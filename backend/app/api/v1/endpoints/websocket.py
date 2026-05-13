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