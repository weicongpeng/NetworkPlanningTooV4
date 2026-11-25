/** 真实 ImWindow 组件树冒烟：窗口壳、Tab 切换、置顶层级、最小化与 Esc。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

// 与真实 i18next 行为对齐：t(key, 'default') / t(key, { defaultValue, ...interpolation })
// 两种写法都要能拿到可读文案，否则 React 会把 options 对象当子节点渲染。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg?: string | Record<string, unknown>) => {
      if (typeof arg === 'string') return arg
      if (arg && typeof arg === 'object') {
        const values = arg as Record<string, unknown>
        return String(values.defaultValue ?? key).replace(
          /\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name] ?? ''))
      }
      return key
    },
    i18n: { language: 'zh' },
  }),
}))

vi.mock('../../../services/api', () => ({
  IM_CHUNK_SIZE: 2 * 1024 * 1024,
  imApi: {
    conversations: vi.fn(), contacts: vi.fn(), messages: vi.fn(), send: vi.fn(),
    markRead: vi.fn(), createConversation: vi.fn(), createGroup: vi.fn(),
    uploadAttachment: vi.fn(), downloadAttachment: vi.fn(), attachmentBlob: vi.fn(),
  },
}))

vi.mock('../../../store/authStore', () => ({
  useAuthStore: (selector: (state: any) => any) => selector({ user: { id: 1, username: 'alice' } }),
}))

import { imApi } from '../../../services/api'
import { useImStore } from '../../../store/imStore'
import { ImWindow } from '../ImWindow'

const GEOMETRY_KEY = 'im-window-geometry-user-1'
const MAXIMIZED_KEY = 'im-window-maximized-user-1'

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true, writable: true, value: width,
  })
  Object.defineProperty(window, 'innerHeight', {
    configurable: true, writable: true, value: height,
  })
}

function windowSize(): { w: number; h: number } {
  const dialog = screen.getByRole('dialog') as HTMLElement
  return { w: parseFloat(dialog.style.width), h: parseFloat(dialog.style.height) }
}

describe('沟通助手窗口', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setViewport(1024, 768)
    useImStore.getState().stopPolling()
    useImStore.setState({
      open: true, activeTab: 'messages', activeConversationId: null,
      conversations: [], contacts: null, messages: {}, cursors: {},
      online: {}, unreadTotal: 0, drafts: {}, lightbox: null,
      groupDialog: false, error: null, uploadProgress: null,
    })
    vi.mocked(imApi.conversations).mockResolvedValue({
      success: true, data: { items: [], server_time: '' },
    } as any)
    vi.mocked(imApi.contacts).mockResolvedValue({
      success: true, data: { users: [], groups: [], online_count: 0, server_time: '' },
    } as any)
  })

  it('渲染固定置顶窗口壳、双 Tab 与空会话引导', () => {
    render(<ImWindow userId={1} desktopMode={false} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: '沟通助手' })
    expect(dialog.className).toContain('z-[6000]')
    expect(screen.getByText('消息')).toBeTruthy()
    expect(screen.getByText('通讯录')).toBeTruthy()
    expect(screen.getByText('选择一个会话开始协作')).toBeTruthy()
  })

  it('标题栏不显示「协」徽标图标', () => {
    render(<ImWindow userId={1} desktopMode={false} onClose={vi.fn()} />)
    expect(screen.queryByText('协')).toBeNull()
  })

  it('标题栏不再显示在线人数统计', () => {
    useImStore.setState({ contacts: { users: [], groups: [], online_count: 3 } as any })
    render(<ImWindow userId={1} desktopMode={false} onClose={vi.fn()} />)
    expect(screen.queryByText(/人在线/)).toBeNull()
  })

  it('切换通讯录 Tab 展示空联系人状态与建群入口', () => {
    render(<ImWindow userId={1} desktopMode={false} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('通讯录'))
    expect(useImStore.getState().activeTab).toBe('contacts')
    expect(screen.getByText('建群')).toBeTruthy()
    expect(screen.getByText('暂无联系人')).toBeTruthy()
  })

  it('右上角不再提供置顶与最小化按钮，窗口层级固定', () => {
    render(<ImWindow userId={1} desktopMode={false} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog').className).toContain('z-[6000]')
    expect(screen.queryByTitle('取消置顶')).toBeNull()
    expect(screen.queryByTitle('窗口置顶')).toBeNull()
    expect(screen.queryByTitle('最小化到悬浮图标')).toBeNull()
    expect(screen.getByTitle('最大化')).toBeTruthy()
    expect(screen.getByTitle('关闭并隐藏到悬浮图标')).toBeTruthy()
  })

  it('关闭按钮只回调 onClose，不销毁会话状态', () => {
    const onClose = vi.fn()
    useImStore.setState({ activeConversationId: 9 })
    render(<ImWindow userId={1} desktopMode={false} onClose={onClose} />)
    fireEvent.click(screen.getByTitle('关闭并隐藏到悬浮图标'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(useImStore.getState().activeConversationId).toBe(9)
  })

  it('Esc 关闭窗口；输入聚焦时不拦截', () => {
    const onClose = vi.fn()
    render(<ImWindow userId={1} desktopMode={false} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    input.remove()
  })

  it('桌面端切页面/窗口缩放导致视口临时变小时不缩水，视口恢复后回到原尺寸', () => {
    const preferred = { x: 60, y: 60, w: 900, h: 600 }
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify(preferred))
    render(<ImWindow userId={1} desktopMode onClose={vi.fn()} />)
    expect(windowSize()).toEqual({ w: 900, h: 600 })

    act(() => {
      setViewport(700, 500)
      window.dispatchEvent(new Event('resize'))
    })
    expect(windowSize().w).toBeLessThan(900)
    // 视口钳制结果绝不能写回用户偏好，否则切回页面后窗口永久变小
    expect(JSON.parse(localStorage.getItem(GEOMETRY_KEY)!)).toEqual(preferred)

    act(() => {
      setViewport(1024, 768)
      window.dispatchEvent(new Event('resize'))
    })
    expect(windowSize()).toEqual({ w: 900, h: 600 })
  })

  it('最大化状态持久化：重新打开窗口仍铺满，还原后回到原尺寸', () => {
    const preferred = { x: 60, y: 60, w: 900, h: 600 }
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify(preferred))
    const first = render(<ImWindow userId={1} desktopMode onClose={vi.fn()} />)
    fireEvent.click(screen.getByTitle('最大化'))
    // 与图片编辑页最大化一致：铺满整个内容区（桌面标题栏 32px 以下），不留 8px 边距
    expect(windowSize()).toEqual({ w: 1024, h: 736 })
    expect((screen.getByRole('dialog') as HTMLElement).style.top).toBe('32px')
    expect(localStorage.getItem(MAXIMIZED_KEY)).toBe('1')
    expect(JSON.parse(localStorage.getItem(GEOMETRY_KEY)!)).toEqual(preferred)

    // 切到其它页面再回来（窗口重新挂载）仍保持最大化，不会退回普通尺寸
    first.unmount()
    render(<ImWindow userId={1} desktopMode onClose={vi.fn()} />)
    expect(windowSize()).toEqual({ w: 1024, h: 736 })
    expect(screen.getByTitle('还原')).toBeTruthy()

    fireEvent.click(screen.getByTitle('还原'))
    expect(windowSize()).toEqual({ w: 900, h: 600 })
    expect(localStorage.getItem(MAXIMIZED_KEY)).toBe('0')
  })
})
