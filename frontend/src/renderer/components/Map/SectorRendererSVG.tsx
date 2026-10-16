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
import { SECTOR_CONFIG, getCellCoverStyle, getSectorColor, resolveSectorField } from '../../config/sector-config'
import { tacColorMapper } from '../../utils/tacColors'
import { matchThematicColor, matchRangeIndex, getFieldValue, toNumber } from '../../utils/fieldValue'
import { buildPciModPalette, getPciModColor } from '../../utils/pciModColor'
import type { PciRenderStats } from '../../utils/pciModColor'
import type { ThematicSettings } from './LabelSettingsModal'
import type { HeatPoint } from '../../utils/heatmap'
import type { NetworkType } from '../../config/sector-config'
import { LabelLayoutManager, type LabelCandidate } from './LabelLayoutManager'
import { layerHitAt, layerBoundsHitPx, CLICK_HIT_TOLERANCE_PX, type FeatureHitType } from './mapHitTest'

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
  /** 字体族（CSS font-family 栈），默认 sans-serif */
  fontFamily?: string
  /** 字体效果：加粗 */
  bold?: boolean
  /** 字体效果：斜体 */
  italic?: boolean
  /** 字体效果：阴影 */
  shadow?: boolean
  /** 字体背景：none=无 / halo=光晕 / box=框形 */
  background?: 'none' | 'halo' | 'box'
  /** 字体背景颜色（background 为 halo/box 时生效） */
  backgroundColor?: string
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
  /** 共享标签布局引擎（统一防重叠，跨图层不重叠） */
  labelManager?: LabelLayoutManager
  /** 标签源 ID（在共享引擎中的唯一标识） */
  labelSourceId?: string
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
  private editSessionMode: boolean = false // 图层编辑会话标志（点击穿透到地图）

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

  // 默认设置覆盖（图形透明度/边框宽度；仅默认频点配色模式生效）
  private colorOverrides: { fillOpacity: number; borderWidth: number } | null = null

  // 小区PCI渲染（默认设置：启用后按 PCI 模3/模30 取值配色）
  private pciRender: { enabled: boolean; mod: 3 | 30 } | null = null

  // PCI模值图例统计（按频点分组的小区数、总数、无PCI/无频点数）
  private pciRenderStats: PciRenderStats | null = null

  // PCI渲染调色板（"频点×模值"组合，与统计同步构建）
  private pciRenderPalette: string[] | null = null

  // PCI渲染频点有序列表（升序，频点序号用于调色板组合编号）
  private pciFrequencies: number[] = []

  // 专题图层设置（启用时优先于频点配色）
  private thematicSettings: ThematicSettings | null = null

  // 专题图例统计（区间/属性值/文本的要素数与总数）
  private thematicStats: { counts: number[]; total: number; other: number } | null = null

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

  // 共享标签布局引擎（标签防重叠统一由 LabelLayoutManager 处理）
  private labelManager: LabelLayoutManager | null
  private labelSourceId: string

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
    this.labelManager = options.labelManager || null
    this.labelSourceId = options.labelSourceId || `sector-layer-${Math.random().toString(36).slice(2, 8)}`

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
    this.labelManager?.removeSource(this.labelSourceId)
    this.visibleSectorsCache = null
    return this
  }

  /**
   * 更新扇区数据
   */
  updateSectors(sectors: RenderSectorData[]): void {
    this.sectors = sectors
    this.computePciRenderStats()
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
   * 图层编辑会话模式：扇区要素禁用鼠标交互（pointer-events: none），
   * 点击穿透到地图供编辑会话绘制/选中使用（否则扇区 click stopPropagation 吞掉地图 click）。
   * 与测距模式同机制；重渲染时通过 className 计算保持状态。
   */
  setEditSessionMode(enabled: boolean): void {
    if (this.editSessionMode === enabled) return
    this.editSessionMode = enabled
    // 重新套用各要素 className（与 setMeasureMode 相同的刷新方式）
    this.featureGroup?.eachLayer((layer: any) => {
      const el = layer.getElement?.()
      if (el && el.classList) {
        el.classList.toggle('sector-edit-passthrough', enabled)
      }
    })
  }

  /** 计算扇区要素 className：编辑会话模式下追加穿透类（pointer-events: none） */
  private pathClassName(base: string): string {
    return this.editSessionMode ? `${base} sector-edit-passthrough` : base
  }

  /**
   * 把扇区 svg 渲染层移到 pane 顶部，使其成为点击命中目标。
   * featureGroup 无 getContainer()；扇区路径共用地图默认 SVG renderer 的容器
   * （<svg>）。从 featureGroup 内任一 Path 图层取 renderer（Path.getRenderer()
   * 无需参数），将其 appendChild 到 overlayPane 顶部即可让基站层高于各 canvas 层。
   */
  bringToFrontForZOrder(): void {
    if (!this.featureGroup) return
    let container: HTMLElement | undefined
    this.featureGroup.eachLayer((layer: any) => {
      if (container) return
      const renderer = typeof layer?.getRenderer === 'function' ? layer.getRenderer() : undefined
      container = renderer?._container as HTMLElement | undefined
    })
    if (container && container.parentNode) {
      container.parentNode.appendChild(container)
    }
  }

  /**
   * 设置频点可见性
   * @param frequency 频点值
   * @param visible 是否可见
   */
  setFrequencyVisibility(frequency: number, visible: boolean): void {
    this.frequencyVisibility.set(frequency, visible)
    // 频点勾选变化：同步重算PCI图例统计（图例只展示勾选频点）
    this.computePciRenderStats()
    this._render() // 重新渲染
  }

  /**
   * 获取指定屏幕位置的所有扇区数据
   * 用于处理重叠扇区点击
   */
  public getSectorsAt(clientX: number, clientY: number): RenderSectorData[] {
    const sectors: RenderSectorData[] = []
    const elements = document.elementsFromPoint(clientX, clientY)

    // 遍历所有元素，寻找属于本图层的扇区多边形或标记
    for (const el of elements) {
      if (el.classList.contains('sector-polygon') || el.classList.contains('sector-marker')) {
        // 通过寻找 FeatureGroup 中的对应 Layer 获取数据
        if (this.featureGroup) {
          this.featureGroup.eachLayer((layer: any) => {
            const layerEl = layer.getElement?.()
            // CircleMarker 的 getElement() 返回 SVG 元素
            // 多边形也是 SVG 元素，两者都通过 element 匹配
            if (layerEl === el && layer.sectorData) {
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
   * 获取坐标位置精确命中的扇区（几何命中，用于手形工具统一"点击查属性"）。
   *
   * 与 getSectorsAt（DOM elementsFromPoint）不同：
   * - 编辑会话/测距模式下扇区元素 pointer-events:none，elementsFromPoint 会忽略它们，
   *   而本方法直接对渲染几何做像素空间命中，不受交互状态影响；
   * - 按 mapHitTest 口径区分 direct（扇形填充包含点击点）/ border（仅边框容差压中，
   *   如相邻扇区的直边交叠），交由调用方做穿透收敛，避免边框交叠误弹重叠列表。
   *
   * @param latlng 点击位置（渲染坐标/GCJ02）
   * @param tolerancePx 像素容差
   */
  public getSectorsAtLatLng(
    latlng: L.LatLng,
    tolerancePx: number = CLICK_HIT_TOLERANCE_PX
  ): Array<{ sector: RenderSectorData; hitType: FeatureHitType; distancePx: number }> {
    if (!this.mapInstance || !this.featureGroup) return []
    const results: Array<{ sector: RenderSectorData; hitType: FeatureHitType; distancePx: number }> = []

    const collect = (layer: L.Layer) => {
      const sector = (layer as any).sectorData as RenderSectorData | undefined
      if (!sector) return
      // 已被移出渲染层的缓存（清理滞后）不参与命中
      if (!this.featureGroup!.hasLayer(layer)) return
      // 像素包围盒粗检预筛：扇区多边形点数多，避免全量逐点投影
      if (!layerBoundsHitPx(this.mapInstance!, layer, latlng, tolerancePx)) return
      const hit = layerHitAt(this.mapInstance!, layer, latlng, tolerancePx)
      if (hit) results.push({ sector, hitType: hit.type, distancePx: hit.distancePx })
    }

    for (const cached of this.sectorPolygons.values()) collect(cached.polygon)
    for (const cached of this.siteMarkers.values()) collect(cached.marker)

    // 去重（同一扇区不会同时存在于两个缓存，此处仅防御）
    return results.filter((v, i, a) => a.findIndex(t => String(t.sector.id) === String(v.sector.id)) === i)
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
          // 频点不在映射中，默认为不可见（只有用户明确勾选的频点才显示）。
          // 映射本身由 MapPage 的频点表提供，新频点在那边默认跟随总开关为可见，
          // 这里保持"严格按映射执行"，不与 PCI 图例的 `=== true` 口径分叉。
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

    // 频点可见性初始化/变化：重算PCI图例统计后再渲染
    this.computePciRenderStats()
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
    this._updateSectorStyles()
  }

  /**
   * 设置邻区高亮模式
   * @param config 邻区高亮配置，null表示清除高亮
   */
  setNeighborHighlightMode(config: NeighborHighlightConfig | null): void {
    this.neighborHighlightConfig = config
    console.log('[SectorRenderer] 设置邻区高亮模式', config)
    // 使用requestAnimationFrame批处理样式更新，提升性能
    this._updateSectorStyles()
  }

  /**
   * 设置TAC插花高亮模式
   * @param config TAC高亮配置，null表示清除高亮
   */
  setTACHighlightMode(config: TACHighlightConfig | null): void {
    this.tacHighlightConfig = config
    console.log('[SectorRenderer] 设置TAC插花高亮模式', config)
    // 使用requestAnimationFrame批处理样式更新，提升性能
    this._updateSectorStyles()
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
          className: this.pathClassName(this.measureMode ? 'sector-polygon sector-polygon-measure' : 'sector-polygon')
        })
      }
    }

    // 更新圆点标记的CSS类名
    for (const [sectorId, cached] of this.siteMarkers) {
      const marker = cached.marker
      if (marker) {
        marker.setStyle({
          className: this.pathClassName(this.measureMode ? 'sector-marker sector-marker-measure' : 'sector-marker')
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
          // 扇区已存在，更新其样式以应用高亮（红色边框，保留原频点填充色，与图层文件/地理化数据圈选效果一致）
          existingPolygon.polygon.setStyle({
            color: '#ef4444',
            weight: 4
          })
          existingPolygon.polygon.bringToFront()
          console.log('[SectorRenderer] 更新已有扇区多边形高亮', sectorId)
          continue
        }

        if (existingMarker) {
          // 标记已存在，更新其样式以应用高亮（红色边框，保留原填充色）
          existingMarker.marker.setStyle({
            color: '#ef4444',
            weight: 3
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

    // 遍历所有已缓存的扇区图形，直接应用/恢复高亮样式
    // 与 GeoDataLayer 的 setSelectionHighlight 逻辑一致
    this._applySelectionHighlightToCaches()
  }

  /**
   * 遍历 sectorPolygons 和 siteMarkers 缓存，直接应用或恢复高亮样式
   * 与 GeoDataLayer 的 setSelectionHighlight 各层遍历方式一致
   */
  private _applySelectionHighlightToCaches(): void {
    // 处理扇区多边形缓存
    for (const [sectorId, cached] of this.sectorPolygons) {
      const layer = cached.polygon
      const sector = (layer as any).sectorData as RenderSectorData
      if (!sector) continue
      const isSelected = this._isSectorSelected(sectorId, sector)
      if (isSelected) {
        // 红色边框高亮，保留原频点填充色/透明度（与图层文件/地理化数据圈选效果一致）
        layer.setStyle({
          color: '#ef4444',
          weight: 4
        })
        if (layer.bringToFront) layer.bringToFront()
      } else {
        const base = this._sectorBaseStyle(sector)
        layer.setStyle({
          fillColor: base.fillColor,
          color: base.strokeColor,
          weight: base.strokeWidth,
          fillOpacity: base.fillOpacity
        })
      }
    }
    // 处理站点标记缓存
    for (const [siteKey, cached] of this.siteMarkers) {
      const layer = cached.marker
      const sector = (layer as any).sectorData as RenderSectorData
      if (!sector) continue
      const isSelected = this._isSectorSelected(siteKey, sector)
      if (isSelected) {
        // 红色边框高亮，保留圆点原填充色
        layer.setStyle({
          color: '#ef4444',
          weight: 3
        })
        if (layer.bringToFront) layer.bringToFront()
      } else {
        const base = this._sectorBaseStyle(sector, 'marker')
        layer.setStyle({
          fillColor: base.fillColor,
          color: base.strokeColor,
          weight: base.strokeWidth,
          fillOpacity: base.fillOpacity
        })
      }
    }
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

    const base = this._sectorBaseStyle(sector)

    // 检查是否选中
    let strokeColor = base.strokeColor
    let strokeWidth = base.strokeWidth
    let fillOpacity = base.fillOpacity

    if (this.selectionHighlightIds && this.selectionHighlightIds.size > 0) {
      const sectorId = String(sector.id)
      const compositeId = sector.siteId && sector.sectorId ? `${sector.siteId}_${sector.sectorId}` : null
      const isSelected = this.selectionHighlightIds.has(sectorId) ||
        (compositeId && this.selectionHighlightIds.has(compositeId)) ||
        (sector.name && this.selectionHighlightIds.has(sector.name))

      if (isSelected) {
        // 红色边框高亮，填充色/透明度保持频点基础样式
        strokeColor = '#ef4444'
        strokeWidth = 4
      }
    }

    const polygon = L.polygon(latLngs, {
      color: strokeColor,
      weight: strokeWidth,
      opacity: 1,
      fillColor: base.fillColor,
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
   * 计算扇区基础样式（专题配色优先、默认频点配色次之，再叠加默认设置覆盖的透明度/边框宽度）
   * @param sector 扇区数据
   * @param kind 渲染形态：'polygon' 使用 SECTOR_CONFIG 默认边框/透明度；'marker' 使用站点圆点默认
   * @returns 基础样式
   */
  private _sectorBaseStyle(
    sector: RenderSectorData,
    kind: 'polygon' | 'marker' = 'polygon'
  ): { fillColor: string; strokeColor: string; strokeWidth: number; fillOpacity: number } {
    const colors = getSectorColor(sector)
    const config = SECTOR_CONFIG[sector.networkType]

    let fillColor = colors.fillColor
    // 小区PCI渲染（默认设置）：同频点且同 PCI 模3/模30 取值才同色；
    // 无有效频点/PCI时保持原配色。专题图层优先级更高，在下方覆盖。
    if (this.pciRender?.enabled && this.pciRenderPalette) {
      const frequency = this._getFrequencyValue(sector)
      const pci = frequency !== null ? this._getPCIValue(sector) : null
      const freqIndex = frequency !== null ? this.pciFrequencies.indexOf(frequency) : -1
      if (pci !== null && freqIndex >= 0) {
        fillColor = getPciModColor(this.pciRenderPalette, freqIndex, this.pciRender.mod, pci)
      }
    }
    // 专题配色优先（启用且字段有效时）
    if (this.thematicSettings?.enabled && this.thematicSettings.field) {
      const thematicColor = matchThematicColor(
        this.thematicSettings,
        getFieldValue(sector as unknown as Record<string, any>, this.thematicSettings.field)
      )
      if (thematicColor) fillColor = thematicColor
    }

    let strokeColor: string
    let strokeWidth: number
    let fillOpacity: number
    if (kind === 'marker') {
      strokeColor = colors.strokeColor
      strokeWidth = 1
      fillOpacity = 0.8
    } else {
      strokeColor = config.strokeColor || '#000000'
      strokeWidth = config.strokeWidth || 0.5
      fillOpacity = config.opacity
    }

    // 默认设置覆盖（图形透明度/边框宽度）
    if (this.colorOverrides) {
      if (typeof this.colorOverrides.fillOpacity === 'number') fillOpacity = this.colorOverrides.fillOpacity
      if (typeof this.colorOverrides.borderWidth === 'number') strokeWidth = this.colorOverrides.borderWidth
    }

    // 专题设置覆盖（图形透明度/边框颜色/图形大小）：专题启用时优先于默认设置。
    // 扇区属面状图层，「图形大小」语义为**边框宽度**（与图层文件的面/线一致）。
    if (this.thematicSettings?.enabled) {
      if (typeof this.thematicSettings.fillOpacity === 'number') fillOpacity = this.thematicSettings.fillOpacity
      if (this.thematicSettings.borderColor) strokeColor = this.thematicSettings.borderColor
      if (typeof this.thematicSettings.pointSize === 'number') strokeWidth = this.thematicSettings.pointSize
    }

    return { fillColor, strokeColor, strokeWidth, fillOpacity }
  }

  /**
   * 设置默认设置覆盖（图形透明度/边框宽度/小区PCI渲染；null 恢复 SECTOR_CONFIG 默认）
   * 频点配色模式下生效；专题启用时透明度/边框宽仍叠加（与图层文件一致）
   */
  setColorOverrides(settings: {
    fillOpacity: number
    borderWidth: number
    pciRenderEnabled?: boolean
    pciMod?: 3 | 30
  } | null): void {
    this.colorOverrides = settings
    this.pciRender = settings?.pciRenderEnabled
      ? { enabled: true, mod: settings.pciMod ?? 3 }
      : null
    this.computePciRenderStats()
    // _render 负责新增视口内缺失的扇区，_updateSectorStyles 负责重绘已缓存的扇区
    this._render()
    this._updateSectorStyles()
  }

  /**
   * 计算小区PCI渲染统计：收集有序频点列表与调色板，按"频点×模值"分组计数；
   * noPci = 有频点但无有效PCI；noFrequency = 无有效频点（保持原配色）。
   */
  private computePciRenderStats(): void {
    const pr = this.pciRender
    if (!pr?.enabled || this.sectors.length === 0) {
      this.pciRenderStats = null
      this.pciRenderPalette = null
      this.pciFrequencies = []
      return
    }
    // 有序频点列表（去重升序）；仅控制面板已勾选可见的频点才进入图例，
    // 与地图渲染过滤（frequencyVisibility）及频点复选框状态保持一致。
    const freqSet = new Set<number>()
    for (const sector of this.sectors) {
      const f = this._getFrequencyValue(sector)
      if (f !== null && this.frequencyVisibility.get(f) === true) freqSet.add(f)
    }
    const frequencies = [...freqSet].sort((a, b) => a - b)
    this.pciFrequencies = frequencies
    this.pciRenderPalette = buildPciModPalette(frequencies.length, pr.mod)

    const groups = frequencies.map(frequency => ({
      frequency,
      counts: new Array(pr.mod).fill(0),
      total: 0
    }))
    let total = 0
    let noPci = 0
    let noFrequency = 0
    for (const sector of this.sectors) {
      const frequency = this._getFrequencyValue(sector)
      if (frequency === null) { noFrequency++; continue }
      // 未勾选频点：不展示该频点图例，也不计入 noPci（其小区本就被频点过滤）
      if (this.frequencyVisibility.get(frequency) !== true) continue
      const pci = this._getPCIValue(sector)
      if (pci === null) { noPci++; continue }
      const group = groups[frequencies.indexOf(frequency)]
      group.total++
      total++
      group.counts[((pci % pr.mod) + pr.mod) % pr.mod]++
    }
    this.pciRenderStats = { frequencies: groups, total, noPci, noFrequency }
  }

  /**
   * 获取PCI渲染图例统计（按频点分组的各模值个数及无PCI/无频点小区数）
   */
  getPciRenderStats(): PciRenderStats | null {
    return this.pciRenderStats
  }

  /**
   * 设置专题图层覆盖（启用时优先于频点配色；null 关闭专题后回退到频点配色）
   */
  setThematicOverrides(settings: ThematicSettings | null): void {
    this.thematicSettings = settings
    this.computeThematicStats()
    // _render 负责新增视口内缺失的扇区，_updateSectorStyles 负责重绘已缓存的扇区
    this._render()
    this._updateSectorStyles()
  }

  /**
   * 重新渲染全部已渲染扇区（频点自定义配色等颜色变化后调用）
   */
  redraw(): void {
    this._render()
    this._updateSectorStyles()
  }

  /**
   * 计算专题图例统计（各配色模式的扇区数与总数，供图例展示）
   */
  private computeThematicStats(): void {
    const ts = this.thematicSettings
    if (!ts?.enabled || this.sectors.length === 0) {
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
    for (const sector of this.sectors) {
      const raw = getFieldValue(sector as unknown as Record<string, any>, ts.field)
      if (isRange) {
        total++
        const idx = matchRangeIndex(ts, raw)
        if (idx >= 0) counts[idx]++; else other++
      } else if (isValue) {
        total++
        if (raw === undefined || raw === null || raw === '') { other++; continue }
        const idx = valueIndex!.get(String(raw))
        if (idx !== undefined) counts[idx]++; else other++
      } else {
        total++
        if (raw === undefined || raw === null || raw === '') { if (otherIdx >= 0) counts[otherIdx]++; else other++; continue }
        const idx = categoryIndex!.get(String(raw))
        if (idx !== undefined) counts[idx]++
        else if (otherIdx >= 0) counts[otherIdx]++
        else other++
      }
    }
    this.thematicStats = { counts, total, other }
  }

  /**
   * 获取专题图例统计（图例显示每个区间的个数与占比；other = 未匹配的扇区数）
   */
  getThematicStats(): { counts: number[]; total: number; other: number } | null {
    return this.thematicStats
  }

  /**
   * 收集热力图点（displayLat/displayLng 为已纠偏 GCJ02 渲染坐标）。
   * 权重取扇区对象上的工参数值字段（azimuth/beamwidth/height/pci/tac/frequency/cell_cover_type）；
   * 展示别名（覆盖类型/是否共享/厂家）按 SECTOR_FIELD_ALIAS 映射回真实字段；
   * 字段非数值的扇区跳过。
   */
  getHeatPoints(field: string): HeatPoint[] {
    if (this.sectors.length === 0 || !field) return []
    const points: HeatPoint[] = []
    const key = resolveSectorField(field)
    for (const sector of this.sectors) {
      if (typeof sector.displayLat !== 'number' || typeof sector.displayLng !== 'number') continue
      const weight = toNumber((sector as any)[key])
      if (weight === null) continue
      points.push({ lat: sector.displayLat, lng: sector.displayLng, weight })
    }
    return points
  }

  /**
   * 获取该图层全部扇区的地理范围（图层预览：居中最大化显示）
   * @returns LatLngBounds；无扇区/无有效坐标返回 null
   */
  getSectorBounds(): L.LatLngBounds | null {
    const bounds = L.latLngBounds([])
    let has = false
    for (const sector of this.sectors) {
      if (typeof sector.displayLat !== 'number' || typeof sector.displayLng !== 'number') continue
      bounds.extend([sector.displayLat, sector.displayLng])
      has = true
    }
    return has ? bounds : null
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

    console.log('[SectorRenderer] getSectorsInPolygon 结果', {
      totalSectors: this.sectors.length,
      foundSectors: results.length,
      sampleIds: results.slice(0, 5).map(s => s.id)
    })

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

    // 重新渲染以更新标签（候选标签随渲染重新注册到共享布局引擎）
    this._render()
  }

  /**
   * 将当前可见扇区的标签候选注册到共享标签布局引擎。
   * 标签的防重叠/避让/显隐统一由 LabelLayoutManager 按屏幕空间处理，
   * 跨图层（LTE/NR/地理化数据）全局不重叠。
   */
  private _syncLabelCandidates(sectorsToRender: RenderSectorData[]): void {
    if (!this.labelManager) return

    const shouldShowLabel = this.showLabels || this.sectorLabelsEnabled
    if (!shouldShowLabel) {
      this.labelManager.setCandidates(this.labelSourceId, [])
      return
    }

    const isPciMode = this.pciHighlightConfig && this.renderMode === 'pci-planning'
    const candidates: LabelCandidate[] = []

    for (const sector of sectorsToRender) {
      if (typeof sector.displayLat !== 'number' || typeof sector.displayLng !== 'number') continue

      let text: string
      if (isPciMode) {
        // PCI模式：显示 小区名称 + PCI（优先使用规划后的PCI）
        text = `${sector.name || ''} (PCI: ${this._getLabelContent(sector, 'pci') || '-'})`
      } else {
        text = this._getLabelContent(sector, this.labelConfig.content)
      }
      if (!text) continue

      const sectorId = String(sector.id)
      const priority = this._isSectorSelected(sectorId, sector) ? 10 : 0

      candidates.push({
        id: sectorId,
        lat: sector.displayLat,
        lng: sector.displayLng,
        text,
        fontSize: this.labelConfig.fontSize || 12,
        fontFamily: this.labelConfig.fontFamily,
        bold: this.labelConfig.bold,
        italic: this.labelConfig.italic,
        shadow: this.labelConfig.shadow,
        background: this.labelConfig.background,
        backgroundColor: this.labelConfig.backgroundColor,
        color: this.labelConfig.color || '#000000',
        priority
      })
    }

    this.labelManager.setCandidates(this.labelSourceId, candidates)
  }

  /**
   * 获取小区PCI数值（标签与PCI渲染共用）
   * 优先使用PCI规划应用后的同步值（pciDataSyncService），再回退工参原始 pci 字段；
   * PCI 必须为有限整数（非整数/NaN/Infinity 等脏数据视为无效），否则返回 null。
   */
  private _getPCIValue(sector: RenderSectorData): number | null {
    let raw: unknown
    try {
      const pciDataSyncService = require('../../services/pciDataSyncService').pciDataSyncService
      if (pciDataSyncService && sector.siteId && sector.sectorId) {
        const syncedSector = pciDataSyncService.findSector(sector.siteId, sector.sectorId)
        if (syncedSector && syncedSector.syncedPCI !== undefined) raw = syncedSector.syncedPCI
      }
    } catch (e) {
      console.warn('[SectorRenderer] 获取同步PCI失败:', e)
    }
    if (raw === undefined || raw === null) raw = sector.pci
    const num = Number(raw)
    return Number.isInteger(num) ? num : null
  }

  /**
   * 获取小区工作频点（标签与PCI渲染共用）
   * 解析顺序 frequency → ssbFrequency → earfcn；必须为正有限数，否则返回 null。
   */
  private _getFrequencyValue(sector: RenderSectorData): number | null {
    for (const raw of [sector.frequency, sector.ssbFrequency, sector.earfcn]) {
      const num = Number(raw)
      if (Number.isFinite(num) && num > 0) return num
    }
    return null
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

      case 'networkType':
        // 网络类型
        return sector.networkType || ''

      case 'siteId':
        // 基站ID - 直接使用siteId字段
        return sector.siteId || ''

      case 'sectorId':
        // 小区ID
        return sector.sectorId || ''

      case 'frequency': {
        // 下行频点 - 与PCI渲染的频点解析同源
        const frequency = this._getFrequencyValue(sector)
        return frequency !== null ? String(frequency) : ''
      }

      case 'pci': {
        // PCI - 与PCI渲染同源（同步服务优先，原始pci字段兜底）
        const pci = this._getPCIValue(sector)
        return pci !== null ? String(pci) : ''
      }

      case 'tac':
        // TAC - 直接使用tac字段
        return sector.tac !== undefined ? String(sector.tac) : ''

      case 'longitude':
        // 经度
        return sector.longitude !== undefined ? sector.longitude.toFixed(6) : ''

      case 'latitude':
        // 纬度
        return sector.latitude !== undefined ? sector.latitude.toFixed(6) : ''

      case 'azimuth':
        // 方向角
        return sector.azimuth !== undefined ? `${sector.azimuth}°` : ''

      case 'height':
        // 天线挂高
        return sector.height !== undefined ? `${sector.height}m` : ''

      case 'isShared':
        // 是否共享 - 直接使用is_shared字段
        return sector.is_shared || ''

      case 'firstGroup':
        // 厂家（第一分组）
        return sector.first_group || ''

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
      // 通过 sectorPolygons / siteMarkers 缓存直接应用高亮
      // 与 setSelectionHighlight 中的 _applySelectionHighlightToCaches 使用相同的缓存遍历策略
      this._applySelectionHighlightToCaches()
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
          cached.polygon.setStyle({
            fillColor: this._sectorBaseStyle(sector).fillColor,
            color: '#ef4444', // 红色高亮边框
            weight: 3,
            fillOpacity: 0.9
          })
          highlightPolygons.push(cached.polygon)
        } else if (this.renderMode === 'pci-planning') {
          // PCI模式：检查是否在白名单中
          const isInWhitelist = this.sectorIdWhitelist ? this.sectorIdWhitelist.has(sectorId) : false
          if (isInWhitelist) {
            const base = this._sectorBaseStyle(sector)
            cached.polygon.setStyle({
              fillColor: base.fillColor,
              color: base.strokeColor,
              weight: base.strokeWidth,
              fillOpacity: base.fillOpacity
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
          const base = this._sectorBaseStyle(sector)
          cached.polygon.setStyle({
            fillColor: base.fillColor,
            color: base.strokeColor,
            weight: base.strokeWidth,
            fillOpacity: base.fillOpacity
          })
        }
      }

      for (const [siteKey, cached] of this.siteMarkers) {
        const sector = (cached.marker as any).sectorData as RenderSectorData
        const isSelected = this.selectionHighlightIds?.has(sector.id) ||
          (sector.siteId && sector.sectorId && this.selectionHighlightIds?.has(`${sector.siteId}_${sector.sectorId}`)) ||
          (sector.name && this.selectionHighlightIds?.has(sector.name))

        if (isSelected) {
          cached.marker.setStyle({
            fillColor: this._sectorBaseStyle(sector, 'marker').fillColor,
            color: '#ef4444', // 红色高亮边框
            weight: 3,
            fillOpacity: 1
          })
          highlightMarkers.push(cached.marker)
        } else if (this.renderMode === 'pci-planning') {
          const isInWhitelist = this.sectorIdWhitelist ? this.sectorIdWhitelist.has(sector.id) : false
          if (isInWhitelist) {
            const base = this._sectorBaseStyle(sector, 'marker')
            cached.marker.setStyle({
              fillColor: base.fillColor,
              color: base.strokeColor,
              weight: base.strokeWidth,
              fillOpacity: base.fillOpacity
            })
          } else {
            cached.marker.setStyle({
              fillColor: '#FFFFFF', color: '#000000', weight: 1.5, fillOpacity: 1.0
            })
          }
        } else {
          const base = this._sectorBaseStyle(sector, 'marker')
          cached.marker.setStyle({
            fillColor: base.fillColor,
            color: base.strokeColor,
            weight: base.strokeWidth,
            fillOpacity: base.fillOpacity
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
        cached.polygon.setStyle({
          fillColor: this._sectorBaseStyle(sector).fillColor,
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
          const base = this._sectorBaseStyle(sector)
          cached.polygon.setStyle({
            fillColor: base.fillColor,
            color: base.strokeColor,
            weight: base.strokeWidth,
            fillOpacity: base.fillOpacity
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
        cached.marker.setStyle({
          fillColor: this._sectorBaseStyle(sector, 'marker').fillColor,
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
          const base = this._sectorBaseStyle(sector, 'marker')
          cached.marker.setStyle({
            fillColor: base.fillColor,
            color: base.strokeColor,
            weight: base.strokeWidth,
            fillOpacity: base.fillOpacity
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

      // 低缩放级别不渲染扇区，同步清空标签候选
      this.labelManager?.setCandidates(this.labelSourceId, [])

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
      this._updateSectorStyles()
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
    // 口径契约：仅 raw frequency 显式 false 才隐藏；undefined（频点键缺失）放行。
    // 已知频点由 setFrequenciesVisibility 初始化为 true/false（default 模式未勾选补 false，
    // 映射由 MapPage 频点表提供，新频点默认跟随图层总开关为可见），
    // 故 undefined 仅在数据出现未登记频点时发生。PCI图例口径不同（===true 才展示，
    // 且频点解析含 ssbFrequency/earfcn 回退），改动此处须与 computePciRenderStats 对齐。
    const frequencyFilteredSectors = visibleSectors.filter(sector => {
      if (!sector.frequency) return true
      const isVisible = this.frequencyVisibility.get(sector.frequency)
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

    // 标签：注册候选到共享标签布局引擎，由引擎按屏幕空间统一防重叠
    this._syncLabelCandidates(sectorsToRender)
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
        fillColor = this._sectorBaseStyle(sector, 'marker').fillColor
        color = '#ff0000'
        weight = 3
        fillOpacity = 0.6
      } else {
        // 默认模式：彩色（基于频点或网络类型）
        const base = this._sectorBaseStyle(sector, 'marker')
        fillColor = base.fillColor
        color = base.strokeColor
        weight = base.strokeWidth
        fillOpacity = base.fillOpacity
      }
    } else {
      // 默认模式：彩色（基于频点或网络类型）
      const base = this._sectorBaseStyle(sector, 'marker')
      fillColor = base.fillColor
      color = base.strokeColor
      weight = base.strokeWidth
      fillOpacity = base.fillOpacity
    }

    const marker = L.circleMarker(centerLatLng, {
      radius: Math.max(radiusInPixels, 3), // 最小3像素，确保可见
      fillColor: fillColor,
      color: color,
      weight: weight,
      opacity: 1,
      fillOpacity: fillOpacity,
      className: this.pathClassName(this.measureMode ? 'sector-marker sector-marker-measure' : 'sector-marker')
    })

    // 绑定点击事件 - 测距模式或框选模式下禁用
    marker.on('click', (e: L.LeafletMouseEvent) => {
      // 测距模式下不响应点击
      if (this.measureMode) {
        L.DomEvent.stopPropagation(e)
        return
      }
      // 图层编辑会话：放行点击（不拦截），让地图 click 供编辑会话使用
      if (this.editSessionMode) return
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

    // 按频点过滤扇区（口径契约见 _renderSectorsOptimized 同名注释：
    // 显式 false 才隐藏、undefined 放行；与 PCI 图例 ===true 口径不同，改动须同步）
    const frequencyFilteredSectors = visibleSectors.filter(sector => {
      if (!sector.frequency) return true
      const isVisible = this.frequencyVisibility.get(sector.frequency)
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

    // 按物理位置（经纬度）分组扇区 - 同位置扇区集中渲染多边形
    const locationGroups = this._groupSectorsByLocation(sectorsToRender)

    // 标记当前应该可见的扇区ID
    const currentVisibleIds = new Set<string>()

    // 渲染每个位置组内的扇区多边形
    for (const [, locationSectors] of locationGroups.entries()) {
      locationSectors.sort((a, b) => {
        const aId = a.sectorId || ''
        const bId = b.sectorId || ''
        return aId.localeCompare(bId)
      })

      for (const sector of locationSectors) {
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
        } else {
          // 更新时间戳
          cached.lastUsed = now
        }

      }
    }

    // 标签：注册候选到共享标签布局引擎，由引擎按屏幕空间统一防重叠
    this._syncLabelCandidates(sectorsToRender)

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
        fillColor = '#ff4444'
        strokeColor = '#ff0000'
        strokeWidth = 4
        fillOpacity = 0.6
      } else {
        // 默认模式：彩色（基于频点或网络类型）
        const base = this._sectorBaseStyle(sector)
        fillColor = base.fillColor
        strokeColor = base.strokeColor
        strokeWidth = base.strokeWidth
        fillOpacity = base.fillOpacity
      }
    } else {
      // 默认模式：彩色（基于频点或网络类型）
      const base = this._sectorBaseStyle(sector)
      fillColor = base.fillColor
      strokeColor = base.strokeColor
      strokeWidth = base.strokeWidth
      fillOpacity = base.fillOpacity
    }

    // 获取当前缩放级别用于动态调整渲染质量
    const currentZoom = this.mapInstance ? this.mapInstance.getZoom() : 12

    // 选中红框扇区在高缩放级别也保持粗红边，不被压缩为 0.3px（否则圈选/搜索高亮几乎不可见）
    const isSelHL = !!(this.selectionHighlightIds && this.selectionHighlightIds.size > 0 && (
      this.selectionHighlightIds.has(String(sector.id)) ||
      (sector.siteId && sector.sectorId && this.selectionHighlightIds.has(`${sector.siteId}_${sector.sectorId}`)) ||
      (sector.name && this.selectionHighlightIds.has(sector.name))
    ))

    // 创建多边形 - PCI模式下禁用平滑处理以提升性能
    const polygon = L.polygon(latLngs, {
      color: strokeColor,
      weight: (currentZoom >= 17 && !isSelHL) ? 0.3 : strokeWidth,
      opacity: 1,
      fillColor: fillColor,
      fillOpacity: fillOpacity,
      className: this.pathClassName(this.measureMode ? 'sector-polygon sector-polygon-measure' : 'sector-polygon'),
      smoothFactor: this.renderMode === 'pci-planning' ? 0 : (currentZoom >= 17 ? 0.5 : 0.1),
      noClip: this.renderMode !== 'pci-planning'  // PCI模式启用裁剪以提升性能
    })

    // 设置交互样式
    polygon.setStyle({
      className: this.pathClassName(this.measureMode ? 'sector-polygon sector-polygon-measure' : 'sector-polygon')
    })

    // 绑定点击事件 - 测距模式或框选模式下禁用
    polygon.on('click', (e: L.LeafletMouseEvent) => {
      // 测距模式下不响应点击
      if (this.measureMode) {
        L.DomEvent.stopPropagation(e)
        return
      }
      // 图层编辑会话：放行点击（不拦截），让地图 click 供编辑会话使用
      if (this.editSessionMode) return
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
