/**
 * 网络状态指示器组件
 *
 * 设计理念：航图雷达美学
 * - 网络规划工具处理"连接"和"信号"，使用雷达风格视觉元素
 * - 状态指示器像飞机仪表盘一样清晰直观
 * - 非阻塞式设计，提供优雅的网络异常提示
 */
import { useState, useEffect, useCallback } from 'react'
import { Wifi, WifiOff, RefreshCw, X, ChevronDown, ChevronUp, AlertCircle, Activity } from 'lucide-react'

/**
 * 网络状态类型
 */
type NetworkStatus = 'online' | 'offline' | 'degraded' | 'checking'

/**
 * 网络诊断信息
 */
interface NetworkDiagnostics {
  backendAvailable: boolean
  mapServiceAvailable: boolean
  latency: number | null
  lastCheckTime: Date
  errorDetails: string[]
}

/**
 * 组件属性
 */
interface NetworkStatusIndicatorProps {
  /** 后端健康检查URL */
  healthCheckUrl?: string
  /** 检查间隔（毫秒） */
  checkInterval?: number
  /** 是否显示详细信息 */
  showDetails?: boolean
  /** 状态变化回调 */
  onStatusChange?: (status: NetworkStatus) => void
}

/**
 * 网络状态指示器组件
 */
export const NetworkStatusIndicator = ({
  healthCheckUrl = '/api/v1/health',
  checkInterval = 30000,
  showDetails: initialShowDetails = false,
  onStatusChange
}: NetworkStatusIndicatorProps) => {
  const [status, setStatus] = useState<NetworkStatus>('checking')
  const [showDetails, setShowDetails] = useState(initialShowDetails)
  const [isRetrying, setIsRetrying] = useState(false)
  const [diagnostics, setDiagnostics] = useState<NetworkDiagnostics>({
    backendAvailable: false,
    mapServiceAvailable: false,
    latency: null,
    lastCheckTime: new Date(),
    errorDetails: []
  })

  /**
   * 检查网络连接
   */
  const checkNetwork = useCallback(async (isRetry = false) => {
    if (isRetry) {
      setIsRetrying(true)
    }

    const startTime = performance.now()
    const newDiagnostics: NetworkDiagnostics = {
      backendAvailable: false,
      mapServiceAvailable: false,
      latency: null,
      lastCheckTime: new Date(),
      errorDetails: []
    }

    try {
      // 检查后端健康状态
      const healthResponse = await fetch(healthCheckUrl, {
        method: 'GET',
        cache: 'no-store'
      }).catch(() => null)

      const endTime = performance.now()
      newDiagnostics.latency = Math.round(endTime - startTime)

      if (healthResponse?.ok) {
        newDiagnostics.backendAvailable = true

        // 尝试检查地图数据API
        try {
          const mapResponse = await fetch('/api/v1/map/data', {
            method: 'GET',
            cache: 'no-store'
          }).catch(() => null)
          newDiagnostics.mapServiceAvailable = mapResponse?.ok || false
        } catch (e) {
          newDiagnostics.mapServiceAvailable = false
          newDiagnostics.errorDetails.push('地图服务不可用')
        }

        // 判断网络状态
        if (newDiagnostics.mapServiceAvailable) {
          setStatus('online')
        } else {
          setStatus('degraded')
          newDiagnostics.errorDetails.push('后端正常，但地图数据加载失败')
        }
      } else {
        setStatus('offline')
        newDiagnostics.errorDetails.push('后端服务未响应')
      }
    } catch (error) {
      setStatus('offline')
      newDiagnostics.errorDetails.push(`网络连接失败: ${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setDiagnostics(newDiagnostics)
      setIsRetrying(false)
    }
  }, [healthCheckUrl])

  /**
   * 手动重试
   */
  const handleRetry = useCallback(() => {
    setStatus('checking')
    checkNetwork(true)
  }, [checkNetwork])

  /**
   * 切换详情显示
   */
  const toggleDetails = useCallback(() => {
    setShowDetails(prev => !prev)
  }, [])

  /**
   * 定期检查网络状态
   */
  useEffect(() => {
    // 初始检查
    checkNetwork()

    const interval = setInterval(() => {
      checkNetwork()
    }, checkInterval)

    return () => clearInterval(interval)
  }, [checkNetwork, checkInterval])

  /**
   * 状态变化通知
   */
  useEffect(() => {
    onStatusChange?.(status)
  }, [status, onStatusChange])

  /**
   * 渲染状态图标
   */
  const renderStatusIcon = () => {
    const iconClassName = 'w-4 h-4'

    switch (status) {
      case 'online':
        return <Wifi className={iconClassName} />
      case 'offline':
        return <WifiOff className={iconClassName} />
      case 'degraded':
        return <AlertCircle className={iconClassName} />
      case 'checking':
      default:
        return <Activity className={`${iconClassName} animate-pulse`} />
    }
  }

  /**
   * 获取状态颜色
   */
  const getStatusColor = () => {
    switch (status) {
      case 'online':
        return 'text-emerald-400'
      case 'offline':
        return 'text-rose-400'
      case 'degraded':
        return 'text-amber-400'
      case 'checking':
      default:
        return 'text-blue-400'
    }
  }

  /**
   * 获取状态文本
   */
  const getStatusText = () => {
    switch (status) {
      case 'online':
        return '网络正常'
      case 'offline':
        return '网络离线'
      case 'degraded':
        return '服务受限'
      case 'checking':
      default:
        return '检测中...'
    }
  }

  /**
   * 获取延迟显示
   */
  const getLatencyDisplay = () => {
    if (diagnostics.latency === null) return '--'
    if (diagnostics.latency < 100) return `${diagnostics.latency}ms`
    return `${diagnostics.latency}ms`
  }

  return (
    <div className="fixed top-4 right-4 z-[9999] min-w-[200px]">
      {/* 主状态指示器 */}
      <div
        className={`
          relative overflow-hidden rounded-lg border backdrop-blur-md
          transition-all duration-300 ease-out
          ${status === 'offline' ? 'border-rose-500/50 bg-rose-950/80 shadow-lg shadow-rose-500/20' :
            status === 'degraded' ? 'border-amber-500/50 bg-amber-950/80 shadow-lg shadow-amber-500/20' :
            status === 'checking' ? 'border-blue-500/50 bg-blue-950/80 shadow-lg shadow-blue-500/20' :
            'border-emerald-500/30 bg-emerald-950/60 shadow-md'
          }
        `}
      >
        {/* 雷达扫描效果（仅在离线或降级时显示） */}
        {(status === 'offline' || status === 'degraded') && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute inset-0 animate-[radar-sweep_2s_linear_infinite]">
              <div className="absolute top-1/2 left-0 w-1/2 h-[1px] bg-gradient-to-r from-transparent via-rose-500/30 to-transparent" />
              <div className="absolute top-1/2 left-0 w-1/2 h-1/2 bg-gradient-to-t from-rose-500/5 to-transparent" />
            </div>
          </div>
        )}

        {/* 状态栏 */}
        <div
          className={`
            relative flex items-center justify-between px-4 py-3 cursor-pointer
            hover:brightness-110 active:brightness-95
          `}
          onClick={toggleDetails}
        >
          <div className="flex items-center gap-3">
            <div className={`${getStatusColor()} transition-colors duration-300`}>
              {renderStatusIcon()}
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-medium text-white/90">
                {getStatusText()}
              </span>
              {diagnostics.latency !== null && status === 'online' && (
                <span className="text-xs text-white/50">
                  延迟 {getLatencyDisplay()}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {(status === 'offline' || status === 'degraded') && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleRetry()
                }}
                className={`
                  p-1.5 rounded-md transition-all duration-200
                  ${isRetrying ? 'animate-spin' : 'hover:bg-white/10 active:bg-white/20'}
                  text-white/70 hover:text-white
                `}
                disabled={isRetrying}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              className={`
                p-1 rounded-md transition-all duration-200
                text-white/50 hover:text-white/80 hover:bg-white/10
              `}
            >
              {showDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* 详细信息面板 */}
        {showDetails && (
          <div className="border-t border-white/10 px-4 py-3 space-y-2">
            {/* 服务状态 */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${diagnostics.backendAvailable ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                <span className="text-white/70">后端服务</span>
              </div>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${diagnostics.mapServiceAvailable ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                <span className="text-white/70">地图服务</span>
              </div>
            </div>

            {/* 错误详情 */}
            {diagnostics.errorDetails.length > 0 && (
              <div className="mt-2 p-2 rounded bg-white/5 border border-white/10">
                <div className="text-xs text-white/50 mb-1">错误详情</div>
                {diagnostics.errorDetails.map((error, index) => (
                  <div key={index} className="text-xs text-rose-300/90">
                    • {error}
                  </div>
                ))}
              </div>
            )}

            {/* 最后检查时间 */}
            <div className="text-xs text-white/40">
              最后检查: {diagnostics.lastCheckTime.toLocaleTimeString()}
            </div>
          </div>
        )}
      </div>

      {/* 离线状态下的额外提示条 */}
      {status === 'offline' && (
        <div className="mt-2 px-4 py-2 rounded-lg bg-rose-950/80 border border-rose-500/30 backdrop-blur-sm">
          <div className="flex items-start gap-2 text-xs text-rose-200/90">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-medium mb-1">网络连接异常</div>
              <div className="text-rose-300/70">
                请检查：后端服务是否启动 · 网络连接是否正常 · 防火墙设置
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 用于地图页面的简化网络状态指示器
 * 仅在出现问题时显示
 */
interface NetworkStatusAlertProps {
  /** 是否可见 */
  visible?: boolean
  /** 错误消息 */
  message?: string
  /** 重试回调 */
  onRetry?: () => void
  /** 关闭回调 */
  onDismiss?: () => void
}

export const NetworkStatusAlert = ({
  visible = true,
  message = '网络连接异常，地图数据加载失败',
  onRetry,
  onDismiss
}: NetworkStatusAlertProps) => {
  if (!visible) {
    return null
  }

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999]">
      <div className="relative overflow-hidden rounded-xl border border-rose-500/30 bg-rose-950/95 backdrop-blur-md shadow-2xl shadow-rose-500/20 px-6 py-4">
        {/* 雷达扫描效果 */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl">
          <div className="absolute inset-0 animate-[radar-sweep_2s_linear_infinite]">
            <div className="absolute top-1/2 left-0 w-1/2 h-[1px] bg-gradient-to-r from-transparent via-rose-500/20 to-transparent" />
          </div>
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(239,68,68,0.1),transparent_70%)] animate-pulse" />
        </div>

        {/* 内容 */}
        <div className="relative flex items-center gap-4">
          <div className="p-2 rounded-lg bg-rose-500/20">
            <WifiOff className="w-5 h-5 text-rose-400" />
          </div>

          <div className="flex-1">
            <div className="text-sm font-medium text-white">网络连接异常</div>
            <div className="text-xs text-rose-300/80 mt-1">{message}</div>
          </div>

          <div className="flex items-center gap-2">
            {onRetry && (
              <button
                onClick={onRetry}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 transition-colors duration-200 flex items-center gap-2"
              >
                <RefreshCw className="w-3 h-3" />
                重试
              </button>
            )}
            {onDismiss && (
              <button
                onClick={onDismiss}
                className="p-2 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors duration-200"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default NetworkStatusIndicator
