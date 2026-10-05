"""桌面版本机接口：在线激活 / 续期 / 申请授权（仅 NPT_DESKTOP=1 时可用）。

前端只访问本机这些接口，由本机后端去调用授权服务器：
- 客户端本机 JWT 与服务器无关（也不受服务器 CORS 限制）
- 激活/续期成功后统一走 license_service.activate() 落盘并镜像到期日
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.security import get_current_admin_user, get_current_user
from app.models.database import User
from app.services import desktop_cloud_client as cloud
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


class DesktopGroupRequest(BaseModel):
    city: str
    operator: str


def _sync_service():
    from app.services import desktop_sync_service as sync

    return sync


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
    """切换共享/离线模式。离线模式不与服务器通信，数据完全本机私有。"""
    from app.services.desktop_sync_service import MODE_SHARED, is_shared, run_mode, set_run_mode

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


@router.put("/group")
async def update_desktop_group(
    payload: DesktopGroupRequest,
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """桌面端自选数据组（地市+运营商）：决定共享模式下能共享到哪一组的数据。

    服务器上若已为该授权锁定组，下次同步会按服务器的值纠正本机。
    """
    from app.core.database import SessionLocal
    from app.models.database import User as UserModel
    from app.services.data_group import OPERATORS, migrate_group_data, validate_group

    city = (payload.city or "").strip()
    operator = (payload.operator or "").strip()
    error = validate_group(city, operator)
    if error:
        raise HTTPException(status_code=400, detail=_gbk_safe(error))

    db = SessionLocal()
    try:
        row = db.query(UserModel).filter(UserModel.id == current_user.id).first()
        if row is None:
            raise HTTPException(status_code=404, detail="本机账号不存在")
        old_city, old_operator = row.city, row.operator
        if (old_city, old_operator) == (city, operator):
            return {"success": True, "message": "数据组未变化", "data": {"city": city, "operator": operator}}
        row.city = city
        row.operator = operator
        db.commit()
        # 与网页端一致：改组要连带迁移存量数据，否则老数据会"消失"
        if old_city and old_operator:
            migrate_group_data(
                db, user_id=row.id, username=row.username,
                old_city=old_city, old_operator=old_operator,
                new_city=city, new_operator=operator, scope="user",
            )
    finally:
        db.close()
    return {
        "success": True,
        "message": f"已切换到 {city} / {operator}，存量数据一并迁移",
        "data": {"city": city, "operator": operator, "operators": list(OPERATORS)},
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
