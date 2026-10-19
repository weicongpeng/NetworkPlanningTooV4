/**
 * 共享标签布局引擎（LabelLayoutManager）
 *
 * 解决问题：
 * - 旧实现中各图层（LTE/NR 扇区层、地理化数据层、MapInfo 点层）各自做标签防重叠，
 *   互相不感知；且防重叠只按"锚点网格"判断，不考虑标签实际文本矩形宽度，
 *   导致标签大量重叠。地理化 Canvas 标签层只在创建时按当时屏幕坐标去重一次，
 *   缩放后不再重新碰撞，缩小视图时标签挤成"文字墙"。
 *
 * 方案：
 * - 所有标签源把候选标签（地理坐标 + 文本 + 字号 + 颜色 + 优先级）注册到本引擎；
 * - 每次 moveend / zoomend / 候选变更时，在屏幕空间统一布局：
 *   1. 视口粗筛（经纬度边界 + 像素边距）；
 *   2. 按优先级、屏幕位置排序（高优先级、靠上靠左优先）；
 *   3. 用 Canvas measureText 得到文本实际尺寸，构造标签矩形；
 *   4. 贪心放置：依次尝试 8 个避让方位（上 → 右上 → 左上 → 右 → 左 → 右下 → 左下 → 下），
 *      第一个不与已放置矩形（空间哈希网格 + 间距膨胀）碰撞且完整在视口内的方位胜出，
 *      否则该标签本次不显示；
 * - 布局结果以"锚点屏幕偏移（dx, dy）"记录；平移时按锚点实时投影 + 偏移重绘
 *   （平移不改变相对屏幕几何，偏移持续有效）；缩放动画期间隐藏标签，zoomend 重新布局。
 * - 所有标签绘制在同一个 Canvas 上（pointer-events: none），跨图层全局不重叠。
 *
 * 布局与绘制的算法在 `labelLayoutCore`（纯函数）里，3D 的 `CesiumLabelOverlay` 复用同一份，
 * 本类只负责把它接到 Leaflet 的坐标系与事件上。
 */
import L from 'leaflet'
import {
  layoutLabels,
  drawPlacedLabels,
  type LabelCandidateBase,
  type PlacedLabel,
} from './labelLayoutCore'

/** 标签候选（由各图层注册） */
export type LabelCandidate = LabelCandidateBase
export type { PlacedLabel }

/**
 * 共享标签布局引擎（Leaflet 图层，单 Canvas 绘制）
 */
export class LabelLayoutManager extends L.Layer {
  private map: L.Map | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null

  /** 各标签源注册的候选标签，key = sourceId */
  private sources = new Map<string, LabelCandidate[]>()
  /** 最近一次布局结果 */
  private placements: PlacedLabel[] = []

  /** 文本测量用的离屏 canvas */
  private measureCtx: CanvasRenderingContext2D | null = null
  private textWidthCache = new Map<string, number>()

  private _layoutQueued = false
  private _drawQueued = false
  /** 缩放动画期间隐藏标签（缩放过程中旧偏移失效，强制等 zoomend 重新布局） */
  private _zooming = false

  /**
   * Leaflet 生命周期：添加到地图
   */
  onAdd(map: L.Map): this {
    this.map = map

    this.canvas = L.DomUtil.create('canvas', 'npt-label-layout-canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '1000'

    const ctx = this.canvas.getContext('2d')
    if (!ctx) {
      throw new Error('LabelLayoutManager: 无法获取 Canvas 2D 上下文')
    }
    this.ctx = ctx

    const pane = map.getPanes()?.overlayPane
    if (pane) {
      pane.appendChild(this.canvas)
    }

    this._resizeCanvas()
    this._updateCanvasPosition()

    map.on('moveend', this._onMoveEnd, this)
    map.on('move', this._onMove, this)
    map.on('resize', this._onResize, this)
    map.on('zoomstart', this._onZoomStart, this)
    map.on('zoomend', this._onZoomEnd, this)
    map.on('viewreset', this._onViewReset, this)

    this._requestLayout()
    return this
  }

  /**
   * Leaflet 生命周期：从地图移除
   */
  onRemove(map: L.Map): this {
    map.off('moveend', this._onMoveEnd, this)
    map.off('move', this._onMove, this)
    map.off('resize', this._onResize, this)
    map.off('zoomstart', this._onZoomStart, this)
    map.off('zoomend', this._onZoomEnd, this)
    map.off('viewreset', this._onViewReset, this)

    if (this.canvas?.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas)
    }
    this.canvas = null
    this.ctx = null
    this.map = null
    this.placements = []
    return this
  }

  /**
   * 注册（全量替换）某标签源的候选标签
   */
  setCandidates(sourceId: string, candidates: LabelCandidate[]): void {
    this.sources.set(sourceId, candidates)
    this._requestLayout()
  }

  /**
   * 移除标签源（图层关闭标签 / 图层移除时调用）
   */
  removeSource(sourceId: string): void {
    if (this.sources.delete(sourceId)) {
      this._requestLayout()
    }
  }

  // ------------------------------------------------------------------
  // 事件处理
  // ------------------------------------------------------------------

  private _onMoveEnd(): void {
    this._requestLayout()
  }

  private _onMove(): void {
    // 平移：相对屏幕几何不变，用旧偏移实时重绘即可
    this._updateCanvasPosition()
    this._requestDraw()
  }

  private _onResize(): void {
    this._resizeCanvas()
    this._requestLayout()
  }

  private _onZoomStart(): void {
    this._zooming = true
    // 立即清空，避免缩放动画过程中标签错位重叠
    this.placements = []
    this._clearCanvas()
  }

  private _onZoomEnd(): void {
    this._zooming = false
    this._updateCanvasPosition()
    this._requestLayout()
  }

  private _onViewReset(): void {
    this._updateCanvasPosition()
    this._requestLayout()
  }

  // ------------------------------------------------------------------
  // 布局
  // ------------------------------------------------------------------

  /**
   * 屏幕空间标签布局：基于实际文本矩形的贪心碰撞避让（算法见 labelLayoutCore）
   */
  private _layout(): void {
    const map = this.map
    this.placements = []
    if (!map || !this.canvas) {
      this._clearCanvas()
      return
    }

    const size = map.getSize()
    // 视口外扩边距对应的经纬度边界（廉价粗筛，避免全量投影）
    const padNorthWest = map.containerPointToLatLng([-80, -80])
    const padSouthEast = map.containerPointToLatLng([size.x + 80, size.y + 80])
    const padBounds = L.latLngBounds(padNorthWest, padSouthEast)

    this.placements = layoutLabels({
      sources: this.sources,
      width: size.x,
      height: size.y,
      inView: (lat, lng) => padBounds.contains([lat, lng]),
      project: (lat, lng) => map.latLngToContainerPoint([lat, lng]),
      measureText: (text, font) => this._measureText(text, font),
    })
    this._draw()
  }

  // ------------------------------------------------------------------
  // 绘制
  // ------------------------------------------------------------------

  /**
   * 按当前布局重绘（平移时每帧调用：锚点重新投影 + 布局时记录的屏幕偏移）
   */
  private _draw(): void {
    const map = this.map
    const ctx = this.ctx
    if (!map || !ctx) return

    this._clearCanvas()
    if (this._zooming) return

    const size = map.getSize()
    drawPlacedLabels(
      ctx,
      this.placements,
      (lat, lng) => map.latLngToContainerPoint([lat, lng]),
      { width: size.x, height: size.y },
    )
  }

  private _clearCanvas(): void {
    const map = this.map
    const ctx = this.ctx
    if (!map || !ctx) return
    const size = map.getSize()
    ctx.clearRect(0, 0, size.x, size.y)
  }

  /**
   * Canvas 定位：与 GeoDataCanvasLabelLayer 相同的补偿方式，
   * 平移过程中 overlayPane 的 CSS 变换由本定位抵消，绘制坐标始终用容器坐标。
   */
  private _updateCanvasPosition(): void {
    if (!this.map || !this.canvas) return
    const topLeft = this.map.containerPointToLayerPoint([0, 0])
    L.DomUtil.setPosition(this.canvas, topLeft)
  }

  private _resizeCanvas(): void {
    if (!this.map || !this.canvas || !this.ctx) return
    const size = this.map.getSize()
    const pixelRatio = window.devicePixelRatio || 1
    this.canvas.width = size.x * pixelRatio
    this.canvas.height = size.y * pixelRatio
    this.canvas.style.width = `${size.x}px`
    this.canvas.style.height = `${size.y}px`
    this.ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  }

  // ------------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------------

  /**
   * 测量文本宽度（结果按 完整字体串|文本 缓存；加粗/斜体/字体族均影响宽度）
   */
  private _measureText(text: string, font: string): number {
    const key = `${font}|${text}`
    const cached = this.textWidthCache.get(key)
    if (cached !== undefined) return cached

    if (!this.measureCtx) {
      const offscreen = document.createElement('canvas')
      this.measureCtx = offscreen.getContext('2d')
    }
    if (this.measureCtx) {
      this.measureCtx.font = font
      const width = this.measureCtx.measureText(text).width
      this.textWidthCache.set(key, width)
      return width
    }
    // 极端情况下拿不到 2d 上下文，按字数粗估
    return text.length * 12 * 0.9
  }


  private _requestLayout(): void {
    if (this._layoutQueued) return
    this._layoutQueued = true
    requestAnimationFrame(() => {
      this._layoutQueued = false
      this._layout()
    })
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
