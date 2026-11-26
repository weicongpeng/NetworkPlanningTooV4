"""协作沟通附件服务：分片接收、安全校验、落盘、缩略图与读取。

- 文件落 NPT_IM_ATTACHMENT_DIR/<conversation_id>/<uuid>.<ext>，以 UUID 重命名；
- 上传会话是进程内内存态（与现有 data.py 的 _chunked_sessions 同构），重启后
  残留临时文件由 start 时的惰性清理回收；
- 所有读取都经 im_service.get_attachment_for_member 做成员鉴权后再定位磁盘文件。
"""
import hashlib
import hmac
import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings

# 2MB/片：512MB 文件约 256 片，避免 512KB 方案下上千次 relay 往返把大文件上传拖到不可用
CHUNK_SIZE = 2 * 1024 * 1024
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
    # 桌面端用户在设置里改过路径时，以档内配置为准；服务端/网页端恒为默认目录
    from app.services.desktop_im_storage import effective_attachment_dir

    path = Path(effective_attachment_dir())
    path.mkdir(parents=True, exist_ok=True)
    return path


def _max_bytes() -> int:
    return max(1, int(settings.NPT_IM_MAX_FILE_MB)) * 1024 * 1024


# 共享模式的云端附件在本地的只读副本：附件一旦上传即不可变，可长期复用，
# 避免每次预览/下载都走公网 relay；按 LRU 控制磁盘占用。
_REMOTE_CACHE_DIR = "remote-cache"


def _remote_cache_folder(attachment_id: int, thumb: bool) -> Path:
    return _base_dir() / _REMOTE_CACHE_DIR / str(int(attachment_id)) / ("thumb" if thumb else "full")


def remote_cache_info(attachment_id: int, thumb: bool) -> Optional[Tuple[Path, str, str]]:
    """本地只读副本的 (路径, mime, 原始文件名)；没有副本时返回 None。

    供下载/定位场景流式返回或复制，避免把 100MB 级文件整块读进内存。
    """
    if int(getattr(settings, "NPT_IM_LOCAL_ATTACHMENT_CACHE_MB", 0)) <= 0:
        return None
    folder = _remote_cache_folder(attachment_id, thumb)
    data_path = folder / "data.bin"
    meta_path = folder / "meta.json"
    if not data_path.is_file() or not meta_path.is_file():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        return (data_path,
                str(meta.get("mime") or "application/octet-stream"),
                str(meta.get("filename") or "attachment"))
    except (OSError, ValueError, TypeError):
        return None


def read_remote_cache(attachment_id: int, thumb: bool) -> Optional[Tuple[bytes, str, str]]:
    limit_mb = int(getattr(settings, "NPT_IM_LOCAL_ATTACHMENT_CACHE_MB", 0))
    if limit_mb <= 0:
        return None
    folder = _remote_cache_folder(attachment_id, thumb)
    data_path = folder / "data.bin"
    meta_path = folder / "meta.json"
    if not data_path.is_file() or not meta_path.is_file():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        return (data_path.read_bytes(),
                str(meta.get("mime") or "application/octet-stream"),
                str(meta.get("filename") or "attachment"))
    except (OSError, ValueError, TypeError):
        return None


def _prune_remote_cache() -> None:
    limit = max(0, int(getattr(settings, "NPT_IM_LOCAL_ATTACHMENT_CACHE_MB", 0))) * 1024 * 1024
    root = _base_dir() / _REMOTE_CACHE_DIR
    entries: List[Tuple[float, int, Path]] = []
    for path in root.glob("*/*/data.bin"):
        try:
            stat = path.stat()
            entries.append((stat.st_mtime, stat.st_size, path))
        except OSError:
            pass
    total = sum(size for _, size, _ in entries)
    for _, size, path in sorted(entries):
        if total <= limit:
            break
        try:
            path.unlink(missing_ok=True)
            (path.parent / "meta.json").unlink(missing_ok=True)
            total -= size
        except OSError:
            pass


def write_remote_cache(attachment_id: int, thumb: bool,
                       content: bytes, mime: str, filename: str) -> None:
    if int(getattr(settings, "NPT_IM_LOCAL_ATTACHMENT_CACHE_MB", 0)) <= 0:
        return
    folder = _remote_cache_folder(attachment_id, thumb)
    folder.mkdir(parents=True, exist_ok=True)
    data_path = folder / "data.bin"
    tmp = folder / "data.part"
    tmp.write_bytes(content)
    tmp.replace(data_path)
    (folder / "meta.json").write_text(
        json.dumps({"mime": mime, "filename": filename}, ensure_ascii=False),
        encoding="utf-8",
    )
    _prune_remote_cache()


def write_remote_cache_file(attachment_id: int, thumb: bool,
                            source: Path, mime: str, filename: str) -> None:
    """把已落盘的附件流式复制进本地缓存，避免大文件再次整块读入内存。"""
    import shutil

    if int(getattr(settings, "NPT_IM_LOCAL_ATTACHMENT_CACHE_MB", 0)) <= 0:
        return
    folder = _remote_cache_folder(attachment_id, thumb)
    folder.mkdir(parents=True, exist_ok=True)
    data_path = folder / "data.bin"
    tmp = folder / "data.part"
    shutil.copyfile(source, tmp)
    tmp.replace(data_path)
    (folder / "meta.json").write_text(
        json.dumps({"mime": mime, "filename": filename}, ensure_ascii=False),
        encoding="utf-8",
    )
    _prune_remote_cache()


def _attachment_signature(attachment_id: int, user_id: int,
                          thumb: bool, expires_at: int) -> str:
    payload = f"{int(attachment_id)}|{int(user_id)}|{1 if thumb else 0}|{int(expires_at)}"
    return hmac.new(
        settings.IM_ATTACHMENT_URL_SECRET.encode("utf-8"),
        payload.encode("utf-8"), hashlib.sha256,
    ).hexdigest()


def verify_attachment_token(token: str, attachment_id: int,
                            user_id: int, thumb: bool) -> bool:
    """校验签名直链 token（HMAC-SHA256 + 过期时间，恒定时间比较）。

    token 只证明「谁在多长时间内可以看哪张图的哪种尺寸」，下载端点仍必须再查一次
    会话成员关系，不能把 token 当作长期授权。
    """
    try:
        expires_at, token_user_id, digest = _split_token(token)
    except (ValueError, AttributeError):
        return False
    if expires_at < int(time.time()) or token_user_id != int(user_id):
        return False
    expected = _attachment_signature(attachment_id, user_id, thumb, expires_at)
    return hmac.compare_digest(digest, expected)


def _split_token(token: str) -> Tuple[int, int, str]:
    parts = str(token).split(".")
    if len(parts) != 3:
        raise ValueError("bad attachment token")
    return int(parts[0]), int(parts[1]), parts[2]


def attachment_token_user_id(token: str) -> Optional[int]:
    """从签名 token 取出绑定的 user_id；仅用于定位校验主体，不代表已验签。"""
    try:
        return _split_token(token)[1]
    except (ValueError, AttributeError):
        return None


def sign_attachment(attachment_id: int, user_id: int, thumb: bool = False) -> dict:
    expires_at = int(time.time()) + settings.IM_ATTACHMENT_URL_TTL_SECONDS
    return {
        "token": (f"{expires_at}.{int(user_id)}."
                  f"{_attachment_signature(attachment_id, user_id, thumb, expires_at)}"),
        "path": f"/api/v1/im/attachments/signed/{int(attachment_id)}",
        "thumb": bool(thumb),
        "expires_at": expires_at,
    }


def sign_attachments(db: Session, user_id: int, items: List[Any]) -> Dict[str, dict]:
    """批量换取签名 URL；签发前逐个校验成员关系，key 为 ``id:thumb``。"""
    from app.services import im_service

    signed: Dict[str, dict] = {}
    for item in items or []:
        try:
            attachment_id = int(item.get("attachment_id") or 0)
        except (AttributeError, TypeError, ValueError):
            continue
        if attachment_id <= 0:
            continue
        thumb = bool(item.get("thumb"))
        # 非会话成员一律 404：不能凭猜测 id 换到签名链接
        im_service.get_attachment_for_member(db, attachment_id, user_id)
        signed[f"{attachment_id}:{int(thumb)}"] = sign_attachment(
            attachment_id, user_id, thumb)
    return signed


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


def active_upload_paths() -> Iterable[Path]:
    """正在写入的分片临时文件：清理时必须跳过，否则会打断上传。"""
    with _LOCK:
        return {Path(session["tmp_path"]) for session in _UPLOADS.values()}


def resolve_path(relative: str) -> Tuple[Path, str]:
    """把存储的相对路径解析为绝对路径，并阻止路径穿越。"""
    base = _base_dir().resolve()
    target = (base / (relative or "")).resolve()
    if base not in target.parents:
        raise _err(400, "IM_ATTACHMENT_NOT_FOUND")
    if not target.is_file():
        raise _err(404, "IM_ATTACHMENT_NOT_FOUND")
    return target, target.name
