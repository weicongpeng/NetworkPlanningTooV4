"""IM 附件签名直链：签发/验签/过期/越权/批量 op 与流式下载端点。"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.v1.endpoints import im as im_endpoint
from app.core.config import settings
from app.core.database import Base, get_db
from app.core.security import get_current_user
from app.models.database import User
from app.services import im_attachment_service, im_ops, im_service


@pytest.fixture()
def env(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False)()
    session.add_all([
        User(username="alice", password_hash="x", city="广州", operator="移动"),
        User(username="bob", password_hash="x", city="广州", operator="移动"),
        User(username="carol", password_hash="x", city="深圳", operator="联通"),
    ])
    session.commit()
    users = {u.username: u.id for u in session.query(User).all()}
    monkeypatch.setattr(settings, "NPT_IM_ATTACHMENT_DIR", tmp_path / "im")

    app = FastAPI()
    app.include_router(im_endpoint.router, prefix="/api/v1/im")
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_user] = lambda: session.query(User).filter(
        User.username == "alice").first()

    conv = im_service.create_direct(session, users["alice"], users["bob"])["conversation"]["id"]
    started = im_attachment_service.start_upload(
        session, users["alice"], conv, "照片.png", "image/png", 6)
    im_attachment_service.write_chunk(session, users["alice"], started["upload_id"], 0, b"PNGDATA")
    completed = im_attachment_service.complete_upload(
        session, users["alice"], started["upload_id"])

    yield {
        "db": session, "users": users, "conv": conv,
        "attachment_id": completed["id"], "client": TestClient(app),
    }
    session.close()


def test_signature_verify_expiry_and_tamper():
    token = im_attachment_service.sign_attachment(7, 3, True)["token"]
    assert im_attachment_service.attachment_token_user_id(token) == 3
    assert im_attachment_service.verify_attachment_token(token, 7, 3, True)

    # 换用户 / 换附件 / 换尺寸 / 篡改摘要都必须失败
    assert not im_attachment_service.verify_attachment_token(token, 7, 4, True)
    assert not im_attachment_service.verify_attachment_token(token, 8, 3, True)
    assert not im_attachment_service.verify_attachment_token(token, 7, 3, False)
    assert not im_attachment_service.verify_attachment_token(token + "x", 7, 3, True)
    assert not im_attachment_service.verify_attachment_token("bad.token", 7, 3, True)

    expired = "1.3." + im_attachment_service._attachment_signature(7, 3, True, 1)
    assert not im_attachment_service.verify_attachment_token(expired, 7, 3, True)


def test_batch_op_signs_only_member_attachments(env):
    aid = env["attachment_id"]
    result = im_ops.run_local_op(env["db"], env["users"]["alice"], "attachment_urls", {
        "items": [{"attachment_id": aid, "thumb": False}],
    })
    info = result["tokens"][f"{aid}:0"]
    assert info["path"].endswith(f"/attachments/signed/{aid}")
    assert im_attachment_service.verify_attachment_token(
        info["token"], aid, env["users"]["alice"], False)

    # 非会话成员不能直接换到签名链接
    with pytest.raises(HTTPException) as exc:
        im_ops.run_local_op(env["db"], env["users"]["carol"], "attachment_urls", {
            "items": [{"attachment_id": aid, "thumb": False}],
        })
    assert exc.value.status_code == 404


def test_signed_get_streams_bytes_with_cache_headers(env):
    aid = env["attachment_id"]
    signed = im_ops.run_local_op(env["db"], env["users"]["alice"], "attachment_urls", {
        "items": [{"attachment_id": aid, "thumb": False}],
    })["tokens"][f"{aid}:0"]

    resp = env["client"].get(
        f"/api/v1/im/attachments/signed/{aid}",
        params={"token": signed["token"], "thumb": "false"},
        headers={"Origin": "http://127.0.0.1:18789"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.content == b"PNGDATA"
    assert resp.headers["cache-control"].startswith("private, max-age=")
    assert resp.headers["access-control-allow-origin"] == "http://127.0.0.1:18789"
    assert "token" not in str(resp.headers)


def test_signed_get_rejects_invalid_token_and_non_member(env):
    aid = env["attachment_id"]
    resp = env["client"].get(
        f"/api/v1/im/attachments/signed/{aid}", params={"token": "1.2.deadbeef"})
    assert resp.status_code == 403

    # 签名合法但用户已被移出会话：仍要查成员关系
    token = im_attachment_service.sign_attachment(aid, env["users"]["carol"], False)["token"]
    resp = env["client"].get(
        f"/api/v1/im/attachments/signed/{aid}", params={"token": token})
    assert resp.status_code == 404


def test_download_streams_local_copy_before_relay(env, monkeypatch):
    """共享桌面模式已有本地副本：图片/文件下载不再触碰云端 relay。"""
    aid = env["attachment_id"]
    im_attachment_service.write_remote_cache(aid, False, b"LOCAL", "image/png", "照片.png")
    monkeypatch.setattr(im_endpoint.im_desktop_proxy, "is_shared_desktop", lambda: True)

    def _unexpected(*args, **kwargs):
        raise AssertionError("本地副本命中时不应访问云端")

    monkeypatch.setattr(im_endpoint, "_shared_attachment_bytes", _unexpected)
    resp = env["client"].get(f"/api/v1/im/attachments/{aid}")
    assert resp.status_code == 200, resp.text
    assert resp.content == b"LOCAL"


def test_open_uses_local_copy_instead_of_relay(env, monkeypatch):
    """双击打开已缓存文件：本机复制到临时目录，不再让云端返回字节。"""
    aid = env["attachment_id"]
    im_attachment_service.write_remote_cache(
        aid, False, b"LOCALDOC", "application/zip", "本地包.zip")
    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    monkeypatch.setattr(im_endpoint.im_desktop_proxy, "is_shared_desktop", lambda: True)
    monkeypatch.setattr(im_endpoint.os, "startfile", lambda path: None, raising=False)

    def _unexpected(*args, **kwargs):
        raise AssertionError("已有本地副本时不应访问云端")

    monkeypatch.setattr(im_endpoint, "_shared_attachment_bytes", _unexpected)
    resp = env["client"].post(f"/api/v1/im/attachments/{aid}/open")
    assert resp.status_code == 200, resp.text
    assert Path(resp.json()["data"]["path"]).read_bytes() == b"LOCALDOC"


def test_batch_urls_endpoint_stays_local_in_shared_mode(env, monkeypatch):
    """桌面共享模式本地优先：连换直链的控制请求都不发，字节走本机 remote-cache。"""
    calls = []
    monkeypatch.setattr(im_endpoint.im_desktop_proxy, "is_shared_desktop", lambda: True)
    monkeypatch.setattr(im_endpoint, "_run", lambda *a, **kw: calls.append(a) or {"tokens": {}})
    resp = env["client"].post("/api/v1/im/attachments/urls", json={
        "items": [{"attachment_id": env["attachment_id"], "thumb": False}],
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["tokens"] == {}
    assert calls == []
