/**
 * GeoJSON 几何工具（GCJ02 → WGS84）。
 *
 * 图层文件 / 装饰要素的 GeoJSON 在前端是 GCJ02，Cesium 用 WGS84，
 * 加载前递归转换坐标。点/线/面/Multi* 全覆盖。
 */
import { gcj02ToWgs84 } from '../../../utils/coordinate'

type Position = number[]

/** 单个 GeoJSON 位置 [lng,lat]（GCJ02）→ [wlng,wlat]（WGS84） */
function transformPosition(p: Position): Position {
  const [wlat, wlng] = gcj02ToWgs84(p[1], p[0])
  return [wlng, wlat]
}

/** 递归转换到指定层级（0=点,1=线/MultiPoint,2=面/MultiLine,3=MultiPolygon） */
function transformAt(coords: unknown, depth: number): unknown {
  if (depth === 0) return transformPosition(coords as Position)
  const arr = coords as unknown[]
  return arr.map((c) => transformAt(c, depth - 1))
}

const GEOMETRY_DEPTH: Record<string, number> = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
}

/** 深度转换一个 GeoJSON geometry，返回新 geometry（WGS84） */
export function transformGeometry<T extends { type: string; coordinates: unknown }>(
  geometry: T,
): T {
  const depth = GEOMETRY_DEPTH[geometry.type]
  if (depth === undefined) return geometry
  return {
    ...geometry,
    coordinates: transformAt(geometry.coordinates, depth),
  }
}

/** 转换整个 FeatureCollection（WGS84） */
export function transformFeatureCollection<FC extends {
  features: Array<{ geometry?: { type: string; coordinates: unknown } }>
}>(fc: FC): FC {
  return {
    ...fc,
    features: fc.features.map((f) =>
      f.geometry ? { ...f, geometry: transformGeometry(f.geometry) } : f),
  }
}

/** 提取几何锚点 [lng,lat]（标签/定位用；取首个坐标） */
export function geometryAnchor(geometry: {
  type: string
  coordinates: unknown
}): [number, number] | null {
  const c = geometry.coordinates
  const first = (v: unknown): Position | null => {
    if (Array.isArray(v)) {
      if (typeof v[0] === 'number') return v as Position
      for (const child of v) {
        const r = first(child)
        if (r) return r
      }
    }
    return null
  }
  const p = first(c)
  return p ? [p[0], p[1]] : null
}

// ===== 地理化数据（Excel 点/扇区文件）的扇区几何 =====
// 与 2D GeoDataLayer 同口径：固定半径 80 米、波束默认 65°、低 zoom 退化为圆点。

/** 地理化数据扇区半径（米）——对齐 2D `GeoDataLayer` 的 `SECTOR_RADIUS` */
export const GEO_DATA_SECTOR_RADIUS_M = 80
/** 地理化数据扇区 LOD 阈值——对齐 2D `GeoDataLayer` 的 `LOD_THRESHOLD` */
export const GEO_DATA_SECTOR_LOD_ZOOM = 9

/**
 * 地理化数据扇区环（WGS84 GeoJSON 外环，[lng,lat][]，已闭合）。
 *
 * 复刻 2D `GeoDataLayer.createSectorPolygon`：导航坐标系（正北 0°、顺时针），
 * 从 `方位角 - 波束/2` 扫到 `方位角 + 波束/2`，采样点数 `max(6, ceil(波束/5))`。
 */
export function geoDataSectorRing(
  lat: number,
  lng: number,
  azimuth: number,
  beamwidth: number,
  radiusMeters: number = GEO_DATA_SECTOR_RADIUS_M,
): number[][] {
  const latDeg = radiusMeters / 111320
  const lngDeg = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180))
  const halfBeam = (beamwidth / 2) * (Math.PI / 180)
  const aziRad = azimuth * (Math.PI / 180)
  const startAngle = aziRad - halfBeam
  const endAngle = aziRad + halfBeam
  const numPoints = Math.max(6, Math.ceil(beamwidth / 5))

  const ring: number[][] = [[lng, lat]]
  for (let i = 0; i <= numPoints; i++) {
    const angle = startAngle + (endAngle - startAngle) * (i / numPoints)
    ring.push([lng + lngDeg * Math.sin(angle), lat + latDeg * Math.cos(angle)])
  }
  ring.push([lng, lat])
  return ring
}

/**
 * 该行地理化数据应渲染为圆点还是扇形。
 * 与 2D 判定一致：方位角≈360°（全向）／室内小区（cell_cover_type=4）／低 zoom → 圆点。
 */
export function isGeoDataDot(
  row: { azimuth?: number | null; cell_cover_type?: number | null },
  zoom: number,
): boolean {
  const azimuth = row.azimuth ?? 0
  const coverType = row.cell_cover_type ?? 1
  return Math.abs(azimuth - 360) < 0.1
    || coverType === 4
    || zoom <= GEO_DATA_SECTOR_LOD_ZOOM
}

/**
 * 要素的选中标识。
 *
 * 圈选收集（`CesiumSelectionSession`）与高亮渲染（`CesiumGeoJsonLayer.setSelectionIds`）
 * **必须用同一套 id**，否则圈选出来的是 id A、高亮找的是 id B，表现为"圈到了但不高亮"。
 * 图层要素普遍没有 `properties.id`，所以按 后端 id → 编辑 id → 序号 依次回退。
 */
export function featureSelectionId(
  props: Record<string, unknown> | undefined, index: number,
): string {
  const raw = props?.id ?? props?._editId
  return raw === undefined || raw === null ? String(index) : String(raw)
}

/** WGS84 经纬度包围盒（用于「图层预览」把相机飞到该图层全貌） */
export interface LngLatBounds {
  west: number
  south: number
  east: number
  north: number
}

/** 新建一个空包围盒（西/南取 +∞、东/北取 -∞，便于逐点 extend） */
export function emptyBounds(): LngLatBounds {
  return { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
}

/** 包围盒是否已写入过有效点 */
export function hasBounds(b: LngLatBounds): boolean {
  return Number.isFinite(b.west) && Number.isFinite(b.east)
    && b.west <= b.east && b.south <= b.north
}

/** 把一个 WGS84 经纬度点并入包围盒 */
export function extendBoundsWithPoint(b: LngLatBounds, lng: number, lat: number): void {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
  if (lng < b.west) b.west = lng
  if (lng > b.east) b.east = lng
  if (lat < b.south) b.south = lat
  if (lat > b.north) b.north = lat
}

/** 递归把一个 GeoJSON 几何的坐标并入包围盒；返回是否命中过点 */
export function extendBounds(b: LngLatBounds, geom: any): boolean {
  let hit = false
  const walk = (node: unknown) => {
    if (!Array.isArray(node)) return
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      extendBoundsWithPoint(b, node[0] as number, node[1] as number)
      hit = true
      return
    }
    node.forEach(walk)
  }
  walk(geom?.coordinates)
  return hit
}

/** 提取 Polygon/MultiPolygon 各外环（用于贴地边框线），返回 [lng,lat][][] */
export function polygonOuterRings(geometry: {
  type: string
  coordinates: unknown
}): Position[][] {
  if (geometry.type === 'Polygon') {
    return [(geometry.coordinates as Position[][])[0]]
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as Position[][][]).map((poly) => poly[0])
  }
  return []
}
