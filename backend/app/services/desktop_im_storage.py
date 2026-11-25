"""桌面端「项目沟通」本地存储管理（档内配置 + 迁移 + 缓存清理）。

配置写在 ``settings.PROFILE_ROOT/im_storage_settings.json``，shared / standalone
各档互不影响；网页端和服务器不读这份配置。数据库里的 storage_path / thumb_path 是
相对路径，所以迁移时整体搬目录即可保持引用有效。
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

from app.core.config import settings

SETTINGS_FILE_NAME = "im_storage_settings.json"
OPEN_TEMP_DIR_NAME = "npt-im-open"
VALID_DOWNLOAD_MODES = {"manual", "auto"}
# 最近几分钟内打开过的文件不清理，降低误删正在被外部程序占用的副本
OPEN_TEMP_KEEP_SECONDS = 300

_lock = threading.Lock()
_cache: Tuple[int, str] | None = None


def _settings_path() -> Path:
    return Path(settings.PROFILE_ROOT) / SETTINGS_FILE_NAME


def default_attachment_dir() -> Path:
    return Path(settings.NPT_IM_ATTACHMENT_DIR)


def _read_config() -> Dict[str, Any]:
    try:
        data = json.loads(_settings_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001 - 配置损坏时按默认处理
        return {}


def _write_config(data: Dict[str, Any]) -> None:
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


def download_mode() -> str:
    """manual=用户点击才下载（默认）；auto=收到新附件时自动缓存到本地。"""
    raw = str(_read_config().get("attachment_download_mode") or "manual")
    return raw if raw in VALID_DOWNLOAD_MODES else "manual"


def set_download_mode(mode: str) -> str:
    value = str(mode or "").strip().lower()
    if value not in VALID_DOWNLOAD_MODES:
        raise ValueError("IM_INVALID_DOWNLOAD_MODE")
    global _cache
    with _lock:
        data = _read_config()
        data["attachment_download_mode"] = value
        _write_config(data)
        _cache = None
    return value


def _read_configured_path() -> str:
    """读档内配置；用 mtime 做缓存，热路径不反复解析 JSON。损坏时回退默认目录。"""
    global _cache
    path = _settings_path()
    try:
        stat = path.stat()
        stamp = stat.st_mtime_ns
    except OSError:
        stamp = 0
    with _lock:
        if _cache is not None and _cache[0] == stamp:
            return _cache[1]
        raw = ""
        if stamp:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                raw = str(data.get("attachment_dir") or "")
            except Exception:  # noqa: BLE001 - 配置损坏不影响附件读写
                raw = ""
        _cache = (stamp, raw)
        return raw


def effective_attachment_dir() -> Path:
    raw = _read_configured_path()
    return Path(raw) if raw else default_attachment_dir()


def save_path(target: Path) -> None:
    """原子写配置；空字符串表示恢复默认目录。"""
    global _cache
    raw = str(target) if target else ""
    with _lock:
        data = _read_config()
        data["attachment_dir"] = raw
        _write_config(data)
        _cache = None


def validate_path(raw: str) -> Path:
    """校验用户输入的绝对路径：必须可写，且不能是盘符根/系统/程序/数据根本身。"""
    value = os.path.expandvars(os.path.expanduser(str(raw or "").strip()))
    if not value:
        raise ValueError("IM_STORAGE_PATH_REQUIRED")
    candidate = Path(value)
    if not candidate.is_absolute():
        raise ValueError("IM_STORAGE_PATH_ABSOLUTE")
    candidate = candidate.resolve(strict=False)
    if candidate.parent == candidate:
        raise ValueError("IM_STORAGE_PATH_FORBIDDEN")
    forbidden = [
        Path(settings.BUNDLE_DIR).resolve(strict=False),
        Path(settings.DATA_ROOT).resolve(strict=False),
        Path(settings.PROFILE_ROOT).resolve(strict=False),
    ]
    for root in forbidden:
        if candidate == root or root in candidate.parents:
            raise ValueError("IM_STORAGE_PATH_FORBIDDEN")
    name = candidate.name.lower()
    if name in {"windows", "system32", "syswow64", "program files", "program files (x86)", "programdata"}:
        raise ValueError("IM_STORAGE_PATH_FORBIDDEN")
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        probe = candidate / ".npt-write-test"
        probe.write_bytes(b"ok")
        probe.unlink()
    except OSError as exc:
        raise ValueError(f"IM_STORAGE_PATH_NOT_WRITABLE: {exc}") from exc
    return candidate


def _dir_stats(path: Path) -> Dict[str, int]:
    files = 0
    size = 0
    if path.is_dir():
        for item in path.rglob("*"):
            if item.is_file():
                files += 1
                try:
                    size += item.stat().st_size
                except OSError:
                    pass
    return {"files": files, "bytes": size}


def open_temp_dir() -> Path:
    return Path(tempfile.gettempdir()) / OPEN_TEMP_DIR_NAME


def current_state() -> Dict[str, Any]:
    path = effective_attachment_dir()
    usage = _dir_stats(path)
    temp_usage = _dir_stats(open_temp_dir())
    return {
        "path": str(path),
        "default_path": str(default_attachment_dir()),
        "customized": bool(_read_configured_path()),
        "profile": str(settings.DESKTOP_PROFILE or "default"),
        # 共享模式的聊天附件实际存在服务器上，本机目录只承载上传分片/临时文件；
        # 前端据此解释「目录为空」不是配置失效。
        "mode": "shared" if settings.DESKTOP_PROFILE == "shared" else "standalone",
        "remote_attachments": settings.DESKTOP_PROFILE == "shared",
        "attachment_download_mode": download_mode(),
        "usage": {
            "attachments": usage,
            "open_temp": temp_usage,
            "total_bytes": usage["bytes"] + temp_usage["bytes"],
            "total_files": usage["files"] + temp_usage["files"],
        },
    }


def migrate_attachment_dir(new_dir: Path) -> Dict[str, Any]:
    """整体搬迁附件目录：校验→复制→比对→改配置；失败删除目标并保留原配置。"""
    old = effective_attachment_dir().resolve()
    target = new_dir.resolve()
    if old == target:
        return current_state()
    if target.exists() and any(target.iterdir()):
        raise ValueError("IM_STORAGE_DIR_NOT_EMPTY")
    if old in target.parents or target in old.parents:
        raise ValueError("IM_STORAGE_PATH_NESTED")

    source_stats = _dir_stats(old)
    created = False
    try:
        if old.is_dir():
            # validate_path 已确保目标为空；空目录本身允许存在（用户刚选的文件夹）
            shutil.copytree(old, target, dirs_exist_ok=True)
            created = True
        copied = _dir_stats(target)
        if copied != source_stats:
            raise ValueError("IM_STORAGE_MIGRATION_MISMATCH")
        save_path(target)
    except Exception:
        if created:
            shutil.rmtree(target, ignore_errors=True)
        raise
    # 旧目录保留为备份，不删除正式附件；重命名失败也不影响新路径生效
    backup = old.with_name(f"{old.name}.backup-{int(time.time())}")
    try:
        if old.is_dir():
            old.rename(backup)
    except OSError:
        backup = old
    return {"moved_files": source_stats["files"], "moved_bytes": source_stats["bytes"],
            "backup_path": str(backup), **current_state()}


def reset_to_default() -> Dict[str, Any]:
    save_path(Path(""))
    return current_state()


def _referenced_names(db: Any) -> set[str]:
    from app.models.database import ImAttachment

    names: set[str] = set()
    for row in db.query(ImAttachment).all():  # type: ignore[union-attr]
        for value in (getattr(row, "storage_path", None), getattr(row, "thumb_path", None)):
            if value:
                names.add(Path(str(value)).name)
    return names


def _candidates(db: Any) -> List[Path]:
    from app.services import im_attachment_service

    base = effective_attachment_dir()
    referenced = _referenced_names(db)
    active = set(im_attachment_service.active_upload_paths())
    items: List[Path] = []
    if base.is_dir():
        for item in base.rglob("*"):
            if not item.is_file() or item in active:
                continue
            if item.name.endswith((".part", ".tmp")) or item.name not in referenced:
                items.append(item)
    temp = open_temp_dir()
    if temp.is_dir():
        cutoff = time.time() - OPEN_TEMP_KEEP_SECONDS
        for item in temp.iterdir():
            if not item.is_file():
                continue
            try:
                if item.stat().st_mtime < cutoff:
                    items.append(item)
            except OSError:
                continue
    return items


def cleanup_preview(db: Any) -> Dict[str, Any]:
    items = _candidates(db)
    size = 0
    for item in items:
        try:
            size += item.stat().st_size
        except OSError:
            pass
    return {"files": len(items), "bytes": size,
            "keep_recent_seconds": OPEN_TEMP_KEEP_SECONDS}


def cleanup_now(db: Any) -> Dict[str, Any]:
    deleted = 0
    freed = 0
    errors: List[str] = []
    for item in _candidates(db):
        try:
            size = item.stat().st_size
            item.unlink()
            deleted += 1
            freed += size
        except OSError as exc:
            errors.append(f"{item.name}: {exc}")
    return {"deleted_files": deleted, "freed_bytes": freed, "errors": errors}
