"""
管理员用户管理 API 端点
"""
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import get_current_admin_user
from app.models.database import User
from app.models.schemas import (
    UserCreate, UserUpdate, ResetPasswordRequest,
    UserResponse, UserDetailResponse, UserListResponse, UserSessionResponse,
)
from app.services.auth_service import auth_service

router = APIRouter()


def _user_to_response(user: User) -> dict:
    return user.to_dict()


@router.get("/")
async def list_users(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    search: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """获取用户列表"""
    users, total = auth_service.get_all_users(db, page, page_size, search, is_active)
    user_list = []
    for u in users:
        user_dict = u.to_dict()
        user_dict["is_online"] = auth_service.is_user_online(db, u.id)
        user_dict["is_online_pc"] = auth_service.is_user_online_by_client_type(db, u.id, 'pc')
        user_dict["is_online_app"] = auth_service.is_user_online_by_client_type(db, u.id, 'app')
        user_list.append(user_dict)
    return {
        "success": True,
        "data": {
            "total": total,
            "users": user_list,
        },
    }


@router.post("/")
async def create_user(
    data: UserCreate,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """管理员手动创建用户"""
    license_expiry = None
    if data.license_expiry:
        try:
            license_expiry = datetime.fromisoformat(data.license_expiry)
        except ValueError:
            raise HTTPException(status_code=400, detail="授权截止日期格式无效")

    user, error = auth_service.create_user(
        db=db,
        username=data.username,
        password=data.password,
        is_admin=data.is_admin,
        license_expiry=license_expiry,
        city=data.city,
        operator=data.operator,
    )
    if error:
        raise HTTPException(status_code=400, detail=error)
    return {"success": True, "data": user.to_dict(), "message": "用户创建成功"}


@router.get("/{user_id}")
async def get_user(
    user_id: int,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """获取单个用户详情"""
    user = auth_service.get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    sessions = auth_service.get_user_sessions(db, user_id)
    return {
        "success": True,
        "data": {
            **user.to_dict(),
            "sessions": [s.to_dict() for s in sessions],
        },
    }


@router.put("/{user_id}")
async def update_user(
    user_id: int,
    data: UserUpdate,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """更新用户信息"""
    updates = data.model_dump(exclude_none=True)
    if "license_expiry" in updates and updates["license_expiry"] is not None:
        try:
            updates["license_expiry"] = datetime.fromisoformat(updates["license_expiry"])
        except ValueError:
            raise HTTPException(status_code=400, detail="授权截止日期格式无效")

    # 不允许管理员禁用自己
    if updates.get("is_active") == False and user_id == admin_user.id:
        raise HTTPException(status_code=400, detail="不能禁用自己的账号")

    user = auth_service.update_user(db, user_id, updates)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    return {"success": True, "data": user.to_dict(), "message": "用户更新成功"}


@router.delete("/{user_id}")
async def delete_user(
    user_id: int,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """硬删除用户"""
    if user_id == admin_user.id:
        raise HTTPException(status_code=400, detail="不能删除自己的账号")
    success = auth_service.delete_user(db, user_id)
    if not success:
        raise HTTPException(status_code=404, detail="用户不存在")
    return {"success": True, "message": "用户已删除"}


@router.post("/{user_id}/reset-password")
async def reset_password(
    user_id: int,
    data: ResetPasswordRequest,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """管理员重置用户密码"""
    success = auth_service.reset_password(db, user_id, data.new_password)
    if not success:
        raise HTTPException(status_code=404, detail="用户不存在")
    return {"success": True, "message": "密码重置成功"}
