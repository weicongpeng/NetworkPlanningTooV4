import { useState, useEffect, useRef, useCallback } from 'react'
import { Play, Download, Settings, Loader2, AlertCircle, Search, X, Ruler, Save, Check, GripVertical, List, Eye } from 'lucide-react'
import { pciApi, dataApi } from '../services/api'
import type { ApiResponse } from '@shared/types'
import { useTaskStore } from '../store/taskStore'
import { OnlineMap, type OnlineMapRef } from '../components/Map/OnlineMap'
import { PCILegend } from '../components/Map/PCILegend'
import { MapTypeSwitch } from '../components/Map/MapTypeSwitch'
import { pciDataSyncService } from '../services/pciDataSyncService'
import { mapDataService, getCellList, clearCellListCache } from '../services/mapDataService'
import { CoordinateTransformer } from '../utils/coordinate'
import type { RenderSectorData, CellListItem } from '../services/mapDataService'
import { triggerDataRefresh, DATA_REFRESH_EVENT } from '../store/dataStore'
import { useTranslation } from 'react-i18next'
import { CellSelectionTable } from '../components/CellSelectionTable'

// PCI表格列配置（静态版本，用于组件外部）
const PCI_COLUMNS_STATIC = [
  { key: 'networkType', label: '网元类型', defaultWidth: 80 },
  { key: 'siteId', label: '基站ID', defaultWidth: 100 },
  { key: 'cellId', label: '网元ID', defaultWidth: 80 },
  { key: 'sectorId', label: '小区ID', defaultWidth: 80 },
  { key: 'sectorName', label: '小区名称', defaultWidth: 150 },
  { key: 'frequency', label: '频点', defaultWidth: 60 },
  { key: 'originalPCI', label: '原PCI', defaultWidth: 60 },
  { key: 'newPCI', label: '新PCI', defaultWidth: 60 },
  { key: 'originalMod', label: '原模', defaultWidth: 50 },
  { key: 'newMod', label: '新模', defaultWidth: 50 },
  { key: 'tac', label: 'TAC规划值', defaultWidth: 80 },
  { key: 'assignmentReason', label: '分配原因', defaultWidth: 120 },
  { key: 'minReuseDistance', label: '复用距离', defaultWidth: 80 }
] as const

interface PCIResultData {
  taskId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  totalSites: number
  totalSectors: number
  collisions: number
  confusions: number
  results?: any[]
  startTime: string
  endTime?: string
}

const MAX_ERRORS = 5

// 计算两点之间的距离（Haversine公式，单位：米）
const calculateDistance = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const R = 6371000 // 地球半径（米）
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

// 配置验证函数（静态版本）
const validateConfigStatic = (config: any): string | null => {
  const maxPCI = config.networkType === 'LTE' ? 503 : 1007

  // 解析PCI范围字符串
  const pciRangeMatch = config.pciRange.match(/^(\d+)-(\d+)$/)
  if (!pciRangeMatch) {
    return `PCI范围格式错误，正确格式为：0-503（当前值：${config.pciRange}）`
  }

  const pciMin = parseInt(pciRangeMatch[1])
  const pciMax = parseInt(pciRangeMatch[2])

  // 验证PCI最小值
  if (pciMin < 0 || pciMin > maxPCI) {
    return `PCI最小值必须在0-${maxPCI}之间，当前值为${pciMin}`
  }

  // 验证PCI最大值
  if (pciMax < 0 || pciMax > maxPCI) {
    return `PCI最大值必须在0-${maxPCI}之间，当前值为${pciMax}`;
  }

  // 验证PCI范围逻辑
  if (pciMin >= pciMax) {
    return `PCI最小值(${pciMin})必须小于最大值(${pciMax})`
  }

  // 验证复用距离
  if (config.distanceThreshold < 0.1 || config.distanceThreshold > 50) {
    return `复用距离必须在0.1-50公里之间，当前值为${config.distanceThreshold}`
  }

  // 验证模数与网络类型匹配
  const expectedModulus = config.networkType === 'LTE' ? 3 : 30
  const pciModulus = config.networkType === 'LTE' ? 3 : 30
  if (pciModulus !== expectedModulus) {
    return `${config.networkType}网络模数必须为${expectedModulus}`
  }

  return null
}

// 动态翻译版本的验证函数
const validateConfig = (config: any, t: (key: string) => string): string | null => {
  const maxPCI = config.networkType === 'LTE' ? 503 : 1007

  // 解析PCI范围字符串
  const pciRangeMatch = config.pciRange.match(/^(\d+)-(\d+)$/)
  if (!pciRangeMatch) {
    return t('pci.pciRangeFormatError') || `PCI范围格式错误，正确格式为：0-503（当前值：${config.pciRange}）`
  }

  const pciMin = parseInt(pciRangeMatch[1])
  const pciMax = parseInt(pciRangeMatch[2])

  // 验证PCI最小值
  if (pciMin < 0 || pciMin > maxPCI) {
    return (t('pci.pciMinError') || `PCI最小值必须在0-${maxPCI}之间，当前值为${pciMin}`)
  }

  // 验证PCI最大值
  if (pciMax < 0 || pciMax > maxPCI) {
    return (t('pci.pciMaxError') || `PCI最大值必须在0-${maxPCI}之间，当前值为${pciMax}`)
  }

  // 验证PCI范围逻辑
  if (pciMin >= pciMax) {
    return (t('pci.pciRangeLogicError') || `PCI最小值(${pciMin})必须小于最大值(${pciMax})`)
  }

  // 验证复用距离
  if (config.distanceThreshold < 0.1 || config.distanceThreshold > 50) {
    return (t('pci.distanceRangeError') || `复用距离必须在0.1-50公里之间，当前值为${config.distanceThreshold}`)
  }

  // 验证模数与网络类型匹配
  const expectedModulus = config.networkType === 'LTE' ? 3 : 30
  const pciModulus = config.networkType === 'LTE' ? 3 : 30
  if (pciModulus !== expectedModulus) {
    return (t('pci.modulusError') || `${config.networkType}网络模数必须为${expectedModulus}`)
  }

  return null
}

export function PCIPage() {
  const { t } = useTranslation()
  const [config, setConfig] = useState({
    networkType: 'LTE',
    distanceThreshold: 10.0,
    inheritModulus: false,  // 新增：是否继承全量工参模数
    useMod3: true,          // LTE时可用
    useMod30: false,        // NR时可用
    pciRange: '0-503',      // PCI范围，格式：最小值-最大值
    enableTACPlanning: true // 新增：是否启用TAC规划，默认勾选
  })
  const {
    updateTaskProgress, completeTask, failTask, activeTaskIds, setActiveTaskId, startTask,
    getLatestPCITask
  } = useTaskStore()
  const taskId = activeTaskIds.pci_planning
  const latestPCITask = getLatestPCITask()

  const [localTaskResult, setLocalTaskResult] = useState<PCIResultData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isWhitelistEnabled, setIsWhitelistEnabled] = useState(false)
  const [isLegendVisible, setIsLegendVisible] = useState(true)
  
  // 应用到工参的状态
  const [applyingToParams, setApplyingToParams] = useState(false)
  const [applySuccess, setApplySuccess] = useState(false)

  // 选中的小区ID（用于行高亮）
  const [selectedSectorKey, setSelectedSectorKey] = useState<string | null>(null)

  // 搜索状态
  const [searchValue, setSearchValue] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchMarkers, setSearchMarkers] = useState<Array<{ id: string; name: string; lat: number; lng: number }>>([])
  const [measureMode, setMeasureMode] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const mapEverLoadedRef = useRef(false)

  // 规划结果搜索功能
  const [resultSearchEnabled, setResultSearchEnabled] = useState(false)
  const [resultSearchFilters, setResultSearchFilters] = useState({
    networkType: '',
    siteId: '',
    cellId: '',
    sectorId: '',
    sectorName: '',
    frequency: '',
    originalPCI: '',
    newPCI: '',
    originalMod: '',
    newMod: '',
    tac: '',
    assignmentReason: '',
    minReuseDistance: ''
  })
  const [filteredResults, setFilteredResults] = useState<any[]>([])

  // 左列页签状态：'cell-selection' | 'planning-result'
  const [activeLeftTab, setActiveLeftTab] = useState<'cell-selection' | 'planning-result'>('planning-result')
  // 选中的小区ID集合（格式：sector.id，如 siteId_sectorId）
  const [selectedCellIds, setSelectedCellIds] = useState<Set<string>>(new Set())
  // 小区列表数据（从轻量API获取）
  const [cellListData, setCellListData] = useState<{ lte: CellListItem[]; nr: CellListItem[] }>({ lte: [], nr: [] })
  const [cellListLoading, setCellListLoading] = useState(false)

  // 翻译后的表格列配置
  const PCI_COLUMNS = [
    { key: 'networkType', label: t('pci.networkType') || '网元类型', defaultWidth: 80 },
    { key: 'siteId', label: t('pci.siteId') || '基站ID', defaultWidth: 100 },
    { key: 'cellId', label: t('pci.cellId') || '网元ID', defaultWidth: 80 },
    { key: 'sectorId', label: t('pci.sectorId') || '小区ID', defaultWidth: 80 },
    { key: 'sectorName', label: t('pci.sectorName') || '小区名称', defaultWidth: 150 },
    { key: 'frequency', label: t('pci.frequency') || '频点', defaultWidth: 60 },
    { key: 'originalPCI', label: t('pci.originalPci') || '原PCI', defaultWidth: 60 },
    { key: 'newPCI', label: t('pci.newPci') || '新PCI', defaultWidth: 60 },
    { key: 'originalMod', label: t('pci.originalMod') || '原模', defaultWidth: 50 },
    { key: 'newMod', label: t('pci.newMod') || '新模', defaultWidth: 50 },
    { key: 'tac', label: t('pci.tacPlanned') || 'TAC规划值', defaultWidth: 80 },
    { key: 'assignmentReason', label: t('pci.assignmentReason') || '分配原因', defaultWidth: 120 },
    { key: 'minReuseDistance', label: t('pci.reuseDistance') || '复用距离', defaultWidth: 80 }
  ]

  // 列宽状态
  const [pciColumnWidths, setPciColumnWidths] = useState<Record<string, number>>(
    Object.fromEntries(PCI_COLUMNS_STATIC.map(col => [col.key, col.defaultWidth]))
  )

  // 列宽拖拽状态
  const [pciResizingColumn, setPciResizingColumn] = useState<string | null>(null)
  const pciResizingStartX = useRef<number>(0)
  const pciResizingStartWidth = useRef<number>(0)

  // 处理列宽拖拽开始
  const handlePciResizeStart = useCallback((columnKey: string, startX: number) => {
    setPciResizingColumn(columnKey)
    pciResizingStartX.current = startX
    pciResizingStartWidth.current = pciColumnWidths[columnKey]
    document.body.classList.add('resizing-column')
  }, [pciColumnWidths])

  // 处理列宽拖拽中
  const handlePciResizeMove = useCallback((clientX: number) => {
    if (pciResizingColumn) {
      const deltaX = clientX - pciResizingStartX.current
      const newWidth = Math.max(40, pciResizingStartWidth.current + deltaX)
      setPciColumnWidths(prev => ({
        ...prev,
        [pciResizingColumn]: newWidth
      }))
    }
  }, [pciResizingColumn])

  // 处理列宽拖拽结束
  const handlePciResizeEnd = useCallback(() => {
    setPciResizingColumn(null)
    document.body.classList.remove('resizing-column')
  }, [])

  // 全局鼠标事件监听
  useEffect(() => {
    if (pciResizingColumn) {
      const handleMouseMove = (e: MouseEvent) => {
        handlePciResizeMove(e.clientX)
      }
      const handleMouseUp = () => {
        handlePciResizeEnd()
      }
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      return () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [pciResizingColumn, handlePciResizeMove, handlePciResizeEnd])

  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const errorCountRef = useRef(0)

  // 地图组件ref
  const mapRef = useRef<OnlineMapRef>(null)

  // 确定当前显示的任务结果
  const currentTaskResult = localTaskResult || (latestPCITask?.result as PCIResultData | null)
  const isRunning = localTaskResult?.status === 'pending' || localTaskResult?.status === 'processing'

  // 组件挂载时，检查是否有最新的PCI规划结果
  useEffect(() => {
    if (latestPCITask && latestPCITask.result) {
      setLocalTaskResult(latestPCITask.result as PCIResultData)

      // 如果有规划结果，加载到同步服务
      if (latestPCITask.result.results) {
        pciDataSyncService.setPCIResults({ results: latestPCITask.result.results })
        console.log('[PCIPage] 从latestPCITask加载PCI结果到同步服务')
      }
    }
  }, [latestPCITask])

  // 初始化PCI数据同步服务
  useEffect(() => {
    let mounted = true

    const initSyncService = async () => {
      try {
        await pciDataSyncService.initialize()
        console.log('[PCIPage] PCI数据同步服务初始化完成')

        // 初始化完成后，如果有地图实例，刷新地图数据
        if (mapRef.current && mounted) {
          await mapRef.current.refreshData()
          console.log('[PCIPage] 地图数据已刷新')
        }
      } catch (error: any) {
        console.warn('[PCIPage] PCI数据同步服务初始化失败:', error?.message || error)
        // 如果没有全量工参，清除历史任务结果
        if (error?.message?.includes('未找到全量工参') || error?.message?.includes('全量工参')) {
          setLocalTaskResult(null)
          console.log('[PCIPage] 无全量工参，已清除历史任务结果')
        }
      }
    }

    initSyncService()

    // 监听数据刷新事件（当在其他页面上传新工参时）
    const handleDataRefresh = async () => {
      console.log('[PCIPage] 收到数据刷新事件，正在重新初始化...')
      try {
        // 清除地图数据和小区列表缓存
        mapDataService.clearCache()
        clearCellListCache()
        console.log('[PCIPage] 已清除地图数据和小区列表缓存')

        // 重新初始化PCI数据同步服务
        await initSyncService()
        console.log('[PCIPage] 数据同步服务已重新初始化')
      } catch (error) {
        console.warn('[PCIPage] 数据刷新失败:', error)
      }
    }

    window.addEventListener(DATA_REFRESH_EVENT, handleDataRefresh)

    return () => {
      mounted = false
      window.removeEventListener(DATA_REFRESH_EVENT, handleDataRefresh)
    }
  }, [])

  // 当规划结果完成时，刷新地图数据并清除白名单和选中状态
  // 使用ref跟踪是否已经处理过完成状态，避免重复清除选中状态
  const completionHandledRef = useRef(false)

  useEffect(() => {
    if (currentTaskResult?.status === 'completed' && currentTaskResult?.results && mapRef.current) {
      // 只在状态从非完成变为完成时处理，避免重复清除选中状态
      if (completionHandledRef.current) {
        return
      }
      completionHandledRef.current = true

      const map = mapRef.current
      const refreshMap = async () => {
        try {
          // 清除之前的白名单和高亮
          map.clearSectorIdWhitelist()
          map.clearPCIHighlight()
          setIsWhitelistEnabled(false)
          // 同时清除选中状态，保持UI状态一致
          setSelectedSectorKey(null)

          await map.refreshData()
          console.log('[PCIPage] 规划完成后刷新地图数据，已清除选中状态')
        } catch (error) {
          console.error('[PCIPage] 刷新地图数据失败:', error)
        }
      }
      refreshMap()
    } else if (currentTaskResult?.status !== 'completed') {
      // 重置处理标记，以便下次完成时可以再次处理
      completionHandledRef.current = false
    }
  }, [currentTaskResult?.status, currentTaskResult?.results])

  // 处理规划结果搜索过滤
  useEffect(() => {
    if (currentTaskResult?.status === 'completed' && currentTaskResult.results) {
      // 扁平化结果数据
      const flatResults: any[] = []
      const taskNetworkType = (currentTaskResult as any).networkType || 'LTE'
      currentTaskResult.results.forEach((site: any) => {
        site.sectors.forEach((sector: any) => {
          flatResults.push({
            ...sector,
            siteId: site.siteId,
            networkType: taskNetworkType,
            managedElementId: site.managedElementId,  // 从site级别传递管理网元ID
            siteName: site.siteName  // 从site级别传递站点名称
          })
        })
      })

      if (resultSearchEnabled) {
        const filtered = flatResults.filter(cell => {
          return (
            String(cell.networkType || '').toLowerCase().includes(resultSearchFilters.networkType.toLowerCase()) &&
            String(cell.siteId || '').toLowerCase().includes(resultSearchFilters.siteId.toLowerCase()) &&
            String(cell.managedElementId || '').toLowerCase().includes(resultSearchFilters.cellId.toLowerCase()) &&
            String(cell.sectorId || '').toLowerCase().includes(resultSearchFilters.sectorId.toLowerCase()) &&
            String(cell.sectorName || '').toLowerCase().includes(resultSearchFilters.sectorName.toLowerCase()) &&
            String(cell.frequency || cell.earfcn || cell.ssb_frequency || '').toLowerCase().includes(resultSearchFilters.frequency.toLowerCase()) &&
            String(cell.originalPCI ?? '').toLowerCase().includes(resultSearchFilters.originalPCI.toLowerCase()) &&
            String(cell.newPCI ?? '').toLowerCase().includes(resultSearchFilters.newPCI.toLowerCase()) &&
            String(cell.originalMod ?? '').toLowerCase().includes(resultSearchFilters.originalMod.toLowerCase()) &&
            String(cell.newMod ?? '').toLowerCase().includes(resultSearchFilters.newMod.toLowerCase()) &&
            String(cell.tac ?? '').toLowerCase().includes(resultSearchFilters.tac.toLowerCase()) &&
            String(cell.assignmentReason || '').toLowerCase().includes(resultSearchFilters.assignmentReason.toLowerCase()) &&
            String(cell.minReuseDistance ?? '').toLowerCase().includes(resultSearchFilters.minReuseDistance.toLowerCase())
          )
        })
        setFilteredResults(filtered)
      } else {
        setFilteredResults(flatResults)
      }
    }
  }, [currentTaskResult, resultSearchEnabled, resultSearchFilters])

  // 处理搜索输入变化
  const handleResultSearchChange = (field: string, value: string) => {
    setResultSearchFilters(prev => ({
      ...prev,
      [field]: value
    }))
  }

  // 轮询任务进度 - 统一管理轮询生命周期
  useEffect(() => {
    // 如果没有任务ID或任务已完成，不启动轮询
    if (!taskId || localTaskResult?.status === 'completed' || localTaskResult?.status === 'failed') {
      return
    }

    // 避免重复启动轮询
    if (pollingIntervalRef.current) {
      return
    }

    // 每1秒轮询一次任务进度
    pollingIntervalRef.current = setInterval(async () => {
      // 检查任务是否已完成
      if (localTaskResult?.status === 'completed' || localTaskResult?.status === 'failed') {
        stopPolling()
        return
      }

      try {
        const response: ApiResponse<any> = await pciApi.getProgress(taskId)
        errorCountRef.current = 0

        if (response.success && response.data) {
          const data = response.data
          const updatedResult = {
            ...data,
            startTime: data.created_at || localTaskResult?.startTime || new Date().toISOString()
          }
          setLocalTaskResult(updatedResult)

          // 更新全局任务状态
          updateTaskProgress(taskId, data.progress, data.status)

          if (data.status === 'completed') {
            stopPolling()
            setTimeout(async () => {
              try {
                const resultResponse: ApiResponse<any> = await pciApi.getResult(taskId)
                if (resultResponse.success && resultResponse.data) {
                  setLocalTaskResult(resultResponse.data)
                  // 将完成的任务结果保存到全局状态
                  completeTask(taskId, resultResponse.data)

                  // 将PCI规划结果加载到同步服务
                  if (resultResponse.data.results) {
                    pciDataSyncService.setPCIResults({ results: resultResponse.data.results })
                    console.log('[PCIPage] PCI规划结果已加载到同步服务')
                  }
                } else {
                  setError(resultResponse.message || (t('pci.getResultFailed') || '获取规划结果失败'))
                  failTask(taskId, resultResponse.message || '获取规划结果失败')
                }
              } catch (err: any) {
                const errorMsg = (t('pci.getResultFailed') || '获取规划结果失败: ') + (err.message || err.toString?.() || '未知错误')
                setError(errorMsg)
                failTask(taskId, errorMsg)
              }
            }, 100)
          } else if (data.status === 'failed') {
            stopPolling()
            const errorMsg = data.message || data.error || (t('pci.planFailed') || '规划任务失败')
            setError(errorMsg)
            failTask(taskId, errorMsg)
          }
        } else {
          setError(response.message || (t('pci.getProgressFailed') || '获取进度失败'))
        }
      } catch (err: any) {
        console.error('Failed to get progress:', err)

        if (err?.code === 404) {
          stopPolling()
          console.log('[PCIPage] Task not found (404), clearing invalid taskId:', taskId)
          useTaskStore.getState().setActiveTaskId('pci_planning', null)
          setLocalTaskResult(null)
          setError(null)
          return
        }

        errorCountRef.current++

        if (errorCountRef.current >= MAX_ERRORS) {
          stopPolling()
          const errorMsg = t('pci.connectionError') || '无法连接到服务器，请检查网络连接或后端服务状态'
          setError(errorMsg)
          failTask(taskId, errorMsg)
        } else {
          setError((t('pci.getProgressRetrying') || `获取进度失败 (${errorCountRef.current}/${MAX_ERRORS})，正在重试...`))
        }
      }
    }, 1000)

    // 统一的停止轮询函数
    function stopPolling() {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
    }

    // 组件卸载或依赖变化时清理
    return () => {
      stopPolling()
    }
  }, [taskId, localTaskResult?.status, updateTaskProgress, completeTask, failTask])

  const handleRunPCI = async () => {
    // **新增**: 前端验证配置参数
    const validationError = validateConfig(config, t)
    if (validationError) {
      setError(validationError)
      return
    }

    setError(null)
    setLocalTaskResult(null)
    setLoading(true)
    errorCountRef.current = 0

    // 确定PCI模数
    const pciModulus = config.networkType === 'LTE' ? 3 : 30

    // 解析PCI范围字符串
    const pciRangeMatch = config.pciRange.match(/^(\d+)-(\d+)$/)
    if (!pciRangeMatch) {
      setError(t('pci.pciRangeFormatError') || `PCI范围格式错误，正确格式为：0-503（当前值：${config.pciRange}）`)
      setLoading(false)
      return
    }

    const pciMin = parseInt(pciRangeMatch[1])
    const pciMax = parseInt(pciRangeMatch[2])

    try {
      const response: ApiResponse<{ taskId: string; message: string }> = await pciApi.plan({
        networkType: config.networkType as 'LTE' | 'NR',
        distanceThreshold: config.distanceThreshold,
        pciModulus: pciModulus,
        inheritModulus: config.inheritModulus,
        pciRange: {
          min: pciMin,
          max: pciMax
        },
        enableTACPlanning: config.enableTACPlanning,
        selectedCellIds: selectedCellIds.size > 0 ? Array.from(selectedCellIds) : undefined
      })

      if (response.success && response.data) {
        const newTaskId = response.data.taskId
        setActiveTaskId('pci_planning', newTaskId)

        const initialResult = {
          taskId: newTaskId,
          status: 'pending' as const,
          progress: 0,
          totalSites: 0,
          totalSectors: 0,
          collisions: 0,
          confusions: 0,
          startTime: new Date().toISOString()
        }

        setLocalTaskResult(initialResult)
        // 在全局任务状态中开始新任务
        startTask(newTaskId, 'pci_planning', 'PCI规划开始')
      } else {
        setError(response.message || (t('pci.startPlanFailed') || '启动规划任务失败'))
      }
    } catch (err: any) {
      setError(err.message || (t('pci.startPlanFailed') || '启动规划任务失败'))
    } finally {
      setLoading(false)
    }
  }

  const handleExport = async () => {
    const exportTaskId = taskId || currentTaskResult?.taskId
    if (!exportTaskId) return

    try {
      const blob = await pciApi.export(exportTaskId, 'xlsx')
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url

      // 生成带网络类型、复用距离和时间戳的文件名
      const now = new Date()
      const timestamp = now.toISOString().slice(0, 10).replace(/-/g, '') + '_' + now.toTimeString().slice(0, 5).replace(/:/g, '')

      // 优先从任务结果中获取网络类型和阈值，解决文件名随界面选择变化的问题
      const taskNetworkType = (currentTaskResult as any)?.networkType || config.networkType
      const taskDistance = (currentTaskResult as any)?.distanceThreshold || config.distanceThreshold

      a.download = `pci_result_${taskNetworkType}_${taskDistance}km_${timestamp}.xlsx`

      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
    } catch (err: any) {
      setError((t('pci.exportFailed') || '导出失败: ') + (err.message || '未知错误'))
    }
  }

  const handleApplyToParams = async () => {
    const applyTaskId = taskId || currentTaskResult?.taskId
    if (!applyTaskId) return

    try {
      setError(null)
      setApplyingToParams(true)
      setApplySuccess(false)
      
      const response = await pciApi.applyToParams(applyTaskId)

      if (response.success && response.data) {
        const { updatedCount, newFileId, newFileName, savedToOriginal } = response.data

        // 触发数据刷新事件，通知其他页面（如数据管理页面）更新数据列表
        triggerDataRefresh()
        console.log('[PCIPage] 已触发数据刷新事件')

        // 显示成功状态
        setApplySuccess(true)

        // 显示成功消息
        let successMsg = `✅ ${t('pci.applySuccess') || '成功将PCI规划结果应用到工参，更新了'}${updatedCount}${t('pci.cells') || '个小区的PCI'}`
        if (newFileName) {
          successMsg += `\n📄 ${t('pci.newFile') || '新工参文件'}: ${newFileName}`
        }
        if (savedToOriginal) {
          successMsg += `\n📁 ${t('pci.savedCopy') || '已保存副本到原始目录'}`
        }
        setError(successMsg)
        console.log('[PCIPage] 应用到工参成功:', response.data)

        // 1. 清除mapDataService缓存，确保重新加载最新数据
        mapDataService.clearCache()
        console.log('[PCIPage] 已清除地图数据缓存')

        // 2. 重新获取数据列表，更新数据索引（强制刷新，绕过缓存）
        try {
          const listResponse = await dataApi.list(1, 50, true)  // cacheBust=true 强制刷新
          if (listResponse.success) {
            console.log('[PCIPage] 已重新获取数据列表（强制刷新），新工参ID:', newFileId)
          }
        } catch (listErr) {
          console.warn('[PCIPage] 重新获取数据列表失败:', listErr)
        }

        // 3. 重新初始化同步服务，获取最新的全量工参数据
        await pciDataSyncService.initialize()
        console.log('[PCIPage] 重新初始化PCI数据同步服务，获取最新全量工参数据')

        // 4. 重新设置PCI规划结果到同步服务（initialize会清除映射表，需要重新加载）
        // 注意：规划结果中的originalPCI保持不变
        if (currentTaskResult?.results) {
          pciDataSyncService.setPCIResults({ results: currentTaskResult.results })
          console.log('[PCIPage] 重新设置PCI规划结果到同步服务（原PCI保持不变）')
        }

        // 5. 强制刷新地图数据，确保扇区图层使用最新PCI值
        if (mapRef.current) {
          console.log('[PCIPage] 刷新地图数据，更新扇区图层PCI显示')
          await mapRef.current.refreshData()
        }

        // 5秒后清除成功消息和状态
        setTimeout(() => {
          setError(null)
          setApplySuccess(false)
        }, 5000)
      } else {
        const errorMsg = `❌ ${t('pci.applyFailed') || '应用到工参失败'}: ` + (response.message || '未知错误')
        setError(errorMsg)
        console.error('[PCIPage] 应用到工参失败:', errorMsg)
      }
    } catch (err: any) {
      const errorMsg = `❌ ${t('pci.applyFailed') || '应用到工参失败'}: ` + (err.message || '未知错误')
      setError(errorMsg)
      console.error('[PCIPage] 应用到工参异常:', err)
    } finally {
      setApplyingToParams(false)
      setLoading(false)
    }
  }

  // 处理结果列表点击
  const handleResultRowClick = async (siteId: string, sectorId: string, newPCI: number, frequency: number | null) => {
    if (!currentTaskResult?.results) return

    // 更新选中状态（用于行高亮）
    const normalizedSiteId = String(siteId).trim()
    const normalizedSectorId = String(sectorId).trim()
    const sectorKey = `${normalizedSiteId}-${normalizedSectorId}`

    const taskNetworkType = (currentTaskResult as any).networkType || 'LTE'
    console.log('[PCIPage] 开始处理结果行点击', { 
      siteId, 
      sectorId, 
      newPCI, 
      frequency,
      taskNetworkType 
    })

    setSelectedSectorKey(sectorKey)

    // 同步PCI到全量工参
    pciDataSyncService.syncSectorPCI(siteId, sectorId, newPCI)

    // 查找同步后的扇区，验证是否找到
    const syncedSector = pciDataSyncService.findSector(siteId, sectorId)
    console.log('[PCIPage] 查找同步后的扇区', {
      found: !!syncedSector,
      sectorId: syncedSector?.id,
      sectorName: syncedSector?.name,
      syncedPCI: syncedSector?.syncedPCI,
      inputSiteId: siteId,
      inputSectorId: sectorId,
      actualSiteId: syncedSector?.siteId,
      actualSectorId: syncedSector?.sectorId,
      displayLat: syncedSector?.displayLat,
      displayLng: syncedSector?.displayLng
    })

    if (!syncedSector) {
      console.error('[PCIPage] 未找到同步后的扇区，无法高亮显示')
      return
    }

    // 获取同步后的扇区的PCI和频点（规划后已更新到全量工参的数据）
    const syncedPCI = syncedSector.syncedPCI ?? newPCI
    const syncedFrequency = syncedSector.frequency || syncedSector.earfcn || syncedSector.ssbFrequency || frequency

    // 查找同频同PCI扇区（按网络类型过滤，使用同步后的PCI和频点）
    const samePCISectors = pciDataSyncService.findSameFrequencyPCI(syncedPCI, syncedFrequency, siteId, sectorId, taskNetworkType)
    
    // 直接从扇区的latitude/longitude获取坐标（WGS84）并转换为GCJ02
    const getSectorCoords = (sector: any): [number, number] | null => {
      // 尝试多种坐标字段组合
      const lat = sector.latitude ?? sector.lat ?? sector.displayLat
      const lng = sector.longitude ?? sector.lng ?? sector.displayLng
      
      if (lat != null && lng != null) {
        // 如果是displayLat/displayLng，说明已经是GCJ02坐标，无需转换
        if (sector.displayLat != null && sector.displayLng != null && lat === sector.displayLat && lng === sector.displayLng) {
          return [lat, lng]
        }
        // 否则需要转换
        return CoordinateTransformer.wgs84ToGcj02(lat, lng)
      }
      return null
    }

    const selectedCoords = getSectorCoords(syncedSector)
    console.log('[PCIPage] 选中扇区完整信息', {
      name: syncedSector.name,
      networkType: syncedSector.networkType,
      latitude: syncedSector.latitude,
      longitude: syncedSector.longitude,
      displayLat: syncedSector.displayLat,
      displayLng: syncedSector.displayLng,
      coords: selectedCoords,
      allKeys: Object.keys(syncedSector)
    })
    console.log('[PCIPage] 查找到同频同PCI扇区', {
      count: samePCISectors.length,
      sectors: samePCISectors.map(s => ({
        id: s.id,
        name: s.name,
        networkType: s.networkType,
        latitude: s.latitude,
        longitude: s.longitude,
        displayLat: s.displayLat,
        displayLng: s.displayLng,
        coords: getSectorCoords(s),
        allKeys: Object.keys(s)
      }))
    })

    // 找出最近的同频同PCI小区（用于地图视窗定位）
    let nearestSamePCISector: any = null
    if (samePCISectors.length > 0 && selectedCoords) {
      // 计算每个同频同PCI扇区与选中扇区的距离
      const sectorsWithDistance = samePCISectors.map(s => {
        const sCoords = getSectorCoords(s)
        return {
          sector: s,
          coords: sCoords,
          distance: sCoords 
            ? calculateDistance(selectedCoords[0], selectedCoords[1], sCoords[0], sCoords[1])
            : Infinity
        }
      })
      
      console.log('[PCIPage] 同频同PCI扇区距离计算', sectorsWithDistance.map(s => ({
        name: s.sector.name,
        distance: s.distance,
        coords: s.coords
      })))
      
      // 按距离排序
      sectorsWithDistance.sort((a, b) => a.distance - b.distance)
      
      // 取最近的一个有有效坐标的扇区
      const nearest = sectorsWithDistance.find(s => s.coords != null)
      nearestSamePCISector = nearest?.sector || null
      console.log('[PCIPage] 最近同频同PCI扇区', {
        name: nearestSamePCISector?.name,
        distance: nearest?.distance
      })
    }

    // 使用syncedSector的实际id而不是构造的ID
    const selectedSectorId = syncedSector.id
    const relatedIds = samePCISectors
      .filter(s => s.id !== selectedSectorId)
      .map(s => s.id)

    console.log('[PCIPage] 准备高亮', {
      selectedId: selectedSectorId,
      selectedSectorActualId: syncedSector.id,
      relatedCount: relatedIds.length,
      firstFewRelatedIds: relatedIds.slice(0, 5),
      samePCISectorsFirst: samePCISectors.slice(0, 3).map(s => ({ id: s.id, name: s.name, sectorId: s.sectorId }))
    })

    // 构建白名单：渲染选中的扇区和所有同频同PCI的扇区
    const whitelist = new Set<string>([selectedSectorId, ...relatedIds])
    
    // 获取所有同步数据的ID用于验证
    const syncedData = pciDataSyncService.getSyncedData()
    const allSyncedIds = syncedData ? 
      [...syncedData.lte, ...syncedData.nr].map(s => s.id) : []
    
    // 验证白名单中的ID是否在同步数据中存在
    const missingIds = Array.from(whitelist).filter(id => !allSyncedIds.includes(id))
    
    console.log('[PCIPage] 设置扇区白名单 - 详细验证', {
      count: whitelist.size,
      selectedId: selectedSectorId,
      selectedIdInSyncedData: allSyncedIds.includes(selectedSectorId),
      relatedIds: relatedIds,
      relatedIdsInSyncedData: relatedIds.map(id => ({
        id,
        exists: allSyncedIds.includes(id)
      })),
      allIds: Array.from(whitelist),
      totalSyncedIds: allSyncedIds.length,
      missingIds: missingIds,
      whitelistSample: Array.from(whitelist).slice(0, 10),
      syncedDataSample: allSyncedIds.slice(0, 10)
    })

    // 先设置高亮配置（在图层重建前设置，SectorRenderer会在渲染完成后自动应用）
    mapRef.current?.setPCIHighlightMode({
      selectedId: selectedSectorId,
      relatedIds: relatedIds
    })

    // 然后设置白名单（这会触发加载同步数据和图层重建，只加载规划网络类型的扇区）
    // 图层重建完成后会自动应用之前设置的高亮配置
    mapRef.current?.setSectorIdWhitelist(whitelist, 'pci-planning', taskNetworkType)
    setIsWhitelistEnabled(true)

    // 收集地图视窗聚焦的经纬度坐标（只包含选中扇区和最近同频同PCI扇区）
    const latLngs: Array<[number, number]> = []
    
    // 添加选中扇区
    if (selectedCoords) {
      latLngs.push(selectedCoords)
    }
    
    // 添加最近的同频同PCI扇区（用于地图视窗定位）
    if (nearestSamePCISector) {
      const nearestCoords = getSectorCoords(nearestSamePCISector)
      if (nearestCoords) {
        latLngs.push(nearestCoords)
      }
    }
    
    console.log('[PCIPage] 准备地图缩放', {
      latLngs,
      latLngCount: latLngs.length,
      selectedCoords,
      nearestSamePCISector: nearestSamePCISector?.name
    })
    
    // 使用fitBounds自动调整地图视窗，只聚焦显示选中扇区和最近同频同PCI扇区
    // 延迟调用，确保图层重建后再执行缩放
    setTimeout(() => {
      console.log('[PCIPage] 执行地图缩放延迟调用')
      if (latLngs.length > 0 && mapRef.current) {
        if (latLngs.length === 1) {
          // 如果只有一个点，使用固定zoom
          console.log('[PCIPage] 调用 flyTo', { latLng: latLngs[0], zoom: 16 })
          mapRef.current.flyTo(latLngs[0], 16)
        } else {
          // 多个点时，使用fitBounds自动调整
          console.log('[PCIPage] 调用 fitBounds', { latLngs })
          mapRef.current.fitBounds(latLngs, [80, 80])
        }
      }
    }, 500)

    console.log('[PCIPage] 结果行点击处理完成', { 
      siteId, 
      sectorId, 
      newPCI, 
      relatedCount: relatedIds.length, 
      latLngCount: latLngs.length,
      totalSamePCISectors: samePCISectors.length,
      nearestSector: nearestSamePCISector?.name
    })
  }

  // 处理显示全部扇区
  const handleShowAll = () => {
    console.log('[PCIPage] 显示全部扇区')
    setSelectedSectorKey(null)  // 清除选中状态
    mapRef.current?.clearSectorIdWhitelist()
    mapRef.current?.clearPCIHighlight()
    mapRef.current?.setSectorLabelVisibility('lte', false)
    mapRef.current?.setSectorLabelVisibility('nr', false)
    setIsWhitelistEnabled(false)
  }

  // 处理小区搜索
  const handleSearch = async () => {
    if (!searchValue.trim()) {
      setSearchError(t('pci.inputSearchHint') || '请输入小区名称或基站ID-小区ID')
      return
    }

    setSearchError(null)
    const trimmedSearch = searchValue.trim()
    console.log('[PCIPage] 开始搜索小区', trimmedSearch)

    try {
      let foundSector: RenderSectorData | null = null
      let siteId: string = ''
      let sectorId: string = ''

      // 尝试解析"基站ID-小区ID"格式
      if (trimmedSearch.includes('-')) {
        const parts = trimmedSearch.split('-')
        if (parts.length === 2) {
          siteId = parts[0].trim()
          sectorId = parts[1].trim()
          foundSector = pciDataSyncService.findSector(siteId, sectorId)
          console.log('[PCIPage] 按ID搜索', { siteId, sectorId, found: !!foundSector })
        }
      }

      // 如果按ID没找到，尝试按小区名称搜索
      if (!foundSector) {
        const syncedData = pciDataSyncService.getSyncedData()
        if (syncedData) {
          const allSectors = [...syncedData.lte, ...syncedData.nr]
          foundSector = allSectors.find(s => s.name === trimmedSearch) || null
          if (foundSector) {
            siteId = foundSector.siteId || ''
            sectorId = foundSector.sectorId || ''
            console.log('[PCIPage] 按名称搜索', {
              name: trimmedSearch,
              siteId,
              sectorId,
              found: true
            })
          }
        }
      }

      if (!foundSector) {
        setSearchError((t('pci.sectorNotFound') || `未找到小区: ${trimmedSearch}`))
        return
      }

      console.log('[PCIPage] 找到小区', {
        id: foundSector.id,
        name: foundSector.name,
        lat: foundSector.displayLat,
        lng: foundSector.displayLng
      })

      // 飞至该扇区位置并添加搜索标记
      if (foundSector.displayLat && foundSector.displayLng) {
        mapRef.current?.flyTo([foundSector.displayLat, foundSector.displayLng], 16)

        // 添加搜索标记
        const newMarker = {
          id: foundSector.id,
          name: foundSector.name || `${foundSector.siteId}-${foundSector.sectorId}`,
          lat: foundSector.displayLat,
          lng: foundSector.displayLng
        }

        // 检查是否已存在相同标记
        const markerExists = searchMarkers.some(m => m.id === newMarker.id)
        if (!markerExists) {
          const updatedMarkers = [...searchMarkers, newMarker]
          setSearchMarkers(updatedMarkers)
          // 添加标记到地图（使用当前标记数作为索引）
          mapRef.current?.addLocationMarker({
            id: newMarker.id,
            lat: newMarker.lat,
            lng: newMarker.lng,
            name: newMarker.name
          }, updatedMarkers.length)
        }

        console.log('[PCIPage] 搜索完成', {
          markerAdded: !markerExists,
          totalMarkers: searchMarkers.length + (!markerExists ? 1 : 0)
        })
      } else {
        setSearchError(t('pci.sectorNoCoords') || '小区缺少经纬度信息，无法定位')
      }
    } catch (err) {
      console.error('[PCIPage] 搜索失败', err)
      setSearchError(t('pci.searchFailed') || '搜索失败，请重试')
    }
  }

  // 清除搜索
  const handleClearSearch = () => {
    setSearchValue('')
    setSearchError(null)
    handleShowAll()
    // 清除搜索定位标记
    setSearchMarkers([])
    mapRef.current?.clearLocationMarkers()
  }

  // 清除所有搜索标记
  const handleClearMarkers = () => {
    setSearchMarkers([])
    mapRef.current?.clearLocationMarkers()
    console.log('[PCIPage] 已清除所有搜索标记')
  }

  // 清除所有标记（定位标记 + 测距标记）
  const handleClearAllMarkers = () => {
    // 清除搜索定位标记
    setSearchMarkers([])
    mapRef.current?.clearLocationMarkers()
    // 清除测距标记并退出测距模式
    mapRef.current?.clearMeasurements()
    mapRef.current?.setMeasureMode(false)
    setMeasureMode(false)
    console.log('[PCIPage] 已清除所有标记（定位 + 测距）')
  }

  // 切换测距模式
  const handleToggleMeasure = () => {
    const newMode = !measureMode
    setMeasureMode(newMode)
    if (mapRef.current) {
      mapRef.current.setMeasureMode(newMode)
    }
  }

  // 测距模式结束回调
  const handleMeasureModeEnd = () => {
    setMeasureMode(false)
  }

  // 处理地图扇区点击 - 实现PCI高亮
  const handleMapSectorClick = (sector: RenderSectorData) => {
    console.log('[PCIPage] 地图扇区点击', {
      id: sector.id,
      name: sector.name,
      siteId: sector.siteId,
      pci: sector.pci,
      earfcn: sector.earfcn,
      arfcn: sector.arfcn
    })

    // 确保有当前任务结果
    if (!currentTaskResult?.results) {
      console.warn('[PCIPage] 没有当前任务结果，无法进行PCI高亮')
      return
    }

    // 获取任务网络类型
    const taskNetworkType = (currentTaskResult as any).networkType || 'LTE'

    // 获取同步数据，直接在其中查找匹配的扇区
    const syncedData = pciDataSyncService.getSyncedData()
    if (!syncedData) {
      console.warn('[PCIPage] PCI数据同步服务未初始化')
      return
    }

    // 在同步数据中查找当前扇区（通过id匹配）
    const allSyncedSectors = [...syncedData.lte, ...syncedData.nr]
    let syncedSector = allSyncedSectors.find(s => s.id === sector.id)

    // 如果没找到，尝试通过siteId和name匹配
    if (!syncedSector) {
      syncedSector = allSyncedSectors.find(s =>
        s.siteId === sector.siteId && s.name === sector.name
      )
    }

    if (!syncedSector) {
      console.warn('[PCIPage] 未找到同步后的扇区数据', {
        sectorId: sector.id,
        siteId: sector.siteId,
        name: sector.name,
        totalSynced: allSyncedSectors.length,
        sampleIds: allSyncedSectors.slice(0, 5).map(s => s.id)
      })
      return
    }

    // 获取PCI值（优先使用同步后的PCI，即规划后的新PCI）
    const pci = (syncedSector as any).syncedPCI || syncedSector.pci || sector.pci
    if (pci === undefined || pci === null) {
      console.warn('[PCIPage] 扇区没有PCI值', {
        syncedPCI: (syncedSector as any).syncedPCI,
        syncedPci: syncedSector.pci,
        sectorPci: sector.pci
      })
      return
    }

    // 获取频点（优先使用同步后的扇区数据）
    const frequency = (syncedSector as any).frequency || (syncedSector as any).earfcn || (syncedSector as any).ssbFrequency || sector.earfcn || sector.arfcn || null

    console.log('[PCIPage] 找到匹配的同步扇区，准备进行PCI高亮', {
      syncedId: syncedSector.id,
      syncedName: syncedSector.name,
      pci,
      frequency,
      syncedPCI: (syncedSector as any).syncedPCI
    })

    // 查找同频同PCI的扇区
    const samePCISectors = pciDataSyncService.findSameFrequencyPCI(
      pci,
      frequency,
      syncedSector.siteId,
      (syncedSector as any).sectorId || syncedSector.id.split('_').pop(),
      taskNetworkType
    )

    console.log('[PCIPage] 查找到同频同PCI扇区', {
      count: samePCISectors.length,
      sectors: samePCISectors.map(s => ({ id: s.id, name: s.name, pci: s.pci }))
    })

    // 构建白名单和高亮配置
    const selectedSectorId = syncedSector.id
    const relatedIds = samePCISectors
      .filter(s => s.id !== selectedSectorId)
      .map(s => s.id)
    const whitelist = new Set<string>([selectedSectorId, ...relatedIds])

    console.log('[PCIPage] 设置PCI高亮', {
      selectedId: selectedSectorId,
      relatedCount: relatedIds.length,
      whitelistSize: whitelist.size,
      whitelistIds: Array.from(whitelist).slice(0, 10)
    })

    // 先设置高亮配置
    mapRef.current?.setPCIHighlightMode({
      selectedId: selectedSectorId,
      relatedIds: relatedIds
    })

    // 设置白名单（只加载规划网络类型的扇区）
    mapRef.current?.setSectorIdWhitelist(whitelist, 'pci-planning', taskNetworkType)
    setIsWhitelistEnabled(true)
  }

  // 加载小区列表数据（根据当前的网络类型）
  const loadCellList = useCallback(async () => {
    setCellListLoading(true)
    try {
      const data = await getCellList()
      setCellListData({
        lte: data.lte || [],
        nr: data.nr || []
      })
    } catch (err) {
      console.error('[PCIPage] 加载小区列表失败:', err)
    } finally {
      setCellListLoading(false)
    }
  }, [])

  // 初始加载小区列表
  useEffect(() => {
    loadCellList()
  }, [loadCellList])

  // 切换单个小区选中状态
  const toggleCellSelection = (cellId: string) => {
    setSelectedCellIds(prev => {
      const next = new Set(prev)
      if (next.has(cellId)) {
        next.delete(cellId)
      } else {
        next.add(cellId)
      }
      return next
    })
  }

  // 全选/取消全选当前网络类型的小区
  const toggleSelectAll = () => {
    const networkType = config.networkType as 'LTE' | 'NR'
    const sectors = networkType === 'LTE' ? cellListData.lte : cellListData.nr
    const allIds = sectors.map(s => s.id)
    const allSelected = allIds.length > 0 && allIds.every(id => selectedCellIds.has(id))
    if (allSelected) {
      // 取消全选
      setSelectedCellIds(prev => {
        const next = new Set(prev)
        allIds.forEach(id => next.delete(id))
        return next
      })
    } else {
      // 全选
      setSelectedCellIds(prev => {
        const next = new Set(prev)
        allIds.forEach(id => next.add(id))
        return next
      })
    }
  }

  // 清空所有选中
  const clearSelections = () => {
    setSelectedCellIds(new Set())
  }

  return (
    <div className="h-full flex flex-col p-4 min-h-0">
      <h1 className="text-3xl font-bold mb-6 shrink-0">{t('pci.title') || 'PCI规划'}</h1>

      {/* 错误提示 */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3 text-red-700 shrink-0">
          <AlertCircle size={18} />
          <span className="text-sm">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-sm underline">{t('pci.close') || '关闭'}</button>
        </div>
      )}

      {/* 两列布局：左侧参数+结果，右侧地图 */}
      <div className="flex flex-row gap-1 min-h-0 flex-1 overflow-hidden">
        {/* 左列：规划参数 + 规划结果 */}
        <div className="flex flex-col gap-1 min-h-0 overflow-hidden flex-1 min-w-0">
          {/* 规划参数面板 - 单行布局 */}
          <div className="bg-card p-3 rounded-lg border border-border">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-base font-semibold">{t('pci.planningParams') || '规划参数'}</h2>
            </div>

            <div className="grid grid-cols-6 gap-x-3 gap-y-1 items-center">
              {/* 网络类型 */}
              <ConfigSelect
                label={t('pci.networkType') || '网络类型'}
                value={config.networkType}
                options={['LTE', 'NR']}
                onChange={(value) => {
                  setSelectedCellIds(new Set())
                  setConfig({
                    ...config,
                    networkType: value,
                    useMod3: value === 'LTE',
                    useMod30: value === 'NR',
                    pciRange: value === 'LTE' ? '0-503' : '0-1007'
                  })
                  loadCellList()
                }}
                disabled={isRunning}
              />

              {/* 复用距离 */}
              <ConfigInput
                label={t('pci.distanceLabel') || '复用距离(km)'}
                type="number"
                value={config.distanceThreshold}
                onChange={(value) =>
                  setConfig({
                    ...config,
                    distanceThreshold: parseFloat(value) || 0
                  })
                }
                disabled={isRunning}
                min={0.1}
                max={50}
                step={0.1}
              />

              {/* PCI范围 */}
              <ConfigInput
                label={t('pci.pciRange') || 'PCI范围'}
                type="text"
                value={config.pciRange}
                onChange={(value) => {
                  // 当用户修改时，直接更新值
                  setConfig({
                    ...config,
                    pciRange: value
                  })
                }}
                disabled={isRunning}
                placeholder="0-503"
              />

              {/* 继承模数 */}
              <div className="flex items-center gap-2 h-[30px]">
                <input
                  type="checkbox"
                  id="inheritModulus"
                  checked={config.inheritModulus}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      inheritModulus: e.target.checked
                    })
                  }
                  className="w-3.5 h-3.5"
                  disabled={isRunning}
                />
                <label htmlFor="inheritModulus" className="text-xs cursor-pointer">
                  {t('pci.inheritMod') || `继承模${config.networkType === 'LTE' ? '3' : '30'}`}
                </label>
              </div>

              {/* TAC规划 */}
              <div className="flex items-center gap-2 h-[30px]">
                <input
                  type="checkbox"
                  id="enableTACPlanning"
                  checked={config.enableTACPlanning}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      enableTACPlanning: e.target.checked
                    })
                  }
                  className="w-3.5 h-3.5"
                  disabled={isRunning}
                />
                <label htmlFor="enableTACPlanning" className="text-xs cursor-pointer">
                  {t('pci.enableTac') || 'TAC规划'}
                </label>
              </div>

              {/* 开始规划按钮 */}
              <button
                onClick={handleRunPCI}
                disabled={loading || isRunning || validateConfig(config, t) !== null}
                className="flex items-center gap-2 px-4 py-2 bg-blue-400 text-white rounded hover:bg-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed text-sm"
              >
                <Play size={16} />
                {t('pci.startPlan') || '开始规划'}
              </button>
            </div>

            {/* 验证错误提示 */}
            {(config.distanceThreshold < 0.1 || config.distanceThreshold > 50) && (
              <div className="mt-2 text-xs text-orange-600">
                {t('pci.distanceRangeError') || '复用距离必须在0.1-50公里之间'}
              </div>
            )}
            {(() => {
              const error = validateConfig(config, t)
              if (error && error.includes('PCI')) {
                return <div className="mt-2 text-xs text-orange-600">{error}</div>
              }
              return null
            })()}
          </div>

          {/* 小区选择与结果面板（页签切换） */}
          <div className="bg-card p-3 rounded-lg border border-border flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* 页签切换栏 */}
            <div className="flex items-center gap-1 mb-3 border-b border-border shrink-0">
              <button
                onClick={() => setActiveLeftTab('cell-selection')}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                  activeLeftTab === 'cell-selection'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('pci.cellSelection') || '小区选择'}
                {selectedCellIds.size > 0 && (
                  <span className="ml-2 px-1.5 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full">
                    {selectedCellIds.size}
                  </span>
                )}
              </button>
              <button
                onClick={() => setActiveLeftTab('planning-result')}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                  activeLeftTab === 'planning-result'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('pci.planningResult') || '规划结果'}
                {currentTaskResult?.status === 'completed' && (
                  <span className="ml-2 px-1.5 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">✓</span>
                )}
                {currentTaskResult?.status === 'failed' && (
                  <span className="ml-2 inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold">!</span>
                )}
              </button>
            </div>

            {/* 页签内容 */}
            <div className="flex-1 min-h-0 overflow-hidden">
              {activeLeftTab === 'cell-selection' ? (
                /* 小区选择面板 */
                <div className="flex flex-col h-full overflow-hidden">
                  <CellSelectionTable
                    sectors={(() => {
                      const networkType = config.networkType as 'LTE' | 'NR'
                      return networkType === 'LTE' ? cellListData.lte : cellListData.nr
                    })()}
                    selectedCellIds={selectedCellIds}
                    onToggleCell={toggleCellSelection}
                    onSelectAll={toggleSelectAll}
                    onClearSelections={clearSelections}
                    selectedCountText={(t('pci.selectedCount') || '已选中 {{count}} 个小区').replace('{{count}}', String(selectedCellIds.size))}
                    dataSourceText={(t('pci.cellListSource') || '数据源：{{type}} 小区').replace('{{type}}', config.networkType)}
                    searchPlaceholder={t('pci.cellSearchPlaceholder') || '搜索基站ID、小区ID或名称...'}
                    loading={cellListLoading}
                    columnLabels={{
                      siteId: t('pci.siteId') || '基站ID',
                      cellId: t('pci.sectorId') || '小区ID',
                      cellName: t('pci.sectorName') || '小区名称',
                      selectAll: t('pci.selectAll') || '全选',
                      clearSelections: t('pci.clearSelections') || '清空选择'
                    }}
                  />
                </div>
              ) : (
                /* 规划结果面板 */
                <div className="flex flex-col h-full min-h-0 overflow-hidden">
                  {currentTaskResult?.status === 'completed' && (
                    <div className="flex items-center justify-between mb-3 shrink-0">
                      <div className="flex items-center gap-6">
                        <div className="flex items-center gap-4 text-sm">
                          <span className="text-blue-600">{t('pci.siteTotal') || '基站总数'}：<span className="font-bold text-blue-600">{currentTaskResult.totalSites || 0}</span></span>
                          <span className="text-blue-600">{t('pci.cellTotal') || '小区总数'}：<span className="font-bold text-blue-600">{currentTaskResult.totalSectors || 0}</span></span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setResultSearchEnabled(!resultSearchEnabled)}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-xs font-medium ${
                            resultSearchEnabled
                              ? 'bg-blue-400 text-white hover:bg-blue-500'
                              : 'bg-card border border-border hover:bg-muted/80'
                          }`}
                        >
                          <Search size={14} />
                          {t('pci.search') || '搜索'}
                        </button>
                        <button
                          onClick={handleExport}
                          className="flex items-center justify-center gap-2 px-4 py-2 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium whitespace-nowrap"
                        >
                          <Download size={14} />
                          {t('pci.export') || '导出结果'}
                        </button>
                        <button
                          onClick={handleApplyToParams}
                          disabled={applyingToParams}
                          className={`flex items-center justify-center gap-2 px-4 py-2 rounded-lg transition-all text-xs font-medium whitespace-nowrap ${
                            applySuccess
                              ? 'bg-green-500/20 border border-green-500/50 text-green-600'
                              : applyingToParams
                                ? 'bg-blue-500/20 border border-blue-500/50 text-blue-600'
                                : 'bg-card border border-border hover:bg-muted/80'
                          } disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                          {applyingToParams ? (
                            <>
                              <Loader2 size={14} className="animate-spin" />
                              {t('pci.applying') || '应用中...'}
                            </>
                          ) : applySuccess ? (
                            <>
                              <Check size={14} />
                              {t('pci.applied') || '已应用'}
                            </>
                          ) : (
                            <>
                              <Save size={14} />
                              {t('pci.apply') || '应用到工参'}
                            </>
                          )}
                        </button>
                        <button
                          onClick={() => setShowMap(prev => !prev)}
                          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors text-xs font-medium whitespace-nowrap ${
                            showMap
                              ? 'bg-blue-400 text-white hover:bg-blue-500'
                              : 'bg-card border border-border hover:bg-muted/80'
                          }`}
                        >
                          <Eye size={14} />
                          {t('pci.showMap') || '地图展示'}
                        </button>
                      </div>
                    </div>
                  )}

                  {!currentTaskResult ? (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground flex-col">
                      <List size={48} className="mb-4 opacity-30" />
                      <p>{t('pci.configAndPlan') || '配置参数后点击「开始规划」查看结果'}</p>
                      <p className="text-xs mt-2">{t('pci.uploadRequired') || '需要先上传「全量工参」和「待规划小区」文件'}</p>
                    </div>
                  ) : currentTaskResult.status === 'failed' ? (
                    <div className="flex-1 flex items-center justify-center text-red-500">
                      <AlertCircle size={48} className="mb-4" />
                      <p className="font-semibold">{t('pci.planFailed') || '规划任务失败'}</p>
                    </div>
                  ) : currentTaskResult.status === 'completed' ? (
                    <>
                      {/* 结果表格 */}
                      {currentTaskResult.results && currentTaskResult.results.length > 0 ? (
                        <div className="overflow-x-auto overflow-y-auto rounded-lg border border-border flex-1 min-h-0">
                          <table className="w-full text-xs text-left border-collapse table-fixed">
                            <thead className="sticky top-0 z-20 bg-background border-b border-border shadow-sm">
                              <tr>
                                {PCI_COLUMNS.map((column) => (
                                  <th
                                    key={column.key}
                                    className="p-2 bg-muted z-20 relative group border-r border-border"
                                    style={{ width: `${pciColumnWidths[column.key]}px`, minWidth: `${pciColumnWidths[column.key]}px` }}
                                  >
                                    <span className="block pr-3">{column.label}</span>
                                    {resultSearchEnabled && (
                                      <input
                                        type="text"
                                        value={resultSearchFilters[column.key as keyof typeof resultSearchFilters]}
                                        onChange={(e) => handleResultSearchChange(column.key, e.target.value)}
                                        placeholder={t('pci.search') || '搜索'}
                                        className="mt-1 w-full p-1 border border-border rounded text-[10px] bg-white dark:bg-slate-800"
                                      />
                                    )}
                                    <div
                                      className={`table-resize-handle ${pciResizingColumn === column.key ? 'resizing' : ''}`}
                                      onMouseDown={(e) => {
                                        e.preventDefault()
                                        e.stopPropagation()
                                        handlePciResizeStart(column.key, e.clientX)
                                      }}
                                    >
                                      <GripVertical size={12} className="opacity-0 group-hover:opacity-40 text-muted-foreground absolute right-0.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                    </div>
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {filteredResults.map((sector: any, idx: number) => {
                                const normalizedSiteId = String(sector.siteId).trim()
                                const normalizedSectorId = String(sector.sectorId).trim()
                                const sectorKey = `${normalizedSiteId}-${normalizedSectorId}`
                                const isSelected = selectedSectorKey === sectorKey

                                return (
                                  <tr
                                    key={`${sector.siteId}-${sector.sectorId}-${idx}`}
                                    className={`border-b cursor-pointer transition-colors ${
                                      isSelected
                                        ? 'bg-[#87CEEB]'
                                        : 'bg-card hover:bg-muted/50'
                                    }`}
                                    onClick={() => handleResultRowClick(
                                      sector.siteId,
                                      sector.sectorId,
                                      sector.newPCI,
                                      sector.frequency || sector.earfcn || sector.ssb_frequency || null
                                    )}
                                  >
                                    {PCI_COLUMNS.map((column) => {
                                      const width = pciColumnWidths[column.key]
                                      const getCellValue = () => {
                                        switch (column.key) {
                                          case 'networkType':
                                            return sector.networkType || '-'
                                          case 'siteId':
                                            return sector.siteId
                                          case 'cellId':
                                            return sector.managedElementId || sector.siteName || sector.siteId
                                          case 'sectorId':
                                            return sector.sectorId
                                          case 'sectorName':
                                            return sector.sectorName
                                          case 'frequency':
                                            return sector.frequency || sector.earfcn || sector.ssb_frequency || '-'
                                          case 'originalPCI':
                                            return sector.originalPCI ?? '-'
                                          case 'newPCI':
                                            return sector.newPCI
                                          case 'originalMod':
                                            return sector.originalMod ?? '-'
                                          case 'newMod':
                                            return sector.newMod ?? '-'
                                          case 'tac':
                                            return sector.tac ?? '-'
                                          case 'assignmentReason':
                                            return sector.assignmentReason || '-'
                                          case 'minReuseDistance':
                                            return sector.minReuseDistance && isFinite(Number(sector.minReuseDistance))
                                              ? Number(sector.minReuseDistance).toFixed(2) + ' km'
                                              : '-'
                                          default:
                                            return null
                                        }
                                      }

                                      const value = getCellValue()
                                      const isTruncated = column.key === 'sectorName' || column.key === 'assignmentReason'

                                      return (
                                        <td
                                          key={column.key}
                                          className={`p-2 border-r border-border ${isTruncated ? 'truncate' : ''} ${column.key === 'newPCI' ? 'font-semibold' : ''}`}
                                          style={{
                                            width: `${width}px`,
                                            minWidth: `${width}px`,
                                            maxWidth: `${width}px`
                                          }}
                                          title={isTruncated ? value : undefined}
                                        >
                                          {value}
                                        </td>
                                      )
                                    })}
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="flex-1 flex items-center justify-center text-muted-foreground">
                          <p>{t('pci.noResult') || '暂无匹配结果'}</p>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                      <Loader2 className="animate-spin mb-4" size={48} />
                      <p>{t('pci.planning') || '规划进行中，请稍候...'}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 右列：地理化展示 - 可折叠 */}
        <div
          className="overflow-hidden transition-[width] duration-300 flex-shrink-0"
          style={{ width: showMap ? '40%' : '0px' }}
        >
          <div className="bg-card p-4 rounded-lg border border-border h-full flex flex-col min-w-[600px]">
              {/* 搜索栏 */}
              <div className="flex items-center justify-end mb-3 gap-2">
                <div className="relative flex-1 max-w-[300px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
                  <input
                    type="text"
                    value={searchValue}
                    onChange={(e) => {
                      setSearchValue(e.target.value)
                      setSearchError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleSearch()
                      }
                    }}
                    placeholder={t('pci.searchPlaceholder') || '输入小区名称或 基站ID-小区ID (例如: SITE001-SEC001)'}
                    className="w-full pl-10 pr-10 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-xs"
                  />
                  {searchValue && (
                    <button
                      onClick={handleClearSearch}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X size={18} />
                    </button>
                  )}
                </div>
                <button
                  onClick={handleSearch}
                  className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors text-xs"
                >
                  <Search size={14} />
                  {t('pci.search') || '搜索'}
                </button>
                <button
                  onClick={handleToggleMeasure}
                  className={`flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors text-xs ${
                    measureMode ? 'bg-primary' : ''
                  }`}
                  title={measureMode ? (t('pci.exitMeasureMode') || '退出测距模式') : (t('pci.enterMeasureMode') || '进入测距模式')}
                >
                  <Ruler size={14} />
                  {t('pci.measure') || '测距'}
                </button>
                <button
                  onClick={handleClearAllMarkers}
                  className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors text-xs"
                  title={t('pci.clearAllMarkersTip') || '清除所有标记（定位 + 测距）'}
                >
                  <X size={14} />
                  {t('pci.clear') || '清除'}
                </button>
                <MapTypeSwitch mapRef={mapRef} />
              </div>

              {/* 搜索标记计数 */}
              {searchMarkers.length > 0 && (
                <div className="mb-3 p-2 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg text-xs text-blue-700 dark:text-blue-300 flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Search size={14} />
                    {t('pci.searchMarkersAdded') || `已添加 ${searchMarkers.length} 个搜索标记`}
                  </span>
                  <button
                    onClick={handleClearMarkers}
                    className="text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-100 font-medium"
                  >
                    {t('pci.clearAll') || '清除全部'}
                  </button>
                </div>
              )}

              {/* 搜索错误提示 */}
              {searchError && (
                <div className="mb-3 p-3 bg-orange-50 border border-orange-200 rounded-lg text-sm text-orange-700 flex items-center gap-2">
                  <AlertCircle size={16} />
                  <span>{searchError}</span>
                  <button
                    onClick={() => setSearchError(null)}
                    className="ml-auto text-orange-700 hover:text-orange-900"
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
              <div className="flex-1 rounded-lg overflow-hidden relative min-h-[500px]">
                {(showMap || mapEverLoadedRef.current) && (
                  <>
                    {!mapEverLoadedRef.current && (mapEverLoadedRef.current = true)}
                    <OnlineMap
                      ref={mapRef}
                      mode="pci-planning"
                      pciData={currentTaskResult?.results || []}
                      onSectorClick={handleMapSectorClick}
                      initialLayerVisibility={{
                        // PCI规划模式：总是同时显示LTE和NR图层
                        lte: true,
                        nr: true
                      }}
                      frequencies={{
                        lte: [],
                        nr: []
                      }}
                      measureMode={measureMode}
                      onMeasureModeEnd={handleMeasureModeEnd}
                    />
                    <PCILegend
                      visible={isLegendVisible}
                      onToggleVisible={() => setIsLegendVisible(!isLegendVisible)}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
  )
}

function ConfigSelect({
  label,
  value,
  options,
  onChange,
  disabled = false
}: {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div>
      <label className="block text-xs font-medium mb-0.5">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  )
}

function ConfigInput({
  label,
  type,
  value,
  onChange,
  disabled = false,
  min,
  max,
  step = 1,
  customWidth
}: {
  label: string
  type: string
  value: number | string
  onChange: (value: string) => void
  disabled?: boolean
  min?: number
  max?: number
  step?: number
  customWidth?: string
}) {
  const widthClass = customWidth || 'w-full'
  return (
    <div>
      <label className="block text-xs font-medium mb-0.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        className={`${widthClass} px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed`}
      />
    </div>
  )
}

function StatCard({ title, value }: { title: string; value: string | number }) {
  return (
    <div className="bg-card p-4 rounded-lg border border-border text-center">
      <p className="text-sm text-muted-foreground mb-1">{title}</p>
      <p className="text-2xl font-bold text-primary">{value}</p>
    </div>
  )
}
