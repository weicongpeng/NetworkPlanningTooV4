import { useEffect, useRef } from 'react'
import { useAuthStore } from '../store/authStore'
import { useDesktopSyncStore } from '../store/desktopSyncStore'
import { desktopLoginApi } from '../services/api'
import { useDesktopStatusLabel } from './desktopStatusLabel'

/**
 * 桌面端共享模式同步的「无渲染」驱动器。
 *
 * 同步状态不再用顶部悬浮胶囊展示（原「已同步 11:28」），改为：
 * - 侧栏应用名旁的常驻标注（MainLayout 读同一份 store）
 * - 桌面窗口标题栏（本组件推送到本机后端 → launcher 的 window.set_title）
 *
 * 这里只负责启停轮询、把标题同步到窗口，以及同步完成提示（逻辑在 desktopSyncStore 里）。
 * 网页端（非桌面形态）什么都不做。
 */
export function DesktopSyncIndicator() {
  const desktopMode = useAuthStore((s) => s.desktopMode)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const desktopRunMode = useAuthStore((s) => s.desktopRunMode)
  const startPolling = useDesktopSyncStore((s) => s.startPolling)
  const stopPolling = useDesktopSyncStore((s) => s.stopPolling)

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

  return null
}
