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


@router.post("/register")
async def register(data: UserCreate, request: Request, db: Session = Depends(get_db)):
    """注册新用户并自动登录"""
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
    同时清理过期会话，自动累加使用时长。
    """
    if jti:
        auth_service.update_session_activity(db, jti)
    # 定期清理过期会话，以 last_activity 作为离线时间累加使用时长
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
