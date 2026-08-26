import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './i18n'
import { useThemeStore } from './store/themeStore'

// 应用持久化主题：themeStore 仅被 LicensePage 引用（懒加载），
// 若不在此处显式应用，非 LicensePage 路由（首页/PCI 等）刷新后
// CSS 变量保持 index.css 默认值（--primary-foreground 为深色），
// 导致菜单选中项蓝底黑字。立即应用默认蓝色主题保证首帧白字，
// persist 异步 rehydrate 完成后 onRehydrateStorage 会再次应用用户配置。
useThemeStore.getState().applyTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
