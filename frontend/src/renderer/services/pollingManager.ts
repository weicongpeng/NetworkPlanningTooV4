/**
 * 统一轮询管理器
 * 用于管理任务状态轮询，避免重复轮询同一任务
 */

interface PollingConfig {
  taskId: string
  apiCall: () => Promise<any>
  interval: number
  onProgress: (data: any) => void
  onComplete?: (result: any) => void
  onFailed?: (error: string) => void
  maxErrors?: number
}

class PollingManager {
  private static instance: PollingManager
  private activePollings: Map<string, NodeJS.Timeout> = new Map()
  private errorCounts: Map<string, number> = new Map()

  private constructor() {}

  static getInstance(): PollingManager {
    if (!PollingManager.instance) {
      PollingManager.instance = new PollingManager()
    }
    return PollingManager.instance
  }

  /**
   * 启动轮询（同一任务ID只会启动一次）
   * @param config 轮询配置
   */
  subscribe(config: PollingConfig): void {
    const { taskId, apiCall, interval, onProgress, onComplete, onFailed, maxErrors = 5 } = config

    // 如果已经在轮询，先停止
    if (this.activePollings.has(taskId)) {
      console.warn(`[PollingManager] 任务 ${taskId} 已在轮询中，跳过重复订阅`)
      return
    }

    // 初始化错误计数
    this.errorCounts.set(taskId, 0)

    console.log(`[PollingManager] 开始轮询任务: ${taskId}, 间隔: ${interval}ms`)

    const intervalId = setInterval(async () => {
      try {
        const response = await apiCall()

        // 重置错误计数
        this.errorCounts.set(taskId, 0)

        if (response.success && response.data) {
          const data = response.data

          // 进度更新
          if (data.status === 'processing' || data.status === 'pending') {
            onProgress(data)
          }
          // 任务完成
          else if (data.status === 'completed') {
            this.unsubscribe(taskId)
            if (onComplete) {
              onComplete(data)
            }
          }
          // 任务失败
          else if (data.status === 'failed') {
            this.unsubscribe(taskId)
            const errorMsg = data.message || data.error || '任务失败'
            if (onFailed) {
              onFailed(errorMsg)
            }
          }
        } else {
          // 响应格式不正确
          console.warn(`[PollingManager] 任务 ${taskId} 响应格式异常:`, response)
        }
      } catch (err: any) {
        console.error(`[PollingManager] 任务 ${taskId} 轮询错误:`, err)

        const errorCount = (this.errorCounts.get(taskId) || 0) + 1
        this.errorCounts.set(taskId, errorCount)

        // 处理404错误（任务不存在）
        if (err?.response?.status === 404 || err?.code === 404) {
          this.unsubscribe(taskId)
          console.log(`[PollingManager] 任务 ${taskId} 不存在 (404)，停止轮询`)
          if (onFailed) {
            onFailed('任务不存在')
          }
          return
        }

        // 达到最大错误次数
        if (errorCount >= maxErrors) {
          this.unsubscribe(taskId)
          // 尝试从错误响应中提取实际错误信息
          const errorMsg = err?.response?.data?.detail || err?.response?.data?.message || err?.message || '无法连接到服务器，请检查网络连接'
          console.error(`[PollingManager] 任务 ${taskId} 达到最大错误次数 (${maxErrors})，停止轮询`)
          if (onFailed) {
            onFailed(errorMsg)
          }
        }
      }
    }, interval)

    this.activePollings.set(taskId, intervalId)
  }

  /**
   * 停止轮询
   * @param taskId 任务ID
   */
  unsubscribe(taskId: string): void {
    const intervalId = this.activePollings.get(taskId)
    if (intervalId) {
      clearInterval(intervalId)
      this.activePollings.delete(taskId)
      this.errorCounts.delete(taskId)
      console.log(`[PollingManager] 停止轮询任务: ${taskId}`)
    }
  }

  /**
   * 检查任务是否在轮询中
   * @param taskId 任务ID
   * @returns 是否在轮询中
   */
  isPolling(taskId: string): boolean {
    return this.activePollings.has(taskId)
  }

  /**
   * 停止所有轮询
   */
  unsubscribeAll(): void {
    console.log(`[PollingManager] 停止所有轮询，共 ${this.activePollings.size} 个任务`)
    for (const [taskId] of this.activePollings) {
      this.unsubscribe(taskId)
    }
  }

  /**
   * 获取当前轮询中的任务数量
   * @returns 轮询中任务数量
   */
  getActivePollingCount(): number {
    return this.activePollings.size
  }
}

export const pollingManager = PollingManager.getInstance()
export default PollingManager