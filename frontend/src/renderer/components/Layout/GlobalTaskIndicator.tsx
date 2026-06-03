import React from 'react'
import { useTaskStore } from '../../store/taskStore'
import { useNavigate } from 'react-router-dom'

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

export const GlobalTaskIndicator: React.FC = () => {
  const tasks = useTaskStore((s) => s.tasks)
  const activeTaskIds = useTaskStore((s) => s.activeTaskIds)
  const navigate = useNavigate()

  const runningEntries = React.useMemo(() => {
    const entries: Array<{ type: string; taskId: string; progress: number; label: string }> = []

    for (const [type, taskId] of Object.entries(activeTaskIds)) {
      if (!taskId) continue
      const task = tasks[taskId]
      if (!task) continue
      if (task.status === 'running' || task.status === 'pending' || task.status === 'processing') {
        entries.push({
          type,
          taskId,
          progress: task.progress ?? 0,
          label: TASK_LABELS[type] || type,
        })
      }
    }

    return entries
  }, [tasks, activeTaskIds])

  if (runningEntries.length === 0) return null

  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex justify-center pointer-events-none">
      <div className="flex gap-3 mt-1 pointer-events-auto">
        {runningEntries.map((entry) => (
          <button
            key={entry.taskId}
            onClick={() => {
              const route = TASK_ROUTES[entry.type]
              if (route) navigate(route)
            }}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium
                       bg-primary/10 text-primary rounded-full border border-primary/20
                       hover:bg-primary/20 transition-colors shadow-sm"
            title="点击跳转到任务页面"
          >
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            <span>
              {entry.label}: {Math.round(entry.progress)}%
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
