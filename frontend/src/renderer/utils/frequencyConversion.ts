/**
 * LTE / NR 频点与频率换算工具
 *
 * 数据与公式来源：
 * - LTE: 3GPP TS 36.101 Table 5.7.3-1（国内常用 9 频段，数据来自「频点换算方法.pdf」）
 * - NR-ARFCN: 3GPP TS 38.104（全局三段栅格，不依赖 Band、不分方向）
 * - GSCN: 3GPP TS 38.104 Table 5.4.3.1-1（全局同步栅格）
 */

// ==================== LTE ====================

export interface LteBand {
  band: number
  type: 'FDD' | 'TDD'
  dlLow: number
  dlOffset: number
  ulLow: number
  ulOffset: number
}

export const LTE_BANDS: LteBand[] = [
  { band: 1, type: 'FDD', dlLow: 2110, dlOffset: 0, ulLow: 1920, ulOffset: 18000 },
  { band: 3, type: 'FDD', dlLow: 1805, dlOffset: 1200, ulLow: 1710, ulOffset: 19200 },
  { band: 5, type: 'FDD', dlLow: 869, dlOffset: 2400, ulLow: 824, ulOffset: 20400 },
  { band: 8, type: 'FDD', dlLow: 925, dlOffset: 3450, ulLow: 880, ulOffset: 21450 },
  { band: 34, type: 'TDD', dlLow: 2010, dlOffset: 36200, ulLow: 2010, ulOffset: 36200 },
  { band: 38, type: 'TDD', dlLow: 2570, dlOffset: 37750, ulLow: 2570, ulOffset: 37750 },
  { band: 39, type: 'TDD', dlLow: 1880, dlOffset: 38250, ulLow: 1880, ulOffset: 38250 },
  { band: 40, type: 'TDD', dlLow: 2300, dlOffset: 38650, ulLow: 2300, ulOffset: 38650 },
  { band: 41, type: 'TDD', dlLow: 2496, dlOffset: 39650, ulLow: 2496, ulOffset: 39650 },
]

export type LteDirection = 'DL' | 'UL'

function findLteBand(band: number): LteBand | undefined {
  return LTE_BANDS.find(b => b.band === band)
}

/**
 * EARFCN = N_off + (F - F_low) / 0.1
 * 校验：频率落在该方向 [F_low, F_low + 2000] 有效带宽内，且 EARFCN 为非负整数。
 */
export function lteFreqToEarfcn(band: number, freqMhz: number, direction: LteDirection): number | null {
  const b = findLteBand(band)
  if (!b) return null
  const fLow = direction === 'DL' ? b.dlLow : b.ulLow
  const nOff = direction === 'DL' ? b.dlOffset : b.ulOffset
  if (!Number.isFinite(freqMhz)) return null
  // 有效带宽校验：频率需落在 [fLow, fLow + 2000) 区间
  if (freqMhz < fLow || freqMhz >= fLow + 2000) return null
  const earfcn = nOff + (freqMhz - fLow) / 0.1
  return Math.round(earfcn)
}

/** F = F_low + 0.1 × (N - N_off)；EARFCN 需为非负整数且落在该方向有效范围内 */
export function lteEarfcnToFreq(band: number, earfcn: number, direction: LteDirection): number | null {
  const b = findLteBand(band)
  if (!b) return null
  if (!Number.isInteger(earfcn) || earfcn < 0) return null
  const fLow = direction === 'DL' ? b.dlLow : b.ulLow
  const nOff = direction === 'DL' ? b.dlOffset : b.ulOffset
  const freq = fLow + 0.1 * (earfcn - nOff)
  // 有效范围校验
  if (freq < fLow || freq >= fLow + 2000) return null
  return freq
}

export function getLteBandTable(): LteBand[] {
  return LTE_BANDS
}

// ==================== NR-ARFCN ====================

/**
 * NR-ARFCN 全局三段栅格（3GPP TS 38.104，不依赖 Band、不分方向）
 * 0-3000MHz: 5kHz；3000-24250MHz: 15kHz；24250-100000MHz: 60kHz
 */
export function nrFreqToArfcn(freqMhz: number): number | null {
  if (!Number.isFinite(freqMhz) || freqMhz < 0 || freqMhz > 100000) return null
  if (freqMhz <= 3000) return Math.round(freqMhz * 200)
  if (freqMhz <= 24250) return Math.round(600000 + ((freqMhz - 3000) * 1000) / 15)
  return Math.round(2016667 + ((freqMhz - 24250.08) * 1000) / 60)
}

export function nrArfcnToFreq(arfcn: number): number | null {
  if (!Number.isInteger(arfcn) || arfcn < 0) return null
  if (arfcn <= 599999) return (arfcn * 5) / 1000
  if (arfcn <= 2016666) return 3000 + ((arfcn - 600000) * 15) / 1000
  if (arfcn <= 3279165) return 24250.08 + ((arfcn - 2016667) * 60) / 1000
  return null
}

/** NR 常用频段表（用于 ARFCN 换算结果附注「落在哪个 5G 频段」） */
export interface NrBand {
  band: string
  dlLow: number
  dlHigh: number
  type: 'FDD' | 'TDD'
}

export const NR_BANDS: NrBand[] = [
  { band: 'n1', dlLow: 2110, dlHigh: 2170, type: 'FDD' },
  { band: 'n3', dlLow: 1805, dlHigh: 1880, type: 'FDD' },
  { band: 'n5', dlLow: 869, dlHigh: 894, type: 'FDD' },
  { band: 'n8', dlLow: 925, dlHigh: 960, type: 'FDD' },
  { band: 'n28', dlLow: 758, dlHigh: 803, type: 'FDD' },
  { band: 'n41', dlLow: 2496, dlHigh: 2690, type: 'TDD' },
  { band: 'n77', dlLow: 3300, dlHigh: 4200, type: 'TDD' },
  { band: 'n78', dlLow: 3300, dlHigh: 3800, type: 'TDD' },
  { band: 'n79', dlLow: 4400, dlHigh: 5000, type: 'TDD' },
]

export function getNrBandTable(): NrBand[] {
  return NR_BANDS
}

/** 校验频率落在哪个常用 NR 频段 */
export function matchNrBand(freqMhz: number): NrBand | null {
  return NR_BANDS.find(b => freqMhz >= b.dlLow && freqMhz <= b.dlHigh) ?? null
}

// ==================== GSCN ====================

/**
 * GSCN 三段全局同步栅格（3GPP TS 38.104 Table 5.4.3.1-1）
 * 0-3000MHz: GSCN=3N, F=N×1.2；3000-24250MHz: GSCN=3N+7498, F=3000+N×1.44；
 * 24250-100000MHz: GSCN=3N+22256, F=24250.08+N×17.28
 */
export function gsnFreqToGscn(freqMhz: number): { gscn: number; actualFreq: number; deviationKHz: number } | null {
  if (!Number.isFinite(freqMhz) || freqMhz < 0 || freqMhz > 100000) return null
  let n: number, offset: number, base: number, step: number
  if (freqMhz <= 3000) { offset = 0; base = 0; step = 1.2; n = Math.round(freqMhz / 1.2) }
  else if (freqMhz <= 24250) { offset = 7498; base = 3000; step = 1.44; n = Math.round((freqMhz - 3000) / 1.44) }
  else { offset = 22256; base = 24250.08; step = 17.28; n = Math.round((freqMhz - 24250.08) / 17.28) }
  const gscn = 3 * n + offset
  const actualFreq = base + n * step
  return { gscn, actualFreq, deviationKHz: Math.round(Math.abs(actualFreq - freqMhz) * 1000) }
}

export function gsnGscnToFreq(gscn: number): { freqMhz: number } | null {
  if (!Number.isInteger(gscn) || gscn < 0) return null
  let n: number, offset: number, base: number, step: number
  if (gscn <= 7497) { offset = 0; base = 0; step = 1.2; n = gscn / 3 }
  else if (gscn <= 22255) { offset = 7498; base = 3000; step = 1.44; n = (gscn - 7498) / 3 }
  else { offset = 22256; base = 24250.08; step = 17.28; n = (gscn - 22256) / 3 }
  if (!Number.isInteger(n)) return null
  return { freqMhz: base + n * step }
}
