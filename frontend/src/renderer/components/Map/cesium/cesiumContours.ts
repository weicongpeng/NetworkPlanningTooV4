/**
 * 3D 等高线：**客户端采样地形**生成，不依赖任何外部等高线服务。
 *
 * 为什么不用现成服务：高德 / 天地图都没有公开的等高线瓦片接口，而本项目已经有
 * Cesium World Terrain（`Terrain.fromWorldTerrain()`，settings 里的 Cesium ion Token），
 * 直接采样地形高度即可画等高线 —— 不引入新服务、不新增 Key。
 *
 * 流程：相机视野矩形 → 经纬网格 → `sampleTerrainMostDetailed` 采高程 → 从高程网格提取
 * 等高线段（marching squares 的简化版，见 `contourSegments`）→ 合并成一个
 * `GroundPolylinePrimitive`（贴地线，跨地形起伏贴合）。
 *
 * 性能约束（采样是异步且按视野大小平方增长的）：
 * - 只在相机停下后触发（由调用方节流），不在逐帧里跑；
 * - 网格边长按缩放自适应并封顶（见 `gridSizeFor`），总采样点有硬上限；
 * - 图元**同步构建**（`asynchronous: false`，与 `CesiumSectorLayer` 同口径），
 *   且先建新的再摘旧的 —— 贴地图元异步构建/先删后建会触发
 *   `TypeError: ...reading '_target'` 并让渲染循环永久停止。
 */

/** 等高线颜色（半透明棕灰，卫星/矢量底图上都清晰但不抢眼） */
const CONTOUR_COLOR = 'rgba(196, 140, 90, 0.75)'

/**
 * 单次重建允许的最大线段数。贴地线的几何三角化在**主线程同步**完成，
 * 段数过万会明显卡住画面，所以宁可把等高距翻倍重算也别硬堆。
 */
const MAX_SEGMENTS = 15000

/** 采样点数硬上限（cols*rows），防止低缩放时把主线程/网络打满 */
const MAX_SAMPLES = 6400

/** 相机高于此高度（米）不画：全球视野下等高线没有意义，采样也不划算 */
const MAX_CAMERA_HEIGHT = 400_000

export interface ContourSegment {
  /** 起点格点列号（0..cols-1 的浮点插值） */
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * 从高程网格提取等高线段（**纯函数**，不依赖 Cesium，便于单测）。
 *
 * @param heights 行主序高程数组，长度 = cols * rows；index = row * cols + col
 * @param cols    网格列数（经度方向）
 * @param rows    网格行数（纬度方向，row 0 = 北）
 * @param levels  要提取的高程值（米）
 *
 * 每个格子按 marching squares 判断四角逐 level 的穿越，用线性插值求边上交点：
 * 2 个交点直接成段；4 个交点（鞍形）按 (0,1)(2,3) 配对 —— 鞍形本就二义，
 * 这里取一种走法，观感上无差别。
 */
export function contourSegments(
  heights: ArrayLike<number>,
  cols: number,
  rows: number,
  levels: number[],
): ContourSegment[] {
  const out: ContourSegment[] = []
  if (cols < 2 || rows < 2 || levels.length === 0) return out
  const at = (col: number, row: number) => heights[row * cols + col]
  // level 由小到大，格子里只需遍历落在 [min,max] 内的那些
  const sorted = [...levels].sort((a, b) => a - b)

  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const a = at(col, row)          // NW
      const b = at(col + 1, row)      // NE
      const c = at(col + 1, row + 1)  // SE
      const d = at(col, row + 1)      // SW
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) continue
      const lo = Math.min(a, b, c, d)
      const hi = Math.max(a, b, c, d)
      if (hi <= lo) continue
      // 二分找第一条 >= lo 的 level
      let i = 0
      while (i < sorted.length && sorted[i] < lo) i++
      for (; i < sorted.length && sorted[i] <= hi; i++) {
        const level = sorted[i]
        // 四条边的交点：上(a-b)、右(b-c)、下(d-c)、左(a-d)
        const xs: number[] = []
        const ys: number[] = []
        const edge = (p: number, q: number, x1: number, y1: number, x2: number, y2: number) => {
          if ((p < level && level <= q) || (q < level && level <= p)) {
            const t = q === p ? 0.5 : (level - p) / (q - p)
            xs.push(x1 + (x2 - x1) * t)
            ys.push(y1 + (y2 - y1) * t)
          }
        }
        edge(a, b, col, row, col + 1, row)
        edge(b, c, col + 1, row, col + 1, row + 1)
        edge(c, d, col + 1, row + 1, col, row + 1)
        edge(d, a, col, row + 1, col, row)
        if (xs.length === 2) {
          out.push({ x1: xs[0], y1: ys[0], x2: xs[1], y2: ys[1] })
        } else if (xs.length === 4) {
          out.push({ x1: xs[0], y1: ys[0], x2: xs[1], y2: ys[1] })
          out.push({ x1: xs[2], y1: ys[2], x2: xs[3], y2: ys[3] })
        }
      }
    }
  }
  return out
}

/** 把步长归整到 1/2/5 × 10ⁿ（等高距用"整"数才好看），**向下**取整（步长不超过 raw） */
export function niceInterval(rawMetres: number): number {
  if (!(rawMetres > 0)) return 1
  const exp = Math.floor(Math.log10(rawMetres))
  const base = Math.pow(10, exp)
  const f = rawMetres / base
  const mult = f >= 5 ? 5 : f >= 2 ? 2 : 1
  return mult * base
}

/**
 * 同上，但**向上**取整：返回 ≥ raw 的最小"整"步长。
 *
 * 等高距用它，条数才不会超过目标（向下取整会让 8m→5m，条数从 10 涨到 17）。
 */
export function niceIntervalCeil(rawMetres: number): number {
  if (!(rawMetres > 0)) return 1
  const exp = Math.floor(Math.log10(rawMetres))
  const base = Math.pow(10, exp)
  const f = rawMetres / base
  const mult = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10
  return mult * base
}

/** 采样网格边长：按相机高度自适应（越高越稀，采样是花钱的），并受 MAX_SAMPLES 约束 */
export function gridSizeFor(cameraHeight: number): number {
  const budget = Math.floor(Math.sqrt(MAX_SAMPLES))   // 80：采样预算允许的最大边长
  const h = Math.max(cameraHeight, 1)
  // 高空时同一套网格纯属浪费（地形细节本来也看不清），按高度线性稀释，下限 1/4 预算
  const factor = Math.max(Math.min(20_000 / h, 1), 0.25)
  return Math.max(16, Math.min(Math.round(budget * factor), budget))
}

/** 目标等高线条数（视野内高差被切成几份） */
const TARGET_LINES = 10
/** 高差小于此值视为平地，不画等高线（否则会出现 0.1m 级的碎线） */
const MIN_RELIEF = 2
/** 单次最多取多少条等高线（levels 数组上限） */
const MAX_LEVELS = 200

/**
 * 由**视野内高差**反推等高高程值列表。
 *
 * **必须按高差算，不能按视野跨度算**（这是"开了开关却一条线都没有"的根因）：
 * 城市/河谷视野高差往往只有几十~几百米，而按跨度算出来的等高距动辄 200~2000m，
 * 高差被整除光 → levels 为空 → 画面上什么都没有（实测：10km 视野 + 200m 高差 = 0 条）。
 * 按高差切成 ~TARGET_LINES 份，任何尺度都能稳定画出十来条。
 */
export function contourLevels(min: number, max: number, targetLines = TARGET_LINES): number[] {
  const relief = max - min
  if (!Number.isFinite(relief) || relief < MIN_RELIEF) return []
  const interval = niceIntervalCeil(relief / Math.max(targetLines, 1))
  const levels: number[] = []
  const first = Math.ceil(min / interval) * interval
  // 浮点累加要留容差，否则最后一条可能因精度差一点点被丢掉
  for (let lv = first; lv <= max + interval * 1e-6; lv += interval) {
    levels.push(lv)
    if (levels.length >= MAX_LEVELS) break
  }
  return levels
}

export interface ContourLayerHandle {
  /** 相机变化后由调用方节流调用；内部自带"同一视野不重算"守卫 */
  update(): Promise<void>
  /** 移除全部图元（开关关闭 / 组件卸载时调用） */
  destroy(): void
}

export interface ContourLayerOptions {
  C: any
  viewer: any
  /** 线宽（像素），默认 1 */
  width?: number
  /** 日志前缀，便于定位 */
  logPrefix?: string
}

/**
 * 创建等高线图层管理器。
 *
 * 图元生命周期：每次 update 生成新的 `GroundPolylinePrimitive` 并**先加后删**旧的，
 * 避免"先删后建中间空一帧"以及 worker 未完成时 remove 引发的 `_target` 崩溃。
 */
export function createContourLayer(opts: ContourLayerOptions): ContourLayerHandle {
  const { C, viewer } = opts
  const width = opts.width ?? 1
  const prefix = opts.logPrefix ?? '[CesiumContours]'

  let primitive: any = null
  let destroyed = false
  /** 同一视野（矩形 + 相机高度取整）不重复采样，地形瓦片加载完自己会再触发一次 */
  let lastKey = ''
  let running = false
  let pending = false
  /** 上一次采样是否没画出线（地形瓦片未就绪会采到全 0）：只有这种情况才值得等瓦片加载完重试 */
  let lastWasEmpty = true
  /** 诊断只打一次：开着开关却没画面时，浏览器控制台能直接看出原因 */
  let warnedEmpty = false

  /**
   * 地形瓦片加载完（含 ion 瓦片异步到位）后允许重采样：开关刚打开时地形往往还没好，
   * 此时采样得到全 0，若被"同一视野不重算"守卫挡住就永远画不出线。
   */
  const onTileLoadProgress = (e: any) => {
    if (destroyed || !lastWasEmpty) return
    if (e?.queueLength !== 0) return
    lastKey = ''
    void update()
  }
  const globe: any = viewer?.scene?.globe
  globe?.tileLoadProgressEvent?.addEventListener(onTileLoadProgress)

  const clearPrimitive = () => {
    const old = primitive
    primitive = null
    if (old && viewer?.scene?.primitives) {
      try { viewer.scene.primitives.remove(old) } catch { /* ignore */ }
    }
  }

  const render = (segments: ContourSegment[], rect: {
    west: number; south: number; east: number; north: number;
  }, cols: number, rows: number) => {
    const primitives = viewer?.scene?.primitives
    if (!primitives || destroyed) return
    lastWasEmpty = segments.length === 0
    if (segments.length === 0) {
      clearPrimitive()
      return
    }
    warnedEmpty = false
    // 格点列号 → 经度、行号 → 纬度（row 0 在北）
    const lonAt = (col: number) => rect.west + ((rect.east - rect.west) * col) / (cols - 1)
    const latAt = (row: number) => rect.north - ((rect.north - rect.south) * row) / (rows - 1)
    const flat: number[] = []
    for (const s of segments) {
      flat.push(lonAt(s.x1), latAt(s.y1), lonAt(s.x2), latAt(s.y2))
    }
    const positions = C.Cartesian3.fromDegreesArray(flat)
    const color = C.ColorGeometryInstanceAttribute.fromColor(
      C.Color.fromCssColorString(CONTOUR_COLOR),
    )
    let next: any = null
    try {
      next = primitives.add(new C.GroundPolylinePrimitive({
        geometryInstances: [new C.GeometryInstance({
          geometry: new C.GroundPolylineGeometry({ positions, width }),
          attributes: { color },
        })],
        appearance: new C.PolylineColorAppearance(),
        // 同步构建：与 CesiumSectorLayer 同口径，异步构建易触发 _target 崩溃
        asynchronous: false,
      }))
    } catch (e) {
      console.warn(`${prefix} 图元创建失败:`, e)
      return
    }
    // 先建新的再摘旧的，避免中间空一帧
    const old = primitive
    primitive = next
    if (old) { try { primitives.remove(old) } catch { /* ignore */ } }
  }

  const update = async (): Promise<void> => {
    if (destroyed) return
    const camera = viewer?.camera
    if (!camera) return
    const height = camera.positionCartographic?.height ?? Infinity
    if (height > MAX_CAMERA_HEIGHT) {
      // 飞到很高处：清掉线，别留着上一层的等高线
      lastKey = ''
      clearPrimitive()
      return
    }
    const rectRadians = camera.computeViewRectangle?.()
    if (!rectRadians) return
    const west = C.Math.toDegrees(rectRadians.west)
    const east = C.Math.toDegrees(rectRadians.east)
    const south = C.Math.toDegrees(rectRadians.south)
    const north = C.Math.toDegrees(rectRadians.north)
    if (!(east > west && north > south)) return

    const n = gridSizeFor(height)
    const key = `${west.toFixed(3)},${south.toFixed(3)},${east.toFixed(3)},${north.toFixed(3)}@${n}`
    if (key === lastKey) return
    if (running) { pending = true; return }
    running = true
    lastKey = key
    try {
      const cols = n
      const rows = n
      const positions: number[] = []
      for (let row = 0; row < rows; row++) {
        const lat = north - ((north - south) * row) / (rows - 1)
        for (let col = 0; col < cols; col++) {
          const lon = west + ((east - west) * col) / (cols - 1)
          positions.push(lon, lat)
        }
      }
      const cartesians = C.Cartesian3.fromDegreesArray(positions)
      // Cesium 1.146 的签名是 sampleTerrainMostDetailed(terrainProvider, positions, singleTileFallback)
      // —— **地形提供器是第一个参数**（早期版本曾是没有提供器的重载，别照抄旧写法：
      // 传错会让 Cesium 内部去读 positions.length 而抛 "Cannot read properties of undefined"）。
      const terrainProvider = viewer.terrainProvider ?? viewer.scene?.globe?.terrainProvider
      if (!terrainProvider?.availability) {
        throw new Error(
          '当前地形提供器不支持"最精细采样"（缺少 availability）：'
          + '请确认 3D 底图用的是 Cesium World Terrain 而非椭球地形',
        )
      }
      const sampled = await C.sampleTerrainMostDetailed(terrainProvider, cartesians)
      if (destroyed) return
      const heights = new Float64Array(sampled.length)
      let min = Infinity
      let max = -Infinity
      for (let i = 0; i < sampled.length; i++) {
        const h = sampled[i] ? C.Cartographic.fromCartesian(sampled[i]).height : NaN
        heights[i] = h
        if (Number.isFinite(h)) {
          if (h < min) min = h
          if (h > max) max = h
        }
      }
      if (!(max > min)) {
        // 全 0（地形瓦片未加载 / 无 ion Token 拿不到地形）或全平：没有可画的等高线；
        // 清掉视野守卫，等瓦片到位后重试
        lastKey = ''
        lastWasEmpty = true
        if (!warnedEmpty) {
          warnedEmpty = true
          console.warn(
            `${prefix} 本次采样高程全为 ${min.toFixed(1)}m —— `
            + '若为 0 通常是 Cesium ion 地形未就绪或 Token 无效，等瓦片加载完会自动重试；'
            + '若两值相同则是视野内确实没有高差（平地/海面）。',
          )
        }
        clearPrimitive()
        return
      }
      // 等高距按**视野内高差**反推（不是按视野跨度）：城市/河谷高差只有百来米，
      // 按跨度算出来的等高距会把高差整除光，一条线都画不出来。
      const levels = contourLevels(min, max)
      if (levels.length === 0) {
        // 高差太小（近乎平地）：没有可画的等高线
        lastWasEmpty = true
        if (!warnedEmpty) {
          warnedEmpty = true
          console.warn(`${prefix} 视野内高差仅 ${(max - min).toFixed(1)}m，低于 2m 不画等高线`)
        }
        clearPrimitive()
        return
      }
      let segments = contourSegments(heights, cols, rows, levels)
      if (segments.length > MAX_SEGMENTS) {
        // 段数爆了：把**目标条数减半**（等高距随之变粗 → 线更少），重算一次。
        // 注意 targetLines 是"想要几条线"，减才是稀疏；乘 2 会更多线更多段，方向反了。
        segments = contourSegments(
          heights, cols, rows, contourLevels(min, max, Math.max(TARGET_LINES / 2, 3)),
        )
      }
      render(segments, { west, south, east, north }, cols, rows)
    } catch (e) {
      // 地形服务不可用（无 ion Token / 离线 / 地形类型不支持）时只是没有等高线，不该影响地图
      lastWasEmpty = true
      lastKey = ''   // 允许下次相机停下时重试（地形可能随后才就绪）
      const detail = e instanceof Error ? e.message : String(e)
      console.warn(
        `${prefix} 地形采样失败，本次不出等高线（地形就绪或移动相机后会重试）: ${detail}`, e,
      )
    } finally {
      running = false
      if (pending && !destroyed) {
        pending = false
        void update()
      }
    }
  }

  const destroy = () => {
    destroyed = true
    lastKey = ''
    try { globe?.tileLoadProgressEvent?.removeEventListener(onTileLoadProgress) } catch { /* ignore */ }
    clearPrimitive()
  }

  return { update, destroy }
}
