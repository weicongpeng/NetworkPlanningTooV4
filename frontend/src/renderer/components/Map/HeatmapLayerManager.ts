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
import { DEFAULT_HEATMAP_SETTINGS, type HeatmapSettings } from './LabelSettingsModal'
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
} from '../../utils/heatmap'
import { buildValueMapper, collectBoundaryPolygons, collectGeoDataPolygons, probeFieldDistribution, quantizeLevel, renderHeatSurface, type HeatBoundary } from '../../utils/heatSurface'
import { DEG2RAD, EARTH_RADIUS, buildHeatField, nearestNeighborDistances, projectToMercator, unprojectFromMercator, type HeatField } from '../../utils/heatField'

/** Mercator 米范围 → 地理范围（度） */
function mercatorBoundsToLatLng(minX: number, minY: number, maxX: number, maxY: number): { west: number; south: number; east: number; north: number } {
  const sw = unprojectFromMercator(minX, minY)
  const ne = unprojectFromMercator(maxX, maxY)
  return { west: sw.lng, south: sw.lat, east: ne.lng, north: ne.lat }
}
import { useMapDataCacheStore } from '../../store/mapDataCacheStore'
import { layerApi, dataApi } from '../../services/api'

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
  /** 插值场（建桶结果）：颜色分级标定与栅格渲染共用同一个场 */
  field: HeatField | null
  /** 值 → 色带位置 的固定映射，同样与视口无关 */
  mapValue: (value: number) => number
  /** 渲染代际（异步取图回写时校验，防止旧图覆盖新图） */
  generation: number
  /** 已渲染栅格的地理范围（= 图层数据外接矩形，与视口无关） */
  bounds: L.LatLngBounds
  /** 已注入的 blob URL（下次渲染前释放） */
  objectUrl: string | null
}

export class HeatmapLayerManager {
  private entries = new Map<string, HeatEntry>()
  /** 边界图层多边形缓存：key=图层 id，值 null 表示该图层不是面或无数据 */
  private boundaries = new Map<string, HeatBoundary | null>()
  /** 正在加载的边界图层 id，避免重复请求 */
  private boundaryLoading = new Set<string>()

  /**
   * 应用/更新某图层的热力渲染。
   * 无有效点时移除既有热力层并返回 null。
   */
  apply(map: L.Map, layerId: string, points: HeatPoint[], settings: HeatmapSettings): Promise<HeatmapStats | null> {
    const normalized = normalizeHeatPoints(points)
    if (normalized.points.length === 0) {
      this.remove(layerId)
      return Promise.resolve(null)
    }

    // 图例统计中与渲染无关的部分（levels 要等映射函数算好后才能定）
    const baseStats = {
      min: normalized.min,
      max: normalized.max,
      count: normalized.count,
      sampled: normalized.sampled,
      field: settings.field,
    }

    const existing = this.entries.get(layerId)
    const entry: HeatEntry = existing && existing.map === map
      ? existing
      : {
        layerId,
        overlay: L.imageOverlay(EMPTY_TILE, map.getBounds(), { interactive: false }).addTo(map),
        map,
        stats: { ...baseStats, levels: [], fieldDistribution: new Float64Array(0) },
        points: normalized.points,
        settings,
        radiusMeters: 0,
        pointRadii: new Float64Array(0),
        field: null,
        mapValue: (v: number) => v,
        generation: 0,
        bounds: map.getBounds(),
        objectUrl: null,
      }
    entry.points = normalized.points
    entry.settings = settings
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
    const globalR = Math.max(p90, densityR * 0.6) * smooth
    const cap = globalR * 1.5
    const pointRadii = new Float64Array(nn.length)
    for (let i = 0; i < nn.length; i++) {
      pointRadii[i] = Math.min(Math.max(nn[i] * smooth, globalR), cap)
    }
    entry.radiusMeters = globalR
    entry.pointRadii = pointRadii
    // 颜色分级的基准分布：取**渲染出来的插值场**的取值分布（按桶面积等权），
    // 而不是原始采样点分布——插值会把邻域值平均掉，两种分布差很远，
    // 用后者定分位时整幅图只用得到色带中段（分级设了几个都只显一两种颜色）。
    // 细节增强内建于场（整体趋势场 ↔ 细节场凸组合，见 heatField.buildHeatField）：
    // probe/图例标定与渲染共用同一个场，严格同源
    const field = buildHeatField(
      normalized.points,
      globalR,
      pointRadii,
      settings.detail ?? DEFAULT_HEATMAP_SETTINGS.detail!,
      settings.sampling ?? DEFAULT_HEATMAP_SETTINGS.sampling
    )
    entry.field = field
    const distribution = field ? buildQuantileRef(probeFieldDistribution(field)) : new Float64Array(0)
    const method = settings.method ?? 'cellCount'
    const contrast = settings.contrast ?? DEFAULT_HEATMAP_SETTINGS.contrast
    // 用户手工编辑过分级 → 以 (值, 色带位置) 锚点做分段映射；
    // 否则用自动映射（纯分位 / 线性）。两者都是"值→色带位置"，图例与地图共用同一个函数。
    // "等效细胞计数"下占比才是用户表达的意图，故各级取值一律由基准分布在 t 处反算，
    // 不复用编辑时存档的值（那是设置弹窗按采样样本估的，与地图全量数据不同源）
    const customLevels: HeatLegendOverride[] | null = normalizeLegendOverrides(settings.levels, method, distribution)
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
    // 分级着色：把连续色带位置量化到图例的 N 级（等值线感）。
    // 包在 mapValue 外层 → 地图着色、图例各级 colorT、弹窗预览全部自动量化一致
    const discreteLevels = settings.discrete
      ? Math.max(2, settings.inflections ?? DEFAULT_HEATMAP_SETTINGS.inflections!)
      : 0
    const finalMapValue = discreteLevels >= 2
      ? (v: number) => quantizeLevel(mapValue(v), discreteLevels)
      : mapValue
    entry.mapValue = finalMapValue
    // 分级图例与渲染走同一套分级与同一映射函数，
    // 图例色块不会列出地图上不存在的颜色（重复值/退化值域下尤其明显）
    entry.stats = {
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

  /** 将热力栅格提到 overlayPane 顶部（保证压在图形层之上） */
  bringToFront(layerId: string): void {
    const el = (this.entries.get(layerId)?.overlay as any)?._image as HTMLElement | undefined
    if (el?.parentNode) el.parentNode.appendChild(el)
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

  /** 地图销毁时清理（可选限定 map） */
  removeAll(map?: L.Map): void {
    for (const [id, entry] of Array.from(this.entries)) {
      if (map && entry.map !== map) continue
      this.remove(id)
    }
    if (!map) {
      this.boundaries.clear()
      this.boundaryLoading.clear()
    }
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
    // 数据范围（Mercator 米），外扩全局半径的 1.5 倍作为边缘渐隐带
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const p of entry.points) {
      const m = projectToMercator(p.lat, p.lng)
      if (m.x < minX) minX = m.x
      if (m.x > maxX) maxX = m.x
      if (m.y < minY) minY = m.y
      if (m.y > maxY) maxY = m.y
    }
    const pad = entry.radiusMeters * 1.5
    minX -= pad
    maxX += pad
    minY -= pad
    maxY += pad
    const spanX = maxX - minX
    const spanY = maxY - minY
    if (!(spanX > 0) || !(spanY > 0)) return
    // 分辨率：长边适配预算（与视口无关），短边按纵横比
    const budget = MAX_SIDE
    const spanMax = Math.max(spanX, spanY)
    const width = Math.max(64, Math.min(MAX_SIDE, Math.round((spanX / spanMax) * budget)))
    const height = Math.max(64, Math.min(MAX_SIDE, Math.round((spanY / spanMax) * budget)))
    const boundary = entry.settings.boundaryLayerId
      ? this.getBoundary(entry.settings, entry.map)
      : null
    const dataBounds = mercatorBoundsToLatLng(minX, minY, maxX, maxY)
    const canvas = renderHeatSurface({
      points: entry.points,
      // 复用标定时建的场：既省一次建桶，又保证渲染与分级标定严格同源
      field: entry.field,
      min: entry.stats.min,
      max: entry.stats.max,
      mapValue: entry.mapValue,
      // 色带：有自定义级色时按分级锚点重建（含颜色方向镜像：自定义色注册到镜像位），
      // 保证地图配色与图例色块一致
      lut: buildGradientLut(resolveLevelGradient(
        resolveHeatGradient(entry.settings.colorScheme, entry.settings.colorDirection),
        entry.stats.levels,
        entry.settings.colorDirection
      )),
      radius: entry.radiusMeters,
      pointRadii: entry.pointRadii,
      bounds: dataBounds,
      width,
      height,
      opacity: entry.settings.opacity ?? 1,
      boundary,
    })

    // 栅格地理范围固定：只需设一次边界（数据/设置变化会重走 paint）
    const bounds = L.latLngBounds([dataBounds.south, dataBounds.west], [dataBounds.north, dataBounds.east])
    entry.overlay.setBounds(bounds)
    entry.bounds = bounds

    if (!canvas) {
      this.releaseObjectUrl(entry)
      entry.overlay.setUrl(EMPTY_TILE)
      return
    }
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
    if (!this.boundaryLoading.has(layerId)) {
      void this.loadBoundary(layerId, settings.boundaryDataId ?? '', settings.boundarySource ?? 'mapinfo', map)
    }
    return null
  }

  /**
   * 加载边界多边形（缓存优先，否则按来源拉取）并重绘使用该边界的图层。
   * - mapinfo（图层文件）：优先用地图数据缓存的 GeoJSON，否则调图层数据接口
   * - excel（地理化数据）：拉行数据，行内 path 已是 GCJ02 的 [[lat,lng],...]
   */
  private async loadBoundary(layerId: string, dataId: string, source: 'mapinfo' | 'excel', map: L.Map): Promise<void> {
    this.boundaryLoading.add(layerId)
    let polygons: HeatBoundary | null = null
    try {
      if (source === 'excel') {
        const resp = await dataApi.get(dataId)
        polygons = collectGeoDataPolygons(resp.data)
      } else {
        let geojson = useMapDataCacheStore.getState().layers[layerId]?.geojson
        if (!geojson && dataId) {
          const resp = await layerApi.getLayerData(dataId, layerId)
          if (resp.success && resp.data) geojson = resp.data
        }
        polygons = collectBoundaryPolygons(geojson)
      }
    } catch (e) {
      console.error('[HeatmapLayerManager] 边界图层加载失败:', layerId, e)
    }
    this.boundaryLoading.delete(layerId)
    this.boundaries.set(layerId, polygons)
    for (const entry of this.entries.values()) {
      if (entry.map === map && entry.settings.boundaryLayerId === layerId) this.paint(entry)
    }
  }
}
