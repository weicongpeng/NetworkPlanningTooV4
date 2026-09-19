/**
 * 无色（镂空/无边框）样式 + 点击穿透回归测试
 *
 * 覆盖：
 * 1. 基础配色 fillColor='none'（NO_FILL_COLOR）→ 面/点要素 fill:false 仅显示边框，
 *    边框颜色保留（不被置为 'none' 非法色）
 * 2. 专题配色某类别/区间为 'none' → 该类要素镂空，边框色回退基础色
 * 3. 要素不再绑定 click + stopPropagation（点击穿透由地图 click 统一检测）
 * 4. 镂空面仍可被 getFeaturesAtPoint 射线法命中（不依赖 Leaflet 的 fill 命中）
 * 5. 基础/专题边框色 borderColor='none' → 点/面要素 stroke:false（不描边）
 * 6. 线状图层：线色由"图形颜色"（fillColor）驱动，旧版本 borderColor 存线色仍兼容
 */
import { describe, it, expect, beforeAll } from 'vitest'
import L from 'leaflet'
import { MapInfoLayer } from '../MapInfoLayer'
import { GeoDataLayer } from '../GeoDataLayer'
import { NO_FILL_COLOR } from '../../../utils/fieldValue'
import type { ThematicSettings } from '../LabelSettingsModal'

function makePolygonFeature(name: string, ringLngLat: number[][], extra: Record<string, unknown> = {}) {
  return {
    type: 'Feature' as const,
    geometry: { type: 'Polygon' as const, coordinates: [ringLngLat] },
    properties: { name, ...extra },
  }
}

function makePointFeature(name: string, lng: number, lat: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [lng, lat] },
    properties: { name, ...extra },
  }
}

/** 假地图：经纬度按 100 倍线性投影为容器像素（1° = 100px） */
function makeFakeMap() {
  return {
    latLngToContainerPoint: (ll: L.LatLng) => L.point(ll.lng * 100, ll.lat * 100),
  } as any as L.Map
}

describe('MapInfoLayer 无色（镂空）样式', () => {
  let layer: MapInfoLayer

  beforeAll(async () => {
    layer = await MapInfoLayer.fromGeoJSON({
      id: 'nofill-layer',
      name: '镂空测试图层',
      type: 'polygon',
      dataId: 'data-nofill',
      data: {
        type: 'FeatureCollection',
        features: [
          makePolygonFeature('面A', [
            [0, 0], [10, 0], [10, 10], [0, 10], [0, 0],
          ], { type: 'A' }),
          makePointFeature('点A', 5, 5, { type: 'A' }),
          makePolygonFeature('面B', [
            [20, 20], [30, 20], [30, 30], [20, 30], [20, 20],
          ], { type: 'B' }),
        ],
      } as any,
    })
  })

  function findByName(name: string): any {
    let found: any = null
    layer.getLeafletLayer()!.eachLayer((l: any) => {
      if (l.feature?.properties?.name === name) found = l
    })
    return found
  }

  it('基础配色 fillColor=none：面要素 fill:false 且边框色保留', () => {
    layer.setStyleOverrides({
      fillColor: NO_FILL_COLOR,
      fillOpacity: 0.5,
      borderWidth: 2,
      borderColor: '#ff0000',
    })
    const poly = findByName('面A')
    expect(poly.options.fill).toBe(false)
    expect(poly.options.color).toBe('#ff0000')
  })

  it('基础配色 fillColor=none：点要素（circleMarker）fill:false', () => {
    const point = findByName('点A')
    expect(point instanceof L.CircleMarker).toBe(true)
    expect(point.options.fill).toBe(false)
    expect(point.options.color).toBe('#ff0000')
  })

  it('专题配色类别为 none：该类要素镂空，边框色回退基础色（不为 none）', () => {
    const ts: ThematicSettings = {
      enabled: true,
      field: 'type',
      fieldType: 'text',
      pointSize: 8,
      ranges: [],
      categories: [
        { value: 'A', color: NO_FILL_COLOR },
        { value: 'B', color: '#0000ff' },
      ],
    }
    layer.setThematicOverrides(ts)

    const polyA = findByName('面A')
    expect(polyA.options.fill).toBe(false)
    expect(polyA.options.color).not.toBe(NO_FILL_COLOR)
    expect(polyA.options.color).toBeTruthy()

    const pointA = findByName('点A')
    expect(pointA.options.fill).toBe(false)
    expect(pointA.options.color).not.toBe(NO_FILL_COLOR)

    // 非镂空类别保持正常填充
    const polyB = findByName('面B')
    expect(polyB.options.fillColor).toBe('#0000ff')
  })

  it('基础配色 borderColor=none：面/点要素 stroke:false（不描边），填充保留', () => {
    layer.setThematicOverrides(null)
    layer.setStyleOverrides({
      fillColor: '#3b82f6',
      fillOpacity: 0.5,
      borderWidth: 2,
      borderColor: NO_FILL_COLOR,
    })
    const poly = findByName('面A')
    expect(poly.options.stroke).toBe(false)
    expect(poly.options.fillColor).toBe('#3b82f6')
    const point = findByName('点A')
    expect(point.options.stroke).toBe(false)
    expect(point.options.fill).not.toBe(false)
  })

  it('专题边框色为 none：面/点要素 stroke:false，专题填充色仍生效', () => {
    layer.setStyleOverrides({
      fillColor: '#3b82f6',
      fillOpacity: 0.5,
      borderWidth: 2,
      borderColor: '#00ff00',
    })
    layer.setThematicOverrides({
      enabled: true,
      field: 'type',
      fieldType: 'text',
      pointSize: 8,
      borderColor: NO_FILL_COLOR,
      fillOpacity: 0.9,
      ranges: [],
      categories: [
        { value: 'A', color: '#ff0000' },
        { value: 'B', color: '#0000ff' },
      ],
    } as ThematicSettings)

    const polyA = findByName('面A')
    expect(polyA.options.stroke).toBe(false)
    expect(polyA.options.fillColor).toBe('#ff0000')

    const pointA = findByName('点A')
    expect(pointA.options.stroke).toBe(false)

    const polyB = findByName('面B')
    expect(polyB.options.stroke).toBe(false)
    expect(polyB.options.fillColor).toBe('#0000ff')
  })

  it('要素不再绑定 click（点击穿透由地图 click 统一检测，无 stopPropagation 吞事件）', () => {
    layer.getLeafletLayer()!.eachLayer((l: any) => {
      expect(l._events?.click).toBeUndefined()
    })
  })

  it('镂空面仍可被 getFeaturesAtPoint 命中（射线法不依赖 Leaflet fill 命中）', () => {
    (layer as any).currentMap = makeFakeMap()
    // 面A 内部 (lat=5,lng=5)，镂空后点击仍应出属性
    const result = layer.getFeaturesAtPoint(L.latLng(5, 5))
    const names = result.map(r => r.properties.name)
    expect(names).toContain('面A')
  })
})

describe('MapInfoLayer 线状图层线色', () => {
  let lineLayer: MapInfoLayer

  beforeAll(async () => {
    lineLayer = await MapInfoLayer.fromGeoJSON({
      id: 'line-color-layer',
      name: '线色测试图层',
      type: 'line',
      dataId: 'data-line',
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature' as const,
            geometry: { type: 'LineString' as const, coordinates: [[0, 0], [10, 10]] },
            properties: { name: '线A' },
          },
        ],
      } as any,
    })
  })

  function findLine(): any {
    let found: any = null
    lineLayer.getLeafletLayer()!.eachLayer((l: any) => {
      if (l.feature?.properties?.name === '线A') found = l
    })
    return found
  }

  it('新版设置：图形颜色（fillColor）驱动线色，线宽取 borderWidth', () => {
    lineLayer.setStyleOverrides({
      fillColor: '#ff00ff',
      fillOpacity: 1,
      borderWidth: 3,
      borderColor: NO_FILL_COLOR,
    })
    const line = findLine()
    expect(line.options.color).toBe('#ff00ff')
    expect(line.options.weight).toBe(3)
  })

  it('旧版兼容：线色保存在 borderColor 时仍优先生效', () => {
    lineLayer.setStyleOverrides({
      fillColor: '#3b82f6',
      fillOpacity: 1,
      borderWidth: 2,
      borderColor: '#123456',
    })
    expect(findLine().options.color).toBe('#123456')
  })

  it('图形颜色为无色：线条不绘制（stroke:false）', () => {
    lineLayer.setStyleOverrides({
      fillColor: NO_FILL_COLOR,
      fillOpacity: 1,
      borderWidth: 2,
      borderColor: NO_FILL_COLOR,
    })
    expect(findLine().options.stroke).toBe(false)
  })
})

describe('GeoDataLayer._mergeStyleOverrides 镂空', () => {
  function makeLayer() {
    return new GeoDataLayer({
      id: 'geo-nofill',
      name: '地理化镂空',
      geometryType: 'polygon',
      data: [
        { name: 'p1', properties: { type: 'A' }, path: [[0, 0], [10, 0], [10, 10], [0, 10]] },
      ] as any,
    })
  }

  const base = { fillColor: '#ffffff', color: '#000000', weight: 2, opacity: 1, fillOpacity: 0.5 }

  it('基础覆盖 fillColor=none → fill:false，边框色保留基础色', () => {
    const layer = makeLayer()
    layer.setStyleOverrides({
      fillColor: NO_FILL_COLOR,
      fillOpacity: 0.3,
      borderWidth: 3,
      borderColor: '#00ff00',
    })
    const style = (layer as any)._mergeStyleOverrides(base)
    expect(style.fill).toBe(false)
    expect(style.color).toBe('#00ff00')
  })

  it('专题类别色为 none → fill:false，边框色不被置空', () => {
    const layer = makeLayer()
    layer.setThematicOverrides({
      enabled: true,
      field: 'type',
      fieldType: 'text',
      pointSize: 8,
      ranges: [],
      categories: [{ value: 'A', color: NO_FILL_COLOR }],
    } as any)
    const style = (layer as any)._mergeStyleOverrides(base, (layer as any).data[0])
    expect(style.fill).toBe(false)
    expect(style.color).toBe('#000000')
  })

  it('正常填充色不受影响', () => {
    const layer = makeLayer()
    layer.setStyleOverrides({
      fillColor: '#3b82f6',
      fillOpacity: 0.8,
      borderWidth: 2,
      borderColor: '#000000',
    })
    const style = (layer as any)._mergeStyleOverrides(base)
    expect(style.fillColor).toBe('#3b82f6')
    expect(style.fill).toBeUndefined()
  })

  it('基础覆盖 borderColor=none → stroke:false（不描边），填充保留', () => {
    const layer = makeLayer()
    layer.setStyleOverrides({
      fillColor: '#3b82f6',
      fillOpacity: 0.8,
      borderWidth: 2,
      borderColor: NO_FILL_COLOR,
    })
    const style = (layer as any)._mergeStyleOverrides(base)
    expect(style.stroke).toBe(false)
    expect(style.fillColor).toBe('#3b82f6')
    expect(style.fill).toBeUndefined()
  })

  it('专题边框色 none → stroke:false，专题填充色仍生效', () => {
    const layer = makeLayer()
    layer.setStyleOverrides({
      fillColor: '#ffffff',
      fillOpacity: 0.5,
      borderWidth: 2,
      borderColor: '#000000',
    })
    layer.setThematicOverrides({
      enabled: true,
      field: 'type',
      fieldType: 'text',
      pointSize: 8,
      borderColor: NO_FILL_COLOR,
      ranges: [],
      categories: [{ value: 'A', color: '#ff0000' }],
    } as any)
    const style = (layer as any)._mergeStyleOverrides(base, (layer as any).data[0])
    expect(style.stroke).toBe(false)
    expect(style.fillColor).toBe('#ff0000')
  })

  it('专题边框色为具体颜色时覆盖基础边框色（含基础为无色的情况）', () => {
    const layer = makeLayer()
    layer.setStyleOverrides({
      fillColor: '#ffffff',
      fillOpacity: 0.5,
      borderWidth: 2,
      borderColor: NO_FILL_COLOR,
    })
    layer.setThematicOverrides({
      enabled: true,
      field: 'type',
      fieldType: 'text',
      pointSize: 8,
      borderColor: '#00ff00',
      ranges: [],
      categories: [{ value: 'A', color: '#ff0000' }],
    } as any)
    const style = (layer as any)._mergeStyleOverrides(base, (layer as any).data[0])
    expect(style.color).toBe('#00ff00')
    expect(style.stroke).toBeUndefined()
  })
})
