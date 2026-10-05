"""桌面壳（launcher）与后端之间的极简桥接（同一进程内）。

launcher 创建 pywebview 窗口后注入 ``window.destroy`` 回调；
后端"重启并安装"流程在拉起安装 helper 后调用 :func:`request_exit` 让应用退出，
helper 随即执行静默安装并拉起新版本。

服务器/网页模式下没有注入回调，``request_exit()`` 返回 False（端点据此返回 403）。
"""
from __future__ import annotations

from typing import Callable, Optional

_exit_handler: Optional[Callable[[], None]] = None


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
