# 设计文档：任务状态保持 / PCI 应用优化 / 地图标记点样式

**日期**: 2026-06-03
**状态**: 已批准

---

## 目录

1. [主题 1：任务状态保持与全局进度指示器](#主题-1任务状态保持与全局进度指示器)
2. [主题 2：PCI 应用性能优化](#主题-2pci-应用性能优化)
3. [主题 3：地图搜索标记点样式调整](#主题-3地图搜索标记点样式调整)

---

## 主题 1：任务状态保持与全局进度指示器

### 目标

PCI 规划、邻区规划、TAC 核查、TAC 规划模块在执行任务时，用户切出到其他页面再切换回来时依然保持任务状态（进度数值），顶部导航栏显示全局任务进行状态指示器。

### 设计方案：Zustand 状态提升 + 全局指示器

#### 1.1 状态持久化策略

为四个模块创建/扩展专用的 Zustand store，参考 `tacPlanningStore` 模式，将页面级状态持久化到 localStorage：

**PCI 规划 Store** (`pciStore.ts`):
- `wizardStep` — 当前向导步骤
- `config` — PCI 规划参数（networkType, distanceThreshold, pciRange 等）
- `selectedCellIds` — 选中的小区 ID 列表
- `activeLeftTab` — 当前激活的标签页（'history' | 'task-config' | 'planning-result'）
- `taskName` — 任务名称

**邻区规划 Store** (`neighborStore.ts`):
- 同上，存储邻区规划特定参数

**TAC 核查 Store** (`tacCheckStore.ts`):
- 上文 TACPage 使用的 `useTACStore` 扩展，添加 `wizardStep`、`activeLeftTab` 等

**TAC 规划 Store** (`tacPlanningStore.ts`):
- 已有 `tacPlanningStore`，但不完整。补充 `activeLeftTab`

所有 store 使用 Zustand `persist` 中间件，`partialize` **保留全部字段**（注意结果数据容量问题，可设置大小限制）。

#### 1.2 页面状态恢复流程

```
页面重新挂载
  │
  ├── 从 store 读取 wizardStep
  │     └── 非 'idle' 则恢复对应步骤的 UI 状态
  │
  ├── 从 store 读取 activeLeftTab
  │     └── 切换到对应的标签页
  │
  ├── 从 store 读取 config
  │     └── 恢复表单参数
  │
  ├── 从 store 读取 selectedCellIds
  │     └── 恢复选中的小区
  │
  ├── 检查 activeTaskIds[type] (已有 taskStore 能力)
  │     └── 存在进行中的任务 → 恢复进度轮询
  │
  └── 检查 localStorage 中的结果数据
        └── 缺失则调用 getResult API 重新获取
```

#### 1.3 全局任务状态指示器

在 `MainLayout.tsx` 中添加 `GlobalTaskIndicator` 组件：

**位置**: 顶部导航栏右端（或顶部横幅区域）
**展示内容**:
- 任务类型图标 + 名称（"PCI 规划执行中..."）
- 进度百分比数值（"65%"）
- 进度条（窄条，保持克制）
- 完成或失败时的短暂提示（3 秒后自动消失）

**数据来源**:
- 读取 `taskStore.activeTaskIds` 和 `taskStore.tasks[id].progress`
- 通过模块级 `pollingIntervals` 持续更新（现有机制）
- 点击指示器可跳转到对应模块页面

**实现要点**:
- 指示器组件独立于路由页面，在 `MainLayout` 中始终挂载
- 使用 `useTaskStore` 的 `tasks` 和 `activeTaskIds` 驱动渲染
- 当所有 `activeTaskIds` 为 null 或对应任务已完成/失败时，指示器隐藏
- 避免额外的轮询开销——复用 `taskStore` 中已有的 HTTP 轮询数据

#### 1.4 异步执行验证

当前异步执行链条已正常工作：
```
前端 POST /plan → 后端 asyncio.create_task() → 立即返回 taskId
  → 前端 startGlobalPolling(2s 间隔) → GET /progress/{id}
  → 后端更新 task.progress → 前端读取进度
  → 任务完成 → completeTask() → stopGlobalPolling()
```

**需要确认/修复的点**:
1. 前端的 `pollingIntervals` 是模块级变量，不会随 React 组件卸载而清除 ✅
2. 但 `startGlobalPolling` 的 `poll()` 函数中读取 `activeTaskIds[type]` 来自 Zustand store，这是安全的 ✅
3. 后端 `asyncio.create_task` 创建的 task 独立运行，不受 HTTP 连接影响 ✅
4. 任务完成后的结果通过 `completeTask()` 写入 Zustand store，在内存中保留 ✅
5. **潜在问题**: 刷新页面后 `result` 被 `partialize` 剥离，需要确保所有页面在 `planning-result` tab 下能正确调用 `getResult()` API 重新获取结果 ✅

#### 1.5 修改文件清单

| 文件 | 操作 |
|------|------|
| `frontend/src/renderer/store/pciStore.ts` | **新建** — PCI 规划状态 store |
| `frontend/src/renderer/store/neighborStore.ts` | **新建** — 邻区规划状态 store |
| `frontend/src/renderer/store/tacCheckStore.ts` | **新建** — TAC 核查状态 store |
| `frontend/src/renderer/store/tacStore.ts` | **修改** — 扩展为 tacCheckStore |
| `frontend/src/renderer/store/tacPlanningStore.ts` | **修改** — 补充缺失字段 |
| `frontend/src/renderer/store/taskStore.ts` | **修改** — 临时暴露结果数据（或确保 partialize 不剥离关键字段） |
| `frontend/src/renderer/components/Layout/MainLayout.tsx` | **修改** — 添加全局任务指示器 |
| `frontend/src/renderer/components/Layout/GlobalTaskIndicator.tsx` | **新建** — 全局任务状态指示器组件 |
| `frontend/src/renderer/pages/PCIPage.tsx` | **修改** — 使用 pciStore 替代 useState |
| `frontend/src/renderer/pages/NeighborPage.tsx` | **修改** — 使用 neighborStore 替代 useState |
| `frontend/src/renderer/pages/TACPage.tsx` | **修改** — 使用 tacCheckStore 替代 useState |
| `frontend/src/renderer/pages/TACPlanningPage.tsx` | **修改** — 同步 tacPlanningStore |

---

## 主题 2：PCI 应用性能优化

### 目标

点击"应用"按钮将 PCI 规划结果写入工参，从"几分钟"优化至 1-3 秒内给出反馈。

### 设计方案：SQLite 快速路径 + Excel 真正后台化

#### 2.1 当前瓶颈分析

| 环节 | 耗时 | 优化方向 |
|------|------|---------|
| 复制 `original.xlsx` | 中 | 异步后台，不阻塞响应 |
| 逐个删除旧 full_params（`delete_data()` 循环） | 中 | 批量处理 |
| 加载 Excel + openpyxl 逐行更新 + 保存 | **高** | 完全移到后台 |
| `_save_index()` 全量写入 | 低 | 接受现状 |

#### 2.2 优化后的执行流程

```
用户点击"应用"
  │
  ├── Phase 1（前端等待，目标 < 2 秒）
  │    │
  │    ├── 1. 从 data_service.index 找到当前 full_params ID (O(1) 查找)
  │    │
  │    ├── 2. 从 SQLite 读取当前数据
  │    │      data_service.get_data_from_db(full_params_id)
  │    │
  │    ├── 3. 在内存中构建 PCI 更新映射（已是最优 O(n)）
  │    │
  │    ├── 4. 更新 sector["pci"] 值（已是最优 O(1) per sector）
  │    │
  │    ├── 5. 批量写入 SQLite（已是最优 bulk_insert_mappings）
  │    │
  │    ├── 6. 创建新 DATA_DIR/<uuid> + 复制 original.xlsx
  │    │    （改为：不复制 Excel，先只记录新 ID 和关联关系）
  │    │
  │    ├── 7. 更新 data_service.index
  │    │    - 标记旧 full_params 为 "待清理"
  │    │    - 注册新条目
  │    │    - 一次 _save_index()
  │    │
  │    └── 8. 返回响应 { updatedCount, newFileId } 给前端
  │
  └── Phase 2（后台执行，前端不等待）
       │
       ├── 1. 在后台 asyncio 任务中：
       │    - 复制 original.xlsx 到新目录
       │    - openpyxl 加载 → 更新 PCI → 保存
       │    - 清理旧 full_params 目录（文件删除）
       │    - 删除旧索引条目
       │    - 重新保存 index.json
       │
       └── 2. 完成（用户无感知，下次使用数据时已就绪）
```

#### 2.3 关键优化点

**1. 延迟 Excel 文件操作（最大收益）**
- 当前：Phase 1 中即复制 Excel → `openpyxl.load_workbook` → 逐行更新 → `save`（几分钟）
- 优化后：Phase 1 只写 SQLite，Phase 2 后台执行 Excel 操作
- 前端收到响应时，SQLite 已更新完毕，应用可直接使用新数据
- Excel 文件在后台线程池中完成，用户无需等待

**2. 批量索引操作**
- 当前：逐个遍历并调用 `delete_data()`（每次涉及文件 I/O + 索引写入）
- 优化后：先标记删除，最后一次性清理和写入 `_save_index()`

**3. 移除不必要的操作**
- 当前 `_sync_apply_pci_fast` 约 200 行，其中包含对旧数据的全量扫描和删除
- 优化后：直接聚焦 SQLite 更新路径，将文件操作职责分离

#### 2.4 API 调整

**前端调用链改造**：
```
当前（同步等待）:
  POST /apply-to-params/{task_id}  →  等待几分钟  →  返回

优化后（异步轮询）:
  POST /apply-to-params/{task_id}  →  立即返回 apply_task_id
  →  轮询 GET /apply-to-params/progress/{apply_task_id}
  →  当 progress >= 100 时显示"应用成功"
  →  后台继续完成 Excel 更新（用户无感知）
```

**或更简化方案**（前端改动最小）：
```
  POST /apply-to-params/{task_id}
  → 后端同步等待 SQLite 更新（~1-2 秒）
  → 立即返回 { success, updatedCount }
  → 后台 asyncio.create_task 继续执行 Excel 更新
  → 前端收到响应即显示成功
```

推荐后者，对前端改动最小，SQLite 更新基本在 2 秒内完成。

#### 2.5 修改文件清单

| 文件 | 操作 |
|------|------|
| `backend/app/services/task_manager.py` | **修改** — 重构 `_run_apply_pci_to_params_task`，分离 Phase 1/2，将 Excel 操作完全移到后台 |
| `backend/app/api/v1/endpoints/pci.py` | **修改** — 调整 apply 端点返回时机 |
| `frontend/src/renderer/pages/PCIPage.tsx` | **修改** — 调整 `handleApplyToParams`/`handleApplyTask` 逻辑 |

---

## 主题 3：地图搜索标记点样式调整

### 目标

将地图搜索结果的标记点从现在的 24px 红色水滴形图钉改为 16px 纯红色小圆点，减少对地图图形元素的遮挡。

### 设计方案：复用打点标记样式

#### 3.1 更改位置

`frontend/src/renderer/components/Map/OnlineMap.tsx`，`setSearchMarker` 方法（约 602-633 行）。

#### 3.2 样式变更

```tsx
// 当前（水滴形图钉）
const icon = L.divIcon({
    html: `<div style="background-color: #ef4444; width: 24px; height: 24px; 
           border-radius: 50% 50% 50% 0; transform: rotate(-45deg); 
           border: 3px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.3);"></div>`,
    className: 'search-marker-icon',
    iconSize: [24, 24],
    iconAnchor: [12, 24]
})

// 优化后（红色小圆点，复用 capture-marker 样式）
const icon = L.divIcon({
    html: `<div style="background-color: #ef4444; width: 16px; height: 16px; 
           border-radius: 50%; border: 2px solid white; 
           box-shadow: 0 2px 6px rgba(0,0,0,0.3);"></div>`,
    className: 'search-marker-icon',
    iconSize: [16, 16],
    iconAnchor: [8, 8]
})
```

#### 3.3 可选：CSS class 外化

在 `index.css` 中添加 `.search-marker-icon` 样式（替代内联 style），便于后续维护：

```css
.search-marker-icon div {
    background-color: #ef4444;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid white;
    box-shadow: 0 2px 6px rgba(0,0,0,0.3);
}
```

#### 3.4 修改文件清单

| 文件 | 操作 |
|------|------|
| `frontend/src/renderer/components/Map/OnlineMap.tsx` | **修改** — 更改 `setSearchMarker` 中的 `divIcon` html 和尺寸 |
| `frontend/src/renderer/index.css` | **修改** — 可选：添加 `.search-marker-icon` 样式 |

---

## 实现优先级

| 优先级 | 主题 | 预估工时 | 风险 |
|--------|------|---------|------|
| P0 | 主题 2：PCI 应用优化 | 中等 | 低 — 改动集中在 task_manager.py 的 apply 流程 |
| P1 | 主题 3：地图搜索标记点 | 小 | 极低 — 单文件 20 行内改动 |
| P2 | 主题 1：任务状态保持 | 较大 | 中 — 涉及多个新 store 和页面重构 |

## 实现建议

1. **先做 P0（PCI 优化）** — 后端独立改动，测试简单，用户感知最强
2. **再做 P1（标记点）** — 改动最小，立竿见影
3. **最后 P2（状态保持）** — 改动量最大，需要仔细测试各页面的状态恢复
