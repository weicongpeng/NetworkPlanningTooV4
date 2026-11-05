"""桌面版在线授权-管理端接口（仅管理员）。"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import get_current_admin_user, reject_desktop_mode
from app.models.database import User
from app.services.desktop_license_service import (
    DesktopLicenseError,
    desktop_license_service,
)

# 桌面端是被管理方，授权只能由服务器「桌面授权」页操作
router = APIRouter(tags=["桌面授权管理"], dependencies=[Depends(reject_desktop_mode)])


def _gbk_safe(message: str) -> str:
    return str(message).encode("gbk", "replace").decode("gbk")


class DesktopLicenseCreate(BaseModel):
    licensee_username: str = Field(..., description="被授权用户/单位名称")
    organization: Optional[str] = None
    machine_code: Optional[str] = Field(default=None, description="可预先绑定机器码")
    lease_days: Optional[int] = Field(default=None, ge=1, le=3650)
    note: Optional[str] = None
    with_code: bool = Field(default=True, description="是否立即生成激活码")
    # 数据组：留空 = 由桌面端自选（首次同步时绑定到本授权）；指定则桌面端强制跟随
    city: Optional[str] = None
    operator: Optional[str] = None
    # 绑定的网页端账号（桌面端与网页端共用账号权限）；单机用户无操作自动退出登录的时长
    username: Optional[str] = None
    idle_logout_days: Optional[int] = Field(default=None, ge=1, le=365)


class DesktopLicenseUpdate(BaseModel):
    licensee_username: Optional[str] = None
    organization: Optional[str] = None
    lease_days: Optional[int] = Field(default=None, ge=1, le=3650)
    note: Optional[str] = None
    city: Optional[str] = None
    operator: Optional[str] = None
    idle_logout_days: Optional[int] = Field(default=None, ge=1, le=365)


class DesktopLicenseReview(BaseModel):
    lease_days: Optional[int] = Field(default=None, ge=1, le=3650)
    note: Optional[str] = None
    idle_logout_days: Optional[int] = Field(default=None, ge=1, le=365)


@router.get("")
@router.get("/")
async def list_desktop_licenses(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    status: Optional[str] = Query(default=None),
    keyword: Optional[str] = Query(default=None),
    mode: Optional[str] = Query(default=None, description="standalone=单机授权 / shared=共享模式自动签发 / 空=全部"),
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    total, records = desktop_license_service.list_licenses(
        db, page, page_size, status, keyword, mode
    )
    # 数据组与到期以「用户管理」为准：展示值取自绑定账号，组变化时回写授权记录
    items = desktop_license_service.admin_list_items(db, records)
    return {"success": True, "data": {"total": total, "items": items}}


@router.post("")
@router.post("/")
async def create_desktop_license(
    payload: DesktopLicenseCreate,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        record, code = desktop_license_service.create(
            db,
            licensee_username=payload.licensee_username,
            organization=payload.organization,
            machine_code=payload.machine_code,
            lease_days=payload.lease_days,
            note=payload.note,
            created_by=admin_user.username,
            with_code=payload.with_code,
            city=payload.city,
            operator=payload.operator,
            idle_logout_days=payload.idle_logout_days,
            username=payload.username,
        )
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    data = record.to_dict()
    data["activation_code"] = code
    return {"success": True, "data": data}


@router.put("/{license_id}")
async def update_desktop_license(
    license_id: int,
    payload: DesktopLicenseUpdate,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        record = desktop_license_service.update(
            db,
            license_id,
            licensee_username=payload.licensee_username,
            organization=payload.organization,
            lease_days=payload.lease_days,
            note=payload.note,
            city=payload.city,
            operator=payload.operator,
            idle_logout_days=payload.idle_logout_days,
        )
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    return {"success": True, "data": record.to_dict()}


@router.delete("/{license_id}")
async def delete_desktop_license(
    license_id: int,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        desktop_license_service.delete(db, license_id)
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    return {"success": True, "message": "已删除"}


@router.post("/{license_id}/approve")
async def approve_desktop_license(
    license_id: int,
    payload: DesktopLicenseReview,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        record, code = desktop_license_service.approve(
            db,
            license_id,
            lease_days=payload.lease_days,
            note=payload.note,
            approved_by=admin_user.username,
            idle_logout_days=payload.idle_logout_days,
        )
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    data = record.to_dict()
    data["activation_code"] = code
    return {"success": True, "data": data}


@router.post("/{license_id}/reject")
async def reject_desktop_license(
    license_id: int,
    payload: DesktopLicenseReview,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        record = desktop_license_service.reject(db, license_id, note=payload.note)
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    return {"success": True, "data": record.to_dict()}


@router.post("/{license_id}/disable")
async def disable_desktop_license(
    license_id: int,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        record = desktop_license_service.disable(db, license_id)
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    return {"success": True, "data": record.to_dict()}


@router.post("/{license_id}/enable")
async def enable_desktop_license(
    license_id: int,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        record = desktop_license_service.enable(db, license_id)
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    return {"success": True, "data": record.to_dict()}


@router.post("/{license_id}/unbind")
async def unbind_desktop_license(
    license_id: int,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        record = desktop_license_service.unbind(db, license_id)
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    return {"success": True, "data": record.to_dict()}


@router.post("/{license_id}/regenerate-code")
async def regenerate_desktop_code(
    license_id: int,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        record, code = desktop_license_service.regenerate_code(db, license_id)
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    data = record.to_dict()
    data["activation_code"] = code
    return {"success": True, "data": data}
