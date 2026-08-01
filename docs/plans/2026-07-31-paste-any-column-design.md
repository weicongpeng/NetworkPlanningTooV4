# 新站录入任意列粘贴设计

日期：2026-07-31
状态：设计定稿

## 需求概述

调整后，新站录入的多行多列数据复制粘贴，改为可以在录入面板的**任意列开始**按剪贴板内容顺序粘贴：光标落在哪个字段的单元格，剪贴板第 1 列就填到该字段，后续列顺延；逐列检查是否符合该字段的过滤条件，符合才填充。

## 现状

当前 `handlePaste`（`frontend/src/renderer/pages/DataPage.tsx:1502-1547`）:
- 列锚点**固定从第 0 列**（网元ID）开始，`get(i)` 按绝对位置映射
- 过滤是**强清洗**：`filterDigits`/`filterNumeric` 不符也 strip 填入
- 输入框无列级属性，只能定位到行（`data-row-id`）

## 需求细节（已确认）

1. **列锚点**：光标所在单元格的字段列 = 剪贴板第 1 列目标
2. **越界**：剪贴板列数超出表末列（覆盖类型之后）时，超出部分丢弃
3. **过滤语义**：逐列独立判断，粘贴值与该字段规则不符时跳过该列（保留原值），不影响其他列/行

## 设计

### 1. 字段顺序表（共享常量）

在 `NewCellEntryCard` 内定义 `FIELD_ORDER`，与表头列序一致，标注每列过滤类型：

```typescript
const FIELD_ORDER: Array<{ key: keyof CellRow; kind: 'digits' | 'numeric' | 'text' | 'cover' }> = [
  { key: 'managedElementId', kind: 'digits' },
  { key: 'siteId', kind: 'digits' },
  { key: 'cellId', kind: 'digits' },
  { key: 'cellName', kind: 'text' },
  { key: 'mcc', kind: 'digits' },
  { key: 'mnc', kind: 'digits' },
  { key: 'longitude', kind: 'numeric' },
  { key: 'latitude', kind: 'numeric' },
  { key: 'azimuth', kind: 'digits' },
  { key: 'frequency', kind: 'numeric' },   // LTE 面板
  { key: 'ssbFrequency', kind: 'numeric' }, // NR 面板
  { key: 'cellCoverType', kind: 'cover' },
]
```

> 频率列：同一表格位置，但 LTE 面板用 `frequency`、NR 面板用 `ssbFrequency`。映射时按 `isLteTab` 二选一，跳过非当前制式的那列。

### 2. 输入框加 `data-field`

每个 `<input>` 加 `data-field={字段key}`（如 `data-field="managedElementId"`、`data-field="cellName"`），供粘贴时定位聚焦字段。

### 3. `handlePaste` 重写核心逻辑

```typescript
// 获取聚焦字段（光标所在列）
const activeInput = (document.activeElement as HTMLElement | null)?.closest?.('input') as HTMLInputElement | null
const focusField = activeInput?.dataset?.field as keyof CellRow | undefined
if (!focusField) return // 聚焦不在输入框内
const startCol = FIELD_ORDER.findIndex(f => f.key === focusField)
if (startCol < 0) return

const isLteTab = activeTab === 'LTE'
const nextRows = rows[activeTab].map(r => ({ ...r }))
let rowIdx = anchor
for (const line of lines) {
  const cols = line.split('\t')
  const base = nextRows[rowIdx] ?? createEmptyRow()
  const next: CellRow = { ...base }
  // 从 startCol 开始映射：剪贴板第 j 列 → 表列 startCol+j
  for (let j = 0; startCol + j < FIELD_ORDER.length; j++) {
    const field = FIELD_ORDER[startCol + j]
    if (field.key === 'frequency' && !isLteTab) continue
    if (field.key === 'ssbFrequency' && isLteTab) continue
    const raw = (cols[j] ?? '').trim()
    if (raw === '') continue // 空单元格不填充
    // 按 kind 校验过滤：不符则跳过该列（保留 base 原值）
    if (field.kind === 'digits' && /^\d+$/.test(raw)) {
      next[field.key] = field.key === 'mnc' ? raw.slice(0, 2) : raw
    } else if (field.kind === 'numeric' && /^-?\d+(\.\d+)?$/.test(raw)) {
      next[field.key] = raw
    } else if (field.kind === 'text') {
      next[field.key] = raw
    } else if (field.kind === 'cover' && (raw === '1' || raw === '4')) {
      next[field.key] = parseInt(raw, 10)
    }
  }
  if (rowIdx < nextRows.length) nextRows[rowIdx] = next
  else nextRows.push(next)
  rowIdx++
}
setRows(prev => ({ ...prev, [activeTab]: nextRows }))
```

### 4. 关键变化点

| 项目 | 当前 | 新行为 |
|------|------|--------|
| 列锚点 | 固定从第 0 列 | 光标所在单元格字段列 |
| 列映射 | 绝对位置 `get(0)`→网元ID | 相对位置 `startCol+j` |
| 过滤 | 强清洗（不符也 strip） | 逐列校验，不符跳过保留原值 |
| 频率列 | 按 isLte 分流 | 保持（映射时跳过非当前制式频率列） |

### 5. 边界与错误处理

- 聚焦不在输入框 → `closest('input')` 为 null 或 `data-field` 缺失 → return（不接管）
- 光标在表头/checkbox → 同上 return
- 剪贴板列数超出表末列 → 内层循环 `startCol + j < FIELD_ORDER.length` 截断
- 空单元格（剪贴板 tab 间的空值）→ `raw === ''` 跳过不填充
- 不符值 → 该列保留 base 原值，不影响其他列/行
- 行锚点逻辑（`data-row-id`）保持不变

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `frontend/src/renderer/pages/DataPage.tsx` | 新增 `FIELD_ORDER` 常量、输入框加 `data-field`、重写 `handlePaste` |

## 测试要点

- 前端无测试框架，靠 type-check + 手工验证
- 验证：光标放"小区名称"粘贴 3 列 → 小区名称/MCC/MNC 正确填充；粘贴字母到小区ID列 → 该列保留原值；粘贴超长行 → 超出列丢弃
