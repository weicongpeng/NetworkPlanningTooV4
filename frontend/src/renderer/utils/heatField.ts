/**
 * IDW 插值场：投影、网格桶聚合、采样与点间距统计
 *
 * 网格聚合（桶代表点）把密集区的计算量压到常数级；所有距离均在 Web Mercator 平面（米）上计算。
 * 渲染与颜色映射见 heatSurface.ts。
 */
import type { HeatPoint } from './heatmap'
export const EARTH_RADIUS = 6378137
export const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const MERCATOR_LAT_LIMIT = 85.05112878
/**
 * 覆盖半径外的渐隐倍数：值核在 1.25×桶半径处截断（高斯查表范围）。
 * 覆盖（不透明度）不再由逐桶覆盖圆决定，而是来自**区域覆盖场**（见 buildRegionAlpha）
 */
export const FADE_OUT_FACTOR = 1.25
/** 桶边长相对全局覆盖半径的倍数：桶越细，插值越接近真实 IDW（粒度粗会出现块状色块） */
const CELL_FACTOR = 0.75
/** 网格总桶数上限（按范围自适应放大桶边长，防止内存膨胀） */
const MAX_BUCKETS_SIDE = 512
/**
 * 权重核：高斯 exp(-d²/(2σ²))，σ = 桶半径 × GAUSS_SIGMA_RATIO。
 *
 * 为什么不用距离倒数幂（1/(d+d0)^p）：
 * - p=1（1/(d+1)）在采样点处导数不连续，分辨率提高后每个桶代表点会显出
 *   可见的尖峰/圆盘边界（"每个采样点颜色边界太明显"）
 * - p=2（1/(d²+d0)）在采样点附近近乎常量，形成平台，站间过渡被挤成一条陡边界
 * 高斯核在 d=0 处导数为 0（无尖峰）、又单调无平台，是 KDE 的标准核。
 *
 * 用查表替代 Math.exp（每像素每桶一次，属热路径）
 */
const GAUSS_SIGMA_RATIO = 0.5
/** 查表覆盖的 x = d/σ 上界：搜索范围为 1.25R、σ=0.5R → 2.5 */
const GAUSS_MAX_X = 2.5
const GAUSS_LUT_SIZE = 512
const gaussLut = (() => {
  const lut = new Float32Array(GAUSS_LUT_SIZE + 1)
  for (let i = 0; i <= GAUSS_LUT_SIZE; i++) {
    const x = (i / GAUSS_LUT_SIZE) * GAUSS_MAX_X
    lut[i] = Math.exp(-0.5 * x * x)
  }
  return lut
})()
/** 由 d 与桶半径直接得到查表下标的系数：idx = d × GAUSS_LUT_INDEX_SCALE / radius */
const GAUSS_LUT_INDEX_SCALE = GAUSS_LUT_SIZE / (GAUSS_MAX_X * GAUSS_SIGMA_RATIO)

/** 高斯核权重（查表，超界取 0） */
function gaussWeight(d: number, radius: number): number {
  if (!(radius > 0)) return 0
  const idx = (d * GAUSS_LUT_INDEX_SCALE) / radius
  return idx >= GAUSS_LUT_SIZE ? 0 : gaussLut[idx | 0]
}

/** 经纬度 → Web Mercator 平面（米） */
export function projectToMercator(lat: number, lng: number): { x: number; y: number } {
  const clamped = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat))
  return {
    x: lng * DEG2RAD * EARTH_RADIUS,
    y: EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG2RAD) / 2)),
  }
}

/** Web Mercator 平面（米）→ 经纬度 */
export function unprojectFromMercator(x: number, y: number): { lat: number; lng: number } {
  return {
    lat: (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * RAD2DEG,
    lng: x / (DEG2RAD * EARTH_RADIUS),
  }
}

/** IDW 采样结果（复用同一对象，避免逐像素分配） */
export interface HeatHit {
  value: number
  /** 最近贡献桶代表点到像元的距离（米） */
  distance: number
  /** 最近贡献桶的覆盖半径（米）：备用半径信息 */
  radius?: number
  /**
   * 像元不透明度（0~1）：来自**区域覆盖场**（占位桶闭运算+模糊，见 buildRegionAlpha）——
   * 区域内部连续不透明（无逐点圆盘/缝隙），仅区域外边界 ~2 格宽度渐隐。
   * 缺省时由渲染层按 distance/radius 自行计算
   */
  alpha?: number
}

/** IDW 采样场 */
export interface HeatField {
  /** 平面坐标处插值：有覆盖时写入 out 并返回 true，超出范围返回 false */
  sample(x: number, y: number, out: HeatHit): boolean
  /** 桶网格边长（米）：插值场空间粒度的元数据 */
  cell: number
  /** 场的数据范围（Mercator 米）：分布探测按此范围做均匀面积网格采样 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /**
   * 非空桶代表点的平面坐标（交错存放 [x0,y0,x1,y1,…]）。
   * 桶是等边长网格 → 每个代表点代表**相等的渲染面积**。
   */
  centroids?: Float64Array
}

/** 网格聚合桶（等长数组，按桶行列一维索引），每桶存 x 和/y 和/值和/半径和 */
interface HeatBuckets {
  /** 每桶 4 个 Float64：x 和、y 和、值和（聚合后除 count）、桶内半径最大值 */
  grid: Float64Array
  count: Uint32Array
  ixMin: number
  iyMin: number
  gw: number
  gh: number
  cell: number
  /** 桶搜索圈数：按最大逐点半径动态计算（自适应半径下大于固定 3 圈） */
  reach: number
}

function buildBuckets(
  points: HeatPoint[],
  radius: number,
  pointRadii?: Float64Array,
  cellOverride?: number
): HeatBuckets | null {
  const n = points.length
  if (n === 0 || !(radius > 0)) return null
  // 长度不对齐的逐点半径会产生 NaN 静默清空渲染，直接回退全局半径
  const radii = pointRadii && pointRadii.length >= n ? pointRadii : undefined
  // 自适应半径的最大值决定桶搜索圈数；未提供逐点半径时退化为全局半径
  let maxRadius = radius
  if (radii) {
    for (let i = 0; i < n; i++) {
      if (radii[i] > maxRadius) maxRadius = radii[i]
    }
  }

  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const p = points[i]
    const { x, y } = projectToMercator(p.lat, p.lng)
    xs[i] = x
    ys[i] = y
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  const cell = Math.max(
    cellOverride ?? radius * CELL_FACTOR,
    (maxX - minX) / MAX_BUCKETS_SIDE,
    (maxY - minY) / MAX_BUCKETS_SIDE,
    1e-3
  )
  const ixMin = Math.floor(minX / cell)
  const iyMin = Math.floor(minY / cell)
  const gw = Math.floor(maxX / cell) - ixMin + 1
  const gh = Math.floor(maxY / cell) - iyMin + 1
  const total = gw * gh
  // 每桶 4 个 Float64（x 和 / y 和 / 值和 / 半径和）+ 1 个计数
  const sums = new Float64Array(total * 4)
  const count = new Uint32Array(total)

  for (let i = 0; i < n; i++) {
    const bx = Math.floor(xs[i] / cell) - ixMin
    const by = Math.floor(ys[i] / cell) - iyMin
    const idx = by * gw + bx
    sums[idx * 4] += xs[i]
    sums[idx * 4 + 1] += ys[i]
    sums[idx * 4 + 2] += points[i].weight
    // 半径取桶内最大值（而非均值）：稀疏点的补洞半径不能被同桶密集邻居稀释
    const r = radii ? radii[i] : radius
    if (r > sums[idx * 4 + 3]) sums[idx * 4 + 3] = r
    count[idx]++
  }

  // 原地转为桶代表点：重心 + 值均值（半径槽已是桶内最大值，不再除 count）。
  // 代表点忽略密度差异，只保留"该处的值"
  for (let idx = 0; idx < total; idx++) {
    const c = count[idx]
    if (!c) continue
    sums[idx * 4] /= c
    sums[idx * 4 + 1] /= c
    sums[idx * 4 + 2] /= c
  }

  // 像素所在桶为 0 时，第 k 圈桶内点的最小距离为 (k-1)·cell，
  // 搜索圈数需覆盖到最大逐点半径的渐隐外沿 maxR×1.25
  const reach = Math.ceil((maxRadius * FADE_OUT_FACTOR) / cell) + 1
  return { grid: sums, count, ixMin, iyMin, gw, gh, cell, reach }
}

/** 收集非空桶的代表点坐标（已由 buildBuckets 原地转为桶内重心） */
function collectCentroids(b: HeatBuckets): Float64Array {
  const { grid, count } = b
  let n = 0
  for (let idx = 0; idx < count.length; idx++) if (count[idx]) n++
  const out = new Float64Array(n * 2)
  let w = 0
  for (let idx = 0; idx < count.length; idx++) {
    if (!count[idx]) continue
    out[w++] = grid[idx * 4]
    out[w++] = grid[idx * 4 + 1]
  }
  return out
}

/**
 * 可分离滑窗最大值滤波（膨胀）。r<=0 原样复制。
 * 仅用于桶网格（≤512×512），窗口按行/列直接扫描，O(cells×r)
 */
function dilateMax(src: Float32Array, gw: number, gh: number, r: number): Float32Array {
  const out = new Float32Array(gw * gh)
  if (r <= 0) {
    out.set(src)
    return out
  }
  const tmp = new Float32Array(gw * gh)
  for (let y = 0; y < gh; y++) {
    const row = y * gw
    for (let x = 0; x < gw; x++) {
      let m = 0
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(gw - 1, x + r)
      for (let k = x0; k <= x1; k++) if (src[row + k] > m) m = src[row + k]
      tmp[row + x] = m
    }
  }
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let m = 0
      const y0 = Math.max(0, y - r)
      const y1 = Math.min(gh - 1, y + r)
      for (let k = y0; k <= y1; k++) if (tmp[k * gw + x] > m) m = tmp[k * gw + x]
      out[y * gw + x] = m
    }
  }
  return out
}

/** 桶网格上的盒式模糊（边界钳位，可指定遍数，近似高斯） */
function blurSmallGrid(src: Float32Array, gw: number, gh: number, r: number, passes = 2): Float32Array {
  let cur = src
  const tmp = new Float32Array(gw * gh)
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(gw * gh)
    for (let y = 0; y < gh; y++) {
      const row = y * gw
      for (let x = 0; x < gw; x++) {
        let sum = 0
        const x0 = Math.max(0, x - r)
        const x1 = Math.min(gw - 1, x + r)
        for (let k = x0; k <= x1; k++) sum += cur[row + k]
        tmp[row + x] = sum / (x1 - x0 + 1)
      }
    }
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let sum = 0
        const y0 = Math.max(0, y - r)
        const y1 = Math.min(gh - 1, y + r)
        for (let k = y0; k <= y1; k++) sum += tmp[k * gw + x]
        out[y * gw + x] = sum / (y1 - y0 + 1)
      }
    }
    cur = out
  }
  return cur
}

/**
 * 双线性采样桶网格（gx/gy 为桶网格坐标，越界钳位）。
 * 用于把桶级 alpha 场/值回退场连续化到像元级
 */
function bilinearSample(grid: Float32Array, gw: number, gh: number, gx: number, gy: number): number {
  const x = Math.max(0, Math.min(gw - 1, gx))
  const y = Math.max(0, Math.min(gh - 1, gy))
  const i0 = Math.floor(x)
  const j0 = Math.floor(y)
  const i1 = Math.min(gw - 1, i0 + 1)
  const j1 = Math.min(gh - 1, j0 + 1)
  const fx = x - i0
  const fy = y - j0
  const a = grid[j0 * gw + i0]
  const b = grid[j0 * gw + i1]
  const c = grid[j1 * gw + i0]
  const d = grid[j1 * gw + i1]
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

/**
 * 区域覆盖场（0~1，桶网格分辨率）：占位桶做**形态学闭运算**桥接相邻簇间缝隙，
 * 再模糊成边界平滑的连续覆盖——替代旧"逐桶覆盖圆"模型：
 * 旧模型 alpha = 桶半径内不透明 + 窄渐隐带，稀疏区圆盘互不相接 → 波点状圆盘与覆盖空洞。
 *
 * 闭运算半径 2 格（≈1.5R）：桥接 ≤3R 宽的缝隙；更宽的海湾保持敞开，
 * 避免把大片无数据区域强行填满。模糊后按峰值归一，孤立单桶也有可见的软斑块
 * （中心不透明、四周 ~2 格渐隐），区域内部 alpha=1 无镶边。
 *
 * 网格四周 pad PAD_CELLS 格（值 0）：保证越出桶网格后双线性钳位取到的是 0，
 * 孤立点/边缘区域的 alpha 随距离衰减而不是沿边界值无限外推
 */
function buildRegionAlpha(b: HeatBuckets): { grid: Float32Array; pw: number; ph: number } {
  const { count, gw, gh } = b
  const pw = gw + 2 * PAD_CELLS
  const ph = gh + 2 * PAD_CELLS
  const n = pw * ph
  const occ = new Float32Array(n)
  for (let by = 0; by < gh; by++) {
    const row = (by + PAD_CELLS) * pw + PAD_CELLS
    for (let bx = 0; bx < gw; bx++) occ[row + bx] = count[by * gw + bx] ? 1 : 0
  }
  const CLOSE_CELLS = 2
  // 闭运算 = 膨胀 → 腐蚀：桥接 ≤2×CLOSE_CELLS 格宽的缝隙，再恢复区域外轮廓
  const dil = dilateMax(occ, pw, ph, CLOSE_CELLS)
  const inv = new Float32Array(n)
  for (let i = 0; i < n; i++) inv[i] = 1 - dil[i]
  const erodedInv = dilateMax(inv, pw, ph, CLOSE_CELLS)
  const closed = new Float32Array(n)
  for (let i = 0; i < n; i++) closed[i] = 1 - erodedInv[i]
  // 边界平滑：r=1（≈0.75R）两遍盒式模糊 → ~2 格宽度渐隐、深入 2 格即饱和；
  // 按峰值归一，保证小区域/孤立桶的中心不透明
  const blurred = blurSmallGrid(closed, pw, ph, 1, 2)
  let max = 0
  for (let i = 0; i < n; i++) if (blurred[i] > max) max = blurred[i]
  const out = new Float32Array(n)
  if (max > 0) {
    for (let i = 0; i < n; i++) out[i] = Math.min(1, blurred[i] / max)
  }
  return { grid: out, pw, ph }
}

/**
 * 整体趋势场（桶网格分辨率，无数据处为 NaN）：占位值的归一化模糊（邻域平均）。
 * 双重用途：
 * - 细节增强的"整体"端：与桶粒度 IDW 细节场按 detail 比例凸组合（融合不超界）；
 * - 桥接缝隙区兜底：±reach 搜索窗内无核贡献（sumW=0）时直接取趋势场值，
 *   与 IDW 在核作用边界处衔接平滑
 */
function buildRegionalValues(b: HeatBuckets): { grid: Float32Array; pw: number; ph: number } {
  const { grid, count, gw, gh } = b
  const pw = gw + 2 * PAD_CELLS
  const ph = gh + 2 * PAD_CELLS
  const n = pw * ph
  const v = new Float32Array(n)
  const w = new Float32Array(n)
  for (let by = 0; by < gh; by++) {
    const row = (by + PAD_CELLS) * pw + PAD_CELLS
    for (let bx = 0; bx < gw; bx++) {
      const idx = by * gw + bx
      if (count[idx]) {
        v[row + bx] = grid[idx * 4 + 2]
        w[row + bx] = 1
      }
    }
  }
  const FILL_CELLS = 2
  const vb = blurSmallGrid(v, pw, ph, FILL_CELLS, 2)
  const wb = blurSmallGrid(w, pw, ph, FILL_CELLS, 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = wb[i] > 1e-3 ? vb[i] / wb[i] : NaN
  return { grid: out, pw, ph }
}

/** 区域/回退场的桶网格外扩格数：模糊半径 + 1，保证边界外钳位值为 0/NaN */
const PAD_CELLS = 3

/** 由桶网格构建采样场；blend = 细节场占比（0=纯整体趋势场，1=纯站点级细节场） */
function makeSampler(coarse: HeatBuckets, fine: HeatBuckets, blend: number): HeatField {
  const { grid, count, ixMin, iyMin, gw, gh, cell, reach } = coarse
  const { grid: regionAlpha, pw, ph } = buildRegionAlpha(coarse)
  const { grid: regionalValues } = buildRegionalValues(coarse)
  // 细节场：**站点尺度细粒度网格**（cell 由点间距决定，与平滑半径无关）——
  // 平滑强度把粗网格抹平的站点级差异，只有更细的网格才保留得住
  const f = fine.grid
  const fCount = fine.count
  const fIxMin = fine.ixMin
  const fIyMin = fine.iyMin
  const fGw = fine.gw
  const fGh = fine.gh
  const fCell = fine.cell
  const fReach = fine.reach
  return {
    // 探测基准用**细节网格**的代表点：渲染值来自细节场，粗桶代表点采不到
    // 细节场的站内变化（分布标定偏窄 → 个别色带段面积≈0）
    centroids: collectCentroids(fine),
    cell,
    bounds: {
      minX: coarse.ixMin * cell,
      minY: coarse.iyMin * cell,
      maxX: (coarse.ixMin + gw) * cell,
      maxY: (coarse.iyMin + gh) * cell,
    },
    sample(x: number, y: number, out: HeatHit) {
      // 细节场：细粒度网格高斯 IDW（站点尺度栅格采样）
      let detailValue = NaN
      let fineSumW = 0
      {
        const cx = Math.floor(x / fCell) - fIxMin
        const cy = Math.floor(y / fCell) - fIyMin
        let sumW = 0
        let sumV = 0
        for (let dy = -fReach; dy <= fReach; dy++) {
          const by = cy + dy
          if (by < 0 || by >= fGh) continue
          const rowBase = by * fGw
          for (let dx = -fReach; dx <= fReach; dx++) {
            const bx = cx + dx
            if (bx < 0 || bx >= fGw) continue
            const idx = rowBase + bx
            if (!fCount[idx]) continue
            const ddx = f[idx * 4] - x
            const ddy = f[idx * 4 + 1] - y
            const d2 = ddx * ddx + ddy * ddy
            const bucketRadius = f[idx * 4 + 3]
            const limit = bucketRadius * FADE_OUT_FACTOR
            if (d2 > limit * limit) continue
            const d = Math.sqrt(d2)
            // 高斯核（查表）：σ 取该桶半径的一半，站点级平滑
            const w = gaussWeight(d, bucketRadius)
            sumW += w
            sumV += w * f[idx * 4 + 2]
          }
        }
        if (sumW > 0) {
          detailValue = sumV / sumW
          fineSumW = sumW
        }
      }
      // 粗网格高斯 IDW（自适应半径）：中尺度过渡 + 稀疏区补洞的基准场
      let coarseValue = NaN
      let minD2 = Infinity
      let nearestR = 0
      {
        const cx = Math.floor(x / cell) - ixMin
        const cy = Math.floor(y / cell) - iyMin
        let sumW = 0
        let sumV = 0
        for (let dy = -reach; dy <= reach; dy++) {
          const by = cy + dy
          if (by < 0 || by >= gh) continue
          const rowBase = by * gw
          for (let dx = -reach; dx <= reach; dx++) {
            const bx = cx + dx
            if (bx < 0 || bx >= gw) continue
            const idx = rowBase + bx
            if (!count[idx]) continue
            const ddx = grid[idx * 4] - x
            const ddy = grid[idx * 4 + 1] - y
            const d2 = ddx * ddx + ddy * ddy
            const bucketRadius = grid[idx * 4 + 3]
            const limit = bucketRadius * FADE_OUT_FACTOR
            if (d2 > limit * limit) continue
            const d = Math.sqrt(d2)
            const w = gaussWeight(d, bucketRadius)
            sumW += w
            sumV += w * grid[idx * 4 + 2]
            if (d2 < minD2) {
              minD2 = d2
              nearestR = bucketRadius
            }
          }
        }
        if (sumW > 0) coarseValue = sumV / sumW
      }
      // pad 后粗网格坐标：pad 环使双线性在原网格外的钳位值为 0/NaN
      const gx = x / cell - coarse.ixMin - 0.5 + PAD_CELLS
      const gy = y / cell - coarse.iyMin - 0.5 + PAD_CELLS
      const trend = bilinearSample(regionalValues, pw, ph, gx, gy)
      // 三层组合（由细到粗逐级兜底）：
      // 1) 细节场优先：blend 比例 × **细节覆盖度软权重** 混合粗场与细节场。
      //    覆盖度 = 细核权重质量的 smoothstep（桶中心=1，随远离斑点平滑衰减到 0）
      //    → 斑点从中心向边缘逐渐淡化、与整体色块完美衔接，消除细节场/粗场
      //    硬切换处的分界线（高斯查表在 1.25×半径处截断仍残留 ~4% 权重，
      //    硬切换会在斑点边缘形成可见台阶）
      // 2) 细节核够不到（密集区外过渡带/稀疏区间隙）→ 粗场承担中尺度过渡
      // 3) 粗场也无核贡献（桥接缝隙中带）→ 整体趋势场兜底（连续渲染，无覆盖空洞）
      if (Number.isFinite(detailValue)) {
        if (Number.isFinite(coarseValue)) {
          const t = Math.min(1, fineSumW)
          const coverage = t * t * (3 - 2 * t)
          out.value = coarseValue + (detailValue - coarseValue) * (blend * coverage)
        } else {
          out.value = detailValue
        }
      } else if (Number.isFinite(coarseValue)) {
        out.value = coarseValue
      } else if (Number.isFinite(trend)) {
        out.value = trend
      } else {
        return false
      }
      out.distance = Math.sqrt(minD2)
      out.radius = nearestR
      out.alpha = bilinearSample(regionAlpha, pw, ph, gx, gy)
      return true
    },
  }
}

/**
 * 构建 IDW 采样场（空输入或无覆盖半径时返回 null）。
 *
 * 双尺度结构（整体与细节按比例融合）：
 * - **整体趋势场**：粗网格（cell=0.75×全局半径）占位值的邻域平均，承担区域分布；
 * - **细节场**：细粒度网格（cell 由**点间距**决定，与平滑半径无关）上的高斯 IDW，
 *   保留被平滑强度抹平的站点级差异（参考 MapInfo 网格渲染的站点斑点纹理）。
 * @param radius 全局覆盖半径（米），粗网格与整体趋势的基准
 * @param pointRadii 逐点覆盖半径（米，与 points 对齐）：稀疏区粗网格桶半径放大补洞；
 *                   不传时所有桶使用全局半径
 * @param detail 细节增强 0~100：趋势场 ↔ 细节场的凸组合比例
 *               （0=纯趋势场，100=纯细节场；缺省 100 保持纯插值行为）
 * @param sampling 栅格采样粒度 1~30（缺省 4）：细节网格边长相对**点间距**的倍数——
 *               1=站点级最细，越大细节斑点越大越融合；粗于趋势网格时自动封顶
 */
export function buildHeatField(
  points: HeatPoint[],
  radius: number,
  pointRadii?: Float64Array,
  detail?: number,
  sampling?: number
): HeatField | null {
  const coarse = buildBuckets(points, radius, pointRadii)
  if (!coarse) return null
  const d = Math.min(100, Math.max(0, Number.isFinite(detail) ? detail! : 100))
  const samp = Math.min(30, Math.max(1, Number.isFinite(sampling) ? sampling! : 4))
  // 细节网格粒度 = 站点间距 ×0.75×采样倍数，但不粗于趋势网格、
  // 不细于范围/512（内存上限，MAX_BUCKETS_SIDE 兜底）
  const nn = nearestNeighborDistances(points)
  const sorted = Float64Array.from(nn).sort()
  // 采样间距基准只统计**非零**最近邻距离（= 站间距）：小区级数据同站多扇区
  // 坐标完全重合（nn=0）占比常超一半甚至九成，直接取 P50/P90 会得 0 →
  // spacing=0 → 细网格退化为 span/512 固定粒度，「栅格采样」设置完全失效
  let posCount = 0
  for (let i = 0; i < sorted.length; i++) if (sorted[i] > 0) posCount++
  const posStart = sorted.length - posCount
  const spacingP50 = posCount > 0 ? sorted[posStart + Math.floor(0.5 * (posCount - 1))] : 0
  const spacingP90 = posCount > 0 ? sorted[posStart + Math.round(0.9 * (posCount - 1))] : 0
  let span = 0
  {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < points.length; i++) {
      const m = projectToMercator(points[i].lat, points[i].lng)
      const dx = m.x
      const dy = m.y
      if (dx < minX) minX = dx
      if (dx > maxX) maxX = dx
      if (dy < minY) minY = dy
      if (dy > maxY) maxY = dy
    }
    span = Math.max(maxX - minX, maxY - minY)
  }
  // 非零间距缺失（全重合/单点极端）→ 按密度半径兜底，避免细网格退化到毫米级
  const spacing = spacingP50 > 0 ? spacingP50 : Math.max(spacingP90, Math.sqrt(Math.max(span * span, 1) / Math.max(1, points.length)))
  const fineCell = Math.min(
    coarse.cell,
    Math.max(0.75 * spacing * samp, span / 512, 1e-3)
  )
  // 细节核扩散半径 = 2×细网格边长（站点斑点充分外扩、与邻域/整体色块软融合；
  // 核作用范围 1.25×半径 = 2.5×cell ≫ 代表点最大间距 √2×cell），
  // P90 站间距项兜底极稀疏场景；上限 = 全局半径——细网格被 coarse.cell 封顶
  // 后退化为与粗网格同粒度时，细节场绝不能比粗场更平滑（否则"细节增强"方向反转）
  const fineRadius = Math.min(Math.max(2 * fineCell, 0.9 * spacingP90), radius)
  const fine = buildBuckets(points, fineRadius, undefined, fineCell)
  return makeSampler(coarse, fine ?? coarse, d / 100)
}

/**
 * 每个采样点的最近邻距离（米，与 points 对齐）：全局半径与细节网格粒度的共同依据。
 * 与视口无关（基于全量点），故缩放/平移时半径不变、颜色不跳。
 * 网格分桶 + 环形扩散精确最近邻：稠密区一环内命中（近似 O(n)）；
 * 孤立点向外扩环直到命中——3×3 网格近似会把孤立点的最近邻低估为 2×cell，
 * 曾导致细节核半径过小、站点间失去融合（硬阶跃色块）
 */
export function nearestNeighborDistances(points: HeatPoint[]): Float64Array {
  const n = points.length
  const distances = new Float64Array(n)
  if (n < 2) return distances

  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const { x, y } = projectToMercator(points[i].lat, points[i].lng)
    xs[i] = x
    ys[i] = y
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  const area = Math.max((maxX - minX) * (maxY - minY), Math.max(maxX - minX, maxY - minY) ** 2 * 0.05, 1)
  const cell = Math.max(Math.sqrt(area / n), 1)
  const buckets = new Map<string, number[]>()
  let ringLimit = 1
  for (let i = 0; i < n; i++) {
    const key = `${Math.floor(xs[i] / cell)},${Math.floor(ys[i] / cell)}`
    const arr = buckets.get(key)
    if (arr) arr.push(i)
    else buckets.set(key, [i])
  }
  {
    // 环形扩散上界：桶坐标跨度 + 1（任意两点都可达）
    let maxCx = -Infinity
    let minCx = Infinity
    let maxCy = -Infinity
    let minCy = Infinity
    for (let i = 0; i < n; i++) {
      const bx = Math.floor(xs[i] / cell)
      const by = Math.floor(ys[i] / cell)
      if (bx < minCx) minCx = bx
      if (bx > maxCx) maxCx = bx
      if (by < minCy) minCy = by
      if (by > maxCy) maxCy = by
    }
    ringLimit = Math.max(maxCx - minCx, maxCy - minCy) + 1
  }

  for (let i = 0; i < n; i++) {
    const cx = Math.floor(xs[i] / cell)
    const cy = Math.floor(ys[i] / cell)
    let best = Infinity
    outer:
    for (let ring = 1; ring <= ringLimit; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          // 只扫外环（内环上一轮已查过）
          if (ring > 1 && Math.max(Math.abs(dx), Math.abs(dy)) < ring) continue
          const arr = buckets.get(`${cx + dx},${cy + dy}`)
          if (!arr) continue
          for (const j of arr) {
            if (j === i) continue
            const ddx = xs[j] - xs[i]
            const ddy = ys[j] - ys[i]
            const d2 = ddx * ddx + ddy * ddy
            if (d2 < best) best = d2
            // 坐标重合（同站多扇区/重复行常见）：0 已是最小距离，立即结束，
            // 否则 5 万个重合点同桶会退化成 O(n²) 卡死主线程
            if (best === 0) break outer
          }
        }
      }
      // 本环找到候选即可停：更远环只会更大（环形扩散精确最近邻，
      // 3×3 网格近似会把孤立点的最近邻低估为 2×cell，导致细节核半径过小失去融合）
      if (best !== Infinity) break
    }
    distances[i] = best === Infinity ? 0 : Math.sqrt(best)
  }
  return distances
}

/**
 * 采样点最近邻距离的分位数（米）：全局搜索半径的依据。
 * 用高分位而非平均值：点分布不均时稀疏区的间距远大于均值，取均值会让稀疏区出现渲染空洞。
 */
export function nearestNeighborDistance(points: HeatPoint[], percentile = 0.9): number {
  const distances = nearestNeighborDistances(points)
  if (distances.length < 2) return 0
  const sorted = Float64Array.from(distances).sort()
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(percentile * (sorted.length - 1))))
  return sorted[index]
}
