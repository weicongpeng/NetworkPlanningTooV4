import React from 'react'
import { useTaskStore } from '../../store/taskStore'
import { useAuthStore } from '../../store/authStore'
import { useNavigate } from 'react-router-dom'
import { Loader2, Clock } from 'lucide-react'

const TASK_ROUTES: Record<string, string> = {
  pci_planning: '/pci',
  neighbor_planning: '/neighbor',
  tac_check: '/tac',
  tac_planning: '/tac/planning',
}

const TASK_LABELS: Record<string, string> = {
  pci_planning: 'PCI规划',
  neighbor_planning: '邻区规划',
  tac_check: 'TAC核查',
  tac_planning: 'TAC规划',
}

const RUNNING_STATUSES = new Set(['pending', 'processing', 'running'])
const QUEUED_STATUSES = new Set(['queued', 'waiting'])

export const GlobalTaskIndicator: React.FC = () => {
  const tasks = useTaskStore((s) => s.tasks)
  const activeTaskIds = useTaskStore((s) => s.activeTaskIds)
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()

  const { runningEntries, queuedEntries } = React.useMemo(() => {
    const run: Array<{ type: string; taskId: string; progress: number; label: string }> = []
    const queue: Array<{ type: string; taskId: string; label: string }> = []
    const visited = new Set<string>()

    // 从 activeTaskIds 检查
    for (const [type, taskId] of Object.entries(activeTaskIds)) {
      if (!taskId || visited.has(taskId)) continue
      visited.add(taskId)
      const task = tasks[taskId]
      if (!task) continue
      if (RUNNING_STATUSES.has(task.status)) {
        run.push({
          type,
          taskId,
          progress: task.progress ?? 0,
          label: TASK_LABELS[type] || type,
        })
      } else if (QUEUED_STATUSES.has(task.status)) {
        queue.push({ type, taskId, label: TASK_LABELS[type] || type })
      }
    }

    // 兜底扫描
    if (run.length === 0 && queue.length === 0) {
      for (const [taskId, task] of Object.entries(tasks)) {
        if (!task || visited.has(taskId)) continue
        if (RUNNING_STATUSES.has(task.status)) {
          run.push({
            type: 'unknown',
            taskId,
            progress: task.progress ?? 0,
            label: '任务',
          })
        }
      }
    }

    return { runningEntries: run, queuedEntries: queue }
  }, [tasks, activeTaskIds])

  const username = user?.username || user?.name || ''

  if (runningEntries.length === 0 && queuedEntries.length === 0) return null

  const totalCount = runningEntries.length + queuedEntries.length
  const isMultiple = totalCount > 1

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none">
      {/* 提示卡片 */}
      <div className="pointer-events-auto w-full max-w-sm">
        <div className="bg-white/95 dark:bg-gray-800/95 backdrop-blur-sm
                        rounded-xl shadow-xl border border-gray-200/80 dark:border-gray-700/80
                        overflow-hidden">
          {/* 头部 */}
          <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700/50
                          flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Loader2 className="w-4 h-4 text-primary animate-spin flex-shrink-0" />
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
                {isMultiple
                  ? `任务执行中 (${runningEntries.length}/${totalCount})`
                  : '任务执行中'}
              </span>
            </div>
            {username && (
              <span className="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0 truncate max-w-[120px]">
                {username}
              </span>
            )}
          </div>

          {/* 运行中任务列表 */}
          <div className="px-4 py-2 space-y-2">
            {runningEntries.map((entry) => {
              const progress = Math.round(entry.progress)
              return (
                <button
                  key={entry.taskId}
                  onClick={() => {
                    const route = TASK_ROUTES[entry.type]
                    if (route) navigate(route)
                  }}
                  className="w-full flex items-center gap-3 p-2 rounded-lg
                             bg-primary/5 hover:bg-primary/10
                             transition-colors text-left cursor-pointer"
                  title="点击跳转到任务页面"
                >
                  {/* 旋转动画 */}
                  <Loader2 className="w-4 h-4 text-primary animate-spin flex-shrink-0" />

                  {/* 任务信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-200 truncate">
                        {entry.label}
                      </span>
                      <span className="text-xs font-semibold text-primary tabular-nums flex-shrink-0">
                        {progress}%
                      </span>
                    </div>
                    {/* 进度条 */}
                    <div className="mt-1.5 h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-500 ease-out"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                </button>
              )
            })}

            {/* 等待中的任务 */}
            {queuedEntries.map((entry) => (
              <div
                key={entry.taskId}
                className="flex items-center gap-3 p-2 rounded-lg opacity-60"
              >
                <Clock className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {entry.label} (等待中)
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
