/**
 * 地图要素点击精确命中检测（容器像素空间）
 *
 * 用于「点击查属性」场景，与图层类的 getFeaturesInCircle（包围盒/中心粗检，
 * 供圈选、点选工具使用）不同：
 * - 点要素：点击点距要素的像素距离 ≤ 容差
 * - 线要素：点击点到任一折线段的像素距离 ≤ 容差
 * - 面要素：点击点落在封闭区域内（射线法，外环/孔洞按奇偶规则叠加），
 *   或距面边框的像素距离 ≤ 容差
 *
 * 解决问题：面状图层中，点击某要素内部时，其他要素即使只有包围盒与点击位置
 * 相交（边框/形状并未覆盖该点）也会被粗检命中，导致误弹「重叠要素」列表。
 * 精确检测只返回封闭区域真正包含点击点的要素，仅当多个要素的填充区域确实
 * 重叠于点击点时才弹出重叠列表。
 */
import L from 'leaflet'

/** 点击命中容差（像素）：点/线/面边框统一使用 */
export const CLICK_HIT_TOLERANCE_PX = 12

/**
 * 将 Leaflet layer.getLatLngs() 的任意嵌套结构归一化为「环」数组。
 * - 简单线/面：LatLng[]
 * - 带孔面 / MultiLineString：LatLng[][]
 * - MultiPolygon：LatLng[][][]
 */
export function normalizeLatLngRings(latlngs: any): L.LatLng[][] {
  const rings: L.LatLng[][] = []
  const isLatLng = (v: any): v is L.LatLng =>
    !!v && typeof v.lat === 'number' && typeof v.lng === 'number'

  const walk = (arr: any[]) => {
    if (!Array.isArray(arr) || arr.length === 0) return
    if (isLatLng(arr[0])) {
      rings.push(arr as L.LatLng[])
      return
    }
    for (const sub of arr) walk(sub)
  }

  walk(latlngs)
  return rings
}

/** 射线法判断点是否在环内（像素坐标，奇偶规则） */
export function pointInRingPx(p: L.Point, ring: L.Point[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y
    const xj = ring[j].x, yj = ring[j].y
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** 点到环折线段的最短像素距离；closed=true 时首尾闭合（面边框） */
export function minDistanceToRingPx(p: L.Point, ring: L.Point[], closed: boolean): number {
  let min = Infinity
  const segCount = closed ? ring.length : ring.length - 1
  for (let i = 0; i < segCount; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    let t = 0
    if (lenSq > 0) {
      t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
      t = Math.max(0, Math.min(1, t))
    }
    const cx = a.x + t * dx
    const cy = a.y + t * dy
    const dist = Math.hypot(p.x - cx, p.y - cy)
    if (dist < min) min = dist
  }
  return min
}

/**
 * 判断点击点是否精确命中指定 Leaflet 子图层。
 *
 * @param map 地图实例（用于 latLng → 容器像素坐标投影）
 * @param layer Leaflet 子图层（CircleMarker/Marker/Polyline/Polygon/Rectangle）
 * @param latlng 点击位置（渲染坐标/GCJ02）
 * @param tolerancePx 像素容差
 */
export function layerContainsPoint(
  map: L.Map,
  layer: any,
  latlng: L.LatLng,
  tolerancePx: number = CLICK_HIT_TOLERANCE_PX
): boolean {
  const clickPx = map.latLngToContainerPoint(latlng)

  // 点要素：CircleMarker / Marker（有 getLatLng，无 getLatLngs）
  if (typeof layer.getLatLng === 'function' && typeof layer.getLatLngs !== 'function') {
    const markerPx = map.latLngToContainerPoint(layer.getLatLng() as L.LatLng)
    return markerPx.distanceTo(clickPx) <= tolerancePx
  }

  if (typeof layer.getLatLngs === 'function') {
    const ringsPx = normalizeLatLngRings(layer.getLatLngs()).map(ring =>
      ring.map(ll => map.latLngToContainerPoint(ll))
    )
    if (ringsPx.length === 0) return false

    // Polygon 继承自 Polyline，instanceof 需先判断 Polygon
    const isPolygon = layer instanceof L.Polygon

    // 边框/线段容差命中（点击压线/压边框）
    for (const ring of ringsPx) {
      if (minDistanceToRingPx(clickPx, ring, isPolygon) <= tolerancePx) return true
    }

    // 面填充：所有环按奇偶规则叠加（点在外环内且在孔洞外 → 命中；
    // MultiPolygon 任一部分包含即命中）
    if (isPolygon) {
      let inside = false
      for (const ring of ringsPx) {
        if (pointInRingPx(clickPx, ring)) inside = !inside
      }
      return inside
    }

    return false
  }

  return false
}

/**
 * 从 Leaflet 子图层反推 GeoJSON 几何（供要素属性弹窗做面积/长度/节点数统计）。
 * 优先取 layer.feature.geometry（L.geoJSON 构建），否则按图层类型从坐标推导。
 */
export function layerGeometry(layer: any): { type: string; coordinates: any } | null {
  if (layer?.feature?.geometry) return layer.feature.geometry

  if (typeof layer?.getLatLng === 'function' && typeof layer.getLatLngs !== 'function') {
    const ll = layer.getLatLng() as L.LatLng
    if (!ll) return null
    return { type: 'Point', coordinates: [ll.lng, ll.lat] }
  }

  if (typeof layer?.getLatLngs === 'function') {
    const rings = normalizeLatLngRings(layer.getLatLngs()).map((ring) =>
      ring.map((ll) => [ll.lng, ll.lat] as [number, number]),
    )
    if (rings.length === 0) return null
    const isPolygon = layer instanceof L.Polygon
    if (!isPolygon) {
      return rings.length === 1
        ? { type: 'LineString', coordinates: rings[0] }
        : { type: 'MultiLineString', coordinates: rings }
    }
    return { type: 'Polygon', coordinates: rings }
  }

  return null
}
