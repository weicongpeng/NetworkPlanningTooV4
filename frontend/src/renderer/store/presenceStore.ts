import { create } from 'zustand'

/**
 * 用户上线提醒（气泡 + 敲门声）
 *
 * 唯一数据来源：服务器 WebSocket 广播的 `user_online` 事件（别人上线）。
 * 服务端已排除上线者自身的所有连接，因此「自身登录」不会产生提醒。
 * eventId 用于去重，避免同一事件在重连/重复推送时弹两遍。
 */

export interface PresenceNotice {
  /** 本次上线的唯一标识（用于去重） */
  eventId: string
  /** 提示文案，如「河源_电信 admin」 */
  text: string
  /** 上线者用户 id */
  userId?: number
  /** 上线者用户名 */
  username?: string
}

interface PresenceState {
  /** 当前待展示的上线提醒（null = 无） */
  notice: PresenceNotice | null
  /** 展示一条提醒（同一 eventId 重复调用会被忽略） */
  show: (notice: PresenceNotice) => void
  /** 收起当前提醒 */
  clear: () => void
}

/** 已展示过的事件 id（保留最近若干条，避免无限增长） */
const seenEventIds: string[] = []
const SEEN_MAX = 64

function markSeen(eventId: string): boolean {
  if (!eventId) return false
  if (seenEventIds.includes(eventId)) return true
  seenEventIds.push(eventId)
  if (seenEventIds.length > SEEN_MAX) seenEventIds.shift()
  return false
}

export const usePresenceStore = create<PresenceState>((set) => ({
  notice: null,

  show: (notice) => {
    if (!notice) return
    if (markSeen(notice.eventId)) return
    set({ notice })
  },

  clear: () => set({ notice: null }),
}))
