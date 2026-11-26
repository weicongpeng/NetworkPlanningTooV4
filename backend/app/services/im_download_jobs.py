"""桌面端 IM 附件本地缓存任务：后台分块落盘 + 进度查询 + 完成后定位文件。

桌面共享模式的附件在云端，103MB 级文件若让前端一次性取 Blob 会占满内存且无进度；
这里在本机后端后台分块写盘，前端只轮询百分比，完成后走壳层在资源管理器中选中。

落盘结果按附件持久化索引（``<附件目录同级>/im_downloads.json``）：同一附件再次
「在文件夹中显示」时直接定位上次下载的文件，进程重启后依然有效；
同名且大小一致的文件视为同一份，不再每点一次就多出 ``-1/-2`` 副本。
"""
from __future__ import annotations

import base64
import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from fastapi import HTTPException

from app import desktop_bridge
from app.core.config import settings
from app.core.database import SessionLocal
from app.services import (
    desktop_im_storage, im_attachment_service, im_desktop_proxy, im_service,
)

INDEX_FILE_NAME = "im_downloads.json"
MAX_JOB_ENTRIES = 200
MAX_INDEX_ENTRIES = 500
STALE_PART_SECONDS = 3600

_lock = threading.Lock()
_jobs: Dict[Tuple[int, int], Dict[str, Any]] = {}
# 已落盘附件索引：attachment_id -> {path, size, filename, saved_at}。
# 按索引文件路径缓存：桌面端可改存储目录，不同目录各持一份索引。
_index_cache: Tuple[str, Dict[str, Dict[str, Any]]] = ("", {})


def _key(user_id: int, attachment_id: int) -> Tuple[int, int]:
    return int(user_id), int(attachment_id)


def _download_dir() -> Path:
    """下载目录与附件目录同级（uploads/downloads），随存储路径配置一起搬。"""
    return desktop_im_storage.effective_attachment_dir().parent / "downloads"


def _index_path() -> Path:
    return desktop_im_storage.effective_attachment_dir().parent / INDEX_FILE_NAME


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


def _index_locked() -> Dict[str, Dict[str, Any]]:
    global _index_cache
    path = _index_path()
    stamp = str(path)
    if _index_cache[0] == stamp:
        return _index_cache[1]
    data: Dict[str, Dict[str, Any]] = {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        items = raw.get("downloads") if isinstance(raw, dict) else None
        if isinstance(items, dict):
            data = {str(k): dict(v) for k, v in items.items() if isinstance(v, dict)}
    except (OSError, ValueError):
        data = {}
    _index_cache = (stamp, data)
    return data


def _save_index_locked(data: Dict[str, Dict[str, Any]]) -> None:
    path = _index_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".json.tmp")
        temp.write_text(json.dumps({"downloads": data}, ensure_ascii=False, indent=2),
                        encoding="utf-8")
        os.replace(temp, path)
    except OSError:
        pass  # 索引写不进去只影响复用，下载本身照常完成


def _saved_path_locked(attachment_id: int) -> str:
    """索引里已落盘的路径；文件被移走/删除或大小不符时不再复用。"""
    entry = _index_locked().get(str(int(attachment_id)))
    if not entry:
        return ""
    raw = str(entry.get("path") or "")
    if not raw:
        return ""
    try:
        size = Path(raw).stat().st_size
    except OSError:
        _index_locked().pop(str(int(attachment_id)), None)
        return ""
    expected = entry.get("size")
    if isinstance(expected, (int, float)) and expected and int(expected) != size:
        return ""  # 同名文件被别的程序改写过，不能定位到错误文件
    return raw


def _remember(attachment_id: int, target: Path, size: int) -> None:
    with _lock:
        data = _index_locked()
        data[str(int(attachment_id))] = {
            "path": str(target), "size": int(size), "filename": target.name,
            "saved_at": int(time.time()),
        }
        if len(data) > MAX_INDEX_ENTRIES:
            for key in list(data):
                if len(data) <= MAX_INDEX_ENTRIES:
                    break
                if not Path(str(data[key].get("path") or "")).is_file():
                    data.pop(key, None)
        _save_index_locked(data)


def _claimed_locked(target: Path, attachment_id: int) -> bool:
    """该路径是否已被别的附件占用：被占用时不能再拿来做「同一份文件」复用。"""
    wanted = os.path.normcase(str(target))
    for key, entry in _index_locked().items():
        if key == str(int(attachment_id)):
            continue
        if os.path.normcase(str(entry.get("path") or "")) == wanted:
            return True
    return False


def _job_path_locked(old: Optional[Dict[str, Any]]) -> str:
    if not old or old.get("status") != "done":
        return ""
    raw = str(old.get("path") or "")
    return raw if raw and Path(raw).is_file() else ""


def _prune_jobs_locked() -> None:
    """内存任务表只留最近若干条，避免长时间运行时无限增长。"""
    if len(_jobs) < MAX_JOB_ENTRIES:
        return
    for key in [k for k, v in _jobs.items() if v.get("status") != "running"]:
        _jobs.pop(key, None)
        if len(_jobs) < MAX_JOB_ENTRIES:
            break


def _sweep_stale_parts(out_dir: Path) -> None:
    """清掉崩溃/强杀留下的临时分片（1 小时内的保留，避免误删正在写的）。"""
    cutoff = time.time() - STALE_PART_SECONDS
    try:
        items = list(out_dir.glob("*.part"))
    except OSError:
        return
    for item in items:
        try:
            if item.is_file() and item.stat().st_mtime < cutoff:
                item.unlink(missing_ok=True)
        except OSError:
            continue


def _finalize(part: Path, preferred: Path, attachment_id: int) -> Path:
    """把临时分片落到最终文件名。

    同名且大小一致的既有文件视为同一份直接复用（聊天里同一附件反复点
    「在文件夹中显示」不该越攒越多 ``-1/-2`` 副本）；已被其它附件登记过的
    文件不复用，避免两个附件指向同一个文件；其余情况另起序号，绝不覆盖用户文件。
    """
    size = part.stat().st_size
    if preferred.exists():
        with _lock:
            claimed = _claimed_locked(preferred, attachment_id)
        if not claimed:
            try:
                if preferred.is_file() and preferred.stat().st_size == size:
                    part.unlink(missing_ok=True)
                    return preferred
            except OSError:
                pass
        stem, suffix = preferred.stem, preferred.suffix
        index = 1
        while True:
            candidate = preferred.with_name(f"{stem}-{index}{suffix}")
            if not candidate.exists():
                preferred = candidate
                break
            index += 1
    part.replace(preferred)
    return preferred


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
        out_dir = _download_dir()
        out_dir.mkdir(parents=True, exist_ok=True)
        _sweep_stale_parts(out_dir)
        # 临时文件用随机名：最终文件名要等拿到服务端返回的真实名字后再定
        part = out_dir / f"~{uuid.uuid4().hex}.part"
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

        safe = im_attachment_service.clean_filename(filename or "attachment")
        target = _finalize(part, out_dir / safe, attachment_id)
        part = None
        _remember(attachment_id, target, target.stat().st_size)
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
    result: Optional[Dict[str, Any]] = None
    with _lock:
        old = _jobs.get(key)
        if old and old["status"] == "running":
            return dict(old)
        saved = _saved_path_locked(attachment_id) or _job_path_locked(old)
        if saved:
            state = {"status": "done", "percent": 100, "phase": "已完成",
                     "path": saved, "error": ""}
            _jobs[key] = state
            result = dict(state)
        else:
            _prune_jobs_locked()
            _jobs[key] = {
                "status": "running", "percent": 0, "phase": "排队中",
                "path": "", "error": "",
            }
    if result is not None:
        # 已经在本地：直接定位，不再重新下载；壳层调用放在锁外，不阻塞进度轮询
        if reveal:
            desktop_bridge.reveal_path(result["path"])
        return result
    threading.Thread(
        target=_run_job, args=(key, user_id, attachment_id, filename, reveal),
        daemon=True,
    ).start()
    return status(user_id, attachment_id)


def reveal_cached(user_id: int, attachment_id: int) -> Dict[str, Any]:
    path = ""
    with _lock:
        state = _jobs.get(_key(user_id, attachment_id)) or {}
        if state.get("status") == "done":
            candidate = str(state.get("path") or "")
            path = candidate if candidate and Path(candidate).is_file() else ""
        if not path:
            # 进程重启后内存任务表是空的，靠持久化索引找回上次落盘的文件
            path = _saved_path_locked(attachment_id)
            if path:
                _jobs[_key(user_id, attachment_id)] = {
                    "status": "done", "percent": 100, "phase": "已完成",
                    "path": path, "error": "",
                }
    if not path or not Path(path).is_file():
        raise HTTPException(status_code=409, detail="IM_ATTACHMENT_NOT_CACHED")
    return {"revealed": desktop_bridge.reveal_path(path), "path": path}
