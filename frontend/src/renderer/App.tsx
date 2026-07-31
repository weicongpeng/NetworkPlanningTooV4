import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { MainLayout } from './components/Layout/MainLayout'
import { ProtectedRoute } from './components/ProtectedRoute'
import { AuthGuard } from './components/AuthGuard'
import { HomePage } from './pages/HomePage'
import { DataPage } from './pages/DataPage'
import { PCIPage } from './pages/PCIPage'
import { NeighborPage } from './pages/NeighborPage'
import { TACPage } from './pages/TACPage'
import { TACPlanningPage } from './pages/TACPlanningPage'
import { LicensePage } from './pages/LicensePage'
import { MapPage } from './pages/MapPage'
import { AdminUsersPage } from './pages/AdminUsersPage'
import { AppVersionsPage } from './pages/AppVersionsPage'
import { useEffect } from 'react'
import { startHealthCheck, stopHealthCheck } from '@/renderer/services/api'
import { useHeartbeat } from './hooks/useHeartbeat'

function App() {
  useHeartbeat()

  // 启动时开始后端健康检查轮询
  useEffect(() => {
    startHealthCheck(15000)
    return () => stopHealthCheck()
  }, [])

  return (
    <Router>
      <AuthGuard>
        <MainLayout>
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

            {/* 未匹配路径重定向到首页 */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </MainLayout>
      </AuthGuard>
    </Router>
  )
}

export default App
