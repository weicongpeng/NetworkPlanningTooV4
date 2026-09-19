/**
 * 图层控制组件 - 树形结构版本
 *
 * 功能:
 * - 树形层级结构展示图层
 * - 支持展开/折叠节点
 * - 在线地图子项：平面地图/卫星地图切换
 * - 工参扇区图: LTE/NR子图层
 * - 图层文件: 外部导入的MapInfo文件
 * - 右键菜单支持标签设置
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { ChevronDown, ChevronRight, Map, Folder, File, X, Satellite, Radio, MapPin, Route, Hexagon, Settings, Maximize2, MousePointer2, Pencil, Type } from 'lucide-react'
import { HexColorPicker } from 'react-colorful'
import { useTranslation } from 'react-i18next'
import { NetworkType } from '../../config/sector-config'
import { LabelSettingsModal, LabelSettings, LayerColorSettings, FieldOption, ThematicSettings, ThematicTemplate, ThematicRange, HeatmapSettings, HeatmapTemplate } from './LabelSettingsModal'
import type { HeatmapStats } from './HeatmapLayerManager'
import { dataApi, layerApi } from '../../services/api'
import { useMapStore } from '../../store/mapStore'
import type { LayerCategory, LayerOrderMap } from '../../store/mapStore'
import { useMapDataCacheStore } from '../../store/mapDataCacheStore'
import { getFieldValue, hasValue, FieldValueSample, NO_FILL_COLOR } from '../../utils/fieldValue'
import { orderWithIds, isLayerSelectable } from './layerZOrder'

/**
 * 预定义的标签字段列表
 * 用于扇区标签设置的下拉选项
 */
const PREDEFINED_LABEL_FIELDS: FieldOption[] = [
  { value: 'name', label: '小区名称' },
  { value: 'networkType', label: '网络类型' },
  { value: 'siteId', label: '基站ID' },
  { value: 'sectorId', label: '小区ID' },
  { value: 'coverageType', label: '覆盖类型' },
  { value: 'frequency', label: '下行频点（MHz）' },
  { value: 'pci', label: 'PCI' },
  { value: 'tac', label: 'TAC' },
  { value: 'longitude', label: '经度' },
  { value: 'latitude', label: '纬度' },
  { value: 'azimuth', label: '方向角' },
  { value: 'height', label: '天线挂高' },
  { value: 'isShared', label: '是否共享' },
  { value: 'firstGroup', label: '厂家' }
]

// 预定义字段的翻译map - 用于动态获取翻译
const PREDEFINED_FIELDS_I18N: Record<string, string> = {
  'name': 'pci.sectorName',
  'siteId': 'pci.siteId',
  'frequency': 'pci.frequency',
  'pci': 'pci.originalPci',
  'tac': 'tac.tacCode',
  'isShared': 'common.yes',
  'coverageType': 'coverageType'
}

/**
 * 扇形图标组件
 */
const SectorIcon = ({ color }: { color: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M7 12L2 5.5C3.5 3.5 10.5 3.5 12 5.5L7 12Z"
      stroke={color}
      strokeWidth="0.5"
      strokeLinejoin="round"
      fill="transparent"
    />
  </svg>
)

/**
 * 右键菜单项统一样式
 */
const menuItemStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '8px 12px',
  fontSize: '12px',
  color: 'hsl(var(--foreground))',
  cursor: 'pointer',
  border: 'none',
  backgroundColor: 'transparent',
  textAlign: 'left',
  borderRadius: '4px'
}

/**
 * 树节点类型
 */
type TreeNodeType = 'root' | 'sector-group' | 'layer-files' | 'sector-layer' | 'sector-label' | 'layer-file' | 'layer-file-label' | 'map-type' | 'frequency' | 'custom-group' | 'custom-layer' | 'decoration-group' | 'decoration-layer'

/**
 * 扇区图层选项
 */
export interface SectorLayerOption {
  id: string
  label: string
  type: NetworkType
  visible: boolean
  icon: string
  color: string
}

/**
 * 图层文件选项
 */
export interface LayerFileOption {
  id: string
  name: string
  type: 'point' | 'line' | 'polygon' | 'sector' | 'mixed'
  visible: boolean
  dataId: string
  sourceType?: 'mapinfo' | 'excel'
  geometryType?: 'point' | 'sector' | 'polygon'
  /** 是否可编辑（仅 .tab 源的 MapInfo 图层支持绘制/保存） */
  editable?: boolean
  /** 是否本工具新建的图层（metadata.editable=true）；数据管理导入的文件为 false，导出走原始文件下载 */
  toolCreated?: boolean
  /** 图层文件自带的默认样式（用于自定义设置弹窗初始化，还原 tab/mif/kml 默认配置） */
  defaultStyle?: {
    fillColor?: string
    fillOpacity?: number
    strokeColor?: string
    strokeWidth?: number
    markerColor?: string
    markerSize?: number
    [key: string]: any
  }
}

/**
 * 自定义图层控制选项 (点/线/面)
 */
export interface CustomLayerOption {
  id: string
  name: string
  type: 'point' | 'line' | 'polygon'
  visible: boolean
}

/**
 * 装饰图层选项（用于打点、定位标记等装饰性元素）
 */
export interface DecorationLayerOption {
  id: string
  name: string
  visible: boolean
  count?: number // 装饰点数量
}

/**
 * 地图类型选项
 */
export interface MapTypeOption {
  id: 'roadmap' | 'satellite'
  label: string
  visible: boolean
}

/**
 * 频点选项
 */
export interface FrequencyOption {
  frequency: number
  color: string
  strokeColor: string
  visible: boolean
  networkType: NetworkType
  count?: number // 小区数量
}

/**
 * 树节点接口
 */
export interface TreeNode {
  id: string
  type: TreeNodeType
  label: string
  expanded?: boolean
  children?: TreeNode[]
  // 扇区图层专用
  sectorLayer?: SectorLayerOption
  // 扇区标签专用
  sectorLabel?: {
    layerId: string
    visible: boolean
  }
  // 点文件标签专用
  pointFileLabel?: {
    fileId: string
    visible: boolean
  }
  // 图层文件专用
  layerFile?: LayerFileOption
  // 图层文件标签专用
  layerFileLabel?: {
    fileId: string
    visible: boolean
  }
  // 地图类型专用
  mapType?: MapTypeOption
  // 频点专用
  frequency?: FrequencyOption
  // 自定义图层专用
  customLayer?: CustomLayerOption
  // 装饰图层专用
  decorationLayer?: DecorationLayerOption
  // 单选
  radio?: boolean
}

/**
 * 图层控制组件属性
 */
export interface LayerControlProps {
  /** 扇区图层选项 */
  sectors?: SectorLayerOption[]
  /** 外部图层文件 (MapInfo) */
  layerFiles?: LayerFileOption[]
  /** 点图层文件 (Excel) */
  pointFiles?: LayerFileOption[]
  /** 点文件数据映射（用于动态提取列名） */
  pointFileData?: Record<string, any[]>
  /** 图层可见性变化回调 */
  onSectorToggle?: (layerId: string, visible: boolean) => void
  /** 扇区标签可见性变化回调 */
  onSectorLabelToggle?: (layerId: string, visible: boolean) => void
  /** 图层文件可见性变化回调 */
  onLayerFileToggle?: (fileId: string, visible: boolean) => void
  /** 地图类型变化回调 */
  onMapTypeChange?: (type: 'roadmap' | 'satellite') => void
  /** 当前地图类型 */
  mapType?: 'roadmap' | 'satellite'
  /** 当前扇区标签可见性 */
  sectorLabelVisibility?: Record<string, boolean>
  /** 当前点文件标签可见性 */
  pointFileLabelVisibility?: Record<string, boolean>
  /** 当前图层文件标签可见性 */
  layerFileLabelVisibility?: Record<string, boolean>
  /** 点文件标签可见性变化回调 */
  onPointFileLabelToggle?: (fileId: string, visible: boolean) => void
  /** 图层文件标签可见性变化回调 */
  onLayerFileLabelToggle?: (fileId: string, visible: boolean) => void
  /** 频点列表（按网络类型分组） */
  frequencies?: { lte: FrequencyOption[]; nr: FrequencyOption[] }
  /** 频点可见性变化回调 */
  onFrequencyToggle?: (networkType: NetworkType, frequency: number, visible: boolean) => void
  /** 自定义图层 */
  customLayers?: CustomLayerOption[]
  /** 自定义图层可见性变化回调 */
  onCustomLayerToggle?: (layerId: string, visible: boolean) => void
  /** 移除图层文件回调 */
  onLayerFileRemove?: (fileId: string) => void
  /** 移除自定义图层回调 */
  onCustomLayerRemove?: (layerId: string) => void
  /** 标签设置变化回调 */
  onLabelSettingsChange?: (node: TreeNode, settings: LabelSettings) => void
  /** 标签设置映射 */
  labelSettingsMap?: Record<string, LabelSettings>
  /** 图层颜色设置变化回调 */
  onColorSettingsChange?: (node: TreeNode, settings: LayerColorSettings) => void
  /** 图层颜色设置映射 */
  colorSettingsMap?: Record<string, LayerColorSettings>
  /** 专题图层设置变化回调（null 表示关闭专题） */
  onThematicSettingsChange?: (node: TreeNode, settings: ThematicSettings | null) => void
  /** 保存热力图设置（null=关闭），由 MapPage 应用到 OnlineMap */
  onHeatmapSettingsChange?: (node: TreeNode, settings: HeatmapSettings | null) => void
  /** 专题图层设置映射 */
  thematicSettingsMap?: Record<string, ThematicSettings>
  /** 热力图设置映射 */
  heatmapSettingsMap?: Record<string, HeatmapSettings>
  /** 各图层在地图上的热力统计（含渲染场分布，供设置弹窗按同一基准做分级预览） */
  heatmapStats?: Record<string, HeatmapStats | null>
  /** 外部跳转指令：打开指定图层的专题/热力图设置页（图例双击） */
  openThematicFor?: { layerId: string; ts: number; subTab?: 'thematic' | 'heatmap' } | null
  /** 图层预览回调（右键菜单：居中并最大化显示该图层全部要素） */
  onLayerPreview?: (fileId: string) => void
  /** 已保存的区间配色模板列表 */
  thematicTemplates?: ThematicTemplate[]
  /** 保存区间配色模板回调 */
  onSaveThematicTemplate?: (name: string, ranges: ThematicRange[]) => void
  /** 删除区间配色模板回调 */
  onRemoveThematicTemplate?: (id: string) => void
  /** 已保存的热力图设置模板列表 */
  heatmapTemplates?: HeatmapTemplate[]
  /** 保存热力图设置模板回调 */
  onSaveHeatmapTemplate?: (name: string, settings: HeatmapTemplate['settings']) => void
  /** 删除热力图设置模板回调 */
  onRemoveHeatmapTemplate?: (id: string) => void
  /** 扇区数据（用于基站专题图层字段样本提取） */
  sectorData?: { lte: any[]; nr: any[] }
  /** 频点自定义配色变化回调（默认设置模式下点击频点色块） */
  onFrequencyColorChange?: (networkType: NetworkType, frequency: number, colors: { color: string; strokeColor: string }) => void
  /** 装饰图层 */
  decorationLayer?: DecorationLayerOption
  /** 装饰图层可见性变化回调 */
  onDecorationLayerToggle?: (visible: boolean) => void
  /** 装饰图层标签可见性 */
  decorationLabelVisible?: boolean
  /** 装饰图层标签可见性变化回调 */
  onDecorationLabelToggle?: (visible: boolean) => void
  /** 各类别内部图层顺序（控制面板上下拖拽，索引 0 = 最上）；跨类别层级固定：基站 > 图层文件 > 地理化数据 > 装饰图层 */
  layerOrder?: LayerOrderMap
  /** 图层"可选"开关映射（鼠标箭头按钮），未收录视为 true */
  selectableMap?: Record<string, boolean>
  /** 图层"可选"开关变化回调 */
  onSelectableToggle?: (layerId: string, selectable: boolean) => void
  /** 当前可编辑图层 id（全局互斥，仅一个；null = 无） */
  editableLayerId?: string | null
  /** 图层"可编辑"开关变化回调（铅笔按钮） */
  onEditableToggle?: (layerId: string, active: boolean) => void
  /** 类别内图层拖拽排序完成回调（newOrder 索引 0 = 面板最上） */
  onReorderLayers?: (category: LayerCategory, newOrder: string[]) => void
}

/**
 * 图层控制组件 - 树形结构
 */
export function LayerControl({
  sectors = [],
  layerFiles = [],
  pointFiles = [],
  pointFileData = {},
  onSectorToggle,
  onSectorLabelToggle,
  onLayerFileToggle,
  onMapTypeChange,
  mapType = 'roadmap',
  sectorLabelVisibility = {},
  pointFileLabelVisibility = {},
  layerFileLabelVisibility = {},
  onPointFileLabelToggle,
  onLayerFileLabelToggle,
  frequencies = { lte: [], nr: [] },
  onFrequencyToggle,
  customLayers = [],
  onCustomLayerToggle,
  onLayerFileRemove,
  onCustomLayerRemove,
  onLabelSettingsChange,
  onColorSettingsChange,
  colorSettingsMap,
  onThematicSettingsChange,
  onHeatmapSettingsChange,
  thematicSettingsMap,
  heatmapSettingsMap,
  heatmapStats,
  openThematicFor,
  onLayerPreview,
  thematicTemplates = [],
  onSaveThematicTemplate,
  onRemoveThematicTemplate,
  heatmapTemplates,
  onSaveHeatmapTemplate,
  onRemoveHeatmapTemplate,
  decorationLayer,
  onDecorationLayerToggle,
  decorationLabelVisible,
  onDecorationLabelToggle,
  sectorData,
  onFrequencyColorChange,
  layerOrder,
  selectableMap,
  onSelectableToggle,
  editableLayerId,
  onEditableToggle,
  onReorderLayers
}: LayerControlProps) {
  const { t } = useTranslation()

  // 从持久化 store 获取标签设置
  const { mapSettings, setLabelSettings: storeUpdateLabelSettings, setColorSettings: storeUpdateColorSettings, setThematicSettings: storeUpdateThematicSettings, setHeatmapSettings: storeUpdateHeatmapSettings } = useMapStore()
  const persistedLabelSettings = mapSettings.labelSettingsMap
  const persistedColorSettings = colorSettingsMap ?? mapSettings.colorSettingsMap ?? {}
  const persistedThematicSettings = thematicSettingsMap ?? mapSettings.thematicSettingsMap ?? {}
  const persistedHeatmapSettings = heatmapSettingsMap ?? mapSettings.heatmapSettingsMap ?? {}
  // 边界裁剪的可选面图层：图层文件 + 地理化数据中的面类型（两者都带来源标记供分别加载）
  const polygonLayers = useMemo(
    () => [
      ...layerFiles.filter(f => f.type === 'polygon').map(f => ({ id: f.id, dataId: f.dataId, name: f.name, source: 'mapinfo' as const })),
      ...pointFiles.filter(f => f.type === 'polygon').map(f => ({ id: f.id, dataId: f.dataId, name: f.name, source: 'excel' as const })),
    ],
    [layerFiles, pointFiles]
  )

  // 各扇区图层是否已启用专题图层（专题激活时频点色块不可点击自定义配色）
  const sectorThematicActive = useMemo(() => {
    const map: Record<string, boolean> = {}
    for (const s of sectors) {
      map[s.id] = !!persistedThematicSettings[s.id]?.enabled
    }
    return map
  }, [sectors, persistedThematicSettings])

  // 用户手动切换的展开节点ID集合
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set(['root', 'sector-group', 'custom-group']))

  // 标签设置弹窗状态
  const [showLabelSettingsModal, setShowLabelSettingsModal] = useState(false)
  const [currentSettingsNode, setCurrentSettingsNode] = useState<TreeNode | null>(null)
  const [currentLabelSettings, setCurrentLabelSettings] = useState<LabelSettings>({
    content: 'name',
    color: '#000000',
    fontSize: 12,
    fontFamily: 'sans-serif',
    bold: false,
    italic: false,
    shadow: false,
    background: 'none',
    backgroundColor: '#ffffff'
  })

  // 图层颜色设置弹窗状态
  const [activeTab, setActiveTab] = useState<'label' | 'color'>('label')
  const [currentColorSettings, setCurrentColorSettings] = useState<LayerColorSettings>({
    fillColor: '#3b82f6',
    fillOpacity: 0.6,
    borderWidth: 2,
    borderColor: '#000000'
  })

  // 专题图层设置弹窗状态
  const [currentThematicSettings, setCurrentThematicSettings] = useState<ThematicSettings | null>(null)
  const [currentHeatmapSettings, setCurrentHeatmapSettings] = useState<HeatmapSettings | null>(null)
  /** 当前设置图层在地图上的热力统计（打开弹窗时快照，供分级预览取渲染场分布） */
  const [currentHeatmapStats, setCurrentHeatmapStats] = useState<HeatmapStats | null>(null)
  const [thematicFieldSamples, setThematicFieldSamples] = useState<Record<string, any[]>>({})
  const [loadingThematicSamples, setLoadingThematicSamples] = useState(false)
  // 颜色设置页初始子页（图例双击跳转时打开专题图层页）
  const [modalInitialSubTab, setModalInitialSubTab] = useState<'basic' | 'thematic' | 'heatmap' | undefined>(undefined)
  // 专题字段样本缓存（避免重复提取同一图层）
  const thematicSamplesCacheRef = useRef<Record<string, Record<string, any[]>>>({})

  // 字段选项状态 - 初始化为预定义字段，避免右键时为空
  const [fieldOptions, setFieldOptions] = useState<FieldOption[]>(PREDEFINED_LABEL_FIELDS)
  const [loadingFields, setLoadingFields] = useState(false)

  // 字段选项缓存 - 避免重复请求同一图层（使用简单的对象存储）
  const fieldOptionsCacheRef = useRef<Record<string, FieldOption[]>>({})

  // 获取缓存实例
  const getCache = useCallback((): Record<string, FieldOption[]> => {
    if (!fieldOptionsCacheRef.current) {
      fieldOptionsCacheRef.current = {}
    }
    return fieldOptionsCacheRef.current
  }, [])

  /**
   * 获取LTE/NR扇区的字段选项
   */
  const fetchSectorFieldOptions = useCallback(async (networkType: 'LTE' | 'NR') => {
    setLoadingFields(true)
    try {
      // 直接使用预定义的字段列表，不进行过滤
      // 字段映射会在实际渲染标签时处理，这里只提供选项
      console.log(`[LayerControl] 使用预定义字段列表 (${networkType})`)

      setFieldOptions(PREDEFINED_LABEL_FIELDS)
      console.log(`[LayerControl] ${networkType}可用字段:`, PREDEFINED_LABEL_FIELDS.map(f => f.label))
    } catch (error) {
      console.error('[LayerControl] 获取扇区字段失败:', error)
      // 出错时使用预定义字段作为后备
      setFieldOptions(PREDEFINED_LABEL_FIELDS)
    } finally {
      setLoadingFields(false)
    }
  }, [])

  /**
   * 获取图层文件的字段选项（带缓存）
   */
  const fetchLayerFileFieldOptions = useCallback(async (dataId: string, layerId: string) => {
    // 生成缓存键
    const cacheKey = `${dataId}-${layerId}`
    const cache = getCache()

    // 检查缓存
    if (cacheKey in cache) {
      console.log('[LayerControl] 使用缓存的字段选项:', cacheKey)
      const cachedOptions = cache[cacheKey]
      setFieldOptions(cachedOptions)
      return
    }

    setLoadingFields(true)
    try {
      const response = await layerApi.getLayerColumns(dataId, layerId)
      if (response.success && response.data) {
        const fields = response.data.fields || []
        const options: FieldOption[] = fields.map((field: string) => ({
          value: field,
          label: field
        }))

        // 存入缓存
        cache[cacheKey] = options
        setFieldOptions(options)
        console.log('[LayerControl] 获取到图层数据字段:', options.length, '已缓存')
      } else {
        setFieldOptions([])
      }
    } catch (error) {
      console.error('[LayerControl] 获取图层数据字段失败:', error)
      setFieldOptions([])
    } finally {
      setLoadingFields(false)
    }
  }, [getCache])

  /**
   * 从记录数组中聚合字段值样本（去重，每字段限 N 个）
   * 兼容两种数据形态：GeoJSON features（MapInfo）与 item 数组（Excel，properties 嵌套）
   */
  /**
   * 从记录数组中聚合字段值样本（去重，每字段限 N 个；含质心坐标用于地理隔离配色）
   * 兼容两种数据形态：GeoJSON features（MapInfo）与 item 数组（Excel，properties 嵌套）
   */
  const collectFieldSamples = useCallback((records: any[], maxValuesPerField = 1800): Record<string, FieldValueSample[]> => {
    const EXCLUDE = new Set(['_style', 'properties', 'attributes', 'longitude', 'latitude', 'displayLng', 'displayLat', 'type', 'geometry', 'path', 'azimuth', 'beamwidth', 'cell_cover_type'])
    const map: Record<string, FieldValueSample[]> = {}
    const seen: Record<string, Set<string>> = {}
    // 坐标累计（质心 = 平均值）+ 出现次数（seen，用于热力图预览按真实分布加权）
    const acc: Record<string, Record<string, { latSum: number; lngSum: number; count: number; seen: number }>> = {}
    for (const rec of records) {
      // 提取要素坐标（GeoJSON: geometry.coordinates [lng, lat]；Excel item: displayLat/displayLng 或 latitude/longitude）
      let lat: number | undefined
      let lng: number | undefined
      if (rec?.geometry?.coordinates) {
        const c = rec.geometry.coordinates
        const flat = Array.isArray(c[0]) ? c[0] : c
        lng = Number(flat[0])
        lat = Number(flat[1])
      } else if (rec?.path && Array.isArray(rec.path) && rec.path.length > 0) {
        const mid = rec.path[Math.floor(rec.path.length / 2)]
        lat = Number(mid[0])
        lng = Number(mid[1])
      } else {
        lat = rec?.displayLat ?? rec?.latitude
        lng = rec?.displayLng ?? rec?.longitude
      }
      const props = rec?.properties || rec
      if (!props || typeof props !== 'object') continue
      const keys = new Set<string>(Object.keys(props).filter(k => !EXCLUDE.has(k)))
      const nested = props.properties || props.attributes
      if (nested && typeof nested === 'object') {
        for (const k of Object.keys(nested)) if (!EXCLUDE.has(k)) keys.add(k)
      }
      for (const k of keys) {
        const v = getFieldValue(props, k)
        if (!hasValue(v)) continue
        if (!map[k]) { map[k] = []; seen[k] = new Set(); acc[k] = {} }
        const s = String(v)
        const a = acc[k][s] || (acc[k][s] = { latSum: 0, lngSum: 0, count: 0, seen: 0 })
        // 出现次数先于上限判断累加：即使样本条数触顶，已记录取值的占比仍然准确
        a.seen++
        if (typeof lat === 'number' && typeof lng === 'number') {
          a.latSum += lat
          a.lngSum += lng
          a.count++
        }
        if (map[k].length >= maxValuesPerField) continue
        if (seen[k].has(s)) continue
        seen[k].add(s)
        map[k].push({
          v,
          lat: a.count > 0 ? a.latSum / a.count : 0,
          lng: a.count > 0 ? a.lngSum / a.count : 0
        })
      }
    }
    // 回填每个取值的出现次数（push 时最终计数未知）
    for (const k of Object.keys(map)) {
      for (const sample of map[k]) {
        const a = acc[k][String(sample.v)]
        if (a) sample.count = a.seen
      }
    }
    return map
  }, [])

  /**
   * 提取专题图层字段值样本（cache-first：优先前端已有数据，冷缓存才请求后端）
   */
  const extractThematicSamples = useCallback(async (node: TreeNode) => {
    // 扇区图层：直接使用传入的扇区数据（LTE/NR 各一份）
    if (node.type === 'sector-layer') {
      const sl = node.sectorLayer
      if (!sl) return
      const records = sectorData ? (sl.type === 'LTE' ? sectorData.lte : sectorData.nr) : []
      const cacheKey = `samples-sector-${sl.id}`
      const cache = thematicSamplesCacheRef.current
      if (cache[cacheKey]) {
        setThematicFieldSamples(cache[cacheKey])
        return
      }
      setLoadingThematicSamples(true)
      try {
        const samples = collectFieldSamples(records || [])
        cache[cacheKey] = samples
        setThematicFieldSamples(samples)
      } catch (error) {
        console.error('[LayerControl] 提取扇区专题字段样本失败:', error)
        setThematicFieldSamples({})
      } finally {
        setLoadingThematicSamples(false)
      }
      return
    }

    const lf = node.layerFile
    if (!lf) return
    // 采样逻辑变更时递增，使旧版本的不完整样本缓存失效
    const cacheKey = `samples-v2-${lf.dataId}-${lf.id}`
    const cache = thematicSamplesCacheRef.current
    if (cache[cacheKey]) {
      setThematicFieldSamples(cache[cacheKey])
      return
    }
    setLoadingThematicSamples(true)
    try {
      let records: any[] | null = null
      if (lf.sourceType === 'excel') {
        // 1. pointFileData（MapPage 已传入的原始数据）
        const fd = pointFileData[lf.id]
        if (fd && Array.isArray(fd) && fd.length > 0) {
          records = fd
        } else {
          // 2. dataApi.get 回退
          const res = await dataApi.get(lf.dataId)
          if (res.success && res.data) {
            if (Array.isArray(res.data)) records = res.data
            else if (res.data.data && Array.isArray(res.data.data)) records = res.data.data
            else if (res.data.lte) records = res.data.lte
            else if (res.data.nr) records = res.data.nr
          }
        }
      } else {
        // MapInfo：优先 useMapDataCacheStore（prefetchLayerData 已写入）
        const cached = useMapDataCacheStore.getState().layers[lf.id]?.geojson
        if (cached?.features?.length) {
          records = cached.features
        } else {
          const res = await layerApi.getLayerData(lf.dataId, lf.id)
          if (res.success && res.data?.features) records = res.data.features
        }
      }
      const samples = collectFieldSamples(records || [])
      cache[cacheKey] = samples
      setThematicFieldSamples(samples)
    } catch (error) {
      console.error('[LayerControl] 提取专题字段样本失败:', error)
      setThematicFieldSamples({})
    } finally {
      setLoadingThematicSamples(false)
    }
  }, [pointFileData, sectorData, collectFieldSamples])

  /**
   * 预取图层文件字段选项（不阻塞UI）
   * 当图层文件列表更新时，提前缓存字段信息
   */
  useEffect(() => {
    const cache = getCache()

    // 只预取前3个图层文件，避免过多并发请求
    const layersToPrefetch = layerFiles.slice(0, 3)

    layersToPrefetch.forEach((layerFile) => {
      const cacheKey = `${layerFile.dataId}-${layerFile.id}`

      // 如果已经缓存过，跳过
      if (cacheKey in cache) {
        return
      }

      // 异步预取，不阻塞UI
      layerApi.getLayerColumns(layerFile.dataId, layerFile.id)
        .then(response => {
          if (response.success && response.data) {
            const fields = response.data.fields || []
            const options: FieldOption[] = fields.map((field: string) => ({
              value: field,
              label: field
            }))

            // 存入缓存
            cache[cacheKey] = options
            console.log('[LayerControl] 预取字段成功:', layerFile.name, options.length, '个字段')
          }
        })
        .catch(error => {
          console.warn('[LayerControl] 预取字段失败:', layerFile.name, error)
        })
    })
  }, [layerFiles, getCache])

  // 构建树形结构
  const buildTree = (): TreeNode[] => {
    const isExpanded = (id: string, defaultExpanded: boolean) => {
      return expandedNodeIds.has(id) || (defaultExpanded && !expandedNodeIds.has(`collapse-${id}`))
    }

    return [
      {
        id: 'root',
        type: 'root',
        label: '',
        expanded: isExpanded('root', true),
        children: [
          // 基站分组
          {
            id: 'sector-group',
            type: 'sector-group',
            label: t('map.baseStation'),
            expanded: isExpanded('sector-group', true),
            children: orderWithIds(layerOrder?.sector, sectors.map(s => s.id))
              .map(id => sectors.find(s => s.id === id)!)
              .map(sector => {
              // 获取该网络类型的频点列表
              const freqList = sector.type === 'LTE' ? frequencies.lte : frequencies.nr
              const networkType = sector.type === 'LTE' ? 'LTE' : 'NR' as NetworkType

              return {
                id: sector.id,
                type: 'sector-layer' as TreeNodeType,
                label: sector.type === 'LTE' ? 'LTE' : 'NR',
                sectorLayer: sector,
                expanded: isExpanded(sector.id, false),
                sectorLabel: {
                  layerId: sector.id,
                  visible: sectorLabelVisibility[sector.id] || false
                },
                // 添加频点子节点，每个频点包含显示控制
                children: freqList.map(freq => ({
                  id: `${sector.id}-freq-${freq.frequency}`,
                  type: 'frequency' as TreeNodeType,
                  label: `${freq.frequency}${freq.count ? ` (${freq.count})` : ''}`,
                  frequency: freq
                }))
              }
            })
          },
          // 图层文件分组 (MapInfo)
          ...(layerFiles.length > 0 ? [
            {
              id: 'layer-files',
              type: 'layer-files' as TreeNodeType,
              label: t('map.layerFiles'),
              expanded: isExpanded('layer-files', true),
              children: orderWithIds(layerOrder?.mapinfo, layerFiles.map(f => f.id))
                .map(id => layerFiles.find(f => f.id === id)!)
                .map(file => ({
                id: file.id,
                type: 'layer-file' as TreeNodeType,
                label: file.name,
                layerFile: file,
                // 为每个图层文件添加独立的标签控件
                layerFileLabel: {
                  fileId: file.id,
                  visible: layerFileLabelVisibility[file.id] || false
                }
              }))
            }
          ] : []),
          // 地理化数据分组 (Excel)
          {
            id: 'custom-group',
            type: 'custom-group' as TreeNodeType,
            label: t('map.geoData'),
            expanded: isExpanded('custom-group', true),
            children: [
              // pointFiles 按面板拖拽顺序排列，为每个文件添加标签子项
              ...orderWithIds(layerOrder?.geodata, pointFiles.map(f => f.id))
                .map(id => pointFiles.find(f => f.id === id)!)
                .map(file => {
                console.log('[LayerControl] 处理点文件:', {
                  id: file.id,
                  name: file.name,
                  type: file.type,
                  sourceType: file.sourceType,
                  geometryType: file.geometryType,
                  visible: file.visible
                })

                // 所有点文件（包括地理化数据和 MapInfo 图层）都不展开
                // 标签开关直接显示在文件复选框右边
                return {
                  id: file.id,
                  type: 'layer-file' as TreeNodeType,
                  label: file.name,
                  layerFile: file
                  // 不添加 children，标签开关直接在主节点渲染
                }
              }),
              // 兼容旧的 customLayers (如果有)
              ...customLayers.map(layer => ({
                id: layer.id,
                type: 'custom-layer' as TreeNodeType,
                label: layer.name,
                customLayer: layer
              }))
            ]
          },
          // 装饰图层（打点、定位标记等）- 无子节点，复选框直接在标题旁
          ...(decorationLayer ? [
            {
              id: 'decoration-layer',
              type: 'decoration-layer' as TreeNodeType,
              label: decorationLayer.name,
              decorationLayer: decorationLayer
            }
          ] : [])
        ]
      }
    ]
  }

  const [tree, setTree] = useState<TreeNode[]>(buildTree())

  // 当外部数据变化时更新树（layerOrder 变化也需重建以应用拖拽排序）
  useEffect(() => {
    setTree(buildTree())
  }, [sectors, layerFiles, pointFiles, mapType, sectorLabelVisibility, layerFileLabelVisibility, pointFileLabelVisibility, frequencies, customLayers, decorationLayer, layerOrder])

  // ===== 类内拖拽排序 =====
  const [draggingLayer, setDraggingLayer] = useState<{ category: LayerCategory; layerId: string } | null>(null)
  const [dragOverLayer, setDragOverLayer] = useState<{ category: LayerCategory; layerId: string; position: 'before' | 'after' } | null>(null)

  /** 某类别当前实际存在的图层 id（自然顺序） */
  const getCategoryIds = useCallback((category: LayerCategory): string[] => {
    if (category === 'sector') return sectors.map(s => s.id)
    if (category === 'mapinfo') return layerFiles.map(f => f.id)
    if (category === 'geodata') return pointFiles.map(f => f.id)
    return ['decoration-layer']
  }, [sectors, layerFiles, pointFiles])

  const handleRowDragStart = useCallback((e: React.DragEvent, category: LayerCategory, layerId: string) => {
    // 从行内交互控件（可选按钮/复选框/标签开关）按下时不发起拖拽：
    // 否则点击开关时手部微移会触发行拖拽并吞掉 click，造成误排序
    const target = e.target as HTMLElement
    if (target.closest('button, input, label, [data-no-drag]')) {
      e.preventDefault()
      return
    }
    setDraggingLayer({ category, layerId })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', `${category}:${layerId}`)
  }, [])

  const handleRowDragOver = useCallback((e: React.DragEvent, category: LayerCategory, layerId: string) => {
    if (!draggingLayer || draggingLayer.layerId === layerId) return
    // 跨类别悬停：不放置，并清除其他类别行上残留的落点指示线
    if (draggingLayer.category !== category) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'none'
      setDragOverLayer(prev => (prev && prev.category !== category ? null : prev))
      return
    }
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const position: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDragOverLayer(prev =>
      prev && prev.category === category && prev.layerId === layerId && prev.position === position
        ? prev
        : { category, layerId, position }
    )
  }, [draggingLayer])

  const handleRowDrop = useCallback((e: React.DragEvent, category: LayerCategory, layerId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const dragged = draggingLayer
    const over = dragOverLayer
    setDraggingLayer(null)
    setDragOverLayer(null)
    if (!dragged || dragged.category !== category || dragged.layerId === layerId) return
    const ids = orderWithIds(layerOrder?.[category], getCategoryIds(category))
    const from = ids.indexOf(dragged.layerId)
    if (from < 0) return
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    let insertAt = next.indexOf(layerId)
    if (insertAt < 0) return
    if (over?.category === category && over.layerId === layerId && over.position === 'after') insertAt += 1
    next.splice(insertAt, 0, moved)
    onReorderLayers?.(category, next)
  }, [draggingLayer, dragOverLayer, layerOrder, getCategoryIds, onReorderLayers])

  const handleRowDragEnd = useCallback(() => {
    setDraggingLayer(null)
    setDragOverLayer(null)
  }, [])

  // 传给 TreeNodeComponent 的"可选"开关与拖拽状态（方法引用稳定，避免整树重渲染）
  const selectableProps = useMemo(() => ({
    map: selectableMap ?? {},
    onToggle: onSelectableToggle,
    hint: t('map.selectableHint') || '可选：开启后该图层可被圈选/点选；仅最上层生效'
  }), [selectableMap, onSelectableToggle, t])

  const editableProps = useMemo(() => ({
    editableLayerId: editableLayerId ?? null,
    onToggle: onEditableToggle,
    hint: t('map.editableHint') || '可编辑：开启后可在该图层绘制/编辑点线面（同时只能编辑一个图层）'
  }), [editableLayerId, onEditableToggle, t])

  const dndProps = useMemo(() => ({
    draggedId: draggingLayer?.layerId ?? null,
    dragOver: dragOverLayer,
    onDragStart: handleRowDragStart,
    onDragOver: handleRowDragOver,
    onDrop: handleRowDrop,
    onDragEnd: handleRowDragEnd
  }), [draggingLayer, dragOverLayer, handleRowDragStart, handleRowDragOver, handleRowDrop, handleRowDragEnd])

  /**
   * 切换节点展开状态
   */
  const toggleNode = (nodeId: string) => {
    setExpandedNodeIds(prev => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
        // 记录用户显式折叠了原本默认展开的项
        next.add(`collapse-${nodeId}`)
      } else {
        next.add(nodeId)
        next.delete(`collapse-${nodeId}`)
      }
      return next
    })
  }

  // 当展开状态集合变化时，也触发树的重绘
  useEffect(() => {
    setTree(buildTree())
  }, [expandedNodeIds])

  /**
   * 处理扇区图层切换
   */
  const handleSectorToggle = (layerId: string, visible: boolean) => {
    onSectorToggle?.(layerId, visible)
  }

  /**
   * 处理图层文件切换
   */
  const handleLayerFileToggle = (fileId: string, visible: boolean) => {
    onLayerFileToggle?.(fileId, visible)
  }

  /**
   * 处理地图类型切换
   */// 地图类型变化事件
  const handleMapTypeChange = (type: 'roadmap' | 'satellite') => {
    console.log('[LayerControl] Map type change:', type)
    onMapTypeChange?.(type)
  }

  // 添加显示/隐藏状态管理
  const [isVisible, setIsVisible] = useState(true) // 默认展开
  const [isPinned, setIsPinned] = useState(true) // 默认固定侧边栏
  const [isPinHovered, setIsPinHovered] = useState(false) // 控件是否被悬停

  // 面板引用
  const panelRef = useRef<HTMLDivElement>(null)

  // 点击控件 - 切换固定/隐藏状态
  const handleTogglePin = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (isPinned) {
      // 取消固定，隐藏面板
      setIsPinned(false)
      setIsVisible(false)
    } else {
      // 固定面板
      setIsPinned(true)
      setIsVisible(true)
    }
  }, [isPinned])

  // 面板宽度状态
  const [panelWidth, setPanelWidth] = useState(240)
  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  // 按钮现在在面板容器内部，使用 left: -40px 相对于面板定位

  // 开始调整大小
  const startResize = (e: React.MouseEvent) => {
    isResizing.current = true
    startX.current = e.clientX
    startWidth.current = panelWidth

    document.addEventListener('mousemove', doResize)
    document.addEventListener('mouseup', stopResize)
    document.body.style.userSelect = 'none' // 防止拖动时选中文本
  }

  // 执行调整大小
  const doResize = (e: MouseEvent) => {
    if (!isResizing.current) return
    // 面板在左侧，向右拖动（X增大）增加宽度
    const delta = e.clientX - startX.current
    const newWidth = Math.max(200, Math.min(500, startWidth.current + delta))
    setPanelWidth(newWidth)
  }

  // 停止调整大小
  const stopResize = () => {
    isResizing.current = false
    document.removeEventListener('mousemove', doResize)
    document.removeEventListener('mouseup', stopResize)
    document.body.style.userSelect = ''
  }

  // 全局右键菜单状态（type: 'layer-file' 自定义菜单 / 'custom-layer' 卸载菜单）
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, nodeId: string, type: string } | null>(null)

  // 处理右键点击
  /**
   * 判断图层文件是否已勾选可见（图层预览菜单可用性）
   */
  const isFileVisible = (fileId: string): boolean => {
    return [...layerFiles, ...pointFiles].some(f => f.id === fileId && f.visible)
  }

  /**
   * 判断扇区图层是否已勾选可见（图层预览菜单可用性）
   */
  const isSectorVisible = (layerId: string): boolean => {
    return sectors.some(s => s.id === layerId && s.visible)
  }

  /**
   * 打开图层设置弹窗（右键 / 图例双击跳转共用）
   * @param node 目标图层节点
   * @param tab 初始标签页
   * @param subTab 颜色设置页初始子页（'thematic' 表示专题图层页）
   */
  const openSettingsDialog = (node: TreeNode, tab: 'label' | 'color', subTab?: 'basic' | 'thematic' | 'heatmap') => {
    // 支持 sector-layer 和 layer-file 的标签设置
    if (node.type === 'sector-layer' || node.type === 'layer-file') {
      // 先立即显示对话框
      setShowLabelSettingsModal(true)
      setCurrentSettingsNode(node)
      setActiveTab(tab)
      setModalInitialSubTab(subTab)

      // 获取图层ID用于加载已保存的设置
      let layerId = ''
      if (node.type === 'sector-layer' && node.sectorLayer) {
        layerId = node.sectorLayer.id
      } else if (node.type === 'layer-file' && node.layerFile) {
        layerId = node.layerFile.id
      }

      // 从持久化 store 获取已保存的设置
      const savedSettings = persistedLabelSettings[layerId]

      // 设置当前配置（先显示默认或已保存的配置）
      setCurrentLabelSettings(savedSettings || {
        content: 'name',
        color: '#000000',
        fontSize: 12,
        fontFamily: 'sans-serif',
        bold: false,
        italic: false,
        shadow: false,
        background: 'none',
        backgroundColor: '#ffffff'
      })

      // 载入已保存的颜色设置（无保存设置时，用图层文件自带的默认样式初始化，
      // 还原 tab/mif/kml 的默认属性配置：填充色/线宽/透明度）
      const savedColor = persistedColorSettings[layerId]
      const ds = node.type === 'layer-file' ? node.layerFile?.defaultStyle : undefined
      const geomType = node.type === 'layer-file' ? node.layerFile?.type : undefined
      setCurrentColorSettings(savedColor || (node.type === 'sector-layer'
        // 基站（扇区）图层默认设置：图形透明度 100%、边框宽度 1px（与 SECTOR_CONFIG 默认渲染一致）
        ? { fillColor: '#3b82f6', fillOpacity: 1, borderWidth: 1, borderColor: '#000000' }
        : {
          fillColor: ds?.fillColor || ds?.markerColor || '#3b82f6',
          fillOpacity: ds?.fillOpacity ?? 0.6,
          borderWidth: ds?.strokeWidth ?? 2,
          // 点/面图层边框颜色默认无色（不描边）；线图层无边框色项，strokeColor 作为
          // 线色种子（弹窗内映射到"图形颜色"，兼容旧版本线色语义）
          borderColor: geomType === 'point' || geomType === 'polygon'
            ? NO_FILL_COLOR
            : (ds?.strokeColor || '#000000')
        }))

      // 专题图层设置初始化（图层文件类与扇区类）+ 字段值样本提取（cache-first）
      // 注意：扇区类也必须从持久化初始化（或置空），否则会残留上次打开图层文件时
      // 的专题激活状态，导致"基站"图层颜色设置被错误禁用
      if (node.type === 'layer-file' || node.type === 'sector-layer') {
        setCurrentThematicSettings(persistedThematicSettings[layerId] ?? null)
        setCurrentHeatmapSettings(persistedHeatmapSettings[layerId] ?? null)
        setCurrentHeatmapStats(heatmapStats?.[layerId] ?? null)
        extractThematicSamples(node)
      }

      // 异步加载字段选项（不阻塞对话框显示）
      if (node.type === 'sector-layer' && node.sectorLayer) {
        setFieldOptions(PREDEFINED_LABEL_FIELDS)
        fetchSectorFieldOptions(node.sectorLayer.type)
      } else if (node.type === 'layer-file' && node.layerFile) {
        // 图层文件：检查是否为 Excel 点文件（地理化数据）
        if (node.layerFile.sourceType === 'excel') {
          // ✅ Excel 点文件：使用 getColumns API 获取完整的字段列表
          // 注意：pointFileData 依赖 ref 快照可能已过时，因此不依赖它
          console.log('[LayerControl] 检测到 Excel 点文件，通过 API 获取字段:', node.layerFile.id)

          // 先设置为空，显示加载状态
          setFieldOptions([])
          setLoadingFields(true)

          // 同步尝试从 pointFileData 获取字段作为快速显示（如果有数据）
          const fileData = pointFileData[node.layerFile.id]
          if (fileData && Array.isArray(fileData) && fileData.length > 0) {
            const columns = new Set<string>()
            for (const item of fileData) {
              const props = item.properties || item
              for (const key of Object.keys(props)) {
                if (key === 'attributes' || key === 'properties' ||
                    key === 'longitude' || key === 'latitude' ||
                    key === 'displayLng' || key === 'displayLat' ||
                    key === 'type' || key === 'geometry') {
                  continue
                }
                columns.add(key)
              }
              // 检查嵌套 properties
              const nested = props.properties || props.attributes
              if (nested && typeof nested === 'object') {
                for (const key of Object.keys(nested)) {
                  columns.add(key)
                }
              }
            }
            if (columns.size > 0) {
              const syncOptions: FieldOption[] = Array.from(columns).sort().map(col => ({
                value: col, label: col
              }))
              console.log('[LayerControl] 从 pointFileData 同步提取字段:', syncOptions.length)
              setFieldOptions(syncOptions)
              setLoadingFields(false)
            }
          }

          // 通过 API 获取完整数据并提取字段
          // 注意：getColumns API 不覆盖 geo data (default.json)，因此直接加载数据来提取列名
          if (node.layerFile.dataId) {
            console.log('[LayerControl] 通过 dataApi.get 获取字段:', node.layerFile.dataId)
            dataApi.get(node.layerFile.dataId).then(response => {
              if (response.success && response.data) {
                // 处理多种数据格式
                let rawArray: any[] | null = null
                if (Array.isArray(response.data)) {
                  rawArray = response.data
                } else if (response.data.data && Array.isArray(response.data.data)) {
                  rawArray = response.data.data
                } else if (response.data.lte) {
                  rawArray = response.data.lte
                } else if (response.data.nr) {
                  rawArray = response.data.nr
                }

                if (rawArray && rawArray.length > 0) {
                  const firstItem = rawArray[0]
                  const props = firstItem.properties || firstItem
                  const allKeys = new Set<string>()
                  for (const key of Object.keys(props)) {
                    if (key === 'attributes' || key === 'properties' ||
                        key === 'longitude' || key === 'latitude' ||
                        key === 'displayLng' || key === 'displayLat' ||
                        key === 'type' || key === 'geometry') {
                      continue
                    }
                    allKeys.add(key)
                  }
                  // 检查嵌套 properties
                  const nested = props.properties || props.attributes
                  if (nested && typeof nested === 'object') {
                    for (const key of Object.keys(nested)) {
                      allKeys.add(key)
                    }
                  }
                  if (allKeys.size > 0) {
                    const apiOptions: FieldOption[] = Array.from(allKeys).sort().map(col => ({
                      value: col, label: col
                    }))
                    console.log('[LayerControl] dataApi.get 提取字段数量:', apiOptions.length, '字段:', apiOptions.map(o => o.value))
                    setFieldOptions(apiOptions)
                  }
                }
              }
            }).catch(error => {
              console.error('[LayerControl] dataApi.get API 失败:', error)
            }).finally(() => {
              setLoadingFields(false)
            })
          } else {
            setLoadingFields(false)
          }
        } else {
          // MapInfo 图层文件：先显示预定义字段，然后异步获取实际字段
          setFieldOptions(PREDEFINED_LABEL_FIELDS)
          fetchLayerFileFieldOptions(node.layerFile.dataId, node.layerFile.id)
        }
      }
    }
  }

  const handleContextMenu = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault()
    e.stopPropagation()

    // 图层文件/地理化数据/扇区图层：右键弹出冒泡菜单（自定义设置 / 图层预览）
    if (node.type === 'layer-file' || node.type === 'sector-layer') {
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        nodeId: node.id,
        type: node.type
      })
    } else if (node.type === 'decoration-layer') {
      setShowLabelSettingsModal(true)
      setCurrentSettingsNode(node)
      setActiveTab('color')
      setModalInitialSubTab(undefined)
      const savedColor = persistedColorSettings['decoration-layer']
      setCurrentColorSettings(savedColor || {
        fillColor: '#ef4444',
        fillOpacity: 1,
        borderWidth: 2,
        borderColor: '#ffffff'
      })
    } else if (node.type === 'custom-layer') {
      // 自定义图层支持卸载
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        nodeId: node.id,
        type: node.type
      })
    }
  }

  // 关闭右键菜单
  useEffect(() => {
    const handleGlobalClick = () => setContextMenu(null)
    if (contextMenu) {
      window.addEventListener('click', handleGlobalClick)
    }
    return () => window.removeEventListener('click', handleGlobalClick)
  }, [contextMenu])

  // 图例双击跳转：打开对应图层的专题图层设置页
  useEffect(() => {
    if (!openThematicFor) return
    const layerId = openThematicFor.layerId
    // 扇区图层（基站 LTE/NR）
    const sector = sectors.find(s => s.id === layerId)
    if (sector) {
      const node: TreeNode = {
        id: sector.id,
        type: 'sector-layer',
        label: sector.type === 'LTE' ? 'LTE' : 'NR',
        sectorLayer: sector,
        sectorLabel: { layerId: sector.id, visible: sectorLabelVisibility[sector.id] || false }
      }
      openSettingsDialog(node, 'color', openThematicFor.subTab ?? 'thematic')
      return
    }
    // 图层文件 / 地理化数据
    const file = [...layerFiles, ...pointFiles].find(f => f.id === layerId)
    if (!file) return
    const node: TreeNode = { id: file.id, type: 'layer-file', label: file.name, layerFile: file }
    openSettingsDialog(node, 'color', openThematicFor.subTab ?? 'thematic')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openThematicFor])

  /**
   * 保存标签设置
   */
  const handleSaveLabelSettings = (settings: LabelSettings) => {
    const node = currentSettingsNode
    if (!node) return

    // 获取图层ID
    let layerId = ''
    if (node.type === 'sector-layer' && node.sectorLayer) {
      layerId = node.sectorLayer.id
    } else if (node.type === 'layer-file' && node.layerFile) {
      layerId = node.layerFile.id
    }

    if (layerId) {
      // 保存到持久化 store
      storeUpdateLabelSettings(layerId, settings)
    }

    // 通知父组件更新标签配置
    // MapPage中的onLabelSettingsChange会自动处理：更新配置状态 + 设置可见性为true + 立即应用到地图
    onLabelSettingsChange?.(node, settings)

    // 更新本地状态
    setCurrentLabelSettings(settings)
    setShowLabelSettingsModal(false)
  }

  /**
   * 保存图层颜色设置
   */
  const handleSaveColorSettings = (settings: LayerColorSettings) => {
    const node = currentSettingsNode
    if (!node) return

    // 获取图层ID（装饰图层为固定 id）
    let layerId = ''
    if (node.type === 'sector-layer' && node.sectorLayer) {
      layerId = node.sectorLayer.id
    } else if (node.type === 'layer-file' && node.layerFile) {
      layerId = node.layerFile.id
    } else if (node.type === 'decoration-layer') {
      layerId = 'decoration-layer'
    }

    if (layerId) {
      // 保存到持久化 store
      storeUpdateColorSettings(layerId, settings)
    }

    // 通知父组件应用到地图
    onColorSettingsChange?.(node, settings)

    // 更新本地状态
    setCurrentColorSettings(settings)
    setShowLabelSettingsModal(false)
  }

  /**
   * 保存专题图层设置
   */
  const handleSaveThematicSettings = (settings: ThematicSettings | null) => {
    const node = currentSettingsNode
    if (!node) return

    // 获取图层ID
    let layerId = ''
    if (node.type === 'layer-file' && node.layerFile) {
      layerId = node.layerFile.id
    } else if (node.type === 'sector-layer' && node.sectorLayer) {
      layerId = node.sectorLayer.id
    }

    if (layerId) {
      // 保存到持久化 store（null 表示关闭专题，删除条目）
      storeUpdateThematicSettings(layerId, settings)
    }

    // 通知父组件应用到地图
    onThematicSettingsChange?.(node, settings)

    // 更新本地状态
    setCurrentThematicSettings(settings)
    setShowLabelSettingsModal(false)
  }

  /**
   * 保存热力图设置
   */
  const handleSaveHeatmapSettings = (settings: HeatmapSettings | null) => {
    const node = currentSettingsNode
    if (!node) return

    // 获取图层ID（与专题设置同一套节点判定）
    let layerId = ''
    if (node.type === 'layer-file' && node.layerFile) {
      layerId = node.layerFile.id
    } else if (node.type === 'sector-layer' && node.sectorLayer) {
      layerId = node.sectorLayer.id
    }

    if (layerId) {
      // 保存到持久化 store（null 表示关闭，删除条目）
      storeUpdateHeatmapSettings(layerId, settings)
    }

    // 通知父组件应用到地图
    onHeatmapSettingsChange?.(node, settings)

    // 更新本地状态
    setCurrentHeatmapSettings(settings)
  }

  return (
    <>
      <style>{`
        /* 自定义面板滚动条 - 美化样式 */
        .layer-control::-webkit-scrollbar {
          width: 6px;
        }
        .layer-control::-webkit-scrollbar-track {
          background: hsl(var(--muted) / 0.5);
          border-radius: 3px;
        }
        .layer-control::-webkit-scrollbar-thumb {
          background: hsl(var(--muted-foreground) / 0.35);
          border-radius: 3px;
          transition: background 0.2s ease;
        }
        .layer-control::-webkit-scrollbar-thumb:hover {
          background: hsl(var(--muted-foreground) / 0.5);
        }
        /* Firefox 滚动条样式 */
        .layer-control {
          scrollbar-width: thin;
          scrollbar-color: hsl(var(--muted-foreground) / 0.35) hsl(var(--muted) / 0.5);
        }
        /* 隐藏地图容器滚动条 */
        .map-container::-webkit-scrollbar {
          display: none;
        }
        .map-container {
          -ms-overflow-style: none;
          scrollbar-width: none;
          overflow: hidden !important;
        }
        /* 自定义复选框样式 */
        .custom-checkbox {
          position: relative;
          display: inline-block;
          width: 14px;
          height: 14px;
        }
        .custom-checkbox input {
          opacity: 0;
          width: 0;
          height: 0;
        }
        .custom-checkbox .checkmark {
          position: absolute;
          top: 0;
          left: 0;
          width: 14px;
          height: 14px;
          background-color: hsl(var(--muted));
          border: 2px solid hsl(var(--border));
          border-radius: 4px;
          transition: all 0.2s ease;
        }
        .custom-checkbox:hover input ~ .checkmark {
          background-color: hsl(var(--accent));
          border-color: hsl(var(--muted-foreground));
        }
        .custom-checkbox input:checked ~ .checkmark {
          background-color: hsl(var(--primary));
          border-color: hsl(var(--primary));
        }
        .custom-checkbox .checkmark:after {
          content: "";
          position: absolute;
          display: none;
          left: 4px;
          top: 1px;
          width: 4px;
          height: 8px;
          border: solid hsl(var(--primary-foreground));
          border-width: 0 2px 2px 0;
          transform: rotate(45deg);
        }
        .custom-checkbox input:checked ~ .checkmark:after {
          display: block;
        }
      `}</style>

      {/* 悬停检测区域 - 面板隐藏时显示在左侧边缘 */}
      <div
        onMouseEnter={() => {
          if (!isPinned && !isVisible) {
            setIsVisible(true)
          }
        }}
        onMouseLeave={() => {
          if (!isPinned && isVisible) {
            setIsVisible(false)
          }
        }}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '24px',
          height: '100%',
          zIndex: 997,
          pointerEvents: isPinned || isVisible ? 'none' : 'auto',
          backgroundColor: 'transparent',
        }}
      />

      {/* 图层控制面板容器 - 相对于父容器定位，高度匹配地图窗口 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          height: '100%',
          width: `${panelWidth}px`,
          zIndex: 998,
          pointerEvents: 'none',
        }}
      >
        {/* 图层控制面板 - 从左侧滑入/滑出 */}
        <div
          ref={panelRef}
          className="layer-control"
          style={{
            position: 'absolute',
            top: '0px',
            left: '0px',
            zIndex: 1000,
            pointerEvents: isVisible ? 'auto' : 'none',
            backgroundColor: 'hsl(var(--popover) / 0.98)',
            backdropFilter: 'blur(12px)',
            borderRadius: '0',
            boxShadow: 'none',
            width: `${panelWidth}px`,
            minWidth: '240px',
            height: '100%',
            maxHeight: '100%',
            overflow: 'hidden',
            fontSize: '12px',
            border: 'none',
            boxSizing: 'border-box',
            transition: 'transform 0.35s cubic-bezier(0.25, 0.1, 0.25, 1), opacity 0.35s ease',
            transform: isVisible ? 'translateX(0)' : `translateX(-${panelWidth + 10}px)`,
            opacity: isVisible ? 1 : 0,
          }}
          onMouseEnter={() => {
            // 鼠标进入面板时，如果未固定则保持显示
            if (!isPinned) {
              setIsVisible(true)
            }
          }}
          onMouseLeave={() => {
            // 鼠标离开面板时，如果未固定则隐藏
            if (!isPinned) {
              setIsVisible(false)
            }
          }}
        >
        {/* 拖动调整手柄 */}
        <div
          onMouseDown={startResize}
          style={{
            position: 'absolute',
            right: 0,
            top: 0,
            bottom: 0,
            width: '8px',
            cursor: 'ew-resize',
            zIndex: 10,
            backgroundColor: 'hsl(var(--muted) / 0.5)',
            transition: 'background-color 0.2s ease',
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'hsl(var(--primary) / 0.2)'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'hsl(var(--muted) / 0.5)'}
          title="拖动调整宽度"
        />

        {/* 固定/解开控件 - 位于面板内部右上角 */}
        <button
          onClick={handleTogglePin}
          style={{
            position: 'absolute',
            top: '10px',
            right: '10px',
            zIndex: 1003,
            pointerEvents: 'auto',
            backgroundColor: 'transparent',
            cursor: 'pointer',
            padding: '4px 8px',
            borderRadius: '4px',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: isPinned ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
            fontSize: '16px',
            fontWeight: 500,
            transition: 'color 0.2s ease',
          }}
          title={isPinned ? '解开固定' : '固定侧边栏'}
        >
          ⇌
        </button>

        {/* 内容容器 - 处理滚动 */}
        <div style={{
          height: '100%',
          maxHeight: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
          paddingTop: '8px',
          paddingLeft: '8px',
          paddingRight: '8px',
          paddingBottom: '24px',
          boxSizing: 'border-box',
        }}>
          {/* 渲染树 */}
          {tree.map(rootNode => (
            <TreeNodeComponent
              key={rootNode.id}
              node={rootNode}
              level={0}
              onToggle={toggleNode}
              onSectorToggle={handleSectorToggle}
              onSectorLabelToggle={onSectorLabelToggle}
              onLayerFileToggle={handleLayerFileToggle}
              onMapTypeChange={handleMapTypeChange}
              onFrequencyToggle={onFrequencyToggle}
              onCustomLayerToggle={onCustomLayerToggle}
              onLayerFileRemove={onLayerFileRemove}
              onCustomLayerRemove={onCustomLayerRemove}
              onPointFileLabelToggle={onPointFileLabelToggle}
              onLayerFileLabelToggle={onLayerFileLabelToggle}
              onDecorationLayerToggle={onDecorationLayerToggle}
              onDecorationLabelToggle={onDecorationLabelToggle}
              decorationLabelVisible={decorationLabelVisible}
              onContextMenu={handleContextMenu}
              mapType={mapType}
              pointFileLabelVisibility={pointFileLabelVisibility}
              layerFileLabelVisibility={layerFileLabelVisibility}
              onFrequencyColorChange={onFrequencyColorChange}
              sectorThematicActive={sectorThematicActive}
              selectable={selectableProps}
              editable={editableProps}
              labelToggleHint={t('map.showLabelsHint') || '显示/隐藏要素文字标签'}
              dnd={dndProps}
            />
          ))}
        </div>
        </div>
      </div>

      {/* 右键菜单 - 放在面板外部以避免被裁剪或出现滚动条 */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 10000,
            backgroundColor: 'hsl(var(--popover))',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            border: '1px solid hsl(var(--border))',
            padding: '4px',
            minWidth: '140px'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {(contextMenu.type === 'layer-file' || contextMenu.type === 'sector-layer') && (
            <>
              {/* 自定义设置 */}
              <button
                onClick={() => {
                  if (contextMenu.type === 'sector-layer') {
                    const sector = sectors.find(s => s.id === contextMenu.nodeId)
                    if (sector) {
                      const treeNode: TreeNode = {
                        id: sector.id,
                        type: 'sector-layer',
                        label: sector.type === 'LTE' ? 'LTE' : 'NR',
                        sectorLayer: sector,
                        sectorLabel: { layerId: sector.id, visible: sectorLabelVisibility[sector.id] || false }
                      }
                      openSettingsDialog(treeNode, 'label')
                    }
                  } else {
                    const node = [...layerFiles, ...pointFiles].find(f => f.id === contextMenu.nodeId)
                    if (node) {
                      const treeNode: TreeNode = { id: node.id, type: 'layer-file', label: node.name, layerFile: node }
                      openSettingsDialog(treeNode, 'label')
                    }
                  }
                  setContextMenu(null)
                }}
                style={menuItemStyle}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'hsl(var(--accent))')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <Settings size={14} />
                <span>{t('map.customSettings')}</span>
              </button>
              {/* 图层预览：仅已勾选图层支持 */}
              <button
                onClick={() => {
                  onLayerPreview?.(contextMenu.nodeId)
                  setContextMenu(null)
                }}
                disabled={contextMenu.type === 'sector-layer' ? !isSectorVisible(contextMenu.nodeId) : !isFileVisible(contextMenu.nodeId)}
                style={{
                  ...menuItemStyle,
                  opacity: contextMenu.type === 'sector-layer' ? (isSectorVisible(contextMenu.nodeId) ? 1 : 0.45) : (isFileVisible(contextMenu.nodeId) ? 1 : 0.45),
                  cursor: contextMenu.type === 'sector-layer' ? (isSectorVisible(contextMenu.nodeId) ? 'pointer' : 'not-allowed') : (isFileVisible(contextMenu.nodeId) ? 'pointer' : 'not-allowed')
                }}
                onMouseEnter={(e) => {
                  const enabled = contextMenu.type === 'sector-layer' ? isSectorVisible(contextMenu.nodeId) : isFileVisible(contextMenu.nodeId)
                  if (enabled) e.currentTarget.style.backgroundColor = 'hsl(var(--accent))'
                }}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                title={contextMenu.type === 'sector-layer'
                  ? (isSectorVisible(contextMenu.nodeId) ? t('map.layerPreviewHint') : t('map.layerPreviewDisabledHint'))
                  : (isFileVisible(contextMenu.nodeId) ? t('map.layerPreviewHint') : t('map.layerPreviewDisabledHint'))}
              >
                <Maximize2 size={14} />
                <span>{t('map.layerPreview')}</span>
              </button>
            </>
          )}
          {contextMenu.type === 'custom-layer' && (
            <button
              onClick={() => {
                onCustomLayerRemove?.(contextMenu.nodeId)
                setContextMenu(null)
              }}
              style={{ ...menuItemStyle, color: 'hsl(var(--destructive))' }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'hsl(var(--destructive) / 0.12)')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              <X size={14} />
              <span>{t('map.unloadLayer')}</span>
            </button>
          )}
        </div>
      )}

      {/* 标签设置弹窗 */}
      <LabelSettingsModal
        isOpen={showLabelSettingsModal}
        onClose={() => setShowLabelSettingsModal(false)}
        onSave={handleSaveLabelSettings}
        title={currentSettingsNode?.type === 'sector-layer' ? t('map.customSettings') : t('map.layerFileLabelSettings')}
        currentSettings={currentLabelSettings}
        fieldOptions={fieldOptions}
        loadingFields={loadingFields}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        currentColorSettings={currentColorSettings}
        onSaveColor={handleSaveColorSettings}
        showThematicTab={currentSettingsNode?.type === 'layer-file' || currentSettingsNode?.type === 'sector-layer'}
        sectorColorMode={currentSettingsNode?.type === 'sector-layer'}
        currentThematicSettings={currentThematicSettings}
        onSaveThematic={handleSaveThematicSettings}
        currentHeatmapSettings={currentHeatmapSettings}
        onSaveHeatmap={handleSaveHeatmapSettings}
        mapHeatmapStats={currentHeatmapStats}
        polygonLayers={polygonLayers}
        thematicFieldSamples={thematicFieldSamples}
        loadingThematicSamples={loadingThematicSamples}
        initialColorSubTab={modalInitialSubTab ?? 'basic'}
        thematicGeometryType={currentSettingsNode?.type === 'sector-layer'
          ? 'sector'
          : currentSettingsNode?.layerFile?.type as 'point' | 'line' | 'polygon' | 'sector' | undefined}
        thematicTemplates={thematicTemplates}
        onSaveThematicTemplate={onSaveThematicTemplate}
        onRemoveThematicTemplate={onRemoveThematicTemplate}
        heatmapTemplates={heatmapTemplates}
        onSaveHeatmapTemplate={onSaveHeatmapTemplate}
        onRemoveHeatmapTemplate={onRemoveHeatmapTemplate}
      />
    </>
  )
}

/**
 * 树节点组件属性接口
 */
interface TreeNodeComponentProps {
  node: TreeNode;
  level: number;
  onToggle: (nodeId: string) => void;
  onSectorToggle: (layerId: string, visible: boolean) => void;
  onSectorLabelToggle?: (layerId: string, visible: boolean) => void;
  onLayerFileToggle: (fileId: string, visible: boolean) => void;
  onMapTypeChange: (type: 'roadmap' | 'satellite') => void;
  onFrequencyToggle?: (networkType: NetworkType, frequency: number, visible: boolean) => void;
  onFrequencyLabelToggle?: (networkType: NetworkType, frequency: number, visible: boolean) => void;
  onCustomLayerToggle?: (layerId: string, visible: boolean) => void;
  onLayerFileRemove?: (fileId: string) => void;
  onCustomLayerRemove?: (layerId: string) => void;
  onPointFileLabelToggle?: (fileId: string, visible: boolean) => void;
  onLayerFileLabelToggle?: (fileId: string, visible: boolean) => void;
  onDecorationLayerToggle?: (visible: boolean) => void;
  onDecorationLabelToggle?: (visible: boolean) => void;
  decorationLabelVisible?: boolean;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  mapType: 'roadmap' | 'satellite';
  pointFileLabelVisibility: Record<string, boolean>;
  layerFileLabelVisibility: Record<string, boolean>;
  /** 频点自定义配色回调（点击频点色块） */
  onFrequencyColorChange?: (networkType: NetworkType, frequency: number, colors: { color: string; strokeColor: string }) => void;
  /** 各扇区图层专题是否激活（激活时频点色块不可点击） */
  sectorThematicActive?: Record<string, boolean>;
  /** "可选"开关状态（鼠标箭头按钮） */
  selectable?: {
    map: Record<string, boolean>
    onToggle?: (layerId: string, selectable: boolean) => void
    hint: string
  }
  /** "可编辑"开关状态（铅笔按钮；全局互斥，同时只能编辑一个图层） */
  editable?: {
    editableLayerId: string | null
    onToggle?: (layerId: string, active: boolean) => void
    hint: string
  }
  /** "要素标签"开关提示文案 */
  labelToggleHint?: string

  /** 类内拖拽排序状态与事件 */
  dnd?: {
    draggedId: string | null
    dragOver: { category: string; layerId: string; position: 'before' | 'after' } | null
    onDragStart: (e: React.DragEvent, category: LayerCategory, layerId: string) => void
    onDragOver: (e: React.DragEvent, category: LayerCategory, layerId: string) => void
    onDrop: (e: React.DragEvent, category: LayerCategory, layerId: string) => void
    onDragEnd: () => void
  }
}

/**
 * 树节点组件
 */
function TreeNodeComponent({
  node,
  level,
  onToggle,
  onSectorToggle,
  onSectorLabelToggle,
  onLayerFileToggle,
  onMapTypeChange,
  onFrequencyToggle,
  onCustomLayerToggle,
  onLayerFileRemove,
  onCustomLayerRemove,
  onPointFileLabelToggle,
  onLayerFileLabelToggle,
  onDecorationLayerToggle,
  onDecorationLabelToggle,
  decorationLabelVisible,
  onContextMenu,
  mapType,
  pointFileLabelVisibility,
  layerFileLabelVisibility,
  onFrequencyColorChange,
  sectorThematicActive,
  selectable,
  editable,
  labelToggleHint = '',
  dnd
}: TreeNodeComponentProps) {
  // 长按拖动排序时的光标态（悬停保持默认光标，拖动中才变"移动中"光标）
  const [isRowDragging, setIsRowDragging] = useState(false)
  // 该节点所属图层类别（custom-layer 不参与圈选/排序，返回 null）
  const layerCategory: LayerCategory | null = (() => {
    if (node.type === 'sector-layer') return 'sector'
    if (node.type === 'decoration-layer') return 'decoration'
    if (node.type === 'layer-file') return node.layerFile?.sourceType === 'excel' ? 'geodata' : 'mapinfo'
    return null
  })()
  // 装饰图层仅单项不可拖拽；频点/分组/自定义图层行不可拖拽
  const canDrag = !!layerCategory && layerCategory !== 'decoration'

  const getIndent = () => {
    // 根据层级添加缩进：每级 12px（树形引导线已移除，缩进仅服务于展开箭头层级对齐）
    const basePadding = 4
    const indentPerLevel = 12
    const paddingLeft = basePadding + (level * indentPerLevel)
    return { paddingLeft: `${paddingLeft}px` }
  }

  const getNodeIcon = () => {
    // 根据需求，删除特定节点类型的图标，只保留文字
    switch (node.type) {
      case 'root':
        return null
      case 'map-type':
        if (node.mapType?.id === 'roadmap') return <Map size={14} color="currentColor" />
        if (node.mapType?.id === 'satellite') return <Satellite size={14} color="currentColor" />
        return null
      case 'sector-layer':
        return <Radio size={12} color="currentColor" />
      case 'sector-group':
        return <Map size={14} color="currentColor" />
      case 'layer-files':
        return <Folder size={14} color="currentColor" />
      case 'sector-label':
        return <span style={{ fontSize: '14px' }}>📝</span>
      case 'layer-file-label':
        return <span style={{ fontSize: '14px' }}>🏷️</span>
      case 'layer-file': {
        // 按图层类型显示点/线/面图标（复选框左侧的类型标识）
        const lfType = node.layerFile?.type || node.layerFile?.geometryType
        if (lfType === 'point') return <MapPin size={12} color="currentColor" />
        if (lfType === 'line') return <Route size={12} color="currentColor" />
        if (lfType === 'polygon') return <Hexagon size={12} color="currentColor" />
        if (lfType === 'sector') return <Radio size={12} color="currentColor" />
        return <File size={12} color="currentColor" />
      }
      case 'custom-group':
        return <Folder size={14} color="currentColor" />
      case 'custom-layer':
        return <File size={12} color="currentColor" />
      case 'decoration-layer':
        return <Folder size={14} color="currentColor" />
      default:
        return null
    }
  }

  const isExpandable = node.children && node.children.length > 0
  const isExpanded = node.expanded

  const handleClick = () => {
    if (isExpandable) {
      onToggle(node.id)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      {/* 节点行 */}
      <div
        draggable={canDrag}
        onDragStart={canDrag && dnd ? (e) => { setIsRowDragging(true); dnd.onDragStart(e, layerCategory!, node.id) } : undefined}
        onDragOver={canDrag && dnd ? (e) => dnd.onDragOver(e, layerCategory!, node.id) : undefined}
        onDrop={canDrag && dnd ? (e) => { setIsRowDragging(false); dnd.onDrop(e, layerCategory!, node.id) } : undefined}
        onDragEnd={dnd ? () => { setIsRowDragging(false); dnd.onDragEnd() } : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          padding: node.type === 'frequency' ? '2px 8px' : '3px 8px',
          // 悬停用默认光标（不用手形/grab）；仅在按住左键拖动排序时才显示"移动中"光标
          cursor: canDrag
            ? (isRowDragging ? 'grabbing' : 'default')
            : (node.type === 'root' ? 'default' : (isExpandable ? 'pointer' : 'default')),
          opacity: dnd?.draggedId === node.id ? 0.4 : 1,
          userSelect: 'none',
          borderBottom: '1px solid hsl(var(--border) / 0.6)',
          backgroundColor: node.type === 'root' ? 'transparent' : 'transparent',
          borderRadius: '8px',
          border: 'none',
          boxShadow: 'none',
          gap: node.type === 'frequency' ? '3px' : '4px',
          height: 'auto',
          minHeight: node.type === 'frequency' ? '16px' : '26px',
          lineHeight: '1.2',
          position: 'relative',
          transition: 'all 0.2s ease',
          ...getIndent()
        }}
        onClick={node.type === 'root' ? undefined : handleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
        onMouseEnter={(e) => {
          if (node.type !== 'root') {
            e.currentTarget.style.backgroundColor = 'hsl(var(--primary) / 0.1)'
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent'
        }}
      >
        {/* 拖拽落点指示线（类内上下排序） */}
        {canDrag && dnd?.dragOver?.layerId === node.id && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: '2px',
              backgroundColor: 'hsl(var(--primary))',
              borderRadius: '1px',
              pointerEvents: 'none',
              zIndex: 5,
              ...(dnd.dragOver.position === 'before' ? { top: '-1px' } : { bottom: '-1px' })
            }}
          />
        )}

        {/* 展开/折叠图标 - root 节点不显示 */}
        {node.type !== 'root' && (
          <>
            {isExpandable ? (
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '16px' }}>
                {isExpanded ? (
                  <ChevronDown size={12} color="currentColor" />
                ) : (
                  <ChevronRight size={12} color="currentColor" />
                )}
              </span>
            ) : (
              <span style={{ width: '16px' }} />
            )}
          </>
        )}

        {/* 节点图标 - 图层文件类型图标（设置入口已移至右键菜单） */}
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '16px'
          }}
        >
          {getNodeIcon()}
        </span>

        {/* 节点标签 */}
        <span
          title={node.label}
          style={{
            flex: 1,
            color: 'hsl(var(--foreground))',
            fontWeight: (() => {
              // 根节点保持加粗
              if (node.type === 'root') return 500

              // 分组标题（基站/图层文件/地理化数据/装饰图层）加粗
              if (node.type === 'sector-group' ||
                  node.type === 'layer-files' ||
                  node.type === 'custom-group' ||
                  node.type === 'decoration-group') {
                return 700
              }

              // 扇区图层
              if (node.type === 'sector-layer' && node.sectorLayer) {
                return node.sectorLayer.visible ? 600 : 400
              }

              // 图层文件
              if (node.type === 'layer-file' && node.layerFile) {
                return node.layerFile.visible ? 600 : 400
              }

              // 自定义图层
              if (node.type === 'custom-layer' && node.customLayer) {
                return node.customLayer.visible ? 600 : 400
              }

              // 频点 - 不加粗,使用正常字重
              if (node.type === 'frequency' && node.frequency) {
                return 400
              }

              // 其他类型保持正常
              return 400
            })(),
            textAlign: node.type === 'root' ? 'center' : 'left',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {/* 频点标签 - 分为频点数值和小区数量两部分 */}
          {node.type === 'frequency' && node.frequency ? (
            <>
              <span style={{ fontSize: 'inherit' }}>
                {node.frequency.frequency}
              </span>
              {node.frequency.count && (
                <span style={{
                  fontSize: '10px',
                  color: 'hsl(var(--muted-foreground))',
                  marginLeft: '2px',
                  fontWeight: 400
                }}>
                  ({node.frequency.count})
                </span>
              )}
            </>
          ) : (
            node.label
          )}
        </span>

        {/* 地图类型子节点已隐藏，改用按钮组切换 */}
        {false && node.type === 'map-type' && node.mapType && (
          <MapTypeRadio
            option={node.mapType}
            onToggle={() => onMapTypeChange(node.mapType.id)}
          />
        )}

        {/* 扇区图层 - 复选框 */}
        {node.type === 'sector-layer' && node.sectorLayer && (
          <SectorLayerCheckbox
            layer={node.sectorLayer}
            onToggle={(visible) => onSectorToggle(node.sectorLayer!.id, visible)}
            isChecked={node.sectorLayer.visible}
          />
        )}

        {/* 扇区图层 - "可选"开关（鼠标箭头；仅 z-order 最高且开启的图层被圈选；图层未勾选时不高亮） */}
        {node.type === 'sector-layer' && node.sectorLayer && selectable && (
          <SelectableToggleButton
            active={!!node.sectorLayer.visible && isLayerSelectable(selectable.map, node.sectorLayer.id)}
            hint={selectable.hint}
            onToggle={(v) => selectable.onToggle?.(node.sectorLayer!.id, v)}
          />
        )}

        {/* 扇区标签 - 文字标签显隐开关（复选框 → 可选 → 标签） */}
        {node.type === 'sector-layer' && node.sectorLabel && (
          <LabelToggleButton
            active={!!node.sectorLabel.visible}
            hint={labelToggleHint}
            onToggle={(v) => onSectorLabelToggle?.(node.sectorLabel!.layerId, v)}
          />
        )}

        {/* 图层文件 - 复选框 */}
        {node.type === 'layer-file' && node.layerFile && (
          <LayerFileCheckbox
            file={node.layerFile}
            onToggle={(visible) => onLayerFileToggle(node.layerFile!.id, visible)}
          />
        )}

        {/* 图层文件 - "可选"开关（鼠标箭头；仅 z-order 最高且开启的图层被圈选；
            图层未勾选时不高亮；编辑态保持高亮——可选开关被编辑强制开启） */}
        {node.type === 'layer-file' && node.layerFile && selectable && (
          <SelectableToggleButton
            active={!!node.layerFile.visible && isLayerSelectable(selectable.map, node.layerFile.id)}
            hint={selectable.hint}
            disabled={!node.layerFile.visible || editable?.editableLayerId === node.layerFile.id}
            onToggle={(v) => selectable.onToggle?.(node.layerFile!.id, v)}
          />
        )}

        {/* 图层文件 - "可编辑"开关（铅笔；仅 .tab 图层；全局互斥） */}
        {node.type === 'layer-file' && node.layerFile?.editable && editable?.onToggle && (
          <EditableToggleButton
            active={editable.editableLayerId === node.layerFile.id}
            hint={editable.hint}
            disabled={!node.layerFile.visible}
            onToggle={(v) => editable.onToggle?.(node.layerFile!.id, v)}
          />
        )}

        {/* 点文件标签 - 文字标签显隐开关（地理化数据；复选框 → 可选 → 编辑 → 标签） */}
        {node.type === 'layer-file' && node.layerFile && node.layerFile.sourceType === 'excel' && (
          <LabelToggleButton
            active={!!pointFileLabelVisibility[node.layerFile.id]}
            hint={labelToggleHint}
            onToggle={(v) => onPointFileLabelToggle?.(node.layerFile!.id, v)}
          />
        )}

        {/* 图层文件标签 - 文字标签显隐开关（MapInfo 图层；复选框 → 可选 → 编辑 → 标签） */}
        {node.type === 'layer-file' && node.layerFile && node.layerFile.sourceType !== 'excel' && (
          <LabelToggleButton
            active={!!layerFileLabelVisibility[node.layerFile.id]}
            hint={labelToggleHint}
            onToggle={(v) => onLayerFileLabelToggle?.(node.layerFile!.id, v)}
          />
        )}

        {/* 频点 - 颜色方块 + 复选框 */}
        {node.type === 'frequency' && node.frequency && (
          <FrequencyCheckbox
            frequency={node.frequency}
            onToggle={(visible: boolean) => onFrequencyToggle?.(
              node.frequency!.networkType,
              node.frequency!.frequency,
              visible
            )}
            networkType={node.frequency!.networkType}
            onColorChange={onFrequencyColorChange
              ? (color, strokeColor) => onFrequencyColorChange(node.frequency!.networkType, node.frequency!.frequency, { color, strokeColor })
              : undefined}
            colorPickDisabled={!!sectorThematicActive?.[node.frequency.networkType === 'LTE' ? 'lte-sectors' : 'nr-sectors']}
          />
        )}

        {/* 自定义图层 - 复选框 */}
        {node.type === 'custom-layer' && node.customLayer && (
          <CustomLayerCheckbox
            layer={node.customLayer}
            onToggle={(visible: boolean) => onCustomLayerToggle?.(node.customLayer!.id, visible)}
          />
        )}

        {/* 装饰图层 - 复选框（与上面图层的复选框对齐） */}
        {node.type === 'decoration-layer' && node.decorationLayer && (
          <DecorationLayerCheckbox
            layer={node.decorationLayer}
            onToggle={(visible: boolean) => onDecorationLayerToggle?.(visible)}
          />
        )}

        {/* 装饰图层 - "可选"开关（鼠标箭头；打点/定位标记圈选；图层未勾选时不高亮） */}
        {node.type === 'decoration-layer' && selectable && (
          <SelectableToggleButton
            active={!!node.decorationLayer?.visible && isLayerSelectable(selectable.map, 'decoration-layer')}
            hint={selectable.hint}
            onToggle={(v) => selectable.onToggle?.('decoration-layer', v)}
          />
        )}
        {/* 装饰图层 - 文字标签显隐开关（复选框 → 可选 → 标签） */}
        {node.type === 'decoration-layer' && node.decorationLayer && (
          <LabelToggleButton
            active={!!decorationLabelVisible}
            hint={labelToggleHint}
            onToggle={(v) => onDecorationLabelToggle?.(v)}
          />
        )}

      </div>

      {/* 子节点 */}
      {isExpandable && isExpanded && node.children && (
        <div>
          {node.children.filter(child => child.type !== 'map-type').map(child => (
            <TreeNodeComponent
              key={child.id}
              node={child}
              level={level + 1}
              onToggle={onToggle}
              onSectorToggle={onSectorToggle}
              onSectorLabelToggle={onSectorLabelToggle}
              onLayerFileToggle={onLayerFileToggle}
              onMapTypeChange={onMapTypeChange}
              onFrequencyToggle={onFrequencyToggle}
              onCustomLayerToggle={onCustomLayerToggle}
              onLayerFileRemove={onLayerFileRemove}
              onCustomLayerRemove={onCustomLayerRemove}
              onPointFileLabelToggle={onPointFileLabelToggle}
              onLayerFileLabelToggle={onLayerFileLabelToggle}
              onDecorationLayerToggle={onDecorationLayerToggle}
              onDecorationLabelToggle={onDecorationLabelToggle}
              decorationLabelVisible={decorationLabelVisible}
              onContextMenu={onContextMenu}
              mapType={mapType}
              pointFileLabelVisibility={pointFileLabelVisibility}
              layerFileLabelVisibility={layerFileLabelVisibility}
              onFrequencyColorChange={onFrequencyColorChange}
              sectorThematicActive={sectorThematicActive}
              selectable={selectable}
              editable={editable}
              labelToggleHint={labelToggleHint}
              dnd={dnd}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 图层"可选"开关按钮（鼠标箭头图标）
 * 开启后该图层可被圈选/点选；实际仅 z-order 最高
 * （跨类：基站 > 图层文件 > 地理化数据 > 装饰图层；类内：面板最上）且开启的图层生效。
 */
function SelectableToggleButton({ active, hint, onToggle, disabled = false }: {
  active: boolean
  hint: string
  onToggle: (selectable: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={hint}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(!active)
      }}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        width: '20px',
        height: '20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: 0,
        border: 'none',
        borderRadius: '4px',
        background: 'transparent',
        color: active ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground) / 0.45)',
        // 禁用且未激活才弱化：编辑态锁定时保持高亮（可选开关被编辑强制开启）
        opacity: disabled && !active ? 0.35 : 1,
        flexShrink: 0
      }}
    >
      <MousePointer2 size={13} fill={active ? 'currentColor' : 'none'} />
    </button>
  )
}

/** 图层"可编辑"开关按钮（铅笔图标；全局互斥，同时只能编辑一个图层） */
function EditableToggleButton({ active, hint, onToggle, disabled = false }: {
  active: boolean
  hint: string
  onToggle: (active: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={hint}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(!active)
      }}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        width: '20px',
        height: '20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: 0,
        border: 'none',
        borderRadius: '4px',
        background: 'transparent',
        color: active ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground) / 0.45)',
        opacity: disabled ? 0.35 : 1,
        flexShrink: 0
      }}
    >
      <Pencil size={12} fill={active ? 'currentColor' : 'none'} />
    </button>
  )
}

/** 图层"要素标签"开关按钮（Type/文字图标；与"可选/可编辑"开关同款按钮风格） */
function LabelToggleButton({ active, hint, onToggle, disabled = false }: {
  active: boolean
  hint: string
  onToggle: (active: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={hint}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(!active)
      }}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        width: '20px',
        height: '20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: 0,
        border: 'none',
        borderRadius: '4px',
        background: 'transparent',
        color: active ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground) / 0.45)',
        opacity: disabled ? 0.35 : 1,
        flexShrink: 0
      }}
    >
      <Type size={13} fill={active ? 'currentColor' : 'none'} />
    </button>
  )
}

/**
 * 地图类型单选按钮组件
 */
interface MapTypeRadioProps {
  option: MapTypeOption;
  onToggle: () => void;
}

/**
 * 地图类型单选按钮组件
 */
function MapTypeRadio({ option, onToggle }: MapTypeRadioProps) {
  return (
    <div
      onClick={onToggle}
      style={{
        width: '16px',
        height: '16px',
        border: option.visible ? 'hsl(var(--primary)) solid 2px' : 'hsl(var(--border)) solid 2px',
        borderRadius: '50%',
        backgroundColor: option.visible ? 'hsl(var(--primary))' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        transition: 'all 0.2s ease'
      }}
    >
      {option.visible && (
        <div
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: 'hsl(var(--primary-foreground))'
          }}
        />
      )}
    </div>
  );
}

/**
 * 扇区图层复选框组件
 */
interface SectorLayerCheckboxProps {
  layer: SectorLayerOption;
  onToggle: (visible: boolean) => void;
  isChecked?: boolean;
}

/**
 * 扇区图层复选框组件
 */
function SectorLayerCheckbox({ layer, onToggle, isChecked: externalChecked }: SectorLayerCheckboxProps) {
  const [isChecked, setIsChecked] = useState(externalChecked ?? layer.visible);

  useEffect(() => {
    setIsChecked(externalChecked ?? layer.visible);
  }, [layer.visible, externalChecked]);

  const handleToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const newValue = e.target.checked;
    setIsChecked(newValue);
    onToggle(newValue);
  };

  return (
    <label className="custom-checkbox">
      <input
        type="checkbox"
        checked={isChecked}
        onChange={handleToggle}
      />
      <span className="checkmark"></span>
    </label>
  );
}

/**
 * 图层文件复选框组件
 */
interface LayerFileCheckboxProps {
  file: LayerFileOption;
  onToggle: (visible: boolean) => void;
}

/**
 * 图层文件复选框组件
 */
function LayerFileCheckbox({ file, onToggle }: LayerFileCheckboxProps) {
  const [isChecked, setIsChecked] = useState(file.visible);

  useEffect(() => {
    setIsChecked(file.visible);
  }, [file.visible]);

  const handleToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const newValue = e.target.checked;
    setIsChecked(newValue);
    onToggle(newValue);
  };

  return (
    <label className="custom-checkbox">
      <input
        type="checkbox"
        checked={isChecked}
        onChange={handleToggle}
      />
      <span className="checkmark"></span>
    </label>
  );
}

/**
 * 使十六进制颜色变深（用于频点自定义配色的边框色）
 */
function darkenHex(hex: string, amount = 35): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return hex
  const to = (n: number) => Math.max(0, n - amount)
  const r = to(parseInt(m[1], 16))
  const g = to(parseInt(m[2], 16))
  const b = to(parseInt(m[3], 16))
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

/**
 * 频点复选框组件属性接口
 */
interface FrequencyCheckboxProps {
  frequency: FrequencyOption;
  onToggle: (visible: boolean) => void;
  networkType: NetworkType;
  /** 频点自定义配色回调（点击色块进入配色面板） */
  onColorChange?: (color: string, strokeColor: string) => void;
  /** 专题图层激活时禁用配色面板 */
  colorPickDisabled?: boolean;
}

/**
 * 频点复选框组件
 * 显示频点颜色方块和复选框；默认设置模式下点击色块进入配色面板自定义配色并持久化
 */
function FrequencyCheckbox({ frequency, onToggle, networkType, onColorChange, colorPickDisabled = false }: FrequencyCheckboxProps) {
  const { t } = useTranslation()
  const [isChecked, setIsChecked] = useState(frequency.visible);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [draftColor, setDraftColor] = useState(frequency.color);

  useEffect(() => {
    setIsChecked(frequency.visible);
  }, [frequency.visible]);

  // 外部颜色变化（父组件持久化返回）时同步草稿色
  useEffect(() => {
    setDraftColor(frequency.color);
  }, [frequency.color]);

  const handleToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const newValue = e.target.checked;
    setIsChecked(newValue);
    onToggle(newValue);
  };

  const canPickColor = !!onColorChange && !colorPickDisabled;

  const applyColor = (color: string) => {
    setDraftColor(color);
    onColorChange?.(color, darkenHex(color));
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', position: 'relative' }}>
      {/* 颜色方块 - 优化样式；默认设置模式下可点击进入配色面板 */}
      <div
        onClick={(e) => {
          if (!canPickColor) return
          e.stopPropagation()
          setShowColorPicker(prev => !prev)
        }}
        title={canPickColor ? t('map.frequencyColorEdit') : (colorPickDisabled ? t('map.frequencyColorDisabled') : undefined)}
        style={{
          width: '14px',
          height: '14px',
          backgroundColor: frequency.color,
          border: `1px solid ${frequency.strokeColor}`,
          borderRadius: '4px',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.1)',
          cursor: canPickColor ? 'pointer' : 'default'
        }}
      />

      {/* 现代化复选框 */}
      <label className="custom-checkbox">
        <input
          type="checkbox"
          checked={isChecked}
          onChange={handleToggle}
        />
        <span className="checkmark"></span>
      </label>

      {/* 频点配色面板（默认设置模式下点击色块弹出） */}
      {showColorPicker && (
        <div
          className="frequency-color-picker"
          style={{
            position: 'absolute',
            right: 0,
            top: '24px',
            zIndex: 1200,
            backgroundColor: 'hsl(var(--popover))',
            borderRadius: '8px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
            border: '1px solid hsl(var(--border))',
            padding: '10px',
            width: '200px'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', marginBottom: '6px', fontWeight: 500 }}>
            {frequency.frequency} MHz
          </div>
          <HexColorPicker color={draftColor} onChange={applyColor} style={{ width: '100%', height: '150px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' }}>
            <input
              type="text"
              value={draftColor}
              onChange={(e) => applyColor(e.target.value)}
              className="flex-1 px-2 py-1 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="hsl(var(--foreground))"
            />
            <button
              onClick={(e) => {
                e.stopPropagation()
                setShowColorPicker(false)
              }}
              className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
            >
              {t('map.frequencyColorDone')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 旧的图层选项接口（向后兼容）
 */
export interface LayerOption {
  id: string
  label: string
  type: NetworkType
  visible: boolean
  icon: string
  color: string
}

/**
 * 默认图层配置（向后兼容）
 */
export function createDefaultLayers(): LayerOption[] {
  return [
    {
      id: 'lte-sectors',
      label: 'LTE扇区',
      type: 'LTE',
      visible: false,
      icon: '📡',
      color: 'hsl(var(--primary))'
    },
    {
      id: 'nr-sectors',
      label: 'NR扇区',
      type: 'NR',
      visible: false,
      icon: '📶',
      color: '#10b981'
    }
  ]
}

/**
 * 自定义图层复选框组件
 */
function CustomLayerCheckbox({ layer, onToggle }: { layer: CustomLayerOption; onToggle: (visible: boolean) => void }) {
  const [isChecked, setIsChecked] = useState(layer.visible);

  useEffect(() => {
    setIsChecked(layer.visible);
  }, [layer.visible]);

  const handleToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const newValue = e.target.checked;
    setIsChecked(newValue);
    onToggle(newValue);
  };

  return (
    <label className="custom-checkbox">
      <input
        type="checkbox"
        checked={isChecked}
        onChange={handleToggle}
      />
      <span className="checkmark"></span>
    </label>
  );
}

/**
 * 装饰图层复选框组件
 */
function DecorationLayerCheckbox({ layer, onToggle }: { layer: DecorationLayerOption; onToggle: (visible: boolean) => void }) {
  const [isChecked, setIsChecked] = useState(layer.visible);

  useEffect(() => {
    setIsChecked(layer.visible);
  }, [layer.visible]);

  const handleToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const newValue = e.target.checked;
    setIsChecked(newValue);
    onToggle(newValue);
  };

  return (
    <label className="custom-checkbox">
      <input
        type="checkbox"
        checked={isChecked}
        onChange={handleToggle}
      />
      <span className="checkmark"></span>
    </label>
  );
}