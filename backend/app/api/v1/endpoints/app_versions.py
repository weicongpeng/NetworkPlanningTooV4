"""
APP 版本管理 API 端点
PC 端管理员上传/管理 APK 版本，APP 端检查最新版本并下载
"""
import os
import re
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import get_current_admin_user
from app.models.database import User, AppVersion
from app.models.schemas import AppVersionUpdate
from app.core.config import settings
import logging

logger = logging.getLogger(__name__)
router = APIRouter(tags=["APP版本管理"])

# APK 存储目录（可写数据根下）
APKS_DIR = settings.APKS_DIR


def _read_range(path: str, start: int, end: int) -> bytes:
    """同步读取文件的指定字节范围（在线程池中执行）"""
    with open(path, "rb") as f:
        f.seek(start)
        return f.read(end - start + 1)

# ===== 分块上传会话存储（解决 Cloudflare 413/524 问题）=====
# APK 文件通常 >100MB，Cloudflare 默认限制 100MB。
# 通过 500KB 分块绕过此限制。会话存储在内存中，重启可重新上传。
_chunked_sessions: Dict[str, Dict[str, Any]] = {}


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


def _cleanup_orphaned_records(db: Session) -> int:
    """清理数据库中 APK 文件已被手动删除的孤立记录，返回清理数量"""
    cleaned = 0
    for v in db.query(AppVersion).all():
        file_path = Path(v.apk_path)
        if not file_path.exists():
            logger.warning(f"APK 文件不存在，删除孤立记录: {v.version} (ID: {v.id}, path: {v.apk_path})")
            db.delete(v)
            cleaned += 1
    if cleaned:
        db.commit()
    return cleaned


@router.get("")
@router.get("/")
async def list_versions(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """管理员分页获取版本列表（自动清理文件已缺失的孤立记录）"""
    # 自动清理 APK 文件已不存在的孤立数据库记录
    _cleanup_orphaned_records(db)

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


@router.post("")
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
    request: Request,
    db: Session = Depends(get_db),
):
    """公开下载 APK 文件（无需认证）

    支持 HTTP Range 请求头（断点续传和并行分块下载）。
    前端并行下载加速器通过 Range 头将 200MB 文件分成 N 块同时下载。
    """
    app_version = db.query(AppVersion).filter(AppVersion.id == version_id).first()
    if not app_version:
        raise HTTPException(status_code=404, detail="版本不存在")

    file_path = Path(app_version.apk_path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="APK 文件不存在，可能已被删除")

    range_header = request.headers.get("range")

    # 增加下载次数（仅真正的完整 GET 下载计数，排除 HEAD 探测和 Range 分块）
    # - HEAD 请求用于 parallelDownload 文件大小探测，不应计数
    # - Range 请求是并行分块下载的片段，不应分别计数
    if request.method == "GET" and not range_header:
        app_version.download_count = (app_version.download_count or 0) + 1
        db.commit()

    file_size = file_path.stat().st_size

    # 中文文件名 URL 编码
    from urllib.parse import quote
    safe_filename = app_version.apk_filename
    encoded_filename = quote(safe_filename)

    base_headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}",
        "Accept-Ranges": "bytes",
        # 禁止缓存，确保每次下载都到达后端、正确计数
        "Cache-Control": "private, no-store, max-age=0",
    }

    # ===== 处理 Range 请求（支持断点续传和并行分块下载）=====
    if range_header:
        try:
            # 解析 Range: bytes=start-end
            range_match = re.match(r"bytes=(\d+)-(\d*)", range_header)
            if range_match:
                start = int(range_match.group(1))
                end_str = range_match.group(2)
                end = int(end_str) if end_str else (file_size - 1)

                # 校验范围
                if start < 0 or start >= file_size or end >= file_size or start > end:
                    return Response(
                        status_code=416,
                        headers={
                            **base_headers,
                            "Content-Range": f"bytes */{file_size}",
                        },
                    )

                content_length = end - start + 1

                # 异步读取指定字节范围（使用线程池避免阻塞事件循环）
                import asyncio
                loop = asyncio.get_event_loop()

                async def ranged_data() -> bytes:
                    return await loop.run_in_executor(None, _read_range, str(file_path), start, end)

                data = await ranged_data()
                return Response(
                    content=data,
                    status_code=206,
                    media_type="application/vnd.android.package-archive",
                    headers={
                        **base_headers,
                        "Content-Range": f"bytes {start}-{end}/{file_size}",
                        "Content-Length": str(content_length),
                    },
                )
        except (ValueError, IndexError):
            # Range 头格式异常，回退到完整下载
            pass

    # ===== 完整文件下载（默认路径）=====
    return FileResponse(
        path=str(file_path),
        filename=safe_filename,
        media_type="application/vnd.android.package-archive",
        headers=base_headers,
    )


@router.post("/import-local")
async def import_local_apks(
    version_override: str | None = Form(default=None, description="强制指定版本号（可选）"),
    changelog: str = Form(default="", description="更新说明（可选）"),
    mark_latest: bool = Form(default=True, description="是否标记为最新版本"),
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """管理员导入 APK 目录中已有的 APK 文件到数据库

    扫描 apks/ 目录下的所有 .apk 文件，将未注册的文件导入数据库。
    版本号优先从文件名中提取（如 'V2.0.0'、'v1.3.0-beta'、'2.0.1'），
    提取失败则使用文件名作为版本号。
    已注册的文件（apk_filename 匹配）会被跳过。
    """
    APKS_DIR.mkdir(parents=True, exist_ok=True)

    # 获取已有记录的文件名集合
    existing_filenames = set()
    for v in db.query(AppVersion).all():
        if v.apk_filename:
            existing_filenames.add(v.apk_filename)

    imported = []
    skipped = []

    for f in sorted(APKS_DIR.iterdir()):
        if not f.is_file() or not f.name.endswith(".apk"):
            continue

        # 跳过已注册的文件
        if f.name in existing_filenames:
            skipped.append({"filename": f.name, "reason": "数据库已存在"})
            continue

        # 提取版本号
        if version_override:
            ver = version_override
        else:
            # 尝试从文件名提取版本号：V2.0.0 / v1.3.0-beta / 2.0.1 ...
            import re
            match = re.search(r"[vV]?(\d[\d.]*(?:-\w+)?)", f.stem)
            if match:
                ver = match.group(1)
            else:
                ver = f.stem  # 回退：使用文件名（不含扩展名）

        now = datetime.now(timezone.utc).isoformat()
        file_size = f.stat().st_size

        app_version = AppVersion(
            version=ver,
            changelog=changelog.strip() if changelog else "",
            apk_filename=f.name,
            apk_path=str(f.resolve()),
            file_size=file_size,
            is_latest=mark_latest,
            created_at=now,
        )
        db.add(app_version)

        # 如果标记为最新，清除其他版本的最新标记
        if mark_latest:
            _clear_other_latest(db)

        imported.append({
            "filename": f.name,
            "version": ver,
            "file_size": file_size,
            "file_size_display": _format_size(file_size),
        })

    db.commit()

    # 重新查询导入的记录以获得 id
    for item in imported:
        record = db.query(AppVersion).filter(
            AppVersion.apk_filename == item["filename"]
        ).first()
        if record:
            item["id"] = record.id

    logger.info(
        f"管理员 {admin_user.username} 执行了本地APK导入: "
        f"成功 {len(imported)} 个, 跳过 {len(skipped)} 个"
    )

    return {
        "success": True,
        "data": {
            "imported": imported,
            "skipped": skipped,
            "total_imported": len(imported),
            "total_skipped": len(skipped),
        },
        "message": f"成功导入 {len(imported)} 个 APK 文件",
    }


# ===== 分块上传端点（解决 Cloudflare 413 Payload Too Large）=====
# APK 文件通常 100MB+，Cloudflare 默认限制 100MB。
# 分块上传将文件切为 500KB 小块分别上传，避免超限。
#
# 流程: /chunked/start -> /chunked/{id}/chunk (N次) -> /chunked/{id}/complete
# 与前端 chunkedUpload() 函数兼容。


@router.post("/chunked/start")
async def start_chunked_upload(
    filename: str = Form(...),
    total_chunks: int = Form(...),
    total_size: int = Form(...),
):
    """初始化分块上传会话（无需认证，/complete 才校验管理员权限）"""
    upload_id = str(uuid.uuid4())
    chunks_dir = APKS_DIR / f"chunks_{upload_id}"
    chunks_dir.mkdir(parents=True, exist_ok=True)

    safe_filename = re.sub(r'[<>:"/\\|?*]', "_", filename)
    if len(safe_filename) > 100:
        name_part, ext = os.path.splitext(safe_filename)
        safe_filename = name_part[:90] + ext

    _chunked_sessions[upload_id] = {
        "filename": safe_filename,
        "chunks_dir": str(chunks_dir),
        "total_chunks": total_chunks,
        "total_size": total_size,
        "received": set(),
        "created_at": time.time(),
    }

    logger.info(
        f"[ChunkedUpload-APK] 会话已创建: {upload_id}, "
        f"文件: {safe_filename}, 分块: {total_chunks}"
    )

    return {
        "success": True,
        "data": {
            "id": upload_id,
            "total_chunks": total_chunks,
        }
    }


@router.post("/chunked/{upload_id}/chunk")
async def upload_chunk(
    upload_id: str,
    chunk_index: int = Form(...),
    file: UploadFile = File(...),
):
    """上传单个分块（无需认证）"""
    session = _chunked_sessions.get(upload_id)
    if not session:
        raise HTTPException(status_code=404, detail="上传会话不存在或已过期")

    content = await file.read()
    chunk_path = Path(session["chunks_dir"]) / f"chunk_{chunk_index:06d}"
    chunk_path.write_bytes(content)
    session["received"].add(chunk_index)

    return {
        "success": True,
        "data": {
            "chunk_index": chunk_index,
            "size": len(content),
            "received": len(session["received"]),
            "total": session["total_chunks"],
        },
    }


@router.post("/chunked/{upload_id}/complete")
async def complete_chunked_upload(
    upload_id: str,
    version: str = Form(..., description="版本号，如 1.2.0"),
    changelog: str = Form(default="", description="更新说明"),
    is_latest: bool = Form(default=False, description="是否标记为最新版本"),
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """完成分块上传：重组文件、保存 APK、创建数据库记录"""
    session = _chunked_sessions.get(upload_id)
    if not session:
        raise HTTPException(status_code=404, detail="上传会话不存在或已过期")

    # 验证版本号
    if not version.strip():
        raise HTTPException(status_code=400, detail="版本号不能为空")

    chunks_dir = Path(session["chunks_dir"])
    total = session["total_chunks"]

    # 验证所有分块已接收
    if len(session["received"]) != total:
        missing = [i for i in range(total) if i not in session["received"]]
        raise HTTPException(status_code=400, detail=f"缺失 {len(missing)} 个分块")

    # 生成安全的 APK 文件名
    safe_name = _safe_filename(version, session["filename"])
    file_path = APKS_DIR / safe_name

    # 如果文件已存在，先删除
    if file_path.exists():
        file_path.unlink()

    # 清理会话记录（在重组前，防止并发）
    del _chunked_sessions[upload_id]

    # 重组文件
    logger.info(f"[ChunkedUpload-APK] 开始重组文件: {upload_id} -> {safe_name}")
    try:
        with open(file_path, "wb") as out:
            for i in range(total):
                chunk_path = chunks_dir / f"chunk_{i:06d}"
                if not chunk_path.exists():
                    raise HTTPException(
                        status_code=400, detail=f"分块 {i} 不存在，上传可能已损坏"
                    )
                out.write(chunk_path.read_bytes())
    except Exception:
        # 清理分块目录
        shutil.rmtree(chunks_dir, ignore_errors=True)
        raise

    # 清理分块目录
    shutil.rmtree(chunks_dir, ignore_errors=True)

    file_size = file_path.stat().st_size
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

    logger.info(
        f"管理员 {admin_user.username} 通过分块上传了 APP 版本 {version} "
        f"(文件: {safe_name}, {_format_size(file_size)})"
    )

    data = app_version.to_dict()
    data["file_size_display"] = _format_size(file_size)
    return {"success": True, "data": data, "message": "版本上传成功"}
