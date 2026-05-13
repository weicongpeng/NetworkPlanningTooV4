import { useState } from 'react'
import { Check, Upload, Palette, Sun, Moon, Key, RefreshCw, X, Globe } from 'lucide-react'
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
import { useLicenseStore } from '../store/licenseStore'

export function LicensePage() {
  const { t, i18n } = useTranslation()
  const [isUploading, setIsUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<{type: 'success' | 'error', text: string} | null>(null)

  const { themeMode, colorScheme, setThemeMode, setColorScheme, applyTheme } = useThemeStore()
  const { isAuthorized, isLoading, expiryDate, remainingDays, errorMessage, refreshStatus } = useLicenseStore()
  const [previewTheme, setPreviewTheme] = useState<ThemeMode | null>(null)
  const [previewColor, setPreviewColor] = useState<ColorScheme | null>(null)

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

  const handleRefreshStatus = async () => {
    await refreshStatus()
  }

  const handleLanguageChange = (lang: string) => {
    i18n.changeLanguage(lang)
    localStorage.setItem('language', lang)
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsUploading(true)
    setUploadMessage(null)

    try {
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch('/api/v1/license/upload', {
        method: 'POST',
        body: formData
      })

      const result = await response.json()

      if (result.success) {
        setUploadMessage({ type: 'success', text: result.message })
        await refreshStatus()
      } else {
        setUploadMessage({ type: 'error', text: result.message })
      }
    } catch (error) {
      setUploadMessage({ type: 'error', text: t('license.uploadError') })
      console.error('上传许可证失败:', error)
    } finally {
      setIsUploading(false)
      setTimeout(() => setUploadMessage(null), 5000)
    }
  }

  const getExpiryDateDisplay = (expiryDate: string | null) => {
    if (!expiryDate) return '-'
    try {
      const date = new Date(expiryDate)
      const locale = i18n.language === 'en' ? 'en-US' : 'zh-CN'
      return date.toLocaleDateString(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
    } catch {
      return expiryDate
    }
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">{t('license.title')}</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-5xl">
        {/* 语言设置 */}
        <div className="bg-card p-5 rounded-lg border border-border">
          <div className="flex items-center gap-2 mb-4">
            <Globe size={20} className="text-primary" />
            <h2 className="text-lg font-semibold">{t('language.title')}</h2>
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
              <h2 className="text-lg font-semibold">{t('license.licenseManagement')}</h2>
            </div>
            <button
              onClick={handleRefreshStatus}
              className="p-1.5 hover:bg-muted rounded-lg transition-colors"
            >
              <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
            </button>
          </div>

          {!isLoading && (
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-muted-foreground">{t('license.status')}</span>
                <div className="flex items-center gap-1.5">
                  {isAuthorized ? (
                    <>
                      <Check size={14} className="text-green-500" />
                      <span className="text-sm text-green-500 font-medium">{t('license.authorized')}</span>
                    </>
                  ) : (
                    <>
                      <X size={14} className="text-red-500" />
                      <span className="text-sm text-red-500 font-medium">{t('license.unauthorized')}</span>
                    </>
                  )}
                </div>
              </div>

              {isAuthorized && (
                <>
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-sm text-muted-foreground">{t('license.expiryDate')}</span>
                    <span className="text-sm font-medium">{getExpiryDateDisplay(expiryDate)}</span>
                  </div>

                  {remainingDays !== null && (
                    <div className="flex items-center justify-between py-2">
                      <span className="text-sm text-muted-foreground">{t('license.remainingDays')}</span>
                      <span className={`text-sm font-medium ${remainingDays <= 30 ? 'text-orange-500' : ''}`}>
                        {remainingDays} {t('license.days')}
                      </span>
                    </div>
                  )}
                </>
              )}

              {!isAuthorized && errorMessage && (
                <>
                  <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                    <p className="text-sm text-red-500 font-medium mb-2">{t('license.expiredMessage')}</p>
                    <div className="space-y-1 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-red-400">{t('license.email')}</span>
                        <a href="mailto:weicongpeng1@163.com" className="text-primary hover:underline">
                          weicongpeng1@163.com
                        </a>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-red-400">{t('license.wechat')}</span>
                        <span className="font-mono">pengwc2010</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <div className="flex-1 flex justify-center">
                      <img
                        src="/wechat-qr.png"
                        alt="微信二维码"
                        className="w-1/2 border border-border rounded bg-white"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement
                          target.style.display = 'none'
                        }}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="flex flex-col items-center justify-center w-full h-20 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary transition-colors bg-background">
                      <div className="flex flex-col items-center justify-center text-muted-foreground">
                        <Upload size={20} />
                        <p className="text-xs mt-1">{t('license.uploadPrompt')}</p>
                      </div>
                      <input
                        type="file"
                        className="hidden"
                        accept=".lic,.dat"
                        onChange={handleFileUpload}
                        disabled={isUploading}
                      />
                    </label>
                  </div>

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
                </>
              )}
            </div>
          )}

          {isLoading && (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary mx-auto mb-2"></div>
              <p className="text-xs text-muted-foreground">{t('license.loading')}</p>
            </div>
          )}
        </div>

        {/* 主题与配色 */}
        <div className="bg-card p-5 rounded-lg border border-border">
          <div className="flex items-center gap-2 mb-4">
            <Palette size={20} className="text-primary" />
            <h2 className="text-lg font-semibold">{t('theme.title')}</h2>
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
