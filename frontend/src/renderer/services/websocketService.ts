/**
 * WebSocket客户端服务
 * 用于实时接收任务进度推送，支持自动重连和降级到轮询
 */

interface WebSocketMessage {
  type: 'progress' | 'complete' | 'failed' | 'pong'
  taskId: string
  data?: any
  timestamp?: number
}

interface SubscribeCallback {
  (message: WebSocketMessage): void
}

class WebSocketService {
  private static instance: WebSocketService
  private ws: WebSocket | null = null
  private subscriptions: Map<string, Set<SubscribeCallback>> = new Map()
  private reconnectAttempts = 0
  private maxReconnectAttempts = 2  // 减少重连次数，更快降级到轮询
  private reconnectDelay = 3000
  private heartbeatInterval: NodeJS.Timeout | null = null
  private isConnecting = false
  private usePollingFallback = false

  // WebSocket服务器地址（通过Vite代理）
  // 使用相对路径，让Vite代理自动处理协议转换
  private readonly WS_URL = '/api/v1/ws/tasks'

  private constructor() {}

  static getInstance(): WebSocketService {
    if (!WebSocketService.instance) {
      WebSocketService.instance = new WebSocketService()
    }
    return WebSocketService.instance
  }

  /**
   * 连接WebSocket服务器
   * @returns Promise<boolean> 连接是否成功
   */
  async connect(): Promise<boolean> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return true
    }

    if (this.isConnecting) {
      // 等待连接完成
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            clearInterval(checkInterval)
            resolve(true)
          } else if (!this.isConnecting) {
            clearInterval(checkInterval)
            resolve(false)
          }
        }, 100)
      })
    }

    if (this.usePollingFallback) {
      console.log('[WebSocketService] 已启用轮询降级模式，跳过连接')
      return false
    }

    return new Promise((resolve) => {
      this.isConnecting = true
      console.log(`[WebSocketService] 正在连接到: ${this.WS_URL}`)

      try {
        // 使用相对路径，让浏览器根据当前页面协议自动选择ws/wss
        // Vite代理会正确转发
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        // 开发环境使用Vite代理，生产环境使用实际路径
        const isDev = import.meta.env.DEV
        const host = isDev ? window.location.host : window.location.host
        const wsUrl = `${protocol}//${host}${this.WS_URL}`

        console.log(`[WebSocketService] WebSocket URL: ${wsUrl}`)

        this.ws = new WebSocket(wsUrl)

        this.ws.onopen = () => {
          console.log('[WebSocketService] 连接成功')
          this.isConnecting = false
          this.reconnectAttempts = 0
          this.startHeartbeat()

          // 重新订阅所有任务
          this.resubscribeAll()

          resolve(true)
        }

        this.ws.onmessage = (event) => {
          try {
            const message: WebSocketMessage = JSON.parse(event.data)
            this.handleMessage(message)
          } catch (error) {
            console.error('[WebSocketService] 消息解析失败:', error, event.data)
          }
        }

        this.ws.onclose = (event) => {
          // 正常关闭或非用户主动断开时才记录日志
          if (event.code !== 1000) {
            console.log(`[WebSocketService] 连接关闭: code=${event.code}, reason=${event.reason}`)
          }
          this.stopHeartbeat()
          this.isConnecting = false

          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnect()
          } else {
            console.warn('[WebSocketService] 达到最大重连次数，启用轮询降级')
            this.usePollingFallback = true
          }
        }

        this.ws.onerror = (error) => {
          // 静默处理连接错误，避免控制台噪音
          this.isConnecting = false
          resolve(false)
        }
      } catch (error) {
        console.error('[WebSocketService] 连接异常:', error)
        this.isConnecting = false
        this.usePollingFallback = true
        resolve(false)
      }
    })
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.stopHeartbeat()
    this.subscriptions.clear()
    this.reconnectAttempts = 0
    this.isConnecting = false
  }

  /**
   * 订阅任务进度
   * @param taskId 任务ID
   * @param callback 回调函数
   */
  subscribeTask(taskId: string, callback: SubscribeCallback): void {
    // 添加回调
    if (!this.subscriptions.has(taskId)) {
      this.subscriptions.set(taskId, new Set())
    }
    this.subscriptions.get(taskId)!.add(callback)

    // 如果已连接，立即发送订阅消息
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendMessage({
        type: 'subscribe',
        taskId
      })
    }
  }

  /**
   * 取消订阅任务
   * @param taskId 任务ID
   */
  unsubscribeTask(taskId: string): void {
    // 移除回调
    this.subscriptions.delete(taskId)

    // 发送取消订阅消息
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendMessage({
        type: 'unsubscribe',
        taskId
      })
    }
  }

  /**
   * 启用轮询降级模式
   */
  enablePollingFallback(): void {
    console.log('[WebSocketService] 启用轮询降级模式')
    this.usePollingFallback = true
    this.disconnect()
  }

  /**
   * 禁用轮询降级模式
   */
  disablePollingFallback(): void {
    console.log('[WebSocketService] 禁用轮询降级模式')
    this.usePollingFallback = false
    this.reconnectAttempts = 0
  }

  /**
   * 发送消息到服务器
   * @param data 消息数据
   */
  private sendMessage(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  /**
   * 处理服务器消息
   * @param message 消息
   */
  private handleMessage(message: WebSocketMessage): void {
    const { taskId } = message

    // 触发该任务的所有订阅回调
    const callbacks = this.subscriptions.get(taskId)
    if (callbacks) {
      callbacks.forEach((callback) => {
        try {
          callback(message)
        } catch (error) {
          console.error('[WebSocketService] 回调执行失败:', error)
        }
      })
    }
  }

  /**
   * 重新订阅所有任务
   */
  private resubscribeAll(): void {
    for (const taskId of this.subscriptions.keys()) {
      this.sendMessage({
        type: 'subscribe',
        taskId
      })
    }
  }

  /**
   * 重新连接
   */
  private reconnect(): void {
    if (this.isConnecting) {
      return
    }

    this.reconnectAttempts++
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1) // 指数退避

    console.log(`[WebSocketService] ${delay}ms后尝试第${this.reconnectAttempts}次重连`)

    setTimeout(() => {
      if (!this.usePollingFallback) {
        this.connect()
      }
    }, delay)
  }

  /**
   * 开始心跳
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()

    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendMessage({ type: 'ping' })
      }
    }, 30000) // 每30秒发送一次心跳
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  /**
   * 获取连接状态
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /**
   * 获取是否启用轮询降级
   */
  isPollingFallback(): boolean {
    return this.usePollingFallback
  }
}

export const websocketService = WebSocketService.getInstance()
export default WebSocketService