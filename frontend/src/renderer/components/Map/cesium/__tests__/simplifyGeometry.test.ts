/**
 * Douglas-Peucker 抽稀（3D 渲染几何瘦身）行为锁定。
 *
 * 背景：MapInfo / 地理化数据的边界动辄上万个点，而城市级视野下一屏只有几百像素。
 * 3D 侧对超过 SIMPLIFY_MIN_POINTS 的线/环做抽稀（仅影响 3D 贴地渲染几何；
 * 2D、点击命中、标签、热力取点仍用原始坐标）。这里锁住抽稀的正确性：
 * 端点保留、共线点删除、尖角保留、闭合环保持闭合、小图形不动。
 */
import { describe, it, expect } from 'vitest'
import {
  douglasPeucker,
  simplifyRingOrLine,
  SIMPLIFY_MIN_POINTS,
} from '../cesiumGeoJson'

/** 构造一条共线折线（n 个点，步长 step），可在指定下标插入一个尖角 */
function lineWithSpike(n: number, step: number, spikeAt = -1, spikeOffset = 0): number[][] {
  const pts: number[][] = []
  for (let i = 0; i < n; i++) {
    const y = i === spikeAt ? i * step + spikeOffset : i * step
    pts.push([114 + i * step, 23 + y])
  }
  return pts
}

describe('douglasPeucker', () => {
  it('共线点全部删除，只留首尾', () => {
    const pts = lineWithSpike(200, 0.001)
    const out = douglasPeucker(pts, 1e-6)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual(pts[0])
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1])
  })

  it('尖角（偏离超过容差）必须保留', () => {
    const pts = lineWithSpike(200, 0.001, 100, 0.01) // 中间凸起 0.01°
    const out = douglasPeucker(pts, 1e-4)
    expect(out.length).toBeGreaterThan(2)
    expect(out).toContainEqual(pts[100])
  })

  it('容差内的轻微抖动被抹平', () => {
    const pts = lineWithSpike(200, 0.001, 100, 1e-7) // 抖动 1e-7° < 容差
    const out = douglasPeucker(pts, 1e-4)
    expect(out).toHaveLength(2)
  })

  it('少于 3 个点原样返回', () => {
    expect(douglasPeucker([[0, 0], [1, 1]], 1e-4)).toHaveLength(2)
    expect(douglasPeucker([[0, 0]], 1e-4)).toHaveLength(1)
  })

  it('大环（万级点）不爆栈且结果远小于输入', () => {
    const n = 20000
    const ring: number[][] = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      ring.push([114 + 0.01 * Math.cos(a), 23 + 0.01 * Math.sin(a)])
    }
    const out = douglasPeucker(ring, 1e-5)
    expect(out.length).toBeGreaterThan(2)
    expect(out.length).toBeLessThan(n / 5) // 近似圆的环绝大部分点共线可删
  })
})

describe('simplifyRingOrLine', () => {
  it('顶点数 ≤ SIMPLIFY_MIN_POINTS 原样返回（小图形不动）', () => {
    const pts = lineWithSpike(SIMPLIFY_MIN_POINTS, 0.001)
    expect(simplifyRingOrLine(pts, 1e-4, false)).toBe(pts) // 同一引用
  })

  it('未闭合线：抽稀后仍为开放线', () => {
    const pts = lineWithSpike(300, 0.001)
    const out = simplifyRingOrLine(pts, 1e-6, false)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual(pts[0])
  })

  it('闭合环：首尾闭合保持，且不同点数 ≥ 3', () => {
    const n = 400
    const ring: number[][] = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      ring.push([114 + 0.01 * Math.cos(a), 23 + 0.01 * Math.sin(a)])
    }
    ring.push([...ring[0]]) // GeoJSON 闭合环：首尾相同
    const out = simplifyRingOrLine(ring, 1e-5, true)
    expect(out.length).toBeGreaterThanOrEqual(4)
    expect(out[0]).toEqual(out[out.length - 1]) // 仍闭合
    expect(out.length).toBeLessThan(ring.length / 3)
  })

  it('未真正闭合的"环"（首尾不同）按开放线处理，不强行闭合', () => {
    const pts = lineWithSpike(300, 0.001) // 首尾不同
    const out = simplifyRingOrLine(pts, 1e-6, true)
    expect(out[0]).not.toEqual(out[out.length - 1])
    expect(out).toHaveLength(2)
  })

  it('抽稀后点数不足 3 的闭合环放弃抽稀（保底）', () => {
    // 一条直线段 + 大量共线冗余点，但容差极大 → 理论上只剩 2 点，必须回退原图形
    const ring: number[][] = []
    for (let i = 0; i < 100; i++) ring.push([114 + i * 0.001, 23])
    ring.push([...ring[0]])
    const out = simplifyRingOrLine(ring, 1, true) // 容差 1°：全删
    expect(out).toBe(ring) // 回退原引用
  })
})
