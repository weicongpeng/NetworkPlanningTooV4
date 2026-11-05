/**
 * 热力图「平滑强度」旧值迁移：旧版 smooth 在 detail≈95 时对细节核完全无效
 * （实测 smooth=3/5/9 渲染逐像素相同），保存的值不携带用户意图；
 * 新版同一数值会显著改变高值扩散范围（9 → 自身权重仅 10%），
 * 故无版本标记的旧条目必须归一到新默认，否则老图层会一直按旧值渲染。
 */
import { describe, it, expect } from 'vitest'
import { migrateHeatmapSmooth } from '../mapStore'
import { DEFAULT_HEATMAP_SETTINGS, HEATMAP_SETTINGS_VERSION, type HeatmapSettings } from '../../components/Map/LabelSettingsModal'

const legacy = (smooth: number): HeatmapSettings => ({
  enabled: true,
  field: 'rsrp',
  smooth,
  colorScheme: 'default',
  colorDirection: 'normal',
  showOriginal: false,
})

describe('migrateHeatmapSmooth（旧 smooth 值归一）', () => {
  it('无 smoothVersion 的旧条目 → smooth/sampling 都归到新默认并打上版本标记', () => {
    const out = migrateHeatmapSmooth({
      heatmapSettingsMap: { a: { ...legacy(9), sampling: 24 }, b: legacy(3) },
    })
    expect(out.heatmapSettingsMap.a.smooth).toBe(DEFAULT_HEATMAP_SETTINGS.smooth)
    expect(out.heatmapSettingsMap.b.smooth).toBe(DEFAULT_HEATMAP_SETTINGS.smooth)
    // 旧 sampling 是"斑点大小"倍数、新版是"网格边长"倍数，含义不同 → 同样归一
    expect(out.heatmapSettingsMap.a.sampling).toBe(DEFAULT_HEATMAP_SETTINGS.sampling)
    expect(out.heatmapSettingsMap.a.smoothVersion).toBe(HEATMAP_SETTINGS_VERSION)
  })

  it('v2 条目（smoothVersion=2）→ 版本升级，分级保持原值（默认关）并补边界柔化', () => {
    const v2: HeatmapSettings = { ...legacy(6), sampling: 8, discrete: false, smoothVersion: 2 }
    const out = migrateHeatmapSmooth({ heatmapSettingsMap: { a: v2 } })
    expect(out.heatmapSettingsMap.a.discrete).toBe(false)
    expect(out.heatmapSettingsMap.a.levelSoftness).toBe(DEFAULT_HEATMAP_SETTINGS.levelSoftness)
    // smooth/sampling 用户值保留
    expect(out.heatmapSettingsMap.a.smooth).toBe(6)
    expect(out.heatmapSettingsMap.a.sampling).toBe(8)
    expect(out.heatmapSettingsMap.a.smoothVersion).toBe(HEATMAP_SETTINGS_VERSION)
  })

  it('v3 → v4：仍是旧默认值（2/1/0.5/1）的字段升到新默认，用户改过的值保持', () => {
    const v3Defaults: HeatmapSettings = { ...legacy(2), sampling: 1, contrast: 0.5, concentration: 1, smoothVersion: 3 }
    const v3Custom: HeatmapSettings = { ...legacy(6), sampling: 1, contrast: 1.2, concentration: 1.5, smoothVersion: 3 }
    const out = migrateHeatmapSmooth({ heatmapSettingsMap: { a: v3Defaults, b: v3Custom } })
    expect(out.heatmapSettingsMap.a.smooth).toBe(DEFAULT_HEATMAP_SETTINGS.smooth)
    expect(out.heatmapSettingsMap.a.sampling).toBe(DEFAULT_HEATMAP_SETTINGS.sampling)
    expect(out.heatmapSettingsMap.a.contrast).toBe(DEFAULT_HEATMAP_SETTINGS.contrast)
    expect(out.heatmapSettingsMap.a.concentration).toBe(DEFAULT_HEATMAP_SETTINGS.concentration)
    expect(out.heatmapSettingsMap.b.smooth).toBe(6)      // 用户值保持
    expect(out.heatmapSettingsMap.b.sampling).toBe(DEFAULT_HEATMAP_SETTINGS.sampling) // 命中旧默认 → 升级
    expect(out.heatmapSettingsMap.b.contrast).toBe(1.2)  // 用户值保持
    expect(out.heatmapSettingsMap.b.concentration).toBe(1.5) // 用户值保持
  })

  it('用户已手动开启分级的条目迁移后仍为开启（不被默认值覆盖）', () => {
    const v2: HeatmapSettings = { ...legacy(6), discrete: true, smoothVersion: 2 }
    const out = migrateHeatmapSmooth({ heatmapSettingsMap: { a: v2 } })
    expect(out.heatmapSettingsMap.a.discrete).toBe(true)
  })

  it('当前版本条目保持原值（用户在新版里调过的值不被覆盖）', () => {
    const kept: HeatmapSettings = { ...legacy(6), sampling: 8, discrete: false, smoothVersion: HEATMAP_SETTINGS_VERSION }
    const out = migrateHeatmapSmooth({ heatmapSettingsMap: { a: kept } })
    expect(out.heatmapSettingsMap.a.smooth).toBe(6)
    expect(out.heatmapSettingsMap.a.sampling).toBe(8)
    expect(out.heatmapSettingsMap.a.discrete).toBe(false)
  })

  it('语义未变的字段（字段名/细节增强/分级数）不受迁移影响', () => {
    const src: HeatmapSettings = { ...legacy(9), detail: 30, inflections: 7 }
    const out = migrateHeatmapSmooth({ heatmapSettingsMap: { a: src } })
    expect(out.heatmapSettingsMap.a).toMatchObject({ field: 'rsrp', detail: 30, inflections: 7 })
  })

  it('模板里的旧 smooth 同样迁移（套用模板才会得到与地图一致的效果）', () => {
    const out = migrateHeatmapSmooth({
      heatmapTemplates: [{ id: 't1', name: 'x', settings: { smooth: 9, colorScheme: 'default', colorDirection: 'normal', showOriginal: false } }],
    })
    expect(out.heatmapTemplates![0].settings.smooth).toBe(DEFAULT_HEATMAP_SETTINGS.smooth)
  })

  it('无可迁移内容时原对象引用不变（避免每次 rehydrate 都产生新对象触发同步）', () => {
    const input = { heatmapSettingsMap: { a: { ...legacy(2), smoothVersion: HEATMAP_SETTINGS_VERSION } } }
    expect(migrateHeatmapSmooth(input)).toBe(input)
  })
})
