/**
 * 地理化数据图层渲染器
 *
 * 功能:
 * - 智能识别数据类型：点、扇区、多边形
 * - 点状渲染：L.circleMarker (黑框白底)
 * - 扇区渲染：根据缩放级别 LOD 显示
 * - 多边形渲染：L.polygon (黑框白底)
 * - 支持点击事件和标签显示
 * - Canvas 标签渲染（性能优化）
 *
 * 🔥 版本: 2025-03-29-v3 - Canvas 标签优化版本
 */
import L from 'leaflet'
import { CoordinateTransformer } from '../../utils/coordinate'
import type { LabelCandidate, LabelLayoutManager } from './LabelLayoutManager'
import { getFieldValue, matchThematicColor, matchRangeIndex, hasValue, toNumber, NO_FILL_COLOR } from '../../utils/fieldValue'
import type { ThematicSettings } from './LabelSettingsModal'
import type { HeatPoint } from '../../utils/heatmap'
import { centroidFromLatLngRing } from '../../utils/heatmap'
import { layerHitAt, CLICK_HIT_TOLERANCE_PX, layerGeometry, type FeatureHitType } from './mapHitTest'
import { geometryAnchor } from '../../services/boundarySelection'

console.log('🔥🔥🔥 GeoDataLayer.tsx 已加载 (2025-03-29-v3 Canvas优化版) 🔥🔥🔥')

export type GeoDataGeometryType = 'point' | 'sector' | 'polygon'

export interface GeoDataItem {
  // 基础字段（所有类型都有）
  name?: string
  properties: Record<string, any>

  // 点/扇区专用
  longitude?: number
  latitude?: number
  displayLng?: number
  displayLat?: number
  azimuth?: number
  beamwidth?: number
  cell_cover_type?: number

  // 多边形专用（已转换好的GCJ02坐标，[lat, lng]顺序）
  path?: [number, number][]

  /** 圈选结果附带 GeoJSON 几何（GCJ02；跨图层复制粘贴用，getFeaturesIn* 方法填充） */
  geometry?: { type: string; coordinates: any }
}

export interface GeoDataLayerOptions {
  id: string
  name: string
  geometryType: GeoDataGeometryType
  data: GeoDataItem[]
  visible?: boolean
  /** 缩放级别（用于LOD策略） */
  zoom?: number
  /** 共享标签布局引擎（统一防重叠，跨图层不重叠） */
  labelManager?: LabelLayoutManager
}

// 默认样式：黑框白底
const DEFAULT_POINT_STYLE = {
  radius: 10,  // 10像素半径（固定大小，不随缩放变化）
  fillColor: '#ffffff',
  color: '#000000',
  weight: 2,
  opacity: 1,
  fillOpacity: 1
}

const DEFAULT_SECTOR_STYLE = {
  fillColor: '#ffffff',
  color: '#000000',
  weight: 2,
  opacity: 1,
  // 默认不透明度 100%（用户要求：地图上所有图形的默认不透明度都是 100%）
  fillOpacity: 1
}

const DEFAULT_POLYGON_STYLE = {
  fillColor: '#ffffff',
  color: '#000000',
  weight: 2,
  opacity: 1,
  // 默认不透明度 100%（同上）
  fillOpacity: 1
}

// LOD 阈值
const LOD_THRESHOLD = 9

/**
 * 创建扇区多边形坐标
 * @param lat 纬度
 * @param lng 经度
 * @param azimuth 方位角（度数，导航坐标：正北为0度，顺时针增加）
 * @param beamwidth 扇形角度（度数）
 * @param radiusMeters 扇形半径（米）
 */
function createSectorPolygon(
  lat: number,
  lng: number,
  azimuth: number,
  beamwidth: number,
  radiusMeters: number
): L.LatLngExpression[] {
  // 将米转换为经纬度距离
  const latDeg = radiusMeters / 111320
  const lngDeg = radiusMeters / (111320 * Math.cos(lat * Math.PI / 180))

  // 🔧 修复：使用导航坐标系（正北=0°，顺时针）
  // 扇形半角（度数转弧度）
  const halfBeam = (beamwidth / 2) * (Math.PI / 180)
  // 方位角转弧度（正北为0，顺时针）
  const aziRad = azimuth * (Math.PI / 180)

  // 计算扇形边界点
  const points: L.LatLngExpression[] = [[lat, lng]]

  // 🔧 关键修复：从方位角 - 半宽 到 方位角 + 半宽
  const startAngle = aziRad - halfBeam
  const endAngle = aziRad + halfBeam
  const numPoints = Math.max(6, Math.ceil(beamwidth / 5))

  for (let i = 0; i <= numPoints; i++) {
    const angle = startAngle + (endAngle - startAngle) * (i / numPoints)
    // 🔧 使用 sin 计算经度（x方向），cos 计算纬度（y方向）
    // 因为 angle=0 时应该指向正北（纬度增加方向）
    const x = lng + lngDeg * Math.sin(angle)
    const y = lat + latDeg * Math.cos(angle)
    points.push([y, x])
  }

  points.push([lat, lng]) // 闭合
  return points
}

/**
 * 地理化数据图层类
 */
export class GeoDataLayer {
  private id: string
  private name: string
  private geometryType: GeoDataGeometryType
  private data: GeoDataItem[]
  private leafletLayer: L.LayerGroup | null = null
  private featureGroup: L.FeatureGroup | null = null  // 聚合图层
  private currentZoom: number = 12
  private labelsEnabled: boolean = false
  private visible: boolean = false
  private map: L.Map | null = null

  // 共享标签布局引擎（标签防重叠统一由 LabelLayoutManager 处理）
  private labelManager: LabelLayoutManager | null
  private labelSourceId: string

  // 共享 Canvas renderer：几万个 circleMarker/polygon 用 SVG 渲染会 DOM 爆炸卡顿，
  // Canvas 大幅减少 DOM 节点（circleMarker/polygon 均支持 Canvas + 点击 + tooltip）
  private canvasRenderer: L.Renderer | null = null

  // 标签配置
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
  } = {
    content: 'name',
    color: '#000000',
    fontSize: 12
  }

  // 图层颜色覆盖（图形颜色 / 透明度 / 边框宽度 / 边框颜色）
  private styleOverrides: { fillColor: string; fillOpacity: number; borderWidth: number; borderColor: string; pointSize?: number } | null = null

  // 专题图层设置（启用时优先于 styleOverrides；null 表示未启用）
  private thematicSettings: ThematicSettings | null = null
  // 专题区间统计（每个区间的要素数/总数，用于图例展示）
  private thematicStats: { counts: number[]; total: number; other: number } | null = null

  // 几何图形重新渲染定时器
  private _geometryRenderTimer: number | null = null
  // 初始分块渲染定时器 + 令牌（令牌递增用于取消过期批次）
  private _chunkTimer: number | null = null
  private _renderToken: number = 0
  // 缩放事件处理函数引用（用于取消注册）
  private _onZoomBound: (() => void) | null = null
  private _onZoomEndBound: (() => void) | null = null
  // 拖拽（move）节流字段
  private _onMoveBound: (() => void) | null = null
  private _lastMoveRenderTime: number = 0
  // 缩放动画帧 ID
  private _zoomAnimFrameId: number | null = null
  // 交互状态标志
  private isInteractive: boolean = true
  // 测距模式标志：测距时要素不拦截鼠标事件（点击/悬停穿透到地图，供测量加点）
  private measureMode: boolean = false
  // 框选高亮状态
  private selectionHighlightIds: Set<string> | null = null
  private _originalMarkerStyles: Map<L.Marker, string> = new Map() // Marker高亮前保存原始outline
  // 存储原始样式以便恢复
  private originalStyles: Map<L.Layer, any> = new Map()

  constructor(options: GeoDataLayerOptions) {
    this.id = options.id
    this.name = options.name
    this.geometryType = options.geometryType
    this.data = options.data
    this.currentZoom = options.zoom || 12
    this.visible = options.visible ?? false
    this.labelManager = options.labelManager || null
    this.labelSourceId = `geo-${options.id}`

    // 创建聚合图层
    this.featureGroup = L.featureGroup()

    // 共享 Canvas renderer（大点/扇区/多边形数据集渲染加速）
    this.canvasRenderer = L.canvas()
  }

  /**
   * 添加到地图
   */
  addTo(map: L.Map): this {
    console.log('[GeoDataLayer] ========== addTo 被调用 ==========')
    console.log('[GeoDataLayer] this:', this)
    console.log('[GeoDataLayer] geometryType:', this.geometryType)
    console.log('[GeoDataLayer] visible:', this.visible)
    console.log('[GeoDataLayer] data.length:', this.data.length)
    console.log('[GeoDataLayer] data[0]:', this.data[0])

    this.map = map

    // 🔧 注册缩放事件处理器（防重复注册：先清理旧的再再注册新的）
    if (this._onZoomBound) {
      map.off('zoom', this._onZoomBound)
    }
    if (this._onZoomEndBound) {
      map.off('zoomend', this._onZoomEndBound)
    }
    this._onZoomBound = this._handleZoom.bind(this)
    this._onZoomEndBound = this._handleZoomEnd.bind(this)
    map.on('zoom', this._onZoomBound)
    map.on('zoomend', this._onZoomEndBound)

    // 🔧 拖拽（纯平移）实时刷新可视区域：move 高频触发，_handleMove 内做固定间隔节流
    if (this._onMoveBound) {
      map.off('move', this._onMoveBound)
    }
    this._onMoveBound = () => this._handleMove()
    map.on('move', this._onMoveBound)

    // 🔧 修复：添加到地图时，清理可能存在的旧定时器
    // 防止之前的 _reRenderGeometries 定时器在新图层创建后触发并清空它
    if (this._geometryRenderTimer !== null) {
      clearTimeout(this._geometryRenderTimer)
      this._geometryRenderTimer = null
      console.log('[GeoDataLayer] addTo: 已清理旧的 _geometryRenderTimer')
    }
    if (this._zoomAnimFrameId !== null) {
      cancelAnimationFrame(this._zoomAnimFrameId)
      this._zoomAnimFrameId = null
    }

    // 🔧 修复：安全地检查图层是否在地图上
    const leafletLayerOnMap = this.leafletLayer && map.hasLayer(this.leafletLayer)
    console.log('[GeoDataLayer] leafletLayerOnMap:', leafletLayerOnMap, 'leafletLayer 存在:', !!this.leafletLayer)

    // 总是创建并添加 featureGroup（即使图层不可见），这样标签才能正常工作
    if (!this.featureGroup) {
      this.featureGroup = L.featureGroup()
    }
    if (!map.hasLayer(this.featureGroup)) {
      this.featureGroup.addTo(map)
      console.log('[GeoDataLayer] featureGroup 已添加到地图 (visible=' + this.visible + ')')
    }

    // 如果图层不可见
    if (!this.visible) {
      console.log('[GeoDataLayer] ⚠️ 图层不可见，跳过渲染几何图形')
      // 确保有空的 leafletLayer 在地图上（用于图层管理）
      if (!this.leafletLayer) {
        this.leafletLayer = L.layerGroup()
      }
      if (!leafletLayerOnMap) {
        this.leafletLayer.addTo(map)
        console.log('[GeoDataLayer] 空 leafletLayer 已添加到地图')
      }
      return this
    }

    // 🔧 图层可见时：清理并重新渲染
    // 如果 leafletLayer 已在地图上，先移除它以便重新渲染
    if (leafletLayerOnMap && this.leafletLayer) {
      console.log('[GeoDataLayer] 移除旧的 leafletLayer')
      map.removeLayer(this.leafletLayer)
    }

    // 创建新的 leafletLayer 并渲染几何图形
    this.leafletLayer = L.layerGroup()
    console.log('[GeoDataLayer] leafletLayer 已创建')

    // 🔧 修复：更新 currentZoom 为当前地图的实际缩放级别
    // 防止图层关闭期间地图缩放过，重新打开时使用旧值导致渲染错误
    const currentMapZoom = map.getZoom()
    if (this.currentZoom !== currentMapZoom) {
      console.log('[GeoDataLayer] 更新 currentZoom:', this.currentZoom, '->', currentMapZoom)
      this.currentZoom = currentMapZoom
    }

    // 🔧 分块渲染：视口裁剪 + 批次让步，避免一次性创建全量要素阻塞主线程
    // 大数据集渐进显示；小数据集因分块粒度小，耗时差异可忽略
    this._renderChunked()

    console.log('[GeoDataLayer] 将 leafletLayer 添加到地图，已渲染', this.leafletLayer.getLayers().length, '个图层')
    this.leafletLayer.addTo(map)

    // 重新渲染后恢复选中高亮
    if (this.selectionHighlightIds) {
      this.setSelectionHighlight(this.selectionHighlightIds)
    }

    // 勾选图层时同步标签候选到共享布局引擎（幂等：全量替换本层候选）
    if (this.labelsEnabled && this.visible) {
      this._createLabels(map)
    }

    console.log('[GeoDataLayer] ========== addTo 完成 ==========')
    return this
  }

  /**
   * 过滤当前视口（含缓冲）内的要素
   * 点/扇区按中心点判断；多边形按任一顶点是否在视口内判断
   */
  private _filterVisible(pad: L.LatLngBounds): GeoDataItem[] {
    const out: GeoDataItem[] = []
    for (const item of this.data) {
      if (this.geometryType === 'polygon') {
        if (item.path && item.path.some(p => pad.contains([p[0], p[1]]))) out.push(item)
        continue
      }
      if (item.longitude === undefined || item.latitude === undefined) continue
      const [dlat, dlng] = item.displayLat !== undefined && item.displayLng !== undefined
        ? [item.displayLat, item.displayLng]
        : CoordinateTransformer.wgs84ToGcj02(item.latitude, item.longitude)
      if (pad.contains([dlat, dlng])) out.push(item)
    }
    return out
  }

  /**
   * 分块渲染（初始渲染 / 视口裁剪 + 批次让步）
   *
   * 大数据集一次性创建数万个 Leaflet 图层会阻塞主线程，导致勾选后长时间无响应。
   * 这里按批次（每帧一批）用 setTimeout 让步渲染，UI 保持响应、要素渐进显示。
   * 新渲染会递增令牌使旧的未完成批次失效；移动/缩放过时由 _reRenderGeometries 接管。
   */
  private _renderChunked(): void {
    if (!this.leafletLayer || !this.map) return

    // 取消旧的分块渲染
    this._renderToken++
    const token = this._renderToken
    if (this._chunkTimer !== null) {
      clearTimeout(this._chunkTimer)
      this._chunkTimer = null
    }

    this.leafletLayer.clearLayers()

    const pad = this._padBounds(this.map.getBounds(), 0.2)
    const visible = this._filterVisible(pad)

    // 🔧 性能：批次 300→600 减半 setTimeout 空闲间隙（加快首屏出图，桌面端可接受）
    const BATCH = 600
    let i = 0
    const self = this

    const step = () => {
      if (token !== self._renderToken || !self.leafletLayer) {
        self._chunkTimer = null
        return
      }
      const end = Math.min(i + BATCH, visible.length)
      const slice = visible.slice(i, end)
      i = end
      if (slice.length > 0) {
        switch (self.geometryType) {
          case 'point':
            self._renderPoints(false, slice, self.leafletLayer)
            break
          case 'sector':
            self._renderSectors(false, slice, self.leafletLayer)
            break
          case 'polygon':
            self._renderPolygons(false, slice, self.leafletLayer)
            break
        }
      }
      if (i < visible.length) {
        self._chunkTimer = window.setTimeout(step, 0)
      } else {
        self._chunkTimer = null
        console.log(`[GeoDataLayer] 分块渲染完成: 视口内 ${visible.length}/${self.data.length} 个要素`)
        // 重新渲染后恢复选中高亮
        if (self.selectionHighlightIds) {
          self.setSelectionHighlight(self.selectionHighlightIds)
        }
      }
    }

    this._chunkTimer = window.setTimeout(step, 0)
  }

  /**
   * 渲染点状数据
   *
   * 🔧 使用 L.circleMarker（像素半径）+ 动态半径计算替代 L.circle（米半径）。
   * L.circle 在缩放动画后存在路径投影不更新的问题，改用 circleMarker + 重绘
   * 可以在每次缩放时精确控制显示大小。
   *
   * @param useCulling 是否使用视口裁剪（默认false显示全部，地图移动后设为true）
   * @param dataSlice 可选：只渲染数据切片（分块渲染用）
   * @param destLayer 可选：渲染目标图层（分块渲染用，默认 this.leafletLayer）
   */
  private _renderPoints(useCulling: boolean = false, dataSlice?: GeoDataItem[], destLayer?: L.LayerGroup): void {
    if (!this.leafletLayer || !this.map) return

    const source = dataSlice || this.data
    const target = destLayer || this.leafletLayer
    const bounds = this.map.getBounds()
    const paddedBounds = bounds ? this._padBounds(bounds, 0.1) : null
    const zoom = this.map.getZoom()

    let filteredCount = 0
    let renderedCount = 0
    let skippedNoCoords = 0

    for (let i = 0; i < source.length; i++) {
      const item = source[i]
      if (item.longitude === undefined || item.latitude === undefined) {
        skippedNoCoords++
        continue
      }

      const [displayLat, displayLng] = item.displayLat !== undefined && item.displayLng !== undefined
        ? [item.displayLat, item.displayLng]
        : CoordinateTransformer.wgs84ToGcj02(item.latitude, item.longitude)

      if (useCulling && paddedBounds && !paddedBounds.contains([displayLat, displayLng])) {
        filteredCount++
        continue
      }

      // 动态计算像素半径，模拟 10 米在当前缩放级别下的视觉大小
      const pixelRadius = this._metersToPixels(10, displayLat, zoom)
      // 基础配置"图形大小"设置：设置后以固定像素半径渲染（覆盖默认随缩放的 10 米半径）
      const baseRadius = (this.styleOverrides && typeof this.styleOverrides.pointSize === 'number')
        ? this.styleOverrides.pointSize
        : pixelRadius
      // 专题启用时用固定点大小（图形大小设置，优先于基础配置）
      const radius = (this.thematicSettings?.enabled && this.thematicSettings.pointSize)
        ? this.thematicSettings.pointSize
        : baseRadius

      const marker = L.circleMarker([displayLat, displayLng], {
        ...this._mergeStyleOverrides(DEFAULT_POINT_STYLE, item),
        radius,
        renderer: this.canvasRenderer || undefined,
        // 测距模式下要素不参与鼠标命中检测，点击穿透到地图（测量加点）
        interactive: !this.measureMode,
        properties: item.properties,
        name: item.name
      })

      // 要素点击属性弹窗统一由地图 click 穿透所有图层检测处理，
      // 不再逐要素绑定 click + stopPropagation（否则最上层 Canvas 图层会吞掉点击，
      // 下层图层要素无法点选）；tooltip 仍按交互开关绑定
      // 只在交互启用时绑定 tooltip
      if (this.isInteractive) {
        marker.bindTooltip(item.name || `点${i+1}`, { permanent: false, direction: 'top' })
      }
      marker.addTo(target!)
      renderedCount++
    }

    console.log(`[GeoDataLayer] _renderPoints 完成: 总数据=${source.length}, 无坐标=${skippedNoCoords}, 过滤=${filteredCount}, 渲染=${renderedCount}`)
  }

  /**
   * 渲染扇区数据
   * LOD策略: zoom <= 9 用圆点, zoom > 9 用扇形
   * @param useCulling 是否使用视口裁剪（默认false显示全部，地图移动后设为true）
   * @param dataSlice 可选：只渲染数据切片（分块渲染用）
   * @param destLayer 可选：渲染目标图层（分块渲染用，默认 this.leafletLayer）
   */
  private _renderSectors(useCulling: boolean = false, dataSlice?: GeoDataItem[], destLayer?: L.LayerGroup): void {
    if (!this.leafletLayer) return

    const source = dataSlice || this.data
    const target = destLayer || this.leafletLayer

    // 🔧 视口裁剪优化：获取当前视口边界
    const bounds = this.map?.getBounds()
    const paddedBounds = bounds ? this._padBounds(bounds, 0.1) : null  // 10% 缓冲

    console.log('[GeoDataLayer] _renderSectors: useCulling=', useCulling, 'bounds=', bounds, 'paddedBounds=', paddedBounds)
    if (bounds) {
      console.log('[GeoDataLayer] _renderSectors: bounds SouthWest=', bounds.getSouthWest(), 'NorthEast=', bounds.getNorthEast())
    }

    let filteredCount = 0
    let renderedCount = 0
    let skippedNoCoords = 0

    for (let i = 0; i < source.length; i++) {
      const item = source[i]
      if (item.longitude === undefined || item.latitude === undefined) {
        skippedNoCoords++
        continue
      }

      // 坐标转换
      const [displayLat, displayLng] = item.displayLat !== undefined && item.displayLng !== undefined
        ? [item.displayLat, item.displayLng]
        : CoordinateTransformer.wgs84ToGcj02(item.latitude, item.longitude)

      // 🔧 视口裁剪：只在启用时过滤
      if (useCulling && paddedBounds && !paddedBounds.contains([displayLat, displayLng])) {
        filteredCount++
        continue
      }

      const azimuth = item.azimuth || 0
      const coverType = item.cell_cover_type || 1

      // 渲染逻辑：
      // - 方位角360度 → 圆形（全向覆盖）
      // - 室内小区(coverType=4) 或 低缩放级别 → 圆点
      // - 其他情况 → 扇形
      const is360Degree = Math.abs(azimuth - 360) < 0.1

      if (is360Degree || coverType === 4 || this.currentZoom <= LOD_THRESHOLD) {
        // 渲染为圆点
        const marker = L.circleMarker([displayLat, displayLng], {
          ...this._mergeStyleOverrides(DEFAULT_POINT_STYLE, item),
          // 扇区属面状图层：尺寸设置语义为边框宽度（描边），圆点半径保持默认
          ...(this.thematicSettings?.enabled && this.thematicSettings.pointSize
            ? { weight: this.thematicSettings.pointSize }
            : {}),
          renderer: this.canvasRenderer || undefined,
          // 测距模式下要素不参与鼠标命中检测，点击穿透到地图（测量加点）
          interactive: !this.measureMode,
          properties: item.properties,
          name: item.name
        })
        // 要素点击属性弹窗统一由地图 click 穿透检测处理（不再逐要素绑定 click）
        // 只在交互启用时绑定 tooltip
        if (this.isInteractive) {
          marker.bindTooltip(item.name || `扇区${i+1}`, { permanent: false, direction: 'top' })
        }
        marker.addTo(target!)
        renderedCount++
      } else {
        // 渲染为扇形
        // 使用数据中的波束宽度，如果没有则默认65度
        const beamwidth = item.beamwidth || 65
        const SECTOR_RADIUS = 80 // 米

        const points = createSectorPolygon(displayLat, displayLng, azimuth, beamwidth, SECTOR_RADIUS)
        const polygon = L.polygon(points, {
          ...this._mergeStyleOverrides(DEFAULT_SECTOR_STYLE, item),
          // 扇区属面状图层：尺寸设置语义为边框宽度
          ...(this.thematicSettings?.enabled && this.thematicSettings.pointSize
            ? { weight: this.thematicSettings.pointSize }
            : {}),
          renderer: this.canvasRenderer || undefined,
          // 测距模式下要素不参与鼠标命中检测，点击穿透到地图（测量加点）
          interactive: !this.measureMode,
          properties: item.properties,
          name: item.name
        })

        // 要素点击属性弹窗统一由地图 click 穿透检测处理（不再逐要素绑定 click）
        // 只在交互启用时绑定 tooltip
        if (this.isInteractive) {
          polygon.bindTooltip(item.name || `扇区${i+1}`, { permanent: false, direction: 'top' })
        }
        polygon.addTo(target!)
        renderedCount++
      }
    }

    console.log(`[GeoDataLayer] _renderSectors 完成: 总数据=${source.length}, 无坐标=${skippedNoCoords}, 过滤=${filteredCount}, 渲染=${renderedCount}`)
  }

  /**
   * 渲染多边形数据
   *
   * 坐标说明：item.path 已在后端转换为 GCJ02 坐标，格式为 [[lat, lng], ...]
   * 直接传给 L.polygon 即可，Leaflet 不会进行额外的坐标转换
   * @param useCulling 是否使用视口裁剪（默认false显示全部，地图移动后设为true）
   * @param dataSlice 可选：只渲染数据切片（分块渲染用）
   * @param destLayer 可选：渲染目标图层（分块渲染用，默认 this.leafletLayer）
   */
  private _renderPolygons(useCulling: boolean = false, dataSlice?: GeoDataItem[], destLayer?: L.LayerGroup): void {
    if (!this.leafletLayer) return

    const source = dataSlice || this.data
    const target = destLayer || this.leafletLayer

    // 🔧 视口裁剪优化：获取当前视口边界
    const bounds = this.map?.getBounds()
    const paddedBounds = bounds ? this._padBounds(bounds, 0.3) : null  // 30% 缓冲（多边形需要更大缓冲）

    console.log('[GeoDataLayer] _renderPolygons 开始，数据量:', source.length)
    console.log('[GeoDataLayer] _renderPolygons this.geometryType:', this.geometryType)
    console.log('[GeoDataLayer] _renderPolygons: useCulling=', useCulling, 'bounds=', bounds, 'paddedBounds=', paddedBounds)

    let filteredCount = 0
    let renderedCount = 0
    let skippedInvalidPath = 0

    for (let i = 0; i < source.length; i++) {
      const item = source[i]

      if (!item.path || item.path.length < 3) {
        skippedInvalidPath++
        continue
      }

      // 验证 path 格式
      const firstPoint = item.path[0]
      if (!Array.isArray(firstPoint) || firstPoint.length !== 2) {
        skippedInvalidPath++
        continue
      }

      // 🔧 视口裁剪：只在启用时过滤
      if (useCulling && paddedBounds) {
        const hasPointInViewport = item.path.some(point =>
          paddedBounds.contains([point[0], point[1]])
        )
        if (!hasPointInViewport) {
          filteredCount++
          continue
        }
      }

      try {
        // 直接使用 L.polygon，path 已经是正确的 [lat, lng] 格式（GCJ02）
        const polygon = L.polygon(item.path as L.LatLngExpression[], {
          ...this._mergeStyleOverrides(DEFAULT_POLYGON_STYLE, item),
          // 面状图层：尺寸设置语义为边框宽度
          ...(this.thematicSettings?.enabled && this.thematicSettings.pointSize
            ? { weight: this.thematicSettings.pointSize }
            : {}),
          renderer: this.canvasRenderer || undefined,
          // 测距模式下要素不参与鼠标命中检测，点击穿透到地图（测量加点）
          interactive: !this.measureMode,
          properties: item.properties,
          name: item.name
        })

        // 要素点击属性弹窗统一由地图 click 穿透检测处理（不再逐要素绑定 click）

        // 只在交互启用时绑定 tooltip
        if (this.isInteractive) {
          polygon.bindTooltip(item.name || `多边形${i+1}`, { permanent: false, direction: 'top' })
        }
        polygon.addTo(target!)
        renderedCount++
      } catch (error) {
        console.error(`[GeoDataLayer] ❌ 第 ${i} 个多边形渲染失败:`, error)
      }
    }

    console.log(`[GeoDataLayer] _renderPolygons 完成: 总数据=${source.length}, 无效路径=${skippedInvalidPath}, 过滤=${filteredCount}, 渲染=${renderedCount}`)
  }

  /**
   * 从地图移除
   */
  remove(map?: L.Map): this {
    const targetMap = map || this.map

    // 🔧 清理缩放事件监听器
    if (targetMap) {
      if (this._onZoomBound) {
        targetMap.off('zoom', this._onZoomBound)
        this._onZoomBound = null
      }
      if (this._onZoomEndBound) {
        targetMap.off('zoomend', this._onZoomEndBound)
        this._onZoomEndBound = null
      }
      if (this._onMoveBound) {
        targetMap.off('move', this._onMoveBound)
        this._onMoveBound = null
      }
    }

    // 取消待处理的缩放动画帧
    if (this._zoomAnimFrameId !== null) {
      cancelAnimationFrame(this._zoomAnimFrameId)
      this._zoomAnimFrameId = null
    }

    // 🔧 修复：取消待处理的几何图形重新渲染定时器
    // 防止图层关闭后定时器仍然触发，清空新创建的图层
    if (this._geometryRenderTimer !== null) {
      clearTimeout(this._geometryRenderTimer)
      this._geometryRenderTimer = null
      console.log('[GeoDataLayer] remove: 已取消待处理的 _geometryRenderTimer')
    }

    // 取消分块渲染（递增令牌使未完成批次失效）
    this._renderToken++
    if (this._chunkTimer !== null) {
      clearTimeout(this._chunkTimer)
      this._chunkTimer = null
    }

    // 移除共享标签引擎中的本层候选
    this.labelManager?.removeSource(this.labelSourceId)

    if (this.leafletLayer && targetMap) {
      targetMap.removeLayer(this.leafletLayer)
      this.leafletLayer = null
    }
    if (this.featureGroup && targetMap) {
      targetMap.removeLayer(this.featureGroup)
    }

    return this
  }

  /**
   * 获取可见性
   */
  isVisible(): boolean {
    return this.visible
  }

  /**
   * 获取图层名称
   */
  getName(): string {
    return this.name
  }

  /**
   * 设置可见性
   */
  setVisible(map: L.Map, visible: boolean): this {
    this.visible = visible
    if (visible) {
      try {
        this.addTo(map)
      } catch (error) {
        console.error(`[GeoDataLayer] addTo 出错:`, error)
        throw error
      }
    } else {
      this.remove(map)
    }

    return this
  }

  /**
   * 更新缩放级别（由 OnlineMap 的 zoomend handler 调用）
   *
   * 🔧 修复：L.circle / L.circleMarker 在 Leaflet 缩放动画后不会自动更新路径，
   * 导致圆形和扇区图在缩放后显示不正确。
   *
   * 注意：完整的视口裁剪重渲染由 _handleZoomEnd() 负责（直接调用，无定时器），
   * 此方法只做立即强制重绘作为补充，避免定时器竞态条件。
   */
  updateZoom(zoom: number, _map: L.Map): void {
    this.currentZoom = zoom

    if (!this.visible) return

    // 立即强制重绘所有现有图层（更新 CircleMarker 投影位置）
    this._forceRedrawLayers()
  }

  /**
   * 拖拽（纯平移）时按固定间隔节流刷新视口裁剪
   *
   * 🔧 修复：原实现只在 moveend 才刷新，拖拽过程中移入视口的要素不出现。
   * 这里在 move 事件上做固定间隔节流（throttle），拖拽过程中每 150ms 重建一次
   * 视口裁剪，保证"拖拽实时刷新可视区域"；缩放动画期间的 move 由 _handleZoom 处理。
   */
  private _handleMove(): void {
    if (!this.map || !this.visible) return

    // 固定间隔节流：避免每次 move 都全量重建（move 高频触发）
    const now = performance.now()
    if (now - this._lastMoveRenderTime < 150) return
    this._lastMoveRenderTime = now

    // 缩放动画也触发 move，几何已由 _handleZoom 实时处理，这里跳过
    if (this.map.getZoom() !== this.currentZoom) return

    // 视口裁剪重建：移入视口的要素实时出现
    this._reRenderGeometries()
  }

  /**
   * 处理缩放动画事件（zoom 事件在动画过程中持续触发）
   *
   * 参考 SectorRendererSVG._onZoom 的实现：
   * 使用 requestAnimationFrame 节流，在动画过程中实时更新几何图形，
   * 避免出现"硬拉伸/硬压缩"的视觉效果。
   */
  private _handleZoom(): void {
    if (!this.leafletLayer || !this.visible) return

    // 使用 requestAnimationFrame 节流，避免每帧都重绘
    if (this._zoomAnimFrameId !== null) return

    this._zoomAnimFrameId = requestAnimationFrame(() => {
      this._zoomAnimFrameId = null
      if (!this.leafletLayer || !this.visible) return

      // 强制重绘所有现有图层，使 Leaflet 重新计算投影坐标
      this._forceRedrawLayers()
    })
  }

  /**
   * 处理缩放结束事件（zoomend 在动画完成后触发一次）
   *
   * 缩放动画结束后，需要完整重新渲染：
   * 1. 更新当前缩放级别（影响 LOD 策略）
   * 2. 重新计算扇形半径（保持像素大小恒定）
   * 3. 应用视口裁剪（只渲染可见区域）
   *
   * 🔧 修复：直接调用 _reRenderGeometries() 而非使用定时器，
   * 避免与 updateZoom() / onMapMove() 的定时器互相取消导致重渲染丢失。
   */
  private _handleZoomEnd(): void {
    if (!this.map || !this.leafletLayer || !this.visible) return

    const newZoom = this.map.getZoom()
    this.currentZoom = newZoom

    // 取消可能还在排队的动画帧
    if (this._zoomAnimFrameId !== null) {
      cancelAnimationFrame(this._zoomAnimFrameId)
      this._zoomAnimFrameId = null
    }

    // 取消之前的定时器（避免与 updateZoom 竞争）
    if (this._geometryRenderTimer) {
      clearTimeout(this._geometryRenderTimer)
      this._geometryRenderTimer = null
    }

    // 🔧 修复：直接重新渲染，不使用延迟定时器
    // zoomend 只在动画完成后触发一次，直接执行是安全的
    this._reRenderGeometries()
  }

  /**
   * 强制重绘所有现有图层
   * 调用每个 Leaflet 图层的 redraw() 方法，使其重新计算投影坐标和路径
   */
  private _forceRedrawLayers(): void {
    if (!this.leafletLayer) return
    this.leafletLayer.eachLayer((layer: any) => {
      if (typeof layer.redraw === 'function') {
        layer.redraw()
      }
    })
  }

  /**
   * 地图移动时更新标签和几何图形
   *
   * 🔧 注意：缩放也会触发 moveend，但 updateZoom 已处理了几何图形更新，
   * 这里只处理纯平移（zoom 未变化）的情况。
   */
  onMapMove(): void {
    if (!this.map || !this.visible) return

    // 检测是否伴随缩放变化
    const newZoom = this.map.getZoom()
    const zoomChanged = this.currentZoom !== newZoom
    if (zoomChanged) {
      this.currentZoom = newZoom
    }

    // 标签由共享 LabelLayoutManager 监听地图事件自行处理视口/缩放，无需在此更新

    // 纯平移时直接重新渲染几何图形（视口裁剪需要更新）
    // 说明：move 已由 _handleMove 节流实时刷新，此处为 moveend 兜底；
    // 缩放场景由 _handleZoomEnd 全量重渲染，此处按 zoomChanged 跳过避免重复全量重建
    if (!zoomChanged) {
      if (this._geometryRenderTimer) {
        clearTimeout(this._geometryRenderTimer)
      }
      // 使用短延迟合并连续 move 事件，但不再与 zoom 处理共享定时器变量
      this._geometryRenderTimer = window.setTimeout(() => {
        this._reRenderGeometries()
        this._geometryRenderTimer = null
      }, 150) as unknown as number
    }
  }

  /**
   * 设置标签可见性
   */
  setLabelVisibility(visible: boolean): this {
    console.log(`[GeoDataLayer] ========== setLabelVisibility ==========`)
    console.log(`[GeoDataLayer] id: ${this.id}`)
    console.log(`[GeoDataLayer] visible: ${this.labelsEnabled} -> ${visible}`)
    console.log(`[GeoDataLayer] hasMap: ${!!this.map}`)
    console.log(`[GeoDataLayer] layerVisible: ${this.visible}`)

    this.labelsEnabled = visible

    if (!this.map) {
      console.log(`[GeoDataLayer] ❌ map 为空，无法设置标签可见性`)
      return this
    }

    if (visible) {
      console.log(`[GeoDataLayer] 注册标签候选到共享布局引擎`)
      this._createLabels(this.map)
    } else {
      // 从共享标签引擎移除本层候选
      this.labelManager?.removeSource(this.labelSourceId)
    }

    console.log(`[GeoDataLayer] ========== setLabelVisibility 完成 ==========`)
    return this
  }

  /**
   * 设置标签配置
   */
  setLabelConfig(config: {
    content: string
    color: string
    fontSize: number
    fontFamily?: string
    bold?: boolean
    italic?: boolean
    shadow?: boolean
    background?: 'none' | 'halo' | 'box'
    backgroundColor?: string
  }): this {
    console.log(`[GeoDataLayer] setLabelConfig 被调用:`, {
      id: this.id,
      oldConfig: this.labelConfig,
      newConfig: config
    })

    // 更新配置
    this.labelConfig = {
      content: config.content || 'name',
      color: config.color || '#000000',
      fontSize: config.fontSize || 12,
      fontFamily: config.fontFamily,
      bold: config.bold,
      italic: config.italic,
      shadow: config.shadow,
      background: config.background,
      backgroundColor: config.backgroundColor
    }

    // 如果标签已启用，重新同步标签候选以应用新配置
    if (this.labelsEnabled && this.map) {
      console.log(`[GeoDataLayer] 标签已启用，重新同步标签候选以应用新配置`)
      this._createLabels(this.map)
    }

    return this
  }

  /**
   * 同步标签候选到共享标签布局引擎
   *
   * 所有元素的标签候选（地理坐标 + 文本 + 样式）注册到 LabelLayoutManager，
   * 由引擎按屏幕空间统一做矩形碰撞检测与避让，跨图层全局不重叠；
   * 视口裁剪、地图移动/缩放后的显隐均由引擎处理。
   */
  private _createLabels(_map: L.Map): void {
    if (!this.labelManager) return

    // 标签开关关闭或图层不可见：清空本层候选
    if (!this.labelsEnabled || !this.visible) {
      this.labelManager.removeSource(this.labelSourceId)
      return
    }

    const candidates: LabelCandidate[] = []
    let skippedNoPosition = 0
    let skippedNoContent = 0

    for (let i = 0; i < this.data.length; i++) {
      const item = this.data[i]

      const latLng = this._getLatLng(item)
      if (!latLng) {
        skippedNoPosition++
        continue
      }

      const content = this._getLabelContent(item)
      if (!content) {
        skippedNoContent++
        continue
      }

      candidates.push({
        id: String(i),
        lat: latLng.lat,
        lng: latLng.lng,
        text: content,
        fontSize: this.labelConfig.fontSize,
        fontFamily: this.labelConfig.fontFamily,
        bold: this.labelConfig.bold,
        italic: this.labelConfig.italic,
        shadow: this.labelConfig.shadow,
        background: this.labelConfig.background,
        backgroundColor: this.labelConfig.backgroundColor,
        color: this.labelConfig.color
      })
    }

    console.log(`[GeoDataLayer] 标签候选注册: ${candidates.length}/${this.data.length}（无位置 ${skippedNoPosition}，无内容 ${skippedNoContent}）`)
    this.labelManager.setCandidates(this.labelSourceId, candidates)
  }

  /**
   * 获取标签内容
   */
  private _getLabelContent(dataItem: GeoDataItem): string {
    if (!dataItem) return ''

    // 根据 labelConfig.content 获取字段值
    const field = this.labelConfig.content

    // 如果是 'name' 或默认，使用 item.name
    if (field === 'name') {
      return dataItem.name || ''
    }

    // 从 properties 中获取字段值（根级：OnlineMap 将整条 item 存入 properties，所以此处查 item 根字段）
    if (dataItem.properties && dataItem.properties[field] !== undefined && dataItem.properties[field] !== null) {
      return String(dataItem.properties[field])
    }

    // 从嵌套 properties 中获取字段值（geo_data_service 将原始列全部存入 item.properties[key]）
    if (dataItem.properties && dataItem.properties.properties &&
        dataItem.properties.properties[field] !== undefined && dataItem.properties.properties[field] !== null) {
      return String(dataItem.properties.properties[field])
    }

    // 严格按用户选择的标签字段显示：所选字段缺失时不回退到 name/默认标签，
    // 直接返回空串（该要素不在地图显示标签）
    return ''
  }

  /**
   * 获取图层ID
   */
  getId(): string {
    return this.id
  }

  /**
   * 获取几何类型
   */
  getGeometryType(): GeoDataGeometryType {
    return this.geometryType
  }

  /**
   * 设置是否允许交互
   * @param interactive 是否允许交互
   */
  setInteractive(interactive: boolean): void {
    this.isInteractive = interactive
    // 更新所有 Leaflet 图层的交互状态
    if (this.leafletLayer) {
      this.leafletLayer.eachLayer((layer: any) => {
        // 禁用/启用交互
        if (interactive) {
          // 恢复交互：重新绑定事件（通过重新渲染实现）
          if (this.map) {
            this._reRenderGeometries()
          }
        } else {
          // 禁用交互：关闭 tooltip 并移除事件绑定
          if (layer.closeTooltip) {
            layer.closeTooltip()
          }
          if (layer.unbindTooltip) {
            layer.unbindTooltip()
          }
          // 禁用 Leaflet 图层的鼠标事件
          if (layer.off) {
            layer.off('click mouseover mouseout mouseenter mouseleave')
          }
        }
      })
    }
  }

  /**
   * 设置测距模式
   * 测距时所有要素不参与 Canvas 命中检测（options.interactive=false）：
   * 面状要素的 click stopPropagation 不再吞掉地图 click（测量无法加点），悬停 tooltip 也不弹出。
   * Canvas 渲染器在命中检测时实时读取 options.interactive，无需重绘；
   * 测距期间新渲染的要素在创建时按此标志设置 interactive。
   * @param enabled 是否启用测距模式
   */
  setMeasureMode(enabled: boolean): void {
    this.measureMode = enabled
    if (this.leafletLayer) {
      this.leafletLayer.eachLayer((layer: any) => {
        if (layer.options) {
          layer.options.interactive = !enabled
        }
        if (enabled && layer.closeTooltip) {
          layer.closeTooltip()
        }
      })
    }
  }

  /**
   * 把 canvas 渲染层移到 pane 顶部，使其成为点击命中目标。
   * 对 Canvas，路径 bringToFront 只重绘不移动 DOM，必须直接操作 canvas 元素。
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
   * @param ids 选中的要素ID集合，null表示清除
   */
  setSelectionHighlight(ids: Set<string> | null): void {
    this.selectionHighlightIds = ids
    if (!this.leafletLayer) return

    this.leafletLayer.eachLayer((layer: any) => {
      // 获取要素的ID（从options或feature中）
      const featureId = layer.options?.name || layer.options?.properties?.name || layer.options?.properties?.id || ''
      const isSelected = ids?.has(String(featureId))

      if (layer instanceof L.CircleMarker || layer instanceof L.Polygon) {
        if (isSelected) {
          // 保存原始样式（如果还没保存）
          if (!this.originalStyles.has(layer)) {
            this.originalStyles.set(layer, {
              color: layer.options.color,
              weight: layer.options.weight,
              fillColor: layer.options.fillColor,
              fillOpacity: layer.options.fillOpacity,
              // 记录描边开关：无色边框要素为 stroke:false，恢复时需还原
              stroke: layer.options.stroke !== false
            })
          }
          // 应用高亮样式：红色边框（stroke:false 要素临时恢复描边，否则高亮不可见）
          layer.setStyle({
            stroke: true,
            color: '#ef4444',
            weight: 3,
            fillColor: layer.options.fillColor, // 保持原填充色
            fillOpacity: layer.options.fillOpacity
          })
          if (layer.bringToFront) layer.bringToFront()
        } else {
          // 恢复原始样式
          const originalStyle = this.originalStyles.get(layer)
          if (originalStyle) {
            layer.setStyle(originalStyle)
            this.originalStyles.delete(layer)
          }
          // 无保存的原始样式说明该要素从未被高亮过，其样式本就是渲染时的正确状态
          // （点半径为按缩放动态计算的像素半径、配色含专题/用户覆盖）。
          // 不再 setStyle(_getDefaultStyle())：那会把半径强制改为固定 10px、
          // 并把配色改回基础色，导致圈选时未选中的点突然变大且专题配色丢失。
        }
      } else if (layer instanceof L.Marker) {
        // Marker（点要素）高亮：修改DOM元素添加高亮边框
        const markerEl = layer.getElement()
        if (markerEl) {
          if (isSelected) {
            this._originalMarkerStyles.set(layer, markerEl.style.outline || '')
            markerEl.style.outline = '2px solid #ef4444'
            markerEl.style.outlineOffset = '2px'
            markerEl.style.borderRadius = '2px'
          } else {
            const origOutline = this._originalMarkerStyles.get(layer)
            markerEl.style.outline = origOutline || ''
            markerEl.style.outlineOffset = ''
            markerEl.style.borderRadius = ''
            this._originalMarkerStyles.delete(layer)
          }
        }
      }
    })
  }

  /**
   * 计算要素的专题样式（按字段值匹配区间/文本配色）
   * - fillColor: 专题填充配色
   * - borderColor: 专题边框色（用户配置；'none'=无色不描边；undefined=未配置，边框用专题色）
   * - fillOpacity: 专题图形透明度（缺省不覆盖，回退基础配置/默认样式）
   * @returns 或 null（未启用专题）
   */
  private _thematicStyleFor(item: GeoDataItem): { fillColor: string; borderColor?: string; fillOpacity?: number } | null {
    const ts = this.thematicSettings
    if (!ts || !ts.enabled || !ts.field) return null
    const color = matchThematicColor(ts, getFieldValue(item.properties, ts.field))
    return {
      fillColor: color,
      borderColor: ts.borderColor,
      ...(typeof ts.fillOpacity === 'number' ? { fillOpacity: ts.fillOpacity } : {})
    }
  }

  /**
   * 将颜色覆盖合并到基础样式（专题启用时优先于基础覆盖）
   * 映射：fillColor→fillColor，fillOpacity→fillOpacity，borderColor→color，borderWidth→weight
   * 填充色为无色哨兵（NO_FILL_COLOR）时转为 fill:false（镂空，仅显示边框）；
   * 边框色为无色哨兵时转为 stroke:false（不描边）。
   */
  private _mergeStyleOverrides(baseStyle: any, item?: GeoDataItem): any {
    let style = baseStyle
    if (this.styleOverrides) {
      style = {
        ...baseStyle,
        fillColor: this.styleOverrides.fillColor,
        fillOpacity: this.styleOverrides.fillOpacity,
        color: this.styleOverrides.borderColor,
        weight: this.styleOverrides.borderWidth,
        opacity: 1
      }
    }
    if (item && this.thematicSettings?.enabled) {
      const t = this._thematicStyleFor(item)
      if (t) {
        style = {
          ...style,
          fillColor: t.fillColor,
          // 边框色：专题显式配置优先（'none'=无色 → 不描边）；未配置时专题填充色即
          // 边框色，填充无色（镂空）则保留基础/默认边框色
          ...(t.borderColor
            ? (t.borderColor === NO_FILL_COLOR ? { stroke: false } : { color: t.borderColor })
            : (t.fillColor !== NO_FILL_COLOR ? { color: t.fillColor } : {})),
          ...(typeof t.fillOpacity === 'number' ? { fillOpacity: t.fillOpacity } : {})
        }
      }
    }
    // 无色（镂空）：面/点不填充，仅描边
    if (style.fillColor === NO_FILL_COLOR) {
      style = { ...style, fill: false }
    }
    // 边框无色：不描边（stroke:false），color 置基础色占位避免非法颜色
    if (style.color === NO_FILL_COLOR) {
      style = { ...style, stroke: false, color: baseStyle.color }
    }
    return style
  }

  /**
   * 设置图层颜色覆盖（图形颜色 / 透明度 / 边框宽度 / 边框颜色）
   * 立即应用到已渲染的几何，后续重渲染也会沿用覆盖。
   *
   * 采用「全量重渲染」而非逐要素 setStyle：
   * - 所有渲染函数在创建几何时都会调 _mergeStyleOverrides 读取 styleOverrides，
   *   因此重建图层必然带上新颜色，避免不同要素类型（circleMarker/polygon）与
   *   Canvas 渲染器在 setStyle 重绘上的细微差异导致不生效。
   */
  setStyleOverrides(settings: { fillColor: string; fillOpacity: number; borderWidth: number; borderColor: string; pointSize?: number }): void {
    this.styleOverrides = settings

    // 未渲染/不可见时仅保存覆盖，几何由后续 addTo/_reRenderGeometries 统一按新覆盖渲染
    if (!this.map || !this.leafletLayer || !this.visible) return

    this._reRenderGeometries()
  }

  /**
   * 设置专题图层覆盖（与基础配置相互独立：专题启用时优先渲染；null 关闭专题后由渲染层回退到基础配置色）
   */
  setThematicOverrides(settings: ThematicSettings | null): void {
    this.thematicSettings = settings
    // 关闭专题时不清除基础配置：基础配置与专题图层相互独立，
    // 专题关闭时由 _mergeStyleOverrides 自然回退到基础配置色（无基础配置则用导入默认色）。
    this.computeThematicStats()

    // 未渲染/不可见时仅保存覆盖，几何由后续 addTo/_reRenderGeometries 统一按新覆盖渲染
    if (!this.map || !this.leafletLayer || !this.visible) return

    this._reRenderGeometries()
  }

  /**
   * 计算专题图例统计（各配色模式的要素数与总数，供图例展示）
   * - 区间配色：counts[每区间] + other（未匹配）
   * - 属性值配色：counts[每个值] + other（未配置值）
   * - 文本配色：counts[每个类别，含 __other__] + other（无兜底时的未列出值）
   */
  private computeThematicStats(): void {
    const ts = this.thematicSettings
    if (!ts?.enabled || !this.data || this.data.length === 0) {
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
    if (isRange) {
      for (const item of this.data) {
        total++
        const idx = matchRangeIndex(ts, getFieldValue(item.properties, ts.field))
        if (idx >= 0) counts[idx]++; else other++
      }
    } else if (isValue) {
      const valueIndex = new Map(ts.valueColors!.map((c, i) => [c.value, i]))
      for (const item of this.data) {
        total++
        const raw = getFieldValue(item.properties, ts.field)
        if (!hasValue(raw)) { other++; continue }
        const idx = valueIndex.get(String(raw))
        if (idx !== undefined) counts[idx]++; else other++
      }
    } else {
      const otherIdx = ts.categories.findIndex(c => c.value === '__other__')
      const categoryIndex = new Map(ts.categories.map((c, i) => [c.value, i]))
      for (const item of this.data) {
        total++
        const raw = getFieldValue(item.properties, ts.field)
        if (!hasValue(raw)) { if (otherIdx >= 0) counts[otherIdx]++; else other++; continue }
        const idx = categoryIndex.get(String(raw))
        if (idx !== undefined) counts[idx]++
        else if (otherIdx >= 0) counts[otherIdx]++
        else other++
      }
    }
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
   * 注意：视口裁剪下已渲染几何可能为空，必须从数据源计算
   * @returns LatLngBounds；无要素返回 null
   */
  getFeaturesBounds(): L.LatLngBounds | null {
    if (!this.data || this.data.length === 0) return null
    const bounds = L.latLngBounds([])
    let has = false
    for (const item of this.data) {
      try {
        // 无效坐标（工参/撒点解析失败默认 (0,0)、越界值）不并入包围盒：
        // 否则双击"显示全部"会被拉到印度洋（视野覆盖非洲-印度洋-亚洲）
        const isValid = (lat: number | undefined, lng: number | undefined): boolean =>
          typeof lat === 'number' && typeof lng === 'number'
          && !(lat === 0 && lng === 0)
          && Math.abs(lng) <= 180 && Math.abs(lat) <= 90
        if (Array.isArray(item.path) && item.path.length > 0) {
          for (const p of item.path) {
            const plat: number | undefined = p[0]
            const plng: number | undefined = p[1]
            if (!isValid(plat, plng)) continue
            bounds.extend([plat as number, plng as number])
            has = true
          }
        } else {
          const lat = item.displayLat ?? item.latitude
          const lng = item.displayLng ?? item.longitude
          if (isValid(lat, lng)) {
            bounds.extend([lat as number, lng as number])
            has = true
          }
        }
      } catch { /* 忽略单要素异常 */ }
    }
    return has ? bounds : null
  }

  /**
   * 收集热力图点（渲染坐标 GCJ02 + 字段权重）：
   * - 点/扇区：displayLat/displayLng 优先，否则现场纠偏
   * - 多边形：外环顶点质心
   * - 权重字段非数值的要素跳过
   */
  getHeatPoints(field: string): HeatPoint[] {
    if (!this.data || this.data.length === 0 || !field) return []
    const points: HeatPoint[] = []
    for (const item of this.data) {
      const weight = toNumber(getFieldValue(item.properties, field))
      if (weight === null) continue

      let lat: number | undefined
      let lng: number | undefined
      if (Array.isArray(item.path) && item.path.length > 0) {
        const c = centroidFromLatLngRing(item.path)
        lat = c?.lat
        lng = c?.lng
      } else if (item.latitude !== undefined && item.longitude !== undefined) {
        if (item.displayLat !== undefined && item.displayLng !== undefined) {
          lat = item.displayLat
          lng = item.displayLng
        } else {
          [lat, lng] = CoordinateTransformer.wgs84ToGcj02(item.latitude, item.longitude)
        }
      }
      if (typeof lat !== 'number' || typeof lng !== 'number') continue
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
      points.push({ lat, lng, weight })
    }
    return points
  }

  /**
   * 射线法判断点是否在多边形内（替代 Leaflet L.Polygon.contains，该方法在 Leaflet 1.x 中不存在）
   */
  private static _isPointInPolygon(point: number[], polygon: number[][]): boolean {
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1]
      const xj = polygon[j][0], yj = polygon[j][1]
      const intersect = ((yi > point[1]) !== (yj > point[1]))
        && (point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi)
      if (intersect) inside = !inside
    }
    return inside
  }

  /**
   * 获取多边形内的要素（用于框选）
   *
   * 🔧 遍历完整数据集（this.data）而非仅已渲染的 leafletLayer。
   * 原先只遍历 leafletLayer，而 GeoDataLayer 在地图平移/缩放时会做视口裁剪
   * （_reRenderGeometries 仅保留视口内要素），导致位于视口外的要素被物理移除，
   * 框选（多边形/矩形）无法命中它们——表现为只有扇区图层可圈选、点/面图层无效。
   * 改为直接使用原始坐标遍历全量数据，与 SectorRendererSVG.getSectorsInPolygon 保持一致。
   *
   * @param polygon Leaflet多边形对象（坐标为渲染坐标/GCJ02）
   */
  /**
   * 圈选附带几何（GCJ02）：点用 display 坐标；面/线用 path（[lat,lng] → [lng,lat]）。
   * 供跨图层复制粘贴使用。
   */
  private buildItemGeometry(item: GeoDataItem): { type: string; coordinates: any } | undefined {
    if (item.path && item.path.length >= 2) {
      const coords = item.path.map(pt => [pt[1], pt[0]] as [number, number])
      if (this.geometryType === 'polygon' && item.path.length >= 3) {
        const ring = [...coords]
        const a = ring[0]
        const b = ring[ring.length - 1]
        if (a[0] !== b[0] || a[1] !== b[1]) ring.push(a)
        return { type: 'Polygon', coordinates: [ring] }
      }
      return { type: 'LineString', coordinates: coords }
    }
    const lat = item.displayLat ?? item.latitude
    const lng = item.displayLng ?? item.longitude
    if (lat !== undefined && lng !== undefined) {
      return { type: 'Point', coordinates: [lng, lat] }
    }
    return undefined
  }

  getFeaturesInPolygon(polygon: L.Polygon, byAnchor: boolean = false): GeoDataItem[] {
    const results: GeoDataItem[] = []
    if (!this.data || this.data.length === 0) return results

    const bounds = polygon.getBounds()
    // 将多边形顶点转为 [lat, lng] 二维数组用于射线法判断
    const polygonPoints: number[][] = (polygon.getLatLngs()[0] as L.LatLng[]).map(p => [p.lat, p.lng])

    for (const item of this.data) {
      // 边界选择锚点口径：仅要素归属经纬度（点=自身；线/面=包围盒中心）落入才选中，
      // 保证相邻边界选择时同一要素不会被重复选中。点/线/面统一经 geometryAnchor 判定。
      if (byAnchor) {
        const anchor = geometryAnchor(this.buildItemGeometry(item))
        if (anchor
          && bounds.contains([anchor.lat, anchor.lng])
          && GeoDataLayer._isPointInPolygon([anchor.lat, anchor.lng], polygonPoints)) {
          results.push({ name: item.name, properties: item.properties, geometry: this.buildItemGeometry(item) })
        }
        continue
      }

      // 面状要素：以其任一顶点是否落在框选范围内判定（覆盖整片区域被框住的情况）
      if (this.geometryType === 'polygon' && item.path && item.path.length > 0) {
        const inside = item.path.some(pt =>
          bounds.contains([pt[ 0], pt[1]]) &&
          GeoDataLayer._isPointInPolygon([pt[0], pt[1]], polygonPoints)
        )
        if (inside) {
          results.push({ name: item.name, properties: item.properties, geometry: this.buildItemGeometry(item) })
        }
        continue
      }

      if (item.longitude === undefined || item.latitude === undefined) continue

      // 与渲染逻辑保持一致：优先 display 坐标，否则由 GCJ02 转换
      const [dLat, dLng] = (item.displayLat !== undefined && item.displayLng !== undefined)
        ? [item.displayLat, item.displayLng]
        : CoordinateTransformer.wgs84ToGcj02(item.latitude, item.longitude)

      if (
        bounds.contains([dLat, dLng]) &&
        GeoDataLayer._isPointInPolygon([dLat, dLng], polygonPoints)
      ) {
        results.push({ name: item.name, properties: item.properties, geometry: this.buildItemGeometry(item) })
      }
    }

    return results
  }

  /**
   * 获取圆圈内的要素（用于框选）
   * @param center 中心点
   * @param radius 半径（米）
   */
  getFeaturesInCircle(center: L.LatLng, radius: number): GeoDataItem[] {
    if (!this.leafletLayer) return []
    const results: GeoDataItem[] = []

    this.leafletLayer.eachLayer((layer: any) => {
      let isInside = false

      if (layer.getLatLng) {
        // 点要素（CircleMarker）
        const layerLatLng = layer.getLatLng()
        const distance = center.distanceTo(layerLatLng)
        isInside = distance <= radius
      } else if (layer.getBounds) {
        // 线/面要素：检查中心点
        const layerBounds = layer.getBounds()
        const layerCenter = layerBounds.getCenter()
        const distance = center.distanceTo(layerCenter)
        isInside = distance <= radius
      }

      if (isInside && layer.options?.properties) {
        const srcItem = this.data.find(d => d.properties === layer.options.properties)
        results.push({
          name: layer.options.name || layer.options.properties?.name,
          properties: layer.options.properties,
          geometry: srcItem ? this.buildItemGeometry(srcItem) : undefined,
        })
      }
    })

    return results
  }

  /** 获取底层 Leaflet 图层（只读遍历用，如编辑态自动捕获节点收集可见图层顶点） */
  getLeafletLayer(): L.LayerGroup | null {
    return this.leafletLayer
  }

  /**
   * 获取点击位置精确命中的要素（用于「点击查属性」）
   *
   * 与 getFeaturesInCircle（包围盒/中心粗检，供圈选/点选工具使用）不同：
   * 面要素按点击点是否落在封闭区域内判定，仅包围盒/边框相交不算命中，
   * 避免点击面内部时因其他要素包围盒压到点击点而误弹重叠列表；
   * 点要素按像素距离、线要素按到折线段的像素距离判定。
   * 命中附带 hitType（direct/border）供调用方做穿透收敛。
   *
   * @param latlng 点击位置（渲染坐标/GCJ02）
   * @param tolerancePx 像素容差
   */
  getFeaturesAtPoint(
    latlng: L.LatLng,
    tolerancePx: number = CLICK_HIT_TOLERANCE_PX
  ): Array<GeoDataItem & { hitType: FeatureHitType; distancePx: number }> {
    if (!this.leafletLayer || !this.map) return []
    const results: Array<GeoDataItem & { hitType: FeatureHitType; distancePx: number }> = []

    this.leafletLayer.eachLayer((layer: any) => {
      if (!layer.options?.properties) return
      const hit = layerHitAt(this.map!, layer, latlng, tolerancePx)
      if (hit) {
        results.push({
          name: layer.options.name || layer.options.properties?.name,
          properties: layer.options.properties,
          geometry: layerGeometry(layer) ?? undefined,
          hitType: hit.type,
          distancePx: hit.distancePx,
        })
      }
    })

    return results
  }

  /**
  /**
   * 获取元素的 LatLng 位置
   */
  private _getLatLng(item: GeoDataItem): L.LatLng | null {
    if (this.geometryType === 'polygon' && item.path) {
      // 多边形：计算中心点
      if (item.path.length > 0) {
        const sumLat = item.path.reduce((sum, p) => sum + p[0], 0)
        const sumLng = item.path.reduce((sum, p) => sum + p[1], 0)
        return L.latLng([sumLat / item.path.length, sumLng / item.path.length])
      }
    } else if (item.displayLat !== undefined && item.displayLng !== undefined) {
      // 点/扇区：使用已转换的坐标
      return L.latLng([item.displayLat, item.displayLng])
    } else if (item.latitude !== undefined && item.longitude !== undefined) {
      // 点/扇区：使用原始坐标并转换
      const [gcjLat, gcjLng] = CoordinateTransformer.wgs84ToGcj02(item.latitude, item.longitude)
      return L.latLng([gcjLat, gcjLng])
    }

    return null
  }

  /**
   * 将米转换为像素半径（基于 Web Mercator 投影）
   * @param meters 米数
   * @param lat 纬度（影响墨卡托变形）
   * @param zoom 缩放级别
   */
  private _metersToPixels(meters: number, lat: number, zoom: number): number {
    const metersPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom)
    return Math.max(3, Math.round(meters / metersPerPixel))
  }

  /**
   * 扩展边界（添加缓冲区）
   */
  private _padBounds(bounds: L.LatLngBounds, bufferRatio: number): L.LatLngBounds {
    const latBuffer = (bounds.getNorth() - bounds.getSouth()) * bufferRatio
    const lngBuffer = (bounds.getEast() - bounds.getWest()) * bufferRatio
    return L.latLngBounds(
      [bounds.getSouth() - latBuffer, bounds.getWest() - lngBuffer],
      [bounds.getNorth() + latBuffer, bounds.getEast() + lngBuffer]
    )
  }

  /**
   * 重新渲染几何图形（延迟更新模式）
   * 清除现有几何图形并根据当前视口重新渲染
   * 地图移动后调用，使用视口裁剪只显示当前视口元素
   */
  private _reRenderGeometries(): void {
    if (!this.map || !this.leafletLayer || !this.visible) return

    console.log('[GeoDataLayer] _reRenderGeometries: 重新渲染几何图形（启用视口裁剪）')

    // 取消分块渲染（移动/缩放过时，改由本方法同步渲染当前视口）
    this._renderToken++
    if (this._chunkTimer !== null) {
      clearTimeout(this._chunkTimer)
      this._chunkTimer = null
    }

    // 清空现有图层
    this.leafletLayer.clearLayers()

    // 根据几何类型重新渲染，启用视口裁剪
    switch (this.geometryType) {
      case 'point':
        this._renderPoints(true)  // 启用视口裁剪
        break
      case 'sector':
        this._renderSectors(true)  // 启用视口裁剪
        break
      case 'polygon':
        this._renderPolygons(true)  // 启用视口裁剪
        break
    }

    console.log(`[GeoDataLayer] _reRenderGeometries 完成，当前视口内有 ${this.leafletLayer.getLayers().length} 个几何图形`)

    // 重新渲染后，如果存在未清除的选中状态，重新应用高亮
    // 这样拖拽、缩放、移动地图后选中高亮不会消失
    if (this.selectionHighlightIds) {
      this.setSelectionHighlight(this.selectionHighlightIds)
    }
  }
}

/**
 * GeoDataLayer 管理器 - 管理多个地理化数据图层
 */
export class GeoDataLayerManager {
  private layers: Map<string, GeoDataLayer> = new Map()
  private map: L.Map | null = null
  /** 共享标签布局引擎（所有图层的标签统一防重叠） */
  private labelManager: LabelLayoutManager | null = null
  /** 测距模式标志：新增图层时自动应用（测距中加载的图层也要穿透） */
  private measureMode: boolean = false

  /**
   * 初始化管理器
   */
  init(map: L.Map, labelManager?: LabelLayoutManager | null): void {
    this.map = map
    if (labelManager !== undefined) this.labelManager = labelManager
  }

  /**
   * 设置所有图层的测距模式
   * 测距时要素不参与鼠标命中检测，点击/悬停穿透到地图（测量加点不被面状要素拦截）
   * @param enabled 是否启用测距模式
   */
  setMeasureMode(enabled: boolean): void {
    this.measureMode = enabled
    this.layers.forEach(layer => {
      layer.setMeasureMode(enabled)
    })
  }

  /**
   * 添加图层
   */
  addLayer(options: GeoDataLayerOptions): GeoDataLayer {
    console.log('[GeoDataLayerManager] ========== addLayer 被调用 ==========')
    console.log('[GeoDataLayerManager] id:', options.id)
    console.log('[GeoDataLayerManager] name:', options.name)
    console.log('[GeoDataLayerManager] geometryType:', options.geometryType)
    console.log('[GeoDataLayerManager] visible:', options.visible)
    console.log('[GeoDataLayerManager] data.length:', options.data.length)
    console.log('[GeoDataLayerManager] map 已初始化:', !!this.map)

    // 若已存在同 id 图层，先移除旧实例（避免切换/重复加载导致地图叠加）
    const existing = this.layers.get(options.id)
    if (existing && this.map) {
      console.log('[GeoDataLayerManager] 存在同 id 旧图层，先移除:', options.id)
      existing.remove(this.map)
    }

    // 注入共享标签布局引擎（标签统一防重叠）
    const layer = new GeoDataLayer(this.labelManager
      ? { ...options, labelManager: this.labelManager }
      : options)
    // 测距中加载的新图层自动继承测距模式（要素点击穿透到地图）
    if (this.measureMode) {
      layer.setMeasureMode(true)
    }
    this.layers.set(options.id, layer)
    console.log('[GeoDataLayerManager] GeoDataLayer 已创建并存储')

    // 🔧 修复：总是调用 addTo(map)，即使 visible=false
    // 这样可以确保 featureGroup 被添加到地图，标签功能才能正常工作
    // GeoDataLayer.addTo() 内部会根据 visible 决定是否渲染几何图形
    if (this.map) {
      console.log('[GeoDataLayerManager] 调用 layer.addTo(map) (visible=' + options.visible + ')')
      layer.addTo(this.map)
      console.log('[GeoDataLayerManager] layer.addTo() 完成')
    } else {
      console.log('[GeoDataLayerManager] ⚠️ 未调用 addTo: map未初始化')
    }

    console.log('[GeoDataLayerManager] ========== addLayer 完成 ==========')
    return layer
  }

  /**
   * 移除图层
   */
  removeLayer(layerId: string): void {
    const layer = this.layers.get(layerId)
    if (layer && this.map) {
      layer.remove(this.map)
    }
    this.layers.delete(layerId)
  }

  /**
   * 遍历所有已注册图层
   */
  forEachLayer(cb: (layer: GeoDataLayer, id: string) => void): void {
    this.layers.forEach((layer, id) => cb(layer, id))
  }

  /**
   * 获取图层
   */
  getLayer(layerId: string): GeoDataLayer | undefined {
    console.log(`[GeoDataLayerManager] getLayer(${layerId}) 被调用`)
    console.log(`[GeoDataLayerManager] 当前存储的图层ID:`, Array.from(this.layers.keys()))
    const layer = this.layers.get(layerId)
    console.log(`[GeoDataLayerManager] 查询结果:`, !!layer)
    return layer
  }

  /**
   * 设置图层可见性
   */
  setLayerVisibility(layerId: string, visible: boolean): void {
    const layer = this.layers.get(layerId)
    if (layer && this.map) {
      layer.setVisible(this.map, visible)
    }
  }

  /**
   * 更新缩放级别
   */
  updateZoom(zoom: number): void {
    if (!this.map) return

    this.layers.forEach(layer => {
      layer.updateZoom(zoom, this.map!)
    })
  }

  /**
   * 地图移动时更新标签
   */
  onMapMove(): void {
    console.log(`[GeoDataLayerManager] onMapMove 被调用，更新 ${this.layers.size} 个图层的标签`)

    this.layers.forEach(layer => {
      layer.onMapMove()
    })
  }

  /**
   * 获取所有图层
   */
  getAllLayers(): GeoDataLayer[] {
    return Array.from(this.layers.values())
  }

  /**
   * 清空所有图层
   */
  clear(): void {
    if (this.map) {
      this.layers.forEach(layer => {
        layer.remove(this.map!)
      })
    }
    this.layers.clear()
  }

  /**
   * 设置所有图层的交互状态
   * @param interactive 是否允许交互
   */
  setInteractive(interactive: boolean): void {
    console.log(`[GeoDataLayerManager] setInteractive: ${interactive}`)
    this.layers.forEach(layer => {
      layer.setInteractive(interactive)
    })
  }
}
