/**
 * 单条消息：文本气泡 / 图片缩略图（懒加载 + 灯箱）/ 视频（点击播放）/
 * 文件卡片（Office / PDF 双击用本地应用打开，单击下载）。
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Download, File as FileIcon, FileSpreadsheet, FileText, Film, ImageIcon,
  Loader2, Play, RotateCcw,
} from 'lucide-react'

import { imApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import { formatBytes, formatClock } from './types'
import type { ImAttachmentInfo, ImMessage } from './types'
import { ImAvatar } from './ImAvatar'
import { isOpenableDocument, isVideoFile, openReceivedFile } from './attachmentKinds'

interface Props {
  message: ImMessage
  isMine: boolean
  onPreview: (attachmentId: number, name: string, mime: string) => void
  /** 重发本条消息；参数即当前消息，调用方可以传稳定回调让 memo 生效 */
  onRetry?: (message: ImMessage) => void
  /** 撤回后点击占位把原文放回输入框（只有发送者能编辑） */
  onEditRecalled?: (message: ImMessage) => void
  /** 桌面端文件下载：保存本地并在文件夹定位；网页端不传则走浏览器下载 */
  onDownloadFile?: (message: ImMessage) => void
  /** 右键菜单：由 ImChatPanel 统一弹出 */
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>, message: ImMessage) => void
  selectionMode?: boolean
  selected?: boolean
  onToggleSelect?: (messageId: number) => void
}

function fileIcon(name: string) {
  const lower = name.toLowerCase()
  if (/\.(xlsx|xls|csv|et|xlsm)$/.test(lower)) return FileSpreadsheet
  if (/\.(doc|docx|pdf|txt|md|ppt|pptx|rtf|wps)$/.test(lower)) return FileText
  if (isVideoFile(lower)) return Film
  return FileIcon
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 只识别 http/https，避免 javascript: 等协议被渲染成可点链接 */
const URL_PATTERN = String.raw`https?:\/\/[^\s<>"']+`
const URL_TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、）】」』]+$/

/** 点击聊天里的网址：桌面 pywebview 中 window.open 会交给系统浏览器，网页端开新标签页 */
function openMessageUrl(event: ReactMouseEvent<HTMLAnchorElement>, url: string) {
  event.preventDefault()
  event.stopPropagation()
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * 把正文切成 React 节点：@ 按服务端结构化名单高亮，网址渲染成可点链接。
 * 不用 innerHTML：用户名和网址都来自用户输入，拼 HTML 会引入 XSS。
 */
function renderMessageContent(content: string, names: string[]): ReactNode[] {
  const unique = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length)
  const mentionPattern = unique.length ? `@(${unique.map(escapeRegExp).join('|')})` : ''
  const pattern = new RegExp(mentionPattern ? `${mentionPattern}|${URL_PATTERN}` : URL_PATTERN, 'g')
  const nodes: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > last) nodes.push(content.slice(last, match.index))
    if (match[1]) {
      nodes.push(
        <mark key={`mention-${match.index}`}
              className="rounded bg-amber-300/70 px-0.5 font-medium text-amber-950 dark:bg-amber-400/40 dark:text-amber-50">
          {match[0]}
        </mark>,
      )
    } else {
      const url = match[0].replace(URL_TRAILING_PUNCTUATION, '')
      const urlEnd = match.index + url.length
      const matchEnd = match.index + match[0].length
      if (url) {
        nodes.push(
          <a key={`url-${match.index}`} href={url} target="_blank" rel="noopener noreferrer"
             onClick={event => openMessageUrl(event, url)}
             className="break-words [overflow-wrap:anywhere] underline underline-offset-2 hover:opacity-80 cursor-pointer">
            {url}
          </a>,
        )
      }
      if (urlEnd < matchEnd) nodes.push(content.slice(urlEnd, matchEnd))
    }
    last = match.index + match[0].length
  }
  if (last < content.length) nodes.push(content.slice(last))
  return nodes
}

function ImageBubble({ message, onPreview }: {
  message: ImMessage
  onPreview: (attachmentId: number, name: string, mime: string) => void
}) {
  const { t } = useTranslation()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
  const holderRef = useRef<HTMLDivElement>(null)
  const attachment = message.attachment
  const attachmentId = attachment?.id
  const thumb = Boolean(attachment?.has_thumb)

  // 只加载视口附近的图片：翻历史时不再给几十张图同时发公网请求
  useEffect(() => {
    const node = holderRef.current
    if (!node || visible) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '400px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [visible, attachmentId])

  useEffect(() => {
    if (!attachmentId || !visible) return
    let objectUrl: string | null = null
    let cancelled = false
    setFailed(false)
    const load = async () => {
      try {
        const blob = await imApi.attachmentBlob(attachmentId, thumb)
        objectUrl = URL.createObjectURL(blob)
        if (!cancelled) setUrl(objectUrl)
        else URL.revokeObjectURL(objectUrl)
      } catch {
        if (!cancelled) setFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachmentId, thumb, visible, retryCount])

  const name = attachment?.original_name || t('im.message.image', '图片')
  return (
    <div ref={holderRef} className="w-[210px] max-w-full">
      {url ? (
        <button
          type="button"
          onClick={() => attachmentId && onPreview(attachmentId, name, attachment?.mime || 'image/png')}
          className="group relative block w-full overflow-hidden rounded-xl border border-border/60 bg-muted/40 cursor-pointer"
          title={t('im.message.clickPreview', '点击查看大图')}
        >
          <img
            src={url}
            alt={name}
            loading="lazy"
            decoding="async"
            className="h-[150px] w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
          <span className="absolute inset-x-0 bottom-0 truncate bg-black/45 px-2 py-1 text-left text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
            {name}
          </span>
        </button>
      ) : (
        <div className="flex h-[150px] w-full flex-col items-center justify-center gap-1 rounded-xl border border-border/60 bg-muted/40 text-xs text-muted-foreground">
          {failed ? (
            <button type="button"
                    onClick={() => setRetryCount(value => value + 1)}
                    className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent cursor-pointer">
              <RotateCcw size={14} /> {t('im.message.imageFailed', '图片加载失败，重试')}
            </button>
          ) : visible ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <ImageIcon size={18} />
          )}
        </div>
      )}
    </div>
  )
}

/** 收到的视频：点播放按钮才拉取 Blob（避免聊天列表把大视频全部预载），随后内联播放。 */
function VideoBubble({ attachment }: { attachment: ImAttachmentInfo }) {
  const { t } = useTranslation()
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const urlRef = useRef<string | null>(null)

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
  }, [])

  const play = async () => {
    if (url || loading) return
    setLoading(true)
    setFailed(false)
    try {
      const blob = await imApi.attachmentBlob(attachment.id)
      const objectUrl = URL.createObjectURL(new Blob([blob], { type: blob.type || 'video/mp4' }))
      urlRef.current = objectUrl
      setUrl(objectUrl)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-[280px] max-w-full">
      {url ? (
        <video
          src={url}
          controls
          autoPlay
          playsInline
          preload="metadata"
          className="max-h-[260px] w-full rounded-xl bg-black"
        />
      ) : (
        <button type="button" onClick={() => void play()} disabled={loading}
                title={t('im.message.playVideo', '点击播放视频')}
                className="relative flex h-[150px] w-full items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-black/70 text-white disabled:opacity-60 cursor-pointer">
          <span className="absolute inset-0 bg-gradient-to-br from-slate-700/50 to-slate-900/70" />
          {loading
            ? <Loader2 size={26} className="relative animate-spin" />
            : <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm">
                <Play size={22} fill="currentColor" className="ml-0.5" />
              </span>}
          <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-2 py-1 text-left text-[11px]">
            {attachment.original_name}
          </span>
        </button>
      )}
      {failed && (
        <p className="mt-1 text-[11px] text-red-400">
          {t('im.message.videoFailed', '视频加载失败，可点右侧按钮下载后播放')}
        </p>
      )}
    </div>
  )
}

/** Office / PDF 等文件：双击交给系统默认应用打开（桌面端），网页端退化为新标签页预览。 */
function FileBubble({ attachment, isMine, onDownload }: {
  attachment: ImAttachmentInfo
  isMine: boolean
  onDownload?: () => void
}) {
  const { t } = useTranslation()
  const desktopMode = useAuthStore(s => s.desktopMode)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState(false)
  const Icon = fileIcon(attachment.original_name)
  const canOpen = isOpenableDocument(attachment.original_name)

  const open = async () => {
    if (opening) return
    setOpening(true)
    setError(false)
    try {
      await openReceivedFile(
        attachment.id, attachment.original_name, desktopMode,
        id => imApi.openAttachment(id),
        (id, thumb) => imApi.attachmentBlob(id, thumb),
      )
    } catch {
      setError(true)
    } finally {
      setOpening(false)
    }
  }

  return (
    <div
      className={`flex min-w-[220px] items-center gap-3 rounded-xl p-1
        ${isMine ? 'bg-white/10' : 'bg-muted/50'}
        ${canOpen ? 'cursor-pointer' : ''}`}
      onDoubleClick={() => { if (canOpen) void open() }}
      title={canOpen
        ? t('im.message.doubleClickOpen', '双击用本地应用打开')
        : attachment.original_name}
    >
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg
        ${isMine ? 'bg-white/20' : 'bg-primary/10 text-primary'}`}>
        {opening ? <Loader2 size={20} className="animate-spin" /> : <Icon size={20} />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{attachment.original_name}</p>
        <p className={`text-[11px] ${isMine ? 'text-white/70' : 'text-muted-foreground'}`}>
          {error
            ? t('im.message.openFailed', '打开失败，请下载后手动打开')
            : `${formatBytes(attachment.size_bytes)}${canOpen ? ` · ${t('im.message.doubleClickOpen', '双击打开')}` : ''}`}
        </p>
      </div>
      <button
        type="button"
        title={t('im.message.download', '下载文件')}
        onClick={event => {
          event.stopPropagation()
          if (onDownload) onDownload()
          else void imApi.downloadAttachment(attachment.id, attachment.original_name)
        }}
        onDoubleClick={event => event.stopPropagation()}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors cursor-pointer
          ${isMine ? 'hover:bg-white/20' : 'hover:bg-primary/15 hover:text-primary'}`}
      >
        <Download size={16} />
      </button>
    </div>
  )
}

/** 引用块里的附件链接：图片进灯箱，其它文件交给系统默认应用 / 浏览器打开。 */
function ReplyAttachmentLink({ attachment, isImage, onPreview }: {
  attachment: ImAttachmentInfo
  isImage: boolean
  onPreview: (attachmentId: number, name: string, mime: string) => void
}) {
  const { t } = useTranslation()
  const desktopMode = useAuthStore(s => s.desktopMode)
  const [busy, setBusy] = useState(false)

  const open = async () => {
    if (isImage) {
      onPreview(attachment.id, attachment.original_name, attachment.mime)
      return
    }
    setBusy(true)
    try {
      await openReceivedFile(
        attachment.id, attachment.original_name, desktopMode,
        id => imApi.openAttachment(id),
        (id, thumb) => imApi.attachmentBlob(id, thumb),
      )
    } catch {
      /* 失败保持原样，用户可重试 */
    } finally {
      setBusy(false)
    }
  }

  const Icon = isImage ? ImageIcon : FileIcon
  return (
    <button type="button" onClick={() => void open()}
            title={t('im.message.openReplyAttachment', '打开引用的附件')}
            className="mt-1 flex max-w-full items-center gap-1 text-primary hover:underline cursor-pointer">
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />}
      <span className="truncate">{attachment.original_name}</span>
    </button>
  )
}

function ImMessageItemBase({
  message, isMine, onPreview, onRetry, onEditRecalled, onDownloadFile, onContextMenu,
  selectionMode = false, selected = false, onToggleSelect,
}: Props) {
  const { t } = useTranslation()
  // 自己发的消息也按服务端下发的真实账号名展示，不再写成「我」
  const selfName = useAuthStore(s => s.user?.username || '')
  const initial = (message.sender_name || '?').slice(0, 1).toUpperCase()
  const allLabel = t('im.mention.allLabel', '@所有人')
  const mentionNames = useMemo(() => {
    const names = new Set((message.mentions || []).map(item => item.username).filter(Boolean))
    if (message.mention_all) names.add(allLabel.replace(/^@/, ''))
    return [...names]
  }, [message.mentions, message.mention_all, allLabel])
  const showMentionChips = Boolean(message.mention_all || message.mentioned_me)
  const chipClass = isMine ? 'bg-white/20 text-white' : 'bg-primary/15 text-primary'
  const attachment = message.attachment

  return (
    <div
      data-im-message-id={message.id}
      onContextMenu={event => {
        if (selectionMode) { onToggleSelect?.(message.id); return }
        onContextMenu?.(event, message)
      }}
      className={`flex w-full gap-2 px-1 ${isMine ? 'flex-row-reverse' : 'flex-row'}
        ${selectionMode ? 'rounded-lg bg-primary/5 py-0.5' : ''}
        ${selected ? 'ring-1 ring-primary/70' : ''}`}>
      {selectionMode && (
        <button type="button" aria-label={t('im.message.select', '选择')}
                onClick={() => onToggleSelect?.(message.id)}
                className={`mt-3 h-5 w-5 shrink-0 rounded border cursor-pointer
                  ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>
          {selected ? '✓' : ''}
        </button>
      )}
      <ImAvatar
        name={message.sender_name || initial}
        avatar={message.sender_avatar}
        kind="user"
        size={28}
        rounded="full"
        className="mt-0.5"
      />
      <div className={`flex min-w-0 max-w-[76%] flex-col ${isMine ? 'items-end' : 'items-start'}`}>
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{message.sender_name || selfName || t('im.message.me', '我')}</span>
          <span>{formatClock(message.created_at)}</span>
        </div>
        <div className={`relative max-w-full min-w-0 rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed shadow-sm
          ${isMine
            ? 'rounded-tr-md bg-primary text-primary-foreground'
            : 'rounded-tl-md border border-border/70 bg-card text-card-foreground'}
          ${message.mentioned_me ? 'ring-1 ring-primary/60' : ''}`}>
          {message.recalled ? (
            isMine
              ? message.content_text ? (
                <button type="button" onClick={() => onEditRecalled?.(message)}
                        title={t('im.message.recalledEditHint', '点击回填到输入框重新编辑')}
                        className="block w-full cursor-pointer text-left opacity-75 hover:opacity-100">
                  <span className="mb-1 block text-[11px] italic">
                    {t('im.message.recalledByMe', '已撤回，点击重新编辑')}
                  </span>
                  <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {message.content_text}
                  </span>
                </button>
              ) : (
                <span className="italic opacity-75">
                  {t('im.message.recalledByMeNoText', '你撤回了一条消息')}
                </span>
              )
              : (
                <span className="italic opacity-75">
                  {t('im.message.recalledByOther', '对方撤回了一条消息')}
                </span>
              )
          ) : (
            <>
              {message.reply_to && (
                <div className={`mb-1.5 border-l-2 pl-2 text-[11px] opacity-80
                  ${isMine ? 'border-primary-foreground/60' : 'border-primary/60'}`}>
                  <span className="font-medium">{message.reply_to.sender_name || selfName || t('im.message.me', '我')}：</span>
                  {message.reply_to.preview
                    && !(message.reply_to.attachment && message.reply_to.preview.startsWith('[附件]')) && (
                    <span className="line-clamp-2">{message.reply_to.preview}</span>
                  )}
                  {message.reply_to.attachment?.id ? (
                    <ReplyAttachmentLink
                      attachment={message.reply_to.attachment}
                      isImage={message.reply_to.kind === 'image'
                        || Boolean(message.reply_to.attachment.mime?.startsWith('image/'))}
                      onPreview={onPreview}
                    />
                  ) : !message.reply_to.preview ? (
                    <span className="line-clamp-2">[附件]</span>
                  ) : null}
                </div>
              )}
              {showMentionChips && (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {message.mention_all && (
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${chipClass}`}>
                      {allLabel}
                    </span>
                  )}
                  {message.mentioned_me && (
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${chipClass}`}>
                      {t('im.mention.meLabel', '@我')}
                    </span>
                  )}
                </div>
              )}
              {message.kind === 'text' && (
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {renderMessageContent(message.content_text || '', mentionNames)}
                </p>
              )}
              {message.kind === 'image' && attachment && (
                <ImageBubble message={message} onPreview={onPreview} />
              )}
              {(message.kind === 'file' || message.kind === 'image') && attachment
                && isVideoFile(attachment.original_name, attachment.mime) && (
                <VideoBubble attachment={attachment} />
              )}
              {message.kind === 'file' && attachment
                && !isVideoFile(attachment.original_name, attachment.mime) && (
                <FileBubble attachment={attachment} isMine={isMine}
                            onDownload={onDownloadFile ? () => onDownloadFile(message) : undefined} />
              )}
            </>
          )}
          {message.failed && (
            <button
              type="button"
              onClick={() => onRetry?.(message)}
              className="mt-2 flex items-center gap-1 text-[11px] text-red-200 hover:text-white cursor-pointer"
            >
              <RotateCcw size={12} /> {t('im.message.retry', '发送失败，重试')}
            </button>
          )}
        </div>
        {message.pending && (
          <span className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 size={10} className="animate-spin" /> {t('im.message.sending', '发送中')}
          </span>
        )}
      </div>
    </div>
  )
}

export const ImMessageItem = memo(ImMessageItemBase)
