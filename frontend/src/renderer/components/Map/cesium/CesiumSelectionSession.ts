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

export class CesiumSelectionSession {
  readonly dataSource: any
  private handler: any
  private mode: CesiumSelectionMode = 'none'
  private dragging = false
  private start: Pos | null = null
  private current: Pos | null = null
  private polygonPoints: Pos[] = []
  private selectedIds: Set<string> = new Set()
  private selectedProps: Record<string, unknown>[] = []

  constructor(
    private C: any,
    private viewer: any,
    private ctx: SelectionSessionContext,
  ) {
    this.dataSource = new C.CustomDataSource('cesium-selection')
    viewer.dataSources.add(this.dataSource)
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

  /** 清空绘制中的临时图形 */
  clearShape(): void {
    this.reset()
  }

  destroy(): void {
    try { this.handler.destroy() } catch { /* ignore */ }
    try { this.viewer.dataSources.remove(this.dataSource) } catch { /* ignore */ }
  }

  // ===== 内部 =====
  private hintFor(mode: CesiumSelectionMode): string {
    const t = this.ctx.t
    if (mode === 'circle') return t('map.circleSelectHint') || '按住左键拖出圆形范围'
    if (mode === 'polygon') return t('map.clickToAddPolygon') || '点击添加多边形顶点'
    if (mode === 'boundary') return t('map.boundaryClickHint') || '点击一个面要素作为边界'
    return t('map.dragSelectHint') || '按住左键拖出矩形范围'
  }

  private reset(): void {
    this.dragging = false
    this.start = null
    this.current = null
    this.polygonPoints = []
    this.dataSource.entities.removeAll()
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

  private bind(): void {
    const { LEFT_DOWN, MOUSE_MOVE, LEFT_UP, LEFT_CLICK, RIGHT_CLICK } = this.C.ScreenSpaceEventType
    this.handler.setInputAction((e: any) => this.onLeftDown(e.position), LEFT_DOWN)
    this.handler.setInputAction((e: any) => this.onMouseMove(e.endPosition), MOUSE_MOVE)
    this.handler.setInputAction(() => this.onLeftUp(), LEFT_UP)
    this.handler.setInputAction((e: any) => this.onLeftClick(e.position), LEFT_CLICK)
    this.handler.setInputAction(() => this.finishPolygon(), RIGHT_CLICK)
  }

  private onLeftDown(position: any) {
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
        if (g) { this.current = g; this.renderPreview() }
      }
      return
    }
    const g = this.pickGround(position)
    if (!g) return
    this.current = g
    this.renderPreview()
  }

  private onLeftUp() {
    if (!this.dragging) return
    this.dragging = false
    const a = this.start, b = this.current
    this.start = null
    this.current = null
    if (!a || !b) return

    if (this.mode === 'point') {
      if (haversine(a, b) < 3) return // <3m 视为误触
      this.collectInRect(a, b)
    } else if (this.mode === 'circle') {
      const radius = haversine(a, b)
      if (radius < 3) return
      this.collectInCircle(a, radius)
    }
    this.renderPreview()
  }

  private onLeftClick(position: any) {
    if (this.mode === 'polygon') {
      const g = this.pickGround(position)
      if (!g) return
      this.polygonPoints.push(g)
      this.current = g
      this.renderPreview()
      this.ctx.onTip(
        `${this.ctx.t('map.polygonPoints', { count: this.polygonPoints.length }) || `已选 ${this.polygonPoints.length} 个顶点`}`
        + `，${this.ctx.t('map.polygonFinishHint') || '双击或右键闭合'}`)
      return
    }
    if (this.mode === 'boundary') {
      const g = this.pickGround(position)
      if (g) this.selectByBoundary(g)
    }
  }

  /** 双击闭合多边形：由宿主在 LEFT_DOUBLE_CLICK 里调用 */
  finishPolygon(): void {
    if (this.mode !== 'polygon' || this.polygonPoints.length < 3) return
    const ring = [...this.polygonPoints]
    this.collectInPolygon(ring)
    this.polygonPoints = []
    this.current = null
    this.renderPreview()
    this.drawFeedbackPolygon(ring)
  }

  // ===== 绘制预览 =====
  private renderPreview(): void {
    const C = this.C
    this.dataSource.entities.removeAll()
    if (this.mode === 'point' && this.start && this.current) {
      const [west, east, south, north] = rectOf(this.start, this.current)
      const positions = C.Cartesian3.fromDegreesArray([
        west, south, east, south, east, north, west, north,
      ])
      this.dataSource.entities.add(new C.Entity({
        polygon: {
          hierarchy: new C.PolygonHierarchy(positions),
          material: C.Color.fromCssColorString('#00ffff').withAlpha(0.1),
          clampToGround: true,
        },
      }))
      this.dataSource.entities.add(new C.Entity({
        polyline: {
          positions: [...positions, positions[0]],
          width: 2, material: C.Color.fromCssColorString('#00ffff'), clampToGround: true,
        },
      }))
      return
    }
    if (this.mode === 'circle' && this.start && this.current) {
      const radius = haversine(this.start, this.current)
      this.dataSource.entities.add(new C.Entity({
        position: C.Cartesian3.fromDegrees(this.start[0], this.start[1]),
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius,
          material: C.Color.fromCssColorString('#00ffff').withAlpha(0.1),
          outline: true,
          outlineColor: C.Color.fromCssColorString('#00ffff'),
          outlineWidth: 2,
          height: 0,
        },
      }))
      return
    }
    if (this.mode === 'polygon' && this.polygonPoints.length > 0) {
      const pts = this.current ? [...this.polygonPoints, this.current] : this.polygonPoints
      const flat = pts.flatMap((p) => [p[0], p[1]])
      if (pts.length >= 2) {
        this.dataSource.entities.add(new C.Entity({
          polyline: {
            positions: C.Cartesian3.fromDegreesArray(flat),
            width: 2,
            material: C.Color.fromCssColorString('#00ffff'),
            clampToGround: true,
          },
        }))
      }
      for (const p of this.polygonPoints) {
        this.dataSource.entities.add(new C.Entity({
          position: C.Cartesian3.fromDegrees(p[0], p[1]),
          point: {
            pixelSize: 7, color: C.Color.fromCssColorString('#00ffff'),
            heightReference: C.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }))
      }
    }
  }

  /** 边界选择反馈：把作为边界的面用青色画出来 */
  private drawFeedbackPolygon(ring: number[][]) {
    const C = this.C
    const positions = C.Cartesian3.fromDegreesArray(ring.flatMap((p) => [p[0], p[1]]))
    this.dataSource.entities.add(new C.Entity({
      polygon: {
        hierarchy: new C.PolygonHierarchy(positions),
        material: C.Color.fromCssColorString('#00ffff').withAlpha(0.1),
        clampToGround: true,
      },
    }))
    this.dataSource.entities.add(new C.Entity({
      polyline: {
        positions: [...positions, positions[0]],
        width: 2, material: C.Color.fromCssColorString('#00ffff'), clampToGround: true,
      },
    }))
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

    this.dataSource.entities.removeAll()
    for (const ring of rings) this.drawFeedbackPolygon(ring)
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
