import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Play, Download, Settings, Loader2, AlertCircle, Search, X, Ruler, GripVertical, Check, Eye } from 'lucide-react'
import { useTranslation } from 'react-i18next'


// 虚拟滚动配置
const ITEM_HEIGHT = 40 // 每行高度
const VISIBLE_COUNT = 25 // 可见行数
const BUFFER_COUNT = 5 // 缓冲行数
// 历史结果超过该邻区条数时不在打开页面时自动拉取完整结果：
// 单份 20 万+ 条邻区 JSON 解析后约 1GB，会把后端内存打满并触发 swap / 长时间高 CPU
// 结果表按「源小区」分页：每页包含该源小区的全部目标小区
const NEIGHBOR_SOURCE_PAGE_SIZE = 50
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
import { HistoryTabActions } from '../components/HistoryTabActions'
import { generateFullTaskName } from '../utils/taskNameUtils'
import { buildMissingCellsError } from '../utils/cellValidation'
import { StepIndicator } from '../components/StepIndicator'
import { WizardFooter } from '../components/WizardFooter'
import { NumberInput } from '../components/NumberInput'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { extractCellIdsFromFileGrouped, matchCellIds, downloadCellTreeTemplate } from '../utils/cellFileHelper'

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
  const { t, i18n: i18nInstance } = useTranslation()
  const user = useAuthStore((s) => s.user)
  const { wizardStep, setWizardStep, config, setConfig, selectedCellIds: storeSelectedCellIds, activeLeftTab, setActiveLeftTab, taskName, setTaskName, resetConfig: storeResetConfig } = useNeighborStore()
  const [taskNameError, setTaskNameError] = useState<string | null>(null)
  const [nextTaskError, setNextTaskError] = useState<string | null>(null)

  // 翻译文本（带中文后备）
  const i18n = {
    title: t('neighbor.title') || '邻区规划',
    planningParams: t('neighbor.planningParams') || '规划参数',
    result: t('neighbor.result') || '结果',
    startPlan: t('neighbor.startPlan') || '开始规划',
    planning: t('neighbor.planning') || '规划中...',
    starting: t('neighbor.starting') || '启动中...',
    export: t('neighbor.export') || '导出',
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
    cellFreq: t('neighbor.cellFreq') || '频点',
    cellPci: t('neighbor.cellPci') || 'PCI',
    cellLng: t('neighbor.cellLng') || '经度',
    cellLat: t('neighbor.cellLat') || '纬度',
    // 工具提示
    distanceFactorTooltip: t('neighbor.distanceFactorTooltip') || '覆盖圆距离系数：站点到覆盖圆心的距离系数，默认5/9(≈0.556)',
    radiusFactorTooltip: t('neighbor.radiusFactorTooltip') || '覆盖圆半径系数：覆盖半径系数，默认5/9(≈0.556)',
    maxNeighborsTooltip: t('neighbor.maxNeighborsTooltip') || '同频与异频邻区各自的上限：每小区同频邻区最多 N 个，异频邻区再单独最多 N 个',
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
    loadingResult: t('common.loadingResult') || '正在加载规划结果...',
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
  const isLoadingResultRef = useRef(false) // 标记结果加载是否有效，防止竞态
  const [resultLoading, setResultLoading] = useState(false) // 结果页加载动画
  const [loadingFullResult, setLoadingFullResult] = useState(false) // 大结果按需加载
  // 已按需加载过完整结果的 taskId：切回结果页时不要再用摘要覆盖
  const loadedFullResultTaskIdRef = useRef<string | null>(null)

  // ===== 分页结果（按源小区）=====
  const [pagedSources, setPagedSources] = useState<any[]>([])
  const [pagedSourceTotal, setPagedSourceTotal] = useState(0)
  const [pagedSourcePage, setPagedSourcePage] = useState(1)
  const [pagedLoading, setPagedLoading] = useState(false)
  const [pagedPreparing, setPagedPreparing] = useState(false)
  const [pagedRequest, setPagedRequest] = useState<{ taskId: string; summary?: any } | null>(null)
  const pagedTaskIdRef = useRef<string | null>(null)
  const pagedPollRef = useRef<number | null>(null)
  // 已经自动补拉过完整结果的 taskId，失败也不重试，避免 effect 循环打后端
  const [selectedCount, setSelectedCount] = useState(0)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const {
    updateTaskProgress, completeTask, failTask, activeTaskIds, setActiveTaskId, startTask,
    getLatestNeighborTask,
    startGlobalPolling, isGlobalPollingActive
  } = useTaskStore()
  const taskId = activeTaskIds.neighbor_planning
  // 响应式订阅当前活跃任务（含处理中 progress/status/result），跨页面切回时据此水合本地状态
  const activeStoreTask = useTaskStore((s: any) => (s.activeTaskIds.neighbor_planning ? s.tasks[s.activeTaskIds.neighbor_planning] : null))
  const latestNeighborTask = getLatestNeighborTask()
  // 🔥 修复：改用后端返回的真实任务总数（historyCounts），避免本地 store 缓存截断导致计数不准
  const neighborHistoryCount = useTaskStore(s => s.historyCounts.neighbor_planning)

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
  // 🔥 页面加载动画
  const [pageLoading, setPageLoading] = useState(true)
  const pageLoadingRef = useRef(true)
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
    setWizardStep('idle')
    setError(null)
  }, [storeResetConfig, setActiveTaskId, setWizardStep])

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
  // 🔥 页面挂载时同步一次历史计数（badge 显示后端真实任务总数）
  useEffect(() => {
    syncHistoryFromBackend('neighbor_planning').catch(() => {})
  }, [syncHistoryFromBackend])
  useEffect(() => {
    if (activeLeftTab === 'planning-result') {
      // 如果用户通过"查看"按钮加载了特定任务的结果，不要自动加载最新的
      if (viewedTaskIdRef.current) {
        return
      }
      isLoadingResultRef.current = true
      if (!localTaskResult && !latestNeighborTask?.result) {
        setResultLoading(true)
      }
      const loadLatest = async () => {
        await syncHistoryFromBackend('neighbor_planning')
        if (!isLoadingResultRef.current) return
        const latest = getLatestNeighborTask()
        if (latest?.status === 'completed' && latest.result) {
          setLocalTaskResult({ ...(latest.result as any), taskId: latest.id })
          setWizardStep('completed')
          if (pagedTaskIdRef.current !== latest.id) {
            setPagedRequest({ taskId: latest.id, summary: latest.result })
          }
        }
      }
      loadLatest().finally(() => {
        if (isLoadingResultRef.current) setResultLoading(false)
        isLoadingResultRef.current = false
      })
      return () => {
        isLoadingResultRef.current = false
        setResultLoading(false)
      }
    } else {
      // 离开结果页时清除 viewedTaskIdRef
      viewedTaskIdRef.current = null
    }
  }, [activeLeftTab])

  // ===== getCellCount =====
  const getCellCount = useCallback((task: Task): number | string => {
    // 归一化字段优先（同组镜像任务同步来的摘要只有它）
    if (task.result?.cellCount != null) return task.result.cellCount
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

  // 确定当前显示的任务结果（分页模式下只含摘要；完整 results 仅作兜底）
  const taskResult = localTaskResult || (latestNeighborTask?.result as NeighborResultData | null)
  const hasPagedSources = pagedSources.length > 0

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

  // 🔥 优化：延迟初始化邻区数据同步服务（页面挂载时不自动加载全量工参数据）
  const lazyNeighborInitRef = useRef<Promise<void> | null>(null)
  const ensureNeighborSyncService = useCallback(async () => {
    if (!lazyNeighborInitRef.current) {
      lazyNeighborInitRef.current = neighborDataSyncService.initialize().then(() => {
        setSyncServiceInitialized(true)
      }).catch(err => {
        lazyNeighborInitRef.current = null
        setSyncServiceInitialized(false)
        throw err
      })
    }
    return lazyNeighborInitRef.current
  }, [])

  // 当前有效搜索条件（供分页请求使用）
  const activeFilters = useMemo(() => {
    if (!resultSearchEnabled) return {}
    return Object.fromEntries(
      Object.entries(resultSearchFilters).filter(([, value]) => String(value || '').trim() !== '')
    )
  }, [resultSearchEnabled, resultSearchFilters])
  const activeFiltersRef = useRef<Record<string, string>>({})
  activeFiltersRef.current = activeFilters

  const fetchPagedSources = useCallback(async (
    targetTaskId: string,
    page: number,
    filters: Record<string, string>
  ): Promise<boolean> => {
    setPagedLoading(true)
    try {
      const response = await neighborApi.getResultSources(
        targetTaskId, page, NEIGHBOR_SOURCE_PAGE_SIZE, filters
      )
      const data = response?.data
      if (!response?.success || !data) return true
      if (data.preparing) {
        setPagedPreparing(true)
        return false
      }
      setPagedPreparing(false)
      const sources = Array.isArray(data.sources) ? data.sources : []
      setPagedSources(sources)
      setPagedSourceTotal(Number(data.total) || 0)
      setPagedSourcePage(Number(data.page) || page)
      const flat = sources.flatMap((source: any) => (source.targets || []).map((target: any) => ({
        ...target,
        sourceSiteId: target.sourceSiteId ?? source.sourceSiteId,
        sourceCellId: target.sourceCellId ?? source.sourceCellId,
        sourceCellName: target.sourceCellName ?? source.sourceCellName,
        sourceFrequency: target.sourceFrequency ?? source.sourceFrequency,
        sourcePci: target.sourcePci ?? source.sourcePci,
        relationType: target.relationType ?? source.relationType,
      })))
      setFilteredResults(flat)
      return true
    } catch (err: any) {
      console.warn('[NeighborPage] 加载分页结果失败:', err?.message)
      return true
    } finally {
      setPagedLoading(false)
    }
  }, [])

  const schedulePagedPollRef = useRef<(taskId: string) => void>(() => {})
  const schedulePagedPoll = useCallback((targetTaskId: string) => {
    if (pagedPollRef.current) return
    pagedPollRef.current = window.setTimeout(async () => {
      pagedPollRef.current = null
      if (pagedTaskIdRef.current !== targetTaskId) return
      try {
        const metaResponse = await neighborApi.getResultMeta(targetTaskId)
        if (metaResponse?.data?.rowsReady) {
          if (metaResponse.data.summary) {
            setLocalTaskResult({
              ...metaResponse.data.summary,
              taskId: targetTaskId,
              status: 'completed',
            } as NeighborResultData)
          }
          const ready = await fetchPagedSources(targetTaskId, 1, activeFiltersRef.current)
          if (!ready) schedulePagedPollRef.current(targetTaskId)
        } else {
          schedulePagedPollRef.current(targetTaskId)
        }
      } catch {
        schedulePagedPollRef.current(targetTaskId)
      }
    }, 1000)
  }, [fetchPagedSources])
  useEffect(() => {
    schedulePagedPollRef.current = schedulePagedPoll
  }, [schedulePagedPoll])
  useEffect(() => () => {
    if (pagedPollRef.current) {
      window.clearTimeout(pagedPollRef.current)
      pagedPollRef.current = null
    }
  }, [])

  /** 分页结果入口：先取摘要，再按源小区拉第一页；未建好索引时展示准备状态并轮询 */
  const loadPagedResult = useCallback(async (targetTaskId: string, fallbackSummary?: any) => {
    if (!targetTaskId) return
    if (pagedPollRef.current) {
      window.clearTimeout(pagedPollRef.current)
      pagedPollRef.current = null
    }
    pagedTaskIdRef.current = targetTaskId
    viewedTaskIdRef.current = targetTaskId
    loadedFullResultTaskIdRef.current = null
    setPagedSources([])
    setPagedSourceTotal(0)
    setPagedSourcePage(1)
    setFilteredResults([])
    setPagedPreparing(false)
    setResultLoading(true)
    try {
      const response = await neighborApi.getResultMeta(targetTaskId)
      const meta = response?.data
      if (!meta) {
        setError(i18n.getResultFailed)
        return
      }
      setLocalTaskResult({
        ...(meta.summary || fallbackSummary || {}),
        taskId: targetTaskId,
        status: 'completed',
      } as NeighborResultData)
      setWizardStep('completed')
      await ensureNeighborSyncService().catch(() => {})
      if (meta.rowsReady) {
        const ready = await fetchPagedSources(targetTaskId, 1, activeFiltersRef.current)
        if (!ready) schedulePagedPollRef.current(targetTaskId)
      } else {
        setPagedPreparing(true)
        schedulePagedPollRef.current(targetTaskId)
      }
    } catch (err: any) {
      setError(`${i18n.loadResultFailed}: ${err?.message || ''}`)
    } finally {
      setResultLoading(false)
    }
  }, [ensureNeighborSyncService, fetchPagedSources, i18n.getResultFailed, i18n.loadResultFailed])

  // 历史/任务完成时发起分页加载请求
  useEffect(() => {
    if (!pagedRequest) return
    const request = pagedRequest
    setPagedRequest(null)
    loadPagedResult(request.taskId, request.summary)
  }, [pagedRequest, loadPagedResult])

  // 搜索条件变化：防抖后从第一页重新查询（服务端搜索全量结果）
  useEffect(() => {
    const targetTaskId = pagedTaskIdRef.current
    if (!targetTaskId || pagedPreparing) return
    const timer = window.setTimeout(() => {
      fetchPagedSources(targetTaskId, 1, activeFiltersRef.current)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [resultSearchFilters, resultSearchEnabled, pagedPreparing, fetchPagedSources])

  const goToPagedSourcePage = useCallback((page: number) => {
    const targetTaskId = pagedTaskIdRef.current
    if (!targetTaskId || page < 1) return
    fetchPagedSources(targetTaskId, page, activeFiltersRef.current)
  }, [fetchPagedSources])

  /** 兜底：索引失败或用户主动要求时，仍可加载完整结果 */
  const loadFullResultForTask = useCallback(async (targetTaskId: string) => {
    if (!targetTaskId || loadingFullResult) return
    setLoadingFullResult(true)
    try {
      const response = await neighborApi.getResult(targetTaskId)
      if (response?.success && response?.data && (response.data as any).results) {
        const fullResult = response.data as NeighborResultData
        if (pagedPollRef.current) {
          window.clearTimeout(pagedPollRef.current)
          pagedPollRef.current = null
        }
        pagedTaskIdRef.current = null
        setPagedPreparing(false)
        viewedTaskIdRef.current = targetTaskId
        loadedFullResultTaskIdRef.current = targetTaskId
        setLocalTaskResult(fullResult)
        setWizardStep('completed')
        await ensureNeighborSyncService().catch(() => {})
        neighborDataSyncService.setNeighborResults({ results: fullResult.results || [] })
      } else {
        setError(i18n.getResultFailed)
      }
    } catch (err: any) {
      setError(`${i18n.loadResultFailed}: ${err?.message || ''}`)
    } finally {
      setLoadingFullResult(false)
    }
  }, [loadingFullResult, ensureNeighborSyncService, i18n.getResultFailed, i18n.loadResultFailed])

  // 任务完成时进度接口只回摘要：自动切到分页结果（不再整包拉取）
  useEffect(() => {
    if (taskResult?.status !== 'completed' || (taskResult as any).results) return
    const targetTaskId = taskResult.taskId || taskId
    if (!targetTaskId || pagedTaskIdRef.current === targetTaskId) return
    setPagedRequest({ taskId: targetTaskId, summary: taskResult })
  }, [taskResult?.status, taskResult?.taskId, taskResult?.results, taskId])

  useEffect(() => {
    let mounted = true

    // 🔥 优化：移除了 initSyncService 调用，页面挂载时不再自动加载全量工参

    // 监听数据刷新事件（当在其他页面上传新工参时）
    const handleDataRefresh = async () => {
      console.log('[NeighborPage] 收到数据刷新事件，正在清除缓存...')
      try {
        // 清除地图数据和小区列表缓存
        await mapDataService.clearCache()
        clearCellListCache()
        lazyNeighborInitRef.current = null // 数据刷新后清除懒加载缓存
        setSyncServiceInitialized(false)
        // 重新加载小区列表，确保新建任务页面使用最新数据
        loadCellList()
        console.log('[NeighborPage] 已清除缓存并重载小区列表')
      } catch (error) {
        console.warn('[NeighborPage] 数据刷新失败:', error)
      }
    }

    window.addEventListener(DATA_REFRESH_EVENT, handleDataRefresh)

    return () => {
      mounted = false
      window.removeEventListener(DATA_REFRESH_EVENT, handleDataRefresh)
    }
  }, [])

  // 邻区规划模式：仅在规划结果完成时加载全量扇区数据
  // 根据规划结果的关系类型决定加载哪些网络类型的扇区
  useEffect(() => {
    // 🔥 优化：懒加载同步服务（需要时才初始化）
    if (!syncServiceInitialized) {
      console.log('[NeighborPage] 同步服务未初始化，延迟加载...')
      ensureNeighborSyncService().catch(() => {})
      return
    }

    // 仅在规划任务完成且有结果时加载数据（分页模式下有当前页源小区即可）
    if (taskResult?.status !== 'completed') return
    if (!(taskResult?.results?.length) && !hasPagedSources) return

    const loadFullParamsData = async () => {
      try {
        // 直接从mapDataService获取全量工参数据（🔥 已静态导入，无需动态 import）

        // 根据规划结果的关系类型决定加载策略
        let shouldLoadLTE = false
        let shouldLoadNR = false

        // 检查规划结果的关系类型（分页模式下来自当前页的源小区）
        const relationTypes = new Set<string>(
          taskResult.results
            ? taskResult.results.map((r: any) => r.relationType || 'LTE-LTE')
            : pagedSources.map((source: any) => source.relationType || 'LTE-LTE')
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
  }, [taskResult?.status, taskResult?.results, hasPagedSources, syncServiceInitialized])

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
    } else if (!pagedTaskIdRef.current) {
      // 任务未完成且没有进入分页模式时才清空；分页数据由 fetchPagedSources 维护
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
  // 响应式同步活跃任务 → 本地状态（修复：切换到其他页面再切回时进度停滞/不显示完成）。
  // 全局轮询跨页面持续写入 store，本 effect 在任务 progress/status 变化时回填本地：
  //  - running/processing/pending：回填处理中状态+进度、确保全局轮询运行中、向导停在 executing
  //  - completed + result：回填完整结果（向导 effect 会推进到完成页）
  //  - failed：回填失败状态
  // viewedTaskIdRef 标记用户通过"查看"按钮打开的历史结果，不覆盖。
  useEffect(() => {
    if (!taskId || !activeStoreTask) return
    if (viewedTaskIdRef.current === taskId) return
    const st = activeStoreTask.status
    const progress = activeStoreTask.progress ?? 0

    if (st === 'completed' && activeStoreTask.result) {
      setLocalTaskResult(activeStoreTask.result as NeighborResultData)
    } else if (st === 'failed') {
      setLocalTaskResult((prev: NeighborResultData | null) =>
        prev?.taskId === taskId && (prev.status === 'failed' || prev.status === 'completed') ? prev : {
          taskId, status: 'failed' as const, progress,
          totalSites: 0, totalSectors: 0, totalNeighbors: 0, avgNeighbors: 0,
          startTime: new Date(activeStoreTask.startTime || Date.now()).toISOString(),
        })
    } else if (st === 'running' || st === 'processing' || st === 'pending') {
      setWizardStep('executing')
      setLocalTaskResult((prev: NeighborResultData | null) => {
        if (prev?.taskId === taskId && (prev.status === 'processing' || prev.status === 'pending')) {
          return prev.progress === progress ? prev : { ...prev, status: 'processing' as const, progress }
        }
        // remount 后本地无状态：从 store 水合（不覆盖已完成结果）
        if (prev?.taskId === taskId && prev.status === 'completed') return prev
        return {
          taskId, status: 'processing' as const, progress,
          totalSites: 0, totalSectors: 0, totalNeighbors: 0, avgNeighbors: 0,
          startTime: new Date(activeStoreTask.startTime || Date.now()).toISOString(),
        }
      })
      if (!isGlobalPollingActive('neighbor_planning')) {
        startGlobalPolling('neighbor_planning')
      }
    }
  }, [taskId, activeStoreTask, setWizardStep, isGlobalPollingActive, startGlobalPolling])

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
      // 🔥 首次加载完成，关闭页面加载动画
      if (pageLoadingRef.current) {
        pageLoadingRef.current = false
        setPageLoading(false)
      }
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

  // 全选/取消全选当前搜索过滤后的小区
  const toggleSelectAll = (filteredIds: string[]) => {
    const allIds = filteredIds
    const allSelected = allIds.length > 0 && allIds.every(id => selectedCellIdsSet.has(id))
    if (allSelected) {
      // 取消全选：从选中集合中移除当前过滤后的小区
      setSelectedCellIdsSet(prev => {
        const next = new Set(prev)
        allIds.forEach(id => next.delete(id))
        return next
      })
    } else {
      // 全选：添加所有当前过滤后的小区
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
      // 1. 本地解析文件，按网络类型分组提取小区ID
      const grouped = await extractCellIdsFromFileGrouped(file)

      // 规划类型决定期望的小区清单类型：
      // LTE-LTE 只能导入 LTE 小区；NR-NR / NR-LTE 只能导入 NR 小区
      const expectNet: 'lte' | 'nr' = config.planningType === 'LTE-LTE' ? 'lte' : 'nr'
      const expectLabel = expectNet === 'lte' ? 'LTE' : 'NR'
      const expectIds = grouped[expectNet]
      const otherIds = expectNet === 'lte' ? grouped.nr : grouped.lte

      if (expectIds.length === 0) {
        if (otherIds.length > 0) {
          // 文件里有小区，但全是错误的网络类型
          setError(
            (i18n.cellTypeMismatch || '当前规划类型为 {{type}}，只能导入 {{expect}} 小区清单，请检查文件')
              .replace('{{type}}', config.planningType)
              .replace('{{expect}}', expectLabel)
          )
        } else {
          setError(i18n.noCellIdsExtracted || '未能从文件中提取到小区ID，请检查文件格式')
        }
        return
      }

      // 2. 获取并刷新小区选择列表（匹配优先于上传）
      clearCellListCache()
      setCellListLoading(true)
      const data = await getCellList()
      setCellListData({ lte: data.lte || [], nr: data.nr || [] })
      setCellListLoading(false)

      // 3. 仅在期望网络类型的小区列表中匹配并自动勾选
      const availableIds = (expectNet === 'lte' ? data.lte || [] : data.nr || []).map(item => item.id)
      const matchedIds = matchCellIds(expectIds, availableIds)

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
    setConfig({
      planningType: 'LTE-LTE', maxNeighbors: 64,
      coverageDistanceFactor: 0.5, coverageRadiusFactor: 0.5,
      denseSpacingThreshold: 1.0, denseMultiplier: 1.3,
      outdoorToIndoorMaxDistance: 0.6, indoorToIndoorRadius: 0.35,
      indoorToOutdoorMultiplier: 1.5, outdoorSpacingSiteCount: 11,
    })
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
      const nameError = validateTaskName(taskName)
      if (nameError) { setTaskNameError(nameError); return }
      setTaskNameError(null); setWizardStep('params_set'); setError(null)
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
    // 校验选中小区的必要字段（经度/纬度/频点/基站ID/小区ID）
    const sourceSectors = config.planningType.split('-')[0] === 'LTE' ? cellListData.lte : cellListData.nr
    const missingCellsError = buildMissingCellsError(sourceSectors, selectedCellIdsSet, {
      labels: {
        siteId: i18n.sourceSiteId,
        cellId: i18n.sourceCellId,
        frequency: i18n.cellFreq,
        longitude: i18n.cellLng,
        latitude: i18n.cellLat
      },
      mainTemplate: t('neighbor.cellsMissingData') || '选中的小区中有 {{count}} 个缺少必要数据（经度/纬度/频点/基站ID/小区ID），请补充工参后再执行。缺失示例：{{examples}}',
      missingTemplate: t('neighbor.missingFieldsLabel') || '缺少：{{fields}}',
      lang: i18nInstance.language === 'en' ? 'en' : 'zh'
    })
    if (missingCellsError) {
      setError(missingCellsError)
      return
    }
    const validationError = validateNeighborConfig(config)
    if (validationError) { setError(validationError); return }
    setError(null); setLocalTaskResult(null); setLoading(true)
    setWizardStep('executing'); errorCountRef.current = 0
    try {
      const fullTaskName = generateFullTaskName(taskName)
      const response: ApiResponse<{ taskId: string; message: string }> = await neighborApi.plan({
        taskName: fullTaskName,
        planningType: config.planningType as 'LTE-LTE' | 'NR-NR' | 'NR-LTE',
        maxNeighbors: config.maxNeighbors,
        coverageDistanceFactor: config.coverageDistanceFactor,
        coverageRadiusFactor: config.coverageRadiusFactor,
        denseSpacingThreshold: config.denseSpacingThreshold ?? 1.0,
        denseMultiplier: config.denseMultiplier ?? 1.3,
        outdoorToIndoorMaxDistance: config.outdoorToIndoorMaxDistance ?? 0.6,
        indoorToIndoorRadius: config.indoorToIndoorRadius ?? 0.35,
        indoorToOutdoorMultiplier: config.indoorToOutdoorMultiplier ?? 1.5,
        outdoorSpacingSiteCount: config.outdoorSpacingSiteCount ?? 11,
        selectedCellIds: Array.from(selectedCellIdsSet)
      })
      if (response.success && response.data) {
        const newTaskId = response.data.taskId
        setActiveTaskId('neighbor_planning', newTaskId)
        setLocalTaskResult({ taskId: newTaskId, status: 'pending' as const, progress: 0, totalSites: 0, totalSectors: 0, totalNeighbors: 0, avgNeighbors: 0, startTime: new Date().toISOString() })
        startTask(newTaskId, 'neighbor_planning', i18n.startTaskMsg, fullTaskName, user?.username)
      } else {
        setError(response.message || i18n.startTaskFailed); setWizardStep('cells_selected')
      }
    } catch (err: any) {
      setError(err.message || i18n.startTaskFailed); setWizardStep('cells_selected')
    } finally { setLoading(false) }
  }

  // 从历史任务查看 - 先切到结果页，再按源小区分页加载
  const handleViewTask = (task: any) => {
    setActiveTaskId('neighbor_planning', task.id)
    setActiveLeftTab('planning-result')
    setShowMap(true)
    loadPagedResult(task.id, task.result)
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
    <div className="h-full flex flex-col p-4 min-h-0 relative">
      {/* 🔥 页面加载动画 */}
      {pageLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 z-50 rounded-xl">
          <div className="flex flex-col items-center gap-3">
            <Loader2 size={36} className="animate-spin text-primary" />
            <span className="text-sm text-muted-foreground">{i18n.loading || '加载中...'}</span>
          </div>
        </div>
      )}

      <h1 className="text-base font-bold mb-6 shrink-0">{i18n.title}</h1>

      {/* 错误提示 */}
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-3 text-red-400 shrink-0">
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
              {/* 历史任务操作：仅「历史任务」页签显示（邻区无可应用项，「应用」恒置灰） */}
              {activeLeftTab === 'history' && (
                <HistoryTabActions
                  selectedCount={selectedCount}
                  deleting={batchDeleting}
                />
              )}
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
                  {/* 每步仅渲染当前操作卡片，居中显示 */}
                  <div className="flex-1 min-h-0 overflow-y-auto flex justify-center px-4">
                  <div className="w-full max-w-3xl py-2 flex flex-col gap-4 min-h-0">
                    {/* 步骤1：任务名称卡片 */}
                    {(wizardStep === 'idle' || wizardStep === 'task_created') && (
                    <div className="bg-card border border-border rounded-xl p-6 w-full">
                      {nextTaskError && (
                        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-3 text-red-400">
                          <AlertCircle size={18} />
                          <span className="text-sm">{nextTaskError}</span>
                          <button onClick={() => setNextTaskError(null)} className="ml-auto text-sm underline">{i18n.close}</button>
                        </div>
                      )}
                      {/* 任务名称 */}
                      <div>
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
                    </div>
                    )}

                    {/* 步骤2：规划参数卡片 */}
                    {wizardStep === 'params_set' && (
                    <div className="bg-card border border-border rounded-xl p-6 w-full">
                      <h3 className="text-sm font-semibold mb-4">{i18n.planningParams}</h3>
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
                            <label className="block text-xs font-medium mb-0.5" title={i18n.maxNeighborsTooltip}>{i18n.maxNeighbors}</label>
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

                        {/* 高级门限参数（可选，默认值即推荐值） */}
                        <div className="border-t border-border pt-3 mt-1">
                          <p className="text-xs font-semibold text-muted-foreground mb-2">
                            {t('neighbor.advancedThresholds') || '高级门限（默认值即推荐值，一般无需修改）'}
                          </p>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                            <div>
                              <label className="block text-xs font-medium mb-0.5" title={t('neighbor.denseThresholdTooltip') || '平均站间距小于该值按密集场景（全量添加），单位公里'}>
                                {t('neighbor.denseSpacingThreshold') || '密集/稀疏门限(km)'}
                              </label>
                              <NumberInput
                                value={config.denseSpacingThreshold ?? 1.0}
                                onChange={(v) => setConfig({ denseSpacingThreshold: v })}
                                disabled={wizardStep !== 'params_set'}
                                min={0.1} max={10}
                                className="w-full"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium mb-0.5" title={t('neighbor.denseMultiplierTooltip') || '密集场景按该倍数×站间距范围内全量添加'}>
                                {t('neighbor.denseMultiplier') || '密集全量倍数'}
                              </label>
                              <NumberInput
                                value={config.denseMultiplier ?? 1.3}
                                onChange={(v) => setConfig({ denseMultiplier: v })}
                                disabled={wizardStep !== 'params_set'}
                                min={1.0} max={5}
                                className="w-full"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium mb-0.5" title={t('neighbor.outdoorToIndoorMaxTooltip') || '室外→室分最大添加距离，单位公里（且需在天线前向）'}>
                                {t('neighbor.outdoorToIndoorMax') || '室外→室分最远距离(km)'}
                              </label>
                              <NumberInput
                                value={config.outdoorToIndoorMaxDistance ?? 0.6}
                                onChange={(v) => setConfig({ outdoorToIndoorMaxDistance: v })}
                                disabled={wizardStep !== 'params_set'}
                                min={0.1} max={3}
                                className="w-full"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium mb-0.5" title={t('neighbor.indoorToIndoorRadiusTooltip') || '室分→室分最大添加距离，单位公里'}>
                                {t('neighbor.indoorToIndoorRadius') || '室分→室分距离(km)'}
                              </label>
                              <NumberInput
                                value={config.indoorToIndoorRadius ?? 0.35}
                                onChange={(v) => setConfig({ indoorToIndoorRadius: v })}
                                disabled={wizardStep !== 'params_set'}
                                min={0.05} max={2}
                                className="w-full"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium mb-0.5" title={t('neighbor.indoorToOutdoorMultiplierTooltip') || '室分→室外按该倍数×站间距范围内全量添加'}>
                                {t('neighbor.indoorToOutdoorMultiplier') || '室分→室外倍数'}
                              </label>
                              <NumberInput
                                value={config.indoorToOutdoorMultiplier ?? 1.5}
                                onChange={(v) => setConfig({ indoorToOutdoorMultiplier: v })}
                                disabled={wizardStep !== 'params_set'}
                                min={1.0} max={5}
                                className="w-full"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium mb-0.5" title={t('neighbor.spacingSiteCountTooltip') || '室外源计算平均站间距时取最近N个室外站点'}>
                                {t('neighbor.outdoorSpacingSiteCount') || '室外站间距站点数'}
                              </label>
                              <NumberInput
                                value={config.outdoorSpacingSiteCount ?? 11}
                                onChange={(v) => setConfig({ outdoorSpacingSiteCount: Math.round(v) })}
                                disabled={wizardStep !== 'params_set'}
                                min={1} max={30}
                                className="w-full"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    )}

                    {/* 步骤3：小区选择卡片（含执行中/完成前展示） */}
                    {(wizardStep === 'cells_selected' || wizardStep === 'executing' || wizardStep === 'completed') && (
                    <div className="bg-card border border-border rounded-xl p-6 w-full h-[70vh] min-h-[420px] flex flex-col">
                      <h3 className="text-sm font-semibold mb-4 shrink-0">{t('pci.cellSelection') || '小区选择'}</h3>
                      <input type="file" ref={cellFileInputRef} onChange={handleCellFileChange} accept=".xlsx,.xls" className="hidden" />
                      <div className="flex-1 min-h-0 flex flex-col">
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
                        columnLabels={{ siteId: i18n.sourceSiteId, cellId: i18n.sourceCellId, cellName: i18n.sourceCellName, cellFreq: i18n.cellFreq, cellPci: i18n.cellPci, cellLng: i18n.cellLng, cellLat: i18n.cellLat, selectAll: i18n.selectAll, clearSelections: i18n.clearSelections, uploadCellFile: i18n.uploadCellFile, downloadCellTemplate: i18n.downloadCellTemplate }}
                      />
                      </div>
                    </div>
                    )}
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
                    wizardStep === 'idle' ? taskName.trim().length > 0
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
                        setLocalTaskResult({ ...result, taskId: task.id })
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
                    onSelectedChange={(counts) => setSelectedCount(counts.total)}
                    onBatchStatusChange={(_applying, deleting) => setBatchDeleting(deleting)}
                  />
                </div>
              )}

              {activeLeftTab === 'planning-result' && (
                <>
                {resultLoading ? (
                  <LoadingSpinner variant="spinner" text={i18n.loadingResult || '正在加载规划结果...'} />
                ) : (

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
                  ) : taskResult.status === 'completed' ? (
                    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                      {pagedPreparing ? (
                        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
                          <Loader2 className="animate-spin" size={40} />
                          <p className="text-sm">
                            {t('neighbor.preparingResult') || '正在准备结果明细（首次查看大结果约需数秒）...'}
                          </p>
                          <button
                            onClick={() => loadFullResultForTask(taskResult.taskId || taskId!)}
                            disabled={loadingFullResult}
                            className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg bg-muted hover:bg-muted/80 transition-colors text-xs font-medium disabled:opacity-50"
                          >
                            <Download size={14} />
                            {t('neighbor.loadFullResult') || '直接加载完整结果'}
                          </button>
                        </div>
                      ) : pagedLoading && filteredResults.length === 0 ? (
                        <div className="flex-1 flex items-center justify-center text-muted-foreground">
                          <Loader2 className="animate-spin mx-auto mb-4" size={40} />
                          <p className="text-sm">{i18n.loadingResult || '正在加载规划结果...'}</p>
                        </div>
                      ) : hasPagedSources || filteredResults.length > 0 || (taskResult as any).results ? (
                        <>
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
                          {!(taskResult as any).results && pagedSourceTotal > 0 && (
                            <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-card shrink-0">
                              <span className="text-xs text-muted-foreground">
                                {t('neighbor.sourcePageInfo', {
                                  total: pagedSourceTotal,
                                  page: pagedSourcePage,
                                  pages: Math.max(1, Math.ceil(pagedSourceTotal / NEIGHBOR_SOURCE_PAGE_SIZE)),
                                }) || `共 ${pagedSourceTotal} 个源小区 · 第 ${pagedSourcePage} / ${Math.max(1, Math.ceil(pagedSourceTotal / NEIGHBOR_SOURCE_PAGE_SIZE))} 页`}
                              </span>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => goToPagedSourcePage(pagedSourcePage - 1)}
                                  disabled={pagedSourcePage <= 1 || pagedLoading}
                                  className="px-2.5 py-1 text-xs rounded-md border border-border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
                                >
                                  {t('common.prevPage') || '上一页'}
                                </button>
                                <button
                                  onClick={() => goToPagedSourcePage(pagedSourcePage + 1)}
                                  disabled={pagedSourcePage >= Math.ceil(pagedSourceTotal / NEIGHBOR_SOURCE_PAGE_SIZE) || pagedLoading}
                                  className="px-2.5 py-1 text-xs rounded-md border border-border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
                                >
                                  {t('common.nextPage') || '下一页'}
                                </button>
                              </div>
                            </div>
                          )}
                        </>
                      ) : resultLoading ? (
                        <div className="flex-1 flex items-center justify-center text-muted-foreground">
                          <Loader2 className="animate-spin mx-auto mb-4" size={40} />
                          <p className="text-sm">{i18n.loadingResult || '正在加载规划结果...'}</p>
                        </div>
                      ) : (
                        <div className="flex-1 flex items-center justify-center text-muted-foreground">
                          <AlertCircle size={48} className="mx-auto mb-4 opacity-50" />
                          <p>{t('common.resultUnavailable') || '结果数据不可用，请重新执行规划任务'}</p>
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
            </>
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
              <div className="mb-2 p-2 bg-blue-500/10 border border-blue-500/30 rounded-lg text-xs text-blue-600 flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Search size={14} />
                  {i18n.searchMarkerCount.replace('{{count}}', String(searchMarkers.length))}
                </span>
                <button
                  onClick={handleClearMarkers}
                  className="text-blue-600 hover:text-blue-500 font-medium"
                >
                  {i18n.clearAll}
                </button>
              </div>
            )}

            {/* 搜索错误提示 */}
            {searchError && (
              <div className="mb-2 p-2 bg-orange-500/10 border border-orange-500/20 rounded-lg text-xs text-orange-400 flex items-center gap-2">
                <AlertCircle size={14} />
                <span className="flex-1">{searchError}</span>
                <button
                  onClick={() => setSearchError(null)}
                  className="text-orange-400 hover:text-orange-300"
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

  // 分组行偏移表：只在结果变化时算一次，滚动时二分定位，
  // 避免每次滚动都遍历/重建 70 万行扁平数组（历史卡顿主因之一）。
  const groupOffsets = useMemo(() => {
    const offsets = new Array<number>(groupedData.length + 1)
    let total = 0
    groupedData.forEach((group, index) => {
      offsets[index] = total
      total += group.targets.length
    })
    offsets[groupedData.length] = total
    return offsets
  }, [groupedData])

  // 计算虚拟滚动的可见数据
  const virtualData = useMemo(() => {
    const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_COUNT)
    const totalRows = groupOffsets[groupOffsets.length - 1] || 0
    const endIndex = Math.min(
      totalRows,
      Math.ceil((scrollTop + VISIBLE_COUNT * ITEM_HEIGHT) / ITEM_HEIGHT) + BUFFER_COUNT
    )

    // 二分找到起始行所属分组，只展开可视范围内的行
    let low = 0
    let high = Math.max(0, groupOffsets.length - 2)
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (groupOffsets[mid] <= startIndex) low = mid
      else high = mid - 1
    }

    const visibleData: any[] = []
    for (let groupIndex = low; groupIndex < groupedData.length; groupIndex++) {
      const groupStart = groupOffsets[groupIndex]
      if (groupStart >= endIndex) break
      const group = groupedData[groupIndex]
      const from = Math.max(0, startIndex - groupStart)
      const to = Math.min(group.targets.length, endIndex - groupStart)
      for (let targetIdx = from; targetIdx < to; targetIdx++) {
        visibleData.push({
          ...group.targets[targetIdx],
          group,
          targetIdx,
          isFirstInGroup: targetIdx === 0
        })
      }
    }

    return {
      startIndex,
      endIndex,
      visibleData,
      totalHeight: totalRows * ITEM_HEIGHT,
      offsetY: startIndex * ITEM_HEIGHT
    }
  }, [scrollTop, groupedData, groupOffsets])

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
                    className="mt-1 w-full p-1 border border-border rounded text-[10px] text-foreground bg-input placeholder:text-muted-foreground"
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
                              group.relationType === 'LTE-LTE' ? 'bg-blue-500/15 text-blue-400' :
                              group.relationType === 'NR-NR' ? 'bg-purple-500/15 text-purple-400' :
                                'bg-green-500/15 text-green-400'
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
