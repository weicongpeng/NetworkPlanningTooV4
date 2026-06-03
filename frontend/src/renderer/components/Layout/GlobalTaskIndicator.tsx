import React from 'react'
import { useTaskStore } from '../../store/taskStore'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'

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

export const GlobalTaskIndicator: React.FC = () => {
  const tasks = useTaskStore((s) => s.tasks)
  const activeTaskIds = useTaskStore((s) => s.activeTaskIds)
  const navigate = useNavigate()

  const runningEntries = React.useMemo(() => {
    const entries: Array<{ type: string; taskId: string; progress: number; label: string }> = []
    const visited = new Set<string>()

    // 1. 从 activeTaskIds 检查（任务创建时注册）
    for (const [type, taskId] of Object.entries(activeTaskIds)) {
      if (!taskId || visited.has(taskId)) continue
      visited.add(taskId)
      const task = tasks[taskId]
      if (!task) continue
      if (RUNNING_STATUSES.has(task.status)) {
        entries.push({
          type,
          taskId,
          progress: task.progress ?? 0,
          label: TASK_LABELS[type] || type,
        })
      }
    }

    // 2. 兜底：扫描所有 tasks 中状态为 running 但未在 activeTaskIds 中的
    if (entries.length === 0) {
      for (const [taskId, task] of Object.entries(tasks)) {
        if (!task || visited.has(taskId)) continue
        if (RUNNING_STATUSES.has(task.status)) {
          // 尝试推断任务类型
          const foundType = Object.entries(activeTaskIds).find(([, id]) => id === taskId)?.[0]
          entries.push({
            type: foundType || 'unknown',
            taskId,
            progress: task.progress ?? 0,
            label: foundType ? (TASK_LABELS[foundType] || foundType) : '任务',
          })
        }
      }
    }

    return entries
  }, [tasks, activeTaskIds])

  if (runningEntries.length === 0) return null

  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] flex justify-center pointer-events-none">
      <div className="flex gap-3 mt-1 pointer-events-auto">
        {runningEntries.map((entry) => {
          const progress = Math.round(entry.progress)
          return (
            <div
              key={entry.taskId}
              onClick={() => {
                const route = TASK_ROUTES[entry.type]
                if (route) navigate(route)
              }}
              className="flex items-center gap-2 px-3 py-2 text-xs font-medium
                         bg-white/95 dark:bg-gray-800/95 text-gray-700 dark:text-gray-200
                         rounded-lg border border-gray-200 dark:border-gray-700
                         hover:bg-gray-50 dark:hover:bg-gray-700/80
                         transition-colors shadow-lg cursor-pointer min-w-[160px]"
              title="点击跳转到任务页面"
            >
              {/* 动态旋转图标 */}
              <Loader2 className="w-4 h-4 text-primary animate-spin flex-shrink-0" />

              {/* 任务信息 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{entry.label}</span>
                  <span className="text-primary font-semibold tabular-nums flex-shrink-0">{progress}%</span>
                </div>
                {/* 进度条 */}
                <div className="mt-1 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
