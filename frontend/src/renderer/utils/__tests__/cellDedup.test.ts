import { describe, it, expect } from 'vitest'
import { normId, cellDedupKey } from '../cellDedup'

describe('normId', () => {
  it('数字串按整数归一（去前导零/小数）', () => {
    expect(normId('01')).toBe('1')
    expect(normId('11')).toBe('11')
    expect(normId('00')).toBe('0')
    expect(normId('541379.0')).toBe('541379')
    expect(normId(460)).toBe('460')
  })
  it('空值与非数字', () => {
    expect(normId('')).toBe('')
    expect(normId(null)).toBe('')
    expect(normId(undefined)).toBe('')
    expect(normId('ABC')).toBe('ABC')
  })
})

describe('cellDedupKey', () => {
  it('LTE 键为 基站_小区（不带 PLMN）', () => {
    expect(cellDedupKey('LTE', { siteId: '541379', cellId: '61' })).toBe('541379_61')
  })

  it('NR 键为 MCC_MNC_基站_小区', () => {
    expect(cellDedupKey('NR', { siteId: '541379', cellId: '61', mcc: '460', mnc: '11' }))
      .toBe('460_11_541379_61')
  })

  it('NR 共享小区同基站/同小区、不同 MNC → 不同键（互不视为重复）', () => {
    const telecom = cellDedupKey('NR', { siteId: '222', cellId: '1', mcc: '460', mnc: '11' })
    const unicom = cellDedupKey('NR', { siteId: '222', cellId: '1', mcc: '460', mnc: '01' })
    expect(telecom).toBe('460_11_222_1')
    expect(unicom).toBe('460_1_222_1') // '01' 归一化为 '1'
    expect(telecom).not.toBe(unicom)
  })
})
