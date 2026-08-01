# 新站录入列宽调整与 MNC 下拉设计

日期：2026-07-31
状态：设计定稿

## 需求概述

1. **默认列宽调整**：小区名称列默认宽度加大到原来的 2.5 倍；网元ID、基站ID、小区ID、MCC、MNC、方向角、下行频点列默认宽度缩小 1/4（保留 75%）。
2. **列宽拖拽**：录入面板每列宽度可自由拖拽调整，内联/展开模式都支持，持久化到 localStorage。
3. **MNC 下拉**：MNC 列下拉目前只有 11（实际代码已有 01 但视觉不显示），需排查并最终包含 11、01、00。

## 现状

- 表头 `<th>` 无显式宽度，列宽靠 `inputCls` 的 `min-w-[70px]`（展开模式 `inputClsExp` 的 `min-w-[100px]`）和内容自适应。
- MNC 是 `input + datalist`（`DataPage.tsx:1904-1916`），datalist 有 `<option value="11">`、`<option value="01">`，但浏览器 datalist 对前导零值的渲染差异大，用户视觉上只看到 11。
- 列宽调整无任何机制。

## 需求细节（已确认）

1. **列宽基准**：按 70px 为基准（当前 inputCls 的 min-w）。
   - 小区名称：70 → **175px**（2.5 倍）
   - 网元ID/基站ID/小区ID/MCC/MNC/方向角/下行频点：70 → **52px**（75%）
   - 经度/纬度/覆盖类型：**保持 70px**（不变）
2. **拖拽持久化**：localStorage，LTE/NR 共用一套，刷新/重开保持。
3. **MNC 方案**：改成真正 `<select>` 下拉，选项 11/01/00 固定展示。
4. **拖拽模式**：内联和展开两种模式都支持。

## 设计

### 1. 列宽表（默认宽度）

| 列 | 默认宽度 | 依据 |
|------|---------|------|
| 复选框/操作 | `w-0` | 不变 |
| 网元ID | 52px | 70×0.75 |
| 基站ID | 52px | 70×0.75 |
| 小区ID | 52px | 70×0.75 |
| 小区名称 | 175px | 70×2.5 |
| MCC | 52px | 70×0.75 |
| MNC | 52px | 70×0.75 |
| 经度 | 70px | 不变 |
| 纬度 | 70px | 不变 |
| 方向角 | 52px | 70×0.75 |
| 下行频点/SSB | 52px | 70×0.75 |
| 覆盖类型 | 70px | 不变 |

实现：表头 `<th>` 加 `style={{ width }}`，列宽来自状态。**注意**：`inputCls` 的 `min-w-[70px]` 会顶住 52px 的列，需同步把 `min-w-[70px]` 降为 `min-w-[40px]`（展开模式 `min-w-[100px]` 降为 `min-w-[40px]`），让窄列生效。

### 2. 列宽状态 + 拖拽

**状态**：
```typescript
const DEFAULT_COL_WIDTHS: Record<string, number> = {
  managedElementId: 52, siteId: 52, cellId: 52, cellName: 175,
  mcc: 52, mnc: 52, longitude: 70, latitude: 70,
  azimuth: 52, frequency: 52, ssbFrequency: 52, cellCoverType: 70,
}
const STORAGE_KEY = 'npt_cell_entry_col_widths'
const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? { ...DEFAULT_COL_WIDTHS, ...JSON.parse(saved) } : DEFAULT_COL_WIDTHS
  } catch { return DEFAULT_COL_WIDTHS }
})
```

**拖拽**：每个可调 `<th>` 内右侧加手柄：
```tsx
<div
  className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/60"
  onMouseDown={e => startResize(e, 'cellName')}
/>
```
`startResize` 记录起始 x 和原宽度，`mousemove` 计算增量更新 `colWidths`，`mouseup` 结束并写 localStorage。最小宽度 40px。

**事件监听**：`mousemove`/`mouseup` 用 `window.addEventListener` 挂载/清理，避免拖出表格时丢失。

**持久化**：拖拽过程中实时更新 state（视觉反馈），`mouseup` 时写 localStorage。

### 3. MNC 改 select

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
移除外置 `<datalist id="mnc-options">`。`isRowComplete` 校验（`row.mnc.trim().length === 2 && isInteger(row.mnc)`）对 select 值仍成立。`createEmptyRow` 的 `mnc: '11'` 默认值不变。

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `frontend/src/renderer/pages/DataPage.tsx` | `DEFAULT_COL_WIDTHS`/`STORAGE_KEY`/`colWidths` 状态、拖拽手柄与事件、表头 `style={{ width }}`、`inputCls`/`inputClsExp` 的 `min-w` 调整、MNC 改 select |

## 测试要点

- 前端无测试框架，type-check + 手工验证
- 手工：小区名称列明显更宽、缩小的列更窄；拖拽手柄调整列宽后刷新页面宽度保持；MNC 下拉显示 11/01/00 三个选项；内联/展开模式拖拽都生效
