/** 历史消息右键菜单：复制 / 引用 / 多选 / 转发 / 删除。 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  CheckSquare, Copy, CornerUpLeft, FolderOpen, Forward, RotateCcw, Trash2,
} from 'lucide-react'

import type { ImMessage } from './types'

export interface MessageMenuState {
  message: ImMessage
  x: number
  y: number
}

interface Props {
  state: MessageMenuState
  onClose: () => void
  onCopy: (message: ImMessage) => void
  /** 桌面端附件消息：保存到本地并在文件管理器中定位 */
  onRevealFile?: (message: ImMessage) => void
  canRevealFile?: boolean
  onRecall: (message: ImMessage) => void
  onQuote: (message: ImMessage) => void
  onMultiSelect: (message: ImMessage) => void
  onForward: (message: ImMessage) => void
  onDelete: (message: ImMessage) => void
  /** 只有自己发出的消息才可删除（删除仅对自己隐藏） */
  canDelete?: boolean
  /** null/undefined = 不显示撤回项；false = 显示但置灰（已撤回 / 超过 5 分钟） */
  canRecall?: boolean | null
}

export function ImMessageContextMenu({
  state, onClose, onCopy, onRevealFile, onRecall, onQuote, onMultiSelect, onForward, onDelete,
  canDelete = false, canRecall = null, canRevealFile = false,
}: Props) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])

  const run = (action: (message: ImMessage) => void) => {
    onClose()
    action(state.message)
  }

  const items: Array<{
    key: string; label: string; icon: ReactNode; action: (m: ImMessage) => void; disabled?: boolean
  }> = [
    { key: 'copy', label: t('im.message.menu.copy', '复制'), icon: <Copy size={14} />, action: onCopy },
    ...(canRevealFile && onRevealFile ? [{
      key: 'revealFile', label: t('im.message.menu.revealFile', '在文件夹中显示'),
      icon: <FolderOpen size={14} />, action: onRevealFile,
    }] : []),
    ...(canRecall === null || canRecall === undefined ? [] : [{
      key: 'recall', label: t('im.message.menu.recall', '撤回'), icon: <RotateCcw size={14} />,
      action: onRecall, disabled: !canRecall,
    }]),
    { key: 'quote', label: t('im.message.menu.quote', '引用'), icon: <CornerUpLeft size={14} />, action: onQuote },
    { key: 'multiSelect', label: t('im.message.menu.multiSelect', '多选'), icon: <CheckSquare size={14} />, action: onMultiSelect },
    { key: 'forward', label: t('im.message.menu.forward', '转发'), icon: <Forward size={14} />, action: onForward },
    // 删除只对操作者自己隐藏，且仅限自己发出的消息；对方的右键菜单不出现这一项
    ...(canDelete
      ? [{ key: 'delete', label: t('im.message.menu.delete', '删除'), icon: <Trash2 size={14} />, action: onDelete }]
      : []),
  ]

  return createPortal(
    <div ref={ref} data-im-message-menu
         className="fixed z-[10050] min-w-[132px] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
         style={{
           left: Math.max(4, Math.min(state.x, window.innerWidth - 156)),
           top: Math.max(4, Math.min(state.y, window.innerHeight - 220)),
         }}
         onContextMenu={event => event.preventDefault()}>
      {items.map(item => (
        <button key={item.key} type="button" disabled={item.disabled}
                title={item.disabled && item.key === 'recall'
                  ? t('im.message.recallExpired', '发送超过 5 分钟，无法撤回') : undefined}
                onClick={() => { if (!item.disabled) run(item.action) }}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs
                  ${item.disabled
                    ? 'cursor-not-allowed text-muted-foreground opacity-45'
                    : 'hover:bg-accent hover:text-accent-foreground cursor-pointer'}
                  ${item.key === 'delete' ? 'text-destructive' : ''}`}>
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
