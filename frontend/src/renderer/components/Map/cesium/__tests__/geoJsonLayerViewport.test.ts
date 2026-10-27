/**
 * CesiumGeoJsonLayer 视口裁剪行为锁定。
 *
 * 背景："3D 叠加自定义图层后卡顿"的主因之一是万级要素的图层在每次重建时把全部
 * 几何重新三角化。这里锁住视口裁剪的行为边界：
 * 1. 裁剪只对"大图层"（要素数超过阈值）生效，小图层行为与优化前完全一致
 * 2. 选中要素在视野外也必须渲染（圈选高亮不能缺）
 * 3. 同视野重复 setView 不触发重建（视野分档键去重）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { CesiumGeoJsonLayer } from '../CesiumGeoJsonLayer'

/** 极简 Cesium mock：只记录点图元（PointPrimitiveCollection）的条目数 */
function makeCesiumMock() {
  const pointColls: any[] = []
  const C: any = {
    Cartesian3: {
      fromDegrees: (...a: number[]) => a,
      fromDegreesArray: (a: number[]) => a,
    },
    Color: {
      fromCssColorString: (css: string) => ({
        css,
        withAlpha(alpha: number) { return { css, alpha } },
      }),
    },
    ColorGeometryInstanceAttribute: { fromColor: (color: any) => ({ color }) },
    GeometryInstance: class {
      constructor(public opts: any) {
        this.geometry = opts.geometry
        this.attributes = opts.attributes
        this.id = opts.id
      }
      geometry: any
      attributes: any
      id: any
    },
    PolygonGeometry: class { constructor(public opts: any) {} },
    GroundPolylineGeometry: class { constructor(public opts: any) {} },
    PolygonHierarchy: class { constructor(public positions: any) {} },
    PerInstanceColorAppearance: Object.assign(
      class { constructor(public opts?: any) {} },
      { VERTEX_FORMAT: 'vertexFormat' },
    ),
    PolylineColorAppearance: class { constructor(public opts?: any) {} },
    GroundPrimitive: class {
      kind = 'ground-polygon'
      constructor(public opts: any) {}
    },
    GroundPolylinePrimitive: class {
      kind = 'ground-polyline'
      constructor(public opts: any) {}
    },
    PointPrimitiveCollection: class {
      kind = 'points'
      items: any[] = []
      add(opts: any) { this.items.push(opts); return opts }
      constructor() { pointColls.push(this) }
    },
  }
  /** 当前挂在场景里的图元（remove 要真正移除，否则重建后计数会累积） */
  const live: any[] = []
  const viewer: any = {
    scene: {
      primitives: {
        add: (p: any) => { live.push(p); return p },
        remove: (p: any) => {
          const i = live.indexOf(p)
          if (i >= 0) live.splice(i, 1)
        },
      },
    },
  }
  return { C, viewer, pointColls, live }
}

/** 当前挂在场景里的点图元条目总数（0 = 没建点图元） */
function pointCount(live: any[]): number {
  return live
    .filter((p) => p.kind === 'points')
    .reduce((n, c) => n + c.items.length, 0)
}

/** 生成围绕 (114.7, 23.75) 散布的 n 个点要素（间隔 0.002°，列宽 0.2°） */
function spreadPoints(n: number) {
  const features: any[] = []
  for (let i = 0; i < n; i++) {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [114.7 + (i % 100) * 0.002, 23.75 + Math.floor(i / 100) * 0.002],
      },
      properties: { id: `p${i}` },
    })
  }
  return { type: 'FeatureCollection', features }
}

/** setView 的重建走 rAF 合并，等两帧让它跑完 */
function flushFrames(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40))
}

describe('CesiumGeoJsonLayer 视口裁剪', () => {
  let live: any[]
  let layer: CesiumGeoJsonLayer

  beforeEach(() => {
    const mock = makeCesiumMock()
    live = mock.live
    layer = new CesiumGeoJsonLayer(mock.C, mock.viewer, 'layer-1')
  })

  it('大图层（超过阈值）：只建视野内的点，视野外不建', async () => {
    layer.setFeatureCollection(spreadPoints(2500) as any)
    expect(pointCount(live)).toBe(2500) // 初始无视野 → 全量

    // 视野在千里之外：一个点都不该建（rAF 合并后生效）
    layer.setView({ south: 30, north: 30.01, west: 120, east: 120.01, zoom: 15 })
    await flushFrames()
    expect(pointCount(live)).toBe(0)

    // 视野覆盖中心区域：只建视口内（含外扩）的点
    layer.setView({ south: 23.74, north: 23.76, west: 114.69, east: 114.71, zoom: 15 })
    await flushFrames()
    const inView = pointCount(live)
    expect(inView).toBeGreaterThan(0)
    expect(inView).toBeLessThan(2500)
  })

  it('小图层（低于阈值）：视野再远也全量渲染（行为与优化前一致）', async () => {
    layer.setFeatureCollection(spreadPoints(50) as any)
    expect(pointCount(live)).toBe(50)
    layer.setView({ south: 30, north: 30.01, west: 120, east: 120.01, zoom: 15 })
    await flushFrames()
    expect(pointCount(live)).toBe(50)
  })

  it('选中要素在视野外也必须渲染（圈选高亮不能缺）', async () => {
    layer.setFeatureCollection(spreadPoints(2500) as any)
    layer.setSelectionIds(new Set(['p0']))
    layer.setView({ south: 30, north: 30.01, west: 120, east: 120.01, zoom: 15 })
    await flushFrames()
    expect(pointCount(live)).toBe(1)
  })

  it('同视野重复 setView 不触发重建（视野分档键去重）', async () => {
    layer.setFeatureCollection(spreadPoints(2500) as any)
    const view = { south: 23.74, north: 23.76, west: 114.69, east: 114.71, zoom: 15 }
    layer.setView(view)
    await flushFrames()
    const n = pointCount(live)
    const liveBefore = live.length
    layer.setView(view) // 视野完全不变：键相同，不应重建
    await flushFrames()
    expect(pointCount(live)).toBe(n)
    expect(live.length).toBe(liveBefore)
  })
})
