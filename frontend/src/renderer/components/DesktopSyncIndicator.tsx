import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { useDesktopSyncStore } from '../store/desktopSyncStore'
import { desktopLoginApi } from '../services/api'
import { useDesktopStatusLabel } from './desktopStatusLabel'

/**
 * 桌面端共享模式同步的驱动器。
 *
 * 同步状态不再用顶部悬浮胶囊展示（原「已同步 11:28」），改为：
 * - 侧栏应用名旁的常驻标注（MainLayout 读同一份 store）
 * - 桌面窗口标题栏（本组件推送到本机后端 → launcher 的 window.set_title）
 *
 * 另外负责：跨档切换前冻结的旧改动确认条（避免静默覆盖同组数据）。
 * 网页端（非桌面形态）什么都不做。
 */
export function DesktopSyncIndicator() {
  const desktopMode = useAuthStore((s) => s.desktopMode)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const desktopRunMode = useAuthStore((s) => s.desktopRunMode)
  const startPolling = useDesktopSyncStore((s) => s.startPolling)
  const stopPolling = useDesktopSyncStore((s) => s.stopPolling)
  const frozen = useDesktopSyncStore((s) => s.status?.frozen_local_changes)
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState('')

  const label = useDesktopStatusLabel()
  const lastTitleRef = useRef<string | null>(null)

  const shared = desktopMode && desktopRunMode === 'shared'

  useEffect(() => {
    if (!isAuthenticated || !shared) {
      stopPolling()
      return
    }
    startPolling()
    return () => stopPolling()
  }, [isAuthenticated, shared, startPolling, stopPolling])

  useEffect(() => {
    if (!desktopMode || !label) return
    // 只在文案真正变化时调用，避免每 5s 轮询都打一次本机接口
    if (lastTitleRef.current === label.title) return
    lastTitleRef.current = label.title
    // 网页端标签页标题同步；桌面壳再额外写到窗口标题栏（非桌面壳返回 403，忽略）
    document.title = label.title
    void desktopLoginApi.setWindowTitle(label.title).catch(() => { /* 非桌面壳：忽略 */ })
  }, [desktopMode, label])

  const confirmFrozen = async (action: 'discard' | 'restore') => {
    setResolving(true)
    setResolveError('')
    try {
      await desktopLoginApi.resolveFrozenChanges(action)
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : '处理失败，请稍后重试')
    } finally {
      setResolving(false)
    }
  }

  if (!desktopMode || !shared || !frozen) return null

  return (
    <div className="fixed bottom-4 right-4 z-[9000] w-[min(420px,92vw)] rounded-xl border border-amber-500/40 bg-card p-3 shadow-xl">
      <p className="text-xs font-medium text-amber-500">切换模式前的未同步改动已暂停</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        为避免覆盖同组其他用户的数据，冻结于 {frozen.frozen_at} 的本地改动暂不上行。
        确认「恢复」将重新排队上传；「丢弃」仅影响这些旧改动，当前数据不受影响。
      </p>
      {resolveError && <p className="mt-1 text-[11px] text-destructive">{resolveError}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" disabled={resolving}
                onClick={() => void confirmFrozen('discard')}
                className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50 cursor-pointer">
          丢弃
        </button>
        <button type="button" disabled={resolving}
                onClick={() => void confirmFrozen('restore')}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:brightness-110 disabled:opacity-50 cursor-pointer">
          恢复并上传
        </button>
      </div>
    </div>
  )
}
