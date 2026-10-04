/**
 * 节点合并（边框对齐）纯几何算法。
 *
 * 场景：用户在地图上拖一个矩形框，把"可编辑图形"在框内的边框段整体替换为
 * "参考图形（不可编辑图层）"在框内的边框段——以参考段节点为基准，
 * 可编辑段节点少则补、多则删，最终框内两段边框完全重合。
 *
 * 坐标系：普通 {lat,lng}（GCJ02 渲染坐标），轴对齐矩形（地图拖框即地理 bbox）。
 * 本文件不依赖 Leaflet，便于单元测试。
 *
 * 拓扑约定（见 analyzeRingInRect）：仅处理环与矩形"单段进出"（恰 2 个穿越交点）
 * 的情况；全包含 / 完全不相交 / 多次进出一律跳过（'none' | 'ambiguous'）。
 */

export interface MMPoint {
  lat: number
  lng: number
}

export interface MMRect {
  south: number
  west: number
  north: number
  east: number
}

/** 环与矩形边界的一个穿越交点 */
export interface MMCrossing {
  /** 交点所在边的起点顶点索引（边 closed: i→(i+1)%n；open: i→i+1） */
  edge: number
  /** 沿该边从起点出发的参数 t∈[0,1] */
  t: number
  pt: MMPoint
  /** 沿环方向是否"由框外进入框内"（false=由框内穿出） */
  enter: boolean
}

export type MMAnalysisStatus = 'single' | 'none' | 'ambiguous'

export interface MMAnalysis {
  status: MMAnalysisStatus
  /** 沿环方向排序的穿越交点（single 时恰 2 个：[entry, exit]） */
  crossings: MMCrossing[]
}

export type MMAlignReason = 'editable-not-single' | 'reference-not-single' | 'too-few-points'

export interface MMAlignResult {
  ok: boolean
  /** 开放环（面由调用方补闭合重复点）；ok=false 时为 null */
  ring: MMPoint[] | null
  reason?: MMAlignReason
}

const EPS = 1e-9

function clonePt(k: MMPoint): MMPoint {
  return { lat: k.lat, lng: k.lng }
}

/** 轴对齐矩形内（含边界）判定。 */
export function insideRect(p: MMPoint, r: MMRect): boolean {
  return p.lat >= r.south - EPS && p.lat <= r.north + EPS
    && p.lng >= r.west - EPS && p.lng <= r.east + EPS
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * 线段 p→q 与矩形的参数重叠区间 [t0,t1]（Liang–Barsky）。
 * t0>t1 表示不相交；t0=0 表示起点在框内/边界，t1=1 表示终点在框内/边界。
 * 一条边可以"穿入再穿出"（长边扫过矩形、两端都在框外），
 * 因此不能只比较两端点的内外标志。
 */
function edgeClipRange(p: MMPoint, q: MMPoint, r: MMRect): { t0: number; t1: number } | null {
  let tLow = 0
  let tHigh = 1
  const slabs: Array<[number, number, 'lat' | 'lng']> = [
    [r.south, r.north, 'lat'],
    [r.west, r.east, 'lng'],
  ]
  for (const [lo, hi, key] of slabs) {
    const pv = p[key]
    const d = q[key] - pv
    if (Math.abs(d) < EPS) {
      if (pv < lo - EPS || pv > hi + EPS) return null // 平行且在该 slab 外
      continue
    }
    let ta = (lo - pv) / d
    let tb = (hi - pv) / d
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp }
    tLow = Math.max(tLow, ta)
    tHigh = Math.min(tHigh, tb)
    if (tLow > tHigh + EPS) return null
  }
  return { t0: tLow, t1: tHigh }
}

function crossingAt(p: MMPoint, q: MMPoint, edge: number, t: number, enter: boolean): MMCrossing {
  return { edge, t, pt: { lat: lerp(p.lat, q.lat, t), lng: lerp(p.lng, q.lng, t) }, enter }
}

/**
 * 分析一条环与矩形的穿越关系。
 * @param closed 面环=true（首尾闭合、边数=顶点数）；线=false（边数=n-1）
 *
 * 对每条边求与矩形的参数重叠区间：t0>0 产生穿入交点、t1<1 产生穿出交点。
 * 恰 2 个交点（一进一出）= single；0 个 = none（全包含/不相交）；其余 = ambiguous。
 */
export function analyzeRingInRect(ring: MMPoint[], closed: boolean, rect: MMRect): MMAnalysis {
  const n = ring.length
  if (n < 2) return { status: 'none', crossings: [] }
  const edgeCount = closed ? n : n - 1
  const crossings: MMCrossing[] = []
  for (let e = 0; e < edgeCount; e++) {
    const a = ring[e]
    const bIndex = closed ? (e + 1) % n : e + 1
    const b = ring[bIndex]
    const clip = edgeClipRange(a, b, rect)
    if (!clip) continue
    if (clip.t0 > EPS) crossings.push(crossingAt(a, b, e, clip.t0, true))
    if (clip.t1 < 1 - EPS) crossings.push(crossingAt(a, b, e, clip.t1, false))
  }
  if (crossings.length === 0) return { status: 'none', crossings: [] }
  if (crossings.length !== 2) return { status: 'ambiguous', crossings }
  // 同进同出（顶点压边等退化）不做处理
  if (crossings[0].enter === crossings[1].enter) return { status: 'ambiguous', crossings }
  // 闭合环框内段可能跨索引 0，沿边序先遇 exit —— 规范成 [entry, exit]；
  // 开放线要求严格"外→内→外"（首段在框外），否则框内段在线两端不连续。
  if (closed) {
    if (!crossings[0].enter) crossings.reverse()
  } else if (!(crossings[0].enter && !crossings[1].enter)) {
    return { status: 'ambiguous', crossings }
  }
  return { status: 'single', crossings }
}

/**
 * 沿环方向收集 fromEdge+1 … toEdge（含 toEdge）之间的顶点。
 * 闭合环允许跨索引 0 循环；entry/exit 落在同一条边时（长边扫过框）无中间顶点。
 */
function verticesBetween(ring: MMPoint[], closed: boolean, fromEdge: number, toEdge: number): MMPoint[] {
  if (fromEdge === toEdge) return []
  const n = ring.length
  const out: MMPoint[] = []
  let i = fromEdge + 1
  for (let guard = 0; guard <= n; guard++) {
    const idx = ((i % n) + n) % n
    out.push(clonePt(ring[idx]))
    if (idx === toEdge) break
    if (!closed && idx >= n - 1) break
    i++
  }
  return out
}

/** 近似平面距离平方（中纬度经度修正，仅用于参考段方向二选一，足够稳健）。 */
function dist2(a: MMPoint, b: MMPoint): number {
  const k = Math.cos(((a.lat + b.lat) * Math.PI) / 360)
  const dl = (a.lng - b.lng) * k
  const da = a.lat - b.lat
  return dl * dl + da * da
}

/** 环在矩形内的单段折线（入口交点 → 框内顶点 → 出口交点）；非 single 返回 null。 */
export function insideSegmentPoints(ring: MMPoint[], closed: boolean, rect: MMRect): MMPoint[] | null {
  const a = analyzeRingInRect(ring, closed, rect)
  if (a.status !== 'single') return null
  const [entry, exit] = a.crossings
  const pts: MMPoint[] = [clonePt(entry.pt)]
  if (entry.edge !== exit.edge) pts.push(...verticesBetween(ring, closed, entry.edge, exit.edge))
  pts.push(clonePt(exit.pt))
  return pts
}

interface Segment {
  /** 框内段：入口交点 → 中间顶点 → 出口交点 */
  points: MMPoint[]
  entry: MMPoint
  exit: MMPoint
}

/** 取参考环的框内段（按其自身环方向：entry→exit）。 */
function insideSegment(ring: MMPoint[], closed: boolean, a: MMAnalysis): Segment {
  const [entry, exit] = a.crossings
  const middle = verticesBetween(ring, closed, entry.edge, exit.edge)
  return { points: [clonePt(entry.pt), ...middle, clonePt(exit.pt)], entry: entry.pt, exit: exit.pt }
}

/**
 * 用参考环的框内段替换可编辑环的框内段。
 *
 * 结果（沿可编辑环方向）：
 * - 线：[框外前顶点…] + [参考入口交点, 参考框内顶点…, 参考出口交点] + [框外后顶点…]
 * - 面：[参考段（方向自动匹配）] + [可编辑框外顶点…]，由调用方补闭合点
 *
 * 参考段方向按两端交点总距离就近匹配（自动处理两边环方向相反）；
 * 框边处可编辑交点与参考交点不同会产生一条短连接边（两边框近似重合时长度≈0）。
 */
export function alignRingToReference(
  editableRing: MMPoint[],
  refRing: MMPoint[],
  closed: boolean,
  rect: MMRect,
): MMAlignResult {
  if (editableRing.length < (closed ? 3 : 2) || refRing.length < (closed ? 3 : 2)) {
    return { ok: false, ring: null, reason: 'too-few-points' }
  }
  const ae = analyzeRingInRect(editableRing, closed, rect)
  if (ae.status !== 'single') return { ok: false, ring: null, reason: 'editable-not-single' }
  const ar = analyzeRingInRect(refRing, closed, rect)
  if (ar.status !== 'single') return { ok: false, ring: null, reason: 'reference-not-single' }

  const [edEntry, edExit] = ae.crossings
  const refSeg = insideSegment(refRing, closed, ar)
  const middle = refSeg.points.slice(1, -1)

  // 参考段正向 / 反向放置，取端点总距离小者
  const forward = [clonePt(refSeg.entry), ...middle.map(clonePt), clonePt(refSeg.exit)]
  const reversed = [clonePt(refSeg.exit), ...middle.map(clonePt).reverse(), clonePt(refSeg.entry)]
  const useReverse =
    dist2(edEntry.pt, refSeg.exit) + dist2(edExit.pt, refSeg.entry)
    < dist2(edEntry.pt, refSeg.entry) + dist2(edExit.pt, refSeg.exit)
  const seg = useReverse ? reversed : forward

  let out: MMPoint[]
  if (closed) {
    // 框外顶点：exit 边的下一个顶点起，沿环方向到 entry 边起点（含）止
    const n = editableRing.length
    const outside: MMPoint[] = []
    let i = edExit.edge + 1
    for (let guard = 0; guard <= n; guard++) {
      const idx = ((i % n) + n) % n
      outside.push(clonePt(editableRing[idx]))
      if (idx === edEntry.edge) break
      i++
    }
    out = [...seg, ...outside]
  } else {
    // 外→内→外：前段保留 0..edEntry.edge（含框外末顶点），后段保留 edExit.edge+1..末尾
    const before = editableRing.slice(0, edEntry.edge + 1).map(clonePt)
    const after = editableRing.slice(edExit.edge + 1).map(clonePt)
    out = [...before, ...seg, ...after]
  }
  return { ok: true, ring: out }
}
