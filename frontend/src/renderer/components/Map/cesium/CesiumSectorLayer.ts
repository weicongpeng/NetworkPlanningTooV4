/**
 * Cesium 扇区图层（对应 LTE 或 NR）——用 CustomDataSource 管理贴地扇区。
 *
 * 对等 SectorRendererSVG 的核心能力：
 * - 视口剔除（computeViewRectangle）+ 远距 LOD 采样
 * - 白名单（规划模式只渲染名单内扇区）
 * - 选中红框高亮（selection ids）
 * - 标签（字段内容，含 PCI 规划模式）
 *
 * 几何直接用 RenderSectorData 的 WGS84 originalLat/Lng（无需坐标转换）。
 */
import { getCellCoverStyle, type NetworkType } from '../../../config/sector-config'
import type { RenderSectorData } from '../../../services/mapDataService'
import {
  resolveSectorStyle,
  getSectorPCI,
  type SectorStyleContext,
} from './cesiumSectorStyle'
import { resolvePlanningStyle, type PlanningHighlight } from './cesiumHighlight'
import type { LabelSettings } from '../LabelSettingsModal'
import type { LabelCandidateBase } from '../labelLayoutCore'
import { computeThematicStats, type ThematicStats } from '../../../utils/thematicStats'

const METERS_PER_LAT = 111319.9

/** 平地近似终点（复刻 SectorRenderer._fastDestination），输入/输出 WGS84 */
function fastDestination(
  lat: number, lng: number, azimuthDeg: number, distance: number,
): [number, number] {
  const az = (azimuthDeg * Math.PI) / 180
  const dLat = (distance * Math.cos(az)) / METERS_PER_LAT
  const dLng = (distance * Math.sin(az)) /
    (METERS_PER_LAT * Math.cos((lat * Math.PI) / 180))
  return [lat + dLat, lng + dLng]
}

/** 扇区闭合环（WGS84 [lat,lng][]，首尾相接） */
function sectorRing(
  sector: RenderSectorData, radius: number, arcSegments: number,
): [number, number][] {
  const cover = getCellCoverStyle(sector.cell_cover_type, sector.networkType)
  const lat = sector.originalLat
  const lng = sector.originalLng

  if (cover.isCircular) {
    const pts: [number, number][] = []
    for (let i = 0; i <= arcSegments; i++) {
      pts.push(fastDestination(lat, lng, (360 / arcSegments) * i, radius))
    }
    return pts
  }

  const beamwidth = sector.beamwidth || cover.angle
  const half = beamwidth / 2
  const startAz = sector.azimuth - half
  const endAz = sector.azimuth + half

  const pts: [number, number][] = [[lat, lng], fastDestination(lat, lng, startAz, radius)]
  for (let i = 1; i < arcSegments; i++) {
    pts.push(fastDestination(lat, lng, startAz + ((endAz - startAz) / arcSegments) * i, radius))
  }
  pts.push(fastDestination(lat, lng, endAz, radius))
  pts.push([lat, lng])
  return pts
}

/** 当前相机视野（WGS84 经纬度范围 + 等价 Leaflet zoom） */
export interface CameraView {
  south: number
  north: number
  west: number
  east: number
  zoom: number
  /**
   * 某点处的米/像素（3D 透视：按该点到相机的距离换算）。
   * 不提供时回退到 Web Mercator 的 zoom 公式（与高德侧一致）。
   */
  metersPerPixelAt?: (lat: number, lng: number) => number
}

// ===== 扇区视觉尺寸：与 SectorRendererSVG 保持一致 =====
/** 室外扇区在屏幕上的目标半径（像素）；室内取一半 */
const TARGET_PIXEL_RADIUS_OUTDOOR = 16
/** 物理半径上下限（米），避免极端缩放下的过小/过大 */
const MIN_SECTOR_RADIUS_M = 5
const MAX_SECTOR_RADIUS_M = 5000
/** 邻区高亮的源/目标扇区放大倍数（覆盖初始扇区的黑边框） */
const NEIGHBOR_HIGHLIGHT_SCALE = 1.15
/** 低于此 zoom 不画扇区边框（对齐 SectorRendererSVG 的 LOD showStroke） */
const STROKE_MIN_ZOOM = 12
/**
 * 单次重建的扇区数硬上限。超过时按"离视野中心近的优先"采样。
 * 目的是给重建代价封顶：否则大网规模下每次相机停下都要建上万条几何，缩放/平移必然卡。
 */
export const MAX_RENDER_SECTORS = 4000

/**
 * 以视野中心为圆心、由近及远取前 `limit` 个（近似：按到中心的平方距离排序）。
 * 比等距抽样更符合直觉——用户看的是屏幕中心。
 */
export function sampleCenteredOn(
  list: RenderSectorData[], view: CameraView, limit: number,
): RenderSectorData[] {
  const cLat = (view.south + view.north) / 2
  const cLng = (view.west + view.east) / 2
  const dist2 = (x: RenderSectorData) =>
    (x.originalLat - cLat) ** 2 + (x.originalLng - cLng) ** 2
  return list
    .map((x) => ({ x, d: dist2(x) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((e) => e.x)
}

/** Web Mercator zoom 0 赤道每像素米数 */
const EQUATOR_MPP = 156543.03392
/**
 * 米/像素的量化档位数（每档 2^1/32 ≈ 2.2%）。
 *
 * 透视下"某点的米/像素"随相机位置连续变化，扇区半径 = 目标像素 × 米/像素，
 * 于是**任何**相机移动（哪怕只是平移或旋转）都会让半径变一点 → 几何全变 → 整个重建。
 * 把米/像素量化到 2.2% 档位后：
 * - 档内半径完全一致 → 平移/旋转/微缩放**不触发重建**（这是卡顿的大头）
 * - 视觉上扇区尺寸偏差 ≤2.2%，肉眼不可辨
 */
const MPP_BUCKETS_PER_ZOOM = 32

/** 量化档位索引（zoom 的 1/32 分档，向上取整避免 0 附近震荡） */
function mppBucketIndex(mpp: number): number {
  if (!Number.isFinite(mpp) || mpp <= 0) return 0
  return Math.max(0, Math.round(Math.log2(EQUATOR_MPP / mpp) * MPP_BUCKETS_PER_ZOOM))
}

/** 档位索引 → 该档的米/像素 */
function mppOfBucket(idx: number): number {
  return EQUATOR_MPP / Math.pow(2, idx / MPP_BUCKETS_PER_ZOOM)
}

/**
 * 某点的米/像素（已量化到 2.2% 档位）。
 * 优先用相机透视换算后量化；无透视信息时回退 Web Mercator zoom 公式（本身就是整数档）。
 */
export function metersPerPixelQuantized(mppAt: () => number): number {
  return mppOfBucket(mppBucketIndex(mppAt()))
}

function metersPerPixel(view: CameraView, lat: number, lng: number): number {
  if (view.metersPerPixelAt) return metersPerPixelQuantized(() => view.metersPerPixelAt!(lat, lng))
  return mppOfBucket(mppBucketIndex(
    (EQUATOR_MPP * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, view.zoom)))
}

/**
 * 扇区物理半径（米）：恒定屏幕像素半径 × 该点米/像素，钳制后室内取一半。
 * 导出供单测锁定与 SectorRendererSVG（高德侧）的一致性。
 */
export function sectorRadius(
  sector: RenderSectorData, view: CameraView, magnify: boolean,
): number {
  const cover = getCellCoverStyle(sector.cell_cover_type, sector.networkType)
  const mpp = metersPerPixel(view, sector.originalLat, sector.originalLng)
  const outdoor = Math.max(
    MIN_SECTOR_RADIUS_M,
    Math.min(MAX_SECTOR_RADIUS_M, TARGET_PIXEL_RADIUS_OUTDOOR * mpp),
  )
  const base = cover.isCircular ? outdoor / 2 : outdoor
  return magnify ? base * NEIGHBOR_HIGHLIGHT_SCALE : base
}

/** 弧线采样点数（对齐 SectorRendererSVG._getArcPointsCount） */
export function arcPointsCount(zoom: number, pciPlanning: boolean): number {
  if (pciPlanning) return zoom <= 12 ? 6 : zoom <= 15 ? 8 : 10
  if (zoom <= 12) return 12
  if (zoom <= 15) return 20
  if (zoom <= 17) return 30
  return 40
}
/** 圆形采样点数（对齐 SectorRendererSVG._getCirclePointsCount） */
export function circlePointsCount(zoom: number, pciPlanning: boolean): number {
  if (pciPlanning) return 8
  if (zoom <= 12) return 20
  if (zoom <= 15) return 32
  if (zoom <= 17) return 48
  return 64
}

export class CesiumSectorLayer {
  private viewer: any
  /** 扇区面（贴地，按 PerInstanceColor 批量） */
  private fillPrimitive: any = null
  /** 扇区边框（贴地折线，按 PerInstanceColor 批量） */
  private outlinePrimitive: any = null
  private allSectors: RenderSectorData[] = []
  private whitelist: Set<string> | null = null
  private selectionIds: Set<string> | null = null
  private visible = true
  private labelsEnabled = false
  private labelSettings: LabelSettings | null = null
  private renderMode: string = 'default'
  private ctx: SectorStyleContext = {}
  private highlight: PlanningHighlight = {}
  /**
   * 配置是否变过（任一 setter 写入即置位）。
   * `update()` 只在"配置变了"或"视野明显移动了"时才重建几何 —— 同步路径（热力重放、
   * 选中态刷新等）会频繁调 `syncAll()` → `update()`，没有这个判断就会反复重建
   * 几千个扇区的几何，是"3D 缩放/平移卡顿"的直接来源。
   */
  private configDirty = true
  /** 上次重建时的视野量化键 */
  private lastViewKey = ''
  /**
   * 扇区几何缓存（`sectorId|半径|采样数` → Cartesian3 顶点数组）。
   *
   * 量化档位让同一个扇区在相邻缩放档之间几何完全一致，缩放来回时可以直接复用，
   * 省掉 `Cartesian3.fromDegreesArray` + `PolygonGeometry` + `GeometryInstance` 的重复创建。
   * 上限封顶，超限整体清空（简单可控，避免无界增长）。
   */
  private geomCache = new Map<string, any[]>()
  private static readonly GEOM_CACHE_MAX = 12000

  constructor(
    private C: any,
    viewer: any,
    private networkType: NetworkType,
  ) {
    this.viewer = viewer
  }

  /** 释放批量图元（重建前 / 卸载时） */
  private clearPrimitives(): void {
    const primitives = this.viewer?.scene?.primitives
    if (!primitives) return
    if (this.fillPrimitive) { primitives.remove(this.fillPrimitive); this.fillPrimitive = null }
    if (this.outlinePrimitive) { primitives.remove(this.outlinePrimitive); this.outlinePrimitive = null }
  }

  /** 图层卸载：释放图元 */
  destroy(): void {
    this.clearPrimitives()
  }

  setRenderData(sectors: RenderSectorData[]): void {
    this.allSectors = sectors
    this.configDirty = true
  }
  /** 全部扇区（圈选按几何收集时用，不做视口剔除） */
  getAllSectors(): RenderSectorData[] {
    return this.allSectors
  }

  /**
   * 本图层当前的标签候选（WGS84）。
   *
   * 标签不再走 Cesium 的逐要素 Entity/LabelCollection —— 那些标签既不防重叠，
   * 又要跟着相机停下时的 `removeAll()` 一起全量重建（卡顿主因之一）。
   * 现在只把候选交给 `CesiumLabelOverlay`，在屏幕空间统一避让后批量画到一张 Canvas 上。
   */
  labelCandidates(view: CameraView): LabelCandidateBase[] {
    if (!this.visible || !this.labelsEnabled || !this.labelSettings) return []
    const ls = this.labelSettings
    const out: LabelCandidateBase[] = []
    for (const sector of this.pickSectors(view)) {
      const text = this.labelText(sector)
      if (!text) continue
      out.push({
        id: String(sector.id),
        lat: sector.originalLat,
        lng: sector.originalLng,
        text,
        fontSize: ls.fontSize || 12,
        fontFamily: ls.fontFamily,
        bold: ls.bold,
        italic: ls.italic,
        shadow: ls.shadow,
        background: ls.background,
        backgroundColor: ls.backgroundColor,
        color: ls.color || '#000000',
        // 选中的要素优先占位（与 2D SectorRendererSVG 的 priority=10 一致）
        priority: this.isSelected(sector) ? 10 : 0,
      })
    }
    return out
  }

  /** 专题图例统计（与 2D 同算法，保证两边图例数字一致） */
  getThematicStats(): ThematicStats | null {
    return computeThematicStats(
      this.ctx.thematic, this.allSectors as unknown as Array<Record<string, any>>)
  }
  isVisible(): boolean {
    return this.visible
  }
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.configDirty = true
  }
  setWhitelist(whitelist: Set<string> | null): void {
    this.whitelist = whitelist
    this.configDirty = true
  }
  setSelectionIds(ids: Set<string> | null): void {
    this.selectionIds = ids
    this.configDirty = true
  }
  setLabels(enabled: boolean, settings: LabelSettings | null): void {
    this.labelsEnabled = enabled
    this.labelSettings = settings
  }
  setRenderMode(mode: string): void {
    if (this.renderMode === mode) return
    this.renderMode = mode
    this.configDirty = true
  }
  setStyleContext(ctx: SectorStyleContext): void {
    this.ctx = ctx
    this.configDirty = true
  }
  setHighlight(highlight: PlanningHighlight): void {
    this.highlight = highlight
    this.configDirty = true
  }

  private inWhitelist(sector: RenderSectorData): boolean {
    if (!this.whitelist) return true
    return this.whitelist.has(String(sector.id))
  }

  private isSelected(sector: RenderSectorData): boolean {
    if (!this.selectionIds) return false
    const id = String(sector.id)
    const composite = sector.siteId && sector.sectorId
      ? `${sector.siteId}_${sector.sectorId}`
      : null
    return this.selectionIds.has(id)
      || (!!composite && this.selectionIds.has(composite))
      || (!!sector.name && this.selectionIds.has(sector.name))
  }

  private labelText(sector: RenderSectorData): string {
    if (this.renderMode === 'pci-planning') {
      return `${sector.name || ''} (PCI: ${getSectorPCI(sector) ?? '-'})`
    }
    const field = this.labelSettings?.content || 'name'
    const value = (sector as unknown as Record<string, unknown>)[field]
    return value === undefined || value === null ? '' : String(value)
  }

  /** 视口内 + LOD 采样后的待渲染扇区（结果条数有硬上限，保证单次重建代价可控） */
  private pickSectors(view: CameraView): RenderSectorData[] {
    const padLat = (view.north - view.south) * 0.15
    const padLng = (view.east - view.west) * 0.15
    const south = view.south - padLat
    const north = view.north + padLat
    const west = view.west - padLng
    const east = view.east + padLng

    let list = this.allSectors.filter((x) =>
      x.originalLat >= south && x.originalLat <= north &&
      x.originalLng >= west && x.originalLng <= east &&
      this.inWhitelist(x))

    // 远距 LOD 均匀采样（低 zoom 时减少图形数）
    const step = view.zoom < 10 ? 4 : view.zoom < 12 ? 2 : 1
    if (step > 1) list = list.filter((_, i) => i % step === 0)

    // 硬上限：单次重建的几何量有界，避免大网规模下"每次缩放都要建上万图元"
    if (list.length > MAX_RENDER_SECTORS) {
      list = sampleCenteredOn(list, view, MAX_RENDER_SECTORS)
    }
    return list
  }

  /**
   * 按当前相机视野重建图形。
   *
   * **用批量图元而非逐 Entity**：原来每个扇区建 2~3 个 `Entity`（面 + 边框 + 标签），
   * 每次相机停下都 `entities.removeAll()` + 全量重建。`Entity` 是重量级抽象（PropertyBag、
   * 集合事件、逐实体图元），几千个扇区时每次重建要几百毫秒到秒级 —— 这是 3D 缩放/平移卡顿的主因。
   * 现在面与边框各自合成**一个** `GroundPrimitive` / `GroundPolylinePrimitive`，
   * 逐实例颜色走 `ColorGeometryInstanceAttribute`，拾取走 `GeometryInstance.id = { sector }`。
   * 标签仍用 Entity（数量少、且 Cesium 标签本就无批量接口）。
   */
  /**
   * 视野量化键：把视野平移量按跨度的 1/20 分档，并把米/像素档位一并纳入。
   * 小幅平移 / 旋转 / 微缩放都不触发重建（视口剔除本来就有 15% 外扩余量，边缘不会缺图形）。
   */
  private viewKey(view: CameraView): string {
    const spanLat = Math.max(1e-6, view.north - view.south)
    const spanLng = Math.max(1e-6, view.east - view.west)
    const qx = Math.round(view.west / (spanLng / 20))
    const qy = Math.round(view.south / (spanLat / 20))
    // 视野中心处的米/像素档位：跨档才意味着"尺寸真的变了"，需要重建
    const cLat = (view.south + view.north) / 2
    const cLng = (view.west + view.east) / 2
    const mppIdx = mppBucketIndex(metersPerPixel(view, cLat, cLng))
    return `${Math.round(view.zoom)}|${mppIdx}|${qx}|${qy}`
  }

  update(view: CameraView): void {
    const C = this.C
    const viewKey = this.viewKey(view)
    // 配置没变且视野没实质移动：这次重建可以整个省掉
    if (!this.configDirty && viewKey === this.lastViewKey) return
    this.configDirty = false
    this.lastViewKey = viewKey

    this.clearPrimitives()

    if (!this.visible) return

    const sectors = this.pickSectors(view)
    const pciPlanning = this.renderMode === 'pci-planning'
    // 要素极多时降采样弧/圆：全场几万个顶点会把重建拖到秒级，视觉上几乎看不出差别
    const dense = sectors.length > 1500
    const arcSegments = dense
      ? Math.min(arcPointsCount(view.zoom, pciPlanning), 12)
      : arcPointsCount(view.zoom, pciPlanning)
    const circleSegments = dense
      ? Math.min(circlePointsCount(view.zoom, pciPlanning), 16)
      : circlePointsCount(view.zoom, pciPlanning)
    const showStroke = view.zoom >= STROKE_MIN_ZOOM

    const fills: any[] = []
    const outlines: any[] = []

    for (const sector of sectors) {
      const cover = getCellCoverStyle(sector.cell_cover_type, sector.networkType)
      const selected = this.isSelected(sector)
      // 邻区高亮的源/目标扇区放大（与 SectorRendererSVG._updateSectorShapes 一致）
      const nh = this.highlight.neighbor
      const magnify = !!nh && this.renderMode === 'neighbor-planning' && (
        String(sector.id) === String(nh.sourceSectorId)
        || nh.targetSectorIds.has(String(sector.id)))
      const radius = sectorRadius(sector, view, magnify)
      const segments = cover.isCircular ? circleSegments : arcSegments
      const ring = sectorRing(sector, radius, segments)
      const style = resolvePlanningStyle(sector, this.renderMode, this.highlight)
        ?? resolveSectorStyle(sector, this.ctx)
      const strokeCss = selected ? '#ef4444' : style.strokeColor
      const strokeWidth = selected ? 4 : style.strokeWidth

      // 顶点数组按「扇区 + 半径档 + 采样数」缓存：量化后同档几何一致，缩放来回可直接复用
      const geomKey = `${sector.id}|${Math.round(radius)}|${segments}|${magnify ? 1 : 0}`
      let positions = this.geomCache.get(geomKey)
      if (!positions) {
        const verts = C.Cartesian3.fromDegreesArray(ring.flatMap((p) => [p[1], p[0]]))
        if (this.geomCache.size >= CesiumSectorLayer.GEOM_CACHE_MAX) this.geomCache.clear()
        this.geomCache.set(geomKey, verts)
        positions = verts
      }

      fills.push(new C.GeometryInstance({
        geometry: new C.PolygonGeometry({
          polygonHierarchy: new C.PolygonHierarchy(positions),
          vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(
            C.Color.fromCssColorString(style.fillColor).withAlpha(style.fillOpacity)),
        },
        // 拾取时 scene.pick 返回的 id 即此对象
        id: { sector },
      }))

      // 贴地面不支持 outline，边框另画贴地线；低 zoom 与高德一致不画边框（选中态除外）
      if (showStroke || selected) {
        outlines.push(new C.GeometryInstance({
          geometry: new C.GroundPolylineGeometry({ positions, width: strokeWidth }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              C.Color.fromCssColorString(strokeCss)),
          },
          id: { sector },
        }))
      }

    }

    const primitives = this.viewer?.scene?.primitives
    if (!primitives) return
    try {
      if (fills.length > 0) {
        this.fillPrimitive = primitives.add(new C.GroundPrimitive({
          geometryInstances: fills,
          appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true }),
          // 同步构建：我们重建频繁，异步会产生中间态闪烁
          asynchronous: false,
        }))
      }
      if (outlines.length > 0) {
        this.outlinePrimitive = primitives.add(new C.GroundPolylinePrimitive({
          geometryInstances: outlines,
          appearance: new C.PolylineColorAppearance(),
          asynchronous: false,
        }))
      }
    } catch (e) {
      // 设备不支持贴地图元等情况下不让整层崩掉
      console.warn('[CesiumSectorLayer] 批量图元创建失败:', e)
      this.clearPrimitives()
    }
  }

  getNetworkType(): NetworkType {
    return this.networkType
  }
}
