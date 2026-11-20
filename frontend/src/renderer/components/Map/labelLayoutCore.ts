/**
 * 标签布局与绘制的核心算法（与地图引擎无关的纯函数）。
 *
 * 2D（Leaflet）与 3D（Cesium）共用：
 * - 2D：`LabelLayoutManager`（Leaflet Layer，单 Canvas 挂在 overlayPane）
 * - 3D：`components/Map/cesium/CesiumLabelOverlay`（单 Canvas 覆盖在地图容器上）
 *
 * 两端只负责提供「经纬度 → 屏幕像素」的投影与文本测量，其余（视口裁剪、真实文本矩形、
 * 优先级排序、8 方位贪心避让、空间哈希碰撞、绘制）全部在这里 —— 保证两边标签密度、
 * 避让行为与观感一致，也避免同一套算法在两处各写一份而分叉。
 *
 * 算法要点：
 * 1. 视口粗筛（可选 `inView` 廉价经纬度过滤）→ 投影到屏幕；
 * 2. 用 Canvas measureText 得到文本实际尺寸（按 字体串|文本 缓存），构造标签矩形；
 * 3. 按 优先级降序 → 屏幕 y → x → 源 → id 排序（结果确定、可复现）；
 * 4. 贪心放置：依次尝试 8 个避让方位，第一个"完整在视口内且不与已放置矩形相撞"的胜出，
 *    全失败则本次不显示该标签（靠排序保证高优先级先占好位置）。
 */

/** 标签候选（由各图层注册） */
export interface LabelCandidateBase {
  /** 来源图层内唯一 ID */
  id: string
  /** 纬度（渲染坐标系，与地图一致） */
  lat: number
  /** 经度（渲染坐标系，与地图一致） */
  lng: number
  /** 标签文本 */
  text: string
  /** 字号（px），默认 12 */
  fontSize?: number
  /** 字体族（CSS font-family 栈），默认 sans-serif */
  fontFamily?: string
  bold?: boolean
  italic?: boolean
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

/** 已放置标签（布局结果） */
export interface PlacedLabel {
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

/** 拼接 Canvas font 字符串（绘制与测量必须用同一串，否则布局宽度与实际渲染不符） */
export function buildFontString(
  fontSize: number, fontFamily?: string, bold?: boolean, italic?: boolean,
): string {
  const style = italic ? 'italic ' : ''
  const weight = bold ? '700' : '500'
  const family = fontFamily && fontFamily.trim() ? fontFamily : 'sans-serif'
  return `${style}${weight} ${fontSize}px ${family}`
}

interface Rect { x1: number; y1: number; x2: number; y2: number }

export const DEFAULT_FONT_SIZE = 12
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

export interface LayoutParams {
  /** 各标签源注册的候选（key = sourceId） */
  sources: Iterable<[string, LabelCandidateBase[]]>
  /** 视口尺寸（CSS 像素） */
  width: number
  height: number
  /** 经纬度 → 容器像素坐标；不可见（相机背面等）返回 null */
  project: (lat: number, lng: number) => { x: number; y: number } | null
  /** 文本宽度测量（实现方负责缓存） */
  measureText: (text: string, font: string) => number
  /** 可选的廉价视口粗筛（经纬度级别），用于跳过明显不在视口内的候选，避免全量投影 */
  inView?: (lat: number, lng: number) => boolean
}

/** 屏幕空间标签布局：基于实际文本矩形的贪心碰撞避让 */
export function layoutLabels(params: LayoutParams): PlacedLabel[] {
  const { sources, width, height, project, measureText, inView } = params

  interface LayoutItem {
    source: string
    candidate: LabelCandidateBase
    ax: number
    ay: number
    boxW: number
    boxH: number
    fontSize: number
  }

  const items: LayoutItem[] = []
  for (const [source, candidates] of sources) {
    for (const candidate of candidates) {
      if (!candidate.text) continue
      if (inView && !inView(candidate.lat, candidate.lng)) continue
      const point = project(candidate.lat, candidate.lng)
      if (!point) continue
      if (point.x < -VIEW_MARGIN || point.x > width + VIEW_MARGIN
        || point.y < -VIEW_MARGIN || point.y > height + VIEW_MARGIN) continue

      const fontSize = candidate.fontSize || DEFAULT_FONT_SIZE
      const fontString = buildFontString(
        fontSize, candidate.fontFamily, candidate.bold, candidate.italic)
      const textWidth = measureText(candidate.text, fontString)
      const textHeight = fontSize * 1.3
      items.push({
        source,
        candidate,
        ax: point.x,
        ay: point.y,
        boxW: textWidth + PAD_X * 2,
        boxH: textHeight + PAD_Y * 2,
        fontSize,
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
        if (rects) rects.push(rect)
        else occupied.set(key, [rect])
      }
    }
  }

  const rectInView = (rect: Rect): boolean =>
    rect.x1 >= -4 && rect.y1 >= -4 && rect.x2 <= width + 4 && rect.y2 <= height + 4

  const placements: PlacedLabel[] = []

  for (const item of items) {
    const { ax, ay, boxW, boxH } = item

    // 8 个候选避让方位（标签中心相对锚点的偏移），优先靠近元素的正上方
    const offsetCandidates: Array<[number, number]> = [
      [0, -(MARKER_CLEAR + boxH / 2)],                   // 正北（上）
      [boxW / 2 + 8, -(MARKER_CLEAR + boxH / 2)],        // 东北（右上）
      [-(boxW / 2 + 8), -(MARKER_CLEAR + boxH / 2)],     // 西北（左上）
      [MARKER_CLEAR + boxW / 2, 0],                      // 正东（右）
      [-(MARKER_CLEAR + boxW / 2), 0],                   // 正西（左）
      [boxW / 2 + 8, MARKER_CLEAR + boxH / 2],           // 东南（右下）
      [-(boxW / 2 + 8), MARKER_CLEAR + boxH / 2],        // 西南（左下）
      [0, MARKER_CLEAR + boxH / 2],                      // 正南（下）
    ]

    for (const [ox, oy] of offsetCandidates) {
      const cx = ax + ox
      const cy = ay + oy
      const rect: Rect = {
        x1: cx - boxW / 2,
        y1: cy - boxH / 2,
        x2: cx + boxW / 2,
        y2: cy + boxH / 2,
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
        color: item.candidate.color || '#000000',
      })
      break
    }
  }

  return placements
}

/**
 * 按布局结果绘制到一张 Canvas 上（单画布批量 fillText，零对象创建销毁）。
 * 调用方负责先 `clearRect` 并根据自身坐标系设置 transform。
 */
export function drawPlacedLabels(
  ctx: CanvasRenderingContext2D,
  placements: PlacedLabel[],
  project: (lat: number, lng: number) => { x: number; y: number } | null,
  size: { width: number; height: number },
): void {
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (const p of placements) {
    const anchor = project(p.lat, p.lng)
    if (!anchor) continue
    const x = anchor.x + p.dx
    const y = anchor.y + p.dy

    // 视口外不绘制（文本可能较长，水平方向留足裁剪余量）
    if (x < -260 || x > size.width + 260 || y < -40 || y > size.height + 40) continue

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
