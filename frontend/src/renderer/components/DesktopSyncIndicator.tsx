import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Cloud, CloudOff, Loader2 } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { useDesktopSyncStore } from '../store/desktopSyncStore'

/** 桌面端共享模式同步指示器：同步中动画 / 上次同步时间 / 冲突角标。 */
export function DesktopSyncIndicator() {
  const { t } = useTranslation()
  const desktopMode = useAuthStore((s) => s.desktopMode)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const desktopRunMode = useAuthStore((s) => s.desktopRunMode)
  const status = useDesktopSyncStore((s) => s.status)
  const startPolling = useDesktopSyncStore((s) => s.startPolling)
  const stopPolling = useDesktopSyncStore((s) => s.stopPolling)

  const shared = desktopMode && desktopRunMode === 'shared'

  useEffect(() => {
    if (!isAuthenticated || !shared) {
      stopPolling()
      return
    }
    startPolling()
    return () => stopPolling()
  }, [isAuthenticated, shared, startPolling, stopPolling])

  if (!shared || !status) return null

  const conflicts = status.conflicts?.length || 0
  const syncing = status.syncing

  return (
    <div
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[1200] flex items-center gap-2 px-3 py-1.5 rounded-full border border-border bg-card/95 shadow-md text-xs"
      title={
        status.last_error
          ? status.last_error
          : `${t('desktopSync.server', '服务器')}: ${status.server_url || '-'}`
      }
    >
      {syncing ? (
        <>
          <Loader2 size={13} className="animate-spin text-primary" />
          <span className="text-primary">{t('desktopSync.syncing', '数据同步中…')}</span>
        </>
      ) : conflicts > 0 ? (
        <>
          <AlertTriangle size={13} className="text-amber-500" />
          <span className="text-amber-500">
            {t('desktopSync.conflicts', '{{count}} 项数据冲突，请联系管理员处理', { count: conflicts })}
          </span>
        </>
      ) : status.run_mode === 'shared' ? (
        <>
          <Cloud size={13} className="text-muted-foreground" />
          <span className="text-muted-foreground">
            {status.last_sync_at
              ? t('desktopSync.syncedAt', '已同步 {{time}}', {
                  time: status.last_sync_at.slice(11, 16),
                })
              : t('desktopSync.waiting', '等待同步')}
          </span>
        </>
      ) : (
        <>
          <CloudOff size={13} className="text-muted-foreground" />
          <span className="text-muted-foreground">{t('desktopSync.offline', '离线模式')}</span>
        </>
      )}
      {status.pending_uploads > 0 && (
        <span className="px-1.5 rounded-full bg-primary/10 text-primary">
          {t('desktopSync.pending', '待上传 {{count}}', { count: status.pending_uploads })}
        </span>
      )}
    </div>
  )
}
