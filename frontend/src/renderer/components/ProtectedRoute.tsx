import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, AlertCircle } from 'lucide-react'
import { useLicenseStore } from '../store/licenseStore'

interface ProtectedRouteProps {
  children: React.ReactNode
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const perfRef = useRef(performance.now())
  const navigate = useNavigate()
  const { isAuthorized, isLoading, checkAuthorization, errorMessage, remainingDays } = useLicenseStore()
  const [hasChecked, setHasChecked] = useState(false)

  console.log('[ProtectedRoute] render: isAuthorized=', isAuthorized, 'isLoading=', isLoading, 'hasChecked=', hasChecked, 'elapsed=', (performance.now() - perfRef.current).toFixed(0), 'ms')

  useEffect(() => {
    console.log('[ProtectedRoute] effect authCheck: isAuthorized=', isAuthorized, 'elapsed=', (performance.now() - perfRef.current).toFixed(0), 'ms')
    // 如果已经授权过，跳过重复检查（避免每次路由切换都等待API）
    if (isAuthorized) {
      setHasChecked(true)
      return
    }
    // 未授权过，首次检查授权状态
    checkAuthorization().then(() => {
      setHasChecked(true)
    })
  }, [checkAuthorization, isAuthorized])

  useEffect(() => {
    // 如果未授权且不在允许的路径上，重定向到许可证页面
    if (hasChecked && !isLoading && !isAuthorized) {
      const currentPath = window.location.pathname

      // 检查当前路径是否在允许的列表中
      if (!currentPath.includes('/license')) {
        navigate('/license', { replace: true })
      }
    }
  }, [hasChecked, isLoading, isAuthorized, navigate])

  // 显示加载状态
  if (isLoading || !hasChecked) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">检查授权状态...</p>
        </div>
      </div>
    )
  }

  // 如果未授权，显示未授权提示（但在LicensePage上不会显示）
  if (!isAuthorized && !window.location.pathname.includes('/license')) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="max-w-md w-full p-8 space-y-6">
          <div className="flex justify-center">
            <div className="p-4 bg-red-500/10 rounded-full">
              <Lock size={48} className="text-red-500" />
            </div>
          </div>

          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold text-foreground">需要授权</h1>
            <p className="text-muted-foreground">
              {errorMessage || '您需要先激活许可证才能使用此功能'}
            </p>
          </div>

          {remainingDays !== null && remainingDays <= 0 && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm text-red-500 font-medium mb-2">License已到期，请联系管理员：</p>
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
              </div>
            </div>
          )}

          <button
            onClick={() => navigate('/license')}
            className="w-full px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity font-medium"
          >
            前往配置管理
          </button>
        </div>
      </div>
    )
  }

  // 已授权，渲染子组件
  return <>{children}</>
}
