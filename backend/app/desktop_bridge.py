"""桌面壳（launcher）与后端之间的极简桥接（同一进程内）。

launcher 创建 pywebview 窗口后注入 ``window.destroy`` / ``window.set_title`` /
全屏切换 / 窗口控制回调；后端"重启并安装"流程在拉起安装 helper 后调用 :func:`request_exit`
让应用退出，helper 随即执行静默安装并拉起新版本；
前端则通过 :func:`set_window_title` 把「运行模式 + 实时同步状态」写到窗口标题栏，
通过 :func:`set_window_fullscreen` 让地图页的「全屏」把主窗口切成系统级全屏，
通过 :func:`control_window` 响应自绘标题栏的最小化/最大化/关闭与边缘缩放，
通过 :func:`screenshot` 承接壳层取景截图会话与全局热键重注册。

服务器/网页模式下没有注入回调，各入口都返回 False / None（端点据此返回 403）。
"""
from __future__ import annotations

import threading
from typing import Callable, Optional

_exit_handler: Optional[Callable[[], None]] = None
_title_handler: Optional[Callable[[str], None]] = None
_fullscreen_handler: Optional[Callable[[bool], None]] = None
_window_control_handler: Optional[Callable[[str, dict], Optional[dict]]] = None
# 取景截图会话 / 可配置热键：单一 handler，按 action 分派（与 control_window 同范式）
_screenshot_handler: Optional[Callable[[str, dict], Optional[dict]]] = None

# 系统级截图热键（Alt+Z）由 launcher 的 Win32 RegisterHotKey 线程触发。
# 前端按序号增量消费：即使 WebView 处于后台 / evaluate_js 不可用也不会丢事件。
_hotkey_lock = threading.Lock()
_screenshot_hotkey_seq = 0
# 全局热键登记后、前端尚未接管前，壳层保留一个 2s watchdog 兜底抓屏：
# WebView2 后台久了定时器会被 Chromium 压到分钟级，只靠前端轮询会明显延迟。
# claim 让「前端 POST」与「watchdog」竞争，先到者获胜，避免重复铺蒙层。
_screenshot_pending_round = 0


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


def set_screenshot_handler(
    handler: Optional[Callable[[str, dict], Optional[dict]]],
) -> None:
    global _screenshot_handler
    _screenshot_handler = handler


def screenshot(action: str, params: Optional[dict] = None) -> Optional[dict]:
    """执行截图相关动作（start/status/image/cancel/apply/hotkey-status）。

    无回调（非桌面壳）或执行失败返回 None（端点据此返回 403）。结果里的 PNG 二进制
    以 ``{"png": bytes}`` 透传，端点用 ``Response`` 直接输出，不经 JSON 膨胀。
    """
    if _screenshot_handler is None:
        return None
    try:
        return _screenshot_handler(action, params or {})
    except Exception:  # noqa: BLE001
        return None


def notify_screenshot_hotkey() -> int:
    """壳层捕获到全局截图热键时调用：递增序号并登记一轮待前端接管的取景。"""
    global _screenshot_hotkey_seq, _screenshot_pending_round
    with _hotkey_lock:
        _screenshot_hotkey_seq += 1
        _screenshot_pending_round += 1
        return _screenshot_hotkey_seq


def claim_screenshot_round() -> bool:
    """竞争接管一轮热键取景：前端 POST 或 watchdog 谁先调用谁抓屏，返回是否抢到。

    前端在 ``POST /desktop/screenshot-capture`` 里调用表示已接管，watchdog 随后
    拿不到 claim 就会自行取消；反之 watchdog 兜底抓屏后，前端晚到的 POST 会命中
    控制器的 busy / 复用结果契约，不会重复铺蒙层。
    """
    global _screenshot_pending_round
    with _hotkey_lock:
        if _screenshot_pending_round <= 0:
            return False
        _screenshot_pending_round = 0
        return True


def screenshot_hotkey_seq() -> int:
    """前端轮询读取当前序号；与上次读数不同即视为有一次热键。"""
    with _hotkey_lock:
        return _screenshot_hotkey_seq
