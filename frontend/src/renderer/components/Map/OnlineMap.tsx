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
import { Loader2, FileSpreadsheet, Copy as CopyIcon, Trash2 } from 'lucide-react'
import * as XLSX from 'xlsx'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { NetworkStatusAlert } from './NetworkStatusIndicator'
import { frequencyColorMapper } from '../../utils/frequencyColors'
import { mapDataService, RenderSectorData } from '../../services/mapDataService'
import { CoordinateTransformer } from '../../utils/coordinate'
import { extractFeatureId } from '../../utils/featureId'
import { SectorInfoPanel, useSectorInfoPanel } from './SectorInfoPanel'
import { FeatureInfoPanel, useFeatureInfoPanel } from './FeatureInfoPanel'
import { clampPopupPosition, type MapViewportBounds } from './popupPosition'
import { MapInfoLayerManager, MapInfoLayer, MapInfoLayerOptions, LayerGeometryType } from './MapInfoLayer'
import { GeoDataLayerManager, GeoDataLayer, GeoDataItem } from './GeoDataLayer'
import type { ThematicSettings, HeatmapSettings } from './LabelSettingsModal'
import { HeatmapLayerManager, type HeatmapStats } from './HeatmapLayerManager'
import { reconcileZOrder, ZOrderLayer, orderWithIds, panelRankFromIndex, isLayerSelectable } from './layerZOrder'
import type { LayerOrderMap } from '../../store/mapStore'
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
  labelManager: LabelLayoutManager | null  // 共享标签布局引擎（跨图层标签防重叠）
}
let __sharedMapCache: SharedMapCache = {
  map: null, tileLayer: null, leafletContainer: null, mapLayerType: 'roadmap', labelManager: null
}
let __sharedHiddenContainer: HTMLDivElement | null = null
// 模块级共享 ref —— 地图缓存后，事件监听器闭包仍引用旧组件的 useRef 对象
// 使用模块级对象确保所有组件实例读写同一个 ref，解决跨实例闭包问题
const __sharedCaptureModeRef: { current: boolean } = { current: false }
const __sharedMeasureModeRef: { current: boolean } = { current: false }
const __sharedMeasurePointsRef: { current: Array<{ lng: number; lat: number }> } = { current: [] }
const __sharedFinishMeasurementRef: { current: (() => void) | null } = { current: null }
const __sharedHandleMapClickRef: { current: ((event: any) => void) | null } = { current: null }
// 测量预览虚线/标签：mousemove 监听器在地图首次创建时内联绑定（闭包冻结在首次组件实例），
// 若用组件 useRef，跨页面缓存复用后新实例的 ref 为 null，ESC/切菜单/卸载时清不到旧闭包创建的预览图层，故提升为模块级共享
const __sharedShadowLineRef: { current: any } = { current: null }
const __sharedShadowLabelRef: { current: any } = { current: null }
// 模块级：跨页面共享，跟踪已创建的数据图层实例（MapInfoLayer / GeoDataLayer）
// 用途：页面切换卸载清理意外失败时，重新挂载时从缓存地图上强制移除残留图层，避免"取消勾选后扇区不消失/叠加"
const __mapDataLayerInstances: Set<{ remove: (map: any) => any }> = new Set()
// =====================================

import { mapStateService } from '../../services/mapStateService'
import { SectorSVGLayer, PCIHighlightConfig, TACHighlightConfig, NeighborHighlightConfig, SectorLabelConfig } from './SectorRendererSVG'
import { LabelLayoutManager } from './LabelLayoutManager'
import { pciDataSyncService } from '../../services/pciDataSyncService'
import { neighborDataSyncService } from '../../services/neighborDataSyncService'
import { tacDataSyncService } from '../../services/tacDataSyncService'
import { useMapDataCacheStore } from '../../store/mapDataCacheStore'
import { useMapStore } from '../../store/mapStore'
import { useLayerEditStore } from '../../store/layerEditStore'
import type { AttributeErrorCode } from '../../store/layerEditStore'
import { LayerEditSession, type MergeReferenceSource } from './LayerEditSession'
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
  type: 'point' | 'line' | 'polygon' | 'sector' | 'mixed'
  visible: boolean
  dataId: string
  sourceType?: 'mapinfo' | 'excel'
  geometryType?: 'point' | 'sector' | 'polygon'
  editable?: boolean
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
  /** 装饰图层标签可见性 */
  decorationLabelVisible?: boolean
  /** 打点功能被阻止时的回调（装饰图层未勾选） */
  onCaptureBlocked?: () => void
  /**
   * 各类别内部图层面板顺序（控制面板拖拽排序），索引 0 = 最上。
   * 跨类别层级固定：基站 > 图层文件 > 地理化数据 > 装饰图层。
   */
  layerOrder?: LayerOrderMap
  /** 图层"可选"开关（控制面板鼠标箭头按钮），key=图层 id；未收录视为 true */
  selectableMap?: Record<string, boolean>
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
 * 圈选/选择的目标图层（z-order 最高且"可选"开关打开的唯一图层）
 * - sector：基站扇区（LTE 或 NR）
 * - mapinfo：图层文件（MapInfo），layerId = MapInfoLayer id
 * - geodata：地理化数据（Excel 点/扇区/面），layerId = GeoDataLayer id
 * - decoration：装饰图层（打点/定位标记）
 */
type SelectionTarget =
  | { kind: 'sector'; networkType: 'lte' | 'nr' }
  | { kind: 'mapinfo'; layerId: string }
  | { kind: 'geodata'; layerId: string }
  | { kind: 'decoration' }

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
  /** 保存后刷新图层数据（丢弃前端 GeoJSON 缓存并重建原始图层实例；编辑态下保持隐藏） */
  /** 保存后刷新图层数据：传入最新 GeoJSON 时直接用内存数据重建（免重新下载整层）；不传则重新拉取 */
  refreshLayerData: (layerId: string, fresh?: { data?: any; version?: string | null }) => Promise<void>
  /** 设置地图类型 */
  setMapType: (type: 'roadmap' | 'satellite') => void
  /** 设置点文件标签可见性并更新设置 (MapPage用) */
  setLayerFileLabelVisibility: (fileId: string, visible: boolean, settings: any) => void
  /** 设置图层颜色（图形颜色/透明度/边框宽度/边框颜色） */
  setLayerColorSettings: (fileId: string, settings: { fillColor: string; fillOpacity: number; borderWidth: number; borderColor: string; pointSize?: number }, geometryType?: string) => void
  /** 设置扇区默认设置（图形透明度/边框宽度；null 恢复默认，仅默认频点配色模式生效） */
  setSectorColorSettings: (layerId: string, settings: { fillOpacity: number; borderWidth: number } | null) => void
  /** 刷新扇区图层颜色（频点自定义配色变化后调用） */
  refreshSectorColors: () => void
  /** 设置专题图层（按属性字段分段配色；null 关闭专题恢复基础配置） */
  setLayerThematicSettings: (fileId: string, settings: ThematicSettings | null) => void
  /** 设置扇区专题图层（与图层文件一致；null 关闭专题回退频点配色） */
  setSectorThematicSettings: (layerId: string, settings: ThematicSettings | null) => void
  /** 设置数据图层热力图（null/disabled 关闭；替换模式下自动隐藏原图形与标签） */
  setLayerHeatmapSettings: (fileId: string, settings: HeatmapSettings | null) => void
  /** 设置扇区图层热力图（null 关闭） */
  setSectorHeatmapSettings: (layerId: string, settings: HeatmapSettings | null) => void
  /** 获取热力图图例统计（min/max/count/sampled） */
  getHeatmapStats: (layerId: string) => HeatmapStats | null
  /** 重放全部已保存热力设置（跨页面缓存复用/异步图层兜底） */
  replayHeatmapSettings: () => void
  /** 获取扇区专题区间统计（图例展示用） */
  getSectorThematicStats: (layerId: string) => { counts: number[]; total: number; other: number } | null
  /** 聚焦图层：居中并最大化显示该图层全部要素（图层预览） */
  focusLayer: (fileId: string) => void
  /** 获取专题区间统计（每个区间的要素数与总数，图例展示用） */
  getLayerThematicStats: (fileId: string) => { counts: number[]; total: number; other: number } | null
  /** 设置地图类型切换 */
  toggleMapType: () => void
  /** 设置频点可见性 */
  setFrequencyVisibility: (networkType: 'LTE' | 'NR', frequency: number, visible: boolean) => void
  /** 设置自定义图层可见性 */
  setCustomLayerVisibility: (layerId: string, visible: boolean) => void
  /** 设置装饰图层可见性 */
  setDecorationLayerVisibility: (visible: boolean) => void
  /** 设置装饰图层标签可见性 */
  setDecorationLabelVisibility: (visible: boolean) => void
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
  /** 设置图层文件标签配置 */
  setLayerFileLabelSettings: (fileId: string, settings: any) => void
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
  /** 搜索定位：等待图层可见后红色边框高亮指定要素并飞行定位（图层文件/地理化数据） */
  locateLayerFeature: (opts: {
    layerId: string
    featureId: string
    /** 点/扇区要素目标中心（GCJ02 渲染坐标） */
    center?: [number, number]
    /** 线/面要素包围盒 [[南,西],[北,东]]（GCJ02 渲染坐标），优先于 center */
    bounds?: [[number, number], [number, number]]
  }) => Promise<boolean>
  /** 清除搜索定位的要素红色边框高亮（数据图层） */
  clearLayerFeatureHighlight: () => void
  /** 工参搜索定位：红色边框高亮目标扇区图形本身并飞行定位（LTE/NR，替代中心标记点） */
  locateSector: (opts: { id: string; lat: number; lng: number; zoom?: number }) => void
  /** 清除扇区红色边框高亮（工参搜索定位） */
  clearSectorHighlight: () => void
  /** 获取撒点文件数据 */
  getPointFileData: () => Record<string, any[]>
  /** 设置扇区标签配置 */
  setSectorLabelSettings: (settings: any, layerId: string) => void
  /** 清除所有抓取坐标标记 */
  clearCaptureMarkers: () => void
  /** 清除编辑态圈选选中高亮与计数（不改变任何工具激活状态） */
  clearShapeSelection: () => void
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
  decorationLayerVisible = true,
  decorationLabelVisible,
  layerOrder,
  selectableMap = {},
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
  // 测量预览虚线/标签使用模块级 __sharedShadowLineRef / __sharedShadowLabelRef（见文件顶部说明）
  const measurementFinishTimeRef = useRef<number>(0) // 结束测量时间戳防抖（右键结束后 500ms 内重复触发忽略）

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
  const snapIndicatorRef = useRef<L.CircleMarker | null>(null) // 多边形起点吸附指示器
  const dragPreviewRectRef = useRef<L.Rectangle | null>(null) // 矩形拖拽预览（独立于已保存的矩形轨迹）
  const dragPreviewCircleRef = useRef<L.Circle | null>(null) // 圆形拖拽预览（独立于已保存的圆形轨迹）
  const [selectionTip, setSelectionTip] = useState<string>('') // 框选提示信息
  // 编辑态圈选命中的要素数（底部提示条"删除"按钮的显隐与删除数量）
  const [shapeSelectedCount, setShapeSelectedCount] = useState(0)
  const [selectedFeatureCount, setSelectedFeatureCount] = useState(0) // 当前选中要素数（控制导出按钮）
  const preserveSelectionRef = useRef<boolean>(false) // 同步跟踪保留状态，避免 state 异步更新问题
  const [customLayerVisibility, setCustomLayerVisibilityState] = useState<Record<string, boolean>>({})
  const [decorationLayerVisibility, setDecorationLayerVisibility] = useState<boolean>(decorationLayerVisible)
  const decorationLayerRef = useRef<L.LayerGroup | null>(null) // 装饰图层引用
  const decorationLabelVisibleRef = useRef<boolean>(decorationLabelVisible ?? false)

  // 标记点自定义标签存储
  const markerLabelsRef = useRef<Map<string, MarkerLabelData>>(new Map())
  const markerLabelElementsRef = useRef<Map<string, L.Marker>>(new Map())

  // i18n translation
  const { t } = useTranslation()

  // 图层编辑态/绘制工具/"选择"工具（响应式订阅，供可见性与双击缩放互斥判断）
  const editableLayerId = useLayerEditStore((s) => s.editableLayerId)
  const editDrawTool = useLayerEditStore((s) => s.drawTool)
  const editSelectMode = useLayerEditStore((s) => s.selectMode)

  // 选择/拖拽规则（事件回调内读取最新值用 ref）：
  // - 要素选中（点击查属性/信息面板）需"可选"开关打开且激活"选择"工具
  //   （可选开关 ref 复用下方已有的 selectableMapRef）
  // - 地图拖动仅"手形"工具激活时可用（默认态/其他工具态点击不拖动地图）
  const selectModeRef = useRef(editSelectMode)
  const modeRef = useRef(mode)
  const mapDragToolRef = useRef(mapDragTool)
  useEffect(() => { selectModeRef.current = editSelectMode }, [editSelectMode])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { mapDragToolRef.current = mapDragTool }, [mapDragTool])

  // 同步Ref
  useEffect(() => { measureModeRef.current = measureMode }, [measureMode])
  useEffect(() => { selectionModeRef.current = selectionMode }, [selectionMode])
  useEffect(() => { captureModeRef.current = captureMode }, [captureMode])

  // ===== 图层编辑会话（新建 TAB / 绘制点线面 / 顶点编辑）=====
  const editSessionRef = useRef<LayerEditSession | null>(null)

  // 会话挂在地图实例上（地图跨页面缓存复用，避免重复绑定监听）
  const getEditSession = useCallback((): LayerEditSession | null => {
    const map = mapInstanceRef.current
    if (!map) return null
    let session = (map as any).__nptEditSession as LayerEditSession | undefined
    if (!session) {
      session = new LayerEditSession(map)
      ;(map as any).__nptEditSession = session
      editSessionRef.current = session
    }
    // 会话随共享地图跨页面挂载复用，provider 闭包必须重新绑定当前实例的 refs ——
    // 否则持有已卸载实例的 refs（.current 为空），非编辑图层的捕获节点来源为空
    //（表现为"只有打开编辑开关的图层才能捕获"）。
    if ((session as any).__snapProviderFor !== mapInfoLayerRefsRef) {
      session.setSnapSourceProvider(() => {
        const editableId = useLayerEditStore.getState().editableLayerId
        const selectable = selectableMapRef.current
        const out: L.Layer[] = []
        // 图层文件（MapInfo）：可见 + "可选"开关打开
        mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer, leafletLayer }: any) => {
          const id = (mapInfoLayer as any).id
          if (!id || id === editableId) return
          if (typeof mapInfoLayer.isVisible === 'function' && !mapInfoLayer.isVisible()) return
          if (!isLayerSelectable(selectable, id)) return
          if (leafletLayer) out.push(leafletLayer)
        })
        // 地理化数据（GeoData）：可见 + "可选"开关打开
        const geoLayers = geoDataLayerManagerRef.current?.getAllLayers?.() ?? []
        for (const gl of geoLayers) {
          try {
            if (typeof gl.isVisible === 'function' && !gl.isVisible()) continue
            if (!isLayerSelectable(selectable, gl.getId())) continue
            const leaf = typeof (gl as any).getLeafletLayer === 'function' ? (gl as any).getLeafletLayer() : null
            if (leaf) out.push(leaf as L.Layer)
          } catch { /* ignore */ }
        }
        return out
      })
      ;(session as any).__snapProviderFor = mapInfoLayerRefsRef
    }
    return session
  }, [])

  // 加载某图层工作集（无则从缓存/接口拉取已转 GCJ02 的 GeoJSON 后 beginEdit）
  const ensureWorkspace = useCallback(async (layerId: string) => {
    const store = useLayerEditStore.getState()
    if (store.getWorkspace(layerId)) return
    const lf = layerFiles.find((f) => f.id === layerId)
    if (!lf || lf.sourceType !== 'mapinfo') return
    // mixed=混合图层（可同时含点/线/面）；point/line/polygon=单一几何
    const geomType =
      lf.type === 'point' || lf.type === 'line' || lf.type === 'polygon' || lf.type === 'mixed'
        ? lf.type
        : null
    if (!geomType) return
    const cachedLayer = useMapDataCacheStore.getState().layers[layerId]
    let geojson: any = cachedLayer?.geojson
    let version: string | null = cachedLayer?.version ?? null
    if (!geojson) {
      try {
        const { data, version: v } = await layerApi.getLayerDataWithVersion(lf.dataId, layerId)
        geojson = data
        version = v
        if (geojson) useMapDataCacheStore.getState().cacheLayerGeoJSON(layerId, geojson, v)
      } catch (e) {
        console.error('[EditSession] 加载图层数据失败', e)
        return
      }
    }
    const features = (geojson?.features || []).map((f: any) => ({ ...f }))
    // 捕获图层原配色（defaultStyle + 用户颜色设置），供编辑副本上的原要素沿用。
    // 未配置的键保持 undefined（不发明颜色），编辑会话据此回退到要素自带 _style /
    // 渲染层默认值，保证打开编辑开关前后图形配色不变。
    const cs = useMapStore.getState().mapSettings.colorSettingsMap?.[layerId] as any
    const ds = (lf as any).defaultStyle as any || {}
    const baseStyle = {
      point: {
        markerColor: cs?.fillColor ?? ds.markerColor,
        markerSize: ds.markerSize,
        borderColor: cs?.borderColor,
      },
      line: {
        // 线色与 setStyleOverrides 约定一致：用户边框色（有效时）优先，其次图形颜色
        color: cs?.borderColor ?? cs?.fillColor ?? ds.strokeColor ?? ds.color,
        weight: cs?.borderWidth ?? ds.strokeWidth,
        opacity: ds.opacity,
        dashArray: ds.strokeDasharray,
      },
      polygon: {
        fillColor: cs?.fillColor ?? ds.fillColor ?? ds.strokeColor,
        fillOpacity: cs?.fillOpacity ?? ds.fillOpacity,
        borderColor: cs?.borderColor ?? ds.strokeColor,
        borderWidth: cs?.borderWidth ?? ds.strokeWidth,
      },
    }
    useLayerEditStore.getState().beginEdit(
      layerId,
      lf.dataId,
      geomType as 'point' | 'line' | 'polygon' | 'mixed',
      features,
      baseStyle,
      // 版本指纹（ETag）随数据来源一起传递：增量保存据此校验基底，未知则整层保存
      { version },
    )
  }, [layerFiles])

  // 订阅编辑 store：可编辑图层 / 绘制工具 / 样式 变化时同步到会话
  useEffect(() => {
    const unsubEdit = useLayerEditStore.subscribe((state: any, prev: any) => {
      const session = getEditSession()
      if (!session) return
      if (state.editableLayerId !== prev.editableLayerId) {
        const id = state.editableLayerId
        if (!id) {
          session.clear()
        } else {
          void ensureWorkspace(id).then(() => {
            const ws = useLayerEditStore.getState().getWorkspace(id)
            if (ws) session.setWorkspace(id)
          })
        }
      }
      if (state.drawTool !== prev.drawTool) {
        if (state.drawTool === 'none') session.stopDraw()
        else session.startDraw(state.drawTool)
      }
      if (state.selectMode !== prev.selectMode) session.setSelectMode(state.selectMode)
      // 当前编辑层工作集要素变化（增删改/撤销/样式）→ 重建编辑层
      const active = state.editableLayerId
      if (active) {
        const ws = state.workspaces?.[active]
        const prevWs = prev.workspaces?.[active]
        if (ws && ws !== prevWs) {
          session.setWorkspace(active)
          // 编辑态标签：工作集变化（增删/拖动/撤销）→ 标签候选同步重建
          const ref = mapInfoLayerRefsRef.current.get(active)
          const file = layerFilesMirrorRef.current.find((f) => f.id === active)
          if (ref && file?.visible) {
            ref.mapInfoLayer.setEditLabelSource(ws.features)
          }
        }
      }
    })
    const unsubStyle = useMapStore.subscribe((state: any, prev: any) => {
      if (state.mapSettings?.drawStyleMap !== prev.mapSettings?.drawStyleMap) {
        getEditSession()?.refreshStyle()
      }
    })
    return () => { unsubEdit(); unsubStyle() }
  }, [getEditSession, ensureWorkspace])

  // 编辑键盘：Esc 取消绘制 / Backspace 删末点 / Delete 删选中；S 切换节点捕获（不依赖编辑开关）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const session = (mapInstanceRef.current as any)?.__nptEditSession as LayerEditSession | undefined
      if (!session) return
      // 键盘 Delete/Backspace 可能触发圈选批量删除，先记下删除前的选中数（供下方同步提示条）
      const shapeSelBefore = session.isEditing() ? session.getShapeSelectedCount() : 0
      if (session.isEditing() && session.handleKey(e)) {
        e.preventDefault()
        // 键盘删除了圈选选中要素 → 与底部"删除"按钮行为同步：
        // "删除"按钮消失、复制/导出数据源复位、提示删除结果
        if ((e.key === 'Delete' || e.key === 'Backspace') && shapeSelBefore > 0) {
          const after = session.getShapeSelectedCount()
          if (after < shapeSelBefore) {
            setShapeSelectedCount(after)
            selectedFeaturesRef.current = []
            setSelectedFeatureCount(0)
            const n = shapeSelBefore - after
            setSelectionTip(t('map.shapeDeleted', { count: n }) || `已删除 ${n} 个圈选要素（Ctrl+Z 可撤销）`)
          }
        }
        return
      }
      // S 键：切换自动捕获节点（英文输入法、无组合键、非输入框聚焦时生效）
      if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const t2 = e.target as HTMLElement | null
        if (t2 && (t2.tagName === 'INPUT' || t2.tagName === 'TEXTAREA' || t2.isContentEditable)) return
        session.toggleSnapEnabled()
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [t])

  // 编辑图层可见性联动：勾选/去勾选与地图显示同步（不受"编辑"开关影响）。
  // 去勾选 → 清除编辑会话渲染（工作集保留在 store，未保存更改不丢）；
  // 重新勾选 → 恢复编辑会话渲染。此前编辑会话层不受 visible 控制，
  // 表现为"编辑保存后在控制面板关闭图层无效"。
  const prevEditLayerVisibleRef = useRef<boolean | null>(null)
  useEffect(() => {
    const f = editableLayerId ? layerFiles.find((x) => x.id === editableLayerId) : undefined
    const visible = editableLayerId ? !!f?.visible : null
    const prev = prevEditLayerVisibleRef.current
    prevEditLayerVisibleRef.current = visible
    if (!editableLayerId || prev === null || prev === visible) return
    const session = getEditSession()
    if (!session) return
    if (!visible) {
      session.clear()
    } else if (useLayerEditStore.getState().getWorkspace(editableLayerId)) {
      session.setWorkspace(editableLayerId)
    }
  }, [layerFiles, editableLayerId, getEditSession])
  useEffect(() => { setDecorationLayerVisibility(decorationLayerVisible) }, [decorationLayerVisible])
  useEffect(() => {
    decorationLabelVisibleRef.current = decorationLabelVisible ?? false
  }, [decorationLabelVisible])

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
  // 工参搜索定位的扇区红框高亮（createSectorLayers 重建渲染器后新实例会丢失高亮，需据此恢复）
  const searchSectorHighlightRef = useRef<Set<string> | null>(null)
  const labelLayoutManagerRef = useRef<LabelLayoutManager | null>(null)

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

  // 热力图层管理器（按字段值插值的值热力面），随缓存地图生命周期存在
  const heatmapManagerRef = useRef<HeatmapLayerManager | null>(null)
  const getHeatmapManager = (): HeatmapLayerManager => {
    if (!heatmapManagerRef.current) heatmapManagerRef.current = new HeatmapLayerManager()
    return heatmapManagerRef.current
  }
  // 图层 props 镜像：命令式热力方法（handle 闭包固定）读取最新勾选可见性
  const layerFilesMirrorRef = useRef(layerFiles)
  layerFilesMirrorRef.current = layerFiles
  const pointFilesMirrorRef = useRef(pointFiles)
  pointFilesMirrorRef.current = pointFiles

  // 点文件数据存储（用于属性标签渲染）
  const pointFileDataRef = useRef<Map<string, any[]>>(new Map())
  // 预取的 Excel 原始数据缓存（挂载时并发预取，避免构建阶段 3 并发 worker 串行等待网络）
  const prefetchedExcelDataRef = useRef<Map<string, any>>(new Map())

  // 组件卸载标记：异步图层构建（loadMapInfoLayer）在页面切换后仍在飞行时，
  // 用此标记阻止旧实例把几何/标签挂到复用后的共享地图上（避免"关闭标签后仍显示"的孤儿实例）
  const unmountedRef = useRef(false)

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

  // showSectorInfo 是每次渲染都新建的普通函数（useSectorInfoPanel 未 memo），
  // 若作为 handleSectorClick 依赖会导致 createSectorLayers 每次重渲染都重建扇区图层，
  // 框选高亮刚设置就被重建的空高亮实例覆盖。用 ref 持有最新引用，保持 handleSectorClick 稳定。
  const showSectorInfoRef = useRef(showSectorInfo)
  showSectorInfoRef.current = showSectorInfo

  // 要素信息面板 (MapInfo/地理化点文件)
  const {
    featureProperties,
    featurePanelVisible,
    featureTitle,
    featureSubtitle,
    featureClickPosition,
    showFeatureInfo,
    hideFeatureInfo
  } = useFeatureInfoPanel()

  // 从重叠列表进入属性框时缓存列表，供属性框「返回」恢复
  const overlapListCacheRef = useRef<{ features: OverlappingFeature[]; position: { x: number, y: number } } | null>(null)
  // 从重叠扇区列表进入属性框时缓存列表，供属性框「返回」恢复（与图层文件返回重叠列表行为一致）
  const overlapSectorsCacheRef = useRef<{ sectors: RenderSectorData[]; position: { x: number, y: number } } | null>(null)

  // 属性框当前展示的编辑态要素（编辑开关图层 + 编辑会话要素）：仅此时字段值可编辑写回
  const featureEditTargetRef = useRef<{ layerId: string; editId: string } | null>(null)

  // 属性框字段提交：写回编辑工作集（随后由保存工具落盘）
  const handleFeaturePropertyChange = useCallback((key: string, value: string) => {
    const target = featureEditTargetRef.current
    if (!target) return
    useLayerEditStore.getState().updateFeatureProperties(target.layerId, target.editId, { [key]: value })
  }, [])

  // 属性框新增图层属性字段：写回工作集（字段对全图层生效）后重读要素刷新面板
  const handleFeatureAddProperty = useCallback((key: string, value: string): AttributeErrorCode | null => {
    const target = featureEditTargetRef.current
    if (!target) return 'noWorkspace'
    const code = useLayerEditStore.getState().addFeatureAttribute(target.layerId, target.editId, key, value)
    if (code) return code
    const f = useLayerEditStore.getState().getWorkspace(target.layerId)
      ?.features.find((x) => x.properties?._editId === target.editId)
    if (f) {
      const clean: Record<string, any> = {}
      for (const [k, v] of Object.entries(f.properties || {})) {
        if (!k.startsWith('_')) clean[k] = v
      }
      // event 传 undefined：面板位置保持不变，只刷新内容
      showFeatureInfo(clean, undefined, featureTitle, featureSubtitle)
    }
    return null
  }, [showFeatureInfo, featureTitle, featureSubtitle])

  // 属性框关闭：同时清空重叠列表缓存（「返回」按钮不再可用）与编辑态要素标识
  const handleFeatureInfoClose = useCallback(() => {
    overlapListCacheRef.current = null
    featureEditTargetRef.current = null
    hideFeatureInfo()
  }, [hideFeatureInfo])

  // 从属性框返回重叠要素选择列表
  const handleBackToOverlapList = useCallback(() => {
    const cache = overlapListCacheRef.current
    if (!cache) return
    overlapListCacheRef.current = null
    featureEditTargetRef.current = null
    hideFeatureInfo()
    setOverlappingFeatures(cache.features)
    setOverlapPosition(cache.position)
  }, [hideFeatureInfo])

  // 扇区属性框关闭：同时清空重叠扇区列表缓存（「返回」按钮不再可用）
  const handleSectorInfoClose = useCallback(() => {
    overlapSectorsCacheRef.current = null
    hideSectorInfo()
  }, [hideSectorInfo])

  // 从扇区属性框返回重叠扇区选择列表
  const handleBackToOverlapSectors = useCallback(() => {
    const cache = overlapSectorsCacheRef.current
    if (!cache) return
    overlapSectorsCacheRef.current = null
    hideSectorInfo()
    setOverlappingSectors(cache.sectors)
    setOverlapPosition(cache.position)
  }, [hideSectorInfo])

  // 关闭地图上的全部弹出层（属性框 + 重叠列表 + 列表回退缓存）：点击地图空白区域统一清理
  const closeMapPopups = useCallback(() => {
    overlapSectorsCacheRef.current = null
    overlapListCacheRef.current = null
    featureEditTargetRef.current = null
    hideSectorInfo()
    hideFeatureInfo()
    setOverlappingSectors([])
    setOverlappingFeatures([])
    setOverlapPosition(null)
  }, [hideSectorInfo, hideFeatureInfo])

  // 移除悬停状态管理，改为仅使用点击事件显示属性

  // State
  const [loading, setLoading] = useState(true)
  const [isMapInitialized, setIsMapInitialized] = useState(false)
  // 图层加载中状态（勾选图层时地图中央转圈提示）
  // 用计数器支持并发：连续勾选多个图层时，所有加载都完成才隐藏
  const [layerLoading, setLayerLoading] = useState(false)
  const layerLoadCountRef = useRef(0)
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

  // props → 内部状态同步：内部 layerVisibility 只在挂载时初始化，登录后设置异步恢复
  // （MapPage 的层列表随后回填）时若不在此同步，基站图层会停留在旧的显隐状态。
  // 按值比较（原始类型依赖）避免每次渲染新建对象导致的循环更新。
  useEffect(() => {
    setLayerVisibility(prev => (
      prev.lte === initialLayerVisibility.lte && prev.nr === initialLayerVisibility.nr
        ? prev
        : { lte: initialLayerVisibility.lte, nr: initialLayerVisibility.nr }
    ))
  }, [initialLayerVisibility.lte, initialLayerVisibility.nr])
  const [labelVisibility, setLabelVisibility] = useState<LayerVisibility>({
    lte: false,
    nr: false
  })
  // 点文件标签可见性（撒点文件的属性标签）
  // 🔧 挂载时从持久化 store 恢复（合并 pointFileLabelVisibility 与 layerFileLabelVisibility），
  // 保证页面切换后文件标签开关与显示状态保持
  const [pointFileLabelVisibility, setPointFileLabelVisibilityState] = useState<Record<string, boolean>>(() => {
    const s = useMapStore.getState().mapSettings
    return { ...s.pointFileLabelVisibility, ...s.layerFileLabelVisibility }
  })
  // 🔧 最新标签状态 ref：异步图层构建（loadMapInfoLayer）读取时用它而非闭包，
  // 避免构建期间用户切换标签开关读到旧值（RC3：构建完成后强制恢复旧标签状态）
  const pointFileLabelVisibilityRef = useRef(pointFileLabelVisibility)
  pointFileLabelVisibilityRef.current = pointFileLabelVisibility

  // 上一个处于编辑态的图层 id（用于退出/切换编辑时恢复全量标签注册）
  const prevEditableLabelRef = useRef<string | null>(null)
  // 🔧 类内图层顺序 / "可选"开关 ref：圈选收集与 z-order 协调读取时用它而非闭包，
  // 避免异步构建的图层与事件回调读到旧值
  const layerOrderRef = useRef<LayerOrderMap | undefined>(layerOrder)
  layerOrderRef.current = layerOrder
  const selectableMapRef = useRef<Record<string, boolean>>(selectableMap)
  selectableMapRef.current = selectableMap
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

  // 重叠要素（图层文件/地理化数据）选择状态
  const [overlappingFeatures, setOverlappingFeatures] = useState<OverlappingFeature[]>([])

  /**
   * 装饰图层：把其 marker 移到 markerPane 顶部（装饰为最低优先级，仅独立勾选时自身可点）
   */
  const bringDecorationToFront = useCallback(() => {
    const fg = decorationLayerRef.current
    if (!fg) return
    fg.eachLayer((layer: any) => {
      const el = layer?.getElement?.()
      if (el && el.parentNode) el.parentNode.appendChild(el)
    })
  }, [])

  /**
   * 汇总所有勾选可见图层并按优先级重排渲染层。
   * 优先级：基站 > 图层文件 > 地理化数据 > 装饰图层；同类型内面板顶部最高。
   * 可见性直接查询各图层管理器，避免依赖可能过期的 props。
   */
  const reconcileLayerZOrder = useCallback(() => {
    const visible: ZOrderLayer[] = []
    const order = layerOrderRef.current

    // 装饰图层（最低优先级，typeRank=0）：marker 在 markerPane(600)，天然在 overlayPane 之上
    if (decorationLayerVisibility) {
      const ids = orderWithIds(order?.decoration, ['decoration-layer'])
      const idx = ids.indexOf('decoration-layer')
      visible.push({ type: 'decoration', panelRank: panelRankFromIndex(idx, ids.length), bringToFront: bringDecorationToFront })
    }

    // 地理化数据（typeRank=1）：类内按控制面板顺序（索引 0 = 最上）
    const geoLayers = geoDataLayerManagerRef.current?.getAllLayers?.() ?? []
    const geoIds = orderWithIds(order?.geodata, geoLayers.map(gl => gl.getId()))
    geoIds.forEach((id, idx) => {
      const gl = geoLayers.find(g => g.getId() === id)
      if (!gl || !gl.isVisible()) return
      visible.push({ type: 'geodata', panelRank: panelRankFromIndex(idx, geoIds.length), bringToFront: () => gl.bringToFrontForZOrder() })
    })

    // 图层文件（typeRank=2）：类内按控制面板顺序
    const mapInfoEntries = Array.from(mapInfoLayerRefsRef.current.values())
    const mapInfoIds = orderWithIds(order?.mapinfo, mapInfoEntries.map(e => (e.mapInfoLayer as any).id))
    mapInfoIds.forEach((id, idx) => {
      const entry = mapInfoEntries.find(e => (e.mapInfoLayer as any).id === id)
      if (!entry || !entry.mapInfoLayer.isVisible()) return
      visible.push({ type: 'mapinfo', panelRank: panelRankFromIndex(idx, mapInfoIds.length), bringToFront: () => entry.mapInfoLayer.bringToFrontForZOrder() })
    })

    // 基站（typeRank=3）：优先级最高，类内 LTE/NR 按控制面板顺序
    const sectorIds = orderWithIds(order?.sector, ['lte-sectors', 'nr-sectors'])
    sectorIds.forEach((id, idx) => {
      const isLte = id === 'lte-sectors'
      const ref = isLte ? lteSectorLayerRef.current : nrSectorLayerRef.current
      const isVisible = isLte ? layerVisibility.lte : layerVisibility.nr
      if (isVisible && ref) {
        visible.push({ type: 'sector', panelRank: panelRankFromIndex(idx, sectorIds.length), bringToFront: () => ref!.bringToFrontForZOrder() })
      }
    })

    reconcileZOrder(visible)

    // 热力层始终压在所有数据图形之上
    heatmapManagerRef.current?.bringAllToFront()
  }, [decorationLayerVisibility, layerVisibility, bringDecorationToFront, geoDataLayerManagerRef, mapInfoLayerRefsRef, lteSectorLayerRef, nrSectorLayerRef])

  /**
   * 解析当前圈选/选择的唯一目标图层。
   * 按 z-order 从高到低 walk（基站 > 图层文件 > 地理化数据 > 装饰图层；类内按面板顺序），
   * 第一个"可见且可选开关打开"的图层获胜；无穿透到更低类型。
   * 返回 null 表示当前没有可圈选图层。
   */
  const getSelectionTarget = useCallback((): SelectionTarget | null => {
    const visibility = layerVisibilityRef.current
    const order = layerOrderRef.current
    const selectable = selectableMapRef.current

    // 1. 基站（最高优先级）
    const sectorIds = orderWithIds(order?.sector, ['lte-sectors', 'nr-sectors'])
    for (const id of sectorIds) {
      const isLte = id === 'lte-sectors'
      const isVisible = isLte ? visibility.lte : visibility.nr
      if (isVisible && isLayerSelectable(selectable, id)) {
        return { kind: 'sector', networkType: isLte ? 'lte' : 'nr' }
      }
    }

    // 2. 图层文件（MapInfo）
    const mapInfoEntries = Array.from(mapInfoLayerRefsRef.current.values())
    const mapInfoIds = orderWithIds(order?.mapinfo, mapInfoEntries.map(e => (e.mapInfoLayer as any).id))
    for (const id of mapInfoIds) {
      const entry = mapInfoEntries.find(e => (e.mapInfoLayer as any).id === id)
      if (entry?.mapInfoLayer.isVisible() && isLayerSelectable(selectable, id)) {
        return { kind: 'mapinfo', layerId: id }
      }
    }

    // 3. 地理化数据（GeoData；自定义图层不参与圈选收集，自然跳过）
    const geoLayers = geoDataLayerManagerRef.current?.getAllLayers?.() ?? []
    const geoIds = orderWithIds(order?.geodata, geoLayers.map(gl => gl.getId()))
    for (const id of geoIds) {
      const gl = geoLayers.find(g => g.getId() === id)
      if (gl?.isVisible() && isLayerSelectable(selectable, id)) {
        return { kind: 'geodata', layerId: id }
      }
    }

    // 4. 装饰图层（打点/定位标记，最低优先级）
    if (decorationLayerVisibility && isLayerSelectable(selectable, 'decoration-layer')) {
      return { kind: 'decoration' }
    }

    return null
  }, [decorationLayerVisibility, geoDataLayerManagerRef, mapInfoLayerRefsRef])
  // 圈选收集回调以空依赖长期持有，通过 ref 调用最新的目标解析
  const getSelectionTargetRef = useRef<() => SelectionTarget | null>(() => null)
  getSelectionTargetRef.current = getSelectionTarget

  // 面板拖拽顺序变化后立即重排渲染层
  useEffect(() => {
    reconcileLayerZOrder()
  }, [layerOrder, reconcileLayerZOrder])


  /**
   * 应用装饰图层颜色（marker 填充色 / 边框 / 边框宽度 / 透明度）
   */
  const applyDecorationColor = useCallback((settings: { fillColor: string; fillOpacity: number; borderWidth: number; borderColor: string }) => {
    const fg = decorationLayerRef.current
    if (!fg || !window.L) return
    const L = window.L
    fg.eachLayer((layer: any) => {
      if (!(layer instanceof L.Marker)) return
      const iconOpts = layer.options?.icon?.options
      if (iconOpts?.className !== 'location-marker-icon') return
      const newIcon = L.divIcon({
        // 定位点圆点始终不透明：fillOpacity 只影响面填充，不应让定位点标记消失
        html: `<div style="background:${settings.fillColor};width:16px;height:16px;border-radius:50%;border:${settings.borderWidth}px solid ${settings.borderColor};box-shadow:0 1px 4px rgba(0,0,0,0.3);opacity:1;"></div>`,
        className: 'location-marker-icon',
        iconSize: [16, 16] as [number, number],
        iconAnchor: [8, 8] as [number, number]
      })
      layer.setIcon(newIcon)
    })
  }, [])

  /**
   * 暴露方法给父组件（同时留存到 selfHandleRef，供组件内部键盘事件调用
   * clearMeasurements/clearCaptureMarkers 等，无需经父组件 ref）
   */
  const selfHandleRef = useRef<OnlineMapRef | null>(null)
  useImperativeHandle(ref, () => {
    const handle: OnlineMapRef = {
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

      // 热力替换模式：原图形保持隐藏
      const wantVisible = visible && !isHeatmapReplacement(layerId)

      // 先检查是否是 GeoDataLayer（扇区或多边形类型）
      if (geoDataLayerManagerRef.current) {
        const geoLayer = geoDataLayerManagerRef.current.getLayer(layerId)
        if (geoLayer) {
          console.log('[OnlineMap] GeoDataLayer 可见性切换:', layerId, wantVisible)
          if (mapInstanceRef.current) {
            geoLayer.setVisible(mapInstanceRef.current, wantVisible)
          }
          reconcileLayerZOrder()
          return
        }
      }

      // 处理 MapInfoLayer
      const layerRef = mapInfoLayerRefsRef.current.get(layerId)
      if (layerRef && mapInstanceRef.current) {
        if (wantVisible) {
          // 使用 MapInfoLayer 的 addTo 方法而不是直接添加 Leaflet 图层
          // 这样可以正确设置 currentMap 引用，使标签功能能够工作
          layerRef.mapInfoLayer.addTo(mapInstanceRef.current)
        } else {
          // 使用 MapInfoLayer 的 remove 方法而不是直接移除 Leaflet 图层
          // 这样可以正确清理标签和其他资源
          layerRef.mapInfoLayer.remove(mapInstanceRef.current)
        }
        reconcileLayerZOrder()
      }
    },

    // 保存成功后刷新图层数据：源文件已被整层重写，必须丢弃缓存并重建原始图层实例，
    // 否则关闭"编辑"开关后属性框/标签仍显示保存前的旧值（内存中旧数据）。
    refreshLayerData: async (layerId, fresh) => {
      const map = mapInstanceRef.current
      const file = layerFiles.find((f) => f.id === layerId)
      if (!map || !file) return
      try {
        // 1) 缓存处理：有最新数据（编辑工作集）则直接以之替换缓存，避免保存后再下载整层
        //    （40MB 级图层重新拉取 + 解析会额外卡顿数秒）；否则丢弃缓存走重新拉取
        if (fresh?.data) {
          useMapDataCacheStore.getState().cacheLayerGeoJSON(layerId, fresh.data, fresh.version ?? null)
        } else {
          useMapDataCacheStore.getState().invalidateLayer(layerId)
        }
        // 2) 移除旧图层实例并重置加载标记，随后重新拉取数据构建
        const oldRef = mapInfoLayerRefsRef.current.get(layerId)
        if (oldRef) {
          try { oldRef.mapInfoLayer.remove(map) } catch { /* ignore */ }
          mapInfoLayerRefsRef.current.delete(layerId)
        }
        loadedMapInfoLayersRef.current.delete(layerId)
        getHeatmapManager().remove(layerId)
        // 3) 重新构建（先按不可见加载，避免编辑态下与编辑会话层重叠显示）
        await loadMapInfoLayer({ ...file, visible: false })
        // 4) 按"当前"状态恢复显隐：编辑态保持隐藏（退出编辑由图层可见性 effect 恢复）
        const nowEditing = useLayerEditStore.getState().editableLayerId === layerId
        const newRef = mapInfoLayerRefsRef.current.get(layerId)
        if (newRef && mapInstanceRef.current) {
          // 编辑态 / 热力替换模式（显示原图层关闭）下保持隐藏
          newRef.mapInfoLayer.setVisible(
            mapInstanceRef.current,
            !!file.visible && !nowEditing && !isHeatmapReplacement(layerId)
          )
          // 编辑态：标签改从编辑工作集注册（新实例无编辑源），按标签开关状态恢复显示
          if (nowEditing) {
            const ws = useLayerEditStore.getState().getWorkspace(layerId)
            newRef.mapInfoLayer.setEditLabelSource(file.visible && ws ? ws.features : null)
            if (pointFileLabelVisibilityRef.current[layerId]) {
              newRef.mapInfoLayer.setLabelVisibility(true)
            }
          }
        }
        reconcileLayerZOrder()
        // 5) 热力图重放（与图层可见性 effect 的兜底逻辑一致）
        const hs = useMapStore.getState().mapSettings.heatmapSettingsMap?.[layerId]
        if (hs?.enabled) applyDataLayerHeat(layerId, hs)
      } catch (e) {
        console.error('[OnlineMap] 刷新图层数据失败:', layerId, e)
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
        // 先应用已保存的标签配置再切换可见性：有配置时 MapInfoLayer 标记为已自定义，
        // 开启标签即用保存的字段，避免先触发"首次自动挑选默认标签字段"造成闪烁
        if (settings) {
          layerRef.mapInfoLayer.setLabelConfig(settings)
        }
        layerRef.mapInfoLayer.setLabelVisibility(visible)
        return
      }

      // 2. 处理 GeoDataLayer（地理化数据：点状、扇区或多边形）
      if (geoDataLayerManagerRef.current) {
        const geoLayer = geoDataLayerManagerRef.current.getLayer(fileId)
        if (geoLayer) {
          console.log('[OnlineMap] GeoDataLayer 标签可见性切换:', fileId, visible)
          if (settings) {
            console.log('[OnlineMap] GeoDataLayer 应用标签配置:', settings)
            geoLayer.setLabelConfig(settings)
          }
          geoLayer.setLabelVisibility(visible)
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
      reconcileLayerZOrder()
    },

    setDecorationLabelVisibility: (visible: boolean) => {
      console.log('[OnlineMap] setDecorationLabelVisibility called:', visible)
      decorationLabelVisibleRef.current = visible

      // Show/hide decoration label markers（定位点标签直接在地图上，不受此开关控制）
      const map = mapInstanceRef.current
      if (!map || !decorationLayerRef.current) return

      markerLabelElementsRef.current.forEach((labelMarker, captureId) => {
        if (captureId.startsWith('location-')) return
        if (visible) {
          if (!decorationLayerRef.current?.hasLayer(labelMarker)) {
            decorationLayerRef.current?.addLayer(labelMarker)
          }
        } else {
          if (decorationLayerRef.current?.hasLayer(labelMarker)) {
            decorationLayerRef.current?.removeLayer(labelMarker)
          }
        }
      })
    },

    setLayerColorSettings: (fileId, settings, geometryType) => {
      console.log('[OnlineMap] setLayerColorSettings:', fileId, settings, geometryType)

      // 装饰图层
      if (fileId === 'decoration-layer') {
        applyDecorationColor(settings)
        return
      }

      // 地理化数据 / MapInfo 图层
      // 1. 优先处理 GeoDataLayer（地理化数据）
      if (geoDataLayerManagerRef.current) {
        const geoLayer = geoDataLayerManagerRef.current.getLayer(fileId)
        if (geoLayer) {
          console.log('[OnlineMap] setLayerColorSettings -> GeoDataLayer:', fileId)
          geoLayer.setStyleOverrides(settings)
          return
        }
      }

      // 2. 处理 MapInfoLayer（图层文件）
      const layerRef = mapInfoLayerRefsRef.current.get(fileId)
      if (layerRef) {
        console.log('[OnlineMap] setLayerColorSettings -> MapInfoLayer:', fileId)
        layerRef.mapInfoLayer.setStyleOverrides(settings)
        return
      }

      console.warn('[OnlineMap] setLayerColorSettings: 未找到目标图层', fileId)
    },

    setLayerThematicSettings: (fileId, settings) => {
      console.log('[OnlineMap] setLayerThematicSettings:', fileId, settings)

      // 1. 优先处理 GeoDataLayer（地理化数据）
      if (geoDataLayerManagerRef.current) {
        const geoLayer = geoDataLayerManagerRef.current.getLayer(fileId)
        if (geoLayer) {
          geoLayer.setThematicOverrides(settings)
          return
        }
      }

      // 2. 处理 MapInfoLayer（图层文件）
      const layerRef = mapInfoLayerRefsRef.current.get(fileId)
      if (layerRef) {
        layerRef.mapInfoLayer.setThematicOverrides(settings)
        return
      }

      console.warn('[OnlineMap] setLayerThematicSettings: 未找到目标图层', fileId)
    },

    setSectorColorSettings: (layerId, settings) => {
      console.log('[OnlineMap] setSectorColorSettings:', layerId, settings)
      if (layerId === 'lte-sectors' && lteSectorLayerRef.current) {
        lteSectorLayerRef.current.setColorOverrides(settings)
      } else if (layerId === 'nr-sectors' && nrSectorLayerRef.current) {
        nrSectorLayerRef.current.setColorOverrides(settings)
      }
    },

    setSectorThematicSettings: (layerId, settings) => {
      console.log('[OnlineMap] setSectorThematicSettings:', layerId, settings)
      if (layerId === 'lte-sectors' && lteSectorLayerRef.current) {
        lteSectorLayerRef.current.setThematicOverrides(settings)
      } else if (layerId === 'nr-sectors' && nrSectorLayerRef.current) {
        nrSectorLayerRef.current.setThematicOverrides(settings)
      }
    },

    setLayerHeatmapSettings: (fileId, settings) => {
      heatOpsRef.current?.applyDataLayerHeat(fileId, settings)
    },

    setSectorHeatmapSettings: (layerId, settings) => {
      if (layerId === 'lte-sectors' || layerId === 'nr-sectors') {
        heatOpsRef.current?.applySectorHeat(layerId, settings)
      }
    },

    getHeatmapStats: (layerId) => heatmapManagerRef.current?.getStats(layerId) ?? null,

    replayHeatmapSettings: () => {
      heatOpsRef.current?.replayHeatmaps()
    },

    refreshSectorColors: () => {
      lteSectorLayerRef.current?.redraw()
      nrSectorLayerRef.current?.redraw()
    },

    focusLayer: (fileId) => {
      console.log('[OnlineMap] focusLayer:', fileId)
      if (!mapInstanceRef.current) return

      // 0. 处理扇区图层（基站 LTE/NR）
      let bounds: L.LatLngBounds | null = null
      if (fileId === 'lte-sectors') {
        bounds = lteSectorLayerRef.current?.getSectorBounds() ?? null
      } else if (fileId === 'nr-sectors') {
        bounds = nrSectorLayerRef.current?.getSectorBounds() ?? null
      }

      // 1. 处理 GeoDataLayer（地理化数据）
      if (!bounds && geoDataLayerManagerRef.current) {
        const geoLayer = geoDataLayerManagerRef.current.getLayer(fileId)
        if (geoLayer) bounds = geoLayer.getFeaturesBounds()
      }

      // 2. 处理 MapInfoLayer（图层文件）
      if (!bounds) {
        const layerRef = mapInfoLayerRefsRef.current.get(fileId)
        if (layerRef) bounds = layerRef.mapInfoLayer.getFeaturesBounds()
      }

      if (bounds && bounds.isValid()) {
        mapInstanceRef.current.fitBounds(bounds, { padding: [60, 60] })
      } else {
        console.warn('[OnlineMap] focusLayer: 图层无可见要素或未加载', fileId)
      }
    },

    /**
     * 搜索定位图层文件/地理化数据要素：
     * 父组件已开启图层可见性后，轮询等待异步图层构建完成 → 清除其他数据图层高亮
     * → 目标要素红色边框高亮 → 飞行定位（面/线按包围盒适配，点/扇区飞至中心）
     */
    locateLayerFeature: async (opts) => {
      const map = mapInstanceRef.current
      if (!map) return false

      const findVisibleLayer = (): { instance: any } | null => {
        const mi = mapInfoLayerRefsRef.current.get(opts.layerId)
        if (mi && mi.mapInfoLayer.isVisible()) return { instance: mi.mapInfoLayer }
        const geo = geoDataLayerManagerRef.current?.getLayer(opts.layerId)
        if (geo && geo.isVisible()) return { instance: geo }
        return null
      }

      // 大图层首次构建可能耗时（后端解析 + Canvas 分块渲染），最多等待 30s
      let target = findVisibleLayer()
      const deadline = Date.now() + 30000
      while (!target && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200))
        target = findVisibleLayer()
      }
      if (!target) {
        console.warn('[OnlineMap] locateLayerFeature: 图层未加载或不可见', opts.layerId)
        return false
      }

      // 清除其他数据图层与扇区图层的高亮，仅高亮目标要素
      mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
        mapInfoLayer.setSelectionHighlight(null)
      })
      geoDataLayerManagerRef.current?.getAllLayers().forEach(geoLayer => {
        geoLayer.setSelectionHighlight(null)
      })
      searchSectorHighlightRef.current = null
      lteSectorLayerRef.current?.setSelectionHighlight(null)
      nrSectorLayerRef.current?.setSelectionHighlight(null)
      target.instance.setSelectionHighlight(new Set([String(opts.featureId)]))

      // 定位：线/面要素按包围盒适配视野，点/扇区飞到中心点
      if (opts.bounds) {
        const latLngBounds = L.latLngBounds(opts.bounds)
        if (latLngBounds.isValid()) {
          map.flyToBounds(latLngBounds, { padding: [120, 120], maxZoom: 17, duration: 0.8 })
          return true
        }
      }
      if (opts.center) {
        map.flyTo(opts.center, Math.max(map.getZoom(), 16), { duration: 0.8 })
      }
      return true
    },

    /** 清除搜索定位的要素红色边框高亮（所有数据图层） */
    clearLayerFeatureHighlight: () => {
      mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
        mapInfoLayer.setSelectionHighlight(null)
      })
      geoDataLayerManagerRef.current?.getAllLayers().forEach(geoLayer => {
        geoLayer.setSelectionHighlight(null)
      })
    },

    /**
     * 工参搜索定位：红色边框高亮目标扇区图形本身（视口外扇区由渲染器强制补绘），
     * 并飞行定位。与图层文件搜索一致，不再使用中心标记点。
     */
    locateSector: (opts) => {
      const map = mapInstanceRef.current
      if (!map) return
      // 清除数据图层（图层文件/地理化数据）高亮，避免与扇区高亮混杂
      mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
        mapInfoLayer.setSelectionHighlight(null)
      })
      geoDataLayerManagerRef.current?.getAllLayers().forEach(geoLayer => {
        geoLayer.setSelectionHighlight(null)
      })
      // LTE/NR 两个渲染器都设置（各自只命中自己的扇区）
      const ids = new Set([String(opts.id)])
      // 持久化到 ref：图层总开关/频点变化会触发 createSectorLayers 重建渲染器，重建后据此恢复
      searchSectorHighlightRef.current = ids
      lteSectorLayerRef.current?.setSelectionHighlight(ids)
      nrSectorLayerRef.current?.setSelectionHighlight(ids)
      map.flyTo([opts.lat, opts.lng], opts.zoom ?? Math.max(map.getZoom(), 16), { duration: 0.8 })
    },

    /** 清除扇区红色边框高亮（工参搜索定位） */
    clearSectorHighlight: () => {
      searchSectorHighlightRef.current = null
      lteSectorLayerRef.current?.setSelectionHighlight(null)
      nrSectorLayerRef.current?.setSelectionHighlight(null)
    },

    getLayerThematicStats: (fileId) => {
      // 0. 处理扇区图层（基站 LTE/NR）
      if (fileId === 'lte-sectors') {
        return lteSectorLayerRef.current?.getThematicStats() ?? null
      } else if (fileId === 'nr-sectors') {
        return nrSectorLayerRef.current?.getThematicStats() ?? null
      }

      // 1. 处理 GeoDataLayer（地理化数据）
      if (geoDataLayerManagerRef.current) {
        const geoLayer = geoDataLayerManagerRef.current.getLayer(fileId)
        if (geoLayer) return geoLayer.getThematicStats()
      }

      // 2. 处理 MapInfoLayer（图层文件）
      const layerRef = mapInfoLayerRefsRef.current.get(fileId)
      if (layerRef) return layerRef.mapInfoLayer.getThematicStats()

      return null
    },

    getSectorThematicStats: (layerId) => {
      if (layerId === 'lte-sectors') {
        return lteSectorLayerRef.current?.getThematicStats() ?? null
      } else if (layerId === 'nr-sectors') {
        return nrSectorLayerRef.current?.getThematicStats() ?? null
      }
      return null
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
        // 直接在 Leaflet 容器上设置主题背景色，避免默认灰色透出
        mapInstanceRef.current.getContainer().style.backgroundColor = 'hsl(var(--muted))'
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

      // 幂等：同一 locationId 已存在时仅更新位置与标签，不重复创建圆点，
      // 保证"一个定位点 = 一个标记 + 一个标签"，避免重复添加导致标记/标签不一致
      const existing = locationMarkersRef.current.find(
        m => (m as any).captureProperties?.id === locationId
      )
      if (existing) {
        existing.setLatLng([marker.lat, marker.lng])
        updateMarkerLabel(locationId, index, defaultLabel, marker.lat, marker.lng)
        return
      }

      // 定位点标记采用固定样式（与打点标记一致：纯色红圆点 + 白边框），
      // 不随装饰图层颜色/透明度变化，也不依赖"装饰图层"复选框可见性
      const icon = L.divIcon({
        html: `<div style="background:#ef4444;width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.3);"></div>`,
        className: 'capture-marker',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      })

      // 创建标记
      const mapMarker = L.marker([marker.lat, marker.lng], { icon })

      // 弹出属性框显示/存储的经纬度统一使用 WGS84（与打点标记一致），
      // GCJ02 仅用于地图定位显示（marker.lng/marker.lat）
      const [wgsLat, wgsLng] = CoordinateTransformer.gcj02ToWgs84(marker.lat, marker.lng)

      // 存储属性数据到 marker 上，供圈选工具读取（经纬度为 WGS84）
      ;(mapMarker as any).captureProperties = {
        id: locationId,
        name: defaultLabel,  // 使用默认标签名作为名称
        标签: defaultLabel,  // 添加标签字段
        longitude: wgsLng.toFixed(6),
        latitude: wgsLat.toFixed(6),
        lng: wgsLng.toFixed(6),
        lat: wgsLat.toFixed(6),
        _layerType: 'LocationPoint'
      }

      // 保存默认标签到 markerLabelsRef
      markerLabelsRef.current.set(locationId, {
        id: locationId,
        name: locationId,
        label: defaultLabel
      })

      // 直接添加到地图，不依赖"装饰图层"复选框勾选状态（定位点始终显示）
      mapMarker.addTo(map)

      // 立即显示默认标签
      updateMarkerLabel(locationId, index, defaultLabel, marker.lat, marker.lng)

      // 左键点击：弹出可编辑属性框
      mapMarker.on('click', () => {
        const labelData = markerLabelsRef.current.get(locationId)
        const currentLabel = labelData?.label || defaultLabel
        const inputId = `location-label-input-${locationId}`
        const lngInputId = `location-lng-input-${locationId}`
        const latInputId = `location-lat-input-${locationId}`
        const inputStyle = `padding:4px 8px;border:1px solid hsl(var(--border));border-radius:4px;font-size:12px;width:100%;color:hsl(var(--foreground));background:hsl(var(--muted));outline:none;font-family:monospace;`
        const inputFocus = `onfocus="this.style.borderColor='#3b82f6';this.style.boxShadow='0 0 0 2px rgba(59,130,246,0.2)'" onblur="this.style.borderColor='hsl(var(--border))';this.style.boxShadow='none'"`
        const deleteBtnText = t('map.delete') || '删除'
        const copyBtnText = t('map.copy') || '复制'
        const propertiesText = t('map.properties') || '属性'
        const labelNameText = t('map.labelName') || '标签'
        const longitudeText = t('map.longitude') || '经度'
        const latitudeText = t('map.latitude') || '纬度'
        const confirmBtnText = t('common.confirm') || '确定'

        const popupContent = `
          <div style="padding:10px 12px;min-width:280px;background:hsl(var(--popover));color:hsl(var(--popover-foreground));border:1px solid hsl(var(--border));border-radius:8px;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);" onclick="event.stopPropagation()">
            <div style="font-size:14px;font-weight:600;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid hsl(var(--border));color:hsl(var(--foreground));">${propertiesText}</div>
            <div style="display:grid;grid-template-columns:50px 1fr;gap:8px 12px;align-items:center;line-height:1.6;">
              <span style="color:hsl(var(--muted-foreground));font-size:11px;">${labelNameText}</span>
              <input id="${inputId}" type="text" value="${currentLabel.replace(/"/g, '&quot;')}"
                style="${inputStyle}" ${inputFocus} />
              <span style="color:hsl(var(--muted-foreground));font-size:11px;">${longitudeText}</span>
              <input id="${lngInputId}" type="text" value="${wgsLng.toFixed(6)}"
                style="${inputStyle}" ${inputFocus} />
              <span style="color:hsl(var(--muted-foreground));font-size:11px;">${latitudeText}</span>
              <input id="${latInputId}" type="text" value="${wgsLat.toFixed(6)}"
                style="${inputStyle}" ${inputFocus} />
            </div>
            <div style="margin-top:10px;padding-top:8px;border-top:1px solid hsl(var(--border));display:flex;justify-content:flex-end;gap:8px;">
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
              const idx = locationMarkersRef.current.findIndex(m => m === mapMarker)
              if (idx > -1) {
                locationMarkersRef.current.splice(idx, 1)
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
      if (__sharedShadowLineRef.current) {
        mapInstanceRef.current.removeLayer(__sharedShadowLineRef.current)
        __sharedShadowLineRef.current = null
      }
      if (__sharedShadowLabelRef.current) {
        mapInstanceRef.current.removeLayer(__sharedShadowLabelRef.current)
        __sharedShadowLabelRef.current = null
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
      setSelectedFeatureCount(0)
      selectionPointsRef.current = []
      // 清除扇区图层高亮（含工参搜索定位红框）
      searchSectorHighlightRef.current = null
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
    },

    clearShapeSelection: () => {
      const session = (mapInstanceRef.current as any)?.__nptEditSession as LayerEditSession | undefined
      session?.clearShapeSelection?.()
      setShapeSelectedCount(0)
    }
    }
    selfHandleRef.current = handle
    return handle
  })

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
    // 测距模式、圈选模式或打点模式下不显示扇区属性
    if (measureModeRef.current || selectionModeRef.current !== 'none' || captureModeRef.current) return;

    // 选中规则（地图工具页）：
    // - "选择"工具：基站要素仅高亮选中（不弹属性框），纳入统一选中状态（Ctrl+C 复制/清除可用）
    // - "手形"工具：点击基站弹属性框/重叠列表（与图层文件、地理化数据一致）
    if (modeRef.current === 'default') {
      if (!mapDragToolRef.current) {
        if (!selectModeRef.current) return
        const sid = sector.networkType === 'LTE' ? 'lte-sectors' : 'nr-sectors'
        if (selectableMapRef.current?.[sid] === false) return
        const id = String(sector.id)
        selectedFeaturesRef.current = [{ ...sector, _layerType: sector.networkType }]
        selectedIdsRef.current = new Set([id])
        setSelectedFeatureCount(1)
        if (lteSectorLayerRef.current) lteSectorLayerRef.current.setSelectionHighlight(selectedIdsRef.current)
        if (nrSectorLayerRef.current) nrSectorLayerRef.current.setSelectionHighlight(selectedIdsRef.current)
        setSelectionTip(`${t('map.featuresSelected', { count: 1 })}，${t('map.copyTip') || '按 Ctrl+C 复制'}`)
        return
      }
    }

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
      overlapListCacheRef.current = null
      setOverlappingFeatures([])
      setOverlappingSectors(uniqueOverlapping)
      setOverlapPosition({ x: clientX, y: clientY })
    } else {
      // 直接点击单个扇区：非重叠列表进入，清除回退缓存（属性框不显示「返回」）
      overlapSectorsCacheRef.current = null
      showSectorInfoRef.current(sector, event)
    }

    if (onSectorClick) {
      onSectorClick(sector)
    }
  }, [layerVisibility, onSectorClick, mode])

  /**
   * 收集点击位置穿透命中的所有可见图层要素（地理化数据 + 图层文件）。
   *
   * 不再依赖 Leaflet 把 click 分发给最上层要素（Canvas 渲染器下最上层图层的
   * canvas 会整块吞掉点击，下层图层要素收不到事件——即"图层优先级"），
   * 而是在地图 click 中统一遍历所有可见图层做像素空间精确命中检测：
   * 面要素只认封闭区域实际包含点击点，边框/包围盒相交不算命中。
   * 圈选/点选工具仍使用 getFeaturesInCircle 的包围盒粗检，不受影响。
   */
  const collectFeatureHits = useCallback((latlng: L.LatLng, ignoreSelectable: boolean = false): OverlappingFeature[] => {
    const map = mapInstanceRef.current
    const hits: Array<OverlappingFeature & { z: number }> = []
    const seenProps = new Set<object>()
    const selectable = selectableMapRef.current || {}
    // 命中优先级 = 图层类别（图层文件 > 地理化数据；基站由 getSelectionTarget 另行处理）
    // + 类内面板层级（拖拽排序，序号小 = 层级高）
    const order = layerOrderRef.current
    const mapInfoRank = new Map<string, number>()
    orderWithIds(order?.mapinfo, Array.from(mapInfoLayerRefsRef.current.keys())).forEach((id, i) => mapInfoRank.set(id, i))
    const geoLayersAll = geoDataLayerManagerRef.current?.getAllLayers?.() ?? []
    const geoRank = new Map<string, number>()
    orderWithIds(order?.geodata, geoLayersAll.map(gl => gl.getId())).forEach((id, i) => geoRank.set(id, i))
    const addHit = (ln: string, props: Record<string, any>, geometry: any, z: number, layerId?: string, editId?: string) => {
      if (!props || seenProps.has(props)) return
      seenProps.add(props)
      // 主行显示要素自身名称（属性内容），图层名仅作副标题/次行
      hits.push({ layerName: ln, layerId, editId, name: extractFeatureName(props) || ln, properties: props, geometry, z })
    }

    // 地理化数据图层（GeoDataLayer）—— 默认仅"可选"开关打开的图层参与选中
    geoDataLayerManagerRef.current?.forEachLayer(layer => {
      if (!layer.isVisible()) return
      if (!ignoreSelectable && selectable[layer.getId()] === false) return
      const ln = layer.getName()
      const z = 100000 + (geoRank.get(layer.getId()) ?? 9999)
      for (const item of layer.getFeaturesAtPoint(latlng)) {
        addHit(ln, item.properties, (item as any).geometry, z, layer.getId())
      }
    })

    // 图层文件（MapInfoLayer）—— 默认仅"可选"开关打开的图层参与选中
    if (map) {
      mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer, leafletLayer }) => {
        if (!map.hasLayer(leafletLayer)) return
        if (!ignoreSelectable && selectable[(mapInfoLayer as any).id] === false) return
        const ln = mapInfoLayer.getName()
        const layerId = (mapInfoLayer as any).id
        const z = (mapInfoRank.get(layerId) ?? 9999)
        for (const f of mapInfoLayer.getFeaturesAtPoint(latlng)) {
          addHit(ln, f.properties, f.geometry, z, layerId)
        }
      })
    }

    // 编辑会话图层（编辑开关图层：原始渲染层已隐藏，由会话 EDIT_PANE 层渲染）——
    // 手形工具点击要素弹属性框需要能命中编辑层要素，这里补收集。
    // 编辑层视觉在最上（EDIT_PANE），z 取最小保证排序优先。
    const editableId = useLayerEditStore.getState().editableLayerId
    if (editableId) {
      const session = (map as any)?.__nptEditSession as LayerEditSession | undefined
      if (session?.isEditing()) {
        const editLn = mapInfoLayerRefsRef.current.get(editableId)?.mapInfoLayer.getName()
          || session.getLayerName()
          || editableId
        // 属性框不展示编辑器内部字段（_editStyle/_shape/_ellipse 等）；_editId 单独取出供字段编辑写回
        for (const f of session.getFeaturesAtPoint(latlng)) {
          const clean: Record<string, any> = {}
          for (const [k, v] of Object.entries(f.properties || {})) {
            if (k.startsWith('_')) continue
            clean[k] = v
          }
          addHit(editLn, clean, f.geometry, -1, editableId, f.properties?._editId ? String(f.properties._editId) : undefined)
        }
      }
    }

    // 按图层类别 + 面板层级排序：hits[0] 即层级最高的命中要素
    //（修复"大面积面图层盖过层级更高的小图层"——点击选中不再取决于面积）
    hits.sort((a, b) => a.z - b.z)
    return hits
  }, [])

  /**
   * 处理地图点击位置的图层要素：命中多个弹重叠选择菜单，单个直接弹属性框。
   * 由 handleMapClick 统一调用（要素自身不再绑定 click + stopPropagation）。
   * @returns 是否命中了要素（命中时调用方应中止后续地图点击处理）
   */
  const handleFeatureLayersAtPoint = useCallback((
    latlng: L.LatLng,
    clientX: number,
    clientY: number,
    ignoreSelectable: boolean = false
  ): boolean => {
    const hits = collectFeatureHits(latlng, ignoreSelectable)
    if (hits.length === 0) return false

    // 关闭可能还开着的扇区重叠选择菜单
    setOverlappingSectors([])

    if (hits.length > 1) {
      // 重叠列表选定后再确定编辑目标（onSelect 内设置）
      featureEditTargetRef.current = null
      setOverlappingFeatures(hits)
      setOverlapPosition({ x: clientX, y: clientY })
    } else {
      const h = hits[0]
      // 编辑会话要素 → 属性框字段可编辑（写回工作集）；其余图层只读
      featureEditTargetRef.current = h.layerId && h.editId ? { layerId: h.layerId, editId: h.editId } : null
      // 属性框标题显示要素自身名称，图层名作为副标题
      showFeatureInfo(h.properties, { originalEvent: { clientX, clientY } } as any, h.name, h.layerName)
    }
    return true
  }, [collectFeatureHits, showFeatureInfo])

  // ===== "选择"工具：点击要素高亮、双击要素弹属性/风格配置（非编辑图层路径）=====
  const selectHighlightRef = useRef<L.GeoJSON | null>(null)
  // 高亮要素所属图层 id：高亮绘制在独立 nptSelectPane，不随源图层隐藏而消失，
  // 需要记录来源图层，在图层被关闭/移除时主动清理（见图层可见性 effect）
  const selectHighlightLayerIdRef = useRef<string | null>(null)

  const clearSelectHighlight = useCallback(() => {
    const map = mapInstanceRef.current
    if (map && selectHighlightRef.current) {
      map.removeLayer(selectHighlightRef.current)
      selectHighlightRef.current = null
    }
    selectHighlightLayerIdRef.current = null
  }, [])

  const highlightFeature = useCallback((hit: OverlappingFeature) => {
    const map = mapInstanceRef.current
    if (!map || !hit.geometry) return
    clearSelectHighlight()
    selectHighlightLayerIdRef.current = hit.layerId ?? null
    if (!map.getPane('nptSelectPane')) {
      const pane = map.createPane('nptSelectPane')
      pane.style.zIndex = '640'
      pane.style.pointerEvents = 'none'
    }
    selectHighlightRef.current = L.geoJSON(
      { type: 'Feature', properties: hit.properties, geometry: hit.geometry } as any,
      {
        pane: 'nptSelectPane',
        interactive: false,
        style: {
          color: '#f59e0b',
          weight: 3,
          fillColor: '#f59e0b',
          fillOpacity: 0.15,
          dashArray: '6,3',
        } as any,
        pointToLayer: (_f, latlng) =>
          L.circleMarker(latlng, {
            pane: 'nptSelectPane',
            interactive: false,
            radius: 7,
            color: '#f59e0b',
            weight: 3,
            fillColor: '#f59e0b',
            fillOpacity: 0.35,
          }),
      },
    ).addTo(map)
  }, [clearSelectHighlight])

  // 双击要素 → 打开属性/风格配置弹窗（编辑图层由 LayerEditSession 处理，这里走非编辑图层）
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !editSelectMode) return
    const onDblClick = (e: any) => {
      if (useLayerEditStore.getState().editableLayerId) return
      const hits = collectFeatureHits(e.latlng)
      if (hits.length === 0) return
      L.DomEvent.stopPropagation(e)
      const h = hits[0]
      if (h.geometry) highlightFeature(h)
      useLayerEditStore.getState().setInspectFeature({
        layerId: '',
        layerName: h.layerName,
        name: h.name,
        geometry: h.geometry as any,
        properties: h.properties,
        editable: false,
      })
    }
    map.on('dblclick', onDblClick)
    return () => { map.off('dblclick', onDblClick) }
  }, [editSelectMode, collectFeatureHits, highlightFeature])

  // 绘制 / "选择" 激活时禁用双击缩放，避免双击收尾/查属性时地图被放大
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    if (editSelectMode || editDrawTool !== 'none') {
      map.doubleClickZoom.disable()
    } else if (!measureMode && !mapDragTool && selectionMode === 'none') {
      map.doubleClickZoom.enable()
    }
  }, [editSelectMode, editDrawTool, measureMode, mapDragTool, selectionMode])

  // 退出"选择"时清理高亮
  useEffect(() => {
    if (!editSelectMode) clearSelectHighlight()
  }, [editSelectMode, clearSelectHighlight])

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

    // 定位点标签（captureId 以 location- 开头）直接添加到地图，始终显示，
    // 不依赖"装饰图层"勾选/标签可见性开关
    if (captureId.startsWith('location-')) {
      labelMarker.addTo(map)
    } else if (decorationLabelVisibleRef.current) {
      // 打点标签：根据标签可见性决定是否添加到装饰图层
      if (decorationLayerRef.current) {
        labelMarker.addTo(decorationLayerRef.current)
      } else {
        labelMarker.addTo(map)
      }
    } else {
      // 标签不可见时，只存储引用但不添加到图层
      // 当 setDecorationLabelVisibility(true) 时再添加到图层
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
    // 手形工具：除平移地图外，点击要素弹属性框（所有可见图层，不受"可选"开关限制）。
    // 平移地图结束后 Leaflet 不派发 click，不会误弹框；未命中要素（点击空白区域）时关闭已打开的弹窗。
    // （注意：此分支必须在最前 —— 手形工具下不进入选择/编辑/打点等任何其他点击逻辑）
    if (mapDragToolRef.current && !measureModeRef.current && selectionModeRef.current === 'none' && event.latlng) {
      const hit = handleFeatureLayersAtPoint(
        event.latlng,
        event.originalEvent?.clientX ?? 0,
        event.originalEvent?.clientY ?? 0,
        true,
      )
      if (hit) return
      closeMapPopups()
      return
    }

    // 图层编辑模式：选中/绘制/删点交由 LayerEditSession（其独立监听 map click），
    // 此处直接返回，避免触发要素属性弹窗。
    // 测距/打点例外：与编辑可并存（激活测距/打点时已退出绘制与选择工具），
    // 编辑开关打开时点击地图仍需正常加点，否则打点功能失效。
    if (
      useLayerEditStore.getState().editableLayerId &&
      !measureModeRef.current &&
      !captureModeRef.current
    ) return

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
      // 选中规则（地图工具页）：需"可选"开关打开且激活"选择"工具，点击才能选中装饰图层要素
      marker.on('click', () => {
        if (modeRef.current === 'default') {
          if (!selectModeRef.current) return
          if (selectableMapRef.current?.['decoration-layer'] === false) return
        }
        const labelData = markerLabelsRef.current.get(captureId)
        const currentLabel = labelData?.label || defaultLabel
        const inputId = `capture-label-input-${captureId}`
        const lngInputId = `capture-lng-input-${captureId}`
        const latInputId = `capture-lat-input-${captureId}`
        const inputStyle = `padding:4px 8px;border:1px solid hsl(var(--border));border-radius:4px;font-size:12px;width:100%;color:hsl(var(--foreground));background:hsl(var(--muted));outline:none;font-family:monospace;`
        const inputFocus = `onfocus="this.style.borderColor='#3b82f6';this.style.boxShadow='0 0 0 2px rgba(59,130,246,0.2)'" onblur="this.style.borderColor='hsl(var(--border))';this.style.boxShadow='none'"`
        const deleteBtnText = t('map.delete') || '删除'
        const copyBtnText = t('map.copy') || '复制'
        const confirmBtnText = t('common.confirm') || '确定'
        const propertiesText = t('map.properties') || '属性'
        const labelNameText = t('map.labelName') || '标签'
        const longitudeText = t('map.longitude') || '经度'
        const latitudeText = t('map.latitude') || '纬度'

        const popupContent = `
          <div style="padding:10px 12px;min-width:280px;background:hsl(var(--popover));color:hsl(var(--popover-foreground));border:1px solid hsl(var(--border));border-radius:8px;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);" onclick="event.stopPropagation()">
            <div style="font-size:14px;font-weight:600;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid hsl(var(--border));color:hsl(var(--foreground));">${propertiesText}</div>
            <div style="display:grid;grid-template-columns:50px 1fr;gap:8px 12px;align-items:center;line-height:1.6;">
              <span style="color:hsl(var(--muted-foreground));font-size:11px;">${labelNameText}</span>
              <input id="${inputId}" type="text" value="${currentLabel.replace(/"/g, '&quot;')}"
                style="${inputStyle}" ${inputFocus} />
              <span style="color:hsl(var(--muted-foreground));font-size:11px;">${longitudeText}</span>
              <input id="${lngInputId}" type="text" value="${wgsLng.toFixed(6)}"
                style="${inputStyle}" ${inputFocus} />
              <span style="color:hsl(var(--muted-foreground));font-size:11px;">${latitudeText}</span>
              <input id="${latInputId}" type="text" value="${wgsLat.toFixed(6)}"
                style="${inputStyle}" ${inputFocus} />
            </div>
            <div style="margin-top:10px;padding-top:8px;border-top:1px solid hsl(var(--border));display:flex;justify-content:flex-end;gap:8px;">
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

    // "选择"工具：点击要素仅高亮选中（不弹属性框），双击才弹属性/风格配置
    if (useLayerEditStore.getState().selectMode) {
      if (measureMode || !event.latlng) return
      const hits = collectFeatureHits(event.latlng)
      if (hits.length === 0) {
        clearSelectHighlight()
        closeMapPopups()
        return
      }
      highlightFeature(hits[0])
      return
    }

    // 框选模式下不处理地图点击事件
    if (selectionModeRef.current !== 'none') return

    // 图层要素点击：穿透所有可见图层（地理化数据 + 图层文件）做精确命中检测，
    // 命中即弹属性框/重叠列表 —— 取消图层堆叠优先级，多图层重叠时统一由重叠列表选择。
    // 测量模式下要素已设为不参与命中、点击穿透到地图，此处跳过以保证测量加点。
    // 选中规则（地图工具页）：需激活"选择"工具（图层"可选"开关在 collectFeatureHits 内过滤）
    if (!measureMode && event.latlng && selectModeRef.current) {
      const hitFeature = handleFeatureLayersAtPoint(
        event.latlng,
        event.originalEvent?.clientX ?? 0,
        event.originalEvent?.clientY ?? 0
      )
      if (hitFeature) return
    }

    closeMapPopups()

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
      // 源头去抖：双击时 Leaflet 触发两次 click，第二次 click 与上一次坐标几乎一致。
      // 使用像素距离判断（而非坐标绝对值）：双击两次 click 落在同一像素位置，
      // 但坐标转换可能因鼠标微抖有微小差异，像素距离能可靠识别重复点击
      const lastPt = currentMeasurePoints[currentMeasurePoints.length - 1]
      if (lastPt) {
        const lastPoint = map.latLngToContainerPoint([lastPt.lat, lastPt.lng])
        const newPointPx = map.latLngToContainerPoint([latLng.lat, latLng.lng])
        if (lastPoint.distanceTo(newPointPx) < 8) {
          return // 8 像素内的重复点击（双击第二次 click），丢弃
        }
      }
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
  }, [measureMode, closeMapPopups, captureMode, onCaptureCoord, handleFeatureLayersAtPoint, collectFeatureHits, clearSelectHighlight, highlightFeature])

  /**
   * 处理地图右键事件：阻止浏览器默认右键菜单；测距模式下单击右键结束当前测量
   */
  const handleMapContextMenu = useCallback((event: any) => {
    // 阻止默认右键菜单
    event.originalEvent.preventDefault()
    // 测距模式下：右键单击结束测量（使用模块级共享 ref，避免地图初始化闭包过期）
    if (__sharedMeasureModeRef.current) {
      event.originalEvent.stopPropagation()
      __sharedFinishMeasurementRef.current?.()
    }
  }, [])

  /**
   * 结束当前测距
   */
  const finishMeasurement = useCallback(() => {
    // 时间戳防抖：结束测量后 500ms 内的重复触发（误触/连续右键）忽略，避免生成重复测量结果
    const now = Date.now()
    if (now - measurementFinishTimeRef.current < 500) return
    measurementFinishTimeRef.current = now

    // 使用 ref 获取最新的点数据，避免闭包值过期
    const currentPoints = measurePointsRef.current
    if (!mapInstanceRef.current || currentPoints.length < 2) return

    const L = (window as any).L
    const map = mapInstanceRef.current

    // 复制点数组进行处理（使用 ref 中的最新数据）
    let points = [...currentPoints]

    // 如果最后两个点坐标一致（历史双击结束场景的防御性处理），移除最后一个重复点
    if (points.length >= 2) {
      const p1 = points[points.length - 1]
      const p2 = points[points.length - 2]
      if (p1.lat === p2.lat && p1.lng === p2.lng) {
        points.pop()
        // 同时移除对应的标记和标签（重复点对应一次多余的 click 加点）
        const redundantLabel = measurementMarkersRef.current.pop()
        if (redundantLabel) map.removeLayer(redundantLabel)
        const redundantMarker = measurementMarkersRef.current.pop()
        if (redundantMarker) map.removeLayer(redundantMarker)
        // 移除最后一条含重复点的测量线（它包含重复顶点，否则结束点附近残留轨迹）
        const redundantLine = measurementLinesRef.current.pop()
        if (redundantLine) map.removeLayer(redundantLine)
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

    // 在 deleteButton 上存储本条测量的全部图层引用（轨迹线 + 点/距离标签/总长/删除按钮标记）。
    // 删除时按引用精确移除，只影响本条测量、不波及其他测量。
    // 不能用数组索引范围删除（[start, end) 会连带删掉后续测量）。
    const thisMeasureLine = measurementLinesRef.current[savedLineStartIndex]
    const thisMeasureMarkers = measurementMarkersRef.current.slice(markerStartIndex)
    ;(deleteButton as any)._measureLayers = [...thisMeasureMarkers, thisMeasureLine].filter(Boolean)

    // 使用 Leaflet 的 on('click') 事件系统替代 getElement()?.addEventListener
    // 后者在 DOM 元素未就绪时可能静默失败，导致点击 X 无响应
    deleteButton.on('click', function (this: typeof deleteButton, e: L.LeafletMouseEvent) {
      // 阻止冒泡到地图 click：否则测距模式仍激活时，点击删除按钮会误触发 handleMapClick 添加新测量点
      L.DomEvent.stopPropagation(e)

      // 按引用精确移除本条测量的所有图层，不依赖数组索引（避免连带删除其他测量）
      const layers = ((this as any)._measureLayers as any[]) || []
      layers.forEach(l => { try { map.removeLayer(l) } catch (_) { /* ignore */ } })
      const layerSet = new Set(layers)
      measurementLinesRef.current = measurementLinesRef.current.filter(l => !layerSet.has(l))
      measurementMarkersRef.current = measurementMarkersRef.current.filter(m => !layerSet.has(m))

      // 重置起始索引为当前末尾（下一条新测量追加到末尾）
      measurementLineStartIndexRef.current = measurementLinesRef.current.length
      measurementMarkerStartIndexRef.current = measurementMarkersRef.current.length

      // 清除预览虚线和标签
      if (__sharedShadowLineRef.current) {
        map.removeLayer(__sharedShadowLineRef.current)
        __sharedShadowLineRef.current = null
      }
      if (__sharedShadowLabelRef.current) {
        map.removeLayer(__sharedShadowLabelRef.current)
        __sharedShadowLabelRef.current = null
      }
    })

    // 更新线条起始索引，为下一次测量做准备
    measurementLineStartIndexRef.current = measurementLinesRef.current.length
    // 更新标记起始索引，为下一次测量做准备
    measurementMarkerStartIndexRef.current = measurementMarkersRef.current.length

    // 清除预览线
    if (__sharedShadowLineRef.current) {
      map.removeLayer(__sharedShadowLineRef.current)
      __sharedShadowLineRef.current = null
    }
    if (__sharedShadowLabelRef.current) {
      map.removeLayer(__sharedShadowLabelRef.current)
      __sharedShadowLabelRef.current = null
    }

    setMeasurePoints([])
    measurePointsRef.current = [] // 立即更新组件 ref
    // 立即同步模块级共享 ref：mousemove 监听读取它，若等 useEffect 异步同步，
    // 结束后残留的 mousemove 会用旧点数组重建预览虚线/标签造成残留
    __sharedMeasurePointsRef.current = []
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
    if (__sharedShadowLineRef.current && updatedPoints.length > 0) {
      // 触发一次 mousemove 的逻辑（或者等待下一次 mousemove）
    } else if (__sharedShadowLineRef.current) {
      map.removeLayer(__sharedShadowLineRef.current)
      __sharedShadowLineRef.current = null
      if (__sharedShadowLabelRef.current) {
        map.removeLayer(__sharedShadowLabelRef.current)
        __sharedShadowLabelRef.current = null
      }
    }
  }, [])

  /**
   * 处理全键盘事件，支持 Esc 退出测距/框选，Ctrl+C 复制选中要素，Backspace 删除多边形最后一个点
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (measureModeRef.current) {
        if (e.key === 'Escape' || e.key === 'Delete') {
          // Esc / Delete：清除测量轨迹与打点标记，测量工具不退出（退出需切换其他工具）
          e.preventDefault()
          selfHandleRef.current?.clearMeasurements()
          if (e.key === 'Delete') {
            selfHandleRef.current?.clearCaptureMarkers()
          }
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
          // Esc：仅取消地图当前选中的要素（含编辑会话的圈选高亮），不退出圈选工具
          //（退出圈选只能通过切换到其他工具）
          clearSelectionStateRef.current()
          const session = (mapInstanceRef.current as any)?.__nptEditSession as LayerEditSession | undefined
          session?.clearShapeSelection?.()
          setShapeSelectedCount(0)
          setSelectionTip(t('map.escClearedSelection') || '已取消选中（Esc 不退出圈选，可继续圈选）')
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
          // Ctrl+C：属性文本（粘贴到 Excel）+ 几何要素（工具栏"粘贴"）同时复制
          if (selectedFeaturesRef.current.length > 0) {
            void copySelectionBoth()
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
      if (__sharedShadowLineRef.current) {
        map.removeLayer(__sharedShadowLineRef.current)
        __sharedShadowLineRef.current = null
      }
      if (__sharedShadowLabelRef.current) {
        map.removeLayer(__sharedShadowLabelRef.current)
        __sharedShadowLabelRef.current = null
      }

      // 退出测距模式时：清理未完成的测量痕迹（已点击的点标记/线条但未右键结束）
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
    labelManager?: LabelLayoutManager | null
    labelSourceId?: string
  }) => {
    return new SectorSVGLayer({
      sectors: options.sectors,
      zoom: options.zoom,
      showLabels: options.showLabels,
      labelConfig: options.labelConfig,
      onClick: options.onClick,
      measureMode: options.measureMode || false,
      labelManager: options.labelManager || undefined,
      labelSourceId: options.labelSourceId
    })
  }, [])

  /**
   * 创建扇区图层
   */
  /**
   * 查找数据图层实例（GeoDataLayer 优先，与 setLayerThematicSettings 查找顺序一致）
   */
  const findDataLayerInstance = useCallback((fileId: string): GeoDataLayer | MapInfoLayer | null => {
    const geo = geoDataLayerManagerRef.current?.getLayer(fileId)
    if (geo) return geo
    return mapInfoLayerRefsRef.current.get(fileId)?.mapInfoLayer ?? null
  }, [])

  /**
   * 图层是否处于热力图"替换模式"（热力启用且"显示原图层"关闭）：
   * 此时原图形/标签必须强制隐藏，只保留热力渲染。
   * 所有"按勾选状态恢复原图层可见性"的路径都要经过此判定，
   * 否则兜底显隐会把已隐藏的原图层重新显示出来。
   */
  const isHeatmapReplacement = useCallback((layerId: string): boolean => {
    const hs = useMapStore.getState().mapSettings.heatmapSettingsMap?.[layerId]
    return !!(hs?.enabled && hs.field && !hs.showOriginal)
  }, [])

  /**
   * 应用数据图层热力设置（null/disabled=关闭热力）。
   * 替换模式（enabled && !showOriginal）下移除原图形层（各渲染器 remove 时自动注销标签候选）；
   * 恢复时按用户勾选真值 setVisible。图层尚未异步构建完成时仅保留 store 设置，
   * 由图层加载 effect / replayHeatmapSettings 重放。
   */
  const applyDataLayerHeat = useCallback((fileId: string, settings: HeatmapSettings | null) => {
    const map = mapInstanceRef.current
    if (!map) return
    const manager = getHeatmapManager()
    const enabled = !!(settings?.enabled && settings.field)

    // 用户勾选真值（props 镜像，避免固定闭包读到旧 state）
    const userVisible = [...layerFilesMirrorRef.current, ...pointFilesMirrorRef.current]
      .some(f => f.id === fileId && f.visible)
    // 编辑态图层的原始渲染层由既有 effect 强制隐藏（编辑会话层渲染工作集），不可被此处恢复
    const editing = useLayerEditStore.getState().editableLayerId === fileId
    const suppress = !!(settings?.enabled && settings.field && !settings.showOriginal)

    // 用户取消勾选 → 热力一并移除；勾选且启用 → 取点渲染
    if (userVisible && enabled && settings) {
      const layer = findDataLayerInstance(fileId)
      if (layer) {
        // 取点/渲染异常不得影响后续原图层显隐校正（替换模式必须保证原图形被隐藏）
        try {
          manager.apply(map, fileId, layer.getHeatPoints(settings.field), settings)
        } catch (e) {
          console.error('[OnlineMap] 热力渲染失败:', fileId, e)
        }
      }
    } else {
      manager.remove(fileId)
    }

    // 原图形显隐 = 用户勾选 && 非替换模式 && 非编辑态
    const layer = findDataLayerInstance(fileId)
    if (layer) {
      const desired = userVisible && !suppress && !editing
      if (layer.isVisible() !== desired) {
        layer.setVisible(map, desired)
      }
    }
    manager.bringToFront(fileId)
  }, [findDataLayerInstance])

  /**
   * 应用扇区图层热力设置（lte-sectors / nr-sectors）。
   * 替换模式下直接 removeLayer（onRemove 注销标签候选），恢复时按制式总开关 addTo。
   */
  const applySectorHeat = useCallback((layerId: 'lte-sectors' | 'nr-sectors', settings: HeatmapSettings | null) => {
    const map = mapInstanceRef.current
    const sectorLayer = layerId === 'lte-sectors' ? lteSectorLayerRef.current : nrSectorLayerRef.current
    const manager = getHeatmapManager()
    const enabled = !!(settings?.enabled && settings.field)
    const userVisible = layerId === 'lte-sectors'
      ? layerVisibilityRef.current.lte
      : layerVisibilityRef.current.nr
    const suppress = !!(settings?.enabled && settings.field && !settings.showOriginal)
    // 用户取消制式总开关 → 热力一并移除
    if (map && sectorLayer && userVisible && enabled && settings) {
      try {
        manager.apply(map, layerId, sectorLayer.getHeatPoints(settings.field), settings)
      } catch (e) {
        console.error('[OnlineMap] 扇区热力渲染失败:', layerId, e)
      }
    } else {
      manager.remove(layerId)
    }
    if (map && sectorLayer) {
      const desired = userVisible && !suppress
      const onMap = map.hasLayer(sectorLayer)
      if (desired && !onMap) sectorLayer.addTo(map)
      if (!desired && onMap) map.removeLayer(sectorLayer)
    }
    manager.bringToFront(layerId)
  }, [])

  /**
   * 重放全部已保存且启用的热力设置（地图跨页面缓存复用 / 异步图层构建完成兜底）。
   */
  const replayHeatmaps = useCallback(() => {
    const heat = useMapStore.getState().mapSettings.heatmapSettingsMap ?? {}
    for (const [id, hs] of Object.entries(heat)) {
      if (!hs?.enabled) continue
      if (id === 'lte-sectors' || id === 'nr-sectors') {
        applySectorHeat(id, hs)
      } else {
        applyDataLayerHeat(id, hs)
      }
    }
  }, [applyDataLayerHeat, applySectorHeat])

  // 命令式 handle 闭包固定（[] 依赖），通过 ref 调用最新热力操作（同 getSelectionTargetRef 模式）
  const heatOpsRef = useRef<{ applyDataLayerHeat: typeof applyDataLayerHeat; applySectorHeat: typeof applySectorHeat; replayHeatmaps: typeof replayHeatmaps } | null>(null)
  heatOpsRef.current = { applyDataLayerHeat, applySectorHeat, replayHeatmaps }

  const createSectorLayers = useCallback(() => {
    if (!mapInstanceRef.current) return

    const currentZoom = mapInstanceRef.current.getZoom()

    // 从持久化 store 恢复扇区图层的默认设置（透明度/边框宽度）与专题图层配置
    const applySectorPersistedSettings = (layerId: 'lte-sectors' | 'nr-sectors', layer: SectorSVGLayer) => {
      const ms = useMapStore.getState().mapSettings
      const color = ms.colorSettingsMap?.[layerId]
      if (color) {
        layer.setColorOverrides({ fillOpacity: color.fillOpacity, borderWidth: color.borderWidth })
      }
      const thematic = ms.thematicSettingsMap?.[layerId]
      if (thematic) {
        layer.setThematicOverrides(thematic)
      }
      // 热力图重放（渲染器已持有 sectors，可立即取点；含替换模式图形隐藏）
      const heat = ms.heatmapSettingsMap?.[layerId]
      if (heat?.enabled) {
        applySectorHeat(layerId, heat)
      } else {
        getHeatmapManager().remove(layerId)
      }
    }

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
        measureMode: measureMode,
        labelManager: labelLayoutManagerRef.current,
        labelSourceId: 'sectors-lte'
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

      // 应用持久化的扇区默认设置（透明度/边框宽度）与专题图层配置
      applySectorPersistedSettings('lte-sectors', lteSectorLayerRef.current)
    } else {
      // 该制式未创建（无数据/TAC-check 切到另一制式）：清除可能残留的热力层
      getHeatmapManager().remove('lte-sectors')
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
        measureMode: measureMode,
        labelManager: labelLayoutManagerRef.current,
        labelSourceId: 'sectors-nr'
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

      // 应用持久化的扇区默认设置（透明度/边框宽度）与专题图层配置
      applySectorPersistedSettings('nr-sectors', nrSectorLayerRef.current)
    } else {
      getHeatmapManager().remove('nr-sectors')
    }

    // 重建渲染器后恢复扇区红框高亮（新实例 selectionHighlightIds 为空）：
    // 合并工参搜索定位高亮 + 框选高亮。图层开关/频点/标签等变化触发重建时，
    // 不恢复会导致已圈选/已搜索定位的扇区红框丢失（数据图层独立管理不受影响）。
    const mergedSectorHL = new Set<string>([
      ...(searchSectorHighlightRef.current || []),
      ...selectedIdsRef.current
    ])
    if (mergedSectorHL.size > 0) {
      lteSectorLayerRef.current?.setSelectionHighlight(mergedSectorHL)
      nrSectorLayerRef.current?.setSelectionHighlight(mergedSectorHL)
    }

    // 扇区图层已就绪，重排图层顺序
    reconcileLayerZOrder()
  }, [sectorData, layerVisibility, labelVisibility, sectorLabelVisibility, labelSettingsMap, handleSectorClick, mode, frequencies, createSectorLayer, measureMode, reconcileLayerZOrder, applySectorHeat])

  /**
   * 加载单个MapInfo图层或Excel点图层
   */
  const loadMapInfoLayer = useCallback(async (layerFile: LayerFileOption) => {
    if (!mapInstanceRef.current) return

    console.log('[OnlineMap] loadMapInfoLayer 开始加载:', layerFile.id, layerFile.name, 'sourceType:', layerFile.sourceType, 'visible:', layerFile.visible)

    // 检查是否已存在于 GeoDataLayer 管理器（以实际创建为准，不依赖 geometryType 判断，
    // 避免 geometryType 未定义时取消勾选无法移除 / 重新勾选叠加）
    if (geoDataLayerManagerRef.current) {
      const existingLayer = geoDataLayerManagerRef.current.getLayer(layerFile.id)
      if (existingLayer) {
        // 热力替换模式（显示原图层关闭）下原图形保持隐藏
        const wantVisible = layerFile.visible && !isHeatmapReplacement(layerFile.id)
        console.log('[OnlineMap] GeoDataLayer 已存在，直接更新可见性:', wantVisible)
        existingLayer.setVisible(mapInstanceRef.current, wantVisible)
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
      // 该 GeoJSON 对应的版本指纹（缓存命中时沿用缓存值，重新拉取时取响应 ETag）
      let fetchedVersion: string | null = useMapDataCacheStore.getState().layers[layerFile.id]?.version ?? null

      if (layerFile.sourceType === 'excel') {
        console.log('[OnlineMap] 从Excel加载点数据, dataId:', layerFile.dataId)
        // 🔧 优先复用预取缓存（loadMapInfoLayers 挂载时已并发预取），避免 3 并发 worker 串行等待网络
        const cachedExcel = prefetchedExcelDataRef.current.get(layerFile.id)
        const response = cachedExcel !== undefined
          ? { success: true, data: cachedExcel }
          : await dataApi.get(layerFile.dataId)
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
                zoom: mapInstanceRef.current?.getZoom() || 12
              })

              console.log('[OnlineMap] ✅ addLayer 返回成功:', geoLayer)
              loadedMapInfoLayersRef.current.add(layerFile.id)
              // 注册到模块级数据图层集合（页面切换清理兜底）
              __mapDataLayerInstances.add(geoLayer)

              // 同步标签可见性状态
              const labelVisible = pointFileLabelVisibilityRef.current[layerFile.id] || false
              console.log('[OnlineMap] 同步 GeoDataLayer 标签可见性:', layerFile.id, labelVisible)
              geoLayer.setLabelVisibility(labelVisible)

              // 🔧 重新应用已保存的颜色设置（否则刷新/切换页面后图层会回到默认色）
              const savedColor = useMapStore.getState().mapSettings.colorSettingsMap?.[layerFile.id]
              if (savedColor) {
                geoLayer.setStyleOverrides(savedColor)
              }

              // 🔧 重新应用已保存的专题图层设置（必须在基础色之后，专题优先）
              const savedThematic = useMapStore.getState().mapSettings.thematicSettingsMap?.[layerFile.id]
              if (savedThematic?.enabled) {
                geoLayer.setThematicOverrides(savedThematic)
              }

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
        // 优先使用缓存的后端已转换 GeoJSON（懒加载时已 prefetch）
        const cachedGeojson = useMapDataCacheStore.getState().layers[layerFile.id]?.geojson
        if (cachedGeojson) {
          geojsonData = cachedGeojson as GeoJSON.FeatureCollection
          console.log('[OnlineMap] 使用缓存的MapInfo数据, layerId:', layerFile.id, '要素数:', geojsonData.features?.length)
        } else {
          console.log('[OnlineMap] 从MapInfo文件加载图层, dataId:', layerFile.dataId)
          const fetched = await layerApi.getLayerDataWithVersion(layerFile.dataId, layerFile.id)
          fetchedVersion = fetched.version
          console.log('[OnlineMap] MapInfo API响应: 有数据:', !!fetched.data)
          if (fetched.data) {
            geojsonData = fetched.data as GeoJSON.FeatureCollection
          } else {
            // 数据不存在或加载失败，跳过此图层
            console.log('[OnlineMap] 图层数据不存在，跳过:', layerFile.id, layerFile.name)
            return
          }
        }
      }

      if (geojsonData) {
        // 缓存后端已转换 GeoJSON（含版本指纹），避免下次重复拉取（仅 MapInfo 源）
        if (layerFile.sourceType !== 'excel') {
          useMapDataCacheStore.getState().cacheLayerGeoJSON(layerFile.id, geojsonData, fetchedVersion)
        }

        // 创建图层选项
        const options: MapInfoLayerOptions = {
          id: layerFile.id,
          name: layerFile.name,
          type: layerFile.type as LayerGeometryType,
          data: geojsonData,
          dataId: layerFile.dataId,
          visible: layerFile.visible,
          labelManager: labelLayoutManagerRef.current || __sharedMapCache.labelManager || undefined
        }

        // 创建 Map Info 图层
        console.log('[OnlineMap] 开始创建MapInfoLayer, options:', { id: options.id, name: options.name, type: options.type })
        const mapInfoLayer = await MapInfoLayer.fromGeoJSON(options)
        const leafletLayer = mapInfoLayer.getLeafletLayer()
        console.log('[OnlineMap] MapInfoLayer创建完成, leafletLayer存在:', !!leafletLayer)

        if (leafletLayer) {
          // 🔧 过期守卫：页面已卸载（跨页竞态）时，旧实例不得挂到共享地图，直接清理自身
          if (unmountedRef.current) {
            console.warn('[OnlineMap] 组件已卸载，跳过已过期图层构建:', layerFile.id)
            try {
              const fallbackMap = mapInstanceRef.current || __sharedMapCache.map
              if (fallbackMap) mapInfoLayer.remove(fallbackMap)
            } catch (e) { /* ignore */ }
            return
          }

          // 🔧 去重：移除共享地图上同 id 的残留旧实例（跨挂载竞态/历史缓存产生的孤儿实例，
          // 其标签 canvas 会残留导致"关闭标签后仍显示"）
          for (const inst of __mapDataLayerInstances) {
            if (inst instanceof MapInfoLayer && inst.getId() === layerFile.id) {
              try {
                if (mapInstanceRef.current) inst.remove(mapInstanceRef.current)
              } catch (e) { /* ignore */ }
              __mapDataLayerInstances.delete(inst)
            }
          }

          // 防御：若该 id 已有旧 MapInfoLayer 仍在地图上，先移除，避免重复加载叠加
          const oldRef = mapInfoLayerRefsRef.current.get(layerFile.id)
          if (oldRef && mapInstanceRef.current && mapInstanceRef.current.hasLayer(oldRef.leafletLayer)) {
            console.log('[OnlineMap] 存在同 id 旧 MapInfoLayer，先移除:', layerFile.id)
            oldRef.mapInfoLayer.remove(mapInstanceRef.current)
          }

          // 存储图层实例和 Leaflet 图层以便控制
          mapInfoLayerRefsRef.current.set(layerFile.id, { mapInfoLayer, leafletLayer })
          loadedMapInfoLayersRef.current.add(layerFile.id)
          // 注册到模块级数据图层集合（页面切换清理兜底）
          __mapDataLayerInstances.add(mapInfoLayer)
          // 测距模式下新加载的工参图层同步测距状态（要素点击穿透到地图，测量可正常加点）
          mapInfoLayer.setMeasureMode(measureModeRef.current)
          console.log('[OnlineMap] 图层已存储到refs, loaded状态:', loadedMapInfoLayersRef.current.has(layerFile.id))

          // 同步标签：先应用已保存的标签配置，再开启可见性（避免首次开启时
          // 触发自动挑选默认标签字段、随后被保存配置覆盖的闪烁）
          const labelVisible = pointFileLabelVisibilityRef.current[layerFile.id] || false
          if (labelSettingsMap[layerFile.id]) {
            mapInfoLayer.setLabelConfig(labelSettingsMap[layerFile.id])
          }
          mapInfoLayer.setLabelVisibility(labelVisible)

          // 🔧 重新应用已保存的颜色设置（否则刷新/切换页面后图层会回到默认色）
          const savedColor = useMapStore.getState().mapSettings.colorSettingsMap?.[layerFile.id]
          if (savedColor) {
            mapInfoLayer.setStyleOverrides(savedColor)
          }

          // 🔧 重新应用已保存的专题图层设置（必须在基础色之后，专题优先）
          const savedThematic = useMapStore.getState().mapSettings.thematicSettingsMap?.[layerFile.id]
          if (savedThematic?.enabled) {
            mapInfoLayer.setThematicOverrides(savedThematic)
          }

          // 热力替换模式（启用热力且关闭"显示原图层"）下原图形保持隐藏
          const wantVisible = layerFile.visible && !isHeatmapReplacement(layerFile.id)
          console.log('[OnlineMap] Layer created:', layerFile.id, 'visible:', wantVisible)

          // 根据初始可见性决定是否添加到地图
          if (wantVisible && mapInstanceRef.current) {
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
  }, [pointFileLabelVisibility, labelSettingsMap, isHeatmapReplacement])

  /**
   * 懒加载：只拉取 MapInfo 图层数据并缓存，不构建图层
   */
  const prefetchLayerData = useCallback(async (layerFile: LayerFileOption) => {
    // Excel 数据：预取到内存 ref，构建阶段直接复用，避免 3 并发 worker 串行等待网络
    if (layerFile.sourceType === 'excel') {
      if (prefetchedExcelDataRef.current.has(layerFile.id)) return
      try {
        const response = await dataApi.get(layerFile.dataId)
        if (response.success && response.data) {
          prefetchedExcelDataRef.current.set(layerFile.id, response.data)
        }
      } catch (error) {
        console.error('[OnlineMap] 预取 Excel 数据失败:', layerFile.id, error)
      }
      return
    }

    // MapInfo 图层：已缓存则跳过
    if (useMapDataCacheStore.getState().layers[layerFile.id]?.geojson) return

    try {
      const { data, version } = await layerApi.getLayerDataWithVersion(layerFile.dataId, layerFile.id)
      if (data) {
        useMapDataCacheStore.getState().cacheLayerGeoJSON(layerFile.id, data, version)
      }
    } catch (error) {
      console.error('[OnlineMap] 预取图层数据失败:', layerFile.id, error)
    }
  }, [])

  /**
   * 图层加载开始/结束（计数器支持并发，全部完成才隐藏转圈）
   */
  const beginLayerLoad = useCallback(() => {
    layerLoadCountRef.current++
    setLayerLoading(true)
  }, [])

  const endLayerLoad = useCallback(() => {
    layerLoadCountRef.current = Math.max(0, layerLoadCountRef.current - 1)
    if (layerLoadCountRef.current === 0) {
      setLayerLoading(false)
    }
  }, [])

  /**
   * 加载所有MapInfo图层（懒加载：先并发预取数据，再构建已勾选图层）
   */
  const loadMapInfoLayers = useCallback(async () => {
    if (!mapInfoLayerManagerRef.current || !mapInstanceRef.current) return

    const allFiles = [...layerFiles, ...pointFiles]
    const visibleFiles = allFiles.filter(f => f.visible)

    // 无可见图层需要加载时，不显示加载转圈
    if (visibleFiles.length === 0) return

    beginLayerLoad()
    try {
      console.log('[OnlineMap] 加载图层数据（懒加载，不阻塞主线程）:', allFiles.length)

      // 只预取已勾选的图层：不可见图层等用户勾选时再懒加载，
      // 避免首屏对几十个图层发起请求（尤其是大图层，首次解析 +20s 会阻塞勾选渲染）
      console.log('[OnlineMap] 预取已勾选图层数量:', visibleFiles.length)

      // 🔧 流水线化：每个 worker 内 "预取数据 → 立即构建"，勾选图层数据一到就出图，
      // 不再"先全部预取再构建"（避免单图层被其他图层的预取拖后）
      // 已加载图层由 loadedMapInfoLayersRef / geoDataLayerManager.getLayer 守卫，不会重复构建
      const CONCURRENCY = 4
      let buildIdx = 0
      const worker = async () => {
        while (buildIdx < visibleFiles.length) {
          const layerFile = visibleFiles[buildIdx++]
          try {
            await prefetchLayerData(layerFile)   // 数据先到（网络/缓存）
            await loadMapInfoLayer(layerFile)     // 立即构建
          } catch (e) {
            console.error('[OnlineMap] 加载图层失败:', layerFile.id, e)
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, visibleFiles.length) }, () => worker())
      )

      // 所有异步构建完成后按面板顺序重排一次：
      // 新构建的图层 addTo 时按 DOM 自然顺序置顶，可能与类内拖拽顺序不一致
      reconcileLayerZOrder()
    } finally {
      endLayerLoad()
    }
  }, [layerFiles, pointFiles, loadMapInfoLayer, prefetchLayerData, beginLayerLoad, endLayerLoad, reconcileLayerZOrder])

  // ============ 未勾选图层空闲静默预加载（仅地图工具页）============
  // 勾选图层加载完成后，利用浏览器空闲时段（requestIdleCallback）顺序预取未勾选图层的**数据**（只拉不构建），
  // 用户勾选时缓存命中 → 仅剩构建，秒级出图。PCI/Neighbor/TAC 页不传 layerFiles/pointFiles，天然隔离；
  // 卸载时取消，不抢占其他功能页资源。
  const idlePrefetchStateRef = useRef<{
    handle: number | null
    inFlight: number
    cancelled: boolean
  }>({ handle: null, inFlight: 0, cancelled: false })

  const scheduleIdlePrefetch = useCallback(() => {
    const state = idlePrefetchStateRef.current
    if (state.handle !== null) return  // 已有排程
    if (state.cancelled) return

    // 收集未勾选且未缓存的图层；容量控制：只预取前 MAX 个（全仓大 GeoJSON 可能上百 MB，避免全量进内存）
    const allFiles = [...layerFiles, ...pointFiles]
    const unchecked = allFiles.filter(f => !f.visible)
    const targets = unchecked.filter(f => {
      if (f.sourceType === 'excel') return !prefetchedExcelDataRef.current.has(f.id)
      return !useMapDataCacheStore.getState().layers[f.id]?.geojson
    })
    const MAX_IDLE_PREFETCH = 5
    const limited = targets.slice(0, MAX_IDLE_PREFETCH)
    if (limited.length === 0) return

    let idx = 0
    const runStep = () => {
      if (state.cancelled) return
      while (idx < limited.length && state.inFlight < 2) {  // 并发上限 2
        const file = limited[idx++]
        state.inFlight++
        prefetchLayerData(file).finally(() => {
          state.inFlight--
          if (state.cancelled) return
          if (idx >= limited.length && state.inFlight === 0) {
            state.handle = null
            return
          }
          if (typeof requestIdleCallback === 'function') {
            state.handle = requestIdleCallback(runStep, { timeout: 3000 })
          } else {
            runStep()
          }
        })
      }
    }
    if (typeof requestIdleCallback === 'function') {
      state.handle = requestIdleCallback(runStep, { timeout: 3000 })
    } else {
      runStep()  // 降级：直接按序预取
    }
  }, [layerFiles, pointFiles, prefetchLayerData])

  // 图层列表变化后调度空闲预取（延迟到勾选图层加载基本完成，避免抢占其网络）；卸载时取消
  useEffect(() => {
    if (!mapInstanceRef.current) return
    const state = idlePrefetchStateRef.current
    state.cancelled = false
    const t = window.setTimeout(() => {
      scheduleIdlePrefetch()
    }, 1500)
    return () => {
      window.clearTimeout(t)
      state.cancelled = true
      if (state.handle !== null && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(state.handle)
        state.handle = null
      }
    }
  }, [scheduleIdlePrefetch])

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

          // 兜底：清理上次挂载残留的数据图层（若上次卸载清理失败，图层仍挂在缓存地图上）
          if (__mapDataLayerInstances.size > 0) {
            console.log('[OnlineMap] 清理上次挂载残留的数据图层:', __mapDataLayerInstances.size)
            __mapDataLayerInstances.forEach(layer => {
              try { layer.remove(cached.map) } catch (e) { /* ignore */ }
            })
            __mapDataLayerInstances.clear()
          }

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

          // 共享标签布局引擎：复用缓存实例；不存在则创建（随缓存地图存活）
          if (!cached.labelManager) {
            cached.labelManager = new LabelLayoutManager()
            cached.labelManager.addTo(cached.map)
          }
          labelLayoutManagerRef.current = cached.labelManager

          // 重新初始化各管理器（注入共享标签引擎）
          if (!mapInfoLayerManagerRef.current) {
            const manager = new MapInfoLayerManager()
            manager.setMap(cached.map, cached.labelManager)
            mapInfoLayerManagerRef.current = manager
          }
          if (!geoDataLayerManagerRef.current) {
            const geoManager = new GeoDataLayerManager()
            geoManager.init(cached.map, cached.labelManager)
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
              if (__sharedShadowLineRef.current) {
                __sharedShadowLineRef.current.setLatLngs([[lastPoint.lat, lastPoint.lng], [mouseLatLng.lat, mouseLatLng.lng]])
              } else {
                __sharedShadowLineRef.current = L.polyline(
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

              if (__sharedShadowLabelRef.current) {
                __sharedShadowLabelRef.current.setLatLng(mouseLatLng)
                __sharedShadowLabelRef.current.setIcon(L.divIcon({
                  html: labelContent,
                  className: 'measure-label-shadow',
                  iconSize: [0, 0],
                  iconAnchor: [-5, 10]
                }))
              } else {
                __sharedShadowLabelRef.current = L.marker(mouseLatLng, {
                  icon: L.divIcon({
                    html: labelContent,
                    className: 'measure-label-shadow',
                    iconSize: [0, 0],
                    iconAnchor: [-5, 10]
                  }),
                  pane: 'measurement'
                }).addTo(map)
              }
            } else {
              // 测距模式但无测量点（测量刚结束/点已清空）：清除可能残留的预览虚线和标签
              if (__sharedShadowLineRef.current) {
                map.removeLayer(__sharedShadowLineRef.current)
                __sharedShadowLineRef.current = null
              }
              if (__sharedShadowLabelRef.current) {
                map.removeLayer(__sharedShadowLabelRef.current)
                __sharedShadowLabelRef.current = null
              }
            }
          } else {
            map.getContainer().style.cursor = 'default'
          }
        })

        // 测距结束由地图右键事件（contextmenu → handleMapContextMenu）触发

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

        // 共享标签布局引擎（单 Canvas 统一防重叠，LTE/NR/地理化图层全局生效）
        const labelManager = new LabelLayoutManager()
        labelManager.addTo(map)
        labelLayoutManagerRef.current = labelManager

        tileLayerRef.current = tileLayer
        mapInstanceRef.current = map

        // 立即挂载图层编辑会话：节点自动捕获（S 键/十字光标）不依赖"编辑"开关，
        // 对所有打开的可见图层生效；编辑相关能力仍由 editableLayerId 驱动
        getEditSession()

        // 保存地图实例到共享缓存（后续页面切换可复用）
        __sharedMapCache = {
          map: map,
          tileLayer: tileLayer,
          leafletContainer: leafletContainer,
          mapLayerType: savedState.mapLayerType,
          labelManager
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

        // 初始化MapInfo图层管理器（注入共享标签引擎）
        if (!mapInfoLayerManagerRef.current) {
          const manager = new MapInfoLayerManager()
          manager.setMap(map, labelManager)
          mapInfoLayerManagerRef.current = manager
        }

        // 初始化地理化数据图层管理器（注入共享标签引擎）
        if (!geoDataLayerManagerRef.current) {
          const geoManager = new GeoDataLayerManager()
          geoManager.init(map, labelManager)
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
      // 🔧 标记组件已卸载：阻止仍在飞行的异步图层构建（loadMapInfoLayer）
      // 把图层挂到复用后的共享地图上（跨页竞态产生的孤儿实例/标签）
      unmountedRef.current = true
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
        // 热力 canvas 绑定当前地图实例，随地图清理一并移除（重放由各图层 effect 完成）
        heatmapManagerRef.current?.removeAll(map)

        // 兜底：确保所有数据图层实例从地图移除（即使 manager.clear 有遗漏/抛错）
        __mapDataLayerInstances.forEach(layer => {
          try { layer.remove(map) } catch (e) { /* ignore */ }
        })
        __mapDataLayerInstances.clear()

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
        if (__sharedShadowLineRef.current) {
          try { map.removeLayer(__sharedShadowLineRef.current) } catch (e) { /* ignore */ }
          __sharedShadowLineRef.current = null
        }
        if (__sharedShadowLabelRef.current) {
          try { map.removeLayer(__sharedShadowLabelRef.current) } catch (e) { /* ignore */ }
          __sharedShadowLabelRef.current = null
        }
        measurementLineStartIndexRef.current = 0
        measurementMarkerStartIndexRef.current = 0
        // 清除搜索标记
        searchMarkerRef.current.forEach(marker => {
          try { map.removeLayer(marker) } catch (e) { /* ignore */ }
        })
        searchMarkerRef.current = []

        // 5. 清理框选图形（圆形/多边形/矩形框选、拖拽预览），避免跨页面残留且切回后无法清除
        ;[selectionShapeRef, selectionRectRef, polygonTempLayerRef, dragPreviewRectRef, dragPreviewCircleRef].forEach(ref => {
          try { if (ref.current) map.removeLayer(ref.current) } catch (e) { /* ignore */ }
          ref.current = null
        })
        selectionStartPointRef.current = null
        selectionPointsRef.current = []
        selectionDrawingRef.current = false
        pointModeIsDragging.current = false

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
          // 标签布局引擎随缓存地图保留（其 canvas 挂在 overlayPane，随容器缓存）
          __sharedMapCache = {
            map: map,
            tileLayer: tileLayer,
            leafletContainer: leafletContainer,
            mapLayerType: mapLayerType,
            labelManager: __sharedMapCache.labelManager
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

  /**
   * 地图容器尺寸变化时同步 Leaflet 尺寸（invalidateSize）。
   *
   * Leaflet 只在 window resize 时自动失效尺寸；容器因页面布局变化而改变尺寸时不会感知：
   * 进入地图页 3 秒后侧边栏自动折叠、全屏切换、窗口缩放等都会让容器变宽/变窄，
   * 而 Leaflet 缓存的尺寸偏小 → 像素包围盒只覆盖旧区域，
   * 表现为拖拽后新露出的右侧/下侧区域不加载瓦片、出现"留白"。
   */
  useEffect(() => {
    const container = mapRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const invalidate = () => {
      if (timer) clearTimeout(timer)
      // 防抖：侧边栏折叠是 CSS 过渡动画，避免动画过程中反复重算导致地图抖动
      timer = setTimeout(() => {
        timer = null
        const map = mapInstanceRef.current
        if (!map) return
        try {
          map.invalidateSize()
        } catch (e) {
          console.warn('[OnlineMap] invalidateSize 失败:', e)
        }
      }, 180)
    }
    const observer = new ResizeObserver(invalidate)
    observer.observe(container)
    // 初始化/复用完成后立即校正一次（首帧容器尺寸可能与地图初始化时不同）
    invalidate()
    return () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
    }
  }, [isMapInitialized])

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
        // 拖拽规则：仅手形工具可拖动地图（测距态不再额外放开拖拽）
        map.doubleClickZoom.disable() // 测距模式下禁用双击缩放（结束测量改用右键，避免双击误加点/缩放）

        // 通知扇区图层进入测距模式，禁用扇区点击
        if (lteSectorLayerRef.current) {
          lteSectorLayerRef.current.setMeasureMode(true)
        }
        if (nrSectorLayerRef.current) {
          nrSectorLayerRef.current.setMeasureMode(true)
        }

        // 通知地理化数据图层/工参 GeoJSON 图层进入测距模式：
        // 否则大面积面状要素的 click stopPropagation 会吞掉地图 click，测量无法加点
        geoDataLayerManagerRef.current?.setMeasureMode(true)
        mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
          mapInfoLayer.setMeasureMode(true)
        })
      } else {
        // 非测距模式：恢复默认光标（mapDragTool 为 true 时由单独 useEffect 的 CSS class 接管）
        map.getContainer().style.cursor = ''
        // 拖拽规则由手形工具统一管理，此处不再放开
        map.doubleClickZoom.enable()

        // 通知扇区图层退出测距模式，恢复扇区点击
        if (lteSectorLayerRef.current) {
          lteSectorLayerRef.current.setMeasureMode(false)
        }
        if (nrSectorLayerRef.current) {
          nrSectorLayerRef.current.setMeasureMode(false)
        }

        // 通知地理化数据图层/工参 GeoJSON 图层退出测距模式，恢复要素点击
        geoDataLayerManagerRef.current?.setMeasureMode(false)
        mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
          mapInfoLayer.setMeasureMode(false)
        })
      }
    }
  }, [measureMode, mapDragTool])

  // 图层编辑会话激活期间：基站扇区禁用点击/悬停交互（pointer-events 穿透），
  // 否则扇区要素的 click stopPropagation 会吞掉地图 click —— 编辑图层上绘制点线面时
  // 落在扇区上的点击全部丢失（"无法绘制"），扇区属性面板也会在编辑时误弹出。
  useEffect(() => {
    const active = !!editableLayerId
    if (lteSectorLayerRef.current) lteSectorLayerRef.current.setEditSessionMode(active)
    if (nrSectorLayerRef.current) nrSectorLayerRef.current.setEditSessionMode(active)
  }, [editableLayerId])

  /**
   * 监听地图拖拽工具状态
   * 激活时：始终保持手型光标（CSS !important 覆盖 Leaflet 内部光标管理），禁用双击缩放，只允许拖拽地图
   * 同时禁用所有图层交互（悬停提示、点击事件等）
   */  useEffect(() => {
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
        // 拖拽规则：仅手形工具可拖动地图 —— 关闭手形工具后恢复禁拖（applyDraggingPolicy 统一处理）
        map.dragging.disable()
        if (!measureMode) {
          map.doubleClickZoom.enable()
        }

        // 恢复扇区图层的悬停提示和点击交互
        if (lteSectorLayerRef.current) lteSectorLayerRef.current.updateSelectionMode(false)
        if (nrSectorLayerRef.current) nrSectorLayerRef.current.updateSelectionMode(false)

        // 恢复 MapInfoLayer / GeoDataLayer 的点击交互
        // 测距模式下由测距 effect 的 setMeasureMode 接管穿透，不在此恢复
        // （GeoDataLayer.setInteractive(true) 会全量重渲染，须避免测距期间误触发）
        if (!measureMode) {
          mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
            mapInfoLayer.setInteractive(true)
          })

          // 恢复 GeoDataLayer 的点击交互
          if (geoDataLayerManagerRef.current) {
            geoDataLayerManagerRef.current.setInteractive(true)
          }
        }
      }
    }
  }, [mapDragTool, measureMode])

  // ===== 地图拖拽规则：仅"手形"工具激活时才允许拖动地图 =====
  // 地图工具页（default 模式）默认禁拖：默认态/选择/圈选/测距/打点/编辑均不可拖动地图；
  // 其他页面（PCI/邻区/TAC）无手形工具，保持可拖动不受影响。
  // 依赖覆盖全部工具态：任何工具切换后都重新套用规则，
  // 避免某处遗留的 dragging.enable() 在非手形工具状态下让地图可平移。
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !isMapInitialized) return
    if (modeRef.current !== 'default') {
      map.dragging.enable()
      return
    }
    if (mapDragToolRef.current) map.dragging.enable()
    else map.dragging.disable()
  }, [
    mapDragTool, mode, isMapInitialized,
    measureMode, captureMode, selectionMode,
    editableLayerId, editSelectMode, editDrawTool,
  ])

  // 手形工具激活状态同步到编辑会话：手形工具激活时禁用"按住要素拖动移位"（拖动地图优先）
  useEffect(() => {
    const session = (mapInstanceRef.current as any)?.__nptEditSession as LayerEditSession | undefined
    if (session) session.isPanToolActive = mapDragTool
  }, [mapDragTool, isMapInitialized])

  // 进入图层编辑时清除"选择"工具留下的要素高亮（否则删除要素后 nptSelectPane 高亮残留，
  // 表现为"删除第一个图形后还残留相同的图形"）
  useEffect(() => {
    if (editableLayerId) clearSelectHighlight()
  }, [editableLayerId, clearSelectHighlight])

  /**
   * 框选功能辅助函数
   */

  /**
   * 清除选中状态和高亮
   */
  const clearSelectionState = useCallback(() => {
    selectedFeaturesRef.current = []
    selectedIdsRef.current = new Set()
    setSelectedFeatureCount(0)
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
  // 供定义在本函数之前的键盘事件 effect 使用（ref 转发，避免 TDZ）
  const clearSelectionStateRef = useRef(clearSelectionState)
  clearSelectionStateRef.current = clearSelectionState

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
    // 圈选目标：z-order 最高且"可选"开关打开的唯一图层；无目标则不收集任何要素
    const target = getSelectionTargetRef.current()

    // 收集点击位置的所有要素
    const clickedFeatures: Array<{ id: string, props: any, layerType: string }> = []

    // 1. 遍历所有MapInfoLayer（仅圈选目标图层收集）
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      if (target?.kind !== 'mapinfo' || (mapInfoLayer as any).id !== target.layerId) return
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
          // 优先用构建时分配的稳定选择 ID（_nptSelectionId，含「图层ID#序号」兜底），
          // 否则回退到属性字段提取；与 getFeaturesInCircle/InPolygon 返回的 id 保持一致
          const id = (layer as any)._nptSelectionId || extractFeatureId(props)
          if (id) {
            clickedFeatures.push({ id: String(id), props: { ...props, _layerType: 'MapInfo' }, layerType: 'MapInfo' })
          }
        }
      })
    })

    // 2. 遍历 GeoDataLayer（仅圈选目标图层收集）
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
        if (target?.kind !== 'geodata' || geoLayer.getId() !== target.layerId) return
        if (!geoLayer.isVisible()) return
        const features = geoLayer.getFeaturesInCircle(latLng, 30)
        features.forEach(item => {
          const id = item.name || item.properties?.id || ''
          if (id) {
            clickedFeatures.push({ id: String(id), props: { ...item.properties, _layerType: 'GeoData', _geoDataName: item.name }, layerType: 'GeoData' })
          }
        })
      })
    }

    // 3. 遍历扇区图层 (LTE/NR) - 仅圈选目标制式收集
    if (target?.kind === 'sector' && target.networkType === 'lte' && visibility.lte && lteSectorLayerRef.current) {
      let sectorsAtPoint: RenderSectorData[] = []
      if (clientX !== undefined && clientY !== undefined) {
        sectorsAtPoint = lteSectorLayerRef.current.getSectorsAt(clientX, clientY)
      }
      sectorsAtPoint.forEach(sector => {
        clickedFeatures.push({ id: String(sector.id), props: { ...sector, _layerType: 'LTE' }, layerType: 'LTE' })
      })
    }

    if (target?.kind === 'sector' && target.networkType === 'nr' && visibility.nr && nrSectorLayerRef.current) {
      let sectorsAtPoint: RenderSectorData[] = []
      if (clientX !== undefined && clientY !== undefined) {
        sectorsAtPoint = nrSectorLayerRef.current.getSectorsAt(clientX, clientY)
      }
      sectorsAtPoint.forEach(sector => {
        clickedFeatures.push({ id: String(sector.id), props: { ...sector, _layerType: 'NR' }, layerType: 'NR' })
      })
    }

    // 4. 遍历抓取坐标点（仅装饰图层为圈选目标时收集）
    captureMarkersRef.current.forEach(marker => {
      if (target?.kind !== 'decoration') return
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
            const pid = extractFeatureId(p)
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
            const pid = extractFeatureId(p)
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
    setSelectedFeatureCount(selectedIds.size)

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
    // 圈选目标：z-order 最高且"可选"开关打开的唯一图层；无目标则不收集任何要素
    const target = getSelectionTargetRef.current()

    const newIds = new Set<string>()
    const newProperties: any[] = []

    // 1. 遍历所有MapInfoLayer（仅圈选目标图层收集）
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      if (target?.kind !== 'mapinfo' || (mapInfoLayer as any).id !== target.layerId) return
      // 检查图层是否可见
      const isVisible = mapInfoLayer.isVisible()
      console.log('[OnlineMap] 圆形框选检查MapInfo图层:', {
        id: (mapInfoLayer as any).id,
        name: (mapInfoLayer as any).name,
        isVisible
      })
      if (!isVisible) return

      // 使用MapInfoLayer的getFeaturesInCircle方法（返回 { id, properties }）
      const features = mapInfoLayer.getFeaturesInCircle(center, radius)
      console.log('[OnlineMap] MapInfo图层返回的要素数量:', features.length)

      // 收集要素ID和属性
      features.forEach(item => {
        const id = item.id
        console.log('[OnlineMap] 处理要素:', { id, properties: item.properties })
        if (id) {
          newIds.add(String(id))
          newProperties.push({ ...item.properties, _layerType: 'MapInfo', _geometry: (item as any).geometry })
        }
      })
    })

    // 2. 遍历 GeoDataLayer（仅圈选目标图层收集）
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
        if (target?.kind !== 'geodata' || geoLayer.getId() !== target.layerId) return
        if (!geoLayer.isVisible()) return
        const features = geoLayer.getFeaturesInCircle(center, radius)
        features.forEach(item => {
          const id = item.name || item.properties?.id || ''
          if (id) {
            newIds.add(String(id))
            newProperties.push({ ...item.properties, _layerType: 'GeoData', _geoDataName: item.name, _geometry: (item as any).geometry })
            console.log('[OnlineMap] 圆形框选选中GeoData要素:', item.name || id)
          }
        })
      })
    }

    // 3. 遍历扇区图层 (LTE/NR) - 仅圈选目标制式收集
    if (target?.kind === 'sector' && target.networkType === 'lte' && visibility.lte && lteSectorLayerRef.current) {
      const sectorsInCircle = lteSectorLayerRef.current.getSectorsInCircle(center, radius)
      sectorsInCircle.forEach(sector => {
        const id = String(sector.id)
        newIds.add(id)
        newProperties.push({ ...sector, _layerType: 'LTE' })
        console.log('[OnlineMap] 圆形框选选中LTE扇区:', sector.name, sector.id)
      })
    }

    if (target?.kind === 'sector' && target.networkType === 'nr' && visibility.nr && nrSectorLayerRef.current) {
      const sectorsInCircle = nrSectorLayerRef.current.getSectorsInCircle(center, radius)
      sectorsInCircle.forEach(sector => {
        const id = String(sector.id)
        newIds.add(id)
        newProperties.push({ ...sector, _layerType: 'NR' })
        console.log('[OnlineMap] 圆形框选选中NR扇区:', sector.name, sector.id)
      })
    }

    // 4. 遍历抓取坐标点（仅装饰图层为圈选目标时收集）
    captureMarkersRef.current.forEach(marker => {
      if (target?.kind !== 'decoration') return
      if (!mapInstanceRef.current || !mapInstanceRef.current.hasLayer(marker)) return
      const markerLatLng = marker.getLatLng()
      if (markerLatLng && center.distanceTo(markerLatLng) <= radius) {
        const props = (marker as any).captureProperties
        if (props) {
          newIds.add(props.id)
          newProperties.push({ ...props, _geometry: { type: 'Point', coordinates: [markerLatLng.lng, markerLatLng.lat] } })
        }
      }
    })

    // 5. 遍历定位标记点（仅装饰图层为圈选目标时收集）
    locationMarkersRef.current.forEach(marker => {
      if (target?.kind !== 'decoration') return
      if (!mapInstanceRef.current || !mapInstanceRef.current.hasLayer(marker)) return
      const markerLatLng = marker.getLatLng()
      if (markerLatLng && center.distanceTo(markerLatLng) <= radius) {
        const props = (marker as any).captureProperties
        if (props) {
          newIds.add(props.id)
          newProperties.push({ ...props, _geometry: { type: 'Point', coordinates: [markerLatLng.lng, markerLatLng.lat] } })
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
            const pid = extractFeatureId(p)
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
    setSelectedFeatureCount(selectedIds.size)

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
    // 圈选目标：z-order 最高且"可选"开关打开的唯一图层；无目标则不收集任何要素
    const target = getSelectionTargetRef.current()

    const newIds = new Set<string>()
    const newProperties: any[] = []

    if (points.length < 3) {
      console.warn('[OnlineMap] 多边形至少需要3个点')
      return { ids: newIds, properties: newProperties }
    }

    // 创建临时多边形对象用于查询
    const polygon = L.polygon(points.map(p => [p.lat, p.lng]))

    // 1. 遍历所有MapInfoLayer（仅圈选目标图层收集）
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      if (target?.kind !== 'mapinfo' || (mapInfoLayer as any).id !== target.layerId) return
      // 检查图层是否可见
      if (!mapInfoLayer.isVisible()) return

      // 使用MapInfoLayer的getFeaturesInPolygon方法（返回 { id, properties }）
      const features = mapInfoLayer.getFeaturesInPolygon(polygon)

      // 收集要素ID和属性
      features.forEach(item => {
        const id = item.id
        if (id) {
          newIds.add(String(id))
          newProperties.push({ ...item.properties, _layerType: 'MapInfo', _geometry: (item as any).geometry })
        }
      })
    })

    // 2. 遍历 GeoDataLayer（仅圈选目标图层收集）
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
        if (target?.kind !== 'geodata' || geoLayer.getId() !== target.layerId) return
        if (!geoLayer.isVisible()) return
        const features = geoLayer.getFeaturesInPolygon(polygon)
        features.forEach(item => {
          const id = item.name || item.properties?.id || ''
          if (id) {
            newIds.add(String(id))
            newProperties.push({ ...item.properties, _layerType: 'GeoData', _geoDataName: item.name, _geometry: (item as any).geometry })
            console.log('[OnlineMap] 多边形框选选中GeoData要素:', item.name || id)
          }
        })
      })
    }

    // 3. 遍历扇区图层 (LTE/NR) - 仅圈选目标制式收集
    if (target?.kind === 'sector' && target.networkType === 'lte' && visibility.lte && lteSectorLayerRef.current) {
      const sectorsInPolygon = lteSectorLayerRef.current.getSectorsInPolygon(polygon)
      sectorsInPolygon.forEach(sector => {
        const id = String(sector.id)
        newIds.add(id)
        newProperties.push({ ...sector, _layerType: 'LTE' })
        console.log('[OnlineMap] 多边形框选选中LTE扇区:', sector.name, sector.id)
      })
    }

    if (target?.kind === 'sector' && target.networkType === 'nr' && visibility.nr && nrSectorLayerRef.current) {
      const sectorsInPolygon = nrSectorLayerRef.current.getSectorsInPolygon(polygon)
      sectorsInPolygon.forEach(sector => {
        const id = String(sector.id)
        newIds.add(id)
        newProperties.push({ ...sector, _layerType: 'NR' })
        console.log('[OnlineMap] 多边形框选选中NR扇区:', sector.name, sector.id)
      })
    }

    // 4. 遍历抓取坐标点（仅装饰图层为圈选目标时收集）
    captureMarkersRef.current.forEach(marker => {
      if (target?.kind !== 'decoration') return
      if (!mapInstanceRef.current || !mapInstanceRef.current.hasLayer(marker)) return
      const markerLatLng = marker.getLatLng()
      if (markerLatLng) {
        // 使用 Leaflet 的 getBounds().contains() 检查点是否在多边形内
        const isInside = polygon.getBounds().contains(markerLatLng)
        if (isInside) {
          const props = (marker as any).captureProperties
          if (props) {
            newIds.add(props.id)
            newProperties.push({ ...props, _geometry: { type: 'Point', coordinates: [markerLatLng.lng, markerLatLng.lat] } })
          }
        }
      }
    })

    // 5. 遍历定位标记点（仅装饰图层为圈选目标时收集）
    locationMarkersRef.current.forEach(marker => {
      if (target?.kind !== 'decoration') return
      if (!mapInstanceRef.current || !mapInstanceRef.current.hasLayer(marker)) return
      const markerLatLng = marker.getLatLng()
      if (markerLatLng) {
        // 使用 Leaflet 的 getBounds().contains() 检查点是否在多边形内
        const isInside = polygon.getBounds().contains(markerLatLng)
        if (isInside) {
          const props = (marker as any).captureProperties
          if (props) {
            newIds.add(props.id)
            newProperties.push({ ...props, _geometry: { type: 'Point', coordinates: [markerLatLng.lng, markerLatLng.lat] } })
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
            const pid = extractFeatureId(p)
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
    setSelectedFeatureCount(selectedIds.size)

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
    // 圈选目标：z-order 最高且"可选"开关打开的唯一图层；无目标则不收集任何要素
    const target = getSelectionTargetRef.current()

    // 多选模式下从已有选中开始，否则重置
    const newIds = new Set<string>()
    const newProperties: any[] = []

    const polygon = L.polygon(points.map(p => [p.lat, p.lng]))

    // 1. 遍历所有 MapInfoLayer（仅圈选目标图层收集）
    mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
      if (target?.kind !== 'mapinfo' || (mapInfoLayer as any).id !== target.layerId) return
      const isVisible = mapInfoLayer.isVisible()
      console.log('[OnlineMap] 矩形框选检查MapInfo图层:', {
        id: (mapInfoLayer as any).id,
        name: (mapInfoLayer as any).name,
        isVisible
      })
      if (!isVisible) return
      const features = mapInfoLayer.getFeaturesInPolygon(polygon)
      console.log('[OnlineMap] MapInfo图层矩形框选返回要素数量:', features.length)
      features.forEach(item => {
        const id = item.id
        if (id) {
          newIds.add(String(id))
          newProperties.push({ ...item.properties, _layerType: 'MapInfo', _geometry: (item as any).geometry })
          console.log('[OnlineMap] 矩形框选选中MapInfo要素:', item.properties?.name || id)
        }
      })
    })

    // 2. 遍历 GeoDataLayer（仅圈选目标图层收集）
    if (geoDataLayerManagerRef.current) {
      geoDataLayerManagerRef.current.getAllLayers().forEach(geoLayer => {
        if (target?.kind !== 'geodata' || geoLayer.getId() !== target.layerId) return
        if (!geoLayer.isVisible()) return
        try {
          const features = geoLayer.getFeaturesInPolygon(polygon)
          console.log('[OnlineMap] GeoDataLayer矩形框选返回要素数量:', features.length)
          features.forEach(item => {
            const id = item.name || item.properties?.id || ''
            if (id) {
              newIds.add(String(id))
              newProperties.push({ ...item.properties, _layerType: 'GeoData', _geoDataName: item.name, _geometry: (item as any).geometry })
              console.log('[OnlineMap] 矩形框选选中GeoData要素:', item.name || id)
            }
          })
        } catch (e) {
          console.error('[OnlineMap] GeoDataLayer矩形框选失败:', e)
        }
      })
    }

    // 3. 扇区图层 (LTE/NR) - 仅圈选目标制式收集
    if (target?.kind === 'sector' && target.networkType === 'lte' && visibility.lte && lteSectorLayerRef.current) {
      const sectorsIn = lteSectorLayerRef.current.getSectorsInPolygon(polygon)
      sectorsIn.forEach(sector => {
        newIds.add(String(sector.id))
        newProperties.push({ ...sector, _layerType: 'LTE' })
      })
    }
    if (target?.kind === 'sector' && target.networkType === 'nr' && visibility.nr && nrSectorLayerRef.current) {
      const sectorsIn = nrSectorLayerRef.current.getSectorsInPolygon(polygon)
      sectorsIn.forEach(sector => {
        newIds.add(String(sector.id))
        newProperties.push({ ...sector, _layerType: 'NR' })
      })
    }

    // 4. 抓取坐标点（仅装饰图层为圈选目标时收集）
    captureMarkersRef.current.forEach(marker => {
      if (target?.kind !== 'decoration') return
      if (!mapInstanceRef.current || !mapInstanceRef.current.hasLayer(marker)) return
      const markerLatLng = marker.getLatLng()
      if (markerLatLng) {
        // 使用 Leaflet 的 getBounds().contains() 检查点是否在多边形内
        const isInside = polygon.getBounds().contains(markerLatLng)
        if (isInside) {
          const props = (marker as any).captureProperties
          if (props) {
            newIds.add(props.id)
            newProperties.push({ ...props, _geometry: { type: 'Point', coordinates: [markerLatLng.lng, markerLatLng.lat] } })
          }
        }
      }
    })

    // 5. 遍历定位标记点（仅装饰图层为圈选目标时收集）
    locationMarkersRef.current.forEach(marker => {
      if (target?.kind !== 'decoration') return
      if (!mapInstanceRef.current || !mapInstanceRef.current.hasLayer(marker)) return
      const markerLatLng = marker.getLatLng()
      if (markerLatLng) {
        // 使用 Leaflet 的 getBounds().contains() 检查点是否在多边形内
        const isInside = polygon.getBounds().contains(markerLatLng)
        if (isInside) {
          const props = (marker as any).captureProperties
          if (props) {
            newIds.add(props.id)
            newProperties.push({ ...props, _geometry: { type: 'Point', coordinates: [markerLatLng.lng, markerLatLng.lat] } })
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
            const pid = extractFeatureId(p)
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
    setSelectedFeatureCount(selectedIds.size)

    if (selectedIds.size > 0) {
      setSelectionTip(`${t('map.featuresSelected', { count: selectedIds.size })}，${t('map.copyTip') || '按 Ctrl+C 复制'}`)
    } else {
      setSelectionTip(t('map.noFeatureSelected'))
    }

    return { ids: selectedIds, properties: selectedProperties }
  }, [])

  /**
   * 将选中要素属性转为二维表（首行表头），复制与导出 Excel 共用
   * @param properties 属性列表
   */
  const featuresToAoa = (properties: any[]): string[][] => {
    if (!properties || properties.length === 0) return []

    // 提取所有唯一的键作为表头 (排除内部私有字段和不必要的坐标字段)
    const excludeKeys = new Set(['displayLat', 'displayLng', '_layerType', '_geometry', 'geometry', 'id_type', 'layerId', 'properties', 'attributes', '_geoDataName'])
    const allKeys = new Set<string>()
    properties.forEach(p => {
      Object.keys(p).forEach(key => {
        // 排除内部私有字段（_ 前缀）和不必要的坐标字段
        if (key.startsWith('_') || excludeKeys.has(key)) return
        allKeys.add(key)
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
      })
    })

    return [header, ...rows]
  }

  /**
   * 将选中的要素属性格式化为 Tab 分隔的文本，用于粘贴到 Excel
   * @param properties 属性列表
   */
  const formatFeaturesToExcelText = (properties: any[]) => {
    return featuresToAoa(properties).map(row => row.join('\t')).join('\n')
  }

  /**
   * 将选中要素导出为 Excel 文件（.xlsx）并触发浏览器下载
   * @param properties 属性列表
   */
  const exportSelectionToExcel = (properties: any[]) => {
    const aoa = featuresToAoa(properties)
    if (aoa.length === 0) return
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, t('map.selectedFeatures') || '选中要素')
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    XLSX.writeFile(wb, `${t('map.selectedFeatures') || '选中要素'}_${stamp}.xlsx`)
    console.log('[OnlineMap] 选中要素已导出 Excel，数量:', properties.length)
  }

  /**
   * 复制选中要素到剪贴板并提示
   */
  /**
   * 写入系统剪贴板（供粘贴到 Excel/文本）。navigator.clipboard 在非安全上下文
   * （http 访问）、无权限或文档失焦时会失败，故降级到隐藏 textarea + execCommand。
   */
  const writeTextToClipboard = async (text: string): Promise<boolean> => {
    if (!text) return false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {
      /* 降级到 execCommand */
    }
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.top = '0'
      ta.style.left = '0'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }

  /**
   * 复制选中要素属性文本到系统剪贴板（可直接粘贴到 Excel）
   * @returns 是否复制成功
   */
  const copySelectionToClipboard = async (properties: any[]): Promise<boolean> => {
    const excelText = formatFeaturesToExcelText(properties)
    if (!excelText) return false
    const ok = await writeTextToClipboard(excelText)
    if (ok) {
      console.log('[OnlineMap] 选中要素属性已复制到系统剪贴板，数量:', properties.length)
    } else {
      console.error('[OnlineMap] 复制到系统剪贴板失败，数量:', properties.length)
    }
    return ok
  }

/**
 * 基站扇区（RenderSectorData）没有 GeoJSON 几何，只有经纬度。
 * 圈选复制时按渲染坐标（displayLat/displayLng，GCJ02）合成点几何 —— 与地图其他
 * 复制来源同一坐标系，保存时后端统一转 WGS84。
 */
function sectorPointGeometry(f: any): { type: 'Point'; coordinates: [number, number] } | null {
  if (!f) return null
  const num = (v: any): number | null => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
    return Number.isFinite(n) ? n : null
  }
  const lat = num(f.displayLat) ?? num(f.lat) ?? num(f.latitude) ?? num(f.纬度)
  const lng = num(f.displayLng) ?? num(f.lng) ?? num(f.longitude) ?? num(f.经度)
  if (lat === null || lng === null) return null
  return { type: 'Point', coordinates: [lng, lat] }
}

/**
 * 复制圈选要素（含几何+完整属性）到图层编辑剪贴板，供粘贴到其他打开编辑开关的 TAB 图层
 */
  const copyFeaturesForPaste = useCallback(() => {
    const items = (selectedFeaturesRef.current as any[])
      .map((f) => {
        const { _geometry, _layerType, _geoDataName, _nptSelectionId, ...props } = f
        // 基站扇区圈选结果只有经纬度、无 GeoJSON 几何（{...sector, _layerType}）：
        // 按渲染坐标合成点几何，保证"复制→粘贴"与其他图层行为一致
        const geom = _geometry || sectorPointGeometry(f)
        if (!geom) return null
        // 净化属性：去掉内部字段，非标量（如扇区 attributes 嵌套对象）转字符串，
        // 保证粘贴后的要素可正常写入 TAB 属性表。
        // 例外：_editStyle/_shape/_ellipse 是编辑要素的样式/形态元数据（保存管线消费），
        // 原样保留（对象不字符串化），否则粘贴后丢失配色与圆形态
        const EDIT_META_KEYS = new Set(['_editStyle', '_shape', '_ellipse'])
        const cleanProps: Record<string, any> = {}
        for (const [k, v] of Object.entries(props || {})) {
          if (v === undefined || typeof v === 'function') continue
          if (k.startsWith('_') && !EDIT_META_KEYS.has(k)) continue
          const isMeta = EDIT_META_KEYS.has(k)
          cleanProps[k] = (!isMeta && v !== null && typeof v === 'object') ? JSON.stringify(v) : v
        }
        return { geometry: geom, properties: cleanProps, sourceLayerName: _geoDataName }
      })
      .filter(Boolean) as any[]
    if (items.length === 0) {
      setSelectionTip(t('map.copyNoGeometry') || '当前选中要素不支持复制（无几何信息）')
      return
    }
    useLayerEditStore.getState().copyToClipboard(items)
    setSelectionTip(
      t('map.copiedHint', { count: items.length })
        || `已复制 ${items.length} 个要素：打开目标图层"编辑"开关后点击工具栏"粘贴"`,
    )
    console.log('[OnlineMap] 圈选要素已复制到编辑剪贴板:', items.length)
  }, [t])

  /**
   * 底部"复制"按钮 / Ctrl+C：同时
   * ① 写系统剪贴板（属性文本，可直接粘贴到 Excel）
   * ② 写图层编辑剪贴板（含几何，供工具栏"粘贴"到可编辑图层）
   * 两者互不影响；任一项失败不影响另一项。
   * 注意：必须定义在 copyFeaturesForPaste 之后（useCallback 依赖数组立即求值）。
   */
  const copySelectionBoth = useCallback(async () => {
    const props = selectedFeaturesRef.current as any[]
    if (props.length === 0) return
    // 先写系统剪贴板（借用户手势/激活态，越早越好）
    const textOk = await copySelectionToClipboard(props)
    // 再写编辑剪贴板（内部会写入提示文案，这里在其后补充 Excel 提示）
    copyFeaturesForPaste()
    if (textOk) {
      setSelectionTip(
        (prev: string) => (prev ? `${prev}；${t('map.copiedExcelHint') || '属性文本已复制，可直接粘贴到 Excel'}` : prev),
      )
    }
  }, [copyFeaturesForPaste, copySelectionToClipboard, t])

  /**
   * 编辑模式下圈选：把编辑会话工作集中与形状相交的要素复制到剪贴板（含几何+完整属性），
   * 并在编辑层上高亮。可随后打开其他 TAB 图层的"编辑"开关点击"粘贴"。
   */
  const copyEditSessionInShape = useCallback((shape: any) => {
    if (!shape) return
    if (!useLayerEditStore.getState().editableLayerId) return
    const session = (mapInstanceRef.current as any)?.__nptEditSession as LayerEditSession | undefined
    if (!session || !session.isEditing()) return
    const items = session.selectInShape(shape)
    if (items.length === 0) return
    useLayerEditStore.getState().copyToClipboard(items)
    // 同步到底部提示条的数据源：让"复制"/"导出 Excel"按钮与"删除"按钮一并显示
    // 保留完整属性（含 _editStyle/_shape/_ellipse 等内部键，保证复制→粘贴后样式/圆形态不丢），
    // 内部键不会进入 Excel 表（featuresToAoa 排除 _ 前缀键）
    selectedFeaturesRef.current = items.map(it => ({
      ...it.properties,
      _geometry: it.geometry,
      _geoDataName: it.sourceLayerName,
    }))
    setSelectedFeatureCount(items.length)
    setShapeSelectedCount(items.length)
    setSelectionTip(
      t('map.copiedHint', { count: items.length })
        || `已复制 ${items.length} 个要素：打开目标图层"编辑"开关后点击工具栏"粘贴"`,
    )
    console.log('[OnlineMap] 编辑态圈选已复制到剪贴板:', items.length)
  }, [t])

  /**
   * 删除编辑态圈选选中的要素（底部提示条"删除"按钮，Delete/Backspace 同效）
   */
  const deleteShapeSelectedFeatures = useCallback(() => {
    const session = (mapInstanceRef.current as any)?.__nptEditSession as LayerEditSession | undefined
    if (!session || !session.isEditing()) return
    const n = session.deleteShapeSelected()
    setShapeSelectedCount(0)
    // 同步复位底部提示条"复制/导出"按钮的数据源
    selectedFeaturesRef.current = []
    setSelectedFeatureCount(0)
    setSelectionTip(
      n > 0
        ? (t('map.shapeDeleted', { count: n }) || `已删除 ${n} 个圈选要素（Ctrl+Z 可撤销）`)
        : (t('map.escClearedSelection') || '已取消选中'),
    )
  }, [t])

  /**
   * 监听圈选模式变化 - 控制地图拖拽和交互
   */
  useEffect(() => {
    const isSelectionActive = selectionMode !== 'none'
    if (lteSectorLayerRef.current) lteSectorLayerRef.current.updateSelectionMode(isSelectionActive)
    if (nrSectorLayerRef.current) nrSectorLayerRef.current.updateSelectionMode(isSelectionActive)

    // 框选模式下禁用 MapInfoLayer 和 GeoDataLayer 的点击交互（避免属性框弹出）
    // 测距模式下由测距 effect 的 setMeasureMode 接管穿透，此处跳过，
    // 避免 setInteractive(true) 全量重渲染地理化图层并重置要素穿透状态
    if (!measureMode) {
      mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }) => {
        mapInfoLayer.setInteractive(!isSelectionActive)
      })
      if (geoDataLayerManagerRef.current) {
        geoDataLayerManagerRef.current.setInteractive(!isSelectionActive)
      }
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
          setSelectionTip('点击添加多边形顶点，至少3个点后可移近起点单击闭合（或双击闭合），按 Backspace 删除上一个点，按 Ctrl+C 复制')
        }
        // 进入框选模式时，重置临时标志（不清除已有选中）
        preserveSelectionRef.current = false
      } else if (!measureMode) {
        // 退出框选模式时，恢复地图交互
        // 注意：选中状态和图形的清除逻辑在另一个useEffect中处理
        // 拖拽规则：仅"手形"工具可拖动地图 —— 此处不得 enable（否则退出圈选后无需手形即可平移）
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
        // 多边形模式：先检查鼠标是否靠近起点（吸附闭合）
        const SNAP_THRESHOLD_PX = 15
        if (selectionPointsRef.current.length >= 3) {
          const firstPt = selectionPointsRef.current[0]
          const mousePt = map.latLngToContainerPoint(latLng)
          const startPt = map.latLngToContainerPoint(firstPt)
          const distToStart = mousePt.distanceTo(startPt)
          
          if (distToStart < SNAP_THRESHOLD_PX) {
            // 靠近起点，单击闭合多边形
            hideSnapIndicator()
            clearPolygonTempLine()
            const isMultiSelect = e.originalEvent.shiftKey
            
            if (!isMultiSelect && selectionShapeRef.current) {
              map.removeLayer(selectionShapeRef.current)
              selectionShapeRef.current = null
            }
            
            selectFeaturesInPolygon(selectionPointsRef.current, isMultiSelect)

            // 编辑模式：把编辑会话工作集中与多边形相交的要素复制到剪贴板
            copyEditSessionInShape(window.L.polygon(selectionPointsRef.current as any) as any)

            const Lx = window.L
            const newPoly = Lx.polygon(selectionPointsRef.current, {
              color: '#00ffff', weight: 2, fillColor: '#00ffff', fillOpacity: 0.1,
              interactive: false
            }).addTo(map)
            
            if (isMultiSelect && selectionShapeRef.current) {
              if (selectionShapeRef.current instanceof Lx.FeatureGroup) {
                selectionShapeRef.current.addLayer(newPoly)
              } else {
                const fg = Lx.featureGroup([selectionShapeRef.current, newPoly])
                fg.addTo(map)
                selectionShapeRef.current = fg as any
              }
            } else {
              selectionShapeRef.current = newPoly
            }
            
            selectionPointsRef.current = []
            setSelectionTip('多边形已闭合，可继续绘制下一个（Shift+单击起点叠加）或按 Ctrl+C 复制')
            L.DomEvent.stopPropagation(e)
            L.DomEvent.preventDefault(e)
            return
          }
        }
        
        // 不靠近起点：正常添加顶点
        selectionPointsRef.current.push(latLng)
        clearPolygonTempLine()
        
        // 绘制临时线段
        const Lx = window.L
        if (selectionPointsRef.current.length >= 1) {
          const pts = selectionPointsRef.current.map(p => [p.lat, p.lng])
          if (pts.length >= 2) {
            polygonTempLayerRef.current = Lx.polyline(pts as L.LatLngExpression[], {
              color: '#00ffff',
              weight: 2,
              dashArray: '5, 5'
            }).addTo(map)
          }
        }
        
        // 更新提示信息：显示当前顶点数，并提示靠近起点闭合
        const count = selectionPointsRef.current.length
        if (count >= 3) {
          setSelectionTip(`已添加 ${count} 个顶点，将鼠标移到起点附近单击闭合`)
        } else {
          setSelectionTip(`已添加 ${count} 个顶点（至少需要 3 个），点击继续添加顶点`)
        }
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
        
        const Lx = window.L
        const points = selectionPointsRef.current.map(p => [p.lat, p.lng])
        
        // 检查鼠标是否靠近起点（>=3个点时启用吸附）
        let isNearStart = false
        if (selectionPointsRef.current.length >= 3) {
          const firstPt = selectionPointsRef.current[0]
          const mousePt = map.latLngToContainerPoint(latLng)
          const startPt = map.latLngToContainerPoint(firstPt)
          isNearStart = mousePt.distanceTo(startPt) < 15
        }
        
        if (isNearStart) {
          // 靠近起点：显示闭合预览（实线 + 起点高亮）
          const closedPoints = [...points, [selectionPointsRef.current[0].lat, selectionPointsRef.current[0].lng]]
          polygonTempLayerRef.current = Lx.polyline(closedPoints as L.LatLngExpression[], {
            color: '#00ffff',
            weight: 3,
            dashArray: null  // 实线表示闭合
          }).addTo(map)
          
          // 起点吸附指示器
          if (!snapIndicatorRef.current) {
            snapIndicatorRef.current = Lx.circleMarker(selectionPointsRef.current[0], {
              radius: 10,
              color: '#00ffff',
              weight: 3,
              fillColor: '#00ffff',
              fillOpacity: 0.3,
              interactive: false
            }).addTo(map)
          } else {
            snapIndicatorRef.current.setLatLng(selectionPointsRef.current[0])
            if (!map.hasLayer(snapIndicatorRef.current)) {
              map.addLayer(snapIndicatorRef.current)
            }
          }
          map.getContainer().style.cursor = 'pointer'
        } else {
          // 不靠近起点：虚线预览到鼠标位置
          points.push([latLng.lat, latLng.lng]) // 添加鼠标当前位置
          polygonTempLayerRef.current = Lx.polyline(points as L.LatLngExpression[], {
            color: '#00ffff',
            weight: 2,
            dashArray: '5, 5'
          }).addTo(map)
          
          // 隐藏吸附指示器
          if (snapIndicatorRef.current) {
            map.removeLayer(snapIndicatorRef.current)
          }
          map.getContainer().style.cursor = ''
        }
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

            // 编辑模式：把编辑会话工作集中与矩形相交的要素复制到剪贴板（可粘贴到其他图层）
            copyEditSessionInShape(L.rectangle(bounds) as any)

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
        // 拖拽规则：仅手形工具可拖动地图（圈选手势后不放开拖拽）
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

          // 编辑模式：把编辑会话工作集中与圆相交的要素复制到剪贴板
          copyEditSessionInShape(window.L.circle(startPoint, { radius }) as any)

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
        // 拖拽规则：仅手形工具可拖动地图（圈选手势后不放开拖拽）
      }
      L.DomEvent.stopPropagation(e)
    }

    // 处理双击完成多边形绘制（备用方案，主用起点吸附闭合）
    const handleDoubleClick = (e: L.LeafletMouseEvent) => {
      if (selectionModeRef.current !== 'polygon') return
      
      // 如果有足够的顶点，直接闭合多边形
      if (selectionPointsRef.current.length >= 3) {
        hideSnapIndicator()
        clearPolygonTempLine()
        const isMultiSelect = e.originalEvent.shiftKey
        
        if (!isMultiSelect && selectionShapeRef.current) {
          map.removeLayer(selectionShapeRef.current)
          selectionShapeRef.current = null
        }
        
        selectFeaturesInPolygon(selectionPointsRef.current, isMultiSelect)

        // 编辑模式：把编辑会话工作集中与多边形相交的要素复制到剪贴板
        copyEditSessionInShape(window.L.polygon(selectionPointsRef.current as any) as any)

        const Lx = window.L
        const newPolygon = Lx.polygon(selectionPointsRef.current, {
          color: '#00ffff', weight: 2, fillColor: '#00ffff', fillOpacity: 0.1,
          interactive: false
        }).addTo(map)
        
        if (isMultiSelect && selectionShapeRef.current) {
          if (selectionShapeRef.current instanceof Lx.FeatureGroup) {
            selectionShapeRef.current.addLayer(newPolygon)
          } else {
            const featureGroup = Lx.featureGroup([selectionShapeRef.current, newPolygon])
            featureGroup.addTo(map)
            selectionShapeRef.current = featureGroup as any
          }
        } else {
          selectionShapeRef.current = newPolygon
        }
        
        selectionPointsRef.current = []
        setSelectionTip('多边形已闭合，可继续绘制下一个（Shift+双击叠加）或按 Ctrl+C 复制')
      } else {
        setSelectionTip(`多边形至少需要 3 个顶点，当前只有 ${selectionPointsRef.current.length} 个，请继续点击添加`)
      }
      L.DomEvent.stopPropagation(e)
      L.DomEvent.preventDefault(e)
    }
    // 隐藏多边形起点吸附指示器
    const hideSnapIndicator = () => {
      if (snapIndicatorRef.current) {
        try { map.removeLayer(snapIndicatorRef.current) } catch(e) {/* ignore */}
        snapIndicatorRef.current = null
      }
      map.getContainer().style.cursor = ''
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
      if (snapIndicatorRef.current) {
        map.removeLayer(snapIndicatorRef.current)
        snapIndicatorRef.current = null
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
      // 拖拽规则：仅手形工具可拖动地图（切换模式时由手形工具 effect 统一管理）
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
      for (const [id, ref] of mapInfoLayerRefsRef.current.entries()) {
        if (!currentLayerIds.has(id)) {
          // 🔧 用 mapInfoLayer.remove() 而非裸 removeLayer：确保标签 canvas 一并清理
          if (mapInstanceRef.current && ref.mapInfoLayer) {
            try {
              ref.mapInfoLayer.remove(mapInstanceRef.current);
            } catch (e) { /* ignore */ }
          }
          mapInfoLayerRefsRef.current.delete(id);
          loadedMapInfoLayersRef.current.delete(id);
          // 同步移除该图层热力渲染
          getHeatmapManager().remove(id);
        }
      }

      // GeoDataLayer 不经过上面的 MapInfo 映射：按文件列表兜底清理已卸载图层的热力层
      // （扇区图层 id 除外，其生命周期由 createSectorLayers 管理）
      for (const heatId of getHeatmapManager().getLayerIds()) {
        if (heatId !== 'lte-sectors' && heatId !== 'nr-sectors' && !currentLayerIds.has(heatId)) {
          getHeatmapManager().remove(heatId)
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

        // 处理 GeoDataLayer 可见性：以管理器实际是否持有为准（不依赖 geometryType 判断，
        // 否则 geometryType 未定义的图层取消勾选无法移除、重新勾选会叠加）
        const geoLayer = geoDataLayerManagerRef.current?.getLayer(layerFile.id)
        if (geoLayer) {
          // 热力替换模式：原图形必须保持隐藏（只留热力渲染）
          const wantVisible = layerFile.visible && !isHeatmapReplacement(layerFile.id)
          console.log('[OnlineMap] GeoDataLayer 可见性:', layerFile.id, layerFile.name, 'visible:', wantVisible)
          try {
            geoLayer.setVisible(mapInstanceRef.current, wantVisible)
            // 勾选图层复选框时，按当前标签开关状态同步标签（保证立即显示，无需再点开关）
            if (wantVisible && pointFileLabelVisibility[layerFile.id]) {
              geoLayer.setLabelVisibility(true)
            } else if (pointFileLabelVisibility[layerFile.id] === false) {
              // 🔧 兜底：开关明确关闭时主动移除标签（防异步构建残留/状态不同步）
              geoLayer.setLabelVisibility(false)
            }
          } catch (error) {
            console.error('[OnlineMap] ❌ geoLayer.setVisible 出错:', error)
          }
          continue
        }

        // 处理 MapInfoLayer
        const layerRef = mapInfoLayerRefsRef.current.get(layerFile.id);
        console.log('[OnlineMap] 处理图层:', layerFile.id, layerFile.name, 'visible:', layerFile.visible, 'layerRef存在:', !!layerRef)

        if (layerRef && mapInstanceRef.current) {
          const hasLayer = mapInstanceRef.current.hasLayer(layerRef.leafletLayer)
          console.log('[OnlineMap]   - hasLayer检查结果:', hasLayer, 'leafletLayer存在:', !!layerRef.leafletLayer)

          // 图层处于编辑态时隐藏原始渲染层：编辑会话层已渲染工作集全部要素，
          // 否则删除的要素仍会由原始图层显示，出现"删了但图上还在"的残留。
          // 热力替换模式下同理必须保持隐藏（原图形由热力图替代）。
          if (layerFile.visible && layerFile.id !== editableLayerId && !isHeatmapReplacement(layerFile.id)) {
            // 使用 MapInfoLayer 的 addTo 方法而不是直接添加 Leaflet 图层
            // 这样可以正确设置 currentMap 引用，使标签功能能够工作
            if (!hasLayer) {
              console.log('[OnlineMap]   - 添加图层到地图')
              layerRef.mapInfoLayer.addTo(mapInstanceRef.current)
            } else {
              console.log('[OnlineMap]   - 图层已在地图上，跳过')
            }
            // 勾选图层复选框时，按当前标签开关状态同步标签（保证立即显示，无需再点开关）
            if (pointFileLabelVisibility[layerFile.id]) {
              layerRef.mapInfoLayer.setLabelVisibility(true)
            } else if (pointFileLabelVisibility[layerFile.id] === false) {
              // 🔧 兜底：开关明确关闭时主动移除标签（防异步构建残留/状态不同步）
              layerRef.mapInfoLayer.setLabelVisibility(false)
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

      // ===== 兜底同步：确保地图实际显示与勾选状态一致（处理任何状态不同步/残留）=====
      // 遍历管理器中的全部图层，按当前文件列表的 visible 强制校正，
      // 避免"取消勾选后旧内容残留"或"页面切换后状态不同步"。
      const mapForSync = mapInstanceRef.current
      if (mapForSync) {
        const fileMap = new Map(allFiles.map(f => [f.id, f]))
        // GeoDataLayer
        geoDataLayerManagerRef.current?.getAllLayers().forEach(layer => {
          const file = fileMap.get(layer.getId())
          // 热力替换模式：原图形保持隐藏
          const shouldShow = !!file?.visible && !isHeatmapReplacement(layer.getId())
          if (layer.isVisible() !== shouldShow) {
            console.log('[OnlineMap] 兜底同步 GeoDataLayer 可见性:', layer.getId(), '->', shouldShow)
            try {
              layer.setVisible(mapForSync, shouldShow)
            } catch (error) {
              console.error('[OnlineMap] 兜底同步 GeoDataLayer 出错:', layer.getId(), error)
            }
          }
        })
        // MapInfoLayer
        mapInfoLayerRefsRef.current.forEach(({ mapInfoLayer }, id) => {
          const file = fileMap.get(id)
          // 热力替换模式：原图形保持隐藏
          const shouldShow = !!file?.visible && id !== editableLayerId && !isHeatmapReplacement(id)
          if (mapInfoLayer.isVisible() !== shouldShow) {
            console.log('[OnlineMap] 兜底同步 MapInfoLayer 可见性:', id, '->', shouldShow)
            try {
              mapInfoLayer.setVisible(mapForSync, shouldShow)
            } catch (error) {
              console.error('[OnlineMap] 兜底同步 MapInfoLayer 出错:', id, error)
            }
          }
        })
      }

      // "选择"工具高亮残留清理：高亮绘制在独立 nptSelectPane，不随源图层隐藏而消失。
      // 图层被关闭（visible=false）或移除（不在 allFiles）后，若高亮要素来自该图层则一并清除。
      const highlightLayerId = selectHighlightLayerIdRef.current
      if (highlightLayerId && !allFiles.some(f => f.id === highlightLayerId && f.visible)) {
        clearSelectHighlight()
      }

      // ===== 编辑态标签联动 =====
      // 打开"编辑"开关后原图层隐藏（remove 会清标签），改从编辑工作集注册标签候选
      //（同 sourceId），保证"标签开关打开后打开编辑开关"标签不消失；
      // 退出编辑/切换编辑图层时恢复从全量数据注册。
      const prevEditableId = prevEditableLabelRef.current
      prevEditableLabelRef.current = editableLayerId
      const applyEditLabels = (id: string | null, editing: boolean) => {
        if (!id) return
        const ref = mapInfoLayerRefsRef.current.get(id)
        if (!ref) return
        const file = allFiles.find(f => f.id === id)
        const ws = editing ? useLayerEditStore.getState().getWorkspace(id) : null
        ref.mapInfoLayer.setEditLabelSource(editing && file?.visible && ws ? ws.features : null)
      }
      if (prevEditableId && prevEditableId !== editableLayerId) applyEditLabels(prevEditableId, false)
      applyEditLabels(editableLayerId, true)

      // 图层加载就绪后重排一次，确保初始点击命中正确目标
      reconcileLayerZOrder()

      // 热力图重放：图层可能刚在此 effect 中异步构建完成，按 store 设置取点渲染，
      // 并同步替换模式下的原图形隐藏（applyDataLayerHeat 内部幂等校正显隐）。
      // 注意不看 layerFile.visible：用户取消勾选时也要走到 remove 分支清除热力 canvas。
      const heatSettingsMap = useMapStore.getState().mapSettings.heatmapSettingsMap ?? {}
      for (const layerFile of allFiles) {
        const hs = heatSettingsMap[layerFile.id]
        if (hs?.enabled) {
          applyDataLayerHeat(layerFile.id, hs)
        }
      }

      // 图层增删/显隐/异步加载完成 → 节点捕获候选缓存失效（下次 mousemove 重建，
      // 保证新打开的图层节点立即可捕获，无需再开关编辑）
      getEditSession()?.invalidateSnapCache()
    })();
  }, [layerFiles, pointFiles, loadMapInfoLayers, reconcileLayerZOrder, editableLayerId, getEditSession, applyDataLayerHeat, clearSelectHighlight, isHeatmapReplacement]);

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

      // 定位标记直接添加在地图上（不依赖装饰图层），无需加入装饰图层
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

    // 热力替换模式（启用热力且关闭"显示原图层"）下原扇区图形必须保持隐藏，
    // 因此这里不能按总开关无脑 addTo；统一交给 applySectorHeat 处理
    // （它同时负责热力渲染、替换模式隐藏、取消勾选时一并移除热力）。
    const heatSettingsMap = useMapStore.getState().mapSettings.heatmapSettingsMap ?? {}
    const applySectorVisibility = (layerId: 'lte-sectors' | 'nr-sectors', layer: SectorSVGLayer | null) => {
      if (!layer) return
      const hs = heatSettingsMap[layerId]
      if (hs?.enabled) {
        heatOpsRef.current?.applySectorHeat(layerId, hs)
        return
      }
      const visible = layerId === 'lte-sectors' ? layerVisibility.lte : layerVisibility.nr
      if (visible) {
        layer.addTo(mapInstanceRef.current!)
      } else {
        mapInstanceRef.current!.removeLayer(layer)
      }
    }

    applySectorVisibility('lte-sectors', lteSectorLayerRef.current)
    applySectorVisibility('nr-sectors', nrSectorLayerRef.current)

    reconcileLayerZOrder()
  }, [layerVisibility, reconcileLayerZOrder])


  /**
   * 当扇区标签可见性变化时更新图层
   */
  useEffect(() => {
    if (mapInstanceRef.current && sectorData) {
      console.log('[OnlineMap] 扇区标签可见性变化，重新创建扇区图层:', labelVisibility)
      createSectorLayers()
    }
  }, [labelVisibility])

  // 地图视口矩形：属性弹窗/重叠要素菜单统一钳制在该区域内，地图边缘点击时弹窗全尺寸可见
  const anyPopupOpen = panelVisible
    || featurePanelVisible
    || overlappingSectors.length > 0
    || overlappingFeatures.length > 0
  const popupViewportBounds: MapViewportBounds | null = anyPopupOpen && mapRef.current
    ? (() => {
        const rect = mapRef.current!.getBoundingClientRect()
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
      })()
    : null

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
        onClose={handleSectorInfoClose}
        onBack={overlapSectorsCacheRef.current ? handleBackToOverlapSectors : undefined}
        position={clickPosition}
        viewportBounds={popupViewportBounds}
        onMouseEnter={onPanelMouseEnter}
        onMouseLeave={onPanelMouseLeave}
      />

      {/* 地图容器 */}
      <div
        ref={mapRef}
        style={{
          height: '100%',
          width: '100%',
          backgroundColor: 'transparent'  // 底图隐藏时由 leaflet-container 的主题背景色决定
        }}
        className="relative"
      >
        {/* 加载提示 */}
        {loading && (
          <div className="absolute top-4 left-4 z-[1000] bg-card/95 backdrop-blur px-4 py-2 rounded-lg shadow-md border border-border flex items-center gap-2">
            <Loader2 className="animate-spin text-blue-600" size={16} />
            <span className="text-sm text-blue-600">加载地图中...</span>
          </div>
        )}

        {/* 图层加载中 - 地图中央转圈提示（勾选图层后让用户明确当前状态） */}
        {layerLoading && (
          <div className="absolute inset-0 z-[1001] flex items-center justify-center pointer-events-none">
            <div className="bg-card/95 backdrop-blur rounded-xl shadow-lg border border-border px-5 py-3 flex items-center gap-3">
              <Loader2 className="animate-spin text-blue-600" size={20} />
              <span className="text-sm text-blue-600">{t('map.loading')}</span>
            </div>
          </div>
        )}

        {/* 框选提示 */}
        {selectionTip && selectionMode !== 'none' && (
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-[1000] bg-blue-600/95 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2">
            <span className="text-sm font-medium">{selectionTip}</span>
            {selectedFeatureCount > 0 && (
              <button
                type="button"
                onClick={() => { void copySelectionBoth() }}
                title={t('map.copySelectionHint') || '复制圈选要素：属性文本可粘贴到 Excel，几何+属性可粘贴到其他打开编辑开关的图层'}
                className="flex items-center gap-1 bg-white text-blue-600 text-sm font-medium px-2.5 py-1 rounded-md hover:bg-blue-50 active:bg-blue-100 transition-colors"
              >
                <CopyIcon size={14} />
                {t('map.copySelection') || '复制'}
              </button>
            )}
            {selectedFeatureCount > 0 && (
              <button
                type="button"
                onClick={() => exportSelectionToExcel(selectedFeaturesRef.current)}
                title={t('map.exportExcel') || '导出 Excel'}
                className="flex items-center gap-1 bg-white text-blue-600 text-sm font-medium px-2.5 py-1 rounded-md hover:bg-blue-50 active:bg-blue-100 transition-colors"
              >
                <FileSpreadsheet size={14} />
                {t('map.exportExcel') || '导出 Excel'}
              </button>
            )}
            {/* 编辑态圈选：删除选中要素（Delete/Backspace 同效） */}
            {editableLayerId && shapeSelectedCount > 0 && (
              <button
                type="button"
                onClick={deleteShapeSelectedFeatures}
                title={t('map.deleteSelectedHint') || '删除圈选选中的要素（Delete/Backspace 同效，Ctrl+Z 可撤销）'}
                className="flex items-center gap-1 bg-white text-red-600 text-sm font-medium px-2.5 py-1 rounded-md hover:bg-red-50 active:bg-red-100 transition-colors"
              >
                <Trash2 size={14} />
                {t('map.deleteSelected') || '删除'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* 重叠扇区选择菜单 */}
      {overlappingSectors.length > 0 && overlapPosition && (
        <OverlappingSectorsMenu
          sectors={overlappingSectors}
          position={overlapPosition}
          viewportBounds={popupViewportBounds}
          onSelect={(sector) => {
            // 缓存当前重叠列表，属性框点「返回」时恢复列表供用户改选其他扇区（与图层文件一致）
            overlapSectorsCacheRef.current = {
              sectors: overlappingSectors,
              position: overlapPosition
            }
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

      {/* 重叠要素（图层文件/地理化数据）选择菜单 */}
      {overlappingFeatures.length > 0 && overlapPosition && (
        <OverlappingFeaturesMenu
          features={overlappingFeatures}
          position={overlapPosition}
          viewportBounds={popupViewportBounds}
          onSelect={(feature) => {
            // 缓存当前重叠列表，属性框点「返回」时恢复列表供用户改选其他要素
            overlapListCacheRef.current = {
              features: overlappingFeatures,
              position: overlapPosition
            }
            // 选中的是编辑会话要素 → 属性框字段可编辑（写回工作集）
            featureEditTargetRef.current = feature.layerId && feature.editId
              ? { layerId: feature.layerId, editId: feature.editId }
              : null
            showFeatureInfo(feature.properties, {
              originalEvent: {
                clientX: overlapPosition.x,
                clientY: overlapPosition.y
              }
            } as any, feature.name, feature.layerName)
            setOverlappingFeatures([])
            setOverlapPosition(null)
          }}
          onClose={() => {
            setOverlappingFeatures([])
            setOverlapPosition(null)
          }}
        />
      )}

      {/* TAC 频段图例已移除 - 各个页面自己管理对应的图例组件 */}

      {/* 要素属性面板 (MapInfo/地理化数据) */}
      <FeatureInfoPanel
        title={featureTitle}
        subtitle={featureSubtitle}
        properties={featureProperties}
        visible={featurePanelVisible}
        position={featureClickPosition}
        viewportBounds={popupViewportBounds}
        onClose={handleFeatureInfoClose}
        onBack={overlapListCacheRef.current ? handleBackToOverlapList : undefined}
        editable={!!featureEditTargetRef.current}
        onPropertyChange={handleFeaturePropertyChange}
        onAddProperty={handleFeatureAddProperty}
      />
    </>
  )
})

/**
 * 重叠扇区选择菜单组件
 */
function OverlappingSectorsMenu({ sectors, position, viewportBounds, onSelect, onClose }: {
  sectors: RenderSectorData[],
  position: { x: number, y: number },
  viewportBounds?: MapViewportBounds | null,
  onSelect: (sector: RenderSectorData) => void,
  onClose: () => void
}) {
  const { t } = useTranslation()
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 预估菜单尺寸（头部 + 最多300px列表 + 底部按钮），超出地图视口时翻转/钳制
  const { left, top } = clampPopupPosition(position, { width: 280, height: 380 }, viewportBounds)

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
        left,
        top,
        backgroundColor: 'hsl(var(--popover))',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        borderRadius: '8px',
        padding: '8px 0',
        zIndex: 11000,
        minWidth: '180px',
        maxWidth: '320px',
        border: '1px solid hsl(var(--border))',
        fontFamily: 'sans-serif'
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={() => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }}
      onMouseLeave={startAutoClose}
    >
      <div style={{ position: 'relative', padding: '6px 32px 10px 12px', fontSize: '12px', color: 'hsl(var(--muted-foreground))', borderBottom: '1px solid hsl(var(--border))', marginBottom: '4px' }}>
        {t('map.overlappingSectors', { count: sectors.length })}
        {/* 关闭按钮 */}
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
          style={{
            position: 'absolute', top: '2px', right: '6px',
            width: '20px', height: '20px', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            border: 'none', background: 'transparent',
            cursor: 'pointer', borderRadius: '4px',
            color: 'hsl(var(--muted-foreground))', fontSize: '14px', lineHeight: '1', padding: 0, zIndex: 1
          }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'hsl(var(--accent))'; (e.target as HTMLElement).style.color = 'hsl(var(--foreground))' }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; (e.target as HTMLElement).style.color = 'hsl(var(--muted-foreground))' }}
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
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'hsl(var(--accent))')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            onClick={() => onSelect(sector)}
          >
            <div style={{
              width: '10px',
              height: '10px',
              borderRadius: '2px',
              backgroundColor: sector.frequency ? frequencyColorMapper.getColor(sector.frequency, sector.networkType).color || '#ccc' : '#ccc',
              border: '1px solid hsl(var(--border))'
            }} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>{sector.id}</span>
              <span style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>{sector.name} | {sector.networkType} | PCI: {sector.pci}</span>
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          padding: '8px 12px',
          borderTop: '1px solid hsl(var(--border))',
          marginTop: '4px',
          fontSize: '12px',
          color: 'hsl(var(--muted-foreground))',
          cursor: 'pointer',
          textAlign: 'center',
          fontWeight: 500
        }}
        onClick={onClose}
      >
        {t('map.overlapCancel')}
      </div>
    </div>
  )
}

/**
 * 从要素属性中提取要素显示名称（与 MapInfoLayer 标签字段映射保持一致）
 * 优先名称类字段（小区名称/CELLNAME/Name 等），其次 ID 类字段（OBJECTID/ID 等），都没有返回空串
 */
function extractFeatureName(properties: Record<string, any> | null | undefined): string {
  if (!properties) return ''
  // 名称类字段（含常见中英文列名）
  const nameFields = [
    'name', '小区名称', '站点名称', 'CELLNAME', 'CELL_NAME', 'CELL NAME',
    'Cell Name', 'cellName', 'NAME', 'Name', 'zhLabel', '名称', '图层名称'
  ]
  for (const f of nameFields) {
    const v = properties[f]
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim()
  }
  // 嵌套 properties（地理化数据展平前的结构）
  const nested = properties.properties
  if (nested && typeof nested === 'object') {
    const nestedName = extractFeatureName(nested)
    if (nestedName) return nestedName
  }
  // ID 类字段兜底
  const idFields = ['OBJECTID', 'GRID_ID', 'id', 'ID', 'Id']
  for (const f of idFields) {
    const v = properties[f]
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim()
  }
  return ''
}

/**
 * 重叠要素（图层文件/地理化数据）
 */
interface OverlappingFeature {
  /** 所属图层名称 */
  layerName: string
  /** 所属图层 id（"选择"工具高亮追踪用：图层被关闭/移除后清理残留高亮） */
  layerId?: string
  /** 编辑会话要素标识（仅编辑态图层要素有；属性弹窗字段编辑写回工作集用） */
  editId?: string
  /** 要素显示名称 */
  name: string
  /** 要素属性（点击后传给 FeatureInfoPanel 展示） */
  properties: Record<string, any>
  /** 要素几何（"选择"工具下用于面积/长度/节点数统计） */
  geometry?: { type: string; coordinates: any } | null
}

/**
 * 重叠要素选择菜单组件
 * 点击位置命中多个图层文件/地理化数据要素时弹出，供用户选择查看哪个要素
 */
function OverlappingFeaturesMenu({ features, position, viewportBounds, onSelect, onClose }: {
  features: OverlappingFeature[],
  position: { x: number, y: number },
  viewportBounds?: MapViewportBounds | null,
  onSelect: (feature: OverlappingFeature) => void,
  onClose: () => void
}) {
  const { t } = useTranslation()
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 预估菜单尺寸（头部 + 最多300px列表 + 底部按钮），超出地图视口时翻转/钳制
  const { left, top } = clampPopupPosition(position, { width: 360, height: 380 }, viewportBounds)

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
        left,
        top,
        backgroundColor: 'hsl(var(--popover))',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        borderRadius: '8px',
        padding: '8px 0',
        zIndex: 11000,
        minWidth: '200px',
        maxWidth: '360px',
        border: '1px solid hsl(var(--border))',
        fontFamily: 'sans-serif'
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={() => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }}
      onMouseLeave={startAutoClose}
    >
      <div style={{ position: 'relative', padding: '6px 32px 10px 12px', fontSize: '12px', color: 'hsl(var(--muted-foreground))', borderBottom: '1px solid hsl(var(--border))', marginBottom: '4px' }}>
        {t('map.overlappingFeatures', { count: features.length })}
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
          style={{
            position: 'absolute', top: '2px', right: '6px',
            width: '20px', height: '20px', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            border: 'none', background: 'transparent',
            cursor: 'pointer', borderRadius: '4px',
            color: 'hsl(var(--muted-foreground))', fontSize: '14px', lineHeight: '1', padding: 0, zIndex: 1
          }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'hsl(var(--accent))'; (e.target as HTMLElement).style.color = 'hsl(var(--foreground))' }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; (e.target as HTMLElement).style.color = 'hsl(var(--muted-foreground))' }}
          title={t('map.overlapCancel')}
        >✕</button>
      </div>
      <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
        {features.map((feature, idx) => (
          <div
            key={`${feature.layerName}-${idx}`}
            style={{
              padding: '10px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              transition: 'background-color 0.2s'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'hsl(var(--accent))')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            onClick={() => onSelect(feature)}
          >
            <div style={{
              width: '10px',
              height: '10px',
              borderRadius: '50%',
              backgroundColor: 'hsl(var(--primary))',
              border: '1px solid hsl(var(--border))',
              flexShrink: 0
            }} />
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontWeight: 600, color: 'hsl(var(--foreground))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{feature.name}</span>
              <span style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>{feature.layerName}</span>
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          padding: '8px 12px',
          borderTop: '1px solid hsl(var(--border))',
          marginTop: '4px',
          fontSize: '12px',
          color: 'hsl(var(--muted-foreground))',
          cursor: 'pointer',
          textAlign: 'center',
          fontWeight: 500
        }}
        onClick={onClose}
      >
        {t('map.overlapCancel')}
      </div>
    </div>
  )
}

OnlineMap.displayName = 'OnlineMap'
