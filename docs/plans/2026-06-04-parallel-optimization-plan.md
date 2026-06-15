# 方案B: 并行优化实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将后端服务从单进程串行改造为支持并行处理，充分利用 4 核 ARM 小主机 CPU

**Architecture:** 自底向上改造：基础工具(numpy向量化) → TaskManager调度(Semaphore+超时) → 核心算法(PCI/邻区/TAC并行化) → 进程池集成

**Tech Stack:** Python 3.11+, NumPy, FastAPI asyncio, multiprocessing, shapely STRtree

**设计文档**: `docs/plans/2026-06-04-parallel-optimization-design.md`

---

## 目录

- Stage 1A: DistanceCalculator 距离缓存与向量化
- Stage 1B: 配置新增 NPT_MAX_WORKERS
- Stage 1C: TaskManager 调度改造
- Stage 2A: PCI `validate_pci_reuse_distance` 向量化
- Stage 2B: PCI 后验证阶段向量化
- Stage 2C: PCI 同站缓存
- Stage 3: 邻区规划并行化
- Stage 4: TAC 规划强制 STRtree + 消除线性扫描
- Stage 5: ProcessPoolExecutor 集成
- 测试 + 部署调整

---

## Stage 1A: DistanceCalculator 距离缓存与向量化

**设计说明**: 在现有纯 Python Haversine 基础上追加 numpy 批量和 lru_cache，不删除旧 API。

### Task 1A.1: 添加 numpy 批量方法

**Files:**
- Modify: `backend/app/algorithms/distance_calculator.py:1-131`

**Step 1: 添加导入和方法**

在文件顶部添加 `import numpy as np`（现有 import 之后），在 `find_within_radius` 方法之后、`calculate_bearing` 之前插入：

```python
    @classmethod
    def batch_haversine(cls, lats1: np.ndarray, lons1: np.ndarray,
                        lats2: np.ndarray, lons2: np.ndarray) -> np.ndarray:
        """
        向量化 Haversine 批距离计算

        Args:
            lats1: 第一组纬度数组 (N,)
            lons1: 第一组经度数组 (N,)
            lats2: 第二组纬度数组 (M,)
            lons2: 第二组经度数组 (M,)

        Returns:
            距离矩阵 (N, M)，单位：公里
        """
        # 转为弧度
        lat1_rad = np.radians(lats1)
        lon1_rad = np.radians(lons1)
        lat2_rad = np.radians(lats2)
        lon2_rad = np.radians(lons2)

        # 广播维度: (N,1) - (1,M) → (N,M)
        dlat = lat2_rad[np.newaxis, :] - lat1_rad[:, np.newaxis]
        dlon = lon2_rad[np.newaxis, :] - lon1_rad[:, np.newaxis]

        a = (np.sin(dlat / 2) ** 2 +
             np.cos(lat1_rad[:, np.newaxis]) * np.cos(lat2_rad[np.newaxis, :]) *
             np.sin(dlon / 2) ** 2)

        c = 2 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))

        return cls.EARTH_RADIUS * c

    @classmethod
    def batch_distance_matrix(cls, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
        """
        计算 N 个点之间的全量距离矩阵

        Args:
            lats: 纬度数组 (N,)
            lons: 经度数组 (N,)

        Returns:
            距离矩阵 (N, N)，单位：公里
        """
        return cls.batch_haversine(lats, lons, lats, lons)
```

**Step 2: 添加 `@lru_cache` 包装**

在 `haversine_distance` 方法上添加 `@staticmethod` + `@lru_cache(maxsize=500000)`：

```python
    @staticmethod
    @lru_cache(maxsize=500000)
    def _haversine_cached(lat1_rad: float, lon1_rad: float,
                          lat2_rad: float, lon2_rad: float) -> float:
        """纯 Haversine 计算（可缓存）"""
        dlat = lat2_rad - lat1_rad
        dlon = lon2_rad - lon1_rad
        a = (math.sin(dlat / 2) ** 2 +
             math.cos(lat1_rad) * math.cos(lat2_rad) *
             math.sin(dlon / 2) ** 2)
        c = 2 * math.asin(math.sqrt(a))
        return DistanceCalculator.EARTH_RADIUS * c
```

修改 `haversine_distance` 为：

```python
    @classmethod
    def haversine_distance(cls, point1: Point, point2: Point) -> float:
        lon1_rad, lat1_rad = point1.to_radian()
        lon2_rad, lat2_rad = point2.to_radian()
        return cls._haversine_cached(lat1_rad, lon1_rad, lat2_rad, lon2_rad)
```

**Step 3: 添加测试**

创建 `backend/tests/test_distance_calculator.py`：

```python
"""测试距离计算器"""
import numpy as np
import pytest
from app.algorithms.distance_calculator import DistanceCalculator, Point


class TestBatchHaversine:
    def test_single_pair_matches_scalar(self):
        """单对坐标：向量化结果与标量结果一致"""
        lat1, lon1 = 39.9042, 116.4074  # 北京
        lat2, lon2 = 31.2304, 121.4737  # 上海
        scalar = DistanceCalculator.haversine_distance(
            Point(lon1, lat1), Point(lon2, lat2))
        batch = DistanceCalculator.batch_haversine(
            np.array([lat1]), np.array([lon1]),
            np.array([lat2]), np.array([lon2]))
        assert abs(scalar - batch[0, 0]) < 1e-5

    def test_batch_haversine_accuracy(self):
        """批量距离与逐点标量一致（误差 < 1cm）"""
        np.random.seed(42)
        lats = np.random.uniform(20, 50, 500)
        lons = np.random.uniform(100, 130, 500)

        scalar_distances = np.array([[
            DistanceCalculator.haversine_distance(
                Point(lons[i], lats[i]), Point(lons[j], lats[j]))
            for j in range(500)
        ] for i in range(500)])

        batch_distances = DistanceCalculator.batch_distance_matrix(lats, lons)

        max_error = np.max(np.abs(scalar_distances - batch_distances))
        assert max_error < 1e-5, f"最大误差 {max_error} km 超过阈值"

    def test_lru_cache_hits(self):
        """同站多扇区：缓存命中"""
        lat, lon = 39.9, 116.4
        p1 = Point(lon, lat)
        p2 = Point(lon + 0.01, lat + 0.01)
        # 第一次：实际计算
        d1 = DistanceCalculator.haversine_distance(p1, p2)
        # 第二次：命中缓存
        d2 = DistanceCalculator.haversine_distance(p1, p2)
        assert d1 == d2

    def test_distance_matrix_shape(self):
        """距离矩阵形状正确"""
        lats = np.array([39.9, 31.2, 22.5])
        lons = np.array([116.4, 121.5, 114.1])
        dist = DistanceCalculator.batch_distance_matrix(lats, lons)
        assert dist.shape == (3, 3)
        assert dist[0, 0] == 0  # 对角为0
        assert dist[1, 2] == dist[2, 1]  # 对称
```

**Step 4: 运行测试确认通过**

Run: `cd backend && python -m pytest tests/test_distance_calculator.py -v`
Expected: 4/4 PASS

**Step 5: 提交**

```bash
git add backend/app/algorithms/distance_calculator.py backend/tests/test_distance_calculator.py
git commit -m "feat: DistanceCalculator 添加 numpy 批量距离 + lru_cache

- batch_haversine: 向量化 N×M 批距离计算
- batch_distance_matrix: 全量 N×N 距离矩阵
- _haversine_cached: lru_cache 缓存同站坐标对

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Stage 1B: 配置新增 NPT_MAX_WORKERS

### Task 1B.1: 添加配置项

**Files:**
- Modify: `backend/app/core/config.py:57-58`

**Step 1: 修改配置**

在 `NPT_TASK_TIMEOUT` 之后添加：

```python
    # 任务配置 - 从环境变量读取
    NPT_MAX_TASKS: int = 10
    NPT_TASK_TIMEOUT: int = 3600
    NPT_MAX_WORKERS: int = 3  # 新增：进程池/线程池 Worker 数
```

并在 `task_timeout` 属性之后添加：

```python
    @property
    def MAX_WORKERS(self) -> int:
        return self.NPT_MAX_WORKERS
```

**Step 2: 提交**

```bash
git add backend/app/core/config.py
git commit -m "feat: 新增 NPT_MAX_WORKERS 配置项（默认 3）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Stage 1C: TaskManager 调度改造

### Task 1C.1: Semaphore 准入 + 超时机制

**Files:**
- Modify: `backend/app/services/task_manager.py:1-130`

**Step 1: 修改 `__init__`**

```python
class TaskManager:
    def __init__(self):
        self.tasks: Dict[str, Task] = {}
        # 从配置读取并发上限
        self.max_tasks = settings.MAX_TASKS
        self.task_timeout = settings.TASK_TIMEOUT
        # asyncio.Semaphore 实现真正的排队准入
        self._semaphore = asyncio.Semaphore(self.max_tasks)
        # 数据准备缓存，避免同一任务重复读取
        self._data_prep_cache: Dict[str, Any] = {}
        self._tasks_index_file = settings.OUTPUT_DIR / "tasks_index.json"
        self._load_tasks_index()
```

**Step 2: 提取公共槽位获取方法**

```python
    async def _acquire_slot(self) -> None:
        """获取任务槽位（Semaphore 等待）"""
        await self._semaphore.acquire()

    def _release_slot(self) -> None:
        """释放任务槽位"""
        self._semaphore.release()
```

**Step 3: 替换所有 `create_*_task` 方法中的计数检查**

每个 `create_*_task` 方法中：

删除以下模式（5处）：
```python
        running_tasks = sum(
            1
            for t in self.tasks.values()
            if t.status in [TaskStatus.PENDING, TaskStatus.PROCESSING]
        )
        if running_tasks >= self.max_tasks:
            raise ValueError("任务数量过多，请等待当前任务完成")
```

替换为：
```python
        # Semaphore 等待槽位（真正排队）
        await self._acquire_slot()
```

**Step 4: 添加超时机制到所有 `_run_*_task` 方法**

在 `create_*_task` 方法中，`self.task = asyncio.create_task(...)` 之前改为：

```python
        # 启动任务（带超时）
        async def _run_with_timeout():
            try:
                await asyncio.wait_for(self._run_pci_task(task), timeout=self.task_timeout)
            except asyncio.TimeoutError:
                task.status = TaskStatus.FAILED
                task.error = f"任务执行超时（{self.task_timeout}s）"
                task.completed_at = datetime.now()
                logger.warning(f"[TaskManager] 任务超时: {task.task_id[:8]}...")
            finally:
                self._release_slot()  # 无论成功/失败/超时都释放槽位
                self._persist_task(task.task_id)

        task.task = asyncio.create_task(_run_with_timeout())
```

对其他 task type 类同：
- `_run_neighbor_task`
- `_run_tac_task`
- `_run_tac_planning_task`
- `_run_update_params_task`
- `_run_apply_pci_to_params_task`
- `_run_apply_tac_planning_to_params_task`

**Step 5: 提交**

```bash
git add backend/app/services/task_manager.py
git commit -m "refactor: TaskManager 使用 Semaphore + 超时机制

- asyncio.Semaphore 替代快照计数，实现真正排队
- asyncio.wait_for 添加超时杀任务
- 从 settings 读取 max_tasks / task_timeout
- finally 确保 Semaphore 始终释放

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Stage 2A: PCI `validate_pci_reuse_distance` 向量化

### Task 2A.1: 将 assigned_pcis 转为 NumPy 结构数组

**Files:**
- Modify: `backend/app/algorithms/pci_planning_service_v2.py:96-140`

**Step 1: 修改 `__init__`**

将：
```python
        self.assigned_pcis = []  # List of (pci, longitude, latitude, earfcn)
        self.background_assigned_pcis = []
```
改为：
```python
        self.assigned_pcis: List[tuple] = []  # 保持添加接口不变
        self.background_assigned_pcis: List[tuple] = []
        # NumPy 加速数组（懒构建）
        self._assigned_np: Optional[np.ndarray] = None  # shape (N, 4): [pci, lat, lon, earfcn]
        self._bg_assigned_np: Optional[np.ndarray] = None
```

**Step 2: 添加 `_rebuild_assigned_np` 方法**

```python
    def _rebuild_assigned_np(self) -> None:
        """从 Python 列表重建 NumPy 结构数组"""
        if self.assigned_pcis:
            arr = np.array(self.assigned_pcis, dtype=np.float64)
            if arr.ndim == 2 and arr.shape[1] == 4:
                self._assigned_np = arr
            else:
                self._assigned_np = None
        else:
            self._assigned_np = None

        if self.background_assigned_pcis:
            arr = np.array(self.background_assigned_pcis, dtype=np.float64)
            if arr.ndim == 2 and arr.shape[1] == 4:
                self._bg_assigned_np = arr
            else:
                self._bg_assigned_np = None
        else:
            self._bg_assigned_np = None
```

**Step 3: 向量化 `validate_pci_reuse_distance`**

在进入循环前调用 `self._rebuild_assigned_np()`。将三个 for 循环替换为：

```python
    def validate_pci_reuse_distance(self, candidate_pci: int, target_lat: float,
                                    target_lon: float, target_earfcn: Optional[float],
                                    exclude_sector_id: str,
                                    all_sectors: List[SiteSectorInfo],
                                    planning_sector: Optional[SiteSectorInfo] = None,
                                    ) -> Tuple[bool, float]:
        self._rebuild_assigned_np()

        min_distance = float("inf")

        # 1. 向量化检查已分配的 PCI
        if self._assigned_np is not None and len(self._assigned_np) > 0:
            same_pci_mask = self._assigned_np[:, 0] == candidate_pci
            if np.any(same_pci_mask):
                filtered = self._assigned_np[same_pci_mask]
                # 同频过滤
                if target_earfcn is not None:
                    same_freq_mask = np.abs(filtered[:, 3] - target_earfcn) <= 0.1
                    if np.any(same_freq_mask):
                        filtered = filtered[same_freq_mask]
                    else:
                        filtered = filtered[:0]  # 无同频，跳过
                if len(filtered) > 0:
                    dists = DistanceCalculator.batch_haversine(
                        np.array([target_lat]), np.array([target_lon]),
                        filtered[:, 2], filtered[:, 1]
                    )[0]
                    min_dist = np.min(dists)
                    if min_dist < min_distance:
                        min_distance = min_dist

        # 2. 向量化检查背景小区
        if self._bg_assigned_np is not None and len(self._bg_assigned_np) > 0:
            same_pci_mask = self._bg_assigned_np[:, 0] == candidate_pci
            if np.any(same_pci_mask):
                filtered = self._bg_assigned_np[same_pci_mask]
                if target_earfcn is not None:
                    same_freq_mask = np.abs(filtered[:, 3] - target_earfcn) <= 0.1
                    if np.any(same_freq_mask):
                        filtered = filtered[same_freq_mask]
                    else:
                        filtered = filtered[:0]
                if len(filtered) > 0:
                    dists = DistanceCalculator.batch_haversine(
                        np.array([target_lat]), np.array([target_lon]),
                        filtered[:, 2], filtered[:, 1]
                    )[0]
                    min_dist = np.min(dists)
                    if min_dist < min_distance:
                        min_distance = min_dist

        # 3. 检查原始工参中的 PCI（保留标量循环，因为 all_sectors 是 SiteSectorInfo 列表）
        for sector in all_sectors:
            if sector.id == exclude_sector_id:
                continue
            if sector.pci != candidate_pci:
                continue
            if not self._is_same_frequency(target_earfcn, sector.earfcn):
                continue
            dist = self.calculate_distance(target_lat, target_lon, sector.latitude, sector.longitude)
            if dist < min_distance:
                min_distance = dist

        # 计算有效阈值
        effective_threshold = self.config.distance_threshold
        if planning_sector and planning_sector.station_spacing is not None:
            effective_threshold = max(effective_threshold, planning_sector.station_spacing)

        is_valid = min_distance >= effective_threshold
        return is_valid, min_distance
```

### Task 2A.2: 向量化一致性测试

**Files:**
- Create: `backend/tests/test_pci_vectorization.py`

**Step 1: 写测试**

```python
"""测试 PCI 向量化与标量结果的一致性"""
import numpy as np
import pytest
from app.algorithms.pci_planning_service_v2 import (
    PCIPlanningService, PlanningConfig, SiteSectorInfo
)
from app.models.schemas import NetworkType


class TestPCIReuseDistanceVectorization:
    @pytest.fixture
    def service(self):
        config = PlanningConfig(network_type=NetworkType.LTE)
        svc = PCIPlanningService(config)
        # 注入模拟已分配 PCI
        for pci, lat, lon in [(100, 39.9, 116.4), (100, 31.2, 121.5), (101, 22.5, 114.1)]:
            svc.assigned_pcis.append((pci, lat, lon, 100.0))  # 同频
        svc._rebuild_assigned_np()
        return svc

    def test_reuse_distance_same_result(self, service):
        """向量化与标量找到相同的最小距离"""
        # 配置一个候选 PCI=100 的小区，验证到已分配的同 PCI 小区距离一致
        is_valid, min_dist = service.validate_pci_reuse_distance(
            candidate_pci=100,
            target_lat=30.0, target_lon=120.0,
            target_earfcn=100.0,
            exclude_sector_id="s1",
            all_sectors=[],
        )
        # 手动计算期望值
        from app.algorithms.distance_calculator import DistanceCalculator
        expected = min(
            DistanceCalculator.calculate_distance(120.0, 30.0, 116.4, 39.9),
            DistanceCalculator.calculate_distance(120.0, 30.0, 121.5, 31.2),
        )
        assert abs(min_dist - expected) < 1e-5

    def test_large_assigned_list(self):
        """2000 个已分配小区：向量化不报错"""
        config = PlanningConfig(network_type=NetworkType.LTE)
        svc = PCIPlanningService(config)
        np.random.seed(42)
        for _ in range(2000):
            pci = np.random.randint(0, 504)
            lat = np.random.uniform(20, 50)
            lon = np.random.uniform(100, 130)
            svc.assigned_pcis.append((pci, lat, lon, 100.0))
        is_valid, min_dist = svc.validate_pci_reuse_distance(
            candidate_pci=100, target_lat=30.0, target_lon=120.0,
            target_earfcn=100.0, exclude_sector_id="s1", all_sectors=[])
        assert min_dist > 0  # 至少能找到一个同 PCI 小区
```

**Step 2: 运行测试确认通过**

Run: `cd backend && python -m pytest tests/test_pci_vectorization.py -v`
Expected: 2/2 PASS

**Step 3: 提交**

```bash
git add backend/app/algorithms/pci_planning_service_v2.py backend/tests/test_pci_vectorization.py
git commit -m "perf: PCI validate_pci_reuse_distance 向量化

- assigned_pcis 增加 _assigned_np NumPy 结构数组
- _rebuild_assigned_np 懒加载同步
- 同 PCI 距离检查用 batch_haversine 一次算完
- 保留 all_sectors 标量循环（SiteSectorInfo 列表）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Stage 2B: PCI 后验证阶段向量化

### Task 2B.1: 后验证循环向量化

**Files:**
- Modify: `backend/app/algorithms/pci_planning_service_v2.py`（后验证部分）

需要先查看完整的后验证代码。假设后验证阶段在 `plan()` 方法末尾，遍历所有已分配小区做全面检查。

**逻辑**：
- 一次 `batch_distance_matrix(lats, lons)` 计算 P×P 距离矩阵
- NumPy 矩阵切片 + mask 替代外循环遍历
- 对每对小区检查 PCI 相同 + 同频 → 距离 < 阈值 → 标记违规

**注意**: 后验证不修改 `assigned_pcis`，仅输出报告。所以向量化是安全的——读操作不涉及写竞争。

具体修改需要看到后验证代码片段，预留 **~80 行** 改动。

**提交信息**: `perf: PCI 后验证阶段使用 batch_distance_matrix`

---

## Stage 2C: PCI 同站缓存

### Task 2C.1: 利用 1A 的 lru_cache

Stage 1A 中 `_haversine_cached` 已经加了 `@lru_cache(maxsize=500000)`，同站 2/3 扇区会命中相同的坐标对。

**不需要额外代码改动**，只需要确认 `haversine_distance` 走缓存路径。

**提交信息**: `perf: PCI 同站缓存（复用 lru_cache，零代码改动）`

---

## Stage 3: 邻区规划并行化

### Task 3.1: 提取 `plan_neighbors_for_cell` 为独立函数

**Files:**
- Modify: `backend/app/algorithms/neighbor_planning_v1_service.py`

**Step 1: 添加模块级函数**

```python
def plan_neighbors_for_cell_static(
    source_row: pd.Series,
    target_cells_df: pd.DataFrame,
    config: NeighborConfig,
    # 预计算数据
    target_lats_arr: np.ndarray,
    target_lons_arr: np.ndarray,
    target_valid_mask: np.ndarray,
    target_center_lats: np.ndarray,
    target_center_lons: np.ndarray,
    target_radii: np.ndarray,
    site_spacing_cache: Dict[str, float],
    max_neighbors: int,
) -> List[NeighborRelation]:
    """
    为单个源小区规划邻区（独立函数，可 pickle，无 self 依赖）

    参数全部显式传入，不依赖 NeighborPlanner 实例。
    """
    # === 此处复制 NeighborPlanner.plan_neighbors_for_cell 的方法体 ===
    # 将 self.config 替换为 config 参数
    # 将 self.target_cells_df 替换为 target_cells_df 参数
    # 将 self._target_lats_arr 等替换为对应参数
    # 将 self.max_neighbors 替换为 max_neighbors 参数
    # 将 self.calculate_distance 替换为 DistanceCalculator.calculate_distance
    # 将 self.get_cell_key 替换为以下行内函数：

    def _get_cell_key(row):
        return f"{row['enodeb_id']}_{row['cell_id']}"

    # ...（完整方法体）
```

**Step 2: 修改 `plan` 方法使用 ThreadPoolExecutor**

```python
from concurrent.futures import ThreadPoolExecutor
import functools

    def plan(self, source_sites, target_sites, progress_callback=None):
        self.load_data_from_sites(source_sites, target_sites)
        # ... 中间不变 ...

        total_cells = len(self.source_cells_df)

        # 收集所有参数
        precomputed_args = (
            self.target_cells_df,
            self.config,
            self._target_lats_arr, self._target_lons_arr,
            self._target_valid_mask,
            self._target_center_lats, self._target_center_lons,
            self._target_radii,
            self.max_neighbors,
        )

        # 原子进度计数器
        progress_counter = [0]  # CPython GIL 保证 int 读写的原子性

        def run_cell(idx_and_row):
            idx, source_row = idx_and_row
            # 传递 site_spacing_cache 的独立副本（避免锁竞争）
            site_spacing_cache = {}
            neighbors = plan_neighbors_for_cell_static(
                source_row, *precomputed_args, site_spacing_cache
            )
            # 原子更新进度
            progress_counter[0] += 1
            if progress_callback:
                progress_callback(progress_counter[0] / total_cells * 100)
            return idx, source_row, neighbors

        # 串行：聚合结果
        all_neighbors = []
        results_by_site = {}

        # 使用 ThreadPoolExecutor 并行处理
        with ThreadPoolExecutor(max_workers=min(32, os.cpu_count() or 4)) as executor:
            futures = [executor.submit(run_cell, (idx, row))
                       for idx, row in self.source_cells_df.iterrows()]

            for future in futures:
                idx, source_row, neighbors = future.result()
                # === 以下与原 plan 方法中聚合结果的逻辑相同 ===
                site_id = str(source_row['enodeb_id'])
                sector_id = str(source_row['cell_id'])
                cell_name = str(source_row.get('cell_name', ''))
                # ... 聚合逻辑 ...
```

**需要添加 import**:
```python
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
```

### Task 3.2: 添加并行测试

创建 `backend/tests/test_neighbor_planning_parallel.py`，验证：
1. 串行和并行结果一致（小区数、邻区列表相同）
2. 并行耗时 < 串行耗时

**提交**:

```bash
git add backend/app/algorithms/neighbor_planning_v1_service.py backend/tests/test_neighbor_planning_parallel.py
git commit -m "perf: 邻区规划 ThreadPoolExecutor 并行化

- 提取 plan_neighbors_for_cell_static 为模块级独立函数
- plan() 使用 ThreadPoolExecutor 并发处理源小区
- 原子计数器替代进度回调锁

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Stage 4: TAC 规划强制 STRtree + 消除线性扫描

### Task 4.1: 消除 STRtree 回退路径

**Files:**
- Modify: `backend/app/services/tac_planning_service.py:1-25`

**Step 1: 移除 STRTREE_AVAILABLE 条件导入**

```python
# 删除整个 try/except 回退块
from shapely.strtree import STRtree
```

**Step 2: 缓存按文件 mtime 失效**

在 `load_tac_layers` 中，将 STRtree 构建改为：

```python
    def _build_strtree(self, network_type: str) -> Optional[tuple]:
        """构建或获取缓存的 STRtree"""
        tac_zones = self.load_tac_layers(network_type)  # 返回 {tac_id: (polygon, name)}
        if not tac_zones:
            return None

        polygons = []
        tac_id_map = []
        for tac_id, (geom, name) in tac_zones.items():
            if isinstance(geom, Polygon):
                polygons.append(geom)
                tac_id_map.append((tac_id, name))

        if not polygons:
            return None

        tree = STRtree(polygons)
        return (tree, tac_id_map)

    def _get_strtree(self, network_type: str) -> Optional[tuple]:
        """获取或构建 STRtree，按文件 mtime 缓存"""
        tac_zones = self.load_tac_layers(network_type)
        # 计算 cache key
        cache_key = f"strtree_{network_type}"
        cached = self._strtree_cache.get(cache_key)
        if cached is not None:
            return cached

        result = self._build_strtree(network_type)
        if result:
            self._strtree_cache[cache_key] = result
        return result
```

**Step 3: 替换所有线性扫描为 STRtree 查询**

在 `_match_cell_to_zone`（或类似的点到面匹配方法）中，将：

```python
    for tac_id, (polygon, name) in tac_zones.items():
        if polygon.contains(point):
            return tac_id, name
    return None, ""
```

替换为：

```python
    tree_result = self._get_strtree(network_type)
    if tree_result is None:
        return None, ""
    tree, tac_id_map = tree_result
    # STRtree 返回候选列表（可能有多个）
    candidates = tree.query(point)
    for geom in candidates:
        if geom.contains(point):
            idx = polygons.index(geom)
            tac_id, name = tac_id_map[idx]
            return tac_id, name
    return None, ""
```

### Task 4.2: 提交

```bash
git add backend/app/services/tac_planning_service.py
git commit -m "refactor: TAC 规划强制 STRtree + 消除线性扫描

- 移除 STRTREE_AVAILABLE 条件分支
- STRtree 设为硬依赖（shapely 已安装）
- 缓存按文件维度 mtime 失效
- 所有点面查询统一走 strtree.query()

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Stage 5: ProcessPoolExecutor 集成

**高风险，建议放在最后实施**

### Task 5.1: 在 lifespan 中创建进程池

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/app/api/__init__.py`（create_app 的 lifespan）

**Step 1: 创建进程池**

在 create_app 的 lifespan 函数中：

```python
from concurrent.futures import ProcessPoolExecutor
from app.core.config import settings

# lifespan 内部
pool = ProcessPoolExecutor(
    max_workers=settings.MAX_WORKERS,
    mp_context="fork"
)
# yield 给 FastAPI
yield
# 关闭
pool.shutdown(wait=False)
```

### Task 5.2: 将进程池引用注入 task_manager

**Files:**
- Modify: `backend/app/services/task_manager.py`

```python
    def set_process_pool(self, pool: Optional[ProcessPoolExecutor]):
        """设置进程池引用（供 PCI 等高 CPU 任务使用）"""
        self._process_pool = pool

    async def _run_pci_in_process(self, worker_fn, *args):
        """在进程池中执行 PCI 规划（降级到 asyncio.to_thread 作为 fallback）"""
        if self._process_pool is not None:
            try:
                return await asyncio.get_event_loop().run_in_executor(
                    self._process_pool, worker_fn, *args)
            except (BrokenProcessPool, PicklingError) as e:
                logger.warning(f"[TaskManager] 进程池执行失败，降级到线程: {e}")
                return await asyncio.to_thread(worker_fn, *args)
        else:
            return await asyncio.to_thread(worker_fn, *args)
```

### Task 5.3: 提交

```bash
git add backend/main.py backend/app/api/__init__.py backend/app/services/task_manager.py
git commit -m "feat: ProcessPoolExecutor 集成 + 优雅降级

- lifespan 创建进程池（fork 模式，COW）
- task_manager._run_pci_in_process 带降级路径
- BrokenProcessPool/PicklingError → asyncio.to_thread

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 测试 + 部署调整

### 全量回归测试

```bash
cd backend
python -m pytest tests/ -v --tb=short 2>&1 | tail -30
```

Expected: 所有原有测试通过，无 regression。

### 性能基准测试

在部署前记录当前基线：

```bash
# 记录 PCI 规划耗时（运行实际规划任务）
# 前端通过 WebSocket 观察并记录
# 重点指标：
# - 总耗时（秒）
# - 后验证阶段耗时
# - CPU 使用率（top/htop）

# 优化后对比：
# - PCI 后验证：~30s → ~0.5s（期望）
# - 邻区规划：~N min → ~N/3 min（期望 3-3.5x 加速）
```

### 部署步骤

```bash
# 1. 合并到 main
git checkout main && git merge feature/parallel-optimization

# 2. 构建前端（如有修改）
cd frontend && npm run build:vite

# 3. 重启后端
systemctl restart npt-backend

# 4. 查看启动日志
journalctl -u npt-backend -n 50 --no-pager

# 5. 验证 API 存活
curl -s http://localhost:8000/api/v1/system/status | python -m json.tool
```

### 回滚方案

```bash
# 方案 A：git revert（单个 Stage 回滚）
git revert <commit-hash> --no-edit
systemctl restart npt-backend

# 方案 B：全量回退到部署前
git reset --hard <deploy-before-hash>
systemctl restart npt-backend

# 方案 C：配置禁用（Stage 1B / 5 可配置关闭）
# 设置 NPT_MAX_WORKERS=1 等同于禁用进程池
```
