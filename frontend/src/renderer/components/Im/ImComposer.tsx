/**
 * 输入工具栏：文字草稿 + 待发送附件（粘贴 / 拖拽 / 选图 / 截图）+ 表情。
 *
 * 所有来源只把内容放进本地待发送队列，必须由「发送消息」按钮或 Enter 统一提交；
 * 粘贴、拖拽、选择文件、截图确认都不会直接调用发送接口。
 * 截图弹窗由 ImHost 应用级挂载（Alt+Z / 剪刀按钮统一走 requestScreenshot），
 * 结果经 imStore.pendingScreenshot 队列回到当前会话的输入框。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent as ReactChangeEvent, ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent, ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  AtSign, Check, ChevronDown, EyeOff, File as FileIcon, ImagePlus, Loader2,
  Paperclip, Scissors, Settings2, Smile, X,
} from 'lucide-react'

import { imApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import { IM_COMPOSER_FILL_EVENT, useImStore } from '../../store/imStore'
import { useThemeStore } from '../../store/themeStore'
import { useToastStore } from '../../store/toastStore'
import { EMOJI_GROUPS } from './emojis'
import { ImMentionPopup } from './ImMentionPopup'
import {
  openScreenshotSettings, requestScreenshot, SCREENSHOT_STABILIZE_EVENT,
} from './screenshotBus'
import {
  formatHotkey, getScreenshotSettings, saveScreenshotSettings, useScreenshotSettings,
} from './screenshotSettings'
import { formatBytes, imUserId } from './types'
import { openReceivedFile } from './attachmentKinds'
import type { ImMember, ImMentionTarget, ImSendMention } from './types'

interface PendingAttachment {
  id: string
  file: File
  previewUrl: string | null
}

let attachmentSeq = 0

function makeAttachments(files: File[]): PendingAttachment[] {
  return files.map(file => ({
    id: `pending-${Date.now()}-${attachmentSeq += 1}`,
    file,
    previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
  }))
}

function releaseAttachments(items: PendingAttachment[]) {
  items.forEach(item => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl) })
}

/** selector 空数组必须稳定，否则 zustand 每次返回新引用会反复重渲染 */
const EMPTY_MEMBERS: ImMember[] = []
/** 光标前最近的 @ 片段（兼容中文/字母数字用户名，最多 32 字） */
const MENTION_RE = /@([^\s@]{0,32})$/u
/** 「@所有人」的触发别名，中英文都能命中 */
const ALL_ALIASES = ['all', 'everyone', '所有人', '所有']

function parseMention(value: string, caret: number): { start: number; query: string } | null {
  const match = MENTION_RE.exec(value.slice(0, caret))
  if (!match) return null
  return { start: caret - match[0].length, query: match[1] }
}

export function ImComposer({ conversationId, onSent }: {
  conversationId: number
  /** 提交发送后回调：会话区据此跳回最新消息（即便此前停留在历史位置） */
  onSent?: () => void
}) {
  const { t } = useTranslation()
  const lightTheme = useThemeStore(s => s.themeMode === 'light')
  const [text, setText] = useState('')
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [screenshotMenuOpen, setScreenshotMenuOpen] = useState(false)
  const [emojiGroup, setEmojiGroup] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [mentionState, setMentionState] = useState<{ start: number; query: string } | null>(null)
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0)
  const [pendingMentions, setPendingMentions] = useState<ImSendMention>({
    mentions: [], mention_all: false,
  })
  const mentionRef = useRef<ImSendMention>({ mentions: [], mention_all: false })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const emojiRef = useRef<HTMLDivElement>(null)
  const screenshotRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef<PendingAttachment[]>([])

  const draftFor = useImStore(s => s.draftFor)
  const setDraft = useImStore(s => s.setDraft)
  const sendText = useImStore(s => s.sendText)
  const sendFiles = useImStore(s => s.sendFiles)
  const pendingScreenshot = useImStore(s => s.pendingScreenshot)
  const takeScreenshot = useImStore(s => s.takeScreenshot)
  const clearError = useImStore(s => s.clearError)
  const sending = useImStore(s => s.sending)
  const uploadProgress = useImStore(s => s.uploadProgress)
  const error = useImStore(s => s.error)
  const errorScope = useImStore(s => s.errorScope)
  const ensureMembers = useImStore(s => s.ensureMembers)
  const setLightbox = useImStore(s => s.setLightbox)
  const replyTo = useImStore(s => s.replyTo)
  const setReplyTo = useImStore(s => s.setReplyTo)
  const conversation = useImStore(s => s.conversations.find(c => c.id === conversationId) || null)
  const members = useImStore(s => s.membersByConversation[conversationId]) || EMPTY_MEMBERS
  const myId = useAuthStore(s => imUserId(s.user))
  const desktopMode = useAuthStore(s => s.desktopMode)
  const screenshotSettings = useScreenshotSettings()
  const isGroup = conversation !== null && conversation.kind !== 'direct'
  // 权限口径与服务端 _require_admin 一致：严格按本群 role，不用系统管理员位
  const canMentionAll = isGroup && myId !== null && members.some(
    m => m.id === myId && (m.role === 'owner' || m.role === 'admin'))

  useEffect(() => { pendingRef.current = pending }, [pending])

  const clearPending = useCallback(() => {
    releaseAttachments(pendingRef.current)
    pendingRef.current = []
    setPending([])
  }, [])

  const clearMentions = useCallback(() => {
    const empty: ImSendMention = { mentions: [], mention_all: false }
    mentionRef.current = empty
    setPendingMentions(empty)
    setMentionState(null)
    setMentionActiveIndex(0)
  }, [])

  useEffect(() => {
    setText(draftFor(conversationId))
    setNotice('')
    setEmojiOpen(false)
    clearPending()
    clearMentions()
    // 成员名单由 ensureMembers 的短 TTL 缓存维护；进入会话不再强制回源（共享模式走公网 relay）
  }, [conversationId, draftFor, clearPending, clearMentions])

  // 全局截图（输入框按钮 / Alt+Z）产出的 File 由 imStore 队列送到「当前会话」输入框。
  // 截图时若还没有激活会话，文件会一直留在队列里，等用户打开任一会话后自动补进来。
  useEffect(() => {
    if (!pendingScreenshot) return
    addFiles([pendingScreenshot])
    takeScreenshot()
    textareaRef.current?.focus()
    // addFiles / takeScreenshot 是稳定引用外的局部函数与 store action，只在队列变化时消费一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScreenshot, takeScreenshot])

  useEffect(() => () => releaseAttachments(pendingRef.current), [])

  // 点面板外关闭；面板内可以连点多个表情，不再点一个就关
  useEffect(() => {
    if (!emojiOpen && !screenshotMenuOpen) return
    const onDown = (event: PointerEvent) => {
      if (emojiRef.current && !emojiRef.current.contains(event.target as Node)) setEmojiOpen(false)
      if (screenshotRef.current && !screenshotRef.current.contains(event.target as Node)) {
        setScreenshotMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [emojiOpen, screenshotMenuOpen])

  // 四个截图入口（按钮 / 应用内快捷键 / 系统热键 / 重新取景）都会先广播稳定化事件：
  // 下拉必须收起，否则它会出现在壳层冻结的整屏快照里
  useEffect(() => {
    const onStabilize = () => {
      setScreenshotMenuOpen(false)
      setEmojiOpen(false)
    }
    window.addEventListener(SCREENSHOT_STABILIZE_EVENT, onStabilize)
    return () => window.removeEventListener(SCREENSHOT_STABILIZE_EVENT, onStabilize)
  }, [])

  /** 下拉里的「隐藏窗口截图」与设置面板共用一个持久开关 */
  const toggleHideImWindow = async () => {
    const current = getScreenshotSettings()
    try {
      const result = await saveScreenshotSettings(
        { ...current, hideImWindow: !current.hideImWindow }, Boolean(desktopMode))
      if (result.conflict) {
        setNotice(t('im.screenshot.settings.conflict',
          '该快捷键已被其它应用占用，已恢复原来的设置，请更换一个组合键'))
      }
    } catch {
      setNotice(t('im.screenshot.settings.saveFailed', '保存失败，请稍后重试'))
    }
  }

  const updateText = useCallback((value: string) => {
    setText(value)
    setDraft(value)
  }, [setDraft])

  // 撤回消息点「重新编辑」：store 广播原文，这里同步本地 textarea（只回填当前会话）
  useEffect(() => {
    const onFill = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      if (Number(detail.conversationId) !== conversationId) return
      const value = String(detail.text || '')
      updateText(value)
      textareaRef.current?.focus()
      window.requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(value.length, value.length)
      })
    }
    window.addEventListener(IM_COMPOSER_FILL_EVENT, onFill)
    return () => window.removeEventListener(IM_COMPOSER_FILL_EVENT, onFill)
  }, [conversationId, updateText])

  const mentionTargets = useMemo<ImMentionTarget[]>(() => {
    if (!isGroup || !mentionState) return []
    const keyword = mentionState.query.toLowerCase()
    const allLabel = t('im.mention.allLabel', '@所有人')
    const list: ImMentionTarget[] = []
    if (canMentionAll && (!keyword || ALL_ALIASES.some(alias => alias.includes(keyword))
        || allLabel.toLowerCase().includes(keyword))) {
      list.push({ id: 'all', username: allLabel })
    }
    for (const member of members) {
      if (member.id === myId) continue
      if (keyword && !member.username.toLowerCase().includes(keyword)) continue
      list.push({ id: member.id, username: member.username, is_online: member.is_online })
      if (list.length >= 30) break
    }
    return list
  }, [isGroup, mentionState, canMentionAll, members, myId, t])

  const onTextChange = (event: ReactChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value
    updateText(value)
    if (!isGroup) return
    const parsed = parseMention(value, event.target.selectionStart ?? value.length)
    setMentionState(parsed)
    setMentionActiveIndex(0)
    if (parsed) void ensureMembers(conversationId)
  }

  const selectMention = (target: ImMentionTarget) => {
    if (!mentionState) return
    const el = textareaRef.current
    const caret = el?.selectionStart ?? text.length
    const before = text.slice(0, mentionState.start)
    const after = text.slice(caret)
    const insert = `@${target.username.replace(/^@/, '')} `
    updateText(before + insert + after)

    const next: ImSendMention = {
      mentions: [...mentionRef.current.mentions],
      mention_all: mentionRef.current.mention_all,
    }
    if (target.id === 'all') next.mention_all = true
    else if (!next.mentions.includes(target.id)) next.mentions.push(target.id)
    mentionRef.current = next
    setPendingMentions(next)
    setMentionState(null)
    setMentionActiveIndex(0)
    window.requestAnimationFrame(() => {
      const pos = before.length + insert.length
      el?.setSelectionRange(pos, pos)
      el?.focus()
    })
  }

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionState && mentionTargets.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionActiveIndex(index => (index + 1) % mentionTargets.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionActiveIndex(index => (index - 1 + mentionTargets.length) % mentionTargets.length)
        return
      }
      // 中文输入法选字期间的 Enter 不参与候选选择，也不发送消息
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) {
        event.preventDefault()
        selectMention(mentionTargets[mentionActiveIndex])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMentionState(null)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  const addFiles = (files: FileList | File[] | null) => {
    if (!files || !files.length) return
    const next = makeAttachments(Array.from(files))
    pendingRef.current = [...pendingRef.current, ...next]
    setPending(prev => [...prev, ...next])
  }

  const removeAttachment = (id: string) => {
    releaseAttachments(pendingRef.current.filter(item => item.id === id))
    pendingRef.current = pendingRef.current.filter(item => item.id !== id)
    setPending(prev => prev.filter(item => item.id !== id))
  }

  /** 双击待发送附件打开预览：图片走可缩放灯箱，文件走新标签页 / 文件卡片 */
  const previewAttachment = (item: PendingAttachment) => {
    setLightbox({ name: item.file.name, mime: item.file.type || 'application/octet-stream', file: item.file })
  }

  /** 唯一的发送出口：文字 + 全部待发送附件一起提交 */
  const submit = async () => {
    const value = text.trim()
    const files = pendingRef.current.map(item => item.file)
    const mentionPayload = mentionRef.current
    const hasMention = mentionPayload.mentions.length > 0 || mentionPayload.mention_all
    if ((!value && !files.length) || busy || sending) return
    setBusy(true)
    updateText('')
    clearPending()
    setMentionState(null)
    // 发送即回到底部：乐观消息由 store 同步写入，后续消息到达时 atBottom 已为 true
    onSent?.()
    try {
      let textOk = true
      if (value) {
        textOk = hasMention
          ? await sendText(value, mentionPayload)
          : await sendText(value)
        // 失败保留草稿与结构化 @，点发送即可重发
        if (!textOk) updateText(value)
      }
      if (textOk && hasMention) clearMentions()
      if (files.length) {
        const failed = await sendFiles(files)
        if (failed.length) {
          const restored = makeAttachments(failed)
          pendingRef.current = restored
          setPending(restored)
        }
      }
    } finally {
      setBusy(false)
      textareaRef.current?.focus()
    }
  }

  // 绑定在整个输入区而不是 textarea：焦点在工具栏/附件预览上时粘贴截图也能接住。
  // 纯文本不 preventDefault，仍由聚焦的 textarea 默认插入草稿，绝不自动发送。
  const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData?.items || [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (files.length) {
      event.preventDefault()
      addFiles(files)
    }
  }

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragOver(false)
    addFiles(event.dataTransfer.files)
  }

  /** 引用预览里的附件链接：图片进灯箱，文件按桌面/网页各自方式打开 */
  const openReplyAttachment = async () => {
    const att = replyTo?.attachment
    if (!att?.id) return
    if (replyTo?.kind === 'image' || att.mime?.startsWith('image/')) {
      setLightbox({
        name: att.original_name, mime: att.mime || 'image/png',
        attachmentId: att.id, gallery: [], galleryIndex: 0,
      })
      return
    }
    try {
      await openReceivedFile(
        att.id, att.original_name, Boolean(desktopMode),
        id => imApi.openAttachment(id),
        (id, thumb) => imApi.attachmentBlob(id, thumb),
      )
    } catch {
      useToastStore.getState().show(t('im.message.openReplyAttachmentFailed', '打开引用附件失败'))
    }
  }

  // 输入框高度可拖拽调整：记住上次高度，范围 54~360px
  const [inputHeight, setInputHeight] = useState(() => {
    const saved = Number(localStorage.getItem('im-composer-height'))
    return Number.isFinite(saved) && saved >= 54 ? Math.min(360, saved) : 54
  })
  const resizeRef = useRef<{ y: number; height: number } | null>(null)

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeRef.current = { y: event.clientY, height: inputHeight }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current
    if (!drag) return
    const next = Math.min(360, Math.max(54, drag.height - (event.clientY - drag.y)))
    setInputHeight(next)
  }
  const onResizePointerUp = () => {
    if (!resizeRef.current) return
    resizeRef.current = null
    try { localStorage.setItem('im-composer-height', String(inputHeight)) } catch { /* 忽略 */ }
  }

  /** 只显示与当前会话相关的错误：一次 relay 繁忙不应在其它会话的输入框里刷屏 */
  const visibleError = error && (!errorScope || errorScope === 'global' || [
    `send:${conversationId}`, `file:${conversationId}`,
    `message:${conversationId}`, `group:${conversationId}`,
    `messages:${conversationId}`,
  ].includes(errorScope)) ? error : null

  const hasInput = !!text.trim() || pending.length > 0
  const disabled = !hasInput || busy || sending
  const hasPendingMention = pendingMentions.mention_all || pendingMentions.mentions.length > 0

  return (
    <div
      className={`relative flex flex-col border-t border-border/60 bg-card/80 backdrop-blur-sm transition-colors
        ${dragOver ? 'bg-primary/5' : ''}`}
      onDragOver={event => { event.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-primary/5 text-sm font-medium text-primary">
          {t('im.composer.dropHint', '松开即可添加为待发送附件')}
        </div>
      )}

      {isGroup && mentionState && (
        <ImMentionPopup
          targets={mentionTargets}
          activeIndex={mentionActiveIndex}
          onSelect={selectMention}
          onHover={setMentionActiveIndex}
        />
      )}

      {pending.length > 0 && (
        <div className="border-b border-border/50 px-3 py-2">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Paperclip size={12} />
            <span className="flex-1">
              {t('im.composer.pendingTitle', {
                defaultValue: '待发送附件 · {{count}}', count: pending.length,
              })}
            </span>
            <button type="button" onClick={clearPending}
                    className="hover:text-foreground cursor-pointer">
              {t('im.composer.clearAll', '清空附件')}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {pending.map(item => (
              <div key={item.id}
                   onDoubleClick={() => previewAttachment(item)}
                   title={t('im.composer.doubleClickPreview', '双击预览')}
                   className="relative flex max-w-[220px] cursor-pointer items-center gap-2 rounded-lg border border-border/70 bg-background/60 p-1.5 pr-6 hover:border-primary/50">
                {item.previewUrl
                  ? <img src={item.previewUrl} alt={item.file.name}
                         className="h-9 w-9 shrink-0 rounded object-cover" />
                  : <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-primary/10 text-primary">
                      <FileIcon size={17} />
                    </div>}
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-medium">{item.file.name}</p>
                  <p className="text-[10px] text-muted-foreground">{formatBytes(item.file.size)}</p>
                </div>
                <button type="button" onClick={() => removeAttachment(item.id)}
                        onDoubleClick={event => event.stopPropagation()}
                        title={t('im.composer.removeAttachment', '移除附件')}
                        className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/15 hover:text-destructive cursor-pointer">
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {uploadProgress && (
        <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin text-primary" />
          <span className="max-w-[180px] truncate">
            {t('im.composer.uploading', {
              defaultValue: '正在发送 {{name}}', name: uploadProgress.name,
            })}
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all"
                 style={{ width: `${uploadProgress.percent}%` }} />
          </div>
          <span>{uploadProgress.percent}%</span>
        </div>
      )}
      {(notice || visibleError) && (
        <div className="flex items-center gap-2 border-b border-border/50 px-4 py-1.5 text-[11px] text-amber-500">
          <span className="flex-1 truncate">{notice || (visibleError ? t(visibleError) : '')}</span>
          <button type="button" className="cursor-pointer hover:text-foreground"
                  onClick={() => { setNotice(''); clearError() }}>
            <X size={12} />
          </button>
        </div>
      )}

      {replyTo && (
        <div className="mx-3 mt-2 flex items-center gap-2 rounded-lg border-l-2 border-primary bg-primary/5 px-3 py-1.5 text-[11px]">
          <div className="min-w-0 flex-1">
            <span className="font-medium">{replyTo.sender_name || t('im.message.me', '我')}：</span>
            <span className="line-clamp-1">
              {replyTo.content_text || (replyTo.attachment ? replyTo.attachment.original_name : '')}
            </span>
            {replyTo.attachment?.id && (
              <button type="button" onClick={() => void openReplyAttachment()}
                      title={t('im.message.openReplyAttachment', '打开引用的附件')}
                      className="mt-0.5 flex max-w-full items-center gap-1 text-primary hover:underline cursor-pointer">
                <FileIcon size={11} />
                <span className="truncate">{replyTo.attachment.original_name}</span>
              </button>
            )}
          </div>
          <button type="button" onClick={() => setReplyTo(null)}
                  title={t('im.common.cancel', '取消')}
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent cursor-pointer">
            <X size={13} />
          </button>
        </div>
      )}

      {/* 拖拽此把手调整输入框高度（向上拖变高，向下拖变矮） */}
      <div data-im-composer-resize
           title={t('im.composer.resizeHint', '拖拽调整输入框高度')}
           onPointerDown={onResizePointerDown}
           onPointerMove={onResizePointerMove}
           onPointerUp={onResizePointerUp}
           onPointerCancel={onResizePointerUp}
           className="mx-auto -mb-0.5 flex h-3 w-16 shrink-0 cursor-ns-resize touch-none items-center justify-center">
        <span className="h-1 w-10 rounded-full bg-border transition-colors hover:bg-primary/60" />
      </div>

      <div className={`mx-3 mb-3 flex flex-col rounded-xl border border-border/70 transition-colors focus-within:border-primary/70 focus-within:ring-2 focus-within:ring-primary/15 ${
        lightTheme ? 'bg-[#FAFAFA]' : 'bg-background/70'
      }`}>
        <textarea
          ref={textareaRef}
          value={text}
          rows={2}
          onChange={onTextChange}
          onKeyDown={onComposerKeyDown}
          placeholder={t('im.composer.placeholder', '输入消息，输入 @ 可点名成员，粘贴截图/拖入文件后确认再发送…')}
          style={{ height: inputHeight }}
          className="block min-h-[54px] w-full resize-none bg-transparent px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <div className="order-last flex items-center gap-1 px-2 pb-2 pt-1">
          <ToolButton title={t('im.composer.sendImage', '添加图片')}
                      onClick={() => imageInputRef.current?.click()}>
            <ImagePlus size={17} />
          </ToolButton>
          <div className="relative flex items-center" ref={screenshotRef}>
            <ToolButton
              title={`${t('im.composer.screenshot', '截图')}（${formatHotkey(screenshotSettings.hotkey)}）`}
              onClick={() => { setScreenshotMenuOpen(false); requestScreenshot() }}>
              <Scissors size={17} />
            </ToolButton>
            <button type="button"
                    title={t('im.composer.screenshotOptions', '截图选项')}
                    onClick={() => setScreenshotMenuOpen(value => !value)}
                    className="flex h-8 w-4 items-center justify-center text-muted-foreground transition-colors hover:text-primary cursor-pointer">
              <ChevronDown size={12} />
            </button>
            {screenshotMenuOpen && (
              <div className="absolute bottom-10 left-0 z-20 w-[228px] rounded-xl border border-border bg-popover p-1.5 shadow-xl">
                <button type="button"
                        onClick={() => { setScreenshotMenuOpen(false); void toggleHideImWindow() }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-accent cursor-pointer">
                  <EyeOff size={14} className="shrink-0 text-muted-foreground" />
                  <span className="flex-1">
                    {t('im.screenshot.settings.hideImWindow', '隐藏窗口截图')}
                  </span>
                  {screenshotSettings.hideImWindow && <Check size={14} className="text-primary" />}
                </button>
                <button type="button"
                        onClick={() => { setScreenshotMenuOpen(false); openScreenshotSettings() }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-accent cursor-pointer">
                  <Settings2 size={14} className="shrink-0 text-muted-foreground" />
                  <span className="flex-1">{t('im.screenshot.settings.title', '截图设置')}</span>
                </button>
                <p className="border-t border-border/60 px-2 pb-0.5 pt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                  {t('im.composer.screenshotHotkeyHint', {
                    defaultValue: '快捷键 {{hotkey}}',
                    hotkey: formatHotkey(screenshotSettings.hotkey),
                  })}
                </p>
              </div>
            )}
          </div>
          <ToolButton title={t('im.composer.sendFile', '添加文件')}
                      onClick={() => fileInputRef.current?.click()}>
            <Paperclip size={17} />
          </ToolButton>
          <div className="relative" ref={emojiRef}>
            <ToolButton title={t('im.composer.emoji', '表情')}
                        onClick={() => setEmojiOpen(value => !value)}>
              <Smile size={17} />
            </ToolButton>
            {emojiOpen && (
              <div className="absolute bottom-10 left-0 z-20 w-[286px] rounded-xl border border-border bg-popover p-2 shadow-xl">
                <div className="mb-1.5 flex gap-0.5 border-b border-border/60 pb-1.5">
                  {EMOJI_GROUPS.map((group, index) => (
                    <button key={group.key} type="button" title={t(group.key)}
                            onClick={() => setEmojiGroup(index)}
                            className={`flex h-7 flex-1 items-center justify-center rounded-md text-base transition-colors cursor-pointer
                              ${emojiGroup === index ? 'bg-primary/15' : 'hover:bg-accent'}`}>
                      {group.icon}
                    </button>
                  ))}
                </div>
                <p className="mb-1 px-0.5 text-[10px] text-muted-foreground">
                  {t(EMOJI_GROUPS[emojiGroup].key)}
                </p>
                <div className="grid max-h-[168px] grid-cols-8 gap-0.5 overflow-y-auto">
                  {EMOJI_GROUPS[emojiGroup].emojis.map((emoji, index) => (
                    <button key={`${emojiGroup}-${index}`} type="button"
                            onClick={() => {
                              updateText((textareaRef.current?.value ?? text) + emoji)
                              textareaRef.current?.focus()
                            }}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-lg hover:bg-accent cursor-pointer">
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          {hasPendingMention && (
            <button type="button" onClick={clearMentions}
                    title={t('im.mention.clear', '清除 @')}
                    className="flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/20 cursor-pointer">
              <AtSign size={11} />
              {pendingMentions.mention_all
                ? t('im.mention.allLabel', '@所有人')
                : t('im.mention.count', {
                  defaultValue: '@ {{count}} 人', count: pendingMentions.mentions.length,
                })}
              <X size={10} />
            </button>
          )}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={disabled}
            title={t('im.composer.sendMessage', '发送消息')}
            className={`ml-auto flex h-[30px] min-w-[66px] shrink-0 items-center justify-center gap-1 rounded-lg px-3 text-xs font-medium transition-all cursor-pointer ${
              hasInput
                ? 'bg-primary text-primary-foreground shadow-lg hover:brightness-110 active:scale-95 disabled:opacity-60 disabled:shadow-none'
                : `${lightTheme ? 'bg-[#EDEDED]' : 'bg-muted'} text-muted-foreground shadow-none`
            }`}
          >
            {(busy || sending) && <Loader2 size={13} className="animate-spin" />}
            {t('im.send', '发送')}
          </button>
        </div>
      </div>

      <input ref={imageInputRef} type="file" accept="image/*" multiple hidden
             onChange={event => { addFiles(event.target.files); event.target.value = '' }} />
      <input ref={fileInputRef} type="file" multiple hidden
             onChange={event => { addFiles(event.target.files); event.target.value = '' }} />

    </div>
  )
}

function ToolButton({ title, onClick, children }: {
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button" title={title} onClick={onClick}
      className="flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors hover:text-primary cursor-pointer"
    >
      {children}
    </button>
  )
}
