import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Loader2, KeyRound } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { desktopLoginApi } from '../services/api'

interface ChangePasswordDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * 用户自助修改密码：校验旧密码 → 设置新密码 → 成功后退出登录回到登录页，
 * 让用户用新密码重新登录（后端 /auth/change-password 同时清除 must_change_password）。
 */
export function ChangePasswordDialog({ open, onClose }: ChangePasswordDialogProps) {
  const { t } = useTranslation()
  const { changePassword, logout } = useAuthStore()
  const desktopMode = useAuthStore((s) => s.desktopMode)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (!open) return null

  const handleClose = () => {
    if (submitting) return
    setOldPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setError('')
    onClose()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!oldPassword) { setError(t('auth.oldPasswordRequired', '请输入旧密码')); return }
    if (newPassword.length < 6) { setError(t('auth.passwordTooShort', '密码长度至少6位')); return }
    if (newPassword !== confirmPassword) { setError(t('auth.passwordMismatch', '两次输入的密码不一致')); return }
    setSubmitting(true)
    try {
      await changePassword(oldPassword, newPassword, confirmPassword)
      // 桌面端清掉「记住的账号密码」里已失效的旧密码，避免下次自动登录拿旧密码重试
      if (desktopMode) {
        await desktopLoginApi.deleteLastLogin().catch(() => { /* 清除失败不阻断跳转 */ })
      }
      // 修改成功后立即退出登录：AuthGuard 会切换到登录页，用户用新密码登录
      await logout()
    } catch (err: any) {
      setError(err?.message || err?.detail || String(err))
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[7000] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl p-6 w-96"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-primary/10 rounded-lg">
              <KeyRound size={18} className="text-primary" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">{t('auth.changePassword', '修改密码')}</h3>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <p className="mb-4 text-xs text-muted-foreground">
          {t('auth.changePasswordHint', '修改成功后将退出登录，请用新密码重新登录。')}
        </p>

        {error && (
          <div className="mb-4 p-2 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('auth.oldPassword', '旧密码')}</label>
            <input
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              autoFocus
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('auth.newPassword', '新密码')}</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('auth.confirmNewPassword', '确认新密码')}</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 py-2 border border-border rounded-lg text-sm text-muted-foreground hover:bg-muted transition-colors"
            >
              {t('common.cancel', '取消')}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 size={16} className="animate-spin" />}
              {t('auth.changePassword', '修改密码')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
