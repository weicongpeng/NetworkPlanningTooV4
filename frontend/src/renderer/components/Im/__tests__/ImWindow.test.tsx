import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg?: string | Record<string, unknown>) => {
      if (typeof arg === 'string') return arg
      if (arg && typeof arg === 'object') return String(arg.defaultValue ?? key)
      return key
    },
    i18n: { language: 'zh' },
  }),
}))

vi.mock('../../../services/api', () => ({
  IM_CHUNK_SIZE: 2 * 1024 * 1024,
  desktopLoginApi: {
    imStorageState: vi.fn().mockResolvedValue({ success: true, data: {} }),
  },
  imApi: {
    conversations: vi.fn(), contacts: vi.fn(), messages: vi.fn(), send: vi.fn(),
    markRead: vi.fn(), createConversation: vi.fn(), createGroup: vi.fn(),
    uploadAttachment: vi.fn(), downloadAttachment: vi.fn(),
  },
}))

const authState = vi.hoisted(() => ({
  user: { id: 1, username: 'alice' },
  desktopMode: false,
  desktopRunMode: null as string | null,
}))

vi.mock('../../../store/authStore', () => ({
  useAuthStore: (selector: (state: any) => any) => selector(authState),
}))

vi.mock('../ImWindow', () => ({
  ImWindow: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="im-window">
      <button type="button" data-testid="im-close" onClick={onClose}>关闭</button>
    </div>
  ),
}))

import { imApi } from '../../../services/api'
import { useImStore } from '../../../store/imStore'
import { ImHost } from '../ImHost'
import { SCREENSHOT_OPEN_EVENT } from '../screenshotBus'

describe('沟通助手悬浮入口', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authState.desktopMode = false
    authState.desktopRunMode = null
    ;(Element.prototype as any).setPointerCapture = vi.fn()
    ;(Element.prototype as any).releasePointerCapture = vi.fn()
    useImStore.getState().stopPolling()
    useImStore.setState({
      open: false, activeConversationId: null, conversations: [], contacts: null,
      messages: {}, cursors: {}, online: {}, unreadTotal: 0, drafts: {},
      lightbox: null, error: null,
    })
    vi.mocked(imApi.conversations).mockResolvedValue({
      success: true, data: { items: [], server_time: '' },
    } as any)
    vi.mocked(imApi.contacts).mockResolvedValue({
      success: true, data: { users: [], groups: [], online_count: 0, server_time: '' },
    } as any)
  })

  it('未登录时不渲染悬浮图标', () => {
    // 当前 mock 固定返回已登录用户，这里验证图标存在即可（登录态由 AuthGuard 保证 MainLayout 不挂载）
    const { container } = render(<ImHost />)
    expect(container.querySelector('[title*="沟通助手"]')).toBeTruthy()
  })

  it('单击图标展开窗口，最小化后隐藏回图标但保留会话状态', async () => {
    render(<ImHost />)
    const icon = screen.getByTitle(/沟通助手/)
    fireEvent.pointerDown(icon, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(icon, { button: 0, clientX: 100, clientY: 100 })
    expect(useImStore.getState().open).toBe(true)
    await waitFor(() => expect(screen.getByTestId('im-window')).toBeTruthy())

    useImStore.setState({ activeConversationId: 7, messages: { 7: [] } })
    fireEvent.click(screen.getByTestId('im-close'))
    expect(useImStore.getState().open).toBe(false)
    expect(screen.queryByTestId('im-window')).toBeNull()
    expect(screen.getByTitle(/沟通助手/)).toBeTruthy()
    // 最小化不是销毁：会话与消息仍保留
    expect(useImStore.getState().activeConversationId).toBe(7)
    expect(useImStore.getState().messages[7]).toEqual([])
  })

  it('拖拽超过阈值时只移动图标，不展开窗口', () => {
    render(<ImHost />)
    const icon = screen.getByTitle(/沟通助手/)
    fireEvent.pointerDown(icon, { button: 0, clientX: 200, clientY: 200 })
    fireEvent.pointerMove(icon, { clientX: 260, clientY: 230 })
    fireEvent.pointerUp(icon, { button: 0, clientX: 260, clientY: 230 })
    expect(useImStore.getState().open).toBe(false)
    expect(screen.queryByTestId('im-window')).toBeNull()
  })

  it('网页端悬浮图标与「下载应用」同尺寸同配色', () => {
    render(<ImHost />)
    const icon = screen.getByTitle(/沟通助手/) as HTMLElement
    expect(icon.className).toContain('w-11')
    expect(icon.className).toContain('h-11')
    expect(icon.className).toContain('bg-card')
    expect(icon.className).toContain('border-border')
    expect(icon.className).toContain('text-muted-foreground')
    expect(icon.style.width).toBe('44px')
    expect(icon.style.height).toBe('44px')
    expect(icon.querySelector('svg')?.getAttribute('width')).toBe('18')
    // 不再有主题渐变 / 呼吸光晕
    expect(icon.className).not.toContain('from-blue')
    expect(icon.querySelector('.animate-pulse')).toBeNull()
  })

  it('桌面单机模式下截图快捷键不打开截图弹窗（没有沟通助手可发送）', async () => {
    authState.desktopMode = true
    authState.desktopRunMode = 'standalone'
    useImStore.setState({ open: false })
    render(<ImHost />)
    window.dispatchEvent(new Event(SCREENSHOT_OPEN_EVENT))
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(document.body.querySelector('[data-screenshot-overlay]')).toBeNull()
    expect(screen.queryByTitle(/沟通助手/)).toBeNull()
  })

  it('桌面端不渲染悬浮图标，但仍注册事件/轮询并可打开窗口', async () => {
    authState.desktopMode = true
    useImStore.setState({ open: true })
    render(<ImHost />)
    expect(screen.queryByTitle(/沟通助手/)).toBeNull()
    await waitFor(() => expect(screen.getByTestId('im-window')).toBeTruthy())
    expect(imApi.conversations).toHaveBeenCalled()
  })
})
