"""协作沟通附件服务：分片接收、安全校验、落盘、缩略图与读取。

- 文件落 NPT_IM_ATTACHMENT_DIR/<conversation_id>/<uuid>.<ext>，以 UUID 重命名；
- 上传会话是进程内内存态（与现有 data.py 的 _chunked_sessions 同构），重启后
  残留临时文件由 start 时的惰性清理回收；
- 所有读取都经 im_service.get_attachment_for_member 做成员鉴权后再定位磁盘文件。
"""
import re
import threading
import uuid
from pathlib import Path
from typing import Dict, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings

CHUNK_SIZE = 512 * 1024
DENY_EXTENSIONS = {
    "exe", "bat", "cmd", "com", "scr", "pif", "msi", "dll", "so", "sh", "bash",
    "ps1", "psm1", "vbs", "vbe", "js", "jse", "jar", "py", "pyc", "php", "phtml",
    "html", "htm", "svg", "xhtml", "hta", "cpl", "reg", "wsf", "wsh", "lnk",
}
IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}
_SAFE_NAME = re.compile(r"[^\w\u4e00-\u9fff.\- ()（）\[\]【】]+")
_LOCK = threading.Lock()
_UPLOADS: Dict[str, dict] = {}


def _err(status: int, detail: str) -> HTTPException:
    return HTTPException(status_code=status, detail=detail)


def clean_filename(raw: str) -> str:
    name = (raw or "").replace("\\", "/").split("/")[-1]
    name = _SAFE_NAME.sub("_", name).strip(" .")
    return (name or "attachment")[:180]


def _extension(name: str) -> str:
    suffix = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if not re.fullmatch(r"[a-z0-9]{1,10}", suffix):
        return "bin"
    return suffix


def _base_dir() -> Path:
    path = Path(settings.NPT_IM_ATTACHMENT_DIR)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _max_bytes() -> int:
    return max(1, int(settings.NPT_IM_MAX_FILE_MB)) * 1024 * 1024


def _purge_stale_tmp() -> None:
    """惰性清理超过 24h 的临时分片文件，避免磁盘堆积。"""
    import time

    base = _base_dir()
    cutoff = time.time() - 24 * 3600
    for path in base.glob("*/*.part"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            pass


def start_upload(db: Session, user_id: int, conversation_id: int,
                 original_name: str, mime: str, size_bytes: int) -> dict:
    from app.services import im_service

    im_service._require_member(db, conversation_id, user_id)
    _purge_stale_tmp()
    name = clean_filename(original_name)
    ext = _extension(name)
    if ext in DENY_EXTENSIONS:
        raise _err(400, "IM_ATTACHMENT_TYPE")
    total = int(size_bytes or 0)
    if total <= 0 or total > _max_bytes():
        raise _err(400, "IM_ATTACHMENT_TOO_LARGE")

    upload_id = uuid.uuid4().hex
    stored_name = f"{uuid.uuid4().hex}.{ext}"
    conv_dir = _base_dir() / str(int(conversation_id))
    conv_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = conv_dir / f"{upload_id}.part"
    tmp_path.touch()
    total_chunks = (total + CHUNK_SIZE - 1) // CHUNK_SIZE
    with _LOCK:
        _UPLOADS[upload_id] = {
            "conversation_id": int(conversation_id), "user_id": int(user_id),
            "original_name": name, "mime": (mime or "application/octet-stream")[:128],
            "size_bytes": total, "ext": ext, "stored_name": stored_name,
            "tmp_path": tmp_path, "total_chunks": total_chunks, "received": set(),
        }
    return {"upload_id": upload_id, "chunk_size": CHUNK_SIZE, "total_chunks": total_chunks}


def write_chunk(db: Session, user_id: int, upload_id: str,
                chunk_index: int, data: bytes) -> dict:
    with _LOCK:
        session = _UPLOADS.get(upload_id)
    if session is None:
        raise _err(404, "IM_ATTACHMENT_NOT_FOUND")
    if session["user_id"] != user_id:
        raise _err(404, "IM_ATTACHMENT_NOT_FOUND")
    index = int(chunk_index)
    if index < 0 or index >= session["total_chunks"] or not data:
        raise _err(409, "IM_UPLOAD_CONFLICT")
    if len(data) > CHUNK_SIZE + 1024:
        raise _err(400, "IM_ATTACHMENT_TOO_LARGE")

    offset = index * CHUNK_SIZE
    tmp_path: Path = session["tmp_path"]
    with _LOCK:
        with tmp_path.open("r+b") as handle:
            handle.seek(offset)
            handle.write(data)
        session["received"].add(index)
        received = len(session["received"])
    return {"received": received, "total_chunks": session["total_chunks"]}


def _make_thumbnail(final_path: Path, ext: str) -> Optional[str]:
    if ext not in IMAGE_EXTENSIONS:
        return None
    try:
        from PIL import Image

        thumb_path = final_path.with_name(f"{final_path.stem}_thumb.png")
        with Image.open(final_path) as image:
            image.thumbnail((320, 320))
            image.convert("RGBA").save(thumb_path, format="PNG")
        return f"{final_path.parent.name}/{thumb_path.name}"
    except Exception:  # noqa: BLE001 - Pillow 缺失或图片损坏时降级为无缩略图
        return None


def complete_upload(db: Session, user_id: int, upload_id: str) -> dict:
    from app.services import im_service

    with _LOCK:
        session = _UPLOADS.pop(upload_id, None)
    if session is None:
        raise _err(404, "IM_ATTACHMENT_NOT_FOUND")
    if session["user_id"] != user_id:
        raise _err(404, "IM_ATTACHMENT_NOT_FOUND")
    if len(session["received"]) != session["total_chunks"]:
        raise _err(409, "IM_UPLOAD_CONFLICT")

    tmp_path: Path = session["tmp_path"]
    final_path = tmp_path.with_name(session["stored_name"])
    tmp_path.replace(final_path)
    actual = final_path.stat().st_size
    if actual > _max_bytes():
        final_path.unlink(missing_ok=True)
        raise _err(400, "IM_ATTACHMENT_TOO_LARGE")

    thumb = _make_thumbnail(final_path, session["ext"])
    storage_path = f"{final_path.parent.name}/{final_path.name}"
    att = im_service.create_attachment(
        db, session["conversation_id"], user_id,
        original_name=session["original_name"], stored_name=session["stored_name"],
        mime=session["mime"], size_bytes=actual, storage_path=storage_path,
        thumb_path=thumb,
    )
    return {
        "id": att.id, "original_name": att.original_name, "mime": att.mime,
        "size_bytes": att.size_bytes, "has_thumb": bool(thumb),
    }


def cancel_upload(user_id: int, upload_id: str) -> None:
    with _LOCK:
        session = _UPLOADS.pop(upload_id, None)
    if session and session["user_id"] == user_id:
        Path(session["tmp_path"]).unlink(missing_ok=True)


def resolve_path(relative: str) -> Tuple[Path, str]:
    """把存储的相对路径解析为绝对路径，并阻止路径穿越。"""
    base = _base_dir().resolve()
    target = (base / (relative or "")).resolve()
    if base not in target.parents:
        raise _err(400, "IM_ATTACHMENT_NOT_FOUND")
    if not target.is_file():
        raise _err(404, "IM_ATTACHMENT_NOT_FOUND")
    return target, target.name
