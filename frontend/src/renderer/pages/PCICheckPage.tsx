import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { pciCheckApi } from '../services/api'
import { usePCICheckStore } from '../store/pciCheckStore'
import { useTaskStore, type Task } from '../store/taskStore'
import { useAuthStore } from '../store/authStore'
import { btn } from '../utils/buttonStyles'
import { HistoryTable } from '../components/HistoryTable'
import { HistoryTabActions } from '../components/HistoryTabActions'
import { SkippedCellsNotice } from '../components/SkippedCellsNotice'
import { PCICheckWizard } from '../components/PCI/PCICheckWizard'
import { PCICheckResultPanel, totalRowCount, type PCICheckResultData } from '../components/PCI/PCICheckResultPanel'
import { CHECK_TYPES, type CheckTypeKey } from '../components/PCI/PCICheckResultTable'
import { generateFullTaskName } from '../utils/taskNameUtils'
import { usePCICheckCells } from '../hooks/usePCICheckCells'

/** 本地时间戳 yyyyMMddHHmmss（导出文件名用） */
const localTimestamp = (): string => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export function PCICheckPage() {
  const { t } = useTranslation()
  const user = useAuthStore((s) => s.user)
  const {
    wizardStep, setWizardStep, config, setConfig,
    activeLeftTab, setActiveLeftTab,
    taskName, setTaskName, resetConfig: storeResetConfig
  } = usePCICheckStore()

  const {
    activeTaskIds, setActiveTaskId, getLatestPCICheckTask, startTask,
    syncHistoryFromBackend, startGlobalPolling, isGlobalPollingActive
  } = useTaskStore()
  const pciCheckHistoryCount = useTaskStore(s => s.historyCounts.pci_check)
  const activeStoreTask = useTaskStore((s: any) => (s.activeTaskIds.pci_check ? s.tasks[s.activeTaskIds.pci_check] : null))

  const [taskNameError, setTaskNameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [resultLoading, setResultLoading] = useState(false)
  const [localTaskResult, setLocalTaskResult] = useState<PCICheckResultData | null>(null)
  const [selectedCount, setSelectedCount] = useState(0)
  const [activeCategory, setActiveCategory] = useState<CheckTypeKey>(CHECK_TYPES[0].key)
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'success'>('idle')
  const viewedTaskIdRef = useRef<string | null>(null)
  const isLoadingResultRef = useRef(false)
  const exportTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // 小区列表加载、勾选与待核查文件导入
  const cells = usePCICheckCells(setError)

  const latestTask = getLatestPCICheckTask()
  const taskId = activeTaskIds.pci_check
  const taskResult = localTaskResult || (latestTask?.result as PCICheckResultData | null)

  useEffect(() => { syncHistoryFromBackend('pci_check').catch(() => {}) }, [syncHistoryFromBackend])

  // 挂载时恢复最近一次核查结果（与 TAC核查一致）
  useEffect(() => {
    if (viewedTaskIdRef.current && latestTask && viewedTaskIdRef.current !== latestTask.id) return
    if (latestTask?.result?.results) setLocalTaskResult(latestTask.result as PCICheckResultData)
  }, [latestTask])

  useEffect(() => () => { if (exportTimerRef.current) clearTimeout(exportTimerRef.current) }, [])

  // 结果页自动加载最新任务（历史列表只有摘要时按需取完整结果）
  useEffect(() => {
    if (activeLeftTab !== 'planning-result') {
      viewedTaskIdRef.current = null
      return
    }
    if (viewedTaskIdRef.current) return
    isLoadingResultRef.current = true
    if (!taskResult) setResultLoading(true)

    const loadLatest = async () => {
      await syncHistoryFromBackend('pci_check')
      if (!isLoadingResultRef.current) return
      const latest = getLatestPCICheckTask()
      if (!latest?.result) return
      if (!latest.result.results) {
        try {
          const response = await pciCheckApi.getResult(latest.id)
          if (isLoadingResultRef.current && response?.success && response?.data?.results) {
            setLocalTaskResult(response.data as PCICheckResultData)
            setWizardStep('completed')
            return
          }
        } catch (err: any) {
          console.warn('[PCICheckPage] 获取完整核查结果失败，使用缓存摘要:', err?.message)
        }
      }
      if (!isLoadingResultRef.current) return
      setLocalTaskResult(latest.result as PCICheckResultData)
      setWizardStep('completed')
    }
    loadLatest().finally(() => {
      if (isLoadingResultRef.current) setResultLoading(false)
    })
    return () => { isLoadingResultRef.current = false; setResultLoading(false) }
  }, [activeLeftTab])

  // 轮询/跨页面切回时同步任务状态
  useEffect(() => {
    if (!taskId || !activeStoreTask || viewedTaskIdRef.current === taskId) return
    const status = activeStoreTask.status
    const progress = activeStoreTask.progress ?? 0

    if (status === 'completed' && activeStoreTask.result) {
      setLocalTaskResult(activeStoreTask.result as PCICheckResultData)
    } else if (status === 'failed') {
      setLocalTaskResult(prev => (
        prev?.taskId === taskId && (prev.status === 'failed' || prev.status === 'completed')
          ? prev
          : {
            taskId, status: 'failed', progress, startTime: new Date(activeStoreTask.startTime || Date.now()).toISOString(),
            results: {}, summary: {}
          }
      ))
    } else if (status === 'running' || status === 'processing' || status === 'pending') {
      setWizardStep('executing')
      setLocalTaskResult(prev => (
        prev?.taskId === taskId && prev.status === 'processing' && prev.progress === progress
          ? prev
          : prev?.taskId === taskId && prev.status === 'completed'
            ? prev
            : {
              taskId, status: 'processing', progress, startTime: new Date(activeStoreTask.startTime || Date.now()).toISOString(),
              results: {}, summary: {}
            }
      ))
      if (!isGlobalPollingActive('pci_check')) startGlobalPolling('pci_check')
    }
  }, [taskId, activeStoreTask, setWizardStep, isGlobalPollingActive, startGlobalPolling])

  // 执行完成后自动进入结果页
  useEffect(() => {
    if (wizardStep !== 'executing') return
    if (localTaskResult?.status === 'completed') { setWizardStep('completed'); setError(null) }
    else if (localTaskResult?.status === 'failed') setWizardStep('cells_selected')
  }, [localTaskResult?.status, wizardStep])

  const resetConfig = useCallback(() => {
    storeResetConfig()
    cells.clearSelections()
    setTaskNameError(null)
    setActiveTaskId('pci_check', null)
    setLocalTaskResult(null)
    setError(null)
  }, [storeResetConfig, setActiveTaskId])

  // 「新建任务」页签只在用户主动切入时重置向导：挂载时首次触发不清状态，
  // 否则从别的页面切回来会清掉活跃任务 ID，执行进度画面就丢了
  const previousTabRef = useRef<typeof activeLeftTab | null>(null)
  useEffect(() => {
    const previousTab = previousTabRef.current
    previousTabRef.current = activeLeftTab
    if (previousTab === null || previousTab === activeLeftTab) return
    if (activeLeftTab !== 'task-config') return
    if (taskResult?.status === 'processing') return
    resetConfig()
  }, [activeLeftTab, taskResult?.status, resetConfig])

  const getCellCount = useCallback((task: Task): number | string => {
    if (task.result?.cellCount != null) return task.result.cellCount
    const total = totalRowCount(task.result as PCICheckResultData)
    if (total) return total
    return task.result?.totalCells ?? '-'
  }, [])

  // === 向导 ===
  const validateTaskName = (name: string): string | null => {
    if (!name.trim()) return t('pciCheck.taskNameRequired') || '请输入任务名称'
    if (name.length > 25) return t('pciCheck.taskNameTooLong') || '任务名称不能超过25个字符'
    return null
  }

  const validateParams = (): string | null => {
    if (!(config.macroPairDistance >= 10) || config.macroPairDistance > 5000) {
      return t('pciCheck.invalidMacroPairDistance') || '宏站到宏站对打距离需在10~5000米之间'
    }
    if (!(config.mixedPairDistance >= 10) || config.mixedPairDistance > 5000) {
      return t('pciCheck.invalidMixedPairDistance') || '宏站到室分对打距离需在10~5000米之间'
    }
    if (!(config.indoorPairDistance >= 10) || config.indoorPairDistance > 5000) {
      return t('pciCheck.invalidIndoorPairDistance') || '室分到室分对打距离需在10~5000米之间'
    }
    if (!(config.minReuseDistanceMacro >= 100) || config.minReuseDistanceMacro > 50000) {
      return t('pciCheck.invalidMacroReuse') || '宏站PCI最小复用距离需在100~50000米之间'
    }
    if (!(config.minReuseDistanceIndoor >= 100) || config.minReuseDistanceIndoor > 50000) {
      return t('pciCheck.invalidIndoorReuse') || '室分PCI最小复用距离需在100~50000米之间'
    }
    if (!(config.macroFacingAngle >= 10) || config.macroFacingAngle > 180) {
      return t('pciCheck.invalidMacroAngle') || '宏站对打夹角门限需在10~180度之间'
    }
    if (!(config.indoorFacingAngle >= 10) || config.indoorFacingAngle > 180) {
      return t('pciCheck.invalidIndoorAngle') || '室分对打夹角门限需在10~180度之间'
    }
    return null
  }

  const handleCancel = () => {
    setWizardStep('idle'); setTaskName(''); setTaskNameError(null); setError(null)
    cells.clearSelections()
    storeResetConfig()
  }

  const handleBack = useCallback(() => {
    if (wizardStep === 'task_created' || wizardStep === 'params_set') {
      setWizardStep('task_created'); setTaskNameError(null); setError(null)
    } else if (wizardStep === 'cells_selected') {
      setWizardStep('params_set'); setError(null)
    }
  }, [wizardStep])

  const handleNext = useCallback(() => {
    if (wizardStep === 'idle' || wizardStep === 'task_created') {
      const nameError = validateTaskName(taskName)
      if (nameError) { setTaskNameError(nameError); return }
      setTaskNameError(null); setWizardStep('params_set'); setError(null)
    } else if (wizardStep === 'params_set') {
      const paramError = validateParams()
      if (paramError) { setError(paramError); return }
      setWizardStep('cells_selected'); cells.clearSelections(); setError(null)
    } else if (wizardStep === 'cells_selected') {
      if (cells.selectedCellIds.size === 0) {
        setError(t('pciCheck.noCellsSelected') || '请在小区选择列表中至少选择一个小区后再执行PCI核查')
        return
      }
      handleExecute()
    } else if (wizardStep === 'completed') {
      setActiveLeftTab('planning-result')
    }
  }, [wizardStep, taskName, config, cells.selectedCellIds, t])

  const handleExecute = async () => {
    const paramError = validateParams()
    if (paramError) { setError(paramError); return }
    if (cells.selectedCellIds.size === 0) {
      setError(t('pciCheck.noCellsSelected') || '请在小区选择列表中至少选择一个小区后再执行PCI核查')
      return
    }
    setLoading(true); setError(null); setLocalTaskResult(null)
    setActiveTaskId('pci_check', null); setWizardStep('executing')
    try {
      const fullTaskName = generateFullTaskName(taskName)
      const response = await pciCheckApi.plan({
        taskName: fullTaskName,
        networkType: config.networkType,
        macroPairDistance: config.macroPairDistance,
        mixedPairDistance: config.mixedPairDistance,
        indoorPairDistance: config.indoorPairDistance,
        minReuseDistanceMacro: config.minReuseDistanceMacro,
        minReuseDistanceIndoor: config.minReuseDistanceIndoor,
        macroFacingAngle: config.macroFacingAngle,
        indoorFacingAngle: config.indoorFacingAngle,
        reuseCheck: config.reuseCheck,
        collisionCheck: config.collisionCheck,
        confusionCheck: config.confusionCheck,
        mod3Check: config.mod3Check,
        mod30Check: config.networkType === 'NR' ? config.mod30Check : true,
        neighborAssoc: config.neighborAssoc,
        selectedCellIds: Array.from(cells.selectedCellIds),
      })
      if (response.success && response.data) {
        const newTaskId = response.data.taskId
        viewedTaskIdRef.current = null
        setActiveTaskId('pci_check', newTaskId)
        startTask(newTaskId, 'pci_check', 'PCI核查开始', fullTaskName, user?.username)
        const progressResponse = await pciCheckApi.getProgress(newTaskId)
        if (progressResponse.success && progressResponse.data) {
          setLocalTaskResult(progressResponse.data as PCICheckResultData)
        }
      } else {
        setError(response.message || (t('pciCheck.startFailed') || '启动PCI核查任务失败'))
        setWizardStep('cells_selected')
      }
    } catch (err: any) {
      console.error('启动PCI核查失败:', err)
      setError(err.message || (t('pciCheck.startFailed') || '启动PCI核查任务失败'))
      setWizardStep('cells_selected')
    } finally {
      setLoading(false)
    }
  }

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    setTimeout(() => {
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
    }, 100)
  }

  const runExport = async (format: 'xlsx' | 'csv', checkType?: string) => {
    if (!taskId || exportState !== 'idle') return
    setExportState('exporting')
    try {
      const blob = await pciCheckApi.export(taskId, format, checkType)
      const networkType = taskResult?.networkType || config.networkType
      const category = CHECK_TYPES.find(item => item.key === checkType)
      const categoryLabel = category ? (t(`pciCheck.types.${category.key}`) || category.label) : ''
      const filename = format === 'csv'
        ? `PCI核查_${categoryLabel}_${networkType}_${localTimestamp()}.csv`
        : `PCI核查结果_${networkType}_${localTimestamp()}.xlsx`
      downloadBlob(blob, filename)
      setExportState('success')
      if (exportTimerRef.current) clearTimeout(exportTimerRef.current)
      exportTimerRef.current = setTimeout(() => setExportState('idle'), 2000)
    } catch (err: any) {
      console.error('导出PCI核查结果失败:', err)
      setExportState('idle')
      setError((t('pciCheck.exportFailed') || '导出失败: ') + (err.message || t('pciCheck.unknownError') || '未知错误'))
    }
  }

  const handleViewTask = async (task: any) => {
    viewedTaskIdRef.current = task.id
    setActiveTaskId('pci_check', task.id)
    setActiveLeftTab('planning-result')
    setResultLoading(true)
    try {
      const response = await pciCheckApi.getResult(task.id)
      if (response?.success && response?.data) {
        setLocalTaskResult(response.data as PCICheckResultData)
      }
    } catch (err: any) {
      console.error('加载PCI核查结果失败:', err)
      setError((t('pciCheck.loadResultFailed') || '加载核查结果失败: ') + (err.message || ''))
    } finally {
      setResultLoading(false)
    }
  }

  const isRunning = loading || taskResult?.status === 'processing'
  const stepIndex =
    wizardStep === 'idle' || wizardStep === 'task_created' ? 0
      : wizardStep === 'params_set' ? 1
        : wizardStep === 'cells_selected' ? 2
          : wizardStep === 'executing' ? 3
            : 4
  const canProceed =
    wizardStep === 'idle' || wizardStep === 'task_created' ? taskName.trim().length > 0
      : wizardStep === 'params_set' ? true
        : wizardStep === 'cells_selected' ? cells.selectedCellIds.size > 0
          : wizardStep === 'completed' ? true
            : false

  return (
    <div className="h-full flex flex-col p-4 min-h-0">
      <h1 className="text-base font-bold mb-6 shrink-0">{t('pciCheck.title') || 'PCI核查'}</h1>

      {error && (
        <div className="mb-6 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2 shrink-0">
          <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-red-500 text-sm font-medium">{t('pciCheck.failed') || '核查失败'}</p>
            <p className="text-red-600 text-xs">{error}</p>
          </div>
        </div>
      )}

      {taskResult?.skippedCells && taskResult.skippedCells.length > 0 && (
        <SkippedCellsNotice
          group="pciCheck"
          skipped={taskResult.skippedCells}
          checkedCount={taskResult.totalCells || 0}
          titleOnly
        />
      )}

      <div className="bg-card p-4 rounded-lg border border-border flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="flex items-center gap-1 mb-3 border-b border-border shrink-0">
          <button
            onClick={() => !isRunning && setActiveLeftTab('history')}
            className={activeLeftTab === 'history' ? btn.activeTab : btn.ghost}
            disabled={isRunning}
          >
            {t('common.historyTask') || '历史任务'}
            <span className={btn.badgeCount}>{pciCheckHistoryCount}</span>
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
            {t('pciCheck.checkResult') || '核查结果'}
            {taskResult?.status === 'completed' && <span className={btn.badgeSuccess}>✓</span>}
            {taskResult?.status === 'failed' && <span className={btn.badgeError}>!</span>}
            {taskResult?.status === 'processing' && (
              <span className="ml-2 inline-flex items-center">
                <Loader2 size={12} className="animate-spin text-blue-500" />
              </span>
            )}
          </button>
          {activeLeftTab === 'history' && <HistoryTabActions selectedCount={selectedCount} />}
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {activeLeftTab === 'task-config' && (
            <PCICheckWizard
              wizardStep={wizardStep}
              stepIndex={stepIndex}
              progress={taskResult?.progress ?? 0}
              isRunning={loading || isRunning}
              taskName={taskName}
              taskNameError={taskNameError}
              onTaskNameChange={(value) => { setTaskName(value); setTaskNameError(null) }}
              config={config}
              onConfigChange={setConfig}
              sectors={config.networkType === 'LTE' ? cells.cellListData.lte : cells.cellListData.nr}
              selectedCellIds={cells.selectedCellIds}
              cellListLoading={cells.cellListLoading}
              cellFileUploading={cells.cellFileUploading}
              cellFileInputRef={cells.cellFileInputRef}
              onToggleCell={cells.toggleCell}
              onSelectAll={cells.selectAll}
              onClearSelections={() => cells.clearSelections()}
              onCellFileChange={cells.handleCellFileChange}
              canProceed={canProceed}
              onNext={handleNext}
              onBack={handleBack}
              onCancel={handleCancel}
            />
          )}

          {activeLeftTab === 'history' && (
            <div className="flex flex-col h-full overflow-hidden">
              <HistoryTable
                taskType="pci_check"
                typeLabel="PCI核查"
                onSelectTask={(task) => {
                  if (!task.result) return
                  setLocalTaskResult(task.result as PCICheckResultData)
                  setActiveTaskId('pci_check', task.id)
                  setActiveLeftTab('planning-result')
                }}
                onViewTask={handleViewTask}
                getCellCount={getCellCount}
                onSelectedChange={(counts) => setSelectedCount(counts.total)}
              />
            </div>
          )}

          {activeLeftTab === 'planning-result' && (
            <PCICheckResultPanel
              result={taskResult}
              config={config}
              loading={resultLoading}
              emptyHint={wizardStep === 'idle'
                ? (t('common.configureFirst') || '请先点击"新建"按钮创建任务')
                : (t('pciCheck.startHint') || '选择小区后点击「开始核查」查看结果')}
              activeCategory={activeCategory}
              onCategoryChange={setActiveCategory}
              exportState={exportState}
              onExportAll={() => runExport('xlsx')}
              onExportCsv={(category) => runExport('csv', category)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
