/**
 * 3D 热力必须认 `sampleMode`（"原始采样"不能 fallback 成 IDW 栅格）。
 *
 * 背景：3D 侧 `CesiumHeatmapLayer` 原先一律走 `renderHeatRaster`，而 2D 在
 * `sampleMode='original'` 时走 `OriginalSamplesLayer`（屏幕空间逐点色斑）。
 * 于是同一份数据、同一套设置，栅格模式两端一致、原始采样两端完全是两种图。
 *
 * 这里锁住"模式分流"本身（是否贴图 / 是否建逐点覆盖层）。绘制细节由
 * `utils/__tests__/sampleBlobDraw.test.ts` 负责 —— 两端共用同一份实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom 无 canvas：`buildGradientLut` 需要 2D 上下文，这里换成空 LUT（其余保持真实实现）
vi.mock('../../../../utils/heatmap', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    buildGradientLut: () => new Uint8ClampedArray(256 * 4),
  }
})

import { CesiumHeatmapLayer } from '../CesiumHeatmapLayer'
import { DEFAULT_HEATMAP_SETTINGS } from '../../LabelSettingsModal'

const POINTS = Array.from({ length: 40 }, (_, i) => ({
  lat: 23.7 + (i % 8) * 0.004,
  lng: 114.7 + Math.floor(i / 8) * 0.004,
  weight: 10 + i,
}))

let host: HTMLDivElement
let viewer: any

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  viewer = {
    imageryLayers: {
      addImageryProvider: vi.fn(() => ({ fake: 'layer' })),
      remove: vi.fn(),
    },
    scene: {},
    canvas: { clientWidth: 900, clientHeight: 700 },
  }
})

afterEach(() => {
  host.remove()
  vi.clearAllMocks()
})

describe('CesiumHeatmapLayer：采样方式分流', () => {
  it('原始采样：不贴栅格图，改为在宿主容器里建逐点覆盖层', () => {
    const layer = new CesiumHeatmapLayer({} as any, viewer, 'L1', host)
    const stats = layer.render(POINTS, {
      ...DEFAULT_HEATMAP_SETTINGS,
      field: 'v',
      enabled: true,
      sampleMode: 'original',
    } as any, null)

    expect(stats).not.toBeNull()
    // 关键：不能走栅格贴图路径（2D 原始采样也不栅格化）
    expect(viewer.imageryLayers.addImageryProvider).not.toHaveBeenCalled()
    // 逐点覆盖层的 canvas 已建在宿主里
    expect(host.querySelector('canvas')).toBeTruthy()
    // 相机变化重画不得抛错（此时 jsdom 无 2D 上下文，实现应静默跳过）
    expect(() => layer.drawSamplesNow()).not.toThrow()
    layer.destroy()
  })

  it('原始采样下覆盖层随相机重画；销毁后 canvas 一并移除', () => {
    const layer = new CesiumHeatmapLayer({} as any, viewer, 'L1', host)
    layer.render(POINTS, {
      ...DEFAULT_HEATMAP_SETTINGS,
      field: 'v',
      enabled: true,
      sampleMode: 'original',
    } as any, null)
    expect(host.querySelector('canvas')).toBeTruthy()
    layer.destroy()
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('无有效点：不贴图也不留覆盖层数据', () => {
    const layer = new CesiumHeatmapLayer({} as any, viewer, 'L1', host)
    const stats = layer.render([], {
      ...DEFAULT_HEATMAP_SETTINGS,
      field: 'v',
      enabled: true,
      sampleMode: 'original',
    } as any, null)
    expect(stats).toBeNull()
    expect(viewer.imageryLayers.addImageryProvider).not.toHaveBeenCalled()
    layer.destroy()
  })
})
