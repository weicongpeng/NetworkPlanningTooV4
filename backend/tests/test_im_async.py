"""IM 实时链路的异步治理回归：并发广播、短超时 relay、来源 IP 归一化。"""
from __future__ import annotations

import base64
import time
from pathlib import Path
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


def test_download_job_shared_mode_uses_relay(monkeypatch, tmp_path):
    """共享模式附件在云端：后台下载必须走 relay，不能查本机 ImAttachment。"""
    from app.core.config import settings
    from app.services import im_download_jobs

    calls = []

    def _fake_forward(op, args, timeout=None):
        calls.append(op)
        if op == "attachment_urls":
            return {"tokens": {"9:0": {"token": "t", "path": "/api/v1/im/attachments/signed/9"}}}
        return {"content_b64": base64.b64encode(b"data").decode(),
                "mime": "application/zip", "filename": "x.zip"}

    def _fake_stream(info, target, on_progress):
        target.write_bytes(b"data")
        on_progress(100)
        return "application/zip", "x.zip", 4

    monkeypatch.setattr(settings, "DESKTOP_PROFILE", "shared")
    monkeypatch.setattr(im_download_jobs.im_desktop_proxy, "forward", _fake_forward)
    monkeypatch.setattr(
        im_download_jobs.im_desktop_proxy, "stream_signed_attachment_to_file", _fake_stream)
    monkeypatch.setattr(im_download_jobs.desktop_im_storage,
                        "effective_attachment_dir", lambda: tmp_path / "im")
    monkeypatch.setattr(im_download_jobs, "SessionLocal",
                        lambda: SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(im_download_jobs.desktop_bridge, "reveal_path", lambda path: True)

    im_download_jobs.start(1, 9, "x.zip", reveal=True)
    for _ in range(100):
        result = im_download_jobs.status(1, 9)
        if result["status"] != "running":
            break
        time.sleep(0.01)
    assert result["status"] == "done"
    assert calls[0] == "attachment_urls"
    assert Path(result["path"]).read_bytes() == b"data"


def test_download_job_reuses_saved_file_across_restart(monkeypatch, tmp_path):
    """同一附件再点「在文件夹中显示」：定位上次落盘的文件，不再重复下载 -1 副本。"""
    from app.core.config import settings
    from app.services import im_download_jobs

    calls: list = []
    revealed: list = []

    def _fake_forward(op, args, timeout=None):
        calls.append(op)
        return {"tokens": {"9:0": {"token": "t", "path": "/api/v1/im/attachments/signed/9"}}}

    def _fake_stream(info, target, on_progress):
        target.write_bytes(b"data")
        on_progress(100)
        return "application/zip", "x.zip", 4

    monkeypatch.setattr(settings, "DESKTOP_PROFILE", "shared")
    monkeypatch.setattr(im_download_jobs.im_desktop_proxy, "forward", _fake_forward)
    monkeypatch.setattr(
        im_download_jobs.im_desktop_proxy, "stream_signed_attachment_to_file", _fake_stream)
    monkeypatch.setattr(im_download_jobs.desktop_im_storage,
                        "effective_attachment_dir", lambda: tmp_path / "im")
    monkeypatch.setattr(im_download_jobs, "SessionLocal",
                        lambda: SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(im_download_jobs.desktop_bridge, "reveal_path",
                        lambda path: revealed.append(path) or True)
    monkeypatch.setattr(im_download_jobs, "_jobs", {})
    monkeypatch.setattr(im_download_jobs, "_index_cache", ("", {}))

    def _wait() -> dict:
        state = im_download_jobs.status(1, 9)
        for _ in range(200):
            if state["status"] != "running":
                return state
            time.sleep(0.01)
            state = im_download_jobs.status(1, 9)
        return state

    im_download_jobs.start(1, 9, "x.zip")
    first = _wait()
    assert first["status"] == "done"
    assert revealed == []  # /cache 不再自己弹资源管理器

    # 模拟进程重启：内存任务表与索引缓存都清空，只能靠持久化索引找回
    im_download_jobs._jobs.clear()
    im_download_jobs._index_cache = ("", {})
    resumed = im_download_jobs.start(1, 9, "x.zip")
    assert resumed["status"] == "done" and resumed["path"] == first["path"]
    assert sorted(p.name for p in (tmp_path / "downloads").iterdir()) == ["x.zip"]
    assert calls == ["attachment_urls"]  # 第二次没有重新下载

    result = im_download_jobs.reveal_cached(1, 9)
    assert result["path"] == first["path"] and result["revealed"] is True
    assert revealed == [first["path"]]  # 定位只发生一次


def test_download_job_reuses_existing_same_name_file(monkeypatch, tmp_path):
    """索引丢失（换目录/清缓存）时同名同大小的既有文件仍复用，不再多出 -1 副本。"""
    from app.services import im_download_jobs

    monkeypatch.setattr(im_download_jobs.desktop_im_storage,
                        "effective_attachment_dir", lambda: tmp_path / "im")
    monkeypatch.setattr(im_download_jobs, "_index_cache", ("", {}))

    downloads = tmp_path / "downloads"
    downloads.mkdir()
    existing = downloads / "截图.png"
    existing.write_bytes(b"data")
    part = downloads / "~abc.part"
    part.write_bytes(b"data")

    assert im_download_jobs._finalize(part, existing, 9) == existing
    assert not part.exists()
    assert sorted(item.name for item in downloads.iterdir()) == ["截图.png"]


def test_reveal_prefers_local_remote_cache_without_network(monkeypatch, tmp_path):
    """历史附件的只读副本在本机：定位时直接复制，不向云端重新取字节。"""
    from app.services import im_download_jobs

    revealed: list = []
    forwards: list = []
    monkeypatch.setattr(im_download_jobs.desktop_im_storage,
                        "effective_attachment_dir", lambda: tmp_path / "im")
    monkeypatch.setattr(im_download_jobs.desktop_bridge, "reveal_path",
                        lambda path: revealed.append(path) or True)
    monkeypatch.setattr(im_download_jobs.im_desktop_proxy, "forward",
                        lambda *a, **kw: forwards.append(a))
    monkeypatch.setattr(im_download_jobs, "_jobs", {})
    monkeypatch.setattr(im_download_jobs, "_index_cache", ("", {}))

    folder = tmp_path / "im" / "remote-cache" / "9" / "full"
    folder.mkdir(parents=True)
    (folder / "data.bin").write_bytes(b"cached")
    (folder / "meta.json").write_text('{"mime":"image/png","filename":"本地图.png"}')

    result = im_download_jobs.reveal_cached(1, 9)

    assert result["path"] == str(tmp_path / "downloads" / "本地图.png")
    assert (tmp_path / "downloads" / "本地图.png").read_bytes() == b"cached"
    assert revealed == [result["path"]]  # 只定位一次
    assert forwards == []  # 零公网请求


def test_relay_client_ip_prefers_cf_connecting_ip():
    from app.api.v1.endpoints import desktop_cloud

    request = SimpleNamespace(
        headers={"cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9"},
        client=SimpleNamespace(host="127.0.0.1"),
    )
    assert desktop_cloud._client_ip(request) == "1.2.3.4"
