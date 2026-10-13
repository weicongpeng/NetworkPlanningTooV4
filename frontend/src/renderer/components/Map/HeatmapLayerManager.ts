/**
 * 热力图层管理器（按字段值插值的值热力面）
 *
 * - 一个数据图层对应一个 L.ImageOverlay，按 layerId 复用（参数/数据变化只换栅格图，不重建）
 * - **按图层全景渲染**：栅格范围 = 数据外接矩形（外扩 1.5×全局半径渐隐带），
 *   分辨率按纵横比适配固定像素预算，与视口/缩放完全无关——只在数据/设置变化时
 *   重绘一次，缩放平移由 Leaflet 对同一栅格做仿射变换 → 任意缩放级别结果一致
 * - 覆盖半径为**地理半径**（由点间距与平滑强度决定，无屏幕像素下限）
 * - 稀疏区空洞靠逐点自适应半径补齐（见 apply），而非加宽渐隐带
 * - 栅格 canvas 由 utils/heatSurface 生成（IDW 插值 + 色带 LUT + 覆盖半径外渐隐）
 * - 普通 TS 类，由 OnlineMap 以 ref 持有，不进 React 状态
 *
 * 注意：ImageOverlay 默认不接收鼠标事件（interactive:false），不会吞地图点击/圈选。
 */
import L from 'leaflet'
import { DEFAULT_HEATMAP_LEVEL_PROPORTIONS, DEFAULT_HEATMAP_SETTINGS, type HeatmapSettings } from './LabelSettingsModal'
import {
  buildAnchoredMapper,
  buildGradientLut,
  buildHeatLegend,
  buildQuantileRef,
  normalizeHeatPoints,
  normalizeLegendOverrides,
  resolveHeatGradient,
  resolveLevelGradient,
  type HeatLegendLevel,
  type HeatLegendOverride,
  type HeatPoint,
  type NormalizedHeat,
} from '../../utils/heatmap'
import { buildValueMapper, collectBoundaryPolygons, collectGeoDataPolygons, concentrateLevel, filterPointsToBoundary, probeFieldDistribution, softQuantizeLevel, renderHeatSurface, type HeatBoundary } from '../../utils/heatSurface'
import { DEG2RAD, EARTH_RADIUS, buildHeatField, nearestNeighborDistances, projectToMercator, unprojectFromMercator, type HeatField } from '../../utils/heatField'

/** Mercator 米范围 → 地理范围（度） */
function mercatorBoundsToLatLng(minX: number, minY: number, maxX: number, maxY: number): { west: number; south: number; east: number; north: number } {
  const sw = unprojectFromMercator(minX, minY)
  const ne = unprojectFromMercator(maxX, maxY)
  return { west: sw.lng, south: sw.lat, east: ne.lng, north: ne.lat }
}
import { useMapDataCacheStore } from '../../store/mapDataCacheStore'
import { layerApi, dataApi } from '../../services/api'
import { OriginalSamplesLayer } from './OriginalSamplesLayer'

/** 图例统计（归一化后） */
export interface HeatmapStats {
  /** 颜色值域下限（数据最小值，可为负） */
  min: number
  /** 颜色值域上限（数据最大值，可为负） */
  max: number
  /** 有效点数（抽样前） */
  count: number
  /** 是否抽样显示 */
  sampled: boolean
  /** 分级图例（低 → 高）：由当前分级方法/级数/取整精度算得 */
  levels: HeatLegendLevel[]
  /** 本次渲染的权重字段名（设置弹窗据此判断能否复用下面的分布） */
  field: string
  /**
   * 渲染场分布（升序，等权）。设置弹窗的图例预览用它做分位基准，
   * 才能与地图上的实际着色同源（原始采样点分布与渲染场分布差别很大）；
   * 空数组表示不可用。仅当字段名一致且设置未变时可直接复用
   */
  fieldDistribution: Float64Array
}

/**
 * 全景栅格单边像素上限（计算量上界）。
 * 全景渲染只在进行设置/数据变化时执行一次（不再随平移缩放重绘），
 * 栅格按数据范围纵横比适配到该预算；放大后像素被插值放大属预期（结果一致优先）
 */
const MAX_SIDE = 1792
/** 边界图层加载超时（毫秒）：超过视为请求卡住，允许重新发起，避免边界一直不生效 */
const BOUNDARY_LOAD_TIMEOUT_MS = 20_000
/** 1×1 透明图（视口内无采样点时占位，避免残留旧栅格） */
const EMPTY_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

interface HeatEntry {
  layerId: string
  overlay: L.ImageOverlay
  map: L.Map
  stats: HeatmapStats
  points: HeatPoint[]
  settings: HeatmapSettings
  /** 全局搜索半径（米）：由点集 P90 间距与平滑强度决定，与视口无关，保证缩放时颜色不跳 */
  radiusMeters: number
  /** 逐点覆盖半径（米，与 points 对齐）：稀疏点半径放大补洞，与视口无关 */
  pointRadii: Float64Array
  /** 本次渲染的纯计算结果（半径/场/映射/统计）——paint 直接用它栅格化 */
  comp: HeatComputation
  /** 插值场（建桶结果）：颜色分级标定与栅格渲染共用同一个场 */
  field: HeatField | null
  /** 原始采样模式的逐点渲染图层（grid 模式为 null） */
  pointLayer: OriginalSamplesLayer | null
  /** 值 → 色带位置 的固定映射，同样与视口无关 */
  mapValue: (value: number) => number
  /** 渲染代际（异步取图回写时校验，防止旧图覆盖新图） */
  generation: number
  /** 已渲染栅格的地理范围（= 图层数据外接矩形，与视口无关） */
  bounds: L.LatLngBounds
  /** 已注入的 blob URL（下次渲染前释放） */
  objectUrl: string | null
  /** 本次渲染使用的设置签名（key 排序序列化）：与点集指纹一起决定能否复用栅格 */
  settingsSig: string
  /** 本次渲染使用的点集指纹：数据未变时跨页面返回可直接复用栅格 */
  dataFingerprint: string
  /** 栅格是否已完成一次完整渲染（可安全复用） */
  ready: boolean
  /** 是否已渲染过至少一次栅格（边界未就绪时用于"保留旧图"判断） */
  rendered: boolean
  /** 当前栅格使用的点集指纹（与 dataFingerprint 不一致说明数据已变，需按新数据出图） */
  paintedFingerprint: string | null
  /**
   * 当前栅格实际使用的边界图层 id（null=未裁剪）。
   * 与 settings.boundaryLayerId 不一致时说明边界换了/尚未就绪，需要补绘
   */
  paintedBoundaryId: string | null
}

/**
 * 稳定的设置序列化（key 排序）：用于判断热力设置是否变化，决定能否复用已渲染栅格
 */
export function heatSettingsSignature(settings: HeatmapSettings): string {
  const src = settings as unknown as Record<string, unknown>
  const keys = Object.keys(src).sort()
  return JSON.stringify(keys.map(k => [k, src[k]]))
}

/**
 * 点集指纹（FNV-1a，含点数）：坐标或权重任一变化都会得到不同指纹。
 * 用于判断"数据未变"，从而跳过昂贵的插值渲染/编码（跨页面返回时直接复用栅格）。
 */
export function fingerprintHeatPoints(points: HeatPoint[]): string {
  let h = 2166136261 >>> 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    h = Math.imul(h ^ ((p.lat * 1e6) | 0), 16777619) >>> 0
    h = Math.imul(h ^ ((p.lng * 1e6) | 0), 16777619) >>> 0
    h = Math.imul(h ^ (Number.isFinite(p.weight) ? (p.weight * 1000) | 0 : 0), 16777619) >>> 0
  }
  return `${points.length}:${h.toString(36)}`
}

/**
 * 热力渲染的**纯计算部分**：点集 + 设置 → 半径 / 插值场 / 值→色带位置映射 / 图例统计。
 *
 * 抽出来是为了让 **3D（Cesium）复用同一套计算**：半径推导、分级、分位基准、图例取值全部与
 * 2D 同源，否则同一个设置在两边会渲染出不同的颜色分布。整个过程不涉及任何 Leaflet 对象。
 *
 * @returns null 表示无有效点（调用方应移除既有热力层）
 */
export interface HeatComputation {
  normalized: NormalizedHeat
  /** 图例统计中与渲染无关的部分 */
  baseStats: { min: number; max: number; count: number; sampled: boolean; field: string }
  /** 全局覆盖半径（米） */
  radiusMeters: number
  /** 逐点半径（米） */
  pointRadii: Float64Array
  /** IDW 插值场；原始采样模式下为 null */
  field: HeatField | null
  /** 值 → 色带位置（0~1）的最终映射（含对比度/高值集中度/分级量化） */
  mapValue: (v: number) => number
  stats: HeatmapStats
  /** 是否"原始采样"模式 */
  isOriginal: boolean
}

export function computeHeatComputation(
  points: HeatPoint[],
  settings: HeatmapSettings,
): HeatComputation | null {
  const normalized = normalizeHeatPoints(points)
  if (normalized.points.length === 0) return null

  // 图例统计中与渲染无关的部分（levels 要等映射函数算好后才能定）
  const baseStats: HeatComputation['baseStats'] = {
    min: normalized.min,
    max: normalized.max,
    count: normalized.count,
    sampled: normalized.sampled,
    field: settings.field,
  }

    // 渲染基准只在数据/设置变化时重算，且均与视口无关 → 缩放平移时同一位置颜色固定：
    // - 全局半径 = max(P90 最近邻, 密度半径) × 平滑强度，全部由数据决定（无屏幕像素项，
    //   旧"40 屏幕像素"兜底随缩放变化，是"缩放前后结果不一致"的来源之一）
    // - **密度半径不可省**：小区级数据同站多频段×多扇区坐标完全重合 → P90(nn)≈0，
    //   只有密度半径 sqrt(面积/点数) 能给出合理的融合尺度（否则只剩单点色斑）
    // - 逐点半径 clamp(nn×smooth, 全局半径, 1.5×全局半径)：下限必须 ≥R——
    //   桶代表点最大间距为 √2×cell=1.06R，核作用范围 1.25×桶半径 > 1.06R 才能跨桶
    //   混值融合；下限低于 R（如 0.5R）时核范围 0.625R < 代表点间距，热力面退化成
    //   一块块值恒定的硬边圆盘（"单点不融合"）
    // - 颜色映射取"等效细胞计数"分位（默认，基准为下面的渲染场分布）或"等效范围"线性
    const isOriginal = (settings.sampleMode ?? 'grid') === 'original'
    const smooth = Math.min(10, Math.max(1, settings.smooth ?? DEFAULT_HEATMAP_SETTINGS.smooth))
    const nn = nearestNeighborDistances(normalized.points)
    let p90 = 0
    {
      const sorted = Float64Array.from(nn).sort()
      p90 = sorted[Math.round(0.9 * (sorted.length - 1))] ?? 0
    }
    let minLat = 90
    let maxLat = -90
    let minLng = 180
    let maxLng = -180
    for (const p of normalized.points) {
      if (p.lat < minLat) minLat = p.lat
      if (p.lat > maxLat) maxLat = p.lat
      if (p.lng < minLng) minLng = p.lng
      if (p.lng > maxLng) maxLng = p.lng
    }
    const spanXm = (maxLng - minLng) * DEG2RAD * EARTH_RADIUS
    const spanYm = (maxLat - minLat) * 111_320
    const densityR = Math.sqrt((spanXm * spanYm) / Math.max(1, normalized.points.length))
    let globalR = 0
    const pointRadii = new Float64Array(nn.length)
    if (isOriginal) {
      // 原始采样：半径是**视觉斑**大小，不需要 IDW 的跨点融合 → 不加融合下限。
      // 所有点半径**统一** = 密度半径 × k（与站点疏密/最近邻距离无关，稀疏区不放大），
      // 平滑强度线性缩放（smooth=1 → k=0.6；10 → k=1.5 大斑）。
      // 下端不能再低：smooth 默认已改为 1（栅格模式的最锐档），沿用旧的 k(1)=0.2 会让
      // 原始采样的斑比之前小 7 倍——两种模式共用同一个滑杆，下端必须各自可用
      const k = 0.6 + ((smooth - 1) / 9) * 0.9
      const r = densityR * k
      pointRadii.fill(r)
      globalR = r
    } else {
      globalR = Math.max(p90, densityR * 0.6) * smooth
      const cap = globalR * 1.5
      for (let i = 0; i < nn.length; i++) {
        pointRadii[i] = Math.min(Math.max(nn[i] * smooth, globalR), cap)
      }
    }
    // 颜色分级基准分布按采样方式分别取：
    // - grid（默认）：取**渲染出来的插值场**分布（按桶面积等权）——插值会把邻域值
    //   平均掉，与原始点分布差很远，用后者定分位时整幅图只用得到色带中段
    // - original：不做 IDW（跳过最贵的建场），逐点按自身权重着色，基准分布直接取
    //   原始采样点权重排序
    // 细节增强内建于场（整体趋势场 ↔ 细节场凸组合，见 heatField.buildHeatField）：
    // grid 模式下 probe/图例标定与渲染共用同一个场，严格同源。
    // 细节核半径由场内部按「点间距 × smooth」定（smooth 必须传入，否则"平滑强度"
    // 滑杆对 detail≈100 的默认档完全无效——实际平滑量会被「栅格采样」暗中决定）
    let field: HeatField | null
    let distribution: Float64Array
    if (isOriginal) {
      field = null
      distribution = buildQuantileRef(Float64Array.from(normalized.points, p => p.weight).sort())
    } else {
      field = buildHeatField(
        normalized.points,
        globalR,
        pointRadii,
        settings.detail ?? DEFAULT_HEATMAP_SETTINGS.detail!,
        settings.sampling ?? DEFAULT_HEATMAP_SETTINGS.sampling,
        smooth
      )
      distribution = field ? buildQuantileRef(probeFieldDistribution(field)) : new Float64Array(0)
    }
    const method = settings.method ?? 'cellCount'
    const contrast = settings.contrast ?? DEFAULT_HEATMAP_SETTINGS.contrast
    // 用户手工编辑过分级 → 以 (值, 色带位置) 锚点做分段映射；
    // 未编辑时若为默认 5 级「等效细胞计数」，则应用内置默认占比（与设置弹窗默认分级同源）；
    // 否则用自动映射（纯分位 / 线性）。两者都是"值→色带位置"，图例与地图共用同一个函数。
    // "等效细胞计数"下占比才是用户表达的意图，故各级取值一律由基准分布在 t 处反算，
    // 不复用编辑时存档的值（那是设置弹窗按采样样本估的，与地图全量数据不同源）
    const defaultLevels = method === 'cellCount' && distribution.length >= 2
      && (settings.inflections ?? DEFAULT_HEATMAP_SETTINGS.inflections!) === DEFAULT_HEATMAP_LEVEL_PROPORTIONS.length
      ? DEFAULT_HEATMAP_LEVEL_PROPORTIONS.map(t => ({ t, value: 0 }))
      : null
    const customLevels: HeatLegendOverride[] | null = normalizeLegendOverrides(settings.levels ?? defaultLevels, method, distribution)
    const mapValue = customLevels
      ? buildAnchoredMapper(customLevels.map(l => ({ value: l.value, t: l.t })), contrast)
      : buildValueMapper(
        normalized.points,
        normalized.min,
        normalized.max,
        method,
        contrast,
        512,
        distribution
      )
    // 高值集中度（幂曲线）：独立于插值，连续收/放高值色面积，默认 gamma=1 不变。
    // 包在基础映射外、分级量化内
    const concentration = settings.concentration ?? DEFAULT_HEATMAP_SETTINGS.concentration!
    const mappedWithConcentration = concentration === 1
      ? mapValue
      : (v: number) => concentrateLevel(mapValue(v), concentration)
    // 分级渲染：连续色带位置量化到 N 级。
    // 包在最外层 → 地图着色、图例各级 colorT、弹窗预览全部同源；
    // levelSoftness>0 时边界窄带软过渡（色块内部仍纯色）
    const discreteLevels = settings.discrete
      ? Math.max(2, settings.inflections ?? DEFAULT_HEATMAP_SETTINGS.inflections!)
      : 0
    const finalMapValue = discreteLevels >= 2
      ? (v: number) => softQuantizeLevel(mappedWithConcentration(v), discreteLevels, settings.levelSoftness ?? DEFAULT_HEATMAP_SETTINGS.levelSoftness!)
      : mappedWithConcentration
    // 分级图例与渲染走同一套分级与同一映射函数，
    // 图例色块不会列出地图上不存在的颜色（重复值/退化值域下尤其明显）
    const stats: HeatmapStats = {
      ...baseStats,
      fieldDistribution: distribution,
      levels: buildHeatLegend(
        normalized.points,
        normalized.min,
        normalized.max,
        method,
        settings.inflections ?? DEFAULT_HEATMAP_SETTINGS.inflections!,
        settings.round ?? DEFAULT_HEATMAP_SETTINGS.round!,
        { mapValue: finalMapValue, overrides: customLevels ?? undefined, distribution }
      ),
    }
  return {
    normalized,
    baseStats,
    radiusMeters: globalR,
    pointRadii,
    field,
    mapValue: finalMapValue,
    stats,
    isOriginal,
  }
}

/** 热力面栅格：位图 + 其地理范围 */
export interface HeatRaster {
  canvas: HTMLCanvasElement
  bounds: { south: number; west: number; north: number; east: number }
}

/**
 * 把热力计算结果**栅格化成位图**（含边界裁剪、色带映射、覆盖半径外渐隐）。
 *
 * 2D 侧把它贴成 `L.ImageOverlay`、3D 侧贴成 Cesium `SingleTileImageryProvider`，
 * 两边用同一张图、同一套色带与分级，同一设置在两端的观感一致。
 *
 * @returns null 表示数据范围退化（点完全重合）或渲染失败
 */
export function renderHeatRaster(
  comp: HeatComputation,
  settings: HeatmapSettings,
  boundary: HeatBoundary | null,
): HeatRaster | null {
  // 数据范围（Mercator 米），外扩全局半径的 1.5 倍作为边缘渐隐带
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of comp.normalized.points) {
    const m = projectToMercator(p.lat, p.lng)
    if (m.x < minX) minX = m.x
    if (m.x > maxX) maxX = m.x
    if (m.y < minY) minY = m.y
    if (m.y > maxY) maxY = m.y
  }
  const pad = comp.radiusMeters * 1.5
  minX -= pad
  maxX += pad
  minY -= pad
  maxY += pad
  const spanX = maxX - minX
  const spanY = maxY - minY
  if (!(spanX > 0) || !(spanY > 0)) return null
  // 分辨率：长边适配预算（与视口无关），短边按纵横比
  const budget = MAX_SIDE
  const spanMax = Math.max(spanX, spanY)
  const width = Math.max(64, Math.min(MAX_SIDE, Math.round((spanX / spanMax) * budget)))
  const height = Math.max(64, Math.min(MAX_SIDE, Math.round((spanY / spanMax) * budget)))
  const dataBounds = mercatorBoundsToLatLng(minX, minY, maxX, maxY)
  // 有裁剪边界时：**用边界内的点重建插值场**（entry.field 含边界外桶，其核值/覆盖度
  // 会越界污染内像素，外部值偏低时表现为沿边界整体偏暗）；无边界则复用标定场
  let paintField: HeatField | null = comp.field
  let paintPoints = comp.normalized.points
  let paintRadii: Float64Array | undefined = comp.pointRadii
  if (boundary) {
    const inside = filterPointsToBoundary(comp.normalized.points, comp.pointRadii, boundary)
    paintPoints = inside.points
    paintRadii = inside.pointRadii
    paintField = buildHeatField(
      inside.points,
      comp.radiusMeters,
      inside.pointRadii,
      settings.detail ?? DEFAULT_HEATMAP_SETTINGS.detail!,
      settings.sampling ?? DEFAULT_HEATMAP_SETTINGS.sampling,
      settings.smooth ?? DEFAULT_HEATMAP_SETTINGS.smooth
    )
  }
  const canvas = renderHeatSurface({
    points: paintPoints,
    // 无边界=复用标定场（同源）；有边界=边界内点重建场（无污染）
    field: paintField,
    min: comp.stats.min,
    max: comp.stats.max,
    mapValue: comp.mapValue,
    // 色带：有自定义级色时按分级锚点重建（含颜色方向镜像：自定义色注册到镜像位），
    // 保证地图配色与图例色块一致
    lut: buildGradientLut(resolveLevelGradient(
      resolveHeatGradient(settings.colorScheme, settings.colorDirection),
      comp.stats.levels,
      settings.colorDirection
    )),
    radius: comp.radiusMeters,
    pointRadii: paintRadii,
    bounds: dataBounds,
    width,
    height,
    opacity: settings.opacity ?? 1,
    boundary,
  })

  return canvas ? { canvas, bounds: dataBounds } : null
}

export class HeatmapLayerManager {
  private entries = new Map<string, HeatEntry>()
  /** 边界图层多边形缓存：key=图层 id，值 null 表示该图层不是面或无数据 */
  private boundaries = new Map<string, HeatBoundary | null>()
  /** 正在加载的边界图层 id → 开始时间戳（避免重复请求，并支持超时后重试） */
  private boundaryLoading = new Map<string, number>()

  /**
   * 应用/更新某图层的热力渲染。
   * 无有效点时移除既有热力层并返回 null。
   */
  apply(map: L.Map, layerId: string, points: HeatPoint[], settings: HeatmapSettings): Promise<HeatmapStats | null> {
    const settingsSig = heatSettingsSignature(settings)
    const dataFingerprint = fingerprintHeatPoints(points)

    // 设置与点集都未变化 → 复用已渲染栅格：只把覆盖层挂回地图（跨页面返回/重复重放时
    // 跳过 IDW 插值渲染与 PNG 编码这两个最耗时的步骤）
    const reusable = this.entries.get(layerId)
    if (reusable && reusable.map === map && reusable.ready
      && reusable.settingsSig === settingsSig && reusable.dataFingerprint === dataFingerprint) {
      this.attach(reusable)
      // 渲染边界兜底：栅格未按当前边界裁剪（边界刚换/当时未就绪）时补绘或重试加载
      this.ensureBoundaryApplied(reusable)
      return Promise.resolve(reusable.stats)
    }

    const comp = computeHeatComputation(points, settings)
    if (!comp) {
      this.remove(layerId)
      return Promise.resolve(null)
    }

    const existing = this.entries.get(layerId)
    // 地图实例不同（旧地图已销毁/重建）：先释放旧栅格与 blob URL，避免内存泄漏
    if (existing && existing.map !== map) this.remove(layerId)
    const entry: HeatEntry = existing && existing.map === map
      ? existing
      : {
        layerId,
        overlay: L.imageOverlay(EMPTY_TILE, map.getBounds(), { interactive: false }).addTo(map),
        map,
        stats: { ...comp.baseStats, levels: [], fieldDistribution: new Float64Array(0) },
        comp,
        points: comp.normalized.points,
        settings,
        radiusMeters: 0,
        pointRadii: new Float64Array(0),
        field: null,
        pointLayer: null,
        mapValue: (v: number) => v,
        generation: 0,
        bounds: map.getBounds(),
        objectUrl: null,
        settingsSig,
        dataFingerprint,
        ready: false,
        rendered: false,
        paintedFingerprint: null,
        paintedBoundaryId: null,
      }
    entry.points = comp.normalized.points
    entry.settings = settings
    entry.settingsSig = settingsSig
    entry.dataFingerprint = dataFingerprint
    entry.ready = false
    entry.comp = comp
    entry.radiusMeters = comp.radiusMeters
    entry.pointRadii = comp.pointRadii
    entry.field = comp.field
    entry.mapValue = comp.mapValue
    entry.stats = comp.stats
    // 原始采样模式下上一轮的逐点图层（若存在）先移除，paint 中按新数据惰性重建
    if (comp.isOriginal && entry.pointLayer) {
      try { map.removeLayer(entry.pointLayer) } catch { /* ignore */ }
      entry.pointLayer = null
    }
    this.entries.set(layerId, entry)

    this.paint(entry)
    return Promise.resolve(entry.stats)
  }

  /**
   * 移除某图层热力渲染。
   */
  remove(layerId: string): void {
    const entry = this.entries.get(layerId)
    if (!entry) return
    try { entry.map.removeLayer(entry.overlay) } catch { /* ignore */ }
    this.releaseObjectUrl(entry)
    if (entry.pointLayer) {
      try { entry.map.removeLayer(entry.pointLayer) } catch { /* ignore */ }
      entry.pointLayer = null
    }
    this.entries.delete(layerId)
    // 同步清掉同 id 的边界缓存，避免图层删除后同 id 新图层复用旧边界
    this.boundaries.delete(layerId)
  }

  has(layerId: string): boolean {
    return this.entries.has(layerId)
  }

  getStats(layerId: string): HeatmapStats | null {
    return this.entries.get(layerId)?.stats ?? null
  }

  /**
   * 把已渲染的栅格挂回地图（幂等）：页面切换后覆盖层被摘下，返回时直接复用无需重算。
   */
  private attach(entry: HeatEntry): void {
    if ((entry.settings.sampleMode ?? 'grid') === 'original') {
      // 原始采样：挂回逐点图层（栅格覆盖层保持摘下）
      if (entry.pointLayer && !entry.map.hasLayer(entry.pointLayer)) {
        try { entry.pointLayer.addTo(entry.map) } catch { /* ignore */ }
      }
    } else if (!entry.map.hasLayer(entry.overlay)) {
      try {
        entry.overlay.setBounds(entry.bounds)
        entry.overlay.addTo(entry.map)
      } catch { /* ignore */ }
    }
    this.bringToFront(entry.layerId)
  }

  /**
   * 用已有栅格恢复显示（图层实例尚未就绪时使用）：
   * 仅在设置签名一致且栅格已渲染完成时挂回，避免渲染中/过期数据被展示。
   * @returns 是否已恢复
   */
  restore(layerId: string, settings: HeatmapSettings): boolean {
    const entry = this.entries.get(layerId)
    if (!entry || !entry.ready || entry.settingsSig !== heatSettingsSignature(settings)) return false
    this.attach(entry)
    this.ensureBoundaryApplied(entry)
    return true
  }

  /**
   * 页面切换：把热力覆盖层从（被缓存复用的）地图上摘下。
   * 保留栅格图/统计/边界缓存，返回页面时可直接挂回，无需重新插值渲染。
   */
  detachAll(map?: L.Map): void {
    for (const entry of this.entries.values()) {
      if (map && entry.map !== map) continue
      try { entry.map.removeLayer(entry.overlay) } catch { /* ignore */ }
      if (entry.pointLayer) {
        try { entry.map.removeLayer(entry.pointLayer) } catch { /* ignore */ }
      }
    }
  }

  /** 将热力层提到 overlayPane 顶部（栅格图片或逐点 canvas，保证压在图形层之上） */
  bringToFront(layerId: string): void {
    const entry = this.entries.get(layerId)
    const el = (entry?.overlay as any)?._image as HTMLElement | undefined
    if (el?.parentNode) el.parentNode.appendChild(el)
    const canvas = entry?.pointLayer?.getCanvas()
    if (canvas?.parentNode) canvas.parentNode.appendChild(canvas)
  }

  /** 所有热力层依次置顶（z-order reconcile 后调用） */
  bringAllToFront(): void {
    for (const layerId of this.entries.keys()) {
      this.bringToFront(layerId)
    }
  }

  /** 当前持有热力层的图层 id（图层卸载清理用） */
  getLayerIds(): string[] {
    return Array.from(this.entries.keys())
  }

  /**
   * 生成/更新某图层的栅格图：**按图层全景渲染**。
   *
   * 栅格范围 = 数据外接矩形（向四周外扩 1.5×全局半径的渐隐带），
   * 分辨率按数据范围纵横比适配到固定像素预算（MAX_SIDE），
   * 与视口/缩放完全无关——overlay 的地理范围固定，缩放平移由 Leaflet
   * 对同一张栅格做仿射变换，任意缩放级别呈现同一结果（一致性优先，
   * 深度放大时像素被放大变软属预期）。只在数据/设置变化时重绘一次。
   */
  private paint(entry: HeatEntry): void {
    // 渲染边界（两种模式共用）：首次异步加载，未就绪时按下方守卫保留现状
    const boundaryLayerId = entry.settings.boundaryLayerId
    const boundary = boundaryLayerId ? this.getBoundary(entry.settings, entry.map) : null
    // 已配置渲染边界但边界尚未就绪（首次异步加载中）：
    // - 已有渲染且数据未变（如只是换了渲染边界）：保留现状等待 loadBoundary 完成后重绘，
    //   避免闪出"未裁剪"的结果（曾表现为：换边界后一直不裁剪，需重新保存/开关图层才恢复）
    // - 数据已变或尚无渲染（首次）：正常出图（无边界），避免长时间空白或显示过期数据
    if (boundaryLayerId && !boundary && entry.rendered
      && entry.paintedFingerprint === entry.dataFingerprint) return

    // 原始采样模式：逐点渲染（不栅格化）
    if ((entry.settings.sampleMode ?? 'grid') === 'original') {
      this.paintOriginal(entry, boundary)
      return
    }
    // 栅格模式：确保 original 模式的残留逐点图层已摘下（模式切换兜底）
    if (entry.pointLayer) {
      try { entry.map.removeLayer(entry.pointLayer) } catch { /* ignore */ }
      entry.pointLayer = null
    }

    const raster = renderHeatRaster(entry.comp, entry.settings, boundary)
    const canvas = raster?.canvas ?? null
    const dataBounds = raster?.bounds ?? mercatorBoundsToLatLng(0, 0, 0, 0)

    // 栅格地理范围固定：只需设一次边界（数据/设置变化会重走 paint）
    const bounds = L.latLngBounds([dataBounds.south, dataBounds.west], [dataBounds.north, dataBounds.east])
    entry.overlay.setBounds(bounds)
    entry.bounds = bounds

    if (!canvas) {
      this.releaseObjectUrl(entry)
      entry.overlay.setUrl(EMPTY_TILE)
      entry.ready = false
      return
    }
    // 同步渲染已完成（toBlob 仅回写图片 URL），标记为可复用：跨页面返回时无需重算
    entry.ready = true
    entry.rendered = true
    entry.paintedFingerprint = entry.dataFingerprint
    // 记录本次栅格实际使用的边界：与设置不一致（边界换了/未就绪）时由兜底逻辑补绘
    entry.paintedBoundaryId = boundary ? (boundaryLayerId ?? null) : null
    const generation = ++entry.generation
    // toBlob 编码在后台线程完成，避免 toDataURL 同步阻塞主线程数百毫秒
    canvas.toBlob(blob => {
      if (!blob || this.entries.get(entry.layerId) !== entry || entry.generation !== generation) return
      const url = URL.createObjectURL(blob)
      this.releaseObjectUrl(entry)
      entry.objectUrl = url
      entry.overlay.setUrl(url)
      this.bringToFront(entry.layerId)
    }, 'image/png')
  }

  /**
   * 原始采样模式出图：逐点渲染（无 IDW 栅格化）。
   * 复用与栅格模式完全相同的映射/色带/半径/边界，逐点图层随缩放重绘保证清晰。
   */
  private paintOriginal(entry: HeatEntry, boundary: HeatBoundary | null): void {
    // 栅格覆盖层若在地图上则摘下（实例保留，切回 grid 时复用）
    if (entry.map.hasLayer(entry.overlay)) {
      try { entry.map.removeLayer(entry.overlay) } catch { /* ignore */ }
    }
    if (!entry.pointLayer) entry.pointLayer = new OriginalSamplesLayer()
    if (!entry.map.hasLayer(entry.pointLayer)) entry.pointLayer.addTo(entry.map)

    // 色带与栅格 paint 同构（含颜色方向镜像与自定义级色），保证逐点配色与图例一致
    const lut = buildGradientLut(resolveLevelGradient(
      resolveHeatGradient(entry.settings.colorScheme, entry.settings.colorDirection),
      entry.stats.levels,
      entry.settings.colorDirection
    ))
    entry.pointLayer.update({
      points: entry.points,
      pointRadii: entry.pointRadii,
      mapValue: entry.mapValue,
      lut,
      opacity: entry.settings.opacity ?? 1,
      boundary,
      detail: entry.settings.detail ?? DEFAULT_HEATMAP_SETTINGS.detail!,
      discreteLevels: entry.settings.discrete
        ? Math.max(2, entry.settings.inflections ?? DEFAULT_HEATMAP_SETTINGS.inflections!)
        : 0,
      smooth: entry.settings.smooth ?? DEFAULT_HEATMAP_SETTINGS.smooth,
    })

    // 逐点渲染为同步绘制，标记完成态（复用/跨页面恢复与栅格模式走同一套判定）
    entry.ready = true
    entry.rendered = true
    entry.paintedFingerprint = entry.dataFingerprint
    entry.paintedBoundaryId = boundary ? (entry.settings.boundaryLayerId ?? null) : null
    this.bringToFront(entry.layerId)
  }

  private releaseObjectUrl(entry: HeatEntry): void {
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl)
    entry.objectUrl = null
  }

  /**
   * 取边界多边形：已缓存直接返回；未缓存则启动异步加载（完成后自动重绘），
   * 本次先用无边界渲染，避免首次打开时长时间白屏
   */
  private getBoundary(settings: HeatmapSettings, map: L.Map): HeatBoundary | null {
    const layerId = settings.boundaryLayerId
    if (!layerId) return null
    const cached = this.boundaries.get(layerId)
    if (cached !== undefined) return cached
    if (!this.isBoundaryLoading(layerId)) {
      void this.loadBoundary(layerId, settings.boundaryDataId ?? '', settings.boundarySource ?? 'mapinfo', map)
    }
    return null
  }

  /** 边界是否正在加载（超过超时时间视为卡住，允许重试） */
  private isBoundaryLoading(layerId: string): boolean {
    const since = this.boundaryLoading.get(layerId)
    if (since === undefined) return false
    if (Date.now() - since < BOUNDARY_LOAD_TIMEOUT_MS) return true
    this.boundaryLoading.delete(layerId)
    return false
  }

  /**
   * 复用/恢复已渲染栅格时的渲染边界兜底。
   *
   * 复用路径不会重绘，因此这里必须处理两种"边界没生效"的状态：
   * 1) 当前栅格实际使用的边界与设置不一致（刚换了边界/栅格是边界未就绪时渲染的）且边界已缓存 → 立即补绘；
   * 2) 边界多边形还没缓存 → 重试异步加载（加载完成后自动补绘）。
   * 否则栅格被标记完成后再也不会重绘，表现为"渲染边界不生效，
   * 需要重新保存或把图层关了再开（走完整重算）才切割"。
   */
  private ensureBoundaryApplied(entry: HeatEntry): void {
    const layerId = entry.settings.boundaryLayerId
    if (!layerId) return
    const cached = this.boundaries.get(layerId)
    if (cached && entry.paintedBoundaryId !== layerId) {
      this.paint(entry)
      return
    }
    if (!cached && !this.isBoundaryLoading(layerId)) {
      void this.loadBoundary(layerId, entry.settings.boundaryDataId ?? '', entry.settings.boundarySource ?? 'mapinfo', entry.map)
    }
  }

  /**
   * 加载边界多边形（缓存优先，否则按来源拉取）并重绘使用该边界的图层。
   * - mapinfo（图层文件）：优先用地图数据缓存的 GeoJSON，否则调图层数据接口
   * - excel（地理化数据）：拉行数据，行内 path 已是 GCJ02 的 [[lat,lng],...]
   */
  private async loadBoundary(layerId: string, dataId: string, source: 'mapinfo' | 'excel', map: L.Map): Promise<void> {
    this.boundaryLoading.set(layerId, Date.now())
    let polygons: HeatBoundary | null = null
    // 边界图层数据是否真的取到了：取到但无面（非面图层）→ 结果可缓存；
    // 没取到（图层尚未加载进缓存、缺少 dataId、请求失败）→ 不缓存，留待下次重放重试
    let dataAvailable = false
    try {
      if (source === 'excel') {
        const resp = await dataApi.get(dataId)
        dataAvailable = !!resp?.data
        polygons = collectGeoDataPolygons(resp.data)
      } else {
        let geojson = useMapDataCacheStore.getState().layers[layerId]?.geojson
        if (!geojson && dataId) {
          const resp = await layerApi.getLayerData(dataId, layerId)
          if (resp.success && resp.data) geojson = resp.data
        }
        dataAvailable = !!geojson
        polygons = collectBoundaryPolygons(geojson)
      }
    } catch (e) {
      console.error('[HeatmapLayerManager] 边界图层加载失败:', layerId, e)
    }
    this.boundaryLoading.delete(layerId)
    // 关键：加载失败/数据未就绪时不缓存 null，否则"渲染边界一直不生效"且不再重试
    if (polygons || dataAvailable) this.boundaries.set(layerId, polygons)
    if (polygons) {
      for (const entry of this.entries.values()) {
        if (entry.map === map && entry.settings.boundaryLayerId === layerId) this.paint(entry)
      }
    }
  }
}

/**
 * 全局共享的热力管理器。
 *
 * 地图实例本身在页面切换时被缓存复用（见 OnlineMap 的 __sharedMapCache），
 * 热力管理器若按组件实例创建，切出页面会丢弃已渲染栅格/统计/边界缓存，
 * 返回时需要完整重算（IDW 插值渲染数秒）且图例统计为空。
 * 改为全局单例后：栅格随地图保留（页面切换时仅摘下覆盖层），返回即恢复。
 */
let __sharedHeatmapManager: HeatmapLayerManager | null = null
export function getSharedHeatmapManager(): HeatmapLayerManager {
  if (!__sharedHeatmapManager) __sharedHeatmapManager = new HeatmapLayerManager()
  return __sharedHeatmapManager
}
