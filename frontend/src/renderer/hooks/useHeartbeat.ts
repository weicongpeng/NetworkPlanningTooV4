import { useEffect, useRef } from 'react'
import { useAuthStore } from '../store/authStore'
import { authApi } from '../services/api'

const HEARTBEAT_INTERVAL = 4 * 60 * 1000  // 4 分钟

export function useHeartbeat() {
  const { isAuthenticated } = useAuthStore()
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const doPing = async () => {
      try {
        await authApi.ping()
      } catch {
        // ping 失败静默处理（如 token 过期）
      }
    }

    const start = () => {
      stop()
      intervalRef.current = setInterval(doPing, HEARTBEAT_INTERVAL)
      doPing()  // 立即执行一次
    }

    const stop = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    // 页面可见性变化：隐藏时暂停，恢复时重启
    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else if (isAuthenticated) {
        start()
      }
    }

    if (isAuthenticated) {
      start()
    }

    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [isAuthenticated])
}
