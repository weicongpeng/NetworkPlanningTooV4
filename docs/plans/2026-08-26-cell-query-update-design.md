# 数据管理「查询/更新」模块设计文档

- 日期：2026-08-26
- 分支：layer-tools
- 状态：已确认

## 1. 背景与目标

在数据管理页新增「查询/更新」模块，实现对全量工参数据库缺漏或错误的小区信息进行查询、修改与删除，并保持与「新站录入」一致的"SQLite 数据库 + 全量工参 Excel 文件"双写一致性，保证导出的全量工参为最新数据。

## 2. 已确认的关键决策

| 决策点 | 结论 |
|--------|------|
| 数据源 | SQLite 数据库（`data.db` 的 Site/Sector 表）+ 全量工参 Excel 文件（`original.xlsx`）双写 |
| 搜索范围 | 全局唯一 full_params 工作簿，无需用户选择；检测到多个时日志告警供排查（视为异常态） |
| 校验规则 | 库内校验为主：标识冲突/重复、超范围（经纬度/方向角/MNC/频点）、主键修改跨制式占用；不引入现网 ZIP 比对 |
| 编辑列 | 与新站录入完全一致（网元ID、基站ID、小区ID、小区名称、MCC、MNC、经度、纬度、方向角、频点/SSB频点、覆盖类型）；「基站名称」仅作搜索定位词 |
| 交互模式 | 多行批量模式：搜索下拉追加多行到编辑表，一次「更新」批量处理 |
| 实现方案 | 方案 A：后端专用端点 + 复用双写服务 |
| 权限 | 沿用 `require_cell_entry`（与「新站录入」一致） |

## 3. 前端 UI 结构

### 3.1 模块切换

DataPage 数据操作区顶部新增 `[查询/更新] [新站录入]` 两个 Tab 按钮，点击切换、同一时刻仅一个激活。默认「新站录入」，保持现有行为不变。

### 3.2 「查询/更新」面板（自上而下）

1. **搜索框**：输入防抖 300ms 调后端搜索，下拉展示匹配结果。模糊匹配字段：小区名称、网元ID、基站ID、基站名称。下拉项显示：小区名称、站点ID_小区ID、站点名称 + 制式标签(LTE/NR)。支持 ↑↓+Enter 或点击选择。
2. **LTE/NR 页签**：与「新站录入」一致的双页签。
3. **编辑表**：列与新站录入完全一致，多行。最左侧每行一个红色「X」删除标记按钮，点击标记待删除（行变灰+删除线），再点取消标记。行可编辑。支持新站录入同款多行粘贴/复制、列宽拖拽。
4. **操作区**：「更新」主按钮 + 「清空」按钮。

**选中行为**：
- 选中小区级匹配 → 以该小区一行追加到当前页签编辑表；
- 选中站点级信息（站点名称/基站ID/网元ID）→ 带出该站全部扇区为多行；
- 重复选中同一小区自动去重。

### 3.3 确认弹窗

点击「更新」后先汇总变更，不直接落库：
- 每个更新行展示 `字段名：旧值 → 新值`；
- 每个删除行展示 `小区名 (站点ID_小区ID)`；
- 用户点「确认执行」才真正执行，「取消」返回编辑。

### 3.4 结果反馈

复用现有 `addLog` 日志与行级成功/失败结果列表样式（同新站录入 batchResults）。

## 4. 后端 API 设计

### 4.1 搜索 `POST /api/v1/data/cell-entry/search`

- 请求：`{ query: string, networkType?: 'LTE'|'NR', limit?: number }`
- 响应：`{ success: true, data: [{ rowKey, networkType, siteId, cellId, cellName, siteName, managedElementId, mcc, mnc, longitude, latitude, azimuth, frequency, ssbFrequency, cellCoverType }] }`
- 模糊匹配 4 字段：小区名(Sector.name)、基站ID(Site.site_id)、网元ID(Site.managed_element_id)、站点名(Site.name)；大小写不敏感、子串匹配、top-20、按相关度排序。
- 作用域 = 唯一 full_params 工作簿。
- `rowKey` = 库内主键（site.id + sector.id），由搜索返回，用户修改 siteId/cellId 后仍能精确定位记录。

### 4.2 批量更新/删除 `POST /api/v1/data/cell-entry/bulk-update`

- 请求：
  ```json
  {
    "updates": [{ "rowKey": "...", "networkType": "LTE", "fields": { "siteId": "...", "cellId": "...", ... } }],
    "deletes": [{ "rowKey": "...", "networkType": "LTE" }]
  }
  ```
- 响应：`{ success, results: [{ rowKey, type: 'update'|'delete', success, message }], updated: N, deleted: M }`
- 部分成功语义：校验失败的行不落库、成功行落库，逐行 message 说明原因。

## 5. 数据流与读写算法

### 5.1 读（搜索）

服务端 `CellSearchIndex` 惰性构建：
- 首次搜索时从 SQLite 一次性读出 full_params 工作簿的 Site+Sector 连接结果，构建内存索引（字段归一化小写）；
- 构建后缓存；任何写入（新站录入/查询更新）后失效重建；
- 单次搜索 O(匹配)，数千行构建 < 50ms；
- 前端只发 query 字符串，搜索算法权威在服务端。

### 5.2 写（bulk-update）

与 `batch_add_cells_to_full_params` 同款高性能模式：

1. 定位唯一 full_params 工作簿；
2. 预加载库内全部 (siteId, cellId, networkType) 供冲突/重复检查（区分同/跨制式）；
3. 逐行校验：
   - 字段级：经纬度范围（lon ±180 / lat ±90）、方向角 0-360 整数、MNC 2 位、必填非空、频点格式（LTE frequency / NR ssbFrequency 数字）；
   - 标识冲突：修改后 (siteId, cellId) 被其他行占用 → 冲突（同制式"已重复"、跨制式"已被 X 制式占用"）；
   - 主键修改（siteId/cellId 变化）：无冲突时原地改键——新 siteId 已存在则改绑 Sector 到该 Site，否则更新 Site 记录本身；有冲突则拒绝该行；
4. **SQLite 单事务 + Excel 单次 load/save**；先提交 DB，Excel 失败则回滚 DB（保持双写一致性）；
5. 更新行复用 `_apply_row_update` 的列映射逻辑，删除行定位数据行后删除；
6. **删除语义**：删除 Sector 行；若该 Site 下再无其他 Sector 则级联删除 Site 行；
7. 失效搜索索引，返回逐行结果。

## 6. 错误处理与边界情况

- 校验失败的行不落库、成功行落库（部分成功 + 行级 message），失败行保留用户已编辑内容；
- 全量工参缺失 → 提示「请先上传全量工参」并禁用模块（与现有行为一致）；
- 写入期间前端锁定操作（同 `hasSyncingItems` 模式）；SQLite 单事务保证原子性；
- 检测到多个 full_params → 日志告警供排查（异常态）。

## 7. 测试策略

### 后端（pytest，`backend/tests/`）

- 搜索：4 种词（小区名/网元ID/基站ID/站点名）各自模糊命中；大小写不敏感；去重；站点级选中带出全部扇区；
- bulk-update：正常更新落库 + Excel 同步；主键冲突拒绝；跨制式占用拒绝；经纬度/方向角/MNC 超范围拒绝；删除后 Site 级联删除（最后扇区）；部分成功语义；事务一致性（Excel 写入失败时 DB 回滚）；搜索索引失效重建。

### 前端（vitest，`frontend/src/renderer/`）

- 搜索框防抖与下拉交互；确认弹窗 diff 汇总；删除标记切换。

## 8. 涉及文件（预估）

| 层 | 文件 | 变更 |
|----|------|------|
| 后端 API | `backend/app/api/v1/endpoints/data.py` | 新增 search / bulk-update 端点 |
| 后端服务 | `backend/app/services/data_service.py` | 新增 `search_cells`、`bulk_update_cells`、`CellSearchIndex` |
| 后端模型 | `backend/app/models/schemas.py` | 新增请求/响应 schema |
| 共享类型 | `shared/types.ts` | 新增搜索/批量更新相关类型 |
| 前端 API | `frontend/src/renderer/services/api.ts` | 新增 search / bulkUpdateCells 调用 |
| 前端页面 | `frontend/src/renderer/pages/DataPage.tsx` | 新增查询/更新面板、Tab 切换、确认弹窗；抽取共用表格子组件 |
| 前端翻译 | `frontend/src/renderer/locales/zh.json` / `en.json` | 新增翻译键 |
| 测试 | `backend/tests/test_data_service.py`、前端对应测试 | 新增用例 |

## 9. 后续步骤

- 调用 writing-plans 生成分阶段实现计划；
- 实现完成后按既有流程测试、提交。
