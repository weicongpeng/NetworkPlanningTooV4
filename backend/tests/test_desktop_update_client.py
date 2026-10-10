"""桌面客户端 OTA 下载测试：断点续传 / sha256 校验 / 稍后计数 / 安装前置条件。

用标准库起一个支持 Range 的本地 HTTP 服务当"授权服务器"，验证下载 worker 的真实行为。
"""
from __future__ import annotations

import hashlib
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
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

    updater._state.update(
        phase="idle", version=None, downloaded=0, total=0, error=None, installer=None, sha256=None,
        background=False,
    )
    updater._install_started = False

    yield SimpleNamespace(updater=updater, tmp_path=tmp_path, settings=settings)
    server.shutdown()


def _release(**overrides):
    data = {
        "version": "1.0.0",
        "sha256": SHA,
        "file_size": len(PAYLOAD),
        "download_url": "/api/v1/desktop-cloud/releases/download/1",
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


def test_check_latest_offline_raises_only_when_asked(updater_env):
    """手动检查更新要能区分「已是最新」与「连不上服务器」。"""
    from app.services.desktop_cloud_client import CloudError

    # 假服务器不接受该路径（返回非 JSON）→ 默认静默 None，显式要求时抛错
    assert updater_env.updater.check_latest() is None
    with pytest.raises(CloudError):
        updater_env.updater.check_latest(raise_on_error=True)


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


def test_helper_script_bounded_wait_and_relaunch(updater_env):
    """升级脚本：等待应用退出必须有上限并强杀兜底，且不能依赖 timeout（隐藏控制台下会报错）。"""
    updater = updater_env.updater
    installer = updater_env.tmp_path / "updates" / "NetworkPlanningTool-Setup-1.0.0.exe"
    installer.parent.mkdir(parents=True, exist_ok=True)
    installer.write_bytes(PAYLOAD)

    helper = updater._write_helper(installer, "1.0.0")
    text = helper.read_text(encoding="utf-8")

    assert helper.parent == updater_env.tmp_path / "updates"
    # 静默安装 + 安装后重新启动应用
    assert "/VERYSILENT" in text and "/SUPPRESSMSGBOXES" in text
    assert 'start "" "%TARGET%"' in text
    # 先按当前运行目录安装（否则会把新版本装到别处、重启旧目录的 exe → "版本没变"）
    assert '/DIR="%APPDIR%"' in text
    # /DIR 失败要退回默认目录重试一次，重启优先选安装目录（再退回默认目录/旧路径）
    assert text.count("start /wait") >= 2
    assert "%DEFAULTDIR%" in text
    # 安装器退出码写盘，应用重启后据此提示"更新未生效"
    assert "setup_rc=%RC%" in text
    assert "npt_ota_result" in text
    # 安装包路径按 8.3 短路径写入（见 _write_helper 注释，规避中文/代码页问题）；
    # Windows 上 GetShortPathNameW 会真的缩写，断言必须用同一转换，否则只有 Linux 过
    assert updater._windows_short_path(installer) in text
    # 等待应用退出的上限与 taskkill 兜底（否则应用不退出安装会永久卡住）
    assert f"GEQ {updater.EXIT_WAIT_SECONDS}" in text
    assert "taskkill /F /IM" in text
    # 计时不能用 timeout：无控制台环境下它直接报错，会退化成忙循环
    assert "timeout /t" not in text
    assert "ping -n 3 127.0.0.1" in text


def test_install_spawns_hidden_helper_and_requests_exit(updater_env, monkeypatch):
    """安装流程：隐藏拉起升级脚本（CREATE_NO_WINDOW）→ 请求退出；重复触发被拒绝。"""
    from types import SimpleNamespace

    updater = updater_env.updater
    installer = updater_env.tmp_path / "updates" / "NetworkPlanningTool-Setup-1.0.0.exe"
    installer.parent.mkdir(parents=True, exist_ok=True)
    installer.write_bytes(PAYLOAD)
    updater._state.update(phase="ready", installer=str(installer), sha256=SHA)

    calls: list = []
    create_no_window = 0x08000000
    # 只在 updater 模块内替换 os/subprocess（避免影响 pathlib、真实进程调用）
    monkeypatch.setattr(updater, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(
        updater,
        "subprocess",
        SimpleNamespace(
            Popen=lambda args, **kwargs: calls.append((args, kwargs)),
            CREATE_NO_WINDOW=create_no_window,
            CREATE_NEW_PROCESS_GROUP=0x00000200,
        ),
    )
    monkeypatch.setattr("app.desktop_bridge.request_exit", lambda: True)

    result = updater.install_and_exit()
    assert result["exiting"] is True
    assert calls[0][0][:2] == ["cmd", "/c"]
    assert calls[0][1]["creationflags"] & create_no_window  # 隐藏窗口，不弹终端
    assert Path(calls[0][0][2]).is_file()

    # 已启动过升级脚本，重复调用只返回 409（避免两个安装器同时跑）
    from app.services.desktop_cloud_client import CloudError

    with pytest.raises(CloudError) as excinfo:
        updater.install_and_exit()
    assert excinfo.value.status_code == 409
    assert len(calls) == 1


def test_install_requests_exit_even_without_bridge(updater_env, monkeypatch):
    """桌面壳未注入回调（request_exit False）时仍要返回提示，由升级脚本强杀兜底完成安装。"""
    from types import SimpleNamespace

    updater = updater_env.updater
    installer = updater_env.tmp_path / "updates" / "NetworkPlanningTool-Setup-1.0.0.exe"
    installer.parent.mkdir(parents=True, exist_ok=True)
    installer.write_bytes(PAYLOAD)
    updater._state.update(phase="ready", installer=str(installer), sha256=SHA)

    monkeypatch.setattr(updater, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(
        updater,
        "subprocess",
        SimpleNamespace(
            Popen=lambda *a, **k: None,
            CREATE_NO_WINDOW=0x08000000,
            CREATE_NEW_PROCESS_GROUP=0x00000200,
        ),
    )
    monkeypatch.setattr("app.desktop_bridge.request_exit", lambda: False)

    result = updater.install_and_exit()
    assert result["exiting"] is False
    assert "安装" in result["message"]


def _load_launcher():
    """按路径加载 desktop/launcher.py（CI 从 backend/ 目录跑 pytest，模块不在 sys.path 上）。"""
    import importlib.util

    path = Path(__file__).resolve().parents[2] / "desktop" / "launcher.py"
    spec = importlib.util.spec_from_file_location("desktop_launcher", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _stub_exit_side_effects(launcher, monkeypatch) -> list:
    """替换 os._exit 与看门狗线程，记录强制退出调用。"""
    from types import SimpleNamespace

    exits: list = []
    thread_stub = SimpleNamespace(Thread=lambda **kwargs: SimpleNamespace(start=lambda: None))
    monkeypatch.setattr(launcher, "os", SimpleNamespace(_exit=exits.append))
    monkeypatch.setattr(launcher, "threading", thread_stub)
    return exits


def test_launcher_force_exits_when_destroy_fails(monkeypatch):
    """场景：window.destroy() 抛异常（跨线程/后端异常）——必须立刻强制退出，否则 OTA 永远卡在等待应用退出。"""
    launcher = _load_launcher()
    exits = _stub_exit_side_effects(launcher, monkeypatch)

    def _broken_destroy():
        raise RuntimeError("cross-thread operation not valid")

    launcher._make_exit_handler(SimpleNamespace(destroy=_broken_destroy))()
    assert exits == [0]


def test_launcher_arms_watchdog_before_destroy(monkeypatch):
    """场景：window.destroy() 永久阻塞——看门狗必须在 destroy 之前武装，否则进程永不退出。"""
    launcher = _load_launcher()
    exits = _stub_exit_side_effects(launcher, monkeypatch)

    started: list = []
    monkeypatch.setattr(launcher, "_force_exit_after", started.append)

    def _blocking_destroy():
        assert started, "destroy 之前必须已武装强制退出看门狗"

    launcher._make_exit_handler(SimpleNamespace(destroy=_blocking_destroy))()
    assert started == [launcher.EXIT_GRACE_SECONDS]
    assert exits == []  # 正常提交关窗时不强制退出


# --------------------------------------------------- 后台运行（关窗不影响更新）
#
# 2026-10-10 用户要求：更新弹窗加「后台运行」，关掉窗口也不中断下载与安装。

def test_arm_background_writes_marker_and_installs_on_wait(updater_env, monkeypatch):
    """「后台运行」：置位 + 写标记文件；后台等待到 ready 后拉起安装并清标记。"""
    updater = updater_env.updater
    installer = updater_env.tmp_path / "updates" / "NetworkPlanningTool-Setup-1.0.0.exe"
    installer.parent.mkdir(parents=True, exist_ok=True)
    installer.write_bytes(PAYLOAD)
    updater._state.update(phase="ready", version="1.0.0", installer=str(installer), sha256=SHA)

    state = updater.arm_background()
    assert state["background"] is True
    marker = updater_env.tmp_path / "updates" / "background_update.json"
    assert marker.is_file()
    assert updater.is_background_armed() is True

    started: list = []
    monkeypatch.setattr(updater, "_start_installer", lambda: started.append(True) or installer)
    result = updater.wait_background_update(poll_seconds=0.1, timeout_seconds=5)

    assert result["action"] == "install"
    assert started == [True]
    assert not marker.exists()


def test_arm_background_rejects_when_no_update(updater_env, monkeypatch):
    """没有新版本时拒绝转入后台（避免用户以为在更新，实际什么都没发生）。"""
    from app.services.desktop_cloud_client import CloudError

    updater = updater_env.updater
    monkeypatch.setattr(updater, "check_latest", lambda **_: None)
    with pytest.raises(CloudError) as excinfo:
        updater.arm_background()
    assert excinfo.value.status_code == 409


def test_last_result_flags_unapplied_install(updater_env, monkeypatch):
    """安装器退出码非 0 / 版本没变 → applied=False、needs_manual=True（前端给人工安装提示）。"""
    import json

    updater = updater_env.updater
    updates = updater_env.tmp_path / "updates"
    updates.mkdir(parents=True, exist_ok=True)
    (updates / "npt_ota_intent.json").write_text(
        json.dumps({"target_version": "1.0.0", "installer": "/tmp/setup.exe"}), encoding="utf-8"
    )
    (updates / "npt_ota_result.txt").write_text(
        "target_version=1.0.0\nsetup_rc=5\nsetup_retry_rc=5\nfinished_at=2026-10-10 10:00:00\n",
        encoding="utf-8",
    )
    result = updater.last_result()
    assert result["target_version"] == "1.0.0"
    assert result["setup_rc"] == "5"
    assert result["applied"] is False
    assert result["needs_manual"] is True

    # 装成功（当前版本已变成目标版本）→ 不再提示人工安装
    monkeypatch.setattr(updater_env.settings, "NPT_DESKTOP_VERSION", "1.0.0")
    (updates / "npt_ota_result.txt").write_text("target_version=1.0.0\nsetup_rc=0\n", encoding="utf-8")
    result = updater.last_result()
    assert result["applied"] is True
    assert result["needs_manual"] is False


def test_launcher_continues_background_update_after_window_close(monkeypatch, tmp_path):
    """启动器：窗口关闭后若已武装后台更新，必须先等它跑完再收尾退出。"""
    launcher = _load_launcher()
    calls: list = []

    import sys
    import types

    fake_service = types.ModuleType("app.services.desktop_update_service")
    fake_service.is_background_armed = lambda: True
    fake_service.wait_background_update = lambda: calls.append("waited") or {"action": "install"}
    # 包属性优先于 sys.modules：两处都替换，否则 from app.services import ... 会拿到真实模块
    import app.services as services_pkg

    monkeypatch.setitem(sys.modules, "app.services.desktop_update_service", fake_service)
    monkeypatch.setattr(services_pkg, "desktop_update_service", fake_service, raising=False)

    launcher._continue_background_update()
    assert calls == ["waited"]

    # 未武装时直接返回，不阻塞关闭流程
    calls.clear()
    fake_service.is_background_armed = lambda: False
    launcher._continue_background_update()
    assert calls == []


def test_launcher_background_marker_detection(tmp_path):
    """重复启动时以标记文件提示"后台更新中"（避免第二实例被 taskkill 兜底误杀）。"""
    launcher = _load_launcher()
    assert launcher._background_update_marker_exists(tmp_path) is False
    updates = tmp_path / "updates"
    updates.mkdir(parents=True, exist_ok=True)
    (updates / "background_update.json").write_text("{}", encoding="utf-8")
    assert launcher._background_update_marker_exists(tmp_path) is True
