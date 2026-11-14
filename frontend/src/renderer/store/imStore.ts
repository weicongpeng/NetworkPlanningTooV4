/** 协作沟通状态仓库：消息按会话分桶、增量游标合并、WS 通知 + 可见窗口轮询兜底。 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { imApi } from '../services/api'
import { IM_MESSAGE_EVENT, IM_PRESENCE_EVENT, IM_RESYNC_EVENT } from '../services/websocketService'
import { playImMessageSound } from '../utils/messageSound'
import type {
  ImContactsData, ImConversation, ImLightboxSource, ImMember, ImMessage,
  ImSendMention, ImTab, ImUser,
} from '../components/Im/types'

type Cursors = Record<number, { next: number | null; prev: number | null; hasMore: boolean }>
type Drafts = Record<number, Record<number, string>>

/** store 只存数据，Toast 文案由 ImHost 组件层用 t() 渲染（store 不得依赖 react-i18next） */
interface MentionNotice {
  key: number
  conversationId: number
  senderName: string
  mentionAll: boolean
}

interface MentionEvent {
  messageId: number
  conversationId: number
  senderName: string
  mentionAll: boolean
}

interface ImState {
  open: boolean
  activeTab: ImTab
  activeConversationId: number | null
  conversations: ImConversation[]
  messages: Record<number, ImMessage[]>
  cursors: Cursors
  contacts: ImContactsData | null
  drafts: Drafts
  online: Record<number, boolean>
  unreadTotal: number
  loading: boolean
  error: string | null
  sending: boolean
  uploadProgress: { name: string; percent: number } | null
  lightbox: ImLightboxSource | null
  groupDialog: boolean
  /** 群成员缓存：@ 下拉与群成员弹窗共用，按会话 id 隔离 */
  membersByConversation: Record<number, ImMember[]>
  /** 最近一次「当前用户被 @」事件，ImHost 订阅后弹 Toast + 播专用音 */
  mentionNotice: MentionNotice | null
  /** 全局截图（Alt+Z / 输入框按钮）产出、等待送入当前会话输入框的 File */
  pendingScreenshot: File | null

  /** 截图弹窗确认后入队；截图时没有激活会话也能保留结果 */
  queueScreenshot: (file: File) => void
  /** 输入区消费并清空队列，返回待发送的截图 File */
  takeScreenshot: () => File | null
  setOpen: (open: boolean) => void
  toggleOpen: () => void
  setTab: (tab: ImTab) => void
  setActiveConversation: (id: number | null) => void
  setDraft: (text: string) => void
  draftFor: (conversationId: number | null) => string
  setLightbox: (value: ImState['lightbox']) => void
  setGroupDialog: (open: boolean) => void
  bootstrap: () => Promise<void>
  refreshConversations: () => Promise<void>
  refreshContacts: () => Promise<void>
  loadMessages: (id: number, direction?: 'initial' | 'older' | 'incremental') => Promise<void>
  sendText: (text: string, mention?: ImSendMention) => Promise<boolean>
  /** 返回发送失败的 File，供输入区把它们放回待发送列表 */
  sendFiles: (files: File[]) => Promise<File[]>
  /** 取群成员（带缓存与 in-flight 去重）；成员变更后用 invalidateMembers 失效 */
  ensureMembers: (conversationId: number) => Promise<ImMember[]>
  invalidateMembers: (conversationId: number) => void
  /** WS 与轮询增量两条路径统一入口，按 messageId 去重 */
  notifyMention: (event: MentionEvent) => void
  clearError: () => void
  openDirect: (userId: number) => Promise<number | null>
  /** true = 已进入会话，供 ImSidebar 决定是否切换到窄窗口聊天面板 */
  openGroup: (id: number) => Promise<boolean>
  createGroup: (name: string, memberIds: number[]) => Promise<number | null>
  /** 自建群管理：群主剔除成员 / 添加成员 / 解散群，成员主动退群，改群头像 */
  removeMember: (conversationId: number, userId: number) => Promise<boolean>
  addGroupMembers: (conversationId: number, memberIds: number[]) => Promise<boolean>
  leaveGroup: (conversationId: number) => Promise<boolean>
  dissolveGroup: (conversationId: number) => Promise<boolean>
  updateGroupAvatar: (conversationId: number, avatar: string) => Promise<boolean>
  /** 群资料 / 成员变更后的统一刷新与本地会话清理 */
  refreshGroupState: (conversationId: number) => Promise<void>
  forgetConversation: (conversationId: number) => void
  handleImMessage: (detail: any) => void
  handlePresence: (detail: any) => void
  resync: () => void
  startPolling: (intervalMs?: number) => void
  stopPolling: () => void
  resetForUserSwitch: () => void
}

function currentUserId(): number | null {
  try {
    const raw = localStorage.getItem('auth-storage')
    const id = JSON.parse(raw || '{}')?.state?.user?.id
    return typeof id === 'number' ? id : null
  } catch {
    return null
  }
}

function mergeMessages(existing: ImMessage[], incoming: ImMessage[]): ImMessage[] {
  const map = new Map<number, ImMessage>()
  existing.forEach(item => map.set(item.id, item))
  incoming.forEach(item => map.set(item.id, item))
  return Array.from(map.values()).sort((a, b) => a.id - b.id)
}

/**
 * store 只存「i18n key」，由 ImComposer 用 t() 渲染，避免 store 依赖 react-i18next。
 * 响应拦截器把 AxiosError 压成了普通对象 `{ success, message, code }`，所以旧代码里
 * `error?.response?.data?.detail` 恒为 undefined，任何后端错误都退化成同一句兜底文案；
 * 现在把原始错误打到控制台便于排查，界面上给出可翻译且可读的对应文案。
 */
function errorMessage(error: unknown, fallbackKey: string): string {
  const err = error as {
    response?: { data?: { detail?: unknown } }
    message?: string
    detail?: unknown
    code?: number
  } | null
  const raw = String(err?.response?.data?.detail || err?.message || err?.detail || '')
  if (raw.includes('IM_RATE_LIMITED') || err?.code === 429) return 'im.error.rateLimited'
  return fallbackKey
}

/** 把当前正在查看的会话未读归零：后端已排除自己的消息，这里避免刷新间隙闪红点 */
function clearActiveUnread(conversations: ImConversation[], activeId: number | null,
                           open: boolean): ImConversation[] {
  if (!open || activeId === null) return conversations
  return conversations.map(c => c.id === activeId && c.unread ? { ...c, unread: 0 } : c)
}

let pollTimer: number | null = null
let refreshTimer: number | null = null
let refreshQueued = false
/** 同一会话的成员请求合并为一个 Promise，避免每次键入 @ 都发请求 */
const membersInFlight = new Map<number, Promise<ImMember[]>>()
/** WS 与轮询可能都带来同一条被 @ 消息，按 messageId 去重；限长防长会话内存增长 */
const notifiedMentionIds = new Set<number>()
let mentionNoticeSeq = 0

function markMentionNotified(messageId: number): boolean {
  if (messageId <= 0 || notifiedMentionIds.has(messageId)) return false
  notifiedMentionIds.add(messageId)
  if (notifiedMentionIds.size > 500) {
    const oldest = notifiedMentionIds.values().next().value
    if (oldest !== undefined) notifiedMentionIds.delete(oldest)
  }
  return true
}

const initialState = {
  open: false,
  activeTab: 'messages' as ImTab,
  activeConversationId: null,
  conversations: [],
  messages: {},
  cursors: {},
  contacts: null,
  drafts: {},
  online: {},
  unreadTotal: 0,
  loading: false,
  error: null,
  sending: false,
  uploadProgress: null,
  lightbox: null,
  groupDialog: false,
  membersByConversation: {},
  mentionNotice: null,
  pendingScreenshot: null,
}

export const useImStore = create<ImState>()(
  persist(
    (set, get) => ({
      ...initialState,

      setOpen: open => set({ open }),
      toggleOpen: () => set(state => ({ open: !state.open })),
      setTab: activeTab => set({ activeTab }),
      setLightbox: lightbox => set({ lightbox }),
      setGroupDialog: groupDialog => set({ groupDialog }),
      clearError: () => set({ error: null }),

      queueScreenshot: file => set({ pendingScreenshot: file }),
      takeScreenshot: () => {
        const file = get().pendingScreenshot
        if (file) set({ pendingScreenshot: null })
        return file
      },

      setDraft: text => {
        const userId = currentUserId()
        const conversationId = get().activeConversationId
        if (userId === null || conversationId === null) return
        set(state => ({
          drafts: {
            ...state.drafts,
            [userId]: { ...(state.drafts[userId] || {}), [conversationId]: text },
          },
        }))
      },

      draftFor: conversationId => {
        const userId = currentUserId()
        if (userId === null || conversationId === null) return ''
        return get().drafts[userId]?.[conversationId] || ''
      },

      setActiveConversation: id => {
        set({ activeConversationId: id })
        if (id !== null) void get().loadMessages(id, 'initial')
      },

      bootstrap: async () => {
        set({ loading: true, error: null })
        try {
          await Promise.all([get().refreshConversations(), get().refreshContacts()])
        } catch (error) {
          console.warn('[IM] bootstrap failed', error)
          set({ error: errorMessage(error, 'im.error.load') })
        } finally {
          set({ loading: false })
        }
      },

      refreshConversations: async () => {
        const response = await imApi.conversations()
        const items = response?.data?.items || []
        const online = { ...get().online }
        items.forEach(conv => {
          if (conv.other_user) online[conv.other_user.id] = conv.other_user.is_online
        })
        const state = get()
        const conversations = clearActiveUnread(items, state.activeConversationId, state.open)
        set({
          conversations,
          online,
          unreadTotal: conversations.reduce((sum: number, c: ImConversation) => sum + (c.unread || 0), 0),
        })
      },

      refreshContacts: async () => {
        const response = await imApi.contacts()
        const contacts = response?.data || null
        const online = { ...get().online }
        contacts?.users?.forEach((user: ImUser) => { online[user.id] = user.is_online })
        set({ contacts, online })
      },

      ensureMembers: async id => {
        const cached = get().membersByConversation[id]
        if (cached) return cached
        const pending = membersInFlight.get(id)
        if (pending) return pending
        const task = (async () => {
          try {
            const members = (await imApi.members(id)).data || []
            set(s => ({
              membersByConversation: { ...s.membersByConversation, [id]: members },
            }))
            return members
          } catch (error) {
            console.warn('[IM] ensureMembers failed', id, error)
            return [] // 不缓存失败结果，下次输入 @ 可重试
          } finally {
            membersInFlight.delete(id)
          }
        })()
        membersInFlight.set(id, task)
        return task
      },

      invalidateMembers: id => set(s => {
        if (!(id in s.membersByConversation)) return {}
        const next = { ...s.membersByConversation }
        delete next[id]
        return { membersByConversation: next }
      }),

      notifyMention: event => {
        if (!markMentionNotified(event.messageId)) return
        set({
          mentionNotice: {
            key: (mentionNoticeSeq += 1),
            conversationId: event.conversationId,
            senderName: event.senderName,
            mentionAll: event.mentionAll,
          },
        })
      },

      loadMessages: async (id, direction = 'initial') => {
        const state = get()
        const cursor = state.cursors[id]
        const params = direction === 'older'
          ? { before_id: cursor?.prev ?? undefined, limit: 30 }
          : direction === 'incremental'
            ? { after_id: cursor?.next ?? 0, limit: 100 }
            : { limit: 30 }
        if (direction === 'older' && !params.before_id) return
        try {
          const page = (await imApi.messages(id, params)).data
          const merged = mergeMessages(
            direction === 'initial' ? [] : (get().messages[id] || []), page.items)
          set(s => ({
            messages: { ...s.messages, [id]: merged },
            cursors: {
              ...s.cursors,
              [id]: {
                next: page.next_cursor ?? cursor?.next ?? null,
                prev: page.prev_cursor ?? cursor?.prev ?? null,
                hasMore: page.has_more,
              },
            },
          }))
          // 桌面共享模式可能没有 WS，靠轮询兜底；只有 incremental 方向提醒，
          // 打开历史/上拉更早消息不触发，避免翻记录时刷屏。WS 路径与这里按 messageId 去重。
          if (direction === 'incremental') {
            const myId = currentUserId()
            page.items.forEach(item => {
              if (!item.mentioned_me || (myId !== null && item.sender_id === myId)) return
              get().notifyMention({
                messageId: item.id,
                conversationId: id,
                senderName: item.sender_name,
                mentionAll: Boolean(item.mention_all),
              })
            })
          }
          const last = merged[merged.length - 1]
          if (direction !== 'older' && last && get().activeConversationId === id) {
            void imApi.markRead(id, last.id).catch(() => {})
            set(s => ({
              conversations: s.conversations.map(c => c.id === id ? { ...c, unread: 0 } : c),
              unreadTotal: s.conversations.reduce((sum, c) => sum + (c.id === id ? 0 : c.unread || 0), 0),
            }))
          }
        } catch (error) {
          console.warn('[IM] loadMessages failed', error)
          set({ error: errorMessage(error, 'im.error.messages') })
        }
      },

      sendText: async (text, mention) => {
        const id = get().activeConversationId
        const value = text.trim()
        if (id === null || !value) return false
        const clientMsgId = `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const tempId = -Date.now()
        const optimistic: ImMessage = {
          id: tempId, conversation_id: id, sender_id: currentUserId() || 0,
          sender_name: '', kind: 'text', content_text: value, attachment: null,
          client_msg_id: clientMsgId, created_at: new Date().toISOString(), pending: true,
          mention_all: mention?.mention_all ?? false,
        }
        set(s => ({ sending: true, messages: { ...s.messages, [id]: mergeMessages(s.messages[id] || [], [optimistic]) } }))
        try {
          const message = (await imApi.send(id, {
            kind: 'text', content_text: value, client_msg_id: clientMsgId,
            // 只有真正 @ 了才带字段，普通消息请求体保持原样（兼容旧服务端）
            ...(mention && (mention.mentions.length > 0 || mention.mention_all)
              ? { mentions: mention.mentions, mention_all: mention.mention_all }
              : {}),
          })).data
          set(s => ({
            sending: false,
            messages: {
              ...s.messages,
              [id]: mergeMessages((s.messages[id] || []).filter(m => m.id !== tempId), [message]),
            },
            cursors: {
              ...s.cursors,
              [id]: {
                next: Math.max(message.id, s.cursors[id]?.next || 0),
                prev: s.cursors[id]?.prev ?? null,
                hasMore: s.cursors[id]?.hasMore || false,
              },
            },
          }))
          get().setDraft('')
          // 自己发出的消息立即把本会话未读归零，不等服务端刷新（后端也会排除自己的消息）
          set(s => ({
            conversations: clearActiveUnread(s.conversations, id, true),
            unreadTotal: s.conversations.reduce((sum, c) => sum + (c.id === id ? 0 : c.unread || 0), 0),
          }))
          void get().refreshConversations().catch(() => {})
          return true
        } catch (error) {
          console.warn('[IM] sendText failed', error)
          set(s => ({
            sending: false,
            messages: {
              ...s.messages,
              [id]: (s.messages[id] || []).map(m => m.id === tempId ? { ...m, pending: false, failed: true } : m),
            },
            error: errorMessage(error, 'im.error.send'),
          }))
          return false
        }
      },

      sendFiles: async files => {
        const id = get().activeConversationId
        if (id === null || !files.length) return []
        const failed: File[] = []
        for (const file of Array.from(files)) {
          set({ uploadProgress: { name: file.name, percent: 0 }, error: null })
          try {
            const attachment = await imApi.uploadAttachment(file, id, percent => {
              set({ uploadProgress: { name: file.name, percent } })
            })
            const kind = (file.type || '').startsWith('image/') ? 'image' : 'file'
            const message = (await imApi.send(id, {
              kind, attachment_id: attachment.id,
              client_msg_id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            })).data
            set(s => ({ messages: { ...s.messages, [id]: mergeMessages(s.messages[id] || [], [message]) } }))
          } catch (error) {
            console.warn('[IM] send attachment failed', file.name, error)
            failed.push(file)
            set({ error: errorMessage(error, 'im.error.file') })
          } finally {
            set({ uploadProgress: null })
          }
        }
        set(s => ({
          conversations: clearActiveUnread(s.conversations, id, true),
          unreadTotal: s.conversations.reduce((sum, c) => sum + (c.id === id ? 0 : c.unread || 0), 0),
        }))
        await get().refreshConversations().catch(() => {})
        return failed
      },

      openDirect: async userId => {
        let conversationId: number | null = null
        let lastError: unknown = null
        try {
          const result = (await imApi.createConversation({ kind: 'direct', peer_user_id: userId })).data
          conversationId = result?.id ?? null
        } catch (error) {
          // 服务端会话可能已创建成功，只是响应超时 / 共享模式 relay 转发失败。
          // 旧实现在这里直接报「发起会话失败」，但用户从会话列表仍能正常聊天。
          lastError = error
          console.warn('[IM] create_direct failed, retry from conversation list', error)
        }
        if (conversationId === null) {
          await get().refreshConversations().catch(() => {})
          const existing = get().conversations.find(
            c => c.kind === 'direct' && c.other_user?.id === userId)
          if (existing) conversationId = existing.id
        }
        if (conversationId === null) {
          set({ error: errorMessage(lastError, 'im.error.conversation') })
          return null
        }
        set({ error: null, activeTab: 'messages' })
        // 新建会话可能还没进列表，先刷新再激活，避免 ImWindow 派生 conversation=null 停在空态
        if (!get().conversations.some(c => c.id === conversationId)) {
          await get().refreshConversations().catch(() => {})
        }
        get().setActiveConversation(conversationId)
        // 刷新只是让列表出现新会话；失败不能反过来把已打开、可发消息的会话显示成失败
        void get().refreshConversations().catch(() => {})
        return conversationId
      },

      openGroup: async id => {
        const state = get()
        // 通讯录已过滤未加入的群，这里是纵深防御：其它入口（消息列表/深链）点到
        // 非成员会话时，后端 list_messages 会 404，激活只会落到空态 + 报错。
        const group = state.contacts?.groups.find(g => g.id === id)
        if (group && !group.joined) {
          console.warn('[IM] openGroup rejected: not a member of conversation', id)
          set({ error: 'im.error.notGroupMember' })
          return false
        }
        // 刚加入/刚建好的群可能还没进会话列表，先补齐再激活
        if (!state.conversations.some(c => c.id === id)) {
          await get().refreshConversations().catch(() => {})
        }
        set({ error: null, activeTab: 'messages' })
        get().setActiveConversation(id)
        void get().refreshConversations().catch(() => {})
        return true
      },

      createGroup: async (name, memberIds) => {
        let conversationId: number | null = null
        let lastError: unknown = null
        try {
          const result = (await imApi.createGroup(name, memberIds)).data
          conversationId = result?.id ?? null
        } catch (error) {
          lastError = error
          console.warn('[IM] create_group failed', error)
        }
        if (conversationId === null) {
          set({ error: errorMessage(lastError, 'im.error.group') })
          return null
        }
        set({ error: null, activeTab: 'messages', groupDialog: false })
        // 先让会话列表 / 通讯录包含新群再激活，避免首次进入时 conversation=null 停在空态
        await Promise.all([
          get().refreshConversations(), get().refreshContacts(),
        ]).catch(() => {})
        get().setActiveConversation(conversationId)
        return conversationId
      },

      /** 群成员 / 群资料变更后统一刷新会话、通讯录与成员缓存；
       *  当前会话补拉一次增量，让操作者立即看到刚写入的群内系统提示 */
      refreshGroupState: async (conversationId: number) => {
        get().invalidateMembers(conversationId)
        await Promise.all([
          get().refreshConversations().catch(() => {}),
          get().refreshContacts().catch(() => {}),
        ])
        if (get().activeConversationId === conversationId) {
          await get().loadMessages(conversationId, 'incremental').catch(() => {})
        }
      },

      removeMember: async (conversationId, userId) => {
        try {
          await imApi.removeMember(conversationId, userId)
          set({ error: null })
          await get().refreshGroupState(conversationId)
          return true
        } catch (error) {
          console.warn('[IM] removeMember failed', error)
          set({ error: errorMessage(error, 'im.error.groupAction') })
          return false
        }
      },

      addGroupMembers: async (conversationId, memberIds) => {
        if (!memberIds.length) return false
        try {
          await imApi.addMembers(conversationId, memberIds)
          set({ error: null })
          await get().refreshGroupState(conversationId)
          return true
        } catch (error) {
          console.warn('[IM] addGroupMembers failed', error)
          set({ error: errorMessage(error, 'im.error.groupAction') })
          return false
        }
      },

      updateGroupAvatar: async (conversationId, avatar) => {
        try {
          await imApi.updateGroupAvatar(conversationId, avatar)
          set({ error: null })
          await get().refreshGroupState(conversationId)
          return true
        } catch (error) {
          console.warn('[IM] updateGroupAvatar failed', error)
          set({ error: errorMessage(error, 'im.error.groupAction') })
          return false
        }
      },

      /** 退群 / 解散后清掉本会话的本地视图，避免停在一个已无权访问的空态 */
      forgetConversation: (conversationId: number) => {
        const { messages, cursors, membersByConversation } = get()
        const nextMessages = { ...messages }
        const nextCursors = { ...cursors }
        const nextMembers = { ...membersByConversation }
        delete nextMessages[conversationId]
        delete nextCursors[conversationId]
        delete nextMembers[conversationId]
        set({
          messages: nextMessages, cursors: nextCursors,
          membersByConversation: nextMembers,
          activeConversationId: get().activeConversationId === conversationId
            ? null : get().activeConversationId,
          groupDialog: false,
        })
      },

      leaveGroup: async conversationId => {
        try {
          await imApi.leaveGroup(conversationId)
          set({ error: null })
          get().forgetConversation(conversationId)
          await get().refreshGroupState(conversationId)
          return true
        } catch (error) {
          console.warn('[IM] leaveGroup failed', error)
          set({ error: errorMessage(error, 'im.error.groupAction') })
          return false
        }
      },

      dissolveGroup: async conversationId => {
        try {
          await imApi.dissolveGroup(conversationId)
          set({ error: null })
          get().forgetConversation(conversationId)
          await get().refreshGroupState(conversationId)
          return true
        } catch (error) {
          console.warn('[IM] dissolveGroup failed', error)
          set({ error: errorMessage(error, 'im.error.groupAction') })
          return false
        }
      },

      handleImMessage: () => {
        // 多条通知合并成一次刷新；当前会话无条件补拉，避免合并时漏掉其中一条
        if (refreshQueued) return
        refreshQueued = true
        refreshTimer = window.setTimeout(() => {
          refreshQueued = false
          const state = useImStore.getState()
          void state.refreshConversations().catch(() => {})
          if (state.activeConversationId !== null) {
            void state.loadMessages(state.activeConversationId, 'incremental')
          }
        }, 180)
      },

      handlePresence: detail => {
        const userId = Number(detail?.user_id)
        if (!Number.isFinite(userId)) return
        const online = Boolean(detail?.online)
        set(s => ({
          online: { ...s.online, [userId]: online },
          contacts: s.contacts ? {
            ...s.contacts,
            users: s.contacts.users.map(u => u.id === userId ? { ...u, is_online: online } : u),
          } : s.contacts,
          conversations: s.conversations.map(c => c.other_user?.id === userId
            ? { ...c, other_user: { ...c.other_user, is_online: online } } : c),
        }))
      },

      resync: () => {
        const state = get()
        void state.refreshConversations().catch(() => {})
        if (state.activeConversationId !== null) {
          void state.loadMessages(state.activeConversationId, 'incremental')
        }
      },

      startPolling: (intervalMs = 8000) => {
        if (pollTimer !== null) return
        let ticks = 0
        pollTimer = window.setInterval(() => {
          if (document.visibilityState !== 'visible') return
          const state = useImStore.getState()
          if (!state.open) return
          ticks += 1
          void state.refreshConversations().catch(() => {})
          // 在线状态低频批量校准：约每 4 个 tick 一次，补齐页面隐藏期间漏掉的离线事件
          if (ticks % 4 === 0) void state.refreshContacts().catch(() => {})
          if (state.activeConversationId !== null) {
            void state.loadMessages(state.activeConversationId, 'incremental')
          }
        }, intervalMs)
      },

      stopPolling: () => {
        if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null }
        if (refreshTimer !== null) { window.clearTimeout(refreshTimer); refreshTimer = null }
        refreshQueued = false
      },

      resetForUserSwitch: () => {
        get().stopPolling()
        // 灯箱的 objectURL 由 ImImageLightbox 自己持有并在卸载时 revoke，此处只清状态
        // 群成员名单与 @ 去重记录都按账号隔离，切账号必须一起清掉
        membersInFlight.clear()
        notifiedMentionIds.clear()
        set({ ...initialState })
      },
    }),
    {
      name: 'im-storage',
      partialize: state => ({ drafts: state.drafts, activeTab: state.activeTab }),
    },
  ),
)

/** ImHost 挂载时注册全局 WS 事件；返回清理函数。 */
export function attachImEvents(): () => void {
  const onMessage = (event: Event) => {
    const detail = (event as CustomEvent).detail || {}
    // 服务端 notify_im_message 只推给「除发送者外的成员」，这里再兜底过滤一次，
    // 保证自己发出的消息既不响普通音也不弹 @ 提醒。
    const myId = currentUserId()
    const fromMe = myId !== null && detail.sender_id != null
      && Number(detail.sender_id) === Number(myId)
    const ids: unknown[] = Array.isArray(detail.mentioned_user_ids)
      ? detail.mentioned_user_ids : []
    const mentioned = Boolean(detail.mention_all)
      || (myId !== null && ids.some(id => Number(id) === myId))
    // 群内系统提示（加人/踢人/退群）只触发增量补拉，不响「新消息」提示音
    const isSystem = detail.kind === 'system'
    if (!fromMe && mentioned && !isSystem) {
      // 被 @ 只走专用提醒（Toast + 上行三音），不叠播普通「叮咚」
      useImStore.getState().notifyMention({
        messageId: Number(detail.message_id) || 0,
        conversationId: Number(detail.conversation_id) || 0,
        senderName: String(detail.sender_name || ''),
        mentionAll: Boolean(detail.mention_all),
      })
    } else if (!fromMe && !isSystem) {
      playImMessageSound()
    }
    useImStore.getState().handleImMessage(detail)
  }
  const onPresence = (event: Event) => useImStore.getState().handlePresence((event as CustomEvent).detail)
  const onResync = () => useImStore.getState().resync()
  window.addEventListener(IM_MESSAGE_EVENT, onMessage)
  window.addEventListener(IM_PRESENCE_EVENT, onPresence)
  window.addEventListener(IM_RESYNC_EVENT, onResync)
  return () => {
    window.removeEventListener(IM_MESSAGE_EVENT, onMessage)
    window.removeEventListener(IM_PRESENCE_EVENT, onPresence)
    window.removeEventListener(IM_RESYNC_EVENT, onResync)
    useImStore.getState().stopPolling()
  }
}
