"""桌面客户端 OTA 下载测试：断点续传 / sha256 校验 / 稍后计数 / 安装前置条件。

用标准库起一个支持 Range 的本地 HTTP 服务当"授权服务器"，验证下载 worker 的真实行为。
"""
from __future__ import annotations

import hashlib
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

import pytest

PAYLOAD = bytes(range(256)) * 80  # 20480 字节
SHA = hashlib.sha256(PAYLOAD).hexdigest()


class _RangeHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        range_header = self.headers.get("Range")
        if range_header:
            match = re.match(r"bytes=(\d+)-", range_header)
            start = int(match.group(1)) if match else 0
            body = PAYLOAD[start:]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(PAYLOAD) - 1}/{len(PAYLOAD)}")
        else:
            body = PAYLOAD
            self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # 静默
        pass


@pytest.fixture()
def updater_env(tmp_path, monkeypatch):
    from app.core.config import settings
    from app.services import desktop_update_service as updater

    server = HTTPServer(("127.0.0.1", 0), _RangeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    monkeypatch.setattr(settings, "DATA_ROOT", tmp_path)
    monkeypatch.setattr(settings, "LICENSE_DIR", tmp_path)
    monkeypatch.setattr(settings, "NPT_SERVER_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setattr(settings, "NPT_DESKTOP_VERSION", "0.0.0-dev-old")
    monkeypatch.setattr(settings, "NPT_DESKTOP_CHANNEL", "stable")
    monkeypatch.setattr(settings, "NPT_DESKTOP_MAX_SNOOZE", 3)

    updater._state.update(
        phase="idle", version=None, downloaded=0, total=0, error=None, installer=None, sha256=None
    )

    yield SimpleNamespace(updater=updater, tmp_path=tmp_path, settings=settings)
    server.shutdown()


def _release(**overrides):
    data = {
        "version": "1.0.0",
        "sha256": SHA,
        "file_size": len(PAYLOAD),
        "download_url": "/api/v1/desktop-cloud/releases/download/1",
        "mandatory": False,
    }
    data.update(overrides)
    return data


def _wait_ready(updater, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = updater.progress()
        if state["phase"] in ("ready", "failed"):
            return state
        time.sleep(0.1)
    return updater.progress()


def test_download_happy_path(updater_env):
    updater = updater_env.updater
    updater.start_download(_release())
    state = _wait_ready(updater)
    assert state["phase"] == "ready", state
    assert state["error"] is None
    installer = updater_env.tmp_path / "updates" / "NetworkPlanningTool-Setup-1.0.0.exe"
    assert installer.read_bytes() == PAYLOAD
    assert state["downloaded"] == len(PAYLOAD)


def test_download_resumes_from_part(updater_env):
    updater = updater_env.updater
    part = updater_env.tmp_path / "updates" / "NetworkPlanningTool-Setup-1.0.0.exe.part"
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(PAYLOAD[:1000])  # 模拟上次中断留下的分片

    updater.start_download(_release())
    state = _wait_ready(updater)
    assert state["phase"] == "ready", state
    installer = updater_env.tmp_path / "updates" / "NetworkPlanningTool-Setup-1.0.0.exe"
    assert installer.read_bytes() == PAYLOAD  # 续传后内容完整


def test_download_sha_mismatch_fails(updater_env):
    updater = updater_env.updater
    updater.start_download(_release(sha256="0" * 64))
    state = _wait_ready(updater)
    assert state["phase"] == "failed"
    assert "校验失败" in (state["error"] or "")


def test_snooze_forces_after_limit(updater_env):
    updater = updater_env.updater
    assert updater.snooze_state("1.0.0")["count"] == 0
    for expected in (1, 2):
        result = updater.snooze("1.0.0")
        assert result["count"] == expected and result["force"] is False
    result = updater.snooze("1.0.0")
    assert result["count"] == 3 and result["force"] is True
    # 不同版本独立计数
    assert updater.snooze_state("1.1.0")["count"] == 0


def test_install_requires_ready_package(updater_env):
    updater = updater_env.updater
    from app.services.desktop_cloud_client import CloudError

    with pytest.raises(CloudError) as excinfo:
        updater.install_and_exit()
    assert excinfo.value.status_code == 409


def test_install_on_non_windows_rejected(updater_env):
    """Linux 上出现"ready"也应拒绝自动安装（仅 Windows 桌面版支持）。"""
    import os

    if os.name == "nt":
        pytest.skip("仅在非 Windows 环境验证")
    updater = updater_env.updater
    item = updater_env.tmp_path / "updates" / "fake.exe"
    item.parent.mkdir(parents=True, exist_ok=True)
    item.write_bytes(PAYLOAD)
    updater._state.update(phase="ready", installer=str(item), sha256=SHA)

    from app.services.desktop_cloud_client import CloudError

    with pytest.raises(CloudError) as excinfo:
        updater.install_and_exit()
    assert excinfo.value.status_code == 400
