import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, ShieldCheck } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { desktopLoginApi } from '../services/api'

const POLL_INTERVAL_MS = 5000

/**
 * 单机模式「申请授权」等待弹窗。
 *
 * 单机模式登录后若该账号在本机尚无授权，服务器会建一条待批准申请；
 * 这里持续轮询，管理员在网页端「桌面授权」页确认后自动完成登录。
 */
export function DesktopAuthPendingDialog() {
  const { t } = useTranslation()
  const pendingUsername = useAuthStore((s) => s.desktopPendingUsername)
  const applyDesktopLogin = useAuthStore((s) => s.applyDesktopLogin)
  const setDesktopPendingUsername = useAuthStore((s) => s.setDesktopPendingUsername)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!pendingUsername) return
    let cancelled = false

    const poll = async () => {
      try {
        const res: any = await desktopLoginApi.poll(pendingUsername)
        const data = res?.data
        if (cancelled) return
        // 本机 auth-poll 与 /desktop/login 同形状返回 result=ok + access_token；
        // 兼容只有 token 字段的旧版本本机后端
        const token = data?.access_token || data?.token
        if (data?.result === 'ok' && token && data?.user) {
          applyDesktopLogin({ ...data, access_token: token })
          return
        }
        if (data?.status === 'rejected' || data?.status === 'disabled') {
          setError(data?.message || t('desktopAuth.rejected', '授权申请未通过，请联系管理员'))
        }
      } catch {
        // 网络抖动：下个周期重试
      }
    }

    poll()
    const timer = window.setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [pendingUsername, applyDesktopLogin, t])

  if (!pendingUsername) return null

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl shadow-2xl p-6 w-[26rem] space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={20} className="text-primary" />
          <h2 className="text-base font-semibold">{t('desktopAuth.title', '申请授权')}</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('desktopAuth.pendingHint', '已提交单机模式授权申请，请等待管理员在「桌面授权」页面确认。')}
        </p>
        <div className="text-xs text-muted-foreground">
          {t('auth.username', '用户名')}：{pendingUsername}
        </div>
        {error ? (
          <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-xs text-red-500">
            {error}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-blue-500">
            <Loader2 size={14} className="animate-spin" />
            {t('desktopAuth.waiting', '等待管理员确认…')}
          </div>
        )}
        <button
          onClick={() => setDesktopPendingUsername(null)}
          className="w-full px-4 py-2 border border-border rounded-lg hover:bg-muted text-sm font-medium"
        >
          {t('desktopAuth.cancel', '取消')}
        </button>
      </div>
    </div>
  )
}
