import { describe, it, expect } from 'vitest'
import {
  IM3_PRESETS,
  assessIm3Risk,
  im3CoreCalc,
  type Im3CalcResult,
  type Im3CalcSuccess,
  type Im3RiskOptions,
} from '../intermodulation'

function expectOk(result: Im3CalcResult): Im3CalcSuccess {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected a successful calculation')
  return result
}

const PIM_DEFAULT: Im3RiskOptions = { type: 'pim', txPowerDbm: 43, isolationDb: 20 }

const CLASSIC = {
  band1Low: 2110,
  band1High: 2125,
  band2Low: 2300,
  band2High: 2370,
  rxLow: 1920,
  rxHigh: 1960,
}

describe('im3CoreCalc 频率计算', () => {
  it('文档经典案例：低段 1850~1950，重叠 1920~1950（30MHz）', () => {
    const result = expectOk(im3CoreCalc(CLASSIC))
    expect(result.lowProduct.rangeMin).toBe(1850)
    expect(result.lowProduct.rangeMax).toBe(1950)
    expect(result.lowProduct.overlap.hasOverlap).toBe(true)
    expect(result.lowProduct.overlap.low).toBe(1920)
    expect(result.lowProduct.overlap.high).toBe(1950)
    expect(result.lowProduct.overlap.bandwidth).toBe(30)
    expect(result.highProduct.rangeMin).toBe(2475)
    expect(result.highProduct.rangeMax).toBe(2630)
    expect(result.highProduct.overlap.hasOverlap).toBe(false)
    expect(result.hasInterference).toBe(true)
    expect(result.totalOverlapBw).toBe(30)
  })

  it('页面默认预置组合（电信 2.1G 下行 + 移动 2.3G + 电信 2.1G 上行）得到高风险', () => {
    const result = expectOk(
      im3CoreCalc({
        band1Low: 2110,
        band1High: 2130,
        band2Low: 2320,
        band2High: 2370,
        rxLow: 1920,
        rxHigh: 1940,
      }),
    )
    expect(result.lowProduct.rangeMin).toBe(1850)
    expect(result.lowProduct.rangeMax).toBe(1940)
    expect(result.lowProduct.overlap.bandwidth).toBe(20)
    expect(assessIm3Risk(result, PIM_DEFAULT).level).toBe('high')
  })

  it('现网全带宽案例：低段 1850~1980，与上行 40MHz 完全重叠', () => {
    const result = expectOk(
      im3CoreCalc({
        band1Low: 2110,
        band1High: 2150,
        band2Low: 2320,
        band2High: 2370,
        rxLow: 1920,
        rxHigh: 1960,
      }),
    )
    expect(result.lowProduct.rangeMin).toBe(1850)
    expect(result.lowProduct.rangeMax).toBe(1980)
    expect(result.lowProduct.overlap.low).toBe(1920)
    expect(result.lowProduct.overlap.high).toBe(1960)
    expect(result.lowProduct.overlap.bandwidth).toBe(40)
    expect(result.totalOverlapBw).toBe(40)
  })

  it('输入顺序颠倒时自动按中心频率区分高低频源', () => {
    const result = expectOk(
      im3CoreCalc({
        ...CLASSIC,
        band1Low: 2300,
        band1High: 2370,
        band2Low: 2110,
        band2High: 2125,
      }),
    )
    expect(result.sorted.lowSource).toBe(2)
    expect(result.sorted.highSource).toBe(1)
    expect(result.sorted.low).toEqual([2110, 2125])
    expect(result.sorted.high).toEqual([2300, 2370])
    expect(result.lowProduct.rangeMin).toBe(1850)
    expect(result.lowProduct.rangeMax).toBe(1950)
  })

  it('单个频段上下限颠倒时自动纠正', () => {
    const result = expectOk(
      im3CoreCalc({
        ...CLASSIC,
        band1Low: 2125,
        band1High: 2110,
      }),
    )
    expect(result.sorted.low).toEqual([2110, 2125])
    expect(result.lowProduct.rangeMin).toBe(1850)
    expect(result.lowProduct.rangeMax).toBe(1950)
  })

  it('频率为 0 或负数时返回 nonPositive', () => {
    expect(im3CoreCalc({ ...CLASSIC, rxLow: 0 })).toEqual({ ok: false, error: 'nonPositive' })
    expect(im3CoreCalc({ ...CLASSIC, band2High: -1 })).toEqual({ ok: false, error: 'nonPositive' })
  })

  it('两个干扰源均为单频点时标记 singlePoint', () => {
    const result = expectOk(
      im3CoreCalc({
        band1Low: 2110,
        band1High: 2110,
        band2Low: 2300,
        band2High: 2300,
        rxLow: 1920,
        rxHigh: 1960,
      }),
    )
    expect(result.singlePoint).toBe(true)
    expect(result.lowProduct.rangeMin).toBe(1920)
    expect(result.lowProduct.rangeMax).toBe(1920)
    expect(result.lowProduct.overlap.hasOverlap).toBe(false)
  })

  it('低段产物为负频率时不参与干扰判定，高段仍独立评估', () => {
    const result = expectOk(
      im3CoreCalc({
        band1Low: 900,
        band1High: 900,
        band2Low: 1900,
        band2High: 1901,
        rxLow: 2800,
        rxHigh: 3000,
      }),
    )
    expect(result.lowProduct.rangeMin).toBe(-101)
    expect(result.lowProduct.rangeMax).toBe(-100)
    expect(result.lowProduct.overlap.valid).toBe(false)
    expect(result.lowProduct.overlap.hasOverlap).toBe(false)
    expect(result.highProduct.rangeMin).toBe(2900)
    expect(result.highProduct.rangeMax).toBe(2902)
    expect(result.highProduct.overlap.hasOverlap).toBe(true)
    expect(result.highProduct.overlap.bandwidth).toBe(2)
    expect(result.hasInterference).toBe(true)
  })

  it('两段产物均不与接收频段重叠时判定无干扰', () => {
    const result = expectOk(
      im3CoreCalc({
        band1Low: 900,
        band1High: 900,
        band2Low: 1900,
        band2High: 1900,
        rxLow: 1000,
        rxHigh: 1100,
      }),
    )
    expect(result.lowProduct.overlap.hasOverlap).toBe(false)
    expect(result.highProduct.overlap.hasOverlap).toBe(false)
    expect(result.hasInterference).toBe(false)
    expect(result.totalOverlapBw).toBe(0)
  })
})

describe('assessIm3Risk 风险等级', () => {
  it('PIM 经典案例：校准后为高风险（-87dBm，高出底噪 9dB）', () => {
    const calc = expectOk(im3CoreCalc(CLASSIC))
    const risk = assessIm3Risk(calc, PIM_DEFAULT)
    expect(risk.level).toBe('high')
    expect(risk.reason).toBe('high')
    expect(risk.im3LevelDbm).toBe(-87)
    expect(risk.noiseFloorDbm).toBe(-96)
    expect(risk.levelDiffDb).toBe(9)
  })

  it('有源互调：43dBm − 20dB 隔离 − 70dBc = -47dBm', () => {
    const calc = expectOk(im3CoreCalc(CLASSIC))
    const risk = assessIm3Risk(calc, { type: 'active', txPowerDbm: 43, isolationDb: 20 })
    expect(risk.im3LevelDbm).toBe(-47)
    expect(risk.levelDiffDb).toBe(49)
    expect(risk.level).toBe('high')
  })

  it('重叠带宽小于 1MHz 时为低风险擦边', () => {
    const calc = expectOk(
      im3CoreCalc({
        band1Low: 2110,
        band1High: 2110.05,
        band2Low: 2300,
        band2High: 2300,
        rxLow: 1920,
        rxHigh: 1960,
      }),
    )
    expect(calc.totalOverlapBw).toBe(0.1)
    const risk = assessIm3Risk(calc, PIM_DEFAULT)
    expect(risk.level).toBe('low')
    expect(risk.reason).toBe('edge')
  })

  it('重叠带宽恰好 1MHz 时进入 1~10MHz 分支', () => {
    const calc = expectOk(
      im3CoreCalc({
        band1Low: 2110,
        band1High: 2110.5,
        band2Low: 2300,
        band2High: 2300,
        rxLow: 1920,
        rxHigh: 1960,
      }),
    )
    expect(calc.totalOverlapBw).toBe(1)
    const risk = assessIm3Risk(calc, PIM_DEFAULT)
    expect(risk.level).toBe('medium')
    expect(risk.reason).toBe('mediumAged')
  })

  it('重叠带宽恰好 10MHz 且电平差 >= 5dB 时为高风险', () => {
    const calc = expectOk(
      im3CoreCalc({
        band1Low: 2110,
        band1High: 2115,
        band2Low: 2300,
        band2High: 2300,
        rxLow: 1920,
        rxHigh: 1960,
      }),
    )
    expect(calc.totalOverlapBw).toBe(10)
    expect(assessIm3Risk(calc, PIM_DEFAULT).level).toBe('high')
  })

  it('1~10MHz 且电平差 < 5dB 时为低风险', () => {
    const calc = expectOk(
      im3CoreCalc({
        band1Low: 2110,
        band1High: 2110.5,
        band2Low: 2300,
        band2High: 2300,
        rxLow: 1920,
        rxHigh: 1960,
      }),
    )
    const risk = assessIm3Risk(calc, { ...PIM_DEFAULT, txPowerDbm: 38 })
    expect(risk.levelDiffDb).toBe(4)
    expect(risk.level).toBe('low')
    expect(risk.reason).toBe('belowNoise')
  })

  it('>= 10MHz 且 0 <= 电平差 < 5dB 时为中风险', () => {
    const calc = expectOk(
      im3CoreCalc({
        band1Low: 2110,
        band1High: 2115,
        band2Low: 2300,
        band2High: 2300,
        rxLow: 1920,
        rxHigh: 1960,
      }),
    )
    const risk = assessIm3Risk(calc, { ...PIM_DEFAULT, txPowerDbm: 36 })
    expect(risk.levelDiffDb).toBe(2)
    expect(risk.level).toBe('medium')
    expect(risk.reason).toBe('mediumEqual')
  })

  it('>= 10MHz 且电平差为负时为低风险', () => {
    const calc = expectOk(
      im3CoreCalc({
        band1Low: 2110,
        band1High: 2115,
        band2Low: 2300,
        band2High: 2300,
        rxLow: 1920,
        rxHigh: 1960,
      }),
    )
    const risk = assessIm3Risk(calc, { ...PIM_DEFAULT, txPowerDbm: 20 })
    expect(risk.levelDiffDb).toBe(-14)
    expect(risk.level).toBe('low')
    expect(risk.reason).toBe('lowIsolated')
  })

  it('无频率重叠时判定无干扰', () => {
    const calc = expectOk(
      im3CoreCalc({
        band1Low: 900,
        band1High: 900,
        band2Low: 1900,
        band2High: 1900,
        rxLow: 1000,
        rxHigh: 1100,
      }),
    )
    const risk = assessIm3Risk(calc, PIM_DEFAULT)
    expect(risk.level).toBe('none')
    expect(risk.reason).toBe('none')
  })
})

describe('IM3_PRESETS 预置频段库', () => {
  it('包含 12 条预置 + 自定义', () => {
    expect(IM3_PRESETS).toHaveLength(13)
    expect(IM3_PRESETS.filter(preset => preset.id !== 'custom')).toHaveLength(12)
    expect(IM3_PRESETS[IM3_PRESETS.length - 1].id).toBe('custom')
  })

  it('预置频段上下限与需求文档一致', () => {
    const byId = (id: string) => IM3_PRESETS.find(preset => preset.id === id)
    expect(byId('1')).toMatchObject({ low: 2110, high: 2130 })
    expect(byId('3')).toMatchObject({ low: 2320, high: 2370 })
    expect(byId('5')).toMatchObject({ low: 1920, high: 1960 })
    expect(byId('6')).toMatchObject({ low: 2515, high: 2675 })
    expect(byId('11')).toMatchObject({ low: 949, high: 959 })
    expect(byId('12')).toMatchObject({ low: 758, high: 788 })
    expect(byId('custom')).toMatchObject({ low: null, high: null })
  })
})
