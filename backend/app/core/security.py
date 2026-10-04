"""
安全依赖
FastAPI Depends 可调用对象，用于认证和授权
"""
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.auth_service import auth_service

security_scheme = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security_scheme),
    db: Session = Depends(get_db),
):
    """从 Bearer Token 解析当前用户。未认证返回 401。"""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="请先登录",
        )
    token = credentials.credentials
    payload = auth_service.decode_token(token)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="登录已过期，请重新登录",
        )

    jti = payload.get("jti")
    if jti and auth_service.is_token_revoked(db, jti):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="会话已注销，请重新登录",
        )

    # 空闲超时校验：连续无操作（含心跳）超过阈值才要求重新登录。
    # 注意：不校验请求 IP——客户端 IPv4/IPv6 切换或换网络不应打断登录态；
    # 同一账号仅在新设备登录时踢掉旧会话（见 auth_service.end_other_ip_sessions）。
    if jti and auth_service.is_session_idle_expired(db, jti):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="长时间未操作，请重新登录",
        )

    user_id = int(payload.get("sub"))
    user = auth_service.get_user_by_id(db, user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户不存在",
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="账号已被禁用",
        )

    # 更新活动时间
    if jti:
        auth_service.update_session_activity(db, jti)

    return user


async def get_current_admin_user(
    current_user=Depends(get_current_user),
):
    """要求管理员权限，否则返回 403"""
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="需要管理员权限",
        )
    return current_user


async def get_token_jti(
    credentials: HTTPAuthorizationCredentials | None = Depends(security_scheme),
):
    """从当前请求提取 JWT JTI（用于登出时标识会话）"""
    if credentials is None:
        return None
    payload = auth_service.decode_token(credentials.credentials)
    if payload is None:
        return None
    return payload.get("jti")


def require_permission(perm: str):
    """权限校验依赖工厂：管理员自动通过，普通用户需对应权限位为 True"""
    async def checker(current_user=Depends(get_current_user)):
        if current_user.is_admin:
            return current_user
        if not getattr(current_user, perm, False):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="无此操作权限，请联系管理员",
            )
        return current_user
    return checker


require_data_import = require_permission("can_data_import")
require_data_delete = require_permission("can_data_delete")
require_data_update = require_permission("can_data_update")
require_cell_entry = require_permission("can_cell_entry")
require_cell_query_update = require_permission("can_cell_query_update")
require_assistant = require_permission("can_assistant")
