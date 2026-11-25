"""IM 实时链路的异步治理回归：并发广播、短超时 relay、来源 IP 归一化。"""
from __future__ import annotations

import base64
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


def test_forward_fails_fast_when_relay_slots_exhausted(monkeypatch):
    """慢 relay 不能无限堆积：名额占满时立刻 503，把连接/线程留给窗口控制请求。

    桌面共享模式 1.5s 轮询 + 12s×2 慢 relay 曾把线程池与 WebView2 6 条连接打满，
    用户表现为「打开项目沟通后点最小化/最大化几十秒没反应」。
    """
    import threading

    from app.services import im_desktop_proxy as proxy

    monkeypatch.setattr(proxy, "_relay_slots", threading.BoundedSemaphore(1))
    assert proxy._relay_slots.acquire(blocking=False)
    try:
        with pytest.raises(HTTPException) as exc:
            proxy.forward("list_conversations", {})
        assert exc.value.status_code == 503
        assert "IM_RELAY_BUSY:list_conversations" in str(exc.value.detail)
    finally:
        proxy._relay_slots.release()


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


def test_fetch_signed_attachment_uses_binary_get(monkeypatch):
    """签名直链拿到的是图片字节，不再 base64 塞在 JSON 里。"""
    from app.services import im_desktop_proxy as proxy

    monkeypatch.setattr(proxy, "server_url", lambda: "https://app.pengwc.asia")
    calls = []

    class _Client:
        def get(self, url, **kwargs):
            calls.append((url, kwargs))
            return httpx.Response(
                200, content=b"\x89PNGDATA",
                headers={"Content-Type": "image/png",
                         "Content-Disposition": "inline; filename*=UTF-8''%E7%85%A7%E7%89%87.png"},
            )

    monkeypatch.setattr(proxy, "_get_client", lambda: _Client())
    content, mime, filename = proxy.fetch_signed_attachment({
        "token": "123.3.abc", "path": "/api/v1/im/attachments/signed/7", "thumb": False,
    })
    assert content == b"\x89PNGDATA" and mime == "image/png" and filename == "照片.png"
    assert calls[0][0].startswith("https://app.pengwc.asia/api/v1/im/attachments/signed/7?token=")
    assert calls[0][1]["timeout"] == proxy.RELAY_ATTACHMENT_TIMEOUT_SECONDS


def test_shared_attachment_bytes_falls_back_to_legacy(monkeypatch):
    """老生产后端不认识 attachment_urls：自动退回 base64 relay，不让图片空白。"""
    from fastapi import HTTPException

    from app.api.v1.endpoints import im as im_endpoint

    calls = []

    def _fake_run(op, args, db, user, limit=60):
        calls.append(op)
        if op == "attachment_urls":
            raise HTTPException(status_code=404, detail="IM_UNKNOWN_OP")
        return {"content_b64": base64.b64encode(b"legacy").decode(),
                "mime": "image/png", "filename": "old.png"}

    monkeypatch.setattr(im_endpoint, "_run", _fake_run)
    # 本机可能已有真实缓存，隔离掉后端本地 LRU 才能验证回退链路
    monkeypatch.setattr(
        im_endpoint.im_attachment_service, "read_remote_cache", lambda *args: None)
    monkeypatch.setattr(
        im_endpoint.im_attachment_service, "write_remote_cache", lambda *args: None)
    content, mime, filename = im_endpoint._shared_attachment_bytes(
        7, False, object(), SimpleNamespace(id=3))
    assert content == b"legacy" and mime == "image/png" and filename == "old.png"
    assert calls == ["attachment_urls", "attachment_download"]


def test_relay_client_ip_prefers_cf_connecting_ip():
    from app.api.v1.endpoints import desktop_cloud

    request = SimpleNamespace(
        headers={"cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9"},
        client=SimpleNamespace(host="127.0.0.1"),
    )
    assert desktop_cloud._client_ip(request) == "1.2.3.4"
