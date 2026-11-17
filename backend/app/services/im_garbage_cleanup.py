"""IM 垃圾自动清理：只清临时/孤儿文件，不碰仍被消息引用的合法附件。

合法性的唯一依据是 ``im_messages.attachment_id``：消息还在，附件就是合法的；
消息被删后遗留的附件行和磁盘文件才算垃圾，按保守保留期回收。
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Set, Tuple

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.services import im_attachment_service

_log = logging.getLogger("im.cleanup")

_stop_event = threading.Event()
_thread: Optional[threading.Thread] = None


@dataclass
class CleanupStats:
    scanned_files: int = 0
    deleted_files: int = 0
    deleted_attachment_rows: int = 0
    freed_bytes: int = 0
    skipped_files: int = 0
    errors: int = 0

    def as_dict(self) -> Dict[str, int]:
        return {
            "scanned_files": self.scanned_files,
            "deleted_files": self.deleted_files,
            "deleted_attachment_rows": self.deleted_attachment_rows,
            "freed_bytes": self.freed_bytes,
            "skipped_files": self.skipped_files,
            "errors": self.errors,
        }


def _within(path: Path, base: Path) -> bool:
    try:
        path.resolve().relative_to(base.resolve())
        return True
    except (ValueError, OSError):
        return False


def _safe_relative(base: Path, relative: Any) -> Optional[Path]:
    """把数据库里的相对路径解析为 base 下的文件；穿越/空值一律拒绝。"""
    if not relative:
        return None
    candidate = (base / str(relative)).resolve()
    return candidate if _within(candidate, base) else None


def _parse_created_at(value: Any) -> Optional[float]:
    if isinstance(value, datetime):
        moment = value
    elif isinstance(value, (int, float)):
        return float(value)
    elif value:
        raw = str(value).strip().replace("Z", "+00:00")
        try:
            moment = datetime.fromisoformat(raw)
        except ValueError:
            return None
    else:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp()


def _mtime(path: Path) -> Optional[float]:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _too_old(path: Path, created: Optional[float], days: int) -> bool:
    moment = created if created is not None else _mtime(path)
    if moment is None:
        return False
    return (time.time() - moment) >= max(0, days) * 86400


def _unlink(path: Path, stats: CleanupStats) -> bool:
    """删除单个文件并记账；占用/权限错误只计数，不抛出。"""
    try:
        size = path.stat().st_size
        path.unlink()
        stats.deleted_files += 1
        stats.freed_bytes += size
        return True
    except OSError as exc:
        stats.errors += 1
        _log.warning("IM 垃圾清理跳过文件 %s：%s", path, exc)
        return False


def _referenced_attachment_ids(db: Session) -> Set[int]:
    """仍被消息引用的附件 ID。表/查询异常向上抛，调用方整轮中止不删除。"""
    rows = db.execute(text(
        "select distinct attachment_id from im_messages where attachment_id is not null"
    )).fetchall()
    return {int(row[0]) for row in rows if row[0] is not None}


def _load_attachment_rows(db: Session) -> list[Tuple[int, Optional[float], str, Optional[str]]]:
    rows = db.execute(text(
        "select id, created_at, storage_path, thumb_path from im_attachments"
    )).fetchall()
    result = []
    for row in rows:
        result.append((
            int(row[0]), _parse_created_at(row[1]), str(row[2] or ""),
            str(row[3]) if row[3] else None,
        ))
    return result


def _orphan_rows(db: Session, base: Path, stats: CleanupStats) -> None:
    """删除消息已删且超过保留期的附件行；文件删不掉时保留行以便下轮重试。"""
    referenced = _referenced_attachment_ids(db)
    for attachment_id, created, relative, thumb_relative in _load_attachment_rows(db):
        if attachment_id in referenced:
            continue
        primary = _safe_relative(base, relative)
        thumb = _safe_relative(base, thumb_relative)
        if not _too_old(primary or base, created, settings.NPT_IM_ORPHAN_RETENTION_DAYS):
            continue
        ok = True
        for path in (primary, thumb):
            if path is not None and path.is_file() and not _unlink(path, stats):
                ok = False
        if not ok:
            stats.skipped_files += 1
            continue
        try:
            db.execute(text("delete from im_attachments where id = :id"),
                       {"id": attachment_id})
            stats.deleted_attachment_rows += 1
        except Exception as exc:  # noqa: BLE001 - 单行失败不影响整轮
            stats.errors += 1
            _log.warning("IM 垃圾清理删除附件行失败 id=%s：%s", attachment_id, exc)


def _disk_orphans(base: Path, known: Set[Path], active: Set[Path],
                  stats: CleanupStats) -> None:
    """清掉数据库完全没有记录、且已过保留期的磁盘文件（含分片与失效缩略图）。"""
    for path in base.rglob("*"):
        if not path.is_file():
            continue
        stats.scanned_files += 1
        resolved = path.resolve()
        if resolved in active or resolved in known:
            stats.skipped_files += 1
            continue
        name = path.name
        if name.endswith(".part") or ".part." in name:
            days = settings.NPT_IM_PART_RETENTION_DAYS
        elif name.endswith("_thumb.png"):
            days = settings.NPT_IM_THUMB_RETENTION_DAYS
        else:
            days = settings.NPT_IM_ORPHAN_RETENTION_DAYS
        if _too_old(path, None, days):
            _unlink(path, stats)


def _temp_dirs(stats: CleanupStats) -> None:
    """截图临时图与打开附件的本地副本，按短保留期回收。"""
    from app.services import desktop_im_storage

    targets: Tuple[Tuple[Path, int], ...] = (
        (Path(settings.DATA_ROOT) / "screenshot_tmp",
         settings.NPT_IM_SCREENSHOT_RETENTION_DAYS),
        (desktop_im_storage.open_temp_dir(),
         max(0, desktop_im_storage.OPEN_TEMP_KEEP_SECONDS) / 86400.0),
    )
    for directory, days in targets:
        if not directory.is_dir():
            continue
        for path in directory.iterdir():
            if not path.is_file():
                continue
            stats.scanned_files += 1
            if _too_old(path, None, days):
                _unlink(path, stats)


def cleanup_once(db: Optional[Session] = None) -> CleanupStats:
    """执行一轮清理。任何异常只记日志，返回统计，绝不向外抛。"""
    stats = CleanupStats()
    own_session = db is None
    session = db
    try:
        from app.core.database import SessionLocal

        session = session or SessionLocal()
        # 先验证引用查询可用；失败则整轮中止，避免误判“全部是孤儿”
        _referenced_attachment_ids(session)

        # 单一路径真源：尊重桌面端设置里改过的附件目录
        from app.services.desktop_im_storage import effective_attachment_dir

        base = effective_attachment_dir().resolve()

        rows = _load_attachment_rows(session)
        known: Set[Path] = set()
        for _, _, relative, thumb_relative in rows:
            for value in (relative, thumb_relative):
                candidate = _safe_relative(base, value)
                if candidate is not None:
                    known.add(candidate)

        _orphan_rows(session, base, stats)
        active = set(im_attachment_service.active_upload_paths())
        _disk_orphans(base, known, active, stats)
        _temp_dirs(stats)
        if own_session:
            session.commit()
    except Exception as exc:  # noqa: BLE001 - 后台任务不能拖垮进程
        stats.errors += 1
        _log.error("IM 垃圾清理本轮中止：%s", exc, exc_info=True)
        if session is not None and own_session:
            try:
                session.rollback()
            except Exception:
                pass
    finally:
        if own_session and session is not None:
            try:
                session.close()
            except Exception:
                pass
    _log.info("IM 垃圾清理完成：%s", stats.as_dict())
    return stats


def _loop() -> None:
    initial = max(60, int(settings.NPT_IM_CLEANUP_INITIAL_DELAY_SECONDS))
    if _stop_event.wait(initial):
        return
    interval = max(1, int(settings.NPT_IM_CLEANUP_INTERVAL_HOURS)) * 3600
    while not _stop_event.is_set():
        cleanup_once()
        if _stop_event.wait(interval):
            break


def start_background_cleanup() -> None:
    """lifespan 启动时调用；开关关闭或已在运行则直接返回。"""
    global _thread
    if not settings.NPT_IM_CLEANUP_ENABLED:
        _log.info("IM 垃圾自动清理已关闭")
        return
    if _thread is not None and _thread.is_alive():
        return
    _stop_event.clear()
    _thread = threading.Thread(
        target=_loop, name="npt-im-cleanup", daemon=True)
    _thread.start()
    _log.info("IM 垃圾自动清理已启动：首次延迟 %ss，间隔 %sh",
              settings.NPT_IM_CLEANUP_INITIAL_DELAY_SECONDS,
              settings.NPT_IM_CLEANUP_INTERVAL_HOURS)


def stop_background_cleanup() -> None:
    """仅置停止事件，不 join：退出时不能因为长等待卡住进程。"""
    _stop_event.set()
