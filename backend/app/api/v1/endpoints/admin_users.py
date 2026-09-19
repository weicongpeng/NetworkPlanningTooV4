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
    """获取用户列表（在线用户优先置顶，在线统计为全量）"""
    users, total, online_stats = auth_service.get_all_users(db, page, page_size, search, is_active)
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
            "online_users": online_stats["online"],
            "online_pc": online_stats["online_pc"],
            "online_app": online_stats["online_app"],
        },
    }


@router.post("/")
async def create_user(
    data: UserCreate,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """管理员手动创建用户"""
    from app.services.data_group import validate_group

    group_error = validate_group(data.city, data.operator)
    if group_error:
        raise HTTPException(status_code=400, detail=group_error)

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
    """更新用户信息。

    若地市/运营商（数据组）发生变化，必须带 migrate_scope 指定历史数据迁移范围
    （user=仅该用户数据 / group=整个旧组），先迁移历史数据再更新用户归属。
    """
    from app.services.data_group import validate_group, migrate_group_data

    target_user = auth_service.get_user_by_id(db, user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="用户不存在")

    new_city = data.city if data.city is not None else target_user.city
    new_operator = data.operator if data.operator is not None else target_user.operator
    group_changed = (new_city, new_operator) != (target_user.city, target_user.operator)

    # 组信息变更：校验新组合法性，并要求显式指定迁移范围
    if group_changed:
        group_error = validate_group(new_city, new_operator)
        if group_error:
            raise HTTPException(status_code=400, detail=group_error)
        if data.migrate_scope not in ("user", "group"):
            raise HTTPException(
                status_code=400,
                detail="用户所属组已变更，必须指定历史数据迁移范围（migrate_scope: user/group）",
            )
        if not (target_user.city and target_user.operator):
            raise HTTPException(
                status_code=400, detail="用户原所属组信息不完整，无法迁移历史数据"
            )

        migration = migrate_group_data(
            db,
            user_id=target_user.id,
            username=target_user.username,
            old_city=target_user.city,
            old_operator=target_user.operator,
            new_city=new_city,
            new_operator=new_operator,
            scope=data.migrate_scope,
        )

    updates = data.model_dump(exclude_none=True)
    updates.pop("migrate_scope", None)  # 非 users 表字段
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

    message = "用户更新成功"
    if group_changed:
        scope_text = "仅该用户" if data.migrate_scope == "user" else "整个旧组（含其他成员）"
        overwritten = len(migration.get("overwritten_workbooks", []))
        overwrite_msg = f"，并覆盖了新组 {overwritten} 份同名工参" if overwritten else ""
        message = (
            f"用户更新成功，已按「{scope_text}」将历史数据迁移至新组 "
            f"{new_city}/{new_operator}：共迁移 {migration['total']} 条数据库记录、"
            f"{migration['index_entries']} 个文件索引{overwrite_msg}。"
        )
    return {"success": True, "data": user.to_dict(), "message": message}


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
