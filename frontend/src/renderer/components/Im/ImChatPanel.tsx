/** 会话区：标题栏、消息流（上拉历史 / 回到底部）、输入区、图片灯箱与群成员。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronLeft, Forward, Loader2, MessageSquareDashed, Users, X,
} from 'lucide-react'

import { imApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import { useImStore } from '../../store/imStore'
import { useToastStore } from '../../store/toastStore'
import { ImAvatar } from './ImAvatar'
import { ImComposer } from './ImComposer'
import { ImGroupMembersDialog } from './ImGroupMembersDialog'
import { ImForwardDialog } from './ImForwardDialog'
import { ImImageLightbox } from './ImImageLightbox'
import { ImMessageContextMenu } from './ImMessageContextMenu'
import type { MessageMenuState } from './ImMessageContextMenu'
import { ImMessageItem } from './ImMessageItem'
import { ImSystemNotice } from './ImSystemNotice'
import {
  conversationTitle, formatBytes, formatClock, imDisplayName, imUserId, isWithinRecallWindow,
} from './types'
import type { ImConversation, ImLightboxSource, ImMessage, ImUser } from './types'

interface Props {
  conversation: ImConversation | null
  /** 通讯录点人后、服务端会话 id 还没返回时的占位对象：立即渲染对方信息 + 骨架 */
  pendingPeer?: { userId: number; user: ImUser | null } | null
  narrow: boolean
  onBack: () => void
}

/** selector 必须返回稳定引用，否则 zustand 会因每次新建空数组而反复重渲染 */
const EMPTY_MESSAGES: ImMessage[] = []

export function ImChatPanel({ conversation, pendingPeer, narrow, onBack }: Props) {
  const { t } = useTranslation()
  const currentUserId = useAuthStore(s => imUserId(s.user))
  const currentUser = useAuthStore(s => s.user)
  const desktopMode = useAuthStore(s => s.desktopMode)
  const messages = useImStore(s => conversation
    ? (s.messages[conversation.id] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES)
  const cursor = useImStore(s => conversation ? s.cursors[conversation.id] : undefined)
  const loadMessages = useImStore(s => s.loadMessages)
  const sendText = useImStore(s => s.sendText)
  const lightbox = useImStore(s => s.lightbox)
  const setLightbox = useImStore(s => s.setLightbox)
  const error = useImStore(s => s.error)
  const errorScope = useImStore(s => s.errorScope)
  // 游标还没建立 = 这一页正文还在路上：显示骨架，别先闪一下「还没有消息」再整块铺入；
  // 加载失败（会话作用域报错）时不能再挂着骨架，改为提示失败原因
  const messagesErrorKey = conversation && error && errorScope === `messages:${conversation.id}`
    ? error : null
  const messagesLoading = messages.length === 0 && !cursor && !messagesErrorKey
  const activeId = useImStore(s => s.activeConversationId)
  const clearError = useImStore(s => s.clearError)
  const setReplyTo = useImStore(s => s.setReplyTo)
  const deleteMessage = useImStore(s => s.deleteMessage)
  const recallMessage = useImStore(s => s.recallMessage)
  const fillComposer = useImStore(s => s.fillComposer)
  const downloadAttachment = useImStore(s => s.downloadAttachment)
  const downloadProgress = useImStore(s => s.downloadProgress)
  const forwardMessages = useImStore(s => s.forwardMessages)
  const markConversationRead = useImStore(s => s.markConversationRead)
  const [menu, setMenu] = useState<MessageMenuState | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [forwardOpen, setForwardOpen] = useState(false)
  const [forwardIds, setForwardIds] = useState<number[]>([])
  // 转发目标在打开弹窗那一刻取快照：不再订阅 conversations，否则 1.5s 轮询每次
  // 换新数组都会把整个聊天区（含全部消息行）重渲染一遍
  const [forwardList, setForwardList] = useState<ImConversation[]>([])
  const [atBottom, setAtBottom] = useState(true)
  const [membersOpen, setMembersOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const loadedFor = useRef<number | null>(null)
  // 与 atBottom 状态同步的 ref：ResizeObserver / 滚动回调里读最新值，不受闭包影响
  const atBottomRef = useRef(true)
  // 程序性 scrollTo 也会派发 scroll 事件；短暂屏蔽，避免把"刚贴底"误判成"离开底部"
  const ignoreScrollRef = useRef(false)

  const dayLabel = (iso: string) => {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return ''
    const monthDay = t('im.chat.dayLabel', {
      defaultValue: '{{month}}月{{day}}日',
      month: date.getMonth() + 1, day: date.getDate(),
    })
    return `${monthDay} ${formatClock(iso)}`
  }

  const scrollToBottom = useCallback((smooth = false) => {
    const node = scrollRef.current
    if (!node) return
    ignoreScrollRef.current = true
    node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    atBottomRef.current = true
    setAtBottom(true)
    window.setTimeout(() => { ignoreScrollRef.current = false }, 150)
  }, [])

  /**
   * 内容高度变化（新消息落地、乐观消息被服务端消息替换、图片加载完成）后再贴一次底。
   * 单靠 messages.length 的 effect 不够：发送时那次滚动发生在新消息渲染之前，
   * 之后 DOM 变高但没有新的 length 变化，最新消息就会被截在容器底部。
   */
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) scrollToBottom()
    })
    observer.observe(content)
    return () => observer.disconnect()
    // conversation.id 必须进依赖：窗口先以空态挂载时 contentRef 还不存在，
    // 只依赖稳定的 scrollToBottom 会让监听永远注册不上。
  }, [scrollToBottom, conversation?.id])

  useLayoutEffect(() => {
    if (conversation && loadedFor.current !== conversation.id) {
      loadedFor.current = conversation.id
      // 打开/切换会话一律先看最新消息：清掉上一个会话遗留的"停留在历史位置"状态
      atBottomRef.current = true
      setAtBottom(true)
      window.requestAnimationFrame(() => scrollToBottom())
    }
  }, [conversation, messages.length, scrollToBottom])

  useEffect(() => {
    if ((atBottom || atBottomRef.current) && messages.length) scrollToBottom()
    // 依赖 messages 引用而非 length：乐观消息被服务端消息替换时长度不变，
    // 只盯 length 会漏掉这次补滚，最新消息被截在容器底部。
  }, [messages, atBottom, scrollToBottom])

  const onScroll = () => {
    if (ignoreScrollRef.current) return
    const node = scrollRef.current
    if (!node) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    const next = distance < 80
    atBottomRef.current = next
    setAtBottom(next)
    if (node.scrollTop < 40 && cursor?.hasMore && conversation) {
      const before = node.scrollHeight
      void loadMessages(conversation.id, 'older').then(() => {
        window.requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop += scrollRef.current.scrollHeight - before
        })
      })
    }
  }

  const openMembers = () => {
    if (!conversation) return
    setMembersOpen(true)
  }

  // 当前会话已加载的图片（按消息顺序）：灯箱据此支持上一张 / 下一张浏览。
  // 只收有服务端 attachmentId 的图片，乐观消息 / 输入框待发送附件不进画廊。
  const imageGallery = useMemo<ImLightboxSource[]>(() => messages.flatMap(message => {
    const attachment = message.attachment
    if (message.kind !== 'image' || !attachment || attachment.id == null) return []
    return [{
      name: attachment.original_name,
      mime: attachment.mime || 'image/png',
      attachmentId: attachment.id,
    }]
  }), [messages])

  const openPreview = useCallback((attachmentId: number, name: string, mime: string) => {
    const index = imageGallery.findIndex(item => item.attachmentId === attachmentId)
    setLightbox({
      name, mime, attachmentId,
      gallery: imageGallery,
      galleryIndex: index >= 0 ? index : 0,
    })
  }, [imageGallery, setLightbox])

  /** 复制单张图片消息时写入原图字节，粘贴到输入框才是图片本身而不是文件名文本 */
  const copyImageMessage = async (message: ImMessage): Promise<boolean> => {
    const attachment = message.attachment
    if (message.kind !== 'image' || !attachment?.id || !attachment.mime.startsWith('image/')) return false
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false
    try {
      const mime = attachment.mime.startsWith('image/') ? attachment.mime : 'image/png'
      // 立即调用 clipboard.write（在用户手势有效期内），字节异步填入；避免慢图下载后失去剪贴板权限
      const blobPromise = imApi.attachmentBlob(attachment.id, false).then(blob =>
        blob.type.startsWith('image/') ? blob : new Blob([blob], { type: mime }))
      await navigator.clipboard.write([new ClipboardItem({ [mime]: blobPromise })])
      return true
    } catch {
      return false
    }
  }

  const copyText = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch { /* 桌面 WebView2 / 非安全上下文降级到 execCommand */ }
    const holder = document.createElement('textarea')
    holder.value = text
    holder.style.position = 'fixed'
    holder.style.opacity = '0'
    document.body.appendChild(holder)
    try {
      holder.select()
      return typeof document.execCommand === 'function' && document.execCommand('copy')
    } catch {
      return false
    } finally {
      holder.remove()
    }
  }

  /** 复制消息正文：不带发送人和时间；多选时按时间顺序拼接 */
  const copyMessages = async (items: ImMessage[]) => {
    if (!items.length) return
    if (items.length === 1 && await copyImageMessage(items[0])) {
      useToastStore.getState().show(t('im.message.copied', '已复制到剪贴板'))
      return
    }
    const text = items.map(message => {
      const attachment = message.attachment
        ? `${message.attachment.original_name}（${formatBytes(message.attachment.size_bytes)}）`
        : ''
      return [message.content_text || '', attachment].filter(Boolean).join('\n')
    }).filter(Boolean).join('\n\n')
    if (!text) return
    const ok = await copyText(text)
    useToastStore.getState().show(
      ok ? t('im.message.copied', '已复制到剪贴板') : t('im.message.copyFailed', '复制失败'),
    )
  }

  /** 桌面端：后台缓存附件，完成后自动在文件管理器中定位 */
  const revealFile = async (message: ImMessage) => {
    if (!message.attachment?.id) return
    const ok = await downloadAttachment(message, true)
    useToastStore.getState().show(ok
      ? t('im.message.revealStarted', '已完成下载，正在打开文件夹')
      : t('im.message.revealFailed', '附件下载失败'))
  }

  // 以下回调全部 useCallback 稳定：ImMessageItem 是 memo 组件，每次渲染新建闭包
  // 会让整屏消息行一起重渲染（切换会话、轮询刷新时肉眼可见的卡顿）
  const toggleSelect = useCallback((id: number) => setSelectedIds(list =>
    list.includes(id) ? list.filter(value => value !== id) : [...list, id]), [])

  const handleRetry = useCallback((message: ImMessage) => {
    void sendText(message.content_text || '')
    scrollToBottom()
  }, [sendText, scrollToBottom])

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>, item: ImMessage) => {
    event.preventDefault()
    setMenu({ message: item, x: event.clientX, y: event.clientY })
  }, [])

  const openForward = useCallback((ids: number[]) => {
    const state = useImStore.getState()
    setForwardList(state.conversations.filter(c => c.id !== state.activeConversationId))
    setForwardIds(ids)
    setForwardOpen(true)
  }, [])

  const handleForward = (message: ImMessage) => {
    openForward(selectionMode && selectedIds.length ? selectedIds : [message.id])
  }

  const exitSelection = () => { setSelectionMode(false); setSelectedIds([]) }

  // objectURL 由 ImImageLightbox 自己持有并在卸载时 revoke，这里只清状态
  const closeLightbox = () => setLightbox(null)

  if (!conversation) {
    // 通讯录点人后会话 id 还在路上：先把对方信息 + 骨架顶上去，
    // 别让「点击 → 等 createConversation 返回」这段时间看起来像没反应
    if (pendingPeer) {
      const peerName = pendingPeer.user
        ? imDisplayName(pendingPeer.user)
        : t('im.sidebar.unknownUser', '用户')
      return (
        <div className={`relative flex min-w-0 flex-1 flex-col bg-background/30 ${narrow ? 'im-pane-in' : ''}`}>
          <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-card/70 px-2 backdrop-blur-sm">
            {narrow && (
              <button type="button" onClick={onBack} title={t('im.chat.back', '返回列表')}
                      className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-accent cursor-pointer">
                <ChevronLeft size={16} />
              </button>
            )}
            <ImAvatar name={peerName} avatar={pendingPeer.user?.avatar} kind="user" size={20} />
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">{peerName}</p>
            <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" />
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4">
            <MessageSkeleton />
          </div>
        </div>
      )
    }
    return (
      <div className="relative flex flex-1 flex-col items-center justify-center gap-3 bg-background/40 text-muted-foreground">
        {/* 空态下 ImComposer 不渲染，错误条只在这里出现，不会与输入区的错误条重复 */}
        {error && (!errorScope || errorScope === 'global' || (activeId !== null && [
          `messages:${activeId}`, `send:${activeId}`,
          `file:${activeId}`, `message:${activeId}`, `group:${activeId}`,
        ].includes(errorScope))) && (
          <div className="absolute top-3 flex max-w-[90%] items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-500">
            <span className="flex-1">{t(error)}</span>
            <button type="button" onClick={clearError}
                    title={t('im.common.close', '关闭')}
                    className="cursor-pointer hover:text-foreground">
              <X size={12} />
            </button>
          </div>
        )}
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/15">
          <MessageSquareDashed size={30} className="text-primary/70" />
        </div>
        <p className="text-sm font-medium">{t('im.chat.selectConversation', '选择一个会话开始协作')}</p>
        <p className="text-xs">{t('im.chat.selectConversationHint', '从左侧近期消息或通讯录里发起单聊、加入群组')}</p>
      </div>
    )
  }

  return (
    <div className={`relative flex min-w-0 flex-1 flex-col bg-background/30 ${narrow ? 'im-pane-in' : ''}`}
         onPointerDown={() => markConversationRead(conversation.id)}>
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-card/70 px-2 backdrop-blur-sm">
        {narrow && (
          <button type="button" onClick={onBack} title={t('im.chat.back', '返回列表')}
                  className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-accent cursor-pointer">
            <ChevronLeft size={16} />
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-baseline gap-1">
          <p className="truncate text-sm font-semibold">
            {conversationTitle(conversation, {
              unknownUser: t('im.sidebar.unknownUser', '用户'),
              unnamedGroup: t('im.sidebar.unnamedGroup', '未命名群组'),
              selfName: imDisplayName(currentUser),
            })}
          </p>
          {conversation.kind !== 'direct' && (
            <span className="shrink-0 text-xs font-normal text-muted-foreground">
              ({conversation.member_count})
            </span>
          )}
        </div>
        {conversation.kind !== 'direct' && (
          <button type="button" onClick={openMembers} title={t('im.chat.groupMembers', '群成员')}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-primary cursor-pointer">
            <Users size={16} />
          </button>
        )}
      </header>

      {downloadProgress && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-card/70 px-4 py-1.5 text-[11px] text-muted-foreground">
          <Loader2 size={12} className="animate-spin text-primary" />
          <span className="max-w-[160px] truncate">
            {t('im.message.downloading', '正在缓存 {{name}}', { name: downloadProgress.name })}
          </span>
          <span className="truncate">{downloadProgress.phase}</span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all"
                 style={{ width: `${downloadProgress.percent}%` }} />
          </div>
          <span>{downloadProgress.percent}%</span>
        </div>
      )}

      {selectionMode && (
        <div className="flex shrink-0 items-center gap-3 border-b border-primary/30 bg-primary/5 px-4 py-1.5 text-xs">
          <span className="flex-1 text-primary">
            {t('im.message.selected', '已选择 {{count}} 条', { count: selectedIds.length })}
          </span>
          <button type="button" disabled={!selectedIds.length}
                  onClick={() => void copyMessages(messages.filter(m => selectedIds.includes(m.id)))}
                  className="rounded px-2 py-1 hover:bg-accent disabled:opacity-40 cursor-pointer">
            {t('im.message.menu.copy', '复制')}
          </button>
          <button type="button" disabled={!selectedIds.length}
                  onClick={() => { setForwardIds(selectedIds); setForwardOpen(true) }}
                  className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent disabled:opacity-40 cursor-pointer">
            <Forward size={13} /> {t('im.message.menu.forward', '转发')}
          </button>
          <button type="button" onClick={exitSelection}
                  className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent cursor-pointer">
            <X size={13} /> {t('im.common.cancel', '取消')}
          </button>
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll}
           className="relative min-h-0 flex-1 overflow-y-auto px-4 py-4"
           style={{ backgroundImage: 'radial-gradient(hsl(var(--muted-foreground) / 0.07) 1px, transparent 1px)', backgroundSize: '18px 18px' }}>
        <div ref={contentRef} className="flex min-h-full flex-col space-y-3">
        {cursor?.hasMore && (
          <div className="flex justify-center">
            <button type="button" onClick={() => void loadMessages(conversation.id, 'older')}
                    className="rounded-full border border-border/70 bg-card/80 px-3 py-1 text-[11px] text-muted-foreground hover:text-primary cursor-pointer">
              {t('im.chat.loadEarlier', '加载更早的消息')}
            </button>
          </div>
        )}
        {messages.length === 0 && (messagesLoading
          ? <MessageSkeleton />
          : (
            <div className={`flex flex-1 items-center justify-center text-xs ${
              messagesErrorKey ? 'text-amber-500' : 'text-muted-foreground'}`}>
              {messagesErrorKey
                ? t(messagesErrorKey)
                : t('im.chat.noMessages', '还没有消息，发送第一条开始沟通')}
            </div>
          ))}
        {messages.map((message, index) => {
          const previous = messages[index - 1]
          const gap = previous ? new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() : Infinity
          return (
            <div key={message.id} className="space-y-3">
              {gap > 5 * 60 * 1000 && (
                <div className="flex justify-center">
                  <span className="rounded-full bg-muted/70 px-2.5 py-0.5 text-[10px] text-muted-foreground">
                    {dayLabel(message.created_at)}
                  </span>
                </div>
              )}
              {message.kind === 'system' ? (
                <ImSystemNotice contentText={message.content_text} />
              ) : (
                <ImMessageItem
                  message={message}
                  isMine={message.sender_id === currentUserId}
                  onPreview={openPreview}
                  onRetry={handleRetry}
                  onEditRecalled={item => {
                    if (item.content_text) fillComposer(item.conversation_id, item.content_text)
                  }}
                  onDownloadFile={desktopMode ? item => void revealFile(item) : undefined}
                  onContextMenu={handleContextMenu}
                  selectionMode={selectionMode}
                  selected={selectedIds.includes(message.id)}
                  onToggleSelect={toggleSelect}
                />
              )}
            </div>
          )
        })}
        </div>
      </div>

      <ImComposer conversationId={conversation.id} onSent={() => scrollToBottom()} />

      {lightbox && (
        <ImImageLightbox source={lightbox} onClose={closeLightbox} />
      )}

      {membersOpen && conversation && (
        <ImGroupMembersDialog conversation={conversation} onClose={() => setMembersOpen(false)} />
      )}

      {menu && (
        <ImMessageContextMenu
          state={menu}
          onClose={() => setMenu(null)}
          onCopy={message => void copyMessages([message])}
          onRevealFile={message => void revealFile(message)}
          canRevealFile={desktopMode && Boolean(menu.message.attachment?.id)}
          onRecall={message => {
            if (conversation) void recallMessage(conversation.id, message.id)
          }}
          onQuote={message => setReplyTo(message)}
          onMultiSelect={message => { setSelectionMode(true); setSelectedIds([message.id]) }}
          onForward={handleForward}
          canRecall={menu.message.sender_id !== currentUserId
            ? null
            : !menu.message.recalled && isWithinRecallWindow(menu.message.created_at)}
          canDelete={menu.message.sender_id === currentUserId}
          onDelete={message => {
            if (conversation) void deleteMessage(conversation.id, message.id)
          }}
        />
      )}

      {forwardOpen && (
        <ImForwardDialog
          open
          conversations={forwardList}
          count={forwardIds.length}
          onClose={() => setForwardOpen(false)}
          onConfirm={async ids => forwardMessages(forwardIds, ids)}
        />
      )}
    </div>
  )
}

/** 正文加载中的骨架：让「切会话 → 消息出现」这段时间有内容占位，不再闪空态再整块铺入 */
function MessageSkeleton() {
  return (
    <div className="flex flex-1 flex-col justify-end gap-3 py-2" aria-hidden>
      {[0, 1, 2, 3].map(index => (
        <div key={index} className={`flex gap-2 ${index % 2 === 1 ? 'flex-row-reverse' : ''}`}>
          <div className="h-8 w-8 shrink-0 animate-pulse rounded-xl bg-muted/60" />
          <div className={`flex flex-col gap-1.5 ${index % 2 === 1 ? 'items-end' : ''}`}>
            <div className="h-2.5 w-16 animate-pulse rounded bg-muted/50" />
            <div className={`h-9 animate-pulse rounded-xl bg-muted/40 ${index % 2 === 1 ? 'w-36' : 'w-52'}`} />
          </div>
        </div>
      ))}
    </div>
  )
}
