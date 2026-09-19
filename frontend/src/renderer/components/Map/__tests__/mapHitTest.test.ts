/**
 * 点击精确命中检测回归测试
 *
 * 覆盖修复：面状图层点击内部区域时，即使其他要素的包围盒/边框与点击位置
 * 相近，只要其封闭区域不包含点击点就不算命中 —— 只有多个要素填充区域
 * 确实重叠于点击点时才返回多个命中（重叠列表）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import L from 'leaflet'
import {
  normalizeLatLngRings,
  pointInRingPx,
  minDistanceToRingPx,
  layerContainsPoint,
  CLICK_HIT_TOLERANCE_PX,
} from '../mapHitTest'
import { MapInfoLayer } from '../MapInfoLayer'

/** 假地图：经纬度直接按 100 倍线性投影为容器像素（1° = 100px） */
function makeFakeMap() {
  return {
    latLngToContainerPoint: (ll: L.LatLng) => L.point(ll.lng * 100, ll.lat * 100),
  } as any as L.Map
}

describe('normalizeLatLngRings 环结构归一化', () => {
  it('简单面：LatLng[] → 1 个环', () => {
    const layer = L.polygon([[0, 0], [0, 10], [10, 10], [10, 0]])
    const rings = normalizeLatLngRings(layer.getLatLngs())
    expect(rings.length).toBe(1)
    expect(rings[0].length).toBe(4)
  })

  it('带孔面：LatLng[][] → 外环 + 孔洞 2 个环', () => {
    const layer = L.polygon([
      [[0, 0], [0, 10], [10, 10], [10, 0]],
      [[4, 4], [4, 6], [6, 6], [6, 4]],
    ])
    const rings = normalizeLatLngRings(layer.getLatLngs())
    expect(rings.length).toBe(2)
  })

  it('MultiPolygon：LatLng[][][] → 各部分的环全部展平', () => {
    const layer = L.polygon([
      [[[0, 0], [0, 2], [2, 2], [2, 0]]],
      [[[8, 8], [8, 10], [10, 10], [10, 8]]],
    ])
    const rings = normalizeLatLngRings(layer.getLatLngs())
    expect(rings.length).toBe(2)
  })
})

describe('pointInRingPx / minDistanceToRingPx 像素几何', () => {
  it('射线法：环内/环外判定', () => {
    const ring = [L.point(0, 0), L.point(1000, 0), L.point(1000, 1000), L.point(0, 1000)]
    expect(pointInRingPx(L.point(500, 500), ring)).toBe(true)
    expect(pointInRingPx(L.point(1500, 500), ring)).toBe(false)
  })

  it('开放折线不首尾相连，闭合环额外计算首尾闭合边', () => {
    // 三角形三边中的两条：(0,0)→(1000,0)→(1000,1000)，闭合边为 (1000,1000)→(0,0)（对角线 y=x）
    const ring = [L.point(0, 0), L.point(1000, 0), L.point(1000, 1000)]
    // 点 (20,500)：开放时最近为底边 y=0（距离 500）
    expect(minDistanceToRingPx(L.point(20, 500), ring, false)).toBeCloseTo(500, 0)
    // 闭合时闭合边 y=x 更近（≈339）
    expect(minDistanceToRingPx(L.point(20, 500), ring, true)).toBeCloseTo(339, 0)
    // 线上点距离 0
    expect(minDistanceToRingPx(L.point(500, 0), ring, false)).toBe(0)
  })
})

describe('layerContainsPoint 精确命中', () => {
  const map = makeFakeMap()

  it('面填充：内部命中、外部不命中', () => {
    const square = L.polygon([[0, 0], [0, 10], [10, 10], [10, 0]])
    expect(layerContainsPoint(map, square, L.latLng(5, 5))).toBe(true)
    expect(layerContainsPoint(map, square, L.latLng(15, 5))).toBe(false)
  })

  it('面边框：容差范围内压线命中，过远不命中', () => {
    const square = L.polygon([[0, 0], [0, 10], [10, 10], [10, 0]])
    // 距底边（lat=0）0.05° = 5px，在 12px 容差内
    expect(layerContainsPoint(map, square, L.latLng(0.05, 5))).toBe(true)
    // 距底边 5° = 500px
    expect(layerContainsPoint(map, square, L.latLng(-5, 5))).toBe(false)
  })

  it('孔洞区域不命中（外环内 + 孔洞内 → 不含）', () => {
    const withHole = L.polygon([
      [[0, 0], [0, 10], [10, 10], [10, 0]],
      [[4, 4], [4, 6], [6, 6], [6, 4]],
    ])
    expect(layerContainsPoint(map, withHole, L.latLng(5, 5))).toBe(false) // 孔内
    expect(layerContainsPoint(map, withHole, L.latLng(2, 2))).toBe(true)  // 填充区
  })

  it('三角形面：点在包围盒内但在封闭区域外 → 不命中（误报修复核心场景）', () => {
    // 三角形顶点 [lat,lng]：(0,0) (0,10) (10,10)，填充区域为 lng ≥ lat 一侧
    const triangle = L.polygon([[0, 0], [0, 10], [10, 10]])
    // lat=8, lng=2：在包围盒 [0..10]² 内，但 lng(2) < lat(8)，在三角形外
    expect(layerContainsPoint(map, triangle, L.latLng(8, 2))).toBe(false)
    // lat=2, lng=8：lng ≥ lat，在三角形填充区内
    expect(layerContainsPoint(map, triangle, L.latLng(2, 8))).toBe(true)
  })

  it('线要素：距折线段容差内命中，过远不命中', () => {
    const line = L.polyline([[0, 0], [10, 10]])
    expect(layerContainsPoint(map, line, L.latLng(5, 5))).toBe(true)     // 线上
    expect(layerContainsPoint(map, line, L.latLng(5, 5.05))).toBe(true)  // 距线 ~3.5px
    expect(layerContainsPoint(map, line, L.latLng(5, 6))).toBe(false)    // 距线 ~71px
  })

  it('点要素：像素距离容差内命中', () => {
    const marker = L.circleMarker([5, 5])
    expect(layerContainsPoint(map, marker, L.latLng(5, 5))).toBe(true)
    expect(layerContainsPoint(map, marker, L.latLng(5, 5.1))).toBe(true)   // 10px
    expect(layerContainsPoint(map, marker, L.latLng(5, 5.2))).toBe(false)  // 20px > 12px
  })

  it('默认容差为 12px', () => {
    expect(CLICK_HIT_TOLERANCE_PX).toBe(12)
  })
})

describe('MapInfoLayer.getFeaturesAtPoint 点击查属性精确命中', () => {
  function makePolygonFeature(name: string, ringLngLat: number[][]) {
    return {
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [ringLngLat] },
      properties: { name },
    }
  }

  const map = makeFakeMap()
  let layer: MapInfoLayer

  beforeAll(async () => {
    layer = await MapInfoLayer.fromGeoJSON({
      id: 'hit-test-layer',
      name: '命中测试图层',
      type: 'polygon',
      dataId: 'data-hit',
      data: {
        type: 'FeatureCollection',
        features: [
          // A：小方块，lng 1.5-2.5 / lat 7.5-8.5
          makePolygonFeature('A', [
            [1.5, 7.5], [2.5, 7.5], [2.5, 8.5], [1.5, 8.5], [1.5, 7.5],
          ]),
          // B：大三角形（lng,lat）：(0,0) (10,0) (10,10)，填充为 lng ≥ lat
          //     包围盒 [0..10]² 覆盖 A 的位置，但封闭区域不含 A 内部
          makePolygonFeature('B', [
            [0, 0], [10, 0], [10, 10], [0, 0],
          ]),
          // C：与 A 真实重叠的小方块，lng 1.8-2.8 / lat 7.8-8.8
          makePolygonFeature('C', [
            [1.8, 7.8], [2.8, 7.8], [2.8, 8.8], [1.8, 8.8], [1.8, 7.8],
          ]),
        ],
      } as any,
    })
    // 未上图时无法投影，返回空
    expect(layer.getFeaturesAtPoint(L.latLng(8, 2))).toEqual([])
    ;(layer as any).currentMap = map
  })

  it('点在 A 内部、B 包围盒内但 B 填充外：只命中 A（不再误报重叠）', () => {
    const result = layer.getFeaturesAtPoint(L.latLng(8, 1.6))
    const names = result.map(r => r.properties.name)
    expect(names).toContain('A')
    expect(names).not.toContain('B')
    expect(names).not.toContain('C')
  })

  it('点落在 A 与 C 填充的真实重叠区：命中 A、C 两个要素', () => {
    const result = layer.getFeaturesAtPoint(L.latLng(8.1, 2.1))
    const names = result.map(r => r.properties.name).sort()
    expect(names).toEqual(['A', 'C'])
  })

  it('点在三角形 B 填充区内：命中 B', () => {
    const result = layer.getFeaturesAtPoint(L.latLng(2, 8))
    const names = result.map(r => r.properties.name)
    expect(names).toContain('B')
    expect(names).not.toContain('A')
  })

  it('空白区域：无命中', () => {
    expect(layer.getFeaturesAtPoint(L.latLng(20, 20))).toEqual([])
  })
})
