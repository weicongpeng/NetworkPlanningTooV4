/**
 * 在线地图组件 - 使用高德地图 + Leaflet
 *
 * 功能:
 * - 支持平面地图和卫星地图切换
 * - 使用智能LOD扇区渲染器绘制LTE/NR扇区
 * - 支持点击扇区查看属性信息（带淡出动画）
 * - 默认位置：河源市
 * - 集成坐标转换服务 (WGS84 ↔ GCJ02)
 * - 支持图层控制 (LTE/NR切换)
 * - 支持MapInfo图层渲染
 * - 状态保持：页面切换时保持地图位置和缩放
 */
import { useEffect, useRef, useState, forwardRef, useImperativeHandle, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { NetworkStatusAlert } from './NetworkStatusIndicator'
import { frequencyColorMapper } from '../../utils/frequencyColors'
import { mapDataService, RenderSectorData } from '../../services/mapDataService'
import { CoordinateTransformer } from '../../utils/coordinate'
import { SectorInfoPanel, useSectorInfoPanel } from './SectorInfoPanel'
import { FeatureInfoPanel, useFeatureInfoPanel } from './FeatureInfoPanel'
import { MapInfoLayerManager, MapInfoLayer, MapInfoLayerOptions, LayerGeometryType } from './MapInfoLayer'
import { GeoDataLayerManager, GeoDataItem } from './GeoDataLayer'
import { layerApi, dataApi } from '../../services/api'

console.log('🔥🔥🔥 OnlineMap.tsx 已加载 (2025-01-27-v3) 🔥🔥🔥')

// ========== 共享地图实例缓存 ==========
// 跨页面复用 Leaflet 地图实例，避免页面切换时地图销毁重建导致瓦片重载
// 原理：在组件内创建独立容器 div（非React管理），unmount 时分离到隐藏存储，remount 时恢复
interface SharedMapCache {
  map: L.Map | null
  tileLayer: L.TileLayer | null
  leafletContainer: HTMLDivElement | null  // Leaflet 实际使用的容器元素
  mapLayerType: MapLayerType
}
let __sharedMapCache: SharedMapCache = {
  map: null, tileLayer: null, leafletContainer: null, mapLayerType: 'roadmap'
}
let __sharedHiddenContainer: HTMLDivElement | null = null
// 模块级共享 ref —— 地图缓存后，事件监听器闭包仍引用旧组件的 useRef 对象
// 使用模块级对象确保所有组件实例读写同一个 ref，解决跨实例闭包问题
const __sharedCaptureModeRef: { current: boolean } = { current: false }
const __sharedMeasureModeRef: { current: boolean } = { current: false }
const __sharedMeasurePointsRef: { current: Array<{ lng: number; lat: number }> } = { current: [] }
const __sharedFinishMeasurementRef: { current: (() => void) | null } = { current: null }
const __sharedHandleMapClickRef: { current: ((event: any) => void) | null } = { current: null }
// =====================================

import { mapStateService } from '../../services/mapStateService'
import { SectorSVGLayer, PCIHighlightConfig, TACHighlightConfig, NeighborHighlightConfig, SectorLabelConfig } from './SectorRendererSVG'
import { pciDataSyncService } from '../../services/pciDataSyncService'
import { neighborDataSyncService } from '../../services/neighborDataSyncService'
import { tacDataSyncService } from '../../services/tacDataSyncService'
// TACLegend 已移除，各个页面自己管理对应的图例组件

type MapLayerType = 'satellite' | 'roadmap'

/**
 * 搜索标记接口
 */
interface SearchMarker {
  lng: number
  lat: number
  name: string
}

/**
 * 图层可见性配置
 */
interface LayerVisibility {
  lte: boolean
  nr: boolean
}

/**
 * MapInfo图层文件配置
 */
interface LayerFileOption {
  id: string
  name: string
  type: 'point' | 'line' | 'polygon' | 'sector'
  visible: boolean
  dataId: string
  sourceType?: 'mapinfo' | 'excel'
  geometryType?: 'point' | 'sector' | 'polygon'
}

/**
 * 频点选项 (用于图层控制)
 */
export interface FrequencyOption {
  frequency: number
  color: string
  strokeColor: string
  visible: boolean
  networkType: 'LTE' | 'NR'
}

/**
 * 自定义图层选项
 */
export interface CustomLayerOption {
  id: string
  name: string
  type: 'point' | 'line' | 'polygon'
  visible: boolean
  data: any[] // 点坐标或GeoJSON
}

/**
 * 标记点自定义标签存储
 */
interface MarkerLabelData {
  id: string
  name: string
  label?: string
}

/**
 * 在线地图组件属性
 */
interface OnlineMapProps {
  /** MapInfo图层文件列表 */
  layerFiles?: LayerFileOption[]
  /** 地理化点文件列表 */
  pointFiles?: any[]
  /** 测距模式 */
  measureMode?: boolean
  /** 结束测距模式回调 */
  onMeasureModeEnd?: () => void
  /** 频点可见性状态 */
  frequencies?: { lte: FrequencyOption[]; nr: FrequencyOption[] }
  /** 自定义图层列表 */
  customLayers?: CustomLayerOption[]
  /** 初始图层可见性 */
  initialLayerVisibility?: LayerVisibility
  /** 视图模式切换回调 */
  onViewModeChange?: (mode: 'online' | 'offline') => void
  /** 地图显示模式 */
  mode?: 'default' | 'pci-planning' | 'neighbor-planning' | 'tac-check'
  /** 扇区点击回调 */
  onSectorClick?: (sector: RenderSectorData) => void
  /** 扇区标签可见性 */
  sectorLabelVisibility?: Record<string, boolean>
  /** 标签设置映射 */
  labelSettingsMap?: Record<string, any>
  /** 圈选模式 */
  selectionMode?: 'none' | 'point' | 'circle' | 'polygon'
  /** 结束圈选模式回调 */
  onSelectionModeEnd?: () => void
  /** 地图拖拽工具是否启用 */
  mapDragTool?: boolean
  /** 抓取坐标模式 */
  captureMode?: boolean
  /** 抓取坐标回调 (WGS84经度, WGS84纬度) */
  onCaptureCoord?: (lng: number, lat: number) => void
  /** 装饰图层可见性 */
  decorationLayerVisible?: boolean
  /** 打点功能被阻止时的回调（装饰图层未勾选） */
  onCaptureBlocked?: () => void
}

/**
 * 定位标记接口
 */
interface LocationMarker {
  id: string
  lng: number
  lat: number
}

/**
 * 暴露给父组件的方法
 */
export interface OnlineMapRef {
  /** 飞到指定位置 */
  flyTo: (latLng: [number, number], zoom?: number, duration?: number) => void
  /** 调整地图视野以包含指定的所有坐标点 */
  fitBounds: (latLngs: Array<[number, number]>, padding?: [number, number]) => void
  /** 设置搜索标记 */
  setSearchMarker: (marker: SearchMarker | null) => void
  /** 清除搜索标记 */
  clearSearchMarker: () => void
  /** 设置图层可见性 */
  setLayerVisibility: (layer: 'lte' | 'nr', visible: boolean) => void
  /** 设置扇区标签可见性 */
  setSectorLabelVisibility: (layer: 'lte' | 'nr', visible: boolean) => void
  /** 设置点文件标签可见性 */
  setPointFileLabelVisibility: (fileId: string, visible: boolean) => void
  /** 设置MapInfo图层可见性 */
  setMapInfoLayerVisibility: (layerId: string, visible: boolean) => void
  /** 设置地图类型 */
  setMapType: (type: 'roadmap' | 'satellite') => void
  /** 设置点文件标签可见性并更新设置 (MapPage用) */
  setLayerFileLabelVisibility: (fileId: string, visible: boolean, settings: any) => void
  /** 设置地图类型切换 */
  toggleMapType: () => void
  /** 设置频点可见性 */
  setFrequencyVisibility: (networkType: 'LTE' | 'NR', frequency: number, visible: boolean) => void
  /** 设置自定义图层可见性 */
  setCustomLayerVisibility: (layerId: string, visible: boolean) => void
  /** 设置装饰图层可见性 */
  setDecorationLayerVisibility: (visible: boolean) => void
  /** 设置底图可见性 */
  setBaseMapVisibility: (visible: boolean) => void
  /** 刷新地图数据 */
  refreshData: () => Promise<void>
  /** 添加定位标记 */
  addLocationMarker: (marker: LocationMarker, index: number) => void
  /** 清除所有定位标记 */
  clearLocationMarkers: () => void
  /** 清除所有测量 */
  clearMeasurements: () => void
  /** 设置测距模式 */
  setMeasureMode: (enabled: boolean) => void
  /** 设置邻区高亮 */
  setNeighborHighlight: (config: NeighborHighlightConfig | null) => void
  /** 清除邻区高亮 */
  clearNeighborHighlight: () => void
  /** 设置扇区ID白名单 */
  setSectorIdWhitelist: (whitelist: Set<string> | null, mode: 'pci-planning' | 'neighbor-planning' | 'tac-check', networkType?: 'LTE' | 'NR') => void
  /** 清除扇区ID白名单 */
  clearSectorIdWhitelist: () => void
  /** 设置PCI高亮模式 */
  setPCIHighlightMode: (config: PCIHighlightConfig | null) => void
  /** 清除PCI高亮 */
  clearPCIHighlight: () => void
  /** 设置TAC高亮模式 */
  setTACHighlightMode: (config: TACHighlightConfig | null) => void
  /** 清除圈选高亮 */
  clearSelectionHighlight: () => void
  /** 设置圈选高亮 */
  setSelectionHighlight: (ids: Set<string> | null) => void
  /** 获取撒点文件数据 */
  getPointFileData: () => Record<string, any[]>
  /** 设置扇区标签配置 */
  setSectorLabelSettings: (settings: any, layerId: string) => void
  /** 清除所有抓取坐标标记 */
  clearCaptureMarkers: () => void
}

export const OnlineMap = forwardRef<OnlineMapRef, OnlineMapProps>(({
  layerFiles = [],
  pointFiles = [],
  measureMode = false,
  onMeasureModeEnd,
  frequencies = { lte: [], nr: [] },
  customLayers = [],
  initialLayerVisibility = { lte: true, nr: true },
  mode = 'default',
  onSectorClick,
  sectorLabelVisibility = {},
  labelSettingsMap = {},
  selectionMode = 'none',
  onSelectionModeEnd,
  mapDragTool = false,
  captureMode = false,
  onCaptureCoord,
  onCaptureBlocked,
  decorationLayerVisible = true
}, ref) => {
  // Refs
  const customLayerRefs = useRef<Record<string, L.LayerGroup | L.FeatureGroup>>({})
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<L.Map | null>(null)
  const leafletRef = useRef<any>(null)
  const searchMarkerRef = useRef<Array<any>>([]) // 改为数组，支持多个搜索标记
  const locationMarkersRef = useRef<Array<any>>([]) // 定位标记数组
  const measurementLinesRef = useRef<Array<any>>([]) // 测量线条数组
  const measurementMarkersRef = useRef<Array<any>>([]) // 测量点标记数组
  const measurementDistanceRef = useRef<any>(null) // 距离显示标签
  const measurementLineStartIndexRef = useRef<number>(0) // 当前测量线条的起始索引
  const measurementMarkerStartIndexRef = useRef<number>(0) // 当前测量标记的起始索引
  const tileLayerRef = useRef<any>(null)
  const tileLoadTimeoutRef = useRef<NodeJS.Timeout | null>(null) // 瓦片加载超时定时器
  const networkEventListenersRef = useRef<{
    handleOnline: () => void
    handleOffline: () => void
    cleanup?: () => void
  } | null>(null) // 网络事件监听器引用
  const hasLoadedAnyTileRef = useRef(false) // 跟踪是否成功加载过至少一个瓦片
  const hasNetworkErrorRef = useRef(false) // 跟踪是否有真正的网络错误
  const isUserInteractingRef = useRef(false)
  const isInitializingRef = useRef(false) // 防止 React Strict Mode 双重初始化
  const initializedRef = useRef(false) // 跟踪是否已初始化过
  const measureModeRef = useRef(measureMode) // 测距模式Ref
  const selectionModeRef = useRef(selectionMode) // 圈选模式Ref
  const captureModeRef = useRef(captureMode) // 抓取模式Ref
  const captureMarkersRef = useRef<Array<any>>([]) // 抓取坐标标记数组
  const shadowLineRef = useRef<any>(null) // 测量预览虚线
  const shadowLabelRef = useRef<any>(null) // 测量预览标签

  // 框选功能状态
  const selectionShapeRef = useRef<L.Circle | L.Polygon | L.FeatureGroup | null>(null) // 框选形状（支持多选时使用FeatureGroup）
  const selectionRectRef = useRef<L.Rectangle | L.FeatureGroup | null>(null) // 矩形框选预览形状（支持多选时使用FeatureGroup）
  const selectionDrawingRef = useRef(false) // 是否正在绘制框选
  const selectionPointsRef = useRef<L.LatLng[]>([]) // 多边形框选的点
  const selectionStartPointRef = useRef<L.LatLng | null>(null) // 框选起点
  const pointModeIsDragging = useRef(false) // point 模式：是否正在拖拽（框选矩形）
  const pointModeDragThreshold = 5 // point 模式：拖拽阈值（像素），超过此值才视为拖拽
  const selectedFeaturesRef = useRef<any[]>([]) // 选中的要素属性数据
  const selectedIdsRef = useRef<Set<string>>(new Set()) // 选中的要素ID集合
  const polygonTempLayerRef = useRef<L.Polyline | null>(null) // 多边形绘制临时线
  const dragPreviewRectRef = useRef<L.Rectangle | null>(null) // 矩形拖拽预览（独立于已保存的矩形轨迹）
  const dragPreviewCircleRef = useRef<L.Circle | null>(null) // 圆形拖拽预览（独立于已保存的圆形轨迹）
  const [selectionTip, setSelectionTip] = useState<string>('') // 框选提示信息
  const preserveSelectionRef = useRef<boolean>(false) // 同步跟踪保留状态，避免 state 异步更新问题
  const [customLayerVisibility, setCustomLayerVisibilityState] = useState<Record<string, boolean>>({})
  const [decorationLayerVisibility, setDecorationLayerVisibility] = useState<boolean>(decorationLayerVisible)
  const decorationLayerRef = useRef<L.LayerGroup | null>(null) // 装饰图层引用

  // 标记点自定义标签存储
  const markerLabelsRef = useRef<Map<string, MarkerLabelData>>(new Map())
  const markerLabelElementsRef = useRef<Map<string, L.Marker>>(new Map())

  // i18n translation
  const { t } = useTranslation()

  // 同步Ref
  useEffect(() => { measureModeRef.current = measureMode }, [measureMode])
  useEffect(() => { selectionModeRef.current = selectionMode }, [selectionMode])
  useEffect(() => { captureModeRef.current = captureMode }, [captureMode])
  useEffect(() => { setDecorationLayerVisibility(decorationLayerVisible) }, [decorationLayerVisible])

  // 使用Ref跟踪上一次的mapDragTool值，用于检测变化
  const prevMapDragToolRef = useRef<boolean>(mapDragTool)
  // 临时存储选中状态，用于在拖拽工具激活时保留
  const preservedSelectionRef = useRef<{
    ids: Set<string>,
    features: any[],
    shapeInfo?: {
      type: 'circle' | 'polygon',
      center?: L.LatLng,
      radius?: number,
      points?: L.LatLng[]
    }
  } | null>(null)

  // 监听mapDragTool变化，当激活拖拽工具时保留选中状态
  useEffect(() => {
    const prevMapDragTool = prevMapDragToolRef.current
    prevMapDragToolRef.current = mapDragTool

    // 检测mapDragTool从false变为true，表示用户点击了拖拽按钮
    if (!prevMapDragTool && mapDragTool) {
      // 在清除选中状态之前，保存当前选中状态和图形
      console.log('[OnlineMap] 检测到拖拽工具激活，检查是否需要保存选中状态，选中要素数量:', selectedIdsRef.current.size)
      if (selectedIdsRef.current.size > 0) {
        // 收集框选图形信息
        let shapeInfo: { type: 'circle' | 'polygon', center?: L.LatLng, radius?: number, points?: L.LatLng[] } | undefined

        if (selectionShapeRef.current) {
          if (selectionShapeRef.current instanceof L.Circle) {
            shapeInfo = {
              type: 'circle',
              center: selectionShapeRef.current.getLatLng(),
              radius: selectionShapeRef.current.getRadius()
            }
          } else if (selectionShapeRef.current instanceof L.Polygon) {
            const latLngs = selectionShapeRef.current.getLatLngs()[0] as L.LatLng[]
            shapeInfo = {
              type: 'polygon',
              points: latLngs
            }
          }
        }

        // 保存当前选中状态到临时存储
        preservedSelectionRef.current = {
          ids: new Set(selectedIdsRef.current),
          features: [...selectedFeaturesRef.current],
          shapeInfo
        }
        // 设置保留标志
        preserveSelectionRef.current = true
        console.log('[OnlineMap] 保存选中状态和图形信息', { shapeType: shapeInfo?.type })
      }
    } else if (prevMapDragTool && !mapDragTool) {
      // 拖拽工具被禁用时，清除临时存储
      preservedSelectionRef.current = null
    }
  }, [mapDragTool])

  // 监听selectionMode变化，处理退出框选模式时的清除逻辑
  useEffect(() => {
    const isSelectionActive = selectionMode !== 'none'

    // 退出框选模式时，根据preserveSelection决定是否清除选中状态
    if (!isSelectionActive) {
      // 使用 ref 来判断，因为 state 更新是异步的
      const shouldPreserve = preserveSelectionRef.current
      if (!shouldPreserve) {
        // 退出框选模式时，保留已圈选的图形和高亮（标记持久化，只有清除按钮才删除）
        // 只清除工具提示，不清除图形和高亮
        console.log('[OnlineMap] 退出框选模式，保留圈选图形（标记持久化）')
        setSelectionTip('')
      } else {
        // 保留选中状态，恢复之前保存的状态
        console.log('[OnlineMap] 退出框选模式，保留选中状态')
        if (preservedSelectionRef.current) {
          // 恢复保存的选中状态
          selectedIdsRef.current = preservedSelectionRef.current.ids
          selectedFeaturesRef.current = preservedSelectionRef.current.features
          console.log('[OnlineMap] 恢复选中状态，选中要素数量:', selectedIdsRef.current.size)
          // 重新应用高亮
          mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
            mapInfoLayer.setSelectionHighlight(selectedIdsRef.current)
          })
          if (lteSectorLayerRef.current) {
            lteSectorLayerRef.current.setSelectionHighlight(selectedIdsRef.current)
          }
          if (nrSectorLayerRef.current) {
            nrSectorLayerRef.current.setSelectionHighlight(selectedIdsRef.current)
          }

          // 恢复框选图形
          const map = mapInstanceRef.current
          const shapeInfo = preservedSelectionRef.current.shapeInfo
          if (map && shapeInfo) {
            const L = window.L
            // 先清除现有的框选图形
            if (selectionShapeRef.current) {
              map.removeLayer(selectionShapeRef.current)
              selectionShapeRef.current = null
            }

            if (shapeInfo.type === 'circle' && shapeInfo.center && shapeInfo.radius) {
              // 恢复圆形框选图形
              selectionShapeRef.current = L.circle(shapeInfo.center, {
                radius: shapeInfo.radius,
                color: '#00ffff',
                weight: 2,
                fillColor: '#00ffff',
                fillOpacity: 0.1
              }).addTo(map)
              console.log('[OnlineMap] 恢复圆形框选图形，半径:', shapeInfo.radius)
            } else if (shapeInfo.type === 'polygon' && shapeInfo.points && shapeInfo.points.length >= 3) {
              // 恢复多边形框选图形
              selectionShapeRef.current = L.polygon(shapeInfo.points, {
                color: '#00ffff',
                weight: 2,
                fillColor: '#00ffff',
                fillOpacity: 0.1
              }).addTo(map)
              console.log('[OnlineMap] 恢复多边形框选图形，顶点数:', shapeInfo.points.length)
            }
          }
        }
        // 更新提示
        if (selectedIdsRef.current.size > 0) {
          setSelectionTip(`${t('map.featuresSelected', { count: selectedIdsRef.current.size })}，${t('map.copyTip') || '按 Ctrl+C 复制'}`)
        } else {
          setSelectionTip('')
        }
      }
    } else {
      // 进入框选模式时，重置保留状态标志和临时存储
      preserveSelectionRef.current = false
      preservedSelectionRef.current = null
    }
  }, [selectionMode])

  // 扇区图层引用
  const lteSectorLayerRef = useRef<SectorSVGLayer | null>(null)
  const nrSectorLayerRef = useRef<SectorSVGLayer | null>(null)

  // MapInfo图层管理器引用
  const mapInfoLayerManagerRef = useRef<MapInfoLayerManager | null>(null)

  // 地理化数据图层管理器引用
  const geoDataLayerManagerRef = useRef<GeoDataLayerManager | null>(null)

  // 高亮配置Refs
  const pciHighlightConfigRef = useRef<PCIHighlightConfig | null>(null)
  const neighborHighlightConfigRef = useRef<NeighborHighlightConfig | null>(null)
  const tacHighlightConfigRef = useRef<TACHighlightConfig | null>(null)

  // 已加载的MapInfo图层ID集合（用于避免重复加载）
  const loadedMapInfoLayersRef = useRef<Set<string>>(new Set())

  // MapInfo图层对象映射 - 存储图层实例和Leaflet图层引用
  const mapInfoLayerRefsRef = useRef<Map<string, { mapInfoLayer: MapInfoLayer, leafletLayer: L.Layer }>>(new Map())

  // 点文件数据存储（用于属性标签渲染）
  const pointFileDataRef = useRef<Map<string, any[]>>(new Map())

  // 点文件标签标记映射
  const pointFileLabelMarkersRef = useRef<Map<string, L.Marker[]>>(new Map())

  // 扇区信息面板
  const {
    selectedSector,
    panelVisible,
    clickPosition,
    showSectorInfo,
    hideSectorInfo,
    onPanelMouseEnter,
    onPanelMouseLeave
  } = useSectorInfoPanel()

  // 要素信息面板 (MapInfo/地理化点文件)
  const {
    featureProperties,
    featurePanelVisible,
    featureTitle,
    featureClickPosition,
    showFeatureInfo,
    hideFeatureInfo
  } = useFeatureInfoPanel()

  // 移除悬停状态管理，改为仅使用点击事件显示属性

  // State
  const [loading, setLoading] = useState(true)
  const [isMapInitialized, setIsMapInitialized] = useState(false)
  const [mapLayerType, setMapLayerType] = useState<MapLayerType>(() => mapStateService.getState().mapLayerType)
  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>(initialLayerVisibility)

  // 网络错误状态
  const [networkError, setNetworkError] = useState<{
    visible: boolean
    message: string
    canRetry: boolean
  }>({
    visible: false,
    message: '',
    canRetry: false
  })

  // 监听 networkError 状态变化（调试用）
  useEffect(() => {
    console.log('[OnlineMap] networkError 状态变化:', networkError)
  }, [networkError])

  // 重试初始化地图的函数
  const retryInitMap = useCallback(() => {
    // 隐藏错误提示
    setNetworkError({ ...networkError, visible: false })
    // 重置网络错误相关的 ref
    hasLoadedAnyTileRef.current = false
    hasNetworkErrorRef.current = false
    // 重置初始化状态，允许重新初始化
    initializedRef.current = false
    isInitializingRef.current = false
    setLoading(true)

    // 触发重新初始化 - 通过强制重新加载组件的方式
    // 由于地图初始化逻辑在 useEffect 中，我们需要重新挂载组件
    // 这里使用一个简单的 hack：触发状态更新来重新执行 useEffect
    window.location.reload()
  }, [networkError])
  
  // 图层可见性Ref - 用于在回调中获取最新的图层可见性状态
  const layerVisibilityRef = useRef<LayerVisibility>(layerVisibility)
  useEffect(() => { layerVisibilityRef.current = layerVisibility }, [layerVisibility])
  const [labelVisibility, setLabelVisibility] = useState<LayerVisibility>({
    lte: false,
    nr: false
  })
  // 点文件标签可见性（撒点文件的属性标签）
  const [pointFileLabelVisibility, setPointFileLabelVisibilityState] = useState<Record<string, boolean>>({})
  const [sectorData, setSectorData] = useState<{
    lte: RenderSectorData[]
    nr: RenderSectorData[]
  }>({ lte: [], nr: [] })

  // 底图可见性状态 - 用于控制背景颜色
  const [baseMapVisible, setBaseMapVisibleState] = useState(true)

  // 测量相关状态
  const [measurePoints, setMeasurePoints] = useState<Array<{ lng: number; lat: number }>>([])

  // 重叠扇区选择状态
  const [overlappingSectors, setOverlappingSectors] = useState<RenderSectorData[]>([])
  const [overlapPosition, setOverlapPosition] = useState<{ x: number, y: number } | null>(null)


  /**
   * 暴露方法给父组件
   */
  useImperativeHandle(ref, () => ({
    flyTo: (latLng: [number, number], zoom = 14, duration = 1.5) => {
      if (mapInstanceRef.current) {
        isUserInteractingRef.current = true
        if (duration === 0) {
          mapInstanceRef.current.setView(latLng, zoom)
        } else {
          mapInstanceRef.current.flyTo(latLng, zoom, { duration })
        }
      }
    },

    fitBounds: (latLngs: Array<[number, number]>, padding: [number, number] = [50, 50]) => {
      if (mapInstanceRef.current && latLngs.length > 0) {
        isUserInteractingRef.current = true
        const bounds = L.latLngBounds(latLngs)
        mapInstanceRef.current.fitBounds(bounds, { padding: [padding[0], padding[1]] })
      }
    },

    setSearchMarker: (marker: SearchMarker | null) => {
      if (!mapInstanceRef.current || !window.L) return

      const L = window.L

      // 添加新的搜索标记
      if (marker) {
        const icon = L.divIcon({
          html: `<div style="background-color: #ef4444; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid white; box-shadow: 0 1px 3px rgba(0,0,0,0.3);"></div>`,
          className: 'search-marker-icon',
          iconSize: [8, 8],
          iconAnchor: [4, 4]
        })

        const mapMarker = L.marker([marker.lat, marker.lng], { icon })
          .addTo(mapInstanceRef.current)

        // 将GCJ02坐标转换为WGS84坐标，以便显示准确的标准坐标
        const [wgsLat, wgsLng] = CoordinateTransformer.gcj02ToWgs84(marker.lat, marker.lng)

        const popupContent = `
          <div style="padding: 8px; min-width: 150px;">
            <h3 style="margin: 0 0 5px 0; font-size: 14px; color: #ef4444;">${marker.name}</h3>
            <p style="margin: 0; font-size: 12px; color: #666;">
              ${wgsLat.toFixed(6)}, ${wgsLng.toFixed(6)}
            </p>
          </div>
        `
        mapMarker.bindPopup(popupContent).openPopup()
        searchMarkerRef.current.push(mapMarker) // 添加到数组中，支持多个标记
      }
    },

    clearSearchMarker: () => {
      if (!mapInstanceRef.current) return

      // 移除所有搜索标记
      searchMarkerRef.current.forEach(marker => {
        mapInstanceRef.current?.removeLayer(marker)
      })
      searchMarkerRef.current = [] // 清空数组
    },

    setLayerVisibility: (layer: 'lte' | 'nr', visible: boolean) => {
      setLayerVisibility(prev => ({ ...prev, [layer]: visible }))
    },

    setSectorLabelVisibility: (layer: 'lte' | 'nr', visible: boolean) => {
      console.log('[OnlineMap] setSectorLabelVisibility called:', layer, visible)
      setLabelVisibility(prev => ({ ...prev, [layer]: visible }))
    },

    setPointFileLabelVisibility: (fileId: string, visible: boolean) => {
      console.log('[OnlineMap] setPointFileLabelVisibility called:', fileId, visible)
      setPointFileLabelVisibilityState(prev => ({ ...prev, [fileId]: visible }))

      // 1. 优先处理 MapInfoLayer（MapInfo 文件）
      const layerRef = mapInfoLayerRefsRef.current.get(fileId)
      if (layerRef) {
        layerRef.mapInfoLayer.setLabelVisibility(visible)
        return
      }

      // 2. 处理 GeoDataLayer（地理化数据：点状、扇区或多边形）
      if (geoDataLayerManagerRef.current) {
        const geoLayer = geoDataLayerManagerRef.current.getLayer(fileId)
        if (geoLayer) {
          console.log('[OnlineMap] GeoDataLayer 标签可见性切换:', fileId, visible)
          geoLayer.setLabelVisibility(visible)
          return
        }
      }

      console.log('[OnlineMap] setPointFileLabelVisibility: 未找到图层:', fileId)
    },

    setMapInfoLayerVisibility: (layerId: string, visible: boolean) => {
      console.log('[OnlineMap] setMapInfoLayerVisibility called:', { layerId, visible })

      // 先检查是否是 GeoDataLayer（扇区或多边形类型）
      if (geoDataLayerManagerRef.current) {
        const geoLayer = geoDataLayerManagerRef.current.getLayer(layerId)
        if (geoLayer) {
          console.log('[OnlineMap] GeoDataLayer 可见性切换:', layerId, visible)
          if (mapInstanceRef.current) {
            geoLayer.setVisible(mapInstanceRef.current, visible)
          }
          return
        }
      }

      // 处理 MapInfoLayer
      const layerRef = mapInfoLayerRefsRef.current.get(layerId)
      if (layerRef && mapInstanceRef.current) {
        if (visible) {
          // 使用 MapInfoLayer 的 addTo 方法而不是直接添加 Leaflet 图层
          // 这样可以正确设置 currentMap 引用，使标签功能能够工作
          layerRef.mapInfoLayer.addTo(mapInstanceRef.current)
        } else {
          // 使用 MapInfoLayer 的 remove 方法而不是直接移除 Leaflet 图层
          // 这样可以正确清理标签和其他资源
          layerRef.mapInfoLayer.remove(mapInstanceRef.current)
        }
      }
    },

    setMapType: (type: 'roadmap' | 'satellite') => {
      console.log('[OnlineMap] setMapType called with type:', type)
      setMapLayerType(type)
      mapStateService.setState({ mapLayerType: type })
      // 图层更新由useEffect钩子统一处理，不直接操作图层
    },

    setLayerFileLabelVisibility: (fileId: string, visible: boolean, settings: any) => {
      console.log('[OnlineMap] setLayerFileLabelVisibility:', fileId, visible, settings)
      setPointFileLabelVisibilityState(prev => ({ ...prev, [fileId]: visible }))

      // 1. 优先处理 MapInfoLayer（MapInfo 文件）
      const layerRef = mapInfoLayerRefsRef.current.get(fileId)
      if (layerRef) {
        layerRef.mapInfoLayer.setLabelVisibility(visible)
        if (settings) {
          layerRef.mapInfoLayer.setLabelConfig(settings)
        }
        return
      }

      // 2. 处理 GeoDataLayer（地理化数据：点状、扇区或多边形）
      if (geoDataLayerManagerRef.current) {
        const geoLayer = geoDataLayerManagerRef.current.getLayer(fileId)
        if (geoLayer) {
          console.log('[OnlineMap] GeoDataLayer 标签可见性切换:', fileId, visible)
          geoLayer.setLabelVisibility(visible)
          if (settings) {
            console.log('[OnlineMap] GeoDataLayer 应用标签配置:', settings)
            geoLayer.setLabelConfig(settings)
          }
          return
        }
      }

      console.log('[OnlineMap] ⚠️ 未找到图层:', fileId)
    },

    toggleMapType: () => {
      toggleMapType()
    },

    setFrequencyVisibility: (networkType: 'LTE' | 'NR', frequency: number, visible: boolean) => {
      console.log('[OnlineMap] setFrequencyVisibility called:', networkType, frequency, visible)
      if (networkType === 'LTE' && lteSectorLayerRef.current) {
        lteSectorLayerRef.current.setFrequencyVisibility(frequency, visible)
      } else if (networkType === 'NR' && nrSectorLayerRef.current) {
        nrSectorLayerRef.current.setFrequencyVisibility(frequency, visible)
      }
    },

    setCustomLayerVisibility: (layerId: string, visible: boolean) => {
      setCustomLayerVisibilityState(prev => ({
        ...prev,
        [layerId]: visible
      }))
    },

    setDecorationLayerVisibility: (visible: boolean) => {
      setDecorationLayerVisibility(visible)
    },

    setBaseMapVisibility: (visible: boolean) => {
      console.log('[OnlineMap] setBaseMapVisibility called:', visible)
      setBaseMapVisibleState(visible)  // 更新本地状态
      if (!mapInstanceRef.current || !tileLayerRef.current) return

      if (visible) {
        // 显示底图：恢复瓦片图层，清除 Leaflet 容器背景色
        if (!mapInstanceRef.current.hasLayer(tileLayerRef.current)) {
          tileLayerRef.current.addTo(mapInstanceRef.current)
        }
        mapInstanceRef.current.getContainer().style.backgroundColor = ''
      } else {
        // 空地图模式：隐藏瓦片图层，设置 Leaflet 容器背景为白色
        if (mapInstanceRef.current.hasLayer(tileLayerRef.current)) {
          mapInstanceRef.current.removeLayer(tileLayerRef.current)
        }
        // 直接在 Leaflet 容器上设置白色背景，避免默认灰色透出
        mapInstanceRef.current.getContainer().style.backgroundColor = '#ffffff'
      }
    },

    refreshData: async () => {
      await loadSectorData(true)
    },

    addLocationMarker: (marker: LocationMarker, index: number) => {
      if (!mapInstanceRef.current || !window.L) return

      const L = window.L
      const map = mapInstanceRef.current
      const locationId = `location-${marker.id}`

      // 生成默认标签名（如"定位1"、"定位2"）
      const defaultLabel = `${t('map.locationPoint') || '定位'}${index}`

      // 创建定位标记图标 - 与抓取坐标小圆点样式一致：纯色红圆点
      const icon = L.divIcon({
        html: `<div style="background:#ef4444;width:16px;height:16px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.3);"></div>`,
        className: 'location-marker-icon',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      })

      // 创建标记
      const mapMarker = L.marker([marker.lat, marker.lng], { icon })

      // 存储属性数据到 marker 上，供圈选工具读取
      ;(mapMarker as any).captureProperties = {
        id: locationId,
        name: defaultLabel,  // 使用默认标签名作为名称
        标签: defaultLabel,  // 添加标签字段
        longitude: marker.lng.toFixed(6),
        latitude: marker.lat.toFixed(6),
        lng: marker.lng.toFixed(6),
        lat: marker.lat.toFixed(6),
        _layerType: 'LocationPoint'
      }

      // 保存默认标签到 markerLabelsRef
      markerLabelsRef.current.set(locationId, {
        id: locationId,
        name: locationId,
        label: defaultLabel
      })

      // 始终添加到装饰图层（装饰图层会自动处理可见性）
      if (decorationLayerRef.current) {
        mapMarker.addTo(decorationLayerRef.current)
      } else {
        mapMarker.addTo(map)
      }

      // 立即显示默认标签
      updateMarkerLabel(locationId, index, defaultLabel, marker.lat, marker.lng)

      // 左键点击：弹出可编辑属性框
      mapMarker.on('click', () => {
        const labelData = markerLabelsRef.current.get(locationId)
        const currentLabel = labelData?.label || defaultLabel
        const inputId = `location-label-input-${locationId}`
        const lngInputId = `location-lng-input-${locationId}`
        const latInputId = `location-lat-input-${locationId}`
        const inputStyle = `padding:4px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;width:100%;color:#111;outline:none;font-family:monospace;`
        const inputFocus = `onfocus="this.style.borderColor='#3b82f6';this.style.boxShadow='0 0 0 2px rgba(59,130,246,0.2)'" onblur="this.style.borderColor='#d1d5db';this.style.boxShadow='none'"`
        const deleteBtnText = t('map.delete') || '删除'
        const copyBtnText = t('map.copy') || '复制'
        const propertiesText = t('map.properties') || '属性'
        const labelNameText = t('map.labelName') || '标签'
        const longitudeText = t('map.longitude') || '经度'
        const latitudeText = t('map.latitude') || '纬度'
        const confirmBtnText = t('common.confirm') || '确定'

        const popupContent = `
          <div style="padding:10px 12px;min-width:280px;background:#fff;color:#000;border:1px solid #d1d5db;border-radius:8px;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);" onclick="event.stopPropagation()">
            <div style="font-size:14px;font-weight:600;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #e5e7eb;color:#111;">${propertiesText}</div>
            <div style="display:grid;grid-template-columns:50px 1fr;gap:8px 12px;align-items:center;line-height:1.6;">
              <span style="color:#888;font-size:11px;">${labelNameText}</span>
              <input id="${inputId}" type="text" value="${currentLabel.replace(/"/g, '&quot;')}"
                style="${inputStyle}" ${inputFocus} />
              <span style="color:#888;font-size:11px;">${longitudeText}</span>
              <input id="${lngInputId}" type="text" value="${marker.lng.toFixed(6)}"
                style="${inputStyle}" ${inputFocus} />
              <span style="color:#888;font-size:11px;">${latitudeText}</span>
              <input id="${latInputId}" type="text" value="${marker.lat.toFixed(6)}"
                style="${inputStyle}" ${inputFocus} />
            </div>
            <div style="margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb;display:flex;justify-content:flex-end;gap:8px;">
              <button class="confirm-btn" style="background:#22c55e;border:1px solid #22c55e;cursor:pointer;color:#fff;font-size:12px;padding:4px 14px;border-radius:4px;transition:all 0.15s;">${confirmBtnText}</button>
              <button class="cp-all-btn" style="background:#3b82f6;border:1px solid #3b82f6;cursor:pointer;color:#fff;font-size:12px;padding:4px 14px;border-radius:4px;transition:all 0.15s;">${copyBtnText}</button>
              <button class="del-btn" style="background:#ef4444;border:1px solid #ef4444;cursor:pointer;color:#fff;font-size:12px;padding:4px 14px;border-radius:4px;transition:all 0.15s;">${deleteBtnText}</button>
            </div>
          </div>
        `

        // 每次都先解绑再重新绑定，确保 popup 状态干净
        mapMarker.unbindPopup()
        mapMarker.bindPopup(popupContent, {
          className: 'capture-popup-white',
          closeButton: true,
          autoPan: true,
          offset: [0, -20]
        }).openPopup()

        // 绑定事件
        setTimeout(() => {
          // 复制按钮事件 — 制表符分隔（粘贴到Excel为横向3列）
          document.querySelectorAll('.capture-popup-white .cp-all-btn').forEach(btn => {
            btn.addEventListener('click', function(this: HTMLButtonElement) {
              const labelInput = document.getElementById(inputId) as HTMLInputElement
              const lngInput = document.getElementById(lngInputId) as HTMLInputElement
              const latInput = document.getElementById(latInputId) as HTMLInputElement
              const labelVal = labelInput?.value.trim() || currentLabel
              const lngVal = lngInput?.value.trim() || marker.lng.toFixed(6)
              const latVal = latInput?.value.trim() || marker.lat.toFixed(6)
              const allText = `${labelVal}\t${lngVal}\t${latVal}`
              navigator.clipboard.writeText(allText).then(() => {
                this.textContent = (window as any).__gsdT?.('map.copied') || '已复制'
                this.style.background = '#16a34a'
                this.style.borderColor = '#16a34a'
                setTimeout(() => {
                  this.textContent = (window as any).__gsdT?.('map.copy') || '复制'
                  this.style.background = '#3b82f6'
                  this.style.borderColor = '#3b82f6'
                }, 1200)
              })
            })
          })

          // 删除按钮事件
          document.querySelectorAll('.capture-popup-white .del-btn').forEach(btn => {
            btn.addEventListener('click', function(this: HTMLButtonElement) {
              // 关闭弹框
              mapMarker.closePopup()
              // 移除地图标记
              map.removeLayer(mapMarker)
              // 移除标签标记
              const labelMarker = markerLabelElementsRef.current.get(locationId)
              if (labelMarker) {
                map.removeLayer(labelMarker)
                markerLabelElementsRef.current.delete(locationId)
              }
              // 清除数据
              markerLabelsRef.current.delete(locationId)
              // 从数组中移除引用
              const idx = mapMarkersRef.current.findIndex(m => m === mapMarker)
              if (idx > -1) {
                mapMarkersRef.current.splice(idx, 1)
              }
            })
          })

          // 确定按钮事件 — 触发输入保存并关闭弹窗
          document.querySelectorAll('.capture-popup-white .confirm-btn').forEach(btn => {
            btn.addEventListener('click', function() {
              const labelInput = document.getElementById(inputId) as HTMLInputElement
              labelInput?.focus()
              labelInput?.blur()
              const lngInput = document.getElementById(lngInputId) as HTMLInputElement
              lngInput?.blur()
              const latInput = document.getElementById(latInputId) as HTMLInputElement
              latInput?.blur()
              mapMarker.closePopup()
            })
          })

          // 标签输入框保存事件
          const input = document.getElementById(inputId) as HTMLInputElement
          if (!input) return

          const saveLabel = () => {
            const newLabel = input.value.trim() || defaultLabel
            markerLabelsRef.current.set(locationId, {
              id: locationId,
              name: locationId,
              label: newLabel
            })
            const props = (mapMarker as any).captureProperties
            if (props) {
              props.name = newLabel
              props.标签 = newLabel
            }
            updateMarkerLabel(locationId, index, newLabel, marker.lat, marker.lng)
          }

          // 经度输入框保存事件
          const lngInput = document.getElementById(lngInputId) as HTMLInputElement
          if (lngInput) {
            const saveLng = () => {
              const val = parseFloat(lngInput.value.trim())
              if (!isNaN(val)) {
                const props = (mapMarker as any).captureProperties
                if (props) {
                  props.longitude = val.toFixed(6)
                  props.lng = val.toFixed(6)
                }
              }
            }
            lngInput.addEventListener('blur', saveLng)
            lngInput.addEventListener('keydown', (e: KeyboardEvent) => {
              if (e.key === 'Enter') { e.preventDefault(); saveLng(); lngInput.blur() }
            })
          }

          // 纬度输入框保存事件
          const latInput = document.getElementById(latInputId) as HTMLInputElement
          if (latInput) {
            const saveLat = () => {
              const val = parseFloat(latInput.value.trim())
              if (!isNaN(val)) {
                const props = (mapMarker as any).captureProperties
                if (props) {
                  props.latitude = val.toFixed(6)
                  props.lat = val.toFixed(6)
                }
              }
            }
            latInput.addEventListener('blur', saveLat)
            latInput.addEventListener('keydown', (e: KeyboardEvent) => {
              if (e.key === 'Enter') { e.preventDefault(); saveLat(); latInput.blur() }
            })
          }

          input.addEventListener('blur', saveLabel)
          input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              saveLabel()
              input.blur()
            }
          })
          input.focus()
          input.select()
        }, 100)
      })

      // 右键点击：阻止默认行为（不再弹出编辑框，编辑已整合到左键属性框）
      mapMarker.on('contextmenu', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e)
        L.DomEvent.preventDefault(e)
      })

      // 添加到定位标记数组
      locationMarkersRef.current.push(mapMarker)
    },

    clearLocationMarkers: () => {
      if (!mapInstanceRef.current) return

      // 从装饰图层中移除所有定位标记及其标签
      locationMarkersRef.current.forEach(marker => {
        // 获取标记的ID以清除对应的标签
        const props = (marker as any).captureProperties
        if (props?.id) {
          const labelMarker = markerLabelElementsRef.current.get(props.id)
          if (labelMarker) {
            if (decorationLayerRef.current) {
              decorationLayerRef.current.removeLayer(labelMarker)
            }
            mapInstanceRef.current?.removeLayer(labelMarker)
            markerLabelElementsRef.current.delete(props.id)
          }
          markerLabelsRef.current.delete(props.id)
        }

        if (decorationLayerRef.current) {
          decorationLayerRef.current.removeLayer(marker)
        }
        mapInstanceRef.current?.removeLayer(marker)
      })
      locationMarkersRef.current = []
    },

    clearMeasurements: () => {
      if (!mapInstanceRef.current) return

      // 移除所有测量线条
      measurementLinesRef.current.forEach(line => {
        mapInstanceRef.current?.removeLayer(line)
      })
      measurementLinesRef.current = []

      // 移除所有测量点标记
      measurementMarkersRef.current.forEach(marker => {
        mapInstanceRef.current?.removeLayer(marker)
      })
      measurementMarkersRef.current = []
      measurementLineStartIndexRef.current = 0
      measurementMarkerStartIndexRef.current = 0

      // 移除距离显示标签
      if (measurementDistanceRef.current) {
        mapInstanceRef.current.removeLayer(measurementDistanceRef.current)
        measurementDistanceRef.current = null
      }

      // 清除当前绘制中的点数据，避免残留旧点污染新测量
      setMeasurePoints([])
      measurePointsRef.current = []

      // 清除预览虚线和标签
      if (shadowLineRef.current) {
        mapInstanceRef.current.removeLayer(shadowLineRef.current)
        shadowLineRef.current = null
      }
      if (shadowLabelRef.current) {
        mapInstanceRef.current.removeLayer(shadowLabelRef.current)
        shadowLabelRef.current = null
      }
    },

    setNeighborHighlight: (config: NeighborHighlightConfig | null) => {
      neighborHighlightConfigRef.current = config
      if (lteSectorLayerRef.current) {
        lteSectorLayerRef.current.setNeighborHighlightMode(config)
      }
      if (nrSectorLayerRef.current) {
        nrSectorLayerRef.current.setNeighborHighlightMode(config)
      }
    },

    clearNeighborHighlight: () => {
      neighborHighlightConfigRef.current = null
      if (lteSectorLayerRef.current) {
        lteSectorLayerRef.current.setNeighborHighlightMode(null)
      }
      if (nrSectorLayerRef.current) {
        nrSectorLayerRef.current.setNeighborHighlightMode(null)
      }
    },

    setSectorIdWhitelist: (whitelist: Set<string> | null, mode: 'pci-planning' | 'neighbor-planning' | 'tac-check', networkType?: 'LTE' | 'NR') => {
      console.log('[OnlineMap] setSectorIdWhitelist 调用', { whitelistCount: whitelist?.size, mode, networkType })

      // 只在PCI/邻区规划/TAC核查模式下处理
      if (mode !== 'pci-planning' && mode !== 'neighbor-planning' && mode !== 'tac-check') {
        console.log('[OnlineMap] 非PCI/邻区规划/TAC核查模式，忽略白名单设置')
        return
      }

      // 如果设置白名单（非null），需要加载对应的同步数据
      if (whitelist !== null) {
        if (mode === 'pci-planning') {
          // PCI模式：使用PCI数据同步服务，只加载指定网络类型的数据
          // 关键修复：使用 getUpdatedPCIData() 而不是 getSyncedData()
          // getUpdatedPCIData() 会将 syncedPCI 正确赋值给 pci 字段
          const updatedData = pciDataSyncService.getUpdatedPCIData()
          if (updatedData) {
            // 如果指定了网络类型，只加载该类型的数据；否则加载所有数据
            const loadLTE = !networkType || networkType === 'LTE'
            const loadNR = !networkType || networkType === 'NR'

            // 坐标转换（数据已经是更新后的PCI）
            const sectorData = {
              lte: loadLTE ? updatedData.lte.map(s => {
                const [displayLat, displayLng] = CoordinateTransformer.wgs84ToGcj02(s.latitude || 0, s.longitude || 0)
                return { ...s, displayLat, displayLng }
              }) : [],
              nr: loadNR ? updatedData.nr.map(s => {
                const [displayLat, displayLng] = CoordinateTransformer.wgs84ToGcj02(s.latitude || 0, s.longitude || 0)
                return { ...s, displayLat, displayLng }
              }) : []
            }
            // 记录数据验证信息
            const sectorIdsInData = {
              lte: sectorData.lte.map(s => s.id),
              nr: sectorData.nr.map(s => s.id)
            }
            console.log('[OnlineMap] PCI模式加载扇区数据（使用更新后的PCI）', {
              loadLTE, loadNR,
              lteCount: sectorData.lte.length,
              nrCount: sectorData.nr.length,
              networkType,
              sampleLteIds: sectorIdsInData.lte.slice(0, 5),
              sampleNrIds: sectorIdsInData.nr.slice(0, 5)
            })
            setSectorData(sectorData)

            // 延迟应用高亮，只对加载的图层应用
            setTimeout(() => {
              if (pciHighlightConfigRef.current) {
                if (loadLTE && lteSectorLayerRef.current) lteSectorLayerRef.current.setPCIHighlightMode(pciHighlightConfigRef.current)
                if (loadNR && nrSectorLayerRef.current) nrSectorLayerRef.current.setPCIHighlightMode(pciHighlightConfigRef.current)
              }
            }, 100)
          }
        } else if (mode === 'neighbor-planning') {
          // 邻区规划模式：使用全量工参数据
          const fullParamsData = neighborDataSyncService.getFullParamsData()
          if (fullParamsData) {
            const sectorData = {
              lte: initialLayerVisibility.lte ? fullParamsData.lte : [],
              nr: initialLayerVisibility.nr ? fullParamsData.nr : []
            }
            setSectorData(sectorData)

            // 延迟应用高亮
            setTimeout(() => {
              if (neighborHighlightConfigRef.current) {
                if (lteSectorLayerRef.current) lteSectorLayerRef.current.setNeighborHighlightMode(neighborHighlightConfigRef.current)
                if (nrSectorLayerRef.current) nrSectorLayerRef.current.setNeighborHighlightMode(neighborHighlightConfigRef.current)
              }
            }, 100)
          }
        } else if (mode === 'tac-check') {
          // TAC核查模式：从tacDataSyncService加载全量同步数据
          // 严格按网络类型过滤，不考虑 initialLayerVisibility
          const syncedData = tacDataSyncService.getSyncedData()
          if (syncedData) {
            // 必须指定网络类型，默认为 LTE
            const effectiveNetworkType = networkType || 'LTE'
            const loadLTE = effectiveNetworkType === 'LTE'
            const loadNR = effectiveNetworkType === 'NR'

            // 初始化/更新TAC高亮配置，包含网络类型信息，确保createSectorLayers能正确过滤图层
            // 保留当前选中的扇区ID，但更新网络类型
            const currentSelectedId = tacHighlightConfigRef.current?.selectedId || null
            tacHighlightConfigRef.current = {
              selectedId: currentSelectedId,
              networkType: effectiveNetworkType
            }
            console.log('[OnlineMap] 初始化TAC高亮配置', { networkType: effectiveNetworkType, previousSelectedId: currentSelectedId })

            const sectorDataToLoad = {
              lte: loadLTE
                ? syncedData.lte.map(s => {
                  const [displayLat, displayLng] = CoordinateTransformer.wgs84ToGcj02(s.latitude || 0, s.longitude || 0)
                  return { ...s, displayLat, displayLng }
                })
                : [],
              nr: loadNR
                ? syncedData.nr.map(s => {
                  const [displayLat, displayLng] = CoordinateTransformer.wgs84ToGcj02(s.latitude || 0, s.longitude || 0)
                  return { ...s, displayLat, displayLng }
                })
                : []
            }
            console.log('[OnlineMap] TAC核查模式加载扇区数据', {
              networkType: effectiveNetworkType,
              loadLTE,
              loadNR,
              lteCount: sectorDataToLoad.lte.length,
              nrCount: sectorDataToLoad.nr.length
            })
            setSectorData(sectorDataToLoad)

            // 延迟应用TAC高亮
            setTimeout(() => {
              if (tacHighlightConfigRef.current) {
                if (loadLTE && lteSectorLayerRef.current) lteSectorLayerRef.current.setTACHighlightMode(tacHighlightConfigRef.current)
                if (loadNR && nrSectorLayerRef.current) nrSectorLayerRef.current.setTACHighlightMode(tacHighlightConfigRef.current)
              }
            }, 100)
          }
        }
      }

      // 设置扇区图层的白名单和渲染模式
      // 对于PCI规划和TAC核查模式，只对加载的图层设置白名单
      if (mode === 'pci-planning' || mode === 'tac-check') {
        // 使用 effectiveNetworkType 确保正确过滤
        const effectiveNetworkType = networkType || 'LTE'
        const loadLTE = effectiveNetworkType === 'LTE'
        const loadNR = effectiveNetworkType === 'NR'

        if (loadLTE && lteSectorLayerRef.current) {
          lteSectorLayerRef.current.setSectorIdWhitelist(whitelist)
          lteSectorLayerRef.current.setRenderMode(mode as any)
        }
        if (loadNR && nrSectorLayerRef.current) {
          nrSectorLayerRef.current.setSectorIdWhitelist(whitelist)
          nrSectorLayerRef.current.setRenderMode(mode as any)
        }
      } else {
        // 其他模式：对所有图层设置白名单
        if (lteSectorLayerRef.current) {
          lteSectorLayerRef.current.setSectorIdWhitelist(whitelist)
          lteSectorLayerRef.current.setRenderMode(mode as any)
        }
        if (nrSectorLayerRef.current) {
          nrSectorLayerRef.current.setSectorIdWhitelist(whitelist)
          nrSectorLayerRef.current.setRenderMode(mode as any)
        }
      }
    },

    clearSectorIdWhitelist: () => {
      console.log('[OnlineMap] clearSectorIdWhitelist 调用')
      if (lteSectorLayerRef.current) {
        lteSectorLayerRef.current.setSectorIdWhitelist(null)
        lteSectorLayerRef.current.setRenderMode('default')
      }
      if (nrSectorLayerRef.current) {
        nrSectorLayerRef.current.setSectorIdWhitelist(null)
        nrSectorLayerRef.current.setRenderMode('default')
      }

      // 恢复默认展示数据
      loadSectorData()
    },

    setPCIHighlightMode: (config: PCIHighlightConfig | null) => {
      pciHighlightConfigRef.current = config
      if (lteSectorLayerRef.current) lteSectorLayerRef.current.setPCIHighlightMode(config)
      if (nrSectorLayerRef.current) nrSectorLayerRef.current.setPCIHighlightMode(config)
    },

    setTACHighlightMode: (config: TACHighlightConfig | null) => {
      tacHighlightConfigRef.current = config
      if (lteSectorLayerRef.current) lteSectorLayerRef.current.setTACHighlightMode(config)
      if (nrSectorLayerRef.current) nrSectorLayerRef.current.setTACHighlightMode(config)
    },

    clearPCIHighlight: () => {
      pciHighlightConfigRef.current = null
      if (lteSectorLayerRef.current) lteSectorLayerRef.current.setPCIHighlightMode(null)
      if (nrSectorLayerRef.current) nrSectorLayerRef.current.setPCIHighlightMode(null)
    },

    clearSelectionHighlight: () => {
      preserveSelectionRef.current = false // 清除保留状态标志
      // 清除选中状态
      selectedFeaturesRef.current = []
      selectedIdsRef.current = new Set()
      selectionPointsRef.current = []
      // 清除扇区图层高亮
      if (lteSectorLayerRef.current) lteSectorLayerRef.current.setSelectionHighlight(null)
      if (nrSectorLayerRef.current) nrSectorLayerRef.current.setSelectionHighlight(null)
      // 清除MapInfo图层高亮
      mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
        mapInfoLayer.setSelectionHighlight(null)
      })
      // 清除GeoDataLayer高亮
      if (geoDataLayerManagerRef.current) {
        geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
          geoLayer.setSelectionHighlight(null)
        })
      }
      // 清除框选形状（包括圆形/多边形框选图形和矩形框选图形）
      const map = mapInstanceRef.current
      if (map) {
        // 清除圆形/多边形选择形状（包括FeatureGroup中的多个形状）
        if (selectionShapeRef.current) {
          // 修复: map.removeLayer(FeatureGroup) 会自动移除其所有子图层
          // clearLayers() 会将子图层从Group移除但不会从Map移除，导致"清除"后轨迹残留
          map.removeLayer(selectionShapeRef.current)
          selectionShapeRef.current = null
        }
        // 清除矩形选择框（包括FeatureGroup中的多个矩形）
        if (selectionRectRef.current) {
          map.removeLayer(selectionRectRef.current)
          selectionRectRef.current = null
        }
        // 清除多边形临时绘制线
        if (polygonTempLayerRef.current) {
          map.removeLayer(polygonTempLayerRef.current)
          polygonTempLayerRef.current = null
        }
        if (dragPreviewRectRef.current) {
          map.removeLayer(dragPreviewRectRef.current)
          dragPreviewRectRef.current = null
        }
        if (dragPreviewCircleRef.current) {
          map.removeLayer(dragPreviewCircleRef.current)
          dragPreviewCircleRef.current = null
        }
      }
      setSelectionTip('')
    },

    setSelectionHighlight: (ids: Set<string> | null) => {
      if (lteSectorLayerRef.current) lteSectorLayerRef.current.setSelectionHighlight(ids)
      if (nrSectorLayerRef.current) nrSectorLayerRef.current.setSelectionHighlight(ids)
    },

    getPointFileData: () => {
      const data: Record<string, any[]> = {}
      pointFileDataRef.current.forEach((value, key) => {
        data[key] = value
      })
      return data
    },

    setSectorLabelSettings: (settings: any, layerId: string) => {
      console.log('[OnlineMap] setSectorLabelSettings:', layerId, settings)
      if (layerId === 'lte-sectors' && lteSectorLayerRef.current) {
        lteSectorLayerRef.current.updateLabelConfig(settings)
      } else if (layerId === 'nr-sectors' && nrSectorLayerRef.current) {
        nrSectorLayerRef.current.updateLabelConfig(settings)
      }
    },

    setLayerFileLabelSettings: (fileId: string, settings: any) => {
      console.log('[OnlineMap] setLayerFileLabelSettings:', fileId, settings)

      // 1. 优先处理 MapInfoLayer（MapInfo 文件）
      const layerRef = mapInfoLayerRefsRef.current.get(fileId)
      if (layerRef && layerRef.mapInfoLayer) {
        console.log('[OnlineMap] 设置 MapInfoLayer 标签配置')
        layerRef.mapInfoLayer.setLabelConfig(settings)
        return
      }

      // 2. 处理 GeoDataLayer（地理化数据：点状、扇区或多边形）
      if (geoDataLayerManagerRef.current) {
        const geoLayer = geoDataLayerManagerRef.current.getLayer(fileId)
        if (geoLayer) {
          console.log('[OnlineMap] 设置 GeoDataLayer 标签配置')
          geoLayer.setLabelConfig(settings)
          return
        }
      }

      console.log('[OnlineMap] setLayerFileLabelSettings: 未找到图层:', fileId)
    },

    setMeasureMode: (enabled: boolean) => {
      console.log('[OnlineMap] setMeasureMode:', enabled)
      measureModeRef.current = enabled
      // useEffect hook会自动处理扇区图层的测距模式更新
    },

    clearCaptureMarkers: () => {
      if (!mapInstanceRef.current) return
      captureMarkersRef.current.forEach(marker => {
        // 获取标记的ID以清除对应的标签
        const props = (marker as any).captureProperties
        if (props?.id) {
          const labelMarker = markerLabelElementsRef.current.get(props.id)
          if (labelMarker) {
            if (decorationLayerRef.current) {
              decorationLayerRef.current.removeLayer(labelMarker)
            }
            mapInstanceRef.current?.removeLayer(labelMarker)
            markerLabelElementsRef.current.delete(props.id)
          }
          markerLabelsRef.current.delete(props.id)
        }

        // 从装饰图层中移除
        if (decorationLayerRef.current) {
          decorationLayerRef.current.removeLayer(marker)
        }
        mapInstanceRef.current?.removeLayer(marker)
      })
      captureMarkersRef.current = []
    }
  }))

  /**
   * 加载扇区数据（不自动调整地图位置）
   */
  const loadSectorData = useCallback(async (forceRefresh = false) => {
    try {
      // 邻区规划模式：如果同步服务中有过滤后的数据，优先使用过滤数据
      if (mode === 'neighbor-planning') {
        const neighborData = neighborDataSyncService.getFullParamsData()
        if (neighborData) {
          setSectorData({
            lte: neighborData.lte,
            nr: neighborData.nr
          })
          console.log('[OnlineMap] 邻区规划模式使用过滤后的扇区数据:', {
            lte: neighborData.lte.length,
            nr: neighborData.nr.length
          })
          return
        }
      }

      const zoom = mapInstanceRef.current?.getZoom() ?? mapStateService.getState().zoom
      const data = await mapDataService.getMapData(zoom, forceRefresh)

      setSectorData({
        lte: data.lteSectors,
        nr: data.nrSectors
      })

      console.log('[OnlineMap] 扇区数据加载完成:', {
        lte: data.lteSectors.length,
        nr: data.nrSectors.length
      })
    } catch (error) {
      console.error('[OnlineMap] 加载扇区数据失败:', error)
    }
  }, [mode])

  /**
   * 处理扇区点击事件 - 支持重叠扇区选择
   */
  const handleSectorClick = useCallback((sector: RenderSectorData, event: L.LeafletMouseEvent) => {
    // 拖拽工具激活时不处理扇区点击，只允许地图拖拽
    if (mapDragTool) return;
    // 测距模式、圈选模式或打点模式下不显示扇区属性
    if (measureModeRef.current || selectionModeRef.current !== 'none' || captureModeRef.current) return;

    // PCI规划模式下不显示扇区属性面板，只调用点击回调
    if (mode === 'pci-planning') {
      if (onSectorClick) {
        onSectorClick(sector)
      }
      return
    }

    // 获取点击位置
    const clientX = event.originalEvent.clientX
    const clientY = event.originalEvent.clientY

    // 从所有可见图层中获取该位置的所有扇区
    const allOverlapping: RenderSectorData[] = []

    if (lteSectorLayerRef.current && layerVisibility.lte) {
      allOverlapping.push(...lteSectorLayerRef.current.getSectorsAt(clientX, clientY))
    }

    if (nrSectorLayerRef.current && layerVisibility.nr) {
      allOverlapping.push(...nrSectorLayerRef.current.getSectorsAt(clientX, clientY))
    }

    // 过滤并去重
    const uniqueOverlapping = allOverlapping.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i)

    if (uniqueOverlapping.length > 1) {
      setOverlappingSectors(uniqueOverlapping)
      setOverlapPosition({ x: clientX, y: clientY })
    } else {
      showSectorInfo(sector, event)
    }

    if (onSectorClick) {
      onSectorClick(sector)
    }
  }, [mapDragTool, showSectorInfo, layerVisibility, onSectorClick, mode])

  // 移除悬停事件处理函数，仅使用点击事件

  /**
   * 更新标记标签显示
   */
  const updateMarkerLabel = (captureId: string, _seq: number, label: string, lat: number, lng: number) => {
    if (!mapInstanceRef.current || !window.L) return

    const L = window.L
    const map = mapInstanceRef.current

    // 移除旧标签
    const oldLabelMarker = markerLabelElementsRef.current.get(captureId)
    if (oldLabelMarker) {
      if (decorationLayerRef.current) {
        decorationLayerRef.current.removeLayer(oldLabelMarker)
      }
      map.removeLayer(oldLabelMarker)
      markerLabelElementsRef.current.delete(captureId)
    }

    // 如果标签为空，不显示
    if (!label) return

    // 创建新标签标记（显示在圆点右侧）
    const labelMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        html: `<div class="marker-label-inner" style="background:rgba(0,0,0,0.75);color:#fff;font-size:12px;padding:2px 8px;border-radius:4px;white-space:nowrap;display:inline-block;line-height:1.6;box-sizing:border-box;margin-left:8px;">${label}</div>`,
        className: 'marker-label-wrapper',
        iconSize: undefined as any,
        // iconAnchor 设置为图标左侧中心点，使标签显示在圆点右侧
        iconAnchor: [0, -10]
      }),
      interactive: false,
      zIndexOffset: -100
    })

    if (decorationLayerRef.current) {
      labelMarker.addTo(decorationLayerRef.current)
    } else {
      labelMarker.addTo(map)
    }

    markerLabelElementsRef.current.set(captureId, labelMarker)
  }

  /**
   * 计算两点之间的距离
   */
  const calculateDistance = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
    const R = 6378137 // 地球半径（米）
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLng = (lng2 - lng1) * Math.PI / 180
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }

  /**
   * 处理地图点击事件
   */
  const handleMapClick = useCallback((event: any) => {
    // 拖拽工具激活时不处理任何点击操作，只允许地图拖拽
    if (mapDragTool) return

    // 抓取模式：获取点击坐标并转换为WGS84，在地图上添加持久化标记
    if (captureMode && onCaptureCoord && mapInstanceRef.current && window.L) {
      // 检查装饰图层是否启用，未启用则阻止打点
      if (!decorationLayerVisibility) {
        onCaptureBlocked?.()
        return
      }
      const L = window.L
      const map = mapInstanceRef.current
      const gcjLat = event.latlng.lat
      const gcjLng = event.latlng.lng
      const [wgsLat, wgsLng] = CoordinateTransformer.gcj02ToWgs84(gcjLat, gcjLng)

      // 序号：从1开始
      const seq = captureMarkersRef.current.length + 1
      const captureId = `capture-${Date.now()}-${seq}`

      // 生成默认标签名（如"打点1"、"打点2"）
      const defaultLabel = `${t('map.capturePoint') || '打点'}${seq}`

      // 创建标记（纯色圆点，无序号）
      const marker = L.marker([gcjLat, gcjLng], {
        icon: L.divIcon({
          html: `<div style="background:#ef4444;width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.3);"></div>`,
          className: 'capture-marker',
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        })
      })

      // 存储属性数据到 marker 上，供圈选工具读取
      ;(marker as any).captureProperties = {
        id: captureId,
        name: defaultLabel,  // 使用默认标签名作为名称
        标签: defaultLabel,  // 添加标签字段
        longitude: wgsLng.toFixed(6),
        latitude: wgsLat.toFixed(6),
        lng: wgsLng.toFixed(6),
        lat: wgsLat.toFixed(6),
        _layerType: 'CapturePoint'
      }

      // 保存默认标签到 markerLabelsRef
      markerLabelsRef.current.set(captureId, {
        id: captureId,
        name: captureId,
        label: defaultLabel
      })

      // 立即显示默认标签
      updateMarkerLabel(captureId, seq, defaultLabel, gcjLat, gcjLng)

      // 左键点击：弹出可编辑属性框
      marker.on('click', () => {
        const labelData = markerLabelsRef.current.get(captureId)
        const currentLabel = labelData?.label || defaultLabel
        const inputId = `capture-label-input-${captureId}`
        const lngInputId = `capture-lng-input-${captureId}`
        const latInputId = `capture-lat-input-${captureId}`
        const inputStyle = `padding:4px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;width:100%;color:#111;outline:none;font-family:monospace;`
        const inputFocus = `onfocus="this.style.borderColor='#3b82f6';this.style.boxShadow='0 0 0 2px rgba(59,130,246,0.2)'" onblur="this.style.borderColor='#d1d5db';this.style.boxShadow='none'"`
        const deleteBtnText = t('map.delete') || '删除'
        const copyBtnText = t('map.copy') || '复制'
        const confirmBtnText = t('common.confirm') || '确定'
        const propertiesText = t('map.properties') || '属性'
        const labelNameText = t('map.labelName') || '标签'
        const longitudeText = t('map.longitude') || '经度'
        const latitudeText = t('map.latitude') || '纬度'

        const popupContent = `
          <div style="padding:10px 12px;min-width:280px;background:#fff;color:#000;border:1px solid #d1d5db;border-radius:8px;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);" onclick="event.stopPropagation()">
            <div style="font-size:14px;font-weight:600;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #e5e7eb;color:#111;">${propertiesText}</div>
            <div style="display:grid;grid-template-columns:50px 1fr;gap:8px 12px;align-items:center;line-height:1.6;">
              <span style="color:#888;font-size:11px;">${labelNameText}</span>
              <input id="${inputId}" type="text" value="${currentLabel.replace(/"/g, '&quot;')}"
                style="${inputStyle}" ${inputFocus} />
              <span style="color:#888;font-size:11px;">${longitudeText}</span>
              <input id="${lngInputId}" type="text" value="${wgsLng.toFixed(6)}"
                style="${inputStyle}" ${inputFocus} />
              <span style="color:#888;font-size:11px;">${latitudeText}</span>
              <input id="${latInputId}" type="text" value="${wgsLat.toFixed(6)}"
                style="${inputStyle}" ${inputFocus} />
            </div>
            <div style="margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb;display:flex;justify-content:flex-end;gap:8px;">
              <button class="confirm-btn" style="background:#22c55e;border:1px solid #22c55e;cursor:pointer;color:#fff;font-size:12px;padding:4px 14px;border-radius:4px;transition:all 0.15s;">${confirmBtnText}</button>
              <button class="cp-all-btn" style="background:#3b82f6;border:1px solid #3b82f6;cursor:pointer;color:#fff;font-size:12px;padding:4px 14px;border-radius:4px;transition:all 0.15s;">${copyBtnText}</button>
              <button class="del-btn" style="background:#ef4444;border:1px solid #ef4444;cursor:pointer;color:#fff;font-size:12px;padding:4px 14px;border-radius:4px;transition:all 0.15s;">${deleteBtnText}</button>
            </div>
          </div>
        `

        // 每次都先解绑再重新绑定，确保 popup 状态干净
        marker.unbindPopup()
        marker.bindPopup(popupContent, {
          className: 'capture-popup-white',
          closeButton: true,
          autoPan: true,
          offset: [0, -20]
        }).openPopup()

        // 绑定事件
        setTimeout(() => {
          // 复制按钮事件 — 制表符分隔（粘贴到Excel为横向3列）
          document.querySelectorAll('.capture-popup-white .cp-all-btn').forEach(btn => {
            btn.addEventListener('click', function(this: HTMLButtonElement) {
              const labelInput = document.getElementById(inputId) as HTMLInputElement
              const lngInput = document.getElementById(lngInputId) as HTMLInputElement
              const latInput = document.getElementById(latInputId) as HTMLInputElement
              const labelVal = labelInput?.value.trim() || currentLabel
              const lngVal = lngInput?.value.trim() || wgsLng.toFixed(6)
              const latVal = latInput?.value.trim() || wgsLat.toFixed(6)
              const allText = `${labelVal}\t${lngVal}\t${latVal}`
              navigator.clipboard.writeText(allText).then(() => {
                this.textContent = (window as any).__gsdT?.('map.copied') || '已复制'
                this.style.background = '#16a34a'
                this.style.borderColor = '#16a34a'
                setTimeout(() => {
                  this.textContent = (window as any).__gsdT?.('map.copy') || '复制'
                  this.style.background = '#3b82f6'
                  this.style.borderColor = '#3b82f6'
                }, 1200)
              })
            })
          })

          // 删除按钮事件
          document.querySelectorAll('.capture-popup-white .del-btn').forEach(btn => {
            btn.addEventListener('click', function(this: HTMLButtonElement) {
              // 关闭弹框
              marker.closePopup()
              // 移除地图标记
              map.removeLayer(marker)
              // 移除标签标记
              const labelMarker = markerLabelElementsRef.current.get(captureId)
              if (labelMarker) {
                map.removeLayer(labelMarker)
                markerLabelElementsRef.current.delete(captureId)
              }
              // 清除数据
              markerLabelsRef.current.delete(captureId)
              // 从数组中移除引用
              const idx = captureMarkersRef.current.findIndex(m => m === marker)
              if (idx > -1) {
                captureMarkersRef.current.splice(idx, 1)
              }
            })
          })

          // 确定按钮事件 — 触发输入保存并关闭弹窗
          document.querySelectorAll('.capture-popup-white .confirm-btn').forEach(btn => {
            btn.addEventListener('click', function() {
              const labelInput = document.getElementById(inputId) as HTMLInputElement
              labelInput?.focus()
              labelInput?.blur()  // 触发 blur 事件 → saveLabel
              const lngInput = document.getElementById(lngInputId) as HTMLInputElement
              lngInput?.blur()
              const latInput = document.getElementById(latInputId) as HTMLInputElement
              latInput?.blur()
              marker.closePopup()
            })
          })

          // 标签输入框保存事件
          const input = document.getElementById(inputId) as HTMLInputElement
          if (!input) return

          const saveLabel = () => {
            const newLabel = input.value.trim() || defaultLabel
            markerLabelsRef.current.set(captureId, {
              id: captureId,
              name: captureId,
              label: newLabel
            })
            const props = (marker as any).captureProperties
            if (props) {
              props.name = newLabel
              props.标签 = newLabel
            }
            updateMarkerLabel(captureId, seq, newLabel, gcjLat, gcjLng)
          }

          // 经度输入框保存事件
          const lngInput = document.getElementById(lngInputId) as HTMLInputElement
          if (lngInput) {
            const saveLng = () => {
              const val = parseFloat(lngInput.value.trim())
              if (!isNaN(val)) {
                const props = (marker as any).captureProperties
                if (props) {
                  props.longitude = val.toFixed(6)
                  props.lng = val.toFixed(6)
                }
              }
            }
            lngInput.addEventListener('blur', saveLng)
            lngInput.addEventListener('keydown', (e: KeyboardEvent) => {
              if (e.key === 'Enter') { e.preventDefault(); saveLng(); lngInput.blur() }
            })
          }

          // 纬度输入框保存事件
          const latInput = document.getElementById(latInputId) as HTMLInputElement
          if (latInput) {
            const saveLat = () => {
              const val = parseFloat(latInput.value.trim())
              if (!isNaN(val)) {
                const props = (marker as any).captureProperties
                if (props) {
                  props.latitude = val.toFixed(6)
                  props.lat = val.toFixed(6)
                }
              }
            }
            latInput.addEventListener('blur', saveLat)
            latInput.addEventListener('keydown', (e: KeyboardEvent) => {
              if (e.key === 'Enter') { e.preventDefault(); saveLat(); latInput.blur() }
            })
          }

          input.addEventListener('blur', saveLabel)
          input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              saveLabel()
              input.blur()
            }
          })
          input.focus()
          input.select()
        }, 100)
      })

      // 右键点击：阻止默认行为（不再弹出编辑框，编辑已整合到左键属性框）
      marker.on('contextmenu', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e)
        L.DomEvent.preventDefault(e)
      })

      captureMarkersRef.current.push(marker)

      // 将标记添加到装饰图层或地图
      if (decorationLayerRef.current) {
        marker.addTo(decorationLayerRef.current)
      } else {
        marker.addTo(map)
      }

      onCaptureCoord(wgsLng, wgsLat)
      return
    }

    // 框选模式下不处理地图点击事件
    if (selectionModeRef.current !== 'none') return

    hideSectorInfo()
    hideFeatureInfo()
    setOverlappingSectors([])
    setOverlapPosition(null)

    // 如果处于测量模式，处理测量点点击
    if (measureMode && mapInstanceRef.current && leafletRef.current) {
      const L = leafletRef.current
      const map = mapInstanceRef.current
      const latLng = event.latlng

      // 确保测量图层在顶层显示 - 使用overlay pane
      let measurementPane = map.getPane('measurement')
      if (!measurementPane) {
        measurementPane = map.createPane('measurement')
        measurementPane.style.zIndex = '1000'
      }

      // 添加测量点
      const newPoint = { lng: latLng.lng, lat: latLng.lat }
      // 使用 ref 获取最新的点数据，避免双击时闭包值过期
      const currentMeasurePoints = measurePointsRef.current
      const updatedPoints = [...currentMeasurePoints, newPoint]
      setMeasurePoints(updatedPoints)
      measurePointsRef.current = updatedPoints // 立即更新 ref 供 mousemove 使用

      // 创建测量点标记
      const icon = L.divIcon({
        html: `<div style="background-color: white; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #ef4444; box-shadow: 0 1px 3px rgba(0,0,0,0.3);"></div>`,
        className: 'measure-point-icon',
        iconSize: [10, 10],
        iconAnchor: [5, 5]
      })

      const marker = L.marker([latLng.lat, latLng.lng], {
        icon,
        pane: 'measurement'
      }).addTo(map)
      measurementMarkersRef.current.push(marker)

      // 计算距离并显示标签
      let labelText = ''
      let totalDist = 0
      if (updatedPoints.length === 1) {
        labelText = t('map.measureStartPoint') || '起点'
      } else {
        for (let i = 0; i < updatedPoints.length - 1; i++) {
          totalDist += calculateDistance(updatedPoints[i].lat, updatedPoints[i].lng, updatedPoints[i + 1].lat, updatedPoints[i + 1].lng)
        }
        labelText = `${totalDist.toFixed(2)}${t('map.meters')}`
      }

      const distanceLabel = L.marker([latLng.lat, latLng.lng], {
        icon: L.divIcon({
          html: `<div style="white-space: nowrap; font-size: 11px; color: #ef4444; font-weight: bold; text-shadow: 1px 1px 1px white, -1px -1px 1px white, 1px -1px 1px white, -1px 1px 1px white;">
                  ${labelText}
                </div>`,
          className: 'measure-label',
          iconSize: [0, 0],
          iconAnchor: [-5, 10]
        }),
        pane: 'measurement'
      }).addTo(map)
      measurementMarkersRef.current.push(distanceLabel)

      // 绘制测量连线
      if (updatedPoints.length >= 2) {
        const polyline = L.polyline(
          updatedPoints.map(p => [p.lat, p.lng]),
          {
            color: '#ef4444',
            weight: 2,
            opacity: 1,
            pane: 'measurement'
          }
        ).addTo(map)
        measurementLinesRef.current.push(polyline)
      }
    }
  }, [mapDragTool, measureMode, hideSectorInfo, hideFeatureInfo, captureMode, onCaptureCoord])

  /**
   * 处理地图右键事件，用于结束测量或释放测距模式
   */
  const handleMapContextMenu = useCallback((event: any) => {
    // 阻止默认右键菜单
    event.originalEvent.preventDefault()
  }, [])

  /**
   * 结束当前测距
   */
  const finishMeasurement = useCallback(() => {
    // 使用 ref 获取最新的点数据，避免双击时闭包值过期
    const currentPoints = measurePointsRef.current
    if (!mapInstanceRef.current || currentPoints.length < 2) return

    const L = (window as any).L
    const map = mapInstanceRef.current

    // 复制点数组进行处理（使用 ref 中的最新数据）
    let points = [...currentPoints]

    // 如果最后两个点坐标一致（通常是双击导致的），移除最后一个重复点
    if (points.length >= 2) {
      const p1 = points[points.length - 1]
      const p2 = points[points.length - 2]
      if (p1.lat === p2.lat && p1.lng === p2.lng) {
        points.pop()
        // 同时移除对应的标记和标签（因为双击触发了两次click）
        const redundantLabel = measurementMarkersRef.current.pop()
        if (redundantLabel) map.removeLayer(redundantLabel)
        const redundantMarker = measurementMarkersRef.current.pop()
        if (redundantMarker) map.removeLayer(redundantMarker)
      }
    }

    // 现在移除最后一个有效点的数字标签，准备替换为"总长"
    const lastLabel = measurementMarkersRef.current.pop()
    if (lastLabel) {
      map.removeLayer(lastLabel)
    }

    const lastPoint = points[points.length - 1]

    // 计算总距离
    let totalDist = 0
    for (let i = 0; i < points.length - 1; i++) {
      totalDist += calculateDistance(points[i].lat, points[i].lng, points[i + 1].lat, points[i + 1].lng)
    }

    // 清理中间状态的线条，只保留最后一条完整的线
    // 在测量过程中，每次点击都会添加一条包含所有点的折线
    // 现在需要清理之前的中间状态线，只保留最后一条
    const savedLineStartIndex = measurementLineStartIndexRef.current
    const currentLineCount = measurementLinesRef.current.length

    // 移除除最后一条外的所有中间状态线
    for (let i = savedLineStartIndex; i < currentLineCount - 1; i++) {
      const line = measurementLinesRef.current[i]
      if (line) map.removeLayer(line)
    }
    // 只保留最后一条线
    if (currentLineCount > savedLineStartIndex) {
      const lastLine = measurementLinesRef.current[currentLineCount - 1]
      measurementLinesRef.current = [
        ...measurementLinesRef.current.slice(0, savedLineStartIndex),
        lastLine
      ]
    }


    // 记录当前测量添加的所有标记引用
    // 在 finishMeasurement 被调用时，measurementMarkersRef 中已经包含了：
    // 1. 所有测量点的标记（每个点一个）- 在点击时添加
    // 2. 所有距离标签（每个点一个，除了最后一个点）- 在点击时添加
    // 3. 总长标签 - 在下面添加
    // 4. 删除按钮 - 在下面添加
    // 我们需要记录当前测量添加的标记，以便删除时能准确定位
    const markerStartIndex = measurementMarkerStartIndexRef.current

    // 绘制最终的总长标签
    const totalLabel = L.marker([lastPoint.lat, lastPoint.lng], {
      icon: L.divIcon({
        html: `<div style="color: #ef4444; white-space: nowrap; font-size: 13px; font-weight: bold; text-shadow: 1px 1px 2px white, -1px -1px 2px white, 1px -1px 2px white, -1px 1px 2px white;">
                ${t('map.totalDistance')} ${totalDist.toFixed(2)}${t('map.meters')}
              </div>`,
        className: 'measure-total-label',
        iconSize: [0, 0],
        iconAnchor: [-5, 20]
      }),
      pane: 'measurement'
    }).addTo(map)
    measurementMarkersRef.current.push(totalLabel)

    // 在结束端添加删除按钮（X样式）
    const deleteButton = L.marker([lastPoint.lat, lastPoint.lng], {
      icon: L.divIcon({
        html: `<div class="measure-delete-btn" style="
          width: 18px;
          height: 18px;
          background: #ef4444;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 1px 3px rgba(0,0,0,0.4);
          border: 2px solid white;
          font-size: 12px;
          font-weight: bold;
          color: white;
          line-height: 1;
        " title="${t('map.deleteMeasurement') || '删除测量'}">×</div>`,
        className: 'measure-delete-button',
        iconSize: [18, 18],
        iconAnchor: [22, 10] // 偏移到总长标签右侧
      }),
      pane: 'measurement'
    }).addTo(map)
    measurementMarkersRef.current.push(deleteButton)

    // 在 deleteButton 上存储索引，避免闭包捕获过期值
    ;(deleteButton as any)._savedLineStartIndex = savedLineStartIndex
    ;(deleteButton as any)._markerStartIndex = markerStartIndex

    // 使用 Leaflet 的 on('click') 事件系统替代 getElement()?.addEventListener
    // 后者在 DOM 元素未就绪时可能静默失败，导致点击 X 无响应
    deleteButton.on('click', function (this: typeof deleteButton) {
      const startLineIdx = (this as any)._savedLineStartIndex as number
      const startMarkerIdx = (this as any)._markerStartIndex as number

      // 移除从 startLineIdx 开始的所有测量线条
      const lineEndIdx = measurementLinesRef.current.length
      for (let i = lineEndIdx - 1; i >= startLineIdx; i--) {
        const line = measurementLinesRef.current[i]
        if (line) map.removeLayer(line)
      }
      measurementLinesRef.current.splice(startLineIdx, lineEndIdx - startLineIdx)

      // 移除从 startMarkerIdx 开始的所有标记（含总长标签和删除按钮自身）
      const markerEndIdx = measurementMarkersRef.current.length
      for (let i = markerEndIdx - 1; i >= startMarkerIdx; i--) {
        const m = measurementMarkersRef.current[i]
        if (m) map.removeLayer(m)
      }
      measurementMarkersRef.current.splice(startMarkerIdx, markerEndIdx - startMarkerIdx)

      // 重置起始索引
      measurementLineStartIndexRef.current = measurementLinesRef.current.length
      measurementMarkerStartIndexRef.current = measurementMarkersRef.current.length

      // 清除预览虚线和标签
      if (shadowLineRef.current) {
        map.removeLayer(shadowLineRef.current)
        shadowLineRef.current = null
      }
      if (shadowLabelRef.current) {
        map.removeLayer(shadowLabelRef.current)
        shadowLabelRef.current = null
      }
    })

    // 更新线条起始索引，为下一次测量做准备
    measurementLineStartIndexRef.current = measurementLinesRef.current.length
    // 更新标记起始索引，为下一次测量做准备
    measurementMarkerStartIndexRef.current = measurementMarkersRef.current.length

    // 清除预览线
    if (shadowLineRef.current) {
      map.removeLayer(shadowLineRef.current)
      shadowLineRef.current = null
    }
    if (shadowLabelRef.current) {
      map.removeLayer(shadowLabelRef.current)
      shadowLabelRef.current = null
    }

    setMeasurePoints([])
    measurePointsRef.current = [] // 立即更新 ref
  }, [calculateDistance])

  /**
   * 撤销上一个测量点
   */
  const undoLastPoint = useCallback(() => {
    // 使用 ref 获取最新的点数据
    const currentPoints = measurePointsRef.current
    if (!mapInstanceRef.current || currentPoints.length <= 1) return

    const map = mapInstanceRef.current

    // 移除最后一个点的数据
    const updatedPoints = [...currentPoints]
    updatedPoints.pop()
    setMeasurePoints(updatedPoints)
    measurePointsRef.current = updatedPoints

    // 移除最后一个标记（点）
    const lastMarker = measurementMarkersRef.current.pop()
    if (lastMarker) map.removeLayer(lastMarker)

    // 移除最后一个标签（距离）
    const lastLabel = measurementMarkersRef.current.pop()
    if (lastLabel) map.removeLayer(lastLabel)

    // 移除最后一段连线
    const lastLine = measurementLinesRef.current.pop()
    if (lastLine) map.removeLayer(lastLine)

    // 强制更新预览线（如果有）
    if (shadowLineRef.current && updatedPoints.length > 0) {
      // 触发一次 mousemove 的逻辑（或者等待下一次 mousemove）
    } else if (shadowLineRef.current) {
      map.removeLayer(shadowLineRef.current)
      shadowLineRef.current = null
      if (shadowLabelRef.current) {
        map.removeLayer(shadowLabelRef.current)
        shadowLabelRef.current = null
      }
    }
  }, [])

  /**
   * 处理全键盘事件，支持 Esc 退出测距/框选，Ctrl+C 复制选中要素，Backspace 删除多边形最后一个点
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (measureModeRef.current) {
        if (e.key === 'Escape') {
          onMeasureModeEnd?.()
        } else if (e.key === 'Backspace') {
          e.preventDefault()
          undoLastPointRef.current()
        }
      } else if (selectionModeRef.current !== 'none') {
        if (e.key === 'Escape' && selectionModeRef.current === 'polygon' && selectionPointsRef.current.length > 0) {
          // 多边形绘制中: 按Esc删除上一个顶点（同Backspace），删除完所有点后才退出多边形模式
          e.preventDefault()
          const map = mapInstanceRef.current
          if (!map) return
          selectionPointsRef.current.pop()
          if (polygonTempLayerRef.current) {
            map.removeLayer(polygonTempLayerRef.current)
            polygonTempLayerRef.current = null
          }
          if (selectionPointsRef.current.length >= 2) {
            const points = selectionPointsRef.current.map(p => [p.lat, p.lng])
            const L = window.L
            polygonTempLayerRef.current = L.polyline(points as L.LatLngExpression[], {
              color: '#00ffff',
              weight: 2,
              dashArray: '5, 5'
            }).addTo(map)
          }
        } else if (e.key === 'Escape') {
          // 非多边形绘制中 或 多边形已无顶点: 按Escape退出选择模式并清除选中状态
          preserveSelectionRef.current = false
          onSelectionModeEnd?.()
        } else if (e.key === 'Backspace' && selectionModeRef.current === 'polygon') {
          // 多边形模式：删除最后一个点
          e.preventDefault()
          const map = mapInstanceRef.current
          if (!map) return

          if (selectionPointsRef.current.length > 0) {
            // 删除最后一个点
            selectionPointsRef.current.pop()

            // 清除临时多边形线
            if (polygonTempLayerRef.current) {
              map.removeLayer(polygonTempLayerRef.current)
              polygonTempLayerRef.current = null
            }

            // 如果还有剩余的点，重新绘制临时线
            if (selectionPointsRef.current.length >= 2) {
              const points = selectionPointsRef.current.map(p => [p.lat, p.lng])
              const L = window.L
              polygonTempLayerRef.current = L.polyline(points as L.LatLngExpression[], {
                color: '#00ffff',
                weight: 2,
                dashArray: '5, 5'
              }).addTo(map)
            }

            // 删除点后保持初始提示，不显示动态点计数
            if (selectionPointsRef.current.length === 0) {
              setSelectionTip(`${t('map.clickToAddPolygon') || '点击添加多边形顶点'}，${t('map.backspaceDelete') || '按 Backspace 删除上一个点'}`)
            }
          }
        } else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
          // Ctrl+C 复制选中要素到剪贴板
          if (selectedFeaturesRef.current.length > 0) {
            copySelectionToClipboard(selectedFeaturesRef.current)
          }
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onMeasureModeEnd, onSelectionModeEnd])

  /**
   * 当测量模式改变时，清除历史数据
   */
  useEffect(() => {
    if (mapInstanceRef.current) {
      const map = mapInstanceRef.current

      // 清除预览线（绘制中的虚线和标签）
      if (shadowLineRef.current) {
        map.removeLayer(shadowLineRef.current)
        shadowLineRef.current = null
      }
      if (shadowLabelRef.current) {
        map.removeLayer(shadowLabelRef.current)
        shadowLabelRef.current = null
      }

      // 退出测距模式时：清理未完成的测量痕迹（已点击的点标记/线条但未双击结束）
      if (!measureMode) {
        measurePointsRef.current = []
        setMeasurePoints([])

        // 清除当前未完成的测量线条（从 lineStartIndexRef 开始到末尾的线条都是未完成的）
        const lineFromIdx = measurementLineStartIndexRef.current
        const totalLines = measurementLinesRef.current.length
        if (totalLines > lineFromIdx) {
          for (let i = totalLines - 1; i >= lineFromIdx; i--) {
            const line = measurementLinesRef.current[i]
            if (line) map.removeLayer(line)
          }
          measurementLinesRef.current.splice(lineFromIdx, totalLines - lineFromIdx)
        }

        // 清除当前未完成的测量标记（从 markerStartIndexRef 开始到末尾的标记都是未完成的）
        const markerFromIdx = measurementMarkerStartIndexRef.current
        const totalMarkers = measurementMarkersRef.current.length
        if (totalMarkers > markerFromIdx) {
          for (let i = totalMarkers - 1; i >= markerFromIdx; i--) {
            const m = measurementMarkersRef.current[i]
            if (m) map.removeLayer(m)
          }
          measurementMarkersRef.current.splice(markerFromIdx, totalMarkers - markerFromIdx)
        }
      }
    }
  }, [measureMode])


  /**
   * 创建扇区图层的辅助函数
   */
  const createSectorLayer = useCallback((options: {
    sectors: RenderSectorData[]
    onClick: (sector: RenderSectorData, event: L.LeafletMouseEvent) => void
    zoom: number
    showLabels: boolean
    labelConfig?: SectorLabelConfig
    measureMode?: boolean
  }) => {
    return new SectorSVGLayer({
      sectors: options.sectors,
      zoom: options.zoom,
      showLabels: options.showLabels,
      labelConfig: options.labelConfig,
      onClick: options.onClick,
      measureMode: options.measureMode || false
    })
  }, [])

  /**
   * 创建扇区图层
   */
  const createSectorLayers = useCallback(() => {
    if (!mapInstanceRef.current) return

    const currentZoom = mapInstanceRef.current.getZoom()

    // 移除旧图层
    if (lteSectorLayerRef.current) {
      mapInstanceRef.current.removeLayer(lteSectorLayerRef.current)
      lteSectorLayerRef.current = null
    }
    if (nrSectorLayerRef.current) {
      mapInstanceRef.current.removeLayer(nrSectorLayerRef.current)
      nrSectorLayerRef.current = null
    }

    // 在TAC-check模式下，根据配置的网络类型只创建对应图层
    let shouldCreateLTELayer = sectorData.lte.length > 0
    let shouldCreateNRLayer = sectorData.nr.length > 0

    if (mode === 'tac-check') {
      const effectiveNetworkType = tacHighlightConfigRef.current?.networkType || 'LTE'
      shouldCreateLTELayer = effectiveNetworkType === 'LTE' && sectorData.lte.length > 0
      shouldCreateNRLayer = effectiveNetworkType === 'NR' && sectorData.nr.length > 0
      console.log('[OnlineMap] TAC-check模式创建图层', {
        effectiveNetworkType,
        shouldCreateLTELayer,
        shouldCreateNRLayer,
        lteDataCount: sectorData.lte.length,
        nrDataCount: sectorData.nr.length
      })
    }

    // 创建LTE扇区图层
    if (shouldCreateLTELayer) {
      lteSectorLayerRef.current = createSectorLayer({
        sectors: sectorData.lte,
        onClick: (sector, event) => handleSectorClick(sector, event),
        zoom: currentZoom,
        // PCI规划模式下禁用标签显示
        showLabels: mode !== 'pci-planning' && (labelVisibility.lte || (sectorLabelVisibility && sectorLabelVisibility['lte-sectors'])),
        labelConfig: labelSettingsMap && labelSettingsMap['lte-sectors'],
        measureMode: measureMode
      })
      if (layerVisibility.lte) {
        lteSectorLayerRef.current.addTo(mapInstanceRef.current)
      }

      // 设置渲染模式
      lteSectorLayerRef.current.setRenderMode(mode as any)

      // TAC核查模式：立即应用TAC高亮配置，确保初始渲染使用正确的TAC颜色
      if (mode === 'tac-check' && tacHighlightConfigRef.current) {
        lteSectorLayerRef.current.setTACHighlightMode(tacHighlightConfigRef.current)
        console.log('[OnlineMap] LTE图层应用TAC高亮配置', tacHighlightConfigRef.current)
      }

      // 应用当前频点可见性
      const visibilityMap = new Map<number, boolean>()
      frequencies.lte.forEach(f => visibilityMap.set(f.frequency, f.visible))
      lteSectorLayerRef.current.setFrequenciesVisibility(visibilityMap)
    }

    // 创建NR扇区图层
    if (shouldCreateNRLayer) {
      nrSectorLayerRef.current = createSectorLayer({
        sectors: sectorData.nr,
        onClick: (sector, event) => handleSectorClick(sector, event),
        zoom: currentZoom,
        // PCI规划模式下禁用标签显示
        showLabels: mode !== 'pci-planning' && (labelVisibility.nr || (sectorLabelVisibility && sectorLabelVisibility['nr-sectors'])),
        labelConfig: labelSettingsMap && labelSettingsMap['nr-sectors'],
        measureMode: measureMode
      })
      if (layerVisibility.nr) {
        nrSectorLayerRef.current.addTo(mapInstanceRef.current)
      }

      // 设置渲染模式
      nrSectorLayerRef.current.setRenderMode(mode as any)

      // TAC核查模式：立即应用TAC高亮配置，确保初始渲染使用正确的TAC颜色
      if (mode === 'tac-check' && tacHighlightConfigRef.current) {
        nrSectorLayerRef.current.setTACHighlightMode(tacHighlightConfigRef.current)
        console.log('[OnlineMap] NR图层应用TAC高亮配置', tacHighlightConfigRef.current)
      }

      // 应用当前频点可见性
      const visibilityMap = new Map<number, boolean>()
      frequencies.nr.forEach(f => visibilityMap.set(f.frequency, f.visible))
      nrSectorLayerRef.current.setFrequenciesVisibility(visibilityMap)
    }
  }, [sectorData, layerVisibility, labelVisibility, sectorLabelVisibility, labelSettingsMap, handleSectorClick, mode, frequencies, createSectorLayer, measureMode])

  /**
   * 加载单个MapInfo图层或Excel点图层
   */
  const loadMapInfoLayer = useCallback(async (layerFile: LayerFileOption) => {
    if (!mapInstanceRef.current) return

    console.log('[OnlineMap] loadMapInfoLayer 开始加载:', layerFile.id, layerFile.name, 'sourceType:', layerFile.sourceType, 'visible:', layerFile.visible)

    // 对于 GeoDataLayer（点、扇区或多边形），检查是否已存在，如果存在则直接更新可见性
    if ((layerFile.geometryType === 'point' || layerFile.geometryType === 'sector' || layerFile.geometryType === 'polygon') && geoDataLayerManagerRef.current) {
      const existingLayer = geoDataLayerManagerRef.current.getLayer(layerFile.id)
      if (existingLayer) {
        console.log('[OnlineMap] GeoDataLayer 已存在，直接更新可见性:', layerFile.visible)
        existingLayer.setVisible(mapInstanceRef.current, layerFile.visible)
        return
      }
    }

    // 对于 MapInfoLayer，如果已经加载过，跳过
    if (loadedMapInfoLayersRef.current.has(layerFile.id)) {
      console.log('[OnlineMap] MapInfoLayer 图层已加载，跳过:', layerFile.id)
      return
    }

    try {
      let geojsonData: GeoJSON.FeatureCollection | null = null

      if (layerFile.sourceType === 'excel') {
        console.log('[OnlineMap] 从Excel加载点数据, dataId:', layerFile.dataId)
        const response = await dataApi.get(layerFile.dataId)
        console.log('[OnlineMap] Excel API响应:', response.success, '有数据:', !!response.data)
        console.log('[OnlineMap] response.data type:', Array.isArray(response.data) ? 'array' : typeof response.data)
        console.log('[OnlineMap] response.data keys:', response.data ? Object.keys(response.data) : 'no data')

        // 详细调试 API 响应结构
        console.log('[OnlineMap] ===== API 响应详情 =====')
        console.log('[OnlineMap] response.success:', response.success)
        console.log('[OnlineMap] response.data 存在:', !!response.data)
        console.log('[OnlineMap] response.data 类型:', Array.isArray(response.data) ? 'array' : typeof response.data)
        console.log('[OnlineMap] response.data.data 存在:', !!response.data?.data)
        console.log('[OnlineMap] response.data.data 类型:', Array.isArray(response.data?.data) ? 'array' : typeof response.data?.data)

        // 检查 rawData 中是否有 coordinates 字段
        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
          console.log('[OnlineMap] 第一条数据示例:', JSON.stringify(response.data[0], null, 2))
          console.log('[OnlineMap] 第一条数据是否有 coordinates:', 'coordinates' in response.data[0])
          console.log('[OnlineMap] 第一条数据.coordinates:', response.data[0].coordinates)
        }
        console.log('[OnlineMap] ==========================')

        // 后端返回的数据格式：
        // 1. default.json -> 直接返回数组
        // 2. data.json -> 直接返回数组
        // 3. LTE.json/NR.json -> 返回 {lte: [...]} 或 {nr: [...]}
        // 4. API 包装格式 -> {success: true, data: [...]}
        // 前端需要正确处理这些格式
        let rawData = null
        if (Array.isArray(response.data)) {
          // 直接是数组格式
          rawData = response.data
          console.log('[OnlineMap] 数据是数组格式，长度:', rawData.length)
        } else if (response.data && typeof response.data === 'object') {
          // 可能是 {success: true, data: [...]} 或 {lte: [...]} 或 {nr: [...]} 或 {default: [...]} 格式
          if (response.data.data && Array.isArray(response.data.data)) {
            // API 包装格式：{success: true, data: [...]}
            rawData = response.data.data
            console.log('[OnlineMap] 从 data.data 获取数据（API包装格式），长度:', rawData.length)
          } else if (response.data.default) {
            rawData = response.data.default
            console.log('[OnlineMap] 从 data.default 获取数据，长度:', rawData.length)
          } else if (response.data.lte) {
            rawData = response.data.lte
            console.log('[OnlineMap] 从 data.lte 获取数据，长度:', rawData.length)
          } else if (response.data.nr) {
            rawData = response.data.nr
            console.log('[OnlineMap] 从 data.nr 获取数据，长度:', rawData.length)
          }
        }

        if (rawData && rawData.length > 0) {
          // 存储原始数据用于标签渲染
          pointFileDataRef.current.set(layerFile.id, rawData)

          // 根据 geometryType 判断渲染方式
          // 优先使用 layerFile.geometryType，如果未定义则根据 layerFile.type 判断
          let geometryType: 'point' | 'sector' | 'polygon' = 'point'

          // 调试：显示原始值
          console.log('[OnlineMap] 📌 DEBUG: geometryType 计算开始')
          console.log('[OnlineMap] 📌 layerFile.geometryType 原始值:', layerFile.geometryType, '类型:', typeof layerFile.geometryType)
          console.log('[OnlineMap] 📌 layerFile.type 原始值:', layerFile.type, '类型:', typeof layerFile.type)

          if (layerFile.geometryType) {
            geometryType = layerFile.geometryType as any
            console.log('[OnlineMap] ✅ 使用 layerFile.geometryType:', geometryType)
          } else if (layerFile.type === 'sector') {
            geometryType = 'sector'
            console.log('[OnlineMap] ✅ 使用 layerFile.type === sector')
          } else if (layerFile.type === 'polygon') {
            geometryType = 'polygon'
            console.log('[OnlineMap] ✅ 使用 layerFile.type === polygon')
          } else {
            console.log('[OnlineMap] ⚠️ 使用默认值 point')
          }

          // 调试 geometryType 判断
          console.log('[OnlineMap] ===== geometryType 判断 =====')
          console.log('[OnlineMap] layerFile.geometryType:', layerFile.geometryType)
          console.log('[OnlineMap] layerFile.type:', layerFile.type)
          console.log('[OnlineMap] 🎯 最终计算后的 geometryType:', geometryType)
          console.log('[OnlineMap] 是否匹配 point、sector 或 polygon:', geometryType === 'point' || geometryType === 'sector' || geometryType === 'polygon')
          console.log('[OnlineMap] ======================================')

          // 对于点状、扇区和多边形类型的地理化数据，使用 GeoDataLayer
          if (geometryType === 'point' || geometryType === 'sector' || geometryType === 'polygon') {
            console.log('[OnlineMap] 使用 GeoDataLayer 渲染', geometryType, '数据')
            console.log('[OnlineMap] layerFile:', JSON.stringify(layerFile, null, 2))
            console.log('[OnlineMap] rawData 前3条:', JSON.stringify(rawData?.slice(0, 3), null, 2))

            // 准备 GeoDataLayer 数据
            const geoDataItems: GeoDataItem[] = rawData.map((item: any, idx: number) => {
              const geoItem: GeoDataItem = {
                name: item.name,
                properties: item,
              }

              // 如果是点状或扇区数据，添加经纬度字段
              if (geometryType === 'point' || geometryType === 'sector') {
                geoItem.longitude = item.longitude
                geoItem.latitude = item.latitude
                geoItem.displayLng = item.displayLng
                geoItem.displayLat = item.displayLat
              }

              // 如果是扇区数据，添加扇区相关字段
              if (geometryType === 'sector') {
                geoItem.azimuth = item.azimuth
                geoItem.beamwidth = item.beamwidth
                geoItem.cell_cover_type = item.cell_cover_type
              }

              // 如果是多边形数据，添加多边形相关字段
              if (geometryType === 'polygon') {
                geoItem.path = item.path
                console.log(`[OnlineMap] 📐 第${idx}条多边形数据:`, {
                  name: item.name,
                  hasPath: !!item.path,
                  pathLength: item.path?.length,
                  path: item.path
                })
              }

              return geoItem
            })
            console.log('[OnlineMap] ========== 多边形数据准备完成 ==========')
            console.log('[OnlineMap] geoDataItems 数量:', geoDataItems.length)
            console.log('[OnlineMap] geoDataItems 前3条详情:', JSON.stringify(geoDataItems.slice(0, 3), null, 2))
            console.log('[OnlineMap] layerFile.visible:', layerFile.visible)
            console.log('[OnlineMap] ========================================')

            // 创建 GeoDataLayer
            if (!geoDataLayerManagerRef.current) {
              console.warn('[OnlineMap] GeoDataLayerManager 未初始化')
              return
            }

            console.log('[OnlineMap] 🚀 准备调用 addLayer，参数:', {
              id: layerFile.id,
              name: layerFile.name,
              geometryType: geometryType,
              dataLength: geoDataItems.length,
              visible: layerFile.visible
            })

            try {
              const geoLayer = geoDataLayerManagerRef.current.addLayer({
                id: layerFile.id,
                name: layerFile.name,
                geometryType: geometryType,
                data: geoDataItems,
                visible: layerFile.visible,
                zoom: mapInstanceRef.current?.getZoom() || 12,
                onFeatureClick: (properties, event, name) => {
                  showFeatureInfo(properties, event, name || layerFile.name)
                }
              })

              console.log('[OnlineMap] ✅ addLayer 返回成功:', geoLayer)
              loadedMapInfoLayersRef.current.add(layerFile.id)

              // 同步标签可见性状态
              const labelVisible = pointFileLabelVisibility[layerFile.id] || false
              console.log('[OnlineMap] 同步 GeoDataLayer 标签可见性:', layerFile.id, labelVisible)
              geoLayer.setLabelVisibility(labelVisible)

              console.log('[OnlineMap] ✅ GeoDataLayer 创建完成:', layerFile.id, 'geometryType:', geometryType)
              return
            } catch (error) {
              console.error('[OnlineMap] ❌ addLayer 调用失败:', error)
              console.error('[OnlineMap] 错误堆栈:', error instanceof Error ? error.stack : 'No stack')
              console.error('[OnlineMap] geoDataItems[0]:', geoDataItems[0])
              return
            }
          }

          // 点状数据使用现有的 MapInfoLayer
          const pointData = rawData.filter((item: any) => item.longitude && item.latitude)
          console.log('[OnlineMap] 过滤后的点数据数量:', pointData.length)

          // 转换Excel数据为GeoJSON
          // 注意：这里使用原始 WGS84 坐标，不进行前端转换
          // MapInfoLayer.fromGeoJSON 会通过 transformFeatureCoordinates 进行 WGS84 -> GCJ02 转换
          // 这样确保只有一次坐标转换，避免双重纠偏导致位置偏移
          const features = pointData.map((item: any) => {
            return {
              type: 'Feature',
              geometry: {
                type: 'Point',
                // GeoJSON 坐标格式: [longitude, latitude] (原始 WGS84)
                coordinates: [item.longitude || 0, item.latitude || 0]
              },
              properties: item
            }
          })

          geojsonData = {
            type: 'FeatureCollection',
            features
          }
        } else {
          // 数据不存在或加载失败，跳过此图层
          console.warn('[OnlineMap] 图层数据不存在或为空，跳过:', layerFile.id, layerFile.name, 'rawData存在:', !!rawData, 'rawData长度:', rawData?.length || 0)
          return
        }
      } else {
        // 默认 MapInfo 图层
        console.log('[OnlineMap] 从MapInfo文件加载图层, dataId:', layerFile.dataId)
        const response = await layerApi.getLayerData(layerFile.dataId, layerFile.id)
        console.log('[OnlineMap] MapInfo API响应:', response.success, '有数据:', !!response.data)
        if (response.success && response.data) {
          geojsonData = response.data as GeoJSON.FeatureCollection
        } else {
          // 数据不存在或加载失败，跳过此图层
          console.log('[OnlineMap] 图层数据不存在，跳过:', layerFile.id, layerFile.name)
          return
        }
      }

      if (geojsonData) {
        // 创建图层选项
        const options: MapInfoLayerOptions = {
          id: layerFile.id,
          name: layerFile.name,
          type: layerFile.type as LayerGeometryType,
          data: geojsonData,
          dataId: layerFile.dataId,
          visible: layerFile.visible,
          onFeatureClick: (properties, event) => showFeatureInfo(properties, event, layerFile.name)
        }

        // 创建 Map Info 图层
        console.log('[OnlineMap] 开始创建MapInfoLayer, options:', { id: options.id, name: options.name, type: options.type })
        const mapInfoLayer = await MapInfoLayer.fromGeoJSON(options)
        const leafletLayer = mapInfoLayer.getLeafletLayer()
        console.log('[OnlineMap] MapInfoLayer创建完成, leafletLayer存在:', !!leafletLayer)

        if (leafletLayer) {
          // 存储图层实例和 Leaflet 图层以便控制
          mapInfoLayerRefsRef.current.set(layerFile.id, { mapInfoLayer, leafletLayer })
          loadedMapInfoLayersRef.current.add(layerFile.id)
          console.log('[OnlineMap] 图层已存储到refs, loaded状态:', loadedMapInfoLayersRef.current.has(layerFile.id))

          // 同步标签可见性
          const labelVisible = pointFileLabelVisibility[layerFile.id] || false
          mapInfoLayer.setLabelVisibility(labelVisible)
          if (labelSettingsMap[layerFile.id]) {
            mapInfoLayer.setLabelConfig(labelSettingsMap[layerFile.id])
          }

          console.log('[OnlineMap] Layer created:', layerFile.id, 'visible:', layerFile.visible)

          // 根据初始可见性决定是否添加到地图
          if (layerFile.visible && mapInstanceRef.current) {
            // 使用 MapInfoLayer 的 addTo 方法而不是直接添加 Leaflet 图层
            // 这样可以正确设置 currentMap 引用，使标签功能能够工作
            console.log('[OnlineMap] 准备添加图层到地图...')
            mapInfoLayer.addTo(mapInstanceRef.current)
            console.log('[OnlineMap] Layer added to map on load:', layerFile.id)
          } else {
            console.log('[OnlineMap] Layer created but NOT added to map (visible=' + layerFile.visible + ', mapInstance=' + !!mapInstanceRef.current + ')')
          }
        } else {
          console.error('[OnlineMap] Failed to create Leaflet layer for:', layerFile.id)
        }
      }
    } catch (error) {
      console.error('[OnlineMap] 加载图层失败:', layerFile.id, error)
    }
  }, [pointFileLabelVisibility, labelSettingsMap, showFeatureInfo])

  /**
   * 加载所有MapInfo图层
   */
  const loadMapInfoLayers = useCallback(async () => {
    if (!mapInfoLayerManagerRef.current || !mapInstanceRef.current) return

    const allFiles = [...layerFiles, ...pointFiles]
    console.log('[OnlineMap] Loading all layers, count:', allFiles.length)

    for (const layerFile of allFiles) {
      await loadMapInfoLayer(layerFile)
    }
  }, [layerFiles, pointFiles, loadMapInfoLayer])

  /**
   * 切换地图类型
   */
  const toggleMapType = useCallback(() => {
    const newType = mapLayerType === 'roadmap' ? 'satellite' : 'roadmap'
    setMapLayerType(newType)
    mapStateService.setState({ mapLayerType: newType })
  }, [mapLayerType])

  /**
   * 初始化Leaflet地图
   */
  useEffect(() => {
    if (!mapRef.current) return

    // 动态加载Leaflet CSS和JS
    const loadLeaflet = () => {
      return new Promise<void>((resolve, reject) => {
        if ((window as any).L) {
          leafletRef.current = (window as any).L
          resolve()
          return
        }

        // 加载CSS
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
        document.head.appendChild(link)

        // 加载JS
        const script = document.createElement('script')
        script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
        script.onload = () => {
          leafletRef.current = (window as any).L
          resolve()
        }
        script.onerror = () => reject(new Error('加载Leaflet失败'))
        document.head.appendChild(script)
      })
    }

    // 获取高德地图图层URL
    const getAMapTileUrl = (type: MapLayerType) => {
      if (type === 'satellite') {
        return `https://webst02.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}`
      } else {
        return `https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}`
      }
    }

    const initMap = async () => {
      try {
        // 如果已经初始化过（React Strict Mode 双重调用保护），跳过
        if (initializedRef.current) {
          console.log('[OnlineMap] 已经初始化过，跳过重复初始化')
          setLoading(false)
          return
        }

        // 如果正在初始化，跳过
        if (isInitializingRef.current) {
          console.log('[OnlineMap] 正在初始化中，跳过重复调用')
          setLoading(false)
          return
        }

        // 如果地图实例已存在（可能是热重载），跳过
        if (mapInstanceRef.current) {
          console.log('[OnlineMap] 地图实例已存在，跳过初始化')
          setLoading(false)
          initializedRef.current = true
          return
        }

        // 立即标记已初始化和正在初始化，防止 Strict Mode 双重调用
        initializedRef.current = true
        isInitializingRef.current = true

        setLoading(true)

        await loadLeaflet()

        const L = leafletRef.current
        const container = mapRef.current

        if (!container) {
          console.error('[OnlineMap] 地图容器不存在')
          setLoading(false)
          isInitializingRef.current = false
          initializedRef.current = false // 允许重试
          return
        }

        // === 共享地图实例复用 ===
        const cached = __sharedMapCache
        if (cached.map && cached.leafletContainer) {
          // 缓存的 Leaflet 容器存在，移到当前组件容器中复用
          const leafletContainer = cached.leafletContainer
          if (__sharedHiddenContainer && __sharedHiddenContainer.contains(leafletContainer)) {
            container.appendChild(leafletContainer)
          } else if (!container.contains(leafletContainer)) {
            container.appendChild(leafletContainer)
          }

          // 恢复地图引用
          mapInstanceRef.current = cached.map
          tileLayerRef.current = cached.tileLayer
          initializedRef.current = true
          isInitializingRef.current = false

          // 恢复地图状态
          const savedState = mapStateService.getState()
          cached.map.setView(savedState.center, savedState.zoom)
          cached.map.invalidateSize()

          // 重置光标为默认，避免上一页面遗留的手型/十字光标
          cached.map.getContainer().style.cursor = ''
          cached.map.dragging.enable()
          cached.map.doubleClickZoom.enable()

          // 确保缓存的瓦片图层有 load 事件监听（首次初始化时通过 mapLayerType 变化添加）
          if (cached.tileLayer && !(cached.tileLayer as any).__reuseListenerAttached) {
            cached.tileLayer.on('load', () => {
              hasLoadedAnyTileRef.current = true
              hasNetworkErrorRef.current = false
              if (networkError.visible) {
                setNetworkError(prev => ({ ...prev, visible: false }))
              }
            })
            ;(cached.tileLayer as any).__reuseListenerAttached = true
          }

          // 重新初始化各管理器
          if (!mapInfoLayerManagerRef.current) {
            const manager = new MapInfoLayerManager()
            manager.setMap(cached.map)
            mapInfoLayerManagerRef.current = manager
          }
          if (!geoDataLayerManagerRef.current) {
            const geoManager = new GeoDataLayerManager()
            geoManager.init(cached.map)
            geoDataLayerManagerRef.current = geoManager
          }

          // 加载扇区数据（触发扇区图层重建）
          await loadSectorData()

          setLoading(false)
          setIsMapInitialized(true)
          return
        }
        // ============================

        const savedState = mapStateService.getState()

        // 创建子容器（独立的DOM元素，组件卸载时可移动到隐藏存储保持存活）
        const leafletContainer = document.createElement('div')
        leafletContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%;'
        container.appendChild(leafletContainer)

        // 检查并清理已初始化的容器（遗留保护）
        const hasLeafletMap = container.querySelector('.leaflet-container')
        if (hasLeafletMap) {
          console.log('[OnlineMap] 检测到旧的地图实例，清理容器')
          container.innerHTML = ''
          container.appendChild(leafletContainer)
        }

        // 创建地图实例
        const map = L.map(leafletContainer, {
          ...L.Map.prototype.options,
          zoomControl: false,
          attributionControl: false, // 禁用版权标签
          // 确保地图点击事件能够触发
          dragging: true,
          zooming: true,
          doubleClickZoom: true,
          scrollWheelZoom: true,
          boxZoom: true,
          tap: true,
          touchZoom: true
        }).setView(savedState.center, savedState.zoom)

        // 设置默认光标
        map.getContainer().style.cursor = 'default'

        // 添加测量模式下的十字光标和预览线（使用模块级共享 ref）
        map.on('mousemove', (e: L.LeafletMouseEvent) => {
          if (__sharedCaptureModeRef.current) {
            map.getContainer().style.cursor = 'crosshair'
            return
          }
          if (__sharedMeasureModeRef.current) {
            map.getContainer().style.cursor = 'crosshair'

            // 如果已经有至少一个点，显示跟随鼠标的虚线
            if (__sharedMeasurePointsRef.current.length > 0) {
              const lastPoint = __sharedMeasurePointsRef.current[__sharedMeasurePointsRef.current.length - 1]
              const mouseLatLng = e.latlng

              // 更新虚线
              if (shadowLineRef.current) {
                shadowLineRef.current.setLatLngs([[lastPoint.lat, lastPoint.lng], [mouseLatLng.lat, mouseLatLng.lng]])
              } else {
                shadowLineRef.current = L.polyline(
                  [[lastPoint.lat, lastPoint.lng], [mouseLatLng.lat, mouseLatLng.lng]],
                  {
                    color: '#ef4444',
                    weight: 2,
                    dashArray: '5, 10',
                    opacity: 0.5,
                    pane: 'measurement'
                  }
                ).addTo(map)
              }

              // 更新悬浮距离标签
              let totalDist = 0
              for (let i = 0; i < __sharedMeasurePointsRef.current.length - 1; i++) {
                totalDist += calculateDistance(__sharedMeasurePointsRef.current[i].lat, __sharedMeasurePointsRef.current[i].lng, __sharedMeasurePointsRef.current[i + 1].lat, __sharedMeasurePointsRef.current[i + 1].lng)
              }
              const lastSegment = calculateDistance(lastPoint.lat, lastPoint.lng, mouseLatLng.lat, mouseLatLng.lng)
              const currentTotal = totalDist + lastSegment

              const labelContent = `<div style="white-space: nowrap; font-size: 11px; color: #ef4444; font-weight: bold; text-shadow: 1px 1px 1px white, -1px -1px 1px white, 1px -1px 1px white, -1px 1px 1px white;">
                                    ${currentTotal.toFixed(2)}${t('map.meters')}
                                  </div>`

              if (shadowLabelRef.current) {
                shadowLabelRef.current.setLatLng(mouseLatLng)
                shadowLabelRef.current.setIcon(L.divIcon({
                  html: labelContent,
                  className: 'measure-label-shadow',
                  iconSize: [0, 0],
                  iconAnchor: [-5, 10]
                }))
              } else {
                shadowLabelRef.current = L.marker(mouseLatLng, {
                  icon: L.divIcon({
                    html: labelContent,
                    className: 'measure-label-shadow',
                    iconSize: [0, 0],
                    iconAnchor: [-5, 10]
                  }),
                  pane: 'measurement'
                }).addTo(map)
              }
            }
          } else {
            map.getContainer().style.cursor = 'default'
          }
        })

        // 监听双击事件结束测量（使用模块级共享 ref）
        map.on('dblclick', (e: L.LeafletMouseEvent) => {
          if (__sharedMeasureModeRef.current) {
            // 禁止双击缩放
            e.originalEvent.stopPropagation()
            __sharedFinishMeasurementRef.current?.()
          }
        })

        // 添加高德地图图层
        // 注意：高德地图服务器对不存在的瓦片（如海洋区域、地图边界外）会返回 404，这是正常行为
        const tileLayer = L.tileLayer(getAMapTileUrl(savedState.mapLayerType), {
          attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>',
          maxZoom: 18,
          minZoom: 3,
          crossOrigin: 'anonymous',  // 跨域标识，与 Canvas 配合防止渲染拖影
        }).addTo(map)

        // 监听瓦片加载事件（用于检测网络恢复），直接在首次创建时添加
        tileLayer.on('load', () => {
          hasLoadedAnyTileRef.current = true
          hasNetworkErrorRef.current = false
          if (networkError.visible) {
            setNetworkError(prev => ({ ...prev, visible: false }))
          }
        })

        // 监听浏览器网络状态变化（仅依赖系统级事件）
        const handleOnline = () => {
          console.log('[OnlineMap] 浏览器检测到网络恢复')
          hasNetworkErrorRef.current = false
          // 清除错误提示
          if (networkError.visible) {
            setNetworkError(prev => ({ ...prev, visible: false }))
          }
        }

        const handleOffline = () => {
          console.log('[OnlineMap] 浏览器检测到网络断开')
          hasNetworkErrorRef.current = true
          // 显示错误提示
          setNetworkError({
            visible: true,
            message: '网络连接已断开，请检查网络设置',
            canRetry: true
          })
        }

        window.addEventListener('online', handleOnline)
        window.addEventListener('offline', handleOffline)

        // 保存事件监听器引用，用于清理
        networkEventListenersRef.current = {
          handleOnline,
          handleOffline,
          cleanup: () => {
            window.removeEventListener('online', handleOnline)
            window.removeEventListener('offline', handleOffline)
          }
        }

        tileLayerRef.current = tileLayer
        mapInstanceRef.current = map

        // 保存地图实例到共享缓存（后续页面切换可复用）
        __sharedMapCache = {
          map: map,
          tileLayer: tileLayer,
          leafletContainer: leafletContainer,
          mapLayerType: savedState.mapLayerType,
        }

        // 监听地图移动和缩放
        const saveMapState = () => {
          const center = map.getCenter()
          const zoom = map.getZoom()
          mapStateService.setState({
            center: [center.lat, center.lng] as [number, number],
            zoom: zoom
          })
        }

        map.on('moveend', saveMapState)
        map.on('zoomend', saveMapState)

        // 监听地图点击事件（使用模块级共享 ref，跨组件实例保持最新）
        map.on('click', (event: L.LeafletMouseEvent) => {
          __sharedHandleMapClickRef.current?.(event)
        })

        // 监听地图右键事件，用于结束测量
        map.on('contextmenu', handleMapContextMenu)

        // 初始化MapInfo图层管理器
        if (!mapInfoLayerManagerRef.current) {
          const manager = new MapInfoLayerManager()
          manager.setMap(map)
          mapInfoLayerManagerRef.current = manager
        }

        // 初始化地理化数据图层管理器
        if (!geoDataLayerManagerRef.current) {
          const geoManager = new GeoDataLayerManager()
          geoManager.init(map)
          geoDataLayerManagerRef.current = geoManager
        }

        // 加载扇区数据
        await loadSectorData()

        setLoading(false)
        setIsMapInitialized(true)
        isInitializingRef.current = false
        console.log('[OnlineMap] 地图初始化完成')
      } catch (error) {
        console.error('[OnlineMap] 初始化地图失败:', error)

        // 判断错误类型并设置网络错误状态
        const errorMessage = error instanceof Error ? error.message : '未知错误'

        // 检查是否是网络相关错误
        const isNetworkError = errorMessage.includes('Failed to fetch') ||
                             errorMessage.includes('NetworkError') ||
                             errorMessage.includes('load') ||
                             errorMessage.includes('网络')

        setNetworkError({
          visible: true,
          message: isNetworkError
            ? '网络连接异常，无法加载在线地图。请检查网络连接或后端服务状态。'
            : `地图初始化失败: ${errorMessage}`,
          canRetry: true
        })

        setLoading(false)
        isInitializingRef.current = false
        // 失败时重置标志，允许重试（除非是 Strict Mode 双重调用）
        // initializedRef 保持为 true 以防止 Strict Mode 第二次调用
      }
    }

    initMap()

    return () => {
      // === 步骤一：优先清理各页面特有的数据图层（必须使用 map.removeLayer） ===
      // 必须在 mapInstanceRef 置空前完成，否则无法从 Leaflet 地图上移除图层
      // 解决：页面切换时旧扇区图层残留导致的 ① 图层污染 ② 性能累积退化
      if (mapInstanceRef.current) {
        const map = mapInstanceRef.current

        // 1. 移除扇区 SVG 图层（每个页面的 mode 不同，必须完全重建）
        if (lteSectorLayerRef.current) {
          try { map.removeLayer(lteSectorLayerRef.current) } catch (e) { /* ignore */ }
          lteSectorLayerRef.current = null
        }
        if (nrSectorLayerRef.current) {
          try { map.removeLayer(nrSectorLayerRef.current) } catch (e) { /* ignore */ }
          nrSectorLayerRef.current = null
        }

        // 2. 清理各管理器维护的图层（点位图、MapInfo 等）
        if (mapInfoLayerManagerRef.current) {
          mapInfoLayerManagerRef.current.clear()
          mapInfoLayerManagerRef.current = null
        }
        if (geoDataLayerManagerRef.current) {
          geoDataLayerManagerRef.current.clear()
          geoDataLayerManagerRef.current = null
        }
        loadedMapInfoLayersRef.current.clear()
        mapInfoLayerRefsRef.current.clear()

        // 3. 清理打点标记和装饰图层（MapPage 专用，需跨页面清除以免污染）
        // 打点标记 (capture markers)
        captureMarkersRef.current.forEach(marker => {
          try { map.removeLayer(marker) } catch (e) { /* ignore */ }
        })
        captureMarkersRef.current = []
        // 打点标签
        markerLabelElementsRef.current.forEach(labelMarker => {
          try { map.removeLayer(labelMarker) } catch (e) { /* ignore */ }
        })
        markerLabelElementsRef.current.clear()
        markerLabelsRef.current.clear()
        // 定位标记 (search location)
        locationMarkersRef.current.forEach(marker => {
          try { map.removeLayer(marker) } catch (e) { /* ignore */ }
        })
        locationMarkersRef.current = []
        // 装饰图层
        if (decorationLayerRef.current) {
          try { map.removeLayer(decorationLayerRef.current) } catch (e) { /* ignore */ }
          decorationLayerRef.current = null
        }

        // 4. 清理测距痕迹（线条、标记、预览线），避免跨页面残留
        measurementLinesRef.current.forEach(line => {
          try { map.removeLayer(line) } catch (e) { /* ignore */ }
        })
        measurementLinesRef.current = []
        measurementMarkersRef.current.forEach(marker => {
          try { map.removeLayer(marker) } catch (e) { /* ignore */ }
        })
        measurementMarkersRef.current = []
        if (measurementDistanceRef.current) {
          try { map.removeLayer(measurementDistanceRef.current) } catch (e) { /* ignore */ }
          measurementDistanceRef.current = null
        }
        if (shadowLineRef.current) {
          try { map.removeLayer(shadowLineRef.current) } catch (e) { /* ignore */ }
          shadowLineRef.current = null
        }
        if (shadowLabelRef.current) {
          try { map.removeLayer(shadowLabelRef.current) } catch (e) { /* ignore */ }
          shadowLabelRef.current = null
        }
        measurementLineStartIndexRef.current = 0
        measurementMarkerStartIndexRef.current = 0
        // 清除搜索标记
        searchMarkerRef.current.forEach(marker => {
          try { map.removeLayer(marker) } catch (e) { /* ignore */ }
        })
        searchMarkerRef.current = []

        // === 步骤二：缓存地图实例（瓦片图层保持存活，仅移除数据图层） ===
        if (tileLayerRef.current) {
          const tileLayer = tileLayerRef.current
          const leafletContainer = map.getContainer()
          const center = map.getCenter()
          const zoom = map.getZoom()

          // 将 Leaflet 容器从当前组件 DOM 中分离，移到隐藏存储区域
          if (leafletContainer.parentNode) {
            leafletContainer.parentNode.removeChild(leafletContainer)
          }
          if (!__sharedHiddenContainer) {
            __sharedHiddenContainer = document.createElement('div')
            __sharedHiddenContainer.style.display = 'none'
            document.body.appendChild(__sharedHiddenContainer)
          }
          __sharedHiddenContainer.appendChild(leafletContainer)

          // 保存缓存（仅缓存底层地图和瓦片，数据图层已在上面清理）
          __sharedMapCache = {
            map: map,
            tileLayer: tileLayer,
            leafletContainer: leafletContainer,
            mapLayerType: mapLayerType,
          }

          // 保存地图状态到 mapStateService
          mapStateService.setState({
            center: [center.lat, center.lng] as [number, number],
            zoom: zoom,
            mapLayerType: mapLayerType,
          })
        }
      }

      // === 步骤三：清理 React ref 和浏览器级资源 ===
      mapInstanceRef.current = null
      tileLayerRef.current = null

      // 清理瓦片加载超时定时器
      if (tileLoadTimeoutRef.current) {
        clearTimeout(tileLoadTimeoutRef.current)
        tileLoadTimeoutRef.current = null
      }

      // 清理网络事件监听器和定时器
      if (networkEventListenersRef.current) {
        if (networkEventListenersRef.current.cleanup) {
          networkEventListenersRef.current.cleanup()
        } else {
          // 兼容旧版本逻辑
          window.removeEventListener('online', networkEventListenersRef.current.handleOnline)
          window.removeEventListener('offline', networkEventListenersRef.current.handleOffline)
        }
        networkEventListenersRef.current = null
      }

      // 重置正在初始化标志，但保持 initializedRef 为 true 以防止 Strict Mode 第二次调用
      isInitializingRef.current = false
      // 注意：不重置 initializedRef，因为同一个组件实例（Strict Mode 双重调用）不应该初始化两次
      // 如果组件完全卸载后重新挂载，useEffect 会重新执行，此时 initializedRef 会在新的闭包中重新创建

      console.log('[OnlineMap] 页面切换 - 地图实例已缓存复用（所有数据图层已清理）')
    }
    // 只在mount时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 用于跟踪最新的handleMapClick函数
  const handleMapClickRef = useRef(handleMapClick)
  const measurePointsRef = useRef(measurePoints)
  const finishMeasurementRef = useRef(finishMeasurement)
  const undoLastPointRef = useRef(undoLastPoint)

  // 更新refs（含模块级共享 ref，确保地图缓存后事件监听器能访问最新的组件状态）
  useEffect(() => {
    handleMapClickRef.current = handleMapClick
    measurePointsRef.current = measurePoints
    finishMeasurementRef.current = finishMeasurement
    undoLastPointRef.current = undoLastPoint
    measureModeRef.current = measureMode
    // 同步模块级共享 ref（地图事件监听器通过它们访问最新状态）
    __sharedCaptureModeRef.current = captureMode
    __sharedMeasureModeRef.current = measureMode
    __sharedMeasurePointsRef.current = measurePoints
    __sharedFinishMeasurementRef.current = finishMeasurement
    __sharedHandleMapClickRef.current = handleMapClick
  }, [handleMapClick, measurePoints, finishMeasurement, measureMode, captureMode])

  useEffect(() => {
    if (mapInstanceRef.current) {
      const map = mapInstanceRef.current
      if (measureMode) {
        map.getContainer().style.cursor = 'crosshair'
        map.dragging.enable()
        map.doubleClickZoom.disable() // 测距模式下禁用双击缩放，改为结束测距

        // 通知扇区图层进入测距模式，禁用扇区点击
        if (lteSectorLayerRef.current) {
          lteSectorLayerRef.current.setMeasureMode(true)
        }
        if (nrSectorLayerRef.current) {
          nrSectorLayerRef.current.setMeasureMode(true)
        }
      } else {
        // 非测距模式：恢复默认光标（mapDragTool 为 true 时由单独 useEffect 的 CSS class 接管）
        map.getContainer().style.cursor = ''
        map.dragging.enable()
        map.doubleClickZoom.enable()

        // 通知扇区图层退出测距模式，恢复扇区点击
        if (lteSectorLayerRef.current) {
          lteSectorLayerRef.current.setMeasureMode(false)
        }
        if (nrSectorLayerRef.current) {
          nrSectorLayerRef.current.setMeasureMode(false)
        }
      }
    }
  }, [measureMode, mapDragTool])

  /**
   * 监听地图拖拽工具状态
   * 激活时：始终保持手型光标（CSS !important 覆盖 Leaflet 内部光标管理），禁用双击缩放，只允许拖拽地图
   * 同时禁用所有图层交互（悬停提示、点击事件等）
   */
  useEffect(() => {
    if (mapInstanceRef.current) {
      const map = mapInstanceRef.current
      const container = map.getContainer()
      if (mapDragTool) {
        map.dragging.enable()
        map.doubleClickZoom.disable()
        // 使用 CSS class + !important 覆盖 Leaflet 内部光标重置，确保始终显示手形
        container.classList.add('map-drag-active')
        // 清除可能残留的 inline cursor（CSS class 的 !important 会接管）
        container.style.cursor = ''

        // 禁用扇区图层的悬停提示和点击交互
        if (lteSectorLayerRef.current) lteSectorLayerRef.current.updateSelectionMode(true)
        if (nrSectorLayerRef.current) nrSectorLayerRef.current.updateSelectionMode(true)

        // 禁用 MapInfoLayer 的点击交互
        mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
          mapInfoLayer.setInteractive(false)
        })

        // 禁用 GeoDataLayer 的点击交互
        if (geoDataLayerManagerRef.current) {
          geoDataLayerManagerRef.current.setInteractive(false)
        }
      } else {
        // 关闭拖拽工具：恢复正常状态
        container.classList.remove('map-drag-active')
        container.style.cursor = ''
        map.dragging.enable()
        if (!measureMode) {
          map.doubleClickZoom.enable()
        }

        // 恢复扇区图层的悬停提示和点击交互
        if (lteSectorLayerRef.current) lteSectorLayerRef.current.updateSelectionMode(false)
        if (nrSectorLayerRef.current) nrSectorLayerRef.current.updateSelectionMode(false)

        // 恢复 MapInfoLayer 的点击交互
        mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
          mapInfoLayer.setInteractive(true)
        })

        // 恢复 GeoDataLayer 的点击交互
        if (geoDataLayerManagerRef.current) {
          geoDataLayerManagerRef.current.setInteractive(true)
        }
      }
    }
  }, [mapDragTool, measureMode])

  /**
   * 框选功能辅助函数
   */

  /**
   * 清除选中状态和高亮
   */
  const clearSelectionState = useCallback(() => {
    selectedFeaturesRef.current = []
    selectedIdsRef.current = new Set()
    // 清除扇区图层高亮
    if (lteSectorLayerRef.current) {
      lteSectorLayerRef.current.setSelectionHighlight(null)
    }
    if (nrSectorLayerRef.current) {
      nrSectorLayerRef.current.setSelectionHighlight(null)
    }
    // 清除GeoDataLayer高亮
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
        geoLayer.setSelectionHighlight(null)
      })
    }
    // 清除MapInfo图层高亮
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      mapInfoLayer.setSelectionHighlight(null)
    })
  }, [])

  /**
   * 点选：选择点击位置附近的要素
   * @param latLng 点击位置 (GCJ-02渲染坐标)
   * @param clientX 浏览器视口X坐标 (用于精确像素命中检测)
   * @param clientY 浏览器视口Y坐标 (用于精确像素命中检测)
   * @param isMultiSelect 是否多选模式（Shift+点击）
   * @returns 选中的要素及其属性
   */
  const selectFeaturesAtPoint = useCallback((latLng: L.LatLng, clientX?: number, clientY?: number, isMultiSelect: boolean = false): { ids: Set<string>, properties: any[] } => {
    // 获取当前图层可见性
    const visibility = layerVisibilityRef.current

    // 收集点击位置的所有要素
    const clickedFeatures: Array<{ id: string, props: any, layerType: string }> = []

    // 1. 遍历所有MapInfoLayer（只选择可见图层）
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      // 检查图层是否可见
      if (!mapInfoLayer.isVisible()) return

      // 获取图层内的所有要素
      const geoJSONLayer = mapInfoLayer.getLeafletLayer()
      if (!geoJSONLayer) return

      geoJSONLayer.eachLayer((layer: any) => {
        let isNear = false

        if (layer.getLatLng) {
          // 点要素
          const pointLatLng = layer.getLatLng()
          const distance = latLng.distanceTo(pointLatLng)
          isNear = distance < 30 // 提高容差到30米
        } else if (layer.getBounds) {
          // 线/面要素: 检查边界是否包含点击点
          const bounds = layer.getBounds()
          isNear = bounds.contains(latLng)
        }

        if (isNear) {
          const props = layer.feature.properties
          // 尝试多种可能的ID字段
          const id = props.id || props.name || props.小区名称 || props.OBJECTID || ''
          if (id) {
            clickedFeatures.push({ id: String(id), props: { ...props, _layerType: 'MapInfo' }, layerType: 'MapInfo' })
          }
        }
      })
    })

    // 2. 遍历 GeoDataLayer（装饰图层）
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
        if (!geoLayer.isVisible()) return
        // 创建一个临时的小圆来查询（模拟点选）
        const L = window.L
        const tempCircle = L.circle(latLng, { radius: 30 }) // 30米容差
        const features = geoLayer.getFeaturesInCircle(latLng, 30)
        features.forEach(item => {
          const id = item.name || item.properties?.id || ''
          if (id) {
            clickedFeatures.push({ id: String(id), props: { ...item.properties, _layerType: 'GeoData', _geoDataName: item.name }, layerType: 'GeoData' })
          }
        })
      })
    }

    // 3. 遍历扇区图层 (LTE/NR) - 只选择可见图层
    if (visibility.lte && lteSectorLayerRef.current) {
      let sectorsAtPoint: RenderSectorData[] = []
      if (clientX !== undefined && clientY !== undefined) {
        sectorsAtPoint = lteSectorLayerRef.current.getSectorsAt(clientX, clientY)
      }
      sectorsAtPoint.forEach(sector => {
        clickedFeatures.push({ id: String(sector.id), props: { ...sector, _layerType: 'LTE' }, layerType: 'LTE' })
      })
    }

    if (visibility.nr && nrSectorLayerRef.current) {
      let sectorsAtPoint: RenderSectorData[] = []
      if (clientX !== undefined && clientY !== undefined) {
        sectorsAtPoint = nrSectorLayerRef.current.getSectorsAt(clientX, clientY)
      }
      sectorsAtPoint.forEach(sector => {
        clickedFeatures.push({ id: String(sector.id), props: { ...sector, _layerType: 'NR' }, layerType: 'NR' })
      })
    }

    // 4. 遍历抓取坐标点
    captureMarkersRef.current.forEach(marker => {
      if (!mapInstanceRef.current || !mapInstanceRef.current.hasLayer(marker)) return
      const markerLatLng = marker.getLatLng()
      if (markerLatLng && latLng.distanceTo(markerLatLng) < 30) {
        const props = (marker as any).captureProperties
        if (props) {
          clickedFeatures.push({ id: props.id, props, layerType: 'CapturePoint' })
        }
      }
    })

    // 如果没有点击到任何要素
    if (clickedFeatures.length === 0) {
      if (!isMultiSelect) {
        // 非多选模式下点击空白区域：清除所有选择状态和图形
        clearSelectionState()
        // 清除框选图形（圆形/多边形/矩形）
        const map = mapInstanceRef.current
        if (map) {
          if (selectionShapeRef.current) {
            map.removeLayer(selectionShapeRef.current)
            selectionShapeRef.current = null
          }
          if (selectionRectRef.current) {
            map.removeLayer(selectionRectRef.current)
            selectionRectRef.current = null
          }
          if (polygonTempLayerRef.current) {
            map.removeLayer(polygonTempLayerRef.current)
            polygonTempLayerRef.current = null
          }
        }
        // 清除提示信息
        setSelectionTip('')
      }
      return { ids: new Set(), properties: [] }
    }

    // 处理选中逻辑
    let selectedIds: Set<string>
    let selectedProperties: any[]

    if (isMultiSelect) {
      // 多选模式：从现有选中集合开始，添加/移除新要素（支持toggle）
      selectedIds = new Set(selectedIdsRef.current)
      selectedProperties = [...selectedFeaturesRef.current]

      clickedFeatures.forEach(feature => {
        if (selectedIds.has(feature.id)) {
          // 已选中，取消选择
          selectedIds.delete(feature.id)
          selectedProperties = selectedProperties.filter(p => {
            const pid = p.id || p.name || p.小区名称 || p.OBJECTID || ''
            return String(pid) !== feature.id
          })
          console.log('[OnlineMap] Shift+点选取消要素:', feature.props.name || feature.id, 'from', feature.layerType)
        } else {
          // 未选中，添加选择
          selectedIds.add(feature.id)
          selectedProperties.push(feature.props)
          console.log('[OnlineMap] Shift+点选添加要素:', feature.props.name || feature.id, 'from', feature.layerType)
        }
      })
    } else {
      // 单选模式：支持toggle操作
      if (clickedFeatures.length === 1) {
        // 只点击了一个要素，检查是否已选中
        const feature = clickedFeatures[0]
        const wasSelected = selectedIdsRef.current.has(feature.id)

        if (wasSelected) {
          // 已选中，取消选择
          selectedIds = new Set(selectedIdsRef.current)
          selectedProperties = [...selectedFeaturesRef.current]
          selectedIds.delete(feature.id)
          selectedProperties = selectedProperties.filter(p => {
            const pid = p.id || p.name || p.小区名称 || p.OBJECTID || ''
            return String(pid) !== feature.id
          })
          console.log('[OnlineMap] 点选取消要素:', feature.props.name || feature.id)
        } else {
          // 未选中，选中它
          selectedIds = new Set([feature.id])
          selectedProperties = [feature.props]
          console.log('[OnlineMap] 点选选中要素:', feature.props.name || feature.id, 'from', feature.layerType)
        }
      } else {
        // 点击了多个要素，只选中第一个
        const feature = clickedFeatures[0]
        selectedIds = new Set([feature.id])
        selectedProperties = [feature.props]
        console.log('[OnlineMap] 点选选中要素（多个中的第一个）:', feature.props.name || feature.id, 'from', feature.layerType)
      }
    }

    // 应用高亮
    console.log('[OnlineMap] 点选选中要素总数:', selectedIds.size, isMultiSelect ? '(多选模式)' : '')

    // 对MapInfoLayer应用高亮
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      mapInfoLayer.setSelectionHighlight(selectedIds)
    })

    // 对GeoDataLayer应用高亮
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
        geoLayer.setSelectionHighlight(selectedIds)
      })
    }

    // 对扇区图层应用高亮
    if (lteSectorLayerRef.current) {
      lteSectorLayerRef.current.setSelectionHighlight(selectedIds)
    }
    if (nrSectorLayerRef.current) {
      nrSectorLayerRef.current.setSelectionHighlight(selectedIds)
    }

    // 保存选中状态到 Ref
    selectedFeaturesRef.current = selectedProperties
    selectedIdsRef.current = selectedIds

    // 更新提示信息
    if (selectedIds.size > 0) {
      setSelectionTip(`${t('map.featuresSelected', { count: selectedIds.size })}，${t('map.copyTip') || '按 Ctrl+C 复制'}`)
    } else {
      setSelectionTip(t('map.clickToSelectFeatures') || '点击选择要素（再次点击取消），Shift+点击多选，按 Ctrl+C 复制')
    }

    return { ids: selectedIds, properties: selectedProperties }
  }, [])

  /**
   * 圆形选择：选择圆内的所有要素
   * @param center 圆心 (GCJ-02渲染坐标)
   * @param radius 半径 (米)
   * @param isMultiSelect 是否多选（Shift键），true时叠加到已有选中
   * @returns 选中的要素及其属性
   */
  const selectFeaturesInCircle = useCallback((center: L.LatLng, radius: number, isMultiSelect: boolean = false): { ids: Set<string>, properties: any[] } => {
    // 获取当前图层可见性
    const visibility = layerVisibilityRef.current

    const newIds = new Set<string>()
    const newProperties: any[] = []

    // 1. 遍历所有MapInfoLayer（只选择可见图层）
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      // 检查图层是否可见
      const isVisible = mapInfoLayer.isVisible()
      console.log('[OnlineMap] 圆形框选检查MapInfo图层:', {
        id: (mapInfoLayer as any).id,
        name: (mapInfoLayer as any).name,
        isVisible
      })
      if (!isVisible) return

      // 使用MapInfoLayer的getFeaturesInCircle方法
      const features = mapInfoLayer.getFeaturesInCircle(center, radius)
      console.log('[OnlineMap] MapInfo图层返回的要素数量:', features.length)

      // 收集要素ID和属性
      features.forEach(props => {
        const id = props.id || props.name || props.小区名称 || props.OBJECTID || ''
        console.log('[OnlineMap] 处理要素:', { id, props })
        if (id) {
          newIds.add(String(id))
          newProperties.push({ ...props, _layerType: 'MapInfo' })
        }
      })
    })

    // 2. 遍历 GeoDataLayer（装饰图层）
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
        if (!geoLayer.isVisible()) return
        const features = geoLayer.getFeaturesInCircle(center, radius)
        features.forEach(item => {
          const id = item.name || item.properties?.id || ''
          if (id) {
            newIds.add(String(id))
            newProperties.push({ ...item.properties, _layerType: 'GeoData', _geoDataName: item.name })
            console.log('[OnlineMap] 圆形框选选中GeoData要素:', item.name || id)
          }
        })
      })
    }

    // 3. 遍历扇区图层 (LTE/NR) - 只选择可见图层
    if (visibility.lte && lteSectorLayerRef.current) {
      const sectorsInCircle = lteSectorLayerRef.current.getSectorsInCircle(center, radius)
      sectorsInCircle.forEach(sector => {
        const id = String(sector.id)
        newIds.add(id)
        newProperties.push({ ...sector, _layerType: 'LTE' })
        console.log('[OnlineMap] 圆形框选选中LTE扇区:', sector.name, sector.id)
      })
    }

    if (visibility.nr && nrSectorLayerRef.current) {
      const sectorsInCircle = nrSectorLayerRef.current.getSectorsInCircle(center, radius)
      sectorsInCircle.forEach(sector => {
        const id = String(sector.id)
        newIds.add(id)
        newProperties.push({ ...sector, _layerType: 'NR' })
        console.log('[OnlineMap] 圆形框选选中NR扇区:', sector.name, sector.id)
      })
    }

    // 4. 遍历抓取坐标点
    captureMarkersRef.current.forEach(marker => {
      if (!mapInstanceRef.current || !mapInstanceRef.current.hasLayer(marker)) return
      const markerLatLng = marker.getLatLng()
      if (markerLatLng && center.distanceTo(markerLatLng) <= radius) {
        const props = (marker as any).captureProperties
        if (props) {
          newIds.add(props.id)
          newProperties.push({ ...props })
        }
      }
    })

    // 5. 遍历定位标记点
    locationMarkersRef.current.forEach(marker => {
      if (!mapInstanceRef.current || !mapInstanceRef.current.hasLayer(marker)) return
      const markerLatLng = marker.getLatLng()
      if (markerLatLng && center.distanceTo(markerLatLng) <= radius) {
        const props = (marker as any).captureProperties
        if (props) {
          newIds.add(props.id)
          newProperties.push({ ...props })
        }
      }
    })

    // 合并选中状态（多选时叠加，单选时替换）
    let selectedIds: Set<string>
    let selectedProperties: any[]

    if (isMultiSelect) {
      // Shift模式：叠加到已有选中
      selectedIds = new Set(selectedIdsRef.current)
      selectedProperties = [...selectedFeaturesRef.current]
      newIds.forEach(id => {
        if (!selectedIds.has(id)) {
          selectedIds.add(id)
          const prop = newProperties.find(p => {
            const pid = p.id || p.name || p.小区名称 || p.OBJECTID || ''
            return String(pid) === id
          })
          if (prop) selectedProperties.push(prop)
        }
      })
    } else {
      selectedIds = newIds
      selectedProperties = newProperties
    }

    // 应用高亮
    // 对MapInfoLayer应用高亮
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      mapInfoLayer.setSelectionHighlight(selectedIds)
    })

    // 对GeoDataLayer应用高亮
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
        geoLayer.setSelectionHighlight(selectedIds)
      })
    }

    // 对扇区图层应用高亮
    if (lteSectorLayerRef.current) {
      lteSectorLayerRef.current.setSelectionHighlight(selectedIds)
    }
    if (nrSectorLayerRef.current) {
      nrSectorLayerRef.current.setSelectionHighlight(selectedIds)
    }

    // 保存选中状态到 Ref
    selectedFeaturesRef.current = selectedProperties
    selectedIdsRef.current = selectedIds

    if (selectedIds.size > 0) {
      console.log('[OnlineMap] 圆形框选选中要素总数:', selectedIds.size)
      setSelectionTip(`${t('map.featuresSelected', { count: selectedIds.size })}，${t('map.copyTip') || '按 Ctrl+C 复制'}`)
    } else {
      setSelectionTip(t('map.noFeatureSelected'))
    }

    return { ids: selectedIds, properties: selectedProperties }
  }, [])

  /**
   * 多边形选择：选择多边形内的所有要素
   * @param points 多边形顶点 (GCJ-02渲染坐标)
   * @param isMultiSelect 是否多选（Shift键），true时叠加到已有选中
   * @returns 选中的要素及其属性
   */
  const selectFeaturesInPolygon = useCallback((points: L.LatLng[], isMultiSelect: boolean = false): { ids: Set<string>, properties: any[] } => {
    const L = window.L
    // 获取当前图层可见性
    const visibility = layerVisibilityRef.current

    const newIds = new Set<string>()
    const newProperties: any[] = []

    if (points.length < 3) {
      console.warn('[OnlineMap] 多边形至少需要3个点')
      return { ids: newIds, properties: newProperties }
    }

    // 创建临时多边形对象用于查询
    const polygon = L.polygon(points.map(p => [p.lat, p.lng]))

    // 1. 遍历所有MapInfoLayer（只选择可见图层）
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      // 检查图层是否可见
      if (!mapInfoLayer.isVisible()) return

      // 使用MapInfoLayer的getFeaturesInPolygon方法
      const features = mapInfoLayer.getFeaturesInPolygon(polygon)

      // 收集要素ID和属性
      features.forEach(props => {
        const id = props.id || props.name || props.小区名称 || props.OBJECTID || ''
        if (id) {
          newIds.add(String(id))
          newProperties.push({ ...props, _layerType: 'MapInfo' })
        }
      })
    })

    // 2. 遍历 GeoDataLayer（装饰图层）
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
        if (!geoLayer.isVisible()) return
        const features = geoLayer.getFeaturesInPolygon(polygon)
        features.forEach(item => {
          const id = item.name || item.properties?.id || ''
          if (id) {
            newIds.add(String(id))
            newProperties.push({ ...item.properties, _layerType: 'GeoData', _geoDataName: item.name })
            console.log('[OnlineMap] 多边形框选选中GeoData要素:', item.name || id)
          }
        })
      })
    }

    // 3. 遍历扇区图层 (LTE/NR) - 只选择可见图层
    if (visibility.lte && lteSectorLayerRef.current) {
      const sectorsInPolygon = lteSectorLayerRef.current.getSectorsInPolygon(polygon)
      sectorsInPolygon.forEach(sector => {
        const id = String(sector.id)
        newIds.add(id)
        newProperties.push({ ...sector, _layerType: 'LTE' })
        console.log('[OnlineMap] 多边形框选选中LTE扇区:', sector.name, sector.id)
      })
    }

    if (visibility.nr && nrSectorLayerRef.current) {
      const sectorsInPolygon = nrSectorLayerRef.current.getSectorsInPolygon(polygon)
      sectorsInPolygon.forEach(sector => {
        const id = String(sector.id)
        newIds.add(id)
        newProperties.push({ ...sector, _layerType: 'NR' })
        console.log('[OnlineMap] 多边形框选选中NR扇区:', sector.name, sector.id)
      })
    }

    // 4. 遍历抓取坐标点
    captureMarkersRef.current.forEach(marker => {
      if (!mapInstanceRef.current || !mapInstanceRef.current.hasLayer(marker)) return
      const markerLatLng = marker.getLatLng()
      if (markerLatLng) {
        // 使用 Leaflet 的 getBounds().contains() 检查点是否在多边形内
        const isInside = polygon.getBounds().contains(markerLatLng)
        if (isInside) {
          const props = (marker as any).captureProperties
          if (props) {
            newIds.add(props.id)
            newProperties.push({ ...props })
          }
        }
      }
    })

    // 5. 遍历定位标记点
    locationMarkersRef.current.forEach(marker => {
      if (!mapInstanceRef.current || !mapInstanceRef.current.hasLayer(marker)) return
      const markerLatLng = marker.getLatLng()
      if (markerLatLng) {
        // 使用 Leaflet 的 getBounds().contains() 检查点是否在多边形内
        const isInside = polygon.getBounds().contains(markerLatLng)
        if (isInside) {
          const props = (marker as any).captureProperties
          if (props) {
            newIds.add(props.id)
            newProperties.push({ ...props })
          }
        }
      }
    })

    // 合并选中状态（多选时叠加，单选时替换）
    let selectedIds: Set<string>
    let selectedProperties: any[]

    if (isMultiSelect) {
      // Shift模式：叠加到已有选中
      selectedIds = new Set(selectedIdsRef.current)
      selectedProperties = [...selectedFeaturesRef.current]
      newIds.forEach(id => {
        if (!selectedIds.has(id)) {
          selectedIds.add(id)
          const prop = newProperties.find(p => {
            const pid = p.id || p.name || p.小区名称 || p.OBJECTID || ''
            return String(pid) === id
          })
          if (prop) selectedProperties.push(prop)
        }
      })
    } else {
      selectedIds = newIds
      selectedProperties = newProperties
    }

    // 应用高亮
    // 对MapInfoLayer应用高亮
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      mapInfoLayer.setSelectionHighlight(selectedIds)
    })

    // 对GeoDataLayer应用高亮
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
        geoLayer.setSelectionHighlight(selectedIds)
      })
    }

    // 对扇区图层应用高亮
    if (lteSectorLayerRef.current) {
      lteSectorLayerRef.current.setSelectionHighlight(selectedIds)
    }
    if (nrSectorLayerRef.current) {
      nrSectorLayerRef.current.setSelectionHighlight(selectedIds)
    }

    // 保存选中状态到 Ref
    selectedFeaturesRef.current = selectedProperties
    selectedIdsRef.current = selectedIds

    if (selectedIds.size > 0) {
      console.log('[OnlineMap] 多边形框选选中要素总数:', selectedIds.size)
      setSelectionTip(`${t('map.featuresSelected', { count: selectedIds.size })}，${t('map.copyTip') || '按 Ctrl+C 复制'}`)
    } else {
      setSelectionTip(t('map.noFeatureSelected'))
    }

    return { ids: selectedIds, properties: selectedProperties }
  }, [])

  /**
   * 矩形选择：选择矩形范围内的所有要素（复用多边形逻辑，将矩形转为四边形）
   * @param sw 矩形西南角 (GCJ-02渲染坐标)
   * @param ne 矩形东北角 (GCJ-02渲染坐标)
   * @param isMultiSelect 是否多选（Shift键），true时叠加到已有选中
   */
  const selectFeaturesInRectangle = useCallback((sw: L.LatLng, ne: L.LatLng, isMultiSelect: boolean = false): { ids: Set<string>, properties: any[] } => {
    const L = window.L
    // 将矩形转为四个顶点的多边形
    const points = [
      L.latLng(sw.lat, sw.lng),
      L.latLng(sw.lat, ne.lng),
      L.latLng(ne.lat, ne.lng),
      L.latLng(ne.lat, sw.lng),
    ]

    // 获取当前图层可见性
    const visibility = layerVisibilityRef.current

    // 多选模式下从已有选中开始，否则重置
    const newIds = new Set<string>()
    const newProperties: any[] = []

    const polygon = L.polygon(points.map(p => [p.lat, p.lng]))

    // 1. 遍历所有 MapInfoLayer
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      const isVisible = mapInfoLayer.isVisible()
      console.log('[OnlineMap] 矩形框选检查MapInfo图层:', {
        id: (mapInfoLayer as any).id,
        name: (mapInfoLayer as any).name,
        isVisible
      })
      if (!isVisible) return
      const features = mapInfoLayer.getFeaturesInPolygon(polygon)
      console.log('[OnlineMap] MapInfo图层矩形框选返回要素数量:', features.length)
      features.forEach(props => {
        const id = props.id || props.name || props.小区名称 || props.OBJECTID || ''
        if (id) {
          newIds.add(String(id))
          newProperties.push({ ...props, _layerType: 'MapInfo' })
          console.log('[OnlineMap] 矩形框选选中MapInfo要素:', props.name || id)
        }
      })
    })

    // 2. 遍历 GeoDataLayer（装饰图层）
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
        if (!geoLayer.isVisible()) return
        try {
          const features = geoLayer.getFeaturesInPolygon(polygon)
          console.log('[OnlineMap] GeoDataLayer矩形框选返回要素数量:', features.length)
          features.forEach(item => {
            const id = item.name || item.properties?.id || ''
            if (id) {
              newIds.add(String(id))
              newProperties.push({ ...item.properties, _layerType: 'GeoData', _geoDataName: item.name })
              console.log('[OnlineMap] 矩形框选选中GeoData要素:', item.name || id)
            }
          })
        } catch (e) {
          console.error('[OnlineMap] GeoDataLayer矩形框选失败:', e)
        }
      })
    }

    // 3. 扇区图层 (LTE/NR)
    if (visibility.lte && lteSectorLayerRef.current) {
      const sectorsIn = lteSectorLayerRef.current.getSectorsInPolygon(polygon)
      sectorsIn.forEach(sector => {
        newIds.add(String(sector.id))
        newProperties.push({ ...sector, _layerType: 'LTE' })
      })
    }
    if (visibility.nr && nrSectorLayerRef.current) {
      const sectorsIn = nrSectorLayerRef.current.getSectorsInPolygon(polygon)
      sectorsIn.forEach(sector => {
        newIds.add(String(sector.id))
        newProperties.push({ ...sector, _layerType: 'NR' })
      })
    }

    // 3. 抓取坐标点
    captureMarkersRef.current.forEach(marker => {
      if (!mapInstanceRef.current || !mapInstanceRef.current.hasLayer(marker)) return
      const markerLatLng = marker.getLatLng()
      if (markerLatLng) {
        // 使用 Leaflet 的 getBounds().contains() 检查点是否在多边形内
        const isInside = polygon.getBounds().contains(markerLatLng)
        if (isInside) {
          const props = (marker as any).captureProperties
          if (props) {
            newIds.add(props.id)
            newProperties.push({ ...props })
          }
        }
      }
    })

    // 4. 遍历定位标记点
    locationMarkersRef.current.forEach(marker => {
      if (!mapInstanceRef.current || !mapInstanceRef.current.hasLayer(marker)) return
      const markerLatLng = marker.getLatLng()
      if (markerLatLng) {
        // 使用 Leaflet 的 getBounds().contains() 检查点是否在多边形内
        const isInside = polygon.getBounds().contains(markerLatLng)
        if (isInside) {
          const props = (marker as any).captureProperties
          if (props) {
            newIds.add(props.id)
            newProperties.push({ ...props })
          }
        }
      }
    })

    // 合并选中状态（多选时叠加，单选时替换）
    let selectedIds: Set<string>
    let selectedProperties: any[]

    if (isMultiSelect) {
      // Shift模式：叠加到已有选中
      selectedIds = new Set(selectedIdsRef.current)
      selectedProperties = [...selectedFeaturesRef.current]
      newIds.forEach(id => {
        if (!selectedIds.has(id)) {
          selectedIds.add(id)
          const prop = newProperties.find(p => {
            const pid = p.id || p.name || p.小区名称 || p.OBJECTID || ''
            return String(pid) === id
          })
          if (prop) selectedProperties.push(prop)
        }
      })
    } else {
      selectedIds = newIds
      selectedProperties = newProperties
    }

    // 应用高亮
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      mapInfoLayer.setSelectionHighlight(selectedIds)
    })
    // 对GeoDataLayer应用高亮
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
        geoLayer.setSelectionHighlight(selectedIds)
      })
    }
    if (lteSectorLayerRef.current) lteSectorLayerRef.current.setSelectionHighlight(selectedIds)
    if (nrSectorLayerRef.current) nrSectorLayerRef.current.setSelectionHighlight(selectedIds)

    selectedFeaturesRef.current = selectedProperties
    selectedIdsRef.current = selectedIds

    if (selectedIds.size > 0) {
      setSelectionTip(`${t('map.featuresSelected', { count: selectedIds.size })}，${t('map.copyTip') || '按 Ctrl+C 复制'}`)
    } else {
      setSelectionTip(t('map.noFeatureSelected'))
    }

    return { ids: selectedIds, properties: selectedProperties }
  }, [])

  /**
   * 将选中的要素属性格式化为 Tab 分隔的文本，用于粘贴到 Excel
   * @param properties 属性列表
   */
  const formatFeaturesToExcelText = (properties: any[]) => {
    if (!properties || properties.length === 0) return ''

    // 提取所有唯一的键作为表头 (排除内部私有字段和不必要的坐标字段)
    const excludeKeys = new Set(['displayLat', 'displayLng', '_layerType', 'geometry', 'id_type', 'layerId', 'properties', 'attributes'])
    const allKeys = new Set<string>()
    properties.forEach(p => {
      Object.keys(p).forEach(key => {
        if (!excludeKeys.has(key)) allKeys.add(key)
      })
      // 处理嵌套属性
      const nested = p.properties || p.attributes
      if (nested && typeof nested === 'object') {
        Object.keys(nested).forEach(key => {
          if (!excludeKeys.has(key)) allKeys.add(key)
        })
      }
    })

    const header = Array.from(allKeys)
    const rows = properties.map(p => {
      const nested = p.properties || p.attributes || {}
      return header.map(key => {
        const val = p[key] !== undefined ? p[key] : nested[key]
        return val === undefined || val === null ? '' : String(val).replace(/[\r\n\t]/g, ' ')
      }).join('\t')
    })

    return [header.join('\t'), ...rows].join('\n')
  }

  /**
   * 复制选中要素到剪贴板并提示
   */
  const copySelectionToClipboard = (properties: any[]) => {
    const excelText = formatFeaturesToExcelText(properties)
    if (excelText) {
      navigator.clipboard.writeText(excelText).then(() => {
        console.log('[OnlineMap] 选中要素属性已复制到剪贴板，数量:', properties.length)
      }).catch(err => {
        console.error('[OnlineMap] 复制到剪贴板失败:', err)
      })
    }
  }

  /**
   * 监听圈选模式变化 - 控制地图拖拽和交互
   */
  useEffect(() => {
    const isSelectionActive = selectionMode !== 'none'
    if (lteSectorLayerRef.current) lteSectorLayerRef.current.updateSelectionMode(isSelectionActive)
    if (nrSectorLayerRef.current) nrSectorLayerRef.current.updateSelectionMode(isSelectionActive)

    // 框选模式下禁用 MapInfoLayer 和 GeoDataLayer 的点击交互（避免属性框弹出）
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      mapInfoLayer.setInteractive(!isSelectionActive)
    })
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.setInteractive(!isSelectionActive)
    }

    if (mapInstanceRef.current) {
      const map = mapInstanceRef.current
      if (isSelectionActive) {
        // 框选模式下禁用地图拖拽，确保鼠标操作仅服务于选择功能
        // 但保留滚轮缩放功能，方便用户在选择时调整地图视角
        map.dragging.disable()
        map.doubleClickZoom.disable() // 圈选时禁用双击放大
        map.boxZoom.disable() // 禁用Shift+拖拽框选缩放，防止与多边形/框选Shift多选冲突
        // 根据模式设置提示
        if (selectionMode === 'point') {
          setSelectionTip('点击选择要素，或按住鼠标拖拽绘制矩形批量选择，按 Ctrl+C 复制')
        } else if (selectionMode === 'circle') {
          setSelectionTip('按住鼠标左键拖动绘制圆形，按 Ctrl+C 复制')
        } else if (selectionMode === 'polygon') {
          setSelectionTip('点击添加多边形顶点，双击完成绘制，按 Backspace 删除上一个点，按 Ctrl+C 复制')
        }
        // 进入框选模式时，重置临时标志（不清除已有选中）
        preserveSelectionRef.current = false
      } else if (!measureMode) {
        // 退出框选模式时，恢复地图交互
        // 注意：选中状态和图形的清除逻辑在另一个useEffect中处理
        map.dragging.enable()
        map.doubleClickZoom.enable()
        map.boxZoom.enable()
        map.scrollWheelZoom.enable()
        // 恢复光标样式（mapDragTool 为 true 时由单独 useEffect 的 CSS class 接管）
        map.getContainer().style.cursor = ''
      }
    }
  }, [selectionMode, measureMode])

  /**
   * 监听框选模式的鼠标事件
   */
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return

    // 清除之前的框选形状
    const clearSelectionShape = () => {
      if (selectionShapeRef.current) {
        map.removeLayer(selectionShapeRef.current)
        selectionShapeRef.current = null
      }
      if (selectionRectRef.current) {
        map.removeLayer(selectionRectRef.current)
        selectionRectRef.current = null
      }
      if (polygonTempLayerRef.current) {
        map.removeLayer(polygonTempLayerRef.current)
        polygonTempLayerRef.current = null
      }
      if (dragPreviewRectRef.current) {
        map.removeLayer(dragPreviewRectRef.current)
        dragPreviewRectRef.current = null
      }
      if (dragPreviewCircleRef.current) {
        map.removeLayer(dragPreviewCircleRef.current)
        dragPreviewCircleRef.current = null
      }
      selectionStartPointRef.current = null
      selectionDrawingRef.current = false
      pointModeIsDragging.current = false
    }

    // 清除多边形临时点（保留已绘制的点）
    const clearPolygonTempLine = () => {
      if (polygonTempLayerRef.current) {
        map.removeLayer(polygonTempLayerRef.current)
        polygonTempLayerRef.current = null
      }
    }

    // 处理鼠标按下
    const handleMouseDown = (e: L.LeafletMouseEvent) => {
      if (selectionModeRef.current === 'none') return

      const latLng = e.latlng
      const originalEvent = e.originalEvent

      if (selectionModeRef.current === 'point') {
        // 框选模式：记录起点，等待鼠标移动判断是拖拽还是点击
        const isShift = originalEvent.shiftKey
        // 非Shift模式下清除上一次的矩形预览；Shift模式下保留（多区域叠加）
        if (!isShift && selectionRectRef.current) {
          map.removeLayer(selectionRectRef.current)
          selectionRectRef.current = null
        }
        selectionStartPointRef.current = latLng
        pointModeIsDragging.current = false
        // 禁用地图拖拽，避免地图随鼠标移动
        map.dragging.disable()
        // 阻止事件冒泡和默认行为，防止Shift键触发地图缩放
        L.DomEvent.stopPropagation(e)
        L.DomEvent.preventDefault(e)
      } else if (selectionModeRef.current === 'circle') {
        // 圆形模式：开始绘制
        const isShift = originalEvent.shiftKey
        if (!isShift) {
          clearSelectionShape()
        }
        selectionStartPointRef.current = latLng
        selectionDrawingRef.current = true
        // 禁用地图拖拽，避免地图随鼠标移动
        map.dragging.disable()
        setSelectionTip('拖动鼠标绘制圆形，松开完成选择')
        L.DomEvent.stopPropagation(e)
        L.DomEvent.preventDefault(e)
      } else if (selectionModeRef.current === 'polygon') {
        // 多边形模式：单击添加点
        selectionPointsRef.current.push(latLng)
        clearPolygonTempLine()

        // 绘制临时线段
        const L = window.L
        if (selectionPointsRef.current.length >= 1) {
          const points = selectionPointsRef.current.map(p => [p.lat, p.lng])
          // 如果有多个点，绘制线段
          if (points.length >= 2) {
            polygonTempLayerRef.current = L.polyline(points as L.LatLngExpression[], {
              color: '#00ffff',
              weight: 2,
              dashArray: '5, 5'
            }).addTo(map)
          }
        }

        // 多边形绘制过程中不再显示动态点计数提示，保持进入框选时的初始提示即可
        L.DomEvent.stopPropagation(e)
        L.DomEvent.preventDefault(e)
      }
    }

    // 处理鼠标移动
    const handleMouseMove = (e: L.LeafletMouseEvent) => {
      const latLng = e.latlng
      const startPoint = selectionStartPointRef.current

      if (selectionModeRef.current === 'point' && startPoint) {
        // 框选模式：检查是否达到拖拽阈值，如果是则绘制矩形预览
        const containerPoint = map.latLngToContainerPoint(latLng)
        const startContainerPoint = map.latLngToContainerPoint(startPoint)
        const dx = Math.abs(containerPoint.x - startContainerPoint.x)
        const dy = Math.abs(containerPoint.y - startContainerPoint.y)

        if (!pointModeIsDragging.current && (dx > pointModeDragThreshold || dy > pointModeDragThreshold)) {
          pointModeIsDragging.current = true
          setSelectionTip('拖动鼠标绘制矩形，松开完成选择')
        }

        if (pointModeIsDragging.current) {
          // 更新矩形预览 —— 使用独立预览 ref，不覆盖已保存的选中矩形轨迹
          if (dragPreviewRectRef.current) {
            map.removeLayer(dragPreviewRectRef.current)
          }
          const L = window.L
          const bounds = L.latLngBounds(startPoint, latLng)
          dragPreviewRectRef.current = L.rectangle(bounds, {
            color: '#00ffff',
            weight: 2,
            fillColor: '#00ffff',
            fillOpacity: 0.1,
            dashArray: '5, 5',
            interactive: false
          }).addTo(map)
        }
        // 阻止事件冒泡和默认行为，防止Shift键触发地图缩放
        L.DomEvent.stopPropagation(e)
        L.DomEvent.preventDefault(e)
      } else if (selectionModeRef.current === 'circle' && selectionDrawingRef.current && startPoint) {
        // 清除之前的预览形状 —— 使用独立预览 ref，不覆盖已保存的选中圆形轨迹
        if (dragPreviewCircleRef.current) {
          map.removeLayer(dragPreviewCircleRef.current)
        }

        const L = window.L
        const radius = startPoint.distanceTo(latLng)
        dragPreviewCircleRef.current = L.circle(startPoint, {
          radius: radius,
          color: '#00ffff',
          weight: 2,
          fillColor: '#00ffff',
          fillOpacity: 0.1,
          dashArray: '5, 5',
          interactive: false
        }).addTo(map)
        
        setSelectionTip(`半径: ${Math.round(radius)} 米，松开完成选择`)
        L.DomEvent.stopPropagation(e)
      } else if (selectionModeRef.current === 'polygon' && selectionPointsRef.current.length > 0) {
        // 多边形模式：更新临时线段到鼠标位置
        clearPolygonTempLine()
        
        const L = window.L
        const points = selectionPointsRef.current.map(p => [p.lat, p.lng])
        points.push([latLng.lat, latLng.lng]) // 添加鼠标当前位置
        
        polygonTempLayerRef.current = L.polyline(points as L.LatLngExpression[], {
          color: '#00ffff',
          weight: 2,
          dashArray: '5, 5'
        }).addTo(map)
      }
    }

    // 处理鼠标释放
    const handleMouseUp = (e: L.LeafletMouseEvent) => {
      if (selectionModeRef.current === 'none') return

      const latLng = e.latlng
      const startPoint = selectionStartPointRef.current

      if (selectionModeRef.current === 'point' && startPoint) {
        const originalEvent = e.originalEvent
        const isMultiSelect = originalEvent.shiftKey

        if (pointModeIsDragging.current) {
          // 拖拽结束：执行矩形框选
          const L = window.L
          const bounds = L.latLngBounds(startPoint, latLng)
          // 检查矩形是否足够大（避免误触）
          const sw = bounds.getSouthWest()
          const ne = bounds.getNorthEast()
          const widthM = sw.distanceTo(L.latLng(sw.lat, ne.lng))
          const heightM = sw.distanceTo(L.latLng(ne.lat, sw.lng))

          if (widthM > 5 || heightM > 5) {
            // 非多选模式（非Shift）：清除之前的矩形
            if (!isMultiSelect && selectionRectRef.current) {
              map.removeLayer(selectionRectRef.current)
              selectionRectRef.current = null
            }

            selectFeaturesInRectangle(sw, ne, isMultiSelect)

            // 绘制最终矩形（青色框）
            const newRect = L.rectangle(bounds, {
              color: '#00ffff',
              weight: 2,
              fillColor: '#00ffff',
              fillOpacity: 0.1,
              interactive: false
            })

            if (isMultiSelect && selectionRectRef.current) {
              // Shift多选：将新矩形与已有矩形组合为FeatureGroup统一管理
              if (selectionRectRef.current instanceof L.FeatureGroup) {
                selectionRectRef.current.addLayer(newRect)
              } else {
                const fg = L.featureGroup([selectionRectRef.current, newRect])
                fg.addTo(map)
                selectionRectRef.current = fg as any
              }
            } else {
              newRect.addTo(map)
              selectionRectRef.current = newRect
            }

            // 清除拖拽预览
            if (dragPreviewRectRef.current) {
              map.removeLayer(dragPreviewRectRef.current)
              dragPreviewRectRef.current = null
            }
          } else {
            // 清除拖拽预览（矩形太小，未完成选择）
            if (dragPreviewRectRef.current) {
              map.removeLayer(dragPreviewRectRef.current)
              dragPreviewRectRef.current = null
            }
            const tip = selectedIdsRef.current.size > 0
              ? `${t('map.featuresSelected', { count: selectedIdsRef.current.size })}，${t('map.copyTip') || '按 Ctrl+C 复制'}`
              : '点击选择要素，或按住鼠标拖拽绘制矩形批量选择'
            setSelectionTip(tip)
          }
        } else {
          // 未拖拽：执行点击点选
          selectFeaturesAtPoint(latLng, originalEvent.clientX, originalEvent.clientY, isMultiSelect)
        }

        selectionStartPointRef.current = null
        pointModeIsDragging.current = false
        // 恢复地图拖拽功能（点选/框选操作完成后）
        map.dragging.enable()
        // 阻止事件冒泡和默认行为，防止地图缩放等干扰
        L.DomEvent.stopPropagation(e)
        L.DomEvent.preventDefault(e)
      } else if (selectionModeRef.current === 'circle' && selectionDrawingRef.current && startPoint) {
        // 圆形模式：完成选择
        const radius = startPoint.distanceTo(latLng)
        const isMultiSelect = e.originalEvent.shiftKey
        if (radius > 10) { // 最小半径10米
          // 非多选模式（非Shift）：清除之前的形状
          if (!isMultiSelect && selectionShapeRef.current) {
            map.removeLayer(selectionShapeRef.current)
            selectionShapeRef.current = null
          }

          selectFeaturesInCircle(startPoint, radius, isMultiSelect)

          // 绘制最终圆形形状
          const L = window.L
          const newCircle = L.circle(startPoint, {
            radius: radius, color: '#00ffff', weight: 2, fillColor: '#00ffff', fillOpacity: 0.1,
            interactive: false // 禁止交互，避免拦截鼠标事件
          })

          if (isMultiSelect && selectionShapeRef.current) {
            // Shift多选：将新圆形与已有形状组合为FeatureGroup统一管理
            if (selectionShapeRef.current instanceof L.FeatureGroup) {
              selectionShapeRef.current.addLayer(newCircle)
            } else {
              const fg = L.featureGroup([selectionShapeRef.current, newCircle])
              fg.addTo(map)
              selectionShapeRef.current = fg as any
            }
          } else {
            selectionShapeRef.current = newCircle
            selectionShapeRef.current.addTo(map)
          }

          // 清除拖拽预览
          if (dragPreviewCircleRef.current) {
            map.removeLayer(dragPreviewCircleRef.current)
            dragPreviewCircleRef.current = null
          }
        } else {
          setSelectionTip('半径太小，请重新绘制')
          if (dragPreviewCircleRef.current) {
            map.removeLayer(dragPreviewCircleRef.current)
            dragPreviewCircleRef.current = null
          }
        }
          selectionDrawingRef.current = false
        selectionStartPointRef.current = null
        // 恢复地图拖拽功能（圆形选择操作完成后）
        map.dragging.enable()
      }
      L.DomEvent.stopPropagation(e)
    }

    // 处理双击
    const handleDoubleClick = (e: L.LeafletMouseEvent) => {
      if (selectionModeRef.current !== 'polygon') return
      
      // 双击会触发两次 mousedown，额外添加了 2 个顶点
      // 只弹出 1 个点，保留双击位置的顶点作为多边形的最后一个闭合顶点
      // 这样点击 A → 点击 B → 双击 C 即可完成三角形（3 个点）
      if (selectionPointsRef.current.length >= 1) {
        selectionPointsRef.current.pop()
      }

      if (selectionPointsRef.current.length >= 3) {
        const isMultiSelect = e.originalEvent.shiftKey
        
        // 非Shift模式下清除之前的形状；Shift模式下保留（多区域叠加）
        if (!isMultiSelect && selectionShapeRef.current) {
          map.removeLayer(selectionShapeRef.current)
          selectionShapeRef.current = null
        }
        
        clearPolygonTempLine()
        selectFeaturesInPolygon(selectionPointsRef.current, isMultiSelect)
        
        // 绘制最终多边形形状
        const L = window.L
        const newPolygon = L.polygon(selectionPointsRef.current, {
          color: '#00ffff', weight: 2, fillColor: '#00ffff', fillOpacity: 0.1,
          interactive: false // 禁止交互，避免拦截鼠标事件
        }).addTo(map)
        
        // Shift模式下：将新多边形添加到选择形状中（使用FeatureGroup管理多个形状）
        if (isMultiSelect && selectionShapeRef.current) {
          // 如果已有选择形状，创建FeatureGroup来管理多个形状
          if (selectionShapeRef.current instanceof L.FeatureGroup) {
            selectionShapeRef.current.addLayer(newPolygon)
          } else {
            const featureGroup = L.featureGroup([selectionShapeRef.current, newPolygon])
            featureGroup.addTo(map)
            selectionShapeRef.current = featureGroup as any
          }
        } else {
          selectionShapeRef.current = newPolygon
        }
        
        selectionPointsRef.current = []
        // 注意：不要在这里恢复地图拖拽，因为用户仍在多边形圈选模式下
        // 地图拖拽状态由 selectionMode 变化的 useEffect 控制
      } else {
        setSelectionTip('多边形至少需要3个点')
      }
      L.DomEvent.stopPropagation(e)
      L.DomEvent.preventDefault(e)
    }

    // 注册事件监听器
    map.on('mousedown', handleMouseDown)
    map.on('mousemove', handleMouseMove)
    map.on('mouseup', handleMouseUp)
    map.on('dblclick', handleDoubleClick)

    return () => {
      map.off('mousedown', handleMouseDown)
      map.off('mousemove', handleMouseMove)
      map.off('mouseup', handleMouseUp)
      map.off('dblclick', handleDoubleClick)
      // 清除未完成的绘制痕迹（临时线段、拖拽预览、多边形待定顶点等），但保留已完成的框选图形
      if (polygonTempLayerRef.current) {
        map.removeLayer(polygonTempLayerRef.current)
        polygonTempLayerRef.current = null
      }
      if (dragPreviewRectRef.current) {
        map.removeLayer(dragPreviewRectRef.current)
        dragPreviewRectRef.current = null
      }
      if (dragPreviewCircleRef.current) {
        map.removeLayer(dragPreviewCircleRef.current)
        dragPreviewCircleRef.current = null
      }
      selectionPointsRef.current = []
      selectionStartPointRef.current = null
      selectionDrawingRef.current = false
      pointModeIsDragging.current = false
      // 恢复地图拖拽（防止切换模式时遗留禁用状态）
      map.dragging.enable()
    }
  }, [selectionMode, selectFeaturesAtPoint, selectFeaturesInCircle, selectFeaturesInPolygon, selectFeaturesInRectangle])

  /**
   * 当地图类型改变时更新瓦片图层
   */
  useEffect(() => {
    // 当地图初始化完成后，更新瓦片图层
    if (!isMapInitialized || !mapInstanceRef.current || !window.L) return

    const L = window.L
    const map = mapInstanceRef.current

    // 共享实例复用保护：如果已有瓦片图层且类型与缓存一致，跳过重建
    // 避免页面切换时不必要的瓦片重新下载
    if (tileLayerRef.current && __sharedMapCache.map && __sharedMapCache.mapLayerType === mapLayerType) {
      console.log('[OnlineMap] 复用缓存瓦片图层，类型匹配，跳过重建')
      return
    }

    // 移除旧的瓦片图层
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current)
    }

    // 添加新的瓦片图层
    const getAMapTileUrl = (type: MapLayerType) => {
      if (type === 'satellite') {
        return `https://webst02.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}`
      } else {
        return `https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}`
      }
    }

    const newTileLayer = L.tileLayer(getAMapTileUrl(mapLayerType), {
      attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>',
      maxZoom: 18,
      minZoom: 3,
      crossOrigin: 'anonymous'  // 跨域标识，与 Canvas 配合防止渲染拖影
    }).addTo(map)

    // 监听所有瓦片加载完成事件（用于检测网络恢复）
    // 注意：404 错误是高德地图服务器的正常行为 - 某些瓦片（如海洋区域）不存在
    newTileLayer.on('load', () => {
      hasLoadedAnyTileRef.current = true
      hasNetworkErrorRef.current = false

      // 立即清除网络错误提示
      if (networkError.visible) {
        setNetworkError(prev => ({ ...prev, visible: false }))
      }
    })

    tileLayerRef.current = newTileLayer

    // 同步共享缓存中的 mapLayerType，使下次类型比较守卫正确判断
    __sharedMapCache.mapLayerType = mapLayerType
  }, [isMapInitialized, mapLayerType])

  // 地图点击事件已经在handleMapClick中处理，这里的useEffect是重复的，会导致事件被多次绑定
  // 移除重复的地图点击事件处理

  /**
   * 监听缩放变化，更新扇区图层和MapInfo图层
   */
  useEffect(() => {
    if (!mapInstanceRef.current) return

    const handleZoomEnd = () => {
      const zoom = mapInstanceRef.current!.getZoom()

      // 更新扇区图层的缩放级别
      if (lteSectorLayerRef.current) {
        lteSectorLayerRef.current.updateZoom(zoom)
      }
      if (nrSectorLayerRef.current) {
        nrSectorLayerRef.current.updateZoom(zoom)
      }

      // 更新所有MapInfo图层的缩放级别，确保标签配置生效
      mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
        mapInfoLayer.updateZoom(zoom)
      })

      // 更新地理化数据图层（扇区/多边形）的缩放级别
      if (geoDataLayerManagerRef.current) {
        geoDataLayerManagerRef.current.updateZoom(zoom)
      }
    }

    mapInstanceRef.current.on('zoomend', handleZoomEnd)

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.off('zoomend', handleZoomEnd)
      }
    }
  }, [])

  /**
   * 监听地图移动，更新地理化数据图层标签
   */
  useEffect(() => {
    if (!mapInstanceRef.current) return

    const handleMapMove = () => {
      console.log('[OnlineMap] 地图移动，更新地理化数据图层标签')

      // 更新地理化数据图层的标签（显示新进入视口的元素）
      if (geoDataLayerManagerRef.current) {
        geoDataLayerManagerRef.current.onMapMove()
      }
    }

    mapInstanceRef.current.on('moveend', handleMapMove)

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.off('moveend', handleMapMove)
      }
    }
  }, [])

  /**
   * 当layerFiles变化时加载MapInfo图层
   */
  useEffect(() => {
    (async () => {
      if (!mapInstanceRef.current) return;

      const allFiles = [...layerFiles, ...pointFiles];

      // 清理不再存在的图层
      const currentLayerIds = new Set(allFiles.map(f => f.id));
      for (const [id, { leafletLayer }] of mapInfoLayerRefsRef.current.entries()) {
        if (!currentLayerIds.has(id)) {
          if (mapInstanceRef.current.hasLayer(leafletLayer)) {
            mapInstanceRef.current.removeLayer(leafletLayer);
          }
          mapInfoLayerRefsRef.current.delete(id);
          loadedMapInfoLayersRef.current.delete(id);
        }
      }

      // 加载新图层（等待加载完成后再更新可见性）
      await loadMapInfoLayers();

      // 更新可见性
      console.log('[OnlineMap] 🔴🔴🔴 更新图层可见性, 总数:', allFiles.length)
      for (const layerFile of allFiles) {
        console.log('[OnlineMap] 🔴 处理图层:', layerFile.id, layerFile.name, 'visible:', layerFile.visible, 'geometryType:', layerFile.geometryType)
        console.log('[OnlineMap] 🔴 geometryType判断:', {
          isPoint: layerFile.geometryType === 'point',
          isSector: layerFile.geometryType === 'sector',
          isPolygon: layerFile.geometryType === 'polygon',
          willEnterGeoDataLayerBranch: layerFile.geometryType === 'point' || layerFile.geometryType === 'sector' || layerFile.geometryType === 'polygon'
        })

        // 处理 GeoDataLayer（点状、扇区或多边形类型）
        if (layerFile.geometryType === 'point' || layerFile.geometryType === 'sector' || layerFile.geometryType === 'polygon') {
          console.log('[OnlineMap] ========== 处理GeoDataLayer可见性 ==========')
          console.log('[OnlineMap] layerFile.id:', layerFile.id)
          console.log('[OnlineMap] layerFile.name:', layerFile.name)
          console.log('[OnlineMap] layerFile.visible:', layerFile.visible)
          console.log('[OnlineMap] geoDataLayerManagerRef.current 存在:', !!geoDataLayerManagerRef.current)
          console.log('[OnlineMap] mapInstanceRef.current 存在:', !!mapInstanceRef.current)

          if (geoDataLayerManagerRef.current && mapInstanceRef.current) {
            const geoLayer = geoDataLayerManagerRef.current.getLayer(layerFile.id)
            if (geoLayer) {
              geoLayer.setVisible(mapInstance, layerFile.visible)

              try {
                const result = geoLayer.setVisible(mapInstanceRef.current, layerFile.visible)
                console.log('[OnlineMap] ✅ geoLayer.setVisible 成功完成，返回值:', result)
              } catch (error) {
                console.error('[OnlineMap] ❌ geoLayer.setVisible 出错:', error)
                console.error('[OnlineMap] 错误堆栈:', error instanceof Error ? error.stack : 'No stack')
              }
            } else {
              console.log('[OnlineMap] ⚠️ GeoDataLayer不存在，需要先创建')
            }
          }
          console.log('[OnlineMap] ========================================')
          continue
        }

        // 处理 MapInfoLayer
        const layerRef = mapInfoLayerRefsRef.current.get(layerFile.id);
        console.log('[OnlineMap] 处理图层:', layerFile.id, layerFile.name, 'visible:', layerFile.visible, 'layerRef存在:', !!layerRef)

        if (layerRef && mapInstanceRef.current) {
          const hasLayer = mapInstanceRef.current.hasLayer(layerRef.leafletLayer)
          console.log('[OnlineMap]   - hasLayer检查结果:', hasLayer, 'leafletLayer存在:', !!layerRef.leafletLayer)

          if (layerFile.visible) {
            // 使用 MapInfoLayer 的 addTo 方法而不是直接添加 Leaflet 图层
            // 这样可以正确设置 currentMap 引用，使标签功能能够工作
            if (!hasLayer) {
              console.log('[OnlineMap]   - 添加图层到地图')
              layerRef.mapInfoLayer.addTo(mapInstanceRef.current)
            } else {
              console.log('[OnlineMap]   - 图层已在地图上，跳过')
            }
          } else {
            // 使用 MapInfoLayer 的 remove 方法而不是直接移除 Leaflet 图层
            // 这样可以正确清理标签和其他资源
            if (hasLayer) {
              console.log('[OnlineMap]   - 从地图移除图层')
              layerRef.mapInfoLayer.remove(mapInstanceRef.current)
            } else {
              console.log('[OnlineMap]   - 图层不在地图上，跳过移除')
            }
          }
        } else {
          console.log('[OnlineMap]   - 跳过: layerRef或mapInstance不存在')
        }
      }
    })();
  }, [layerFiles, pointFiles, loadMapInfoLayers]);

  /**
   * 当扇区数据变化时更新图层
   */
  useEffect(() => {
    if (mapInstanceRef.current && sectorData) {
      createSectorLayers()
    }
  }, [sectorData, createSectorLayers])

  /**
   * 当自定义图层变化时更新渲染
   */
  useEffect(() => {
    if (!mapInstanceRef.current || !window.L) return
    const map = mapInstanceRef.current
    const L = window.L

    // 清理已删除的图层
    const currentLayerIds = new Set(customLayers.map(l => l.id))
    Object.keys(customLayerRefs.current).forEach(id => {
      if (!currentLayerIds.has(id)) {
        map.removeLayer(customLayerRefs.current[id])
        delete customLayerRefs.current[id]
      }
    })

    // 创建或更新图层
    customLayers.forEach(layer => {
      // 如果已经有图层引用，更新可见性
      if (customLayerRefs.current[layer.id]) {
        const isVisible = customLayerVisibility[layer.id] ?? layer.visible
        if (isVisible) {
          if (!map.hasLayer(customLayerRefs.current[layer.id])) {
            map.addLayer(customLayerRefs.current[layer.id])
          }
        } else {
          map.removeLayer(customLayerRefs.current[layer.id])
        }
        return
      }

      // 创建新图层
      let leafletLayer: L.LayerGroup | L.FeatureGroup

      if (layer.type === 'point') {
        leafletLayer = L.layerGroup()
        layer.data.forEach((p: any) => {
          if (p.latitude && p.longitude) {
            // 与扇区数据处理方式一致：在前端进行坐标转换
            const [displayLat, displayLng] = CoordinateTransformer.wgs84ToGcj02(p.latitude || 0, p.longitude || 0)

            L.circleMarker([displayLat, displayLng], {
              radius: 5,
              fillColor: '#ef4444',
              color: '#fff',
              weight: 1,
              opacity: 1,
              fillOpacity: 0.8
            }).bindPopup(`<b>${p.name || '未命名点'}</b><br/>经度: ${p.longitude}<br/>纬度: ${p.latitude}`)
              .addTo(leafletLayer)
          }
        })
      } else {
        // 对于线和面图层，如果是来自MapInfo的数据，MapInfoLayerManager会自动处理
        // 这里如果是通过"导入图层"添加的，我们可以创建一个FeatureGroup
        leafletLayer = L.featureGroup()
      }

      customLayerRefs.current[layer.id] = leafletLayer

      const isVisible = customLayerVisibility[layer.id] ?? layer.visible
      if (isVisible) {
        leafletLayer.addTo(map)
      }
    })
  }, [customLayers, customLayerVisibility])

  /**
   * 装饰图层管理 - 包含打点标记和定位标记
   */
  useEffect(() => {
    if (!mapInstanceRef.current) return
    const map = mapInstanceRef.current
    const L = window.L

    // 创建或获取装饰图层
    if (!decorationLayerRef.current) {
      decorationLayerRef.current = L.layerGroup()
      console.log('[OnlineMap] 创建装饰图层')

      // 将已有的打点标记添加到装饰图层
      captureMarkersRef.current.forEach(marker => {
        if (!decorationLayerRef.current?.hasLayer(marker)) {
          marker.addTo(decorationLayerRef.current!)
        }
      })

      // 将已有的定位标记添加到装饰图层
      locationMarkersRef.current.forEach(marker => {
        if (!decorationLayerRef.current?.hasLayer(marker)) {
          marker.addTo(decorationLayerRef.current!)
        }
      })
    }

    // 根据可见性控制图层
    if (decorationLayerVisibility) {
      if (!map.hasLayer(decorationLayerRef.current)) {
        decorationLayerRef.current.addTo(map)
        console.log('[OnlineMap] 显示装饰图层')
      }
    } else {
      if (map.hasLayer(decorationLayerRef.current)) {
        map.removeLayer(decorationLayerRef.current)
        console.log('[OnlineMap] 隐藏装饰图层')
      }
    }
  }, [decorationLayerVisibility])

  /**
   * 当图层可见性变化时更新
   */
  useEffect(() => {
    if (!mapInstanceRef.current) return

    if (lteSectorLayerRef.current) {
      if (layerVisibility.lte) {
        lteSectorLayerRef.current.addTo(mapInstanceRef.current)
      } else {
        mapInstanceRef.current.removeLayer(lteSectorLayerRef.current)
      }
    }

    if (nrSectorLayerRef.current) {
      if (layerVisibility.nr) {
        nrSectorLayerRef.current.addTo(mapInstanceRef.current)
      } else {
        mapInstanceRef.current.removeLayer(nrSectorLayerRef.current)
      }
    }
  }, [layerVisibility])


  /**
   * 当扇区标签可见性变化时更新图层
   */
  useEffect(() => {
    if (mapInstanceRef.current && sectorData) {
      console.log('[OnlineMap] 扇区标签可见性变化，重新创建扇区图层:', labelVisibility)
      createSectorLayers()
    }
  }, [labelVisibility])

  /**
   * 当点文件标签可见性变化时更新标签标记
   */
  useEffect(() => {
    if (!mapInstanceRef.current || !window.L) return

    const map = mapInstanceRef.current
    const L = window.L

    // 清理所有现有的点文件标签标记
    for (const [_, markers] of pointFileLabelMarkersRef.current.entries()) {
      for (const marker of markers) {
        map.removeLayer(marker)
      }
    }
    pointFileLabelMarkersRef.current.clear()

    // 遍历所有点文件，为启用标签的文件创建标记
    for (const [fileId, pointData] of pointFileDataRef.current.entries()) {
      const shouldShowLabels = pointFileLabelVisibility[fileId] === true

      if (shouldShowLabels && pointData && pointData.length > 0) {
        // 获取用户配置的标签设置
        const labelConfig = labelSettingsMap?.[fileId]

        // 如果没有配置标签内容，跳过（不显示默认标签）
        if (!labelConfig || !labelConfig.content) {
          console.log('[OnlineMap] 点文件未配置标签内容，跳过:', fileId)
          continue
        }

        const markers: L.Marker[] = []

        for (const point of pointData) {
          if (!point.longitude || !point.latitude) continue

          // 与扇区数据处理方式一致：在前端进行坐标转换
          const [displayLat, displayLng] = CoordinateTransformer.wgs84ToGcj02(point.latitude || 0, point.longitude || 0)
          const gcjLat = displayLat
          const gcjLng = displayLng

          // 获取标签字段值
          const attributes = point.attributes || {}
          let labelText = ''

          // 按优先级查找配置的字段值
          const targetField = labelConfig.content

          // 依次检查: point 对象的直接属性 -> attributes 对象
          if (point[targetField] !== undefined && point[targetField] !== null) {
            labelText = String(point[targetField]).trim()
          } else if (attributes[targetField] !== undefined && attributes[targetField] !== null) {
            labelText = String(attributes[targetField]).trim()
          }

          // 如果没有找到字段值，跳过此点
          if (!labelText) continue

          // 使用用户配置的颜色和字体大小
          const labelHtml = `
            <div style="
              background: transparent;
              padding: 0;
              font-size: ${labelConfig.fontSize || 12}px;
              color: ${labelConfig.color || '#000000'};
              white-space: nowrap;
              text-shadow: 0 1px 2px rgba(0,0,0,0.5);
              font-weight: 500;
            ">
              ${labelText}
            </div>
          `

          // 动态计算图标大小基于文本长度和字体大小
          const estimatedWidth = Math.min(200, Math.max(60, labelText.length * (labelConfig.fontSize || 12) * 0.6))
          const estimatedHeight = (labelConfig.fontSize || 12) + 8

          const icon = L.divIcon({
            html: labelHtml,
            className: 'point-file-label',
            iconSize: [estimatedWidth, estimatedHeight],
            iconAnchor: [estimatedWidth / 2, estimatedHeight / 2]
          })

          const marker = L.marker([gcjLat, gcjLng], { icon })
          marker.addTo(map)
          markers.push(marker)
        }

        pointFileLabelMarkersRef.current.set(fileId, markers)
        console.log('[OnlineMap] Point file labels added:', fileId, markers.length, 'config:', labelConfig)
      }
    }
  }, [pointFileLabelVisibility, pointFiles, labelSettingsMap])

  return (
    <>
      {/* 网络状态提示 - 仅在有错误时显示 */}
      <NetworkStatusAlert
        visible={networkError.visible}
        message={networkError.message}
        onRetry={networkError.canRetry ? retryInitMap : undefined}
        onDismiss={() => setNetworkError({ ...networkError, visible: false })}
      />

      {/* 扇区属性信息面板 - 渲染在地图容器之外，避免受地图事件影响 */}
      <SectorInfoPanel
        sector={selectedSector}
        visible={panelVisible}
        onClose={hideSectorInfo}
        position={clickPosition}
        onMouseEnter={onPanelMouseEnter}
        onMouseLeave={onPanelMouseLeave}
      />

      {/* 地图容器 */}
      <div
        ref={mapRef}
        style={{
          height: '100%',
          width: '100%',
          backgroundColor: baseMapVisible ? 'transparent' : '#ffffff'  // 底图隐藏时显示白色背景
        }}
        className="relative"
      >
        {/* 加载提示 */}
        {loading && (
          <div className="absolute top-4 left-4 z-[1000] bg-white/90 backdrop-blur px-4 py-2 rounded-lg shadow flex items-center gap-2">
            <Loader2 className="animate-spin" size={16} />
            <span className="text-sm">加载地图中...</span>
          </div>
        )}

        {/* 框选提示 */}
        {selectionTip && selectionMode !== 'none' && (
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-[1000] bg-blue-600/95 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2">
            <span className="text-sm font-medium">{selectionTip}</span>
          </div>
        )}
      </div>

      {/* 重叠扇区选择菜单 */}
      {overlappingSectors.length > 0 && overlapPosition && (
        <OverlappingSectorsMenu
          sectors={overlappingSectors}
          position={overlapPosition}
          onSelect={(sector) => {
            showSectorInfo(sector, {
              originalEvent: {
                clientX: overlapPosition.x,
                clientY: overlapPosition.y
              }
            } as any)
            setOverlappingSectors([])
            setOverlapPosition(null)
          }}
          onClose={() => {
            setOverlappingSectors([])
            setOverlapPosition(null)
          }}
        />
      )}

      {/* TAC 频段图例已移除 - 各个页面自己管理对应的图例组件 */}

      {/* 要素属性面板 (MapInfo/地理化数据) */}
      <FeatureInfoPanel
        title={featureTitle}
        properties={featureProperties}
        visible={featurePanelVisible}
        position={featureClickPosition}
        onClose={hideFeatureInfo}
      />
    </>
  )
})

/**
 * 重叠扇区选择菜单组件
 */
function OverlappingSectorsMenu({ sectors, position, onSelect, onClose }: {
  sectors: RenderSectorData[],
  position: { x: number, y: number },
  onSelect: (sector: RenderSectorData) => void,
  onClose: () => void
}) {
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 5 秒自动关闭
  const startAutoClose = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      onClose()
      timerRef.current = null
    }, 5000)
  }, [onClose])

  useEffect(() => {
    startAutoClose()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [startAutoClose])

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside, true)
    return () => document.removeEventListener('mousedown', handleClickOutside, true)
  }, [onClose])

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: position.x + 10,
        top: position.y,
        backgroundColor: 'white',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        borderRadius: '8px',
        padding: '8px 0',
        zIndex: 11000,
        minWidth: '180px',
        border: '1px solid #e2e8f0',
        fontFamily: 'sans-serif'
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={() => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }}
      onMouseLeave={startAutoClose}
    >
      <div style={{ position: 'relative', padding: '6px 32px 10px 12px', fontSize: '12px', color: '#64748b', borderBottom: '1px solid #f1f5f9', marginBottom: '4px' }}>
        检测到 {sectors.length} 个重叠扇区:
        {/* 关闭按钮 */}
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
          style={{
            position: 'absolute', top: '2px', right: '6px',
            width: '20px', height: '20px', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            border: 'none', background: 'transparent',
            cursor: 'pointer', borderRadius: '4px',
            color: '#999', fontSize: '14px', lineHeight: '1', padding: 0, zIndex: 1
          }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.background = '#f3f4f6'; (e.target as HTMLElement).style.color = '#374151' }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; (e.target as HTMLElement).style.color = '#999' }}
          title="关闭"
        >✕</button>
      </div>
      <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
        {sectors.map(sector => (
          <div
            key={sector.id}
            style={{
              padding: '10px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              transition: 'background-color 0.2s'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f8fafc')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            onClick={() => onSelect(sector)}
          >
            <div style={{
              width: '10px',
              height: '10px',
              borderRadius: '2px',
              backgroundColor: sector.frequency ? frequencyColorMapper.getColor(sector.frequency, sector.networkType).color || '#ccc' : '#ccc',
              border: '1px solid rgba(0,0,0,0.1)'
            }} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontWeight: 500 }}>{sector.id}</span>
              <span style={{ fontSize: '11px', color: '#94a3b8' }}>{sector.name} | {sector.networkType} | PCI: {sector.pci}</span>
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          padding: '8px 12px',
          borderTop: '1px solid #f1f5f9',
          marginTop: '4px',
          fontSize: '12px',
          color: '#64748b',
          cursor: 'pointer',
          textAlign: 'center',
          fontWeight: 500
        }}
        onClick={onClose}
      >
        取消
      </div>
    </div>
  )
}

OnlineMap.displayName = 'OnlineMap'
