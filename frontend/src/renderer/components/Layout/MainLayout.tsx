import { Link, useLocation } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import {
  Home,
  Database,
  Settings,
  Map,
  Layers,
  Shield,
  Users,
  LogOut,
  ChevronRight,
  Package,
  Smartphone,
  Download,
  X,
  Loader2,
  Wrench,
  RadioTower,
} from 'lucide-react'
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../store/authStore'
import { reloadUserMapSettings } from '../../store/mapStore'
import { GlobalTaskIndicator } from './GlobalTaskIndicator'
import { appVersionsApi } from '../../services/api'

// --- 导航项类型定义 ---
type NavLink = { type: 'link'; name: string; href: string; icon?: LucideIcon }
type NavGroup = { type: 'group'; name: string; icon: LucideIcon; children: NavLink[] }
type NavItem = NavLink | NavGroup

export function MainLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const location = useLocation()
  const { user, isAuthenticated, logout } = useAuthStore()

  const navigation: NavItem[] = [
    { type: 'link', name: t('nav.home'), href: '/', icon: Home },
    { type: 'link', name: t('nav.data'), href: '/data', icon: Database },
    {
      type: 'group',
      name: t('nav.paramPlanning'),
      icon: Settings,
      children: [
        { type: 'link', name: t('nav.pci'), href: '/pci' },
        { type: 'link', name: t('nav.neighbor'), href: '/neighbor' },
        { type: 'link', name: t('nav.tacPlanning'), href: '/tac-planning' },
      ],
    },
    {
      type: 'group',
      name: t('nav.paramCheck'),
      icon: Layers,
      children: [
        { type: 'link', name: t('nav.tac'), href: '/tac' },
      ],
    },
    { type: 'link', name: t('nav.map'), href: '/map', icon: Map },
    {
      type: 'group',
      name: t('nav.tools'),
      icon: Wrench,
      children: [
        { type: 'link', name: t('nav.layerTools'), href: '/layer' },
        { type: 'link', name: t('nav.distanceMatch'), href: '/distance-match' },
        { type: 'link', name: t('nav.siteSpacing'), href: '/site-spacing' },
        { type: 'link', name: t('nav.freqConversion'), href: '/frequency-conversion', icon: RadioTower },
      ],
    },
    { type: 'link', name: t('nav.config'), href: '/license', icon: Shield },
    ...(isAuthenticated && user?.is_admin ? [
      { type: 'link' as const, name: t('admin.title', '用户管理'), href: '/admin/users', icon: Users },
      { type: 'link' as const, name: t('sidebar.appVersions', 'APP 版本管理'), href: '/app-versions', icon: Package },
    ] : []),
  ]

  /** 判断分组是否展开：用户手动切换或当前路径匹配子项时自动展开 */
  const isGroupExpanded = (group: NavGroup) => {
    // 当前路径匹配子项时自动展开
    if (group.children.some(child => location.pathname === child.href)) {
      return true
    }
    return expandedGroups.has(group.name)
  }

  // 路由变化时自动展开匹配的分组（刷新页面也用）
  useEffect(() => {
    const groupsToExpand = navigation
      .filter((item): item is NavGroup =>
        item.type === 'group' &&
        item.children.some(child => location.pathname === child.href)
      )
      .map(g => g.name)

    if (groupsToExpand.length > 0) {
      setExpandedGroups(prev => {
        const next = new Set(prev)
        groupsToExpand.forEach(name => next.add(name))
        if (groupsToExpand.every(name => prev.has(name))) return prev
        return next
      })
    }
  }, [location.pathname])

  const toggleGroup = (groupName: string) => {
    const next = new Set(expandedGroups)
    if (next.has(groupName)) next.delete(groupName)
    else next.add(groupName)
    setExpandedGroups(next)
  }

  // ===== 手机APP下载弹窗 =====
  const [showAppDownload, setShowAppDownload] = useState(false)
  const [latestVersion, setLatestVersion] = useState<any>(null)
  const [versionLoading, setVersionLoading] = useState(false)

  useEffect(() => {
    if (!showAppDownload) return
    setVersionLoading(true)
    appVersionsApi.getLatest()
      .then((res: any) => {
        if (res?.success && res?.data) setLatestVersion(res.data)
        else setLatestVersion(null)
      })
      .catch(() => setLatestVersion(null))
      .finally(() => setVersionLoading(false))
  }, [showAppDownload])

  const getFullDownloadUrl = (downloadUrl: string) => {
    if (!downloadUrl) return ''
    if (downloadUrl.startsWith('http')) return downloadUrl
    const base = window.location.origin
    return `${base}${downloadUrl}`
  }

  const formatSize = (size: number) => {
    if (!size) return ''
    const mb = size / (1024 * 1024)
    return `${mb.toFixed(1)} MB`
  }

  const handleLogout = async () => {
    await logout()
  }

  // 监听用户登录状态变化，切换地图设置
  useEffect(() => {
    reloadUserMapSettings()
  }, [isAuthenticated, user?.id])

  // ===== 地图工具页面自动折叠侧边栏 =====
  // 进入 /map（地图工具）页面 3 秒后自动隐藏左侧边栏，为地图留出更多可视空间；
  // 离开页面时清理定时器，用户手动展开后不会再被强制折叠（除非再次进入该页面）
  useEffect(() => {
    if (location.pathname !== '/map') return
    const timer = setTimeout(() => {
      setSidebarOpen(false)
    }, 3000)
    return () => clearTimeout(timer)
  }, [location.pathname])

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* 侧边栏容器 - 包含侧边栏和控件 */}
      <div className="relative">
        {/* 侧边栏 - 使用主题变量，跟随系统主题设置 */}
        <aside
          style={{
            width: sidebarOpen ? '180px' : '42px',
            height: '100vh',
            transition: 'width 0.35s cubic-bezier(0.25, 0.1, 0.25, 1)',
            backgroundColor: 'hsl(var(--card))',
          }}
          className="border-r border-border flex flex-col relative z-20"
        >
          {/* 导航菜单 - 固定高度和间距，避免上下移动，图标位置固定，内容边距统一 */}
          <nav className="flex-1 overflow-y-auto py-3">
            {navigation.map((item) => {
              if (item.type === 'group') {
                const GroupIcon = item.icon
                const groupExpanded = isGroupExpanded(item)

                return (
                  <div key={item.name}>
                    {/* 分组标题 */}
                    <button
                      onClick={() => toggleGroup(item.name)}
                      className="flex items-center h-[42px] w-full rounded-lg transition-colors"
                      style={{
                        paddingLeft: '6px',
                        paddingRight: '6px',
                        gap: '8px',
                        backgroundColor: 'transparent',
                        color: 'hsl(var(--foreground))',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'hsl(var(--muted))'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent'
                      }}
                    >
                      <div className="flex-shrink-0 w-6 flex justify-center">
                        <GroupIcon size={20} />
                      </div>
                      <span
                        style={{
                          opacity: sidebarOpen ? 1 : 0,
                          maxWidth: sidebarOpen ? '100px' : '0px',
                          transition: 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: 'block',
                          flex: 1,
                          textAlign: 'left',
                        }}
                      >
                        {item.name}
                      </span>
                      {/* 展开/折叠箭头 - 仅在侧边栏展开时显示 */}
                      {sidebarOpen && (
                        <ChevronRight
                          size={14}
                          style={{
                            color: 'hsl(var(--muted-foreground))',
                            transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                            transform: groupExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                            flexShrink: 0,
                          }}
                        />
                      )}
                    </button>

                    {/* 分组子项 */}
                    <div
                      style={{
                        maxHeight: groupExpanded && sidebarOpen ? `${item.children.length * 42}px` : '0px',
                        opacity: groupExpanded && sidebarOpen ? 1 : 0,
                        overflow: 'hidden',
                        transition: 'max-height 0.3s cubic-bezier(0.25, 0.1, 0.25, 1), opacity 0.2s ease',
                      }}
                    >
                      {item.children.map((child) => {
                        const isChildActive = location.pathname === child.href

                        return (
                          <Link
                            key={child.name}
                            to={child.href}
                            className="flex items-center h-[42px] rounded-lg transition-colors"
                            style={{
                              paddingLeft: '38px',
                              paddingRight: '6px',
                              gap: '8px',
                              backgroundColor: isChildActive ? 'hsl(var(--primary))' : 'transparent',
                              color: isChildActive ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
                            }}
                            onMouseEnter={(e) => {
                              if (!isChildActive) {
                                e.currentTarget.style.backgroundColor = 'hsl(var(--muted))'
                                e.currentTarget.style.color = 'hsl(var(--foreground))'
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (!isChildActive) {
                                e.currentTarget.style.backgroundColor = 'transparent'
                                e.currentTarget.style.color = 'hsl(var(--foreground))'
                              }
                            }}
                          >
                            {child.icon && (
                              <div className="flex-shrink-0 w-6 flex justify-center">
                                <child.icon size={20} />
                              </div>
                            )}
                            <span
                              style={{
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {child.name}
                            </span>
                          </Link>
                        )
                      })}
                    </div>
                  </div>
                )
              }

              // --- 普通链接项 ---
              const LinkIcon = item.icon
              const isActive = location.pathname === item.href

              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className="flex items-center h-[42px] rounded-lg transition-colors"
                  style={{
                    paddingLeft: '6px',
                    paddingRight: '6px',
                    gap: '8px',
                    backgroundColor: isActive ? 'hsl(var(--primary))' : 'transparent',
                    color: isActive ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = 'hsl(var(--muted))'
                      e.currentTarget.style.color = 'hsl(var(--foreground))'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = 'transparent'
                      e.currentTarget.style.color = 'hsl(var(--foreground))'
                    }
                  }}
                >
                  {LinkIcon && (
                    <div className="flex-shrink-0 w-6 flex justify-center">
                      <LinkIcon size={20} />
                    </div>
                  )}
                  <span
                    style={{
                      opacity: sidebarOpen ? 1 : 0,
                      maxWidth: sidebarOpen ? '140px' : '0px',
                      transition: 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'block',
                    }}
                  >
                    {item.name}
                  </span>
                </Link>
              )
            })}
          </nav>

          {/* 底部用户信息 & 退出 */}
          {isAuthenticated && user && (
            <div
              className="border-t border-border flex-shrink-0"
              style={{
                opacity: sidebarOpen ? 1 : 0,
                transition: 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            >
              <div className="px-3 py-3 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs text-primary font-medium">{user.username.charAt(0).toUpperCase()}</span>
                  </div>
                  <span className="text-foreground truncate">{user.username}</span>
                  {user.is_admin && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 flex-shrink-0">管理</span>
                  )}
                </div>
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-2 text-xs text-muted-foreground hover:text-red-400 transition-colors w-full"
                >
                  <LogOut size={14} />
                  <span>{t('auth.logout', '退出登录')}</span>
                </button>
              </div>
            </div>
          )}

          {/* 底部版本信息 */}
          <div
            className="text-xs"
            style={{
              opacity: sidebarOpen ? 1 : 0,
              transition: 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
              color: 'hsl(var(--muted-foreground))',
              flexShrink: 0,
            }}
          >
            <div className="px-4 py-2">
              <p>v2.0.0</p>
            </div>
          </div>

          {/* 展开/隐藏控件 - 位于侧边栏内部右下角 */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'hsl(var(--muted))' }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'hsl(var(--card))' }}
            style={{
              position: 'absolute',
              bottom: '8px',
              right: '4px',
              width: sidebarOpen ? 'auto' : '34px',
              minWidth: '34px',
              height: '28px',
              padding: '0 8px',
              backgroundColor: 'hsl(var(--card))',
              borderRadius: '6px',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background-color 0.2s ease, width 0.35s cubic-bezier(0.25, 0.1, 0.25, 1)',
              zIndex: 30,
            }}
            title={sidebarOpen ? t('common.collapseSidebar') : t('common.expandSidebar')}
          >
            {/* > 样式箭头 */}
            <span
              style={{
                fontSize: '16px',
                fontWeight: 'bold',
                color: 'hsl(var(--muted-foreground))',
                transition: 'transform 0.35s cubic-bezier(0.25, 0.1, 0.25, 1)',
                transform: sidebarOpen ? 'rotate(0deg)' : 'rotate(180deg)',
              }}
            >
              {'>'}
            </span>
          </button>

        </aside>
      </div>

      {/* 手机APP按钮 - fixed 固定定位，避免与页面内容层叠 */}
      <button
        onClick={() => setShowAppDownload(true)}
        className="fixed top-3 right-6 z-50 flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
        title={t('app.downloadTitle')}
      >
        <Smartphone size={16} />
        <span>{t('app.download')}</span>
      </button>
      {/* 主内容区域 */}
      <main className="flex-1 overflow-auto flex flex-col relative z-10">

        <GlobalTaskIndicator />
        {children}
      </main>

      {/* 手机APP下载弹窗 - 放在 main 外部避免地图组件层叠上下文遮挡 */}
      {showAppDownload && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50"
          onClick={() => setShowAppDownload(false)}
        >
          <div
            className="bg-card border border-border rounded-xl w-full max-w-sm mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
              {/* 弹窗头部 */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <h2 className="font-semibold text-foreground flex items-center gap-2">
                  <Smartphone size={18} />
                  {t('app.downloadTitle')}
                </h2>
                <button
                  onClick={() => setShowAppDownload(false)}
                  className="p-1 rounded-md hover:bg-muted text-muted-foreground"
                >
                  <X size={18} />
                </button>
              </div>

              {/* 弹窗内容 */}
              <div className="p-5 flex flex-col items-center space-y-4">
                {versionLoading ? (
                  <div className="py-8 text-muted-foreground flex flex-col items-center gap-2">
                    <Loader2 size={24} className="animate-spin" />
                    <span className="text-sm">{t('app.loadingVersion')}</span>
                  </div>
                ) : latestVersion ? (
                  <>
                    {/* 二维码 */}
                    {(() => {
                      const downloadUrl = getFullDownloadUrl(latestVersion.download_url)
                      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(downloadUrl)}`
                      return (
                        <div className="bg-white p-3 rounded-lg shadow-sm border border-border">
                          <img
                            src={qrUrl}
                            alt={t('app.downloadTitle')}
                            className="w-[200px] h-[200px]"
                            crossOrigin="anonymous"
                          />
                        </div>
                      )
                    })()}

                    {/* 版本信息 */}
                    <div className="text-center">
                      <p className="text-sm font-semibold text-foreground">
                        {t('app.latestVersion')} V{latestVersion.version}
                        {latestVersion.file_size_display ? ` · ${latestVersion.file_size_display}` : ''}
                      </p>
                      {latestVersion.changelog && (
                        <p className="text-xs text-muted-foreground mt-1 max-w-xs whitespace-pre-line">
                          {latestVersion.changelog}
                        </p>
                      )}
                    </div>

                    {/* 扫码提示 */}
                    <p className="text-xs text-muted-foreground">
                      {t('app.installHint')}
                    </p>

                    {/* 下载按钮 */}
                    <a
                      href={getFullDownloadUrl(latestVersion.download_url)}
                      download
                      className="inline-flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity text-sm font-medium"
                    >
                      <Download size={16} />
                      <span>{t('app.downloadApk')}</span>
                    </a>
                  </>
                ) : (
                  <div className="py-8 text-muted-foreground text-center">
                    <p className="text-sm">{t('app.noVersionAvailable')}</p>
                    <p className="text-xs mt-1">{t('app.uploadApkHint')}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
    </div>
  )
}
