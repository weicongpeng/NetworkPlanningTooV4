/** 会话区：标题栏、消息流（上拉历史 / 回到底部）、输入区、图片灯箱与群成员。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown, ChevronLeft, MessageSquareDashed, Users, X,
} from 'lucide-react'

import { useAuthStore } from '../../store/authStore'
import { useImStore } from '../../store/imStore'
import { ImAvatar } from './ImAvatar'
import { ImComposer } from './ImComposer'
import { ImGroupMembersDialog } from './ImGroupMembersDialog'
import { ImImageLightbox } from './ImImageLightbox'
import { ImMessageItem } from './ImMessageItem'
import { ImSystemNotice } from './ImSystemNotice'
import { conversationTitle, formatClock } from './types'
import type { ImConversation, ImLightboxSource, ImMessage } from './types'

interface Props {
  conversation: ImConversation | null
  narrow: boolean
  onBack: () => void
}

/** selector 必须返回稳定引用，否则 zustand 会因每次新建空数组而反复重渲染 */
const EMPTY_MESSAGES: ImMessage[] = []

export function ImChatPanel({ conversation, narrow, onBack }: Props) {
  const { t } = useTranslation()
  const currentUserId = useAuthStore(s => s.user?.id ?? null)
  const messages = useImStore(s => conversation
    ? (s.messages[conversation.id] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES)
  const cursor = useImStore(s => conversation ? s.cursors[conversation.id] : undefined)
  const loadMessages = useImStore(s => s.loadMessages)
  const sendText = useImStore(s => s.sendText)
  const lightbox = useImStore(s => s.lightbox)
  const setLightbox = useImStore(s => s.setLightbox)
  const online = useImStore(s => s.online)
  const error = useImStore(s => s.error)
  const clearError = useImStore(s => s.clearError)
  const [atBottom, setAtBottom] = useState(true)
  const [membersOpen, setMembersOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadedFor = useRef<number | null>(null)

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
    node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    setAtBottom(true)
  }, [])

  useLayoutEffect(() => {
    if (conversation && loadedFor.current !== conversation.id) {
      loadedFor.current = conversation.id
      window.requestAnimationFrame(() => scrollToBottom())
    }
  }, [conversation, messages.length, scrollToBottom])

  useEffect(() => {
    if (atBottom && messages.length) scrollToBottom()
  }, [messages.length, atBottom, scrollToBottom])

  const onScroll = () => {
    const node = scrollRef.current
    if (!node) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    setAtBottom(distance < 80)
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

  const openPreview = (attachmentId: number, name: string, mime: string) => {
    const index = imageGallery.findIndex(item => item.attachmentId === attachmentId)
    setLightbox({
      name, mime, attachmentId,
      gallery: imageGallery,
      galleryIndex: index >= 0 ? index : 0,
    })
  }

  // objectURL 由 ImImageLightbox 自己持有并在卸载时 revoke，这里只清状态
  const closeLightbox = () => setLightbox(null)

  if (!conversation) {
    return (
      <div className="relative flex flex-1 flex-col items-center justify-center gap-3 bg-background/40 text-muted-foreground">
        {/* 空态下 ImComposer 不渲染，错误条只在这里出现，不会与输入区的错误条重复 */}
        {error && (
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

  const isOnline = conversation.kind === 'direct'
    ? (conversation.other_user ? online[conversation.other_user.id] : false)
    : undefined

  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-background/30">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 bg-card/70 px-3 backdrop-blur-sm">
        {narrow && (
          <button type="button" onClick={onBack} title={t('im.chat.back', '返回列表')}
                  className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-accent cursor-pointer">
            <ChevronLeft size={18} />
          </button>
        )}
        <ImAvatar
          name={conversationTitle(conversation, {
            unknownUser: t('im.sidebar.unknownUser', '用户'),
            unnamedGroup: t('im.sidebar.unnamedGroup', '未命名群组'),
          })}
          avatar={conversation.kind === 'direct' ? conversation.other_user?.avatar : conversation.avatar}
          kind={conversation.kind === 'direct' ? 'user' : 'group'}
          size={36}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {conversationTitle(conversation, {
              unknownUser: t('im.sidebar.unknownUser', '用户'),
              unnamedGroup: t('im.sidebar.unnamedGroup', '未命名群组'),
            })}
          </p>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {conversation.kind === 'direct' ? (
              <><span className={`h-1.5 w-1.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                {isOnline ? t('im.online', '在线') : t('im.offline', '离线')}</>
            ) : t('im.sidebar.memberCount', {
              defaultValue: '{{count}} 位成员', count: conversation.member_count,
            })}
          </p>
        </div>
        {conversation.kind !== 'direct' && (
          <button type="button" onClick={openMembers} title={t('im.chat.groupMembers', '群成员')}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-primary cursor-pointer">
            <Users size={17} />
          </button>
        )}
      </header>

      <div ref={scrollRef} onScroll={onScroll}
           className="relative min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
           style={{ backgroundImage: 'radial-gradient(hsl(var(--muted-foreground) / 0.07) 1px, transparent 1px)', backgroundSize: '18px 18px' }}>
        {cursor?.hasMore && (
          <div className="flex justify-center">
            <button type="button" onClick={() => void loadMessages(conversation.id, 'older')}
                    className="rounded-full border border-border/70 bg-card/80 px-3 py-1 text-[11px] text-muted-foreground hover:text-primary cursor-pointer">
              {t('im.chat.loadEarlier', '加载更早的消息')}
            </button>
          </div>
        )}
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t('im.chat.noMessages', '还没有消息，发送第一条开始沟通')}
          </div>
        )}
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
                  onRetry={() => void sendText(message.content_text || '')}
                />
              )}
            </div>
          )
        })}
      </div>

      {!atBottom && (
        <button type="button" onClick={() => scrollToBottom(true)}
                className="absolute bottom-32 right-6 z-10 flex items-center gap-1 rounded-full border border-border bg-popover px-3 py-1.5 text-xs shadow-lg hover:text-primary cursor-pointer">
          <ArrowDown size={13} /> {t('im.chat.backToLatest', '回到最新')}
        </button>
      )}

      <ImComposer conversationId={conversation.id} />

      {lightbox && (
        <ImImageLightbox source={lightbox} onClose={closeLightbox} />
      )}

      {membersOpen && conversation && (
        <ImGroupMembersDialog conversation={conversation} onClose={() => setMembersOpen(false)} />
      )}
    </div>
  )
}
