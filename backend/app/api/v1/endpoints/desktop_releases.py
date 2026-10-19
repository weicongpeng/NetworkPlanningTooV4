"""桌面版安装包版本管理 API（管理员，OTA 分发）。

复用 APP 版本管理（app_versions.py）的成熟模式：
- 1MB 分片上传绕过 Cloudflare 100MB 限制（start/chunk 不鉴权，complete 鉴权）
- 分片会话存内存（重启失效，重传即可）
- 落盘 DESKTOP_RELEASES_DIR，complete 时流式计算 sha256
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session
import logging

from app.core.config import settings
from app.core.database import get_db
from app.core.security import get_current_admin_user, reject_desktop_mode
from app.models.database import DesktopRelease, User

# 桌面端是升级的下游消费者，安装包只能在服务器端管理
router = APIRouter(tags=["桌面版版本管理"], dependencies=[Depends(reject_desktop_mode)])

logger = logging.getLogger(__name__)

RELEASES_DIR = settings.DESKTOP_RELEASES_DIR
_chunked_sessions: Dict[str, Dict[str, Any]] = {}


def _gbk_safe(message: str) -> str:
    return str(message).encode("gbk", "replace").decode("gbk")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_filename(version: str, original_name: str) -> str:
    safe_version = "".join(c for c in version if c.isalnum() or c in "._-")
    safe_name = "".join(
        c for c in os.path.basename(original_name) if c.isalnum() or c in "._-"
    )
    if not safe_name:
        safe_name = "NetOpt Engine_Setup.exe"
    return f"{safe_version}_{safe_name}"


def _format_size(size: Optional[int]) -> str:
    if not size:
        return "未知"
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _version_from_filename(filename: str) -> Optional[str]:
    """从安装包文件名解析版本号（NetOpt Engine_Setup-0.0.6.exe → 0.0.6）。

    解析不到返回 None：该类文件不登记，避免往 OTA 里塞版本号不可信的安装包。
    """
    stem = Path(filename).stem
    match = re.search(r"[Ss]etup[-_ ]?v?(\d+(?:\.\d+)+)", stem)
    if match:
        return match.group(1)
    match = re.search(r"(?<!\d)(\d+(?:\.\d+)+)(?!\d)", stem)
    return match.group(1) if match else None


def _ensure_latest(db: Session, channel: str) -> None:
    """把该渠道里「文件存在且版本最高」的记录设为最新。

    手工往目录里放包、或旧记录的文件被删掉后，is_latest 可能指向缺失/较旧的版本，
    OTA 会因此拿到 404 或旧包；导入/删除后统一按版本号重算一次。
    """
    records = [
        r for r in db.query(DesktopRelease).filter(DesktopRelease.channel == channel).all()
        if r.file_path and Path(r.file_path).is_file()
    ]
    if not records:
        return
    best = max(records, key=lambda r: (_version_key(r.version), r.id))
    changed = False
    for record in records:
        want_latest = record.id == best.id
        if bool(record.is_latest) != want_latest:
            record.is_latest = want_latest
            changed = True
    if changed:
        db.commit()


def _cleanup_stale_chunks(max_age_hours: int = 24) -> int:
    """清理中断上传残留的 chunks_* 目录（start 过但没 complete 的会话）。"""
    removed = 0
    try:
        cutoff = time.time() - max_age_hours * 3600
        live_dirs = {Path(s["dir"]) for s in _chunked_sessions.values() if s.get("dir")}
        for directory in RELEASES_DIR.glob("chunks_*"):
            if not directory.is_dir() or directory in live_dirs:
                continue
            try:
                if directory.stat().st_mtime < cutoff:
                    shutil.rmtree(directory, ignore_errors=True)
                    removed += 1
            except OSError:
                continue
    except Exception:  # noqa: BLE001
        return removed
    return removed


def _import_local_files(db: Session) -> List[DesktopRelease]:
    """登记手工放进 DESKTOP_RELEASES_DIR 的安装包（网页端列表与 OTA 都能看到）。

    只处理「没有被任何记录引用」的 .exe；版本号从文件名解析，解析不到或该版本
    已有记录则跳过（绝不覆盖已有记录）。
    """
    RELEASES_DIR.mkdir(parents=True, exist_ok=True)
    _cleanup_stale_chunks()
    records = db.query(DesktopRelease).all()
    known_paths = {Path(r.file_path).name for r in records if r.file_path}
    known_versions = {(r.version, r.channel) for r in records}
    imported: List[DesktopRelease] = []
    for path in sorted(RELEASES_DIR.glob("*.exe")):
        if path.name in known_paths:
            continue
        version = _version_from_filename(path.name)
        if not version or (version, "stable") in known_versions:
            continue
        record = DesktopRelease(
            version=version,
            channel="stable",
            filename=path.name,
            file_path=str(path),
            file_size=path.stat().st_size,
            sha256=_sha256_of(path),
            release_notes=None,
            is_latest=False,
            created_by="local-import",
            created_at=_now_iso(),
            updated_at=_now_iso(),
        )
        db.add(record)
        db.flush()
        known_versions.add((version, "stable"))
        imported.append(record)
    if imported:
        db.commit()
        _ensure_latest(db, "stable")
        for record in imported:
            db.refresh(record)
    return imported


def _clear_other_latest(db: Session, channel: str, exclude_id: Optional[int] = None) -> None:
    query = db.query(DesktopRelease).filter(
        DesktopRelease.channel == channel, DesktopRelease.is_latest == True  # noqa: E712
    )
    if exclude_id is not None:
        query = query.filter(DesktopRelease.id != exclude_id)
    for record in query.all():
        record.is_latest = False
    db.commit()


def _version_key(version: str) -> tuple:
    """宽松版本比较键：把数字段转 int，其余段按字符串（dev/rc 等后缀可比较）。"""
    parts = re.split(r"[.\-_+]", (version or "").strip())
    key = []
    for part in parts:
        key.append((0, int(part)) if part.isdigit() else (1, part))
    return tuple(key)


@router.get("")
@router.get("/")
async def list_releases(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    channel: Optional[str] = Query(default=None),
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    # 手工放进 DESKTOP_RELEASES_DIR 的安装包在这里登记入库（打开本页即可看到）
    try:
        imported = _import_local_files(db)
    except Exception as exc:  # noqa: BLE001
        imported = []
        logger.warning("扫描本地安装包目录失败: %s", _gbk_safe(exc))
    query = db.query(DesktopRelease)
    if channel:
        query = query.filter(DesktopRelease.channel == channel)
    total = query.count()
    records = (
        query.order_by(DesktopRelease.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = []
    for record in records:
        data = record.to_dict()
        data["file_size_display"] = _format_size(record.file_size)
        # 文件被删掉（手工清理/迁移）时前端要能看出来，否则 OTA 会拿到 404
        data["file_missing"] = not (record.file_path and Path(record.file_path).is_file())
        items.append(data)
    return {
        "success": True,
        "data": {"total": total, "items": items, "imported": len(imported)},
    }


@router.post("/chunked/start")
async def chunked_start(
    filename: str = Form(...),
    total_chunks: int = Form(...),
    total_size: int = Form(default=0),
) -> Dict[str, Any]:
    """初始化分片上传（不鉴权：分片请求带不上拦截器；complete 时才校验管理员）。"""
    if total_chunks <= 0 or total_chunks > 20000:
        raise HTTPException(status_code=400, detail="分片数量不合法")
    upload_id = str(uuid.uuid4())
    chunks_dir = RELEASES_DIR / f"chunks_{upload_id}"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    _chunked_sessions[upload_id] = {
        "filename": filename,
        "total_chunks": total_chunks,
        "total_size": total_size,
        "dir": chunks_dir,
        "created_at": _now_iso(),
    }
    return {"success": True, "data": {"id": upload_id, "total_chunks": total_chunks}}


@router.post("/chunked/{upload_id}/chunk")
async def chunked_upload(
    upload_id: str,
    chunk_index: int = Form(...),
    file: UploadFile = File(...),
) -> Dict[str, Any]:
    session = _chunked_sessions.get(upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail="上传会话不存在或已过期，请重新上传")
    if not 0 <= chunk_index < session["total_chunks"]:
        raise HTTPException(status_code=400, detail="分片序号不合法")
    target = session["dir"] / f"chunk_{chunk_index:06d}"
    content = await file.read()
    target.write_bytes(content)
    return {"success": True, "data": {"index": chunk_index, "size": len(content)}}


@router.post("/chunked/{upload_id}/complete")
async def chunked_complete(
    upload_id: str,
    version: str = Form(...),
    channel: str = Form(default="stable"),
    release_notes: str = Form(default=""),
    is_latest: bool = Form(default=True),
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    session = _chunked_sessions.get(upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail="上传会话不存在或已过期，请重新上传")

    chunks_dir: Path = session["dir"]
    total = int(session["total_chunks"])
    received = {int(p.name.split("_")[1]) for p in chunks_dir.glob("chunk_*")}
    missing = [i for i in range(total) if i not in received]
    if missing:
        raise HTTPException(
            status_code=400, detail=f"缺失 {len(missing)} 个分块，请重试上传"
        )

    version = (version or "").strip()
    if not version:
        raise HTTPException(status_code=400, detail="版本号不能为空")
    channel = (channel or "stable").strip() or "stable"

    # 先移除会话，避免并发重复合并
    _chunked_sessions.pop(upload_id, None)
    RELEASES_DIR.mkdir(parents=True, exist_ok=True)
    filename = _safe_filename(version, session["filename"])
    final_path = RELEASES_DIR / f"{uuid.uuid4().hex[:8]}_{filename}"

    def _merge_chunks() -> None:
        with final_path.open("wb") as out:
            for index in range(total):
                out.write((chunks_dir / f"chunk_{index:06d}").read_bytes())

    # 合并几百 MB 分片会阻塞事件循环（其他请求全部排队、Cloudflare 可能 524），放到线程池
    from starlette.concurrency import run_in_threadpool

    try:
        await run_in_threadpool(_merge_chunks)
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(chunks_dir, ignore_errors=True)
        final_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=_gbk_safe(f"合并分片失败: {exc}"))
    shutil.rmtree(chunks_dir, ignore_errors=True)

    sha256 = await run_in_threadpool(_sha256_of, final_path)
    record = DesktopRelease(
        version=version,
        channel=channel,
        filename=filename,
        file_path=str(final_path),
        file_size=final_path.stat().st_size,
        sha256=sha256,
        release_notes=(release_notes or "").strip() or None,
        is_latest=bool(is_latest),
        created_by=admin_user.username,
        created_at=_now_iso(),
        updated_at=_now_iso(),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    if is_latest:
        _clear_other_latest(db, channel, exclude_id=record.id)

    data = record.to_dict()
    data["file_size_display"] = _format_size(record.file_size)
    return {"success": True, "data": data}


@router.put("/{release_id}")
async def update_release(
    release_id: int,
    version: Optional[str] = Form(default=None),
    channel: Optional[str] = Form(default=None),
    release_notes: Optional[str] = Form(default=None),
    is_latest: Optional[bool] = Form(default=None),
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    record = db.query(DesktopRelease).filter(DesktopRelease.id == release_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="版本记录不存在")
    if version is not None and version.strip():
        record.version = version.strip()
    if channel is not None and channel.strip():
        record.channel = channel.strip()
    if release_notes is not None:
        record.release_notes = release_notes.strip() or None
    if is_latest is not None:
        record.is_latest = bool(is_latest)
    record.updated_at = _now_iso()
    db.commit()
    db.refresh(record)
    if record.is_latest:
        _clear_other_latest(db, record.channel, exclude_id=record.id)
    return {"success": True, "data": record.to_dict()}


@router.post("/{release_id}/set-latest")
async def set_latest(
    release_id: int,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    record = db.query(DesktopRelease).filter(DesktopRelease.id == release_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="版本记录不存在")
    record.is_latest = True
    record.updated_at = _now_iso()
    db.commit()
    _clear_other_latest(db, record.channel, exclude_id=record.id)
    db.refresh(record)
    return {"success": True, "data": record.to_dict()}


@router.delete("/{release_id}")
async def delete_release(
    release_id: int,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    record = db.query(DesktopRelease).filter(DesktopRelease.id == release_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="版本记录不存在")
    channel = record.channel
    try:
        Path(record.file_path).unlink(missing_ok=True)
    except OSError:
        pass
    db.delete(record)
    db.commit()
    # 删掉的若是最新版，回退到剩余版本里最高的那个（否则 OTA 会一直 404）
    _ensure_latest(db, channel)
    return {"success": True, "message": "已删除"}
