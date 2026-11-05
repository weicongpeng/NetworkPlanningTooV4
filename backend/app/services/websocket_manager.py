"""
WebSocket连接管理器 - 单例模式
用于管理WebSocket连接和任务进度推送
"""

import asyncio
import logging
from typing import Dict, Optional, Set, Tuple

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class WebSocketManager:
    """WebSocket连接管理器 - 单例模式"""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance.connections: Dict[str, WebSocket] = {}
            cls._instance.task_subscriptions: Dict[str, Set[str]] = {}
            # client_id -> (city, operator)：数据变更只推给同组连接
            cls._instance.client_groups: Dict[str, Tuple[str, str]] = {}
            # 主事件循环（bump 可能在后台线程里调用，广播需要回到循环线程）
            cls._instance.loop: Optional[asyncio.AbstractEventLoop] = None
        return cls._instance

    async def connect(self, websocket: WebSocket, client_id: str) -> None:
        """建立WebSocket连接"""
        await websocket.accept()
        self.connections[client_id] = websocket
        try:
            self.loop = asyncio.get_running_loop()
        except RuntimeError:
            pass
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
        self.client_groups.pop(client_id, None)
        logger.info(f"WebSocket连接断开: {client_id}, 剩余连接数: {len(self.connections)}")

    def register_client_group(self, client_id: str, city: str, operator: str) -> None:
        """登记连接的数据组（登录 JWT 解出）；组不完整则不登记。"""
        if city and operator:
            self.client_groups[client_id] = (city, operator)

    async def broadcast_group(self, city: str, operator: str, message: dict) -> None:
        """仅向（地市+运营商）相同的数据组连接推送消息。"""
        if not city or not operator:
            return
        group = (city, operator)
        # 遍历前 copy：发送失败会调用 disconnect 修改 connections
        for client_id in list(self.connections.keys()):
            if self.client_groups.get(client_id) != group:
                continue
            ws = self.connections.get(client_id)
            if ws is None:
                continue
            try:
                await ws.send_json(message)
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"发送分组消息失败: {client_id}, {exc}")
                await self.disconnect(client_id)

    def notify_data_changed(self, city: str, operator: str, data_id: str = "") -> None:
        """线程安全地通知同组客户端「数据已变化」（任意线程可调用，绝不抛异常）。

        单进程内广播（现网 NPT_WORKERS=1）；多 worker 部署时其它 worker 的连接
        收不到，各端仍有轮询/长轮询兜底。
        """
        if not city or not operator:
            return
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        message = {"type": "data_changed", "taskId": "", "data": {"dataId": data_id}}

        async def _send() -> None:
            try:
                await self.broadcast_group(city, operator, message)
            except Exception as exc:  # noqa: BLE001
                logger.debug(f"数据变更广播失败（忽略）: {exc}")

        try:
            loop.call_soon_threadsafe(lambda: asyncio.create_task(_send()))
        except RuntimeError:
            pass

    def notify_tasks_changed(self, city: str, operator: str, task_id: str = "") -> None:
        """线程安全地通知同组客户端「共享任务历史已变化」（新增/删除/应用标记）。

        与 `notify_data_changed` 分开：任务历史变化不影响工参数据集，网页端
        只需要重载历史列表（`tasks_changed` 事件），不必整表刷新。
        """
        if not city or not operator:
            return
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        message = {"type": "tasks_changed", "taskId": task_id, "data": {"taskId": task_id}}

        async def _send() -> None:
            try:
                await self.broadcast_group(city, operator, message)
            except Exception as exc:  # noqa: BLE001
                logger.debug(f"任务历史变更广播失败（忽略）: {exc}")

        try:
            loop.call_soon_threadsafe(lambda: asyncio.create_task(_send()))
        except RuntimeError:
            pass

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