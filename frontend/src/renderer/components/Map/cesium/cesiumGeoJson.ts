/**
 * GeoJSON 几何工具（GCJ02 → WGS84）。
 *
 * 图层文件 / 装饰要素的 GeoJSON 在前端是 GCJ02，Cesium 用 WGS84，
 * 加载前递归转换坐标。点/线/面/Multi* 全覆盖。
 */
import { gcj02ToWgs84 } from '../../../utils/coordinate'
import { extractFeatureId } from '../../../utils/featureId'

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

/** 分块大小：每块要素转换之间让出一帧 */
const CHUNK = 2000

/** 等一帧（无 rAF 的环境退化成 setTimeout，测试里不会挂住） */
function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })
}

/**
 * 分块转换整个 FeatureCollection（异步，每块之间让出一帧）。
 *
 * 大图层（几万个点/面的 MapInfo）的 GCJ02→WGS84 是纯计算重活，`transformFeatureCollection`
 * 整段跑完要占住主线程几秒 —— 期间界面完全冻住，"正在加载图层"的提示也停在第一帧不动。
 * 分块让帧后提示能持续转，浏览器也能继续响应取消/缩放。
 */
export async function transformFeatureCollectionAsync<FC extends {
  features: Array<{ geometry?: { type: string; coordinates: unknown } }>
}>(fc: FC): Promise<FC> {
  const total = fc.features.length
  if (total <= CHUNK) return transformFeatureCollection(fc)
  const out: typeof fc.features = new Array(total)
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(start + CHUNK, total)
    for (let i = start; i < end; i++) {
      const f = fc.features[i]
      out[i] = f.geometry ? { ...f, geometry: transformGeometry(f.geometry) } : f
    }
    await yieldFrame()
  }
  return { ...fc, features: out }
}

/**
 * 提取几何锚点 [lng,lat]（标签/定位用）。
 *
 * 与 2D `MapInfoLayer._labelAnchorFromGeometry` **同口径**：
 * - 点（Point）→ 自身坐标
 * - 线 / 面 / Multi* → **全部顶点的包围盒中心**（Leaflet `layer.getBounds().getCenter()`）
 *
 * 早先取的是"第一个坐标"：对多边形就是外环的第一个顶点 —— 大面要素的标签因此贴在图形的
 * 边框/角上，而不是图形中央（2026-10-14 用户报"较大的多边形要素标签显示在图形边框位置"）。
 */
export function geometryAnchor(geometry: {
  type: string
  coordinates: unknown
}): [number, number] | null {
  const coords = geometry.coordinates
  if (geometry.type === 'Point') {
    const p = coords as Position
    return Array.isArray(p) && typeof p[0] === 'number' ? [p[0], p[1]] : null
  }
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  let found = false
  const walk = (node: unknown): void => {
    if (!Array.isArray(node) || node.length === 0) return
    if (typeof node[0] === 'number') {
      const lng = node[0] as number
      const lat = node[1] as number
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
      found = true
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      return
    }
    for (const child of node) walk(child)
  }
  walk(coords)
  if (!found) return null
  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2]
}

/**
 * 几何质心 [lng,lat]（全部顶点的算术平均）——热力取点用。
 *
 * 与 2D `MapInfoLayer.geometryCentroid` 同口径（面状要素的热力权重落在图形重心上，
 * 而不是某个角点）。标签锚点请用 `geometryAnchor`（2D 标签用的是包围盒中心，两者不同源）。
 */
export function geometryCentroid(geometry: {
  type: string
  coordinates: unknown
}): [number, number] | null {
  let lngSum = 0
  let latSum = 0
  let n = 0
  const walk = (node: unknown): void => {
    if (!Array.isArray(node) || node.length === 0) return
    if (typeof node[0] === 'number') {
      const lng = node[0] as number
      const lat = node[1] as number
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
      lngSum += lng
      latSum += lat
      n += 1
      return
    }
    for (const child of node) walk(child)
  }
  walk(geometry.coordinates)
  if (n === 0) return null
  return [lngSum / n, latSum / n]
}

/**
 * 顶点数低于该值的线/环不做抽稀。
 *
 * 抽稀本身也有代价（一次 O(n) 遍历 + 结果数组），顶点很少的图形省不了多少几何，
 * 反而让"小图形"多一分被改变形状的风险。
 */
export const SIMPLIFY_MIN_POINTS = 40

/**
 * Douglas-Peucker 抽稀（迭代版，避免大环递归爆栈）。
 *
 * 保留"偏离首尾连线超过容差"的点，逐段二分直到没有点超差。
 * 用于 3D 贴地图元的几何瘦身：MapInfo/地理化数据的边界动辄成千上万个点，
 * 而城市级视野下一屏只能看到几百个像素 —— 抽稀后通常只剩 10~30% 的点，
 * 视觉差异极小（容差按要素尺度缩放，见 simplifyRingOrLine）。
 */
export function douglasPeucker(points: Position[], tolerance: number): Position[] {
  const n = points.length
  if (n < 3) return points
  const tolSq = tolerance * tolerance
  const keep = new Array<boolean>(n).fill(false)
  keep[0] = true
  keep[n - 1] = true
  // 显式栈代替递归：省界/县界动辄几万点，递归深度会爆栈
  const stack: Array<[number, number]> = [[0, n - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number]
    if (last <= first + 1) continue
    const ax = points[first][0]
    const ay = points[first][1]
    const dx = points[last][0] - ax
    const dy = points[last][1] - ay
    const lenSq = dx * dx + dy * dy
    let maxDistSq = -1
    let index = -1
    for (let i = first + 1; i < last; i++) {
      const px = points[i][0]
      const py = points[i][1]
      let distSq: number
      if (lenSq === 0) {
        distSq = (px - ax) ** 2 + (py - ay) ** 2
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const cx = ax + t * dx
        const cy = ay + t * dy
        distSq = (px - cx) ** 2 + (py - cy) ** 2
      }
      if (distSq > maxDistSq) {
        maxDistSq = distSq
        index = i
      }
    }
    if (index > 0 && maxDistSq > tolSq) {
      keep[index] = true
      stack.push([first, index], [index, last])
    }
  }
  const out: Position[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i])
  return out
}

/** 首尾是否同点（GeoJSON 闭合环惯例） */
function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

/**
 * 抽稀一条线 / 一个环（仅用于 **3D 渲染几何**；2D 与命中/标签/热力取点仍用原始坐标）。
 *
 * - 顶点数 ≤ SIMPLIFY_MIN_POINTS 原样返回
 * - 闭合环：去掉重复的首尾点再抽稀、结果重新闭合；抽稀后不足 3 个不同点则放弃
 * - 容差 tolerance 由调用方按要素尺度给出（度）
 */
export function simplifyRingOrLine(
  points: Position[],
  tolerance: number,
  closed: boolean,
): Position[] {
  const n = points.length
  if (n <= SIMPLIFY_MIN_POINTS) return points
  const isClosed = closed && samePosition(points[0], points[n - 1])
  const open = isClosed ? points.slice(0, n - 1) : points
  const simplified = douglasPeucker(open, tolerance)
  if (simplified.length < (isClosed ? 3 : 2)) return points
  return isClosed ? [...simplified, simplified[0]] : simplified
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
 * 圈选收集（`layerSelectables` / `decorationSelectables`）、高亮渲染
 * （`CesiumGeoJsonLayer.setSelectionIds`）与**搜索定位**（`MapSearchDialog` 的 featureId）
 * **必须用同一套 id**，否则圈选出来的是 id A、高亮找的是 id B，表现为"圈到了但不高亮"；
 * 搜索结果也是 id C，定位高亮匹配不上，表现为"飞过去了但没有红色标注"。
 *
 * 口径与 2D 完全一致（2D `MapInfoLayer` 构建时分配的 `_nptSelectionId`、
 * 搜索弹窗 `prepareMapInfoRecord` 的 featureId 都是这条规则）：
 * 1. 编辑期稳定标识 `_editId`（编辑会话新建要素的身份，优先，避免与属性字段混淆）；
 * 2. 自然 ID（`extractFeatureId`：id/name/小区名称/OBJECTID/CGI…）；
 * 3. 兜底 `图层ID#序号`（与 2D 的 `_nptSelectionId` 兜底同形）。
 */
export function featureSelectionId(
  props: Record<string, unknown> | undefined,
  layerId: string,
  index: number,
): string {
  const editId = props?._editId
  if (editId !== undefined && editId !== null) return String(editId)
  const natural = extractFeatureId(props)
  if (natural) return natural
  return `${layerId}#${index}`
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
