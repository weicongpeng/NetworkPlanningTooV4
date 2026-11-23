"""桌面端「登录优先」门控。

背景：桌面形态下 lifespan 会启动一批非关键后台重活（数据索引对账、历史安装包
清理、图层 GeoJSON 预热、坐标缺失提醒回填、旧版任务索引拆分、首次数据同步）。
这些活儿是纯 Python / GDAL 线程，**持 GIL**，而桌面端进程启动后几秒内用户正好
在点登录——于是登录请求、首屏请求全被它们拖慢。

这里提供一个极轻量的闸门：后台重活先等「首次登录成功」，登录请求因此能独占
CPU/磁盘。用户长时间不登录时按 timeout 兜底放行，保证这些维护最终仍会执行。

只依赖标准库，且不得导入任何 app 业务模块（会被 launcher 在极早期间接引用）。
"""
from __future__ import annotations

import threading

# 默认兜底：用户一直不登录也要在这么久之后放行，避免维护永远不跑
DEFAULT_LOGIN_TIMEOUT_SECONDS = 120.0

_LOGIN_EVENT = threading.Event()


def mark_login_completed() -> None:
    """标记首次登录已完成，放行所有等待中的后台重活（幂等）。"""
    _LOGIN_EVENT.set()


def is_login_completed() -> bool:
    return _LOGIN_EVENT.is_set()


def wait_for_login(timeout: float = DEFAULT_LOGIN_TIMEOUT_SECONDS) -> bool:
    """等待首次登录；返回 True 表示已登录，False 表示超时兜底放行。"""
    return _LOGIN_EVENT.wait(timeout=timeout)


def reset_for_tests() -> None:
    """仅供测试：复位闸门。"""
    _LOGIN_EVENT.clear()
