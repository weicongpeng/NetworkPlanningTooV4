/**
 * 专题图例统计（2D/3D 共用）。
 *
 * 算法逐条对齐 2D 侧三处实现（SectorRendererSVG / MapInfoLayer / GeoDataLayer），
 * 两端图例必须给出同样的数字。这里覆盖三种配色模式与兜底分类。
 */
import { describe, it, expect } from 'vitest'
import { computeThematicStats } from '../thematicStats'
import type { ThematicSettings } from '../../components/Map/LabelSettingsModal'

function settings(partial: Partial<ThematicSettings>): ThematicSettings {
  return {
    enabled: true,
    field: 'pci',
    fieldType: 'numeric',
    colorMode: 'range',
    ranges: [],
    categories: [],
    ...partial,
  } as ThematicSettings
}

describe('computeThematicStats', () => {
  it('未启用 / 空数据 → null（图例不显示）', () => {
    expect(computeThematicStats(settings({ enabled: false }), [{ pci: 1 }])).toBeNull()
    expect(computeThematicStats(null, [{ pci: 1 }])).toBeNull()
    expect(computeThematicStats(settings({}), [])).toBeNull()
  })

  it('无数值区间规则 → null', () => {
    expect(computeThematicStats(settings({ ranges: [] }), [{ pci: 1 }])).toBeNull()
  })

  it('区间模式：min 含、max 不含，末段 max 含', () => {
    const ts = settings({
      ranges: [
        { min: 0, max: 10, color: '#a' },
        { min: 10, max: 20, color: '#b' },
      ],
    })
    const r = computeThematicStats(ts, [{ pci: 0 }, { pci: 9 }, { pci: 10 }, { pci: 20 }])!
    expect(r.counts).toEqual([2, 2])
    expect(r.total).toBe(4)
    expect(r.other).toBe(0)
  })

  it('区间模式：非数值/越界计入 other', () => {
    const ts = settings({ ranges: [{ min: 0, max: 10, color: '#a' }] })
    const r = computeThematicStats(ts, [{ pci: 5 }, { pci: 99 }, { pci: 'x' }, { pci: null }])!
    expect(r.counts).toEqual([1])
    expect(r.total).toBe(4)
    expect(r.other).toBe(3)
  })

  it('值模式：按属性值精确匹配，空值计入 other', () => {
    const ts = settings({
      colorMode: 'value',
      ranges: [],
      valueColors: [{ value: '1', color: '#a' }, { value: '2', color: '#b' }],
    })
    const r = computeThematicStats(ts, [{ pci: 1 }, { pci: '2' }, { pci: 3 }, { pci: '' }])!
    expect(r.counts).toEqual([1, 1])
    expect(r.other).toBe(2)
  })

  it('文本模式：命中分类计数，未命中落到 __other__', () => {
    const ts = settings({
      fieldType: 'text',
      field: 'vendor',
      ranges: [],
      categories: [
        { value: '华为', color: '#a' },
        { value: '__other__', color: '#z' },
      ],
    })
    const r = computeThematicStats(ts, [{ vendor: '华为' }, { vendor: '中兴' }, { vendor: '' }])!
    expect(r.counts).toEqual([1, 2])
    expect(r.other).toBe(0)
  })

  it('文本模式无 __other__ 时，未命中计入 other', () => {
    const ts = settings({
      fieldType: 'text',
      field: 'vendor',
      ranges: [],
      categories: [{ value: '华为', color: '#a' }],
    })
    const r = computeThematicStats(ts, [{ vendor: '华为' }, { vendor: '中兴' }])!
    expect(r.counts).toEqual([1])
    expect(r.other).toBe(1)
  })
})
