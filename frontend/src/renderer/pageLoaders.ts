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

// 懒加载组件（App.tsx 路由使用）
export const DataPage = lazy(loadDataPage)
export const PCIPage = lazy(loadPCIPage)
export const NeighborPage = lazy(loadNeighborPage)
export const TACPage = lazy(loadTACPage)
export const TACPlanningPage = lazy(loadTACPlanningPage)
export const LicensePage = lazy(loadLicensePage)
export const LayerToolsPage = lazy(loadLayerToolsPage)
export const DistanceMatchPage = lazy(loadDistanceMatchPage)
export const SiteSpacingPage = lazy(loadSiteSpacingPage)
export const FrequencyConversionPage = lazy(loadFrequencyConversionPage)
export const MapPage = lazy(loadMapPage)
export const AdminUsersPage = lazy(loadAdminUsersPage)
export const AppVersionsPage = lazy(loadAppVersionsPage)

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
export const AssistantPageLazy = lazy(loadAssistantPage)
