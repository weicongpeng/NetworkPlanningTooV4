"""云端 IM 推送：签名许可 WS 鉴权分支（桌面共享模式没有云端 JWT）。

只验证端点协议与身份来源，不重复测 Ed25519 验签 / 机器码匹配（由 relay 既有测试覆盖）。
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import websocket as ws_endpoint


def _ws_client(monkeypatch) -> TestClient:
    app = FastAPI()
    app.include_router(ws_endpoint.router, prefix="/api/v1")
    # 上线广播会额外推一条 im_presence，干扰 receive_json 的断言
    monkeypatch.setattr(
        ws_endpoint.websocket_manager, "notify_im_presence",
        lambda *_args, **_kwargs: None,
    )
    return TestClient(app)


def test_license_ws_group_requires_credentials():
    """空凭证不得碰 DB，也不得把连接登记成任何用户。"""
    assert ws_endpoint._resolve_license_ws_group("", "") is None
    assert ws_endpoint._resolve_license_ws_group("lic", "") is None


def test_license_ws_group_rejects_invalid_license():
    """验签失败（HTTPException 被吞掉）返回 None，连接保持匿名。"""
    assert ws_endpoint._resolve_license_ws_group("not-a-license", "MACHINE") is None


def test_license_auth_registers_cloud_user_and_acks(monkeypatch):
    """许可 auth 成功：按云端真实 user_id 登记，回 auth_ok 供前端能力探测。"""
    seen: list = []
    monkeypatch.setattr(
        ws_endpoint, "_resolve_license_ws_group",
        lambda license_file, machine_code: ("某市", "移动", 42),
    )
    manager = ws_endpoint.websocket_manager
    monkeypatch.setattr(
        manager, "register_client_auth",
        lambda client_id, user_id=0: seen.append(("auth", user_id)),
    )
    monkeypatch.setattr(
        manager, "register_client_group",
        lambda client_id, city, operator: seen.append(("group", city, operator)),
    )
    client = _ws_client(monkeypatch)
    with client.websocket_connect("/api/v1/ws/tasks?kind=license") as ws:
        ws.send_json({
            "type": "auth", "kind": "license",
            "license_file": "signed-license", "machine_code": "A1B2-C3D4",
        })
        assert ws.receive_json() == {"type": "auth_ok"}
    assert ("auth", 42) in seen
    assert ("group", "某市", "移动") in seen


def test_license_auth_failure_replies_auth_failed(monkeypatch):
    """许可无效：明确回 auth_failed，前端可立即降级回 relay 轮询而不必等超时。"""
    monkeypatch.setattr(
        ws_endpoint, "_resolve_license_ws_group", lambda *_args: None
    )
    client = _ws_client(monkeypatch)
    with client.websocket_connect("/api/v1/ws/tasks?kind=license") as ws:
        ws.send_json({
            "type": "auth", "kind": "license",
            "license_file": "bad", "machine_code": "bad",
        })
        assert ws.receive_json() == {"type": "auth_failed"}


def test_legacy_jwt_auth_still_works(monkeypatch):
    """网页端原有 JWT auth 分支不能回归。"""
    monkeypatch.setattr(
        ws_endpoint, "_resolve_ws_group", lambda token: ("某市", "联通", 7)
    )
    monkeypatch.setattr(
        ws_endpoint.websocket_manager, "register_client_auth",
        lambda client_id, user_id=0: None,
    )
    monkeypatch.setattr(
        ws_endpoint.websocket_manager, "register_client_group",
        lambda client_id, city, operator: None,
    )
    client = _ws_client(monkeypatch)
    with client.websocket_connect("/api/v1/ws/tasks") as ws:
        ws.send_json({"type": "auth", "token": "jwt"})
        assert ws.receive_json() == {"type": "auth_ok"}


def test_anonymous_license_connection_rejects_subscribe(monkeypatch):
    """strict 许可连接未鉴权时不允许订阅任务，只能等 auth / ping。"""
    subscribed: list = []

    async def _record_subscribe(*_args, **_kwargs):
        subscribed.append(True)

    monkeypatch.setattr(
        ws_endpoint.websocket_manager, "subscribe_task", _record_subscribe
    )
    client = _ws_client(monkeypatch)
    with client.websocket_connect("/api/v1/ws/tasks?kind=license") as ws:
        ws.send_json({"type": "subscribe", "taskId": "task-1"})
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}
    assert subscribed == []
