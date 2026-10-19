"""桌面端地图「全屏」：必须让主窗口真全屏（覆盖整个电脑屏幕）。

WebView2 里的 HTML Fullscreen API 只会让网页内容占满 WebView 自身，窗口（含标题栏）
不变，所以桌面形态必须由壳层切换窗口全屏：前端 POST /desktop/fullscreen →
desktop_bridge.set_window_fullscreen() → launcher._make_fullscreen_handler(window)。

本文件覆盖壳层处理器语义（幂等 / 退出后回到最大化）与桥接的无回调行为；
端点转发见 tests/test_desktop_local_endpoints.py。
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace


def _load_launcher():
    """按路径加载 desktop/launcher.py（CI 从 backend/ 目录跑 pytest，模块不在 sys.path 上）。"""
    path = Path(__file__).resolve().parents[2] / "desktop" / "launcher.py"
    spec = importlib.util.spec_from_file_location("desktop_launcher_fullscreen", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _FakeWindow:
    """记录 toggle_fullscreen / maximize 调用次数的假窗口。"""

    def __init__(self):
        self.toggles = 0
        self.maximizes = 0

    def toggle_fullscreen(self):
        self.toggles += 1

    def maximize(self):
        self.maximizes += 1


def test_fullscreen_handler_enters_and_leaves_window_fullscreen():
    launcher = _load_launcher()
    window = _FakeWindow()
    handler = launcher._make_fullscreen_handler(window)

    handler(True)
    assert window.toggles == 1  # 进入全屏
    assert window.maximizes == 0  # 进入时不动窗口状态

    handler(False)
    assert window.toggles == 2  # 退出全屏
    # 退出后补一次最大化：pywebview 的退出分支会把窗口置为 Normal + 进入前的尺寸，
    # 不补 maximize 就回不到启动时的最大化窗口
    assert window.maximizes == 1


def test_fullscreen_handler_is_idempotent():
    """pywebview 只有 toggle_fullscreen()、没有状态查询，重复请求同一状态不能来回翻转。"""
    launcher = _load_launcher()
    window = _FakeWindow()
    handler = launcher._make_fullscreen_handler(window)

    handler(True)
    handler(True)
    handler(True)
    assert window.toggles == 1

    handler(False)
    handler(False)
    assert window.toggles == 2
    assert window.maximizes == 1


def test_bridge_without_shell_returns_false():
    """非桌面壳（未注入回调，含网页端/服务器）必须返回 False，端点据此回 403。"""
    from app import desktop_bridge

    desktop_bridge.set_fullscreen_handler(None)
    assert desktop_bridge.set_window_fullscreen(True) is False


def test_bridge_forwards_and_swallows_errors():
    from app import desktop_bridge

    seen: list[bool] = []
    desktop_bridge.set_fullscreen_handler(seen.append)
    try:
        assert desktop_bridge.set_window_fullscreen(True) is True
        assert seen == [True]
    finally:
        desktop_bridge.set_fullscreen_handler(None)

    def boom(_value: bool) -> None:
        raise RuntimeError("gui not ready")

    desktop_bridge.set_fullscreen_handler(boom)
    try:
        # 壳层异常不能让接口 500：按"不支持"处理，前端回退浏览器 Fullscreen API
        assert desktop_bridge.set_window_fullscreen(True) is False
    finally:
        desktop_bridge.set_fullscreen_handler(None)
