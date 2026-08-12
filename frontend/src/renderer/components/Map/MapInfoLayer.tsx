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
 * MapInfo 图层类
 */
export class MapInfoLayer {
  private id: string
  private name: string
  private type: LayerGeometryType
  private geoJSONLayer: L.GeoJSON | null = null
  private canvasRenderer: L.Canvas | null = null // 独立 Canvas renderer（用于 z-order 置顶）
  private style: MapInfoLayerStyle
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
   * @param center 中心点 (渲染坐标/GCJ02)
   * @param radius 半径 (米)
   */
  getFeaturesInCircle(center: L.LatLng, radius: number): any[] {
    if (!this.geoJSONLayer) {
      if (IS_DEV) console.log('[MapInfoLayer] getFeaturesInCircle: geoJSONLayer不存在', this.id)
      return []
    }
    const results: any[] = []
    let layerCount = 0

    this.geoJSONLayer.eachLayer((layer: any) => {
      layerCount++
      if (layer.getLatLng) {
        const latlng = layer.getLatLng()
        const distance = center.distanceTo(latlng)
        if (distance <= radius) {
          results.push(layer.feature.properties)
        }
      } else if (layer.getBounds) {
        // 对于线和面，如果边界中心在圆内或者边界与圆相交
        // 简化处理：检查边界中心
        const bounds = layer.getBounds()
        const distance = center.distanceTo(bounds.getCenter())
        if (distance <= radius) {
          results.push(layer.feature.properties)
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
   * 获取多边形内的要素
   * @param polygon Leaflet 多边形对象 (坐标为渲染坐标/GCJ02)
   */
  getFeaturesInPolygon(polygon: L.Polygon): any[] {
    if (!this.geoJSONLayer) {
      console.log('[MapInfoLayer] getFeaturesInPolygon: geoJSONLayer不存在', this.id)
      return []
    }
    const results: any[] = []
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
      if (layer.getLatLng) {
        const latlng = layer.getLatLng()
        const inBounds = bounds.contains(latlng)
        const inPolygon = inBounds && this._isPointInPolygon([latlng.lat, latlng.lng], points)
        if (inPolygon) {
          results.push(layer.feature.properties)
          console.log('[MapInfoLayer] 点要素在多边形内:', layer.feature.properties.name || layer.feature.properties.id, latlng)
        }
      } else if (layer.getBounds) {
        // 对于线和面，检查其边界中心是否在多边形内
        const layerBounds = layer.getBounds()
        const center = layerBounds.getCenter()
        const inBounds = bounds.contains(center)
        const inPolygon = inBounds && this._isPointInPolygon([center.lat, center.lng], points)
        if (inPolygon) {
          results.push(layer.feature.properties)
          console.log('[MapInfoLayer] 线/面要素中心在多边形内:', layer.feature.properties.name || layer.feature.properties.id, center)
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

    // 创建 GeoJSON 图层（使用后端已转换数据）
    // renderer 是合法 Leaflet 运行时选项（PathOptions），但 @types/leaflet 的
    // GeoJSONOptions 未声明该字段，需类型断言
    const geoJsonOptions: L.GeoJSONOptions & { renderer: any } = {
      renderer: canvasRenderer,
      // 点要素样式
      pointToLayer: (feature: any, latLng: L.LatLng) => {
        // 获取 feature 级别的样式（如果存在）
        // 合并优先级：默认样式 < 要素样式(_style.point) < 图层级用户设置(style.point)
        const featureStyle = (feature.properties as any)?._style?.point || {}
        const pointStyle = { ...DEFAULT_STYLES.point, ...featureStyle, ...mapInfoLayer.style.point }

        // 如果有符号类型，可以使用自定义图标
        if (featureStyle.markerSymbol && featureStyle.markerSymbol !== 'circle') {
          // MapInfo 符号编号转 Leaflet 图标
          return L.circleMarker(latLng, {
            // pointToLayer 不继承 GeoJSON 的 renderer，需显式传入以使用 Canvas
            renderer: canvasRenderer,
            radius: pointStyle.markerSize || pointStyle.radius || 6,
            fillColor: pointStyle.markerColor || pointStyle.fillColor || '#f59e0b',
            color: pointStyle.color || '#fff',
            weight: pointStyle.weight || 2,
            opacity: pointStyle.opacity || 1,
            fillOpacity: pointStyle.fillOpacity || 0.8
          })
        }

        return L.circleMarker(latLng, {
          renderer: canvasRenderer,
          radius: pointStyle.markerSize || pointStyle.radius || 6,
          fillColor: pointStyle.markerColor || pointStyle.fillColor || '#f59e0b',
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
          const lineDashArray = userLine.dashArray ?? featureStyle.strokeDasharray
          if (lineDashArray) {
            result.dashArray = lineDashArray
          }
          return result
        } else if (geometry === 'Polygon' || geometry === 'MultiPolygon') {
          // 合并优先级：默认样式 < 要素样式(_style) < 图层级用户设置(style.polygon)
          const userPolygon = mapInfoLayer.style.polygon || {}
          const mergedStyle = {
            color: userPolygon.color ?? featureStyle.strokeColor ?? DEFAULT_STYLES.polygon.color,
            weight: userPolygon.weight ?? featureStyle.strokeWidth ?? DEFAULT_STYLES.polygon.weight,
            opacity: userPolygon.opacity ?? featureStyle.strokeOpacity ?? DEFAULT_STYLES.polygon.opacity,
            fillColor: userPolygon.fillColor ?? featureStyle.fillColor ?? DEFAULT_STYLES.polygon.fillColor,
            fillOpacity: userPolygon.fillOpacity ?? featureStyle.fillOpacity ?? DEFAULT_STYLES.polygon.fillOpacity,
          }

          const result: any = {
            color: mergedStyle.color || '#10b981',
            weight: mergedStyle.weight || 2,
            opacity: mergedStyle.opacity !== undefined ? mergedStyle.opacity : 1,
            fillColor: mergedStyle.fillColor || '#10b981',
            fillOpacity: mergedStyle.fillOpacity || 0.3
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
   * 设置图层颜色覆盖（图形颜色 / 透明度 / 边框宽度 / 边框颜色）
   * 写入 style 配置后重新执行 GeoJSON 的 style 函数，使已渲染要素即时生效。
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

    // 重新应用样式
    // 注：点要素由 pointToLayer 创建（style 函数对 Point 返回 {}，resetStyle 对其无效），
    // 必须对点要素直接 setStyle；线/面走 style 函数 resetStyle 即可。
    if (this.geoJSONLayer) {
      this.geoJSONLayer.eachLayer((layer: any) => {
        if (layer instanceof L.CircleMarker) {
          layer.setStyle({
            fillColor: settings.fillColor,
            fillOpacity: settings.fillOpacity,
            color: settings.borderColor,
            weight: settings.borderWidth,
            opacity: 1
          })
        } else {
          this.geoJSONLayer?.resetStyle(layer)
        }
      })
      // 兜底：强制所有要素重绘，确保 Canvas 渲染器必然刷新（避免个别 setStyle 未触发重绘）
      this.geoJSONLayer.eachLayer((layer: any) => {
        if (typeof layer.redraw === 'function') layer.redraw()
      })
    }
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

      // 获取标识符 - 与 selectFeaturesAtPoint 保持一致的ID获取逻辑
      const val = feature.properties[idField] || extractFeatureId(feature.properties)
      const isSelected = ids?.has(String(val))

      // 更新样式
      if (layer instanceof L.Path) {
        if (isSelected) {
          // 高亮样式：红色边框
          layer.setStyle({
            color: '#ef4444',
            weight: 3,
            opacity: 1
          })
          if (layer.bringToFront) layer.bringToFront()
        } else {
          // 恢复默认样式 (重新触发 GeoJSON 的 style 函数)
          this.geoJSONLayer?.resetStyle(layer)
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

    // 2. 字段回退：配置字段（含映射）均缺失时，回退到第一个可用的字符串属性，
    // 避免 MIF/MAP 图层字段名不匹配（如 OBJECTID/NAME_1/LABEL）导致大量标签不显示
    // SKIP_FIELDS 按小写匹配，覆盖大小写变体与坐标类字段，避免把坐标/元数据当标签
    const SKIP_FIELDS = new Set(['id', 'type', 'geometry', 'path', 'color', 'style', 'longitude', 'latitude', 'lng', 'lat', 'lon', 'x', 'y', 'azimuth', 'beamwidth', 'properties', '经度', '纬度'])
    for (const [key, value] of Object.entries(properties)) {
      if (SKIP_FIELDS.has(key.toLowerCase())) continue
      if (typeof value !== 'string') continue
      const v = value.trim()
      if (!v) continue
      return v
    }

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
