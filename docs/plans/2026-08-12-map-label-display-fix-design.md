# 地图工具标签显示与可视区域刷新修复设计

**日期**: 2026-08-12
**分支**: layer-tools
**范围**: 地图工具控制面板"图层文件"与"地理化数据"图层的标签显示状态一致、标签全量显示、拖拽/缩放流畅度、拖拽可视区域实时刷新，共 4 个问题修复（方案A）。

---

## 1. 问题与根因

### 1.1 问题1 — 勾选图层复选框不立即显示标签

**现象**: 控制面板中，标签开关已打开时勾选图层复选框，地图不立即显示该图层标签；再次点击"标签"开关按钮才显示。"图层文件"与"地理化数据"两类图层均存在。

**根因**（两条独立链路）:
1. **地理化数据（GeoDataLayer）**: `remove()` 销毁标签 canvas 层并将引用置空（`GeoDataLayer.tsx:678-681`），但 `addTo()`（`:202-296`）从不重建标签层——即使 `labelsEnabled` 仍为 true。因此"取消勾选→重新勾选"后几何恢复但标签缺失，必须再拨一次标签开关（`setLabelVisibility(true)` 才重建）。
2. **图层文件（MapInfoLayer）**: `addTo()` 在 `labelsEnabled` 时会重建标签（`MapInfoLayer.tsx:280-283`），但 `setLabelVisibility()` 在图层未挂载（`currentMap` 为空）时静默返回（`:694-697`），存在开关先于挂载的状态同步时序问题；且 OnlineMap 的图层可见性 useEffect 未在勾选变为可见时主动同步标签状态（`OnlineMap.tsx:5147-5261`）。另存在 `layerFileLabelVisibility`（MapPage 本地）与 `pointFileLabelVisibility`（OnlineMap 内部）双份状态，文件标签渲染实际只读后者，前者为孤儿状态。

### 1.2 问题2 — 图层文件标签只显示部分，大部分未显示

**现象**: "图层文件"标签开关打开后，地图只显示部分图层元素的标签。

**根因**（叠加因素，`MapInfoLayer.tsx`）:
1. **数量硬上限**（主因，`:752`）: `const MAX_LABELS = this.currentZoom > 12 ? 5000 : 1000`，zoom≤12 最多 1000 个标签。
2. **优先级裁剪**（`:807-812`）: 按 `_calculateLabelPriority` 排序后 `slice(0, MAX_LABELS)`。
3. **字段缺失跳过**（`:790`）: `_getLabelContent` 只返回配置字段（默认 `name` 及映射表 `:918-926`），图层要素字段名不匹配（如 MIF/MAP 常用 `OBJECTID`/`NAME_1`/`LABEL`）时返回空串，标签不显示。
4. 仅 CircleMarker/Polyline/Polygon 有位置（`:778-786`）。

### 1.3 问题3 — 图层文件标签拖拽/缩放卡顿，地理化数据流畅

**现象**: "图层文件"标签开关打开后地图拖拽、缩放非常卡顿；"地理化数据"标签打开后较流畅。

**根因**（`MapInfoLayer.tsx` 对比 `GeoDataLayer.tsx`）:

| 维度 | MapInfoLayer（图层文件） | GeoDataLayer（地理化数据） |
|---|---|---|
| 标签渲染 | **DOM** `L.divIcon` + `L.marker`（`:817-840`），≤5000 个 DOM 节点 | **单 Canvas** `GeoDataCanvasLabelLayer` |
| 缩放处理 | `updateZoom` 全量 `_removeLabels` + 重建 ≤5000 DOM（`:726-735`） | rAF 节流 + 增量更新 |
| 移动处理 | 标签 DOM 由 Leaflet 平移 | Canvas 层 `move` 自监听，只更新坐标/可见性（`GeoDataCanvasLabelLayer.tsx:116-118, 237-240`） |
| 视口裁剪 | 无（几何全量 addData，`:522-537`） | 有（`_filterVisible`/`_padBounds`，`:302-387`） |

**结论**: 几何均为 Canvas renderer，卡顿差异主因是标签渲染方案——DOM 逐要素 marker + 缩放全量重建 vs 单 Canvas + 增量更新。

### 1.4 问题4 — 地理化数据拖拽时不实时刷新可视区域

**现象**: "地理化数据"图层拖拽地图时，图层元素不实时刷新可视区域（移入视口的要素不出现），只有缩放地图时才刷新。

**根因**（`GeoDataLayer.tsx`）:
1. **零 move 监听**: `addTo` 只注册 `zoom`/`zoomend`（`:212-222`），无任何 `move`/`moveend` 监听。几何层平移刷新 100% 依赖 OnlineMap 的 `moveend` 转发（`OnlineMap.tsx:5123-5142` → `geoDataLayerManagerRef.current.onMapMove()`）。
2. **onMapMove 有条件+防抖**: 仅 moveend 触发，且 150ms 防抖（`GeoDataLayer.tsx:840-850`）；moveend 伴随缩放变化（`zoomChanged===true`）时**直接跳过几何重渲染**（`:829-831`，只依赖 zoomend 路径）。
3. 拖拽过程中（`move` 持续触发）几何层无任何监听，不做实时视口裁剪刷新——只有 Canvas 标签层内部监听了 `move`。

---

## 2. 修复方案（方案A，已确认）

### 2.1 统一 Canvas 标签层（解决问题2、3）

**决策: 图层文件标签从 DOM 改为复用 Canvas 标签层，移除数量上限，全量显示 + 网格防重叠。**

`GeoDataCanvasLabelLayer`（`GeoDataCanvasLabelLayer.tsx`）已具备全部所需能力：
- 全量标签接收 + 网格防重叠（`_deduplicateLabels` `:381-404`）
- 视口裁剪（`_isPointInViewport` `:419-431`）
- `requestAnimationFrame` 调度（`_scheduleRender` `:287-295`）
- `move`/`resize`/`viewreset` 自监听，拖拽时增量更新坐标与可见性（`:116-118, 198-224, 237-240`）

改造 `MapInfoLayer`:
1. 新增一个 `GeoDataCanvasLabelLayer`（或泛化为公共 `CanvasLabelLayer`）实例作为标签层，替代现有 DOM `divIcon` marker 集合。
2. `addTo(map)`: 若 `labelsEnabled`，遍历全部要素收集标签（复用 `_getLabelContent` 取文本 + CircleMarker/Polyline/Polygon 取位置，含新增字段回退）→ `setLabels(items)` → 标签层 `addTo(map)`。
3. `remove(map)`: 移除标签层。
4. `setLabelConfig`/`updateZoom`: 调 `updateConfig` 或重新 `setLabels`（Canvas 重建开销低，无 DOM 全量重建）。
5. **移除** `MAX_LABELS` 上限（`:752`）、优先级裁剪（`:807-812`）、DOM `divIcon` 标签创建（`:817-840`）。

**标签字段回退（已确认）**: `_getLabelContent` 在配置字段（含现有 `fieldMapping`）均缺失时，回退到该要素 properties 中第一个可用的字符串属性字段（如 `OBJECTID`/`NAME_1`/`LABEL` 等），最大化标签显示率。

### 2.2 可见性 ↔ 标签状态协调（解决问题1）

1. **GeoDataLayer 修复**: `addTo()` 中若 `labelsEnabled && !canvasLabelLayer` 则重建标签层（复用 `_createLabels` `:943-1007`），解决"取消勾选→重新勾选"标签不恢复。
2. **OnlineMap 可见性协调**: 图层可见性 useEffect（`OnlineMap.tsx:5147-5261`）在图层变为可见时，按当前 `pointFileLabelVisibility[fileId]` 对 MapInfo/GeoData 层补调 `setLabelVisibility()`，保证勾选复选框立即显示标签。
3. **状态梳理**: 统一 `layerFileLabelVisibility`（MapPage）与 `pointFileLabelVisibility`（OnlineMap）的映射关系，消除孤儿状态；文件标签统一以 OnlineMap 内部 `pointFileLabelVisibility` 为运行期唯一权威，MapPage 本地 state 仅作为 UI 高亮来源。

### 2.3 拖拽实时刷新可视区域（解决问题4）

1. **GeoDataLayer 增加 `map.on('move')`**（`GeoDataLayer.tsx:212-222` 补绑定，`remove` 对称注销）: rAF + 最小间隔节流（约 120-150ms，沿用现有防抖模式）触发视口裁剪重建（复用 `_reRenderGeometries` `:1420`），使拖拽过程中移入视口的要素实时出现。
2. **保留** zoom/zoomend 路径（`_handleZoom`/`_handleZoomEnd`）。
3. **修复** `onMapMove` 中 `zoomChanged===true` 跳过几何重渲染的分支（`:829-831`），确保 moveend 时几何始终按需重渲染。
4. 标签的拖拽跟随由 Canvas 标签层自带 `move` 监听完成（只更新坐标/可见性，不重建），天然流畅。

### 2.4 范围边界（已确认）

- **不加** MapInfo 几何层视口裁剪（本期仅标签 Canvas 化 + 事件/状态修复）。
- 后端零改动。
- 扇区标签（`SectorRendererSVG`）、Excel 点文件标签、图层颜色、z-order 逻辑不改变。

---

## 3. 影响文件

| 文件 | 改动 |
|------|------|
| `frontend/src/renderer/components/Map/GeoDataCanvasLabelLayer.tsx` | 泛化为公共 Canvas 标签层（类名/导出可按需调整，能力不变） |
| `frontend/src/renderer/components/Map/MapInfoLayer.tsx` | 标签从 DOM 改为 Canvas 标签层；移除 MAX_LABELS 上限与优先级裁剪；`_getLabelContent` 加字段回退；`addTo`/`remove`/`setLabelConfig`/`updateZoom` 适配标签层生命周期 |
| `frontend/src/renderer/components/Map/GeoDataLayer.tsx` | `addTo` 重建标签层（labelsEnabled 时）；增加 `map.on('move')` 实时刷新；修复 onMapMove zoomChanged 跳过分支 |
| `frontend/src/renderer/components/Map/OnlineMap.tsx` | 图层可见性 useEffect 补调 `setLabelVisibility`（勾选即显示标签）；梳理 `layerFileLabelVisibility`/`pointFileLabelVisibility` 状态映射 |
| `frontend/src/renderer/pages/MapPage.tsx` | （如需）标签状态同步清理，消除孤儿状态 |
| `frontend/src/renderer/locales/zh.json` / `en.json` | （如需）新增 UI 文案，保持中英文同步 |

---

## 4. 验证

### 4.1 问题1 — 勾选立即显示标签
- [ ] 地理化数据：标签开关打开 → 取消勾选图层 → 重新勾选 → 标签立即显示（无需再拨开关）。
- [ ] 图层文件：标签开关打开 → 勾选图层复选框 → 标签立即显示。

### 4.2 问题2 — 标签全量显示
- [ ] 图层文件标签全量显示（移除 1000/5000 上限）；低缩放级别下相邻标签不重叠（网格防重叠生效）。
- [ ] 配置字段缺失的要素标签通过字段回退显示。

### 4.3 问题3 — 图层文件标签流畅
- [ ] 图层文件标签打开后，地图拖拽、缩放流畅度与地理化数据标签打开时相当（无 DOM 逐要素卡顿）。

### 4.4 问题4 — 拖拽实时刷新
- [ ] 地理化数据拖拽地图时，移入可视区域的要素实时出现（move 触发裁剪重建）；缩放路径保持原有行为。

### 4.5 回归
- [ ] `npx tsc --noEmit` 无新增错误；`npm run lint` 通过；`npm run build:vite` 成功。
- [ ] 扇区标签、Excel 点文件标签、图层颜色设置、z-order 层级不受影响。

---

## 5. 实施顺序

1. **Canvas 标签层泛化 + MapInfoLayer 接入**（问题2、3 主体）。
2. **标签字段回退**（问题2 补充）。
3. **GeoDataLayer addTo 重建标签 + OnlineMap 可见性协调**（问题1）。
4. **GeoDataLayer move 实时刷新 + onMapMove 修复**（问题4）。
5. **测试与验证**（tsc/lint/build + 手动 4 场景 + 回归）。

---

## 6. 风险

- **标签渲染行为变化**: 从 DOM 改 Canvas 后，标签样式（字体/颜色/背景/边框）需通过 Canvas 标签层配置对齐现有 `labelConfig`；`GeoDataCanvasLabelLayer` 已支持 `fontSize/fontColor/backgroundColor/borderColor/borderWidth/padding/minDistance`。
- **字段回退副作用**: 回退到第一个字符串字段可能显示非预期文本（如 OBJECTID 编号）。已确认接受，以最大化标签显示率为优先。
- **move 实时刷新开销**: 拖拽期间视口裁剪重建在超大要素集（>5 万）下仍有开销，通过 rAF + 最小间隔节流控制，必要时实施阶段微调间隔。
- **双份标签状态**: 若 OnlineMap L5416 `point-file-label` DOM marker 路径与 GeoDataLayer Canvas 标签同时生效，可能重复渲染标签。实施阶段需核对该路径归属（Excel 点文件）并确保不重复。
