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
import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronDown, ChevronRight, Map, Folder, File, X, Satellite, Radio } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NetworkType } from '../../config/sector-config'
import { LabelSettingsModal, LabelSettings, FieldOption } from './LabelSettingsModal'
import { layerApi } from '../../services/api'
import { useMapStore } from '../../store/mapStore'

/**
 * 预定义的标签字段列表
 * 用于扇区标签设置的下拉选项
 */
const PREDEFINED_LABEL_FIELDS: FieldOption[] = [
  { value: 'name', label: '小区名称' },
  { value: 'siteId', label: '基站ID' },
  { value: 'frequency', label: '下行频点' },
  { value: 'pci', label: 'PCI' },
  { value: 'tac', label: 'TAC' },
  { value: 'isShared', label: '是否共享' },
  { value: 'coverageType', label: '覆盖类型' }
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
  type: 'point' | 'line' | 'polygon' | 'sector'
  visible: boolean
  dataId: string
  sourceType?: 'mapinfo' | 'excel'
  geometryType?: 'point' | 'sector' | 'polygon'
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
  /** 装饰图层 */
  decorationLayer?: DecorationLayerOption
  /** 装饰图层可见性变化回调 */
  onDecorationLayerToggle?: (visible: boolean) => void
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
  decorationLayer,
  onDecorationLayerToggle
}: LayerControlProps) {
  const { t } = useTranslation()

  // 从持久化 store 获取标签设置
  const { labelSettingsMap: persistedLabelSettings, setLabelSettings } = useMapStore()

  // 用户手动切换的展开节点ID集合
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set(['root', 'sector-group', 'custom-group']))

  // 标签设置弹窗状态
  const [showLabelSettingsModal, setShowLabelSettingsModal] = useState(false)
  const [currentSettingsNode, setCurrentSettingsNode] = useState<TreeNode | null>(null)
  const [currentLabelSettings, setCurrentLabelSettings] = useState<LabelSettings>({
    content: 'name',
    color: '#000000',
    fontSize: 12
  })

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
   * 从 API 获取地理化数据并提取列名
   */
  const fetchLayerFileDataFromAPI = async (dataId: string, layerId: string) => {
    setLoadingFields(true)
    try {
      console.log('[LayerControl] 从 API 获取数据:', dataId, 'layerId:', layerId)

      const response = await layerApi.getLayerData(dataId, layerId)
      if (response.success && response.data) {
        const rawData = response.data

        // ✅ 改进：处理多种数据格式 (GeoJSON 或 普通列表)
        const allColumns = new Set<string>()

        // 如果是 GeoJSON 格式 (包含 features 数组)
        const features = rawData.features || (Array.isArray(rawData) ? rawData : [])

        for (const item of features) {
          // 1. 只有当 props 是要素根级时，才排除内部字段
          const isGeoJSONRoot = !!item.properties
          const props = item.properties || item

          // 收集当前对象的所有字段
          for (const key of Object.keys(props)) {
            // 排除 GeoJSON 结构性字段和核心坐标字段
            if (key === 'attributes' || key === 'properties' ||
              key === 'longitude' || key === 'latitude' ||
              key === 'displayLng' || key === 'displayLat' ||
              key === 'type' || key === 'geometry') {
              continue
            }

            // 只有当它不是嵌套的 properties 时，才排除内部预定义名 (防止在根级出现 name/azimuth)
            // 如果是在 properties 内部，我们应该保留原始列名，即使它叫 name
            if (!isGeoJSONRoot && (key === 'name' || key === 'azimuth')) {
              continue
            }

            allColumns.add(key)
          }

          // 2. 如果有嵌套的 properties 或 attributes，深入一层收集（不排除任何原始字段）
          const nested = props.properties || props.attributes
          if (nested && typeof nested === 'object') {
            for (const key of Object.keys(nested)) {
              allColumns.add(key)
            }
          }
        }

        // 转换为数组并排序
        const columns = Array.from(allColumns).sort()

        console.log('[LayerControl] 从 API 提取到的列名:', columns)
        console.log('[LayerControl] 列名数量:', columns.length)

        // 生成字段选项（直接使用原始列名）
        const fieldOptions: FieldOption[] = columns.map(col => ({
          value: col,
          label: col
        }))

        console.log('[LayerControl] 生成的字段选项数量:', fieldOptions.length)
        setFieldOptions(fieldOptions)
      } else {
        console.warn('[LayerControl] API 获取数据失败')
        setFieldOptions([])
      }
    } catch (error) {
      console.error('[LayerControl] 从 API 获取数据失败:', error)
      setFieldOptions([])
    } finally {
      setLoadingFields(false)
    }
  }

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
            children: sectors.map(sector => {
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
              children: layerFiles.map(file => ({
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
              // 优先显示 pointFiles，为每个文件添加标签子项
              ...pointFiles.map(file => {
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

  // 当外部数据变化时更新树
  useEffect(() => {
    setTree(buildTree())
  }, [sectors, layerFiles, pointFiles, mapType, sectorLabelVisibility, layerFileLabelVisibility, pointFileLabelVisibility, frequencies, customLayers, decorationLayer])

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

  // 全局右键菜单状态
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, nodeId: string, type: string } | null>(null)

  // 处理右键点击
  const handleContextMenu = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault()
    e.stopPropagation()

    // 支持 sector-layer 和 layer-file 的标签设置
    if (node.type === 'sector-layer' || node.type === 'layer-file') {
      // 先立即显示对话框
      setShowLabelSettingsModal(true)
      setCurrentSettingsNode(node)

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
        color: '#000000',
        fontSize: 12
      })

      // 异步加载字段选项（不阻塞对话框显示）
      if (node.type === 'sector-layer' && node.sectorLayer) {
        // LTE/NR扇区：从预定义字段列表加载（同步）
        setFieldOptions(PREDEFINED_LABEL_FIELDS)
        fetchSectorFieldOptions(node.sectorLayer.type)
      } else if (node.type === 'layer-file' && node.layerFile) {
        // 图层文件：检查是否为 Excel 点文件（地理化数据）
        if (node.layerFile.sourceType === 'excel') {
          // ✅ Excel 点文件：不要使用预定义字段，从实际数据中动态提取列名
          console.log('[LayerControl] 检测到 Excel 点文件，从数据中提取列名:', node.layerFile.id)
          console.log('[LayerControl] 当前 pointFileData:', Object.keys(pointFileData))

          const fileData = pointFileData[node.layerFile.id]
          const features = (fileData as any)?.features || (Array.isArray(fileData) ? fileData : [])

          if (features && features.length > 0) {
            console.log('[LayerControl] 数据记录数量:', features.length)

            // ✅ 改进：遍历所有记录，收集所有可能的字段
            const allColumns = new Set<string>()

            for (const item of features) {
              // 1. 只有当 props 是要素根级时，才排除内部字段
              const isGeoJSONRoot = !!item.properties
              const props = item.properties || item

              // 收集当前对象的所有字段
              for (const key of Object.keys(props)) {
                // 排除 GeoJSON 结构性字段和核心坐标字段
                if (key === 'attributes' || key === 'properties' ||
                  key === 'longitude' || key === 'latitude' ||
                  key === 'displayLng' || key === 'displayLat' ||
                  key === 'type' || key === 'geometry') {
                  continue
                }

                // 只有当它不是嵌套的 properties 时，才排除内部预定义名 (防止在根级出现 name/azimuth)
                // 如果是在 properties 内部，我们应该保留原始列名，即使它叫 name
                if (!isGeoJSONRoot && (key === 'name' || key === 'azimuth')) {
                  continue
                }

                allColumns.add(key)
              }

              // 2. 如果有嵌套的 properties 或 attributes，深入一层收集（不排除任何原始字段）
              const nested = props.properties || props.attributes
              if (nested && typeof nested === 'object') {
                for (const key of Object.keys(nested)) {
                  allColumns.add(key)
                }
              }
            }

            // 转换为数组并排序
            const columns = Array.from(allColumns).sort()

            console.log('[LayerControl] 从所有记录提取到的列名:', columns)
            console.log('[LayerControl] 列名数量:', columns.length)

            // 生成字段选项（直接使用原始列名）
            const excelFieldOptions: FieldOption[] = columns.map(col => ({
              value: col,
              label: col  // 直接使用原始列名
            }))

            console.log('[LayerControl] 生成的字段选项数量:', excelFieldOptions.length)
            setFieldOptions(excelFieldOptions)
          } else {
            console.warn('[LayerControl] 未找到文件数据，数据ID:', node.layerFile.dataId)
            console.warn('[LayerControl] 可用的数据文件ID:', Object.keys(pointFileData))

            // ✅ 如果内存中没有数据，先显示空字段列表并启动加载状态
            setFieldOptions([])
            setLoadingFields(true)

            // 尝试从 API 获取
            if (node.layerFile.dataId) {
              console.log('[LayerControl] 尝试从 API 获取数据...')
              fetchLayerFileDataFromAPI(node.layerFile.dataId, node.layerFile.id)
            }
          }
        } else {
          // MapInfo 图层文件：先显示预定义字段，然后异步获取实际字段
          setFieldOptions(PREDEFINED_LABEL_FIELDS)
          fetchLayerFileFieldOptions(node.layerFile.dataId, node.layerFile.id)
        }
      }
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
      setLabelSettings(layerId, settings)
    }

    // 通知父组件更新标签配置
    // MapPage中的onLabelSettingsChange会自动处理：更新配置状态 + 设置可见性为true + 立即应用到地图
    onLabelSettingsChange?.(node, settings)

    // 更新本地状态
    setCurrentLabelSettings(settings)
    setShowLabelSettingsModal(false)
  }

  return (
    <>
      <style>{`
        /* 自定义面板滚动条 - 美化样式 */
        .layer-control::-webkit-scrollbar {
          width: 6px;
        }
        .layer-control::-webkit-scrollbar-track {
          background: rgba(0, 0, 0, 0.03);
          border-radius: 3px;
        }
        .layer-control::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.15);
          border-radius: 3px;
          transition: background 0.2s ease;
        }
        .layer-control::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 0, 0, 0.25);
        }
        /* Firefox 滚动条样式 */
        .layer-control {
          scrollbar-width: thin;
          scrollbar-color: rgba(0, 0, 0, 0.15) rgba(0, 0, 0, 0.03);
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
          background-color: #f3f4f6;
          border: 2px solid #d1d5db;
          border-radius: 4px;
          transition: all 0.2s ease;
        }
        .custom-checkbox:hover input ~ .checkmark {
          background-color: #e5e7eb;
          border-color: #9ca3af;
        }
        .custom-checkbox input:checked ~ .checkmark {
          background-color: #3b82f6;
          border-color: #3b82f6;
        }
        .custom-checkbox .checkmark:after {
          content: "";
          position: absolute;
          display: none;
          left: 4px;
          top: 1px;
          width: 4px;
          height: 8px;
          border: solid white;
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
            backgroundColor: 'rgba(255, 255, 255, 0.98)',
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
            backgroundColor: 'rgba(0, 0, 0, 0.03)',
            transition: 'background-color 0.2s ease',
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.2)'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.03)'}
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
            color: isPinned ? '#3b82f6' : '#9ca3af',
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
              onContextMenu={handleContextMenu}
              mapType={mapType}
              pointFileLabelVisibility={pointFileLabelVisibility}
              layerFileLabelVisibility={layerFileLabelVisibility}
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
            backgroundColor: 'white',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            border: '1px solid #e2e8f0',
            padding: '4px',
            minWidth: '100px'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              if (contextMenu.type === 'layer-file') {
                onLayerFileRemove?.(contextMenu.nodeId)
              } else if (contextMenu.type === 'custom-layer') {
                onCustomLayerRemove?.(contextMenu.nodeId)
              }
              setContextMenu(null)
            }}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 12px',
              fontSize: '12px',
              color: '#ef4444',
              cursor: 'pointer',
              border: 'none',
              backgroundColor: 'transparent',
              textAlign: 'left',
              borderRadius: '4px'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#fff1f2')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <X size={14} />
            <span>{t('map.unloadLayer')}</span>
          </button>
        </div>
      )}

      {/* 标签设置弹窗 */}
      <LabelSettingsModal
        isOpen={showLabelSettingsModal}
        onClose={() => setShowLabelSettingsModal(false)}
        onSave={handleSaveLabelSettings}
        title={currentSettingsNode?.type === 'sector-layer' ? t('map.sectorLabelSettings') : t('map.layerFileLabelSettings')}
        currentSettings={currentLabelSettings}
        fieldOptions={fieldOptions}
        loadingFields={loadingFields}
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
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  mapType: 'roadmap' | 'satellite';
  pointFileLabelVisibility: Record<string, boolean>;
  layerFileLabelVisibility: Record<string, boolean>;
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
  onContextMenu,
  mapType,
  pointFileLabelVisibility,
  layerFileLabelVisibility
}: TreeNodeComponentProps) {
  const getIndent = () => {
    // 根据层级添加缩进：每级 16px
    const basePadding = 4
    const indentPerLevel = 16
    const paddingLeft = basePadding + (level * indentPerLevel)
    return { paddingLeft: `${paddingLeft}px` }
  }

  /**
   * 渲染树形连线
   */
  const renderTreeLines = () => {
    if (level === 0 || node.type === 'root') return null

    const lineColor = 'rgba(0, 0, 0, 0.15)'
    const lines = []

    // 为每个层级绘制竖线
    for (let i = 0; i < level; i++) {
      const leftPos = 4 + (i * 16) + 8 // 4px base + level * 16px + 8px center
      lines.push(
        <div
          key={`line-${i}`}
          style={{
            position: 'absolute',
            left: `${leftPos}px`,
            top: 0,
            bottom: 0,
            width: '1px',
            backgroundColor: lineColor,
            pointerEvents: 'none'
          }}
        />
      )
    }

    // 绘制当前节点的横线连接线
    const lastLineLeft = 4 + ((level - 1) * 16) + 8
    lines.push(
      <div
        key="horizontal-line"
        style={{
          position: 'absolute',
          left: `${lastLineLeft}px`,
          top: '50%',
          width: '8px',
          height: '1px',
          backgroundColor: lineColor,
          pointerEvents: 'none'
        }}
      />
    )

    return lines
  }

  const getNodeIcon = () => {
    // 根据需求，删除特定节点类型的图标，只保留文字
    switch (node.type) {
      case 'root':
        return null
      case 'map-type':
        if (node.mapType?.id === 'roadmap') return <Map size={14} color="#000" />
        if (node.mapType?.id === 'satellite') return <Satellite size={14} color="#000" />
        return null
      case 'sector-layer':
        return <Radio size={12} color="#000" />
      case 'sector-group':
        return <Map size={14} color="#000" />
      case 'layer-files':
        return <Folder size={14} color="#000" />
      case 'sector-label':
        return <span style={{ fontSize: '14px' }}>📝</span>
      case 'layer-file-label':
        return <span style={{ fontSize: '14px' }}>🏷️</span>
      case 'layer-file':
        return <File size={12} color="#000" />
      case 'custom-group':
        return <Folder size={14} color="#000" />
      case 'custom-layer':
        return <File size={12} color="#000" />
      case 'decoration-layer':
        return <Folder size={14} color="#000" />
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
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          padding: node.type === 'frequency' ? '4px 8px' : '8px 12px',
          cursor: node.type === 'root' ? 'default' : (isExpandable ? 'pointer' : 'default'),
          userSelect: 'none',
          borderBottom: '1px solid rgba(0, 0, 0, 0.05)',
          backgroundColor: node.type === 'root' ? 'transparent' : 'transparent',
          borderRadius: '8px',
          border: 'none',
          boxShadow: 'none',
          gap: node.type === 'frequency' ? '4px' : '8px',
          height: 'auto',
          minHeight: node.type === 'frequency' ? '18px' : '36px',
          lineHeight: '1.2',
          position: 'relative',
          transition: 'all 0.2s ease',
          // 频点行内容左移3个字符宽度，保持树形连线位置不变
          ...(node.type === 'frequency' ? { paddingLeft: '4px' } : {}),
          ...getIndent()
        }}
        onClick={node.type === 'root' ? undefined : handleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
        onMouseEnter={(e) => {
          if (node.type !== 'root') {
            e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.05)'
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent'
        }}
      >
        {/* 树形连线 */}
        {renderTreeLines()}

        {/* 展开/折叠图标 - root 节点不显示 */}
        {node.type !== 'root' && (
          <>
            {isExpandable ? (
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '16px' }}>
                {isExpanded ? (
                  <ChevronDown size={12} color="#000" />
                ) : (
                  <ChevronRight size={12} color="#000" />
                )}
              </span>
            ) : (
              <span style={{ width: '16px' }} />
            )}
          </>
        )}

        {/* 节点图标 */}
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '16px' }}>
          {getNodeIcon()}
        </span>

        {/* 节点标签 */}
        <span
          title={node.label}
          style={{
            flex: 1,
            color: node.type === 'root' ? '#000' : '#000',
            fontWeight: (() => {
              // 根节点保持加粗
              if (node.type === 'root') return 500

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
                  color: '#94a3b8',
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

        {/* 扇区标签 - 标签图标样式控件（如果是扇区图层节点且有标签配置） */}
        {node.type === 'sector-layer' && node.sectorLayer && node.sectorLabel && (
          <div
            onClick={(e) => {
              e.stopPropagation()
              // 使用可选链和空值合并操作符确保类型安全
              const currentVisible = node.sectorLabel?.visible ?? false
              const newVisible = !currentVisible
              const layerId = node.sectorLabel?.layerId ?? ''
              console.log('[LayerControl] Sector label toggle:', layerId, newVisible)
              onSectorLabelToggle?.(layerId, newVisible)
            }}
            style={{
              width: '20px',
              height: '20px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {/* 标签图标 - 显示为图1样式，不显示为图2样式 */}
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* 标签形状 */}
              <path
                d="M10 3L17 5V15L10 17L3 15V5L10 3Z"
                fill={node.sectorLabel.visible ? '#3b82f6' : '#e0e0e0'}
                stroke={node.sectorLabel.visible ? '#2563eb' : '#bdbdbd'}
                strokeWidth="1.5"
              />
              {/* 标签孔 */}
              <circle
                cx="10"
                cy="4.5"
                r="1.5"
                fill={node.sectorLabel.visible ? '#ffffff' : '#f5f5f5'}
                stroke={node.sectorLabel.visible ? '#2563eb' : '#bdbdbd'}
                strokeWidth="1.5"
              />
              {/* 标签上的线条 */}
              <line
                x1="7"
                y1="9"
                x2="13"
                y2="9"
                stroke={node.sectorLabel.visible ? '#ffffff' : '#bdbdbd'}
                strokeWidth="2"
                strokeLinecap="round"
              />
              <line
                x1="7"
                y1="12"
                x2="13"
                y2="12"
                stroke={node.sectorLabel.visible ? '#ffffff' : '#bdbdbd'}
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
        )}

        {/* 图层文件 - 复选框 */}
        {node.type === 'layer-file' && node.layerFile && (
          <LayerFileCheckbox
            file={node.layerFile}
            onToggle={(visible) => onLayerFileToggle(node.layerFile!.id, visible)}
          />
        )}

        {/* 点文件标签 - 标签图标样式控件（地理化数据） */}
        {node.type === 'layer-file' && node.layerFile && node.layerFile.sourceType === 'excel' && (
          <div
            onClick={(e) => {
              e.stopPropagation()
              const fileId = node.layerFile!.id
              const currentVisible = pointFileLabelVisibility[fileId] || false
              const newVisible = !currentVisible
              console.log('[LayerControl] Point file label toggle:', fileId, newVisible)
              onPointFileLabelToggle?.(fileId, newVisible)
            }}
            style={{
              width: '20px',
              height: '20px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {/* 标签图标 */}
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* 标签形状 */}
              <path
                d="M10 3L17 5V15L10 17L3 15V5L10 3Z"
                fill={pointFileLabelVisibility[node.layerFile!.id] ? '#3b82f6' : '#e0e0e0'}
                stroke={pointFileLabelVisibility[node.layerFile!.id] ? '#2563eb' : '#bdbdbd'}
                strokeWidth="1.5"
              />
              {/* 标签孔 */}
              <circle
                cx="10"
                cy="4.5"
                r="1.5"
                fill={pointFileLabelVisibility[node.layerFile!.id] ? '#ffffff' : '#f5f5f5'}
                stroke={pointFileLabelVisibility[node.layerFile!.id] ? '#2563eb' : '#bdbdbd'}
                strokeWidth="1.5"
              />
              {/* 标签上的线条 */}
              <line
                x1="7"
                y1="9"
                x2="13"
                y2="9"
                stroke={pointFileLabelVisibility[node.layerFile!.id] ? '#ffffff' : '#bdbdbd'}
                strokeWidth="2"
                strokeLinecap="round"
              />
              <line
                x1="7"
                y1="12"
                x2="13"
                y2="12"
                stroke={pointFileLabelVisibility[node.layerFile!.id] ? '#ffffff' : '#bdbdbd'}
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
        )}

        {/* 图层文件标签 - 标签图标样式控件（MapInfo 图层，非 Excel） */}
        {node.type === 'layer-file' && node.layerFile && node.layerFile.sourceType !== 'excel' && (
          <div
            onClick={(e) => {
              e.stopPropagation()
              const fileId = node.layerFile!.id
              const currentVisible = layerFileLabelVisibility[fileId] || false
              const newVisible = !currentVisible
              console.log('[LayerControl] MapInfo layer file label toggle:', fileId, newVisible)
              onLayerFileLabelToggle?.(fileId, newVisible)
            }}
            style={{
              width: '20px',
              height: '20px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {/* 标签图标 */}
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* 标签形状 */}
              <path
                d="M10 3L17 5V15L10 17L3 15V5L10 3Z"
                fill={layerFileLabelVisibility[node.layerFile!.id] ? '#3b82f6' : '#e0e0e0'}
                stroke={layerFileLabelVisibility[node.layerFile!.id] ? '#2563eb' : '#bdbdbd'}
                strokeWidth="1.5"
              />
              {/* 标签孔 */}
              <circle
                cx="10"
                cy="4.5"
                r="1.5"
                fill={layerFileLabelVisibility[node.layerFile!.id] ? '#ffffff' : '#f5f5f5'}
                stroke={layerFileLabelVisibility[node.layerFile!.id] ? '#2563eb' : '#bdbdbd'}
                strokeWidth="1.5"
              />
              {/* 标签上的线条 */}
              <line
                x1="7"
                y1="9"
                x2="13"
                y2="9"
                stroke={layerFileLabelVisibility[node.layerFile!.id] ? '#ffffff' : '#bdbdbd'}
                strokeWidth="2"
                strokeLinecap="round"
              />
              <line
                x1="7"
                y1="12"
                x2="13"
                y2="12"
                stroke={layerFileLabelVisibility[node.layerFile!.id] ? '#ffffff' : '#bdbdbd'}
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
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

        {/* 装饰图层 - 占位符（与上面图层的标签按钮对齐） */}
        {node.type === 'decoration-layer' && node.decorationLayer && (
          <div style={{ width: '20px', height: '20px' }} />
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
              onContextMenu={onContextMenu}
              mapType={mapType}
              pointFileLabelVisibility={pointFileLabelVisibility}
              layerFileLabelVisibility={layerFileLabelVisibility}
            />
          ))}
        </div>
      )}
    </div>
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
        border: option.visible ? '#3b82f6 solid 2px' : 'rgba(0, 0, 0, 0.2) solid 2px',
        borderRadius: '50%',
        backgroundColor: option.visible ? '#3b82f6' : 'transparent',
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
            backgroundColor: 'white'
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
 * 频点复选框组件属性接口
 */
interface FrequencyCheckboxProps {
  frequency: FrequencyOption;
  onToggle: (visible: boolean) => void;
  networkType: NetworkType;
}

/**
 * 频点复选框组件
 * 显示频点颜色方块和复选框
 */
function FrequencyCheckbox({ frequency, onToggle, networkType }: FrequencyCheckboxProps) {
  const [isChecked, setIsChecked] = useState(frequency.visible);

  useEffect(() => {
    setIsChecked(frequency.visible);
  }, [frequency.visible]);

  const handleToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const newValue = e.target.checked;
    setIsChecked(newValue);
    onToggle(newValue);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      {/* 颜色方块 - 优化样式 */}
      <div
        style={{
          width: '14px',
          height: '14px',
          backgroundColor: frequency.color,
          border: `1px solid ${frequency.strokeColor}`,
          borderRadius: '4px',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.1)'
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
      color: '#3b82f6'
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