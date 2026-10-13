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

/** 某点的米/像素：优先用相机透视换算，否则回退 Web Mercator zoom 公式 */
function metersPerPixel(view: CameraView, lat: number, lng: number): number {
  if (view.metersPerPixelAt) return view.metersPerPixelAt(lat, lng)
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, view.zoom)
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
  /** 标签专用数据源（面/边框已改批量图元，不再走 Entity） */
  readonly dataSource: any
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

  constructor(
    private C: any,
    viewer: any,
    private networkType: NetworkType,
  ) {
    this.viewer = viewer
    this.dataSource = new C.CustomDataSource('sector-labels-' + networkType)
    viewer.dataSources.add(this.dataSource)
  }

  /** 释放批量图元（重建前 / 卸载时） */
  private clearPrimitives(): void {
    const primitives = this.viewer?.scene?.primitives
    if (!primitives) return
    if (this.fillPrimitive) { primitives.remove(this.fillPrimitive); this.fillPrimitive = null }
    if (this.outlinePrimitive) { primitives.remove(this.outlinePrimitive); this.outlinePrimitive = null }
  }

  /** 图层卸载：释放图元与标签 */
  destroy(): void {
    this.clearPrimitives()
    try { this.viewer?.dataSources?.remove(this.dataSource) } catch { /* ignore */ }
  }

  setRenderData(sectors: RenderSectorData[]): void {
    this.allSectors = sectors
  }
  /** 全部扇区（圈选按几何收集时用，不做视口剔除） */
  getAllSectors(): RenderSectorData[] {
    return this.allSectors
  }
  isVisible(): boolean {
    return this.visible
  }
  setVisible(visible: boolean): void {
    this.visible = visible
  }
  setWhitelist(whitelist: Set<string> | null): void {
    this.whitelist = whitelist
  }
  setSelectionIds(ids: Set<string> | null): void {
    this.selectionIds = ids
  }
  setLabels(enabled: boolean, settings: LabelSettings | null): void {
    this.labelsEnabled = enabled
    this.labelSettings = settings
  }
  setRenderMode(mode: string): void {
    this.renderMode = mode
  }
  setStyleContext(ctx: SectorStyleContext): void {
    this.ctx = ctx
  }
  setHighlight(highlight: PlanningHighlight): void {
    this.highlight = highlight
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
  update(view: CameraView): void {
    const C = this.C
    this.clearPrimitives()
    this.dataSource.entities.removeAll()

    if (!this.visible) return

    const sectors = this.pickSectors(view)
    const pciPlanning = this.renderMode === 'pci-planning'
    const arcSegments = arcPointsCount(view.zoom, pciPlanning)
    const circleSegments = circlePointsCount(view.zoom, pciPlanning)
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

      const ring = sectorRing(sector, radius, cover.isCircular ? circleSegments : arcSegments)
      const style = resolvePlanningStyle(sector, this.renderMode, this.highlight)
        ?? resolveSectorStyle(sector, this.ctx)
      const strokeCss = selected ? '#ef4444' : style.strokeColor
      const strokeWidth = selected ? 4 : style.strokeWidth

      const positions = C.Cartesian3.fromDegreesArray(
        ring.flatMap((p) => [p[1], p[0]]))

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

      if (this.labelsEnabled && this.labelSettings) {
        const text = this.labelText(sector)
        if (text) {
          const ls = this.labelSettings
          const labelEntity = new C.Entity({
            position: C.Cartesian3.fromDegrees(sector.originalLng, sector.originalLat),
            label: {
              text,
              font: `${ls.bold ? 'bold ' : ''}${ls.italic ? 'italic ' : ''}${ls.fontSize || 12}px ${ls.fontFamily || 'sans-serif'}`,
              fillColor: C.Color.fromCssColorString(ls.color || '#000000'),
              showBackground: !!ls.background,
              backgroundColor: C.Color.fromCssColorString(ls.backgroundColor || '#ffffff').withAlpha(0.85),
              style: C.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new C.Cartesian2(0, -8),
              verticalOrigin: C.VerticalOrigin.BOTTOM,
              horizontalOrigin: C.HorizontalOrigin.CENTER,
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          })
          labelEntity.sectorData = sector
          this.dataSource.entities.add(labelEntity)
        }
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
