import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../store/authStore'
import { useDesktopSyncStore } from '../store/desktopSyncStore'

/**
 * 桌面端「运行模式 + 实时同步状态」文案（窗口标题与侧栏应用名共用一份，避免两处漂移）。
 *
 * 网页端（非桌面形态）返回 null，调用方据此完全不展示。
 */

export type DesktopStatusTone = 'normal' | 'syncing' | 'warn'

export interface DesktopStatusLabel {
  /** 应用名（网优引擎 / NetOpt Engine） */
  appName: string
  /** 运行模式 + 同步状态，如「共享模式 · 已同步 11:28」 */
  label: string
  tone: DesktopStatusTone
  /** 窗口标题：应用名 - 状态 */
  title: string
}

export function useDesktopStatusLabel(): DesktopStatusLabel | null {
  const { t } = useTranslation()
  const desktopMode = useAuthStore((s) => s.desktopMode)
  const desktopRunMode = useAuthStore((s) => s.desktopRunMode)
  const status = useDesktopSyncStore((s) => s.status)

  if (!desktopMode) return null

  const appName = t('common.appName', '网优引擎')
  const shared = desktopRunMode === 'shared'

  let label: string
  let tone: DesktopStatusTone = 'normal'

  if (!shared) {
    // 单机模式：数据本机私有、不参与同步，因此没有同步状态可报
    label = desktopRunMode === 'standalone'
      ? t('desktopSync.modeStandalone', '单机模式')
      : t('desktopSync.modeOffline', '离线模式')
  } else if (!status) {
    label = t('desktopSync.modeShared', '共享模式')
  } else if (status.syncing) {
    label = t('desktopSync.modeSharedSyncing', '共享模式 · 同步中…')
    tone = 'syncing'
  } else if ((status.conflicts?.length || 0) > 0) {
    label = t('desktopSync.modeSharedConflicts', '共享模式 · {{count}} 项冲突', {
      count: status.conflicts.length,
    })
    tone = 'warn'
  } else if (status.last_error) {
    label = t('desktopSync.modeSharedError', '共享模式 · 同步异常')
    tone = 'warn'
  } else if (status.last_sync_at) {
    label = t('desktopSync.modeSharedSynced', '共享模式 · 已同步 {{time}}', {
      time: status.last_sync_at.slice(11, 16),
    })
  } else {
    label = t('desktopSync.modeSharedWaiting', '共享模式 · 等待同步')
  }

  return { appName, label, tone, title: `${appName} - ${label}` }
}
