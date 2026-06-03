import { useMemo, useEffect, useState } from 'react'
import { Clock, CheckCircle2, AlertCircle, Eye, Trash2, Check, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTaskStore, type TaskType, type Task } from '../store/taskStore'

function formatTime(ts?: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

interface HistoryTableProps {
  taskType: TaskType
  typeLabel: string
  onSelectTask: (task: Task) => void
  /** 点击查看按钮回调（跳转到结果页并打开地图） */
  onViewTask?: (task: Task) => void
  /** 从 task.result 中提取小区数量 */
  getCellCount?: (task: Task) => number | string
  /** 应用任务结果到全量工参的回调，返回 true 表示成功 */
  onApplyTask?: (task: Task) => Promise<boolean>
}

/** 从 task.isApplied 判断是否已应用（后端跨用户共享） */

export function HistoryTable({ taskType, typeLabel, onSelectTask: _onSelectTask, onViewTask, getCellCount, onApplyTask }: HistoryTableProps) {
  const { t } = useTranslation()
  const tasks = useTaskStore((s) => s.tasks)
  const syncHistoryFromBackend = useTaskStore((s) => s.syncHistoryFromBackend)
  const deleteHistoryTask = useTaskStore((s) => s.deleteHistoryTask)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // 删除确认对话框状态
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  // 跟踪正在应用的任务ID
  const [applyingTaskId, setApplyingTaskId] = useState<string | null>(null)

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
  useEffect(() => {
    syncHistoryFromBackend(taskType)
  }, [taskType, syncHistoryFromBackend])

  // 定期轮询同步（其他用户操作后实时更新）
  useEffect(() => {
    const interval = setInterval(() => {
      syncHistoryFromBackend(taskType)
    }, 5000)
    return () => clearInterval(interval)
  }, [taskType, syncHistoryFromBackend])

  const filteredTasks = useMemo(() => {
    return Object.values(tasks)
      .filter((task) => task.type === taskType)
      .sort((a, b) => {
        const timeA = a.endTime || a.startTime || 0
        const timeB = b.endTime || b.startTime || 0
        return timeB - timeA
      })
  }, [tasks, taskType])

  // 确认删除对话框
  const confirmDialog = confirmDelete ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={cancelDelete}>
      <div className="bg-card border border-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-3">{t('common.confirmDeleteTitle') || '确认删除'}</h3>
        <p className="text-sm text-muted-foreground mb-5">
          {t('common.confirmDeleteTaskMsg', { defaultValue: '确认删除该任务？' })}
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={cancelDelete}
            className="px-4 py-2 text-sm bg-muted text-foreground rounded-lg hover:opacity-80 transition-opacity"
          >
            {t('common.cancel') || '取消'}
          </button>
          <button
            onClick={confirmDeleteTask}
            className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
          >
            {t('common.confirmDelete') || '确认删除'}
          </button>
        </div>
      </div>
    </div>
  ) : null

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
          <thead className="sticky top-0 bg-muted/50 z-10">
            <tr className="border-b border-border">
              <th className="text-left px-4 py-3 font-semibold text-xs">{t('common.userName') || '用户名称'}</th>
              <th className="text-left px-4 py-3 font-semibold text-xs">{t('common.taskName') || '任务名称'}</th>
              <th className="text-left px-4 py-3 font-semibold text-xs">{t('common.taskType') || '任务类型'}</th>
              {getCellCount && (
                <th className="text-center px-3 py-3 font-semibold text-xs">{t('common.cellCount')}</th>
              )}
              <th className="text-left px-4 py-3 font-semibold text-xs">{t('common.taskStartTime') || '任务开始时间'}</th>
              <th className="text-left px-4 py-3 font-semibold text-xs">{t('common.taskEndTime') || '任务完成时间'}</th>
              <th className="text-center px-4 py-3 font-semibold text-xs">{t('common.status') || '状态'}</th>
              {onViewTask && (
                <th className="text-center px-4 py-3 font-semibold text-xs">{t('common.actions')}</th>
              )}
            </tr>
          </thead>
        <tbody className="divide-y divide-border">
          {filteredTasks.map((task) => (
            <tr
              key={task.id}
              className="hover:bg-muted/30 transition-colors"
            >
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
              <td className="px-4 py-3 text-center">
                {task.status === 'completed' ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-green-100 text-green-700 rounded-full font-medium">
                    <CheckCircle2 size={10} />
                    {t('common.taskSuccess') || '成功'}
                  </span>
                ) : task.status === 'failed' ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-red-100 text-red-700 rounded-full font-medium">
                    <AlertCircle size={10} />
                    {t('common.taskFailed') || '失败'}
                  </span>
                ) : null}
              </td>
              {onViewTask && (
                <td className="px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onViewTask(task)
                      }}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors font-medium"
                    >
                      <Eye size={12} />
                      {t('common.view')}
                    </button>
                    {onApplyTask && task.status === 'completed' && (
                      task.isApplied ? (
                        <span className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded-lg font-medium cursor-default">
                          <Check size={12} />
                          {t('common.applied') || '已应用'}
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
                                // 应用成功后刷新历史列表（后端已更新 is_applied）
                                await syncHistoryFromBackend(taskType)
                              }
                            } finally {
                              setApplyingTaskId(null)
                            }
                          }}
                          disabled={applyingTaskId === task.id}
                          className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg transition-colors font-medium ${
                            applyingTaskId === task.id
                              ? 'bg-blue-400 text-white cursor-wait'
                              : 'bg-green-500 text-white hover:bg-green-600'
                          } disabled:opacity-50`}
                        >
                          {applyingTaskId === task.id ? (
                            <><Loader2 size={12} className="animate-spin" />{t('common.applying') || '应用中...'}</>
                          ) : (
                            <><Check size={12} />{t('common.apply')}</>
                          )}
                        </button>
                      )
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(task.id)
                      }}
                      disabled={deletingId === task.id}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors font-medium disabled:opacity-50"
                    >
                      <Trash2 size={12} />
                      {deletingId === task.id ? '...' : (t('common.delete') || '删除')}
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  )
}
