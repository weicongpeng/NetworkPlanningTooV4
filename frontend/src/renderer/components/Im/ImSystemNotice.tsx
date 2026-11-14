/** 群内系统提示：把服务端结构化 payload 渲染成一行居中的友好文案（文案一律 t()）。 */
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'

import { parseSystemMessage } from './types'
import type { ImSystemPayload } from './types'

type Tr = (key: string, options?: Record<string, unknown>) => string

/** 把结构化事件翻成当前语言的友好文案；未知事件退回通用提示。 */
export function systemNoticeText(payload: ImSystemPayload, t: Tr): string {
  const names = (payload.names || []).join(t('im.system.nameSeparator', { defaultValue: '、' }))
  switch (payload.event) {
    case 'members_added':
      return t('im.system.membersAdded', {
        defaultValue: '{{actor}} 邀请 {{names}} 加入了群聊', actor: payload.actor || '', names,
      })
    case 'member_removed':
      return t('im.system.memberRemoved', {
        defaultValue: '{{actor}} 将 {{names}} 移出了群聊', actor: payload.actor || '', names,
      })
    case 'member_left':
      return t('im.system.memberLeft', {
        defaultValue: '{{actor}} 退出了群聊', actor: payload.actor || '',
      })
    default:
      return t('im.system.defaultNotice', { defaultValue: '群内通知' })
  }
}

export function ImSystemNotice({ contentText }: { contentText: string | null }) {
  const { t } = useTranslation()
  const payload = parseSystemMessage(contentText)
  if (!payload) return null
  // 包一层简单签名，避免 i18next TFunction 的重载签名与纯函数类型不兼容
  const tr: Tr = (key, options) => String(t(key, options as never))
  return (
    <div className="flex justify-center py-0.5">
      <span className="inline-flex max-w-[90%] items-center gap-1.5 rounded-full bg-muted/60 px-3 py-1 text-center text-[11px] leading-relaxed text-muted-foreground">
        <Info size={12} className="shrink-0" />
        {systemNoticeText(payload, tr)}
      </span>
    </div>
  )
}
