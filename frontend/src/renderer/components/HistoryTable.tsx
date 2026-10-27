import { useMemo, useEffect, useState, useCallback, useRef } from 'react'
import { Clock, Eye, Trash2, Check, CheckCheck, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTaskStore, type TaskType, type Task } from '../store/taskStore'
import { DESKTOP_SYNCED_EVENT } from '../store/desktopSyncStore'
import { TASKS_CHANGED_EVENT } from '../services/websocketService'
import { LoadingSpinner } from './LoadingSpinner'

function formatTime(ts?: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// 模块级批量操作句柄（替代 forwardRef，避免 Vite production build TDZ 问题）
// 页签栏的常驻图标按钮（刷新/全选/应用/删除）由此进入表格内部，无需提升状态
type BatchHandler = () => Promise<void>
let _batchApplyHandler: BatchHandler | null = null
let _batchDeleteHandler: BatchHandler | null = null
let _refreshHandler: BatchHandler | null = null
let _selectAllHandler: (() => void) | null = null
function setBatchHandlers(
  apply: BatchHandler | null,
  del: BatchHandler | null,
  refresh: BatchHandler | null = null,
  selectAll: (() => void) | null = null,
) {
  _batchApplyHandler = apply
  _batchDeleteHandler = del
  _refreshHandler = refresh
  _selectAllHandler = selectAll
}
export function triggerBatchApply() { return _batchApplyHandler?.() }
export function triggerBatchDelete() { return _batchDeleteHandler?.() }
/** 刷新当前页历史任务（拉取最新条目） */
export function triggerHistoryRefresh() { return _refreshHandler?.() }
/** 全选/取消全选切换 */
export function triggerHistorySelectAll() { _selectAllHandler?.() }

interface HistoryTableProps {
  taskType: TaskType
  typeLabel: string
  onSelectTask: (task: Task) => void
  /** 点击查看按钮回调（跳转到结果页并打开地图） */
  onViewTask?: (task: Task) => void
  /** 从 task.result 中提取小区数量 */
  getCellCount?: (task: Task) => number | string
  /** 应用任务结果到全量工参的回调，返回 true 表示成功。skipConfirm=true 时跳过确认弹窗（批量调用） */
  onApplyTask?: (task: Task, skipConfirm?: boolean) => Promise<boolean>
  /** 批量应用回调：一次性处理所有选中任务，返回 {success, updatedCount}。优先于 onApplyTask 逐条循环 */
  onBatchApplyTasks?: (tasks: Task[]) => Promise<{ success: boolean; updatedCount?: number }>
  /** 选中数量变化回调：返回 total（总选中数）和 unappliable（可应用数） */
  onSelectedChange?: (counts: { total: number; unappliable: number }) => void
  /** 批量操作状态变化回调 */
  onBatchStatusChange?: (applying: boolean, deleting: boolean) => void
  /** 是否正在加载历史数据 */
  loading?: boolean
}

export interface HistoryTableRef {
  triggerBatchApply: () => Promise<void>
  triggerBatchDelete: () => Promise<void>
}

/** 判断任务是否可以勾选（已完成即可勾选，不区分已应用状态） */
function isTaskSelectable(task: Task): boolean {
  return task.status === 'completed'
}

export function HistoryTable({
  taskType, typeLabel, onSelectTask: _onSelectTask, onViewTask, getCellCount, onApplyTask, onBatchApplyTasks, onSelectedChange, onBatchStatusChange
}: HistoryTableProps) {
  const { t } = useTranslation()
  const tasks = useTaskStore((s) => s.tasks)
  const syncHistoryFromBackend = useTaskStore((s) => s.syncHistoryFromBackend)
  const deleteHistoryTask = useTaskStore((s) => s.deleteHistoryTask)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // 删除确认对话框状态
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  // 跟踪正在应用的任务ID
  const [applyingTaskId, setApplyingTaskId] = useState<string | null>(null)

  // ===== 批量选择/应用状态 =====
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
  const [batchApplying, setBatchApplying] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [batchApplyProgress, setBatchApplyProgress] = useState({ current: 0, total: 0 })
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false)

  // 首次加载动画：后端同步期间显示 LoadingSpinner
  const [isLoading, setIsLoading] = useState(true)

  // ===== 分页状态：每页固定 20 条，底部翻页浏览 =====
  const pageSize = 20
  // 🔥 外网优化：总数初始取 store 的 historyCounts（页面挂载时 badge 同步已拿到真实总数），
  // 避免挂载不请求时分页栏显示"共 0 条"
  const storeHistoryCount = useTaskStore(s => s.historyCounts[taskType] ?? 0)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalCount, setTotalCount] = useState(storeHistoryCount)
  // 当前页任务 ID：store 会累积多页与运行中任务，表格只渲染本页 20 条，
  // 避免历史任务多时每次刷新都重渲染上百行。
  const [currentPageIds, setCurrentPageIds] = useState<Set<string> | null>(null)
  const currentPageRef = useRef(1) // 供 visibilitychange / 批量操作等非渲染场景读取当前页
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  // 挂载不请求时，若 badge 同步更新了 historyCounts，同步到分页总数
  useEffect(() => {
    setTotalCount(storeHistoryCount)
  }, [storeHistoryCount])

  // 加载指定页历史任务，并同步分页信息（总数 / 当前页）
  const loadHistoryPage = useCallback(async (page: number) => {
    let effectivePage = page
    let info = await syncHistoryFromBackend(taskType, page, pageSize)
    // 删掉末页最后一条后自动回退一页，避免停在空白页
    if (info && info.taskIds.length === 0 && info.total > 0 && page > 1) {
      effectivePage = page - 1
      info = await syncHistoryFromBackend(taskType, effectivePage, pageSize)
    }
    const nextPage = info?.page ?? effectivePage
    setCurrentPage(nextPage)
    currentPageRef.current = nextPage
    if (info) {
      setTotalCount(info.total)
      setCurrentPageIds(new Set(info.taskIds))
    }
    return info
  }, [taskType, syncHistoryFromBackend])

  // ===== 派生数据（必须在使用前定义，避免 Rollup 生产构建 TDZ 问题） =====
  const filteredTasks = useMemo(() => {
    const sorted = Object.values(tasks)
      .filter((task) => task.type === taskType)
      .sort((a, b) => {
        const timeA = a.endTime || a.startTime || 0
        const timeB = b.endTime || b.startTime || 0
        return timeB - timeA
      })
    if (currentPageIds === null) return sorted.slice(0, pageSize)
    return sorted.filter((task) => currentPageIds.has(task.id))
  }, [tasks, taskType, currentPageIds, pageSize])

  // ===== 全选逻辑 =====
  const allSelectable = useMemo(() => {
    return filteredTasks.filter(isTaskSelectable)
  }, [filteredTasks])

  const allSelectableIds = useMemo(() => allSelectable.map(t => t.id), [allSelectable])

  const isAllSelected = allSelectableIds.length > 0 && allSelectableIds.every(id => selectedTaskIds.has(id))

  // 选中数量变化时通知父组件（区分总选中数和可应用数）
  useEffect(() => {
    const unappliableCount = filteredTasks.filter(t => selectedTaskIds.has(t.id) && t.status === 'completed' && !t.isApplied).length
    onSelectedChange?.({ total: selectedTaskIds.size, unappliable: unappliableCount })
  }, [selectedTaskIds, filteredTasks, onSelectedChange])

  const handleDelete = async (taskId: string) => {
    setConfirmDelete(taskId)
  }

  const confirmDeleteTask = async () => {
    if (!confirmDelete) return
    setDeletingId(confirmDelete)
    setConfirmDelete(null)
    await deleteHistoryTask(confirmDelete, taskType)
    setDeletingId(null)
  }

  const cancelDelete = () => {
    setConfirmDelete(null)
  }

  // 组件挂载时从后端同步历史任务（解决清理浏览器缓存后历史丢失的问题）
  // 🔥 外网优化：已有数据时静默后台刷新（不显示 loading，秒开 + 数据保持新鲜），
  // 避免高延迟下每次进入历史 tab 都白屏等待；无数据时才显示加载动画
  useEffect(() => {
    const hasExisting = Object.values(tasks).filter(t => t.type === taskType).length > 0
    // 有数据时秒开（先显示缓存），后台静默刷新；无数据时显示加载动画
    if (!hasExisting) setIsLoading(true)
    const doSync = async () => {
      try {
        await loadHistoryPage(1)
      } finally {
        setIsLoading(false)
      }
    }
    doSync()
    // 🔥 兜底：5秒后无论是否同步完成都关闭loading，避免卡死在加载状态
    const safetyTimer = setTimeout(() => setIsLoading(false), 5000)
    return () => clearTimeout(safetyTimer)
  }, [taskType, loadHistoryPage])

  // 🔥 优化：移除 5 秒轮询，改为页面可见时刷新（页面切换回来时自动同步）
  // + 操作完成后（删除/应用）已由调用方显式触发 syncHistoryFromBackend
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadHistoryPage(currentPageRef.current)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [taskType, loadHistoryPage])

  // 同组任务历史是跨端共享的（桌面端镜像同步 / 网页端标记应用）：
  // - 桌面端同步落地后派发 DESKTOP_SYNCED_EVENT → 立即刷新
  // - 服务器广播 tasks_changed（同组别端删除/新增/标记应用）→ 立即刷新（网页端）
  // - 可见时每 60 秒静默刷新一次兜底
  useEffect(() => {
    const handleDesktopSynced = () => {
      loadHistoryPage(currentPageRef.current)
    }
    const handleTasksChanged = () => {
      loadHistoryPage(currentPageRef.current)
    }
    window.addEventListener(DESKTOP_SYNCED_EVENT, handleDesktopSynced)
    window.addEventListener(TASKS_CHANGED_EVENT, handleTasksChanged)
    const pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadHistoryPage(currentPageRef.current)
      }
    }, 60000)
    return () => {
      window.removeEventListener(DESKTOP_SYNCED_EVENT, handleDesktopSynced)
      window.removeEventListener(TASKS_CHANGED_EVENT, handleTasksChanged)
      window.clearInterval(pollTimer)
    }
  }, [taskType, loadHistoryPage])

  const handleToggleSelectAll = useCallback(() => {
    if (isAllSelected) {
      setSelectedTaskIds(new Set())
    } else {
      setSelectedTaskIds(new Set(allSelectableIds))
    }
  }, [isAllSelected, allSelectableIds])

  const handleToggleSelect = useCallback((taskId: string) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) {
        next.delete(taskId)
      } else {
        next.add(taskId)
      }
      return next
    })
  }, [])

  // ===== 批量应用逻辑 =====
  const handleBatchApply = useCallback(async () => {
    const applyTasks = filteredTasks.filter(t => selectedTaskIds.has(t.id) && t.status === 'completed' && !t.isApplied)
    if (applyTasks.length === 0) return

    if (!window.confirm(
      t('common.batchApplyConfirm', { defaultValue: '确定要应用选中的 {{count}} 个任务吗？' }).replace('{{count}}', String(applyTasks.length))
    )) return

    setBatchApplying(true)
    onBatchStatusChange?.(true, false)

    // 优先使用批量回调（一次性处理所有任务，效率最高）
    if (onBatchApplyTasks) {
      try {
        const result = await onBatchApplyTasks(applyTasks)
        if (result.success) {
          // 批量应用成功，所有任务已标记为已应用
          setBatchApplyProgress({ current: applyTasks.length, total: applyTasks.length })
        } else {
          // 批量应用失败
          const msg = t('common.batchApplyResult', { defaultValue: '应用完成：成功 {{success}} 个，失败 {{fail}} 个' })
            .replace('{{success}}', '0')
            .replace('{{fail}}', String(applyTasks.length))
          alert(msg)
        }
      } catch (err: any) {
        alert(err?.message || '批量应用失败')
      }
    } else if (onApplyTask) {
      // 回退：逐条应用（兼容旧逻辑）
      setBatchApplyProgress({ current: 0, total: applyTasks.length })
      let successCount = 0
      let failCount = 0

      for (let i = 0; i < applyTasks.length; i++) {
        const task = applyTasks[i]
        setBatchApplyProgress({ current: i + 1, total: applyTasks.length })
        try {
          const result = await onApplyTask(task, true)
          if (result) successCount++
          else failCount++
        } catch {
          failCount++
        }
      }

      if (failCount > 0) {
        const msg = t('common.batchApplyResult', { defaultValue: '应用完成：成功 {{success}} 个，失败 {{fail}} 个' })
          .replace('{{success}}', String(successCount))
          .replace('{{fail}}', String(failCount))
        alert(msg)
      }
    }

    setBatchApplying(false)
    onBatchStatusChange?.(false, false)
    setSelectedTaskIds(new Set())
    setBatchApplyProgress({ current: 0, total: 0 })

    await loadHistoryPage(currentPageRef.current)
  }, [filteredTasks, selectedTaskIds, onApplyTask, onBatchApplyTasks, loadHistoryPage, t])

  // ===== 批量删除逻辑 =====
  const handleBatchDelete = useCallback(async () => {
    const deleteTasks = filteredTasks.filter(t => selectedTaskIds.has(t.id))
    if (deleteTasks.length === 0) return

    if (!window.confirm(
      t('common.batchDeleteConfirm', { defaultValue: '确定要删除选中的 {{count}} 个任务吗？' }).replace('{{count}}', String(deleteTasks.length))
    )) return

    setBatchDeleting(true)
    onBatchStatusChange?.(false, true)
    let successCount = 0
    let failCount = 0

    for (const task of deleteTasks) {
      try {
        const result = await deleteHistoryTask(task.id, taskType)
        if (result) successCount++
        else failCount++
      } catch {
        failCount++
      }
    }

    setBatchDeleting(false)
    onBatchStatusChange?.(false, false)
    setSelectedTaskIds(new Set())
    // deleteHistoryTask 内部已通过 setState 更新 tasks，此处刷新当前页同步总数
    await loadHistoryPage(currentPageRef.current)

    if (failCount > 0) {
      const msg = t('common.batchDeleteResult', { defaultValue: '删除完成：成功 {{success}} 个，失败 {{fail}} 个' })
        .replace('{{success}}', String(successCount))
        .replace('{{fail}}', String(failCount))
      alert(msg)
    }
  }, [filteredTasks, selectedTaskIds, deleteHistoryTask, loadHistoryPage, t])

  // 页签栏「刷新」按钮：重新拉取当前页，展示最新条目
  const handleRefresh = useCallback(async () => {
    await loadHistoryPage(currentPageRef.current)
  }, [loadHistoryPage])

  // ===== 将批量处理方法注册到模块级变量（供父组件 tab 栏按钮调用） =====
  useEffect(() => {
    setBatchHandlers(handleBatchApply, handleBatchDelete, handleRefresh, handleToggleSelectAll)
    return () => setBatchHandlers(null, null)
  }, [handleBatchApply, handleBatchDelete, handleRefresh, handleToggleSelectAll])

  // 确认删除对话框
  const confirmDialog = confirmDelete ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={cancelDelete}>
      <div className="bg-card border border-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-3">{t('common.confirmDeleteTitle') || '确认删除'}</h3>
        <p className="text-sm text-muted-foreground mb-5">
          {t('common.confirmDeleteTaskMsg', { defaultValue: '确认删除该任务？' })}
        </p>
        <div className="flex justify-end gap-3">
          <button onClick={cancelDelete} className="px-4 py-2 text-sm bg-muted text-foreground rounded-lg hover:opacity-80 transition-opacity">
            {t('common.cancel') || '取消'}
          </button>
          <button onClick={confirmDeleteTask} className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors">
            {t('common.confirmDelete') || '确认删除'}
          </button>
        </div>
      </div>
    </div>
  ) : null

  if (isLoading) {
    return (
      <>
        {confirmDialog}
        <LoadingSpinner variant="spinner" text={t('common.loadingHistory') || '正在加载历史任务...'} />
      </>
    )
  }

  if (filteredTasks.length === 0) {
    return (
      <>
        {confirmDialog}
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
          <Clock size={48} className="opacity-20" />
          <p className="text-sm">{t('common.noTaskHistory') || '暂无历史任务'}</p>
        </div>
      </>
    )
  }

  return (
    <>
      {confirmDialog}
      <div className="flex-1 min-h-0 overflow-auto bg-card border border-border rounded-xl">
        <table className="w-full text-sm">
          {/* 表头必须不透明：半透明背景会让滚动的正文透过表头显示 */}
          <thead className="sticky top-0 z-20">
            <tr className="border-b border-border">
              {/* 复选框列 */}
              <th className="sticky top-0 z-20 bg-muted px-3 py-3 w-10">
                {allSelectableIds.length > 0 && (
                  <input
                    type="checkbox"
                    checked={isAllSelected}
                    onChange={handleToggleSelectAll}
                    disabled={batchApplying || batchDeleting}
                    className="w-4 h-4 cursor-pointer disabled:opacity-50"
                    title={t('common.selectAll') || '全选'}
                  />
                )}
              </th>
              <th className="sticky top-0 z-20 bg-muted text-left px-4 py-3 font-semibold text-xs">{t('common.userName') || '用户名称'}</th>
              <th className="sticky top-0 z-20 bg-muted text-left px-4 py-3 font-semibold text-xs">{t('common.taskName') || '任务名称'}</th>
              <th className="sticky top-0 z-20 bg-muted text-left px-4 py-3 font-semibold text-xs">{t('common.taskType') || '任务类型'}</th>
              {getCellCount && (
                <th className="sticky top-0 z-20 bg-muted text-center px-3 py-3 font-semibold text-xs">{t('common.cellCount')}</th>
              )}
              <th className="sticky top-0 z-20 bg-muted text-left px-4 py-3 font-semibold text-xs">{t('common.taskStartTime') || '任务开始时间'}</th>
              <th className="sticky top-0 z-20 bg-muted text-left px-4 py-3 font-semibold text-xs">{t('common.taskEndTime') || '任务完成时间'}</th>
              <th className="sticky top-0 z-20 bg-muted text-center px-4 py-3 font-semibold text-xs">{t('common.status') || '状态'}</th>
              {onViewTask && (
                <th className="sticky top-0 z-20 bg-muted text-center px-4 py-3 font-semibold text-xs min-w-[120px]">{t('common.actions')}</th>
              )}
            </tr>
          </thead>
        <tbody className="divide-y divide-border">
          {filteredTasks.map((task) => {
            const isApplicable = isTaskSelectable(task)
            const isSelected = selectedTaskIds.has(task.id)
            return (
              <tr
                key={task.id}
                className={`transition-colors ${isSelected ? 'bg-accent/30' : 'hover:bg-muted/30'}`}
              >
                {/* 复选框列 */}
                <td className="px-3 py-3">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => {
                      if (isApplicable) {
                        handleToggleSelect(task.id)
                      }
                    }}
                    disabled={!isApplicable || batchApplying || batchDeleting}
                    className="w-4 h-4 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    title={
                      !isApplicable
                        ? (task.status !== 'completed' ? (t('common.taskFailed') || '任务未完成') : (t('common.applied') || '已应用'))
                        : (t('common.selectItem') || '选择')
                    }
                  />
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {task.userName || '-'}
                </td>
                <td className="px-4 py-3 text-xs font-medium max-w-[200px] truncate" title={task.taskName || task.id}>
                  {task.taskName || task.id.slice(0, 24)}
                </td>
                <td className="px-4 py-3">
                  <span className="px-2 py-0.5 text-[10px] bg-muted rounded-full text-muted-foreground">
                    {typeLabel}
                  </span>
                </td>
                {getCellCount && (
                  <td className="px-3 py-3 text-xs text-center text-muted-foreground">
                    {getCellCount ? getCellCount(task) : '-'}
                  </td>
                )}
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {formatTime(task.startTime)}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {formatTime(task.endTime)}
                </td>
                {/* 状态列：纯文字，无背景/颜色/图标 */}
                <td className="px-4 py-3 text-center text-xs text-muted-foreground">
                  {task.status === 'completed' ? (t('common.taskSuccess') || '成功') : task.status === 'failed' ? (t('common.taskFailed') || '失败') : ''}
                </td>
                {/* 操作列：只有图标，无文字标签 */}
                {onViewTask && (
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); onViewTask(task) }}
                        className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                        title={t('common.view') || '查看'}
                      >
                        <Eye size={15} />
                      </button>
                      {onApplyTask && task.status === 'completed' && (
                        task.isApplied ? (
                          // 已应用：灰色双勾（与「待应用」的亮色单勾区分）
                          <span className="p-0.5 text-muted-foreground/45 cursor-default" title={t('common.applied') || '已应用'}>
                            <CheckCheck size={15} />
                          </span>
                        ) : (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation()
                              if (applyingTaskId) return
                              setApplyingTaskId(task.id)
                              try {
                                const success = await onApplyTask(task)
                                if (success) {
                                  await loadHistoryPage(currentPageRef.current)
                                  setSelectedTaskIds(prev => {
                                    const next = new Set(prev)
                                    next.delete(task.id)
                                    return next
                                  })
                                }
                              } finally {
                                setApplyingTaskId(null)
                              }
                            }}
                            disabled={applyingTaskId === task.id}
                            className={`p-0.5 text-primary transition-colors ${
                              applyingTaskId === task.id
                                ? 'cursor-wait opacity-60'
                                : 'hover:text-primary/70'
                            }`}
                            title={t('common.apply') || '应用'}
                          >
                            {applyingTaskId === task.id
                              ? <Loader2 size={15} className="animate-spin" />
                              : <Check size={15} strokeWidth={2.5} />}
                          </button>
                        )
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(task.id) }}
                        disabled={deletingId === task.id}
                        className="p-0.5 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                        title={t('common.delete') || '删除'}
                      >
                        {deletingId === task.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
    {/* ===== 底部翻页栏：每页固定 20 条，统计全部数量与每页数量 ===== */}
    <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-card rounded-b-xl">
      <span className="text-xs text-muted-foreground">
        {t('common.historyTotal', { defaultValue: '共 {{total}} 条' }).replace('{{total}}', String(totalCount))}
        {' · '}
        {t('common.perPage', { defaultValue: '每页 {{size}} 条' }).replace('{{size}}', String(pageSize))}
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => loadHistoryPage(currentPage - 1)}
          disabled={currentPage <= 1}
          className="px-2.5 py-1 text-xs rounded-md border border-border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
        >
          {t('common.prevPage') || '上一页'}
        </button>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {t('common.pageInfo', { defaultValue: '第 {{page}} / {{totalPages}} 页' })
            .replace('{{page}}', String(currentPage))
            .replace('{{totalPages}}', String(totalPages))}
        </span>
        <button
          onClick={() => loadHistoryPage(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className="px-2.5 py-1 text-xs rounded-md border border-border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
        >
          {t('common.nextPage') || '下一页'}
        </button>
      </div>
    </div>
    </>
  )
}
