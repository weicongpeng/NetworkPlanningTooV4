# 图层 z-order 协调修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复地图页频繁勾选/去勾选图层后，被勾选图层（图层文件/地理化数据）左键点击不弹属性框的问题。通过集中式 z-order 协调器，让最高优先级勾选图层的渲染层保持最上，使点击命中正确目标。

**Architecture:** 新增纯函数 `layerZOrder.ts` 计算优先级（`rank = typeRank * 1000 + panelRank`，类型：装饰<地理化数据<图层文件<基站，同类型内面板顶部最高）。为 MapInfoLayer / GeoDataLayer / SectorSVGLayer / 装饰图层各暴露 `bringToFrontForZOrder()`，把实际渲染层 DOM 元素移到其 pane 顶部。`OnlineMap` 增加 `reconcileLayerZOrder()`，在每次可见性变化后按 rank 升序调用各图层的 `bringToFrontForZOrder()`，ranc 最大的最终置顶。

**Tech Stack:** React 18 + TypeScript + Leaflet 1.9（Canvas/SVG renderer）。前端无测试 runner，自动化验证用 `npm run type-check` + `npm run lint`，功能验证用手动 E2E。

**设计文档:** `docs/plans/2026-08-10-layer-zorder-click-design.md`

---

## 根因回顾（实现前必读）

Leaflet 的 **Canvas renderer** 只把点击投递给指针下**最顶层的 `<canvas>`**，命中检测只在该 canvas 内。四类图层都堆在默认 `overlayPane`(zIndex 400)。频繁勾选/去勾选导致 overlayPane 内 `<canvas>`/`<svg>` 的 DOM 顺序漂移，目标图层的 canvas 未必在最上，点击被上层 canvas 拦截 → 不弹属性框。`基站` 用 SVG（逐路径命中）不受影响。

**关键点**：对 Canvas，`LayerGroup/Path.bringToFront()` 只会在**同一张 canvas 内**重绘路径，**不会移动 `<canvas>` DOM 元素**。必须直接操作渲染层元素（`parentNode.appendChild`）。这是修复核心。

---

## 前置：确认各图层渲染层 DOM 元素

实现前，在各图层类中确认/存储渲染层容器引用：

| 图层类型 | 渲染层容器 | 获取方式 |
|---|---|---|
| MapInfoLayer | `<canvas>` | `this.canvasRenderer.getContainer()`（需把 `L.canvas()` 存到实例） |
| GeoDataLayer | `<canvas>` | `this.canvasRenderer.getContainer()`（已在构造函数，行 193） |
| SectorSVGLayer | `<svg>`（map 主 svg） | featureGroup 的渲染容器 |
| 装饰图层 | markerPane 内 marker 元素 | `decorationLayerRef`

> 若实现中发现某图层的渲染层容器与预期不符，以实际 DOM 为准，向上层 `overlayPane`/`markerPane` 追加即可（`parentNode.appendChild` 会把元素移到 pane 顶部）。

---

## Task 1: 新建纯函数优先级模块 `layerZOrder.ts`

**Files:**
- Create: `frontend/src/renderer/components/Map/layerZOrder.ts`

**Step 1:** 创建模块，定义类型、rank 计算与协调函数。

```ts
// frontend/src/renderer/components/Map/layerZOrder.ts
/**
 * 图层层级（z-order）协调
 * 优先级规则（用户确认）：
 *   1. 只勾选某图层 → 该图层最上
 *   2. 多勾选 → 基站 > 图层文件 > 地理化数据 > 装饰图层
 *   3. 同类型内 → 控制面板顶部最高
 *   4. 只认最高层图层（无穿透）
 */

/** 图层类型 rank（低→高 = 底→顶） */
export const LAYER_Z_TYPE_RANK: Record<LayerZType, number> = {
  decoration: 0, // 装饰图层
  geodata: 1,    // 地理化数据
  mapinfo: 2,    // 图层文件
  sector: 3,     // 基站
}

export type LayerZType = 'decoration' | 'geodata' | 'mapinfo' | 'sector'

/** 待协调图层条目 */
export interface ZOrderLayer {
  type: LayerZType
  /** 同类型内面板排序；顶部=最高（值越大 rank 越高） */
  panelRank: number
  /** 把该图层渲染层 DOM 元素移到其 pane 顶部 */
  bringToFront: () => void
}

/** 计算 rank；rank 越大越靠上 */
export function computeZRank(type: LayerZType, panelRank: number): number {
  return LAYER_Z_TYPE_RANK[type] * 1000 + panelRank
}

/**
 * 按 rank 升序调用 bringToFront。
 * 最后调用的（rank 最大 = 最高优先级）最终置顶。
 * @param layers 勾选可见的图层（不含隐藏图层）
 */
export function reconcileZOrder(layers: ZOrderLayer[]): void {
  const sorted = [...layers].sort(
    (a, b) => computeZRank(a.type, a.panelRank) - computeZRank(b.type, b.panelRank)
  )
  for (const layer of sorted) {
    layer.bringToFront()
  }
}
```

**Step 2:** 验证语法与类型。

Run: `cd frontend && npx tsc --noEmit --skipLibCheck src/renderer/components/Map/layerZOrder.ts`
Expected: 无明显类型错误（若有存量错误不影响本文件）。

**Step 3: Commit**

```bash
git add frontend/src/renderer/components/Map/layerZOrder.ts
git commit -m "feat: 新增图层 z-order 优先级纯函数模块"
```

---

## Task 2: MapInfoLayer 暴露 `bringToFrontForZOrder()`

**Files:**
- Modify: `frontend/src/renderer/components/Map/MapInfoLayer.tsx`

**Context:** 该层用独立 `L.canvas()` renderer（行 ~377 `const canvasRenderer = L.canvas()`）。需把 renderer 存到实例字段，新增方法把 `<canvas>` 移到 pane 顶部。

**Step 1:** 在类字段区新增实例字段（在 `id`/`geoJSONLayer` 字段附近）：

```ts
private canvasRenderer: L.Canvas | null = null
```

**Step 2:** 在创建 renderer 处存储到实例（找到 `const canvasRenderer = L.canvas()` 所在行，改为）：

```ts
this.canvasRenderer = L.canvas()
const canvasRenderer = this.canvasRenderer
```

**Step 3:** 新增方法（放在 `setInteractive` 之后）：

```ts
/**
 * 把该图层的 canvas 渲染层移到 pane 顶部，使其成为点击命中目标。
 * 对 Canvas，路径 bringToFront 只重绘不移动 DOM，必须直接操作 canvas 元素。
 */
bringToFrontForZOrder(): void {
  const container = this.canvasRenderer?.getContainer?.() as HTMLElement | undefined
  if (container && container.parentNode) {
    container.parentNode.appendChild(container)
  }
}
```

**Step 4:** 验证。

Run: `cd frontend && npx tsc --noEmit --skipLibCheck`
Expected: 无新增类型错误。

**Step 5: Commit**

```bash
git add frontend/src/renderer/components/Map/MapInfoLayer.tsx
git commit -m "feat: MapInfoLayer 暴露 bringToFrontForZOrder 置顶 canvas"
```

---

## Task 3: GeoDataLayer 暴露 `bringToFrontForZOrder()`

**Files:**
- Modify: `frontend/src/renderer/components/Map/GeoDataLayer.tsx`

**Context:** `this.canvasRenderer` 已在构造函数（行 193）。直接新增方法。

**Step 1:** 新增方法（放在 `setInteractive` 附近）：

```ts
/** 把 canvas 渲染层移到 pane 顶部，使其成为点击命中目标 */
bringToFrontForZOrder(): void {
  const container = this.canvasRenderer?.getContainer?.() as HTMLElement | undefined
  if (container && container.parentNode) {
    container.parentNode.appendChild(container)
  }
}
```

**Step 2:** 验证。

Run: `cd frontend && npx tsc --noEmit --skipLibCheck`
Expected: 无新增类型错误。

**Step 3: Commit**

```bash
git add frontend/src/renderer/components/Map/GeoDataLayer.tsx
git commit -m "feat: GeoDataLayer 暴露 bringToFrontForZOrder 置顶 canvas"
```

---

## Task 4: SectorSVGLayer 暴露 `bringToFrontForZOrder()`

**Files:**
- Modify: `frontend/src/renderer/components/Map/SectorRendererSVG.tsx`

**Context:** 扇区用 SVG featureGroup（行 223 `this.featureGroup.addTo(map)`），SVG 根在 map 的 `<svg>` 中。把扇区的 `<g>` 移到 `<svg>` 顶部，使其高于其他 svg 内容。

**Step 1:** 新增方法：

```ts
/** 把扇区 svg 渲染层移到 pane 顶部，使其成为点击命中目标 */
bringToFrontForZOrder(): void {
  const container = this.featureGroup?.getContainer?.() as HTMLElement | undefined
  if (container && container.parentNode) {
    container.parentNode.appendChild(container)
  }
}
```

> 若 `featureGroup.getContainer()` 返回的是 `<g>`，`appendChild` 会把它移到 `<svg>` 末尾（顶部）。若实现中扇区与其他图层共享同一 `<svg>`，此操作只把扇区提到最上，符合"基站最高优先级"。

**Step 2:** 验证。

Run: `cd frontend && npx tsc --noEmit --skipLibCheck`
Expected: 无新增类型错误。

**Step 3: Commit**

```bash
git add frontend/src/renderer/components/Map/SectorRendererSVG.tsx
git commit -m "feat: SectorSVGLayer 暴露 bringToFrontForZOrder 置顶 svg"
```

---

## Task 5: 装饰图层暴露 `bringToFrontForZOrder()`

**Files:**
- Modify: `frontend/src/renderer/components/Map/OnlineMap.tsx`

**Context:** 装饰图层用 `decorationLayerRef`（L.LayerGroup，行 325）。marker 默认进 `markerPane`(zIndex 600)，天然在 overlayPane(400) 之上。装饰为最低优先级，此处仅保证其内部 marker 顺序一致（若其独立勾选则自身可点）。

**Step 1:** 在 `OnlineMap` 内新增辅助函数（装饰图层由 OnlineMap 持有，无需改类）：

```ts
/** 装饰图层：把其 marker 移到 markerPane 顶部（装饰为最低优先级，仅独立勾选时自身可点） */
const bringDecorationToFront = () => {
  const fg = decorationLayerRef.current
  if (!fg) return
  fg.eachLayer((layer: any) => {
    const el = layer?.getElement?.()
    if (el && el.parentNode) el.parentNode.appendChild(el)
  })
}
```

**Step 2:** 验证。

Run: `cd frontend && npx tsc --noEmit --skipLibCheck`
Expected: 无新增类型错误。

**Step 3: Commit**

```bash
git add frontend/src/renderer/components/Map/OnlineMap.tsx
git commit -m "feat: 装饰图层置顶辅助函数"
```

---

## Task 6: 新增 `reconcileLayerZOrder()` 并接入触发点

**Files:**
- Modify: `frontend/src/renderer/components/Map/OnlineMap.tsx`

**Context:** 协调器汇总所有可见图层（带 type/panelRank/bringToFront），按 rank 升序协调。在每次可见性变化后调用。

**Step 1:** 新增协调函数（放在 `loadMapInfoLayer` 之前），读取各 ref 与可见状态：

```ts
/**
 * 汇总所有勾选可见图层并按优先级重排渲染层。
 * 优先级：基站 > 图层文件 > 地理化数据 > 装饰图层；同类型内面板顶部最高。
 */
const reconcileLayerZOrder = useCallback(() => {
  const visible: ZOrderLayer[] = []

  // 装饰图层（最低优先级，typeRank=0）
  if (decorationLayerVisibility) {
    visible.push({ type: 'decoration', panelRank: 1, bringToFront: bringDecorationToFront })
  }

  // 地理化数据（typeRank=1）：按 pointFiles 面板顺序
  const visibleGeo = pointFiles.filter(f => f.visible)
  visibleGeo.forEach((f, idx) => {
    const gl = geoDataLayerManagerRef.current?.getLayer?.(f.id)
    if (!gl) return
    visible.push({
      type: 'geodata',
      panelRank: visibleGeo.length - idx, // 顶部最高
      bringToFront: () => gl.bringToFrontForZOrder(),
    })
  })

  // 图层文件（typeRank=2）：按 layerFiles 面板顺序
  const visibleMap = layerFiles.filter(f => f.visible)
  visibleMap.forEach((f, idx) => {
    const ref = mapInfoLayerRefsRef.current.get(f.id)
    if (!ref) return
    visible.push({
      type: 'mapinfo',
      panelRank: visibleMap.length - idx,
      bringToFront: () => ref.mapInfoLayer.bringToFrontForZOrder(),
    })
  })

  // 基站（typeRank=3）：按 sectors 面板顺序
  const visibleSector = sectors.filter(s => s.visible)
  visibleSector.forEach((s, idx) => {
    const layer = s.type === 'LTE' ? lteSectorLayerRef.current : nrSectorLayerRef.current
    if (!layer) return
    visible.push({
      type: 'sector',
      panelRank: visibleSector.length - idx,
      bringToFront: () => layer.bringToFrontForZOrder(),
    })
  })

  reconcileZOrder(visible)
}, [decorationLayerVisibility, pointFiles, layerFiles, sectors, bringDecorationToFront])
```

> 实现时以实际 ref 名/字段名/manager 方法为准核对（`pointFiles`/`layerFiles`/`sectors` 的可见性字段、`geoDataLayerManagerRef` 取图层方法、`mapInfoLayerRefsRef` 结构、扇区 ref 命名）。若某管理器的可见性状态不在 OnlineMap 的 state 中，改用该管理器提供的可见性查询。

**Step 2:** 在各可见性变化处调用。在下列 handler 末尾追加 `reconcileLayerZOrder()`：
- `setMapInfoLayerVisibility`（行 ~700）
- GeoData 图层可见性切换（`setMapInfoLayerVisibility` 内的 GeoData 分支，行 ~707）
- 扇区可见性切换
- 装饰图层勾选（`setDecorationLayerVisibility`，行 ~788）

同时在 `useEffect` 初始化（地图就绪、图层加载后）调用一次。

**Step 3:** 验证。

Run: `cd frontend && npx tsc --noEmit --skipLibCheck`
Expected: 无新增类型错误。

Run: `cd frontend && npm run lint`
Expected: 无新增告警。

**Step 4: Commit**

```bash
git add frontend/src/renderer/components/Map/OnlineMap.tsx
git commit -m "feat: 图层 z-order 协调器 reconcileLayerZOrder 接入可见性切换"
```

---

## Task 7: 端到端手动验证

**Files:** 无（仅验证）

**Step 1:** 启动后端 + 前端（`start_electron_app.bat`，或后端 `python main.py` + 前端 `npm run dev:web`）。

**Step 2:** 逐项验证（对照设计目标）：

| # | 场景 | 预期 |
|---|---|---|
| 1 | 只勾选某图层文件 | 该图层元素点击弹属性 |
| 2 | 只勾选某地理化数据 | 该图层元素点击弹属性 |
| 3 | 勾选 图层文件 + 地理化数据 | 只点图层文件元素弹属性；点地理化数据元素不弹（被上层遮挡） |
| 4 | 勾选 基站 + 图层文件 | 基站元素可点、图层文件被遮挡 |
| 5 | 只勾选 装饰图层 | 装饰元素可点 |
| 6 | 反复勾选/去勾选后重复 1-5 | 结果稳定、无保留漂移行为 |

**Step 3:** 若出现偏差，记录现象回到对应 Task 修复（重点核对：各图层渲染层容器是否取对、reconcile 触发点是否覆盖全部可见性变化、装饰图层 markerPane 边界）。

**Step 4:** 确认 `npm run type-check` 与 `npm run lint` 无新增问题。

---

## 完成标准（Definition of Done）

- [ ] `layerZOrder.ts` 纯函数模块新增
- [ ] MapInfoLayer / GeoDataLayer / SectorSVGLayer 各暴露 `bringToFrontForZOrder()`
- [ ] `OnlineMap.reconcileLayerZOrder()` 接入全部可见性触发点
- [ ] `npm run type-check` 无新增错误
- [ ] `npm run lint` 无新增告警
- [ ] 手动 E2E 表格 6 项全部通过
- [ ] 无 TODO 占位 / 未实现分支