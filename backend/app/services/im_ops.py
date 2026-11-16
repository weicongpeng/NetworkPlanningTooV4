"""协作沟通操作分发表。

网页端本机端点与桌面共享模式 relay 共用这一套 op 白名单，保证：
- 线上 relay 只接受白名单内操作，永远不会被当作通用 HTTP 代理；
- 桌面端无法自报 user_id，身份由许可验签后解析；
- 发送后的 WebSocket 轻通知在两端行为一致。
"""
from typing import Any, Callable, Dict

from sqlalchemy.orm import Session

from app.services import im_attachment_service, im_service
from app.services.websocket_manager import websocket_manager


def _conv_dict(conv) -> Dict[str, Any]:
    return {
        "id": conv.id, "kind": conv.kind, "name": conv.name,
        "group_key": conv.group_key, "avatar": conv.avatar,
        "owner_id": conv.owner_id, "member_count": 0,
    }


def op_list_conversations(db: Session, user_id: int, *,
                          include_avatars: bool = True, **_: Any) -> dict:
    return im_service.list_conversations(db, user_id, include_avatars)


def op_get_conversation(db: Session, user_id: int, *, conversation_id: int, **_: Any) -> dict:
    conv = im_service.get_conversation(db, conversation_id, user_id)
    result = _conv_dict(conv)
    result["members"] = im_service.list_members(db, conversation_id, user_id)
    return result


def op_create_direct(db: Session, user_id: int, *, peer_user_id: int, **_: Any) -> dict:
    return im_service.create_direct(db, user_id, int(peer_user_id))


def op_create_group(db: Session, user_id: int, *, name: str,
                    member_ids: list, **_: Any) -> dict:
    return im_service.create_custom_group(db, user_id, name, list(member_ids or []))


def op_list_members(db: Session, user_id: int, *, conversation_id: int, **_: Any) -> list:
    return im_service.list_members(db, conversation_id, user_id)


def _notify_group_system(db: Session, conversation_id: int, actor_id: int) -> None:
    """成员变更后把群内系统提示即时推给在线成员（不含操作者自己）。

    只带 message_id 等轻字段，正文由前端按游标增量拉取；kind='system' 让前端
    跳过「新消息」提示音（系统提示不该叮咚）。
    """
    conv = db.query(im_service.ImConversation).filter(
        im_service.ImConversation.id == conversation_id).first()
    targets = im_service.member_ids(db, conversation_id, exclude_user_id=actor_id)
    websocket_manager.notify_im_message(targets, {
        "conversation_id": conversation_id,
        "message_id": conv.last_message_id if conv else 0,
        "sender_id": actor_id,
        "sender_name": "",
        "kind": "system",
        "mention_all": False,
        "mentioned_user_ids": [],
    })


def op_add_members(db: Session, user_id: int, *, conversation_id: int,
                   member_ids: list, **_: Any) -> dict:
    result = im_service.add_members(db, conversation_id, user_id, list(member_ids or []))
    _notify_group_system(db, conversation_id, user_id)
    return result


def op_remove_member(db: Session, user_id: int, *, conversation_id: int,
                     target_user_id: int, **_: Any) -> dict:
    im_service.remove_member(db, conversation_id, user_id, int(target_user_id))
    _notify_group_system(db, conversation_id, user_id)
    return {"success": True}


def op_leave_group(db: Session, user_id: int, *, conversation_id: int, **_: Any) -> dict:
    result = im_service.leave_group(db, conversation_id, user_id)
    _notify_group_system(db, conversation_id, user_id)
    return result


def op_dissolve_group(db: Session, user_id: int, *, conversation_id: int, **_: Any) -> dict:
    return im_service.dissolve_group(db, conversation_id, user_id)


def op_update_group_avatar(db: Session, user_id: int, *, conversation_id: int,
                           avatar: str | None = None, **_: Any) -> dict:
    return im_service.update_group_avatar(db, conversation_id, user_id, avatar)


def op_update_avatar(db: Session, user_id: int, *, avatar: str | None = None,
                     **_: Any) -> dict:
    return im_service.update_avatar(db, user_id, avatar)


def op_update_nickname(db: Session, user_id: int, *, nickname: str | None = None,
                       **_: Any) -> dict:
    return im_service.update_nickname(db, user_id, nickname)


def op_list_messages(db: Session, user_id: int, *, conversation_id: int,
                     after_id: int | None = None, before_id: int | None = None,
                     limit: int | None = None, **_: Any) -> dict:
    return im_service.list_messages(db, conversation_id, user_id, after_id, before_id, limit)


def op_send_message(db: Session, user_id: int, *, conversation_id: int, kind: str,
                    content_text: str | None = None, attachment_id: int | None = None,
                    client_msg_id: str | None = None, mentions: list | None = None,
                    mention_all: bool = False, **_: Any) -> dict:
    result = im_service.send_message(
        db, conversation_id, user_id, kind, content_text, attachment_id, client_msg_id,
        mentions, mention_all)
    if result.get("created"):
        message = result["message"]
        targets = im_service.member_ids(db, conversation_id, exclude_user_id=user_id)
        # @所有人 时只带布尔量，避免把全量成员 id 塞进每条 WS 轻通知；
        # 精确 @ 名单才下发 id 列表，由前端按当前用户自行判定是否被点名。
        websocket_manager.notify_im_message(targets, {
            "conversation_id": conversation_id,
            "message_id": message["id"],
            "sender_id": user_id,
            "sender_name": message.get("sender_name", ""),
            "kind": message["kind"],
            "mention_all": bool(message.get("mention_all")),
            "mentioned_user_ids": (
                [] if message.get("mention_all")
                else [m["id"] for m in message.get("mentions", [])]
            ),
        })
    return result


def op_mark_read(db: Session, user_id: int, *, conversation_id: int,
                 last_read_message_id: int, **_: Any) -> dict:
    return im_service.mark_read(db, conversation_id, user_id, last_read_message_id)


def op_list_contacts(db: Session, user_id: int, *, limit: int | None = None,
                     query: str | None = None, **_: Any) -> dict:
    return im_service.list_contacts(db, user_id, limit, query)


def op_attachment_start(db: Session, user_id: int, *, conversation_id: int,
                        original_name: str, mime: str, size_bytes: int, **_: Any) -> dict:
    return im_attachment_service.start_upload(
        db, user_id, conversation_id, original_name, mime, size_bytes)


def op_attachment_chunk(db: Session, user_id: int, *, upload_id: str,
                        chunk_index: int, data_b64: str, **_: Any) -> dict:
    import base64
    import binascii

    from fastapi import HTTPException

    try:
        data = base64.b64decode(data_b64 or "", validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="IM_UPLOAD_CONFLICT")
    return im_attachment_service.write_chunk(db, user_id, upload_id, chunk_index, data)


def op_attachment_complete(db: Session, user_id: int, *, upload_id: str, **_: Any) -> dict:
    return im_attachment_service.complete_upload(db, user_id, upload_id)


def op_attachment_cancel(db: Session, user_id: int, *, upload_id: str, **_: Any) -> dict:
    im_attachment_service.cancel_upload(user_id, upload_id)
    return {"success": True}


def op_attachment_download(db: Session, user_id: int, *, attachment_id: int,
                           thumb: bool = False, **_: Any) -> dict:
    """桌面共享模式使用：二进制以 base64 返回，由本机端点还原为 Response。"""
    import base64

    att = im_service.get_attachment_for_member(db, attachment_id, user_id)
    relative = att.thumb_path if thumb and att.thumb_path else att.storage_path
    path, _ = im_attachment_service.resolve_path(relative)
    content = path.read_bytes()
    return {
        "content_b64": base64.b64encode(content).decode("ascii"),
        "mime": "image/png" if thumb and att.thumb_path else att.mime,
        "filename": att.original_name,
        "size_bytes": len(content),
    }


OPS: Dict[str, Callable] = {
    "list_conversations": op_list_conversations,
    "get_conversation": op_get_conversation,
    "create_direct": op_create_direct,
    "create_group": op_create_group,
    "list_members": op_list_members,
    "add_members": op_add_members,
    "remove_member": op_remove_member,
    "leave_group": op_leave_group,
    "dissolve_group": op_dissolve_group,
    "update_group_avatar": op_update_group_avatar,
    "update_avatar": op_update_avatar,
    "update_nickname": op_update_nickname,
    "list_messages": op_list_messages,
    "send_message": op_send_message,
    "mark_read": op_mark_read,
    "list_contacts": op_list_contacts,
    "attachment_start": op_attachment_start,
    "attachment_chunk": op_attachment_chunk,
    "attachment_complete": op_attachment_complete,
    "attachment_cancel": op_attachment_cancel,
    "attachment_download": op_attachment_download,
}


def run_local_op(db: Session, user_id: int, op: str, args: Dict[str, Any]) -> Any:
    handler = OPS.get(op)
    if handler is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="IM_UNKNOWN_OP")
    return handler(db, user_id, **(args or {}))
