# 新站录入方向角超范围输入拦截设计

日期：2026-07-31
状态：设计定稿

## 需求概述

新站录入时，当"方向角"列输入超出范围（0-360）的值时点"一键导入"，会提示"没有待导入的数据，请至少填写一行的必填字段"，但超范围数值仍留在录入单元格。调整：输入超范围值时**直接提示且不让输入**（输入瞬间拦截），避免导入后报错。

## 现状与根因

- 方向角 input 的 `onChange` 是 `filterDigits(e.target.value)`（`DataPage.tsx:2028`），只过滤非数字，超范围值（如 365）被存入 state。
- `isRowComplete` 校验 `azi >= 0 && azi <= 360`（`DataPage.tsx:1451-1452`），超范围 → 行不完整。
- `collectValidRows` 跳过不完整行 → 全部超范围时 `validRows.length === 0` → `handleBatchImport` 提示"没有待导入的数据"（`DataPage.tsx:1705`）。
- 数值仍留在单元格，用户困惑。

## 设计

### 方案：输入瞬间拦截（已确认）

新增 `handleAzimuthChange`，在方向角 input 的 `onChange` 中调用：

```typescript
const handleAzimuthChange = (rowId: string, value: string) => {
  const cleaned = filterDigits(value)
  if (cleaned === '') { updateRow(rowId, 'azimuth', ''); return } // 允许清空
  const num = parseInt(cleaned, 10)
  if (!isNaN(num) && num > 360) {
    setBatchError(t('newCellEntry.azimuthRangeError') || '方向角必须在 0-360 之间')
    setTimeout(() => setBatchError(null), 3000)
    return // 拒绝输入，保留原值
  }
  updateRow(rowId, 'azimuth', cleaned)
}
```

方向角 input 的 `onChange` 改为：

```tsx
onChange={e => handleAzimuthChange(row.id, e.target.value)}
```

### 边界处理

- **清空允许**：`cleaned === ''` → 置空（用户可清空重输）
- **中间态合法**：`1`、`36`、`360` 都合法；`361`+ 拒绝
- **负数**：`filterDigits` 已剔除负号，无需担心
- **提示**：复用现有 `batchError` 显示条（`DataPage.tsx:1839-1845`）+ 3 秒自动消失

### 为什么复用 `batchError`

现有组件已有 `batchError` 条，复用最简，无需新增 UI。i18n key `azimuthRangeError`（"方向角必须在 0-360 之间"）已在 zh/en 存在，直接引用。

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `frontend/src/renderer/pages/DataPage.tsx` | 新增 `handleAzimuthChange`，方向角 input 的 `onChange` 改用它 |

## 测试要点

- type-check 无新增错误
- 手工：输 365 → 提示"方向角必须在 0-360 之间"且单元格回到原值；输 360 → 合法；清空 → 允许
