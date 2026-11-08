import { describe, expect, it } from 'vitest'
import type { HeatmapSettings } from '../../components/Map/LabelSettingsModal'
import { DEFAULT_HEATMAP_SETTINGS } from '../../components/Map/LabelSettingsModal'
import { buildHeatmapLegendItems } from '../heatmapLegendItems'

const enabled = (field: string): HeatmapSettings => ({
  ...DEFAULT_HEATMAP_SETTINGS, enabled: true, field,
})

describe('buildHeatmapLegendItems', () => {
  it('图层 id 与设置 key 一致时按图层名展示', () => {
    const items = buildHeatmapLegendItems(
      { a: enabled('rsrp') },
      [{ id: 'a', name: '图层A', visible: true }],
    )
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('图层A')
  })

  it('设置 key 与图层 id 对不上时仍兜底出图例（桌面端同步后图例不消失）', () => {
    const items = buildHeatmapLegendItems(
      { 'old-layer-id': enabled('rsrp') },
      [{ id: 'new-layer-id', name: '新图层', visible: true }],
    )
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('old-layer-id')
    expect(items[0].settings.enabled).toBe(true)
  })

  it('图层列表尚未加载（空数组）时已启用的设置仍有图例项', () => {
    const items = buildHeatmapLegendItems({ a: enabled('rsrp') }, [])
    expect(items).toHaveLength(1)
  })

  it('未启用的设置不产生图例项，空设置时不显示图例', () => {
    const disabled: HeatmapSettings = { ...enabled('rsrp'), enabled: false }
    expect(buildHeatmapLegendItems({ a: disabled }, [])).toHaveLength(0)
    expect(buildHeatmapLegendItems({}, [{ id: 'a', name: 'A', visible: true }])).toHaveLength(0)
  })

  it('可见图层优先用图层名，同一 id 不重复出条目', () => {
    const items = buildHeatmapLegendItems(
      { a: enabled('rsrp'), b: enabled('sinr') },
      [
        { id: 'a', name: '图层A', visible: true },
        { id: 'b', name: '图层B', visible: false },
      ],
    )
    expect(items.map(i => i.name)).toEqual(['图层A', 'b'])
  })
})
