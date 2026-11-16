"""
WebSocket API 端点
提供任务进度实时推送功能
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.services.websocket_manager import websocket_manager
import asyncio
import json
import logging
import threading

logger = logging.getLogger(__name__)
router = APIRouter()

# 公网 WS 端点匿名可连：按来源 IP 限制并发连接数，桌面许可连接另设 10s 鉴权超时。
# 只统计经 CF-Connecting-IP / XFF 归一后的来源，避免同一出口多桌面互踩。
# 同一办公出口可能有很多台桌面端共享一个公网 IP，阈值不能按「每台 1 条」设；
# 200 既能挡住单 IP 刷连接，也不会误杀正常的多桌面部署。
MAX_WS_PER_IP = 200
LICENSE_AUTH_TIMEOUT_SECONDS = 10
_ws_ip_lock = threading.Lock()
_ws_ip_counts: dict = {}


def _ws_client_ip(websocket: WebSocket) -> str:
    cf = websocket.headers.get("cf-connecting-ip")
    if cf:
        return cf.strip()
    xff = websocket.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return websocket.client.host if websocket.client else "unknown"


def _resolve_ws_group(token: str):
    """解码查询串/消息里的 JWT，返回 (city, operator, user_id)；失败返回 None。

    user_id 用于「用户上线」提醒排除上线者自己的连接（含同一账号其它标签页）。
    """
    if not token:
        return None
    try:
        from app.core.database import SessionLocal
        # 注意：必须从模块里取「实例」（app.services.auth_service.auth_service），
        # 直接 `from app.services import auth_service` 拿到的是模块本身，
        # 调用 decode_token 会抛 AttributeError → 组/鉴权登记全部失效
        from app.services.auth_service import auth_service

        payload = auth_service.decode_token(token)
        if not payload:
            return None
        user_id = int(payload.get("sub"))
        db = SessionLocal()
        try:
            user = auth_service.get_user_by_id(db, user_id)
        finally:
            db.close()
        if user is None or not getattr(user, "is_active", True):
            return None
        return (user.city or "", user.operator or "", user_id)
    except Exception:  # noqa: BLE001
        return None


def _resolve_license_ws_group(license_file: str, machine_code: str):
    """桌面共享模式：验签许可 → 解析云端真实 user_id → 返回 (city, operator, user_id)。

    桌面端没有云端 JWT（本机 token 的 ``sub`` 是本机 users.id，直接拿来用会因密钥
    不同变匿名、密钥相同则撞云端 user_id 串号），所以身份一律从许可绑定的网页账号解析。
    """
    if not license_file or not machine_code:
        return None
    try:
        from app.api.v1.endpoints import desktop_cloud
        from app.core.database import SessionLocal
        from app.models.database import User

        db = SessionLocal()
        try:
            record, _ = desktop_cloud._verify_license(license_file, machine_code, db)
            user_id = desktop_cloud._relay_user_id(db, record)
            user = db.query(User).filter(User.id == user_id).first()
            if user is None:
                return None
            group = desktop_cloud._license_group(record)
            city, operator = group if group else (user.city or "", user.operator or "")
            return (city, operator, user_id)
        finally:
            db.close()
    except Exception:  # noqa: BLE001
        logger.warning("许可 WS 鉴权失败", exc_info=True)
        return None


@router.websocket("/ws/tasks")
async def websocket_tasks_endpoint(websocket: WebSocket):
    """
    WebSocket任务进度推送端点

    客户端消息格式:
    {
        "type": "subscribe" | "unsubscribe" | "ping",
        "taskId": "任务ID"  // subscribe/unsubscribe时需要
    }

    服务器消息格式:
    {
        "type": "progress" | "complete" | "failed" | "pong",
        "taskId": "任务ID",
        "data": {...}  // 消息数据
    }
    """
    client_id = str(id(websocket))
    client_ip = _ws_client_ip(websocket)
    # 桌面共享模式直连云端时带 kind=license：启用严格鉴权超时与匿名限制。
    # 网页端原有连接不带该参数，行为完全不变。
    strict_license = websocket.query_params.get("kind") == "license"
    ip_counted = False
    watchdog = None

    try:
        await websocket_manager.connect(websocket, client_id)
        with _ws_ip_lock:
            count = _ws_ip_counts.get(client_ip, 0)
            over_limit = count >= MAX_WS_PER_IP
            if not over_limit:
                _ws_ip_counts[client_ip] = count + 1
                ip_counted = True
        if over_limit:
            logger.warning("WS 连接数超限: %s", client_ip)
            await websocket.close(code=1013, reason="too many connections")
            return
        if strict_license:
            async def _auth_timeout() -> None:
                await asyncio.sleep(LICENSE_AUTH_TIMEOUT_SECONDS)
                if client_id not in websocket_manager.client_authed:
                    logger.warning("许可 WS 鉴权超时，关闭连接: %s", client_id)
                    try:
                        await websocket.close(code=1008, reason="auth timeout")
                    except Exception:  # noqa: BLE001
                        pass

            watchdog = asyncio.create_task(_auth_timeout())
        # 查询串里的 JWT（前端在已登录时携带）：登记数据组，
        # 之后只接收同组的数据变更推送（data_changed）
        group = _resolve_ws_group(websocket.query_params.get("token") or "")
        if group:
            websocket_manager.register_client_group(client_id, group[0], group[1])
            websocket_manager.register_client_auth(client_id, group[2])
            # 协作沟通通讯录：即时同步上线状态（离线由 finally 判定最后一个连接）
            websocket_manager.notify_im_presence({"user_id": group[2], "online": True})
        logger.info(f"WebSocket客户端连接: {client_id}")

        # 持续接收客户端消息
        while True:
            try:
                # 先接收文本消息
                text_data = await websocket.receive_text()

                # 尝试解析为JSON
                try:
                    data = json.loads(text_data)
                except json.JSONDecodeError:
                    # 如果不是JSON格式，记录警告并跳过
                    logger.warning(f"收到非JSON格式的消息: {text_data[:100]}, 来自客户端: {client_id}")
                    continue

                message_type = data.get("type") if data else None

                if message_type == "subscribe":
                    if strict_license and client_id not in websocket_manager.client_authed:
                        logger.warning("匿名许可 WS 拒绝订阅: %s", client_id)
                        continue
                    task_id = data.get("taskId")
                    if task_id:
                        await websocket_manager.subscribe_task(client_id, task_id)
                        logger.info(f"客户端订阅任务: {client_id} -> {task_id}")

                elif message_type == "unsubscribe":
                    task_id = data.get("taskId")
                    if task_id:
                        await websocket_manager.unsubscribe_task(client_id, task_id)
                        logger.info(f"客户端取消订阅: {client_id} -> {task_id}")

                elif message_type == "ping":
                    # 心跳响应
                    await websocket.send_json({"type": "pong"})
                    logger.debug(f"收到心跳: {client_id}")

                elif message_type == "auth":
                    # 网页端：登录后补鉴权（JWT）。
                    # 桌面共享模式：没有云端 JWT，改用签名许可 + 机器码，
                    # 由云端解析出真实 user_id，绝不采信客户端自报身份。
                    license_auth = data.get("kind") == "license"
                    if license_auth:
                        auth_group = _resolve_license_ws_group(
                            str(data.get("license_file") or ""),
                            str(data.get("machine_code") or ""),
                        )
                    else:
                        auth_group = _resolve_ws_group(str(data.get("token") or ""))
                    if auth_group:
                        websocket_manager.register_client_group(client_id, auth_group[0], auth_group[1])
                        websocket_manager.register_client_auth(client_id, auth_group[2])
                        websocket_manager.notify_im_presence(
                            {"user_id": auth_group[2], "online": True})
                        await websocket.send_json({"type": "auth_ok"})
                    else:
                        logger.warning("WebSocket 鉴权失败: %s", client_id)
                        if license_auth:
                            # 明确回一个失败，前端可立即降级到旧轮询，不必等满超时
                            await websocket.send_json({"type": "auth_failed"})

                else:
                    logger.warning(f"未知消息类型: {message_type}, 来自客户端: {client_id}")

            except Exception as inner_e:
                logger.warning(f"处理客户端消息时出错: {client_id}, {type(inner_e).__name__}: {inner_e}")
                break

    except WebSocketDisconnect:
        logger.info(f"WebSocket客户端主动断开: {client_id}")
    except Exception as e:
        logger.error(f"WebSocket错误: {client_id}, {type(e).__name__}: {e}")
    finally:
        if watchdog is not None:
            watchdog.cancel()
        if ip_counted:
            with _ws_ip_lock:
                remaining = _ws_ip_counts.get(client_ip, 1) - 1
                if remaining <= 0:
                    _ws_ip_counts.pop(client_ip, None)
                else:
                    _ws_ip_counts[client_ip] = remaining
        # 先取 user_id 再清理；只有该用户没有任何剩余连接时才广播离线，
        # 避免多标签页/多设备时把仍在线的人误标为离线。
        offline_user_id = websocket_manager.client_user_ids.get(client_id)
        await websocket_manager.disconnect(client_id)
        if offline_user_id and not websocket_manager.has_other_connections(
                offline_user_id, client_id):
            websocket_manager.notify_im_presence(
                {"user_id": offline_user_id, "online": False})