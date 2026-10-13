/**
 * CesiumLabelOverlay 标签防重叠测试
 *
 * 锁定 3D 标签改版后的两个关键行为（对等 2D LabelLayoutManager 的测试）：
 * 1. 同一锚点堆了一堆标签时，只会画出互不重叠的那几个（8 个避让方位用尽即放弃）
 * 2. 跨标签源（LTE + 图层文件）全局防重叠 —— 不是"各图层自己排自己的"
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { CesiumLabelOverlay } from '../CesiumLabelOverlay'
import type { LabelCandidateBase } from '../../labelLayoutCore'

/** 记录到的 fillText 调用（屏幕坐标） */
interface Drawn { text: string; x: number; y: number }
let drawn: Drawn[] = []

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function () {
    return {
      measureText: (t: string) => ({ width: String(t).length * 6 }),
      fillText: (text: string, x: number, y: number) => { drawn.push({ text, x, y }) },
      strokeText: () => {},
      roundRect: () => {},
      rect: () => {},
      fill: () => {},
      clearRect: () => { drawn = [] },
      setTransform: () => {},
      beginPath: () => {},
      font: '', fillStyle: '', strokeStyle: '',
      textAlign: '', textBaseline: '', lineJoin: '', lineWidth: 0,
      shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    } as unknown as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
})

/**
 * 最小 Cesium 替身：投影退化成"以 (114.7, 23.75) 为画布中心的局部切平面"。
 * 1e-4 度 ≈ 1 像素，便于构造"屏幕上贴在一起"的候选。
 */
const ORIGIN = { lng: 114.7, lat: 23.75 }
const C = {
  Cartographic: { fromDegrees: (lng: number, lat: number) => ({ longitude: lng, latitude: lat, height: 0 }) },
  Cartesian3: { fromRadians: (lon: number, lat: number, h: number) => ({ lon, lat, h }) },
  SceneTransforms: {
    worldToWindowCoordinates: (_scene: unknown, cart: { lon: number; lat: number }) => ({
      x: 400 + (cart.lon - ORIGIN.lng) * 10000,
      y: 300 - (cart.lat - ORIGIN.lat) * 10000,
    }),
  },
}
const viewer = {
  scene: { globe: { getHeight: () => 0 } },
  canvas: { clientWidth: 800, clientHeight: 600 },
}

function makeCandidates(n: number, source: string): LabelCandidateBase[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${source}-${i}`,
    lat: 23.75,
    lng: 114.7,
    text: `${source}${i}`,
    fontSize: 12,
    color: '#000',
  }))
}

function flushRAF(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60))
}

describe('CesiumLabelOverlay 标签防重叠', () => {
  let canvas: HTMLCanvasElement
  let overlay: CesiumLabelOverlay

  beforeEach(() => {
    drawn = []
    canvas = document.createElement('canvas')
    Object.defineProperty(canvas, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true })
    overlay = new CesiumLabelOverlay(C as any, viewer as any, canvas)
  })

  it('同一锚点堆叠时只画互不重叠的标签', async () => {
    overlay.setCandidates('lte', makeCandidates(20, 'A'))
    await flushRAF()

    // 8 个避让方位全部被占满后就不再放置，远小于候选数
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.length).toBeLessThanOrEqual(8)
    // 画出来的标签位置互不相同（重叠的都被丢掉了）
    const keys = new Set(drawn.map((d) => `${Math.round(d.x)},${Math.round(d.y)}`))
    expect(keys.size).toBe(drawn.length)
  })

  it('跨标签源全局防重叠', async () => {
    // 两个源的锚点错开一点点（屏幕上差 1px），远小于一个标签框
    const a: LabelCandidateBase[] = Array.from({ length: 4 }, (_, i) => ({
      id: `lte-${i}`, lat: 23.75, lng: 114.70, text: `LTE-${i}`, fontSize: 12, color: '#000',
    }))
    const b: LabelCandidateBase[] = Array.from({ length: 4 }, (_, i) => ({
      // 与上一个源在屏幕上只差 1 像素，远小于一个标签框
      id: `file-${i}`, lat: 23.75, lng: 114.7001, text: `FILE-${i}`, fontSize: 12, color: '#000',
    }))
    overlay.setCandidates('lte-sectors', a)
    overlay.setCandidates('layer-1', b)
    await flushRAF()

    expect(drawn.length).toBeGreaterThan(0)
    // 任一两枚标签的间距都要大于最小间距（GAP=5）
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        const dx = Math.abs(drawn[i].x - drawn[j].x)
        const dy = Math.abs(drawn[i].y - drawn[j].y)
        expect(dx > 5 || dy > 5).toBe(true)
      }
    }
  })

  it('移除标签源后不再绘制', async () => {
    overlay.setCandidates('lte-sectors', makeCandidates(3, 'A'))
    await flushRAF()
    expect(drawn.length).toBeGreaterThan(0)

    overlay.removeSource('lte-sectors')
    await flushRAF()
    expect(drawn.length).toBe(0)
  })
})
