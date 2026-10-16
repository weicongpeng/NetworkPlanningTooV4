import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { X, LogIn, UserPlus, Loader2 } from 'lucide-react'
import { authApi, desktopLoginApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { getLastRoute } from '../utils/lastRoute'
import type { RegisterOptions } from '@shared/types'

interface LoginModalProps {
  isOpen: boolean
  forceChangePassword?: boolean
  onClose?: () => void
}

// 运营商兜底清单：注册选项接口不可用时仍可注册
const FALLBACK_OPERATORS = ['移动', '联通', '电信', '广电']

export function LoginModal({ isOpen, forceChangePassword = false, onClose }: LoginModalProps) {
  const { t } = useTranslation()
  const { login, register, changePassword } = useAuthStore()
  const desktopMode = useAuthStore((s) => s.desktopMode)
  // 桌面端记住上次登录的账号与运行模式（切换模式需退出后重新登录）
  const lastDesktopLogin = useAuthStore((s) => s.lastDesktopLogin)
  // 用户主动退出登录后本次不再自动登录，等用户手动点「登录」
  const autoLoginSuppressed = useAuthStore((s) => s.desktopAutoLoginSuppressed)
  // 运行模式数据空间切换中（后端已记账，等待应用重启进入目标档）
  const switchPending = useAuthStore((s) => s.desktopSwitchPending)
  const [switchRestartFailed, setSwitchRestartFailed] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  const [mode, setMode] = useState<'login' | 'register'>('login')
  // 桌面端运行模式：共享模式（与网页端一致）/ 单机模式（需管理员单独授权）
  const [desktopRunMode, setDesktopRunMode] = useState<'shared' | 'standalone'>(
    desktopMode && lastDesktopLogin ? lastDesktopLogin.mode : 'shared'
  )
  const [username, setUsername] = useState(
    desktopMode && lastDesktopLogin ? lastDesktopLogin.username : ''
  )
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  // 记住账号密码：勾选后本机加密保存，下次打开登录页自动登录（默认勾选）
  const [remember, setRemember] = useState<boolean>(() => {
    try { return localStorage.getItem('npt-desktop-remember') !== '0' } catch { return true }
  })
  // 自动登录每次打开只尝试一次，失败回退到表单
  const autoLoginAttemptedRef = useRef(false)
  const [city, setCity] = useState('')
  const [operator, setOperator] = useState('')
  const [oldPassword, setOldPassword] = useState('')
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [options, setOptions] = useState<RegisterOptions | null>(null)
  const [optionsError, setOptionsError] = useState(false)

  // 注册选项：桌面端取服务器（经本机后端代理）的预设，网页端直接取本机接口
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    const loader = desktopMode ? desktopLoginApi.options() : authApi.getOptions()
    loader
      .then((res: any) => {
        if (cancelled) return
        if (res.success && res.data) {
          setOptions(res.data)
        } else {
          setOptionsError(true)
        }
      })
      .catch(() => { if (!cancelled) setOptionsError(true) })
    return () => { cancelled = true }
  }, [isOpen, desktopMode])

  // 记住账号密码偏好持久化（默认勾选）
  useEffect(() => {
    try { localStorage.setItem('npt-desktop-remember', remember ? '1' : '0') } catch { /* 忽略 */ }
  }, [remember])

  // 桌面端登录提交（手动点击与自动登录共用）
  const doDesktopLogin = useCallback(
    async (u: string, p: string, runMode: 'shared' | 'standalone', rememberFlag: boolean) => {
      // 先取上次停留页面，登录成功后恢复（须在 login 之前取，避免被路由记录覆盖）
      const restoreTarget = getLastRoute(u)
      const warningMsg = await login(u, p, runMode, rememberFlag)
      if (restoreTarget && restoreTarget !== location.pathname) {
        navigate(restoreTarget, { replace: true })
      }
      // 单机模式离线登录（服务器探测不到）：提示用的是本机授权，联网后自动校验
      const offlineNow = Boolean(desktopMode && useAuthStore.getState().desktopOffline)
      const notice = offlineNow
        ? t('desktopAuth.offlineLogin', '当前无网络：已用本机授权登录，联网后将自动校验授权')
        : warningMsg
      if (notice) {
        setWarning(notice)
        // 短暂显示警告后自动关闭
        setTimeout(() => onClose?.(), offlineNow ? 3000 : 2000)
      } else {
        onClose?.()
      }
    },
    [login, location.pathname, navigate, t, desktopMode, onClose],
  )

  // 桌面端自动登录：跨模式重启的一次性凭据优先，其次「记住的账号密码」
  useEffect(() => {
    if (!isOpen || !desktopMode || mode !== 'login' || forceChangePassword) return
    let cancelled = false

    const attempt = async () => {
      // 1) 跨运行模式重启后保存的一次性登录/注册凭据（当前已是目标数据空间）
      let pending: any = null
      try {
        const res: any = await desktopLoginApi.getPendingLogin()
        pending = res?.data
      } catch {
        pending = null
      }
      if (cancelled) return
      if (pending) {
        const targetMode: 'shared' | 'standalone' =
          pending.mode === 'standalone' ? 'standalone' : 'shared'
        autoLoginAttemptedRef.current = true
        setDesktopRunMode(targetMode)
        setUsername(pending.username || '')
        setIsSubmitting(true)
        try {
          if (pending.kind === 'register') {
            await register(
              pending.username,
              pending.password,
              pending.confirm_password || pending.password,
              pending.city || '',
              pending.operator || '',
            )
            onClose?.()
          } else {
            await doDesktopLogin(
              pending.username, pending.password, targetMode, pending.remember !== false
            )
          }
        } catch (err: any) {
          setError(err?.message || err?.detail || String(err))
          setPassword('')
        } finally {
          if (!cancelled) setIsSubmitting(false)
        }
        return
      }

      // 2) 无切换凭据：读取记住的账号密码预填；勾选「记住」时自动登录一次
      try {
        const res: any = await desktopLoginApi.getLastLogin()
        if (cancelled) return
        const saved = res?.data
        if (!saved?.username) return
        const savedMode: 'shared' | 'standalone' = saved.mode === 'standalone' ? 'standalone' : 'shared'
        setUsername(saved.username)
        setPassword(saved.password || '')
        setDesktopRunMode(savedMode)
        if (remember && saved.password && !autoLoginAttemptedRef.current && !autoLoginSuppressed) {
          autoLoginAttemptedRef.current = true
          setIsSubmitting(true)
          doDesktopLogin(saved.username, saved.password, savedMode, remember)
            .catch((err: any) => setError(err?.message || err?.detail || String(err)))
            .finally(() => setIsSubmitting(false))
        }
      } catch {
        /* 未保存过或本机后端不可用：忽略 */
      }
    }
    void attempt()
    return () => { cancelled = true }
  }, [
    isOpen, desktopMode, mode, forceChangePassword, remember,
    doDesktopLogin, register, onClose, autoLoginSuppressed,
  ])

  // 切换数据空间：调本机重启接口；Windows 自动拉起，失败时提示手动重启
  useEffect(() => {
    if (!isOpen || !switchPending) return
    let cancelled = false
    setSwitchRestartFailed(false)
    desktopLoginApi
      .restart()
      .then((res: any) => {
        if (cancelled) return
        if (!res?.data?.restart_supported) setSwitchRestartFailed(true)
        // restart_supported=true 时进程即将退出，保持「正在重启」遮罩
      })
      .catch(() => {
        if (!cancelled) setSwitchRestartFailed(true)
      })
    return () => { cancelled = true }
  }, [isOpen, switchPending])

  if (!isOpen) return null

  // 运行模式切换中：全屏遮罩 + 自动重启（不允许再操作表单）
  if (switchPending) {
    const modeName = switchPending.mode === 'standalone'
      ? t('desktopAuth.modeStandalone', '单机模式')
      : t('desktopAuth.modeShared', '共享模式')
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="bg-card border border-border rounded-xl shadow-2xl px-8 py-7 w-[26rem] text-center">
          {!switchRestartFailed && (
            <Loader2 className="mx-auto mb-4 h-8 w-8 animate-spin text-primary" />
          )}
          <div className="text-base font-medium text-foreground">
            {t('desktopAuth.switching', { mode: modeName })}
          </div>
          {switchRestartFailed && (
            <div className="mt-3 text-sm text-destructive">
              {t('desktopAuth.switchRestartManual', '自动重启未执行，请手动关闭软件后重新打开')}
            </div>
          )}
        </div>
      </div>
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    // 客户端校验
    if (forceChangePassword) {
      if (!oldPassword) { setError('请输入旧密码'); return }
      if (password.length < 6) { setError(t('auth.passwordTooShort', '密码长度至少6位')); return }
      if (password !== confirmPassword) { setError(t('auth.passwordMismatch', '两次输入的密码不一致')); return }
    } else if (mode === 'register') {
      if (username.length < 3) { setError(t('auth.usernameTooShort', '用户名长度至少3位')); return }
      if (password.length < 6) { setError(t('auth.passwordTooShort', '密码长度至少6位')); return }
      if (password !== confirmPassword) { setError(t('auth.passwordMismatch', '两次输入的密码不一致')); return }
      if (!city) { setError(t('auth.groupRequired', '请选择地市与运营商')); return }
      if (!operator) { setError(t('auth.groupRequired', '请选择地市与运营商')); return }
    } else {
      if (!username.trim()) { setError('请输入用户名'); return }
      if (!password) { setError('请输入密码'); return }
    }

    setIsSubmitting(true)
    try {
      if (forceChangePassword) {
        await changePassword(oldPassword, password, confirmPassword)
        onClose?.()
      } else if (mode === 'login') {
        if (desktopMode) {
          // 桌面端：本机后端代理登录（remember 决定是否保存账号密码）
          await doDesktopLogin(username.trim(), password, desktopRunMode, remember)
        } else {
          // 先取上次停留页面，登录成功后恢复（须在 login 之前取，避免被路由记录覆盖）
          const restoreTarget = getLastRoute(username.trim())
          const warningMsg = await login(username.trim(), password)
          if (restoreTarget && restoreTarget !== location.pathname) {
            navigate(restoreTarget, { replace: true })
          }
          if (warningMsg) {
            setWarning(warningMsg)
            // 短暂显示警告后自动关闭
            setTimeout(() => onClose?.(), 2000)
          } else {
            onClose?.()
          }
        }
      } else {
        await register(username.trim(), password, confirmPassword, city, operator)
        onClose?.()
      }
    } catch (err: any) {
      const msg = err?.message || err?.detail || String(err)
      setError(msg)
    } finally {
      setIsSubmitting(false)
    }
  }

  const switchMode = () => {
    setError('')
    setWarning('')
    setCity('')
    setOperator('')
    setMode(mode === 'login' ? 'register' : 'login')
  }

  // 强制修改密码模式
  if (forceChangePassword) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="bg-card border border-border rounded-xl shadow-2xl p-8 w-96">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-yellow-500/10 rounded-lg">
              <LogIn size={20} className="text-yellow-500" />
            </div>
            <h2 className="text-lg font-semibold text-foreground">
              {t('auth.passwordRequired', '首次登录必须修改密码')}
            </h2>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-muted-foreground mb-1">
                {t('auth.oldPassword', '旧密码')}
              </label>
              <input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">
                {t('auth.newPassword', '新密码')}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">
                {t('auth.confirmNewPassword', '确认新密码')}
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-2.5 bg-primary text-primary-foreground rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isSubmitting && <Loader2 size={16} className="animate-spin" />}
              {t('auth.changePassword', '修改密码')}
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl p-8 w-96"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-primary/10 rounded-lg">
              {mode === 'login' ? <LogIn size={18} className="text-primary" /> : <UserPlus size={18} className="text-primary" />}
            </div>
            <h2 className="text-lg font-semibold text-foreground">
              {mode === 'login' ? t('auth.loginTitle', '用户登录') : t('auth.registerTitle', '用户注册')}
            </h2>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <X size={18} />
            </button>
          )}
        </div>

        {/* Warning */}
        {warning && (
          <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-sm text-yellow-400">
            {warning}
          </div>
        )}

        {/* Error */}
        {error && !warning && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-muted-foreground mb-1">
              {t('auth.username', '用户名')}
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder={t('auth.username', '用户名')}
              autoFocus
              autoComplete="username"
            />
          </div>
          <div>
            <label className="block text-sm text-muted-foreground mb-1">
              {t('auth.password', '密码')}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder={t('auth.password', '密码')}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </div>

          {/* 桌面端运行模式：共享模式与网页端一致；单机模式可断网登录
              （说明文案改为悬浮提示：选中只高亮左侧圆点，两个选项同行） */}
          {desktopMode && mode === 'login' && (
            <div>
              <label className="block text-sm text-muted-foreground mb-1.5">
                {t('desktopAuth.runModeLabel', '运行模式')}
              </label>
              <div className="flex gap-2" role="radiogroup" aria-label={t('desktopAuth.runModeLabel', '运行模式')}>
                {(['shared', 'standalone'] as const).map((value) => {
                  const checked = desktopRunMode === value
                  const hint = value === 'shared'
                    ? t('desktopAuth.modeSharedHint', '与网页端同一账号、权限与数据组，可共享数据。')
                    : t('desktopAuth.modeStandaloneHint', '数据仅存本机、可断网登录；需管理员授权，权限与网页端一致。')
                  return (
                    <label
                      key={value}
                      title={hint}
                      className="flex flex-1 items-center gap-2 min-w-0 px-3 py-2 rounded-lg border border-border cursor-pointer transition-colors hover:border-primary/50"
                    >
                      <input
                        type="radio"
                        name="desktop-run-mode"
                        value={value}
                        checked={checked}
                        onChange={() => setDesktopRunMode(value)}
                        className="h-4 w-4 shrink-0 accent-primary"
                      />
                      <span className="text-sm truncate">
                        {value === 'shared'
                          ? t('desktopAuth.modeShared', '共享模式')
                          : t('desktopAuth.modeStandalone', '单机模式')}
                      </span>
                    </label>
                  )
                })}
              </div>
              <label className="mt-2 flex items-center gap-2 cursor-pointer select-none" title={t('desktopAuth.rememberHint', '勾选后本机加密保存账号密码，下次打开自动登录；取消勾选会清除已保存的凭据。')}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                <span className="text-xs text-muted-foreground">
                  {t('desktopAuth.rememberPassword', '记住账号密码（下次自动登录）')}
                </span>
              </label>
            </div>
          )}

          {mode === 'register' && (
            <>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">
                  {t('auth.confirmPassword', '确认密码')}
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder={t('auth.confirmPassword', '确认密码')}
                  autoComplete="new-password"
                />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">
                  {t('auth.city', '地市')} <span className="text-red-500">*</span>
                </label>
                <select
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  <option value="">{t('auth.citySelectPlaceholder', '请选择地市')}</option>
                  {(options?.cities || []).map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">
                  {t('auth.operator', '运营商')} <span className="text-red-500">*</span>
                </label>
                <select
                  value={operator}
                  onChange={(e) => setOperator(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  <option value="">{t('auth.operatorPlaceholder', '请选择运营商')}</option>
                  {(options?.operators || FALLBACK_OPERATORS).map(op => (
                    <option key={op} value={op}>{op}</option>
                  ))}
                </select>
                {optionsError && (
                  <p className="mt-1 text-xs text-amber-500">{t('auth.optionsLoadFailed', '注册选项加载失败，请刷新重试')}</p>
                )}
              </div>
            </>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-2.5 bg-primary text-primary-foreground rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isSubmitting && <Loader2 size={16} className="animate-spin" />}
            {mode === 'login' ? t('auth.loginButton', '登录') : t('auth.registerButton', '注册')}
          </button>
        </form>

        {/* Switch mode：桌面端同样可以注册（账号创建在服务器上）
            登录态只留「立即注册」入口，不再提示"还没有账号？" */}
        {!forceChangePassword && (
          <div className="mt-5 text-center">
            {mode === 'register' && (
              <>
                <span className="text-sm text-muted-foreground">
                  {t('auth.hasAccount', '已有账号？')}
                </span>{' '}
              </>
            )}
            <button
              onClick={switchMode}
              className="text-sm text-primary hover:underline font-medium"
            >
              {mode === 'login' ? t('auth.goToRegister', '立即注册') : t('auth.goToLogin', '返回登录')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
