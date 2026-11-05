/**
 * 地图要素点击精确命中检测（容器像素空间）
 *
 * 用于「点击查属性」场景，与图层类的 getFeaturesInCircle（包围盒/中心粗检，
 * 供圈选、点选工具使用）不同：
 * - 点要素：点击点距要素的像素距离 ≤ 容差
 * - 线要素：点击点到任一折线段的像素距离 ≤ 容差
 * - 面要素：点击点落在封闭区域内（射线法，外环/孔洞按奇偶规则叠加，与填充样式无关）
 *
 * 命中分两级（FeatureHitType）：
 * - direct：面填充真正包含点击点，或点/线要素被点击点压中 —— 视为"点中了该要素"
 * - border：仅面边框在容差内（点击点不在面内）—— 弱命中，仅在没有 direct 命中时生效
 *
 * 解决问题：面状图层中，点击某要素内部时，其他要素即使只有包围盒与点击位置
 * 相交（边框/形状并未覆盖该点）也会被粗检命中，导致误弹「重叠要素」列表。
 * 精确检测只返回封闭区域真正包含点击点的要素，仅当多个要素的填充区域确实
 * 重叠于点击点时才弹出重叠列表；多个要素只是边框线条交叠时不算重叠，
 * 由 resolveHits 穿透到最近边框所属的单个要素。
 */
import L from 'leaflet'

/** 点击命中容差（像素）：点/线/面边框统一使用 */
export const CLICK_HIT_TOLERANCE_PX = 12

/**
 * 命中类型：
 * - direct：面填充包含点击点（或点/线要素被压中）—— 强命中，多个 direct 才算真重叠
 * - border：仅面边框在像素容差内 —— 弱命中，边框线条交叠不视为重叠
 */
export type FeatureHitType = 'direct' | 'border'

/** 单次命中结果：类型 + 像素距离（border 取最近边框距离，direct 取 0 或要素距离） */
export interface FeatureHitInfo {
  type: FeatureHitType
  distancePx: number
}

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
 * 判断点击点是否精确命中指定 Leaflet 子图层，并给出命中类型与像素距离。
 *
 * @param map 地图实例（用于 latLng → 容器像素坐标投影）
 * @param layer Leaflet 子图层（CircleMarker/Marker/Polyline/Polygon/Rectangle）
 * @param latlng 点击位置（渲染坐标/GCJ02）
 * @param tolerancePx 像素容差
 */
export function layerHitAt(
  map: L.Map,
  layer: any,
  latlng: L.LatLng,
  tolerancePx: number = CLICK_HIT_TOLERANCE_PX
): FeatureHitInfo | null {
  const clickPx = map.latLngToContainerPoint(latlng)

  // 点要素：CircleMarker / Marker（有 getLatLng，无 getLatLngs）—— 点无"面"，距离内即直接命中
  if (typeof layer.getLatLng === 'function' && typeof layer.getLatLngs !== 'function') {
    const markerPx = map.latLngToContainerPoint(layer.getLatLng() as L.LatLng)
    const distance = markerPx.distanceTo(clickPx)
    return distance <= tolerancePx ? { type: 'direct', distancePx: distance } : null
  }

  if (typeof layer.getLatLngs === 'function') {
    const ringsPx = normalizeLatLngRings(layer.getLatLngs()).map(ring =>
      ring.map(ll => map.latLngToContainerPoint(ll))
    )
    if (ringsPx.length === 0) return null

    // Polygon 继承自 Polyline，instanceof 需先判断 Polygon
    const isPolygon = layer instanceof L.Polygon

    if (isPolygon) {
      // 面填充：所有环按奇偶规则叠加（点在外环内且在孔洞外 → 命中；
      // MultiPolygon 任一部分包含即命中）。与 fill 样式无关，镂空面内部同样命中。
      let inside = false
      for (const ring of ringsPx) {
        if (pointInRingPx(clickPx, ring)) inside = !inside
      }
      if (inside) return { type: 'direct', distancePx: 0 }

      // 未落在填充区：边框容差内只算弱命中（边框线条交叠不视为重叠）
      let minDistance = Infinity
      for (const ring of ringsPx) {
        const d = minDistanceToRingPx(clickPx, ring, true)
        if (d < minDistance) minDistance = d
      }
      return minDistance <= tolerancePx ? { type: 'border', distancePx: minDistance } : null
    }

    // 线要素：到折线段距离容差内即命中（线无填充，粗细即命中范围）
    let minDistance = Infinity
    for (const ring of ringsPx) {
      const d = minDistanceToRingPx(clickPx, ring, false)
      if (d < minDistance) minDistance = d
    }
    return minDistance <= tolerancePx ? { type: 'direct', distancePx: minDistance } : null
  }

  return null
}

/**
 * 判断点击点是否精确命中指定 Leaflet 子图层（layerHitAt 的布尔等价形式）。
 */
export function layerContainsPoint(
  map: L.Map,
  layer: any,
  latlng: L.LatLng,
  tolerancePx: number = CLICK_HIT_TOLERANCE_PX
): boolean {
  return layerHitAt(map, layer, latlng, tolerancePx) !== null
}

/**
 * 图层像素包围盒粗检（预筛用，不做精确判定）：
 * 大量要素（如扇区渲染缓存）逐个精确检测前先用包围盒排除，避免全量投影。
 * 无法取包围盒（CircleMarker 无 getBounds）时返回 true（不预筛）。
 *
 * @param map 地图实例
 * @param layer Leaflet 子图层
 * @param latlng 点击位置（渲染坐标/GCJ02）
 * @param tolerancePx 像素容差（包围盒外扩量）
 */
export function layerBoundsHitPx(
  map: L.Map,
  layer: any,
  latlng: L.LatLng,
  tolerancePx: number = CLICK_HIT_TOLERANCE_PX
): boolean {
  const bounds: L.LatLngBounds | undefined = typeof layer?.getBounds === 'function' ? layer.getBounds() : null
  if (!bounds || !bounds.isValid()) return true
  const nw = map.latLngToContainerPoint(bounds.getNorthWest())
  const se = map.latLngToContainerPoint(bounds.getSouthEast())
  const clickPx = map.latLngToContainerPoint(latlng)
  return clickPx.x >= Math.min(nw.x, se.x) - tolerancePx
    && clickPx.x <= Math.max(nw.x, se.x) + tolerancePx
    && clickPx.y >= Math.min(nw.y, se.y) - tolerancePx
    && clickPx.y <= Math.max(nw.y, se.y) + tolerancePx
}

/**
 * 命中结果收敛（"手形"点击穿透规则）：
 * - 存在 direct 命中（面填充真正包含点击点 / 点线被压中）时只保留 direct ——
 *   仅边框线条交叠、面不重叠的要素被剔除，不再误弹重叠列表；
 * - 全部为 border 命中（点在所有面的填充之外，只是压到边框）时，
 *   只保留最近的边框所属要素（距离并列取 z 小 = 层级高者），实现"穿透命中"。
 *
 * @param hits 命中列表（需带 hitType/distancePx/z；z 越小层级越高）
 */
export function resolveHits<T extends { hitType: FeatureHitType; distancePx: number; z: number }>(hits: T[]): T[] {
  if (hits.length <= 1) return hits
  const direct = hits.filter(h => h.hitType === 'direct')
  if (direct.length > 0) return direct
  let best = hits[0]
  for (const h of hits) {
    if (h.distancePx < best.distancePx || (h.distancePx === best.distancePx && h.z < best.z)) best = h
  }
  return [best]
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
