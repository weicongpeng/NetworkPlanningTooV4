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
 */
import { amapTileSourceForWgsTile } from '../../../config/mapSources'

/** 高德服务端真实存在瓦片的最大级别（与 2D 的 maxNativeZoom 同口径） */
export const AMAP_NATIVE_MAX_ZOOM = 18
/** 低层级从 3 级起（与 2D 底图的 minZoom 一致） */
export const AMAP_MIN_ZOOM = 3

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
  const loadTile = (z: number, x: number, y: number): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`amap tile ${z}/${x}/${y}`))
      img.src = tileUrl(z, x, y)
    })

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
      request.cancelFunction = () => { cancelled = true }
    }

    return Promise.all(
      cells.map(([tx, ty, dx, dy]) =>
        ty < 0 || ty >= n
          ? null
          : loadTile(level, tx, ty)
            .then((img) => (cancelled ? null : { img, dx, dy }))
            .catch(() => null), // 单张小图失败不算整块失败（海洋/无数据瓦片会 404）
      ),
    ).then((parts) => {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (ctx) {
        for (const p of parts) {
          if (p) ctx.drawImage(p.img, p.dx, p.dy)
        }
      }
      return canvas
    })
  }

  return provider
}
