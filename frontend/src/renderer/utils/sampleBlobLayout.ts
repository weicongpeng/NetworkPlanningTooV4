/**
 * 原始采样点屏幕空间布局（防重叠）
 *
 * 在屏幕像素空间对每个投影后的采样点做两件事：
 * 1. 按最近邻像素距离收缩半径：r_i = min(期望半径, 0.5×最近邻距离)，
 *    再钳制到 [rMin, rMax]。数学上任意点对 i,j 的最近邻 nn_i ≤ d_ij，
 *    故 r_i + r_j ≤ d_ij —— 任意两斑边缘不重叠，每个斑都完整可见。
 * 2. 像素坐标取整后相同的点（同站多扇区坐标完全重合，放大也无法分开）
 *    合并为一个，保留先出现者（输入顺序稳定）。
 *
 * 最近邻用边长 rMax 的网格桶 + 5×5 邻域检索，整体 O(n)。
 */

export interface ProjectedPoint {
  x: number
  y: number
  /** 地理半径按当前 zoom 换算得到的期望像素半径（未钳制） */
  baseR: number
  /** 中心色带位置 0~1（mapValue(weight)） */
  tc: number
}

export interface LayoutOptions {
  /** 最小像素半径（低于此仍画成 rMin 的小点） */
  rMin: number
  /** 最大像素半径（放大后斑不再变大的上限） */
  rMax: number
}

export interface LaidBlob {
  x: number
  y: number
  r: number
  tc: number
}

/**
 * 对投影点做防重叠布局，返回每个点应绘制的屏幕半径。
 */
export function layoutSampleBlobs(points: ProjectedPoint[], opts: LayoutOptions): LaidBlob[] {
  const { rMin, rMax } = opts
  const n = points.length
  if (n === 0 || !(rMax > 0)) return []

  // ① 重合点合并：像素坐标取整键相同 → 只保留第一个
  const seen = new Set<string>()
  const dedup: number[] = []
  for (let i = 0; i < n; i++) {
    const p = points[i]
    const key = `${Math.round(p.x)},${Math.round(p.y)}`
    if (seen.has(key)) continue
    seen.add(key)
    dedup.push(i)
  }

  // ② 网格桶（边长 rMax），用于最近邻检索
  const buckets = new Map<string, number[]>()
  const cellOf = new Int32Array(dedup.length)
  for (let k = 0; k < dedup.length; k++) {
    const p = points[dedup[k]]
    const gx = Math.floor(p.x / rMax)
    const gy = Math.floor(p.y / rMax)
    const key = `${gx},${gy}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = []
      buckets.set(key, bucket)
    }
    bucket.push(k)
    cellOf[k] = gx
    // gy 不进 cellOf（检索时直接用点坐标重算即可，省一列存储）
  }

  const result: LaidBlob[] = []
  const nnCap = 2 * rMax

  for (let k = 0; k < dedup.length; k++) {
    const p = points[dedup[k]]
    const gx = cellOf[k]
    const gy = Math.floor(p.y / rMax)

    // 5×5 邻格：轴向 ±2rMax 内的点都能被找到（nn 超过 2rMax 时结果无差别）
    let nn2 = nnCap * nnCap
    for (let ax = gx - 2; ax <= gx + 2; ax++) {
      for (let ay = gy - 2; ay <= gy + 2; ay++) {
        const bucket = buckets.get(`${ax},${ay}`)
        if (!bucket) continue
        for (const m of bucket) {
          if (m === k) continue
          const q = points[dedup[m]]
          const dx = p.x - q.x
          const dy = p.y - q.y
          const d2 = dx * dx + dy * dy
          if (d2 < nn2) nn2 = d2
        }
      }
    }

    const nnPx = nn2 >= nnCap * nnCap ? nnCap : Math.sqrt(nn2)
    let r = Math.min(p.baseR, 0.5 * nnPx)
    if (r < rMin) r = rMin
    else if (r > rMax) r = rMax

    result.push({ x: p.x, y: p.y, r, tc: p.tc })
  }

  return result
}
