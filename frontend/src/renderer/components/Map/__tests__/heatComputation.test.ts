/**
 * 热力纯计算 `computeHeatComputation` 的回归锁定。
 *
 * 它由 `HeatmapLayerManager.apply` 抽出（2D 与 3D 共用同一套半径推导 / 分位基准 / 分级映射），
 * 抽出过程是纯代码搬移，这个测试用于固定搬移后的行为，防止后续改动让 2D 与 3D 渲染分叉。
 */
import { describe, it, expect } from 'vitest'
import { computeHeatComputation } from '../HeatmapLayerManager'
import { DEFAULT_HEATMAP_SETTINGS, type HeatmapSettings } from '../LabelSettingsModal'
import type { HeatPoint } from '../../../utils/heatmap'

/** 3×3 网格点，权重 1..9 */
function gridPoints(): HeatPoint[] {
  const pts: HeatPoint[] = []
  let w = 1
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      pts.push({ lat: 23.74 + i * 0.01, lng: 114.69 + j * 0.01, weight: w++ })
    }
  }
  return pts
}

const SETTINGS: HeatmapSettings = {
  ...DEFAULT_HEATMAP_SETTINGS,
  enabled: true,
  field: 'pci',
}

describe('computeHeatComputation（2D/3D 共用）', () => {
  it('无有效点返回 null（调用方据此移除热力层）', () => {
    expect(computeHeatComputation([], SETTINGS)).toBeNull()
    expect(computeHeatComputation(
      [{ lat: NaN, lng: 114, weight: 1 }] as HeatPoint[], SETTINGS)).toBeNull()
  })

  it('归一化后点数与权重范围正确', () => {
    const c = computeHeatComputation(gridPoints(), SETTINGS)!
    expect(c.normalized.points).toHaveLength(9)
    expect(c.baseStats.min).toBe(1)
    expect(c.baseStats.max).toBe(9)
    expect(c.baseStats.count).toBe(9)
    expect(c.baseStats.field).toBe('pci')
  })

  it('推导出正的全局半径与逐点半径', () => {
    const c = computeHeatComputation(gridPoints(), SETTINGS)!
    expect(c.radiusMeters).toBeGreaterThan(0)
    expect(c.pointRadii).toHaveLength(9)
    for (const r of c.pointRadii) expect(r).toBeGreaterThan(0)
  })

  it('栅格模式建出插值场；值→色带位置映射落在 [0,1] 且单调不减', () => {
    const c = computeHeatComputation(gridPoints(), SETTINGS)!
    expect(c.isOriginal).toBe(false)
    expect(c.field).not.toBeNull()
    const samples = [1, 3, 5, 7, 9].map((v) => c.mapValue(v))
    for (const t of samples) {
      expect(t).toBeGreaterThanOrEqual(0)
      expect(t).toBeLessThanOrEqual(1)
    }
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 1e-9)
    }
  })

  it('图例分级非空且覆盖整个值域（图例与地图同源）', () => {
    const c = computeHeatComputation(gridPoints(), SETTINGS)!
    expect(c.stats.levels.length).toBeGreaterThan(0)
    expect(c.stats.fieldDistribution.length).toBeGreaterThan(0)
  })

  it('结果确定：同输入两次调用完全一致', () => {
    const a = computeHeatComputation(gridPoints(), SETTINGS)!
    const b = computeHeatComputation(gridPoints(), SETTINGS)!
    expect(b.radiusMeters).toBe(a.radiusMeters)
    expect(Array.from(b.pointRadii)).toEqual(Array.from(a.pointRadii))
    expect(b.stats.levels).toEqual(a.stats.levels)
    expect(b.mapValue(5)).toBe(a.mapValue(5))
  })

  it('原始采样模式不建场，但仍给出半径与图例', () => {
    const c = computeHeatComputation(gridPoints(), {
      ...SETTINGS, sampleMode: 'original',
    } as HeatmapSettings)!
    expect(c.isOriginal).toBe(true)
    expect(c.field).toBeNull()
    expect(c.radiusMeters).toBeGreaterThan(0)
    expect(c.stats.levels.length).toBeGreaterThan(0)
  })
})
