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

type Position = number[]

interface GeoFeature {
  type: string
  geometry?: { type: string; coordinates: unknown }
  properties?: Record<string, unknown>
}
interface FeatureCollection {
  features: GeoFeature[]
}

export interface LayerBaseStyle {
  fillColor?: string
  fillOpacity?: number
  borderColor?: string
  borderWidth?: number
  pointSize?: number
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
  readonly dataSource: any
  private fc: FeatureCollection = { features: [] }
  private visible = true
  private color: LayerColorSettings | null = null
  private base: LayerBaseStyle = {}
  private labelEnabled = false
  private label: LabelSettings | null = null
  private thematic: ThematicSettings | null = null
  private selectionIds: Set<string> | null = null

  private viewer: any
  /** 本次渲染创建的批量图元（面/线/点/标签各 1 个），重建时整体移除 */
  private primitives: any[] = []

  constructor(private C: any, viewer: any, readonly layerId: string) {
    this.viewer = viewer
    this.dataSource = new C.CustomDataSource('layer-' + layerId)
    viewer.dataSources.add(this.dataSource)
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
    this.clearPrimitives()
    try { this.viewer?.dataSources?.remove(this.dataSource) } catch { /* ignore */ }
  }

  setFeatureCollection(fc: FeatureCollection): void {
    this.fc = fc
    this.render()
  }
  /** 当前要素集合（WGS84）——供圈选/点选按几何收集命中要素 */
  getFeatures(): GeoFeature[] {
    return this.fc.features
  }
  setVisible(visible: boolean): void {
    this.visible = visible
    this.render()
  }
  setColorSettings(color: LayerColorSettings | null): void {
    this.color = color
    this.render()
  }
  setBaseStyle(base: LayerBaseStyle): void {
    this.base = base
  }
  setLabel(enabled: boolean, label: LabelSettings | null): void {
    this.labelEnabled = enabled
    this.label = label
    this.render()
  }
  setThematic(thematic: ThematicSettings | null): void {
    this.thematic = thematic
    this.render()
  }
  setSelectionIds(ids: Set<string> | null): void {
    this.selectionIds = ids
    this.render()
  }

  /** 批量更新配置（合并后只 render 一次，避免连续 setter 各触发一次重建） */
  applyConfig(cfg: {
    visible?: boolean
    color?: LayerColorSettings | null
    base?: LayerBaseStyle
    thematic?: ThematicSettings | null
    labelEnabled?: boolean
    label?: LabelSettings | null
  }): void {
    if (cfg.base) this.base = cfg.base
    if (cfg.visible !== undefined) this.visible = cfg.visible
    if (cfg.color !== undefined) this.color = cfg.color
    if (cfg.thematic !== undefined) this.thematic = cfg.thematic
    if (cfg.labelEnabled !== undefined) this.labelEnabled = cfg.labelEnabled
    if (cfg.label !== undefined) this.label = cfg.label
    this.render()
  }

  /**
   * 单要素最终配色。
   *
   * 合并优先级与 2D `MapInfoLayer` 完全一致：
   * **默认样式 < 文件自带 `_style` < 图层级用户设置(colorSettings) < 专题**。
   * 早先只认用户设置与默认值，文件自带的配色（MapInfo 符号色 / KML 样式）全部丢失，
   * 于是 3D 里"图层文件"显示成了默认色而不是原有配色。
   */
  private resolveFeatureStyle(feature: GeoFeature, kind: GeomKind): ResolvedFeatureStyle {
    const fs = (((feature.properties ?? {}) as Record<string, unknown>)._style ?? {}) as FeatureStyle
    const user = this.color
    const base = this.base
    const def = DEFAULT_BY_KIND[kind]

    // 用户设置的"图形颜色"（面/点填充、线的颜色来源）
    const userFill = user?.fillColor ?? base.fillColor

    let fillColor: string
    let strokeColor: string
    let strokeOpacity: number

    if (kind === 'line') {
      // 线无填充：用户设置里线色取"图形颜色"，兼容旧版把线色存在 borderColor
      const userLineColor = user?.borderColor && user.borderColor !== NO_FILL_COLOR
        ? user.borderColor
        : userFill
      fillColor = userLineColor ?? fs.strokeColor ?? base.borderColor ?? def.stroke
      strokeColor = fillColor
      strokeOpacity = user?.fillOpacity ?? fs.strokeOpacity ?? fs.fillOpacity ?? base.fillOpacity ?? def.fillOpacity
    } else {
      fillColor = userFill ?? fs.fillColor ?? fs.markerColor ?? def.fill
      strokeColor = user?.borderColor ?? fs.strokeColor ?? base.borderColor ?? def.stroke
      strokeOpacity = user?.fillOpacity ?? fs.strokeOpacity ?? base.fillOpacity ?? def.fillOpacity
    }

    let fillOpacity = user?.fillOpacity ?? fs.fillOpacity ?? base.fillOpacity ?? def.fillOpacity
    const strokeWidth = user?.borderWidth ?? fs.strokeWidth ?? base.borderWidth ?? def.width
    const pointSize = user?.pointSize ?? fs.markerSize ?? base.pointSize ?? def.pointSize

    // 专题：填充色/透明度/边框色覆盖（与 2D 的专题优先级一致）
    if (this.thematic?.enabled) {
      if (this.thematic.field && feature.properties) {
        const c = matchThematicColor(
          this.thematic, getFieldValue(feature.properties, this.thematic.field))
        if (c) { fillColor = c; if (kind === 'line') strokeColor = c }
      }
      if (typeof this.thematic.fillOpacity === 'number') fillOpacity = this.thematic.fillOpacity
      if (this.thematic.borderColor) strokeColor = this.thematic.borderColor
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
    this.dataSource.entities.removeAll()
    if (!this.visible) return

    // 批量容器：面 / 线 / 点 / 标签各合成一个图元。
    // 逐 Entity 的写法在图层要素上千时，每次配置变化都要重建上千个 Entity（PropertyBag +
    // 集合事件 + 逐实体图元），是 3D 加载自有图层后卡顿的主因。
    const polygons: any[] = []
    const polylines: any[] = []
    const points: Array<{ opts: any; id: any }> = []
    const labels: Array<{ opts: any; id: any }> = []

    for (let fi = 0; fi < this.fc.features.length; fi++) {
      const feature = this.fc.features[fi]
      if (!feature.geometry) continue
      const g = feature.geometry
      const geomKind: GeomKind = g.type === 'Point' || g.type === 'MultiPoint'
        ? 'point'
        : (g.type === 'LineString' || g.type === 'MultiLineString') ? 'line' : 'polygon'
      const st = this.resolveFeatureStyle(feature, geomKind)
      const selected = this.selectionIds?.has(featureSelectionId(feature.properties, fi))
      const strokeCss = selected ? '#ef4444' : st.strokeColor
      const strokeW = selected ? st.strokeWidth + 2 : st.strokeWidth
      const drawStroke = selected || !st.noStroke

      // 拾取用标识：批量图元把它挂在 GeometryInstance.id / 图元 .id 上
      const pickId = { feature, layerId: this.layerId }

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
            if (!st.noFill) {
              polygons.push(new C.GeometryInstance({
                geometry: new C.PolygonGeometry({
                  polygonHierarchy: new C.PolygonHierarchy(positions),
                  vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
                }),
                attributes: {
                  color: C.ColorGeometryInstanceAttribute.fromColor(
                    C.Color.fromCssColorString(st.fillColor).withAlpha(st.fillOpacity)),
                },
                id: pickId,
              }))
            }
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

      // 标签
      if (this.labelEnabled && this.label && feature.properties) {
        const anchor = geometryAnchor(g)
        if (anchor) {
          const value = getFieldValue(feature.properties, this.label.content)
          const text = value === undefined || value === null ? '' : String(value)
          if (text) {
            const ls = this.label
            labels.push({
              id: pickId,
              opts: {
                position: C.Cartesian3.fromDegrees(anchor[0], anchor[1]),
                text,
                font: `${ls.bold ? 'bold ' : ''}${ls.italic ? 'italic ' : ''}${ls.fontSize || 12}px ${ls.fontFamily || 'sans-serif'}`,
                fillColor: C.Color.fromCssColorString(ls.color || '#000000'),
                showBackground: !!ls.background,
                backgroundColor: C.Color.fromCssColorString(ls.backgroundColor || '#ffffff').withAlpha(0.85),
                style: C.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new C.Cartesian2(0, -6),
                verticalOrigin: C.VerticalOrigin.BOTTOM,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            })
          }
        }
      }
    }

    const collection = this.viewer?.scene?.primitives
    if (!collection) return
    try {
      if (polygons.length > 0) {
        this.primitives.push(collection.add(new C.GroundPrimitive({
          geometryInstances: polygons,
          appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true }),
          asynchronous: false,
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
      if (labels.length > 0) {
        const coll = new C.LabelCollection()
        for (const l of labels) coll.add({ ...l.opts, id: l.id })
        this.primitives.push(collection.add(coll))
      }
    } catch (e) {
      // 设备不支持贴地图元等情况下不让整层崩掉
      console.warn('[CesiumGeoJsonLayer] 批量图元创建失败:', e)
      this.clearPrimitives()
    }
  }
}
