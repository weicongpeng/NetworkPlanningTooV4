"""IM 实时链路的异步治理回归：并发广播、短超时 relay、来源 IP 归一化。"""
from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

class _SlowWS:
    async def send_json(self, _message):
        import asyncio

        await asyncio.sleep(5)


class _FastWS:
    def __init__(self):
        self.sent: list = []

    async def send_json(self, message):
        self.sent.append(message)


@pytest.mark.asyncio
async def test_slow_connection_does_not_delay_other_recipients(monkeypatch):
    """串行 await 会让一个慢连接拖住整批；并发 + 超时后快连接立即收到。"""
    from app.services import websocket_manager as wm_module

    manager = wm_module.websocket_manager
    fast = _FastWS()
    monkeypatch.setattr(manager, "connections", {"slow": _SlowWS(), "fast": fast})
    monkeypatch.setattr(manager, "client_authed", {"slow", "fast"})
    monkeypatch.setattr(manager, "client_user_ids", {"slow": 7, "fast": 7})
    monkeypatch.setattr(wm_module, "IM_WS_SEND_TIMEOUT_SECONDS", 0.05)
    disconnected: list = []

    async def _disconnect(client_id):
        disconnected.append(client_id)

    monkeypatch.setattr(manager, "disconnect", _disconnect)
    await manager.send_to_users([7], {"type": "im_message"})
    assert fast.sent == [{"type": "im_message"}]
    assert "slow" in disconnected


@pytest.mark.asyncio
async def test_broadcast_authenticated_uses_same_concurrent_path(monkeypatch):
    from app.services import websocket_manager as wm_module

    manager = wm_module.websocket_manager
    fast = _FastWS()
    monkeypatch.setattr(manager, "connections", {"a": fast, "anon": _FastWS()})
    monkeypatch.setattr(manager, "client_authed", {"a"})
    monkeypatch.setattr(manager, "client_user_ids", {"a": 7})
    await manager.broadcast_authenticated({"type": "im_presence"})
    assert len(fast.sent) == 1


def test_forward_retries_once_on_transport_error(monkeypatch):
    """网络抖动重试一次并复用短超时；不再用 30s 同步 urlopen 占住线程池。"""
    from app.services import im_desktop_proxy as proxy

    monkeypatch.setattr(proxy, "_credentials",
                        lambda: {"license_file": "lic", "machine_code": "MC"})
    monkeypatch.setattr(proxy, "server_url", lambda: "https://example.invalid")
    calls: list = []

    class _FakeClient:
        def post(self, _url, json=None, timeout=None):
            calls.append(timeout)
            if len(calls) == 1:
                raise httpx.ConnectError("boom")
            return httpx.Response(200, json={"success": True, "data": {"ok": 1}})

    monkeypatch.setattr(proxy, "_get_client", lambda: _FakeClient())
    assert proxy.forward("list_conversations", {}) == {"ok": 1}
    assert len(calls) == 2
    assert calls == [proxy.RELAY_TIMEOUT_SECONDS] * 2


def test_forward_fails_fast_on_timeout(monkeypatch):
    from app.services import im_desktop_proxy as proxy

    monkeypatch.setattr(proxy, "_credentials",
                        lambda: {"license_file": "lic", "machine_code": "MC"})
    monkeypatch.setattr(proxy, "server_url", lambda: "https://example.invalid")

    class _AlwaysSlow:
        def post(self, _url, json=None, timeout=None):
            raise httpx.ConnectTimeout("slow")

    monkeypatch.setattr(proxy, "_get_client", lambda: _AlwaysSlow())
    with pytest.raises(HTTPException) as exc:
        proxy.forward("list_messages", {"conversation_id": 7})
    assert exc.value.status_code == 502


def test_forward_maps_client_errors_without_retry(monkeypatch):
    from app.services import im_desktop_proxy as proxy

    monkeypatch.setattr(proxy, "_credentials",
                        lambda: {"license_file": "lic", "machine_code": "MC"})
    monkeypatch.setattr(proxy, "server_url", lambda: "https://example.invalid")
    calls: list = []

    class _Client:
        def post(self, _url, json=None, timeout=None):
            calls.append(1)
            return httpx.Response(429, json={"detail": "IM_RATE_LIMITED"})

    monkeypatch.setattr(proxy, "_get_client", lambda: _Client())
    with pytest.raises(HTTPException) as exc:
        proxy.forward("list_messages", {})
    assert exc.value.status_code == 429
    assert calls == [1]  # 4xx 不重试


def test_relay_client_ip_prefers_cf_connecting_ip():
    from app.api.v1.endpoints import desktop_cloud

    request = SimpleNamespace(
        headers={"cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9"},
        client=SimpleNamespace(host="127.0.0.1"),
    )
    assert desktop_cloud._client_ip(request) == "1.2.3.4"
