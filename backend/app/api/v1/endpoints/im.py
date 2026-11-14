"""协作沟通 REST 端点（/api/v1/im）。

- 全部要求 JWT（Depends(get_current_user)）；非会话成员一律 404。
- 网页端直接走本地 im_ops；桌面共享模式由 im_desktop_proxy 转发到线上 relay。
- 响应沿用项目统一信封 {"success": True, "data": ...}。
"""
from __future__ import annotations

import base64
import os
import subprocess
import tempfile
import threading
import time
import urllib.parse
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.database import User
from app.services import im_attachment_service, im_desktop_proxy, im_ops, im_service

router = APIRouter(tags=["协作沟通"])

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


@router.get("/conversations")
def list_conversations(db: Session = Depends(get_db),
                       user: User = Depends(get_current_user)):
    return _ok(_run("list_conversations", {}, db, user, limit=60))


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
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if after_id is not None and before_id is not None:
        raise HTTPException(status_code=400, detail="IM_INVALID_MESSAGE")
    return _ok(_run("list_messages", {
        "conversation_id": conversation_id, "after_id": after_id,
        "before_id": before_id, "limit": limit,
    }, db, user, limit=120))


@router.post("/conversations/{conversation_id}/messages")
def send_message(conversation_id: int, payload: SendMessageRequest, response: Response,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    result = _run("send_message", {
        "conversation_id": conversation_id, "kind": payload.kind,
        "content_text": payload.content_text, "attachment_id": payload.attachment_id,
        "client_msg_id": payload.client_msg_id,
        "mentions": payload.mentions, "mention_all": payload.mention_all,
    }, db, user, limit=60)
    if result.get("created"):
        response.status_code = 201
        response.headers["Location"] = (
            f"/api/v1/im/conversations/{conversation_id}/messages/"
            f"{result['message']['id']}"
        )
    return _ok(result.get("message"))


@router.post("/conversations/{conversation_id}/read")
def mark_read(conversation_id: int, payload: ReadRequest,
              db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _ok(_run("mark_read", {
        "conversation_id": conversation_id,
        "last_read_message_id": payload.last_read_message_id,
    }, db, user, limit=120))


@router.get("/contacts")
def list_contacts(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _ok(_run("list_contacts", {}, db, user, limit=30))


@router.post("/groups", status_code=201)
def create_group(payload: CreateConversationRequest, response: Response,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    result = _run("create_group", {
        "name": payload.name or "", "member_ids": payload.member_ids,
    }, db, user, limit=10)
    response.headers["Location"] = f"/api/v1/im/conversations/{result.get('id')}"
    return _ok(result)


# ---------------- 附件：具体路径必须定义在 /attachments/{attachment_id} 之前 ----------------

@router.post("/attachments/start")
def attachment_start(payload: AttachmentStartRequest, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    # 桌面共享经 JSON relay 传输，base64 膨胀与内存占用需更保守的上限
    if im_desktop_proxy.is_shared_desktop() and payload.size_bytes > 5 * 1024 * 1024:
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
    前端自动退化为「下载 / 新标签页预览」；共享模式经 relay 取回 base64 内容。
    """
    if not settings.NPT_DESKTOP:
        raise HTTPException(status_code=404, detail="Not Found")
    if im_desktop_proxy.is_shared_desktop():
        payload = _run("attachment_download", {
            "attachment_id": attachment_id, "thumb": False,
        }, db, user, limit=60)
        content = base64.b64decode(payload["content_b64"])
        filename = payload.get("filename") or "attachment"
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


def _download(attachment_id: int, thumb: bool, db: Session, user: User) -> Response:
    if im_desktop_proxy.is_shared_desktop():
        payload = _run("attachment_download", {
            "attachment_id": attachment_id, "thumb": thumb,
        }, db, user, limit=60)
        content = base64.b64decode(payload["content_b64"])
        mime = payload.get("mime") or "application/octet-stream"
        filename = payload.get("filename") or "attachment"
    else:
        att = im_service.get_attachment_for_member(db, attachment_id, user.id)
        relative = att.thumb_path if thumb and att.thumb_path else att.storage_path
        path, _ = im_attachment_service.resolve_path(relative)
        content = path.read_bytes()
        mime = "image/png" if thumb and att.thumb_path else att.mime
        filename = att.original_name
    quoted = urllib.parse.quote(filename)
    disposition = "inline" if thumb else "attachment"
    return Response(
        content=content, media_type=mime,
        headers={
            "Content-Disposition": f"{disposition}; filename*=UTF-8''{quoted}",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=300",
        },
    )


@router.get("/attachments/{attachment_id}/thumb")
def attachment_thumb(attachment_id: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    return _download(attachment_id, True, db, user)


@router.get("/attachments/{attachment_id}")
def attachment_download(attachment_id: int, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    return _download(attachment_id, False, db, user)
