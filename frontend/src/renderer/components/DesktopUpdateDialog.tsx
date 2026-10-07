import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Download, Loader2, RefreshCw, X } from 'lucide-react'
import type { DesktopUpdateStatus } from '@shared/types'
import { desktopUpdateApi } from '../services/api'
import { useAuthStore } from '../store/authStore'

/**
 * 桌面版 OTA 更新提示（仅桌面壳内生效；网页端接口 404 时静默）。
 * 规则：mandatory 或"稍后"超过服务端上限后不可再稍后（强制更新）。
 */
export function DesktopUpdateDialog() {
  const { t } = useTranslation()
  const { user } = useAuthStore()
  const isAdmin = user?.is_admin ?? false
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null)
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ downloaded: number; total: number; phase: string; error?: string | null }>({
    downloaded: 0,
    total: 0,
    phase: 'idle',
  })
  const [message, setMessage] = useState<string | null>(null)

  const release = status?.release || null
  const force = Boolean(release?.mandatory) || Boolean(release?.snooze?.force)

  const check = useCallback(async () => {
    try {
      const res = await desktopUpdateApi.status()
      if (!res.success) return
      setStatus(res.data)
      setProgress({
        downloaded: res.data.download?.downloaded || 0,
        total: res.data.download?.total || 0,
        phase: res.data.download?.phase || 'idle',
        error: res.data.download?.error,
      })
      if (res.data.update_available && res.data.release) {
        setVisible(true)
      } else if (res.data.download?.phase === 'ready') {
        setVisible(true)
      }
    } catch {
      // 网页版或后端不可用
    }
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    const timer = window.setTimeout(check, 8000) // 启动后延迟检查，避免与首屏争资源
    return () => window.clearTimeout(timer)
  }, [check, isAdmin])

  // 下载中每 1 秒轮询进度
  useEffect(() => {
    if (!visible || progress.phase !== 'downloading') return
    const timer = window.setInterval(async () => {
      try {
        const res: any = await desktopUpdateApi.progress()
        setProgress({
          downloaded: res.data?.downloaded || 0,
          total: res.data?.total || 0,
          phase: res.data?.phase || 'idle',
          error: res.data?.error,
        })
        if (res.data?.phase === 'ready') {
          setMessage(t('desktopUpdate.downloadReady'))
        } else if (res.data?.phase === 'failed') {
          setMessage(res.data?.error || t('desktopUpdate.downloadFailed'))
        }
      } catch {
        /* 下个周期重试 */
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [visible, progress.phase, t])

  const handleDownload = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await desktopUpdateApi.download(release?.version)
      setProgress((prev) => ({ ...prev, phase: 'downloading' }))
    } catch (err: any) {
      setMessage(err?.message || t('desktopUpdate.downloadFailed'))
    } finally {
      setBusy(false)
    }
  }

  const handleInstall = async () => {
    setBusy(true)
    // 安装随即会关闭本程序、连接随之断开，先给出提示避免用户以为无响应
    setMessage(t('desktopUpdate.installing'))
    try {
      const res: any = await desktopUpdateApi.install()
      setMessage(res?.data?.message || t('desktopUpdate.installing'))
    } catch (err: any) {
      // code === 0 表示连接被切断（应用正在退出安装），不是失败
      if (err?.code !== 0) {
        setMessage(err?.message || t('desktopUpdate.installFailed'))
        setBusy(false)
      }
    }
  }

  const handleSnooze = async () => {
    if (!release) return
    try {
      const res: any = await desktopUpdateApi.snooze(String(release.version))
      if (res?.data?.force) {
        setStatus((prev) =>
          prev && prev.release ? { ...prev, release: { ...prev.release, snooze: res.data } } : prev,
        )
        setMessage(t('desktopUpdate.forceNotice'))
        return
      }
    } catch {
      /* 记录失败也允许关闭 */
    }
    setVisible(false)
  }

  if (!isAdmin) return null
  if (!visible || (!release && progress.phase !== 'ready')) return null

  const percent =
    progress.total > 0 ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : 0

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4">
      <div className="bg-card rounded-lg border border-border p-5 w-full max-w-lg space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Download size={18} className="text-primary" />
            <h3 className="text-sm font-semibold">{t('desktopUpdate.title')}</h3>
          </div>
          {!force && progress.phase !== 'ready' && (
            <button onClick={handleSnooze} className="p-1 hover:bg-muted rounded" title={t('desktopUpdate.later')}>
              <X size={16} />
            </button>
          )}
        </div>

        {release && (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono px-1.5 py-0.5 rounded bg-muted">{release.version}</span>
              {release.file_size_display && (
                <span className="text-muted-foreground">{release.file_size_display}</span>
              )}
              {release.mandatory && (
                <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 text-xs">
                  {t('desktopUpdate.mandatoryBadge')}
                </span>
              )}
              {release.snooze && !release.mandatory && (
                <span className="text-xs text-muted-foreground">
                  {t('desktopUpdate.snoozeLeft', {
                    left: Math.max(0, release.snooze.max - release.snooze.count),
                  })}
                </span>
              )}
            </div>
            {release.release_notes && (
              <p className="text-xs text-muted-foreground whitespace-pre-wrap max-h-40 overflow-auto">
                {release.release_notes}
              </p>
            )}
          </div>
        )}

        {progress.phase === 'downloading' && (
          <div className="space-y-1">
            <div className="h-2 rounded bg-muted overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('desktopUpdate.downloading')} {percent}%
              {progress.total > 0 && `（${(progress.downloaded / 1048576).toFixed(1)} / ${(progress.total / 1048576).toFixed(1)} MB）`}
            </p>
          </div>
        )}

        {message && (
          <div className="p-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-600 text-xs flex items-center gap-2">
            <AlertCircle size={14} />
            {message}
          </div>
        )}

        {force && (
          <p className="text-xs text-red-500">{t('desktopUpdate.forceHint')}</p>
        )}

        <div className="flex justify-end gap-2">
          {!force && progress.phase !== 'ready' && (
            <button
              onClick={handleSnooze}
              className="px-4 py-2 border border-border rounded-lg hover:bg-muted text-sm"
            >
              {t('desktopUpdate.later')}
            </button>
          )}
          {progress.phase === 'ready' ? (
            <button
              onClick={handleInstall}
              disabled={busy}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium flex items-center gap-1.5"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {t('desktopUpdate.restartAndInstall')}
            </button>
          ) : (
            <button
              onClick={handleDownload}
              disabled={busy || progress.phase === 'downloading'}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium flex items-center gap-1.5"
            >
              {busy || progress.phase === 'downloading' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              {progress.phase === 'downloading' ? t('desktopUpdate.downloading') : t('desktopUpdate.updateNow')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
