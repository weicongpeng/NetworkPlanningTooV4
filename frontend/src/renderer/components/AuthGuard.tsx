import { useEffect, useState, useRef } from 'react'
import { useAuthStore } from '../store/authStore'
import { LoginModal } from './LoginModal'

interface AuthGuardProps {
  children: React.ReactNode
}

const IDLE_TIMEOUT_MS = 35 * 60 * 1000  // 35 分钟无操作才退出
const IDLE_CHECK_INTERVAL_MS = 60 * 1000  // 每 1 分钟检查一次空闲状态

export function AuthGuard({ children }: AuthGuardProps) {
  const { isAuthenticated, user, fetchUser } = useAuthStore()
  const [initialized, setInitialized] = useState(false)
  const lastActivityRef = useRef(Date.now())

  // 初始化：从 localStorage 恢复后验证 token
  useEffect(() => {
    fetchUser().finally(() => setInitialized(true))
  }, [fetchUser])

  // 监听 401 事件（API 拦截器触发）→ 主动验证 token 并同步 store 状态
  useEffect(() => {
    const handler = () => {
      if (useAuthStore.getState().isAuthenticated) {
        useAuthStore.getState().fetchUser()
      }
    }
    window.addEventListener('auth:required', handler)
    return () => window.removeEventListener('auth:required', handler)
  }, [])

  // 空闲检测：用户交互时仅更新时间戳，不检查 token
  // 仅当无操作超过 IDLE_TIMEOUT_MS（35 分钟）时才验证 token 是否过期
  useEffect(() => {
    if (!initialized) return
    const handleInteraction = () => {
      lastActivityRef.current = Date.now()
    }
    window.addEventListener('click', handleInteraction, { capture: true })
    window.addEventListener('keydown', handleInteraction, { capture: true })
    window.addEventListener('mousemove', handleInteraction, { capture: true })
    window.addEventListener('wheel', handleInteraction, { capture: true })
    return () => {
      window.removeEventListener('click', handleInteraction, { capture: true })
      window.removeEventListener('keydown', handleInteraction, { capture: true })
      window.removeEventListener('mousemove', handleInteraction, { capture: true })
      window.removeEventListener('wheel', handleInteraction, { capture: true })
    }
  }, [initialized])

  // 空闲检测定时器：每分钟检查一次，如果无操作超过 35 分钟才验证 token
  useEffect(() => {
    if (!initialized || !isAuthenticated) return
    const interval = setInterval(() => {
      const idleTime = Date.now() - lastActivityRef.current
      if (idleTime >= IDLE_TIMEOUT_MS) {
        useAuthStore.getState().fetchUser()
      }
    }, IDLE_CHECK_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [initialized, isAuthenticated])

  // 加载中
  if (!initialized) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">加载中...</p>
        </div>
      </div>
    )
  }

  // 未认证 → 只显示登录界面，不渲染应用内容（用户看不到旧缓存页面）
  if (!isAuthenticated) {
    return <LoginModal isOpen={true} />
  }

  // 已认证但需修改密码 → 显示修改密码弹窗，同时保留应用内容（但交互会被弹窗阻挡）
  if (user?.must_change_password) {
    return (
      <>
        <LoginModal isOpen={true} forceChangePassword={true} />
        {children}
      </>
    )
  }

  // 正常应用内容
  return <>{children}</>
}
