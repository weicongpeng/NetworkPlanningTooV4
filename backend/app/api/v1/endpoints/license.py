"""
许可证管理API端点

授权模型：以管理员用户的 license_expiry 为全局授权依据
"""

from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from typing import Dict, Any, Optional
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.security import get_current_admin_user, get_current_user
from app.models.database import User
from app.models.schemas import LicenseStatus, LicenseResponse
from app.services.license_service import license_service
from app.utils.machine_code import get_machine_code

router = APIRouter()


class UpdateExpiryRequest(BaseModel):
    expiry_date: Optional[str] = None  # "YYYY-MM-DD" 或 null（无限期）


@router.get("/status", response_model=Dict[str, Any])
async def get_license_status() -> Dict[str, Any]:
    """获取许可证状态"""
    try:
        status = license_service.get_status()
        return {"success": True, "data": status.dict()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/upload", response_model=Dict[str, Any])
async def upload_license(file: UploadFile = File(...)) -> Dict[str, Any]:
    """
    上传许可证文件激活

    支持的文件格式：
    - .lic: 标准许可证文件（Base64编码）
    - .dat: 二进制许可证文件
    - .txt: 文本格式的许可证密钥
    """
    try:
        # 读取文件内容
        content = await file.read()

        # 上传并激活许可证
        success, message = license_service.upload(content)

        return {"success": success, "message": message}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"上传许可证失败: {str(e)}")


@router.post("/activate", response_model=Dict[str, Any])
async def activate_license(license_key: str = None) -> Dict[str, Any]:
    """
    激活许可证（通过密钥）

    注意：简化版主要使用文件上传激活，此端点保留以备用
    """
    try:
        if not license_key:
            raise HTTPException(status_code=400, detail="license_key is required")

        success, message = license_service.activate(license_key)
        return {"success": success, "message": message}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/check", response_model=Dict[str, Any])
async def check_license() -> Dict[str, Any]:
    """检查许可证是否有效（用于前端路由守卫）"""
    try:
        is_valid = license_service.check_permission()
        return {"success": True, "data": {"valid": is_valid}}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/machine-info", response_model=Dict[str, Any])
async def get_machine_info(current_user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """桌面版机器码信息（用于厂商签发绑定本机的授权文件）。"""
    try:
        return {
            "success": True,
            "data": {
                "machineCode": get_machine_code(),
                "desktopMode": settings.NPT_DESKTOP,
            },
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/update-expiry", response_model=Dict[str, Any])
async def update_license_expiry(
    data: UpdateExpiryRequest,
    admin_user: User = Depends(get_current_admin_user),
):
    """
    管理员更新全局授权期限（即管理员自身的 license_expiry）

    expiry_date: "YYYY-MM-DD" 格式的日期字符串，或 null 表示无限期

    桌面离线版：授权期限由厂商签发的授权文件控制，此接口直接拒绝。
    """
    if settings.NPT_DESKTOP:
        raise HTTPException(
            status_code=403,
            detail="桌面版授权期限由授权文件控制，请联系厂商续期",
        )
    try:
        result = license_service.update_admin_license_expiry(data.expiry_date)
        if result is None:
            raise HTTPException(status_code=400, detail="更新授权期限失败")
        return {"success": True, "data": result, "message": "授权期限更新成功"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
