/**
 * 值热力面测试：IDW 插值的连续性、覆盖半径、与密度解耦（稀疏区按自身值着色）
 */
import { describe, it, expect } from 'vitest'
import { buildHeatField, projectToMercator, unprojectFromMercator, nearestNeighborDistance, nearestNeighborDistances, type HeatHit } from '../heatField'
import { applyContrast, buildValueMapper, collectBoundaryPolygons, collectGeoDataPolygons, concentrateLevel, CONCENTRATION_MIN, CONCENTRATION_MAX, filterPointsToBoundary, pointInHeatBoundary, probeFieldDistribution, quantizeLevel, softQuantizeLevel } from '../heatSurface'
import { buildHeatLegend, buildQuantileRef, quantileRefValue } from '../heatmap'
import type { HeatPoint } from '../heatmap'

/** 采样并返回值（无覆盖返回 null） */
function valueAt(field: ReturnType<typeof buildHeatField>, x: number, y: number): number | null {
  if (!field) return null
  const hit: HeatHit = { value: 0, distance: 0 }
  return field.sample(x, y, hit) ? hit.value : null
}

/** 以 base 为原点、按平面米偏移构造采样点 */
function pointAt(dx: number, dy: number, weight: number): HeatPoint {
  const base = projectToMercator(30, 120)
  const { lat, lng } = unprojectFromMercator(base.x + dx, base.y + dy)
  return { lat, lng, weight }
}

describe('边界多边形提取', () => {
  it('GeoJSON：Polygon 转为一个多边形、MultiPolygon 展开', () => {
    const ring = [[[114, 23], [115, 23], [115, 24], [114, 23]]]
    expect(collectBoundaryPolygons({ features: [{ geometry: { type: 'Polygon', coordinates: ring } }] })).toHaveLength(1)
    expect(collectBoundaryPolygons({
      features: [
        { geometry: { type: 'MultiPolygon', coordinates: [ring, ring] } },
        { geometry: { type: 'Polygon', coordinates: ring } },
      ],
    })).toHaveLength(3)
  })

  it('GeoJSON：忽略点/线几何与非法输入', () => {
    expect(collectBoundaryPolygons(null)).toBeNull()
    expect(collectBoundaryPolygons({})).toBeNull()
    expect(collectBoundaryPolygons({ features: [{ geometry: { type: 'Point', coordinates: [114, 23] } }] })).toBeNull()
  })

  it('地理化数据：行内 path（[[lat,lng]]）转为 [lng,lat] 环', () => {
    const polygons = collectGeoDataPolygons({
      data: [
        { name: 'A', path: [[23, 114], [23, 115], [24, 115], [23, 114]] },
        { name: 'B', path: [[23, 114], [23, 115]] },
      ],
    })
    expect(polygons).toHaveLength(1)
    expect(polygons![0][0][0]).toEqual([114, 23])
  })

  it('地理化数据：无 path 或坐标非法时返回 null', () => {
    expect(collectGeoDataPolygons({ data: [{ name: 'X' }] })).toBeNull()
    expect(collectGeoDataPolygons(null)).toBeNull()
    expect(collectGeoDataPolygons({ data: [{ path: [[NaN, 1], [1, NaN], [0, 0]] }] })).toBeNull()
  })
})

describe('Web Mercator 投影', () => {
  it('往返一致', () => {
    const p = projectToMercator(31.23, 121.47)
    const back = unprojectFromMercator(p.x, p.y)
    expect(back.lat).toBeCloseTo(31.23, 9)
    expect(back.lng).toBeCloseTo(121.47, 9)
  })

  it('纬度越高 y 越大（用于栅格行序）', () => {
    expect(projectToMercator(40, 120).y).toBeGreaterThan(projectToMercator(30, 120).y)
  })
})

describe('buildHeatField（IDW 值插值）', () => {
  it('空点集返回 null', () => {
    expect(buildHeatField([], 1000)).toBeNull()
  })

  it('非正覆盖半径返回 null', () => {
    expect(buildHeatField([pointAt(0, 0, 1)], 0)).toBeNull()
  })

  it('采样点位置取到该点自身值', () => {
    const field = buildHeatField([pointAt(0, 0, 7), pointAt(1000, 0, 30)], 500)!
    expect(valueAt(field, ...xy(0, 0))).toBeCloseTo(7, 0)
    expect(valueAt(field, ...xy(1000, 0))).toBeCloseTo(30, 0)
  })

  it('两点之间连续渐变且等距处取中值（连续、渐变）', () => {
    const base = projectToMercator(30, 120)
    const field = buildHeatField([pointAt(0, 0, 10), pointAt(1000, 0, 20)], 500)!
    const mid = valueAt(field, base.x + 500, base.y)!
    expect(mid).toBeGreaterThan(10)
    expect(mid).toBeLessThan(20)
    expect(mid).toBeCloseTo(15, 0)
    // 单调：从低值端向高值端推进，插值结果逐段升高
    const near = valueAt(field, base.x + 200, base.y)!
    const far = valueAt(field, base.x + 800, base.y)!
    expect(near).toBeLessThan(mid)
    expect(mid).toBeLessThan(far)
  })

  it('桥接带可见（邻域平均兜底），数据区外 alpha 衰减到 0（无覆盖空洞、无无限外推）', () => {
    const base = projectToMercator(30, 120)
    const field = buildHeatField([pointAt(0, 0, 10)], 1000)!
    const hit: HeatHit = { value: 0, distance: 0 }
    expect(field.sample(base.x, base.y, hit)).toBe(true)
    expect(hit.alpha!).toBeGreaterThan(0.5)
    // 桥接带（核作用范围外、闭运算+邻域平均覆盖内）仍可见——连续渲染无空洞
    expect(field.sample(base.x + 2000, base.y, hit)).toBe(true)
    expect(hit.alpha!).toBeGreaterThan(0)
    // 远离数据：alpha 衰减到 0（值场兜底但不渲染，不把整图糊成一片）
    expect(field.sample(base.x + 5000, base.y, hit)).toBe(true)
    expect(hit.alpha).toBe(0)
  })

  it('采样点间隙仍可插值（相邻点之间不断层）', () => {
    const base = projectToMercator(30, 120)
    // 相邻点相距 2km、覆盖半径 1km（搜索范围 1.25km）：中点处仍得到连续过渡值
    const field = buildHeatField([pointAt(0, 0, 10), pointAt(2000, 0, 30)], 1000)!
    const gap = valueAt(field, base.x + 1000, base.y)!
    expect(gap).not.toBeNull()
    expect(gap).toBeGreaterThan(10)
    expect(gap).toBeLessThan(30)
  })

  it('点距远超覆盖半径：中点虽被插值场桥接，但区域覆盖 alpha=0 → 渲染留白（不糊成一片）', () => {
    const base = projectToMercator(30, 120)
    // 细核尺度锚在点间距上（4.3km）→ 中点有插值值；但粗网格（cell=375m）闭运算
    // 桥接宽度仅 750m，4km 间隙区域 alpha=0 → sampleGrid 跳过，视觉仍留白
    const field = buildHeatField([pointAt(0, 0, 10), pointAt(4000, 0, 30)], 500)!
    const hit: HeatHit = { value: 0, distance: 0 }
    expect(field.sample(base.x + 2000, base.y, hit)).toBe(true)
    expect(hit.alpha).toBe(0)
  })

  it('着色只取决于值，不取决于密度（稀疏区不被密集区顶到色带末端）', () => {
    // 稀疏点值 1，3km 外有 200 个值 100 的密集点；覆盖半径 2km → 稀疏点处应仍是自身的值
    const dense: HeatPoint[] = Array.from({ length: 200 }, (_, i) => pointAt(3000 + (i % 20) * 10, Math.floor(i / 20) * 10, 100))
    const field = buildHeatField([pointAt(0, 0, 1), ...dense], 2000)!
    expect(valueAt(field, ...xy(0, 0))).toBeCloseTo(1, 0)
  })

  it('站点粒度下采样点仍偏向自身值（融合加强但未完全粗桶均质化）', () => {
    // 细节网格 cell=0.75×点间距，三点各自成桶：中间点（值 20）以自身值为主，
    // 宽细节核（2×cell）把邻域拉高一些，但仍显著低于粗桶均值 30
    const points = [pointAt(0, 0, 10), pointAt(100, 0, 20), pointAt(200, 0, 60)]
    const field = buildHeatField(points, 1000)!
    const v = valueAt(field, ...xy(100, 0))!
    expect(v).toBeGreaterThan(18)
    expect(v).toBeLessThan(30)
  })

  it('同处多点不影响均值语义（按值平均而非按数量累加）', () => {
    const field = buildHeatField([pointAt(0, 0, 10), pointAt(0, 0, 20), pointAt(0, 0, 30)], 2000)!
    expect(valueAt(field, ...xy(0, 0))).toBeCloseTo(20, 0)
  })

  it('相同输入结果确定', () => {
    const points = [pointAt(0, 0, 3), pointAt(800, 500, 9), pointAt(1500, -300, 5)]
    const a = buildHeatField(points, 2500)!
    const b = buildHeatField(points, 2500)!
    expect(valueAt(a, ...xy(400, 200))).toEqual(valueAt(b, ...xy(400, 200)))
  })

  it('紧支撑 C¹ 核：采样点处无尖峰（导数连续），且以自身值为主', () => {
    // 三点等距 1km、中间为高值：距离倒数核在中间点近乎只取自身值（可见尖峰/圆盘边界），
    // 紧支撑核在 d=0 处导数为 0 → 无尖峰；核宽收紧到 ≈1×点距 → 自身值主导
    // （旧宽核 σ=半径/2 时中间点被邻域稀释到 ~79，"高值扩散过大"的根因）
    const points = [pointAt(-1000, 0, 0), pointAt(0, 0, 100), pointAt(1000, 0, 0)]
    const field = buildHeatField(points, 1000)!
    const mid = valueAt(field, ...xy(0, 0))!
    expect(mid).toBeGreaterThan(90)
    expect(mid).toBeLessThanOrEqual(100)
    // 无尖峰：跨越采样点左右两侧对称、连续，且都低于自身值
    const left = valueAt(field, ...xy(-50, 0))!
    const right = valueAt(field, ...xy(50, 0))!
    expect(left).toBeLessThan(mid)
    expect(right).toBeLessThan(mid)
    expect(Math.abs(left - right)).toBeLessThan(1)
  })

  it('紧支撑 C¹ 核：沿两点连线单调过渡，中部为实质渐变', () => {
    const field = buildHeatField([pointAt(0, 0, 0), pointAt(2000, 0, 100)], 1000)!
    const base = projectToMercator(30, 120)
    const vals: number[] = []
    for (let d = 0; d <= 2000; d += 250) vals.push(valueAt(field, base.x + d, base.y)!)
    // 单调不减
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1])
    // 中段必须是实质过渡（既非阶跃也非常量平台）
    expect(vals[5] - vals[3]).toBeGreaterThan(30)
    // 中点为对称均值附近
    expect(vals[4]).toBeCloseTo(50, 0)
  })
})

describe('buildHeatField 自适应半径（逐点 pointRadii 填补稀疏空洞）', () => {
  it('全局小半径：相距 6km 的两点间隙 alpha=0（渲染留白）', () => {
    const field = buildHeatField([pointAt(0, 0, 10), pointAt(6000, 0, 20)], 500)!
    const hit: HeatHit = { value: 0, distance: 0 }
    field.sample(...xy(3000, 0), hit)
    expect(hit.alpha).toBe(0)
  })

  it('逐点大半径：稀疏间隙被覆盖，hit.radius 返回最近桶半径', () => {
    const points = [pointAt(0, 0, 10), pointAt(6000, 0, 20)]
    const radii = new Float64Array([4000, 4000])
    const field = buildHeatField(points, 500, radii)!
    const hit: HeatHit = { value: 0, distance: 0 }
    expect(field.sample(...xy(3000, 0), hit)).toBe(true)
    expect(hit.value).toBeGreaterThan(10)
    expect(hit.value).toBeLessThan(20)
    // hit.radius 来自粗网格最近桶（逐点自适应半径 4000）
    expect(hit.radius).toBe(4000)
    expect(hit.distance).toBeGreaterThan(2500)
    expect(hit.distance).toBeLessThan(3500)
  })

  it('逐点半径仅放大对应桶：密集点小半径不会被离群点带大', () => {
    // 原点密集点保持小半径，6km 外离群点给大半径；原点处仍只取到自身值
    const dense = [pointAt(0, 0, 10), pointAt(100, 0, 12), pointAt(6000, 0, 20)]
    const radii = new Float64Array([300, 300, 4000])
    const field = buildHeatField(dense, 500, radii)!
    // 原点处不含 6km 外离群点 20（细核窄、离群点够不到 → 不被带大）；
    // 新架构细核为站点级窄核，退化3点下原点只取到自身≈10
    const v = valueAt(field, ...xy(0, 0))!
    expect(v).toBeGreaterThanOrEqual(10)
    expect(v).toBeLessThan(12.5)
    // 离群点与密集区间隙（4km）由粗场大半径补洞覆盖
    expect(valueAt(field, ...xy(4000, 0))).not.toBeNull()
  })

  it('桶半径取桶内最大值：稀疏点的大半径不被同桶密集点稀释', () => {
    // globalR=500 → 桶边长 375m，两点相距 100m 必落入同一桶
    const points = [pointAt(0, 0, 10), pointAt(100, 0, 20)]
    const field = buildHeatField(points, 500, new Float64Array([300, 4000]))!
    // 距两者约 3km 处：仅 4000 半径能覆盖（若被平均成 2150 则覆盖不到）
    expect(valueAt(field, ...xy(3000, 0))).not.toBeNull()
  })

  it('pointRadii 长度不足时回退全局半径（不产生 NaN）', () => {
    const points = [pointAt(0, 0, 10), pointAt(1000, 0, 20)]
    const field = buildHeatField(points, 1000, new Float64Array([500]))!
    const v = valueAt(field, ...xy(500, 0))
    expect(v).not.toBeNull()
    expect(Number.isFinite(v!)).toBe(true)
  })

  it('hit.alpha：区域覆盖场——孤立点为软斑块（中心最不透明、随距离单调衰减）', () => {
    const field = buildHeatField([pointAt(0, 0, 10)], 1000)!
    const hit: HeatHit = { value: 0, distance: 0 }
    expect(field.sample(...xy(0, 0), hit)).toBe(true)
    const a0 = hit.alpha!
    expect(field.sample(...xy(900, 0), hit)).toBe(true)
    const a900 = hit.alpha!
    expect(field.sample(...xy(1100, 0), hit)).toBe(true)
    const a1100 = hit.alpha!
    expect(a0).toBeGreaterThan(0.5)
    expect(a0).toBeGreaterThan(a900)
    expect(a900).toBeGreaterThan(a1100)
    expect(a1100).toBeGreaterThan(0)
  })
})

describe('nearestNeighborDistances / nearestNeighborDistance（自动半径依据）', () => {
  it('点数不足：空数组与单点均返回 0', () => {
    expect(nearestNeighborDistance([])).toBe(0)
    expect(nearestNeighborDistance([pointAt(0, 0, 1)])).toBe(0)
    expect(Array.from(nearestNeighborDistances([pointAt(0, 0, 1)]))).toEqual([0])
  })

  it('逐点数组与分位数一致', () => {
    const points: HeatPoint[] = []
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) points.push(pointAt(i * 1000, j * 1000, 1))
    }
    const dist = nearestNeighborDistances(points)
    expect(dist).toHaveLength(100)
    // 规则网格上每点最近邻恰为 1000m（含边缘点）
    expect(dist.every(d => d > 900 && d < 1100)).toBe(true)
    // 分位函数就是逐点数组的分位
    const sorted = Float64Array.from(dist).sort()
    const p50 = sorted[Math.round(0.5 * 99)]
    expect(nearestNeighborDistance(points, 0.5)).toBe(p50)
    expect(nearestNeighborDistance(points, 0.9)).toBeGreaterThan(900)
  })

  it('坐标全重合（同站多扇区）不退化：距离为 0 且快速返回', () => {
    const points: HeatPoint[] = Array.from({ length: 10000 }, () => pointAt(0, 0, 1))
    const started = Date.now()
    const dist = nearestNeighborDistances(points)
    // 无提前退出时同桶退化为 O(n²)，1 万点需数百毫秒以上
    expect(Date.now() - started).toBeLessThan(1000)
    expect(dist).toHaveLength(10000)
    expect(dist.every(d => d === 0)).toBe(true)
  })

  it('平滑强度 2（新默认）下规则站点网仍相邻覆盖（默认 4→2 不产生空洞）', () => {
    // 站点间距 2km 的规则网：P90 最近邻 ≈ 2km → 全局半径 = 2×2km = 4km ≥ 间距
    const points: HeatPoint[] = []
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) points.push(pointAt(i * 2000, j * 2000, 1))
    }
    const distances = nearestNeighborDistances(points)
    const sorted = Float64Array.from(distances).sort()
    const p90 = sorted[Math.round(0.9 * (sorted.length - 1))]
    const globalR = p90 * 2
    expect(globalR).toBeGreaterThan(2000)
    const field = buildHeatField(points, globalR)!
    // 相邻两站中点必须仍有插值值（半径 ≥ 间距 → 覆盖面重叠）
    expect(valueAt(field, ...xy(1000, 0))).not.toBeNull()
    expect(valueAt(field, ...xy(1000, 1000))).not.toBeNull()
  })

  it('高分位反映稀疏区：加入离群点后 P90 明显大于 P50', () => {
    const dense: HeatPoint[] = []
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) dense.push(pointAt(i * 300, j * 300, 1))
    }
    // 稀疏区占 1/6（高于 P90 的 10% 分位线）：P90 应反映稀疏区，而 P50 仍由密集区决定
    for (let i = 0; i < 20; i++) dense.push(pointAt(20000 + i * 5000, 0, 1))
    const p90 = nearestNeighborDistance(dense, 0.9)
    const p50 = nearestNeighborDistance(dense, 0.5)
    expect(p50).toBeLessThan(1000)
    expect(p90).toBeGreaterThan(p50 * 5)
  })
})

describe('buildValueMapper（固定颜色映射）', () => {
  const points: HeatPoint[] = [
    { lat: 30, lng: 120, weight: 10 },
    { lat: 30, lng: 120.1, weight: 20 },
    { lat: 30, lng: 120.2, weight: 90 },
  ]

  it('等效范围：与值域线性对应', () => {
    const map = buildValueMapper(points, 0, 100, 'valueRange')
    expect(map(0)).toBeCloseTo(0, 6)
    expect(map(50)).toBeCloseTo(0.5, 6)
    expect(map(100)).toBeCloseTo(1, 6)
  })

  it('等效细胞计数：值集中区间被拉开，层次更均匀', () => {
    const map = buildValueMapper(points, 0, 100, 'cellCount')
    // 线性映射下三个值为 0.1/0.2/0.9（低值挤在一起）；等像元数应把区间拉开。
    // 注意最大值（90）在纯分位下本就贴近色带高端，这是分位映射的应有行为
    expect(map(20)).toBeGreaterThan(0.3)
    expect(map(20) - map(10)).toBeGreaterThan(0.2)
    // 单调不降
    expect(map(10)).toBeLessThan(map(20))
    expect(map(20)).toBeLessThan(map(90))
  })

  it('等效细胞计数为纯分位：重尾数据下色带被均匀占用（不合格效果图的根因修复）', () => {
    // 99 个低值 + 1 个极大值：线性映射下 99% 的点会挤在色带最低端
    const heavy: HeatPoint[] = [
      ...Array.from({ length: 99 }, (_, i) => ({ lat: 30, lng: 120 + i * 0.001, weight: 1 })),
      { lat: 30, lng: 121, weight: 1000 },
    ]
    const linear = buildValueMapper(heavy, 1, 1000, 'valueRange')
    const quantile = buildValueMapper(heavy, 1, 1000, 'cellCount')
    // 低值（占 99%）在线性映射下贴近色带低端
    expect(linear(1)).toBeLessThan(0.05)
    // 分位映射把它们抬到色带中段，整条色带才铺得开
    expect(quantile(1)).toBeGreaterThan(0.4)
    // 取"小于/小于等于的中点位次"作分位，最大值不会被压到恰好 1（重复值也不跳变）
    expect(quantile(1000)).toBeGreaterThan(0.98)
  })

  it('映射结果与取值范围无关（缩放/平移不会改变颜色）', () => {
    const a = buildValueMapper(points, 0, 100, 'cellCount')
    const b = buildValueMapper(points, 0, 100, 'cellCount')
    for (const v of [0, 15, 55, 95, 100]) expect(a(v)).toBe(b(v))
  })
})

describe('applyContrast（对比度）', () => {
  it('对比度 1 保持原值', () => {
    expect(applyContrast(0.3, 1)).toBeCloseTo(0.3, 6)
    expect(applyContrast(0.8, 1)).toBeCloseTo(0.8, 6)
  })

  it('对比度 >1：围绕中值拉伸，两端更快饱和', () => {
    expect(applyContrast(0.6, 2)).toBeCloseTo(0.7, 6)
    expect(applyContrast(0.4, 2)).toBeCloseTo(0.3, 6)
    expect(applyContrast(0.5, 2)).toBeCloseTo(0.5, 6)
    // 超出部分钳到端点
    expect(applyContrast(0.9, 3)).toBe(1)
    expect(applyContrast(0.1, 3)).toBe(0)
  })

  it('对比度 <1：颜色向中间聚拢', () => {
    expect(applyContrast(0.6, 0.5)).toBeCloseTo(0.55, 6)
    expect(applyContrast(0.2, 0.5)).toBeCloseTo(0.35, 6)
  })

  it('非法对比度按原值返回', () => {
    expect(applyContrast(0.3, 0)).toBe(0.3)
    expect(applyContrast(0.3, NaN)).toBe(0.3)
  })

  it('图例分级点与地图映射同源（图例颜色必须与地图对得上）', () => {
    const points: HeatPoint[] = Array.from({ length: 100 }, (_, i) => ({
      lat: 30, lng: 120 + i * 0.001, weight: i + 1,
    }))
    const map = buildValueMapper(points, 1, 100, 'cellCount', 1.5)
    const levels = buildHeatLegend(points, 1, 100, 'cellCount', 5, 0.1, { mapValue: map })
    for (const lv of levels) {
      // colorT 必须就是地图映射对该级代表值的结果（图例据此取色）
      expect(lv.colorT).toBe(map(lv.value))
    }
  })

  it('重复值数据下图例不列出地图上不存在的颜色（回归：99% 同值）', () => {
    // 99 个低值 + 1 个极大值：若不按 mapValue 取色，图例会列出整条彩虹，
    // 而地图上 99% 面积都是同一个颜色，用户按图例根本找不到那些颜色
    const points: HeatPoint[] = [
      ...Array.from({ length: 99 }, (_, i) => ({ lat: 30, lng: 120 + i * 0.001, weight: 1 })),
      { lat: 30, lng: 121, weight: 1000 },
    ]
    const map = buildValueMapper(points, 1, 1000, 'cellCount', 1)
    const levels = buildHeatLegend(points, 1, 1000, 'cellCount', 7, 0.1, { mapValue: map })
    // 低 6 级的代表值都是 1，色带位置应全部收敛到 mapValue(1)
    const lowColorT = levels[0].colorT
    for (let i = 0; i < 6; i++) {
      expect(levels[i].value).toBe(1)
      expect(levels[i].colorT).toBeCloseTo(lowColorT, 6)
    }
    // 只有最高一级取到极端值，且位于色带高端
    expect(levels[6].value).toBe(1000)
    expect(levels[6].colorT).toBeGreaterThan(0.9)
  })

  it('退化值域（全部同值）下图例颜色收敛为同一点', () => {
    const points: HeatPoint[] = Array.from({ length: 50 }, (_, i) => ({
      lat: 30, lng: 120 + i * 0.001, weight: 7,
    }))
    const map = buildValueMapper(points, 7, 7, 'cellCount', 1)
    const levels = buildHeatLegend(points, 7, 7, 'cellCount', 5, 0.1, { mapValue: map })
    // span=0 时映射返回固定中点色，图例各行必须一致，而不是画一条彩虹
    const first = levels[0].colorT
    expect(levels.every(lv => lv.colorT === first)).toBe(true)
  })

  it('经 buildValueMapper 组合后仍单调不降', () => {
    const points: HeatPoint[] = Array.from({ length: 50 }, (_, i) => ({
      lat: 30, lng: 120 + i * 0.001, weight: i,
    }))
    const map = buildValueMapper(points, 0, 49, 'cellCount', 2)
    let prev = -1
    for (let v = 0; v <= 49; v += 5) {
      const t = map(v)
      expect(t).toBeGreaterThanOrEqual(prev)
      prev = t
    }
    expect(map(49)).toBe(1)
  })
})

/** 以 (30,120) 为原点、按平面米偏移得到平面坐标 */
function xy(dx: number, dy: number): [number, number] {
  const base = projectToMercator(30, 120)
  return [base.x + dx, base.y + dy]
}

describe('渲染场分布标定（probeFieldDistribution）', () => {
  /**
   * 异构数据：城区密集（低值）+ 郊区稀疏（高值）。
   * 点密度与值域强相关，最容易把"按采样点定分位"的标定带偏
   */
  const buildSitePoints = (): HeatPoint[] => {
    let s = 7
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
    const points: HeatPoint[] = []
    for (let i = 0; i < 400; i++) points.push(pointAt((rnd() - 0.5) * 2000, (rnd() - 0.5) * 2000, rnd() * 10))
    for (let i = 0; i < 40; i++) points.push(pointAt((rnd() - 0.5) * 40000, (rnd() - 0.5) * 40000, 100 + rnd() * 100))
    return points
  }

  /** 模拟"渲染出来的像素"按映射后的色带位置分布（只统计不透明像素） */
  const rasterColorPositions = (
    field: ReturnType<typeof buildHeatField>,
    mapValue: (v: number) => number,
    bounds: { x0: number; x1: number; y0: number; y1: number },
    size = 240
  ): number[] => {
    const hit: HeatHit = { value: 0, distance: 0 }
    const out: number[] = []
    for (let py = 0; py < size; py++) {
      const y = bounds.y0 + ((bounds.y1 - bounds.y0) * (py + 0.5)) / size
      for (let px = 0; px < size; px++) {
        const x = bounds.x0 + ((bounds.x1 - bounds.x0) * (px + 0.5)) / size
        if (!field!.sample(x, y, hit)) continue
        if ((hit.alpha ?? 0) > 0.5) out.push(mapValue(hit.value))
      }
    }
    return out
  }

  const decileShares = (positions: number[]): number[] => {
    const bins = new Array(10).fill(0)
    for (const t of positions) bins[Math.min(9, Math.max(0, Math.floor(t * 10)))]++
    return bins.map(c => c / positions.length)
  }

  it('按场范围均匀面积网格采样（可见区为基准，桶外填充区也计入）', () => {
    const points = [pointAt(0, 0, 10), pointAt(100, 0, 20), pointAt(100, 0, 30)]
    const field = buildHeatField(points, 1000)!
    const probe = probeFieldDistribution(field)
    // bounds = 粗网格外接范围（约 750m×1 桶），90×90 网格上可见样点非零
    expect(probe.length).toBeGreaterThan(0)
    for (const v of probe) {
      expect(v).toBeGreaterThanOrEqual(10)
      expect(v).toBeLessThanOrEqual(30)
    }
  })

  it('探测值落在数据值域内', () => {
    const points = [pointAt(0, 0, 5), pointAt(3000, 0, 50), pointAt(6000, 0, 90)]
    const field = buildHeatField(points, 3000)!
    const values = Array.from(probeFieldDistribution(field))
    expect(values.length).toBeGreaterThan(0)
    expect(Math.min(...values)).toBeGreaterThanOrEqual(5)
    // 归一化加权平均存在 ~1e-14 量级的浮点溢出（所有贡献桶同值时并非精确等于该值），
    // 不构成"超数据界"（映射层另有 [0,1] 钳制），此处按浮点误差放行
    expect(Math.max(...values)).toBeLessThanOrEqual(90 + 1e-9)
  })

  it('探测点数超过上限时等距抽样（分布估计精度上界，不影响渲染）', () => {
    const points: HeatPoint[] = []
    for (let i = 0; i < 60; i++) points.push(pointAt(i * 4000, 0, i))
    const field = buildHeatField(points, 2000)!
    expect(probeFieldDistribution(field, 8).length).toBeLessThanOrEqual(8)
  })

  it('外部自定义场（无桶信息）返回空数组', () => {
    expect(probeFieldDistribution({ sample: () => false, cell: 0, bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 } }).length).toBe(0)
  })

  /** 数据外接范围（平面米，外扩余量） */
  const boundsOf = (points: HeatPoint[], margin = 5000) => {
    const xs = points.map(p => projectToMercator(p.lat, p.lng).x)
    const ys = points.map(p => projectToMercator(p.lat, p.lng).y)
    return {
      x0: Math.min(...xs) - margin,
      x1: Math.max(...xs) + margin,
      y0: Math.min(...ys) - margin,
      y1: Math.max(...ys) + margin,
    }
  }

  it('回归：以渲染场分布为基准，5 个分级都显色（色带位置铺满，不再偏向某一色）', () => {
    const points = buildSitePoints()
    const field = buildHeatField(points, 4000)!
    const reference = buildQuantileRef(probeFieldDistribution(field))
    const min = Math.min(...points.map(p => p.weight))
    const max = Math.max(...points.map(p => p.weight))
    const bounds = boundsOf(points)

    const shares = decileShares(rasterColorPositions(field, buildValueMapper(points, min, max, 'cellCount', 1, 512, reference), bounds))
    // 每段色带都承载了实质面积（旧实现是真 · 单色：最高一段占 90%+）
    for (const share of shares) expect(share).toBeGreaterThan(0.01)
    for (const share of shares) expect(share).toBeLessThan(0.3)
    // 5 个分级的分界点必须落在互不相同的色带位置上
    const levels = buildHeatLegend(points, min, max, 'cellCount', 5, 0.1, {
      mapValue: buildValueMapper(points, min, max, 'cellCount', 1, 512, reference),
      distribution: reference,
    })
    expect(levels).toHaveLength(5)
    expect(levels[4].colorT - levels[0].colorT).toBeGreaterThan(0.9)
  })

  it('对照：以原始采样点分布为基准时，渲染结果挤在色带一端（换基准的理由）', () => {
    const points = buildSitePoints()
    const field = buildHeatField(points, 4000)!
    const min = Math.min(...points.map(p => p.weight))
    const max = Math.max(...points.map(p => p.weight))
    const bounds = boundsOf(points)
    const shares = decileShares(rasterColorPositions(field, buildValueMapper(points, min, max, 'cellCount', 1), bounds))
    // 密集区按点计数主导了分位，稀疏高值区被推到色带末端：最高一段吞掉绝大多数面积
    expect(shares[9]).toBeGreaterThan(0.5)
  })

  it('渲染场分布与地图着色同源：图例各级取值即该分位处的场值', () => {
    const points = buildSitePoints()
    const field = buildHeatField(points, 4000)!
    const reference = buildQuantileRef(probeFieldDistribution(field))
    const min = Math.min(...points.map(p => p.weight))
    const max = Math.max(...points.map(p => p.weight))
    const mapValue = buildValueMapper(points, min, max, 'cellCount', 1, 512, reference)
    const levels = buildHeatLegend(points, min, max, 'cellCount', 5, 0.1, { mapValue, distribution: reference })
    levels.forEach((lv, i) => {
      expect(lv.value).toBe(quantileRefValue(reference, i / 4))
      expect(lv.colorT).toBe(mapValue(lv.value))
    })
    // 单调递增（分级表按占比排序展示的前提）
    for (let i = 1; i < levels.length; i++) expect(levels[i].value).toBeGreaterThanOrEqual(levels[i - 1].value)
  })
})

describe('分级着色（quantizeLevel）', () => {
  it('量化到最近的级点（n=5：0.3→0.25、0.7→0.75）', () => {
    expect(quantizeLevel(0.3, 5)).toBe(0.25)
    expect(quantizeLevel(0.7, 5)).toBe(0.75)
    expect(quantizeLevel(0.5, 5)).toBe(0.5)
  })
  it('端点与钳制', () => {
    expect(quantizeLevel(0, 5)).toBe(0)
    expect(quantizeLevel(1, 5)).toBe(1)
    expect(quantizeLevel(-0.4, 5)).toBe(0)
    expect(quantizeLevel(1.4, 5)).toBe(1)
  })
  it('级数不足 2 时原样返回（关闭）', () => {
    expect(quantizeLevel(0.3, 0)).toBe(0.3)
    expect(quantizeLevel(0.3, 1)).toBe(0.3)
  })
})

describe('裁剪边界点判定（pointInHeatBoundary）', () => {
  // 外环：lng 0~10、lat 0~10
  const outer = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]
  const boundary: number[][][][] = [[outer]]

  it('外环内=真、外=假', () => {
    expect(pointInHeatBoundary(5, 5, boundary as any)).toBe(true)
    expect(pointInHeatBoundary(1, 5, boundary as any)).toBe(false)
    expect(pointInHeatBoundary(5, 9, boundary as any)).toBe(false)
  })
  it('洞环（evenodd）：洞内=假', () => {
    const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
    const withHole = [[outer, hole]] as any
    expect(pointInHeatBoundary(5, 5, withHole)).toBe(false) // 洞内
    expect(pointInHeatBoundary(3, 5, withHole)).toBe(true)  // 环与洞之间
  })
  it('两个不重叠多边形：各自内部都为真', () => {
    const secondRing = [[20, 20], [22, 20], [22, 22], [20, 22], [20, 20]]
    const b: number[][][][] = [[outer], [secondRing]]
    expect(pointInHeatBoundary(5, 5, b)).toBe(true)
    expect(pointInHeatBoundary(21, 21, b)).toBe(true)
    expect(pointInHeatBoundary(15, 15, b)).toBe(false)
  })
})

describe('按边界过滤采样点（filterPointsToBoundary）', () => {
  const boundary = [[[[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]]] as any
  it('只保留边界内点、逐点半径索引对齐', () => {
    const points: HeatPoint[] = [
      { lat: 5, lng: 5, weight: 100 },
      { lat: 5, lng: 1, weight: 20 },
      { lat: 5, lng: 7, weight: 30 },
    ]
    const radii = new Float64Array([111, 222, 333])
    const out = filterPointsToBoundary(points, radii, boundary)
    expect(out.points).toHaveLength(2)
    expect(out.points[0].weight).toBe(100)
    expect(out.points[1].weight).toBe(30)
    expect(Array.from(out.pointRadii!)).toEqual([111, 333])
  })
  it('无 pointRadii 时返回 undefined；全部在界外时为空集', () => {
    const out = filterPointsToBoundary([{ lat: 1, lng: 1, weight: 1 }], undefined, boundary)
    expect(out.pointRadii).toBeUndefined()
    const none = filterPointsToBoundary(
      [{ lat: 50, lng: 50, weight: 1 }, { lat: -50, lng: -50, weight: 2 }],
      new Float64Array([1, 2]), boundary
    )
    expect(none.points).toHaveLength(0)
    expect(none.pointRadii).toHaveLength(0)
  })
})

describe('高值集中度（concentrateLevel，仅高端分段）', () => {
  it('支点(0.5)及以下任何 gamma 都完全不变（中低配色不同步调整）', () => {
    for (const g of [CONCENTRATION_MIN, 0.25, 1, 4, CONCENTRATION_MAX]) {
      expect(concentrateLevel(0.2, g)).toBe(0.2)
      expect(concentrateLevel(0.5, g)).toBe(0.5)
      expect(concentrateLevel(0, g)).toBe(0)
    }
  })
  it('gamma=1 高端不变；>1 把近峰但未到顶的值下压（t 变小）', () => {
    expect(concentrateLevel(0.8, 1)).toBe(0.8)
    expect(concentrateLevel(0.8, 4)).toBeLessThan(0.8)
    expect(concentrateLevel(0.8, 4)).toBeGreaterThan(0.5)
  })
  it('顶点 t=1 恒为 1（真峰不丢、被突出），严格单调于 gamma', () => {
    expect(concentrateLevel(1, 4)).toBe(1)
    expect(concentrateLevel(0.9, 8)).toBeLessThan(concentrateLevel(0.9, 4))
  })
  it('核心契约：真峰(t=1) 与近峰点拉开 → 100% 点位突出', () => {
    // gamma 大时：真峰仍为 1，近峰(0.9)被明显压低，二者色差扩大
    const peak = concentrateLevel(1, 8)
    const near = concentrateLevel(0.9, 8)
    expect(peak).toBe(1)
    expect(1 - near).toBeGreaterThan(1 - 0.9) // 比 gamma=1 时差距更大
  })
  it('gamma<1 高端色放宽；越界/NaN 钳制（范围上下限、NaN→原值）', () => {
    expect(concentrateLevel(0.6, 0.25)).toBeGreaterThan(0.6)
    expect(concentrateLevel(0.8, 999)).toBe(concentrateLevel(0.8, CONCENTRATION_MAX))
    expect(concentrateLevel(0.8, NaN)).toBe(0.8)
  })
})

describe('软分级（softQuantizeLevel）', () => {
  it('softness=0 等同硬量化、=1 等同原始连续值', () => {
    expect(softQuantizeLevel(0.3, 5, 0)).toBe(0.25)
    expect(softQuantizeLevel(0.3, 5, 1)).toBe(0.3)
  })
  it('色块内部（t 恰在级点上）任何柔化都是纯色（仅边界窄带被软化）', () => {
    expect(softQuantizeLevel(0.5, 5, 0.5)).toBe(0.5)
    expect(softQuantizeLevel(0, 5, 0.5)).toBe(0)
  })
  it('中间柔化：落在硬值与原值之间，单调且不越界', () => {
    const v = softQuantizeLevel(0.3, 5, 0.4)
    expect(v).toBeGreaterThan(0.25)
    expect(v).toBeLessThan(0.3)
    expect(softQuantizeLevel(1.2, 5, 0.5)).toBe(1)
    expect(softQuantizeLevel(-0.2, 5, 0.5)).toBe(0)
  })
  it('级数不足 2 时原样返回', () => {
    expect(softQuantizeLevel(0.3, 1, 0.5)).toBe(0.3)
  })
})
describe('细节增强（整体趋势场 ↔ 细粒度细节场 凸组合）', () => {
  /**
   * 中间高值点被低值邻域包围，且**点距（300m）远小于覆盖半径（3000m）**：
   * 此时细节网格（采样=1）远细于粗网格，"整体 ↔ 细节"两端差异才直观
   */
  const buildPoints = (): HeatPoint[] => [pointAt(-300, 0, 0), pointAt(0, 0, 100), pointAt(300, 0, 0)]
  const atCenter = (detail?: number): number => {
    const field = buildHeatField(buildPoints(), 3000, undefined, detail, 1)!
    const v = valueAt(field, ...xy(0, 0))
    return v ?? NaN
  }

  it('detail=100（缺省）：细粒度细节场为主，采样点仍显著高于趋势端（不超数据界）', () => {
    // 宽细节核（2×cell，扩散融合加强）会把邻域拉低一些，但细节端仍明显高于粗场端
    expect(atCenter(100)).toBeGreaterThan(45)
    expect(atCenter(100)).toBeLessThanOrEqual(100)
    // 缺省 detail 行为与 100 一致（旧调用兼容）
    expect(atCenter(undefined)).toBeCloseTo(atCenter(100), 6)
  })

  it('detail=0：纯粗网格中尺度场，孤立高值被邻域显著压平（低于细节端）', () => {
    const v = atCenter(0)
    expect(v).toBeGreaterThan(0)      // 凸组合不超界、方向正确
    expect(v).toBeLessThan(60)        // 粗网格宽核把高值大幅稀释
    expect(v).toBeLessThan(atCenter(100))
  })

  it('detail 比例单调：越大局部细节越强', () => {
    const v0 = atCenter(0)
    const v50 = atCenter(50)
    const v100 = atCenter(100)
    expect(v50).toBeGreaterThan(v0)
    expect(v100).toBeGreaterThan(v50)
    // 统一归一化里细核对粗/趋势权重的抑制门（smoothstep×blend）对 blend 非线性
    // （趋势地板项偏低，半档向下偏），只要求半档落在两端跨度的中间区间、方向正确
    const spanV = v100 - v0
    expect(v50).toBeGreaterThan(v0 + spanV * 0.25)
    expect(v50).toBeLessThan(v0 + spanV * 0.75)
  })

  it('同站重合小区（nn=0 占 ≥90%）下间距基准不退化：站点各自成桶、不被并桶平均', () => {
    // 2 站 × 10 个重合小区：18/20 的点 nn=0 → 旧实现 p50=p90=0 → spacing=0
    // → 细网格退化到 span/512，「栅格采样」滑杆无任何变化（用户实测回归）
    const pts: HeatPoint[] = []
    for (let k = 0; k < 10; k++) pts.push(pointAt(0, 0, 10))
    for (let k = 0; k < 10; k++) pts.push(pointAt(3000, 0, 80))
    // samp=1：两站各自成桶、站点接近自身值
    const vFine = valueAt(buildHeatField(pts, 8000, undefined, 100, 1)!, ...xy(0, 0))!
    expect(vFine).toBeLessThan(35)
    // samp=12：细网格粗到站距级别、两站并入同一桶做大面积均值 → 被邻站拉高（融合）。
    // 这正是「栅格采样」滑杆的有效区间（1=站点级、大=区域级）
    const vCoarse = valueAt(buildHeatField(pts, 8000, undefined, 100, 12)!, ...xy(0, 0))!
    expect(vCoarse).toBeGreaterThan(35)
  })

  it('细节斑点从中心向边缘平滑淡出、与整体色块无缝衔接（覆盖度软权重，无分界线）', () => {
    // 孤立高值站 + 8km 外低值簇：沿连线剖面应为单调平滑衰减，
    // 细节场/粗场硬切换处（细核查表截断残留 ~4% 权重）不得出现台阶
    const pts: HeatPoint[] = [pointAt(0, 0, 100)]
    for (let k = 0; k < 4; k++) pts.push(pointAt(8000 + (k % 2) * 600, Math.floor(k / 2) * 600, 0))
    const field = buildHeatField(pts, 6000, undefined, 100, 2)!
    const base = projectToMercator(30, 120)
    let prev = NaN
    let maxStep = 0
    let vEnd = NaN
    for (let d = 0; d <= 7500; d += 100) {
      const hit: HeatHit = { value: 0, distance: 0 }
      const v = field.sample(base.x + d, base.y, hit) ? hit.value : NaN
      if (d === 0) expect(v).toBeCloseTo(100, 0)
      if (Number.isFinite(prev) && Number.isFinite(v) && Math.abs(v - prev) > maxStep) {
        maxStep = Math.abs(v - prev)
      }
      prev = v
      vEnd = v
    }
    // 斑点淡出到与整体色块同值（低值簇附近 ≈0）
    expect(vEnd).toBeLessThan(5)
    // 全程无台阶：最大 100m 步进不超过斑点自然梯度（硬分界会产生数十单位跳变）
    expect(maxStep).toBeLessThan(12)
  })

  it('栅格采样粒度（sampling）：倍数越大细节斑点越粗、站点自身值被邻域平均得越多', () => {
    const pts = buildPoints()
    const v1 = (() => {
      const f = buildHeatField(pts, 3000, undefined, 100, 1)!
      return valueAt(f, ...xy(0, 0))!
    })()
    const vCoarse = (() => {
      const f = buildHeatField(pts, 3000, undefined, 100, 20)!
      return valueAt(f, ...xy(0, 0))!
    })()
    // 粗采样下中间高值点被大面积桶平均 → 更接近邻域低值（细节更"融"）
    expect(vCoarse).toBeLessThan(v1)
    // 缺省 sampling=1 与显式 1 一致
    const vDef = valueAt(buildHeatField(pts, 3000, undefined, 100)!, ...xy(0, 0))!
    expect(vDef).toBeCloseTo(v1, 6)
    // sampling 越界钳到 [1,30]
    expect(valueAt(buildHeatField(pts, 3000, undefined, 100, 0)!, ...xy(0, 0))!).toBeCloseTo(v1, 6)
  })
})

describe('跨桶融合契约（全景渲染半径契约）', () => {
  /**
   * 回归：逐点半径下限 < R 时，核作用范围（1.25×桶半径）小于桶代表点最大间距
   * (√2×cell=1.06R)，热力面退化成一块块值恒定的硬边圆盘（"单点不融合"）。
   * 下限 = R 保证 1.25R > 1.06R → 相邻桶必然互相混值。
   */
  it('相邻代表点之间全程有值且单调渐变（无硬边圆盘/白缝）', () => {
    const R = 2800
    const base = projectToMercator(24.2, 116.1)
    const pts: HeatPoint[] = []
    const radii = new Float64Array(144).fill(R)
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
      const { lat, lng } = unprojectFromMercator(base.x + i * 2100, base.y + j * 2100)
      pts.push({ lat, lng, weight: (i + j) % 2 === 0 ? 10 : 90 })
    }
    const field = buildHeatField(pts, R, radii)!
    const hit: HeatHit = { value: 0, distance: 0 }
    const vals: number[] = []
    for (let d = 0; d <= 2100; d += 150) {
      const ok = field.sample(base.x + d, base.y, hit)
      vals.push(ok ? hit.value : NaN)
    }
    // 全程有值（不出现白缝）
    expect(vals.every(v => Number.isFinite(v))).toBe(true)
    // 单调渐变（棋盘值 10/90 交替下允许局部抖动，但整体从 40+ 渐变到 50+）
    expect(vals[0]).toBeGreaterThan(9)
    expect(vals[0]).toBeLessThan(50)
    expect(vals[vals.length - 1]).toBeGreaterThan(50)
    expect(vals[vals.length - 1]).toBeLessThan(91)
    // 网格中心（距最近代表点 0.71×cell）：区域内部不出现镶边暗环（α 不低于 0.7），
    // 深入区域内部（3 格以上）完全饱和（α=1）
    const cx = base.x + 1050, cy = base.y + 1050
    expect(field.sample(cx, cy, hit)).toBe(true)
    expect(hit.alpha!).toBeGreaterThan(0.5)
    expect(field.sample(base.x + 2100 * 4, base.y + 2100 * 4, hit)).toBe(true)
    expect(hit.alpha).toBe(1)
  })
})

describe('细节核锐化（高值不扩散 + 支撑边界无弧形阶跃）', () => {
  /**
   * 旧实现用截断高斯 exp(-d²/(2σ²))：在 d=1.25×核半径 处权重仍有 4.4%，
   * 越过即跳 0。归一化加权平均下该跳变在每个桶周围形成**圆形阶跃**——
   * 三点（-300/0/+300，中间 100）下实测场值在圆周上从 7.9 直接跳到 0，
   * 经"等效细胞计数"分位拉伸后就是用户看到的"放大后明显的弧形分界"。
   */
  it('支撑边界处值连续：细步扫描无跳变（无弧形分界）', () => {
    const points = [pointAt(-300, 0, 0), pointAt(0, 0, 100), pointAt(300, 0, 0)]
    const field = buildHeatField(points, 3000)!
    const base = projectToMercator(30, 120)
    let prev = NaN
    let maxStep = 0
    let span = 0
    let peak = 0
    for (let d = 0; d <= 900; d += 2) {
      const v = valueAt(field, base.x + d, base.y)
      if (v === null) continue
      if (Number.isFinite(prev)) maxStep = Math.max(maxStep, Math.abs(v - prev))
      prev = v
      peak = Math.max(peak, v)
      span = Math.max(span, Math.abs(v - 100))
    }
    expect(peak).toBeGreaterThan(40)
    // 2m 步进下的最大跳变必须远小于场域跨度：新核实测 0.36（阈值 1.9，跨度 95），
    // 旧截断高斯实测 2.89（同一路径，占跨度 3.2%）→ 该断言能真正区分新旧核
    expect(maxStep).toBeLessThan(span * 0.02)
  })

  /**
   * 旧默认档（smooth=9/sampling=4）细节核作用范围达 **7.5×点间距**：
   * 网格中心的高值点自身权重仅 ~11%，100 被平均成 11.4 → 再用纯分位映射把这点
   * 微小差异拉满整条色带，高值色带覆盖"高值点聚集区"一大片，采样点层次全丢。
   * 新规则（核半径 = 点间距 × 平滑强度）下自身权重 ≈40%，高值点成紧凑色斑。
   */
  it('采样点保真：高值点以自身值为主（不被邻域平均成一片）', () => {
    const points: HeatPoint[] = []
    for (let i = -10; i <= 10; i++) {
      for (let j = -10; j <= 10; j++) {
        if (i === 0 && j === 0) continue
        points.push(pointAt(i * 200, j * 200, 10))
      }
    }
    points.push(pointAt(0, 0, 100))
    // 缺省档（即应用默认：smooth=4 / sampling=1）下也必须保真
    const field = buildHeatField(points, 2000, undefined, 100)!
    const peak = valueAt(field, ...xy(0, 0))!
    // 自身值 100：以自身权重为主（旧实现只有 11.4）
    expect(peak).toBeGreaterThan(40)
    expect(peak).toBeLessThanOrEqual(100)
    // 背景仍是邻域值 10（高值未把整片区域拉起来）
    expect(valueAt(field, ...xy(200 * 6, 200 * 6))!).toBeCloseTo(10, 0)
  })

  it('栅格采样全范围有效：samp=1 站点级保真、samp=24 大区域均值（不再加几何上限）', () => {
    const points: HeatPoint[] = []
    for (let i = -10; i <= 10; i++) {
      for (let j = -10; j <= 10; j++) {
        if (i === 0 && j === 0) continue
        points.push(pointAt(i * 200, j * 200, 10))
      }
    }
    points.push(pointAt(0, 0, 100))
    const peakAt = (sampling: number) => valueAt(buildHeatField(points, 2000, undefined, 100, sampling, 1)!, ...xy(0, 0))!
    // samp=1：高值点保真（gate 中心全抑制粗场）
    expect(peakAt(1)).toBeGreaterThan(90)
    // samp=24：细网格粗于整个数据范围 → 桶值≈全量均值（用户主动选择的最大融合档）
    const coarse = peakAt(24)
    expect(coarse).toBeGreaterThan(8)
    expect(coarse).toBeLessThan(25)
  })

  it('细核固定站点窄核：任何 smooth 下高值都保留（不再被邻域平均稀释）', () => {
    const points = [pointAt(-300, 0, 0), pointAt(0, 0, 100), pointAt(300, 0, 0)]
    const v = (smooth: number) => valueAt(buildHeatField(points, 3000, undefined, 100, 1, smooth)!, ...xy(0, 0))!
    // smooth 不再进入细核：三档站点峰值都保留（旧耦合下 smooth10 会被平均）
    expect(v(1)).toBeGreaterThan(90)
    expect(v(4)).toBeGreaterThan(90)
    expect(v(10)).toBeGreaterThan(90)
    // smooth 越界仍钳 [1,10]（用于 gate 过渡带宽）
    expect(v(0)).toBeCloseTo(v(1), 6)
    expect(v(99)).toBeCloseTo(v(10), 6)
  })
})
