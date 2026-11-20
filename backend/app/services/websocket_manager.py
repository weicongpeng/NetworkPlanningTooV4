"""
WebSocket连接管理器 - 单例模式
用于管理WebSocket连接和任务进度推送
"""

import asyncio
import logging
from typing import Any, Dict, Optional, Set, Tuple

from fastapi import WebSocket

logger = logging.getLogger(__name__)

# 单条 WS 推送的超时：慢连接不能拖住同一批其它连接（测试可缩短）
IM_WS_SEND_TIMEOUT_SECONDS = 2.0
IM_WS_MAX_CONCURRENT_SENDS = 32


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
            # 已通过鉴权的连接（登录过）：全局事件（如「用户上线」）只推给这些连接，
            # 避免把在线提醒暴露给还停留在登录页的匿名连接
            cls._instance.client_authed: Set[str] = set()
            # client_id -> user_id：上线提醒要排除「上线者自己」的所有连接（含其它标签页）
            cls._instance.client_user_ids: Dict[str, int] = {}
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
        self.client_authed.discard(client_id)
        self.client_user_ids.pop(client_id, None)
        logger.info(f"WebSocket连接断开: {client_id}, 剩余连接数: {len(self.connections)}")

    def register_client_group(self, client_id: str, city: str, operator: str) -> None:
        """登记连接的数据组（登录 JWT 解出）；组不完整则不登记。"""
        if city and operator:
            self.client_groups[client_id] = (city, operator)

    def register_client_auth(self, client_id: str, user_id: int = 0) -> None:
        """登记连接已通过鉴权（登录过），并记住所属用户 id。

        「用户上线」这类全局提醒只推给已鉴权的连接，避免把在线名单
        暴露给还停留在登录页的匿名连接；user_id 用于把上线者自己的
        连接（含同一账号的其它标签页/设备）排除在提醒之外。
        """
        self.client_authed.add(client_id)
        if user_id:
            self.client_user_ids[client_id] = int(user_id)

    async def _send_concurrently(self, pairs, message: dict) -> None:
        """并发推送：单连接 2s 超时，慢连接不再串行拖住同一批其它连接。

        用信号量限制并发，避免连接数暴涨时一次性创建过多 task；失败连接先收集，
        推送结束后统一摘除，防止 disconnect 与正在进行的发送互相竞态。
        """
        if not pairs:
            return
        semaphore = asyncio.Semaphore(IM_WS_MAX_CONCURRENT_SENDS)

        async def _send_one(client_id: str, ws) -> Optional[str]:
            try:
                async with semaphore:
                    await asyncio.wait_for(
                        ws.send_json(message), timeout=IM_WS_SEND_TIMEOUT_SECONDS)
                return None
            except Exception as exc:  # noqa: BLE001
                logger.debug("WebSocket 推送失败（摘除连接）: %s, %s", client_id, exc)
                return client_id

        results = await asyncio.gather(
            *(_send_one(cid, ws) for cid, ws in pairs), return_exceptions=True)
        for result in results:
            if isinstance(result, str):
                await self.disconnect(result)

    async def broadcast_authenticated(self, message: dict, exclude_user_id: Optional[int] = None) -> None:
        """向所有已鉴权的连接推送消息（跨数据组）。

        exclude_user_id 不为空时跳过该用户的全部连接：某人登录时，
        只让「除自身以外的其他用户端」看到上线提醒。
        """
        pairs = [
            (cid, self.connections[cid])
            for cid in list(self.connections.keys())
            if cid in self.client_authed
            and self.connections.get(cid) is not None
            and not (exclude_user_id
                     and self.client_user_ids.get(cid) == exclude_user_id)
        ]
        await self._send_concurrently(pairs, message)

    def notify_user_online(self, payload: Dict[str, Any]) -> None:
        """线程安全地广播「用户上线」事件（任意线程可调用，绝不抛异常）。

        单进程内广播（现网 NPT_WORKERS=1）；多 worker 部署时其它 worker 的连接
        收不到，属于已知限制（数据变更推送同样如此）。
        """
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        message = {"type": "user_online", "taskId": "", "data": payload}
        try:
            exclude_user_id = int(payload.get("userId")) if payload.get("userId") else None
        except (TypeError, ValueError):
            exclude_user_id = None

        async def _send() -> None:
            try:
                await self.broadcast_authenticated(message, exclude_user_id=exclude_user_id)
            except Exception as exc:  # noqa: BLE001
                logger.debug(f"用户上线广播失败（忽略）: {exc}")

        try:
            loop.call_soon_threadsafe(lambda: asyncio.create_task(_send()))
        except RuntimeError:
            pass

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

    # ---------------- 协作沟通（IM）定向推送 ----------------
    # WS 只推「有新消息 / 状态变化」的轻量事件，消息正文一律由 REST 游标拉取，
    # 因此即便单进程广播丢通知也不会丢消息（见 docs/协作沟通设计方案.md §2.1）。

    async def send_to_users(self, user_ids, message: dict) -> None:
        """向指定用户的全部已鉴权连接推送（按 user_id 定向，非按数据组）。"""
        targets = {int(uid) for uid in user_ids}
        if not targets:
            return
        pairs = [
            (cid, self.connections[cid])
            for cid in list(self.connections.keys())
            if cid in self.client_authed
            and self.client_user_ids.get(cid) in targets
            and self.connections.get(cid) is not None
        ]
        await self._send_concurrently(pairs, message)

    def has_other_connections(self, user_id: int, exclude_client_id: str) -> bool:
        """该用户是否还有其它已鉴权连接（避免多标签页误判为离线）。"""
        for client_id, uid in self.client_user_ids.items():
            if client_id != exclude_client_id and uid == int(user_id):
                return True
        return False

    def _notify(self, message: dict, *, user_ids=None) -> None:
        loop = self.loop
        if loop is None or loop.is_closed():
            return

        async def _send() -> None:
            try:
                if user_ids is None:
                    await self.broadcast_authenticated(message)
                else:
                    await self.send_to_users(user_ids, message)
            except Exception as exc:  # noqa: BLE001
                logger.debug(f"IM 事件广播失败（忽略）: {exc}")

        try:
            loop.call_soon_threadsafe(lambda: asyncio.create_task(_send()))
        except RuntimeError:
            pass

    def notify_im_message(self, user_ids, payload: Dict[str, Any]) -> None:
        """线程安全：通知会话成员有新消息（只带 id，不带头像/正文）。"""
        self._notify({"type": "im_message", "taskId": "", "data": payload},
                     user_ids=user_ids or [])

    def notify_im_presence(self, payload: Dict[str, Any]) -> None:
        """线程安全：通知全站某用户上线 / 离线。"""
        self._notify({"type": "im_presence", "taskId": "", "data": payload})

    def get_connection_count(self) -> int:
        """获取当前连接数"""
        return len(self.connections)

    def get_subscription_count(self, task_id: str) -> int:
        """获取任务订阅数"""
        return len(self.task_subscriptions.get(task_id, set()))


# 全局单例
websocket_manager = WebSocketManager()