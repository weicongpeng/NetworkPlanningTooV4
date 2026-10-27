/**
 * 值热力面渲染：边界掩膜、颜色映射与栅格生成
 *
 * 与 leaflet.heat 的密度热力图本质区别：
 * - 密度热力图：颜色由"点的叠加强度"决定 → 密集区饱和顶到色带末端，稀疏区几乎透明
 * - 值热力面：颜色由"该处插值出的字段值"决定 → 稀疏区按其自身值着色，整条色带都被使用
 *
 * 插值场的构建见 heatField.ts；渲染分两遍：先插值出每个像元的值与不透明度，
 * 再按固定映射（值→色带位置，由调用方给定，与视口无关）着色。
 */
import { applyContrast, type HeatPoint } from './heatmap'
import {
  DEG2RAD,
  EARTH_RADIUS,
  FADE_OUT_FACTOR,
  buildHeatField,
  projectToMercator,
  type HeatField,
  type HeatHit,
} from './heatField'
import type { HeatmapLegendMethod } from '../components/Map/LabelSettingsModal'

// 从本模块转出，便于渲染层与图例共用同一对比度实现（测试亦从 heatSurface 引入）
export { applyContrast }

/**
 * 构造“值 → 色带位置(0~1)”映射表。
 * 基于**固定的分位基准**（而不是当前栅格像元），因此同一数值永远对应同一颜色，
 * 缩放、平移不会改变颜色。
 *
 * - valueRange（等效范围）：值域线性对应，色带按数值等分
 * - cellCount（等效细胞计数）：按分位映射，使每段色带承载等量渲染面积——
 *   重尾数据（流量类）用线性映射会把绝大多数像元压在色带最低端，必须用分位才能
 *   让整条色带铺开。此处为**纯分位**（不混线性），否则“每级等效占比”不成立。
 *   分位基准优先取 reference（渲染场分布，见 probeFieldDistribution）：
 *   插值会把邻域值平均掉，用原始采样点分布定分位时，渲染出来的像元只覆盖色带中段，
 *   图例设了几级就只有中间一两级显色
 */
export function buildValueMapper(
  points: HeatPoint[],
  min: number,
  max: number,
  method: HeatmapLegendMethod = 'cellCount',
  contrast = 1,
  bins = 512,
  reference?: Float64Array | null
): (v: number) => number {
  const span = max - min
  const linear = (v: number) => {
    if (!(span > 0)) return 0.5
    const t = (v - min) / span
    return t <= 0 ? 0 : t >= 1 ? 1 : t
  }
  const finish = (raw: (v: number) => number) =>
    contrast === 1 ? raw : (v: number) => applyContrast(raw(v), contrast)

  if (method !== 'cellCount' || points.length < 2 || !(span > 0)) return finish(linear)

  const sorted = reference && reference.length >= 2
    ? reference
    : Float64Array.from(points, p => p.weight).sort()
  const n = sorted.length
  const lut = new Float32Array(bins)
  for (let i = 0; i < bins; i++) {
    const value = min + span * (i / (bins - 1))
    // 取“小于 value 的个数”与“小于等于 value 的个数”的中点位置作分位，
    // 使最小值不会被压到 0、最大值不会被压到 1（重复值也不会跳变）
    const below = lowerBound(sorted, value)
    const above = upperBound(sorted, value)
    lut[i] = (below + above) / 2 / n
  }
  const quantile = (v: number) => {
    if (!(span > 0)) return lut[0]
    const pos = ((v - min) / span) * (bins - 1)
    if (pos <= 0) return lut[0]
    if (pos >= bins - 1) return lut[bins - 1]
    const i = pos | 0
    // 相邻档线性插值：消除分位分档的量化台阶，颜色过渡更平滑
    return lut[i] + (lut[i + 1] - lut[i]) * (pos - i)
  }
  return finish(quantile)
}

/**
 * 探测**插值场**的取值分布（颜色分级标定用）。
 *
 * 在桶代表点上采样：桶是等边长网格，每个代表点代表相等的地面面积，
 * 故等权采样即"按渲染面积"加权——点密度极不均匀时（城区密、郊区疏）
 * 不会被密集区把分布带偏。与视口无关（只取决于点集与半径），缩放平移不改变分级。
 *
 * 代表点数超过 limit 时等距跨步抽样：抽样只影响分布的估计精度，不影响渲染。
 */
export function probeFieldDistribution(field: HeatField, limit = FIELD_PROBE_LIMIT): Float64Array {
  // 优先按**场的范围做均匀面积网格**采样（可见 alpha>0 处）：渲染像元的取值分布
  // 才是分级标定的正确基准——桶代表点只覆盖"有数据的桶"，桶之间的填充区
  // （粗场/趋势兜底）的值不在其中，异构密度下面积占比会被带偏（个别色带段面积≈0）
  if (field.bounds) {
    const { minX, minY, maxX, maxY } = field.bounds
    const n = Math.max(2, Math.floor(Math.sqrt(limit)))
    const out: number[] = []
    const hit: HeatHit = { value: 0, distance: 0 }
    for (let iy = 0; iy < n; iy++) {
      const y = minY + (maxY - minY) * (iy + 0.5) / n
      for (let ix = 0; ix < n; ix++) {
        const x = minX + (maxX - minX) * (ix + 0.5) / n
        if (!field.sample(x, y, hit) || !(hit.alpha !== undefined && hit.alpha > 0)) continue
        out.push(hit.value)
      }
    }
    return Float64Array.from(out)
  }
  const centroids = field.centroids
  if (!centroids || centroids.length < 2) return new Float64Array(0)
  const count = centroids.length >> 1
  const stride = count > limit ? count / limit : 1
  const size = stride === 1 ? count : Math.ceil(count / stride)
  const out = new Float64Array(size)
  const hit: HeatHit = { value: 0, distance: 0 }
  let w = 0
  for (let k = 0; k < size; k++) {
    const i = stride === 1 ? k : Math.floor(k * stride)
    if (!field.sample(centroids[i * 2], centroids[i * 2 + 1], hit)) continue
    out[w++] = hit.value
  }
  return w === size ? out : out.subarray(0, w)
}

/** 第一个 >= value 的下标 */
function lowerBound(sorted: Float64Array, value: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** 第一个 > value 的下标 */
function upperBound(sorted: Float64Array, value: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 场分布探测点上限：分布估计的精度上界即可（分级只用到少数几个分位值），
 * 取 8192 时单次探测约 1 万个桶扫描，几十毫秒内完成
 */
export const FIELD_PROBE_LIMIT = 8192

/**
 * 分级着色：把连续色带位置 t 量化到 n 级（0.3, n=5 → round(0.3×4)/4=0.25）。
 * 开启后地图按图例 N 级离散着色（等值线感，参考 MapInfo 网格分级渲染），
 * 不再是连续渐变。n<2 时原样返回（关闭）。
 */
export function quantizeLevel(t: number, n: number): number {
  if (!(n >= 2)) return t
  const q = Math.round(t * (n - 1)) / (n - 1)
  return q <= 0 ? 0 : q >= 1 ? 1 : q
}

/** 集中度 gamma 的允许范围（防极端值使颜色塌成单点/单色） */
export const CONCENTRATION_MIN = 0.125
export const CONCENTRATION_MAX = 8
/**
 * 高端分段的下支点：该位置及以下的配色**完全不动**，
 * 只有 (PIVOT,1] 的高端颜色参与集中度调整（不对所有配色同步平移）
 */
const CONCENTRATION_PIVOT = 0.5

/**
 * 高值集中度：**仅对高端分段**做幂曲线，把最高级颜色留给真正 100% 的点位突出渲染。
 *
 * - t ≤ PIVOT：t' = t（中低配色与面积完全不变）；
 * - t > PIVOT：u=(t−PIVOT)/(1−PIVOT)，t' = PIVOT+(1−PIVOT)·u^gamma。
 *   gamma>1：把接近但未到顶的值向下压，顶端色（100%）只保留给真正近峰值的点
 *   → 真峰与周围拉开、突出；t=1 恒为 1（顶点不丢）。
 *   gamma<1：高端色略微放宽；gamma=1：不变。
 * 严格单调、[0,1]→[0,1]，只重新分配高端颜色面积、不改变空间插值。
 */
export function concentrateLevel(t: number, gamma: number): number {
  if (!(t > 0)) return 0
  if (t >= 1) return 1
  if (t <= CONCENTRATION_PIVOT) return t
  let g = Number.isFinite(gamma) ? gamma : 1
  g = g < CONCENTRATION_MIN ? CONCENTRATION_MIN : g > CONCENTRATION_MAX ? CONCENTRATION_MAX : g
  if (g === 1) return t
  const u = (t - CONCENTRATION_PIVOT) / (1 - CONCENTRATION_PIVOT)
  return CONCENTRATION_PIVOT + (1 - CONCENTRATION_PIVOT) * Math.pow(u, g)
}

/**
 * 软分级：在硬分级值与原始连续值之间按 softness 混合。
 *
 * t_out = q + (t−q)×softness，q = quantizeLevel(t,n)：
 * - softness=0：硬分级（等值区域，边界=等值线，MapInfo 式）
 * - softness=1：完全连续（等同不分级）
 * - 中间：色块内部（远离级别边界时 t−q≈0）仍为纯色，仅边界窄带内软过渡
 *   → 既保留分级的清晰区域与"红区面积由断点控制"，边界又不生硬。
 * n<2 时原样返回。
 */
export function softQuantizeLevel(t: number, n: number, softness: number): number {
  if (!(n >= 2)) return t
  const s = softness <= 0 ? 0 : softness >= 1 ? 1 : softness
  const q = quantizeLevel(t, n)
  const out = q + (t - q) * s
  return out <= 0 ? 0 : out >= 1 ? 1 : out
}

/** 值热力面渲染参数 */
export interface HeatSurfaceParams {
  points: HeatPoint[]
  /** 值域下限（映射到色带低端） */
  min: number
  /** 值域上限（映射到色带高端） */
  max: number
  /** 色带查找表（RGBA，长度 256*4） */
  lut: Uint8ClampedArray
  /** 全局覆盖半径（米，按当前缩放由屏幕像素换算）：桶未带半径时用它，半径内不透明向外渐隐 */
  radius: number
  /**
   * 逐点覆盖半径（米，与 points 对齐）：稀疏区放大补洞，桶内取最大值；
   * 不传时所有桶使用全局 radius
   */
  pointRadii?: Float64Array
  bounds: { west: number; south: number; east: number; north: number }
  width: number
  height: number
  /** 半透明度 0~1（对插值层整体乘算 alpha，默认 1=完全不透明） */
  opacity?: number
  /**
   * 值 → 色带位置(0~1) 的固定映射（由 buildValueMapper 预先算好）。
   * 传入后颜色只取决于数值，与视口无关；不传则按值域线性映射
   */
  mapValue?: (value: number) => number
  /** 边界裁剪多边形（MultiPolygon 形式 [lng,lat] GCJ02）；非空时仅范围内着色 */
  boundary?: HeatBoundary | null
  /**
   * 已构建的插值场（与 points/radius/pointRadii 对应）。
   * 传入后不再重复建桶：颜色分级标定已经建过一次，且用同一个场能保证
   * "标定用的分布"与"实际渲染的像元"严格同源。
   * 细节增强已内建于场本身（整体趋势场 ↔ 细节场凸组合，见 heatField.buildHeatField）
   */
  field?: HeatField | null
}

/** 边界多边形：多边形 → 环 → 顶点 [lng,lat]（MultiPolygon 形式，支持多面与洞） */
export type HeatBoundary = number[][][][]

/** 从 GeoJSON 要素集提取边界多边形（Polygon / MultiPolygon） */
export function collectBoundaryPolygons(geojson: unknown): HeatBoundary | null {
  const features = (geojson as { features?: unknown[] })?.features
  if (!Array.isArray(features)) return null
  const polygons: number[][][][] = []
  for (const feature of features) {
    const geometry = (feature as { geometry?: { type?: string; coordinates?: unknown } })?.geometry
    if (geometry?.type === 'Polygon') polygons.push(geometry.coordinates as number[][][])
    else if (geometry?.type === 'MultiPolygon') polygons.push(...(geometry.coordinates as number[][][][]))
  }
  return polygons.length > 0 ? polygons : null
}

/**
 * 从地理化数据行提取边界多边形（每行 path 为 [[lat,lng],...]，后端已转 GCJ02）
 */
export function collectGeoDataPolygons(rows: unknown): HeatBoundary | null {
  const payload = (rows as { data?: unknown })?.data ?? rows
  if (!Array.isArray(payload)) return null
  const polygons: number[][][][] = []
  for (const row of payload) {
    const path = (row as { path?: unknown })?.path
    if (!Array.isArray(path) || path.length < 3) continue
    const ring: number[][] = []
    for (const point of path) {
      if (!Array.isArray(point) || point.length < 2) continue
      const lat = Number(point[0])
      const lng = Number(point[1])
      if (Number.isFinite(lat) && Number.isFinite(lng)) ring.push([lng, lat])
    }
    if (ring.length >= 3) polygons.push([ring])
  }
  return polygons.length > 0 ? polygons : null
}

/**
 * 点（lng/lat 度）是否在边界集合内：对所有外环/洞环做射线穿越奇偶判定，
 * 与掩膜 canvas 的 fill('evenodd') 语义一致（天然支持多面与孔洞）。
 * 纯几何函数，不依赖 canvas（jsdom 无 canvas 时仍可判定/测试）。
 */
export function pointInHeatBoundary(lng: number, lat: number, boundary: HeatBoundary): boolean {
  let inside = false
  for (const polygon of boundary) {
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1]
        const xj = ring[j][0], yj = ring[j][1]
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
          inside = !inside
        }
      }
    }
  }
  return inside
}

/**
 * 过滤出落在裁剪边界内的采样点及其逐点半径（索引对齐）。
 *
 * **这是裁剪变暗修复的关键**：插值场必须只由边界内的点构建——
 * 边界外点的核值/覆盖度会越过边界污染内像素（外部值偏低=暗，污染带宽=核半径，
 * 几何掩膜只切外形、切不掉这种颜色污染）。
 */
export function filterPointsToBoundary(
  points: HeatPoint[],
  pointRadii: Float64Array | undefined,
  boundary: HeatBoundary
): { points: HeatPoint[]; pointRadii: Float64Array | undefined } {
  const keep: number[] = []
  for (let i = 0; i < points.length; i++) {
    if (pointInHeatBoundary(points[i].lng, points[i].lat, boundary)) keep.push(i)
  }
  return {
    points: keep.map(i => points[i]),
    pointRadii: pointRadii ? Float64Array.from(keep, i => pointRadii[i]) : undefined,
  }
}

/**
 * 将边界多边形栅格化为覆盖掩膜（255=范围内，0=范围外，边缘抗锯齿保留中间值）。
 * 用 canvas 奇偶填充一次成型，天然支持多个面与孔洞
 */
export function buildBoundaryMask(
  boundary: HeatBoundary,
  bounds: { west: number; south: number; east: number; north: number },
  width: number,
  height: number
): Uint8Array {
  const mask = new Uint8Array(width * height)
  if (boundary.length === 0) return mask

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return mask

  const x0 = bounds.west * DEG2RAD * EARTH_RADIUS
  const x1 = bounds.east * DEG2RAD * EARTH_RADIUS
  const y0 = projectToMercator(bounds.north, 0).y
  const y1 = projectToMercator(bounds.south, 0).y
  const sx = x1 === x0 ? 0 : width / (x1 - x0)
  const sy = y1 === y0 ? 0 : height / (y1 - y0)

  ctx.fillStyle = '#fff'
  ctx.beginPath()
  for (const polygon of boundary) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i++) {
        const px = (ring[i][0] * DEG2RAD * EARTH_RADIUS - x0) * sx
        const py = (projectToMercator(ring[i][1], 0).y - y0) * sy
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
    }
  }
  ctx.fill('evenodd')

  const data = ctx.getImageData(0, 0, width, height).data
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4 + 3]
  }
  return mask
}

/** 按字段值插值渲染热力面，返回可直接叠加到地图的 canvas */
export function renderHeatSurface(params: HeatSurfaceParams): HTMLCanvasElement | null {
  const field = params.field ?? buildHeatField(params.points, params.radius, params.pointRadii)
  if (!field) return null

  const canvas = document.createElement('canvas')
  canvas.width = params.width
  canvas.height = params.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const image = ctx.createImageData(params.width, params.height)
  const mask = params.boundary?.length
    ? buildBoundaryMask(params.boundary, params.bounds, params.width, params.height)
    : null
  // mask 已在 sampleGrid 烘焙进 alpha（边界内不透明、仅 1px AA 软边），
  // 无需事后再乘掩膜（二次相乘会把抗锯齿边缘压暗）
  paintSurface(image.data, params, field, mask)
  ctx.putImageData(image, 0, 0)
  return canvas
}

/** 逐像素两遍着色：先插值出值与不透明度，再按颜色分布映射到色带（细节增强已内建于场） */
function paintSurface(data: Uint8ClampedArray, params: HeatSurfaceParams, field: HeatField, mask: Uint8Array | null): void {
  const total = params.width * params.height
  const values = new Float32Array(total)
  const alphas = new Uint8Array(total)
  sampleGrid(values, alphas, params, field, mask)
  const toColorT = params.mapValue ?? buildLinearMapper(params.min, params.max)
  const opacity = params.opacity === undefined ? 1 : params.opacity <= 0 ? 0 : params.opacity >= 1 ? 1 : params.opacity
  colorize(data, values, alphas, toColorT, params.lut, opacity)
}

/** 第一遍：逐像元 IDW 插值，写入值与覆盖不透明度（有边界掩膜时仅范围内参与） */
function sampleGrid(values: Float32Array, alphas: Uint8Array, params: HeatSurfaceParams, field: HeatField, mask: Uint8Array | null): void {
  const { width, height, bounds } = params
  const x0 = bounds.west * DEG2RAD * EARTH_RADIUS
  const x1 = bounds.east * DEG2RAD * EARTH_RADIUS
  const y0 = projectToMercator(bounds.north, 0).y
  const y1 = projectToMercator(bounds.south, 0).y
  const hit: HeatHit = { value: 0, distance: 0 }

  let i = 0
  for (let py = 0; py < height; py++) {
    const y = y0 + (y1 - y0) * ((py + 0.5) / height)
    for (let px = 0; px < width; px++, i++) {
      if (mask && !mask[i]) continue
      const x = x0 + (x1 - x0) * ((px + 0.5) / width)
      if (!field.sample(x, y, hit)) continue
      values[i] = hit.value
      if (mask) {
        // **有裁剪边界：覆盖度直接由掩膜定义**——边界内 = 255（完全不透明），
        // 仅掩膜自身 1px 抗锯齿条带保留半透明。
        // 不能再用 hit.alpha：边界外桶被过滤后，区域覆盖场的模糊会把边界内 ~2 格
        // alpha 拉低（一条数格宽的半透明带，底图透上来显暗，即用户实测问题）。
        // sample 失败（真正无数据的内部空洞）时上面已 continue，alpha 仍为 0
        alphas[i] = mask[i]
        continue
      }
      // 无边界：alpha 由场的覆盖度给出（自适应半径，消除簇边缘暗环）；
      // 外部自定义 field 不带 alpha 时，按最近桶半径（缺省回退全局 radius）补算
      let alpha = hit.alpha
      if (alpha === undefined) {
        const rb = hit.radius ?? params.radius
        const fadeSpan = Math.max(1e-9, rb * (FADE_OUT_FACTOR - 1))
        alpha = hit.distance <= rb ? 1 : 1 - (hit.distance - rb) / fadeSpan
      }
      if (alpha > 0) alphas[i] = alpha >= 1 ? 255 : (alpha * 255) | 0
    }
  }
}

/** 第二遍：按映射函数查色带写入 RGBA（alpha 再乘半透明度） */
function colorize(
  data: Uint8ClampedArray,
  values: Float32Array,
  alphas: Uint8Array,
  toColorT: (v: number) => number,
  lut: Uint8ClampedArray,
  opacity: number
): void {
  for (let i = 0, offset = 0; i < values.length; i++, offset += 4) {
    const alpha = alphas[i]
    if (!alpha) continue
    const t = toColorT(values[i])
    const lutIndex = (t <= 0 ? 0 : t >= 1 ? 255 : (t * 255) | 0) << 2
    data[offset] = lut[lutIndex]
    data[offset + 1] = lut[lutIndex + 1]
    data[offset + 2] = lut[lutIndex + 2]
    data[offset + 3] = opacity === 1 ? alpha : (alpha * opacity) | 0
  }
}

/** 等值域映射：值与值域线性对应（Equal Value Ranges） */
function buildLinearMapper(min: number, max: number): (v: number) => number {
  const span = max - min
  const inv = span > 0 ? 1 / span : 0
  return v => (v - min) * inv
}


