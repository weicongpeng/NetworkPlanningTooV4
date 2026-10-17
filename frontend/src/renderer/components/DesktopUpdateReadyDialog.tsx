/**
 * 安装包下载完成后的「重启更新」提示弹窗。
 *
 * 场景：发现新版本后客户端**静默预下载**安装包（用户点「立即更新」/「后台运行」的
 * 下载同样适用）。下载完成后**必须再给用户一个明确入口**：静默下载不打扰用户，
 * 若没有这个弹窗，用户只有打开「系统设置 → 版本」才能看到"可以重启更新了"。
 *
 * 触发条件（后端 `/desktop/update/progress` 的 state）：
 * - `phase === 'ready'`：安装包已下载完成（前台/后台/静默下载都提示）
 * - 主更新弹窗可见时避让：由主弹窗自己的「重启并安装」按钮接手，不叠两个对话框
 *
 * 「稍后更新」按版本记忆，不反复打扰；「重启更新」与更新弹窗的「重启并安装」是同一个
 * 后端动作（拉起升级脚本 → 等本进程退出 → 静默安装 → 自动重启新版本）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react'
import { desktopUpdateApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { useDesktopUpdateStore } from '../store/desktopUpdateStore'

/** 轮询间隔：后台下载完成要及时提示，但也不必太密 */
const POLL_INTERVAL_MS = 3000
/** 「稍后更新」的记忆 key（按版本，避免每次打开软件都重弹） */
const DISMISS_KEY = 'npt-ota-ready-dismissed'

interface ReadyProgress {
  phase: string
  background: boolean
  version: string | null
}

function readDismissed(): { version: string; at: number } | null {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return typeof parsed?.at === 'number' ? { version: String(parsed.version || ''), at: parsed.at } : null
  } catch {
    return null
  }
}

export function DesktopUpdateReadyDialog() {
  const { t } = useTranslation()
  const desktopMode = useAuthStore((s) => s.desktopMode)
  // 主更新弹窗开着就由它自己提示「重启并安装」，这里不叠第二个对话框
  const mainVisible = useDesktopUpdateStore((s) => s.mainDialogVisible)
  const [ready, setReady] = useState<ReadyProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /** 已提示过的版本（同一次运行里不重复弹） */
  const promptedRef = useRef<string | null>(null)

  const poll = useCallback(async () => {
    try {
      const res: any = await desktopUpdateApi.progress()
      const data = res?.data || {}
      const phase = String(data.phase || 'idle')
      // 安装包已就绪就提示（静默/前台/后台下载都算）：主更新弹窗可见时不轮询、
      // 渲染时也让位，由主弹窗的「重启并安装」接手
      if (phase === 'ready') {
        const version = String(data.version || '')
        const dismissed = readDismissed()
        if (dismissed && dismissed.version === version) return
        if (promptedRef.current === version) return
        promptedRef.current = version
        setReady({ phase, background: Boolean(data.background), version })
      } else if (phase === 'failed') {
        // 下载失败：交给自动检查下次提醒，这里不占着屏幕
        setReady(null)
      }
    } catch {
      /* 网页版或后端不可用：下个周期重试 */
    }
  }, [])

  useEffect(() => {
    if (!desktopMode || mainVisible) return
    const timer = window.setInterval(poll, POLL_INTERVAL_MS)
    // 首轮立即跑一次：软件启动时下载可能已经完成（重启过软件）
    void poll()
    return () => window.clearInterval(timer)
  }, [desktopMode, mainVisible, poll])

  // 主弹窗打开后让位：安装入口由主弹窗接手
  if (!ready || mainVisible) return null
  const handleInstall = async () => {
    setBusy(true)
    setMessage(t('desktopUpdate.installing'))
    try {
      const res: any = await desktopUpdateApi.install()
      setMessage(res?.data?.message || t('desktopUpdate.installing'))
    } catch (err: any) {
      // code === 0：连接被切断 = 应用正在退出安装，不是失败
      if (err?.code !== 0) {
        setMessage(err?.message || t('desktopUpdate.installFailed'))
        setBusy(false)
      }
    }
  }

  const handleLater = () => {
    const version = ready?.version || ''
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify({ version, at: Date.now() }))
    } catch {
      /* 隐私模式写不进去也不影响本次忽略 */
    }
    setReady(null)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[110] p-4">
      <div className="bg-card rounded-lg border border-border p-5 w-full max-w-md space-y-4">
        <div className="flex items-center gap-2">
          <RefreshCw size={18} className="text-primary" />
          <h3 className="text-sm font-semibold">{t('desktopUpdate.downloadDoneTitle')}</h3>
        </div>

        <div className="space-y-1 text-sm">
          <p>{t('desktopUpdate.updateReady')}</p>
          {ready.version && (
            <p className="text-xs text-muted-foreground">
              {t('desktopUpdate.targetVersion')}
              <span className="font-mono ml-1">{ready.version}</span>
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t('desktopUpdate.mimeHint')}</p>
        </div>

        {message && (
          <div className="p-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-600 text-xs flex items-center gap-2">
            <AlertCircle size={14} />
            {message}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={handleLater}
            disabled={busy}
            className="px-4 py-2 border border-border rounded-lg hover:bg-muted disabled:opacity-50 text-sm"
          >
            {t('desktopUpdate.updateLater')}
          </button>
          <button
            onClick={handleInstall}
            disabled={busy}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium flex items-center gap-1.5"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {t('desktopUpdate.restartUpdate')}
          </button>
        </div>
      </div>
    </div>
  )
}
