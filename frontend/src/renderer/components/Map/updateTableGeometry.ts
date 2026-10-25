/**
 * 更新表：单个图形的固有属性度量（纯函数，无 React / api 依赖，便于单测）
 *
 * 坐标口径：地图显示链路统一为 GCJ02，本模块的输入输出经度/纬度一律是 GCJ02；
 * WGS84 版本由 `updateTableFields` 侧调用 `gcj02ToWgs84` 换算，不在这里做。
 *
 * 度量（长度/周长/面积）在 GCJ02 坐标上按球面公式计算：GCJ02 与 WGS84 在单个要素
 * 范围内只差一个近似常量的平移，相对误差远小于数据本身的精度，故无需逐点换算。
 */
/** 经纬度对 [lng, lat] */
export type LngLat = [number, number]

/** 图形类别 */
export type GeometryKind = 'point' | 'line' | 'polygon' | null

export interface GeometryMeasure {
  kind: GeometryKind
  /** 定位点：点=自身，线/面=第一个节点 */
  first: LngLat | null
  /** 几何中心：面=面积加权质心，线=顶点平均，点=自身 */
  center: LngLat | null
  /** 节点数 */
  nodeCount: number
  /** 线长度（米），非线为空 */
  lengthM: number | null
  /** 面周长（米，含洞），非面为空；对外展示统一换算为 km */
  perimeterM: number | null
  /** 面面积（平方米，已扣除洞），非面为空；对外展示统一换算为 km² */
  areaM2: number | null
  /** 坐标环：线=每条线一段、面=每个环一段（外环与洞并列），多部件按出现顺序排列 */
  rings: LngLat[][]
  /** 坐标集文本（GCJ02）："经度 纬度,经度 纬度"，多环以 ";" 分隔 */
  coordText: string
}

const EARTH_R = 6378137
const COORD_DECIMALS = 6

const toRad = (deg: number) => (deg * Math.PI) / 180

function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** 环长度（closed=true 时首尾相连） */
function ringLength(ring: LngLat[], closed: boolean): number {
  let total = 0
  for (let i = 0; i < ring.length - 1; i++) total += haversine(ring[i], ring[i + 1])
  if (closed && ring.length > 2) total += haversine(ring[ring.length - 1], ring[0])
  return total
}

/** 顶点算术平均 */
function averagePoint(points: LngLat[]): LngLat | null {
  if (points.length === 0) return null
  const lng = points.reduce((s, p) => s + p[0], 0) / points.length
  const lat = points.reduce((s, p) => s + p[1], 0) / points.length
  return [lng, lat]
}

/** 递归取全部顶点（多部件/多重嵌套都摊平） */
function collectPoints(coords: any, out: LngLat[]): void {
  if (!Array.isArray(coords)) return
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    out.push([coords[0], coords[1]])
    return
  }
  for (const c of coords) collectPoints(c, out)
}

function emptyMeasure(kind: GeometryKind = null): GeometryMeasure {
  return {
    kind,
    first: null,
    center: null,
    nodeCount: 0,
    lengthM: null,
    perimeterM: null,
    areaM2: null,
    rings: [],
    coordText: '',
  }
}

/**
 * 度量任意 GeoJSON 几何（Point / LineString / Polygon / MultiPoint /
 * MultiLineString / MultiPolygon 及其 GeometryCollection 之外的常见类型）。
 * geometry 为空或无有效坐标时返回 kind=null 的空度量（由调用方统计为跳过）。
 */
export function measureGeometry(geometry: any | null | undefined): GeometryMeasure {
  if (!geometry || !geometry.type || !geometry.coordinates) return emptyMeasure()
  const type: string = geometry.type
  const coords: any = geometry.coordinates

  const points: LngLat[] = []

  if (type === 'Point') {
    if (!isLngLat(coords)) return emptyMeasure(null)
    const p: LngLat = [coords[0], coords[1]]
    return { ...emptyMeasure('point'), first: p, center: p, nodeCount: 1, rings: [[p]], coordText: formatCoordText([[p]]) }
  }
  if (type === 'MultiPoint') {
    const pts = (coords as any[]).filter(isLngLat).map((c) => [c[0], c[1]] as LngLat)
    if (pts.length === 0) return emptyMeasure(null)
    return {
      ...emptyMeasure('point'),
      first: pts[0] ?? null,
      center: averagePoint(pts),
      nodeCount: pts.length,
      rings: [pts],
      coordText: formatCoordText([pts]),
    }
  }

  if (type === 'LineString' || type === 'MultiLineString') {
    const rings: LngLat[][] = (type === 'LineString' ? [coords] : coords)
      .map((line: any) => (line as any[]).filter(isLngLat).map((c) => [c[0], c[1]] as LngLat))
      .filter((r: LngLat[]) => r.length > 0)
    for (const r of rings) points.push(...r)
    if (points.length === 0) return emptyMeasure(null)
    const lengthM = rings.reduce((sum, r) => sum + ringLength(r, false), 0)
    return {
      ...emptyMeasure('line'),
      first: points[0],
      center: averagePoint(points),
      nodeCount: points.length,
      lengthM,
      rings,
      coordText: formatCoordText(rings),
    }
  }

  if (type === 'Polygon' || type === 'MultiPolygon') {
    // Polygon: [[ring...], ...] / MultiPolygon: [[[ring...], ...], ...]
    const polys: LngLat[][][] = (type === 'Polygon' ? [coords] : coords)
      .map((poly: any) => (poly as any[])
        .map((ring: any) => (ring as any[]).filter(isLngLat).map((c) => [c[0], c[1]] as LngLat))
        .filter((ring: LngLat[]) => ring.length > 0))
      .filter((poly: LngLat[][]) => poly.length > 0)
    for (const poly of polys) for (const ring of poly) points.push(...ring)
    if (points.length === 0) return emptyMeasure(null)

    let areaM2 = 0
    let perimeterM = 0
    let signedSum = 0
    let centroidLng = 0
    let centroidLat = 0
    for (const poly of polys) {
      for (const ring of poly) {
        const signed = ringAreaSigned(ring)
        const c = ringCentroid(ring)
        signedSum += signed
        centroidLng += signed * c[0]
        centroidLat += signed * c[1]
      }
      areaM2 += polyArea(poly)
      perimeterM += polyPerimeter(poly)
    }
    const areaCentroid: LngLat | null = signedSum === 0 ? null : [centroidLng / signedSum, centroidLat / signedSum]
    return {
      ...emptyMeasure('polygon'),
      first: points[0],
      center: areaCentroid ?? averagePoint(points),
      nodeCount: points.length,
      perimeterM,
      areaM2,
      // 多部件/多环统一摊平成环序列，文本里同样用 ";" 分隔
      rings: polys.flat(),
      coordText: formatCoordText(polys.flat()),
    }
  }

  // 未知几何类型：只统计节点数，避免误报为无数据
  collectPoints(coords, points)
  return points.length > 0
    ? { ...emptyMeasure(null), first: points[0], center: averagePoint(points), nodeCount: points.length }
    : emptyMeasure(null)
}

/** 有效的经纬度对（源数据可能存在被清空的 coordinates） */
function isLngLat(c: any): c is number[] {
  return Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])
}

/** 带符号的环面积（方向决定正负），用于按面积加权求面质心（洞自动反向相减） */
function ringAreaSigned(ring: LngLat[]): number {
  if (ring.length < 3) return 0
  let total = 0
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i]
    const p2 = ring[(i + 1) % ring.length]
    total += toRad(p2[0] - p1[0]) * (2 + Math.sin(toRad(p1[1])) + Math.sin(toRad(p2[1])))
  }
  return (total * EARTH_R * EARTH_R) / 2
}

/** 环面积（m²，取绝对值） */
function ringArea(ring: LngLat[]): number {
  return Math.abs(ringAreaSigned(ring))
}

/** 坐标集文本：ring 内以逗号分隔、ring 之间以分号分隔 */
export function formatCoordText(rings: LngLat[][]): string {
  return rings
    .map((ring) => ring.map(([lng, lat]) => `${lng.toFixed(COORD_DECIMALS)} ${lat.toFixed(COORD_DECIMALS)}`).join(','))
    .join(';')
}

/** 环的顶点平均（面积加权求质心的基准） */
function ringCentroid(ring: LngLat[]): LngLat {
  let lng = 0
  let lat = 0
  for (let i = 0; i < ring.length; i++) {
    lng += ring[i][0]
    lat += ring[i][1]
  }
  return ring.length > 0 ? [lng / ring.length, lat / ring.length] : [0, 0]
}

/** 单个多边形面积：外环 − 洞 */
function polyArea(poly: LngLat[][]): number {
  if (poly.length === 0) return 0
  const outer = ringArea(poly[0])
  const holes = poly.slice(1).reduce((s, ring) => s + ringArea(ring), 0)
  return Math.max(0, outer - holes)
}

/** 单个多边形周长：外环 + 各洞环 */
function polyPerimeter(poly: LngLat[][]): number {
  return poly.reduce((s, ring) => s + ringLength(ring, true), 0)
}
