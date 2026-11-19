/** 转发目标选择：可多选个人会话与群聊，复用侧栏同一套会话标题。 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

import { useAuthStore } from '../../store/authStore'
import { conversationTitle, imDisplayName } from './types'
import type { ImConversation } from './types'

interface Props {
  open: boolean
  conversations: ImConversation[]
  count: number
  onClose: () => void
  onConfirm: (conversationIds: number[]) => Promise<boolean>
}

export function ImForwardDialog({ open, conversations, count, onClose, onConfirm }: Props) {
  const { t } = useTranslation()
  const desktopMode = useAuthStore(s => s.desktopMode)
  const currentUser = useAuthStore(s => s.user)
  const [selected, setSelected] = useState<number[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (open) setSelected([]) }, [open])

  if (!open) return null

  const toggle = (id: number) => setSelected(list =>
    list.includes(id) ? list.filter(value => value !== id) : [...list, id])

  const confirm = async () => {
    if (!selected.length || busy) return
    setBusy(true)
    const ok = await onConfirm(selected)
    setBusy(false)
    if (ok) onClose()
  }

  return createPortal(
    <div data-im-forward-dialog
         className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/55"
         style={desktopMode ? { paddingTop: 32 } : undefined}
         onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className="flex max-h-[80vh] w-[min(420px,92vw)] flex-col rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-3">
          <h3 className="flex-1 text-sm font-semibold">
            {t('im.message.forwardTitle', '转发 {{count}} 条消息', { count })}
          </h3>
          <button type="button" onClick={onClose} title={t('im.common.close', '关闭')}
                  className="rounded-md p-1 text-muted-foreground hover:bg-accent cursor-pointer">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {conversations.length === 0 && (
            <p className="py-8 text-center text-xs text-muted-foreground">
              {t('im.message.noConversation', '暂无可转发的会话')}
            </p>
          )}
          {conversations.map(conv => {
            const checked = selected.includes(conv.id)
            return (
              <button key={conv.id} type="button" onClick={() => toggle(conv.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs
                        hover:bg-accent cursor-pointer ${checked ? 'bg-primary/10' : ''}`}>
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border
                  ${checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>
                  {checked ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {conversationTitle(conv, {
                    unknownUser: t('im.sidebar.unknownUser', '用户'),
                    unnamedGroup: t('im.sidebar.unnamedGroup', '未命名群组'),
                    selfName: imDisplayName(currentUser),
                  })}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {conv.kind === 'direct'
                    ? t('im.message.person', '个人')
                    : t('im.message.group', '群聊')}
                </span>
              </button>
            )
          })}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-border/70 px-4 py-3">
          <button type="button" onClick={onClose}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-accent cursor-pointer">
            {t('im.common.cancel', '取消')}
          </button>
          <button type="button" disabled={!selected.length || busy} onClick={() => void confirm()}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50 cursor-pointer">
            {t('im.message.forward', '转发')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
