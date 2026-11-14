/** 真实 ImWindow 组件树冒烟：窗口壳、Tab 切换、置顶层级、最小化与 Esc。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

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
  IM_CHUNK_SIZE: 512 * 1024,
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

describe('项目沟通窗口', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    const dialog = screen.getByRole('dialog', { name: '项目沟通' })
    expect(dialog.className).toContain('z-[6000]')
    expect(screen.getByText('消息')).toBeTruthy()
    expect(screen.getByText('通讯录')).toBeTruthy()
    expect(screen.getByText('选择一个会话开始协作')).toBeTruthy()
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
})
