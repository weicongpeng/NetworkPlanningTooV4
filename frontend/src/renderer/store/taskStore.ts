import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { pciApi, neighborApi, tacApi, tacPlanningApi } from '../services/api'

/**
 * 全局任务状态管理
 * 用于跨页面保持任务状态，解决切换窗口后状态丢失的问题
 */

// 模块级轮询定时器（独立于组件生命周期，页面切换不中断）
const pollingIntervals: Record<string, any> = {}

// 初始化 WebSocket 任务删除事件监听（全局一次）
let _wsTaskDeleteInitialized = false
function _initWsTaskDeleteListener() {
  if (_wsTaskDeleteInitialized) return
  _wsTaskDeleteInitialized = true

  // 延迟导入避免循环依赖
  import('../services/websocketService').then(({ websocketService }) => {
    websocketService.onGlobalMessage((message) => {
      if (message.type === 'task_deleted' && message.taskId) {
        const taskId = message.taskId
        useTaskStore.getState().clearTask(taskId)
        console.log(`[taskStore] WebSocket 删除事件: 已移除任务 ${taskId.slice(0, 8)}...`)
      }
    })
    // 尝试连接 WebSocket（用于接收广播事件）
    websocketService.connect().then((connected) => {
      if (connected) {
        console.log('[taskStore] WebSocket 已连接，实时任务事件已启用')
      }
    })
  }).catch(() => {
    // WebSocket 服务导入失败，静默忽略（降级到轮询模式）
  })
}

// 在模块加载时初始化
_initWsTaskDeleteListener()


export type TaskType = 'parameter_update' | 'pci_planning' | 'neighbor_planning' | 'tac_check' | 'tac_planning' | 'upload'
export type TaskStatus = 'idle' | 'running' | 'completed' | 'failed'

export interface Task {
  id: string
  type: TaskType
  status: TaskStatus
  taskName?: string
  userName?: string
  isApplied?: boolean
  message?: string
  progress?: number
  startTime?: number
  endTime?: number
  result?: any
}

interface TaskState {
  tasks: Record<string, Task>
  activeTaskIds: Record<TaskType, string | null> // 记录每个模块当前活跃的任务ID

  // 获取所有运行中的任务
  getRunningTasks: () => Task[]

  // 开始任务
  startTask: (id: string, type: TaskType, message?: string, taskName?: string, userName?: string) => void

  // 更新任务进度
  updateTaskProgress: (id: string, progress: number, message?: string) => void

  // 完成任务
  completeTask: (id: string, result?: any) => void

  // 任务失败
  failTask: (id: string, message: string) => void

  // 获取任务状态
  getTaskStatus: (id: string) => TaskStatus

  // 获取任务
  getTask: (id: string) => Task | undefined

  // 清除任务
  clearTask: (id: string) => void

  // 清除所有已完成/失败的任务
  clearFinishedTasks: () => void

  // 获取最新的PCI规划任务结果
  getLatestPCITask: () => Task | undefined

  // 获取最新的邻区规划任务结果
  getLatestNeighborTask: () => Task | undefined

  // 获取最新的TAC核查任务结果
  getLatestTACCheckTask: () => Task | undefined
  // 设置模块活跃任务ID
  setActiveTaskId: (type: TaskType, id: string | null) => void

  // 从后端同步历史任务到本地 store
  syncHistoryFromBackend: (type: TaskType) => Promise<void>

  // 删除历史任务（后端 + 本地）
  deleteHistoryTask: (taskId: string, type: TaskType) => Promise<boolean>

  // === 全局轮询（跨页面持久） ===
  startGlobalPolling: (type: TaskType) => void
  stopGlobalPolling: (type: TaskType) => void
  isGlobalPollingActive: (type: TaskType) => boolean
}

// 带配额错误处理的 storage 适配器
const safeStorage = {
  getItem: (name: string) => {
    try {
      return localStorage.getItem(name)
    } catch {
      return null
    }
  },
  setItem: (name: string, value: string) => {
    try {
      localStorage.setItem(name, value)
    } catch (e: any) {
      console.warn(`[taskStore] localStorage 写入失败 (${e?.name || 'unknown'})，已降级为仅内存存储`)
      // 写入失败时尝试清理旧数据重试一次
      if (e?.name === 'QuotaExceededError' || e?.code === 22) {
        try {
          // 尝试删除当前 key 后重新设置（清空旧数据重新开始）
          localStorage.removeItem(name)
          localStorage.setItem(name, value)
        } catch {
          // 二次重试也失败，静默降级
        }
      }
    }
  },
  removeItem: (name: string) => {
    try {
      localStorage.removeItem(name)
    } catch {
      // 静默忽略
    }
  }
}

export const useTaskStore = create<TaskState>()(
  persist(
    (set, get) => ({
      tasks: {},
      activeTaskIds: {
        parameter_update: null,
        pci_planning: null,
        neighbor_planning: null,
        tac_check: null,
        tac_planning: null,
        upload: null
      },

      getRunningTasks: () => {
        const state = get()
        return Object.values(state.tasks).filter(task => task.status === 'running')
      },

      startTask: (id, type, message, taskName?, userName?) => {
        set(state => {
          // 限制内存中最多保留200个任务，避免无限制增长
          const entries = Object.entries(state.tasks)
          if (entries.length >= 200) {
            const sorted = entries.sort(([, a], [, b]) => {
              const aTime = a.endTime || a.startTime || 0
              const bTime = b.endTime || b.startTime || 0
              return bTime - aTime
            })
            const kept = sorted.slice(0, 199)
            return {
              tasks: {
                ...Object.fromEntries(kept),
                [id]: {
                  id, type, status: 'running' as const,
                  message, progress: 0, startTime: Date.now(),
                  ...(taskName && { taskName }),
                  ...(userName && { userName })
                }
              }
            }
          }
          return {
            tasks: {
              ...state.tasks,
              [id]: {
                id, type, status: 'running' as const,
                message, progress: 0, startTime: Date.now(),
                ...(taskName && { taskName }),
                ...(userName && { userName })
              }
            }
          }
        })
      },

      updateTaskProgress: (id, progress, message) => {
        set(state => {
          const task = state.tasks[id]
          if (!task) return state

          return {
            tasks: {
              ...state.tasks,
              [id]: {
                ...task,
                progress,
                ...(message && { message })
              }
            }
          }
        })
      },

      completeTask: (id, result) => {
        set(state => {
          const task = state.tasks[id]
          if (!task) return state

          return {
            tasks: {
              ...state.tasks,
              [id]: {
                ...task,
                status: 'completed',
                progress: 100,
                endTime: Date.now(),
                result
              }
            }
          }
        })
      },

      failTask: (id, message) => {
        set(state => {
          const task = state.tasks[id]
          if (!task) return state

          return {
            tasks: {
              ...state.tasks,
              [id]: {
                ...task,
                status: 'failed',
                message,
                endTime: Date.now()
              }
            }
          }
        })
      },

      getTaskStatus: (id) => {
        const task = get().tasks[id]
        return task?.status || 'idle'
      },

      getTask: (id) => {
        return get().tasks[id]
      },

      clearTask: (id) => {
        set(state => {
          const newTasks = { ...state.tasks }
          delete newTasks[id]
          return { tasks: newTasks }
        })
      },

      clearFinishedTasks: () => {
        set(state => {
          const newTasks: Record<string, Task> = {};
          for (const [id, task] of Object.entries(state.tasks)) {
            if (task.status === 'running') {
              newTasks[id] = task;
            }
          }
          return { tasks: newTasks };
        });
      },

      getLatestPCITask: () => {
        const state = get();
        // 获取所有PCI规划任务
        const pciTasks = Object.values(state.tasks)
          .filter(task => task.type === 'pci_planning');

        // 按结束时间降序排序，获取最新的任务
        const sortedTasks = pciTasks.sort((a, b) => {
          const endTimeA = a.endTime || a.startTime || 0;
          const endTimeB = b.endTime || b.startTime || 0;
          return endTimeB - endTimeA;
        });

        return sortedTasks.length > 0 ? sortedTasks[0] : undefined;
      },

      getLatestNeighborTask: () => {
        const state = get();
        // 获取所有邻区规划任务
        const neighborTasks = Object.values(state.tasks)
          .filter(task => task.type === 'neighbor_planning');

        // 按结束时间降序排序，获取最新的任务
        const sortedTasks = neighborTasks.sort((a, b) => {
          const endTimeA = a.endTime || a.startTime || 0;
          const endTimeB = b.endTime || b.startTime || 0;
          return endTimeB - endTimeA;
        });

        return sortedTasks.length > 0 ? sortedTasks[0] : undefined;
      },

      getLatestTACCheckTask: () => {
        const state = get();
        const tacTasks = Object.values(state.tasks)
          .filter(task => task.type === 'tac_check');
        const sortedTasks = tacTasks.sort((a, b) => {
          const endTimeA = a.endTime || a.startTime || 0;
          const endTimeB = b.endTime || b.startTime || 0;
          return endTimeB - endTimeA;
        });
        return sortedTasks.length > 0 ? sortedTasks[0] : undefined;
      },

      setActiveTaskId: (type, id) => {
        set(state => ({
          activeTaskIds: {
            ...state.activeTaskIds,
            [type]: id
          }
        }))
      },

      syncHistoryFromBackend: async (type) => {
        try {
          let response: any
          switch (type) {
            case 'pci_planning':
              response = await pciApi.getHistory()
              break
            case 'neighbor_planning':
              response = await neighborApi.getHistory()
              break
            case 'tac_check':
              response = await tacApi.getHistory()
              break
            case 'tac_planning':
              response = await tacPlanningApi.getHistory()
              break
            default:
              return
          }

          const historyTasks = response?.data
          if (!Array.isArray(historyTasks)) return

          // 🔍 诊断日志：打印从后端接收的原始数据
          console.log(`[taskStore.syncHistoryFromBackend] type=${type} count=${historyTasks.length}`)
          historyTasks.slice(0, 5).forEach((ht: any) => {
            console.log(`  taskId=${ht.taskId?.slice(0,12)}... taskName=${ht.taskName} resultSummary=`, ht.resultSummary)
          })

          set(state => {
            const merged: Record<string, any> = {}

            // 保留其他类型的任务、运行中的同类型任务、以及已有完整 results 的历史任务
            for (const [id, task] of Object.entries(state.tasks)) {
              if (task.type !== type || task.status === 'running' || (task.result && task.result.results)) {
                merged[id] = task
              }
            }

            // 合并后端返回的历史任务
            for (const ht of historyTasks) {
              const id = ht.taskId
              if (!id) continue
              // ⚠️ result 严格区分：
              //   - 运行中的任务或已有完整 results 的任务 → 保留原有 result
              //   - 其他历史任务 → 只使用后端返回的 resultSummary（不含 results 数组）
              const preserved = merged[id]
              // 如果已有完整的 results，优先保留（不被 resultSummary 覆盖）
              const taskResult = (preserved?.result?.results ? preserved.result : (ht.resultSummary || undefined))
              merged[id] = {
                id,
                type,
                status: ht.status === 'completed' ? 'completed' as const : 'failed' as const,
                taskName: ht.taskName || preserved?.taskName || id.slice(0, 24),
                userName: ht.userName || preserved?.userName,
                isApplied: ht.isApplied === true || preserved?.isApplied === true,
                progress: preserved?.progress ?? (ht.progress ?? (ht.status === 'completed' ? 100 : 0)),
                startTime: preserved?.startTime || (ht.createdAt ? new Date(ht.createdAt).getTime() : undefined),
                endTime: preserved?.endTime || (ht.completedAt ? new Date(ht.completedAt).getTime() : undefined),
                result: taskResult,
              }
            }
            // 🔍 诊断日志：验证 merge 结果
            console.log(`[taskStore.syncHistoryFromBackend] merge done, tasks count=${Object.keys(merged).length}`)
            Object.entries(merged).slice(0, 5).forEach(([id, t]: [string, any]) => {
              console.log(`  merged[${id.slice(0,12)}...] type=${t.type} name=${t.taskName} result.totalSites=${t.result?.totalSites} result.totalSectors=${t.result?.totalSectors}`)
            })

            return { tasks: merged }
          })
        } catch (err) {
          console.warn(`[taskStore] 同步 ${type} 历史任务失败:`, err)
        }
      },

      deleteHistoryTask: async (taskId, type) => {
        try {
          let response: any
          switch (type) {
            case 'pci_planning':
              response = await pciApi.deleteHistory(taskId)
              break
            case 'neighbor_planning':
              response = await neighborApi.deleteHistory(taskId)
              break
            case 'tac_check':
              response = await tacApi.deleteHistory(taskId)
              break
            case 'tac_planning':
              response = await tacPlanningApi.deleteHistory(taskId)
              break
            default:
              console.warn(`[taskStore] 不支持的删除类型: ${type}`)
              return false
          }

          if (response?.success) {
            set(state => {
              const newTasks = { ...state.tasks }
              delete newTasks[taskId]
              return { tasks: newTasks }
            })
            return true
          }
          return false
        } catch (err) {
          console.warn(`[taskStore] 删除 ${type} 历史任务失败:`, err)
          return false
        }
      },

      // === 全局轮询（跨页面持久，页面切换不中断） ===
      startGlobalPolling: (type) => {
        if (pollingIntervals[type]) return
        const poll = async () => {
          const state = get()
          const taskId = state.activeTaskIds[type]
          if (!taskId) { get().stopGlobalPolling(type); return }
          try {
            let response: any
            switch (type) {
              case 'pci_planning': response = await pciApi.getProgress(taskId); break
              case 'neighbor_planning': response = await neighborApi.getProgress(taskId); break
              case 'tac_check': response = await tacApi.getProgress(taskId); break
              case 'tac_planning': response = await tacPlanningApi.getProgress(taskId); break
              default: return
            }
            if (response?.success && response?.data) {
              const data = response.data
              get().updateTaskProgress(taskId, data.progress ?? 0, data.status)
              if (data.status === 'completed') {
                get().completeTask(taskId, data.result || data)
                get().stopGlobalPolling(type)
              } else if (data.status === 'failed') {
                get().failTask(taskId, data.error || data.message || '任务执行失败')
                get().stopGlobalPolling(type)
              }
            }
          } catch (err: any) {
            // 404: 任务不存在 → 停止轮询
            if (err?.code === 404) {
              get().stopGlobalPolling(type)
              const tid = get().activeTaskIds[type]
              if (tid) { get().failTask(tid, '任务不存在'); get().setActiveTaskId(type, null) }
              return
            }
            // 🔥 其他错误（JSON解析失败、网络错误等）：记录到控制台，继续轮询
            // 如果连续失败5次（10秒），标记为失败并停止轮询，避免永久转圈
            const errorKey = `_pollError_${type}`
            const prevErrors = (pollingIntervals as any)[errorKey] || 0
            const newErrors = prevErrors + 1
            ;(pollingIntervals as any)[errorKey] = newErrors
            if (newErrors >= 5) {
              console.error(`[taskStore] ${type} 轮询连续失败${newErrors}次，标记为失败:`, err?.message || err)
              get().stopGlobalPolling(type)
              const tid = get().activeTaskIds[type]
              if (tid) {
                get().failTask(tid, `任务状态查询失败（连续${newErrors}次）: ${err?.message || '未知错误'}`)
                get().setActiveTaskId(type, null)
              }
              delete (pollingIntervals as any)[errorKey]
            }
          }
        }
        poll()
        pollingIntervals[type] = setInterval(poll, 2000) as unknown as NodeJS.Timeout
      },

      stopGlobalPolling: (type) => {
        if (pollingIntervals[type]) { clearInterval(pollingIntervals[type]); delete pollingIntervals[type] }
      },

      isGlobalPollingActive: (type) => {
        return !!pollingIntervals[type]
      },
    }),
    {
      name: 'global-task-store',
      storage: safeStorage,
      // 只保留最近50个任务，并排除result字段，避免localStorage配额超限
      partialize: (state) => {
        const entries = Object.entries(state.tasks)
        // 按最后更新时间排序，取最近50条
        const sorted = entries.sort(([, a], [, b]) => {
          const aTime = a.endTime || a.startTime || 0
          const bTime = b.endTime || b.startTime || 0
          return bTime - aTime
        })
        const limited = sorted.slice(0, 50)
        return {
          tasks: Object.fromEntries(
            limited.map(([id, task]) => [
              id,
              { ...task, result: undefined }
            ])
          ),
          activeTaskIds: state.activeTaskIds
        }
      }
    }
  )
)
