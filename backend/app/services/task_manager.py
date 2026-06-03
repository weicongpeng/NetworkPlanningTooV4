"""
任务管理器 - 用于管理PCI和邻区规划的异步任务
"""

import asyncio
import uuid
import math
import json
from pathlib import Path
from datetime import datetime
from typing import Dict, Optional, Any, Callable, List
from enum import Enum
import logging

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
from app.services.data_service import data_service


class TaskType(str, Enum):
    """任务类型"""

    PCI = "pci"
    NEIGHBOR = "neighbor"
    TAC = "tac"  # 核查
    TAC_PLANNING = "tac_planning"  # 规划
    UPDATE_PARAMS = "update_params"  # 工参更新
    APPLY_PCI = "apply_pci"  # PCI应用到工参
    APPLY_TAC_PLANNING = "apply_tac_planning"  # TAC规划应用到工参


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

    def __init__(self, task_type: TaskType, config: Any, task_name: Optional[str] = None, user_name: Optional[str] = None):
        self.task_id = str(uuid.uuid4())
        self.task_type = task_type
        self.config = config
        self.task_name = task_name
        self.user_name = user_name
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
        return {
            "taskId": self.task_id,
            "status": self.status.value,
            "progress": self.progress,
            "message": self._get_status_message(),
            "error": self.error if self.status == TaskStatus.FAILED else None,
            "created_at": self.created_at.isoformat(),
        }

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
        self.max_tasks = 10
        # 数据准备缓存，避免同一任务重复读取
        self._data_prep_cache: Dict[str, Any] = {}
        # 持久化索引文件路径
        self._tasks_index_file = settings.OUTPUT_DIR / "tasks_index.json"
        # 启动时从磁盘恢复已完成的任务（支持后端重启后导出历史结果）
        self._load_tasks_index()

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
                        user_name=task_data.get("user_name"))
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


    # 数据准备优化辅助方法 (P1-2)
    # ============================================================

    def _resolve_input_datasets(
        self, network_type_str: str
    ) -> Dict[str, Any]:
        """
        一次性确定待规划小区和全量工参文件

        优化点: 避免多次调用 list_data() 和重复扫描

        Args:
            network_type_str: 网络类型 ("LTE" 或 "NR")

        Returns:
            {"target_cells_item": DataItem, "full_params_item": DataItem}
        """
        cache_key = f"datasets_{network_type_str}"
        if cache_key in self._data_prep_cache:
            return self._data_prep_cache[cache_key]

        self._data_prep_cache.clear()
        try:
            data_service.reload_index()
            data_items = data_service.list_data()

            target_cells_item = None
            full_params_item = None
            full_params_upload_time = None

            for item in data_items:
                if item.type.value == "excel":
                    data_info = data_service.index.get(item.id, {})
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
                        elif filename.startswith("projectparameter_mongoose"):
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

    def _find_full_params_item(self) -> Optional[Any]:
        """
        仅查找全量工参文件，不依赖待规划小区文件。

        用于当PCI规划使用前端选中小区时，避免对待规划小区文件的任何依赖。

        Returns:
            full_params_item: DataItem 或 None
        """
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

                    if file_type == "full_params":
                        if full_params_item is None or (upload_date and (
                            full_params_upload_time is None or upload_date > full_params_upload_time
                        )):
                            full_params_item = item
                            full_params_upload_time = upload_date
                    elif file_type not in ("target_cells", "full_params_backup"):
                        if filename.startswith("projectparameter_mongoose"):
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

    def _validate_pci_data_files(self, network_type: NetworkType, skip_target_cells: bool = False) -> None:
        """
        验证PCI规划所需的数据文件

        Args:
            network_type: 网络类型(LTE或NR)
            skip_target_cells: 是否跳过待规划小区文件检查（当使用前端选中的小区时可跳过）

        Raises:
            ValueError: 当数据文件缺失或不符合要求时
        """
        logger.info(f"[TaskManager] 开始验证PCI数据文件, network_type={network_type}, skip_target_cells={skip_target_cells}")

        # 1. 检查文件存在性
        data_items = data_service.list_data()
        target_cells_file = None
        full_params_file = None

        for item in data_items:
            filename = item.name.lower()
            if filename.startswith("cell-tree-export"):
                target_cells_file = item
            elif filename.startswith("projectparameter_mongoose"):
                full_params_file = item

        # 2. 验证文件存在
        if not skip_target_cells and not target_cells_file:
            raise ValueError(
                "未找到待规划小区文件。请上传文件名以'cell-tree-export'开头的Excel文件。"
            )
        if not full_params_file:
            raise ValueError(
                "未找到全量工参文件。请上传文件名以'ProjectParameter_mongoose'开头的Excel文件。"
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

    async def create_pci_task(self, config: PCIConfig, task_name: Optional[str] = None, user_name: Optional[str] = None) -> str:
        """创建PCI规划任务 - 增强数据验证"""
        logger.info(f"[TaskManager] 创建PCI任务, config: {config}, task_name: {task_name}, user_name: {user_name}")

        # **新增**: 预验证数据文件
        try:
            # 如果提供了selectedCellIds，验证可以跳过待规划小区文件的检查
            has_selected_cells = config.selectedCellIds and len(config.selectedCellIds) > 0
            self._validate_pci_data_files(config.networkType, skip_target_cells=has_selected_cells)
        except ValueError as e:
            logger.error(f"[TaskManager] 数据文件验证失败: {str(e)}")
            raise

        # 检查任务数量
        running_tasks = sum(
            1
            for t in self.tasks.values()
            if t.status in [TaskStatus.PENDING, TaskStatus.PROCESSING]
        )
        if running_tasks >= self.max_tasks:
            raise ValueError("任务数量过多，请等待当前任务完成")

        # 创建任务（携带任务名称和用户名）
        task = Task(TaskType.PCI, config, task_name=task_name, user_name=user_name)
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)
        logger.info(f"[TaskManager] 任务创建成功, task_id: {task.task_id}")

        # 启动任务
        task.task = asyncio.create_task(self._run_pci_task(task))
        logger.info(f"[TaskManager] 异步任务已启动")

        return task.task_id

    async def create_neighbor_task(self, config: NeighborConfig, task_name: Optional[str] = None, user_name: Optional[str] = None) -> str:
        """创建邻区规划任务"""
        logger.info(f"[TaskManager] 创建邻区任务, task_name: {task_name}, user_name: {user_name}")

        # 检查任务数量
        running_tasks = sum(
            1
            for t in self.tasks.values()
            if t.status in [TaskStatus.PENDING, TaskStatus.PROCESSING]
        )
        if running_tasks >= self.max_tasks:
            raise ValueError("任务数量过多，请等待当前任务完成")

        # 创建任务（携带任务名称和用户名）
        task = Task(TaskType.NEIGHBOR, config, task_name=task_name, user_name=user_name)
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)

        # 启动任务
        task.task = asyncio.create_task(self._run_neighbor_task(task))

        return task.task_id

    async def create_tac_task(self, config: TACConfig, task_name: Optional[str] = None, user_name: Optional[str] = None) -> str:
        """创建TAC核查任务"""
        logger.info(f"[TaskManager] 创建TAC核查任务, task_name: {task_name}, user_name: {user_name}")

        # 检查任务数量
        running_tasks = sum(
            1
            for t in self.tasks.values()
            if t.status in [TaskStatus.PENDING, TaskStatus.PROCESSING]
        )
        if running_tasks >= self.max_tasks:
            raise ValueError("任务数量过多，请等待当前任务完成")

        # 创建任务（携带任务名称和用户名）
        task = Task(TaskType.TAC, config, task_name=task_name, user_name=user_name)
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)

        # 启动任务
        task.task = asyncio.create_task(self._run_tac_task(task))
        logger.info(f"[TaskManager] TAC核查任务已启动, task_id: {task.task_id}")

        return task.task_id

    async def create_tac_planning_task(self, config: TACConfig, task_name: Optional[str] = None, user_name: Optional[str] = None) -> str:
        """创建TAC规划任务（数据型）"""
        logger.info(f"[TaskManager] 创建TAC规划任务, task_name: {task_name}, user_name: {user_name}")

        # 检查任务数量
        running_tasks = sum(
            1
            for t in self.tasks.values()
            if t.status in [TaskStatus.PENDING, TaskStatus.PROCESSING]
        )
        if running_tasks >= self.max_tasks:
            raise ValueError("任务数量过多，请等待当前任务完成")

        # 创建任务（携带任务名称和用户名）
        task = Task(TaskType.TAC_PLANNING, config, task_name=task_name, user_name=user_name)
        self.tasks[task.task_id] = task
 
        # 启动任务
        task.task = asyncio.create_task(self._run_tac_planning_task(task))
 
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

                # 只查找全量工参文件
                full_params_item = self._find_full_params_item()
                if not full_params_item:
                    raise ValueError("未找到全量工参文件（前缀为'ProjectParameter_mongoose'的Excel文件）")

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
                data_dir=data_dir
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

                # 1. 查找全量工参文件（两种方式都需要）
                for item in data_items:
                    if item.type.value == "excel":
                        fname = item.name.lower()
                        if fname.startswith("projectparameter_mongoose"):
                            full_params_item = item

                if not full_params_item:
                    raise ValueError("未找到全量工参文件 (文件名需以 ProjectParameter_mongoose 开头)")

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
            )

            # 必须提供selectedCellIds，否则报错
            if not config.selectedCellIds or len(config.selectedCellIds) == 0:
                raise ValueError("请在小区选择列表中至少选择一个小区后再执行TAC核查")

            selected_set = set(config.selectedCellIds)
            filtered_results = []
            for cell in results:
                sector_id = cell.get("sectorId", "")
                site_id = cell.get("siteId", "")
                cell_key = f"{site_id}_{sector_id}"
                if cell_key in selected_set or sector_id in selected_set:
                    filtered_results.append(cell)
            results = filtered_results
            # 重新统计
            total_cells = len(results)
            matched_count = sum(1 for c in results if c.get("matched"))
            unmatched_count = sum(1 for c in results if not c.get("matched"))
            mismatched_count = sum(1 for c in results if c.get("tac") != c.get("existingTac") and c.get("existingTac") is not None)
            singularity_count = sum(1 for c in results if c.get("isSingularity"))
            logger.info(f"[TaskManager] TAC核查: 已根据选中小区过滤, 保留{total_cells}个小区")

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
                "mismatchedRate": (mismatched_count / matched_count * 100) if matched_count > 0 else 0,
                "matchingRate": (matched_count / total_cells * 100) if total_cells > 0 else 0,
                "singularityCount": singularity_count,
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

            # 查找全量工参文件
            data_items = data_service.list_data()
            full_params_data = None
            for item in data_items:
                if item.type.value == "excel":
                    filename = item.name.lower()
                    if filename.startswith("projectparameter_mongoose"):
                        full_params_data = data_service.get_data(item.id)
                        if full_params_data:
                            break

            if not full_params_data:
                raise ValueError("未找到全量工参文件（projectparameter_mongoose）")

            logger.info(f"[TaskManager] TAC规划: 待规划小区数量={len(target_cell_keys)}")
            
            # 从全量工参中提取匹配的小区信息（带坐标）
            matched_sites = []
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
                raise ValueError("无法匹配待规划小区与工参坐标信息，请检查ID是否一致")

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
                tac_service.plan_tac_for_list, network_type, matched_sites, progress_callback
            )
 
            # 5. 完成任务
            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()
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
    ) -> str:
        """创建工参更新任务"""
        logger.info(f"[TaskManager] 创建工参更新任务: full={full_param_id[:8]}..., current={current_param_id[:8]}...")

        # 检查任务数量
        running_tasks = sum(
            1
            for t in self.tasks.values()
            if t.status in [TaskStatus.PENDING, TaskStatus.PROCESSING]
        )
        if running_tasks >= self.max_tasks:
            raise ValueError("任务数量过多，请等待当前任务完成")

        # 创建任务
        task = Task(TaskType.UPDATE_PARAMS, {
            "fullParamId": full_param_id,
            "currentParamId": current_param_id,
            "username": username,
            "userId": user_id,
        })
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)
        logger.info(f"[TaskManager] 工参更新任务已创建: {task.task_id}")

        # 启动后台任务
        task.task = asyncio.create_task(self._run_update_params_task(task))
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

            # 在线程池中运行同步的耗时操作
            result = await asyncio.to_thread(
                data_service.update_parameters,
                full_param_id, current_param_id,
                username=username, user_id=user_id,
            )
            task.progress = 90

            # 清除地图数据缓存
            import app.api.v1.endpoints.map as map_module
            map_module._map_data_cache = None
            map_module._map_data_cache_time = 0

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
            }
            self._persist_task(task.task_id)
            logger.info(f"[TaskManager] 工参更新任务完成: {task.task_id}")
        except Exception as e:
            import traceback
            traceback.print_exc()
            task.status = TaskStatus.FAILED
            task.error = str(e)
            task.completed_at = datetime.now()
            task.progress = task.progress if hasattr(task, 'progress') else 0
            self._persist_task(task.task_id)
            logger.error(f"[TaskManager] 工参更新任务失败: {task.task_id}, error: {e}")

    async def create_apply_pci_to_params_task(self, planning_task_id: str) -> str:
        """创建PCI应用到工参任务"""
        logger.info(f"[TaskManager] 创建PCI应用到工参任务: planning_task={planning_task_id[:8]}...")

        # 检查规划任务是否存在并已完成
        planning_result = self.get_task_result(planning_task_id)
        if planning_result is None:
            raise ValueError("PCI规划任务不存在")
        if planning_result.get("status") != "completed":
            raise ValueError("PCI规划任务尚未完成")

        # 检查任务数量
        running_tasks = sum(
            1
            for t in self.tasks.values()
            if t.status in [TaskStatus.PENDING, TaskStatus.PROCESSING]
        )
        if running_tasks >= self.max_tasks:
            raise ValueError("任务数量过多，请等待当前任务完成")

        # 创建任务
        task = Task(TaskType.APPLY_PCI, {
            "planningTaskId": planning_task_id,
        })
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)
        logger.info(f"[TaskManager] PCI应用到工参任务已创建: {task.task_id}")

        # 启动后台任务
        task.task = asyncio.create_task(self._run_apply_pci_to_params_task(task))
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
            full_params_info = None
            for data_id, data_info in data_service.index.items():
                if data_info.get("fileType") == "full_params":
                    full_params_info = data_info
                    break

            task.progress = 10

            # 用于线程内进度回传的容器
            progress_holder = [10]

            # === 阶段1: SQLite-only 快路径（线程池，~1-2秒）===
            result = await asyncio.to_thread(
                self._apply_pci_fast_sqlite_only,
                planning_result, progress_holder, logger
            )

            task.progress = max(progress_holder[0], 90)

            # 清除地图数据缓存
            import app.api.v1.endpoints.map as map_module
            map_module._map_data_cache = None
            map_module._map_data_cache_time = 0

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

            # === 阶段2: 后台更新Excel文件（用户无需等待）===
            new_data_id = result.get("newFileId", "")
            old_entry_id = result.get("oldEntryId", "")
            if new_data_id:
                asyncio.create_task(
                    self._apply_pci_background_excel_update(
                        new_data_id, old_entry_id,
                        planning_result, full_params_info or {},
                        logger
                    )
                )
                logger.info(f"[TaskManager] 后台Excel更新任务已创建: new_data_id={new_data_id}")
            else:
                logger.warning("[TaskManager] 快路径未返回newFileId，跳过后台Excel更新")

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

    def _apply_pci_fast_sqlite_only(self, planning_result: Dict, progress_holder: list, _logger: logging.Logger) -> Dict:
        """Phase 1: SQLite-only fast path for PCI apply. No Excel I/O."""
        import json
        import os
        import uuid
        import re
        from datetime import datetime
        from pathlib import Path

        _logger.info(f"[ApplyPCI-Phase1] 开始执行PCI应用到工参（SQLite-only快路径）")

        # 获取规划结果
        results = planning_result.get("results", [])
        if not results:
            raise ValueError("规划结果为空")
        network_type = planning_result.get("networkType", "LTE")
        _logger.info(f"[ApplyPCI-Phase1] 规划结果包含 {len(results)} 个站点, 网络类型: {network_type}")

        progress_holder[0] = 15

        # 找到当前的全量工参
        full_params_id = None
        full_params_info = None
        for data_id, data_info in data_service.index.items():
            if data_info.get("fileType") == "full_params":
                full_params_id = data_id
                full_params_info = data_info
                break

        if not full_params_id:
            raise ValueError("未找到全量工参数据")
        _logger.info(f"[ApplyPCI-Phase1] 找到全量工参: {full_params_id}")

        progress_holder[0] = 20

        # 创建PCI更新映射
        pci_updates = {}
        for site_result in results:
            result_site_id = str(site_result.get("siteId", ""))
            sectors = site_result.get("sectors", [])
            for sector in sectors:
                new_pci = sector.get("newPCI")
                if new_pci is not None:
                    result_sector_id = str(sector.get("sectorId", ""))
                    unique_key = f"{result_site_id}_{result_sector_id}"
                    pci_updates[unique_key] = new_pci

        _logger.info(f"[ApplyPCI-Phase1] 创建了 {len(pci_updates)} 个PCI更新映射")

        progress_holder[0] = 35

        # ====== 核心：更新 PCI 到 SQLite（快路径，不需操作 Excel）======
        parsed_data = {}
        updated_count = 0
        try:
            # 优先从 SQLite 读取
            parsed_data = data_service.get_data_from_db(full_params_id)
            if parsed_data is None:
                _logger.warning("[ApplyPCI-Phase1] SQLite 无数据, 回退到 data.json")
                src_data_json = settings.DATA_DIR / full_params_id / "data.json"
                if src_data_json.exists():
                    with open(src_data_json, "r", encoding="utf-8") as f:
                        parsed_data = json.load(f)
                else:
                    raise ValueError("SQLite 和 data.json 均无数据，无法更新")

            # 应用 PCI 更新到内存中的 parsed_data
            for net_key in list(parsed_data.keys()):
                sites = parsed_data.get(net_key, [])
                if not isinstance(sites, list):
                    continue
                for site in sites:
                    sectors = site.get("sectors", [])
                    for sector in sectors:
                        sid = str(sector.get("siteId", ""))
                        sec_id = str(sector.get("sectorId") or sector.get("id", ""))
                        key = f"{sid}_{sec_id}"
                        if key in pci_updates:
                            sector["pci"] = pci_updates[key]
                            updated_count += 1

            _logger.info(f"[ApplyPCI-Phase1] 已更新 {updated_count} 个小区PCI")

            # 生成带时间戳和"已更新PCI"后缀的新文件名
            timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
            original_name = full_params_info.get("name", "ProjectParameter_mongoose.xlsx")
            name_part, ext_part = os.path.splitext(original_name)
            new_name = re.sub(r"_已更新PCI$", "", name_part)
            new_name = re.sub(r"_?\d{14}$", "", new_name)
            new_filename = f"{new_name}_{timestamp}_已更新PCI{ext_part}"

            # 创建新的数据ID和目录
            new_data_id = str(uuid.uuid4())
            new_data_dir = settings.DATA_DIR / new_data_id
            new_data_dir.mkdir(parents=True, exist_ok=True)

            # 写入 SQLite（无须 Excel 文件存在，size 字段留空）
            data_service._save_to_sqlite(
                data_id=new_data_id,
                filename=new_filename,
                file_type="full_params",
                user_id=full_params_info.get("user_id", 1),
                parsed_data=parsed_data,
                metadata={},
                file_path=new_data_dir / "original.xlsx",
                original_path=full_params_info.get("originalPath"),
            )
            _logger.info(f"[ApplyPCI-Phase1] SQLite 数据已写入: {new_data_id}")
        except Exception as e:
            _logger.error(f"[ApplyPCI-Phase1] PCI 更新失败: {e}")
            raise

        progress_holder[0] = 85

        # 更新数据索引（新条目）
        metadata = {}
        for net in ["LTE", "NR"]:
            if net in parsed_data:
                metadata[f"{net}SiteCount"] = len(parsed_data[net])
                metadata[f"{net}SectorCount"] = sum(len(s.get("sectors", [])) for s in parsed_data[net])

        data_service.index[new_data_id] = {
            "id": new_data_id,
            "name": new_filename,
            "type": "excel",
            "fileType": "full_params",
            "size": 0,
            "uploadDate": datetime.now().isoformat(),
            "status": "ready",
            "originalPath": full_params_info.get("originalPath"),
            "metadata": metadata,
        }

        # 标记旧的全量工参为 deprecated（不删除，Phase 2 清理）
        if full_params_id in data_service.index:
            old_info = data_service.index[full_params_id]
            old_info["fileType"] = "full_params_deprecated"
            old_info["deprecated"] = True
            old_info["deprecatedAt"] = datetime.now().isoformat()
            old_info["replacedBy"] = new_data_id
            data_service._save_index()
            _logger.info(f"[ApplyPCI-Phase1] 已标记旧工参为 deprecated: {full_params_id}")

        progress_holder[0] = 95

        return {
            "success": True,
            "message": f"成功应用PCI规划结果到全量工参，更新了{updated_count}个小区的PCI",
            "updatedCount": updated_count,
            "newFileId": new_data_id,
            "newFileName": new_filename,
            "oldEntryId": full_params_id,
        }

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

        # 新Excel路径
        new_data_dir = settings.DATA_DIR / new_data_id
        new_data_dir.mkdir(parents=True, exist_ok=True)
        new_excel_path = new_data_dir / "original.xlsx"

        # 复制原始Excel到新目录
        shutil.copy2(original_excel_path, new_excel_path)
        _logger.info(f"[SyncExcelUpdate] 已复制Excel到新目录: {new_excel_path}")

        # 更新Excel文件中的PCI
        results = planning_result.get("results", [])
        if not results:
            _logger.warning("[SyncExcelUpdate] 规划结果为空，跳过PCI更新")
            return
        network_type = planning_result.get("networkType", "LTE")

        pci_updates = {}
        for site_result in results:
            result_site_id = str(site_result.get("siteId", ""))
            for sector in site_result.get("sectors", []):
                new_pci = sector.get("newPCI")
                if new_pci is not None:
                    pci_updates[f"{result_site_id}_{str(sector.get('sectorId', ''))}"] = new_pci

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

            site_id_col_idx = sector_id_col_idx = pci_col_idx = None
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

            if site_id_col_idx is None or sector_id_col_idx is None or pci_col_idx is None:
                wb.close()
                _logger.warning("[SyncExcelUpdate] Excel缺少必需列，跳过")
                return

            updated_count = 0
            for row in ws.iter_rows(min_row=2, values_only=False):
                site_id_val = str(row[site_id_col_idx].value) if row[site_id_col_idx].value else ""
                sector_id_val = str(row[sector_id_col_idx].value) if row[sector_id_col_idx].value else ""
                try:
                    if "." in sector_id_val:
                        sector_id_val = str(int(float(sector_id_val)))
                except:
                    pass

                new_pci = pci_updates.get(f"{site_id_val}_{sector_id_val}")
                if new_pci is None and "_" in sector_id_val:
                    parts = sector_id_val.split("_")
                    if len(parts) == 2:
                        new_pci = pci_updates.get(f"{parts[0]}_{parts[1]}")

                if new_pci is not None and row[pci_col_idx].value != new_pci:
                    row[pci_col_idx].value = new_pci
                    updated_count += 1

            wb.save(new_excel_path)
            wb.close()
            _logger.info(f"[SyncExcelUpdate] Excel已更新 {updated_count} 个小区PCI")

            # 更新数据索引中的文件大小
            if new_data_id in data_service.index:
                data_service.index[new_data_id]["size"] = new_excel_path.stat().st_size
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

        # 检查任务数量
        running_tasks = sum(
            1
            for t in self.tasks.values()
            if t.status in [TaskStatus.PENDING, TaskStatus.PROCESSING]
        )
        if running_tasks >= self.max_tasks:
            raise ValueError("任务数量过多，请等待当前任务完成")

        task = Task(TaskType.APPLY_TAC_PLANNING, {
            "planningTaskId": planning_task_id,
        })
        self.tasks[task.task_id] = task
        self._persist_task(task.task_id)
        logger.info(f"[TaskManager] TAC规划应用到工参任务已创建: {task.task_id}")

        task.task = asyncio.create_task(self._run_apply_tac_planning_to_params_task(task))
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

            full_params_info = None
            for data_id, data_info in data_service.index.items():
                if data_info.get("fileType") == "full_params":
                    full_params_info = data_info
                    break

            # 用于线程内进度回传的容器
            progress_holder = [10]

            # === 阶段1: 快路径 — 更新 data.json/SQLite ===
            result = await asyncio.to_thread(
                self._sync_apply_tac_planning_fast,
                planning_result, progress_holder, logger
            )

            task.progress = max(progress_holder[0], 90)

            # 清除地图数据缓存
            import app.api.v1.endpoints.map as map_module
            map_module._map_data_cache = None
            map_module._map_data_cache_time = 0

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

            # === 阶段2: 后台更新Excel文件 ===
            new_data_id = result.get("newFileId", "")
            if new_data_id:
                asyncio.create_task(
                    asyncio.to_thread(
                        self._sync_update_excel_tac_background,
                        new_data_id,
                        planning_result,
                        full_params_info or {},
                        logger
                    )
                )
                logger.info(f"[TaskManager] 后台TAC Excel更新任务已创建: new_data_id={new_data_id}")

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

    def _sync_apply_tac_planning_fast(self, planning_result: Dict, progress_holder: list, _logger: logging.Logger) -> Dict:
        """
        快路径：将TAC规划结果中的TAC值更新到SQLite（在后台线程中运行）
        """
        import json
        import os
        import uuid
        import shutil
        import re
        from datetime import datetime
        from pathlib import Path

        _logger.info(f"[SyncApplyTAC-Fast] 开始执行TAC规划应用到工参（快路径）")

        # 获取规划结果
        results = planning_result.get("results", [])
        if not results:
            raise ValueError("TAC规划结果为空")
        network_type = planning_result.get("networkType", "LTE")
        _logger.info(f"[SyncApplyTAC-Fast] 规划结果包含 {len(results)} 个小区, 网络类型: {network_type}")

        progress_holder[0] = 15

        # 找到当前的全量工参
        full_params_id = None
        full_params_info = None
        for data_id, data_info in data_service.index.items():
            if data_info.get("fileType") == "full_params":
                full_params_id = data_id
                full_params_info = data_info
                break

        if not full_params_id:
            raise ValueError("未找到全量工参数据")

        # 获取原始Excel文件路径
        original_excel_path = settings.DATA_DIR / full_params_id / "original.xlsx"
        if not original_excel_path.exists():
            raise ValueError("全量工参原始Excel文件不存在")

        progress_holder[0] = 20

        # 删除其他旧工参
        deleted_count = 0
        for old_id, old_info in list(data_service.index.items()):
            if old_id != full_params_id and (old_info.get("fileType") in ("full_params", "full_params_backup")):
                try:
                    data_service.delete_data(old_id)
                    deleted_count += 1
                except Exception as e:
                    _logger.warning(f"[SyncApplyTAC-Fast] 删除旧工参失败: {old_id}, 错误: {e}")

        # 创建新的数据ID和目录
        new_data_id = str(uuid.uuid4())
        new_data_dir = settings.DATA_DIR / new_data_id
        new_data_dir.mkdir(parents=True, exist_ok=True)

        new_excel_path = new_data_dir / "original.xlsx"
        shutil.copy2(original_excel_path, new_excel_path)

        progress_holder[0] = 25

        # 从结果中提取匹配小区并创建TAC更新映射
        tac_updates = {}
        for item in results:
            if not item.get("matched"):
                continue
            site_id = str(item.get("siteId", ""))
            sector_id = str(item.get("sectorId", ""))
            new_tac = item.get("tac")
            if new_tac is not None and site_id and sector_id:
                unique_key = f"{site_id}_{sector_id}"
                tac_updates[unique_key] = new_tac

        _logger.info(f"[SyncApplyTAC-Fast] 创建了 {len(tac_updates)} 个TAC更新映射")

        progress_holder[0] = 35

        # 更新 SQLite
        parsed_data = {}
        updated_count = 0
        try:
            parsed_data = data_service.get_data_from_db(full_params_id)
            if parsed_data is None:
                _logger.warning("[SyncApplyTAC-Fast] SQLite 无数据, 回退到 data.json 解析")
                src_data_json = settings.DATA_DIR / full_params_id / "data.json"
                if src_data_json.exists():
                    with open(src_data_json, "r", encoding="utf-8") as f:
                        parsed_data = json.load(f)
                else:
                    import pandas as pd
                    xls = pd.ExcelFile(new_excel_path, engine='calamine')
                    for net in ["LTE", "NR"]:
                        sheet_name = f"{net} Project Parameters"
                        if sheet_name in xls.sheet_names:
                            sites = data_service._parse_sheet_data(xls, sheet_name, net)
                            parsed_data[net] = sites

            # 应用 TAC 更新
            for net_key in list(parsed_data.keys()):
                sites = parsed_data.get(net_key, [])
                if not isinstance(sites, list):
                    continue
                for site in sites:
                    sid = str(site.get("id", ""))
                    sectors = site.get("sectors", [])
                    for sector in sectors:
                        sec_id = str(sector.get("id", ""))
                        key = f"{sid}_{sec_id}"
                        if key in tac_updates:
                            sector["tac"] = tac_updates[key]
                            updated_count += 1

            _logger.info(f"[SyncApplyTAC-Fast] 已更新 {updated_count} 个小区TAC")

            # 生成新文件名
            timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
            original_name = full_params_info.get("name", "ProjectParameter_mongoose.xlsx")
            name_part, ext_part = os.path.splitext(original_name)
            new_name = re.sub(r"_已更新TAC$", "", name_part)
            new_name = re.sub(r"_?\d{14}$", "", new_name)
            new_filename = f"{new_name}_{timestamp}_已更新TAC{ext_part}"

            # 写入 SQLite
            data_service._save_to_sqlite(
                data_id=new_data_id,
                filename=new_filename,
                file_type="full_params",
                user_id=full_params_info.get("user_id", 1),
                parsed_data=parsed_data,
                metadata={},
                file_path=new_excel_path,
                original_path=full_params_info.get("originalPath"),
            )
        except Exception as e:
            _logger.error(f"[SyncApplyTAC-Fast] TAC更新失败: {e}")
            raise

        progress_holder[0] = 85

        # 保存到原始目录
        saved_to_original = False
        original_path = full_params_info.get("originalPath")
        if original_path and original_path.strip():
            try:
                original_file_path = os.path.abspath(original_path.strip())
                original_dir = os.path.dirname(original_file_path)
                if os.path.exists(original_dir):
                    target_path = os.path.join(original_dir, new_filename)
                    shutil.copy2(new_excel_path, target_path)
                    if os.path.exists(target_path):
                        saved_to_original = True
            except Exception as e:
                _logger.warning(f"[SyncApplyTAC-Fast] 保存到原始目录失败: {e}")

        # 更新数据索引
        metadata = {}
        for net in ["LTE", "NR"]:
            if net in parsed_data:
                metadata[f"{net}SiteCount"] = len(parsed_data[net])
                metadata[f"{net}SectorCount"] = sum(len(s.get("sectors", [])) for s in parsed_data[net])

        data_service.index[new_data_id] = {
            "id": new_data_id,
            "name": new_filename,
            "type": "excel",
            "fileType": "full_params",
            "size": new_excel_path.stat().st_size,
            "uploadDate": datetime.now().isoformat(),
            "status": "ready",
            "originalPath": original_path,
            "metadata": metadata,
        }

        # 删除旧工参
        if full_params_id in data_service.index:
            try:
                data_service.delete_data(full_params_id)
                _logger.info(f"[SyncApplyTAC-Fast] 已删除旧工参: {full_params_id}")
            except Exception as e:
                _logger.warning(f"[SyncApplyTAC-Fast] 删除旧工参失败: {full_params_id}, 错误: {e}")

        progress_holder[0] = 95

        return {
            "success": True,
            "message": f"成功应用TAC规划结果到全量工参，更新了{updated_count}个小区的TAC",
            "updatedCount": updated_count,
            "newFileId": new_data_id,
            "newFileName": new_filename,
            "savedToOriginal": saved_to_original,
            "deletedCount": deleted_count,
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

                existing = db.query(TaskResult).filter(TaskResult.task_id == task.task_id).first()
                if existing:
                    existing.result_json = result_json
                    existing.status = task.status.value
                    existing.progress = task.progress
                    existing.task_name = getattr(task, 'task_name', None) or existing.task_name
                    existing.user_name = getattr(task, 'user_name', None) or existing.user_name
                    existing.completed_at = task.completed_at.isoformat() if task.completed_at else None
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
                        created_at=task.created_at.isoformat() if task.created_at else datetime.now().isoformat(),
                        completed_at=task.completed_at.isoformat() if task.completed_at else None,
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
                db.commit()
                logger.info(f"[TaskManager] 任务已标记为已应用: {task_id[:8]}...")
                return True
            finally:
                db.close()
        except Exception as e:
            logger.error(f"[TaskManager] 标记任务已应用失败: {e}")
            return False

    def list_task_history(self, task_type: Optional[str] = None, limit: int = 50, user_name: Optional[str] = None) -> List[Dict]:
        """从 SQLite 获取历史任务列表，支持按用户过滤"""
        try:
            from app.core.database import SessionLocal
            from app.models.database import TaskResult

            db = SessionLocal()
            try:
                query = db.query(TaskResult)
                if task_type:
                    query = query.filter(TaskResult.task_type == task_type)
                if user_name:
                    query = query.filter(TaskResult.user_name == user_name)
                results = query.order_by(TaskResult.created_at.desc()).limit(limit).all()
                return [{
                    "taskId": r.task_id,
                    "taskType": r.task_type,
                    "taskName": r.task_name,
                    "userName": r.user_name,
                    "status": r.status,
                    "progress": r.progress,
                    "config": json.loads(r.config_json) if r.config_json else {},
                    "resultSummary": self._extract_result_summary(r.result_json),
                    "isApplied": bool(r.is_applied) if hasattr(r, 'is_applied') and r.is_applied else False,
                    "createdAt": r.created_at,
                    "completedAt": r.completed_at,
                } for r in results]
            finally:
                db.close()
        except Exception as e:
            logger.error(f"[TaskManager] 读取历史任务失败: {e}")
            return []

    @staticmethod
    def _extract_result_summary(result_json_str: Optional[str]) -> Optional[Dict]:
        """从完整 result JSON 中提取轻量摘要字段（避免历史列表返回大数据）"""
        if not result_json_str:
            return None
        try:
            r = json.loads(result_json_str)
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
                        db.delete(row)
                        db.commit()
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
