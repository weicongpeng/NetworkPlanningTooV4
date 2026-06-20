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
} from 'lucide-react'
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../store/authStore'
import { reloadUserMapSettings } from '../../store/mapStore'
import { GlobalTaskIndicator } from './GlobalTaskIndicator'

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
    { type: 'link', name: t('nav.config'), href: '/license', icon: Shield },
    ...(isAuthenticated && user?.is_admin ? [
      {
        type: 'group' as const,
        name: t('admin.title', '用户管理'),
        icon: Users,
        children: [
          { type: 'link' as const, name: t('admin.pcUser', 'PC用户'), href: '/admin/users' },
          { type: 'link' as const, name: t('admin.appUser', 'APP用户'), href: '/admin/app-users' },
        ],
      },
    ] : []),
  ]

  /** 判断分组是否展开：仅由用户手动切换控制，默认收起 */
  const isGroupExpanded = (group: NavGroup) => {
    return expandedGroups.has(group.name)
  }

  const toggleGroup = (groupName: string) => {
    const next = new Set(expandedGroups)
    if (next.has(groupName)) next.delete(groupName)
    else next.add(groupName)
    setExpandedGroups(next)
  }

  const handleLogout = async () => {
    await logout()
  }

  // 监听用户登录状态变化，切换地图设置
  useEffect(() => {
    reloadUserMapSettings()
  }, [isAuthenticated, user?.id])

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
            {/* >>> 样式箭头 */}
            <span
              style={{
                fontSize: '12px',
                fontWeight: 'bold',
                color: 'hsl(var(--muted-foreground))',
                letterSpacing: '-1px',
                transition: 'transform 0.35s cubic-bezier(0.25, 0.1, 0.25, 1)',
                transform: sidebarOpen ? 'rotate(0deg)' : 'rotate(180deg)',
                display: 'flex',
                gap: '2px',
              }}
            >
              {'>>>'}
            </span>
          </button>
        </aside>
      </div>

      {/* 主内容区域 */}
      <main className="flex-1 overflow-auto flex flex-col relative z-10">
        <GlobalTaskIndicator />
        {children}
      </main>
    </div>
  )
}
