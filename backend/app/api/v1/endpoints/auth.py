"""
认证 API 端点
登录、注册、登出、修改密码
"""
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

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


@router.get("/desktop-session")
async def desktop_session(request: Request, db: Session = Depends(get_db)):
    """桌面版免登录会话：签发本机唯一 owner 账号的长效 JWT。

    仅 NPT_DESKTOP=1 且来源为回环地址时可用；桌面端是单用户形态，
    没有注册/登录入口，令牌过期会导致无法继续操作，因此有效期取 365 天。

    刻意不写 UserSession 行：`is_session_idle_expired()` 无会话记录即放行，
    桌面端天然不受服务器会话空闲超时影响（含 4 分钟心跳）。
    """
    from datetime import timedelta

    from app.core.config import settings
    from app.core.database import DESKTOP_OWNER_USERNAME

    # 桌面端没有开发者工具，失败原因只能靠日志（desktop.log）排查，这里逐项记录
    if not settings.NPT_DESKTOP:
        print("[DesktopSession] 拒绝：NPT_DESKTOP 未启用（非桌面形态）")
        raise HTTPException(status_code=404, detail="Not Found")

    client_host = request.client.host if request.client else ""
    if client_host not in ("127.0.0.1", "::1", "localhost"):
        print(f"[DesktopSession] 拒绝：来源非回环地址 {client_host}")
        raise HTTPException(status_code=403, detail="仅允许本机访问")

    user = db.query(User).filter(User.username == DESKTOP_OWNER_USERNAME).first()
    if user is None or not user.is_active:
        print(
            f"[DesktopSession] 拒绝：本机 owner 账号缺失或停用 "
            f"(found={user is not None}, active={bool(user and user.is_active)})"
        )
        raise HTTPException(status_code=500, detail="本机桌面账号缺失，请重新安装或联系厂商")
    print(f"[DesktopSession] 已签发本机会话：user={user.username}, host={client_host}")

    token, _jti = auth_service.create_access_token(
        user.id, user.username, user.is_admin, expires_delta=timedelta(days=365)
    )
    return {
        "success": True,
        "data": {
            "token": token,
            "access_token": token,
            "token_type": "bearer",
            "user": user.to_dict(),
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
            "user": user.to_dict(),
        },
    }


@router.post("/login")
async def login(data: UserLogin, request: Request, db: Session = Depends(get_db)):
    """用户登录"""
    user, error = auth_service.authenticate_user(db, data.username, data.password)
    if error:
        raise HTTPException(status_code=401, detail=error)

    client_ip = auth_service.get_client_ip(request)

    # 仅同类型客户端互踢（APP端不踢任何会话）
    ended_count = auth_service.end_other_ip_sessions(db, user.id, client_ip, data.client_type)

    auth_service.update_last_login(db, user, client_ip)

    token, jti = auth_service.create_access_token(user.id, user.username, user.is_admin)
    auth_service.record_session(db, user.id, jti, client_ip, data.client_type)

    result = {
        "success": True,
        "data": {
            "token": token,
            "access_token": token,
            "token_type": "bearer",
            "user": user.to_dict(),
        },
    }
    if ended_count > 0:
        result["warning"] = "该账号在另一设备上已退出登录（同一账号只能在一个IP地址登录）"

    return result


@router.get("/me")
async def get_me(current_user: User = Depends(get_current_user)):
    """获取当前用户信息"""
    return {
        "success": True,
        "data": current_user.to_dict(),
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
    """退出登录"""
    if jti:
        auth_service.end_session(db, jti)
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
