/** 协作沟通主窗口：fixed 置顶、可拖拽缩放、双栏 / 窄窗口单栏。 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2, Minimize2, X } from 'lucide-react'

import { useImStore } from '../../store/imStore'
import { ImChatPanel } from './ImChatPanel'
import { ImGroupDialog } from './ImGroupDialog'
import { ImSidebar } from './ImSidebar'
import { useImWindowGeometry } from './useImWindowGeometry'
import type { ResizeDir } from './useImWindowGeometry'

interface Props {
  userId: number | null
  desktopMode: boolean
  onClose: () => void
}

const HANDLES: { dir: ResizeDir; className: string; cursor: string }[] = [
  { dir: 'n', className: 'left-3 right-3 top-0 h-1.5', cursor: 'ns-resize' },
  { dir: 's', className: 'bottom-0 left-3 right-3 h-1.5', cursor: 'ns-resize' },
  { dir: 'w', className: 'bottom-3 left-0 top-3 w-1.5', cursor: 'ew-resize' },
  { dir: 'e', className: 'bottom-3 right-0 top-3 w-1.5', cursor: 'ew-resize' },
  { dir: 'nw', className: 'left-0 top-0 h-3 w-3', cursor: 'nwse-resize' },
  { dir: 'ne', className: 'right-0 top-0 h-3 w-3', cursor: 'nesw-resize' },
  { dir: 'sw', className: 'bottom-0 left-0 h-3 w-3', cursor: 'nesw-resize' },
  { dir: 'se', className: 'bottom-0 right-0 h-3 w-3', cursor: 'nwse-resize' },
]

export function ImWindow({ userId, desktopMode, onClose }: Props) {
  const { t } = useTranslation()
  const topOffset = desktopMode ? 40 : 8
  const {
    rect, elementRef, maximized, toggleMaximize, startDrag, startResize,
  } = useImWindowGeometry(userId, topOffset)
  const [entered, setEntered] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const conversation = useImStore(s => s.conversations.find(c => c.id === s.activeConversationId) || null)
  const refreshConversations = useImStore(s => s.refreshConversations)
  const narrow = rect.w < 640

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true))
    void refreshConversations().catch(() => {})
    // 窗口重新展开时补拉当前会话正文：收起期间桌面端只刷会话列表（红点），
    // 不在这里补拉就会出现「红点有、聊天窗口没加载对方消息」。
    const state = useImStore.getState()
    if (state.activeConversationId !== null) {
      void state.loadMessages(state.activeConversationId, 'incremental').catch(() => {})
    }
    return () => window.cancelAnimationFrame(frame)
  }, [refreshConversations])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      // 事件目标可能是 window/document（无 closest），输入框聚焦时不拦截 Esc
      if (target && typeof target.closest === 'function'
          && target.closest('input, textarea, [contenteditable="true"]')) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      ref={elementRef}
      role="dialog"
      data-im-window
      aria-label={t('im.title', '项目沟通')}
      className="fixed z-[6000] flex flex-col overflow-hidden rounded-2xl border border-border/80 bg-card/95 shadow-[0_24px_70px_-12px_rgba(0,0,0,0.45)] backdrop-blur-xl"
      style={{
        left: rect.x, top: rect.y, width: rect.w, height: rect.h,
        opacity: entered ? 1 : 0,
        transform: entered ? 'scale(1)' : 'scale(0.96)',
        transition: 'opacity 180ms ease-out, transform 180ms ease-out',
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />

      <header
        onPointerDown={startDrag}
        onDoubleClick={toggleMaximize}
        className="flex h-12 shrink-0 cursor-grab select-none items-center gap-2 border-b border-border/60 bg-gradient-to-r from-primary/10 via-card/40 to-primary/5 px-3 active:cursor-grabbing"
        style={{ touchAction: 'none' }}
      >
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] font-semibold leading-tight">{t('im.title', '项目沟通')}</h2>
        </div>
        <HeaderButton title={maximized ? t('im.window.restore', '还原') : t('im.window.maximize', '最大化')}
                      onClick={toggleMaximize}>
          {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </HeaderButton>
        <HeaderButton title={t('im.window.close', '关闭并隐藏到悬浮图标')} onClick={onClose}>
          <X size={16} />
        </HeaderButton>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {(!narrow || !showChat) && (
          <ImSidebar onSelectConversation={() => { if (narrow) setShowChat(true) }} />
        )}
        {(!narrow || showChat) && (
          <ImChatPanel
            conversation={conversation}
            narrow={narrow}
            onBack={() => setShowChat(false)}
          />
        )}
        <ImGroupDialog />
      </div>

      {!maximized && HANDLES.map(handle => (
        <div
          key={handle.dir}
          onPointerDown={event => startResize(event, handle.dir)}
          className={`absolute z-10 ${handle.className}`}
          style={{ cursor: handle.cursor, touchAction: 'none' }}
        />
      ))}
    </div>
  )
}

function HeaderButton({ title, onClick, children }: {
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button" title={title} onClick={onClick}
      data-im-no-drag
      className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
    >
      {children}
    </button>
  )
}
