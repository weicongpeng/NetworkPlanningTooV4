import { lazy } from 'react'

/**
 * 页面 chunk 懒加载工厂（React.lazy 与导航预加载共用同一份，避免路径散落）
 * 非首屏业务页在用户访问时才动态加载，重型依赖（xlsx/leaflet）自动进入各自 chunk
 */
export const loadDataPage = () => import('./pages/DataPage').then(m => ({ default: m.DataPage }))
export const loadPCIPage = () => import('./pages/PCIPage').then(m => ({ default: m.PCIPage }))
export const loadNeighborPage = () => import('./pages/NeighborPage').then(m => ({ default: m.NeighborPage }))
export const loadTACPage = () => import('./pages/TACPage').then(m => ({ default: m.TACPage }))
export const loadTACPlanningPage = () => import('./pages/TACPlanningPage').then(m => ({ default: m.TACPlanningPage }))
export const loadLicensePage = () => import('./pages/LicensePage').then(m => ({ default: m.LicensePage }))
export const loadLayerToolsPage = () => import('./pages/LayerToolsPage')
export const loadDistanceMatchPage = () => import('./pages/DistanceMatchPage')
export const loadSiteSpacingPage = () => import('./pages/SiteSpacingPage')
export const loadFrequencyConversionPage = () => import('./pages/FrequencyConversionPage')
export const loadMapPage = () => import('./pages/MapPage').then(m => ({ default: m.MapPage }))
export const loadAdminUsersPage = () => import('./pages/AdminUsersPage').then(m => ({ default: m.AdminUsersPage }))
export const loadAppVersionsPage = () => import('./pages/AppVersionsPage').then(m => ({ default: m.AppVersionsPage }))

/**
 * chunk 加载失败自动恢复
 *
 * 生产部署后 Vite 清空旧产物（emptyOutDir），仍停留在旧版本页面的浏览器
 * 动态 import 旧 hash chunk 时会拿到 SPA 回退的 index.html（MIME 错误）或网络失败。
 * 此时自动刷新一次加载新版本；刷新后仍失败则抛出，避免刷新死循环。
 */
const CHUNK_RELOAD_KEY = 'chunk_reload_attempted'

export function recoverable<T>(factory: () => Promise<T>): () => Promise<T> {
  return () => factory().then((mod) => {
    try { sessionStorage.removeItem(CHUNK_RELOAD_KEY) } catch { /* noop */ }
    return mod
  }).catch((error) => {
    let alreadyTried = false
    try {
      alreadyTried = sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1'
    } catch {
      // sessionStorage 不可用（如站点数据被禁用），无法防循环，直接抛出
      throw error
    }
    if (alreadyTried) {
      try { sessionStorage.removeItem(CHUNK_RELOAD_KEY) } catch { /* noop */ }
      throw error
    }
    try {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
    } catch {
      throw error
    }
    window.location.reload()
    // 刷新期间挂起 Promise，避免 Suspense 渲染异常
    return new Promise<T>(() => {})
  })
}

// 懒加载组件（App.tsx 路由使用）
export const DataPage = lazy(recoverable(loadDataPage))
export const PCIPage = lazy(recoverable(loadPCIPage))
export const NeighborPage = lazy(recoverable(loadNeighborPage))
export const TACPage = lazy(recoverable(loadTACPage))
export const TACPlanningPage = lazy(recoverable(loadTACPlanningPage))
export const LicensePage = lazy(recoverable(loadLicensePage))
export const LayerToolsPage = lazy(recoverable(loadLayerToolsPage))
export const DistanceMatchPage = lazy(recoverable(loadDistanceMatchPage))
export const SiteSpacingPage = lazy(recoverable(loadSiteSpacingPage))
export const FrequencyConversionPage = lazy(recoverable(loadFrequencyConversionPage))
export const MapPage = lazy(recoverable(loadMapPage))
export const AdminUsersPage = lazy(recoverable(loadAdminUsersPage))
export const AppVersionsPage = lazy(recoverable(loadAppVersionsPage))

/**
 * 导航预加载：导航项 hover 时提前拉取目标页面 chunk，
 * 用户点击切换时 chunk 已就绪，不再显示 Suspense fallback
 */
export function prefetchPage(href: string) {
  switch (href) {
    case '/data': loadDataPage(); break
    case '/pci': loadPCIPage(); break
    case '/neighbor': loadNeighborPage(); break
    case '/tac': loadTACPage(); break
    case '/tac-planning': loadTACPlanningPage(); break
    case '/license': loadLicensePage(); break
    case '/layer': loadLayerToolsPage(); break
    case '/distance-match': loadDistanceMatchPage(); break
    case '/site-spacing': loadSiteSpacingPage(); break
    case '/frequency-conversion': loadFrequencyConversionPage(); break
    case '/map': loadMapPage(); break
    case '/admin/users': loadAdminUsersPage(); break
    case '/app-versions': loadAppVersionsPage(); break
    case '/assistant': loadAssistantPage(); break
    default: break
  }
}
export const loadAssistantPage = () => import('./pages/AssistantPage').then(m => ({ default: m.AssistantPage }))
export const AssistantPageLazy = lazy(recoverable(loadAssistantPage))
