/**
 * 高程采样源：AWS Terrain Tiles（terrarium 格式）。
 *
 * **为什么不继续用 Cesium ion 的 `sampleTerrainMostDetailed`**（等高线最初的做法）：
 * 免费 Cesium World Terrain 资产在中国全境没有高程数据 —— 实测重庆 z8/z11 瓦片
 * 解包后高程全部 ≈-13m（等于没有地形；珠峰同级别瓦片 527~839m 正常）。按 ion 地形
 * 采样，国内任何视野采回来都是平地 → 高差 < 2m → 等高线一条都画不出来。
 *
 * terrarium 是 AWS Open Data 上的全球地形瓦片（SRTM / NED / GMTED 等合成，含中国），
 * 免鉴权、返回 CORS 头（`Access-Control-Allow-Origin: *`），高程编码在 PNG 像素里：
 *
 *     elevation = R × 256 + G + B / 256 - 32768
 *
 * 一个视野通常只覆盖 1~9 块瓦片（每块 ~50KB），瓦片按 LRU 缓存，重复平移不重复请求。
 * 取不到的瓦片（404 / 网络错误）按"无数据"处理：对应格点高程为 NaN，
 * `contourSegments` 会跳过含 NaN 的格子 —— 局部缺数据只丢局部等高线，不整体失败。
 */

/** 瓦片 URL 模板（Mapzen terrarium，AWS Open Data） */
const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
/** 瓦片像素边长 */
const TILE_PX = 256
/** zoom 下限：再低没有细节，且低 zoom 一格覆盖大半个中国 */
const MIN_ZOOM = 10
/** zoom 上限：中国区域 SRTM 源约 30m ≈ z13，再高只是上采样、白传瓦片 */
const MAX_ZOOM = 13
/** 选 zoom 的目标：让视野跨度大致映射到这么多源像素 */
const TARGET_SAMPLES = 128
/** 瓦片缓存上限（每块缓存解码后的像素数据 256×256×4 ≈ 256KB） */
const CACHE_MAX = 48

/** 采样矩形（WGS84 度） */
export interface SampleRect {
  west: number
  south: number
  east: number
  north: number
}

export interface TerrariumSampler {
  /**
   * 采样矩形内的 cols×rows 高程网格（行主序，row 0 = 北；无数据处为 NaN）。
   * 全部瓦片都取不到时抛错（由调用方走 catch/重试逻辑）。
   */
  sample(rect: SampleRect, cols: number, rows: number): Promise<Float64Array>
  destroy(): void
}

/** terrarium 像素 → 高程（米） */
export function terrariumDecode(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768
}

/** 经度 → 全局像素 X（zoom z 下） */
function lngToPixelX(lng: number, z: number): number {
  return ((lng + 180) / 360) * TILE_PX * Math.pow(2, z)
}

/** 纬度 → 全局像素 Y（zoom z 下，北为正） */
function latToPixelY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2)
    * TILE_PX * Math.pow(2, z)
}

/**
 * 按视野跨度选 terrarium zoom。
 *
 * 纯函数便于单测：跨度越大 zoom 越低（低 zoom 一格覆盖更大），并夹在 [MIN,MAX]。
 */
export function terrariumZoomFor(spanDeg: number): number {
  if (!(spanDeg > 0)) return MIN_ZOOM
  const raw = Math.log2((360 / spanDeg) * TILE_PX / TARGET_SAMPLES)
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(raw)))
}

interface DecodedTile {
  /** RGBA 像素数据（256×256×4） */
  data: Uint8ClampedArray
}

/**
 * 创建 terrarium 高程采样器。
 *
 * @param onError 全部瓦片都取不到时的回调（用于 UI 提示，只期望调用一次）
 * @param logPrefix 日志前缀
 */
export function createTerrariumSampler(opts?: {
  onError?: (message: string) => void
  logPrefix?: string
}): TerrariumSampler {
  const prefix = opts?.logPrefix ?? '[CesiumTerrarium]'
  const onError = opts?.onError
  /** LRU：key = `z/x/y`；null = 已知取不到（缓存负结果，避免同一视野反复请求） */
  const cache = new Map<string, DecodedTile | null>()
  let destroyed = false
  let errorReported = false

  const cacheGet = (key: string): DecodedTile | null | undefined => {
    if (!cache.has(key)) return undefined
    const v = cache.get(key) as DecodedTile | null
    // 命中后移到队尾（Map 保持插入序）＝LRU 刷新
    cache.delete(key)
    cache.set(key, v)
    return v
  }
  const cacheSet = (key: string, v: DecodedTile | null): void => {
    if (cache.has(key)) cache.delete(key)
    cache.set(key, v)
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  /** 取一块瓦片并解码；失败返回 null（负缓存） */
  const loadTile = async (z: number, x: number, y: number): Promise<DecodedTile | null> => {
    const key = `${z}/${x}/${y}`
    const cached = cacheGet(key)
    if (cached !== undefined) return cached
    try {
      const url = TERRARIUM_URL
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y))
      const resp = await fetch(url, { mode: 'cors' })
      if (!resp.ok) {
        cacheSet(key, null)
        return null
      }
      const bmp = await createImageBitmap(await resp.blob())
      const w = bmp.width
      const h = bmp.height
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        cacheSet(key, null)
        return null
      }
      ctx.drawImage(bmp, 0, 0)
      const img = ctx.getImageData(0, 0, w, h)
      if (typeof bmp.close === 'function') bmp.close()
      const tile: DecodedTile = { data: img.data }
      cacheSet(key, tile)
      return tile
    } catch {
      cacheSet(key, null)
      return null
    }
  }

  /**
   * 采样实现。
   *
   * 网格点 → 全局像素坐标 → 所在瓦片内双线性插值。跨瓦片的邻域点从相邻瓦片取，
   * 任一角点无效就只用有效角点加权（瓦片边缘/缺数据处自然退化）。
   */
  const sample = async (
    rect: SampleRect,
    cols: number,
    rows: number,
  ): Promise<Float64Array> => {
    const span = Math.max(rect.east - rect.west, rect.north - rect.south)
    const z = terrariumZoomFor(span)
    const x0 = Math.floor(lngToPixelX(rect.west, z) / TILE_PX)
    const x1 = Math.floor(lngToPixelX(rect.east, z) / TILE_PX)
    const y0 = Math.floor(latToPixelY(rect.north, z) / TILE_PX)
    const y1 = Math.floor(latToPixelY(rect.south, z) / TILE_PX)
    const coords: Array<[number, number]> = []
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) coords.push([tx, ty])
    }
    const tiles = await Promise.all(coords.map(([tx, ty]) => loadTile(z, tx, ty)))
    const tileMap = new Map<string, DecodedTile>()
    let anyOk = false
    coords.forEach(([tx, ty], i) => {
      const t = tiles[i]
      if (t) {
        tileMap.set(`${tx},${ty}`, t)
        anyOk = true
      }
    })
    if (!anyOk) {
      throw new Error(`terrarium 瓦片全部不可用（z=${z}，${coords.length} 块）`)
    }

    /** 全局像素坐标 → 高程，瓦片缺失/越界为 NaN */
    const pixelHeight = (gx: number, gy: number): number => {
      const ix = Math.floor(gx)
      const iy = Math.floor(gy)
      const tx = Math.floor(ix / TILE_PX)
      const ty = Math.floor(iy / TILE_PX)
      const tile = tileMap.get(`${tx},${ty}`)
      if (!tile) return NaN
      const lx = ix - tx * TILE_PX
      const ly = iy - ty * TILE_PX
      if (lx < 0 || ly < 0 || lx >= TILE_PX || ly >= TILE_PX) return NaN
      const i = (ly * TILE_PX + lx) * 4
      return terrariumDecode(tile.data[i], tile.data[i + 1], tile.data[i + 2])
    }

    const out = new Float64Array(cols * rows)
    for (let row = 0; row < rows; row++) {
      const lat = rect.north - ((rect.north - rect.south) * row) / (rows - 1)
      const fy = latToPixelY(lat, z)
      for (let col = 0; col < cols; col++) {
        const lng = rect.west + ((rect.east - rect.west) * col) / (cols - 1)
        const fx = lngToPixelX(lng, z)
        const xi = Math.floor(fx)
        const yi = Math.floor(fy)
        const tx = fx - xi
        const ty = fy - yi
        const h00 = pixelHeight(xi, yi)
        const h10 = pixelHeight(xi + 1, yi)
        const h01 = pixelHeight(xi, yi + 1)
        const h11 = pixelHeight(xi + 1, yi + 1)
        let sum = 0
        let wsum = 0
        const add = (h: number, w: number): void => {
          if (Number.isFinite(h)) {
            sum += h * w
            wsum += w
          }
        }
        add(h00, (1 - tx) * (1 - ty))
        add(h10, tx * (1 - ty))
        add(h01, (1 - tx) * ty)
        add(h11, tx * ty)
        out[row * cols + col] = wsum > 0 ? sum / wsum : NaN
      }
    }
    return out
  }

  return {
    sample: async (rect, cols, rows) => {
      if (destroyed) throw new Error('sampler destroyed')
      try {
        return await sample(rect, cols, rows)
      } catch (e) {
        // 网络整体不可用：让上层（也是唯一一次）通知 UI，之后静默重试
        if (!errorReported) {
          errorReported = true
          const msg = e instanceof Error ? e.message : String(e)
          console.warn(`${prefix} 高程瓦片不可用：${msg}`)
          onError?.(msg)
        }
        throw e
      }
    },
    destroy() {
      destroyed = true
      cache.clear()
    },
  }
}
