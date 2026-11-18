/** 协作沟通状态仓库：消息按会话分桶、增量游标合并、WS 通知 + 可见窗口轮询兜底。 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { imApi } from '../services/api'
import { clearImAttachmentCache } from '../services/imAttachmentCache'
import { IM_MESSAGE_EVENT, IM_PRESENCE_EVENT, IM_RESYNC_EVENT } from '../services/websocketService'
import { playImMessageSound } from '../utils/messageSound'
import { imUserId } from '../components/Im/types'
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
  /** 错误所属作用域（会话 id / 操作），避免一次异步异常在所有聊天窗口同时弹提示 */
  errorScope: string | null
  sending: boolean
  uploadProgress: { name: string; percent: number } | null
  lightbox: ImLightboxSource | null
  /** 当前正在引用的历史消息；发送成功后自动清空 */
  replyTo: ImMessage | null
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
  /** 用户点击聊天区时标记该会话已读（不必先点左侧列表头像） */
  markConversationRead: (id: number) => void
  setDraft: (text: string) => void
  draftFor: (conversationId: number | null) => string
  setLightbox: (value: ImState['lightbox']) => void
  setReplyTo: (message: ImMessage | null) => void
  setGroupDialog: (open: boolean) => void
  bootstrap: () => Promise<void>
  refreshConversations: () => Promise<void>
  refreshContacts: () => Promise<void>
  loadMessages: (id: number, direction?: 'initial' | 'older' | 'incremental') => Promise<void>
  sendText: (text: string, mention?: ImSendMention) => Promise<boolean>
  /** 返回发送失败的 File，供输入区把它们放回待发送列表 */
  sendFiles: (files: File[]) => Promise<File[]>
  /** 右键菜单：删除单条历史消息 / 批量转发 */
  deleteMessage: (conversationId: number, messageId: number) => Promise<boolean>
  forwardMessages: (messageIds: number[], conversationIds: number[]) => Promise<boolean>
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
  /** pollWhenClosed：桌面共享模式没有 WS 广播，窗口收起时也要继续感知新消息（未读 + 提示音） */
  startPolling: (intervalMs?: number, pollWhenClosed?: boolean) => void
  stopPolling: () => void
  resetForUserSwitch: () => void
}

function currentUserId(): number | null {
  try {
    const raw = localStorage.getItem('auth-storage')
    const user = JSON.parse(raw || '{}')?.state?.user
    return imUserId(user)
  } catch {
    return null
  }
}

/** 每会话最多保留最近 300 条，避免长时间上拉历史让内存无限增长（游标仍单独保留） */
const MESSAGE_WINDOW_SIZE = 300
/** incremental 一次最多翻的页数，防止断线积压 / 病态数据把一次刷新拖成死循环 */
const MAX_INCREMENTAL_PAGES = 10
/** 「红点有、正文没来」的补洞节流，避免每次轮询都重拉最新一页 */
const HOLE_FILL_THROTTLE_MS = 5000

interface MessagePage {
  items: ImMessage[]
  has_more: boolean
  next_cursor: number | null
  prev_cursor: number | null
}

/** 乐观消息 id 为负数（临时），按 id 升序会排到列表顶部；把它们排到末尾 */
function messageOrder(message: ImMessage): number {
  return message.id > 0 ? message.id : Number.MAX_SAFE_INTEGER + message.id
}

function mergeMessages(existing: ImMessage[], incoming: ImMessage[]): ImMessage[] {
  const map = new Map<number, ImMessage>()
  existing.forEach(item => map.set(item.id, item))
  incoming.forEach(item => map.set(item.id, item))
  const merged = Array.from(map.values()).sort((a, b) => messageOrder(a) - messageOrder(b))
  return merged.length > MESSAGE_WINDOW_SIZE
    ? merged.slice(merged.length - MESSAGE_WINDOW_SIZE)
    : merged
}

/**
 * 带有限重试的消息分页请求。响应拦截器把错误压成 `{ success:false, code }` 普通对象，
 * 必须显式判失败；429 用更长的退避，避免高频轮询时限流叠加导致列表永久卡住。
 */
async function fetchMessagesPage(
  id: number,
  params: { after_id?: number; before_id?: number; limit?: number },
): Promise<MessagePage> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await imApi.messages(id, params)
      if (response && response.success === false) throw new Error('IM_REQUEST_FAILED')
      const page = response?.data
      return {
        items: page?.items || [],
        has_more: Boolean(page?.has_more),
        next_cursor: page?.next_cursor ?? null,
        prev_cursor: page?.prev_cursor ?? null,
      }
    } catch (error) {
      lastError = error
      const code = (error as { code?: number } | null)?.code
      // relay 槽位忙 / 网关抖动是背压信号：立刻重试只会继续抢占名额，把一次
      // 慢请求放大成 3×12s。留给下一轮轮询或用户操作重试即可。
      if (code === 503 || code === 502 || attempt === 2) break
      const delay = code === 429 ? 800 * (attempt + 1) : 200 * (attempt + 1)
      await new Promise<void>(resolve => { window.setTimeout(resolve, delay) })
    }
  }
  throw lastError
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
  // 附件失败以前一律折叠成「附件发送失败，已放回待发送列表」，用户无法判断
  // 是文件太大、消息服务繁忙还是断网；这里把可操作的真实原因显示出来。
  if (raw.includes('IM_ATTACHMENT_TOO_LARGE')) return 'im.error.tooLarge'
  const busyOp = raw.match(/IM_RELAY_BUSY:([a-z_]+)/)?.[1] || ''
  const busyKeys: Record<string, string> = {
    list_conversations: 'im.error.busyConversations',
    list_messages: 'im.error.busyMessages',
    send_message: 'im.error.busySend',
    attachment_download: 'im.error.busyAttachment',
    attachment_urls: 'im.error.busyAttachment',
    attachment_start: 'im.error.busyUpload',
    attachment_chunk: 'im.error.busyUpload',
    attachment_complete: 'im.error.busyUpload',
    list_members: 'im.error.busyMembers',
  }
  if (busyOp && busyKeys[busyOp]) return busyKeys[busyOp]
  if (raw.includes('IM_RELAY_BUSY') || raw.includes('IM_RELAY_FAILED')) return 'im.error.relayBusy'
  if (err?.code === 0) return 'im.error.network'
  return fallbackKey
}

/** 设置/清除某个作用域的错误；同作用域重试成功后立即消失，不会污染其它会话 */
function setImError(scope: string, key: string | null): void {
  const state = useImStore.getState()
  if (key === null) {
    if (state.errorScope === scope) {
      useImStore.setState({ error: null, errorScope: null })
    }
    return
  }
  useImStore.setState({ error: key, errorScope: scope })
}

/** 只把用户本轮真正点开过的会话未读归零；窗口打开但没点会话时红点必须保留 */
function clearActiveUnread(conversations: ImConversation[], viewedId: number | null,
                           open: boolean): ImConversation[] {
  if (!open || viewedId === null) return conversations
  return conversations.map(c => c.id === viewedId && c.unread ? { ...c, unread: 0 } : c)
}

let pollTimer: number | null = null
let refreshTimer: number | null = null
let refreshQueued = false
/**
 * 本轮窗口会话中用户**真正点开过**的会话。
 * 不能再拿 activeConversationId + open 判断已读：窗口重新展开后仍停留在上次会话，
 * 或用户停在通讯录 Tab 时，新消息会被误判已读、红点直接消失。
 */
let viewedConversationId: number | null = null
/**
 * 一轮轮询是否还在途。桌面共享模式 1.5s 一个 tick，relay 慢的时候旧请求能挂 12~24s；
 * 不去重会持续叠加在途请求，打满 WebView2 的 6 条 HTTP/1.1 连接与后端线程池，
 * 标题栏「最小化/最大化」这种交互请求也被排到几十秒后（用户实测复现）。
 */
let pollInFlight = false
/** 上次「红点/最新 id 与本地正文不一致」补洞时间 */
let lastHoleFillAt = 0
/** 头像只在首次会话列表加载时传输一次，之后轮询带 include_avatars=false */
let avatarsFetched = false
/** 收到非激活会话的新消息：标记脏，切换进该会话时优先补拉而不是重新 initial */
const dirtyConversations = new Set<number>()
/** 桌面端窗口重新可见时的立即刷新监听（由 startPolling 注册、stopPolling 移除） */
let pollFocusHandler: (() => void) | null = null
/** 同一会话的成员请求合并为一个 Promise，避免每次键入 @ 都发请求 */
const membersInFlight = new Map<number, Promise<ImMember[]>>()
/** 成员列表缓存时间：共享桌面模式每次回源都是公网 relay，短 TTL 只挡重复弹窗 */
const MEMBERS_CACHE_TTL_MS = 60_000
const membersFetchedAt = new Map<number, number>()
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

/**
 * 「新消息叮咚」按 messageId 去重：网页端 WS 通知、轮询增量与会话列表刷新
 * 可能带来同一条消息，只响一次。桌面共享模式没有服务端 WS 推送，新消息全靠
 * 5s 轮询，所以轮询路径也必须接上音效，声效才与网页端一致。
 */
const soundedMessageIds = new Set<number>()
function markMessageSoundNotified(messageId: number): boolean {
  if (!(messageId > 0) || soundedMessageIds.has(messageId)) return false
  soundedMessageIds.add(messageId)
  if (soundedMessageIds.size > 500) {
    const oldest = soundedMessageIds.values().next().value
    if (oldest !== undefined) soundedMessageIds.delete(oldest)
  }
  return true
}

/** 会话列表快照：conversationId → last_message.id。首次刷新只建基线，不把历史当新消息 */
let conversationLastIds: Map<number, number> | null = null

/**
 * 桌面共享模式没有服务端 WS 广播：窗口打开但没进入任何会话、或消息落在其它会话时，
 * 只有会话列表轮询能看到新消息。这里补播与网页端 WS 路径同款的「叮咚」。
 * 当前激活会话交给 loadMessages 增量处理（能识别被 @ 并走专用上行三音），避免叠播。
 */
function playConversationMessageSound(
  conversations: ImConversation[], activeId: number | null, open: boolean,
) {
  const myId = currentUserId()
  const next = new Map<number, number>()
  conversations.forEach(conv => {
    if (conv.last_message) next.set(conv.id, conv.last_message.id)
  })
  const previous = conversationLastIds
  conversationLastIds = next
  if (!previous) return
  let hasFresh = false
  conversations.forEach(conv => {
    const last = conv.last_message
    // 窗口打开时活跃会话由 loadMessages 增量负责（能区分 @，走专用上行三音）；
    // 窗口收起后没有增量补拉，所有会话都由这里补播「叮咚」。
    if (!last || (open && conv.id === activeId) || last.kind === 'system') return
    if (myId !== null && last.sender_id === myId) return
    const before = previous.get(conv.id)
    if (before !== undefined && last.id <= before) return
    if (markMessageSoundNotified(last.id)) hasFresh = true
  })
  if (hasFresh) playImMessageSound()
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
  errorScope: null,
  sending: false,
  uploadProgress: null,
  lightbox: null,
  replyTo: null,
  groupDialog: false,
  membersByConversation: {},
  mentionNotice: null,
  pendingScreenshot: null,
}

export const useImStore = create<ImState>()(
  persist(
    (set, get) => ({
      ...initialState,

      setOpen: open => {
        // 收起窗口即结束本轮查看：下次展开时旧会话的红点不能被自动清掉
        if (!open) viewedConversationId = null
        set({ open })
      },
      toggleOpen: () => {
        const state = get()
        if (state.open) {
          viewedConversationId = null
          set({ open: false })
          return
        }
        set({ open: true })
        // 收到新消息后从悬浮图标/标题栏展开窗口：直接跳到最近一条未读消息所属会话，
        // 聊天区据此从最新消息开始，不必再手动去侧栏点一次。
        // 只走 toggleOpen（用户主动展开）；截图确认等 setOpen(true) 不切会话，
        // 否则待发送附件会落进被自动切走的会话。
        const latestUnread = [...state.conversations]
          .filter(c => (c.unread || 0) > 0)
          .sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || ''))[0]
        if (latestUnread && latestUnread.id !== state.activeConversationId) {
          get().setActiveConversation(latestUnread.id)
        }
      },
      setTab: activeTab => set({ activeTab }),
      setLightbox: lightbox => set({ lightbox }),
      setReplyTo: replyTo => set({ replyTo }),
      setGroupDialog: groupDialog => set({ groupDialog }),
      clearError: () => set({ error: null, errorScope: null }),

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

      markConversationRead: id => {
        // 用户点开左侧会话或直接点聊天区都算已读：红点立刻消失，不等轮询/翻页。
        viewedConversationId = id
        set(s => {
          const conversations = clearActiveUnread(s.conversations, id, true)
          return {
            conversations,
            unreadTotal: conversations.reduce(
              (sum: number, c: ImConversation) => sum + (c.unread || 0), 0),
          }
        })
        const lastId = Math.max(
          get().cursors[id]?.next ?? 0,
          get().messages[id]?.slice(-1)[0]?.id ?? 0,
        )
        if (lastId > 0) void imApi.markRead(id, lastId).catch(() => {})
      },

      setActiveConversation: id => {
        if (id === null) {
          viewedConversationId = null
          set({ activeConversationId: null })
          return
        }
        get().markConversationRead(id)
        set({ activeConversationId: id })
        // 该会话在后台收过新消息：用增量补拉接上游标，避免 initial 重置窗口
        // 把还没读的历史消息丢掉；否则按原有行为拉最新一页。
        if (dirtyConversations.has(id) && get().cursors[id]) {
          dirtyConversations.delete(id)
          void get().loadMessages(id, 'incremental')
        } else if (get().cursors[id] && (get().messages[id]?.length || 0) > 0) {
          // 已加载过的会话切来切去不再反复走公网 relay 拉同一页；
          // 新消息由 1.5s 轮询的 incremental 接上游标补拉。
        } else {
          void get().loadMessages(id, 'initial')
        }
      },

      bootstrap: async () => {
        set({ loading: true, error: null })
        try {
          await Promise.all([get().refreshConversations(), get().refreshContacts()])
        } catch (error) {
          console.warn('[IM] bootstrap failed', error)
          setImError('global', errorMessage(error, 'im.error.load'))
        } finally {
          set({ loading: false })
        }
      },

      refreshConversations: async () => {
        // 头像 base64 最多 256KB × 100 会话，1.5s 轮询时是最大的传输负担；
        // 只在首次取一次，后续请求让服务端省略，前端用缓存补齐字段。
        const includeAvatars = !avatarsFetched
        const response = await imApi.conversations(includeAvatars)
        // 高频轮询下偶发 429 / 网络失败时，响应拦截器返回 { success:false } 且没有 data。
        // 此时不能把会话列表与未读红点清空，保留上次成功结果等下一个 tick 重试。
        if (response && response.success === false) return
        let items = response?.data?.items || []
        if (includeAvatars) {
          avatarsFetched = true
        } else {
          const cached = new Map(get().conversations.map(c => [c.id, c]))
          items = items.map(c => {
            const prev = cached.get(c.id)
            return {
              ...c,
              avatar: c.avatar ?? prev?.avatar ?? null,
              other_user: c.other_user
                ? { ...c.other_user,
                    avatar: c.other_user.avatar ?? prev?.other_user?.avatar ?? null }
                : null,
            }
          })
        }
        const online = { ...get().online }
        items.forEach(conv => {
          if (conv.other_user) online[conv.other_user.id] = conv.other_user.is_online
        })
        const state = get()
        playConversationMessageSound(items, state.activeConversationId, state.open)
        const conversations = clearActiveUnread(items, viewedConversationId, state.open)
        set({
          conversations,
          online,
          unreadTotal: conversations.reduce((sum: number, c: ImConversation) => sum + (c.unread || 0), 0),
        })
        setImError('global', null) // 会话列表恢复后立即撤掉繁忙提示
        // 红点有、正文没来的兜底：服务端最新消息 id 已超过本地正文最大值，
        // 说明本地游标跳过了一段或窗口收起期间漏了补拉，重拉最新一页补洞。
        // 用服务端返回的原始 items 判断（clearActiveUnread 会把当前会话置 0）。
        const activeId = state.activeConversationId
        if (activeId !== null && Date.now() - lastHoleFillAt > HOLE_FILL_THROTTLE_MS) {
          const serverLast = items.find((c: ImConversation) => c.id === activeId)?.last_message?.id || 0
          const localLast = get().messages[activeId]?.slice(-1)[0]?.id || 0
          if (serverLast > localLast) {
            lastHoleFillAt = Date.now()
            void get().loadMessages(activeId, 'initial').catch(() => {})
          }
        }
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
        // 共享桌面模式每次成员列表都走公网 relay（12s 超时），而弹窗每次打开都
        // invalidate 一次。缓存 60s 内直接复用，成员变更由 invalidateMembers 显式失效。
        if (cached && Date.now() - (membersFetchedAt.get(id) || 0) < MEMBERS_CACHE_TTL_MS) {
          return cached
        }
        const pending = membersInFlight.get(id)
        if (pending) return pending
        const task = (async () => {
          try {
            const members = (await imApi.members(id)).data || []
            membersFetchedAt.set(id, Date.now())
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

      invalidateMembers: id => {
        membersFetchedAt.delete(id)
        set(s => {
          if (!(id in s.membersByConversation)) return {}
          const next = { ...s.membersByConversation }
          delete next[id]
          return { membersByConversation: next }
        })
      },

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
        if (direction === 'older' && !cursor?.prev) return
        const existing = direction === 'initial' ? [] : (get().messages[id] || [])
        // 没有游标说明尚未加载过该会话，整页都是历史，先建基线不提醒
        const hasBaseline = Boolean(state.cursors[id])
        const myId = currentUserId()

        let nextCursor = cursor?.next ?? null
        let prevCursor = cursor?.prev ?? null
        let hasMore = false
        const incoming: ImMessage[] = []
        try {
          // 断线期间可能积压超过一页：incremental 循环翻到 has_more=false，
          // 上限 10 页防止病态数据把一次刷新拖成死循环。
          const pages = direction === 'incremental' ? MAX_INCREMENTAL_PAGES : 1
          for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
            const params = direction === 'older'
              ? { before_id: prevCursor ?? undefined, limit: 30 }
              : direction === 'incremental'
                ? { after_id: nextCursor ?? 0, limit: 100 }
                : { limit: 30 }
            const page = await fetchMessagesPage(id, params)
            incoming.push(...page.items)
            if (direction === 'incremental') {
              // 增量游标只单向前进；服务端无新消息时保持原值，绝不回退
              if (page.next_cursor !== null) nextCursor = page.next_cursor
            } else if (direction === 'older') {
              prevCursor = page.prev_cursor ?? prevCursor
            } else {
              nextCursor = page.next_cursor ?? null
              prevCursor = page.prev_cursor ?? null
            }
            hasMore = page.has_more
            if (direction !== 'incremental' || !hasMore || page.items.length === 0) break
          }
          const merged = mergeMessages(existing, incoming)
          set(s => ({
            messages: { ...s.messages, [id]: merged },
            cursors: {
              ...s.cursors,
              [id]: {
                // older 的历史批次不能覆盖增量游标（旧实现会回退 next 造成重复拉取）
                next: direction === 'older' ? (s.cursors[id]?.next ?? null) : nextCursor,
                prev: direction === 'incremental'
                  ? (s.cursors[id]?.prev ?? prevCursor) : prevCursor,
                hasMore: direction === 'incremental'
                  ? (s.cursors[id]?.hasMore ?? false) : hasMore,
              },
            },
          }))
          setImError(`messages:${id}`, null) // 同一会话重试成功后立即撤掉繁忙提示
          // 一页历史消息里的图片批量换签名 URL：一次 relay 控制请求覆盖整页，
          // 避免每张缩略图各发一次（共享模式公网往返是主要耗时）。
          void imApi.prewarmAttachmentUrls?.(
            merged
              .filter(m => m.kind === 'image' && m.attachment?.id)
              .slice(-60)
              .map(m => ({ attachment_id: m.attachment!.id, thumb: true })),
          )?.catch(() => { /* 直链不可用由 api 层自动回退 */ })
          // 桌面共享模式可能没有 WS，靠轮询兜底；只有 incremental 方向提醒，
          // 打开历史/上拉更早消息不触发，避免翻记录时刷屏。WS 路径与这里按 messageId 去重。
          if (direction === 'incremental' && hasBaseline) {
            const existingIds = new Set(existing.map(item => item.id))
            let shouldChime = false
            incoming.forEach(item => {
              if (existingIds.has(item.id) || item.kind === 'system') return
              if (myId !== null && item.sender_id === myId) return
              if (item.mentioned_me || item.mention_all) {
                // 被 @ 只走专用提醒（Toast + 上行三音），不叠播普通「叮咚」
                get().notifyMention({
                  messageId: item.id,
                  conversationId: id,
                  senderName: item.sender_name,
                  mentionAll: Boolean(item.mention_all),
                })
                return
              }
              if (markMessageSoundNotified(item.id)) shouldChime = true
            })
            if (shouldChime) playImMessageSound()
          }
          const last = merged[merged.length - 1]
          if (direction !== 'older' && last && viewedConversationId === id) {
            const readId = Math.max(nextCursor ?? 0, last.id)
            void imApi.markRead(id, readId).catch(() => {})
            set(s => ({
              conversations: s.conversations.map(c => c.id === id ? { ...c, unread: 0 } : c),
              unreadTotal: s.conversations.reduce((sum, c) => sum + (c.id === id ? 0 : c.unread || 0), 0),
            }))
          }
        } catch (error) {
          console.warn('[IM] loadMessages failed', error)
          setImError(`messages:${id}`, errorMessage(error, 'im.error.messages'))
        }
      },

      sendText: async (text, mention) => {
        const id = get().activeConversationId
        const value = text.trim()
        if (id === null || !value) return false
        const clientMsgId = `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const tempId = -Date.now()
        const reply = get().replyTo
        const replyId = reply?.id ?? null
        const optimistic: ImMessage = {
          id: tempId, conversation_id: id, sender_id: currentUserId() || 0,
          sender_name: '', kind: 'text', content_text: value, attachment: null,
          client_msg_id: clientMsgId, created_at: new Date().toISOString(), pending: true,
          mention_all: mention?.mention_all ?? false,
          reply_to_id: replyId,
          reply_to: reply ? {
            id: reply.id, sender_id: reply.sender_id, sender_name: reply.sender_name,
            kind: reply.kind,
            preview: (reply.content_text
              || (reply.attachment ? `[附件] ${reply.attachment.original_name}` : '')).slice(0, 120),
            attachment: reply.attachment ?? null,
          } : null,
        }
        set(s => ({ sending: true, messages: { ...s.messages, [id]: mergeMessages(s.messages[id] || [], [optimistic]) } }))
        try {
          const message = (await imApi.send(id, {
            kind: 'text', content_text: value, client_msg_id: clientMsgId,
            // 只有真正 @ 了才带字段，普通消息请求体保持原样（兼容旧服务端）
            ...(mention && (mention.mentions.length > 0 || mention.mention_all)
              ? { mentions: mention.mentions, mention_all: mention.mention_all }
              : {}),
            ...(replyId ? { reply_to_id: replyId } : {}),
          })).data
          // 绝不能用服务端返回的**全局自增** message.id 直接推进 next：若此刻对方
          // 的消息 id 更小但还没被拉到，after_id 严格大于会把它永久跳过，服务端
          // unread 仍 >0 —— 正是「红点有了、聊天窗口永远看不到对方消息」的根因。
          // 只合并消息，游标交给随后的 incremental 由服务端 next_cursor 单向推进。
          set(s => ({
            sending: false,
            replyTo: null,
            messages: {
              ...s.messages,
              [id]: mergeMessages((s.messages[id] || []).filter(m => m.id !== tempId), [message]),
            },
          }))
          setImError(`send:${id}`, null)
          get().setDraft('')
          // 自己发出的消息立即把本会话未读归零，不等服务端刷新（后端也会排除自己的消息）
          set(s => ({
            conversations: clearActiveUnread(s.conversations, viewedConversationId, true),
            unreadTotal: s.conversations.reduce((sum, c) => sum + (c.id === id ? 0 : c.unread || 0), 0),
          }))
          void get().refreshConversations().catch(() => {})
          // 用服务端 next_cursor 推进游标，同时把并发期间到达的对方消息一起补齐
          void get().loadMessages(id, 'incremental').catch(() => {})
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
            errorScope: `send:${id}`,
          }))
          return false
        }
      },

      sendFiles: async files => {
        const id = get().activeConversationId
        if (id === null || !files.length) return []
        const failed: File[] = []
        for (const file of Array.from(files)) {
          set({ uploadProgress: { name: file.name, percent: 0 } })
          setImError(`file:${id}`, null)
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
            setImError(`file:${id}`, null)
          } catch (error) {
            console.warn('[IM] send attachment failed', file.name, error)
            failed.push(file)
            setImError(`file:${id}`, errorMessage(error, 'im.error.file'))
          } finally {
            set({ uploadProgress: null })
          }
        }
        set(s => ({
          conversations: clearActiveUnread(s.conversations, viewedConversationId, true),
          unreadTotal: s.conversations.reduce((sum, c) => sum + (c.id === id ? 0 : c.unread || 0), 0),
        }))
        await get().refreshConversations().catch(() => {})
        return failed
      },

      deleteMessage: async (conversationId, messageId) => {
        try {
          await imApi.deleteMessage(conversationId, messageId)
          set(s => {
            const next = (s.messages[conversationId] || []).filter(m => m.id !== messageId)
            return {
              messages: { ...s.messages, [conversationId]: next },
              replyTo: s.replyTo?.id === messageId ? null : s.replyTo,
            }
          })
          setImError(`message:${conversationId}`, null)
          void get().refreshConversations().catch(() => {})
          return true
        } catch (error) {
          console.warn('[IM] delete message failed', error)
          setImError(`message:${conversationId}`, errorMessage(error, 'im.message.deleteFailed'))
          return false
        }
      },

      forwardMessages: async (messageIds, conversationIds) => {
        try {
          await imApi.forwardMessages(messageIds, conversationIds)
          setImError('forward', null)
          void get().refreshConversations().catch(() => {})
          return true
        } catch (error) {
          console.warn('[IM] forward messages failed', error)
          setImError('forward', errorMessage(error, 'im.message.forwardFailed'))
          return false
        }
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
            c => c.kind === 'direct'
              && (c.other_user?.id === userId
                || (c.is_self && userId === currentUserId())))
          if (existing) conversationId = existing.id
        }
        if (conversationId === null) {
          setImError('global', errorMessage(lastError, 'im.error.conversation'))
          return null
        }
        set({ activeTab: 'messages' })
        setImError('global', null)
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
          setImError(`group:${id}`, 'im.error.notGroupMember')
          return false
        }
        // 刚加入/刚建好的群可能还没进会话列表，先补齐再激活
        if (!state.conversations.some(c => c.id === id)) {
          await get().refreshConversations().catch(() => {})
        }
        set({ activeTab: 'messages' })
        setImError('global', null)
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
          setImError('global', errorMessage(lastError, 'im.error.group'))
          return null
        }
        set({ activeTab: 'messages', groupDialog: false })
        setImError('global', null)
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
          setImError(`group:${conversationId}`, null)
          await get().refreshGroupState(conversationId)
          return true
        } catch (error) {
          console.warn('[IM] removeMember failed', error)
          setImError(`group:${conversationId}`, errorMessage(error, 'im.error.groupAction'))
          return false
        }
      },

      addGroupMembers: async (conversationId, memberIds) => {
        if (!memberIds.length) return false
        try {
          await imApi.addMembers(conversationId, memberIds)
          setImError(`group:${conversationId}`, null)
          await get().refreshGroupState(conversationId)
          return true
        } catch (error) {
          console.warn('[IM] addGroupMembers failed', error)
          setImError(`group:${conversationId}`, errorMessage(error, 'im.error.groupAction'))
          return false
        }
      },

      updateGroupAvatar: async (conversationId, avatar) => {
        try {
          await imApi.updateGroupAvatar(conversationId, avatar)
          setImError(`group:${conversationId}`, null)
          await get().refreshGroupState(conversationId)
          return true
        } catch (error) {
          console.warn('[IM] updateGroupAvatar failed', error)
          setImError(`group:${conversationId}`, errorMessage(error, 'im.error.groupAction'))
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
          setImError(`group:${conversationId}`, null)
          get().forgetConversation(conversationId)
          await get().refreshGroupState(conversationId)
          return true
        } catch (error) {
          console.warn('[IM] leaveGroup failed', error)
          setImError(`group:${conversationId}`, errorMessage(error, 'im.error.groupAction'))
          return false
        }
      },

      dissolveGroup: async conversationId => {
        try {
          await imApi.dissolveGroup(conversationId)
          setImError(`group:${conversationId}`, null)
          get().forgetConversation(conversationId)
          await get().refreshGroupState(conversationId)
          return true
        } catch (error) {
          console.warn('[IM] dissolveGroup failed', error)
          setImError(`group:${conversationId}`, errorMessage(error, 'im.error.groupAction'))
          return false
        }
      },

      handleImMessage: detail => {
        // 多条通知合并成一次刷新；被合并掉的通知所属会话要标记脏，
        // 否则用户切到那个会话时可能只看到红点、正文没补拉。
        const conversationId = Number(detail?.conversation_id) || 0
        if (conversationId > 0) dirtyConversations.add(conversationId)
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
        // WS / 云 WS 重连后要补齐断线期间所有已知会话的消息，不只当前激活会话。
        // 只补拉已有游标的会话，避免刚启动时把每个会话都全量拉一遍。
        const ids = new Set<number>(Object.keys(state.cursors).map(Number))
        if (state.activeConversationId !== null) ids.add(state.activeConversationId)
        ids.forEach(id => { void state.loadMessages(id, 'incremental').catch(() => {}) })
      },

      startPolling: (intervalMs = 8000, pollWhenClosed = false) => {
        if (pollTimer !== null) return
        let ticks = 0
        // 通讯录/在线状态固定约 20s 校准一次，不随会话列表轮询变快而放大请求量
        const contactsEveryTicks = Math.max(4, Math.ceil(20000 / intervalMs))
        /** 上一轮还没回来就跳过：在途请求最多一轮，连接始终留给窗口控制等交互请求 */
        const runPoll = () => {
          if (pollInFlight) return
          const state = useImStore.getState()
          const jobs: Promise<void>[] = [state.refreshConversations()]
          ticks += 1
          if (ticks % contactsEveryTicks === 0) jobs.push(state.refreshContacts())
          // 窗口收起时只刷会话列表（未读 + 提示音），不补拉当前会话正文
          if (state.open && state.activeConversationId !== null) {
            jobs.push(state.loadMessages(state.activeConversationId, 'incremental'))
          }
          pollInFlight = true
          Promise.allSettled(jobs).finally(() => { pollInFlight = false })
        }
        pollTimer = window.setInterval(() => {
          // 网页端窗口隐藏时省请求；桌面共享模式没有服务端 WS 广播，隐藏/失焦也要继续刷未读，
          // 否则切出去再回来时标题栏「项目沟通」红点会一直停在旧值
          if (document.visibilityState !== 'visible' && !pollWhenClosed) return
          const state = useImStore.getState()
          if (!state.open && !pollWhenClosed) return
          runPoll()
        }, intervalMs)

        if (pollWhenClosed) {
          // 切回桌面窗口 / 页面重新可见时立刻补一次：轮询间隔内到达的消息也能马上
          // 反映到标题栏红点上，不必等下一个 tick。1s 节流避免 focus 与 visibilitychange 双触发
          let lastRefreshAt = 0
          const onVisible = () => {
            if (document.visibilityState !== 'visible') return
            const now = Date.now()
            if (now - lastRefreshAt < 1000) return
            lastRefreshAt = now
            runPoll()
          }
          pollFocusHandler = onVisible
          window.addEventListener('focus', onVisible)
          document.addEventListener('visibilitychange', onVisible)
        }
      },

      stopPolling: () => {
        if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null }
        if (refreshTimer !== null) { window.clearTimeout(refreshTimer); refreshTimer = null }
        if (pollFocusHandler) {
          window.removeEventListener('focus', pollFocusHandler)
          document.removeEventListener('visibilitychange', pollFocusHandler)
          pollFocusHandler = null
        }
        refreshQueued = false
        pollInFlight = false
        viewedConversationId = null
      },

      resetForUserSwitch: () => {
        get().stopPolling()
        viewedConversationId = null
        // 灯箱的 objectURL 由 ImImageLightbox 自己持有并在卸载时 revoke，此处只清状态
        // 群成员名单与 @ 去重记录都按账号隔离，切账号必须一起清掉
        membersInFlight.clear()
        membersFetchedAt.clear()
        clearImAttachmentCache()
        notifiedMentionIds.clear()
        soundedMessageIds.clear()
        conversationLastIds = null
        dirtyConversations.clear()
        lastHoleFillAt = 0
        avatarsFetched = false
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
      // 登记 message_id：随后 WS 触发的增量补拉 / 会话列表刷新不会再响一次。
      // 旧服务端轻通知不带 id 时保持原行为（仍响），由提示音自身的节流兜底。
      const messageId = Number(detail.message_id) || 0
      if (!messageId || markMessageSoundNotified(messageId)) playImMessageSound()
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
