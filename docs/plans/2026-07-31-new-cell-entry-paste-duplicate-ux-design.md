# 新站录入功能调整设计（粘贴录入 / 制式分离查重 / 导入即时反馈）

日期：2026-07-31
状态：设计定稿

## 需求概述

1. **默认 3 行 + 多行多列粘贴**：新站录入面板每个制式页签默认显示 3 行；支持从 Excel/类似格式文本复制多行多列粘贴，行数不足时自动向下扩充。
2. **制式分离查重与跨制式提示**：录入面板按制式独立比对。LTE 面板录入的小区只与现有 LTE 工参比对；NR 面板只与现有 NR 工参比对。
   - 同制式重复 → 提示 `[面板制式]小区 XXX 已重复，信息已更新覆盖`
   - 跨制式重复（LTE 面板录入的 CGI 已在 NR 工参存在）→ 提示 `[面板制式]小区 XXX 已在[库中制式]工参中存在，请检查`，且**该行不导入**（已确认：跨制式跳过不导入）。
3. **一键导入即时反馈**：点击后按钮立即进入 spinner/"录入中..."状态（覆盖预查重阶段），消除"没反应"的体感。（已确认：保留预查重 + 即时反馈。）

## 现状与根因

- 录入面板每制式初始仅 1 行（`rows.LTE: [createEmptyRow()]`），无粘贴支持。
- **预查重实际失效**：`check-duplicates` 端点使用 `CellBatchCreateRequest` 校验，前端仅发送 `{siteId, cellId}`，必填字段缺失 → 422；`handleBatchImport` 中 `try/catch(_)` 静默吞掉，红框高亮从未生效，每次都直接 `batchAddCells`。
- 后端 `batch_add_cells_to_full_params` 按 `siteId_cellId` 不区分制式查重，统一返回 `小区 XXX 已存在，已在 Excel 中更新覆盖`，且重复行实际是**跳过**（未写入 Excel/SQLite），提示与行为不符。
- 一键导入：`isAddingCell` 仅在 `batchAddCells`（store 内）才置 true，预查重阶段无任何反馈 → 视觉迟钝。

## 设计

### 1. 默认 3 行 + 多行多列粘贴（需求 1）

**初始行数**：`LTE/NR` 各 `[createEmptyRow() x3]`。`resetAll`、导入成功后的清空，均回到 3 行（新增 `createEmptyRows(n)` 辅助函数）。

**粘贴**：在表格外层 `<div>` 上挂 `onPaste`。
- 解析 `e.clipboardData.getData('text/plain')`：按 `\r?\n` 分行，再按 `\t` 分列（Excel 复制标准格式）。
- **列顺序（与表头一致）**：网元ID、基站ID、小区ID、小区名称、MCC、MNC、经度、纬度、方向角、频点（LTE→frequency / NR→ssbFrequency）、覆盖类型。
- 粘贴锚点：取 `document.activeElement` 所在 `<tr>` 的行号；无聚焦输入时从第 0 行开始。
- 逐行填充到现有行；粘贴行数超过剩余行时自动追加新行。列缺失时保留目标行原有值；空值字段套默认（MCC=460、MNC=11、覆盖类型=1）。
- 数字字段沿用现有过滤：整数位 `filterDigits`，浮点 `filterNumeric`，覆盖类型 `parseInt` 兜底 1/4。
- 仅当剪贴板含 `\t` 或 `\n` 时 `preventDefault()` 接管；单格粘贴交还浏览器默认。

### 2. 制式分离查重 + 跨制式提示（需求 2）

**后端 `check_cell_duplicates` 重构**（顺带修复 422 隐患）：
- 新增轻量 schema `CellDupCheckRequest { cells: [{ siteId, cellId, networkType }] }`（替换误用 `CellBatchCreateRequest`）。
- 查询带出 `Site.network_type`，返回：
  ```json
  { "duplicates": [...], "exists": { "siteId_cellId": { "lte": bool, "nr": bool } } }
  ```

**前端预查重分析**（`handleBatchImport` 内）：
- 对每行按面板制式 `panelType` 分类：
  - `exists[key][panelType]` → 同制式重复：红框高亮（`duplicateMap[key]='same'`），批量导入时剔除。
  - `exists[key][otherType]` → 跨制式重复：橙框高亮（`duplicateMap[key]='cross'`），剔除，结果中提示"已在[其他制式]工参中存在,请检查"。
  - 均无 → 正常导入。

**后端 `batch_add_cells_to_full_params` 重复行消息**（结果逐行 `message`）：
- 查重时带出库中该 CGI 的 `network_type`。
- 输入制式 == 库中制式：`[{面板制式}]小区 {name} 已重复，信息已更新覆盖`
- 输入制式 ≠ 库中制式：`[{面板制式}]小区 {name} 已在[{库中制式}]工参中存在，请检查`（该行跳过，不写 Excel/SQLite）
- 批内后续行查重（`existing_cell_keys`）同步改为 `key → network_type` 的字典，保持一致。

**状态模型**：`duplicateCgiSet` 升级为 `duplicateMap: Record<string, 'same' | 'cross'>`，行背景色按类型区分（same→红，cross→橙/琥珀）。

### 3. 一键导入即时反馈（需求 3）

- 新增组件级 `const [importing, setImporting] = useState(false)`。
- `handleBatchImport`：入口 `setImporting(true)`，预查重 + 批量导入整体用 `try/finally` 包住，`finally { setImporting(false) }`。
- 按钮：`disabled={totalRows===0 || importing || !hasFullParams}`；图标/文案绑定 `importing`（spinner + "录入中..."）。
- `isAddingCell`（store）仍保留，但按钮反馈以 `importing` 为准，覆盖预查重阶段。

## 数据流

```
点击一键导入
  → setImporting(true)                     [立即反馈]
  → check-duplicates (带 networkType)      [修复 422 后生效]
      → exists {key: {lte, nr}} → 分类 same/cross → 红/橙高亮 + 剔除
  → batchAddCells(非重复行)
      → 后端逐行消息（同制式覆盖 / 跨制式请检查 / 新增成功）
  → 结果面板展示 + 清空为 3 行
  → finally setImporting(false)
```

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `frontend/src/renderer/pages/DataPage.tsx` | 默认 3 行、`onPaste` 粘贴、`importing` 状态、`duplicateMap` 分类高亮、按钮反馈、`createEmptyRows` |
| `frontend/src/renderer/services/api.ts` | `checkCellDuplicates` 请求带 `networkType`；响应 `exists` 类型改为 `Record<string, {lte,nr}>` |
| `backend/app/models/schemas.py` | 新增 `CellDupCheckRequest` / `CellDupCheckItem` |
| `backend/app/api/v1/endpoints/data.py` | `check-duplicates` 改用新 schema |
| `backend/app/services/data_service.py` | `check_cell_duplicates` 重构（带制式返回）；`batch_add_cells_to_full_params` 制式分离查重 + 新消息；单条 `add_cell_to_full_params` 消息对齐 |
| `frontend/src/renderer/locales/zh.json` | 新增粘贴提示、跨制式提示等 key |
| `frontend/src/renderer/locales/en.json` | 同步英文 key |

## 错误处理与边界

- 查重请求失败：沿用现有"查重失败不影响导入"，降级为直接 `batchAddCells`，由后端逐行结果兜底。
- 粘贴覆盖类型非法值：`parseInt` 后非 1/4 时保留默认 1。
- 粘贴空行/纯数字单格：交还浏览器默认，不接管。
- 批量导入后端异常：沿用现有 `catch` 输出 `批量新站录入失败` + error 日志，`finally` 保证 `importing` 复位。

## 测试要点

- 后端：`check_cell_duplicates` 返回 `{lte, nr}` 双键；`batch_add_cells_to_full_params` 同制式/跨制式消息断言；跨制式行不写入 Excel/SQLite。
- 前端：粘贴 3 行 11 列 → 网格正确填充且无多余追加；粘贴 5 行 → 自动扩到 5 行；点击导入按钮立即进入 spinner。
