import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { pciApi, pciCheckApi, neighborApi, tacApi, tacPlanningApi } from '../services/api'

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


export type TaskType = 'parameter_update' | 'pci_planning' | 'neighbor_planning' | 'tac_check' | 'tac_planning' | 'pci_check' | 'upload'
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
  /** 各模块历史任务真实总数（来自后端 COUNT，不受本地 store 缓存条数限制） */
  historyCounts: Record<TaskType, number>

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
  // 获取最新的PCI核查任务结果
  getLatestPCICheckTask: () => Task | undefined
  // 设置模块活跃任务ID
  setActiveTaskId: (type: TaskType, id: string | null) => void

  // 从后端同步历史任务到本地 store（支持分页，返回分页信息与当前页 ID）
  syncHistoryFromBackend: (type: TaskType, page?: number, pageSize?: number) => Promise<{ total: number; page: number; page_size: number; taskIds: string[] } | undefined>

  // 标记任务为已应用（本地状态同步，不依赖后端刷新）
  markTaskApplied: (taskId: string) => void

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
        pci_check: null,
        upload: null
      },
      historyCounts: {
        parameter_update: 0,
        pci_planning: 0,
        neighbor_planning: 0,
        tac_check: 0,
        tac_planning: 0,
        pci_check: 0,
        upload: 0
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
          // 进度轮询只带轻量摘要：与已有 result 合并，避免把 totals / 完整结果覆盖掉
          const mergedResult = task.result && typeof task.result === 'object'
            ? { ...task.result, ...(result && typeof result === 'object' ? result : {}) }
            : result
          return {
            tasks: {
              ...state.tasks,
              [id]: {
                ...task,
                status: 'completed',
                progress: 100,
                endTime: Date.now(),
                result: mergedResult
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
          // WebSocket 删除事件也需清除 activeTaskIds 中的引用
          const newActiveTaskIds = { ...state.activeTaskIds }
          for (const [type, activeId] of Object.entries(state.activeTaskIds)) {
            if (activeId === id) {
              newActiveTaskIds[type as TaskType] = null
            }
          }
          return { tasks: newTasks, activeTaskIds: newActiveTaskIds }
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

      getLatestPCICheckTask: () => {
        const state = get();
        const pciCheckTasks = Object.values(state.tasks)
          .filter(task => task.type === 'pci_check');
        const sortedTasks = pciCheckTasks.sort((a, b) => {
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

      syncHistoryFromBackend: async (type, page = 1, pageSize = 20): Promise<{ total: number; page: number; page_size: number; taskIds: string[] } | undefined> => {
        try {
          let response: any
          switch (type) {
            case 'pci_planning':
              response = await pciApi.getHistory(page, pageSize)
              break
            case 'neighbor_planning':
              response = await neighborApi.getHistory(page, pageSize)
              break
            case 'tac_check':
              response = await tacApi.getHistory(page, pageSize)
              break
            case 'tac_planning':
              response = await tacPlanningApi.getHistory(page, pageSize)
              break
            case 'pci_check':
              response = await pciCheckApi.getHistory(page, pageSize)
              break
            default:
              return
          }

          const data = response?.data
          const historyTasks = data?.tasks
          const historyTotal = typeof data?.total === 'number' ? data.total : (Array.isArray(historyTasks) ? historyTasks.length : 0)
          if (!Array.isArray(historyTasks)) return { total: historyTotal, page, page_size: pageSize, taskIds: [] }
          const taskIds = historyTasks.map((ht: any) => ht.taskId).filter(Boolean)

          set(state => {
            const merged: Record<string, any> = {}

            // 保留其他类型的任务、运行中的同类型任务、以及已有完整 results 的历史任务
            for (const [id, task] of Object.entries(state.tasks)) {
              if (task.type !== type || task.status === 'running' || (task.result && task.result.results)) {
                merged[id] = task
              }
            }

            // 跨端删除：同组其他端删掉的历史记录，本机缓存要同步移除。
            // 列表按创建时间倒序分页，"比本页最早一条更新、却不在本页响应里"的任务
            // 只可能已被删除（否则必然排在本页内），可从本地安全剔除。
            // 运行中/正在查看（activeTaskIds）的任务保留，避免打断进行中的流程。
            const responseIds = new Set<string>(
              historyTasks.map((ht: any) => ht.taskId).filter(Boolean)
            )
            let boundaryTime: number | null = null
            for (const ht of historyTasks) {
              if (!ht?.createdAt) continue
              const t = new Date(ht.createdAt).getTime()
              if (!Number.isNaN(t) && (boundaryTime === null || t < boundaryTime)) boundaryTime = t
            }
            if (boundaryTime !== null) {
              const activeId = state.activeTaskIds?.[type] ?? null
              for (const [id, task] of Object.entries(merged)) {
                if (task.type !== type || responseIds.has(id)) continue
                if (task.status === 'running' || id === activeId) continue
                if (typeof task.startTime === 'number' && task.startTime >= boundaryTime) {
                  delete merged[id]
                }
              }
            }

            // 合并后端返回的历史任务
            for (const ht of historyTasks) {
              const id = ht.taskId
              if (!id) continue
              // 🔥 性能优化：后端历史列表不再返回完整 result（含 results 数组），
              // 只返回轻量 resultSummary。本地已有完整结果的任务保留完整结果，
              // 否则回退到摘要；前端"查看"时通过 /result/{taskId} 按需获取完整结果
              const preserved = merged[id]
              let taskResult
              if (preserved?.result?.results) {
                taskResult = preserved.result // 已有完整结果，保留
              } else {
                taskResult = ht.resultSummary || undefined  // 回退到摘要
              }
              merged[id] = {
                id,
                type,
                status: ht.status === 'completed' ? 'completed' as const : 'failed' as const,
                taskName: ht.taskName || preserved?.taskName || id.slice(0, 24),
                userName: ht.userName || preserved?.userName,
                isApplied: ht.isApplied === true,
                progress: preserved?.progress ?? (ht.progress ?? (ht.status === 'completed' ? 100 : 0)),
                startTime: preserved?.startTime || (ht.createdAt ? new Date(ht.createdAt).getTime() : undefined),
                endTime: preserved?.endTime || (ht.completedAt ? new Date(ht.completedAt).getTime() : undefined),
                result: taskResult,
              }
            }

            return {
              tasks: merged,
              historyCounts: {
                ...state.historyCounts,
                [type]: historyTotal
              }
            }
          })
          // 🔥 分页：返回后端的分页信息（供 HistoryTable 翻页栏显示）
          return { total: historyTotal, page: data?.page ?? page, page_size: data?.page_size ?? pageSize, taskIds }
        } catch (err) {
          console.warn(`[taskStore] 同步 ${type} 历史任务失败:`, err)
          return { total: 0, page, page_size: pageSize, taskIds: [] }
        }
      },

      markTaskApplied: (taskId) => {
        set(state => {
          const task = state.tasks[taskId]
          if (!task) {
            console.warn(`[taskStore] 标记已应用失败：任务 ${taskId.slice(0, 8)}... 不存在`)
            return state
          }
          return {
            tasks: {
              ...state.tasks,
              [taskId]: { ...task, isApplied: true }
            }
          }
        })
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
            case 'pci_check':
              response = await pciCheckApi.deleteHistory(taskId)
              break
            default:
              console.warn(`[taskStore] 不支持的删除类型: ${type}`)
              return false
          }

          if (response?.success) {
            set(state => {
              const newTasks = { ...state.tasks }
              delete newTasks[taskId]
              // 删除任务时同步清除 activeTaskIds 中的引用（各规划页据此判断"进行中"）
              const newActiveTaskIds = { ...state.activeTaskIds }
              if (state.activeTaskIds[type] === taskId) {
                newActiveTaskIds[type] = null
              }
              // 删除成功后同步递减历史任务计数（保持 badge 与后端一致）
              const newCount = Math.max(0, (state.historyCounts[type] || 0) - 1)
              return {
                tasks: newTasks,
                activeTaskIds: newActiveTaskIds,
                historyCounts: { ...state.historyCounts, [type]: newCount }
              }
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
              case 'pci_check': response = await pciCheckApi.getProgress(taskId); break
              default: get().stopGlobalPolling(type); return
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
          } finally {
            // 串行轮询：上次请求返回后再排下一次，慢请求（大结果）不会叠加并发
            if (pollingIntervals[type]) {
              pollingIntervals[type] = setTimeout(poll, 2000) as unknown as NodeJS.Timeout
            }
          }
        }
        pollingIntervals[type] = setTimeout(poll, 0) as unknown as NodeJS.Timeout
      },

      stopGlobalPolling: (type) => {
        if (pollingIntervals[type]) { clearTimeout(pollingIntervals[type]); delete pollingIntervals[type] }
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
          activeTaskIds: state.activeTaskIds,
          historyCounts: state.historyCounts
        }
      }
    }
  )
)
