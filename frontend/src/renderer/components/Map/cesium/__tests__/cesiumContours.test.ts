/**
 * 3D 等高线核心算法测试（纯函数部分，不依赖 Cesium）。
 *
 * 覆盖：等高线段提取（marching squares 简化版：线性插值交点、鞍形配对）、
 * 等高距归整、采样网格边长自适应。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  contourSegments,
  contourLevels,
  niceInterval,
  niceIntervalCeil,
  gridSizeFor,
  createContourLayer,
  reliefMask,
  reliefRadiusFor,
  chainContourSegments,
  type ContourSegment,
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
  it('城市/河谷小高差也必须能切出好几条（按跨度算会得到 0 条）', () => {
    // 这些组合在旧算法（等高距按视野跨度算）下 levels 全为空：开开关看不到任何线。
    // 目标条数已调疏（TARGET_LINES=7），下界相应放宽到 4，但**绝不能为 0**。
    const cases: Array<[number, number, string]> = [
      [100, 180, '3km 视野 80m 高差'],
      [100, 250, '5km 视野 150m 高差'],
      [100, 300, '10km 视野 200m 高差'],
      [100, 400, '20km 视野 300m 高差'],
      [100, 900, '50km 视野 800m 高差'],
    ]
    for (const [min, max, label] of cases) {
      const levels = contourLevels(min, max)
      expect(levels.length, label).toBeGreaterThanOrEqual(4)
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
    expect(small.length).toBeGreaterThanOrEqual(4)
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
    // 目标条数已调疏（TARGET_LINES=7，用户要"稀疏"），但绝不能是 0 ——
    // 这正是当年"开了开关一条线都没有"要防的回归
    expect(levels.length).toBeGreaterThanOrEqual(4)
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
describe('createContourLayer：terrarium 高程采样契约', () => {
  /**
   * 为什么锁 terrarium 而不是 ion 的 sampleTerrainMostDetailed：
   * 免费 Cesium WorldTerrain 在中国全境没有高程数据（实测 ≈-13m），
   * 按 ion 地形采样国内永远采回平地，等高线一条都画不出来。
   * 这里锁住高程源是 AWS terrarium 瓦片，防止有人改回 ion。
   */
  /** 把高程编码成 terrarium 像素（elevation = R*256 + G + B/256 - 32768） */
  function encodeTerrarium(elev: number): [number, number, number] {
    const v = elev + 32768
    const r = Math.floor(v / 256)
    const g = Math.round(v - r * 256)
    return [r, g, 0]
  }

  /**
   * 合成地形：高程随像素坐标线性起伏（保证有高差、能切出等高线）。
   * 每块瓦片用同一张图案（测试不关心瓦片间接缝）。
   */
  function syntheticTileData(): Uint8ClampedArray {
    const data = new Uint8ClampedArray(256 * 256 * 4)
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const [r, g, b] = encodeTerrarium(100 + (x + y) / 4)
        const i = (y * 256 + x) * 4
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
      }
    }
    return data
  }

  function makeFakeCesium(opts?: { tileOk?: boolean }) {
    const fetchedUrls: string[] = []
    const C: any = {
      Math: { toDegrees: (r: number) => (r * 180) / Math.PI },
      Cartesian3: { fromDegreesArray: (flat: number[]) => flat },
      Color: { fromCssColorString: (s: string) => s },
      ColorGeometryInstanceAttribute: { fromColor: (c: any) => c },
      GeometryInstance: class { constructor(public o: any) {} },
      GroundPolylineGeometry: class { constructor(public o: any) {} },
      GroundPolylinePrimitive: class { constructor(public o: any) {} },
      PolylineColorAppearance: class {},
    }
    // 城市级视野（约 0.1°×0.05°，与真实使用同量级：terrarium z13、9 块瓦片）
    const viewer: any = {
      camera: {
        positionCartographic: { height: 3000 },
        computeViewRectangle: () => ({
          west: 2.094, south: 0.523, east: 2.096, north: 0.525,
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
    const tileOk = opts?.tileOk !== false
    const fetchMock = vi.fn(async (url: string) => {
      fetchedUrls.push(url)
      if (!tileOk) return { ok: false, status: 404, blob: async () => new Blob([]) }
      return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([1, 2, 3])]) }
    })
    const bitmapMock = vi.fn(async () => ({ width: 256, height: 256, close() {} }))
    const tileData = syntheticTileData()
    const ctxMock = {
      drawImage() {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: tileData, width: w, height: h,
      }),
    }
    const getContextMock = vi.fn(() => ctxMock)
    return { C, viewer, fetchedUrls, fetchMock, bitmapMock, getContextMock, tileData }
  }

  let restoreGetContext: (() => void) | null = null
  afterEach(() => {
    vi.unstubAllGlobals()
    restoreGetContext?.()
    restoreGetContext = null
    vi.restoreAllMocks()
  })

  /** 打桩浏览器全局（fetch / createImageBitmap / canvas 2d） */
  function stubBrowser(fake: ReturnType<typeof makeFakeCesium>) {
    vi.stubGlobal('fetch', fake.fetchMock)
    vi.stubGlobal('createImageBitmap', fake.bitmapMock)
    const orig = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function () {
      return fake.getContextMock() as any
    } as any
    restoreGetContext = () => { HTMLCanvasElement.prototype.getContext = orig }
  }

  it('高程取自 terrarium 瓦片（URL 形状锁定，防止退回 ion 地形）', async () => {
    const fake = makeFakeCesium()
    stubBrowser(fake)
    const layer = createContourLayer({ C: fake.C, viewer: fake.viewer })
    await layer.update()

    expect(fake.fetchMock).toHaveBeenCalled()
    for (const url of fake.fetchedUrls) {
      expect(url).toContain("elevation-tiles-prod/terrarium/")
      expect(url).toMatch(/\.png$/)
    }
    // 城市级视野只取少数几块瓦片（LRU 缓存的就是这些）
    expect(fake.fetchedUrls.length).toBeGreaterThan(0)
    expect(fake.fetchedUrls.length).toBeLessThanOrEqual(16)
    layer.destroy()
  })

  it('采样有结果时确实加上了贴地图元，destroy 后移除', async () => {
    const fake = makeFakeCesium()
    stubBrowser(fake)
    const primitives = fake.viewer.scene.primitives
    const layer = createContourLayer({ C: fake.C, viewer: fake.viewer })
    await layer.update()

    expect(primitives.added.length).toBe(1)
    layer.destroy()
    expect(primitives.added.length).toBe(0)
  })

  it('瓦片全部取不到时不崩：给警告、走 onError、不出图元', async () => {
    const fake = makeFakeCesium({ tileOk: false })
    stubBrowser(fake)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const onSamplerError = vi.fn()
    const layer = createContourLayer({
      C: fake.C, viewer: fake.viewer, onSamplerError,
    })
    await expect(layer.update()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    // 采样器自己先 warn 一次（高程瓦片不可用），图层再 warn 一次；两条都要有
    const allWarns = warn.mock.calls.map((c) => String(c[0])).join("\n")
    expect(allWarns).toContain("高程采样失败")
    expect(allWarns).toContain("高程瓦片不可用")
    expect(onSamplerError).toHaveBeenCalled()
    expect(fake.viewer.scene.primitives.added.length).toBe(0)
    warn.mockRestore()
    layer.destroy()
  })

  it('视野内无高差（全平）时不出图元但也不报错', async () => {
    // 把所有瓦片像素编码成同一高程（平地）。双线性插值后 min/max 会有 1ulp 级
    // 浮点差（199.99999999999997 vs 200.00000000000003），走"高差不足"分支 ——
    // 两个分支都不出图元、都给明确警告，这里锁"不出图元 + 警告提到高差"。
    const fake = makeFakeCesium()
    const flat = new Uint8ClampedArray(256 * 256 * 4)
    for (let i = 0; i < flat.length; i += 4) {
      const [r, g, b] = encodeTerrarium(200)
      flat[i] = r; flat[i + 1] = g; flat[i + 2] = b; flat[i + 3] = 255
    }
    fake.tileData.set(flat)
    stubBrowser(fake)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const layer = createContourLayer({ C: fake.C, viewer: fake.viewer })
    await layer.update()
    expect(fake.viewer.scene.primitives.added.length).toBe(0)
    const allWarns = warn.mock.calls.map((c) => String(c[0])).join("\n")
    expect(allWarns).toContain("高差")
    warn.mockRestore()
    layer.destroy()
  })
})

describe('reliefMask / reliefRadiusFor（只在山体出线）', () => {
  /** 造一片高程网格：左半边平地（噪声级），右半边山坡 */
  function halfFlatHalfHill(n: number): number[] {
    const h: number[] = []
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const t = col / (n - 1)
        // 左半：平地 + 米级噪声；右半：30% 坡
        const noise = Math.sin(row * 1.7) * 2
        h.push(t < 0.5 ? 100 + noise : 100 + (t - 0.5) * 400)
      }
    }
    return h
  }

  it('平地邻域高差接近 0，山坡邻域高差很大', () => {
    const n = 40
    const h = halfFlatHalfHill(n)
    const mask = reliefMask(h, n, n, 2)
    const flat = mask[10 * n + 5]     // 左半平地
    const hill = mask[10 * n + 35]    // 右半山坡
    expect(flat).toBeLessThan(12)      // 低于门槛 → 不画
    expect(hill).toBeGreaterThan(30)   // 远高于门槛 → 画
  })

  it('起伏掩码能滤掉平地的等高线（城市不再横七竖八）', () => {
    const n = 40
    const h = halfFlatHalfHill(n)
    const levels = contourLevels(Math.min(...h), Math.max(...h))
    expect(levels.length).toBeGreaterThan(0)
    const all = contourSegments(h, n, n, levels)
    const masked = contourSegments(h, n, n, levels, reliefMask(h, n, n, 2))
    expect(all.length).toBeGreaterThan(masked.length)
    // 掩码后剩下的段必须都在山坡那半边（列号 > n/2）
    for (const s of masked) {
      expect(Math.min(s.x1, s.x2)).toBeGreaterThan(n / 2 - 3)
    }
  })

  it('邻域半径随视野自适应：放大也不至于把山体误判成平地', () => {
    // 1km 视野 / 80 格 → 每格 12.5m，固定半径 2 只有 62m，坡度再大也会被误判
    const zoomedIn = reliefRadiusFor(0.009, 80)
    expect(zoomedIn).toBeGreaterThanOrEqual(4)
    // 100km 视野 → 每格 1.25km，半径取下限 1 就够（邻域 3.75km）
    const zoomedOut = reliefRadiusFor(0.9, 80)
    expect(zoomedOut).toBeGreaterThanOrEqual(1)
    expect(zoomedOut).toBeLessThanOrEqual(6)
  })
})

describe('chainContourSegments（碎段 → 连续等高线）', () => {
  /** 一条从 (0,0) 到 (5,0) 的水平等高线，逐格给 5 段 */
  function fiveSegments(): ContourSegment[] {
    const out: ContourSegment[] = []
    for (let i = 0; i < 5; i++) {
      out.push({ x1: i, y1: 0, x2: i + 1, y2: 0, level: 100 })
    }
    return out
  }

  it('首尾相接的段串成一条连续折线（不再是一堆短横线）', () => {
    const lines = chainContourSegments(fiveSegments())
    expect(lines).toHaveLength(1)
    expect(lines[0].level).toBe(100)
    // 5 段 → 6 个顶点，且首尾正是整条线的两个端点
    expect(lines[0].points).toHaveLength(6)
    expect(lines[0].points[0]).toEqual({ x: 0, y: 0 })
    expect(lines[0].points[5]).toEqual({ x: 5, y: 0 })
  })

  it('不同等高值的段不会串到一起', () => {
    const segs: ContourSegment[] = [
      { x1: 0, y1: 0, x2: 1, y2: 0, level: 100 },
      { x1: 1, y1: 0, x2: 2, y2: 0, level: 200 },
    ]
    const lines = chainContourSegments(segs)
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.level).sort()).toEqual([100, 200])
  })

  it('闭合的一圈串成环（首尾同点）', () => {
    // 正方形一圈：4 段首尾相接
    const segs: ContourSegment[] = [
      { x1: 0, y1: 0, x2: 1, y2: 0, level: 300 },
      { x1: 1, y1: 0, x2: 1, y2: 1, level: 300 },
      { x1: 1, y1: 1, x2: 0, y2: 1, level: 300 },
      { x1: 0, y1: 1, x2: 0, y2: 0, level: 300 },
    ]
    const lines = chainContourSegments(segs)
    expect(lines).toHaveLength(1)
    const pts = lines[0].points
    expect(pts).toHaveLength(5)
    // 闭合：最后一个顶点回到起点
    expect(pts[pts.length - 1].x).toBe(pts[0].x)
    expect(pts[pts.length - 1].y).toBe(pts[0].y)
  })

  it('端点浮点误差（1ulp）不断链', () => {
    const segs: ContourSegment[] = [
      { x1: 0, y1: 0, x2: 1 + 1e-15, y2: 0, level: 100 },
      { x1: 1 - 1e-15, y1: 0, x2: 2, y2: 0, level: 100 },
    ]
    const lines = chainContourSegments(segs)
    expect(lines).toHaveLength(1)
    expect(lines[0].points).toHaveLength(3)
  })
})
