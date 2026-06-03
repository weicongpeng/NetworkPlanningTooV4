import { useEffect, useMemo } from 'react'
import { X, Clock, CheckCircle2, AlertCircle, Loader2, Eye } from 'lucide-react'
import { useTaskStore, type Task, type TaskType } from '../store/taskStore'
import { btn } from '../utils/buttonStyles'

interface HistoryTaskPanelLabels {
  title: string
  type: string
  status: string
  time: string
  loadResult: string
  empty: string
  noResult: string
  running: string
  completed: string
  failed: string
}

interface HistoryTaskPanelProps {
  open: boolean
  taskType: TaskType
  onClose: () => void
  onSelectTask: (task: Task) => void
  activeTaskId?: string | null
  labels: HistoryTaskPanelLabels
}

function formatTime(ts?: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 size={16} className="text-green-500" />
    case 'failed':
      return <AlertCircle size={16} className="text-red-500" />
    case 'running':
      return <Loader2 size={16} className="animate-spin text-blue-500" />
    default:
      return <Clock size={16} className="text-gray-400" />
  }
}

function StatusBadge({ status, labels }: { status: string; labels: HistoryTaskPanelLabels }) {
  const text = status === 'completed' ? labels.completed
    : status === 'failed' ? labels.failed
    : status === 'running' ? labels.running
    : status

  const colorClass = status === 'completed' ? 'bg-green-100 text-green-700'
    : status === 'failed' ? 'bg-red-100 text-red-700'
    : status === 'running' ? 'bg-blue-100 text-blue-700'
    : 'bg-gray-100 text-gray-600'

  return (
    <span className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${colorClass}`}>
      {text}
    </span>
  )
}

export function HistoryTaskPanel({
  open,
  taskType,
  onClose,
  onSelectTask,
  activeTaskId,
  labels,
}: HistoryTaskPanelProps) {
  const tasks = useTaskStore((s) => s.tasks)

  const filteredTasks = useMemo(() => {
    return Object.values(tasks)
      .filter((t) => t.type === taskType)
      .sort((a, b) => {
        const timeA = a.endTime || a.startTime || 0
        const timeB = b.endTime || b.startTime || 0
        return timeB - timeA
      })
  }, [tasks, taskType])

  useEffect(() => {
    if (!open) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', handleEscape)
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/30 animate-in fade-in duration-150" onClick={onClose} />

      {/* 面板 */}
      <div className="relative w-[380px] max-w-[90vw] bg-card border-l border-border shadow-2xl h-full flex flex-col animate-in slide-in-from-right duration-200">
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Clock size={18} className="text-muted-foreground" />
            <h3 className="font-semibold text-sm">{labels.title}</h3>
            <span className="px-1.5 py-0.5 text-[10px] bg-muted rounded-full text-muted-foreground">
              {filteredTasks.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-muted/80 transition-colors text-muted-foreground hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto">
          {filteredTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
              <Clock size={36} className="opacity-30" />
              <p className="text-sm">{labels.empty}</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filteredTasks.map((task) => {
                const isActive = task.id === activeTaskId
                const hasResult = task.status === 'completed' && task.result

                return (
                  <div
                    key={task.id}
                    className={`px-4 py-3 hover:bg-muted/30 transition-colors ${
                      isActive ? 'bg-blue-50/50 border-l-2 border-blue-400' : 'border-l-2 border-transparent'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <StatusIcon status={task.status} />
                        <div className="min-w-0">
                          <p className="text-xs font-mono text-muted-foreground truncate max-w-[180px]" title={task.id}>
                            {task.id.length > 24 ? task.id.slice(0, 24) + '...' : task.id}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <StatusBadge status={task.status} labels={labels} />
                            <span className="text-[10px] text-muted-foreground">
                              {formatTime(task.startTime)}
                            </span>
                          </div>
                        </div>
                      </div>

                      {hasResult ? (
                        <button
                          onClick={() => onSelectTask(task)}
                          className="flex items-center gap-1 px-2 py-1 text-[10px] bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors shrink-0"
                        >
                          <Eye size={10} />
                          {labels.loadResult}
                        </button>
                      ) : task.status === 'running' ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <div className="w-16 bg-muted rounded-full h-1">
                            <div
                              className="bg-blue-500 h-1 rounded-full transition-all duration-300"
                              style={{ width: `${task.progress || 0}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-blue-600">{task.progress || 0}%</span>
                        </div>
                      ) : task.status === 'failed' ? (
                        <span className="text-[10px] text-red-500 max-w-[100px] truncate" title={task.message}>
                          {task.message || ''}
                        </span>
                      ) : null}
                    </div>

                    {/* 错误消息（failed 状态） */}
                    {task.status === 'failed' && task.message && (
                      <p className="mt-1 text-[10px] text-red-500 truncate max-w-full" title={task.message}>
                        {task.message}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
