"""桌面版本机接口：在线激活 / 续期 / 申请授权（仅 NPT_DESKTOP=1 时可用）。

前端只访问本机这些接口，由本机后端去调用授权服务器：
- 客户端本机 JWT 与服务器无关（也不受服务器 CORS 限制）
- 激活/续期成功后统一走 license_service.activate() 落盘并镜像到期日
"""
from __future__ import annotations

import threading
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.security import get_current_admin_user, get_current_user
from app.models.database import User
from app.services import desktop_cloud_client as cloud
from app.services.auth_service import auth_service
from app.services.license_service import license_service
from app.utils.machine_code import get_machine_code

router = APIRouter(tags=["桌面客户端本地接口"])


def _gbk_safe(message: str) -> str:
    return str(message).encode("gbk", "replace").decode("gbk")


def _require_desktop() -> None:
    if not settings.NPT_DESKTOP:
        raise HTTPException(status_code=404, detail="Not Found")


def _raise_cloud_error(exc: cloud.CloudError) -> None:
    status_code = exc.status_code if exc.status_code and exc.status_code >= 400 else 502
    raise HTTPException(status_code=status_code, detail=_gbk_safe(exc.message))


def _status_payload() -> Dict[str, Any]:
    state = cloud.load_state()
    return {
        "desktop": True,
        "server_url": cloud.server_url(),
        "machine_code": get_machine_code(),
        "version": settings.NPT_DESKTOP_VERSION or "",
        "channel": settings.NPT_DESKTOP_CHANNEL or "stable",
        "license": license_service.desktop_license_info(),
        "cloud": {
            "license_id": state.get("license_id"),
            "last_renew_at": state.get("last_renew_at"),
            "request_id": state.get("request_id"),
        },
    }


class ActivateRequest(BaseModel):
    activation_code: str = Field(..., description="管理员发放的激活码")


class ApplyRequest(BaseModel):
    applicant_name: str
    organization: Optional[str] = None
    note: Optional[str] = None


class RunModeRequest(BaseModel):
    mode: str = Field(..., description="shared=共享模式 / offline=离线模式")


class SyncResolveRequest(BaseModel):
    data_id: str
    resolution: str = Field(..., description="server=取服务器版本 / local=用本地覆盖")


class DesktopRegisterRequest(BaseModel):
    """桌面端注册：与网页端注册字段一致（数据组只能在注册时选择）。"""

    username: str
    password: str
    confirm_password: str
    city: str
    operator: str


# ------------------------------------------------- 桌面端登录（与网页端同一套账号）
#
# 桌面端不再有 owner 免登录账号：登录页输入网页端用户名/密码，由本机后端代理到
# 授权服务器校验，成功后在本机镜像出同名本地账号（组/权限位/管理员位照搬），
# 之后的权限与数据组语义与网页端完全一致。
# 单机模式在授权有效期内允许断网登录（本机保存密码哈希），登录次数下次联机补报。

MODE_STANDALONE = "standalone"


class DesktopLoginRequest(BaseModel):
    username: str
    password: str
    mode: str = Field(default=MODE_STANDALONE, description="shared=共享模式 / standalone=单机模式")


class DesktopPollRequest(BaseModel):
    username: str


def _mirror_local_user(db: Session, incoming: dict, mode: str, password: Optional[str] = None):
    """在本机 users 表镜像网页端账号（组、权限位、管理员位照搬）。

    password 为空表示沿用本机已有哈希（轮询批准时拿不到明文密码）；
    新账号则随机生成，正式登录时会覆盖。桌面端不强制改密（改密走网页端）。
    """
    import uuid as _uuid

    from app.models.database import User as UserModel

    username = (incoming.get("username") or "").strip()
    if not username:
        raise HTTPException(status_code=400, detail="服务器返回的账号信息不完整")
    row = db.query(UserModel).filter(UserModel.username == username).first()
    if row is None:
        row = UserModel(
            username=username,
            password_hash=auth_service.hash_password(password or str(_uuid.uuid4())),
        )
        db.add(row)
    elif password:
        row.password_hash = auth_service.hash_password(password)
    row.is_admin = bool(incoming.get("is_admin"))
    row.is_active = True
    row.must_change_password = False
    row.is_desktop_shadow = False
    row.desktop_run_mode = mode
    row.city = incoming.get("city")
    row.operator = incoming.get("operator")
    for perm in (
        "can_data_import", "can_data_delete", "can_data_update",
        "can_cell_entry", "can_cell_query_update", "can_assistant",
    ):
        setattr(row, perm, bool(incoming.get(perm)))
    db.commit()
    db.refresh(row)
    return row


def _issue_local_token(db: Session, user, idle_logout_days: Optional[int] = None) -> str:
    """签发本机 JWT：单机模式按授权时长放宽，避免短有效期把人锁在门外。"""
    from datetime import timedelta

    days = int(idle_logout_days or 2)
    delta = timedelta(days=max(days, 2)) if settings.NPT_DESKTOP else None
    token, jti = auth_service.create_access_token(
        user.id, user.username, user.is_admin, expires_delta=delta
    )
    # 写会话记录 → 空闲超时（单机模式为管理员设定的天数）才会要求重新登录
    auth_service.record_session(db, user.id, jti, "127.0.0.1", "pc")
    # 记住本机会话 jti：账号在别处登录时可在本地直接注销这个会话
    try:
        cloud.save_state(local_jti=jti, desktop_username=user.username)
    except Exception:  # noqa: BLE001
        pass
    return token


def _standalone_offline_allowed(username: str) -> bool:
    """单机模式断网登录的前提：本机已有该账号且本机许可仍有效、模式与账号一致。"""
    info = license_service.desktop_license_info() or {}
    if not info.get("valid"):
        return False
    if (info.get("mode") or MODE_STANDALONE) != MODE_STANDALONE:
        return False
    return (info.get("username") or "").strip() == username


def _offline_login(db: Session, username: str, password: str):
    from app.models.database import User as UserModel

    row = db.query(UserModel).filter(UserModel.username == username).first()
    if row is None or not row.is_active:
        return None
    if not auth_service.verify_password(password, row.password_hash):
        return None
    row.desktop_run_mode = MODE_STANDALONE
    db.commit()
    return row


def _ensure_local_group(db: Session, user, license_payload: dict) -> None:
    """单机模式必须保证本地账号有数据组：没有组就看不到自己刚上传的数据。

    优先沿用账号组（与网页端一致），其次用授权记录上管理员指定的组，
    最后兜底到地市预设，避免单机用户陷入「数据传上去却看不见」。
    """
    if user.city and user.operator:
        return
    payload = license_payload or {}
    city = (user.city or payload.get("city") or "").strip()
    operator = (user.operator or payload.get("operator") or "").strip()
    if not city:
        presets = settings.CITY_PRESETS or []
        city = (presets[0] if presets else "").strip()
    if city and not operator:
        operator = "移动"
    if not (city and operator):
        return
    user.city = city
    user.operator = operator
    db.commit()
    db.refresh(user)


def _note_offline_login() -> None:
    """记录一次离线登录（联机时补报给服务器）。"""
    count = int(cloud.load_state().get("pending_offline_logins") or 0) + 1
    cloud.save_state(pending_offline_logins=count)


async def _login_via_server(username: str, password: str, mode: str) -> Dict[str, Any]:
    """代理到授权服务器登录，顺便把断网期间的登录次数补报上去。"""
    from starlette.concurrency import run_in_threadpool

    pending = int(cloud.load_state().get("pending_offline_logins") or 0)
    data = await run_in_threadpool(cloud.login, username, password, mode, pending or None)
    if pending:
        cloud.save_state(pending_offline_logins=0)
    return data


def _remember_sync_user(username: str) -> None:
    """同步服务取本机数据组时要知道当前登录的是谁（后台线程拿不到请求上下文）。"""
    from app.services import desktop_sync_service as sync

    sync.save_state(username=username)


def _sync_service():
    from app.services import desktop_sync_service as sync

    return sync


def _force_local_logout(reason: str) -> None:
    """账号在别处登录 → 注销本机会话并记账（前端下次请求即 401）。"""
    state = cloud.load_state()
    jti = (state.get("local_jti") or "").strip()
    if jti:
        from app.core.database import SessionLocal

        db = SessionLocal()
        try:
            auth_service.end_session(db, jti)
        except Exception:  # noqa: BLE001
            pass
        finally:
            db.close()
    cloud.save_state(
        session_jti=None, local_jti=None, kicked=True,
        kicked_reason=reason or "该账号已在其它设备登录，本机已退出登录",
    )
    print(f"[DesktopAuth] {reason or '该账号已在其它设备登录'}，本机已退出登录")


def check_session_once() -> Dict[str, Any]:
    """向服务器确认本机登录是否仍是该账号的最后一次登录。"""
    state = cloud.load_state()
    jti = (state.get("session_jti") or "").strip()
    if not jti:
        return {"valid": True, "skipped": True}
    try:
        result = cloud.session_check(jti)
    except Exception as exc:  # noqa: BLE001
        return {"valid": True, "offline": True, "error": str(exc)}
    if result.get("valid") is False:
        _force_local_logout(str(result.get("reason") or ""))
        return {"valid": False, "reason": result.get("reason")}
    return {"valid": True}


async def session_guard_loop(interval_seconds: int = 60) -> None:
    """周期性校验登录态：同一账号在网页端/另一台桌面端登录 → 本机自动登出。"""
    import asyncio

    await asyncio.sleep(30)  # 启动先让本地服务热身
    while True:
        try:
            await asyncio.to_thread(check_session_once)
        except Exception as exc:  # noqa: BLE001
            print(f"[DesktopAuth] 登录态校验异常（忽略）：{exc}")
        await asyncio.sleep(max(15, interval_seconds))


def _start_shared_sync() -> None:
    """共享模式登录成功即同步一次同组数据。

    同步可能要下载多个数据集，放后台线程跑，失败只写状态不影响本机使用。
    """
    from app.services.desktop_sync_service import MODE_SHARED, set_run_mode

    set_run_mode(MODE_SHARED)
    threading.Thread(target=_run_sync_once, name="desktop-login-sync", daemon=True).start()


def _run_sync_once() -> None:
    try:
        _sync_service().sync_once()
    except Exception as exc:  # noqa: BLE001
        print(f"[DesktopSync] 登录同步失败（忽略）：{exc}")


@router.get("/app-version")
async def desktop_app_version() -> Dict[str, Any]:
    """手机 APP 最新版本（公开）：桌面端不分发 APK，直接取服务器的最新版。

    相对下载路径拼成服务器绝对地址，客户端才能扫码/下载（本机 127.0.0.1 不可达）。
    """
    from starlette.concurrency import run_in_threadpool

    _require_desktop()
    try:
        data = await run_in_threadpool(cloud.app_version)
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)
    if not data:
        return {"success": True, "data": None}
    download_url = str(data.get("download_url") or "")
    if download_url and not download_url.startswith("http"):
        download_url = f"{cloud.server_url()}{download_url}"
    return {"success": True, "data": {**data, "download_url": download_url}}


@router.get("/session-status")
async def session_status(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """本机登录是否仍有效（同一账号被其它端登录时 valid=False）。

    前端登录后周期轮询：失效即清理本地凭据并回到登录页。
    """
    state = cloud.load_state()
    if state.get("kicked"):
        return {
            "success": True,
            "data": {
                "valid": False,
                "reason": state.get("kicked_reason") or "该账号已在其它设备登录，本机已退出登录",
            },
        }
    from starlette.concurrency import run_in_threadpool

    result = await run_in_threadpool(check_session_once)
    return {"success": True, "data": result}


@router.get("/sync-status")
async def sync_status(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """共享模式同步状态：当前模式、上次同步时间、待上传数、冲突列表。"""
    return {"success": True, "data": _sync_service().status()}


@router.put("/run-mode")
async def set_run_mode(
    payload: RunModeRequest,
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """切换共享/离线同步。离线模式不与服务器通信，数据完全本机私有。

    单机模式（登录时选择）不参与服务器数据共享，只能保持离线。
    """
    from app.services.desktop_sync_service import MODE_SHARED, is_shared, run_mode, set_run_mode

    if payload.mode == MODE_SHARED and current_user.desktop_run_mode == MODE_STANDALONE:
        raise HTTPException(
            status_code=403, detail="单机模式不与服务器共享数据，如需共享请以共享模式重新登录"
        )
    mode = set_run_mode(payload.mode)
    detail = {"run_mode": mode, "shared": is_shared()}
    # 切到共享模式立刻同步一次（网络失败不影响本地继续使用）
    if mode == MODE_SHARED:
        from starlette.concurrency import run_in_threadpool

        try:
            result = await run_in_threadpool(_sync_service().sync_once)
            detail["sync_result"] = result
        except Exception as exc:  # noqa: BLE001
            detail["sync_result"] = {"error": str(exc)}
    return {"success": True, "data": {**detail, **_sync_service().status()}}


@router.post("/sync")
async def sync_now(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """立即与服务器同步一次（离线模式下返回跳过）。"""
    from starlette.concurrency import run_in_threadpool

    result = await run_in_threadpool(_sync_service().sync_once)
    message = None
    if result.get("skipped"):
        message = (
            "当前为离线模式，不与服务器同步；切到共享模式后可共享同组数据"
            if result.get("reason") == "当前为离线模式"
            else result.get("reason")
        )
    elif result.get("error"):
        raise HTTPException(status_code=502, detail=_gbk_safe(result["error"]))
    return {
        "success": True,
        "message": message or "同步完成",
        "data": {**result, **_sync_service().status()},
    }


@router.post("/sync-resolve")
async def sync_resolve(
    payload: SyncResolveRequest,
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """冲突选边：server=下载服务器版本覆盖本地；local=用本地覆盖服务器。"""
    from starlette.concurrency import run_in_threadpool

    try:
        result = await run_in_threadpool(
            _sync_service().resolve_conflict, payload.data_id, payload.resolution
        )
    except _sync_service().SyncError as exc:
        raise HTTPException(status_code=400, detail=_gbk_safe(str(exc)))
    return {"success": True, "data": {**result, **_sync_service().status()}}


@router.get("/register-options")
async def desktop_register_options() -> Dict[str, Any]:
    """注册选项（公开）：地市预设与运营商取自服务器，桌面端注册与网页端一致。"""
    from app.services.data_group import OPERATORS

    _require_desktop()
    try:
        from starlette.concurrency import run_in_threadpool

        data = await run_in_threadpool(cloud.register_options)
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)
    return {
        "success": True,
        "data": {
            "cities": data.get("cities") or [],
            "operators": data.get("operators") or list(OPERATORS),
        },
    }


@router.post("/register")
async def desktop_register(
    payload: DesktopRegisterRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """桌面端注册：与网页端同一套注册规则（账号创建在服务器上）。

    注册成功后自动以共享模式登录并同步同组数据；数据组只能在注册时选择，
    之后只能由服务器管理员修改。
    """
    username = (payload.username or "").strip()
    password = payload.password or ""
    city = (payload.city or "").strip()
    operator = (payload.operator or "").strip()
    if len(username) < 3:
        raise HTTPException(status_code=400, detail="用户名长度至少3位")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="密码长度至少6位")
    if password != (payload.confirm_password or ""):
        raise HTTPException(status_code=400, detail="两次输入的密码不一致")
    if not city or not operator:
        raise HTTPException(status_code=400, detail="请选择地市与运营商")

    try:
        await _register_via_server(username, password, city, operator)
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)

    # 注册成功即共享模式登录（注册时已选定数据组），登录会触发同组数据同步
    return await desktop_login(
        DesktopLoginRequest(username=username, password=password, mode="shared"), db
    )


async def _register_via_server(
    username: str, password: str, city: str, operator: str
) -> None:
    from starlette.concurrency import run_in_threadpool

    await run_in_threadpool(
        cloud.register, username, password, city, operator
    )


@router.post("/login")
async def desktop_login(
    payload: DesktopLoginRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """桌面端登录：共享模式与网页端同账号同权限；单机模式需管理员单独授权。

    单机模式在服务器不可达时回退为离线登录（本机许可有效即可），断网期间
    的登录次数本机记账，下次联机自动补报。
    """
    username = (payload.username or "").strip()
    password = payload.password or ""
    mode = MODE_STANDALONE if str(payload.mode).lower() != "shared" else "shared"
    if not username or not password:
        raise HTTPException(status_code=400, detail="请输入用户名与密码")

    offline_used = False
    try:
        data = await _login_via_server(username, password, mode)
    except cloud.CloudError as exc:
        # 仅网络不可达才回退离线登录；鉴权/授权类错误照常抛出
        if exc.status_code != 0 or mode != MODE_STANDALONE:
            raise HTTPException(
                status_code=exc.status_code or 502, detail=_gbk_safe(exc.message)
            )
        if not _standalone_offline_allowed(username):
            raise HTTPException(
                status_code=exc.status_code or 502, detail=_gbk_safe(exc.message)
            )
        user = _offline_login(db, username, password)
        if user is None:
            # 本机从未联机登录过该账号 → 没有可比对的凭据，报网络原因更有指导性
            from app.models.database import User as UserModel

            known = db.query(UserModel).filter(UserModel.username == username).first()
            if known is None:
                raise HTTPException(
                    status_code=exc.status_code or 502, detail=_gbk_safe(exc.message)
                )
            raise HTTPException(status_code=401, detail="用户名或密码错误")
        offline_used = True
        info = license_service.desktop_license_info() or {}
        data = {
            "result": "ok",
            "mode": MODE_STANDALONE,
            "user": user.to_dict(),
            "license": info,
            "idle_logout_days": info.get("idle_logout_days") or 2,
            "offline": True,
        }

    if data.get("result") == "pending":
        return {"success": True, "data": data}

    incoming = data.get("user") or {}
    user = _mirror_local_user(db, incoming, mode, password)
    info = license_service.desktop_license_info() or (data.get("license") or {})
    _remember_sync_user(username)
    # 记住服务器会话标识：后续周期性校验"是否仍是最后一次登录"
    server_jti = (data.get("session_jti") or "").strip()
    cloud.save_state(session_jti=server_jti or None, kicked=False, kicked_reason=None)
    if mode == MODE_STANDALONE:
        # 单机模式数据本机私有，不参与服务器数据同步
        from app.services.desktop_sync_service import MODE_OFFLINE, set_run_mode

        set_run_mode(MODE_OFFLINE)
        _ensure_local_group(db, user, info)
    else:
        # 共享模式：登录即开始同步同组数据
        _start_shared_sync()

    if offline_used:
        _note_offline_login()

    token = _issue_local_token(db, user, data.get("idle_logout_days"))
    return {
        "success": True,
        "data": {
            "token": token,
            "access_token": token,
            "token_type": "bearer",
            "user": user.to_dict(),
            "mode": mode,
            "offline": offline_used,
            "sync_started": mode != MODE_STANDALONE,
            "idle_logout_days": data.get("idle_logout_days") or 2,
            "license": info,
        },
    }


@router.post("/auth-poll")
async def desktop_auth_poll(
    payload: DesktopPollRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """单机模式：轮询「申请授权」结果，管理员一批准即完成登录。"""
    username = (payload.username or "").strip()
    if not username:
        raise HTTPException(status_code=400, detail="缺少用户名")
    try:
        data = cloud.poll_login(username)
    except cloud.CloudError as exc:
        raise HTTPException(status_code=exc.status_code or 502, detail=_gbk_safe(exc.message))

    if data.get("result") != "ok":
        return {"success": True, "data": data}

    incoming = data.get("user") or {}
    # 轮询阶段没有明文密码：本机已有账号就沿用其哈希（_mirror 在 password=None 时保留）
    user = _mirror_local_user(db, incoming, MODE_STANDALONE)
    info = license_service.desktop_license_info() or {}
    _ensure_local_group(db, user, info)
    from app.services.desktop_sync_service import MODE_OFFLINE, set_run_mode

    set_run_mode(MODE_OFFLINE)
    _remember_sync_user(username)
    return {
        "success": True,
        "data": {
            "token": _issue_local_token(db, user, data.get("idle_logout_days")),
            "user": user.to_dict(),
            "mode": MODE_STANDALONE,
            "idle_logout_days": data.get("idle_logout_days") or 2,
        },
    }


@router.get("/cloud-status")
async def cloud_status(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    return {"success": True, "data": _status_payload()}


@router.post("/cloud-activate")
def cloud_activate(
    payload: ActivateRequest,
    admin_user: User = Depends(get_current_admin_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    try:
        data = cloud.activate(payload.activation_code.strip())
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)

    ok, message = license_service.activate(str(data.get("license_file") or ""))
    if not ok:
        raise HTTPException(status_code=500, detail=_gbk_safe(f"许可文件校验失败：{message}"))
    return {"success": True, "message": message, "data": _status_payload()}


@router.post("/cloud-renew")
def cloud_renew(
    admin_user: User = Depends(get_current_admin_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    try:
        data = cloud.renew_local_license()
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)
    return {
        "success": True,
        "message": f"已续期至 {data.get('expire_date', '')}",
        "data": _status_payload(),
    }


@router.post("/cloud-apply")
def cloud_apply(
    payload: ApplyRequest,
    admin_user: User = Depends(get_current_admin_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    try:
        data = cloud.apply_license(payload.applicant_name, payload.organization, payload.note)
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)
    return {"success": True, "data": data}


@router.get("/cloud-apply")
def cloud_apply_poll(
    admin_user: User = Depends(get_current_admin_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    try:
        result = cloud.poll_apply()
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)

    activated = False
    if result.get("status") == "issued" and result.get("activation_code"):
        try:
            data = cloud.activate(str(result["activation_code"]))
            ok, message = license_service.activate(str(data.get("license_file") or ""))
            activated = bool(ok)
            if not ok:
                result["message"] = f"许可文件校验失败：{message}"
        except cloud.CloudError as exc:
            result["message"] = exc.message

    return {
        "success": True,
        "data": {
            "status": result.get("status"),
            "message": result.get("message"),
            "activated": activated,
            "status_detail": _status_payload() if activated else None,
        },
    }


# ---------------------------------------------------------------- OTA 更新

class UpdateRequest(BaseModel):
    version: Optional[str] = None


@router.get("/update/status")
def update_status(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    from app.services import desktop_update_service as updater

    release = updater.check_latest()
    return {
        "success": True,
        "data": {
            "current": settings.NPT_DESKTOP_VERSION or "",
            "channel": settings.NPT_DESKTOP_CHANNEL or "stable",
            "release": release,
            "update_available": bool(release and release.get("update_available")),
            "download": updater.progress(),
        },
    }


@router.post("/update/download")
def update_download(
    payload: UpdateRequest,
    admin_user: User = Depends(get_current_admin_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    from app.services import desktop_update_service as updater

    release = updater.check_latest()
    if not release:
        raise HTTPException(
            status_code=502, detail="无法获取版本信息，请检查网络或授权服务器地址"
        )
    return {"success": True, "data": updater.start_download(release)}


@router.get("/update/progress")
async def update_progress(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    from app.services import desktop_update_service as updater

    return {"success": True, "data": updater.progress()}


@router.post("/update/snooze")
def update_snooze(
    payload: UpdateRequest,
    admin_user: User = Depends(get_current_admin_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    from app.services import desktop_update_service as updater

    return {"success": True, "data": updater.snooze(payload.version or "")}


@router.post("/update/install")
def update_install(
    admin_user: User = Depends(get_current_admin_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    from app.services import desktop_update_service as updater

    try:
        result = updater.install_and_exit()
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)
    return {"success": True, "data": result}


@router.post("/exit")
async def desktop_exit(
    admin_user: User = Depends(get_current_admin_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """仅用于"重启并安装"：关闭窗口退出应用（web/服务器模式返回 403）。"""
    from app import desktop_bridge

    if not desktop_bridge.request_exit():
        raise HTTPException(status_code=403, detail="当前运行环境不支持退出（非桌面壳）")
    return {"success": True, "message": "正在退出"}
