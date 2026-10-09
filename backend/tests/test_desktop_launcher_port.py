"""桌面端本机端口必须稳定：端口决定 WebView2 的 origin，随机端口会清空 localStorage。

现象（2026-10-10 用户报「系统设置应用后无法保存配置」）：语言、主题、登录态等
都写在 localStorage 里，而 localStorage 按 scheme+host+port 隔离；启动器每次
绑定随机端口 → 每次启动都是新 origin → 设置永远保存不住。
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path


def _load_launcher():
    """按路径加载 desktop/launcher.py（CI 从 backend/ 目录跑 pytest，模块不在 sys.path 上）。"""
    path = Path(__file__).resolve().parents[2] / "desktop" / "launcher.py"
    spec = importlib.util.spec_from_file_location("desktop_launcher_port", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_bound_port_is_stable_across_restarts(tmp_path):
    launcher = _load_launcher()

    sock, port = launcher._create_bound_socket(tmp_path)
    sock.close()
    saved = json.loads((tmp_path / launcher.PORT_STATE_FILE).read_text(encoding="utf-8"))

    # 端口写入状态文件，供下次启动复用
    assert saved["port"] == port

    # 重启：优先复用上次端口（origin 不变 → 本地设置保留）
    sock2, port2 = launcher._create_bound_socket(tmp_path)
    sock2.close()
    assert port2 == port


def test_saved_port_file_is_ignored_when_corrupt(tmp_path):
    launcher = _load_launcher()
    (tmp_path / launcher.PORT_STATE_FILE).write_text("not-json", encoding="utf-8")

    sock, port = launcher._create_bound_socket(tmp_path)
    sock.close()
    assert port > 0
