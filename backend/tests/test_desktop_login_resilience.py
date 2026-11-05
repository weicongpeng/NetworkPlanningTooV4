"""登录链路的韧性与响应速度：网络瞬断重试、退出登录不被跨公网通知阻塞。"""
from __future__ import annotations

import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.database import get_db
from app.core.security import get_current_user, get_token_jti
from app.services import desktop_cloud_client as cloud


# ------------------------------------------------------- cloud.login 重试

def test_login_retries_on_network_error(monkeypatch):
    """网络不可达（含 TLS 握手超时）重试一次：弱网下握手超时多为瞬时故障。"""
    calls = []

    def _fake_request(method, path, payload=None, timeout=20):
        calls.append((method, path, timeout))
        if len(calls) == 1:
            raise cloud.CloudError(0, "_ssl.c:993: The handshake operation timed out")
        return {"data": {"result": "ok", "license_file": None, "license_id": 1}}

    monkeypatch.setattr(cloud, "_request", _fake_request)
    # 成功路径会激活许可；让它直接失败也无所谓——重试是否发生看调用次数即可。
    # 这里让 activate 通过：mock license_service.activate
    from app.services import license_service

    monkeypatch.setattr(license_service.license_service, "activate", lambda text: (True, ""))

    data = cloud.login("alice", "pwd", "shared", timeout=6)
    assert data["result"] == "ok"
    assert len(calls) == 2, f"网络瞬断应重试一次，实际调用 {len(calls)} 次"
    assert calls[0][2] == 6


def test_login_does_not_retry_on_http_error(monkeypatch):
    """HTTP 业务错误（401 密码错等）立刻抛出，不重试、不增加用户等待。"""
    calls = []

    def _fake_request(method, path, payload=None, timeout=20):
        calls.append(1)
        raise cloud.CloudError(401, "用户名或密码错误")

    monkeypatch.setattr(cloud, "_request", _fake_request)
    with pytest.raises(cloud.CloudError) as exc:
        cloud.login("alice", "wrong", "shared", timeout=6)
    assert exc.value.status_code == 401
    assert len(calls) == 1


def test_login_fast_probe_disables_retry(monkeypatch):
    """快速探测路径（retries=0）只请求一次，不挤占 1.2s 的时间预算。"""
    calls = []

    def _fake_request(method, path, payload=None, timeout=20):
        calls.append(1)
        raise cloud.CloudError(0, "unreachable")

    monkeypatch.setattr(cloud, "_request", _fake_request)
    with pytest.raises(cloud.CloudError):
        cloud.login("alice", "pwd", "standalone", timeout=4, retries=0)
    assert len(calls) == 1


# ------------------------------------------------------- 退出登录不阻塞

def test_logout_returns_before_server_notification_finishes(monkeypatch):
    """桌面端退出登录：通知服务器是跨公网 HTTP，端点必须在它完成前就返回。

    前端又依赖「返回后才清登录态」，这里把通知人为拖到 3 秒；端点应在 1.5s 内
    返回（通知在后台线程尽力而为，失败由会话心跳过期兜底）。
    """
    from app.api.v1.endpoints import auth as auth_endpoint
    from app.api.v1.endpoints import desktop_local
    from app.core.config import settings

    monkeypatch.setattr(settings, "NPT_DESKTOP", True)

    entered = threading.Event()

    def _slow_notify():
        entered.set()
        time.sleep(3)

    monkeypatch.setattr(desktop_local, "notify_server_logout", _slow_notify)
    monkeypatch.setattr(
        auth_endpoint.auth_service, "end_session", lambda db, jti: None
    )

    app = FastAPI()
    app.include_router(auth_endpoint.router, prefix="/api/v1/auth")
    app.dependency_overrides[get_current_user] = lambda: object()
    app.dependency_overrides[get_token_jti] = lambda: "jti-1"
    app.dependency_overrides[get_db] = lambda: None
    client = TestClient(app)

    started = time.monotonic()
    resp = client.post("/api/v1/auth/logout")
    elapsed = time.monotonic() - started

    assert resp.status_code == 200, resp.text
    assert elapsed < 1.5, f"退出登录被服务器通知阻塞了 {elapsed:.2f}s"
    # 后台通知确实被调度了（给线程一点启动时间）
    assert entered.wait(timeout=1.0)
