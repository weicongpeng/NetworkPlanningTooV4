/**
 * MapInfoLayer 圈选回归测试
 *
 * 覆盖修复：
 * 1. 图层文件圈选不生效
 *    - getFeaturesInCircle / getFeaturesInPolygon 返回 { id, properties }，
 *      其中 id 为构建时分配的 _nptSelectionId（自然 ID 或「图层ID#序号」兜底）
 *    - 无自然 ID 的要素（MIF/KML 任意属性列名）也能被圈中，不再被静默丢弃
 *    - 圆与面/线包围盒相交即选中（修复中心判断漏选）
 * 2. 专题图层激活后圈选不还原为基础配色（setSelectionHighlight 用 _applyFeatureStyle 而非 resetStyle）
 * 3. 标签严格按所选字段显示，字段缺失不回退其他属性
 */
import { describe, it, expect, beforeAll } from 'vitest'
import L from 'leaflet'
import { MapInfoLayer } from '../MapInfoLayer'
import type { ThematicSettings } from '../LabelSettingsModal'

function makePoint(lng: number, lat: number, props: Record<string, unknown>) {
  return { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [lng, lat] }, properties: props }
}

function makePolygon(lng: number, lat: number, size: number, props: Record<string, unknown>) {
  const half = size / 2
  return {
    type: 'Feature' as const,
    geometry: {
      type: 'Polygon' as const,
      coordinates: [[
        [lng - half, lat - half],
        [lng + half, lat - half],
        [lng + half, lat + half],
        [lng - half, lat + half],
        [lng - half, lat - half],
      ]],
    },
    properties: props,
  }
}

describe('MapInfoLayer 圈选', () => {
  let layer: MapInfoLayer

  beforeAll(async () => {
    layer = await MapInfoLayer.fromGeoJSON({
      id: 'test-layer',
      name: '测试图层',
      type: 'polygon',
      dataId: 'data-1',
      data: {
        type: 'FeatureCollection',
        features: [
          // 有自然 ID（OBJECTID）
          makePoint(110.0, 20.0, { OBJECTID: 1, name: 'point-with-id' }),
          // 无自然 ID（任意属性列，如 GRID_ID）
          makePoint(110.01, 20.01, { GRID_ID: 'A1', label: 'grid-a1' }),
          // 面要素（有 ID）
          makePolygon(110.05, 20.05, 0.02, { OBJECTID: 10, name: 'poly-with-id' }),
          // 面要素（无自然 ID）
          makePolygon(110.08, 20.08, 0.02, { GRID_ID: 'B2' }),
        ],
      } as any,
    })
  })

  it('getFeaturesInCircle 返回 { id, properties } 且无自然 ID 要素也有稳定 ID', () => {
    // 圆心在 (110.0, 20.0)，半径 2000m：应圈中第一个点
    const center = L.latLng(20.0, 110.0)
    const result = layer.getFeaturesInCircle(center, 2000)

    expect(result.length).toBeGreaterThanOrEqual(1)
    for (const item of result) {
      // 每项都是 { id, properties }，id 非空
      expect(typeof item.id).toBe('string')
      expect(item.id.length).toBeGreaterThan(0)
      expect(item.properties).toBeTruthy()
    }
    // 有自然 ID 的要素用自然 ID（extractFeatureId 优先级：name 先于 OBJECTID）
    expect(result.some(r => r.id === 'point-with-id')).toBe(true)
  })

  it('无自然 ID 的要素使用「图层ID#序号」兜底 ID 而非空', () => {
    // 只圈 (110.01, 20.01) 附近
    const center = L.latLng(20.01, 110.01)
    const result = layer.getFeaturesInCircle(center, 1000)
    expect(result.length).toBeGreaterThanOrEqual(1)
    // 兜底 ID 前缀为图层 ID
    expect(result.some(r => r.id.startsWith('test-layer#'))).toBe(true)
  })

  it('圆与面要素包围盒相交即选中（中心在圆外也命中）', () => {
    // 面中心在 (110.05, 20.05)，半径约 0.01°（~1.1km）
    // 圆心取面的北边缘外侧，距中心 ~0.008°，半径 2000m —— 圆只压到面的一部分
    const center = L.latLng(20.058, 110.05)
    const result = layer.getFeaturesInCircle(center, 2000)
    const polyHit = result.some(r => r.properties?.OBJECTID === 10 || r.properties?.name === 'poly-with-id')
    expect(polyHit).toBe(true)
  })

  it('getFeaturesInPolygon 返回 { id, properties }', () => {
    const polygon = L.polygon([
      [19.99, 109.99],
      [19.99, 110.11],
      [20.11, 110.11],
      [20.11, 109.99],
    ])
    const result = layer.getFeaturesInPolygon(polygon)
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const item of result) {
      expect(typeof item.id).toBe('string')
      expect(item.properties).toBeTruthy()
    }
  })
})

describe('MapInfoLayer 圈选后的专题配色保持', () => {
  let thematicLayer: MapInfoLayer

  beforeAll(async () => {
    thematicLayer = await MapInfoLayer.fromGeoJSON({
      id: 'thematic-layer',
      name: '专题图层',
      type: 'point',
      dataId: 'data-2',
      data: {
        type: 'FeatureCollection',
        features: [
          makePoint(110.0, 20.0, { name: 'ptA', type: 'A' }),
          makePoint(110.01, 20.01, { name: 'ptB', type: 'B' }),
        ],
      } as any,
    })
    const ts: ThematicSettings = {
      enabled: true,
      field: 'type',
      fieldType: 'text',
      pointSize: 8,
      ranges: [],
      categories: [
        { value: 'A', color: '#ff0000' },
        { value: 'B', color: '#0000ff' },
      ],
    }
    thematicLayer.setThematicOverrides(ts)
  })

  function findPoint(name: string): any {
    let found: any = null
    thematicLayer.getLeafletLayer()!.eachLayer((l: any) => {
      if (l.feature?.properties?.name === name) found = l
    })
    return found
  }

  it('专题配色应用到点要素', () => {
    expect(findPoint('ptA').options.fillColor).toBe('#ff0000')
    expect(findPoint('ptB').options.fillColor).toBe('#0000ff')
  })

  it('圈选后未选中点保持专题配色（不还原基础色）', () => {
    // 只选中 ptA
    thematicLayer.setSelectionHighlight(new Set(['ptA']))
    // 选中点填充色保持专题色（红色）
    expect(findPoint('ptA').options.fillColor).toBe('#ff0000')
    // 未选中点仍是专题蓝色，而不是被 resetStyle 还原为基础色（#f59e0b）
    expect(findPoint('ptB').options.fillColor).toBe('#0000ff')
    // 清除选中后同样保持专题色
    thematicLayer.setSelectionHighlight(null)
    expect(findPoint('ptA').options.fillColor).toBe('#ff0000')
    expect(findPoint('ptB').options.fillColor).toBe('#0000ff')
  })
})

describe('MapInfoLayer 圈选后保留文件自带配色', () => {
  // 回归：_applyFeatureStyle 曾只读图层级 style.point，漏掉要素自带的 _style，
  // 圈选后所有未选中点被刷成默认橙（#f59e0b）+ 黑边（color 兜到 'none'）
  let fileStyleLayer: MapInfoLayer

  beforeAll(async () => {
    fileStyleLayer = await MapInfoLayer.fromGeoJSON({
      id: 'file-style-layer',
      name: '自带配色图层',
      type: 'point',
      dataId: 'data-4',
      data: {
        type: 'FeatureCollection',
        features: [
          makePoint(110.0, 20.0, { name: 'ptA', _style: { fillColor: '#00ff00', color: '#0000ff' } }),
          makePoint(110.01, 20.01, { name: 'ptB', _style: { fillColor: '#00ff00', color: '#0000ff' } }),
        ],
      } as any,
    })
  })

  function findPoint(name: string): any {
    let found: any = null
    fileStyleLayer.getLeafletLayer()!.eachLayer((l: any) => {
      if (l.feature?.properties?.name === name) found = l
    })
    return found
  }

  it('未配置图层级样式时点要素用文件自带配色', () => {
    expect(findPoint('ptA').options.fillColor).toBe('#00ff00')
    expect(findPoint('ptA').options.color).toBe('#0000ff')
  })

  it('圈选后未选中点仍是文件自带配色（橙底黑边即为回归）', () => {
    fileStyleLayer.setSelectionHighlight(new Set(['ptA']))
    expect(findPoint('ptA').options.color).toBe('#ef4444') // 选中：红色描边高亮
    expect(findPoint('ptB').options.fillColor).toBe('#00ff00')
    expect(findPoint('ptB').options.color).toBe('#0000ff')

    fileStyleLayer.setSelectionHighlight(null)
    expect(findPoint('ptA').options.fillColor).toBe('#00ff00')
    expect(findPoint('ptA').options.color).toBe('#0000ff')
  })
})

describe('MapInfoLayer 标签严格按所选字段', () => {
  let labelLayer: MapInfoLayer

  beforeAll(async () => {
    labelLayer = await MapInfoLayer.fromGeoJSON({
      id: 'label-layer',
      name: '标签图层',
      type: 'point',
      dataId: 'data-3',
      data: {
        type: 'FeatureCollection',
        features: [
          makePoint(110.0, 20.0, { OBJECTID: 1, GRID_ID: 'A1', name: '站点A' }),
          makePoint(110.01, 20.01, { OBJECTID: 2, name: '站点B' }),
        ],
      } as any,
    })
    // 用户选择自定义字段 GRID_ID 作为标签内容
    labelLayer.setLabelConfig({ content: 'GRID_ID', color: '#000000', fontSize: 12 })
  })

  it('所选字段存在时显示该字段值', () => {
    const getContent = (layer: MapInfoLayer) => (layer as any)._getLabelContent.bind(layer)
    expect(getContent(labelLayer)({ OBJECTID: 1, GRID_ID: 'A1', name: '站点A' })).toBe('A1')
  })

  it('所选字段缺失时不回退显示其他属性内容（返回空串）', () => {
    const getContent = (layer: MapInfoLayer) => (layer as any)._getLabelContent.bind(layer)
    // ptB 无 GRID_ID 字段：应返回 ''，不得回退显示 OBJECTID=2 或 name=站点B
    expect(getContent(labelLayer)({ OBJECTID: 2, name: '站点B' })).toBe('')
  })
})
