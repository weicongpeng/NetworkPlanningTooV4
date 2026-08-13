import { describe, it, expect } from 'vitest'
import { lteFreqToEarfcn, lteEarfcnToFreq } from '../frequencyConversion'

describe('LTE EARFCN 换算', () => {
  // PDF 已验证向量
  it('B1 下行 2120MHz → EARFCN 100', () => {
    expect(lteFreqToEarfcn(1, 2120, 'DL')).toBe(100)
  })
  it('B3 下行 1870MHz → EARFCN 1850', () => {
    expect(lteFreqToEarfcn(3, 1870, 'DL')).toBe(1850)
  })
  it('B34 下行 2017.5MHz → EARFCN 36275', () => {
    expect(lteFreqToEarfcn(34, 2017.5, 'DL')).toBe(36275)
  })
  // 反向
  it('B1 EARFCN 100 → 下行 2120MHz', () => {
    expect(lteEarfcnToFreq(1, 100, 'DL')).toBe(2120)
  })
  // 上行（FDD UL offset）
  it('B1 上行 1920MHz → EARFCN 18000', () => {
    expect(lteFreqToEarfcn(1, 1920, 'UL')).toBe(18000)
  })
  it('B3 上行 1710MHz → EARFCN 19200', () => {
    expect(lteFreqToEarfcn(3, 1710, 'UL')).toBe(19200)
  })
  // 往返一致性
  it('EARFCN↔频率 往返一致', () => {
    expect(lteEarfcnToFreq(3, lteFreqToEarfcn(3, 1845, 'DL')!, 'DL')).toBe(1845)
  })
  // 非法输入
  it('非法频段返回 null', () => {
    expect(lteFreqToEarfcn(99, 2120, 'DL')).toBeNull()
  })
  it('越界频率返回 null（B1 DL 低于 2110）', () => {
    expect(lteFreqToEarfcn(1, 2000, 'DL')).toBeNull()
  })
  it('负数 EARFCN 返回 null', () => {
    expect(lteEarfcnToFreq(1, -5, 'DL')).toBeNull()
  })
})
