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

# 功能权限位：管理员在网页端「用户管理 → 编辑」设置，网页端与桌面端一致生效
PERMISSION_FIELDS = (
    "can_data_import", "can_data_delete", "can_data_update",
    "can_cell_entry", "can_cell_query_update", "can_assistant",
)


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
    for perm in PERMISSION_FIELDS:
        setattr(row, perm, bool(incoming.get(perm)))
    db.commit()
    db.refresh(row)
    return row


def _sync_permissions_from_remote(incoming: Optional[dict]) -> Optional[dict]:
    """把服务器上的最新权限位同步到本机镜像账号，返回同步后的账号载荷。

    管理员在网页端「用户管理 → 编辑」改动权限位后，运行中的桌面端在下一次
    心跳（session-check）就会拿到新权限，无需重新登录，保证两端一致；
    断网时拿不到新值，沿用本机上次同步的结果。
    """
    if not incoming or not incoming.get("username"):
        return None
    from app.core.database import SessionLocal
    from app.models.database import User as UserModel

    db = SessionLocal()
    try:
        row = db.query(UserModel).filter(UserModel.username == incoming["username"]).first()
        if row is None:
            return None
        row.is_admin = bool(incoming.get("is_admin"))
        for perm in PERMISSION_FIELDS:
            setattr(row, perm, bool(incoming.get(perm)))
        db.commit()
        db.refresh(row)
        return auth_service.user_payload(row)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        print(f"[DesktopAuth] 同步权限失败（忽略）：{exc}")
        return None
    finally:
        db.close()


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


def _standalone_local_login(db: Session, username: str, password: str):
    """单机模式本地直登校验（不发任何网络请求）。

    返回 (user, reason)：user 非空表示本地凭据有效、可立即离线登录并正常使用；
    reason 供调用方在不能离线登录时给出可操作的提示（许可过期/换机/账号不匹配等），
    而不是笼统的"无法连接服务器"。
    """
    from app.models.database import User as UserModel

    info = license_service.desktop_license_info()
    if not info:
        return None, "no_license"
    if not info.get("valid"):
        # 过期 / 机器码不匹配 / 系统时间回拨：直接把许可文件自身的原因透出
        return None, info.get("errorMessage") or "本机授权无效"
    if (info.get("mode") or MODE_STANDALONE) != MODE_STANDALONE:
        return None, "本机授权是共享模式，切换单机模式需要联网登录"
    if (info.get("username") or "").strip() != username:
        licensed = (info.get("username") or "").strip() or "其它账号"
        return None, f"本机授权归属于 {licensed}，请改用该账号登录"

    row = db.query(UserModel).filter(UserModel.username == username).first()
    if row is None or not row.is_active:
        return None, "no_local_user"
    if not auth_service.verify_password(password, row.password_hash):
        return None, "bad_password"
    row.desktop_run_mode = MODE_STANDALONE
    db.commit()
    return row, ""


def _offline_unavailable_detail(reason: str, network_message: str) -> tuple:
    """服务器不可达且不能离线登录时，按本地校验结果给出可操作的提示。"""
    if reason == "bad_password":
        return 401, "用户名或密码错误"
    if reason == "no_local_user":
        return 502, f"{network_message}；本机没有该账号的离线凭据，请先联网登录一次"
    if reason == "no_license":
        return 502, f"{network_message}；本机尚未激活单机授权，首次使用需要联网登录一次"
    if reason:
        return 403, f"{reason}；请连接网络后重试（联网会自动续期）"
    return 502, network_message


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


async def _login_via_server(
    username: str, password: str, mode: str, timeout: int = 20
) -> Dict[str, Any]:
    """代理到授权服务器登录，顺便把断网期间的登录次数补报上去。

    timeout 用于单机模式的"快速探测"：本地凭据有效时只给很短的时间，
    连不上就立即回落离线登录，不让用户干等 20 秒。
    """
    from starlette.concurrency import run_in_threadpool

    pending = int(cloud.load_state().get("pending_offline_logins") or 0)
    data = await run_in_threadpool(
        cloud.login, username, password, mode, pending or None, timeout=timeout
    )
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


def notify_server_logout() -> None:
    """桌面端退出登录：通知服务器结束会话，并清掉本机保存的云端会话标识。

    两步缺一不可——只清本机标识，服务器那条 client_type='desktop' 会话仍会被
    心跳刷新；只通知服务器不清标识，本机心跳还会继续把它刷回来。结果都是管理员
    「用户管理」看到「已退出却仍在线」。全程尽力而为：网络不可达也不能阻断本机登出。
    """
    jti = (cloud.load_state().get("session_jti") or "").strip()
    if jti:
        try:
            cloud.logout(jti)
        except Exception as exc:  # noqa: BLE001
            print(f"[DesktopAuth] 通知服务器退出登录失败（忽略）：{exc}")
    cloud.clear_state("session_jti", "local_jti", "kicked", "kicked_reason")


# 单机模式本地凭据有效时，服务器登录只给这么长的探测时间（超时即离线登录）
STANDALONE_ONLINE_PROBE_SECONDS = 4


def _finish_offline_login(db: Session, user) -> Dict[str, Any]:
    """单机模式离线登录：本地许可 + 本机账号密码校验通过即签发令牌，不等网络。

    登录次数先本机记账、联网后补报；同时留下 needs_license_verify 标记，
    由后台巡检在能连上服务器时用许可续期通道校验一次授权并续期。
    """
    from app.services.desktop_sync_service import MODE_OFFLINE, set_run_mode

    info = license_service.desktop_license_info() or {}
    set_run_mode(MODE_OFFLINE)  # 单机模式数据本机私有，不参与服务器数据同步
    _ensure_local_group(db, user, info)
    _remember_sync_user(user.username)
    _note_offline_login()  # 登录次数先本机记账，下次联机补报
    # 旧会话标识不再代表本次登录：清掉，避免联网后拿旧 jti 校验把用户误判为"已登出"
    cloud.clear_state("session_jti", "kicked", "kicked_reason")
    cloud.save_state(
        needs_license_verify=True,  # 联网后自动校验授权
        desktop_username=user.username,
        desktop_mode=MODE_STANDALONE,
    )
    token = _issue_local_token(db, user, info.get("idle_logout_days"))
    return {
        "success": True,
        "data": {
            "token": token,
            "access_token": token,
            "token_type": "bearer",
            "user": auth_service.user_payload(user),
            "mode": MODE_STANDALONE,
            "offline": True,
            "verify_pending": True,
            "sync_started": False,
            "idle_logout_days": info.get("idle_logout_days") or 2,
            "license": info,
        },
    }


def verify_pending_license_once() -> Optional[str]:
    """联网时用许可续期通道补一次授权校验（离线登录后调用，不依赖密码/会话）。

    成功返回新到期日（顺带把过期授权续期、把到期日镜像回本机用户）；
    授权被禁用/解绑/机器不匹配等由服务器拒绝时写 license_error 供前端提示；
    网络不可达保留标记下轮再试，离线导入的许可无需也无法在线校验。
    """
    if not cloud.load_state().get("needs_license_verify"):
        return None
    info = license_service.desktop_license_info() or {}
    if info.get("issued_via") != "online" or not info.get("license_id"):
        cloud.clear_state("needs_license_verify")  # 离线导入许可：无在线记录，无需校验
        return None
    try:
        data = cloud.renew_local_license()
    except cloud.CloudError as exc:
        if exc.status_code >= 400:
            # 服务器明确拒绝（禁用/解绑/机器不匹配/许可被改）：提示用户并停止重试
            cloud.save_state(license_error=_gbk_safe(exc.message))
            cloud.clear_state("needs_license_verify")
        return None  # 网络不可达：保留标记，下轮巡检再试
    cloud.clear_state("needs_license_verify", "license_error")
    print(f"[DesktopAuth] 联网后授权校验通过，已续期至 {data.get('expire_date')}")
    return str(data.get("expire_date") or "")


def _local_user_payload_from_state() -> Optional[dict]:
    """取本机当前登录镜像账号的最新载荷（续期后到期日即时回传前端授权门禁）。"""
    username = (cloud.load_state().get("desktop_username") or "").strip()
    if not username:
        return None
    from app.core.database import SessionLocal
    from app.models.database import User as UserModel

    db = SessionLocal()
    try:
        row = db.query(UserModel).filter(UserModel.username == username).first()
        return auth_service.user_payload(row) if row is not None else None
    except Exception:  # noqa: BLE001
        return None
    finally:
        db.close()


def check_session_once() -> Dict[str, Any]:
    """周期性巡检：本机登录是否仍有效 + 单机模式联网后的授权校验。

    登录态：只有服务器**明确回复** valid=False（账号已在别处登录）才登出；
    网络不可达/超时/5xx 一律按"无法确定"处理，断网时继续可用。
    授权：离线登录留下的待校验标记在能连上服务器时自动校验一次。
    """
    state = cloud.load_state()
    jti = (state.get("session_jti") or "").strip()
    data: Dict[str, Any] = {"valid": True}
    if jti:
        try:
            result = cloud.session_check(jti)
        except Exception as exc:  # noqa: BLE001
            result = {"valid": True, "offline": True, "reason": str(exc)}
        if result.get("valid") is False:
            reason = str(result.get("reason") or "")
            _force_local_logout(reason)
            return {"valid": False, "reason": reason}
        if result.get("offline"):
            # 服务器不可达/异常：按"无法确定"处理（断网继续用，不踢下线）
            data["offline"] = True
        else:
            # 心跳能到达服务器：前端据此确认已联网（清除离线提示）
            data["offline"] = False
        # 权限位随心跳同步：管理员改权限后运行中的桌面端无需重登即可生效
        user_payload = _sync_permissions_from_remote(result.get("user"))
        if user_payload is not None:
            data["user"] = user_payload
    else:
        data["skipped"] = True

    expire_date = verify_pending_license_once()
    if expire_date:
        data["license_verified"] = True
        data["license_expire_date"] = expire_date
        # 续期已把新到期日镜像到本机用户：随响应回传，授权门禁即时解除"过期"状态
        refreshed = _local_user_payload_from_state()
        if refreshed is not None:
            data["user"] = refreshed
    license_error = cloud.load_state().get("license_error")
    if license_error:
        data["license_error"] = license_error
    return data


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


# 登录优先：共享模式的首次同步延后这么久再跑
LOGIN_SYNC_DELAY_SECONDS = 5.0


def _start_shared_sync() -> None:
    """共享模式登录成功即同步一次同组数据。

    同步要下载并导入多个数据集，与登录、首屏请求抢资源会让"登录很慢"，
    因此延后再跑：登录响应与首屏先完成，同步仍是同一次后台任务
    （失败只写状态，不影响本机使用）。
    """
    from app.services.desktop_sync_service import MODE_SHARED, set_run_mode

    set_run_mode(MODE_SHARED)
    timer = threading.Timer(LOGIN_SYNC_DELAY_SECONDS, _run_sync_once)
    timer.name = "desktop-login-sync"
    timer.daemon = True
    timer.start()


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

    单机模式「本地优先」：本机授权 + 本机镜像账号密码校验通过就立即登录（无需网络、
    不等待授权服务器），联网后的授权校验/权限刷新由后台任务补齐；本地凭据不可用时
    才请求服务器（首次登录、等待批准、联网续期等）。
    """
    username = (payload.username or "").strip()
    password = payload.password or ""
    mode = MODE_STANDALONE if str(payload.mode).lower() != "shared" else "shared"
    if not username or not password:
        raise HTTPException(status_code=400, detail="请输入用户名与密码")

    local_user = None
    local_reason = ""
    if mode == MODE_STANDALONE:
        local_user, local_reason = _standalone_local_login(db, username, password)

    try:
        # 单机模式本地凭据有效：服务器只做短时探测，连不上就立即离线登录；
        # 本地凭据不可用（首次登录/等待批准等）时按完整超时请求服务器。
        probe = STANDALONE_ONLINE_PROBE_SECONDS if local_user is not None else 20
        data = await _login_via_server(username, password, mode, probe)
    except cloud.CloudError as exc:
        # 本地凭据有效且只是网络不可达/服务器故障 → 离线登录，拿到本机授权继续用
        if (
            local_user is not None
            and mode == MODE_STANDALONE
            and (exc.status_code == 0 or exc.status_code >= 500)
        ):
            print(
                f"[DesktopAuth] 授权服务器暂不可用（{exc.status_code or '网络'}），"
                "改用本机授权离线登录"
            )
            return _finish_offline_login(db, local_user)
        # 仅网络不可达才回落离线；鉴权/授权类错误照常抛出
        if exc.status_code != 0 or mode != MODE_STANDALONE:
            raise HTTPException(
                status_code=exc.status_code or 502, detail=_gbk_safe(exc.message)
            )
        # 网络不可达且本地不能离线登录：按本地校验的具体原因提示（过期/换机/账号不符…）
        status_code, detail = _offline_unavailable_detail(local_reason, exc.message)
        raise HTTPException(status_code=status_code, detail=_gbk_safe(detail))

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

    token = _issue_local_token(db, user, data.get("idle_logout_days"))
    return {
        "success": True,
        "data": {
            "token": token,
            "access_token": token,
            "token_type": "bearer",
            "user": auth_service.user_payload(user),
            "mode": mode,
            "offline": False,
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
    # 与 /desktop/login 返回同形状：前端轮询入口按 result/access_token 判定登录成功，
    # 缺了这两个字段管理员批准后桌面端会一直停在等待弹窗
    token = _issue_local_token(db, user, data.get("idle_logout_days"))
    return {
        "success": True,
        "data": {
            "result": "ok",
            "token": token,
            "access_token": token,
            "token_type": "bearer",
            "user": auth_service.user_payload(user),
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

    try:
        release = updater.check_latest(raise_on_error=True)
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)
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
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """下载新版本：桌面端是本机单机形态，登录用户即可更新（接口仅桌面形态存在）。"""
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


@router.post("/update/install")
def update_install(
    current_user: User = Depends(get_current_user),
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


class WindowTitleRequest(BaseModel):
    title: str = Field(..., description="窗口标题（应用名 + 运行模式 + 同步状态）")


@router.post("/window-title")
async def desktop_window_title(
    payload: WindowTitleRequest,
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """把「运行模式 + 实时同步状态」写到桌面窗口标题栏（web/服务器模式返回 403）。

    前端在运行模式或同步状态变化时调用；标题串由前端按当前语言拼好，后端只做转发。
    """
    from app import desktop_bridge

    title = (payload.title or "").strip()[:200]
    if not title:
        raise HTTPException(status_code=400, detail="标题不能为空")
    if not desktop_bridge.set_window_title(title):
        raise HTTPException(status_code=403, detail="当前运行环境不支持修改窗口标题（非桌面壳）")
    return {"success": True, "data": {"title": title}}
