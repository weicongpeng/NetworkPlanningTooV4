/**
 * 标签设置弹窗组件
 *
 * 功能:
 * - 标签内容选择（下拉列表，动态加载字段）
 * - 颜色选择器（react-colorful + 预设颜色）
 * - 字体大小输入（8-20范围）
 * - 保存/取消按钮
 */
import { useState, useEffect } from 'react'
import { X, ChevronDown } from 'lucide-react'
import { HexColorPicker } from 'react-colorful'
import { useTranslation } from 'react-i18next'

/**
 * 标签字段类型 - 现在支持任意字符串
 */
export type LabelField = string

/**
 * 字段选项接口
 */
export interface FieldOption {
  value: string
  label: string
}

/**
 * 标签设置接口
 */
export interface LabelSettings {
  content: LabelField
  color: string
  fontSize: number
}

/**
 * 预设颜色列表
 */
const PRESET_COLORS = [
  '#000000', // 黑色
  '#ffffff', // 白色
  '#ef4444', // 红色
  '#22c55e', // 绿色
  '#3b82f6', // 蓝色
  '#f59e0b', // 橙色
  '#8b5cf6', // 紫色
  '#06b6d4', // 青色
]

/**
 * 标签设置弹窗组件属性
 */
interface LabelSettingsModalProps {
  /** 是否显示弹窗 */
  isOpen: boolean
  /** 关闭弹窗回调 */
  onClose: () => void
  /** 保存设置回调 */
  onSave: (settings: LabelSettings) => void
  /** 弹窗标题 */
  title: string
  /** 当前设置 */
  currentSettings?: LabelSettings
  /** 可用的字段选项 */
  fieldOptions?: FieldOption[]
  /** 是否正在加载字段 */
  loadingFields?: boolean
}

/**
 * 标签设置弹窗组件
 */
export function LabelSettingsModal({
  isOpen,
  onClose,
  onSave,
  title,
  currentSettings,
  fieldOptions = [],
  loadingFields = false
}: LabelSettingsModalProps) {
  // i18n translation
  const { t } = useTranslation()

  // 内部状态
  const [content, setContent] = useState<LabelField>(currentSettings?.content || fieldOptions[0]?.value || 'name')
  const [color, setColor] = useState(currentSettings?.color || '#000000')
  const [fontSize, setFontSize] = useState(currentSettings?.fontSize || 12)
  const [showCustomColor, setShowCustomColor] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)

  // 当弹窗打开时，重置为当前设置
  useEffect(() => {
    if (isOpen) {
      // 如果有当前设置，使用当前设置；否则使用第一个可用字段
      // 修复：如果content是空字符串，也使用默认值，避免用户意外保存空字符串
      const defaultContent = (currentSettings?.content && currentSettings.content !== '')
        ? currentSettings.content
        : (fieldOptions[0]?.value || 'name')
      setContent(defaultContent)
      setColor(currentSettings?.color || '#000000')
      setFontSize(currentSettings?.fontSize || 12)
      setShowCustomColor(false)
      setShowDropdown(false)
    }
  }, [isOpen, currentSettings, fieldOptions])

  // 保存设置
  const handleSave = () => {
    // 修复：确保content不为空字符串，如果为空则使用默认值
    const validContent = (content && content !== '')
      ? content
      : (fieldOptions[0]?.value || 'name')
    onSave({ content: validContent, color, fontSize })
    onClose()
  }

  // 处理预设颜色点击
  const handlePresetColorClick = (presetColor: string) => {
    setColor(presetColor)
    setShowCustomColor(false)
  }

  // 处理自定义颜色变化
  const handleCustomColorChange = (newColor: string) => {
    setColor(newColor)
  }

  // 获取当前选中字段的显示名称
  const getSelectedFieldLabel = () => {
    const selected = fieldOptions.find(opt => opt.value === content)
    return selected?.label || content
  }

  // 如果弹窗未打开，不渲染任何内容
  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/20"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-lg p-5 w-96"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <X size={14} />
          </button>
        </div>

        {/* 标签内容选择 - 下拉列表 */}
        <div className="mb-4">
          <label className="block text-xs text-muted-foreground mb-2">{t('map.labelContent')}</label>

          {loadingFields ? (
            <div className="w-full px-3 py-2 text-xs border border-border rounded bg-background text-muted-foreground flex items-center gap-2">
              <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span>{t('map.loadingFields')}</span>
            </div>
          ) : (
            <div className="relative">
              {/* 下拉按钮 */}
              <button
                type="button"
                onClick={() => setShowDropdown(!showDropdown)}
                className="w-full px-3 py-2 text-xs border border-border rounded bg-background text-left flex items-center justify-between hover:border-primary/50 transition-colors"
              >
                <span className="truncate">{getSelectedFieldLabel()}</span>
                <ChevronDown size={14} className={`transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
              </button>

              {/* 下拉选项列表 */}
              {showDropdown && (
                <div className="absolute z-10 w-full mt-1 bg-background border border-border rounded shadow-lg max-h-96 overflow-y-auto">
                  {fieldOptions.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      {t('map.noAvailableFields')}
                    </div>
                  ) : (
                    fieldOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          setContent(option.value)
                          setShowDropdown(false)
                        }}
                        className={`w-full px-3 py-2 text-xs text-left hover:bg-muted transition-colors ${option.value === content ? 'bg-primary/10 text-primary' : ''
                          }`}
                      >
                        <span className="block truncate" title={option.label}>
                          {option.label}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 颜色选择 */}
        <div className="mb-4">
          <label className="block text-xs text-muted-foreground mb-2">{t('map.fontColor')}</label>
          <div className="space-y-2">
            {/* 预设颜色 */}
            <div className="flex flex-wrap gap-1.5">
              {PRESET_COLORS.map((presetColor) => (
                <button
                  key={presetColor}
                  onClick={() => handlePresetColorClick(presetColor)}
                  className={`w-6 h-6 rounded border-2 transition-all ${color === presetColor
                    ? 'border-primary ring-1 ring-primary ring-offset-1'
                    : 'border-gray-300 hover:border-gray-400'
                    }`}
                  style={{ backgroundColor: presetColor }}
                  title={presetColor}
                />
              ))}
              {/* 自定义颜色按钮 */}
              <button
                onClick={() => {
                  setShowCustomColor(true)
                }}
                className={`w-6 h-6 rounded border-2 border-gray-300 hover:border-gray-400 flex items-center justify-center transition-all bg-gradient-to-br from-red-500 via-green-500 to-blue-500 ${showCustomColor ? 'ring-1 ring-primary ring-offset-1' : ''
                  }`}
                title={t('map.customColor')}
              >
                <span className="text-white text-xs">+</span>
              </button>
            </div>

            {/* 自定义颜色选择器 */}
            {showCustomColor && (
              <div className="flex items-center gap-2 pt-1">
                <HexColorPicker color={color} onChange={handleCustomColorChange} />
                <input
                  type="text"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="w-20 px-2 py-1 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="#000000"
                />
              </div>
            )}
          </div>
        </div>

        {/* 字体大小 */}
        <div className="mb-4">
          <label className="block text-xs text-muted-foreground mb-2">
            {t('map.fontSizeUnit', { size: fontSize })}
          </label>
          <input
            type="range"
            min="8"
            max="20"
            step="1"
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
          />
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>8px</span>
            <span>20px</span>
          </div>
        </div>

        {/* 按钮组 */}
        <div className="flex gap-2 pt-2">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-2 text-xs bg-muted rounded-lg hover:bg-muted/80 transition-colors"
          >
            {t('map.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={loadingFields}
            className="flex-1 px-3 py-2 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('map.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
