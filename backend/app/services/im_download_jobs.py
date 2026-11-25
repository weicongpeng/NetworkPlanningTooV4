"""桌面端 IM 附件本地缓存任务：后台分块落盘 + 进度查询 + 完成后定位文件。

桌面共享模式的附件在云端，103MB 级文件若让前端一次性取 Blob 会占满内存且无进度；
这里在本机后端后台分块写盘，前端只轮询百分比，完成后走壳层在资源管理器中选中。
"""
from __future__ import annotations

import base64
import shutil
import threading
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from fastapi import HTTPException

from app import desktop_bridge
from app.core.config import settings
from app.core.database import SessionLocal
from app.services import (
    desktop_im_storage, im_attachment_service, im_desktop_proxy, im_ops, im_service,
)

_lock = threading.Lock()
_jobs: Dict[Tuple[int, int], Dict[str, Any]] = {}


def _key(user_id: int, attachment_id: int) -> Tuple[int, int]:
    return int(user_id), int(attachment_id)


def status(user_id: int, attachment_id: int) -> Dict[str, Any]:
    with _lock:
        return dict(_jobs.get(_key(user_id, attachment_id), {
            "status": "idle", "percent": 0, "phase": "", "path": "", "error": "",
        }))


def _update(key: Tuple[int, int], **fields: Any) -> None:
    with _lock:
        state = _jobs.setdefault(key, {
            "status": "running", "percent": 0, "phase": "", "path": "", "error": "",
        })
        state.update(fields)


def _target_path(out_dir: Path, filename: str) -> Tuple[Path, Path]:
    safe = im_attachment_service.clean_filename(filename or "attachment")
    target = out_dir / safe
    stem, suffix = target.stem, target.suffix
    index = 1
    while target.exists():
        target = out_dir / f"{stem}-{index}{suffix}"
        index += 1
    return target, target.with_name(target.name + ".part")


def _copy_with_progress(source: Path, part: Path, total: int,
                        key: Tuple[int, int]) -> None:
    done = 0
    with source.open("rb") as reader, part.open("wb") as writer:
        while True:
            chunk = reader.read(64 * 1024)
            if not chunk:
                break
            writer.write(chunk)
            done += len(chunk)
            percent = min(95, int(done * 100 / total)) if total else 50
            _update(key, percent=percent, phase="缓存到本地")


def _run_job(key: Tuple[int, int], user_id: int, attachment_id: int,
             filename: str, reveal: bool) -> None:
    db = SessionLocal()
    part: Optional[Path] = None
    try:
        out_dir = desktop_im_storage.effective_attachment_dir().parent / "downloads"
        out_dir.mkdir(parents=True, exist_ok=True)
        target, part = _target_path(out_dir, filename)
        _update(key, percent=2, phase="准备下载")

        mime = "application/octet-stream"
        if settings.DESKTOP_PROFILE == "shared" or im_desktop_proxy.is_shared_desktop():
            # 共享模式的附件只存在云端：必须和 im.py 的 _run 一样走 relay 转发，
            # 直接 run_local_op 查不到本机 ImAttachment，下载会立刻失败。
            data = im_desktop_proxy.forward("attachment_urls", {
                "items": [{"attachment_id": attachment_id, "thumb": False}],
            })
            info = (data or {}).get("tokens", {}).get(f"{attachment_id}:0")
            if info:
                mime, resolved_name, _ = im_desktop_proxy.stream_signed_attachment_to_file(
                    info, part, lambda p: _update(
                        key, percent=max(2, int(p * 0.95)), phase="下载中"))
                filename = resolved_name or filename
            else:
                payload = im_desktop_proxy.forward("attachment_download", {
                    "attachment_id": attachment_id, "thumb": False,
                })
                content = base64.b64decode(payload["content_b64"])
                mime = payload.get("mime") or mime
                filename = payload.get("filename") or filename
                part.write_bytes(content)
                _update(key, percent=95, phase="写盘")
            im_attachment_service.write_remote_cache_file(
                attachment_id, False, part, mime, filename)
        else:
            att = im_service.get_attachment_for_member(db, attachment_id, user_id)
            source, _ = im_attachment_service.resolve_path(att.storage_path)
            filename = att.original_name or filename
            mime = att.mime or mime
            _copy_with_progress(source, part, source.stat().st_size, key)

        part.replace(target)
        _update(key, percent=100, status="done", phase="完成", path=str(target), error="")
        if reveal:
            desktop_bridge.reveal_path(str(target))
    except Exception as exc:  # noqa: BLE001 - 后台任务异常必须落到状态里供前端提示
        if part is not None:
            part.unlink(missing_ok=True)
        _update(key, status="failed", percent=0, phase="失败", error=str(exc))
    finally:
        db.close()


def start(user_id: int, attachment_id: int, filename: str = "",
          reveal: bool = False) -> Dict[str, Any]:
    key = _key(user_id, attachment_id)
    with _lock:
        old = _jobs.get(key)
        if old and old["status"] == "running":
            return dict(old)
        if old and old["status"] == "done" and Path(old.get("path") or "").is_file():
            if reveal:
                desktop_bridge.reveal_path(old["path"])
            return dict(old)
        _jobs[key] = {
            "status": "running", "percent": 0, "phase": "排队中",
            "path": "", "error": "",
        }
    threading.Thread(
        target=_run_job, args=(key, user_id, attachment_id, filename, reveal),
        daemon=True,
    ).start()
    return status(user_id, attachment_id)


def reveal_cached(user_id: int, attachment_id: int) -> Dict[str, Any]:
    state = status(user_id, attachment_id)
    path = state.get("path") or ""
    if state.get("status") != "done" or not Path(path).is_file():
        raise HTTPException(status_code=409, detail="IM_ATTACHMENT_NOT_CACHED")
    return {"revealed": desktop_bridge.reveal_path(path), "path": path}
