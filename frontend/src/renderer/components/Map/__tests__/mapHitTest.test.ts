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
  layerHitAt,
  resolveHits,
  CLICK_HIT_TOLERANCE_PX,
  type FeatureHitType,
} from '../mapHitTest'
import { MapInfoLayer } from '../MapInfoLayer'
import { SectorSVGLayer } from '../SectorRendererSVG'

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

describe('layerHitAt 命中分级（direct / border）', () => {
  const map = makeFakeMap()

  it('面填充包含点击点 → direct，距离 0', () => {
    const square = L.polygon([[0, 0], [0, 10], [10, 10], [10, 0]])
    expect(layerHitAt(map, square, L.latLng(5, 5))).toEqual({ type: 'direct', distancePx: 0 })
  })

  it('点击点在面外但边框容差内 → border，并给出像素距离', () => {
    const square = L.polygon([[0, 0], [0, 10], [10, 10], [10, 0]])
    // 距上边框（lat=10）0.05° = 5px（点在面外）
    const hit = layerHitAt(map, square, L.latLng(10.05, 5))
    expect(hit?.type).toBe('border')
    expect(hit?.distancePx).toBeCloseTo(5, 0)
    // 距上边框 2° = 200px：不命中
    expect(layerHitAt(map, square, L.latLng(12, 5))).toBeNull()
  })

  it('镂空面（fill 关闭）内部仍按填充判定 → direct（与填充样式无关）', () => {
    const hollow = L.polygon([[0, 0], [0, 10], [10, 10], [10, 0]], { fill: false })
    expect(layerHitAt(map, hollow, L.latLng(5, 5))?.type).toBe('direct')
  })

  it('点要素容差内 → direct（距离即为像素距离）', () => {
    const marker = L.circleMarker([5, 5])
    const hit = layerHitAt(map, marker, L.latLng(5, 5.1))  // 10px
    expect(hit?.type).toBe('direct')
    expect(hit?.distancePx).toBeCloseTo(10, 0)
    expect(layerHitAt(map, marker, L.latLng(5, 5.2))).toBeNull()  // 20px > 12px
  })

  it('线要素容差内 → direct', () => {
    const line = L.polyline([[0, 0], [10, 10]])
    expect(layerHitAt(map, line, L.latLng(5, 5))?.type).toBe('direct')
    expect(layerHitAt(map, line, L.latLng(5, 6))).toBeNull()
  })
})

describe('resolveHits 穿透收敛（"手形"点击不因边框交叠判重叠）', () => {
  const hit = (hitType: FeatureHitType, distancePx: number, z: number) => ({ hitType, distancePx, z })

  it('有 direct 命中时丢弃所有 border 命中（点在面 A 内、仅压到面 B 边框）', () => {
    const resolved = resolveHits([hit('border', 3, 0), hit('direct', 0, 1)])
    expect(resolved).toHaveLength(1)
    expect(resolved[0].hitType).toBe('direct')
  })

  it('多个 direct 命中全部保留（填充真实重叠 → 仍需重叠列表）', () => {
    const resolved = resolveHits([hit('direct', 0, 1), hit('direct', 0, 0)])
    expect(resolved).toHaveLength(2)
  })

  it('全为 border 命中时只保留最近的一个（边框交叠只穿透命中最近图形）', () => {
    const resolved = resolveHits([hit('border', 9, 0), hit('border', 2, 5)])
    expect(resolved).toHaveLength(1)
    expect(resolved[0].distancePx).toBe(2)
  })

  it('border 距离并列时取层级更高者（z 小）', () => {
    const resolved = resolveHits([hit('border', 4, 7), hit('border', 4, 1)])
    expect(resolved).toHaveLength(1)
    expect(resolved[0].z).toBe(1)
  })

  it('单命中/空命中原样返回', () => {
    expect(resolveHits([])).toEqual([])
    expect(resolveHits([hit('border', 4, 0)])).toHaveLength(1)
  })
})

describe('相邻多边形共享边框：边框交叠不算重叠（问题 2 回归）', () => {
  const map = makeFakeMap()
  let layer: MapInfoLayer

  beforeAll(async () => {
    layer = await MapInfoLayer.fromGeoJSON({
      id: 'adjacent-layer',
      name: '相邻多边形',
      type: 'polygon',
      dataId: 'data-adj',
      data: {
        type: 'FeatureCollection',
        features: [
          // 左块 lng 0..2 / lat 0..2，右块 lng 2..4 / lat 0..2 —— 仅共享 lng=2 边框，面不重叠
          {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] },
            properties: { name: 'LEFT' },
          },
          {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [[[2, 0], [4, 0], [4, 2], [2, 2], [2, 0]]] },
            properties: { name: 'RIGHT' },
          },
        ],
      } as any,
    })
    ;(layer as any).currentMap = map
  })

  it('点击共享边框：两要素都命中但最多只有一个是填充命中（另一个仅边框）', () => {
    const result = layer.getFeaturesAtPoint(L.latLng(1, 2))  // 边框线上（lat=1°, lng=2° → 像素 (200,100)）
    expect(result.map(r => r.properties.name).sort()).toEqual(['LEFT', 'RIGHT'])
    // 面不重叠：至多一个要素的填充包含点击点，另一个只能是 border 弱命中
    expect(result.filter(r => r.hitType === 'direct').length).toBeLessThanOrEqual(1)
    expect(result.some(r => r.hitType === 'border')).toBe(true)
  })

  it('resolveHits 收敛后只剩 1 个（不再弹多项重叠列表）', () => {
    const result = layer.getFeaturesAtPoint(L.latLng(1, 2))
    // 模拟 OnlineMap：按图层内面板序号赋 z（编号小 = 层级高）
    const withZ = result.map((r, i) => ({ ...r, z: i }))
    const resolved = resolveHits(withZ)
    expect(resolved).toHaveLength(1)
  })

  it('边框交叉、面不重叠：两要素均为 border 命中，收敛后只剩层级高的一个', async () => {
    // 两块菱形（旋转 45° 的正方形），边框在 (lng 3.5, lat 2.5) / (3.5, 3.5) 交叉，填充互不覆盖
    const crossLayer = await MapInfoLayer.fromGeoJSON({
      id: 'cross-layer',
      name: '边框交叉多边形',
      type: 'polygon',
      dataId: 'data-cross',
      data: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[2, 3], [3, 2], [4, 3], [3, 4], [2, 3]]] }, properties: { name: 'D1' } },
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[3, 3], [4, 2], [5, 3], [4, 4], [3, 3]]] }, properties: { name: 'D2' } },
        ],
      } as any,
    })
    ;(crossLayer as any).currentMap = map

    // (lng 3.5, lat 2.4) → 像素 (350,240)：距两块边框均约 7.07px，且都在填充之外
    const result = crossLayer.getFeaturesAtPoint(L.latLng(2.4, 3.5))
    expect(result.map(r => r.properties.name).sort()).toEqual(['D1', 'D2'])
    expect(result.every(r => r.hitType === 'border')).toBe(true)
    expect(result[0].distancePx).toBeCloseTo(result[1].distancePx, 1)

    // 距离并列 → 取层级高者（z 小）：不再出现两项重叠清单
    const resolved = resolveHits(result.map((r, i) => ({ ...r, z: i })))
    expect(resolved).toHaveLength(1)
    expect(resolved[0].properties.name).toBe('D1')
  })

  it('点击面内部仍为 direct 命中（真重叠判定不受影响）', () => {
    const result = layer.getFeaturesAtPoint(L.latLng(1, 1))  // 左块内部
    expect(result).toHaveLength(1)
    expect(result[0].properties.name).toBe('LEFT')
    expect(result[0].hitType).toBe('direct')
  })
})

describe('SectorSVGLayer.getSectorsAtLatLng 扇区几何命中', () => {
  const map = makeFakeMap()

  /** 构造带渲染缓存与 sectorData 的扇区图层（绕过渲染流程，仅测命中逻辑） */
  function makeSectorLayer(polygon: L.Polygon, sector: Record<string, any>) {
    const layer = new SectorSVGLayer({ sectors: [sector as any], zoom: 12 })
    ;(polygon as any).sectorData = sector
    const fg = L.featureGroup([polygon])
    ;(layer as any).mapInstance = map
    ;(layer as any).featureGroup = fg
    ;(layer as any).sectorPolygons = new Map([
      [String(sector.id), { polygon, lastUsed: Date.now(), zoom: 12 }],
    ])
    return layer
  }

  const sector = { id: 's1', name: '小区1', networkType: 'LTE', pci: 100 }

  it('扇形填充内 → direct；容差外 → 无命中', () => {
    // 矩形近似扇形：lng 0..2 / lat 0..2
    const polygon = L.polygon([[0, 0], [0, 2], [2, 2], [2, 0]])
    const layer = makeSectorLayer(polygon, sector)
    const hits = layer.getSectorsAtLatLng(L.latLng(1, 1))
    expect(hits).toHaveLength(1)
    expect(hits[0].sector.id).toBe('s1')
    expect(hits[0].hitType).toBe('direct')
    expect(layer.getSectorsAtLatLng(L.latLng(50, 50))).toEqual([])
  })

  it('仅压到边框（点在扇形外但在 12px 容差内）→ border，交由调用方穿透收敛', () => {
    const polygon = L.polygon([[0, 0], [0, 2], [2, 2], [2, 0]])
    const layer = makeSectorLayer(polygon, sector)
    const hits = layer.getSectorsAtLatLng(L.latLng(2.05, 1))  // 距上边框 5px
    expect(hits).toHaveLength(1)
    expect(hits[0].hitType).toBe('border')
    expect(hits[0].distancePx).toBeCloseTo(5, 0)
  })

  it('不在渲染层中的缓存要素不参与命中', () => {
    const polygon = L.polygon([[0, 0], [0, 2], [2, 2], [2, 0]])
    const layer = makeSectorLayer(polygon, sector)
    ;(layer as any).featureGroup.removeLayer(polygon)
    expect(layer.getSectorsAtLatLng(L.latLng(1, 1))).toEqual([])
  })
})
