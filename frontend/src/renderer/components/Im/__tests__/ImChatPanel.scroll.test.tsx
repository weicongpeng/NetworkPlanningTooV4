/** 会话区贴底：发送时先滚一次，消息渲染后内容变高还要再补滚到最新。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

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
  IM_CHUNK_SIZE: 512 * 1024,
  imApi: {
    conversations: vi.fn(), contacts: vi.fn(), messages: vi.fn(), send: vi.fn(),
    markRead: vi.fn(), createConversation: vi.fn(), createGroup: vi.fn(),
    uploadAttachment: vi.fn(), downloadAttachment: vi.fn(), attachmentBlob: vi.fn(),
  },
}))

vi.mock('../../../store/authStore', () => ({
  useAuthStore: (selector: (s: { user: { id: number } }) => unknown) => selector({ user: { id: 1 } }),
}))

vi.mock('../ImComposer', () => ({
  ImComposer: ({ onSent }: { onSent?: () => void }) => (
    <button type="button" data-testid="composer" onClick={() => onSent?.()}>发送</button>
  ),
}))
vi.mock('../ImMessageItem', () => ({
  ImMessageItem: ({ message }: { message: { content_text?: string } }) => (
    <div data-testid="message">{message.content_text}</div>
  ),
}))
vi.mock('../ImAvatar', () => ({ ImAvatar: () => <div /> }))
vi.mock('../ImGroupMembersDialog', () => ({ ImGroupMembersDialog: () => null }))
vi.mock('../ImForwardDialog', () => ({ ImForwardDialog: () => null }))
vi.mock('../ImImageLightbox', () => ({ ImImageLightbox: () => null }))
vi.mock('../ImMessageContextMenu', () => ({ ImMessageContextMenu: () => null }))

let resizeCallback: (() => void) | null = null
const observeMock = vi.fn()
class MockResizeObserver {
  constructor(callback: () => void) { resizeCallback = callback }
  observe() { observeMock() }
  disconnect() { resizeCallback = null }
}

const scrollToMock = vi.fn()

import { useImStore } from '../../../store/imStore'
import { ImChatPanel } from '../ImChatPanel'
import type { ImConversation, ImMessage } from '../types'

function message(id: number): ImMessage {
  return {
    id, conversation_id: 7, sender_id: 1, sender_name: '我', kind: 'text',
    content_text: `消息-${id}`, attachment: null, client_msg_id: null,
    created_at: new Date().toISOString(),
  }
}

const conversation: ImConversation = {
  id: 7, kind: 'direct', name: null, group_key: null, other_user: null,
  member_count: 2, last_message: null, last_message_at: null, unread: 0, muted: false,
}

describe('会话区发送后贴底', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resizeCallback = null
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true, value: MockResizeObserver,
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true, value: scrollToMock,
    })
    useImStore.setState({
      conversations: [conversation],
      messages: { 7: [message(1)] },
      cursors: { 7: { next: 1, prev: 1, hasMore: false } },
      activeConversationId: 7,
      online: {}, lightbox: null, error: null, errorScope: null,
      replyTo: null, sending: false, uploadProgress: null,
      draftFor: vi.fn(() => ''), setDraft: vi.fn(),
      sendText: vi.fn().mockResolvedValue(true),
      markConversationRead: vi.fn(),
      setReplyTo: vi.fn(), deleteMessage: vi.fn(), forwardMessages: vi.fn(),
      loadMessages: vi.fn().mockResolvedValue(undefined),
    } as unknown as Partial<ReturnType<typeof useImStore.getState>>)
  })

  it('内容在发送滚动之后变高时，ResizeObserver 补滚到新底部', () => {
    const { container } = render(
      <ImChatPanel conversation={conversation} narrow={false} onBack={vi.fn()} />,
    )
    const scrollEl = container.querySelector('.overflow-y-auto') as HTMLElement
    expect(scrollEl).toBeTruthy()
    let height = 1000
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scrollEl, 'scrollTop', { configurable: true, writable: true, value: 600 })

    // 用户此前停留在历史位置
    fireEvent.scroll(scrollEl)
    scrollToMock.mockClear()

    // 发送：先滚到当前底部
    fireEvent.click(screen.getByTestId('composer'))
    expect(scrollToMock).toHaveBeenLastCalledWith({ top: 1000, behavior: 'auto' })

    // 新消息渲染后内容变高：监听回调应再贴一次底
    scrollToMock.mockClear()
    height = 1400
    act(() => { resizeCallback?.() })
    expect(scrollToMock).toHaveBeenLastCalledWith({ top: 1400, behavior: 'auto' })
  })

  it('会话头部不显示头像与在线状态，群成员数以「名称(数量)」显示在名称旁', () => {
    const direct = render(
      <ImChatPanel conversation={conversation} narrow={false} onBack={vi.fn()} />,
    )
    expect(direct.container.querySelector('header')?.textContent).toContain('自己')
    expect(direct.container.querySelector('header')?.textContent).not.toContain('(2)')
    expect(screen.queryByText('在线')).toBeNull()
    expect(screen.queryByText('离线')).toBeNull()
    direct.unmount()

    const group: ImConversation = {
      ...conversation, id: 8, kind: 'custom_group', name: 'test', member_count: 10,
    }
    useImStore.setState({ conversations: [group], messages: { 8: [] }, cursors: {} })
    const grouped = render(
      <ImChatPanel conversation={group} narrow={false} onBack={vi.fn()} />,
    )
    const header = grouped.container.querySelector('header') as HTMLElement
    expect(header.textContent).toContain('test')
    expect(header.textContent).toContain('(10)')
    expect(screen.queryByText('10 位成员')).toBeNull()
  })

  it('不再渲染「回到最新」控件', () => {
    render(<ImChatPanel conversation={conversation} narrow={false} onBack={vi.fn()} />)
    expect(screen.queryByText('回到最新')).toBeNull()
  })

  it('挂载时无会话、之后点开会话也要补上内容高度监听', () => {
    const { rerender } = render(
      <ImChatPanel conversation={null} narrow={false} onBack={vi.fn()} />,
    )
    expect(observeMock).not.toHaveBeenCalled()

    rerender(<ImChatPanel conversation={conversation} narrow={false} onBack={vi.fn()} />)
    expect(observeMock).toHaveBeenCalled()
  })

  it('消息条数不变但内容被替换（乐观消息换成服务端消息）时也会补滚', () => {
    const { container } = render(
      <ImChatPanel conversation={conversation} narrow={false} onBack={vi.fn()} />,
    )
    const scrollEl = container.querySelector('.overflow-y-auto') as HTMLElement
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 1000 })
    scrollToMock.mockClear()

    fireEvent.click(screen.getByTestId('composer'))
    expect(scrollToMock).toHaveBeenLastCalledWith({ top: 1000, behavior: 'auto' })
    scrollToMock.mockClear()

    act(() => {
      useImStore.setState({ messages: { 7: [{ ...message(1), content_text: '服务端消息' }] } })
    })
    expect(scrollToMock).toHaveBeenLastCalledWith({ top: 1000, behavior: 'auto' })
  })
})
