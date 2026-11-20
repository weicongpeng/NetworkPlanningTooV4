"""
用户上线广播

登录成功后把「谁上线了」推给「除上线者自身以外」的已鉴权 WebSocket 连接，
各端在侧边栏顶部弹气泡提醒（文案形如「河源_电信 admin」）并播放敲门声。

- 排除自身：上线者自己的全部连接（含同一账号其它标签页/设备）都不弹气泡、不响敲门声
- 只推给已鉴权的连接：登录页上的匿名连接不该收到在线名单
- 广播失败绝不影响登录：任何异常都吞掉并记日志
- 单进程内广播（现网 NPT_WORKERS=1），多 worker 部署时其它 worker 的连接收不到
"""
import logging
import uuid
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


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
