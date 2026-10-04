import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Palette, Sun, Moon, Key, RefreshCw, X, Globe, Calendar, Infinity, Loader2, LifeBuoy, Monitor, Copy, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MachineInfo, LicenseStatus } from '@shared/types'
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
import { licenseApi } from '../services/api'
import { LLMConfigCard } from '../components/LLMConfigCard'

export function LicensePage() {
  const { t, i18n } = useTranslation()
  const [isUpdating, setIsUpdating] = useState(false)
  const [updateMessage, setUpdateMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [selectedDate, setSelectedDate] = useState('')

  const { themeMode, colorScheme, setThemeMode, setColorScheme, applyTheme } = useThemeStore()
  const { user, fetchUser } = useAuthStore()
  const [previewTheme, setPreviewTheme] = useState<ThemeMode | null>(null)
  const [previewColor, setPreviewColor] = useState<ColorScheme | null>(null)

  const isAdmin = user?.is_admin ?? false
  const licenseExpiry = user?.license_expiry ?? null

  // 桌面离线授权：机器码与授权状态
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

  useEffect(() => {
    if (isAdmin) refreshLicenseState()
  }, [isAdmin, refreshLicenseState])

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
    <div className="p-6">
      <h1 className="text-base font-bold mb-6">{t('license.title')}</h1>

      {/* 大模型配置（网优助手）置顶整行：仅管理员或被授予网优助手权限的用户可见 */}
      {(isAdmin || user?.can_assistant) && (
        <div className="mb-6 max-w-5xl">
          <LLMConfigCard />
        </div>
      )}

      {/* 桌面离线授权：机器码 + 授权文件导入（仅桌面版、管理员可见） */}
      {isAdmin && machineInfo?.desktopMode && (
        <div className="mb-6 max-w-5xl">
          <div className="bg-card p-5 rounded-lg border border-border">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Monitor size={20} className="text-primary" />
                <h2 className="text-base font-semibold">{t('license.desktopTitle')}</h2>
              </div>
              <button
                onClick={() => refreshLicenseState()}
                className="p-1.5 hover:bg-muted rounded-lg transition-colors"
                title={t('license.refresh')}
              >
                <RefreshCw size={16} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-1.5">{t('license.machineCodeLabel')}</label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-muted rounded-lg text-sm font-mono tracking-wider">
                    {machineInfo.machineCode}
                  </code>
                  <button
                    onClick={handleCopyMachineCode}
                    className="px-3 py-2 border border-border rounded-lg hover:bg-muted text-sm font-medium flex items-center gap-1.5"
                  >
                    {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                    {copied ? t('license.copied') : t('license.copy')}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">{t('license.machineCodeHint')}</p>
              </div>

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
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium flex items-center gap-1.5"
                >
                  {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  {uploading ? t('license.uploading') : t('license.importButton')}
                </button>
                <p className="text-xs text-muted-foreground mt-1.5">{t('license.importHint')}</p>
              </div>

              {licenseStatus && (
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-5xl">
        {/* 语言设置 */}
        <div className="bg-card p-5 rounded-lg border border-border">
          <div className="flex items-center gap-2 mb-4">
            <Globe size={20} className="text-primary" />
            <h2 className="text-base font-semibold">{t('language.title')}</h2>
          </div>

          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{t('language.select')}</p>
            <div className="flex gap-2">
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

            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">{t('license.adminHint')}</p>

              <div>
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
                  className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium flex items-center justify-center gap-1.5"
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

          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('license.authorHint')}</p>

            <div className="pt-3 border-t border-border space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground flex-shrink-0">{t('license.adminEmailLabel')}</span>
                <a href="mailto:weicongpeng1@163.com" className="text-sm text-primary hover:underline break-all">
                  weicongpeng1@163.com
                </a>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground flex-shrink-0">{t('license.adminPhoneLabel')}</span>
                <a href="tel:15220958556" className="text-sm text-primary hover:underline">
                  15220958556
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* 主题与配色 */}
        <div className="bg-card p-5 rounded-lg border border-border">
          <div className="flex items-center gap-2 mb-4">
            <Palette size={20} className="text-primary" />
            <h2 className="text-base font-semibold">{t('theme.title')}</h2>
          </div>

          <div className="space-y-4">
            <div>
              <h3 className="text-xs font-medium text-muted-foreground mb-3">{t('theme.themeMode')}</h3>
              <div className="grid grid-cols-2 gap-3">
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

            {(previewTheme || previewColor) && (
              <div className="flex gap-2 pt-3 border-t border-border">
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
