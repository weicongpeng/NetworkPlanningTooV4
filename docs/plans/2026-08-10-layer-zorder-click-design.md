# 图层层级（z-order）协调修复设计

**日期**: 2026-08-10
**状态**: 已确认（方案 A）
**相关分支**: layer-tools

## 背景与问题

地图页控制面板包含四类图层：**基站**（扇区）、**图层文件**（MapInfo）、**地理化数据**（GeoData）、**装饰图层**（打点/定位标记）。在频繁勾选/去勾选子图层后，被勾选图层的元素**鼠标左键点击不再弹出属性框**；`基站` 图层不受影响。

### 根因

Leaflet 的 **Canvas renderer** 只把点击事件投递给指针下**最顶层的 `<canvas>`**。命中检测只在该 canvas 内进行：

- `图层文件`（MapInfoLayer）与 `地理化数据`（GeoDataLayer）各用**独立的 `L.canvas()` renderer**。
- 四类图层全部堆叠在默认 `overlayPane`（zIndex 400）中，Canvas/SVG 的 DOM 顺序决定谁在最上。
- 当某张 canvas（如一个 GeoData 或空 canvas）压在 MapInfo canvas 之上时，浏览器点击被这张 canvas 拦截 → 命中检测找不到路径 → **不触发任何图层点击**，且下方 canvas 永远收不到 DOM click。
- `基站` 用 **SVG** renderer，按路径逐元素命中检测，`<g>` 空处不拦截点击，因此不受影响。

频繁勾选/去勾选导致 overlayPane 内 canvas/SVG 的 DOM 顺序漂移，使目标图层的 canvas 未必在最上，属性框无法弹出。

## 目标（用户确认）

统一 z-order，使点击永远命中**最高优先级勾选图层**，且"只认最高层图层"：

1. **只勾选某一图层** → 该图层层级最高，元素可点击弹出属性框。
2. **同时勾选多图层** → 层级从高到低：`基站 > 图层文件 > 地理化数据 > 装饰图层`。
3. **同类型内** → 控制面板**从上到下**优先级递减（顶部最高）。
4. **装饰图层**可作为最低优先级图层参与点击。
5. **点击穿透**：只认最高层图层 —— 最高层该点无元素则点击无效，不回落到下方图层。

> 注：面板顺序（顶部 `基站` → `图层文件` → `地理化数据` → `装饰图层`）恰好等于目标优先级顺序。

## 方案选型

采用 **方案 A：集中式 z-order 协调器**。理由：
- 需求本质是"让最高优先级图层的渲染层保持最上"，无需复杂点击路由。
- 改动集中、不影响各图层自身现有 `on('click')` 逻辑。
- 规避方案 C（全局点击路由）的逐点命中检测与回归风险。

## 设计

### 1. 优先级模型（纯函数）

```
rank = typeRank * 1000 + panelRank
```

- **typeRank**（低→高 = 底→顶）：
  - 装饰图层 = 0
  - 地理化数据（GeoData, custom-group）= 1
  - 图层文件（MapInfo, layer-files）= 2
  - 基站（Sector, sector-group）= 3
- **panelRank**：同类型内，面板**顶部**最高。某类型有 N 个项，顶部第 1 个 `panelRank = N`，向下递减。
- **只纳入勾选可见的图层**。

### 2. 协调函数 `reconcileLayerZOrder()`

```
1. 收集所有可见图层：{ layer, rank }（decoration / geodata / mapinfo / sector）
2. 按 rank 升序排序
3. 依次调用 layer.bringToFrontForZOrder()   // rank 越大越靠后 → 最终置顶
```

调用后最高优先级图层的渲染层在 overlayPane 中最靠上，成为点击命中目标。

### 3. 各图层类型的 `bringToFrontForZOrder()`

为每类图层暴露方法，把**实际渲染层 DOM 元素**移到 pane 顶部：

| 图层类型 | 渲染层 | 置顶方式 |
|---|---|---|
| 图层文件 MapInfo | 独立 `L.canvas()` | 取 `<canvas>` 元素 → `pane.appendChild(canvasEl)` |
| 地理化数据 GeoData | 独立 `L.canvas()` | 同上 |
| 基站 Sector | SVG `<g>` | 取 featureGroup 容器 → `pane.appendChild(svgEl)` |
| 装饰图层 Decoration | 依实现 | 同上 |

> **关键点**：对 Canvas，`LayerGroup.bringToFront()` 或 `Path.bringToFront()` 只会在**同一张 canvas 内**按画家算法重绘路径，**不会移动 `<canvas>` DOM 元素**。因此必须直接操作渲染层元素（`pane.appendChild`），这是根因修复的核心。

### 4. 触发时机

在以下任一处调用 `reconcileLayerZOrder()`：
- 勾选/去勾选任一图层（`setMapInfoLayerVisibility`、GeoData 可见性切换、Sector 可见性切换、Decoration 勾选）
- 图层文件加载/移除后
- 地图初始化完成后

为防遗漏，可放在一个统一 `useEffect` 中，监听"可见图层集合"变化后触发。

### 5. 错误处理与边界

- **装饰图层最低**：仅当其被单独勾选、或上三层该处无元素时才可点击（因"只认最高层"）。
- **无勾选图层**：协调器为空操作，点击落到地图默认行为。
- **rank 冲突**：typeRank 区分类型、panelRank 区分同类型内，避免冲突。

## 改动文件（预估）

- `frontend/src/renderer/components/Map/OnlineMap.tsx` — 新增 `reconcileLayerZOrder()`、触发点、优先级收集
- `frontend/src/renderer/components/Map/MapInfoLayer.tsx` — 暴露 `bringToFrontForZOrder()`
- `frontend/src/renderer/components/Map/GeoDataLayer.tsx` — 暴露 `bringToFrontForZOrder()`
- `frontend/src/renderer/components/Map/SectorRendererSVG.tsx` — 暴露 `bringToFrontForZOrder()`（如需）
- 装饰图层渲染组件 — 暴露 `bringToFrontForZOrder()`
- 新增纯函数模块（优先级计算，便于单测）

## 测试

- **纯函数单测**：优先级 rank 计算（不同勾选组合、单图层、同类型排序）。
- **手动端到端**：
  - 单勾选某图层 → 点击元素 → 弹属性。
  - 多勾选（如 图层文件 + 地理化数据）→ 只点最高层（图层文件）元素弹属性；点地理化数据元素不弹（被上层遮挡）。
  - 勾选 基站 + 图层文件 → 基站元素可点、图层文件被遮挡。
  - 只勾选 装饰图层 → 装饰元素可点。
  - 反复勾选/去勾选后重复以上，确认无漂移。