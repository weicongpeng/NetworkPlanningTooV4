/**
 * Cesium 图层文件渲染器（一个图层文件 = 一个 CustomDataSource）。
 *
 * 数据：已转 WGS84 的 GeoJSON FeatureCollection。
 * 对等 MapInfoLayer / GeoDataLayer 的图层级能力：
 * - 点（固定像素圆点，黑边）/ 线（贴地线）/ 面（贴地面 + 贴地边框线）
 * - 颜色设置（colorSettings）、专题配色（per feature）、标签、选中红框
 * - 「无色」填充（NO_FILL_COLOR）：只画边框
 */
import {
  getFieldValue,
  matchThematicColor,
  NO_FILL_COLOR,
} from '../../../utils/fieldValue'
import type { LayerColorSettings, LabelSettings, ThematicSettings } from '../LabelSettingsModal'
import {
  geometryAnchor,
  polygonOuterRings,
  featureSelectionId,
  simplifyRingOrLine,
} from './cesiumGeoJson'
import { sameSelection, type CameraView } from './CesiumSectorLayer'
import type { LabelCandidateBase } from '../labelLayoutCore'
import { perfStart, perfEnd } from './cesiumPerf'

/** 单图层的标签候选上限（按离视野中心近的优先保留） */
const MAX_LABEL_CANDIDATES = 2000
/**
 * 视口裁剪的要素数阈值：超过才裁。
 *
 * 阈值以下的小图层（TAC 边界、装饰图层等常见场景）全量渲染，行为与优化前完全一致；
 * 超过的大图层只建视野内图元 —— 否则万级要素的图层每次重建都要把全部几何重新
 * 三角化一遍，平移/缩放后要卡几百毫秒到数秒（"叠加自定义图层后卡顿"的主因）。
 */
const VIEWPORT_CULL_MIN_FEATURES = 2000
/**
 * 视野外扩比例（相对视野跨度）。
 *
 * 比扇区层的 15% 更宽松：GeoJSON 重建同样只在相机停下时发生，外扩大一些可让
 * "只平移了一小段"的场景不发生重建、也不缺要素。
 */
const VIEW_PADDING_RATIO = 0.5
/**
 * 分块渲染参数（仅面/线；点仍走全局 PointPrimitiveCollection）。
 *
 * 导入图层的主要成本是"每次视野变化把整层几何重新三角化 + 重建贴地图元"。
 * 按空间网格切成若干块后：视野变化只重建进出视口的块，其余块直接复用；
 * 图元用 `asynchronous: true` 把三角化交给 Cesium worker，主线程只做实例包装；
 * 新图元就绪后才摘旧图元（双缓冲），避免历史上"异步构建中被 remove"的渲染崩溃。
 */
const CHUNK_MIN_FEATURES = 1500
const CHUNK_TARGET_FEATURES = 500
const CHUNK_GRID_MAX = 12
/** 块级视口外扩（比按要素裁剪粗一档，避免块边缘反复进出） */
const CHUNK_VIEW_PADDING_RATIO = 0.25
/** 已构建块缓存上限：超出按"最久未可见"淘汰，控制显存 */
const MAX_BUILT_CHUNKS = 40
/** 每帧最多构建的块数（把主线程实例包装摊到多帧） */
const CHUNK_BUILD_BUDGET = 2
/** 抽稀容差上下界（度）：1e-6°≈0.11m，5e-4°≈55m */
const SIMPLIFY_TOLERANCE_MIN = 1e-6
const SIMPLIFY_TOLERANCE_MAX = 5e-4
/**
 * 选中态描边色（与 2D `setSelectionHighlight` 的 `color:'#ef4444'` 同色）。
 * 2D 只改描边、不动填充，3D 同口径 —— 见 render() 里的说明。
 */
const SELECTED_STROKE_COLOR = '#ef4444'
import { computeThematicStats, type ThematicStats } from '../../../utils/thematicStats'

/** 配置对象内容比较：store 每次可能给出新引用，内容没变不应触发整层重建 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

type Position = number[]

interface GeoFeature {
  type: string
  geometry?: { type: string; coordinates: unknown }
  properties?: Record<string, unknown>
}
interface FeatureCollection {
  features: GeoFeature[]
}

/**
 * 要素自带样式：后端从 TAB/MIF/KML 逐要素读出后注入到 `properties._style`（扁平结构）。
 * 字段口径见 `backend/app/services/mapinfo_service.py`（`properties['_style'] = style_info`）。
 */
interface FeatureStyle {
  /** 点：图形颜色 */
  markerColor?: string
  /** 点：图形大小（半径） */
  markerSize?: number
  strokeColor?: string
  strokeWidth?: number
  strokeOpacity?: number
  fillColor?: string
  fillOpacity?: number
  /** KML `<fill>0</fill>`：文件声明无填充 */
  fill?: boolean
}

type GeomKind = 'point' | 'line' | 'polygon'

/** 几何类型 → 归类（无法归类的一律跳过，与旧 switch 的 default 分支同结果） */
function geomKindOf(type: string): GeomKind | null {
  if (type === 'Point' || type === 'MultiPoint') return 'point'
  if (type === 'LineString' || type === 'MultiLineString') return 'line'
  if (type === 'Polygon' || type === 'MultiPolygon') return 'polygon'
  return null
}

/**
 * 按类型取出"点/线/环"列表。
 * 点：[[lng,lat],...]；线：[[点...],...]；面：只取外环（与 polygonOuterRings 一致）。
 */
function extractGeoms(g: { type: string; coordinates: unknown }, kind: GeomKind): Position[][] {
  const c = g.coordinates as any
  if (kind === 'point') return g.type === 'Point' ? [c] : c
  if (kind === 'line') return g.type === 'LineString' ? [c] : c
  return polygonOuterRings(g)
}

/**
 * 视野量化键（与 CesiumSectorLayer.viewKey 同思路）：平移按跨度 1/20 分档、
 * zoom 按 0.5 步长分档。只有"真正改变裁剪结果"的视野变化才重建 —— 视野外扩有
 * VIEW_PADDING_RATIO 余量，阈值之间的微小移动不会缺要素。
 */
function geoViewKey(view: CameraView): string {
  const spanLat = Math.max(1e-6, view.north - view.south)
  const spanLng = Math.max(1e-6, view.east - view.west)
  const qx = Math.round(view.west / (spanLng / 20))
  const qy = Math.round(view.south / (spanLat / 20))
  return `${Math.round(view.zoom * 2)}|${qx}|${qy}`
}

/** 要素包围盒是否与视野（含外扩）相交 */
function bboxInView(
  pf: { west: number; south: number; east: number; north: number },
  view: CameraView,
): boolean {
  const padLat = (view.north - view.south) * VIEW_PADDING_RATIO
  const padLng = (view.east - view.west) * VIEW_PADDING_RATIO
  return pf.west <= view.east + padLng && pf.east >= view.west - padLng
    && pf.south <= view.north + padLat && pf.north >= view.south - padLat
}

/** 预整理后的要素（换数据时算一次；重建只做图元构建，不重复抽稀/算包围盒） */
interface PreparedFeature {
  /** 在 fc.features 里的下标（选中标识/拾取标识要用） */
  fi: number
  feature: GeoFeature
  kind: GeomKind
  /** 点：[[lng,lat],...]；线：[[点...],...]；面：[外环,...]（线/环均已抽稀） */
  geoms: Position[][]
  /** WGS84 包围盒（按抽稀前的原始点计算，是保守超集，裁剪判定不会漏） */
  south: number
  west: number
  north: number
  east: number
}

interface ChunkBounds { south: number; west: number; north: number; east: number }

/** 空间分块：一块 = 一批相邻面/线要素 + 自己的贴地图元 */
interface GeoChunk {
  id: string
  features: PreparedFeature[]
  bounds: ChunkBounds
  /** 当前挂在地图上的图元（面/线各至多一个） */
  primitives: any[]
  /** 构建时的样式签名；与当前不一致说明需要重建 */
  signature: string
  /** 当前是否应显示 */
  visible: boolean
  /** 上次写入的 show 值（避免重复设置） */
  shown: boolean
  /** 是否已在构建队列（防重复入队） */
  queued: boolean
  /** 最近一次可见的帧序号（LRU 淘汰用） */
  lastVisibleTick: number
}

function unionBounds(features: PreparedFeature[]): ChunkBounds {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity
  for (const f of features) {
    if (f.south < south) south = f.south
    if (f.west < west) west = f.west
    if (f.north > north) north = f.north
    if (f.east > east) east = f.east
  }
  return { south, west, north, east }
}

/** 块包围盒是否与视野（含块级外扩）相交 */
function chunkInView(bounds: ChunkBounds, view: CameraView): boolean {
  const padLat = (view.north - view.south) * CHUNK_VIEW_PADDING_RATIO
  const padLng = (view.east - view.west) * CHUNK_VIEW_PADDING_RATIO
  return bounds.west <= view.east + padLng && bounds.east >= view.west - padLng
    && bounds.south <= view.north + padLat && bounds.north >= view.south - padLat
}

/** 与 2D `MapInfoLayer.DEFAULT_STYLES` 一致的默认值（填充不透明度一律 100%） */
const DEFAULT_BY_KIND: Record<GeomKind, {
  fill: string; stroke: string; width: number; fillOpacity: number; pointSize: number
}> = {
  point: { fill: '#f59e0b', stroke: NO_FILL_COLOR, width: 2, fillOpacity: 1, pointSize: 6 },
  line: { fill: '#8b5cf6', stroke: '#8b5cf6', width: 3, fillOpacity: 1, pointSize: 0 },
  polygon: { fill: '#10b981', stroke: '#10b981', width: 2, fillOpacity: 1, pointSize: 0 },
}

/** 单要素最终配色 */
interface ResolvedFeatureStyle {
  fillColor: string
  fillOpacity: number
  noFill: boolean
  strokeColor: string
  strokeWidth: number
  noStroke: boolean
  /** 线/点透明度（作用于描边） */
  strokeOpacity: number
  pointSize: number
}

export class CesiumGeoJsonLayer {
  private fc: FeatureCollection = { features: [] }
  private visible = true
  private color: LayerColorSettings | null = null
  private labelEnabled = false
  private label: LabelSettings | null = null
  private thematic: ThematicSettings | null = null
  private selectionIds: Set<string> | null = null

  private viewer: any
  /**
   * 预整理后的要素（换数据时算一次：抽稀 + 包围盒）。
   * render() 只从这里建图元，不再每次遍历原始 FC。
   */
  private prepared: PreparedFeature[] = []
  /** 当前视野（setView 推入）；null = 不裁剪（全量渲染） */
  private view: CameraView | null = null
  /** 视野分档键：与上次相同就不重建（见 geoViewKey） */
  private lastViewKey = ''
  /**
   * 重建序号：每次「请求重建」或「立即重建」都 +1，挂起的 rAF 回调序号对不上就放弃。
   * 用来合并同一帧内的多次配置变更——后面那次会覆盖前面那次，避免重复重建。
   */
  private renderSeq = 0

  /** 空间分块（仅面/线；点无三角化成本，仍走全局 PointPrimitiveCollection） */
  private chunks: GeoChunk[] = []
  /** 待构建块队列（每帧限量，把实例包装摊到多帧） */
  private buildQueue: GeoChunk[] = []
  private drainScheduled = false
  /** 渲染帧序号：块缓存 LRU 淘汰用 */
  private tick = 0
  /** 样式签名：数据/配色/专题变化时递增，已建块据此判断是否过期 */
  private dataVersion = 0
  private styleVersion = 0
  /**
   * 选中集合版本：选中态走**独立红色描边批次**，不让所有块失效
   * （否则每次搜索/框选都要把整层重三角化一遍）。
   */
  private selectionVersion = 0
  private selectionBuiltVersion = -1
  private selectionPrimitives: any[] = []
  /** 点图元（全局，含选中描边） */
  private pointsPrimitive: any = null
  private destroyed = false

  constructor(private C: any, viewer: any, readonly layerId: string) {
    this.viewer = viewer
  }

  private styleSignature(): string {
    return `${this.dataVersion}.${this.styleVersion}`
  }

  private removePrimitiveSafely(p: any): void {
    const collection = this.viewer?.scene?.primitives
    if (!collection || !p) return
    try { collection.remove(p) } catch { /* ignore */ }
  }

  /**
   * 延迟摘除图元。
   *
   * 异步图元在 worker 构建期间被 remove，会让 Cesium 拿已销毁的纹理/批处理继续渲染
   * （历史 `_target` 崩溃）。这里等 `readyPromise` 完成后再摘，构建中的旧图元同理。
   */
  private retirePrimitives(primitives: any[]): void {
    for (const p of primitives) {
      if (!p) continue
      if (p.ready === false && typeof p.readyPromise?.then === 'function') {
        p.readyPromise
          .then(() => this.removePrimitiveSafely(p))
          .catch(() => this.removePrimitiveSafely(p))
      } else {
        this.removePrimitiveSafely(p)
      }
    }
  }

  /** 新图元就绪后再摘旧图元（双缓冲，避免重建期间出现空白帧） */
  private retireAfterReplacement(old: any[], replacement: any[]): void {
    if (old.length === 0) return
    const pending = replacement
      .filter((p) => p?.ready === false && typeof p.readyPromise?.then === 'function')
      .map((p) => p.readyPromise.catch(() => undefined))
    if (pending.length === 0) {
      this.retirePrimitives(old)
      return
    }
    Promise.all(pending).then(() => this.retirePrimitives(old))
  }

  /** 图层卸载：释放图元 */
  destroy(): void {
    this.destroyed = true
    this.renderSeq += 1
    this.buildQueue = []
    for (const chunk of this.chunks) {
      this.retirePrimitives(chunk.primitives)
      chunk.primitives = []
    }
    this.chunks = []
    this.retirePrimitives(this.selectionPrimitives)
    this.selectionPrimitives = []
    if (this.pointsPrimitive) this.retirePrimitives([this.pointsPrimitive])
    this.pointsPrimitive = null
  }

  /**
   * 请求重建（rAF 合并）。
   * 连续多个 setter（可见性 → 配色 → 专题 → 标签 → 选中）原来会各自触发一次全量重建，
   * 上千要素时等于同一帧重建四五遍。合并后一帧只重建一次，也避免在调用栈里同步增删
   * `scene.primitives`（Cesium 在集合被改的瞬间迭代会抛 `_target` 相关错误）。
   */
  private requestRender(): void {
    const seq = ++this.renderSeq
    requestAnimationFrame(() => {
      if (seq !== this.renderSeq) return // 已被后续一次重建覆盖
      if (!this.destroyed) this.render()
    })
  }

  /**
   * 换数据立即重建（同步）。首屏只构建视野内的块（其余块按需构建）。
   * 取数完成的时机天然低频，且上层的要素收集/热力取点紧接着就要用新的要素集合，
   * 推迟到下一帧会让这些读路径拿到旧数据。
   */
  setFeatureCollection(fc: FeatureCollection): void {
    if (this.destroyed) return
    this.fc = fc
    this.prepare()
    this.dataVersion += 1
    this.renderSeq += 1 // 作废挂起中的重建，避免紧随其后又重建一遍
    this.render()
  }

  /**
   * 预整理要素（换数据时算一次）。
   *
   * - 按类型归组"点/线/环"（面只取外环）
   * - 线/环做 Douglas-Peucker 抽稀：MapInfo/地理化边界动辄上万点，城市级视野下
   *   一屏只有几百像素，通常可减到 10~30% 的点，视觉差异极小（仅影响 3D 渲染几何，
   *   2D / 命中 / 标签 / 热力取点仍用原始坐标）
   * - 记录 WGS84 包围盒（视口裁剪用）
   */
  private prepare(): void {
    this.prepared = []
    for (let fi = 0; fi < this.fc.features.length; fi++) {
      const feature = this.fc.features[fi]
      const g = feature.geometry
      if (!g) continue
      const kind = geomKindOf(g.type)
      if (!kind) continue
      const raw = extractGeoms(g, kind)
      if (raw.length === 0) continue
      let south = Infinity
      let west = Infinity
      let north = -Infinity
      let east = -Infinity
      const visit = (lng: number, lat: number): void => {
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
        if (lng < west) west = lng
        if (lng > east) east = lng
        if (lat < south) south = lat
        if (lat > north) north = lat
      }
      if (kind === 'point') {
        // 点要素的 raw 元素本身就是 [lng,lat]（比线/面少一层，见 extractGeoms）
        for (const p of raw as unknown as Position[]) visit(p[0], p[1])
      } else {
        // 线/面要素的 raw 元素是点数组
        for (const geom of raw) {
          for (const p of geom) visit(p[0], p[1])
        }
      }
      if (!Number.isFinite(west)) continue
      let geoms = raw
      if (kind !== 'point') {
        // 容差 = 要素对角线 / 2000（相对误差 0.05%），封顶 5e-4 度（≈55m）：
        // 大边界允许的绝对误差大一些，小图形保持精细
        const diag = Math.hypot(east - west, north - south)
        const tol = Math.min(SIMPLIFY_TOLERANCE_MAX, Math.max(SIMPLIFY_TOLERANCE_MIN, diag / 2000))
        geoms = raw.map((geom) => simplifyRingOrLine(geom, tol, kind === 'polygon'))
      }
      this.prepared.push({ fi, feature, kind, geoms, south, west, north, east })
    }
    this.rebuildChunks()
  }

  /**
   * 按空间网格重建分块（换数据时一次）。
   *
   * 面/线要素按包围盒中心落入网格；每块目标 ~CHUNK_TARGET_FEATURES 个要素、格数封顶。
   * 小图层（≤CHUNK_MIN_FEATURES）保持单块、不按视野裁剪，行为与优化前一致。
   */
  private rebuildChunks(): void {
    for (const chunk of this.chunks) this.retirePrimitives(chunk.primitives)
    this.chunks = []
    this.buildQueue = []
    const heavy = this.prepared.filter((pf) => pf.kind !== 'point')
    if (heavy.length === 0) return
    if (heavy.length <= CHUNK_MIN_FEATURES) {
      this.chunks.push({
        id: 'all', features: heavy, bounds: unionBounds(heavy),
        primitives: [], signature: '', visible: true, shown: false, queued: false, lastVisibleTick: 0,
      })
      return
    }
    const all = unionBounds(heavy)
    const n = Math.max(1, Math.min(
      CHUNK_GRID_MAX,
      Math.ceil(Math.sqrt(heavy.length / CHUNK_TARGET_FEATURES)),
    ))
    const cellW = Math.max(1e-9, (all.east - all.west) / n)
    const cellH = Math.max(1e-9, (all.north - all.south) / n)
    const cells = new Map<string, PreparedFeature[]>()
    for (const pf of heavy) {
      const cx = Math.min(n - 1, Math.max(0, Math.floor(((pf.west + pf.east) / 2 - all.west) / cellW)))
      const cy = Math.min(n - 1, Math.max(0, Math.floor(((pf.south + pf.north) / 2 - all.south) / cellH)))
      const key = `${cx}_${cy}`
      const list = cells.get(key)
      if (list) list.push(pf)
      else cells.set(key, [pf])
    }
    for (const [id, features] of cells) {
      this.chunks.push({
        id, features, bounds: unionBounds(features),
        primitives: [], signature: '', visible: true, shown: false, queued: false, lastVisibleTick: 0,
      })
    }
  }

  /**
   * 推入当前视野（宿主在相机停下 / syncAll 时调用）。
   *
   * 视口裁剪：要素数超过阈值的图层只建"视野内（含外扩）"的图元，重建时机与扇区图层
   * 一致（只在相机停下后，移动中不重建）。阈值以下的小图层 setView 不触发重建 ——
   * 全量渲染，视野变化不影响结果。
   */
  setView(view: CameraView | null): void {
    const key = view ? geoViewKey(view) : ''
    if (key === this.lastViewKey) return
    this.lastViewKey = key
    this.view = view
    // 分块图层按视野增删块；大要素图层（点裁剪）也依赖视野；小图层全量渲染不受影响
    if (this.chunks.length > 1 || this.prepared.length > VIEWPORT_CULL_MIN_FEATURES) {
      this.requestRender()
    }
  }
  /** 当前要素集合（WGS84）——供圈选/点选按几何收集命中要素 */
  getFeatures(): GeoFeature[] {
    return this.fc.features
  }

  /** 专题图例统计（与 2D 同算法，保证两边图例数字一致） */
  getThematicStats(): ThematicStats | null {
    return computeThematicStats(
      this.thematic,
      this.fc.features.map((f) => (f.properties ?? {}) as Record<string, any>))
  }
  isVisible(): boolean {
    return this.visible
  }
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    // 隐藏只切 show（块图元保留复用）；点图元直接摘掉
    if (!visible) {
      for (const chunk of this.chunks) this.applyChunkShown(chunk, false)
      this.applySelectionShown(false)
      if (this.pointsPrimitive) this.retirePrimitives([this.pointsPrimitive])
      this.pointsPrimitive = null
    } else {
      this.applySelectionShown(true)
      this.requestRender()
    }
  }
  setColorSettings(color: LayerColorSettings | null): void {
    if (sameJson(this.color, color)) return
    this.color = color
    this.styleVersion += 1
    this.requestRender()
  }
  setLabel(enabled: boolean, label: LabelSettings | null): void {
    // 标签由 Canvas 覆盖层绘制，与几何无关：只更新配置，不重建图元
    this.labelEnabled = enabled
    this.label = label
  }
  setThematic(thematic: ThematicSettings | null): void {
    if (sameJson(this.thematic, thematic)) return
    this.thematic = thematic
    this.styleVersion += 1
    this.requestRender()
  }
  /**
   * 选中集合（+ 当前视野）。
   *
   * 宿主 `syncAll()` 每次相机停下都会重推一遍，所以集合没变就**直接返回**、不再重建 ——
   * 否则每次平移/缩放后都要把上千个要素的贴地图元全量重建一遍，是"缩放/平移卡顿"的
   * 主要来源之一。
   */
  setSelectionIds(ids: Set<string> | null): void {
    if (sameSelection(this.selectionIds, ids)) return
    this.selectionIds = ids
    this.selectionVersion += 1
    this.requestRender()
  }

  /**
   * 本图层当前的标签候选（WGS84）。
   * 与扇区层同口径：交给 `CesiumLabelOverlay` 统一防重叠绘制，不再建 Cesium 标签图元。
   *
   * **必须先按视口裁剪**：地理化数据常有几万个点，不裁剪的话全量候选会在覆盖层被
   * "候选上限"按要素顺序截断 —— 于是放大地图后，视口内的要素反而一个标签都没有。
   * 超过上限时按"离视野中心近的优先"保留（与扇区层 sampleCenteredOn 同思路）。
   */
  labelCandidates(view: CameraView | null): LabelCandidateBase[] {
    if (!this.visible || !this.labelEnabled || !this.label) return []
    const ls = this.label
    // 视口外扩 15%（与 CesiumSectorLayer.pickSectors 同口径）
    let south = -90, north = 90, west = -180, east = 180
    let cLat = 0, cLng = 0
    if (view) {
      const padLat = (view.north - view.south) * 0.15
      const padLng = (view.east - view.west) * 0.15
      south = view.south - padLat
      north = view.north + padLat
      west = view.west - padLng
      east = view.east + padLng
      cLat = (view.south + view.north) / 2
      cLng = (view.west + view.east) / 2
    }
    const out: LabelCandidateBase[] = []
    for (let fi = 0; fi < this.fc.features.length; fi++) {
      const f = this.fc.features[fi]
      if (!f.geometry || !f.properties) continue
      const anchor = geometryAnchor(f.geometry)
      if (!anchor) continue
      const lng = anchor[0]
      const lat = anchor[1]
      if (lng < west || lng > east || lat < south || lat > north) continue
      const value = getFieldValue(f.properties, ls.content)
      if (value === undefined || value === null) continue
      const text = String(value)
      if (!text) continue
      const sid = featureSelectionId(f.properties, this.layerId, fi)
      out.push({
        id: sid,
        lat,
        lng,
        text,
        fontSize: ls.fontSize || 12,
        fontFamily: ls.fontFamily,
        bold: ls.bold,
        italic: ls.italic,
        shadow: ls.shadow,
        background: ls.background,
        backgroundColor: ls.backgroundColor,
        color: ls.color || '#000000',
        priority: this.selectionIds?.has(sid) ? 10 : 0,
      })
    }
    if (out.length <= MAX_LABEL_CANDIDATES) return out
    return out
      .map((c) => ({ c, d: (c.lat - cLat) ** 2 + (c.lng - cLng) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_LABEL_CANDIDATES)
      .map((e) => e.c)
  }

  /**
   * 批量更新配置（合并后只 render 一次）。
   *
   * 按值比较去重：`syncGeoJsonLayers` 会在任一 store 配置变化时推给**所有**图层，
   * 若每次无条件重建，切换一个图层的显隐/标签就会把所有已打开图层重新三角化一遍。
   */
  applyConfig(cfg: {
    visible?: boolean
    color?: LayerColorSettings | null
    thematic?: ThematicSettings | null
    labelEnabled?: boolean
    label?: LabelSettings | null
  }): void {
    let styleChanged = false
    if (cfg.visible !== undefined && cfg.visible !== this.visible) {
      this.setVisible(cfg.visible)
    }
    if (cfg.color !== undefined && !sameJson(cfg.color, this.color)) {
      this.color = cfg.color
      this.styleVersion += 1
      styleChanged = true
    }
    if (cfg.thematic !== undefined && !sameJson(cfg.thematic, this.thematic)) {
      this.thematic = cfg.thematic
      this.styleVersion += 1
      styleChanged = true
    }
    // 标签只影响 Canvas 覆盖层（syncLabels 负责刷新），不参与图元重建
    if (cfg.labelEnabled !== undefined) this.labelEnabled = cfg.labelEnabled
    if (cfg.label !== undefined) this.label = cfg.label
    if (styleChanged && this.visible) this.requestRender()
  }

  /**
   * 单要素最终配色。
   *
   * 合并优先级与 2D `MapInfoLayer` **完全一致**：
   * **渲染默认值 < 要素自带 `_style` < 图层级用户设置(colorSettings) < 专题**。
   *
   * 关键：**`defaultStyle`（字段 `base`）不参与渲染配色**。
   * 后端 `MapInfoParser._get_layer_default_style` 在命名规则未命中时会用
   * `_palette_color(图层名)` 返回**按图层名固定的一种颜色**（`mapinfo_service.py:1419-1428`）。
   * 早先这里写的是 `user ?? base ?? _style ?? def`，那一层 `base` 会无条件盖掉
   * 逐要素的 `_style`（MapInfo 各要素 Brush/Pen 色、KML <Style>、RSRP 分级色…），
   * 表现就是「整层被刷成同一种颜色」——例如按 RSRP 分级着色的多段配色全变绿。
   * 2D 从来不把 `defaultStyle` 放进渲染链（它只在图层控制里作为颜色设置弹窗的初始值出现），
   * 这里保持同口径即可让 3D 与 2D 一致。
   */
  private resolveFeatureStyle(feature: GeoFeature, kind: GeomKind): ResolvedFeatureStyle {
    const fs = (((feature.properties ?? {}) as Record<string, unknown>)._style ?? {}) as FeatureStyle
    const user = this.color
    const def = DEFAULT_BY_KIND[kind]

    // 用户设置的"图形颜色"（面/点填充、线的颜色来源）
    const userFill = user?.fillColor

    let fillColor: string
    let strokeColor: string
    let strokeOpacity: number

    if (kind === 'line') {
      // 线无填充：用户设置里线色取"图形颜色"，兼容旧版把线色存在 borderColor
      const userLineColor = user?.borderColor && user.borderColor !== NO_FILL_COLOR
        ? user.borderColor
        : userFill
      fillColor = userLineColor ?? fs.strokeColor ?? def.stroke
      strokeColor = fillColor
      strokeOpacity = user?.fillOpacity ?? fs.strokeOpacity ?? fs.fillOpacity ?? def.fillOpacity
    } else {
      fillColor = userFill ?? fs.fillColor ?? fs.markerColor ?? def.fill
      strokeColor = user?.borderColor ?? fs.strokeColor ?? def.stroke
      strokeOpacity = user?.fillOpacity ?? fs.strokeOpacity ?? def.fillOpacity
    }

    let fillOpacity = user?.fillOpacity ?? fs.fillOpacity ?? def.fillOpacity
    let strokeWidth = user?.borderWidth ?? fs.strokeWidth ?? def.width
    let pointSize = user?.pointSize ?? fs.markerSize ?? def.pointSize

    // 专题：填充色/透明度/边框色/图形大小覆盖（与 2D 的专题优先级一致）
    if (this.thematic?.enabled) {
      if (this.thematic.field && feature.properties) {
        const c = matchThematicColor(
          this.thematic, getFieldValue(feature.properties, this.thematic.field))
        if (c) { fillColor = c; if (kind === 'line') strokeColor = c }
      }
      if (typeof this.thematic.fillOpacity === 'number') fillOpacity = this.thematic.fillOpacity
      if (this.thematic.borderColor) strokeColor = this.thematic.borderColor
      // 「图形大小」：点要素=点大小，线/面=边框宽度（2D MapInfoLayer / GeoDataLayer 同语义）
      if (typeof this.thematic.pointSize === 'number') {
        if (kind === 'point') pointSize = this.thematic.pointSize
        else strokeWidth = this.thematic.pointSize
      }
    }

    // KML 声明无填充且用户未自定义 → 不填充（只画边框）
    const noFill = fillColor === NO_FILL_COLOR
      || (kind !== 'line' && fs.fill === false && userFill === undefined)
    // 边框色为"无色"哨兵 → 不描边
    const noStroke = strokeColor === NO_FILL_COLOR

    return {
      fillColor: fillColor === NO_FILL_COLOR ? def.fill : fillColor,
      fillOpacity,
      noFill,
      strokeColor: noStroke ? def.stroke : strokeColor,
      strokeWidth,
      noStroke,
      strokeOpacity,
      pointSize,
    }
  }

  private render(): void {
    const perf = perfStart()
    if (this.destroyed) return
    if (!this.visible) {
      for (const chunk of this.chunks) this.applyChunkShown(chunk, false)
      this.applySelectionShown(false)
      return
    }
    if (!this.viewer?.scene?.primitives) return
    this.tick += 1

    // 点：无三角化成本，仍走全局 PointPrimitiveCollection（大图层按视野裁剪、选中强制渲染）
    this.rebuildPoints()

    const sig = this.styleSignature()
    // 分块图层按视野裁剪；单块小图层全量渲染，行为与优化前一致
    const cullView = this.chunks.length > 1 ? this.view : null
    for (const chunk of this.chunks) {
      const visible = !cullView || chunkInView(chunk.bounds, cullView)
      chunk.visible = visible
      if (visible) chunk.lastVisibleTick = this.tick
      const built = chunk.primitives.length > 0 && chunk.signature === sig
      if (built) {
        this.applyChunkShown(chunk, visible)
        continue
      }
      // 样式过期：旧图元先顶着（双缓冲，新图元就绪后再摘）；不可见则先隐藏
      if (chunk.primitives.length > 0) this.applyChunkShown(chunk, visible)
      if (visible && !chunk.queued) {
        chunk.queued = true
        this.buildQueue.push(chunk)
      }
    }

    this.trimChunkCache()
    this.drainBuildQueue()
    // 选中描边最后建（独立批次，选中变化不会让任何块失效；后画的覆盖先画的）
    this.rebuildSelectionIfNeeded()
    this.raiseSelectionToTop()
    perfEnd(
      'GeoJsonLayer.render', perf,
      `${this.layerId} ${this.prepared.length} features / ${this.chunks.length} chunks`,
    )
  }

  /** 设置块可见性：只切 show，不重建几何 */
  private applyChunkShown(chunk: GeoChunk, visible: boolean): void {
    chunk.visible = visible
    if (chunk.shown === visible) return
    chunk.shown = visible
    for (const p of chunk.primitives) {
      try { p.show = visible } catch { /* ignore */ }
    }
  }

  /** 每帧限量构建，剩余排队到下一帧（避免手势结束一次产生几百毫秒长任务） */
  private drainBuildQueue(): void {
    if (this.destroyed || !this.visible) return
    let built = 0
    while (this.buildQueue.length > 0 && built < CHUNK_BUILD_BUDGET) {
      const chunk = this.buildQueue.shift()!
      chunk.queued = false
      if (!chunk.visible || this.destroyed || !this.visible) continue
      this.buildChunk(chunk)
      built += 1
    }
    if (this.buildQueue.length > 0 && !this.drainScheduled) {
      this.drainScheduled = true
      requestAnimationFrame(() => {
        this.drainScheduled = false
        this.drainBuildQueue()
      })
    }
  }

  /** 构建一个块的面/线图元（异步构建 + 双缓冲替换） */
  private buildChunk(chunk: GeoChunk): void {
    const C = this.C
    const collection = this.viewer?.scene?.primitives
    if (!collection) return
    const polygons: any[] = []
    const polylines: any[] = []
    for (const pf of chunk.features) {
      const st = this.resolveFeatureStyle(pf.feature, pf.kind)
      const sid = featureSelectionId(pf.feature.properties, this.layerId, pf.fi)
      /**
       * 拾取用标识：批量图元把它挂在 GeometryInstance.id / 图元 .id 上。
       * `selectionId` 必须带出来：点选高亮按它写选中态，而图层要素普遍没有 properties.id。
       */
      const pickId = { feature: pf.feature, layerId: this.layerId, selectionId: sid }
      const strokeW = st.strokeWidth
      if (pf.kind === 'line') {
        for (const line of pf.geoms) {
          if (line.length < 2) continue
          polylines.push(new C.GeometryInstance({
            geometry: new C.GroundPolylineGeometry({
              positions: C.Cartesian3.fromDegreesArray(line.flatMap((p) => p)),
              width: strokeW,
            }),
            attributes: {
              color: C.ColorGeometryInstanceAttribute.fromColor(
                C.Color.fromCssColorString(st.strokeColor).withAlpha(st.strokeOpacity)),
            },
            id: pickId,
          }))
        }
        continue
      }
      if (pf.kind !== 'polygon') continue
      for (const ring of pf.geoms) {
        if (ring.length < 3) continue
        const positions = C.Cartesian3.fromDegreesArray(ring.flatMap((p) => p))
        /**
         * 面图元**始终**建（"无色填充"时给一个近乎全透明的 alpha）。
         * 面图元同时承担"点击命中区域"的职责：不建面就只剩贴地边框线，
         * 线的命中宽度只有几个像素（见原实现说明）。
         */
        polygons.push(new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(positions),
            vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              C.Color.fromCssColorString(st.fillColor)
                .withAlpha(st.noFill ? 0.01 : st.fillOpacity)),
          },
          id: pickId,
        }))
        if (!st.noStroke) {
          polylines.push(new C.GeometryInstance({
            geometry: new C.GroundPolylineGeometry({ positions, width: strokeW }),
            attributes: {
              color: C.ColorGeometryInstanceAttribute.fromColor(
                C.Color.fromCssColorString(st.strokeColor)),
            },
            id: pickId,
          }))
        }
      }
    }

    const newPrimitives: any[] = []
    try {
      if (polygons.length > 0) {
        newPrimitives.push(collection.add(new C.GroundPrimitive({
          geometryInstances: polygons,
          appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true }),
          /**
           * 分块后每批图元较小，异步构建把三角化交给 worker，主线程只做实例包装。
           * 旧图元在新图元 ready 后才摘（retireAfterReplacement），不会重演
           * "worker 构建中被 remove → `_target` 崩溃"。
           */
          asynchronous: true,
        })))
      }
      if (polylines.length > 0) {
        newPrimitives.push(collection.add(new C.GroundPolylinePrimitive({
          geometryInstances: polylines,
          appearance: new C.PolylineColorAppearance(),
          asynchronous: true,
        })))
      }
    } catch (e) {
      console.warn('[CesiumGeoJsonLayer] 分块图元创建失败:', this.layerId, chunk.id, e)
      this.retirePrimitives(newPrimitives)
      return
    }
    const old = chunk.primitives
    chunk.primitives = newPrimitives
    chunk.signature = this.styleSignature()
    chunk.shown = chunk.visible
    for (const p of newPrimitives) {
      try { p.show = chunk.visible } catch { /* ignore */ }
    }
    this.retireAfterReplacement(old, newPrimitives)
    this.raiseSelectionToTop()
  }

  /** 点图元：全局一个 PointPrimitiveCollection（大图层按视野裁剪、选中强制渲染） */
  private rebuildPoints(): void {
    const C = this.C
    const collection = this.viewer?.scene?.primitives
    if (!collection) return
    if (this.pointsPrimitive) {
      this.retirePrimitives([this.pointsPrimitive])
      this.pointsPrimitive = null
    }
    const points: Array<{ opts: any; id: any }> = []
    const cullView = this.prepared.length > VIEWPORT_CULL_MIN_FEATURES ? this.view : null
    for (const pf of this.prepared) {
      if (pf.kind !== 'point') continue
      const sid = featureSelectionId(pf.feature.properties, this.layerId, pf.fi)
      const selected = this.selectionIds?.has(sid) ?? false
      // 视野外且未选中的点不建图元；选中态必须保留（跨视野选中/定位场景）
      if (cullView && !selected && !bboxInView(pf, cullView)) continue
      const st = this.resolveFeatureStyle(pf.feature, pf.kind)
      const pickId = { feature: pf.feature, layerId: this.layerId, selectionId: sid }
      for (const p of pf.geoms) {
        points.push({
          id: pickId,
          opts: {
            position: C.Cartesian3.fromDegrees(p[0], p[1]),
            pixelSize: st.pointSize,
            color: C.Color.fromCssColorString(st.fillColor)
              .withAlpha(st.noFill ? 0 : st.fillOpacity),
            outlineColor: C.Color.fromCssColorString(
              selected ? SELECTED_STROKE_COLOR : st.strokeColor),
            outlineWidth: st.noStroke && !selected ? 0 : st.strokeWidth,
            // PointPrimitive 无 heightReference，用"始终画在最上层"达到同等可见性
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        })
      }
    }
    if (points.length === 0) return
    const coll = new C.PointPrimitiveCollection()
    for (const p of points) coll.add({ ...p.opts, id: p.id })
    coll.show = this.visible
    this.pointsPrimitive = collection.add(coll)
  }

  /**
   * 选中要素的红色描边（面/线）：独立批次、最后绘制（等价 2D 的 bringToFront）。
   * 选中只换描边色、宽度沿用原描边宽，填充保持原色（与 2D `setSelectionHighlight` 同口径）。
   */
  private rebuildSelectionIfNeeded(): void {
    if (this.selectionBuiltVersion === this.selectionVersion) return
    this.selectionBuiltVersion = this.selectionVersion
    const C = this.C
    const collection = this.viewer?.scene?.primitives
    const old = this.selectionPrimitives
    this.selectionPrimitives = []
    if (!collection || !this.selectionIds || this.selectionIds.size === 0) {
      this.retirePrimitives(old)
      return
    }
    const outlines: any[] = []
    for (const pf of this.prepared) {
      if (pf.kind === 'point') continue
      const sid = featureSelectionId(pf.feature.properties, this.layerId, pf.fi)
      if (!this.selectionIds.has(sid)) continue
      const st = this.resolveFeatureStyle(pf.feature, pf.kind)
      const pickId = { feature: pf.feature, layerId: this.layerId, selectionId: sid }
      const addLine = (line: Position[]): void => {
        if (line.length < 2) return
        outlines.push(new C.GeometryInstance({
          geometry: new C.GroundPolylineGeometry({
            positions: C.Cartesian3.fromDegreesArray(line.flatMap((p) => p)),
            width: st.strokeWidth,
          }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              C.Color.fromCssColorString(SELECTED_STROKE_COLOR)),
          },
          id: pickId,
        }))
      }
      if (pf.kind === 'line') pf.geoms.forEach(addLine)
      else pf.geoms.forEach((ring) => { if (ring.length >= 3) addLine(ring) })
    }
    if (outlines.length === 0) {
      this.retirePrimitives(old)
      return
    }
    try {
      const prim = collection.add(new C.GroundPolylinePrimitive({
        geometryInstances: outlines,
        appearance: new C.PolylineColorAppearance(),
        asynchronous: true,
      }))
      this.selectionPrimitives = [prim]
      this.retireAfterReplacement(old, this.selectionPrimitives)
    } catch (e) {
      console.warn('[CesiumGeoJsonLayer] 选中描边创建失败:', this.layerId, e)
      this.retirePrimitives(old)
    }
  }

  private applySelectionShown(visible: boolean): void {
    for (const p of this.selectionPrimitives) {
      try { p.show = visible } catch { /* ignore */ }
    }
  }

  /** 选中红边框必须画在所有块之上 */
  private raiseSelectionToTop(): void {
    const collection = this.viewer?.scene?.primitives
    if (!collection) return
    for (const p of this.selectionPrimitives) {
      try { collection.raiseToTop?.(p) } catch { /* ignore */ }
    }
  }

  /** 已构建块超过上限时，按"最久未可见"淘汰（控制显存） */
  private trimChunkCache(): void {
    const built = this.chunks.filter((c) => c.primitives.length > 0)
    if (built.length <= MAX_BUILT_CHUNKS) return
    const evictable = built
      .filter((c) => !c.visible)
      .sort((a, b) => a.lastVisibleTick - b.lastVisibleTick)
    let excess = built.length - MAX_BUILT_CHUNKS
    for (const chunk of evictable) {
      if (excess <= 0) break
      this.retirePrimitives(chunk.primitives)
      chunk.primitives = []
      chunk.shown = false
      excess -= 1
    }
  }
}
