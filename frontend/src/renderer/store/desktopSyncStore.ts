import { create } from 'zustand'
import { desktopCloudApi } from '../services/api'
import type { DesktopSyncStatus } from '../services/api'
import { useToastStore } from './toastStore'

/** 桌面端数据同步完成：页面据此刷新数据（事件名，供各业务页监听） */
export const DESKTOP_SYNCED_EVENT = 'desktop:synced'

interface DesktopSyncState {
  status: DesktopSyncStatus | null
  /** 轮询是否已启动（桌面端登录后启动一次） */
  polling: boolean
  startPolling: () => void
  stopPolling: () => void
}

let timer: number | null = null

export const useDesktopSyncStore = create<DesktopSyncState>((set, get) => ({
  status: null,
  polling: false,

  startPolling: () => {
    if (get().polling) return
    set({ polling: true })

    const tick = async () => {
      try {
        const res = await desktopCloudApi.getSyncStatus()
        if (!res.success) return
        const next = res.data
        const prev = get().status
        set({ status: next })

        // 新一次同步落地：提示结果并通知页面刷新（避免正在用的数据仍旧是旧版本）
        if (
          next?.last_sync_at &&
          prev?.last_sync_at &&
          next.last_sync_at !== prev.last_sync_at
        ) {
          const r = next.last_result || {}
          const moved = (r.pulled || 0) + (r.pushed || 0) + (r.deleted || 0)
          if (moved > 0) {
            useToastStore.getState().show(`数据已同步（${moved} 项）`)
            window.dispatchEvent(new CustomEvent(DESKTOP_SYNCED_EVENT, { detail: r }))
          }
        }
      } catch {
        // 非桌面端或本机后端不可用：静默
      }
    }

    void tick()
    timer = window.setInterval(tick, 5000)
  },

  stopPolling: () => {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
    set({ polling: false, status: null })
  },
}))
