/**
 * 高德 canvas 影像 provider 的失败语义锁定。
 *
 * 背景（2026-11-02 3D 底图"只剩注记"事故）：Cesium 的 `ImageryLayer` 把
 * `requestImage` **resolve** 当成"瓦片已就绪"——缓存纹理且不再重试；只有 **reject**
 * 才回滚瓦片状态。早先这里无论成败都返回一张画布（取不到图时是一张全透明画布），
 * 于是桌面端任何一次瓦片抖动都会把一块底图永久钉成空白：底图位置露出地球底色，
 * 天地图注记照常叠在上面 —— 看起来就是"底图没了、只剩天地图注记"，并随瓦片重建反复闪。
 *
 * 这里锁三件事：失败必须 reject、偶发失败要重试、取消必须 reject。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createAmapImageryProvider,
  AMAP_TILE_RETRY_DELAYS_MS,
  AMAP_TILE_TIMEOUT_MS,
} from '../amapImageryProvider'
import { amapTileSourceForWgsTile } from '../../../../config/mapSources'

type Behavior = 'ok' | 'fail' | 'hang'

/** 记录每次 `<img>` 请求，按 respond 决定成功/失败/挂起 */
let respond: (url: string, attempt: number) => Behavior = () => 'ok'
let attempts = new Map<string, number>()
let drawImage = vi.fn()

class FakeImage {
  crossOrigin: string | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private _src = ''
  set src(value: string) {
    this._src = value
    const attempt = (attempts.get(value) ?? 0) + 1
    attempts.set(value, attempt)
    const behavior = respond(value, attempt)
    if (behavior === 'hang') return
    // 用微任务回调模拟异步加载（不要用 queueMicrotask：假定时器会接管它）
    Promise.resolve().then(() => {
      if (behavior === 'ok') this.onload?.()
      else this.onerror?.()
    })
  }
  get src() {
    return this._src
  }
}

/** 只实现 provider 用到的构造元数据 */
class FakeUrlTemplateImageryProvider {
  url: string
  minimumLevel: number
  maximumLevel: number
  credit: string
  hasAlpha = false
  constructor(opts: any) {
    this.url = opts.url
    this.minimumLevel = opts.minimumLevel
    this.maximumLevel = opts.maximumLevel
    this.credit = opts.credit
  }
}

const C = { UrlTemplateImageryProvider: FakeUrlTemplateImageryProvider }
const URL_TEMPLATE =
  'https://webst02.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}'

/** 一次请求会拼几张 GCJ02 瓦片（源矩形横跨 1~4 张） */
function cellsOf(s: { offX: number; offY: number }): number {
  return 1 + (s.offX > 0 ? 1 : 0) + (s.offY > 0 ? 1 : 0) + (s.offX > 0 && s.offY > 0 ? 1 : 0)
}

/**
 * 取一张"横跨 4 张 GCJ02 瓦片"的样本瓦片。
 * 必须落在国内：`wgs84ToGcj02` 在境外不偏移，偏移量为 0 时只会拼 1 张。
 */
function sampleTile(): { x: number; y: number; level: number; cells: number; wx: number; wy: number } {
  for (let level = 10; level <= 13; level++) {
    for (let x = 780; x < 880; x++) {
      for (let y = 380; y < 440; y++) {
        const s = amapTileSourceForWgsTile(level, x, y, 256)
        if (cellsOf(s) === 4) return { x, y, level, cells: 4, wx: s.wx, wy: s.wy }
      }
    }
  }
  throw new Error('未找到横跨 4 张瓦片的样本瓦片')
}

function tileUrl(wx: number, wy: number, level: number): string {
  return URL_TEMPLATE
    .replace('{x}', String(wx))
    .replace('{y}', String(wy))
    .replace('{z}', String(level))
}

describe('createAmapImageryProvider 失败语义', () => {
  beforeEach(() => {
    attempts = new Map()
    respond = () => 'ok'
    drawImage = vi.fn()
    vi.stubGlobal('Image', FakeImage)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('子瓦片全部失败时必须 reject（不再返回全透明画布冒充成功）', async () => {
    respond = () => 'fail'
    const t = sampleTile()
    const p = createAmapImageryProvider(C, URL_TEMPLATE).requestImage(t.x, t.y, t.level, {})
    // 先挂上断言再推进定时器，否则 reject 会先于断言被当成未处理拒绝
    const assertion = expect(p).rejects.toThrow(/unavailable/)
    await vi.advanceTimersByTimeAsync(AMAP_TILE_TIMEOUT_MS * 3 + 2000)
    await assertion
    // 每张子瓦片都试了「首次 + 重试」，且没有画出任何东西
    expect(Math.max(...attempts.values())).toBe(AMAP_TILE_RETRY_DELAYS_MS.length + 1)
    expect(attempts.size).toBe(t.cells)
    expect(drawImage).not.toHaveBeenCalled()
  })

  it('偶发失败重试后成功 → resolve 画布（重试确实生效）', async () => {
    respond = (_url, attempt) => (attempt === 1 ? 'fail' : 'ok')
    const t = sampleTile()
    const promise = createAmapImageryProvider(C, URL_TEMPLATE).requestImage(t.x, t.y, t.level, {})
    await vi.advanceTimersByTimeAsync(AMAP_TILE_TIMEOUT_MS)
    await expect(promise).resolves.toBeTruthy()
    expect(drawImage).toHaveBeenCalledTimes(t.cells)
  })

  it('单张子瓦片始终失败、其余成功 → 仍出图（部分空块可接受）', async () => {
    const t = sampleTile()
    const firstUrl = tileUrl(t.wx, t.wy, t.level)
    respond = (url) => (url === firstUrl ? 'fail' : 'ok')
    const promise = createAmapImageryProvider(C, URL_TEMPLATE).requestImage(t.x, t.y, t.level, {})
    await vi.advanceTimersByTimeAsync(AMAP_TILE_TIMEOUT_MS)
    await expect(promise).resolves.toBeTruthy()
    expect(drawImage).toHaveBeenCalledTimes(t.cells - 1)
  })

  it('请求被取消时 reject（Cesium 会据此把瓦片状态回滚重试）', async () => {
    respond = () => 'hang'
    const t = sampleTile()
    const request: any = {}
    const promise = createAmapImageryProvider(C, URL_TEMPLATE).requestImage(t.x, t.y, t.level, request)
    const assertion = expect(promise).rejects.toThrow(/cancelled/)
    expect(typeof request.cancelFunction).toBe('function')
    request.cancelFunction()
    await vi.advanceTimersByTimeAsync(AMAP_TILE_TIMEOUT_MS + 1000)
    await assertion
  })

  it('子瓦片无响应时按超时失败（不无限挂起）', async () => {
    respond = () => 'hang'
    const t = sampleTile()
    const promise = createAmapImageryProvider(C, URL_TEMPLATE).requestImage(t.x, t.y, t.level, {})
    const assertion = expect(promise).rejects.toThrow(/unavailable|timeout/)
    // 首次 + 2 次重试，每次各 8s 超时
    await vi.advanceTimersByTimeAsync(AMAP_TILE_TIMEOUT_MS * 3 + 2000)
    await assertion
  })
})
