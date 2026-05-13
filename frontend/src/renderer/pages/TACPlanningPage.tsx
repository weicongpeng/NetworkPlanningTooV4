import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Play, Download, Loader2, AlertCircle, CheckCircle2, FileSpreadsheet, Search, GripVertical, Check, List } from 'lucide-react'
import { tacPlanningApi, dataApi } from '../services/api'
import { useTACPlanningStore } from '../store/tacPlanningStore'
import type { RenderSectorData, CellListItem } from '../services/mapDataService'
import { getCellList } from '../services/mapDataService'
import { useTranslation } from 'react-i18next'
import { CellSelectionTable } from '../components/CellSelectionTable'

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

export function TACPlanningPage() {
    const { t } = useTranslation()
    const { taskId, config, result, setTaskId, setConfig, setResult, clearTAC } = useTACPlanningStore()
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const taskResult = result as TACResultData | null

    // 左列页签状态：'cell-selection' | 'planning-result'
    const [activeLeftTab, setActiveLeftTab] = useState<'cell-selection' | 'planning-result'>('planning-result')
    // 选中的小区ID集合（格式：sector.id，如 siteId_sectorId）
    const [selectedCellIds, setSelectedCellIds] = useState<Set<string>>(new Set())
    // 小区列表数据（从轻量API获取）
    const [cellListData, setCellListData] = useState<{ lte: CellListItem[]; nr: CellListItem[] }>({ lte: [], nr: [] })
    const [cellListLoading, setCellListLoading] = useState(false)

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

    const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
    const errorCountRef = useRef(0)

    // 轮询任务进度
    useEffect(() => {
        const clearPolling = () => {
            if (pollingIntervalRef.current) {
                clearInterval(pollingIntervalRef.current)
                pollingIntervalRef.current = null
            }
        }

        if (!taskId || taskResult?.status === 'completed' || taskResult?.status === 'failed') {
            clearPolling()
            return
        }

        pollingIntervalRef.current = setInterval(async () => {
            try {
                const response = await tacPlanningApi.getProgress(taskId)
                if (response.success && response.data) {
                    setResult({
                        ...response.data,
                        exportPath: taskResult?.exportPath
                    })

                    if (response.data.status === 'completed' || response.data.status === 'failed') {
                        clearPolling()
                    }
                }
            } catch (err: any) {
                errorCountRef.current++
                console.error('轮询TAC规划进度失败:', err)

                if (err.code === 404 || err.message?.includes('任务不存在')) {
                    clearPolling()
                    clearTAC()
                    setError(null)
                    return
                }

                if (errorCountRef.current >= MAX_ERRORS) {
                    clearPolling()
                    setError(t('tacPlanning.getProgressFailed') || '获取任务进度失败，请刷新页面重试')
                }
            }
        }, 2000)

        return clearPolling
    }, [taskId, taskResult?.status])

    const handleStartPlanning = async () => {
        if (!config?.networkType) {
            setError(t('tacPlanning.selectNetworkType') || '请选择网络类型')
            return
        }

        setLoading(true)
        setError(null)
        setResult(null)
        clearTAC()
        errorCountRef.current = 0

        const has_selected_cells = selectedCellIds.size > 0

        try {
            // 先检查数据文件是否存在
            try {
                const listResponse = await dataApi.list(1, 100, true)
                if (listResponse.success && listResponse.data) {
                    const dataItems = listResponse.data
                    const networkType = config.networkType

                    // 当有选中小区时，跳过待规划小区文件检查
                    if (!has_selected_cells) {
                        const targetCellsFile = dataItems.find(item =>
                            item.type === 'excel' &&
                            item.name.toLowerCase().startsWith('cell-tree-export')
                        )
                        if (!targetCellsFile) {
                            setError(
                                (t('tacPlanning.missingDataFiles') || '请先导入以下数据文件：') +
                                '\n' + (t('tacPlanning.targetCellsFile') || '待规划小区(cell-tree-export)')
                            )
                            setLoading(false)
                            return
                        }
                    }

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
                        return
                    }

                    // 检查TAC图层文件
                    const tacFileName = networkType === 'LTE' ? '4G_TAC.TAB' : '5G_TAC.TAB'
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
                        return
                    }
                }
            } catch (listErr) {
                console.warn('检查数据文件列表失败，将继续尝试规划:', listErr)
            }

            const planConfig = {
                ...config!,
                selectedCellIds: has_selected_cells ? Array.from(selectedCellIds) : undefined
            }
            const response = await tacPlanningApi.plan(planConfig)
            if (response.success && response.data) {
                const newTaskId = response.data.taskId
                setTaskId(newTaskId)

                const progressResponse = await tacPlanningApi.getProgress(newTaskId)
                if (progressResponse.success && progressResponse.data) {
                    setResult(progressResponse.data)
                }
            } else {
                setError(response.message || (t('tacPlanning.startFailed') || '启动TAC规划任务失败'))
            }
        } catch (err: any) {
            setError(err.message || (t('tacPlanning.startFailed') || '启动TAC规划任务失败'))
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

    return (
        <div className="h-full flex flex-col p-4 min-h-0">
            <h1 className="text-xl font-bold mb-4 shrink-0">{t('tacPlanning.title') || 'TAC规划'}</h1>

            <div className="bg-card p-3 rounded-lg border border-border mb-3 shrink-0">
                <div className="space-y-3">
                    <div>
                        <label className="block text-sm font-semibold mb-1.5">{t('tacPlanning.networkType') || '网络类型'}</label>
                        <div className="flex gap-3">
                            <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                    type="radio"
                                    name="networkType"
                                    value="LTE"
                                    checked={config?.networkType === 'LTE'}
                                    onChange={(e) => {
                                        setSelectedCellIds(new Set())
                                        setConfig({ networkType: e.target.value as 'LTE' | 'NR' })
                                        loadCellList()
                                    }}
                                    disabled={loading || taskResult?.status === 'processing'}
                                    className="w-3.5 h-3.5 text-primary"
                                />
                                <span className="text-xs">4G LTE</span>
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                    type="radio"
                                    name="networkType"
                                    value="NR"
                                    checked={config?.networkType === 'NR'}
                                    onChange={(e) => {
                                        setSelectedCellIds(new Set())
                                        setConfig({ networkType: e.target.value as 'LTE' | 'NR' })
                                        loadCellList()
                                    }}
                                    disabled={loading || taskResult?.status === 'processing'}
                                    className="w-3.5 h-3.5 text-primary"
                                />
                                <span className="text-xs">5G NR</span>
                            </label>
                        </div>
                    </div>

                    <div className="flex items-start gap-3">
                        <div className="w-1/2 p-2.5 bg-muted/50 rounded-lg text-xs text-muted-foreground">
                            <ul className="space-y-1.5">
                                <li className="flex items-start gap-1.5">
                                    <span className="bg-primary/20 text-primary rounded-full w-4 h-4 flex items-center justify-center text-[10px] mt-0.5 shrink-0">1</span>
                                    <span><b>{t('tacPlanning.planningCell') || '待规划小区'}</b>：{t('tacPlanning.planningCellTip') || '导入 cell-tree-export 格式的 Excel 文件，系统将通过小区 ID 自动关联全量工参获取坐标。'}</span>
                                </li>
                                <li className="flex items-start gap-1.5">
                                    <span className="bg-primary/20 text-primary rounded-full w-4 h-4 flex items-center justify-center text-[10px] mt-0.5 shrink-0">2</span>
                                    <span><b>{t('tacPlanning.fullParams') || '全量工参'}</b>：{t('tacPlanning.fullParamsTip') || '在首页数据管理中导入对应的 4G 或 5G 全量工参，用于提供待规划小区的经纬度信息。'}</span>
                                </li>
                                <li className="flex items-start gap-1.5">
                                    <span className="bg-primary/20 text-primary rounded-full w-4 h-4 flex items-center justify-center text-[10px] mt-0.5 shrink-0">3</span>
                                    <span><b>{t('tacPlanning.tacLayer') || 'TAC图层'}</b>：{t('tacPlanning.tacLayerTip') || '在数据管理导入 4G 或 5G TAC 图层，图层格式为 zip 压缩包（包含 .tab 或 .shp 等 MapInfo 格式数据）。'}</span>
                                </li>
                                <li className="flex items-start gap-1.5">
                                    <FileSpreadsheet size={14} className="flex-shrink-0 mt-0.5" />
                                    <p>{t('tacPlanning.remark') || '备注：此为数据驱动规划，用于新站点/新增小区的TAC分配。'}</p>
                                </li>
                            </ul>
                        </div>

                        <button
                            onClick={handleStartPlanning}
                            disabled={loading || taskResult?.status === 'processing'}
                            className="px-4 py-2 bg-blue-400 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 text-sm font-medium ml-auto"
                        >
                            {loading || taskResult?.status === 'processing' ? (
                                <>
                                    <Loader2 className="animate-spin" size={16} />
                                    <span>{t('tacPlanning.planning') || '规划进行中...'}</span>
                                </>
                            ) : (
                                <>
                                    <Play size={16} />
                                    <span>{t('tacPlanning.startPlan') || '开始TAC规划'}</span>
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>

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
                        {t('tacPlanning.result') || '规划结果'}
                        {taskResult?.status === 'completed' && (
                            <span className="ml-2 px-1.5 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">✓</span>
                        )}
                        {taskResult?.status === 'failed' && (
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
                                    const networkType = (config?.networkType || 'LTE') as 'LTE' | 'NR'
                                    return networkType === 'LTE' ? cellListData.lte : cellListData.nr
                                })()}
                                selectedCellIds={selectedCellIds}
                                onToggleCell={toggleCellSelection}
                                onSelectAll={toggleSelectAll}
                                onClearSelections={clearSelections}
                                selectedCountText={'已选中 {{count}} 个小区'.replace('{{count}}', String(selectedCellIds.size))}
                                dataSourceText={'数据源：{{type}} 小区'.replace('{{type}}', config?.networkType || 'LTE')}
                                loading={cellListLoading}
                            />
                        </div>
                    ) : (
                        /* 规划结果面板 */
                        <div className="flex flex-col h-full min-h-0 overflow-hidden">
                            {taskResult ? (
                                <>
                                    {/* 标题行 + 统计卡片 + 进度条 */}
                                    <div className="mb-3 shrink-0">
                                        <div className="flex items-center gap-4 mb-3 flex-wrap">
                                            <div className="flex items-center gap-2">
                                                {taskResult.status === 'completed' ? (
                                                    <CheckCircle2 size={18} className="text-green-500" />
                                                ) : taskResult.status === 'failed' ? (
                                                    <AlertCircle size={18} className="text-red-500" />
                                                ) : (
                                                    <Loader2 size={18} className="animate-spin text-primary" />
                                                )}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <div className="flex items-center gap-1 px-2 py-1.5 bg-muted/50 rounded-lg">
                                                    <span className="text-[10px] text-muted-foreground">{t('tacPlanning.total') || '总'}</span>
                                                    <span className="text-sm font-bold">{taskResult.totalCells || 0}</span>
                                                </div>
                                                <div className="flex items-center gap-1 px-2 py-1.5 bg-green-500/10 border border-green-500/20 rounded-lg">
                                                    <span className="text-[10px] text-green-600">{t('tacPlanning.success') || '成功'}</span>
                                                    <span className="text-sm font-bold text-green-500">{taskResult.matchedCells || 0}</span>
                                                </div>
                                                <div className="flex items-center gap-1 px-2 py-1.5 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                                                    <span className="text-[10px] text-blue-600">{t('tacPlanning.matchRate') || '匹配率'}</span>
                                                    <span className="text-sm font-bold text-blue-500">
                                                        {taskResult.totalCells > 0 ? ((taskResult.matchedCells / taskResult.totalCells) * 100).toFixed(1) : 0}%
                                                    </span>
                                                </div>
                                            </div>
                                            {taskResult.status === 'completed' && taskResult.results && (
                                                <button
                                                    onClick={() => setSearchEnabled(!searchEnabled)}
                                                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg transition-colors text-xs ${
                                                        searchEnabled
                                                            ? 'bg-blue-400 text-white hover:bg-blue-500'
                                                            : 'bg-muted hover:bg-muted/80'
                                                    }`}
                                                >
                                                    <Search size={12} />
                                                    {t('tacPlanning.search') || '搜索'}
                                                </button>
                                            )}
                                            {taskResult.status === 'completed' && (
                                                <button
                                                    onClick={() => handleExport('xlsx')}
                                                    className="flex items-center gap-1.5 px-4 py-2 bg-blue-400 text-white rounded-lg hover:bg-blue-500 text-sm font-medium ml-auto"
                                                >
                                                    <Download size={16} />
                                                    <span>{t('tacPlanning.export') || '导出结果'}</span>
                                                </button>
                                            )}
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
                                                                            className="mt-1 w-full p-1 border border-border rounded text-[10px] bg-white dark:bg-slate-800"
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
                                    <p>配置参数后点击「开始TAC规划」查看结果</p>
                                    <p className="text-xs mt-2">需要先导入「全量工参」、「待规划小区」和「TAC图层」文件</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
