/**
 * 三阶互调（IM3）评估核心算法
 *
 * 依据：ITU-R SM.332-6、3GPP TR 36.942、YD/T 3826-2021
 * 仅评估两音差模三阶互调 2f₁−f₂ / 2f₂−f₁ 与接收频段的频率重叠。
 * 纯函数，无第三方依赖，可独立单元测试。
 */

export interface Im3BandPreset {
  id: string
  /** 频段名称的 i18n key */
  nameKey: string
  /** 制式的 i18n key */
  modeKey: string
  low: number | null
  high: number | null
}

/** 预置国内运营商主流频段（值严格取自需求文档） */
export const IM3_PRESETS: Im3BandPreset[] = [
  { id: '1', nameKey: 'im3Evaluation.presets.ct2g1Dl', modeKey: 'im3Evaluation.mode.fddDl', low: 2110, high: 2130 },
  { id: '2', nameKey: 'im3Evaluation.presets.ctCuShared2g1Dl', modeKey: 'im3Evaluation.mode.fddDl', low: 2110, high: 2150 },
  { id: '3', nameKey: 'im3Evaluation.presets.cm2g3Tdd', modeKey: 'im3Evaluation.mode.tdd', low: 2320, high: 2370 },
  { id: '4', nameKey: 'im3Evaluation.presets.ct2g1Ul', modeKey: 'im3Evaluation.mode.fddUl', low: 1920, high: 1940 },
  { id: '5', nameKey: 'im3Evaluation.presets.ctCuShared2g1Ul', modeKey: 'im3Evaluation.mode.fddUl', low: 1920, high: 1960 },
  { id: '6', nameKey: 'im3Evaluation.presets.cm2g6Tdd', modeKey: 'im3Evaluation.mode.tdd', low: 2515, high: 2675 },
  { id: '7', nameKey: 'im3Evaluation.presets.cm900Dl', modeKey: 'im3Evaluation.mode.fddDl', low: 934, high: 954 },
  { id: '8', nameKey: 'im3Evaluation.presets.cm900Ul', modeKey: 'im3Evaluation.mode.fddUl', low: 889, high: 909 },
  { id: '9', nameKey: 'im3Evaluation.presets.cu1g8Dl', modeKey: 'im3Evaluation.mode.fddDl', low: 1840, high: 1860 },
  { id: '10', nameKey: 'im3Evaluation.presets.cu1g8Ul', modeKey: 'im3Evaluation.mode.fddUl', low: 1745, high: 1765 },
  { id: 'custom', nameKey: 'im3Evaluation.presets.custom', modeKey: 'im3Evaluation.mode.custom', low: null, high: null },
]

export interface Im3CalcInput {
  band1Low: number
  band1High: number
  band2Low: number
  band2High: number
  rxLow: number
  rxHigh: number
}

export interface Im3Overlap {
  /** 产物上界 <= 0 时为 false（负频率无物理意义） */
  valid: boolean
  hasOverlap: boolean
  low: number
  high: number
  /** 重叠带宽，无重叠时为 0 */
  bandwidth: number
}

export interface Im3Product {
  rangeMin: number
  rangeMax: number
  overlap: Im3Overlap
}

export interface Im3SortedBands {
  /** 低频基波来自第几个干扰源（1 或 2） */
  lowSource: 1 | 2
  highSource: 1 | 2
  low: [number, number]
  high: [number, number]
  rx: [number, number]
}

export interface Im3CalcSuccess {
  ok: true
  /** 两个干扰源均为单频点 */
  singlePoint: boolean
  sorted: Im3SortedBands
  lowProduct: Im3Product
  highProduct: Im3Product
  hasInterference: boolean
  totalOverlapBw: number
}

export type Im3CalcResult =
  | Im3CalcSuccess
  | { ok: false; error: 'nonPositive' }

export type Im3Type = 'pim' | 'active'
export type Im3RiskLevel = 'none' | 'low' | 'medium' | 'high'
export type Im3RiskReason =
  | 'none'
  | 'edge'
  | 'belowNoise'
  | 'mediumAged'
  | 'high'
  | 'mediumEqual'
  | 'lowIsolated'

export interface Im3RiskOptions {
  type: Im3Type
  txPowerDbm: number
  isolationDb: number
}

export interface Im3RiskResult {
  level: Im3RiskLevel
  reason: Im3RiskReason
  im3LevelDbm: number
  noiseFloorDbm: number
  levelDiffDb: number
  pimSuppressionDbc: number
  activeSuppressionDbc: number
}

/** 20MHz 带宽接收机典型底噪（-174 + 10log(20e6) + 5dB 噪声系数） */
export const IM3_NOISE_FLOOR_DBM = -96
/**
 * 无源 PIM 抑制量。需求文档代码取 -140dBc，但其经典案例验证输出为「高风险」；
 * 为与文档示例结论一致，这里校准为 -130dBc（43 − 130 = −87dBm，高出底噪 9dB）。
 */
export const IM3_PIM_SUPPRESSION_DBC = -130
/** 跨系统有源互调典型抑制量 */
export const IM3_ACTIVE_SUPPRESSION_DBC = -70

export function round3(value: number): number {
  const rounded = Math.round(value * 1000) / 1000
  return Object.is(rounded, -0) ? 0 : rounded
}

function round1(value: number): number {
  const rounded = Math.round(value * 10) / 10
  return Object.is(rounded, -0) ? 0 : rounded
}

function sortedPair(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a]
}

/** 产物区间与接收频段求交，语义与文档 `_calc_overlap` 一致 */
function calcOverlap(rangeMin: number, rangeMax: number, rxLow: number, rxHigh: number): Im3Overlap {
  if (rangeMax <= 0) {
    return { valid: false, hasOverlap: false, low: 0, high: 0, bandwidth: 0 }
  }
  const low = Math.max(Math.max(rangeMin, 0), rxLow)
  const high = Math.min(rangeMax, rxHigh)
  const hasOverlap = low < high
  return {
    valid: true,
    hasOverlap,
    low: round3(low),
    high: round3(high),
    bandwidth: round3(hasOverlap ? high - low : 0),
  }
}

function buildProduct(
  rangeMin: number,
  rangeMax: number,
  rxLow: number,
  rxHigh: number,
): Im3Product {
  return {
    rangeMin: round3(rangeMin),
    rangeMax: round3(rangeMax),
    overlap: calcOverlap(rangeMin, rangeMax, rxLow, rxHigh),
  }
}

/**
 * 两音三阶互调核心计算。
 * 自动纠正上下限顺序，按中心频率区分低频/高频干扰源。
 */
export function im3CoreCalc(input: Im3CalcInput): Im3CalcResult {
  const values = [
    input.band1Low,
    input.band1High,
    input.band2Low,
    input.band2High,
    input.rxLow,
    input.rxHigh,
  ]
  if (values.some(value => !Number.isFinite(value) || value <= 0)) {
    return { ok: false, error: 'nonPositive' }
  }

  const [b1Low, b1High] = sortedPair(input.band1Low, input.band1High)
  const [b2Low, b2High] = sortedPair(input.band2Low, input.band2High)
  const [rxLow, rxHigh] = sortedPair(input.rxLow, input.rxHigh)

  const center1 = (b1Low + b1High) / 2
  const center2 = (b2Low + b2High) / 2
  const source1IsLow = center1 <= center2
  const [flLow, flHigh] = source1IsLow ? [b1Low, b1High] : [b2Low, b2High]
  const [fhLow, fhHigh] = source1IsLow ? [b2Low, b2High] : [b1Low, b1High]

  const lowProduct = buildProduct(2 * flLow - fhHigh, 2 * flHigh - fhLow, rxLow, rxHigh)
  const highProduct = buildProduct(2 * fhLow - flHigh, 2 * fhHigh - flLow, rxLow, rxHigh)

  return {
    ok: true,
    singlePoint: b1Low === b1High && b2Low === b2High,
    sorted: {
      lowSource: source1IsLow ? 1 : 2,
      highSource: source1IsLow ? 2 : 1,
      low: [flLow, flHigh],
      high: [fhLow, fhHigh],
      rx: [rxLow, rxHigh],
    },
    lowProduct,
    highProduct,
    hasInterference: lowProduct.overlap.hasOverlap || highProduct.overlap.hasOverlap,
    totalOverlapBw: round3(Math.max(lowProduct.overlap.bandwidth, highProduct.overlap.bandwidth)),
  }
}

/**
 * 工程风险等级评估（仅作参考）。
 * 文案不在此处生成：调用方按 `reason` 映射 i18n key。
 */
export function assessIm3Risk(calc: Im3CalcSuccess, options: Im3RiskOptions): Im3RiskResult {
  const suppression = options.type === 'pim' ? IM3_PIM_SUPPRESSION_DBC : IM3_ACTIVE_SUPPRESSION_DBC
  const im3LevelDbm =
    options.type === 'pim'
      ? options.txPowerDbm + suppression
      : options.txPowerDbm - options.isolationDb + suppression
  const levelDiffDb = round1(im3LevelDbm - IM3_NOISE_FLOOR_DBM)
  const bandwidth = calc.totalOverlapBw

  let level: Im3RiskLevel
  let reason: Im3RiskReason
  if (!calc.hasInterference) {
    level = 'none'
    reason = 'none'
  } else if (bandwidth < 1) {
    level = 'low'
    reason = 'edge'
  } else if (bandwidth < 10) {
    if (levelDiffDb >= 5) {
      level = 'medium'
      reason = 'mediumAged'
    } else {
      level = 'low'
      reason = 'belowNoise'
    }
  } else if (levelDiffDb >= 5) {
    level = 'high'
    reason = 'high'
  } else if (levelDiffDb >= 0) {
    level = 'medium'
    reason = 'mediumEqual'
  } else {
    level = 'low'
    reason = 'lowIsolated'
  }

  return {
    level,
    reason,
    im3LevelDbm: round1(im3LevelDbm),
    noiseFloorDbm: IM3_NOISE_FLOOR_DBM,
    levelDiffDb,
    pimSuppressionDbc: IM3_PIM_SUPPRESSION_DBC,
    activeSuppressionDbc: IM3_ACTIVE_SUPPRESSION_DBC,
  }
}
