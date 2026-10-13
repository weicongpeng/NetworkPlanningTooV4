/**
 * Cesium 图层编辑会话——LayerEditSession 的 Cesium 实现。
 *
 * 与 LayerEditSession 一样自包含：订阅同一个 layerEditStore（工作集/撤销/剪贴板真源），
 * 用 Cesium 交互完成 绘制 / 顶点编辑 / 要素拖拽 / 圈选 / 吸附 / 删除键，并直接写 store。
 * 保存路径（MapPage 的 buildSavePlan → layerApi）框架无关，原样复用。
 *
 * 坐标：store 中工作集是 GCJ02（与 Leaflet 会话一致），渲染转 WGS84、输入转回 GCJ02。
 */
import { useLayerEditStore } from '../../../store/layerEditStore'
import type { EditFeature } from '../../../store/layerEditStore'
import {
  transformGeometry,
} from './cesiumGeoJson'
import { wgs84ToGcj02, gcj02ToWgs84 } from '../../../utils/coordinate'
import {
  useMapStore,
  loadUserDecorations,
  getCurrentMapStorageKey,
} from '../../../store/mapStore'
import { layerApi } from '../../../services/api'
import { useMapDataCacheStore } from '../../../store/mapDataCacheStore'
import { NO_FILL_COLOR } from '../../../utils/fieldValue'

/** 装饰图层固定 id / 数据哨兵（与 OnlineMap 一致） */
const DECORATION_LAYER_ID = 'decoration-layer'
const DECORATION_DATA_ID = '__decoration__'

type Pos = [number, number] // [lng,lat]

/** 几何嵌套深度（坐标递归层数） */
function geomDepth(type: string): number {
  return ({ Point: 0, LineString: 1, Polygon: 2 } as Record<string, number>)[type] ?? 0
}

/** 要素的编辑期稳定标识（存于 properties._editId） */
function editIdOf(feat: EditFeature): string {
  return String(feat.properties._editId)
}

interface DragState {
  kind: 'vertex' | 'feature'
  editId: string
  index: number
  startGround: Pos
  original: any
}

export class CesiumEditSession {
  readonly dataSource: any
  private store = useLayerEditStore.getState()
  private unsub: () => void
  private handler: any
  private activeId: string | null = null
  // 正在播种的图层（防止重复请求）
  private loadingId: string | null = null
  private selectedEditId: string | null = null
  private shapeSelected: Set<string> = new Set()
  // 绘制临时态
  private drawPoints: Pos[] = [] // GCJ02
  private drawFinished = false
  private drag: DragState | null = null
  private marqueeStart: Pos | null = null
  private marqueeEnd: Pos | null = null
  // 框选拖拽后抑制紧随的 LEFT_CLICK（避免又触发点选）
  private suppressClick = false
  // editId → WGS84 geometry 镜像
  private mirror: Map<string, { type: string; coordinates: any }> = new Map()

  constructor(private C: any, private viewer: any) {
    this.dataSource = new C.CustomDataSource('edit-session')
    viewer.dataSources.add(this.dataSource)

    this.handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas)
    this.bindEvents()

    // 键盘：Enter 结束绘制；Backspace 删末点；Delete/Backspace 删除圈选要素；Esc 取消
    this.boundKeyDown = (e: KeyboardEvent) => this.onKeyDown(e)
    document.addEventListener('keydown', this.boundKeyDown)

    this.unsub = useLayerEditStore.subscribe(() => this.syncFromStore())
    this.syncFromStore()
  }

  private boundKeyDown: (e: KeyboardEvent) => void

  // ===== 坐标拾取：屏幕 → 地面 WGS84 [lng,lat] =====
  private pickGround(windowPos: any): Pos | null {
    const { scene } = this.viewer
    const ray = scene.camera.getPickRay(windowPos)
    let cartesian = ray ? scene.globe.pick(ray, scene) : null
    if (!cartesian) cartesian = scene.camera.pickEllipsoid(windowPos, scene.globe.ellipsoid)
    if (!cartesian) return null
    const carto = this.C.Cartographic.fromCartesian(cartesian)
    return [this.C.Math.toDegrees(carto.longitude), this.C.Math.toDegrees(carto.latitude)]
  }

  /** WGS84 → GCJ02 */
  private toGCJ(wgs: Pos): Pos {
    const [lat, lng] = wgs84ToGcj02(wgs[1], wgs[0])
    return [lng, lat]
  }

  // ===== 事件绑定 =====
  private bindEvents() {
    const { LEFT_CLICK, LEFT_DOWN, MOUSE_MOVE, LEFT_UP, LEFT_DOUBLE_CLICK } =
      this.C.ScreenSpaceEventType

    this.handler.setInputAction((e: any) => this.onClick(e.position), LEFT_CLICK)
    this.handler.setInputAction((e: any) => this.onLeftDown(e.position), LEFT_DOWN)
    this.handler.setInputAction((e: any) => this.onMouseMove(e.endPosition), MOUSE_MOVE)
    this.handler.setInputAction(() => this.onLeftUp(), LEFT_UP)
    this.handler.setInputAction((e: any) => this.onDoubleClick(e.position), LEFT_DOUBLE_CLICK)
  }

  private onLeftDown(position: any) {
    const picked = this.viewer.scene.pick(position)
    const entity = picked?.id
    if (entity instanceof this.C.Entity) {
      if (entity.handleEditId != null) {
        this.drag = {
          kind: 'vertex',
          editId: entity.handleEditId,
          index: entity.handleVertexIndex,
          startGround: this.pickGround(position)!,
          original: null,
        }
        return
      }
      if (entity.featEditId != null) {
        const ground = this.pickGround(position)
        if (ground) {
          this.drag = {
            kind: 'feature',
            editId: entity.featEditId,
            index: -1,
            startGround: ground,
            original: this.mirror.get(entity.featEditId) ?? null,
          }
        }
      }
    } else if (this.store.selectMode) {
      const g = this.pickGround(position)
      if (g) this.marqueeStart = g
    }
  }

  private onMouseMove(position: any) {
    // 框选拖拽：更新终点并实时预览矩形
    if (this.marqueeStart) {
      const g = this.pickGround(position)
      if (g) { this.marqueeEnd = g; this.render() }
      return
    }
    // 绘制橡皮筋预览（move 即可，无需 drag）
    if (this.isDrawingLineOrPolygon()) {
      this.render()
      return
    }
    if (!this.drag) return
    const ground = this.pickGround(position)
    if (!ground) return

    if (this.drag.kind === 'vertex') {
      this.applyVertexDrag(this.drag.editId, this.drag.index, ground)
    } else {
      this.applyFeatureDrag(this.drag.editId, this.drag.startGround, ground, this.drag.original)
    }
  }

  private onLeftUp() {
    // 框选结束：计算 WGS84 包围盒，命中要素加入选区
    if (this.marqueeStart && this.marqueeEnd) {
      const dragged = this.haversine(this.marqueeStart, this.marqueeEnd)
      if (dragged > 3) { // >3m 才算框选，否则当普通点击
        this.applyMarquee(this.marqueeStart, this.marqueeEnd)
        this.suppressClick = true
      }
    }
    this.marqueeStart = null
    this.marqueeEnd = null
    this.drag = null
  }

  /** 框选：WGS84 包围盒内的要素加入 shapeSelected */
  private applyMarquee(a: Pos, b: Pos) {
    const west = Math.min(a[0], b[0])
    const east = Math.max(a[0], b[0])
    const south = Math.min(a[1], b[1])
    const north = Math.max(a[1], b[1])
    for (const [editId, geom] of this.mirror) {
      if (this.geomInBox(geom, west, south, east, north)) {
        this.shapeSelected.add(editId)
      }
    }
    this.render()
  }

  /** 几何是否有任一坐标落在包围盒内 */
  private geomInBox(geom: any, west: number, south: number, east: number, north: number): boolean {
    const depth = geomDepth(geom.type)
    let hit = false
    const walk = (v: unknown, d: number) => {
      if (hit) return
      if (d === 0) {
        const p = v as Pos
        if (p[0] >= west && p[0] <= east && p[1] >= south && p[1] <= north) hit = true
      } else {
        (v as unknown[]).forEach((c) => walk(c, d - 1))
      }
    }
    walk(geom.coordinates, depth)
    return hit
  }

  /** 两点 WGS84 距离（米） */
  private haversine(a: Pos, b: Pos): number {
    const R = 6378137
    const toRad = (x: number) => (x * Math.PI) / 180
    const dLat = toRad(b[1] - a[1])
    const dLng = toRad(b[0] - a[0])
    const la1 = toRad(a[1]), la2 = toRad(b[1])
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(h))
  }

  private onClick(position: any) {
    if (this.suppressClick) { this.suppressClick = false; return }
    const { drawTool } = this.store
    if (drawTool === 'point') {
      const g = this.pickGround(position)
      if (g && this.activeId) {
        const gcj = this.toGCJ(g)
        this.store.addFeature(this.activeId,
          { type: 'Point', coordinates: gcj } as any)
      }
      return
    }
    if (drawTool === 'line' || drawTool === 'polygon') {
      const g = this.pickGround(position)
      if (g) this.drawPoints.push(this.toGCJ(g))
      this.render()
      return
    }
    // 非绘制：点选要素 / 圈选
    const picked = this.viewer.scene.pick(position)
    const entity = picked?.id
    const featId: string | undefined = entity instanceof this.C.Entity
      ? entity.featEditId
      : undefined

    if (this.store.selectMode) {
      if (featId) {
        if (this.shapeSelected.has(featId)) this.shapeSelected.delete(featId)
        else this.shapeSelected.add(featId)
        this.render()
      }
      return
    }

    this.selectedEditId = featId ?? null
    this.render()
  }

  private onDoubleClick(_position: any) {
    if (this.isDrawingLineOrPolygon()) this.finishDrawing()
  }

  private isDrawingLineOrPolygon(): boolean {
    const t = this.store.drawTool
    return (t === 'line' || t === 'polygon') && this.drawPoints.length > 0
  }

  private finishDrawing() {
    const tool = this.store.drawTool as 'line' | 'polygon'
    if (this.drawPoints.length >= 2 && this.activeId) {
      // GeoJSON：LineString 坐标为 Position[]；Polygon 必须为 Position[][]（外环再包一层）
      const coordinates = tool === 'line'
        ? this.drawPoints
        : [[...this.drawPoints, this.drawPoints[0]]]
      this.store.addFeature(this.activeId,
        { type: tool === 'line' ? 'LineString' : 'Polygon', coordinates } as any)
    }
    this.drawPoints = []
    this.drawFinished = true
    this.store.setDrawTool('none' as any)
    this.render()
  }

  private onKeyDown(e: KeyboardEvent) {
    const t = this.store.drawTool
    if ((t === 'line' || t === 'polygon')) {
      if (e.key === 'Enter') { e.preventDefault(); this.finishDrawing() }
      else if (e.key === 'Backspace' && this.drawPoints.length) {
        e.preventDefault(); this.drawPoints.pop(); this.render()
      } else if (e.key === 'Escape') {
        this.drawPoints = []; this.store.setDrawTool('none' as any); this.render()
      }
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.shapeSelected.size) {
      // 防止输入框聚焦时误删
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()
      if (this.activeId) {
        this.store.deleteFeatures(this.activeId, Array.from(this.shapeSelected))
        this.shapeSelected.clear()
        this.render()
      }
    }
  }

  // ===== 顶点 / 要素 拖拽落地 =====
  private applyVertexDrag(editId: string, index: number, wgs: Pos) {
    const gcj = this.toGCJ(wgs)
    const wgsGeom = this.mirror.get(editId)
    if (!wgsGeom) return
    const next = structuredClone(wgsGeom)
    if (next.type === 'LineString') next.coordinates[index] = wgs
    else if (next.type === 'Polygon') next.coordinates[0][index] = wgs
    else if (next.type === 'Point') next.coordinates = wgs
    this.mirror.set(editId, next)
    this.commitGeometry(editId, gcj, index, next)
    this.render()
  }

  private applyFeatureDrag(editId: string, start: Pos, now: Pos, _orig: any) {
    const dx = now[0] - start[0]
    const dy = now[1] - start[1]
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return
    const wgsGeom = this.mirror.get(editId)
    if (!wgsGeom) return
    const shift = (v: Pos): Pos => [v[0] + dx, v[1] + dy]
    let next = structuredClone(wgsGeom)
    next = this.mapCoords(next, shift)
    this.mirror.set(editId, next)
    // 起始点更新为当前点，避免增量累加
    this.drag!.startGround = now
    this.commitFullGeometry(editId, next)
    this.render()
  }

  private mapCoords(geom: any, fn: (v: Pos) => Pos): any {
    const walk = (v: unknown, depth: number): unknown =>
      depth === 0 ? fn(v as Pos) : (v as unknown[]).map((c) => walk(c, depth - 1))
    const depth = geomDepth(geom.type)
    return { ...geom, coordinates: walk(geom.coordinates, depth) }
  }

  /** 单顶点改动：直接在 store 要素 GCJ02 geometry 上改对应下标 */
  private commitGeometry(editId: string, gcj: Pos, index: number, _wgs: any) {
    if (!this.activeId) return
    const ws = this.store.getWorkspace(this.activeId)
    const feat = ws?.features.find((f) => editIdOf(f) === editId)
    if (!feat) return
    const g = feat.geometry
    if (g.type === 'Point') g.coordinates = gcj
    else if (g.type === 'LineString') g.coordinates[index] = gcj
    else if (g.type === 'Polygon') g.coordinates[0][index] = gcj
    this.store.updateFeatureGeometry(this.activeId, editId, g)
  }

  /** 整体移动：WGS84 改动转回 GCJ02 写 store */
  private commitFullGeometry(editId: string, wgsGeom: any) {
    if (!this.activeId) return
    const reverse = (v: Pos): Pos => {
      const [lat, lng] = wgs84ToGcj02(v[1], v[0])
      return [lng, lat]
    }
    const gcjGeom = this.mapCoords(wgsGeom, reverse)
    this.store.updateFeatureGeometry(this.activeId, editId, gcjGeom)
  }

  // ===== 从 store 同步 =====
  private syncFromStore() {
    this.store = useLayerEditStore.getState()
    const id = this.store.editableLayerId
    const idChanged = id !== this.activeId
    this.activeId = id
    if (this.drawFinished) { this.drawFinished = false }
    // 切换工作集时清选区
    if (idChanged) { this.selectedEditId = null }
    // 工作集缺失（刚打开现有图层编辑）：异步播种后 store 订阅会再次触发渲染
    if (id && !this.store.getWorkspace(id) && this.loadingId !== id) {
      void this.ensureWorkspace(id)
    }
    this.render()
  }

  /**
   * 加载并播种工作集（复刻 OnlineMap.ensureWorkspace）。
   * - 装饰图层：从持久化装饰要素播种
   * - MapInfo 图层：缓存/接口取 GCJ02 GeoJSON，构建要素 + baseStyle 后 beginEdit
   */
  private async ensureWorkspace(layerId: string) {
    this.loadingId = layerId
    const store = useLayerEditStore.getState()
    try {
      // 打开期间已切换到其它图层：放弃
      if (useLayerEditStore.getState().editableLayerId !== layerId) return

      if (layerId === DECORATION_LAYER_ID) {
        let feats = useMapStore.getState().decorationFeatures ?? []
        if (feats.length === 0) {
          feats = await loadUserDecorations(getCurrentMapStorageKey())
          if (feats.length > 0) useMapStore.setState({ decorationFeatures: feats })
        }
        store.seedWorkspace(
          DECORATION_LAYER_ID, DECORATION_DATA_ID, 'mixed', feats, null,
        )
        return
      }

      // 从 props 找图层文件：会话本身不持有 props，经 window 暴露的当前 layerFiles
      const lf = this.currentLayerFiles().find((f) => f.id === layerId)
      if (!lf || lf.sourceType !== 'mapinfo') return
      const geomType =
        ['point', 'line', 'polygon', 'mixed'].includes(lf.type) ? lf.type : null
      if (!geomType) return

      const cachedLayer = useMapDataCacheStore.getState().layers[layerId]
      let geojson: any = cachedLayer?.geojson
      let version: string | null = cachedLayer?.version ?? null
      if (!geojson) {
        const { data, version: v } = await layerApi.getLayerDataWithVersion(lf.dataId, layerId)
        geojson = data
        version = v
        if (geojson) {
          useMapDataCacheStore.getState().cacheLayerGeoJSON(layerId, geojson, v)
        }
      }
      if (useLayerEditStore.getState().editableLayerId !== layerId) return
      const features = (geojson?.features || []).map((f: any) => ({ ...f }))
      const cs = useMapStore.getState().mapSettings.colorSettingsMap?.[layerId] as any
      const baseStyle = {
        point: {
          markerColor: cs?.fillColor,
          markerRadius: cs?.pointSize,
          fillOpacity: cs?.fillOpacity,
          borderColor: cs?.borderColor,
        },
        line: {
          color: cs?.borderColor && cs.borderColor !== NO_FILL_COLOR ? cs.borderColor : cs?.fillColor,
          weight: cs?.borderWidth,
          opacity: cs?.fillOpacity,
        },
        polygon: {
          fillColor: cs?.fillColor,
          fillOpacity: cs?.fillOpacity,
          borderColor: cs?.borderColor,
          borderWidth: cs?.borderWidth,
        },
      }
      useLayerEditStore.getState().beginEdit(
        layerId,
        lf.dataId,
        geomType as 'point' | 'line' | 'polygon' | 'mixed',
        features,
        baseStyle,
        { version },
      )
    } catch (e) {
      console.warn('[CesiumEdit] ensureWorkspace failed', layerId, e)
    } finally {
      this.loadingId = null
    }
  }

  /** 当前 layerFiles（由 CesiumMap 注入；默认空） */
  private currentLayerFiles(): any[] {
    return ((window as unknown as Record<string, unknown>).__nptLayerFiles as any[]) ?? []
  }

  clearSelection(): void {
    this.shapeSelected.clear()
    this.selectedEditId = null
    this.render()
  }

  // ===== 渲染 =====
  private render() {
    const entities = this.dataSource.entities
    entities.removeAll()
    this.mirror.clear()
    if (!this.activeId) return

    const ws = this.store.getWorkspace(this.activeId)
    if (!ws) return
    const drawTool = this.store.drawTool

    for (const feat of ws.features as EditFeature[]) {
      const editId = editIdOf(feat)
      const wgsGeom = transformGeometry(feat.geometry)
      this.mirror.set(editId, wgsGeom)
      const isShapeSel = this.shapeSelected.has(editId)
      const isSelected = this.selectedEditId === editId
      this.addFeatureEntities(editId, wgsGeom, {
        isShapeSel, isSelected, faded: drawTool !== 'none' && !isShapeSel,
      })
    }

    // 选中要素的顶点把手
    if (this.selectedEditId && this.store.drawTool === 'none') {
      const geom = this.mirror.get(this.selectedEditId)
      if (geom) this.addVertexHandles(this.selectedEditId, geom)
    }

    // 绘制临时橡皮筋
    if (this.isDrawingLineOrPolygon() || (this.drawPoints.length === 1)) {
      this.addDrawPreview()
    }

    // 框选矩形预览
    if (this.marqueeStart && this.marqueeEnd) {
      this.addMarqueePreview()
    }
  }

  /** 框选矩形（WGS84） */
  private addMarqueePreview() {
    const C = this.C
    const a = this.marqueeStart!, b = this.marqueeEnd!
    const west = Math.min(a[0], b[0]), east = Math.max(a[0], b[0])
    const south = Math.min(a[1], b[1]), north = Math.max(a[1], b[1])
    const coords: Pos[] = [
      [west, south], [east, south], [east, north], [west, north], [west, south],
    ]
    const positions = C.Cartesian3.fromDegreesArray(coords.flatMap((p) => p))
    this.dataSource.entities.add(new C.Entity({
      polyline: {
        positions, width: 2,
        material: C.Color.fromCssColorString('#22c55e'), clampToGround: true,
      },
    }))
  }

  private addFeatureEntities(editId: string, geom: any, st: {
    isShapeSel: boolean; isSelected: boolean; faded: boolean
  }) {
    const C = this.C
    const stroke = st.isShapeSel ? '#f97316' : st.isSelected ? '#ef4444' : '#3b82f6'
    const common = (entity: any) => {
      entity.featEditId = editId
      this.dataSource.entities.add(entity)
    }

    if (geom.type === 'Point') {
      common(new C.Entity({
        position: C.Cartesian3.fromDegrees(geom.coordinates[0], geom.coordinates[1]),
        point: {
          pixelSize: 12,
          color: C.Color.fromCssColorString(stroke),
          outlineColor: C.Color.WHITE, outlineWidth: 2,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }))
      return
    }
    if (geom.type === 'LineString') {
      common(new C.Entity({
        polyline: {
          positions: C.Cartesian3.fromDegreesArray(geom.coordinates.flatMap((p: Pos) => p)),
          width: 3, material: C.Color.fromCssColorString(stroke), clampToGround: true,
        },
      }))
      return
    }
    if (geom.type === 'Polygon') {
      const ring = geom.coordinates[0]
      const positions = C.Cartesian3.fromDegreesArray(ring.flatMap((p: Pos) => p))
      common(new C.Entity({
        polygon: {
          hierarchy: new C.PolygonHierarchy(positions),
          material: C.Color.fromCssColorString(stroke).withAlpha(st.faded ? 0.2 : 0.35),
          clampToGround: true,
        },
      }))
      common(new C.Entity({
        polyline: {
          positions, width: 2, material: C.Color.fromCssColorString(stroke), clampToGround: true,
        },
      }))
    }
  }

  private addVertexHandles(editId: string, geom: any) {
    const C = this.C
    let pts: Pos[] = []
    if (geom.type === 'Point') pts = [geom.coordinates]
    else if (geom.type === 'LineString') pts = geom.coordinates
    else if (geom.type === 'Polygon') pts = geom.coordinates[0]
    pts.forEach((p, index) => {
      const entity = new C.Entity({
        position: C.Cartesian3.fromDegrees(p[0], p[1]),
        point: {
          pixelSize: 10,
          color: C.Color.WHITE,
          outlineColor: C.Color.fromCssColorString('#f97316'), outlineWidth: 2,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
      entity.handleEditId = editId
      entity.handleVertexIndex = index
      this.dataSource.entities.add(entity)
    })
  }

  private addDrawPreview() {
    const C = this.C
    const tool = this.store.drawTool
    // drawPoints 是 GCJ02：转 WGS84 预览
    const wgsPts = this.drawPoints.map((p) => {
      const [lat, lng] = gcj02ToWgs84(p[1], p[0])
      return [lng, lat] as Pos
    })
    if (wgsPts.length === 0) return

    if (tool === 'line') {
      const positions = C.Cartesian3.fromDegreesArray(wgsPts.flatMap((p) => p))
      this.dataSource.entities.add(new C.Entity({
        polyline: { positions, width: 3, material: C.Color.fromCssColorString('#22c55e'), clampToGround: true },
      }))
    } else if (tool === 'polygon') {
      const closed = [...wgsPts, wgsPts[0]]
      const positions = C.Cartesian3.fromDegreesArray(closed.flatMap((p) => p))
      this.dataSource.entities.add(new C.Entity({
        polygon: {
          hierarchy: new C.PolygonHierarchy(positions),
          material: C.Color.fromCssColorString('#22c55e').withAlpha(0.3), clampToGround: true,
        },
      }))
    }

    // 顶点标记
    wgsPts.forEach((p) => {
      this.dataSource.entities.add(new C.Entity({
        position: C.Cartesian3.fromDegrees(p[0], p[1]),
        point: {
          pixelSize: 8, color: C.Color.fromCssColorString('#22c55e'),
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }))
    })
  }

  destroy() {
    document.removeEventListener('keydown', this.boundKeyDown)
    try { this.handler.destroy() } catch { /* ignore */ }
    this.unsub()
    this.viewer.dataSources.remove(this.dataSource)
  }
}
