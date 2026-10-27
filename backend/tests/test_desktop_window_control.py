"""frameless 自绘标题栏的窗口控制：壳层 handler 语义 + 桥接行为。

桌面端窗口去掉了原生边框（launcher._create_window 的 frameless=True），
最小化/最大化/关闭/边缘缩放由前端标题栏按钮经 POST /desktop/window-control 进来，
最终落到 launcher._make_window_control_handler(window, state, min_size)。

本文件覆盖 handler 的动作语义（按缓存选 maximize/restore、resize clamp、close 走
destroy 且不复用退出看门狗）与 state 事件的缓存收敛；端点转发见
tests/test_desktop_local_endpoints.py。
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace


def _load_launcher():
    """按路径加载 desktop/launcher.py（CI 从 backend/ 目录跑 pytest，模块不在 sys.path 上）。"""
    path = Path(__file__).resolve().parents[2] / "desktop" / "launcher.py"
    spec = importlib.util.spec_from_file_location("desktop_launcher_window_control", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _FakeEvent:
    """模拟 pywebview Event：支持 `+=` 订阅与 set() 广播（与 winforms on_resize 用法一致）。"""

    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self

    def set(self):
        for handler in self.handlers:
            handler()


class _FakeWindow:
    def __init__(self, destroy_error: bool = False):
        self.calls = []
        self._destroy_error = destroy_error
        self.events = SimpleNamespace(
            maximized=_FakeEvent(),
            restored=_FakeEvent(),
        )

    def minimize(self):
        self.calls.append("minimize")

    def maximize(self):
        self.calls.append("maximize")

    def restore(self):
        self.calls.append("restore")

    def destroy(self):
        self.calls.append("destroy")
        if self._destroy_error:
            raise RuntimeError("gui not ready")

    def resize(self, width, height):
        self.calls.append(("resize", width, height))


def _make_handler(launcher, window, state=None, min_size=(1024, 680)):
    if state is None:
        state = {"fullscreen": False, "maximized": True}
    return launcher._make_window_control_handler(window, state, min_size), state


def test_toggle_maximize_uses_state_cache():
    """启动即最大化：第一次点击必须走 restore，第二次走 maximize，且返回值同步前端。"""
    launcher = _load_launcher()
    window = _FakeWindow()
    handler, _ = _make_handler(launcher, window)

    assert handler("toggle-maximize", {}) == {"maximized": False}
    assert window.calls == ["restore"]

    assert handler("toggle-maximize", {}) == {"maximized": True}
    assert window.calls == ["restore", "maximize"]


def test_toggle_maximize_limits_borderless_window_to_work_area(monkeypatch):
    """无边框窗口最大化默认会盖住任务栏：还原时清限制、最大化前按工作区收口。"""
    launcher = _load_launcher()
    window = _FakeWindow()
    limited: list[bool] = []
    monkeypatch.setattr(
        launcher,
        "_limit_maximized_to_work_area",
        lambda _window, enable: limited.append(enable),
    )
    handler, _ = _make_handler(launcher, window)

    handler("toggle-maximize", {})
    assert limited == [False]  # 启动即最大化 → 还原并清掉工作区限制

    handler("toggle-maximize", {})
    assert limited == [False, True]  # 最大化前先按工作区收口
    assert window.calls == ["restore", "maximize"]


def test_state_events_converge_cache():
    """Win+↑/↓、任务栏还原等系统路径触发 maximized/restored 事件 → 缓存自然收敛。"""
    launcher = _load_launcher()
    window = _FakeWindow()
    handler, state = _make_handler(launcher, window)

    # 模拟用户从最大化还原（launcher 缓存还以为是 True）
    state["maximized"] = True
    window.events.restored.set()
    assert handler("state", {}) == {"maximized": False, "fullscreen": False}

    window.events.maximized.set()
    assert handler("state", {})["maximized"] is True


def test_resize_clamps_min_size():
    """resize 走裸 SetWindowPos、绕过 WinForms MinimumSize → 壳层必须自己 clamp。"""
    launcher = _load_launcher()
    window = _FakeWindow()
    handler, _ = _make_handler(launcher, window, min_size=(1024, 680))

    handler("resize", {"width": 800, "height": 900})
    assert ("resize", 1024, 900) in window.calls

    handler("resize", {"width": 1600, "height": 500})
    assert ("resize", 1600, 680) in window.calls


def test_close_destroys_without_force_exit():
    """close 走 destroy()（触发 events.closing 保留后台更新例外），不武装退出看门狗。"""
    launcher = _load_launcher()
    window = _FakeWindow()
    handler, _ = _make_handler(launcher, window)

    watchdog_calls = []
    launcher._force_exit_after = lambda delay: watchdog_calls.append(delay)
    handler("close", {})
    assert window.calls == ["destroy"]
    assert watchdog_calls == []


def test_close_falls_back_to_force_exit_on_error():
    launcher = _load_launcher()
    window = _FakeWindow(destroy_error=True)
    handler, _ = _make_handler(launcher, window)

    watchdog_calls = []
    launcher._force_exit_after = lambda delay: watchdog_calls.append(delay)
    handler("close", {})
    assert watchdog_calls == [2]


def test_fullscreen_handler_shares_state_with_window_control():
    """全屏与窗口控制共享状态 dict：state 动作要能同时报 maximized/fullscreen。"""
    launcher = _load_launcher()
    window = _FakeWindow()
    window.toggle_fullscreen = lambda: window.calls.append("toggle_fullscreen")
    window.maximize = lambda: window.calls.append("maximize")
    state = {"fullscreen": False, "maximized": True}
    fullscreen_handler = launcher._make_fullscreen_handler(window, state)
    control_handler, _ = _make_handler(launcher, window, state)

    fullscreen_handler(True)
    assert control_handler("state", {}) == {"maximized": True, "fullscreen": True}

    fullscreen_handler(False)
    assert control_handler("state", {})["fullscreen"] is False
    # 退出全屏补 maximize：共享 state 直接同步缓存，不等 on_resize 事件
    assert state["maximized"] is True


def test_bridge_without_shell_returns_none():
    from app import desktop_bridge

    desktop_bridge.set_window_control_handler(None)
    assert desktop_bridge.control_window("minimize") is None
    assert desktop_bridge.control_window("state") is None


def test_bridge_forwards_and_swallows_errors():
    from app import desktop_bridge

    seen: list = []
    desktop_bridge.set_window_control_handler(
        lambda action, params: seen.append((action, params)) or {"ok": True}
    )
    try:
        assert desktop_bridge.control_window("resize", {"width": 100}) == {"ok": True}
        assert seen == [("resize", {"width": 100})]
    finally:
        desktop_bridge.set_window_control_handler(None)

    def boom(_action, _params):
        raise RuntimeError("gui not ready")

    desktop_bridge.set_window_control_handler(boom)
    try:
        # 壳层异常不能让接口 500：按"不支持"处理，端点回 403
        assert desktop_bridge.control_window("minimize") is None
    finally:
        desktop_bridge.set_window_control_handler(None)
