# 方案B: 网络规划工具并行优化设计

**日期**: 2026-06-04
**状态**: 已批准
**目标**: 提升多用户共享 Arm64 小主机（4核ARM + 4GB RAM）上的任务并行处理能力

---

## 问题概述

当前项目运行在 Armbian 小主机（RK3588 4核ARM + 4GB RAM），多个用户共享后端服务。存在两个性能问题：

1. **单任务耗时久**：上万个小区的 PCI 规划/邻区规划需要数分钟
2. **多用户互相阻塞**：一个用户跑任务时，其他用户必须排队

## 根因分析

| 问题 | 根因 |
|------|------|
| PCI 规划慢 | 纯 Python Haversine 距离计算，无缓存，O(N²) 循环，无向量化 |
| 邻区规划慢 | 外层循环串行跑所有源小区（本可并行） |
| CPU 资源闲置 | 单进程单线程，GIL 锁死 3 个核心 |
| TaskManager 调度弱 | 无信号量、无超时、硬编码限制、不读配置 |

---

## 设计方案

### Stage 1: 基础架构层

#### 1A — DistanceCalculator 距离缓存与向量化

**文件**: `backend/app/algorithms/distance_calculator.py`

- `batch_haversine(lats1, lons1, lats2, lons2)` → numpy 向量化批距离（替代 N×M 标量循环）
- `batch_distance_matrix(lats, lons)` → 全量 N×N 距离矩阵（float32，3000 小区 = 3.6MB）
- `@lru_cache(maxsize=500000)` 缓存 Haversine 结果（同站共享坐标减少 90%+ 重复）

**风险**: 低。新增 API，不移除旧 API，旧代码不受影响。

#### 1B — 配置新增 `NPT_MAX_WORKERS`

**文件**: `backend/app/core/config.py`

- 新增 `NPT_MAX_WORKERS: int = 3`（进程池大小，可环境变量覆盖）
- 区分 `NPT_MAX_TASKS`（并发任务准入上限，已有）和 `NPT_MAX_WORKERS`（CPU Worker 数）

**风险**: 零。纯配置追加，不影响现有行为。

#### 1C — TaskManager 调度改造

**文件**: `backend/app/services/task_manager.py`

- 读取配置的 `NPT_MAX_TASKS` 和 `NPT_TASK_TIMEOUT`（替代 `max_tasks = 10` 硬编码）
- `asyncio.Semaphore(max_tasks)` 真正排队准入（替代快照计数）
- `asyncio.wait_for(task, timeout)` 超时杀任务
- 提取公共 `_check_and_acquire_slot()` 方法，消除 5 个 `create_*` 方法的重复计数逻辑

**风险**: 中。需测试 Semaphore 释放路径和超时触发后的任务清理。

### Stage 2: PCI 规划向量化 + 空间索引

**文件**: `backend/app/algorithms/pci_planning_service_v2.py`

#### 2A — `validate_pci_reuse_distance` 向量化
- 将 `self.assigned_pcis` 从 Python 列表转为 NumPy 结构数组 (pci/lat/lon/earfcn)
- 一次 `batch_haversine` 计算到所有已分配小区距离
- NumPy mask 按 PCI 值过滤 → 取最小值
- 复杂度: O(N×M) → O(N+M)

#### 2B — 后验证阶段向量化
- 一次 `batch_distance_matrix` 计算 P×P 距离矩阵（float32，3000 小区 = 3.6MB）
- 矩阵切片 + mask 过滤替代外循环遍历
- 复杂度: O(P²+P×B) → O(P²) 全量矩阵 + O(1) 查询

#### 2C — 同站缓存
- `@lru_cache` 自动缓存同一坐标对结果
- 第一扇区算完，同站第二/三扇区命中缓存

**风险**: **高**（结果一致性）。采用三层验证策略：
1. **单元级逐点验证**: 向量化距离与标量距离误差 < 1cm
2. **算法级回归测试**: 优化前后 PCI 输出逐小区对比，一致率 100%
3. **端到端 API 回归**: FastAPI TestClient 模拟完整规划流程

**预计**: 后验证从 ~30 秒降到 ~0.5 秒（60x），候选检查从 ~100x

### Stage 3: 邻区规划并行化

**文件**: `backend/app/algorithms/neighbor_planning_v1_service.py`

- `plan_neighbors_for_cell` 解耦为模块级函数：目标数据作为显式参数（不再依赖 `self`）
- `ThreadPoolExecutor(max_workers=cpu_count)` 并行处理源小区分块
- 原子计数器替代 `progress_callback`（CPython GIL 保证 int 的原子性）
- 选 ThreadPool 而非 ProcessPool：NumPy 数组操作释放 GIL，数据零拷贝

**风险**: 中。重构独立函数时需确保参数完整，不遗漏依赖。

### Stage 4: TAC 规划优化（强制 STRtree + 消除线性扫描）

**文件**: `backend/app/services/tac_planning_service.py`

- **消除线性扫描兜底**: 删除 `STRTREE_AVAILABLE` 条件分支和 `tac_zones` 字典回退
- **STRtree 设为硬依赖**: 项目中已安装 geopandas + shapely，STRtree 必然可用
- **缓存加固**: `_strtree_cache` 按 `(network_type, file_mtime)` 作为键，TAC 文件不变则不重建
- **消除并行路径**: 查询全部走 `strtree.query()`，不再保留 `for poly in tac_zones` 线性扫描

**风险**: 低。删除失效分支 + 缓存加固，不改变业务逻辑。

### Stage 5: ProcessPoolExecutor 集成

**文件**: `backend/app/services/task_manager.py` + `backend/main.py`

#### 5A — 创建进程池

```python
ProcessPoolExecutor(max_workers=NPT_MAX_WORKERS, mp_context=fork)
```

- `fork` 模式：COW 零拷贝、启动快
- 提前在 `lifespan` 事件中初始化（避免 asyncio fork 死锁）

#### 5B — 跨进程进度传递
- `multiprocessing.Queue` 作为进度管道
- 主进程 `asyncio` 通过 `loop.run_in_executor(None, queue.get)` 非阻塞读取
- worker 函数在模块顶层（可 pickle），内部建独立 event loop

#### 5C — 超时机制
- `asyncio.wait_for(loop.run_in_executor(pool, worker_fn, args), timeout)`
- 超时后任务 FAILED，Semaphore 释放，下一任务开始

#### 5D — 优雅降级

```python
try:
    result = await loop.run_in_executor(pool, worker_fn, args)
except (BrokenProcessPool, PicklingError):
    result = await asyncio.to_thread(worker_fn, args)
```

#### 5E — 启动时机
- 在 `lifespan` 中 `yield` 前创建进程池
- 在 `lifespan` 关闭时 `pool.shutdown(wait=False)`

#### 各任务并行策略

| 任务类型 | Executor | 原因 |
|---------|----------|------|
| PCI 规划 | ProcessPoolExecutor | CPU 密集 + 长耗时，COW 共享 numpy 数组 |
| 邻区规划 | ThreadPoolExecutor | NumPy 操作释放 GIL，零拷贝 > 隔离性 |
| TAC 核查/规划 | ThreadPoolExecutor | 主要是 shapely + geopandas I/O |
| 工参更新 | ThreadPoolExecutor (现有) | openpyxl I/O + 少量计算 |

**风险**: 高。进程池稳定性（fork 死锁、pickle 限制、优雅降级路径完整）

---

## 实施顺序

```
Stage 1A (距离工具) → Stage 1B (配置) → Stage 1C+5A (TaskManager 基础)
  │
  ├─→ Stage 2A (PCI 候选检查向量化)   ← 需要 1A
  ├─→ Stage 2B (PCI 后验证向量化)     ← 需要 1A
  ├─→ Stage 2C (同站缓存)             ← 需要 1A
  │
  ├─→ Stage 3 (邻区并行)              ← 独立
  ├─→ Stage 4 (TAC 优化)              ← 独立
  │
  └─→ Stage 5B-5E (进程池集成)        ← 需要 1C+5A
      │
      └─→ 测试 + 部署调整
```

## 工作量估计

| 子任务 | 文件 | 改动量 | 风险 | 预计时间 |
|-------|------|--------|------|---------|
| 1A | distance_calculator.py | +60 行 | 低 | 0.5h |
| 1B | config.py | +3 行 | 低 | 0.1h |
| 1C | task_manager.py (前半) | +100 行 | 中 | 1h |
| 2A-2C | pci_planning_service_v2.py | +200 行 | 高 | 2h |
| 3 | neighbor_planning_v1_service.py | +150 行 | 中 | 1.5h |
| 4 | tac_planning_service.py | +40 行 | 低 | 0.5h |
| 5A-5E | task_manager.py (后半) + main.py | +150 行 | 高 | 2h |
| 测试 | 所有 + 性能验证 | +200 行 | - | 2h |
| **合计** | | | | **~10h** |
