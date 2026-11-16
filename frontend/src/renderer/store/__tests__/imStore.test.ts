import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/messageSound', () => ({
  playImMessageSound: vi.fn(), playImMentionSound: vi.fn(),
}))

vi.mock('../../services/api', () => ({
  IM_CHUNK_SIZE: 512 * 1024,
  imApi: {
    conversations: vi.fn(), contacts: vi.fn(), messages: vi.fn(), send: vi.fn(),
    markRead: vi.fn(), createConversation: vi.fn(), createGroup: vi.fn(),
    uploadAttachment: vi.fn(), downloadAttachment: vi.fn(), members: vi.fn(),
  },
}))

import { imApi } from '../../services/api'
import { IM_MESSAGE_EVENT } from '../../services/websocketService'
import { playImMessageSound } from '../../utils/messageSound'
import { attachImEvents, useImStore } from '../imStore'
import type {
  ImConversation, ImConversationsData, ImEnvelope, ImMessage, ImMessageKind, ImMessagesPage,
} from '../../components/Im/types'

function message(id: number, text = `消息-${id}`): ImMessage {
  return {
    id, conversation_id: 7, sender_id: 1, sender_name: 'alice', kind: 'text',
    content_text: text, attachment: null, client_msg_id: null,
    created_at: new Date().toISOString(),
  }
}

/** 会话列表轮询用：last_message 是桌面端无 WS 时唯一能看到的新消息线索 */
function conversation(lastId: number | null, senderId = 2,
                      kind: ImMessageKind = 'text'): ImConversation {
  return {
    id: 7, kind: 'direct', name: null, group_key: null, other_user: null,
    member_count: 2,
    last_message: lastId === null ? null : {
      id: lastId, kind, preview: 'hi', sender_id: senderId,
      sender_name: 'alice', created_at: new Date().toISOString(),
    },
    last_message_at: null, unread: 0, muted: false,
  }
}

function conversationsPage(items: ImConversation[]): ImEnvelope<ImConversationsData> {
  return { success: true, data: { items, server_time: '' } }
}

function messagesPage(items: ImMessage[], next: number | null): ImEnvelope<ImMessagesPage> {
  return {
    success: true,
    data: {
      items, has_more: false, next_cursor: next, prev_cursor: items[0]?.id ?? null,
    },
  }
}

/** 排空若干微任务，让 Promise.allSettled().finally() 释放轮询在途标记 */
async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

describe('imStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 清掉模块级的 @ 去重集合与成员 in-flight 缓存，保证用例互不影响
    useImStore.getState().resetForUserSwitch()
    useImStore.getState().stopPolling()
    useImStore.setState({
      ...useImStore.getState(),
      activeConversationId: null, conversations: [], contacts: null,
      messages: {}, cursors: {}, online: {}, unreadTotal: 0, drafts: {},
      open: false, activeTab: 'messages', lightbox: null, error: null,
      mentionNotice: null, membersByConversation: {},
    })
    vi.mocked(imApi.markRead).mockResolvedValue({ success: true, data: {} } as any)
    vi.mocked(imApi.conversations).mockResolvedValue({ success: true, data: { items: [], server_time: '' } } as any)
    vi.mocked(imApi.contacts).mockResolvedValue({ success: true, data: { users: [], groups: [], online_count: 0, server_time: '' } } as any)
  })

  it('按 message_id 去重合并增量消息，并推进游标', async () => {
    vi.mocked(imApi.messages)
      .mockResolvedValueOnce({ success: true, data: {
        items: [message(1), message(2)], has_more: false, next_cursor: 2, prev_cursor: 1,
      } } as any)
      .mockResolvedValueOnce({ success: true, data: {
        items: [message(2), message(3)], has_more: false, next_cursor: 3, prev_cursor: 1,
      } } as any)

    await useImStore.getState().loadMessages(7, 'initial')
    await useImStore.getState().loadMessages(7, 'incremental')
    const list = useImStore.getState().messages[7]
    expect(list.map(item => item.id)).toEqual([1, 2, 3])
    expect(useImStore.getState().cursors[7].next).toBe(3)
  })

  it('发送文字：乐观插入 → 成功后替换为服务端消息并清空草稿', async () => {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 1 } } }))
    useImStore.setState({ activeConversationId: 7, drafts: { 1: { 7: '待发送' } } })
    vi.mocked(imApi.send).mockResolvedValue({ success: true, data: message(11, '待发送') } as any)

    const ok = await useImStore.getState().sendText('待发送')
    expect(ok).toBe(true)
    const list = useImStore.getState().messages[7]
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(11)
    expect(list[0].pending).toBeUndefined()
    expect(useImStore.getState().draftFor(7)).toBe('')
  })

  it('发送失败：保留输入并标记 failed，不残留 pending 态', async () => {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 1 } } }))
    useImStore.setState({ activeConversationId: 7 })
    vi.mocked(imApi.send).mockRejectedValue(new Error('network'))

    const ok = await useImStore.getState().sendText('重试消息')
    expect(ok).toBe(false)
    const list = useImStore.getState().messages[7]
    expect(list).toHaveLength(1)
    expect(list[0].failed).toBe(true)
    expect(list[0].pending).toBe(false)
    expect(list[0].content_text).toBe('重试消息')
  })

  it('在线状态事件同时更新 online / 通讯录 / 单聊会话', () => {
    useImStore.setState({
      contacts: { users: [{ id: 5, username: 'bob', is_online: false, city: '', operator: '' }],
                  groups: [], online_count: 0, server_time: '' },
      conversations: [{ id: 7, kind: 'direct', name: null, group_key: null,
                        other_user: { id: 5, username: 'bob', is_online: false },
                        member_count: 2, last_message: null, last_message_at: null,
                        unread: 0, muted: false }],
      online: { 5: false },
    })
    useImStore.getState().handlePresence({ user_id: 5, online: true })
    const state = useImStore.getState()
    expect(state.online[5]).toBe(true)
    expect(state.contacts?.users[0].is_online).toBe(true)
    expect(state.conversations[0].other_user?.is_online).toBe(true)
  })

  it('草稿按用户分桶，切换账号不串数据', () => {
    useImStore.setState({ activeConversationId: 7 })
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 1 } } }))
    useImStore.getState().setDraft('账号一的草稿')
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 2 } } }))
    expect(useImStore.getState().draftFor(7)).toBe('')
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 1 } } }))
    expect(useImStore.getState().draftFor(7)).toBe('账号一的草稿')
  })

  it('resetForUserSwitch 清空会话/消息/未读并停止轮询', () => {
    useImStore.setState({
      activeConversationId: 7, open: true, unreadTotal: 3,
      messages: { 7: [message(1)] },
      conversations: [{ id: 7, kind: 'direct', name: null, group_key: null,
                        other_user: null, member_count: 2, last_message: null,
                        last_message_at: null, unread: 3, muted: false }],
    })
    useImStore.getState().startPolling(1000)
    useImStore.getState().resetForUserSwitch()
    const state = useImStore.getState()
    expect(state.messages).toEqual({})
    expect(state.conversations).toEqual([])
    expect(state.unreadTotal).toBe(0)
    expect(state.open).toBe(false)
    expect(state.activeConversationId).toBeNull()
  })

  it('WS 新消息通知合并为一次刷新，并对当前会话补拉增量', () => {
    vi.useFakeTimers()
    vi.mocked(imApi.messages).mockResolvedValue({ success: true, data: {
      items: [message(4)], has_more: false, next_cursor: 4, prev_cursor: 1,
    } } as any)
    useImStore.setState({ activeConversationId: 7, open: true })
    useImStore.getState().handleImMessage({ conversation_id: 7, message_id: 3 })
    useImStore.getState().handleImMessage({ conversation_id: 7, message_id: 4 })
    vi.advanceTimersByTime(250)
    expect(vi.mocked(imApi.conversations)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(imApi.messages)).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  const emptyPage = {
    success: true,
    data: { items: [], has_more: false, next_cursor: null, prev_cursor: null },
  }

  it('会话创建成功后刷新列表失败，仍打开会话且不误报「发起会话失败」', async () => {
    vi.mocked(imApi.createConversation).mockResolvedValue({
      success: true, data: { id: 12, kind: 'direct' },
    } as any)
    vi.mocked(imApi.messages).mockResolvedValue(emptyPage as any)
    vi.mocked(imApi.conversations).mockRejectedValue(new Error('IM_RATE_LIMITED'))

    const id = await useImStore.getState().openDirect(5)
    expect(id).toBe(12)
    expect(useImStore.getState().activeConversationId).toBe(12)
    expect(useImStore.getState().error).toBeNull()
  })

  it('创建接口失败但会话已存在于列表时兜底打开，不报错', async () => {
    vi.mocked(imApi.createConversation).mockRejectedValue(new Error('IM_RELAY_FAILED'))
    vi.mocked(imApi.messages).mockResolvedValue(emptyPage as any)
    vi.mocked(imApi.conversations).mockResolvedValue({
      success: true,
      data: { items: [{
        id: 8, kind: 'direct', name: null, group_key: null,
        other_user: { id: 5, username: 'bob', is_online: true },
        member_count: 2, last_message: null, last_message_at: null,
        unread: 0, muted: false,
      }], server_time: '' },
    } as any)

    const id = await useImStore.getState().openDirect(5)
    expect(id).toBe(8)
    expect(useImStore.getState().activeConversationId).toBe(8)
    expect(useImStore.getState().error).toBeNull()
  })

  it('附件发送失败时返回失败文件，供输入区放回待发送列表', async () => {
    useImStore.setState({ activeConversationId: 7 })
    const okFile = new File(['a'], 'ok.png', { type: 'image/png' })
    const badFile = new File(['b'], 'bad.png', { type: 'image/png' })
    vi.mocked(imApi.uploadAttachment)
      .mockResolvedValueOnce({
        id: 1, original_name: 'ok.png', mime: 'image/png', size_bytes: 1, has_thumb: false,
      } as any)
      .mockRejectedValueOnce(new Error('upload failed'))
    vi.mocked(imApi.send).mockResolvedValue({ success: true, data: message(20) } as any)

    const failed = await useImStore.getState().sendFiles([okFile, badFile])
    expect(failed).toEqual([badFile])
  })

  it('收到他人消息才播放提示音，自己发出的消息不响', () => {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 1 } } }))
    const detach = attachImEvents()
    window.dispatchEvent(new CustomEvent(IM_MESSAGE_EVENT, {
      detail: { sender_id: 2, conversation_id: 7, message_id: 10 },
    }))
    expect(playImMessageSound).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new CustomEvent(IM_MESSAGE_EVENT, {
      detail: { sender_id: 1, conversation_id: 7, message_id: 11 },
    }))
    expect(playImMessageSound).toHaveBeenCalledTimes(1)
    detach()
  })

  it('被 @ 的 WS 通知只发 @ 提醒，不叠播普通提示音', () => {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 1 } } }))
    const detach = attachImEvents()
    window.dispatchEvent(new CustomEvent(IM_MESSAGE_EVENT, {
      detail: {
        conversation_id: 7, message_id: 301, sender_id: 2, sender_name: 'bob',
        mention_all: false, mentioned_user_ids: [1],
      },
    }))
    expect(playImMessageSound).not.toHaveBeenCalled()
    expect(useImStore.getState().mentionNotice).toMatchObject({
      conversationId: 7, senderName: 'bob', mentionAll: false,
    })
    detach()
  })

  it('@所有人 命中所有接收者，发送者自己不提醒', () => {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 1 } } }))
    const detach = attachImEvents()
    window.dispatchEvent(new CustomEvent(IM_MESSAGE_EVENT, {
      detail: {
        conversation_id: 7, message_id: 302, sender_id: 1, sender_name: 'alice',
        mention_all: true, mentioned_user_ids: [],
      },
    }))
    expect(useImStore.getState().mentionNotice).toBeNull()
    window.dispatchEvent(new CustomEvent(IM_MESSAGE_EVENT, {
      detail: {
        conversation_id: 7, message_id: 303, sender_id: 2, sender_name: 'bob',
        mention_all: true, mentioned_user_ids: [],
      },
    }))
    expect(useImStore.getState().mentionNotice?.mentionAll).toBe(true)
    expect(playImMessageSound).not.toHaveBeenCalled()
    detach()
  })

  it('同一条被 @ 消息经 WS 与轮询增量只提醒一次，历史方向不提醒', async () => {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 1 } } }))
    const item = {
      ...message(304), sender_id: 2, sender_name: 'bob',
      mentioned_me: true, mention_all: false,
    }
    vi.mocked(imApi.messages).mockResolvedValue({ success: true, data: {
      items: [item], has_more: false, next_cursor: 304, prev_cursor: 304,
    } } as any)
    useImStore.setState({ activeConversationId: 7, open: true })

    await useImStore.getState().loadMessages(7, 'initial')
    expect(useImStore.getState().mentionNotice).toBeNull()

    useImStore.getState().notifyMention({
      messageId: 304, conversationId: 7, senderName: 'bob', mentionAll: false,
    })
    const first = useImStore.getState().mentionNotice
    expect(first).not.toBeNull()

    await useImStore.getState().loadMessages(7, 'incremental')
    expect(useImStore.getState().mentionNotice).toBe(first)
    expect(useImStore.getState().mentionNotice?.key).toBe(first?.key)
  })

  it('ensureMembers 缓存复用，切账号清空成员缓存与 @ 去重记录', async () => {
    vi.mocked(imApi.members).mockResolvedValue({ success: true, data: [
      { id: 2, username: 'bob', is_online: true, city: '', operator: '', role: 'member' },
    ] } as any)
    const first = await useImStore.getState().ensureMembers(7)
    const second = await useImStore.getState().ensureMembers(7)
    expect(first).toBe(second)
    expect(imApi.members).toHaveBeenCalledTimes(1)
    expect(useImStore.getState().membersByConversation[7]).toHaveLength(1)

    useImStore.getState().resetForUserSwitch()
    expect(useImStore.getState().membersByConversation).toEqual({})
    expect(useImStore.getState().mentionNotice).toBeNull()
    await useImStore.getState().ensureMembers(7)
    expect(imApi.members).toHaveBeenCalledTimes(2)
  })

  const group = (joined: boolean) => ({
    id: 6, kind: 'custom_group', name: '别人的群', member_count: 3,
    is_auto: false, city: '', operator: '', joined,
  })

  it('openGroup 对未加入的群只给友好提示，不激活也不请求消息', async () => {
    useImStore.setState({
      conversations: [],
      contacts: { users: [], groups: [group(false)], online_count: 0, server_time: '' },
    } as any)

    const ok = await useImStore.getState().openGroup(6)
    expect(ok).toBe(false)
    expect(useImStore.getState().activeConversationId).toBeNull()
    expect(useImStore.getState().error).toBe('im.error.notGroupMember')
    expect(imApi.messages).not.toHaveBeenCalled()
  })

  it('openGroup 对已加入但列表未同步的群先刷新再激活，避免首次空态', async () => {
    vi.mocked(imApi.conversations).mockResolvedValue({ success: true, data: { items: [{
      id: 6, kind: 'custom_group', name: '三网沟通群', group_key: null,
      other_user: null, member_count: 3, last_message: null,
      last_message_at: null, unread: 0, muted: false,
    }], server_time: '' } } as any)
    vi.mocked(imApi.messages).mockResolvedValue({ success: true, data: {
      items: [], has_more: false, next_cursor: null, prev_cursor: null,
    } } as any)
    useImStore.setState({
      conversations: [],
      contacts: { users: [], groups: [group(true)], online_count: 0, server_time: '' },
    } as any)

    const ok = await useImStore.getState().openGroup(6)
    expect(ok).toBe(true)
    expect(useImStore.getState().activeConversationId).toBe(6)
    expect(useImStore.getState().conversations.some(c => c.id === 6)).toBe(true)
    expect(imApi.messages).toHaveBeenCalled()
    expect(useImStore.getState().error).toBeNull()
  })

  it('桌面端会话列表轮询补播「叮咚」：首次只建基线，自己发的与 system 不响', async () => {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 1 } } }))
    useImStore.setState({ open: true, activeConversationId: null })

    vi.mocked(imApi.conversations).mockResolvedValue(conversationsPage([conversation(10)]))
    await useImStore.getState().refreshConversations()
    expect(playImMessageSound).not.toHaveBeenCalled()

    vi.mocked(imApi.conversations).mockResolvedValue(conversationsPage([conversation(11)]))
    await useImStore.getState().refreshConversations()
    expect(playImMessageSound).toHaveBeenCalledTimes(1)

    // 同一条消息重复刷新不叠播
    await useImStore.getState().refreshConversations()
    expect(playImMessageSound).toHaveBeenCalledTimes(1)

    vi.mocked(imApi.conversations).mockResolvedValue(conversationsPage([conversation(12, 1)]))
    await useImStore.getState().refreshConversations()
    vi.mocked(imApi.conversations).mockResolvedValue(
      conversationsPage([conversation(13, 2, 'system')]))
    await useImStore.getState().refreshConversations()
    expect(playImMessageSound).toHaveBeenCalledTimes(1)
  })

  it('轮询增量与 WS 共用同一条提示音：他人消息响，重复/自己/被@不叠播', async () => {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 1 } } }))
    useImStore.setState({ activeConversationId: 7, open: true })
    vi.mocked(imApi.messages)
      .mockResolvedValueOnce(messagesPage([], 100))
      .mockResolvedValueOnce(messagesPage([{ ...message(101), sender_id: 2 }], 101))
      .mockResolvedValueOnce(messagesPage([{ ...message(102), sender_id: 2 }], 102))
      .mockResolvedValueOnce(messagesPage([{ ...message(103), sender_id: 2, mentioned_me: true }], 103))
      .mockResolvedValueOnce(messagesPage([{ ...message(104), sender_id: 1 }], 104))

    await useImStore.getState().loadMessages(7, 'initial')
    expect(playImMessageSound).not.toHaveBeenCalled()

    const detach = attachImEvents()
    window.dispatchEvent(new CustomEvent(IM_MESSAGE_EVENT, {
      detail: { sender_id: 2, conversation_id: 7, message_id: 101 },
    }))
    expect(playImMessageSound).toHaveBeenCalledTimes(1)

    await useImStore.getState().loadMessages(7, 'incremental')
    expect(playImMessageSound).toHaveBeenCalledTimes(1) // WS 已登记，增量不双响

    await useImStore.getState().loadMessages(7, 'incremental')
    expect(playImMessageSound).toHaveBeenCalledTimes(2) // 无 WS 的桌面轮询路径

    await useImStore.getState().loadMessages(7, 'incremental')
    expect(playImMessageSound).toHaveBeenCalledTimes(2) // 被 @ 走专用三音，不叠播叮咚
    expect(useImStore.getState().mentionNotice).not.toBeNull()

    await useImStore.getState().loadMessages(7, 'incremental')
    expect(playImMessageSound).toHaveBeenCalledTimes(2) // 自己发的不响
    detach()
  })

  it('桌面共享模式窗口收起后仍轮询会话列表，网页端保持只在窗口打开时轮询', () => {
    vi.useFakeTimers()
    useImStore.setState({ open: false })
    useImStore.getState().startPolling(1000, true)
    vi.advanceTimersByTime(1000)
    expect(imApi.conversations).toHaveBeenCalledTimes(1)
    useImStore.getState().stopPolling()

    vi.clearAllMocks()
    useImStore.getState().startPolling(1000)
    vi.advanceTimersByTime(1000)
    expect(imApi.conversations).not.toHaveBeenCalled()
    useImStore.getState().stopPolling()
    vi.useRealTimers()
  })

  it('会话列表刷新失败（429/网络错误）时保留未读红点，不清空会话', async () => {
    useImStore.setState({ open: false })
    vi.mocked(imApi.conversations).mockResolvedValueOnce(
      conversationsPage([{ ...conversation(20), unread: 3 }]))
    await useImStore.getState().refreshConversations()
    expect(useImStore.getState().unreadTotal).toBe(3)

    vi.mocked(imApi.conversations).mockResolvedValueOnce({
      success: false, message: 'IM_RATE_LIMITED', code: 429,
    } as unknown as ImEnvelope<ImConversationsData>)
    await useImStore.getState().refreshConversations()
    expect(useImStore.getState().unreadTotal).toBe(3)
    expect(useImStore.getState().conversations).toHaveLength(1)
  })

  it('桌面端页面隐藏仍轮询未读，窗口重新可见时立即补刷一次', async () => {
    vi.useFakeTimers()
    vi.mocked(imApi.conversations).mockResolvedValue(conversationsPage([]) as any)
    const visibility = { value: 'hidden' as DocumentVisibilityState }
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get: () => visibility.value,
    })
    useImStore.setState({ open: false })
    useImStore.getState().startPolling(1000, true)
    vi.advanceTimersByTime(1000)
    expect(imApi.conversations).toHaveBeenCalledTimes(1) // hidden 也继续刷红点
    await flushMicrotasks() // 上一轮在途结束，释放连接

    visibility.value = 'visible'
    window.dispatchEvent(new Event('focus'))
    expect(imApi.conversations).toHaveBeenCalledTimes(2) // 立即补刷，不等下一个 tick
    window.dispatchEvent(new Event('focus'))
    expect(imApi.conversations).toHaveBeenCalledTimes(2) // 1s 节流避免重复打

    useImStore.getState().stopPolling()
    window.dispatchEvent(new Event('focus'))
    expect(imApi.conversations).toHaveBeenCalledTimes(2) // 停止后监听已移除
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    vi.useRealTimers()
  })

  it('一轮轮询在途时跳过后续 tick，避免打满 WebView2 连接与后端线程池', async () => {
    vi.useFakeTimers()
    let finishFirst: (value: unknown) => void = () => {}
    vi.mocked(imApi.conversations)
      .mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve }) as any)
      .mockResolvedValue(conversationsPage([]) as any)
    useImStore.setState({ open: false })
    useImStore.getState().startPolling(1000, true)
    // 3 个 tick 过去，第一个慢请求还没回来：只应有 1 个在途请求
    vi.advanceTimersByTime(3000)
    expect(imApi.conversations).toHaveBeenCalledTimes(1)

    finishFirst(conversationsPage([]))
    await flushMicrotasks()
    vi.advanceTimersByTime(1000)
    expect(imApi.conversations).toHaveBeenCalledTimes(2) // 释放后恢复轮询

    useImStore.getState().stopPolling()
    vi.useRealTimers()
  })

  it('发送消息不用全局自增 id 推进游标，对方的旧消息不再被永久跳过', async () => {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 1 } } }))
    useImStore.setState({ activeConversationId: 7 })
    vi.mocked(imApi.messages).mockResolvedValueOnce(messagesPage([message(5)], 5) as any)
    await useImStore.getState().loadMessages(7, 'initial')
    expect(useImStore.getState().cursors[7].next).toBe(5)

    // 自己发出的消息服务端 id=8，而对方 id=6/7 还没拉到
    vi.mocked(imApi.send).mockResolvedValueOnce({
      success: true, data: message(8, '我方'),
    } as any)
    vi.mocked(imApi.messages).mockResolvedValue({
      success: true, data: {
        items: [message(6), message(7), message(8)], has_more: false,
        next_cursor: 8, prev_cursor: 6,
      },
    } as any)
    vi.mocked(imApi.conversations).mockResolvedValue(conversationsPage([]) as any)

    expect(await useImStore.getState().sendText('我方')).toBe(true)
    await vi.waitFor(() => {
      const ids = useImStore.getState().messages[7].map(m => m.id)
      expect(ids).toContain(6)
      expect(ids).toContain(7)
    })
  })

  it('增量消息超过一页时循环补拉到 has_more=false', async () => {
    useImStore.setState({
      activeConversationId: 7,
      cursors: { 7: { next: 0, prev: 1, hasMore: true } },
    })
    vi.mocked(imApi.messages)
      .mockResolvedValueOnce({ success: true, data: {
        items: [message(1), message(2)], has_more: true, next_cursor: 2, prev_cursor: 1,
      } } as any)
      .mockResolvedValueOnce({ success: true, data: {
        items: [message(3)], has_more: false, next_cursor: 3, prev_cursor: 3,
      } } as any)
    await useImStore.getState().loadMessages(7, 'incremental')
    expect(imApi.messages).toHaveBeenCalledTimes(2)
    expect(vi.mocked(imApi.messages).mock.calls[1][1]).toMatchObject({ after_id: 2 })
    expect(useImStore.getState().messages[7].map(m => m.id)).toEqual([1, 2, 3])
    expect(useImStore.getState().cursors[7].next).toBe(3)
  })

  it('上拉历史不回退增量游标', async () => {
    useImStore.setState({
      activeConversationId: 7,
      cursors: { 7: { next: 20, prev: 10, hasMore: true } },
      messages: { 7: [message(10), message(20)] },
    })
    vi.mocked(imApi.messages).mockResolvedValueOnce({ success: true, data: {
      items: [message(5)], has_more: false, next_cursor: 5, prev_cursor: 5,
    } } as any)
    await useImStore.getState().loadMessages(7, 'older')
    expect(useImStore.getState().cursors[7].next).toBe(20)
    expect(useImStore.getState().cursors[7].prev).toBe(5)
    expect(useImStore.getState().messages[7].map(m => m.id)).toEqual([5, 10, 20])
  })

  it('每会话消息只保留最近 300 条，游标仍单独保留', async () => {
    const many = Array.from({ length: 320 }, (_, i) => message(i + 1))
    vi.mocked(imApi.messages).mockResolvedValueOnce({ success: true, data: {
      items: many, has_more: false, next_cursor: 320, prev_cursor: 1,
    } } as any)
    await useImStore.getState().loadMessages(7, 'initial')
    const list = useImStore.getState().messages[7]
    expect(list).toHaveLength(300)
    expect(list[0].id).toBe(21)
    expect(list[299].id).toBe(320)
    expect(useImStore.getState().cursors[7].next).toBe(320)
  })

  it('服务端最新消息越过本地正文时重拉一页补洞（红点有、正文没来）', async () => {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 1 } } }))
    useImStore.setState({
      activeConversationId: 7, open: true,
      messages: { 7: [message(1)] },
      cursors: { 7: { next: 1, prev: 1, hasMore: false } },
    })
    vi.mocked(imApi.conversations).mockResolvedValue(
      conversationsPage([{ ...conversation(9, 2), unread: 2 }]) as any)
    vi.mocked(imApi.messages).mockResolvedValue({ success: true, data: {
      items: [message(8), message(9)], has_more: false, next_cursor: 9, prev_cursor: 8,
    } } as any)

    await useImStore.getState().refreshConversations()
    await vi.waitFor(() => {
      expect(useImStore.getState().messages[7].some(m => m.id === 9)).toBe(true)
    })
  })
})
