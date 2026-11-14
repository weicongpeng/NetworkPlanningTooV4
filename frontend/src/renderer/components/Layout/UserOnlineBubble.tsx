import { useEffect, useState } from 'react'
import { LogIn } from 'lucide-react'
import { usePresenceStore } from '../../store/presenceStore'
import { useAuthStore } from '../../store/authStore'
import { USER_ONLINE_EVENT } from '../../services/websocketService'
import { playKnockSound } from '../../utils/knockSound'

/** 气泡停留时长（毫秒）：到点后开始渐变消失 */
const VISIBLE_MS = 5000
/** 渐变消失时长（毫秒） */
const FADE_MS = 500

type Phase = 'hidden' | 'shown' | 'leaving'

/**
 * 用户上线提醒气泡：贴在左侧边栏顶端「网优引擎」标题旁。
 *
 * 唯一触发来源：服务器 WebSocket 广播的 `user_online`（别人上线）。
 * 服务端会排除上线者自身的连接，因此「自身登录」不会弹气泡/不响敲门声；
 * 这里再按当前登录用户 id 做一次兜底过滤，防止旧服务端或重连时序导致自己收到。
 *
 * 出现时同时播放两声清脆的敲门声，5 秒后气泡渐变消失。
 */
export function UserOnlineBubble() {
  const notice = usePresenceStore((s) => s.notice)
  const clear = usePresenceStore((s) => s.clear)
  const [phase, setPhase] = useState<Phase>('hidden')

  // 服务器广播的「有人上线」
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      // 兜底：即便服务端版本较旧把事件推回本端，自己上线也不提示
      const myId = useAuthStore.getState().user?.id
      if (myId != null && detail.userId != null && Number(detail.userId) === Number(myId)) return
      const text = String(detail.text || detail.username || '')
      if (!text) return
      usePresenceStore.getState().show({
        eventId: String(detail.eventId || ''),
        text,
        userId: detail.userId,
        username: detail.username,
      })
    }
    window.addEventListener(USER_ONLINE_EVENT, handler)
    return () => window.removeEventListener(USER_ONLINE_EVENT, handler)
  }, [])

  // 提醒出现 → 敲门声 → 5 秒后渐变消失
  useEffect(() => {
    if (!notice) {
      setPhase('hidden')
      return
    }
    setPhase('shown')
    playKnockSound()

    const hideTimer = window.setTimeout(() => setPhase('leaving'), VISIBLE_MS)
    const clearTimer = window.setTimeout(() => clear(), VISIBLE_MS + FADE_MS)
    return () => {
      window.clearTimeout(hideTimer)
      window.clearTimeout(clearTimer)
    }
  }, [notice, clear])

  if (!notice) return null

  const visible = phase === 'shown'

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute left-full top-1/2 z-[3000] ml-2 -translate-y-1/2 select-none"
      style={{
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transform: `translateY(-50%) translateX(${visible ? 0 : -6}px)`,
        transition: `opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease`,
      }}
    >
      <div
        className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-primary/40 bg-card px-2.5 py-1 text-xs text-foreground shadow-lg"
        style={{
          transform: visible ? 'scale(1)' : 'scale(0.96)',
          transition: `transform ${FADE_MS}ms ease`,
        }}
      >
        <LogIn size={13} className="shrink-0 text-primary" />
        <span className="font-medium">{notice.text}</span>
      </div>
      {/* 指向标题的小箭头 */}
      <div
        className="absolute left-[-4px] top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 border-b border-l border-primary/40 bg-card"
        style={{ opacity: visible ? 1 : 0, transition: `opacity ${FADE_MS}ms ease` }}
      />
    </div>
  )
}
