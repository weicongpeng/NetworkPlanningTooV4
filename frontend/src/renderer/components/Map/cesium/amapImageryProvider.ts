/**
 * 高德瓦片影像提供器（Cesium）——**带 GCJ02 → WGS84 纠偏**。
 *
 * 为什么需要它：Cesium 场景是 WGS84（工参/图层/装饰都按 WGS84 渲染），而高德瓦片是 GCJ02，
 * 直接按同 z/x/y 铺会整体偏 100~700 米（与工参错位）。这正是 2D 侧天地图要纠偏的反向问题：
 * 那边是"显示链路 GCJ02 ← 天地图 WGS84"，这里是"场景 WGS84 ← 高德 GCJ02"。
 *
 * 做法与 2D 的 `TiandituGridLayer` 完全同构：对每个请求的 **WGS84 瓦片**，用
 * `amapTileSourceForWgsTile` 反算出它对应哪张 **GCJ02** 瓦片的哪个像素，把（最多 4 张）
 * GCJ02 瓦片按该偏移画进一张 256×256 画布返回给 Cesium。
 *
 * 必须是 canvas 而不是直接给 URL —— 偏移要烘进位图；Cesium 的 `ImageryProvider` 接受
 * canvas 作为瓦片内容（`GridImageryProvider` 也是这么做的）。
 *
 * 失败语义（重要）：Cesium 的 `ImageryLayer` 把 `requestImage` **resolve** 视为"瓦片已就绪"，
 * 会缓存纹理且不再重试；只有 **reject** 才会回滚瓦片状态。所以本 provider 在子瓦片重试后
 * 仍全部失败、或请求被取消时一律 reject，绝不返回"全透明画布冒充成功"。
 */
import { amapTileSourceForWgsTile } from '../../../config/mapSources'

/** 高德服务端真实存在瓦片的最大级别（与 2D 的 maxNativeZoom 同口径） */
export const AMAP_NATIVE_MAX_ZOOM = 18
/** 低层级从 3 级起（与 2D 底图的 minZoom 一致） */
export const AMAP_MIN_ZOOM = 3

/**
 * 单张瓦片取图失败后的重试退避（毫秒）。
 *
 * 为什么必须重试：`ImageryLayer` 一旦收到 image 就把瓦片标记为 RECEIVED 并缓存纹理，
 * 不会再请求第二次。桌面端（WebView2）的跨域图片/缓存/代理与浏览器不同，偶发失败比
 * 浏览器频繁得多 —— 不重试的话每一次抖动都会变成**永久的底图空洞**（底图位置露出地球
 * 底色，天地图注记照常叠在上面，看起来就是"底图没了只剩注记"）。
 */
export const AMAP_TILE_RETRY_DELAYS_MS = [200, 600] as const

/** 单张瓦片取图超时（毫秒）：不可达的瓦片不能让 Promise 永远挂着 */
export const AMAP_TILE_TIMEOUT_MS = 8000

export interface AmapImageryOptions {
  /** 是否带透明通道（卫星影像/矢量底图 false，注记层 true） */
  hasAlpha?: boolean
  credit?: string
}

/**
 * 创建一个"纠偏后的高德瓦片"影像提供器。
 *
 * 实现方式：先按普通 `UrlTemplateImageryProvider` 建好（拿到 tilingScheme / rectangle /
 * 层级范围等元数据），再把 `requestImage` 换成"取 GCJ02 瓦片 → 画到偏移画布"。
 */
export function createAmapImageryProvider(
  C: any,
  urlTemplate: string,
  opts: AmapImageryOptions = {},
): any {
  const provider = new C.UrlTemplateImageryProvider({
    url: urlTemplate,
    minimumLevel: AMAP_MIN_ZOOM,
    maximumLevel: AMAP_NATIVE_MAX_ZOOM,
    credit: opts.credit ?? '高德地图',
  })
  if (opts.hasAlpha) provider.hasAlpha = true

  const tileUrl = (z: number, x: number, y: number): string =>
    urlTemplate
      .replace('{x}', String(x))
      .replace('{y}', String(y))
      .replace('{z}', String(z))

  /** 取一张 GCJ02 瓦片位图（crossOrigin：画布要能上传给 WebGL，否则会被判定为污染画布） */
  const loadTileOnce = (
    z: number,
    x: number,
    y: number,
    isCancelled: () => boolean,
  ): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      // 网络黑洞（代理挂起/连接不返回）时不能让这个 Promise 永远 outstanding：
      // ImageryLayer 会一直等它，底图瓦片卡在 TRANSITIONING 永远出不来。
      const timer = setTimeout(
        () => finish(() => reject(new Error(`amap tile timeout ${z}/${x}/${y}`))),
        AMAP_TILE_TIMEOUT_MS,
      )
      img.onload = () => finish(() => {
        if (isCancelled()) reject(new Error(`amap imagery cancelled ${z}/${x}/${y}`))
        else resolve(img)
      })
      img.onerror = () => finish(() => reject(new Error(`amap tile ${z}/${x}/${y}`)))
      img.src = tileUrl(z, x, y)
    })

  /** 带退避重试的取图：偶发失败重试两次，仍失败才把错误抛给上层；取消后立即放弃 */
  const loadTile = async (
    z: number,
    x: number,
    y: number,
    isCancelled: () => boolean,
  ): Promise<HTMLImageElement> => {
    let lastError: unknown
    for (let attempt = 0; attempt <= AMAP_TILE_RETRY_DELAYS_MS.length; attempt++) {
      if (isCancelled()) throw new Error(`amap imagery cancelled ${z}/${x}/${y}`)
      try {
        return await loadTileOnce(z, x, y, isCancelled)
      } catch (e) {
        lastError = e
        const delay = AMAP_TILE_RETRY_DELAYS_MS[attempt]
        // 取消是"这块瓦片已经不在视野里了"，重试毫无意义，也不该拖住整个请求
        if (delay !== undefined && !isCancelled()) {
          await new Promise((r) => setTimeout(r, delay))
        }
      }
    }
    throw lastError
  }

  provider.requestImage = function (x: number, y: number, level: number, request: any) {
    const size = 256
    const n = 1 << level
    const src = amapTileSourceForWgsTile(level, x, y, size)
    const wrapX = (v: number) => ((v % n) + n) % n

    // 源矩形可能横跨 2×2 张 GCJ02 瓦片：起点 + 右/下/右下各一张
    const cells: Array<[number, number, number, number]> = [
      [wrapX(src.wx), src.wy, -src.offX, -src.offY],
    ]
    if (src.offX > 0) cells.push([wrapX(src.wx + 1), src.wy, size - src.offX, -src.offY])
    if (src.offY > 0) cells.push([wrapX(src.wx), src.wy + 1, -src.offX, size - src.offY])
    if (src.offX > 0 && src.offY > 0) {
      cells.push([wrapX(src.wx + 1), src.wy + 1, size - src.offX, size - src.offY])
    }

    // Cesium 取消请求时把已发出的图也中止掉（相机快速移动会大量取消）
    let cancelled = false
    if (request && typeof request === 'object') {
      const prevCancel = request.cancelFunction
      request.cancelFunction = () => {
        cancelled = true
        if (typeof prevCancel === 'function') prevCancel.call(request)
      }
    }

    return Promise.all(
      cells.map(([tx, ty, dx, dy]) =>
        ty < 0 || ty >= n
          ? null
          : loadTile(level, tx, ty, () => cancelled)
            .then((img) => ({ img, dx, dy }))
            .catch(() => null), // 单张小图失败不算整块失败（海洋/无数据瓦片会 404）
      ),
    ).then((parts) => {
      /**
       * 失败/取消必须 reject，不能"伪造成功"。
       *
       * `ImageryLayer._requestImagery` 的语义是：promise resolve → 该瓦片标记 RECEIVED 并
       * 上传纹理（空白纹理也照上，永不重试）；reject → 回滚 UNLOADED/FAILED。
       * 早先这里无论成败都返回一张（可能是全透明的）画布，于是任何一次网络抖动都会把一块
       * 底图永久钉成空白 —— 桌面端失败率高，表现就是底图成片消失、只剩天地图注记，并随
       * 瓦片重建反复出现（闪烁）。
       */
      if (cancelled) throw new Error(`amap imagery cancelled ${level}/${x}/${y}`)
      const loaded = parts.filter((p): p is { img: HTMLImageElement; dx: number; dy: number } => !!p)
      if (loaded.length === 0) throw new Error(`amap tile unavailable ${level}/${x}/${y}`)

      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (ctx) {
        for (const p of loaded) ctx.drawImage(p.img, p.dx, p.dy)
      }
      return canvas
    })
  }

  return provider
}
