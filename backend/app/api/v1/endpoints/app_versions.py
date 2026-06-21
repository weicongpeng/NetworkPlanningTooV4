"""
APP 版本管理 API 端点
PC 端管理员上传/管理 APK 版本，APP 端检查最新版本并下载
"""
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import get_current_admin_user
from app.models.database import User, AppVersion
from app.models.schemas import AppVersionCreate, AppVersionUpdate, AppVersionOut
import logging

logger = logging.getLogger(__name__)
router = APIRouter(tags=["APP版本管理"])

# APK 存储目录
APKS_DIR = Path(__file__).parent.parent.parent.parent / "apks"


def _get_download_url(request_path: str) -> str:
    """从请求路径拼接下载 URL"""
    return f"{request_path}/download"


def _format_size(size: int) -> str:
    """格式化文件大小"""
    if size is None:
        return "未知"
    if size < 1024:
        return f"{size} B"
    elif size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    else:
        return f"{size / (1024 * 1024):.1f} MB"


def _safe_filename(version: str, original_name: str) -> str:
    """生成安全的文件名：version_original_name"""
    # 清理版本号中的非法字符
    safe_version = "".join(c for c in version if c.isalnum() or c in "._-")
    # 保留原始文件名但去除路径和特殊字符
    safe_name = "".join(c for c in os.path.basename(original_name) if c.isalnum() or c in "._-")
    if not safe_name:
        safe_name = "app-release.apk"
    return f"{safe_version}_{safe_name}"


def _clear_other_latest(db: Session, exclude_id: int | None = None) -> None:
    """将所有非指定版本的 is_latest 设为 False"""
    query = db.query(AppVersion).filter(AppVersion.is_latest == True)
    if exclude_id is not None:
        query = query.filter(AppVersion.id != exclude_id)
    for v in query.all():
        v.is_latest = False
    db.commit()


@router.get("/")
async def list_versions(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """管理员分页获取版本列表"""
    total = db.query(AppVersion).count()
    versions = (
        db.query(AppVersion)
        .order_by(AppVersion.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = []
    for v in versions:
        item = v.to_dict()
        item["file_size_display"] = _format_size(v.file_size)
        items.append(item)
    return {
        "success": True,
        "data": {
            "total": total,
            "items": items,
        },
    }


@router.get("/latest")
async def get_latest_version(db: Session = Depends(get_db)):
    """公开获取最新版本（无需认证）"""
    version = (
        db.query(AppVersion)
        .filter(AppVersion.is_latest == True)
        .order_by(AppVersion.created_at.desc())
        .first()
    )
    if not version:
        return {"success": True, "data": None}

    data = version.to_dict()
    data["file_size_display"] = _format_size(version.file_size)
    data["download_url"] = f"/api/v1/app-versions/download/{version.id}"
    return {"success": True, "data": data}


@router.post("/")
async def upload_version(
    file: UploadFile = File(..., description="APK 文件"),
    version: str = Form(..., description="版本号，如 1.2.0"),
    changelog: str = Form(default="", description="更新说明"),
    is_latest: bool = Form(default=False, description="是否标记为最新版本"),
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """管理员上传新版本 APK"""
    # 验证版本号
    if not version.strip():
        raise HTTPException(status_code=400, detail="版本号不能为空")

    # 验证文件类型
    if not file.filename or not file.filename.endswith(".apk"):
        raise HTTPException(status_code=400, detail="请上传 .apk 格式的文件")

    # 确保 APK 目录存在
    APKS_DIR.mkdir(parents=True, exist_ok=True)

    # 生成安全文件名并保存文件
    safe_name = _safe_filename(version, file.filename or "app-release.apk")
    file_path = APKS_DIR / safe_name

    # 检查文件是否已存在
    if file_path.exists():
        # 如果文件已存在，先删除旧的
        file_path.unlink()

    # 写入文件
    content = await file.read()
    file_path.write_bytes(content)
    file_size = len(content)

    now = datetime.now(timezone.utc).isoformat()

    # 如果标记为最新，清除其他版本的最新标记
    if is_latest:
        _clear_other_latest(db)

    # 创建数据库记录
    app_version = AppVersion(
        version=version.strip(),
        changelog=changelog.strip() if changelog else "",
        apk_filename=safe_name,
        apk_path=str(file_path),
        file_size=file_size,
        is_latest=is_latest,
        created_at=now,
    )
    db.add(app_version)
    db.commit()
    db.refresh(app_version)

    logger.info(f"管理员 {admin_user.username} 上传了 APP 版本 {version} (文件: {safe_name}, {_format_size(file_size)})")

    data = app_version.to_dict()
    data["file_size_display"] = _format_size(file_size)
    return {"success": True, "data": data, "message": "版本上传成功"}


@router.put("/{version_id}")
async def update_version(
    version_id: int,
    data: AppVersionUpdate,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """管理员编辑版本信息"""
    app_version = db.query(AppVersion).filter(AppVersion.id == version_id).first()
    if not app_version:
        raise HTTPException(status_code=404, detail="版本不存在")

    old_version = app_version.version
    old_filename = app_version.apk_filename

    # 更新字段
    if data.version is not None:
        app_version.version = data.version.strip()
    if data.changelog is not None:
        app_version.changelog = data.changelog.strip()

    # 处理 is_latest 互斥逻辑
    if data.is_latest is not None and data.is_latest:
        _clear_other_latest(db, exclude_id=version_id)
        app_version.is_latest = True
    elif data.is_latest is not None and not data.is_latest:
        app_version.is_latest = False

    # 如果版本号变更，重命名 APK 文件
    if data.version is not None and data.version.strip() != old_version:
        new_filename = _safe_filename(data.version.strip(), old_filename)
        new_path = APKS_DIR / new_filename
        old_path = Path(app_version.apk_path)

        if old_path.exists():
            shutil.move(str(old_path), str(new_path))
            app_version.apk_filename = new_filename
            app_version.apk_path = str(new_path)

    app_version.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    db.refresh(app_version)

    logger.info(f"管理员 {admin_user.username} 编辑了 APP 版本 {version_id}: {old_version} -> {app_version.version}")

    data = app_version.to_dict()
    data["file_size_display"] = _format_size(app_version.file_size)
    return {"success": True, "data": data, "message": "版本更新成功"}


@router.delete("/{version_id}")
async def delete_version(
    version_id: int,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """管理员删除版本（同时删除 APK 文件）"""
    app_version = db.query(AppVersion).filter(AppVersion.id == version_id).first()
    if not app_version:
        raise HTTPException(status_code=404, detail="版本不存在")

    # 删除 APK 文件
    file_path = Path(app_version.apk_path)
    if file_path.exists():
        file_path.unlink()
        logger.info(f"已删除 APK 文件: {file_path}")

    # 删除数据库记录
    db.delete(app_version)
    db.commit()

    logger.info(f"管理员 {admin_user.username} 删除了 APP 版本 {app_version.version} (ID: {version_id})")
    return {"success": True, "message": "版本已删除"}


@router.get("/download/{version_id}")
async def download_apk(
    version_id: int,
    db: Session = Depends(get_db),
):
    """公开下载 APK 文件（无需认证）"""
    app_version = db.query(AppVersion).filter(AppVersion.id == version_id).first()
    if not app_version:
        raise HTTPException(status_code=404, detail="版本不存在")

    file_path = Path(app_version.apk_path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="APK 文件不存在，可能已被删除")

    return FileResponse(
        path=str(file_path),
        filename=app_version.apk_filename,
        media_type="application/vnd.android.package-archive",
        headers={
            "Content-Disposition": f'attachment; filename="{app_version.apk_filename}"',
        },
    )
