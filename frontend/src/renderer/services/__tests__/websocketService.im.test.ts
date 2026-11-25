import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  IM_CHUNK_SIZE: 2 * 1024 * 1024,
  imApi: {
    conversations: vi.fn(), contacts: vi.fn(), messages: vi.fn(), send: vi.fn(),
    markRead: vi.fn(), createConversation: vi.fn(), createGroup: vi.fn(),
    uploadAttachment: vi.fn(), downloadAttachment: vi.fn(),
  },
}))

import { imApi } from '../api'
import {
  IM_MESSAGE_EVENT, IM_PRESENCE_EVENT, IM_RECALL_EVENT, IM_RESYNC_EVENT,
} from '../websocketService'
import { attachImEvents, useImStore } from '../../store/imStore'

function emit(name: string, detail: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

describe('协作沟通 WebSocket 事件接线', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useImStore.getState().stopPolling()
    useImStore.setState({
      activeConversationId: null, conversations: [], contacts: null,
      messages: {}, cursors: {}, online: {}, unreadTotal: 0, open: false,
    })
    vi.mocked(imApi.conversations).mockResolvedValue({
      success: true, data: { items: [], server_time: '' },
    } as any)
  })

  it('事件常量沿用 npt: 前缀且互不重复', () => {
    expect(new Set([
      IM_MESSAGE_EVENT, IM_RECALL_EVENT, IM_PRESENCE_EVENT, IM_RESYNC_EVENT,
    ]).size).toBe(4)
    expect(IM_MESSAGE_EVENT.startsWith('npt:')).toBe(true)
  })

  it('im_presence 事件即时更新通讯录在线状态', () => {
    useImStore.setState({
      contacts: { users: [{ id: 9, username: 'carol', is_online: false, city: '', operator: '' }],
                  groups: [], online_count: 0, server_time: '' },
    })
    const detach = attachImEvents()
    emit(IM_PRESENCE_EVENT, { user_id: 9, online: true })
    expect(useImStore.getState().online[9]).toBe(true)
    expect(useImStore.getState().contacts?.users[0].is_online).toBe(true)
    detach()
  })

  it('im_message 事件触发一次游标增量补拉', () => {
    vi.useFakeTimers()
    vi.mocked(imApi.messages).mockResolvedValue({
      success: true, data: { items: [], has_more: false, next_cursor: null, prev_cursor: null },
    } as any)
    useImStore.setState({ activeConversationId: 3, open: true })
    const detach = attachImEvents()
    emit(IM_MESSAGE_EVENT, { conversation_id: 3, message_id: 12 })
    emit(IM_MESSAGE_EVENT, { conversation_id: 3, message_id: 13 })
    vi.advanceTimersByTime(250)
    expect(vi.mocked(imApi.messages)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(imApi.messages)).toHaveBeenCalledWith(3, expect.objectContaining({ after_id: 0 }))
    detach()
    vi.useRealTimers()
  })

  it('im_recall 事件立即把对方消息改成撤回占位', async () => {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 1 } } }))
    useImStore.setState({
      messages: { 7: [{ id: 12, conversation_id: 7, sender_id: 2, sender_name: 'bob',
        kind: 'text', content_text: '原文', attachment: null, client_msg_id: null,
        created_at: new Date().toISOString() }] },
    })
    const detach = attachImEvents()
    emit(IM_RECALL_EVENT, { conversation_id: 7, message_id: 12, sender_id: 2, recalled_at: 'now' })
    await Promise.resolve()
    expect(useImStore.getState().messages[7][0]).toMatchObject({
      recalled: true, content_text: null,
    })
    detach()
  })

  it('重连 resync 事件补拉会话列表；detach 后不再响应', () => {
    const detach = attachImEvents()
    emit(IM_RESYNC_EVENT, {})
    expect(vi.mocked(imApi.conversations)).toHaveBeenCalledTimes(1)
    detach()
    emit(IM_RESYNC_EVENT, {})
    expect(vi.mocked(imApi.conversations)).toHaveBeenCalledTimes(1)
  })
})
