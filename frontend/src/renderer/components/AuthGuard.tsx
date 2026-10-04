import { useEffect, useRef } from 'react'
import { useAuthStore } from '../store/authStore'
import { LoginModal } from './LoginModal'

interface AuthGuardProps {
  children: React.ReactNode
}

const IDLE_TIMEOUT_MS = 3 * 60 * 60 * 1000  // 3 小时无操作才校验登录态（与后端会话空闲超时一致）
const IDLE_CHECK_INTERVAL_MS = 60 * 1000  // 每 1 分钟检查一次空闲状态

export function AuthGuard({ children }: AuthGuardProps) {
  const { isAuthenticated, user } = useAuthStore()
  const lastActivityRef = useRef(Date.now())

  // 监听 401 事件（API 拦截器触发）→ 主动验证 token 并同步 store 状态
  // 后台 token 校验由 authStore persist 的 onRehydrateStorage 触发（fire-and-forget）
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
  // 仅当无操作超过 IDLE_TIMEOUT_MS（3 小时）时才验证 token / 会话是否失效
  useEffect(() => {
    if (!isAuthenticated) return
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
  }, [isAuthenticated])

  // 空闲检测定时器：每分钟检查一次，如果无操作超过 3 小时才验证 token
  useEffect(() => {
    if (!isAuthenticated) return
    const interval = setInterval(() => {
      const idleTime = Date.now() - lastActivityRef.current
      if (idleTime >= IDLE_TIMEOUT_MS) {
        useAuthStore.getState().fetchUser()
      }
    }, IDLE_CHECK_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [isAuthenticated])

  // 未认证 → 只显示登录界面，不渲染应用内容（persist 同步恢复，无需等待网络验证）
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

  // 正常应用内容（已认证 → 立即渲染，后台静默验证）
  return <>{children}</>
}
