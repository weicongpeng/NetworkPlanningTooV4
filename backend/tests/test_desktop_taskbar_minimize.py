"""无边框窗口的任务栏最小化样式位。

frameless 窗口（WinForms FormBorderStyle.None）没有原生标题栏，样式里也没有最小化/最大化
箱位，任务栏图标点击发来的 WM_SYSCOMMAND(SC_MINIMIZE) 被系统丢弃 → 点图标没反应。
launcher._enable_taskbar_minimize 负责补回 WS_MINIMIZEBOX/WS_MAXIMIZEBOX/WS_SYSMENU/WS_THICKFRAME。

WS_THICKFRAME 是 Windows 贴边分屏（左右半屏 / 四角四分屏）的前提：系统只对"可缩放"的
窗口做 Snap。补完样式位必须跟一次 SetWindowPos(SWP_FRAMECHANGED)，否则新边框不生效。

本文件用假的 ctypes / 窗体验证样式位语义（Linux CI 上不能真调 user32）。
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace

WS_POPUP = 0x80000000
WS_THICKFRAME = 0x00040000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_SYSMENU = 0x00080000
WANTED = WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_THICKFRAME


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
        self.set_window_pos_calls: list[tuple] = []

        def _get(hwnd, index):
            return self.style

        def _set(hwnd, index, value):
            self.set_calls.append(value)
            self.style = value
            return value

        def _set_window_pos(hwnd, insert_after, x, y, cx, cy, flags):
            self.set_window_pos_calls.append((x, y, cx, cy, flags))
            return 1

        # 实例属性存函数对象：函数可被赋 restype/argtypes，绑定方法不行
        self.GetWindowLongW = _get
        self.SetWindowLongW = _set
        self.SetWindowPos = _set_window_pos


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

    assert user32.set_calls == [WS_POPUP | WANTED]
    # 改完样式位要让系统重算非客户区，否则 WS_THICKFRAME 不生效（贴边分屏仍然不可用）
    assert user32.set_window_pos_calls == [(0, 0, 0, 0, launcher.SWP_FRAMECHANGED
                                            | launcher.SWP_NOMOVE | launcher.SWP_NOSIZE
                                            | launcher.SWP_NOZORDER | launcher.SWP_NOACTIVATE)]


def test_idempotent_when_bits_already_present(monkeypatch):
    """样式位已在时不重复 SetWindowLongW（全屏切换后会再调一次）。"""
    launcher = _load_launcher()
    full = WS_POPUP | WANTED
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


# ------------------------------------------------------ 启动首帧的投影 / 圆角
#
# frameless 窗口由 pywebview 以 FormBorderStyle.None 创建，DWM 在建窗时就缓存了
# 「无边框 → 不画投影、直角」；我们随后补 WS_THICKFRAME / 子类化 WM_NCCALCSIZE
# 不会触发它重新判定，只有窗口矩形真变化（用户拖一下）才恢复。下面锁定修复：
# 启动时显式设置 DWM 属性并强制重合成一次。

class _FakeCtypesForDwm:
    """两个 DWM 辅助函数用到的 ctypes 子集（byref 直接回传对象便于断言）。"""

    c_void_p = staticmethod(lambda value=None: value)
    c_int = int
    c_long = int
    c_bool = bool
    c_uint = int
    POINTER = staticmethod(lambda cls: cls)
    byref = staticmethod(lambda obj: obj)
    sizeof = staticmethod(lambda _obj: 4)

    def __init__(self, dwmapi=None, user32=None):
        self._dwmapi = dwmapi
        self._user32 = user32
        self.calls: list[str] = []

    def WinDLL(self, name, *args, **kwargs):
        self.calls.append(name)
        return self._user32 if name == "user32" else self._dwmapi


class _FakeDwmApi:
    def __init__(self):
        self.margins = None
        self.attributes = []

        def _extend(hwnd, margins):
            self.margins = (
                margins.cxLeftWidth, margins.cxRightWidth,
                margins.cyTopHeight, margins.cyBottomHeight,
            )
            return 0

        def _set_attribute(hwnd, attribute, value, size):
            self.attributes.append((attribute, value, size))
            return 0

        self.DwmExtendFrameIntoClientArea = _extend
        self.DwmSetWindowAttribute = _set_attribute


class _FakeNudgeUser32:
    def __init__(self, zoomed: bool = False):
        self.calls = []
        self._zoomed = zoomed

        def _is_zoomed(hwnd):
            return self._zoomed

        def _get_rect(hwnd, rect):
            rect.left, rect.top, rect.right, rect.bottom = 10, 20, 1010, 720
            return True

        def _set_pos(hwnd, after, x, y, w, h, flags):
            self.calls.append((x, y, w, h, flags))
            return True

        self.IsZoomed = _is_zoomed
        self.GetWindowRect = _get_rect
        self.SetWindowPos = _set_pos


def test_dwm_appearance_sets_shadow_and_win11_rounded_corners(monkeypatch):
    """扩展 1px 玻璃边框拿回系统投影 + 显式 ROUND 圆角 + 强制重合成。"""
    launcher = _load_launcher()
    dwm = _FakeDwmApi()
    fake_ctypes = _FakeCtypesForDwm(dwmapi=dwm)
    nudged: list = []
    monkeypatch.setattr(launcher, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(launcher, "ctypes", fake_ctypes)
    monkeypatch.setattr(launcher, "_nudge_window_rect", lambda w: nudged.append(w))

    window = _fake_window()
    launcher._apply_window_frame_appearance(window)

    assert dwm.margins == (1, 1, 1, 1)
    assert dwm.attributes == [
        (launcher.DWMWA_WINDOW_CORNER_PREFERENCE, launcher.DWMWCP_ROUND, 4),
    ]
    assert nudged == [window]
    assert fake_ctypes.calls == ["dwmapi"]


def test_dwm_appearance_skips_without_native_or_off_windows(monkeypatch):
    """非 Windows / 窗体未就绪时静默跳过，绝不能让启动失败。"""
    launcher = _load_launcher()
    fake_ctypes = _FakeCtypesForDwm(dwmapi=_FakeDwmApi())
    monkeypatch.setattr(launcher, "ctypes", fake_ctypes)

    monkeypatch.setattr(launcher, "os", SimpleNamespace(name="posix"))
    launcher._apply_window_frame_appearance(_fake_window())
    monkeypatch.setattr(launcher, "os", SimpleNamespace(name="nt"))
    launcher._apply_window_frame_appearance(_fake_window(native=False))

    assert fake_ctypes.calls == []


def test_nudge_forces_dwm_recompose_without_user_drag(monkeypatch):
    """宽 +1px 再还原，让 DWM 立刻重合成（等价用户拖一下窗口，但无需用户操作）。"""
    launcher = _load_launcher()
    user32 = _FakeNudgeUser32()
    monkeypatch.setattr(launcher, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(launcher, "ctypes", _FakeCtypesForDwm(user32=user32))

    launcher._nudge_window_rect(_fake_window())

    flags = (launcher.SWP_NOZORDER | launcher.SWP_NOACTIVATE
             | launcher.SWP_FRAMECHANGED)
    assert user32.calls == [
        (10, 20, 1001, 700, flags),
        (10, 20, 1000, 700, flags),
    ]


def test_nudge_skips_maximized_window(monkeypatch):
    """最大化窗口不画投影，也不能用尺寸抖动把最大化状态改掉。"""
    launcher = _load_launcher()
    user32 = _FakeNudgeUser32(zoomed=True)
    monkeypatch.setattr(launcher, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(launcher, "ctypes", _FakeCtypesForDwm(user32=user32))

    launcher._nudge_window_rect(_fake_window())

    assert user32.calls == []
