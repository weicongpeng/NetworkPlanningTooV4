import { useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Clock, CheckCircle2, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTaskStore, type TaskType } from '../store/taskStore'
import { btn } from '../utils/buttonStyles'

type PageType = 'pci' | 'neighbor' | 'tac' | 'tac-planning'

interface TypeMeta {
  taskType: TaskType
  backRoute: string
  typeLabel: string
}

const TYPE_META: Record<PageType, TypeMeta> = {
  pci: { taskType: 'pci_planning', backRoute: '/pci', typeLabel: 'PCI规划' },
  neighbor: { taskType: 'neighbor_planning', backRoute: '/neighbor', typeLabel: '邻区规划' },
  tac: { taskType: 'tac_check', backRoute: '/tac', typeLabel: 'TAC核查' },
  'tac-planning': { taskType: 'tac_planning', backRoute: '/tac-planning', typeLabel: 'TAC规划' },
}

function formatTime(ts?: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function HistoryPage() {
  const { type } = useParams<{ type: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const tasks = useTaskStore((s) => s.tasks)

  const meta = TYPE_META[type as PageType]

  if (!meta) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <AlertCircle size={48} className="mx-auto mb-4 text-red-400" />
          <p className="text-lg font-semibold mb-2">无效的页面类型: {type}</p>
          <button onClick={() => navigate('/')} className={btn.primary}>
            返回首页
          </button>
        </div>
      </div>
    )
  }

  const filteredTasks = useMemo(() => {
    return Object.values(tasks)
      .filter((t) => t.type === meta.taskType)
      .sort((a, b) => {
        const timeA = a.endTime || a.startTime || 0
        const timeB = b.endTime || b.startTime || 0
        return timeB - timeA
      })
  }, [tasks, meta.taskType])

  const handleBack = () => {
    navigate(meta.backRoute)
  }

  const handleSelectTask = (taskId: string) => {
    navigate(meta.backRoute, { state: { loadTaskId: taskId } })
  }

  return (
    <div className="h-full flex flex-col p-4 min-h-0">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6 shrink-0">
        <button
          onClick={handleBack}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors"
        >
          <ArrowLeft size={16} />
          {t('common.backToPlanning')}
        </button>
        <h1 className="text-2xl font-bold">{meta.typeLabel}{t('common.historyTask')}</h1>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto bg-card border border-border rounded-xl">
        {filteredTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
            <Clock size={48} className="opacity-20" />
            <p className="text-sm">{t('common.noTaskHistory')}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/50 z-10">
              <tr className="border-b border-border">
                <th className="text-left px-4 py-3 font-semibold text-xs">{t('common.userName')}</th>
                <th className="text-left px-4 py-3 font-semibold text-xs">{t('common.taskName')}</th>
                <th className="text-left px-4 py-3 font-semibold text-xs">{t('common.taskType')}</th>
                <th className="text-left px-4 py-3 font-semibold text-xs">{t('common.taskStartTime')}</th>
                <th className="text-left px-4 py-3 font-semibold text-xs">{t('common.taskEndTime')}</th>
                <th className="text-center px-4 py-3 font-semibold text-xs">{t('common.status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredTasks.map((task) => (
                <tr
                  key={task.id}
                  onClick={() => handleSelectTask(task.id)}
                  className="hover:bg-muted/30 transition-colors cursor-pointer"
                >
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {task.userName || '-'}
                  </td>
                  <td className="px-4 py-3 text-xs font-medium max-w-[200px] truncate" title={task.taskName || task.id}>
                    {task.taskName || task.id.slice(0, 24)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 text-[10px] bg-muted rounded-full text-muted-foreground">
                      {meta.typeLabel}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatTime(task.startTime)}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatTime(task.endTime)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {task.status === 'completed' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-green-500/15 text-green-400 rounded-full font-medium">
                        <CheckCircle2 size={10} />
                        {t('common.taskSuccess')}
                      </span>
                    ) : task.status === 'failed' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-red-500/15 text-red-400 rounded-full font-medium">
                        <AlertCircle size={10} />
                        {t('common.taskFailed')}
                      </span>
                    ) : task.status === 'running' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-blue-500/15 text-blue-400 rounded-full font-medium">
                        <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                        {task.progress || 0}%
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
