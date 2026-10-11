/**
 * 地图工具页面
 *
 * 功能:
 * - 在线地图：显示LTE/NR扇区图层，支持搜索定位
 * - 离线地图：本地地图工具
 * - 双模式搜索：地名搜索(高德) + 工参搜索
 * - 图层控制：切换LTE/NR扇区显示
 * - 显示当前工参文件名
 * - 坐标缺失警告
 */
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Search, X, MapPin, AlertTriangle, Database, Trash2, MousePointer2, Circle as CircleIcon, Pentagon, Hand, Map as MapIcon, Satellite, Move, Shrink, FilePlus2, Save, Download, Hexagon, Spline, Palette, PenLine, Undo2, BoxSelect, ClipboardPaste, Magnet, Combine, Filter, ChevronRight, ChevronsRight } from 'lucide-react'
import { OnlineMap, OnlineMapRef, CustomLayerOption } from '../components/Map/OnlineMap'
import { MapSearchDialog } from '../components/Map/MapSearchDialog'
import { LayerControl, SectorLayerOption, LayerFileOption, DecorationLayerOption } from '../components/Map/LayerControl'
import { OfflineMap, createDefaultLayers } from '../components/Map'
import type { LayerOption, FrequencyOption } from '../components/Map'
import { CoordinateTransformer } from '../utils/coordinate'
import { mapApi, layerApi } from '../services/api'
import { useDataStore, DATA_REFRESH_EVENT, triggerDataRefresh } from '../store/dataStore'
import { useMapStore } from '../store/mapStore'
import type { LayerCategory } from '../store/mapStore'
import { useMapDataCacheStore } from '../store/mapDataCacheStore'
import { useLayerEditStore, selectDirtyLayerIds, buildSavePlan } from '../store/layerEditStore'
import type { EditFeature } from '../store/layerEditStore'
import NewLayerDialog from '../components/Map/NewLayerDialog'
import AttributeJoinDialog from '../components/Map/AttributeJoinDialog'
import BufferDialog from '../components/Map/BufferDialog'
import SaveLayersDialog, { type DirtyLayerItem } from '../components/Map/SaveLayersDialog'
import MapExportDialog from '../components/Map/MapExportDialog'
import DrawStyleModal from '../components/Map/DrawStyleModal'
import FeatureStyleDialog from '../components/Map/FeatureStyleDialog'
import type { DrawGeometryType } from '@shared/types'
import { mapDataService, type RenderSectorData } from '../services/mapDataService'
import { frequencyColorMapper } from '../config/sector-config'
import { LabelSettings, LayerColorSettings, ThematicSettings, ThematicRange, HeatmapSettings, HeatmapTemplate } from '../components/Map/LabelSettingsModal'
import { TreeNode } from '../components/Map/LayerControl'
import { ThematicLegend } from '../components/Map/ThematicLegend'
import { PciModLegend } from '../components/Map/PCIModLegend'
import type { PciModLegendItem } from '../components/Map/PCIModLegend'
import type { PciRenderStats } from '../utils/pciModColor'
import { HeatmapLegend } from '../components/Map/HeatmapLegend'
import type { HeatmapStats } from '../components/Map/HeatmapLayerManager'
import { selectionManager } from '../services/selectionManager'

// MapInfo 图层列表缓存（避免每次挂载都重新请求）
interface LayerListCacheEntry {
  data: any[]
  time: number
}

/**
 * 另存为的保存目标：
 * - fsa：File System Access API 拿到的文件句柄（用户已在路径选择框中指定位置）
 * - download：浏览器不支持路径选择，回退为默认下载
 */
type SaveTarget = { kind: 'fsa'; handle: any } | { kind: 'download' }

/** 弹出系统路径选择框（需用户手势，故在发起网络请求前调用）。用户取消返回 null。 */
async function pickSaveTarget(filename: string): Promise<SaveTarget | null> {
  const w = window as any
  try {
    if (typeof w.showSaveFilePicker === 'function') {
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }],
      })
      return { kind: 'fsa', handle }
    }
    if (typeof w.showDirectoryPicker === 'function') {
      const dir = await w.showDirectoryPicker({ mode: 'readwrite' })
      const handle = await dir.getFileHandle(filename, { create: true })
      return { kind: 'fsa', handle }
    }
  } catch (e: any) {
    // 用户在路径选择框点了取消
    if (e?.name === 'AbortError') return null
    // 其它错误（非安全上下文等）回退为默认下载
  }
  return { kind: 'download' }
}

/** 把内容写入已选中的保存目标。 */
async function writeSaveTarget(target: SaveTarget, blob: Blob, filename: string): Promise<void> {
  if (target.kind === 'fsa') {
    const writable = await target.handle.createWritable()
    try {
      await writable.write(blob)
    } finally {
      await writable.close()
    }
    return
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
/** 梯形图标：只有上下两边平行的四边形（边界选择专用） */
function TrapezoidIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 5 L17 5 L20 19 L4 19 Z" />
    </svg>
  )
}
/** 缓冲区图标：中心一条曲线，四周被与曲线等距、不相交的封闭轮廓包裹（绘制缓冲区专用） */
function BufferIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.40 11.42 C2.98 12.37 4.86 14.95 5.85 15.88 C6.84 16.81 7.67 16.82 8.33 16.98 C8.99 17.14 9.33 16.99 9.81 16.85 C10.29 16.71 10.51 16.82 11.23 16.16 C11.95 15.50 13.24 12.99 14.11 12.92 C14.98 12.85 15.72 15.07 16.45 15.73 C17.18 16.39 17.95 16.68 18.50 16.86 C19.05 17.04 19.36 16.90 19.72 16.81 C20.08 16.72 20.33 16.72 20.66 16.34 C20.99 15.96 21.59 15.15 21.68 14.54 C21.77 13.93 21.53 13.19 21.23 12.69 C20.93 12.19 20.46 12.19 19.86 11.53 C19.26 10.87 18.22 9.37 17.61 8.71 C17.00 8.05 16.68 7.84 16.18 7.56 C15.68 7.28 15.10 7.10 14.59 7.03 C14.08 6.96 13.59 7.00 13.10 7.13 C12.61 7.26 12.36 7.15 11.63 7.81 C10.90 8.47 9.60 10.99 8.72 11.08 C7.84 11.17 6.95 8.86 6.33 8.35 C5.71 7.84 5.40 8.01 4.98 8.00 C4.56 7.99 4.15 8.11 3.79 8.29 C3.44 8.47 3.09 8.75 2.85 9.07 C2.61 9.39 2.43 9.81 2.35 10.20 C2.27 10.59 1.82 10.47 2.40 11.42 Z" />
      <path d="M5.00 10.70 C5.15 10.89 5.61 11.45 5.91 11.84 C6.21 12.23 6.52 12.68 6.82 13.02 C7.12 13.37 7.43 13.71 7.73 13.93 C8.03 14.14 8.34 14.28 8.64 14.30 C8.94 14.32 9.25 14.22 9.55 14.04 C9.85 13.86 10.16 13.54 10.46 13.21 C10.76 12.88 11.07 12.45 11.37 12.06 C11.67 11.67 11.98 11.23 12.28 10.89 C12.58 10.55 12.89 10.22 13.19 10.02 C13.49 9.82 13.80 9.70 14.10 9.70 C14.40 9.70 14.71 9.82 15.01 10.01 C15.31 10.21 15.62 10.53 15.92 10.87 C16.22 11.21 16.53 11.66 16.83 12.04 C17.13 12.43 17.44 12.87 17.74 13.20 C18.04 13.53 18.50 13.89 18.65 14.03" />
    </svg>
  )
}

const _layerListCache = new Map<string, LayerListCacheEntry>()
const _LAYER_LIST_CACHE_TTL = 10 * 60 * 1000 // 10分钟

/** 可编辑保存的图层源文件后缀（与后端 layer_edit_service._LAYER_FMT_BY_SUFFIX 保持一致） */
const LAYER_EDITABLE_EXTS = ['.tab', '.shp', '.geojson', '.json']

/** 源文件名 → 图层格式（仅 TAB 支持增量保存，其余走整层保存） */
function layerFileFormat(sourceFile?: string): string {
  const f = (sourceFile || '').toLowerCase()
  if (f.endsWith('.tab')) return 'tab'
  if (f.endsWith('.shp')) return 'shp'
  if (f.endsWith('.geojson') || f.endsWith('.json')) return 'geojson'
  return ''
}

// ===== 工具栏个性化（右键设置）：按钮排序 + 标签文字显隐，按登录用户持久化 =====

/** 可拖动排序的工具栏按钮 id（数据源指示/搜索区固定不参与）；默认顺序按使用频率排列 */
/* 全屏按钮不在此列：已迁到地图内右上角的悬浮图标（见地图内容区域） */
const TOOLBAR_ITEM_IDS = [
  'save', 'export', 'new', 'undo', 'capture', 'paste', 'measure',
  'drag', 'select', 'marquee', 'draw', 'style', 'nodesnap', 'nodemerge',
  'maptype',
] as const
type ToolbarItemId = (typeof TOOLBAR_ITEM_IDS)[number]

interface ToolbarPrefs {
  order: ToolbarItemId[]
  showLabels: boolean
  /** 快照格式版本（v3 = 标签默认显示；旧快照一次性迁移） */
  __v?: number
}

/** 按登录用户区分的 localStorage key（与 mapStore.getStorageKey 同源） */
function toolbarPrefsKey(): string {
  try {
    const stored = localStorage.getItem('auth-storage')
    if (stored) {
      const user = JSON.parse(stored)?.state?.user
      if (user?.id) return `map-toolbar-user-${user.id}`
    }
  } catch { /* ignore */ }
  return 'map-toolbar-anonymous'
}

function loadToolbarPrefs(): ToolbarPrefs {
  // v3 默认：标签文字显示 + 默认按钮顺序
  const defaults: ToolbarPrefs = { order: [...TOOLBAR_ITEM_IDS], showLabels: true, __v: 3 }
  try {
    const raw = localStorage.getItem(toolbarPrefsKey())
    if (!raw) return defaults
    const p = JSON.parse(raw)
    // 旧版快照（v1 及更早）：一次性迁移为新的默认外观（按未定制处理）
    if (p.__v !== 2 && p.__v !== 3) return defaults
    // v2 快照：旧默认"标签隐藏"与新默认冲突，按未定制处理（改为显示标签），保留自定义按钮顺序；
    // v3 快照：尊重用户显式设置，仅补齐新增按钮
    const known = TOOLBAR_ITEM_IDS as readonly string[]
    const order: ToolbarItemId[] = Array.isArray(p.order)
      ? (p.order.filter((id: string) => known.includes(id)) as ToolbarItemId[])
      : [...TOOLBAR_ITEM_IDS]
    // 缺失按钮按默认顺序插到"前一个默认邻居"之后，
    // 保证新按钮（如节点捕获/节点合并）出现在规范位置而非一律追加到末尾
    for (const id of TOOLBAR_ITEM_IDS) {
      if (order.includes(id)) continue
      const defaultIdx = TOOLBAR_ITEM_IDS.indexOf(id)
      let placed = false
      for (let j = defaultIdx - 1; j >= 0; j--) {
        const anchorPos = order.indexOf(TOOLBAR_ITEM_IDS[j])
        if (anchorPos >= 0) {
          order.splice(anchorPos + 1, 0, id)
          placed = true
          break
        }
      }
      if (!placed) order.unshift(id)
    }
    return { order, showLabels: p.__v === 3 ? p.showLabels === true : true, __v: 3 }
  } catch {
    return defaults
  }
}

/** 「更多」面板条目：工具栏被收纳按钮的等价行（图标 + 文案 + 动作，与 toolbarButtons 保持一致） */
interface ToolbarMoreEntry {
  icon: ReactNode
  label: string
  title?: string
  /** 对应工具当前处于激活态（面板行高亮） */
  active?: boolean
  disabled?: boolean
  /** 直接执行的动作；带 submenu 的复合按钮改用子项列表 */
  onSelect?: () => void
  /** 复合按钮（新建/圈选/绘制）的下拉项 */
  submenu?: Array<{ icon: ReactNode; label: string; onSelect: () => void }>
}

/**
 * 搜索模式
 */
type SearchMode = 'map' | 'parameter'

/**
 * 地名搜索结果接口
 */
interface PlaceSearchResult {
  type: 'place'
  name: string
  address: string
  district: string
  location: string  // "lng,lat"格式 (GCJ02坐标系)
  adcode: string
}

/**
 * 工参搜索结果接口
 */
interface ParameterSearchResult {
  type: 'parameter'
  id: string
  name: string
  networkType: 'LTE' | 'NR'
  siteId?: string
  sectorId?: string
  latitude?: number
  longitude?: number
  hasLocation: boolean  // 是否有坐标
}

type SearchResult = PlaceSearchResult | ParameterSearchResult

export function MapPage() {
  const { t } = useTranslation()

  // 从持久化 store 获取设置（必须放在所有使用 mapSettings 的 state 之前）
  const {
    mapSettings,
    setLayerVisibility: storeSetLayerVisibility,
    setLayerFileVisibility: storeSetLayerFileVisibility,
    setPointFileVisibility: storeSetPointFileVisibility,
    setSectorLabelVisibility: storeSetSectorLabelVisibility,
    setPointFileLabelVisibility: storeSetPointFileLabelVisibility,
    setLayerFileLabelVisibility: storeSetLayerFileLabelVisibility,
    setMapType: storeSetMapType,
    setLabelSettings: storeSetLabelSettings,
    setColorSettings: storeSetColorSettings,
    setThematicSettings: storeSetThematicSettings,
    setHeatmapSettings: storeSetHeatmapSettings,
    setThematicTemplates: storeSetThematicTemplates,
    setHeatmapTemplates: storeSetHeatmapTemplates,
    setFrequencyCustomColors: storeSetFrequencyCustomColors,
    setBaseMapVisible: storeSetBaseMapVisible,
    setDecorationLabelVisible: storeSetDecorationLabelVisible,
    setLayerOrder: storeSetLayerOrder,
    setLayerSelectable: storeSetLayerSelectable,
  } = useMapStore()

  // 视图模式
  const [viewMode, setViewMode] = useState<'online' | 'offline'>(() => {
    // 从状态服务获取当前视图模式
    return 'online' // 默认在线地图
  })

  // 地图类型（平面/卫星）- 从持久化 store 初始化
  const [mapType, setMapType] = useState<'roadmap' | 'satellite'>(() => mapSettings.mapType)

  // 在线地图可见性 - 从持久化 store 初始化
  const [onlineMapVisible, setOnlineMapVisible] = useState(() => mapSettings.baseMapVisible)

  // 数据存储 - 获取工参文件名
  const { items } = useDataStore()

  // 刷新按钮状态：idle(红色), loading(旋转), loaded(绿色)
  const [refreshStatus, setRefreshStatus] = useState<'idle' | 'loading' | 'loaded'>('idle')

  // 离线地图数据
  const [offlinePath, setOfflinePath] = useState('')
  const [offlineData, setOfflineData] = useState({
    sites: [],
    center: { latitude: 23.74, longitude: 114.69 }
  })

  // 获取当前工参文件名
  const currentDataSourceFile = useMemo(() => {
    // 按后端分类标识判断全量工参（不能按文件名前缀：存量 mongoose 命名/用户改名都会漏判导致图标误红）
    const excelFiles = items
      .filter(item => item.type === 'excel' && item.status === 'ready' && item.fileType === 'full_params')
      .sort((a, b) => new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime())
    return excelFiles.length > 0 ? excelFiles[0].name : null
  }, [items])

  // 初始化时获取数据列表
  useEffect(() => {
    useDataStore.getState().fetchList()
  }, [])

  // 自动重置刷新状态为idle（绿色状态保持2秒后恢复红色）
  useEffect(() => {
    if (refreshStatus === 'loaded') {
      const timer = setTimeout(() => {
        setRefreshStatus('idle')
      }, 2000)
      return () => clearTimeout(timer)
    }
  }, [refreshStatus])

  // 获取离线地图配置
  useEffect(() => {
    const fetchOfflineConfig = async () => {
      try {
        const response = await mapApi.getOfflinePath()
        if (response.success && response.data?.path) {
          setOfflinePath(response.data.path)
        }
      } catch (error) {
        console.error('[MapPage] 获取离线地图路径失败:', error)
      }
    }
    fetchOfflineConfig()
  }, [])

  // 图层控制 - 从持久化 store 初始化
  const [layers, setLayers] = useState<LayerOption[]>(() => {
    const defaults = createDefaultLayers()
    return defaults.map(l => ({
      ...l,
      visible: l.id === 'lte-sectors'
        ? mapSettings.layerVisibility.lte
        : l.id === 'nr-sectors'
          ? mapSettings.layerVisibility.nr
          : l.visible
    }))
  })
  // 扇区标签可见性
  const [sectorLabelVisibility, setSectorLabelVisibility] = useState<Record<string, boolean>>(
    mapSettings.sectorLabelVisibility
  )
  // 点文件标签可见性（撒点文件的属性标签）
  const [pointFileLabelVisibility, setPointFileLabelVisibility] = useState<Record<string, boolean>>(
    mapSettings.pointFileLabelVisibility
  )
  // 图层文件标签可见性（从持久化 store 初始化，页面切换后状态保持）
  const [layerFileLabelVisibility, setLayerFileLabelVisibility] = useState<Record<string, boolean>>(
    mapSettings.layerFileLabelVisibility
  )
  const [layerFiles, setLayerFiles] = useState<LayerFileOption[]>([])
  const [pointFiles, setPointFiles] = useState<LayerFileOption[]>([])



  // 频点列表（按网络类型分组）
  const [frequencies, setFrequencies] = useState<{ lte: FrequencyOption[]; nr: FrequencyOption[] }>({
    lte: [],
    nr: []
  })
  // 跟踪频点是否已初始化过（避免覆盖用户的选择）
  const frequenciesInitializedRef = useRef(false)

  // 自定义图层 (用户创建的点)
  const [customLayers, setCustomLayers] = useState<CustomLayerOption[]>([])

  // 装饰图层（打点/定位标记 + 绘制要素）- 恒定可见（控制面板复选框锁定不可关闭）
  const [decorationLayer, setDecorationLayer] = useState<DecorationLayerOption>({
    id: 'decoration-layer',
    name: '装饰图层',
    visible: true,
    count: 0
  })

  // 装饰图层标签可见性 - 从持久化 store 初始化
  const [decorationLabelVisible, setDecorationLabelVisible] = useState<boolean>(
    mapSettings.decorationLabelVisible
  )

  // 全屏模式：地图占满整个屏幕（隐藏侧栏与应用顶栏），按钮在地图右上角悬浮
  const [isFullscreen, setIsFullscreen] = useState(false)
  const mapPageRef = useRef<HTMLDivElement>(null)
  // 是否真的进入了系统级全屏（Fullscreen API 成功）；桌面壳不支持时只做应用内全屏
  const fsApiActiveRef = useRef(false)

  // 切换全屏：先切应用内状态（保证任何环境都有"地图占满屏幕"的效果），
  // 再尽力请求系统级全屏（浏览器里连浏览器外壳一起占满；失败/不支持也不影响）
  const toggleFullscreen = useCallback(() => {
    const next = !isFullscreen
    setIsFullscreen(next)
    if (next) {
      fsApiActiveRef.current = false
      const req = document.documentElement.requestFullscreen?.()
      if (req && typeof req.then === 'function') {
        req.then(() => { fsApiActiveRef.current = true }).catch(() => { /* 桌面壳/权限不允许 */ })
      }
    } else if (document.fullscreenElement) {
      document.exitFullscreen?.()?.catch?.(() => { /* ignore */ })
    }
  }, [isFullscreen])

  // 系统级全屏被外部退出（Esc / 系统手势）时同步应用内状态；
  // 只有确实进入过系统级全屏才收敛，避免桌面壳下刚点开就被打回
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (document.fullscreenElement) {
        fsApiActiveRef.current = true
        setIsFullscreen(true)
      } else if (fsApiActiveRef.current) {
        fsApiActiveRef.current = false
        setIsFullscreen(false)
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // 全屏时添加/移除 body class 用于 CSS 隐藏侧边栏
  useEffect(() => {
    if (isFullscreen) {
      document.body.classList.add('map-fullscreen-mode')
    } else {
      document.body.classList.remove('map-fullscreen-mode')
    }
    return () => document.body.classList.remove('map-fullscreen-mode')
  }, [isFullscreen])

  // 当语言变化时更新装饰图层名称
  useEffect(() => {
    setDecorationLayer(prev => ({
      ...prev,
      name: t('map.decorationLayer') || '装饰图层'
    }))
  }, [t])

  // 标签配置状态（按图层ID存储）- 从持久化 store 初始化
  const initialLabelSettings = Object.keys(mapSettings.labelSettingsMap).length > 0
    ? mapSettings.labelSettingsMap
    : { 'lte-sectors': { content: 'name' as const, color: '#000000', fontSize: 12 }, 'nr-sectors': { content: 'name' as const, color: '#000000', fontSize: 12 } }
  const [labelSettingsMap, setLabelSettingsMap] = useState<Record<string, LabelSettings>>(initialLabelSettings)

  // 图层颜色配置状态（按图层ID存储）- 从持久化 store 初始化
  const initialColorSettings = Object.keys(mapSettings.colorSettingsMap ?? {}).length > 0
    ? mapSettings.colorSettingsMap
    : {}
  const [colorSettingsMap, setColorSettingsMap] = useState<Record<string, LayerColorSettings>>(initialColorSettings)

  // 专题图层配置状态（按图层ID存储）- 从持久化 store 初始化
  const initialThematicSettings = Object.keys(mapSettings.thematicSettingsMap ?? {}).length > 0
    ? mapSettings.thematicSettingsMap
    : {}
  const [thematicSettingsMap, setThematicSettingsMap] = useState<Record<string, ThematicSettings>>(initialThematicSettings)

  // 热力图配置状态（按图层ID存储）- 从持久化 store 初始化
  const initialHeatmapSettings = Object.keys(mapSettings.heatmapSettingsMap ?? {}).length > 0
    ? mapSettings.heatmapSettingsMap
    : {}
  const [heatmapSettingsMap, setHeatmapSettingsMap] = useState<Record<string, HeatmapSettings>>(initialHeatmapSettings)

  // ===== store → 本地状态回填 =====
  // 登录后地图设置是异步恢复的（本地 localStorage / 后端 GET），MapPage 可能先挂载，
  // 此时本地镜像会停在默认值：表现为自定义设置弹窗参数回到默认、图例/勾选开关与已保存状态不一致。
  // store 为唯一真源（各 setter 均同步写 store），因此在 store 变化时统一回填本地镜像。
  useEffect(() => {
    setThematicSettingsMap(mapSettings.thematicSettingsMap ?? {})
  }, [mapSettings.thematicSettingsMap])

  useEffect(() => {
    setHeatmapSettingsMap(mapSettings.heatmapSettingsMap ?? {})
  }, [mapSettings.heatmapSettingsMap])

  useEffect(() => {
    setColorSettingsMap(mapSettings.colorSettingsMap ?? {})
  }, [mapSettings.colorSettingsMap])

  // 标签设置仅在 store 有数据时回填（空 store 时保留基站默认标签配置）
  useEffect(() => {
    const m = mapSettings.labelSettingsMap
    if (m && Object.keys(m).length > 0) setLabelSettingsMap(m)
  }, [mapSettings.labelSettingsMap])

  // 基站图层（LTE/NR 总开关）勾选状态恢复
  useEffect(() => {
    const v = mapSettings.layerVisibility
    if (!v) return
    setLayers(prev => {
      let changed = false
      const next = prev.map(l => {
        const want = l.id === 'lte-sectors' ? v.lte : l.id === 'nr-sectors' ? v.nr : l.visible
        if (want === l.visible) return l
        changed = true
        return { ...l, visible: want }
      })
      return changed ? next : prev
    })
  }, [mapSettings.layerVisibility])

  // 图层文件 / 地理化数据勾选状态恢复
  useEffect(() => {
    const lv = mapSettings.layerFileVisibility ?? {}
    const pv = mapSettings.pointFileVisibility ?? {}
    setLayerFiles(prev => {
      let changed = false
      const next = prev.map(f => {
        const want = lv[f.id] ?? false
        if (want === f.visible) return f
        changed = true
        return { ...f, visible: want }
      })
      return changed ? next : prev
    })
    setPointFiles(prev => {
      let changed = false
      const next = prev.map(f => {
        const want = pv[f.id] ?? false
        if (want === f.visible) return f
        changed = true
        return { ...f, visible: want }
      })
      return changed ? next : prev
    })
  }, [mapSettings.layerFileVisibility, mapSettings.pointFileVisibility])

  // 标签开关恢复（与本地状态合并：保存标签设置时会本地强制置 true 但未必写入 store，
  // 直接整体替换会把这类本地状态冲掉）
  useEffect(() => {
    setSectorLabelVisibility(prev => ({ ...prev, ...(mapSettings.sectorLabelVisibility ?? {}) }))
  }, [mapSettings.sectorLabelVisibility])
  useEffect(() => {
    setPointFileLabelVisibility(prev => ({ ...prev, ...(mapSettings.pointFileLabelVisibility ?? {}) }))
  }, [mapSettings.pointFileLabelVisibility])
  useEffect(() => {
    setLayerFileLabelVisibility(prev => ({ ...prev, ...(mapSettings.layerFileLabelVisibility ?? {}) }))
  }, [mapSettings.layerFileLabelVisibility])

  const sectorLayers = useMemo((): SectorLayerOption[] => layers.map(layer => ({
    id: layer.id,
    label: layer.label,
    type: (layer.type as any),
    visible: layer.visible,
    icon: layer.icon,
    color: layer.color
  })), [layers])

  /**
   * 加载图层文件列表 (MapInfo 和 Excel点文件)
   * 优化：并行加载所有MapInfo图层数据，减少等待时间
   */
  const loadLayerFiles = useCallback(async () => {
    try {
      // 从数据列表中获取所有数据项
      const items = useDataStore.getState().items

      console.log('[MapPage] 开始加载图层文件，总数据项:', items.length)

      // 1. 处理 MapInfo 文件 - 并行加载
      const mapItems = items.filter(item => item.type === 'map')
      console.log('[MapPage] Map 类型数据项:', mapItems.length)

      // 并行获取所有MapInfo图层（带缓存）
      const mapInfoPromises = mapItems.map(async (mapItem) => {
        try {
          // 勾选状态持久化：从 store 恢复该图层上次的可见性（无记录则默认 false）
          const layerFileVisibility = useMapStore.getState().mapSettings.layerFileVisibility

          // 检查缓存
          const cached = _layerListCache.get(mapItem.id)
          if (cached && Date.now() - cached.time < _LAYER_LIST_CACHE_TTL) {
            console.log('[MapPage] 使用图层列表缓存:', mapItem.id)
            return cached.data.map((layer: any) => ({
              id: layer.id,
              name: layer.name,
              type: layer.type as 'point' | 'line' | 'polygon' | 'mixed',
              visible: layerFileVisibility[layer.id] ?? false,
              dataId: mapItem.id,
              sourceType: 'mapinfo' as const,
              defaultStyle: layer.defaultStyle,
              editable: LAYER_EDITABLE_EXTS.some((ext) => (layer.metadata?.source_file || '').toLowerCase().endsWith(ext)),
              format: layerFileFormat(layer.metadata?.source_file),
              toolCreated: layer.metadata?.editable === true
            }))
          }

          const response = await layerApi.getLayers(mapItem.id)
          if (response.success && response.data?.layers) {
            // 写入缓存
            _layerListCache.set(mapItem.id, {
              data: response.data.layers,
              time: Date.now()
            })
            return response.data.layers.map((layer: any) => ({
              id: layer.id,
              name: layer.name,
              type: layer.type as 'point' | 'line' | 'polygon' | 'mixed',
              visible: layerFileVisibility[layer.id] ?? false,
              dataId: mapItem.id,
              sourceType: 'mapinfo' as const,
              defaultStyle: layer.defaultStyle,
              editable: LAYER_EDITABLE_EXTS.some((ext) => (layer.metadata?.source_file || '').toLowerCase().endsWith(ext)),
              format: layerFileFormat(layer.metadata?.source_file),
              toolCreated: layer.metadata?.editable === true
            }))
          }
          return []
        } catch (error) {
          console.error('[MapPage] 获取图层文件失败:', mapItem.id, error)
          return []
        }
      })

      // 等待所有并行请求完成
      const mapInfoResults = await Promise.all(mapInfoPromises)
      const mapInfoFiles = mapInfoResults.flat()
      console.log(`[MapPage] 总共加载 ${mapInfoFiles.length} 个 MapInfo 图层文件`)
      setLayerFiles(mapInfoFiles)

      // 2. 处理 Excel 点文件 (fileType='default' 或 'geo_data' 或空，或者有 geometryType 字段)
      const excelItems = items.filter(item => {
        // 基本条件：必须是 excel 类型
        if (item.type !== 'excel') return false

        // 如果有 geometryType 字段（点/扇区/多边形），则包含它
        if (item.geometryType && ['point', 'sector', 'polygon'].includes(item.geometryType)) {
          console.log('[MapPage] ✅ 包含 Excel 数据项:', item.name, 'geometryType:', item.geometryType)
          return true
        }

        // 否则检查 fileType
        const isValidFileType = item.fileType === 'default' || item.fileType === 'geo_data' || !item.fileType
        if (isValidFileType) {
          console.log('[MapPage] ✅ 包含 Excel 数据项:', item.name, 'fileType:', item.fileType)
        }
        return isValidFileType
      })

      const excelPointFiles: LayerFileOption[] = excelItems.map(item => {
        // 根据 geometryType 确定图层类型
        let type: 'point' | 'line' | 'polygon' | 'sector' = 'point'
        if (item.geometryType === 'sector') {
          type = 'sector'
        } else if (item.geometryType === 'polygon') {
          type = 'polygon'
        }

        // 勾选状态持久化：从 store 恢复该地理化数据上次的可见性（无记录则默认 false）
        const pointFileVisibility = useMapStore.getState().mapSettings.pointFileVisibility

        return {
          id: item.id,
          name: item.name,
          type: type,
          visible: pointFileVisibility[item.id] ?? false,
          dataId: item.id,
          sourceType: 'excel',
          geometryType: item.geometryType
        }
      })
      setPointFiles(excelPointFiles)

    } catch (error) {
      console.error('[MapPage] 加载图层文件失败:', error)
    }
  }, [])

  // 当数据列表更新后，加载图层文件
  useEffect(() => {
    loadLayerFiles()
  }, [items, loadLayerFiles])

  /**
   * 加载工参数据用于搜索（带缓存检查）
   */
  const { cacheSectors, getCachedSectors, markSectorsDirty } = useMapDataCacheStore()

  const loadSectorDataForSearch = useCallback(async () => {
    try {
      // 尝试从缓存加载当前激活的 workbook 数据
      const loadedIds = useMapStore.getState().mapSettings.loadedWorkbookIds
      if (loadedIds.length > 0) {
        const primaryId = loadedIds[0]
        const cached = getCachedSectors(primaryId)
        if (cached) {
          console.log('[MapPage] 使用缓存扇区数据')
          setSectorDataCache({
            lte: (cached as any).lteSectors || [],
            nr: (cached as any).nrSectors || []
          })
          return
        }
      }

      const data = await mapDataService.getMapData()
      setSectorDataCache({
        lte: data.lteSectors,
        nr: data.nrSectors
      })
      // 缓存结果
      if (loadedIds.length > 0) {
        cacheSectors(loadedIds[0], data)
      }
    } catch (error) {
      console.error('[MapPage] 加载工参数据失败:', error)
    }
  }, [getCachedSectors, cacheSectors])

  // 监听数据刷新事件（数据被删除或上传时重新加载扇区数据和图层文件）
  useEffect(() => {
    const handleDataRefresh = (e: Event) => {
      const scope = (e as CustomEvent)?.detail?.scope
      // 清除图层列表缓存（图层保存后源文件时间戳变化，列表需重取）
      _layerListCache.clear()
      loadLayerFiles()
      if (scope === 'layer') {
        // 仅图层内容变化（保存链路）：扇区/工参数据未变，跳过重载与重绘，避免保存后卡顿
        console.log('[MapPage] 图层内容已更新，跳过扇区数据重载')
        return
      }
      console.log('[MapPage] 数据已变更，重新加载扇区数据')
      // 重载扇区数据缓存（用于频点提取和工参搜索）
      loadSectorDataForSearch()
      // 刷新在线地图（sectorData state + 图层重绘）
      onlineMapRef.current?.refreshData()
    }
    window.addEventListener(DATA_REFRESH_EVENT, handleDataRefresh)
    return () => window.removeEventListener(DATA_REFRESH_EVENT, handleDataRefresh)
  }, [loadLayerFiles, loadSectorDataForSearch])

  // 搜索模式
  const [searchMode, setSearchMode] = useState<SearchMode>('parameter')

  // 搜索状态
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [showSearchResults, setShowSearchResults] = useState(false)
  const [searching, setSearching] = useState(false)
  const [missingCoordCount, setMissingCoordCount] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Ctrl+F 地图搜索弹窗
  const [searchDialogOpen, setSearchDialogOpen] = useState(false)

  // Ctrl/Cmd+F 调出地图搜索弹窗（preventDefault 屏蔽浏览器原生查找；离线模式无定位能力，不拦截）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (viewMode !== 'online') return
      // 输入框内聚焦时不拦截（允许在弹窗/搜索框内正常编辑文本）
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const key = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && key === 'f') {
        e.preventDefault()
        setSearchDialogOpen(true)
      } else if ((e.ctrlKey || e.metaKey) && key === 'n') {
        // 新建图层（Electron 可拦截；纯浏览器可能被浏览器拦截）
        e.preventDefault()
        setNewLayerDialogOpen(true)
      } else if ((e.ctrlKey || e.metaKey) && key === 's') {
        // 保存（仅当存在未保存编辑时拦截）
        if (selectDirtyLayerIds(useLayerEditStore.getState().workspaces).length > 0) {
          e.preventDefault()
          setSaveDialogOpen(true)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [viewMode])

  // 工具控件状态
  const [measureMode, setMeasureMode] = useState(false)
  const [measurePoints, setMeasurePoints] = useState<Array<{ lng: number; lat: number }>>([])

  // 圈选模式: none, circle, polygon
  const [selectionMode, setSelectionMode] = useState<'none' | 'circle' | 'polygon' | 'point' | 'boundary'>('none')
  const [showSelectionMenu, setShowSelectionMenu] = useState(false)
  const selectionMenuRef = useRef<HTMLDivElement>(null)

  // 点击外部收起下拉菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (selectionMenuRef.current && !selectionMenuRef.current.contains(e.target as Node)) {
        setShowSelectionMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // 地图拖拽工具状态：刷新页面后默认激活手形；若"选择"工具在上次使用中处于激活
  //（selectMode 存于全局 store，跨页面切换持久），则保持选择激活、手形不激活（互斥）
  const [mapDragTool, setMapDragTool] = useState(() => !useLayerEditStore.getState().selectMode)

  /**
   * 是否存在"可见且可选开关打开"的图层。
   * 圈选不再限制可见图层数量/类别；实际圈选目标由 OnlineMap.getSelectionTarget
   * 按 z-order（基站 > 图层文件 > 地理化数据 > 装饰图层，类内按面板顺序）取最高者。
   */
  const hasSelectableLayer = useCallback((): boolean => {
    const selectable = mapSettings.selectableMap ?? {}
    const isOn = (id: string) => selectable[id] !== false
    // 基站（LTE/NR 扇区）
    if (layers.some(l => l.visible && isOn(l.id))) return true
    // 图层文件（MapInfo）
    if (layerFiles.some(f => f.visible && isOn(f.id))) return true
    // 地理化数据（Excel 点/扇区/面文件；自定义图层不参与圈选）
    if (pointFiles.some(f => f.visible && isOn(f.id))) return true
    // 装饰图层（打点/定位标记）
    if (decorationLayer.visible && isOn('decoration-layer')) return true
    return false
  }, [mapSettings.selectableMap, layers, layerFiles, pointFiles, decorationLayer.visible])

  /**
   * 统计"可见且可选开关打开"的图层数量（按图层粒度计数）。
   * 边界选择跨图层收集，要求至少 2 个这样的图层。
   */
  const countSelectableLayers = useCallback((): number => {
    const selectable = mapSettings.selectableMap ?? {}
    const isOn = (id: string) => selectable[id] !== false
    let n = 0
    // 基站（LTE/NR 扇区各算一个图层）
    n += layers.filter(l => l.visible && isOn(l.id)).length
    // 图层文件（MapInfo）
    n += layerFiles.filter(f => f.visible && isOn(f.id)).length
    // 地理化数据
    n += pointFiles.filter(f => f.visible && isOn(f.id)).length
    // 装饰图层
    if (decorationLayer.visible && isOn('decoration-layer')) n += 1
    return n
  }, [mapSettings.selectableMap, layers, layerFiles, pointFiles, decorationLayer.visible])

  /**
   * 处理框选模式切换
   * 框选功能和拖拽工具互斥：激活框选时禁用拖拽工具
   */
  const handleSelectionModeChange = (mode: 'circle' | 'polygon' | 'point' | 'boundary') => {
    // 工具"粘滞"：再次点击已激活的模式不再退出，只能通过切换到其他工具退出
    if (selectionMode === mode) {
      setShowSelectionMenu(false)
      return
    }

    // 边界选择需要至少 2 个"可见且可选"图层（一个提供边界、其余提供被选要素）
    if (mode === 'boundary') {
      if (countSelectableLayers() < 2) {
        alert(t('map.needTwoSelectable') || '边界选择需要至少 2 个图层打开"可选"开关')
        return
      }
    } else if (!hasSelectableLayer()) {
      // 圆形/多边形/框选都需要至少一个"可见且可选"的图层作为圈选目标
      alert(t('map.enableSelectableFirst') || '请先在图层控制面板打开需要圈选图层的"可选"开关（鼠标箭头按钮）')
      return
    }

    setSelectionMode(mode)
    setMeasureMode(false)
    setCaptureMode(false)
    setCaptureCoord(null)
    // 与绘制/选择工具互斥：激活圈选时退出绘制与选择
    useLayerEditStore.getState().setDrawTool('none')
    useLayerEditStore.getState().setSelectMode(false)
    if (mapDragTool) {
      setMapDragTool(false)
    }
    // 激活框选工具后，菜单列表自动收起
    setShowSelectionMenu(false)
  }

  /**
   * 处理地图拖拽工具切换
   * 拖拽工具与其他所有操作模式互斥：激活拖拽时退出所有其他模式。
   * 手形工具保持激活：再次点击不去激活（避免误触失去拖拽），仅可通过点击其他工具切换出去。
   */
  const handleMapDragToolToggle = () => {
    if (mapDragTool) return
    setMapDragTool(true)

    // 激活拖拽：关闭所有其他互斥模式
    setMeasureMode(false)
    setCaptureMode(false)
    setCaptureCoord(null)
    setSelectionMode('none')
    // 与绘制工具互斥：激活拖拽时退出绘制
    useLayerEditStore.getState().setDrawTool('none')
    // 拖拽与"选择"工具互斥
    useLayerEditStore.getState().setSelectMode(false)
    // 注意：不调用 clearSelectionHighlight()，拖拽工具仅负责地图拖拽，不影响已绘制的框选图形和选中高亮
  }

  /**
   * 处理"选择"工具切换：点击要素选中（可编辑图层显示顶点），双击要素弹属性/风格配置。
   * 与圈选/测距/打点/拖拽/绘制全部互斥。
   */
  const handleSelectToolToggle = useCallback(() => {
    const store = useLayerEditStore.getState()
    // 工具"粘滞"：已激活时再次点击不取消，只能通过切换到其他工具退出
    if (store.selectMode) return
    store.setSelectMode(true)
    setMeasureMode(false)
    setCaptureMode(false)
    setCaptureCoord(null)
    setSelectionMode('none')
    setMapDragTool(false)
  }, [])
  const [totalDistance, setTotalDistance] = useState<number | null>(null)
  const [captureMode, setCaptureMode] = useState(false)
  const [captureCoord, setCaptureCoord] = useState<{ lng: number; lat: number } | null>(null)

  /**
   * 处理打点功能被阻止（装饰图层未勾选）
   */
  const handleCaptureBlocked = useCallback(() => {
    alert(t('map.captureRequiresDecorationLayer') || '请先勾选装饰图层后再进行打点操作')
  }, [t])

  // ===== 新建 TAB 图层 / 编辑 / 保存 =====
  const [newLayerDialogOpen, setNewLayerDialogOpen] = useState(false)
  const [joinDialogOpen, setJoinDialogOpen] = useState(false)
  const [bufferDialogOpen, setBufferDialogOpen] = useState(false)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [styleModalTab, setStyleModalTab] = useState<DrawGeometryType | null>(null)
  // 工具栏下拉菜单：'new' 新建 / 'draw' 绘制 / null 关闭
  const [openMenu, setOpenMenu] = useState<'new' | 'draw' | null>(null)
  const [savingLayers, setSavingLayers] = useState(false)
  const newMenuRef = useRef<HTMLDivElement>(null)
  const drawMenuRef = useRef<HTMLDivElement>(null)

  // ===== 工具栏个性化：右键菜单设置标签显隐、拖动调整按钮顺序（按用户持久化） =====
  const [toolbarPrefs, setToolbarPrefs] = useState<ToolbarPrefs>(loadToolbarPrefs)
  const [toolbarMenu, setToolbarMenu] = useState<{ x: number; y: number } | null>(null)
  const toolbarDragIdRef = useRef<string | null>(null)

  // ===== 工具栏收纳：标签全展开时放不下的按钮收进「更多」面板（最右端"》"按钮触发） =====
  // toolbarOverflowStart：第一个被收纳按钮在 order 中的下标（Infinity = 全部放得下）
  const [toolbarOverflowStart, setToolbarOverflowStart] = useState<number>(Number.POSITIVE_INFINITY)
  const [toolbarMoreOpen, setToolbarMoreOpen] = useState(false)
  const [toolbarMoreSubmenu, setToolbarMoreSubmenu] = useState<string | null>(null)
  const toolbarItemsRef = useRef<HTMLDivElement>(null)
  const toolbarMoreRef = useRef<HTMLDivElement>(null)
  const toolbarMoreBtnRef = useRef<HTMLButtonElement>(null)
  const hasToolbarOverflow = toolbarOverflowStart < toolbarPrefs.order.length

  /**
   * 实测工具区可用宽度，计算能完整显示的前 N 个按钮，其余收纳进「更多」面板。
   * 收纳项以 absolute + w-max 保形（不可见但可测宽），因此每次都能测到全部按钮的自然宽度；
   * 需要为「更多」按钮预留宽度，但仅当仍有按钮放不下（最后一个按钮无需预留）。
   */
  const measureToolbarOverflow = useCallback(() => {
    const el = toolbarItemsRef.current
    if (!el) return
    const items = Array.from(el.querySelectorAll<HTMLElement>('[data-toolbar-item]'))
    if (items.length === 0) return
    const gapRaw = Number.parseFloat(getComputedStyle(el).columnGap)
    const gap = Number.isFinite(gapRaw) ? gapRaw : 16
    const moreBtn = toolbarMoreBtnRef.current
    // 「更多」按钮按需占用 宽度 + 间距；它已渲染时容器实测宽度已扣除这部分，需加回来再统一计算，
    // 否则窗口变宽后最后一项永远差一点、按钮无法消失
    const moreWidth = (moreBtn?.offsetWidth ?? 30) + gap
    const avail = el.clientWidth + (moreBtn ? moreWidth : 0)
    let used = 0
    let start = 0
    for (let k = 0; k < items.length; k++) {
      const next = used + items[k].offsetWidth + (k > 0 ? gap : 0)
      const needMore = k + 1 < items.length
      if (next + (needMore ? moreWidth : 0) <= avail) {
        used = next
        start = k + 1
      } else {
        break
      }
    }
    setToolbarOverflowStart((prev) => (prev === start ? prev : start))
  }, [])

  // 每次渲染后重算（按钮标签/徽标/语言切换都会改变宽度）
  useLayoutEffect(() => {
    measureToolbarOverflow()
  })

  // 容器尺寸变化（窗口缩放/侧栏收起）时重算
  useEffect(() => {
    const el = toolbarItemsRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measureToolbarOverflow())
    ro.observe(el)
    return () => ro.disconnect()
  }, [measureToolbarOverflow])

  // 没有收纳项时收起「更多」面板
  useEffect(() => {
    if (!hasToolbarOverflow) {
      setToolbarMoreOpen(false)
      setToolbarMoreSubmenu(null)
    }
  }, [hasToolbarOverflow])

  // 「更多」面板：点击其他处收起
  useEffect(() => {
    if (!toolbarMoreOpen) return
    const close = (e: MouseEvent) => {
      if (toolbarMoreRef.current && !toolbarMoreRef.current.contains(e.target as Node)) {
        setToolbarMoreOpen(false)
        setToolbarMoreSubmenu(null)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [toolbarMoreOpen])

  // 持久化到 localStorage（key 按登录用户区分）
  useEffect(() => {
    try {
      localStorage.setItem(toolbarPrefsKey(), JSON.stringify(toolbarPrefs))
    } catch { /* ignore */ }
  }, [toolbarPrefs])

  // 右键菜单：点击其他处收起
  useEffect(() => {
    if (!toolbarMenu) return
    const close = () => setToolbarMenu(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [toolbarMenu])

  // 拖拽排序：把拖动按钮移动到目标按钮所在位置
  const handleToolbarDrop = useCallback((targetId: string) => {
    const dragId = toolbarDragIdRef.current
    toolbarDragIdRef.current = null
    if (!dragId || dragId === targetId) return
    setToolbarPrefs((p) => {
      const order = [...p.order]
      const from = order.indexOf(dragId as ToolbarItemId)
      const to = order.indexOf(targetId as ToolbarItemId)
      if (from < 0 || to < 0) return p
      order.splice(from, 1)
      order.splice(to, 0, dragId as ToolbarItemId)
      return { ...p, order }
    })
  }, [])

  const editableLayerId = useLayerEditStore((s) => s.editableLayerId)
  const drawTool = useLayerEditStore((s) => s.drawTool)
  const selectMode = useLayerEditStore((s) => s.selectMode)
  const snapEnabled = useLayerEditStore((s) => s.snapEnabled)
  const nodeMergeMode = useLayerEditStore((s) => s.nodeMergeMode)
  const inspectFeature = useLayerEditStore((s) => s.inspectFeature)
  const editWorkspaces = useLayerEditStore((s) => s.workspaces)
  const clipboardItems = useLayerEditStore((s) => s.clipboard)
  // 装饰图层不参与后端保存（自动落 localStorage），从"未保存图层"列表中排除：
  // 避免 Ctrl+S 弹窗/保存角标出现一个点保存无效果的条目
  const dirtyLayerIds = selectDirtyLayerIds(editWorkspaces).filter(id => id !== 'decoration-layer')
  // 粘贴就绪：编辑图层存在、剪贴板非空、且编辑图层处于勾选（可见）状态
  //（去勾选只是隐藏编辑会话渲染，但不允许向看不见的图层粘贴内容；装饰图层恒显）
  const pasteTargetReady = !!editableLayerId
    && clipboardItems.length > 0
    && (editableLayerId === 'decoration-layer' || !!layerFiles.find((f) => f.id === editableLayerId)?.visible)

  /**
   * 装饰图层工作集 → localStorage 持久化（单向回写）。
   * 装饰图层无后端文件，绘制/打点/删除后把工作集要素写回 mapStore.decorationFeatures，
   * 由 zustand persist 落盘（按用户 key）；JSON 比对去重，跳过 seed 后的回声写入。
   */
  const decorationFlushJsonRef = useRef<string>(JSON.stringify(useMapStore.getState().decorationFeatures ?? []))
  useEffect(() => {
    const flush = (features: EditFeature[] | undefined) => {
      if (!features) return
      const json = JSON.stringify(features)
      if (json === decorationFlushJsonRef.current) return
      decorationFlushJsonRef.current = json
      useMapStore.getState().setDecorationFeatures(features)
    }
    const unsub = useLayerEditStore.subscribe((state, prev) => {
      const ws = state.workspaces['decoration-layer']
      if (!ws || ws === prev.workspaces['decoration-layer']) return
      flush(ws.features)
    })
    return unsub
  }, [])

  // 点击外部收起所有工具栏下拉菜单
  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      const t = e.target as Node
      if (
        !newMenuRef.current?.contains(t) &&
        !drawMenuRef.current?.contains(t)
      ) {
        setOpenMenu(null)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  // 新建图层成功：刷新列表后自动进入该图层编辑（默认可编辑）
  const handleLayerCreated = useCallback(async (r: { data_id: string; layer_id: string; name: string; geometry_type?: string; format?: string }) => {
    triggerDataRefresh()
    // 新建图层已注册到 index，须强制重新拉取数据列表；否则 items 仍是旧快照，新图层不会立即出现在图层面板
    await useDataStore.getState().fetchList(1, 50, true)
    try {
      await loadLayerFiles()
    } catch (e) {
      console.error('[MapPage] 新建后刷新图层列表失败', e)
    }
    // 直接建立编辑工作集（beginEdit 同时设 editableLayerId），避免 ensureWorkspace
    // 用旧 layerFiles 闭包找不到刚创建的新图层而跳过初始化，导致绘制要素无处落地。
    // 几何类型按后端返回值初始化：新建的点/线/面 Shapefile 不能当混合图层用。
    useLayerEditStore.getState().beginEdit(
      r.layer_id, r.data_id, (r.geometry_type as any) || 'mixed', [], null,
    )
    // 新图层默认可视 + 可选（可编辑图层一定可选择），便于立即绘制并在地图可见
    useMapStore.getState().setLayerFileVisibility(r.layer_id, true)
    useMapStore.getState().setLayerSelectable(r.layer_id, true)
    setLayerFiles(prev => prev.map(f => f.id === r.layer_id ? { ...f, visible: true } : f))
  }, [loadLayerFiles])

  // 图层面板"可编辑"开关：全局互斥（store 只维护一个 editableLayerId）
  const handleEditableToggle = useCallback((layerId: string, active: boolean) => {
    useLayerEditStore.getState().setEditableLayerId(active ? layerId : null)
    if (active) {
      // 可编辑图层一定可选择：编辑开启时自动打开"可选"开关（若关闭）
      useMapStore.getState().setLayerSelectable(layerId, true)
    }
    // 控制面板"编辑"开关与菜单栏工具（选择/圈选/测距/打点/手形）完全互不影响：
    // 开/关编辑均不改变任何工具状态（工具只能通过切换其他工具退出）
  }, [])

  // 粘贴：把剪贴板中圈选复制的要素（几何+完整属性）插入当前编辑图层
  const handlePasteFeatures = useCallback(() => {
    const store = useLayerEditStore.getState()
    const targetId = store.editableLayerId
    if (!targetId) {
      alert(t('map.enableEditFirst') || '请先在图层控制面板打开一个 TAB 图层的"编辑"开关（铅笔按钮）')
      return
    }
    if (store.clipboard.length === 0) return
    // 目标图层必须处于勾选（可见）状态：去勾选只是隐藏显示、编辑会话保留（未保存更改不丢），
    // 但不允许向看不见的图层写入内容。装饰图层恒显、名称取面板显示名。
    const isDecoration = targetId === 'decoration-layer'
    const targetFile = layerFiles.find(f => f.id === targetId)
    if (!isDecoration && !targetFile?.visible) {
      alert(t('map.pasteTargetHidden')
        || '目标图层当前未勾选（隐藏状态），请先在图层控制面板重新勾选该图层后再粘贴')
      return
    }
    // 执行前弹窗确认（粘贴会直接写入当前编辑图层，避免误粘）
    const targetName = isDecoration ? (t('map.decorationLayer') || '装饰图层') : (targetFile?.name || '')
    const ok = window.confirm(
      t('map.pasteConfirm', { count: store.clipboard.length, name: targetName })
      || `确认把剪贴板中的 ${store.clipboard.length} 个要素粘贴到图层「${targetName}」？`
    )
    if (!ok) return
    for (const item of store.clipboard) {
      const { _editId: _dropId, _isNew: _dropNew, ...props } = (item.properties || {}) as any
      store.addFeature(targetId, item.geometry as any, { ...props, _keepStyle: true })
    }
    console.log('[MapPage] 粘贴要素到图层:', targetName, '数量:', store.clipboard.length)
    alert(t('map.pasteDone', { count: store.clipboard.length, name: targetName })
      || `已粘贴 ${store.clipboard.length} 个要素到图层「${targetName}」`)
  }, [t, layerFiles])

  // 绘制工具切换（与测量/圈选/拖拽/打点互斥）
  const handleDrawTool = useCallback((tool: DrawGeometryType) => {
    const store = useLayerEditStore.getState()
    if (!store.editableLayerId) {
      alert(t('map.enableEditFirst') || '请先在图层控制面板打开一个 TAB 图层的"编辑"开关（铅笔按钮）')
      return
    }
    // 绘制工具"粘滞"：再次点击同一工具不取消，只能通过切换到其他工具退出
    if (store.drawTool === tool) return
    store.setDrawTool(tool)
    setMeasureMode(false)
    setSelectionMode('none')
    setMapDragTool(false)
    setCaptureMode(false)
    setCaptureCoord(null)
  }, [t])

  // 节点捕获：独立开关（与 S 键等价），不与任何工具互斥
  const handleToggleSnap = useCallback(() => {
    useLayerEditStore.getState().toggleSnapEnabled()
  }, [])

  // 节点合并：必须先打开一个图层的"编辑"开关；与绘制/选择/圈选/测距/打点/手形互斥
  const handleToggleNodeMerge = useCallback(() => {
    const store = useLayerEditStore.getState()
    if (!store.nodeMergeMode && !store.editableLayerId) {
      alert(t('map.mergeNeedEditableLayer') || '请先在图层控制面板打开一个图层的"编辑"开关，再使用节点合并')
      return
    }
    const next = !store.nodeMergeMode
    store.setNodeMergeMode(next)
    setMeasureMode(false)
    setCaptureMode(false)
    setCaptureCoord(null)
    setSelectionMode('none')
    setMapDragTool(false)
  }, [t])

  // 保存勾选的未保存图层
  // 把勾选图层的工作集保存落盘（返回 {name, ok, error}[]；成功图层清脏）
  const saveSelectedToStore = useCallback(async (selectedIds: string[]) => {
    const results: Array<{ name: string; ok: boolean; layerId?: string; dataId?: string; error?: string; mode?: string }> = []
    for (const layerId of selectedIds) {
      // 装饰图层无后端文件（改动自动落 localStorage），不进入保存链路
      if (layerId === 'decoration-layer') continue
      const ws = useLayerEditStore.getState().getWorkspace(layerId)
      const lf = layerFiles.find((f) => f.id === layerId)
      if (!ws || !lf) continue
      // 保存计划：有基底版本指纹时只回传变更要素（大图层省掉整层上传/解析），否则整层保存。
      // 增量保存仅 TAB 支持（SHP/GeoJSON 的样式在 .qml），其余格式直接整层。
      const plan = buildSavePlan(ws, { allowPatch: lf.format === 'tab' })
      if (plan.mode === 'none') {
        // 无有效变更（如新增后又删除）：不写盘，仅清脏并保持基底版本
        useLayerEditStore.getState().markSaved(layerId, { remapRows: true, version: ws.version })
        results.push({ name: lf.name, ok: true, layerId, dataId: ws.dataId, mode: 'none' })
        continue
      }
      const save = async (payload: { geojson?: any; patch?: any }) =>
        layerApi.saveLayerData(ws.dataId, layerId, payload)
      try {
        let mode: string = plan.mode
        let resp: any
        try {
          resp = await save(plan.payload)
        } catch (e: any) {
          // 409：基底已被其它会话改写（axios 非 2xx 走 reject）→ 回退整层保存，本次改动不丢
          if (e?.response?.status === 409 && plan.mode === 'patch') {
            console.warn('[MapPage] 增量保存基底冲突，回退整层保存:', lf.name)
            mode = 'full'
            resp = await save({ geojson: { type: 'FeatureCollection', features: ws.features } })
          } else {
            throw e
          }
        }
        const data: any = (resp as any)?.data ?? {}
        if (resp.success) {
          // 服务端要素数与工作集一致时才重排基底行号，否则清空基底（下次自动整层保存）
          const remapRows = Number(data.feature_count) === ws.features.length
          useLayerEditStore.getState().markSaved(layerId, { remapRows, version: data.version ?? null })
          results.push({ name: lf.name, ok: true, layerId, dataId: ws.dataId, mode: data.mode ?? mode })
          // 先丢弃保存前的旧缓存，再用编辑工作集（刚写入的内容）重建地图上的原始图层：
          // 既避免保存后再下载整层（40MB 级图层重新拉取 + 解析额外卡顿数秒），也保证不残留旧数据
          useMapDataCacheStore.getState().invalidateLayer(layerId)
          const fresh = useLayerEditStore.getState().getWorkspace(layerId)
          void onlineMapRef.current?.refreshLayerData(layerId, {
            data: fresh
              ? { type: 'FeatureCollection', features: fresh.features }
              : undefined,
            version: data.version ?? null,
          })
        } else {
          results.push({ name: lf.name, ok: false, error: (resp as any)?.message })
        }
      } catch (e: any) {
        const detail = e?.response?.data?.detail || e?.message
        results.push({ name: lf.name, ok: false, error: detail })
      }
    }
    // 以 layer 范围刷新数据列表：数据条目本身未变，地图页无需重载扇区数据/重绘
    // （图层缓存已在保存成功处精确失效并按工作集重建，扇区/其它图层数据未变）
    triggerDataRefresh('layer')
    return results
  }, [layerFiles])

  // 缓冲区写入 TAB 图层后的刷新：失效图层缓存并重新拉取，刷新数据列表（口径同保存链路）
  const handleBufferSaved = useCallback((layerId: string) => {
    useMapDataCacheStore.getState().invalidateLayer(layerId)
    void onlineMapRef.current?.refreshLayerData(layerId, {})
    triggerDataRefresh('layer')
  }, [])

  // 保存：仅把编辑结果写回库（MapInfo TAB），不触发任何下载
  const handleSaveLayers = useCallback(async (selectedIds: string[]) => {
    if (selectedIds.length === 0) return
    setSavingLayers(true)
    const results = await saveSelectedToStore(selectedIds)
    setSavingLayers(false)
    setSaveDialogOpen(false)
    const failed = results.filter((r) => !r.ok)
    if (failed.length > 0) {
      alert(`${t('map.saveLayerFailed') || '部分图层保存失败'}:\n` + failed.map((f) => `${f.name}: ${f.error || ''}`).join('\n'))
    }
  }, [saveSelectedToStore, t])

  // 另存为：保存落盘后弹出路径选择框，把 MapInfo 全套文件（.tab/.dat/.id/.map）zip 写到用户指定位置
  const handleSaveLayersAs = useCallback(async (selectedIds: string[]) => {
    if (selectedIds.length === 0) return
    setSavingLayers(true)
    const results = await saveSelectedToStore(selectedIds)
    const okLayers = results.filter((r) => r.ok && r.layerId && r.dataId)
    for (const r of okLayers) {
      // 先弹路径选择框（依赖用户手势），再取数据写入
      let target: SaveTarget | null
      try {
        target = await pickSaveTarget(`${r.name}.tab.zip`)
      } catch (e: any) {
        target = { kind: 'download' }
      }
      if (!target) continue // 用户取消路径选择
      try {
        const { blob, filename } = await layerApi.fetchLayerZip(r.dataId!, r.layerId!, r.name)
        await writeSaveTarget(target, blob, filename)
      } catch (e: any) {
        console.error('[MapPage] 另存为失败', r.name, e)
        results.push({ name: r.name, ok: false, error: e?.message || '导出失败' })
      }
    }
    setSavingLayers(false)
    setSaveDialogOpen(false)
    const failed = results.filter((r) => !r.ok)
    if (failed.length > 0) {
      alert(`${t('map.saveLayerFailed') || '部分图层保存失败'}:\n` + failed.map((f) => `${f.name}: ${f.error || ''}`).join('\n'))
    }
  }, [saveSelectedToStore, t])

  const dirtyLayerItems: DirtyLayerItem[] = dirtyLayerIds
    .map((layerId) => ({
      layerId,
      name: layerFiles.find((f) => f.id === layerId)?.name || layerId,
      changeCount: editWorkspaces[layerId]?.changeCount ?? 0,
    }))

  // 撤销（当前编辑图层）：工具栏按钮 / Ctrl+Z
  const canUndoNow = !!editableLayerId && useLayerEditStore.getState().canUndo(editableLayerId)
  const handleUndo = useCallback(() => {
    const id = useLayerEditStore.getState().editableLayerId
    if (id) useLayerEditStore.getState().undo(id)
  }, [])

  // Ctrl/Cmd+Z 撤销（先让 OnlineMap 的绘制态键优先处理 Backspace/Esc）
  useEffect(() => {
    const onUndoKey = (e: KeyboardEvent) => {
      if (viewMode !== 'online') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        const st = useLayerEditStore.getState()
        if (st.editableLayerId) {
          e.preventDefault()
          st.undo(st.editableLayerId)
        }
      }
    }
    window.addEventListener('keydown', onUndoKey)
    return () => window.removeEventListener('keydown', onUndoKey)
  }, [viewMode])

  // 从mapStore获取定位点数据
  const { locationPoints, addLocationPoint, clearLocationPoints } = useMapStore()

  // 更新装饰图层计数（打点数量 + 定位点数量）
  useEffect(() => {
    setDecorationLayer(prev => ({
      ...prev,
      count: locationPoints.length
    }))
  }, [locationPoints])

  // 工参数据缓存（用于工参搜索）
  const [sectorDataCache, setSectorDataCache] = useState<{
    lte: RenderSectorData[]
    nr: RenderSectorData[]
  }>({ lte: [], nr: [] })

  // 使用ref保存最新的sectorDataCache状态，解决闭包问题
  const sectorDataCacheRef = useRef(sectorDataCache)

  // 当sectorDataCache状态更新时，同步更新ref
  useEffect(() => {
    sectorDataCacheRef.current = sectorDataCache
  }, [sectorDataCache])

  // 地图组件引用
  const onlineMapRef = useRef<OnlineMapRef>(null)

  // 基站图层"默认设置"（图形透明度/边框宽度）恢复：store 变化时下发到渲染器。
  // 扇区图层若在设置恢复前已构建完成（createSectorLayers 只读一次 store），
  // 不补发会一直按 SECTOR_CONFIG 默认渲染。
  useEffect(() => {
    const colorMap = mapSettings.colorSettingsMap ?? {}
    for (const layerId of ['lte-sectors', 'nr-sectors']) {
      const c = colorMap[layerId]
      if (c && onlineMapRef.current) {
        onlineMapRef.current.setSectorColorSettings(layerId, {
          fillOpacity: c.fillOpacity,
          borderWidth: c.borderWidth,
          ...(c.pciRenderEnabled ? { pciRenderEnabled: true, pciMod: c.pciMod ?? 3 } : {})
        })
      }
    }
  }, [mapSettings.colorSettingsMap])

  /**
   * 工参搜索定位前确保目标制式扇区图层可见（总开关+频点全可见+持久化）。
   * 图层未勾选时扇区图形不渲染，红框高亮会无目标，与图层文件搜索自动开启图层行为对齐。
   */
  const ensureSectorLayerVisible = useCallback((networkType?: string) => {
    const net: 'lte' | 'nr' = networkType === 'NR' ? 'nr' : 'lte'
    const layerId = net === 'lte' ? 'lte-sectors' : 'nr-sectors'
    const layer = layers.find(l => l.id === layerId)
    if (layer?.visible) return

    setLayers(prev => prev.map(l => (l.id === layerId ? { ...l, visible: true } : l)))
    const currentVis = useMapStore.getState().mapSettings.layerVisibility
    storeSetLayerVisibility(
      net === 'lte' ? true : currentVis.lte,
      net === 'nr' ? true : currentVis.nr
    )
    // 勾选总开关时该制式所有频点设为可见
    setFrequencies(prev => ({
      ...prev,
      [net]: prev[net].map(f => ({ ...f, visible: true }))
    }))
    onlineMapRef.current?.setLayerVisibility(net, true)
  }, [layers, storeSetLayerVisibility])

  /**
   * 选择搜索结果并定位
   */
  const selectSearchResult = useCallback((result: SearchResult) => {
    if (result.type === 'place') {
      // 地名搜索 - 高德API返回的坐标已经是GCJ02坐标系
      const parts = result.location.split(',')
      if (parts.length !== 2) return

      const gcjLng = parseFloat(parts[0])
      const gcjLat = parseFloat(parts[1])

      if (onlineMapRef.current) {
        onlineMapRef.current.flyTo([gcjLat, gcjLng], 15)
        onlineMapRef.current.setSearchMarker({ lng: gcjLng, lat: gcjLat, name: result.name })
      }
    } else {
      // 工参搜索：红色边框高亮目标扇区图形本身并飞行定位（与图层文件搜索一致，不再放中心标记点）
      if (result.hasLocation && result.latitude !== undefined && result.longitude !== undefined && onlineMapRef.current) {
        // 目标制式图层未勾选时自动开启（总开关+频点全可见），否则扇区图形不渲染、红框高亮无目标
        ensureSectorLayerVisible(result.networkType)
        onlineMapRef.current.locateSector({
          id: result.id,
          lat: result.latitude,
          lng: result.longitude
        })
      }
    }

    setSearchKeyword(result.name)
    setShowSearchResults(false)
  }, [ensureSectorLayerVisible])

  /**
   * 搜索弹窗：工参搜索，直接复用原"搜索定位"工参模式逻辑
   * （当前数据源 LTE/NR 小区缓存，匹配小区名/基站ID/小区ID，坐标为已转换的 displayLat/displayLng）
   */
  const handleDialogSearchWorkbook = useCallback((keyword: string) => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return []
    const all = [...sectorDataCacheRef.current.lte, ...sectorDataCacheRef.current.nr]
    return all
      .filter(s => {
        const nameMatch = s.name && s.name.toLowerCase().includes(kw)
        const siteIdMatch = s.siteId && s.siteId.toLowerCase().includes(kw)
        const sectorIdMatch = s.sectorId && s.sectorId.toLowerCase().includes(kw)
        return nameMatch || siteIdMatch || sectorIdMatch
      })
      .slice(0, 50)
      .map(s => ({
        id: String(s.id),
        name: s.name || '未命名',
        networkType: s.networkType,
        siteId: s.siteId,
        sectorId: s.sectorId,
        lat: s.displayLat,
        lng: s.displayLng
      }))
  }, [])

  /**
   * 搜索弹窗：工参结果定位（红色边框高亮扇区图形本身 + 飞行定位，与原搜索框工参定位一致）
   * 目标制式图层未勾选时自动开启，否则扇区不渲染、红框无目标
   */
  const handleDialogLocateSector = useCallback((r: { id: string; lat: number; lng: number; networkType?: string }) => {
    if (!onlineMapRef.current) return
    ensureSectorLayerVisible(r.networkType)
    onlineMapRef.current.locateSector({
      id: r.id,
      lat: r.lat,
      lng: r.lng
    })
  }, [ensureSectorLayerVisible])

  /**
   * 搜索弹窗：图层文件/地理化要素定位
   * 图层未勾选时自动开启（搜索定位不受框选互斥限制），OnlineMap 监听 props 变化后懒加载，
   * 再由 locateLayerFeature 等待图层可见 → 红色边框高亮 → 飞行定位
   */
  const handleDialogLocateLayerFeature = useCallback(async (opts: {
    layerId: string
    featureId: string
    center?: [number, number]
    bounds?: [[number, number], [number, number]]
  }) => {
    const inLayerFiles = layerFiles.some(f => f.id === opts.layerId)
    const target = (inLayerFiles ? layerFiles : pointFiles).find(f => f.id === opts.layerId)
    if (target && !target.visible) {
      if (inLayerFiles) {
        setLayerFiles(prev => prev.map(f => (f.id === opts.layerId ? { ...f, visible: true } : f)))
        storeSetLayerFileVisibility(opts.layerId, true)
      } else {
        setPointFiles(prev => prev.map(f => (f.id === opts.layerId ? { ...f, visible: true } : f)))
        storeSetPointFileVisibility(opts.layerId, true)
      }
    }
    if (!onlineMapRef.current) return false
    return onlineMapRef.current.locateLayerFeature(opts)
  }, [layerFiles, pointFiles, storeSetLayerFileVisibility, storeSetPointFileVisibility])



  /**
   * 切换自定义图层可见性
   */
  const handleCustomLayerToggle = useCallback((layerId: string, visible: boolean) => {
    setCustomLayers(prev => prev.map(layer =>
      layer.id === layerId ? { ...layer, visible } : layer
    ))

    if (onlineMapRef.current) {
      onlineMapRef.current.setCustomLayerVisibility(layerId, visible)
    }
  }, [])

  /**
   * 切换图层文件可见性 (MapInfo 和 Excel)
   */
  const handleLayerFileToggle = useCallback((fileId: string, visible: boolean) => {
    console.log('[MapPage] handleLayerFileToggle:', fileId, 'visible:', visible)

    // 勾选/去勾选图层只改可见性，不影响"编辑"等其他开关状态
    // （去勾选当前编辑图层时编辑会话保持激活，重新勾选后可继续编辑，未保存更改不丢）

    // 圈选模式下不再限制勾选图层数量：圈选目标由"可选"开关 + 图层层级决定
    // （z-order 最高且可选开关打开的图层被圈选，其余可见图层仅展示）

    setLayerFiles(prev => prev.map(f =>
      f.id === fileId ? { ...f, visible } : f
    ))
    setPointFiles(prev => prev.map(f =>
      f.id === fileId ? { ...f, visible } : f
    ))

    // 同步到持久化 store
    // 判断是 MapInfo 文件还是 Excel 点文件
    const isInLayerFiles = layerFiles.some(f => f.id === fileId)
    if (isInLayerFiles) {
      storeSetLayerFileVisibility(fileId, visible)
    } else {
      storeSetPointFileVisibility(fileId, visible)
    }

    // 注意：不需要调用 onlineMapRef.current.setMapInfoLayerVisibility
    // 因为 OnlineMap 组件会通过 useEffect 监听 layerFiles prop 的变化自动处理
  }, [layerFiles, storeSetLayerFileVisibility, storeSetPointFileVisibility])

  /**
   * 切换图层"可选"开关（控制面板鼠标箭头按钮）
   * 仅 z-order 最高（跨类固定 基站>图层文件>地理化数据>装饰，类内按面板顺序）且开关打开的图层被圈选
   */
  const handleSelectableToggle = useCallback((layerId: string, selectable: boolean) => {
    // 可编辑图层一定可选择：编辑开启时不可关闭该图层的"可选"开关
    const editableId = useLayerEditStore.getState().editableLayerId
    if (!selectable && editableId === layerId) return
    storeSetLayerSelectable(layerId, selectable)
  }, [storeSetLayerSelectable])

  /**
   * 类别内图层拖拽排序：newOrder 为该类别完整的图层 id 顺序（索引 0 = 面板最上）
   */
  const handleReorderLayers = useCallback((category: LayerCategory, newOrder: string[]) => {
    storeSetLayerOrder(category, newOrder)
  }, [storeSetLayerOrder])

  /**
   * 移除图层文件 (MapInfo)
   */
  const handleRemoveLayerFile = useCallback(async (fileId: string) => {
    try {
      // 使用 dataStore 的 deleteItem 方法，确保与数据管理模块同步，并自动刷新列表
      const success = await useDataStore.getState().deleteItem(fileId)
      if (success) {
        console.log('[MapPage] 移除图层文件成功:', fileId)
        // 重新加载图层列表 (此时 store 中的 items 已经更新)
        await loadLayerFiles()
      }
    } catch (error) {
      console.error('[MapPage] 移除图层文件失败:', error)
    }
  }, [loadLayerFiles])

  /**
   * 移除自定义图层 (创建点)
   */
  const handleRemoveCustomLayer = useCallback((layerId: string) => {
    setCustomLayers(prev => prev.filter(layer => layer.id !== layerId))
    if (onlineMapRef.current) {
      onlineMapRef.current.setCustomLayerVisibility(layerId, false)
    }
  }, [])

  /**
   * 处理装饰图层标签可见性切换
   */
  const handleDecorationLabelToggle = useCallback((visible: boolean) => {
    console.log('[MapPage] 装饰图层标签切换:', visible)
    setDecorationLabelVisible(visible)
    storeSetDecorationLabelVisible(visible)
    if (onlineMapRef.current) {
      onlineMapRef.current.setDecorationLabelVisibility(visible)
    }
  }, [storeSetDecorationLabelVisible])

  /**
   * 加载工参数据用于搜索
   */
  const executeParameterSearch = useCallback(async (keyword: string) => {
    if (!keyword.trim()) {
      setSearchResults([])
      setShowSearchResults(false)
      return
    }

    setSearching(true)
    try {
      // 直接使用缓存的数据，避免重复加载
      // 数据已在组件加载时通过useEffect预加载
      const allSectors = [...sectorDataCacheRef.current.lte, ...sectorDataCacheRef.current.nr]

      const lowerKeyword = keyword.toLowerCase()

      // 优化搜索算法：使用更高效的搜索方式，限制结果数量
      const matched = allSectors.filter(sector => {
        const nameMatch = sector.name && sector.name.toLowerCase().includes(lowerKeyword)
        const siteIdMatch = sector.siteId && sector.siteId.toLowerCase().includes(lowerKeyword)
        const sectorIdMatch = sector.sectorId && sector.sectorId.toLowerCase().includes(lowerKeyword)
        return nameMatch || siteIdMatch || sectorIdMatch
      }).slice(0, 20) // 限制最多显示20条结果，提高渲染性能

      const results: ParameterSearchResult[] = matched.map(sector => ({
        type: 'parameter',
        id: sector.id,
        name: sector.name || '未命名',
        networkType: sector.networkType,
        siteId: sector.siteId,
        sectorId: sector.sectorId,
        latitude: sector.displayLat,
        longitude: sector.displayLng,
        hasLocation: !!sector.displayLat && !!sector.displayLng
      }))

      setSearchResults(results)
      // 延迟设置showSearchResults，确保searchResults已经更新
      setTimeout(() => {
        setShowSearchResults(true)
      }, 0)
    } catch (error) {
      setSearchResults([])
      setShowSearchResults(true)
    } finally {
      setSearching(false)
    }
  }, [])

  /**
   * 预加载工参数据
   */
  useEffect(() => {
    const preloadSectorData = async () => {
      try {
        await loadSectorDataForSearch()
      } catch (error) {
        console.error('[MapPage] 预加载工参数据失败:', error)
      }
    }

    preloadSectorData()
  }, [loadSectorDataForSearch])

  /**
   * 扫描扇区数据提取频点列表
   * 注意：移除了layers依赖，避免图层总开关切换时重新扫描频点
   */
  useEffect(() => {
    const extractFrequencies = () => {
      const lteFreqCountMap = new Map<number, number>()
      const nrFreqCountMap = new Map<number, number>()

      // 扫描LTE扇区频点并统计小区数量
      sectorDataCache.lte.forEach(sector => {
        if (sector.frequency && sector.frequency > 0) {
          const currentCount = lteFreqCountMap.get(sector.frequency) || 0
          lteFreqCountMap.set(sector.frequency, currentCount + 1)
        }
      })

      // 扫描NR扇区频点并统计小区数量
      sectorDataCache.nr.forEach(sector => {
        if (sector.frequency && sector.frequency > 0) {
          const currentCount = nrFreqCountMap.get(sector.frequency) || 0
          nrFreqCountMap.set(sector.frequency, currentCount + 1)
        }
      })

      // 清除旧的颜色映射
      frequencyColorMapper.clear()

      // 恢复用户自定义频点配色（数据刷新后仍生效，从持久化 store 读取避免闭包过期）
      frequencyColorMapper.loadCustomColors(useMapStore.getState().mapSettings.frequencyCustomColors)

      // 检查是否是首次初始化
      const isFirstInit = !frequenciesInitializedRef.current

      // 获取扇区图层总开关状态（仅在首次初始化时使用）
      let lteLayerVisible = false
      let nrLayerVisible = false
      if (isFirstInit) {
        lteLayerVisible = layers.find(l => l.id === 'lte-sectors')?.visible ?? false
        nrLayerVisible = layers.find(l => l.id === 'nr-sectors')?.visible ?? false
      }

      // 为LTE频点生成颜色和小区数量
      const lteFrequencies: FrequencyOption[] = Array.from(lteFreqCountMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([freq, count]) => {
          const colorObj = frequencyColorMapper.getColor(freq, 'LTE')
          // 首次初始化时根据图层总开关设置，之后保持用户的选择
          let visible = false
          if (isFirstInit) {
            visible = lteLayerVisible
          } else {
            const existingFreq = frequencies.lte.find(f => f.frequency === freq)
            visible = existingFreq?.visible ?? false
          }
          return {
            frequency: freq,
            color: colorObj.color,
            strokeColor: colorObj.strokeColor,
            visible: visible,
            networkType: 'LTE' as const,
            count: count // 添加小区数量
          }
        })

      // 为NR频点生成颜色和小区数量
      const nrFrequencies: FrequencyOption[] = Array.from(nrFreqCountMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([freq, count]) => {
          const colorObj = frequencyColorMapper.getColor(freq, 'NR')
          // 首次初始化时根据图层总开关设置，之后保持用户的选择
          let visible = false
          if (isFirstInit) {
            visible = nrLayerVisible
          } else {
            const existingFreq = frequencies.nr.find(f => f.frequency === freq)
            visible = existingFreq?.visible ?? false
          }
          return {
            frequency: freq,
            color: colorObj.color,
            strokeColor: colorObj.strokeColor,
            visible: visible,
            networkType: 'NR' as const,
            count: count // 添加小区数量
          }
        })

      setFrequencies({
        lte: lteFrequencies,
        nr: nrFrequencies
      })

      // 标记为已初始化
      frequenciesInitializedRef.current = true
    }

    // 只在数据加载完成后扫描
    if (sectorDataCache.lte.length > 0 || sectorDataCache.nr.length > 0) {
      extractFrequencies()
    }
  }, [sectorDataCache.lte, sectorDataCache.nr])


  /**
   * 渲染定位点 - 当组件挂载或locationPoints变化时
   */
  useEffect(() => {
    if (onlineMapRef.current && locationPoints.length > 0) {
      // 重新添加所有定位点标记
      locationPoints.forEach((point, index) => {
        onlineMapRef.current?.addLocationMarker(point, index + 1)
      })
    }
  }, [locationPoints])

  /**
   * 执行地名搜索
   */
  const executeMapSearch = useCallback(async (keyword: string) => {
    if (!keyword.trim()) {
      setSearchResults([])
      setShowSearchResults(false)
      return
    }

    setSearching(true)
    try {
      // 使用高德Place Text API进行模糊搜索
      const apiKey = '5299af602f4ee3cd7351c1bc7f32b1cb'
      const url = `https://restapi.amap.com/v3/place/text?key=${apiKey}&keywords=${encodeURIComponent(keyword)}&output=json&citylimit=10`

      const response = await fetch(url)
      const data = await response.json()

      if (data.status === '1' && data.pois && data.pois.length > 0) {
        const results: PlaceSearchResult[] = data.pois.map((poi: any) => ({
          type: 'place',
          name: poi.name,
          address: poi.address || '',
          district: poi.pname || poi.cityname || '',
          location: poi.location,  // GCJ02坐标
          adcode: poi.adcode || ''
        }))
        setSearchResults(results)
        // 延迟设置showSearchResults，确保searchResults已经更新
        setTimeout(() => {
          setShowSearchResults(true)
          console.log('Search results set, showSearchResults:', true)
        }, 0)
      } else {
        setSearchResults([])
        // 延迟设置showSearchResults，确保searchResults已经更新
        setTimeout(() => {
          setShowSearchResults(true)
          console.log('Search results set, showSearchResults:', true)
        }, 0)
      }
    } catch (err) {
      console.error('[MapPage] 地名查询失败:', err)
      setSearchResults([])
      setShowSearchResults(true)
    } finally {
      setSearching(false)
    }
  }, [])

  /**
   * 执行搜索（根据模式分发）
   */
  const executeSearch = useCallback(async (keyword: string) => {
    if (searchMode === 'parameter') {
      await executeParameterSearch(keyword)
    } else {
      await executeMapSearch(keyword)
    }
  }, [searchMode, executeParameterSearch, executeMapSearch])

  /**
   * 处理输入变化 - 添加防抖机制
   */
  // 防抖定时器引用
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setSearchKeyword(value)

    // 清除之前的定时器
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    // 实时搜索，显示预览结果 - 添加150ms防抖
    if (value.trim()) {
      debounceTimerRef.current = setTimeout(() => {
        executeSearch(value)
      }, 150)
    } else {
      setSearchResults([])
      setShowSearchResults(false)
    }
  }

  /**
   * 检测输入是否为经纬度格式（经度,纬度）
   * 支持中英文逗号分隔
   */
  const isCoordinateInput = useCallback((input: string): { isValid: boolean; lng?: number; lat?: number } => {
    const trimmed = input.trim()
    // 匹配经纬度格式：数字,数字 或 数字，数字（支持中英文逗号）
    const coordRegex = /^\s*(-?\d+\.?\d*)\s*[，,]\s*(-?\d+\.?\d*)\s*$/
    const match = trimmed.match(coordRegex)
    if (match) {
      const lng = parseFloat(match[1])
      const lat = parseFloat(match[2])
      // 验证经纬度范围
      if (!isNaN(lng) && !isNaN(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
        return { isValid: true, lng, lat }
      }
    }
    return { isValid: false }
  }, [])

  /**
   * 执行坐标定位
   */
  const executeCoordinateLocation = useCallback((lng: number, lat: number) => {
    // WGS84 转 GCJ02
    const [correctedLat, correctedLng] = CoordinateTransformer.wgs84ToGcj02(lat, lng)
    const id = `location-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const newPoint = { id, lng: correctedLng, lat: correctedLat }
    addLocationPoint(newPoint)
    if (onlineMapRef.current) {
      onlineMapRef.current.flyTo([correctedLat, correctedLng], 15)
    }
    // 定位点标记由 locationPoints 驱动的 useEffect 统一添加，
    // 此处不再重复调用 addLocationMarker，避免与 effect 产生重复标记/标签
  }, [addLocationPoint])

  /**
   * 处理搜索或定位动作（点击放大镜按钮或回车）
   */
  const handleSearchAction = useCallback(() => {
    const keyword = searchKeyword.trim()
    if (!keyword) return

    // 优先检测是否为经纬度格式
    const coordCheck = isCoordinateInput(keyword)
    if (coordCheck.isValid && coordCheck.lng !== undefined && coordCheck.lat !== undefined) {
      // 是经纬度格式，执行坐标定位
      executeCoordinateLocation(coordCheck.lng, coordCheck.lat)
      setSearchResults([])
      setShowSearchResults(false)
      return
    }

    // 不是经纬度格式，执行普通搜索
    if (searchResults.length > 0) {
      selectSearchResult(searchResults[0])
    } else {
      executeSearch(keyword)
    }
  }, [searchKeyword, isCoordinateInput, executeCoordinateLocation, searchResults, selectSearchResult, executeSearch])

  /**
   * 处理回车键
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSearchAction()
    }
  }

  /**
   * 清除搜索输入 - 只清空输入框和搜索结果，不清除地图标记
   */
  const clearSearchInput = () => {
    setSearchKeyword('')
    setSearchResults([])
    setShowSearchResults(false)
    if (searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }

  /**
   * 清除所有搜索 - 清空搜索结果和地图标记，但保留搜索框内容
   */
  const clearAllSearch = () => {
    setSearchResults([])
    setShowSearchResults(false)
    if (onlineMapRef.current) {
      onlineMapRef.current.clearSearchMarker()
      onlineMapRef.current.clearLocationMarkers()
      onlineMapRef.current.clearMeasurements()
      // 同步清除搜索定位产生的红色高亮（图层文件/地理化要素 + 工参扇区）
      onlineMapRef.current.clearLayerFeatureHighlight()
      onlineMapRef.current.clearSectorHighlight()
    }
    // 清空定位点和测量点
    clearLocationPoints() // 使用全局store清除定位点
    setMeasurePoints([])
    setTotalDistance(null)
    // 注意：此处不退出测量工具（clearMeasurements 已清地图轨迹），
    // 工具"粘滞"语义 —— 清除≠退出，退出需切换其他工具
    if (searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }

  /**
   * 处理图层切换
   */
  const handleLayerToggle = useCallback((layerId: string, visible: boolean) => {
    console.log('[MapPage] Layer toggle:', layerId, visible)

    // 更新图层状态
    setLayers(prev => prev.map(layer =>
      layer.id === layerId ? { ...layer, visible } : layer
    ))

    let networkTypeLower: 'lte' | 'nr' | null = null
    let networkType: 'LTE' | 'NR' | null = null

    // 确定网络类型
    if (layerId === 'lte-sectors') {
      networkTypeLower = 'lte'
      networkType = 'LTE'
    } else if (layerId === 'nr-sectors') {
      networkTypeLower = 'nr'
      networkType = 'NR'
    }

    if (networkTypeLower && networkType) {
      // 同步到持久化 store（使用 getState 获取最新值，避免闭包过期）
      const currentVis = useMapStore.getState().mapSettings.layerVisibility
      storeSetLayerVisibility(
        networkTypeLower === 'lte' ? visible : currentVis.lte,
        networkTypeLower === 'nr' ? visible : currentVis.nr
      )

      // 扇区总开关现在是"快捷方式"：
      // - 勾选时：所有频点设为可见（显示所有扇区）
      // - 取消勾选时：所有频点设为不可见（隐藏所有扇区）
      // - 用户仍可单独控制每个频点的显示/隐藏
      setFrequencies(prev => ({
        ...prev,
        [networkTypeLower]: prev[networkTypeLower].map(freq => ({ ...freq, visible }))
      }))

      // 通知地图组件显示/隐藏扇区图层
      if (onlineMapRef.current) {
        onlineMapRef.current.setLayerVisibility(networkTypeLower, visible)
      }
    }
  }, [storeSetLayerVisibility])

  /**
   * 处理地图类型切换
   */
  const handleMapTypeChange = useCallback((type: 'roadmap' | 'satellite') => {
    console.log('[MapPage] Map type change:', type)
    setMapType(type)
    storeSetMapType(type)
    // 调用 OnlineMap 的 setMapType 方法直接设置地图类型
    if (onlineMapRef.current) {
      console.log('[MapPage] Calling onlineMapRef.current.setMapType')
      onlineMapRef.current.setMapType(type)
    }
  }, [storeSetMapType])

  /**
   * 处理在线地图可见性切换
   */
  const handleOnlineMapToggle = useCallback((visible: boolean) => {
    console.log('[MapPage] Online map visibility toggle:', visible)
    setOnlineMapVisible(visible)
    storeSetBaseMapVisible(visible)
    // 调用 OnlineMap 的 setBaseMapVisibility 方法
    if (onlineMapRef.current) {
      onlineMapRef.current.setBaseMapVisibility(visible)
    }
  }, [storeSetBaseMapVisible])

  /**
   * 处理频点可见性切换
   */
  const handleFrequencyToggle = useCallback((networkType: 'LTE' | 'NR', frequency: number, visible: boolean) => {
    console.log('[MapPage] Frequency toggle:', networkType, frequency, visible)

    const networkTypeLower = networkType.toLowerCase() as 'lte' | 'nr'
    const layerId = networkTypeLower === 'lte' ? 'lte-sectors' : 'nr-sectors'

    // 更新本地频点状态
    setFrequencies(prev => {
      const updated = {
        ...prev,
        [networkTypeLower]: prev[networkTypeLower].map(freq =>
          freq.frequency === frequency ? { ...freq, visible } : freq
        )
      }

      console.log('[MapPage] Updated frequencies:', updated[networkTypeLower].map(f => ({ freq: f.frequency, visible: f.visible })))

      // 检查是否还有勾选的频点
      const hasVisibleFrequency = updated[networkTypeLower].some(freq => freq.visible)
      console.log('[MapPage] Has visible frequency:', hasVisibleFrequency)

      return updated
    })

    // 关键修复：当勾选某个频点时，如果父图层不可见，自动启用父图层
    // 这样可以确保频点显示功能正常工作
    if (visible) {
      const currentLayer = layers.find(l => l.id === layerId)
      if (currentLayer && !currentLayer.visible) {
        console.log('[MapPage] 自动启用父图层以显示频点:', layerId)
        // 更新图层状态
        setLayers(prev => prev.map(layer =>
          layer.id === layerId ? { ...layer, visible: true } : layer
        ))
        // 通知地图组件显示扇区图层
        if (onlineMapRef.current) {
          onlineMapRef.current.setLayerVisibility(networkTypeLower, true)
        }
      }
    }

    // 通知地图组件更新频点可见性
    if (onlineMapRef.current) {
      onlineMapRef.current.setFrequencyVisibility(networkType, frequency, visible)
    }
  }, [layers])

  /**
   * 处理频点自定义配色变化（默认设置模式下点击频点色块）
   * 更新颜色映射器 + 持久化 store + 色块显示，并刷新已渲染扇区
   */
  const handleFrequencyColorChange = useCallback((networkType: 'LTE' | 'NR', frequency: number, colors: { color: string; strokeColor: string }) => {
    console.log('[MapPage] Frequency color change:', networkType, frequency, colors)

    // 1. 更新颜色映射器（内存立即生效，getSectorColor 下次调用返回新色）
    frequencyColorMapper.setCustomColor(frequency, networkType, colors.color, colors.strokeColor)

    // 2. 持久化到 store
    const key = `${networkType}:${frequency}`
    storeSetFrequencyCustomColors({
      ...useMapStore.getState().mapSettings.frequencyCustomColors,
      [key]: { color: colors.color, strokeColor: colors.strokeColor }
    })

    // 3. 更新本地频点状态（色块颜色实时刷新）
    const nt = networkType.toLowerCase() as 'lte' | 'nr'
    setFrequencies(prev => ({
      ...prev,
      [nt]: prev[nt].map(f => f.frequency === frequency ? { ...f, color: colors.color, strokeColor: colors.strokeColor } : f)
    }))

    // 4. 刷新已渲染扇区（重新读取颜色）
    onlineMapRef.current?.refreshSectorColors()
  }, [storeSetFrequencyCustomColors])

  /**
   * 处理扇区标签可见性切换
   */
  const handleSectorLabelToggle = useCallback((layerId: string, visible: boolean) => {
    console.log('[MapPage] Sector label toggle:', layerId, visible)

    // 更新本地状态
    setSectorLabelVisibility(prev => ({
      ...prev,
      [layerId]: visible
    }))
    storeSetSectorLabelVisibility(layerId, visible)

    // 通知地图组件更新扇区标签可见性
    if (onlineMapRef.current) {
      const layerType = layerId === 'lte-sectors' ? 'lte' : 'nr'
      console.log('[MapPage] Calling onlineMapRef.current.setSectorLabelVisibility:', layerType, visible)
      onlineMapRef.current.setSectorLabelVisibility(layerType, visible)
    }
  }, [storeSetSectorLabelVisibility])

  /**
   * 处理点文件标签可见性切换
   */
  const handlePointFileLabelToggle = useCallback((fileId: string, visible: boolean) => {
    console.log('[MapPage] Point file label toggle:', fileId, visible)
    setPointFileLabelVisibility(prev => ({
      ...prev,
      [fileId]: visible
    }))
    storeSetPointFileLabelVisibility(fileId, visible)

    // 通知地图组件
    if (onlineMapRef.current) {
      onlineMapRef.current.setPointFileLabelVisibility(fileId, visible)
    }
  }, [storeSetPointFileLabelVisibility])

  /**
   * 处理图层文件标签可见性切换
   */
  const handleLayerFileLabelToggle = useCallback((fileId: string, visible: boolean) => {
    console.log('[MapPage] Layer file label toggle:', fileId, visible)
    setLayerFileLabelVisibility(prev => ({
      ...prev,
      [fileId]: visible
    }))
    storeSetLayerFileLabelVisibility(fileId, visible)

    // 通知地图组件更新图层文件标签可见性
    if (onlineMapRef.current) {
      const settings = labelSettingsMap[fileId]
      onlineMapRef.current.setLayerFileLabelVisibility(fileId, visible, settings)
    }
  }, [labelSettingsMap, storeSetLayerFileLabelVisibility])

  /**
   * 处理标签设置变化
   */
  const handleLabelSettingsChange = useCallback((node: TreeNode, settings: LabelSettings) => {
    console.log('[MapPage] Label settings change:', node, settings)

    // 确定图层ID
    let layerId: string | undefined
    if (node.type === 'sector-layer' && node.sectorLayer) {
      layerId = node.sectorLayer.id
    } else if (node.type === 'layer-file' && node.layerFile) {
      layerId = node.layerFile.id
    }

    if (!layerId) {
      console.warn('[MapPage] Cannot determine layer ID for label settings')
      return
    }

    // 同时更新本地状态和持久化 store
    setLabelSettingsMap(prev => ({
      ...prev,
      [layerId]: settings
    }))

    // 保存到持久化 store
    storeSetLabelSettings(layerId, settings)

    // 通知地图组件更新标签配置
    if (!onlineMapRef.current) return

    // 对于扇区图层，更新标签配置并设置可见性为true
    if (layerId === 'lte-sectors' || layerId === 'nr-sectors') {
      console.log('[MapPage] Applying label settings to sector and forcing show:', layerId)

      // 1. 立即更新状态为可见（与图层文件的处理逻辑保持一致）
      setSectorLabelVisibility(prev => ({
        ...prev,
        [layerId]: true
      }))

      // 2. 立即应用配置并强制显示
      onlineMapRef.current.setSectorLabelSettings(settings, layerId)
    }
    // 对于图层文件（包括地理化数据和 MapInfo 图层），应用设置到地图
    else if (node.type === 'layer-file') {
      console.log('[MapPage] Applying label settings for layer file:', layerId, settings)

      // 🔥 修复：保存标签设置时，自动启用标签显示
      // 用户既然在配置标签，肯定希望看到效果，所以强制显示标签
      setPointFileLabelVisibility(prev => ({
        ...prev,
        [layerId]: true  // 强制启用标签显示（地理化数据开关读此状态）
      }))
      storeSetPointFileLabelVisibility(layerId, true)
      // 🔧 修复：图层文件（非 excel）的标签开关读 layerFileLabelVisibility，需同步置 true 并持久化
      // （否则设置保存后地图显示标签但控制面板开关仍关闭，状态不一致；参考地理化数据已有行为）
      if (node.layerFile && node.layerFile.sourceType !== 'excel') {
        setLayerFileLabelVisibility(prev => ({
          ...prev,
          [layerId]: true
        }))
        storeSetLayerFileLabelVisibility(layerId, true)
      }

      // 应用标签设置到地图
      if (onlineMapRef.current) {
        // 传入 visible=true，确保标签显示并应用新配置
        onlineMapRef.current.setLayerFileLabelVisibility(layerId, true, settings)
      }
    }
  }, [pointFileLabelVisibility, storeSetPointFileLabelVisibility, storeSetLayerFileLabelVisibility])

  /**
   * 处理图层颜色设置变化
   */
  const handleColorSettingsChange = useCallback((node: TreeNode, settings: LayerColorSettings) => {
    console.log('[MapPage] Color settings change:', node, settings)

    // 确定图层ID
    let layerId: string | undefined
    if (node.type === 'sector-layer' && node.sectorLayer) {
      layerId = node.sectorLayer.id
    } else if (node.type === 'layer-file' && node.layerFile) {
      layerId = node.layerFile.id
    } else if (node.type === 'decoration-layer') {
      layerId = 'decoration-layer'
    }

    if (!layerId) {
      console.warn('[MapPage] Cannot determine layer ID for color settings')
      return
    }

    // 更新本地状态 + 持久化 store
    setColorSettingsMap(prev => ({ ...prev, [layerId as string]: settings }))
    storeSetColorSettings(layerId, settings)

    if (!onlineMapRef.current) return

    // 强制显示目标图层，便于看到改色效果（装饰图层恒显，无需处理）
    if (node.type === 'layer-file' && node.layerFile) {
      storeSetLayerFileVisibility(layerId, true)
    }

    // 应用颜色到地图：扇区图层应用透明度/边框宽度/小区PCI渲染（默认按频点区分颜色）
    if (node.type === 'sector-layer') {
      onlineMapRef.current?.setSectorColorSettings(layerId, {
        fillOpacity: settings.fillOpacity,
        borderWidth: settings.borderWidth,
        ...(settings.pciRenderEnabled ? { pciRenderEnabled: true, pciMod: settings.pciMod ?? 3 } : {})
      })
      return
    }

    // 应用颜色到地图
    onlineMapRef.current.setLayerColorSettings(layerId, settings)
  }, [storeSetColorSettings, storeSetLayerFileVisibility])

  /**
   * 处理专题图层设置变化（null 表示关闭专题）
   * 支持图层文件/地理化数据与基站扇区图层
   */
  const handleThematicSettingsChange = useCallback((node: TreeNode, settings: ThematicSettings | null) => {
    console.log('[MapPage] Thematic settings change:', node, settings)

    // 确定图层ID
    let layerId: string | undefined
    if (node.type === 'layer-file' && node.layerFile) {
      layerId = node.layerFile.id
    } else if (node.type === 'sector-layer' && node.sectorLayer) {
      layerId = node.sectorLayer.id
    }

    if (!layerId) {
      console.warn('[MapPage] Cannot determine layer ID for thematic settings')
      return
    }

    // 更新本地状态 + 持久化 store（null 删除条目）
    setThematicSettingsMap(prev => {
      const next = { ...prev }
      if (settings === null) {
        delete next[layerId as string]
      } else {
        next[layerId as string] = settings
      }
      return next
    })
    storeSetThematicSettings(layerId, settings)

    // 基础配置与专题图层相互独立：关闭专题时不再清除基础配置，
    // 刷新后由 colorSettingsMap / thematicSettingsMap 分别恢复，渲染层按专题是否启用决定优先级，
    // 因此关闭专题后基础配置色自然生效，无需在此清除（避免把刚保存的基础配置误删）。

    if (!onlineMapRef.current) return

    // 强制显示目标图层
    if (node.type === 'sector-layer') {
      // 扇区图层：更新本地 layers 状态 + 通知 OnlineMap 显示
      setLayers(prev => prev.map(l => l.id === layerId ? { ...l, visible: true } : l))
      if (onlineMapRef.current) {
        const layerType = layerId === 'lte-sectors' ? 'lte' : 'nr'
        onlineMapRef.current.setLayerVisibility(layerType, true)
      }
    } else {
      // 图层文件/地理化数据（更新本地 state，OnlineMap 监听 prop 自动显示；图例也随 visible 刷新）
      setLayerFiles(prev => prev.map(f => f.id === layerId ? { ...f, visible: true } : f))
      setPointFiles(prev => prev.map(f => f.id === layerId ? { ...f, visible: true } : f))

      // 同步持久化可见性（刷新后保持显示）
      const isInLayerFiles = layerFiles.some(f => f.id === layerId)
      if (isInLayerFiles) {
        storeSetLayerFileVisibility(layerId, true)
      } else {
        storeSetPointFileVisibility(layerId, true)
      }
    }

    // 应用到地图（专题优先于基础配置，渲染层内部处理互斥）
    if (node.type === 'sector-layer') {
      onlineMapRef.current.setSectorThematicSettings(layerId, settings)
      const st = onlineMapRef.current.getSectorThematicStats(layerId)
      setThematicStats(prev => ({ ...prev, [layerId as string]: st }))
    } else {
      onlineMapRef.current.setLayerThematicSettings(layerId, settings)
      // 立即拉取区间统计（图例展示个数与占比）
      const st = onlineMapRef.current.getLayerThematicStats(layerId)
      setThematicStats(prev => ({ ...prev, [layerId as string]: st }))
    }
  }, [storeSetThematicSettings, storeSetLayerFileVisibility, storeSetPointFileVisibility, storeSetColorSettings, layerFiles])

  /**
   * 处理热力图设置变化（null 表示关闭）。
   * 与专题图层同链路：本地 state + store 持久化 + 强制显示目标图层 + 下发 OnlineMap。
   * 替换模式下原图形/标签的隐藏由 OnlineMap 内部处理。
   */
  const handleHeatmapSettingsChange = useCallback((node: TreeNode, settings: HeatmapSettings | null) => {
    console.log('[MapPage] Heatmap settings change:', node, settings)

    let layerId: string | undefined
    if (node.type === 'layer-file' && node.layerFile) {
      layerId = node.layerFile.id
    } else if (node.type === 'sector-layer' && node.sectorLayer) {
      layerId = node.sectorLayer.id
    }
    if (!layerId) return

    setHeatmapSettingsMap(prev => {
      const next = { ...prev }
      if (settings === null) {
        delete next[layerId as string]
      } else {
        next[layerId as string] = settings
      }
      return next
    })
    storeSetHeatmapSettings(layerId, settings)

    if (!onlineMapRef.current) return

    // 强制显示目标图层（与专题保存一致；替换模式下 OnlineMap 会再隐藏原图形）
    if (node.type === 'sector-layer') {
      setLayers(prev => prev.map(l => l.id === layerId ? { ...l, visible: true } : l))
      onlineMapRef.current.setLayerVisibility(layerId === 'lte-sectors' ? 'lte' : 'nr', true)
      onlineMapRef.current.setSectorHeatmapSettings(layerId, settings)
    } else {
      setLayerFiles(prev => prev.map(f => f.id === layerId ? { ...f, visible: true } : f))
      setPointFiles(prev => prev.map(f => f.id === layerId ? { ...f, visible: true } : f))
      const isInLayerFiles = layerFiles.some(f => f.id === layerId)
      if (isInLayerFiles) {
        storeSetLayerFileVisibility(layerId, true)
      } else {
        storeSetPointFileVisibility(layerId, true)
      }
      onlineMapRef.current.setLayerHeatmapSettings(layerId, settings)
    }
  }, [storeSetHeatmapSettings, storeSetLayerFileVisibility, storeSetPointFileVisibility, layerFiles])

  /**
   * 图层预览（右键菜单）：居中并最大化显示该图层全部要素
   */
  const handleLayerPreview = useCallback((fileId: string) => {
    onlineMapRef.current?.focusLayer(fileId)
  }, [])

  /**
   * 保存区间配色模板
   */
  const handleSaveThematicTemplate = useCallback((name: string, ranges: ThematicRange[]) => {
    const templates = mapSettings.thematicTemplates || []
    const id = `tpl-${Date.now()}`
    storeSetThematicTemplates([
      ...templates,
      { id, name, ranges: JSON.parse(JSON.stringify(ranges)) }
    ])
  }, [mapSettings.thematicTemplates, storeSetThematicTemplates])

  /**
   * 删除区间配色模板
   */
  const handleRemoveThematicTemplate = useCallback((id: string) => {
    const templates = mapSettings.thematicTemplates || []
    storeSetThematicTemplates(templates.filter(t => t.id !== id))
  }, [mapSettings.thematicTemplates, storeSetThematicTemplates])

  /**
   * 保存热力图设置模板
   */
  const handleSaveHeatmapTemplate = useCallback((name: string, settings: HeatmapTemplate['settings']) => {
    const templates = mapSettings.heatmapTemplates || []
    storeSetHeatmapTemplates([
      ...templates,
      { id: `htpl-${Date.now()}`, name, settings: JSON.parse(JSON.stringify(settings)) }
    ])
  }, [mapSettings.heatmapTemplates, storeSetHeatmapTemplates])

  /**
   * 删除热力图设置模板
   */
  const handleRemoveHeatmapTemplate = useCallback((id: string) => {
    const templates = mapSettings.heatmapTemplates || []
    storeSetHeatmapTemplates(templates.filter(t => t.id !== id))
  }, [mapSettings.heatmapTemplates, storeSetHeatmapTemplates])

  // 专题图例项：已勾选可见且启用专题的图层（含基站扇区图层）
  const thematicLegendItems = useMemo(() => {
    const tsMap = mapSettings.thematicSettingsMap || {}
    const items: { id: string; name: string; settings: ThematicSettings }[] = []
    for (const f of [...layerFiles, ...pointFiles]) {
      const ts = tsMap[f.id]
      if (f.visible && ts?.enabled) {
        items.push({ id: f.id, name: f.name, settings: ts })
      }
    }
    // 基站扇区图层（LTE/NR）
    for (const s of sectorLayers) {
      const ts = tsMap[s.id]
      if (s.visible && ts?.enabled) {
        items.push({ id: s.id, name: s.type === 'LTE' ? 'LTE' : 'NR', settings: ts })
      }
    }
    return items
  }, [layerFiles, pointFiles, sectorLayers, mapSettings.thematicSettingsMap])

  // PCI模值图例项：已勾选可见且启用"小区PCI渲染"的基站扇区图层。
  // 门控：同图层专题启用（画面为专题色）/热力图替换模式（扇区层已移除）时图例不显示，
  // 避免画面颜色与图例不符。
  const pciRenderLegendItems = useMemo(() => {
    const cMap = colorSettingsMap ?? {}
    const tsMap = mapSettings.thematicSettingsMap ?? {}
    const hsMap = mapSettings.heatmapSettingsMap ?? {}
    const items: PciModLegendItem[] = []
    for (const s of sectorLayers) {
      const c = cMap[s.id]
      const thematicOn = tsMap[s.id]?.enabled
      const hs = hsMap[s.id]
      const heatReplace = hs?.enabled && !!hs.field && !hs.showOriginal
      // 该制式至少有一个频点勾选（图例只展示勾选频点，全不勾选时无内容可显示）
      const visibleFreqs = s.id === 'lte-sectors' ? frequencies.lte : frequencies.nr
      const hasCheckedFrequency = visibleFreqs.some(f => f.visible)
      if (s.visible && c?.pciRenderEnabled && !thematicOn && !heatReplace && hasCheckedFrequency) {
        items.push({
          id: s.id,
          name: s.type === 'LTE' ? 'LTE' : 'NR',
          mod: c.pciMod ?? (s.type === 'NR' ? 30 : 3)
        })
      }
    }
    return items
  }, [sectorLayers, colorSettingsMap, mapSettings.thematicSettingsMap, mapSettings.heatmapSettingsMap, frequencies])

  // 图例双击跳转：打开对应图层的专题/热力图设置页
  const [openThematicFor, setOpenThematicFor] = useState<{ layerId: string; ts: number; subTab?: 'basic' | 'thematic' | 'heatmap' } | null>(null)
  const handleLegendItemDoubleClick = useCallback((item: { id: string }) => {
    setOpenThematicFor({ layerId: item.id, ts: Date.now(), subTab: 'thematic' })
  }, [])
  const handleHeatmapLegendItemDoubleClick = useCallback((item: { id: string }) => {
    setOpenThematicFor({ layerId: item.id, ts: Date.now(), subTab: 'heatmap' })
  }, [])
  // PCI模值图例双击：打开对应扇区图层默认设置（基础配置页）
  const handlePciRenderLegendDoubleClick = useCallback((item: { id: string }) => {
    setOpenThematicFor({ layerId: item.id, ts: Date.now(), subTab: 'basic' })
  }, [])

  // 专题图例统计（图例显示每个区间的个数与占比；other = 黑色“其他”要素数）
  const [thematicStats, setThematicStats] = useState<Record<string, { counts: number[]; total: number; other: number } | null>>({})
  const fetchThematicStats = useCallback((ids: string[]) => {
    if (!onlineMapRef.current || ids.length === 0) return
    const next: Record<string, { counts: number[]; total: number; other: number } | null> = {}
    for (const id of ids) {
      next[id] = onlineMapRef.current.getLayerThematicStats(id)
    }
    setThematicStats(prev => ({ ...prev, ...next }))
  }, [])
  // 图例项变化时拉取统计；图层可能仍在异步加载，延时重拉兜底
  useEffect(() => {
    const ids = thematicLegendItems.map(i => i.id)
    if (ids.length === 0) {
      setThematicStats({})
      return
    }
    fetchThematicStats(ids)
    const timer = setTimeout(() => fetchThematicStats(ids), 2000)
    return () => clearTimeout(timer)
  }, [thematicLegendItems, fetchThematicStats])

  // PCI模值图例统计（各模值小区数；noPci = 无有效PCI的小区数）
  const [pciRenderStats, setPciRenderStats] = useState<Record<string, PciRenderStats | null>>({})
  const fetchPciRenderStats = useCallback((ids: string[]) => {
    if (!onlineMapRef.current) return
    // 按当前 ids 裁剪：图层从图例消失后清除其旧统计键
    const next: Record<string, PciRenderStats | null> = {}
    for (const id of ids) {
      next[id] = onlineMapRef.current.getPciRenderStats(id)
    }
    setPciRenderStats(next)
  }, [])
  // 图例项变化时拉取统计；扇区图层可能仍在异步构建，延时重拉兜底
  useEffect(() => {
    const ids = pciRenderLegendItems.map(i => i.id)
    if (ids.length === 0) {
      setPciRenderStats({})
      return
    }
    fetchPciRenderStats(ids)
    const timer = setTimeout(() => fetchPciRenderStats(ids), 2000)
    return () => clearTimeout(timer)
  }, [pciRenderLegendItems, fetchPciRenderStats])

  // 热力图例项：已勾选可见且启用热力图的图层（含基站扇区图层）
  const heatmapLegendItems = useMemo(() => {
    const hsMap = mapSettings.heatmapSettingsMap || {}
    const items: { id: string; name: string; settings: HeatmapSettings }[] = []
    for (const f of [...layerFiles, ...pointFiles]) {
      const hs = hsMap[f.id]
      if (f.visible && hs?.enabled) {
        items.push({ id: f.id, name: f.name, settings: hs })
      }
    }
    for (const s of sectorLayers) {
      const hs = hsMap[s.id]
      if (s.visible && hs?.enabled) {
        items.push({ id: s.id, name: s.type === 'LTE' ? 'LTE' : 'NR', settings: hs })
      }
    }
    return items
  }, [layerFiles, pointFiles, sectorLayers, mapSettings.heatmapSettingsMap])

  // 热力图例统计（分级色块/权重 min/max/点数/抽样）。
  // 热力栅格可能在数据图层异步构建完成（或页面切换后重放）之后才就绪，
  // 因此短轮询补齐：统计全部就绪即停止，最多轮询 15 次（约 30s）避免永久定时器。
  const [heatmapStats, setHeatmapStats] = useState<Record<string, HeatmapStats | null>>({})
  useEffect(() => {
    const ids = heatmapLegendItems.map(i => i.id)
    if (ids.length === 0) {
      setHeatmapStats({})
      return
    }
    const fetchStats = (): boolean => {
      if (!onlineMapRef.current) return false
      let allReady = true
      const next: Record<string, HeatmapStats | null> = {}
      for (const id of ids) {
        const st = onlineMapRef.current.getHeatmapStats(id)
        next[id] = st
        if (!st) allReady = false
      }
      setHeatmapStats(prev => ({ ...prev, ...next }))
      return allReady
    }
    if (fetchStats()) return
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      if (fetchStats() || tries >= 15) clearInterval(timer)
    }, 2000)
    return () => clearInterval(timer)
  }, [heatmapLegendItems])

  // 热力图挂载/重挂载重放兜底：地图实例跨页面缓存复用、大图层异步构建晚于设置恢复时，
  // 延时幂等重放一次已保存的热力设置（OnlineMap 内部按 layerId 复用，不产生重复图层）
  useEffect(() => {
    const timer = setTimeout(() => {
      onlineMapRef.current?.replayHeatmapSettings()
    }, 2000)
    return () => clearTimeout(timer)
  }, [])

  // ===== 工具栏按钮（id → JSX）：渲染顺序由 toolbarPrefs.order 决定（右键菜单/拖拽可调） =====

  /** 打点工具"粘滞"：已激活时再次点击不关闭，只能通过切换到其他工具退出 */
  const activateCaptureTool = () => {
    if (captureMode) return
    setCaptureMode(true)
    setMeasureMode(false)
    setSelectionMode('none')
    setMapDragTool(false)
    // 与绘制工具互斥：激活打点时退出绘制与选择
    useLayerEditStore.getState().setDrawTool('none')
    useLayerEditStore.getState().setSelectMode(false)
  }

  /** 测距工具"粘滞"：已激活时再次点击不关闭，只能通过切换到其他工具退出 */
  const activateMeasureTool = () => {
    if (measureMode) return
    setMeasureMode(true)
    setCaptureMode(false)
    setCaptureCoord(null)
    setSelectionMode('none')
    setMapDragTool(false)
    // 与绘制工具互斥：激活测距时退出绘制与选择
    useLayerEditStore.getState().setDrawTool('none')
    useLayerEditStore.getState().setSelectMode(false)
  }

  /** 地图类型三态循环：关闭底图 → 平面图 → 卫星图 → 关闭底图 */
  const cycleMapType = () => {
    if (!onlineMapVisible) {
      // 关闭状态 → 恢复平面图
      handleOnlineMapToggle(true)
      handleMapTypeChange('roadmap')
    } else if (mapType === 'roadmap') {
      // 平面图 → 卫星图
      handleMapTypeChange('satellite')
    } else {
      // 卫星图 → 关闭底图
      handleOnlineMapToggle(false)
    }
  }

  const toolbarButtons: Record<string, ReactNode> = {
    /* 保存按钮：有未保存编辑时可点击，弹窗选择保存哪些图层 */
    save: (
      <button
        className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${
          dirtyLayerIds.length > 0
            ? 'text-foreground hover:bg-muted hover:text-primary'
            : 'text-muted-foreground/40 cursor-not-allowed'
        }`}
        disabled={dirtyLayerIds.length === 0}
        onClick={() => setSaveDialogOpen(true)}
        title={t('map.saveLayersHint') || '保存有未保存编辑的图层（Ctrl+S）'}
      >
        <Save size={14} />
        <span className="toolbar-label">{t('common.save') || '保存'}</span>
        {dirtyLayerIds.length > 0 && (
          <span className="ml-0.5 min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] flex items-center justify-center">
            {dirtyLayerIds.length}
          </span>
        )}
      </button>
    ),

    /* 导出按钮：弹框列出所有导入的文件，勾选后导出到本地（TAB 套装 zip / 表格 xlsx） */
    export: (
      <button
        className="px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 text-foreground hover:bg-muted hover:text-primary"
        onClick={() => setExportDialogOpen(true)}
        title={t('map.exportFilesHint') || '导出已导入的文件到本地'}
      >
        <Download size={14} />
        <span className="toolbar-label">{t('map.exportAction') || '导出'}</span>
      </button>
    ),

    /* 撤销按钮：撤销当前编辑图层的最近一次操作（Ctrl+Z） */
    undo: (
      <button
        className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${
          canUndoNow
            ? 'text-foreground hover:bg-muted hover:text-primary'
            : 'text-muted-foreground/40 cursor-not-allowed'
        }`}
        disabled={!canUndoNow}
        onClick={handleUndo}
        title={t('map.undoHint') || '撤销当前编辑图层的操作（Ctrl+Z）'}
      >
        <Undo2 size={14} />
        <span className="toolbar-label">{t('map.undo') || '撤销'}</span>
      </button>
    ),

    /* 提取坐标按钮 */
    capture: (
      <button
        className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${captureMode ? 'bg-blue-400 text-white hover:bg-blue-500' : 'text-foreground hover:bg-muted hover:text-primary'}`}
        onClick={activateCaptureTool}
        title={captureMode ? (t('map.exitCaptureMode') || '退出打点') : (t('map.captureModeHint') || '点击地图任意位置抓取WGS84坐标')}
      >
        <div className="w-4 h-4 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        </div>
        <span className="toolbar-label">{captureMode ? (t('map.exitCaptureMode') || '退出打点') : (t('map.extractCoord') || '打点')}</span>
      </button>
    ),

    /* 测距按钮 */
    measure: (
      <button
        className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${measureMode ? 'bg-blue-400 text-white hover:bg-blue-500' : 'text-foreground hover:bg-muted hover:text-primary'
          }`}
        onClick={activateMeasureTool}
        title={measureMode ? (t('map.exitDistanceMode') || '退出测距模式') : (t('map.distanceMode') || '测距工具')}
      >
        <div className="w-4 h-4 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2h8v20H8V2z"></path><path d="M13 6h3"></path><path d="M13 10h3"></path><path d="M13 14h3"></path><path d="M13 18h3"></path></svg>
        </div>
        <span className="toolbar-label">{t('map.measure') || '测距'}</span>
      </button>
    ),

    /* 地图拖拽（手形）工具按钮：保持激活，再次点击不去激活，点击其他工具切换出去 */
    drag: (
      <button
        className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${mapDragTool ? 'bg-blue-400 text-white hover:bg-blue-500' : 'text-foreground hover:bg-muted hover:text-primary'
          }`}
        onClick={handleMapDragToolToggle}
        title={mapDragTool ? (t('map.dragActiveHint') || '手形工具已激活（点击其他工具切换出去）') : (t('map.enableDrag') || '启用地图拖拽')}
      >
        <Hand size={14} />
        <span className="toolbar-label">{t('map.drag') || '拖拽'}</span>
      </button>
    ),

    /* 选择按钮：点击要素选中（可编辑图层显示可拖拽顶点），双击要素弹属性与风格配置。
       标签始终显示"选择"并保持高亮，不再切换为"退出选择" */
    select: (
      <button
        className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${selectMode ? 'bg-blue-400 text-white hover:bg-blue-500' : 'text-foreground hover:bg-muted hover:text-primary'}`}
        onClick={handleSelectToolToggle}
        title={t('map.selectToolHint') || '点击地图要素选中，双击要素查看属性并配置风格'}
      >
        <MousePointer2 size={14} />
        <span className="toolbar-label">{t('map.selectTool') || '选择'}</span>
      </button>
    ),

    /* 圈选按钮（框选/圆形/多边形） */
    marquee: (
      <div className="relative" ref={selectionMenuRef}>
        <button
          className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${selectionMode !== 'none' ? 'bg-blue-400 text-white hover:bg-blue-500' : 'text-foreground hover:bg-muted hover:text-primary'
            }`}
          onClick={() => {
            // 圈选工具"粘滞"：已激活时再次点击不退出模式（只能切换到其他工具退出），
            // 仅切换菜单显隐，便于已激活状态下改选其他形状
            setShowSelectionMenu((v) => !v)
          }}
          title={selectionMode !== 'none' ? (t('map.selectShapeHint') || '切换圈选形状（框选/圆形/多边形）') : (t('map.mapSelectTool') || '地图圈选工具')}
        >
          {selectionMode === 'point' && <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>}
          {selectionMode === 'circle' && <CircleIcon size={14} />}
          {selectionMode === 'polygon' && <Pentagon size={14} />}
          {selectionMode === 'boundary' && <TrapezoidIcon size={14} />}
          {selectionMode === 'none' && <BoxSelect size={14} />}
          <span className="toolbar-label">
            {selectionMode === 'point'
              ? (t('map.pointSelect') || '框选')
              : selectionMode === 'circle'
                ? (t('map.circleSelect') || '圆形')
                : selectionMode === 'polygon'
                  ? (t('map.polygonSelect') || '多边形')
                  : selectionMode === 'boundary'
                    ? (t('map.boundarySelect') || '边界选择')
                    : (t('map.marqueeSelect') || '圈选')}
          </span>
          {selectionMode === 'none' && (
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="ml-0.5 opacity-60">
              <path d="m6 9 6 6 6-6"/>
            </svg>
          )}
        </button>
        {showSelectionMenu && (
          <div className="absolute top-full left-0 mt-1 z-[3000] bg-card border border-border rounded-lg shadow-lg w-32 overflow-hidden">
            <button
              onClick={() => handleSelectionModeChange('point')}
              className="w-full text-left px-2 py-1.5 text-xs text-foreground hover:bg-muted hover:text-primary transition-colors flex items-center gap-1"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
              {t('map.pointSelect') || '框选'}
            </button>
            <button
              onClick={() => handleSelectionModeChange('circle')}
              className="w-full text-left px-2 py-1.5 text-xs text-foreground hover:bg-muted hover:text-primary transition-colors flex items-center gap-1"
            >
              <CircleIcon size={12} />
              {t('map.circleSelect') || '圆形'}
            </button>
            <button
              onClick={() => handleSelectionModeChange('polygon')}
              className="w-full text-left px-2 py-1.5 text-xs text-foreground hover:bg-muted hover:text-primary transition-colors flex items-center gap-1"
            >
              <Pentagon size={12} />
              {t('map.polygonSelect') || '多边形'}
            </button>
            <button
              onClick={() => handleSelectionModeChange('boundary')}
              className="w-full text-left px-2 py-1.5 text-xs text-foreground hover:bg-muted hover:text-primary transition-colors flex items-center gap-1"
            >
              <TrapezoidIcon size={12} />
              {t('map.boundarySelect') || '边界选择'}
            </button>
            <button
              onClick={() => { setShowSelectionMenu(false); setJoinDialogOpen(true) }}
              className="w-full text-left px-2 py-1.5 text-xs text-foreground hover:bg-muted hover:text-primary transition-colors flex items-center gap-1"
            >
              <Filter size={12} />
              {t('map.attributeJoin') || '条件选择'}
            </button>
          </div>
        )}
      </div>
    ),

    /* 新建图层菜单 */
    new: (
      <div className="relative" ref={newMenuRef}>
        <button
          className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${openMenu === 'new' ? 'bg-muted text-primary' : 'text-foreground hover:bg-muted hover:text-primary'}`}
          onClick={() => setOpenMenu(openMenu === 'new' ? null : 'new')}
          title={t('map.newLayer') || '新建图层（Ctrl+N）'}
        >
          <FilePlus2 size={14} />
          <span className="toolbar-label">{t('map.newLayer') || '新建'}</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="ml-0.5 opacity-60">
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </button>
        {openMenu === 'new' && (
          <div className="absolute top-full left-0 mt-1 z-[3000] bg-card border border-border rounded-lg shadow-lg w-36 overflow-hidden">
            <button
              onClick={() => { setOpenMenu(null); setNewLayerDialogOpen(true) }}
              className="w-full text-left px-2 py-1.5 text-xs text-foreground hover:bg-muted hover:text-primary transition-colors flex items-center gap-1.5"
            >
              <FilePlus2 size={12} />
              {t('map.newLayerMenu') || '图层'}
            </button>
          </div>
        )}
      </div>
    ),

    /* 绘制工具下拉：点 / 线 / 面（互斥，需先打开图层编辑开关） */
    draw: (
      <div className="relative" ref={drawMenuRef}>
        <button
          className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${drawTool !== 'none' ? 'bg-blue-400 text-white hover:bg-blue-500' : 'text-foreground hover:bg-muted hover:text-primary'}`}
          onClick={() => setOpenMenu(openMenu === 'draw' ? null : 'draw')}
          title={t('map.drawHint') || '在可编辑图层绘制点/线/面'}
        >
          {drawTool === 'point' && <MapPin size={14} />}
          {drawTool === 'line' && <Spline size={14} />}
          {drawTool === 'polygon' && <Hexagon size={14} />}
          {drawTool === 'none' && <PenLine size={14} />}
          <span className="toolbar-label">
            {drawTool === 'point' ? (t('map.point') || '点')
              : drawTool === 'line' ? (t('map.line') || '线')
                : drawTool === 'polygon' ? (t('map.polygon') || '面')
                  : (t('map.draw') || '绘制')}
          </span>
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="ml-0.5 opacity-60">
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </button>
        {openMenu === 'draw' && (
          <div className="absolute top-full left-0 mt-1 z-[3000] bg-card border border-border rounded-lg shadow-lg w-36 overflow-hidden">
            <button
              onClick={() => { setOpenMenu(null); handleDrawTool('point') }}
              className="w-full text-left px-2 py-1.5 text-xs text-foreground hover:bg-muted hover:text-primary transition-colors flex items-center gap-1.5"
            >
              <MapPin size={13} />
              {t('map.drawPoint') || '绘制点'}
            </button>
            <button
              onClick={() => { setOpenMenu(null); handleDrawTool('line') }}
              className="w-full text-left px-2 py-1.5 text-xs text-foreground hover:bg-muted hover:text-primary transition-colors flex items-center gap-1.5"
            >
              <Spline size={13} />
              {t('map.drawLine') || '绘制线'}
            </button>
            <button
              onClick={() => { setOpenMenu(null); handleDrawTool('polygon') }}
              className="w-full text-left px-2 py-1.5 text-xs text-foreground hover:bg-muted hover:text-primary transition-colors flex items-center gap-1.5"
            >
              <Hexagon size={13} />
              {t('map.drawPolygon') || '绘制面'}
            </button>
            <button
              onClick={() => { setOpenMenu(null); setBufferDialogOpen(true) }}
              className="w-full text-left px-2 py-1.5 text-xs text-foreground hover:bg-muted hover:text-primary transition-colors flex items-center gap-1.5"
            >
              <BufferIcon size={13} />
              {t('map.drawBuffer') || '绘制缓冲区'}
            </button>
          </div>
        )}
      </div>
    ),

    /* 样式按钮：直接打开点/线/面样式弹框（弹框内切换页签），不再走下拉菜单 */
    style: (
      <button
        className="px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 text-foreground hover:bg-muted hover:text-primary"
        onClick={() => setStyleModalTab('point')}
        title={t('map.styleHint') || '点/线/面样式设置'}
      >
        <Palette size={14} />
        <span className="toolbar-label">{t('map.style') || '样式'}</span>
      </button>
    ),

    /* 节点捕获：与按 S 键等价的独立开关，不与其他工具互斥 */
    nodesnap: (
      <button
        className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${
          snapEnabled
            ? 'bg-blue-400 text-white hover:bg-blue-500'
            : 'text-foreground hover:bg-muted hover:text-primary'
        }`}
        onClick={handleToggleSnap}
        title={snapEnabled
          ? (t('map.nodeSnapOnHint') || '节点捕获已开启（点击或按 S 关闭）：拖动/绘制节点时自动吸附')
          : (t('map.nodeSnapHint') || '节点捕获（同键盘 S）：开启后拖动/绘制节点靠近其他节点自动吸附')}
      >
        <Magnet size={14} />
        <span className="toolbar-label">{t('map.nodeSnap') || '节点捕获'}</span>
      </button>
    ),

    /* 节点合并：拖框把可编辑边框对齐到不可编辑参考图形边框（节点少补多删） */
    nodemerge: (
      <button
        className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${
          nodeMergeMode
            ? 'bg-blue-400 text-white hover:bg-blue-500'
            : 'text-foreground hover:bg-muted hover:text-primary'
        }`}
        onClick={handleToggleNodeMerge}
        title={nodeMergeMode
          ? (t('map.nodeMergeOnHint') || '节点合并已开启（点击关闭）：左键拖框选择相邻边框')
          : (t('map.nodeMergeHint') || '节点合并：开启编辑图层后，拖框把可编辑边框吸附对齐到参考图层边框')}
      >
        <Combine size={14} />
        <span className="toolbar-label">{t('map.nodeMerge') || '节点合并'}</span>
      </button>
    ),

    /* 粘贴按钮：把圈选复制的要素粘贴到当前编辑图层（目标图层需勾选可见） */
    paste: (
      <button
        className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${
          pasteTargetReady
            ? 'text-foreground hover:bg-muted hover:text-primary'
            : 'text-muted-foreground/40 cursor-not-allowed'
        }`}
        disabled={!pasteTargetReady}
        onClick={handlePasteFeatures}
        title={t('map.pasteSelectionHint') || '把圈选复制的要素粘贴到当前编辑图层（需先在图层控制打开"编辑"开关，且图层处于勾选状态）'}
      >
        <ClipboardPaste size={14} />
        <span className="toolbar-label">{t('map.pasteSelection') || '粘贴'}</span>
        {clipboardItems.length > 0 && (
          <span className="ml-0.5 min-w-[16px] h-4 px-1 rounded-full bg-blue-500 text-white text-[10px] flex items-center justify-center">
            {clipboardItems.length}
          </span>
        )}
      </button>
    ),

    /* 地图类型切换按钮：平面图 → 卫星图 → 关闭底图 三态循环 */
    maptype: (
      <button
        onClick={cycleMapType}
        className={`flex items-center gap-1 px-2 py-1.5 text-xs rounded transition-colors ${
          onlineMapVisible
            ? 'text-foreground hover:bg-muted hover:text-primary'
            : 'text-foreground hover:bg-muted hover:text-primary'
        }`}
        title={!onlineMapVisible
          ? (t('map.switchToRoadmap') || '切换到平面图')
          : mapType === 'roadmap'
            ? (t('map.switchToSatellite') || '切换到卫星图')
            : (t('map.emptyMap') || '空地图')}
      >
        {!onlineMapVisible ? (
          <>
            <MapIcon size={14} />
            <span className="toolbar-label">{t('map.emptyMap') || '空地图'}</span>
          </>
        ) : mapType === 'roadmap' ? (
          <>
            <MapIcon size={14} />
            <span className="toolbar-label">{t('map.vector') || '平面图'}</span>
          </>
        ) : (
          <>
            <Satellite size={14} />
            <span className="toolbar-label">{t('map.satellite') || '卫星图'}</span>
          </>
        )}
      </button>
    ),
  }

  // =====「更多」面板条目：被收纳按钮的等价行 =====
  const marqueeIcon = selectionMode === 'point'
    ? <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
    : selectionMode === 'circle'
      ? <CircleIcon size={14} />
      : selectionMode === 'polygon'
        ? <Pentagon size={14} />
        : selectionMode === 'boundary'
          ? <TrapezoidIcon size={14} />
          : <BoxSelect size={14} />
  const marqueeLabel = selectionMode === 'point'
    ? (t('map.pointSelect') || '框选')
    : selectionMode === 'circle'
      ? (t('map.circleSelect') || '圆形')
      : selectionMode === 'polygon'
        ? (t('map.polygonSelect') || '多边形')
        : selectionMode === 'boundary'
          ? (t('map.boundarySelect') || '边界选择')
          : (t('map.marqueeSelect') || '圈选')
  const drawIcon = drawTool === 'point'
    ? <MapPin size={14} />
    : drawTool === 'line'
      ? <Spline size={14} />
      : drawTool === 'polygon'
        ? <Hexagon size={14} />
        : <PenLine size={14} />
  const drawLabel = drawTool === 'point'
    ? (t('map.point') || '点')
    : drawTool === 'line'
      ? (t('map.line') || '线')
      : drawTool === 'polygon'
        ? (t('map.polygon') || '面')
        : (t('map.draw') || '绘制')
  const mapTypeLabel = !onlineMapVisible
    ? (t('map.emptyMap') || '空地图')
    : mapType === 'roadmap'
      ? (t('map.vector') || '平面图')
      : (t('map.satellite') || '卫星图')

  const toolbarMoreEntries: Record<string, ToolbarMoreEntry> = {
    save: {
      icon: <Save size={14} />,
      label: t('common.save') || '保存',
      title: t('map.saveLayersHint') || '保存有未保存编辑的图层（Ctrl+S）',
      disabled: dirtyLayerIds.length === 0,
      onSelect: () => setSaveDialogOpen(true),
    },
    export: {
      icon: <Download size={14} />,
      label: t('map.exportAction') || '导出',
      title: t('map.exportFilesHint') || '导出已导入的文件到本地',
      onSelect: () => setExportDialogOpen(true),
    },
    new: {
      icon: <FilePlus2 size={14} />,
      label: t('map.newLayer') || '新建',
      submenu: [
        { icon: <FilePlus2 size={12} />, label: t('map.newLayerMenu') || '图层', onSelect: () => setNewLayerDialogOpen(true) },
      ],
    },
    undo: {
      icon: <Undo2 size={14} />,
      label: t('map.undo') || '撤销',
      title: t('map.undoHint') || '撤销当前编辑图层的操作（Ctrl+Z）',
      disabled: !canUndoNow,
      onSelect: handleUndo,
    },
    capture: {
      icon: <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>,
      label: captureMode ? (t('map.exitCaptureMode') || '退出打点') : (t('map.extractCoord') || '打点'),
      active: captureMode,
      onSelect: activateCaptureTool,
    },
    paste: {
      icon: <ClipboardPaste size={14} />,
      label: t('map.pasteSelection') || '粘贴',
      disabled: !pasteTargetReady,
      onSelect: handlePasteFeatures,
    },
    measure: {
      icon: <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2h8v20H8V2z"></path><path d="M13 6h3"></path><path d="M13 10h3"></path><path d="M13 14h3"></path><path d="M13 18h3"></path></svg>,
      label: t('map.measure') || '测距',
      active: measureMode,
      onSelect: activateMeasureTool,
    },
    drag: {
      icon: <Hand size={14} />,
      label: t('map.drag') || '拖拽',
      active: mapDragTool,
      onSelect: handleMapDragToolToggle,
    },
    select: {
      icon: <MousePointer2 size={14} />,
      label: t('map.selectTool') || '选择',
      active: selectMode,
      onSelect: handleSelectToolToggle,
    },
    marquee: {
      icon: marqueeIcon,
      label: marqueeLabel,
      active: selectionMode !== 'none',
      submenu: [
        { icon: <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>, label: t('map.pointSelect') || '框选', onSelect: () => handleSelectionModeChange('point') },
        { icon: <CircleIcon size={12} />, label: t('map.circleSelect') || '圆形', onSelect: () => handleSelectionModeChange('circle') },
        { icon: <Pentagon size={12} />, label: t('map.polygonSelect') || '多边形', onSelect: () => handleSelectionModeChange('polygon') },
        { icon: <TrapezoidIcon size={12} />, label: t('map.boundarySelect') || '边界选择', onSelect: () => handleSelectionModeChange('boundary') },
        { icon: <Filter size={12} />, label: t('map.attributeJoin') || '条件选择', onSelect: () => setJoinDialogOpen(true) },
      ],
    },
    draw: {
      icon: drawIcon,
      label: drawLabel,
      active: drawTool !== 'none',
      submenu: [
        { icon: <MapPin size={13} />, label: t('map.drawPoint') || '绘制点', onSelect: () => handleDrawTool('point') },
        { icon: <Spline size={13} />, label: t('map.drawLine') || '绘制线', onSelect: () => handleDrawTool('line') },
        { icon: <Hexagon size={13} />, label: t('map.drawPolygon') || '绘制面', onSelect: () => handleDrawTool('polygon') },
        { icon: <BufferIcon size={13} />, label: t('map.drawBuffer') || '绘制缓冲区', onSelect: () => setBufferDialogOpen(true) },
      ],
    },
    style: {
      icon: <Palette size={14} />,
      label: t('map.style') || '样式',
      onSelect: () => setStyleModalTab('point'),
    },
    nodesnap: {
      icon: <Magnet size={14} />,
      label: t('map.nodeSnap') || '节点捕获',
      active: snapEnabled,
      onSelect: handleToggleSnap,
    },
    nodemerge: {
      icon: <Combine size={14} />,
      label: t('map.nodeMerge') || '节点合并',
      active: nodeMergeMode,
      onSelect: handleToggleNodeMerge,
    },
    maptype: {
      icon: (!onlineMapVisible || mapType === 'roadmap') ? <MapIcon size={14} /> : <Satellite size={14} />,
      label: mapTypeLabel,
      onSelect: cycleMapType,
    },
  }

  return (
    <div ref={mapPageRef} className="flex flex-col h-full min-h-0">
      {/* 地图工具栏（右键可设置标签显隐/按钮顺序） */}
      <div
        data-map-toolbar
        className={`h-14 bg-background border-b border-border/60 flex items-center justify-start px-4 flex-shrink-0 gap-4 ${toolbarPrefs.showLabels ? '' : 'npt-hide-toolbar-labels'}`}
        onContextMenu={(e) => {
          e.preventDefault()
          setToolbarMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <div className="flex items-center gap-4 shrink-0">

          {/* 数据源状态指示 - 绿色已加载/红色未加载 */}
          <div className="px-3 py-1.5 bg-muted/50 rounded-md">
            <div className="flex items-center gap-2">
              <Database size={14} className={currentDataSourceFile ? 'text-green-500' : 'text-red-500'} />
            </div>
          </div>
        </div>

        {/* 搜索框（空间不足时优先收缩自身，给右侧工具按钮让位） */}
        <div className="relative flex items-center gap-2 min-w-0 flex-shrink justify-start">
          {/* 搜索模式切换 - 单按钮切换 */}
          <button
            onClick={() => {
              const newMode = searchMode === 'parameter' ? 'map' : 'parameter'
              setSearchMode(newMode)
              setSearchResults([])
              setShowSearchResults(false)
            }}
            className="px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 text-foreground hover:bg-muted hover:text-primary shrink-0"
            title={t('map.searchModeSwitchHint') || '点击可切换工参搜索、经纬度定位和地图搜索'}
          >
            <Search size={14} />
            <span>{searchMode === 'parameter' ? (t('map.searchLocation') || '搜索定位') : (t('map.searchPlace') || '地图搜索')}</span>
          </button>
          {searchMode === 'parameter' && missingCoordCount > 0 && (
            <div className="flex items-center gap-1 ml-2 text-xs text-amber-600 shrink-0" title="部分扇区缺少坐标信息">
              <AlertTriangle size={12} />
              <span>{missingCoordCount}{t('map.missingCoordCells') || '个扇区缺坐标'}</span>
            </div>
          )}

          {/* 搜索输入框 */}
          <div className="relative w-[360px] min-w-[110px] shrink">
            <input
              ref={searchInputRef}
              type="text"
              value={searchKeyword}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (searchResults.length > 0) setShowSearchResults(true)
              }}
              onBlur={() => {
                // 延迟隐藏，以便点击搜索结果
                setTimeout(() => setShowSearchResults(false), 200)
              }}
              placeholder={searchMode === 'map' ? (t('map.inputPlaceHint') || '输入地名、道路名称等') : (t('map.inputLocationHint') || '输入小区名、基站ID或经纬度(经度,纬度)')}
              className="w-full pl-3 pr-16 py-1.5 text-xs border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
            />

            {/* 右侧按钮组：搜索/清除 */}
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
              {/* 搜索/定位按钮 */}
              <button
                onClick={() => handleSearchAction()}
                className="p-1 rounded hover:bg-muted transition-colors text-foreground hover:text-primary"
                title={t('map.searchOrLocate') || '搜索或定位'}
              >
                <Search size={12} />
              </button>
              {/* 清除输入按钮 */}
              {searchKeyword && (
                <button
                  onClick={clearSearchInput}
                  className="p-1 rounded hover:bg-muted transition-colors text-foreground hover:text-primary"
                  title={t('map.clearInput') || '清除输入'}
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* 搜索结果容器 - 在输入框容器内部定位 */}
            <div className="absolute top-full left-0 mt-1 z-[2000] w-full">
              {/* 搜索结果下拉框 */}
              {showSearchResults && searchResults.length > 0 && (
                <div className="bg-card border border-border rounded-lg shadow-lg max-h-64 overflow-y-auto">
                  {searchResults.map((result, index) => {
                    if (result.type === 'place') {
                      return (
                        <button
                          key={index}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            selectSearchResult(result)
                          }}
                          className="w-full px-3 py-2 text-left text-xs hover:bg-muted transition-colors border-b border-border last:border-0"
                          title={result.name}
                        >
                          <div className="flex items-start gap-2">
                            <MapPin size={14} className="mt-0.5 text-red-500 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium truncate">{result.name}</div>
                              <div className="text-xs text-foreground/80 truncate" title={`${result.address} ${result.district}`}>
                                {result.address} {result.district}
                              </div>
                            </div>
                          </div>
                        </button>
                      )
                    } else {
                      return (
                        <button
                          key={index}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            selectSearchResult(result)
                          }}
                          className="w-full px-3 py-2 text-left text-xs hover:bg-muted transition-colors border-b border-border last:border-0"
                          title={result.name}
                        >
                          <div className="flex items-start gap-2">
                            <Database size={14} className={`mt-0.5 shrink-0 ${result.networkType === 'LTE' ? 'text-blue-500' : 'text-green-500'}`} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-medium truncate">{result.name}</span>
                                <span className={`text-xs px-1.5 py-0.5 rounded ${result.networkType === 'LTE' ? 'bg-blue-500/15 text-blue-400' : 'bg-green-500/15 text-green-400'}`}>
                                  {result.networkType}
                                </span>
                              </div>
                              <div className="text-xs text-foreground/80">
                                {result.siteId && <span>基站ID: {result.siteId}</span>}
                                {result.sectorId && <span> • 小区ID: {result.sectorId}</span>}
                              </div>
                              {!result.hasLocation && (
                                <div className="text-xs text-amber-600 flex items-center gap-1 mt-1">
                                  <AlertTriangle size={10} />
                                  {t('map.noCoordinate') || '缺少坐标信息'}
                                </div>
                              )}
                            </div>
                          </div>
                        </button>
                      )
                    }
                  })}
                </div>
              )}

              {/* 搜索中提示 */}
              {searching && (
                <div className="bg-card border border-border rounded-lg shadow-lg p-3 text-xs text-foreground/80 flex items-center justify-center gap-2">
                  <Loader2 className="animate-spin" size={14} />
                  {t('map.searching') || '搜索中...'}
                </div>
              )}

              {/* 无结果提示 */}
              {showSearchResults && searchResults.length === 0 && !searching && (
                <div className="bg-card border border-border rounded-lg shadow-lg p-3 text-xs text-foreground/80">
                  {searchMode === 'map' ? (t('map.noRelatedPlace') || '未找到相关地点') : (t('map.noRelatedCell') || '未找到相关小区')}
                </div>
              )}
            </div>
          </div>

          {/* 独立的清除搜索标记按钮，使用文字标签 */}
          <button
            onClick={() => {
              // 只清除各工具的轨迹/标记/选中状态，不退出已激活工具（打点/测量/圈选保持激活）
              clearAllSearch()
              setCaptureCoord(null)
              selectionManager.clearSelection()
              if (onlineMapRef.current) {
                onlineMapRef.current.clearPCIHighlight()
                onlineMapRef.current.clearNeighborHighlight()
                onlineMapRef.current.clearSelectionHighlight()
                onlineMapRef.current.clearCaptureMarkers()
                onlineMapRef.current.clearMeasurements()
                onlineMapRef.current.clearShapeSelection()
              }
            }}
            className="px-2 py-1.5 text-xs rounded hover:bg-muted transition-colors text-foreground hover:text-primary flex items-center gap-1 shrink-0"
            title={t('map.clearAllMarkers') || '清除所有搜索标记和圈选状态'}
          >
            <Trash2 size={14} />
            <span className="toolbar-label">{t('map.clear') || '清除'}</span>
          </button>
        </div>

        {/* 工具栏按钮区：渲染顺序由用户设置决定（右键工具栏可配置），按钮可拖拽调整位置；
            宽度不足时右侧放不下的按钮收进「更多」面板（收纳项不可见但保留在 DOM 中用于测宽）。
            注意：不能加 overflow-hidden——会裁掉按钮自身的下拉菜单（新建/绘制/圈选） */}
        <div
          ref={toolbarItemsRef}
          className="relative flex items-center gap-4 flex-1 min-w-0"
        >
          {toolbarPrefs.order.map((id, index) => {
            const overflowed = index >= toolbarOverflowStart
            return (
              <div
                key={id}
                data-toolbar-item={id}
                className={overflowed
                  ? 'absolute left-0 top-0 w-max whitespace-nowrap invisible pointer-events-none'
                  : 'flex items-center shrink-0 whitespace-nowrap'}
                draggable
                onDragStart={(e) => {
                  toolbarDragIdRef.current = id
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', id)
                  // 拖动过程中显示"移动中"光标（与图层面板拖动排序一致）
                  ;(e.currentTarget as HTMLElement).style.cursor = 'grabbing'
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  handleToolbarDrop(id)
                }}
                onDragEnd={(e) => {
                  const el = e.currentTarget as HTMLElement
                  el.style.cursor = ''
                }}
              >
                {toolbarButtons[id]}
              </div>
            )
          })}
        </div>

        {/* 「更多」按钮（最右端）：展开被收纳的工具按钮 */}
        {hasToolbarOverflow && (
          <div ref={toolbarMoreRef} className="relative shrink-0">
            <button
              ref={toolbarMoreBtnRef}
              onClick={() => setToolbarMoreOpen((v) => !v)}
              className={`flex items-center justify-center w-[30px] px-2 py-1.5 text-xs rounded transition-colors ${toolbarMoreOpen ? 'bg-muted text-primary' : 'text-foreground hover:bg-muted hover:text-primary'}`}
              title={t('map.toolbarMoreTools') || '更多工具'}
            >
              <ChevronsRight size={14} />
            </button>

            {toolbarMoreOpen && (
              <div className="absolute right-0 top-full mt-1 z-[4000] bg-card border border-border rounded-lg shadow-lg py-1 min-w-[168px] max-h-[70vh] overflow-y-auto">
                <div className="px-3 py-1 text-[10px] text-muted-foreground border-b border-border/60 mb-0.5">
                  {t('map.toolbarMoreTools') || '更多工具'}
                </div>
                {toolbarPrefs.order.slice(toolbarOverflowStart).map((id) => {
                  const entry = toolbarMoreEntries[id]
                  if (!entry) return null
                  const submenuOpen = toolbarMoreSubmenu === id
                  return (
                    <div key={id}>
                      <button
                        className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                          entry.disabled
                            ? 'text-muted-foreground/40 cursor-not-allowed'
                            : entry.active
                              ? 'bg-primary/10 text-primary hover:bg-muted'
                              : 'text-foreground hover:bg-muted hover:text-primary'
                        }`}
                        disabled={entry.disabled}
                        title={entry.title || entry.label}
                        onClick={() => {
                          if (entry.submenu) {
                            setToolbarMoreSubmenu((v) => (v === id ? null : id))
                            return
                          }
                          entry.onSelect?.()
                          setToolbarMoreOpen(false)
                          setToolbarMoreSubmenu(null)
                        }}
                      >
                        {entry.icon}
                        <span className="truncate">{entry.label}</span>
                        {entry.submenu && (
                          <ChevronRight
                            size={12}
                            className={`ml-auto shrink-0 opacity-60 transition-transform ${submenuOpen ? 'rotate-90' : ''}`}
                          />
                        )}
                      </button>
                      {entry.submenu && submenuOpen && entry.submenu.map((sub) => (
                        <button
                          key={sub.label}
                          onClick={() => {
                            sub.onSelect()
                            setToolbarMoreOpen(false)
                            setToolbarMoreSubmenu(null)
                          }}
                          className="w-full text-left pl-8 pr-3 py-1.5 text-xs flex items-center gap-2 text-foreground hover:bg-muted hover:text-primary transition-colors"
                        >
                          {sub.icon}
                          <span className="truncate">{sub.label}</span>
                        </button>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>



      {/* 地图内容区域 */}
      <div className="flex-1 relative min-h-0 bg-muted/20 map-container" style={{ overflow: 'hidden' }}>
        {viewMode === 'online' ? (
          <>
            <OnlineMap
              ref={onlineMapRef}
              layerFiles={layerFiles}
              pointFiles={pointFiles}
              measureMode={measureMode}
              onMeasureModeEnd={() => setMeasureMode(false)}
              frequencies={frequencies}
              customLayers={customLayers}
              onViewModeChange={setViewMode}
              initialLayerVisibility={{
                lte: layers.find(l => l.id === 'lte-sectors')?.visible ?? false,
                nr: layers.find(l => l.id === 'nr-sectors')?.visible ?? false
              }}
              sectorLabelVisibility={sectorLabelVisibility}
              labelSettingsMap={labelSettingsMap}
              selectionMode={selectionMode}
              onSelectionModeEnd={() => {
                setSelectionMode('none')
                // 退出框选模式时不清除拖拽工具状态，保留已绘制的框选图形
                // 框选模式和拖拽工具独立管理
              }}
              mapDragTool={mapDragTool}
              captureMode={captureMode}
              onCaptureCoord={(lng, lat) => setCaptureCoord({ lng, lat })}
              onCaptureBlocked={handleCaptureBlocked}
              decorationLayerVisible={decorationLayer.visible}
              decorationLabelVisible={decorationLabelVisible}
              layerOrder={mapSettings.layerOrder}
              selectableMap={mapSettings.selectableMap}
            />

            {/* 图层控制面板 */}
            <LayerControl
              sectors={sectorLayers}
              layerFiles={layerFiles}
              pointFiles={pointFiles}
              pointFileData={onlineMapRef.current?.getPointFileData() || {}}
              onSectorToggle={handleLayerToggle}
              onSectorLabelToggle={handleSectorLabelToggle}
              onLayerFileToggle={handleLayerFileToggle}
              onMapTypeChange={handleMapTypeChange}
              mapType={mapType}
              sectorLabelVisibility={sectorLabelVisibility}
              pointFileLabelVisibility={pointFileLabelVisibility}
              onPointFileLabelToggle={handlePointFileLabelToggle}
              layerFileLabelVisibility={layerFileLabelVisibility}
              onLayerFileLabelToggle={handleLayerFileLabelToggle}
              frequencies={frequencies}
              onFrequencyToggle={handleFrequencyToggle}
              customLayers={customLayers}
              onCustomLayerToggle={handleCustomLayerToggle}
              onLayerFileRemove={handleRemoveLayerFile}
              onCustomLayerRemove={handleRemoveCustomLayer}
              onLabelSettingsChange={handleLabelSettingsChange}
              labelSettingsMap={labelSettingsMap}
              onColorSettingsChange={handleColorSettingsChange}
              colorSettingsMap={colorSettingsMap}
              onThematicSettingsChange={handleThematicSettingsChange}
              thematicSettingsMap={thematicSettingsMap}
              onHeatmapSettingsChange={handleHeatmapSettingsChange}
              heatmapSettingsMap={heatmapSettingsMap}
              heatmapStats={heatmapStats}
              openThematicFor={openThematicFor}
              onLayerPreview={handleLayerPreview}
              thematicTemplates={mapSettings.thematicTemplates || []}
              onSaveThematicTemplate={handleSaveThematicTemplate}
              onRemoveThematicTemplate={handleRemoveThematicTemplate}
              heatmapTemplates={mapSettings.heatmapTemplates || []}
              onSaveHeatmapTemplate={handleSaveHeatmapTemplate}
              onRemoveHeatmapTemplate={handleRemoveHeatmapTemplate}
              sectorData={sectorDataCache}
              onFrequencyColorChange={handleFrequencyColorChange}
              decorationLayer={decorationLayer}
              decorationLabelVisible={decorationLabelVisible}
              onDecorationLabelToggle={handleDecorationLabelToggle}
              layerOrder={mapSettings.layerOrder}
              selectableMap={mapSettings.selectableMap}
              onSelectableToggle={handleSelectableToggle}
              editableLayerId={editableLayerId}
              onEditableToggle={handleEditableToggle}
              onReorderLayers={handleReorderLayers}
            />

            {/* 专题图层图例（随图层勾选/配置实时刷新；双击图例跳转专题设置） */}
            <ThematicLegend items={thematicLegendItems} stats={thematicStats} onItemDoubleClick={handleLegendItemDoubleClick} />
            {/* PCI模值图例（小区PCI渲染开启后显示；双击跳转默认设置） */}
            <PciModLegend items={pciRenderLegendItems} stats={pciRenderStats} onItemDoubleClick={handlePciRenderLegendDoubleClick} />
            {/* 热力图图例（连续渐变色带 + 权重 min/max + 点数） */}
            <HeatmapLegend items={heatmapLegendItems} stats={heatmapStats} onItemDoubleClick={handleHeatmapLegendItemDoubleClick} />

          </>
        ) : (
          <OfflineMap data={offlineData} offlinePath={offlinePath} />
        )}

        {/* 全屏悬浮按钮：贴在地图右上角（顶部工具栏下方的地图内）。
            absolute 定位在地图容器内，窗口/侧栏尺寸变化时始终吸附地图边缘 */}
        <button
          onClick={toggleFullscreen}
          className="absolute top-3 right-3 z-[1200] w-9 h-9 flex items-center justify-center rounded-lg bg-card/95 border border-border shadow-md text-muted-foreground hover:text-primary hover:bg-muted transition-colors"
          title={isFullscreen ? (t('map.exitFullscreen') || '退出全屏') : (t('map.fullscreen') || '全屏')}
          aria-label={isFullscreen ? (t('map.exitFullscreen') || '退出全屏') : (t('map.fullscreen') || '全屏')}
        >
          {isFullscreen ? <Shrink size={16} /> : <Move size={16} />}
        </button>
      </div>

      {/* Ctrl+F 地图搜索弹窗（仅在线模式：数据源搜索 + 定位高亮） */}
      {viewMode === 'online' && (
        <MapSearchDialog
          open={searchDialogOpen}
          onOpenChange={setSearchDialogOpen}
          searchWorkbook={handleDialogSearchWorkbook}
          workbookSourceName={currentDataSourceFile || undefined}
          onLocateSector={handleDialogLocateSector}
          onLocateLayerFeature={handleDialogLocateLayerFeature}
        />
      )}

      {/* 新建 TAB 图层弹窗（Ctrl+N） */}
      {viewMode === 'online' && (
        <NewLayerDialog
          open={newLayerDialogOpen}
          onClose={() => setNewLayerDialogOpen(false)}
          onCreated={handleLayerCreated}
        />
      )}

      {/* 条件选择弹窗：两图层属性按地理位置空间连接并导出 Excel */}
      {viewMode === 'online' && (
        <AttributeJoinDialog
          open={joinDialogOpen}
          onClose={() => setJoinDialogOpen(false)}
          layers={layers}
          layerFiles={layerFiles}
          pointFiles={pointFiles}
        />
      )}

      {/* 绘制缓冲区弹窗：参考图层按米制球面距离生成缓冲多边形并直接保存 */}
      {viewMode === 'online' && (
        <BufferDialog
          open={bufferDialogOpen}
          onClose={() => setBufferDialogOpen(false)}
          layers={layers}
          layerFiles={layerFiles}
          pointFiles={pointFiles}
          onSaved={handleBufferSaved}
        />
      )}

      {/* 保存图层弹窗（Ctrl+S）：列出未保存编辑的图层供勾选 */}
      {viewMode === 'online' && (
        <SaveLayersDialog
          open={saveDialogOpen}
          dirtyLayers={dirtyLayerItems}
          saving={savingLayers}
          onClose={() => setSaveDialogOpen(false)}
          onSave={handleSaveLayers}
          onSaveAs={handleSaveLayersAs}
        />
      )}

      {/* 文件导出弹窗：列出所有导入的文件，勾选后导出（TAB 套装 zip / 表格 xlsx） */}
      {viewMode === 'online' && (
        <MapExportDialog
          open={exportDialogOpen}
          onClose={() => setExportDialogOpen(false)}
          layerFiles={layerFiles}
        />
      )}

      {/* 点/线/面绘制样式弹窗 */}
      {viewMode === 'online' && styleModalTab && (
        <DrawStyleModal
          open={!!styleModalTab}
          tab={styleModalTab}
          onClose={() => setStyleModalTab(null)}
        />
      )}

      {/* 要素属性与风格配置弹窗（"选择"工具下双击要素） */}
      {viewMode === 'online' && inspectFeature && (
        <FeatureStyleDialog
          open={!!inspectFeature}
          data={inspectFeature}
          layerName={layerFiles.find((f) => f.id === inspectFeature.layerId)?.name}
          onClose={() => useLayerEditStore.getState().setInspectFeature(null)}
        />
      )}

      {/* 工具栏右键设置菜单：标签文字显隐 + 提示拖拽排序 + 恢复默认 */}
      {toolbarMenu && (
        <div
          className="fixed z-[6000] bg-card border border-border rounded-lg shadow-lg py-1 w-48"
          style={{ left: toolbarMenu.x, top: toolbarMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-[10px] text-muted-foreground border-b border-border/60 mb-0.5">
            {t('map.toolbarSettings') || '工具栏设置'}
          </div>
          <button
            onClick={() => {
              setToolbarPrefs((p) => ({ ...p, showLabels: !p.showLabels }))
              setToolbarMenu(null)
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-foreground hover:bg-muted hover:text-primary transition-colors"
          >
            {toolbarPrefs.showLabels
              ? (t('map.toolbarHideLabels') || '隐藏标签文字')
              : (t('map.toolbarShowLabels') || '显示标签文字')}
          </button>
          <div className="px-3 py-1 text-[10px] text-muted-foreground">
            {t('map.toolbarDragHint') || '拖动按钮可调整位置'}
          </div>
          <button
            onClick={() => {
              setToolbarPrefs({ order: [...TOOLBAR_ITEM_IDS], showLabels: true, __v: 3 })
              setToolbarMenu(null)
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-foreground hover:bg-muted hover:text-primary transition-colors border-t border-border/60"
          >
            {t('map.toolbarResetLayout') || '恢复默认布局'}
          </button>
        </div>
      )}

      {/* 工具栏标签隐藏样式（右键菜单设置） */}
      {!toolbarPrefs.showLabels && (
        <style>{`.npt-hide-toolbar-labels .toolbar-label{display:none !important;}`}</style>
      )}

      {/* 全屏模式全局样式：地图占满整个屏幕（隐藏侧栏与应用顶栏），退出按钮在地图右上角 */}
      {isFullscreen && (
        <style>{`
          body.map-fullscreen-mode aside {
            display: none !important;
          }
          body.map-fullscreen-mode > div#root > div > div:first-child {
            display: none !important;
          }
          body.map-fullscreen-mode [data-map-toolbar] {
            display: none !important;
          }
        `}</style>
      )}
    </div>
  )
}

/**
 * 获取完整下载URL
 * @param downloadUrl 下载路径（相对或绝对）
 * @returns 完整下载URL
 */
