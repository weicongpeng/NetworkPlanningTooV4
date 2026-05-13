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
import { GeoDataCanvasLabelLayer, CanvasLabelData } from './GeoDataCanvasLabelLayer'

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
}

export interface GeoDataLayerOptions {
  id: string
  name: string
  geometryType: GeoDataGeometryType
  data: GeoDataItem[]
  visible?: boolean
  onFeatureClick?: (properties: Record<string, any>, event: L.LeafletMouseEvent, name?: string) => void
  /** 缩放级别（用于LOD策略） */
  zoom?: number
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
  fillOpacity: 0.6
}

const DEFAULT_POLYGON_STYLE = {
  fillColor: '#ffffff',
  color: '#000000',
  weight: 2,
  opacity: 1,
  fillOpacity: 0.5
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
  private onFeatureClick?: (properties: Record<string, any>, event: L.LeafletMouseEvent, name?: string) => void
  private labelsEnabled: boolean = false
  private visible: boolean = false
  private map: L.Map | null = null

  // Canvas 标签层（替代 DOM 标签）
  private canvasLabelLayer: GeoDataCanvasLabelLayer | null = null

  // 标签配置
  private labelConfig: {
    content: string
    color: string
    fontSize: number
  } = {
    content: 'name',
    color: '#000000',
    fontSize: 12
  }

  // 地图移动节流定时器
  private _mapMoveTimer: number | null = null
  // 几何图形重新渲染定时器
  private _geometryRenderTimer: number | null = null
  // 缩放事件处理函数引用（用于取消注册）
  private _onZoomBound: (() => void) | null = null
  private _onZoomEndBound: (() => void) | null = null
  // 缩放动画帧 ID
  private _zoomAnimFrameId: number | null = null
  // 交互状态标志
  private isInteractive: boolean = true
  // 框选高亮状态
  private selectionHighlightIds: Set<string> | null = null
  // 存储原始样式以便恢复
  private originalStyles: Map<L.Layer, any> = new Map()

  constructor(options: GeoDataLayerOptions) {
    this.id = options.id
    this.name = options.name
    this.geometryType = options.geometryType
    this.data = options.data
    this.onFeatureClick = options.onFeatureClick
    this.currentZoom = options.zoom || 12
    this.visible = options.visible ?? false

    // 创建聚合图层
    this.featureGroup = L.featureGroup()
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

    switch (this.geometryType) {
      case 'point':
        console.log('[GeoDataLayer] 调用 _renderPoints(false)')
        this._renderPoints(false)  // 初始渲染不使用裁剪
        break
      case 'sector':
        console.log('[GeoDataLayer] 调用 _renderSectors(false)')
        this._renderSectors(false)  // 初始渲染不使用裁剪
        break
      case 'polygon':
        console.log('[GeoDataLayer] 调用 _renderPolygons(false)')
        this._renderPolygons(false)  // 初始渲染不使用裁剪
        break
      default:
        console.warn('[GeoDataLayer] ❌ 未知的 geometryType:', this.geometryType)
    }

    console.log('[GeoDataLayer] 将 leafletLayer 添加到地图，已渲染', this.leafletLayer.getLayers().length, '个图层')
    this.leafletLayer.addTo(map)

    console.log('[GeoDataLayer] ========== addTo 完成 ==========')
    return this
  }

  /**
   * 渲染点状数据
   *
   * 🔧 使用 L.circleMarker（像素半径）+ 动态半径计算替代 L.circle（米半径）。
   * L.circle 在缩放动画后存在路径投影不更新的问题，改用 circleMarker + 重绘
   * 可以在每次缩放时精确控制显示大小。
   *
   * @param useCulling 是否使用视口裁剪（默认false显示全部，地图移动后设为true）
   */
  private _renderPoints(useCulling: boolean = false): void {
    if (!this.leafletLayer || !this.map) return

    const bounds = this.map.getBounds()
    const paddedBounds = bounds ? this._padBounds(bounds, 0.1) : null
    const zoom = this.map.getZoom()

    let filteredCount = 0
    let renderedCount = 0
    let skippedNoCoords = 0

    for (let i = 0; i < this.data.length; i++) {
      const item = this.data[i]
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

      const marker = L.circleMarker([displayLat, displayLng], {
        ...DEFAULT_POINT_STYLE,
        radius: pixelRadius
      })

      if (this.onFeatureClick && this.isInteractive) {
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e)
          this.onFeatureClick!(item.properties, e as L.LeafletMouseEvent, item.name)
        })
      }

      // 只在交互启用时绑定 tooltip
      if (this.isInteractive) {
        marker.bindTooltip(item.name || `点${i+1}`, { permanent: false, direction: 'top' })
      }
      marker.addTo(this.leafletLayer!)
      renderedCount++
    }

    console.log(`[GeoDataLayer] _renderPoints 完成: 总数据=${this.data.length}, 无坐标=${skippedNoCoords}, 过滤=${filteredCount}, 渲染=${renderedCount}`)
  }

  /**
   * 渲染扇区数据
   * LOD策略: zoom <= 9 用圆点, zoom > 9 用扇形
   * @param useCulling 是否使用视口裁剪（默认false显示全部，地图移动后设为true）
   */
  private _renderSectors(useCulling: boolean = false): void {
    if (!this.leafletLayer) return

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

    for (let i = 0; i < this.data.length; i++) {
      const item = this.data[i]
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
        const marker = L.circleMarker([displayLat, displayLng], DEFAULT_POINT_STYLE)
        if (this.onFeatureClick && this.isInteractive) {
          marker.on('click', (e) => {
            L.DomEvent.stopPropagation(e)
            this.onFeatureClick!(item.properties, e as L.LeafletMouseEvent, item.name)
          })
        }
        // 只在交互启用时绑定 tooltip
        if (this.isInteractive) {
          marker.bindTooltip(item.name || `扇区${i+1}`, { permanent: false, direction: 'top' })
        }
        marker.addTo(this.leafletLayer!)
        renderedCount++
      } else {
        // 渲染为扇形
        // 使用数据中的波束宽度，如果没有则默认65度
        const beamwidth = item.beamwidth || 65
        const SECTOR_RADIUS = 80 // 米

        const points = createSectorPolygon(displayLat, displayLng, azimuth, beamwidth, SECTOR_RADIUS)
        const polygon = L.polygon(points, DEFAULT_SECTOR_STYLE)

        if (this.onFeatureClick && this.isInteractive) {
          polygon.on('click', (e) => {
            L.DomEvent.stopPropagation(e)
            this.onFeatureClick!(item.properties, e as L.LeafletMouseEvent, item.name)
          })
        }
        // 只在交互启用时绑定 tooltip
        if (this.isInteractive) {
          polygon.bindTooltip(item.name || `扇区${i+1}`, { permanent: false, direction: 'top' })
        }
        polygon.addTo(this.leafletLayer!)
        renderedCount++
      }
    }

    console.log(`[GeoDataLayer] _renderSectors 完成: 总数据=${this.data.length}, 无坐标=${skippedNoCoords}, 过滤=${filteredCount}, 渲染=${renderedCount}`)
  }

  /**
   * 渲染多边形数据
   *
   * 坐标说明：item.path 已在后端转换为 GCJ02 坐标，格式为 [[lat, lng], ...]
   * 直接传给 L.polygon 即可，Leaflet 不会进行额外的坐标转换
   * @param useCulling 是否使用视口裁剪（默认false显示全部，地图移动后设为true）
   */
  private _renderPolygons(useCulling: boolean = false): void {
    if (!this.leafletLayer) return

    // 🔧 视口裁剪优化：获取当前视口边界
    const bounds = this.map?.getBounds()
    const paddedBounds = bounds ? this._padBounds(bounds, 0.3) : null  // 30% 缓冲（多边形需要更大缓冲）

    console.log('[GeoDataLayer] _renderPolygons 开始，数据量:', this.data.length)
    console.log('[GeoDataLayer] _renderPolygons this.geometryType:', this.geometryType)
    console.log('[GeoDataLayer] _renderPolygons: useCulling=', useCulling, 'bounds=', bounds, 'paddedBounds=', paddedBounds)

    let filteredCount = 0
    let renderedCount = 0
    let skippedInvalidPath = 0

    for (let i = 0; i < this.data.length; i++) {
      const item = this.data[i]

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
        const polygon = L.polygon(item.path as L.LatLngExpression[], DEFAULT_POLYGON_STYLE)

        if (this.onFeatureClick && this.isInteractive) {
          polygon.on('click', (e) => {
            L.DomEvent.stopPropagation(e)
            this.onFeatureClick!(item.properties, e as L.LeafletMouseEvent, item.name)
          })
        }

        // 只在交互启用时绑定 tooltip
        if (this.isInteractive) {
          polygon.bindTooltip(item.name || `多边形${i+1}`, { permanent: false, direction: 'top' })
        }
        polygon.addTo(this.leafletLayer!)
        renderedCount++
      } catch (error) {
        console.error(`[GeoDataLayer] ❌ 第 ${i} 个多边形渲染失败:`, error)
      }
    }

    console.log(`[GeoDataLayer] _renderPolygons 完成: 总数据=${this.data.length}, 无效路径=${skippedInvalidPath}, 过滤=${filteredCount}, 渲染=${renderedCount}`)
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

    // 移除 Canvas 标签层
    if (this.canvasLabelLayer && targetMap) {
      targetMap.removeLayer(this.canvasLabelLayer)
      this.canvasLabelLayer = null
    }

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

    // 标签更新
    if (this.labelsEnabled) {
      this._updateLabelsThrottled()
    }
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

    // 更新标签
    if (this.labelsEnabled) {
      this._updateLabelsThrottled()
    }
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

    // 标签更新（使用节流）
    if (this.labelsEnabled) {
      this._updateLabelsThrottled()
    }

    // 纯平移时直接重新渲染几何图形（视口裁剪需要更新）
    // 缩放引起的 moveend 不需要在此处理，_handleZoomEnd 已负责
    if (!zoomChanged) {
      // 取消之前的定时器
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
      // 创建 Canvas 标签层（如果尚未创建）
      if (!this.canvasLabelLayer) {
        console.log(`[GeoDataLayer] 创建新的 Canvas 标签层`)
        this.canvasLabelLayer = new GeoDataCanvasLabelLayer({
          fontSize: this.labelConfig.fontSize,
          fontColor: this.labelConfig.color
        })
        this.canvasLabelLayer.addTo(this.map)
      } else {
        console.log(`[GeoDataLayer] Canvas 标签层已存在`)
      }

      console.log(`[GeoDataLayer] 调用 _createLabels()`)
      this._createLabels(this.map)
    } else {
      // 移除 Canvas 标签层
      if (this.canvasLabelLayer) {
        console.log(`[GeoDataLayer] 移除 Canvas 标签层`)
        this.map.removeLayer(this.canvasLabelLayer)
        this.canvasLabelLayer = null
      }
    }

    console.log(`[GeoDataLayer] ========== setLabelVisibility 完成 ==========`)
    return this
  }

  /**
   * 设置标签配置
   */
  setLabelConfig(config: { content: string; color: string; fontSize: number }): this {
    console.log(`[GeoDataLayer] setLabelConfig 被调用:`, {
      id: this.id,
      oldConfig: this.labelConfig,
      newConfig: config
    })

    // 更新配置
    this.labelConfig = {
      content: config.content || 'name',
      color: config.color || '#000000',
      fontSize: config.fontSize || 12
    }

    // 更新 Canvas 标签层配置
    if (this.canvasLabelLayer) {
      this.canvasLabelLayer.updateConfig({
        fontColor: this.labelConfig.color,
        fontSize: this.labelConfig.fontSize
      })
    }

    // 如果标签已启用，重新创建标签以应用新配置
    if (this.labelsEnabled && this.map) {
      console.log(`[GeoDataLayer] 标签已启用，重新创建标签以应用新配置`)
      this._createLabels(this.map)
    }

    return this
  }

  /**
   * 创建标签 - 使用 Canvas 渲染
   *
   * 🔧 延时显示方式：创建所有元素的标签，由 Canvas 层根据屏幕可见性动态渲染
   *
   * 优化策略：
   * - 创建所有元素的标签数据（不使用视口裁剪）
   * - Canvas 层根据屏幕坐标判断可见性
   * - 地图移动时标签自动跟随显示/隐藏
   * - 使用 Canvas 代替 DOM 元素，性能更好
   */
  private _createLabels(map: L.Map): void {
    // 防御性检查：确保只在图层可见时才创建标签
    if (!this.visible) {
      console.log('[GeoDataLayer] ⚠️ _createLabels: 图层不可见，跳过标签创建')
      return
    }

    // 确保 Canvas 标签层已创建
    if (!this.canvasLabelLayer) {
      this.canvasLabelLayer = new GeoDataCanvasLabelLayer({
        fontSize: this.labelConfig.fontSize,
        fontColor: this.labelConfig.color
      })
      this.canvasLabelLayer.addTo(map)
    }

    console.log('[GeoDataLayer] ========== _createLabels 开始（延时显示模式）=========')
    console.log('[GeoDataLayer] id:', this.id, 'geometryType:', this.geometryType)
    console.log('[GeoDataLayer] 数据量:', this.data.length, 'zoom:', this.currentZoom)

    // 🔧 延时显示方式：收集所有元素的标签数据，不使用视口裁剪
    // Canvas 层会根据屏幕坐标动态判断哪些标签应该显示
    const labels: CanvasLabelData[] = []

    let skippedNoPosition = 0
    let skippedNoContent = 0

    for (let i = 0; i < this.data.length; i++) {
      const item = this.data[i]

      // 获取位置
      const latLng = this._getLatLng(item)
      if (!latLng) {
        skippedNoPosition++
        continue
      }

      // 🔧 移除视口裁剪：创建所有元素的标签
      // Canvas 层会在渲染时根据屏幕坐标判断可见性
      // 这样地图移动时新进入视窗的元素会自动显示标签

      // 获取标签内容
      const content = this._getLabelContent(item, i)
      if (!content) {
        skippedNoContent++
        continue
      }

      labels.push({
        index: i,
        position: latLng,
        content
      })
    }

    console.log('[GeoDataLayer] 标签收集统计（所有元素，无视口裁剪）:')
    console.log('  - 无位置:', skippedNoPosition)
    console.log('  - 无内容:', skippedNoContent)
    console.log('  - ✅ 创建标签:', labels.length, '/', this.data.length)

    // 更新到 Canvas 图层
    this.canvasLabelLayer.setLabels(labels)

    console.log('[GeoDataLayer] ========== _createLabels 完成 ==========')
  }

  /**
   * 获取标签内容
   */
  private _getLabelContent(dataItem: GeoDataItem, index: number): string {
    if (!dataItem) return ''

    // 根据 labelConfig.content 获取字段值
    const field = this.labelConfig.content

    // 如果是 'name' 或默认，使用 item.name
    if (field === 'name') {
      return dataItem.name || this._getDefaultLabel(index)
    }

    // 从 properties 中获取字段值
    if (dataItem.properties && dataItem.properties[field] !== undefined && dataItem.properties[field] !== null) {
      return String(dataItem.properties[field])
    }

    // 回退到 name
    return dataItem.name || this._getDefaultLabel(index)
  }

  /**
   * 获取默认标签文本
   */
  private _getDefaultLabel(index: number): string {
    switch (this.geometryType) {
      case 'point':
        return `点${index + 1}`
      case 'sector':
        return `扇区${index + 1}`
      case 'polygon':
        return `多边形${index + 1}`
      default:
        return `要素${index + 1}`
    }
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
   * 设置框选高亮
   * @param ids 选中的要素ID集合，null表示清除
   */
  setSelectionHighlight(ids: Set<string> | null): void {
    this.selectionHighlightIds = ids
    if (!this.leafletLayer) return

    this.leafletLayer.eachLayer((layer: any) => {
      // 获取要素的ID（从options或feature中）
      const featureId = layer.options?.properties?.name || layer.options?.properties?.id || ''
      const isSelected = ids?.has(String(featureId))

      if (layer instanceof L.CircleMarker || layer instanceof L.Polygon) {
        if (isSelected) {
          // 保存原始样式（如果还没保存）
          if (!this.originalStyles.has(layer)) {
            this.originalStyles.set(layer, {
              color: layer.options.color,
              weight: layer.options.weight,
              fillColor: layer.options.fillColor,
              fillOpacity: layer.options.fillOpacity
            })
          }
          // 应用高亮样式：红色边框
          layer.setStyle({
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
          } else {
            // 如果没有保存的样式，使用默认样式
            layer.setStyle(this._getDefaultStyle())
          }
        }
      }
    })
  }

  /**
   * 获取默认样式
   */
  private _getDefaultStyle(): any {
    switch (this.geometryType) {
      case 'point':
        return DEFAULT_POINT_STYLE
      case 'sector':
        return DEFAULT_SECTOR_STYLE
      case 'polygon':
        return DEFAULT_POLYGON_STYLE
      default:
        return DEFAULT_POINT_STYLE
    }
  }

  /**
   * 获取多边形内的要素（用于框选）
   * @param polygon Leaflet多边形对象
   */
  getFeaturesInPolygon(polygon: L.Polygon): GeoDataItem[] {
    if (!this.leafletLayer) return []
    const results: GeoDataItem[] = []
    const bounds = polygon.getBounds()

    this.leafletLayer.eachLayer((layer: any) => {
      let isInside = false
      let layerLatLng: L.LatLng | null = null

      if (layer.getLatLng) {
        // 点要素（CircleMarker）
        layerLatLng = layer.getLatLng()
        if (bounds.contains(layerLatLng)) {
          isInside = polygon.contains(layerLatLng)
        }
      } else if (layer.getBounds) {
        // 线/面要素：检查中心点
        const layerBounds = layer.getBounds()
        layerLatLng = layerBounds.getCenter()
        if (bounds.contains(layerLatLng)) {
          isInside = polygon.contains(layerLatLng)
        }
      }

      if (isInside && layer.options?.properties) {
        results.push({
          name: layer.options.properties.name,
          properties: layer.options.properties
        })
      }
    })

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
        results.push({
          name: layer.options.properties.name,
          properties: layer.options.properties
        })
      }
    })

    return results
  }

  /**
   * 节流更新标签（用于地图移动和缩放）
   *
   * 🔧 延时显示模式：
   * - 首次创建时调用 _createLabels() 创建所有元素的标签
   * - 地图移动时调用 updateViewport() 更新标签可见性
   * - 新进入视窗的元素自动显示标签，移出视窗的自动隐藏
   */
  private _updateLabelsThrottled(): void {
    console.log('[GeoDataLayer] _updateLabelsThrottled 被调用:', {
      hasCanvasLabelLayer: !!this.canvasLabelLayer,
      hasMap: !!this.map,
      existingLabels: this.canvasLabelLayer?.getLabelCount() || 0
    })

    if (!this.canvasLabelLayer || !this.map) {
      console.log('[GeoDataLayer] _updateLabelsThrottled: 跳过（缺少 Canvas 层或地图）')
      return
    }

    // 防抖：150ms 内只执行一次
    if (this._mapMoveTimer) {
      clearTimeout(this._mapMoveTimer)
      console.log('[GeoDataLayer] _updateLabelsThrottled: 取消之前的定时器')
    }

    this._mapMoveTimer = window.setTimeout(() => {
      if (!this.canvasLabelLayer || !this.map) return

      const existingLabelCount = this.canvasLabelLayer.getLabelCount()
      console.log('[GeoDataLayer] _updateLabelsThrottled: 定时器触发，现有标签数 =', existingLabelCount)

      // 🔧 延时显示模式：只更新标签可见性，不重新创建
      // 首次调用 _createLabels() 时已创建所有元素的标签
      // 后续只需更新屏幕坐标和可见性即可
      if (existingLabelCount === 0) {
        // 没有标签数据，首次创建
        console.log('[GeoDataLayer] _updateLabelsThrottled: 首次创建标签，调用 _createLabels()')
        this._createLabels(this.map)
      } else {
        // 有标签数据，只更新可见性
        const bounds = this.map.getBounds()
        const zoom = this.map.getZoom()
        console.log('[GeoDataLayer] _updateLabelsThrottled: 更新标签可见性')
        this.canvasLabelLayer.updateViewport(bounds, zoom)
      }

      this._mapMoveTimer = null
    }, 150) as unknown as number
  }

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
  }
}

/**
 * GeoDataLayer 管理器 - 管理多个地理化数据图层
 */
export class GeoDataLayerManager {
  private layers: Map<string, GeoDataLayer> = new Map()
  private map: L.Map | null = null

  /**
   * 初始化管理器
   */
  init(map: L.Map): void {
    this.map = map
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

    const layer = new GeoDataLayer(options)
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
