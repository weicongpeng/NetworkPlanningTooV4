"""桌面壳（launcher）与后端之间的极简桥接（同一进程内）。

launcher 创建 pywebview 窗口后注入 ``window.destroy`` / ``window.set_title`` /
全屏切换 / 窗口控制回调；后端"重启并安装"流程在拉起安装 helper 后调用 :func:`request_exit`
让应用退出，helper 随即执行静默安装并拉起新版本；
前端则通过 :func:`set_window_title` 把「运行模式 + 实时同步状态」写到窗口标题栏，
通过 :func:`set_window_fullscreen` 让地图页的「全屏」把主窗口切成系统级全屏，
通过 :func:`control_window` 响应自绘标题栏的最小化/最大化/关闭与边缘缩放。

服务器/网页模式下没有注入回调，各入口都返回 False（端点据此返回 403）。
"""
from __future__ import annotations

from typing import Callable, Optional

_exit_handler: Optional[Callable[[], None]] = None
_title_handler: Optional[Callable[[str], None]] = None
_fullscreen_handler: Optional[Callable[[bool], None]] = None
_window_control_handler: Optional[Callable[[str, dict], Optional[dict]]] = None


def set_exit_handler(handler: Optional[Callable[[], None]]) -> None:
    global _exit_handler
    _exit_handler = handler


def has_handler() -> bool:
    return _exit_handler is not None


def request_exit() -> bool:
    """请求关闭窗口并退出应用；无回调（非桌面壳）返回 False。"""
    if _exit_handler is None:
        return False
    try:
        _exit_handler()
        return True
    except Exception:  # noqa: BLE001
        return False


def set_title_handler(handler: Optional[Callable[[str], None]]) -> None:
    global _title_handler
    _title_handler = handler


def set_window_title(title: str) -> bool:
    """设置桌面窗口标题；无回调（非桌面壳）返回 False。"""
    if _title_handler is None:
        return False
    try:
        _title_handler(title)
        return True
    except Exception:  # noqa: BLE001
        return False


def set_fullscreen_handler(handler: Optional[Callable[[bool], None]]) -> None:
    global _fullscreen_handler
    _fullscreen_handler = handler


def set_window_fullscreen(fullscreen: bool) -> bool:
    """进入/退出桌面主窗口的系统级全屏；无回调（非桌面壳）返回 False。"""
    if _fullscreen_handler is None:
        return False
    try:
        _fullscreen_handler(bool(fullscreen))
        return True
    except Exception:  # noqa: BLE001
        return False


def set_window_control_handler(
    handler: Optional[Callable[[str, dict], Optional[dict]]],
) -> None:
    global _window_control_handler
    _window_control_handler = handler


def control_window(action: str, params: Optional[dict] = None) -> Optional[dict]:
    """执行窗口控制动作（minimize/toggle-maximize/close/resize/state）；
    无回调（非桌面壳）或执行失败返回 None（端点据此返回 403）。"""
    if _window_control_handler is None:
        return None
    try:
        return _window_control_handler(action, params or {})
    except Exception:  # noqa: BLE001
        return None
