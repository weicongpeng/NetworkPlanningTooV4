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
import type { LabelCandidate, LabelLayoutManager } from './LabelLayoutManager'
import { getFieldValue, matchThematicColor, matchRangeIndex, hasValue, toNumber, NO_FILL_COLOR } from '../../utils/fieldValue'
import type { ThematicSettings } from './LabelSettingsModal'
import type { HeatPoint } from '../../utils/heatmap'
import { layerHitAt, CLICK_HIT_TOLERANCE_PX, layerGeometry, type FeatureHitType } from './mapHitTest'
import { buildLineArrows } from './lineArrows'

const IS_DEV = import.meta.env.DEV

/** "带方向线段的线"箭头装饰的整层数量上限（divIcon 为 DOM 节点，大图层防止卡顿） */
const MAX_LINE_ARROWS_PER_LAYER = 400

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
  /** 共享标签布局引擎（统一防重叠） */
  labelManager?: LabelLayoutManager
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
 * 点默认不描边（无色哨兵）：绝大多数文件（KML IconStyle/MapInfo Symbol）只声明图形颜色，
 * 若默认给白色描边，缩小时白边会盖住图形本体颜色
 */
const DEFAULT_STYLES: Record<LayerGeometryType, any> = {
  // 填充不透明度一律 100%（用户要求：地图上所有图形的默认不透明度都是 100%）
  point: {
    radius: 6,
    fillColor: '#f59e0b',
    color: NO_FILL_COLOR,
    weight: 2,
    opacity: 1,
    fillOpacity: 1
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
    fillOpacity: 1
  }
}

/**
 * 名称类标签字段候选（按优先级排列）
 * 图层首次开启"标签"开关、尚无保存的自定义字段时，从这些字段中自动挑选一个作为
 * 标签内容，使新导入的图层一开启标签即可显示要素名称（用户无需先进"自定义设置"保存）。
 */
const NAME_LABEL_CANDIDATES = [
  '小区名称', 'CELLNAME', 'CELL_NAME', 'CELL NAME', 'Cell Name', 'cellName',
  '站点名称', 'zhLabel', 'NAME_CN', '名称', '站点名', '小区名',
  'Name', 'NAME', 'name', 'OBJNAM', 'OBJNAME', 'Label', 'LABEL', 'label'
]

/** 自动挑选标签字段时跳过的无关编号/几何类字段（避免误把 OBJECTID/GRID_ID 等当标签） */
const NOISE_LABEL_KEYS = new Set([
  'OBJECTID', 'OBJECTID_1', 'FID', 'GID', 'ID', 'id', '_nptSelectionId', 'layer',
  'Shape_Length', 'Shape_Area', 'Shape_Area_1', 'GRID_ID', 'GEO_ID'
])

/**
 * MapInfo Symbol shape 编号 → 形状名（与后端 layer_service.POINT_SHAPE_MIF 一致）
 * 38/40/41/42 按用户实测的 MapInfo 输出取字形（空心方形/空心圆/空心五角星/空心正三角），
 * 与图层制作页的形状标签同源；空心与否 app 侧不区分，取同族字形。
 */
const MAPINFO_SYMBOL_SHAPES: Record<number, string> = {
  34: 'circle', 32: 'square', 33: 'diamond', 35: 'star',
  40: 'circle', 41: 'star', 42: 'triangle', 38: 'square'
}

const POINT_SHAPE_NAMES = ['circle', 'square', 'diamond', 'triangle', 'triangle_down', 'star', 'landmark', 'pin']

/**
 * 将后端 _style.markerSymbol（MapInfo Symbol 编号或形状名）解析为形状名；无形状信息返回 null。
 * 导出供图层编辑会话（LayerEditSession）复用，保证进入编辑时点形状渲染一致。
 */
export function resolvePointShape(symbol: any): string | null {
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
 * 读取要素自身持久化的编辑样式（properties._editStyle）。
 * 保存到 TAB 的 NPT_FEATSYM 列经后端还原为 _editStyle 对象；无/类型不符返回 null。
 * 支持整体存储与按点/线/面分段存储两种形态（与 LayerEditSession.styleFor 口径一致）。
 */
function editStyleForKind(props: any, kind: 'point' | 'line' | 'polygon'): any | null {
  const own = props?._editStyle
  if (!own || typeof own !== 'object') return null
  const seg = (own as any)[kind]
  if (seg && typeof seg === 'object') return seg
  const kindOfStyle =
    own.markerShape !== undefined || (own.markerSize !== undefined && own.markerColor !== undefined)
      ? 'point'
      : own.fillColor !== undefined
        ? 'polygon'
        : 'line'
  return kindOfStyle === kind ? own : null
}

/**
 * 生成点形状的 SVG Data URI（完全离线可用，与后端 layer_service.svg_point_icon 形状一致）
 * stroke 缺省不描边：文件未声明边框色时不画白边，避免遮住图形颜色
 */
function pointShapeIconDataUri(shape: string, color: string, stroke = 'none'): string {
  const fill = color || '#f59e0b'
  const svgs: Record<string, string> = {
    circle: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12" fill="${fill}" stroke="${stroke}" stroke-width="2"/></svg>`,
    square: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="4" y="4" width="24" height="24" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="2"/></svg>`,
    diamond: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="16,3 29,16 16,29 3,16" fill="${fill}" stroke="${stroke}" stroke-width="2"/></svg>`,
    triangle: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="16,3 29,29 3,29" fill="${fill}" stroke="${stroke}" stroke-width="2"/></svg>`,
    triangle_down: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="3,3 29,3 16,29" fill="${fill}" stroke="${stroke}" stroke-width="2"/></svg>`,
    star: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="16,2 19,11 29,11 21,17 24,27 16,21 8,27 11,17 3,11 13,11" fill="${fill}" stroke="${stroke}" stroke-width="2"/></svg>`,
    landmark: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M16 3 L28 10 L16 17 L4 10 Z" fill="${fill}" stroke="${stroke}" stroke-width="2"/><rect x="4" y="12" width="24" height="4" fill="${fill}" stroke="${stroke}" stroke-width="1"/><rect x="12" y="16" width="8" height="10" fill="${fill}" stroke="${stroke}" stroke-width="1"/></svg>`,
    pin: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M16 2 C9 2 4 7 4 14 C4 23 16 30 16 30 C16 30 28 23 28 14 C28 7 23 2 16 2 Z" fill="${fill}" stroke="${stroke}" stroke-width="2"/><circle cx="16" cy="13" r="4" fill="#fff"/></svg>`
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
  private labelManager: LabelLayoutManager | null
  private labelSourceId: string
  private labelConfig: {
    content: string
    color: string
    fontSize: number
    fontFamily?: string
    bold?: boolean
    italic?: boolean
    shadow?: boolean
    background?: 'none' | 'halo' | 'box'
    backgroundColor?: string
  }
  /** 标签配置是否已被用户显式保存过（true 后不再自动挑选默认标签字段） */
  private labelConfigCustomized: boolean = false
  /**
   * 编辑态标签源覆盖：非空时标签候选改从编辑工作集要素构建。
   * 打开"编辑"开关后原图层隐藏（remove 会清标签），标签改由工作集注册，
   * 保证"标签开关打开后打开编辑开关"标签不消失；null 恢复从自身数据构建。
   */
  private editLabelFeatures: any[] | null = null
  private currentMap: L.Map | null = null  // 存储当前地图实例

  // 框选高亮配置
  private selectionHighlightIds: Set<string> | null = null

  /** 线要素方向箭头装饰层（"带方向线段的线"：要素 _editStyle.arrow） */
  private lineArrowGroup: L.LayerGroup | null = null

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
    this.currentMap = null
    this.labelManager = options.labelManager || null
    this.labelSourceId = `mapinfo-${options.id}`
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
  getFeaturesInCircle(center: L.LatLng, radius: number): Array<{ id: string, properties: any, geometry?: any }> {
    if (!this.geoJSONLayer) {
      if (IS_DEV) console.log('[MapInfoLayer] getFeaturesInCircle: geoJSONLayer不存在', this.id)
      return []
    }
    const results: Array<{ id: string, properties: any, geometry?: any }> = []
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
          results.push({ id: String(id), properties: props, geometry: layer.feature?.geometry })
        }
      } else if (layer.getBounds) {
        // 线/面要素：圆与要素包围盒相交即选中。
        // 此前仅判断包围盒中心，圆只压到面的一部分（中心在圆外）时会漏选。
        if (this._circleIntersectsBounds(center, radius, layer.getBounds())) {
          results.push({ id: String(id), properties: props, geometry: layer.feature?.geometry })
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
   * 获取点击位置精确命中的要素（用于「点击查属性」）
   *
   * 与 getFeaturesInCircle（圆与包围盒相交即选中，供圈选/点选工具）不同：
   * 面要素按点击点是否落在封闭区域内判定，仅包围盒/边框相交不算命中，
   * 避免点击面内部时误弹重叠列表；点要素按像素距离、线要素按到折线段的
   * 像素距离判定。命中附带 hitType（direct/border）供调用方做穿透收敛。
   * 需先 addTo 地图（依赖投影），未上图时返回空。
   *
   * @param latlng 点击位置（渲染坐标/GCJ02）
   * @param tolerancePx 像素容差
   */
  getFeaturesAtPoint(
    latlng: L.LatLng,
    tolerancePx: number = CLICK_HIT_TOLERANCE_PX
  ): Array<{ id: string, properties: any, geometry: any, hitType: FeatureHitType, distancePx: number }> {
    if (!this.geoJSONLayer || !this.currentMap) return []
    const results: Array<{ id: string, properties: any, geometry: any, hitType: FeatureHitType, distancePx: number }> = []

    this.geoJSONLayer.eachLayer((layer: any) => {
      const props = layer.feature?.properties
      if (!props) return
      const id = layer._nptSelectionId || extractFeatureId(props)
      if (!id) return
      const hit = layerHitAt(this.currentMap!, layer, latlng, tolerancePx)
      if (hit) {
        results.push({ id: String(id), properties: props, geometry: layerGeometry(layer), hitType: hit.type, distancePx: hit.distancePx })
      }
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
  getFeaturesInPolygon(polygon: L.Polygon): Array<{ id: string, properties: any, geometry?: any }> {
    if (!this.geoJSONLayer) {
      console.log('[MapInfoLayer] getFeaturesInPolygon: geoJSONLayer不存在', this.id)
      return []
    }
    const results: Array<{ id: string, properties: any, geometry?: any }> = []
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
          results.push({ id: String(id), properties: props, geometry: layer.feature?.geometry })
          console.log('[MapInfoLayer] 点要素在多边形内:', props.name || props.id, latlng)
        }
      } else if (layer.getBounds) {
        // 对于线和面，检查其边界中心是否在多边形内
        const layerBounds = layer.getBounds()
        const center = layerBounds.getCenter()
        const inBounds = bounds.contains(center)
        const inPolygon = inBounds && this._isPointInPolygon([center.lat, center.lng], points)
        if (inPolygon) {
          results.push({ id: String(id), properties: props, geometry: layer.feature?.geometry })
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
    // 方向箭头装饰层（"带方向线段的线"）随图层一起上/下地图
    this.lineArrowGroup?.addTo(map)

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
    if (this.lineArrowGroup && map.hasLayer(this.lineArrowGroup)) {
      map.removeLayer(this.lineArrowGroup)
    }
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
        const point = mapInfoLayer._resolvePointStyle(feature)

        // 还原点形状（MapInfo Symbol 编号 / 形状名）：仅**非圆形**形状用 L.marker + SVG 图标，
        // 圆形与无形状信息一样走 circleMarker —— SVG 图标是 DOM 渲染，上万点的图层缩放/平移会卡，
        // 而圆形用 Canvas 圆点视觉等价（与 LayerEditSession 的 circle 处理一致）
        const iconShape = point.shapeName && point.shapeName !== 'circle' ? point.shapeName : null
        if (iconShape && !point.noFill) {
          const iconPx = Math.max(12, Math.min(36, Math.round(point.markerSize * 2)))
          const icon = L.icon({
            iconUrl: pointShapeIconDataUri(iconShape, point.markerColor, point.noStroke ? 'none' : point.strokeColor),
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
          radius: point.markerSize,
          fill: !point.noFill,
          fillColor: point.markerColor,
          // 边框颜色/填充透明度：专题启用时用专题设置（缺省回退专题色/基础样式）；
          // 边框色为无色哨兵时 stroke:false 不描边
          stroke: !point.noStroke,
          color: point.strokeColor,
          weight: point.weight,
          opacity: point.opacity,
          fillOpacity: point.fillOpacity
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
          // 要素级编辑样式优先于图层默认与图层级用户设置
          const es = editStyleForKind(feature.properties, 'line')
          if (es) {
            if (es.color) mergedStyle.color = es.color
            if (es.weight !== undefined) mergedStyle.weight = Number(es.weight)
            if (es.opacity !== undefined) mergedStyle.opacity = Number(es.opacity)
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
            // 线无填充：图形透明度作用于线条透明度（边框颜色对线不适用）
            if (typeof mapInfoLayer.thematicSettings?.fillOpacity === 'number') {
              result.opacity = mapInfoLayer.thematicSettings.fillOpacity
            }
          }
          // 线色为无色哨兵（图形颜色选"无色"）：整条线不绘制，color 置占位色避免非法值
          if (result.color === NO_FILL_COLOR) {
            result.stroke = false
            result.color = DEFAULT_STYLES.line.color
          }
          const lineDashArray = (es as any)?.dashArray ?? userLine.dashArray ?? featureStyle.strokeDasharray
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
          // 要素级编辑样式优先于图层默认与图层级用户设置
          const esPoly = editStyleForKind(feature.properties, 'polygon')
          if (esPoly) {
            if (esPoly.fillColor) mergedStyle.fillColor = esPoly.fillColor
            if (esPoly.fillOpacity !== undefined) mergedStyle.fillOpacity = Number(esPoly.fillOpacity)
            if (esPoly.borderColor) mergedStyle.color = esPoly.borderColor
            if (esPoly.borderWidth !== undefined) mergedStyle.weight = Number(esPoly.borderWidth)
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
            fillOpacity: noFill ? 0 : (mergedStyle.fillOpacity || 1)
          }
          // 面状图层：专题"边框宽度"设置优先（专题启用时）
          if (mapInfoLayer.thematicSettings?.enabled && mapInfoLayer.thematicSettings.pointSize) {
            result.weight = mapInfoLayer.thematicSettings.pointSize
          }
          const thematicColor = mapInfoLayer._thematicColor(feature)
          if (thematicColor) {
            // 边框色：专题边框色优先；专题无色（镂空）且未设边框色时保留基础边框色
            if (mapInfoLayer.thematicSettings?.borderColor) {
              result.color = mapInfoLayer.thematicSettings.borderColor
            } else if (thematicColor !== NO_FILL_COLOR) {
              result.color = thematicColor
            }
            result.fillColor = thematicColor
            if (typeof mapInfoLayer.thematicSettings?.fillOpacity === 'number') {
              result.fillOpacity = mapInfoLayer.thematicSettings.fillOpacity
            }
          }
          // 无色（镂空）：面不填充，仅显示边框
          if (result.fillColor === NO_FILL_COLOR) {
            result.fill = false
          }
          // 边框颜色为无色哨兵（基础/专题边框色选"无色"）：不描边，color 置占位色避免非法值
          if (result.color === NO_FILL_COLOR) {
            result.stroke = false
            result.color = DEFAULT_STYLES.polygon.color
          }
          const polygonDashArray = (esPoly as any)?.borderDash ?? userPolygon.dashArray ?? featureStyle.strokeDasharray
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

        // 要素点击属性弹窗统一由地图 click 穿透所有图层检测处理（OnlineMap.handleMapClick），
        // 不再逐要素绑定 click + stopPropagation —— 否则最上层 Canvas 图层吞掉点击后，
        // 下层图层要素无法点选，重叠检测退化为只响应最上层图层。
      }
    }

    // 🔧 分块构建：避免一次性同步创建数万要素阻塞主线程（大数据集渐进显示）
    // 先建空 GeoJSON 图层（继承 renderer/pointToLayer/style/onEachFeature 配置），再分块 addData
    mapInfoLayer.geoJSONLayer = L.geoJSON([], geoJsonOptions as any)
    await mapInfoLayer._addGeoJSONChunks(transformedData)
    // "带方向线段的线"：要素样式（_editStyle.arrow）需要在地图上叠加箭头装饰
    mapInfoLayer._rebuildLineArrows()

    return mapInfoLayer
  }

  /**
   * 重建线要素方向箭头装饰（"带方向线段的线"）：
   * 逐要素检查 _editStyle.arrow（绘制/风格面板配置，保存于 NPT_FEATSYM），
   * 用该线当前渲染色沿线等距布置箭头 divIcon；数量超上限时截断（大图层防 DOM 爆炸）。
   */
  private _rebuildLineArrows(): void {
    if (!this.lineArrowGroup) this.lineArrowGroup = L.layerGroup()
    this.lineArrowGroup.clearLayers()
    if (!this.geoJSONLayer) return
    let count = 0
    this.geoJSONLayer.eachLayer((layer: any) => {
      if (count >= MAX_LINE_ARROWS_PER_LAYER) return
      const geomType = layer?.feature?.geometry?.type
      if (geomType !== 'LineString' && geomType !== 'MultiLineString') return
      const es = editStyleForKind(layer.feature?.properties, 'line')
      if (es?.arrow !== true) return
      // 线色为无色哨兵时不描边，也不画箭头
      if (layer.options?.stroke === false || layer.options?.color === NO_FILL_COLOR) return
      const markers = buildLineArrows(layer.getLatLngs?.(), {
        color: layer.options?.color || DEFAULT_STYLES.line.color,
        opacity: layer.options?.opacity ?? 1,
      })
      for (const m of markers) {
        if (count >= MAX_LINE_ARROWS_PER_LAYER) break
        this.lineArrowGroup!.addLayer(m)
        count += 1
      }
    })
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
   * 解析一个点要素当前应显示的完整配色（专题优先、基础次之）。
   *
   * 创建（pointToLayer）与恢复（_applyFeatureStyle）必须共用同一份解析结果：
   * 早期两处各算一遍且恢复侧漏掉了要素自带配色（_style）与要素级编辑样式
   * （_editStyle），导致圈选后「未选中」的点被刷成橙色 + 黑边。
   */
  private _resolvePointStyle(feature: any): {
    markerSize: number
    markerColor: string
    strokeColor: string
    noFill: boolean
    noStroke: boolean
    shapeName: string | null
    weight: number
    opacity: number
    fillOpacity: number
  } {
    // 合并优先级：默认样式 < 要素样式(_style，扁平结构，含 markerSymbol/markerColor/markerSize)
    //                 < 图层级用户设置(style.point)
    const featureStyle = (feature?.properties as any)?._style || {}
    const pointStyle: any = { ...DEFAULT_STYLES.point, ...featureStyle, ...this.style.point }

    // 要素级编辑样式（用户绘制/配置的 _editStyle）优先于图层默认与图层级设置
    const es = editStyleForKind(feature?.properties, 'point')
    if (es) {
      if (es.markerColor) {
        pointStyle.markerColor = es.markerColor
        pointStyle.fillColor = es.markerColor
      }
      if (es.borderColor) pointStyle.color = es.borderColor
      if (es.markerShape) pointStyle.markerSymbol = es.markerShape
      // 编辑样式 markerSize 为图标直径；MapInfoLayer 约定 markerSize 为半径（iconPx = 半径×2）
      if (es.markerSize !== undefined) pointStyle.markerSize = Number(es.markerSize) / 2
    }

    // 专题启用：按字段值配色，点大小用图形大小设置
    const thematicColor = this._thematicColor(feature)
    if (thematicColor) {
      pointStyle.markerColor = thematicColor
      pointStyle.fillColor = thematicColor
      pointStyle.color = thematicColor
    }

    const markerSize = (thematicColor && this.thematicSettings?.pointSize)
      ? this.thematicSettings.pointSize
      : (pointStyle.markerSize || pointStyle.radius || 6)
    const markerColorRaw = pointStyle.markerColor || pointStyle.fillColor || '#f59e0b'
    // 无色（镂空）：fill:false 仅显示描边；形状图标无法表达镂空，统一回退 circleMarker
    const noFill = markerColorRaw === NO_FILL_COLOR
    const markerColor = noFill ? '#f59e0b' : markerColorRaw
    // 边框色：专题边框色优先，'none'（无色）→ 不描边；专题填充无色且未设边框色时
    // 回退基础边框色（镂空也要有边框）；非专题用基础边框色（缺省为无色哨兵，不画白边），
    // 'none' 同样不描边
    let strokeColor: string
    let noStroke = false
    const thematicBorderColor = this.thematicSettings?.borderColor
    if (thematicColor) {
      if (thematicBorderColor === NO_FILL_COLOR) {
        noStroke = true
        strokeColor = '#000000'
      } else if (thematicBorderColor) {
        strokeColor = thematicBorderColor
      } else {
        strokeColor = thematicColor === NO_FILL_COLOR
          ? (pointStyle.color && pointStyle.color !== NO_FILL_COLOR ? pointStyle.color : '#fff')
          : thematicColor
      }
    } else {
      noStroke = pointStyle.color === NO_FILL_COLOR
      strokeColor = noStroke ? '#000000' : (pointStyle.color || NO_FILL_COLOR)
    }

    return {
      markerSize,
      markerColor,
      strokeColor,
      noFill,
      noStroke,
      shapeName: resolvePointShape(pointStyle.markerSymbol),
      weight: pointStyle.weight || 2,
      opacity: pointStyle.opacity || 1,
      fillOpacity: thematicColor
        ? (this.thematicSettings?.fillOpacity ?? pointStyle.fillOpacity ?? 0.8)
        : (pointStyle.fillOpacity || 0.8),
    }
  }

  /**
   * 应用单个要素的当前应显示样式（专题优先、基础次之）
   * 点要素由 pointToLayer 创建（style 函数对 Point 返回 {}，resetStyle 对其无效，
   * 且 Leaflet resetStyle 会把 layer.options 还原为创建时快照 defaultOptions，
   * 使后续专题/基础配色丢失），必须对点要素直接 setStyle / setIcon；
   * 线/面走 style 函数 resetStyle 即可（style 回调已含专题逻辑）。
   */
  private _applyFeatureStyle(layer: any): void {
    if (layer instanceof L.CircleMarker) {
      const point = this._resolvePointStyle(layer.feature)
      layer.setStyle({
        fill: !point.noFill,
        fillColor: point.markerColor,
        fillOpacity: point.fillOpacity,
        stroke: !point.noStroke,
        color: point.strokeColor,
        weight: point.weight,
        opacity: point.opacity,
        radius: point.markerSize,
      })
    } else if (layer instanceof L.Marker) {
      // 点形状（L.marker + SVG 图标）：用新填充色重新生成图标（无色镂空不适用图标，回退兜底色）
      const point = this._resolvePointStyle(layer.feature)
      const shapeName = point.shapeName
      if (shapeName) {
        // 形状图标直径 = 半径×2（与专题图形大小逻辑一致）
        const iconSize = Math.max(12, Math.min(36, Math.round(point.markerSize * 2)))
        const iconStroke = point.noStroke ? 'none' : point.strokeColor
        layer.setIcon(L.icon({
          iconUrl: pointShapeIconDataUri(shapeName, point.markerColor, iconStroke),
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
    // 线色/透明度变化后同步箭头装饰配色
    this._rebuildLineArrows()
  }

  /**
   * 设置图层颜色覆盖（图形颜色 / 透明度 / 边框宽度 / 边框颜色）
   * 写入 style 配置后重新应用样式，使已渲染要素即时生效。
   */
  setStyleOverrides(settings: { fillColor: string; fillOpacity: number; borderWidth: number; borderColor: string; pointSize?: number }): void {
    // 点样式：填充 + 边框；图形大小（点要素半径）覆盖到 radius
    this.style.point = {
      ...this.style.point,
      fillColor: settings.fillColor,
      fillOpacity: settings.fillOpacity,
      color: settings.borderColor,
      weight: settings.borderWidth,
      opacity: 1,
      ...(typeof settings.pointSize === 'number' ? { radius: settings.pointSize } : {})
    }

    // 线样式：无填充，透明度作用于描边。
    // 线状图层设置页只有"图形颜色/线宽/透明度"，线色取图形颜色（fillColor）；
    // 兼容旧版本设置（旧版线色保存在 borderColor）：borderColor 为有效颜色时优先使用
    const lineColor = settings.borderColor && settings.borderColor !== NO_FILL_COLOR
      ? settings.borderColor
      : settings.fillColor
    this.style.line = {
      ...this.style.line,
      color: lineColor,
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
   * 收集热力图点（后端 GeoJSON 坐标已转 GCJ02）：
   * 点用自身坐标；线/面（含 Multi*）取全部顶点算术平均质心；权重非数值的要素跳过。
   */
  getHeatPoints(field: string): HeatPoint[] {
    if (!this.geoJSONLayer || !field) return []
    const points: HeatPoint[] = []
    this.geoJSONLayer.eachLayer((layer: any) => {
      const feature = layer?.feature as GeoJSON.Feature | undefined
      if (!feature?.geometry || !feature.properties) return
      const weight = toNumber(getFieldValue(feature.properties as Record<string, any>, field))
      if (weight === null) return
      const c = geometryCentroid(feature.geometry)
      if (c) points.push({ lat: c.lat, lng: c.lng, weight })
    })
    return points
  }

  /**
   * 设置是否允许交互（框选/测距模式下关闭）：
   * 直接切换各要素 options.interactive —— Canvas 渲染器命中检测实时读取该选项，
   * 关闭后要素不拦截鼠标事件，点击穿透到地图（供框选/测量工具使用），悬停 tooltip 也不弹出。
   */
  setInteractive(interactive: boolean): void {
    this.geoJSONLayer?.eachLayer((layer: any) => {
      if (layer.options) {
        layer.options.interactive = interactive
      }
      if (!interactive && layer.closeTooltip) {
        layer.closeTooltip()
      }
    })
  }

  /**
   * 设置测距模式
   * 测距时所有要素不参与 Canvas 命中检测（options.interactive=false），点击穿透到地图供测量加点。
   * Canvas 渲染器在命中检测时实时读取 options.interactive，无需重绘。
   * @param enabled 是否启用测距模式
   */
  setMeasureMode(enabled: boolean): void {
    this.setInteractive(!enabled)
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
          // 高亮样式：红色边框（保留当前填充色/专题配色）；
          // stroke:false（无色边框）要素需临时恢复描边，否则高亮不可见
          layer.setStyle({
            stroke: true,
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

    if (visible) {
      // 🔧 首次开启标签且尚无用户自定义字段时，自动挑选一个合适的默认标签字段，
      // 使新导入的图层一开启标签即可显示要素名称（无需先进"自定义设置"保存）
      if (!this.labelConfigCustomized) {
        this._resolveDefaultLabelField()
      }
      if (this.currentMap || this.editLabelFeatures) {
        // 标签候选注册不依赖图层在地图上：编辑态原图层已移除（currentMap=null），
        // 标签改从编辑工作集注册，保证"标签开关打开后打开编辑开关"标签不消失
        this._createLabels(this.currentMap)
      }
      // 图层尚未添加到地图时，addTo() 会在挂载时自动创建标签
    } else {
      this._removeLabels()
    }
  }

  /**
   * 编辑态标签源覆盖：传入工作集要素时，标签候选改从工作集构建（与编辑会话渲染一致，
   * 删除/新增/拖动的要素标签随工作集同步）；传入 null 恢复从图层自身数据构建。
   * 仅在标签开关已开启时立即生效，否则仅记录，待 setLabelVisibility(true) 时应用。
   */
  setEditLabelSource(features: any[] | null): void {
    this.editLabelFeatures = features
    if (!this.labelManager) return
    if (this.labelsEnabled && (features || this.currentMap)) {
      // features 非空时图层可能已从地图移除（编辑态 currentMap=null），仍需注册工作集标签
      this._createLabels(this.currentMap)
    } else if (!features) {
      // 图层不在地图上（currentMap=null）且无编辑源时不注册全量标签，避免隐藏图层残留标签
      this._removeLabels()
    }
  }

  /**
   * 设置标签配置
   * @param config 标签配置
   */
  setLabelConfig(config: { content: string; color: string; fontSize: number }): void {
    // 标记为用户显式保存过配置，后续不再自动挑选默认字段
    this.labelConfigCustomized = true
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
   * 首次开启标签且无自定义字段时，自动挑选默认标签字段。
   * 优先级：名称类候选字段（name/NAME/小区名称/LABEL/OBJNAM…）→ 首个非噪音字段；
   * 均无则保持原默认 'name'（该字段不匹配时要素不显示标签，等待用户进设置选择）。
   */
  private _resolveDefaultLabelField(): void {
    if (!this.geoJSONLayer) return

    const present = new Map<string, boolean>()   // 字段名 → 是否有非空值
    const orderedKeys: string[] = []
    this.geoJSONLayer.eachLayer((layer: any) => {
      const feature = layer.feature
      const props = feature?.properties || {}
      const nested = props.properties || props.attributes
      const sources = nested && typeof nested === 'object' ? [props, nested] : [props]
      for (const src of sources) {
        if (!src || typeof src !== 'object') continue
        for (const key of Object.keys(src)) {
          const v = src[key]
          if (v === undefined || v === null) continue
          const s = String(v).trim()
          if (!s) continue
          if (!present.has(key)) {
            present.set(key, true)
            orderedKeys.push(key)
          }
        }
      }
    })
    if (orderedKeys.length === 0) return

    // 1) 名称类候选字段
    for (const cand of NAME_LABEL_CANDIDATES) {
      if (present.has(cand)) {
        this.labelConfig = { ...this.labelConfig, content: cand }
        if (IS_DEV) console.log('[MapInfoLayer] 自动选用名称类标签字段:', this.id, cand)
        return
      }
    }
    // 2) 首个非噪音字段
    const fallback = orderedKeys.find((k) => !NOISE_LABEL_KEYS.has(k))
    if (fallback) {
      this.labelConfig = { ...this.labelConfig, content: fallback }
      if (IS_DEV) console.log('[MapInfoLayer] 自动选用首个可用标签字段:', this.id, fallback)
    }
  }

  /**
   * 更新缩放级别
   * 标签布局由 LabelLayoutManager 在 zoomend 统一重排，此处仅记录缩放级别
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  updateZoom(_zoom: number): void {
    // 标签布局由 LabelLayoutManager 在 zoomend 统一重排，无需图层自身处理
  }

  /**
   * 同步标签候选到共享标签布局引擎
   *
   * 所有要素的标签候选（地理坐标 + 文本 + 样式）注册到 LabelLayoutManager，
   * 由引擎按屏幕空间统一做矩形碰撞检测与避让，跨图层全局不重叠；
   * 视口裁剪、地图移动/缩放后的显隐均由引擎处理。
   */
  private _createLabels(_map: L.Map | null): void {
    if (!this.labelManager) return
    // 编辑态：原图层隐藏后标签改从编辑工作集要素构建（与编辑会话渲染一致）
    if (this.editLabelFeatures) {
      this._createLabelsFromEditFeatures()
      return
    }
    if (!this.geoJSONLayer) return

    const candidates: LabelCandidate[] = []
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

        const labelContent = this._getLabelContent(properties)
        if (!labelContent) return

        candidates.push({
          id: String(layer._nptSelectionId || index),
          lat: latLng.lat,
          lng: latLng.lng,
          text: labelContent,
          fontSize: this.labelConfig.fontSize,
          fontFamily: this.labelConfig.fontFamily,
          bold: this.labelConfig.bold,
          italic: this.labelConfig.italic,
          shadow: this.labelConfig.shadow,
          background: this.labelConfig.background,
          backgroundColor: this.labelConfig.backgroundColor,
          color: this.labelConfig.color
        })
        index++
      } catch (err) {
        // 静默忽略单个要素的错误
      }
    })

    this.labelManager.setCandidates(this.labelSourceId, candidates)
    if (IS_DEV) console.log(`[MapInfoLayer] 已注册 ${candidates.length} 个标签候选:`, this.id)
  }

  /**
   * 编辑态：从编辑工作集要素构建标签候选（GeoJSON 直接计算锚点，不依赖渲染层）。
   * 锚点：点=坐标本身；线/面=外接矩形中心（与渲染层 getBounds().getCenter() 一致）。
   */
  private _createLabelsFromEditFeatures(): void {
    if (!this.labelManager) return

    const candidates: LabelCandidate[] = []
    let index = 0

    for (const feature of this.editLabelFeatures!) {
      try {
        const properties = feature?.properties || {}
        const anchor = this._labelAnchorFromGeometry(feature?.geometry)
        if (!anchor) continue
        const labelContent = this._getLabelContent(properties)
        if (!labelContent) continue

        candidates.push({
          // 用编辑要素的稳定 _editId，拖动/重建后标签候选不闪烁
          id: String(properties._editId || `edit-${index}`),
          lat: anchor.lat,
          lng: anchor.lng,
          text: labelContent,
          fontSize: this.labelConfig.fontSize,
          fontFamily: this.labelConfig.fontFamily,
          bold: this.labelConfig.bold,
          italic: this.labelConfig.italic,
          shadow: this.labelConfig.shadow,
          background: this.labelConfig.background,
          backgroundColor: this.labelConfig.backgroundColor,
          color: this.labelConfig.color
        })
        index++
      } catch (err) {
        // 静默忽略单个要素的错误
      }
    }

    this.labelManager.setCandidates(this.labelSourceId, candidates)
  }

  /** 从 GeoJSON 几何计算标签锚点（点=坐标；线/面=外接矩形中心） */
  private _labelAnchorFromGeometry(geometry: any): { lat: number; lng: number } | null {
    if (!geometry) return null

    const coords = (geometry as any).coordinates
    const type = (geometry as any).type
    if (!coords) return null

    const walk = (c: any): [number, number, number, number] | null => {
      if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
        return [c[0] as number, c[1] as number, c[0] as number, c[1] as number]
      }
      if (!Array.isArray(c) || c.length === 0) return null
      let bbox: [number, number, number, number] | null = null
      for (const child of c) {
        const b = walk(child)
        if (!b) continue
        bbox = bbox
          ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])]
          : b
      }
      return bbox
    }

    const bbox = walk(coords)
    if (!bbox) return null
    // GeoJSON 坐标为 [lng, lat]
    if (type === 'Point') {
      return { lat: bbox[1], lng: bbox[0] }
    }
    return { lat: (bbox[1] + bbox[3]) / 2, lng: (bbox[0] + bbox[2]) / 2 }
  }

  /**
   * 移除所有标签（从共享布局引擎注销本层候选）
   */
  private _removeLabels(_targetMap?: L.Map): void {
    this.labelManager?.removeSource(this.labelSourceId)
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
  /** 共享标签布局引擎（所有图层的标签统一防重叠） */
  private labelManager: LabelLayoutManager | null = null

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
   * 设置地图实例（可同时注入共享标签布局引擎）
   */
  setMap(map: L.Map, labelManager?: LabelLayoutManager | null): void {
    this.map = map
    if (labelManager !== undefined) this.labelManager = labelManager
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

    const layer = await MapInfoLayer.fromGeoJSON(
      this.labelManager ? { ...options, labelManager: this.labelManager } : options
    )
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

/**
 * GeoJSON 几何质心（全部顶点算术平均，兼容 Point/Line/Polygon 及 Multi*）
 * 坐标为 GeoJSON 序 [lng, lat]（后端已转 GCJ02）。
 */
function geometryCentroid(geometry: GeoJSON.Geometry): { lat: number; lng: number } | null {
  const positions: [number, number][] = []
  const walk = (node: any): void => {
    if (!Array.isArray(node) || node.length === 0) return
    if (typeof node[0] === 'number') {
      positions.push([node[0], node[1]])
      return
    }
    for (const child of node) walk(child)
  }
  // GeoJSON.Geometry 是含 GeometryCollection 的 union，坐标统一按 any 递归取值
  walk((geometry as any).coordinates)
  let lngSum = 0
  let latSum = 0
  let n = 0
  for (const [lng, lat] of positions) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
    lngSum += lng
    latSum += lat
    n++
  }
  if (n === 0) return null
  return { lat: latSum / n, lng: lngSum / n }
}
