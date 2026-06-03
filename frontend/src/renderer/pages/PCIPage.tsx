import { useState, useEffect, useRef, useCallback } from 'react'
import { Download, Loader2, AlertCircle, Search, X, Ruler, Save, Check, GripVertical, List, Eye } from 'lucide-react'
import { pciApi, dataApi } from '../services/api'
import type { ApiResponse } from '@shared/types'
import { useTaskStore, type Task } from '../store/taskStore'
import { useMapStore } from '../store/mapStore'
import { btn } from '../utils/buttonStyles'
import { OnlineMap, type OnlineMapRef } from '../components/Map/OnlineMap'
import { PCILegend } from '../components/Map/PCILegend'
import { MapTypeSwitch } from '../components/Map/MapTypeSwitch'
import { useAuthStore } from '../store/authStore'
import { pciDataSyncService } from '../services/pciDataSyncService'
import { mapDataService, getCellList, clearCellListCache } from '../services/mapDataService'
import { CoordinateTransformer } from '../utils/coordinate'
import type { RenderSectorData, CellListItem } from '../services/mapDataService'
import { triggerDataRefresh, DATA_REFRESH_EVENT } from '../store/dataStore'
import { usePCIStore } from '../store/pciStore'
import { useTranslation } from 'react-i18next'
import { CellSelectionTable } from '../components/CellSelectionTable'
import { HistoryTable } from '../components/HistoryTable'
import { StepIndicator } from '../components/StepIndicator'
import { WizardFooter } from '../components/WizardFooter'
import { extractCellIdsFromFile, matchCellIds, downloadCellTreeTemplate } from '../utils/cellFileHelper'

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

type WizardStep = 'idle' | 'task_created' | 'params_set' | 'cells_selected' | 'executing' | 'completed'

const WIZARD_STEP_ORDER: WizardStep[] = ['idle', 'task_created', 'params_set', 'cells_selected', 'executing', 'completed']

const calculateDistance = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

const validateConfigStatic = (config: any): string | null => {
  const maxPCI = config.networkType === 'LTE' ? 503 : 1007
  const pciRangeMatch = config.pciRange.match(/^(\d+)-(\d+)$/)
  if (!pciRangeMatch) {
    return `PCI范围格式错误，正确格式为：0-503（当前值：${config.pciRange}）`
  }
  const pciMin = parseInt(pciRangeMatch[1])
  const pciMax = parseInt(pciRangeMatch[2])
  if (pciMin < 0 || pciMin > maxPCI) {
    return `PCI最小值必须在0-${maxPCI}之间，当前值为${pciMin}`
  }
  if (pciMax < 0 || pciMax > maxPCI) {
    return `PCI最大值必须在0-${maxPCI}之间，当前值为${pciMax}`;
  }
  if (pciMin >= pciMax) {
    return `PCI最小值(${pciMin})必须小于最大值(${pciMax})`
  }
  if (config.distanceThreshold < 0.1 || config.distanceThreshold > 50) {
    return `复用距离必须在0.1-50公里之间，当前值为${config.distanceThreshold}`
  }
  const expectedModulus = config.networkType === 'LTE' ? 3 : 30
  const pciModulus = config.networkType === 'LTE' ? 3 : 30
  if (pciModulus !== expectedModulus) {
    return `${config.networkType}网络模数必须为${expectedModulus}`
  }
  return null
}

const validateConfig = (config: any, t: (key: string) => string): string | null => {
  const maxPCI = config.networkType === 'LTE' ? 503 : 1007
  const pciRangeMatch = config.pciRange.match(/^(\d+)-(\d+)$/)
  if (!pciRangeMatch) {
    return t('pci.pciRangeFormatError') || `PCI范围格式错误，正确格式为：0-503（当前值：${config.pciRange}）`
  }
  const pciMin = parseInt(pciRangeMatch[1])
  const pciMax = parseInt(pciRangeMatch[2])
  if (pciMin < 0 || pciMin > maxPCI) {
    return (t('pci.pciMinError') || `PCI最小值必须在0-${maxPCI}之间，当前值为${pciMin}`)
  }
  if (pciMax < 0 || pciMax > maxPCI) {
    return (t('pci.pciMaxError') || `PCI最大值必须在0-${maxPCI}之间，当前值为${pciMax}`)
  }
  if (pciMin >= pciMax) {
    return (t('pci.pciRangeLogicError') || `PCI最小值(${pciMin})必须小于最大值(${pciMax})`)
  }
  if (config.distanceThreshold < 0.1 || config.distanceThreshold > 50) {
    return (t('pci.distanceRangeError') || `复用距离必须在0.1-50公里之间，当前值为${config.distanceThreshold}`)
  }
  const expectedModulus = config.networkType === 'LTE' ? 3 : 30
  const pciModulus = config.networkType === 'LTE' ? 3 : 30
  if (pciModulus !== expectedModulus) {
    return (t('pci.modulusError') || `${config.networkType}网络模数必须为${expectedModulus}`)
  }
  return null
}

export function PCIPage() {
  const { t } = useTranslation()
  const user = useAuthStore((s) => s.user)
  const {
    wizardStep, setWizardStep,
    config, setConfig,
    selectedCellIds: storeSelectedCellIds,
    setSelectedCellIds: setStoreSelectedCellIds,
    activeLeftTab, setActiveLeftTab,
    taskName, setTaskName,
    resetConfig: storeResetConfig
  } = usePCIStore()
  const [taskNameError, setTaskNameError] = useState<string | null>(null)
  const [nextTaskError, setNextTaskError] = useState<string | null>(null)
  const [distanceInputValue, setDistanceInputValue] = useState('10')

  // Bridge: store uses string[], local uses Set<string> for toggle operations
  const [selectedCellIdsSet, setSelectedCellIdsSet] = useState<Set<string>>(new Set(storeSelectedCellIds))
  // 初始同步 store → local Set
  useEffect(() => { setSelectedCellIdsSet(new Set(storeSelectedCellIds)) }, [storeSelectedCellIds])
  // 选中小区的辅助函数：同时更新 local Set 和 store
  const updateCellSelection = useCallback((fn: (prev: Set<string>) => Set<string>) => {
    setSelectedCellIdsSet(prev => {
      const next = fn(prev)
      setStoreSelectedCellIds(Array.from(next))
      return next
    })
  }, [setStoreSelectedCellIds])
  const {
    updateTaskProgress, completeTask, failTask, activeTaskIds, setActiveTaskId, startTask,
    getLatestPCITask,
    startGlobalPolling, stopGlobalPolling, isGlobalPollingActive
  } = useTaskStore()
  const taskId = activeTaskIds.pci_planning
  const latestPCITask = getLatestPCITask()
  const pciHistoryCount = useTaskStore(s => Object.values(s.tasks).filter(t => t.type === 'pci_planning').length)

  const [localTaskResult, setLocalTaskResult] = useState<PCIResultData | null>(null)
  const viewedTaskResultRef = useRef<PCIResultData | null>(null) // 🔒 用户点击"查看"的结果，永不覆盖
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isWhitelistEnabled, setIsWhitelistEnabled] = useState(true)
  const [isLegendVisible, setIsLegendVisible] = useState(true)

  const [applyingToParams, setApplyingToParams] = useState(false)
  const [applySuccess, setApplySuccess] = useState(false)

  const [selectedSectorKey, setSelectedSectorKey] = useState<string | null>(null)

  const [searchValue, setSearchValue] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchMarkers, setSearchMarkers] = useState<Array<{ id: string; name: string; lat: number; lng: number }>>([])
  const [measureMode, setMeasureMode] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const mapEverLoadedRef = useRef(false)

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

  const [cellListData, setCellListData] = useState<{ lte: CellListItem[]; nr: CellListItem[] }>({ lte: [], nr: [] })
  const [cellListLoading, setCellListLoading] = useState(false)
  const [cellFileUploading, setCellFileUploading] = useState(false)
  const cellFileInputRef = useRef<HTMLInputElement>(null)

  // 全局地图控制
  const setGlobalShowMap = useMapStore((s) => s.setGlobalShowMap)

  // ===== 状态重置：切换到"新建任务"时重置表单 =====
  const resetConfig = useCallback(() => {
    storeResetConfig()
    updateCellSelection(() => new Set())
    setDistanceInputValue('10')
    setTaskNameError(null)
    setNextTaskError(null)
    setActiveTaskId('pci_planning', null)
    setLocalTaskResult(null)
    setError(null)
    completionHandledRef.current = false
  }, [storeResetConfig, setActiveTaskId])

  useEffect(() => {
    if (activeLeftTab === 'task-config') {
      resetConfig()
    }
  }, [activeLeftTab, resetConfig])

  // ===== 地图联动关闭：切换到历史/新建任务时自动关闭 =====
  useEffect(() => {
    if (activeLeftTab !== 'planning-result') {
      setShowMap(false)
      setGlobalShowMap(false)
    }
  }, [activeLeftTab, setGlobalShowMap])

  // ===== 结果加载：点击"规划结果"时加载最近一次任务 =====
  const { syncHistoryFromBackend } = useTaskStore()
  useEffect(() => {
    if (activeLeftTab === 'planning-result') {
      // 如果用户通过"查看"按钮加载了结果，不自动加载（viewedTaskResultRef 优先级最高）
      if (viewedTaskResultRef.current) {
        return
      }
      const loadLatest = async () => {
        await syncHistoryFromBackend('pci_planning')
        const latest = getLatestPCITask()
        if (latest && latest.result) {
          // 如果 store 中的结果没有完整 results（来自 resultSummary），尝试从 API 重新获取
          if (!latest.result.results && latest.id) {
            try {
              const response = await pciApi.getResult(latest.id)
              if (response?.success && response?.data?.results) {
                const fullResult = response.data as PCIResultData
                setLocalTaskResult(fullResult)
                if (fullResult.results) {
                  pciDataSyncService.setPCIResults({ results: fullResult.results })
                }
                setWizardStep('completed')
                return
              }
            } catch (fetchErr: any) {
              console.warn('[PCIPage] 获取完整规划结果失败，使用缓存摘要:', fetchErr?.message)
            }
          }
          // 有完整 results 或 API 获取失败时使用已有结果
          setLocalTaskResult(latest.result as PCIResultData)
          if (latest.result.results) {
            pciDataSyncService.setPCIResults({ results: latest.result.results })
          }
          setWizardStep('completed')
        }
      }
      loadLatest()
    } else {
      // 离开结果页时清除用户显式查看的结果
      viewedTaskResultRef.current = null
    }
  }, [activeLeftTab])

  // ===== getCellCount 回调（从 task.result 提取小区数量） =====
  const getCellCount = useCallback((task: Task): number | string => {
    if (task.result?.totalSectors !== undefined) return task.result.totalSectors
    if (task.result?.results) {
      const results = task.result.results
      if (Array.isArray(results)) {
        return results.length
      }
    }
    return '-'
  }, [])

  // ===== 应用 PCI 结果到全量工参 =====
  const pollApplyResult = useCallback(async (applyTaskId: string, timeout = 30000): Promise<any> => {
    const startTime = Date.now()
    while (Date.now() - startTime < timeout) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        const result = await pciApi.getApplyResult(applyTaskId)
        if (result?.data?.status === 'completed') {
          return result.data
        }
        if (result?.data?.status === 'failed') {
          throw new Error(result?.data?.error || '应用失败')
        }
      } catch (pollErr: any) {
        if (pollErr?.response?.status === 404) continue
        throw pollErr
      }
    }
    throw new Error('应用超时')
  }, [])

  const handleApplyTask = useCallback(async (task: Task): Promise<boolean> => {
    setApplyingToParams(true)
    setApplySuccess(false)
    try {
      const response: ApiResponse<any> = await pciApi.applyToParams(task.id)
      const data = response?.data

      // Phase 1 可能已内联返回结果
      let updatedCount: number | undefined = data?.result?.updatedCount
      if (updatedCount === undefined && data?.taskId) {
        // 回退：轮询 Phase 1 结果
        const resultData = await pollApplyResult(data.taskId)
        updatedCount = resultData?.updatedCount
      }

      if (updatedCount !== undefined) {
        // 标记任务为已应用（跨用户共享）
        pciApi.markApplied(task.id).catch(e =>
          console.warn('[PCIPage] 标记已应用失败:', e?.message)
        )
        // 清除地图缓存，确保扇区属性显示更新后的PCI
        mapDataService.clearCache().catch(e =>
          console.warn('[PCIPage] 清理地图缓存失败:', e?.message)
        )
        setApplySuccess(true)
        triggerDataRefresh()
        return true
      }
      throw new Error('应用失败：未获取到更新结果')
    } catch (err: any) {
      console.error('应用PCI结果失败:', err)
      alert(err.message || '应用失败')
      return false
    } finally {
      setApplyingToParams(false)
    }
  }, [pollApplyResult])

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

  const [pciColumnWidths, setPciColumnWidths] = useState<Record<string, number>>(
    Object.fromEntries(PCI_COLUMNS_STATIC.map(col => [col.key, col.defaultWidth]))
  )

  const [pciResizingColumn, setPciResizingColumn] = useState<string | null>(null)
  const pciResizingStartX = useRef<number>(0)
  const pciResizingStartWidth = useRef<number>(0)

  const handlePciResizeStart = useCallback((columnKey: string, startX: number) => {
    setPciResizingColumn(columnKey)
    pciResizingStartX.current = startX
    pciResizingStartWidth.current = pciColumnWidths[columnKey]
    document.body.classList.add('resizing-column')
  }, [pciColumnWidths])

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

  const handlePciResizeEnd = useCallback(() => {
    setPciResizingColumn(null)
    document.body.classList.remove('resizing-column')
  }, [])

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
  const mapRef = useRef<OnlineMapRef>(null)

  // 🔒 结果优先级：用户查看的结果 > 当前运行的任务结果 > 最新任务的结果
  const currentTaskResult = (viewedTaskResultRef.current || localTaskResult || latestPCITask?.result) as PCIResultData | null
  // 只有当有完整结果数据（含 results 数组）时才认为是有效结果
  const hasFullResult = currentTaskResult && !!(currentTaskResult as any).results
  const isRunning = localTaskResult?.status === 'pending' || localTaskResult?.status === 'processing'

  useEffect(() => {
    // latestPCITask 变化时自动加载结果（不影响用户显式查看的 viewedTaskResultRef）
    if (latestPCITask && latestPCITask.result && latestPCITask.result.results) {
      setLocalTaskResult(latestPCITask.result as PCIResultData)
      pciDataSyncService.setPCIResults({ results: latestPCITask.result.results })
    }
  }, [latestPCITask])

  useEffect(() => {
    let mounted = true
    const initSyncService = async () => {
      try {
        await pciDataSyncService.initialize()
        if (mapRef.current && mounted) {
          await mapRef.current.refreshData()
        }
      } catch (error: any) {
        if (error?.message?.includes('未找到全量工参') || error?.message?.includes('全量工参')) {
          setLocalTaskResult(null)
        }
      }
    }
    initSyncService()
    const handleDataRefresh = async () => {
      try {
        mapDataService.clearCache()
        clearCellListCache()
        await initSyncService()
        // 重新加载小区列表，确保新建任务页面使用最新数据
        loadCellList()
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

  const completionHandledRef = useRef(false)
  useEffect(() => {
    if (currentTaskResult?.status === 'completed' && currentTaskResult?.results && mapRef.current) {
      if (completionHandledRef.current) return
      completionHandledRef.current = true
      const map = mapRef.current
      const refreshMap = async () => {
        try {
          map.clearSectorIdWhitelist()
          map.clearPCIHighlight()
          setIsWhitelistEnabled(false)
          setSelectedSectorKey(null)
          await map.refreshData()
        } catch (error) {
          console.error('[PCIPage] 刷新地图数据失败:', error)
        }
      }
      refreshMap()
    } else if (currentTaskResult?.status !== 'completed') {
      completionHandledRef.current = false
    }
  }, [currentTaskResult?.status, currentTaskResult?.results])

  useEffect(() => {
    if (currentTaskResult?.status === 'completed' && currentTaskResult.results) {
      const flatResults: any[] = []
      const taskNetworkType = (currentTaskResult as any).networkType || 'LTE'
      currentTaskResult.results.forEach((site: any) => {
        site.sectors.forEach((sector: any) => {
          flatResults.push({
            ...sector,
            siteId: site.siteId,
            networkType: taskNetworkType,
            managedElementId: site.managedElementId,
            siteName: site.siteName
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

  const handleResultSearchChange = (field: string, value: string) => {
    setResultSearchFilters(prev => ({ ...prev, [field]: value }))
  }

  // === 全局轮询：页面切换不中断，切换回来继续展示执行过程 ===
  useEffect(() => {
    if (taskId && (localTaskResult?.status === 'pending' || localTaskResult?.status === 'processing')) {
      if (!isGlobalPollingActive('pci_planning')) {
        startGlobalPolling('pci_planning')
      }
    }
    // 不在此处停止轮询——组件卸载时轮询继续在后台运行
  }, [taskId, localTaskResult?.status])

  // 从 taskStore 同步进度到 localTaskResult
  useEffect(() => {
    if (taskId) {
      const t = useTaskStore.getState().tasks[taskId]
      if (t) {
        if (t.result && Object.keys(t.result).length > 0) {
          setLocalTaskResult(t.result as PCIResultData)
        }
        if (t.status === 'completed' || t.status === 'failed') {
          stopGlobalPolling('pci_planning')
        }
      }
    }
  }, [taskId])

  // 监听任务完成/失败，自动推进向导步骤
  useEffect(() => {
    if (wizardStep === 'executing') {
      if (localTaskResult?.status === 'completed') {
        setWizardStep('completed')
        setError(null)
      } else if (localTaskResult?.status === 'failed') {
        setWizardStep('cells_selected')
      }
    }
  }, [localTaskResult?.status, wizardStep])

  // 同步距离输入值当进入参数设置步骤时
  useEffect(() => {
    if (wizardStep === 'params_set') {
      setDistanceInputValue(String(config.distanceThreshold))
    }
  }, [wizardStep])

  // === 向导步骤处理函数 ===

  const validateTaskName = (name: string): string | null => {
    if (!name.trim()) {
      return '请输入任务名称'
    }
    if (name.length > 25) {
      return '任务名称不能超过25个字符'
    }
    return null
  }

  const handleTaskNameChange = (value: string) => {
    if (value.length > 25) {
      return // 阻止输入超过25个字符
    }
    setTaskName(value)
    if (value.length > 25) {
      setTaskNameError('任务名称不能超过25个字符')
    } else {
      setTaskNameError(null)
    }
  }

  const handleCancel = () => {
    storeResetConfig()
    updateCellSelection(() => new Set())
    setTaskNameError(null)
    setNextTaskError(null)
    setError(null)
    setDistanceInputValue('10')
  }

  // ===== 上一步逻辑 =====
  const handleBack = useCallback(() => {
    if (wizardStep === 'task_created') {
      // 回到初始状态
      setWizardStep('idle')
      setTaskName('')
      setTaskNameError(null)
      setError(null)
    } else if (wizardStep === 'params_set') {
      setWizardStep('task_created')
      setNextTaskError(null)
      setError(null)
    } else if (wizardStep === 'cells_selected') {
      setWizardStep('params_set')
      updateCellSelection(() => new Set())
      setError(null)
    }
  }, [wizardStep])

  // ===== 统一的"下一步"逻辑 =====
  const handleNext = useCallback(() => {
    if (wizardStep === 'idle') {
      // 新建任务：进入任务名称输入，指示器不跳转
      setWizardStep('task_created')
      setTaskNameError(null)
      setError(null)
    } else if (wizardStep === 'task_created') {
      // 验证任务名称 → 参数设置，指示器跳转到"2规划参数"
      const nameError = validateTaskName(taskName)
      if (nameError) {
        setTaskNameError(nameError)
        return
      }
      setTaskNameError(null)
      setWizardStep('params_set')
      setDistanceInputValue(String(config.distanceThreshold))
      setError(null)
    } else if (wizardStep === 'params_set') {
      // 验证参数 → 小区选择，指示器跳转到"3小区选择"
      const validationError = validateConfig(config, t)
      if (validationError) {
        setNextTaskError(validationError)
        return
      }
      setNextTaskError(null)
      setWizardStep('cells_selected')
      updateCellSelection(() => new Set())
      setError(null)
    } else if (wizardStep === 'cells_selected') {
      // 执行
      if (selectedCellIdsSet.size === 0) {
        setError(t('pci.noCellsSelected') || '请在小区选择列表中至少选择一个小区后再执行PCI规划')
        return
      }
      handleExecute()
    } else if (wizardStep === 'completed') {
      // 查看结果
      setActiveLeftTab('planning-result')
      setShowMap(true)
    }
  }, [wizardStep, taskName, config, selectedCellIdsSet, t, setActiveLeftTab, setShowMap])

  const handleNewTask = () => {
    setWizardStep('task_created')
    setTaskNameError(null)
    setError(null)
  }

  const handleParamsSetup = () => {
    const nameError = validateTaskName(taskName)
    if (nameError) {
      setTaskNameError(nameError)
      return
    }
    setTaskNameError(null)
    setWizardStep('params_set')
    setDistanceInputValue(String(config.distanceThreshold))
    setError(null)
  }

  const handleSelectCells = () => {
    const validationError = validateConfig(config, t)
    if (validationError) {
      setNextTaskError(validationError)
      return
    }
    setNextTaskError(null)
    setWizardStep('cells_selected')
    updateCellSelection(() => new Set())
    setError(null)
  }

  const handleExecute = async () => {
    if (selectedCellIdsSet.size === 0) {
      setError(t('pci.noCellsSelected') || '请在小区选择列表中至少选择一个小区后再执行PCI规划')
      return
    }
    const validationError = validateConfig(config, t)
    if (validationError) {
      setError(validationError)
      return
    }
    setError(null)
    setLocalTaskResult(null)
    setLoading(true)
    setWizardStep('executing')
    errorCountRef.current = 0
    const pciModulus = config.networkType === 'LTE' ? 3 : 30
    const pciRangeMatch = config.pciRange.match(/^(\d+)-(\d+)$/)
    if (!pciRangeMatch) {
      setError(t('pci.pciRangeFormatError') || `PCI范围格式错误，正确格式为：0-503（当前值：${config.pciRange}）`)
      setLoading(false)
      setWizardStep('cells_selected')
      return
    }
    const pciMin = parseInt(pciRangeMatch[1])
    const pciMax = parseInt(pciRangeMatch[2])
    try {
      const response: ApiResponse<{ taskId: string; message: string }> = await pciApi.plan({
        taskName: taskName,
        networkType: config.networkType as 'LTE' | 'NR',
        distanceThreshold: config.distanceThreshold,
        pciModulus: pciModulus,
        inheritModulus: config.inheritModulus,
        pciRange: { min: pciMin, max: pciMax },
        enableTACPlanning: config.enableTACPlanning,
        selectedCellIds: selectedCellIdsSet.size > 0 ? Array.from(storeSelectedCellIds) : undefined
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
        startTask(newTaskId, 'pci_planning', 'PCI规划开始', taskName, user?.username)
      } else {
        setError(response.message || (t('pci.startPlanFailed') || '启动规划任务失败'))
        setWizardStep('cells_selected')
      }
    } catch (err: any) {
      setError(err.message || (t('pci.startPlanFailed') || '启动规划任务失败'))
      setWizardStep('cells_selected')
    } finally {
      setLoading(false)
    }
  }

  // 从历史任务查看 - 跳转到结果页并自动打开地图
  const handleViewTask = async (task: any) => {
    try {
      const response = await pciApi.getResult(task.id)
      if (response?.success && response?.data) {
        const result = response.data as PCIResultData
        viewedTaskResultRef.current = result // 🔒 永久保存用户显式查看的结果
        setLocalTaskResult(result)
        setActiveTaskId('pci_planning', task.id)
        setActiveLeftTab('planning-result')
        setShowMap(true)
        if (result.results) {
          pciDataSyncService.setPCIResults({ results: result.results })
        }
      }
    } catch (err: any) {
      console.error('加载PCI规划结果失败:', err)
      // 回退：如果 API 失败，尝试从 store 中加载
      const stored = useTaskStore.getState().tasks[task.id]
      if (stored?.result) {
        viewedTaskResultRef.current = stored.result as PCIResultData
        setLocalTaskResult(stored.result as PCIResultData)
        setActiveTaskId('pci_planning', task.id)
        setActiveLeftTab('planning-result')
      } else {
        setError('加载规划结果失败: ' + (err.message || '未知错误'))
      }
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
      const now = new Date()
      const timestamp = now.toISOString().slice(0, 10).replace(/-/g, '') + '_' + now.toTimeString().slice(0, 5).replace(/:/g, '')
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
        // Phase 1 可能已内联返回结果，否则回退轮询
        let resultData = response.data.result
        if (!resultData && response.data.taskId) {
          try {
            resultData = await pollApplyResult(response.data.taskId)
          } catch {
            // poll timeout — result will be available later
          }
        }

        const updatedCount = resultData?.updatedCount ?? 0
        triggerDataRefresh()
        setApplySuccess(true)
        let successMsg = `已成功将PCI规划结果应用到工参，更新了${updatedCount}个小区的PCI`
        setError(successMsg)
        mapDataService.clearCache()
        try {
          const listResponse = await dataApi.list(1, 50, true)
        } catch (listErr) { }
        await pciDataSyncService.initialize()
        if (currentTaskResult?.results) {
          pciDataSyncService.setPCIResults({ results: currentTaskResult.results })
        }
        if (mapRef.current) {
          await mapRef.current.refreshData()
        }
        setTimeout(() => {
          setError(null)
          setApplySuccess(false)
        }, 5000)
      } else {
        setError('应用到工参失败: ' + (response.message || '未知错误'))
      }
    } catch (err: any) {
      setError('应用到工参失败: ' + (err.message || '未知错误'))
    } finally {
      setApplyingToParams(false)
      setLoading(false)
    }
  }

  const handleResultRowClick = async (siteId: string, sectorId: string, newPCI: number, frequency: number | null) => {
    if (!currentTaskResult?.results) return
    const normalizedSiteId = String(siteId).trim()
    const normalizedSectorId = String(sectorId).trim()
    const sectorKey = `${normalizedSiteId}-${normalizedSectorId}`
    const taskNetworkType = (currentTaskResult as any).networkType || 'LTE'
    setSelectedSectorKey(sectorKey)
    pciDataSyncService.syncSectorPCI(siteId, sectorId, newPCI)
    const syncedSector = pciDataSyncService.findSector(siteId, sectorId)
    if (!syncedSector) return
    const syncedPCI = syncedSector.syncedPCI ?? newPCI
    const syncedFrequency = syncedSector.frequency || syncedSector.earfcn || syncedSector.ssbFrequency || frequency
    const samePCISectors = pciDataSyncService.findSameFrequencyPCI(syncedPCI, syncedFrequency, siteId, sectorId, taskNetworkType)
    const getSectorCoords = (sector: any): [number, number] | null => {
      const lat = sector.latitude ?? sector.lat ?? sector.displayLat
      const lng = sector.longitude ?? sector.lng ?? sector.displayLng
      if (lat != null && lng != null) {
        if (sector.displayLat != null && sector.displayLng != null && lat === sector.displayLat && lng === sector.displayLng) {
          return [lat, lng]
        }
        return CoordinateTransformer.wgs84ToGcj02(lat, lng)
      }
      return null
    }
    const selectedCoords = getSectorCoords(syncedSector)
    let nearestSamePCISector: any = null
    if (samePCISectors.length > 0 && selectedCoords) {
      const sectorsWithDistance = samePCISectors.map(s => {
        const sCoords = getSectorCoords(s)
        return { sector: s, coords: sCoords, distance: sCoords ? calculateDistance(selectedCoords[0], selectedCoords[1], sCoords[0], sCoords[1]) : Infinity }
      })
      sectorsWithDistance.sort((a, b) => a.distance - b.distance)
      const nearest = sectorsWithDistance.find(s => s.coords != null)
      nearestSamePCISector = nearest?.sector || null
    }
    const selectedSectorId = syncedSector.id
    const relatedIds = samePCISectors.filter(s => s.id !== selectedSectorId).map(s => s.id)
    const whitelist = new Set<string>([selectedSectorId, ...relatedIds])
    mapRef.current?.setPCIHighlightMode({ selectedId: selectedSectorId, relatedIds: relatedIds })
    mapRef.current?.setSectorIdWhitelist(whitelist, 'pci-planning', taskNetworkType)
    setIsWhitelistEnabled(true)
    const latLngs: Array<[number, number]> = []
    if (selectedCoords) latLngs.push(selectedCoords)
    if (nearestSamePCISector) {
      const nearestCoords = getSectorCoords(nearestSamePCISector)
      if (nearestCoords) latLngs.push(nearestCoords)
    }
    setTimeout(() => {
      if (latLngs.length > 0 && mapRef.current) {
        if (latLngs.length === 1) {
          mapRef.current.flyTo(latLngs[0], 16)
        } else {
          mapRef.current.fitBounds(latLngs, [80, 80])
        }
      }
    }, 500)
  }

  const handleShowAll = () => {
    setSelectedSectorKey(null)
    mapRef.current?.clearSectorIdWhitelist()
    mapRef.current?.clearPCIHighlight()
    mapRef.current?.setSectorLabelVisibility('lte', false)
    mapRef.current?.setSectorLabelVisibility('nr', false)
    setIsWhitelistEnabled(false)
  }

  const handleSearch = async () => {
    if (!searchValue.trim()) {
      setSearchError(t('pci.inputSearchHint') || '请输入小区名称或基站ID-小区ID')
      return
    }
    setSearchError(null)
    const trimmedSearch = searchValue.trim()
    try {
      let foundSector: RenderSectorData | null = null
      let siteId: string = ''
      let sectorId: string = ''
      if (trimmedSearch.includes('-')) {
        const parts = trimmedSearch.split('-')
        if (parts.length === 2) {
          siteId = parts[0].trim()
          sectorId = parts[1].trim()
          foundSector = pciDataSyncService.findSector(siteId, sectorId)
        }
      }
      if (!foundSector) {
        const syncedData = pciDataSyncService.getSyncedData()
        if (syncedData) {
          const allSectors = [...syncedData.lte, ...syncedData.nr]
          foundSector = allSectors.find(s => s.name === trimmedSearch) || null
          if (foundSector) {
            siteId = foundSector.siteId || ''
            sectorId = foundSector.sectorId || ''
          }
        }
      }
      if (!foundSector) {
        setSearchError((t('pci.sectorNotFound') || `未找到小区: ${trimmedSearch}`))
        return
      }
      if (foundSector.displayLat && foundSector.displayLng) {
        mapRef.current?.flyTo([foundSector.displayLat, foundSector.displayLng], 16)
        const newMarker = {
          id: foundSector.id,
          name: foundSector.name || `${foundSector.siteId}-${foundSector.sectorId}`,
          lat: foundSector.displayLat,
          lng: foundSector.displayLng
        }
        const markerExists = searchMarkers.some(m => m.id === newMarker.id)
        if (!markerExists) {
          const updatedMarkers = [...searchMarkers, newMarker]
          setSearchMarkers(updatedMarkers)
          mapRef.current?.addLocationMarker({ id: newMarker.id, lat: newMarker.lat, lng: newMarker.lng, name: newMarker.name }, updatedMarkers.length)
        }
      } else {
        setSearchError(t('pci.sectorNoCoords') || '小区缺少经纬度信息，无法定位')
      }
    } catch (err) {
      setSearchError(t('pci.searchFailed') || '搜索失败，请重试')
    }
  }

  const handleClearSearch = () => {
    setSearchValue('')
    setSearchError(null)
    handleShowAll()
    setSearchMarkers([])
    mapRef.current?.clearLocationMarkers()
  }

  const handleClearMarkers = () => {
    setSearchMarkers([])
    mapRef.current?.clearLocationMarkers()
  }

  const handleClearAllMarkers = () => {
    setSearchMarkers([])
    mapRef.current?.clearLocationMarkers()
    mapRef.current?.clearMeasurements()
    mapRef.current?.setMeasureMode(false)
    setMeasureMode(false)
  }

  const handleToggleMeasure = () => {
    const newMode = !measureMode
    setMeasureMode(newMode)
    if (mapRef.current) mapRef.current.setMeasureMode(newMode)
  }

  const handleMeasureModeEnd = () => { setMeasureMode(false) }

  const handleMapSectorClick = (sector: RenderSectorData) => {
    if (!currentTaskResult?.results) return
    const taskNetworkType = (currentTaskResult as any).networkType || 'LTE'
    const syncedData = pciDataSyncService.getSyncedData()
    if (!syncedData) return
    const allSyncedSectors = [...syncedData.lte, ...syncedData.nr]
    let syncedSector = allSyncedSectors.find(s => s.id === sector.id)
    if (!syncedSector) {
      syncedSector = allSyncedSectors.find(s => s.siteId === sector.siteId && s.name === sector.name)
    }
    if (!syncedSector) return
    const pci = (syncedSector as any).syncedPCI || syncedSector.pci || sector.pci
    if (pci === undefined || pci === null) return
    const frequency = (syncedSector as any).frequency || (syncedSector as any).earfcn || (syncedSector as any).ssbFrequency || sector.earfcn || sector.arfcn || null
    const samePCISectors = pciDataSyncService.findSameFrequencyPCI(pci, frequency, syncedSector.siteId, (syncedSector as any).sectorId || syncedSector.id.split('_').pop(), taskNetworkType)
    const selectedSectorId = syncedSector.id
    const relatedIds = samePCISectors.filter(s => s.id !== selectedSectorId).map(s => s.id)
    const whitelist = new Set<string>([selectedSectorId, ...relatedIds])
    mapRef.current?.setPCIHighlightMode({ selectedId: selectedSectorId, relatedIds: relatedIds })
    mapRef.current?.setSectorIdWhitelist(whitelist, 'pci-planning', taskNetworkType)
    setIsWhitelistEnabled(true)
  }

  const loadCellList = useCallback(async () => {
    setCellListLoading(true)
    try {
      const data = await getCellList()
      setCellListData({ lte: data.lte || [], nr: data.nr || [] })
    } catch (err) {
      console.error('[PCIPage] 加载小区列表失败:', err)
    } finally {
      setCellListLoading(false)
    }
  }, [])

  useEffect(() => { loadCellList() }, [loadCellList])

  const toggleCellSelection = (cellId: string) => {
    updateCellSelection(prev => {
      const next = new Set(prev)
      if (next.has(cellId)) next.delete(cellId)
      else next.add(cellId)
      return next
    })
  }

  const toggleSelectAll = () => {
    const networkType = config.networkType as 'LTE' | 'NR'
    const sectors = networkType === 'LTE' ? cellListData.lte : cellListData.nr
    const allIds = sectors.map(s => s.id)
    const allSelected = allIds.length > 0 && allIds.every(id => selectedCellIdsSet.has(id))
    if (allSelected) {
      updateCellSelection(prev => { const next = new Set(prev); allIds.forEach(id => next.delete(id)); return next })
    } else {
      updateCellSelection(prev => { const next = new Set(prev); allIds.forEach(id => next.add(id)); return next })
    }
  }

  const clearSelections = () => { updateCellSelection(() => new Set()) }

  const handleUploadCellFile = () => {
    cellFileInputRef.current?.click()
  }

  const handleCellFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.name.toLowerCase().startsWith('cell-tree')) {
      setError(t('pci.cellFilePrefixError') || '文件名必须以"cell-tree"开头')
      e.target.value = ''
      return
    }

    setCellFileUploading(true)
    setError(null)
    try {
      const extractedIds = await extractCellIdsFromFile(file)
      if (extractedIds.length === 0) {
        setError(t('pci.noCellIdsExtracted') || '未能从文件中提取到小区ID，请检查文件格式')
        return
      }

      clearCellListCache()
      setCellListLoading(true)
      const data = await getCellList()
      setCellListData({ lte: data.lte || [], nr: data.nr || [] })
      setCellListLoading(false)

      const allAvailableIds = [...data.lte, ...data.nr].map(item => item.id)
      const matchedIds = matchCellIds(extractedIds, allAvailableIds)

      if (matchedIds.length > 0) {
        setSelectedCellIdsSet(new Set(matchedIds))
      } else {
        setError(t('pci.noMatchingCells') || '未匹配到任何小区，请检查文件内容与当前工参数据是否一致')
      }
    } catch (err: any) {
      console.error('[PCIPage] 处理待规划小区文件失败:', err)
      setError(err.message || (t('pci.cellFileUploadFailed') || '待规划小区文件处理失败'))
    } finally {
      setCellFileUploading(false)
      e.target.value = ''
    }
  }

  const handleDownloadCellTemplate = () => {
    try {
      const networkType = (config.networkType || 'LTE') as 'LTE' | 'NR'
      downloadCellTreeTemplate(networkType)
    } catch (err: any) {
      console.error('[PCIPage] 下载模板失败:', err)
      alert(`${t('data.downloadTemplateFailed') || '下载模板失败'}: ${err.message || ''}`)
    }
  }

  return (
    <div className="h-full flex flex-col p-4 min-h-0">
      <h1 className="text-3xl font-bold mb-6 shrink-0">{t('pci.title') || 'PCI规划'}</h1>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3 text-red-700 shrink-0">
          <AlertCircle size={18} />
          <span className="text-sm">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-sm underline">{t('pci.close') || '关闭'}</button>
        </div>
      )}

      <div className="flex flex-row gap-1 min-h-0 flex-1 overflow-hidden">
        {/* 左列 */}
        <div className="flex flex-col gap-1 min-h-0 overflow-hidden flex-1 min-w-0">
          <div className="bg-card p-3 rounded-lg border border-border flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* 页签切换栏 */}
            <div className="flex items-center gap-1 mb-3 border-b border-border">
              <button
                onClick={() => !isRunning && setActiveLeftTab('history')}
                className={activeLeftTab === 'history' ? btn.activeTab : btn.ghost}
                disabled={isRunning}
              >
                {t('common.historyTask') || '历史任务'}
                <span className={btn.badgeCount}>{pciHistoryCount}</span>
              </button>
              <button
                onClick={() => !isRunning && setActiveLeftTab('task-config')}
                className={activeLeftTab === 'task-config' ? btn.activeTab : btn.ghost}
                disabled={isRunning}
              >
                {t('common.newTask') || '新建任务'}
              </button>
              <button
                onClick={() => setActiveLeftTab('planning-result')}
                className={activeLeftTab === 'planning-result' ? btn.activeTab : btn.ghost}
              >
                {t('pci.planningResult') || '规划结果'}
                {currentTaskResult?.status === 'completed' && <span className={btn.badgeSuccess}>✓</span>}
                {currentTaskResult?.status === 'failed' && <span className={btn.badgeError}>!</span>}
                {isRunning && <span className="ml-2 inline-flex items-center"><Loader2 size={12} className="animate-spin text-blue-500" /></span>}
              </button>
            </div>

            {/* 页签内容 */}
            <div className="flex-1 min-h-0 overflow-hidden">
              {activeLeftTab === 'task-config' && (
                <div className="flex flex-col h-full overflow-hidden">
                  {/* 步骤指示器（仅视觉展示，执行步骤显示进度百分比） */}
                  <StepIndicator
                    currentStep={
                      wizardStep === 'idle' || wizardStep === 'task_created' ? 0
                      : wizardStep === 'params_set' ? 1
                      : wizardStep === 'cells_selected' ? 2
                      : wizardStep === 'executing' ? 3
                      : 4
                    }
                    executingProgress={wizardStep === 'executing' ? (currentTaskResult?.progress ?? 0) : undefined}
                  />
                  <div className="flex flex-row gap-4 flex-1 min-h-0 overflow-hidden">
                    {/* 左侧：任务名称 + 参数设置 */}
                    <div className="flex flex-col overflow-y-auto flex-1 min-w-0">
                      <div className="bg-card border border-border rounded-xl p-6 w-full">
                        {nextTaskError && (
                          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3 text-red-700">
                            <AlertCircle size={18} />
                            <span className="text-sm">{nextTaskError}</span>
                            <button onClick={() => setNextTaskError(null)} className="ml-auto text-sm underline">关闭</button>
                          </div>
                        )}
                        {/* 任务名称 */}
                        <div className="mb-6">
                          <label className="block text-sm font-semibold mb-2">{t('common.taskName') || '任务名称'}</label>
                          <input
                            type="text"
                            value={taskName}
                            onChange={(e) => handleTaskNameChange(e.target.value)}
                            disabled={wizardStep !== 'idle' && wizardStep !== 'task_created'}
                            placeholder={t('common.taskNamePlaceholder') || '请输入任务名称'}
                            maxLength={25}
                            className={`w-full px-3 py-2 text-sm bg-background border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 disabled:cursor-not-allowed ${taskNameError ? 'border-red-400 focus:ring-red-400' : wizardStep === 'task_created' && !taskName.trim() ? 'input-pulse' : 'border-border'}`}
                          />
                          {taskNameError && (
                            <p className="mt-1 text-xs text-red-500">{taskNameError}</p>
                          )}
                          <p className="mt-1 text-xs text-muted-foreground">{taskName.length}/25</p>
                        </div>

                        {/* PCI参数 */}
                        <div className="space-y-4">
                          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                            <div>
                              <label className="block text-xs font-medium mb-0.5">网络类型</label>
                              <select
                                value={config.networkType}
                                onChange={(e) => {
                                  const nt = e.target.value as 'LTE' | 'NR'
                                  setConfig({ networkType: nt, pciRange: nt === 'LTE' ? '0-503' : '0-1007' })
                                }}
                                disabled={wizardStep !== 'params_set'}
                                className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 disabled:cursor-not-allowed"
                              >
                                <option value="LTE">LTE</option>
                                <option value="NR">NR</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs font-medium mb-0.5">复用距离(km)</label>
                              <input
                                type="number"
                                value={distanceInputValue}
                                onChange={(e) => {
                                  const raw = e.target.value
                                  setDistanceInputValue(raw)
                                  const num = parseFloat(raw)
                                  if (!isNaN(num)) {
                                    setConfig({ distanceThreshold: num })
                                  } else if (raw === '' || raw === '-') {
                                    setConfig({ distanceThreshold: 0 })
                                  }
                                }}
                                disabled={wizardStep !== 'params_set'}
                                step={0.1}
                                placeholder="0"
                                className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 disabled:cursor-not-allowed"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium mb-0.5">PCI范围</label>
                              <input
                                type="text"
                                value={config.pciRange}
                                onChange={(e) => setConfig({ pciRange: e.target.value })}
                                disabled={wizardStep !== 'params_set'}
                                className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 disabled:cursor-not-allowed"
                              />
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            <label className="flex items-center gap-2 text-xs cursor-pointer">
                              <input
                                type="checkbox"
                                checked={config.inheritModulus}
                                onChange={(e) => setConfig({ inheritModulus: e.target.checked })}
                                disabled={wizardStep !== 'params_set'}
                                className="w-3.5 h-3.5 disabled:opacity-60"
                              />
                              继承模{config.networkType === 'LTE' ? '3' : '30'}
                            </label>
                            <label className="flex items-center gap-2 text-xs cursor-pointer">
                              <input
                                type="checkbox"
                                checked={config.enableTACPlanning}
                                onChange={(e) => setConfig({ enableTACPlanning: e.target.checked })}
                                disabled={wizardStep !== 'params_set'}
                                className="w-3.5 h-3.5 disabled:opacity-60"
                              />
                              TAC规划
                            </label>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 右侧：小区选择 */}
                    <div className="flex flex-col flex-1 min-w-0 border-l border-border pl-4 overflow-hidden">
                      <div className="flex flex-col h-full overflow-hidden">
                        <input
                          type="file"
                          ref={cellFileInputRef}
                          onChange={handleCellFileChange}
                          accept=".xlsx,.xls"
                          className="hidden"
                        />
                        <CellSelectionTable
                          sectors={(() => {
                            const networkType = config.networkType as 'LTE' | 'NR'
                            return networkType === 'LTE' ? cellListData.lte : cellListData.nr
                          })()}
                          selectedCellIds={selectedCellIdsSet}
                          onToggleCell={wizardStep === 'cells_selected' && !isRunning ? toggleCellSelection : () => {}}
                          onSelectAll={wizardStep === 'cells_selected' && !isRunning ? toggleSelectAll : () => {}}
                          onClearSelections={wizardStep === 'cells_selected' && !isRunning ? clearSelections : () => {}}
                          selectedCountText={(t('pci.selectedCount') || '已选中 {{count}} 个小区').replace('{{count}}', String(selectedCellIdsSet.size))}
                          searchPlaceholder={t('pci.cellSearchPlaceholder') || '搜索基站ID、小区ID或名称...'}
                          loading={cellListLoading}
                          onUploadCellFile={wizardStep === 'cells_selected' ? handleUploadCellFile : undefined}
                          onDownloadCellTemplate={wizardStep === 'cells_selected' ? handleDownloadCellTemplate : undefined}
                          uploading={cellFileUploading}
                          disabled={wizardStep !== 'cells_selected' || isRunning}
                          columnLabels={{
                            siteId: t('pci.siteId') || '基站ID',
                            cellId: t('pci.sectorId') || '小区ID',
                            cellName: t('pci.sectorName') || '小区名称',
                            selectAll: t('pci.selectAll') || '全选',
                            clearSelections: t('pci.clearSelections') || '清空选择',
                            uploadCellFile: t('pci.uploadCellFile') || '上传待规划小区文件',
                            downloadCellTemplate: t('pci.downloadCellTemplate') || '下载待规划小区模板'
                          }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* === 向导流程底部导航 === */}
                  <WizardFooter
                    currentStep={
                      wizardStep === 'idle' || wizardStep === 'task_created' ? 0
                      : wizardStep === 'params_set' ? 1
                      : wizardStep === 'cells_selected' ? 2
                      : wizardStep === 'executing' ? 3
                      : 4
                    }
                    isExecuting={loading || isRunning}
                    canProceed={
                      wizardStep === 'idle' ? true
                      : wizardStep === 'task_created' ? taskName.trim().length > 0
                      : wizardStep === 'params_set' ? true
                      : wizardStep === 'cells_selected' ? selectedCellIdsSet.size > 0
                      : wizardStep === 'completed' ? true
                      : false
                    }
                    onNext={handleNext}
                    onCancel={handleCancel}
                    onBack={handleBack}
                    isTaskNameStep={wizardStep === 'task_created'}
                  />
                </div>
              )}

              {activeLeftTab === 'history' && (
                <div className="flex flex-col h-full overflow-hidden">
                  <HistoryTable
                    taskType="pci_planning"
                    typeLabel="PCI规划"
                    onSelectTask={(task) => {
                      if (task.result) {
                        const result = task.result as PCIResultData
                        setLocalTaskResult(result)
                        setActiveTaskId('pci_planning', task.id)
                        setActiveLeftTab('planning-result')
                        if (result.results) {
                          pciDataSyncService.setPCIResults({ results: result.results })
                        }
                      }
                    }}
                    onViewTask={handleViewTask}
                    getCellCount={getCellCount}
                    onApplyTask={handleApplyTask}
                  />
                </div>
              )}

              {activeLeftTab === 'planning-result' && (
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
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-xs font-medium ${resultSearchEnabled ? 'bg-blue-400 text-white hover:bg-blue-500' : 'bg-card border border-border hover:bg-muted/80'}`}
                        >
                          <Search size={14} />
                          {t('pci.search') || '搜索'}
                        </button>
                        <button onClick={handleExport} className="flex items-center justify-center gap-2 px-4 py-2 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium whitespace-nowrap">
                          <Download size={14} />
                          {t('pci.export') || '导出结果'}
                        </button>
                        <button
                          onClick={handleApplyToParams}
                          disabled={applyingToParams}
                          className={`flex items-center justify-center gap-2 px-4 py-2 rounded-lg transition-all text-xs font-medium whitespace-nowrap ${applySuccess ? 'bg-green-500/20 border border-green-500/50 text-green-600' : applyingToParams ? 'bg-blue-500/20 border border-blue-500/50 text-blue-600' : 'bg-card border border-border hover:bg-muted/80'} disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                          {applyingToParams ? <><Loader2 size={14} className="animate-spin" />{t('pci.applying') || '应用中...'}</> : applySuccess ? <><Check size={14} />{t('pci.applied') || '已应用'}</> : <><Save size={14} />{t('pci.apply') || '应用到工参'}</>}
                        </button>
                        <button
                          onClick={() => setShowMap(prev => !prev)}
                          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors text-xs font-medium whitespace-nowrap ${showMap ? 'bg-blue-400 text-white hover:bg-blue-500' : 'bg-card border border-border hover:bg-muted/80'}`}
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
                      {wizardStep === 'idle' ? (
                        <p>{t('common.configureFirst') || '请先点击"新建"按钮创建任务'}</p>
                      ) : (
                        <p>{t('common.selectCellsThenExecute') || '按向导完成参数设置 → 选择小区 → 执行'}</p>
                      )}
                      <p className="text-xs mt-2">{t('pci.uploadRequired') || '需要先上传「全量工参」和「待规划小区」文件'}</p>
                    </div>
                  ) : currentTaskResult.status === 'failed' ? (
                    <div className="flex-1 flex items-center justify-center text-red-500">
                      <AlertCircle size={48} className="mb-4" />
                      <p className="font-semibold">{t('pci.planFailed') || '规划任务失败'}</p>
                    </div>
                  ) : currentTaskResult.status === 'completed' && !(currentTaskResult as any).results ? (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground flex-col">
                      <AlertCircle size={48} className="mb-4 opacity-50" />
                      <p>{t('common.resultUnavailable') || '结果数据不可用，请重新执行规划任务'}</p>
                    </div>
                  ) : hasFullResult ? (
                    <>
                      {currentTaskResult.results && currentTaskResult.results.length > 0 ? (
                        <div className="overflow-x-auto overflow-y-auto rounded-lg border border-border flex-1 min-h-0">
                          <table className="w-full text-xs text-left border-collapse table-fixed">
                            <thead className="sticky top-0 z-20 bg-background border-b border-border shadow-sm">
                              <tr>
                                {PCI_COLUMNS.map((column) => (
                                  <th key={column.key} className="p-2 bg-muted z-20 relative group border-r border-border" style={{ width: `${pciColumnWidths[column.key]}px`, minWidth: `${pciColumnWidths[column.key]}px` }}>
                                    <span className="block pr-3">{column.label}</span>
                                    {resultSearchEnabled && (
                                      <input type="text" value={resultSearchFilters[column.key as keyof typeof resultSearchFilters]} onChange={(e) => handleResultSearchChange(column.key, e.target.value)} placeholder={t('pci.search') || '搜索'} className="mt-1 w-full p-1 border border-border rounded text-[10px] bg-white dark:bg-slate-800" />
                                    )}
                                    <div className={`table-resize-handle ${pciResizingColumn === column.key ? 'resizing' : ''}`} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); handlePciResizeStart(column.key, e.clientX) }}>
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
                                  <tr key={`${sector.siteId}-${sector.sectorId}-${idx}`} className={`border-b cursor-pointer transition-colors ${isSelected ? 'bg-[#87CEEB]' : 'bg-card hover:bg-muted/50'}`} onClick={() => handleResultRowClick(sector.siteId, sector.sectorId, sector.newPCI, sector.frequency || sector.earfcn || sector.ssb_frequency || null)}>
                                    {PCI_COLUMNS.map((column) => {
                                      const width = pciColumnWidths[column.key]
                                      const getCellValue = () => {
                                        switch (column.key) {
                                          case 'networkType': return sector.networkType || '-'
                                          case 'siteId': return sector.siteId
                                          case 'cellId': return sector.managedElementId || sector.siteName || sector.siteId
                                          case 'sectorId': return sector.sectorId
                                          case 'sectorName': return sector.sectorName
                                          case 'frequency': return sector.frequency || sector.earfcn || sector.ssb_frequency || '-'
                                          case 'originalPCI': return sector.originalPCI ?? '-'
                                          case 'newPCI': return sector.newPCI
                                          case 'originalMod': return sector.originalMod ?? '-'
                                          case 'newMod': return sector.newMod ?? '-'
                                          case 'tac': return sector.tac ?? '-'
                                          case 'assignmentReason': return sector.assignmentReason || '-'
                                          case 'minReuseDistance': return sector.minReuseDistance && isFinite(Number(sector.minReuseDistance)) ? Number(sector.minReuseDistance).toFixed(2) + ' km' : '-'
                                          default: return null
                                        }
                                      }
                                      const value = getCellValue()
                                      const isTruncated = column.key === 'sectorName' || column.key === 'assignmentReason'
                                      return (
                                        <td key={column.key} className={`p-2 border-r border-border ${isTruncated ? 'truncate' : ''} ${column.key === 'newPCI' ? 'font-semibold' : ''}`} style={{ width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` }} title={isTruncated ? value : undefined}>
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
                        <div className="flex-1 flex items-center justify-center text-muted-foreground"><p>{t('pci.noResult') || '暂无匹配结果'}</p></div>
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

        {/* 右列：地图 */}
        <div className="overflow-hidden transition-[width] duration-300 flex-shrink-0" style={{ width: showMap ? '40%' : '0px' }}>
          <div className="bg-card p-4 rounded-lg border border-border h-full flex flex-col min-w-[600px]">
            <div className="flex items-center justify-end mb-3 gap-2">
              <div className="relative flex-1 max-w-[300px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
                <input type="text" value={searchValue} onChange={(e) => { setSearchValue(e.target.value); setSearchError(null) }} onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }} placeholder={t('pci.searchPlaceholder') || '输入小区名称或 基站ID-小区ID'} className="w-full pl-10 pr-10 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-xs" />
                {searchValue && <button onClick={handleClearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X size={18} /></button>}
              </div>
              <button onClick={handleSearch} className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors text-xs"><Search size={14} />{t('pci.search') || '搜索'}</button>
              <button onClick={handleToggleMeasure} className={`flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors text-xs ${measureMode ? 'bg-primary' : ''}`} title={measureMode ? (t('pci.exitMeasureMode') || '退出测距模式') : (t('pci.enterMeasureMode') || '进入测距模式')}><Ruler size={14} />{t('pci.measure') || '测距'}</button>
              <button onClick={handleClearAllMarkers} className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors text-xs" title={t('pci.clearAllMarkersTip') || '清除所有标记'}><X size={14} />{t('pci.clear') || '清除'}</button>
              <MapTypeSwitch mapRef={mapRef} />
            </div>
            {searchMarkers.length > 0 && (
              <div className="mb-3 p-2 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg text-xs text-blue-700 dark:text-blue-300 flex items-center justify-between">
                <span className="flex items-center gap-2"><Search size={14} />{t('pci.searchMarkersAdded') || `已添加 ${searchMarkers.length} 个搜索标记`}</span>
                <button onClick={handleClearMarkers} className="text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-100 font-medium">{t('pci.clearAll') || '清除全部'}</button>
              </div>
            )}
            {searchError && (
              <div className="mb-3 p-3 bg-orange-50 border border-orange-200 rounded-lg text-sm text-orange-700 flex items-center gap-2">
                <AlertCircle size={16} /><span>{searchError}</span>
                <button onClick={() => setSearchError(null)} className="ml-auto text-orange-700 hover:text-orange-900"><X size={16} /></button>
              </div>
            )}
            <div className="flex-1 rounded-lg overflow-hidden relative min-h-[500px]">
              {(showMap || mapEverLoadedRef.current) && (
                <>
                  {!mapEverLoadedRef.current && (mapEverLoadedRef.current = true)}
                  <OnlineMap ref={mapRef} mode="pci-planning" pciData={currentTaskResult?.results || []} onSectorClick={handleMapSectorClick} initialLayerVisibility={{ lte: true, nr: true }} frequencies={{ lte: [], nr: [] }} measureMode={measureMode} onMeasureModeEnd={handleMeasureModeEnd} />
                  <PCILegend visible={isLegendVisible} onToggleVisible={() => setIsLegendVisible(!isLegendVisible)} />
                </>
              )}
            </div>
          </div>
        </div>
      </div>
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
