import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Play, Download, Settings, Loader2, AlertCircle, Search, X, Ruler, GripVertical, Check, Eye } from 'lucide-react'
import { useTranslation } from 'react-i18next'


// 虚拟滚动配置
const ITEM_HEIGHT = 40 // 每行高度
const VISIBLE_COUNT = 25 // 可见行数
const BUFFER_COUNT = 5 // 缓冲行数
import { neighborApi } from '../services/api'
import type { ApiResponse } from '@shared/types'
import { useTaskStore, type Task } from '../store/taskStore'
import { useMapStore } from '../store/mapStore'
import { useAuthStore } from '../store/authStore'
import { useNeighborStore } from '../store/neighborStore'
import { btn } from '../utils/buttonStyles'
import { OnlineMap, type OnlineMapRef } from '../components/Map/OnlineMap'
import { NeighborLegend } from '../components/Map/NeighborLegend'
import { MapTypeSwitch } from '../components/Map/MapTypeSwitch'
import { neighborDataSyncService } from '../services/neighborDataSyncService'
import type { RenderSectorData, CellListItem } from '../services/mapDataService'
import { mapDataService, getCellList, clearCellListCache } from '../services/mapDataService'
import { DATA_REFRESH_EVENT } from '../store/dataStore'
import { CellSelectionTable } from '../components/CellSelectionTable'
import { HistoryTable } from '../components/HistoryTable'
import { StepIndicator } from '../components/StepIndicator'
import { WizardFooter } from '../components/WizardFooter'
import { NumberInput } from '../components/NumberInput'
import { extractCellIdsFromFile, matchCellIds, downloadCellTreeTemplate } from '../utils/cellFileHelper'

interface NeighborResultData {
  taskId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  totalSites: number
  totalSectors: number
  totalNeighbors: number
  avgNeighbors: number
  results?: any[]
  startTime: string
  endTime?: string
}

const MAX_ERRORS = 5

type WizardStep = 'idle' | 'task_created' | 'params_set' | 'cells_selected' | 'executing' | 'completed'

// 邻区规划类型最大邻区数限制
const MAX_NEIGHBORS_LIMIT: Record<string, number> = {
  'LTE-LTE': 256,
  'NR-NR': 512,
  'NR-LTE': 512
}

export function NeighborPage() {
  const { t } = useTranslation()
  const user = useAuthStore((s) => s.user)
  const { wizardStep, setWizardStep, config, setConfig, selectedCellIds: storeSelectedCellIds, activeLeftTab, setActiveLeftTab, taskName, setTaskName, resetConfig: storeResetConfig } = useNeighborStore()
  const [taskNameError, setTaskNameError] = useState<string | null>(null)
  const [nextTaskError, setNextTaskError] = useState<string | null>(null)

  // 翻译文本（带中文后备）
  const i18n = {
    title: t('neighbor.title') || '邻区规划',
    planningParams: t('neighbor.planningParams') || '规划参数',
    result: t('neighbor.result') || '规划结果',
    startPlan: t('neighbor.startPlan') || '开始规划',
    planning: t('neighbor.planning') || '规划中...',
    starting: t('neighbor.starting') || '启动中...',
    export: t('neighbor.export') || '导出结果',
    search: t('neighbor.search') || '搜索',
    clear: t('neighbor.clear') || '清除',
    clearAll: t('neighbor.clearAll') || '清除全部',
    noResult: t('neighbor.noResult') || '暂无规划结果',
    planningInProgress: t('neighbor.planningInProgress') || '规划进行中，请稍候...',
    noMatchResult: t('neighbor.noMatchResult') || '暂无匹配结果',
    measure: t('neighbor.measure') || '测距',
    searchPlaceholder: t('neighbor.searchPlaceholder') || '输入小区名称或 基站ID-小区ID',
    searchColPlaceholder: t('neighbor.searchColPlaceholder') || '搜索',
    configTip: t('neighbor.configTip') || '配置参数后点击"开始规划"查看结果',
    needUpload: t('neighbor.needUpload') || '需要先上传"全量工参"和"待规划小区"文件',
    taskFailed: t('neighbor.taskFailed') || '规划任务失败',
    close: t('neighbor.close') || '关闭',
    // 表格列
    sourcePci: t('neighbor.sourcePci') || '源PCI',
    targetPci: t('neighbor.targetPci') || '目标PCI',
    // 统计卡片
    siteCount: t('neighbor.siteCount') || '基站数',
    cellCount: t('neighbor.cellCount') || '小区数',
    neighborCount: t('neighbor.neighborCount') || '邻区数',
    avgNeighbors: t('neighbor.avgNeighbors') || '平均邻区数',
    // 配置参数
    planningType: t('neighbor.planningType') || '规划类型',
    maxNeighbors: t('neighbor.maxNeighbors') || '最大邻区数',
    distanceFactor: t('neighbor.distanceFactor') || '距离系数',
    radiusFactor: t('neighbor.radiusFactor') || '半径系数',
    // 搜索相关
    searchErrorNoInput: t('neighbor.searchErrorNoInput') || '请输入小区名称或基站ID-小区ID',
    searchErrorNotFound: t('neighbor.searchErrorNotFound') || '未找到小区',
    searchErrorNoCoords: t('neighbor.searchErrorNoCoords') || '小区缺少经纬度信息，无法定位',
    searchErrorFailed: t('neighbor.searchErrorFailed') || '搜索失败，请重试',
    searchMarkerCount: t('neighbor.searchMarkerCount') || '已添加 {{count}} 个搜索标记',
    // 验证消息
    validationMaxNeighbors1: t('neighbor.validationMaxNeighbors1') || '最大邻区数不能小于1',
    validationMaxNeighbors2: t('neighbor.validationMaxNeighbors2') || '{{type}}规划最多配置{{limit}}条邻区关系，当前值为{{value}}',
    validationDistanceFactor: t('neighbor.validationDistanceFactor') || '覆盖圆距离系数必须在0.1-2.0之间，当前值为{{value}}',
    validationRadiusFactor: t('neighbor.validationRadiusFactor') || '覆盖圆半径系数必须在0.1-2.0之间，当前值为{{value}}',
    validationFactorProduct: t('neighbor.validationFactorProduct') || '覆盖圆系数乘积({{value}})过大，可能产生过多无效邻区，建议减小系数',
    // 其他
    exitMeasureMode: t('neighbor.exitMeasureMode') || '退出测距模式',
    enterMeasureMode: t('neighbor.enterMeasureMode') || '进入测距模式',
    clearMarkersTip: t('neighbor.clearMarkersTip') || '清除所有标记（定位 + 测距）',
    exportFailed: t('neighbor.exportFailed') || '导出失败',
    getResultFailed: t('neighbor.getResultFailed') || '获取规划结果失败',
    startTaskFailed: t('neighbor.startTaskFailed') || '启动规划任务失败',
    loadResultFailed: t('neighbor.loadResultFailed') || '加载规划结果失败',
    getProgressFailed: t('neighbor.getProgressFailed') || '获取进度失败',
    cannotConnect: t('neighbor.cannotConnect') || '无法连接到服务器，请检查网络连接或后端服务状态',
    retrying: t('neighbor.retrying') || '获取进度失败 ({{count}}/{{max}})，正在重试...',
    taskFailed2: t('neighbor.taskFailed2') || '规划任务失败',
    // 小区选择相关
    cellSelection: t('neighbor.cellSelection') || '小区选择',
    selectAll: t('neighbor.selectAll') || '全选',
    deselectAll: t('neighbor.deselectAll') || '取消全选',
    clearSelections: t('neighbor.clearSelections') || '清空选择',
    selectedCount: t('neighbor.selectedCount') || '已选中 {{count}} 个小区',
    cellSearchPlaceholder: t('neighbor.cellSearchPlaceholder') || '搜索基站ID、小区ID或名称...',
    noCells: t('neighbor.noCells') || '暂无小区数据',
    loadingCells: t('neighbor.loadingCells') || '加载中...',
    cellListSource: t('neighbor.cellListSource') || '数据源：{{type}} 小区',
    cellFilePrefixError: t('neighbor.cellFilePrefixError') || '文件名必须以"cell-tree"开头',
    cellFileUploadFailed: t('neighbor.cellFileUploadFailed') || '待规划小区文件处理失败',
    uploadCellFile: t('neighbor.uploadCellFile') || '上传待规划小区文件',
    downloadCellTemplate: t('neighbor.downloadCellTemplate') || '下载待规划小区模板',
    noCellsSelected: t('neighbor.noCellsSelected') || '请在小区选择列表中至少选择一个小区后再执行邻区规划',
    noCellIdsExtracted: t('neighbor.noCellIdsExtracted') || '未能从文件中提取到小区ID，请检查文件格式',
    noMatchingCells: t('neighbor.noMatchingCells') || '未匹配到任何小区，请检查文件内容与当前工参数据是否一致',
    // 工具提示
    distanceFactorTooltip: t('neighbor.distanceFactorTooltip') || '覆盖圆距离系数：站点到覆盖圆心的距离系数，默认5/9(≈0.556)',
    radiusFactorTooltip: t('neighbor.radiusFactorTooltip') || '覆盖圆半径系数：覆盖半径系数，默认5/9(≈0.556)',
    // 规划类型描述
    startTaskMsg: t('neighbor.startTaskMsg') || '邻区规划开始',
    // 表格列
    relationType: t('neighbor.relationType') || '关系类型',
    sourceSiteId: t('neighbor.sourceSiteId') || '源基站ID',
    sourceCellId: t('neighbor.sourceCellId') || '源小区ID',
    sourceCellName: t('neighbor.sourceCellName') || '源小区名称',
    sourceFrequency: t('neighbor.sourceFrequency') || '源频点',
    targetSiteId: t('neighbor.targetSiteId') || '目标基站ID',
    targetCellId: t('neighbor.targetCellId') || '目标小区ID',
    targetCellName: t('neighbor.targetCellName') || '目标小区名称',
    targetFrequency: t('neighbor.targetFrequency') || '目标频点',
    distance: t('neighbor.distance') || '距离',
    showMap: t('neighbor.showMap') || '地图展示',
  }

  // 配置验证函数
  const validateNeighborConfig = (config: any): string | null => {
    // 验证最大邻区数
    const maxLimit = MAX_NEIGHBORS_LIMIT[config.planningType] || 512
    if (config.maxNeighbors < 1) {
      return i18n.validationMaxNeighbors1
    }
    if (config.maxNeighbors > maxLimit) {
      return i18n.validationMaxNeighbors2
        .replace('{{type}}', config.planningType)
        .replace('{{limit}}', String(maxLimit))
        .replace('{{value}}', String(config.maxNeighbors))
    }

    // 验证覆盖圆距离系数
    if (config.coverageDistanceFactor < 0.1 || config.coverageDistanceFactor > 2.0) {
      return i18n.validationDistanceFactor.replace('{{value}}', String(config.coverageDistanceFactor))
    }

    // 验证覆盖圆半径系数
    if (config.coverageRadiusFactor < 0.1 || config.coverageRadiusFactor > 2.0) {
      return i18n.validationRadiusFactor.replace('{{value}}', String(config.coverageRadiusFactor))
    }

    // 验证两个系数的乘积不应过大
    const factorProduct = config.coverageDistanceFactor * config.coverageRadiusFactor
    if (factorProduct > 3.0) {
      return i18n.validationFactorProduct.replace('{{value}}', factorProduct.toFixed(2))
    }

    return null
  }

  // 邻区表格列配置
  const NEIGHBOR_COLUMNS = [
    { key: 'relationType', label: i18n.relationType, defaultWidth: 80 },
    { key: 'sourceSiteId', label: i18n.sourceSiteId, defaultWidth: 80 },
    { key: 'sourceCellId', label: i18n.sourceCellId, defaultWidth: 80 },
    { key: 'sourceCellName', label: i18n.sourceCellName, defaultWidth: 120 },
    { key: 'sourceFrequency', label: i18n.sourceFrequency, defaultWidth: 70 },
    { key: 'sourcePci', label: i18n.sourcePci, defaultWidth: 60 },
    { key: 'targetSiteId', label: i18n.targetSiteId, defaultWidth: 80 },
    { key: 'targetCellId', label: i18n.targetCellId, defaultWidth: 80 },
    { key: 'targetCellName', label: i18n.targetCellName, defaultWidth: 120 },
    { key: 'targetFrequency', label: i18n.targetFrequency, defaultWidth: 70 },
    { key: 'targetPci', label: i18n.targetPci, defaultWidth: 60 },
    { key: 'distance', label: i18n.distance, defaultWidth: 70 }
  ] as const

  const [localTaskResult, setLocalTaskResult] = useState<NeighborResultData | null>(null)
  const viewedTaskIdRef = useRef<string | null>(null) // 防止 useEffect 覆盖 API 获取的结果
  const {
    updateTaskProgress, completeTask, failTask, activeTaskIds, setActiveTaskId, startTask,
    getLatestNeighborTask,
    startGlobalPolling, stopGlobalPolling, isGlobalPollingActive
  } = useTaskStore()
  const taskId = activeTaskIds.neighbor_planning
  const latestNeighborTask = getLatestNeighborTask()
  const neighborHistoryCount = useTaskStore(s => Object.values(s.tasks).filter(t => t.type === 'neighbor_planning').length)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isLegendVisible, setIsLegendVisible] = useState(true)
  const [syncServiceInitialized, setSyncServiceInitialized] = useState(false)

  // 选中的小区ID集合（格式：${siteId}_${sectorId}）- 本地 Set 桥接 store 的 string[]
  const [selectedCellIdsSet, setSelectedCellIdsSet] = useState<Set<string>>(new Set(storeSelectedCellIds))
  useEffect(() => { setSelectedCellIdsSet(new Set(storeSelectedCellIds)) }, [storeSelectedCellIds])
  // 小区列表数据（从轻量API获取）
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
    setActiveTaskId('neighbor_planning', null)
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
  const { syncHistoryFromBackend } = useTaskStore()
  useEffect(() => {
    if (activeLeftTab === 'planning-result') {
      // 如果用户通过"查看"按钮加载了特定任务的结果，不要自动加载最新的
      if (viewedTaskIdRef.current) {
        return
      }
      const loadLatest = async () => {
        await syncHistoryFromBackend('neighbor_planning')
        const latest = getLatestNeighborTask()
        if (latest && latest.result) {
          // 如果缺少完整 results（来自 resultSummary），尝试从 API 重新获取
          if (!latest.result.results && latest.id) {
            try {
              const response = await neighborApi.getResult(latest.id)
              if (response?.success && response?.data?.results) {
                const fullResult = response.data as NeighborResultData
                setLocalTaskResult(fullResult)
                neighborDataSyncService.setNeighborResults({ results: fullResult.results })
                setWizardStep('completed')
                return
              }
            } catch (fetchErr: any) {
              console.warn('[NeighborPage] 获取完整规划结果失败，使用缓存摘要:', fetchErr?.message)
            }
          }
          // 有完整 results 或 API 获取失败时使用已有结果
          setLocalTaskResult(latest.result as NeighborResultData)
          if (latest.result.results) {
            neighborDataSyncService.setNeighborResults({ results: latest.result.results })
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
    if (task.result?.totalSectors !== undefined) return task.result.totalSectors
    if (task.result?.results && Array.isArray(task.result.results)) {
      return task.result.results.length
    }
    return '-'
  }, [])

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
    relationType: '',
    sourceSiteId: '',
    sourceCellId: '',
    sourceCellName: '',
    sourceFrequency: '',
    sourcePci: '',
    targetSiteId: '',
    targetCellId: '',
    targetCellName: '',
    targetFrequency: '',
    targetPci: '',
    distance: ''
  })
  const [filteredResults, setFilteredResults] = useState<any[]>([])

  // 列宽状态
  const [neighborColumnWidths, setNeighborColumnWidths] = useState<Record<string, number>>(
    Object.fromEntries(NEIGHBOR_COLUMNS.map(col => [col.key, col.defaultWidth]))
  )

  // 列宽拖拽状态
  const [neighborResizingColumn, setNeighborResizingColumn] = useState<string | null>(null)
  const neighborResizingStartX = useRef<number>(0)
  const neighborResizingStartWidth = useRef<number>(0)

  // 处理列宽拖拽开始
  const handleNeighborResizeStart = useCallback((columnKey: string, startX: number) => {
    setNeighborResizingColumn(columnKey)
    neighborResizingStartX.current = startX
    neighborResizingStartWidth.current = neighborColumnWidths[columnKey]
    document.body.classList.add('resizing-column')
  }, [neighborColumnWidths])

  // 处理列宽拖拽中
  const handleNeighborResizeMove = useCallback((clientX: number) => {
    if (neighborResizingColumn) {
      const deltaX = clientX - neighborResizingStartX.current
      const newWidth = Math.max(40, neighborResizingStartWidth.current + deltaX)
      setNeighborColumnWidths(prev => ({
        ...prev,
        [neighborResizingColumn]: newWidth
      }))
    }
  }, [neighborResizingColumn])

  // 处理列宽拖拽结束
  const handleNeighborResizeEnd = useCallback(() => {
    setNeighborResizingColumn(null)
    document.body.classList.remove('resizing-column')
  }, [])

  // 全局鼠标事件监听
  useEffect(() => {
    if (neighborResizingColumn) {
      const handleMouseMove = (e: MouseEvent) => {
        handleNeighborResizeMove(e.clientX)
      }
      const handleMouseUp = () => {
        handleNeighborResizeEnd()
      }
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      return () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [neighborResizingColumn, handleNeighborResizeMove, handleNeighborResizeEnd])

  // 地图组件ref
  const mapRef = useRef<OnlineMapRef>(null)

  // 选中的源小区（用于地图高亮）
  const [selectedSourceSector, setSelectedSourceSector] = useState<any | null>(null)

  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const pollingTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const errorCountRef = useRef(0)

  // 确定当前显示的任务结果
  const taskResult = localTaskResult || (latestNeighborTask?.result as NeighborResultData | null)
  // 只有当有完整结果数据（含 results 数组）或由 handleViewTask 设置时才认为是有效结果
  const hasFullResult = taskResult && (!!(taskResult as any).results || viewedTaskIdRef.current)

  // 组件挂载时，检查是否有最新的邻区规划结果
  useEffect(() => {
    if (latestNeighborTask && latestNeighborTask.result) {
      setLocalTaskResult(latestNeighborTask.result as NeighborResultData)
    }
  }, [latestNeighborTask])

  // 将 SiteNeighborResult[] 转换为扁平的邻区关系列表
  const buildFlatResults = useCallback((siteResults: any[]): any[] => {
    const flat: any[] = []
    siteResults.forEach((site: any) => {
      const siteId = site.siteId || ''
      ;(site.sectors || []).forEach((sector: any) => {
        const sectorId = sector.sectorId || ''
        const sectorName = sector.sectorName || ''
        ;(sector.neighbors || []).forEach((neighbor: any) => {
          // 解析 targetSector (格式: siteId_sectorId)
          const targetParts = (neighbor.targetSector || '').split('_')
          const targetCellId = targetParts[1] || ''
          flat.push({
            sourceSiteId: siteId,
            sourceCellId: sectorId,
            sourceCellName: sectorName,
            sourceFrequency: '',
            sourcePci: '',
            targetSiteId: neighbor.targetSite || targetParts[0] || '',
            targetCellId: targetCellId,
            targetCellName: neighbor.targetSectorName || '',
            targetFrequency: '',
            targetPci: '',
            distance: neighbor.distance ?? 0,
            relationType: neighbor.relationType || 'LTE-LTE',
          })
        })
      })
    })
    return flat
  }, [])

  // 初始化filteredResults，确保taskResult加载时filteredResults有数据
  useEffect(() => {
    if (taskResult?.status === 'completed' && taskResult.results) {
      const flatResults = buildFlatResults(taskResult.results)
      setFilteredResults(flatResults)
    }
  }, [taskResult?.status, taskResult?.results, buildFlatResults])

  // 初始化邻区数据同步服务（异步执行，不阻塞页面渲染）
  useEffect(() => {
    let mounted = true

    // 使用 setTimeout 将初始化放到事件循环末尾，避免阻塞页面渲染
    const initSyncService = async () => {
      try {
        await neighborDataSyncService.initialize()
        if (mounted) {
          console.log('[NeighborPage] 邻区数据同步服务初始化完成')
          setSyncServiceInitialized(true)
        }
      } catch (error) {
        console.error('[NeighborPage] 邻区数据同步服务初始化失败:', error)
      }
    }

    // 监听数据刷新事件（当在其他页面上传新工参时）
    const handleDataRefresh = async () => {
      console.log('[NeighborPage] 收到数据刷新事件，正在清除缓存...')
      try {
        // 清除地图数据和小区列表缓存
        await mapDataService.clearCache()
        clearCellListCache()
        // 重新加载小区列表，确保新建任务页面使用最新数据
        loadCellList()
        console.log('[NeighborPage] 已清除缓存并重载小区列表')
      } catch (error) {
        console.warn('[NeighborPage] 数据刷新失败:', error)
      }
    }

    window.addEventListener(DATA_REFRESH_EVENT, handleDataRefresh)

    // 延迟初始化，优先保证页面渲染
    const timeoutId = setTimeout(() => {
      initSyncService()
    }, 0)

    return () => {
      mounted = false
      window.removeEventListener(DATA_REFRESH_EVENT, handleDataRefresh)
      clearTimeout(timeoutId)
    }
  }, [])

  // 邻区规划模式：仅在规划结果完成时加载全量扇区数据
  // 根据规划结果的关系类型决定加载哪些网络类型的扇区
  useEffect(() => {
    // 确保同步服务已初始化
    if (!syncServiceInitialized) {
      console.log('[NeighborPage] 等待同步服务初始化完成')
      return
    }

    // 仅在规划任务完成且有结果时加载数据
    if (taskResult?.status !== 'completed' || !taskResult?.results || taskResult.results.length === 0) {
      return
    }

    const loadFullParamsData = async () => {
      try {
        // 直接从mapDataService获取全量工参数据
        const { mapDataService } = await import('../services/mapDataService')

        // 根据规划结果的关系类型决定加载策略
        let shouldLoadLTE = false
        let shouldLoadNR = false

        // 检查规划结果的关系类型
        const relationTypes = new Set(
          taskResult.results.map((r: any) => r.relationType || 'LTE-LTE')
        )

        console.log('[NeighborPage] 规划结果关系类型', Array.from(relationTypes))

        if (relationTypes.has('NR-LTE')) {
          // NR-LTE关系：同时加载LTE和NR
          shouldLoadLTE = true
          shouldLoadNR = true
        } else if (relationTypes.has('LTE-LTE')) {
          // LTE-LTE关系：只加载LTE
          shouldLoadLTE = true
          shouldLoadNR = false
        } else if (relationTypes.has('NR-NR')) {
          // NR-NR关系：只加载NR
          shouldLoadLTE = false
          shouldLoadNR = true
        } else {
          // 默认情况：加载所有
          shouldLoadLTE = true
          shouldLoadNR = true
        }

        console.log('[NeighborPage] 扇区加载策略', {
          shouldLoadLTE,
          shouldLoadNR,
          hasResults: !!(taskResult?.results)
        })

        // 获取地图数据（使用缓存，避免强制刷新）
        const mapData = await mapDataService.getMapData(12, false)

        // 根据策略过滤数据
        const filteredLTE = shouldLoadLTE ? mapData.lteSectors : []
        const filteredNR = shouldLoadNR ? mapData.nrSectors : []

        console.log('[NeighborPage] 全量工参数据已加载（按关系类型过滤）', {
          lte: filteredLTE.length,
          nr: filteredNR.length,
          originalLte: mapData.lteSectors.length,
          originalNr: mapData.nrSectors.length
        })

        // 将过滤后的全量工参数据存储到邻区同步服务中
        neighborDataSyncService.setFullParamsData({
          lte: filteredLTE,
          nr: filteredNR
        })

        // 设置加载的网络类型标记
        neighborDataSyncService.setLoadedNetworkTypes({
          lte: shouldLoadLTE,
          nr: shouldLoadNR
        })

        // 同时加载邻区规划结果（在过滤后的数据上处理，避免被初始化全量数据覆盖）
        if (taskResult.results) {
          neighborDataSyncService.setNeighborResults({ results: taskResult.results })
          console.log('[NeighborPage] 邻区规划结果已加载到同步服务（在过滤数据基础上）')
        }

        // 如果有地图实例，刷新数据
        if (mapRef.current) {
          await mapRef.current.refreshData()
          console.log('[NeighborPage] 全量扇区数据加载后刷新地图')
        }
      } catch (error) {
        console.error('[NeighborPage] 加载全量工参数据失败:', error)
      }
    }

    loadFullParamsData()
  }, [taskResult?.status, taskResult?.results, syncServiceInitialized])

  // 处理规划结果搜索过滤
  useEffect(() => {
    if (taskResult?.status === 'completed' && taskResult.results) {
      // 将 SiteNeighborResult[] 转换为扁平的邻区关系列表
      const allResults = taskResult.results || []

      if (resultSearchEnabled) {
        const hasActiveFilters = Object.values(resultSearchFilters).some(v => v.trim() !== '')

        if (hasActiveFilters) {
          const filtered = allResults.filter((row: any) => {
            return (
              String(row.relationType || '').toLowerCase().includes(resultSearchFilters.relationType.toLowerCase()) &&
              String(row.sourceSiteId || '').toLowerCase().includes(resultSearchFilters.sourceSiteId.toLowerCase()) &&
              String(row.sourceCellId || '').toLowerCase().includes(resultSearchFilters.sourceCellId.toLowerCase()) &&
              String(row.sourceCellName || '').toLowerCase().includes(resultSearchFilters.sourceCellName.toLowerCase()) &&
              String(row.sourceFrequency ?? '').toLowerCase().includes(resultSearchFilters.sourceFrequency.toLowerCase()) &&
              String(row.sourcePci ?? '').toLowerCase().includes(resultSearchFilters.sourcePci.toLowerCase()) &&
              String(row.targetSiteId || '').toLowerCase().includes(resultSearchFilters.targetSiteId.toLowerCase()) &&
              String(row.targetCellId || '').toLowerCase().includes(resultSearchFilters.targetCellId.toLowerCase()) &&
              String(row.targetCellName || '').toLowerCase().includes(resultSearchFilters.targetCellName.toLowerCase()) &&
              String(row.targetFrequency ?? '').toLowerCase().includes(resultSearchFilters.targetFrequency.toLowerCase()) &&
              String(row.targetPci ?? '').toLowerCase().includes(resultSearchFilters.targetPci.toLowerCase()) &&
              String(row.distance ?? '').toLowerCase().includes(resultSearchFilters.distance.toLowerCase())
            )
          })
          setFilteredResults(filtered)
        } else {
          // 搜索启用但没有输入过滤条件时，显示所有结果
          setFilteredResults(allResults)
        }
      } else {
        setFilteredResults(allResults)
      }
    } else {
      // 任务未完成或没有结果时，清空filteredResults
      setFilteredResults([])
    }
  }, [taskResult, resultSearchEnabled, resultSearchFilters, buildFlatResults])

  // 处理搜索输入变化
  const handleResultSearchChange = (field: string, value: string) => {
    setResultSearchFilters(prev => ({
      ...prev,
      [field]: value
    }))
  }

  // === 全局轮询：页面切换不中断 ===
  useEffect(() => {
    if (taskId && (taskResult?.status === 'pending' || taskResult?.status === 'processing')) {
      if (!isGlobalPollingActive('neighbor_planning')) {
        startGlobalPolling('neighbor_planning')
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
          setLocalTaskResult(t.result as NeighborResultData)
        }
        if (t.status === 'completed' || t.status === 'failed') {
          stopGlobalPolling('neighbor_planning')
        }
      }
    }
  }, [taskId])

  // 加载小区列表数据（根据规划类型加载对应网络类型的扇区）
  const loadCellList = useCallback(async () => {
    const sourceType = config.planningType.split('-')[0] as 'LTE' | 'NR'
    setCellListLoading(true)
    try {
      const data = await getCellList()
      setCellListData({
        lte: data.lte || [],
        nr: data.nr || []
      })
    } catch (err) {
      console.error('[NeighborPage] 加载小区列表失败:', err)
    } finally {
      setCellListLoading(false)
    }
  }, [config.planningType])

  // 初始加载小区列表
  useEffect(() => {
    loadCellList()
  }, [loadCellList])

  // 切换单个小区选中状态
  const toggleCellSelection = (cellId: string) => {
    setSelectedCellIdsSet(prev => {
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
    const sourceType = config.planningType.split('-')[0] as 'LTE' | 'NR'
    const sectors = sourceType === 'LTE' ? cellListData.lte : cellListData.nr
    const allIds = sectors.map(s => s.id)
    const allSelected = allIds.every(id => selectedCellIdsSet.has(id))
    if (allSelected) {
      // 取消全选：从选中集合中移除当前网络类型的所有小区
      setSelectedCellIdsSet(prev => {
        const next = new Set(prev)
        allIds.forEach(id => next.delete(id))
        return next
      })
    } else {
      // 全选：添加所有当前网络类型的小区
      setSelectedCellIdsSet(prev => {
        const next = new Set(prev)
        allIds.forEach(id => next.add(id))
        return next
      })
    }
  }

  // 清空所有选中
  const clearSelections = () => {
    setSelectedCellIdsSet(new Set())
  }

  // 上传待规划小区文件
  const handleUploadCellFile = () => {
    cellFileInputRef.current?.click()
  }

  const handleCellFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.name.toLowerCase().startsWith('cell-tree')) {
      setError(i18n.cellFilePrefixError || '文件名必须以"cell-tree"开头')
      e.target.value = ''
      return
    }

    setCellFileUploading(true)
    setError(null)
    try {
      // 1. 本地解析文件，提取小区ID
      const extractedIds = await extractCellIdsFromFile(file)
      if (extractedIds.length === 0) {
        setError(i18n.noCellIdsExtracted || '未能从文件中提取到小区ID，请检查文件格式')
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
        setError(i18n.noMatchingCells || '未匹配到任何小区，请检查文件内容与当前工参数据是否一致')
      }
    } catch (err: any) {
      console.error('[NeighborPage] 处理待规划小区文件失败:', err)
      setError(err.message || (i18n.cellFileUploadFailed || '待规划小区文件处理失败'))
    } finally {
      setCellFileUploading(false)
      e.target.value = ''
    }
  }

  // 下载待规划小区模板（根据当前规划类型的源网络类型动态生成）
  const handleDownloadCellTemplate = () => {
    try {
      const sourceType = (config.planningType.split('-')[0] as 'LTE' | 'NR') || 'LTE'
      downloadCellTreeTemplate(sourceType)
    } catch (err: any) {
      console.error('[NeighborPage] 下载模板失败:', err)
      alert(`下载模板失败: ${err.message || ''}`)
    }
  }

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
    setWizardStep('idle')
    setTaskName(''); setTaskNameError(null); setNextTaskError(null)
    setSelectedCellIdsSet(new Set()); setError(null)
    setConfig({ planningType: 'LTE-LTE', maxNeighbors: 64, coverageDistanceFactor: 1.0, coverageRadiusFactor: 1.0 })
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
      const nameError = validateTaskName(taskName)
      if (nameError) { setTaskNameError(nameError); return }
      setTaskNameError(null); setWizardStep('params_set'); setError(null)
    } else if (wizardStep === 'params_set') {
      const validationError = validateNeighborConfig(config)
      if (validationError) { setNextTaskError(validationError); return }
      setNextTaskError(null); setWizardStep('cells_selected'); setSelectedCellIdsSet(new Set()); setError(null)
    } else if (wizardStep === 'cells_selected') {
      if (selectedCellIdsSet.size === 0) {
        setError(i18n.noCellsSelected || '请在小区选择列表中至少选择一个小区后再执行邻区规划')
        return
      }
      handleExecute()
    } else if (wizardStep === 'completed') {
      setActiveLeftTab('planning-result'); setShowMap(true)
    }
  }, [wizardStep, taskName, config, selectedCellIdsSet])

  const handleNewTask = () => { setWizardStep('task_created'); setTaskNameError(null); setError(null) }

  const handleParamsSetup = () => {
    const nameError = validateTaskName(taskName)
    if (nameError) { setTaskNameError(nameError); return }
    setTaskNameError(null); setWizardStep('params_set'); setError(null)
  }

  const handleSelectCells = () => {
    const validationError = validateNeighborConfig(config)
    if (validationError) { setNextTaskError(validationError); return }
    setNextTaskError(null); setWizardStep('cells_selected'); setSelectedCellIdsSet(new Set()); setError(null)
  }

  const handleExecute = async () => {
    if (selectedCellIdsSet.size === 0) {
      setError(i18n.noCellsSelected || '请在小区选择列表中至少选择一个小区后再执行邻区规划')
      return
    }
    const validationError = validateNeighborConfig(config)
    if (validationError) { setError(validationError); return }
    setError(null); setLocalTaskResult(null); setLoading(true)
    setWizardStep('executing'); errorCountRef.current = 0
    try {
      const response: ApiResponse<{ taskId: string; message: string }> = await neighborApi.plan({
        taskName: taskName,
        planningType: config.planningType as 'LTE-LTE' | 'NR-NR' | 'NR-LTE',
        maxNeighbors: config.maxNeighbors,
        coverageDistanceFactor: config.coverageDistanceFactor,
        coverageRadiusFactor: config.coverageRadiusFactor,
        selectedCellIds: Array.from(selectedCellIdsSet)
      })
      if (response.success && response.data) {
        const newTaskId = response.data.taskId
        setActiveTaskId('neighbor_planning', newTaskId)
        setLocalTaskResult({ taskId: newTaskId, status: 'pending' as const, progress: 0, totalSites: 0, totalSectors: 0, totalNeighbors: 0, avgNeighbors: 0, startTime: new Date().toISOString() })
        startTask(newTaskId, 'neighbor_planning', i18n.startTaskMsg, taskName, user?.username)
      } else {
        setError(response.message || i18n.startTaskFailed); setWizardStep('cells_selected')
      }
    } catch (err: any) {
      setError(err.message || i18n.startTaskFailed); setWizardStep('cells_selected')
    } finally { setLoading(false) }
  }

  // 从历史任务查看 - 跳转到结果页并自动打开地图
  const handleViewTask = async (task: any) => {
    try {
      const response = await neighborApi.getResult(task.id)
      if (response?.success && response?.data) {
        const result = response.data as NeighborResultData
        viewedTaskIdRef.current = task.id // 必须在 setActiveTaskId 之前设置！
        setLocalTaskResult(result)
        setActiveTaskId('neighbor_planning', task.id)
        setActiveLeftTab('planning-result')
        setShowMap(true)
        if (result.results) {
          neighborDataSyncService.setNeighborResults({ results: result.results })
        }
      }
    } catch (err: any) {
      console.error('加载邻区规划结果失败:', err)
      setError('加载规划结果失败: ' + (err.message || '未知错误'))
    }
  }

  const handleExport = async () => {
    if (!taskId) return

    try {
      const blob = await neighborApi.export(taskId, 'xlsx')
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url

      // 生成带邻区规划类型和时间戳的文件名
      const now = new Date()
      const timestamp = now.toISOString().slice(0, 19).replace(/:/g, '-').replace('T', '_')
      const planningType = config.planningType
      a.download = `neighbor_result_${planningType}_${timestamp}.xlsx`

      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
    } catch (err: any) {
      setError(i18n.exportFailed + ': ' + (err.message || '未知错误'))
    }
  }

  // 处理源小区行点击
  const handleSourceSectorClick = (sourceSector: any, targetSectors: any[]) => {
    console.log('[NeighborPage] 源小区被点击:', sourceSector)
    console.log('[NeighborPage] 源小区属性:', {
      sourceKey: sourceSector.sourceKey,
      sourceSiteId: sourceSector.sourceSiteId,
      sourceCellId: sourceSector.sourceCellId
    })
    console.log('[NeighborPage] 目标小区数量:', targetSectors.length)

    setSelectedSourceSector(sourceSector)
    console.log('[NeighborPage] selectedSourceSector 已更新')

    // 构建目标小区ID集合（使用下划线分隔，与mapDataService的ID格式一致）
    const targetSectorIds = new Set(
      targetSectors.map(t => `${t.targetSiteId}_${t.targetCellId}`)
    )

    // 构建源小区ID（使用下划线分隔）
    const sourceSectorId = `${sourceSector.sourceSiteId}_${sourceSector.sourceCellId}`

    console.log('[NeighborPage] 调用地图高亮', {
      sourceSectorId,
      targetSectorIds: Array.from(targetSectorIds),
      targetCount: targetSectorIds.size
    })

    // 先设置高亮配置（使用与图例一致的颜色）
    mapRef.current?.setNeighborHighlight({
      sourceSectorId,
      targetSectorIds,
      sourceColor: '#FF0000',  // 红色（与图例一致）
      targetColor: '#0000FF'   // 蓝色（与图例一致）
    })

    // 构建白名单：源小区 + 所有目标小区
    const whitelist = new Set<string>([sourceSectorId, ...Array.from(targetSectorIds)])

    console.log('[NeighborPage] 设置扇区白名单', {
      count: whitelist.size,
      sourceId: sourceSectorId,
      targetCount: targetSectorIds.size
    })

    // 设置白名单（这会触发加载邻区同步数据并重建图层）
    mapRef.current?.setSectorIdWhitelist(whitelist, 'neighbor-planning')

    // 查找源小区的经纬度用于飞至该位置
    const sourceSectorData = neighborDataSyncService.findSector(
      sourceSector.sourceSiteId,
      sourceSector.sourceCellId
    )

    // 收集所有需要显示的小区坐标（源小区 + 目标小区）
    const allSectorCoordinates: Array<{ lat: number; lng: number }> = []

    if (sourceSectorData && sourceSectorData.displayLat && sourceSectorData.displayLng) {
      allSectorCoordinates.push({
        lat: sourceSectorData.displayLat,
        lng: sourceSectorData.displayLng
      })
    }

    // 收集目标小区坐标
    for (const target of targetSectors) {
      const targetSectorData = neighborDataSyncService.findSector(
        target.targetSiteId,
        target.targetCellId
      )
      if (targetSectorData && targetSectorData.displayLat && targetSectorData.displayLng) {
        allSectorCoordinates.push({
          lat: targetSectorData.displayLat,
          lng: targetSectorData.displayLng
        })
      }
    }

    // 智能缩放：计算包含所有选中小区的边界并调整地图
    if (allSectorCoordinates.length > 0 && mapRef.current) {
      // 计算边界
      const lats = allSectorCoordinates.map(c => c.lat)
      const lngs = allSectorCoordinates.map(c => c.lng)
      const minLat = Math.min(...lats)
      const maxLat = Math.max(...lats)
      const minLng = Math.min(...lngs)
      const maxLng = Math.max(...lngs)

      // 计算中心点
      const centerLat = (minLat + maxLat) / 2
      const centerLng = (minLng + maxLng) / 2

      // 计算合适的缩放级别
      const latDiff = maxLat - minLat
      const lngDiff = maxLng - minLng
      const maxDiff = Math.max(latDiff, lngDiff)

      // 根据覆盖范围计算缩放级别（经验公式）
      let zoom = 14
      if (maxDiff > 0.5) zoom = 10
      else if (maxDiff > 0.2) zoom = 11
      else if (maxDiff > 0.1) zoom = 12
      else if (maxDiff > 0.05) zoom = 13
      else if (maxDiff > 0.02) zoom = 14
      else if (maxDiff > 0.01) zoom = 15
      else zoom = 16

      // 飞到计算出的位置和缩放级别（即时跳转）
      mapRef.current.flyTo([centerLat, centerLng], zoom, 0)
    } else if (sourceSectorData && sourceSectorData.displayLat && sourceSectorData.displayLng) {
      // 如果没有坐标数据，回退到源小区位置
      mapRef.current?.flyTo(
        [sourceSectorData.displayLat, sourceSectorData.displayLng],
        14,
        0
      )
    }

    console.log('[NeighborPage] 源小区行点击处理完成', {
      sourceSiteId: sourceSector.sourceSiteId,
      sourceCellId: sourceSector.sourceCellId,
      targetCount: targetSectorIds.size
    })
  }

  // 处理小区搜索
  const handleSearch = async () => {
    if (!searchValue.trim()) {
      setSearchError(i18n.searchErrorNoInput)
      return
    }

    setSearchError(null)
    const trimmedSearch = searchValue.trim()

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
          foundSector = neighborDataSyncService.findSector(siteId, sectorId)
          console.log('[NeighborPage] 按ID搜索', { siteId, sectorId, found: !!foundSector })
        }
      }

      // 如果按ID没找到，尝试按小区名称搜索（遍历所有扇区数据）
      if (!foundSector) {
        const syncedData = neighborDataSyncService.getFullParamsData()
        if (syncedData) {
          const allSectors = [...syncedData.lte, ...syncedData.nr]
          foundSector = allSectors.find(s => s.name === trimmedSearch) || null
          if (foundSector) {
            siteId = foundSector.siteId || ''
            sectorId = foundSector.sectorId || ''
            console.log('[NeighborPage] 按名称搜索', {
              name: trimmedSearch,
              siteId,
              sectorId,
              found: true
            })
          }
        }
      }

      if (!foundSector) {
        setSearchError(i18n.searchErrorNotFound + ': ' + trimmedSearch)
        return
      }

      console.log('[NeighborPage] 找到小区', foundSector)

      // 构建扇区ID（使用下划线格式，与sector.id一致）
      const sectorKey = `${foundSector.siteId}_${foundSector.sectorId}`

      console.log('[NeighborPage] 搜索找到小区', {
        sectorKey,
        name: foundSector.name,
        lat: foundSector.displayLat,
        lng: foundSector.displayLng
      })

      setSearchError(null)

      // 智能缩放：飞到该扇区位置并添加搜索标记
      if (foundSector.displayLat && foundSector.displayLng) {
        mapRef.current?.flyTo([foundSector.displayLat, foundSector.displayLng], 16)

        // 添加搜索标记
        const newMarker = {
          id: sectorKey,
          name: foundSector.name || `${foundSector.siteId}-${foundSector.sectorId}`,
          lat: foundSector.displayLat,
          lng: foundSector.displayLng
        }

        // 检查是否已存在相同标记
        const markerExists = searchMarkers.some(m => m.id === newMarker.id)
        if (!markerExists) {
          const updatedMarkers = [...searchMarkers, newMarker]
          setSearchMarkers(updatedMarkers)
          // 添加标记到地图
          mapRef.current?.addLocationMarker({
            id: newMarker.id,
            lat: newMarker.lat,
            lng: newMarker.lng,
            name: newMarker.name
          }, updatedMarkers.length)
        }

        console.log('[NeighborPage] 搜索完成', {
          sectorKey,
          markerAdded: !markerExists,
          totalMarkers: searchMarkers.length + (!markerExists ? 1 : 0)
        })
      } else {
        setSearchError(i18n.searchErrorNoCoords)
      }
    } catch (err) {
      console.error('[NeighborPage] 搜索失败', err)
      setSearchError(i18n.searchErrorFailed)
    }
  }

  // 清除搜索
  const handleClearSearch = () => {
    setSearchValue('')
    setSearchError(null)
    setSelectedSourceSector(null)
    mapRef.current?.clearNeighborHighlight()
    // 清除白名单，显示所有扇区
    mapRef.current?.clearSectorIdWhitelist()
    // 清除搜索定位标记
    setSearchMarkers([])
    mapRef.current?.clearLocationMarkers()
  }

  // 清除所有搜索标记
  const handleClearMarkers = () => {
    setSearchMarkers([])
    mapRef.current?.clearLocationMarkers()
    console.log('[NeighborPage] 已清除所有搜索标记')
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
    console.log('[NeighborPage] 已清除所有标记（定位 + 测距）')
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

  // 处理地图扇区点击
  const handleMapSectorClick = (sector: RenderSectorData) => {
    console.log('[NeighborPage] 地图扇区点击', sector.id, sector.name)

    // 可以在这里添加其他逻辑，比如高亮对应的结果表格行等
  }

  const isRunning = localTaskResult?.status === 'pending' || localTaskResult?.status === 'processing'

  return (
    <div className="h-full flex flex-col p-4 min-h-0">
      <h1 className="text-3xl font-bold mb-6 shrink-0">{i18n.title}</h1>

      {/* 错误提示 */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3 text-red-700 shrink-0">
          <AlertCircle size={18} />
          <span className="text-sm">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-sm underline">{i18n.close}</button>
        </div>
      )}

      {/* 两列布局：左侧参数+结果，右侧地图 */}
      <div className="flex flex-col lg:flex-row gap-4 min-h-0 flex-1 overflow-hidden">
        {/* 左列：规划参数 + 规划结果 */}
        <div className="flex flex-col gap-4 min-h-0 flex-1 min-w-0">
          {/* 小区选择与结果面板（页签切换） */}
          <div className="bg-card p-3 rounded-lg border border-border flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* 页签切换栏 */}
            <div className="flex items-center gap-1 mb-3 border-b border-border">
              {/* 历史任务 tab */}
              <button
                onClick={() => !isRunning && setActiveLeftTab('history')}
                className={activeLeftTab === 'history' ? btn.activeTab : btn.ghost}
                disabled={isRunning}
              >
                {t('common.historyTask') || '历史任务'}
                <span className={btn.badgeCount}>{neighborHistoryCount}</span>
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
                {i18n.result}
                {taskResult?.status === 'completed' && (
                  <span className={btn.badgeSuccess}>✓</span>
                )}
                {taskResult?.status === 'failed' && (
                  <span className={btn.badgeError}>!</span>
                )}
                {isRunning && (
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
                          <button onClick={() => setNextTaskError(null)} className="ml-auto text-sm underline">{i18n.close}</button>
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
                        {taskNameError && <p className="mt-1 text-xs text-red-500">{taskNameError}</p>}
                        <p className="mt-1 text-xs text-muted-foreground">{taskName.length}/25</p>
                      </div>

                      {/* 邻区规划参数 */}
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                          <div>
                            <label className="block text-xs font-medium mb-0.5">{i18n.planningType}</label>
                            <select
                              value={config.planningType}
                              onChange={(e) => setConfig({ planningType: e.target.value })}
                              disabled={wizardStep !== 'params_set'}
                              className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                              <option value="LTE-LTE">LTE-LTE</option>
                              <option value="NR-NR">NR-NR</option>
                              <option value="NR-LTE">NR-LTE</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium mb-0.5">{i18n.maxNeighbors}</label>
                            <NumberInput
                              value={config.maxNeighbors}
                              onChange={(v) => setConfig({ maxNeighbors: v })}
                              disabled={wizardStep !== 'params_set'}
                              min={1}
                              max={MAX_NEIGHBORS_LIMIT[config.planningType] || 512}
                              className="w-full"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium mb-0.5" title={i18n.distanceFactorTooltip}>{i18n.distanceFactor}</label>
                            <NumberInput
                              value={config.coverageDistanceFactor}
                              onChange={(v) => setConfig({ coverageDistanceFactor: v })}
                              disabled={wizardStep !== 'params_set'}
                              min={0.1}
                              max={2.0}
                              className="w-full"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium mb-0.5" title={i18n.radiusFactorTooltip}>{i18n.radiusFactor}</label>
                            <NumberInput
                              value={config.coverageRadiusFactor}
                              onChange={(v) => setConfig({ coverageRadiusFactor: v })}
                              disabled={wizardStep !== 'params_set'}
                              min={0.1}
                              max={2.0}
                              className="w-full"
                            />
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
                        sectors={(() => { const sourceType = config.planningType.split('-')[0] as 'LTE' | 'NR'; return sourceType === 'LTE' ? cellListData.lte : cellListData.nr })()}
                        selectedCellIds={selectedCellIdsSet}
                        onToggleCell={wizardStep === 'cells_selected' && !isRunning ? toggleCellSelection : () => {}}
                        onSelectAll={wizardStep === 'cells_selected' && !isRunning ? toggleSelectAll : () => {}}
                        onClearSelections={wizardStep === 'cells_selected' && !isRunning ? clearSelections : () => {}}
                        selectedCountText={i18n.selectedCount.replace('{{count}}', String(selectedCellIdsSet.size))}
                        searchPlaceholder={i18n.cellSearchPlaceholder}
                        loading={cellListLoading}
                        onUploadCellFile={wizardStep === 'cells_selected' ? handleUploadCellFile : undefined}
                        onDownloadCellTemplate={wizardStep === 'cells_selected' ? handleDownloadCellTemplate : undefined}
                        uploading={cellFileUploading}
                        disabled={wizardStep !== 'cells_selected' || isRunning}
                        columnLabels={{ siteId: i18n.sourceSiteId, cellId: i18n.sourceCellId, cellName: i18n.sourceCellName, selectAll: i18n.selectAll, clearSelections: i18n.clearSelections, uploadCellFile: i18n.uploadCellFile, downloadCellTemplate: i18n.downloadCellTemplate }}
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
                    taskType="neighbor_planning"
                    typeLabel="邻区规划"
                    onSelectTask={(task) => {
                      if (task.result) {
                        const result = task.result as NeighborResultData
                        setLocalTaskResult(result)
                        setActiveTaskId('neighbor_planning', task.id)
                        setActiveLeftTab('planning-result')
                        if (result.results) {
                          neighborDataSyncService.setNeighborResults(result.results)
                        }
                        setSelectedSourceSector(null)
                      }
                    }}
                    onViewTask={handleViewTask}
                    getCellCount={getCellCount}
                  />
                </div>
              )}

              {activeLeftTab === 'planning-result' && (

                /* 规划结果面板（原内容） */
                <div className="flex flex-col h-full overflow-hidden">
                  {/* 标题行 + 统计卡片 */}
                  <div className="flex items-center gap-3 mb-3 flex-wrap shrink-0">
                    {taskResult?.status === 'completed' && (
                      <>
                        <div className="flex gap-2">
                          <CompactStatCard title={i18n.siteCount} value={taskResult.totalSites || 0} />
                          <CompactStatCard title={i18n.cellCount} value={taskResult.totalSectors || 0} />
                          <CompactStatCard title={i18n.neighborCount} value={taskResult.totalNeighbors || 0} />
                          <CompactStatCard title={i18n.avgNeighbors} value={taskResult.avgNeighbors || 0} />
                        </div>
                        <div className="flex items-center gap-3 ml-auto">
                          <button
                            onClick={() => {
                              if (resultSearchEnabled) {
                                setResultSearchFilters({
                                  relationType: '', sourceSiteId: '', sourceCellId: '', sourceCellName: '',
                                  sourceFrequency: '', sourcePci: '', targetSiteId: '', targetCellId: '',
                                  targetCellName: '', targetFrequency: '', targetPci: '', distance: ''
                                })
                                setFilteredResults([])
                              }
                              setResultSearchEnabled(!resultSearchEnabled)
                            }}
                            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors text-xs font-medium ${
                              resultSearchEnabled
                                ? 'bg-blue-400 text-white hover:bg-blue-500'
                                : 'bg-card border border-border hover:bg-muted/80'
                            }`}
                          >
                            <Search size={14} />
                            {i18n.search}
                          </button>
                          <button
                            onClick={handleExport}
                            className="flex items-center justify-center gap-2 px-3 py-1.5 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium whitespace-nowrap"
                          >
                            <Download size={14} />
                            {i18n.export}
                          </button>
                          <button
                            onClick={() => setShowMap(prev => !prev)}
                            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors text-xs font-medium whitespace-nowrap ${
                              showMap
                                ? 'bg-blue-400 text-white hover:bg-blue-500'
                                : 'bg-card border border-border hover:bg-muted/80'
                            }`}
                          >
                            <Eye size={14} />
                            {i18n.showMap}
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {!taskResult ? (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                      <Settings size={48} className="mx-auto mb-4 opacity-50" />
                      <div className="text-center">
                        {wizardStep === 'idle' ? (
                          <p>{t('common.configureFirst') || '请先点击"新建"按钮创建任务'}</p>
                        ) : (
                          <p>{t('common.selectCellsThenExecute') || '按向导完成参数设置 → 选择小区 → 执行'}</p>
                        )}
                        <p className="text-xs mt-2">{i18n.needUpload}</p>
                      </div>
                    </div>
                  ) : taskResult.status === 'failed' ? (
                    <div className="flex-1 flex items-center justify-center text-red-500">
                      <AlertCircle size={48} className="mx-auto mb-4" />
                      <p className="font-semibold">{i18n.taskFailed}</p>
                    </div>
                  ) : taskResult.status === 'completed' && !(taskResult as any).results ? (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                      <AlertCircle size={48} className="mx-auto mb-4 opacity-50" />
                      <p>{t('common.resultUnavailable') || '结果数据不可用，请重新执行规划任务'}</p>
                    </div>
                  ) : hasFullResult ? (
                    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                      {taskResult.results && taskResult.results.length > 0 ? (
                        <NeighborTable
                          results={filteredResults}
                          onSourceSectorClick={handleSourceSectorClick}
                          selectedSectorKey={selectedSourceSector?.sourceKey || null}
                          searchEnabled={resultSearchEnabled}
                          searchFilters={resultSearchFilters}
                          onSearchChange={handleResultSearchChange}
                          columnWidths={neighborColumnWidths}
                          resizingColumn={neighborResizingColumn}
                          onResizeStart={handleNeighborResizeStart}
                        />
                      ) : (
                        <div className="flex items-center justify-center h-full text-muted-foreground">
                          <p>{i18n.noResult}</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                      <Loader2 className="animate-spin mx-auto mb-4" size={48} />
                      <p>{i18n.planningInProgress}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 右列：地图窗口 - 可折叠 */}
        <div
          className="overflow-hidden transition-[width] duration-300 flex-shrink-0 flex flex-col"
          style={{ width: showMap ? '50%' : '0px' }}
        >
          <div className="bg-card rounded-lg border border-border p-3 flex-1 flex flex-col min-h-0 min-w-[600px]">
            {/* 搜索栏 */}
            <div className="flex items-center gap-2 mb-2">
              <div className="relative flex-1 max-w-[300px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
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
                  placeholder={i18n.searchPlaceholder}
                  className="w-full pl-10 pr-10 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-xs"
                />
                {searchValue && (
                  <button
                    onClick={handleClearSearch}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
              <button
                onClick={handleSearch}
                className="flex items-center gap-2 px-3 py-2 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors text-xs"
              >
                <Search size={14} />
                {i18n.search}
              </button>
              <button
                onClick={handleToggleMeasure}
                className={`flex items-center gap-2 px-3 py-2 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors text-xs ${
                  measureMode ? 'bg-primary' : ''
                }`}
                title={measureMode ? i18n.exitMeasureMode : i18n.enterMeasureMode}
              >
                <Ruler size={14} />
                {i18n.measure}
              </button>
              <button
                onClick={handleClearAllMarkers}
                className="flex items-center gap-2 px-3 py-2 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors text-xs"
                title={i18n.clearMarkersTip}
              >
                <X size={14} />
                {i18n.clear}
              </button>
              <div className="ml-auto">
                <MapTypeSwitch mapRef={mapRef} />
              </div>
            </div>

            {/* 搜索标记计数 */}
            {searchMarkers.length > 0 && (
              <div className="mb-2 p-2 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg text-xs text-blue-700 dark:text-blue-300 flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Search size={14} />
                  {i18n.searchMarkerCount.replace('{{count}}', String(searchMarkers.length))}
                </span>
                <button
                  onClick={handleClearMarkers}
                  className="text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-100 font-medium"
                >
                  {i18n.clearAll}
                </button>
              </div>
            )}

            {/* 搜索错误提示 */}
            {searchError && (
              <div className="mb-2 p-2 bg-orange-50 border border-orange-200 rounded-lg text-xs text-orange-700 flex items-center gap-2">
                <AlertCircle size={14} />
                <span className="flex-1">{searchError}</span>
                <button
                  onClick={() => setSearchError(null)}
                  className="text-orange-700 hover:text-orange-900"
                >
                  <X size={14} />
                </button>
              </div>
            )}

            {/* 地图容器 */}
            <div className="flex-1 rounded-lg overflow-hidden relative min-h-0">
            {(showMap || mapEverLoadedRef.current) && (
              <>
                {!mapEverLoadedRef.current && (mapEverLoadedRef.current = true)}
                <OnlineMap
                  ref={mapRef}
                  mode="neighbor-planning"
                  neighborData={taskResult?.results || []}
                  onSectorClick={handleMapSectorClick}
                  onMapReady={() => {
                    console.log('[NeighborPage] 地图已就绪')
                  }}
                  measureMode={measureMode}
                  onMeasureModeEnd={handleMeasureModeEnd}
                />
                <NeighborLegend
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

// 邻区规划结果表格 - 按源小区分组显示（带虚拟滚动）
function NeighborTable({
  results,
  onSourceSectorClick,
  selectedSectorKey,
  searchEnabled,
  searchFilters,
  onSearchChange,
  columnWidths,
  resizingColumn,
  onResizeStart
}: {
  results: any[]
  onSourceSectorClick?: (sourceSector: any, targetSectors: any[]) => void
  selectedSectorKey?: string | null
  searchEnabled?: boolean
  searchFilters?: any
  onSearchChange?: (field: string, value: string) => void
  columnWidths: Record<string, number>
  resizingColumn: string | null
  onResizeStart: (columnKey: string, startX: number) => void
}) {
  const { t } = useTranslation()

  // 表格翻译文本
  const tableI18n = {
    noMatchResult: t('neighbor.noMatchResult') || '暂无匹配结果',
    searchColPlaceholder: t('neighbor.searchColPlaceholder') || '搜索',
    // 表格列
    relationType: t('neighbor.relationType') || '关系类型',
    sourceSiteId: t('neighbor.sourceSiteId') || '源基站ID',
    sourceCellId: t('neighbor.sourceCellId') || '源小区ID',
    sourceCellName: t('neighbor.sourceCellName') || '源小区名称',
    sourceFrequency: t('neighbor.sourceFrequency') || '源频点',
    sourcePci: t('neighbor.sourcePci') || '源PCI',
    targetSiteId: t('neighbor.targetSiteId') || '目标基站ID',
    targetCellId: t('neighbor.targetCellId') || '目标小区ID',
    targetCellName: t('neighbor.targetCellName') || '目标小区名称',
    targetFrequency: t('neighbor.targetFrequency') || '目标频点',
    targetPci: t('neighbor.targetPci') || '目标PCI',
    distance: t('neighbor.distance') || '距离',
  }

  // 邻区表格列配置
  const tableColumns = [
    { key: 'relationType', label: tableI18n.relationType, defaultWidth: 80 },
    { key: 'sourceSiteId', label: tableI18n.sourceSiteId, defaultWidth: 80 },
    { key: 'sourceCellId', label: tableI18n.sourceCellId, defaultWidth: 80 },
    { key: 'sourceCellName', label: tableI18n.sourceCellName, defaultWidth: 120 },
    { key: 'sourceFrequency', label: tableI18n.sourceFrequency, defaultWidth: 70 },
    { key: 'sourcePci', label: tableI18n.sourcePci, defaultWidth: 60 },
    { key: 'targetSiteId', label: tableI18n.targetSiteId, defaultWidth: 80 },
    { key: 'targetCellId', label: tableI18n.targetCellId, defaultWidth: 80 },
    { key: 'targetCellName', label: tableI18n.targetCellName, defaultWidth: 120 },
    { key: 'targetFrequency', label: tableI18n.targetFrequency, defaultWidth: 70 },
    { key: 'targetPci', label: tableI18n.targetPci, defaultWidth: 60 },
    { key: 'distance', label: tableI18n.distance, defaultWidth: 70 }
  ]

  console.log('[NeighborTable] Props received:', { selectedSectorKey, resultsCount: results?.length })

  // 按源小区分组（使用下划线格式，与sector.id一致）
  const groupedData = useMemo(() => {
    const sourceGroupMap = new Map<string, any[]>()
    results?.forEach((row: any) => {
      const key = `${row.sourceSiteId}_${row.sourceCellId}`
      if (!sourceGroupMap.has(key)) {
        sourceGroupMap.set(key, [])
      }
      sourceGroupMap.get(key)!.push(row)
    })

    // 转换为数组并排序
    return Array.from(sourceGroupMap.entries()).map(([sourceKey, targets]) => {
      const firstRow = targets[0]
      return {
        sourceKey,
        sourceSiteId: firstRow.sourceSiteId,
        sourceCellId: firstRow.sourceCellId,
        sourceCellName: firstRow.sourceCellName,
        sourceFrequency: firstRow.sourceFrequency,
        sourcePci: firstRow.sourcePci,
        relationType: firstRow.relationType,
        targets
      }
    })
  }, [results])

  // 虚拟滚动状态
  const [scrollTop, setScrollTop] = useState(0)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  // 计算总行数（展开后的行数）
  const totalRows = useMemo(() => {
    return groupedData.reduce((sum, group) => sum + group.targets.length, 0)
  }, [groupedData])

  // 计算虚拟滚动的可见数据
  const virtualData = useMemo(() => {
    const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_COUNT)
    const endIndex = Math.min(
      totalRows,
      Math.ceil((scrollTop + VISIBLE_COUNT * ITEM_HEIGHT) / ITEM_HEIGHT) + BUFFER_COUNT
    )
    
    // 将分组数据转换为扁平的行数据
    const flatRows: any[] = []
    groupedData.forEach((group) => {
      group.targets.forEach((target: any, targetIdx: number) => {
        flatRows.push({
          ...target,
          group,
          targetIdx,
          isFirstInGroup: targetIdx === 0
        })
      })
    })
    
    return {
      startIndex,
      endIndex,
      visibleData: flatRows.slice(startIndex, endIndex),
      totalHeight: totalRows * ITEM_HEIGHT,
      offsetY: startIndex * ITEM_HEIGHT
    }
  }, [scrollTop, groupedData, totalRows])

  // 处理滚动事件
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  // 重置滚动位置当数据变化时
  useEffect(() => {
    setScrollTop(0)
    if (tableContainerRef.current) {
      tableContainerRef.current.scrollTop = 0
    }
  }, [results])

  return (
    <div
      ref={tableContainerRef}
      onScroll={handleScroll}
      className="overflow-x-auto rounded-lg border border-border overflow-y-auto flex-1 min-h-0"
    >
      <table className="w-full text-xs text-left border-collapse table-fixed">
        <thead className="sticky top-0 z-20 bg-background border-b border-border shadow-sm">
          <tr>
            {tableColumns.map((column) => (
              <th
                key={column.key}
                className="text-left p-2 font-medium bg-background z-20 relative group border-r border-border"
                style={{ width: `${columnWidths[column.key]}px`, minWidth: `${columnWidths[column.key]}px` }}
              >
                <span className="block pr-3">{column.label}</span>
                {searchEnabled && onSearchChange && (
                  <input
                    type="text"
                    value={searchFilters?.[column.key] || ''}
                    onChange={(e) => onSearchChange(column.key, e.target.value)}
                    placeholder={tableI18n.searchColPlaceholder}
                    className="mt-1 w-full p-1 border border-border rounded text-[10px] text-gray-900 bg-gray-100 placeholder:text-gray-400"
                  />
                )}
                {/* 拖拽手柄 */}
                <div
                  className={`table-resize-handle ${resizingColumn === column.key ? 'resizing' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onResizeStart(column.key, e.clientX)
                  }}
                >
                  <GripVertical size={12} className="opacity-0 group-hover:opacity-40 text-muted-foreground absolute right-0.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {groupedData.length === 0 ? (
            <tr>
              <td colSpan={tableColumns.length} className="px-3 py-8 text-center text-muted-foreground">
                {tableI18n.noMatchResult}
              </td>
            </tr>
          ) : (
            <>
              {/* 顶部占位行 */}
              <tr style={{ height: `${virtualData.offsetY}px` }}>
                <td colSpan={tableColumns.length}></td>
              </tr>
              {virtualData.visibleData.map((row: any, index: number) => {
                const { group, targetIdx } = row
                const isSelected = selectedSectorKey === group.sourceKey
                const actualIndex = virtualData.startIndex + index

                return (
                  <tr
                    key={`${group.sourceKey}-${targetIdx}-${actualIndex}`}
                    className={`border-b cursor-pointer transition-colors ${
                      isSelected ? 'bg-[#87CEEB]' : 'bg-card hover:bg-muted/50'
                    }`}
                    style={{ height: `${ITEM_HEIGHT}px` }}
                    onClick={() => {
                      console.log('[NeighborTable] Row clicked:', group.sourceKey)
                      onSourceSectorClick?.(group, group.targets)
                    }}
                  >
                    {tableColumns.map((column) => {
                      const width = columnWidths[column.key]
                      let cellContent: any

                      switch (column.key) {
                        case 'relationType':
                          cellContent = (
                            <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                              group.relationType === 'LTE-LTE' ? 'bg-blue-100 text-blue-700' :
                              group.relationType === 'NR-NR' ? 'bg-purple-100 text-purple-700' :
                                'bg-green-100 text-green-700'
                            }`}>
                              {group.relationType}
                            </span>
                          )
                          break
                        case 'sourceSiteId':
                          cellContent = group.sourceSiteId
                          break
                        case 'sourceCellId':
                          cellContent = group.sourceCellId
                          break
                        case 'sourceCellName':
                          cellContent = group.sourceCellName
                          break
                        case 'sourceFrequency':
                          cellContent = group.sourceFrequency
                          break
                        case 'sourcePci':
                          cellContent = group.sourcePci
                          break
                        case 'targetSiteId':
                          cellContent = row.targetSiteId
                          break
                        case 'targetCellId':
                          cellContent = row.targetCellId
                          break
                        case 'targetCellName':
                          cellContent = row.targetCellName
                          break
                        case 'targetFrequency':
                          cellContent = row.targetFrequency
                          break
                        case 'targetPci':
                          cellContent = row.targetPci
                          break
                        case 'distance':
                          cellContent = row.distance
                          break
                        default:
                          cellContent = null
                      }

                      return (
                        <td
                          key={column.key}
                          className="p-2 truncate border-r border-border"
                          style={{ width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` }}
                          title={column.key.includes('Name') ? cellContent : undefined}
                        >
                          {cellContent}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
              {/* 底部占位行 */}
              <tr style={{ height: `${virtualData.totalHeight - virtualData.offsetY - virtualData.visibleData.length * ITEM_HEIGHT}px` }}>
                <td colSpan={tableColumns.length}></td>
              </tr>
            </>
          )}
        </tbody>
      </table>
    </div>
  )
}

// 紧凑型统计卡片（用于标题行，字体缩小）
function CompactStatCard({ title, value }: { title: string; value: string | number }) {
  return (
    <div className="bg-card px-2 py-1 rounded border border-border text-center min-w-[60px]">
      <p className="text-[10px] text-muted-foreground leading-tight">{title}</p>
      <p className="text-sm font-semibold text-primary leading-tight">{value}</p>
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
