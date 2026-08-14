import { describe, it, expect } from 'vitest'
import {
  lteFreqToEarfcn, lteEarfcnToFreq,
  nrFreqToArfcn, nrArfcnToFreq, gsnFreqToGscn, gsnGscnToFreq, getNrBandTable,
  gscnToArfcn, arfcnToGscn, matchNrBand,
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

describe('GSCN 换算（GSCN和频点换算方法.docx / 3GPP TS 38.104）', () => {
  // ===== 区间1：0-3000MHz 非均匀栅格（N=1..2499, M∈{1,3,5}） =====
  it('区间1 示例3: N=100, M=3 → GSCN 298, SS_REF 120.15MHz', () => {
    // SS_REF = N×1200kHz + M×50kHz = 120000+150 = 120150kHz = 120.15MHz
    const r = gsnFreqToGscn(120.15)!
    expect(r.gscn).toBe(298)
    expect(r.actualFreq).toBeCloseTo(120.15, 5)
  })
  it('区间1: GSCN 298 → 120.15MHz', () => {
    expect(gsnGscnToFreq(298)!.freqMhz).toBeCloseTo(120.15, 5)
  })
  it('区间1: GSCN 1（N=1,M=3）→ 1.35MHz', () => {
    // GSCN = 3(N-1)+(M-3)/2+1，GSCN=1 时 N=1,M=3 → SS_REF = 1×1200+3×50 = 1350kHz = 1.35MHz
    expect(gsnGscnToFreq(1)!.freqMhz).toBeCloseTo(1.35, 5)
  })
  // ===== 区间2：3000-24250MHz，连续整数 GSCN 7499~22255，步长 1.44MHz =====
  it('区间2 示例1/2: GSCN 7711 → 3305.28MHz', () => {
    // SS_REF = 3000 + (7711-7499)×1.44 = 3000 + 212×1.44 = 3305.28
    expect(gsnGscnToFreq(7711)!.freqMhz).toBeCloseTo(3305.28, 5)
  })
  it('区间2 反算: 3305.28MHz → GSCN 7711', () => {
    // GSCN = 7499 + int((3305.28-3000)/1.44) = 7499 + 212 = 7711
    expect(gsnFreqToGscn(3305.28)!.gscn).toBe(7711)
  })
  it('区间2 起点: GSCN 7499 → 3000MHz', () => {
    expect(gsnGscnToFreq(7499)!.freqMhz).toBe(3000)
  })
  it('区间2 n78 频段: 3300MHz → 最近 GSCN 7711 (3305.28MHz)', () => {
    // GSCN = 7499 + int((3300-3000)/1.44) = 7499 + int(208.33) = 7499+208 = 7707 → SS_REF=3299.52
    // 但 3300 与 3299.52 偏差 0.48，与 3305.28 偏差 5.28 → 最近是 7707 (3299.52MHz)
    const r = gsnFreqToGscn(3300)!
    expect(r.gscn).toBe(7707)
    expect(r.actualFreq).toBeCloseTo(3299.52, 5)
  })
  // ===== 区间3：24250-100000MHz，连续整数 GSCN 22256~26639，步长 17.28MHz =====
  it('区间3 起点: GSCN 22256 → 24250.08MHz', () => {
    expect(gsnGscnToFreq(22256)!.freqMhz).toBeCloseTo(24250.08, 5)
  })
  it('区间3: 30000MHz → 最近 GSCN', () => {
    // GSCN = 22256 + int((30000-24250.08)/17.28) = 22256 + int(332.75) = 22256+332 = 22588
    // SS_REF = 24250.08 + 332×17.28 = 24250.08 + 5736.96 = 29987.04
    const r = gsnFreqToGscn(30000)!
    expect(r.gscn).toBe(22588)
    expect(r.actualFreq).toBeCloseTo(29987.04, 5)
  })
  // ===== 非法输入 =====
  it('非法 GSCN 返回 null', () => {
    expect(gsnGscnToFreq(-1)).toBeNull()
    expect(gsnGscnToFreq(7498)).toBeNull() // 7498 是区间1与区间2之间的空洞
    expect(gsnGscnToFreq(22256 + 100000)).toBeNull()
    expect(gsnFreqToGscn(150000)).toBeNull()
  })
})

describe('GSCN ↔ ARFCN 换算', () => {
  it('GSCN 7711 → ARFCN（SS_REF 3305.28MHz → ARFCN）', () => {
    // 3305.28MHz 在 3-24.25GHz 段: ARFCN = 600000 + (3305.28-3000)×1000/15 = 600000+20352 = 620352
    const a = gscnToArfcn(7711)
    expect(a).toBe(620352)
  })
  it('ARFCN 620352 → 最近 GSCN 7711', () => {
    // 620352 → 3000+(620352-600000)×15/1000 = 3000+305.28 = 3305.28MHz → GSCN 7711
    expect(arfcnToGscn(620352)).toBe(7711)
  })
  it('ARFCN→GSCN→ARFCN 往返一致', () => {
    const a = 620352
    expect(gscnToArfcn(arfcnToGscn(a)!)!).toBe(a)
  })
  it('非法 ARFCN → null', () => {
    expect(arfcnToGscn(-1)).toBeNull()
    expect(gscnToArfcn(7498)).toBeNull()
  })
})

describe('NR 频段表', () => {
  it('返回常用 NR 频段表（含 n78/n41）', () => {
    const bands = getNrBandTable()
    expect(bands.some(b => b.band === 'n78')).toBe(true)
    expect(bands.some(b => b.band === 'n41')).toBe(true)
  })
})

describe('NR 频段校验（交叠区优先窄频段）', () => {
  it('3408.96MHz → n78（n77∩n78 交叠区，窄频段优先）', () => {
    expect(matchNrBand(3408.96)!.band).toBe('n78')
  })
  it('3509.76MHz → n78', () => {
    expect(matchNrBand(3509.76)!.band).toBe('n78')
  })
  it('3309.6MHz → n78', () => {
    expect(matchNrBand(3309.6)!.band).toBe('n78')
  })
  it('4000MHz → n77（超出 n78 上界 3800，仅 n77）', () => {
    expect(matchNrBand(4000)!.band).toBe('n77')
  })
  it('4550MHz → n79', () => {
    expect(matchNrBand(4550)!.band).toBe('n79')
  })
  it('无匹配（如 2800MHz）→ null', () => {
    expect(matchNrBand(2800)).toBeNull()
  })
})
