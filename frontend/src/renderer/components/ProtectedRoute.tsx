import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, ShieldAlert } from 'lucide-react'
import { useLicenseStore } from '../store/licenseStore'
import { useAuthStore } from '../store/authStore'

interface ProtectedRouteProps {
  children: React.ReactNode
  requireAdmin?: boolean
}

export function ProtectedRoute({ children, requireAdmin = false }: ProtectedRouteProps) {
  const perfRef = useRef(performance.now())
  const navigate = useNavigate()
  const { isAuthorized, isLoading, remainingDays, errorMessage, setFromUser } = useLicenseStore()
  const { user } = useAuthStore()

  console.log('[ProtectedRoute] render: isAuthorized=', isAuthorized, 'isLoading=', isLoading, 'elapsed=', (performance.now() - perfRef.current).toFixed(0), 'ms')

  useEffect(() => {
    if (user) {
      setFromUser(user)
    }
  }, [user, setFromUser])

  // 显示加载状态
  if (isLoading || !user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">检查授权状态...</p>
        </div>
      </div>
    )
  }

  // 管理员权限检查
  if (requireAdmin && !user.is_admin) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="max-w-md w-full p-8 space-y-6">
          <div className="flex justify-center">
            <div className="p-4 bg-red-500/10 rounded-full">
              <ShieldAlert size={48} className="text-red-500" />
            </div>
          </div>
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold text-foreground">需要管理员权限</h1>
            <p className="text-muted-foreground">
              此页面仅限管理员访问。如需使用请联系管理员提升权限。
            </p>
          </div>
          <button
            onClick={() => navigate('/')}
            className="w-full px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity font-medium"
          >
            返回首页
          </button>
        </div>
      </div>
    )
  }

  // 授权过期检查（基于 admin license_expiry）
  if (!isAuthorized && !window.location.pathname.includes('/license')) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="max-w-md w-full p-8 space-y-6">
          <div className="flex justify-center">
            <div className="p-4 bg-red-500/10 rounded-full">
              <AlertCircle size={48} className="text-red-500" />
            </div>
          </div>

          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold text-foreground">授权已过期，请联系管理员</h1>
          </div>

          {remainingDays !== null && remainingDays <= 0 && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <div className="space-y-1 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-red-400">邮箱：</span>
                      <a href="mailto:weicongpeng1@163.com" className="text-primary hover:underline">
                        weicongpeng1@163.com
                      </a>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-red-400">微信：</span>
                      <span className="font-mono text-red-300">pengwc2010</span>
                    </div>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return <>{children}</>
}
