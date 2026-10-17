"""
认证 API 端点
登录、注册、登出、修改密码
"""
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.security import get_current_user, get_token_jti
from app.models.database import User
from app.models.schemas import (
    UserCreate, UserLogin, UserResponse,
    TokenResponse, ChangePasswordRequest,
)
from app.services.auth_service import auth_service

router = APIRouter()


@router.get("/options")
async def get_register_options():
    """注册选项（公开，登录前可达）：地市预设清单与运营商列表"""
    from app.core.config import settings
    from app.services.data_group import OPERATORS

    return {
        "success": True,
        "data": {
            "cities": settings.CITY_PRESETS,
            "operators": list(OPERATORS),
        },
    }


@router.post("/register")
async def register(data: UserCreate, request: Request, db: Session = Depends(get_db)):
    """注册新用户并自动登录（桌面单用户形态下不可用）"""
    from app.core.config import settings
    from app.services.data_group import validate_group

    if settings.NPT_DESKTOP:
        raise HTTPException(status_code=404, detail="Not Found")

    group_error = validate_group(data.city, data.operator)
    if group_error:
        raise HTTPException(status_code=400, detail=group_error)

    user, error = auth_service.create_user(
        db=db,
        username=data.username,
        password=data.password,
        is_admin=False,  # 安全：注册不允许自封管理员，管理员只能由管理员创建
        license_expiry=datetime.fromisoformat(data.license_expiry) if data.license_expiry else None,
        city=data.city,
        operator=data.operator,
    )
    if error:
        raise HTTPException(status_code=400, detail=error)

    token, jti = auth_service.create_access_token(user.id, user.username, user.is_admin)
    auth_service.record_session(db, user.id, jti, auth_service.get_client_ip(request))
    auth_service.update_last_login(db, user, auth_service.get_client_ip(request))

    return {
        "success": True,
        "data": {
            "token": token,
            "access_token": token,
            "token_type": "bearer",
            "user": auth_service.user_payload(user),
        },
    }


@router.post("/login")
async def login(data: UserLogin, request: Request, db: Session = Depends(get_db)):
    """用户登录"""
    user, error = auth_service.authenticate_user(db, data.username, data.password)
    if error:
        raise HTTPException(status_code=401, detail=error)

    client_ip = auth_service.get_client_ip(request)

    auth_service.update_last_login(db, user, client_ip)

    token, jti = auth_service.create_access_token(user.id, user.username, user.is_admin)
    auth_service.record_session(db, user.id, jti, client_ip, data.client_type)
    # 同一账号只保留最后这一次登录：网页端与桌面端互踢（APP 端不参与）
    ended_count = (
        0 if (data.client_type or "") == "app"
        else auth_service.revoke_other_sessions(db, user.id, jti)
    )

    result = {
        "success": True,
        "data": {
            "token": token,
            "access_token": token,
            "token_type": "bearer",
            "user": auth_service.user_payload(user),
        },
    }
    if ended_count > 0:
        result["warning"] = "该账号已在其它设备登录，之前的登录已退出（同一账号以最后登录为准）"

    return result


@router.get("/me")
async def get_me(current_user: User = Depends(get_current_user)):
    """获取当前用户信息"""
    return {
        "success": True,
        "data": auth_service.user_payload(current_user),
    }


@router.post("/ping")
async def ping(
    current_user: User = Depends(get_current_user),
    jti: str | None = Depends(get_token_jti),
    db: Session = Depends(get_db),
):
    """
    心跳检测：更新当前会话的 last_activity，延长在线状态。
    APP 和 PC 端应定时（4-5分钟）调用此接口。
    同时结算超时会话的使用时长（只结算、不注销；登录态由空闲超时策略决定）。
    """
    if jti:
        auth_service.update_session_activity(db, jti)
    # 定期结算超时会话的使用时长，以 last_activity 作为离线时间
    if jti:
        auth_service.cleanup_stale_sessions(db, idle_minutes=6)
    return {
        "success": True,
        "last_activity": datetime.now(timezone.utc).isoformat(),
    }


@router.post("/logout")
async def logout(
    current_user: User = Depends(get_current_user),
    jti: str | None = Depends(get_token_jti),
    db: Session = Depends(get_db),
):
    """退出登录（桌面形态下同时结束服务器侧的会话，避免管理员侧显示"仍在线"）"""
    if jti:
        auth_service.end_session(db, jti)
    if settings.NPT_DESKTOP:
        # 通知服务器是一次跨公网 HTTP（TLS 握手不好时可能数秒），绝不能让它挡住
        # 本端点返回——用户点「退出登录」后期望立刻看到登录窗。丢后台线程尽力而为，
        # 服务器会话也会因心跳停止在活跃窗口过期后自动离线
        import threading

        def _notify_in_background() -> None:
            try:
                from app.api.v1.endpoints.desktop_local import notify_server_logout

                notify_server_logout()
            except Exception as exc:  # noqa: BLE001
                print(f"[DesktopAuth] 桌面端登出清理失败（忽略）：{exc}")

        threading.Thread(
            target=_notify_in_background, daemon=True, name="npt-logout-notify"
        ).start()
    return {"success": True, "message": "已退出登录"}


@router.post("/change-password")
async def change_password(
    data: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """修改密码"""
    success, error = auth_service.change_password(db, current_user.id, data.old_password, data.new_password)
    if not success:
        raise HTTPException(status_code=400, detail=error)
    return {"success": True, "message": "密码修改成功"}
