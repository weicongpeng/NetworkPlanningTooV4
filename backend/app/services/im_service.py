"""协作沟通（IM）业务服务。

设计要点见 docs/协作沟通设计方案.md：
- SQLite 是消息唯一真源，WebSocket 只做「有新消息」轻通知；
- IM 可见性由 im_conversation_members 判定，与业务数据 (city, operator) 组过滤完全解耦；
- 通讯录只返回 users 的身份投影，不查询任何业务表。

服务层直接抛 HTTPException，与现有端点（auth/desktop_cloud）错误约定一致。
"""
import base64
import binascii
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.database import (
    ImAttachment, ImConversation, ImConversationMember, ImGroupMeta, ImMessage,
    ImMessageMention, User, UserSession,
)

KINDS = ("direct", "auto_group", "custom_group")
MESSAGE_KINDS = ("text", "image", "file")
MAX_TEXT_LENGTH = 8000
# 头像一律是前端裁剪到 128×128 后的 base64 data URL，限制体积避免把 data.db 撑爆
MAX_AVATAR_BYTES = 256 * 1024
_AVATAR_RE = re.compile(r"^data:image/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$")
# 协作沟通昵称：只在 IM 展示名生效，不动登录账号 username
MAX_NICKNAME_LENGTH = 24


def normalize_avatar(value: Optional[str]) -> Optional[str]:
    """校验并返回头像 data URL；空串 / None 表示恢复默认头像。"""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    match = _AVATAR_RE.match(text)
    if not match:
        raise _err(400, "IM_INVALID_AVATAR")
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise _err(400, "IM_INVALID_AVATAR") from None
    if not raw or len(raw) > MAX_AVATAR_BYTES:
        raise _err(400, "IM_INVALID_AVATAR")
    return f"data:image/{match.group(1)};base64,{match.group(2)}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _direct_key(a: int, b: int) -> str:
    lo, hi = sorted((int(a), int(b)))
    return f"d:{lo}:{hi}"


def _auto_key(city: str, operator: str) -> str:
    return f"g:{city}:{operator}"


def _err(status: int, detail: str) -> HTTPException:
    return HTTPException(status_code=status, detail=detail)


def _require_member(db: Session, conversation_id: int, user_id: int) -> ImConversationMember:
    member = (
        db.query(ImConversationMember)
        .filter(
            ImConversationMember.conversation_id == conversation_id,
            ImConversationMember.user_id == user_id,
        )
        .first()
    )
    if member is None:
        raise _err(404, "IM_CONVERSATION_NOT_FOUND")
    return member


def _require_admin(db: Session, conversation_id: int, user_id: int) -> ImConversationMember:
    member = _require_member(db, conversation_id, user_id)
    if member.role not in ("owner", "admin"):
        raise _err(403, "IM_NOT_ADMIN")
    return member


def _add_members(db: Session, conversation_id: int, user_ids: List[int], role: str = "member") -> None:
    existing = {
        row[0]
        for row in db.query(ImConversationMember.user_id)
        .filter(
            ImConversationMember.conversation_id == conversation_id,
            ImConversationMember.user_id.in_(user_ids),
        )
        .all()
    }
    for uid in user_ids:
        if uid not in existing:
            db.add(ImConversationMember(
                conversation_id=conversation_id, user_id=uid, role=role,
                last_read_message_id=0, muted=False, joined_at=_now(),
            ))


def _bump_unread(db: Session, conversation_id: int, sender_id: int) -> None:
    """新消息落库后给除发送者外的成员增量维护冗余未读计数。

    必须与消息插入在**同一事务**里执行，否则列表读到的 unread_count 会与
    last_read_message_id / im_messages 不一致（SQLAlchemy 默认 autoflush=False）。
    """
    db.query(ImConversationMember).filter(
        ImConversationMember.conversation_id == conversation_id,
        ImConversationMember.user_id != sender_id,
    ).update(
        {ImConversationMember.unread_count: ImConversationMember.unread_count + 1},
        synchronize_session=False,
    )


def _emit_system_message(db: Session, conversation_id: int, sender_id: int,
                         payload: Dict[str, Any]) -> int:
    """群内友好提示：落一条 kind='system' 的结构化消息，文案由前端按语言 t() 渲染。

    与用户消息分开、直接写库，客户端无法通过 send_message 伪造系统提示；
    payload = {"event": ..., "params": {...}}，只存标量参数，避免把中文句子写进库。
    """
    message = ImMessage(
        conversation_id=conversation_id, sender_id=sender_id, kind="system",
        content_text=json.dumps(payload, ensure_ascii=False), created_at=_now(),
    )
    db.add(message)
    db.flush()
    _bump_unread(db, conversation_id, sender_id)
    conv = db.query(ImConversation).filter(ImConversation.id == conversation_id).first()
    if conv is not None:
        conv.last_message_id = message.id
        conv.last_message_at = message.created_at
    return message.id


def _sync_meta_count(db: Session, conversation_id: int, owner_id: Optional[int] = None,
                     is_auto: bool = False, city: str = "", operator: str = "") -> None:
    # SessionLocal 关闭了 autoflush（core/database.py），调用方刚 db.add/db.delete 的成员行
    # 还只在 session 里；不先 flush 就会统计到旧值（建群时 0、移人时多算），
    # 而 commit 时成员才真正落库，导致 im_group_meta.member_count 永久漂移。
    db.flush()
    count = (
        db.query(func.count(ImConversationMember.id))
        .filter(ImConversationMember.conversation_id == conversation_id)
        .scalar() or 0
    )
    meta = db.query(ImGroupMeta).filter(ImGroupMeta.conversation_id == conversation_id).first()
    if meta is None:
        meta = ImGroupMeta(conversation_id=conversation_id, owner_id=owner_id,
                           is_auto=is_auto, city=city or None, operator=operator or None)
        db.add(meta)
    meta.member_count = int(count)


def _real_member_counts(db: Session, conversation_ids: List[int]) -> Dict[int, int]:
    """一次 GROUP BY 批量取真实成员数；成员关系表是唯一真源，不信任冗余缓存。"""
    if not conversation_ids:
        return {}
    rows = (
        db.query(ImConversationMember.conversation_id, func.count(ImConversationMember.id))
        .filter(ImConversationMember.conversation_id.in_(list(conversation_ids)))
        .group_by(ImConversationMember.conversation_id)
        .all()
    )
    found = {int(cid): int(count) for cid, count in rows}
    return {cid: found.get(cid, 0) for cid in conversation_ids}


def _reconcile_group_meta(db: Session, counts: Dict[int, int],
                          convs_by_id: Dict[int, ImConversation]) -> None:
    """把真实成员数幂等回写 im_group_meta，自愈存量错误值（如 custom_group 的 0）。

    只在数值不一致或 meta 缺失时写；稳定后轮询读路径零写入。调用方应在读完
    会话数据之后再调用，因为这里的 commit 会让 session 内对象过期。
    """
    if not counts:
        return
    metas = {
        m.conversation_id: m
        for m in db.query(ImGroupMeta)
        .filter(ImGroupMeta.conversation_id.in_(list(counts))).all()
    }
    changed = False
    for cid, count in counts.items():
        meta = metas.get(cid)
        if meta is None:
            conv = convs_by_id.get(cid)
            db.add(ImGroupMeta(
                conversation_id=cid,
                owner_id=conv.owner_id if conv else None,
                is_auto=bool(conv and conv.kind == "auto_group"),
                city=conv.city if conv else None,
                operator=conv.operator if conv else None,
                member_count=count,
            ))
            changed = True
        elif int(meta.member_count or 0) != count:
            meta.member_count = count
            changed = True
    if changed:
        db.commit()


def ensure_default_groups(db: Session, user_id: int) -> Optional[int]:
    """幂等确保当前用户的 (city, operator) 自动群存在且成员与在册用户同步。

    只在用户读取会话列表 / 通讯录时调用，避免启动时全量重算。
    """
    user = db.query(User).filter(User.id == user_id).first()
    if user is None or not user.city or not user.operator:
        return None

    group_key = _auto_key(user.city, user.operator)
    conv = db.query(ImConversation).filter(ImConversation.group_key == group_key).first()
    created = False
    if conv is None:
        conv = ImConversation(
            kind="auto_group", group_key=group_key,
            name=f"{user.city} · {user.operator} 协作群",
            owner_id=None, city=user.city, operator=user.operator,
            last_message_id=None, last_message_at=None, created_at=_now(),
        )
        db.add(conv)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            conv = db.query(ImConversation).filter(ImConversation.group_key == group_key).first()
            if conv is None:
                return None
        created = True

    peers = [
        row[0]
        for row in db.query(User.id).filter(
            User.is_active == True,  # noqa: E712
            User.city == user.city, User.operator == user.operator,
        ).all()
    ]
    _add_members(db, conv.id, peers)
    _sync_meta_count(db, conv.id, owner_id=None, is_auto=True,
                     city=user.city, operator=user.operator)
    db.commit()
    return conv.id if created else conv.id


def get_conversation(db: Session, conversation_id: int, user_id: int) -> ImConversation:
    conv = db.query(ImConversation).filter(ImConversation.id == conversation_id).first()
    if conv is None:
        raise _err(404, "IM_CONVERSATION_NOT_FOUND")
    _require_member(db, conversation_id, user_id)
    return conv


def _message_brief(message: Optional[ImMessage], sender_names: Dict[int, str],
                   attachments: Dict[int, ImAttachment]) -> Optional[Dict[str, Any]]:
    if message is None:
        return None
    preview = message.content_text or ""
    if message.kind not in ("text", "system"):
        att = attachments.get(message.attachment_id) if message.attachment_id else None
        preview = f"[{message.kind}] {att.original_name if att else '附件'}"
    return {
        "id": message.id,
        "kind": message.kind,
        # system 的 preview 是结构化 JSON，前端要解析后按语言渲染，不能截断
        "preview": preview if message.kind == "system" else preview[:120],
        "sender_id": message.sender_id,
        "sender_name": sender_names.get(message.sender_id, ""),
        "created_at": message.created_at,
    }


def _load_sender_names(db: Session, user_ids: set) -> Dict[int, str]:
    """消息展示名：优先协作沟通昵称，未设置则回落登录账号 username。

    sender_name 只用于 IM 展示，不影响 @ 名单、登录与权限判定，所以直接在这里
    完成「昵称优先」的解析，避免给每条消息 / 每个序列化点再透传一份昵称字典。
    """
    if not user_ids:
        return {}
    return {
        row.id: (row.nickname or "").strip() or row.username
        for row in db.query(User.id, User.username, User.nickname)
        .filter(User.id.in_(user_ids)).all()
    }


def _load_user_avatars(db: Session, user_ids: set) -> Dict[int, Optional[str]]:
    if not user_ids:
        return {}
    return {
        row.id: row.avatar
        for row in db.query(User.id, User.avatar).filter(User.id.in_(user_ids)).all()
    }


def list_conversations(db: Session, user_id: int,
                       include_avatars: bool = True) -> Dict[str, Any]:
    # 桌面共享模式按 1.5s 轮询这条读路径；ensure_default_groups 会写库 + commit，
    # 移到低频的 list_contacts（登录 bootstrap / ~20s 校准）执行，读路径零写事务。
    members = (
        db.query(ImConversationMember)
        .filter(ImConversationMember.user_id == user_id)
        .all()
    )
    if not members:
        return {"items": [], "server_time": _now()}

    member_map = {m.conversation_id: m for m in members}
    convs = (
        db.query(ImConversation)
        .filter(ImConversation.id.in_(list(member_map.keys())))
        .order_by(ImConversation.last_message_at.desc().nullslast(), ImConversation.id.desc())
        .limit(100)
        .all()
    )
    if not convs:
        return {"items": [], "server_time": _now()}

    last_ids = [c.last_message_id for c in convs if c.last_message_id]
    last_messages = {}
    if last_ids:
        last_messages = {
            m.id: m for m in db.query(ImMessage).filter(ImMessage.id.in_(last_ids)).all()
        }
    sender_ids = {m.sender_id for m in last_messages.values()}
    sender_names = _load_sender_names(db, sender_ids)

    # 批量预取附件摘要与群成员数，避免列表逐行 N+1
    attachment_ids = {m.attachment_id for m in last_messages.values() if m.attachment_id}
    attachments = (
        {a.id: a for a in db.query(ImAttachment)
         .filter(ImAttachment.id.in_(list(attachment_ids))).all()}
        if attachment_ids else {}
    )
    group_ids = [c.id for c in convs if c.kind != "direct"]
    # 以成员关系表为准批量算真实成员数，不再无条件信任 im_group_meta 冗余缓存
    group_counts = _real_member_counts(db, group_ids)

    # 未读直接读成员行的冗余计数：不再对 im_messages 逐会话跑相关子查询。
    # 计数由 send_message / _emit_system_message / mark_read 在同一事务内维护，
    # init_db 对存量库按原 SQL 口径一次性回填。

    peer_ids = set()
    for conv in convs:
        if conv.kind == "direct":
            peer_ids.add(conv.id)
    other_users: Dict[int, Dict[str, Any]] = {}
    if peer_ids:
        rows = (
            db.query(ImConversationMember.conversation_id, User.id,
                     User.username, User.nickname, User.avatar)
            .join(User, User.id == ImConversationMember.user_id)
            .filter(
                ImConversationMember.conversation_id.in_(list(peer_ids)),
                ImConversationMember.user_id != user_id,
            )
            .all()
        )
        other_users = {
            int(cid): {"id": int(uid), "username": uname,
                       "nickname": nick,
                       "avatar": avatar if include_avatars else None}
            for cid, uid, uname, nick, avatar in rows
        }

    online_ids = _online_user_ids(db)
    items = []
    for conv in convs:
        member = member_map[conv.id]
        other = other_users.get(conv.id)
        if other:
            other["is_online"] = other["id"] in online_ids
        items.append({
            "id": conv.id,
            "kind": conv.kind,
            "name": conv.name,
            "group_key": conv.group_key,
            "avatar": conv.avatar if include_avatars else None,
            "owner_id": conv.owner_id,
            "my_role": member.role,
            "other_user": other,
            # 自己会话：按成员关系表只有一个成员，前端据此显示「自己」而不是「用户 」
            "is_self": conv.kind == "direct" and other is None,
            "member_count": (group_counts.get(conv.id, 0) if conv.kind != "direct"
                             else (1 if other is None else 2)),
            "last_message": _message_brief(
                last_messages.get(conv.last_message_id), sender_names, attachments),
            "last_message_at": conv.last_message_at,
            # 字段名保持 unread，旧客户端零改动；值来自冗余列
            "unread": int(member.unread_count or 0),
            "muted": bool(member.muted),
        })
    # 放在 items 构造完成后：内部 commit 会让 session 内对象过期
    _reconcile_group_meta(db, group_counts,
                          {c.id: c for c in convs if c.kind != "direct"})
    return {"items": items, "server_time": _now()}


def _online_user_ids(db: Session) -> set:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
    return {
        int(row[0])
        for row in db.query(UserSession.user_id).filter(
            UserSession.logout_time.is_(None),
            UserSession.last_activity >= cutoff,
        ).distinct().all()
    }


def create_direct(db: Session, user_id: int, peer_id: int) -> Dict[str, Any]:
    # 允许「自己 ↔ 自己」会话（文件传输助手语义）；只有单成员，不重复插入成员行
    self_chat = peer_id == user_id
    if not self_chat:
        peer = db.query(User).filter(User.id == peer_id, User.is_active == True).first()  # noqa: E712
        if peer is None:
            raise _err(400, "IM_INVALID_PEER")

    key = _direct_key(user_id, peer_id)
    conv = db.query(ImConversation).filter(ImConversation.group_key == key).first()
    if conv is None:
        conv = ImConversation(
            kind="direct", group_key=key, name=None, owner_id=None,
            last_message_id=None, last_message_at=None, created_at=_now(),
        )
        db.add(conv)
        try:
            db.flush()
            db.add(ImConversationMember(conversation_id=conv.id, user_id=user_id,
                                        role="member", last_read_message_id=0, joined_at=_now()))
            if not self_chat:
                db.add(ImConversationMember(conversation_id=conv.id, user_id=peer_id,
                                            role="member", last_read_message_id=0, joined_at=_now()))
            db.commit()
        except IntegrityError:
            db.rollback()
            conv = db.query(ImConversation).filter(ImConversation.group_key == key).first()
            if conv is None:
                raise _err(409, "IM_CONVERSATION_CONFLICT")
        else:
            return {"conversation": {"id": conv.id, "kind": "direct"}, "created": True}
    _require_member(db, conv.id, user_id)
    return {"conversation": {"id": conv.id, "kind": "direct"}, "created": False}


def create_custom_group(db: Session, user_id: int, name: str,
                        member_ids: List[int]) -> Dict[str, Any]:
    name = (name or "").strip()
    if not name or len(name) > 128:
        raise _err(400, "IM_INVALID_MEMBERS")
    limit = int(settings.NPT_IM_MAX_MEMBERS_PER_GROUP)
    ids = sorted({int(i) for i in member_ids if int(i) != user_id})
    if not ids or len(ids) > limit:
        raise _err(400, "IM_INVALID_MEMBERS")
    valid = {
        row[0] for row in db.query(User.id).filter(
            User.id.in_(ids), User.is_active == True  # noqa: E712
        ).all()
    }
    if valid != set(ids):
        raise _err(400, "IM_INVALID_MEMBERS")

    conv = ImConversation(
        kind="custom_group", group_key=None, name=name, owner_id=user_id,
        last_message_id=None, last_message_at=None, created_at=_now(),
    )
    db.add(conv)
    db.flush()
    db.add(ImConversationMember(conversation_id=conv.id, user_id=user_id,
                                role="owner", last_read_message_id=0, joined_at=_now()))
    _add_members(db, conv.id, ids)
    _sync_meta_count(db, conv.id, owner_id=user_id, is_auto=False)
    db.commit()
    return {"id": conv.id, "kind": "custom_group", "name": conv.name, "member_count": len(ids) + 1}


def list_members(db: Session, conversation_id: int, user_id: int) -> List[Dict[str, Any]]:
    _require_member(db, conversation_id, user_id)
    rows = (
        db.query(ImConversationMember, User.username, User.nickname, User.avatar)
        .join(User, User.id == ImConversationMember.user_id)
        .filter(ImConversationMember.conversation_id == conversation_id)
        .all()
    )
    online = _online_user_ids(db)
    return [{
        "id": m.user_id, "username": uname, "nickname": nick,
        "role": m.role, "avatar": avatar,
        "is_online": m.user_id in online, "joined_at": m.joined_at,
    } for m, uname, nick, avatar in rows]


def add_members(db: Session, conversation_id: int, user_id: int,
                member_ids: List[int]) -> Dict[str, Any]:
    _require_admin(db, conversation_id, user_id)
    ids = sorted({int(i) for i in member_ids})
    limit = int(settings.NPT_IM_MAX_MEMBERS_PER_GROUP)
    current = db.query(func.count(ImConversationMember.id)).filter(
        ImConversationMember.conversation_id == conversation_id).scalar() or 0
    if not ids or current + len(ids) > limit:
        raise _err(400, "IM_INVALID_MEMBERS")
    valid = {
        row[0] for row in db.query(User.id).filter(
            User.id.in_(ids), User.is_active == True  # noqa: E712
        ).all()
    }
    if valid != set(ids):
        raise _err(400, "IM_INVALID_MEMBERS")
    _add_members(db, conversation_id, ids)
    _sync_meta_count(db, conversation_id)
    names = _load_sender_names(db, set(ids) | {user_id})
    _emit_system_message(db, conversation_id, user_id, {
        "event": "members_added",
        "actor": names.get(user_id, ""),
        "names": [names.get(i, str(i)) for i in ids],
    })
    db.commit()
    return {"member_count": db.query(func.count(ImConversationMember.id)).filter(
        ImConversationMember.conversation_id == conversation_id).scalar() or 0}


def remove_member(db: Session, conversation_id: int, user_id: int, target_id: int) -> None:
    conv = get_conversation(db, conversation_id, user_id)
    if conv.kind == "direct":
        raise _err(400, "IM_INVALID_MEMBERS")
    _require_admin(db, conversation_id, user_id)
    if target_id == conv.owner_id:
        raise _err(403, "IM_NOT_ADMIN")
    target = (
        db.query(ImConversationMember)
        .filter(ImConversationMember.conversation_id == conversation_id,
                ImConversationMember.user_id == target_id)
        .first()
    )
    if target is None:
        raise _err(404, "IM_CONVERSATION_NOT_FOUND")
    names = _load_sender_names(db, {user_id, target_id})
    db.delete(target)
    _sync_meta_count(db, conversation_id)
    _emit_system_message(db, conversation_id, user_id, {
        "event": "member_removed",
        "actor": names.get(user_id, ""),
        "names": [names.get(target_id, str(target_id))],
    })
    db.commit()


def normalize_nickname(value: Optional[str]) -> Optional[str]:
    """校验协作沟通昵称；空串 / None 表示清除昵称、回落 username。"""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) > MAX_NICKNAME_LENGTH or any(ord(ch) < 32 for ch in text):
        raise _err(400, "IM_INVALID_NICKNAME")
    return text


def update_avatar(db: Session, user_id: int, avatar: Optional[str]) -> Dict[str, Any]:
    """修改当前用户头像；空串 / None 表示恢复默认首字母头像。"""
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise _err(404, "IM_CONVERSATION_NOT_FOUND")
    user.avatar = normalize_avatar(avatar)
    db.commit()
    return {"avatar": user.avatar}


def update_nickname(db: Session, user_id: int,
                    nickname: Optional[str]) -> Dict[str, Any]:
    """修改当前用户的协作沟通昵称（只影响 IM 展示名，不改 username）。"""
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise _err(404, "IM_CONVERSATION_NOT_FOUND")
    user.nickname = normalize_nickname(nickname)
    db.commit()
    return {"nickname": user.nickname}


def update_group_avatar(db: Session, conversation_id: int, user_id: int,
                        avatar: Optional[str]) -> Dict[str, Any]:
    """群主 / 管理员修改自建群头像；自动群与单聊不可改。"""
    conv = get_conversation(db, conversation_id, user_id)
    if conv.kind != "custom_group":
        raise _err(400, "IM_INVALID_GROUP")
    _require_admin(db, conversation_id, user_id)
    conv.avatar = normalize_avatar(avatar)
    db.commit()
    return {"avatar": conv.avatar}


def leave_group(db: Session, conversation_id: int, user_id: int) -> Dict[str, Any]:
    """成员主动退出自建群；群主必须先解散群（避免产生无主群）。"""
    conv = get_conversation(db, conversation_id, user_id)
    if conv.kind != "custom_group":
        raise _err(400, "IM_INVALID_GROUP")
    if conv.owner_id == user_id:
        raise _err(400, "IM_OWNER_MUST_DISSOLVE")
    member = _require_member(db, conversation_id, user_id)
    actor = _load_sender_names(db, {user_id}).get(user_id, "")
    db.delete(member)
    _sync_meta_count(db, conversation_id)
    # 退群提示仍写入会话，剩余成员可见；退群者本人已不是成员，下次不再拉取
    _emit_system_message(db, conversation_id, user_id, {
        "event": "member_left", "actor": actor,
    })
    db.commit()
    return {"success": True}


def dissolve_group(db: Session, conversation_id: int, user_id: int) -> Dict[str, Any]:
    """群主解散自建群：级联删除成员 / 消息 / @ 记录 / 附件记录 / 群元信息。

    附件磁盘文件不随群删除（异步清理即可，避免误删其它会话共享目录）；
    会话行最后删，保证中途失败不会留下"有会话无成员"的孤儿。
    """
    conv = get_conversation(db, conversation_id, user_id)
    if conv.kind != "custom_group":
        raise _err(400, "IM_INVALID_GROUP")
    if conv.owner_id != user_id:
        raise _err(403, "IM_NOT_ADMIN")
    message_ids = [
        int(row[0]) for row in db.query(ImMessage.id)
        .filter(ImMessage.conversation_id == conversation_id).all()
    ]
    if message_ids:
        db.query(ImMessageMention).filter(
            ImMessageMention.message_id.in_(message_ids)).delete(synchronize_session=False)
    db.query(ImMessage).filter(
        ImMessage.conversation_id == conversation_id).delete(synchronize_session=False)
    db.query(ImAttachment).filter(
        ImAttachment.conversation_id == conversation_id).delete(synchronize_session=False)
    db.query(ImConversationMember).filter(
        ImConversationMember.conversation_id == conversation_id).delete(synchronize_session=False)
    db.query(ImGroupMeta).filter(
        ImGroupMeta.conversation_id == conversation_id).delete(synchronize_session=False)
    db.delete(conv)
    db.commit()
    return {"success": True}


def _load_mentions(db: Session, message_ids: List[int]) -> Dict[int, List[Dict[str, Any]]]:
    """按消息 id 批量取被 @ 成员：一次 IN 查询 + join 用户名，避免逐条 N+1。"""
    unique_ids = list(set(message_ids or []))
    if not unique_ids:
        return {}
    rows = (
        db.query(ImMessageMention.message_id, ImMessageMention.user_id, User.username)
        .join(User, User.id == ImMessageMention.user_id)
        .filter(ImMessageMention.message_id.in_(unique_ids))
        .all()
    )
    result: Dict[int, List[Dict[str, Any]]] = {}
    for message_id, user_id, username in rows:
        result.setdefault(int(message_id), []).append(
            {"id": int(user_id), "username": username})
    return result


def _reply_preview(message: Optional[ImMessage],
                   sender_names: Dict[int, str],
                   db: Optional[Session] = None,
                   attachments: Optional[Dict[int, Any]] = None) -> Optional[Dict[str, Any]]:
    """引用消息的轻量摘要（不递归嵌套引用，避免历史页传输膨胀）。

    附件摘要要带 attachment_id，前端才能把引用里的图片/文件渲染成可打开链接；
    只写 "[附件]" 会让用户看到引用却点不开原图/原文件。
    """
    if message is None:
        return None
    text = (message.content_text or "").strip()
    att = None
    if message.attachment_id:
        att = attachments.get(message.attachment_id) if attachments is not None else None
        if att is None and db is not None:
            att = db.query(ImAttachment).filter(ImAttachment.id == message.attachment_id).first()
    def _field(name: str) -> Any:
        if isinstance(att, dict):
            return att.get(name)
        return getattr(att, name, None) if att is not None else None

    if not text and att is not None:
        text = f"[附件] {_field('original_name') or ''}"
    elif not text and message.attachment_id:
        text = "[附件]"
    return {
        "id": message.id,
        "sender_id": message.sender_id,
        "sender_name": sender_names.get(message.sender_id, ""),
        "kind": message.kind,
        "preview": text[:120],
        "attachment": ({
            "id": _field("id"), "original_name": _field("original_name"),
            "mime": _field("mime"), "size_bytes": _field("size_bytes"),
            "has_thumb": bool(_field("has_thumb") or _field("thumb_path")),
        } if att is not None and _field("id") else None),
    }


def _serialize_message(db: Session, message: ImMessage,
                       sender_names: Dict[int, str],
                       attachments: Optional[Dict[int, ImAttachment]] = None,
                       mention_map: Optional[Dict[int, List[Dict[str, Any]]]] = None,
                       viewer_id: Optional[int] = None,
                       sender_avatars: Optional[Dict[int, Optional[str]]] = None,
                       reply_map: Optional[Dict[int, ImMessage]] = None) -> Dict[str, Any]:
    attachment = None
    if message.attachment_id:
        att = (attachments.get(message.attachment_id) if attachments is not None
               else db.query(ImAttachment).filter(ImAttachment.id == message.attachment_id).first())
        if att:
            attachment = {
                "id": att.id, "original_name": att.original_name, "mime": att.mime,
                "size_bytes": att.size_bytes, "has_thumb": bool(att.thumb_path),
            }
    if mention_map is None:
        mention_map = _load_mentions(db, [message.id])
    mentioned = mention_map.get(message.id, [])
    return {
        "id": message.id, "conversation_id": message.conversation_id,
        "sender_id": message.sender_id,
        "sender_name": sender_names.get(message.sender_id, ""),
        "sender_avatar": (sender_avatars or {}).get(message.sender_id),
        "kind": message.kind, "content_text": message.content_text,
        "attachment": attachment, "client_msg_id": message.client_msg_id,
        "created_at": message.created_at,
        # mention_all 是消息属性（气泡显示 @所有人）；mentioned_me 按发送时刻固化的
        # mention 行判定，不受后来加入/退出的成员影响，也不把发送者自己算进去。
        "mention_all": bool(message.mention_all),
        "mentions": mentioned,
        "mentioned_me": viewer_id is not None
            and any(item["id"] == viewer_id for item in mentioned),
        "reply_to_id": message.reply_to_id,
        "reply_to": _reply_preview(
            reply_map.get(message.reply_to_id) if reply_map else None,
            sender_names, db, attachments,
        ),
    }


def list_messages(db: Session, conversation_id: int, user_id: int,
                  after_id: Optional[int] = None, before_id: Optional[int] = None,
                  limit: Optional[int] = None) -> Dict[str, Any]:
    _require_member(db, conversation_id, user_id)
    size = limit or int(settings.NPT_IM_MESSAGE_PAGE_SIZE)
    size = max(1, min(int(size), 100))

    query = db.query(ImMessage).filter(ImMessage.conversation_id == conversation_id)
    has_more = False
    if after_id is not None:
        rows = query.filter(ImMessage.id > int(after_id)).order_by(ImMessage.id.asc()).limit(size + 1).all()
        has_more = len(rows) > size
        rows = rows[:size]
        items = rows
        # 无论是否还有更多，都返回当前批最后一条 id 作为下一轮 after_id 游标
        next_cursor = rows[-1].id if rows else None
        prev_cursor = rows[0].id if rows else None
    else:
        if before_id is not None:
            query = query.filter(ImMessage.id < int(before_id))
        rows = query.order_by(ImMessage.id.desc()).limit(size + 1).all()
        has_more = len(rows) > size
        rows = rows[:size]
        items = list(reversed(rows))
        next_cursor = items[-1].id if items else None
        prev_cursor = items[0].id if has_more and items else None

    sender_ids = {m.sender_id for m in items}
    sender_names = _load_sender_names(db, sender_ids)
    sender_avatars = _load_user_avatars(db, sender_ids)
    attachment_ids = {m.attachment_id for m in items if m.attachment_id}
    attachments = (
        {a.id: a for a in db.query(ImAttachment)
         .filter(ImAttachment.id.in_(list(attachment_ids))).all()}
        if attachment_ids else {}
    )
    mention_map = _load_mentions(db, [m.id for m in items])
    reply_ids = {m.reply_to_id for m in items if m.reply_to_id}
    reply_map = (
        {r.id: r for r in db.query(ImMessage).filter(ImMessage.id.in_(list(reply_ids))).all()}
        if reply_ids else {}
    )
    # 引用消息可能是更早的消息，其附件不在本页 attachment_ids 里；一并预取，
    # 让引用块能直接给出可打开的附件链接，且不会引入逐行 N+1。
    reply_attachment_ids = {
        r.attachment_id for r in reply_map.values() if r.attachment_id
    } - set(attachments)
    if reply_attachment_ids:
        for att in db.query(ImAttachment).filter(
                ImAttachment.id.in_(list(reply_attachment_ids))).all():
            attachments[att.id] = att
    return {
        "items": [_serialize_message(db, m, sender_names, attachments,
                                     mention_map, viewer_id=user_id,
                                     sender_avatars=sender_avatars,
                                     reply_map=reply_map) for m in items],
        "has_more": has_more,
        "next_cursor": next_cursor,
        "prev_cursor": prev_cursor,
    }


def _resolve_mentions(db: Session, conversation: Optional[ImConversation],
                      conversation_id: int, user_id: int,
                      mentions: Optional[List[int]], mention_all: bool) -> set:
    """把显式 @ 名单与 @所有人 展开成待落库的用户 id 集合。

    @所有人 严格复用 _require_admin 的群角色门禁（owner/admin），不使用 users.is_admin；
    自动群通常没有 owner/admin 成员，此时无人可 @所有人，与 add_members 行为一致。
    名单在发送时刻固化，成员后续增减不会改变历史消息的被 @ 归属。
    """
    if not mentions and not mention_all:
        return set()
    if conversation is None or conversation.kind == "direct":
        raise _err(400, "IM_INVALID_MENTION")

    valid = {
        int(row[0]) for row in db.query(ImConversationMember.user_id)
        .filter(ImConversationMember.conversation_id == conversation_id).all()
    }
    try:
        requested = {int(uid) for uid in (mentions or [])}
    except (TypeError, ValueError):
        raise _err(400, "IM_INVALID_MENTION") from None
    if not requested.issubset(valid):
        raise _err(400, "IM_INVALID_MENTION")

    resolved = requested - {user_id}
    if mention_all:
        _require_admin(db, conversation_id, user_id)
        resolved |= valid - {user_id}
    return resolved


def send_message(db: Session, conversation_id: int, user_id: int, kind: str,
                 content_text: Optional[str] = None, attachment_id: Optional[int] = None,
                 client_msg_id: Optional[str] = None,
                 mentions: Optional[List[int]] = None,
                 mention_all: bool = False,
                 reply_to_id: Optional[int] = None) -> Dict[str, Any]:
    _require_member(db, conversation_id, user_id)
    if kind not in MESSAGE_KINDS:
        raise _err(400, "IM_INVALID_MESSAGE")
    conv = db.query(ImConversation).filter(ImConversation.id == conversation_id).first()
    reply_map: Dict[int, ImMessage] = {}

    def _serialize(m: ImMessage) -> Dict[str, Any]:
        names = _load_sender_names(db, {m.sender_id})
        if m.reply_to_id and m.reply_to_id not in reply_map:
            replied = db.query(ImMessage).filter(ImMessage.id == m.reply_to_id).first()
            if replied:
                reply_map[replied.id] = replied
        return _serialize_message(db, m, names, viewer_id=user_id, reply_map=reply_map)

    if reply_to_id is not None:
        replied = db.query(ImMessage).filter(
            ImMessage.id == int(reply_to_id),
            ImMessage.conversation_id == conversation_id).first()
        if replied is None:
            raise _err(400, "IM_INVALID_MESSAGE")
        reply_map[replied.id] = replied

    if client_msg_id:
        existing = (
            db.query(ImMessage)
            .filter(ImMessage.conversation_id == conversation_id,
                    ImMessage.sender_id == user_id,
                    ImMessage.client_msg_id == client_msg_id)
            .first()
        )
        if existing:
            return {"message": _serialize(existing), "created": False}

    text_value = (content_text or "").strip()
    if kind == "text":
        if not text_value or len(text_value) > MAX_TEXT_LENGTH:
            raise _err(400, "IM_INVALID_MESSAGE")
        attachment_id = None
    else:
        if not attachment_id:
            raise _err(400, "IM_ATTACHMENT_MISMATCH")
        att = db.query(ImAttachment).filter(ImAttachment.id == int(attachment_id)).first()
        if (att is None or att.conversation_id != conversation_id
                or att.uploader_id != user_id):
            raise _err(400, "IM_ATTACHMENT_MISMATCH")
        used = db.query(ImMessage.id).filter(ImMessage.attachment_id == att.id).first()
        if used:
            raise _err(400, "IM_ATTACHMENT_MISMATCH")
        text_value = None

    # 校验/展开放在写库前，权限或名单非法时不留半成品消息
    mention_ids = _resolve_mentions(
        db, conv, conversation_id, user_id, mentions, mention_all)

    message = ImMessage(
        conversation_id=conversation_id, sender_id=user_id, kind=kind,
        content_text=text_value, attachment_id=attachment_id,
        client_msg_id=(client_msg_id or None), mention_all=bool(mention_all),
        reply_to_id=(reply_map[int(reply_to_id)].id if reply_to_id is not None else None),
        created_at=_now(),
    )
    db.add(message)
    db.flush()
    _bump_unread(db, conversation_id, user_id)
    for uid in sorted(mention_ids):
        db.add(ImMessageMention(message_id=message.id, user_id=uid))
    conv.last_message_id = message.id
    conv.last_message_at = message.created_at
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if client_msg_id:
            existing = (
                db.query(ImMessage)
                .filter(ImMessage.conversation_id == conversation_id,
                        ImMessage.sender_id == user_id,
                        ImMessage.client_msg_id == client_msg_id)
                .first()
            )
            if existing:
                names = _load_sender_names(db, {existing.sender_id})
                return {"message": _serialize_message(db, existing, names, viewer_id=user_id), "created": False}
        raise

    avatars = _load_user_avatars(db, {user_id})
    serialized = _serialize(message)
    serialized["sender_avatar"] = (avatars or {}).get(user_id)
    return {"message": serialized, "created": True}


def delete_message(db: Session, conversation_id: int, message_id: int,
                   user_id: int) -> Dict[str, Any]:
    """删除单条历史消息：发送者本人或群主/管理员可删，引用它的消息只清空引用。"""
    member = _require_member(db, conversation_id, user_id)
    message = db.query(ImMessage).filter(
        ImMessage.id == int(message_id),
        ImMessage.conversation_id == conversation_id).first()
    if message is None:
        raise _err(404, "IM_CONVERSATION_NOT_FOUND")
    if message.sender_id != user_id and member.role not in ("owner", "admin"):
        raise _err(403, "IM_NO_PERMISSION")
    conv = db.query(ImConversation).filter(ImConversation.id == conversation_id).first()
    was_last = conv is not None and conv.last_message_id == message.id
    # 外键无 ON DELETE SET NULL，先手动断开引用与 @ 名单，避免整批删消息时违反约束
    db.query(ImMessage).filter(ImMessage.reply_to_id == message.id).update(
        {ImMessage.reply_to_id: None}, synchronize_session=False)
    db.query(ImMessageMention).filter(ImMessageMention.message_id == message.id).delete(
        synchronize_session=False)
    db.delete(message)
    if was_last and conv is not None:
        latest = (db.query(ImMessage)
                  .filter(ImMessage.conversation_id == conversation_id)
                  .order_by(ImMessage.id.desc()).first())
        conv.last_message_id = latest.id if latest else None
        conv.last_message_at = latest.created_at if latest else None
    db.commit()
    return {"deleted": int(message_id)}


def forward_messages(db: Session, user_id: int, message_ids: List[int],
                     conversation_ids: List[int]) -> Dict[str, Any]:
    """把历史消息复制到多个目标会话（个人 / 群）；图片/视频复用同一份磁盘文件。"""
    ids = [int(x) for x in (message_ids or [])][:50]
    targets = [int(x) for x in (conversation_ids or [])][:50]
    if not ids or not targets:
        raise _err(400, "IM_INVALID_MESSAGE")
    sources = (db.query(ImMessage).filter(ImMessage.id.in_(ids))
               .order_by(ImMessage.id.asc()).all())
    if len(sources) != len(set(ids)):
        raise _err(404, "IM_CONVERSATION_NOT_FOUND")
    for cid in {m.conversation_id for m in sources}:
        _require_member(db, cid, user_id)
    for cid in targets:
        _require_member(db, cid, user_id)
    attachment_ids = {m.attachment_id for m in sources if m.attachment_id}
    attachments = (
        {a.id: a for a in db.query(ImAttachment)
         .filter(ImAttachment.id.in_(list(attachment_ids))).all()}
        if attachment_ids else {}
    )
    created: List[Dict[str, Any]] = []
    for target in targets:
        conv = db.query(ImConversation).filter(ImConversation.id == target).first()
        for source in sources:
            attachment_id = None
            original = attachments.get(source.attachment_id) if source.attachment_id else None
            if original is not None:
                clone = ImAttachment(
                    conversation_id=target, uploader_id=user_id,
                    original_name=original.original_name, stored_name=original.stored_name,
                    mime=original.mime, size_bytes=original.size_bytes,
                    storage_path=original.storage_path, thumb_path=original.thumb_path,
                    created_at=_now(),
                )
                db.add(clone)
                db.flush()
                attachment_id = clone.id
            message = ImMessage(
                conversation_id=target, sender_id=user_id, kind=source.kind,
                content_text=source.content_text if source.kind == "text" else None,
                attachment_id=attachment_id, client_msg_id=None, mention_all=False,
                created_at=_now(),
            )
            db.add(message)
            db.flush()
            _bump_unread(db, target, user_id)
            if conv is not None:
                conv.last_message_id = message.id
                conv.last_message_at = message.created_at
            created.append({"id": message.id, "conversation_id": target})
    db.commit()
    return {"items": created, "count": len(created)}


def member_ids(db: Session, conversation_id: int, exclude_user_id: Optional[int] = None) -> List[int]:
    query = db.query(ImConversationMember.user_id).filter(
        ImConversationMember.conversation_id == conversation_id)
    if exclude_user_id is not None:
        query = query.filter(ImConversationMember.user_id != exclude_user_id)
    return [int(row[0]) for row in query.all()]


def mark_read(db: Session, conversation_id: int, user_id: int,
              last_read_message_id: int) -> Dict[str, Any]:
    member = _require_member(db, conversation_id, user_id)
    value = max(int(member.last_read_message_id or 0), int(last_read_message_id or 0))
    member.last_read_message_id = value
    # 精算剩余未读：mark_read 是低频写路径，一次索引范围 COUNT 可接受；
    # 直接置 0 会在「客户端只标记到中间某条」时与服务端真实未读不一致。
    remaining = int(db.query(func.count(ImMessage.id)).filter(
        ImMessage.conversation_id == conversation_id,
        ImMessage.id > value,
        ImMessage.sender_id != user_id,
    ).scalar() or 0)
    member.unread_count = remaining
    db.commit()
    return {"unread": remaining}


def list_contacts(db: Session, user_id: int, limit: Optional[int] = None,
                  query: Optional[str] = None) -> Dict[str, Any]:
    """通讯录；可选 limit/query 让新前端做增量搜索，旧客户端不传参仍拿全量。"""
    ensure_default_groups(db, user_id)
    online = _online_user_ids(db)
    users_query = db.query(User).filter(
        User.is_active == True,  # noqa: E712
        User.is_desktop_shadow == False,  # noqa: E712
    )
    keyword = (query or "").strip()
    if keyword:
        # 参数化 like，避免把用户输入拼进 SQL
        pattern = f"%{keyword}%"
        users_query = users_query.filter(
            or_(User.username.like(pattern), User.nickname.like(pattern)))
    users_query = users_query.order_by(User.username.asc())
    if limit is not None:
        users_query = users_query.limit(max(1, min(int(limit), 500)))
    users = [
        {"id": u.id, "username": u.username, "nickname": u.nickname,
         "is_online": u.id in online,
         "city": u.city or "", "operator": u.operator or "", "avatar": u.avatar}
        for u in users_query.all()
    ]
    joined = {
        int(row[0]) for row in db.query(ImConversationMember.conversation_id)
        .filter(ImConversationMember.user_id == user_id).all()
    }
    convs = db.query(ImConversation).filter(ImConversation.kind != "direct").all()
    convs_by_id = {c.id: c for c in convs}
    real_counts = _real_member_counts(db, list(convs_by_id))
    groups = []
    for conv in convs:
        groups.append({
            "id": conv.id, "kind": conv.kind, "name": conv.name,
            "avatar": conv.avatar, "owner_id": conv.owner_id,
            "member_count": real_counts.get(conv.id, 0),
            # 自动群直接由 kind 判定，不再逐群查 meta（顺带去掉 N+1）
            "is_auto": conv.kind == "auto_group",
            "city": conv.city or "", "operator": conv.operator or "",
            "joined": conv.id in joined,
        })
    # 读路径自愈存量错误计数；仍在返回体里保留全站群 + joined，API 契约不变
    _reconcile_group_meta(db, real_counts, convs_by_id)
    return {
        "users": users, "groups": groups,
        "online_count": sum(1 for u in users if u["is_online"]),
        "server_time": _now(),
    }


def get_attachment_for_member(db: Session, attachment_id: int, user_id: int) -> ImAttachment:
    att = db.query(ImAttachment).filter(ImAttachment.id == attachment_id).first()
    if att is None:
        raise _err(404, "IM_ATTACHMENT_NOT_FOUND")
    _require_member(db, att.conversation_id, user_id)
    return att


def create_attachment(db: Session, conversation_id: int, user_id: int,
                      original_name: str, stored_name: str, mime: str,
                      size_bytes: int, storage_path: str,
                      thumb_path: Optional[str] = None) -> ImAttachment:
    _require_member(db, conversation_id, user_id)
    att = ImAttachment(
        conversation_id=conversation_id, uploader_id=user_id,
        original_name=original_name, stored_name=stored_name, mime=mime,
        size_bytes=size_bytes, storage_path=storage_path,
        thumb_path=thumb_path, created_at=_now(),
    )
    db.add(att)
    db.commit()
    return att
