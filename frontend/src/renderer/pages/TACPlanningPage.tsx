import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Download, Loader2, AlertCircle, CheckCircle2, Search, GripVertical, Check, List, Save } from 'lucide-react'
import { tacPlanningApi, dataApi } from '../services/api'
import { useTACPlanningStore } from '../store/tacPlanningStore'
import { useTaskStore, type Task } from '../store/taskStore'
import { useAuthStore } from '../store/authStore'
import { btn } from '../utils/buttonStyles'
import type { RenderSectorData, CellListItem } from '../services/mapDataService'
import { mapDataService, getCellList, clearCellListCache } from '../services/mapDataService'
import { useTranslation } from 'react-i18next'
import { CellSelectionTable } from '../components/CellSelectionTable'
import { HistoryTable } from '../components/HistoryTable'
import { StepIndicator } from '../components/StepIndicator'
import { WizardFooter } from '../components/WizardFooter'
import { extractCellIdsFromFile, matchCellIds, downloadCellTreeTemplate } from '../utils/cellFileHelper'
import { triggerDataRefresh, DATA_REFRESH_EVENT } from '../store/dataStore'
import type { ApiResponse } from '@shared/types'

// 虚拟滚动配置
const ITEM_HEIGHT = 48 // 每行高度
const VISIBLE_COUNT = 20 // 可见行数
const BUFFER_COUNT = 5 // 缓冲行数

// 列配置
const COLUMNS = [
  { key: 'siteId', label: '基站ID', defaultWidth: 100 },
  { key: 'siteName', label: '基站名称', defaultWidth: 150 },
  { key: 'sectorId', label: '小区ID', defaultWidth: 80 },
  { key: 'sectorName', label: '小区名称', defaultWidth: 200 },
  { key: 'longitude', label: '经度', defaultWidth: 90 },
  { key: 'latitude', label: '纬度', defaultWidth: 90 },
  { key: 'tac', label: '被分配TAC', defaultWidth: 80 },
  { key: 'status', label: '规划状态', defaultWidth: 80 }
] as const

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
    results: any[]
    startTime: string
    endTime?: string
    error?: string
    exportPath?: string
}

const MAX_ERRORS = 5

type WizardStep = 'idle' | 'task_created' | 'params_set' | 'cells_selected' | 'executing' | 'completed'

export function TACPlanningPage() {
    const { t } = useTranslation()
    const user = useAuthStore((s) => s.user)
    const [taskName, setTaskName] = useState('')
    const [taskNameError, setTaskNameError] = useState<string | null>(null)
    const [nextTaskError, setNextTaskError] = useState<string | null>(null)
    const [wizardStep, setWizardStep] = useState<WizardStep>('idle')
    const { taskId, config, result, setTaskId, setConfig, setResult, clearTAC, activeLeftTab, setActiveLeftTab } = useTACPlanningStore()
    const { startTask, updateTaskProgress, completeTask, failTask, syncHistoryFromBackend, setActiveTaskId,
      startGlobalPolling, stopGlobalPolling, isGlobalPollingActive } = useTaskStore()
    const [loading, setLoading] = useState(false)
    const storeTask = useTaskStore(s => taskId ? s.tasks[taskId] : undefined)
    const [error, setError] = useState<string | null>(null)
    const taskResult = result as TACResultData | null
    const tacPlanningHistoryCount = useTaskStore(s => Object.values(s.tasks).filter(t => t.type === 'tac_planning').length)

    // 选中的小区ID集合（格式：sector.id，如 siteId_sectorId）
    const [selectedCellIds, setSelectedCellIds] = useState<Set<string>>(new Set())
    // 小区列表数据（从轻量API获取）
    const [cellListData, setCellListData] = useState<{ lte: CellListItem[]; nr: CellListItem[] }>({ lte: [], nr: [] })
    const [cellListLoading, setCellListLoading] = useState(false)
    const [cellFileUploading, setCellFileUploading] = useState(false)
    const cellFileInputRef = useRef<HTMLInputElement>(null)
    const viewedTaskIdRef = useRef<string | null>(null)
    const errorCountRef = useRef(0)

    // ===== 状态重置 =====
    const resetConfig = useCallback(() => {
      setTaskName('')
      setTaskNameError(null)
      setWizardStep('idle')
      setSelectedCellIds(new Set())
      setActiveTaskId('tac_planning', null)
      setResult(null)
      setError(null)
      clearTAC()
    }, [setActiveTaskId, clearTAC])

    useEffect(() => {
      if (activeLeftTab === 'task-config') { resetConfig() }
    }, [activeLeftTab, resetConfig])

    // ===== 结果自动加载 =====
    useEffect(() => {
      if (activeLeftTab === 'planning-result') {
        // 如果用户通过"查看"按钮加载了特定任务的结果，不要自动加载最新的
        if (viewedTaskIdRef.current) {
          return
        }
        const loadLatest = async () => {
          await syncHistoryFromBackend('tac_planning')
          const tasks = useTaskStore.getState().tasks
          const tacPlanTasks = Object.values(tasks)
            .filter(t => t.type === 'tac_planning')
            .sort((a, b) => {
              const aTime = a.endTime || a.startTime || 0
              const bTime = b.endTime || b.startTime || 0
              return bTime - aTime
            })
          if (tacPlanTasks.length > 0) {
            const latest = tacPlanTasks[0]
            // 如果缺少完整 results（来自 resultSummary），尝试从 API 重新获取
            if (latest.result && !latest.result.results && latest.id) {
              try {
                const response = await tacPlanningApi.getResult(latest.id)
                if (response?.success && response?.data?.results) {
                  setResult(response.data as TACResultData)
                  setTaskId(latest.id)
                  setWizardStep('completed')
                  return
                }
              } catch (fetchErr: any) {
                console.warn('[TACPlanningPage] 获取完整规划结果失败，使用缓存摘要:', fetchErr?.message)
              }
            }
            if (latest.result) {
              setResult(latest.result as TACResultData)
              setTaskId(latest.id)
              setWizardStep('completed')
            }
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

    // ===== 应用 TAC 结果到全量工参 =====
    const [applyingToParams, setApplyingToParams] = useState(false)
    const [applySuccess, setApplySuccess] = useState(false)

    const pollApplyTACResult = useCallback(async (applyTaskId: string, timeout = 30000): Promise<any> => {
      const startTime = Date.now()
      while (Date.now() - startTime < timeout) {
        await new Promise(r => setTimeout(r, 1000))
        try {
          const progress = await tacPlanningApi.getApplyProgress(applyTaskId)
          if (progress?.data?.status === 'completed') {
            return await tacPlanningApi.getApplyResult(applyTaskId)
          }
          if (progress?.data?.status === 'failed') {
            throw new Error(progress?.data?.error || '应用失败')
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
        const response: ApiResponse<any> = await tacPlanningApi.applyToParams(task.id)
        const data = response?.data

        // Phase 1 可能已内联返回结果
        let updatedCount: number | undefined = data?.result?.updatedCount
        if (updatedCount === undefined && data?.taskId) {
          const resultData = await pollApplyTACResult(data.taskId)
          updatedCount = resultData?.data?.updatedCount
        }

        if (updatedCount !== undefined) {
          // 标记任务为已应用
          tacPlanningApi.markApplied(task.id).catch(e =>
            console.warn('[TACPlanningPage] 标记已应用失败:', e?.message)
          )
          mapDataService.clearCache().catch(e =>
            console.warn('[TACPlanningPage] 清理地图缓存失败:', e?.message)
          )
          setApplySuccess(true)
          triggerDataRefresh()
          return true
        }
        throw new Error('应用失败：未获取到更新结果')
      } catch (err: any) {
        console.error('应用TAC结果失败:', err)
        alert(err.message || '应用失败')
        return false
      } finally {
        setApplyingToParams(false)
      }
    }, [pollApplyTACResult])

    // 页面加载时检查任务是否仍然存在
    useEffect(() => {
        const checkTaskExists = async () => {
            if (taskId && result?.status === 'processing') {
                try {
                    await tacPlanningApi.getProgress(taskId)
                } catch (err: any) {
                    console.log('任务已不存在，清除TAC状态')
                    clearTAC()
                    setError(null)
                }
            }
        }
        checkTaskExists()
    }, [])

    // === 全局轮询：页面切换不中断 ===
    useEffect(() => {
      if (taskId && (taskResult?.status === 'pending' || taskResult?.status === 'processing')) {
        if (!isGlobalPollingActive('tac_planning')) {
          startGlobalPolling('tac_planning')
        }
      }
    }, [taskId, taskResult?.status])

    // 从 taskStore 同步进度到本地（但不要覆盖用户通过"查看"按钮加载的结果）
    useEffect(() => {
      if (taskId && viewedTaskIdRef.current === taskId) {
        return
      }
      if (taskId) {
        const t = useTaskStore.getState().tasks[taskId]
        if (t) {
          if (t.result && Object.keys(t.result).length > 0) {
            setResult(t.result as TACResultData)
          }
          if (t.status === 'completed' || t.status === 'failed') {
            stopGlobalPolling('tac_planning')
          }
        }
      }
    }, [taskId, storeTask])

    // 监听任务完成/失败，自动推进向导步骤
    useEffect(() => {
        if (wizardStep === 'executing') {
            if (taskResult?.status === 'completed') { setWizardStep('completed'); setError(null) }
            else if (taskResult?.status === 'failed') { setWizardStep('cells_selected') }
        }
    }, [taskResult?.status, wizardStep])

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
        setSelectedCellIds(new Set()); setError(null)
        setConfig({ ...config, networkType: 'LTE' }); clearTAC()
    }

    // ===== 上一步逻辑 =====
    const handleBack = useCallback(() => {
      if (wizardStep === 'task_created') {
        setWizardStep('idle'); setTaskName(''); setTaskNameError(null); setError(null)
      } else if (wizardStep === 'params_set') {
        setWizardStep('task_created'); setNextTaskError(null); setError(null)
      } else if (wizardStep === 'cells_selected') {
        setWizardStep('params_set'); setSelectedCellIds(new Set()); setError(null)
      }
    }, [wizardStep])

    // ===== 统一的"下一步"逻辑 =====
    const handleNext = useCallback(() => {
      if (wizardStep === 'idle') {
        setWizardStep('task_created'); setTaskNameError(null); setError(null)
      } else if (wizardStep === 'task_created') {
        if (!config?.networkType) { setNextTaskError(t('tacPlanning.selectNetworkType') || '请选择网络类型'); return }
        const nameError = validateTaskName(taskName)
        if (nameError) { setTaskNameError(nameError); return }
        setNextTaskError(null); setTaskNameError(null); setWizardStep('params_set'); setError(null)
      } else if (wizardStep === 'params_set') {
        setNextTaskError(null); setWizardStep('cells_selected'); setSelectedCellIds(new Set()); setError(null)
      } else if (wizardStep === 'cells_selected') {
        if (selectedCellIds.size === 0) {
          setError(t('tacPlanning.noCellsSelected') || '请在小区选择列表中至少选择一个小区后再执行TAC规划')
          return
        }
        handleExecute()
      } else if (wizardStep === 'completed') {
        setActiveLeftTab('planning-result')
      }
    }, [wizardStep, taskName, config, selectedCellIds, t])

    const handleNewTask = () => { setWizardStep('task_created'); setTaskNameError(null); setError(null) }

    const handleParamsSetup = () => {
        if (!config?.networkType) { setNextTaskError(t('tacPlanning.selectNetworkType') || '请选择网络类型'); return }
        const nameError = validateTaskName(taskName)
        if (nameError) { setTaskNameError(nameError); return }
        setNextTaskError(null); setTaskNameError(null); setWizardStep('params_set'); setError(null)
    }

    const handleSelectCells = () => {
        setNextTaskError(null); setWizardStep('cells_selected'); setSelectedCellIds(new Set()); setError(null)
    }

    const handleExecute = async () => {
        if (!config?.networkType) {
            setError(t('tacPlanning.selectNetworkType') || '请选择网络类型')
            return
        }

        if (selectedCellIds.size === 0) {
            setError(t('tacPlanning.noCellsSelected') || '请在小区选择列表中至少选择一个小区后再执行TAC规划')
            return
        }

        setLoading(true)
        setError(null)
        setResult(null)
        clearTAC()
        setWizardStep('executing')
        errorCountRef.current = 0

        try {
            // 检查全量工参文件是否存在
            try {
                const listResponse = await dataApi.list(1, 100, true)
                if (listResponse.success && listResponse.data) {
                    const dataItems = listResponse.data

                    // 检查全量工参文件 (projectparameter_mongoose)
                    const fullParamsFile = dataItems.find(item =>
                        item.type === 'excel' &&
                        item.name.toLowerCase().startsWith('projectparameter_mongoose')
                    )
                    if (!fullParamsFile) {
                        setError(
                            (t('tacPlanning.missingDataFiles') || '请先导入以下数据文件：') +
                            '\n' + (t('tacPlanning.fullParamsFile') || '全量工参(ProjectParameter_mongoose)')
                        )
                        setLoading(false)
                        setWizardStep('cells_selected')
                        return
                    }

                    // 检查TAC图层文件
                    const tacFileName = config.networkType === 'LTE' ? '4G_TAC.TAB' : '5G_TAC.TAB'
                    const tacLayerFile = dataItems.find(item =>
                        item.type === 'map' && (
                            item.name.toLowerCase().includes('4g_tac') ||
                            item.name.toLowerCase().includes('5g_tac') ||
                            item.name.toLowerCase().includes('tac')
                        )
                    )
                    if (!tacLayerFile) {
                        setError(
                            (t('tacPlanning.missingDataFiles') || '请先导入以下数据文件：') +
                            '\n' + (t('tacPlanning.tacLayerFile') || `TAC图层(${tacFileName})`)
                        )
                        setLoading(false)
                        setWizardStep('cells_selected')
                        return
                    }
                }
            } catch (listErr) {
                console.warn('检查数据文件列表失败，将继续尝试规划:', listErr)
            }

            const planConfig = {
                taskName: taskName,
                ...config!,
                selectedCellIds: Array.from(selectedCellIds)
            }
            const response = await tacPlanningApi.plan(planConfig)
            if (response.success && response.data) {
                const newTaskId = response.data.taskId
                setTaskId(newTaskId)
                setActiveTaskId('tac_planning', newTaskId)
                startTask(newTaskId, 'tac_planning', 'TAC规划开始', taskName, user?.username)

                const progressResponse = await tacPlanningApi.getProgress(newTaskId)
                if (progressResponse.success && progressResponse.data) {
                    setResult(progressResponse.data)
                }
            } else {
                setError(response.message || (t('tacPlanning.startFailed') || '启动TAC规划任务失败'))
                setWizardStep('cells_selected')
            }
        } catch (err: any) {
            setError(err.message || (t('tacPlanning.startFailed') || '启动TAC规划任务失败'))
            setWizardStep('cells_selected')
        } finally {
            setLoading(false)
        }
    }

    const handleExport = async (format: 'xlsx' | 'csv' = 'xlsx') => {
        if (!taskId) return

        try {
            const blob = await tacPlanningApi.export(taskId, format)
            const url = window.URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url

            const networkType = taskResult?.networkType || config?.networkType || 'LTE'
            const currentTime = new Date()
            const year = currentTime.getFullYear()
            const month = String(currentTime.getMonth() + 1).padStart(2, '0')
            const day = String(currentTime.getDate()).padStart(2, '0')
            const hours = String(currentTime.getHours()).padStart(2, '0')
            const minutes = String(currentTime.getMinutes()).padStart(2, '0')
            const seconds = String(currentTime.getSeconds()).padStart(2, '0')
            const timestamp = `${year}${month}${day}${hours}${minutes}${seconds}`

            const filename = `TAC规划结果_${networkType}_${timestamp}.${format}`
            link.download = filename
            document.body.appendChild(link)
            link.click()

            setTimeout(() => {
                document.body.removeChild(link)
                window.URL.revokeObjectURL(url)
            }, 100)

            setResult((prev: TACResultData | null) => prev ? { ...prev, exportPath: filename } : null)
        } catch (err: any) {
            setError((t('tacPlanning.exportFailed') || '导出失败:') + (err.message || (t('tacPlanning.unknownError') || '未知错误')))
        }
    }

    // 从历史任务查看 - 跳转到结果页
    const handleViewTask = async (task: any) => {
        try {
            const response = await tacPlanningApi.getResult(task.id)
            if (response?.success && response?.data) {
                const resultData = response.data as TACResultData
                viewedTaskIdRef.current = task.id // 必须在 setTaskId 之前设置！
                setResult(resultData)
                setTaskId(task.id)
                setActiveLeftTab('planning-result')
            }
        } catch (err: any) {
            console.error('加载TAC规划结果失败:', err)
            setError('加载规划结果失败: ' + (err.message || '未知错误'))
        }
    }

    // 搜索功能状态
    const [searchEnabled, setSearchEnabled] = useState(false)
    const [searchFilters, setSearchFilters] = useState({
        siteId: '',
        siteName: '',
        sectorId: '',
        sectorName: '',
        longitude: '',
        latitude: '',
        tac: '',
        status: ''
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
        if (taskResult?.status === 'completed' && taskResult.results) {
            if (searchEnabled) {
                const filtered = taskResult.results.filter(cell => {
                    return (
                        String(cell.siteId || '').toLowerCase().includes(searchFilters.siteId.toLowerCase()) &&
                        String(cell.siteName || '').toLowerCase().includes(searchFilters.siteName.toLowerCase()) &&
                        String(cell.sectorId || '').toLowerCase().includes(searchFilters.sectorId.toLowerCase()) &&
                        String(cell.sectorName || '').toLowerCase().includes(searchFilters.sectorName.toLowerCase()) &&
                        String(cell.longitude?.toString() || '').includes(searchFilters.longitude) &&
                        String(cell.latitude?.toString() || '').includes(searchFilters.latitude) &&
                        String(cell.tac || '').toLowerCase().includes(searchFilters.tac.toLowerCase()) &&
                        (searchFilters.status === '' || String(cell.matched) === searchFilters.status)
                    )
                })
                setFilteredResults(filtered)
            } else {
                setFilteredResults(taskResult.results)
            }
        }
    }, [taskResult, searchEnabled, searchFilters])

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
            console.error('[TACPlanningPage] 加载小区列表失败:', err)
        } finally {
            setCellListLoading(false)
        }
    }, [])

    // 初始加载小区列表
    useEffect(() => {
        loadCellList()
    }, [loadCellList])

    // 监听数据刷新事件（当在其他页面上传新工参时）
    useEffect(() => {
        const handleDataRefresh = () => {
            console.log('[TACPlanningPage] 收到数据刷新事件，正在清除缓存并重载小区列表...')
            clearCellListCache()
            loadCellList()
        }
        window.addEventListener(DATA_REFRESH_EVENT, handleDataRefresh)
        return () => window.removeEventListener(DATA_REFRESH_EVENT, handleDataRefresh)
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
        const networkType = (config?.networkType || 'LTE') as 'LTE' | 'NR'
        const sectors = networkType === 'LTE' ? cellListData.lte : cellListData.nr
        const allIds = sectors.map(s => s.id)
        const allSelected = allIds.length > 0 && allIds.every(id => selectedCellIds.has(id))
        if (allSelected) {
            setSelectedCellIds(prev => {
                const next = new Set(prev)
                allIds.forEach(id => next.delete(id))
                return next
            })
        } else {
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

    // 上传待规划小区文件
    const handleUploadCellFile = () => {
        cellFileInputRef.current?.click()
    }

    const handleCellFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return

        if (!file.name.toLowerCase().startsWith('cell-tree')) {
            setError(t('tacPlanning.cellFilePrefixError') || '文件名必须以"cell-tree"开头')
            e.target.value = ''
            return
        }

        setCellFileUploading(true)
        setError(null)
        try {
            // 1. 本地解析文件，提取小区ID
            const extractedIds = await extractCellIdsFromFile(file)
            if (extractedIds.length === 0) {
                setError(t('tacPlanning.noCellIdsExtracted') || '未能从文件中提取到小区ID，请检查文件格式')
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
                setSelectedCellIds(new Set(matchedIds))
            } else {
                setError(t('tacPlanning.noMatchingCells') || '未匹配到任何小区，请检查文件内容与当前工参数据是否一致')
            }
        } catch (err: any) {
            console.error('[TACPlanningPage] 处理待规划小区文件失败:', err)
            setError(err.message || (t('tacPlanning.cellFileUploadFailed') || '待规划小区文件处理失败'))
        } finally {
            setCellFileUploading(false)
            e.target.value = ''
        }
    }

    // 下载待规划小区模板（根据当前网络类型动态生成）
    const handleDownloadCellTemplate = () => {
        try {
            const networkType = (config?.networkType || 'LTE') as 'LTE' | 'NR'
            downloadCellTreeTemplate(networkType)
        } catch (err: any) {
            console.error('[TACPlanningPage] 下载模板失败:', err)
            alert(`${t('data.downloadTemplateFailed') || '下载模板失败'}: ${err.message || ''}`)
        }
    }

    const isRunning = loading || taskResult?.status === 'processing'

    return (
        <div className="h-full flex flex-col p-4 min-h-0">
            <h1 className="text-xl font-bold mb-4 shrink-0">{t('tacPlanning.title') || 'TAC规划'}</h1>

            {error && (
                <div className="mb-3 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2 shrink-0">
                    <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                        <p className="text-red-500 font-medium text-xs mb-0.5">{t('tacPlanning.failed') || '规划失败'}</p>
                        <p className="text-red-600 text-xs">{error}</p>
                    </div>
                </div>
            )}

            {/* 小区选择与结果面板（页签切换） */}
            <div className="bg-card p-3 rounded-lg border border-border flex-1 min-h-0 flex flex-col overflow-hidden">
                {/* 页签切换栏 */}
                <div className="flex items-center gap-1 mb-3 border-b border-border shrink-0">
                    {/* 历史任务 tab */}
                    <button
                        onClick={() => !isRunning && setActiveLeftTab('history')}
                        className={activeLeftTab === 'history' ? btn.activeTab : btn.ghost}
                        disabled={isRunning}
                    >
                        {t('common.historyTask') || '历史任务'}
                        <span className={btn.badgeCount}>{tacPlanningHistoryCount}</span>
                    </button>

                    {/* 新建任务 tab */}
                    <button
                        onClick={() => !isRunning && setActiveLeftTab('task-config')}
                        className={activeLeftTab === 'task-config' ? btn.activeTab : btn.ghost}
                        disabled={isRunning}
                    >
                        {t('common.newTask') || '新建任务'}
                    </button>

                    {/* 规划结果 tab */}
                    <button
                        onClick={() => setActiveLeftTab('planning-result')}
                        className={activeLeftTab === 'planning-result' ? btn.activeTab : btn.ghost}
                    >
                        {t('tacPlanning.result') || '结果'}
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
                                            <button onClick={() => setNextTaskError(null)} className="ml-auto text-sm underline">{t('tacPlanning.close') || '关闭'}</button>
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

                                    {/* TAC规划参数 */}
                                    <div className="space-y-4">
                                        <div>
                                            <label className="block text-xs font-medium mb-1">{t('tacPlanning.networkType') || '网络类型'}</label>
                                            <div className="flex gap-4">
                                                <label className="flex items-center gap-2 text-sm cursor-pointer">
                                                    <input type="radio" name="tacPlanNetworkType" value="LTE" checked={config?.networkType === 'LTE'} onChange={() => setConfig({ ...config, networkType: 'LTE' })} disabled={wizardStep !== 'params_set'} className="w-4 h-4 disabled:opacity-60" />LTE
                                                </label>
                                                <label className="flex items-center gap-2 text-sm cursor-pointer">
                                                    <input type="radio" name="tacPlanNetworkType" value="NR" checked={config?.networkType === 'NR'} onChange={() => setConfig({ ...config, networkType: 'NR' })} disabled={wizardStep !== 'params_set'} className="w-4 h-4 disabled:opacity-60" />NR
                                                </label>
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
                                        sectors={(() => { const networkType = (config?.networkType || 'LTE') as 'LTE' | 'NR'; return networkType === 'LTE' ? cellListData.lte : cellListData.nr })()}
                                        selectedCellIds={selectedCellIds}
                                        onToggleCell={wizardStep === 'cells_selected' && !isRunning ? toggleCellSelection : () => {}}
                                        onSelectAll={wizardStep === 'cells_selected' && !isRunning ? toggleSelectAll : () => {}}
                                        onClearSelections={wizardStep === 'cells_selected' && !isRunning ? clearSelections : () => {}}
                                        selectedCountText={(t('tacPlanning.selectedCount') || '已选中 {{count}} 个小区').replace('{{count}}', String(selectedCellIds.size))}
                                        loading={cellListLoading}
                                        onUploadCellFile={wizardStep === 'cells_selected' ? handleUploadCellFile : undefined}
                                        onDownloadCellTemplate={wizardStep === 'cells_selected' ? handleDownloadCellTemplate : undefined}
                                        uploading={cellFileUploading}
                                        disabled={wizardStep !== 'cells_selected' || isRunning}
                                        columnLabels={{ siteId: t('tacPlanning.siteId') || '基站ID', cellId: t('tacPlanning.cellId') || '小区ID', cellName: t('tacPlanning.cellName') || '小区名称', selectAll: t('tacPlanning.selectAll') || '全选', clearSelections: t('tacPlanning.clearSelections') || '清空选择', uploadCellFile: t('tacPlanning.uploadCellFile') || '上传待规划小区文件', downloadCellTemplate: t('tacPlanning.downloadCellTemplate') || '下载待规划小区模板' }}
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
                                : wizardStep === 'cells_selected' ? selectedCellIds.size > 0
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
                                taskType="tac_planning"
                                typeLabel="TAC规划"
                                onSelectTask={(task) => {
                                    if (task.result) {
                                        const resultData = task.result as TACResultData
                                        setResult(resultData)
                                        setTaskId(task.id)
                                        setActiveLeftTab('planning-result')
                                    }
                                }}
                                onViewTask={handleViewTask}
                                getCellCount={getCellCount}
                                onApplyTask={handleApplyTask}
                            />
                        </div>
                    )}

                    {activeLeftTab === 'planning-result' && (

                        /* 规划结果面板 */
                        <div className="flex flex-col h-full min-h-0 overflow-hidden">
                            {taskResult ? (
                                <>
                                    {/* 标题行 + 统计卡片 + 进度条 */}
                                    <div className="mb-3 shrink-0">
                                        <div className="flex items-center justify-between gap-4 mb-3 flex-wrap">
                                            <div className="flex items-center gap-2">
                                                {taskResult.status === 'completed' ? (
                                                    <CheckCircle2 size={18} className="text-green-500" />
                                                ) : taskResult.status === 'failed' ? (
                                                    <AlertCircle size={18} className="text-red-500" />
                                                ) : (
                                                    <Loader2 size={18} className="animate-spin text-primary" />
                                                )}
                                                <div className="flex items-center gap-1 px-2 py-1.5 bg-muted/50 rounded-lg">
                                                    <span className="text-xs text-muted-foreground">{t('tacPlanning.total') || '总'}</span>
                                                    <span className="text-xs font-bold">{taskResult.totalCells || 0}</span>
                                                </div>
                                                <div className="flex items-center gap-1 px-2 py-1.5 bg-green-500/10 border border-green-500/20 rounded-lg">
                                                    <span className="text-xs text-green-600">{t('tacPlanning.success') || '成功'}</span>
                                                    <span className="text-xs font-bold text-green-500">{taskResult.matchedCells || 0}</span>
                                                </div>
                                                <div className="flex items-center gap-1 px-2 py-1.5 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                                                    <span className="text-xs text-blue-600">{t('tacPlanning.matchRate') || '匹配率'}</span>
                                                    <span className="text-xs font-bold text-blue-500">
                                                        {taskResult.totalCells > 0 ? ((taskResult.matchedCells / taskResult.totalCells) * 100).toFixed(1) : 0}%
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                            {taskResult.status === 'completed' && taskResult.results && (
                                                <button
                                                    onClick={() => {
                                                        if (searchEnabled) {
                                                            setSearchFilters({
                                                                siteId: '', siteName: '', sectorId: '', sectorName: '',
                                                                longitude: '', latitude: '', tac: '', status: ''
                                                            })
                                                            setFilteredResults([])
                                                        }
                                                        setSearchEnabled(!searchEnabled)
                                                    }}
                                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors text-xs ${
                                                        searchEnabled
                                                            ? 'bg-blue-400 text-white hover:bg-blue-500'
                                                            : 'bg-card border border-border hover:bg-muted/80'
                                                    }`}
                                                >
                                                    <Search size={12} />
                                                    {t('tacPlanning.search') || '搜索'}
                                                </button>
                                            )}
                                            {taskResult.status === 'completed' && (
                                                <button
                                                    onClick={async () => {
                                                        const applyTaskId = taskId
                                                        if (!applyTaskId) return
                                                        setApplyingToParams(true)
                                                        setApplySuccess(false)
                                                        try {
                                                            const response = await tacPlanningApi.applyToParams(applyTaskId)
                                                            const atId = response?.data?.taskId
                                                            if (!atId) throw new Error('应用失败')
                                                            // Phase 1 可能已内联返回
                                                            if (response?.data?.result?.updatedCount !== undefined) {
                                                                setApplySuccess(true)
                                                                triggerDataRefresh()
                                                                setTimeout(() => setApplySuccess(false), 5000)
                                                            } else {
                                                                // 短轮询进度（避免 getApplyResult 返回 404）
                                                                const startTime = Date.now()
                                                                const timeout = 30000
                                                                while (Date.now() - startTime < timeout) {
                                                                    await new Promise(r => setTimeout(r, 1000))
                                                                    try {
                                                                        const progress = await tacPlanningApi.getApplyProgress(atId)
                                                                        if (progress?.data?.status === 'completed') {
                                                                            setApplySuccess(true)
                                                                            triggerDataRefresh()
                                                                            setTimeout(() => setApplySuccess(false), 5000)
                                                                            break
                                                                        }
                                                                        if (progress?.data?.status === 'failed') {
                                                                            throw new Error(progress?.data?.error || '应用失败')
                                                                        }
                                                                    } catch (pollErr: any) {
                                                                        if (pollErr?.response?.status === 404) continue
                                                                        throw pollErr
                                                                    }
                                                                }
                                                            }
                                                        } catch (err: any) {
                                                            setError('应用到工参失败: ' + (err.message || '未知错误'))
                                                        } finally {
                                                            setApplyingToParams(false)
                                                        }
                                                    }}
                                                    disabled={applyingToParams}
                                                    className={`flex items-center gap-1.5 px-4 py-2 rounded-lg transition-all text-sm font-medium ${applySuccess ? 'bg-green-500/20 border border-green-500/50 text-green-600 cursor-default' : applyingToParams ? 'bg-blue-500/20 border border-blue-500/50 text-blue-600' : 'bg-card border border-border hover:bg-muted/80'}`}
                                                >
                                                    {applyingToParams ? (
                                                        <><Loader2 size={16} className="animate-spin" /><span>{t('common.applying') || '应用中...'}</span></>
                                                    ) : applySuccess ? (
                                                        <><Check size={16} /><span>{t('common.applied') || '已应用'}</span></>
                                                    ) : (
                                                        <><Save size={16} /><span>{t('common.applyToParams') || '应用到工参'}</span></>
                                                    )}
                                                </button>
                                            )}
                                            {taskResult.status === 'completed' && (
                                                <button
                                                    onClick={() => handleExport('xlsx')}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors text-xs bg-card border border-border hover:bg-muted/80"
                                                >
                                                    <Download size={12} />
                                                    <span>{t('tacPlanning.export') || '导出'}</span>
                                                </button>
                                            )}
                                        </div>
                                        </div>

                                        {/* 进度条 */}
                                        {taskResult.status !== 'completed' && taskResult.status !== 'failed' && (
                                            <div className="mb-3">
                                                <div className="flex items-center justify-end mb-1.5 text-xs">
                                                    <span>{taskResult.progress}%</span>
                                                </div>
                                                <div className="w-full bg-muted rounded-full h-1.5">
                                                    <div
                                                        className="bg-primary h-1.5 rounded-full transition-all duration-300"
                                                        style={{ width: `${taskResult.progress}%` }}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    {/* 任务错误信息 */}
                                    {taskResult.status === 'failed' && taskResult.error && (
                                        <div className="mb-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2 shrink-0">
                                            <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
                                            <div className="flex-1">
                                                <p className="text-red-500 font-medium text-xs mb-0.5">{t('tacPlanning.failed') || '规划失败'}</p>
                                                <p className="text-red-600 text-xs">{taskResult.error}</p>
                                            </div>
                                        </div>
                                    )}

                                    {taskResult.status === 'completed' && taskResult.results ? (
                                        <div className="flex flex-col flex-1 min-h-0">
                                            <div
                                                ref={tableContainerRef}
                                                onScroll={handleScroll}
                                                className="overflow-x-auto overflow-y-auto border border-border rounded-lg flex-1 min-h-0"
                                            >
                                                <table className="w-full text-xs border-collapse table-fixed">
                                                    <thead className="sticky top-0 z-20 bg-background border-b border-border shadow-sm">
                                                        <tr>
                                                            {COLUMNS.map((column) => (
                                                                <th
                                                                    key={column.key}
                                                                    className="text-left p-2 font-medium bg-background z-20 relative group border-r border-border"
                                                                    style={{ width: `${columnWidths[column.key]}px`, minWidth: `${columnWidths[column.key]}px` }}
                                                                >
                                                                    <span className="block pr-3">{t(`tacPlanning.column.${column.key}`) || column.label}</span>
                                                                    {searchEnabled && column.key !== 'status' && (
                                                                        <input
                                                                            type="text"
                                                                            value={searchFilters[column.key as keyof typeof searchFilters]}
                                                                            onChange={(e) => handleSearchChange(column.key, e.target.value)}
                                                                            placeholder={t('tacPlanning.search') || '搜索'}
                                                                            className="mt-1 w-full p-1 border border-border rounded text-[10px] text-gray-900 bg-gray-100 placeholder:text-gray-400"
                                                                        />
                                                                    )}
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
                                                            return (
                                                                <tr
                                                                    key={`${cell.sectorId}-${actualIndex}`}
                                                                    className="border-b border-border hover:bg-muted/50"
                                                                    style={{ height: `${ITEM_HEIGHT}px` }}
                                                                >
                                                                    {COLUMNS.map((column) => {
                                                                        const width = columnWidths[column.key]
                                                                        const cellClassName = column.key === 'siteId' || column.key === 'sectorId' || column.key === 'longitude' || column.key === 'latitude' || column.key === 'tac'
                                                                            ? 'p-2 font-mono truncate border-r border-border'
                                                                            : column.key === 'status'
                                                                            ? 'p-2 border-r border-border'
                                                                            : 'p-2 truncate border-r border-border'

                                                                        const getCellContent = () => {
                                                                            switch (column.key) {
                                                                                case 'siteId':
                                                                                    return cell.siteId
                                                                                case 'siteName':
                                                                                    return cell.siteName
                                                                                case 'sectorId':
                                                                                    return cell.sectorId
                                                                                case 'sectorName':
                                                                                    return cell.sectorName
                                                                                case 'longitude':
                                                                                    return cell.longitude?.toFixed(6)
                                                                                case 'latitude':
                                                                                    return cell.latitude?.toFixed(6)
                                                                                case 'tac':
                                                                                    return cell.tac || '-'
                                                                                case 'status':
                                                                                    return cell.matched ? (
                                                                                        <span className="px-1.5 py-0.5 bg-green-500/10 text-green-600 rounded text-[10px]">{t('tacPlanning.completed') || '完成'}</span>
                                                                                    ) : (
                                                                                        <span className="px-1.5 py-0.5 bg-orange-500/10 text-orange-600 rounded text-[10px]">{t('tacPlanning.unmatched') || '未匹配'}</span>
                                                                                    )
                                                                                default:
                                                                                    return null
                                                                            }
                                                                        }

                                                                        return (
                                                                            <td
                                                                                key={column.key}
                                                                                className={cellClassName + (column.key === 'tac' ? ' text-primary font-bold' : '')}
                                                                                style={{ width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` }}
                                                                            >
                                                                                {getCellContent()}
                                                                            </td>
                                                                        )
                                                                    })}
                                                                </tr>
                                                            )
                                                        })}
                                                        <tr style={{ height: `${virtualData.totalHeight - virtualData.offsetY - virtualData.visibleData.length * ITEM_HEIGHT}px` }}>
                                                            <td colSpan={8}></td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    ) : taskResult.status === 'processing' || taskResult.status === 'pending' ? (
                                        <div className="flex-1 flex items-center justify-center text-muted-foreground flex-col">
                                            <Loader2 className="animate-spin mb-2" size={32} />
                                            <p className="text-xs">规划进行中，请稍候...</p>
                                        </div>
                                    ) : null}
                                </>
                            ) : (
                                <div className="flex-1 flex items-center justify-center text-muted-foreground flex-col">
                                    <List size={48} className="mb-4 opacity-30" />
                                    {wizardStep === 'idle' ? (
                                        <p>{t('common.configureFirst') || '请先点击"新建"按钮创建任务'}</p>
                                    ) : (
                                        <>
                                            <p>配置参数后点击「开始TAC规划」查看结果</p>
                                            <p className="text-xs mt-2">需要先导入「全量工参」、「待规划小区」和「TAC图层」文件</p>
                                        </>
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
