/**
 * 「更新已就绪，重启后完成更新」提示条（挂在「系统设置 → 版本」栏内，桌面端专用）。
 *
 * 背景：OTA 安装包下载完成后（后端 `phase === 'ready'`）此前只有那个可以随时关掉的更新弹窗
 * 提供入口；用户关掉弹窗 / 走的是「后台运行」下载时，就没有地方"重启完成更新"了。
 * 现在只要系统设置页在开着，就由本提示条给出确定入口：
 * - 文案：「更新已就绪，重启后完成更新」（附目标版本号）
 * - 「立即重启」：调用同一个后端动作 POST /desktop/update/install —— 先拉起升级脚本
 *   （等待本进程退出 → 静默安装 → 自动重启新版本），再请求应用退出。
 *
 * 为什么要自己轮询：下载可能是在更新弹窗里、也可能是在「后台运行」里完成的，
 * 系统设置页必须自己感知"下载已完成"，否则用户看不到重启入口。轮询打的是本机
 * 127.0.0.1 的轻量 GET（不带任何远端检查），4 秒一次可以忽略不计。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DownloadCloud, Loader2, RefreshCw } from 'lucide-react'
import { desktopUpdateApi } from '../services/api'

/** 轮询间隔（毫秒） */
const POLL_MS = 4000

export function DesktopUpdateReadyBanner() {
  const { t } = useTranslation()
  /** 非空 = 安装包已下载完成（version 为目标版本号，可能取不到） */
  const [ready, setReady] = useState<{ version: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const sync = async () => {
      try {
        const res: any = await desktopUpdateApi.progress()
        if (cancelled) return
        const data = res?.data
        if (data?.phase === 'ready') {
          // 保持对象引用稳定，避免每次轮询都重渲染（版本号取不到时也不闪烁）
          setReady((prev) => prev ?? { version: data?.version ? String(data.version) : null })
        } else {
          setReady(null)
        }
      } catch {
        // 网页端没有这些接口、或本机后端不可用：静默（提示条不出现即可）
      }
    }
    void sync()
    const timer = window.setInterval(() => void sync(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  if (!ready) return null

  const handleRestart = async () => {
    setBusy(true)
    // 安装随即会关闭本程序、连接随之断开，先给出提示避免用户以为无响应
    setMessage(t('desktopUpdate.installing'))
    try {
      const res: any = await desktopUpdateApi.install()
      setMessage(res?.data?.message || t('desktopUpdate.installing'))
    } catch (err: any) {
      // code === 0 表示连接被切断（应用正在退出安装），不是失败（与更新弹窗同口径）
      if (err?.code !== 0) {
        setMessage(err?.message || t('desktopUpdate.installFailed'))
        setBusy(false)
      }
    }
  }

  return (
    <div className="mt-4 p-3 rounded-lg bg-primary/10 border border-primary/25">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <DownloadCloud size={16} className="text-primary shrink-0" />
        <span className="text-sm font-medium text-primary">
          {t('desktopUpdate.updateReady')}
        </span>
        {ready.version && (
          <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {ready.version}
          </span>
        )}
        <button
          onClick={handleRestart}
          disabled={busy}
          className="ml-auto px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium flex items-center gap-1.5"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {t('desktopUpdate.restartNow')}
        </button>
      </div>
      {message && <p className="mt-2 text-xs text-muted-foreground">{message}</p>}
    </div>
  )
}
