/**
 * 3D 标签覆盖层（Cesium）——对等 2D 的 `LabelLayoutManager`。
 *
 * 为什么要自己画而不用 Cesium 的 `Label`/`LabelCollection`：
 * - Cesium 标签**没有防重叠**，基站密集时（一个城市几千个小区）标签直接叠成一片；
 * - 逐要素一个 `Entity`/label，数量上千后每次相机停下都要跟着 `removeAll()` 全量重建，
 *   这是 3D 移动/缩放卡顿的主要来源，也容易在集合被改的瞬间触发 Cesium 内部
 *   `TypeError: Cannot read properties of undefined (reading '_target')`。
 *
 * 现在与 2D 同一套机制：所有标签源把候选注册进来，在**屏幕空间**统一布局
 * （真实文本矩形 + 8 方位贪心避让 + 空间哈希碰撞），最后批量 `fillText` 画到一张
 * `pointer-events: none` 的 Canvas 上 —— 跨图层全局不重叠、零 Cesium 对象创建销毁。
 *
 * 布局与绘制的算法复用 `labelLayoutCore`（2D 的 LabelLayoutManager 同源），
 * 这里只负责提供 Cesium 的投影与"相机移动中只重绘、停下才重排"的时机控制。
 *
 * 坐标：候选一律 **WGS84**（Cesium 场景坐标系）。
 */
import {
  layoutLabels,
  drawPlacedLabels,
  type LabelCandidateBase,
  type PlacedLabel,
} from '../labelLayoutCore'

/** 单个标签源的候选上限：给最坏情况下的布局代价封顶 */
const MAX_CANDIDATES_PER_SOURCE = 1500
/** 地形高度缓存上限（键 = 量化到 4 位小数的经纬度；LRU 逐出） */
const HEIGHT_CACHE_MAX = 20000

export class CesiumLabelOverlay {
  private canvas: HTMLCanvasElement | null
  private ctx: CanvasRenderingContext2D | null = null
  private sources = new Map<string, LabelCandidateBase[]>()
  private placements: PlacedLabel[] = []

  private measureCtx: CanvasRenderingContext2D | null = null
  private textWidthCache = new Map<string, number>()
  /** 地形高度缓存：绘制路径每帧 × 每标签都要用，不能每次都去查瓦片 */
  private heightCache = new Map<string, number>()

  private layoutQueued = false
  private drawQueued = false
  private cssW = 0
  private cssH = 0
  private dpr = 1

  constructor(
    private C: any,
    private viewer: any,
    canvas?: HTMLCanvasElement | null,
  ) {
    this.canvas = canvas ?? null
    if (this.canvas) {
      this.ctx = this.canvas.getContext('2d')
    }
  }

  /** 当前标签源数量（性能埋点用） */
  get sourceCount(): number {
    return this.sources.size
  }

  /** 注册（全量替换）某标签源的候选 */
  setCandidates(sourceId: string, candidates: LabelCandidateBase[]): void {
    this.sources.set(
      sourceId,
      candidates.length > MAX_CANDIDATES_PER_SOURCE
        ? candidates.slice(0, MAX_CANDIDATES_PER_SOURCE)
        : candidates,
    )
    this.requestLayout()
  }

  /** 移除标签源（图层关闭标签 / 图层移除时） */
  removeSource(sourceId: string): void {
    if (this.sources.delete(sourceId)) this.requestLayout()
  }

  clear(): void {
    this.sources.clear()
    this.placements = []
    this.requestDraw()
  }

  /**
   * 相机停下（或数据/配置变化）后重新布局。rAF 合并，一帧最多算一次。
   */
  requestLayout(): void {
    if (this.layoutQueued) return
    this.layoutQueued = true
    requestAnimationFrame(() => {
      this.layoutQueued = false
      this.layout()
    })
  }

  /**
   * 只重绘（相机移动中：锚点重新投影 + 布局时记录的屏幕偏移，不重排）。
   * 与 2D 的 `move → 只重绘 / moveend → 重排` 同策略，避免拖动时每帧重算碰撞。
   */
  requestDraw(): void {
    if (this.drawQueued) return
    this.drawQueued = true
    requestAnimationFrame(() => {
      this.drawQueued = false
      this.draw()
    })
  }

  /**
   * 立即重绘（不排 rAF）。
   *
   * 供 `scene.postRender` 调用：Cesium 的渲染循环是 rAF，我们自己再排一个 rAF 时，
   * 回调可能落在 Cesium 那一帧**之前**，于是用的是上一帧的相机状态 —— 表现为
   * "缩放/平移时标签比地图慢半拍"。在 postRender 里同步画，拿到的就是本帧最终相机，
   * 零延迟。
   */
  drawNow(): void {
    this.drawQueued = false
    this.draw()
  }

  destroy(): void {
    this.sources.clear()
    this.placements = []
    this.canvas = null
    this.ctx = null
  }

  // ===== 内部 =====

  /**
   * WGS84 → 屏幕像素；在相机背面/被地球遮挡时返回 null。
   * 高度取地形高：图形是贴地（clampToGround）渲染的，标签若按椭球面高度投影会在
   * 斜视/高海拔处与图形明显错位。
   *
   * 地形高按「经纬度（4 位小数 ≈ 10 米）」缓存：`Globe.getHeight` 是一次瓦片查询，
   * 而绘制路径是**每帧 × 每个标签**，几百个标签就是每帧几百次查询。高度在同一位置
   * 不会变，缓存后绘制路径只剩矩阵运算。
   */
  private project(lat: number, lng: number): { x: number; y: number } | null {
    const scene = this.viewer?.scene
    if (!scene) return null
    try {
      const qLat = Math.round(lat * 1e4) / 1e4
      const qLng = Math.round(lng * 1e4) / 1e4
      const hKey = `${qLat},${qLng}`
      let height = this.heightCache.get(hKey)
      if (height !== undefined) {
        // LRU 刷新：命中后移到队尾（Map 保持插入序），被逐出的才是真最久未用
        this.heightCache.delete(hKey)
        this.heightCache.set(hKey, height)
      } else {
        const carto = this.C.Cartographic.fromDegrees(qLng, qLat)
        const raw = typeof scene.globe?.getHeight === 'function'
          ? scene.globe.getHeight(carto)
          : 0
        height = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
        // 满则逐出最久未用的一条（原来是整体 clear：大网缩放漫游时会周期性
        // 触发一整轮高度重查，表现为周期性的帧时间尖刺）
        if (this.heightCache.size >= HEIGHT_CACHE_MAX) {
          const oldest = this.heightCache.keys().next().value
          if (oldest !== undefined) this.heightCache.delete(oldest)
        }
        this.heightCache.set(hKey, height)
      }
      // 弧度换算用普通 Math（不依赖 C.Math，测试替身更简单）
      const cartesian = this.C.Cartesian3.fromRadians(
        qLng * Math.PI / 180, qLat * Math.PI / 180, height)
      const p = this.C.SceneTransforms.worldToWindowCoordinates(scene, cartesian)
      return p ? { x: p.x, y: p.y } : null
    } catch {
      return null
    }
  }

  /** 画布尺寸跟随 Cesium canvas（含 devicePixelRatio） */
  private syncSize(): boolean {
    const canvas = this.canvas
    if (!canvas || !this.ctx) return false
    const w = this.viewer?.canvas?.clientWidth ?? canvas.clientWidth
    const h = this.viewer?.canvas?.clientHeight ?? canvas.clientHeight
    if (w <= 0 || h <= 0) return false
    const dpr = window.devicePixelRatio || 1
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) return true
    this.cssW = w
    this.cssH = h
    this.dpr = dpr
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    return true
  }

  private layout(): void {
    if (!this.syncSize() || !this.ctx) return
    this.placements = layoutLabels({
      sources: this.sources,
      width: this.cssW,
      height: this.cssH,
      project: (lat, lng) => this.project(lat, lng),
      measureText: (text, font) => this.measureText(text, font),
    })
    this.draw()
  }

  private draw(): void {
    const ctx = this.ctx
    if (!ctx || !this.syncSize()) return
    ctx.clearRect(0, 0, this.cssW, this.cssH)
    if (this.placements.length === 0) return
    drawPlacedLabels(ctx, this.placements, (lat, lng) => this.project(lat, lng), {
      width: this.cssW,
      height: this.cssH,
    })
  }

  /** 文本宽度测量（按 完整字体串|文本 缓存；加粗/斜体/字体族均影响宽度） */
  private measureText(text: string, font: string): number {
    const key = `${font}|${text}`
    const cached = this.textWidthCache.get(key)
    if (cached !== undefined) return cached
    if (!this.measureCtx) {
      this.measureCtx = document.createElement('canvas').getContext('2d')
    }
    if (this.measureCtx) {
      this.measureCtx.font = font
      const width = this.measureCtx.measureText(text).width
      this.textWidthCache.set(key, width)
      return width
    }
    // 极端情况下拿不到 2d 上下文，按字数粗估
    return text.length * 12 * 0.9
  }
}
