import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../store/authStore'
import { useToastStore } from '../store/toastStore'
import { LoginModal } from './LoginModal'
import { LoadingSpinner } from './LoadingSpinner'
import { DesktopAuthPendingDialog } from './DesktopAuthPendingDialog'

interface AuthGuardProps {
  children: React.ReactNode
}

const IDLE_TIMEOUT_MS = 3 * 60 * 60 * 1000  // 3 小时无操作才校验登录态（与后端会话空闲超时一致）
const IDLE_CHECK_INTERVAL_MS = 60 * 1000  // 每 1 分钟检查一次空闲状态

export function AuthGuard({ children }: AuthGuardProps) {
  const { t } = useTranslation()
  const { isAuthenticated, user } = useAuthStore()
  const desktopProbed = useAuthStore((s) => s.desktopProbed)
  const token = useAuthStore((s) => s.token)
  const lastActivityRef = useRef(Date.now())

  // 运行形态探测：桌面版（NPT_DESKTOP=1）由 /system/info 公开字段判定
  useEffect(() => {
    useAuthStore.getState().probeDesktopMode()
  }, [])

  // 登录后给 WebSocket 补鉴权：服务器据此把连接归入数据组，
  // 同组任何端（桌面端/网页端）写入数据都会即时推送 data_changed 给本页
  useEffect(() => {
    if (!isAuthenticated || !token) return
    import('../services/websocketService').then(({ websocketService }) => {
      websocketService.authenticate(token)
    }).catch(() => {
      // WS 不可用：静默降级（各页面仍有页面可见时刷新等兜底）
    })
  }, [isAuthenticated, token])

  // 监听 401 事件（API 拦截器触发）→ 主动验证 token 并同步 store 状态
  // 后台 token 校验由 authStore persist 的 onRehydrateStorage 触发（fire-and-forget）
  // 同一账号在别处登录时服务端会注销本会话，这里给出明确提示再回到登录页
  useEffect(() => {
    const handler = async () => {
      if (!useAuthStore.getState().isAuthenticated) return
      await useAuthStore.getState().fetchUser()
      if (!useAuthStore.getState().isAuthenticated) {
        useToastStore.getState().show(t('auth.sessionEnded', '登录状态已失效，请重新登录'))
      }
    }
    window.addEventListener('auth:required', handler)
    return () => window.removeEventListener('auth:required', handler)
  }, [t])

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
    // 运行形态尚未探测完时先转圈，避免桌面版闪一下网页端登录页
    if (!desktopProbed) {
      return <LoadingSpinner variant="spinner" />
    }
    return (
      <>
        <LoginModal isOpen={true} />
        <DesktopAuthPendingDialog />
      </>
    )
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
