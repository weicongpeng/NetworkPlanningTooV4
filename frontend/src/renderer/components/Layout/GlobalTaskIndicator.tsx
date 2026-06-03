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

/** 从 activeTaskIds 反向查找任务类型 */
function getTaskType(activeTaskIds: Record<string, string | null>, taskId: string): string | null {
  for (const [type, id] of Object.entries(activeTaskIds)) {
    if (id === taskId) return type
  }
  return null
}

/**
 * 从 task.type 字段推断显示标签
 */
function getTaskLabel(task: any): string {
  const typeMap: Record<string, string> = {
    pci_planning: 'PCI规划',
    neighbor_planning: '邻区规划',
    tac_check: 'TAC核查',
    tac_planning: 'TAC规划',
    apply_pci: 'PCI应用',
    apply_tac: 'TAC应用',
  }
  // 优先使用 task.type
  if (task?.type && typeMap[task.type]) return typeMap[task.type]
  // 其次 task.taskType
  if (task?.taskType && typeMap[task.taskType]) return typeMap[task.taskType]
  return '任务'
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

    // 从 activeTaskIds 检查（首要来源，可确定任务类型）
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
          label: getTaskLabel(task) || TASK_LABELS[type] || type,
        })
      } else if (QUEUED_STATUSES.has(task.status)) {
        queue.push({ type, taskId, label: getTaskLabel(task) || TASK_LABELS[type] || type })
      }
    }

    // 兜底：扫描所有 tasks 中状态为 running 的
    if (run.length === 0 && queue.length === 0) {
      for (const [taskId, task] of Object.entries(tasks)) {
        if (!task || visited.has(taskId)) continue
        if (RUNNING_STATUSES.has(task.status)) {
          const foundType = getTaskType(activeTaskIds, taskId)
          run.push({
            type: foundType || 'unknown',
            taskId,
            progress: task.progress ?? 0,
            label: getTaskLabel(task),
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
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-2 pointer-events-none">
      {runningEntries.map((entry) => {
        const progress = Math.round(entry.progress)
        return (
          <button
            key={entry.taskId}
            onClick={() => {
              const route = TASK_ROUTES[entry.type]
              if (route) navigate(route)
            }}
            className="pointer-events-auto group
                       bg-white/90 dark:bg-gray-800/90 backdrop-blur-md
                       rounded-xl shadow-2xl border border-gray-200/80 dark:border-gray-700/80
                       hover:bg-white dark:hover:bg-gray-800
                       hover:shadow-2xl hover:border-primary/30 dark:hover:border-primary/30
                       hover:scale-[1.02] active:scale-[0.98]
                       transition-all duration-200 ease-out cursor-pointer
                       min-w-[220px] max-w-[300px] overflow-hidden"
            title={`点击跳转到${entry.label}页面`}
          >
            {/* 顶部：任务类型 + 用户名 + 进度 */}
            <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1.5">
              <Loader2 className="w-4 h-4 text-primary animate-spin flex-shrink-0" />
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate flex-1 text-left">
                {entry.label}
              </span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs font-bold text-primary tabular-nums">{progress}%</span>
                {username && (
                  <span className="text-[10px] text-gray-400 dark:text-gray-500 hidden group-hover:inline transition-opacity">
                    {username}
                  </span>
                )}
              </div>
            </div>
            {/* 进度条 */}
            <div className="px-3.5 pb-2.5">
              <div className="h-1.5 bg-gray-100 dark:bg-gray-700/80 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-primary/80 to-primary rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          </button>
        )
      })}
      {queuedEntries.map((entry) => (
        <div
          key={entry.taskId}
          className="pointer-events-auto
                     bg-white/70 dark:bg-gray-800/70 backdrop-blur-sm
                     rounded-lg border border-gray-200/60 dark:border-gray-700/60
                     px-3.5 py-2 flex items-center gap-2 opacity-80"
        >
          <Clock className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-xs text-gray-500 dark:text-gray-400">{entry.label}（等待中）</span>
        </div>
      ))}
    </div>
  )
}
