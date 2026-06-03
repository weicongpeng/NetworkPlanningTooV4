import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { LoginModal } from './LoginModal'

interface AuthGuardProps {
  children: React.ReactNode
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { isAuthenticated, user, isLoading, fetchUser } = useAuthStore()
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [initialized, setInitialized] = useState(false)

  // 初始化：从 localStorage 恢复后验证 token
  useEffect(() => {
    fetchUser().finally(() => setInitialized(true))
  }, [])

  // 监听 401 事件
  useEffect(() => {
    const handler = () => {
      setShowLoginModal(true)
    }
    window.addEventListener('auth:required', handler)
    return () => window.removeEventListener('auth:required', handler)
  }, [])

  // 同步显示状态
  useEffect(() => {
    if (initialized && !isAuthenticated) {
      setShowLoginModal(true)
    } else if (isAuthenticated) {
      setShowLoginModal(false)
    }
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

  return (
    <>
      {/* 登录模态框（未认证时显示） */}
      {showLoginModal && !isAuthenticated && (
        <LoginModal isOpen={true} />
      )}

      {/* 强制修改密码（已认证但需修改密码时） */}
      {isAuthenticated && user?.must_change_password && (
        <LoginModal isOpen={true} forceChangePassword={true} />
      )}

      {/* 正常应用内容（已认证且无需修改密码时） */}
      {isAuthenticated && !user?.must_change_password && children}
    </>
  )
}
