"""协作沟通 REST 端点（/api/v1/im）。

- 全部要求 JWT（Depends(get_current_user)）；非会话成员一律 404。
- 网页端直接走本地 im_ops；桌面共享模式由 im_desktop_proxy 转发到线上 relay。
- 响应沿用项目统一信封 {"success": True, "data": ...}。
"""
from __future__ import annotations

import base64
import logging
import os
import re
import subprocess
import tempfile
import threading
import time
import urllib.parse
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import desktop_bridge
from app.core.config import settings
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.database import User
from app.services import (
    desktop_im_storage, im_attachment_service, im_desktop_proxy, im_download_jobs,
    im_ops, im_service,
)

router = APIRouter(tags=["协作沟通"])
logger = logging.getLogger(__name__)

_RATE: Dict[str, List[float]] = defaultdict(list)
_RATE_LOCK = threading.Lock()


def _rate_limit(user_id: int, op: str, limit: int, window: int = 60) -> None:
    key = f"{user_id}:{op}"
    now = time.time()
    with _RATE_LOCK:
        bucket = [t for t in _RATE.get(key, []) if now - t < window]
        if len(bucket) >= limit:
            raise HTTPException(status_code=429, detail="IM_RATE_LIMITED",
                                headers={"Retry-After": str(window)})
        bucket.append(now)
        _RATE[key] = bucket


def _run(op: str, args: Dict[str, Any], db: Session, user: User,
         limit: int = 60) -> Any:
    _rate_limit(user.id, op, limit)
    if im_desktop_proxy.is_shared_desktop():
        return im_desktop_proxy.forward(op, args)
    return im_ops.run_local_op(db, user.id, op, args)


def _ok(data: Any) -> dict:
    return {"success": True, "data": data}


class CreateConversationRequest(BaseModel):
    kind: str = Field(..., pattern="^(direct|custom_group)$")
    peer_user_id: Optional[int] = None
    name: Optional[str] = None
    member_ids: List[int] = Field(default_factory=list)


class MemberRequest(BaseModel):
    member_ids: List[int] = Field(default_factory=list)


class AvatarRequest(BaseModel):
    """裁剪后的 base64 data URL；空串恢复默认头像。"""
    avatar: Optional[str] = None


class NicknameRequest(BaseModel):
    """协作沟通展示昵称；空串 / None 清除昵称并回落 username。"""
    nickname: Optional[str] = None


class SendMessageRequest(BaseModel):
    kind: str
    content_text: Optional[str] = None
    attachment_id: Optional[int] = None
    client_msg_id: Optional[str] = None
    # 结构化 @ 名单（群成员 id）；@所有人 由服务端按群角色 owner/admin 独立校验权限
    mentions: List[int] = Field(default_factory=list)
    mention_all: bool = False
    # 引用回复：必须是同一会话内存在的消息 id
    reply_to_id: Optional[int] = None


class ForwardRequest(BaseModel):
    message_ids: List[int] = Field(default_factory=list)
    conversation_ids: List[int] = Field(default_factory=list)


class ReadRequest(BaseModel):
    last_read_message_id: int = 0


class AttachmentStartRequest(BaseModel):
    conversation_id: int
    original_name: str
    mime: str = "application/octet-stream"
    size_bytes: int


class AttachmentChunkRequest(BaseModel):
    upload_id: str
    chunk_index: int
    data_b64: str


class AttachmentIdRequest(BaseModel):
    upload_id: str


class AttachmentCacheRequest(BaseModel):
    attachment_id: int = Field(..., gt=0)
    filename: str = Field("", max_length=255)
    reveal: bool = False


class AttachmentUrlItem(BaseModel):
    attachment_id: int = Field(..., gt=0)
    thumb: bool = False


class AttachmentUrlsRequest(BaseModel):
    items: List[AttachmentUrlItem] = Field(default_factory=list)


@router.get("/conversations")
def list_conversations(include_avatars: bool = Query(True),
                       db: Session = Depends(get_db),
                       user: User = Depends(get_current_user)):
    # 桌面共享模式没有服务端 WS 广播，前端以 1.5s 轮询会话列表及时更新未读红点。
    # 与打开会话、发送成功后的刷新叠加后，旧阈值 60 次/分钟会误触发 429，这里放宽。
    # 头像 base64 最多 256KB × 100 会话：前端只在首次加载时取一次，之后轮询
    # 带 include_avatars=false，把每次响应从数十 MB 降到 KB 级。旧客户端不传参
    # 默认 true，行为完全不变。
    limit = 240 if im_desktop_proxy.is_shared_desktop() else 60
    return _ok(_run("list_conversations", {"include_avatars": include_avatars},
                    db, user, limit=limit))


@router.post("/conversations")
def create_conversation(payload: CreateConversationRequest, response: Response,
                        db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    if payload.kind == "direct":
        if payload.peer_user_id is None:
            raise HTTPException(status_code=400, detail="IM_INVALID_PEER")
        result = _run("create_direct", {"peer_user_id": payload.peer_user_id},
                      db, user, limit=30)
        conv = result.get("conversation", {})
        created = bool(result.get("created"))
    else:
        result = _run("create_group", {
            "name": payload.name or "", "member_ids": payload.member_ids,
        }, db, user, limit=10)
        conv = result
        created = True
    if created:
        response.status_code = 201
        response.headers["Location"] = f"/api/v1/im/conversations/{conv.get('id')}"
    return _ok(conv)


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    return _ok(_run("get_conversation", {"conversation_id": conversation_id}, db, user))


@router.delete("/conversations/{conversation_id}", status_code=200)
def dissolve_group(conversation_id: int, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """群主解散自建群（自动群 / 单聊不可解散）。"""
    return _ok(_run("dissolve_group", {"conversation_id": conversation_id},
                    db, user, limit=10))


@router.put("/conversations/{conversation_id}/avatar")
def update_group_avatar(conversation_id: int, payload: AvatarRequest,
                        db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    """群主 / 管理员修改自建群头像。"""
    return _ok(_run("update_group_avatar", {
        "conversation_id": conversation_id, "avatar": payload.avatar,
    }, db, user, limit=20))


@router.put("/avatar")
def update_avatar(payload: AvatarRequest, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    """修改当前用户头像。

    桌面共享模式下 IM 数据由线上 relay 承载，这里同时把头像写回本机 users 表，
    让本机登录载荷 / 侧边栏头像立即生效（其它端由服务器 DB 分发）。
    """
    result = _run("update_avatar", {"avatar": payload.avatar}, db, user, limit=20)
    if im_desktop_proxy.is_shared_desktop():
        local = db.query(User).filter(User.id == user.id).first()
        if local is not None:
            local.avatar = im_service.normalize_avatar(payload.avatar)
            db.commit()
    return _ok(result)


@router.put("/nickname")
def update_nickname(payload: NicknameRequest, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    """修改协作沟通昵称（仅 IM 展示名生效，不改登录账号 username）。

    与头像一致：桌面共享模式同时写回本机 users 表，让本机登录载荷 / 侧边栏立即生效。
    """
    result = _run("update_nickname", {"nickname": payload.nickname}, db, user, limit=20)
    if im_desktop_proxy.is_shared_desktop():
        local = db.query(User).filter(User.id == user.id).first()
        if local is not None:
            local.nickname = im_service.normalize_nickname(payload.nickname)
            db.commit()
    return _ok(result)


@router.get("/conversations/{conversation_id}/members")
def list_members(conversation_id: int, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    return _ok(_run("list_members", {"conversation_id": conversation_id}, db, user))


@router.post("/conversations/{conversation_id}/members", status_code=201)
def add_members(conversation_id: int, payload: MemberRequest,
                db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _ok(_run("add_members", {
        "conversation_id": conversation_id, "member_ids": payload.member_ids,
    }, db, user, limit=30))


# 固定路径 /members/me 必须注册在 /members/{target_user_id} 之前，
# 否则 Starlette 会先命中 int 路径参数并对 "me" 做 422 校验。
@router.delete("/conversations/{conversation_id}/members/me", status_code=204)
def leave_group(conversation_id: int, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    """成员主动退出自建群；群主须先解散群。"""
    _run("leave_group", {"conversation_id": conversation_id}, db, user, limit=20)
    return Response(status_code=204)


@router.delete("/conversations/{conversation_id}/members/{target_user_id}", status_code=204)
def remove_member(conversation_id: int, target_user_id: int,
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _run("remove_member", {
        "conversation_id": conversation_id, "target_user_id": target_user_id,
    }, db, user, limit=30)
    return Response(status_code=204)


@router.get("/conversations/{conversation_id}/messages")
def list_messages(conversation_id: int,
                  after_id: Optional[int] = Query(None),
                  before_id: Optional[int] = Query(None),
                  limit: Optional[int] = Query(None, ge=1, le=100),
                  ids: Optional[str] = Query(None, description="逗号分隔的消息 id，用于撤回状态对账"),
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if after_id is not None and before_id is not None:
        raise HTTPException(status_code=400, detail="IM_INVALID_MESSAGE")
    parsed_ids: Optional[List[int]] = None
    if ids:
        parts = [part.strip() for part in ids.split(',') if part.strip()]
        if not parts or len(parts) > 100 or any(not re.fullmatch(r'\d+', part) for part in parts):
            raise HTTPException(status_code=400, detail="IM_INVALID_MESSAGE")
        parsed_ids = [int(part) for part in parts]
    return _ok(_run("list_messages", {
        "conversation_id": conversation_id, "after_id": after_id,
        "before_id": before_id, "limit": limit, "ids": parsed_ids,
    }, db, user, limit=120))


@router.post("/conversations/{conversation_id}/messages")
def send_message(conversation_id: int, payload: SendMessageRequest, response: Response,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    result = _run("send_message", {
        "conversation_id": conversation_id, "kind": payload.kind,
        "content_text": payload.content_text, "attachment_id": payload.attachment_id,
        "client_msg_id": payload.client_msg_id,
        "mentions": payload.mentions, "mention_all": payload.mention_all,
        "reply_to_id": payload.reply_to_id,
    }, db, user, limit=60)
    if result.get("created"):
        response.status_code = 201
        response.headers["Location"] = (
            f"/api/v1/im/conversations/{conversation_id}/messages/"
            f"{result['message']['id']}"
        )
    return _ok(result.get("message"))


@router.delete("/conversations/{conversation_id}/messages/{message_id}")
def delete_message(conversation_id: int, message_id: int,
                   db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """隐藏单条自己发出的历史消息（仅对操作者生效，对方无感）。"""
    return _ok(_run("delete_message", {
        "conversation_id": conversation_id, "message_id": message_id,
    }, db, user, limit=30))


@router.post("/conversations/{conversation_id}/messages/{message_id}/recall")
def recall_message(conversation_id: int, message_id: int,
                   db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """撤回自己 5 分钟内发出的消息：原文仅自己可见，其他成员看到撤回占位。"""
    return _ok(_run("recall_message", {
        "conversation_id": conversation_id, "message_id": message_id,
    }, db, user, limit=30))


@router.post("/messages/forward")
def forward_messages(payload: ForwardRequest, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    """把选中的历史消息转发到指定个人/群会话。"""
    return _ok(_run("forward_messages", {
        "message_ids": payload.message_ids,
        "conversation_ids": payload.conversation_ids,
    }, db, user, limit=30))


@router.post("/conversations/{conversation_id}/read")
def mark_read(conversation_id: int, payload: ReadRequest,
              db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _ok(_run("mark_read", {
        "conversation_id": conversation_id,
        "last_read_message_id": payload.last_read_message_id,
    }, db, user, limit=120))


@router.get("/contacts")
def list_contacts(limit: Optional[int] = Query(None, ge=1, le=500),
                  query: Optional[str] = Query(None, max_length=64),
                  db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    """通讯录；不传 limit/query 时保持旧客户端的全量行为。"""
    args: Dict[str, Any] = {}
    if limit is not None:
        args["limit"] = limit
    if query:
        args["query"] = query
    return _ok(_run("list_contacts", args, db, user, limit=30))


@router.post("/groups", status_code=201)
def create_group(payload: CreateConversationRequest, response: Response,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    result = _run("create_group", {
        "name": payload.name or "", "member_ids": payload.member_ids,
    }, db, user, limit=10)
    response.headers["Location"] = f"/api/v1/im/conversations/{result.get('id')}"
    return _ok(result)


# ---------------- 附件：具体路径必须定义在 /attachments/{attachment_id} 之前 ----------------

@router.post("/attachments/urls")
def attachment_urls(payload: AttachmentUrlsRequest, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    """批量换取短时签名直链：共享模式一次历史消息只发一次 relay 控制请求。"""
    if len(payload.items) > 200:
        raise HTTPException(status_code=400, detail="IM_TOO_MANY_ATTACHMENTS")
    items = [
        {"attachment_id": item.attachment_id, "thumb": item.thumb}
        for item in payload.items
    ]
    data = _run("attachment_urls", {"items": items}, db, user, limit=600)
    tokens = dict((data or {}).get("tokens") or {})
    if im_desktop_proxy.is_shared_desktop():
        from app.services.desktop_cloud_client import server_url

        base = server_url()
        if base:
            for info in tokens.values():
                thumb = 1 if info.get("thumb") else 0
                info["url"] = (
                    f"{base.rstrip('/')}{info['path']}"
                    f"?token={urllib.parse.quote(str(info['token']), safe='')}"
                    f"&thumb={thumb}"
                )
    return _ok({"tokens": tokens})


@router.post("/attachments/start")
def attachment_start(payload: AttachmentStartRequest, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    # 桌面共享同样走与网页端一致的上限：分片已是 2MB，base64 单片约 2.7MB，
    # 默认上限 512MB；生产可通过 NPT_IM_MAX_FILE_MB 调整。真正限制慢请求的是独立 relay 槽池。
    if im_desktop_proxy.is_shared_desktop() \
            and payload.size_bytes > settings.NPT_IM_MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(status_code=400, detail="IM_ATTACHMENT_TOO_LARGE")
    return _ok(_run("attachment_start", {
        "conversation_id": payload.conversation_id,
        "original_name": payload.original_name, "mime": payload.mime,
        "size_bytes": payload.size_bytes,
    }, db, user, limit=20))


@router.post("/attachments/chunk")
def attachment_chunk(payload: AttachmentChunkRequest, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    return _ok(_run("attachment_chunk", {
        "upload_id": payload.upload_id, "chunk_index": payload.chunk_index,
        "data_b64": payload.data_b64,
    }, db, user, limit=600))


@router.post("/attachments/complete", status_code=201)
def attachment_complete(payload: AttachmentIdRequest, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    return _ok(_run("attachment_complete", {"upload_id": payload.upload_id},
                    db, user, limit=20))


@router.post("/attachments/cancel", status_code=204)
def attachment_cancel(payload: AttachmentIdRequest, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    _run("attachment_cancel", {"upload_id": payload.upload_id}, db, user, limit=20)
    return Response(status_code=204)


@router.post("/attachments/{attachment_id}/open")
def open_attachment(attachment_id: int, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    """桌面端：把聊天附件写到临时目录并交给系统默认应用打开（Excel / Word / PPT / 视频…）。

    网页端不提供该能力（在服务器进程里 startfile 只会打开服务器上的文件），
    前端自动退化为「下载 / 新标签页预览」；共享模式优先用签名直链取二进制。
    """
    if not settings.NPT_DESKTOP:
        raise HTTPException(status_code=404, detail="Not Found")
    if im_desktop_proxy.is_shared_desktop():
        content, _, filename = _shared_attachment_bytes(
            attachment_id, False, db, user)
    else:
        att = im_service.get_attachment_for_member(db, attachment_id, user.id)
        path, _ = im_attachment_service.resolve_path(att.storage_path)
        content = path.read_bytes()
        filename = att.original_name

    out_dir = Path(tempfile.gettempdir()) / "npt-im-open"
    out_dir.mkdir(parents=True, exist_ok=True)
    safe_name = im_attachment_service.clean_filename(filename)
    target = out_dir / safe_name
    target.write_bytes(content)
    try:
        if os.name == "nt":
            os.startfile(str(target))  # type: ignore[attr-defined]
        else:
            subprocess.Popen(  # noqa: S603 - 路径由 clean_filename 净化，参数用列表传递
                ["xdg-open", str(target)], stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
            )
    except (OSError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=f"IM_OPEN_UNSUPPORTED: {exc}")
    return _ok({"opened": True, "path": str(target)})


@router.post("/attachments/cache")
def start_attachment_cache(payload: AttachmentCacheRequest,
                           user: User = Depends(get_current_user)):
    """桌面端：后台缓存附件到本机下载目录（已下载过的附件直接复用本机文件）。"""
    if not settings.NPT_DESKTOP:
        raise HTTPException(status_code=404, detail="Not Found")
    return _ok(im_download_jobs.start(
        int(user.id), payload.attachment_id, payload.filename, payload.reveal))


@router.get("/attachments/{attachment_id}/cache")
def attachment_cache_status(attachment_id: int,
                            user: User = Depends(get_current_user)):
    """桌面端：查询后台缓存进度，供前端显示进度条。"""
    if not settings.NPT_DESKTOP:
        raise HTTPException(status_code=404, detail="Not Found")
    return _ok(im_download_jobs.status(int(user.id), attachment_id))


@router.post("/attachments/{attachment_id}/reveal")
def reveal_attachment(attachment_id: int,
                      user: User = Depends(get_current_user)):
    """桌面端：在本地已缓存的附件上调用系统文件管理器定位。"""
    if not settings.NPT_DESKTOP:
        raise HTTPException(status_code=404, detail="Not Found")
    try:
        return _ok(im_download_jobs.reveal_cached(int(user.id), attachment_id))
    except HTTPException as exc:
        if exc.status_code != 409:
            raise
        # 兼容未先调用 /cache 的旧前端：后台缓存完成后自动定位
        return _ok(im_download_jobs.start(
            int(user.id), attachment_id, f"attachment-{attachment_id}", reveal=True))


def _attachment_headers(filename: str, thumb: bool) -> Dict[str, str]:
    disposition = "inline" if thumb else "attachment"
    quoted = urllib.parse.quote(filename)
    return {
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{quoted}",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": f"private, max-age={settings.IM_ATTACHMENT_CACHE_SECONDS}",
    }


def _shared_attachment_bytes(attachment_id: int, thumb: bool,
                             db: Session, user: User) -> tuple[bytes, str, str]:
    """共享模式取图：优先短时签名直链的二进制流，失败自动退回 base64 relay。

    回退是为了兼容「新桌面端 + 未升级的生产后端」——旧 relay 不认识 attachment_urls
    会返回 404；回退后功能不变，只是暂时没有性能收益。限流 429 不回退，避免叠加。
    """
    cached = im_attachment_service.read_remote_cache(attachment_id, thumb)
    if cached is not None:
        return cached
    try:
        data = _run("attachment_urls", {
            "items": [{"attachment_id": attachment_id, "thumb": thumb}],
        }, db, user, limit=120)
        info = (data or {}).get("tokens", {}).get(f"{attachment_id}:{int(thumb)}")
        if info:
            result = im_desktop_proxy.fetch_signed_attachment(info)
            im_attachment_service.write_remote_cache(attachment_id, thumb, *result)
            return result
    except HTTPException as exc:
        if exc.status_code == 429:
            raise
        logger.warning("签名直链失败，回退旧 relay：attachment=%s thumb=%s detail=%s",
                       attachment_id, thumb, exc.detail)
    except Exception as exc:  # noqa: BLE001 - 任何异常都不能让图片直接空白
        logger.warning("签名直链异常，回退旧 relay：attachment=%s thumb=%s err=%s",
                       attachment_id, thumb, exc)
    payload = _run("attachment_download", {
        "attachment_id": attachment_id, "thumb": thumb,
    }, db, user, limit=60)
    content = base64.b64decode(payload["content_b64"])
    result = (content,
              payload.get("mime") or "application/octet-stream",
              payload.get("filename") or "attachment")
    im_attachment_service.write_remote_cache(attachment_id, thumb, *result)
    return result


def _download(attachment_id: int, thumb: bool, db: Session, user: User) -> Response:
    if im_desktop_proxy.is_shared_desktop():
        content, mime, filename = _shared_attachment_bytes(
            attachment_id, thumb, db, user)
        return Response(content=content, media_type=mime,
                        headers=_attachment_headers(filename, thumb))

    att = im_service.get_attachment_for_member(db, attachment_id, user.id)
    relative = att.thumb_path if thumb and att.thumb_path else att.storage_path
    path, _ = im_attachment_service.resolve_path(relative)
    mime = "image/png" if thumb and att.thumb_path else att.mime
    # 网页端流式响应：不再把整个附件 read_bytes() 读进内存，大附件不会挤占
    # 请求线程内存，也不会拖慢同进程内的实时消息处理。
    return FileResponse(path=str(path), media_type=mime,
                        headers=_attachment_headers(att.original_name, thumb))


_SIGNED_ORIGIN = re.compile(
    r"^(https://app\.pengwc\.asia|https?://(localhost|127\.0\.0\.1)(:\d+)?)$"
)


@router.get("/attachments/signed/{attachment_id}")
def signed_attachment(attachment_id: int, request: Request,
                      token: str = Query(..., description="短时签名，不写入日志"),
                      thumb: bool = Query(False),
                      db: Session = Depends(get_db)) -> Response:
    """无 Bearer 的图片直链：验签 + 成员校验后流式返回文件字节。

    token 自带 user_id，但只用它定位校验主体；签名校验通过后仍要走一次会话成员
    查询，防止被踢出群的人继续使用未过期链接看图。
    """
    user_id = im_attachment_service.attachment_token_user_id(token)
    if user_id is None or not im_attachment_service.verify_attachment_token(
            token, attachment_id, user_id, thumb):
        raise HTTPException(status_code=403, detail="IM_ATTACHMENT_LINK_INVALID")
    att = im_service.get_attachment_for_member(db, attachment_id, user_id)
    relative = att.thumb_path if thumb and att.thumb_path else att.storage_path
    path, _ = im_attachment_service.resolve_path(relative)
    mime = "image/png" if thumb and att.thumb_path else att.mime
    headers = _attachment_headers(att.original_name, thumb)
    headers["Cache-Control"] = f"private, max-age={settings.IM_ATTACHMENT_CACHE_SECONDS}"
    headers["Vary"] = "Origin"
    origin = request.headers.get("origin", "")
    if origin and _SIGNED_ORIGIN.match(origin):
        # 只给桌面壳随机端口 / 本站回显 CORS，不放宽全局；token 本身不可猜测
        headers["Access-Control-Allow-Origin"] = origin
    return FileResponse(path=str(path), media_type=mime, headers=headers)


@router.get("/attachments/{attachment_id}/thumb")
def attachment_thumb(attachment_id: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    return _download(attachment_id, True, db, user)


@router.get("/attachments/{attachment_id}")
def attachment_download(attachment_id: int, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    return _download(attachment_id, False, db, user)
