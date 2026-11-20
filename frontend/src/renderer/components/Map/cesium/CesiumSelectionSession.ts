/**
 * Cesium 圈选 / 点选会话——对等 OnlineMap 的圈选交互。
 *
 * 四种模式与高德侧一致：
 * - point（框选）：按住拖出矩形
 * - circle（圆形）：按住拖出半径
 * - polygon（多边形）：左键逐点、双击（或右键）闭合
 * - boundary（边界选择）：点击一个面状要素作为边界，收集落在其内的要素
 *
 * 收集规则对齐 OnlineMap.getSelectionTarget：只收集 z-order 最高且"可选"开关打开的
 * 那一个图层（基站 > 图层文件 > 地理化数据 > 装饰），无目标则不收集任何要素。
 *
 * **图形框走 SVG 覆盖层，不走 Cesium 贴地图元**：
 * 早先预览矩形是 Entity（`clampToGround`），而拖动过程中每次 `MOUSE_MOVE` 都
 * `removeAll()` + 重建——贴地图元（GroundPrimitive）要等地形瓦片就绪才出图，
 * 每帧重建等于永远等不到，表现为"圈选过程中完全没有图形框"。
 * 现在改成在地图容器上叠一张 `pointer-events:none` 的 SVG，每帧只改几个坐标属性，
 * 与 2D（Leaflet 的 SVG renderer）同一套机制：拖动实时有框、松手保留终态框。
 *
 * 坐标：本会话内部一律用 **WGS84**（Cesium 场景坐标系）——
 * 基站用 originalLat/originalLng，图层/地理化用已转 WGS84 的 GeoJSON，装饰要素入参前已转 WGS84。
 */
import { boundaryOuterRings, isPolygonGeometry } from '../../../services/boundarySelection'
import type { RenderSectorData } from '../../../services/mapDataService'

export type CesiumSelectionMode = 'none' | 'point' | 'circle' | 'polygon' | 'boundary'

/** 圈选目标图层（与 OnlineMap.getSelectionTarget 同口径） */
export type SelectionTarget =
  | { kind: 'sector'; networkType: 'lte' | 'nr' }
  | { kind: 'layer'; layerId: string }
  | { kind: 'decoration' }
  | null

/** 单个待测要素（WGS84 几何 + 属性） */
export interface SelectableFeature {
  id: string
  /** GeoJSON 几何（WGS84，[lng,lat]） */
  geometry: any
  properties: Record<string, unknown>
}

/** 会话与宿主的接口 */
export interface SelectionSessionContext {
  /** 解析当前圈选目标图层 */
  getTarget: () => SelectionTarget
  /** 当前可见且需要参与收集的扇区（WGS84，用 originalLat/originalLng 判定） */
  getSectors: (networkType: 'lte' | 'nr') => RenderSectorData[]
  /** 指定图层的全部要素（WGS84） */
  getLayerFeatures: (layerId: string) => SelectableFeature[]
  /** 装饰图层要素（WGS84） */
  getDecorationFeatures: () => SelectableFeature[]
  /** 把选中 id 应用到各图层高亮 */
  applyHighlight: (ids: Set<string>) => void
  /** 选中结果变化（用于底部提示条） */
  onSelectionChange: (count: number, properties: Record<string, unknown>[]) => void
  /** 模式结束（闭合多边形/完成一次框选后由宿主决定是否退出工具） */
  onTip: (tip: string) => void
  /** 图层类型标签，用于属性复制时标注来源 */
  t: (key: string, opts?: Record<string, unknown>) => string
}

type Pos = [number, number] // [lng, lat] WGS84

/** 图形框（WGS84）。与预览共用：预览虚线，终态实线 */
type Shape =
  | { kind: 'rect'; a: Pos; b: Pos }
  | { kind: 'circle'; center: Pos; radius: number }
  | { kind: 'ring'; ring: Pos[] }

/** 两点球面距离（米） */
function haversine(a: Pos, b: Pos): number {
  const R = 6378137
  const toRad = (x: number) => (x * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const la1 = toRad(a[1]), la2 = toRad(b[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** 点在多边形内（射线法，[lng,lat] 环） */
function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    const intersect = (yi > lat) !== (yj > lat)
      && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** 几何锚点（归属点）：点取自身，其余取包围盒中心——与 boundarySelection.geometryAnchor 同口径 */
function anchorOf(geom: any): Pos | null {
  if (!geom) return null
  if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
    return [geom.coordinates[0], geom.coordinates[1]]
  }
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity, count = 0
  const walk = (node: any) => {
    if (!Array.isArray(node)) return
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lng, lat] = node as [number, number]
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      count += 1
      return
    }
    node.forEach(walk)
  }
  walk(geom.coordinates)
  if (count === 0) return null
  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2]
}

/** 命中集合（id 去重 + 属性） */
interface HitSet {
  ids: Set<string>
  properties: Record<string, unknown>[]
}

function addHit(hits: HitSet, id: string, properties: Record<string, unknown>) {
  const key = String(id)
  if (!key || hits.ids.has(key)) return
  hits.ids.add(key)
  hits.properties.push(properties)
}

/** 圈选框配色——与 2D（Leaflet 青色虚线框）一致 */
const SHAPE_STROKE = '#00ffff'
const SHAPE_FILL = 'rgba(0,255,255,0.10)'
/** 多边形起点吸附半径（屏幕像素）——与 2D OnlineMap 的 SNAP_THRESHOLD_PX 一致 */
const SNAP_THRESHOLD_PX = 15

export class CesiumSelectionSession {
  private handler: any
  private mode: CesiumSelectionMode = 'none'
  private dragging = false
  private start: Pos | null = null
  private current: Pos | null = null
  private polygonPoints: Pos[] = []
  private selectedIds: Set<string> = new Set()
  private selectedProps: Record<string, unknown>[] = []

  /** 拖拽过程中的预览框 */
  private preview: Shape | null = null
  /** 已完成的框（松手后保留在地图上，与 2D 一致） */
  private shapes: Shape[] = []
  /** 多边形：鼠标是否靠近起点（可单击闭合） */
  private nearStart = false
  /** 吸附闭合发生在 LEFT_DOWN，需要抑制紧随其后的那次 LEFT_CLICK（否则会多加一个顶点） */
  private suppressClick = false
  /** 图形框覆盖层（SVG，pointer-events:none） */
  private overlay: SVGSVGElement | null

  constructor(
    private C: any,
    private viewer: any,
    private ctx: SelectionSessionContext,
    overlay?: SVGSVGElement | null,
  ) {
    this.overlay = overlay ?? null
    this.handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas)
    this.bind()
  }

  // ===== 对外 =====
  getMode(): CesiumSelectionMode {
    return this.mode
  }

  setMode(mode: CesiumSelectionMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.reset()
    this.clearSelection()
    this.applyCursor()
    if (mode !== 'none') this.ctx.onTip(this.hintFor(mode))
  }

  /** 点选单个要素（「选择」工具点击扇区/要素）：写入选中态并高亮 */
  selectSingle(id: string, properties: Record<string, unknown>): void {
    this.applySelection({ ids: new Set([String(id)]), properties: [properties] })
  }

  /** 清空选中态（工具栏「清除」） */
  clearSelection(): void {
    this.selectedIds = new Set()
    this.selectedProps = []
    this.ctx.applyHighlight(this.selectedIds)
    this.ctx.onSelectionChange(0, [])
  }

  /** 清空绘制中的临时图形与已完成的框 */
  clearShape(): void {
    this.reset()
    this.shapes = []
    this.renderOverlay()
  }

  /**
   * 键盘快捷键（由宿主在 window keydown 里转发）。
   * - Esc / Backspace：多边形绘制中删除上一个顶点（删完才轮到 Esc 取消选中）
   * - Esc（非绘制中）：取消当前选中，但不退出圈选工具
   * @returns 是否已消费该按键
   */
  handleKeyDown(e: KeyboardEvent): boolean {
    if (this.mode === 'none') return false
    if (e.key === 'Escape' || e.key === 'Backspace') {
      if (this.mode === 'polygon' && this.polygonPoints.length > 0) {
        e.preventDefault()
        this.polygonPoints.pop()
        this.current = null
        this.renderOverlay()
        return true
      }
      if (e.key !== 'Escape') return false
      e.preventDefault()
      this.clearSelection()
      this.ctx.onTip(this.ctx.t('map.escClearedSelection')
        || '已取消选中（Esc 不退出圈选，可继续圈选）')
      return true
    }
    return false
  }

  /** 相机变化后重画已完成的框（它们在地理上锚定，屏幕位置要跟着变） */
  refreshOverlay(): void {
    if (this.shapes.length > 0 || this.preview) this.renderOverlay()
  }

  destroy(): void {
    try { this.handler.destroy() } catch { /* ignore */ }
    this.applyCursor()
    this.renderOverlayClear()
  }

  // ===== 内部 =====
  private hintFor(mode: CesiumSelectionMode): string {
    const t = this.ctx.t
    if (mode === 'circle') return t('map.circleSelectHint') || '按住左键拖出圆形范围'
    if (mode === 'polygon') return t('map.clickToAddPolygon') || '点击添加多边形顶点'
    if (mode === 'boundary') return t('map.boundaryClickHint') || '点击一个面要素作为边界'
    return t('map.dragSelectHint') || '按住左键拖出矩形范围'
  }

  /**
   * 光标：圈选态为十字；多边形靠近起点时变手型（提示"单击即闭合"）；退出圈选复位。
   * 与 2D `map.getContainer().style.cursor` 的切换时机一致。
   */
  private applyCursor(): void {
    const canvas = this.viewer?.scene?.canvas
    if (!canvas) return
    if (this.mode === 'none') { canvas.style.cursor = ''; return }
    canvas.style.cursor = (this.mode === 'polygon' && this.nearStart) ? 'pointer' : 'crosshair'
  }

  /** 重置"绘制中"的状态（不动已完成的框） */
  private reset(): void {
    this.dragging = false
    this.start = null
    this.current = null
    this.polygonPoints = []
    this.preview = null
    this.nearStart = false
    this.suppressClick = false
    this.applyCursor()
    this.renderOverlay()
  }

  /**
   * 鼠标（屏幕像素）是否落在多边形起点附近。
   * 与 2D 一致用**像素距离**判定而不是米，这样任意缩放级别下手感都一样。
   */
  private isNearStart(screenPos: { x: number; y: number }): boolean {
    if (this.polygonPoints.length < 3) return false
    const first = this.polygonPoints[0]
    const p = this.project(first[0], first[1])
    if (!p) return false
    return Math.hypot(screenPos.x - p.x, screenPos.y - p.y) < SNAP_THRESHOLD_PX
  }

  /** 闭合多边形并收集要素（吸附闭合 / 双击 / 右键三条路径共用） */
  private closePolygon(ring: Pos[]): void {
    this.collectInPolygon(ring)
    this.polygonPoints = []
    this.current = null
    this.preview = null
    this.nearStart = false
    this.shapes = [{ kind: 'ring', ring }]
    this.applyCursor()
    this.renderOverlay()
  }

  /** 屏幕坐标 → 地面 WGS84 [lng,lat] */
  private pickGround(position: any): Pos | null {
    const { scene } = this.viewer
    const ray = scene.camera.getPickRay(position)
    let cartesian = ray ? scene.globe.pick(ray, scene) : null
    if (!cartesian) cartesian = scene.camera.pickEllipsoid(position, scene.globe.ellipsoid)
    if (!cartesian) return null
    const carto = this.C.Cartographic.fromCartesian(cartesian)
    return [this.C.Math.toDegrees(carto.longitude), this.C.Math.toDegrees(carto.latitude)]
  }

  /** WGS84 → 屏幕像素；不可见（在相机背面/被地球遮挡）时返回 null */
  private project(lng: number, lat: number): { x: number; y: number } | null {
    const scene = this.viewer?.scene
    if (!scene) return null
    try {
      const carto = this.C.Cartographic.fromDegrees(lng, lat)
      const h = typeof scene.globe?.getHeight === 'function' ? scene.globe.getHeight(carto) : 0
      const cartesian = this.C.Cartesian3.fromRadians(
        carto.longitude, carto.latitude, h ?? 0)
      const p = this.C.SceneTransforms.worldToWindowCoordinates(scene, cartesian)
      return p ? { x: p.x, y: p.y } : null
    } catch {
      return null
    }
  }

  private bind(): void {
    const { LEFT_DOWN, MOUSE_MOVE, LEFT_UP, LEFT_CLICK, RIGHT_CLICK } = this.C.ScreenSpaceEventType
    this.handler.setInputAction((e: any) => this.onLeftDown(e.position), LEFT_DOWN)
    this.handler.setInputAction((e: any) => this.onMouseMove(e.endPosition), MOUSE_MOVE)
    this.handler.setInputAction(() => this.onLeftUp(), LEFT_UP)
    this.handler.setInputAction((e: any) => this.onLeftClick(e.position), LEFT_CLICK)
    this.handler.setInputAction(() => this.finishPolygon(), RIGHT_CLICK)
  }

  private onLeftDown(position: any) {
    // 多边形：靠近起点单击即闭合（与 2D 一致：吸附后不再追加顶点）
    if (this.mode === 'polygon') {
      if (this.isNearStart(position)) {
        this.suppressClick = true
        this.closePolygon([...this.polygonPoints])
      }
      return
    }
    if (this.mode !== 'point' && this.mode !== 'circle') return
    const g = this.pickGround(position)
    if (!g) return
    this.dragging = true
    this.start = g
    this.current = g
  }

  private onMouseMove(position: any) {
    if (!this.dragging) {
      if (this.mode === 'polygon' && this.polygonPoints.length > 0) {
        const g = this.pickGround(position)
        if (g) { this.current = g }
        // 靠近起点 → 闭合实线预览 + 起点高亮圈 + 手型光标（与 2D 同反馈）
        this.nearStart = this.isNearStart(position)
        this.applyCursor()
        this.renderOverlay()
      }
      return
    }
    const g = this.pickGround(position)
    if (!g) return
    this.current = g
    this.preview = this.shapeOf(this.start, g)
    this.renderOverlay()
  }

  private onLeftUp() {
    if (!this.dragging) return
    this.dragging = false
    const a = this.start, b = this.current
    this.start = null
    this.current = null
    if (!a || !b) return

    if (this.mode === 'point') {
      if (haversine(a, b) < 3) { this.preview = null; this.renderOverlay(); return } // <3m 视为误触
      this.collectInRect(a, b)
      // 松手后保留终态框（与 2D selectionRectRef 一致）：新框替换旧框（未按住 Shift）
      this.shapes = [this.shapeOf(a, b)!]
    } else if (this.mode === 'circle') {
      const radius = haversine(a, b)
      if (radius < 3) { this.preview = null; this.renderOverlay(); return }
      this.collectInCircle(a, radius)
      this.shapes = [{ kind: 'circle', center: a, radius }]
    }
    this.preview = null
    this.renderOverlay()
  }

  private onLeftClick(position: any) {
    if (this.mode === 'polygon') {
      // 吸附闭合时 LEFT_DOWN 已经收尾，紧随的这次 click 要丢掉，否则会多加一个顶点
      if (this.suppressClick) { this.suppressClick = false; return }
      const g = this.pickGround(position)
      if (!g) return
      this.polygonPoints.push(g)
      this.current = g
      this.nearStart = this.isNearStart(position)
      this.applyCursor()
      this.renderOverlay()
      const count = this.polygonPoints.length
      this.ctx.onTip(count >= 3
        ? `已添加 ${count} 个顶点，将鼠标移到起点附近单击闭合`
        : `已添加 ${count} 个顶点（至少需要 3 个），点击继续添加顶点`)
      return
    }
    if (this.mode === 'boundary') {
      const g = this.pickGround(position)
      if (g) this.selectByBoundary(g)
    }
  }

  /** 双击 / 右键闭合多边形（双击由宿主在 LEFT_DOUBLE_CLICK 里转发） */
  finishPolygon(): void {
    if (this.mode !== 'polygon' || this.polygonPoints.length < 3) return
    this.closePolygon([...this.polygonPoints])
  }

  // ===== SVG 覆盖层 =====

  private shapeOf(a: Pos | null, b: Pos | null): Shape | null {
    if (!a || !b) return null
    if (this.mode === 'circle') return { kind: 'circle', center: a, radius: haversine(a, b) }
    return { kind: 'rect', a, b }
  }

  private renderOverlayClear(): void {
    if (this.overlay) this.overlay.innerHTML = ''
  }

  /** 把预览框与已完成的框画到 SVG 覆盖层上 */
  private renderOverlay(): void {
    const svg = this.overlay
    if (!svg) return
    const canvas = this.viewer?.scene?.canvas
    const w = canvas?.clientWidth ?? svg.clientWidth
    const h = canvas?.clientHeight ?? svg.clientHeight
    const parts: string[] = []

    const shapeMarkup = (shape: Shape, dashed: boolean): string => {
      const dash = dashed ? ' stroke-dasharray="5,5"' : ''
      if (shape.kind === 'rect') {
        const [west, east, south, north] = rectOf(shape.a, shape.b)
        const p1 = this.project(west, north)
        const p2 = this.project(east, south)
        if (!p1 || !p2) return ''
        const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y)
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.abs(p2.x - p1.x).toFixed(1)}" height="${Math.abs(p2.y - p1.y).toFixed(1)}" fill="${SHAPE_FILL}" stroke="${SHAPE_STROKE}" stroke-width="2"${dash}/>`
      }
      if (shape.kind === 'circle') {
        const c = this.project(shape.center[0], shape.center[1])
        if (!c) return ''
        // 半径换算成像素：取圆心正北 radius 米处的屏幕点
        const edge = this.project(
          shape.center[0], shape.center[1] + shape.radius / 111320)
        const r = edge ? Math.hypot(edge.x - c.x, edge.y - c.y) : 0
        if (r <= 1) return ''
        return `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${SHAPE_FILL}" stroke="${SHAPE_STROKE}" stroke-width="2"${dash}/>`
      }
      // 多边形 / 边界反馈环
      const pts = shape.ring
        .map((p) => this.project(p[0], p[1]))
        .filter((p): p is { x: number; y: number } => !!p)
      if (pts.length < 2) return ''
      const path = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
      if (dashed) {
        return `<polyline points="${path}" fill="none" stroke="${SHAPE_STROKE}" stroke-width="2"${dash}/>`
          + pts.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${SHAPE_STROKE}"/>`).join('')
      }
      return `<polygon points="${path}" fill="${SHAPE_FILL}" stroke="${SHAPE_STROKE}" stroke-width="2"/>`
    }

    // 已完成的框（实线）
    for (const s of this.shapes) {
      const m = shapeMarkup(s, false)
      if (m) parts.push(m)
    }
    // 预览框（虚线）
    if (this.preview) {
      const m = shapeMarkup(this.preview, true)
      if (m) parts.push(m)
    } else if (this.mode === 'polygon' && this.polygonPoints.length > 0) {
      if (this.nearStart) {
        // 靠近起点：画闭合实线（表示"点下去就闭合"）
        const closed = [...this.polygonPoints, this.polygonPoints[0]]
        const m = shapeMarkup({ kind: 'ring', ring: closed }, false)
        if (m) parts.push(m)
        // 起点吸附指示器（青色高亮圈，与 2D snapIndicator 同款）
        const sp = this.project(this.polygonPoints[0][0], this.polygonPoints[0][1])
        if (sp) {
          parts.push(`<circle cx="${sp.x.toFixed(1)}" cy="${sp.y.toFixed(1)}" r="10" fill="${SHAPE_FILL}" stroke="${SHAPE_STROKE}" stroke-width="3"/>`)
        }
      } else {
        // 多边形预览：已确定的顶点 + 跟随鼠标的当前点
        const pts = this.current
          ? [...this.polygonPoints, this.current] : this.polygonPoints
        const m = shapeMarkup({ kind: 'ring', ring: pts }, true)
        if (m) parts.push(m)
      }
    }

    svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    svg.innerHTML = parts.join('')
  }

  // ===== 收集 =====
  private collectInRect(a: Pos, b: Pos) {
    const [west, east, south, north] = rectOf(a, b)
    this.collect((lng, lat) => lng >= west && lng <= east && lat >= south && lat <= north)
  }

  private collectInCircle(center: Pos, radius: number) {
    this.collect((lng, lat) => haversine(center, [lng, lat]) <= radius)
  }

  private collectInPolygon(ring: Pos[]) {
    const coords = ring.map((p) => [p[0], p[1]])
    this.collect((lng, lat) => pointInRing(lng, lat, coords))
  }

  /**
   * 按 z-order 目标图层收集命中要素。
   * test(lng, lat) 判定某个归属点是否落在圈选形状内。
   */
  private collect(test: (lng: number, lat: number) => boolean) {
    const target = this.ctx.getTarget()
    const hits: HitSet = { ids: new Set(), properties: [] }

    if (target?.kind === 'sector') {
      for (const sector of this.ctx.getSectors(target.networkType)) {
        if (!test(sector.originalLng, sector.originalLat)) continue
        const id = String(sector.id)
        addHit(hits, id, {
          ...sector,
          _layerType: sector.networkType,
        } as unknown as Record<string, unknown>)
      }
    } else if (target?.kind === 'layer') {
      for (const f of this.ctx.getLayerFeatures(target.layerId)) {
        const anchor = anchorOf(f.geometry)
        if (!anchor || !test(anchor[0], anchor[1])) continue
        addHit(hits, f.id, {
          ...f.properties,
          _layerType: 'MapInfo',
          _geometry: f.geometry,
        })
      }
    } else if (target?.kind === 'decoration') {
      for (const f of this.ctx.getDecorationFeatures()) {
        const anchor = anchorOf(f.geometry)
        if (!anchor || !test(anchor[0], anchor[1])) continue
        addHit(hits, f.id, {
          ...f.properties,
          _layerType: 'Decoration',
          _geometry: f.geometry,
        })
      }
    }

    this.applySelection(hits)
  }

  /**
   * 边界选择：把点击处的面状要素当边界，收集其外环内的要素（排除边界自身所在图层）。
   */
  private selectByBoundary(point: Pos) {
    const target = this.ctx.getTarget()
    if (!target || target.kind !== 'layer') {
      this.ctx.onTip(this.ctx.t('map.boundaryNotFound') || '未找到面状边界要素')
      return
    }
    const features = this.ctx.getLayerFeatures(target.layerId)
    const boundary = features.find(
      (f) => isPolygonGeometry(f.geometry) && anchorOf(f.geometry)
        && pointInFeature(point, f.geometry))
    if (!boundary) {
      this.ctx.onTip(this.ctx.t('map.boundaryNotFound') || '未找到面状边界要素')
      return
    }
    const rings = boundaryOuterRings(boundary.geometry)
    if (rings.length === 0) return

    const hits: HitSet = { ids: new Set(), properties: [] }
    // 收集同目标图层内、落在边界外环里的其余要素（边界自身不入选）
    for (const f of features) {
      if (String(f.id) === String(boundary.id)) continue
      const anchor = anchorOf(f.geometry)
      if (!anchor) continue
      if (rings.some((ring) => pointInRing(anchor[0], anchor[1], ring))) {
        addHit(hits, f.id, { ...f.properties, _layerType: 'MapInfo', _geometry: f.geometry })
      }
    }
    this.applySelection(hits)

    this.shapes = rings.map((ring) => ({ kind: 'ring' as const, ring: ring as Pos[] }))
    this.renderOverlay()
  }

  private applySelection(hits: HitSet) {
    this.selectedIds = hits.ids
    this.selectedProps = hits.properties
    this.ctx.applyHighlight(hits.ids)
    this.ctx.onSelectionChange(hits.ids.size, hits.properties)
    const t = this.ctx.t
    this.ctx.onTip(
      hits.ids.size > 0
        ? `${t('map.featuresSelected', { count: hits.ids.size })}，${t('map.copyTip') || '按 Ctrl+C 复制'}`
        : (t('map.noFeaturesSelected') || '未选中要素'),
    )
  }

  /** 当前选中的属性（Ctrl+C 复制用） */
  getSelectedProperties(): Record<string, unknown>[] {
    return this.selectedProps
  }

  /** 当前选中的 id 集合（高亮用） */
  getSelectedIds(): Set<string> {
    return this.selectedIds
  }
}

/** 两点构成的 WGS84 矩形 [west, east, south, north] */
function rectOf(a: Pos, b: Pos): [number, number, number, number] {
  return [
    Math.min(a[0], b[0]), Math.max(a[0], b[0]),
    Math.min(a[1], b[1]), Math.max(a[1], b[1]),
  ]
}

/** 点是否落在（多）面要素内 */
function pointInFeature(point: Pos, geom: any): boolean {
  const rings = boundaryOuterRings(geom)
  return rings.some((ring) => pointInRing(point[0], point[1], ring))
}
