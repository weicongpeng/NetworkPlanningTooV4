/**
 * 3D 清晰度档位锁定。
 *
 * 3D 底图比 2D 高德卫星糊，主因是渲染分辨率（Cesium `resolutionScale` 默认 1.0 按 CSS 像素
 * 渲染，而 Leaflet 的 <img> 瓦片由浏览器按设备像素合成），不是瓦片源——两家都是 256×256、原生 z18。
 * 这里锁定三档的映射关系，并保证默认档 `smooth` 与改造前行为一致（不改默认观感）。
 */
import { describe, it, expect } from 'vitest'
import { CESIUM_QUALITY_PRESETS, type CesiumQuality } from '../mapStore'

describe('CesiumJS 3D 清晰度档位', () => {
  const tiers: CesiumQuality[] = ['smooth', 'balanced', 'sharp']

  it('三档齐全', () => {
    for (const t of tiers) expect(CESIUM_QUALITY_PRESETS[t]).toBeTruthy()
  })

  it('smooth = 改造前默认行为（resolutionScale 1 / FXAA 开 / SSE 2）', () => {
    expect(CESIUM_QUALITY_PRESETS.smooth).toEqual({
      maxResolutionScale: 1,
      fxaa: true,
      maximumScreenSpaceError: 2,
    })
  })

  it('档位越高：渲染分辨率上限单调不减、屏幕空间误差单调不增', () => {
    for (let i = 1; i < tiers.length; i++) {
      const prev = CESIUM_QUALITY_PRESETS[tiers[i - 1]]
      const cur = CESIUM_QUALITY_PRESETS[tiers[i]]
      expect(cur.maxResolutionScale).toBeGreaterThanOrEqual(prev.maxResolutionScale)
      expect(cur.maximumScreenSpaceError).toBeLessThanOrEqual(prev.maximumScreenSpaceError)
    }
  })

  it('非默认档关闭 FXAA（后处理会柔化画面，与"更清晰"诉求冲突）', () => {
    expect(CESIUM_QUALITY_PRESETS.balanced.fxaa).toBe(false)
    expect(CESIUM_QUALITY_PRESETS.sharp.fxaa).toBe(false)
  })

  it('分辨率上限不超过 2（DPR 再高也不无限放大渲染成本）', () => {
    for (const t of tiers) {
      expect(CESIUM_QUALITY_PRESETS[t].maxResolutionScale).toBeLessThanOrEqual(2)
    }
  })
})
