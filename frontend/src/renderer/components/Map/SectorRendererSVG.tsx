/**
 * 扇区渲染器 - SVG版本（使用 L.Polygon + L.CircleMarker）
 *
 * 特点：
 * - Zoom <= 9: 对每个扇区使用 L.CircleMarker 绘制圆点（5米半径，无数量限制）
 * - Zoom > 9: 使用 L.Polygon 绘制全部扇区（无数量限制，完整细节）
 * - 解除所有扇区数量限制，确保密集区域也不缺失
 * - Leaflet 自动处理坐标转换、缩放和定位
 * - 原生 Leaflet 事件处理点击和悬停
 * - 支持不同小区覆盖类型的渲染（室内圆形/室外扇形）
 * - 支持扇区标签显示/隐藏
 */
import L from 'leaflet'
import { RenderSectorData } from '../../services/mapDataService'
import { SECTOR_CONFIG, getCellCoverStyle, getSectorColor } from '../../config/sector-config'
import { tacColorMapper } from '../../utils/tacColors'
import type { NetworkType } from '../../config/sector-config'

/**
 * PCI高亮配置接口
 */
export interface PCIHighlightConfig {
  /** 选中的扇区ID */
  selectedId: string | null
  /** 同频同PCI的扇区ID列表 */
  relatedIds: string[]
}

/**
 * TAC插花高亮配置接口
 */
export interface TACHighlightConfig {
  /** 选中的扇区ID */
  selectedId: string | null
  /** 是否是插花小区 */
  isSingularity?: boolean
  /** TAC值（用于按TAC颜色渲染） */
  tacValue?: string
  /** 周边主流TAC的小区ID列表（保留兼容） */
  relatedIds?: string[]
  /** 网络类型（用于TAC颜色映射） */
  networkType?: 'LTE' | 'NR'
}

/**
 * 邻区高亮配置接口
 */
export interface NeighborHighlightConfig {
  /** 源小区ID */
  sourceSectorId: string
  /** 目标小区ID集合 */
  targetSectorIds: Set<string>
  /** 源小区颜色 */
  sourceColor: string
  /** 目标小区颜色 */
  targetColor: string
}

/**
 * 标签字段类型 - 支持任意字符串以兼容 LabelSettingsModal
 */
export type LabelField = string

/**
 * 扇区标签配置接口
 */
export interface SectorLabelConfig {
  /** 标签内容字段 */
  content: LabelField
  /** 字体颜色 */
  color: string
  /** 字体大小 */
  fontSize: number
}

/**
 * 扇区图层配置
 */
export interface SectorLayerOptions extends L.LayerOptions {
  /** 扇区数据 */
  sectors: RenderSectorData[]
  /** 点击回调 */
  onClick?: (sector: RenderSectorData, event: L.LeafletMouseEvent) => void
  /** 当前缩放级别 */
  zoom: number
  /** 是否显示扇区标签 */
  showLabels?: boolean
  /** 渲染模式（用于PCI/邻区规划/TAC核查可视化） */
  renderMode?: 'default' | 'pci-planning' | 'neighbor-planning' | 'tac-check'
  /** 扇区标签配置（可选，用于在创建图层时应用已保存的配置） */
  labelConfig?: SectorLabelConfig
  /** 是否处于测距模式（测距模式下禁用扇区点击和悬停效果） */
  measureMode?: boolean
}

/**
 * 扇区 SVG 图层（使用 L.Polygon + L.CircleMarker 实现）
 *
 * 继承 L.Layer，智能切换渲染模式：
 * - zoom < 17: 扇区模式，每个扇区是一个 L.Polygon
 * - zoom >= 17: 站点圆点模式，每个站点是一个 L.CircleMarker
 */
export class SectorSVGLayer extends L.Layer {
  private readonly _isDev = import.meta.env.DEV
  private sectors: RenderSectorData[] = []
  private onClick?: (sector: RenderSectorData, event: L.LeafletMouseEvent) => void
  private mapInstance?: L.Map
  private currentZoom: number = 12
  private showLabels: boolean = false
  private renderMode: 'default' | 'pci-planning' | 'neighbor-planning' | 'tac-check' = 'default'
  private measureMode: boolean = false  // 测距模式标志
  private isSelectionMode: boolean = false // 框选模式标志 (满足需求3)

  // 动画帧请求ID
  private _animRequestId: number | null = null
  private _styleUpdateRequestId: number | null = null

  // 频点可见性映射（用于过滤）
  private frequencyVisibility: Map<number, boolean> = new Map()

  // 扇区ID白名单（用于只渲染特定扇区）
  private sectorIdWhitelist: Set<string> | null = null

  // PCI高亮配置
  private pciHighlightConfig: PCIHighlightConfig | null = null

  // 邻区高亮配置
  private neighborHighlightConfig: NeighborHighlightConfig | null = null

  // TAC插花高亮配置
  private tacHighlightConfig: TACHighlightConfig | null = null

  // 框选高亮配置
  private selectionHighlightIds: Set<string> | null = null

  // PCI模式标签启用状态 (用于控制是否显示小区名称+PCI值标签)
  private sectorLabelsEnabled: boolean = false

  // 扇区标签配置
  private labelConfig: SectorLabelConfig = {
    content: 'name',
    color: '#000000',
    fontSize: 12
  }

  // 扇区多边形映射（带缓存时间戳）
  private sectorPolygons = new Map<string, {
    polygon: L.Polygon
    lastUsed: number  // 最后使用时间戳
    zoom: number      // 创建时的缩放级别
  }>()

  // 站点圆点映射（带缓存时间戳）
  private siteMarkers = new Map<string, {
    marker: L.CircleMarker
    lastUsed: number
    zoom: number
  }>()

  // 扇区标签映射
  private sectorLabels = new Map<string, L.Marker>()

  // 位置分组缓存 - 用于同一位置的扇区分组
  private locationGroupsCache: {
    groups: Map<string, RenderSectorData[]>
    timestamp: number
  } | null = null

  // 聚合图层
  private featureGroup?: L.FeatureGroup

  // 视口扇区缓存（避免重复计算）
  private visibleSectorsCache: {
    boundsKey: string
    sectors: RenderSectorData[]
    timestamp: number
  } | null = null

  // 延迟清理定时器
  private cleanupTimer: number | null = null

  constructor(options: SectorLayerOptions) {
    super()
    this.sectors = options.sectors
    this.onClick = options.onClick
    this.currentZoom = options.zoom
    this.showLabels = options.showLabels || false
    this.renderMode = options.renderMode || 'default'
    this.measureMode = options.measureMode || false

    console.log('[SectorRenderer] 构造函数初始化', {
      sectorsCount: this.sectors.length,
      sampleSectors: this.sectors.slice(0, 5).map(s => ({
        id: s.id,
        idType: typeof s.id,
        name: s.name,
        displayLat: s.displayLat,
        displayLng: s.displayLng,
        hasDisplayLat: !!s.displayLat,
        hasDisplayLng: !!s.displayLng,
        latitude: s.latitude,
        longitude: s.longitude,
        siteId: s.siteId,
        sectorId_field: s.sectorId
      }))
    })

    // 如果提供了labelConfig，使用它（用于在创建图层时应用已保存的配置）
    if (options.labelConfig) {
      this.labelConfig = options.labelConfig
      console.log('[SectorRenderer] 构造函数中应用已保存的标签配置', options.labelConfig)
    }
  }

  /**
   * Leaflet 图层生命周期：添加到地图
   */
  onAdd(map: L.Map): this {
    this.mapInstance = map

    // 创建 FeatureGroup 来管理所有扇区多边形和圆点
    this.featureGroup = L.featureGroup()
    this.featureGroup.addTo(map)

    // 监听地图移动和缩放结束事件，重新渲染以显示新进入视口的扇区
    map.on('moveend', this._render, this)

    // zoom: 缩放过程中持续触发，用于平滑更新扇区大小
    this._onZoom = this._onZoom.bind(this)
    map.on('zoom', this._onZoom, this)

    // 渲染所有扇区
    this._render()

    return this
  }

  /**
   * Leaflet 图层生命周期：从地图移除
   */
  onRemove(map: L.Map): this {
    // 移除事件监听
    map.off('moveend', this._render, this)
    map.off('zoom', this._onZoom, this)

    // 取消挂起的动画帧
    if (this._animRequestId !== null) {
      L.Util.cancelAnimFrame(this._animRequestId)
      this._animRequestId = null
    }

    // 取消样式更新请求
    if (this._styleUpdateRequestId !== null) {
      L.Util.cancelAnimFrame(this._styleUpdateRequestId)
      this._styleUpdateRequestId = null
    }

    // 取消延迟清理定时器
    if (this.cleanupTimer !== null) {
      window.clearTimeout(this.cleanupTimer)
      this.cleanupTimer = null
    }

    if (this.featureGroup) {
      map.removeLayer(this.featureGroup)
      this.featureGroup = undefined
    }

    this.sectorPolygons.clear()
    this.siteMarkers.clear()
    this.sectorLabels.clear()
    this.visibleSectorsCache = null
    return this
  }

  /**
   * 更新扇区数据
   */
  updateSectors(sectors: RenderSectorData[]): void {
    this.sectors = sectors
    this._render()
  }

  /**
   * 更新缩放级别
   */
  updateZoom(zoom: number): void {
    this.currentZoom = zoom
    // 强制重绘
    if (!this.mapInstance) return
    this._render()
  }

  /**
   * 更新标签显示状态
   */
  updateShowLabels(showLabels: boolean): void {
    this.showLabels = showLabels
    this._render()
  }

  /**
   * 更新测距模式状态
   * @param measureMode 是否处于测距模式
   */
  updateMeasureMode(measureMode: boolean): void {
    this.measureMode = measureMode
    // 测距模式变化时不需要重新渲染，只需改变事件行为
    console.log('[SectorRenderer] 测距模式更新:', measureMode)
  }

  /**
   * 更新框选模式状态 (满足需求3)
   * @param isSelectionMode 是否处于框选模式
   */
  updateSelectionMode(isSelectionMode: boolean): void {
    this.isSelectionMode = isSelectionMode
    // 框选模式下不禁用交互，只阻止点击事件触发信息面板
    // 鼠标悬停提示和光标样式由 OnlineMap.tsx 的 mousemove 事件处理
    console.log('[SectorRenderer] 框选模式更新:', isSelectionMode)
  }

  /**
   * 设置频点可见性
   * @param frequency 频点值
   * @param visible 是否可见
   */
  setFrequencyVisibility(frequency: number, visible: boolean): void {
    this.frequencyVisibility.set(frequency, visible)
    this._render() // 重新渲染
  }

  /**
   * 获取指定屏幕位置的所有扇区数据
   * 用于处理重叠扇区点击
   */
  public getSectorsAt(clientX: number, clientY: number): RenderSectorData[] {
    const sectors: RenderSectorData[] = []
    const elements = document.elementsFromPoint(clientX, clientY)

    // 遍历所有元素，寻找属于本图层的扇区多边形
    for (const el of elements) {
      if (el.classList.contains('sector-polygon')) {
        // 通过寻找 FeatureGroup 中的对应 Layer 获取数据
        if (this.featureGroup) {
          this.featureGroup.eachLayer((layer: any) => {
            if (layer.getElement?.() === el && layer.sectorData) {
              sectors.push(layer.sectorData)
            }
          })
        }
      }
    }

    // 去重并返回
    return sectors.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i)
  }

  /**
   * 批量设置频点可见性
   * @param visibilityMap 频点可见性映射
   */
  setFrequenciesVisibility(visibilityMap: Map<number, boolean>): void {
    // 复制传入的可见性映射
    this.frequencyVisibility = new Map(visibilityMap)

    // PCI/邻区规划/TAC核查模式：自动收集所有扇区的频点并设置为可见
    if (this.renderMode === 'pci-planning' || this.renderMode === 'neighbor-planning' || this.renderMode === 'tac-check') {
      const allFrequencies = new Set<number>()
      this.sectors.forEach(sector => {
        if (sector.frequency) allFrequencies.add(sector.frequency)
        if (sector.earfcn) allFrequencies.add(sector.earfcn)
        if (sector.ssbFrequency) allFrequencies.add(sector.ssbFrequency)
      })

      // 为所有存在的频点设置为可见
      let hasNewFrequencies = false
      allFrequencies.forEach(f => {
        if (!this.frequencyVisibility.has(f)) {
          this.frequencyVisibility.set(f, true)
          hasNewFrequencies = true
        }
      })

      if (hasNewFrequencies) {
        console.log('[SectorRenderer] 自动添加扇区中存在的频点到可见性映射（PCI/邻区规划模式）', {
          totalFrequencies: allFrequencies.size,
          userControlledFrequencies: visibilityMap.size,
          newFrequencies: allFrequencies.size - visibilityMap.size
        })
      }
    } else {
      // 其他模式：自动收集所有扇区的频点并设置默认可见性
      const allFrequencies = new Set<number>()
      this.sectors.forEach(sector => {
        if (sector.frequency) allFrequencies.add(sector.frequency)
        if (sector.earfcn) allFrequencies.add(sector.earfcn)
        if (sector.ssbFrequency) allFrequencies.add(sector.ssbFrequency)
      })

      // 为所有存在的频点设置默认可见性（如果不在映射中）
      let hasNewFrequencies = false
      allFrequencies.forEach(f => {
        if (!this.frequencyVisibility.has(f)) {
          // 频点不在映射中，默认为不可见（只有用户明确勾选的频点才显示）
          this.frequencyVisibility.set(f, false)
          hasNewFrequencies = true
        }
      })

      if (hasNewFrequencies) {
        console.log('[SectorRenderer] 自动添加扇区中存在的频点到可见性映射', {
          totalFrequencies: allFrequencies.size,
          userControlledFrequencies: visibilityMap.size,
          newFrequencies: allFrequencies.size - visibilityMap.size
        })
      }
    }

    this._render()
  }

  /**
   * 设置渲染模式
   * @param mode 渲染模式
   */
  setRenderMode(mode: 'default' | 'pci-planning' | 'neighbor-planning' | 'tac-check'): void {
    this.renderMode = mode
    console.log('[SectorRenderer] 设置渲染模式:', mode)
    this._updateSectorStyles()
  }

  /**
   * 设置扇区ID白名单
   * 只渲染白名单中的扇区，null表示渲染所有扇区
   * @param whitelist 扇区ID集合，null表示清除白名单
   */
  setSectorIdWhitelist(whitelist: Set<string> | null): void {
    this.sectorIdWhitelist = whitelist
    console.log('[SectorRenderer] 设置扇区白名单', {
      enabled: whitelist !== null,
      count: whitelist?.size || 0
    })
    this._render()
  }

  /**
   * 更新标签配置
   * @param config 标签配置
   */
  updateLabelConfig(config: SectorLabelConfig): void {
    this.labelConfig = { ...this.labelConfig, ...config }
    console.log('[SectorRenderer] 更新标签配置:', this.labelConfig)
    if (this.showLabels) {
      this._render()
    }
  }

  /**
   * 设置PCI高亮模式
   * @param config PCI高亮配置，null表示清除高亮
   */
  setPCIHighlightMode(config: PCIHighlightConfig | null): void {
    this.pciHighlightConfig = config
    // 使用requestAnimationFrame批处理样式更新，提升性能
    if (this._styleUpdateRequestId !== null) {
      L.Util.cancelAnimFrame(this._styleUpdateRequestId)
    }
    this._styleUpdateRequestId = L.Util.requestAnimFrame(() => {
      this._updateSectorStyles()
      this._styleUpdateRequestId = null
    }, this)
  }

  /**
   * 设置邻区高亮模式
   * @param config 邻区高亮配置，null表示清除高亮
   */
  setNeighborHighlightMode(config: NeighborHighlightConfig | null): void {
    this.neighborHighlightConfig = config
    console.log('[SectorRenderer] 设置邻区高亮模式', config)
    // 使用requestAnimationFrame批处理样式更新，提升性能
    if (this._styleUpdateRequestId !== null) {
      L.Util.cancelAnimFrame(this._styleUpdateRequestId)
    }
    this._styleUpdateRequestId = L.Util.requestAnimFrame(() => {
      this._updateSectorStyles()
      this._styleUpdateRequestId = null
    }, this)
  }

  /**
   * 设置TAC插花高亮模式
   * @param config TAC高亮配置，null表示清除高亮
   */
  setTACHighlightMode(config: TACHighlightConfig | null): void {
    this.tacHighlightConfig = config
    console.log('[SectorRenderer] 设置TAC插花高亮模式', config)
    // 使用requestAnimationFrame批处理样式更新，提升性能
    if (this._styleUpdateRequestId !== null) {
      L.Util.cancelAnimFrame(this._styleUpdateRequestId)
    }
    this._styleUpdateRequestId = L.Util.requestAnimFrame(() => {
      this._updateSectorStyles()
      this._styleUpdateRequestId = null
    }, this)
  }

  /**
   * 设置测距模式
   * @param enabled 是否启用测距模式
   */
  setMeasureMode(enabled: boolean): void {
    const prevMode = this.measureMode
    this.measureMode = enabled

    console.log('[SectorRenderer] 设置测距模式', { enabled, prevMode })

    // 如果测距模式发生变化，需要更新所有扇区的交互状态
    if (prevMode !== enabled) {
      this._updateMeasureModeState()
    }
  }

  /**
   * 更新所有扇区的测距模式状态
   */
  private _updateMeasureModeState(): void {
    // 更新多边形的CSS类名
    for (const [sectorId, cached] of this.sectorPolygons) {
      const polygon = cached.polygon
      if (polygon) {
        polygon.setStyle({
          className: this.measureMode ? 'sector-polygon sector-polygon-measure' : 'sector-polygon'
        })
      }
    }

    // 更新圆点标记的CSS类名
    for (const [sectorId, cached] of this.siteMarkers) {
      const marker = cached.marker
      if (marker) {
        marker.setStyle({
          className: this.measureMode ? 'sector-marker sector-marker-measure' : 'sector-marker'
        })
      }
    }

    // 如果退出测距模式，重新渲染以恢复正常交互
    if (!this.measureMode) {
      this._render()
    }
  }

  /**
   * 设置框选高亮模式
   * @param ids 选中的扇区ID集合，null表示清除高亮
   */
  setSelectionHighlight(ids: Set<string> | null): void {
    const prevIds = this.selectionHighlightIds
    this.selectionHighlightIds = ids

    console.log('[SectorRenderer] setSelectionHighlight 被调用', {
      idsCount: ids?.size || 0,
      sampleIds: ids ? Array.from(ids).slice(0, 10) : [],
      sectorsCount: this.sectors.length,
      sampleSectors: this.sectors.slice(0, 5).map(s => ({
        id: s.id,
        idType: typeof s.id,
        name: s.name,
        siteId: s.siteId,
        sectorId: s.sectorId
      })),
      sectorPolygonsCount: this.sectorPolygons.size,
      siteMarkersCount: this.siteMarkers.size,
      mapInstanceExists: !!this.mapInstance,
      featureGroupExists: !!this.featureGroup
    })

    if (ids && ids.size > 0 && this.mapInstance && this.featureGroup) {
      const currentZoom = this.mapInstance.getZoom()
      const mapCenter = this.mapInstance.getCenter()
      const outdoorRadius = this._calculateRadius(currentZoom, mapCenter.lat)
      const indoorRadius = outdoorRadius / 2
      const now = Date.now()

      console.log('[SectorRenderer] 开始强制渲染扇区', {
        idsCount: ids.size,
        currentZoom,
        sectorPolygonsBefore: this.sectorPolygons.size
      })

      for (const sector of this.sectors) {
        const sectorId = String(sector.id)
        const compositeId = sector.siteId && sector.sectorId ? `${sector.siteId}_${sector.sectorId}` : null

        const shouldBeForced = ids.has(sectorId) ||
          (compositeId && ids.has(compositeId)) ||
          (sector.name && ids.has(sector.name))

        if (!shouldBeForced) continue

        // 检查是否需要渲染新扇区或更新已存在扇区的样式
        const existingPolygon = this.sectorPolygons.get(sectorId)
        const existingMarker = this.siteMarkers.get(sectorId)

        if (existingPolygon) {
          // 扇区已存在，更新其样式以应用高亮
          existingPolygon.polygon.setStyle({
            color: '#ff0000',
            weight: 3,
            fillOpacity: 0.6
          })
          existingPolygon.polygon.bringToFront()
          console.log('[SectorRenderer] 更新已有扇区多边形高亮', sectorId)
          continue
        }

        if (existingMarker) {
          // 标记已存在，更新其样式以应用高亮
          existingMarker.marker.setStyle({
            color: '#ff0000',
            weight: 3,
            fillOpacity: 0.6
          })
          existingMarker.marker.bringToFront()
          console.log('[SectorRenderer] 更新已有标记高亮', sectorId)
          continue
        }

        // 扇区不存在，需要创建新的
        // 使用当前缩放级别判断渲染模式，而不是使用可能过时的 this.currentZoom
        const useSiteMarkerMode = currentZoom <= 9
        if (useSiteMarkerMode) {
          const marker = this._createSectorMarker(sector)
          marker.addTo(this.featureGroup)
          this.siteMarkers.set(sectorId, {
            marker,
            lastUsed: now,
            zoom: currentZoom
          })
          console.log('[SectorRenderer] 强制渲染站点标记', sectorId)
        } else {
          const coverStyle = getCellCoverStyle(sector.cell_cover_type, sector.networkType)
          const radius = coverStyle.isCircular ? indoorRadius : outdoorRadius
          const latLngs = this._generateSectorLatLngs(sector, radius)
          const polygon = this._createSectorPolygonWithStyle(sector, latLngs, radius)
          polygon.addTo(this.featureGroup)
          this.sectorPolygons.set(sectorId, {
            polygon,
            lastUsed: now,
            zoom: currentZoom
          })
          console.log('[SectorRenderer] 强制渲染扇区多边形', sectorId)
        }
      }

      console.log('[SectorRenderer] 强制渲染完成', {
        sectorPolygonsAfter: this.sectorPolygons.size,
        siteMarkersAfter: this.siteMarkers.size
      })
    }

    if (this._styleUpdateRequestId !== null) {
      L.Util.cancelAnimFrame(this._styleUpdateRequestId)
    }
    this._styleUpdateRequestId = L.Util.requestAnimFrame(() => {
      this._updateSectorStyles()
      this._styleUpdateRequestId = null
    }, this)
  }

  /**
   * 强制渲染指定的扇区（忽略视口限制）
   * 用于框选高亮时确保选中的扇区都被渲染
   * 注意：即使在低缩放级别（<=6）下，也应该渲染选中的扇区以显示高亮
   */
  private _forceRenderSectorsById(ids: Set<string>): void {
    if (!this.mapInstance || !this.featureGroup) {
      console.log('[SectorRenderer] _forceRenderSectorsById 提前返回：缺少 mapInstance 或 featureGroup')
      return
    }

    const currentZoom = this.mapInstance.getZoom()
    console.log('[SectorRenderer] _forceRenderSectorsById 开始', {
      idsCount: ids.size,
      sampleIds: Array.from(ids).slice(0, 10),
      sectorsCount: this.sectors.length,
      currentZoom,
      sectorPolygonsCount: this.sectorPolygons.size,
      siteMarkersCount: this.siteMarkers.size
    })

    const mapCenter = this.mapInstance.getCenter()
    const outdoorRadius = this._calculateRadius(currentZoom, mapCenter.lat)
    const indoorRadius = outdoorRadius / 2
    const now = Date.now()

    for (const sector of this.sectors) {
      const sectorId = String(sector.id)
      const compositeId = sector.siteId && sector.sectorId ? `${sector.siteId}_${sector.sectorId}` : null

      const shouldBeForced = ids.has(sectorId) ||
        (compositeId && ids.has(compositeId)) ||
        (sector.name && ids.has(sector.name))

      console.log('[SectorRenderer] 检查扇区是否需要强制渲染', {
        sectorId,
        sectorIdType: typeof sector.id,
        compositeId,
        sectorName: sector.name,
        hasInIds: ids.has(sectorId),
        hasCompositeInIds: compositeId ? ids.has(compositeId) : false,
        hasNameInIds: sector.name ? ids.has(sector.name) : false,
        shouldBeForced
      })

      if (!shouldBeForced) continue

      if (this.sectorPolygons.has(sectorId) || this.siteMarkers.has(sectorId)) {
        console.log('[SectorRenderer] 扇区已存在，跳过', sectorId)
        continue
      }

      // 使用当前缩放级别判断渲染模式，而不是使用可能过时的 this.currentZoom
      const useSiteMarkerMode = currentZoom <= 9
      if (useSiteMarkerMode) {
        const marker = this._createSectorMarker(sector)
        marker.addTo(this.featureGroup)
        this.siteMarkers.set(sectorId, {
          marker,
          lastUsed: now,
          zoom: currentZoom
        })
      } else {
        const coverStyle = getCellCoverStyle(sector.cell_cover_type, sector.networkType)
        const radius = coverStyle.isCircular ? indoorRadius : outdoorRadius
        const latLngs = this._generateSectorLatLngs(sector, radius)
        const polygon = this._createSectorPolygonWithStyle(sector, latLngs, radius)
        polygon.addTo(this.featureGroup)
        this.sectorPolygons.set(sectorId, {
          polygon,
          lastUsed: now,
          zoom: currentZoom
        })
      }
    }
  }

  /**
   * 创建扇区多边形（带样式）
   */
  private _createSectorPolygonWithStyle(sector: RenderSectorData, latLngs: L.LatLngExpression[], radius: number): L.Polygon {
    console.log('[SectorRenderer] _createSectorPolygonWithStyle', {
      sectorId: sector.id,
      sectorIdType: typeof sector.id,
      sectorName: sector.name
    })

    const colors = getSectorColor(sector)
    const config = SECTOR_CONFIG[sector.networkType]

    // 检查是否选中
    let strokeColor = config.strokeColor || '#000000'
    let strokeWidth = config.strokeWidth || 0.5
    let fillOpacity = config.opacity

    if (this.selectionHighlightIds && this.selectionHighlightIds.size > 0) {
      const sectorId = String(sector.id)
      const compositeId = sector.siteId && sector.sectorId ? `${sector.siteId}_${sector.sectorId}` : null
      const isSelected = this.selectionHighlightIds.has(sectorId) ||
        (compositeId && this.selectionHighlightIds.has(compositeId)) ||
        (sector.name && this.selectionHighlightIds.has(sector.name))

      if (isSelected) {
        strokeColor = '#ff0000'
        strokeWidth = 3
        fillOpacity = 0.6
      }
    }

    const polygon = L.polygon(latLngs, {
      color: strokeColor,
      weight: strokeWidth,
      opacity: 1,
      fillColor: colors.fillColor,
      fillOpacity: fillOpacity,
      className: 'sector-polygon',
      smoothFactor: 0.1,
      noClip: true
    })

      // 存储扇区数据
      ; (polygon as any).sectorData = sector

    return polygon
  }

  /**
   * 设置扇区标签启用状态
   * @param enabled 是否启用标签
   */
  setSectorLabelsEnabled(enabled: boolean): void {
    this.sectorLabelsEnabled = enabled
    console.log('[SectorRenderer] 设置扇区标签启用状态', { enabled })
    // 重新渲染以更新标签
    this._render()
  }

  /**
   * 获取圆圈内的扇区
   * @param center 中心点 (渲染坐标/GCJ02)
   * @param radius 半径 (米)
   */
  getSectorsInCircle(center: L.LatLng, radius: number): RenderSectorData[] {
    const results: RenderSectorData[] = []

    console.log('[SectorRenderer] getSectorsInCircle 开始', {
      center: { lat: center.lat, lng: center.lng },
      radius,
      totalSectors: this.sectors.length,
      sampleSectorIds: this.sectors.slice(0, 5).map(s => ({
        id: s.id,
        idType: typeof s.id,
        name: s.name
      }))
    })

    // 注意：this.sectors 存的是已经纠偏过的坐标（渲染坐标：displayLat/displayLng）
    // 为了准确，由于中心点 center 也是地图上的点击点（渲染坐标），直接计算距离
    for (const sector of this.sectors) {
      if (!sector.displayLat || !sector.displayLng) {
        console.log('[SectorRenderer] 跳过扇区（缺少坐标）', sector.id, sector.name)
        continue
      }

      const distance = center.distanceTo([sector.displayLat, sector.displayLng])
      if (distance <= radius) {
        console.log('[SectorRenderer] 找到匹配扇区', {
          id: sector.id,
          idType: typeof sector.id,
          name: sector.name
        })
        results.push(sector)
      }
    }

    console.log('[SectorRenderer] getSectorsInCircle 结果', {
      matchedCount: results.length,
      totalCount: this.sectors.length,
      matchedIds: results.map(s => s.id)
    })

    return results
  }

  /**
   * 获取多边形内的扇区
   * @param polygon Leaflet 多边形对象 (坐标为渲染坐标/GCJ02)
   */
  getSectorsInPolygon(polygon: L.Polygon): RenderSectorData[] {
    const results: RenderSectorData[] = []
    const bounds = polygon.getBounds()
    const points = (polygon.getLatLngs()[0] as L.LatLng[]).map(p => [p.lat, p.lng])

    for (const sector of this.sectors) {
      if (!sector.displayLat || !sector.displayLng) continue

      const latlng = L.latLng(sector.displayLat, sector.displayLng)
      if (bounds.contains(latlng)) {
        if (this._isPointInPolygon([sector.displayLat, sector.displayLng], points)) {
          results.push(sector)
        }
      }
    }

    return results
  }

  /**
   * 获取扇区总数
   */
  getSectorCount(): number {
    return this.sectors.length
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
   * 设置扇区标签配置
   * @param config 标签配置
   */
  setSectorLabelConfig(config: SectorLabelConfig): void {
    this.labelConfig = config
    console.log('[SectorRenderer] 设置扇区标签配置', config)
    console.log('[SectorRenderer] labelConfig更新后:', {
      content: this.labelConfig.content,
      color: this.labelConfig.color,
      fontSize: this.labelConfig.fontSize
    })

    // 强制重新创建所有标签以应用新的配置
    // 移除所有现有标签标记
    for (const [, label] of this.sectorLabels) {
      if (this.featureGroup && this.featureGroup.hasLayer(label)) {
        this.featureGroup.removeLayer(label)
      }
    }
    this.sectorLabels.clear()

    // 重新渲染以更新标签
    this._render()
  }

  /**
   * 获取标签内容根据字段类型
   * 参考SectorInfoPanel的实现，直接读取sector对象的属性
   * @param sector 扇区数据
   * @param fieldType 字段类型
   * @returns 标签内容
   */
  private _getLabelContent(sector: RenderSectorData, fieldType: LabelField): string {
    // 直接根据字段类型返回对应的值
    switch (fieldType) {
      case 'name':
        // 小区名称
        return sector.name || ''

      case 'siteId':
        // 基站ID - 直接使用siteId字段
        return sector.siteId || ''

      case 'frequency':
        // 下行频点 - 直接使用frequency字段
        if (sector.frequency) return String(sector.frequency)
        // 如果frequency为空，尝试其他字段
        if (sector.ssbFrequency) return String(sector.ssbFrequency)
        if (sector.earfcn) return String(sector.earfcn)
        return ''

      case 'pci':
        // PCI - 优先使用同步服务中的PCI值，然后使用原始pci字段
        try {
          // 尝试从同步服务获取同步后的PCI值
          const pciDataSyncService = require('../../services/pciDataSyncService').pciDataSyncService
          if (pciDataSyncService && sector.siteId && sector.sectorId) {
            const syncedSector = pciDataSyncService.findSector(sector.siteId, sector.sectorId)
            if (syncedSector && syncedSector.syncedPCI !== undefined) {
              return String(syncedSector.syncedPCI)
            }
          }
        } catch (e) {
          // 如果同步服务不可用，使用原始pci字段
          console.warn('[SectorRenderer] 获取同步PCI失败:', e)
        }
        // 使用原始pci字段作为后备
        return sector.pci !== undefined ? String(sector.pci) : ''

      case 'tac':
        // TAC - 直接使用tac字段
        return sector.tac !== undefined ? String(sector.tac) : ''

      case 'isShared':
        // 是否共享 - 直接使用is_shared字段
        return sector.is_shared || ''

      case 'coverageType':
        // 覆盖类型 - 直接使用cell_cover_type字段
        if (sector.cell_cover_type === 1) return '室外小区'
        if (sector.cell_cover_type === 4) return '室内小区'
        if (sector.cell_cover_type !== undefined) return `类型${sector.cell_cover_type}`
        return ''

      default:
        // 其他字段 - 尝试直接从sector对象读取
        const value = (sector as any)[fieldType]
        return value !== undefined && value !== null ? String(value) : ''
    }
  }

  /**
   * 检查扇区是否被选中
   * @param sectorId 扇区ID（缓存中的key）
   * @param sector 扇区数据
   * @returns 是否被选中
   */
  private _isSectorSelected(sectorId: string, sector: RenderSectorData): boolean {
    if (!this.selectionHighlightIds || this.selectionHighlightIds.size === 0) {
      return false
    }

    const sectorAny = sector as any
    const compositeId = sector.siteId && sector.sectorId ? `${sector.siteId}_${sector.sectorId}` : null

    return this.selectionHighlightIds.has(sectorId) ||
      this.selectionHighlightIds.has(String(sector.id)) ||
      (compositeId && this.selectionHighlightIds.has(compositeId)) ||
      (sector.name && this.selectionHighlightIds.has(sector.name)) ||
      (sectorAny['小区名称'] && this.selectionHighlightIds.has(String(sectorAny['小区名称']))) ||
      (sectorAny['Cell Name'] && this.selectionHighlightIds.has(String(sectorAny['Cell Name'])))
  }

  /**
   * 更新扇区样式（用于PCI/邻区高亮）
   */
  private _updateSectorStyles(): void {
    if (this.selectionHighlightIds && this.selectionHighlightIds.size > 0) {
      console.log('[SectorRenderer] _updateSectorStyles - 框选高亮模式', {
        selectionIdsCount: this.selectionHighlightIds.size,
        sectorPolygonsCount: this.sectorPolygons.size,
        siteMarkersCount: this.siteMarkers.size
      })

      const highlightPolygons: L.Polygon[] = []
      const highlightMarkers: L.CircleMarker[] = []

      for (const [sectorId, cached] of this.sectorPolygons) {
        const sector = (cached.polygon as any).sectorData as RenderSectorData
        const isSelected = this._isSectorSelected(sectorId, sector)

        console.log('[SectorRenderer] _updateSectorStyles - 检查扇区', {
          sectorId,
          isSelected
        })

        if (isSelected) {
          const colors = getSectorColor(sector)
          cached.polygon.setStyle({
            fillColor: colors.fillColor,
            color: '#ff0000',
            weight: 3,
            fillOpacity: 0.6
          })
          highlightPolygons.push(cached.polygon)
        } else {
          const colors = getSectorColor(sector)
          const config = SECTOR_CONFIG[sector.networkType]
          cached.polygon.setStyle({
            fillColor: colors.fillColor,
            color: config.strokeColor || '#000000',
            weight: config.strokeWidth || 0.5,
            fillOpacity: config.opacity
          })
        }
      }

      for (const [siteKey, cached] of this.siteMarkers) {
        const sector = (cached.marker as any).sectorData as RenderSectorData
        const isSelected = this._isSectorSelected(siteKey, sector)

        if (isSelected) {
          const colors = getSectorColor(sector)
          cached.marker.setStyle({
            fillColor: colors.fillColor,
            color: '#ff0000',
            weight: 3,
            fillOpacity: 0.6
          })
          highlightMarkers.push(cached.marker)
        } else {
          const colors = getSectorColor(sector)
          cached.marker.setStyle({
            fillColor: colors.fillColor,
            color: colors.strokeColor,
            weight: 1,
            fillOpacity: 0.8
          })
        }
      }

      for (const polygon of highlightPolygons) {
        polygon.bringToFront()
      }
      for (const marker of highlightMarkers) {
        marker.bringToFront()
      }

      return
    }

    // 邻区规划模式处理
    if (this.neighborHighlightConfig && this.renderMode === 'neighbor-planning') {
      const { sourceSectorId, targetSectorIds, sourceColor, targetColor } = this.neighborHighlightConfig

      console.log('[SectorRenderer] 应用邻区高亮', {
        sourceSectorId,
        targetCount: targetSectorIds.size,
        sourceColor,
        targetColor,
        totalSectors: this.sectorPolygons.size
      })

      // 分别收集源小区和目标小区的多边形，用于控制图层顺序
      const sourcePolygon: L.Polygon[] = []
      const targetPolygons: L.Polygon[] = []
      let visibleCount = 0

      for (const [sectorId, cached] of this.sectorPolygons) {
        if (sectorId === sourceSectorId) {
          // 源小区：红色，带黑色边框，高不透明度（与图例一致）
          cached.polygon.setStyle({
            fillColor: sourceColor || '#FF0000',  // 红色（与图例一致）
            color: '#000000',        // 黑色边框
            weight: 3,               // 加粗边框
            fillOpacity: 0.9,         // 高不透明度
            fillRule: 'evenodd'
          })
          sourcePolygon.push(cached.polygon)
          visibleCount++
          console.log('[SectorRenderer] 源小区高亮:', sectorId)
        } else if (targetSectorIds.has(sectorId)) {
          // 目标小区：蓝色，带黑色边框（与图例一致）
          cached.polygon.setStyle({
            fillColor: targetColor || '#0000FF',  // 蓝色（与图例一致）
            color: '#000000',        // 黑色边框
            weight: 2,               // 中等边框
            fillOpacity: 0.85,        // 高不透明度
            fillRule: 'evenodd'
          })
          targetPolygons.push(cached.polygon)
          visibleCount++
          console.log('[SectorRenderer] 目标小区高亮:', sectorId)
        } else {
          // 其他小区：白色填充带黑色细边框
          cached.polygon.setStyle({
            fillColor: '#FFFFFF',     // 白色填充
            color: '#000000',      // 黑色边框
            weight: 1.5,         // 细边框
            fillOpacity: 1.0,    // 不透明
            fillRule: 'evenodd'
          })
        }
      }

      console.log('[SectorRenderer] 邻区高亮应用完成', {
        visibleCount,
        sourceCount: 1,
        targetCount: targetSectorIds.size
      })

      // 控制图层顺序：
      // 1. 先将所有其他小区（透明黑边）放到最底层
      // 2. 然后将所有蓝色目标小区放到中间层
      // 3. 最后将红色源小区放到最顶层
      for (const [sectorId, cached] of this.sectorPolygons) {
        if (sectorId !== sourceSectorId && !targetSectorIds.has(sectorId)) {
          // 其他小区：放到最底层
          cached.polygon.bringToBack()
        }
      }

      // 目标小区：放到中间层（在其他小区之上）
      for (const polygon of targetPolygons) {
        polygon.bringToFront()
      }

      // 源小区：放到最顶层（在所有扇区之上）
      for (const polygon of sourcePolygon) {
        polygon.bringToFront()
      }

      return
    }

    // TAC核查模式：按TAC值分配颜色，插花小区紫色边框
    if (this.renderMode === 'tac-check') {
      console.log('[SectorRenderer] _updateSectorStyles - TAC核查模式', {
        hasTacConfig: !!this.tacHighlightConfig,
        selectedId: this.tacHighlightConfig?.selectedId,
        networkType: this.tacHighlightConfig?.networkType,
        totalPolygons: this.sectorPolygons.size,
        totalMarkers: this.siteMarkers.size
      })

      const { selectedId } = this.tacHighlightConfig || {}

      // 更新扇区多边形样式
      for (const [sectorId, cached] of this.sectorPolygons) {
        const sector = (cached.polygon as any).sectorData as RenderSectorData

        // 获取扇区的TAC值（优先使用 syncedTAC，其次使用原始 tac）
        const sectorTac = (sector as any).syncedTAC || sector.tac
        const isSectorSelected = sector.id === selectedId

        // 确定网络类型用于颜色映射
        const networkType = (this.tacHighlightConfig?.networkType || sector.networkType) as NetworkType

        if (sectorTac && networkType) {
          // 获取TAC对应的颜色
          const tacColor = tacColorMapper.getColor(String(sectorTac), networkType)
          cached.polygon.setStyle({
            fillColor: tacColor.color,
            color: isSectorSelected ? '#FF0000' : tacColor.strokeColor,
            weight: isSectorSelected ? 6 : 1.5,
            fillOpacity: isSectorSelected ? 1.0 : 0.85
          })
        } else {
          // 无TAC值的小区：灰色
          cached.polygon.setStyle({
            fillColor: '#E5E7EB',
            color: isSectorSelected ? '#FF0000' : '#9CA3AF',
            weight: isSectorSelected ? 6 : 1.5,
            fillOpacity: 0.8
          })
        }

        // 插花小区特殊处理：紫色边框
        if ((sector as any).isSingularity) {
          cached.polygon.setStyle({
            color: '#A855F7',  // 紫色边框
            weight: 2.5
          })
        }
      }

      // 更新站点圆点样式
      for (const [siteKey, cached] of this.siteMarkers) {
        const sector = (cached.marker as any).sectorData as RenderSectorData

        // 获取扇区的TAC值
        const sectorTac = (sector as any).syncedTAC || sector.tac
        const isSectorSelected = sector.id === selectedId
        const networkType = (this.tacHighlightConfig?.networkType || sector.networkType) as NetworkType

        if (sectorTac && networkType) {
          const tacColor = tacColorMapper.getColor(String(sectorTac), networkType)
          cached.marker.setStyle({
            fillColor: tacColor.color,
            color: isSectorSelected ? '#FF0000' : tacColor.strokeColor,
            weight: isSectorSelected ? 8 : 3,
            fillOpacity: isSectorSelected ? 1.0 : 0.85
          })
        } else {
          cached.marker.setStyle({
            fillColor: '#E5E7EB',
            color: isSectorSelected ? '#FF0000' : '#9CA3AF',
            weight: isSectorSelected ? 8 : 3,
            fillOpacity: 0.8
          })
        }

        // 插花小区特殊处理
        if ((sector as any).isSingularity) {
          cached.marker.setStyle({
            color: '#A855F7',
            weight: 5
          })
        }
      }

      console.log('[SectorRenderer] TAC核查模式样式更新完成')
      return
    }

    // 默认/其他模式：清除高亮，恢复基础样式，但需保留框选高亮
    if (!this.pciHighlightConfig && !this.neighborHighlightConfig) {
      const highlightPolygons: L.Polygon[] = []
      const highlightMarkers: L.CircleMarker[] = []

      for (const [sectorId, cached] of this.sectorPolygons) {
        const sector = (cached.polygon as any).sectorData as RenderSectorData
        const isSelected = this.selectionHighlightIds?.has(sectorId) ||
          (sector.siteId && sector.sectorId && this.selectionHighlightIds?.has(`${sector.siteId}_${sector.sectorId}`)) ||
          (sector.name && this.selectionHighlightIds?.has(sector.name))

        if (isSelected) {
          const colors = getSectorColor(sector)
          cached.polygon.setStyle({
            fillColor: colors.fillColor,
            color: '#ef4444', // 红色高亮边框
            weight: 3,
            fillOpacity: 0.9
          })
          highlightPolygons.push(cached.polygon)
        } else if (this.renderMode === 'pci-planning') {
          // PCI模式：检查是否在白名单中
          const isInWhitelist = this.sectorIdWhitelist ? this.sectorIdWhitelist.has(sectorId) : false
          if (isInWhitelist) {
            const colors = getSectorColor(sector)
            const config = SECTOR_CONFIG[sector.networkType]
            cached.polygon.setStyle({
              fillColor: colors.fillColor,
              color: config.strokeColor || '#000000',
              weight: config.strokeWidth || 0.5,
              fillOpacity: config.opacity
            })
          } else {
            cached.polygon.setStyle({
              fillColor: '#FFFFFF', color: '#000000', weight: 1.5, fillOpacity: 1.0
            })
          }
        } else if (this.renderMode === 'neighbor-planning') {
          cached.polygon.setStyle({
            fillColor: '#FFFFFF', color: '#000000', weight: 1.5, fillOpacity: 1.0
          })
        } else {
          // 默认模式
          const colors = getSectorColor(sector)
          const config = SECTOR_CONFIG[sector.networkType]
          cached.polygon.setStyle({
            fillColor: colors.fillColor,
            color: config.strokeColor || '#000000',
            weight: config.strokeWidth || 0.5,
            fillOpacity: config.opacity
          })
        }
      }

      for (const [siteKey, cached] of this.siteMarkers) {
        const sector = (cached.marker as any).sectorData as RenderSectorData
        const isSelected = this.selectionHighlightIds?.has(sector.id) ||
          (sector.siteId && sector.sectorId && this.selectionHighlightIds?.has(`${sector.siteId}_${sector.sectorId}`)) ||
          (sector.name && this.selectionHighlightIds?.has(sector.name))

        if (isSelected) {
          const colors = getSectorColor(sector)
          cached.marker.setStyle({
            fillColor: colors.fillColor,
            color: '#ef4444', // 红色高亮边框
            weight: 3,
            fillOpacity: 1
          })
          highlightMarkers.push(cached.marker)
        } else if (this.renderMode === 'pci-planning') {
          const isInWhitelist = this.sectorIdWhitelist ? this.sectorIdWhitelist.has(sector.id) : false
          if (isInWhitelist) {
            const colors = getSectorColor(sector)
            cached.marker.setStyle({
              fillColor: colors.fillColor,
              color: colors.strokeColor,
              weight: 1,
              fillOpacity: 0.8
            })
          } else {
            cached.marker.setStyle({
              fillColor: '#FFFFFF', color: '#000000', weight: 1.5, fillOpacity: 1.0
            })
          }
        } else {
          const colors = getSectorColor(sector)
          cached.marker.setStyle({
            fillColor: colors.fillColor,
            color: colors.strokeColor,
            weight: 1,
            fillOpacity: 0.8
          })
        }
      }

      for (const polygon of highlightPolygons) { polygon.bringToFront() }
      for (const marker of highlightMarkers) { marker.bringToFront() }
      return
    }

    // 应用高亮样式
    if (!this.pciHighlightConfig) return
    const { selectedId, relatedIds } = this.pciHighlightConfig
    const relatedIdsSet = new Set(relatedIds)

    // 数据验证：检查渲染数据中是否存在 relatedIds 指向的扇区
    const renderedSectorIds = new Set<string>()
    for (const [sectorId, cached] of this.sectorPolygons) {
      renderedSectorIds.add(sectorId)
    }
    for (const [siteKey, cached] of this.siteMarkers) {
      renderedSectorIds.add(siteKey)
    }

    // 找出缺失的 relatedIds（这些扇区在渲染数据中不存在）
    const missingRelatedIds = relatedIds.filter(id => !renderedSectorIds.has(id))

    // 检查渲染模式
    console.log('[SectorRenderer] 应用PCI高亮 - 配置检查', {
      renderMode: this.renderMode,
      hasHighlightConfig: !!this.pciHighlightConfig,
      totalPolygons: this.sectorPolygons.size,
      totalMarkers: this.siteMarkers.size,
      totalRenderedSectors: renderedSectorIds.size,
      relatedIdsCount: relatedIds.length,
      relatedIdsInData: relatedIds.filter(id => renderedSectorIds.has(id)).length,
      missingRelatedIds: missingRelatedIds.length,
      missingRelatedIdsSample: missingRelatedIds.slice(0, 5)
    })

    console.log('[SectorRenderer] 应用PCI高亮', {
      selectedId,
      selectedIdInRendered: renderedSectorIds.has(selectedId || ''),
      relatedCount: relatedIds.length,
      relatedInDataCount: relatedIds.filter(id => renderedSectorIds.has(id)).length,
      totalPolygons: this.sectorPolygons.size,
      renderMode: this.renderMode,
      samplePolygonIds: Array.from(this.sectorPolygons.keys()).slice(0, 10)
    })

    // 更新扇区多边形样式
    let selectedCount = 0
    let relatedCount = 0
    let otherCount = 0

    // 收集需要提升到最顶层的扇区
    const highlightPolygons: L.Polygon[] = []

    for (const [sectorId, cached] of this.sectorPolygons) {
      const sector = (cached.polygon as any).sectorData as RenderSectorData

      // 增强匹配逻辑：支持 ID、站点-小区复合ID、小区名称匹配 (满足需求5)
      // 修复：使用下划线而不是短横线，与后端ID生成逻辑一致
      const isSelected = this.selectionHighlightIds?.has(sectorId) ||
        (sector.siteId && sector.sectorId && this.selectionHighlightIds?.has(`${sector.siteId}_${sector.sectorId}`)) ||
        (sector.name && this.selectionHighlightIds?.has(sector.name))

      if (sectorId === selectedId) {
        // 选中的扇区：不透明红色，高对比度
        selectedCount++
        cached.polygon.setStyle({
          fillColor: '#ff0000',  // 更亮的红色
          color: isSelected ? '#ef4444' : '#cc0000',  // 如果被框选，显示红色边框
          weight: isSelected ? 5 : 6,  // 更粗的边框
          fillOpacity: 1
        })
        highlightPolygons.push(cached.polygon)
      } else if (relatedIdsSet.has(sectorId)) {
        // 同频同PCI的扇区：不透明蓝色，高对比度
        relatedCount++
        cached.polygon.setStyle({
          fillColor: '#0066ff',  // 更亮的蓝色
          color: isSelected ? '#ef4444' : '#0044cc',
          weight: isSelected ? 5 : 6,
          fillOpacity: 1
        })
        highlightPolygons.push(cached.polygon)
      } else if (isSelected) {
        // 仅被框选的高亮：保持原色但加红色边框
        const colors = getSectorColor(sector)
        cached.polygon.setStyle({
          fillColor: colors.fillColor,
          color: '#ef4444', // 红色高亮边框
          weight: 3,
          fillOpacity: 0.9
        })
        highlightPolygons.push(cached.polygon)
      } else {
        // 其他扇区：根据渲染模式选择默认样式
        if (this.renderMode === 'pci-planning' || this.renderMode === 'neighbor-planning') {
          // PCI/邻区规划模式：白色填充带黑色细边框
          cached.polygon.setStyle({
            fillColor: '#FFFFFF',
            color: '#000000',
            weight: 1.5,
            fillOpacity: 1.0
          })
        } else {
          // 默认模式：彩色
          const colors = getSectorColor(sector)
          const config = SECTOR_CONFIG[sector.networkType]
          cached.polygon.setStyle({
            fillColor: colors.fillColor,
            color: config.strokeColor || '#000000',
            weight: config.strokeWidth || 0.5,
            fillOpacity: config.opacity
          })
        }
      }
    }

    console.log('[SectorRenderer] PCI高亮应用完成', {
      selectedCount,
      relatedCount,
      otherCount,
      totalProcessed: selectedCount + relatedCount + otherCount
    })

    // 将所有高亮扇区提升到最顶层（在样式更新完成后）
    for (const polygon of highlightPolygons) {
      polygon.bringToFront()
    }

    // 更新站点圆点样式
    for (const [siteKey, cached] of this.siteMarkers) {
      const sector = (cached.marker as any).sectorData as RenderSectorData
      const sectorId = sector.id

      // 增强匹配逻辑 (满足需求5)
      // 修复：使用下划线而不是短横线，与后端ID生成逻辑一致
      const isSelected = this.selectionHighlightIds?.has(sectorId) ||
        (sector.siteId && sector.sectorId && this.selectionHighlightIds?.has(`${sector.siteId}_${sector.sectorId}`)) ||
        (sector.name && this.selectionHighlightIds?.has(sector.name))

      if (sectorId === selectedId) {
        // 选中的扇区：不透明红色，高对比度
        cached.marker.setStyle({
          fillColor: '#ff0000',  // 更亮的红色
          color: isSelected ? '#ef4444' : '#cc0000',
          weight: isSelected ? 5 : 6,
          fillOpacity: 1
        })
      } else if (relatedIdsSet.has(sectorId)) {
        // 同频同PCI的扇区：不透明蓝色，高对比度
        cached.marker.setStyle({
          fillColor: '#0066ff',  // 更亮的蓝色
          color: isSelected ? '#ef4444' : '#0044cc',
          weight: isSelected ? 5 : 6,
          fillOpacity: 1
        })
      } else if (isSelected) {
        const colors = getSectorColor(sector)
        cached.marker.setStyle({
          fillColor: colors.fillColor,
          color: '#ef4444', // 红色高亮边框
          weight: 3,
          fillOpacity: 1
        })
      } else {
        // 其他扇区：根据渲染模式选择默认样式
        if (this.renderMode === 'pci-planning') {
          // PCI模式：白色填充带黑色细边框
          cached.marker.setStyle({
            fillColor: '#FFFFFF',
            color: '#000000',
            weight: 1.5,
            fillOpacity: 1.0
          })
        } else {
          // 默认模式：彩色
          const colors = getSectorColor(sector)
          cached.marker.setStyle({
            fillColor: colors.fillColor,
            color: colors.strokeColor,
            weight: 1,
            fillOpacity: 0.8
          })
        }
      }
    }
  }

  /**
   * 判断是否应该使用站点圆点模式
   * Zoom <= 9：远景模式，显示圆点
   * Zoom > 9：细节模式，显示全部扇区
   */
  private _shouldUseSiteMarkerMode(): boolean {
    return this.currentZoom <= 9
  }

  /**
   * 根据缩放级别计算弧线点数
   * 优化策略：平衡性能和视觉效果
   * PCI模式：使用更少的点数以提升性能
   * 默认模式：
   * - Zoom 10-12: 低细节（刚切换到扇区模式）
   * - Zoom 13-15: 中等细节
   * - Zoom 16+: 高细节
   */
  private _getArcPointsCount(zoom: number): number {
    if (this.renderMode === 'pci-planning') {
      // PCI模式：大幅减少点数以提升性能
      if (zoom <= 12) return 6     // 低缩放：6点（三角形）
      if (zoom <= 15) return 8     // 中缩放：8点
      return 10                    // 高缩放：10点
    }
    // 默认模式：正常细节
    if (zoom <= 12) return 12     // 低缩放：12点
    if (zoom <= 15) return 20     // 中缩放：20点
    if (zoom <= 17) return 30     // 高缩放：30点
    return 40                     // 超高缩放：40点
  }

  /**
   * 根据缩放级别计算圆形点数
   */
  private _getCirclePointsCount(zoom: number): number {
    if (this.renderMode === 'pci-planning') {
      // PCI模式：减少圆形点数
      return 8
    }
    // 默认模式：正常点数
    if (zoom <= 12) return 20     // 低缩放：20点
    if (zoom <= 15) return 32     // 中缩放：32点
    if (zoom <= 17) return 48     // 高缩放：48点
    return 64                     // 超高缩放：64点
  }

  /**
   * 处理缩放事件：使用 requestAnimationFrame 节流
   */
  private _onZoom(): void {
    if (this._animRequestId !== null) return

    this._animRequestId = L.Util.requestAnimFrame(() => {
      this._updateSectorShapes()
      this._animRequestId = null
    }, this)
  }

  /**
   * 计算当前缩放级别下的扇区物理半径（米）
   * 策略：保持扇区的**视觉像素大小恒定**，无论地图如何缩放
   * 这样用户在缩放地图时，扇区看起来大小"不变"
   */
  private _calculateRadius(zoom: number, centerLat: number = 39.9): number {
    // 目标：室外扇区在屏幕上保持约 16 像素的半径
    // 室内扇区在屏幕上保持约 8 像素的半径（在户外扇区大小的一半）
    const TARGET_PIXEL_RADIUS_OUTDOOR = 16

    // 在Web Mercator投影中，每像素代表的米数公式：
    // metersPerPixel = 156543.03392 * Math.cos(lat * π/180) / 2^zoom
    // 其中 156543.03392 是赤道在zoom 0时的米/像素
    const METERS_PER_PIXEL_AT_EQUATOR_ZOOM_0 = 156543.03392
    const latRad = centerLat * Math.PI / 180
    const metersPerPixel = METERS_PER_PIXEL_AT_EQUATOR_ZOOM_0 * Math.cos(latRad) / Math.pow(2, zoom)

    // 物理半径 = 目标像素半径 × 每像素米数
    const physicalRadius = TARGET_PIXEL_RADIUS_OUTDOOR * metersPerPixel

    // 设置合理的上下限，避免极端情况
    // 最小5米（避免过小），最大5000米（避免过大影响性能）
    return Math.max(5, Math.min(5000, physicalRadius))
  }

  /**
   * 缩放过程中实时更新扇区形状（优化版）
   *
   * 🔧 修复：同时更新 CircleMarker（siteMarkers）的投影位置，
   * 解决缩放动画后圆形标记与地图位置错位的问题。
   * L.CircleMarker 在 Leaflet 缩放动画后不会自动重投影，
   * 需要手动调用 redraw() 强制更新。
   */
  private _updateSectorShapes(): void {
    if (!this.mapInstance) return

    const currentZoom = this.mapInstance.getZoom()
    const mapCenter = this.mapInstance.getCenter()
    const outdoorRadius = this._calculateRadius(currentZoom, mapCenter.lat)
    const indoorRadius = outdoorRadius / 2

    // 遍历所有已渲染的扇区多边形并更新形状
    for (const [sectorId, cached] of this.sectorPolygons) {
      const polygon = cached.polygon
      const sector = (polygon as any).sectorData as RenderSectorData
      if (!sector) continue

      const coverStyle = getCellCoverStyle(sector.cell_cover_type, sector.networkType)
      let radius = coverStyle.isCircular ? indoorRadius : outdoorRadius

      // 邻区高亮模式：为源小区和目标小区使用更大的半径（放大1.15倍）
      if (this.neighborHighlightConfig && this.renderMode === 'neighbor-planning') {
        const { sourceSectorId, targetSectorIds } = this.neighborHighlightConfig
        if (sectorId === sourceSectorId || targetSectorIds.has(sectorId)) {
          radius = radius * 1.15  // 放大15%，覆盖初始扇区的黑边框
        }
      }

      const newLatLngs = this._generateSectorLatLngs(sector, radius)
      polygon.setLatLngs(newLatLngs)

      // 更新缩放级别
      cached.zoom = currentZoom
    }

    // 🔧 修复：同步更新 CircleMarker 的缩放级别并强制重绘
    // CircleMarker 在缩放动画后投影位置可能不正确，需要 redraw()
    for (const cached of this.siteMarkers.values()) {
      cached.zoom = currentZoom
      // 强制重绘 CircleMarker，使其重新计算投影坐标
      if (typeof cached.marker.redraw === 'function') {
        cached.marker.redraw()
      }
    }

    // 缩放过程中保持高亮样式
    if (this.selectionHighlightIds && this.selectionHighlightIds.size > 0) {
      this._updateSectorStyles()
    }
  }

  /**
   * 生成扇区坐标点数组
   */
  private _generateSectorLatLngs(sector: RenderSectorData, radius: number): L.LatLngExpression[] {
    const coverStyle = getCellCoverStyle(sector.cell_cover_type, sector.networkType)
    const centerLatLng = L.latLng(sector.displayLat, sector.displayLng)

    if (coverStyle.isCircular) {
      const points = this._generateCirclePoints(centerLatLng, radius)
      // 仅在首次渲染时记录（避免日志过多）
      if (!this.sectorPolygons.has(String(sector.id))) {
        console.log(`[SectorRenderer] 圆形点数: ${points.length}, Zoom: ${this.currentZoom}`)
      }
      return points
    } else {
      // 使用 sector.beamwidth 作为扇形夹角，如果未提供则使用配置的默认值
      const beamwidth = sector.beamwidth || coverStyle.angle
      const halfAngle = beamwidth / 2
      const startAzimuth = sector.azimuth - halfAngle
      const endAzimuth = sector.azimuth + halfAngle

      const startPointLatLng = this._fastDestination(centerLatLng, startAzimuth, radius)
      const endPointLatLng = this._fastDestination(centerLatLng, endAzimuth, radius)

      const arcPoints = this._generateArcPoints(centerLatLng, startAzimuth, endAzimuth, radius)

      // 仅在首次渲染时记录
      if (!this.sectorPolygons.has(String(sector.id))) {
        const source = sector.beamwidth ? '数据' : '配置'
        console.log(`[SectorRenderer] 扇形点数: ${arcPoints.length}, 夹角: ${beamwidth}° (来源: ${source}), Zoom: ${this.currentZoom}`)
      }

      return [
        [centerLatLng.lat, centerLatLng.lng],
        [startPointLatLng.lat, startPointLatLng.lng],
        ...arcPoints,
        [endPointLatLng.lat, endPointLatLng.lng],
        [centerLatLng.lat, centerLatLng.lng]
      ]
    }
  }


  /**
   * 获取可见扇区（带缓存）
   *
   * 🔥 性能优化：视口缓存 TTL 从 100ms 延长到 300ms
   * - 快速拖动地图时缓存命中率提升
   * - 减少重复计算
   * - 预期性能提升：20-30%
   */
  private _getVisibleSectors(paddedBounds: L.LatLngBounds): RenderSectorData[] {
    const boundsKey = `${paddedBounds.toBBoxString()}-${this.currentZoom}`
    const now = Date.now()

    // 检查缓存（300ms 内有效，从 100ms 延长以提升快速拖动时的性能）
    if (this.visibleSectorsCache &&
      this.visibleSectorsCache.boundsKey === boundsKey &&
      now - this.visibleSectorsCache.timestamp < 300) {
      return this.visibleSectorsCache.sectors
    }

    // 筛选可见扇区
    const visibleSectors = this.sectors.filter(sector => {
      if (!sector.displayLat || !sector.displayLng) return false
      return paddedBounds.contains([sector.displayLat, sector.displayLng])
    })

    // 更新缓存
    this.visibleSectorsCache = {
      boundsKey,
      sectors: visibleSectors,
      timestamp: now
    }

    return visibleSectors
  }

  /**
   * 延迟清理不可见的扇区（避免快速移动时频繁创建/销毁）
   */
  private _scheduleCleanup(): void {
    if (this.cleanupTimer !== null) {
      return // 已有定时器在运行
    }

    this.cleanupTimer = window.setTimeout(() => {
      this._cleanupInvisibleSectors()
      this.cleanupTimer = null
    }, 2000) // 2秒后清理
  }

  /**
   * 清理不可见的扇区
   */
  private _cleanupInvisibleSectors(): void {
    if (!this.mapInstance) return

    const now = Date.now()
    const bounds = this.mapInstance.getBounds()
    const latBuffer = (bounds.getNorth() - bounds.getSouth()) * 0.2
    const lngBuffer = (bounds.getEast() - bounds.getWest()) * 0.2
    const paddedBounds = L.latLngBounds(
      [bounds.getSouth() - latBuffer, bounds.getWest() - lngBuffer],
      [bounds.getNorth() + latBuffer, bounds.getEast() + lngBuffer]
    )

    const visibleSectorIds = new Set<string>()

    if (this._shouldUseSiteMarkerMode()) {
      for (const sector of this.sectors) {
        if (!sector.displayLat || !sector.displayLng) continue
        if (paddedBounds.contains([sector.displayLat, sector.displayLng])) {
          visibleSectorIds.add(sector.id)
        }
      }
    } else {
      const visibleSectors = this._getVisibleSectors(paddedBounds)
      for (const sector of visibleSectors) {
        visibleSectorIds.add(sector.id)
      }
    }

    let cleanedPolygons = 0
    for (const [sectorId, cached] of this.sectorPolygons) {
      const sector = (cached.polygon as any).sectorData as RenderSectorData
      const isSelectionHighlighted = this._isSectorSelected(sectorId, sector)

      if (!visibleSectorIds.has(sectorId) && !isSelectionHighlighted && now - cached.lastUsed > 2000) {
        if (this.featureGroup && this.featureGroup.hasLayer(cached.polygon)) {
          this.featureGroup.removeLayer(cached.polygon)
        }
        this.sectorPolygons.delete(sectorId)
        cleanedPolygons++
      }
    }

    let cleanedMarkers = 0
    for (const [sectorId, cached] of this.siteMarkers) {
      const sector = (cached.marker as any).sectorData as RenderSectorData
      const isSelectionHighlighted = this._isSectorSelected(sectorId, sector)

      if (!visibleSectorIds.has(sectorId) && !isSelectionHighlighted && now - cached.lastUsed > 2000) {
        if (this.featureGroup && this.featureGroup.hasLayer(cached.marker)) {
          this.featureGroup.removeLayer(cached.marker)
        }
        this.siteMarkers.delete(sectorId)
        cleanedMarkers++
      }
    }
  }

  /**
   * 优化的渲染方法 - 只更新变化的扇区
   */
  private _render(): void {
    if (!this.mapInstance || !this.featureGroup) return

    const startTime = performance.now()
    const currentZoom = this.mapInstance.getZoom()
    const zoomChanged = currentZoom !== this.currentZoom
    this.currentZoom = currentZoom

    // 检查是否有选中的扇区需要保留高亮显示
    const hasSelectionHighlight = this.selectionHighlightIds && this.selectionHighlightIds.size > 0
    const selectedSectorIds = hasSelectionHighlight ? new Set<string>() : null

    if (currentZoom <= 6) {
      // 即使在低缩放级别，也要保留选中的扇区用于高亮显示
      if (selectedSectorIds && this.sectors.length > 0) {
        // 收集需要保留的选中扇区ID
        for (const sector of this.sectors) {
          const sectorId = String(sector.id)
          const compositeId = sector.siteId && sector.sectorId ? `${sector.siteId}_${sector.sectorId}` : null
          const shouldKeep = this.selectionHighlightIds?.has(sectorId) ||
            (compositeId && this.selectionHighlightIds?.has(compositeId)) ||
            (sector.name && this.selectionHighlightIds?.has(sector.name))
          if (shouldKeep) {
            selectedSectorIds.add(sectorId)
            if (compositeId) selectedSectorIds.add(compositeId)
            if (sector.name) selectedSectorIds.add(sector.name)
          }
        }
      }

      // 移除不在选中列表中的扇区
      if (this.sectorPolygons.size > 0 || this.siteMarkers.size > 0) {
        for (const [sectorId, cached] of this.sectorPolygons) {
          if (!selectedSectorIds?.has(sectorId)) {
            if (this.featureGroup.hasLayer(cached.polygon)) {
              this.featureGroup.removeLayer(cached.polygon)
            }
            this.sectorPolygons.delete(sectorId)
          }
        }

        for (const [siteKey, cached] of this.siteMarkers) {
          if (!selectedSectorIds?.has(siteKey)) {
            if (this.featureGroup.hasLayer(cached.marker)) {
              this.featureGroup.removeLayer(cached.marker)
            }
            this.siteMarkers.delete(siteKey)
          }
        }
      }

      // 如果有选中的扇区，强制渲染它们以显示高亮
      if (selectedSectorIds && selectedSectorIds.size > 0) {
        this._forceRenderSectorsById(selectedSectorIds)
      }

      // 即使在低缩放级别，如果选中了扇区仍需要更新样式
      if (hasSelectionHighlight) {
        if (this._styleUpdateRequestId !== null) {
          L.Util.cancelAnimFrame(this._styleUpdateRequestId)
        }
        this._styleUpdateRequestId = L.Util.requestAnimFrame(() => {
          this._updateSectorStyles()
          this._styleUpdateRequestId = null
        }, this)
      }

      return
    }

    const mapCenter = this.mapInstance.getCenter()
    const bounds = this.mapInstance.getBounds()
    const latBuffer = (bounds.getNorth() - bounds.getSouth()) * 0.2
    const lngBuffer = (bounds.getEast() - bounds.getWest()) * 0.2
    const paddedBounds = L.latLngBounds(
      [bounds.getSouth() - latBuffer, bounds.getWest() - lngBuffer],
      [bounds.getNorth() + latBuffer, bounds.getEast() + lngBuffer]
    )

    const now = Date.now()

    if (this._shouldUseSiteMarkerMode()) {
      this._renderSiteMarkersOptimized(currentZoom, paddedBounds, now, zoomChanged)
    } else {
      this._renderSectorsOptimized(currentZoom, mapCenter, paddedBounds, now, zoomChanged)
    }

    this._scheduleCleanup()

    const endTime = performance.now()
    const renderTime = endTime - startTime
    const renderCount = this._shouldUseSiteMarkerMode()
      ? this.siteMarkers.size
      : this.sectorPolygons.size

    if (this._isDev && (renderTime > 100 || !this._hasLoggedOnce)) {
      const mode = this._shouldUseSiteMarkerMode() ? '站点圆点' : '扇区'
      console.log(`[SectorRenderer] ${mode}模式: ${renderCount} 对象, Zoom: ${currentZoom}, 耗时: ${renderTime.toFixed(1)}ms`)
      this._hasLoggedOnce = true
    }

    if (this.pciHighlightConfig || this.neighborHighlightConfig ||
      (this.selectionHighlightIds && this.selectionHighlightIds.size > 0)) {
      if (this._styleUpdateRequestId !== null) {
        L.Util.cancelAnimFrame(this._styleUpdateRequestId)
      }
      this._styleUpdateRequestId = L.Util.requestAnimFrame(() => {
        this._updateSectorStyles()
        this._styleUpdateRequestId = null
      }, this)
    }
  }

  /**
   * 优化的站点圆点模式渲染
   */
  private _renderSiteMarkersOptimized(
    currentZoom: number,
    paddedBounds: L.LatLngBounds,
    now: number,
    _zoomChanged: boolean
  ): void {
    // 获取可见扇区（带缓存）
    const visibleSectors = this._getVisibleSectors(paddedBounds)

    // 按频点过滤扇区
    const frequencyFilteredSectors = visibleSectors.filter(sector => {
      if (!sector.frequency) return true
      const isVisible = this.frequencyVisibility.get(sector.frequency)
      // 如果频点不在映射中（undefined），默认显示；只有在映射中且值为false时才过滤
      const result = isVisible !== false
      if (this._isDev && !result && this.renderMode === 'neighbor-planning') {
        console.log('[SectorRenderer] 扇区被频点过滤', {
          sectorId: sector.id,
          frequency: sector.frequency,
          isVisible,
          frequencyVisibilitySize: this.frequencyVisibility.size
        })
      }
      return result
    })

    // 按白名单过滤扇区（如果设置了白名单）
    const whitelistFilteredSectors = this.sectorIdWhitelist
      ? frequencyFilteredSectors.filter(sector => this.sectorIdWhitelist!.has(sector.id))
      : frequencyFilteredSectors

    // 添加选中的扇区（即使不在视口内也要渲染以保持高亮）
    const sectorsToRender = [...whitelistFilteredSectors]
    if (this.selectionHighlightIds && this.selectionHighlightIds.size > 0) {
      for (const sector of this.sectors) {
        const sectorId = String(sector.id)
        const compositeId = sector.siteId && sector.sectorId ? `${sector.siteId}_${sector.sectorId}` : null
        const isSelected = this.selectionHighlightIds.has(sectorId) ||
          (compositeId && this.selectionHighlightIds.has(compositeId)) ||
          (sector.name && this.selectionHighlightIds.has(sector.name))

        if (isSelected && !sectorsToRender.includes(sector)) {
          sectorsToRender.push(sector)
        }
      }
    }

    if (this._isDev) {
      console.log(`[SectorRenderer] 圆点模式: 总扇区=${this.sectors.length}, 可见=${visibleSectors.length}, 频点过滤后=${frequencyFilteredSectors.length}, 白名单过滤后=${whitelistFilteredSectors.length}, Zoom=${currentZoom}`)
    }

    // 标记当前应该可见的扇区ID
    const currentVisibleIds = new Set<string>()

    // 添加或更新圆点标记
    for (const sector of sectorsToRender) {
      currentVisibleIds.add(sector.id)

      const cached = this.siteMarkers.get(String(sector.id))

      if (!cached || cached.zoom !== currentZoom) {
        // 需要创建新标记
        if (cached) {
          // 移除旧标记
          if (this.featureGroup && this.featureGroup.hasLayer(cached.marker)) {
            this.featureGroup.removeLayer(cached.marker)
          }
          this.siteMarkers.delete(String(sector.id))
        }

        // 创建新标记
        const marker = this._createSectorMarker(sector)
        marker.addTo(this.featureGroup!)
        this.siteMarkers.set(String(sector.id), {
          marker,
          lastUsed: now,
          zoom: currentZoom
        })
      } else {
        // 更新时间戳
        cached.lastUsed = now
      }
    }

    for (const [sectorId, cached] of this.siteMarkers) {
      const sector = (cached.marker as any).sectorData as RenderSectorData
      const isSelectionHighlighted = this._isSectorSelected(sectorId, sector)

      if (!currentVisibleIds.has(sectorId) && !isSelectionHighlighted) {
        if (this.featureGroup && this.featureGroup.hasLayer(cached.marker)) {
          this.featureGroup.removeLayer(cached.marker)
        }
        this.siteMarkers.delete(sectorId)
      }
    }
  }

  /**
   * 渲染站点圆点模式（Zoom <= 9，远景）- 保留兼容性
   */
  private _renderSiteMarkers(currentZoom: number): void {
    // 获取当前视口边界
    const bounds = this.mapInstance!.getBounds()
    const latBuffer = (bounds.getNorth() - bounds.getSouth()) * 0.2
    const lngBuffer = (bounds.getEast() - bounds.getWest()) * 0.2
    const paddedBounds = L.latLngBounds(
      [bounds.getSouth() - latBuffer, bounds.getWest() - lngBuffer],
      [bounds.getNorth() + latBuffer, bounds.getEast() + lngBuffer]
    )

    const now = Date.now()
    this._renderSiteMarkersOptimized(currentZoom, paddedBounds, now, true)
  }

  /**
   * 创建扇区圆点标记（每个扇区一个圆点）
   */
  private _createSectorMarker(sector: RenderSectorData): L.CircleMarker {
    const centerLatLng = L.latLng(sector.displayLat, sector.displayLng)

    // 计算圆点半径：5米转换为像素
    const currentZoom = this.mapInstance!.getZoom()
    const mapCenter = this.mapInstance!.getCenter()
    const metersPerPixel = 156543.03392 * Math.cos(mapCenter.lat * Math.PI / 180) / Math.pow(2, currentZoom)
    const radiusInMeters = 5
    const radiusInPixels = radiusInMeters / metersPerPixel

    // 确定圆点样式：先检查PCI高亮配置
    let fillColor: string
    let color: string
    let weight: number
    let fillOpacity: number

    // 检查是否需要应用PCI高亮样式
    const applyPCIHighlight = this.pciHighlightConfig && this.renderMode === 'pci-planning'

    if (applyPCIHighlight && this.pciHighlightConfig) {
      const { selectedId, relatedIds } = this.pciHighlightConfig
      const relatedIdsSet = new Set(relatedIds)

      if (sector.id === selectedId) {
        // 选中的扇区：不透明红色，高对比度
        fillColor = '#ef4444'
        color = '#dc2626'
        weight = 3
        fillOpacity = 1
      } else if (relatedIdsSet.has(sector.id)) {
        // 同频同PCI的扇区：不透明蓝色，高对比度
        fillColor = '#0066ff'
        color = '#2563eb'
        weight = 3
        fillOpacity = 1
      } else {
        // 其他扇区：白色填充带黑色细边框
        fillColor = '#FFFFFF'
        color = '#000000'
        weight = 1.5
        fillOpacity = 1.0
      }
    } else if (this.renderMode === 'pci-planning') {
      // PCI模式无高亮：白色填充带黑色细边框
      fillColor = '#FFFFFF'
      color = '#000000'
      weight = 1.5
      fillOpacity = 1.0
    } else if (this.renderMode === 'neighbor-planning') {
      // 邻区规划模式：白色填充带黑色细边框
      fillColor = '#FFFFFF'
      color = '#000000'
      weight = 1.5
      fillOpacity = 1.0
    } else if (this.renderMode === 'tac-check') {
      // TAC核查模式：按TAC值分配颜色，插花小区红色边框
      const { selectedId } = this.tacHighlightConfig || {}

      // 获取扇区的TAC值（优先使用 syncedTAC，其次使用原始 tac）
      const sectorTac = (sector as any).syncedTAC || sector.tac
      const isSectorSelected = sector.id === selectedId

      // 确定网络类型用于颜色映射
      const networkType = (this.tacHighlightConfig?.networkType || sector.networkType) as NetworkType

      if (sectorTac && networkType) {
        // 获取TAC对应的颜色
        const tacColor = tacColorMapper.getColor(String(sectorTac), networkType)
        fillColor = tacColor.color
        color = isSectorSelected ? '#FF0000' : tacColor.strokeColor
        weight = isSectorSelected ? 3 : 1.5
        fillOpacity = isSectorSelected ? 1.0 : 0.85
      } else {
        // 无TAC值的小区：灰色
        fillColor = '#E5E7EB'
        color = isSectorSelected ? '#FF0000' : '#9CA3AF'
        weight = isSectorSelected ? 3 : 1.5
        fillOpacity = 0.8
      }

      // 插花小区特殊处理：紫色边框
      if ((sector as any).isSingularity) {
        color = '#A855F7'  // 紫色边框
        weight = 2.5
      }
    } else if (this.selectionHighlightIds && this.selectionHighlightIds.size > 0) {
      // 选中高亮模式：应用选中样式
      const sectorId = String(sector.id)
      const compositeId = sector.siteId && sector.sectorId ? `${sector.siteId}_${sector.sectorId}` : null
      const isSelected = this.selectionHighlightIds.has(sectorId) ||
        (compositeId && this.selectionHighlightIds.has(compositeId)) ||
        (sector.name && this.selectionHighlightIds.has(sector.name))

      if (isSelected) {
        // 选中扇区：红色高亮
        const colors = getSectorColor(sector)
        fillColor = colors.fillColor
        color = '#ff0000'
        weight = 3
        fillOpacity = 0.6
      } else {
        // 默认模式：彩色（基于频点或网络类型）
        const colors = getSectorColor(sector)
        fillColor = colors.fillColor
        color = colors.strokeColor
        weight = 1
        fillOpacity = 0.8
      }
    } else {
      // 默认模式：彩色（基于频点或网络类型）
      const colors = getSectorColor(sector)
      fillColor = colors.fillColor
      color = colors.strokeColor
      weight = 1
      fillOpacity = 0.8
    }

    const marker = L.circleMarker(centerLatLng, {
      radius: Math.max(radiusInPixels, 3), // 最小3像素，确保可见
      fillColor: fillColor,
      color: color,
      weight: weight,
      opacity: 1,
      fillOpacity: fillOpacity,
      className: this.measureMode ? 'sector-marker sector-marker-measure' : 'sector-marker'
    })

    // 绑定点击事件 - 测距模式或框选模式下禁用
    marker.on('click', (e: L.LeafletMouseEvent) => {
      // 测距模式下不响应点击
      if (this.measureMode) {
        L.DomEvent.stopPropagation(e)
        return
      }
      // 点选模式下允许点击事件
      L.DomEvent.stopPropagation(e)
      e.originalEvent.preventDefault()
      this.onClick?.(sector, e)
      console.log(`[SectorRenderer] 扇区圆点被点击: ${sector.name}, ${sector.networkType}`)
    })

    // 绑定鼠标悬停事件 - 测距模式或框选模式下禁用
    marker.on('mouseover', (e: L.LeafletMouseEvent) => {
      // 测距或框选模式下不显示悬停提示
      if (this.measureMode || this.isSelectionMode) {
        return
      }
      // 使用 Leaflet 的 tooltip 显示小区名称
      const tooltipContent = `
        <div class="sector-tooltip-content">
          ${sector.name || sector.id}
        </div>
      `

      // 创建或更新 tooltip
      if (!marker.getTooltip()) {
        marker.bindTooltip(tooltipContent, {
          permanent: false,
          direction: 'top',
          offset: [0, -10],
          className: 'sector-tooltip'
        })
      } else {
        marker.setTooltipContent(tooltipContent)
      }

      marker.openTooltip()
    })

    // 绑定鼠标移出事件，隐藏 tooltip
    marker.on('mouseout', () => {
      marker.closeTooltip()
    })

      // 存储扇区数据
      ; (marker as any).sectorData = sector

    return marker
  }

  /**
   * 优化的扇区模式渲染
   */
  private _renderSectorsOptimized(
    currentZoom: number,
    mapCenter: L.LatLng,
    paddedBounds: L.LatLngBounds,
    now: number,
    _zoomChanged: boolean
  ): void {
    // 预先计算当前半径（使用地图中心纬度）
    const outdoorRadius = this._calculateRadius(currentZoom, mapCenter.lat)
    const indoorRadius = outdoorRadius / 2

    // 获取可见扇区（带缓存）
    const visibleSectors = this._getVisibleSectors(paddedBounds)

    // 按频点过滤扇区
    const frequencyFilteredSectors = visibleSectors.filter(sector => {
      if (!sector.frequency) return true
      const isVisible = this.frequencyVisibility.get(sector.frequency)
      // 如果频点不在映射中（undefined），默认显示；只有在映射中且值为false时才过滤
      return isVisible !== false
    })

    // 按白名单过滤扇区（如果设置了白名单）
    const sectorsToRender = this.sectorIdWhitelist
      ? frequencyFilteredSectors.filter(sector => this.sectorIdWhitelist!.has(sector.id))
      : frequencyFilteredSectors

    // 添加选中的扇区（即使不在视口内也要渲染以保持高亮）
    if (this.selectionHighlightIds && this.selectionHighlightIds.size > 0) {
      for (const sector of this.sectors) {
        const sectorId = String(sector.id)
        const compositeId = sector.siteId && sector.sectorId ? `${sector.siteId}_${sector.sectorId}` : null
        const isSelected = this.selectionHighlightIds.has(sectorId) ||
          (compositeId && this.selectionHighlightIds.has(compositeId)) ||
          (sector.name && this.selectionHighlightIds.has(sector.name))

        if (isSelected && !sectorsToRender.includes(sector)) {
          sectorsToRender.push(sector)
        }
      }
    }

    if (this._isDev) {
      console.log(`[SectorRenderer] 扇区模式: 总扇区=${this.sectors.length}, 可见=${visibleSectors.length}, 频点过滤后=${frequencyFilteredSectors.length}, 白名单过滤后=${sectorsToRender.length}, Zoom=${currentZoom}`)
    }

    // 按物理位置（经纬度）分组扇区 - 同一位置的扇区只显示部分标签
    const locationGroups = this._groupSectorsByLocation(sectorsToRender)

    // 获取当前zoom级别下每个位置最多显示的标签数
    const maxLabelsPerLocation = this._getMaxLabelsPerLocation()

    // 标签碰撞检测优化：使用屏幕坐标网格分桶，避免 O(n^2) 的全量遍历
    // gridSize 越大越保守（更少标签），越小越激进（更易重叠）
    const fontSize = this.labelConfig.fontSize || 12
    const gridSize = Math.max(8, fontSize * 6)
    const occupiedGrid = new Set<string>()

    const markOccupied = (latLng: L.LatLng) => {
      if (!this.mapInstance) return
      const p = this.mapInstance.latLngToContainerPoint(latLng)
      const gx = Math.floor(p.x / gridSize)
      const gy = Math.floor(p.y / gridSize)
      occupiedGrid.add(`${gx},${gy}`)
    }

    const isGridOccupied = (latLng: L.LatLng) => {
      if (!this.mapInstance) return false
      const p = this.mapInstance.latLngToContainerPoint(latLng)
      const gx = Math.floor(p.x / gridSize)
      const gy = Math.floor(p.y / gridSize)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (occupiedGrid.has(`${gx + dx},${gy + dy}`)) return true
        }
      }
      return false
    }

    // 先把本轮“已存在且仍在地图上”的标签占位写入网格
    for (const [, label] of this.sectorLabels) {
      if (this.featureGroup && this.featureGroup.hasLayer(label)) {
        markOccupied(label.getLatLng())
      }
    }

    // 标记当前应该可见的扇区ID
    const currentVisibleIds = new Set<string>()

    let renderedCount = 0
    // 渲染每个位置组内的扇区，处理同一位置多扇区标签显示问题
    for (const [, locationSectors] of locationGroups.entries()) {
      locationSectors.sort((a, b) => {
        const aId = a.sectorId || ''
        const bId = b.sectorId || ''
        return aId.localeCompare(bId)
      })

      for (let i = 0; i < locationSectors.length; i++) {
        const sector = locationSectors[i]
        const coverStyle = getCellCoverStyle(sector.cell_cover_type, sector.networkType)
        let radius = coverStyle.isCircular ? indoorRadius : outdoorRadius

        // 邻区高亮模式：为源小区和目标小区使用更大的半径（放大1.15倍）
        if (this.neighborHighlightConfig && this.renderMode === 'neighbor-planning') {
          const { sourceSectorId, targetSectorIds } = this.neighborHighlightConfig
          if (sector.id === sourceSectorId || targetSectorIds.has(sector.id)) {
            radius = radius * 1.15  // 放大15%，覆盖初始扇区的黑边框
          }
        }

        currentVisibleIds.add(sector.id)

        const cached = this.sectorPolygons.get(String(sector.id))

        // 检查是否需要创建或更新多边形
        if (!cached || cached.zoom !== currentZoom || _zoomChanged) {
          // 需要创建新多边形
          if (cached) {
            // 移除旧多边形
            if (this.featureGroup && this.featureGroup.hasLayer(cached.polygon)) {
              this.featureGroup.removeLayer(cached.polygon)
            }
            this.sectorPolygons.delete(String(sector.id))
          }

          // 创建新多边形
          const polygon = this._createSectorPolygon(sector, radius)
          polygon.addTo(this.featureGroup!)
          this.sectorPolygons.set(String(sector.id), {
            polygon,
            lastUsed: now,
            zoom: currentZoom
          })
          renderedCount++
        } else {
          // 更新时间戳
          cached.lastUsed = now
        }

        // 处理标签
        // 检查是否应该显示标签：
        // 1. 全局标签开关开启 (this.showLabels)
        // 2. PCI模式标签开关开启 (this.sectorLabelsEnabled)
        const shouldShowLabel = this.showLabels || this.sectorLabelsEnabled

        // 临时调试日志：只记录特定频点的扇区（仅开发环境）
        if (this._isDev && (sector.frequency === 100 || sector.frequency === 200)) {
          console.log('[SectorRendererSVG] Label check:', {
            sectorName: sector.name,
            sectorFrequency: sector.frequency,
            shouldShowLabel,
            showLabels: this.showLabels,
            sectorLabelsEnabled: this.sectorLabelsEnabled
          })
        }

        if (shouldShowLabel) {
          // 动态计算当前zoom下可以显示的标签数量
          // 优化策略：更保守的标签显示，避免重叠
          // zoom < 14: 只显示1个标签
          // zoom 14-15: 显示2个标签
          // zoom 16-17: 显示3个标签
          // zoom >= 18: 显示更多标签但仍控制上限
          const maxLabelsPerLocation = this._getMaxLabelsPerLocation()

          // 如果扇区数量小于允许的最大值，则全部显示
          if (i < maxLabelsPerLocation) {
            // 创建临时标签以获取位置
            const tempLabel = this._createSectorLabel(sector, i, locationSectors.length, false)
            const isOverlapping = isGridOccupied(tempLabel.getLatLng())

            if (!isOverlapping) {
              // 不重叠，显示标签
              // 检查是否需要重新创建标签
              const existingLabel = this.sectorLabels.get(String(sector.id))
              if (existingLabel) {
                if (this.featureGroup && this.featureGroup.hasLayer(existingLabel)) {
                  this.featureGroup.removeLayer(existingLabel)
                }
                this.sectorLabels.delete(String(sector.id))
              }

              // 添加标签到地图
              tempLabel.addTo(this.featureGroup!)
              this.sectorLabels.set(String(sector.id), tempLabel)
              markOccupied(tempLabel.getLatLng())
            } else {
              // 重叠，隐藏标签
              const existingLabel = this.sectorLabels.get(String(sector.id))
              if (existingLabel) {
                if (this.featureGroup && this.featureGroup.hasLayer(existingLabel)) {
                  this.featureGroup.removeLayer(existingLabel)
                }
                this.sectorLabels.delete(String(sector.id))
              }
            }
          } else {
            // 超出限制的标签，清理已存在的
            const label = this.sectorLabels.get(String(sector.id))
            if (label && this.featureGroup && this.featureGroup.hasLayer(label)) {
              this.featureGroup.removeLayer(label)
            }
            this.sectorLabels.delete(String(sector.id))
          }
        } else {
          // 清理标签
          const label = this.sectorLabels.get(String(sector.id))
          if (label && this.featureGroup && this.featureGroup.hasLayer(label)) {
            this.featureGroup.removeLayer(label)
          }
          this.sectorLabels.delete(String(sector.id))
        }
      }
    }

    for (const [sectorId, cached] of this.sectorPolygons) {
      const sector = (cached.polygon as any).sectorData as RenderSectorData
      const isSelectionHighlighted = this._isSectorSelected(sectorId, sector)

      if (!currentVisibleIds.has(sectorId) && !isSelectionHighlighted) {
        if (this.featureGroup && this.featureGroup.hasLayer(cached.polygon)) {
          this.featureGroup.removeLayer(cached.polygon)
        }
        this.sectorPolygons.delete(sectorId)
      }
    }

    // 清理不再需要显示的标签（针对那些不可见的扇区）
    for (const [sectorId, label] of this.sectorLabels) {
      if (!currentVisibleIds.has(sectorId)) {
        if (this.featureGroup && this.featureGroup.hasLayer(label)) {
          this.featureGroup.removeLayer(label)
        }
        this.sectorLabels.delete(sectorId)
      }
    }
  }

  /**
   * 按地理位置分组扇区
   * key: "lat,lng", value: sector[]
   */
  private _groupSectorsByLocation(sectors: RenderSectorData[]): Map<string, RenderSectorData[]> {
    const groups = new Map<string, RenderSectorData[]>()
    const precision = 5 // 坐标精度，约1米

    for (const sector of sectors) {
      if (!sector.displayLat || !sector.displayLng) continue
      const key = `${sector.displayLat.toFixed(precision)},${sector.displayLng.toFixed(precision)}`
      if (!groups.has(key)) {
        groups.set(key, [])
      }
      groups.get(key)!.push(sector)
    }
    return groups
  }

  /**
   * 获取当前zoom级别下每个位置最多显示的标签数
   * 优化策略：更激进的标签显示，避免重叠
   * 当zoom < 14: 只显示1个标签
   * zoom 14-15: 显示2个标签
   * zoom 16-17: 显示3个标签
   * zoom 18-19: 显示5个标签
   * zoom >= 20: 显示8个标签（仍然控制上限，避免过于密集）
   */
  private _getMaxLabelsPerLocation(): number {
    const zoom = this.currentZoom

    if (zoom < 14) return 1      // 低zoom：只显示1个
    if (zoom < 16) return 2      // 中低zoom：显示2个
    if (zoom < 18) return 3      // 中zoom：显示3个
    if (zoom < 20) return 5      // 中高zoom：显示5个
    return 8                     // 高zoom：最多显示8个，仍然控制上限
  }

  /**
   * 检测标签是否与已显示的标签重叠
   * @param labelPos 标签位置
   * @param occupiedPositions 已占用的标签位置集合
   * @param minDistance 最小间距（像素）
   * @returns 是否重叠
   */
  private _isLabelOverlapping(
    labelPos: L.LatLng,
    occupiedPositions: L.LatLng[],
    minDistance: number
  ): boolean {
    if (!this.mapInstance) return false

    for (const occupiedPos of occupiedPositions) {
      // 将LatLng转换为屏幕像素坐标
      const labelPoint = this.mapInstance.latLngToContainerPoint(labelPos)
      const occupiedPoint = this.mapInstance.latLngToContainerPoint(occupiedPos)

      // 计算两点之间的像素距离
      const distance = Math.sqrt(
        Math.pow(labelPoint.x - occupiedPoint.x, 2) +
        Math.pow(labelPoint.y - occupiedPoint.y, 2)
      )

      if (distance < minDistance) {
        return true  // 重叠
      }
    }

    return false  // 不重叠
  }

  /**
   * 创建扇区标签
   * @param sector 扇区数据
   * @param index 同一位置的扇区索引
   * @param totalSectors 同一位置的总扇区数
   * @param isAggregated 是否是聚合标签（低zoom模式）
   */
  private _createSectorLabel(sector: RenderSectorData, index: number, totalSectors: number, isAggregated: boolean = false): L.Marker {
    // 获取标签内容
    let content = ''
    if (this.pciHighlightConfig && this.renderMode === 'pci-planning') {
      // PCI模式：显示 小区名称 + PCI（优先使用规划后的PCI）
      content = `${sector.name || ''} (PCI: ${this._getLabelContent(sector, 'pci') || '-'})`
    } else {
      // 默认模式：根据配置获取
      // 如果是聚合标签(isAggregated=true)，优先显示站点名称
      if (isAggregated) {
        // 尝试获取站点名称，如果没有则回退到配置内容
        // 通常站点名称在 sector.siteName 或者 sector.name 中包含
        // 这里简单使用配置内容，但在样式上可能有所不同
        content = this._getLabelContent(sector, this.labelConfig.content)
        // 如果配置是显示小区名，但在聚合模式下可能想显示基站名？
        // 暂时保持一致，用户配置什么显示什么
      } else {
        content = this._getLabelContent(sector, this.labelConfig.content)
      }
    }

    // 计算标签位置 - 扇区中间对齐
    // 标签位于扇区中心（基站位置），通过CSS居中对齐
    const centerLatLng = L.latLng(sector.displayLat, sector.displayLng)
    const labelPos = centerLatLng

    // 创建标签图标
    const textColor = this.labelConfig.color || '#000000'
    const fontSize = this.labelConfig.fontSize || 12

    // Leaflet 定位逻辑：
    // - iconAnchor 是图标上与地图位置对齐的点
    // - 设置 iconAnchor 为图标中心，使标签中点与基站中心重合
    // - 由于文字宽度动态变化，使用一个足够大的固定尺寸，通过 CSS 居中

    const html = `
      <div style="
        font-size: ${fontSize}px;
        color: ${textColor};
        font-weight: 500;
        white-space: nowrap;
        background-color: transparent;
        padding: 0;
        margin: 0;
        pointer-events: none;
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
      ">${content}</div>
    `

    const icon = L.divIcon({
      html: html,
      className: 'sector-label-centered',
      iconSize: [200, 20],     // 足够大的容器，容纳各种长度的文字
      iconAnchor: [100, 10]    // 容器中心点：(200/2, 20/2)
    })

    return L.marker(labelPos, {
      icon: icon,
      interactive: false,
      zIndexOffset: 1000 // 确保标签在顶层
    })
  }

  /**
   * 渲染扇区模式（Zoom > 9，中近景，显示全部扇区）- 保留兼容性
   */
  private _renderSectors(currentZoom: number, mapCenter: L.LatLng): void {
    // 获取当前视口边界，添加缓冲区以确保边缘附近的扇区也被渲染
    const bounds = this.mapInstance!.getBounds()
    const latBuffer = (bounds.getNorth() - bounds.getSouth()) * 0.2
    const lngBuffer = (bounds.getEast() - bounds.getWest()) * 0.2
    const paddedBounds = L.latLngBounds(
      [bounds.getSouth() - latBuffer, bounds.getWest() - lngBuffer],
      [bounds.getNorth() + latBuffer, bounds.getEast() + lngBuffer]
    )

    const now = Date.now()
    this._renderSectorsOptimized(currentZoom, mapCenter, paddedBounds, now, true)
  }

  // 标记是否已记录过日志（避免重复）
  private _hasLoggedOnce = false

  /**
   * 创建扇区多边形
   * 根据小区覆盖类型绘制不同形状：
   * - cell_cover_type = 1: 室外小区，扇形，半径60米，夹角40度，按方位角绘制
   * - cell_cover_type = 4: 室内小区，圆形，半径30米，忽略方位角
   */
  private _createSectorPolygon(sector: RenderSectorData, adjustedRadius?: number): L.Polygon {
    // 如果没有传入调整后的半径，则计算一个默认值 (避免 crash，但实际上应该总是传入)
    let radius = adjustedRadius
    if (!radius) {
      // Fallback: 使用默认缩放进行计算
      const currentZoom = this.mapInstance ? this.mapInstance.getZoom() : 12
      const centerLat = this.mapInstance ? this.mapInstance.getCenter().lat : sector.displayLat
      radius = this._calculateRadius(currentZoom, centerLat)
      if (getCellCoverStyle(sector.cell_cover_type, sector.networkType).isCircular) {
        radius = radius / 2
      }
    }

    // 使用提取的坐标生成方法
    const latLngs = this._generateSectorLatLngs(sector, radius)

    // 确定扇区样式：先检查PCI高亮配置，再使用渲染模式默认样式
    let fillColor: string
    let strokeColor: string
    let strokeWidth: number
    let fillOpacity: number

    // 检查是否需要应用PCI高亮样式
    const applyPCIHighlight = this.pciHighlightConfig && this.renderMode === 'pci-planning'

    if (applyPCIHighlight && this.pciHighlightConfig) {
      const { selectedId, relatedIds } = this.pciHighlightConfig
      const relatedIdsSet = new Set(relatedIds)

      if (sector.id === selectedId) {
        // 选中的扇区：不透明红色，高对比度
        fillColor = '#ff0000'  // 更亮的红色
        strokeColor = '#cc0000'  // 深红色边框
        strokeWidth = 6  // 更粗的边框
        fillOpacity = 1
      } else if (relatedIdsSet.has(sector.id)) {
        // 同频同PCI的扇区：不透明蓝色，高对比度
        fillColor = '#0066ff'
        strokeColor = '#0044cc'
        strokeWidth = 6
        fillOpacity = 1
      } else {
        // 其他扇区：白色填充带黑色细边框
        fillColor = '#FFFFFF'
        strokeColor = '#000000'
        strokeWidth = 1.5
        fillOpacity = 1.0
      }
    } else if (this.renderMode === 'pci-planning') {
      // PCI模式无高亮：白色填充带黑色细边框
      fillColor = '#FFFFFF'
      strokeColor = '#000000'
      strokeWidth = 1.5
      fillOpacity = 1.0
    } else if (this.renderMode === 'neighbor-planning') {
      // 邻区规划模式：白色填充带黑色细边框
      fillColor = '#FFFFFF'
      strokeColor = '#000000'
      strokeWidth = 1.5
      fillOpacity = 1.0
    } else if (this.renderMode === 'tac-check') {
      // TAC核查模式：按TAC值分配颜色，插花小区红色边框
      const { selectedId } = this.tacHighlightConfig || {}

      // 获取扇区的TAC值（优先使用 syncedTAC，其次使用原始 tac）
      const sectorTac = (sector as any).syncedTAC || sector.tac
      const isSectorSelected = sector.id === selectedId

      // 确定网络类型用于颜色映射
      const networkType = (this.tacHighlightConfig?.networkType || sector.networkType) as NetworkType

      if (sectorTac && networkType) {
        // 获取TAC对应的颜色
        const tacColor = tacColorMapper.getColor(String(sectorTac), networkType)
        fillColor = tacColor.color
        strokeColor = isSectorSelected ? '#FF0000' : tacColor.strokeColor
        strokeWidth = isSectorSelected ? 6 : 3
        fillOpacity = isSectorSelected ? 1.0 : 0.85
      } else {
        // 无TAC值的小区：灰色
        fillColor = '#E5E7EB'
        strokeColor = isSectorSelected ? '#FF0000' : '#9CA3AF'
        strokeWidth = isSectorSelected ? 6 : 3
        fillOpacity = 0.8
      }

      // 插花小区特殊处理：紫色边框
      if ((sector as any).isSingularity) {
        strokeColor = '#A855F7'  // 紫色边框
        strokeWidth = 5
      }
    } else if (this.selectionHighlightIds && this.selectionHighlightIds.size > 0) {
      // 选中高亮模式：应用选中样式
      const sectorId = String(sector.id)
      const compositeId = sector.siteId && sector.sectorId ? `${sector.siteId}_${sector.sectorId}` : null
      const isSelected = this.selectionHighlightIds.has(sectorId) ||
        (compositeId && this.selectionHighlightIds.has(compositeId)) ||
        (sector.name && this.selectionHighlightIds.has(sector.name))

      if (isSelected) {
        // 选中扇区：红色高亮
        const colors = getSectorColor(sector)
        fillColor = colors.fillColor
        strokeColor = '#ff0000'
        strokeWidth = 3
        fillOpacity = 0.6
      } else {
        // 默认模式：彩色（基于频点或网络类型）
        const colors = getSectorColor(sector)
        const config = SECTOR_CONFIG[sector.networkType]
        fillColor = colors.fillColor
        strokeColor = config.strokeColor || '#000000'
        strokeWidth = config.strokeWidth || 0.5
        fillOpacity = config.opacity
      }
    } else {
      // 默认模式：彩色（基于频点或网络类型）
      const colors = getSectorColor(sector)
      const config = SECTOR_CONFIG[sector.networkType]
      fillColor = colors.fillColor
      strokeColor = config.strokeColor || '#000000'
      strokeWidth = config.strokeWidth || 0.5
      fillOpacity = config.opacity
    }

    // 获取当前缩放级别用于动态调整渲染质量
    const currentZoom = this.mapInstance ? this.mapInstance.getZoom() : 12

    // 创建多边形 - PCI模式下禁用平滑处理以提升性能
    const polygon = L.polygon(latLngs, {
      color: strokeColor,
      weight: currentZoom >= 17 ? 0.3 : strokeWidth,
      opacity: 1,
      fillColor: fillColor,
      fillOpacity: fillOpacity,
      className: this.measureMode ? 'sector-polygon sector-polygon-measure' : 'sector-polygon',
      smoothFactor: this.renderMode === 'pci-planning' ? 0 : (currentZoom >= 17 ? 0.5 : 0.1),
      noClip: this.renderMode !== 'pci-planning'  // PCI模式启用裁剪以提升性能
    })

    // 设置交互样式
    polygon.setStyle({
      className: this.measureMode ? 'sector-polygon sector-polygon-measure' : 'sector-polygon'
    })

    // 绑定点击事件 - 测距模式或框选模式下禁用
    polygon.on('click', (e: L.LeafletMouseEvent) => {
      // 测距模式下不响应点击
      if (this.measureMode) {
        L.DomEvent.stopPropagation(e)
        return
      }
      // 点选模式下允许点击事件，通过 onClick 回调处理
      L.DomEvent.stopPropagation(e)
      e.originalEvent.preventDefault()
      e.target = polygon
      this.onClick?.(sector, e)
      console.log('[SectorRenderer] 扇区被点击:', sector.name, sector.networkType, 'cell_cover_type:', sector.cell_cover_type)
    })

    // 绑定鼠标悬停事件 - 测距模式或框选模式下禁用
    polygon.on('mouseover', (e: L.LeafletMouseEvent) => {
      // 测距或框选模式下不显示悬停提示
      if (this.measureMode || this.isSelectionMode) {
        return
      }
      // 使用 Leaflet 的 tooltip 显示小区名称
      const tooltipContent = `
        <div class="sector-tooltip-content">
          ${sector.name || sector.id}
        </div>
      `

      // 创建或更新 tooltip
      if (!polygon.getTooltip()) {
        polygon.bindTooltip(tooltipContent, {
          permanent: false,
          direction: 'top',
          offset: [0, -10],
          className: 'sector-tooltip'
        })
      } else {
        polygon.setTooltipContent(tooltipContent)
      }

      polygon.openTooltip()
    })

    // 绑定鼠标移出事件，隐藏 tooltip
    polygon.on('mouseout', () => {
      polygon.closeTooltip()
    })

      // 添加数据属性（用于调试）
      ; (polygon as any).sectorData = sector

    // 调试：记录创建的扇区ID（仅PCI模式下记录前几个）
    if (this.renderMode === 'pci-planning' && this.sectorPolygons.size < 5) {
      console.log('[SectorRenderer] 创建扇区多边形', {
        id: sector.id,
        siteId: sector.siteId,
        sectorId: sector.sectorId,
        name: sector.name
      })
    }

    return polygon
  }

  /**
   * 生成弧线上的点
   * 根据缩放级别自适应调整点数以平衡性能和视觉效果
   */
  private _generateArcPoints(
    center: L.LatLng,
    startAzimuth: number,
    endAzimuth: number,
    radius: number
  ): L.LatLng[] {
    const numPoints = this._getArcPointsCount(this.currentZoom)
    const points: L.LatLng[] = []
    const angleStep = (endAzimuth - startAzimuth) / numPoints

    for (let i = 1; i < numPoints; i++) {
      const azimuth = startAzimuth + angleStep * i
      const point = this._fastDestination(center, azimuth, radius)
      points.push(point)
    }

    return points
  }

  /**
   * 获取位置的唯一键（用于分组同一位置的扇区）
   */
  private _getLocationKey(sector: RenderSectorData): string {
    // 使用经纬度保留4位小数作为位置键（约11米精度）
    const lat = sector.displayLat.toFixed(4)
    const lng = sector.displayLng.toFixed(4)
    return `${lat},${lng}`
  }

  /**
   * 根据zoom级别获取每个位置最多显示的标签数
   */
  /**
   * 计算标签在圆形分布中的位置
   * @param center 中心点
   * @param index 标签索引
   * @param total 总标签数
   * @param radius 分布半径（米）
   * @returns 偏移后的坐标
   */
  private _calculateLabelPosition(
    center: L.LatLng,
    index: number,
    total: number,
    radius: number
  ): L.LatLng {
    if (total === 1) {
      return center  // 只有一个标签时，显示在中心
    }

    // 使用圆形分布算法
    const angleStep = 360 / total
    const angle = angleStep * index

    return this._fastDestination(center, angle, radius)
  }

  /**
   * 生成圆形上的点
   * 根据缩放级别自适应调整点数以平衡性能和视觉效果
   */
  private _generateCirclePoints(
    center: L.LatLng,
    radius: number
  ): L.LatLng[] {
    const numPoints = this._getCirclePointsCount(this.currentZoom)
    const points: L.LatLng[] = []
    const angleStep = 360 / numPoints

    for (let i = 0; i <= numPoints; i++) {
      const azimuth = angleStep * i
      const point = this._fastDestination(center, azimuth, radius)
      points.push(point)
    }

    return points
  }

  /**
   * 快速计算终点坐标 (Flat-Earth Approximation)
   * 适用于小范围（<几百公里）的高性能计算，避免昂贵的反三角函数
   * 精度提示：在2300m范围内，误差极小，完全满足视觉需求
   */
  private _fastDestination(start: L.LatLng, azimuth: number, distance: number): L.LatLng {
    // 将角度转换为弧度
    const radAzimuth = azimuth * Math.PI / 180
    // 纬度的每米度数 (常量 approximation)
    const metersPerLatDegree = 111319.9
    // 经度的每米度数 (随纬度变化)
    const metersPerLngDegree = 111319.9 * Math.cos(start.lat * Math.PI / 180)

    const dLat = (distance * Math.cos(radAzimuth)) / metersPerLatDegree
    const dLng = (distance * Math.sin(radAzimuth)) / metersPerLngDegree

    return L.latLng(start.lat + dLat, start.lng + dLng)
  }


}

/**
 * 创建扇区 SVG 图层
 */
export function createSectorLayer(options: SectorLayerOptions): SectorSVGLayer {
  return new SectorSVGLayer(options)
}
