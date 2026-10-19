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
  /** 下行频点号上界 N_DL_max（3GPP TS 36.101 Table 5.7.3-1） */
  nDlMax: number
}

export const LTE_BANDS: LteBand[] = [
  { band: 1, type: 'FDD', dlLow: 2110, dlOffset: 0, ulLow: 1920, ulOffset: 18000, nDlMax: 599 },
  { band: 3, type: 'FDD', dlLow: 1805, dlOffset: 1200, ulLow: 1710, ulOffset: 19200, nDlMax: 1949 },
  { band: 5, type: 'FDD', dlLow: 869, dlOffset: 2400, ulLow: 824, ulOffset: 20400, nDlMax: 2649 },
  { band: 8, type: 'FDD', dlLow: 925, dlOffset: 3450, ulLow: 880, ulOffset: 21450, nDlMax: 3799 },
  { band: 34, type: 'TDD', dlLow: 2010, dlOffset: 36200, ulLow: 2010, ulOffset: 36200, nDlMax: 36349 },
  { band: 38, type: 'TDD', dlLow: 2570, dlOffset: 37750, ulLow: 2570, ulOffset: 37750, nDlMax: 38249 },
  { band: 39, type: 'TDD', dlLow: 1880, dlOffset: 38250, ulLow: 1880, ulOffset: 38250, nDlMax: 38649 },
  { band: 40, type: 'TDD', dlLow: 2300, dlOffset: 38650, ulLow: 2300, ulOffset: 38650, nDlMax: 39649 },
  { band: 41, type: 'TDD', dlLow: 2496, dlOffset: 39650, ulLow: 2496, ulOffset: 39650, nDlMax: 41589 },
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

/** LTE 一键换算结果：上行/下行频率 + 下行/上行频点号 */
export interface LteConvertResult {
  fUl: number // 上行频率 MHz
  fDl: number // 下行频率 MHz
  nDl: number // 下行频点号 EARFCN
  nUl: number // 上行频点号 EARFCN
}

/** 输入类型：上行频率 / 下行频率 / 下行频点号，三选一 */
export type LteConvertInput =
  | { fUl: number }
  | { fDl: number }
  | { nDl: number }

/**
 * LTE 一键换算（参照「频点换算方法.pdf」推导，基于 3GPP TS 36.101）：
 *   N_DL = (F_DL − F_DL_low)×10 + N_Offs_DL
 *   N_UL = (F_UL − F_UL_low)×10 + N_Offs_UL
 *   F_DL = F_DL_low + 0.1×(N_DL − N_Offs_DL)
 *   F_UL = F_DL − 双工间隔（F_DL_low − F_UL_low；TDD 为 0）
 *   N_UL = N_DL + (N_Offs_UL − N_Offs_DL)（FDD 统一为 18000，TDD 为 0）
 * 输入上行频率 / 下行频率 / 下行频点号任一，校验范围后返回其余三个量；非法或超范围返回 null。
 */
export function lteConvert(band: number, input: LteConvertInput): LteConvertResult | null {
  const b = findLteBand(band)
  if (!b) return null
  // 双工间隔（FDD: F_DL_low − F_UL_low；TDD: 0）
  const duplex = b.dlLow - b.ulLow
  // 有效带宽：频率上界 = F_low + (N_DL_max − N_Offs_DL)×0.1
  const dlHigh = b.dlLow + (b.nDlMax - b.dlOffset) * 0.1
  const ulHigh = b.ulLow + (b.nDlMax - b.dlOffset) * 0.1

  let nDl: number
  if ('fUl' in input) {
    if (!Number.isFinite(input.fUl)) return null
    // F_UL 必须落在 UL 有效范围内
    if (input.fUl < b.ulLow || input.fUl > ulHigh) return null
    const fDl = input.fUl + duplex
    // 上行→下行（0.1MHz 栅格对齐）
    if (Math.abs(fDl - Math.round(fDl * 10) / 10) > 1e-6) return null
    nDl = Math.round((fDl - b.dlLow) * 10 + b.dlOffset)
  } else if ('fDl' in input) {
    if (!Number.isFinite(input.fDl)) return null
    if (input.fDl < b.dlLow || input.fDl > dlHigh) return null
    nDl = Math.round((input.fDl - b.dlLow) * 10 + b.dlOffset)
  } else {
    if (!Number.isInteger(input.nDl)) return null
    if (input.nDl < b.dlOffset || input.nDl > b.nDlMax) return null
    nDl = input.nDl
  }

  // 反推下行频率
  const fDl = b.dlLow + 0.1 * (nDl - b.dlOffset)
  const fUl = fDl - duplex
  const nUl = nDl + (b.ulOffset - b.dlOffset)
  return { fUl, fDl, nDl, nUl }
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

/**
 * 校验频率落在哪个常用 NR 频段。
 * 交叠区（如 n77 3300-4200 与 n78 3300-3800 的重叠部分）优先匹配带宽最窄的频段——
 * 即频率同时落在多个频段时返回最精确（带宽最小）的那个，如 3408.96MHz 返回 n78 而非 n77。
 */
export function matchNrBand(freqMhz: number): NrBand | null {
  const matched = NR_BANDS.filter(b => freqMhz >= b.dlLow && freqMhz <= b.dlHigh)
  if (matched.length === 0) return null
  return matched.reduce((a, b) => (b.dlHigh - b.dlLow) < (a.dlHigh - a.dlLow) ? b : a)
}

// ==================== GSCN ====================

/**
 * GSCN 三段全局同步栅格（3GPP TS 38.104 Table 5.4.3.1-1）
 *
 * 区间1（0-3000MHz，非均匀栅格）：
 *   SS_REF = N×1200kHz + M×50kHz，N=1..2499，M∈{1,3,5}
 *   GSCN = 3N + (M-3)/2，范围 2~7498（N=1,M=1 → GSCN 2；N=2499,M=5 → GSCN 7498）
 *   注：仓库内「GSCN和频点换算方法.docx」在区间1 写作 3(N-1)+(M-3)/2+1，比标准少 2，
 *   且由此臆造出 7498 空洞；此处以 TS 38.104 为准。
 * 区间2（3000-24250MHz，连续整数 GSCN，步长 1.44MHz）：
 *   SS_REF = 3000 + (GSCN-7499)×1.44，GSCN 范围 7499~22255
 *   GSCN = 7499 + int((F-3000)/1.44)
 * 区间3（24250-100000MHz，连续整数 GSCN，步长 17.28MHz）：
 *   SS_REF = 24250.08 + (GSCN-22256)×17.28，GSCN 范围 22256~26639
 *   GSCN = 22256 + int((F-24250.08)/17.28)
 */

/** 区间1 反推：GSCN(2~7498) → { N, M }。GSCN 对 3 取余决定 M 分支。 */
function gsnRange1ToNM(gscn: number): { n: number; m: number } | null {
  // GSCN = 3N + (M-3)/2，M∈{1,3,5}
  // 设 x=(M-3)/2 ∈ {-1,0,1} → GSCN = 3N + x → N = (GSCN - x)/3
  // 由 GSCN mod 3 定 x：GSCN≡2→x=-1(M=1)，GSCN≡0→x=0(M=3)，GSCN≡1→x=1(M=5)
  const r = gscn % 3
  let x: number, m: number
  if (r === 2) { x = -1; m = 1 }
  else if (r === 0) { x = 0; m = 3 }
  else { x = 1; m = 5 }
  const n = (gscn - x) / 3
  if (!Number.isInteger(n) || n < 1 || n > 2499) return null
  return { n, m }
}

/** 频率 → 最近 GSCN（区间1 非均匀栅格，遍历附近 N 的三个 M 点取最小偏差） */
function gsnFreqToGscnRange1(freqMhz: number): { gscn: number; actualFreq: number; deviationKHz: number } | null {
  const fKhz = freqMhz * 1000
  const n0 = Math.round(fKhz / 1200)
  let best: { gscn: number; actualFreq: number; deviationKHz: number } | null = null
  for (let n = Math.max(1, n0 - 1); n <= Math.min(2499, n0 + 1); n++) {
    for (const m of [1, 3, 5]) {
      const ssRefKhz = n * 1200 + m * 50
      const actualFreq = ssRefKhz / 1000
      const deviationKHz = Math.round(Math.abs(actualFreq - freqMhz) * 1000)
      if (!best || deviationKHz < best.deviationKHz) {
        best = { gscn: 3 * n + (m - 3) / 2, actualFreq, deviationKHz }
      }
    }
  }
  return best
}

/** 频率 → GSCN（三段自动路由），返回 GSCN、实际 SS_REF 频率与偏差。区间2/3 用整数 kHz 运算避免浮点误差 */
export function gsnFreqToGscn(freqMhz: number): { gscn: number; actualFreq: number; deviationKHz: number } | null {
  if (!Number.isFinite(freqMhz) || freqMhz < 0 || freqMhz > 100000) return null
  const freqKhz = Math.round(freqMhz * 1000)
  // 3000MHz 整点是区间2 的起点（GSCN 7499），归区间2，否则该 GSCN 无法由频率反推得到
  if (freqMhz < 3000) return gsnFreqToGscnRange1(freqMhz)
  if (freqMhz <= 24250) {
    // 步长 1.44MHz = 1440kHz
    const gscn = 7499 + Math.floor((freqKhz - 3000000) / 1440)
    if (gscn < 7499 || gscn > 22255) return null
    const actualFreq = (3000000 + (gscn - 7499) * 1440) / 1000
    return { gscn, actualFreq, deviationKHz: Math.round(Math.abs(actualFreq - freqMhz) * 1000) }
  }
  // 步长 17.28MHz = 17280kHz
  const gscn = 22256 + Math.floor((freqKhz - 24250080) / 17280)
  if (gscn < 22256 || gscn > 26639) return null
  const actualFreq = (24250080 + (gscn - 22256) * 17280) / 1000
  return { gscn, actualFreq, deviationKHz: Math.round(Math.abs(actualFreq - freqMhz) * 1000) }
}

/** GSCN → SS_REF 频率（三段自动路由）；非法 GSCN 返回 null。区间2/3 用整数 kHz 运算 */
export function gsnGscnToFreq(gscn: number): { freqMhz: number } | null {
  if (!Number.isInteger(gscn) || gscn < 2) return null
  if (gscn <= 7498) {
    const nm = gsnRange1ToNM(gscn)
    if (!nm) return null
    return { freqMhz: (nm.n * 1200 + nm.m * 50) / 1000 }
  }
  if (gscn <= 22255) return { freqMhz: (3000000 + (gscn - 7499) * 1440) / 1000 }
  if (gscn <= 26639) return { freqMhz: (24250080 + (gscn - 22256) * 17280) / 1000 }
  return null
}

// ==================== 频段可用 GSCN 范围 ====================

/**
 * 各频段的可用 GSCN 范围（TS 38.104 §5.4.3.1 同步栅格，取值范围按频段给定）
 *
 * 判据：SS_REF 落在该频段下行频率区间内。例如 n28 下行 758–803MHz →
 * GSCN 1895(758.45MHz) 为首个、2007(802.95MHz) 为末个；1894(757.45MHz) 与 2008(803.05MHz) 均已出带。
 *
 * 只收录已确认范围的频段：未收录的频段不参与判定（宁可不提示，不可误报）。
 * 新频段补齐后在此追加，并在测试的「范围端点与频段下行频率区间一致」用例中加对应断言。
 */
export interface NrBandGscnRange {
  band: string
  gscnMin: number
  gscnMax: number
}

export const NR_BAND_GSCN_RANGES: NrBandGscnRange[] = [
  { band: 'n28', gscnMin: 1895, gscnMax: 2007 },
  { band: 'n41', gscnMin: 6239, gscnMax: 6724 },
]

/** 取频段可用 GSCN 范围；未收录该频段时返回 null */
export function getBandGscnRange(band: string): NrBandGscnRange | null {
  return NR_BAND_GSCN_RANGES.find(r => r.band === band) ?? null
}

/** GSCN 越界信息：该 GSCN 不在所属频段可用范围内 */
export interface GscnBandViolation {
  band: string
  gscnMin: number
  gscnMax: number
  /** 该频段内离输入 GSCN 最近的合法 GSCN */
  nearestInBand: number
  nearestInBandFreqMhz: number
}

/**
 * 校验 GSCN 是否落在所属频段的可用范围内，越界则返回带内最近点供提示。
 *
 * band 由频率匹配（matchNrBand）得出；未匹配到频段、或该频段未收录范围时一律返回 null——
 * 频率→GSCN 取的是全局最近栅格点，在频段边界会落到带外（如 n41 上边界 2690MHz → GSCN 6725 @2690.45MHz，
 * 而 n41 止于 6724），此函数用于把这种情况显式暴露出来，不改写换算结果。
 */
export function findGscnBandViolation(
  gscn: number,
  band: string | null | undefined
): GscnBandViolation | null {
  if (!band || !Number.isInteger(gscn)) return null
  const range = getBandGscnRange(band)
  if (!range) return null
  if (gscn >= range.gscnMin && gscn <= range.gscnMax) return null
  const nearestInBand = Math.min(Math.max(gscn, range.gscnMin), range.gscnMax)
  const freq = gsnGscnToFreq(nearestInBand)
  if (!freq) return null
  return {
    band: range.band,
    gscnMin: range.gscnMin,
    gscnMax: range.gscnMax,
    nearestInBand,
    nearestInBandFreqMhz: freq.freqMhz,
  }
}

// ==================== GSCN ↔ ARFCN ====================

/**
 * GSCN → NR-ARFCN：GSCN 标识 SS_REF（SSB 频域位置），换算为该频率对应的全局栅格频点。
 * SS_REF → F_REF(MHz) → N_REF = N_REF_Offs + (F_REF - F_REF_Offs)/ΔF_Global
 */
export function gscnToArfcn(gscn: number): number | null {
  const r = gsnGscnToFreq(gscn)
  if (!r) return null
  return nrFreqToArfcn(r.freqMhz)
}

/**
 * NR-ARFCN → 最近 GSCN：先转频率，再取最近同步栅格点。
 * 注意：ARFCN 频率不一定恰好落在同步栅格上，结果取最近 GSCN（有偏差提示需求时用 gsnFreqToGscn）。
 */
export function arfcnToGscn(arfcn: number): number | null {
  const freq = nrArfcnToFreq(arfcn)
  if (freq === null) return null
  const r = gsnFreqToGscn(freq)
  return r ? r.gscn : null
}
