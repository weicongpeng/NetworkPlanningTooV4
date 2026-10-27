# 地图工具标签显示与可视区域刷新修复实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复地图工具 4 个标签/可视区域问题：①勾选图层复选框立即显示标签；②图层文件标签全量显示（+字段回退）；③图层文件标签 Canvas 化解决拖拽/缩放卡顿；④地理化数据拖拽实时刷新可视区域。

**Architecture:** 复用已有 `GeoDataCanvasLabelLayer`（单 Canvas + 网格防重叠 + 视口裁剪 + rAF + move 自刷新）作为公共标签层，将 `MapInfoLayer` 的 DOM 逐要素标签（上限 1000/5000、缩放全量重建）改为 Canvas 渲染。修复 `GeoDataLayer.addTo` 不重建标签层、OnlineMap 可见性不协调标签状态的断点；移除冗余的 OnlineMap L5416 点文件 DOM 标签路径。为 `GeoDataLayer` 增加 `move` 事件 + 节流视口裁剪重建实现拖拽实时刷新。

**Tech Stack:** React 18 + Leaflet + TypeScript（前端仅，后端零改动）。无前端测试框架，验证用 `tsc --noEmit` / `eslint` / `vite build` + 手动场景。

**设计文档:** `docs/plans/2026-08-12-map-label-display-fix-design.md`

---

## 阶段0：建立基线（先确认前端可编译可 lint）

**Files:**
- 无改动，仅验证环境

**Step 1: 确认前端基线通过**

Run: `cd frontend && npx tsc --noEmit 2>&1 | tail -20`
Expected: 仅有预先存在的错误（若有，记录数量基线，本次改动不得新增）。可对照 `git stash` 前后对比，或仅记录当前错误数。

**Step 2: 确认 lint 基线**

Run: `cd frontend && npm run lint 2>&1 | tail -20`
Expected: 无新增错误（记录基线）。

**Step 3: 记录基线**

若基线有失败，先记录，不要在本计划改动前混入环境问题。

---

## Task 1: 图层文件标签 Canvas 化 —— 引入公共标签层并重写核心方法（问题2、3主体）

**Files:**
- Modify: `frontend/src/renderer/components/Map/MapInfoLayer.tsx`
  - 类字段区（`:112-114` 附近）：新增 `canvasLabelLayer` 字段，删除 `labelMarkers`
  - 文件顶部：新增 `GeoDataCanvasLabelLayer` / `CanvasLabelData` 导入
  - `_createLabels`（`:745-847`）：重写为 Canvas 收集
  - `_removeLabels`（`:894-906`）：重写为移除 Canvas 层
  - `addTo`（`:265-290`）、`remove`（`:306-324`）、`setLabelVisibility`（`:690-704`）、`setLabelConfig`（`:710-721`）、`updateZoom`（`:726-735`）：适配
- Inspect（参考实现，不修改）: `frontend/src/renderer/components/Map/GeoDataCanvasLabelLayer.tsx`（`setLabels` `:156`、`updateConfig` `:448`、`onRemove` `:135`）

**Step 1: 新增字段与导入**

在 `MapInfoLayer.tsx` 顶部加导入：

```ts
import { GeoDataCanvasLabelLayer, CanvasLabelData } from './GeoDataCanvasLabelLayer'
```

类字段区（`:112-114`）替换：

```ts
// 标签相关属性
private labelsEnabled: boolean = false
private canvasLabelLayer: GeoDataCanvasLabelLayer | null = null  // Canvas 标签层（替代 DOM marker）
private labelConfig: {
  content: string
  color: string
  fontSize: number
}
```

删除 `private labelMarkers: Map<string, L.Marker> = new Map()`。

**Step 2: 重写 `_createLabels(map)`（移除 MAX_LABELS 上限与优先级裁剪）**

将 `:745-847` 整段替换为：

```ts
private _createLabels(map: L.Map): void {
  if (!this.geoJSONLayer) return

  // 移除旧标签
  this._removeLabels()

  // 收集全部要素标签（无数量上限，Canvas 层负责防重叠与视口裁剪）
  const labelItems: CanvasLabelData[] = []
  let index = 0

  this.geoJSONLayer.eachLayer((layer: any) => {
    try {
      const feature = layer.feature
      const properties = feature?.properties || {}
      let latLng: L.LatLng | null = null

      // 获取标签显示位置
      if (layer instanceof L.CircleMarker) {
        latLng = layer.getLatLng()
      } else if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
        latLng = layer.getBounds().getCenter()
      } else if (layer instanceof L.Polygon) {
        latLng = layer.getBounds().getCenter()
      }
      if (!latLng) return

      // 获取标签内容（含字段回退，见 Task 3）
      const labelContent = this._getLabelContent(properties)
      if (!labelContent) return

      labelItems.push({ index: index++, position: latLng, content: labelContent })
    } catch (err) {
      // 静默忽略单个要素的错误
    }
  })

  // 创建/复用 Canvas 标签层
  if (!this.canvasLabelLayer) {
    this.canvasLabelLayer = new GeoDataCanvasLabelLayer({
      fontSize: this.labelConfig.fontSize,
      fontColor: this.labelConfig.color
    })
  } else {
    this.canvasLabelLayer.updateConfig({
      fontSize: this.labelConfig.fontSize,
      fontColor: this.labelConfig.color
    })
  }

  this.canvasLabelLayer.setLabels(labelItems)
  if (!map.hasLayer(this.canvasLabelLayer)) {
    this.canvasLabelLayer.addTo(map)
  }
  console.log(`[MapInfoLayer] ✅ 已创建 ${labelItems.length} 个 Canvas 标签`)
}
```

> 同时删除不再使用的 `_calculateLabelPriority`（`:853-889`），若 grep 确认无其他调用点。

**Step 3: 重写 `_removeLabels()`**

将 `:894-906` 替换为：

```ts
private _removeLabels(): void {
  if (this.canvasLabelLayer) {
    const map = this.canvasLabelLayer._map || this.currentMap
    if (map && map.hasLayer(this.canvasLabelLayer)) {
      map.removeLayer(this.canvasLabelLayer)
    }
    this.canvasLabelLayer = null
  }
}
```

> `GeoDataCanvasLabelLayer.onRemove` 会自动 off move/resize/viewreset 监听并移除 canvas DOM，无需手动清理。

**Step 4: 适配 `addTo`/`remove`/`setLabelVisibility`/`setLabelConfig`/`updateZoom`**

- `addTo`（`:280-283`）无需改动（`labelsEnabled` 时已调 `_createLabels`）。
- `remove`（`:306-324`）无需改动（已调 `_removeLabels`）。
- `setLabelVisibility`（`:690-704`）无需改动逻辑，`_createLabels`/`_removeLabels` 已被重写；但移除 `labelMarkers` 相关残留。
- `setLabelConfig`（`:710-721`）：`_createLabels` 已处理 updateConfig，保持原逻辑即可（`this._removeLabels(); this._createLabels(this.currentMap)` 会在新实现下重建 Canvas 标签）。
- `updateZoom`（`:726-735`）：保持 `Math.abs(oldZoom - zoom) >= 1` 条件；Canvas 重建开销低，行为不变。

**Step 5: 编译验证**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -i "MapInfoLayer" | head -20`
Expected: 无 MapInfoLayer 相关新增错误（若有，修复：注意 `_map` 是 Leaflet 内部字段，若 TS 报私有属性访问错误，改用 `this.currentMap` 传递）。

**Step 6: Commit**

```bash
git add frontend/src/renderer/components/Map/MapInfoLayer.tsx
git commit -m "feat: MapInfoLayer 标签改为 Canvas 渲染（移除数量上限与 DOM 全量重建）"
```

---

## Task 2: `_getLabelContent` 加字段回退（问题2补充）

**Files:**
- Modify: `frontend/src/renderer/components/Map/MapInfoLayer.tsx:944-948`（`_getLabelContent` 尾部）

**Step 1: 替换"只返回配置字段"逻辑为字段回退**

将 `:943-948` 的注释与 `return ''` 替换为：

```ts
// 2. 字段回退：配置字段（含映射）均缺失时，回退到第一个可用的字符串属性，
// 避免 MIF/MAP 图层字段名不匹配（如 OBJECTID/NAME_1/LABEL）导致大量标签不显示
const SKIP_FIELDS = new Set(['id', 'type', 'geometry', 'path', 'color', 'style', 'longitude', 'latitude', 'azimuth', 'beamwidth', 'properties'])
for (const [key, value] of Object.entries(properties)) {
  if (SKIP_FIELDS.has(key)) continue
  if (typeof value !== 'string') continue
  const v = value.trim()
  if (!v) continue
  return v
}

return ''
```

**Step 2: 验证（静态检查 + 逻辑复查）**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -i "MapInfoLayer" | head`
Expected: 无新增错误。

**Step 3: 手动验证（可放在 Task 7 统一做，此处至少确认编译通过）**

预期：一个属性里只有 `OBJECTID=123`（字符串）的图层要素，标签显示 "123"。

**Step 4: Commit**

```bash
git add frontend/src/renderer/components/Map/MapInfoLayer.tsx
git commit -m "feat: 图层文件标签字段回退（配置字段缺失时用首个字符串属性）"
```

---

## Task 3: GeoDataLayer addTo 重建标签层（问题1-地理化数据）

**Files:**
- Modify: `frontend/src/renderer/components/Map/GeoDataLayer.tsx`
  - `addTo`（`:202-296`）：几何渲染完成后补标签重建
  - Inspect 参考：`setLabelVisibility`（`:856-896`）、`_createLabels`（`:943-1007`）、`remove`（`:641-692` 清空 canvasLabelLayer）

**Step 1: 在 `addTo` 末尾（几何渲染完成后）补标签重建**

找到 `addTo(map)` 内几何渲染逻辑结束的位置（`:284` 附近调用 `_renderChunked()` 之后），追加：

```ts
// 🔧 修复：remove() 清空了 canvasLabelLayer，重新勾选图层时需重建标签层
// （labelsEnabled 持久，但 Canvas 标签层被销毁，addTo 不再重建导致标签不恢复）
if (this.labelsEnabled && !this.canvasLabelLayer && this.visible) {
  this._createLabels(targetMap)
}
```

> 注意 `addTo` 内部的实际 map 变量名（targetMap 或 map），以当前实现为准；`_createLabels(map)` 自身会创建并 addTo Canvas 标签层。

**Step 2: 编译验证**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -i "GeoDataLayer" | head`
Expected: 无新增错误。

**Step 3: Commit**

```bash
git add frontend/src/renderer/components/Map/GeoDataLayer.tsx
git commit -m "fix: GeoDataLayer addTo 重建 Canvas 标签层（取消勾选再勾选后标签恢复）"
```

---

## Task 4: OnlineMap 可见性↔标签状态协调 + 移除冗余 DOM 标签路径（问题1补充）

**Files:**
- Modify: `frontend/src/renderer/components/Map/OnlineMap.tsx`
  - 图层可见性 useEffect（`:5147-5261`）：图层变为可见时同步标签状态
  - 点文件标签 DOM marker useEffect（`:5416-5506`）：核对并移除冗余路径
  - 清理：`pointFileLabelMarkersRef` 相关残留

**Step 1: 可见性 useEffect 中补标签同步**

在 `:5165-5222` 的可见性处理循环内，GeoDataLayer 分支（`:5181-5190` `geoLayer.setVisible(...)` 后）与 MapInfoLayer 分支（`:5200-5208` `addTo(...)` 后）分别补：

```ts
// GeoDataLayer 分支 setVisible(true) 后：
if (layerFile.visible && pointFileLabelVisibility[layerFile.id]) {
  geoLayer.setLabelVisibility(true)  // 幂等；addTo 未重建标签时兜底恢复
}

// MapInfoLayer 分支 addTo 后：
if (layerFile.visible && pointFileLabelVisibility[layerFile.id]) {
  layerRef.mapInfoLayer.setLabelVisibility(true)  // 幂等，保证勾选即显示
}
```

> 依赖数组 `[layerFiles, pointFiles, loadMapInfoLayers, reconcileLayerZOrder]` 增加 `pointFileLabelVisibility`（避免闭包读到旧值）。

**Step 2: 核对并移除 L5416 冗余 DOM 点文件标签路径**

先确认（只读检查）：`:5416-5506` 的 useEffect 为所有 `pointFileLabelVisibility[fileId]===true` 且配置了 `labelConfig.content` 的文件创建 `L.divIcon` DOM marker，遍历 `pointFileDataRef`（含 Excel 点文件与 MapInfo 文件）。

- **Excel 点文件** 标签已由 GeoDataLayer Canvas 标签层渲染（`setLabelVisibility` → `_createLabels`）。
- **MapInfo 文件** 标签已由 Task 1 的 MapInfoLayer Canvas 标签层渲染。

因此 L5416 DOM 路径与 Canvas 标签层**功能完全重复**，且存在"图层隐藏时标签仍残留"（`:5498` 直接 `marker.addTo(map)` 不看图层可见性）与双重渲染问题。移除该 useEffect 及其引用的 `pointFileLabelMarkersRef` 字段与清理逻辑。

**Step 3: 编译验证**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -i "OnlineMap" | head`
Expected: 无新增错误（注意 `pointFileLabelMarkersRef` 若在其他处使用需一并清理）。

**Step 4: 手动验证（关键）**

打开地图工具，确认：①Excel 点文件开标签 → 标签显示（Canvas，非 DOM 重复）；②勾选/取消勾选图层 → 标签随图层显隐且立即恢复；③图层文件开标签 → 标签显示且无重复。

**Step 5: Commit**

```bash
git add frontend/src/renderer/components/Map/OnlineMap.tsx
git commit -m "fix: 勾选图层立即显示标签 + 移除冗余 DOM 点文件标签路径（统一 Canvas 渲染）"
```

---

## Task 5: GeoDataLayer 拖拽实时刷新可视区域（问题4）

**Files:**
- Modify: `frontend/src/renderer/components/Map/GeoDataLayer.tsx`
  - `addTo`（`:202-222` 事件注册区）：注册 `map.on('move', ...)`
  - `remove`（`:641-654` 事件注销区）：对称注销
  - 新增 `_handleMove()` 节流方法 + 相关字段
  - `onMapMove`（`:823-851`）：修复 zoomChanged 跳过几何重渲染分支

**Step 1: 注册/注销 move 事件**

在 `addTo` 的事件注册区（`:212-222`，`map.on('zoom', ...)` 附近）追加：

```ts
if (!this._onMoveBound) {
  this._onMoveBound = () => this._handleMove()
}
targetMap.on('move', this._onMoveBound)
```

在 `remove` 的事件注销区（`:644-654`）追加：

```ts
if (this._onMoveBound) {
  targetMap.off('move', this._onMoveBound)
  this._onMoveBound = null
}
```

**Step 2: 新增节流的 `_handleMove()`**

在 `_handleZoom`（`:750-763`）附近新增：

```ts
/**
 * 拖拽（纯平移）时按固定间隔节流刷新视口裁剪
 *
 * 🔧 修复：原实现只在 moveend 才刷新，拖拽过程中移入视口的要素不出现。
 * 这里在 move 事件上做固定间隔节流（throttle），拖拽过程中每 150ms 重建一次
 * 视口裁剪，保证"拖拽实时刷新可视区域"；缩放动画期间的 move 由 _handleZoom 处理。
 */
private _onMoveBound: (() => void) | null = null
private _lastMoveRenderTime: number = 0

private _handleMove(): void {
  if (!this.map || !this.visible) return

  // 固定间隔节流：避免每次 move 都全量重建（move 高频触发）
  const now = performance.now()
  if (now - this._lastMoveRenderTime < 150) return
  this._lastMoveRenderTime = now

  // 缩放动画也触发 move，几何已由 _handleZoom 实时处理，这里跳过
  if (this.map.getZoom() !== this.currentZoom) return

  // 视口裁剪重建：移入视口的要素实时出现
  this._reRenderGeometries()
}
```

> 若实现中发现 `_reRenderGeometries` 重建开销大导致拖拽掉帧，可将间隔调至 200ms 或复用现有 `_geometryRenderTimer` 定时器模式，以实际手感为准（目标：与缩放刷新一致流畅）。

**Step 3: 修复 `onMapMove` 的 zoomChanged 跳过分支**

`onMapMove`（`:823-851`）当前在 `zoomChanged===true` 时跳过几何重渲染。因 `_handleMove` 已覆盖纯平移的实时刷新，`onMapMove` 保留为 moveend 的兜底；将 `:838-850` 调整为确保 moveend 时几何始终按需重渲染：

```ts
// 纯平移时直接重新渲染几何图形（视口裁剪需要更新）
// 说明：move 已由 _handleMove 节流刷新；此处为 moveend 兜底，
// 不再因 zoomChanged 跳过 —— zoom 场景由 _handleZoomEnd 全量重渲染，重复执行无害（幂等）
if (this._geometryRenderTimer) {
  clearTimeout(this._geometryRenderTimer)
}
this._geometryRenderTimer = window.setTimeout(() => {
  this._reRenderGeometries()
  this._geometryRenderTimer = null
}, 150) as unknown as number
```

（即删去 `if (!zoomChanged) { ... }` 外层判断，使 moveend 时几何始终刷新。）

**Step 4: 编译验证**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -i "GeoDataLayer" | head`
Expected: 无新增错误。

**Step 5: Commit**

```bash
git add frontend/src/renderer/components/Map/GeoDataLayer.tsx
git commit -m "feat: GeoDataLayer 拖拽时按节流实时刷新可视区域（move 监听 + 视口裁剪）"
```

---

## Task 6: 综合验证与回归（所有问题）

**Files:**
- 无改动；验证全部 4 个问题 + 回归

**Step 1: 静态检查全绿**

Run: `cd frontend && npx tsc --noEmit 2>&1 | tail -5`
Run: `cd frontend && npm run lint 2>&1 | tail -10`
Run: `cd frontend && npm run build:vite 2>&1 | tail -10`
Expected: 无新增错误；build 成功。

**Step 2: 手动验证 4 场景**（启动 `npm run dev:web`，浏览器验证）

1. **问题1**：控制面板"图层文件"与"地理化数据"下，标签开关打开 → 勾选图层复选框 → 标签立即显示；取消勾选 → 重新勾选 → 标签立即恢复（无需再点开关）。
2. **问题2**：图层文件标签全量显示（大图层 >1000 要素也能看到大部分标签）；低缩放级别下相邻标签不重叠；配置字段缺失的要素通过字段回退显示。
3. **问题3**：图层文件标签打开后，地图拖拽、缩放流畅度与地理化数据标签打开时相当（无明显卡顿）。
4. **问题4**：地理化数据拖拽地图时，移入可视区域的要素实时出现（不必等拖拽结束或缩放）。

**Step 3: 回归**

- 扇区标签（LTE/NR）开关行为不变。
- Excel 点文件标签正常显示（Canvas，无 DOM 重复）。
- 图层颜色设置、z-order（图层文件在最上、地理化数据其次）不变。
- 框选/测量/搜索定位标记不受影响。

**Step 4: 更新设计文档验证清单**

将 `docs/plans/2026-08-12-map-label-display-fix-design.md` 第 4 节勾选项按实际结果标注 ✅/⏳。

**Step 5: Commit**

```bash
git add docs/plans/2026-08-12-map-label-display-fix-design.md
git commit -m "docs: 图层标签显示修复验证结果"
```

---

## 风险与实施注意事项

- **`_map` 内部字段**: `GeoDataCanvasLabelLayer._map` 是 Leaflet 内部字段，Task 1 Step 3 若 TS 报错改用 `this.currentMap` 传递。
- **L5416 移除**: Task 4 Step 2 移除前务必手动确认 Canvas 标签层已完整覆盖两类文件的标签渲染；若发现某文件类型（如 sector 多边形 Excel）不走 GeoDataLayer 标签，需保留对应兜底。
- **move 节流间隔**: Task 5 的 150ms 为起点，以实际拖拽手感为准（对比缩放流畅度）。
- **重复标签**: 若 Task 4 后仍见重复标签，检查是否存在其他 DOM 标签创建点（grep `divIcon` / `point-file-label`）。
- 本次改动仅前端；后端零改动，无需 pytest。
