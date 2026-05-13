"""
许可证管理API端点（简化版）
"""

from fastapi import APIRouter, UploadFile, File, HTTPException
from typing import Dict, Any
from app.models.schemas import LicenseStatus, LicenseResponse
from app.services.license_service import license_service

router = APIRouter()


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
