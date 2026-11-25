"""
用户上线广播

登录成功后把「谁上线了」推给「除上线者自身以外」的已鉴权 WebSocket 连接，
各端在侧边栏顶部弹气泡提醒（文案形如「河源_电信 admin」）并播放敲门声。

- 排除自身：上线者自己的全部连接（含同一账号其它标签页/设备）都不弹气泡、不响敲门声
- 只推给已鉴权的连接：登录页上的匿名连接不该收到在线名单
- 广播失败绝不影响登录：任何异常都吞掉并记日志
- 单进程内广播（现网 NPT_WORKERS=1），多 worker 部署时其它 worker 的连接收不到
- 事件另存一份环形日志：桌面壳内的渲染进程只连本机后端，收不到这里的 WS 广播，
  由 ``events_since`` 供桌面端长轮询补齐（见 desktop_presence_relay）
"""
import logging
import threading
import uuid
from collections import deque
from typing import Any, Deque, Dict, List, Optional

logger = logging.getLogger(__name__)

# 最近上线事件环形日志：只留最近若干条，够桌面端按游标补齐就够了。
# seq 单调递增、进程内唯一；客户端带上自己见过的最大 seq 即可拿增量。
EVENT_LOG_MAX = 64
_event_lock = threading.Lock()
_event_log: Deque[Dict[str, Any]] = deque(maxlen=EVENT_LOG_MAX)
_event_seq = 0


def _remember(event: Dict[str, Any]) -> int:
    """把事件记进环形日志，返回新的游标（广播失败也要记：桌面端仍能补齐）。"""
    global _event_seq
    with _event_lock:
        _event_seq += 1
        _event_log.append({"seq": _event_seq, "event": dict(event or {})})
        return _event_seq


def current_seq() -> int:
    """当前游标（客户端首次对齐用，避免把历史事件重播成一片敲门声）。"""
    with _event_lock:
        return _event_seq


def events_since(since: int = 0, limit: int = 20) -> Dict[str, Any]:
    """返回游标之后的上线事件：``{"seq": 最新游标, "events": [事件...]}``。

    只取最近 ``limit`` 条（一次性弹十几个气泡没有意义）：截断时仍会推进 seq，
    客户端不会卡在积压的历史事件上。
    """
    try:
        cursor = int(since or 0)
    except (TypeError, ValueError):
        cursor = 0
    with _event_lock:
        latest = _event_seq
        items: List[Dict[str, Any]] = [
            item["event"] for item in _event_log if int(item["seq"]) > cursor
        ]
    if limit > 0 and len(items) > limit:
        items = items[-limit:]
    return {"seq": latest, "events": items}


def _group_text(city: str, operator: str) -> str:
    """数据组文案：地市_运营商（如「河源_电信」）；缺项时退化为已有的一项。"""
    parts = [p for p in (city, operator) if p]
    return "_".join(parts)


def build_online_event(
    *,
    user_id: Optional[int] = None,
    username: str = "",
    city: str = "",
    operator: str = "",
    is_admin: bool = False,
    client_type: str = "pc",
    event_id: str = "",
) -> Dict[str, Any]:
    """构造上线事件负载。

    userId 是「排除自身」的依据：服务端广播时跳过该用户的所有连接。
    eventId 用于前端去重，避免同一事件重复推送时弹多次气泡。
    """
    city = city or ""
    operator = operator or ""
    username = username or ""
    group = _group_text(city, operator)
    text = f"{group} {username}".strip() if group else username
    return {
        "eventId": event_id or uuid.uuid4().hex,
        "userId": user_id,
        "username": username,
        "city": city,
        "operator": operator,
        "isAdmin": bool(is_admin),
        "clientType": client_type or "pc",
        "text": text,
    }


def notify_user_online(event: Dict[str, Any]) -> Dict[str, Any]:
    """广播「用户上线」事件；绝不抛异常（调用方无需 try/except）。返回同一份事件。"""
    # 先入日志再广播：WS 广播失败（如连接已断开）不该让桌面端也漏掉这次上线
    try:
        _remember(event)
    except Exception as exc:  # noqa: BLE001
        logger.debug(f"用户上线事件入队失败（忽略）：{exc}")
    try:
        from app.services.websocket_manager import websocket_manager

        websocket_manager.notify_user_online(event)
    except Exception as exc:  # noqa: BLE001
        logger.debug(f"用户上线广播失败（忽略）：{exc}")
    return event


def notify_user_online_from_user(user, client_type: str = "pc", event_id: str = "") -> Dict[str, Any]:
    """从 User 对象广播上线事件（组信息缺失时按空串处理）。"""
    event = build_online_event(
        user_id=getattr(user, "id", None),
        username=getattr(user, "username", "") or "",
        city=getattr(user, "city", "") or "",
        operator=getattr(user, "operator", "") or "",
        is_admin=bool(getattr(user, "is_admin", False)),
        client_type=client_type,
        event_id=event_id,
    )
    return notify_user_online(event)


def notify_user_online_from_payload(
    payload: Dict[str, Any], client_type: str = "pc", event_id: str = ""
) -> Dict[str, Any]:
    """从用户字典（user_payload 结构）广播上线事件。"""
    payload = payload or {}
    event = build_online_event(
        user_id=payload.get("id"),
        username=payload.get("username", "") or "",
        city=payload.get("city", "") or "",
        operator=payload.get("operator", "") or "",
        is_admin=bool(payload.get("is_admin")),
        client_type=client_type,
        event_id=event_id,
    )
    return notify_user_online(event)
