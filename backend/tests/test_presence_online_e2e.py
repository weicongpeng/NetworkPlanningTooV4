"""用户上线提醒端到端集成测试

真实起一个 uvicorn 服务（独立进程内的线程）+ 两个 WebSocket 客户端：
- 客户端 A（其他用户）先连接并鉴权
- 客户端 B（上线者本人）也先连接并鉴权，模拟同一账号的另一个标签页
- 上线者本人调用 /api/v1/auth/login 登录
- 断言：A 收到 user_online 广播；B（自身）不收到；登录响应不带 online_event
"""
import asyncio
import json
import socket
import threading
import time

import pytest

from app.core.database import SessionLocal, init_db
from app.models.database import User
from app.services.auth_service import auth_service
from app.services.websocket_manager import websocket_manager


def _ensure_user(username: str, city: str, operator: str, is_admin: bool = False):
    init_db()
    db = SessionLocal()
    try:
        user = auth_service.get_user_by_username(db, username)
        if user is None:
            user = User(
                username=username,
                password_hash=auth_service.hash_password("Test@12345"),
                is_admin=is_admin,
                is_active=True,
                must_change_password=False,
                license_expiry=None,
                city=city,
                operator=operator,
            )
            db.add(user)
            db.commit()
            db.refresh(user)
        return user
    finally:
        db.close()


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def _wait_auth_ok(ws):
    for _ in range(20):
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        if msg.get("type") == "auth_ok":
            return
    raise AssertionError("WebSocket 鉴权未成功")


def test_login_notifies_only_other_users():
    try:
        import httpx
        import uvicorn
        import websockets
        from app.api import create_app
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"缺少测试依赖: {exc}")

    self_user = _ensure_user("presence_admin", "河源", "电信", is_admin=True)
    other_user = _ensure_user("presence_other", "河源", "电信")

    # 清理单例广播状态，避免其它测试残留
    websocket_manager.connections = {}
    websocket_manager.client_authed = set()
    websocket_manager.client_groups = {}
    websocket_manager.client_user_ids = {}

    app = create_app()
    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.time() + 30
    while time.time() < deadline and not server.started:
        time.sleep(0.1)
    if not server.started:
        pytest.skip("uvicorn 未能在超时内启动")

    base = f"http://127.0.0.1:{port}"
    ws_url = f"ws://127.0.0.1:{port}/api/v1/ws/tasks"

    async def _scenario():
        token_self = auth_service.create_access_token(self_user.id, "presence_admin", True)[0]
        token_other = auth_service.create_access_token(other_user.id, "presence_other", False)[0]

        async with websockets.connect(ws_url) as ws_other, websockets.connect(ws_url) as ws_self:
            await ws_other.send(json.dumps({"type": "auth", "token": token_other}))
            await _wait_auth_ok(ws_other)
            await ws_self.send(json.dumps({"type": "auth", "token": token_self}))
            await _wait_auth_ok(ws_self)

            # 上线者本人登录（触发广播）
            async with httpx.AsyncClient(base_url=base, timeout=20) as client:
                resp = await client.post(
                    "/api/v1/auth/login",
                    json={
                        "username": "presence_admin",
                        "password": "Test@12345",
                        "client_type": "pc",
                    },
                )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["success"] is True
            assert "online_event" not in body["data"], "自身登录不应回带上线事件"

            # 其他用户端应收到 user_online 广播
            got = None
            for _ in range(20):
                msg = json.loads(await asyncio.wait_for(ws_other.recv(), timeout=10))
                if msg.get("type") == "user_online":
                    got = msg
                    break
            assert got is not None, "其他用户端未收到 user_online 广播"
            assert got["data"]["text"] == "河源_电信 presence_admin"
            assert got["data"]["userId"] == self_user.id

            # 上线者自身的连接（含其它标签页）不应收到
            try:
                own = json.loads(await asyncio.wait_for(ws_self.recv(), timeout=0.6))
            except asyncio.TimeoutError:
                own = None
            assert own is None or own.get("type") != "user_online", (
                "自身登录不应在自己端弹出气泡/响敲门声"
            )

    try:
        asyncio.run(_scenario())
    finally:
        server.should_exit = True
        thread.join(timeout=15)
        websocket_manager.connections = {}
        websocket_manager.client_authed = set()
        websocket_manager.client_groups = {}
        websocket_manager.client_user_ids = {}
