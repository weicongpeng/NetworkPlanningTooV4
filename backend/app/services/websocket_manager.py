"""
WebSocket连接管理器 - 单例模式
用于管理WebSocket连接和任务进度推送
"""

from fastapi import WebSocket
from typing import Dict, Set
import logging

logger = logging.getLogger(__name__)


class WebSocketManager:
    """WebSocket连接管理器 - 单例模式"""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance.connections: Dict[str, WebSocket] = {}
            cls._instance.task_subscriptions: Dict[str, Set[str]] = {}
        return cls._instance

    async def connect(self, websocket: WebSocket, client_id: str) -> None:
        """建立WebSocket连接"""
        await websocket.accept()
        self.connections[client_id] = websocket
        logger.info(f"WebSocket连接建立: {client_id}, 当前连接数: {len(self.connections)}")

    async def disconnect(self, client_id: str) -> None:
        """断开连接并清理订阅"""
        # 清理所有订阅
        for task_id in list(self.task_subscriptions.keys()):
            if client_id in self.task_subscriptions[task_id]:
                self.task_subscriptions[task_id].discard(client_id)
                if not self.task_subscriptions[task_id]:
                    del self.task_subscriptions[task_id]

        # 移除连接
        if client_id in self.connections:
            del self.connections[client_id]
        logger.info(f"WebSocket连接断开: {client_id}, 剩余连接数: {len(self.connections)}")

    async def subscribe_task(self, client_id: str, task_id: str) -> None:
        """客户端订阅任务进度"""
        if task_id not in self.task_subscriptions:
            self.task_subscriptions[task_id] = set()
        self.task_subscriptions[task_id].add(client_id)
        logger.info(f"客户端订阅任务: {client_id} -> {task_id}")

    async def unsubscribe_task(self, client_id: str, task_id: str) -> None:
        """客户端取消订阅"""
        if task_id in self.task_subscriptions and client_id in self.task_subscriptions[task_id]:
            self.task_subscriptions[task_id].discard(client_id)
            if not self.task_subscriptions[task_id]:
                del self.task_subscriptions[task_id]
            logger.info(f"客户端取消订阅: {client_id} -> {task_id}")

    async def broadcast_progress(self, task_id: str, progress_data: dict) -> None:
        """广播进度更新"""
        if task_id not in self.task_subscriptions:
            return

        message = {
            "type": "progress",
            "taskId": task_id,
            "data": progress_data
        }

        for client_id in list(self.task_subscriptions[task_id]):
            if client_id in self.connections:
                try:
                    await self.connections[client_id].send_json(message)
                except Exception as e:
                    logger.error(f"发送进度消息失败: {client_id}, {e}")
                    await self.disconnect(client_id)

    async def broadcast_complete(self, task_id: str, result: dict) -> None:
        """广播任务完成"""
        if task_id not in self.task_subscriptions:
            return

        message = {
            "type": "complete",
            "taskId": task_id,
            "data": result
        }

        for client_id in list(self.task_subscriptions[task_id]):
            if client_id in self.connections:
                try:
                    await self.connections[client_id].send_json(message)
                except Exception as e:
                    logger.error(f"发送完成消息失败: {client_id}, {e}")
                    await self.disconnect(client_id)

    async def broadcast_failed(self, task_id: str, error: str) -> None:
        """广播任务失败"""
        if task_id not in self.task_subscriptions:
            return

        message = {
            "type": "failed",
            "taskId": task_id,
            "data": {"error": error}
        }

        for client_id in list(self.task_subscriptions[task_id]):
            if client_id in self.connections:
                try:
                    await self.connections[client_id].send_json(message)
                except Exception as e:
                    logger.error(f"发送失败消息失败: {client_id}, {e}")
                    await self.disconnect(client_id)

    def get_connection_count(self) -> int:
        """获取当前连接数"""
        return len(self.connections)

    def get_subscription_count(self, task_id: str) -> int:
        """获取任务订阅数"""
        return len(self.task_subscriptions.get(task_id, set()))


# 全局单例
websocket_manager = WebSocketManager()