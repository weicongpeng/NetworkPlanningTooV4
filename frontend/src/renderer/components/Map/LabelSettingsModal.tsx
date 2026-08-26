/**
 * 标签设置 / 图层颜色设置 弹窗组件
 *
 * 功能:
 * - 双 Tab：标签设置页 + 图层颜色设置页
 * - 标签设置页：标签内容选择（下拉）、颜色选择器、字体大小
 * - 图层颜色设置页：图形颜色、图形透明度、边框宽度、边框颜色
 * - 保存/取消按钮
 */
import { useState, useEffect, useRef } from 'react'
import { X, ChevronDown, Plus, Trash2, Sparkles } from 'lucide-react'
import { HexColorPicker } from 'react-colorful'
import { useTranslation } from 'react-i18next'
import { hasValue, isNumericValue, toNumber, generateGeoIsolatedColors, THEMATIC_VALUE_LIMIT, FieldValueSample } from '../../utils/fieldValue'

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
 * 图层颜色设置接口
 * - fillColor: 图形颜色（填充色）
 * - fillOpacity: 图形透明度 0~1
 * - borderWidth: 边框宽度 px
 * - borderColor: 边框颜色
 */
export interface LayerColorSettings {
  fillColor: string
  fillOpacity: number
  borderWidth: number
  borderColor: string
}

/**
 * 弹窗标签页类型
 */
export type SettingsTab = 'label' | 'color'

/**
 * 专题图层字段类型
 */
export type ThematicFieldType = 'numeric' | 'text'

/**
 * 数值字段配色模式：区间配色 / 属性值配色
 */
export type ThematicColorMode = 'range' | 'value'

/**
 * 数值区间（区间语义：min 含、max 不含；最后一区间 max 含）
 */
export interface ThematicRange {
  min: number
  max: number
  color: string
}

/**
 * 文本类配色条目
 */
export interface ThematicCategory {
  value: string
  color: string
}

/**
 * 专题图层设置
 * - enabled: 是否启用（与基础配置互斥：启用后基础配置不生效）
 * - field: 属性字段名
 * - fieldType: 字段类型（自动检测）
 * - colorMode: 数值字段配色模式（'range' 区间配色 / 'value' 属性值配色）
 * - pointSize: 图形大小（点要素半径，仅点图层生效）
 * - ranges: 数值类连续区间（重叠取首个匹配，未匹配落黑）
 * - valueColors: 数值类属性值配色（colorMode='value' 时使用，未分配的值黑色）
 * - categories: 文本类配色
 */
export interface ThematicSettings {
  enabled: boolean
  field: string
  fieldType: ThematicFieldType
  colorMode?: ThematicColorMode
  pointSize: number
  ranges: ThematicRange[]
  valueColors?: ThematicCategory[]
  categories: ThematicCategory[]
  /** 图例是否显示每个区间的元素个数与占比（默认 true） */
  showStats?: boolean
}

/**
 * 专题区间配色模板（可持久化保存/删除/复用）
 */
export interface ThematicTemplate {
  id: string
  name: string
  ranges: ThematicRange[]
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
  /** 保存标签设置回调 */
  onSave: (settings: LabelSettings) => void
  /** 弹窗标题 */
  title: string
  /** 当前标签设置 */
  currentSettings?: LabelSettings
  /** 可用的字段选项 */
  fieldOptions?: FieldOption[]
  /** 是否正在加载字段 */
  loadingFields?: boolean
  /** 当前激活标签页 */
  activeTab?: SettingsTab
  /** 标签页切换回调 */
  onTabChange?: (tab: SettingsTab) => void
  /** 当前图层颜色设置 */
  currentColorSettings?: LayerColorSettings
  /** 保存图层颜色设置回调 */
  onSaveColor?: (settings: LayerColorSettings) => void
  /** 是否显示专题图层子页（仅 layer-file 类型图层） */
  showThematicTab?: boolean
  /** 当前专题图层设置 */
  currentThematicSettings?: ThematicSettings | null
  /** 保存专题图层设置回调（null 表示关闭专题） */
  onSaveThematic?: (settings: ThematicSettings | null) => void
  /** 字段值样本（字段 → 样本值数组，用于类型检测/推荐区间/唯一值列表） */
  thematicFieldSamples?: Record<string, FieldValueSample[]>
  /** 是否正在加载字段样本 */
  loadingThematicSamples?: boolean
  /** 打开弹窗时颜色设置页的初始子页（默认基础配置） */
  initialColorSubTab?: 'basic' | 'thematic'
  /** 图层几何类型（决定"图形大小"设置的语义：点→图形大小 / 面→边框宽度 / 线→线宽） */
  thematicGeometryType?: 'point' | 'line' | 'polygon' | 'sector'
  /** 扇区图层颜色模式：默认设置按频点区分颜色，不提供图形颜色/边框颜色设置项，仅保留透明度/边框宽度 */
  sectorColorMode?: boolean
  /** 已保存的区间配色模板列表 */
  thematicTemplates?: ThematicTemplate[]
  /** 保存区间配色模板回调 */
  onSaveThematicTemplate?: (name: string, ranges: ThematicRange[]) => void
  /** 删除区间配色模板回调 */
  onRemoveThematicTemplate?: (id: string) => void
}

/**
 * 专题图层预设色带（推荐默认区间/色块面板用，红→黄→青→绿→深绿）
 */
const THEMATIC_PALETTE = ['#FF0000', '#FFFF00', '#00FFFF', '#00FF00', '#006400']

/**
 * 根据样本值生成推荐数值区间（等分 5 段，边界取整为整数）
 */
function buildRecommendedRanges(samples: FieldValueSample[]): ThematicRange[] {
  const nums = samples.map(s => toNumber(s.v)).filter((n): n is number => n !== null)
  if (nums.length === 0) return []
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  if (min === max) {
    // 所有值相同：单区间
    return [{ min, max, color: THEMATIC_PALETTE[0] }]
  }
  const span = max - min
  const ranges: ThematicRange[] = []
  let prevMax = min
  // 前 4 段：边界取整，空段跳过（保证连续无遗漏）
  for (let i = 0; i < 4; i++) {
    const segMax = Math.round(min + (span * (i + 1)) / 5)
    if (segMax > prevMax) {
      ranges.push({ min: prevMax, max: segMax, color: THEMATIC_PALETTE[ranges.length % THEMATIC_PALETTE.length] })
      prevMax = segMax
    }
  }
  // 末段：取整后保证覆盖到最大值
  const lastMax = Math.max(Math.round(max), prevMax + 1)
  ranges.push({ min: prevMax, max: lastMax, color: THEMATIC_PALETTE[ranges.length % THEMATIC_PALETTE.length] })
  return ranges
}

/**
 * 根据样本值生成文本配色（去重排序，前 20 个 + 其余归入"其他"黑色）
 */
function buildCategoryColors(samples: FieldValueSample[]): { categories: ThematicCategory[] } {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const s of samples) {
    if (!hasValue(s.v)) continue
    const key = String(s.v)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(key)
  }
  unique.sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const hasOthers = unique.length > 20
  const top = unique.slice(0, 20)
  const categories = top.map((value, i) => ({ value, color: THEMATIC_PALETTE[i % THEMATIC_PALETTE.length] }))
  if (hasOthers) {
    // 超出极限配色的值统一黑色
    categories.push({ value: '__other__', color: '#000000' })
  }
  return { categories }
}

/**
 * 检测字段类型：样本全部可转数字 → 数值类，否则文本类
 */
function detectFieldType(samples: FieldValueSample[] | undefined): ThematicFieldType | null {
  if (!samples || samples.length === 0) return null
  // 至少一个有效值，且所有有效值均可转数字 → 数值类
  let hasValid = false
  for (const s of samples) {
    if (!hasValue(s.v)) continue
    hasValid = true
    if (!isNumericValue(s.v)) return 'text'
  }
  return hasValid ? 'numeric' : null
}

/**
 * 整数区间输入框
 * - 仅允许整数（含负号）：非法字符即时过滤并纠正 DOM
 * - 内部字符串状态：可完全删除为空，不会自动回填 0
 */
function IntInput({ value, onChange, className }: { value: number; onChange: (v: number) => void; className?: string }) {
  const [text, setText] = useState(String(value))

  // 外部值变化时同步；用户删除为空（仍在编辑）时不回填
  useEffect(() => {
    setText(prev => (prev === '' ? prev : String(value)))
  }, [value])

  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        // 只保留数字与（仅开头位置的）负号，非法字符即时过滤
        let cleaned = e.target.value.replace(/[^\d-]/g, '')
        if (cleaned.startsWith('-')) {
          cleaned = '-' + cleaned.slice(1).replace(/-/g, '')
        } else {
          cleaned = cleaned.replace(/-/g, '')
        }
        setText(cleaned)
        if (cleaned !== '' && cleaned !== '-') {
          const num = Number(cleaned)
          if (Number.isFinite(num)) onChange(num)
        }
      }}
      className={className}
    />
  )
}

/**
 * 专题色块选择器 - 单色块 + 点击弹出面板（预设 5 色 + 自定义色板）
 */
function ColorSwatch({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-7 h-7 rounded border-2 border-gray-300 hover:border-gray-400 transition-all flex items-center justify-center"
        style={{ backgroundColor: value }}
        title={value}
      >
        {open && (
          <span className="w-3 h-3 rounded-full border border-white/60 shadow" />
        )}
      </button>
      {open && (
        <div
          className="absolute right-0 z-30 mt-1 p-2 bg-background border border-border rounded-lg shadow-lg w-52"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 预设色块 */}
          <div className="flex flex-wrap gap-1.5 mb-2">
            {THEMATIC_PALETTE.map((presetColor) => (
              <button
                key={presetColor}
                onClick={() => { onChange(presetColor); setOpen(false) }}
                className={`w-6 h-6 rounded border-2 transition-all ${value.toLowerCase() === presetColor.toLowerCase()
                  ? 'border-primary ring-1 ring-primary ring-offset-1'
                  : 'border-gray-300 hover:border-gray-400'
                  }`}
                style={{ backgroundColor: presetColor }}
                title={presetColor}
              />
            ))}
          </div>
          {/* 自定义色板 */}
          <HexColorPicker color={value} onChange={onChange} />
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full mt-2 px-2 py-1 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="#000000"
            title={t('map.customColor')}
          />
        </div>
      )}
    </div>
  )
}

/**
 * 颜色选择器组件 - 预设颜色 + 自定义色板（复用，保证两处颜色设置风格一致）
 */
function ColorField({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const { t } = useTranslation()
  const [showCustomColor, setShowCustomColor] = useState(false)

  return (
    <div className="space-y-2">
      {/* 预设颜色 */}
      <div className="flex flex-wrap gap-1.5">
        {PRESET_COLORS.map((presetColor) => (
          <button
            key={presetColor}
            onClick={() => { onChange(presetColor); setShowCustomColor(false) }}
            className={`w-6 h-6 rounded border-2 transition-all ${value === presetColor
              ? 'border-primary ring-1 ring-primary ring-offset-1'
              : 'border-gray-300 hover:border-gray-400'
              }`}
            style={{ backgroundColor: presetColor }}
            title={presetColor}
          />
        ))}
        {/* 自定义颜色按钮 */}
        <button
          onClick={() => setShowCustomColor(true)}
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
          <HexColorPicker color={value} onChange={onChange} />
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-20 px-2 py-1 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="#000000"
          />
        </div>
      )}
    </div>
  )
}

/**
 * 专题页字段下拉组件（独立展开状态，避免与标签页下拉互相干扰）
 */
function ThematicFieldDropdown({
  options,
  value,
  onChange,
  emptyText
}: {
  options: FieldOption[]
  value: string
  onChange: (value: string) => void
  emptyText: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find(opt => opt.value === value)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 text-xs border border-border rounded bg-background text-left flex items-center justify-between hover:border-primary/50 transition-colors"
      >
        <span className="truncate">{selected?.label || value || emptyText}</span>
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-10 w-full mt-1 bg-background border border-border rounded shadow-lg max-h-96 overflow-y-auto">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">{emptyText}</div>
          ) : (
            options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
                className={`w-full px-3 py-2 text-xs text-left hover:bg-muted transition-colors ${option.value === value ? 'bg-primary/10 text-primary' : ''
                  }`}
              >
                <span className="block truncate" title={option.label}>{option.label}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
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
  loadingFields = false,
  activeTab = 'label',
  onTabChange,
  currentColorSettings,
  onSaveColor,
  showThematicTab = false,
  currentThematicSettings,
  onSaveThematic,
  thematicFieldSamples = {},
  loadingThematicSamples = false,
  initialColorSubTab = 'basic',
  thematicGeometryType = 'point',
  sectorColorMode = false,
  thematicTemplates = [],
  onSaveThematicTemplate,
  onRemoveThematicTemplate
}: LabelSettingsModalProps) {
  // i18n translation
  const { t } = useTranslation()

  // 内部状态 - 标签设置
  const [content, setContent] = useState<LabelField>(currentSettings?.content || fieldOptions[0]?.value || 'name')
  const [color, setColor] = useState(currentSettings?.color || '#000000')
  const [fontSize, setFontSize] = useState(currentSettings?.fontSize || 12)
  const [showDropdown, setShowDropdown] = useState(false)

  // 内部状态 - 图层颜色设置
  const [fillColor, setFillColor] = useState(currentColorSettings?.fillColor || '#3b82f6')
  const [fillOpacityPct, setFillOpacityPct] = useState(Math.round((currentColorSettings?.fillOpacity ?? 0.6) * 100))
  const [borderWidth, setBorderWidth] = useState(currentColorSettings?.borderWidth || 2)
  const [borderColor, setBorderColor] = useState(currentColorSettings?.borderColor || '#000000')

  // 内部状态 - 专题图层设置
  const [colorSubTab, setColorSubTab] = useState<'basic' | 'thematic'>('basic')
  const [thematicEnabled, setThematicEnabled] = useState(false)
  const [thematicField, setThematicField] = useState('')
  const [thematicFieldType, setThematicFieldType] = useState<ThematicFieldType | null>(null)
  const [thematicColorMode, setThematicColorMode] = useState<ThematicColorMode>('range')
  const [thematicRanges, setThematicRanges] = useState<ThematicRange[]>([])
  const [thematicValueColors, setThematicValueColors] = useState<ThematicCategory[]>([])
  const [thematicCategories, setThematicCategories] = useState<ThematicCategory[]>([])
  const [thematicPointSize, setThematicPointSize] = useState(8)
  // 图例是否显示元素个数与占比统计
  const [thematicShowStats, setThematicShowStats] = useState(true)
  // 模板 UI 状态
  const [templateName, setTemplateName] = useState('')
  const [templateDropdownOpen, setTemplateDropdownOpen] = useState(false)

  // 几何类型 → 尺寸设置语义：点=图形大小(半径)，面/扇区=边框宽度，线=线宽
  const isPointType = thematicGeometryType === 'point'
  const sizeMin = isPointType ? 3 : 1
  const sizeMax = isPointType ? 20 : 8

  // 当弹窗打开时，重置为当前设置（仅在打开瞬间初始化一次，
  // 依赖仅 isOpen：字段选项异步加载等 props 变化不会重置用户正在进行的操作）
  const prevIsOpenRef = useRef(false)
  useEffect(() => {
    const wasOpen = prevIsOpenRef.current
    prevIsOpenRef.current = isOpen
    if (!isOpen || wasOpen) return
      // 标签设置
      const defaultContent = (currentSettings?.content && currentSettings.content !== '')
        ? currentSettings.content
        : (fieldOptions[0]?.value || 'name')
      setContent(defaultContent)
      setColor(currentSettings?.color || '#000000')
      setFontSize(currentSettings?.fontSize || 12)
      setShowDropdown(false)

      // 图层颜色设置
      setFillColor(currentColorSettings?.fillColor || '#3b82f6')
      setFillOpacityPct(Math.round((currentColorSettings?.fillOpacity ?? 0.6) * 100))
      setBorderWidth(currentColorSettings?.borderWidth || 2)
      setBorderColor(currentColorSettings?.borderColor || '#000000')

      // 专题图层设置
      setColorSubTab(initialColorSubTab)
      const ts = currentThematicSettings
      if (ts && ts.enabled) {
        setThematicEnabled(true)
        setThematicField(ts.field || fieldOptions[0]?.value || '')
        setThematicFieldType(ts.fieldType)
        setThematicColorMode(ts.colorMode === 'value' ? 'value' : 'range')
        setThematicRanges(ts.ranges || [])
        setThematicValueColors(ts.valueColors || [])
        setThematicCategories(ts.categories || [])
        setThematicPointSize(ts.pointSize || (isPointType ? 8 : 2))
        setThematicShowStats(ts.showStats !== false)
      } else {
        setThematicEnabled(false)
        setThematicField(fieldOptions[0]?.value || '')
        setThematicFieldType(null)
        setThematicColorMode('range')
        setThematicRanges([])
        setThematicValueColors([])
        setThematicCategories([])
        setThematicPointSize(isPointType ? 8 : 2)
        setThematicShowStats(true)
      }
      setTemplateName('')
      setTemplateDropdownOpen(false)
  }, [isOpen])

  /**
   * 字段选项加载完成后：若用户尚未选择字段，自动选择第一个并生成推荐配置
   * （仅在未选择时触发，不会重置用户正在进行的操作）
   */
  useEffect(() => {
    if (!isOpen) return
    if (thematicField === '' && fieldOptions.length > 0) {
      handleThematicFieldChange(fieldOptions[0].value)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldOptions, isOpen])

  /**
   * 样本异步加载完成后：若已启用专题但字段类型尚未检测（用户操作早于样本到达），
   * 自动补检测并生成推荐配置
   */
  useEffect(() => {
    if (!isOpen || !thematicEnabled) return
    if (thematicFieldType === null && thematicField && thematicFieldSamples[thematicField]) {
      handleThematicFieldChange(thematicField)
      return
    }
    // 属性值配色：样本就绪后若存在未配置的值（旧版本截断产物/旧保存数据），补全配色
    if (thematicFieldType === 'numeric' && thematicColorMode === 'value' && thematicField) {
      const samples = thematicFieldSamples[thematicField]
      if (samples && samples.length > 0 && samples.length <= THEMATIC_VALUE_LIMIT) {
        const missing = getUncoveredValues(samples, thematicValueColors)
        if (missing.length > 0) {
          const colors = generateGeoIsolatedColors(thematicValueColors.length + missing.length)
          setThematicValueColors(prev => [
            ...prev,
            ...missing.map((v, i) => ({ value: v, color: colors[prev.length + i] }))
          ])
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thematicFieldSamples, isOpen, thematicEnabled])

  /**
   * 生成属性值配色（上限 100 个；按质心空间位置排序 + 黄金角色相，
   * 使地理相邻的属性值分配差异大的颜色，避免相邻位置同色）
   */
  const buildValueColors = (samples: FieldValueSample[]): ThematicCategory[] => {
    // 按值聚合质心
    const agg = new Map<string, { latSum: number; lngSum: number; count: number }>()
    const order: string[] = []
    for (const s of samples) {
      const key = String(s.v)
      if (!agg.has(key)) {
        agg.set(key, { latSum: 0, lngSum: 0, count: 0 })
        order.push(key)
      }
      const a = agg.get(key)!
      a.latSum += s.lat
      a.lngSum += s.lng
      a.count++
    }
    const values = order.map(key => {
      const a = agg.get(key)!
      return { key, lat: a.count > 0 ? a.latSum / a.count : 0, lng: a.count > 0 ? a.lngSum / a.count : 0 }
    })
    // 按质心空间位置排序（经度优先，近似空间邻近 → 排序相邻）
    values.sort((a, b) => a.lng - b.lng || a.lat - b.lat)
    // 极限配色范围：100 个，其余值渲染为黑色
    const top = values.slice(0, THEMATIC_VALUE_LIMIT)
    const colors = generateGeoIsolatedColors(top.length)
    return top.map((item, i) => ({ value: item.key, color: colors[i] }))
  }

  /**
   * 字段选择变化：重置区间/配色，并按样本自动生成推荐配置
   */
  /**
   * 计算未覆盖配色的字段值（用于提示：这些值将按黑色渲染）
   * 存在 '__other__' 兜底时视为已涵盖，不提示
   */
  const getUncoveredValues = (samples: FieldValueSample[] | undefined, configured: ThematicCategory[]): string[] => {
    if (!samples || samples.length === 0) return []
    if (configured.some(c => c.value === '__other__')) return []
    const configuredSet = new Set(configured.filter(c => c.value !== '__other__').map(c => c.value))
    const uncovered: string[] = []
    const seen = new Set<string>()
    for (const s of samples) {
      const key = String(s.v)
      if (seen.has(key)) continue
      seen.add(key)
      if (!configuredSet.has(key)) uncovered.push(key)
    }
    return uncovered
  }

  const handleThematicFieldChange = (field: string) => {
    setThematicField(field)
    setThematicRanges([])
    setThematicValueColors([])
    setThematicCategories([])
    const samples = thematicFieldSamples[field]
    const detected = detectFieldType(samples)
    setThematicFieldType(detected)
    if (detected === 'numeric' && samples) {
      if (thematicColorMode === 'value') {
        setThematicValueColors(buildValueColors(samples))
      } else {
        setThematicRanges(buildRecommendedRanges(samples))
      }
    } else if (detected === 'text' && samples) {
      setThematicCategories(buildCategoryColors(samples).categories)
    }
  }

  // 保存设置（根据当前标签页决定保存哪个）
  const handleSave = () => {
    if (activeTab === 'color') {
      const settings: LayerColorSettings = {
        fillColor,
        fillOpacity: fillOpacityPct / 100,
        borderWidth,
        borderColor
      }
      // 总是同时保存基础配置与专题配置（两套独立存储，互不覆盖）
      onSaveColor?.(settings)
      if (showThematicTab) {
        if (thematicEnabled && thematicField && thematicFieldType) {
          const ts: ThematicSettings = {
            enabled: true,
            field: thematicField,
            fieldType: thematicFieldType,
            colorMode: thematicFieldType === 'numeric' ? thematicColorMode : undefined,
            pointSize: thematicPointSize,
            showStats: thematicShowStats,
            ranges: thematicRanges,
            valueColors: thematicFieldType === 'numeric' && thematicColorMode === 'value' ? thematicValueColors : [],
            categories: thematicCategories
          }
          onSaveThematic?.(ts)
        } else {
          onSaveThematic?.(null)
        }
      }
    } else {
      // 修复：确保content不为空字符串，如果为空则使用默认值
      const validContent = (content && content !== '')
        ? content
        : (fieldOptions[0]?.value || 'name')
      onSave({ content: validContent, color, fontSize })
    }
    onClose()
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
        className="bg-card border border-border rounded-lg shadow-lg p-5 w-[420px] h-[640px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <X size={14} />
          </button>
        </div>

        {/* 内容区 - 固定高度内滚动 */}
        <div className="flex-1 overflow-y-auto min-h-0 pr-1">
        {/* 标签页切换 */}
        <div className="flex gap-1 mb-4 p-1 bg-muted/60 rounded-lg">
          <button
            type="button"
            onClick={() => onTabChange?.('label')}
            className={`flex-1 px-3 py-1.5 text-xs rounded-md transition-colors font-medium ${activeTab === 'label'
              ? 'bg-background text-primary shadow-sm border border-border'
              : 'text-muted-foreground hover:text-foreground'
              }`}
          >
            {t('map.labelSettingsTab')}
          </button>
          <button
            type="button"
            onClick={() => onTabChange?.('color')}
            className={`flex-1 px-3 py-1.5 text-xs rounded-md transition-colors font-medium ${activeTab === 'color'
              ? 'bg-background text-primary shadow-sm border border-border'
              : 'text-muted-foreground hover:text-foreground'
              }`}
          >
            {t('map.colorSettings')}
          </button>
        </div>

        {/* ===== 标签设置页 ===== */}
        {activeTab === 'label' && (
          <>
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
              <ColorField value={color} onChange={setColor} />
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
          </>
        )}

        {/* ===== 图层颜色设置页 ===== */}
        {activeTab === 'color' && (
          <>
            {/* 子页切换：基础配置 / 专题图层（图层文件类与扇区类） */}
            {showThematicTab && (
              <div className="flex gap-1 mb-4 p-1 bg-muted/60 rounded-lg">
                <button
                  type="button"
                  onClick={() => setColorSubTab('basic')}
                  className={`flex-1 px-3 py-1.5 text-xs rounded-md transition-colors font-medium ${colorSubTab === 'basic'
                    ? 'bg-background text-primary shadow-sm border border-border'
                    : 'text-muted-foreground hover:text-foreground'
                    }`}
                >
                  {sectorColorMode ? t('map.defaultSettings') : t('map.thematicBasicTab')}
                </button>
                <button
                  type="button"
                  onClick={() => setColorSubTab('thematic')}
                  className={`flex-1 px-3 py-1.5 text-xs rounded-md transition-colors font-medium ${colorSubTab === 'thematic'
                    ? 'bg-background text-primary shadow-sm border border-border'
                    : 'text-muted-foreground hover:text-foreground'
                    }`}
                >
                  {t('map.thematicLayer')}
                </button>
              </div>
            )}

            {/* ===== 基础配置子页 ===== */}
            {colorSubTab === 'basic' && (
              <div className={thematicEnabled ? 'opacity-50 pointer-events-none select-none' : ''}>
                {thematicEnabled && (
                  <div className="mb-3 px-3 py-2 text-xs rounded bg-amber-50 border border-amber-200 text-amber-700">
                    {t('map.thematicActiveHint')}
                  </div>
                )}
                {/* 图形颜色（填充色）- 扇区图层默认按频点区分颜色，不提供图形颜色设置项 */}
                {!sectorColorMode && (
                  <div className="mb-4">
                    <label className="block text-xs text-muted-foreground mb-2">{t('map.fillColor')}</label>
                    <ColorField value={fillColor} onChange={setFillColor} />
                  </div>
                )}

                {/* 图形透明度 */}
                <div className="mb-4">
                  <label className="block text-xs text-muted-foreground mb-2">
                    {t('map.fillOpacityUnit', { value: fillOpacityPct })}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={fillOpacityPct}
                    onChange={(e) => setFillOpacityPct(Number(e.target.value))}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground mt-1">
                    <span>0%</span>
                    <span>100%</span>
                  </div>
                </div>

                {/* 边框宽度 */}
                <div className="mb-4">
                  <label className="block text-xs text-muted-foreground mb-2">
                    {t('map.borderWidthUnit', { size: borderWidth })}
                  </label>
                  <input
                    type="range"
                    min="1"
                    max="8"
                    step="1"
                    value={borderWidth}
                    onChange={(e) => setBorderWidth(Number(e.target.value))}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground mt-1">
                    <span>1px</span>
                    <span>8px</span>
                  </div>
                </div>

                {/* 边框颜色 - 扇区图层默认按频点区分颜色，不提供边框颜色设置项 */}
                {!sectorColorMode && (
                  <div className="mb-4">
                    <label className="block text-xs text-muted-foreground mb-2">{t('map.borderColor')}</label>
                    <ColorField value={borderColor} onChange={setBorderColor} />
                  </div>
                )}
              </div>
            )}

            {/* ===== 专题图层子页 ===== */}
            {showThematicTab && colorSubTab === 'thematic' && (
              <div className="space-y-4">
                {/* 启用开关 */}
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">{t('map.thematicEnable')}</label>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !thematicEnabled
                      setThematicEnabled(next)
                      // 启用时若当前字段尚未检测类型，立即按样本生成推荐配置
                      if (next && thematicFieldType === null && thematicField) {
                        handleThematicFieldChange(thematicField)
                      }
                    }}
                    className={`relative w-9 h-5 rounded-full transition-colors ${thematicEnabled ? 'bg-primary' : 'bg-gray-300'}`}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${thematicEnabled ? 'left-[18px]' : 'left-0.5'}`}
                    />
                  </button>
                </div>

                {!thematicEnabled && (
                  <div className="px-3 py-2 text-xs rounded bg-muted/50 text-muted-foreground">
                    {t('map.thematicDisabledHint')}
                  </div>
                )}

                {thematicEnabled && (
                  <>
                    {/* 属性字段下拉 */}
                    <div>
                      <label className="block text-xs text-muted-foreground mb-2">{t('map.thematicField')}</label>
                      {loadingThematicSamples ? (
                        <div className="w-full px-3 py-2 text-xs border border-border rounded bg-background text-muted-foreground flex items-center gap-2">
                          <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 4.824 3 7.938l3-2.647z"></path>
                          </svg>
                          <span>{t('map.loadingFields')}</span>
                        </div>
                      ) : (
                        <ThematicFieldDropdown
                          options={fieldOptions}
                          value={thematicField}
                          onChange={handleThematicFieldChange}
                          emptyText={t('map.noAvailableFields')}
                        />
                      )}
                    </div>

                    {/* 字段类型提示 */}
                    {thematicFieldType && (
                      <div className="text-xs text-muted-foreground">
                        {thematicFieldType === 'numeric'
                          ? t('map.thematicNumericType')
                          : t('map.thematicTextType')}
                      </div>
                    )}

                    {/* 图例统计开关（区间/属性值/文本配色均适用） */}
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-muted-foreground">{t('map.thematicShowStats')}</label>
                      <button
                        type="button"
                        onClick={() => setThematicShowStats(!thematicShowStats)}
                        className={`relative w-9 h-5 rounded-full transition-colors ${thematicShowStats ? 'bg-primary' : 'bg-gray-300'}`}
                      >
                        <span
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${thematicShowStats ? 'left-[18px]' : 'left-0.5'}`}
                        />
                      </button>
                    </div>

                    {/* 数值类：区间配置 / 属性值配色 */}
                    {thematicFieldType === 'numeric' && (
                      <>
                        {/* 配色模式切换 */}
                        <div className="flex gap-1 p-1 bg-muted/60 rounded-lg">
                          <button
                            type="button"
                            onClick={() => {
                              setThematicColorMode('range')
                              if (thematicRanges.length === 0) {
                                const samples = thematicFieldSamples[thematicField]
                                if (samples) setThematicRanges(buildRecommendedRanges(samples))
                              }
                            }}
                            className={`flex-1 px-3 py-1.5 text-xs rounded-md transition-colors font-medium ${thematicColorMode === 'range'
                              ? 'bg-background text-primary shadow-sm border border-border'
                              : 'text-muted-foreground hover:text-foreground'
                              }`}
                          >
                            {t('map.thematicModeRange')}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setThematicColorMode('value')
                              if (thematicValueColors.length === 0) {
                                const samples = thematicFieldSamples[thematicField]
                                if (samples) setThematicValueColors(buildValueColors(samples))
                              }
                            }}
                            className={`flex-1 px-3 py-1.5 text-xs rounded-md transition-colors font-medium ${thematicColorMode === 'value'
                              ? 'bg-background text-primary shadow-sm border border-border'
                              : 'text-muted-foreground hover:text-foreground'
                              }`}
                          >
                            {t('map.thematicModeValue')}
                          </button>
                        </div>

                        {/* ===== 区间配色模式 ===== */}
                        {thematicColorMode === 'range' && (
                          <>
                            <div className="flex items-center justify-between">
                              <label className="text-xs text-muted-foreground">{t('map.thematicRanges')}</label>
                              <button
                                type="button"
                                onClick={() => {
                                  const samples = thematicFieldSamples[thematicField]
                                  if (samples) setThematicRanges(buildRecommendedRanges(samples))
                                }}
                                className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                              >
                                <Sparkles size={12} />
                                {t('map.thematicRecommend')}
                              </button>
                            </div>
                            <div className="space-y-2">
                              {thematicRanges.map((r, i) => (
                                <div key={i} className="flex items-center gap-1.5">
                                  <IntInput
                                    value={r.min}
                                    onChange={(v) => {
                                      const next = [...thematicRanges]
                                      next[i] = { ...next[i], min: v }
                                      setThematicRanges(next)
                                    }}
                                    className="w-16 px-1.5 py-1 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                                  />
                                  <span className="text-xs text-muted-foreground">~</span>
                                  <IntInput
                                    value={r.max}
                                    onChange={(v) => {
                                      const next = [...thematicRanges]
                                      next[i] = { ...next[i], max: v }
                                      setThematicRanges(next)
                                    }}
                                    className="w-16 px-1.5 py-1 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                                  />
                                  <div className="flex-1 flex justify-center">
                                    <ColorSwatch value={r.color} onChange={(c) => {
                                      const next = [...thematicRanges]
                                      next[i] = { ...next[i], color: c }
                                      setThematicRanges(next)
                                    }} />
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setThematicRanges(thematicRanges.filter((_, j) => j !== i))}
                                    className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600 transition-colors"
                                    title={t('map.thematicRemoveRange')}
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              ))}
                              <button
                                type="button"
                                onClick={() => {
                                  const last = thematicRanges[thematicRanges.length - 1]
                                  const max = last ? last.max : 0
                                  setThematicRanges([...thematicRanges, { min: max, max: max + 1, color: THEMATIC_PALETTE[0] }])
                                }}
                                className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border hover:bg-muted transition-colors"
                              >
                                <Plus size={12} />
                                {t('map.thematicAddRange')}
                              </button>
                            </div>

                            {/* 区间配色模板 */}
                            <div className="pt-1 border-t border-border/60">
                              <label className="block text-xs text-muted-foreground mb-2">{t('map.thematicTemplate')}</label>
                              <div className="flex items-center gap-1.5 mb-2">
                                <input
                                  type="text"
                                  value={templateName}
                                  onChange={(e) => setTemplateName(e.target.value)}
                                  placeholder={t('map.thematicTemplateName')}
                                  className="flex-1 px-2 py-1 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    const name = templateName.trim()
                                    if (!name) return
                                    if (thematicRanges.length === 0) return
                                    onSaveThematicTemplate?.(name, thematicRanges)
                                    setTemplateName('')
                                  }}
                                  className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                                >
                                  <Plus size={12} />
                                  {t('map.thematicTemplateSave')}
                                </button>
                              </div>
                              {thematicTemplates.length > 0 && (
                                <div className="relative">
                                  <button
                                    type="button"
                                    onClick={() => setTemplateDropdownOpen(!templateDropdownOpen)}
                                    className="w-full px-2 py-1.5 text-xs border border-border rounded bg-background text-left flex items-center justify-between hover:border-primary/50 transition-colors"
                                  >
                                    <span className="truncate">{t('map.thematicTemplateApply')}</span>
                                    <ChevronDown size={14} className={`transition-transform ${templateDropdownOpen ? 'rotate-180' : ''}`} />
                                  </button>
                                  {templateDropdownOpen && (
                                    <div className="absolute z-20 w-full mt-1 bg-background border border-border rounded shadow-lg max-h-48 overflow-y-auto">
                                      {thematicTemplates.map((tmpl) => (
                                        <div key={tmpl.id} className="flex items-center px-2 py-1.5 hover:bg-muted transition-colors group">
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setThematicRanges(JSON.parse(JSON.stringify(tmpl.ranges)))
                                              setTemplateDropdownOpen(false)
                                            }}
                                            className="flex-1 text-left text-xs truncate"
                                            title={tmpl.name}
                                          >
                                            {tmpl.name}
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => onRemoveThematicTemplate?.(tmpl.id)}
                                            className="p-1 rounded hover:bg-red-50 text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                            title={t('map.thematicTemplateDelete')}
                                          >
                                            <Trash2 size={12} />
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </>
                        )}

                        {/* ===== 属性值配色模式 ===== */}
                        {thematicColorMode === 'value' && (
                          <div className="space-y-2">
                            <label className="block text-xs text-muted-foreground">
                              {t('map.thematicValueColors')}
                            </label>
                            {thematicValueColors.length === 0 && (
                              <div className="px-3 py-2 text-xs rounded bg-muted/50 text-muted-foreground">
                                {t('map.thematicNoSamples')}
                              </div>
                            )}
                            {thematicValueColors.map((c, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <span
                                  className="flex-1 truncate px-2 py-1 text-xs rounded border border-border bg-background"
                                  title={c.value}
                                >
                                  {c.value}
                                </span>
                                <ColorSwatch value={c.color} onChange={(color) => {
                                  const next = [...thematicValueColors]
                                  next[i] = { ...next[i], color }
                                  setThematicValueColors(next)
                                }} />
                                <button
                                  type="button"
                                  onClick={() => setThematicValueColors(thematicValueColors.filter((_, j) => j !== i))}
                                  className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600 transition-colors"
                                  title={t('map.thematicRemoveRange')}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            ))}
                            {/* 未覆盖配色提示（区分：超限未分配 / 用户删减未配置） */}
                            {thematicValueColors.length > 0 && (() => {
                              const samples = thematicFieldSamples[thematicField]
                              const uncovered = getUncoveredValues(samples, thematicValueColors)
                              if (uncovered.length === 0) return null
                              // 统计样本唯一值总数判断是否超限
                              const totalValues = new Set((samples || []).map(s => String(s.v))).size
                              if (totalValues > THEMATIC_VALUE_LIMIT) {
                                return (
                                  <div className="px-3 py-2 text-xs rounded bg-amber-50 border border-amber-200 text-amber-700">
                                    {t('map.thematicValueOverLimitHint', {
                                      total: totalValues,
                                      limit: THEMATIC_VALUE_LIMIT,
                                      count: uncovered.length,
                                      values: uncovered.slice(0, 8).join('、')
                                    })}
                                  </div>
                                )
                              }
                              return (
                                <div className="px-3 py-2 text-xs rounded bg-amber-50 border border-amber-200 text-amber-700">
                                  {t('map.thematicUncoveredHint', {
                                    count: uncovered.length,
                                    values: uncovered.slice(0, 8).join('、')
                                  })}
                                </div>
                              )
                            })()}
                            <div className="px-3 py-2 text-xs rounded bg-muted/50 text-muted-foreground">
                              {t('map.thematicValueLimitHint', { limit: THEMATIC_VALUE_LIMIT })}
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {/* 文本类：不同文本值配色 */}
                    {thematicFieldType === 'text' && (
                      <div className="space-y-2">
                        <label className="block text-xs text-muted-foreground">{t('map.thematicCategories')}</label>
                        {thematicCategories.length === 0 && (
                          <div className="px-3 py-2 text-xs rounded bg-muted/50 text-muted-foreground">
                            {t('map.thematicNoSamples')}
                          </div>
                        )}
                        {thematicCategories.map((c, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <span
                              className="flex-1 truncate px-2 py-1 text-xs rounded border border-border bg-background"
                              title={c.value}
                            >
                              {c.value === '__other__' ? t('map.thematicOthers') : c.value}
                            </span>
                            <ColorSwatch value={c.color} onChange={(color) => {
                              const next = [...thematicCategories]
                              next[i] = { ...next[i], color }
                              setThematicCategories(next)
                            }} />
                            {c.value !== '__other__' && (
                              <button
                                type="button"
                                onClick={() => setThematicCategories(thematicCategories.filter((_, j) => j !== i))}
                                className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600 transition-colors"
                                title={t('map.thematicRemoveRange')}
                              >
                                <Trash2 size={12} />
                              </button>
                            )}
                          </div>
                        ))}
                        {/* 未覆盖配色提示 */}
                        {thematicCategories.length > 0 && getUncoveredValues(thematicFieldSamples[thematicField], thematicCategories).length > 0 && (
                          <div className="px-3 py-2 text-xs rounded bg-amber-50 border border-amber-200 text-amber-700">
                            {t('map.thematicUncoveredHint', {
                              count: getUncoveredValues(thematicFieldSamples[thematicField], thematicCategories).length,
                              values: getUncoveredValues(thematicFieldSamples[thematicField], thematicCategories).slice(0, 8).join('、')
                            })}
                          </div>
                        )}
                      </div>
                    )}

                        {/* 尺寸设置（点=图形大小 / 面=边框宽度 / 线=线宽） */}
                        <div>
                          <label className="block text-xs text-muted-foreground mb-2">
                            {isPointType
                              ? t('map.thematicPointSizeUnit', { size: thematicPointSize })
                              : thematicGeometryType === 'line'
                                ? t('map.thematicLineWidthUnit', { size: thematicPointSize })
                                : t('map.thematicBorderWidthUnit', { size: thematicPointSize })}
                          </label>
                          <input
                            type="range"
                            min={sizeMin}
                            max={sizeMax}
                            step="1"
                            value={thematicPointSize}
                            onChange={(e) => setThematicPointSize(Number(e.target.value))}
                            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                          />
                          <div className="flex justify-between text-xs text-muted-foreground mt-1">
                            <span>{sizeMin}px</span>
                            <span>{sizeMax}px</span>
                          </div>
                        </div>

                    {/* 无样本提示 */}
                    {!loadingThematicSamples && thematicFieldType === null && (
                      <div className="px-3 py-2 text-xs rounded bg-amber-50 border border-amber-200 text-amber-700">
                        {t('map.thematicNoDataHint')}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}


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