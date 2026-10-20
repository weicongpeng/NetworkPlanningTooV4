import { Suspense, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { MainLayout } from './components/Layout/MainLayout'
import { ProtectedRoute } from './components/ProtectedRoute'
import { AuthGuard } from './components/AuthGuard'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoadingSpinner } from './components/LoadingSpinner'
import { HomePage } from './pages/HomePage'
import {
  DataPage,
  PCIPage,
  NeighborPage,
  TACPage,
  TACPlanningPage,
  LicensePage,
  LayerToolsPage,
  DistanceMatchPage,
  SiteSpacingPage,
  FrequencyConversionPage,
  IntermodulationPage,
  MapPage,
  AdminUsersPage,
  AppVersionsPage,
  DesktopReleasesPage,
  DesktopLicensesPage,
  AssistantPageLazy,
} from './pageLoaders'
import { startHealthCheck, stopHealthCheck } from '@/renderer/services/api'
import { useHeartbeat } from './hooks/useHeartbeat'
import { useAuthStore } from './store/authStore'
import { saveLastRoute } from './utils/lastRoute'

/** 记录已登录用户当前所在页面，重新登录后可恢复到该页面 */
function LastRouteTracker() {
  const location = useLocation()
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const username = useAuthStore((s) => s.user?.username)

  useEffect(() => {
    if (isAuthenticated && username) {
      saveLastRoute(username, location.pathname)
    }
  }, [isAuthenticated, username, location.pathname])

  return null
}

function App() {
  useHeartbeat()

  // 启动时开始后端健康检查轮询
  useEffect(() => {
    startHealthCheck(15000)
    return () => stopHealthCheck()
  }, [])

  return (
    <Router>
      <LastRouteTracker />
      <AuthGuard>
        {/* 顶层错误边界：页面渲染抛错时给出可恢复界面，不再整树卸载白屏 */}
        <ErrorBoundary>
          <MainLayout>
          {/* 懒加载兜底：与页面内部 loading 风格一致（转圈），导航 hover 已预加载，切换时一般不显示 */}
          <Suspense fallback={<LoadingSpinner variant="spinner" />}>
            <Routes>
              {/* 许可证页面 - 无需授权保护 */}
              <Route path="/license" element={<LicensePage />} />

              {/* 其他页面 - 需要授权 */}
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <HomePage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/data"
                element={
                  <ProtectedRoute>
                    <DataPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/pci"
                element={
                  <ProtectedRoute>
                    <PCIPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/neighbor"
                element={
                  <ProtectedRoute>
                    <NeighborPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/tac"
                element={
                  <ProtectedRoute>
                    <TACPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/tac-planning"
                element={
                  <ProtectedRoute>
                    <TACPlanningPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/map"
                element={
                  <ProtectedRoute>
                    <MapPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/layer"
                element={
                  <ProtectedRoute>
                    <LayerToolsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/distance-match"
                element={
                  <ProtectedRoute>
                    <DistanceMatchPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/site-spacing"
                element={
                  <ProtectedRoute>
                    <SiteSpacingPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/frequency-conversion"
                element={
                  <ProtectedRoute>
                    <FrequencyConversionPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/intermodulation"
                element={
                  <ProtectedRoute>
                    <IntermodulationPage />
                  </ProtectedRoute>
                }
              />

              {/* 管理员页面 */}
              <Route
                path="/admin/users"
                element={
                  <ProtectedRoute requireAdmin>
                    <AdminUsersPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/app-versions"
                element={
                  <ProtectedRoute requireAdmin>
                    <AppVersionsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/desktop-releases"
                element={
                  <ProtectedRoute requireAdmin>
                    <DesktopReleasesPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/desktop-licenses"
                element={
                  <ProtectedRoute requireAdmin>
                    <DesktopLicensesPage />
                  </ProtectedRoute>
                }
              />

              <Route
                path="/assistant"
                element={
                  <ProtectedRoute requirePermission="can_assistant">
                    <AssistantPageLazy />
                  </ProtectedRoute>
                }
              />

              {/* 未匹配路径重定向到首页 */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
          </MainLayout>
        </ErrorBoundary>
      </AuthGuard>
    </Router>
  )
}

export default App
