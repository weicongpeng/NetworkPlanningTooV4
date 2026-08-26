/**
 * MapInfo 图层渲染器
 *
 * 功能:
 * - 渲染点要素（Point）
 * - 渲染线要素（LineString）
 * - 渲染面要素（Polygon）
 * - 使用 Leaflet GeoJSON 图层
 * - 坐标转换已由后端统一完成（WGS84 → GCJ-02）
 */
import L from 'leaflet'
import { extractFeatureId } from '../../utils/featureId'
import { GeoDataCanvasLabelLayer, CanvasLabelData } from './GeoDataCanvasLabelLayer'
import { getFieldValue, matchThematicColor, matchRangeIndex, hasValue } from '../../utils/fieldValue'
import type { ThematicSettings } from './LabelSettingsModal'

const IS_DEV = import.meta.env.DEV

/**
 * 图层要素类型
 */
export type LayerGeometryType = 'point' | 'line' | 'polygon'

/**
 * MapInfo 图层配置
 */
export interface MapInfoLayerOptions {
  /** 图层ID */
  id: string
  /** 图层名称 */
  name: string
  /** 几何类型 */
  type: LayerGeometryType
  /** GeoJSON 数据 */
  data: GeoJSON.FeatureCollection
  /** 数据集ID（用于重新加载数据） */
  dataId: string
  /** 是否可见 */
  visible?: boolean
  /** 样式配置 */
  style?: MapInfoLayerStyle
  /** 要素点击回调 */
  onFeatureClick?: (properties: any, event: L.LeafletMouseEvent) => void
}

/**
 * 图层样式配置
 */
export interface MapInfoLayerStyle {
  /** 点样式 */
  point?: {
    radius?: number
    fillColor?: string
    color?: string
    weight?: number
    opacity?: number
    fillOpacity?: number
  }
  /** 线样式 */
  line?: {
    color?: string
    weight?: number
    opacity?: number
    dashArray?: string
  }
  /** 面样式 */
  polygon?: {
    color?: string
    weight?: number
    opacity?: number
    dashArray?: string
    fillColor?: string
    fillOpacity?: number
  }
}

/**
 * 默认样式配置
 */
const DEFAULT_STYLES: Record<LayerGeometryType, any> = {
  point: {
    radius: 6,
    fillColor: '#f59e0b',
    color: '#fff',
    weight: 2,
    opacity: 1,
    fillOpacity: 0.8
  },
  line: {
    color: '#8b5cf6',
    weight: 3,
    opacity: 1
  },
  polygon: {
    color: '#10b981',
    weight: 2,
    opacity: 1,
    fillColor: '#10b981',
    fillOpacity: 0.3
  }
}

/**
 * MapInfo Symbol shape 编号 → 形状名（与后端 layer_service.POINT_SHAPE_MIF 一致）
 */
const MAPINFO_SYMBOL_SHAPES: Record<number, string> = {
  34: 'circle', 32: 'square', 33: 'diamond', 35: 'star',
  40: 'triangle', 41: 'triangle_down', 42: 'landmark', 38: 'pin'
}

const POINT_SHAPE_NAMES = ['circle', 'square', 'diamond', 'triangle', 'triangle_down', 'star', 'landmark', 'pin']

/**
 * 将后端 _style.markerSymbol（MapInfo Symbol 编号或形状名）解析为形状名；无形状信息返回 null
 */
function resolvePointShape(symbol: any): string | null {
  if (symbol === undefined || symbol === null || symbol === '') return null
  if (typeof symbol === 'string') {
    const s = symbol.toLowerCase()
    return POINT_SHAPE_NAMES.includes(s) ? s : null
  }
  const num = Number(symbol)
  if (!Number.isFinite(num)) return null
  return MAPINFO_SYMBOL_SHAPES[num] || null
}

/**
 * 生成点形状的 SVG Data URI（完全离线可用，与后端 layer_service.svg_point_icon 形状一致）
 */
function pointShapeIconDataUri(shape: string, color: string): string {
  const fill = color || '#f59e0b'
  const svgs: Record<string, string> = {
    circle: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12" fill="${fill}" stroke="#fff" stroke-width="2"/></svg>`,
    square: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="4" y="4" width="24" height="24" rx="2" fill="${fill}" stroke="#fff" stroke-width="2"/></svg>`,
    diamond: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="16,3 29,16 16,29 3,16" fill="${fill}" stroke="#fff" stroke-width="2"/></svg>`,
    triangle: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="16,3 29,29 3,29" fill="${fill}" stroke="#fff" stroke-width="2"/></svg>`,
    triangle_down: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="3,3 29,3 16,29" fill="${fill}" stroke="#fff" stroke-width="2"/></svg>`,
    star: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="16,2 19,11 29,11 21,17 24,27 16,21 8,27 11,17 3,11 13,11" fill="${fill}" stroke="#fff" stroke-width="2"/></svg>`,
    landmark: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M16 3 L28 10 L16 17 L4 10 Z" fill="${fill}" stroke="#fff" stroke-width="2"/><rect x="4" y="12" width="24" height="4" fill="${fill}" stroke="#fff" stroke-width="1"/><rect x="12" y="16" width="8" height="10" fill="${fill}" stroke="#fff" stroke-width="1"/></svg>`,
    pin: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M16 2 C9 2 4 7 4 14 C4 23 16 30 16 30 C16 30 28 23 28 14 C28 7 23 2 16 2 Z" fill="${fill}" stroke="#fff" stroke-width="2"/><circle cx="16" cy="13" r="4" fill="#fff"/></svg>`
  }
  const svg = svgs[shape] || svgs.circle
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

/**
 * MapInfo 图层类
 */
export class MapInfoLayer {
  private id: string
  private name: string
  private type: LayerGeometryType
  private geoJSONLayer: L.GeoJSON | null = null
  private canvasRenderer: L.Canvas | null = null // 独立 Canvas renderer（用于 z-order 置顶）
  private style: MapInfoLayerStyle
  // 专题图层设置（启用时优先于 style 基础配置；null 表示未启用）
  private thematicSettings: ThematicSettings | null = null
  // 专题区间统计（每个区间的要素数/总数，用于图例展示）
  private thematicStats: { counts: number[]; total: number; other: number } | null = null
  private static _debugPrinted: boolean = false

  // 标签相关属性
  private labelsEnabled: boolean = false
  private canvasLabelLayer: GeoDataCanvasLabelLayer | null = null  // Canvas 标签层（替代 DOM marker）
  private labelConfig: {
    content: string
    color: string
    fontSize: number
  }
  private currentZoom: number = 14
  private currentMap: L.Map | null = null  // 存储当前地图实例
  private onFeatureClickCallback?: (properties: any, event: L.LeafletMouseEvent) => void
  private isInteractive: boolean = true // 是否允许交互 (满足需求3)

  // 框选高亮配置
  private selectionHighlightIds: Set<string> | null = null

  constructor(options: MapInfoLayerOptions) {
    this.id = options.id
    this.name = options.name
    this.type = options.type
    this.style = options.style || {}

    // 初始化标签配置
    this.labelConfig = {
      content: 'name',
      color: '#000000',
      fontSize: 12
    }
    this.onFeatureClickCallback = options.onFeatureClick
    this.currentMap = null
  }

  /**
   * 获取底层的 Leaflet GeoJSON 图层
   * 用于直接控制图层的添加/移除
   */
  getLeafletLayer(): L.GeoJSON | null {
    return this.geoJSONLayer
  }

  /**
   * 获取圆圈内的要素
   *
   * 🔧 返回 { id, properties }：MIF/KML 图层的属性列名任意（如 GRID_ID、行政区名），
   * 很多要素提取不到自然 ID，此前直接返回 properties 导致上游 extractFeatureId 落空、
   * 要素被静默丢弃（表现为面状/点状图层圈选无效）。这里为每个要素返回构建时分配的
   * 稳定选择 ID（_nptSelectionId，自然 ID 或「图层ID#序号」兜底）。
   *
   * @param center 中心点 (渲染坐标/GCJ02)
   * @param radius 半径 (米)
   */
  getFeaturesInCircle(center: L.LatLng, radius: number): Array<{ id: string, properties: any }> {
    if (!this.geoJSONLayer) {
      if (IS_DEV) console.log('[MapInfoLayer] getFeaturesInCircle: geoJSONLayer不存在', this.id)
      return []
    }
    const results: Array<{ id: string, properties: any }> = []
    let layerCount = 0

    this.geoJSONLayer.eachLayer((layer: any) => {
      layerCount++
      const props = layer.feature?.properties
      if (!props) return
      const id = layer._nptSelectionId || extractFeatureId(props)
      if (!id) return

      if (layer.getLatLng) {
        const latlng = layer.getLatLng()
        const distance = center.distanceTo(latlng)
        if (distance <= radius) {
          results.push({ id: String(id), properties: props })
        }
      } else if (layer.getBounds) {
        // 线/面要素：圆与要素包围盒相交即选中。
        // 此前仅判断包围盒中心，圆只压到面的一部分（中心在圆外）时会漏选。
        if (this._circleIntersectsBounds(center, radius, layer.getBounds())) {
          results.push({ id: String(id), properties: props })
        }
      }
    })

    if (IS_DEV) console.log('[MapInfoLayer] getFeaturesInCircle:', {
      id: this.id,
      name: this.name,
      totalLayers: layerCount,
      matchedFeatures: results.length,
      radius
    })
    return results
  }

  /**
   * 判断圆与包围盒是否相交（线/面要素命中检测）
   * 取包围盒内距圆心最近的点，其到圆心距离 <= 半径即视为相交，
   * 避免圆只压到面/线的一部分（中心在圆外）时漏选。
   */
  private _circleIntersectsBounds(center: L.LatLng, radius: number, bounds: L.LatLngBounds): boolean {
    const nearestLat = Math.max(bounds.getSouth(), Math.min(center.lat, bounds.getNorth()))
    const nearestLng = Math.max(bounds.getWest(), Math.min(center.lng, bounds.getEast()))
    return center.distanceTo(L.latLng(nearestLat, nearestLng)) <= radius
  }

  /**
   * 获取多边形内的要素
   * @param polygon Leaflet 多边形对象 (坐标为渲染坐标/GCJ02)
   *
   * 🔧 与 getFeaturesInCircle 保持一致：返回 { id, properties }，
   * id 为构建时分配的 _nptSelectionId（自然 ID 或「图层ID#序号」兜底），
   * 保证 MIF/KML 任意属性列名下多边形/矩形框选也能命中。
   */
  getFeaturesInPolygon(polygon: L.Polygon): Array<{ id: string, properties: any }> {
    if (!this.geoJSONLayer) {
      console.log('[MapInfoLayer] getFeaturesInPolygon: geoJSONLayer不存在', this.id)
      return []
    }
    const results: Array<{ id: string, properties: any }> = []
    const bounds = polygon.getBounds()
    const points = (polygon.getLatLngs()[0] as L.LatLng[]).map(p => [p.lat, p.lng])
    let layerCount = 0

    console.log('[MapInfoLayer] getFeaturesInPolygon:', {
      id: this.id,
      name: this.name,
      polygonBounds: bounds,
      polygonPoints: points
    })

    this.geoJSONLayer.eachLayer((layer: any) => {
      layerCount++
      const props = layer.feature?.properties
      if (!props) return
      const id = layer._nptSelectionId || extractFeatureId(props)
      if (!id) return
      if (layer.getLatLng) {
        const latlng = layer.getLatLng()
        const inBounds = bounds.contains(latlng)
        const inPolygon = inBounds && this._isPointInPolygon([latlng.lat, latlng.lng], points)
        if (inPolygon) {
          results.push({ id: String(id), properties: props })
          console.log('[MapInfoLayer] 点要素在多边形内:', props.name || props.id, latlng)
        }
      } else if (layer.getBounds) {
        // 对于线和面，检查其边界中心是否在多边形内
        const layerBounds = layer.getBounds()
        const center = layerBounds.getCenter()
        const inBounds = bounds.contains(center)
        const inPolygon = inBounds && this._isPointInPolygon([center.lat, center.lng], points)
        if (inPolygon) {
          results.push({ id: String(id), properties: props })
          console.log('[MapInfoLayer] 线/面要素中心在多边形内:', props.name || props.id, center)
        }
      }
    })

    console.log('[MapInfoLayer] getFeaturesInPolygon结果:', {
      id: this.id,
      totalLayers: layerCount,
      matchedFeatures: results.length
    })

    return results
  }

  /**
   * 射线法判断点是否在多边形内
   */
  private _isPointInPolygon(point: number[], polygon: number[][]): boolean {
    const x = point[0], y = point[1]
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1]
      const xj = polygon[j][0], yj = polygon[j][1]
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
      if (intersect) inside = !inside
    }
    return inside
  }

  /**
   * 添加到地图
   */
  addTo(map: L.Map): this {
    if (!this.geoJSONLayer) {
      throw new Error('图层未初始化，请先调用 loadData() 加载数据')
    }

    // 先移除（如果已存在），避免重复添加
    if (map.hasLayer(this.geoJSONLayer)) {
      if (IS_DEV) console.log('[MapInfoLayer] Layer already on map, removing first:', this.id)
      map.removeLayer(this.geoJSONLayer)
    }

    this.geoJSONLayer.addTo(map)
    this.currentMap = map  // 存储地图实例

    // 如果标签已开启，在添加到地图时自动创建标签
    if (this.labelsEnabled) {
      if (IS_DEV) console.log('[MapInfoLayer] Labels enabled, creating labels upon adding to map:', this.id)
      this._createLabels(map)
    }

    // 监听缩放变化，缩放结束后重新应用高亮样式
    map.on('zoomend', this._onZoomEnd.bind(this))

    if (IS_DEV) console.log('[MapInfoLayer] Layer added to map:', this.id)
    return this
  }

  /**
   * 缩放结束事件处理 - 重新应用高亮样式
   */
  private _onZoomEnd(): void {
    // 如果之前设置过高亮，缩放结束后重新应用
    if (this.selectionHighlightIds && this.selectionHighlightIds.size > 0) {
      if (IS_DEV) console.log('[MapInfoLayer] Zoom ended, re-applying highlight:', this.id)
      this.setSelectionHighlight(this.selectionHighlightIds)
    }
  }

  /**
   * 从地图移除
   */
  remove(map: L.Map): this {
    if (this.geoJSONLayer && map.hasLayer(this.geoJSONLayer)) {
      if (IS_DEV) console.log('[MapInfoLayer] Removing layer from map:', this.id)
      map.removeLayer(this.geoJSONLayer)
      // 移除 zoomend 事件监听器，防止事件泄漏
      map.off('zoomend', this._onZoomEnd)
    } else {
      if (IS_DEV) console.log('[MapInfoLayer] Layer not on map, skipping remove:', this.id, {
        hasGeoJSONLayer: !!this.geoJSONLayer,
        hasLayerInMap: this.geoJSONLayer ? map.hasLayer(this.geoJSONLayer) : false
      })
    }
    // 🔧 修复：无条件清理标签层（即使几何层不在 map.hasLayer 判定内，
    // 标签 canvas 也可能残留在地图上，必须显式移除，避免"关闭标签后仍显示"）
    this._removeLabels(map)
    if (this.currentMap === map) {
      this.currentMap = null
    }
    return this
  }

  /**
   * 设置可见性
   */
  setVisible(map: L.Map, visible: boolean): this {
    if (IS_DEV) console.log('[MapInfoLayer] setVisible called:', this.id, visible, {
      hasGeoJSONLayer: !!this.geoJSONLayer,
      hasLayerInMap: this.geoJSONLayer ? map.hasLayer(this.geoJSONLayer) : false
    })
    if (visible) {
      this.addTo(map)
    } else {
      this.remove(map)
    }
    return this
  }

  /**
   * 检查图层是否可见
   */
  isVisible(): boolean {
    if (!this.geoJSONLayer || !this.currentMap) {
      if (IS_DEV) console.log('[MapInfoLayer] isVisible: 不可见', {
        id: this.id,
        name: this.name,
        hasGeoJSONLayer: !!this.geoJSONLayer,
        hasCurrentMap: !!this.currentMap
      })
      return false
    }
    const visible = this.currentMap.hasLayer(this.geoJSONLayer)
    if (IS_DEV) console.log('[MapInfoLayer] isVisible:', {
      id: this.id,
      name: this.name,
      visible
    })
    return visible
  }

  /**
   * 从 GeoJSON 数据创建图层
   */
  static async fromGeoJSON(options: MapInfoLayerOptions): Promise<MapInfoLayer> {
    const mapInfoLayer = new MapInfoLayer(options)

    // 后端 get_layer_data 已统一做 WGS84→GCJ02 转换（transform_coords=True）
    // 前端不再转换，避免双重转换导致位置偏移
    const transformedData = options.data

    if (IS_DEV) console.log('[MapInfoLayer] 使用后端已转换数据，要素数:', transformedData.features.length)

    // Canvas renderer：大幅减少 DOM 节点（18,903 个 SVG path → 单个 canvas）
    // 图层常含数万个 polygon/line，SVG 渲染会导致 DOM 爆炸、勾选后长时间卡顿。
    mapInfoLayer.canvasRenderer = L.canvas()
    const canvasRenderer = mapInfoLayer.canvasRenderer

    // 构建时分配稳定选择 ID 的序号兜底（跨分块递增，保证唯一）
    let featureSeq = 0

    // 创建 GeoJSON 图层（使用后端已转换数据）
    // renderer 是合法 Leaflet 运行时选项（PathOptions），但 @types/leaflet 的
    // GeoJSONOptions 未声明该字段，需类型断言
    const geoJsonOptions: L.GeoJSONOptions & { renderer: any } = {
      renderer: canvasRenderer,
      // 点要素样式
      pointToLayer: (feature: any, latLng: L.LatLng) => {
        // 获取 feature 级别的样式（如果存在）
        // 合并优先级：默认样式 < 要素样式(_style，扁平结构，含 markerSymbol/markerColor/markerSize)
        //                 < 图层级用户设置(style.point) < 专题图层设置(优先)
        const featureStyle = (feature.properties as any)?._style || {}
        const pointStyle = { ...DEFAULT_STYLES.point, ...featureStyle, ...mapInfoLayer.style.point }

        // 专题启用：按字段值配色，点大小用图形大小设置
        const thematicColor = mapInfoLayer._thematicColor(feature)
        if (thematicColor) {
          pointStyle.markerColor = thematicColor
          pointStyle.fillColor = thematicColor
          pointStyle.color = thematicColor
        }

        const markerSize = (thematicColor && mapInfoLayer.thematicSettings?.pointSize)
          ? mapInfoLayer.thematicSettings.pointSize
          : (pointStyle.markerSize || pointStyle.radius || 6)
        const markerColor = pointStyle.markerColor || pointStyle.fillColor || '#f59e0b'

        // 还原点形状（MapInfo Symbol 编号 / 形状名）：有形状信息时用 L.marker + SVG 图标，
        // 否则保持 circleMarker（Canvas 渲染、大数据量性能好）
        const shapeName = resolvePointShape(featureStyle.markerSymbol)
        if (shapeName) {
          const iconPx = Math.max(12, Math.min(36, Math.round(markerSize * 2)))
          const icon = L.icon({
            iconUrl: pointShapeIconDataUri(shapeName, markerColor),
            iconSize: [iconPx, iconPx],
            iconAnchor: [iconPx / 2, iconPx / 2]
          })
          const marker = L.marker(latLng, { icon })
          const fName = feature.properties?.name
          if (fName) marker.options.title = String(fName)
          return marker
        }

        return L.circleMarker(latLng, {
          renderer: canvasRenderer,
          radius: markerSize,
          fillColor: markerColor,
          color: pointStyle.color || '#fff',
          weight: pointStyle.weight || 2,
          opacity: pointStyle.opacity || 1,
          fillOpacity: pointStyle.fillOpacity || 0.8
        })
      },

      // 线和面要素样式
      style: (feature) => {
        if (!feature || !feature.geometry) return {}
        const geometry = feature.geometry.type
        const featureStyle = (feature.properties as any)?._style || {}

        // 调试：打印第一个要素的样式
        if (feature && feature.properties && Object.keys(feature.properties).length > 0) {
          if (!MapInfoLayer._debugPrinted) {
            if (IS_DEV) console.log('[MapInfoLayer] Feature style sample:', {
              geometry,
              featureStyle,
              properties: Object.keys(feature.properties).slice(0, 5)
            })
            MapInfoLayer._debugPrinted = true
          }
        }

        if (geometry === 'LineString' || geometry === 'MultiLineString') {
          // 合并优先级：默认样式 < 要素样式(_style) < 图层级用户设置(style.line)
          // 后端注入的 feature._style 是 MapInfo 文件自带的默认样式，用户通过
          // "图层颜色设置" 配置的颜色/透明度必须优先于它，否则保存后不生效。
          const userLine = mapInfoLayer.style.line || {}
          const mergedStyle = {
            color: userLine.color ?? featureStyle.strokeColor ?? DEFAULT_STYLES.line.color,
            weight: userLine.weight ?? featureStyle.strokeWidth ?? DEFAULT_STYLES.line.weight,
            opacity: userLine.opacity ?? featureStyle.strokeOpacity ?? DEFAULT_STYLES.line.opacity,
          }

          const result: any = {
            color: mergedStyle.color || '#8b5cf6',
            weight: mergedStyle.weight || 3,
            opacity: mergedStyle.opacity !== undefined ? mergedStyle.opacity : 1,
            lineCap: 'round',
            lineJoin: 'round'
          }
          // 线状图层：专题"线宽"设置优先（专题启用时）
          if (mapInfoLayer.thematicSettings?.enabled && mapInfoLayer.thematicSettings.pointSize) {
            result.weight = mapInfoLayer.thematicSettings.pointSize
          }
          const thematicColor = mapInfoLayer._thematicColor(feature)
          if (thematicColor) {
            result.color = thematicColor
          }
          const lineDashArray = userLine.dashArray ?? featureStyle.strokeDasharray
          if (lineDashArray) {
            result.dashArray = lineDashArray
          }
          return result
        } else if (geometry === 'Polygon' || geometry === 'MultiPolygon') {
          // 合并优先级：默认样式 < 要素样式(_style) < 图层级用户设置(style.polygon) < 专题图层设置(优先)
          const userPolygon = mapInfoLayer.style.polygon || {}
          const mergedStyle = {
            color: userPolygon.color ?? featureStyle.strokeColor ?? DEFAULT_STYLES.polygon.color,
            weight: userPolygon.weight ?? featureStyle.strokeWidth ?? DEFAULT_STYLES.polygon.weight,
            opacity: userPolygon.opacity ?? featureStyle.strokeOpacity ?? DEFAULT_STYLES.polygon.opacity,
            fillColor: userPolygon.fillColor ?? featureStyle.fillColor ?? DEFAULT_STYLES.polygon.fillColor,
            fillOpacity: userPolygon.fillOpacity ?? featureStyle.fillOpacity ?? DEFAULT_STYLES.polygon.fillOpacity,
          }

          // KML <fill>0</fill>（无填充）：文件声明无填充且用户未自定义时透明（仅显示边框）
          const noFill = featureStyle.fill === false
            && userPolygon.fillOpacity === undefined
            && userPolygon.fillColor === undefined
          const result: any = {
            color: mergedStyle.color || '#10b981',
            weight: mergedStyle.weight || 2,
            opacity: mergedStyle.opacity !== undefined ? mergedStyle.opacity : 1,
            fillColor: mergedStyle.fillColor || '#10b981',
            fillOpacity: noFill ? 0 : (mergedStyle.fillOpacity || 0.3)
          }
          // 面状图层：专题"边框宽度"设置优先（专题启用时）
          if (mapInfoLayer.thematicSettings?.enabled && mapInfoLayer.thematicSettings.pointSize) {
            result.weight = mapInfoLayer.thematicSettings.pointSize
          }
          const thematicColor = mapInfoLayer._thematicColor(feature)
          if (thematicColor) {
            result.color = thematicColor
            result.fillColor = thematicColor
          }
          const polygonDashArray = userPolygon.dashArray ?? featureStyle.strokeDasharray
          if (polygonDashArray) {
            result.dashArray = polygonDashArray
          }
          return result
        }
        return {}
      },

      // 要素交互处理
      onEachFeature: (feature, leafletLayer) => {
        // 为每个要素分配稳定选择 ID：自然 ID（id/name/OBJECTID/CGI 等）优先，
        // 提取不到时用「图层ID#序号」兜底，保证 getFeaturesInCircle/InPolygon、
        // setSelectionHighlight、selectFeaturesAtPoint 都能命中，MIF/KML 任意属性列名也可圈选
        const props = feature?.properties || {}
        const naturalId = extractFeatureId(props)
        ;(leafletLayer as any)._nptSelectionId = naturalId || `${mapInfoLayer.id}#${featureSeq++}`

        leafletLayer.on('click', (e: L.LeafletMouseEvent) => {
          // 如果交互被禁用（如框选模式下），不处理点击，也不阻止事件冒泡
          // 让事件继续传递，以便框选工具可以处理
          if (!mapInfoLayer.isInteractive) {
            return
          }

          // 阻止事件冒泡到地图
          L.DomEvent.stopPropagation(e as any)

          if (mapInfoLayer.onFeatureClickCallback) {
            console.log('[MapInfoLayer] 🔍 要素点击触发:', mapInfoLayer.id, {
              hasProperties: !!feature.properties,
              propCount: feature.properties ? Object.keys(feature.properties).length : 0
            })
            mapInfoLayer.onFeatureClickCallback(feature.properties, e)
          }
        })
      }
    }

    // 🔧 分块构建：避免一次性同步创建数万要素阻塞主线程（大数据集渐进显示）
    // 先建空 GeoJSON 图层（继承 renderer/pointToLayer/style/onEachFeature 配置），再分块 addData
    mapInfoLayer.geoJSONLayer = L.geoJSON([], geoJsonOptions as any)
    await mapInfoLayer._addGeoJSONChunks(transformedData)

    return mapInfoLayer
  }

  /**
   * 分块向 GeoJSON 图层添加要素
   * 每次添加一个批次后让步（setTimeout 0），保持 UI 响应、要素渐进显示
   */
  private async _addGeoJSONChunks(featureCollection: GeoJSON.FeatureCollection): Promise<void> {
    if (!this.geoJSONLayer) return
    const features = featureCollection.features || []
    // 🔧 性能：批次提到 4000（实测逐要素构建仅 ~26µs，4000 个单批 ~0.1s，桌面端可接受），
    // 19000 要素从 19 批压到 5 批，大幅减少 setTimeout 空闲间隙
    const BATCH = 4000
    for (let i = 0; i < features.length; i += BATCH) {
      const chunk: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: features.slice(i, i + BATCH)
      }
      this.geoJSONLayer.addData(chunk as any)
      // 让步：让浏览器处理已添加的要素并保持 UI 响应
      if (i + BATCH < features.length) {
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    }
  }

  /**
   * 获取图层ID
   */
  getId(): string {
    return this.id
  }

  /**
   * 获取图层名称
   */
  getName(): string {
    return this.name
  }

  /**
   * 获取几何类型
   */
  getType(): LayerGeometryType {
    return this.type
  }

  /**
   * 计算要素的专题颜色（按字段值匹配区间/文本配色）
   * @returns 颜色；专题未启用返回 null（走基础样式）
   */
  private _thematicColor(feature: any): string | null {
    const ts = this.thematicSettings
    if (!ts || !ts.enabled || !ts.field) return null
    return matchThematicColor(ts, getFieldValue(feature?.properties, ts.field))
  }

  /**
   * 应用单个要素的当前应显示样式（专题优先、基础次之）
   * 点要素由 pointToLayer 创建（style 函数对 Point 返回 {}，resetStyle 对其无效，
   * 且 Leaflet resetStyle 会把 layer.options 还原为创建时快照 defaultOptions，
   * 使后续专题/基础配色丢失），必须对点要素直接 setStyle / setIcon；
   * 线/面走 style 函数 resetStyle 即可（style 回调已含专题逻辑）。
   */
  private _applyFeatureStyle(layer: any): void {
    const thematicColor = this._thematicColor(layer.feature)
    if (layer instanceof L.CircleMarker) {
      if (thematicColor) {
        // 专题启用：按图形大小设置更新半径（否则已渲染的点大小不变）
        layer.setStyle({
          fillColor: thematicColor,
          fillOpacity: 1,
          color: thematicColor,
          opacity: 1,
          ...(this.thematicSettings?.pointSize ? { radius: this.thematicSettings.pointSize } : {})
        })
      } else {
        layer.setStyle({
          fillColor: this.style.point?.fillColor || '#f59e0b',
          fillOpacity: this.style.point?.fillOpacity ?? 0.8,
          color: this.style.point?.color || '#fff',
          weight: this.style.point?.weight ?? 2,
          opacity: this.style.point?.opacity ?? 1,
          // 半径保留当前已渲染值（要素级 markerSize/专题点大小），无则用基础配置或默认值，
          // 避免恢复样式时把点强制缩回固定 6px
          radius: this.style.point?.radius ?? layer.options.radius ?? 6
        })
      }
    } else if (layer instanceof L.Marker) {
      // 点形状（L.marker + SVG 图标）：用新填充色重新生成图标
      const shapeName = resolvePointShape(layer.feature?.properties?._style?.markerSymbol)
      if (shapeName) {
        const curIcon: any = layer.options.icon
        const iconPx = (curIcon?.options?.iconSize && curIcon.options.iconSize[0]) || 24
        const iconSize = (thematicColor && this.thematicSettings?.pointSize)
          ? this.thematicSettings.pointSize * 2
          : iconPx
        const color = thematicColor || (this.style.point as any)?.markerColor || this.style.point?.fillColor || '#f59e0b'
        layer.setIcon(L.icon({
          iconUrl: pointShapeIconDataUri(shapeName, color),
          iconSize: [iconSize, iconSize],
          iconAnchor: [iconSize / 2, iconSize / 2]
        }))
      }
    } else {
      this.geoJSONLayer?.resetStyle(layer)
    }
  }

  /**
   * 重新应用全部要素样式（专题优先、基础次之）
   */
  private _reapplyStyles(): void {
    if (!this.geoJSONLayer) return
    this.geoJSONLayer.eachLayer((layer: any) => {
      this._applyFeatureStyle(layer)
    })
    // 兜底：强制所有要素重绘，确保 Canvas 渲染器必然刷新（避免个别 setStyle 未触发重绘）
    this.geoJSONLayer.eachLayer((layer: any) => {
      if (typeof layer.redraw === 'function') layer.redraw()
    })
  }

  /**
   * 设置图层颜色覆盖（图形颜色 / 透明度 / 边框宽度 / 边框颜色）
   * 写入 style 配置后重新应用样式，使已渲染要素即时生效。
   */
  setStyleOverrides(settings: { fillColor: string; fillOpacity: number; borderWidth: number; borderColor: string }): void {
    // 点样式：填充 + 边框
    this.style.point = {
      ...this.style.point,
      fillColor: settings.fillColor,
      fillOpacity: settings.fillOpacity,
      color: settings.borderColor,
      weight: settings.borderWidth,
      opacity: 1
    }

    // 线样式：无填充，透明度作用于描边
    this.style.line = {
      ...this.style.line,
      color: settings.borderColor,
      weight: settings.borderWidth,
      opacity: settings.fillOpacity
    }

    // 面样式：填充 + 边框
    this.style.polygon = {
      ...this.style.polygon,
      fillColor: settings.fillColor,
      fillOpacity: settings.fillOpacity,
      color: settings.borderColor,
      weight: settings.borderWidth,
      opacity: 1
    }

    this._reapplyStyles()
  }

  /**
   * 设置专题图层覆盖（与基础配置相互独立：专题启用时优先渲染；null 关闭专题后由渲染层回退到基础配置色）
   */
  setThematicOverrides(settings: ThematicSettings | null): void {
    this.thematicSettings = settings
    // 关闭专题时不清除基础配置：基础配置与专题图层相互独立，
    // 专题关闭时自然回退到基础配置色（无基础配置则用导入默认色）。
    this.computeThematicStats()
    this._reapplyStyles()
  }

  /**
   * 计算专题图例统计（各配色模式的要素数与总数，供图例展示）
   * - 区间配色：counts[每区间] + other（未匹配）
   * - 属性值配色：counts[每个值] + other（未配置值）
   * - 文本配色：counts[每个类别，含 __other__] + other（无兜底时的未列出值）
   */
  private computeThematicStats(): void {
    const ts = this.thematicSettings
    if (!ts?.enabled || !this.geoJSONLayer) {
      this.thematicStats = null
      return
    }
    const isRange = ts.fieldType === 'numeric' && ts.colorMode !== 'value' && ts.ranges.length > 0
    const isValue = ts.fieldType === 'numeric' && ts.colorMode === 'value' && (ts.valueColors?.length ?? 0) > 0
    const isText = ts.fieldType === 'text' && ts.categories.length > 0
    if (!isRange && !isValue && !isText) {
      this.thematicStats = null
      return
    }
    const counts = new Array(
      isRange ? ts.ranges.length : isValue ? ts.valueColors!.length : ts.categories.length
    ).fill(0)
    let total = 0
    let other = 0
    const valueIndex = isValue ? new Map(ts.valueColors!.map((c, i) => [c.value, i])) : null
    const otherIdx = isText ? ts.categories.findIndex(c => c.value === '__other__') : -1
    const categoryIndex = isText ? new Map(ts.categories.map((c, i) => [c.value, i])) : null
    this.geoJSONLayer.eachLayer((layer: any) => {
      const feature = layer.feature
      if (!feature?.properties) return
      if (isRange) {
        total++
        const idx = matchRangeIndex(ts, getFieldValue(feature.properties, ts.field))
        if (idx >= 0) counts[idx]++; else other++
      } else if (isValue) {
        total++
        const raw = getFieldValue(feature.properties, ts.field)
        if (!hasValue(raw)) { other++; return }
        const idx = valueIndex!.get(String(raw))
        if (idx !== undefined) counts[idx]++; else other++
      } else {
        total++
        const raw = getFieldValue(feature.properties, ts.field)
        if (!hasValue(raw)) { if (otherIdx >= 0) counts[otherIdx]++; else other++; return }
        const idx = categoryIndex!.get(String(raw))
        if (idx !== undefined) counts[idx]++
        else if (otherIdx >= 0) counts[otherIdx]++
        else other++
      }
    })
    this.thematicStats = { counts, total, other }
  }

  /**
   * 获取专题区间统计（图例显示每个区间的个数与占比；other = 未匹配区间/无兜底分类的要素数）
   */
  getThematicStats(): { counts: number[]; total: number; other: number } | null {
    return this.thematicStats
  }

  /**
   * 获取图层全部要素的地理范围（图层预览：居中最大化显示）
   * @returns LatLngBounds；无要素/未渲染返回 null
   */
  getFeaturesBounds(): L.LatLngBounds | null {
    if (!this.geoJSONLayer) return null
    const bounds = L.latLngBounds([])
    let has = false
    this.geoJSONLayer.eachLayer((layer: any) => {
      try {
        if (typeof layer.getLatLng === 'function') {
          bounds.extend(layer.getLatLng())
          has = true
        } else if (typeof layer.getBounds === 'function') {
          bounds.extend(layer.getBounds())
          has = true
        }
      } catch { /* 忽略单要素异常 */ }
    })
    return has ? bounds : null
  }

  /**
   * 设置是否允许交互 (满足需求3)
   */
  setInteractive(interactive: boolean): void {
    this.isInteractive = interactive
  }

  /**
   * 把该图层的 canvas 渲染层移到 pane 顶部，使其成为点击命中目标。
   * 对 Canvas，路径 bringToFront 只重绘不移动 DOM，必须直接操作 canvas 元素。
   * 注意：Leaflet Renderer 无公共 getContainer()，实际容器元素是私有 _container。
   */
  bringToFrontForZOrder(): void {
    const renderer = this.canvasRenderer as any
    const container = renderer?._container as HTMLElement | undefined
    if (container && container.parentNode) {
      container.parentNode.appendChild(container)
    }
  }

  /**
   * 设置框选高亮
   * @param ids 选中的要素ID集合（通常基于某个唯一属性，如'id'或'name'），null表示清除
   * @param idField 用于匹配的属性字段名，默认为 'id'
   */
  setSelectionHighlight(ids: Set<string> | null, idField: string = 'id'): void {
    this.selectionHighlightIds = ids
    if (!this.geoJSONLayer) return

    this.geoJSONLayer.eachLayer((layer: any) => {
      const feature = layer.feature
      if (!feature || !feature.properties) return

      // 获取标识符 - 与 getFeaturesInCircle/InPolygon 返回的 id 保持一致，
      // 优先用构建时分配的 _nptSelectionId（含「图层ID#序号」兜底），否则回退到属性字段
      const val = (layer as any)._nptSelectionId || feature.properties[idField] || extractFeatureId(feature.properties)
      const isSelected = ids?.has(String(val))

      // 更新样式
      if (layer instanceof L.Path) {
        if (isSelected) {
          // 高亮样式：红色边框（保留当前填充色/专题配色）
          layer.setStyle({
            color: '#ef4444',
            weight: 3,
            opacity: 1
          })
          if (layer.bringToFront) layer.bringToFront()
        } else {
          // 恢复当前应显示的样式（专题配色优先、基础配置次之）。
          // 不能用 resetStyle：Leaflet 会把它还原为创建时快照（defaultOptions），
          // 使点要素的专题配色丢失、回退到基础配色（圈选后配色还原 bug）
          this._applyFeatureStyle(layer)
        }
      } else if (layer instanceof L.Marker) {
        // Marker（点要素）高亮：修改图标添加高亮框
        const markerEl = layer.getElement()
        if (markerEl) {
          if (isSelected) {
            markerEl.style.outline = '2px solid #ef4444'
            markerEl.style.outlineOffset = '2px'
            markerEl.style.borderRadius = '2px'
          } else {
            markerEl.style.outline = ''
            markerEl.style.outlineOffset = ''
            markerEl.style.borderRadius = ''
          }
        }
      }
    })
  }

  /**
   * 设置标签可见性
   * @param visible 是否显示标签
   */
  setLabelVisibility(visible: boolean): void {
    this.labelsEnabled = visible
    if (IS_DEV) console.log('[MapInfoLayer] setLabelVisibility:', this.id, visible)

    if (!this.currentMap) {
      console.warn('[MapInfoLayer] 图层未添加到地图，无法显示标签')
      return
    }

    if (visible) {
      this._createLabels(this.currentMap)
    } else {
      this._removeLabels()
    }
  }

  /**
   * 设置标签配置
   * @param config 标签配置
   */
  setLabelConfig(config: { content: string; color: string; fontSize: number }): void {
    // 更新配置
    this.labelConfig = { ...this.labelConfig, ...config }
    if (IS_DEV) console.log('[MapInfoLayer] setLabelConfig:', this.id, this.labelConfig)

    // 如果标签已启用且图层已添加到地图，重新创建标签以应用新配置
    if (this.labelsEnabled && this.currentMap) {
      if (IS_DEV) console.log('[MapInfoLayer] 标签已启用，立即重新创建标签')
      this._removeLabels()
      this._createLabels(this.currentMap)
    }
  }

  /**
   * 更新缩放级别并重绘标签
   */
  updateZoom(zoom: number): void {
    const oldZoom = this.currentZoom
    this.currentZoom = zoom

    // 如果缩放级别改变较大或者标签已开启，重新创建标签以应用碰撞检测
    if (this.labelsEnabled && this.currentMap && Math.abs(oldZoom - zoom) >= 1) {
      if (IS_DEV) console.log('[MapInfoLayer] Zoom changed, re-creating labels:', this.id, zoom)
      this._createLabels(this.currentMap)
    }
  }

  /**
   * 创建标签
   *
   * 🔧 Canvas 化：复用 GeoDataCanvasLabelLayer（单 Canvas + 网格防重叠 + 视口裁剪 + rAF + move 自刷新）
   * 移除 MAX_LABELS 上限与 DOM 全量重建，全部要素交给 Canvas 层处理防重叠与视口裁剪
   */
  private _createLabels(map: L.Map): void {
    if (!this.geoJSONLayer) return

    // 移除旧标签
    this._removeLabels()

    // 收集全部要素标签（无数量上限，Canvas 层负责防重叠与视口裁剪）
    const labelItems: CanvasLabelData[] = []
    let index = 0

    this.geoJSONLayer.eachLayer((layer: any) => {
      try {
        const feature = layer.feature
        const properties = feature?.properties || {}
        let latLng: L.LatLng | null = null

        // 获取标签显示位置
        if (layer instanceof L.CircleMarker) {
          latLng = layer.getLatLng()
        } else if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
          latLng = layer.getBounds().getCenter()
        } else if (layer instanceof L.Polygon) {
          latLng = layer.getBounds().getCenter()
        }
        if (!latLng) return

        // 获取标签内容（保留现有 _getLabelContent 逻辑，字段回退在 Task 2 加）
        const labelContent = this._getLabelContent(properties)
        if (!labelContent) return

        labelItems.push({ index: index++, position: latLng, content: labelContent })
      } catch (err) {
        // 静默忽略单个要素的错误
      }
    })

    // 创建/复用 Canvas 标签层
    if (!this.canvasLabelLayer) {
      this.canvasLabelLayer = new GeoDataCanvasLabelLayer({
        fontSize: this.labelConfig.fontSize,
        fontColor: this.labelConfig.color
      })
    } else {
      this.canvasLabelLayer.updateConfig({
        fontSize: this.labelConfig.fontSize,
        fontColor: this.labelConfig.color
      })
    }

    // 🔧 必须先 addTo 再 setLabels：GeoDataCanvasLabelLayer.setLabels 在 this.map 为空时直接早退
    // （this.map 由 addTo → onAdd 赋值），先 setLabels 会把标签全部丢弃
    if (!map.hasLayer(this.canvasLabelLayer)) {
      this.canvasLabelLayer.addTo(map)
    }
    this.canvasLabelLayer.setLabels(labelItems)
    console.log(`[MapInfoLayer] ✅ 已创建 ${labelItems.length} 个 Canvas 标签`)
  }

  /**
   * 移除所有标签
   */
  private _removeLabels(targetMap?: L.Map): void {
    if (this.canvasLabelLayer) {
      // 🔧 优先使用调用方传入的 map（remove() 场景 currentMap 可能已被置空/不匹配），
      // 兜底用 currentMap，确保标签 canvas 总能从地图移除
      const map = targetMap || this.currentMap
      if (map && map.hasLayer(this.canvasLabelLayer)) {
        map.removeLayer(this.canvasLabelLayer)
      }
      this.canvasLabelLayer = null
    }
  }

  /**
   * 获取标签内容
   * @param properties 要素属性
   * @returns 标签文本
   */
  private _getLabelContent(properties: any): string {
    const requestedField = this.labelConfig.content

    // 1. 尝试直接获取请求的字段
    // 预定义字段的映射
    const fieldMapping: Record<string, string[]> = {
      'name': ['小区名称', 'CELLNAME', 'CELL_NAME', 'CELL NAME', 'Cell Name', 'Name', 'name', 'cellName', 'NAME', '站点名称', 'zhLabel'],
      'siteId': ['基站ID', 'Site ID', 'eNodeB ID', 'siteId', 'enbId', 'ENBID', 'site_id'],
      'frequency': ['下行频点', 'DL Frequency', 'Frequency', 'frequency', 'dlFreq', 'freq'],
      'pci': ['PCI', 'physicalCellId', 'pci', 'Pci'],
      'tac': ['TAC', 'trackingAreaCode', 'tac', 'Tac'],
      'isShared': ['是否共享', 'Is Shared', 'Shared', 'isShared'],
      'coverageType': ['覆盖类型', 'Coverage Type', 'coverageType']
    }

    // 查找匹配的字段
    const possibleNames = fieldMapping[requestedField] || [requestedField]
    for (const propName of possibleNames) {
      // 1a. 直接在 properties 中查找
      if (properties[propName] !== undefined && properties[propName] !== null) {
        const val = String(properties[propName]).trim()
        if (val) return val
      }

      // 1b. 在嵌套的 properties 中查找 (地理化数据展平前或特殊结构)
      if (properties.properties && properties.properties[propName] !== undefined && properties.properties[propName] !== null) {
        const val = String(properties.properties[propName]).trim()
        if (val) return val
      }
    }

    // 严格按用户选择的标签字段显示：所选字段缺失时不回退到其他属性内容，
    // 直接返回空串（该要素不在地图显示标签），避免 MIF/MAP 字段名不匹配时
    // 误把 OBJECTID/GRID_ID 等无关属性当标签
    return ''
  }
}

/**
 * MapInfo 图层管理器
 */
export class MapInfoLayerManager {
  private layers: Map<string, MapInfoLayer> = new Map()
  private map: L.Map | null = null

  constructor() { }

  /**
   * 调试方法：打印所有图层及其在地图上的状态
   */
  debugPrintLayers(): void {
    if (!IS_DEV) return
    console.log('[MapInfoLayerManager] === LAYER STATUS ===')
    console.log('[MapInfoLayerManager] Total layers in memory:', this.layers.size)
    console.log('[MapInfoLayerManager] Map instance:', this.map ? 'exists' : 'NULL')

    for (const [id, layer] of this.layers) {
      const geoJSONLayer = (layer as any).geoJSONLayer
      const onMap = this.map && geoJSONLayer && this.map.hasLayer(geoJSONLayer)
      console.log(`[MapInfoLayerManager] Layer "${id}": ${onMap ? '✓ ON MAP' : '✗ NOT ON MAP'}`)
    }
    console.log('[MapInfoLayerManager] ======================')
  }

  /**
   * 设置地图实例
   */
  setMap(map: L.Map): void {
    this.map = map
  }

  /**
   * 添加图层
   */
  async addLayer(options: MapInfoLayerOptions, visible: boolean = false): Promise<void> {
    // 若已存在同 id 图层，先移除旧实例（避免切换/重复加载导致地图叠加）
    const existing = this.layers.get(options.id)
    if (existing && this.map) {
      if (IS_DEV) console.log('[MapInfoLayerManager] 存在同 id 旧图层，先移除:', options.id)
      existing.remove(this.map)
    }

    const layer = await MapInfoLayer.fromGeoJSON(options)
    if (IS_DEV) console.log('[MapInfoLayerManager] Adding layer:', layer.getId(), 'visible:', visible)
    this.layers.set(layer.getId(), layer)

    if (visible && this.map) {
      layer.addTo(this.map)
      if (IS_DEV) console.log('[MapInfoLayerManager] Layer added to map:', layer.getId())
    }
  }

  /**
   * 移除图层
   */
  removeLayer(layerId: string): void {
    if (IS_DEV) console.log('[MapInfoLayerManager] Removing layer:', layerId, 'existing layers:', Array.from(this.layers.keys()))
    const layer = this.layers.get(layerId)
    if (layer && this.map) {
      layer.remove(this.map)
    }
    this.layers.delete(layerId)
  }

  /**
   * 设置图层可见性
   */
  setLayerVisibility(layerId: string, visible: boolean): void {
    if (IS_DEV) console.log('[MapInfoLayerManager] setLayerVisibility:', layerId, visible, 'existing layers:', Array.from(this.layers.keys()))
    if (IS_DEV) console.log('[MapInfoLayerManager] Map instance:', this.map ? 'exists' : 'NULL')

    // 调试：打印所有图层状态
    this.debugPrintLayers()

    const layer = this.layers.get(layerId)
    if (layer) {
      if (IS_DEV) console.log('[MapInfoLayerManager] Found layer:', layerId)
      if (this.map) {
        layer.setVisible(this.map, visible)
        if (IS_DEV) console.log('[MapInfoLayerManager] Layer visibility set, checking result...')
        // 验证：检查图层是否真的在地图上
        const geoJSONLayer = (layer as any).geoJSONLayer
        if (geoJSONLayer && this.map.hasLayer(geoJSONLayer)) {
          if (IS_DEV) console.log('[MapInfoLayerManager] ✓ Layer IS on map:', layerId)
        } else {
          if (IS_DEV) console.log('[MapInfoLayerManager] ✗ Layer NOT on map:', layerId)
        }

        // 再次打印状态以确认更改
        if (IS_DEV) console.log('[MapInfoLayerManager] After visibility change:')
        this.debugPrintLayers()
      } else {
        if (IS_DEV) console.log('[MapInfoLayerManager] Map instance is null!')
      }
    } else {
      if (IS_DEV) console.log('[MapInfoLayerManager] Layer not found:', layerId)
    }
  }

  /**
   * 获取所有图层
   */
  getLayers(): MapInfoLayer[] {
    return Array.from(this.layers.values())
  }

  /**
   * 清空所有图层
   */
  clear(): void {
    if (this.map) {
      for (const layer of this.layers.values()) {
        layer.remove(this.map)
      }
    }
    this.layers.clear()
  }
}
