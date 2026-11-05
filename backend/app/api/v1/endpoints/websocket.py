"""
WebSocket API 端点
提供任务进度实时推送功能
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.services.websocket_manager import websocket_manager
import json
import logging

logger = logging.getLogger(__name__)
router = APIRouter()


def _resolve_ws_group(token: str):
    """解码查询串/消息里的 JWT，返回用户的数据组 (city, operator)；失败返回 None。"""
    if not token:
        return None
    try:
        from app.core.database import SessionLocal
        from app.services import auth_service

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
        return (user.city or "", user.operator or "")
    except Exception:  # noqa: BLE001
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

    try:
        await websocket_manager.connect(websocket, client_id)
        # 查询串里的 JWT（前端在已登录时携带）：登记数据组，
        # 之后只接收同组的数据变更推送（data_changed）
        group = _resolve_ws_group(websocket.query_params.get("token") or "")
        if group:
            websocket_manager.register_client_group(client_id, group[0], group[1])
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
                    # 登录后补鉴权（连接建立时可能还没登录）：登记数据组
                    auth_group = _resolve_ws_group(str(data.get("token") or ""))
                    if auth_group:
                        websocket_manager.register_client_group(client_id, auth_group[0], auth_group[1])
                        await websocket.send_json({"type": "auth_ok"})
                    else:
                        logger.warning(f"WebSocket 鉴权失败: {client_id}")

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
        await websocket_manager.disconnect(client_id)