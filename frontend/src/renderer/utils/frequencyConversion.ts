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
