/**
 * 3D 等高线：**客户端采样地形**生成，不依赖任何外部等高线服务。
 *
 * 高程来源是 AWS Terrain Tiles（terrarium 格式，见 `cesiumTerrarium.ts`）：
 * 高德 / 天地图都没有公开的等高线瓦片接口；Cesium ion 的免费 WorldTerrain 又在
 * 中国全境没有高程数据（实测全部 ≈-13m），所以改用免鉴权、全球覆盖（含中国）的
 * terrarium 瓦片，高程编码在 PNG 像素里，客户端解码 + 双线性采样。
 *
 * 流程：相机视野矩形 → 经纬网格 → terrarium 采高程 → 从高程网格提取
 * 等高线段（marching squares 的简化版，见 `contourSegments`）→ 合并成一个
 * `GroundPolylinePrimitive`（贴地线，跨地形起伏贴合）。
 *
 * 性能约束（采样是异步且按视野大小平方增长的）：
 * - 只在相机停下后触发（由调用方节流），不在逐帧里跑；
 * - 网格边长按缩放自适应并封顶（见 `gridSizeFor`），总采样点有硬上限；
 * - 一个视野只取 1~9 块瓦片（LRU 缓存，见 `cesiumTerrarium.ts`）；
 * - 图元**同步构建**（`asynchronous: false`，与 `CesiumSectorLayer` 同口径），
 *   且先建新的再摘旧的 —— 贴地图元异步构建/先删后建会触发
 *   `TypeError: ...reading '_target'` 并让渲染循环永久停止。
 */
import { createTerrariumSampler, type TerrariumSampler } from './cesiumTerrarium'

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

/**
 * 局部起伏门槛（米）：格点邻域高差小于此值**不画等高线**。
 * 城市/平地的高程噪声是米级的，门槛太低会把噪声画成碎线（"横七竖八"）；
 * 12m 能把平坦城区滤掉，同时保留真实丘陵/山地。
 */
const MIN_LOCAL_RELIEF = 12

/** 等高线标签（海拔标注）上限，避免密密麻麻压住画面 */
const MAX_CONTOUR_LABELS = 24

/** 等高线标签样式：与线同色系、小字号、带白描边（卫星/矢量底图上都看得清） */
const CONTOUR_LABEL_COLOR = '#8a5a2b'
const CONTOUR_LABEL_FONT_SIZE = 10

export interface ContourSegment {
  /** 起点格点列号（0..cols-1 的浮点插值） */
  x1: number
  y1: number
  x2: number
  y2: number
  /** 所属等高值（米）；串联成线与标注海拔都要用 */
  level: number
}

/** 串起来的一条等高线（同一等高值上的连续折线，格点坐标） */
export interface ContourPolyline {
  level: number
  /** 折线顶点（x=列、y=行，浮点） */
  points: Array<{ x: number; y: number }>
}

/**
 * 起伏掩码的邻域半径（格）。
 *
 * **必须随视野尺度自适应**：固定格数在放大时会退化（1 格只有十几米 → 任何坡度
 * 的邻域高差都很小 → 整片被误判为平地）。这里让邻域大致覆盖 ~500m 的地面距离：
 * 半径 = clamp(1, 6, 500m ÷ 每格米数)。放大到 1km 视野时半径取上限 6 格
 * （约 160m），仍足以把平坦城区（米级噪声）滤掉。
 */
export function reliefRadiusFor(spanDeg: number, cols: number): number {
  if (!(spanDeg > 0) || !(cols > 1)) return 2
  const spanMeters = spanDeg * 111320
  const metersPerCell = spanMeters / cols
  return Math.max(1, Math.min(6, Math.round(500 / metersPerCell)))
}

/**
 * 局部起伏掩码：每个格点邻域（半径 radius 格）内的高差（米）。
 *
 * 用途：**只在山体画等高线**。城市/平地的高程数据（SRTM）有米级噪声，
 * 不加掩码会把这些噪声画成密密麻麻的碎线（用户反馈"横七竖八"）；
 * 加了掩码后平坦/城区（邻域高差小于阈值）一条线都不画，只有真有起伏的山体才出线。
 *
 * 邻域高差不足（NaN 过多）时记 0，等价于"不画"。
 */
export function reliefMask(
  heights: ArrayLike<number>,
  cols: number,
  rows: number,
  radius = 2,
): Float64Array {
  const mask = new Float64Array(cols * rows)
  if (cols < 2 || rows < 2) return mask
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let lo = Infinity
      let hi = -Infinity
      let valid = 0
      const c0 = Math.max(0, col - radius)
      const c1 = Math.min(cols - 1, col + radius)
      const r0 = Math.max(0, row - radius)
      const r1 = Math.min(rows - 1, row + radius)
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const h = heights[r * cols + c]
          if (!Number.isFinite(h)) continue
          if (h < lo) lo = h
          if (h > hi) hi = h
          valid++
        }
      }
      // 邻域里有效点太少（瓦片缺数据边缘）也不画
      mask[row * cols + col] = valid >= 3 ? hi - lo : 0
    }
  }
  return mask
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
  mask?: ArrayLike<number>,
  minLocalRelief = MIN_LOCAL_RELIEF,
): ContourSegment[] {
  const out: ContourSegment[] = []
  if (cols < 2 || rows < 2 || levels.length === 0) return out
  const at = (col: number, row: number) => heights[row * cols + col]
  // level 由小到大，格子里只需遍历落在 [min,max] 内的那些
  const sorted = [...levels].sort((a, b) => a - b)

  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      // 起伏不足（平地/城区噪声）整格跳过 —— "只在山体出线"的落地点
      if (mask && mask[row * cols + col] < minLocalRelief) continue
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
          out.push({ x1: xs[0], y1: ys[0], x2: xs[1], y2: ys[1], level })
        } else if (xs.length === 4) {
          out.push({ x1: xs[0], y1: ys[0], x2: xs[1], y2: ys[1], level })
          out.push({ x1: xs[2], y1: ys[2], x2: xs[3], y2: ys[3], level })
        }
      }
    }
  }
  return out
}

/**
 * 把逐格碎段**串联成连续等高线**（纯函数，便于单测）。
 *
 * 为什么必须串联：`contourSegments` 每个格子各自出一段，不串联的话画面上就是
 * 一堆互不相连的短横线 —— 正是用户反馈的"横七竖八"。串联后同一等高值的段按
 * 端点相接，连成一条条完整曲线（闭合的等高线自然闭合成环）。
 *
 * 端点量化到 1e-3 格：相邻格子算同一个交点时浮点会有 1ulp 级差异，
 * 直接比相等会断链。
 */
export function chainContourSegments(segments: ContourSegment[]): ContourPolyline[] {
  const EPS = 1e3
  const key = (x: number, y: number) => `${Math.round(x * EPS)},${Math.round(y * EPS)}`
  // 按等高值分组，组内串联
  const byLevel = new Map<number, ContourSegment[]>()
  for (const s of segments) {
    const list = byLevel.get(s.level)
    if (list) list.push(s)
    else byLevel.set(s.level, [s])
  }

  const out: ContourPolyline[] = []
  for (const [level, list] of byLevel) {
    // 端点 → 段下标（每段两个端点）
    const ends = new Map<string, number[]>()
    const push = (k: string, i: number) => {
      const arr = ends.get(k)
      if (arr) arr.push(i)
      else ends.set(k, [i])
    }
    list.forEach((s, i) => {
      push(key(s.x1, s.y1), i)
      push(key(s.x2, s.y2), i)
    })
    const used = new Array(list.length).fill(false)

    for (let start = 0; start < list.length; start++) {
      if (used[start]) continue
      used[start] = true
      const s0 = list[start]
      const pts: Array<{ x: number; y: number }> = [
        { x: s0.x1, y: s0.y1 }, { x: s0.x2, y: s0.y2 },
      ]
      // 向前接：以当前末端点为键找下一段
      const walk = (atTail: boolean): void => {
        for (;;) {
          const tip = atTail ? pts[pts.length - 1] : pts[0]
          const candidates = ends.get(key(tip.x, tip.y)) ?? []
          let next = -1
          for (const i of candidates) {
            if (!used[i]) { next = i; break }
          }
          if (next < 0) return
          used[next] = true
          const s = list[next]
          // 接上：把新段"另一端"补进来（新段与当前端点重合的那端跳过）
          const nearStart = Math.abs(s.x1 - tip.x) < 1e-3 && Math.abs(s.y1 - tip.y) < 1e-3
          const other = nearStart ? { x: s.x2, y: s.y2 } : { x: s.x1, y: s.y1 }
          if (atTail) pts.push(other)
          else pts.unshift(other)
        }
      }
      walk(true)
      walk(false)
      out.push({ level, points: pts })
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

/**
 * 目标等高线条数（视野内高差被切成几份）。
 * 稀疏一点更耐看（用户要求"稀疏"），且配局部起伏掩码后平坦区本来就不出线。
 */
const TARGET_LINES = 7
/**
 * 视野内总高差小于此值直接不画（近乎平地）。
 * 2m 太低：城市视野常有 3~5m 噪声高差，会触发一堆碎线；提到 15m 更稳。
 */
const MIN_RELIEF = 15
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

/** 一个等高线海拔标注（交给统一标签覆盖层防重叠绘制） */
export interface ContourLabel {
  lat: number
  lng: number
  /** 标注文本，形如 `320m` */
  text: string
}

/** 等高线标签样式（宿主转成标签候选时用，保证 3D 与等高线颜色一致） */
export const CONTOUR_LABEL_STYLE = {
  fontSize: CONTOUR_LABEL_FONT_SIZE,
  color: CONTOUR_LABEL_COLOR,
  background: 'halo' as const,
  backgroundColor: 'rgba(255,255,255,0.85)',
}

export interface ContourLayerOptions {
  C: any
  viewer: any
  /** 线宽（像素），默认 1 */
  width?: number
  /** 日志前缀，便于定位 */
  logPrefix?: string
  /**
   * 高程瓦片整体不可用（网络不通 / 被拦截）时的 UI 提示回调。
   * 每层只调一次；之后仍会随相机移动静默重试。
   */
  onSamplerError?: (message: string) => void
  /**
   * 海拔标注回调：每次重建后给出本视野的标注锚点；没有等高线时给空数组。
   * 宿主应把它们交给统一标签覆盖层（CesiumLabelOverlay）做防重叠绘制。
   */
  onLabels?: (labels: ContourLabel[]) => void
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
  const onLabels = opts.onLabels
  /** 高程采样器（terrarium 瓦片 + LRU 缓存），随图层创建/销毁 */
  const sampler: TerrariumSampler = createTerrariumSampler({
    logPrefix: prefix,
    onError: opts.onSamplerError,
  })

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
   * 场景瓦片加载完后允许重采样：开关刚打开/刚到新区域时高程瓦片可能还没取到，
   * 若被"同一视野不重算"守卫挡住就永远画不出线。这里借场景的瓦片加载事件当
   * "场景就绪"信号触发一次重试（与高程源无关，只是个廉价的就绪探测）。
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
    onLabels?.([])
  }

  /**
   * 画出等高线（**连续曲线**，不是逐格碎段）+ 产出海拔标注锚点。
   *
   * 贴地范围限定为 **TERRAIN（只贴地形）**：默认的 BOTH 会把等高线一起拖到
   * OSM 3D 建筑上，建筑密集区就变成一团乱线（用户反馈"其他建筑不要渲染"）。
   */
  const render = (lines: ContourPolyline[], rect: {
    west: number; south: number; east: number; north: number;
  }, cols: number, rows: number) => {
    const primitives = viewer?.scene?.primitives
    if (!primitives || destroyed) return
    lastWasEmpty = lines.length === 0
    if (lines.length === 0) {
      clearPrimitive()
      onLabels?.([])
      return
    }
    warnedEmpty = false
    // 格点列号 → 经度、行号 → 纬度（row 0 在北）
    const lonAt = (col: number) => rect.west + ((rect.east - rect.west) * col) / (cols - 1)
    const latAt = (row: number) => rect.north - ((rect.north - rect.south) * row) / (rows - 1)
    const instances: any[] = []
    for (const line of lines) {
      if (line.points.length < 2) continue
      const flat: number[] = []
      for (const p of line.points) flat.push(lonAt(p.x), latAt(p.y))
      instances.push(new C.GeometryInstance({
        geometry: new C.GroundPolylineGeometry({
          positions: C.Cartesian3.fromDegreesArray(flat),
          width,
        }),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(
            C.Color.fromCssColorString(CONTOUR_COLOR),
          ),
        },
      }))
    }
    if (instances.length === 0) {
      clearPrimitive()
      onLabels?.([])
      return
    }
    let next: any = null
    try {
      next = primitives.add(new C.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new C.PolylineColorAppearance(),
        // 只贴地形，不贴 3D 建筑：等高线爬到楼上会变成一团乱线
        classificationType: C.ClassificationType?.TERRAIN,
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
    onLabels?.(pickLabelAnchors(lines, rect, cols, rows))
  }

  /**
   * 挑海拔标注锚点：**每个等高值取最长的一两条线**的中点，避免同一圈堆一堆字。
   */
  const pickLabelAnchors = (
    lines: ContourPolyline[],
    rect: { west: number; south: number; east: number; north: number },
    cols: number,
    rows: number,
  ): ContourLabel[] => {
    const lonAt = (col: number) => rect.west + ((rect.east - rect.west) * col) / (cols - 1)
    const latAt = (row: number) => rect.north - ((rect.north - rect.south) * row) / (rows - 1)
    // 按等高值分组，每组按折线长度降序
    const byLevel = new Map<number, ContourPolyline[]>()
    for (const l of lines) {
      const arr = byLevel.get(l.level)
      if (arr) arr.push(l)
      else byLevel.set(l.level, [l])
    }
    const picked: ContourLabel[] = []
    for (const [level, arr] of byLevel) {
      arr.sort((a, b) => b.points.length - a.points.length)
      // 每个等高值最多 2 个标注（太长的一圈标两处也合理）
      for (const line of arr.slice(0, 2)) {
        if (picked.length >= MAX_CONTOUR_LABELS) break
        const mid = line.points[Math.floor(line.points.length / 2)]
        if (mid) {
          picked.push({
            lat: latAt(mid.y),
            lng: lonAt(mid.x),
            text: `${Math.round(level)}m`,
          })
        }
      }
      if (picked.length >= MAX_CONTOUR_LABELS) break
    }
    return picked
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
      // 高程来源：terrarium 瓦片（含中国；ion 的免费 WorldTerrain 在国内没有高程数据）。
      // 瓦片缺失/取不到的点高程为 NaN，contourSegments 会跳过 —— 局部缺数据不整体失败。
      const heights = await sampler.sample({ west, south, east, north }, cols, rows)
      if (destroyed) return
      let min = Infinity
      let max = -Infinity
      for (let i = 0; i < heights.length; i++) {
        const h = heights[i]
        if (Number.isFinite(h)) {
          if (h < min) min = h
          if (h > max) max = h
        }
      }
      if (!(max > min)) {
        // 全 NaN（瓦片还没到位 / 被拦）或全平：没有可画的等高线；
        // 清掉视野守卫，等瓦片到位或移动相机后重试
        lastKey = ''
        lastWasEmpty = true
        if (!warnedEmpty) {
          warnedEmpty = true
          console.warn(
            `${prefix} 本次采样没有有效高程（NaN/平地）—— `
            + '若瓦片刚切换可能是网络慢，移动相机会重试；'
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
      // 局部起伏掩码：平坦/城区（邻域高差 < MIN_LOCAL_RELIEF）一格都不画，
      // 只有山体出线 —— 这是"别画得横七竖八"的关键一步。
      const spanDeg = Math.max(east - west, north - south)
      const mask = reliefMask(heights, cols, rows, reliefRadiusFor(spanDeg, cols))
      let segments = contourSegments(heights, cols, rows, levels, mask)
      if (segments.length > MAX_SEGMENTS) {
        // 段数爆了：把**目标条数减半**（等高距随之变粗 → 线更少），重算一次。
        // 注意 targetLines 是"想要几条线"，减才是稀疏；乘 2 会更多线更多段，方向反了。
        segments = contourSegments(
          heights, cols, rows, contourLevels(min, max, Math.max(TARGET_LINES / 2, 3)),
          mask,
        )
      }
      // 逐格碎段 → 连续等高线（不串联画面上就是一堆断开的短横线）
      const lines = chainContourSegments(segments)
      render(lines, { west, south, east, north }, cols, rows)
    } catch (e) {
      // 高程瓦片不可用（网络不通 / 被拦截 / 全 404）时只是没有等高线，不该影响地图
      lastWasEmpty = true
      lastKey = ''   // 允许下次相机停下时重试（网络可能随后恢复）
      const detail = e instanceof Error ? e.message : String(e)
      console.warn(
        `${prefix} 高程采样失败，本次不出等高线（网络恢复或移动相机后会重试）: ${detail}`, e,
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
    sampler.destroy()
    clearPrimitive()
  }

  return { update, destroy }
}
