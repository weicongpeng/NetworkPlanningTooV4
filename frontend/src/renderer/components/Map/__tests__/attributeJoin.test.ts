/**
 * 条件选择候选构建纯函数测试
 *
 * 覆盖：图层1三类候选（扇区/图层文件/地理化数据）的引用与分组、
 * 图层2仅保留面状图层、key 唯一。
 */
import { describe, it, expect } from 'vitest'
import {
  buildLayer1Options,
  buildLayer2Options,
  type JoinOption,
} from '../attributeJoinOptions'
import type { SectorLayerOption, LayerFileOption } from '../LayerControl'

const sectors: SectorLayerOption[] = [
  { id: 'lte-sectors', label: 'LTE扇区', type: 'LTE', visible: true, icon: '', color: '' },
  { id: 'nr-sectors', label: 'NR扇区', type: 'NR', visible: false, icon: '', color: '' },
]

const layerFiles: LayerFileOption[] = [
  { id: 'poly-layer', name: '县界', type: 'polygon', visible: true, dataId: 'd-poly' },
  { id: 'point-layer', name: '景点', type: 'point', visible: true, dataId: 'd-point' },
  { id: 'mixed-layer', name: '混合', type: 'mixed', visible: true, dataId: 'd-mixed' },
]

const pointFiles: LayerFileOption[] = [
  { id: 'd-geo-poly', name: 'TAC面', type: 'polygon', visible: true, dataId: 'd-geo-poly', geometryType: 'polygon' },
  { id: 'd-geo-point', name: '基站点', type: 'point', visible: true, dataId: 'd-geo-point' },
]

describe('buildLayer1Options', () => {
  const opts = buildLayer1Options(sectors, layerFiles, pointFiles)

  it('按 扇区+图层文件+地理化数据 全量收集', () => {
    expect(opts).toHaveLength(2 + 3 + 2)
  })

  it('扇区引用 kind=sector 并携带 networkType', () => {
    const lte = opts.find((o) => o.key === 'sector:lte-sectors:LTE')
    expect(lte?.group).toBe('baseStation')
    expect(lte?.ref).toEqual({ kind: 'sector', networkType: 'LTE' })
    expect(lte?.isPolygon).toBe(false)
  })

  it('图层文件引用 kind=mapinfo 并携带 dataId/layerId', () => {
    const poly = opts.find((o) => o.key === 'mapinfo:d-poly:poly-layer')
    expect(poly?.group).toBe('layerFiles')
    expect(poly?.ref).toEqual({ kind: 'mapinfo', dataId: 'd-poly', layerId: 'poly-layer' })
    expect(poly?.isPolygon).toBe(true)
  })

  it('mixed 图层文件标记为面状', () => {
    const mixed = opts.find((o) => o.key === 'mapinfo:d-mixed:mixed-layer')
    expect(mixed?.isPolygon).toBe(true)
  })

  it('point 图层文件标记为非面状', () => {
    const point = opts.find((o) => o.key === 'mapinfo:d-point:point-layer')
    expect(point?.isPolygon).toBe(false)
  })

  it('地理化数据引用 kind=geodata，polygon 标记为面状', () => {
    const geoPoly = opts.find((o) => o.key === 'geodata:d-geo-poly')
    expect(geoPoly?.group).toBe('geoData')
    expect(geoPoly?.ref).toEqual({ kind: 'geodata', dataId: 'd-geo-poly' })
    expect(geoPoly?.isPolygon).toBe(true)

    const geoPoint = opts.find((o) => o.key === 'geodata:d-geo-point')
    expect(geoPoint?.isPolygon).toBe(false)
  })

  it('所有 key 唯一', () => {
    expect(new Set(opts.map((o) => o.key)).size).toBe(opts.length)
  })
})

describe('buildLayer2Options', () => {
  const all = buildLayer1Options(sectors, layerFiles, pointFiles)
  const l2 = buildLayer2Options(all)

  it('仅保留面状图层（MapInfo polygon/mixed + 地理化 polygon）', () => {
    expect(l2.map((o) => o.key).sort()).toEqual(
      [
        'mapinfo:d-poly:poly-layer',
        'mapinfo:d-mixed:mixed-layer',
        'geodata:d-geo-poly',
      ].sort(),
    )
  })

  it('排除所有扇区与点图层', () => {
    expect(l2.some((o) => o.ref.kind === 'sector')).toBe(false)
    expect(l2.some((o) => o.key === 'mapinfo:d-point:point-layer')).toBe(false)
  })

  it('结果均为 JoinOption 面状', () => {
    expect(l2.every((o: JoinOption) => o.isPolygon)).toBe(true)
  })
})
