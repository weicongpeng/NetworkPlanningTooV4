/**
 * 热力图工具（按字段值插值的值热力面）
 *
 * - 坐标一律使用地图渲染坐标（GCJ02），由各图层渲染器在收集 HeatPoint 时保证
 * - 权重必须为有限数值（支持负数，如 RSRP）；无法转数值/坐标缺失的要素直接跳过
 * - 点校验与抽样统一走 normalizeHeatPoints，像素插值渲染见 heatSurface.ts
 * - 分级图例（Surfer 式 Grid Appearance）的分级点计算见 buildHeatLegend
 */
import type {
  HeatmapColorDirection,
  HeatmapColorScheme,
  HeatmapLegendMethod,
} from '../components/Map/LabelSettingsModal'

/** 热力图原始数据点（渲染坐标 GCJ02 + 原始权重） */
export interface HeatPoint {
  lat: number
  lng: number
  weight: number
}


/** 归一化结果（含图例统计） */
export interface NormalizedHeat {
  /** 通过校验且抽样后的有效点（渲染输入） */
  points: HeatPoint[]
  /** 数据最小值（可为负） */
  min: number
  /** 数据最大值（可为负） */
  max: number
  /** 有效点数（抽样前） */
  count: number
  /** 是否因超过上限做了抽样 */
  sampled: boolean
}

/**
 * 单次渲染点数上限：数万点的 IDW 插值可在百毫秒内完成；
 * 超过后等距跨步抽样，保证全范围均匀稀疏而非截断头部
 */
export const HEAT_POINT_LIMIT = 50000

/**
 * 四套渐变色带（stop: 0~1 → 颜色）。
 * stop 一律均匀铺满 [0,1]：分级图例要在整条色带上等距取色，
 * 色带若从 0.2 起色（旧值）会让最低几级落到同一颜色
 */
export const HEATMAP_GRADIENTS: Record<HeatmapColorScheme, Record<number, string>> = {
  // 经典：蓝 → 青 → 绿 → 黄 → 红
  default: {
    0.0: 'blue',
    0.25: 'cyan',
    0.5: 'lime',
    0.75: 'yellow',
    1.0: 'red',
  },
  // 暖色：黄 → 红
  warm: {
    0.0: '#ffffb2',
    0.25: '#fecc5c',
    0.5: '#fd8d3c',
    0.75: '#f03b20',
    1.0: '#bd0026',
  },
  // 冷色：浅青白 → 深绿
  cool: {
    0.0: '#edf8fb',
    0.25: '#b2e2e2',
    0.5: '#66c2a4',
    0.75: '#2ca25f',
    1.0: '#006d2c',
  },
  // Viridis
  viridis: {
    0.0: '#440154',
    0.25: '#3b528b',
    0.5: '#21918c',
    0.75: '#5ec962',
    1.0: '#fde725',
  },
}

/**
 * 色带查找表缓存：图例逐级取色会在渲染阶段反复请求同一色带，
 * 缓存掉 canvas 创建与 getImageData（同步像素读取）的开销。
 * 有上限：拖动自定义色盘会连续产生新的色带，无上限会持续增长
 */
const gradientLutCache = new Map<string, Uint8ClampedArray>()
const GRADIENT_LUT_CACHE_MAX = 64

/**
 * 色带查找表（长度 size*4 的 RGBA 字节），供像素级按值着色使用。
 * 借用 canvas 渐变解析任意 CSS 颜色（'blue' 与 '#00f' 均可）。
 */
export function buildGradientLut(stops: Record<number, string>, size = 256): Uint8ClampedArray {
  const key = `${size}|${Object.keys(stops).map(Number).sort((a, b) => a - b).map(k => `${k}:${stops[k]}`).join(',')}`
  const cached = gradientLutCache.get(key)
  if (cached) return cached

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = 1
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, size, 0)
  for (const k of Object.keys(stops)) grad.addColorStop(Number(k), stops[Number(k)])
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, 1)
  const lut = ctx.getImageData(0, 0, size, 1).data
  if (gradientLutCache.size >= GRADIENT_LUT_CACHE_MAX) {
    // Map 保持插入序，删最早的一条即可（FIFO 足够：命中率由配色方案规模决定）
    const oldest = gradientLutCache.keys().next().value
    if (oldest !== undefined) gradientLutCache.delete(oldest)
  }
  gradientLutCache.set(key, lut)
  return lut
}

/**
 * 按颜色方向解析实际色带：
 * - normal：原色带（值越大越偏暖/色带右端）
 * - reverse：色带镜像（值越大越偏冷/色带左端），stop 键取 1-k，
 *   镜像后超出定义的端点沿用端点色，与正向行为对称
 */
export function resolveHeatGradient(
  scheme: HeatmapColorScheme,
  direction?: HeatmapColorDirection
): Record<number, string> {
  const stops = HEATMAP_GRADIENTS[scheme] ?? HEATMAP_GRADIENTS.default
  if (direction !== 'reverse') return stops
  const flipped: Record<number, string> = {}
  for (const key of Object.keys(stops)) {
    const k = Number(key)
    flipped[Math.round((1 - k) * 1000) / 1000] = stops[k]
  }
  return flipped
}

/**
 * 归一化热力点：
 * - 跳过坐标/权重非有限值的点；权重可有符号（RSRP 等全负字段直接保留）
 * - 值域取数据真实极值（不再有手动上下限：色带分布由分级方法 + 分级数决定）
 * - 超过 HEAT_POINT_LIMIT 等距跨步确定性抽样（不改变原始权重）
 */
export function normalizeHeatPoints(
  points: HeatPoint[],
  limit: number = HEAT_POINT_LIMIT
): NormalizedHeat {
  const valid: HeatPoint[] = []
  let min = Infinity
  let max = -Infinity
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue
    // 解析失败的行坐标默认为 (0,0)：并入会把插值场范围/密度半径撑到跨洲尺度，
    // 在离采样区数百公里处渲染出虚假热区（与地图包围盒的无效坐标约定一致）
    if (p.lat === 0 && p.lng === 0) continue
    if (!Number.isFinite(p.weight)) continue
    if (p.weight < min) min = p.weight
    if (p.weight > max) max = p.weight
    valid.push({ lat: p.lat, lng: p.lng, weight: p.weight })
  }

  const count = valid.length
  if (count === 0) {
    return { points: [], min: 0, max: 0, count: 0, sampled: false }
  }

  // 等距跨步抽样（确定性：同一数据多次渲染结果一致）
  let sampled = false
  let source = valid
  if (valid.length > limit) {
    sampled = true
    const stride = valid.length / limit
    source = Array.from({ length: limit }, (_, i) => valid[Math.floor(i * stride)])
  }

  return { points: source, min, max, count, sampled }
}

/**
 * 用户对某一级的自定义（覆盖自动分级结果）。
 * 一旦存在，地图着色与图例都按这些锚点走，实现"所见即所得"的手工分级。
 */
export interface HeatLegendOverride {
  /** 色带位置 0~1（占比模式下即占比；区间模式由值归一化而来） */
  t: number
  /** 该级代表值（区间模式即区间端点值；占比模式为对应分位值） */
  value: number
  /** 自定义颜色 #rrggbb；未设则按配色方案在该级位置取色 */
  color?: string
}

/** 分级图例的一级（Surfer Grid Appearance 的 inflection 行） */
export interface HeatLegendLevel {
  /** 该级在色带上的位置 0~1（0=色带低端，1=高端）；用于展示顺序与占比标签 */
  t: number
  /** 该级起始值（cellCount 为分位值，valueRange 为区间端点值） */
  value: number
  /** 显示标签：cellCount 为占比（0%/17%/…），valueRange 为取整后的值 */
  label: string
  /**
   * 该级对应的**色带位置**：由地图同一映射函数作用于 value 得到，
   * 图例色块必须用它取色——否则重复值/退化值域下（如 99% 的点同值）
   * 图例会把整条彩虹列出来，而地图上实际只有一两种颜色
   */
  colorT: number
  /** 用户为该级指定的颜色（优先于按 colorT 从配色方案取色） */
  color?: string
}

/**
 * 按取整精度格式化图例数值（参考 Surfer 的 Round 项）。
 * 值先吸附到步长的整数倍再显示（Round=10 时 157.2 → 160），
 * 小数位由步长决定。只做显示取整，不影响渲染值域。
 * 取整按符号处理，避免负半数被 Math.round 拉向 +∞（-0.05 → 0.0 而非 -0.1）。
 */
export function formatLegendValue(value: number, round: number): string {
  const step = round > 0 ? round : 0.1
  const snapped = Math.sign(value) * Math.round(Math.abs(value) / step) * step
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step))))
  return snapped.toFixed(decimals)
}

/** 加权分位：在（值, 累计频次）上定位占位 t 处的值 */
function weightedQuantile(sortedValues: number[], cumCounts: number[], total: number, t: number): number {
  const target = t * (total - 1)
  let lo = 0
  let hi = cumCounts.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cumCounts[mid] > target) hi = mid
    else lo = mid + 1
  }
  return sortedValues[lo]
}

/**
 * 分位基准：把一组样本值编译成升序表，供按占位取分位值。
 *
 * 热力图分级的"值"必须以**渲染出来的插值场**的分布为基准（见 heatSurface.probeFieldDistribution），
 * 而不是原始采样点分布：插值是对邻域的加权平均，会把重尾数据的高端抹平，
 * 用原始点分布定分位时整幅图只用到色带中段一小截（"5 个分级只显出 1 种颜色"的根因）。
 */
export function buildQuantileRef(values: ArrayLike<number>): Float64Array {
  const ref = new Float64Array(values.length)
  for (let i = 0; i < values.length; i++) ref[i] = values[i]
  ref.sort()
  return ref
}

/** 分位基准在占位 t（0~1）处的值（等权） */
export function quantileRefValue(ref: Float64Array, t: number): number {
  const n = ref.length
  if (n === 0) return 0
  if (n === 1) return ref[0]
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t
  return ref[Math.round(clamped * (n - 1))]
}

/**
 * 归一化手工分级后再交给渲染：等效细胞计数下各级的"值"一律由基准分布在 t 处反算。
 *
 * 编辑态存档的值来自设置弹窗（按去重样本估算），与地图用的全量数据不同源；
 * 而用户在"等效细胞计数"里表达的意图是**占比**，不是某个具体数值。
 * 只跟着 t 走，才能保证"只改个颜色"不会让整幅图重新配色（值域基准一变，
 * 锚点整体偏移，看起来就是分级失效）。
 * 等效范围模式编辑的就是数值本身，按原样使用。
 */
export function normalizeLegendOverrides(
  overrides: HeatLegendOverride[] | null | undefined,
  method: HeatmapLegendMethod,
  distribution?: Float64Array | null
): HeatLegendOverride[] | null {
  if (!overrides || overrides.length < 2) return null
  if (method !== 'cellCount' || !distribution || distribution.length < 2) return overrides
  return overrides.map(l => ({ ...l, value: quantileRefValue(distribution, l.t) }))
}

/**
 * 计算分级图例（Surfer Grid Appearance 的 Percentage / Value 列表）。
 *
 * - cellCount（等效细胞计数）：色带按 N 等分，每级取相同**占比**，
 *   故标签是等比占比（0%/17%/…/100%），value 是该占比对应的字段值（分位值）
 * - valueRange（等效范围）：值域 [min,max] 按 N 等分，标签是各级起始值
 *
 * @param options.counts 与 points 对齐的出现次数（弹窗预览来自按值去重的样本，
 *   用次数还原真实分布；地图侧传全量点，无需该参数）
 * @param options.distribution 渲染场分布（升序）。传入后 cellCount 的各级取值
 *   改由它算分位——"每级等量"落在**渲染面积**上，与地图着色同源
 * @param options.mapValue 地图使用的"值→色带位置"映射；传入后各级的 colorT
 *   与地图实际颜色一致（不传则退化为按 t 取色）
 * @param options.overrides 用户手工编辑的分级（长度与级数一致时整组生效），
 *   覆盖自动算出的 t/value/color
 *
 * 返回顺序为**低 → 高**（t 递增），由展示层按需倒序。
 */
export function buildHeatLegend(
  points: HeatPoint[],
  min: number,
  max: number,
  method: HeatmapLegendMethod,
  inflections: number,
  round: number,
  options?: {
    counts?: number[]
    mapValue?: (v: number) => number
    overrides?: HeatLegendOverride[]
    distribution?: Float64Array
  }
): HeatLegendLevel[] {
  const overrides = options?.overrides
  const useOverrides = !!overrides && overrides.length >= 2
  const n = useOverrides
    ? Math.max(2, Math.min(64, overrides!.length))
    : Math.max(2, Math.min(64, Math.round(inflections) || 7))
  const toColorT = options?.mapValue ?? ((v: number) => v)
  const levels: HeatLegendLevel[] = []
  const tAt = (i: number) => i / (n - 1)
  const label = (t: number, value: number) => (method === 'valueRange'
    ? formatLegendValue(value, round)
    : `${Math.round(t * 100)}%`)

  // 用户手工分级：t/value/color 直接采用，仅补算标签与 colorT
  if (useOverrides) {
    for (const ov of overrides!) {
      const t = Math.max(0, Math.min(1, ov.t))
      const value = Number.isFinite(ov.value) ? ov.value : min
      levels.push({ t, value, label: label(t, value), colorT: toColorT(value), color: ov.color })
    }
    return levels
  }

  if (method === 'valueRange') {
    const span = max - min
    for (let i = 0; i < n; i++) {
      const t = tAt(i)
      const value = min + span * t
      levels.push({ t, value, label: formatLegendValue(value, round), colorT: toColorT(value) })
    }
    return levels
  }

  // 等效细胞计数：t 等分，value 取分位值（与渲染用的分位映射同源）
  // 优先用渲染场分布：此时"每级占比"等于该级在**渲染面积**上的占比
  const distribution = options?.distribution
  const useDistribution = !!distribution && distribution.length >= 2
  const q = useDistribution ? null : quantileIndex(points, options?.counts)
  for (let i = 0; i < n; i++) {
    const t = tAt(i)
    const value = useDistribution
      ? quantileRefValue(distribution!, t)
      : q ? weightedQuantile(q.values, q.cumCounts, q.total, t) : min
    levels.push({ t, value, label: `${Math.round(t * 100)}%`, colorT: toColorT(value) })
  }
  return levels
}

/** 供分位查询使用的（值, 累计频次）表 */
function quantileIndex(points: HeatPoint[], counts?: number[]) {
  if (points.length === 0) return null
  const hasCounts = !!counts && counts.length === points.length
  const pairs = points.map((p, i) => ({
    v: p.weight,
    c: hasCounts ? Math.max(1, Math.round(counts![i])) : 1,
  }))
  pairs.sort((a, b) => a.v - b.v)
  let acc = 0
  const cumCounts = pairs.map(p => (acc += p.c))
  return { values: pairs.map(p => p.v), cumCounts, total: acc }
}

/**
 * 查询占位 t 处对应的字段值（等效细胞计数模式下用户改占比后，反算该级代表值）。
 * 无点集时返回 fallback。
 */
export function quantileValueAt(
  points: HeatPoint[],
  t: number,
  counts?: number[],
  fallback = 0
): number {
  const q = quantileIndex(points, counts)
  if (!q) return fallback
  return weightedQuantile(q.values, q.cumCounts, q.total, Math.max(0, Math.min(1, t)))
}

/**
 * 以 (value → t) 锚点构造分段线性映射：用户手工编辑分级后，
 * 地图着色必须跟着走，否则图例显示的颜色在地图上找不到。
 * 锚点按值升序；两端之外钳到端点。
 */
export function buildAnchoredMapper(
  anchors: { value: number; t: number }[],
  contrast = 1
): (v: number) => number {
  // 合并相同取值的锚点（重尾数据里多级取到同一分位值很常见）：
  // 若各自保留，span=0 的相邻段会让该值前后发生硬色阶跳变，
  // 而自动映射的 (below+above)/2 设计本就是为了消除这种跳变
  const groups = new Map<number, number[]>()
  for (const a of anchors) {
    if (!Number.isFinite(a.value) || !Number.isFinite(a.t)) continue
    const arr = groups.get(a.value)
    if (arr) arr.push(a.t)
    else groups.set(a.value, [a.t])
  }
  const merged = [...groups.entries()]
    .map(([value, ts]) => ({ value, t: Math.max(0, Math.min(1, ts.reduce((s, v) => s + v, 0) / ts.length)) }))
    .sort((a, b) => a.value - b.value)
  const finish = (t: number) => {
    const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t
    return contrast === 1 ? clamped : applyContrast(clamped, contrast)
  }
  if (merged.length === 0) return () => finish(0.5)
  if (merged.length === 1) return () => finish(merged[0].t)

  return (v: number) => {
    if (v <= merged[0].value) return finish(merged[0].t)
    const last = merged[merged.length - 1]
    if (v >= last.value) return finish(last.t)
    for (let i = 1; i < merged.length; i++) {
      const hi = merged[i]
      if (v <= hi.value) {
        const lo = merged[i - 1]
        const span = hi.value - lo.value
        const k = span > 0 ? (v - lo.value) / span : 0
        return finish(lo.t + (hi.t - lo.t) * k)
      }
    }
    return finish(last.t)
  }
}

/**
 * 颜色方向作用后的色带位置：reverse 时把色带位置镜像（t → 1−t）。
 * 供 resolveLevelGradient 把自定义级颜色注册到镜像位置使用；
 * 查找侧（图例色块/弹窗预览/地图着色）直接用镜像后的整条色带按原位取色，不经本函数。
 */
export function directionLutT(t: number, direction?: HeatmapColorDirection): number {
  return direction === 'reverse' ? 1 - t : t
}

/**
 * 构造实际使用的色带：任一级带自定义色时，以各级为锚点重建色带
 * （自定义级用其颜色，未自定义的级按原配色方案在该位置取色），
 * 使地图配色与图例色块严格一致。无自定义色时原样返回。
 *
 * 位置取 `colorT`（= 地图映射后的色带位置，已含对比度/分级量化）而非原始 t：
 * 对比度会把各级推到不同位置，用原始 t 注册会让颜色落在错误的色带位置。
 * `t` 仅作为 colorT 缺失时的回退。
 *
 * direction=reverse 时整体按"镜像色带"取色（见 directionLutT）：
 * - 基础色带由调用方先经 resolveHeatGradient(scheme, direction) 翻转；
 * - 自定义级颜色再注册到镜像位置（1−colorT）——否则自定义色钉死各级后
 *   基础色带翻转对整条色带不起作用，"颜色方向"设置会失效
 */
export function resolveLevelGradient(
  baseStops: Record<number, string>,
  levels: { t: number; colorT?: number; color?: string }[],
  direction?: HeatmapColorDirection
): Record<number, string> {
  if (!levels.some(l => l.color)) return baseStops
  const keyOf = (lv: { t: number; colorT?: number }) => {
    const raw = lv.colorT ?? lv.t
    if (!Number.isFinite(raw)) return null
    const pos = directionLutT(raw, direction)
    return Math.round(Math.max(0, Math.min(1, pos)) * 1000) / 1000
  }
  // 自定义色优先落位（重复值分级会落到同一位置，此时以用户设为红色等显式颜色为准）
  const out: Record<number, string> = {}
  for (const lv of levels) {
    const key = keyOf(lv)
    if (key !== null && lv.color) out[key] = lv.color
  }
  for (const lv of levels) {
    const key = keyOf(lv)
    if (key !== null && !(key in out)) out[key] = gradientColorAt(baseStops, key)
  }
  if (Object.keys(out).length < 2) return baseStops
  return out
}

/**
 * 对比度映射：围绕色带中值 (t=0.5) 做线性拉伸并钳制到 [0,1]。
 * - contrast > 1：高低两端更快饱和（色带两端占比变大），中间过渡更陡
 * - contrast < 1：颜色向中间色带聚拢
 *
 * 属于"值 → 色带位置"映射的一环：地图着色与图例取色都必须过它，
 * 否则对比度非 1 时图例色块与地图实际颜色对不上。
 */
export function applyContrast(t: number, contrast: number): number {
  if (!(contrast > 0) || contrast === 1) return t
  const v = 0.5 + (t - 0.5) * contrast
  return v <= 0 ? 0 : v >= 1 ? 1 : v
}

/**
 * 取色带上某个位置的颜色（图例色块用）。
 * 复用 buildGradientLut 的 canvas 渐变解析，返回 #rrggbb；
 * 取样位置与渲染层 colorize 的 LUT 索引一致（t*255 截断），保证图例与地图同色。
 */
export function gradientColorAt(stops: Record<number, string>, t: number): string {
  const lut = buildGradientLut(stops)
  const pos = t <= 0 ? 0 : t >= 1 ? 255 : (t * 255) | 0
  const i = pos * 4
  const hex = (v: number) => v.toString(16).padStart(2, '0')
  return `#${hex(lut[i])}${hex(lut[i + 1])}${hex(lut[i + 2])}`
}

/**
 * 面/线质心（顶点算术平均，外环）。
 * 入参为 GeoJSON 环 [lng, lat] 序列。
 * 点分布近似均匀时与真实质心视觉差异可忽略，零几何依赖。
 */
export function centroidFromLngLatRing(ring: [number, number][]): { lat: number; lng: number } | null {
  if (!Array.isArray(ring) || ring.length === 0) return null
  let lngSum = 0
  let latSum = 0
  let n = 0
  for (const [lng, lat] of ring) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
    lngSum += lng
    latSum += lat
    n++
  }
  if (n === 0) return null
  return { lat: latSum / n, lng: lngSum / n }
}

/**
 * 面/线质心，入参为 [lat, lng] 序列（如 GeoDataLayer 多边形 path）。
 */
export function centroidFromLatLngRing(ring: [number, number][]): { lat: number; lng: number } | null {
  if (!Array.isArray(ring) || ring.length === 0) return null
  const flipped = ring.map(([lat, lng]) => [lng, lat] as [number, number])
  return centroidFromLngLatRing(flipped)
}

/**
 * 将 gradient stops 转为 CSS linear-gradient 字符串（图例用）。
 */
export function gradientToCss(stops: Record<number, string>): string {
  const parts = Object.keys(stops)
    .map(Number)
    .sort((a, b) => a - b)
    .map(k => `${stops[k]} ${Math.round(k * 100)}%`)
  return `linear-gradient(to right, ${parts.join(', ')})`
}
