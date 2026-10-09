import { Link, useLocation } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import {
  Home,
  Database,
  Settings,
  Map,
  GitCompare,
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
  Bot,
  MonitorDown,
  KeyRound,
  Sun,
  Moon,
  Boxes,
} from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../store/authStore'
import { useThemeStore } from '../../store/themeStore'
import { reloadUserMapSettings } from '../../store/mapStore'
import { Toaster } from './Toaster'
import { DesktopUpdateDialog } from '../DesktopUpdateDialog'
import { DesktopSyncIndicator } from '../DesktopSyncIndicator'
import { useDesktopStatusLabel } from '../desktopStatusLabel'
import { DesktopSessionGuard } from '../DesktopSessionGuard'
import { appVersionsApi, desktopCloudApi, desktopReleasesApi } from '../../services/api'
import { prefetchPage } from '../../pageLoaders'

// ===== APP 悬浮图标：可拖拽移动、松手吸附最近左右边缘，位置按登录用户持久化 =====

const APP_ICON_SIZE = 44

function appIconPosKey(): string {
  try {
    const stored = localStorage.getItem('auth-storage')
    if (stored) {
      const u = JSON.parse(stored)?.state?.user
      if (u?.id) return `app-icon-pos-user-${u.id}`
    }
  } catch { /* ignore */ }
  return 'app-icon-pos-anonymous'
}

/** 默认位置：吸附右侧中部 */
function defaultAppIconPos(): { x: number; y: number } {
  return {
    x: Math.max(8, window.innerWidth - APP_ICON_SIZE - 12),
    y: Math.max(8, window.innerHeight / 2 - APP_ICON_SIZE / 2),
  }
}

function loadAppIconPos(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(appIconPosKey())
    if (raw) {
      const p = JSON.parse(raw)
      if (typeof p?.x === 'number' && typeof p?.y === 'number') return p
    }
  } catch { /* ignore */ }
  return defaultAppIconPos()
}

// --- 导航项类型定义 ---
type NavLink = { type: 'link'; name: string; href: string; icon?: LucideIcon }
type NavGroup = { type: 'group'; name: string; icon: LucideIcon; children: NavLink[] }
type NavItem = NavLink | NavGroup

export function MainLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  // 用户手动收起的分组（即使子项被选中也不自动展开）；路由切换时清空
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const location = useLocation()
  const { user, isAuthenticated, logout } = useAuthStore()
  const desktopMode = useAuthStore((s) => s.desktopMode)
  const { themeMode, setThemeMode } = useThemeStore()
  // 桌面端：应用名旁的运行模式 + 实时同步状态（网页端为 null）
  const desktopStatus = useDesktopStatusLabel()

  // 侧边栏底部用户信息浮层：悬浮显示，点击固定（再次点击或点击浮层外关闭）
  const [userInfoHovered, setUserInfoHovered] = useState(false)
  const [userInfoPinned, setUserInfoPinned] = useState(false)
  const userInfoRef = useRef<HTMLDivElement>(null)
  const showUserInfo = userInfoHovered || userInfoPinned

  useEffect(() => {
    if (!userInfoPinned) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (!userInfoRef.current?.contains(e.target as Node)) setUserInfoPinned(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [userInfoPinned])

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
      icon: GitCompare,
      children: [
        { type: 'link', name: t('nav.tac'), href: '/tac' },
      ],
    },
    // 网优助手：管理员或被授予 can_assistant 权限的用户可见
    ...(isAuthenticated && (user?.is_admin || user?.can_assistant) ? [
      { type: 'link' as const, name: t('nav.assistant', '网优助手'), href: '/assistant', icon: Bot },
    ] : []),
    { type: 'link', name: t('nav.map'), href: '/map', icon: Map },
    {
      type: 'group',
      name: t('nav.tools'),
      icon: Wrench,
      children: [
        { type: 'link', name: t('nav.layerTools'), href: '/layer' },
        { type: 'link', name: t('nav.distanceMatch'), href: '/distance-match' },
        { type: 'link', name: t('nav.siteSpacing'), href: '/site-spacing' },
        { type: 'link', name: t('nav.freqConversion'), href: '/frequency-conversion' },
      ],
    },
    { type: 'link', name: t('nav.config'), href: '/license', icon: Shield },
    // 桌面版是单用户形态，没有管理员与用户管理，以下服务器端管理入口全部隐藏
    ...(isAuthenticated && user?.is_admin && !desktopMode ? [
      { type: 'link' as const, name: t('admin.title', '用户管理'), href: '/admin/users', icon: Users },
      { type: 'link' as const, name: t('sidebar.appVersions', 'APP 版本管理'), href: '/app-versions', icon: Package },
      { type: 'link' as const, name: t('sidebar.desktopLicenses', '桌面授权'), href: '/desktop-licenses', icon: KeyRound },
      { type: 'link' as const, name: t('sidebar.desktopReleases', '桌面版分发'), href: '/desktop-releases', icon: MonitorDown },
    ] : []),
  ]

  /** 判断分组是否展开：用户手动收起则收起；否则当前路径匹配子项或手动展开时展开 */
  const isGroupExpanded = (group: NavGroup) => {
    // 用户手动收起的分组优先（即使子项被选中也保持收起）
    if (collapsedGroups.has(group.name)) return false
    // 当前路径匹配子项时自动展开
    if (group.children.some(child => location.pathname === child.href)) {
      return true
    }
    return expandedGroups.has(group.name)
  }

  /** 分组主菜单是否有选中的子项（用于蓝底高亮） */
  const isGroupActive = (group: NavGroup) =>
    group.children.some(child => location.pathname === child.href)

  // 路由变化时自动展开匹配的分组（刷新页面也用），并清空手动收起标记
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
    // 路由切换后重置手动收起标记，使新页面的分组正常自动展开
    setCollapsedGroups(new Set())
  }, [location.pathname])

  // 点击分组主菜单：折叠态→展开侧边栏并展开该组；展开态→切换子菜单展开/收起
  const handleGroupClick = (group: NavGroup) => {
    if (!sidebarOpen) {
      setSidebarOpen(true)
      setExpandedGroups(prev => { const n = new Set(prev); n.add(group.name); return n })
      setCollapsedGroups(prev => { const n = new Set(prev); n.delete(group.name); return n })
      return
    }
    const expanded = isGroupExpanded(group)
    const nextCollapsed = new Set(collapsedGroups)
    const nextExpanded = new Set(expandedGroups)
    if (expanded) {
      nextCollapsed.add(group.name)
      nextExpanded.delete(group.name)
    } else {
      nextCollapsed.delete(group.name)
      nextExpanded.add(group.name)
    }
    setCollapsedGroups(nextCollapsed)
    setExpandedGroups(nextExpanded)
  }

  // ===== 应用下载弹窗（手机APP / 电脑端） =====
  const [showAppDownload, setShowAppDownload] = useState(false)
  // 桌面端形态本身就是电脑端，不提供「电脑端」下载栏
  const [appTab, setAppTab] = useState<'mobile' | 'desktop'>('mobile')
  const [latestVersion, setLatestVersion] = useState<any>(null)
  const [versionLoading, setVersionLoading] = useState(false)
  // 电脑端：桌面版安装包分发（公开接口取最新版本，点击后交给浏览器下载）
  const [desktopRelease, setDesktopRelease] = useState<any>(null)
  const [desktopVersionLoading, setDesktopVersionLoading] = useState(false)

  // 打开弹窗时回到「手机APP」栏（原有下载方式不变）
  useEffect(() => {
    if (showAppDownload) setAppTab('mobile')
  }, [showAppDownload])

  useEffect(() => {
    if (!showAppDownload) return
    setVersionLoading(true)
    // 桌面端不分发 APK：取服务器最新版本（本机接口会拼出可扫码的绝对下载地址）
    const loader = desktopMode ? desktopCloudApi.appVersion() : appVersionsApi.getLatest()
    loader
      .then((res: any) => {
        if (res?.success && res?.data) setLatestVersion(res.data)
        else setLatestVersion(null)
      })
      .catch(() => setLatestVersion(null))
      .finally(() => setVersionLoading(false))
  }, [showAppDownload, desktopMode])

  // 电脑端版本：切换/打开该栏时按需拉取（取桌面版分发里发布的安装包）
  useEffect(() => {
    if (!showAppDownload || appTab !== 'desktop' || desktopMode) return
    setDesktopVersionLoading(true)
    desktopReleasesApi
      .latestPublic()
      .then((res: any) => {
        setDesktopRelease(res?.success && res?.data ? res.data : null)
      })
      .catch(() => setDesktopRelease(null))
      .finally(() => setDesktopVersionLoading(false))
  }, [showAppDownload, appTab, desktopMode])

  const getFullDownloadUrl = (downloadUrl: string) => {
    if (!downloadUrl) return ''
    if (downloadUrl.startsWith('http')) return downloadUrl
    const base = window.location.origin
    return `${base}${downloadUrl}`
  }

  // ===== APP 悬浮图标拖拽（点击不动 = 打开下载弹窗；拖动后吸附最近左右边缘并持久化） =====
  const [appIconPos, setAppIconPos] = useState(loadAppIconPos)
  const appIconDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null)

  const clampAppIconPos = (x: number, y: number) => ({
    x: Math.min(Math.max(8, x), window.innerWidth - APP_ICON_SIZE - 8),
    y: Math.min(Math.max(8, y), window.innerHeight - APP_ICON_SIZE - 8),
  })

  const onAppIconPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    appIconDragRef.current = {
      startX: e.clientX, startY: e.clientY,
      origX: appIconPos.x, origY: appIconPos.y,
      moved: false,
    }
  }

  const onAppIconPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = appIconDragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
    d.moved = true
    setAppIconPos(clampAppIconPos(d.origX + dx, d.origY + dy))
  }

  const onAppIconPointerUp = () => {
    const d = appIconDragRef.current
    appIconDragRef.current = null
    if (!d) return
    if (!d.moved) {
      // 未拖动 = 点击：保持原有行为（打开 APP 下载弹窗）
      setShowAppDownload(true)
      return
    }
    setAppIconPos((p) => {
      const mid = window.innerWidth / 2
      const next = clampAppIconPos(
        p.x + APP_ICON_SIZE / 2 < mid ? 12 : window.innerWidth - APP_ICON_SIZE - 12,
        p.y,
      )
      try { localStorage.setItem(appIconPosKey(), JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }

  // 窗口尺寸变化时把图标夹回可视范围
  useEffect(() => {
    const onResize = () => setAppIconPos((p) => clampAppIconPos(p.x, p.y))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

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
          onClick={(e) => {
            // 点击侧边栏空白处（非导航项/按钮）时切换展开/收起，保留右下角按钮原有行为
            if (!(e.target as HTMLElement).closest('a, button')) {
              setSidebarOpen((v) => !v)
            }
          }}
          style={{
            width: sidebarOpen ? '180px' : '42px',
            height: '100vh',
            transition: 'width 0.35s cubic-bezier(0.25, 0.1, 0.25, 1)',
            backgroundColor: 'hsl(var(--background))',
          }}
          className="border-r border-border/60 flex flex-col relative z-20"
        >
          {/* 应用名 + 运行模式/同步状态（桌面端常驻标注；网页端只显示应用名） */}
          <div className="flex-shrink-0 border-b border-border/60 py-3" style={{ paddingLeft: '6px', paddingRight: '6px' }}>
            <div className="flex items-center h-[30px]" style={{ gap: '8px' }}>
              <div className="flex-shrink-0 w-6 flex justify-center">
                <Boxes size={20} className="text-primary" />
              </div>
              <span
                className="text-sm font-semibold text-foreground"
                style={{
                  opacity: sidebarOpen ? 1 : 0,
                  maxWidth: sidebarOpen ? '120px' : '0px',
                  transition: 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: 'block',
                }}
              >
                {desktopStatus?.appName || t('common.appName', '网优引擎')}
              </span>
            </div>
            {/* 桌面端运行模式/同步状态不再在侧栏重复展示：窗口标题栏已有同一份文案
                （DesktopSyncIndicator → desktopStatusLabel.title → 本机窗口标题） */}
          </div>

          {/* 导航菜单 - 固定高度和间距，避免上下移动，图标位置固定，内容边距统一 */}
          <nav className="flex-1 overflow-y-auto py-3">
            {navigation.map((item) => {
              if (item.type === 'group') {
                const GroupIcon = item.icon
                const groupExpanded = isGroupExpanded(item)
                const groupActive = isGroupActive(item)

                return (
                  <div key={item.name}>
                    {/* 分组标题 */}
                    <button
                      onClick={() => handleGroupClick(item)}
                      title={!sidebarOpen ? item.name : undefined}
                      className="flex items-center h-[42px] w-full rounded-lg transition-colors"
                      style={{
                        paddingLeft: '6px',
                        paddingRight: '6px',
                        gap: '8px',
                        // 仅在侧边栏收起（图标态）且有选中子项时主菜单蓝底高亮；
                        // 展开时只高亮子菜单，主菜单不高亮
                        backgroundColor: (groupActive && !sidebarOpen) ? 'hsl(var(--primary))' : 'transparent',
                        color: (groupActive && !sidebarOpen) ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
                      }}
                      onMouseEnter={(e) => {
                        if (!(groupActive && !sidebarOpen)) e.currentTarget.style.backgroundColor = 'hsl(var(--muted))'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = (groupActive && !sidebarOpen) ? 'hsl(var(--primary))' : 'transparent'
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
                            color: (groupActive && !sidebarOpen) ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
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
                              prefetchPage(child.href)
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
                    prefetchPage(item.href)
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

          {/* 底部用户信息 & 退出：用户区为"头像 + 所属组"（不再显示用户名文字），退出为图标+文字 */}
          {isAuthenticated && user && (
            <div className="border-t border-border flex-shrink-0">
              {/* 用户信息行：头像图标 + 所属组；鼠标悬浮或点击显示全名与所属组（点击可固定浮层） */}
              <div
                ref={userInfoRef}
                className="relative"
                onMouseEnter={() => setUserInfoHovered(true)}
                onMouseLeave={() => setUserInfoHovered(false)}
              >
                <button
                  type="button"
                  onClick={() => setUserInfoPinned(v => !v)}
                  aria-label={user.username}
                  className="flex items-center w-full h-[42px] rounded-lg transition-colors hover:bg-muted"
                  style={{ paddingLeft: '6px', paddingRight: '6px', gap: '8px' }}
                >
                  <div className="flex-shrink-0 w-6 flex justify-center">
                    <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center">
                      <span className="text-xs text-primary font-medium">{user.username.charAt(0).toUpperCase()}</span>
                    </div>
                  </div>
                  {/* 所属组（地市·运营商）：侧栏展开时显示；收起时仅头像，组信息仍在悬浮浮层中 */}
                  {sidebarOpen && (user.city || user.operator) && (
                    <span
                      className="text-[10px] px-1.5 rounded bg-primary/10 text-primary flex-shrink-0"
                      style={{
                        transition: 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {[user.city, user.operator].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </button>
                {showUserInfo && (
                  <div
                    role="tooltip"
                    onClick={(e) => e.stopPropagation()}
                    className="absolute left-full bottom-1 ml-2 z-[3000] w-56 rounded-lg border border-border bg-card px-3 py-2 shadow-lg"
                  >
                    <div className="text-sm font-medium text-foreground break-all">{user.username}</div>
                    <div className="mt-1 text-xs text-muted-foreground break-all">
                      {t('auth.userGroup')}：{[user.city, user.operator].filter(Boolean).join(' · ') || '—'}
                    </div>
                    {user.is_admin && (
                      <span className="mt-1.5 inline-block text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">
                        {t('auth.adminBadge')}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {/* 退出登录按钮：收起时仅显示图标（悬停提示），与导航项图标尺寸一致。
                  桌面端与网页端一致，退出后回到登录页（可换账号或换运行模式） */}
              <button
                onClick={handleLogout}
                title={!sidebarOpen ? t('auth.logout', '退出登录') : undefined}
                className="flex items-center w-full h-[42px] rounded-lg transition-colors text-muted-foreground hover:text-red-400"
                style={{ paddingLeft: '6px', paddingRight: '6px', gap: '8px' }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'hsl(var(--muted))' }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent' }}
              >
                <div className="flex-shrink-0 w-6 flex justify-center">
                  <LogOut size={20} />
                </div>
                <span
                  className="text-xs"
                  style={{
                    opacity: sidebarOpen ? 1 : 0,
                    maxWidth: sidebarOpen ? '140px' : '0px',
                    transition: 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    display: 'block',
                    textAlign: 'left',
                  }}
                >
                  {t('auth.logout', '退出登录')}
                </span>
              </button>
            </div>
          )}

          {/* 底部：深色/浅色主题切换（替代原版本号与展开/隐藏按钮） */}
          <div className="border-t border-border flex-shrink-0 py-2">
            <button
              onClick={() => setThemeMode(themeMode === 'dark' ? 'light' : 'dark')}
              className="flex items-center w-full h-[42px] rounded-lg transition-colors"
              style={{
                paddingLeft: '6px',
                paddingRight: '6px',
                gap: '8px',
                backgroundColor: 'transparent',
                color: 'hsl(var(--foreground))',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'hsl(var(--muted))' }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent' }}
              title={themeMode === 'dark'
                ? (t('common.lightMode') || '浅色模式')
                : (t('common.darkMode') || '深色模式')}
            >
              <div className="flex-shrink-0 w-6 flex justify-center">
                {themeMode === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
              </div>
              <span
                className="text-xs"
                style={{
                  opacity: sidebarOpen ? 1 : 0,
                  maxWidth: sidebarOpen ? '140px' : '0px',
                  transition: 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  display: 'block',
                  textAlign: 'left',
                }}
              >
                {themeMode === 'dark' ? (t('common.lightMode') || '浅色模式') : (t('common.darkMode') || '深色模式')}
              </span>
            </button>
          </div>

        </aside>
      </div>

      {/* 应用下载悬浮图标：可拖拽移动，默认吸附右侧中部，位置按用户持久化；点击打开下载弹窗 */}
      <button
        onPointerDown={onAppIconPointerDown}
        onPointerMove={onAppIconPointerMove}
        onPointerUp={onAppIconPointerUp}
        className="fixed z-50 w-11 h-11 rounded-full bg-card border border-border shadow-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors touch-none select-none"
        style={{ left: appIconPos.x, top: appIconPos.y, cursor: 'grab' }}
        title={t('app.downloadTitle')}
      >
        <Download size={18} />
      </button>
      {/* 主内容区域 */}
      <main className="flex-1 overflow-auto flex flex-col relative z-10">

        <DesktopSyncIndicator />
        <DesktopSessionGuard />
        {children}
      </main>

      {/* 应用下载弹窗（手机APP / 电脑端）- 放在 main 外部避免地图组件层叠上下文遮挡 */}
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
                  <Download size={18} />
                  {t('app.downloadTitle')}
                </h2>
                <button
                  onClick={() => setShowAppDownload(false)}
                  className="p-1 rounded-md hover:bg-muted text-muted-foreground"
                >
                  <X size={18} />
                </button>
              </div>

              {/* 下载方式切换：手机APP / 电脑端（桌面端形态不显示电脑端） */}
              {!desktopMode && (
                <div className="flex gap-1 px-5 pt-4">
                  {([
                    { key: 'mobile' as const, icon: Smartphone, label: t('app.tabMobile') },
                    { key: 'desktop' as const, icon: MonitorDown, label: t('app.tabDesktop') },
                  ]).map((tab) => {
                    const TabIcon = tab.icon
                    const active = appTab === tab.key
                    return (
                      <button
                        key={tab.key}
                        onClick={() => setAppTab(tab.key)}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm rounded-lg border transition-colors ${
                          active
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'border-border text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        <TabIcon size={14} />
                        {tab.label}
                      </button>
                    )
                  })}
                </div>
              )}

              {/* 弹窗内容 */}
              <div className="p-5 flex flex-col items-center space-y-4">
                {appTab === 'desktop' ? (
                  /* 电脑端：从桌面版分发取最新安装包，点击后由浏览器接管下载 */
                  desktopVersionLoading ? (
                    <div className="py-8 text-muted-foreground flex flex-col items-center gap-2">
                      <Loader2 size={24} className="animate-spin" />
                      <span className="text-sm">{t('app.loadingVersion')}</span>
                    </div>
                  ) : desktopRelease ? (
                    <>
                      <MonitorDown size={44} className="text-primary" />
                      <div className="text-center">
                        <p className="text-sm font-semibold text-foreground">
                          {t('app.latestVersion')} V{desktopRelease.version}
                          {desktopRelease.file_size_display ? ` · ${desktopRelease.file_size_display}` : ''}
                        </p>
                        {desktopRelease.release_notes && (
                          <p className="text-xs text-muted-foreground mt-1 max-w-xs whitespace-pre-line">
                            {desktopRelease.release_notes}
                          </p>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{t('app.desktopInstallHint')}</p>
                      {/* 交给浏览器下载（新标签），与 APK 的 <a download> 行为区分：安装包走浏览器下载管理 */}
                      <a
                        href={getFullDownloadUrl(desktopRelease.download_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity text-sm font-medium"
                      >
                        <Download size={16} />
                        <span>{t('app.downloadDesktop')}</span>
                      </a>
                    </>
                  ) : (
                    <div className="py-8 text-muted-foreground text-center">
                      <p className="text-sm">{t('app.desktopNoVersion')}</p>
                      <p className="text-xs mt-1">{t('app.desktopUploadHint')}</p>
                    </div>
                  )
                ) : versionLoading ? (
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
                        <div className="bg-card p-3 rounded-lg shadow-sm border border-border">
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
      <Toaster />
      {/* 桌面版 OTA 更新提示（网页端自动静默：接口 404） */}
      <DesktopUpdateDialog />
    </div>
  )
}
