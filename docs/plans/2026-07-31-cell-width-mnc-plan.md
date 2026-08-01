# 新站录入列宽调整与 MNC 下拉 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 调整新站录入表格默认列宽（小区名称 2.5 倍、缩小的列 75%）、支持每列拖拽调宽并持久化、MNC 改为 select 下拉（11/01/00）。

**Architecture:** 列宽存 `Record<string, number>` 状态（localStorage 初始化/持久化），表头 `<th>` 用 `style={{ width }}` 控制列宽，每个可调列右侧加拖拽手柄（mousedown/mousemove/mouseup + window 事件）。MNC 从 `input + datalist` 改为 `<select>` 固定三选项。同步调整 `inputCls`/`inputClsExp` 的 `min-w` 让窄列生效。

**Tech Stack:** React 18 + TypeScript + Tailwind CSS。

---

## Task 1: 列宽状态 + 默认宽度表 + min-w 调整

**Files:**
- Modify: `frontend/src/renderer/pages/DataPage.tsx`
  - `:1397`（`importing` state 后新增常量与 `colWidths` 状态）
  - `:1761-1762`（`inputCls`/`inputClsExp` 的 min-w 调整）

**Step 1: 新增默认宽度常量 + `colWidths` 状态**（在 `importing` state `:1397` 之后插入）

```typescript
  // 列宽：默认宽度表（基准 70px）+ localStorage 持久化
  const DEFAULT_COL_WIDTHS: Record<string, number> = {
    managedElementId: 52, siteId: 52, cellId: 52, cellName: 175,
    mcc: 52, mnc: 52, longitude: 70, latitude: 70,
    azimuth: 52, frequency: 52, ssbFrequency: 52, cellCoverType: 70,
  }
  const COL_WIDTHS_KEY = 'npt_cell_entry_col_widths'
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem(COL_WIDTHS_KEY)
      return saved ? { ...DEFAULT_COL_WIDTHS, ...JSON.parse(saved) } : DEFAULT_COL_WIDTHS
    } catch { return DEFAULT_COL_WIDTHS }
  })
  const persistColWidths = (next: Record<string, number>) => {
    setColWidths(next)
    try { localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  }
```

**Step 2: 调整 `inputCls`/`inputClsExp` 的 min-w**（`:1761-1762`）

`min-w-[70px]` → `min-w-[40px]`（两种都改，展开模式 `min-w-[100px]` 也改）：

```typescript
  const inputCls = 'w-full min-w-[40px] px-1.5 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed'
  const inputClsExp = 'w-full min-w-[40px] px-2 py-1.5 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed'
```

> 理由：52px 的窄列会被原 `min-w-[70px]` 顶住，必须降到 40px 以下让窄列生效。

**Step 3: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep "DataPage.tsx"`
Expected: 仅基线 4 处已知错误（397/477/478/581 行），无新增。

**Step 4: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/pages/DataPage.tsx
git commit -m "feat: 新增列宽默认值与 localStorage 持久化"
```

---

## Task 2: 表头加 `style={{ width }}` + 拖拽手柄

**Files:**
- Modify: `frontend/src/renderer/pages/DataPage.tsx`
  - `:1838-1858`（表头 `<th>` 各列加 width style + 拖拽手柄）
  - `:1862`（`<tr>` 行 —— 需让 `th` 相对定位支持手柄）

**Step 1: 新增拖拽事件处理函数**（在 `handlePaste` 之后、`toggleRowSelection` 之前，约 `:1575` 附近）

```typescript
  // 列宽拖拽：记录起始位置与目标列，window 级 mousemove/mouseup 调整
  const startColResize = (e: React.MouseEvent, colKey: string) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = colWidths[colKey] ?? DEFAULT_COL_WIDTHS[colKey] ?? 70
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      const next = Math.max(40, startWidth + delta)
      setColWidths(prev => ({ ...prev, [colKey]: next }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // 结束时持久化（从最新 state 读）
      setColWidths(prev => {
        try { localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(prev)) } catch { /* ignore */ }
        return prev
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
```

> 注意：拖拽期间实时 `setColWidths`（视觉反馈），结束时持久化到 localStorage。

**Step 2: 表头 `<th>` 加 width style + 拖拽手柄**（`:1848-1858` 各列）

每个可调列 `<th>` 改为（以网元ID为例，其他列同理）：

```tsx
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 relative'} style={{ width: colWidths.managedElementId }}>
                {t('newCellEntry.fieldManagedElementId') || '网元ID'}
                <div
                  className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/60"
                  onMouseDown={e => startColResize(e, 'managedElementId')}
                />
              </th>
```

逐列对应（`field` key → 列）：
- 网元ID → `colWidths.managedElementId`，手柄 key `'managedElementId'`
- 基站ID → `colWidths.siteId`
- 小区ID → `colWidths.cellId`
- 小区名称 → `colWidths.cellName`
- MCC → `colWidths.mcc`
- MNC → `colWidths.mnc`
- 经度 → `colWidths.longitude`
- 纬度 → `colWidths.latitude`
- 方向角 → `colWidths.azimuth`
- 下行频点/SSB → `colWidths.frequency`（LTE）/`colWidths.ssbFrequency`（NR），手柄 key 用 `isLte ? 'frequency' : 'ssbFrequency'`
- 覆盖类型 → `colWidths.cellCoverType`

> 复选框列(`:1838`)和操作列(`:1847`)保持 `w-0` 不加手柄。

**Step 3: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep "DataPage.tsx"`
Expected: 仅基线 4 处已知错误，无新增。

**Step 4: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/pages/DataPage.tsx
git commit -m "feat: 新站录入表格列宽可拖拽调整"
```

---

## Task 3: MNC 改 select 下拉（11/01/00）

**Files:**
- Modify: `frontend/src/renderer/pages/DataPage.tsx`
  - `:1904-1916`（MNC input + datalist → select）

**Step 1: 替换 MNC 单元格**（`:1904-1916` 整体替换）

当前：
```tsx
                    <input
                      className={curInputCls}
                      data-field="mnc"
                      list="mnc-options"
                      value={row.mnc}
                      onChange={e => updateRow(row.id, 'mnc', filterDigits(e.target.value).slice(0, 2))}
                      disabled={!hasFullParams || isAddingCell}
                      placeholder="11"
                    />
                    <datalist id="mnc-options">
                      <option value="11" />
                      <option value="01" />
                    </datalist>
```

替换为：
```tsx
                    <select
                      className={curInputCls}
                      data-field="mnc"
                      value={row.mnc}
                      onChange={e => updateRow(row.id, 'mnc', e.target.value)}
                      disabled={!hasFullParams || isAddingCell}
                    >
                      <option value="11">11</option>
                      <option value="01">01</option>
                      <option value="00">00</option>
                    </select>
```

> 说明：`createEmptyRow` 的 `mnc: '11'` 默认值不变，select 三个值都满足 `isRowComplete` 校验（`row.mnc.trim().length === 2 && isInteger(row.mnc)`）。

**Step 2: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep "DataPage.tsx"`
Expected: 仅基线 4 处已知错误，无新增。

**Step 3: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/pages/DataPage.tsx
git commit -m "feat: MNC 改为下拉选项 11/01/00"
```

---

## Task 4: 最终验证

**Step 1: Type-check**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: 259（与基线一致），DataPage.tsx 仅 4 处既有错误（397/477/478/581）

**Step 2: 手工验证清单**（前端启动后 `npm run dev:web`）

1. 小区名称列明显更宽（~175px），网元ID/基站ID/小区ID/MCC/MNC/方向角/频点列更窄（~52px），经度/纬度/覆盖类型保持 70px
2. 鼠标悬停列间竖线变蓝，拖拽调整列宽实时生效
3. 刷新页面后列宽保持（localStorage 持久化）
4. 内联模式与展开模式都能拖拽
5. MNC 下拉显示 11/01/00 三个选项，选择后值正确
6. 现有粘贴/查重/导入功能无回归（列宽不影响逻辑）
