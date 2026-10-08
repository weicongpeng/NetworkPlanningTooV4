import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Download, Loader2, RefreshCw, X } from 'lucide-react'
import type { DesktopUpdateStatus } from '@shared/types'
import { desktopUpdateApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { useDesktopUpdateStore } from '../store/desktopUpdateStore'

/** 自动提醒间隔：1 天 2 次 */
const PROMPT_INTERVAL_MS = 12 * 60 * 60 * 1000
/** 同一版本的"上次提醒时间"，避免重启应用后重复弹窗 */
const PROMPT_STORAGE_KEY = 'npt-ota-last-prompt'
/** 启动后延迟检查，避免与首屏争资源 */
const FIRST_CHECK_DELAY_MS = 8000

function readLastPrompt(): { version: string; at: number } | null {
  try {
    const raw = localStorage.getItem(PROMPT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return typeof parsed?.at === 'number' ? { version: String(parsed.version || ''), at: parsed.at } : null
  } catch {
    return null
  }
}

/**
 * 桌面版 OTA 更新提示（仅桌面壳内生效；网页端接口 404 时静默）。
 * 规则：不强制更新，弹窗随时可关闭；自动检查每 12 小时一次（1 天 2 次）。
 */
export function DesktopUpdateDialog() {
  const { t } = useTranslation()
  // 更新接口只存在于桌面形态，网页端不必轮询
  const desktopMode = useAuthStore((s) => s.desktopMode)
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null)
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ downloaded: number; total: number; phase: string; error?: string | null }>({
    downloaded: 0,
    total: 0,
    phase: 'idle',
  })
  const [message, setMessage] = useState<string | null>(null)
  // 「系统设置 → 检查更新」的交接：拿到结果直接展示（非管理员也可手动触发）
  const requested = useDesktopUpdateStore((s) => s.requested)
  const clearRequest = useDesktopUpdateStore((s) => s.clearRequest)

  const release = status?.release || null

  // force=false：自动检查不打断用户；手动点「检查更新」时立即展示
  const check = useCallback(async (force = false) => {
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
      if (res.data.download?.phase === 'ready') {
        setVisible(true)
        return
      }
      if (!res.data.update_available || !res.data.release) return
      const version = String(res.data.release.version)
      const last = readLastPrompt()
      const due =
        force ||
        !last ||
        last.version !== version ||
        Date.now() - last.at >= PROMPT_INTERVAL_MS
      if (!due) return
      try {
        localStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify({ version, at: Date.now() }))
      } catch {
        /* 隐私模式下写不进去也不影响本次提醒 */
      }
      setVisible(true)
    } catch {
      // 网页版或后端不可用
    }
  }, [])

  useEffect(() => {
    if (!desktopMode) return
    const timer = window.setTimeout(() => check(false), FIRST_CHECK_DELAY_MS)
    const interval = window.setInterval(() => check(false), PROMPT_INTERVAL_MS)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [check, desktopMode])

  // 系统设置页点「检查更新」→ 打开本弹窗展示新版本
  useEffect(() => {
    if (!requested) return
    setStatus(requested)
    setProgress({
      downloaded: requested.download?.downloaded || 0,
      total: requested.download?.total || 0,
      phase: requested.download?.phase || 'idle',
      error: requested.download?.error,
    })
    setMessage(null)
    setVisible(Boolean(requested.update_available && requested.release))
    clearRequest()
  }, [requested, clearRequest])

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

  const handleClose = () => {
    setVisible(false)
    setMessage(null)
  }

  // 可见性由自动检查或「系统设置 → 检查更新」决定
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
          <button onClick={handleClose} className="p-1 hover:bg-muted rounded" title={t('desktopUpdate.close')}>
            <X size={16} />
          </button>
        </div>

        {release && (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono px-1.5 py-0.5 rounded bg-muted">{release.version}</span>
              {release.file_size_display && (
                <span className="text-muted-foreground">{release.file_size_display}</span>
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

        <div className="flex justify-end gap-2">
          <button
            onClick={handleClose}
            className="px-4 py-2 border border-border rounded-lg hover:bg-muted text-sm"
          >
            {t('desktopUpdate.close')}
          </button>
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
