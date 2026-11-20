/**
 * 截图标注的几何 / canvas 绘制层（不依赖 React，便于单独单测）。
 *
 * 坐标一律使用「原图像素」：预览由 SVG viewBox / canvas CSS 缩放负责显示，
 * 导出时先合成整图再按裁剪框复制，避免 DPI、窗口缩放与裁剪偏移造成错位。
 */
export interface Point { x: number; y: number }
export interface Crop { x: number; y: number; w: number; h: number }
export interface SourceImage { url: string; width: number; height: number }

export type MosaicAnnotation = { kind: 'mosaic'; points: Point[]; size: number }

export type Annotation =
  | { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: 'text'; x: number; y: number; text: string; color: string; fontSize: number }
  | MosaicAnnotation

export type Tool = 'crop' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text' | 'mosaic'

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

/** 线宽 / 字号用原图像素，预览 SVG 与导出 canvas 共用同一套数值 */
export const strokeFor = (imageWidth: number) => Math.max(2, Math.round(imageWidth / 400))
export const fontFor = (imageWidth: number) => Math.max(18, Math.round(imageWidth / 45))

/**
 * 马赛克笔刷直径（原图像素）。
 * 旧值 width/70 在 1920 宽截图上只有 27px，配合 12×12 小图块后每块不到 1 个显示像素，
 * 视觉上几乎与原图一致 —— 这正是「马赛克工具没反应」的主要成因之一。
 */
export const mosaicSizeFor = (imageWidth: number) => Math.max(24, Math.round(imageWidth / 32))

export const isMosaic = (shape: Annotation): shape is MosaicAnnotation => shape.kind === 'mosaic'

export function shapeSize(shape: Annotation): number {
  if (shape.kind === 'mosaic') return shape.points.reduce((total, point, index) => {
    if (index === 0) return total
    const previous = shape.points[index - 1]
    return total + Math.hypot(point.x - previous.x, point.y - previous.y)
  }, 0)
  if (shape.kind === 'text') return shape.text.length
  if (shape.kind === 'line' || shape.kind === 'arrow') {
    return Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1)
  }
  if (shape.kind === 'rect' || shape.kind === 'ellipse') {
    return Math.hypot(shape.w, shape.h)
  }
  return 0
}

/** 单箭头头部的三角形三点；size 为箭头翼长（原图像素） */
export function arrowHead(
  x1: number, y1: number, x2: number, y2: number, size: number,
): [Point, Point, Point] {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const spread = Math.PI / 7
  return [
    { x: x2, y: y2 },
    { x: x2 - size * Math.cos(angle - spread), y: y2 - size * Math.sin(angle - spread) },
    { x: x2 - size * Math.cos(angle + spread), y: y2 - size * Math.sin(angle + spread) },
  ]
}

export function arrowPoints(
  x1: number, y1: number, x2: number, y2: number, size: number,
): string {
  return arrowHead(x1, y1, x2, y2, size).map(point => `${point.x},${point.y}`).join(' ')
}

/** 把非马赛克标注绘制到 ctx；dx/dy 为裁剪偏移 */
export function drawAnnotations(
  ctx: CanvasRenderingContext2D, annotations: Annotation[],
  dx: number, dy: number, stroke: number,
) {
  for (const item of annotations) {
    if (item.kind === 'mosaic') continue
    ctx.save()
    ctx.strokeStyle = item.color
    ctx.fillStyle = item.color
    ctx.lineWidth = stroke
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    if (item.kind === 'rect') {
      ctx.strokeRect(item.x - dx, item.y - dy, item.w, item.h)
    } else if (item.kind === 'ellipse') {
      ctx.beginPath()
      ctx.ellipse(
        item.x - dx + item.w / 2, item.y - dy + item.h / 2,
        Math.abs(item.w / 2), Math.abs(item.h / 2), 0, 0, Math.PI * 2,
      )
      ctx.stroke()
    } else if (item.kind === 'line' || item.kind === 'arrow') {
      const ax = item.x1 - dx, ay = item.y1 - dy
      const bx = item.x2 - dx, by = item.y2 - dy
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.stroke()
      if (item.kind === 'arrow') {
        const [tip, wingA, wingB] = arrowHead(ax, ay, bx, by, stroke * 5)
        ctx.beginPath()
        ctx.moveTo(tip.x, tip.y)
        ctx.lineTo(wingA.x, wingA.y)
        ctx.lineTo(wingB.x, wingB.y)
        ctx.closePath()
        ctx.fill()
      }
    } else if (item.kind === 'text') {
      ctx.font = `${item.fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
      ctx.textBaseline = 'top'
      item.text.split('\n').forEach((line, index) => {
        ctx.fillText(line, item.x - dx, item.y - dy + index * item.fontSize * 1.35)
      })
    }
    ctx.restore()
  }
}

/**
 * 马赛克小画布的边长（块数）。
 * 旧值 12 让每个色块过小；8×8 配合更大的笔刷后，缩放到窗口仍能看到明显的方块。
 */
export const TILE_SIZE = 8

/** 复用的马赛克小画布：把区域缩到 TILE_SIZE×TILE_SIZE，再关闭平滑放大回去 */
export function createMosaicTile(): HTMLCanvasElement | null {
  try {
    const tile = document.createElement('canvas')
    tile.width = TILE_SIZE
    tile.height = TILE_SIZE
    if (tile.getContext('2d')) return tile
  } catch { /* 部分 WebView 在禁用硬件加速时拿不到 2D 上下文 */ }
  return null
}

export interface MosaicPainter {
  ctx: CanvasRenderingContext2D
  source: CanvasImageSource
  sourceWidth: number
  sourceHeight: number
  /** 允许为 null：退化成实心块，绝不静默跳过整条马赛克 */
  tile: HTMLCanvasElement | null
}

/** 起笔 / 撤销 / 导出三条路径共用的兜底：即使没有可用 tile 也要留下可见涂抹 */
function paintFallbackBlock(ctx: CanvasRenderingContext2D,
                            sx: number, sy: number, sw: number, sh: number) {
  ctx.save()
  ctx.fillStyle = 'rgba(128, 128, 128, 0.72)'
  ctx.fillRect(sx, sy, sw, sh)
  ctx.restore()
}

/** 绘制一个马赛克点（增量绘制用，避免 pointermove 时全图重算） */
export function paintMosaicPoint(painter: MosaicPainter, point: Point, size: number) {
  const { ctx, source, sourceWidth, sourceHeight, tile } = painter
  const half = size / 2
  const sx = clamp(Math.round(point.x - half), 0, Math.max(0, sourceWidth - size))
  const sy = clamp(Math.round(point.y - half), 0, Math.max(0, sourceHeight - size))
  const sw = Math.min(size, sourceWidth - sx)
  const sh = Math.min(size, sourceHeight - sy)
  if (sw <= 0 || sh <= 0) return

  // 旧实现在这里 `if (!tctx) return`，且 createMosaicTile() 返回 null 时预览 / 起笔 /
  // 导出三处都直接 return，导致马赛克「点了完全没反应」且不报错。现在统一走兜底。
  const tctx = tile?.getContext('2d') ?? null
  if (!tctx || !tile) {
    paintFallbackBlock(ctx, sx, sy, sw, sh)
    return
  }
  try {
    const previous = ctx.imageSmoothingEnabled
    tctx.imageSmoothingEnabled = true // 缩小阶段做平均，避免出现随机噪点
    tctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE)
    tctx.drawImage(source, sx, sy, sw, sh, 0, 0, TILE_SIZE, TILE_SIZE)
    ctx.imageSmoothingEnabled = false // 放大阶段关插值 → 硬边方块
    ctx.drawImage(tile, 0, 0, TILE_SIZE, TILE_SIZE, sx, sy, sw, sh)
    ctx.imageSmoothingEnabled = previous
  } catch {
    // 源图解码失败 / 画布被回收：仍保证这一笔有可见反馈
    paintFallbackBlock(ctx, sx, sy, sw, sh)
  }
}

/**
 * 在两个采样点之间补点，快速拖动也不会留下断续的空白。
 * 返回新增的点（含终点），调用方要把它们一并记进 annotation，导出重放才与预览一致。
 */
export function paintMosaicSegment(painter: MosaicPainter, from: Point,
                                   to: Point, size: number): Point[] {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  const steps = Math.max(1, Math.ceil(distance / (size * 0.4)))
  const points: Point[] = []
  for (let index = 1; index <= steps; index += 1) {
    const point = {
      x: from.x + (to.x - from.x) * index / steps,
      y: from.y + (to.y - from.y) * index / steps,
    }
    points.push(point)
    paintMosaicPoint(painter, point, size)
  }
  return points
}

/** 全量重放马赛克笔画（撤销 / 清空 / 切换图片 / 导出时用） */
export function drawMosaicStrokes(
  painter: MosaicPainter, strokes: MosaicAnnotation[],
) {
  for (const stroke of strokes) {
    for (const point of stroke.points) paintMosaicPoint(painter, point, stroke.size)
  }
}

/** 原图 → 马赛克 → 其它标注，合成到整图画布；用完由调用方释放 width/height */
export function composeFullImage(
  source: CanvasImageSource, width: number, height: number,
  annotations: Annotation[],
): HTMLCanvasElement | null {
  const full = document.createElement('canvas')
  full.width = width
  full.height = height
  const ctx = full.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, width, height)
  // 不再 `if (tile)` 跳过：tile 不可用时 paintMosaicPoint 会画退化色块
  drawMosaicStrokes(
    { ctx, source, sourceWidth: width, sourceHeight: height, tile: createMosaicTile() },
    annotations.filter(isMosaic),
  )
  drawAnnotations(ctx, annotations, 0, 0, strokeFor(width))
  return full
}

/** SVG 预览层：一个标注对应一个（组）SVG 图元，几何与 canvas 导出共用 arrowHead */
export { arrowHead as previewArrowHead }
