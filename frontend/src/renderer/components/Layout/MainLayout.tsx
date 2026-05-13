import { Link, useLocation } from 'react-router-dom'
import {
  Home,
  Database,
  Settings,
  Map,
  Network,
  Layers,
  MapPin,
  Shield
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export function MainLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const location = useLocation()

  const navigation = [
    { name: t('nav.home'), href: '/', icon: Home },
    { name: t('nav.data'), href: '/data', icon: Database },
    { name: t('nav.pci'), href: '/pci', icon: Settings },
    { name: t('nav.neighbor'), href: '/neighbor', icon: Network },
    { name: t('nav.tac'), href: '/tac', icon: Layers },
    { name: t('nav.tacPlanning'), href: '/tac-planning', icon: MapPin },
    { name: t('nav.map'), href: '/map', icon: Map },
    { name: t('nav.config'), href: '/license', icon: Shield }
  ]

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
              const Icon = item.icon
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
                  <div className="flex-shrink-0 w-6 flex justify-center">
                    <Icon size={20} />
                  </div>
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

          {/* 底部版本信息 - 配色与侧边栏一致，无分隔线 */}
          <div
            className="text-xs"
            style={{
              opacity: sidebarOpen ? 1 : 0,
              transition: 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
              color: 'hsl(var(--muted-foreground))',
              flexShrink: 0,
            }}
          >
            <div className="px-4 py-3">
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
        {children}
      </main>
    </div>
  )
}
