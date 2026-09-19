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
 */
import L from 'leaflet'

/**
 * 标签候选（由各图层注册）
 */
export interface LabelCandidate {
  /** 来源图层内唯一 ID */
  id: string
  /** 纬度（渲染坐标，与地图一致） */
  lat: number
  /** 经度（渲染坐标，与地图一致） */
  lng: number
  /** 标签文本 */
  text: string
  /** 字号（px），默认 12 */
  fontSize?: number
  /** 字体族（CSS font-family 栈），默认 sans-serif */
  fontFamily?: string
  /** 字体效果：加粗 */
  bold?: boolean
  /** 字体效果：斜体 */
  italic?: boolean
  /** 字体效果：阴影 */
  shadow?: boolean
  /** 字体背景：none=无 / halo=光晕（文字描边）/ box=框形（圆角矩形底色） */
  background?: 'none' | 'halo' | 'box'
  /** 字体背景颜色（background 为 halo/box 时生效） */
  backgroundColor?: string
  /** 字体颜色，默认 #000000 */
  color?: string
  /** 优先级，数值越大越优先放置（如选中/高亮要素） */
  priority?: number
}

/**
 * 已放置标签（内部）
 */
interface PlacedLabel {
  lat: number
  lng: number
  /** 布局时标签中心相对锚点的屏幕偏移（px） */
  dx: number
  dy: number
  text: string
  fontSize: number
  fontFamily: string
  bold: boolean
  italic: boolean
  shadow: boolean
  background: 'none' | 'halo' | 'box'
  backgroundColor: string
  /** 布局时文本外框尺寸（含内边距），框形背景直接按此矩形绘制 */
  boxW: number
  boxH: number
  color: string
}

/**
 * 拼接 Canvas font 字符串（绘制与测量必须用同一串，否则布局宽度与实际渲染不符）
 */
function buildFontString(fontSize: number, fontFamily?: string, bold?: boolean, italic?: boolean): string {
  const style = italic ? 'italic ' : ''
  const weight = bold ? '700' : '500'
  const family = fontFamily && fontFamily.trim() ? fontFamily : 'sans-serif'
  return `${style}${weight} ${fontSize}px ${family}`
}

interface Rect {
  x1: number
  y1: number
  x2: number
  y2: number
}

const DEFAULT_FONT_SIZE = 12
/** 文本水平内边距（碰撞矩形比文字宽出的部分） */
const PAD_X = 6
/** 文本垂直内边距 */
const PAD_Y = 3
/** 相邻标签矩形之间的最小间距（px） */
const GAP = 5
/** 标签与元素锚点的避让距离（扇区视觉半径约 16px） */
const MARKER_CLEAR = 18
/** 碰撞空间哈希网格尺寸（px） */
const CELL = 24
/** 视口外预布局边距（px），边缘标签提前参与布局 */
const VIEW_MARGIN = 80

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
   * 屏幕空间标签布局：基于实际文本矩形的贪心碰撞避让
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
    const padNorthWest = map.containerPointToLatLng([-VIEW_MARGIN, -VIEW_MARGIN])
    const padSouthEast = map.containerPointToLatLng([size.x + VIEW_MARGIN, size.y + VIEW_MARGIN])
    const padBounds = L.latLngBounds(padNorthWest, padSouthEast)

    interface LayoutItem {
      source: string
      candidate: LabelCandidate
      ax: number
      ay: number
      boxW: number
      boxH: number
      fontSize: number
    }

    const items: LayoutItem[] = []
    for (const [source, candidates] of this.sources) {
      for (const candidate of candidates) {
        if (!candidate.text) continue
        if (!padBounds.contains([candidate.lat, candidate.lng])) continue

        const point = map.latLngToContainerPoint([candidate.lat, candidate.lng])
        const fontSize = candidate.fontSize || DEFAULT_FONT_SIZE
        const fontFamily = candidate.fontFamily
        const fontString = buildFontString(fontSize, fontFamily, candidate.bold, candidate.italic)
        const textWidth = this._measureText(candidate.text, fontString)
        const textHeight = fontSize * 1.3
        items.push({
          source,
          candidate,
          ax: point.x,
          ay: point.y,
          boxW: textWidth + PAD_X * 2,
          boxH: textHeight + PAD_Y * 2,
          fontSize
        })
      }
    }

    // 排序：优先级高者先放；同优先级按屏幕位置从上到下、从左到右（行内紧凑、结果确定）
    items.sort((a, b) => {
      const pa = a.candidate.priority || 0
      const pb = b.candidate.priority || 0
      if (pb !== pa) return pb - pa
      if (a.ay !== b.ay) return a.ay - b.ay
      if (a.ax !== b.ax) return a.ax - b.ax
      if (a.source !== b.source) return a.source < b.source ? -1 : 1
      return a.candidate.id < b.candidate.id ? -1 : 1
    })

    // 空间哈希网格：cellKey -> 占用矩形列表
    const occupied = new Map<string, Rect[]>()

    const rectIsFree = (rect: Rect): boolean => {
      const gx1 = Math.floor((rect.x1 - GAP) / CELL)
      const gx2 = Math.floor((rect.x2 + GAP) / CELL)
      const gy1 = Math.floor((rect.y1 - GAP) / CELL)
      const gy2 = Math.floor((rect.y2 + GAP) / CELL)
      for (let gx = gx1; gx <= gx2; gx++) {
        for (let gy = gy1; gy <= gy2; gy++) {
          const rects = occupied.get(`${gx},${gy}`)
          if (!rects) continue
          for (const r of rects) {
            if (
              rect.x2 + GAP > r.x1 &&
              rect.x1 - GAP < r.x2 &&
              rect.y2 + GAP > r.y1 &&
              rect.y1 - GAP < r.y2
            ) {
              return false
            }
          }
        }
      }
      return true
    }

    const markRect = (rect: Rect): void => {
      const gx1 = Math.floor(rect.x1 / CELL)
      const gx2 = Math.floor(rect.x2 / CELL)
      const gy1 = Math.floor(rect.y1 / CELL)
      const gy2 = Math.floor(rect.y2 / CELL)
      for (let gx = gx1; gx <= gx2; gx++) {
        for (let gy = gy1; gy <= gy2; gy++) {
          const key = `${gx},${gy}`
          const rects = occupied.get(key)
          if (rects) {
            rects.push(rect)
          } else {
            occupied.set(key, [rect])
          }
        }
      }
    }

    const rectInView = (rect: Rect): boolean =>
      rect.x1 >= -4 && rect.y1 >= -4 && rect.x2 <= size.x + 4 && rect.y2 <= size.y + 4

    const placements: PlacedLabel[] = []

    for (const item of items) {
      const { ax, ay, boxW, boxH } = item

      // 8 个候选避让方位（标签中心相对锚点的偏移），优先靠近元素的正上方
      const offsetCandidates: Array<[number, number]> = [
        [0, -(MARKER_CLEAR + boxH / 2)],                  // 正北（上）
        [boxW / 2 + 8, -(MARKER_CLEAR + boxH / 2)],       // 东北（右上）
        [-(boxW / 2 + 8), -(MARKER_CLEAR + boxH / 2)],    // 西北（左上）
        [MARKER_CLEAR + boxW / 2, 0],                     // 正东（右）
        [-(MARKER_CLEAR + boxW / 2), 0],                  // 正西（左）
        [boxW / 2 + 8, MARKER_CLEAR + boxH / 2],          // 东南（右下）
        [-(boxW / 2 + 8), MARKER_CLEAR + boxH / 2],       // 西南（左下）
        [0, MARKER_CLEAR + boxH / 2]                      // 正南（下）
      ]

      for (const [ox, oy] of offsetCandidates) {
        const cx = ax + ox
        const cy = ay + oy
        const rect: Rect = {
          x1: cx - boxW / 2,
          y1: cy - boxH / 2,
          x2: cx + boxW / 2,
          y2: cy + boxH / 2
        }

        if (!rectInView(rect)) continue
        if (!rectIsFree(rect)) continue

        markRect(rect)
        placements.push({
          lat: item.candidate.lat,
          lng: item.candidate.lng,
          dx: cx - ax,
          dy: cy - ay,
          text: item.candidate.text,
          fontSize: item.fontSize,
          fontFamily: item.candidate.fontFamily || 'sans-serif',
          bold: item.candidate.bold ?? false,
          italic: item.candidate.italic ?? false,
          shadow: item.candidate.shadow ?? false,
          background: item.candidate.background || 'none',
          backgroundColor: item.candidate.backgroundColor || '#ffffff',
          boxW: item.boxW,
          boxH: item.boxH,
          color: item.candidate.color || '#000000'
        })
        break
      }
    }

    this.placements = placements
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
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    for (const p of this.placements) {
      const anchor = map.latLngToContainerPoint([p.lat, p.lng])
      const x = anchor.x + p.dx
      const y = anchor.y + p.dy

      // 视口外不绘制（文本可能较长，水平方向留足裁剪余量）
      if (x < -260 || x > size.x + 260 || y < -40 || y > size.y + 40) continue

      ctx.font = buildFontString(p.fontSize, p.fontFamily, p.bold, p.italic)
      ctx.fillStyle = p.color
      // 框形背景：按布局碰撞矩形绘制圆角底色（矩形已含文字内边距，无阴影参与）
      if (p.background === 'box') {
        ctx.fillStyle = p.backgroundColor
        const bx = x - p.boxW / 2
        const by = y - p.boxH / 2
        ctx.beginPath()
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(bx, by, p.boxW, p.boxH, 3)
        } else {
          ctx.rect(bx, by, p.boxW, p.boxH)
        }
        ctx.fill()
        ctx.fillStyle = p.color
      }
      // 光晕：以背景色粗描边文字（圆角衔接），再叠文字主体
      if (p.background === 'halo') {
        ctx.strokeStyle = p.backgroundColor
        ctx.lineWidth = Math.max(2, p.fontSize / 5)
        ctx.lineJoin = 'round'
        ctx.strokeText(p.text, x, y)
      }
      if (p.shadow) {
        // 柔和深色投影：提升浅色文字在浅色底图上的可读性，且不侵入文字主体
        ctx.shadowColor = 'rgba(0, 0, 0, 0.55)'
        ctx.shadowBlur = 3
        ctx.shadowOffsetX = 1
        ctx.shadowOffsetY = 1
      }
      ctx.fillText(p.text, x, y)
      if (p.shadow) {
        ctx.shadowColor = 'transparent'
        ctx.shadowBlur = 0
        ctx.shadowOffsetX = 0
        ctx.shadowOffsetY = 0
      }
    }
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
