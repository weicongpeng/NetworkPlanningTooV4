import { describe, it, expect } from 'vitest'
import {
  lteFreqToEarfcn, lteEarfcnToFreq,
  nrFreqToArfcn, nrArfcnToFreq, gsnFreqToGscn, gsnGscnToFreq, getNrBandTable,
} from '../frequencyConversion'

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

describe('NR-ARFCN 换算（全局三段公式）', () => {
  it('N1 2114.45MHz → 422890 (0-3GHz 5kHz 栅格)', () => {
    expect(nrFreqToArfcn(2114.45)).toBe(422890)
  })
  it('N41 2524.95MHz → 504990', () => {
    expect(nrFreqToArfcn(2524.95)).toBe(504990)
  })
  it('422890 → 2114.45MHz', () => {
    expect(nrArfcnToFreq(422890)).toBeCloseTo(2114.45, 5)
  })
  it('504990 → 2524.95MHz', () => {
    expect(nrArfcnToFreq(504990)).toBeCloseTo(2524.95, 5)
  })
  it('3GHz 边界 → 600000', () => {
    expect(nrFreqToArfcn(3000)).toBe(600000)
  })
  it('>24.25GHz 段（24250.08 → 2016667）', () => {
    expect(nrFreqToArfcn(24250.08)).toBe(2016667)
  })
  it('超范围频率返回 null', () => {
    expect(nrFreqToArfcn(-5)).toBeNull()
    expect(nrFreqToArfcn(100001)).toBeNull()
  })
  it('超范围 ARFCN 返回 null', () => {
    expect(nrArfcnToFreq(9999999)).toBeNull()
  })
  it('往返一致', () => {
    const f = 3450.15
    expect(nrArfcnToFreq(nrFreqToArfcn(f)!)!).toBeCloseTo(f, 5)
  })
})

describe('GSCN 换算（3GPP TS 38.104 全局同步栅格）', () => {
  it('0-3000MHz: 1.2MHz 栅格 3000MHz → GSCN 7500', () => {
    expect(gsnFreqToGscn(3000)!.gscn).toBe(7500)
  })
  it('3000MHz 边界 GSCN 7498 → 3000MHz（第二段 n=0）', () => {
    expect(gsnGscnToFreq(7498)!.freqMhz).toBe(3000)
  })
  it('3000-24250MHz: 1.44MHz 栅格 3300MHz → 最近栅格', () => {
    const r = gsnFreqToGscn(3300)!
    expect(r.gscn).toBe(8122)
    expect(r.actualFreq).toBeCloseTo(3299.52, 5)
  })
  it('24250-100000MHz: 17.28MHz 栅格 30000MHz → 最近栅格', () => {
    const r = gsnFreqToGscn(30000)!
    expect(r.gscn).toBe(23255)
  })
  it('GSCN 22457 → 24250.08MHz 起点（N=67）', () => {
    expect(gsnGscnToFreq(22457)!.freqMhz).toBeCloseTo(24250.08 + 67 * 17.28, 5)
  })
  it('非法 GSCN 返回 null', () => {
    expect(gsnGscnToFreq(-1)).toBeNull()
    expect(gsnFreqToGscn(150000)).toBeNull()
  })
})

describe('NR 频段表', () => {
  it('返回常用 NR 频段表（含 n78/n41）', () => {
    const bands = getNrBandTable()
    expect(bands.some(b => b.band === 'n78')).toBe(true)
    expect(bands.some(b => b.band === 'n41')).toBe(true)
  })
})
