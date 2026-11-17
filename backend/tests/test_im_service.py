"""协作沟通服务层单测：自动群幂等、会话鉴权、消息游标、未读、附件安全。

使用独立 in-memory SQLite，不触碰仓库生产 data/data.db。
"""
import base64

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.core.database import Base
from app.models.database import User
from app.services import im_attachment_service, im_ops, im_service


@pytest.fixture()
def db(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    # 与生产 SessionLocal(core/database.py) 一致：autoflush=False。
    # 用默认 autoflush=True 会掩盖「pending 成员行未 flush 就 COUNT」这类计数 bug。
    session = sessionmaker(bind=engine, autoflush=False)()
    session.add_all([
        User(username="alice", password_hash="x", city="广州", operator="移动"),
        User(username="bob", password_hash="x", city="广州", operator="移动"),
        User(username="carol", password_hash="x", city="深圳", operator="联通"),
    ])
    session.commit()
    monkeypatch.setattr(settings, "NPT_IM_ATTACHMENT_DIR", tmp_path / "im")
    yield session
    session.close()


def _users(db):
    return {u.username: u.id for u in db.query(User).all()}


def test_auto_group_is_idempotent(db):
    ids = _users(db)
    first = im_service.ensure_default_groups(db, ids["alice"])
    second = im_service.ensure_default_groups(db, ids["bob"])
    assert first == second
    groups = db.query(im_service.ImConversation).filter(
        im_service.ImConversation.kind == "auto_group").all()
    assert len(groups) == 1
    members = im_service.list_members(db, first, ids["alice"])
    assert {m["id"] for m in members} == {ids["alice"], ids["bob"]}
    assert ids["carol"] not in {m["id"] for m in members}


def test_direct_conversation_is_idempotent_and_allows_cross_group(db):
    ids = _users(db)
    one = im_service.create_direct(db, ids["alice"], ids["carol"])
    two = im_service.create_direct(db, ids["alice"], ids["carol"])
    assert one["conversation"]["id"] == two["conversation"]["id"]
    assert one["created"] is True and two["created"] is False


def test_self_direct_conversation_allows_sending_to_self(db):
    """点击自己通讯录 / 发消息给自己：单成员 direct 会话，幂等且可读可写。"""
    ids = _users(db)
    one = im_service.create_direct(db, ids["alice"], ids["alice"])
    two = im_service.create_direct(db, ids["alice"], ids["alice"])
    assert one["created"] is True and two["created"] is False
    conv_id = one["conversation"]["id"]
    assert [m["id"] for m in im_service.list_members(db, conv_id, ids["alice"])] == [ids["alice"]]
    sent = im_service.send_message(db, conv_id, ids["alice"], "text", "给自己留个备注")
    assert sent["created"] is True
    items = im_service.list_messages(db, conv_id, ids["alice"])["items"]
    assert [m["content_text"] for m in items] == ["给自己留个备注"]
    conv = next(c for c in im_service.list_conversations(db, ids["alice"])["items"]
                if c["id"] == conv_id)
    assert conv["is_self"] is True and conv["member_count"] == 1


def test_message_quote_delete_and_forward(db):
    """历史消息右键菜单的服务端语义：引用、删除（断引用）、转发到群。"""
    ids = _users(db)
    alice, bob = ids["alice"], ids["bob"]
    conv = im_service.create_direct(db, alice, bob)["conversation"]["id"]
    first = im_service.send_message(db, conv, alice, "text", "原始消息")["message"]
    quoted = im_service.send_message(
        db, conv, bob, "text", "收到", reply_to_id=first["id"])["message"]
    assert quoted["reply_to"]["preview"] == "原始消息"
    assert quoted["reply_to"]["sender_id"] == alice

    target = im_service.create_custom_group(db, alice, "转发目标", [bob])["id"]
    result = im_service.forward_messages(db, alice, [first["id"]], [target])
    assert result["count"] == 1
    forwarded = im_service.list_messages(db, target, alice)["items"]
    assert [m["content_text"] for m in forwarded] == ["原始消息"]
    assert forwarded[0]["sender_id"] == alice

    im_service.delete_message(db, conv, first["id"], alice)
    remaining = im_service.list_messages(db, conv, alice)["items"]
    assert [m["id"] for m in remaining] == [quoted["id"]]
    assert remaining[0]["reply_to"] is None  # 被引用消息删除后只清空引用，不删回复


def test_custom_group_members_and_guard(db):
    ids = _users(db)
    group = im_service.create_custom_group(db, ids["alice"], "跨市项目", [ids["carol"]])
    members = im_service.list_members(db, group["id"], ids["alice"])
    assert {m["id"] for m in members} == {ids["alice"], ids["carol"]}
    with pytest.raises(HTTPException) as exc:
        im_service.list_members(db, group["id"], ids["bob"])
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:
        im_service.add_members(db, group["id"], ids["carol"], [ids["bob"]])
    assert exc.value.status_code == 403


def test_send_message_idempotent_and_cursor_pagination(db):
    ids = _users(db)
    conv_id = im_service.create_direct(db, ids["alice"], ids["bob"])["conversation"]["id"]
    sent = []
    for index in range(5):
        sent.append(im_ops.run_local_op(db, ids["alice"], "send_message", {
            "conversation_id": conv_id, "kind": "text",
            "content_text": f"消息-{index}", "client_msg_id": f"c-{index}",
        })["message"]["id"])
    duplicate = im_ops.run_local_op(db, ids["alice"], "send_message", {
        "conversation_id": conv_id, "kind": "text",
        "content_text": "消息-0", "client_msg_id": "c-0",
    })
    assert duplicate["created"] is False

    first_page = im_service.list_messages(db, conv_id, ids["alice"], limit=3)
    assert [m["id"] for m in first_page["items"]] == sent[2:]
    assert first_page["has_more"] is True
    second_page = im_service.list_messages(
        db, conv_id, ids["alice"], after_id=first_page["next_cursor"], limit=50)
    assert [m["id"] for m in second_page["items"]] == []
    older = im_service.list_messages(
        db, conv_id, ids["alice"], before_id=first_page["prev_cursor"], limit=50)
    assert [m["id"] for m in older["items"]] == sent[:2]


def test_unread_and_mark_read(db):
    ids = _users(db)
    conv_id = im_service.create_direct(db, ids["alice"], ids["bob"])["conversation"]["id"]
    im_ops.run_local_op(db, ids["alice"], "send_message", {
        "conversation_id": conv_id, "kind": "text", "content_text": "在吗",
    })
    convs = im_service.list_conversations(db, ids["bob"])["items"]
    target = next(c for c in convs if c["id"] == conv_id)
    assert target["unread"] == 1
    # 本端发出的消息不进本端未读数（否则自己发完就冒红角标）
    sender_convs = im_service.list_conversations(db, ids["alice"])["items"]
    assert next(c for c in sender_convs if c["id"] == conv_id)["unread"] == 0

    im_service.mark_read(db, conv_id, ids["bob"], 10_000)
    convs = im_service.list_conversations(db, ids["bob"])["items"]
    assert next(c for c in convs if c["id"] == conv_id)["unread"] == 0

    # 对端回复后，只给接收方计未读，发送方自己仍是 0
    im_ops.run_local_op(db, ids["bob"], "send_message", {
        "conversation_id": conv_id, "kind": "text", "content_text": "在的",
    })
    bob_convs = im_service.list_conversations(db, ids["bob"])["items"]
    alice_convs = im_service.list_conversations(db, ids["alice"])["items"]
    assert next(c for c in bob_convs if c["id"] == conv_id)["unread"] == 0
    assert next(c for c in alice_convs if c["id"] == conv_id)["unread"] == 1


def test_contacts_only_expose_identity_projection(db):
    ids = _users(db)
    contacts = im_service.list_contacts(db, ids["alice"])
    assert {u["username"] for u in contacts["users"]} == {"alice", "bob", "carol"}
    for user in contacts["users"]:
        # avatar / nickname 也是身份投影的一部分（用户自定义展示信息，不含任何权限/业务数据）
        assert set(user.keys()) == {
            "id", "username", "nickname", "is_online", "city", "operator", "avatar",
        }
    assert any(g["is_auto"] for g in contacts["groups"])


def test_attachment_rejects_dangerous_type_and_oversize(db, tmp_path):
    ids = _users(db)
    conv_id = im_service.create_direct(db, ids["alice"], ids["bob"])["conversation"]["id"]
    with pytest.raises(HTTPException) as exc:
        im_attachment_service.start_upload(
            db, ids["alice"], conv_id, "setup.exe", "application/octet-stream", 100)
    assert exc.value.detail == "IM_ATTACHMENT_TYPE"
    with pytest.raises(HTTPException) as exc:
        im_attachment_service.start_upload(
            db, ids["alice"], conv_id, "big.xlsx", "application/octet-stream", 999 * 1024 * 1024)
    assert exc.value.detail == "IM_ATTACHMENT_TOO_LARGE"
    assert im_attachment_service.clean_filename("../../etc/passwd") == "passwd"


def test_attachment_upload_then_send_file_message(db):
    ids = _users(db)
    conv_id = im_service.create_direct(db, ids["alice"], ids["bob"])["conversation"]["id"]
    content = b"cell, pci\nA, 123\n"
    started = im_attachment_service.start_upload(
        db, ids["alice"], conv_id, "工参.csv", "text/csv", len(content))
    im_attachment_service.write_chunk(
        db, ids["alice"], started["upload_id"], 0, content)
    completed = im_attachment_service.complete_upload(db, ids["alice"], started["upload_id"])
    assert completed["size_bytes"] == len(content)

    message = im_ops.run_local_op(db, ids["alice"], "send_message", {
        "conversation_id": conv_id, "kind": "file",
        "attachment_id": completed["id"],
    })["message"]
    assert message["attachment"]["original_name"] == "工参.csv"
    with pytest.raises(HTTPException) as exc:
        im_ops.run_local_op(db, ids["carol"], "send_message", {
            "conversation_id": conv_id, "kind": "text", "content_text": "越权",
        })
    assert exc.value.status_code == 404

    payload = im_ops.run_local_op(db, ids["bob"], "attachment_download", {
        "attachment_id": completed["id"],
    })
    assert base64.b64decode(payload["content_b64"]) == content
    path, _ = im_attachment_service.resolve_path(
        db.query(im_service.ImAttachment).filter(
            im_service.ImAttachment.id == completed["id"]).first().storage_path)
    assert path.is_file()


def test_ops_whitelist_rejects_unknown(db):
    with pytest.raises(HTTPException) as exc:
        im_ops.run_local_op(db, 1, "drop_all_tables", {})
    assert exc.value.status_code == 404


# ---------------- @ 提及：结构化名单持久化与权限 ----------------

def test_mention_single_member_is_persisted_and_serialized(db):
    ids = _users(db)
    conv_id = im_service.create_custom_group(
        db, ids["alice"], "协作群", [ids["bob"], ids["carol"]])["id"]
    message = im_ops.run_local_op(db, ids["alice"], "send_message", {
        "conversation_id": conv_id, "kind": "text",
        "content_text": "@bob 请复核", "mentions": [ids["bob"]],
        "client_msg_id": "mention-single",
    })["message"]
    assert message["mention_all"] is False
    assert [m["id"] for m in message["mentions"]] == [ids["bob"]]
    assert message["mentioned_me"] is False  # 发送者自己不算被 @

    # mentioned_me 由服务端按请求者计算，历史消息重拉仍带标记
    assert im_service.list_messages(db, conv_id, ids["bob"])["items"][0]["mentioned_me"] is True
    assert im_service.list_messages(db, conv_id, ids["carol"])["items"][0]["mentioned_me"] is False

    # 幂等重发不重复插入 mention 行，也仍返回名单
    again = im_ops.run_local_op(db, ids["alice"], "send_message", {
        "conversation_id": conv_id, "kind": "text",
        "content_text": "@bob 请复核", "mentions": [ids["bob"]],
        "client_msg_id": "mention-single",
    })
    assert again["created"] is False
    assert [m["id"] for m in again["message"]["mentions"]] == [ids["bob"]]
    assert db.query(im_service.ImMessageMention).count() == 1


def test_mention_all_requires_group_role_and_excludes_sender(db):
    ids = _users(db)
    conv_id = im_service.create_custom_group(
        db, ids["alice"], "协作群", [ids["bob"], ids["carol"]])["id"]

    # 普通成员不能 @所有人
    with pytest.raises(HTTPException) as exc:
        im_ops.run_local_op(db, ids["bob"], "send_message", {
            "conversation_id": conv_id, "kind": "text",
            "content_text": "@所有人 开会", "mention_all": True,
        })
    assert exc.value.status_code == 403
    assert exc.value.detail == "IM_NOT_ADMIN"

    # 系统管理员位不能绕过群角色门禁（口径严格按 owner/admin）
    db.query(User).filter(User.id == ids["carol"]).first().is_admin = True
    db.commit()
    with pytest.raises(HTTPException) as exc:
        im_ops.run_local_op(db, ids["carol"], "send_message", {
            "conversation_id": conv_id, "kind": "text",
            "content_text": "@所有人 开会", "mention_all": True,
        })
    assert exc.value.status_code == 403

    # 群主可用，名单在发送时刻固化为除发送者外的全部成员
    message = im_ops.run_local_op(db, ids["alice"], "send_message", {
        "conversation_id": conv_id, "kind": "text",
        "content_text": "@所有人 开会", "mention_all": True,
    })["message"]
    assert message["mention_all"] is True
    mentioned = {m["id"] for m in message["mentions"]}
    assert mentioned == {ids["bob"], ids["carol"]}
    assert ids["alice"] not in mentioned
    assert im_service.list_messages(db, conv_id, ids["bob"])["items"][-1]["mentioned_me"] is True


def test_group_admin_role_can_mention_all(db):
    ids = _users(db)
    conv_id = im_service.create_custom_group(db, ids["alice"], "协作群", [ids["bob"]])["id"]
    member = db.query(im_service.ImConversationMember).filter(
        im_service.ImConversationMember.conversation_id == conv_id,
        im_service.ImConversationMember.user_id == ids["bob"]).first()
    member.role = "admin"
    db.commit()
    message = im_ops.run_local_op(db, ids["bob"], "send_message", {
        "conversation_id": conv_id, "kind": "text",
        "content_text": "@所有人 同步进度", "mention_all": True,
    })["message"]
    assert message["mention_all"] is True
    assert {m["id"] for m in message["mentions"]} == {ids["alice"]}


def test_mentions_reject_non_member_and_direct_chat(db):
    ids = _users(db)
    conv_id = im_service.create_custom_group(db, ids["alice"], "协作群", [ids["bob"]])["id"]
    with pytest.raises(HTTPException) as exc:
        im_ops.run_local_op(db, ids["alice"], "send_message", {
            "conversation_id": conv_id, "kind": "text",
            "content_text": "@carol", "mentions": [ids["carol"]],
        })
    assert exc.value.status_code == 400
    assert exc.value.detail == "IM_INVALID_MENTION"

    direct = im_service.create_direct(db, ids["alice"], ids["bob"])["conversation"]["id"]
    with pytest.raises(HTTPException) as exc:
        im_ops.run_local_op(db, ids["alice"], "send_message", {
            "conversation_id": direct, "kind": "text",
            "content_text": "@bob", "mentions": [ids["bob"]],
        })
    assert exc.value.status_code == 400
    # 校验发生在写库前，不能留下半成品消息
    assert db.query(im_service.ImMessage).count() == 0


def test_auto_group_has_no_mention_all_authority(db):
    ids = _users(db)
    auto_id = im_service.ensure_default_groups(db, ids["alice"])
    # 自动群成员均为 member，按既定口径无人可 @所有人
    with pytest.raises(HTTPException) as exc:
        im_ops.run_local_op(db, ids["alice"], "send_message", {
            "conversation_id": auto_id, "kind": "text",
            "content_text": "@所有人", "mention_all": True,
        })
    assert exc.value.status_code == 403


# ---------------- 群成员计数：autoflush=False 下的写入与存量自愈 ----------------

def test_custom_group_member_count_tracks_real_members(db):
    ids = _users(db)
    group = im_service.create_custom_group(db, ids["alice"], "三网沟通群", [ids["bob"]])
    gid = group["id"]
    meta = db.query(im_service.ImGroupMeta).filter_by(conversation_id=gid).one()
    # 旧实现成员行未 flush 就 COUNT，这里会写成 0
    assert meta.member_count == 2
    assert group["member_count"] == 2

    contacts = im_service.list_contacts(db, ids["alice"])
    assert next(g for g in contacts["groups"] if g["id"] == gid)["member_count"] == 2
    convs = im_service.list_conversations(db, ids["alice"])
    assert next(c for c in convs["items"] if c["id"] == gid)["member_count"] == 2

    im_service.add_members(db, gid, ids["alice"], [ids["carol"]])
    assert db.query(im_service.ImGroupMeta).filter_by(conversation_id=gid).one().member_count == 3
    im_service.remove_member(db, gid, ids["alice"], ids["carol"])
    assert db.query(im_service.ImGroupMeta).filter_by(conversation_id=gid).one().member_count == 2


def test_stale_group_meta_is_reconciled_on_read(db):
    ids = _users(db)
    gid = im_service.create_custom_group(db, ids["alice"], "历史群", [ids["bob"]])["id"]
    # 模拟生产存量：member_count 被污染成 0，成员表本身是对的
    meta = db.query(im_service.ImGroupMeta).filter_by(conversation_id=gid).one()
    meta.member_count = 0
    db.commit()

    contacts = im_service.list_contacts(db, ids["alice"])
    assert next(g for g in contacts["groups"] if g["id"] == gid)["member_count"] == 2
    assert db.query(im_service.ImGroupMeta).filter_by(conversation_id=gid).one().member_count == 2

    convs = im_service.list_conversations(db, ids["alice"])
    assert next(c for c in convs["items"] if c["id"] == gid)["member_count"] == 2


def test_non_member_cannot_read_custom_group_messages(db):
    ids = _users(db)
    gid = im_service.create_custom_group(db, ids["alice"], "跨市项目", [ids["carol"]])["id"]
    # 通讯录能看到全站群（joined=False），但消息读路径必须仍按成员关系 404
    contacts = im_service.list_contacts(db, ids["bob"])
    assert next(g for g in contacts["groups"] if g["id"] == gid)["joined"] is False
    with pytest.raises(HTTPException) as exc:
        im_service.list_messages(db, gid, ids["bob"])
    assert exc.value.status_code == 404


def test_group_member_changes_emit_system_notices(db, monkeypatch):
    """加人/踢人/退群各落一条结构化系统提示，成员变更历史在群里可见。"""
    import json

    ids = _users(db)
    # 屏蔽 WS 广播：单测只验证 DB 落库，不依赖真实 websocket 连接
    from app.services import websocket_manager as wsm
    monkeypatch.setattr(wsm.websocket_manager, "notify_im_message", lambda *a, **k: None)

    gid = im_service.create_custom_group(db, ids["alice"], "自建群", [ids["bob"]])["id"]
    im_service.add_members(db, gid, ids["alice"], [ids["carol"]])
    im_service.remove_member(db, gid, ids["alice"], ids["bob"])
    im_service.leave_group(db, gid, ids["carol"])

    systems = [m for m in db.query(im_service.ImMessage)
               .filter_by(conversation_id=gid).order_by(im_service.ImMessage.id).all()
               if m.kind == "system"]
    assert [json.loads(m.content_text)["event"] for m in systems] == [
        "members_added", "member_removed", "member_left"]
    added = json.loads(systems[0].content_text)
    assert added["actor"] == "alice" and added["names"] == ["carol"]
    # 系统提示也会成为 last_message，会话列表预览直接透出结构化串，前端按语言渲染
    conv = im_service.list_conversations(db, ids["alice"])
    last = next(c for c in conv["items"] if c["id"] == gid)["last_message"]
    assert last["kind"] == "system"


def test_custom_group_owner_can_kick_member_and_member_can_leave(db):
    ids = _users(db)
    gid = im_service.create_custom_group(db, ids["alice"], "自建群", [ids["bob"], ids["carol"]])["id"]

    # 群主剔除成员，元信息成员数同步回写
    im_service.remove_member(db, gid, ids["alice"], ids["carol"])
    assert {m["id"] for m in im_service.list_members(db, gid, ids["alice"])} == {
        ids["alice"], ids["bob"]}
    assert db.query(im_service.ImGroupMeta).filter_by(conversation_id=gid).one().member_count == 2

    # 普通成员可主动退群；群主必须先解散，不能自己退
    im_service.leave_group(db, gid, ids["bob"])
    assert [m["id"] for m in im_service.list_members(db, gid, ids["alice"])] == [ids["alice"]]
    with pytest.raises(HTTPException) as exc:
        im_service.leave_group(db, gid, ids["alice"])
    assert exc.value.detail == "IM_OWNER_MUST_DISSOLVE"


def test_dissolve_group_requires_owner_and_cleans_rows(db):
    ids = _users(db)
    gid = im_service.create_custom_group(db, ids["alice"], "待解散", [ids["bob"]])["id"]
    im_service.send_message(db, gid, ids["alice"], "text", "最后一条")
    with pytest.raises(HTTPException) as exc:
        im_service.dissolve_group(db, gid, ids["bob"])
    assert exc.value.status_code == 403

    im_service.dissolve_group(db, gid, ids["alice"])
    assert db.query(im_service.ImConversation).filter_by(id=gid).first() is None
    assert db.query(im_service.ImConversationMember).filter_by(conversation_id=gid).count() == 0
    assert db.query(im_service.ImMessage).filter_by(conversation_id=gid).count() == 0
    assert db.query(im_service.ImGroupMeta).filter_by(conversation_id=gid).count() == 0


def test_avatars_validate_and_propagate(db):
    ids = _users(db)
    valid = "data:image/png;base64," + base64.b64encode(b"png").decode()
    assert im_service.update_avatar(db, ids["alice"], valid)["avatar"] == valid
    assert im_service.list_contacts(db, ids["bob"])["users"][0]["avatar"] == valid
    assert im_service.list_members(
        db, im_service.ensure_default_groups(db, ids["alice"]), ids["alice"]
    )[0]["avatar"] == valid

    gid = im_service.create_custom_group(db, ids["alice"], "头像群", [ids["bob"]])["id"]
    assert im_service.update_group_avatar(db, gid, ids["alice"], valid)["avatar"] == valid
    assert next(c for c in im_service.list_conversations(db, ids["alice"])["items"]
                if c["id"] == gid)["avatar"] == valid
    assert im_service.update_group_avatar(db, gid, ids["alice"], "")["avatar"] is None

    for bad in ("https://example.com/a.png", "data:text/html;base64,YQ==",
                "data:image/png;base64,!!!"):
        with pytest.raises(HTTPException) as exc:
            im_service.update_avatar(db, ids["alice"], bad)
        assert exc.value.detail == "IM_INVALID_AVATAR"


def test_nickname_is_im_display_name_only(db):
    """昵称只改 IM 展示名，不动 username，且消息/会话列表即时采用昵称。"""
    ids = _users(db)
    assert im_service.update_nickname(db, ids["alice"], "  老王  ")["nickname"] == "老王"
    # 身份字段仍是登录账号，昵称是独立字段
    contact = next(u for u in im_service.list_contacts(db, ids["bob"])["users"]
                   if u["id"] == ids["alice"])
    assert contact["username"] == "alice" and contact["nickname"] == "老王"
    # 消息 sender_name 用昵称；清除后回落 username
    cid = im_service.create_direct(db, ids["alice"], ids["bob"])["conversation"]["id"]
    sent = im_service.send_message(db, cid, ids["alice"], "text", "在吗")
    assert sent["message"]["sender_name"] == "老王"
    conv = next(c for c in im_service.list_conversations(db, ids["bob"])["items"]
                if c["id"] == cid)
    assert conv["other_user"]["nickname"] == "老王"
    assert im_service.update_nickname(db, ids["alice"], "")["nickname"] is None
    assert im_service._load_sender_names(db, {ids["alice"]})[ids["alice"]] == "alice"
    with pytest.raises(HTTPException) as exc:
        im_service.update_nickname(db, ids["alice"], "x" * 25)
    assert exc.value.detail == "IM_INVALID_NICKNAME"


def test_new_group_ops_are_whitelisted(db):
    for op in ("leave_group", "dissolve_group", "update_group_avatar", "update_avatar"):
        assert op in im_ops.OPS


def _unread_count(db, conv_id, user_id):
    return int(db.query(im_service.ImConversationMember).filter(
        im_service.ImConversationMember.conversation_id == conv_id,
        im_service.ImConversationMember.user_id == user_id,
    ).one().unread_count)


def test_unread_count_is_maintained_in_same_transaction(db):
    """发送消息 → 除发送者外 +1；已读按服务端游标精算；列表读冗余列。"""
    ids = _users(db)
    conv_id = im_service.create_direct(db, ids["alice"], ids["bob"])["conversation"]["id"]
    im_service.send_message(db, conv_id, ids["alice"], "text", content_text="hi")
    im_service.send_message(db, conv_id, ids["alice"], "text", content_text="hi2")
    assert _unread_count(db, conv_id, ids["alice"]) == 0
    assert _unread_count(db, conv_id, ids["bob"]) == 2
    assert im_service.list_conversations(db, ids["bob"])["items"][0]["unread"] == 2

    msg_ids = [int(r[0]) for r in db.query(im_service.ImMessage.id)
               .filter(im_service.ImMessage.conversation_id == conv_id)
               .order_by(im_service.ImMessage.id.asc()).all()]
    # 只读到第一条：剩余未读必须是 1，不能直接置 0
    assert im_service.mark_read(db, conv_id, ids["bob"], msg_ids[0])["unread"] == 1
    assert _unread_count(db, conv_id, ids["bob"]) == 1
    assert im_service.mark_read(db, conv_id, ids["bob"], msg_ids[-1])["unread"] == 0
    assert _unread_count(db, conv_id, ids["bob"]) == 0


def test_unread_count_matches_legacy_count_query(db):
    """冗余列口径必须与 init_db 回填用的旧 SQL 完全一致（排除自己发的消息）。"""
    from sqlalchemy import text

    ids = _users(db)
    conv_id = im_service.create_direct(db, ids["alice"], ids["bob"])["conversation"]["id"]
    im_service.send_message(db, conv_id, ids["alice"], "text", content_text="a")
    im_service.send_message(db, conv_id, ids["bob"], "text", content_text="b")
    im_service.send_message(db, conv_id, ids["alice"], "text", content_text="c")

    for uid in (ids["alice"], ids["bob"]):
        legacy = int(db.execute(text(
            "SELECT COUNT(*) FROM im_messages m "
            "JOIN im_conversation_members cm ON cm.conversation_id = m.conversation_id "
            "WHERE cm.conversation_id = :cid AND cm.user_id = :uid "
            "AND m.id > cm.last_read_message_id AND m.sender_id != cm.user_id"
        ), {"cid": conv_id, "uid": uid}).scalar() or 0)
        assert _unread_count(db, conv_id, uid) == legacy


def test_list_conversations_can_omit_avatars(db):
    """高频轮询省略 base64 头像，其它字段（含 unread）保持不变。"""
    ids = _users(db)
    conv_id = im_service.create_direct(db, ids["alice"], ids["bob"])["conversation"]["id"]
    db.query(User).filter(User.id == ids["alice"]).one().avatar = "data:image/png;base64,AAAA"
    db.commit()

    full = im_service.list_conversations(db, ids["bob"], True)["items"][0]
    lean = im_service.list_conversations(db, ids["bob"], False)["items"][0]
    assert full["other_user"]["avatar"] == "data:image/png;base64,AAAA"
    assert lean["other_user"]["avatar"] is None
    assert lean["avatar"] is None
    assert lean["unread"] == full["unread"] == 0
    assert lean["id"] == conv_id


def test_list_contacts_supports_limit_and_query(db):
    ids = _users(db)
    assert len(im_service.list_contacts(db, ids["alice"])["users"]) == 3
    assert len(im_service.list_contacts(db, ids["alice"], limit=2)["users"]) == 2
    matched = im_service.list_contacts(db, ids["alice"], query="ali")["users"]
    assert [u["username"] for u in matched] == ["alice"]


def test_reply_preview_carries_attachment_link(db):
    """引用图片/文件时必须带 attachment_id 与文件名，前端才能渲染可点击链接。"""
    ids = _users(db)
    conv_id = im_service.create_direct(db, ids["alice"], ids["bob"])["conversation"]["id"]
    started = im_attachment_service.start_upload(
        db, ids["alice"], conv_id, "现场照片.png", "image/png", 4)
    im_attachment_service.write_chunk(db, ids["alice"], started["upload_id"], 0, b"PNG!")
    completed = im_attachment_service.complete_upload(db, ids["alice"], started["upload_id"])

    first = im_service.send_message(
        db, conv_id, ids["alice"], "image", attachment_id=completed["id"])["message"]
    second = im_service.send_message(
        db, conv_id, ids["bob"], "text", "这是什么", reply_to_id=first["id"])["message"]

    reply = second["reply_to"]
    assert reply["id"] == first["id"]
    assert reply["attachment"]["id"] == completed["id"]
    assert reply["attachment"]["original_name"] == "现场照片.png"
    assert reply["attachment"]["mime"] == "image/png"
