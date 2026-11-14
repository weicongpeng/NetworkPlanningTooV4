"""协作沟通 REST 端点测试：鉴权、响应信封、成员门禁、附件下载鉴权。

用独立 FastAPI app 挂载 im.router，避免触发生产 create_app 的 lifespan。
"""
import base64

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.endpoints import im as im_endpoint
from app.core.database import Base, get_db
from app.core.security import get_current_user
from app.models.database import User


@pytest.fixture()
def client(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    # 与生产 SessionLocal 一致：autoflush=False，避免掩盖成员计数未 flush 的问题
    session = sessionmaker(bind=engine, autoflush=False)()
    users = [
        User(username="alice", password_hash="x", city="广州", operator="移动"),
        User(username="bob", password_hash="x", city="广州", operator="移动"),
        User(username="carol", password_hash="x", city="深圳", operator="联通"),
    ]
    session.add_all(users)
    session.commit()
    im_endpoint._RATE.clear()
    monkeypatch.setattr(im_endpoint.im_desktop_proxy.settings, "NPT_DESKTOP", False)
    monkeypatch.setattr(im_endpoint.im_desktop_proxy.settings, "DESKTOP_PROFILE", "")

    app = FastAPI()
    app.include_router(im_endpoint.router, prefix="/api/v1/im")

    current = {"user": users[0]}

    def override_db():
        yield session

    def override_user():
        return current["user"]

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    with TestClient(app) as test_client:
        test_client.current = current
        test_client.users = users
        yield test_client
    app.dependency_overrides.clear()
    session.close()


def test_unauthenticated_is_rejected(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    app = FastAPI()
    app.include_router(im_endpoint.router, prefix="/api/v1/im")
    app.dependency_overrides[get_db] = lambda: session
    with TestClient(app) as raw:
        response = raw.get("/api/v1/im/conversations")
        assert response.status_code in (401, 403)
    session.close()


def test_conversations_and_contacts_envelope(client):
    response = client.get("/api/v1/im/conversations")
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert "items" in body["data"]
    contacts = client.get("/api/v1/im/contacts").json()["data"]
    assert len(contacts["users"]) == 3
    assert all("password_hash" not in u for u in contacts["users"])

    # 自建群成员数在 contacts 与 conversations 两个读路径都等于真实成员关系
    created = client.post("/api/v1/im/groups", json={
        "kind": "custom_group", "name": "三网沟通群",
        "member_ids": [client.users[1].id],
    })
    assert created.status_code == 201
    gid = created.json()["data"]["id"]
    group = next(g for g in client.get("/api/v1/im/contacts").json()["data"]["groups"]
                 if g["id"] == gid)
    assert group["member_count"] == 2
    assert group["joined"] is True
    items = client.get("/api/v1/im/conversations").json()["data"]["items"]
    assert next(c for c in items if c["id"] == gid)["member_count"] == 2


def test_create_direct_returns_201_then_200_on_repeat(client):
    peer = client.users[1].id
    first = client.post("/api/v1/im/conversations",
                        json={"kind": "direct", "peer_user_id": peer})
    assert first.status_code == 201
    assert first.headers.get("location", "").startswith("/api/v1/im/conversations/")
    second = client.post("/api/v1/im/conversations",
                         json={"kind": "direct", "peer_user_id": peer})
    assert second.status_code == 200
    assert first.json()["data"]["id"] == second.json()["data"]["id"]


def test_non_member_cannot_read_or_send(client):
    peer = client.users[1].id
    conv_id = client.post("/api/v1/im/conversations",
                          json={"kind": "direct", "peer_user_id": peer}).json()["data"]["id"]
    assert client.get(f"/api/v1/im/conversations/{conv_id}/messages").status_code == 200
    client.current["user"] = client.users[2]
    assert client.get(f"/api/v1/im/conversations/{conv_id}/messages").status_code == 404
    sent = client.post(f"/api/v1/im/conversations/{conv_id}/messages",
                       json={"kind": "text", "content_text": "越权消息"})
    assert sent.status_code == 404


def test_send_and_cursor_fetch(client):
    peer = client.users[1].id
    conv_id = client.post("/api/v1/im/conversations",
                          json={"kind": "direct", "peer_user_id": peer}).json()["data"]["id"]
    sent = client.post(f"/api/v1/im/conversations/{conv_id}/messages",
                       json={"kind": "text", "content_text": "周五前完成 PCI 复核"})
    assert sent.status_code == 201
    message_id = sent.json()["data"]["id"]
    page = client.get(f"/api/v1/im/conversations/{conv_id}/messages",
                      params={"after_id": 0, "limit": 10}).json()["data"]
    assert [m["id"] for m in page["items"]] == [message_id]
    assert page["next_cursor"] == message_id
    assert client.post(f"/api/v1/im/conversations/{conv_id}/read",
                       json={"last_read_message_id": message_id}).status_code == 200


def test_attachment_download_requires_membership(client):
    peer = client.users[1].id
    conv_id = client.post("/api/v1/im/conversations",
                          json={"kind": "direct", "peer_user_id": peer}).json()["data"]["id"]
    start = client.post("/api/v1/im/attachments/start", json={
        "conversation_id": conv_id, "original_name": "基站清单.xlsx",
        "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "size_bytes": 5,
    }).json()["data"]
    import base64

    chunk = client.post("/api/v1/im/attachments/chunk", json={
        "upload_id": start["upload_id"], "chunk_index": 0,
        "data_b64": base64.b64encode(b"hello").decode("ascii"),
    })
    assert chunk.status_code == 200
    att_id = client.post("/api/v1/im/attachments/complete",
                         json={"upload_id": start["upload_id"]}).json()["data"]["id"]
    downloaded = client.get(f"/api/v1/im/attachments/{att_id}")
    assert downloaded.status_code == 200 and downloaded.content == b"hello"
    client.current["user"] = client.users[2]
    assert client.get(f"/api/v1/im/attachments/{att_id}").status_code == 404


# ---------------- @ 提及：请求体转发、权限与 WS 载荷 ----------------

def _group(client, member_ids):
    response = client.post("/api/v1/im/groups", json={
        "kind": "custom_group", "name": "协作群", "member_ids": member_ids,
    })
    assert response.status_code == 201
    return response.json()["data"]["id"]


def _capture_ws(monkeypatch):
    from app.services import im_ops

    notifications = []
    monkeypatch.setattr(
        im_ops.websocket_manager, "notify_im_message",
        lambda targets, payload: notifications.append((list(targets), payload)))
    return notifications


def test_send_with_mentions_and_ws_payload(client, monkeypatch):
    notifications = _capture_ws(monkeypatch)
    bob_id = client.users[1].id
    conv_id = _group(client, [bob_id])
    sent = client.post(f"/api/v1/im/conversations/{conv_id}/messages", json={
        "kind": "text", "content_text": "@bob 复核一下",
        "mentions": [bob_id], "mention_all": False,
    })
    assert sent.status_code == 201
    data = sent.json()["data"]
    assert [m["id"] for m in data["mentions"]] == [bob_id]
    assert data["mention_all"] is False

    assert len(notifications) == 1
    targets, payload = notifications[0]
    assert targets == [bob_id]  # 不推给发送者
    assert payload["mention_all"] is False
    assert payload["mentioned_user_ids"] == [bob_id]
    assert payload["sender_name"] == "alice"
    assert "content_text" not in payload  # WS 只带轻通知，不带正文

    client.current["user"] = client.users[1]
    page = client.get(f"/api/v1/im/conversations/{conv_id}/messages").json()["data"]
    assert page["items"][-1]["mentioned_me"] is True


def test_mention_all_permission_and_compact_ws_payload(client, monkeypatch):
    notifications = _capture_ws(monkeypatch)
    conv_id = _group(client, [client.users[1].id, client.users[2].id])

    client.current["user"] = client.users[1]
    denied = client.post(f"/api/v1/im/conversations/{conv_id}/messages", json={
        "kind": "text", "content_text": "@所有人 开会", "mention_all": True,
    })
    assert denied.status_code == 403
    assert denied.json()["detail"] == "IM_NOT_ADMIN"
    assert notifications == []

    client.current["user"] = client.users[0]  # 群主
    ok = client.post(f"/api/v1/im/conversations/{conv_id}/messages", json={
        "kind": "text", "content_text": "@所有人 开会", "mention_all": True,
    })
    assert ok.status_code == 201
    assert ok.json()["data"]["mention_all"] is True
    payload = notifications[-1][1]
    assert payload["mention_all"] is True
    assert payload["mentioned_user_ids"] == []  # 全量成员不塞进 WS 轻通知


def test_send_rejects_invalid_mentions_payload(client):
    conv_id = _group(client, [client.users[1].id])
    url = f"/api/v1/im/conversations/{conv_id}/messages"
    bad_type = client.post(url, json={
        "kind": "text", "content_text": "x", "mentions": ["not-an-int"],
    })
    assert bad_type.status_code == 422  # Pydantic 挡住非整数 id
    bad_member = client.post(url, json={
        "kind": "text", "content_text": "x", "mentions": [999999],
    })
    assert bad_member.status_code == 400
    assert bad_member.json()["detail"] == "IM_INVALID_MENTION"


def test_group_management_routes_and_avatar(client):
    gid = client.post("/api/v1/im/groups", json={
        "kind": "custom_group", "name": "管理群",
        "member_ids": [client.users[1].id, client.users[2].id],
    }).json()["data"]["id"]

    # 群主剔除成员（DELETE /members/{id} 仍走 int 路径参数）
    kicked = client.delete(f"/api/v1/im/conversations/{gid}/members/{client.users[2].id}")
    assert kicked.status_code == 204
    assert len(client.get(f"/api/v1/im/conversations/{gid}/members").json()["data"]) == 2

    # 群头像：合法 data URL / 清空 / 非法值
    avatar = "data:image/png;base64," + base64.b64encode(b"png").decode()
    assert client.put(f"/api/v1/im/conversations/{gid}/avatar",
                      json={"avatar": avatar}).json()["data"]["avatar"] == avatar
    assert client.put("/api/v1/im/avatar", json={"avatar": avatar}).status_code == 200
    assert client.put("/api/v1/im/avatar", json={"avatar": "http://x/a.png"}).status_code == 400

    # 协作沟通昵称：写入 / 清空 / 超长拦截，且不影响 username
    assert client.put("/api/v1/im/nickname",
                      json={"nickname": "老王"}).json()["data"]["nickname"] == "老王"
    assert client.current["user"].username == "alice"
    assert client.put("/api/v1/im/nickname",
                      json={"nickname": ""}).json()["data"]["nickname"] is None
    assert client.put("/api/v1/im/nickname",
                      json={"nickname": "x" * 25}).status_code == 400

    # 非群主（仍是成员）不能解散
    client.current["user"] = client.users[1]
    assert client.delete(f"/api/v1/im/conversations/{gid}").status_code == 403

    # /members/me 必须命中固定路径（不能被 int 参数路由吃掉而返回 422）
    left = client.delete(f"/api/v1/im/conversations/{gid}/members/me")
    assert left.status_code == 204
    assert client.get(f"/api/v1/im/conversations/{gid}/members").status_code == 404

    # 群主解散后会话与成员都不存在
    client.current["user"] = client.users[0]
    assert client.delete(f"/api/v1/im/conversations/{gid}").status_code == 200
    assert client.get(f"/api/v1/im/conversations/{gid}").status_code == 404
