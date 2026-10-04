/**
 * 缓冲区保存目标构建纯函数测试
 *
 * 覆盖：固定首项装饰图层；仅 editable=true 且 polygon/mixed 类型的 TAB 图层进入；
 * mapinfo 目标 ref 携带 dataId/layerId；key 唯一。
 */
import { describe, it, expect } from 'vitest'
import { buildBufferTargetOptions } from '../bufferOptions'
import type { LayerFileOption } from '../LayerControl'

const layerFiles: LayerFileOption[] = [
  { id: 'poly-editable', name: '可画面', type: 'polygon', visible: true, dataId: 'd1', editable: true },
  { id: 'mixed-editable', name: '可混合', type: 'mixed', visible: true, dataId: 'd2', editable: true },
  { id: 'point-editable', name: '可画点', type: 'point', visible: true, dataId: 'd3', editable: true },
  { id: 'line-editable', name: '可画线', type: 'line', visible: true, dataId: 'd4', editable: true },
  { id: 'poly-imported', name: '导入面', type: 'polygon', visible: true, dataId: 'd5', editable: false },
  { id: 'poly-no-flag', name: '无标记面', type: 'polygon', visible: true, dataId: 'd6' },
]

describe('buildBufferTargetOptions', () => {
  const opts = buildBufferTargetOptions(layerFiles)

  it('首项固定为装饰图层', () => {
    expect(opts[0]).toEqual({
      key: 'decoration',
      label: '装饰图层',
      ref: { kind: 'decoration' },
    })
  })

  it('仅 editable 的 polygon/mixed 图层进入', () => {
    expect(opts.map((o) => o.key)).toEqual([
      'decoration',
      'mapinfo:d1:poly-editable',
      'mapinfo:d2:mixed-editable',
    ])
  })

  it('点/线型图层即使 editable 也排除', () => {
    expect(opts.some((o) => o.key === 'mapinfo:d3:point-editable')).toBe(false)
    expect(opts.some((o) => o.key === 'mapinfo:d4:line-editable')).toBe(false)
  })

  it('editable 非 true 的图层排除', () => {
    expect(opts.some((o) => o.key === 'mapinfo:d5:poly-imported')).toBe(false)
    expect(opts.some((o) => o.key === 'mapinfo:d6:poly-no-flag')).toBe(false)
  })

  it('mapinfo 目标 ref 携带 dataId/layerId', () => {
    const poly = opts.find((o) => o.key === 'mapinfo:d1:poly-editable')
    expect(poly?.ref).toEqual({ kind: 'mapinfo', dataId: 'd1', layerId: 'poly-editable' })
  })

  it('所有 key 唯一', () => {
    expect(new Set(opts.map((o) => o.key)).size).toBe(opts.length)
  })
})
