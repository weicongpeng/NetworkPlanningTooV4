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
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Search, X, MapPin, AlertTriangle, Database, Trash2, MousePointer2, Circle as CircleIcon, Pentagon, Hand, Map as MapIcon, Satellite } from 'lucide-react'
import { OnlineMap, OnlineMapRef, CustomLayerOption } from '../components/Map/OnlineMap'
import { LayerControl, SectorLayerOption, LayerFileOption, DecorationLayerOption } from '../components/Map/LayerControl'
import { OfflineMap, createDefaultLayers } from '../components/Map'
import type { LayerOption, FrequencyOption } from '../components/Map'
import { CoordinateTransformer } from '../utils/coordinate'
import { mapApi, layerApi } from '../services/api'
import { useDataStore, DATA_REFRESH_EVENT } from '../store/dataStore'
import { useMapStore } from '../store/mapStore'
import { useMapDataCacheStore } from '../store/mapDataCacheStore'
import { mapDataService, type RenderSectorData } from '../services/mapDataService'
import { frequencyColorMapper } from '../config/sector-config'
import { LabelSettings } from '../components/Map/LabelSettingsModal'
import { TreeNode } from '../components/Map/LayerControl'
import { selectionManager } from '../services/selectionManager'

// MapInfo 图层列表缓存（避免每次挂载都重新请求）
interface LayerListCacheEntry {
  data: any[]
  time: number
}
const _layerListCache = new Map<string, LayerListCacheEntry>()
const _LAYER_LIST_CACHE_TTL = 10 * 60 * 1000 // 10分钟

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
    setDecorationLayerVisible: storeSetDecorationLayerVisible,
    setSectorLabelVisibility: storeSetSectorLabelVisibility,
    setPointFileLabelVisibility: storeSetPointFileLabelVisibility,
    setLayerFileLabelVisibility: storeSetLayerFileLabelVisibility,
    setMapType: storeSetMapType,
    setLabelSettings: storeSetLabelSettings,
    setBaseMapVisible: storeSetBaseMapVisible,
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
    const excelFiles = items
      .filter(item => item.type === 'excel' && item.status === 'ready' && item.name.startsWith('ProjectParameter_mongoose'))
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
  // 图层文件标签可见性
  const [layerFileLabelVisibility, setLayerFileLabelVisibility] = useState<Record<string, boolean>>({})
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

  // 装饰图层（打点、定位标记等）- 从持久化 store 初始化
  const [decorationLayer, setDecorationLayer] = useState<DecorationLayerOption>({
    id: 'decoration-layer',
    name: '装饰图层',
    visible: mapSettings.decorationLayerVisible,
    count: 0
  })

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
          // 检查缓存
          const cached = _layerListCache.get(mapItem.id)
          if (cached && Date.now() - cached.time < _LAYER_LIST_CACHE_TTL) {
            console.log('[MapPage] 使用图层列表缓存:', mapItem.id)
            return cached.data.map((layer: any) => ({
              id: layer.id,
              name: layer.name,
              type: layer.type as 'point' | 'line' | 'polygon',
              visible: false,
              dataId: mapItem.id,
              sourceType: 'mapinfo' as const
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
              type: layer.type as 'point' | 'line' | 'polygon',
              visible: false,
              dataId: mapItem.id,
              sourceType: 'mapinfo' as const
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

        return {
          id: item.id,
          name: item.name,
          type: type,
          visible: false,
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
    const handleDataRefresh = () => {
      console.log('[MapPage] 数据已变更，重新加载扇区数据')
      // 清除图层列表缓存
      _layerListCache.clear()
      // 重载扇区数据缓存（用于频点提取和工参搜索）
      loadSectorDataForSearch()
      // 刷新在线地图（sectorData state + 图层重绘）
      onlineMapRef.current?.refreshData()
      loadLayerFiles()
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

  // 工具控件状态
  const [measureMode, setMeasureMode] = useState(false)
  const [measurePoints, setMeasurePoints] = useState<Array<{ lng: number; lat: number }>>([])

  // 圈选模式: none, circle, polygon
  const [selectionMode, setSelectionMode] = useState<'none' | 'circle' | 'polygon' | 'point'>('none')
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

  // 地图拖拽工具状态 - 独立于框选模式
  const [mapDragTool, setMapDragTool] = useState(false)

  /**
   * 获取当前可见图层数量
   */
  const getVisibleLayerCount = useCallback(() => {
    let count = 0
    // 扇区图层
    if (layers.find(l => l.id === 'lte-sectors')?.visible) count++
    if (layers.find(l => l.id === 'nr-sectors')?.visible) count++
    // 图层文件
    count += layerFiles.filter(lf => lf.visible).length
    // 点文件/地理化数据
    count += pointFiles.filter(pf => pf.visible).length
    // 装饰图层
    if (decorationLayer.visible) count++
    return count
  }, [layers, layerFiles, pointFiles, decorationLayer.visible])

  /**
   * 处理框选模式切换
   * 框选功能和拖拽工具互斥：激活框选时禁用拖拽工具
   */
  const handleSelectionModeChange = (mode: 'circle' | 'polygon' | 'point') => {
    // 如果点击当前已激活的模式，则退出框选模式（保留选中状态，只有"清除"按钮才清除）
    if (selectionMode === mode) {
      setSelectionMode('none')
      return
    }

    const visibleCount = getVisibleLayerCount()

    // 圆形和多边形框选需要检查可见图层
    if (mode === 'circle' || mode === 'polygon') {
      if (visibleCount === 0) {
        alert(t('map.enableLayerFirst') || '请先在图层控制面板开启需要圈选的图层')
        return
      }

      if (visibleCount > 1) {
        alert(t('map.onlyOneLayerAtATime') || '当前显示图层多于1个，请先在图层控制面板关闭冗余图层，确保只显示一个目标图层再进行圈选')
        return
      }
    }

    setSelectionMode(mode)
    setMeasureMode(false)
    setCaptureMode(false)
    setCaptureCoord(null)
    if (mapDragTool) {
      setMapDragTool(false)
    }
    // 激活框选工具后，菜单列表自动收起
    setShowSelectionMenu(false)
  }

  /**
   * 处理地图拖拽工具切换
   * 拖拽工具与其他所有操作模式互斥：激活拖拽时退出所有其他模式
   */
  const handleMapDragToolToggle = () => {
    const newState = !mapDragTool
    setMapDragTool(newState)
    
    if (newState) {
      // 激活拖拽：关闭所有其他互斥模式
      setMeasureMode(false)
      setCaptureMode(false)
      setCaptureCoord(null)
      setSelectionMode('none')
      if (onlineMapRef.current) {
        onlineMapRef.current.clearSelectionHighlight()
      }
    }
  }
  const [totalDistance, setTotalDistance] = useState<number | null>(null)
  const [captureMode, setCaptureMode] = useState(false)
  const [captureCoord, setCaptureCoord] = useState<{ lng: number; lat: number } | null>(null)

  /**
   * 处理打点功能被阻止（装饰图层未勾选）
   */
  const handleCaptureBlocked = useCallback(() => {
    alert(t('map.captureRequiresDecorationLayer') || '请先勾选装饰图层后再进行打点操作')
  }, [t])

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
      // 工参搜索
      if (result.hasLocation && result.latitude !== undefined && result.longitude !== undefined) {
        const gcjLat = result.latitude
        const gcjLng = result.longitude

        if (onlineMapRef.current) {
          onlineMapRef.current.flyTo([gcjLat, gcjLng], 16)
          onlineMapRef.current.setSearchMarker({
            lng: gcjLng,
            lat: gcjLat,
            name: `${result.name} (${result.networkType})`
          })
        }
      }
    }

    setSearchKeyword(result.name)
    setShowSearchResults(false)
  }, [])



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

    if (visible && selectionMode !== 'none') {
      // 计算当前可见的图层数量（包括扇区图层和其他图层文件）
      let currentVisibleCount = 0

      // 统计可见的扇区图层数量（从layers状态获取）
      const lteLayer = layers.find(l => l.id === 'lte-sectors')
      const nrLayer = layers.find(l => l.id === 'nr-sectors')
      if (lteLayer && lteLayer.visible) currentVisibleCount++
      if (nrLayer && nrLayer.visible) currentVisibleCount++

      // 统计可见的其他图层文件（MapInfo 和 Excel）
      const otherFiles = [...layerFiles, ...pointFiles].filter(f => f.id !== fileId)
      const otherVisibleFiles = otherFiles.filter(f => f.visible)
      currentVisibleCount += otherVisibleFiles.length

      // 如果已经有一个图层可见，则阻止启用新图层
      if (currentVisibleCount >= 1) {
        alert(t('map.onlyOneLayerInSelectMode') || '框选模式下只能圈选一个图层')
        return
      }
    }

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
  }, [selectionMode, layers, layerFiles, pointFiles, storeSetLayerFileVisibility, storeSetPointFileVisibility])

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
   * 处理装饰图层可见性切换
   */
  const handleDecorationLayerToggle = useCallback((visible: boolean) => {
    console.log('[MapPage] 装饰图层切换:', visible)
    setDecorationLayer(prev => ({ ...prev, visible }))
    storeSetDecorationLayerVisible(visible)
    if (onlineMapRef.current) {
      onlineMapRef.current.setDecorationLayerVisibility(visible)
    }
  }, [storeSetDecorationLayerVisible])

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
      onlineMapRef.current.addLocationMarker(newPoint, locationPoints.length + 1)
    }
  }, [addLocationPoint, locationPoints.length])

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
    }
    // 清空定位点和测量点
    clearLocationPoints() // 使用全局store清除定位点
    setMeasurePoints([])
    setTotalDistance(null)
    setMeasureMode(false)
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
        [layerId]: true  // 强制启用标签显示
      }))

      // 应用标签设置到地图
      if (onlineMapRef.current) {
        // 传入 visible=true，确保标签显示并应用新配置
        onlineMapRef.current.setLayerFileLabelVisibility(layerId, true, settings)
      }
    }
  }, [pointFileLabelVisibility])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 地图工具栏 */}
      <div className="h-14 bg-card border-b border-border flex items-center justify-start px-4 flex-shrink-0 gap-4">
        <div className="flex items-center gap-4">

          {/* 数据源文件名显示 */}
          {currentDataSourceFile ? (
            <div className="px-3 py-1.5 bg-muted/50 rounded-md">
              <div className="flex items-center gap-2">
                <Database size={14} className="text-foreground" />
                <span className="text-xs text-foreground">{t('map.engineerParam') || '工参'}: {currentDataSourceFile}</span>
              </div>
            </div>
          ) : (
            <div className="px-3 py-1.5 bg-muted/50 rounded-md">
              <div className="flex items-center gap-2">
                <Database size={14} className="text-foreground" />
                <span className="text-xs text-foreground">{t('map.noImportFile') || '未导入工参文件'}</span>
              </div>
            </div>
          )}
        </div>

        {/* 搜索框 */}
        <div className="relative flex items-center gap-2 flex-1 justify-start">
          {/* 搜索模式切换 - 单按钮切换 */}
          <button
            onClick={() => {
              const newMode = searchMode === 'parameter' ? 'map' : 'parameter'
              setSearchMode(newMode)
              setSearchResults([])
              setShowSearchResults(false)
            }}
            className="px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 text-foreground hover:bg-muted hover:text-primary"
            title={t('map.searchModeSwitchHint') || '点击可切换工参搜索、经纬度定位和地图搜索'}
          >
            <Search size={14} />
            <span>{searchMode === 'parameter' ? (t('map.searchLocation') || '搜索定位') : (t('map.searchPlace') || '地图搜索')}</span>
          </button>
          {searchMode === 'parameter' && missingCoordCount > 0 && (
            <div className="flex items-center gap-1 ml-2 text-xs text-amber-600" title="部分扇区缺少坐标信息">
              <AlertTriangle size={12} />
              <span>{missingCoordCount}{t('map.missingCoordCells') || '个扇区缺坐标'}</span>
            </div>
          )}

          {/* 搜索输入框 */}
          <div className="relative w-[360px]">
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
              className="w-full pl-3 pr-16 py-1.5 text-xs border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
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
                                <span className={`text-xs px-1.5 py-0.5 rounded ${result.networkType === 'LTE' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
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
              clearAllSearch()
              setSelectionMode('none')
              setCaptureMode(false)
              setCaptureCoord(null)
              selectionManager.clearSelection()
              if (onlineMapRef.current) {
                onlineMapRef.current.clearPCIHighlight()
                onlineMapRef.current.clearNeighborHighlight()
                onlineMapRef.current.clearSelectionHighlight()
                onlineMapRef.current.clearCaptureMarkers()
              }
            }}
            className="px-2 py-1.5 text-xs rounded hover:bg-muted transition-colors text-foreground hover:text-primary flex items-center gap-1"
            title={t('map.clearAllMarkers') || '清除所有搜索标记和圈选状态'}
          >
            <Trash2 size={14} />
            {t('map.clear') || '清除'}
          </button>

          {/* 提取坐标按钮 */}
          <button
            className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${captureMode ? 'bg-blue-400 text-white hover:bg-blue-500' : 'text-foreground hover:bg-muted hover:text-primary'}`}
            onClick={() => {
              // 激活/关闭提取坐标：激活时关闭所有其他互斥模式
              const newMode = !captureMode
              if (newMode) {
                setMeasureMode(false)
                setSelectionMode('none')
                setMapDragTool(false)
              } else {
                setCaptureCoord(null)
              }
              setCaptureMode(newMode)
            }}
            title={captureMode ? (t('map.exitCaptureMode') || '退出打点') : (t('map.captureModeHint') || '点击地图任意位置抓取WGS84坐标')}
          >
            <div className="w-4 h-4 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            </div>
            <span>{captureMode ? (t('map.exitCaptureMode') || '退出打点') : (t('map.extractCoord') || '打点')}</span>
          </button>

          {/* 测距按钮 */}
          <button
            className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${measureMode ? 'bg-blue-400 text-white hover:bg-blue-500' : 'text-foreground hover:bg-muted hover:text-primary'
              }`}
            onClick={() => {
              const newState = !measureMode
              setMeasureMode(newState)
              if (newState) {
                // 激活测距：关闭所有其他互斥模式
                setCaptureMode(false)
                setCaptureCoord(null)
                setSelectionMode('none')
                setMapDragTool(false)
              }
            }}
            title={measureMode ? (t('map.exitDistanceMode') || '退出测距模式') : (t('map.distanceMode') || '测距工具')}
          >
            <div className="w-4 h-4 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2h8v20H8V2z"></path><path d="M13 6h3"></path><path d="M13 10h3"></path><path d="M13 14h3"></path><path d="M13 18h3"></path></svg>
            </div>
            <span>{t('map.measure') || '测距'}</span>
          </button>

          {/* 地图拖拽工具按钮 - 始终显示 */}
          <button
            className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${mapDragTool ? 'bg-blue-400 text-white hover:bg-blue-500' : 'text-foreground hover:bg-muted hover:text-primary'
              }`}
            onClick={handleMapDragToolToggle}
            title={mapDragTool ? (t('map.disableDrag') || '禁用地图拖拽') : (t('map.enableDrag') || '启用地图拖拽')}
          >
            <Hand size={14} />
            <span>{t('map.drag') || '拖拽'}</span>
          </button>

          {/* 圈选按钮 */}
          <div className="relative" ref={selectionMenuRef}>
            <button
              className={`px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-1 ${selectionMode !== 'none' ? 'bg-blue-400 text-white hover:bg-blue-500' : 'text-foreground hover:bg-muted hover:text-primary'
                }`}
              onClick={() => {
                if (selectionMode !== 'none') {
                  // 退出框选模式，但保留已选中的要素高亮（持久化）
                  // 只有"清除"按钮才清除选中状态
                  setSelectionMode('none')
                } else {
                  // 否则显示框选菜单
                  setShowSelectionMenu(!showSelectionMenu)
                }
              }}
              title={selectionMode !== 'none' ? (t('map.exitSelectMode') || '退出框选模式（按ESC也可退出）') : (t('map.mapSelectTool') || '地图圈选工具')}
            >
              {selectionMode === 'point' && <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>}
              {selectionMode === 'circle' && <CircleIcon size={14} />}
              {selectionMode === 'polygon' && <Pentagon size={14} />}
              {selectionMode === 'none' && <MousePointer2 size={14} />}
              <span>
                {selectionMode === 'point'
                  ? (t('map.pointSelect') || '框选')
                  : selectionMode === 'circle'
                    ? (t('map.circleSelect') || '圆形')
                    : selectionMode === 'polygon'
                      ? (t('map.polygonSelect') || '多边形')
                      : (t('map.select') || '选择')}
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
              </div>
            )}
          </div>

          {/* 地图类型切换按钮：平面图 → 卫星图 → 关闭底图 三态循环 */}
          <button
            onClick={() => {
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
            }}
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
                <span>{t('map.emptyMap') || '空地图'}</span>
              </>
            ) : mapType === 'roadmap' ? (
              <>
                <MapIcon size={14} />
                <span>{t('map.vector') || '平面图'}</span>
              </>
            ) : (
              <>
                <Satellite size={14} />
                <span>{t('map.satellite') || '卫星图'}</span>
              </>
            )}
          </button>


        </div>

        {/* 右侧地图控件占位 */}
        <div className="flex items-center gap-4 ml-auto">
        </div>
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
              decorationLayer={decorationLayer}
              onDecorationLayerToggle={handleDecorationLayerToggle}
            />

          </>
        ) : (
          <OfflineMap data={offlineData} offlinePath={offlinePath} />
        )}
      </div>
    </div>
  )
}
