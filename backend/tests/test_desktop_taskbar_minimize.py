"""无边框窗口的任务栏最小化样式位。

frameless 窗口（WinForms FormBorderStyle.None）没有原生标题栏，样式里也没有最小化/最大化
箱位，任务栏图标点击发来的 WM_SYSCOMMAND(SC_MINIMIZE) 被系统丢弃 → 点图标没反应。
launcher._enable_taskbar_minimize 负责补回 WS_MINIMIZEBOX/WS_MAXIMIZEBOX/WS_SYSMENU。

本文件用假的 ctypes / 窗体验证样式位语义（Linux CI 上不能真调 user32）。
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace

WS_POPUP = 0x80000000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_SYSMENU = 0x00080000


def _load_launcher():
    path = Path(__file__).resolve().parents[2] / "desktop" / "launcher.py"
    spec = importlib.util.spec_from_file_location("desktop_launcher_taskbar", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _FakeUser32:
    """只实现 Get/SetWindowLongW 的 user32 替身（记录写入的样式位）。"""

    def __init__(self, style: int):
        self.style = style
        self.set_calls: list[int] = []

        def _get(hwnd, index):
            return self.style

        def _set(hwnd, index, value):
            self.set_calls.append(value)
            self.style = value
            return value

        # 实例属性存函数对象：函数可被赋 restype/argtypes，绑定方法不行
        self.GetWindowLongW = _get
        self.SetWindowLongW = _set


class _FakeCtypes:
    """ctypes 替身：WinDLL 返回同一个假 user32。"""

    c_void_p = staticmethod(lambda value=None: value)
    c_int = int
    c_long = int

    def __init__(self, user32: _FakeUser32):
        self._user32 = user32
        self.windll_calls = 0

    def WinDLL(self, *args, **kwargs):
        self.windll_calls += 1
        return self._user32


def _fake_window(handle: int | None = 0x1234, native: bool = True):
    if not native:
        return SimpleNamespace(native=None)
    return SimpleNamespace(native=SimpleNamespace(Handle=SimpleNamespace(ToInt64=lambda: handle)))


def _patch(monkeypatch, launcher, style: int, platform: str = "nt"):
    user32 = _FakeUser32(style)
    fake_ctypes = _FakeCtypes(user32)
    monkeypatch.setattr(launcher, "os", SimpleNamespace(name=platform))
    monkeypatch.setattr(launcher, "ctypes", fake_ctypes)
    return user32, fake_ctypes


def test_adds_minimize_and_maximize_style_bits(monkeypatch):
    """WS_POPUP 的无边框窗口：补上最小化/最大化/系统菜单位。"""
    launcher = _load_launcher()
    user32, _ = _patch(monkeypatch, launcher, WS_POPUP)

    launcher._enable_taskbar_minimize(_fake_window())

    assert user32.set_calls == [WS_POPUP | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU]


def test_idempotent_when_bits_already_present(monkeypatch):
    """样式位已在时不重复 SetWindowLongW（全屏切换后会再调一次）。"""
    launcher = _load_launcher()
    full = WS_POPUP | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU
    user32, _ = _patch(monkeypatch, launcher, full)

    launcher._enable_taskbar_minimize(_fake_window())

    assert user32.set_calls == []


def test_skips_without_native_window(monkeypatch):
    """窗体尚未就绪（native=None，如 webview.start 的 func 线程早于建窗）静默跳过。"""
    launcher = _load_launcher()
    user32, fake_ctypes = _patch(monkeypatch, launcher, WS_POPUP)

    launcher._enable_taskbar_minimize(_fake_window(native=False))

    assert fake_ctypes.windll_calls == 0
    assert user32.set_calls == []


def test_skips_off_windows(monkeypatch):
    """非 Windows 不碰样式（本地调试/测试环境）。"""
    launcher = _load_launcher()
    user32, fake_ctypes = _patch(monkeypatch, launcher, WS_POPUP, platform="posix")

    launcher._enable_taskbar_minimize(_fake_window())

    assert fake_ctypes.windll_calls == 0
    assert user32.set_calls == []
