/**
 * 群聊 @ 候选浮层。
 *
 * 用 absolute（而非 fixed）相对输入区向上弹出：ImComposer 有 backdrop-blur、
 * ImWindow 有 transform + overflow-hidden，fixed 会被困在错误的包含块里并被裁掉。
 * 键盘（↑↓/Enter/Tab/Esc）由 ImComposer 的 textarea 统一托管，这里只负责渲染与点选。
 */
import { useTranslation } from 'react-i18next'
import { AtSign, UsersRound } from 'lucide-react'

import type { ImMentionTarget } from './types'

interface Props {
  targets: ImMentionTarget[]
  activeIndex: number
  onSelect: (target: ImMentionTarget) => void
  onHover: (index: number) => void
}

export function ImMentionPopup({ targets, activeIndex, onSelect, onHover }: Props) {
  const { t } = useTranslation()
  return (
    <div className="absolute bottom-full left-3 z-40 mb-2 w-[248px] overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
      <p className="border-b border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">
        {t('im.mention.pickTitle', '选择要 @ 的成员')}
      </p>
      <div className="max-h-[208px] overflow-y-auto py-1">
        {targets.length === 0 && (
          <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            {t('im.mention.noMatch', '没有匹配的成员')}
          </p>
        )}
        {targets.map((target, index) => (
          <button
            key={target.id}
            type="button"
            // 保留 textarea 焦点，插入后光标位置才可恢复
            onMouseDown={event => event.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onSelect(target)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors cursor-pointer
              ${index === activeIndex ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`}
          >
            {target.id === 'all'
              ? <UsersRound size={14} className="shrink-0 text-primary" />
              : <AtSign size={14} className="shrink-0 text-muted-foreground" />}
            <span className="min-w-0 flex-1 truncate">{target.username}</span>
            {target.id !== 'all' && (
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full
                ${target.is_online ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
