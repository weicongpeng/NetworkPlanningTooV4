/**
 * 热力图工具测试：点校验、有符号权重（负值）、数据极值、抽样、质心、CSS 色带、颜色方向、分级图例
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeHeatPoints,
  centroidFromLngLatRing,
  centroidFromLatLngRing,
  gradientToCss,
  resolveHeatGradient,
  buildAnchoredMapper,
  buildHeatLegend,
  formatLegendValue,
  quantileValueAt,
  quantileRefValue,
  buildQuantileRef,
  normalizeLegendOverrides,
  resolveLevelGradient,
  HEATMAP_GRADIENTS,
  type HeatPoint,
} from '../heatmap'

describe('normalizeHeatPoints', () => {
  it('空数组返回空结果', () => {
    const r = normalizeHeatPoints([])
    expect(r.points).toHaveLength(0)
    expect(r.count).toBe(0)
    expect(r.sampled).toBe(false)
  })

  it('跳过坐标或权重非有限值的点', () => {
    const points: HeatPoint[] = [
      { lat: 30, lng: 120, weight: 5 },
      { lat: NaN, lng: 120, weight: 5 },
      { lat: 30, lng: Infinity, weight: 5 },
      { lat: 30, lng: 120, weight: NaN },
      { lat: 31, lng: 121, weight: 10 },
    ]
    const r = normalizeHeatPoints(points)
    expect(r.count).toBe(2)
    expect(r.points).toHaveLength(2)
  })

  it('负权重原样保留（RSRP 等全负字段）', () => {
    const r = normalizeHeatPoints([
      { lat: 30, lng: 120, weight: -110 },
      { lat: 31, lng: 121, weight: -70 },
    ])
    expect(r.points[0].weight).toBe(-110)
    expect(r.min).toBe(-110)
    expect(r.max).toBe(-70)
  })

  it('全负数据值域取真实极值（最大负值为上限）', () => {
    const r = normalizeHeatPoints([
      { lat: 30, lng: 120, weight: -105 },
      { lat: 31, lng: 121, weight: -90 },
      { lat: 32, lng: 122, weight: -75 },
    ])
    expect(r.min).toBe(-105)
    expect(r.max).toBe(-75)
  })

  it('值域：取权重最小/最大值（不再有手动上下限）', () => {
    const r = normalizeHeatPoints([
      { lat: 30, lng: 120, weight: 0 },
      { lat: 31, lng: 121, weight: 5 },
      { lat: 32, lng: 122, weight: 10 },
    ])
    expect(r.max).toBe(10)
    expect(r.min).toBe(0)
    expect(r.points.map(p => p.weight)).toEqual([0, 5, 10])
  })

  it('所有权重为 0 时不产生 Infinity', () => {
    const r = normalizeHeatPoints([
      { lat: 30, lng: 120, weight: 0 },
      { lat: 31, lng: 121, weight: 0 },
    ])
    expect(r.points.every(p => p.weight === 0)).toBe(true)
  })

  it('超过上限时确定性等距抽样', () => {
    const points: HeatPoint[] = Array.from({ length: 100 }, (_, i) => ({
      lat: 30 + i * 0.001,
      lng: 120 + i * 0.001,
      weight: i + 1,
    }))
    const r1 = normalizeHeatPoints(points, 10)
    const r2 = normalizeHeatPoints(points, 10)
    expect(r1.sampled).toBe(true)
    expect(r1.points).toHaveLength(10)
    expect(r1.count).toBe(100)
    // 确定性：同样输入输出一致
    expect(r1.points).toEqual(r2.points)
    // 跨步抽样保留全范围：首个为最小值、末个接近最大值（而非截断头部）
    expect(r1.points[0].weight).toBe(1)
    expect(r1.points[9].weight).toBe(91)
  })

  it('保留原始权重与坐标（渲染按原始值插值）', () => {
    const r = normalizeHeatPoints([{ lat: 30.5, lng: 120.25, weight: 8 }])
    expect(r.points[0]).toEqual({ lat: 30.5, lng: 120.25, weight: 8 })
  })
})

describe('formatLegendValue（取整精度）', () => {
  it('按 round 决定小数位', () => {
    expect(formatLegendValue(8.5714, 0.1)).toBe('8.6')
    expect(formatLegendValue(8.5714, 0.01)).toBe('8.57')
    expect(formatLegendValue(8.5714, 1)).toBe('9')
    expect(formatLegendValue(157.2, 10)).toBe('160')
  })

  it('非法 round 回退 0.1', () => {
    expect(formatLegendValue(1.234, 0)).toBe('1.2')
    expect(formatLegendValue(1.234, NaN)).toBe('1.2')
  })

  it('负值正确取整', () => {
    expect(formatLegendValue(-103.456, 0.1)).toBe('-103.5')
  })
})

describe('buildHeatLegend（分级图例）', () => {
  const points: HeatPoint[] = Array.from({ length: 100 }, (_, i) => ({
    lat: 30,
    lng: 120 + i * 0.001,
    weight: i + 1,
  }))

  it('等效细胞计数：色带等分、标签为占比、值为分位值', () => {
    const levels = buildHeatLegend(points, 1, 100, 'cellCount', 7, 0.1)
    expect(levels).toHaveLength(7)
    expect(levels[0].t).toBe(0)
    expect(levels[6].t).toBe(1)
    expect(levels.map(l => l.label)).toEqual(['0%', '17%', '33%', '50%', '67%', '83%', '100%'])
    // 均匀分布数据下，分位值应与值域等分接近
    expect(levels[0].value).toBe(1)
    expect(levels[6].value).toBe(100)
    expect(levels[3].value).toBeGreaterThan(45)
    expect(levels[3].value).toBeLessThan(56)
  })

  it('等效细胞计数适配重尾数据：各级承载等量采样点', () => {
    // 99 个低值 + 1 个极大值（模拟流量类重尾分布）
    const heavy: HeatPoint[] = [
      ...Array.from({ length: 99 }, (_, i) => ({ lat: 30, lng: 120 + i * 0.001, weight: 1 })),
      { lat: 30, lng: 121, weight: 1000 },
    ]
    const levels = buildHeatLegend(heavy, 1, 1000, 'cellCount', 3, 0.1)
    // 低值占 99%，故低端两级都取到低值，只有最高级触及极端值
    expect(levels[0].value).toBe(1)
    expect(levels[1].value).toBe(1)
    expect(levels[2].value).toBe(1000)
  })

  it('等效范围：值域等分且按取整精度显示', () => {
    const levels = buildHeatLegend(points, 0, 51.4, 'valueRange', 7, 0.1)
    expect(levels).toHaveLength(7)
    expect(levels.map(l => l.label)).toEqual(['0.0', '8.6', '17.1', '25.7', '34.3', '42.8', '51.4'])
    // t 与值同步等分
    expect(levels[3].t).toBeCloseTo(0.5, 6)
    expect(levels[3].value).toBeCloseTo(25.7, 6)
  })

  it('等效范围对全负值域同样等分', () => {
    const levels = buildHeatLegend(points, -110, -70, 'valueRange', 5, 1)
    expect(levels.map(l => l.label)).toEqual(['-110', '-100', '-90', '-80', '-70'])
  })

  it('分级数被约束在合理范围', () => {
    expect(buildHeatLegend(points, 0, 1, 'valueRange', 1, 0.1)).toHaveLength(2)
    expect(buildHeatLegend(points, 0, 1, 'valueRange', 999, 0.1)).toHaveLength(64)
  })

  it('空点集不抛错（等效细胞计数退化为常量值）', () => {
    const levels = buildHeatLegend([], 0, 0, 'cellCount', 5, 0.1)
    expect(levels).toHaveLength(5)
    expect(levels.every(l => l.value === 0)).toBe(true)
  })

  it('counts 加权还原真实分布（弹窗预览与地图同源的关键）', () => {
    // 弹窗样本按值去重，只有 3 条；真实数据里值 1 出现 100 次
    const points: HeatPoint[] = [
      { lat: 30, lng: 120, weight: 1 },
      { lat: 30, lng: 120.1, weight: 2 },
      { lat: 30, lng: 120.2, weight: 1000 },
    ]
    const counts = [100, 1, 1]
    const weighted = buildHeatLegend(points, 1, 1000, 'cellCount', 5, 0.1, { counts })
    const unweighted = buildHeatLegend(points, 1, 1000, 'cellCount', 5, 0.1)
    // 加权：98% 的点是值 1，故中位级也应是 1
    expect(weighted[2].value).toBe(1)
    // 不加权（去重样本当真分布）会得出相反结论——这正是必须加权的理由
    expect(unweighted[2].value).toBe(2)
  })

  it('负半值按符号取整（RSRP 等全负字段）', () => {
    expect(formatLegendValue(-0.05, 0.1)).toBe('-0.1')
    expect(formatLegendValue(0.05, 0.1)).toBe('0.1')
    expect(formatLegendValue(0, 0.1)).toBe('0.0')
    expect(formatLegendValue(-103.44, 0.1)).toBe('-103.4')
    expect(formatLegendValue(-103.45, 0.1)).toBe('-103.5')
  })
})

describe('buildAnchoredMapper（手工分级的锚点映射）', () => {
  it('锚点之间线性插值，两端钳制', () => {
    const map = buildAnchoredMapper([
      { value: 0, t: 0 },
      { value: 50, t: 0.5 },
      { value: 100, t: 1 },
    ])
    expect(map(-10)).toBe(0)
    expect(map(0)).toBe(0)
    expect(map(25)).toBeCloseTo(0.25, 6)
    expect(map(50)).toBeCloseTo(0.5, 6)
    expect(map(100)).toBe(1)
    expect(map(999)).toBe(1)
  })

  it('锚点可非等距（用户拉大某一段占比）', () => {
    // 用户把 20 这个值抬到色带 80% 处
    const map = buildAnchoredMapper([
      { value: 0, t: 0 },
      { value: 20, t: 0.8 },
      { value: 100, t: 1 },
    ])
    expect(map(20)).toBeCloseTo(0.8, 6)
    expect(map(10)).toBeCloseTo(0.4, 6)
    // 20→100 段被压缩
    expect(map(60)).toBeCloseTo(0.9, 6)
  })

  it('重复值锚点被合并且不留硬色阶（重尾数据回归）', () => {
    // 7 级里有 4 级取到同一分位值 → 若不合并，该值前后会硬跳变
    const map = buildAnchoredMapper([
      { value: 0, t: 0 },
      { value: 7, t: 1 / 6 },
      { value: 7, t: 2 / 6 },
      { value: 7, t: 3 / 6 },
      { value: 7, t: 4 / 6 },
      { value: 100, t: 1 },
    ])
    // 该值处取四个重复锚点的 t 均值
    const avgT = (1 / 6 + 2 / 6 + 3 / 6 + 4 / 6) / 4
    expect(map(7)).toBeCloseTo(avgT, 6)
    // 值上下微小变化不出现跳变
    expect(Math.abs(map(7.001) - map(6.999))).toBeLessThan(0.01)
    expect(map(0)).toBe(0)
    expect(map(100)).toBe(1)
  })

  it('锚点越界 t 被钳制（与单锚点分支行为一致）', () => {
    const map = buildAnchoredMapper([
      { value: 0, t: -1 },
      { value: 10, t: 5 },
    ])
    expect(map(0)).toBe(0)
    expect(map(10)).toBe(1)
  })

  it('对比度叠加生效', () => {
    const map = buildAnchoredMapper([{ value: 0, t: 0 }, { value: 100, t: 1 }], 2)
    expect(map(75)).toBe(1)      // 0.75 → 0.5+0.25*2 = 1
    expect(map(25)).toBe(0)      // 0.25 → 0.5-0.25*2 = 0
    expect(map(50)).toBeCloseTo(0.5, 6)
  })

  it('空锚点退化为常量中点', () => {
    const map = buildAnchoredMapper([])
    expect(map(42)).toBe(0.5)
  })
})

describe('quantileValueAt（占比反算代表值）', () => {
  it('按占位取分位值', () => {
    const points: HeatPoint[] = Array.from({ length: 100 }, (_, i) => ({
      lat: 30, lng: 120 + i * 0.001, weight: i + 1,
    }))
    expect(quantileValueAt(points, 0)).toBe(1)
    expect(quantileValueAt(points, 1)).toBe(100)
    const mid = quantileValueAt(points, 0.5)
    expect(mid).toBeGreaterThan(45)
    expect(mid).toBeLessThan(56)
  })

  it('带权重的分位与全量点一致', () => {
    const points: HeatPoint[] = [
      { lat: 30, lng: 120, weight: 1 },
      { lat: 30, lng: 121, weight: 1000 },
    ]
    // 99% 的点是值 1 → 50% 分位仍是 1
    expect(quantileValueAt(points, 0.5, [99, 1])).toBe(1)
    expect(quantileValueAt(points, 1, [99, 1])).toBe(1000)
  })

  it('空点集返回 fallback', () => {
    expect(quantileValueAt([], 0.5, undefined, -7)).toBe(-7)
  })
})

describe('buildHeatLegend 手工分级（overrides）', () => {
  const points: HeatPoint[] = Array.from({ length: 100 }, (_, i) => ({
    lat: 30, lng: 120 + i * 0.001, weight: i + 1,
  }))

  it('用户给定的 t/value/color 直接生效', () => {
    const overrides = [
      { t: 0, value: 0 },
      { t: 0.9, value: 30, color: '#ff0000' },
      { t: 1, value: 100 },
    ]
    const levels = buildHeatLegend(points, 0, 100, 'cellCount', 7, 0.1, { overrides })
    expect(levels).toHaveLength(3)
    expect(levels[1].t).toBe(0.9)
    expect(levels[1].value).toBe(30)
    expect(levels[1].color).toBe('#ff0000')
    expect(levels[1].label).toBe('90%')
  })

  it('区间模式下标签为取整值而非占比', () => {
    const overrides = [{ t: 0, value: 0 }, { t: 1, value: 51.43 }]
    const levels = buildHeatLegend(points, 0, 100, 'valueRange', 2, 0.1, { overrides })
    expect(levels.map(l => l.label)).toEqual(['0.0', '51.4'])
  })

  it('t 被钳到 [0,1]，非法 value 回退 min', () => {
    const overrides = [{ t: -1, value: NaN }, { t: 5, value: 10 }]
    const levels = buildHeatLegend(points, 3, 100, 'cellCount', 2, 0.1, { overrides })
    expect(levels[0].t).toBe(0)
    expect(levels[0].value).toBe(3)
    expect(levels[1].t).toBe(1)
  })
})

describe('normalizeLegendOverrides（编辑态分级对齐渲染基准）', () => {
  const reference = buildQuantileRef([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  const overrides = [
    { t: 0, value: 999 },
    { t: 0.5, value: 999, color: '#ff0000' },
    { t: 1, value: 999 },
  ]

  it('等效细胞计数：各级取值由基准分布在 t 处反算（丢弃编辑态存档值）', () => {
    const out = normalizeLegendOverrides(overrides, 'cellCount', reference)!
    expect(out.map(l => l.value)).toEqual([
      quantileRefValue(reference, 0),
      quantileRefValue(reference, 0.5),
      quantileRefValue(reference, 1),
    ])
    // 自定义色原样保留
    expect(out[1].color).toBe('#ff0000')
  })

  it('回归：只改颜色不改配色（改色后锚点仍与自动分级重合，不会整图重新配色）', () => {
    const points: HeatPoint[] = Array.from({ length: 50 }, (_, i) => ({ lat: 30, lng: 120 + i * 0.001, weight: i }))
    const auto = buildHeatLegend(points, 0, 49, 'cellCount', 3, 0.1, { distribution: reference })
    // 用户在自动分级基础上只给中间一级换了颜色，其余字段原样存回
    const edited = normalizeLegendOverrides(auto.map(l => ({ t: l.t, value: l.value, color: l.t === 0.5 ? '#ff0000' : undefined })), 'cellCount', reference)!
    const after = buildHeatLegend(points, 0, 49, 'cellCount', 3, 0.1, { overrides: edited, distribution: reference })
    expect(after.map(l => l.value)).toEqual(auto.map(l => l.value))
    expect(after.map(l => l.colorT)).toEqual(auto.map(l => l.colorT))
  })

  it('等效范围：编辑的就是数值本身，原样使用', () => {
    expect(normalizeLegendOverrides(overrides, 'valueRange', reference)).toBe(overrides)
  })

  it('无基准分布（地图尚未渲染该字段）/ 分级不足 2 级时按原样或忽略', () => {
    expect(normalizeLegendOverrides(overrides, 'cellCount', null)).toBe(overrides)
    expect(normalizeLegendOverrides(overrides, 'cellCount', new Float64Array(0))).toBe(overrides)
    expect(normalizeLegendOverrides([{ t: 0, value: 1 }], 'cellCount', reference)).toBeNull()
    expect(normalizeLegendOverrides(null, 'cellCount', reference)).toBeNull()
  })
})

describe('resolveLevelGradient（自定义色带）', () => {
  it('无自定义色时原样返回', () => {
    const base = HEATMAP_GRADIENTS.default
    expect(resolveLevelGradient(base, [{ t: 0 }, { t: 1 }])).toBe(base)
  })

  it('有自定义色时以分级为锚点重建色带', () => {
    // 注：未自定义的级要经 gradientColorAt 从配色方案取色（依赖 canvas，
    // jsdom 未实现），故此处各级都给定颜色，只验证锚点重建本身
    const stops = resolveLevelGradient(HEATMAP_GRADIENTS.default, [
      { t: 0, color: '#123456' },
      { t: 0.5, color: '#00ff00' },
      { t: 1, color: '#abcdef' },
    ])
    expect(Object.keys(stops).map(Number).sort((a, b) => a - b)).toEqual([0, 0.5, 1])
    expect(stops[0]).toBe('#123456')
    expect(stops[1]).toBe('#abcdef')
  })

  it('t 越界被钳到 [0,1]，不足两级时回退原色带', () => {
    const stops = resolveLevelGradient(HEATMAP_GRADIENTS.default, [
      { t: -1, color: '#111111' },
      { t: 9, color: '#222222' },
    ])
    expect(stops[0]).toBe('#111111')
    expect(stops[1]).toBe('#222222')
    // 只有一级时无法构成渐变色带，原样返回
    const single = resolveLevelGradient(HEATMAP_GRADIENTS.default, [{ t: 0.3, color: '#333333' }])
    expect(single).toBe(HEATMAP_GRADIENTS.default)
  })

  it('direction=reverse：自定义色注册到镜像位（方向设置对自定义色也生效）', () => {
    const stops = resolveLevelGradient(HEATMAP_GRADIENTS.default, [
      { t: 0, colorT: 0, color: '#111111' },
      { t: 1, colorT: 1, color: '#ff0000' },
    ], 'reverse')
    // colorT=1 的自定义红注册到镜像位 0；colorT=0 的自定义色注册到镜像位 1
    expect(stops[0]).toBe('#ff0000')
    expect(stops[1]).toBe('#111111')
    // 正常方向保持原位
    const normal = resolveLevelGradient(HEATMAP_GRADIENTS.default, [
      { t: 0, colorT: 0, color: '#111111' },
      { t: 1, colorT: 1, color: '#ff0000' },
    ])
    expect(normal[0]).toBe('#111111')
    expect(normal[1]).toBe('#ff0000')
  })

  it('direction=reverse：已量化的 colorT（分级着色）镜像后仍落位正确', () => {
    const stops = resolveLevelGradient(HEATMAP_GRADIENTS.default, [
      { t: 0.25, colorT: 0.25, color: '#00ffff' },
      { t: 0.75, colorT: 0.75, color: '#ffff00' },
    ], 'reverse')
    expect(stops[0.25]).toBe('#ffff00')
    expect(stops[0.75]).toBe('#00ffff')
  })
})

describe('色带 stop 分布（分级取色前提）', () => {
  // 注：gradientColorAt 依赖 canvas（jsdom 未实现），其取色由浏览器环境保证；
  // 此处只固化"色带必须铺满 [0,1]"这一前提——旧版 default 从 0.2 起色，
  // 会让最低几级落到同一颜色
  it('四套色带的 stop 首尾恰为 0 与 1', () => {
    for (const scheme of ['default', 'warm', 'cool', 'viridis'] as const) {
      const keys = Object.keys(HEATMAP_GRADIENTS[scheme]).map(Number).sort((a, b) => a - b)
      expect(keys[0]).toBe(0)
      expect(keys[keys.length - 1]).toBe(1)
    }
  })

  it('默认色带为经典 蓝→青→绿→黄→红', () => {
    const g = HEATMAP_GRADIENTS.default
    expect(g[0]).toBe('blue')
    expect(g[0.5]).toBe('lime')
    expect(g[1]).toBe('red')
  })
})

describe('质心计算', () => {
  it('LngLat 环算术平均', () => {
    const c = centroidFromLngLatRing([[0, 0], [10, 0], [10, 10], [0, 10]])
    expect(c).toEqual({ lat: 5, lng: 5 })
  })

  it('LatLng 环翻转后平均', () => {
    const c = centroidFromLatLngRing([[0, 0], [0, 10], [10, 10], [10, 0]])
    expect(c).toEqual({ lat: 5, lng: 5 })
  })

  it('空环/非法点返回 null', () => {
    expect(centroidFromLngLatRing([])).toBeNull()
    expect(centroidFromLngLatRing([[NaN, 1], [1, NaN]])).toBeNull()
  })
})

describe('gradientToCss', () => {
  it('四套配色均可生成按 stop 排序的 CSS 渐变', () => {
    for (const scheme of ['default', 'warm', 'cool', 'viridis'] as const) {
      const css = gradientToCss(HEATMAP_GRADIENTS[scheme])
      expect(css.startsWith('linear-gradient(to right,')).toBe(true)
      expect(css).toContain('100%')
    }
  })
})

describe('resolveHeatGradient（颜色方向）', () => {
  it('normal（含未设置）返回原色带', () => {
    expect(resolveHeatGradient('default', 'normal')).toBe(HEATMAP_GRADIENTS.default)
    expect(resolveHeatGradient('warm', undefined)).toBe(HEATMAP_GRADIENTS.warm)
  })

  it('reverse 镜像 stop 键，两端颜色互换', () => {
    const g = resolveHeatGradient('default', 'reverse')
    // 原色带 0=blue → 1=red；镜像后 0=red、1=blue（值越大越冷）
    expect(g[0]).toBe('red')
    expect(g[1]).toBe('blue')
    expect(Object.keys(g).map(Number).sort((a, b) => a - b)).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('reverse 后 CSS 渐变左右顺序与正向相反', () => {
    const normal = gradientToCss(resolveHeatGradient('warm', 'normal'))
    const reverse = gradientToCss(resolveHeatGradient('warm', 'reverse'))
    expect(normal).toContain('#ffffb2 0%')
    expect(normal).toContain('#bd0026 100%')
    expect(reverse).toContain('#bd0026 0%')
    expect(reverse).toContain('#ffffb2 100%')
  })
})
