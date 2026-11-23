import { describe, it, expect } from 'vitest'
import { findCellsMissingRequiredFields } from '../../services/mapDataService'
import type { CellListItem } from '../../services/mapDataService'
import { buildMissingCellsError } from '../cellValidation'

/** 构造字段齐全的小区 */
function makeCell(overrides: Partial<CellListItem> = {}): CellListItem {
  return {
    id: 'SITE_1',
    name: '测试小区1',
    siteId: 'SITE',
    networkType: 'LTE',
    frequency: 1850,
    longitude: 114.96,
    latitude: 24.2,
    ...overrides,
  }
}

const LABELS = {
  siteId: '基站ID',
  cellId: '小区ID',
  frequency: '频点',
  longitude: '经度',
  latitude: '纬度',
}

const MAIN_TPL = '选中的小区中有 {{count}} 个缺少必要数据，缺失示例：{{examples}}'
const MISSING_TPL = '缺少：{{fields}}'

describe('findCellsMissingRequiredFields', () => {
  it('字段齐全时返回空数组', () => {
    const sectors = [makeCell(), makeCell({ id: 'SITE_2', name: '小区2' })]
    const selected = new Set(['SITE_1', 'SITE_2'])
    expect(findCellsMissingRequiredFields(sectors, selected)).toEqual([])
  })

  it('识别缺失的经纬度/频点/基站ID', () => {
    const sectors = [
      makeCell({ id: 'A_1', longitude: null, latitude: null, frequency: null, siteId: '' }),
    ]
    const result = findCellsMissingRequiredFields(sectors, new Set(['A_1']))
    expect(result).toHaveLength(1)
    expect(result[0].missing.sort()).toEqual(['frequency', 'latitude', 'longitude', 'siteId'])
  })

  it('NaN/Infinity 经纬度视为缺失', () => {
    const sectors = [
      makeCell({ id: 'B_1', longitude: NaN, latitude: Infinity }),
    ]
    const result = findCellsMissingRequiredFields(sectors, new Set(['B_1']))
    expect(result[0].missing).toContain('longitude')
    expect(result[0].missing).toContain('latitude')
  })

  it('只校验选中的小区', () => {
    const sectors = [
      makeCell({ id: 'OK_1' }),
      makeCell({ id: 'BAD_1', longitude: null }),
    ]
    expect(findCellsMissingRequiredFields(sectors, new Set(['OK_1']))).toEqual([])
  })
})

describe('buildMissingCellsError', () => {
  it('全部齐全时返回 null', () => {
    const sectors = [makeCell()]
    const err = buildMissingCellsError(sectors, new Set(['SITE_1']), {
      labels: LABELS, mainTemplate: MAIN_TPL, missingTemplate: MISSING_TPL,
    })
    expect(err).toBeNull()
  })

  it('缺失时返回包含数量、小区名和缺失字段的中文消息', () => {
    const sectors = [makeCell({ id: 'BAD_1', name: '问题小区', longitude: null, latitude: null })]
    const err = buildMissingCellsError(sectors, new Set(['BAD_1']), {
      labels: LABELS, mainTemplate: MAIN_TPL, missingTemplate: MISSING_TPL, lang: 'zh',
    })
    expect(err).not.toBeNull()
    expect(err).toContain('1')
    expect(err).toContain('问题小区')
    expect(err).toContain('经度')
    expect(err).toContain('纬度')
    expect(err).toContain('、')
  })

  it('英文模式使用英文分隔符与括号', () => {
    const sectors = [makeCell({ id: 'BAD_1', name: 'BadCell', frequency: null })]
    const err = buildMissingCellsError(sectors, new Set(['BAD_1']), {
      labels: { siteId: 'Site ID', cellId: 'Cell ID', frequency: 'Frequency', longitude: 'Longitude', latitude: 'Latitude' },
      mainTemplate: '{{count}} cell(s) invalid: {{examples}}',
      missingTemplate: 'Missing: {{fields}}',
      lang: 'en',
    })
    expect(err).toContain('BadCell(Missing: Frequency)')
  })

  it('明细超过 exampleLimit 时只列出限定数量', () => {
    const sectors = Array.from({ length: 8 }, (_, i) =>
      makeCell({ id: `BAD_${i}`, name: `小区${i}`, longitude: null })
    )
    const selected = new Set(sectors.map(s => s.id))
    const err = buildMissingCellsError(sectors, selected, {
      labels: LABELS, mainTemplate: MAIN_TPL, missingTemplate: MISSING_TPL, lang: 'zh', exampleLimit: 3,
    })
    // 总数为 8，但明细只列 3 个
    expect(err).toContain('8')
    expect(err).toContain('小区0')
    expect(err).not.toContain('小区4')
  })
})
