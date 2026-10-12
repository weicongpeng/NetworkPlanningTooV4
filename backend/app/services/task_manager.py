"""
任务管理器 - 用于管理PCI和邻区规划的异步任务
"""

import asyncio
import uuid
import math
import json
import threading
from pathlib import Path
from datetime import datetime
from typing import Dict, Optional, Any, Callable, List
from enum import Enum
import logging
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
import pickle

logger = logging.getLogger(__name__)

from app.models.schemas import (
    TaskStatus,
    PCIConfig,
    NeighborConfig,
    TACConfig,
    NetworkType,
)
from app.algorithms.pci_planning_v1_service import PlanningConfig, run_pci_planning
from app.algorithms.neighbor_planning_v1_service import (
    NeighborConfig as NeighborPlanningConfig,
    run_neighbor_planning,
)
from app.services.data_service import data_service, is_full_params_filename


class TaskType(str, Enum):
    """任务类型"""

    PCI = "pci"
    NEIGHBOR = "neighbor"
    TAC = "tac"  # 核查
    TAC_PLANNING = "tac_planning"  # 规划
    UPDATE_PARAMS = "update_params"  # 工参更新
    APPLY_PCI = "apply_pci"  # PCI应用到工参
    APPLY_TAC_PLANNING = "apply_tac_planning"  # TAC规划应用到工参
    APPLY_PCI_BATCH = "apply_pci_batch"  # PCI批量应用到工参
    APPLY_TAC_PLANNING_BATCH = "apply_tac_planning_batch"  # TAC规划批量应用到工参
    ATTRIBUTE_JOIN = "attribute_join"  # 条件选择（图层属性空间连接）
    BUFFER = "buffer"  # 绘制缓冲区


class Task:
    """任务类"""
    task_id: str
    task_type: TaskType
    config: Any
    status: TaskStatus
    progress: float
    result: Optional[Dict]
    error: Optional[str]
    created_at: datetime
    started_at: Optional[datetime]
    completed_at: Optional[datetime]
    task: Optional[asyncio.Task]

    def __init__(self, task_type: TaskType, config: Any, task_name: Optional[str] = None, user_name: Optional[str] = None,
                 city: Optional[str] = None, operator: Optional[str] = None):
        self.task_id = str(uuid.uuid4())
        self.task_type = task_type
        self.config = config
        self.task_name = task_name
        self.user_name = user_name
        # 任务发起时的（地市+运营商）组快照：执行线程不反查用户表，
        # full_params 解析与任务历史隔离均以此为准
        self.city = city
        self.operator = operator
        self.status = TaskStatus.PENDING
        self.progress = 0.0
        self.result = None
        self.error = None
        self.created_at = datetime.now()
        self.started_at = None
        self.completed_at = None
        self.task = None  # asyncio任务

    def to_dict(self) -> Dict:
        """转换为字典"""
        d = {
            "taskId": self.task_id,
            "status": self.status.value,
            "progress": self.progress,
            "message": self._get_status_message(),
            "error": self.error if self.status == TaskStatus.FAILED else None,
            "created_at": self.created_at.isoformat(),
        }
        # 如有日志消息，附加上
        if hasattr(self, 'log_messages') and self.log_messages:
            d["logMessages"] = self.log_messages
        return d

    def _get_status_message(self) -> str:
        """获取状态消息"""
        if self.status == TaskStatus.PENDING:
            return "任务等待中..."
        elif self.status == TaskStatus.PROCESSING:
            return f"任务进行中... {self.progress:.1f}%"
        elif self.status == TaskStatus.COMPLETED:
            return "任务已完成"
        elif self.status == TaskStatus.FAILED:
            return f"任务失败: {self.error}"
        return ""


class TaskManager:
    """任务管理器"""

    # Excel同步锁：防止后台同步和下载兜底同步同时写入同一文件
    _excel_sync_lock = threading.Lock()

    @staticmethod
    def _sanitize_result(obj: Any) -> Any:
        """递归替换 NaN/Infinity 为 None，确保结果可安全序列化为 JSON"""
        if isinstance(obj, float):
            if math.isnan(obj) or math.isinf(obj):
                return None
            return obj
        elif isinstance(obj, dict):
            return {k: TaskManager._sanitize_result(v) for k, v in obj.items()}
        elif isinstance(obj, (list, tuple)):
            return [TaskManager._sanitize_result(i) for i in obj]
        # 处理 numpy.float64 等类型（通过尝试转换检测）
        try:
            if hasattr(obj, 'dtype'):
                return None  # 非标准数值类型，转为 None
        except Exception:
            pass
        return obj

    def __init__(self):
        self.tasks: Dict[str, Task] = {}
        self.max_tasks = settings.MAX_TASKS
        self.task_timeout = settings.TASK_TIMEOUT
        self._semaphore = asyncio.Semaphore(self.max_tasks)
        # 数据准备缓存，避免同一任务重复读取
        self._data_prep_cache: Dict[str, Any] = {}
        # 持久化索引文件路径
        self._tasks_index_file = settings.OUTPUT_DIR / "tasks_index.json"
        # 启动时从磁盘恢复已完成的任务（支持后端重启后导出历史结果）
        self._load_tasks_index()

        # 进程池引用（由 app lifespan 注入）
        self._process_pool: Optional[ProcessPoolExecutor] = None

    async def _acquire_slot(self):
        """获取信号量槽位"""
        await self._semaphore.acquire()

    def _release_slot(self):
        """释放信号量槽位"""
        self._semaphore.release()

    async def _run_task_with_slot(self, task: Task, run_method):
        """获取信号量槽位，以超时方式运行任务，释放槽位，持久化结果。"""
        acquired = False
        try:
            await self._acquire_slot()
            acquired = True
            await asyncio.wait_for(run_method(task), timeout=self.task_timeout)
        except asyncio.TimeoutError:
            task.status = TaskStatus.FAILED
            task.error = f"任务执行超时（{self.task_timeout}s）"
            task.completed_at = datetime.now()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if task.status != TaskStatus.FAILED:
                task.status = TaskStatus.FAILED
                task.error = str(e)
                task.completed_at = datetime.now()
        finally:
            if acquired:
                self._release_slot()
            self._persist_task(task.task_id)

    # ============================================================
    # ============================================================
    # 任务持久化方法 - 支持后端重启后恢复历史任务
    # ============================================================

    def _get_task_serializable_data(self, task: Task) -> Dict[str, Any]:
        """获取任务的可序列化数据（排除 asyncio.Task 等不可序列化字段）"""
        # config 可能是 Pydantic 模型，需要用 mode='json' 转为 JSON 兼容格式
        config_data = {}
        if task.config is not None:
            try:
                if hasattr(task.config, 'model_dump'):
                    config_data = task.config.model_dump(mode='json')
                elif hasattr(task.config, 'dict'):
                    config_data = task.config.dict()
                else:
                    config_data = {'raw': str(task.config)}
            except Exception as e:
                logger.warning(f'[TaskManager] config 序列化失败: {e}')
                config_data = {'raw': str(task.config)}

        return {
            'task_id': task.task_id,
            'task_type': task.task_type.value if hasattr(task.task_type, 'value') else str(task.task_type),
            'config': config_data,
            'status': task.status.value if hasattr(task.status, 'value') else str(task.status),
            'progress': task.progress,
            'result': self._safe_serialize_result(task.result),
            'error': task.error,
            'task_name': getattr(task, 'task_name', None),
            'user_name': getattr(task, 'user_name', None),
            # （地市+运营商）组快照：恢复内存任务时保留组归属，避免重启后丢组
            'city': getattr(task, 'city', None),
            'operator': getattr(task, 'operator', None),
            'created_at': task.created_at.isoformat() if task.created_at else None,
            'started_at': task.started_at.isoformat() if task.started_at else None,
            'completed_at': task.completed_at.isoformat() if task.completed_at else None,
        }

    def _safe_serialize_result(self, result: Optional[Dict]) -> Optional[Dict]:
        """安全序列化任务结果，处理 numpy/int64/NaN/Infinity 等非 JSON 原生类型"""
        if result is None:
            return None
        try:
            # 先通过 sanitize 去除 NaN/Infinity，再通过 default=str 处理 numpy 类型
            sanitized = self._sanitize_result(result)
            return json.loads(json.dumps(sanitized, ensure_ascii=False, allow_nan=False, default=str))
        except Exception as e:
            logger.warning(f'[TaskManager] result 序列化失败: {e}')
            return {'error': f'result序列化失败: {str(e)}', '_raw': str(result)[:500]}

    def _persist_task(self, task_id: str) -> None:
        """保存单个任务到磁盘索引"""
        try:
            task = self.tasks.get(task_id)
            if task is None:
                return

            serializable_data = self._get_task_serializable_data(task)
            saved_result = serializable_data.get("result")

            if task.result is not None and saved_result is None:
                logger.warning(
                    f"[TaskManager] 任务 {task_id[:8]}... 的 result 序列化失败！"
                    f"原始 result 有 {len(task.result)} 个 key，序列化后为 None。"
                )

            self._tasks_index_file.parent.mkdir(parents=True, exist_ok=True)
            index_data = {}
            if self._tasks_index_file.exists():
                try:
                    with open(self._tasks_index_file, "r", encoding="utf-8") as f:
                        index_data = json.load(f)
                except Exception:
                    index_data = {}

            index_data[task_id] = serializable_data

            with open(self._tasks_index_file, "w", encoding="utf-8") as f:
                json.dump(index_data, f, ensure_ascii=False, indent=2)

            logger.info(f"[TaskManager] 任务已持久化: {task_id[:8]}... type={task.task_type.value} status={task.status.value}")

        except Exception as e:
            import traceback
            logger.error(f"[TaskManager] 保存任务 {task_id[:8] if task_id else '?'}... 索引失败: {e}")
            logger.error(f"[TaskManager] Traceback: {traceback.format_exc()[:500]}")

    def _load_tasks_index(self) -> None:
        """从磁盘恢复已完成的任务元数据（支持后端重启后导出）"""
        if not self._tasks_index_file.exists():
            logger.info(f"[TaskManager] 任务索引文件不存在，将从头开始")
            return
        try:
            with open(self._tasks_index_file, "r", encoding="utf-8") as f:
                index_data = json.load(f)
        except json.JSONDecodeError as e:
            logger.warning(f"[TaskManager] 任务索引文件损坏，将重新创建: {e}")
            return

        recovered = 0
        skipped = 0
        for task_id, task_data in index_data.items():
            status_str = task_data.get("status", "")
            if status_str not in TaskStatus._value2member_map_:
                skipped += 1
                continue

            status = TaskStatus._value2member_map_[status_str]
            if status != TaskStatus.COMPLETED:
                skipped += 1
                continue

            task_type_str = task_data.get("task_type", "")
            if task_type_str not in TaskType._value2member_map_:
                skipped += 1
                continue

            task_type = TaskType._value2member_map_[task_type_str]
            task_result = task_data.get("result")

            if task_result is None:
                logger.warning(
                    f"[TaskManager] 任务 {task_id[:8]}... 已完成但 result 为 None！"
                    f"可能是持久化时序列化失败。请尝试重新运行该规划任务。"
                )

            task = Task(task_type, task_data.get("config", {}),
                        task_name=task_data.get("task_name"),
                        user_name=task_data.get("user_name"),
                        city=task_data.get("city"),
                        operator=task_data.get("operator"))
            task.task_id = task_id
            task.status = status
            task.progress = task_data.get("progress", 100.0)
            task.result = task_result
            task.error = task_data.get("error")
            task.created_at = datetime.fromisoformat(task_data["created_at"]) if task_data.get("created_at") else datetime.now()
            task.started_at = datetime.fromisoformat(task_data["started_at"]) if task_data.get("started_at") else None
            task.completed_at = datetime.fromisoformat(task_data["completed_at"]) if task_data.get("completed_at") else None
            task.task = None

            self.tasks[task_id] = task
            recovered += 1

        logger.info(f"[TaskManager] 从磁盘恢复任务: 成功={recovered}, 跳过={skipped}, 总计={len(index_data)}")

    def set_process_pool(self, pool: Optional[ProcessPoolExecutor]) -> None:
        """设置进程池引用（供 CPU 密集型任务使用）"""
        self._process_pool = pool

    async def _run_in_process_pool(self, fn, *args, **kwargs):
        """在进程池中执行 CPU 密集型函数（降级到线程池作为 fallback）"""
        if self._process_pool is not None:
            try:
                loop = asyncio.get_event_loop()
                return await loop.run_in_executor(self._process_pool, fn, *args, **kwargs)
            except (BrokenProcessPool, pickle.PicklingError, AttributeError) as e:
                logger.warning(f"[TaskManager] 进程池执行失败 ({type(e).__name__})，降级到线程: {e}")
                return await asyncio.to_thread(fn, *args, **kwargs)
        else:
            return await asyncio.to_thread(fn, *args, **kwargs)

    @staticmethod
    def _run_pci_sync(config_dict: dict, sites_data: list, bg_sites: Optional[list]) -> dict:
        """同步执行 PCI 规划（可在进程池中运行，可 pickle）"""
        import asyncio
        # 重建必要的 import 和对象
        from app.algorithms.pci_planning_service_v2 import PlanningConfig, run_pci_planning
        from app.models.schemas import NetworkType

        # 重建 config
        nt = NetworkType(config_dict.get("network_type", "LTE"))
        config = PlanningConfig(
            network_type=nt,
            distance_threshold=config_dict.get("distance_threshold", 3.0),
            pci_modulus=config_dict.get("pci_modulus", 3),
            inherit_modulus=config_dict.get("inherit_modulus", False),
            pci_range=config_dict.get("pci_range"),
        )

        # 使用独立的 event loop 运行异步函数
        loop = asyncio.new_event_loop()
        try:
            asyncio.set_event_loop(loop)
            result = loop.run_until_complete(
                run_pci_planning(config, sites_data, None, bg_sites)
            )
            return result
        finally:
            loop.close()
            asyncio.set_event_loop(None)

    # 数据准备优化辅助方法 (P1-2)
    # ============================================================

    def _resolve_input_datasets(
        self, network_type_str: str, city: Optional[str] = None, operator: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        一次性确定待规划小区和全量工参文件（严格按组隔离）

        优化点: 避免多次调用 list_data() 和重复扫描

        Args:
            network_type_str: 网络类型 ("LTE" 或 "NR")
            city/operator: 数据组快照，不完整时本组视为无数据

        Returns:
            {"target_cells_item": DataItem, "full_params_item": DataItem}
        """
        cache_key = f"datasets_{network_type_str}_{city or ''}_{operator or ''}"
        if cache_key in self._data_prep_cache:
            return self._data_prep_cache[cache_key]

        self._data_prep_cache.clear()
        result = {"target_cells_item": None, "full_params_item": None}
        if not city or not operator:
            self._data_prep_cache[cache_key] = result
            return result
        try:
            data_service.reload_index()
            data_items = data_service.list_data()

            target_cells_item = None
            full_params_item = None
            full_params_upload_time = None

            for item in data_items:
                if item.type.value == "excel":
                    data_info = data_service.index.get(item.id, {})
                    # 仅扫描同组条目
                    if (data_info.get("city"), data_info.get("operator")) != (city, operator):
                        continue
                    file_type = data_info.get("fileType", "")
                    upload_date = data_info.get("uploadDate", "")
                    filename = item.name.lower()

                    # 优先使用 fileType 字段判断
                    if file_type == "target_cells":
                        target_cells_item = item
                    elif file_type == "full_params":
                        if full_params_item is None or (upload_date and (
                            full_params_upload_time is None or upload_date > full_params_upload_time
                        )):
                            full_params_item = item
                            full_params_upload_time = upload_date
                    # 回退到文件名判断
                    elif file_type != "full_params_backup":
                        if filename.startswith("cell-tree-export"):
                            target_cells_item = item
                        elif is_full_params_filename(filename):
                            if full_params_item is None or (upload_date and (
                                full_params_upload_time is None or upload_date > full_params_upload_time
                            )):
                                full_params_item = item
                                full_params_upload_time = upload_date

            result = {
                "target_cells_item": target_cells_item,
                "full_params_item": full_params_item
            }

            # 缓存结果
            self._data_prep_cache[cache_key] = result
            return result

        except Exception as e:
            logger.error(f"解析输入数据集失败: {e}")
            raise

    @staticmethod
    def _resolve_full_params_id(city: Optional[str] = None, operator: Optional[str] = None) -> Optional[str]:
        """在指定（地市+运营商）组内定位最新的 full_params 工参 id。

        严格组隔离：city/operator 不完整时返回 None（绝不回退全局最新，
        否则本组无数据时会读到其他组的工参 PCI/TAC 值）。
        """
        if not city or not operator:
            return None
        found = [
            (_id, _info) for _id, _info in data_service.index.items()
            if isinstance(_info, dict) and _info.get("fileType") == "full_params"
            and (_info.get("city"), _info.get("operator")) == (city, operator)
        ]
        if not found:
            return None
        found.sort(key=lambda x: x[1].get("uploadDate", ""), reverse=True)
        return found[0][0]

    def _group_of_task_id(self, task_id: str) -> tuple:
        """读取已有任务的组快照（用于应用类任务继承规划任务的组）；无则 (None, None)。

        先查内存任务（运行中/本进程），未命中查 SQLite task_results（后端重启后场景）。
        """
        t = self.tasks.get(task_id)
        if t is not None:
            return (getattr(t, "city", None), getattr(t, "operator", None))
        grp = self._group_from_db(task_id)
        return grp if grp is not None else (None, None)

    @staticmethod
    def _group_from_db(task_id: str) -> Optional[tuple]:
        """从 SQLite task_results 读组快照；任务不存在返回 None"""
        try:
            from app.core.database import SessionLocal
            from app.models.database import TaskResult

            db = SessionLocal()
            try:
                row = db.query(TaskResult.city, TaskResult.operator).filter(
                    TaskResult.task_id == task_id
                ).first()
            finally:
                db.close()
            if row is not None:
                return (row.city, row.operator)
        except Exception as e:
            logger.warning(f"[TaskManager] 查询任务组失败({task_id[:8] if task_id else '?'}...): {e}")
        return None

    def get_task_group(self, task_id: str) -> Optional[tuple]:
        """任务组快照（内存任务或 SQLite 持久行）；任务不存在返回 None。

        供端点做跨组访问校验；返回 (None, None) 表示任务存在但无组（旧任务），
        对有组用户同样不可见。
        """
        if task_id in self.tasks:
            t = self.tasks[task_id]
            return (getattr(t, "city", None), getattr(t, "operator", None))
        return self._group_from_db(task_id)

    def _find_full_params_item(self, city: Optional[str] = None, operator: Optional[str] = None) -> Optional[Any]:
        """
        仅查找全量工参文件，不依赖待规划小区文件。

        用于当PCI规划使用前端选中小区时，避免对待规划小区文件的任何依赖。
        city/operator 提供时仅在该组内查找。

        Returns:
            full_params_item: DataItem 或 None
        """
        # 组隔离：必须提供完整组信息，否则直接视为本组无全量工参（禁止全局回退）
        if not city or not operator:
            return None
        try:
            data_service.reload_index()
            data_items = data_service.list_data()

            full_params_item = None
            full_params_upload_time = None

            for item in data_items:
                if item.type.value == "excel":
                    data_info = data_service.index.get(item.id, {})
                    file_type = data_info.get("fileType", "")
                    upload_date = data_info.get("uploadDate", "")
                    filename = item.name.lower()

                    # 仅匹配同组条目
                    if (data_info.get("city"), data_info.get("operator")) != (city, operator):
                        continue

                    if file_type == "full_params":
                        if full_params_item is None or (upload_date and (
                            full_params_upload_time is None or upload_date > full_params_upload_time
                        )):
                            full_params_item = item
                            full_params_upload_time = upload_date
                    elif file_type not in ("target_cells", "full_params_backup"):
                        if is_full_params_filename(filename):
                            if full_params_item is None or (upload_date and (
                                full_params_upload_time is None or upload_date > full_params_upload_time
                            )):
                                full_params_item = item
                                full_params_upload_time = upload_date

            return full_params_item

        except Exception as e:
            logger.error(f"查找全量工参文件失败: {e}")
            raise

    def _extract_target_cell_keys(
        self, target_cells_data: Any, network_type_str: str
    ) -> set:
        """
        从待规划小区数据中提取唯一标识集合

        Args:
            target_cells_data: 待规划小区数据
            network_type_str: 网络类型

        Returns:
            cell_key 集合
        """
        target_cell_keys = set()

        if isinstance(target_cells_data, dict):
            if network_type_str in target_cells_data:
                target_sites = target_cells_data[network_type_str]
                for site in target_sites:
                    site_id = site.get("id", "")
                    for sector in site.get("sectors", []):
                        sector_id = sector.get("id", "")
                        # 处理可能的重复前缀
                        if f"{site_id}_{site_id}" in sector_id:
                            real_sector_id = sector_id.split("_")[-1]
                            cell_key = f"{site_id}_{real_sector_id}"
                        else:
                            cell_key = sector_id
                        target_cell_keys.add(cell_key)
            else:
                # 获取实际可用的网络类型，提供更准确的错误信息
                available_types = list(target_cells_data.keys()) if isinstance(target_cells_data, dict) else []
                if available_types:
                    raise ValueError(
                        f"待规划小区文件中没有{network_type_str}数据。"
                        f"可用的网络类型: {', '.join(available_types)}"
                    )
                else:
                    raise ValueError(f"待规划小区文件中没有{network_type_str}数据，且文件格式异常（无可用网络类型）")
        elif isinstance(target_cells_data, list):
            for site in target_cells_data:
                if site.get("networkType") == network_type_str:
                    site_id = site.get("id", "")
                    for sector in site.get("sectors", []):
                        sector_id = sector.get("id", "")
                        cell_key = f"{site_id}_{sector_id}"
                        target_cell_keys.add(cell_key)
        else:
            raise ValueError(f"待规划小区数据格式不支持: {type(target_cells_data)}")

        return target_cell_keys

    def _build_full_params_index(
        self, full_sites: List[Dict]
    ) -> Dict[str, tuple]:
        """
        为全量工参构建字典索引，实现 O(1) 查找

        优化点: 将 O(n) 的嵌套循环查找降为 O(1) 索引查找

        Args:
            full_sites: 全量工参站点列表

        Returns:
            {cell_key: (site, sector)} 索引字典
        """
        cell_index = {}

        for site in full_sites:
            site_id = site.get("id", "")
            for sector in site.get("sectors", []):
                sector_id = sector.get("id", "")
                # 生成多种可能的 cell_key 格式
                cell_keys = [
                    f"{site_id}_{sector_id}",  # site_id_cell_id 格式
                    sector_id,  # 仅 cell_id 格式
                ]
                for cell_key in cell_keys:
                    cell_index[cell_key] = (site, sector)

        return cell_index

    def _match_cells_with_index(
        self, target_cell_keys: set, cell_index: Dict[str, tuple]
    ) -> List[Dict]:
        """
        使用索引匹配小区并生成 sites_data

        优化点: O(1) 索引查找替代 O(n) 嵌套循环

        Args:
            target_cell_keys: 待规划小区的 cell_key 集合
            cell_index: full_params 索引字典

        Returns:
            合并后的站点列表
        """
        combined_sites = {}
        matched_keys = set()  # 记录已匹配的keys

        # 遍历集合的副本，避免"迭代时修改集合"错误
        for cell_key in list(target_cell_keys):
            if cell_key in cell_index:
                site, sector = cell_index[cell_key]
                site_id = site.get("id", "")

                if site_id not in combined_sites:
                    combined_site = {
                        "id": site_id,
                        "name": site.get("name", f"Site_{site_id}"),
                        "longitude": site.get("longitude", 0.0),
                        "latitude": site.get("latitude", 0.0),
                        "networkType": site.get("networkType", "LTE"),
                        "sectors": [],
                    }
                    if site.get("managedElementId"):
                        combined_site["managedElementId"] = site.get("managedElementId")
                    combined_sites[site_id] = combined_site

                combined_sites[site_id]["sectors"].append(sector)
                matched_keys.add(cell_key)

        # 报告未找到的小区
        unmatched_keys = target_cell_keys - matched_keys
        if unmatched_keys:
            logger.warning(f"以下待规划小区未在全量工参中找到: {unmatched_keys}")

        return list(combined_sites.values())

    # ============================================================
    # 原有方法
    # ============================================================

    def _validate_pci_data_files(
        self,
        network_type: NetworkType,
        skip_target_cells: bool = False,
        city: Optional[str] = None,
        operator: Optional[str] = None,
    ) -> None:
        """
        验证PCI规划所需的数据文件（严格按（地市+运营商）组隔离）

        Args:
            network_type: 网络类型(LTE或NR)
            skip_target_cells: 是否跳过待规划小区文件检查（当使用前端选中的小区时可跳过）
            city/operator: 任务组快照，只在本组内查找数据文件

        Raises:
            ValueError: 当数据文件缺失或不符合要求时
        """
        logger.info(f"[TaskManager] 开始验证PCI数据文件, network_type={network_type}, "
                    f"skip_target_cells={skip_target_cells}, group=({city}/{operator})")

        # 1. 检查文件存在性（仅同组条目）
        data_items = data_service.list_data()
        target_cells_file = None
        full_params_file = None

        for item in data_items:
            data_info = data_service.index.get(item.id, {})
            if (data_info.get("city"), data_info.get("operator")) != (city, operator):
                continue
            filename = item.name.lower()
            if filename.startswith("cell-tree-export"):
                target_cells_file = item
            elif is_full_params_filename(filename):
                full_params_file = item

        # 2. 验证文件存在
        if not skip_target_cells and not target_cells_file:
            raise ValueError(
                "未找到待规划小区文件。请上传文件名以'cell-tree-export'开头的Excel文件。"
            )
        if not full_params_file:
            raise ValueError(
                "未找到全量工参文件。请上传文件名以'ProjectParameter'开头的Excel文件。"
            )

        # 3. 验证数据完整性 - 当skip_target_cells=True时跳过待规划小区数据的验证
        if not skip_target_cells:
            logger.info(f"[TaskManager] 找到数据文件: 待规划={target_cells_file.name}, 全量工参={full_params_file.name}")

            try:
                target_data = data_service.get_data(target_cells_file.id)
                if not target_data:
                    raise ValueError("待规划小区文件数据为空")

                network_type_str = network_type.value

                # 处理两种数据结构：{'LTE': [...], 'NR': [...]} 或 [site1, site2, ...]
                sites_data = []
                if isinstance(target_data, dict):
                    # 新结构：{"LTE": [...], "NR": [...]}
                    if network_type_str in target_data:
                        sites_data = target_data[network_type_str]
                        logger.info(f"[TaskManager] 数据为新格式(字典)，找到{len(sites_data)}个站点")
                    else:
                        # 网络类型不存在
                        available_types = list(target_data.keys())
                        raise ValueError(
                            f"待规划小区文件中未找到{network_type_str}网络数据。"
                            f"可用的网络类型: {', '.join(available_types)}"
                        )
                elif isinstance(target_data, list):
                    # 旧结构：直接是站点列表
                    sites_data = target_data
                    logger.info(f"[TaskManager] 数据为旧格式(列表)，找到{len(sites_data)}个站点")
                else:
                    raise ValueError(f"不支持的数据格式: {type(target_data)}")

                # 检查数据是否为空
                if not sites_data or len(sites_data) == 0:
                    raise ValueError(
                        f"{network_type_str}网络数据为空。请检查数据文件是否包含有效的站点数据。"
                    )

                # 4. 验证数据结构完整性（检查第一个站点）
                first_site = sites_data[0]

                # 检查站点级别必需字段
                if 'id' not in first_site or first_site['id'] is None:
                    raise ValueError("站点数据缺少必需字段: id")

                # 检查sectors字段
                if 'sectors' not in first_site:
                    raise ValueError("站点数据缺少必需字段: sectors")

                sectors = first_site.get('sectors', [])
                if not sectors or len(sectors) == 0:
                    raise ValueError("站点没有小区数据(sectors为空)")

                # 检查第一个小区的必需字段
                first_sector = sectors[0]
                required_fields = ['id', 'longitude', 'latitude', 'azimuth']
                missing_fields = [
                    field for field in required_fields
                    if field not in first_sector or first_sector[field] is None
                ]

                if missing_fields:
                    raise ValueError(
                        f"小区数据缺少必需字段: {', '.join(missing_fields)}。"
                        f"请确保数据包含以下字段: {', '.join(required_fields)}"
                    )

                # 统计总小区数
                total_sectors = sum(len(site.get('sectors', [])) for site in sites_data)
                logger.info(
                    f"[TaskManager] 数据验证通过: {network_type_str}网络包含{len(sites_data)}个站点，{total_sectors}个小区"
                )

            except ValueError:
                raise
            except Exception as e:
                logger.error(f"[TaskManager] 数据验证失败: {str(e)}")
                raise ValueError(
                    f"数据文件验证失败: {str(e)}。请确保上传的Excel文件格式正确。"
                )
        else:
            # skip_target_cells=True时只记录全量工参文件信息
            if full_params_file:
                logger.info(f"[TaskManager] 已跳过待规划小区文件验证（使用前端选中小区），仅验证全量工参: {full_params_file.name}")

    @staticmethod
    def _resolve_group_by_user_name(user_name: Optional[str]) -> Optional[tuple]:
        """按用户名查（地市+运营商）组；用户不存在或组信息缺失返回 None。

        任务创建兜底盖章：端点未显式传组时，按发起人归属组落章，
        避免任务结果行组为 NULL 被误归主管理员组（历史任务跨组串数据根因）。
        """
        if not user_name:
            return None
        try:
            from app.core.database import SessionLocal
            from app.models.database import User

            db = SessionLocal()
            try:
                row = db.query(User.city, User.operator).filter(User.username == user_name).first()
            finally:
                db.close()
            if row and row.city and row.operator:
                return (row.city, row.operator)
        except Exception as e:
            logger.warning(f"[TaskManager] 按用户名解析组失败({user_name}): {e}")
        return None

    @staticmethod
    def _task_group(city: Optional[str], operator: Optional[str], user_name: Optional[str]) -> tuple:
        """确定任务组快照：显式传入优先，缺失时按发起人解析，最终可为 (None, None)"""
        if city and operator:
            return (city, operator)
        resolved = TaskManager._resolve_group_by_user_name(user_name)
        if resolved:
            return resolved
        return (city, operator)

    async def create_pci_task(self, config: PCIConfig, task_name: Optional[str] = None, user_name: Optional[str] = None,
                              city: Optional[str] = None, operator: Optional[str] = None) -> str:
        """创建PCI规划任务 - 增强数据验证"""
        logger.info(f"[TaskManager] 创建PCI任务, config: {config}, task_name: {task_name}, user_name: {user_name}")
        city, operator = self._task_group(city, operator, user_name)

        # **新增**: 预验证数据文件
        try:
            # 如果提供了selectedCellIds，验证可以跳过待规划小区文件的检查
            has_selected_cells = config.selectedCellIds and len(config.selectedCellIds) > 0
            self._validate_pci_data_files(
                config.networkType, skip_target_cells=has_selected_cells,
                city=city, operator=operator,
            )
        except ValueError as e:
            logger.error(f"[TaskManager] 数据文件验证失败: {str(e)}")
            raise

        # 创建任务（携带任务名称和用户名）
        task = Task(TaskType.PCI, config, task_name=task_name, user_name=user_name, city=city, operator=operator)
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)
        logger.info(f"[TaskManager] 任务创建成功, task_id: {task.task_id}")

        # 启动任务（含信号量准入和超时保护）
        task.task = asyncio.create_task(self._run_task_with_slot(task, self._run_pci_task))
        logger.info(f"[TaskManager] 异步任务已启动")

        return task.task_id

    async def create_neighbor_task(self, config: NeighborConfig, task_name: Optional[str] = None, user_name: Optional[str] = None,
                                   city: Optional[str] = None, operator: Optional[str] = None) -> str:
        """创建邻区规划任务"""
        logger.info(f"[TaskManager] 创建邻区任务, task_name: {task_name}, user_name: {user_name}")
        city, operator = self._task_group(city, operator, user_name)

        # 创建任务（携带任务名称和用户名）
        task = Task(TaskType.NEIGHBOR, config, task_name=task_name, user_name=user_name, city=city, operator=operator)
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)

        # 启动任务（含信号量准入和超时保护）
        task.task = asyncio.create_task(self._run_task_with_slot(task, self._run_neighbor_task))

        return task.task_id

    async def create_tac_task(self, config: TACConfig, task_name: Optional[str] = None, user_name: Optional[str] = None,
                              city: Optional[str] = None, operator: Optional[str] = None) -> str:
        """创建TAC核查任务"""
        logger.info(f"[TaskManager] 创建TAC核查任务, task_name: {task_name}, user_name: {user_name}")
        city, operator = self._task_group(city, operator, user_name)

        # 创建任务（携带任务名称和用户名）
        task = Task(TaskType.TAC, config, task_name=task_name, user_name=user_name, city=city, operator=operator)
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)

        # 启动任务（含信号量准入和超时保护）
        task.task = asyncio.create_task(self._run_task_with_slot(task, self._run_tac_task))
        logger.info(f"[TaskManager] TAC核查任务已启动, task_id: {task.task_id}")

        return task.task_id

    async def create_tac_planning_task(self, config: TACConfig, task_name: Optional[str] = None, user_name: Optional[str] = None,
                                       city: Optional[str] = None, operator: Optional[str] = None) -> str:
        """创建TAC规划任务（数据型）"""
        logger.info(f"[TaskManager] 创建TAC规划任务, task_name: {task_name}, user_name: {user_name}")
        city, operator = self._task_group(city, operator, user_name)

        # 创建任务（携带任务名称和用户名）
        task = Task(TaskType.TAC_PLANNING, config, task_name=task_name, user_name=user_name, city=city, operator=operator)
        self.tasks[task.task_id] = task

        # 启动任务（含信号量准入和超时保护）
        task.task = asyncio.create_task(self._run_task_with_slot(task, self._run_tac_planning_task))

        return task.task_id

    async def _run_pci_task(self, task: Task):
        """运行PCI规划任务"""
        logger.info(f"[TaskManager] _run_pci_task 开始执行, task_id: {task.task_id}")
        try:
            task.status = TaskStatus.PROCESSING
            task.started_at = datetime.now()
            logger.info(f"[TaskManager] 任务状态设置为 PROCESSING")

            # 获取配置
            config = task.config
            logger.info(
                f"[TaskManager] 配置: networkType={config.networkType}, distance={config.distanceThreshold}, inheritModulus={config.inheritModulus}"
            )

            # 创建规划配置
            # 处理PCI范围
            pci_range = None
            if hasattr(config, "pciRange") and config.pciRange:
                pci_range = (config.pciRange.min, config.pciRange.max)
                logger.info(f"[TaskManager] 使用自定义PCI范围: {pci_range}")

            planning_config = PlanningConfig(
                network_type=config.networkType.value,
                reuse_distance_km=config.distanceThreshold,
                inherit_mod=config.inheritModulus,
                pci_range=pci_range,
            )

            # 获取数据 - 使用优化后的数据准备方法 (P1-2)
            sites_data = []
            network_type_str = config.networkType.value  # "LTE" 或 "NR"

            try:
                # 检查是否使用前端选中的小区
                has_selected_cells = hasattr(config, 'selectedCellIds') and config.selectedCellIds and len(config.selectedCellIds) > 0

                if not has_selected_cells:
                    raise ValueError("请在小区选择列表中至少选择一个小区后再执行PCI规划")

                # 使用前端选中的小区ID
                logger.info(f"[TaskManager] PCI规划: 使用前端选中的小区, 数量={len(config.selectedCellIds)}")
                target_cell_keys = set(config.selectedCellIds)

                # 只查找全量工参文件（按任务组快照隔离）
                full_params_item = self._find_full_params_item(task.city, task.operator)
                if not full_params_item:
                    raise ValueError("未找到全量工参文件（前缀为'ProjectParameter'的Excel文件）")

                full_params_data = data_service.get_data(full_params_item.id)
                logger.info(f"[TaskManager] PCI规划: 使用全量工参文件: {full_params_item.name}")

                if not full_params_data:
                    raise ValueError("全量工参文件为空")

                logger.info(f"共找到 {len(target_cell_keys)} 个待规划小区")
                if not target_cell_keys:
                    raise ValueError(f"没有{network_type_str}类型的待规划小区数据")

                # 4. 从全量工参中提取站点列表
                full_sites = []
                if isinstance(full_params_data, dict):
                    if network_type_str in full_params_data:
                        full_sites = full_params_data[network_type_str]
                    else:
                        raise ValueError(f"全量工参文件中没有{network_type_str}数据")
                elif isinstance(full_params_data, list):
                    full_sites = [
                        site
                        for site in full_params_data
                        if site.get("networkType") == network_type_str
                    ]
                else:
                    raise ValueError(f"全量工参数据格式不支持: {type(full_params_data)}")

                logger.info(f"从全量工参文件加载 {len(full_sites)} 个{network_type_str}站点")

                # 5. 使用索引优化匹配（P1-2: O(n) -> O(1) 查找）
                cell_index = self._build_full_params_index(full_sites)
                sites_data = self._match_cells_with_index(target_cell_keys, cell_index)

                logger.info(
                    f"生成了 {len(sites_data)} 个待规划站点，包含 {sum(len(s.get('sectors', [])) for s in sites_data)} 个小区"
                )

            except Exception as e:
                logger.error(f"获取数据失败: {e}")
                import traceback

                traceback.print_exc()
                raise

            if not sites_data:
                raise ValueError(
                    f"没有可用的{network_type_str}待规划小区数据，请检查导入的Excel文件"
                )

            # 进度回调（线程安全：GIL 保护 float 赋值）
            def progress_callback(progress: float):
                task.progress = progress

            # 设置初始进度
            task.progress = 0

            # 获取数据目录路径
            from app.core.config import settings
            data_dir = str(settings.DATA_DIR)

            # 检查是否启用TAC规划
            enable_tac_planning = getattr(config, 'enableTACPlanning', False)

            # 在线程池中执行 CPU 密集计算，避免阻塞事件循环
            result = await asyncio.to_thread(
                run_pci_planning,
                planning_config, sites_data, progress_callback, full_sites,
                enable_tac_planning=enable_tac_planning,
                data_dir=data_dir,
                city=task.city,
                operator=task.operator,
            )

            # 完成任务
            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()
            task.result = {
                "taskId": task.task_id,
                "status": "completed",
                "progress": 100,
                "totalSites": result["totalSites"],
                "totalSectors": result["totalSectors"],
                "collisions": result["collisions"],
                "confusions": result["confusions"],
                "results": result["results"],
                "networkType": network_type_str,
                "distanceThreshold": config.distanceThreshold,
                "startTime": task.started_at.isoformat(),
                "endTime": task.completed_at.isoformat(),
            }
            self._persist_task(task.task_id)
            self._save_task_result_to_db(task)
        except Exception as e:
            task.status = TaskStatus.FAILED
            task.error = str(e)
            task.completed_at = datetime.now()

    async def _run_neighbor_task(self, task: Task):
        """运行邻区规划任务"""
        try:
            task.status = TaskStatus.PROCESSING
            task.started_at = datetime.now()

            # 获取配置
            config = task.config

            # 从planningType解析sourceType和targetType
            source_type = config.sourceType  # 使用property方法
            target_type = config.targetType  # 使用property方法

            logger.info(
                f"[TaskManager] 邻区规划: planningType={config.planningType}, sourceType={source_type}, targetType={target_type}"
            )

            # 创建规划配置
            planning_config = NeighborPlanningConfig(
                source_type=source_type.value,
                target_type=target_type.value,
                max_neighbors=config.maxNeighbors,
                coverage_distance_factor=config.coverageDistanceFactor,
                coverage_radius_factor=config.coverageRadiusFactor,
                dense_spacing_threshold_km=config.denseSpacingThreshold,
                dense_multiplier=config.denseMultiplier,
                outdoor_to_indoor_max_km=config.outdoorToIndoorMaxDistance,
                indoor_to_indoor_radius_km=config.indoorToIndoorRadius,
                indoor_to_outdoor_multiplier=config.indoorToOutdoorMultiplier,
                outdoor_spacing_site_count=config.outdoorSpacingSiteCount,
            )

            source_network_str = source_type.value
            target_network_str = target_type.value
            
            source_sites = []
            target_sites = []
            target_cell_keys = set()

            try:
                data_items = data_service.list_data()
                cell_tree_item = None
                full_params_item = None

                # 1. 查找全量工参文件（严格组隔离：仅同组条目）
                for item in data_items:
                    if item.type.value == "excel":
                        _info = data_service.index.get(item.id, {})
                        if (_info.get("city"), _info.get("operator")) != (task.city, task.operator):
                            continue
                        fname = item.name.lower()
                        if is_full_params_filename(fname):
                            full_params_item = item

                if not full_params_item:
                    raise ValueError("未找到全量工参文件 (文件名需以 ProjectParameter 开头)")

                # 2. 确定待规划小区来源
                if not config.selectedCellIds or len(config.selectedCellIds) == 0:
                    raise ValueError("请在小区选择列表中至少选择一个小区后再执行邻区规划")

                logger.info(f"邻区规划: 使用前端选中的小区, 数量={len(config.selectedCellIds)}")
                target_cell_keys = set(config.selectedCellIds)

                logger.info(f"邻区规划: 待规划源小区数量: {len(target_cell_keys)}")
                if not target_cell_keys:
                    raise ValueError(f"没有找到 {source_network_str} 类型的待规划小区")

                # 3. 加载全量工参 (获取Source Candidates 和 Target Full Sites)
                logger.info(f"邻区规划: 加载全量工参 {full_params_item.name}")
                full_params_data = data_service.get_data(full_params_item.id)
                
                source_candidates = []
                target_candidates = []
                
                # 解析工参
                def get_sites_from_params(data, net_type):
                    if isinstance(data, dict):
                        return data.get(net_type, [])
                    elif isinstance(data, list):
                        return [s for s in data if s.get("networkType") == net_type]
                    return []

                source_candidates = get_sites_from_params(full_params_data, source_network_str)
                target_candidates = get_sites_from_params(full_params_data, target_network_str)

                if not source_candidates:
                    raise ValueError(f"全量工参中没有 {source_network_str} 数据")
                if not target_candidates:
                    raise ValueError(f"全量工参中没有 {target_network_str} 数据")

                # 对目标候选站点进行去重（针对NR-NR邻区规划）
                # 使用 "gNodeB标识 + 小区标识" 作为唯一键去重，避免PLMN不同导致的重复
                if target_network_str == "NR":
                    logger.info(f"邻区规划: 对NR目标候选站点进行去重，去重前数量: {len(target_candidates)}")
                    deduplicated_target_candidates = []
                    seen_sectors = set()  # 用于追踪已处理的 sector 唯一键

                    for site in target_candidates:
                        site_id = site.get("id", "")
                        deduplicated_sectors = []

                        for sector in site.get("sectors", []):
                            sector_id = sector.get("id", "")
                            # 构建唯一键: gNodeB标识 + 小区标识
                            # 注意：sector_id 可能已经是 "siteId_sectorId" 格式，需要处理
                            if "_" in str(sector_id):
                                # 如果 sector_id 包含下划线，提取实际的小区标识部分
                                parts = str(sector_id).split("_")
                                if len(parts) >= 2:
                                    actual_site_id = parts[0]
                                    actual_cell_id = parts[-1]
                                    unique_key = f"{actual_site_id}_{actual_cell_id}"
                                else:
                                    unique_key = f"{site_id}_{sector_id}"
                            else:
                                unique_key = f"{site_id}_{sector_id}"

                            if unique_key not in seen_sectors:
                                seen_sectors.add(unique_key)
                                deduplicated_sectors.append(sector)
                            else:
                                logger.debug(f"邻区规划: 跳过重复的NR小区: {unique_key}")

                        if deduplicated_sectors:
                            deduplicated_site = {
                                **site,
                                "sectors": deduplicated_sectors
                            }
                            deduplicated_target_candidates.append(deduplicated_site)

                    target_candidates = deduplicated_target_candidates
                    logger.info(f"邻区规划: NR目标候选站点去重完成，去重后数量: {len(target_candidates)}, 唯一小区数: {len(seen_sectors)}")
                    
                # 4. 过滤Source Sites (合并Info)
                # 使用PCI task类似的匹配逻辑
                combined_source_sites = {}
                for site in source_candidates:
                    site_id = site.get("id", "")
                    for sector in site.get("sectors", []):
                        sector_id = sector.get("id", "")
                        
                        # 匹配检查
                        keys_to_check = [f"{site_id}_{sector_id}", sector_id]
                        matched_key = next((k for k in keys_to_check if k in target_cell_keys), None)
                        
                        if matched_key:
                            if site_id not in combined_source_sites:
                                combined_source_sites[site_id] = {
                                    **site,
                                    "sectors": []
                                }
                            combined_source_sites[site_id]["sectors"].append(sector)
                            target_cell_keys.remove(matched_key)
                
                source_sites = list(combined_source_sites.values())
                target_sites = target_candidates # Target直接用全量
                
                logger.info(f"邻区规划: 最终源站点数: {len(source_sites)}, 目标站点数: {len(target_sites)}")
                
                if not source_sites:
                     raise ValueError("无法匹配待规划小区与工参信息，请检查ID一致性")

            except Exception as e:
                logger.error(f"邻区规划数据准备失败: {e}")
                import traceback
                traceback.print_exc()
                raise e

            # 进度回调（线程安全：GIL 保护 float 赋值）
            def progress_callback(progress: float):
                task.progress = progress

            # 记录初始进度，让前端轮询立即看到
            task.progress = 0

            # 在线程池中执行 CPU 密集计算，避免阻塞事件循环
            result = await asyncio.to_thread(
                run_neighbor_planning,
                planning_config, source_sites, target_sites, progress_callback
            )

            # 完成任务
            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()
            task.result = {
                "taskId": task.task_id,
                "status": "completed",
                "progress": 100,
                "totalSites": result["totalSites"],
                "totalSectors": result["totalSectors"],
                "totalNeighbors": result["totalNeighbors"],
                "avgNeighbors": result["avgNeighbors"],
                "results": result["results"],
                "startTime": task.started_at.isoformat(),
                "endTime": task.completed_at.isoformat(),
            }
            self._persist_task(task.task_id)
            self._save_task_result_to_db(task)
        except Exception as e:
            task.status = TaskStatus.FAILED
            task.error = str(e)
            task.completed_at = datetime.now()

    @staticmethod
    def _collect_skipped_cells(
        loaded_skipped: List[Dict],
        used_keys: set,
        selected_ids: set,
    ) -> List[Dict]:
        """汇总「因工参数据不全被跳过核查/规划」的小区，供结果回传前端提示。

        Args:
            loaded_skipped: 加载阶段（load_cells/load_planning_cells）记录的跳过项
            used_keys: 本次实际进入执行链路的小区 key（两种形式：``siteId_sectorId``、``sectorId``）
            selected_ids: 前端选中的小区 id 集合

        Returns:
            [{siteId, siteName, sectorId, sectorName, reason}]，按小区去重
        """
        def _keys_of(site_id, sector_id) -> set:
            sid = "" if sector_id is None else str(sector_id)
            site = "" if site_id is None else str(site_id)
            # 与选中过滤所用的 key 生成方式保持一致
            return {sid, f"{site}_{sid}"}

        collected: List[Dict] = []
        seen_keys: set = set()

        # 1. 加载阶段已记录的跳过项（仅保留本次选中的小区）
        for item in loaded_skipped or []:
            item_keys = _keys_of(item.get("siteId"), item.get("sectorId"))
            if not (item_keys & selected_ids) or (item_keys & seen_keys):
                continue
            seen_keys |= item_keys
            collected.append({
                "siteId": item.get("siteId", ""),
                "siteName": item.get("siteName", ""),
                "sectorId": item.get("sectorId", ""),
                "sectorName": item.get("sectorName", ""),
                "reason": item.get("reason", "missing_coordinates"),
            })

        # 2. 选中但在工参中完全找不到的小区
        for selected_id in selected_ids:
            sid = str(selected_id)
            if sid in used_keys or sid in seen_keys:
                continue
            collected.append({
                "siteId": "",
                "siteName": "",
                "sectorId": sid,
                "sectorName": "",
                "reason": "not_in_params",
            })

        return collected

    @staticmethod
    def _format_skipped_reason_summary(skipped_cells: List[Dict]) -> str:
        """把跳过原因计数拼成可读文案，如「缺经纬度 2 个、工参中未找到 1 个」"""
        counts: Dict[str, int] = {}
        for item in skipped_cells:
            reason = item.get("reason", "missing_coordinates")
            counts[reason] = counts.get(reason, 0) + 1
        labels = (
            ("missing_coordinates", "缺经纬度"),
            ("missing_ids", "缺基站/小区ID"),
            ("not_in_params", "工参中未找到"),
        )
        return "、".join(
            f"{label} {counts[reason]} 个" for reason, label in labels if counts.get(reason)
        )

    async def _run_tac_task(self, task: Task):
        """运行TAC核查任务（基于现网工参）"""
        logger.info(f"[TaskManager] _run_tac_task 开始执行 (核查), task_id: {task.task_id}")
        try:
            task.status = TaskStatus.PROCESSING
            task.started_at = datetime.now()
 
            # 获取配置
            config = task.config
            network_type = config.networkType.value  # "LTE" 或 "NR"

            # 获取插花检测配置
            enable_singularity = getattr(config, "enableSingularityCheck", True)
            singularity_config = getattr(config, "singularityConfig", None)

            logger.info(f"[TaskManager] TAC核查: networkType={network_type}, 插花检测={enable_singularity}")

            # 导入TAC规划服务
            from app.services.tac_planning_service import TACPlanningService
            from app.core.config import settings

            # 执行TAC核查（plan_tac会加载全量工参并进行匹配和插花检测）
            tac_service = TACPlanningService(settings.DATA_DIR, data_service=data_service)

            def progress_callback(progress: float, message: str = ""):
                task.progress = progress

            # 执行TAC核查逻辑（点在面内匹配 + TAC插花检测）
            results, matched_count, unmatched_count, mismatched_count, singularity_count = await asyncio.to_thread(
                tac_service.plan_tac,
                network_type,
                enable_singularity,
                singularity_config,
                progress_callback,
                city=task.city,
                operator=task.operator,
            )

            # 必须提供selectedCellIds，否则报错
            if not config.selectedCellIds or len(config.selectedCellIds) == 0:
                raise ValueError("请在小区选择列表中至少选择一个小区后再执行TAC核查")

            selected_set = set(config.selectedCellIds)

            filtered_results = []
            matched_selected_keys = set()  # 实际命中所选小区并进入核查的 key（两种形式）
            for cell in results:
                sector_id = cell.get("sectorId", "")
                site_id = cell.get("siteId", "")
                cell_key = f"{site_id}_{sector_id}"
                if cell_key in selected_set or sector_id in selected_set:
                    filtered_results.append(cell)
                    matched_selected_keys.add(cell_key)
                    matched_selected_keys.add(str(sector_id))
            results = filtered_results

            # 因工参数据不全（缺经纬度/缺ID）或工参中未找到而被跳过的小区
            skipped_cells = self._collect_skipped_cells(
                getattr(tac_service, "last_load_skipped", []) or [],
                matched_selected_keys,
                selected_set,
            )

            # 选中的小区全部异常时给出明确提示，避免静默产出 0 小区结果
            if not results:
                raise ValueError(
                    f"选中的小区均因工参数据不全被跳过，无可核查小区"
                    f"（共 {len(skipped_cells)} 个：{self._format_skipped_reason_summary(skipped_cells)}）"
                )

            # 重新统计
            total_cells = len(results)
            matched_count = sum(1 for c in results if c.get("matched"))
            unmatched_count = sum(1 for c in results if not c.get("matched"))
            mismatched_count = sum(1 for c in results if c.get("tac") != c.get("existingTac") and c.get("existingTac") is not None)
            singularity_count = sum(1 for c in results if c.get("isSingularity"))
            logger.info(
                f"[TaskManager] TAC核查: 已根据选中小区过滤, 保留{total_cells}个小区, "
                f"跳过{len(skipped_cells)}个工参数据不全的小区"
            )

            # 完成任务
            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()

            task.result = {
                "taskId": task.task_id,
                "status": "completed",
                "progress": 100,
                "networkType": network_type,
                "totalCells": total_cells,
                "matchedCells": matched_count,
                "unmatchedCells": unmatched_count,
                "mismatchedCells": mismatched_count,
                "mismatchedRate": round(mismatched_count / matched_count * 100, 2) if matched_count > 0 else 0,
                "matchingRate": round(matched_count / total_cells * 100, 2) if total_cells > 0 else 0,
                "singularityCount": singularity_count,
                "skippedCells": skipped_cells,
                "skippedCount": len(skipped_cells),
                "results": results,
                "startTime": task.started_at.isoformat() if task.started_at else None,
                "endTime": task.completed_at.isoformat() if task.completed_at else None,
            }
            self._persist_task(task.task_id)
            self._save_task_result_to_db(task)
            logger.info(
                f"[TaskManager] TAC核查完成: total={total_cells}, matched={matched_count}, "
                f"mismatched={mismatched_count}, singularity={singularity_count}"
            )

        except Exception as e:
            import traceback
            traceback.print_exc()
            task.status = TaskStatus.FAILED
            task.error = str(e)
            task.completed_at = datetime.now()
            task.result = {
                "taskId": task.task_id,
                "status": "failed",
                "progress": task.progress,
                "totalCells": 0,
                "matchedCells": 0,
                "unmatchedCells": 0,
                "singularityCount": 0,
                "results": [],
                "startTime": task.started_at.isoformat() if task.started_at else "",
                "endTime": task.completed_at.isoformat() if task.completed_at else None,
                "error": str(e),
            }
 
    async def _run_tac_planning_task(self, task: Task):
        """运行TAC规划任务 (数据驱动型)"""
        logger.info(f"[TaskManager] _run_tac_planning_task 开始执行, task_id: {task.task_id}")
        try:
            task.status = TaskStatus.PROCESSING
            task.started_at = datetime.now()

            # 获取配置
            config = task.config
            network_type = config.networkType.value  # "LTE" 或 "NR"

            logger.info(f"[TaskManager] TAC规划: networkType={network_type}")

            # 导入TAC规划服务
            from app.services.tac_planning_service import TACPlanningService
            from app.services.data_service import data_service
            from app.core.config import settings
 
            # 1. 必须使用前端选中的小区
            if not hasattr(config, 'selectedCellIds') or not config.selectedCellIds or len(config.selectedCellIds) == 0:
                raise ValueError("请在小区选择列表中至少选择一个小区后再执行TAC规划")

            logger.info(f"[TaskManager] TAC规划: 使用前端选中的小区, 数量={len(config.selectedCellIds)}")
            target_cell_keys = set(config.selectedCellIds)

            # 查找全量工参文件（按任务组快照在组内定位；管理员/存量任务回退全局最新）
            full_params_item = self._find_full_params_item(task.city, task.operator)
            full_params_data = None
            if full_params_item is not None:
                full_params_data = data_service.get_data(full_params_item.id)

            if not full_params_data:
                raise ValueError("未找到全量工参文件（文件名需以 ProjectParameter 开头）")

            logger.info(f"[TaskManager] TAC规划: 待规划小区数量={len(target_cell_keys)}")
            
            # 从全量工参中提取匹配的小区信息（带坐标）
            matched_sites = []
            matched_target_keys = set()  # 实际在工参中找到的选中小区 key
            if full_params_data and network_type in full_params_data:
                combined_sites = {}
                # 添加去重字典，防止同一小区被多次添加
                seen_sectors = {}
                for site in full_params_data[network_type]:
                    site_id = site.get("id", "")
                    for sector in site.get("sectors", []):
                        sector_id = sector.get("id", "")
                        possible_keys = [f"{site_id}_{sector_id}", sector_id]

                        matched_key = next((k for k in possible_keys if k in target_cell_keys), None)
                        if matched_key:
                            matched_target_keys.add(matched_key)
                            # 检查是否已添加过该小区（去重）
                            unique_key = f"{site_id}&{sector_id}"
                            if unique_key in seen_sectors:
                                logger.debug(f"[TaskManager] 跳过重复小区: {unique_key}")
                                continue

                            seen_sectors[unique_key] = True

                            if site_id not in combined_sites:
                                combined_sites[site_id] = {
                                    **site,
                                    "sectors": []
                                }
                            combined_sites[site_id]["sectors"].append(sector)
                            # 如果小区有既存TAC，确保保留
                            if "tac" in sector or "existingTac" in sector:
                                sector["existingTac"] = sector.get("existingTac") or sector.get("tac")
                matched_sites = list(combined_sites.values())

            if not matched_sites:
                raise ValueError(
                    f"无法匹配待规划小区与工参坐标信息，请检查ID是否一致"
                    f"（选中的 {len(target_cell_keys)} 个小区均未在全量工参中找到）"
                )

            total_sites = len(matched_sites)
            logger.info(f"[TaskManager] TAC规划: 匹配到带坐标的站点数={total_sites}")

            # 3. 执行规划
            tac_service = TACPlanningService(settings.DATA_DIR, data_service=data_service)

            # 进度回调
            def progress_callback(progress: float, message: str = ""):
                task.progress = progress
                # logger.info(f"[TaskManager] TAC规划进度: {progress}% - {message}")

            # 执行TAC规划
            (
                results,
                planned_count,
                unplanned_count,
            ) = await asyncio.to_thread(
                tac_service.plan_tac_for_list,
                network_type, matched_sites, progress_callback,
                task.city, task.operator,
            )
 
            # 5. 完成任务
            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()

            # 因工参数据不全（缺坐标）或工参中未找到而被跳过的小区
            skipped_cells = self._collect_skipped_cells(
                getattr(tac_service, "last_load_skipped", []) or [],
                matched_target_keys,
                target_cell_keys,
            )

            # 计算TAC错配 (如果存在 existingTac)
            mismatched_count = 0
            for r in results:
                if r.get("matched") and r.get("existingTac"):
                    # 标准化比较
                    t1 = str(r.get("tac", "")).strip().lstrip("0") or "0"
                    t2 = str(r.get("existingTac", "")).strip().lstrip("0") or "0"
                    if t1 != t2:
                        mismatched_count += 1

            task.result = {
                "taskId": task.task_id,
                "status": "completed",
                "progress": 100,
                "networkType": network_type,
                "totalSites": total_sites,
                "totalCells": len(results),
                "matchedCells": planned_count,
                "unmatchedCells": unplanned_count,
                "mismatchedCells": mismatched_count,
                "mismatchedRate": (mismatched_count / planned_count * 100) if planned_count > 0 else 0,
                "matchingRate": (planned_count / len(results) * 100) if results else 0,
                "skippedCells": skipped_cells,
                "skippedCount": len(skipped_cells),
                "results": results,
                "startTime": task.started_at.isoformat() if task.started_at else None,
                "endTime": task.completed_at.isoformat() if task.completed_at else None,
            }
            self._persist_task(task.task_id)
            self._save_task_result_to_db(task)

            logger.info(f"[TaskManager] TAC规划任务完成: matched={planned_count}/{len(results)}")

        except Exception as e:
            import traceback
 
            traceback.print_exc()
            task.status = TaskStatus.FAILED
            task.error = str(e)
            task.completed_at = datetime.now()
            task.result = {
                "taskId": task.task_id,
                "status": "failed",
                "progress": task.progress,
                "totalCells": 0,
                "matchedCells": 0,
                "unmatchedCells": 0,
                "singularityCount": 0,
                "results": [],
                "startTime": task.started_at.isoformat() if task.started_at else "",
                "endTime": task.completed_at.isoformat() if task.completed_at else None,
                "error": str(e),
            }
            logger.error(
                f"[TaskManager] TAC任务失败, task_id: {task.task_id}, error: {e}"
            )

    async def create_update_params_task(
        self, full_param_id: str, current_param_id: str,
        username: str = "", user_id: int = 1,
        city: Optional[str] = None, operator: Optional[str] = None,
    ) -> str:
        """创建工参更新任务"""
        logger.info(f"[TaskManager] 创建工参更新任务: full={full_param_id[:8]}..., current={current_param_id[:8]}...")
        city, operator = self._task_group(city, operator, username or None)

        # 创建任务
        task = Task(TaskType.UPDATE_PARAMS, {
            "fullParamId": full_param_id,
            "currentParamId": current_param_id,
            "username": username,
            "userId": user_id,
        }, user_name=username or None, city=city, operator=operator)
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)
        logger.info(f"[TaskManager] 工参更新任务已创建: {task.task_id}")

        # 启动后台任务（含信号量准入和超时保护）
        task.task = asyncio.create_task(self._run_task_with_slot(task, self._run_update_params_task))
        return task.task_id

    async def _run_update_params_task(self, task: Task):
        """运行工参更新任务"""
        logger.info(f"[TaskManager] _run_update_params_task 开始执行, task_id: {task.task_id}")
        try:
            task.status = TaskStatus.PROCESSING
            task.started_at = datetime.now()
            task.progress = 10

            full_param_id = task.config["fullParamId"]
            current_param_id = task.config["currentParamId"]
            username = task.config.get("username", "")
            user_id = task.config.get("userId", 1)

            # 激活日志捕获，收集后端终端输出
            data_service.start_capture_logs()
            task.log_messages = []

            # 启动后台日志轮询任务（每 0.5 秒收集一次缓冲区）
            async def _poll_logs():
                while task.status == TaskStatus.PROCESSING:
                    lines = data_service.get_and_clear_captured_logs()
                    if lines:
                        if not hasattr(task, 'log_messages'):
                            task.log_messages = []
                        task.log_messages.extend(lines)
                    await asyncio.sleep(0.5)

            poller = asyncio.create_task(_poll_logs())

            # 在线程池中运行同步的耗时操作
            result = await asyncio.to_thread(
                data_service.update_parameters,
                full_param_id, current_param_id,
                username=username, user_id=user_id,
            )

            # 停止日志轮询并收集最后的日志
            poller.cancel()
            try: await poller
            except asyncio.CancelledError: pass
            # 最后一次收集
            lines = data_service.get_and_clear_captured_logs()
            if lines:
                task.log_messages.extend(lines)

            task.progress = 90

            # 清除地图数据缓存
            import app.api.v1.endpoints.map as map_module
            map_module.invalidate_map_data_cache()

            # 停用日志捕获
            data_service.stop_capture_logs()

            # 完成任务
            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()
            task.progress = 100
            task.result = {
                "taskId": task.task_id,
                "status": "completed",
                "progress": 100,
                "newFileId": result.get("newFileId"),
                "newFileName": result.get("newFileName"),
                "savedToOriginal": result.get("savedToOriginal", False),
                # 合并统计（匹配/新增行数）：前端据此告知用户实际更新了多少小区
                "stats": result.get("stats") or {},
            }
            self._persist_task(task.task_id)
            logger.info(f"[TaskManager] 工参更新任务完成: {task.task_id}")
        except Exception as e:
            import traceback
            traceback.print_exc()
            data_service.stop_capture_logs()
            # 异常时也尝试收集日志
            try:
                lines = data_service.get_and_clear_captured_logs()
                if lines and not hasattr(task, 'log_messages'):
                    task.log_messages = lines
            except: pass
            task.status = TaskStatus.FAILED
            task.error = str(e)
            task.completed_at = datetime.now()
            task.progress = task.progress if hasattr(task, 'progress') else 0
            self._persist_task(task.task_id)
            logger.error(f"[TaskManager] 工参更新任务失败: {task.task_id}, error: {e}")

    async def create_attribute_join_task(
        self, cfg: Dict, username: str = "",
        city: Optional[str] = None, operator: Optional[str] = None,
    ) -> str:
        """创建条件选择（图层属性空间连接）任务。data_id 的组访问权由端点在创建前校验。"""
        logger.info(f"[TaskManager] 创建条件选择任务, l1={cfg.get('layer1', {}).get('kind')}, "
                    f"l2={cfg.get('layer2', {}).get('kind')}")
        city, operator = self._task_group(city, operator, username or None)

        task = Task(TaskType.ATTRIBUTE_JOIN, cfg,
                    user_name=username or None, city=city, operator=operator)
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)
        logger.info(f"[TaskManager] 条件选择任务已创建: {task.task_id}")

        task.task = asyncio.create_task(self._run_task_with_slot(task, self._run_attribute_join_task))
        return task.task_id

    async def _run_attribute_join_task(self, task: Task):
        """运行条件选择任务（执行线程用任务组快照，保证扇区按组隔离）"""
        logger.info(f"[TaskManager] _run_attribute_join_task 开始执行, task_id: {task.task_id}")
        try:
            from app.services.attribute_join_service import run_attribute_join

            task.status = TaskStatus.PROCESSING
            task.started_at = datetime.now()
            task.progress = 2

            group = (task.city, task.operator) if task.city else None

            def _progress_cb(p: float, msg: str = ""):
                task.progress = float(p)

            stats = await asyncio.to_thread(run_attribute_join, task.config, group, _progress_cb)

            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()
            task.progress = 100
            task.result = {
                "taskId": task.task_id,
                "status": "completed",
                "progress": 100,
                **stats,
            }
            self._persist_task(task.task_id)
            logger.info(f"[TaskManager] 条件选择任务完成: {task.task_id}")
        except Exception as e:
            import traceback
            traceback.print_exc()
            task.status = TaskStatus.FAILED
            # GBK 安全处理（Windows 终端兼容）
            task.error = str(e).encode("gbk", "replace").decode("gbk")
            task.completed_at = datetime.now()
            self._persist_task(task.task_id)
            logger.error(f"[TaskManager] 条件选择任务失败: {task.task_id}, error: {e}")

    async def create_buffer_task(
        self, cfg: Dict, username: str = "",
        city: Optional[str] = None, operator: Optional[str] = None,
    ) -> str:
        """创建绘制缓冲区任务。data_id 的组访问权由端点在创建前校验。"""
        logger.info(f"[TaskManager] 创建缓冲区任务, source={cfg.get('source', {}).get('kind')}, "
                    f"target={cfg.get('target', {}).get('kind')}")
        city, operator = self._task_group(city, operator, username or None)

        task = Task(TaskType.BUFFER, cfg,
                    user_name=username or None, city=city, operator=operator)
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)
        logger.info(f"[TaskManager] 缓冲区任务已创建: {task.task_id}")

        task.task = asyncio.create_task(self._run_task_with_slot(task, self._run_buffer_task))
        return task.task_id

    async def _run_buffer_task(self, task: Task):
        """运行缓冲区任务（执行线程用任务组快照，保证参考图层按组隔离）"""
        logger.info(f"[TaskManager] _run_buffer_task 开始执行, task_id: {task.task_id}")
        try:
            from app.services.buffer_service import run_buffer

            task.status = TaskStatus.PROCESSING
            task.started_at = datetime.now()
            task.progress = 2

            group = (task.city, task.operator) if task.city else None

            def _progress_cb(p: float, msg: str = ""):
                task.progress = float(p)

            stats = await asyncio.to_thread(run_buffer, task.config, group, _progress_cb)

            stats_full = {
                "taskId": task.task_id,
                "status": "completed",
                "progress": 100,
                **stats,
            }
            # features（装饰目标的全部几何）仅保留在内存结果，不写入历史库：
            # 装饰要素当时已落 localStorage，历史任务重启后无需该字段
            task.result = {
                k: v for k, v in stats_full.items() if k != "features"
            }
            self._persist_task(task.task_id)
            task.result = stats_full
            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()
            task.progress = 100
            task.result = stats_full
            logger.info(f"[TaskManager] 缓冲区任务完成: {task.task_id}")
        except Exception as e:
            import traceback
            traceback.print_exc()
            task.status = TaskStatus.FAILED
            # GBK 安全处理（Windows 终端兼容）
            task.error = str(e).encode("gbk", "replace").decode("gbk")
            task.completed_at = datetime.now()
            self._persist_task(task.task_id)
            logger.error(f"[TaskManager] 缓冲区任务失败: {task.task_id}, error: {e}")

    async def create_apply_pci_to_params_task(self, planning_task_id: str) -> str:
        """创建PCI应用到工参任务"""
        logger.info(f"[TaskManager] 创建PCI应用到工参任务: planning_task={planning_task_id[:8]}...")

        # 检查规划任务是否存在并已完成
        planning_result = self.get_task_result(planning_task_id)
        if planning_result is None:
            raise ValueError("PCI规划任务不存在")
        if planning_result.get("status") != "completed":
            raise ValueError("PCI规划任务尚未完成")

        # 从规划任务继承组快照（执行线程不反查用户表）
        group = self.get_task_group(planning_task_id)
        if not group:
            raise ValueError("无法确定PCI规划任务的数据组")
        city, operator = group

        # 创建任务
        task = Task(TaskType.APPLY_PCI, {
            "planningTaskId": planning_task_id,
        }, city=city, operator=operator)
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)
        logger.info(f"[TaskManager] PCI应用到工参任务已创建: {task.task_id}")

        # 启动后台任务（含信号量准入和超时保护）
        task.task = asyncio.create_task(self._run_task_with_slot(task, self._run_apply_pci_to_params_task))
        return task.task_id

    async def _run_apply_pci_to_params_task(self, task: Task):
        """运行PCI应用到工参任务（Phase 1: SQLite快路径 + Phase 2: 后台Excel更新）"""
        logger.info(f"[TaskManager] _run_apply_pci_to_params_task 开始执行, task_id: {task.task_id}")
        try:
            task.status = TaskStatus.PROCESSING
            task.started_at = datetime.now()
            task.progress = 5

            planning_task_id = task.config["planningTaskId"]
            planning_result = self.get_task_result(planning_task_id)
            if not planning_result:
                raise ValueError("PCI规划任务不存在")
            if planning_result.get("status") != "completed":
                raise ValueError("PCI规划任务尚未完成")

            # 在快路径操作前，捕获 full_params_info 供后台Excel更新使用
            # （按任务组快照在组内定位；管理员/存量任务回退全局最新）
            full_params_item = self._find_full_params_item(task.city, task.operator)
            full_params_info = data_service.index.get(full_params_item.id, {}) if full_params_item is not None else {}

            task.progress = 10

            # 用于线程内进度回传的容器
            progress_holder = [10]

            # === 阶段1: SQLite-only 快路径（线程池，~1-2秒）===
            result = await asyncio.to_thread(
                self._apply_pci_fast_sqlite_only,
                planning_result, progress_holder, logger,
                city=task.city, operator=task.operator
            )

            task.progress = max(progress_holder[0], 90)

            # 清除地图数据缓存
            import app.api.v1.endpoints.map as map_module
            map_module.invalidate_map_data_cache()

            # 完成任务 — 用户此时收到响应
            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()
            task.progress = 100
            task.result = {
                "taskId": task.task_id,
                "status": "completed",
                "progress": 100,
                **result
            }
            self._persist_task(task.task_id)
            self._save_task_result_to_db(task)
            logger.info(f"[TaskManager] PCI应用到工参 Phase 1 完成: {task.task_id}, 更新了 {result.get('updatedCount', 0)} 个小区")

            # 后台同步 Excel 文件（用户点击下载前已完成，下载时直接返回）
            new_data_id = result.get("newFileId", "")
            if new_data_id:
                full_params_info = data_service.index.get(new_data_id, {})
                asyncio.create_task(
                    asyncio.to_thread(
                        self._sync_excel_from_sqlite, new_data_id, logger
                    )
                )

        except Exception as e:
            import traceback
            traceback.print_exc()
            task.status = TaskStatus.FAILED
            task.error = str(e)
            task.completed_at = datetime.now()
            task.progress = task.progress if hasattr(task, 'progress') else 0
            task.result = {"status": "failed", "error": str(e)}
            self._persist_task(task.task_id)
            self._save_task_result_to_db(task)
            logger.error(f"[TaskManager] PCI应用到工参任务失败: {task.task_id}, error: {e}", exc_info=True)

    # ============================================================
    # 批量 PCI 应用到工参（合并多个规划任务结果，一次 SQLite + 一次 Excel 更新）
    # ============================================================

    async def create_apply_pci_batch_task(self, plan_task_ids: List[str]) -> str:
        """创建PCI批量应用到工参任务"""
        logger.info(f"[TaskManager] 创建PCI批量应用到工参任务: {len(plan_task_ids)} 个规划任务")

        # 验证所有规划任务存在且已完成
        for tid in plan_task_ids:
            r = self.get_task_result(tid)
            if r is None:
                raise ValueError(f"规划任务不存在: {tid[:8]}...")
            if r.get("status") != "completed":
                raise ValueError(f"规划任务未完成: {tid[:8]}...")

        # 所有规划任务必须属于同一数据组，应用任务继承该组快照
        groups = {self.get_task_group(tid) for tid in plan_task_ids}
        if len(groups) != 1 or None in groups:
            raise ValueError("规划任务数据组不一致或缺失，无法批量应用")
        city, operator = next(iter(groups))

        task = Task(TaskType.APPLY_PCI_BATCH, {"planTaskIds": plan_task_ids},
                    city=city, operator=operator)
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)
        logger.info(f"[TaskManager] PCI批量应用到工参任务已创建: {task.task_id}")

        task.task = asyncio.create_task(self._run_task_with_slot(task, self._run_apply_pci_batch_task))
        return task.task_id

    async def _run_apply_pci_batch_task(self, task: Task):
        """运行PCI批量应用到工参任务"""
        logger.info(f"[TaskManager] _run_apply_pci_batch_task 开始执行, task_id: {task.task_id}")
        try:
            task.status = TaskStatus.PROCESSING
            task.started_at = datetime.now()
            task.progress = 5

            plan_task_ids = task.config["planTaskIds"]
            logger.info(f"[ApplyPCI-Batch] 收集 {len(plan_task_ids)} 个规划任务的结果")

            # 收集并合并所有规划结果
            merged_results = []  # List of site results
            seen_cells = {}  # { "siteId_sectorId": sector_data } — 后写入覆盖前写入
            network_type = None

            for tid in plan_task_ids:
                r = self.get_task_result(tid)
                if not r or r.get("status") != "completed":
                    logger.warning(f"[ApplyPCI-Batch] 跳过无效任务: {tid[:8]}...")
                    continue
                if network_type is None:
                    network_type = r.get("networkType", "LTE")

                results = r.get("results", [])
                for site in results:
                    site_id = str(site.get("siteId", ""))
                    for sector in site.get("sectors", []):
                        sid = str(sector.get("sectorId", ""))
                        key = f"{site_id}_{sid}"
                        # 后写入覆盖（合并多个任务的结果）
                        if key in seen_cells:
                            existing = seen_cells[key]
                            if sector.get("newPCI") is not None:
                                existing["newPCI"] = sector["newPCI"]
                            if sector.get("tac") is not None:
                                existing["tac"] = sector["tac"]
                        else:
                            seen_cells[key] = {
                                "siteId": site_id,
                                "sectorId": sid,
                                "newPCI": sector.get("newPCI"),
                                "tac": sector.get("tac"),
                            }

            if not seen_cells:
                raise ValueError("所有规划任务结果均为空")

            # 将合并结果重建为 _apply_pci_fast_sqlite_only 期望的格式
            sites_map = {}
            for key, cell in seen_cells.items():
                site_id = cell["siteId"]
                if site_id not in sites_map:
                    sites_map[site_id] = {"siteId": site_id, "sectors": []}
                sites_map[site_id]["sectors"].append({
                    "sectorId": cell["sectorId"],
                    "newPCI": cell.get("newPCI"),
                    "tac": cell.get("tac"),
                })

            merged_planning_result = {
                "results": list(sites_map.values()),
                "networkType": network_type or "LTE",
            }

            total_cells = len(seen_cells)
            logger.info(f"[ApplyPCI-Batch] 合并后共 {total_cells} 个唯一小区需要更新")

            task.progress = 10

            # 捕获 full_params_info 供后台Excel更新使用（按任务组快照定位）
            full_params_item = self._find_full_params_item(task.city, task.operator)
            full_params_info = data_service.index.get(full_params_item.id, {}) if full_params_item is not None else {}

            # === 阶段1: SQLite 快路径 ===
            progress_holder = [10]
            result = await asyncio.to_thread(
                self._apply_pci_fast_sqlite_only,
                merged_planning_result, progress_holder, logger,
                city=task.city, operator=task.operator
            )

            task.progress = max(progress_holder[0], 90)

            # 清除地图数据缓存
            import app.api.v1.endpoints.map as map_module
            map_module.invalidate_map_data_cache()

            # 标记所有源任务为已应用
            for tid in plan_task_ids:
                try:
                    self.mark_task_applied(tid)
                except Exception as e:
                    logger.warning(f"[ApplyPCI-Batch] 标记任务已应用失败: {tid[:8]}..., {e}")

            # 完成任务
            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()
            task.progress = 100
            task.result = {
                "taskId": task.task_id,
                "status": "completed",
                "progress": 100,
                **result
            }
            self._persist_task(task.task_id)
            self._save_task_result_to_db(task)
            logger.info(f"[TaskManager] PCI批量应用到工参 Phase 1 完成: {task.task_id}, 更新了 {result.get('updatedCount', 0)} 个小区")
            # 后台同步 Excel
            new_data_id = result.get("newFileId", "")
            if new_data_id:
                asyncio.create_task(asyncio.to_thread(self._sync_excel_from_sqlite, new_data_id, logger))

        except Exception as e:
            import traceback
            traceback.print_exc()
            task.status = TaskStatus.FAILED
            task.error = str(e)
            task.completed_at = datetime.now()
            task.progress = task.progress if hasattr(task, 'progress') else 0
            task.result = {"status": "failed", "error": str(e)}
            self._persist_task(task.task_id)
            self._save_task_result_to_db(task)
            logger.error(f"[TaskManager] PCI批量应用到工参任务失败: {task.task_id}, error: {e}", exc_info=True)

    def _apply_pci_fast_sqlite_only(self, planning_result: Dict, progress_holder: list, _logger: logging.Logger, city: Optional[str] = None, operator: Optional[str] = None) -> Dict:
        """Phase 1: Direct SQL UPDATE on Sector rows (optimized, no full copy).

        city/operator: 任务组快照，用于组内定位全量工参；None 保持全局行为。"""
        from datetime import datetime
        from app.core.database import SessionLocal
        from app.models.database import Sector, Site, Workbook

        _logger.info(f"[ApplyPCI-Phase1] 开始执行PCI应用到工参（直接UPDATE优化模式）")

        # 获取规划结果
        results = planning_result.get("results", [])
        if not results:
            raise ValueError("规划结果为空")
        network_type = planning_result.get("networkType", "LTE")
        _logger.info(f"[ApplyPCI-Phase1] 规划结果包含 {len(results)} 个站点, 网络类型: {network_type}")

        progress_holder[0] = 15

        # 找到当前的全量工参（按任务组快照组内定位）
        full_params_item = self._find_full_params_item(city, operator)
        full_params_id = full_params_item.id if full_params_item is not None else None

        if not full_params_id:
            raise ValueError("未找到全量工参数据")
        _logger.info(f"[ApplyPCI-Phase1] 找到全量工参: {full_params_id}")

        progress_holder[0] = 20

        # 构建 PCI + TAC 更新映射: {siteId: {sectorId: {pci, tac}}}
        pci_updates = {}
        tac_updates = {}
        has_tac = False
        for site_result in results:
            result_site_id = str(site_result.get("siteId", ""))
            sectors = site_result.get("sectors", [])
            for sector in sectors:
                result_sector_id = str(sector.get("sectorId", ""))
                uid = f"{result_site_id}_{result_sector_id}"
                new_pci = sector.get("newPCI")
                if new_pci is not None:
                    pci_updates[uid] = new_pci
                new_tac = sector.get("tac")
                if new_tac is not None:
                    tac_updates[uid] = str(new_tac)
                    has_tac = True

        _logger.info(f"[ApplyPCI-Phase1] 创建了 {len(pci_updates)} 个PCI更新映射, {len(tac_updates)} 个TAC更新映射")

        progress_holder[0] = 35

        # ====== 核心优化：批量 UPDATE Sector 表（避免 N+1 查询 + LIKE 全表扫描）======
        db = SessionLocal()
        try:
            # 建立 site_id → 主键 映射
            site_pk_map = {}
            for row in db.query(Site).filter(Site.workbook_id == full_params_id).all():
                site_pk_map[row.site_id] = row.id

            # 收集所有待更新的 sector（归一化 sector_id，去掉小数点）
            from sqlalchemy import text
            all_updates = []  # [(site_pk, sector_id, {pci, tac})]
            for site_result in results:
                result_site_id = str(site_result.get("siteId", ""))
                site_pk = site_pk_map.get(result_site_id)
                if site_pk is None:
                    _logger.warning(f"[ApplyPCI-Phase1] 未找到站点 {result_site_id}，跳过")
                    continue

                for sector in site_result.get("sectors", []):
                    sid = str(sector.get("sectorId", ""))
                    # 归一化：与下载端点逻辑一致
                    if "." in sid:
                        try:
                            sid = str(int(float(sid)))
                        except ValueError:
                            pass

                    update_vals = {}
                    new_pci = sector.get("newPCI")
                    new_tac = sector.get("tac")
                    if new_pci is not None:
                        update_vals["pci"] = new_pci
                    if new_tac is not None:
                        update_vals["tac"] = str(new_tac)
                    if update_vals:
                        all_updates.append((site_pk, sid, update_vals))

            if not all_updates:
                _logger.warning("[ApplyPCI-Phase1] 所有站点都未匹配到，跳过更新")
                db.close()
                raise ValueError("未能匹配到任何待更新的站点")

            _logger.info(f"[ApplyPCI-Phase1] 准备批量更新 {len(all_updates)} 个小区")

            # 使用单个 CASE WHEN UPDATE 替代逐条 execute（性能提升 5-10x）
            # 分块以避免 SQLite 参数上限 (SQLITE_MAX_VARIABLE_NUMBER=999)
            pci_updated = 0
            tac_updated = 0
            CHUNK = 150  # 每块 ~150 个小区，每个用 5 个参数 (3 for CASE + 2 for IN)

            for chunk_start in range(0, len(all_updates), CHUNK):
                chunk = all_updates[chunk_start:chunk_start + CHUNK]
                pci_cases = []
                tac_cases = []
                pci_params = {}
                tac_params = {}
                in_pairs = []
                in_params = {}

                for idx, (site_pk, sid, vals) in enumerate(chunk):
                    pair_key = f"sp{idx}_sid{idx}"
                    in_pairs.append(f"(:{pair_key}_spk, :{pair_key}_sid)")
                    in_params[f"{pair_key}_spk"] = site_pk
                    in_params[f"{pair_key}_sid"] = sid

                    if "pci" in vals:
                        when_param = f"pci_when_{idx}"
                        pci_cases.append(f"WHEN (site_id_fk = :{pair_key}_spk AND sector_id = :{pair_key}_sid) THEN :{when_param}")
                        pci_params[when_param] = vals["pci"]

                    if "tac" in vals:
                        when_param = f"tac_when_{idx}"
                        tac_cases.append(f"WHEN (site_id_fk = :{pair_key}_spk AND sector_id = :{pair_key}_sid) THEN :{when_param}")
                        tac_params[when_param] = vals["tac"]

                if not pci_cases and not tac_cases:
                    continue

                set_clauses = []
                all_case_params = {}
                if pci_cases:
                    set_clauses.append(f"pci = CASE {' '.join(pci_cases)} ELSE pci END")
                    all_case_params.update(pci_params)
                if tac_cases:
                    set_clauses.append(f"tac = CASE {' '.join(tac_cases)} ELSE tac END")
                    all_case_params.update(tac_params)

                sql = f"UPDATE sectors SET {', '.join(set_clauses)} WHERE workbook_id = :wb_id AND (site_id_fk, sector_id) IN ({', '.join(in_pairs)})"
                all_params = {"wb_id": full_params_id, **in_params, **all_case_params}

                result = db.execute(text(sql), all_params)
                if result.rowcount:
                    # 近似计数：按照 chunk 中每个 sector 贡献一个计数
                    for _, _, vals in chunk:
                        if "pci" in vals:
                            pci_updated += 1
                        if "tac" in vals:
                            tac_updated += 1

            # 更新 workbook 的 created_at 使其排在最前
            db.query(Workbook).filter(Workbook.id == full_params_id).update({
                "created_at": datetime.now().isoformat()
            })

            db.commit()
            _logger.info(f"[ApplyPCI-Phase1] 批量更新完成: {pci_updated}个PCI, {tac_updated}个TAC")

            if pci_updated + tac_updated == 0:
                raise ValueError("规划结果未匹配到任何小区（0个小区更新），请检查规划小区与全量工参是否一致")
        finally:
            db.close()

        progress_holder[0] = 95

        # 标记数据已被原地更新
        if full_params_id in data_service.index:
            data_service.index[full_params_id]['inplace_updated'] = True
            data_service.index[full_params_id]['applied_pci'] = True
            data_service.index[full_params_id]['excel_synced'] = False  # 下载时从SQLite按需生成
            if has_tac and tac_updated > 0:
                data_service.index[full_params_id]['applied_tac'] = True
                _logger.info(f"[ApplyPCI-Phase1] PCI+TAC联合更新: 同时标记 applied_tac")
            data_service.index[full_params_id]['uploadDate'] = datetime.now().isoformat()
            data_service._save_index()
            data_service._bump_revision(full_params_id)  # 桌面共享模式：同组其他桌面端需同步

        return {
            "success": True,
            "message": f"成功应用PCI规划结果到全量工参，更新了{pci_updated}个小区的PCI"
                       + (f"，同时更新了{tac_updated}个小区的TAC" if tac_updated > 0 else ""),
            "updatedCount": pci_updated + tac_updated,
            "newFileId": full_params_id,
            "oldEntryId": full_params_id,
        }


    @staticmethod
    def _sync_excel_from_sqlite(data_id: str, _logger: logging.Logger) -> None:
        """后台线程：从 SQLite 全量同步 PCI/TAC 到 Excel 文件

        使用 iter_rows 建立行索引 + 直接定位更新，对 18k 行文件约 10-20 秒
        """
        import openpyxl
        from app.core.database import SessionLocal
        from app.models.database import Sector, Site
        from app.core.config import settings

        _logger.info(f"[ExcelSync] 开始后台同步: data_id={data_id}")

        file_path = settings.DATA_DIR / data_id / "original.xlsx"
        if not file_path.exists():
            _logger.warning(f"[ExcelSync] 文件不存在: {file_path}")
            return

        try:
            # 读取 SQLite 中所有 PCI/TAC 值
            updates = {}
            db = SessionLocal()
            try:
                rows = db.query(
                    Site.site_id, Sector.sector_id, Sector.pci, Sector.tac
                ).join(Sector, Sector.site_id_fk == Site.id).filter(
                    Site.workbook_id == data_id
                ).all()
                for row in rows:
                    key = f"{row.site_id}_{row.sector_id}"
                    rec = {}
                    if row.pci is not None:
                        rec["pci"] = row.pci
                    if row.tac is not None:
                        rec["tac"] = row.tac
                    if rec:
                        updates[key] = rec
            finally:
                db.close()

            _logger.info(f"[ExcelSync] SQLite 读取 {len(updates)} 条记录")

            # 持锁避免后台同步和下载兜底同步同时写入同一文件
            with TaskManager._excel_sync_lock:
                wb = openpyxl.load_workbook(file_path)
                total_updated = 0

                for sheet_name in wb.sheetnames:
                    ws = wb[sheet_name]
                    if ws.max_row < 2:
                        continue

                    headers = [str(c.value or "") for c in ws[1]]
                    site_id_col = sector_id_col = pci_col = tac_col = None

                    for i, h in enumerate(headers):
                        hl = h.lower().replace("\n", " ")
                        if site_id_col is None and any(kw in hl for kw in
                            ("enodeb标识", "enodeb id", "gnodeb标识", "gnodeb id",
                             "enb id", "gnb id", "site_id", "siteid", "基站id", "基站标识")):
                            if not any(x in hl for x in ("length", "宽度", "经度", "纬度", "名称", "name")):
                                site_id_col = i
                        if sector_id_col is None and any(kw in hl for kw in
                            ("celllocalid", "sectorid", "localcellid", "sector_id",
                             "小区标识", "小区id")):
                            if not any(x in hl for x in ("名称", "name")):
                                sector_id_col = i
                        if pci_col is None and any(kw in hl for kw in
                            ("pci", "物理小区识别码", "物理小区id", "physicalcellid")):
                            pci_col = i
                        if tac_col is None and any(kw in hl for kw in
                            ("tac", "跟踪区码", "跟踪区域码", "trackingareacode")):
                            tac_col = i

                    if site_id_col is None or sector_id_col is None:
                        _logger.warning(f"[ExcelSync] 工作表 '{sheet_name}' 未找到站点/小区标识列(表头前10: {headers[:10]})，跳过")
                        continue

                    # iter_rows 一次性加载行引用（快速）
                    row_idx: Dict[str, list] = {}
                    for row in ws.iter_rows(min_row=2, values_only=False):
                        sid = str(row[site_id_col].value or "").strip()
                        sec = str(row[sector_id_col].value or "").strip()
                        if "." in sec:
                            try:
                                sec = str(int(float(sec)))
                            except ValueError:
                                pass
                        if sid and sec:
                            key = f"{sid}_{sec}"
                            if key not in row_idx:
                                row_idx[key] = []
                            row_idx[key].append(row)

                    sheet_updated = 0
                    for key, u in updates.items():
                        rows = row_idx.get(key)
                        if not rows:
                            continue
                        for row in rows:
                            if pci_col is not None and u.get("pci") is not None:
                                row[pci_col].value = u["pci"]
                                sheet_updated += 1
                            if tac_col is not None and u.get("tac") is not None:
                                row[tac_col].value = u["tac"]
                                sheet_updated += 1

                    total_updated += sheet_updated
                    _logger.info(f"[ExcelSync] 工作表 '{sheet_name}': 更新 {sheet_updated} 个单元格")

                wb.save(file_path)
                wb.close()

                # 标记 Excel 已同步
                data_service.index[data_id]["excel_synced"] = True
                data_service._save_index()
                _logger.info(f"[ExcelSync] 完成: {file_path}, 共 {total_updated} 处变更")

        except Exception as e:
            import traceback
            _logger.error(f"[ExcelSync] 失败: {e}")
            traceback.print_exc()


    async def _apply_pci_background_excel_update(self, new_data_id: str, old_entry_id: str,
                                                   planning_result: Dict, full_params_info: Dict,
                                                   _logger: logging.Logger) -> None:
        """Phase 2: Background Excel file update."""
        _logger.info(f"[ApplyPCI-Phase2] 开始后台Excel更新任务: new_data_id={new_data_id}")
        try:
            await asyncio.to_thread(
                self._sync_excel_update_only,
                new_data_id, old_entry_id,
                planning_result, full_params_info,
                _logger
            )
            _logger.info(f"[ApplyPCI-Phase2] 后台Excel更新完成: new_data_id={new_data_id}")
        except Exception as e:
            _logger.error(f"[ApplyPCI-Phase2] 后台Excel更新失败: new_data_id={new_data_id}, error={e}", exc_info=True)

    def _sync_excel_update_only(self, new_data_id: str, old_entry_id: str,
                                 planning_result: Dict, full_params_info: Dict,
                                 _logger: logging.Logger) -> None:
        """Synchronous Excel-only update — runs in thread pool."""
        import openpyxl
        import os
        import shutil
        import re
        from pathlib import Path

        _logger.info(f"[SyncExcelUpdate] 开始更新Excel文件PCI: new_data_id={new_data_id}")

        # 原始Excel路径（从旧工参目录）
        original_excel_path = settings.DATA_DIR / old_entry_id / "original.xlsx"
        if not original_excel_path.exists():
            _logger.warning(f"[SyncExcelUpdate] 原始Excel文件不存在，跳过: {original_excel_path}")
            return

        # 新Excel路径（原地更新时 new_data_id==old_entry_id，直接使用原文件）
        new_data_dir = settings.DATA_DIR / new_data_id
        new_data_dir.mkdir(parents=True, exist_ok=True)
        new_excel_path = new_data_dir / "original.xlsx"

        # ⚠️ 当 new_data_id == old_entry_id（原地更新）时，不能 copy2(src, dst) 到同一文件
        # Python 的 copy2 会先以 'wb' 打开目标文件（截断为 0），再读取源文件，
        # 源==目标时文件被清空，后续 openpyxl.load_workbook 读取空文件会失败
        if new_excel_path != original_excel_path:
            shutil.copy2(original_excel_path, new_excel_path)
            _logger.info(f"[SyncExcelUpdate] 已复制Excel到新目录: {new_excel_path}")
        else:
            _logger.info(f"[SyncExcelUpdate] 原地更新，跳过拷贝: {new_excel_path}")

        # 更新Excel文件中的PCI
        results = planning_result.get("results", [])
        if not results:
            _logger.warning("[SyncExcelUpdate] 规划结果为空，跳过PCI更新")
            return
        network_type = planning_result.get("networkType", "LTE")

        pci_updates = {}
        tac_updates = {}
        has_tac = False
        for site_result in results:
            result_site_id = str(site_result.get("siteId", ""))
            for sector in site_result.get("sectors", []):
                new_pci = sector.get("newPCI")
                if new_pci is not None:
                    pci_updates[f"{result_site_id}_{str(sector.get('sectorId', ''))}"] = new_pci
                new_tac = sector.get("tac")
                if new_tac is not None:
                    tac_updates[f"{result_site_id}_{str(sector.get('sectorId', ''))}"] = str(new_tac)
                    has_tac = True

        try:
            wb = openpyxl.load_workbook(new_excel_path)

            target_sheet_name = f"{network_type} Project Parameters"
            if target_sheet_name not in wb.sheetnames:
                for sn in wb.sheetnames:
                    if network_type in sn and "Project" in sn:
                        target_sheet_name = sn
                        break
            if target_sheet_name not in wb.sheetnames:
                wb.close()
                _logger.warning(f"[SyncExcelUpdate] 未找到工作表: {target_sheet_name}")
                return

            ws = wb[target_sheet_name]
            headers = [str(c.value) if c.value else "" for c in ws[1]]

            site_id_col_idx = sector_id_col_idx = pci_col_idx = tac_col_idx = None
            site_kw = ["eNodeB标识", "eNodeB ID", "基站ID", "eNodeB"] if network_type == "LTE" else \
                      ["gNodeB标识", "gNodeB ID", "基站ID", "gNodeB"]
            for kw in site_kw:
                for i, h in enumerate(headers):
                    if kw in h.strip().replace("\n", " ") and "Length" not in h and "宽度" not in h:
                        site_id_col_idx = i
                        break
                if site_id_col_idx is not None:
                    break
            for kw in ["小区标识", "cellLocalId", "SectorID", "小区ID", "LocalCellId"]:
                for i, h in enumerate(headers):
                    if kw in h.strip().replace("\n", " ") and "名称" not in h and "NAME" not in h.upper():
                        sector_id_col_idx = i
                        break
                if sector_id_col_idx is not None:
                    break
            for kw in ["PCI", "物理小区识别码"]:
                for i, h in enumerate(headers):
                    if kw in h.strip().replace("\n", " "):
                        pci_col_idx = i
                        break
                if pci_col_idx is not None:
                    break
            if has_tac:
                for kw in ["TAC", "跟踪区码", "跟踪区域码", "TrackingAreaCode"]:
                    for i, h in enumerate(headers):
                        if kw in h.strip().replace("\n", " "):
                            tac_col_idx = i
                            break
                    if tac_col_idx is not None:
                        break

            if site_id_col_idx is None or sector_id_col_idx is None or pci_col_idx is None:
                wb.close()
                _logger.warning("[SyncExcelUpdate] Excel缺少必需列，跳过")
                return

            pci_updated = 0
            tac_updated = 0
            for row in ws.iter_rows(min_row=2, values_only=False):
                site_id_val = str(row[site_id_col_idx].value) if row[site_id_col_idx].value else ""
                sector_id_val = str(row[sector_id_col_idx].value) if row[sector_id_col_idx].value else ""
                try:
                    if "." in sector_id_val:
                        sector_id_val = str(int(float(sector_id_val)))
                except:
                    pass

                key = f"{site_id_val}_{sector_id_val}"
                # 处理 sector_id_val 本身可能包含下划线的情况
                if key not in pci_updates and key not in tac_updates and "_" in sector_id_val:
                    parts = sector_id_val.split("_")
                    if len(parts) == 2:
                        alt_key = f"{parts[0]}_{parts[1]}"
                        new_pci = pci_updates.get(alt_key)
                        new_tac = tac_updates.get(alt_key)
                    else:
                        new_pci = pci_updates.get(key)
                        new_tac = tac_updates.get(key)
                else:
                    new_pci = pci_updates.get(key)
                    new_tac = tac_updates.get(key)

                if new_pci is not None and row[pci_col_idx].value != new_pci:
                    row[pci_col_idx].value = new_pci
                    pci_updated += 1
                if new_tac is not None and tac_col_idx is not None:
                    cur_tac = str(row[tac_col_idx].value or "").strip()
                    if cur_tac != new_tac:
                        row[tac_col_idx].value = int(new_tac) if new_tac.isdigit() else new_tac
                        tac_updated += 1

            wb.save(new_excel_path)
            wb.close()
            parts = []
            if pci_updated:
                parts.append(f"{pci_updated}个PCI")
            if tac_updated:
                parts.append(f"{tac_updated}个TAC")
            _logger.info(f"[SyncExcelUpdate] Excel已更新 {'、'.join(parts) if parts else '0个小区'}")

            # 更新数据索引 — 标记 Excel 已同步，下载端点可跳过重复的 openpyxl 同步
            if new_data_id in data_service.index:
                data_service.index[new_data_id]["size"] = new_excel_path.stat().st_size
                data_service.index[new_data_id]["excel_synced"] = True
                data_service._save_index()

            # 保存到原始目录
            original_path = full_params_info.get("originalPath", "")
            if original_path and original_path.strip():
                try:
                    original_file_path = os.path.abspath(original_path.strip())
                    original_dir = os.path.dirname(original_file_path)
                    if os.path.exists(original_dir):
                        original_name = full_params_info.get("name", "")
                        name_part, ext_part = os.path.splitext(original_name)
                        clean_name = re.sub(r"_已更新PCI$", "", name_part)
                        clean_name = re.sub(r"_?\d{14}$", "", clean_name)
                        for f in os.listdir(original_dir):
                            if clean_name in f and "_已更新PCI" in f and f.endswith(ext_part):
                                target_path = os.path.join(original_dir, f)
                                shutil.copy2(new_excel_path, target_path)
                                _logger.info(f"[SyncExcelUpdate] 已覆盖原始目录文件: {f}")
                                break
                except Exception as e:
                    _logger.warning(f"[SyncExcelUpdate] 保存到原始目录失败: {e}")

            # 清理旧的 deprecated 工参条目
            if old_entry_id and old_entry_id != new_data_id:
                try:
                    data_service.delete_data(old_entry_id)
                    _logger.info(f"[SyncExcelUpdate] 已清理旧工参: {old_entry_id}")
                except Exception as e:
                    _logger.warning(f"[SyncExcelUpdate] 清理旧工参失败: {old_entry_id}, 错误: {e}")

        except Exception as e:
            _logger.error(f"[SyncExcelUpdate] 更新Excel失败: {e}", exc_info=True)

    async def create_apply_tac_planning_to_params_task(self, planning_task_id: str) -> str:
        """创建TAC规划应用到工参任务"""
        logger.info(f"[TaskManager] 创建TAC规划应用到工参任务: planning_task={planning_task_id[:8]}...")

        # 检查规划任务是否存在并已完成
        planning_result = self.get_task_result(planning_task_id)
        if planning_result is None:
            raise ValueError("TAC规划任务不存在")
        if planning_result.get("status") != "completed":
            raise ValueError("TAC规划任务尚未完成")

        # 从规划任务继承组快照（执行线程不反查用户表）
        group = self.get_task_group(planning_task_id)
        if not group:
            raise ValueError("无法确定TAC规划任务的数据组")
        city, operator = group

        task = Task(TaskType.APPLY_TAC_PLANNING, {
            "planningTaskId": planning_task_id,
        }, city=city, operator=operator)
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)
        logger.info(f"[TaskManager] TAC规划应用到工参任务已创建: {task.task_id}")

        # 启动后台任务（含信号量准入和超时保护）
        task.task = asyncio.create_task(self._run_task_with_slot(task, self._run_apply_tac_planning_to_params_task))
        return task.task_id

    async def _run_apply_tac_planning_to_params_task(self, task: Task):
        """运行TAC规划应用到工参任务"""
        logger.info(f"[TaskManager] _run_apply_tac_planning_to_params_task 开始执行, task_id: {task.task_id}")
        try:
            task.status = TaskStatus.PROCESSING
            task.started_at = datetime.now()
            task.progress = 5

            planning_task_id = task.config["planningTaskId"]
            planning_result = self.get_task_result(planning_task_id)
            if not planning_result:
                raise ValueError("TAC规划任务不存在")
            if planning_result.get("status") != "completed":
                raise ValueError("TAC规划任务尚未完成")

            task.progress = 10

            full_params_item = self._find_full_params_item(task.city, task.operator)
            full_params_info = data_service.index.get(full_params_item.id, {}) if full_params_item is not None else {}

            # 用于线程内进度回传的容器
            progress_holder = [10]

            # === 阶段1: 快路径 — 更新 data.json/SQLite ===
            result = await asyncio.to_thread(
                self._sync_apply_tac_planning_fast,
                planning_result, progress_holder, logger,
                city=task.city, operator=task.operator
            )

            task.progress = max(progress_holder[0], 90)

            # 清除地图数据缓存
            import app.api.v1.endpoints.map as map_module
            map_module.invalidate_map_data_cache()

            # 完成任务
            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()
            task.progress = 100
            task.result = {
                "taskId": task.task_id,
                "status": "completed",
                "progress": 100,
                **result
            }
            self._persist_task(task.task_id)
            self._save_task_result_to_db(task)
            logger.info(f"[TaskManager] TAC规划应用到工参快路径完成: {task.task_id}, 更新了 {result.get('updatedCount', 0)} 个小区")
            # 后台同步 Excel
            new_data_id = result.get("newFileId", "")
            if new_data_id:
                asyncio.create_task(asyncio.to_thread(self._sync_excel_from_sqlite, new_data_id, logger))

        except Exception as e:
            import traceback
            traceback.print_exc()
            task.status = TaskStatus.FAILED
            task.error = str(e)
            task.completed_at = datetime.now()
            task.progress = task.progress if hasattr(task, 'progress') else 0
            task.result = {"status": "failed", "error": str(e)}
            self._persist_task(task.task_id)
            self._save_task_result_to_db(task)
            logger.error(f"[TaskManager] TAC规划应用到工参任务失败: {task.task_id}, error: {e}", exc_info=True)

    # ============================================================
    # 批量 TAC 规划应用到工参
    # ============================================================

    async def create_apply_tac_planning_batch_task(self, plan_task_ids: List[str]) -> str:
        """创建TAC规划批量应用到工参任务"""
        logger.info(f"[TaskManager] 创建TAC规划批量应用到工参任务: {len(plan_task_ids)} 个规划任务")

        for tid in plan_task_ids:
            r = self.get_task_result(tid)
            if r is None:
                raise ValueError(f"规划任务不存在: {tid[:8]}...")
            if r.get("status") != "completed":
                raise ValueError(f"规划任务未完成: {tid[:8]}...")

        # 所有规划任务必须属于同一数据组，应用任务继承该组快照
        groups = {self.get_task_group(tid) for tid in plan_task_ids}
        if len(groups) != 1 or None in groups:
            raise ValueError("规划任务数据组不一致或缺失，无法批量应用")
        city, operator = next(iter(groups))

        task = Task(TaskType.APPLY_TAC_PLANNING_BATCH, {"planTaskIds": plan_task_ids},
                    city=city, operator=operator)
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)
        logger.info(f"[TaskManager] TAC规划批量应用到工参任务已创建: {task.task_id}")

        task.task = asyncio.create_task(self._run_task_with_slot(task, self._run_apply_tac_planning_batch_task))
        return task.task_id

    async def _run_apply_tac_planning_batch_task(self, task: Task):
        """运行TAC规划批量应用到工参任务"""
        logger.info(f"[TaskManager] _run_apply_tac_planning_batch_task 开始执行, task_id: {task.task_id}")
        try:
            task.status = TaskStatus.PROCESSING
            task.started_at = datetime.now()
            task.progress = 5

            plan_task_ids = task.config["planTaskIds"]
            logger.info(f"[TA-Batch] 收集 {len(plan_task_ids)} 个规划任务的结果")

            # 收集并合并所有TAC规划结果（后写入覆盖前写入）
            merged_tac_updates = {}  # { "siteId_sectorId": new_tac }
            merged_results = []  # 重建为 _sync_apply_tac_planning_fast 期望的格式
            network_type = None

            for tid in plan_task_ids:
                r = self.get_task_result(tid)
                if not r or r.get("status") != "completed":
                    logger.warning(f"[TA-Batch] 跳过无效任务: {tid[:8]}...")
                    continue
                if network_type is None:
                    network_type = r.get("networkType", "LTE")

                results = r.get("results", [])
                for item in results:
                    if not item.get("matched"):
                        continue
                    site_id = str(item.get("siteId", ""))
                    sector_id = str(item.get("sectorId", ""))
                    new_tac = item.get("tac")
                    if new_tac is not None and site_id and sector_id:
                        key = f"{site_id}_{sector_id}"
                        merged_tac_updates[key] = new_tac  # 后写入覆盖
                        # 也保留到 merged_results
                        merged_results.append({
                            "siteId": site_id,
                            "sectorId": sector_id,
                            "tac": new_tac,
                            "matched": True,
                        })

            if not merged_tac_updates:
                raise ValueError("所有规划任务结果均为空")

            merged_planning_result = {
                "results": merged_results,
                "networkType": network_type or "LTE",
            }

            total_cells = len(merged_tac_updates)
            logger.info(f"[TA-Batch] 合并后共 {total_cells} 个唯一小区需要更新")

            task.progress = 10

            full_params_item = self._find_full_params_item(task.city, task.operator)
            full_params_info = data_service.index.get(full_params_item.id, {}) if full_params_item is not None else {}

            # === 阶段1: SQLite 快路径 ===
            progress_holder = [10]
            result = await asyncio.to_thread(
                self._sync_apply_tac_planning_fast,
                merged_planning_result, progress_holder, logger,
                city=task.city, operator=task.operator
            )

            task.progress = max(progress_holder[0], 90)

            import app.api.v1.endpoints.map as map_module
            map_module.invalidate_map_data_cache()

            for tid in plan_task_ids:
                try:
                    self.mark_task_applied(tid)
                except Exception as e:
                    logger.warning(f"[TA-Batch] 标记任务已应用失败: {tid[:8]}..., {e}")

            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()
            task.progress = 100
            task.result = {
                "taskId": task.task_id,
                "status": "completed",
                "progress": 100,
                **result
            }
            self._persist_task(task.task_id)
            self._save_task_result_to_db(task)
            logger.info(f"[TaskManager] TAC批量应用到工参 Phase 1 完成: {task.task_id}, 更新了 {result.get('updatedCount', 0)} 个小区")
            # 后台同步 Excel
            new_data_id = result.get("newFileId", "")
            if new_data_id:
                asyncio.create_task(asyncio.to_thread(self._sync_excel_from_sqlite, new_data_id, logger))

        except Exception as e:
            import traceback
            traceback.print_exc()
            task.status = TaskStatus.FAILED
            task.error = str(e)
            task.completed_at = datetime.now()
            task.progress = task.progress if hasattr(task, 'progress') else 0
            task.result = {"status": "failed", "error": str(e)}
            self._persist_task(task.task_id)
            self._save_task_result_to_db(task)
            logger.error(f"[TaskManager] TAC批量应用到工参任务失败: {task.task_id}, error: {e}", exc_info=True)

    def _sync_apply_tac_planning_fast(self, planning_result: Dict, progress_holder: list, _logger: logging.Logger, city: Optional[str] = None, operator: Optional[str] = None) -> Dict:
        """Direct SQL UPDATE on Sector.tac (optimized, no full copy)."""
        from datetime import datetime
        from app.core.database import SessionLocal
        from app.models.database import Sector, Site, Workbook

        _logger.info(f"[TA-Apply] 开始执行TAC应用到工参（直接UPDATE优化模式）")

        results = planning_result.get("results", [])
        if not results:
            raise ValueError("TAC规划结果为空")

        progress_holder[0] = 15

        # 找到当前的全量工参
        full_params_item = self._find_full_params_item(city, operator)
        full_params_id = full_params_item.id if full_params_item is not None else None

        if not full_params_id:
            raise ValueError("未找到全量工参数据")

        progress_holder[0] = 20

        # 构建TAC更新映射
        tac_updates = {}
        for item in results:
            if not item.get("matched"):
                continue
            site_id = str(item.get("siteId", ""))
            sector_id = str(item.get("sectorId", ""))
            new_tac = item.get("tac")
            if new_tac is not None and site_id and sector_id:
                tac_updates[f"{site_id}_{sector_id}"] = new_tac

        _logger.info(f"[TA-Apply] 创建了 {len(tac_updates)} 个TAC更新映射")

        progress_holder[0] = 35

        # ====== 批量 UPDATE Sector 表的 tac 字段（raw SQL + exact match，避免 LIKE 全表扫描）======
        db = SessionLocal()
        try:
            site_pk_map = {}
            for row in db.query(Site).filter(Site.workbook_id == full_params_id).all():
                site_pk_map[row.site_id] = row.id

            from sqlalchemy import text
            all_updates = []
            for item in results:
                if not item.get("matched"):
                    continue
                site_id = str(item.get("siteId", ""))
                sector_id = str(item.get("sectorId", ""))
                new_tac = item.get("tac")
                if new_tac is None:
                    continue

                site_pk = site_pk_map.get(site_id)
                if site_pk is None:
                    continue

                # 归一化 sector_id
                if "." in sector_id:
                    try:
                        sector_id = str(int(float(sector_id)))
                    except ValueError:
                        pass
                all_updates.append((site_pk, sector_id, new_tac))

            # 使用单个 CASE WHEN UPDATE 替代逐条 execute
            updated_count = 0
            CHUNK = 300  # TAC only, 每块 300 个（每小区 3 参数，共 900+）

            for chunk_start in range(0, len(all_updates), CHUNK):
                chunk = all_updates[chunk_start:chunk_start + CHUNK]
                cases = []
                in_pairs = []
                all_params = {}
                for idx, (site_pk, sector_id, new_tac) in enumerate(chunk):
                    pair_key = f"sp{idx}_sid{idx}"
                    in_pairs.append(f"(:{pair_key}_spk, :{pair_key}_sid)")
                    all_params[f"{pair_key}_spk"] = site_pk
                    all_params[f"{pair_key}_sid"] = sector_id
                    val_key = f"tv{idx}"
                    cases.append(f"WHEN (site_id_fk = :{pair_key}_spk AND sector_id = :{pair_key}_sid) THEN :{val_key}")
                    all_params[val_key] = str(new_tac)

                sql = f"UPDATE sectors SET tac = CASE {' '.join(cases)} ELSE tac END WHERE workbook_id = :wb_id AND (site_id_fk, sector_id) IN ({', '.join(in_pairs)})"
                all_params["wb_id"] = full_params_id

                result = db.execute(text(sql), all_params)
                if result.rowcount:
                    updated_count += result.rowcount

            db.query(Workbook).filter(Workbook.id == full_params_id).update({
                "created_at": datetime.now().isoformat()
            })

            db.commit()
            _logger.info(f"[TA-Apply] 批量更新了 {updated_count} 个小区TAC")

            if updated_count == 0:
                raise ValueError("规划结果未匹配到任何小区（0个小区更新），请检查规划小区与全量工参是否一致")
        finally:
            db.close()

        progress_holder[0] = 95

        # 标记数据已被原地更新，导出时使用原始格式仅更新TAC值
        if full_params_id in data_service.index:
            data_service.index[full_params_id]['inplace_updated'] = True
            data_service.index[full_params_id]['applied_tac'] = True
            data_service.index[full_params_id]['excel_synced'] = False  # 下载时从SQLite按需生成
            data_service.index[full_params_id]['uploadDate'] = datetime.now().isoformat()
            data_service._save_index()
            data_service._bump_revision(full_params_id)  # 桌面共享模式：同组其他桌面端需同步

        return {
            "success": True,
            "message": f"成功应用TAC规划结果到全量工参，更新了{updated_count}个小区的TAC",
            "updatedCount": updated_count,
            "newFileId": full_params_id,
            "oldEntryId": full_params_id,
        }


    def _sync_update_excel_tac_background(self, new_data_id: str, planning_result: Dict, full_params_info: Dict, _logger: logging.Logger) -> None:
        """
        后台更新Excel文件中的TAC（在后台线程中运行）
        """
        import openpyxl
        import os
        import shutil
        import re
        from pathlib import Path

        _logger.info(f"[SyncApplyTAC-Background] 开始后台更新Excel文件TAC, data_id: {new_data_id}")

        new_excel_path = settings.DATA_DIR / new_data_id / "original.xlsx"
        if not new_excel_path.exists():
            _logger.warning(f"[SyncApplyTAC-Background] Excel文件不存在，跳过: {new_excel_path}")
            return

        results = planning_result.get("results", [])
        if not results:
            _logger.warning("[SyncApplyTAC-Background] 规划结果为空，跳过")
            return
        network_type = planning_result.get("networkType", "LTE")

        # 重建TAC更新映射
        tac_updates = {}
        for item in results:
            if not item.get("matched"):
                continue
            site_id = str(item.get("siteId", ""))
            sector_id = str(item.get("sectorId", ""))
            new_tac = item.get("tac")
            if new_tac is not None and site_id and sector_id:
                tac_updates[f"{site_id}_{sector_id}"] = new_tac

        try:
            wb = openpyxl.load_workbook(new_excel_path)
            sheet_name = f"{network_type} Project Parameters"
            if sheet_name in wb.sheetnames:
                ws = wb[sheet_name]
                # 找到列名
                header_row = 1
                headers = {}
                for col in range(1, ws.max_column + 1):
                    val = ws.cell(row=header_row, column=col).value
                    if val:
                        headers[str(val).strip().lower()] = col

                # 查找必要列
                site_id_col = headers.get("siteid") or headers.get("site_id")
                sector_id_col = headers.get("sectorid") or headers.get("sector_id")
                tac_col = headers.get("tac")

                if site_id_col and sector_id_col and tac_col:
                    updated = 0
                    for row in range(header_row + 1, ws.max_row + 1):
                        sid = str(ws.cell(row=row, column=site_id_col).value or "")
                        sec_id = str(ws.cell(row=row, column=sector_id_col).value or "")
                        key = f"{sid}_{sec_id}"
                        if key in tac_updates:
                            ws.cell(row=row, column=tac_col).value = tac_updates[key]
                            updated += 1
                    _logger.info(f"[SyncApplyTAC-Background] Excel中更新了 {updated} 个TAC值")
                else:
                    _logger.warning(f"[SyncApplyTAC-Background] 未找到必要列: siteId={site_id_col}, sectorId={sector_id_col}, tac={tac_col}")

                wb.save(new_excel_path)
                _logger.info(f"[SyncApplyTAC-Background] Excel已保存: {new_excel_path}")
                # 标记 Excel 已同步，下载端点可跳过重复的 openpyxl 同步
                if new_data_id in data_service.index:
                    data_service.index[new_data_id]["excel_synced"] = True
                    data_service._save_index()
            else:
                _logger.warning(f"[SyncApplyTAC-Background] 未找到工作表: {sheet_name}")

            # 保存副本到原始目录
            original_path = full_params_info.get("originalPath") if full_params_info else None
            if original_path and original_path.strip():
                try:
                    orig_file_path = os.path.abspath(original_path.strip())
                    orig_dir = os.path.dirname(orig_file_path)
                    if os.path.exists(orig_dir):
                        # 生成新文件名（与快路径一致）
                        timestamp = os.path.basename(str(new_excel_path.parent))
                        new_filename = str(new_excel_path.parent.name) + os.path.splitext(str(original_path))[1]
                        for f in [os.path.join(orig_dir, fn) for fn in os.listdir(orig_dir) if fn.endswith('.xlsx')]:
                            if new_data_id in f or (timestamp and timestamp[:8] in f):
                                shutil.copy2(new_excel_path, f)
                                _logger.info(f"[SyncApplyTAC-Background] 已覆盖原始目录文件: {f}")
                except Exception as e:
                    _logger.warning(f"[SyncApplyTAC-Background] 保存到原始目录失败: {e}")
        except Exception as e:
            _logger.error(f"[SyncApplyTAC-Background] 更新Excel失败: {e}", exc_info=True)

    def _save_task_result_to_db(self, task: Task) -> None:
        """将完成任务的结果持久化到 SQLite"""
        try:
            from app.core.database import SessionLocal
            from app.models.database import TaskResult

            db = SessionLocal()
            try:
                # 使用 sanitize + default=str 确保 NaN/Infinity/numpy 等非 JSON 原生类型也能安全序列化
                safe_result = self._sanitize_result(task.result) if task.result else None
                result_json = json.dumps(safe_result, ensure_ascii=False, allow_nan=False, default=str) if safe_result else None
                config_json = json.dumps(task.config, ensure_ascii=False, default=str) if task.config else None
                cell_count = self._extract_cell_count(safe_result) if safe_result else None

                existing = db.query(TaskResult).filter(TaskResult.task_id == task.task_id).first()
                if existing:
                    existing.result_json = result_json
                    existing.status = task.status.value
                    existing.progress = task.progress
                    if cell_count is not None:
                        existing.cell_count = cell_count
                    existing.task_name = getattr(task, 'task_name', None) or existing.task_name
                    existing.user_name = getattr(task, 'user_name', None) or existing.user_name
                    existing.completed_at = task.completed_at.isoformat() if task.completed_at else None
                    # 组章补齐：行组为 NULL 且任务带组快照时补章（NULL 组行任何人都不可见）
                    if existing.city is None and getattr(task, 'city', None):
                        existing.city = task.city
                        existing.operator = task.operator
                else:
                    db.add(TaskResult(
                        task_id=task.task_id,
                        task_type=task.task_type.value,
                        task_name=getattr(task, 'task_name', None),
                        user_name=getattr(task, 'user_name', None),
                        config_json=config_json,
                        result_json=result_json,
                        status=task.status.value,
                        progress=task.progress,
                        error_message=task.error,
                        cell_count=cell_count,
                        created_at=task.created_at.isoformat() if task.created_at else datetime.now().isoformat(),
                        completed_at=task.completed_at.isoformat() if task.completed_at else None,
                        # 任务发起时的组快照（地市+运营商），决定历史任务组可见性
                        city=getattr(task, 'city', None),
                        operator=getattr(task, 'operator', None),
                    ))
                db.commit()
            finally:
                db.close()
        except Exception as e:
            logger.error(f"[TaskManager] 保存任务结果到 SQLite 失败: {e}")

    def mark_task_applied(self, task_id: str) -> bool:
        """标记任务为已应用（跨用户共享）"""
        try:
            from app.core.database import SessionLocal
            from app.models.database import TaskResult

            db = SessionLocal()
            try:
                existing = db.query(TaskResult).filter(TaskResult.task_id == task_id).first()
                if not existing:
                    logger.warning(f"[TaskManager] 标记应用失败: 任务 {task_id[:8]}... 不存在")
                    return False
                existing.is_applied = 1
                row_city, row_operator = existing.city, existing.operator
                db.commit()
                # 桌面端共享任务：应用标记也要让同组看到（由同步任务上行）
                self._queue_shared_task_update(task_id, existing.task_type)
                # 网页端同组用户的历史列表即时刷新（桌面端另有长轮询指纹兜底）
                self._notify_tasks_changed(row_city, row_operator, task_id)
                # 清除该任务的验证缓存，保证下次读取反映最新状态
                TaskManager._history_verify_cache.pop(task_id, None)
                logger.info(f"[TaskManager] 任务已标记为已应用: {task_id[:8]}...")
                return True
            finally:
                db.close()
        except Exception as e:
            logger.error(f"[TaskManager] 标记任务已应用失败: {e}")
            return False

    @staticmethod
    def _notify_tasks_changed(city: Optional[str], operator: Optional[str], task_id: str = "") -> None:
        """共享任务历史变化（新增/删除/应用标记）→ 通知同组网页端重载历史列表。"""
        try:
            from app.services.websocket_manager import websocket_manager

            websocket_manager.notify_tasks_changed(city or "", operator or "", task_id)
        except Exception:  # noqa: BLE001
            pass

    # 🔥 优化：_load_current_sector_values 的缓存
    _sector_values_cache: Dict[str, Any] = {}
    _sector_values_cache_time: float = 0
    # TTL 只作兜底（防止未标记的工参变更）；正常的应用操作会设置 inplace_updated 信号精准失效
    _sector_values_cache_ttl: float = 300.0  # 300 秒兜底缓存

    # 🔥 优化：历史任务 isApplied/摘要验证结果缓存
    # key: task_id -> (full_params_id, is_applied, result_summary)
    # full_params_id 变化（全量工参切换）时缓存整体失效；应用/删除任务时按需清除
    _history_verify_cache: Dict[str, tuple] = {}
    _history_verify_cache_max = 300

    # ================================================== 同组任务共享（桌面端同步）

    # 参与同组共享的历史任务类型（规划类）；apply_* 绑定本机工参，不参与共享
    SHARED_TASK_TYPES = ("pci", "neighbor", "tac", "tac_planning")

    @staticmethod
    def _shared_task_meta(row) -> Dict[str, Any]:
        """任务元数据（不含大结果）：桌面端清单与镜像行共用。"""
        return {
            "task_id": row.task_id,
            "task_type": row.task_type,
            "task_name": row.task_name,
            "user_name": row.user_name,
            "status": row.status,
            "is_applied": bool(row.is_applied),
            # 镜像端结果按需拉取，列表「小区数量」只能靠元数据携带
            # （cell_count = -1 是回填哨兵：已计算但结果里没有可用字段）
            "cell_count": row.cell_count if (row.cell_count or 0) > 0 else None,
            "created_at": row.created_at,
            "completed_at": row.completed_at,
            "city": row.city,
            "operator": row.operator,
        }

    def list_shared_tasks(self, city: str, operator: str) -> List[Dict[str, Any]]:
        """（地市+运营商）组内共享的任务历史元数据（倒序，最多 200 条）。"""
        from sqlalchemy import func
        from sqlalchemy.orm import defer

        from app.core.database import SessionLocal
        from app.models.database import TaskResult

        db = SessionLocal()
        try:
            # LENGTH(result_json) 由 SQLite 计算，不会把大结果列取回 Python；
            # 桌面端据此决定是否预拉取结果做「已应用」动态比对（见 sync_tasks）
            rows = (
                db.query(TaskResult, func.length(TaskResult.result_json))
                .options(defer(TaskResult.result_json), defer(TaskResult.config_json))
                .filter(
                    TaskResult.task_type.in_(self.SHARED_TASK_TYPES),
                    TaskResult.city == city,
                    TaskResult.operator == operator,
                )
                .order_by(TaskResult.created_at.desc())
                .limit(200)
                .all()
            )
            items = []
            for row, result_size in rows:
                meta = self._shared_task_meta(row)
                meta["result_size"] = int(result_size) if result_size is not None else 0
                items.append(meta)
            return items
        finally:
            db.close()

    def count_shared_tasks(self, city: str, operator: str) -> int:
        """组内共享任务总数：清单被 LIMIT 截断时，桌面端据此避免误删本地镜像。"""
        from app.core.database import SessionLocal
        from app.models.database import TaskResult

        db = SessionLocal()
        try:
            return int(
                db.query(TaskResult)
                .filter(
                    TaskResult.task_type.in_(self.SHARED_TASK_TYPES),
                    TaskResult.city == city,
                    TaskResult.operator == operator,
                )
                .count()
            )
        finally:
            db.close()

    def get_shared_task_result(self, task_id: str, city: str, operator: str) -> Optional[Dict]:
        """读取组内某任务的结果（组不符或结果缺失返回 None）。"""
        from app.core.database import SessionLocal
        from app.models.database import TaskResult

        db = SessionLocal()
        try:
            row = (
                db.query(TaskResult)
                .filter(
                    TaskResult.task_id == task_id,
                    TaskResult.city == city,
                    TaskResult.operator == operator,
                )
                .first()
            )
            if row is None or not row.result_json:
                return None
            return json.loads(row.result_json)
        finally:
            db.close()

    def upsert_shared_task(self, payload: Dict[str, Any], *, city: str, operator: str) -> Dict[str, Any]:
        """桌面端上行任务（同组共享）：按 task_id 新建或更新元数据与结果。

        只接受规划类任务；结果按需下发，因此这里存全量 result_json 供组内查看/导出。
        """
        from app.core.database import SessionLocal
        from app.models.database import TaskResult

        task_id = str(payload.get("task_id") or "").strip()
        task_type = str(payload.get("task_type") or "").strip()
        if not task_id or task_type not in self.SHARED_TASK_TYPES:
            raise ValueError("任务类型不支持同组共享")

        result = payload.get("result")
        result_json = (
            json.dumps(result, ensure_ascii=False, allow_nan=False, default=str)
            if result is not None
            else None
        )
        # 小数量：优先取客户端显式字段（镜像任务上行时没有完整 result），
        # 其次从完整结果里提取
        cell_count = payload.get("cell_count")
        try:
            cell_count = int(cell_count) if cell_count is not None else None
        except (TypeError, ValueError):
            cell_count = None
        if cell_count is None and result is not None:
            cell_count = self._extract_cell_count(result)
        if cell_count is not None and cell_count < 0:
            cell_count = None  # 哨兵值不回写
        db = SessionLocal()
        try:
            row = db.query(TaskResult).filter(TaskResult.task_id == task_id).first()
            if row is None:
                row = TaskResult(
                    task_id=task_id,
                    task_type=task_type,
                    created_at=str(payload.get("created_at") or datetime.now().isoformat()),
                )
                db.add(row)
            elif row.task_type not in self.SHARED_TASK_TYPES:
                raise ValueError("任务类型不支持同组共享")
            row.task_name = payload.get("task_name") or row.task_name
            row.user_name = payload.get("user_name") or row.user_name
            row.status = str(payload.get("status") or row.status or "completed")
            row.completed_at = payload.get("completed_at") or row.completed_at
            if cell_count is not None:
                row.cell_count = cell_count
            # 应用标记单调置位：桌面端「应用到工参」后上行 is_applied=True 要落库，
            # 否则同组用户在历史列表里看到的永远是未应用（按钮全绿）。
            # 「已应用」没有撤销语义，payload 未带或不带 True 时不回落。
            if payload.get("is_applied"):
                row.is_applied = 1
            if result_json is not None:
                row.result_json = result_json
            # 组以服务器（授权记录的组）为准，防止客户端串组
            row.city = city
            row.operator = operator
            db.commit()
            db.refresh(row)
            # 同组网页端历史列表即时刷新（新增任务 / 应用标记变化）
            self._notify_tasks_changed(city, operator, task_id)
            return self._shared_task_meta(row)
        finally:
            db.close()

    def delete_shared_task(self, task_id: str, city: str, operator: str) -> bool:
        """删除组内某任务（组不符返回 False）。"""
        from app.core.database import SessionLocal
        from app.models.database import TaskResult

        db = SessionLocal()
        try:
            row = (
                db.query(TaskResult)
                .filter(
                    TaskResult.task_id == task_id,
                    TaskResult.city == city,
                    TaskResult.operator == operator,
                    TaskResult.task_type.in_(self.SHARED_TASK_TYPES),
                )
                .first()
            )
            if row is None:
                return False
            db.delete(row)
            db.commit()
            TaskManager._history_verify_cache.pop(task_id, None)
            # 同组网页端历史列表即时刷新
            self._notify_tasks_changed(city, operator, task_id)
            return True
        finally:
            db.close()

    def _fetch_shared_task_result(self, task_id: str) -> Optional[Dict]:
        """桌面端镜像任务：结果不在本机时按需向服务器拉取，成功后写回本机缓存。"""
        try:
            from app.core.config import settings

            if not settings.NPT_DESKTOP:
                return None
            from app.services import desktop_cloud_client as cloud
            from app.services import desktop_sync_service as sync

            if not sync.is_shared():
                return None
            data = cloud.shared_task_result(task_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[TaskManager] 拉取共享任务结果失败（{task_id[:8]}）: {exc}")
            return None
        result = (data or {}).get("result")
        if result is None:
            return None
        try:
            from app.core.database import SessionLocal
            from app.models.database import TaskResult

            db = SessionLocal()
            try:
                row = db.query(TaskResult).filter(TaskResult.task_id == task_id).first()
                if row is not None and not row.result_json:
                    row.result_json = json.dumps(result, ensure_ascii=False, allow_nan=False, default=str)
                    db.commit()
                    # 结果落地后历史列表要重算摘要/应用状态，清掉验证缓存
                    TaskManager._history_verify_cache.pop(task_id, None)
            finally:
                db.close()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[TaskManager] 共享任务结果缓存失败（非致命）: {exc}")
        return result

    @staticmethod
    def _queue_shared_task_update(task_id: str, task_type: Optional[str] = None) -> None:
        """桌面端共享任务元数据变化（如应用标记）→ 记入待上行更新。"""
        try:
            from app.core.config import settings

            if not settings.NPT_DESKTOP:
                return
            if task_type and task_type not in TaskManager.SHARED_TASK_TYPES:
                return
            from app.services import desktop_sync_service as sync

            if not sync.is_shared():
                return
            sync.queue_task_update(task_id)
            # 入队后立刻安排一次上行（防抖 3 秒）：否则要等 1 分钟兜底轮询，
            # 同组用户迟迟看不到「已应用」标记
            sync.schedule_sync()
        except Exception:  # noqa: BLE001
            pass

    @staticmethod
    def _queue_shared_task_delete(task_id: str, task_type: Optional[str] = None) -> None:
        """桌面端本机删除了同组共享任务 → 记入待上行删除（否则下次同步会再拉回来）。"""
        try:
            from app.core.config import settings

            if not settings.NPT_DESKTOP:
                return
            if task_type and task_type not in TaskManager.SHARED_TASK_TYPES:
                return
            from app.services import desktop_sync_service as sync

            if not sync.is_shared():
                return
            sync.queue_task_delete(task_id)
            sync.schedule_sync()
        except Exception:  # noqa: BLE001
            pass

    def list_task_history(self, task_type: Optional[str] = None, page: int = 1, page_size: int = 20, user_name: Optional[str] = None, user=None) -> Dict:
        """从 SQLite 获取历史任务列表（分页），返回 {"tasks": [...], "total": 总数, "page": 当前页, "page_size": 每页条数}

        user 提供时按（地市+运营商）组过滤 TaskResult：所有用户（含管理员）
        一律仅见本组任务，组信息缺失用户不可见任何任务。
        user_name 参数保留兼容（按发起人过滤，通常不与 user 同用）。

        🔥 性能优化：
        - total 单独 COUNT，不受分页截断影响，供前端 badge / 分页栏显示真实任务数
        - 不再返回完整 result（含 results 数组）。单条任务结果可达数 MB，
          一次加载会让响应膨胀到 10+ MB，是历史任务加载慢的根因。
          前端"查看"时通过 /result/{taskId} 按需获取完整结果。
        - result_json 只解析一次，供 isApplied 校验与摘要提取复用
        - 同一任务在 sector 版本未变时缓存 isApplied/摘要，跳过大 result_json 的 json.loads
        """
        try:
            from app.core.database import SessionLocal
            from app.models.database import TaskResult, Sector, Site
            from sqlalchemy.orm import defer

            db = SessionLocal()
            try:
                query = db.query(TaskResult)
                if task_type:
                    query = query.filter(TaskResult.task_type == task_type)
                if user_name:
                    query = query.filter(TaskResult.user_name == user_name)
                # 按（地市+运营商）组隔离：所有用户（含管理员）一律仅见本组任务；
                # 存量 NULL 组任务启动迁移后归主管理员组（与工参数据可见性规则一致）
                if user is not None:
                    from app.services.data_group import group_sql_filter
                    group_filter = group_sql_filter(TaskResult.city, TaskResult.operator, user)
                    if group_filter is not None:
                        query = query.filter(group_filter)
                # 真实总数（不受分页影响）
                total = query.count()
                # 分页：page 从 1 开始
                safe_page = max(1, int(page))
                safe_page_size = max(1, min(100, int(page_size)))
                offset = (safe_page - 1) * safe_page_size
                # 🔥 优化：defer 大 text 列（result_json/config_json 可达数 MB），
                # 避免 ORM 将大列加载进内存拖慢查询。verify 缓存命中时不访问这两列，
                # 仅缓存未命中需要解析结果时才懒加载单条
                results = (
                    query.options(defer(TaskResult.result_json), defer(TaskResult.config_json))
                    .order_by(TaskResult.created_at.desc())
                    .offset(offset).limit(safe_page_size).all()
                )

                # 读取当前全量工参的 sector 实际值，用于动态判断 applied 状态
                # （一律按请求用户的组定位工参；user=None 系统调用保持全局行为）
                from app.services.data_group import user_group as _dg_user_group
                _grp = _dg_user_group(user) or (None, None)
                current_sector_values = self._load_current_sector_values(db, city=_grp[0], operator=_grp[1])
                # 当前全量工参快照（工参 id + 内容指纹）：切换工参条目或工参内容变化时
                # 「已应用」验证缓存整体失效，避免导入新工参后仍按旧值判定
                params_snapshot = TaskManager._sector_values_cache.get("_cache_key") if TaskManager._sector_values_cache else None

                # 🔥 优化：批量预取缓存未命中的 result_json（一次查询），
                # 避免 defer 懒加载在循环中逐条触发 SELECT
                # 缓存键还包含"已应用"标记：桌面端镜像任务由同步改写该标记，
                # 标记变化时必须重算（否则跨端应用状态永远显示旧值）
                miss_ids = [
                    r.task_id for r in results
                    if not (
                        TaskManager._history_verify_cache.get(r.task_id)
                        and TaskManager._history_verify_cache[r.task_id][0] == params_snapshot
                        and len(TaskManager._history_verify_cache[r.task_id]) > 3
                        and TaskManager._history_verify_cache[r.task_id][3] == bool(r.is_applied)
                    )
                ]
                miss_result_map: Dict[str, Optional[str]] = {}
                if miss_ids:
                    miss_rows = db.query(TaskResult.task_id, TaskResult.result_json).filter(TaskResult.task_id.in_(miss_ids)).all()
                    miss_result_map = {rid: rj for rid, rj in miss_rows}

                task_list = []
                for r in results:
                    # 动态检查：对比任务规划结果与当前全量工参的实际 PCI/TAC 值
                    # 如果一致则视为已应用（即使标记为未应用），如果不一致则视为未应用（即使标记为已应用）
                    # 同组同步来的 is_applied 标记只在「本机没有规划结果、无法比对」时兜底：
                    # 该标记是另一端按它自己的工参判定的，本机工参与之不一致时会显示错配。
                    stored_applied = bool(getattr(r, "is_applied", 0))
                    is_applied = False
                    result_summary = None
                    # 缓存命中（同任务 + 同工参版本 + 同应用标记）：跳过大 result_json 的 json.loads
                    cached = TaskManager._history_verify_cache.get(r.task_id)
                    if (cached and cached[0] == params_snapshot
                            and len(cached) > 3 and cached[3] == stored_applied):
                        is_applied = cached[1]
                        result_summary = cached[2]
                    else:
                        parsed_result = None
                        result_json_str = miss_result_map.get(r.task_id)
                        if result_json_str:
                            try:
                                parsed_result = json.loads(result_json_str)
                            except Exception:
                                parsed_result = None
                        if parsed_result is not None and self._result_has_comparable_values(parsed_result):
                            # 「操作」列一律以当前全量工参的 PCI/TAC 列值为准，
                            # 不用同组同步来的标记覆盖比对结果
                            is_applied = self._verify_applied(parsed_result, current_sector_values)
                        else:
                            # 本机没有结果（桌面端镜像任务尚未落地），或结果里没有可比的
                            # PCI/TAC 规划值 → 无法比对，只能沿用标记
                            is_applied = stored_applied
                        result_summary = self._extract_result_summary(parsed_result)
                        if result_summary is None and (r.cell_count or 0) > 0:
                            # 同组镜像任务（本机无 result_json）：用同步来的小数量生成最小摘要，
                            # 否则桌面端历史列表「小区数量」列恒为 '-'
                            result_summary = {"cellCount": int(r.cell_count)}
                        TaskManager._history_verify_cache[r.task_id] = (
                            params_snapshot, is_applied, result_summary, stored_applied)
                        # 防止缓存无限增长
                        if len(TaskManager._history_verify_cache) > TaskManager._history_verify_cache_max:
                            TaskManager._history_verify_cache.clear()
                    entry = {
                        "taskId": r.task_id,
                        "taskType": r.task_type,
                        "taskName": r.task_name,
                        "userName": r.user_name,
                        "status": r.status,
                        "progress": r.progress,
                        # 🔥 不再返回完整 config（大任务可能含数百 KB 的小区列表，前端未消费该字段）
                        "resultSummary": result_summary,
                        # 不再返回完整 result：避免传输数 MB 的结果数组导致历史列表加载缓慢
                        "isApplied": is_applied,
                        "createdAt": r.created_at,
                        "completedAt": r.completed_at,
                    }
                    task_list.append(entry)
                return {"tasks": task_list, "total": total, "page": safe_page, "page_size": safe_page_size}
            finally:
                db.close()
        except Exception as e:
            logger.error(f"[TaskManager] 读取历史任务失败: {e}")
            return {"tasks": [], "total": 0, "page": 1, "page_size": page_size}

    @staticmethod
    def _norm_cell_id(value: Any) -> str:
        """站点/小区标识归一化：Excel、CSV 常把整数写成浮点（32 → "32.0"），
        而 SQLite 里存的是 "32"，两侧必须按同一口径建键，否则「已应用」会漏判。
        只对带小数点的整数串做归一（"0123" 这类带前导零的标识保持原样）。
        """
        text = str(value if value is not None else "").strip()
        if "." not in text:
            return text
        try:
            number = float(text)
        except ValueError:
            return text
        return str(int(number)) if number.is_integer() else text

    @staticmethod
    def _same_param_value(current: Any, expected: Any) -> bool:
        """参数值比较：数值型按数值比（486 == "486.0"），非数值按去空格字符串比。"""
        if current is None or expected is None:
            return current is None and expected is None
        if current == expected:
            return True

        def _to_number(value: Any) -> Optional[float]:
            if isinstance(value, bool):
                return None
            if isinstance(value, (int, float)):
                return float(value)
            try:
                return float(str(value).strip())
            except ValueError:
                return None

        num_cur = _to_number(current)
        num_exp = _to_number(expected)
        if num_cur is not None and num_exp is not None:
            return num_cur == num_exp
        return str(current).strip() == str(expected).strip()

    @staticmethod
    def _full_params_fingerprint(db, workbook_id: Optional[str]) -> str:
        """全量工参内容指纹（一次聚合查询）：工参 id + 小区数 + PCI/TAC 加权聚合值。

        用途：历史任务「已应用」判定必须反映工参的**当前内容**，而不是只反映工参条目的 id。
        导入/同步一份新工参（可能沿用同一 id）、小区批量改 PCI/TAC 等操作都会改变这些
        聚合值，从而让验证缓存立即失效；只靠 id + 300s TTL 会在最长 5 分钟内给出错配结果。

        ⚠ PCI/TAC 用小区主键加权（SUM(pci * id)）而不是裸 SUM(pci)：规划结果应用最常见的
        形态就是 PCI 值在小区之间轮换/互换（480/481/482 → 482/480/481），裸 SUM 对这种
        变化完全不变（总量守恒），会让缓存不失效、历史列表继续显示旧状态。
        互换任意两个不同值的小区都会改变加权和（差 = (a-b)*(i-j) ≠ 0）。
        """
        if not workbook_id:
            return ""
        try:
            from sqlalchemy import text

            row = db.execute(
                text(
                    "SELECT COUNT(*), "
                    "COALESCE(SUM(COALESCE(pci, 0) * id), 0), "
                    "COALESCE(SUM(LENGTH(COALESCE(tac, ''))), 0), "
                    "COALESCE(SUM(CAST(tac AS INTEGER) * id), 0) "
                    "FROM sectors WHERE workbook_id = :wb"
                ),
                {"wb": workbook_id},
            ).first()
            if row is None:
                return f"{workbook_id}|0"
            return f"{workbook_id}|{int(row[0] or 0)}|{int(row[1] or 0)}|{int(row[2] or 0)}|{int(row[3] or 0)}"
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[TaskManager] 计算工参指纹失败: {exc}")
            return f"{workbook_id}|unknown"

    @staticmethod
    def _load_current_sector_values(db, city: Optional[str] = None, operator: Optional[str] = None) -> Dict[str, Dict]:
        """加载当前全量工参中所有小区的实际 PCI/TAC 值，返回 {siteId_sectorId: {pci, tac}}

        city/operator: (地市+运营商) 组快照，严格组内定位全量工参；组不完整返回空。
        缓存按（组 + full_params_id + 内容指纹）区分，避免跨组串值与内容已变但 id 未变的误判。

        🔥 优化：缓存失效依赖内容指纹 + inplace_updated 信号（应用操作设置），
        避免每次历史列表请求都全量查询 SQLite（生产环境几万行，ARM 芯片耗时数秒）。
        只有以下任一情况才重新全表加载：
        - 缓存不存在
        - full_params_id 变化（切换了全量工参文件）
        - 内容指纹变化（同 id 被重写 / 小区批量改 PCI 或 TAC / 导入的新工参与旧值不同）
        - 发生原地更新（inplace_updated=True，PCI/TAC 应用后设置）
        - TTL 兜底过期（防止未标记的工参变更）
        """
        from app.services.data_service import data_service
        from app.models.database import Site, Sector
        import time as _time

        current_time = _time.time()
        # 当前全量工参 workbook_id（严格组内定位；组不完整为 None → 返回空）
        current_full_params_id = TaskManager._resolve_full_params_id(city, operator)
        # 内容指纹：同步/导入一份内容不同但 id 相同的工参也能识别出来
        current_fingerprint = TaskManager._full_params_fingerprint(db, current_full_params_id)

        # 🔥 缓存命中条件：组 + id + 内容指纹匹配 + 未发生原地更新 + TTL 兜底内
        cached = TaskManager._sector_values_cache
        if (cached
                and cached.get("_group") == (city, operator)
                and cached.get("_full_params_id") == current_full_params_id
                and cached.get("_fingerprint") == current_fingerprint
                and not data_service.index.get(current_full_params_id, {}).get("inplace_updated")
                and (current_time - TaskManager._sector_values_cache_time) < TaskManager._sector_values_cache_ttl):
            return cached.get("values", {})

        # 需要重新加载（full_params_id / 内容指纹变化 / 原地更新 / TTL 兜底）
        full_params_id = current_full_params_id
        if not full_params_id:
            return {}

        values = {}
        rows = db.query(
            Site.site_id, Sector.sector_id, Sector.pci, Sector.tac
        ).join(
            Sector, Sector.site_id_fk == Site.id
        ).filter(
            Site.workbook_id == full_params_id
        ).all()
        for row in rows:
            # 标识归一化：保证「32.0」与「32」这两种写法命中同一个键
            key = f"{TaskManager._norm_cell_id(row.site_id)}_{TaskManager._norm_cell_id(row.sector_id)}"
            rec = {}
            if row.pci is not None:
                rec["pci"] = row.pci
            if row.tac is not None:
                rec["tac"] = row.tac
            if rec:
                values[key] = rec

        # 🔥 写入缓存，并清除原地更新信号（表示已消费该次变更）
        if full_params_id in data_service.index:
            data_service.index[full_params_id]['inplace_updated'] = False
        TaskManager._sector_values_cache = {
            "_group": (city, operator),
            "_full_params_id": full_params_id,
            "_fingerprint": current_fingerprint,
            # 合并键：历史任务验证缓存按此键整体失效（换工参或工参内容变化都算）
            "_cache_key": f"{full_params_id}|{current_fingerprint}",
            "values": values,
        }
        TaskManager._sector_values_cache_time = current_time
        return values

    @staticmethod
    def _verify_applied(result: Dict, current_values: Dict[str, Dict]) -> bool:
        """检查任务结果中的 PCI/TAC 是否与当前全量工参的实际值一致

        🔥 优化：直接接收已解析的 result dict，避免在历史列表循环中重复 json.loads
        """
        try:
            task_results = result.get("results", [])
            if not task_results:
                return True  # 无规划结果，视为一致

            # 兼容两种格式：
            # 嵌套格式（PCI规划）: results = [{siteId, sectors: [{sectorId, newPCI, tac}]}]
            # 扁平格式（TAC核查/规划）: results = [{siteId, sectorId, tac, ...}]
            first = task_results[0]
            is_nested = "sectors" in first

            if is_nested:
                # 嵌套格式（PCI规划）
                for site_result in task_results:
                    site_id = str(site_result.get("siteId", ""))
                    for sector in site_result.get("sectors", []):
                        sector_id = str(sector.get("sectorId", ""))
                        key = f"{TaskManager._norm_cell_id(site_id)}_{TaskManager._norm_cell_id(sector_id)}"
                        cur = current_values.get(key)
                        if cur is None:
                            return False
                        new_pci = sector.get("newPCI")
                        if new_pci is not None and not TaskManager._same_param_value(cur.get("pci"), new_pci):
                            return False
                        new_tac = sector.get("tac")
                        if new_tac is not None:
                            cur_tac = cur.get("tac")
                            if cur_tac is None:
                                return False
                            if not TaskManager._same_param_value(cur_tac, new_tac):
                                return False
            else:
                # 扁平格式（TAC核查/TAC规划）
                for item in task_results:
                    site_id = str(item.get("siteId", ""))
                    sector_id = str(item.get("sectorId", ""))
                    key = f"{TaskManager._norm_cell_id(site_id)}_{TaskManager._norm_cell_id(sector_id)}"
                    cur = current_values.get(key)
                    if cur is None:
                        return False
                    new_tac = item.get("tac") or item.get("suggestedTac")
                    if new_tac is not None:
                        cur_tac = cur.get("tac")
                        if cur_tac is None:
                            return False
                        if not TaskManager._same_param_value(cur_tac, new_tac):
                            return False

            return True
        except Exception:
            return False

    @staticmethod
    def _extract_cell_count(result: Optional[Dict]) -> Optional[int]:
        """从任务结果里提取「小区数量」（列表列展示用）。

        各算法结果字段不一致：PCI/邻区用 totalSectors，TAC 核查/规划用 totalCells；
        都缺时退回 results 数组长度。取不到返回 None（前端显示 '-'）。
        """
        if not isinstance(result, dict):
            return None
        for key in ("totalSectors", "totalCells"):
            value = result.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return int(value)
        results = result.get("results")
        if isinstance(results, list):
            return len(results)
        return None

    @staticmethod
    def backfill_task_cell_counts(batch_size: int = 20) -> int:
        """存量任务补齐小数量（-1 = 已计算但结果里没有可用字段）。

        老任务创建时没有 cell_count，同组任务清单与镜像行就无法显示「小区数量」。
        只在服务器形态启动时后台跑一次：只扫「共享类型 + 有结果 + 未计算过」的行，
        分批解析小 JSON 并提交，失败只记日志（绝不阻塞启动）。
        """
        from app.core.database import SessionLocal
        from app.models.database import TaskResult

        updated = 0
        db = SessionLocal()
        try:
            while True:
                rows = (
                    db.query(TaskResult)
                    .filter(
                        TaskResult.task_type.in_(TaskManager.SHARED_TASK_TYPES),
                        TaskResult.cell_count.is_(None),
                        TaskResult.result_json.isnot(None),
                    )
                    .limit(max(1, int(batch_size)))
                    .all()
                )
                if not rows:
                    break
                for row in rows:
                    try:
                        parsed = json.loads(row.result_json) if row.result_json else None
                    except Exception:
                        parsed = None
                    value = TaskManager._extract_cell_count(parsed)
                    row.cell_count = int(value) if value is not None else -1
                    updated += 1
                db.commit()
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            logger.warning(f"[TaskManager] 回填任务小数量失败（非致命）: {exc}")
        finally:
            db.close()
        return updated

    # 应用状态回填只对"结果里确实写了 PCI/TAC 值"的类型做（neighbor 结果不含参数值）
    _APPLIED_BACKFILL_TYPES = ("pci", "tac", "tac_planning")

    @staticmethod
    def _result_has_comparable_values(result: Optional[Dict]) -> bool:
        """结果里是否至少有一个可比较的 PCI/TAC 值。

        `_verify_applied` 对"没有 results"的结果直接返回 True（视为一致），
        回填时必须先用本函数挡住这种情况，避免把无可比值的任务误标为已应用。
        """
        if not isinstance(result, dict):
            return False
        for item in result.get("results") or []:
            if not isinstance(item, dict):
                continue
            sectors = item.get("sectors")
            if isinstance(sectors, list):
                for sector in sectors:
                    if isinstance(sector, dict) and (
                        sector.get("newPCI") is not None or sector.get("tac") is not None
                    ):
                        return True
            if item.get("tac") is not None or item.get("suggestedTac") is not None:
                return True
        return False

    @staticmethod
    def backfill_applied_flags(max_rows: int = 400) -> int:
        """存量任务回填「已应用」：结果与当前工参一致但标记为 0 的行置 1。

        背景（2026-10-09）：旧版服务器 upsert_shared_task 忽略 is_applied，
        桌面端应用过的任务在服务器与同组镜像里全成了「未应用」。按现有动态判定
        口径（_verify_applied 对照本组当前全量工参）回填一次，启动时后台执行。
        """
        from app.core.database import SessionLocal
        from app.models.database import TaskResult

        updated = 0
        db = SessionLocal()
        try:
            rows = (
                db.query(TaskResult)
                .filter(
                    TaskResult.task_type.in_(TaskManager._APPLIED_BACKFILL_TYPES),
                    TaskResult.is_applied == 0,
                    TaskResult.result_json.isnot(None),
                )
                .order_by(TaskResult.created_at.desc())
                .limit(max(1, int(max_rows)))
                .all()
            )
            values_by_group: Dict[Any, Dict] = {}
            for row in rows:
                try:
                    parsed = json.loads(row.result_json) if row.result_json else None
                except Exception:
                    parsed = None
                if not TaskManager._result_has_comparable_values(parsed):
                    continue
                key = (row.city, row.operator)
                if key not in values_by_group:
                    values_by_group[key] = TaskManager._load_current_sector_values(
                        db, city=row.city, operator=row.operator
                    )
                values = values_by_group[key]
                if not values:
                    continue
                if TaskManager._verify_applied(parsed, values):
                    row.is_applied = 1
                    updated += 1
                    TaskManager._history_verify_cache.pop(row.task_id, None)
            if updated:
                db.commit()
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            logger.warning(f"[TaskManager] 回填已应用标记失败（非致命）: {exc}")
        finally:
            db.close()
        return updated

    @staticmethod
    def _extract_result_summary(result: Optional[Dict]) -> Optional[Dict]:
        """从完整 result dict 中提取轻量摘要字段（避免历史列表返回大数据）

        🔥 优化：直接接收已解析的 result dict，避免在历史列表循环中重复 json.loads
        """
        if not result:
            return None
        try:
            r = result
            return {
                "status": r.get("status"),
                "totalSites": r.get("totalSites", 0),
                "totalSectors": r.get("totalSectors", 0),
                "collisions": r.get("collisions", 0),
                "confusions": r.get("confusions", 0),
                "totalCells": r.get("totalCells", 0),
                "totalNeighbors": r.get("totalNeighbors", 0),
                "matchedCells": r.get("matchedCells", 0),
                "unmatchedCells": r.get("unmatchedCells", 0),
                "singularityCount": r.get("singularityCount", 0),
                # 归一化的小区数量（totalSectors/totalCells/results 长度三者取一），
                # 前端历史列表「小区数量」列统一读它
                "cellCount": TaskManager._extract_cell_count(r),
                "startTime": r.get("startTime"),
                "endTime": r.get("endTime"),
            }
        except Exception:
            return None

    def get_task_result_from_db(self, task_id: str) -> Optional[Dict]:
        """从 SQLite 获取任务结果（用于内存中不存在的历史任务）"""
        try:
            from app.core.database import SessionLocal
            from app.models.database import TaskResult

            db = SessionLocal()
            try:
                r = db.query(TaskResult).filter(TaskResult.task_id == task_id).first()
                if r and r.result_json:
                    return json.loads(r.result_json)
                return None
            finally:
                db.close()
        except Exception as e:
            logger.error(f"[TaskManager] 读取历史任务结果失败: {e}")
            return None

    def get_task_progress(self, task_id: str) -> Optional[Dict]:
        """获取任务进度"""
        task = self.tasks.get(task_id)
        if task is None:
            return None
        # 如果任务完成，返回完整的结果数据（包含统计）
        if task.status == TaskStatus.COMPLETED:
            result = task.result
            # 🔥 防御：确保结果不包含 NaN/Infinity（避免前端 JSON.parse 失败）
            if result is not None:
                result = self._sanitize_result(result)
            return result
        # 否则返回进度信息
        return task.to_dict()

    def get_task_result(self, task_id: str) -> Optional[Dict]:
        """获取任务结果（内存优先，回退到 SQLite）"""
        task = self.tasks.get(task_id)
        if task and task.status == TaskStatus.COMPLETED:
            result = task.result
            # 🔥 防御：确保结果不包含 NaN/Infinity
            if result is not None:
                result = self._sanitize_result(result)
            return result
        # 回退到 SQLite 历史任务
        db_result = self.get_task_result_from_db(task_id)
        if db_result is not None:
            db_result = self._sanitize_result(db_result)
            return db_result
        # 桌面端共享镜像任务：结果不随同步下发，第一次查看/导出时按需拉取并缓存
        return self._fetch_shared_task_result(task_id)

    def cancel_task(self, task_id: str) -> bool:
        """取消任务"""
        task = self.tasks.get(task_id)
        if task is None:
            return False

        if task.status in [TaskStatus.PENDING, TaskStatus.PROCESSING]:
            if task.task and not task.task.done():
                task.task.cancel()
            task.status = TaskStatus.FAILED
            task.error = "任务已取消"
            task.completed_at = datetime.now()
            return True

        return False

    def delete_task(self, task_id: str) -> bool:
        """彻底删除任务（SQLite + 导出文件 + 内存）"""
        task_id_str = str(task_id)
        logger.info(f"[TaskManager] 开始删除任务: {task_id_str[:8]}...")

        try:
            # 1. 取消正在运行的任务
            task = self.tasks.get(task_id_str)
            if task and task.status in [TaskStatus.PENDING, TaskStatus.PROCESSING]:
                if task.task and not task.task.done():
                    task.task.cancel()
                logger.info(f"[TaskManager] 已取消正在运行的任务: {task_id_str[:8]}...")

            # 2. 从内存 dict 删除
            if task_id_str in self.tasks:
                del self.tasks[task_id_str]
                logger.info(f"[TaskManager] 已从内存删除任务: {task_id_str[:8]}...")

            # 3. 从 SQLite task_results 表删除（权威数据源）
            try:
                from app.core.database import SessionLocal
                from app.models.database import TaskResult

                db = SessionLocal()
                try:
                    row = db.query(TaskResult).filter(TaskResult.task_id == task_id_str).first()
                    if row:
                        # 桌面端共享任务：本机删除要通知服务器，否则下次同步又拉回来
                        self._queue_shared_task_delete(task_id_str, row.task_type)
                        db.delete(row)
                        db.commit()
                        # 清除该任务的验证缓存
                        TaskManager._history_verify_cache.pop(task_id_str, None)
                        logger.info(f"[TaskManager] 已从 SQLite 删除任务: {task_id_str[:8]}...")
                finally:
                    db.close()
            except Exception as e:
                logger.warning(f"[TaskManager] SQLite 删除失败（可忽略）: {e}")

            # 4. 删除导出文件
            try:
                from app.core.config import settings
                output_dir = settings.OUTPUT_DIR
                for ext in ['xlsx', 'csv']:
                    export_file = output_dir / f"{task_id_str}.{ext}"
                    if export_file.exists():
                        export_file.unlink()
                        logger.info(f"[TaskManager] 已删除导出文件: {export_file.name}")
            except Exception as e:
                logger.warning(f"[TaskManager] 导出文件删除失败（可忽略）: {e}")

            # 5. 广播任务删除事件到所有 WebSocket 客户端，实现实时更新
            try:
                from app.services.websocket_manager import websocket_manager

                async def _broadcast_delete():
                    message = {
                        "type": "task_deleted",
                        "taskId": task_id_str,
                        "data": {"taskId": task_id_str}
                    }
                    for client_id in list(websocket_manager.connections.keys()):
                        try:
                            await websocket_manager.connections[client_id].send_json(message)
                        except Exception as _e:
                            logger.warning(f"[TaskManager] WebSocket 广播删除失败: {client_id}, {_e}")

                # 使用 asyncio（已在文件顶部导入）广播删除事件
                try:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        asyncio.ensure_future(_broadcast_delete())
                    else:
                        loop.run_until_complete(_broadcast_delete())
                except RuntimeError:
                    logger.warning("[TaskManager] 无法广播删除事件：事件循环不可用")
            except Exception as e:
                logger.warning(f"[TaskManager] 广播删除事件异常（非致命）: {e}")

            logger.info(f"[TaskManager] 任务删除完成: {task_id_str[:8]}...")
            return True

        except Exception as e:
            logger.error(f"[TaskManager] 删除任务失败: {task_id_str[:8]}... error={e}", exc_info=True)
            return False

    def export_result(self, task_id: str, format: str = "xlsx") -> Optional[str]:
        """导出任务结果"""
        task = self.tasks.get(task_id)
        if task is None:
            logger.warning(f"[TaskManager] 导出失败: 任务 {task_id[:8]}... 不存在")
            return None
        if task.status != TaskStatus.COMPLETED:
            logger.warning(f"[TaskManager] 导出失败: 任务 {task_id[:8]}... 未完成 (status={task.status.value})")
            return None
        if task.result is None:
            logger.warning(f"[TaskManager] 导出失败: 任务 {task_id[:8]}... 已完成但结果数据为空，可能是不完整的历史任务")
            return None

        logger.info(f"[TaskManager] 开始导出任务 {task_id[:8]}... type={task.task_type.value}, format={format}, networkType={task.result.get('networkType', 'N/A')}")

        try:
            import pandas as pd
            from pathlib import Path
            from app.core.config import settings

            output_file = Path(settings.OUTPUT_DIR) / f"{task_id}.{format}"
            output_file.parent.mkdir(parents=True, exist_ok=True)

            # 根据任务类型导出
            if task.task_type == TaskType.PCI:
                # PCI规划结果导出
                data = []
                for site_result in task.result.get("results", []):
                    site_id = site_result.get("siteId", "")
                    site_name = site_result.get("siteName", "")

                    for sector_result in site_result.get("sectors", []):
                        # 优先从小区的结果中获取网络类型
                        current_network_type = sector_result.get("networkType") or "LTE"

                        # 根据网络类型确定网元ID
                        if current_network_type == "NR":
                            net_element_id = site_result.get("managedElementId", site_id)
                            if isinstance(net_element_id, (int, float)):
                                try:
                                    if math.isnan(net_element_id):
                                        net_element_id = site_id
                                    else:
                                        net_element_id = int(net_element_id)
                                except (ValueError, TypeError):
                                    net_element_id = site_id
                            elif net_element_id is None:
                                net_element_id = site_id
                        else:
                            net_element_id = site_result.get("managedElementId", site_name)

                        # 获取频点信息
                        frequency = (
                            sector_result.get("frequency", "")
                            or sector_result.get("earfcn", "")
                            or sector_result.get("ssb_frequency", "")
                        )

                        # 处理距离显示
                        raw_dist = sector_result.get("minReuseDistance", "")
                        display_dist = raw_dist
                        try:
                            if raw_dist == 999 or raw_dist == 999.0 or raw_dist == float('inf'):
                                display_dist = "无冲突"
                            elif isinstance(raw_dist, (int, float)) and raw_dist != float('inf'):
                                display_dist = f"{raw_dist:.2f}"
                        except Exception:
                            display_dist = str(raw_dist) if raw_dist is not None else ""

                        data.append(
                            {
                                "网络类型": current_network_type,
                                "基站ID": site_id,
                                "网元ID": net_element_id,
                                "小区ID": sector_result.get("sectorId", ""),
                                "小区名称": sector_result.get("sectorName", ""),
                                "运营商/厂家": sector_result.get("firstGroup", ""),
                                "频点": frequency,
                                "原PCI": sector_result.get("originalPCI", ""),
                                "新PCI": sector_result.get("newPCI", ""),
                                "原模值": sector_result.get("originalMod", ""),
                                "新模值": sector_result.get("newMod", ""),
                                "TAC规划值": sector_result.get("tac", ""),
                                "分配原因": sector_result.get("assignmentReason", ""),
                                "最小复用距离(km)": display_dist,
                                "最小复用距离对端小区名称": sector_result.get("minDistanceSectorName", ""),
                            }
                        )

                logger.info(f"[TaskManager] PCI导出: 共 {len(data)} 行数据")
                df = pd.DataFrame(data)

            elif task.task_type == TaskType.NEIGHBOR:
                # 邻区规划结果导出 (扁平化结构)
                data = []
                if task.result:
                    for result in task.result.get("results", []):
                        data.append(
                            {
                                "关系类型": result.get("relationType", ""),
                                "源基站ID": result.get("sourceSiteId", ""),
                                "源小区ID": result.get("sourceCellId", ""),
                                "源小区名称": result.get("sourceCellName", ""),
                                "源频点": result.get("sourceFrequency", ""),
                                "源PCI": result.get("sourcePci", ""),
                                "目标基站ID": result.get("targetSiteId", ""),
                                "目标小区ID": result.get("targetCellId", ""),
                                "目标小区名称": result.get("targetCellName", ""),
                                "目标频点": result.get("targetFrequency", ""),
                                "目标PCI": result.get("targetPci", ""),
                                "邻区距离(km)": result.get("distance", ""),
                                "方位角差": result.get("bearing", ""),
                            }
                        )

                logger.info(f"[TaskManager] 邻区导出: 共 {len(data)} 行数据")
                df = pd.DataFrame(data)

            elif task.task_type in [TaskType.TAC, TaskType.TAC_PLANNING]:
                # TAC结果导出 (核查和规划共用)
                data = []
                if task.result:
                    for result in task.result.get("results", []):
                        tac_planned = str(result.get("tac") or "").strip()
                        tac_existing = str(result.get("existingTac") or "").strip()

                        is_consistent = "一致" if (tac_planned and tac_existing and tac_planned.lstrip('0') == tac_existing.lstrip('0')) else "不一致"
                        if not tac_planned or not tac_existing:
                            is_consistent = "-"

                        data.append(
                            {
                                "网络类型": result.get("networkType", ""),
                                "基站ID": result.get("siteId", ""),
                                "基站名称": result.get("siteName", ""),
                                "小区ID": result.get("sectorId", ""),
                                "小区名称": result.get("sectorName", ""),
                                "运营商/厂家": result.get("firstGroup", ""),
                                "经度": result.get("longitude", ""),
                                "纬度": result.get("latitude", ""),
                                "图层TAC": result.get("tac", ""),
                                "现网TAC": result.get("existingTac", ""),
                                "TAC是否一致": is_consistent,
                                "匹配状态": "已匹配" if result.get("tac") else "未匹配",
                            }
                        )

                logger.info(f"[TaskManager] TAC导出: 共 {len(data)} 行数据")
                df = pd.DataFrame(data)

            else:
                raise ValueError(f"未知的任务类型: {task.task_type}")

            if format == "xlsx":
                df.to_excel(output_file, index=False, engine="openpyxl")
            elif format == "csv":
                df.to_csv(output_file, index=False, encoding="utf-8-sig")
            else:
                raise ValueError(f"不支持的导出格式: {format}")

            file_size = output_file.stat().st_size
            logger.info(f"[TaskManager] 导出成功: {output_file.name} ({file_size} bytes)")
            return str(output_file)

        except Exception as e:
            logger.error(f"[TaskManager] 导出失败: task_id={task_id[:8]}..., type={task.task_type.value}, error={e}", exc_info=True)
            return None

    def cleanup_old_tasks(self):
        """清理旧任务"""
        # 删除超过24小时完成的任务
        from datetime import timedelta

        cutoff = datetime.now() - timedelta(hours=24)
        to_remove = []

        for task_id, task in self.tasks.items():
            if task.completed_at and task.completed_at < cutoff:
                to_remove.append(task_id)

        for task_id in to_remove:
            del self.tasks[task_id]


# 创建全局实例
from app.core.config import settings

task_manager = TaskManager()
