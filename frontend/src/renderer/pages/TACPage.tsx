import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Download, Loader2, AlertCircle, Search, GripVertical, List, Eye } from 'lucide-react'
import { tacApi } from '../services/api'
import { useTACCheckStore } from '../store/tacCheckStore'
import { useTaskStore, type Task } from '../store/taskStore'
import { useMapStore } from '../store/mapStore'
import { useAuthStore } from '../store/authStore'
import { btn } from '../utils/buttonStyles'
import { OnlineMap } from '../components/Map/OnlineMap'
import { TACLegend } from '../components/Map/TACLegend'
import { tacDataSyncService } from '../services/tacDataSyncService'
import { tacColorMapper } from '../utils/tacColors'
import type { OnlineMapRef } from '../components/Map/OnlineMap'
import type { CellListItem } from '../services/mapDataService'
import { mapDataService, getCellList, clearCellListCache } from '../services/mapDataService'
import { DATA_REFRESH_EVENT } from '../store/dataStore'
import { useTranslation } from 'react-i18next'
import { CellSelectionTable } from '../components/CellSelectionTable'
import { HistoryTable } from '../components/HistoryTable'
import { StepIndicator } from '../components/StepIndicator'
import { WizardFooter } from '../components/WizardFooter'
import { extractCellIdsFromFile, matchCellIds, downloadCellTreeTemplate } from '../utils/cellFileHelper'

// 虚拟滚动配置
const ITEM_HEIGHT = 48 // 每行高度
const VISIBLE_COUNT = 20 // 可见行数
const BUFFER_COUNT = 5 // 缓冲行数

// TAC核查表格列配置
const COLUMNS = [
  { key: 'firstGroup', label: '运营商/厂家', defaultWidth: 100 },
  { key: 'siteId', label: '站点ID', defaultWidth: 80 },
  { key: 'siteName', label: '站点名称', defaultWidth: 150 },
  { key: 'sectorId', label: '小区ID', defaultWidth: 70 },
  { key: 'sectorName', label: '小区名称', defaultWidth: 200 },
  { key: 'networkType', label: '网络类型', defaultWidth: 70 },
  { key: 'longitude', label: '经度', defaultWidth: 90 },
  { key: 'latitude', label: '纬度', defaultWidth: 90 },
  { key: 'tac', label: '图层TAC', defaultWidth: 70 },
  { key: 'existingTac', label: '现网TAC', defaultWidth: 70 },
  { key: 'tacConsistent', label: 'TAC是否一致', defaultWidth: 80 },
  { key: 'isSingularity', label: 'TAC是否插花', defaultWidth: 90 },
  { key: 'suggestedTac', label: 'TAC建议值', defaultWidth: 100 },
  { key: 'matched', label: '匹配状态', defaultWidth: 70 }
] as const

// TAC值标准化辅助函数（去除空格、前导零）
const normalizeTac = (tac: string): string => {
  return tac.toString().trim().replace(/^0+/, '') || '0'
}
interface TACResultData {
  taskId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  networkType?: 'LTE' | 'NR'
  totalCells: number
  matchedCells: number
  unmatchedCells: number
  mismatchedCells: number
  mismatchedRate: number
  singularityCount?: number  // TAC插花数量
  results: any[]
  startTime: string
  endTime?: string
  error?: string
}

const MAX_ERRORS = 5

type WizardStep = 'idle' | 'task_created' | 'params_set' | 'cells_selected' | 'executing' | 'completed'

export function TACPage() {
  const perfRef = useRef({ mountTime: performance.now(), renderCount: 0, firstCommitLogged: false })
  perfRef.current.renderCount++
  const now = performance.now()
  if (perfRef.current.renderCount > 1) {
    console.log(`[TACPage] render #${perfRef.current.renderCount} at +${(now - perfRef.current.mountTime).toFixed(0)}ms`)
  }

  const { t } = useTranslation()
  const user = useAuthStore((s) => s.user)
  const { wizardStep, setWizardStep, config, setConfig, selectedCellIds: storeSelectedCellIds, activeLeftTab, setActiveLeftTab, taskName, setTaskName, resetConfig: storeResetConfig } = useTACCheckStore()
  const [taskNameError, setTaskNameError] = useState<string | null>(null)
  const [nextTaskError, setNextTaskError] = useState<string | null>(null)
  const { activeTaskIds, setActiveTaskId, getLatestTACCheckTask, startTask, updateTaskProgress, completeTask, failTask, syncHistoryFromBackend,
    startGlobalPolling, stopGlobalPolling, isGlobalPollingActive } = useTaskStore()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localTaskResult, setLocalTaskResult] = useState<TACResultData | null>(null)
  const viewedTaskIdRef = useRef<string | null>(null) // 防止 useEffect 覆盖 API 获取的结果

  // 从 taskStore 恢复最近的任务结果，行为与 PCI/邻区规划一致
  const t0 = performance.now()
  const latestTACCheckTask = getLatestTACCheckTask()
  const taskId = activeTaskIds.tac_check
  const tacCheckHistoryCount = useTaskStore(s => Object.values(s.tasks).filter(t => t.type === 'tac_check').length)
  const taskResult = localTaskResult || (latestTACCheckTask?.result as TACResultData | null)
  // 只有当有完整结果数据（含 results 数组）或由 handleViewTask 设置时才认为是有效结果
  const hasFullResult = taskResult && (!!(taskResult as any).results || viewedTaskIdRef.current)
  const tStore = performance.now() - t0

  // 组件挂载时，检查是否有最新的TAC核查结果（与PCI/邻区规划逻辑一致）
  useEffect(() => {
    console.time('[TACPage] effect:sync-store')
    // 如果用户通过"查看"按钮加载了特定任务，不要覆盖
    if (viewedTaskIdRef.current && latestTACCheckTask && viewedTaskIdRef.current !== latestTACCheckTask.id) {
      console.timeEnd('[TACPage] effect:sync-store')
      return
    }
    if (latestTACCheckTask && latestTACCheckTask.result && latestTACCheckTask.result.results) {
      setLocalTaskResult(latestTACCheckTask.result as TACResultData)
    }
    console.log('[TACPage] 效果:sync-store fired, tStore=', tStore.toFixed(1), 'ms', 'hasTask=', !!latestTACCheckTask)
    console.timeEnd('[TACPage] effect:sync-store')
  }, [latestTACCheckTask])

  // 选中的小区ID集合（格式：${siteId}_${sectorId}）- 本地 Set 桥接 store 的 string[]
  const [selectedCellIdsSet, setSelectedCellIdsSet] = useState<Set<string>>(new Set(storeSelectedCellIds))
  useEffect(() => { setSelectedCellIdsSet(new Set(storeSelectedCellIds)) }, [storeSelectedCellIds])
  const [cellListData, setCellListData] = useState<{ lte: CellListItem[]; nr: CellListItem[] }>({ lte: [], nr: [] })
  const [cellListLoading, setCellListLoading] = useState(false)
  const [cellFileUploading, setCellFileUploading] = useState(false)
  const cellFileInputRef = useRef<HTMLInputElement>(null)

  // 全局地图控制
  const setGlobalShowMap = useMapStore((s) => s.setGlobalShowMap)

  // ===== 状态重置 =====
  const resetConfig = useCallback(() => {
    storeResetConfig()
    setSelectedCellIdsSet(new Set())
    setTaskNameError(null)
    setActiveTaskId('tac_check', null)
    setLocalTaskResult(null)
    setError(null)
  }, [storeResetConfig, setActiveTaskId])

  useEffect(() => {
    if (activeLeftTab === 'task-config') { resetConfig() }
  }, [activeLeftTab, resetConfig])

  // ===== 地图联动关闭 =====
  useEffect(() => {
    if (activeLeftTab !== 'planning-result') {
      setShowMap(false)
      setGlobalShowMap(false)
    }
  }, [activeLeftTab, setGlobalShowMap])

  // ===== 结果自动加载 =====
  useEffect(() => {
    if (activeLeftTab === 'planning-result') {
      // 如果用户通过"查看"按钮加载了特定任务的结果，不要自动加载最新的
      if (viewedTaskIdRef.current) {
        return
      }
      const loadLatest = async () => {
        await syncHistoryFromBackend('tac_check')
        const latest = getLatestTACCheckTask()
        if (latest && latest.result) {
          // 如果缺少完整 results（来自 resultSummary），尝试从 API 重新获取
          if (!latest.result.results && latest.id) {
            try {
              const response = await tacApi.getResult(latest.id)
              if (response?.success && response?.data?.results) {
                const fullResult = response.data as TACResultData
                setLocalTaskResult(fullResult)
                tacDataSyncService.setTACResults({ results: fullResult.results })
                setWizardStep('completed')
                return
              }
            } catch (fetchErr: any) {
              console.warn('[TACPage] 获取完整核查结果失败，使用缓存摘要:', fetchErr?.message)
            }
          }
          // 有完整 results 或 API 获取失败时使用已有结果
          setLocalTaskResult(latest.result as TACResultData)
          if (latest.result.results) {
            tacDataSyncService.setTACResults({ results: latest.result.results })
          }
          setWizardStep('completed')
        }
      }
      loadLatest()
    } else {
      // 离开结果页时清除 viewedTaskIdRef
      viewedTaskIdRef.current = null
    }
  }, [activeLeftTab])

  // ===== getCellCount =====
  const getCellCount = useCallback((task: Task): number | string => {
    if (task.result?.totalCells !== undefined) return task.result.totalCells
    if (task.result?.results && Array.isArray(task.result.results)) {
      return task.result.results.length
    }
    return '-'
  }, [])

  // 插花检测配置状态
  const [singularityConfig, setSingularityConfig] = useState({
    searchRadius: 1500,
    singularityThreshold: 0.5,
  })

  // 地图相关状态
  const mapRef = useRef<OnlineMapRef>(null)
  const [isLegendVisible, setIsLegendVisible] = useState(true)
  const [selectedSectorKey, setSelectedSectorKey] = useState<string | null>(null)
  const [measureMode, setMeasureMode] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const mapEverLoadedRef = useRef(false)
  // 导出动画状态
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'success'>('idle')
  const exportTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // 标记是否为首次挂载（用于跳过从 localStorage 恢复的旧结果自动应用）
  const isInitialMount = useRef(true)

  // 页面加载时检查任务是否仍然存在，如果不存在则清除状态
  useEffect(() => {
    console.time('[TACPage] effect:checkTaskExists')
    const checkTaskExists = async () => {
      if (taskId && taskResult?.status === 'processing') {
        try {
          await tacApi.getProgress(taskId)
          // 如果任务存在，不进行任何操作，轮询 useEffect 会继续处理
        } catch (err: any) {
          // 如果任务不存在（404）或其他错误，清除状态
          console.log('任务已不存在，清除TAC状态')
          setActiveTaskId('tac_check', null); setLocalTaskResult(null)
          setError(null)
        }
      }
    }

    checkTaskExists()
    console.timeEnd('[TACPage] effect:checkTaskExists')
  }, [])

  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const errorCountRef = useRef(0)
  // === 全局轮询：页面切换不中断 ===
  useEffect(() => {
    if (taskId && (taskResult?.status === 'pending' || taskResult?.status === 'processing')) {
      if (!isGlobalPollingActive('tac_check')) {
        startGlobalPolling('tac_check')
      }
    }
  }, [taskId, taskResult?.status])

  // 从 taskStore 同步进度到 localTaskResult（但不要覆盖用户通过"查看"按钮加载的结果）
  useEffect(() => {
    if (taskId && viewedTaskIdRef.current === taskId) {
      return
    }
    if (taskId) {
      const t = useTaskStore.getState().tasks[taskId]
      if (t) {
        if (t.result && Object.keys(t.result).length > 0) {
          setLocalTaskResult(t.result as TACResultData)
        }
        if (t.status === 'completed' || t.status === 'failed') {
          stopGlobalPolling('tac_check')
        }
      }
    }
  }, [taskId])

  // 初始化TAC数据同步服务（异步执行，不阻塞页面渲染）
  useEffect(() => {
    console.time('[TACPage] effect:init')
    let mounted = true

    const initMapServices = async () => {
      console.time('[TACPage] init:tacDataSyncService')
      try {
        await tacDataSyncService.initialize()
        // 初始化完成后刷新地图数据
        if (mapRef.current && mounted) {
          await mapRef.current.refreshData()
        }
      } catch (error) {
        console.error('Failed to initialize TAC services:', error)
      } finally {
        console.timeEnd('[TACPage] init:tacDataSyncService')
      }
    }

    // 监听数据刷新事件（当在其他页面上传新工参时）
    const handleDataRefresh = async () => {
      console.log('[TACPage] 收到数据刷新事件，正在清除缓存...')
      try {
        // 清除地图数据和小区列表缓存
        await mapDataService.clearCache()
        clearCellListCache()
        // 重新加载小区列表，确保新建任务页面使用最新数据
        loadCellList()
        console.log('[TACPage] 已清除缓存并重载小区列表')
      } catch (error) {
        console.warn('[TACPage] 数据刷新失败:', error)
      }
    }

    window.addEventListener(DATA_REFRESH_EVENT, handleDataRefresh)

    // 延迟初始化，优先保证页面渲染（与邻区规划页面逻辑一致）
    const timeoutId = setTimeout(() => {
      initMapServices()
    }, 0)

    console.timeEnd('[TACPage] effect:init')

    return () => {
      mounted = false
      window.removeEventListener(DATA_REFRESH_EVENT, handleDataRefresh)
      clearTimeout(timeoutId)
    }
  }, [])

  // TAC结果加载后同步到数据服务，并触发地图全量加载
  useEffect(() => {
    console.time('[TACPage] effect:resultSync')

    // 跳过首次挂载：避免从 localStorage 恢复的历史结果自动应用到地图
    if (isInitialMount.current) {
      isInitialMount.current = false
      console.timeEnd('[TACPage] effect:resultSync')
      return
    }

    if (taskResult?.status === 'completed' && taskResult.results) {
      console.log('[TACPage] 任务完成，同步数据并初始化地图')
      const taskNetworkType = taskResult.networkType || config?.networkType || 'LTE'

      // 预加载所有TAC颜色，确保图例能立即显示
      const uniqueTACs = new Set<string>()
      taskResult.results.forEach((cell: any) => {
        if (cell.tac) uniqueTACs.add(String(cell.tac))
        if (cell.existingTac) uniqueTACs.add(String(cell.existingTac))
      })
      console.log('[TACPage] 预加载TAC颜色', { count: uniqueTACs.size, networkType: taskNetworkType })
      uniqueTACs.forEach(tac => {
        tacColorMapper.getColor(tac, taskNetworkType)
      })

      tacDataSyncService.setTACResults({
        results: taskResult.results,
        singularityCount: taskResult.singularityCount || 0
      })

      // 任务完成，通知地图加载TAC同步后的全量数据
      // 传入 null 表示不进行具体的小区过滤（显示全部），但传入网络类型只加载该网络类型
      if (mapRef.current) {
        console.log('[TACPage] 加载TAC地图数据', { networkType: taskNetworkType })
        mapRef.current.setSectorIdWhitelist(null, 'tac-check', taskNetworkType)
      }
    }
    console.timeEnd('[TACPage] effect:resultSync')
  }, [taskResult?.status, taskResult?.results])

  // 地图扇区点击处理
  const handleMapSectorClick = (sector: any) => {
    console.log('Map sector clicked:', sector)
  }


  // 测距模式结束回调
  const handleMeasureModeEnd = () => {
    setMeasureMode(false)
  }

  // 结果行点击处理
  const handleResultRowClick = (cell: any) => {
    const siteId = cell.siteId
    const sectorId = cell.sectorId

    // 更新选中状态（用于表格高亮）
    const sectorKey = `${siteId}-${sectorId}`
    setSelectedSectorKey(sectorKey)

    // 查找同步后的扇区
    const syncedSector = tacDataSyncService.findSector(siteId, sectorId)
    if (!syncedSector) {
      console.warn('[TACPage] 未找到同步后的扇区:', siteId, sectorId)
      return
    }

    // 简化：只设置高亮模式和跳转地图，不设置白名单
    const cellNetworkType = cell.networkType || taskResult?.networkType || 'LTE'
    mapRef.current?.setTACHighlightMode({
      selectedId: syncedSector.id,
      isSingularity: cell.isSingularity,
      tacValue: cell.existingTac || cell.tac,
      networkType: cellNetworkType
    })

    // 跳转地图到该小区位置
    const coords = [syncedSector.displayLat || syncedSector.latitude, syncedSector.displayLng || syncedSector.longitude]
    mapRef.current?.flyTo(coords as [number, number], 16, 0)

    console.log('[TACPage] 点击结果行，跳转地图', {
      siteId,
      sectorId,
      coords,
      tac: cell.existingTac || cell.tac,
      isSingularity: cell.isSingularity
    })
  }

  // 监听任务完成/失败，自动推进向导步骤（使用 localTaskResult 避免从历史任务误判）
  useEffect(() => {
    if (wizardStep === 'executing') {
      if (localTaskResult?.status === 'completed') { setWizardStep('completed'); setError(null) }
      else if (localTaskResult?.status === 'failed') { setWizardStep('cells_selected') }
    }
  }, [localTaskResult?.status, wizardStep])

  // === 向导步骤处理函数 ===
  const validateTaskName = (name: string): string | null => {
    if (!name.trim()) return '请输入任务名称'
    if (name.length > 25) return '任务名称不能超过25个字符'
    return null
  }

  const handleTaskNameChange = (value: string) => {
    if (value.length > 25) return
    setTaskName(value)
    setTaskNameError(null)
  }

  const handleCancel = () => {
    setWizardStep('idle'); setTaskName(''); setTaskNameError(null); setNextTaskError(null)
    setSelectedCellIdsSet(new Set()); setError(null)
    setConfig({ networkType: 'LTE' })
    setSingularityConfig({ searchRadius: 1500, singularityThreshold: 0.5 })
  }

  // ===== 上一步逻辑 =====
  const handleBack = useCallback(() => {
    if (wizardStep === 'task_created') {
      setWizardStep('idle'); setTaskName(''); setTaskNameError(null); setError(null)
    } else if (wizardStep === 'params_set') {
      setWizardStep('task_created'); setNextTaskError(null); setError(null)
    } else if (wizardStep === 'cells_selected') {
      setWizardStep('params_set'); setSelectedCellIdsSet(new Set()); setError(null)
    }
  }, [wizardStep])

  // ===== 统一的"下一步"逻辑 =====
  const handleNext = useCallback(() => {
    if (wizardStep === 'idle') {
      setWizardStep('task_created'); setTaskNameError(null); setError(null)
    } else if (wizardStep === 'task_created') {
      if (!config?.networkType) { setNextTaskError(t('tac.selectNetworkType') || '请选择网络类型'); return }
      const nameError = validateTaskName(taskName)
      if (nameError) { setTaskNameError(nameError); return }
      setNextTaskError(null); setTaskNameError(null)
      setWizardStep('params_set'); setError(null)
    } else if (wizardStep === 'params_set') {
      setNextTaskError(null); setWizardStep('cells_selected'); setSelectedCellIdsSet(new Set()); setError(null)
    } else if (wizardStep === 'cells_selected') {
      if (selectedCellIdsSet.size === 0) {
        setError(t('tac.noCellsSelected') || '请在小区选择列表中至少选择一个小区后再执行TAC核查')
        return
      }
      handleExecute()
    } else if (wizardStep === 'completed') {
      setActiveLeftTab('planning-result'); setShowMap(true)
    }
  }, [wizardStep, taskName, config, selectedCellIdsSet, t])

  const handleNewTask = () => { setWizardStep('task_created'); setTaskNameError(null); setError(null) }

  const handleParamsSetup = () => {
    if (!config?.networkType) { setNextTaskError(t('tac.selectNetworkType') || '请选择网络类型'); return }
    const nameError = validateTaskName(taskName)
    if (nameError) { setTaskNameError(nameError); return }
    setNextTaskError(null); setTaskNameError(null)
    setWizardStep('params_set'); setError(null)
  }

  const handleSelectCells = () => {
    setNextTaskError(null); setWizardStep('cells_selected'); setSelectedCellIdsSet(new Set()); setError(null)
  }

  const handleExecute = async () => {
    if (!config?.networkType) { setError(t('tac.selectNetworkType') || '请选择网络类型'); return }
    if (selectedCellIdsSet.size === 0) {
      setError(t('tac.noCellsSelected') || '请在小区选择列表中至少选择一个小区后再执行TAC核查')
      return
    }
    setLoading(true); setError(null); setLocalTaskResult(null)
    setActiveTaskId('tac_check', null); setWizardStep('executing'); errorCountRef.current = 0
    try {
      const fullConfig: any = { taskName: taskName, networkType: config!.networkType, enableSingularityCheck: true, singularityConfig: singularityConfig, selectedCellIds: Array.from(selectedCellIdsSet) }
      const response = await tacApi.plan(fullConfig)
      if (response.success && response.data) {
        const newTaskId = response.data.taskId
        setActiveTaskId('tac_check', newTaskId)
        startTask(newTaskId, 'tac_check', 'TAC核查开始', taskName, user?.username)
        const progressResponse = await tacApi.getProgress(newTaskId)
        if (progressResponse.success && progressResponse.data) { setLocalTaskResult(progressResponse.data as TACResultData) }
      } else { setError(response.message || (t('tac.startFailed') || '启动TAC核查任务失败')); setWizardStep('cells_selected') }
    } catch (err: any) {
      console.error('启动TAC核查失败:', err)
      setError(err.message || (t('tac.startFailed') || '启动TAC核查任务失败')); setWizardStep('cells_selected')
    } finally { setLoading(false) }
  }

  const handleExport = async (format: 'xlsx' | 'csv' = 'xlsx') => {
    if (!taskId || exportState !== 'idle') return

    setExportState('exporting')

    try {
      const blob = await tacApi.export(taskId, format)

      setExportState('success')
      if (exportTimerRef.current) clearTimeout(exportTimerRef.current)
      exportTimerRef.current = setTimeout(() => {
        setExportState('idle')
      }, 2000)

      // 创建下载链接
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url

      // 生成文件名（使用核查结果中的网络类型，实时获取本地时间戳）
      const networkType = taskResult?.networkType || config?.networkType || 'LTE'
      const currentTime = new Date()
      console.log('[TAC Export] Current time (UTC):', currentTime.toISOString())

      // 使用本地时间而不是UTC时间
      const year = currentTime.getFullYear()
      const month = String(currentTime.getMonth() + 1).padStart(2, '0')
      const day = String(currentTime.getDate()).padStart(2, '0')
      const hours = String(currentTime.getHours()).padStart(2, '0')
      const minutes = String(currentTime.getMinutes()).padStart(2, '0')
      const seconds = String(currentTime.getSeconds()).padStart(2, '0')
      const timestamp = `${year}${month}${day}${hours}${minutes}${seconds}`

      console.log('[TAC Export] Generated timestamp (local time):', timestamp)
      const filename = `TAC核查结果_${networkType}_${timestamp}.${format}`
      console.log('[TAC Export] Generated filename:', filename)

      link.download = filename
      document.body.appendChild(link)
      link.click()

      // 清理
      setTimeout(() => {
        document.body.removeChild(link)
        window.URL.revokeObjectURL(url)
      }, 100)

    } catch (err: any) {
      console.error('导出失败:', err)
      setExportState('idle')
      setError((t('tac.exportFailed') || '导出失败:') + (err.message || (t('tac.unknownError') || '未知错误')))
    }
  }

  // 从历史任务查看 - 跳转到结果页并自动打开地图
  const handleViewTask = async (task: any) => {
    try {
      const response = await tacApi.getResult(task.id)
      if (response?.success && response?.data) {
        const result = response.data as TACResultData
        viewedTaskIdRef.current = task.id // 必须在 setActiveTaskId 之前设置！
        setLocalTaskResult(result)
        setActiveTaskId('tac_check', task.id)
        setActiveLeftTab('planning-result')
        setShowMap(true)
        if (result.results) {
          const taskNetworkType = result.networkType || config?.networkType || 'LTE'
          const uniqueTACs = new Set<string>()
          result.results.forEach((cell: any) => {
            if (cell.tac) uniqueTACs.add(String(cell.tac))
            if (cell.existingTac) uniqueTACs.add(String(cell.existingTac))
          })
          uniqueTACs.forEach(tac => {
            tacColorMapper.getColor(tac, taskNetworkType)
          })
          tacDataSyncService.setTACResults({
            results: result.results,
            singularityCount: result.singularityCount || 0
          })
          if (mapRef.current) {
            mapRef.current.setSectorIdWhitelist(null, 'tac-check', taskNetworkType)
          }
        }
      }
    } catch (err: any) {
      console.error('加载TAC核查结果失败:', err)
      setError('加载核查结果失败: ' + (err.message || '未知错误'))
    }
  }

  // 搜索功能状态
  const [searchEnabled, setSearchEnabled] = useState(false)
  const [searchFilters, setSearchFilters] = useState({
    firstGroup: '',
    siteId: '',
    siteName: '',
    sectorId: '',
    sectorName: '',
    networkType: '',
    longitude: '',
    latitude: '',
    tac: '',
    existingTac: '',
    tacConsistent: '',
    isSingularity: '',
    suggestedTac: '',
    matched: ''
  })
  const [filteredResults, setFilteredResults] = useState<any[]>([])

  // 列宽状态
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    Object.fromEntries(COLUMNS.map(col => [col.key, col.defaultWidth]))
  )

  // 列宽拖拽状态
  const [resizingColumn, setResizingColumn] = useState<string | null>(null)
  const resizingStartX = useRef<number>(0)
  const resizingStartWidth = useRef<number>(0)

  // 处理列宽拖拽开始
  const handleResizeStart = useCallback((columnKey: string, startX: number) => {
    setResizingColumn(columnKey)
    resizingStartX.current = startX
    resizingStartWidth.current = columnWidths[columnKey]
    document.body.classList.add('resizing-column')
  }, [columnWidths])

  // 处理列宽拖拽中
  const handleResizeMove = useCallback((clientX: number) => {
    if (resizingColumn) {
      const deltaX = clientX - resizingStartX.current
      const newWidth = Math.max(50, resizingStartWidth.current + deltaX) // 最小宽度50px
      setColumnWidths(prev => ({
        ...prev,
        [resizingColumn]: newWidth
      }))
    }
  }, [resizingColumn])

  // 处理列宽拖拽结束
  const handleResizeEnd = useCallback(() => {
    setResizingColumn(null)
    document.body.classList.remove('resizing-column')
  }, [])

  // 全局鼠标事件监听
  useEffect(() => {
    if (resizingColumn) {
      const handleMouseMove = (e: MouseEvent) => {
        handleResizeMove(e.clientX)
      }
      const handleMouseUp = () => {
        handleResizeEnd()
      }
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      return () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [resizingColumn, handleResizeMove, handleResizeEnd])

  // 处理搜索过滤
  useEffect(() => {
    console.time('[TACPage] effect:searchFilter')
    if (taskResult?.status === 'completed' && taskResult.results) {
      if (searchEnabled) {
        const filtered = taskResult.results.filter(cell => {
          return (
            String(cell.firstGroup || '').toLowerCase().includes(searchFilters.firstGroup.toLowerCase()) &&
            String(cell.siteId || '').toLowerCase().includes(searchFilters.siteId.toLowerCase()) &&
            String(cell.siteName || '').toLowerCase().includes(searchFilters.siteName.toLowerCase()) &&
            String(cell.sectorId || '').toLowerCase().includes(searchFilters.sectorId.toLowerCase()) &&
            String(cell.sectorName || '').toLowerCase().includes(searchFilters.sectorName.toLowerCase()) &&
            String(cell.networkType || '').toLowerCase().includes(searchFilters.networkType.toLowerCase()) &&
            String(cell.longitude?.toString() || '').includes(searchFilters.longitude) &&
            String(cell.latitude?.toString() || '').includes(searchFilters.latitude) &&
            String(cell.tac || '').toLowerCase().includes(searchFilters.tac.toLowerCase()) &&
            String(cell.existingTac || '').toLowerCase().includes(searchFilters.existingTac.toLowerCase()) &&
            ((cell.tac && cell.existingTac) ?
              (normalizeTac(String(cell.tac)) === normalizeTac(String(cell.existingTac)) ? '是' : '否').includes(searchFilters.tacConsistent)
              : ''.includes(searchFilters.tacConsistent)
            ) &&
            (cell.isSingularity ? '是' : '否').includes(searchFilters.isSingularity) &&
            String(cell.suggestedTac || '').toLowerCase().includes(searchFilters.suggestedTac.toLowerCase()) &&
            (cell.matched ? '已匹配' : '未匹配').includes(searchFilters.matched)
          )
        })
        setFilteredResults(filtered)
      } else {
        setFilteredResults(taskResult.results)
      }
    }
    console.timeEnd('[TACPage] effect:searchFilter')
  }, [taskResult?.status, taskResult?.results, searchEnabled, searchFilters])

  // 处理搜索输入变化
  const handleSearchChange = (field: string, value: string) => {
    setSearchFilters(prev => ({
      ...prev,
      [field]: value
    }))
  }

  // 虚拟滚动状态
  const [scrollTop, setScrollTop] = useState(0)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  // 计算虚拟滚动的可见数据
  const virtualData = useMemo(() => {
    const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_COUNT)
    const endIndex = Math.min(
      filteredResults.length,
      Math.ceil((scrollTop + VISIBLE_COUNT * ITEM_HEIGHT) / ITEM_HEIGHT) + BUFFER_COUNT
    )
    return {
      startIndex,
      endIndex,
      visibleData: filteredResults.slice(startIndex, endIndex),
      totalHeight: filteredResults.length * ITEM_HEIGHT,
      offsetY: startIndex * ITEM_HEIGHT
    }
  }, [scrollTop, filteredResults])

  // 处理滚动事件
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  // 重置滚动位置当过滤结果变化时
  useEffect(() => {
    setScrollTop(0)
    if (tableContainerRef.current) {
      tableContainerRef.current.scrollTop = 0
    }
  }, [filteredResults])

  // 加载小区列表数据
  const loadCellList = useCallback(async () => {
    setCellListLoading(true)
    try {
      const data = await getCellList()
      setCellListData({
        lte: data.lte || [],
        nr: data.nr || []
      })
    } catch (err) {
      console.error('[TACPage] 加载小区列表失败:', err)
    } finally {
      setCellListLoading(false)
    }
  }, [])

  useEffect(() => {
    console.time('[TACPage] effect:loadCellList')
    loadCellList()
    console.timeEnd('[TACPage] effect:loadCellList')
  }, [loadCellList])

  // 清理导出动画定时器
  useEffect(() => {
    return () => {
      if (exportTimerRef.current) clearTimeout(exportTimerRef.current)
    }
  }, [])

  // 性能追踪：首次提交时间
  useEffect(() => {
    if (!perfRef.current.firstCommitLogged) {
      perfRef.current.firstCommitLogged = true
      console.log('[TACPage] 首次渲染完成，总计', (performance.now() - perfRef.current.mountTime).toFixed(0), 'ms')
    }
  }, [])

  const toggleCellSelection = (cellId: string) => {
    setSelectedCellIdsSet(prev => {
      const next = new Set(prev)
      if (next.has(cellId)) next.delete(cellId)
      else next.add(cellId)
      return next
    })
  }

  const toggleSelectAll = () => {
    const networkType = (config?.networkType || 'LTE') as 'LTE' | 'NR'
    const sectors = networkType === 'LTE' ? cellListData.lte : cellListData.nr
    const allIds = sectors.map(s => s.id)
    const allSelected = allIds.length > 0 && allIds.every(id => selectedCellIdsSet.has(id))
    setSelectedCellIdsSet(prev => {
      const next = new Set(prev)
      if (allSelected) allIds.forEach(id => next.delete(id))
      else allIds.forEach(id => next.add(id))
      return next
    })
  }

  const clearSelections = () => setSelectedCellIdsSet(new Set())

  // 上传待规划小区文件
  const handleUploadCellFile = () => {
    cellFileInputRef.current?.click()
  }

  const handleCellFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.name.toLowerCase().startsWith('cell-tree')) {
      setError(t('tac.cellFilePrefixError') || '文件名必须以"cell-tree"开头')
      e.target.value = ''
      return
    }

    setCellFileUploading(true)
    setError(null)
    try {
      // 1. 本地解析文件，提取小区ID
      const extractedIds = await extractCellIdsFromFile(file)
      if (extractedIds.length === 0) {
        setError(t('tac.noCellIdsExtracted') || '未能从文件中提取到小区ID，请检查文件格式')
        return
      }

      // 2. 获取并刷新小区选择列表（匹配优先于上传）
      clearCellListCache()
      setCellListLoading(true)
      const data = await getCellList()
      setCellListData({ lte: data.lte || [], nr: data.nr || [] })
      setCellListLoading(false)

      // 3. 匹配小区ID并自动勾选
      const allAvailableIds = [...data.lte, ...data.nr].map(item => item.id)
      const matchedIds = matchCellIds(extractedIds, allAvailableIds)

      if (matchedIds.length > 0) {
        setSelectedCellIdsSet(new Set(matchedIds))
      } else {
        setError(t('tac.noMatchingCells') || '未匹配到任何小区，请检查文件内容与当前工参数据是否一致')
      }
    } catch (err: any) {
      console.error('[TACPage] 处理待规划小区文件失败:', err)
      setError(err.message || (t('tac.cellFileUploadFailed') || '待规划小区文件处理失败'))
    } finally {
      setCellFileUploading(false)
      e.target.value = ''
    }
  }

  // 下载待规划小区模板（根据当前网络类型动态生成）
  const handleDownloadCellTemplate = () => {
    try {
      const networkType = (config?.networkType as 'LTE' | 'NR') || 'LTE'
      downloadCellTreeTemplate(networkType)
    } catch (err: any) {
      console.error('[TACPage] 下载模板失败:', err)
      alert(`${t('data.downloadTemplateFailed') || '下载模板失败'}: ${err.message || ''}`)
    }
  }

  const isRunning = loading || taskResult?.status === 'processing'

  return (
    <div className="h-full flex flex-col p-4 min-h-0">
      {/* 页面标题 */}
      <h1 className="text-3xl font-bold mb-6 shrink-0">{t('tac.title') || 'TAC核查'}</h1>

      {/* 错误提示 */}
      {error && (
        <div className="mb-6 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2 shrink-0">
          <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-red-500 text-sm font-medium">{t('tac.failed') || '核查失败'}</p>
            <p className="text-red-600 text-xs">{error}</p>
          </div>
        </div>
      )}

      {/* 小区选择与结果面板（页签切换） */}
      <div className="bg-card p-4 rounded-lg border border-border flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* 页签切换栏 */}
        <div className="flex items-center gap-1 mb-3 border-b border-border shrink-0">
          {/* 历史任务 tab */}
          <button
            onClick={() => !isRunning && setActiveLeftTab('history')}
            className={activeLeftTab === 'history' ? btn.activeTab : btn.ghost}
            disabled={isRunning}
          >
            {t('common.historyTask') || '历史任务'}
            <span className={btn.badgeCount}>{tacCheckHistoryCount}</span>
          </button>

          {/* 新建任务 tab */}
          <button
            onClick={() => !isRunning && setActiveLeftTab('task-config')}
            className={activeLeftTab === 'task-config' ? btn.activeTab : btn.ghost}
            disabled={isRunning}
          >
            {t('common.newTask') || '新建任务'}
          </button>

          {/* 核查结果 tab */}
          <button
            onClick={() => setActiveLeftTab('planning-result')}
            className={activeLeftTab === 'planning-result' ? btn.activeTab : btn.ghost}
          >
            {t('tac.checkResult') || '核查结果'}
            {taskResult?.status === 'completed' && (
              <span className={btn.badgeSuccess}>✓</span>
            )}
            {taskResult?.status === 'failed' && (
              <span className={btn.badgeError}>!</span>
            )}
            {taskResult?.status === 'processing' && (
              <span className="ml-2 inline-flex items-center">
                <Loader2 size={12} className="animate-spin text-blue-500" />
              </span>
            )}
          </button>
        </div>

        {/* 页签内容 */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {activeLeftTab === 'task-config' && (
                <div className="flex flex-col h-full overflow-hidden">
                {/* 步骤指示器（执行步骤显示进度百分比） */}
                <StepIndicator
                  currentStep={
                    wizardStep === 'idle' || wizardStep === 'task_created' ? 0
                    : wizardStep === 'params_set' ? 1
                    : wizardStep === 'cells_selected' ? 2
                    : wizardStep === 'executing' ? 3
                    : 4
                  }
                  executingProgress={wizardStep === 'executing' ? (taskResult?.progress ?? 0) : undefined}
                />
                <div className="flex flex-row gap-4 flex-1 min-h-0 overflow-hidden">
                  {/* 左侧：任务名称 + 参数设置 */}
                  <div className="flex flex-col overflow-y-auto flex-1 min-w-0">
                    <div className="bg-card border border-border rounded-xl p-6 w-full">
                      {nextTaskError && (
                        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3 text-red-700">
                          <AlertCircle size={18} />
                          <span className="text-sm">{nextTaskError}</span>
                          <button onClick={() => setNextTaskError(null)} className="ml-auto text-sm underline">{t('tac.close') || '关闭'}</button>
                        </div>
                      )}
                      {/* 任务名称 */}
                      <div className="mb-6">
                        <label className="block text-sm font-semibold mb-2">{t('common.taskName') || '任务名称'}</label>
                        <input
                          type="text" value={taskName}
                          onChange={(e) => handleTaskNameChange(e.target.value)}
                          disabled={wizardStep !== 'idle' && wizardStep !== 'task_created'}
                          placeholder={t('common.taskNamePlaceholder') || '请输入任务名称'}
                          maxLength={25}
                          className={`w-full px-3 py-2 text-sm bg-background border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 disabled:cursor-not-allowed ${taskNameError ? 'border-red-400 focus:ring-red-400' : wizardStep === 'task_created' && !taskName.trim() ? 'input-pulse' : 'border-border'}`}
                        />
                        {taskNameError && <p className="mt-1 text-xs text-red-500">{taskNameError}</p>}
                        <p className="mt-1 text-xs text-muted-foreground">{taskName.length}/25</p>
                      </div>

                      {/* TAC核查参数 */}
                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs font-medium mb-1">{t('tac.networkType') || '网络类型'}</label>
                          <div className="flex gap-4">
                            <label className="flex items-center gap-2 text-sm cursor-pointer">
                              <input type="radio" name="tacNetworkType" value="LTE" checked={config?.networkType === 'LTE'} onChange={() => setConfig({ networkType: 'LTE' })} disabled={wizardStep !== 'params_set'} className="w-4 h-4 disabled:opacity-60" />LTE
                            </label>
                            <label className="flex items-center gap-2 text-sm cursor-pointer">
                              <input type="radio" name="tacNetworkType" value="NR" checked={config?.networkType === 'NR'} onChange={() => setConfig({ networkType: 'NR' })} disabled={wizardStep !== 'params_set'} className="w-4 h-4 disabled:opacity-60" />NR
                            </label>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                          <div>
                            <label className="block text-xs font-medium mb-0.5">{t('tac.searchRadius') || '搜索半径(m)'}</label>
                            <input type="number" value={singularityConfig.searchRadius} onChange={(e) => setSingularityConfig(prev => ({ ...prev, searchRadius: parseInt(e.target.value) || 0 }))} disabled={wizardStep !== 'params_set'} step={100} className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 disabled:cursor-not-allowed" />
                          </div>
                          <div>
                            <label className="block text-xs font-medium mb-0.5">{t('tac.singularityThreshold') || '异TAC阈值'}</label>
                            <input type="number" value={singularityConfig.singularityThreshold} onChange={(e) => setSingularityConfig(prev => ({ ...prev, singularityThreshold: parseFloat(e.target.value) || 0 }))} disabled={wizardStep !== 'params_set'} step={0.1} className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 disabled:cursor-not-allowed" />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 右侧：小区选择 */}
                  <div className="flex flex-col flex-1 min-w-0 border-l border-border pl-4 overflow-hidden">
                    <div className="flex flex-col h-full overflow-hidden">
                      <input type="file" ref={cellFileInputRef} onChange={handleCellFileChange} accept=".xlsx,.xls" className="hidden" />
                      <CellSelectionTable
                        sectors={(() => { const nt = (config?.networkType || 'LTE') as 'LTE' | 'NR'; return nt === 'LTE' ? cellListData.lte : cellListData.nr })()}
                        selectedCellIds={selectedCellIdsSet}
                        onToggleCell={wizardStep === 'cells_selected' && !isRunning ? toggleCellSelection : () => {}}
                        onSelectAll={wizardStep === 'cells_selected' && !isRunning ? toggleSelectAll : () => {}}
                        onClearSelections={wizardStep === 'cells_selected' && !isRunning ? clearSelections : () => {}}
                        selectedCountText={(t('tac.selectedCount') || '已选中 {{count}} 个小区').replace('{{count}}', String(selectedCellIdsSet.size))}
                        loading={cellListLoading}
                        onUploadCellFile={wizardStep === 'cells_selected' ? handleUploadCellFile : undefined}
                        onDownloadCellTemplate={wizardStep === 'cells_selected' ? handleDownloadCellTemplate : undefined}
                        uploading={cellFileUploading}
                        disabled={wizardStep !== 'cells_selected' || isRunning}
                        columnLabels={{ siteId: t('tac.siteId') || '基站ID', cellId: t('tac.cellId') || '小区ID', cellName: t('tac.cellName') || '小区名称', selectAll: t('tac.selectAll') || '全选', clearSelections: t('tac.clearSelections') || '清空选择', uploadCellFile: t('tac.uploadCellFile') || '上传待规划小区文件', downloadCellTemplate: t('tac.downloadCellTemplate') || '下载待规划小区模板' }}
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
            /* 历史任务面板 */
            <div className="flex flex-col h-full overflow-hidden">
              <HistoryTable
                taskType="tac_check"
                typeLabel="TAC核查"
                onSelectTask={(task) => {
                  if (task.result) {
                    const result = task.result as TACResultData
                    setLocalTaskResult(result)
                    setActiveTaskId('tac_check', task.id)
                    setActiveLeftTab('planning-result')
                    if (result.results) {
                      const taskNetworkType = result.networkType || config?.networkType || 'LTE'
                      const uniqueTACs = new Set<string>()
                      result.results.forEach((cell: any) => {
                        if (cell.tac) uniqueTACs.add(String(cell.tac))
                        if (cell.existingTac) uniqueTACs.add(String(cell.existingTac))
                      })
                      uniqueTACs.forEach(tac => {
                        tacColorMapper.getColor(tac, taskNetworkType)
                      })
                      tacDataSyncService.setTACResults({
                        results: result.results,
                        singularityCount: result.singularityCount || 0
                      })
                      if (mapRef.current) {
                        mapRef.current.setSectorIdWhitelist(null, 'tac-check', taskNetworkType)
                      }
                    }
                  }
                }}
                onViewTask={handleViewTask}
                getCellCount={getCellCount}
              />
            </div>
          )}

          {activeLeftTab === 'planning-result' && (

            /* 规划结果面板 */
            <div className="flex flex-col h-full min-h-0 overflow-hidden">
              {taskResult ? (
                <>
                  {/* 统计卡片 */}
                  <div className="mb-3 shrink-0">
                    <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
                      <div className="px-2.5 py-1.5 bg-muted/50 rounded-md">
                        <p className="text-[10px] text-muted-foreground">{t('tac.networkType') || '网络类型'}</p>
                        <p className="text-sm font-semibold">{taskResult.networkType || '-'}</p>
                      </div>
                      <div className="px-2.5 py-1.5 bg-muted/50 rounded-md">
                        <p className="text-[10px] text-muted-foreground">{t('tac.totalCells') || '总小区'}</p>
                        <p className="text-sm font-semibold">{taskResult.totalCells || 0}</p>
                      </div>
                      <div className="px-2.5 py-1.5 bg-green-500/10 border border-green-500/20 rounded-md">
                        <p className="text-[10px] text-green-600">{t('tac.matched') || '匹配成功'}</p>
                        <p className="text-sm font-semibold text-green-600">{taskResult.matchedCells || 0}</p>
                      </div>
                      <div className="px-2.5 py-1.5 bg-orange-500/10 border border-orange-500/20 rounded-md">
                        <p className="text-[10px] text-orange-600">{t('tac.unmatched') || '未匹配'}</p>
                        <p className="text-sm font-semibold text-orange-600">{taskResult.unmatchedCells || 0}</p>
                      </div>
                      <div className="px-2.5 py-1.5 bg-red-500/10 border border-red-500/20 rounded-md">
                        <p className="text-[10px] text-red-600">{t('tac.tacMismatch') || 'TAC错配'}</p>
                        <p className="text-sm font-semibold text-red-600">{taskResult.mismatchedCells || 0}</p>
                      </div>
                      <div className="px-2.5 py-1.5 bg-blue-500/10 border border-blue-500/20 rounded-md">
                        <p className="text-[10px] text-blue-600">{t('tac.mismatchRate') || '错配率'}</p>
                        <p className="text-sm font-semibold text-blue-600">
                          {taskResult.matchedCells > 0 ? ((taskResult.mismatchedCells / taskResult.matchedCells) * 100).toFixed(1) : '0'}%
                        </p>
                      </div>
                      <div className="px-2.5 py-1.5 bg-purple-500/10 border border-purple-500/20 rounded-md">
                        <p className="text-[10px] text-purple-600">{t('tac.singularity') || 'TAC插花'}</p>
                        <p className="text-sm font-semibold text-purple-600">{taskResult.singularityCount || 0}</p>
                      </div>
                      <div className="px-2.5 py-1.5 bg-muted/50 rounded-md">
                        <p className="text-[10px] text-muted-foreground">{t('tac.matchRate') || '匹配率'}</p>
                        <p className="text-sm font-semibold">
                          {taskResult.totalCells > 0 ? ((taskResult.matchedCells / taskResult.totalCells) * 100).toFixed(1) : '0'}%
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* 两栏布局：结果表格 + 地图 */}
                  <div className="flex flex-col lg:flex-row gap-4 flex-1 min-h-0 overflow-hidden">
                    {/* 左列：结果表格 */}
                    <div className="flex flex-col flex-1 min-w-0 min-h-0">
                      {taskResult.status === 'failed' && taskResult.error && (
                        <div className="mb-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                          <div className="flex items-start gap-2">
                            <AlertCircle size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
                            <p className="text-xs text-red-600">{taskResult.error}</p>
                          </div>
                        </div>
                      )}
                      {taskResult.status === 'completed' && taskResult.results && (
                        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                          <div className="flex justify-end items-center gap-2 mb-3 shrink-0">
                            {taskResult.status === 'completed' && (
                              <button
                                onClick={() => handleExport('xlsx')}
                                disabled={exportState !== 'idle'}
                                className={`
                                  relative flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm
                                  transition-all duration-300 ease-out overflow-hidden
                                  ${exportState === 'idle' ? 'bg-muted hover:bg-muted/80 text-foreground' : ''}
                                  ${exportState === 'exporting' ? 'bg-blue-500/10 text-blue-600 border border-blue-500/30' : ''}
                                  ${exportState === 'success' ? 'bg-green-500/10 text-green-600 border border-green-500/30' : ''}
                                `}
                              >
                                {/* 导出动画图标 */}
                                <span className="relative flex items-center justify-center w-4 h-4">
                                  <Download
                                    size={16}
                                    className={`
                                      absolute transition-all duration-300
                                      ${exportState === 'exporting' ? 'opacity-0 scale-75' : 'opacity-100 scale-100'}
                                    `}
                                  />
                                  {exportState === 'exporting' && (
                                    <svg
                                      className="animate-spin text-blue-500"
                                      width={16}
                                      height={16}
                                      viewBox="0 0 24 24"
                                      fill="none"
                                    >
                                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-20" />
                                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                                    </svg>
                                  )}
                                  {exportState === 'success' && (
                                    <svg
                                      className="text-green-500 animate-[ping_0.3s_ease-out]"
                                      width={16}
                                      height={16}
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2.5"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                  )}
                                </span>

                                {/* 文字内容 */}
                                <span className="relative">
                                  {exportState === 'idle' && (t('tac.export') || '导出')}
                                  {exportState === 'exporting' && (
                                    <span className="inline-flex items-center gap-0.5">
                                      {t('tac.exporting') || '导出中'}
                                      <span className="inline-flex gap-0.5">
                                        <span className="w-1 h-1 bg-current rounded-full animate-[bounce_0.6s_infinite]" style={{ animationDelay: '0s' }} />
                                        <span className="w-1 h-1 bg-current rounded-full animate-[bounce_0.6s_infinite]" style={{ animationDelay: '0.15s' }} />
                                        <span className="w-1 h-1 bg-current rounded-full animate-[bounce_0.6s_infinite]" style={{ animationDelay: '0.3s' }} />
                                      </span>
                                    </span>
                                  )}
                                  {exportState === 'success' && (t('tac.exportSuccess') || '已导出')}
                                </span>
                              </button>
                            )}
                            <button onClick={() => {
                                if (searchEnabled) {
                                  setSearchFilters({
                                    firstGroup: '', siteId: '', siteName: '', sectorId: '', sectorName: '',
                                    networkType: '', longitude: '', latitude: '', tac: '', existingTac: '',
                                    tacConsistent: '', isSingularity: '', suggestedTac: '', matched: ''
                                  })
                                  setFilteredResults([])
                                }
                                setSearchEnabled(!searchEnabled)
                              }}
                              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors text-sm ${searchEnabled ? 'bg-blue-400 text-white hover:bg-blue-500' : 'bg-muted hover:bg-muted/80'}`}>
                              <Search size={16} />
                              {t('tac.search') || '搜索'}
                            </button>
                            <button
                              onClick={() => setShowMap(prev => !prev)}
                              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors text-sm ${
                                showMap
                                  ? 'bg-blue-400 text-white hover:bg-blue-500'
                                  : 'bg-muted hover:bg-muted/80'
                              }`}
                            >
                              <Eye size={16} />
                              {t('tac.showMap') || '地图展示'}
                            </button>
                          </div>
                          <div ref={tableContainerRef} onScroll={handleScroll}
                            className="overflow-x-auto overflow-y-auto flex-1 min-h-0">
                    <table className="w-full text-xs border-collapse table-fixed">
                      <thead className="sticky top-0 z-20 bg-background border-b border-border shadow-sm">
                        <tr>
                          {COLUMNS.map((column) => (
                            <th
                              key={column.key}
                              className="text-left p-2 font-medium bg-background z-20 relative group border-r border-border"
                              style={{ width: `${columnWidths[column.key]}px`, minWidth: `${columnWidths[column.key]}px` }}
                            >
                              <span className="block pr-3">{t(`tac.column.${column.key}`) || column.label}</span>
                              {searchEnabled && (
                                <input
                                  type="text"
                                  value={searchFilters[column.key as keyof typeof searchFilters]}
                                  onChange={(e) => handleSearchChange(column.key, e.target.value)}
                                  placeholder={t('tac.search') || '搜索'}
                                  className="mt-1 w-full p-1 border border-border rounded text-[10px] text-gray-900 bg-gray-100 placeholder:text-gray-400"
                                />
                              )}
                              {/* 拖拽手柄 */}
                              <div
                                className={`table-resize-handle ${resizingColumn === column.key ? 'resizing' : ''}`}
                                onMouseDown={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleResizeStart(column.key, e.clientX)
                                }}
                              >
                                <GripVertical size={12} className="opacity-0 group-hover:opacity-40 text-muted-foreground absolute right-0.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                              </div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr style={{ height: `${virtualData.offsetY}px` }}>
                          <td colSpan={COLUMNS.length}></td>
                        </tr>
                        {virtualData.visibleData.map((cell, index) => {
                          const actualIndex = virtualData.startIndex + index
                          const sectorKey = `${cell.siteId}-${cell.sectorId}`
                          const isSelected = sectorKey === selectedSectorKey
                          return (
                            <tr
                              key={`${cell.sectorId}-${actualIndex}`}
                              className={`border-b hover:bg-muted/50 cursor-pointer ${isSelected ? 'bg-blue-50/50 dark:bg-blue-900/20' : ''
                                }`}
                              style={{ height: `${ITEM_HEIGHT}px` }}
                              onClick={() => handleResultRowClick(cell)}
                            >
                              {COLUMNS.map((column) => {
                                const width = columnWidths[column.key]
                                let cellContent: any
                                let cellClassName = 'p-2 border-r border-border'

                                switch (column.key) {
                                  case 'firstGroup':
                                    cellContent = cell.firstGroup || '-'
                                    cellClassName += ' truncate'
                                    break
                                  case 'siteId':
                                    cellContent = cell.siteId
                                    cellClassName += ' font-mono truncate'
                                    break
                                  case 'siteName':
                                    cellContent = cell.siteName
                                    cellClassName += ' truncate'
                                    break
                                  case 'sectorId':
                                    cellContent = cell.sectorId
                                    cellClassName += ' font-mono truncate'
                                    break
                                  case 'sectorName':
                                    cellContent = cell.sectorName
                                    cellClassName += ' truncate'
                                    break
                                  case 'networkType':
                                    cellContent = (
                                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${cell.networkType === 'LTE'
                                          ? 'bg-blue-500/10 text-blue-600'
                                          : 'bg-purple-500/10 text-purple-600'
                                        }`}>
                                        {cell.networkType}
                                      </span>
                                    )
                                    break
                                  case 'longitude':
                                    cellContent = cell.longitude?.toFixed(6)
                                    cellClassName += ' font-mono truncate'
                                    break
                                  case 'latitude':
                                    cellContent = cell.latitude?.toFixed(6)
                                    cellClassName += ' font-mono truncate'
                                    break
                                  case 'tac':
                                    cellContent = cell.tac || '-'
                                    cellClassName += ' font-mono truncate'
                                    break
                                  case 'existingTac':
                                    cellContent = cell.existingTac || '-'
                                    cellClassName += ' font-mono truncate'
                                    break
                                  case 'tacConsistent':
                                    cellContent = cell.tac && cell.existingTac ? (
                                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${normalizeTac(String(cell.tac)) === normalizeTac(String(cell.existingTac))
                                          ? 'bg-green-500/10 text-green-600'
                                          : 'bg-red-500/10 text-red-600'
                                        }`}>
                                        {normalizeTac(String(cell.tac)) === normalizeTac(String(cell.existingTac)) ? (t('tac.yes') || '是') : (t('tac.no') || '否')}
                                      </span>
                                    ) : (
                                      <span className="px-2 py-1 bg-muted/50 text-muted-foreground rounded">
                                        -
                                      </span>
                                    )
                                    break
                                  case 'isSingularity':
                                    cellContent = cell.existingTac && cell.existingTac !== '-' ? (
                                      cell.isSingularity ? (
                                        <span className="px-2 py-1 bg-purple-500/10 text-purple-600 rounded">
                                          {t('tac.yes') || '是'}
                                        </span>
                                      ) : (
                                        <span className="px-2 py-1 bg-muted/50 text-muted-foreground rounded">
                                          {t('tac.no') || '否'}
                                        </span>
                                      )
                                    ) : (
                                      <span className="px-2 py-1 bg-muted/50 text-muted-foreground rounded">
                                        -
                                      </span>
                                    )
                                    break
                                  case 'suggestedTac':
                                    cellContent = cell.existingTac && cell.existingTac !== '-' && cell.suggestedTac ? (
                                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${cell.isSingularity
                                          ? 'bg-purple-500/10 text-purple-600'
                                          : 'bg-blue-500/10 text-blue-600'
                                        }`}>
                                        {cell.suggestedTac}
                                      </span>
                                    ) : (
                                      <span className="px-2 py-1 bg-muted/50 text-muted-foreground rounded">
                                        -
                                      </span>
                                    )
                                    break
                                  case 'matched':
                                    cellContent = cell.matched ? (
                                      <span className="px-2 py-1 bg-green-500/10 text-green-600 rounded">
                                        {t('tac.matched') || '已匹配'}
                                      </span>
                                    ) : (
                                      <span className="px-2 py-1 bg-orange-500/10 text-orange-600 rounded">
                                        {t('tac.unmatched') || '未匹配'}
                                      </span>
                                    )
                                    break
                                  default:
                                    cellContent = null
                                }

                                return (
                                  <td
                                    key={column.key}
                                    className={cellClassName}
                                    style={{ width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` }}
                                  >
                                    {cellContent}
                                  </td>
                                )
                              })}
                            </tr>
                          )
                        })}
                        <tr style={{ height: `${virtualData.totalHeight - virtualData.offsetY - virtualData.visibleData.length * ITEM_HEIGHT}px` }}>
                          <td colSpan={COLUMNS.length}></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

            </div>

            {/* 右列：地图窗口 - 可折叠 */}
            <div
              className="overflow-hidden transition-[width] duration-300 flex-shrink-0 flex flex-col"
              style={{ width: showMap ? '50%' : '0px' }}
            >
              <div className="bg-card rounded-lg border border-border p-3 flex-1 flex flex-col relative min-h-0 min-w-[600px]">
                {(showMap || mapEverLoadedRef.current) && (
                  <>
                    {!mapEverLoadedRef.current && (mapEverLoadedRef.current = true)}
                    <OnlineMap
                      ref={mapRef}
                      mode="tac-check"
                      onSectorClick={handleMapSectorClick}
                      measureMode={measureMode}
                      onMeasureModeEnd={handleMeasureModeEnd}
                    />
                    <TACLegend
                      visible={isLegendVisible}
                      onToggleVisible={() => setIsLegendVisible(!isLegendVisible)}
                      networkType={taskResult?.networkType || config?.networkType || 'LTE'}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground flex-col">
          <List size={48} className="mb-4 opacity-30" />
          {wizardStep === 'idle' ? (
            <p>{t('common.configureFirst') || '请先点击"新建"按钮创建任务'}</p>
          ) : (
            <p>选择网络类型后点击「开始核查」查看结果</p>
          )}
        </div>
      )}
            </div>
          )}
        </div>
      </div>

    </div>
  )
}
