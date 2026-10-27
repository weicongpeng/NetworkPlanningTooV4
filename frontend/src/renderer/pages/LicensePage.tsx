import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Palette, Sun, Moon, Key, RefreshCw, X, Globe, Calendar, Infinity, Loader2, LifeBuoy, Monitor, Copy, Upload, Cloud, Send, Settings, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MachineInfo, LicenseStatus, DesktopCloudStatus } from '@shared/types'
import {
  useThemeStore,
  ThemeMode,
  ColorScheme,
  DARK_THEME_VARS,
  LIGHT_THEME_VARS,
  THEME_COLORS,
  kebabCase
} from '../store/themeStore'
import { useAuthStore } from '../store/authStore'
import { useDesktopUpdateStore } from '../store/desktopUpdateStore'
import { licenseApi, desktopCloudApi, desktopUpdateApi } from '../services/api'
import { LLMConfigCard } from '../components/LLMConfigCard'
import { DesktopUpdateReadyBanner } from '../components/DesktopUpdateReadyBanner'

export function LicensePage() {
  const { t, i18n } = useTranslation()
  const [isUpdating, setIsUpdating] = useState(false)
  const [updateMessage, setUpdateMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [selectedDate, setSelectedDate] = useState('')

  const { themeMode, colorScheme, setThemeMode, setColorScheme, applyTheme } = useThemeStore()
  const { user, fetchUser } = useAuthStore()
  const desktopMode = useAuthStore((s) => s.desktopMode)
  const desktopRunMode = useAuthStore((s) => s.desktopRunMode)
  const isStandalone = desktopRunMode === 'standalone'
  const [previewTheme, setPreviewTheme] = useState<ThemeMode | null>(null)
  const [previewColor, setPreviewColor] = useState<ColorScheme | null>(null)

  const isAdmin = user?.is_admin ?? false
  const licenseExpiry = user?.license_expiry ?? null

  // 桌面端授权：机器码与授权状态
  const [machineInfo, setMachineInfo] = useState<MachineInfo | null>(null)
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const licenseFileRef = useRef<HTMLInputElement>(null)

  const refreshLicenseState = useCallback(async () => {
    try {
      const [infoRes, statusRes] = await Promise.all([
        licenseApi.getMachineInfo(),
        licenseApi.getStatus(),
      ])
      if (infoRes.success) setMachineInfo(infoRes.data)
      if (statusRes.success) setLicenseStatus(statusRes.data)
    } catch {
      // 服务器部署无机器码接口时静默忽略
    }
  }, [])

  // ---- 在线激活 / 续期（桌面版；网页端接口返回 404，静默忽略）----
  const [cloudStatus, setCloudStatus] = useState<DesktopCloudStatus | null>(null)
  const [activationCode, setActivationCode] = useState('')
  const [cloudBusy, setCloudBusy] = useState<'' | 'activate' | 'renew' | 'apply'>('')
  const [cloudMessage, setCloudMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [showApplyForm, setShowApplyForm] = useState(false)
  const [applyName, setApplyName] = useState('')
  const [applyOrg, setApplyOrg] = useState('')
  const [applyWaiting, setApplyWaiting] = useState(false)

  const refreshCloudStatus = useCallback(async () => {
    try {
      const res = await desktopCloudApi.getStatus()
      if (res.success) setCloudStatus(res.data)
    } catch {
      // 非桌面版或本机后端不可用
    }
  }, [])

  useEffect(() => {
    if (machineInfo?.desktopMode) refreshCloudStatus()
  }, [machineInfo?.desktopMode, refreshCloudStatus])

  // ---- 版本与更新（桌面版）：当前版本 + 手动检查更新 ----
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [checkMessage, setCheckMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const requestUpdateCheck = useDesktopUpdateStore((s) => s.requestCheck)

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true)
    setCheckMessage(null)
    try {
      const res = await desktopUpdateApi.status()
      const data = res?.data
      if (data?.update_available && data.release) {
        // 有新版本：交给全局更新弹窗展示与下载，避免维护两套更新 UI
        requestUpdateCheck(data)
      } else {
        setCheckMessage({ type: 'success', text: t('desktopUpdate.upToDate') })
      }
    } catch (err: any) {
      setCheckMessage({ type: 'error', text: err?.message || t('desktopUpdate.checkFailed') })
    } finally {
      setCheckingUpdate(false)
      setTimeout(() => setCheckMessage(null), 6000)
    }
  }

  const handleCloudActivate = async () => {
    const code = activationCode.trim()
    if (!code) return
    setCloudBusy('activate')
    setCloudMessage(null)
    try {
      const res: any = await desktopCloudApi.activate(code)
      setCloudMessage({ type: 'success', text: res?.message || t('license.cloudActivateSuccess') })
      setActivationCode('')
      setShowApplyForm(false)
      setApplyWaiting(false)
      await fetchUser()
      await refreshLicenseState()
      await refreshCloudStatus()
    } catch (err: any) {
      setCloudMessage({ type: 'error', text: err?.message || t('license.cloudActivateFailed') })
    } finally {
      setCloudBusy('')
      setTimeout(() => setCloudMessage(null), 8000)
    }
  }

  const handleCloudRenew = async () => {
    setCloudBusy('renew')
    setCloudMessage(null)
    try {
      const res: any = await desktopCloudApi.renew()
      setCloudMessage({ type: 'success', text: res?.message || t('license.cloudRenewSuccess') })
      await fetchUser()
      await refreshLicenseState()
      await refreshCloudStatus()
    } catch (err: any) {
      setCloudMessage({ type: 'error', text: err?.message || t('license.cloudRenewFailed') })
    } finally {
      setCloudBusy('')
      setTimeout(() => setCloudMessage(null), 8000)
    }
  }

  const handleCloudApply = async () => {
    if (!applyName.trim()) return
    setCloudBusy('apply')
    setCloudMessage(null)
    try {
      const res: any = await desktopCloudApi.apply({
        applicant_name: applyName.trim(),
        organization: applyOrg.trim() || undefined,
      })
      if (res?.success) {
        setApplyWaiting(true)
        setCloudMessage({ type: 'success', text: t('license.cloudApplySubmitted') })
      }
    } catch (err: any) {
      setCloudMessage({ type: 'error', text: err?.message || t('license.cloudApplyFailed') })
    } finally {
      setCloudBusy('')
      setTimeout(() => setCloudMessage(null), 8000)
    }
  }

  // 申请后每 5 秒轮询一次批准结果（批准后本机自动完成激活）
  useEffect(() => {
    if (!applyWaiting) return
    const timer = window.setInterval(async () => {
      try {
        const res: any = await desktopCloudApi.pollApply()
        const data = res?.data
        if (data?.activated) {
          setApplyWaiting(false)
          setCloudMessage({ type: 'success', text: t('license.cloudApplyApproved') })
          await fetchUser()
          await refreshLicenseState()
          await refreshCloudStatus()
        } else if (data?.status === 'rejected') {
          setApplyWaiting(false)
          setCloudMessage({ type: 'error', text: data?.message || t('license.cloudApplyRejected') })
        }
      } catch {
        // 网络抖动：下个周期重试
      }
    }, 5000)
    return () => window.clearInterval(timer)
  }, [applyWaiting, fetchUser, refreshLicenseState, refreshCloudStatus])

  useEffect(() => {
    // 桌面版所有用户都要机器信息（版本卡片/授权展示）；网页端仅管理员需要
    if (isAdmin || desktopMode) refreshLicenseState()
  }, [isAdmin, desktopMode, refreshLicenseState])

  const handleCopyMachineCode = async () => {
    const code = machineInfo?.machineCode
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = code
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleUploadLicense = async (file: File) => {
    setUploading(true)
    setUploadMessage(null)
    try {
      const result: any = await licenseApi.upload(file)
      if (result?.success) {
        setUploadMessage({ type: 'success', text: result.message || t('license.uploadSuccess') })
        await fetchUser()
        await refreshLicenseState()
      } else {
        setUploadMessage({ type: 'error', text: result?.message || t('license.uploadError') })
      }
    } catch (err: any) {
      setUploadMessage({ type: 'error', text: err?.message || t('license.uploadError') })
    } finally {
      setUploading(false)
      if (licenseFileRef.current) licenseFileRef.current.value = ''
      setTimeout(() => setUploadMessage(null), 8000)
    }
  }

  const handleThemeSelect = (mode: ThemeMode) => {
    setPreviewTheme(mode)
    const root = document.documentElement
    const themeVars = mode === 'dark' ? DARK_THEME_VARS : LIGHT_THEME_VARS
    Object.entries(themeVars).forEach(([key, value]) => {
      // kebab-case：与 applyTheme / CSS 变量名一致（驼峰名写不进 --muted-foreground 等）
      root.style.setProperty(`--${kebabCase(key)}`, value)
    })
  }

  const handleColorSelect = (color: ColorScheme) => {
    setPreviewColor(color)
    const root = document.documentElement
    const colorVars = THEME_COLORS[color]
    Object.entries(colorVars).forEach(([key, value]) => {
      root.style.setProperty(`--${kebabCase(key)}`, value)
    })
  }

  const handleApplyTheme = () => {
    if (previewTheme) setThemeMode(previewTheme)
    if (previewColor) setColorScheme(previewColor)
    setPreviewTheme(null)
    setPreviewColor(null)
  }

  const handleCancelTheme = () => {
    setPreviewTheme(null)
    setPreviewColor(null)
    applyTheme()
  }

  const handleLanguageChange = (lang: string) => {
    i18n.changeLanguage(lang)
    localStorage.setItem('language', lang)
  }

  const handleUpdateExpiry = async () => {
    setIsUpdating(true)
    setUpdateMessage(null)
    try {
      const result = await licenseApi.updateExpiry(selectedDate || null)
      if (result.success) {
        setUpdateMessage({ type: 'success', text: t('license.updateSuccess') })
        await fetchUser()
        setSelectedDate('')
      } else {
        setUpdateMessage({ type: 'error', text: (result as any).message || t('license.updateFailed') })
      }
    } catch (err: any) {
      setUpdateMessage({ type: 'error', text: err?.message || t('license.updateFailed') })
    } finally {
      setIsUpdating(false)
      setTimeout(() => setUpdateMessage(null), 5000)
    }
  }

  const handleSetUnlimited = async () => {
    setIsUpdating(true)
    setUpdateMessage(null)
    try {
      const result = await licenseApi.updateExpiry(null)
      if (result.success) {
        setUpdateMessage({ type: 'success', text: t('license.unlimitedSet') })
        await fetchUser()
        setSelectedDate('')
      } else {
        setUpdateMessage({ type: 'error', text: (result as any).message || t('license.updateFailed') })
      }
    } catch (err: any) {
      setUpdateMessage({ type: 'error', text: err?.message || t('license.updateFailed') })
    } finally {
      setIsUpdating(false)
      setTimeout(() => setUpdateMessage(null), 5000)
    }
  }

  // 授权状态/到期展示已从卡片移除：用当前到期日期预填输入框，便于管理员查看与修改
  useEffect(() => {
    if (!licenseExpiry) return
    setSelectedDate(licenseExpiry.slice(0, 10))
  }, [licenseExpiry])

  return (
    <div className="p-6 w-full space-y-6">
      <div className="flex items-center gap-2">
        <Settings size={20} className="text-primary" />
        <h1 className="text-base font-bold">{t('license.title')}</h1>
      </div>

      {/* 大模型配置（网优助手）：仅管理员或被授予网优助手权限的用户可见 */}
      {(isAdmin || user?.can_assistant) && <LLMConfigCard />}

      {/* 桌面端授权：在线激活/续期 + 机器码 + 离线导入（仅共享模式桌面版的管理员） */}
      {machineInfo?.desktopMode && isAdmin && !isStandalone && (
        <div className="bg-card p-5 rounded-lg border border-border">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Monitor size={20} className="text-primary" />
              <h2 className="text-base font-semibold">{t('license.desktopTitle')}</h2>
            </div>
            <button
              onClick={() => {
                refreshLicenseState()
                refreshCloudStatus()
              }}
              className="p-1.5 hover:bg-muted rounded-lg transition-colors"
              title={t('license.refresh')}
            >
              <RefreshCw size={16} />
            </button>
          </div>

          {isAdmin && (
            <p className="mb-4 text-xs text-muted-foreground">{t('license.desktopAdminHint', '管理员账号默认享有全部权限，无需授权激活')}</p>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-8 gap-y-5">
            <div className="min-w-0 space-y-5">
              <div>
                <label className="block text-xs text-muted-foreground mb-1.5">{t('license.machineCodeLabel')}</label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-muted rounded-lg text-sm font-mono tracking-wider break-all">
                    {machineInfo.machineCode}
                  </code>
                  <button
                    onClick={handleCopyMachineCode}
                    className="px-3 py-2 border border-border rounded-lg hover:bg-muted text-sm font-medium flex items-center gap-1.5 flex-shrink-0"
                  >
                    {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                    {copied ? t('license.copied') : t('license.copy')}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">{t('license.machineCodeHint')}</p>
              </div>

              {/* 在线激活 / 续期 */}
              <div className="pt-4 border-t border-border">
                <label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1.5">
                  <Cloud size={13} /> {t('license.cloudLabel')}
                </label>

                {cloudStatus?.license?.valid ? (
                  <div className="space-y-3">
                    <div className="p-2 rounded flex items-center gap-2 border bg-green-500/10 border-green-500/20 text-green-500">
                      <Check size={14} />
                      <span className="text-xs">
                        {t('license.desktopStatusActive', { date: cloudStatus.license.expire_date || '' })}
                        {typeof cloudStatus.license.remaining_days === 'number' &&
                          `（${t('license.remainingDaysLabel')} ${cloudStatus.license.remaining_days} ${t('license.daysUnit')}）`}
                        {cloudStatus.license.subject ? ` · ${cloudStatus.license.subject}` : ''}
                        {' · '}
                        {cloudStatus.license.issued_via === 'online'
                          ? t('license.issuedViaOnline')
                          : t('license.issuedViaOffline')}
                      </span>
                    </div>
                    {cloudStatus.license.issued_via === 'online' && (
                      <button
                        onClick={handleCloudRenew}
                        disabled={cloudBusy !== ''}
                        className="px-4 py-2 border border-border rounded-lg hover:bg-muted disabled:opacity-50 text-sm font-medium flex items-center gap-1.5"
                      >
                        {cloudBusy === 'renew' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                        {cloudBusy === 'renew' ? t('license.cloudRenewing') : t('license.cloudRenewButton')}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <input
                        value={activationCode}
                        onChange={(e) => setActivationCode(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleCloudActivate()
                        }}
                        placeholder={t('license.activationCodePlaceholder')}
                        className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono tracking-wider focus:outline-none focus:ring-2 focus:ring-primary/50"
                      />
                      <button
                        onClick={handleCloudActivate}
                        disabled={cloudBusy !== '' || !activationCode.trim()}
                        className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium flex items-center gap-1.5"
                      >
                        {cloudBusy === 'activate' ? <Loader2 size={14} className="animate-spin" /> : <Cloud size={14} />}
                        {cloudBusy === 'activate' ? t('license.cloudActivating') : t('license.cloudActivateButton')}
                      </button>
                    </div>

                    {applyWaiting ? (
                      <div className="p-2 rounded bg-blue-500/10 border border-blue-500/20 text-blue-500 text-xs flex items-center gap-2">
                        <Loader2 size={14} className="animate-spin" />
                        {t('license.cloudApplyWaiting')}
                      </div>
                    ) : !showApplyForm ? (
                      <button
                        onClick={() => setShowApplyForm(true)}
                        className="text-xs text-primary hover:underline flex items-center gap-1"
                      >
                        <Send size={12} /> {t('license.cloudApplyToggle')}
                      </button>
                    ) : (
                      <div className="space-y-2 p-3 border border-border rounded-lg">
                        <p className="text-xs text-muted-foreground">{t('license.cloudApplyHint')}</p>
                        <input
                          value={applyName}
                          onChange={(e) => setApplyName(e.target.value)}
                          placeholder={t('license.cloudApplyName')}
                          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                        <input
                          value={applyOrg}
                          onChange={(e) => setApplyOrg(e.target.value)}
                          placeholder={t('license.cloudApplyOrg')}
                          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={handleCloudApply}
                            disabled={cloudBusy !== '' || !applyName.trim()}
                            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium flex items-center gap-1.5"
                          >
                            {cloudBusy === 'apply' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                            {t('license.cloudApplySubmit')}
                          </button>
                          <button
                            onClick={() => setShowApplyForm(false)}
                            className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:opacity-90 text-sm font-medium"
                          >
                            {t('theme.cancel')}
                          </button>
                        </div>
                      </div>
                    )}

                    {cloudStatus?.license?.errorMessage && (
                      <p className="text-xs text-amber-600">{cloudStatus.license.errorMessage}</p>
                    )}
                  </div>
                )}

                <p className="text-xs text-muted-foreground mt-2">
                  {t('license.cloudServerHint', { url: cloudStatus?.server_url || '' })}
                </p>
              </div>

            </div>

            {/* 右列：离线导入（内网/无网络时由厂商签发）与状态提示 */}
            <div className="min-w-0 space-y-4 pt-4 border-t border-border xl:pt-0 xl:border-t-0 xl:border-l xl:pl-8">
              <div>
                <label className="block text-xs text-muted-foreground mb-1.5">{t('license.importLabel')}</label>
                <input
                  ref={licenseFileRef}
                  type="file"
                  accept=".nptlic,.lic,.dat,.txt"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleUploadLicense(f)
                  }}
                />
                <button
                  onClick={() => licenseFileRef.current?.click()}
                  disabled={uploading}
                  className="px-4 py-2 border border-border rounded-lg hover:bg-muted disabled:opacity-50 text-sm font-medium flex items-center gap-1.5"
                >
                  {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  {uploading ? t('license.uploading') : t('license.importButton')}
                </button>
                <p className="text-xs text-muted-foreground mt-1.5">{t('license.importHint')}</p>
              </div>

              {licenseStatus && !cloudStatus?.license?.valid && (
                <div className={`p-2 rounded flex items-center gap-2 border ${
                  licenseStatus.valid
                    ? 'bg-green-500/10 border-green-500/20 text-green-500'
                    : 'bg-amber-500/10 border-amber-500/20 text-amber-600'
                }`}>
                  {licenseStatus.valid ? <Check size={14} /> : <X size={14} />}
                  <span className="text-xs">
                    {licenseStatus.valid
                      ? t('license.desktopStatusActive', { date: licenseStatus.expiryDate })
                      : (licenseStatus.errorMessage || t('license.desktopStatusInactive'))}
                  </span>
                </div>
              )}

              {cloudMessage && (
                <div className={`p-2 rounded flex items-center gap-2 ${
                  cloudMessage.type === 'success'
                    ? 'bg-green-500/10 border border-green-500/20 text-green-500'
                    : 'bg-red-500/10 border border-red-500/20 text-red-500'
                }`}>
                  {cloudMessage.type === 'success' ? <Check size={14} /> : <X size={14} />}
                  <span className="text-xs">{cloudMessage.text}</span>
                </div>
              )}

              {uploadMessage && (
                <div className={`p-2 rounded flex items-center gap-2 ${
                  uploadMessage.type === 'success'
                    ? 'bg-green-500/10 border border-green-500/20 text-green-500'
                    : 'bg-red-500/10 border border-red-500/20 text-red-500'
                }`}>
                  {uploadMessage.type === 'success' ? <Check size={14} /> : <X size={14} />}
                  <span className="text-xs">{uploadMessage.text}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 版本与更新（仅桌面版）：当前版本 + 检查更新 */}
      {machineInfo?.desktopMode && (
        <div className="bg-card p-5 rounded-lg border border-border">
          <div className="flex items-center gap-2 mb-4">
            <Info size={20} className="text-primary" />
            <h2 className="text-base font-semibold">{t('desktopUpdate.versionTitle')}</h2>
          </div>

          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <div className="text-xs text-muted-foreground mb-1">{t('desktopUpdate.currentVersion')}</div>
              <div className="text-sm font-mono">{cloudStatus?.version || t('desktopUpdate.versionUnknown')}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">{t('desktopUpdate.channelLabel')}</div>
              <div className="text-sm">{cloudStatus?.channel || '-'}</div>
            </div>
            <button
              onClick={handleCheckUpdate}
              disabled={checkingUpdate}
              className="px-4 py-2 border border-border rounded-lg hover:bg-muted disabled:opacity-50 text-sm font-medium flex items-center gap-1.5"
            >
              {checkingUpdate ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {checkingUpdate ? t('desktopUpdate.checking') : t('desktopUpdate.checkButton')}
            </button>
          </div>

          {/* 安装包已下载完成 → 「更新已就绪，重启后完成更新」+ 立即重启 */}
          <DesktopUpdateReadyBanner />

          {checkMessage && (
            <div className={`mt-3 p-2 rounded flex items-center gap-2 ${
              checkMessage.type === 'success'
                ? 'bg-green-500/10 border border-green-500/20 text-green-500'
                : 'bg-red-500/10 border border-red-500/20 text-red-500'
            }`}>
              {checkMessage.type === 'success' ? <Check size={14} /> : <X size={14} />}
              <span className="text-xs">{checkMessage.text}</span>
            </div>
          )}
        </div>
      )}

      {/* 语言设置 */}
      <div className="bg-card p-5 rounded-lg border border-border">
        <div className="flex items-center gap-2 mb-4">
          <Globe size={20} className="text-primary" />
          <h2 className="text-base font-semibold">{t('language.title')}</h2>
        </div>

        <p className="text-xs text-muted-foreground mb-3">{t('language.select')}</p>
        <div className="flex gap-2 max-w-md">
          <button
            onClick={() => handleLanguageChange('zh')}
            className={`flex-1 px-4 py-2.5 rounded-lg border-2 transition-all text-sm font-medium ${
              i18n.language === 'zh'
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border hover:border-primary/50'
            }`}
          >
            {t('language.zh')}
          </button>
          <button
            onClick={() => handleLanguageChange('en')}
            className={`flex-1 px-4 py-2.5 rounded-lg border-2 transition-all text-sm font-medium ${
              i18n.language === 'en'
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border hover:border-primary/50'
            }`}
          >
            {t('language.en')}
          </button>
        </div>
      </div>

      {/* 主题与配色 */}
      <div className="bg-card p-5 rounded-lg border border-border">
        <div className="flex items-center gap-2 mb-4">
          <Palette size={20} className="text-primary" />
          <h2 className="text-base font-semibold">{t('theme.title')}</h2>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <h3 className="text-xs font-medium text-muted-foreground mb-3">{t('theme.themeMode')}</h3>
            <div className="grid grid-cols-2 gap-3 max-w-md">
              <ThemeModeCard
                mode="dark"
                icon={<Moon size={18} />}
                label={t('theme.dark')}
                isSelected={(previewTheme || themeMode) === 'dark'}
                onSelect={() => handleThemeSelect('dark')}
                previewBg="bg-slate-900"
                previewText="text-white"
              />
              <ThemeModeCard
                mode="light"
                icon={<Sun size={18} />}
                label={t('theme.light')}
                isSelected={(previewTheme || themeMode) === 'light'}
                onSelect={() => handleThemeSelect('light')}
                previewBg="bg-white"
                previewText="text-slate-900"
              />
            </div>
          </div>

          <div>
            <h3 className="text-xs font-medium text-muted-foreground mb-3">{t('theme.colorScheme')}</h3>
            <div className="flex flex-wrap gap-2">
              {(['blue', 'green', 'purple', 'orange', 'pink'] as ColorScheme[]).map((color) => (
                <ColorSwatch
                  key={color}
                  color={color}
                  isSelected={(previewColor || colorScheme) === color}
                  onSelect={() => handleColorSelect(color)}
                />
              ))}
            </div>
          </div>
        </div>

        {(previewTheme || previewColor) && (
          <div className="flex gap-2 pt-4 mt-4 border-t border-border max-w-md">
            <button
              onClick={handleApplyTheme}
              className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 text-sm font-medium"
            >
              {t('theme.apply')}
            </button>
            <button
              onClick={handleCancelTheme}
              className="flex-1 px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:opacity-90 text-sm font-medium"
            >
              {t('theme.cancel')}
            </button>
          </div>
        )}
      </div>

      {/* 授权管理（仅管理员，且非桌面版）：桌面版期限由授权文件控制 */}
      {isAdmin && !machineInfo?.desktopMode && (
        <div className="bg-card p-5 rounded-lg border border-border">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Key size={20} className="text-primary" />
              <h2 className="text-base font-semibold">{t('license.adminTitle')}</h2>
            </div>
            <button
              onClick={() => fetchUser()}
              className="p-1.5 hover:bg-muted rounded-lg transition-colors"
              title={t('license.refresh')}
            >
              <RefreshCw size={16} />
            </button>
          </div>

          <div className="space-y-3 max-w-2xl">
            <p className="text-xs text-muted-foreground">{t('license.adminHint')}</p>

            <div className="max-w-xs">
              <label className="block text-xs text-muted-foreground mb-1.5">{t('license.expiryDateInput')}</label>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleUpdateExpiry}
                disabled={isUpdating || !selectedDate}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium flex items-center justify-center gap-1.5"
              >
                {isUpdating ? <Loader2 size={14} className="animate-spin" /> : <Calendar size={14} />}
                {t('license.updateButton')}
              </button>
              <button
                onClick={handleSetUnlimited}
                disabled={isUpdating}
                className="px-4 py-2 border border-border rounded-lg hover:bg-muted text-sm font-medium flex items-center gap-1.5 disabled:opacity-50"
              >
                <Infinity size={14} />
                {t('license.setUnlimited')}
              </button>
            </div>

            {updateMessage && (
              <div className={`p-2 rounded flex items-center gap-2 ${
                updateMessage.type === 'success'
                  ? 'bg-green-500/10 border border-green-500/20 text-green-500'
                  : 'bg-red-500/10 border border-red-500/20 text-red-500'
              }`}>
                {updateMessage.type === 'success' ? <Check size={14} /> : <X size={14} />}
                <span className="text-xs">{updateMessage.text}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 特别声明：声明内容在上，联系方式置于卡片底部 */}
      <div className="bg-card p-5 rounded-lg border border-border">
        <div className="flex items-center gap-2 mb-4">
          <LifeBuoy size={20} className="text-primary" />
          <h2 className="text-base font-semibold">{t('license.authorTitle')}</h2>
        </div>

        <p className="text-sm text-muted-foreground">{t('license.authorHint')}</p>

        <div className="pt-3 mt-3 border-t border-border flex flex-wrap gap-x-8 gap-y-2">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{t('license.adminEmailLabel')}</span>
            <a href="mailto:weicongpeng1@163.com" className="text-sm text-primary hover:underline break-all">
              weicongpeng1@163.com
            </a>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{t('license.adminPhoneLabel')}</span>
            <a href="tel:15220958556" className="text-sm text-primary hover:underline">
              15220958556
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

interface ThemeModeCardProps {
  mode: ThemeMode
  icon: React.ReactNode
  label: string
  isSelected: boolean
  onSelect: () => void
  previewBg: string
  previewText: string
}

function ThemeModeCard({
  mode: _mode,
  icon,
  label,
  isSelected,
  onSelect,
  previewBg,
  previewText
}: ThemeModeCardProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }

  return (
    <div
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={label}
      className={`relative cursor-pointer rounded-lg border-2 transition-all ${
        isSelected ? 'border-primary ring-2 ring-primary/20' : 'border-border hover:border-primary/50'
      }`}
    >
      <div className={`p-3 ${previewBg} ${previewText} rounded-md`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {icon}
            <span className="text-sm font-medium">{label}</span>
          </div>
          {isSelected && <Check size={14} className="text-primary" />}
        </div>
      </div>
    </div>
  )
}

interface ColorSwatchProps {
  color: ColorScheme
  isSelected: boolean
  onSelect: () => void
}

function ColorSwatch({ color, isSelected, onSelect }: ColorSwatchProps) {
  const { t } = useTranslation()
  const colorMap = {
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    purple: 'bg-purple-500',
    orange: 'bg-orange-500',
    pink: 'bg-pink-500'
  }

  const colorLabels = {
    blue: t('theme.blue'),
    green: t('theme.green'),
    purple: t('theme.purple'),
    orange: t('theme.orange'),
    pink: t('theme.pink')
  }

  return (
    <button
      onClick={onSelect}
      aria-label={colorLabels[color]}
      aria-pressed={isSelected}
      className={`relative flex flex-col items-center gap-1 p-2 rounded-lg border-2 transition-all ${
        isSelected ? 'border-primary ring-2 ring-primary/20' : 'border-border hover:border-primary/50'
      }`}
      title={colorLabels[color]}
    >
      <div className={`w-7 h-7 rounded-full ${colorMap[color]} transition-transform hover:scale-110`} />
      <span className="text-xs font-medium">{colorLabels[color]}</span>
      {isSelected && (
        <div className="absolute top-0.5 right-0.5">
          <Check size={12} className="text-primary" />
        </div>
      )}
    </button>
  )
}
