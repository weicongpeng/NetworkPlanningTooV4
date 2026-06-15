import { useState } from 'react'
import { Check, Palette, Sun, Moon, Key, RefreshCw, X, Globe, Calendar, Infinity, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
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

  const handleThemeSelect = (mode: ThemeMode) => {
    setPreviewTheme(mode)
    const root = document.documentElement
    const themeVars = mode === 'dark' ? DARK_THEME_VARS : LIGHT_THEME_VARS
    Object.entries(themeVars).forEach(([key, value]) => {
      root.style.setProperty(`--${key}`, value)
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

  const getExpiryDisplay = () => {
    if (!licenseExpiry) return { text: t('license.unlimited'), remaining: null, expired: false }
    try {
      const expiry = new Date(licenseExpiry)
      const now = new Date()
      const remaining = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      const locale = i18n.language === 'en' ? 'en-US' : 'zh-CN'
      return {
        text: expiry.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' }),
        remaining,
        expired: remaining < 0,
      }
    } catch {
      return { text: licenseExpiry, remaining: null, expired: false }
    }
  }

  const expiryInfo = getExpiryDisplay()

  return (
    <div className="p-6">
      <h1 className="text-base font-bold mb-6">{t('license.title')}</h1>

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

        {/* License管理 */}
        <div className="bg-card p-5 rounded-lg border border-border">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Key size={20} className="text-primary" />
              <h2 className="text-base font-semibold">
                {isAdmin ? t('license.adminTitle') : t('license.userTitle')}
              </h2>
            </div>
            {isAdmin && (
              <button
                onClick={() => fetchUser()}
                className="p-1.5 hover:bg-muted rounded-lg transition-colors"
                title={t('license.refresh')}
              >
                <RefreshCw size={16} />
              </button>
            )}
          </div>

          <div className="space-y-3">
            {/* 授权状态 */}
            <div className="flex items-center justify-between py-2 border-b border-border">
              <span className="text-sm text-muted-foreground">{t('license.statusLabel')}</span>
              <div className="flex items-center gap-1.5">
                {expiryInfo.expired ? (
                  <>
                    <X size={14} className="text-red-500" />
                    <span className="text-sm text-red-500 font-medium">{t('license.expired')}</span>
                  </>
                ) : (
                  <>
                    <Check size={14} className="text-green-500" />
                    <span className="text-sm text-green-500 font-medium">{t('license.valid')}</span>
                  </>
                )}
              </div>
            </div>

            {/* 授权到期日期 */}
            <div className="flex items-center justify-between py-2 border-b border-border">
              <span className="text-sm text-muted-foreground">{t('license.expiryDateLabel')}</span>
              <span className={`text-sm font-mono font-medium ${expiryInfo.expired ? 'text-red-500' : ''}`}>
                {expiryInfo.text}
              </span>
            </div>

            {/* 剩余天数 */}
            {expiryInfo.remaining !== null && (
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-muted-foreground">{t('license.remainingDaysLabel')}</span>
                <span className={`text-sm font-medium ${expiryInfo.remaining <= 30 ? 'text-orange-500' : ''}`}>
                  {expiryInfo.remaining} {t('license.daysUnit')}
                </span>
              </div>
            )}

            {!licenseExpiry && (
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-muted-foreground">{t('license.remainingDaysLabel')}</span>
                <span className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                  <Infinity size={14} /> {t('license.unlimited')}
                </span>
              </div>
            )}

            {/* 管理员操作区 */}
            {isAdmin && (
              <div className="pt-3 border-t border-border space-y-3">
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
            )}

            {/* 普通用户过期提示 */}
            {!isAdmin && expiryInfo.expired && (
              <div className="pt-3 border-t border-border">
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                  <p className="text-sm text-red-500 font-medium mb-2">{t('license.expiredContactAdmin')}</p>
                  <div className="space-y-1 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-red-400">{t('license.email')}</span>
                      <a href="mailto:weicongpeng1@163.com" className="text-primary hover:underline">
                        weicongpeng1@163.com
                      </a>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-red-400">{t('license.wechat')}</span>
                      <span className="font-mono text-red-300">pengwc2010</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
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
