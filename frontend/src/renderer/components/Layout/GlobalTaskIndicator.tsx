import React from 'react'
import { useTaskStore } from '../../store/taskStore'
import { useAuthStore } from '../../store/authStore'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'

/** 任务类型 → 前端路由映射 */
const TASK_ROUTES: Record<string, string> = {
  pci_planning: '/pci',
  neighbor_planning: '/neighbor',
  tac_check: '/tac',
  tac_planning: '/tac-planning',
  apply_pci: '/pci',
  apply_tac: '/tac-planning',
}

/** 任务类型 → 显示标签 */
const TASK_LABELS: Record<string, string> = {
  pci_planning: 'PCI规划',
  neighbor_planning: '邻区规划',
  tac_check: 'TAC核查',
  tac_planning: 'TAC规划',
  apply_pci: 'PCI应用',
  apply_tac: 'TAC应用',
  upload: '数据上传',
  parameter_update: '参数更新',
}

/** 根据 task.type/type 推断路由（兜底） */
function resolveTaskRoute(task: any): string | null {
  const t = task?.type || task?.taskType
  if (!t) return null
  return TASK_ROUTES[t] || null
}

/** 根据 task.type/type 推断显示标签 */
function getTaskLabel(task: any): string {
  const t = task?.type || task?.taskType
  if (t && TASK_LABELS[t]) return TASK_LABELS[t]
  return '任务'
}

const RUNNING_STATUSES = new Set(['pending', 'processing', 'running'])

export const GlobalTaskIndicator: React.FC = () => {
  const tasks = useTaskStore((s) => s.tasks)
  const activeTaskIds = useTaskStore((s) => s.activeTaskIds)
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()

  const runningEntries = React.useMemo(() => {
    const entries: Array<{
      taskId: string
      type: string
      progress: number
      label: string
      route: string | null
    }> = []
    const visited = new Set<string>()

    // Step 1: 从 activeTaskIds 收集 → 即使 task 详情尚未轮询到也立即显示（进度=0）
    for (const [type, taskId] of Object.entries(activeTaskIds)) {
      if (!taskId || visited.has(taskId)) continue
      visited.add(taskId)
      const task = tasks[taskId]
      if (!task) {
        // 轮询尚未返回 → 立即显示，进度0
        entries.push({
          type,
          taskId,
          progress: 0,
          label: TASK_LABELS[type] || type,
          route: TASK_ROUTES[type] || null,
        })
        continue
      }
      if (RUNNING_STATUSES.has(task.status)) {
        entries.push({
          type,
          taskId,
          progress: task.progress ?? 0,
          label: getTaskLabel(task),
          route: TASK_ROUTES[type] || resolveTaskRoute(task) || null,
        })
      }
    }

    // Step 2: 全量扫描 tasks 补漏
    for (const [taskId, task] of Object.entries(tasks)) {
      if (!task || visited.has(taskId)) continue
      if (RUNNING_STATUSES.has(task.status)) {
        const t = task.type || task.taskType || ''
        entries.push({
          type: t,
          taskId,
          progress: task.progress ?? 0,
          label: getTaskLabel(task),
          route: TASK_ROUTES[t] || resolveTaskRoute(task) || null,
        })
      }
    }

    // 去重
    const seen = new Set<string>()
    return entries.filter((e) => {
      if (seen.has(e.taskId)) return false
      seen.add(e.taskId)
      return true
    })
  }, [tasks, activeTaskIds])

  const username = user?.username || user?.name || ''
  if (runningEntries.length === 0) return null

  return (
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-2 pointer-events-none">
      {runningEntries.map((entry) => {
        const progress = Math.round(entry.progress)
        return (
          <button
            key={entry.taskId}
            onClick={() => {
              if (entry.route) navigate(entry.route)
            }}
            className="pointer-events-auto group
                       bg-white/95 dark:bg-gray-800/95 backdrop-blur-md
                       rounded-xl shadow-2xl border border-gray-200/80 dark:border-gray-700/80
                       hover:bg-white dark:hover:bg-gray-800
                       hover:shadow-2xl hover:border-primary/30 dark:hover:border-primary/30
                       hover:scale-[1.02] active:scale-[0.98]
                       transition-all duration-200 ease-out cursor-pointer
                       min-w-[220px] max-w-[300px] overflow-hidden"
            title={`点击跳转到${entry.label}页面`}
          >
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
    </div>
  )
}
