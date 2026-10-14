/**
 * Cesium 图层文件渲染器（一个图层文件 = 一个 CustomDataSource）。
 *
 * 数据：已转 WGS84 的 GeoJSON FeatureCollection。
 * 对等 MapInfoLayer / GeoDataLayer 的图层级能力：
 * - 点（固定像素圆点，黑边）/ 线（贴地线）/ 面（贴地面 + 贴地边框线）
 * - 颜色设置（colorSettings）、专题配色（per feature）、标签、选中红框
 * - 「无色」填充（NO_FILL_COLOR）：只画边框
 */
import {
  getFieldValue,
  matchThematicColor,
  NO_FILL_COLOR,
} from '../../../utils/fieldValue'
import type { LayerColorSettings, LabelSettings, ThematicSettings } from '../LabelSettingsModal'
import { geometryAnchor, polygonOuterRings, featureSelectionId } from './cesiumGeoJson'
import { sameSelection, type CameraView } from './CesiumSectorLayer'
import type { LabelCandidateBase } from '../labelLayoutCore'

/** 单图层的标签候选上限（按离视野中心近的优先保留） */
const MAX_LABEL_CANDIDATES = 2000
/**
 * 选中态描边色（与 2D `setSelectionHighlight` 的 `color:'#ef4444'` 同色）。
 * 2D 只改描边、不动填充，3D 同口径 —— 见 render() 里的说明。
 */
const SELECTED_STROKE_COLOR = '#ef4444'
/** 选中态描边加粗量（2D 是 weight:3，这里在要素描边宽基础上 +2） */
const SELECTED_STROKE_EXTRA = 2
/** 选中态描边的最小像素宽（对齐 2D 的 weight:3） */
const SELECTED_STROKE_MIN_PX = 3
/** Web Mercator zoom 0 赤道处每像素米数（与 CesiumSectorLayer 同式） */
const EQUATOR_MPP = 156543.03392
import { computeThematicStats, type ThematicStats } from '../../../utils/thematicStats'

type Position = number[]

interface GeoFeature {
  type: string
  geometry?: { type: string; coordinates: unknown }
  properties?: Record<string, unknown>
}
interface FeatureCollection {
  features: GeoFeature[]
}

/**
 * 要素自带样式：后端从 TAB/MIF/KML 逐要素读出后注入到 `properties._style`（扁平结构）。
 * 字段口径见 `backend/app/services/mapinfo_service.py`（`properties['_style'] = style_info`）。
 */
interface FeatureStyle {
  /** 点：图形颜色 */
  markerColor?: string
  /** 点：图形大小（半径） */
  markerSize?: number
  strokeColor?: string
  strokeWidth?: number
  strokeOpacity?: number
  fillColor?: string
  fillOpacity?: number
  /** KML `<fill>0</fill>`：文件声明无填充 */
  fill?: boolean
}

type GeomKind = 'point' | 'line' | 'polygon'

/** 与 2D `MapInfoLayer.DEFAULT_STYLES` 一致的默认值 */
const DEFAULT_BY_KIND: Record<GeomKind, {
  fill: string; stroke: string; width: number; fillOpacity: number; pointSize: number
}> = {
  point: { fill: '#f59e0b', stroke: NO_FILL_COLOR, width: 2, fillOpacity: 0.8, pointSize: 6 },
  line: { fill: '#8b5cf6', stroke: '#8b5cf6', width: 3, fillOpacity: 1, pointSize: 0 },
  polygon: { fill: '#10b981', stroke: '#10b981', width: 2, fillOpacity: 0.3, pointSize: 0 },
}

/** 单要素最终配色 */
interface ResolvedFeatureStyle {
  fillColor: string
  fillOpacity: number
  noFill: boolean
  strokeColor: string
  strokeWidth: number
  noStroke: boolean
  /** 线/点透明度（作用于描边） */
  strokeOpacity: number
  pointSize: number
}

export class CesiumGeoJsonLayer {
  private fc: FeatureCollection = { features: [] }
  private visible = true
  private color: LayerColorSettings | null = null
  private labelEnabled = false
  private label: LabelSettings | null = null
  private thematic: ThematicSettings | null = null
  private selectionIds: Set<string> | null = null
  /** 最近一次推送的视野（选中描边按像素宽换算时用） */
  private view: CameraView | null = null

  private viewer: any
  /** 本次渲染创建的批量图元（面/线/点各 1 个），重建时整体移除 */
  private primitives: any[] = []
  /**
   * 重建序号：每次「请求重建」或「立即重建」都 +1，挂起的 rAF 回调序号对不上就放弃。
   * 用来合并同一帧内的多次配置变更——后面那次会覆盖前面那次，避免重复重建。
   */
  private renderSeq = 0

  constructor(private C: any, viewer: any, readonly layerId: string) {
    this.viewer = viewer
  }

  /** 移除本次渲染的批量图元 */
  private clearPrimitives(): void {
    const collection = this.viewer?.scene?.primitives
    if (!collection) return
    for (const p of this.primitives) {
      try { collection.remove(p) } catch { /* ignore */ }
    }
    this.primitives = []
  }

  /** 图层卸载：释放图元 */
  destroy(): void {
    this.renderSeq += 1 // 作废挂起中的重建
    this.clearPrimitives()
  }

  /**
   * 请求重建（rAF 合并）。
   * 连续多个 setter（可见性 → 配色 → 专题 → 标签 → 选中）原来会各自触发一次全量重建，
   * 上千要素时等于同一帧重建四五遍。合并后一帧只重建一次，也避免在调用栈里同步增删
   * `scene.primitives`（Cesium 在集合被改的瞬间迭代会抛 `_target` 相关错误）。
   */
  private requestRender(): void {
    const seq = ++this.renderSeq
    requestAnimationFrame(() => {
      if (seq !== this.renderSeq) return // 已被后续一次重建覆盖
      this.render()
    })
  }

  /**
   * 换数据立即重建（同步）。
   * 取数完成的时机天然低频，且上层的要素收集/热力取点紧接着就要用新的要素集合，
   * 推迟到下一帧会让这些读路径拿到旧数据。
   */
  setFeatureCollection(fc: FeatureCollection): void {
    this.fc = fc
    this.renderSeq += 1 // 作废挂起中的重建，避免紧随其后又重建一遍
    this.render()
  }
  /** 当前要素集合（WGS84）——供圈选/点选按几何收集命中要素 */
  getFeatures(): GeoFeature[] {
    return this.fc.features
  }

  /** 专题图例统计（与 2D 同算法，保证两边图例数字一致） */
  getThematicStats(): ThematicStats | null {
    return computeThematicStats(
      this.thematic,
      this.fc.features.map((f) => (f.properties ?? {}) as Record<string, any>))
  }
  isVisible(): boolean {
    return this.visible
  }
  setVisible(visible: boolean): void {
    this.visible = visible
    this.requestRender()
  }
  setColorSettings(color: LayerColorSettings | null): void {
    this.color = color
    this.requestRender()
  }
  setLabel(enabled: boolean, label: LabelSettings | null): void {
    this.labelEnabled = enabled
    this.label = label
    this.requestRender()
  }
  setThematic(thematic: ThematicSettings | null): void {
    this.thematic = thematic
    this.requestRender()
  }
  /**
   * 选中集合（+ 当前视野）。
   *
   * 宿主 `syncAll()` 每次相机停下都会重推一遍，所以：
   * - 集合没变就**直接返回**，不再重建 —— 否则每次平移/缩放后都要把上千个要素的
   *   贴地图元全量重建一遍，是"缩放/平移卡顿"的主要来源之一
   * - 视野随推送一起更新：选中描边要按"当前米/像素"换算成像素宽（见 render 里的说明）
   */
  setSelectionIds(ids: Set<string> | null, view?: CameraView | null): void {
    if (view !== undefined) this.view = view
    if (sameSelection(this.selectionIds, ids)) return
    this.selectionIds = ids
    this.requestRender()
  }

  /** 视野中心处的米/像素（Web Mercator）——选中描边按像素宽换算时用 */
  private metersPerPixel(): number {
    const v = this.view
    if (!v) return 1
    const cLat = (v.south + v.north) / 2
    return (EQUATOR_MPP * Math.cos((cLat * Math.PI) / 180)) / Math.pow(2, v.zoom)
  }

  /**
   * 本图层当前的标签候选（WGS84）。
   * 与扇区层同口径：交给 `CesiumLabelOverlay` 统一防重叠绘制，不再建 Cesium 标签图元。
   *
   * **必须先按视口裁剪**：地理化数据常有几万个点，不裁剪的话全量候选会在覆盖层被
   * "候选上限"按要素顺序截断 —— 于是放大地图后，视口内的要素反而一个标签都没有。
   * 超过上限时按"离视野中心近的优先"保留（与扇区层 sampleCenteredOn 同思路）。
   */
  labelCandidates(view: CameraView | null): LabelCandidateBase[] {
    if (!this.visible || !this.labelEnabled || !this.label) return []
    const ls = this.label
    // 视口外扩 15%（与 CesiumSectorLayer.pickSectors 同口径）
    let south = -90, north = 90, west = -180, east = 180
    let cLat = 0, cLng = 0
    if (view) {
      const padLat = (view.north - view.south) * 0.15
      const padLng = (view.east - view.west) * 0.15
      south = view.south - padLat
      north = view.north + padLat
      west = view.west - padLng
      east = view.east + padLng
      cLat = (view.south + view.north) / 2
      cLng = (view.west + view.east) / 2
    }
    const out: LabelCandidateBase[] = []
    for (let fi = 0; fi < this.fc.features.length; fi++) {
      const f = this.fc.features[fi]
      if (!f.geometry || !f.properties) continue
      const anchor = geometryAnchor(f.geometry)
      if (!anchor) continue
      const lng = anchor[0]
      const lat = anchor[1]
      if (lng < west || lng > east || lat < south || lat > north) continue
      const value = getFieldValue(f.properties, ls.content)
      if (value === undefined || value === null) continue
      const text = String(value)
      if (!text) continue
      const sid = featureSelectionId(f.properties, fi)
      out.push({
        id: sid,
        lat,
        lng,
        text,
        fontSize: ls.fontSize || 12,
        fontFamily: ls.fontFamily,
        bold: ls.bold,
        italic: ls.italic,
        shadow: ls.shadow,
        background: ls.background,
        backgroundColor: ls.backgroundColor,
        color: ls.color || '#000000',
        priority: this.selectionIds?.has(sid) ? 10 : 0,
      })
    }
    if (out.length <= MAX_LABEL_CANDIDATES) return out
    return out
      .map((c) => ({ c, d: (c.lat - cLat) ** 2 + (c.lng - cLng) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_LABEL_CANDIDATES)
      .map((e) => e.c)
  }

  /** 批量更新配置（合并后只 render 一次，避免连续 setter 各触发一次重建） */
  applyConfig(cfg: {
    visible?: boolean
    color?: LayerColorSettings | null
    thematic?: ThematicSettings | null
    labelEnabled?: boolean
    label?: LabelSettings | null
  }): void {
    if (cfg.visible !== undefined) this.visible = cfg.visible
    if (cfg.color !== undefined) this.color = cfg.color
    if (cfg.thematic !== undefined) this.thematic = cfg.thematic
    if (cfg.labelEnabled !== undefined) this.labelEnabled = cfg.labelEnabled
    if (cfg.label !== undefined) this.label = cfg.label
    this.requestRender()
  }

  /**
   * 单要素最终配色。
   *
   * 合并优先级与 2D `MapInfoLayer` **完全一致**：
   * **渲染默认值 < 要素自带 `_style` < 图层级用户设置(colorSettings) < 专题**。
   *
   * 关键：**`defaultStyle`（字段 `base`）不参与渲染配色**。
   * 后端 `MapInfoParser._get_layer_default_style` 在命名规则未命中时会用
   * `_palette_color(图层名)` 返回**按图层名固定的一种颜色**（`mapinfo_service.py:1419-1428`）。
   * 早先这里写的是 `user ?? base ?? _style ?? def`，那一层 `base` 会无条件盖掉
   * 逐要素的 `_style`（MapInfo 各要素 Brush/Pen 色、KML <Style>、RSRP 分级色…），
   * 表现就是「整层被刷成同一种颜色」——例如按 RSRP 分级着色的多段配色全变绿。
   * 2D 从来不把 `defaultStyle` 放进渲染链（它只在图层控制里作为颜色设置弹窗的初始值出现），
   * 这里保持同口径即可让 3D 与 2D 一致。
   */
  private resolveFeatureStyle(feature: GeoFeature, kind: GeomKind): ResolvedFeatureStyle {
    const fs = (((feature.properties ?? {}) as Record<string, unknown>)._style ?? {}) as FeatureStyle
    const user = this.color
    const def = DEFAULT_BY_KIND[kind]

    // 用户设置的"图形颜色"（面/点填充、线的颜色来源）
    const userFill = user?.fillColor

    let fillColor: string
    let strokeColor: string
    let strokeOpacity: number

    if (kind === 'line') {
      // 线无填充：用户设置里线色取"图形颜色"，兼容旧版把线色存在 borderColor
      const userLineColor = user?.borderColor && user.borderColor !== NO_FILL_COLOR
        ? user.borderColor
        : userFill
      fillColor = userLineColor ?? fs.strokeColor ?? def.stroke
      strokeColor = fillColor
      strokeOpacity = user?.fillOpacity ?? fs.strokeOpacity ?? fs.fillOpacity ?? def.fillOpacity
    } else {
      fillColor = userFill ?? fs.fillColor ?? fs.markerColor ?? def.fill
      strokeColor = user?.borderColor ?? fs.strokeColor ?? def.stroke
      strokeOpacity = user?.fillOpacity ?? fs.strokeOpacity ?? def.fillOpacity
    }

    let fillOpacity = user?.fillOpacity ?? fs.fillOpacity ?? def.fillOpacity
    let strokeWidth = user?.borderWidth ?? fs.strokeWidth ?? def.width
    let pointSize = user?.pointSize ?? fs.markerSize ?? def.pointSize

    // 专题：填充色/透明度/边框色/图形大小覆盖（与 2D 的专题优先级一致）
    if (this.thematic?.enabled) {
      if (this.thematic.field && feature.properties) {
        const c = matchThematicColor(
          this.thematic, getFieldValue(feature.properties, this.thematic.field))
        if (c) { fillColor = c; if (kind === 'line') strokeColor = c }
      }
      if (typeof this.thematic.fillOpacity === 'number') fillOpacity = this.thematic.fillOpacity
      if (this.thematic.borderColor) strokeColor = this.thematic.borderColor
      // 「图形大小」：点要素=点大小，线/面=边框宽度（2D MapInfoLayer / GeoDataLayer 同语义）
      if (typeof this.thematic.pointSize === 'number') {
        if (kind === 'point') pointSize = this.thematic.pointSize
        else strokeWidth = this.thematic.pointSize
      }
    }

    // KML 声明无填充且用户未自定义 → 不填充（只画边框）
    const noFill = fillColor === NO_FILL_COLOR
      || (kind !== 'line' && fs.fill === false && userFill === undefined)
    // 边框色为"无色"哨兵 → 不描边
    const noStroke = strokeColor === NO_FILL_COLOR

    return {
      fillColor: fillColor === NO_FILL_COLOR ? def.fill : fillColor,
      fillOpacity,
      noFill,
      strokeColor: noStroke ? def.stroke : strokeColor,
      strokeWidth,
      noStroke,
      strokeOpacity,
      pointSize,
    }
  }

  private render(): void {
    const C = this.C
    this.clearPrimitives()
    if (!this.visible) return

    // 批量容器：面 / 线 / 点 各合成一个图元（标签改由 CesiumLabelOverlay 统一绘制）。
    // 逐 Entity 的写法在图层要素上千时，每次配置变化都要重建上千个 Entity（PropertyBag +
    // 集合事件 + 逐实体图元），是 3D 加载自有图层后卡顿的主因。
    const polygons: any[] = []
    const polylines: any[] = []
    const points: Array<{ opts: any; id: any }> = []

    for (let fi = 0; fi < this.fc.features.length; fi++) {
      const feature = this.fc.features[fi]
      if (!feature.geometry) continue
      const g = feature.geometry
      const geomKind: GeomKind = g.type === 'Point' || g.type === 'MultiPoint'
        ? 'point'
        : (g.type === 'LineString' || g.type === 'MultiLineString') ? 'line' : 'polygon'
      const st = this.resolveFeatureStyle(feature, geomKind)
      const selected = this.selectionIds?.has(featureSelectionId(feature.properties, fi))
      const strokeCss = selected ? SELECTED_STROKE_COLOR : st.strokeColor
      /**
       * 选中态描边必须有**最小像素宽**。
       *
       * `GroundPolylineGeometry.width` 的单位是**米**（几何在 worker 里构建，拿不到相机，
       * 所以只能是物理单位），而 2D 的 `weight:3` 是像素。直接把 `strokeWidth` 当米用，
       * 在常用 zoom 下（1px ≈ 数米）边框会细到看不见 —— 选中就"点了没反应"。
       * 这里对选中态按当前米/像素换算，保证至少 `SELECTED_STROKE_MIN_PX` 像素宽。
       * 未选中态维持原样（既有的"米"口径），避免牵动所有图层的观感。
       */
      const strokeW = selected
        ? Math.max(st.strokeWidth + SELECTED_STROKE_EXTRA,
          SELECTED_STROKE_MIN_PX * this.metersPerPixel())
        : st.strokeWidth
      const drawStroke = selected || !st.noStroke

      // 拾取用标识：批量图元把它挂在 GeometryInstance.id / 图元 .id 上。
      // `selectionId` 必须带出来：点选高亮按它写选中态，而图层要素普遍没有 properties.id，
      // 早先宿主用 `properties.id` 兜出空字符串 → 点选后"没有任何高亮"。
      const pickId = {
        feature,
        layerId: this.layerId,
        selectionId: featureSelectionId(feature.properties, fi),
      }

      switch (g.type) {
        case 'Point':
        case 'MultiPoint': {
          const pts: Position[] = g.type === 'Point'
            ? [g.coordinates as Position]
            : (g.coordinates as Position[])
          for (const p of pts) {
            points.push({
              id: pickId,
              opts: {
                position: C.Cartesian3.fromDegrees(p[0], p[1]),
                pixelSize: st.pointSize,
                color: C.Color.fromCssColorString(st.fillColor)
                  .withAlpha(st.noFill ? 0 : st.fillOpacity),
                outlineColor: C.Color.fromCssColorString(strokeCss),
                outlineWidth: st.noStroke && !selected ? 0 : strokeW,
                // PointPrimitive 无 heightReference，用"始终画在最上层"达到同等可见性
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            })
          }
          break
        }
        case 'LineString':
        case 'MultiLineString': {
          const lines: Position[][] = g.type === 'LineString'
            ? [g.coordinates as Position[]]
            : (g.coordinates as Position[][])
          for (const line of lines) {
            if (line.length < 2) continue
            polylines.push(new C.GeometryInstance({
              geometry: new C.GroundPolylineGeometry({
                positions: C.Cartesian3.fromDegreesArray(line.flatMap((p) => p)),
                width: strokeW,
              }),
              attributes: {
                color: C.ColorGeometryInstanceAttribute.fromColor(
                  C.Color.fromCssColorString(strokeCss).withAlpha(st.strokeOpacity)),
              },
              id: pickId,
            }))
          }
          break
        }
        case 'Polygon':
        case 'MultiPolygon': {
          const rings = polygonOuterRings(g)
          for (const ring of rings) {
            if (ring.length < 3) continue
            const positions = C.Cartesian3.fromDegreesArray(ring.flatMap((p) => p))
            /**
             * 面图元**始终**建（"无色填充"时给一个近乎全透明的 alpha）。
             *
             * 面图元同时承担"点击命中区域"的职责：不建面就只剩贴地边框线，而线的命中宽度
             * 只有几个像素 —— 表现为"透明填充的多边形点内部没反应，只能点中边框"。
             * 视觉上 alpha 0.01 与无填充没有区别，但 `scene.pick` 就能拾到整个面了
             * （`scene.pick` 本来就拾取半透明/贴地面，不需要 `pickTranslucentDepth`；
             * 那个开关只影响 `pickPosition`，且会引入缩放崩溃，见 CesiumMap 里的说明）。
             */
            polygons.push(new C.GeometryInstance({
              geometry: new C.PolygonGeometry({
                polygonHierarchy: new C.PolygonHierarchy(positions),
                vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
                /**
                 * 边走**恒向线**（RHUMB），不用默认的测地线（GEODESIC）。
                 *
                 * 2D（Leaflet）是在墨卡托投影平面里连直线，而墨卡托直线正对应球面的恒向线。
                 * 测地线在大跨度边上会相对墨卡托直线外鼓（1° 边约 180m、5° 边约 4.5km），
                 * 于是填充与贴地描边（`GroundPolylineGeometry` 是在经纬空间连直线，
                 * 即墨卡托直线）对不上 —— 填充鼓到图形外面去了。
                 */
                arcType: C.ArcType.RHUMB,
              }),
              attributes: {
                /**
                 * 选中态**只改描边，填充保持原色** —— 与 2D 完全同口径：
                 * `MapInfoLayer.setSelectionHighlight` / `GeoDataLayer.setSelectionHighlight`
                 * 都只是 `setStyle({ color:'#ef4444', weight:3 })`，动的是边框，
                 * `fillColor`/`fillOpacity` 一律保留。
                 *
                 * 早先这里给选中面整面铺一层半透明红（`SELECTED_FILL_*`），结果就是用户
                 * 报的"框内阴影有的超出图形框、有的空洞"：贴地面是分类（classification）
                 * 渲染，填充会被拖到 3D 建筑上（超出），也会被建筑/地形挡出缺口（空洞）；
                 * 而 2D 根本没有这层填充，所以按 2D 的做法做，问题从根上消失。
                 */
                color: C.ColorGeometryInstanceAttribute.fromColor(
                  C.Color.fromCssColorString(st.fillColor)
                    .withAlpha(st.noFill ? 0.01 : st.fillOpacity)),
              },
              id: pickId,
            }))
            // 贴地面不支持 outline，边框另画贴地线
            if (drawStroke) {
              polylines.push(new C.GeometryInstance({
                geometry: new C.GroundPolylineGeometry({ positions, width: strokeW }),
                attributes: {
                  color: C.ColorGeometryInstanceAttribute.fromColor(
                    C.Color.fromCssColorString(strokeCss)),
                },
                id: pickId,
              }))
            }
          }
          break
        }
        default:
          break
      }
    }

    const collection = this.viewer?.scene?.primitives
    if (!collection) return
    try {
      /**
       * `asynchronous` 必须为 `false`（同步构建）。
       *
       * 曾经改成 `true`（把三角化丢给 Web Worker）想省主线程，结果引入**渲染崩溃**：
       * 缩放/平移会连续触发重建，而重建是 `primitives.remove()` + 重新 `add()`。
       * 异步图元在 worker 还在跑时被移除，Cesium 内部拿着已销毁的纹理/批处理继续走
       * 渲染管线，抛 `TypeError: Cannot read properties of undefined (reading '_target')`，
       * `Scene` 直接停掉渲染循环 → 整个 3D 页面冻结。
       * 这里的重建虽有 rAF 合并，但缩放是持续事件，一秒内仍有数次 remove/add，
       * 竞态窗口足够大。同步构建没有这个窗口，代价只是重建时多占几十毫秒主线程。
       */
      if (polygons.length > 0) {
        this.primitives.push(collection.add(new C.GroundPrimitive({
          geometryInstances: polygons,
          appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true }),
          asynchronous: false,
          /**
           * **只贴地形，绝不贴 3D Tiles（建筑）** —— 这是"填充/选中阴影跑到图形外面"的根因。
           *
           * `GroundPrimitive` 走的是分类（classification）渲染：把几何体沿竖直方向
           * 拉伸成一个"体"，凡是落在这个体内的表面（默认 `ClassificationType.BOTH` =
           * 地形 **和** 3D Tiles）都会被涂上颜色。
           * 而体的上下界取自 `ApproximateTerrainHeights` —— 未初始化时是
           * **[-100km, +9km]**（`ApproximateTerrainHeights._defaultMin/MaxTerrainHeight`），
           * 也就是"这个多边形水平范围内的任何高度表面都算体内"。
           * 于是场景里常驻的 OSM 建筑（`createOsmBuildingsAsync`）整面被涂上面色：
           * 建筑墙面/屋顶在斜视下相对其地面轮廓有明显视差，看上去就是
           * "阴影不在图形区域内，飘到图形外面去了"。
           * 2D 没有建筑，面就是平铺在地图上 —— 限定 TERRAIN 才是对等口径。
           */
          classificationType: C.ClassificationType.TERRAIN,
        })))
      }
      if (polylines.length > 0) {
        this.primitives.push(collection.add(new C.GroundPolylinePrimitive({
          geometryInstances: polylines,
          appearance: new C.PolylineColorAppearance(),
          asynchronous: false,
        })))
      }
      if (points.length > 0) {
        const coll = new C.PointPrimitiveCollection()
        for (const p of points) coll.add({ ...p.opts, id: p.id })
        this.primitives.push(collection.add(coll))
      }
    } catch (e) {
      // 设备不支持贴地图元等情况下不让整层崩掉
      console.warn('[CesiumGeoJsonLayer] 批量图元创建失败:', e)
      this.clearPrimitives()
    }
  }
}
