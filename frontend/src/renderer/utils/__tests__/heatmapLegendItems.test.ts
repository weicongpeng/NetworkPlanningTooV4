import { describe, expect, it } from 'vitest'
import type { HeatmapSettings } from '../../components/Map/LabelSettingsModal'
import { DEFAULT_HEATMAP_SETTINGS } from '../../components/Map/LabelSettingsModal'
import { buildHeatmapLegendItems } from '../heatmapLegendItems'

const enabled = (field: string): HeatmapSettings => ({
  ...DEFAULT_HEATMAP_SETTINGS, enabled: true, field,
})

describe('buildHeatmapLegendItems', () => {
  it('图层 id 与设置 key 一致且已勾选时按图层名展示', () => {
    const items = buildHeatmapLegendItems(
      { a: enabled('rsrp') },
      [{ id: 'a', name: '图层A', visible: true }],
    )
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('图层A')
  })

  it('设置 key 与图层 id 对不上时不出图例（不显示孤立 UUID 字段）', () => {
    const items = buildHeatmapLegendItems(
      { '4c5226d4-e41d-4e75-a1c6-d1a8b9aa41e0': enabled('容量挡位') },
      [{ id: 'new-layer-id', name: '新图层', visible: true }],
    )
    expect(items).toHaveLength(0)
  })

  it('图层列表尚未加载（空数组）时不出图例，等图层就绪再按勾选恢复', () => {
    const items = buildHeatmapLegendItems({ a: enabled('rsrp') }, [])
    expect(items).toHaveLength(0)
  })

  it('图层未勾选（visible=false）时不出图例', () => {
    const items = buildHeatmapLegendItems(
      { a: enabled('rsrp') },
      [{ id: 'a', name: '图层A', visible: false }],
    )
    expect(items).toHaveLength(0)
  })

  it('未启用的设置不产生图例项，空设置时不显示图例', () => {
    const disabled: HeatmapSettings = { ...enabled('rsrp'), enabled: false }
    expect(buildHeatmapLegendItems({ a: disabled }, [{ id: 'a', name: 'A', visible: true }])).toHaveLength(0)
    expect(buildHeatmapLegendItems({}, [{ id: 'a', name: 'A', visible: true }])).toHaveLength(0)
  })

  it('按图层名展示已勾选图层，孤立设置与未勾选图层一并剔除', () => {
    const items = buildHeatmapLegendItems(
      { a: enabled('rsrp'), b: enabled('sinr'), orphan: enabled('容量挡位') },
      [
        { id: 'a', name: '图层A', visible: true },
        { id: 'b', name: '图层B', visible: false },
      ],
    )
    expect(items.map(i => i.name)).toEqual(['图层A'])
  })
})
