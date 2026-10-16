/**
 * 3D 等高线核心算法测试（纯函数部分，不依赖 Cesium）。
 *
 * 覆盖：等高线段提取（marching squares 简化版：线性插值交点、鞍形配对）、
 * 等高距归整、采样网格边长自适应。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  contourSegments,
  contourLevels,
  niceInterval,
  niceIntervalCeil,
  gridSizeFor,
  createContourLayer,
} from '../cesiumContours'

/** 行主序网格：index = row * cols + col，row 0 在北 */
function grid(width: number, heights: number[]): number[] {
  expect(heights.length).toBe(width * width)
  return heights
}

describe('contourSegments', () => {
  it('平地（无高差）不产生线段', () => {
    const h = grid(3, [5, 5, 5, 5, 5, 5, 5, 5, 5])
    expect(contourSegments(h, 3, 3, [5])).toHaveLength(0)
  })

  it('斜坡：等高线是沿行方向的直线（高程只随列变）', () => {
    // 高程沿列 0→10→20、行恒定：level=5 的等值面就是 col=0.5 那条竖线
    const h = grid(3, [0, 10, 20, 0, 10, 20, 0, 10, 20])
    const segs = contourSegments(h, 3, 3, [5])
    expect(segs).toHaveLength(2)
    for (const s of segs) {
      expect(s.x1).toBeCloseTo(0.5)
      expect(s.x2).toBeCloseTo(0.5)
    }
    // 上格交点落在 row 边界（0/1、1/2）
    expect(segs[0].y1).toBeCloseTo(0)
    expect(segs[0].y2).toBeCloseTo(1)
    expect(segs[1].y1).toBeCloseTo(1)
    expect(segs[1].y2).toBeCloseTo(2)
  })

  it('中间隆起：level 穿过形成闭合环（每格一段）', () => {
    // 3×3 中间高、四周低
    const h = grid(3, [0, 0, 0, 0, 10, 0, 0, 0, 0])
    const segs = contourSegments(h, 3, 3, [5])
    expect(segs.length).toBeGreaterThanOrEqual(4)
    // 环上的点都应落在中间格子的四条边附近（0..2 的格点范围内）
    for (const s of segs) {
      expect(Math.min(s.x1, s.x2)).toBeGreaterThanOrEqual(0)
      expect(Math.max(s.x1, s.x2)).toBeLessThanOrEqual(2)
    }
  })

  it('多个 level：不同高程各出一段', () => {
    const h = grid(3, [0, 10, 20, 0, 10, 20, 0, 10, 20])
    expect(contourSegments(h, 3, 3, [5])).toHaveLength(2)
    expect(contourSegments(h, 3, 3, [5, 15])).toHaveLength(4)
  })

  it('level 恰在格点高度上时不算穿越（避免整片重复线）', () => {
    // 全部格点都是 5：level=5 无穿越
    const h = grid(3, [5, 5, 5, 5, 5, 5, 5, 5, 5])
    expect(contourSegments(h, 3, 3, [5])).toHaveLength(0)
  })

  it('含 NaN 的格子被跳过，其余格子照常出线且坐标有限', () => {
    // NaN 放在左上角格点：只影响左上那一个格子（NaN 在中间会波及全部 4 格）
    const h = grid(3, [NaN, 10, 20, 0, 10, 20, 0, 10, 20])
    const segs = contourSegments(h, 3, 3, [5])
    expect(segs).toHaveLength(1)   // 左上格被跳过，仅左下格出线
    for (const s of segs) {
      expect(Number.isFinite(s.x1) && Number.isFinite(s.y1)).toBe(true)
      expect(Number.isFinite(s.x2) && Number.isFinite(s.y2)).toBe(true)
    }
  })

  it('网格或 level 退化时安全返回空', () => {
    expect(contourSegments([1, 2], 1, 2, [1])).toHaveLength(0)
    expect(contourSegments([1, 2, 3, 4], 2, 2, [])).toHaveLength(0)
  })
})

describe('niceInterval', () => {
  it('归整到 1/2/5 × 10ⁿ', () => {
    expect(niceInterval(0.9)).toBe(0.5)
    expect(niceInterval(1.4)).toBe(1)
    expect(niceInterval(3)).toBe(2)
    expect(niceInterval(7)).toBe(5)
    expect(niceInterval(23)).toBe(20)
    expect(niceInterval(140)).toBe(100)
    expect(niceInterval(460)).toBe(200)
  })

  it('非法输入兜底为 1', () => {
    expect(niceInterval(0)).toBe(1)
    expect(niceInterval(-5)).toBe(1)
    expect(niceInterval(NaN)).toBe(1)
  })
})

describe('niceIntervalCeil', () => {
  it('向上取整：返回 ≥ raw 的最小整步长（等高距用它才不会超目标条数）', () => {
    expect(niceIntervalCeil(8)).toBe(10)
    expect(niceIntervalCeil(15)).toBe(20)
    expect(niceIntervalCeil(20)).toBe(20)
    expect(niceIntervalCeil(30)).toBe(50)
    expect(niceIntervalCeil(120)).toBe(200)
    expect(niceIntervalCeil(1)).toBe(1)
  })

  it('始终不小于向下取整的结果，且差不超过一个档位', () => {
    for (const raw of [0.5, 1.2, 3, 7, 8, 25, 99, 140, 460, 1300]) {
      const up = niceIntervalCeil(raw)
      const down = niceInterval(raw)
      expect(up).toBeGreaterThanOrEqual(down)
      expect(up).toBeLessThan(raw * 5 + 1e-6)
    }
  })

  it('非法输入兜底为 1', () => {
    expect(niceIntervalCeil(0)).toBe(1)
    expect(niceIntervalCeil(NaN)).toBe(1)
  })
})

describe('gridSizeFor', () => {
  it('相机越高网格越稀（采样越贵，高空不值得细采样）', () => {
    const heights = [1_000, 5_000, 20_000, 50_000, 200_000, 500_000]
    const sizes = heights.map(gridSizeFor)
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1])
    }
    // 近处用满采样预算，远处明显更稀
    expect(sizes[0]).toBe(80)
    expect(sizes[sizes.length - 1]).toBeLessThan(sizes[0] / 2)
  })

  it('采样点总数受硬上限约束（cols*rows <= 6400），且不低于 16', () => {
    for (const h of [1, 100, 10_000, 120_000, 500_000, 1e9]) {
      const n = gridSizeFor(h)
      expect(n).toBeGreaterThanOrEqual(16)
      expect(n * n).toBeLessThanOrEqual(6400)
    }
  })
})

describe('contourLevels（按高差反推等高距——"开了开关没线"的回归）', () => {
  it('城市/河谷小高差也必须能切出十来条（按跨度算会得到 0 条）', () => {
    // 这些组合在旧算法（等高距按视野跨度算）下 levels 全为空：开开关看不到任何线
    const cases: Array<[number, number, string]> = [
      [100, 180, '3km 视野 80m 高差'],
      [100, 250, '5km 视野 150m 高差'],
      [100, 300, '10km 视野 200m 高差'],
      [100, 400, '20km 视野 300m 高差'],
      [100, 900, '50km 视野 800m 高差'],
    ]
    for (const [min, max, label] of cases) {
      const levels = contourLevels(min, max)
      expect(levels.length, label).toBeGreaterThanOrEqual(6)
      expect(levels.length, label).toBeLessThanOrEqual(12)
      // 所有等高值都必须落在 [min, max] 内
      for (const lv of levels) {
        expect(lv, label).toBeGreaterThanOrEqual(min)
        expect(lv, label).toBeLessThanOrEqual(max)
      }
    }
  })

  it('高差越大条数不增（等高距跟着放大）', () => {
    const small = contourLevels(0, 120)
    const big = contourLevels(0, 3000)
    expect(small.length).toBeGreaterThanOrEqual(6)
    expect(big.length).toBeGreaterThanOrEqual(6)
    expect(big.length).toBeLessThanOrEqual(small.length)
  })

  it('近乎平地不画（避免 0.1m 级碎线）', () => {
    expect(contourLevels(100, 100)).toEqual([])
    expect(contourLevels(100, 101.5)).toEqual([])
    expect(contourLevels(NaN, 200)).toEqual([])
  })

  it('targetLines = 想要的条数：越大条数越多（段数超限时是"减半"使用，不是加倍）', () => {
    const few = contourLevels(0, 1000, 5)
    const normal = contourLevels(0, 1000, 10)
    const many = contourLevels(0, 1000, 20)
    expect(few.length).toBeGreaterThan(0)
    expect(few.length).toBeLessThan(normal.length)
    expect(normal.length).toBeLessThanOrEqual(many.length)
  })
})

describe('端到端：合成地形必须真的出线段', () => {
  /** 造一片有起伏的高程网格（行主序，row 0 在北），模拟河谷/山坡 */
  function syntheticTerrain(n: number, relief: number): number[] {
    const h: number[] = []
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        // 一条山脊 + 一点起伏：高差恰为 relief
        const t = col / (n - 1)
        const ridge = Math.sin(t * Math.PI) * relief
        const ripple = Math.sin(row * 0.7) * relief * 0.15
        h.push(100 + ridge + ripple)
      }
    }
    return h
  }

  it('80×80 网格、200m 高差 → 既有等高值也有线段', () => {
    const n = 80
    const h = syntheticTerrain(n, 200)
    const levels = contourLevels(100, 300)
    expect(levels.length).toBeGreaterThanOrEqual(6)
    const segs = contourSegments(h, n, n, levels)
    expect(segs.length).toBeGreaterThan(50)
    // 线段坐标必须落在网格范围内（渲染时按此插值成经纬度）
    for (const s of segs.slice(0, 200)) {
      expect(s.x1).toBeGreaterThanOrEqual(0)
      expect(s.x1).toBeLessThanOrEqual(n - 1)
      expect(s.y2).toBeLessThanOrEqual(n - 1)
    }
  })

  it('同一片地形下，等高值越多线段越多（供段数上限兜底调疏）', () => {
    const n = 80
    const h = syntheticTerrain(n, 400)
    const dense = contourSegments(h, n, n, contourLevels(100, 500, 12)).length
    const sparse = contourSegments(h, n, n, contourLevels(100, 500, 4)).length
    expect(dense).toBeGreaterThan(sparse)
    expect(sparse).toBeGreaterThan(0)
  })
})

/**
 * 回归：`sampleTerrainMostDetailed` 的参数顺序。
 *
 * Cesium 1.146 的签名是 **(terrainProvider, positions, singleTileFallback)** ——
 * 地形提供器是**第一个**参数。早期版本曾提供过"不传 provider"的重载，照抄旧写法
 * 会让 Cesium 内部去读第二个参数的 `.length`，抛
 * `TypeError: Cannot read properties of undefined (reading 'length')`
 * （线上就踩过一次：开关打开后控制台报这个错、地图没有任何等高线）。
 */
describe('createContourLayer：地形采样调用契约', () => {
  function makeFakeCesium() {
    const calls: any[] = []
    const terrainProvider = { availability: { computeMaximumLevelAtPosition: () => 14 } }
    const C: any = {
      Math: { toDegrees: (r: number) => (r * 180) / Math.PI },
      TerrainDataType: { BILINEAR: 'BILINEAR' },
      Cartesian3: {
        fromDegreesArray: (flat: number[]) => flat.map((v, i) => ({ i, v })),
      },
      Cartographic: { fromCartesian: (p: any) => ({ height: p.v }) },
      Color: { fromCssColorString: (s: string) => s },
      ColorGeometryInstanceAttribute: { fromColor: (c: any) => c },
      GeometryInstance: class { constructor(public o: any) {} },
      GroundPolylineGeometry: class { constructor(public o: any) {} },
      GroundPolylinePrimitive: class { constructor(public o: any) {} },
      PolylineColorAppearance: class {},
      sampleTerrainMostDetailed: (...args: any[]) => {
        calls.push(args)
        // 返回与传入等长、形状一致（{i, v}，v 由 Cartographic.fromCartesian 读作 height）的笛卡尔数组，
        // 高度随下标起伏，保证能切出等高线
        return args[1].map((_: any, i: number) => ({ i, v: 100 + (i % 40) }))
      },
    }
    const viewer: any = {
      terrainProvider,
      camera: {
        positionCartographic: { height: 3000 },
        computeViewRectangle: () => ({
          west: 1.1, south: 0.5, east: 1.3, north: 0.7,
        }),
      },
      scene: {
        primitives: {
          added: [] as any[],
          add(p: any) { this.added.push(p); return p },
          remove(p: any) { this.added = this.added.filter((x: any) => x !== p) },
        },
        globe: {
          tileLoadProgressEvent: { addEventListener() {}, removeEventListener() {} },
        },
      },
    }
    return { C, viewer, calls, terrainProvider }
  }

  it('第一个参数必须是地形提供器，第二个是采样点数组', async () => {
    const { C, viewer, calls, terrainProvider } = makeFakeCesium()
    const layer = createContourLayer({ C, viewer })
    await layer.update()

    expect(calls.length).toBe(1)
    expect(calls[0][0]).toBe(terrainProvider)      // 第一个参数 = terrainProvider
    expect(Array.isArray(calls[0][1])).toBe(true)    // 第二个参数 = positions
    expect(calls[0][1].length).toBeGreaterThan(0)
    expect(calls[0][2] ?? false).toBe(false)         // 第三个参数是布尔量（不是插值类型字符串）
    layer.destroy()
  })

  it('采样有结果时确实加上了贴地图元，destroy 后移除', async () => {
    const { C, viewer } = makeFakeCesium()
    const primitives = viewer.scene.primitives
    const layer = createContourLayer({ C, viewer })
    await layer.update()

    expect(primitives.added.length).toBe(1)
    layer.destroy()
    expect(primitives.added.length).toBe(0)
  })

  it('地形提供器不支持最精细采样时给出明确原因而不是崩掉', async () => {
    const { C, viewer } = makeFakeCesium()
    viewer.terrainProvider = { availability: undefined }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = createContourLayer({ C, viewer })
    await expect(layer.update()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toContain('最精细采样')
    expect(viewer.scene.primitives.added.length).toBe(0)
    warn.mockRestore()
    layer.destroy()
  })
})
