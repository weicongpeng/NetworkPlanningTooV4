# 新站录入任意列粘贴 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 新站录入支持从任意列开始粘贴：光标落在哪个字段的单元格，剪贴板第 1 列就填到该字段，后续列顺延，逐列校验过滤。

**Architecture:** 每个 `<input>` 加 `data-field` 属性标识字段；`handlePaste` 通过 `document.activeElement.closest('input')?.dataset.field` 定位光标所在字段列，按 `FIELD_ORDER` 表建立"剪贴板列 → 目标字段"的映射，逐列按字段 kind 校验填充（不符跳过保留原值）。行锚点（`data-row-id`）逻辑不变。

**Tech Stack:** React 18 + TypeScript。

---

## Task 1: 新增 `FIELD_ORDER` 常量 + 输入框加 `data-field`

**Files:**
- Modify: `frontend/src/renderer/pages/DataPage.tsx`
  - `:1501`（`handlePaste` 之前新增 `FIELD_ORDER` 常量）
  - `:1862-1911`（各 input/select 加 `data-field`）

**Step 1: 新增 `FIELD_ORDER` 常量**（在 `handlePaste` 定义 `:1503` 之前插入）

```typescript
  // 列字段顺序表（与表头一致），标注每列粘贴过滤类型
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

**Step 2: 各 input/select 加 `data-field`**——精确改动：

1. `:1862` 网元ID：
   `<input className={curInputCls} type="text" inputMode="numeric" value={row.managedElementId} onChange={...} disabled={...} placeholder="" />`
   → 在 `className={curInputCls}` 后加 `data-field="managedElementId"`

2. `:1865` 基站ID：加 `data-field="siteId"`

3. `:1868` 小区ID：加 `data-field="cellId"`

4. `:1871` 小区名称：加 `data-field="cellName"`

5. `:1874` MCC：加 `data-field="mcc"`

6. `:1877` MNC input：加 `data-field="mnc"`

7. `:1891` 经度：加 `data-field="longitude"`

8. `:1894` 纬度：加 `data-field="latitude"`

9. `:1897` 方向角：加 `data-field="azimuth"`

10. `:1901` LTE 频点：加 `data-field="frequency"`

11. `:1903` NR SSB频点：加 `data-field="ssbFrequency"`

12. `:1907` 覆盖类型 select：加 `data-field="cellCoverType"`

**Step 3: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep "DataPage.tsx"`
Expected: 仅基线 4 处已知错误（397/477/478/581 行），无新增。

**Step 4: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/pages/DataPage.tsx
git commit -m "feat: 新增列字段顺序表并为输入框标注字段"
```

---

## Task 2: 重写 `handlePaste` 支持任意列开始 + 逐列校验

**Files:**
- Modify: `frontend/src/renderer/pages/DataPage.tsx:1502-1547`（`handlePaste` 整体替换）

**Step 1: Replace `handlePaste`**——用下面实现整体替换 `:1502-1547`（当前函数）：

```typescript
  // 多行多列粘贴：从光标所在字段列开始，按剪贴板内容顺序逐列填充（逐列校验过滤，不符保留原值）
  const handlePaste = (e: React.ClipboardEvent) => {
    if (!hasFullParams || isAddingCell || importing) return
    const text = e.clipboardData.getData('text/plain')
    if (!text.includes('\t') && !text.includes('\n')) return // 单格粘贴交给浏览器默认
    e.preventDefault()

    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== '')
    if (lines.length === 0) return

    // 行锚点：只接管聚焦在表格行内的粘贴
    const activeTr = (document.activeElement as HTMLElement | null)?.closest?.('tr') as HTMLTableRowElement | null
    const anchorId = activeTr?.dataset?.rowId
    if (!anchorId) return // 聚焦不在表格行内,不接管粘贴
    const idx = rows[activeTab].findIndex(r => r.id === anchorId)
    const anchor = idx >= 0 ? idx : 0

    // 列锚点：光标所在输入框的字段列 → 剪贴板第 1 列
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
  }
```

**Step 2: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep "DataPage.tsx"`
Expected: 仅基线 4 处已知错误（397/477/478/581 行），无新增。

**Step 3: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/pages/DataPage.tsx
git commit -m "feat: 新站录入支持任意列开始粘贴，逐列校验过滤"
```

---

## Task 3: 最终验证

**Step 1: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: 259（与基线一致），DataPage.tsx 仅 4 处既有错误（397/477/478/581）

**Step 2: 手工验证清单**（前端启动后 `npm run dev:web`）

1. 光标放"小区名称"列单元格,粘贴 `小区A\t460\t11` → 小区名称=小区A, MCC=460, MNC=11
2. 光标放"小区ID"列,粘贴含字母的值(如 `12A`)→ 该列保留原值(过滤),下一列正常
3. 光标放"覆盖类型"列,粘贴 `1`/`4` → 正确;粘贴 `2` → 保留原值
4. 光标放"方向角"列,粘贴 `90\t114.5` → 方向角=90,经度=114.5(跨列顺延)
5. 光标放"经度"列,粘贴超过表末列的行 → 超出列丢弃
6. 光标放"网元ID"列(第 0 列)粘贴 → 行为与旧版一致(从第 0 列开始)
7. 单格粘贴(无 tab/换行)→ 交浏览器默认,不接管

**Step 3: 确认无回归**——`handlePaste` 之前的 `data-row-id` 行锚点、`isAddingCell`/`importing` 守卫均保留
