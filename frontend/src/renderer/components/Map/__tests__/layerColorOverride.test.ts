/**
 * 图层级配色（右键"自定义设置 → 颜色"）必须优先于要素自带样式（_style）
 *
 * 关注点（2026-10-16 修复的"打开编辑开关才能改配色"认知偏差的真实根因）：
 * - 点要素：_resolvePointStyle 的读取顺序是 markerColor → fillColor、markerSize → radius，
 *   setStyleOverrides 只写 fillColor/radius 会被要素自带的 markerColor/markerSize 挡住，
 *   表现为"改图形颜色/图形大小没反应"（与"编辑"开关无关，未开开关同样无效）。
 * - 未设置图形大小时不覆盖要素自带大小（避免把要素尺寸统一刷成默认）。
 * - 线/面要素：图层级用户配色同样覆盖要素自带 strokeColor/fillColor。
 */
import { describe, it, expect } from 'vitest'
import { MapInfoLayer } from '../MapInfoLayer'
import { NO_FILL_COLOR } from '../../../utils/fieldValue'

const pt = (props: Record<string, unknown> = {}) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [114, 23] },
  properties: { name: 'P', ...props },
})
const line = (props: Record<string, unknown> = {}) => ({
  type: 'Feature' as const,
  geometry: { type: 'LineString' as const, coordinates: [[114, 23], [115, 24]] },
  properties: { name: 'L', ...props },
})
const poly = (props: Record<string, unknown> = {}) => ({
  type: 'Feature' as const,
  geometry: { type: 'Polygon' as const, coordinates: [[[114, 23], [115, 23], [115, 24], [114, 23]]] },
  properties: { name: 'A', ...props },
})

async function build(features: any[], type: 'point' | 'line' | 'polygon') {
  return MapInfoLayer.fromGeoJSON({
    id: 'override-layer', name: '配色覆盖', type, dataId: 'd-override',
    data: { type: 'FeatureCollection', features },
  })
}

function firstLayerOptions(layer: MapInfoLayer): any {
  const out: any[] = []
  layer.getLeafletLayer()?.eachLayer((l: any) => out.push(l.options))
  return out[0]
}

const RED = { fillColor: '#ff0000', fillOpacity: 1, borderColor: '#0000ff', borderWidth: 3, pointSize: 12 }

describe('图层配色覆盖要素自带样式', () => {
  it('点要素：图形颜色与图形大小覆盖自带 _style', async () => {
    const l = await build(
      [pt({ _style: { markerColor: '#00ff00', markerSize: 4, strokeColor: '#111111', strokeWidth: 1 } })],
      'point',
    )
    l.setStyleOverrides(RED)
    const o = firstLayerOptions(l)
    expect(o.fillColor).toBe('#ff0000')
    expect(o.radius).toBe(12)
    expect(o.color).toBe('#0000ff')
    expect(o.weight).toBe(3)
  })

  it('点要素：未设置图形大小时保留自带大小', async () => {
    const l = await build([pt({ _style: { markerColor: '#00ff00', markerSize: 4 } })], 'point')
    l.setStyleOverrides({ fillColor: '#ff0000', fillOpacity: 1, borderColor: '#0000ff', borderWidth: 3 })
    expect(firstLayerOptions(l).radius).toBe(4)
  })

  it('线要素：线色与线宽覆盖自带 _style', async () => {
    const l = await build([line({ _style: { strokeColor: '#00ff00', strokeWidth: 1 } })], 'line')
    // 线状图层无"边框颜色"项（传无色哨兵）：线色取图形颜色
    l.setStyleOverrides({ ...RED, borderColor: NO_FILL_COLOR })
    const o = firstLayerOptions(l)
    expect(o.color).toBe('#ff0000')   // 线状图层：图形颜色即线色
    expect(o.weight).toBe(3)
  })

  it('面要素：填充色与边框覆盖自带 _style', async () => {
    const l = await build([poly({ _style: { fillColor: '#00ff00', strokeColor: '#111111', strokeWidth: 1 } })], 'polygon')
    l.setStyleOverrides(RED)
    const o = firstLayerOptions(l)
    expect(o.fillColor).toBe('#ff0000')
    expect(o.color).toBe('#0000ff')
    expect(o.weight).toBe(3)
  })
})
