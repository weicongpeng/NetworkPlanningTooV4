/**
 * 原始采样热力图层（逐点渲染，不做 IDW 栅格化）
 *
 * 实现严格对齐 Leaflet 内置 Renderer/Canvas 的坐标与动画机制：
 * - canvas backing 比视口四周外扩 PADDING（平移缓冲），元素定位在 layerPoint 坐标系
 *   （bounds.min），ctx translate(-bounds.min) 后直接用 layerPoint 坐标绘制
 * - 元素带 `leaflet-zoom-animated` class：zoom 动画期间监听 zoomanim，对 canvas 做
 *   setTransform(offset, scale)（CSS transition 0.25s）→ 与地图缩放完全同步；
 *   zoom 事件（flyTo 等）同样只做 CSS transform，不重绘内容
 * - zoomend：按新 zoom 重新投影所有点；随后的 moveend 重设 backing 并重绘
 *   （重定位+换 backing 在同一同步事件链原子完成，无残余跳变/闪烁）
 * - moveend：重算 bounds/backing 后用现有要素重绘（zoom 未变，坐标自动对齐）
 * - canvas pointerEvents:none，不接收鼠标事件，不影响地图点击/圈选
 */
import L from 'leaflet'
import type { HeatPoint } from '../../utils/heatmap'
import type { HeatBoundary } from '../../utils/heatSurface'
import { layoutSampleBlobs, type ProjectedPoint } from '../../utils/sampleBlobLayout'

/** backing 相对视口四周的外扩比例（平移缓冲：小幅拖出视口的内容已在 backing 内） */
const PADDING = 0.3

/** 屏幕空间斑半径约束（px）：rMax = R_MAX_BASE + smooth×R_MAX_SMOOTH_K */
const R_MIN_PX = 1.5
const R_MAX_BASE = 20
const R_MAX_SMOOTH_K = 3

/** 逐点渲染输入（与栅格管线共用同一套映射/色带，保证与图例同源） */
export interface OriginalSamplesData {
  points: HeatPoint[]
  /** 逐点地理半径（米，与 points 对齐） */
  pointRadii: Float64Array
  /** 值 → 色带位置 0~1（含离散量化/手工分级/对比度） */
  mapValue: (v: number) => number
  /** 色带 RGBA LUT（buildGradientLut 产物，256 色） */
  lut: Uint8ClampedArray
  /** 整体不透明度 0~1 */
  opacity: number
  /** 边界裁剪多边形（[lng,lat]，evenodd），null=不裁剪 */
  boundary: HeatBoundary | null
  /** 细节增强 0~100：控制单点色斑沿色带向下的颜色层次跨度（越大层次越丰富） */
  detail: number
  /** 离散分级数（≥2 时颜色按 N 级量化成硬色环；0=连续） */
  discreteLevels: number
  /** 平滑强度 1~10：与屏幕半径上限联动（默认 9） */
  smooth?: number
}

/** 一次投影后每个可见点的绘制参数（layerPoint 坐标系） */
interface BlobItem {
  x: number
  y: number
  r: number
  /** 中心色带位置 0~1（mapValue(weight)） */
  tc: number
}

export class OriginalSamplesLayer extends L.Layer {
  private map: L.Map | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null

  private data: OriginalSamplesData | null = null
  private items: BlobItem[] = []
  /** 当前 backing 覆盖的 layerPoint 范围（min/max 必非空） */
  private _bounds: { min: L.Point; max: L.Point } | null = null
  /** 事件 map（稳定引用 + 箭头绑定 this，供 on/off 配对使用） */
  private _eventsMap: L.LeafletEventHandlerFnMap | null = null
  /** items 投影时使用的地图中心/缩放（_updateTransform 的基准） */
  private _center: L.LatLng | null = null
  private _zoom = 0
  private _drawQueued = false

  /**
   * Leaflet 生命周期：添加到地图
   */
  onAdd(map: L.Map): this {
    this.map = map

    // leaflet-zoom-animated：zoom 动画时 CSS transition 让 transform 平滑跟随
    this.canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated npt-original-samples-canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.pointerEvents = 'none'

    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('OriginalSamplesLayer: 无法获取 Canvas 2D 上下文')
    this.ctx = ctx

    const pane = map.getPanes()?.overlayPane
    if (pane) pane.appendChild(this.canvas)

    map.on(this._bindEvents())

    // 初始 bounds/backing（此时 data 可能尚未 update，空画布）
    this._update()
    return this
  }

  /**
   * Leaflet 生命周期：从地图移除
   */
  onRemove(map: L.Map): this {
    if (this._eventsMap) map.off(this._eventsMap)
    if (this.canvas?.parentNode) this.canvas.parentNode.removeChild(this.canvas)
    this.canvas = null
    this.ctx = null
    this.map = null
    this.items = []
    this._bounds = null
    this._center = null
    return this
  }

  /**
   * 全量更新绘制数据并重绘（数据/设置变化时由管理器调用，zoom 未变）。
   */
  update(data: OriginalSamplesData): void {
    this.data = data
    if (this.map) {
      this._project()
      this._requestDraw()
    }
  }

  /**
   * 只更新边界（边界异步加载完成时调用）并重绘。
   */
  setBoundary(boundary: HeatBoundary | null): void {
    if (this.data) this.data = { ...this.data, boundary }
    if (this.map) this._requestDraw()
  }

  /** canvas 元素（管理器置顶用） */
  getCanvas(): HTMLCanvasElement | null {
    return this.canvas
  }

  // ------------------------------------------------------------------
  // 事件（与 L.Renderer getEvents 同构）
  // ------------------------------------------------------------------

  private _bindEvents(): L.LeafletEventHandlerFnMap {
    if (this._eventsMap) return this._eventsMap
    this._eventsMap = {
      viewreset: () => this._onViewReset(),
      zoom: () => this._onZoom(),
      moveend: () => this._onMoveEnd(),
      zoomend: () => this._onZoomEnd(),
      zoomanim: (e) => this._onAnimZoom(e as L.ZoomAnimEvent),
    }
    return this._eventsMap
  }

  private _onAnimZoom(ev: L.ZoomAnimEvent): void {
    this._updateTransform(ev.center, ev.zoom)
  }

  private _onZoom(): void {
    if (!this.map) return
    this._updateTransform(this.map.getCenter(), this.map.getZoom())
  }

  private _onZoomEnd(): void {
    // 按新 zoom 重新投影；随后 moveend(_moveEnd 中 zoomend 后紧接 moveend)
    // 会重设 backing 并用新 items 重绘，原子呈现无跳变
    this._project()
  }

  private _onMoveEnd(): void {
    // 重设 backing（新 panePos）后重新投影：纳入随拖动新进入 backing 的点；
    // zoom 未变，旧点坐标体系不变（_pixelOrigin 拖拽期不更新），视觉连续无跳变
    this._update()
    this._project()
    this._draw()
  }

  private _onViewReset(): void {
    // zoomAnimation 关闭等路径：bounds/backing + 投影 + 重绘
    this._update()
    this._project()
    this._draw()
  }

  // ------------------------------------------------------------------
  // Bounds / backing（对齐 L.Canvas._update）
  // ------------------------------------------------------------------

  /**
   * 重算 bounds、canvas 元素位置与 backing 尺寸（会清空 canvas），
   * ctx 坐标系平移到 layerPoint。
   */
  private _update(): void {
    const map = this.map
    const canvas = this.canvas
    const ctx = this.ctx
    if (!map || !canvas || !ctx) return

    const p = PADDING
    const size = map.getSize()
    const min = map.containerPointToLayerPoint(size.multiplyBy(-p)).round()
    const max = min.add(size.multiplyBy(1 + p * 2)).round()
    this._bounds = { min, max }
    this._center = map.getCenter()
    this._zoom = map.getZoom()

    const b = max.subtract(min)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    L.DomUtil.setPosition(canvas, min)
    // 重设 width/height 自动清空 backing
    canvas.width = Math.round(b.x * dpr)
    canvas.height = Math.round(b.y * dpr)
    canvas.style.width = `${b.x}px`
    canvas.style.height = `${b.y}px`

    // 之后直接按 layerPoint 坐标绘制
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.translate(-min.x, -min.y)
  }

  /**
   * zoom 动画期间的 CSS 变换（公式同 L.Renderer._updateTransform）：
   * 不换 backing、不重绘，只对 canvas 元素做 translate+scale，由浏览器合成实时跟随。
   */
  private _updateTransform(center: L.LatLng, zoom: number): void {
    const map = this.map
    const canvas = this.canvas
    if (!map || !canvas || !this._center) return

    const scale = map.getZoomScale(zoom, this._zoom)
    const viewHalf = map.getSize().multiplyBy(0.5 + PADDING)
    const currentCenterPoint = map.project(this._center, zoom)
    // _getNewPixelOrigin 为 Leaflet 内部方法（运行时存在，类型未导出）
    const newPixelOrigin = (map as unknown as {
      _getNewPixelOrigin: (c: L.LatLng, z: number) => L.Point
    })._getNewPixelOrigin(center, zoom)
    const topLeftOffset = viewHalf.multiplyBy(-scale).add(currentCenterPoint)
      .subtract(newPixelOrigin)

    L.DomUtil.setTransform(canvas, topLeftOffset, scale)
  }

  // ------------------------------------------------------------------
  // 投影 + 绘制
  // ------------------------------------------------------------------

  /**
   * 按当前地图 zoom 把每个点投影为 layerPoint + 屏幕半径（仅保留 backing 范围内点）。
   */
  private _project(): void {
    const map = this.map
    if (!map || !this.data || !this._bounds) {
      this.items = []
      return
    }
    const { points, pointRadii, mapValue, smooth } = this.data
    // 兜底值与 DEFAULT_HEATMAP_SETTINGS.smooth 保持一致（Manager 始终显式传入，兜底不会触发）
    const smoothN = Math.min(10, Math.max(1, smooth ?? 4))
    // 屏幕半径上限（与平滑强度联动，smooth 1→23px、10→50px）：放大后斑不再变大
    const rMax = R_MAX_BASE + smoothN * R_MAX_SMOOTH_K
    const zoom = map.getZoom()
    // 当前 zoom 下"米/像素"：40075016.686 * cos(lat) / 2^(zoom+8)
    const zoomScale = 256 * Math.pow(2, zoom)
    const earthSpan = 40_075_016.686
    const b = this._bounds
    const projected: ProjectedPoint[] = []
    for (let i = 0; i < points.length; i++) {
      const p = points[i]
      const lp = map.latLngToLayerPoint([p.lat, p.lng])
      // backing 粗筛（含半径外扩，避免边缘斑被裁）
      const metersPerPixel = earthSpan * Math.cos(p.lat * Math.PI / 180) / zoomScale
      if (!(metersPerPixel > 0)) continue
      const baseR = pointRadii[i] / metersPerPixel
      if (!(baseR > 0.05)) continue
      // 最终 r ≤ min(baseR, rMax)，粗筛按此外扩
      const pad = Math.min(baseR, rMax)
      if (lp.x + pad < b.min.x || lp.x - pad > b.max.x || lp.y + pad < b.min.y || lp.y - pad > b.max.y) continue

      const t = mapValue(p.weight)
      projected.push({ x: lp.x, y: lp.y, baseR, tc: t <= 0 ? 0 : t >= 1 ? 1 : t })
    }
    // 屏幕空间最近邻防重叠 + 重合点合并（纯函数，见 utils/sampleBlobLayout）
    this.items = layoutSampleBlobs(projected, { rMin: R_MIN_PX, rMax })
  }

  /**
   * 按当前/最新 items 重绘 backing（支持边界 clip 与色带径向层次）。
   * backing 在 moveend _update 时已清空；设置变化触发时这里自行清空。
   */
  private _draw(): void {
    const map = this.map
    const ctx = this.ctx
    if (!map || !ctx || !this.data || !this._bounds) return
    const { opacity, boundary, lut, detail, discreteLevels } = this.data
    const bMin = this._bounds.min
    const bSize = this._bounds.max.subtract(bMin)
    ctx.clearRect(bMin.x, bMin.y, bSize.x, bSize.y)

    const a0 = opacity <= 0 ? 0 : opacity >= 1 ? 1 : opacity
    if (a0 === 0 || this.items.length === 0) return

    // 细节增强 → 颜色层次跨度：色斑从中心 t=tc 沿色带向低端过渡，
    // detail=0 仅微降（近似单色柔和斑），detail=100 几乎降到色带底端（完整色环层次）
    const span = 0.05 + 0.9 * Math.min(1, Math.max(0, detail / 100))
    // 径向分段数：连续梯度呈现色带的色相环，离散时相邻段同色形成硬色环
    const K = 10

    ctx.save()
    // 边界裁剪：layerPoint 坐标环 + evenodd（与栅格掩膜规则一致，支持多面/洞）
    if (boundary && boundary.length) {
      ctx.beginPath()
      for (const polygon of boundary) {
        for (const ring of polygon) {
          for (let i = 0; i < ring.length; i++) {
            const lp = map.latLngToLayerPoint([ring[i][1], ring[i][0]])
            if (i === 0) ctx.moveTo(lp.x, lp.y)
            else ctx.lineTo(lp.x, lp.y)
          }
          ctx.closePath()
        }
      }
      ctx.clip('evenodd')
    }

    for (const it of this.items) {
      const grad = ctx.createRadialGradient(it.x, it.y, 0, it.x, it.y, it.r)
      for (let s = 0; s <= K; s++) {
        const f = s / K
        let t = it.tc * (1 - span * f)
        // 离散分级：量化到 N 级 → 同心硬色环
        if (discreteLevels >= 2) t = Math.floor(t * discreteLevels) / discreteLevels
        const li = (t <= 0 ? 0 : t >= 1 ? 255 : (t * 255) | 0) << 2
        // 不透明度：中心 60% 半径内保持 opacity 完全不透明，仅外缘 40% smoothstep 羽化
        let af: number
        if (f <= 0.6) {
          af = a0
        } else {
          const g = (f - 0.6) / 0.4
          af = a0 * (1 - g * g * (3 - 2 * g))
        }
        grad.addColorStop(f, `rgba(${lut[li]},${lut[li + 1]},${lut[li + 2]},${af})`)
      }
      ctx.beginPath()
      ctx.fillStyle = grad
      ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  private _requestDraw(): void {
    if (this._drawQueued) return
    this._drawQueued = true
    requestAnimationFrame(() => {
      this._drawQueued = false
      this._draw()
    })
  }
}
