/**
 * 线要素"方向箭头"装饰（"带方向线段的线"样式）
 *
 * MapInfo/TAB 的原生 Pen 只有线宽 + 线型图案（1~71），没有箭头线型，
 * 因此箭头由本软件渲染：线样式里带 arrow 标记（随要素 _editStyle 保存到 NPT_FEATSYM），
 * 箭头作为独立的 divIcon 标记沿折线布置；保存/导出的几何仍是普通 LineString
 * （第三方 GIS 打开只看到普通线）。
 *
 * 布置策略：沿折线按固定地理间距取点（不足一个间距时取中点），箭头朝向与所在线段走向一致。
 * 采用 divIcon（屏幕像素尺寸 + CSS 旋转），Leaflet 在缩放/平移时自动重定位标记，
 * 等角投影下尺寸与朝向不随缩放变化，故无需监听 zoom/move 重算（避免大数据量图层的重绘开销）。
 */
import L from 'leaflet'

/** 箭头间距（米） */
const ARROW_SPACING_M = 150
/** 单条折线最多箭头数（加密曲线/超长线防止海量 DOM） */
const MAX_ARROWS_PER_LINE = 24
/** 短于该长度（米）的折线不画箭头（过短无法体现方向） */
const MIN_LINE_LENGTH_M = 20
/** 箭头图标边长（像素） */
const ARROW_SIZE_PX = 13

const EARTH_R = 6378137
const toRad = (d: number) => (d * Math.PI) / 180

/** 两点球面距离（米） */
function distanceM(a: L.LatLng, b: L.LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** 墨卡托 y（等角投影：屏幕夹角不随缩放变化，可用于计算箭头旋转角） */
function mercatorY(lat: number): number {
  const clamped = Math.max(-85, Math.min(85, lat))
  return Math.log(Math.tan(Math.PI / 4 + toRad(clamped) / 2))
}

/** 线段屏幕朝向（度）：0=向东，顺时针为正（与 CSS rotate 一致） */
function bearingDeg(a: L.LatLng, b: L.LatLng): number {
  const dx = b.lng - a.lng
  const dy = mercatorY(b.lat) - mercatorY(a.lat)
  return (Math.atan2(-dy, dx) * 180) / Math.PI
}

/** 折线坐标扁平化（MultiLineString / 多段嵌套 → 多条折线） */
export function flattenLineLatLngs(node: any): L.LatLng[][] {
  if (!Array.isArray(node) || node.length === 0) return []
  if (node[0] instanceof L.LatLng) return [node as L.LatLng[]]
  const out: L.LatLng[][] = []
  for (const child of node) out.push(...flattenLineLatLngs(child))
  return out
}

/** 箭头图标：三角形指向 +x 方向，rot 为屏幕旋转角（度） */
function arrowIcon(color: string, opacity: number, rot: number): L.DivIcon {
  const s = ARROW_SIZE_PX
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" ` +
    `style="display:block;transform:rotate(${rot.toFixed(1)}deg);transform-origin:50% 50%">` +
    `<polygon points="1.5,2.5 ${s - 1},${s / 2} 1.5,${s - 2.5}" fill="${color}" fill-opacity="${opacity}" ` +
    `stroke="rgba(255,255,255,0.7)" stroke-width="0.8" stroke-linejoin="round"/></svg>`
  return L.divIcon({ className: '', iconSize: [s, s], iconAnchor: [s / 2, s / 2], html: svg })
}

/**
 * 生成折线的方向箭头标记（interactive:false，可直接加入 LayerGroup）。
 * @param latlngs Leaflet 折线坐标（支持 MultiLineString 嵌套结构）
 * @param opts.color 线条颜色（箭头同色）；opts.opacity 线条透明度
 * @param opts.maxArrows 单条折线箭头数上限（默认 24）
 */
export function buildLineArrows(
  latlngs: any,
  opts: { color: string; opacity?: number; pane?: string; maxArrows?: number },
): L.Marker[] {
  const lines = flattenLineLatLngs(latlngs)
  if (lines.length === 0) return []
  const out: L.Marker[] = []
  const maxArrows = opts.maxArrows ?? MAX_ARROWS_PER_LINE
  const opacity = opts.opacity ?? 1

  for (const line of lines) {
    if (line.length < 2) continue
    const segs: number[] = []
    let total = 0
    for (let i = 0; i < line.length - 1; i++) {
      const d = distanceM(line[i], line[i + 1])
      segs.push(d)
      total += d
    }
    if (total < MIN_LINE_LENGTH_M) continue

    // 箭头数量：按间距取整并均布（超长线达到上限时同步放大间距，保证箭头覆盖整条线，
    // 而不是只在起段密集出现）
    const n = Math.min(maxArrows, Math.max(1, Math.round(total / ARROW_SPACING_M)))
    const step = total / n
    const dists: number[] = []
    for (let i = 0; i < n; i++) dists.push(step * (i + 0.5))

    let acc = 0
    let segIdx = 0
    for (const dist of dists) {
      while (segIdx < segs.length - 1 && acc + segs[segIdx] < dist) {
        acc += segs[segIdx]
        segIdx += 1
      }
      const a = line[segIdx]
      const b = line[segIdx + 1]
      const segLen = segs[segIdx]
      const t = segLen > 1e-9 ? Math.max(0, Math.min(1, (dist - acc) / segLen)) : 0
      const markerOpts: L.MarkerOptions = {
        interactive: false,
        keyboard: false,
        icon: arrowIcon(opts.color, opacity, bearingDeg(a, b)),
      }
      if (opts.pane) markerOpts.pane = opts.pane
      out.push(L.marker([a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t], markerOpts))
    }
  }
  return out
}
