/**
 * 单条消息：文本气泡 / 图片缩略图（懒加载 + 灯箱）/ 视频（点击播放）/
 * 文件卡片（Office / PDF 双击用本地应用打开，单击下载）。
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
  onRetry?: () => void
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

/**
 * 只按服务端给的结构化名单高亮 @ 文本，切成 React 节点渲染。
 * 不用 innerHTML：用户名来自用户输入，拼 HTML 会引入 XSS。
 */
function highlightMentions(content: string, names: string[]): ReactNode[] {
  const unique = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!unique.length) return [content]
  const pattern = new RegExp(`@(${unique.map(escapeRegExp).join('|')})`, 'g')
  const nodes: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > last) nodes.push(content.slice(last, match.index))
    nodes.push(
      <mark key={`mention-${match.index}`}
            className="rounded bg-amber-300/70 px-0.5 font-medium text-amber-950 dark:bg-amber-400/40 dark:text-amber-50">
        {match[0]}
      </mark>,
    )
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
  const attachment = message.attachment
  const attachmentId = attachment?.id

  useEffect(() => {
    if (!attachmentId) return
    let objectUrl: string | null = null
    let cancelled = false
    const load = async () => {
      try {
        const blob = await imApi.attachmentBlob(attachmentId, Boolean(attachment?.has_thumb))
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
  }, [attachmentId, attachment?.has_thumb])

  const name = attachment?.original_name || t('im.message.image', '图片')
  return (
    <div className="w-[210px] max-w-full">
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
        <div className="flex h-[150px] w-full items-center justify-center rounded-xl border border-border/60 bg-muted/40 text-xs text-muted-foreground">
          {failed ? <><ImageIcon size={16} className="mr-1" />{t('im.message.imageFailed', '图片加载失败')}</>
            : <Loader2 size={18} className="animate-spin" />}
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
function FileBubble({ attachment, isMine }: {
  attachment: ImAttachmentInfo
  isMine: boolean
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
          void imApi.downloadAttachment(attachment.id, attachment.original_name)
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

function ImMessageItemBase({ message, isMine, onPreview, onRetry }: Props) {
  const { t } = useTranslation()
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
    <div className={`flex w-full gap-2 px-1 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}>
      <ImAvatar
        name={message.sender_name || initial}
        avatar={message.sender_avatar}
        kind="user"
        size={28}
        rounded="full"
        className="mt-0.5"
      />
      <div className={`flex max-w-[76%] flex-col ${isMine ? 'items-end' : 'items-start'}`}>
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{isMine ? t('im.message.me', '我') : message.sender_name}</span>
          <span>{formatClock(message.created_at)}</span>
        </div>
        <div className={`relative rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed shadow-sm
          ${isMine
            ? 'rounded-tr-md bg-primary text-primary-foreground'
            : 'rounded-tl-md border border-border/70 bg-card text-card-foreground'}
          ${message.mentioned_me ? 'ring-1 ring-primary/60' : ''}`}>
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
            <p className="whitespace-pre-wrap break-words">
              {highlightMentions(message.content_text || '', mentionNames)}
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
            <FileBubble attachment={attachment} isMine={isMine} />
          )}
          {message.failed && (
            <button
              type="button"
              onClick={onRetry}
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
