/**
 * "边界选择"工具的纯函数 helper（不依赖 Leaflet/地图实例，便于单测）。
 * 几何坐标为图层渲染坐标（GCJ-02），GeoJSON 坐标按 [lng, lat] 排列。
 */

/** 是否为面状几何（边界选择只接受 Polygon / MultiPolygon） */
export function isPolygonGeometry(geom: any): boolean {
  return !!geom && (geom.type === 'Polygon' || geom.type === 'MultiPolygon')
}

/**
 * 面几何 → 多个外环。
 * Polygon 返回 1 个环（取外环 coordinates[0]）；MultiPolygon 返回每个 polygon 的外环。
 * 每个环为 [lng, lat] 坐标点数组。
 */
export function boundaryOuterRings(geom: any): number[][][] {
  if (!geom) return []
  if (geom.type === 'Polygon') {
    return Array.isArray(geom.coordinates?.[0]) ? [geom.coordinates[0]] : []
  }
  if (geom.type === 'MultiPolygon') {
    return Array.isArray(geom.coordinates)
      ? geom.coordinates
          .map((poly: any) => poly?.[0])
          .filter((ring: any) => Array.isArray(ring))
      : []
  }
  return []
}

/**
 * 要素锚点（归属经纬度）。
 * Point/MultiPoint = 自身位置；LineString/Polygon/Multi* = 几何全部顶点包围盒中心
 * （与 Leaflet layer.getBounds().getCenter() 口径一致）。
 * 边界选择以此"单点"判定归属：相邻边界各自选择时，同一要素不可能同时落入两边界，
 * 保证要素归属唯一。输入 GeoJSON 几何（[lng,lat]），输出 {lat,lng}。
 */
export function geometryAnchor(geom: any): { lat: number, lng: number } | null {
  if (!geom) return null
  if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
    return { lat: geom.coordinates[1], lng: geom.coordinates[0] }
  }
  let minLat = Infinity, maxLat = -Infinity
  let minLng = Infinity, maxLng = -Infinity
  let count = 0
  const walk = (node: any) => {
    if (typeof node === 'number') return
    if (!Array.isArray(node)) return
    // 坐标点 = 两个数字
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lng, lat] = node
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      count += 1
      return
    }
    node.forEach(walk)
  }
  walk(geom.coordinates)
  if (count === 0) return null
  return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 }
}

/** 命中项：id + 属性 */
export interface BoundaryHitItem {
  id: string
  properties: any
}

/**
 * 按 id 去重合并命中项到目标集合（跨外环、跨图层、Shift 叠加共用）。
 */
export function mergeById(
  dst: { ids: Set<string>; props: any[] },
  items: BoundaryHitItem[],
): void {
  for (const item of items) {
    if (!item.id) continue
    if (dst.ids.has(item.id)) continue
    dst.ids.add(item.id)
    dst.props.push(item.properties)
  }
}
