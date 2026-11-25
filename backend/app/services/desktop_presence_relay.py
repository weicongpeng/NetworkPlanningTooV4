"""桌面共享模式：把云端「有人上线」事件中继到本机 WebSocket。

背景（桌面端「别人登录没提示音」）：敲门声/气泡的唯一触发来源是服务端 WebSocket
广播的 ``user_online``。桌面壳内的渲染进程连的是**本机后端**（127.0.0.1 的
``/api/v1/ws/tasks``），云端那条广播根本到不了它 —— 于是网页端有人登录会响，
桌面端一片安静（气泡也不弹）。

这里用长轮询把云端事件按游标取回来，再用本机 WebSocketManager 广播一次，
前端的气泡 / 敲门声逻辑完全不用改（与网页端同一份实现）。

- 仅共享模式且本机许可有效时才联网（单机/离线模式直接跳过，不产生任何请求）
- 启动先对齐游标：不重播本机启动前的历史事件，避免一开窗就"咚咚咚"
- 自身登录由前端按 ``im_user_id`` 过滤（本机镜像账号 id 与服务器 id 不同，
  本机 WebSocketManager 的按 id 排除对它无效）
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

# 一次长轮询挂起时长（与数据变更监听一致）：服务器有事件会立即返回
WATCH_WAIT_SECONDS = 25
# 离线 / 许可失效时的重试间隔
IDLE_RETRY_SECONDS = 10
# 联网失败（隧道抖动 / 服务器还是旧版本没有该接口）时的重试间隔：
# 比空闲重试更久，避免日志被同一条错误刷屏
ERROR_RETRY_SECONDS = 15
# 启动后稍等：先让本机服务就绪、登录请求先跑完，别和登录抢连接
STARTUP_DELAY_SECONDS = 15


def _license_valid() -> bool:
    try:
        from app.services.desktop_sync_service import _license_valid as valid

        return bool(valid())
    except Exception:  # noqa: BLE001
        return False


def _shared() -> bool:
    try:
        from app.services.desktop_sync_service import is_shared

        return bool(is_shared())
    except Exception:  # noqa: BLE001
        return False


def baseline() -> int:
    """当前云端游标：启动/切档后先对齐，历史事件不再重播。"""
    from app.services import desktop_cloud_client as cloud

    # since 取一个大值 → 服务器立刻返回「最新游标 + 空事件」，不挂起
    data = cloud.wait_online_events(2**31 - 1, timeout=0)
    return int(data.get("seq") or 0)


def broadcast_locally(events: List[Dict[str, Any]]) -> int:
    """把云端事件逐条交给本机 WebSocketManager，返回成功转发的条数。"""
    if not events:
        return 0
    from app.services.websocket_manager import websocket_manager

    forwarded = 0
    for event in events:
        if not isinstance(event, dict) or not event.get("text"):
            continue
        try:
            websocket_manager.notify_user_online(event)
            forwarded += 1
        except Exception as exc:  # noqa: BLE001 - 单条失败不影响后续事件
            print(f"[DesktopPresence] 本机转发上线事件失败（忽略）：{exc}")
    return forwarded


def relay_once(since: int, wait_seconds: int = WATCH_WAIT_SECONDS) -> int:
    """拉一次事件并本机广播，返回新的游标（调用方下一轮带上它）。"""
    from app.services import desktop_cloud_client as cloud

    data = cloud.wait_online_events(since, timeout=wait_seconds)
    events = data.get("events") or []
    broadcast_locally(events if isinstance(events, list) else [])
    latest = int(data.get("seq") or since)
    return latest if latest >= since else since


async def relay_loop(wait_seconds: int = WATCH_WAIT_SECONDS) -> None:
    """常驻协程：本机 WebSocket 的「有人上线」补给通道（失败只重试，不影响主功能）。"""
    await asyncio.sleep(STARTUP_DELAY_SECONDS)
    since: Optional[int] = None
    while True:
        try:
            if not (_shared() and _license_valid()):
                # 退出共享模式后游标作废：下次进来重新对齐，不补播离线期间的旧事件
                since = None
                await asyncio.sleep(IDLE_RETRY_SECONDS)
                continue
            if since is None:
                since = await asyncio.to_thread(baseline)
                continue
            since = await asyncio.to_thread(relay_once, since, wait_seconds)
        except Exception as exc:  # noqa: BLE001
            print(f"[DesktopPresence] 上线事件中继异常（忽略）：{exc}")
            await asyncio.sleep(ERROR_RETRY_SECONDS)
