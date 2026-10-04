/**
 * 标签设置 / 图层颜色设置 弹窗组件
 *
 * 功能:
 * - 双 Tab：标签设置页 + 图层颜色设置页
 * - 标签设置页：标签内容选择（下拉）、颜色选择器、字体大小
 * - 图层颜色设置页：图形颜色、图形透明度、边框宽度、边框颜色
 * - 保存/取消按钮
 */
import { useState, useEffect, useRef, useMemo, type ReactNode } from 'react'
import { ChevronDown, Plus, Trash2, Sparkles } from 'lucide-react'
import { HexColorPicker } from 'react-colorful'
import { useTranslation } from 'react-i18next'
import { hasValue, isNumericValue, toNumber, generateGeoIsolatedColors, THEMATIC_VALUE_LIMIT, NO_FILL_COLOR, FieldValueSample } from '../../utils/fieldValue'
import {
  buildAnchoredMapper,
  buildHeatLegend,
  formatLegendValue,
  gradientColorAt,
  quantileRefValue,
  quantileValueAt,
  resolveHeatGradient,
  resolveLevelGradient,
  type HeatLegendOverride,
} from '../../utils/heatmap'
import { buildValueMapper, concentrateLevel, softQuantizeLevel } from '../../utils/heatSurface'
import { resolveSectorField } from '../../config/sector-config'
import type { HeatmapStats } from './HeatmapLayerManager'
import { FloatingPanel } from './FloatingPanel'
import { useClickOutside } from '../../hooks/useClickOutside'
import { useToastStore } from '../../store/toastStore'

/** 浮动面板初始几何（相对地图容器；小容器下会自动钳为靠右；持久化后以 localStorage 为准） */
const INITIAL_RECT = { x: 720, y: 72, width: 700, height: 640 }

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
  /**
   * 字体族（CSS font-family 栈），默认 'sans-serif'（跟随系统默认字体）。
   * 复用系统自带字体：Windows 下 SimHei/微软雅黑等由 Electron/浏览器直接解析，
   * 无需打包字体文件；缺字平台自动回退到栈中的后备字体
   */
  fontFamily?: string
  /** 字体效果：加粗 */
  bold?: boolean
  /** 字体效果：斜体 */
  italic?: boolean
  /** 字体效果：阴影（深色柔影，提升复杂底图上的可读性） */
  shadow?: boolean
  /**
   * 字体背景：none=无 / halo=光晕（文字描边，浅色字配浅底图时提升对比）/
   * box=框形（文字后的圆角矩形底色），三态互斥
   */
  background?: 'none' | 'halo' | 'box'
  /** 字体背景颜色（background 为 halo/box 时生效） */
  backgroundColor?: string
}

/**
 * 标签字体预设（复用系统自带字体，值=CSS font-family 栈，缺字时逐级回退）
 */
export const FONT_FAMILY_OPTIONS: { value: string; label: string }[] = [
  { value: 'sans-serif', label: '默认' },
  { value: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif', label: '微软雅黑' },
  { value: 'SimHei, "Heiti SC", "Noto Sans CJK SC", sans-serif', label: '黑体' },
  { value: 'SimSun, "Songti SC", "Noto Serif CJK SC", serif', label: '宋体' },
  { value: 'KaiTi, "Kaiti SC", STKaiti, "Noto Serif CJK SC", serif', label: '楷体' },
  { value: 'LiSu, SimLi, "Noto Serif CJK SC", serif', label: '隶书' },
  { value: 'DengXian, "Microsoft YaHei", sans-serif', label: '等线' },
]

/**
 * 图层颜色设置接口
 * - fillColor: 图形颜色（填充色；线状图层为线条颜色）
 * - fillOpacity: 图形透明度 0~1（线要素作用于线条透明度）
 * - borderWidth: 边框宽度 px（线状图层为线宽）
 * - borderColor: 边框颜色（点/面 'none'=无色不描边且为默认值；线状图层不使用，旧版本可能存线色）
 * - pointSize: 图形大小 px（点要素半径；仅点图层的基础配置提供该设置项）
 */
export interface LayerColorSettings {
  fillColor: string
  fillOpacity: number
  borderWidth: number
  borderColor: string
  pointSize?: number
  /** 小区PCI渲染：启用后扇区按 PCI 取模值配色（仅基站扇区图层） */
  pciRenderEnabled?: boolean
  /** PCI 取模方式：3 或 30（开启后默认值随制式：LTE=3，NR=30） */
  pciMod?: 3 | 30
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
 * - fillOpacity: 图形透明度 0~1（专题填充透明度；线要素作用于线条透明度；缺省回退基础配置/默认样式）
 * - borderColor: 边框颜色（点/面专题描边色，'none'=无色不描边且为点/面默认值；线要素不适用；缺省回退专题配色）
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
  fillOpacity?: number
  borderColor?: string
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
 * 热力图设置模板：保存各设置项的当前值（不含图层相关的字段选择/边界裁剪），
 * 供同类图层一键套用。整个模板列表随 mapSettings 持久化。
 */
export interface HeatmapTemplate {
  id: string
  name: string
  settings: Omit<HeatmapSettings, 'enabled' | 'field' | 'boundaryLayerId' | 'boundaryDataId' | 'boundarySource'>
}

/**
 * 热力图配色方案（色带 stops 定义见 utils/heatmap.ts）
 */
export type HeatmapColorScheme = 'default' | 'warm' | 'cool' | 'viridis'

/**
 * 热力图颜色方向：数值变化与色带的方向关系
 * - normal: 值越大越偏暖（色带右端颜色）
 * - reverse: 值越大越偏冷（色带镜像）
 */
export type HeatmapColorDirection = 'normal' | 'reverse'

/**
 * 分级方法（参考 Surfer 网格外观 Grid Appearance 的 Method）
 * - cellCount: 等效细胞计数（Equal Cell Count），色带按采样点占比分级，
 *   每级承载等量采样点——重尾数据（流量类）必须用此法，线性映射会把
 *   绝大多数像元压在色带最低端
 * - valueRange: 等效范围（Equal Value Ranges），色带按数值区间等分
 */
export type HeatmapLegendMethod = 'cellCount' | 'valueRange'

/**
 * 热力图（连续加权值热力面）图层设置
 * - enabled: 是否启用（独立于专题图层，可共存）
 * - field: 权重数值字段名
 * - smooth: 平滑强度（细节核半径 = 最近邻间距 × 该值，1~10，默认 9.5）；
 *   小于点间距时各采样点圆斑互不相接会出现空白与颗粒，故以点间距为基准而非绝对半径
 * - method: 分级方法（旧设置无此字段时按 cellCount 处理）
 * - inflections: 分级数（3~15，默认 5），决定图例级数与色带分段密度
 * - round: 图例数值取整精度（0.01/0.1/1/10/100），仅影响显示
 * - contrast: 颜色映射对比度（0.5~3，默认 0.9，1=线性）：>1 高低端更快饱和、中间过渡更陡
 * - opacity: 半透明度（0~1，1=完全不透明）
 * - detail: 细节增强（0~100，默认 95，0=纯平滑）：整体趋势场与站点级细节场的
 *   **凸组合比例**——按比例栅格化融合，端点都不超数据界（无光晕超界）
 * - sampling: 栅格采样粒度 1~30（默认 26）：细节网格边长相对点间距的倍数。
 *   网格细于细节核时只影响离散精度；粗于细节核时核自动加宽 → 越大越柔越融合
 * - discrete: 分级着色（默认关=连续渐变）：开启后地图按图例 N 级离散着色
 *   （等值线感）；连续渲染下细节增强的局部对比也才不会被量化抹平
 * - levels: 手工编辑过的分级（颜色/区间/占比）。存在时地图着色与图例都按它走
 *   （锚点分段映射），为空则按 method 自动分级
 * - colorScheme: 渐变色带方案
 * - colorDirection: 颜色变化方向（旧设置无此字段时按 normal 处理）
 * - boundaryLayerId / boundaryDataId / boundarySource: 边界裁剪的面图层
 *   （source='mapinfo' 取自图层文件，'excel' 取自地理化数据；空=不裁剪）
 * - showOriginal: 热力启用时是否同时显示原图层图形（false=替换模式，原图形与标签隐藏）
 *
 * 注：原「模糊度 / 清晰度 / 数值上下限 / 颜色分布」参数已删除——
 * 值域与颜色分布统一由图例分级（method/inflections/round/levels）承担。
 */
export interface HeatmapSettings {
  enabled: boolean
  field: string
  smooth: number
  method?: HeatmapLegendMethod
  inflections?: number
  round?: number
  contrast?: number
  opacity?: number
  /** 细节增强 0~100（默认 95）：细桶在统一归一化中的权重比例 */
  detail?: number
  /** 栅格采样粒度 1~30（默认 1）：细网格边长相对点间距的倍数，越大越粗 */
  sampling?: number
  /** 采样方式：grid=栅格化 IDW 全景渲染（默认）；original=按原始采样点逐点渲染（不栅格化） */
  sampleMode?: 'grid' | 'original'
  /**
   * 平滑强度语义版本（缺省=旧版）。旧版 smooth 在 detail≈95 时对细节核**完全无效**
   * （实测 smooth=3/5/9 渲染逐像素相同），保存的值不携带任何用户意图；新版同一数值
   * 会显著改变核宽 → 读回时由 mapStore.migrateHeatmapSmooth 归一到新默认
   */
  smoothVersion?: number
  /** 渲染方式：true=分级渲染（默认，MapInfo 式等值区域）；false=连续渐变 */
  discrete?: boolean
  /**
   * 分级边界柔化 0~1（默认 0.3，仅分级模式）：
   * 色块内部保持纯色，仅级别边界窄带内软过渡（0=硬等值线、1=全连续）
   */
  levelSoftness?: number
  /**
   * 高值集中度 gamma（默认 ≈1.087 = 滑块 52）：**仅对色带高端(>0.5)分段**做幂曲线，
   * >1 把顶端色收缩给真正 100% 点位突出渲染，中低配色完全不动、空间插值不变
   */
  concentration?: number
  /** 手工分级（颜色/区间/占比）；空=默认 5 级等效细胞计数时用内置默认占比，否则按 method 自动分级 */
  levels?: HeatLegendOverride[]
  colorScheme: HeatmapColorScheme
  colorDirection?: HeatmapColorDirection
  /** 图例标签顺序：desc=高值在上（默认），asc=低值在上 */
  legendOrder?: 'asc' | 'desc'
  boundaryLayerId?: string
  boundaryDataId?: string
  boundarySource?: 'mapinfo' | 'excel'
  showOriginal: boolean
}

/**
 * 热力图设置语义版本：用于把**旧版无效/语义不同的值**（见 HeatmapSettings.smoothVersion 注释）
 * 或**旧默认值**在读回时归一到新默认。改动 smooth/sampling/discrete 语义或调整默认值时递增，
 * 并在 mapStore.migrateHeatmapSmooth 里补规则
 */
export const HEATMAP_SETTINGS_VERSION = 4

/**
 * 高值集中度滑块（0~100）↔ gamma 换算：滑块 50=gamma 1（中性），
 * 0=gamma 1/8（高值扩大）、100=gamma 8（高值收缩）。指数刻度保证两侧对称、连续
 */
function gammaFromSlider(v: number): number {
  return Math.pow(8, (Math.min(100, Math.max(0, v)) - 50) / 50)
}
function sliderFromGamma(g: number): number {
  return Math.round(50 + (50 * Math.log(g)) / Math.log(8))
}

/**
 * 内置默认分级占比（色带位置 t，低→高）：蓝 0%、淡绿 27%、绿 50%、黄 78%、红 100%。
 * 未手工编辑分级、且为默认 5 级「等效细胞计数」时按它分级（与地图/图例同源）；
 * 分级数改成其它值即回到等分自动分级
 */
export const DEFAULT_HEATMAP_LEVEL_PROPORTIONS = [0, 0.27, 0.5, 0.78, 1]

/** 热力图默认设置（未选择字段时） */
export const DEFAULT_HEATMAP_SETTINGS: Omit<HeatmapSettings, 'field'> = {
  enabled: false,
  smooth: 9.5,
  method: 'cellCount',
  inflections: DEFAULT_HEATMAP_LEVEL_PROPORTIONS.length,
  round: 0.1,
  contrast: 0.9,
  opacity: 1,
  detail: 95,
  sampling: 26,
  sampleMode: 'grid',
  discrete: false,
  levelSoftness: 0.3,
  // 滑块 52（8^(2/50)，高值略收缩）
  concentration: gammaFromSlider(52),
  colorScheme: 'default',
  colorDirection: 'normal',
  showOriginal: false,
  legendOrder: 'desc',
}

/** 分级色块的基础色板（红、黄、青、绿、蓝） */
export const HEATMAP_BASE_COLORS = ['#ff0000', '#ffff00', '#00ffff', '#00ff00', '#0000ff']

/** 分级数可选项 */
export const HEATMAP_INFLECTION_OPTIONS = [3, 5, 7, 9, 11, 15]
/** 取整精度可选项（图例数值显示） */
export const HEATMAP_ROUND_OPTIONS = [0.01, 0.1, 1, 10, 100]
/** 对比度滑杆区间（百分数） */
export const HEATMAP_CONTRAST_RANGE = { min: 50, max: 300 }
/** 半透明度滑杆区间（百分数，0=完全不显示） */
export const HEATMAP_OPACITY_RANGE = { min: 0, max: 100 }
/** 百分比滑杆区间（0~100 设置项共用） */
export const HEATMAP_PCT_RANGE = { min: 0, max: 100 }

/** 栅格采样粒度滑杆区间（细节网格边长 / 点间距 倍数） */
export const HEATMAP_SAMPLING_RANGE = { min: 1, max: 30 }

/** 把持久化读回的百分数钳到滑杆区间，避免"滑块位置与状态值脱节" */
function clampPct(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return max
  return Math.min(max, Math.max(min, Math.round(v)))
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
  /** 当前热力图设置 */
  currentHeatmapSettings?: HeatmapSettings | null
  /** 保存热力图设置回调（null 表示关闭热力图） */
  onSaveHeatmap?: (settings: HeatmapSettings | null) => void
  /** 取消（未保存关闭）回调：调用方恢复打开前状态 */
  onCancel?: () => void
  /** 实时预览：标签设置（debounce 下发） */
  onPreview?: (settings: LabelSettings) => void
  /** 实时预览：基础图形设置 */
  onPreviewColor?: (settings: LayerColorSettings) => void
  /** 实时预览：专题设置（null 表示关闭） */
  onPreviewThematic?: (settings: ThematicSettings | null) => void
  /** 实时预览：热力图设置（null 表示关闭） */
  onPreviewHeatmap?: (settings: HeatmapSettings | null) => void
  /**
   * 该图层在地图上的热力统计（含渲染场分布）。
   * 分级预览用它做分位基准，才能与地图着色同源；缺省时退化为按样本点分布估算
   */
  mapHeatmapStats?: HeatmapStats | null
  /** 可选作边界裁剪的面图层（来自图层文件与地理化数据） */
  polygonLayers?: { id: string; dataId: string; name: string; source: 'mapinfo' | 'excel' }[]
  /** 字段值样本（字段 → 样本值数组，用于类型检测/推荐区间/唯一值列表） */
  thematicFieldSamples?: Record<string, FieldValueSample[]>
  /** 是否正在加载字段样本 */
  loadingThematicSamples?: boolean
  /** 打开弹窗时颜色设置页的初始子页（默认基础配置） */
  initialColorSubTab?: 'basic' | 'thematic' | 'heatmap'
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
  /** 已保存的热力图设置模板列表 */
  heatmapTemplates?: HeatmapTemplate[]
  /** 保存热力图设置模板回调（以当前设置项的值为模板内容） */
  onSaveHeatmapTemplate?: (name: string, settings: HeatmapTemplate['settings']) => void
  /** 删除热力图设置模板回调 */
  onRemoveHeatmapTemplate?: (id: string) => void
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
 * 无色（镂空）色块：浅色底 + 红色斜线，表示要素不填充仅显示边框
 */
function NoFillSwatch({ selected, onSelect, title, wide }: { selected: boolean; onSelect: () => void; title: string; wide?: boolean }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative ${wide ? 'w-7 h-7' : 'w-6 h-6'} rounded border-2 transition-all overflow-hidden bg-background flex-shrink-0 ${selected
        ? 'border-primary ring-1 ring-primary ring-offset-1'
        : 'border-border hover:border-muted-foreground/50'
        }`}
      title={title}
      aria-label={title}
    >
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 24 24" preserveAspectRatio="none">
        <line x1="3" y1="21" x2="21" y2="3" stroke="#ef4444" strokeWidth="2.5" />
      </svg>
    </button>
  )
}

/**
 * 分级行外壳：色盘展开时，点击本行（色块/输入框/色盘）以外任意区域即收回。
 * 色块的开/合 toggle 在壳内，不会被外部监听打断。
 */
function HeatLevelRowShell({ open, onClose, children }: {
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  const ref = useClickOutside<HTMLDivElement>(onClose, open)
  return <div ref={ref}>{children}</div>
}

/**
 * 热力图分级取色器：基础五色（红/黄/青/绿/蓝）快捷选择 + 自定义色盘。
 * 内联展开在对应分级行下方（不用浮层，避免弹窗内 overflow 裁剪）；
 * 点击色块选中颜色后由 onClose 收起（点击面板外由 HeatLevelRowShell 收起）
 */
function HeatLevelColorPicker({
  value,
  onChange,
  onAuto,
  onClose,
}: {
  value?: string
  onChange: (color: string) => void
  onAuto: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="mt-1 mb-2 p-2 border border-border rounded bg-muted/30">
      <div className="flex items-center gap-1.5 mb-2">
        {HEATMAP_BASE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => { onChange(c); onClose() }}
            className={`w-6 h-6 rounded border-2 transition-all ${value?.toLowerCase() === c ? 'border-primary' : 'border-border'}`}
            style={{ backgroundColor: c }}
            title={c}
          />
        ))}
        <button
          type="button"
          onClick={() => { onAuto(); onClose() }}
          className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
        >
          {t('map.heatmapLevelColorAuto')}
        </button>
      </div>
      <HexColorPicker
        color={value ?? '#ff0000'}
        onChange={onChange}
        style={{ width: '100%', height: '110px' }}
      />
    </div>
  )
}

function ColorSwatch({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const noFill = value === NO_FILL_COLOR
  const rootRef = useClickOutside<HTMLDivElement>(() => setOpen(false), open)

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="relative w-7 h-7 rounded border-2 border-border hover:border-muted-foreground/50 transition-all flex items-center justify-center overflow-hidden bg-background"
        style={{ backgroundColor: noFill ? 'hsl(var(--background))' : value }}
        title={noFill ? t('map.noFillColor') : value}
      >
        {noFill ? (
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 24 24" preserveAspectRatio="none">
            <line x1="3" y1="21" x2="21" y2="3" stroke="#ef4444" strokeWidth="2.5" />
          </svg>
        ) : open && (
          <span className="w-3 h-3 rounded-full border border-white/60 shadow" />
        )}
      </button>
      {open && (
        <div
          className="absolute right-0 z-30 mt-1 p-2 bg-background border border-border rounded-lg shadow-lg w-52"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 无色（镂空）+ 预设色块 */}
          <div className="flex flex-wrap gap-1.5 mb-2">
            <NoFillSwatch
              wide
              selected={noFill}
              title={t('map.noFillColor')}
              onSelect={() => { onChange(NO_FILL_COLOR); setOpen(false) }}
            />
            {THEMATIC_PALETTE.map((presetColor) => (
              <button
                key={presetColor}
                onClick={() => { onChange(presetColor); setOpen(false) }}
                className={`w-6 h-6 rounded border-2 transition-all ${!noFill && value.toLowerCase() === presetColor.toLowerCase()
                  ? 'border-primary ring-1 ring-primary ring-offset-1'
                  : 'border-border hover:border-muted-foreground/50'
                  }`}
                style={{ backgroundColor: presetColor }}
                title={presetColor}
              />
            ))}
          </div>
          {/* 自定义色板（无色时值非法，以白色展示供重新选色） */}
          <HexColorPicker color={noFill ? '#ffffff' : value} onChange={onChange} />
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
 * allowNoFill：提供「无色」选项（填充色=要素镂空仅显示边框；边框色=不描边）
 * noColorTitle：无色色块的提示文案（边框色与填充色语义不同）
 */
function ColorField({ value, onChange, allowNoFill = false, noColorTitle }: { value: string; onChange: (color: string) => void; allowNoFill?: boolean; noColorTitle?: string }) {
  const { t } = useTranslation()
  const [showCustomColor, setShowCustomColor] = useState(false)
  const noFill = value === NO_FILL_COLOR

  return (
    <div className="space-y-2">
      {/* 预设颜色 */}
      <div className="flex flex-wrap gap-1.5">
        {allowNoFill && (
          <NoFillSwatch
            selected={noFill}
            title={noColorTitle || t('map.noFillColor')}
            onSelect={() => { onChange(NO_FILL_COLOR); setShowCustomColor(false) }}
          />
        )}
        {PRESET_COLORS.map((presetColor) => (
          <button
            key={presetColor}
            onClick={() => { onChange(presetColor); setShowCustomColor(false) }}
            className={`w-6 h-6 rounded border-2 transition-all ${!noFill && value === presetColor
              ? 'border-primary ring-1 ring-primary ring-offset-1'
              : 'border-border hover:border-muted-foreground/50'
              }`}
            style={{ backgroundColor: presetColor }}
            title={presetColor}
          />
        ))}
        {/* 自定义颜色按钮 */}
        <button
          onClick={() => setShowCustomColor(true)}
          className={`w-6 h-6 rounded border-2 border-border hover:border-muted-foreground/50 flex items-center justify-center transition-all bg-gradient-to-br from-red-500 via-green-500 to-blue-500 ${showCustomColor && !noFill ? 'ring-1 ring-primary ring-offset-1' : ''
            }`}
          title={t('map.customColor')}
        >
          <span className="text-white text-xs">+</span>
        </button>
      </div>

      {/* 自定义颜色选择器（无色时值非法，以白色展示供重新选色） */}
      {showCustomColor && (
        <div className="flex items-center gap-2 pt-1">
          <HexColorPicker color={noFill ? '#ffffff' : value} onChange={onChange} />
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
  const rootRef = useClickOutside<HTMLDivElement>(() => setOpen(false), open)

  return (
    <div className="relative" ref={rootRef}>
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
  currentHeatmapSettings,
  onSaveHeatmap,
  mapHeatmapStats = null,
  polygonLayers = [],
  thematicFieldSamples = {},
  loadingThematicSamples = false,
  initialColorSubTab = 'basic',
  thematicGeometryType = 'point',
  sectorColorMode = false,
  thematicTemplates = [],
  onSaveThematicTemplate,
  onRemoveThematicTemplate,
  heatmapTemplates = [],
  onSaveHeatmapTemplate,
  onRemoveHeatmapTemplate,
  onCancel,
  onPreview,
  onPreviewColor,
  onPreviewThematic,
  onPreviewHeatmap,
}: LabelSettingsModalProps) {
  // i18n translation
  const { t } = useTranslation()

  // 内部状态 - 标签设置
  const [content, setContent] = useState<LabelField>(currentSettings?.content || fieldOptions[0]?.value || 'name')
  const [color, setColor] = useState(currentSettings?.color || '#000000')
  const [fontSize, setFontSize] = useState(currentSettings?.fontSize || 12)
  const [fontFamily, setFontFamily] = useState(currentSettings?.fontFamily || 'sans-serif')
  const [bold, setBold] = useState(currentSettings?.bold ?? false)
  const [italic, setItalic] = useState(currentSettings?.italic ?? false)
  const [shadow, setShadow] = useState(currentSettings?.shadow ?? false)
  const [background, setBackground] = useState<'none' | 'halo' | 'box'>(currentSettings?.background || 'none')
  const [backgroundColor, setBackgroundColor] = useState(currentSettings?.backgroundColor || '#ffffff')
  const [showDropdown, setShowDropdown] = useState(false)

  // 内部状态 - 图层颜色设置
  const [fillColor, setFillColor] = useState(currentColorSettings?.fillColor || '#3b82f6')
  const [fillOpacityPct, setFillOpacityPct] = useState(Math.round((currentColorSettings?.fillOpacity ?? 1) * 100))
  const [borderWidth, setBorderWidth] = useState(currentColorSettings?.borderWidth || 2)
  // 边框颜色默认无色（点/面图层不描边）；线状图层无边框色项（线色由图形颜色控制）
  const [borderColor, setBorderColor] = useState(NO_FILL_COLOR)
  // 点图层"图形大小"（基础配置新增：点要素半径 px）
  const [pointSize, setPointSize] = useState(currentColorSettings?.pointSize ?? 6)
  // 小区PCI渲染（仅基站扇区图层默认设置）：开关 + 模3/模30 方式
  const [pciRenderEnabled, setPciRenderEnabled] = useState(currentColorSettings?.pciRenderEnabled ?? false)
  const [pciMod, setPciMod] = useState<3 | 30>(currentColorSettings?.pciMod ?? 3)

  // 内部状态 - 专题图层设置
  const [colorSubTab, setColorSubTab] = useState<'basic' | 'thematic' | 'heatmap'>('basic')
  const [thematicEnabled, setThematicEnabled] = useState(false)
  const [thematicField, setThematicField] = useState('')
  const [thematicFieldType, setThematicFieldType] = useState<ThematicFieldType | null>(null)
  const [thematicColorMode, setThematicColorMode] = useState<ThematicColorMode>('range')
  const [thematicRanges, setThematicRanges] = useState<ThematicRange[]>([])
  const [thematicValueColors, setThematicValueColors] = useState<ThematicCategory[]>([])
  const [thematicCategories, setThematicCategories] = useState<ThematicCategory[]>([])
  const [thematicPointSize, setThematicPointSize] = useState(8)
  // 专题图形透明度（百分比，0~100）与边框颜色（点/面默认无色）
  const [thematicFillOpacityPct, setThematicFillOpacityPct] = useState(100)
  const [thematicBorderColor, setThematicBorderColor] = useState(NO_FILL_COLOR)
  // 图例是否显示元素个数与占比统计
  const [thematicShowStats, setThematicShowStats] = useState(true)
  // 模板 UI 状态
  const [templateName, setTemplateName] = useState('')
  const [templateDropdownOpen, setTemplateDropdownOpen] = useState(false)
  /** 热力图模板：保存名称输入与下拉展开态 */
  const [heatTemplateName, setHeatTemplateName] = useState('')
  const [heatSelectedTemplateName, setHeatSelectedTemplateName] = useState('')
  const [heatTemplateDropdownOpen, setHeatTemplateDropdownOpen] = useState(false)
  // 三个自定义下拉：点击外部自动收回
  const fieldDropdownRef = useClickOutside<HTMLDivElement>(() => setShowDropdown(false), showDropdown)
  const thematicTplRef = useClickOutside<HTMLDivElement>(() => setTemplateDropdownOpen(false), templateDropdownOpen)
  const heatTplRef = useClickOutside<HTMLDivElement>(() => setHeatTemplateDropdownOpen(false), heatTemplateDropdownOpen)

  // 内部状态 - 热力图设置
  const [heatEnabled, setHeatEnabled] = useState(false)
  const [heatField, setHeatField] = useState('')
  const [heatSmooth, setHeatSmooth] = useState(DEFAULT_HEATMAP_SETTINGS.smooth)
  const [heatMethod, setHeatMethod] = useState<HeatmapLegendMethod>(DEFAULT_HEATMAP_SETTINGS.method ?? 'cellCount')
  const [heatInflections, setHeatInflections] = useState(DEFAULT_HEATMAP_SETTINGS.inflections ?? 7)
  const [heatRound, setHeatRound] = useState(DEFAULT_HEATMAP_SETTINGS.round ?? 0.1)
  const [heatContrastPct, setHeatContrastPct] = useState(DEFAULT_HEATMAP_SETTINGS.contrast! * 100)
  const [heatOpacityPct, setHeatOpacityPct] = useState(DEFAULT_HEATMAP_SETTINGS.opacity! * 100)
  /** 细节增强（0=纯平滑趋势场，100=桶粒度细节场最强）与分级着色开关 */
  const [heatDetail, setHeatDetail] = useState(DEFAULT_HEATMAP_SETTINGS.detail!)
  const [heatSampling, setHeatSampling] = useState(DEFAULT_HEATMAP_SETTINGS.sampling!)
  const [heatSampleMode, setHeatSampleMode] = useState<'grid' | 'original'>(DEFAULT_HEATMAP_SETTINGS.sampleMode!)
  const [heatDiscrete, setHeatDiscrete] = useState(DEFAULT_HEATMAP_SETTINGS.discrete ?? true)
  /** 分级边界柔化（0=硬等值线、1=全连续），仅分级模式启用 */
  const [heatLevelSoftness, setHeatLevelSoftness] = useState(DEFAULT_HEATMAP_SETTINGS.levelSoftness!)
  /** 高值集中度 gamma（滑块 0~100，50=gamma1 中性） */
  const [heatConcentration, setHeatConcentration] = useState(DEFAULT_HEATMAP_SETTINGS.concentration!)
  const concentrationSlider = sliderFromGamma(heatConcentration)
  /**
   * 手工分级（颜色/区间/占比）；null=未编辑：默认 5 级等效细胞计数时按内置默认占比分级，
   * 其它情况按 method 自动分级
   */
  const [heatLevelOverrides, setHeatLevelOverrides] = useState<HeatLegendOverride[] | null>(null)
  /** 展开中的取色器行号（同一时刻只开一个） */
  const [heatColorPickerRow, setHeatColorPickerRow] = useState<number | null>(null)
  /**
   * 分级输入框的草稿文本（key=分级下标）。
   * 受控输入若直接用派生数值，用户键入 "51." 会被 Number() 解析成 51 并立刻回写，
   * 小数点被抹掉 → 继续输入变成 514。故草稿只在文本为"完整数字"时才提交。
   */
  const [heatLevelDrafts, setHeatLevelDrafts] = useState<Record<number, string>>({})
  const [heatColorScheme, setHeatColorScheme] = useState<HeatmapColorScheme>('default')

  const [heatLegendOrder, setHeatLegendOrder] = useState<'asc' | 'desc'>(DEFAULT_HEATMAP_SETTINGS.legendOrder!)
  const [heatBoundaryLayerId, setHeatBoundaryLayerId] = useState('')
  const [heatShowOriginal, setHeatShowOriginal] = useState(true)
  // 保存校验错误（启用但未选到数值字段）
  const [heatError, setHeatError] = useState('')

  /**
   * 分级基准数据 + 自动分级：与地图图例同源——同一 buildHeatLegend + 同一"值→色带"映射函数，
   * 并用样本的出现次数（count）还原真实分布（样本本身按值去重，不还原会得出相反的分位结论）。
   * 随方法/级数/取整精度/对比度实时刷新；无样本时退化为占位值域，仅展示分级结构。
   *
   * 若地图上该图层已渲染热力（mapHeatmapStats），则优先用地图侧的**渲染场分布**做分位基准：
   * 插值会把邻域值平均掉，渲染场分布与样本点分布差别很大，用后者算出的分级值与地图对不上。
   */
  const heatPreview = useMemo(() => {
    const mapDist = mapHeatmapStats && mapHeatmapStats.field === heatField
      ? mapHeatmapStats.fieldDistribution
      : null
    const distribution = mapDist && mapDist.length >= 2 ? mapDist : null
    const samples = thematicFieldSamples[heatField] ?? []
    const points: { lat: number; lng: number; weight: number }[] = []
    const counts: number[] = []
    let min = Infinity
    let max = -Infinity
    for (const s of samples) {
      const v = toNumber(s.v)
      if (v === null) continue
      points.push({ lat: s.lat, lng: s.lng, weight: v })
      counts.push(Math.max(1, Math.round(s.count ?? 1)))
      if (v < min) min = v
      if (v > max) max = v
    }
    // 值域也取地图侧的全量数据极值（样本按值去重，极值可能缺失）
    if (distribution) {
      min = mapHeatmapStats!.min
      max = mapHeatmapStats!.max
    } else if (points.length === 0) {
      min = 0
      max = 1
    }
    const rawMapper = buildValueMapper(points, min, max, heatMethod, heatContrastPct / 100, 512, distribution)
    // 高值集中度（与地图同规则）
    const withConc = heatConcentration === 1
      ? rawMapper
      : (v: number) => concentrateLevel(rawMapper(v), heatConcentration)
    // 分级渲染：量化到分级数 + 边界柔化（图例色块与地图颜色一致）
    const mapValue = heatDiscrete
      ? (v: number) => softQuantizeLevel(withConc(v), Math.max(2, heatInflections), heatLevelSoftness)
      : withConc
    const autoLevels = buildHeatLegend(points, min, max, heatMethod, heatInflections, heatRound, { counts, mapValue, distribution: distribution ?? undefined })
    return { points, counts, min, max, distribution, autoLevels }
  }, [thematicFieldSamples, heatField, mapHeatmapStats, heatMethod, heatInflections, heatRound, heatContrastPct, heatDiscrete, heatLevelSoftness, heatConcentration])

  /** 内置默认分级占比是否生效：默认 5 级「等效细胞计数」（分级数/分级方法一经改动即回到等分自动分级） */
  const usesDefaultHeatLevels = heatMethod === 'cellCount' && heatInflections === DEFAULT_HEATMAP_LEVEL_PROPORTIONS.length

  /**
   * 内置默认分级（蓝0%/淡绿27%/绿50%/黄78%/红100%）。
   * 各级"值"按预览基准分布在 t 处的分位反算——cellCount 下占比才是分级意图，值随数据而变
   */
  const defaultHeatLevels = useMemo<HeatLegendOverride[]>(() => {
    const dist = heatPreview.distribution
    return DEFAULT_HEATMAP_LEVEL_PROPORTIONS.map(t => ({
      t,
      value: dist && dist.length >= 2
        ? quantileRefValue(dist, t)
        : quantileValueAt(heatPreview.points, t, heatPreview.counts, 0),
    }))
  }, [heatPreview])

  /**
   * 展示用分级：手工编辑优先，其次是内置默认占比，最后是自动分级。
   * 编辑态下映射也换成锚点映射（与地图侧一致），保证面板里看到的颜色就是地图上的颜色。
   */
  const previewLevels = useMemo(() => {
    const overrides = heatLevelOverrides ?? (usesDefaultHeatLevels ? defaultHeatLevels : null)
    if (!overrides) return heatPreview.autoLevels
    const anchoredRaw = buildAnchoredMapper(
      overrides.map(l => ({ value: l.value, t: l.t })),
      heatContrastPct / 100
    )
    const anchoredWithConc = heatConcentration === 1
      ? anchoredRaw
      : (v: number) => concentrateLevel(anchoredRaw(v), heatConcentration)
    const anchored = heatDiscrete
      ? (v: number) => softQuantizeLevel(anchoredWithConc(v), Math.max(2, heatInflections), heatLevelSoftness)
      : anchoredWithConc
    return buildHeatLegend(
      heatPreview.points,
      heatPreview.min,
      heatPreview.max,
      heatMethod,
      overrides.length,
      heatRound,
      { overrides, mapValue: anchored }
    )
  }, [heatPreview, heatLevelOverrides, defaultHeatLevels, usesDefaultHeatLevels, heatMethod, heatRound, heatContrastPct, heatDiscrete, heatInflections, heatLevelSoftness, heatConcentration])

  /**
   * 颜色方向由「图例标签顺序」派生（保留原「颜色方向」能力）：
   * 升序 = 反向色带（低值在图例顶部 → 地图上低值显暖端色），降序 = 正向
   */
  const heatColorDirection: HeatmapColorDirection = heatLegendOrder === 'asc' ? 'reverse' : 'normal'

  /**
   * 图例色带（自定义色按分级占比位注册）：图例取色与对比度**解耦**——
   * 色块按分级的原始占比位置（t）从色带取色，对比度只作用于地图着色
   */
  const previewStops = useMemo(
    () => resolveLevelGradient(
      resolveHeatGradient(heatColorScheme, heatColorDirection),
      previewLevels.map(l => ({ t: l.t, color: l.color })),
      heatColorDirection
    ),
    [heatColorScheme, heatColorDirection, previewLevels]
  )

  /** 进入编辑态：以当前生效分级为初值（用户改动第一项即落为手工分级） */
  const ensureOverrides = (): HeatLegendOverride[] =>
    heatLevelOverrides
    ?? (usesDefaultHeatLevels
      ? defaultHeatLevels.map(l => ({ ...l }))
      : heatPreview.autoLevels.map(l => ({ t: l.t, value: l.value })))

  /** 清空手工分级（连同取色器展开态与输入草稿），回到当前设置的默认/自动分级。
   *  注意：不得改动分级数/配色方案——分级数、分级方法下拉的 onChange 也调用它 */
  const clearLevelOverrides = () => {
    setHeatLevelOverrides(null)
    setHeatColorPickerRow(null)
    setHeatLevelDrafts({})
  }

  /** 恢复默认分级按钮：回到内置默认分级（5 级等效细胞计数：蓝0%/淡绿27%/绿50%/黄78%/红100%，
   *  默认色带；其它级数/方法下即等分自动分级），分级数与配色方案一并复位 */
  const resetLevelsToDefault = () => {
    setHeatInflections(DEFAULT_HEATMAP_LEVEL_PROPORTIONS.length)
    setHeatColorScheme('default')
    clearLevelOverrides()
  }

  /** 分级输入的展示文本：编辑中的草稿优先，否则用派生数值 */
  const levelInputText = (index: number, lv: { t: number; value: number }) =>
    heatLevelDrafts[index] ?? String(heatMethod === 'cellCount' ? Math.round(lv.t * 100) : Math.round(lv.value * 1000) / 1000)

  /**
   * 分级输入变更：草稿照单全收，只有文本构成完整数字时才落到分级里。
   * 这样 "51."、"-"、"" 等中间态不会被打断，也不会把 51.4 误存成 514。
   */
  const handleLevelInput = (index: number, text: string) => {
    setHeatLevelDrafts(prev => ({ ...prev, [index]: text }))
    const trimmed = text.trim()
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return
    updateLevel(index, heatMethod === 'cellCount' ? { pct: n } : { value: n })
  }

  /** 失焦时清掉草稿：下一次显示回到已生效的数值（非法输入自然被丢弃） */
  const handleLevelBlur = (index: number) => {
    setHeatLevelDrafts(prev => {
      if (!(index in prev)) return prev
      const next = { ...prev }
      delete next[index]
      return next
    })
  }

  /** 改占比（等效细胞计数）/ 改区间值（等效范围）：另一字段随之换算 */
  const updateLevel = (index: number, patch: { pct?: number; value?: number; color?: string | null }) => {
    const next = [...ensureOverrides()]
    const cur = next[index]
    if (!cur) return
    let t = cur.t
    let value = cur.value
    if (patch.pct !== undefined) {
      t = Math.max(0, Math.min(1, patch.pct / 100))
      if (heatMethod === 'cellCount') {
        value = heatPreview.distribution
          ? quantileRefValue(heatPreview.distribution, t)
          : quantileValueAt(heatPreview.points, t, heatPreview.counts, cur.value)
      }
    }
    if (patch.value !== undefined) {
      value = patch.value
      const span = heatPreview.max - heatPreview.min
      t = span > 0 ? Math.max(0, Math.min(1, (value - heatPreview.min) / span)) : cur.t
    }
    const color = patch.color === null ? undefined : (patch.color ?? cur.color)
    next[index] = { t, value, color }
    setHeatLevelOverrides(next)
  }

  /**
   * 套用热力图模板：把模板保存的各项设置填回表单（不含字段选择/边界/启用开关/
   * 手工分级——那些是图层相关的）。
   */
  const applyHeatmapTemplate = (tmpl: HeatmapTemplate) => {
    const s = tmpl.settings
    setHeatSmooth(Math.min(10, Math.max(1, s.smooth)))
    setHeatMethod(s.method ?? 'cellCount')
    const inflections = s.inflections ?? DEFAULT_HEATMAP_SETTINGS.inflections!
    setHeatInflections(HEATMAP_INFLECTION_OPTIONS.includes(inflections) ? inflections : DEFAULT_HEATMAP_SETTINGS.inflections!)
    const round = s.round ?? DEFAULT_HEATMAP_SETTINGS.round!
    setHeatRound(HEATMAP_ROUND_OPTIONS.includes(round) ? round : DEFAULT_HEATMAP_SETTINGS.round!)
    setHeatContrastPct(clampPct((s.contrast ?? 1) * 100, HEATMAP_CONTRAST_RANGE.min, HEATMAP_CONTRAST_RANGE.max))
    setHeatOpacityPct(clampPct((s.opacity ?? 1) * 100, HEATMAP_OPACITY_RANGE.min, HEATMAP_OPACITY_RANGE.max))
    setHeatDetail(clampPct(s.detail ?? DEFAULT_HEATMAP_SETTINGS.detail!, HEATMAP_PCT_RANGE.min, HEATMAP_PCT_RANGE.max))
    setHeatSampling(Math.min(HEATMAP_SAMPLING_RANGE.max, Math.max(HEATMAP_SAMPLING_RANGE.min, Math.round(s.sampling ?? DEFAULT_HEATMAP_SETTINGS.sampling!))))
    setHeatSampleMode(s.sampleMode === 'original' ? 'original' : 'grid')
    setHeatDiscrete(s.discrete ?? DEFAULT_HEATMAP_SETTINGS.discrete ?? true)
    setHeatLevelSoftness(s.levelSoftness ?? DEFAULT_HEATMAP_SETTINGS.levelSoftness!)
    setHeatConcentration(s.concentration ?? DEFAULT_HEATMAP_SETTINGS.concentration!)
    setHeatColorScheme(s.colorScheme || 'default')
    // 旧设置只有 colorDirection：反向迁移为升序，正向迁移为降序
    setHeatLegendOrder(s.legendOrder ?? (s.colorDirection === 'reverse' ? 'asc' : DEFAULT_HEATMAP_SETTINGS.legendOrder!))
    setHeatShowOriginal(s.showOriginal !== false)
    setHeatSelectedTemplateName(tmpl.name)
  }

  /** 以当前表单值构造模板内容（不含字段选择/边界/启用开关/手工分级） */
  const buildHeatmapTemplateSettings = (): HeatmapTemplate['settings'] => ({
    smooth: heatSmooth,
    smoothVersion: HEATMAP_SETTINGS_VERSION,
    method: heatMethod,
    inflections: heatInflections,
    round: heatRound,
    contrast: heatContrastPct / 100,
    opacity: heatOpacityPct / 100,
    detail: heatDetail,
    sampling: heatSampling,
    sampleMode: heatSampleMode,
    discrete: heatDiscrete,
    levelSoftness: heatLevelSoftness,
    concentration: heatConcentration,
    colorScheme: heatColorScheme,
    colorDirection: heatColorDirection,
    legendOrder: heatLegendOrder,
    showOriginal: heatShowOriginal,
  })

  // 几何类型 → 尺寸设置语义：点=图形大小(半径)，面/扇区=边框宽度，线=线宽
  const isPointType = thematicGeometryType === 'point'
  const isLineType = thematicGeometryType === 'line'
  // 点/面图层：边框颜色提供「无色」选项且默认无色（扇区图层按频点配色，不提供该项）
  const borderColorSupportsNone = thematicGeometryType === 'point' || thematicGeometryType === 'polygon'
  const sizeMin = isPointType ? 3 : 1
  const sizeMax = isPointType ? 20 : 8
  // "图形大小"（基础设置新增）仅对图层文件类点图层开放（可进入专题子页的 point 图层）；
  // 装饰图层等非图层文件不显示该设置项
  const isPointBasic = isPointType && showThematicTab

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
      setFontFamily(currentSettings?.fontFamily || 'sans-serif')
      setBold(currentSettings?.bold ?? false)
      setItalic(currentSettings?.italic ?? false)
      setShadow(currentSettings?.shadow ?? false)
      setBackground(currentSettings?.background || 'none')
      setBackgroundColor(currentSettings?.backgroundColor || '#ffffff')
      setShowDropdown(false)

      // 图层颜色设置
      setFillOpacityPct(Math.round((currentColorSettings?.fillOpacity ?? 1) * 100))
      setBorderWidth(currentColorSettings?.borderWidth || 2)
      if (thematicGeometryType === 'line') {
        // 线状图层：无"边框颜色"项，"图形颜色"即线条颜色。
        // 兼容旧版本设置（旧版线色保存在 borderColor），优先用它回填图形颜色
        const legacyLineColor = currentColorSettings?.borderColor
        setFillColor(legacyLineColor && legacyLineColor !== NO_FILL_COLOR
          ? legacyLineColor
          : (currentColorSettings?.fillColor || '#8b5cf6'))
        setBorderColor(NO_FILL_COLOR)
      } else {
        setFillColor(currentColorSettings?.fillColor || '#3b82f6')
        // 点/面图层边框颜色默认无色；已保存值（含旧版黑色/自定义色）原样保留
        setBorderColor(currentColorSettings?.borderColor
          || (borderColorSupportsNone ? NO_FILL_COLOR : '#000000'))
      }
      // 点图层"图形大小"：已保存值原样保留，无则用默认 6px
      setPointSize(currentColorSettings?.pointSize ?? (isPointType ? 6 : 1))
      // 小区PCI渲染：已保存值原样保留，无则默认关闭、模3
      setPciRenderEnabled(currentColorSettings?.pciRenderEnabled ?? false)
      setPciMod(currentColorSettings?.pciMod ?? 3)

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
        setThematicFillOpacityPct(Math.round((ts.fillOpacity ?? 1) * 100))
        // 点/面专题描边默认无色；已保存值原样保留；线要素不显示该项
        setThematicBorderColor(ts.borderColor
          || (borderColorSupportsNone ? NO_FILL_COLOR : '#000000'))
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
        setThematicFillOpacityPct(100)
        setThematicBorderColor(borderColorSupportsNone ? NO_FILL_COLOR : '#000000')
        setThematicShowStats(true)
      }
      // 热力图设置回填
      const hs = currentHeatmapSettings
      if (hs && hs.enabled) {
        setHeatEnabled(true)
        setHeatField(hs.field || '')
        setHeatSmooth(hs.smooth ?? DEFAULT_HEATMAP_SETTINGS.smooth)
        // 旧持久化迁移：无 method 时按旧 colorScale 推断（'linear' 等值域 → 等效范围）
        const legacyScale = (hs as HeatmapSettings & { colorScale?: string }).colorScale
        setHeatMethod(hs.method ?? (legacyScale === 'linear' ? 'valueRange' : 'cellCount'))
        // 回填归一化：越界值会让滑块位置与状态脱节、不在白名单的值会让下拉渲染为空选
        const inflections = hs.inflections ?? DEFAULT_HEATMAP_SETTINGS.inflections!
        const round = hs.round ?? DEFAULT_HEATMAP_SETTINGS.round!
        setHeatInflections(HEATMAP_INFLECTION_OPTIONS.includes(inflections) ? inflections : DEFAULT_HEATMAP_SETTINGS.inflections!)
        setHeatRound(HEATMAP_ROUND_OPTIONS.includes(round) ? round : DEFAULT_HEATMAP_SETTINGS.round!)
        setHeatContrastPct(clampPct((hs.contrast ?? 1) * 100, HEATMAP_CONTRAST_RANGE.min, HEATMAP_CONTRAST_RANGE.max))
        setHeatOpacityPct(clampPct((hs.opacity ?? 1) * 100, HEATMAP_OPACITY_RANGE.min, HEATMAP_OPACITY_RANGE.max))
        setHeatDetail(clampPct(hs.detail ?? DEFAULT_HEATMAP_SETTINGS.detail!, HEATMAP_PCT_RANGE.min, HEATMAP_PCT_RANGE.max))
        setHeatSampling(Math.min(HEATMAP_SAMPLING_RANGE.max, Math.max(HEATMAP_SAMPLING_RANGE.min, Math.round(hs.sampling ?? DEFAULT_HEATMAP_SETTINGS.sampling!))))
        setHeatSampleMode(hs.sampleMode === 'original' ? 'original' : 'grid')
        setHeatDiscrete(hs.discrete ?? DEFAULT_HEATMAP_SETTINGS.discrete ?? true)
        setHeatLevelSoftness(hs.levelSoftness ?? DEFAULT_HEATMAP_SETTINGS.levelSoftness!)
        setHeatConcentration(hs.concentration ?? DEFAULT_HEATMAP_SETTINGS.concentration!)
        setHeatLevelOverrides(hs.levels && hs.levels.length >= 2 ? hs.levels : null)
        setHeatColorPickerRow(null)
        setHeatLevelDrafts({})
        setHeatColorScheme(hs.colorScheme || 'default')
        setHeatLegendOrder(hs.legendOrder ?? (hs.colorDirection === 'reverse' ? 'asc' : DEFAULT_HEATMAP_SETTINGS.legendOrder!))
        setHeatBoundaryLayerId(hs.boundaryLayerId ?? '')
        setHeatShowOriginal(hs.showOriginal !== false)
      } else {
        setHeatEnabled(false)
        setHeatField('')
        setHeatSmooth(DEFAULT_HEATMAP_SETTINGS.smooth)
        setHeatMethod(DEFAULT_HEATMAP_SETTINGS.method ?? 'cellCount')
        setHeatInflections(DEFAULT_HEATMAP_SETTINGS.inflections!)
        setHeatRound(DEFAULT_HEATMAP_SETTINGS.round!)
        setHeatContrastPct(DEFAULT_HEATMAP_SETTINGS.contrast! * 100)
        setHeatOpacityPct(DEFAULT_HEATMAP_SETTINGS.opacity! * 100)
        setHeatDetail(DEFAULT_HEATMAP_SETTINGS.detail!)
        setHeatSampling(DEFAULT_HEATMAP_SETTINGS.sampling!)
        setHeatSampleMode(DEFAULT_HEATMAP_SETTINGS.sampleMode!)
        setHeatDiscrete(DEFAULT_HEATMAP_SETTINGS.discrete ?? true)
        setHeatLevelSoftness(DEFAULT_HEATMAP_SETTINGS.levelSoftness!)
        setHeatConcentration(DEFAULT_HEATMAP_SETTINGS.concentration!)
        setHeatLevelOverrides(null)
        setHeatColorPickerRow(null)
        setHeatColorScheme(DEFAULT_HEATMAP_SETTINGS.colorScheme)
        setHeatLegendOrder(DEFAULT_HEATMAP_SETTINGS.legendOrder!)
        setHeatBoundaryLayerId('')
        setHeatShowOriginal(DEFAULT_HEATMAP_SETTINGS.showOriginal)
      }
      setHeatError('')
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

  /** 样本是否已就绪（未就绪时字段类型无法判定） */
  const hasFieldSamples = Object.keys(thematicFieldSamples).length > 0

  /** 样本就绪后按类型判定为数值的字段（未就绪时为空） */
  const sampledNumericFieldOptions = hasFieldSamples
    ? fieldOptions.filter(opt => detectFieldType(thematicFieldSamples[opt.value]) === 'numeric')
    : []

  /** 数值字段候选：样本尚未到达时先返回全量，保存时再做一次数值校验，避免异步样本延迟导致下拉为空 */
  const numericFieldOptions = hasFieldSamples ? sampledNumericFieldOptions : fieldOptions

  /**
   * 热力图"权重字段"下拉清单：
   * - 基站（扇区）图层：与"专题图层"属性字段清单完全一致（同一份 fieldOptions）。
   *   样本判定会漏掉仅用于几何渲染的数值字段（方位角/波瓣角等），逐字段数值过滤会让清单比专题少；
   *   非数值字段无法生成热力，统一在保存时提示，不在此处隐藏；
   * - 其他图层：仍按样本数值过滤（字段来自真实数据列，文本列不能作为权重）。
   */
  const heatFieldOptions = sectorColorMode
    ? fieldOptions
    : numericFieldOptions

  /**
   * 自动默认权重字段候选：只在"样本已验证为数值"的字段中挑，
   * 避免样本到达前把文本字段（如小区名称）选成默认权重导致热力为空。
   */
  const heatAutoFieldOptions = sampledNumericFieldOptions

  // 热力字段自动选择：启用状态下数值候选就绪且当前字段为空/已不在清单中时，选第一个数值字段
  useEffect(() => {
    if (!isOpen || !heatEnabled) return
    if (heatAutoFieldOptions.length === 0) return
    if (!heatField || !heatFieldOptions.some(o => o.value === heatField)) {
      setHeatField(heatAutoFieldOptions[0].value)
      setHeatError('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatAutoFieldOptions.length, heatFieldOptions.length, isOpen, heatEnabled])

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

  /** 组装基础图形设置 payload（保存与实时预览共用） */
  const buildColorPayload = (): LayerColorSettings => ({
    fillColor,
    fillOpacity: fillOpacityPct / 100,
    borderWidth,
    borderColor,
    // 点图层基础设置"图形大小"（点要素半径 px）
    ...(isPointBasic ? { pointSize } : {}),
    // 基站扇区图层：小区PCI渲染开关 + 模3/模30 方式
    ...(sectorColorMode ? { pciRenderEnabled, pciMod } : {}),
  })

  /** 组装专题设置：未启用/条件不完整 → null（保存与实时预览共用） */
  const buildThematicPayload = (): ThematicSettings | null => {
    if (!(thematicEnabled && thematicField && thematicFieldType)) return null
    return {
      enabled: true,
      field: thematicField,
      fieldType: thematicFieldType,
      colorMode: thematicFieldType === 'numeric' ? thematicColorMode : undefined,
      pointSize: thematicPointSize,
      fillOpacity: thematicFillOpacityPct / 100,
      borderColor: thematicBorderColor,
      showStats: thematicShowStats,
      ranges: thematicRanges,
      valueColors: thematicFieldType === 'numeric' && thematicColorMode === 'value' ? thematicValueColors : [],
      categories: thematicCategories,
    }
  }

  /** 组装热力图设置：未启用 → null（保存与实时预览共用） */
  const buildHeatmapPayload = (): HeatmapSettings | null => {
    if (!heatEnabled) return null
    // 未手工编辑分级时携带内置默认占比（与地图/图例同源）；其它情况保持自动分级
    const levels = heatLevelOverrides ?? (usesDefaultHeatLevels ? defaultHeatLevels : null)
    return {
      enabled: true,
      field: heatField,
      smooth: heatSmooth,
      smoothVersion: HEATMAP_SETTINGS_VERSION,
      method: heatMethod,
      inflections: heatInflections,
      round: heatRound,
      contrast: heatContrastPct / 100,
      opacity: heatOpacityPct / 100,
      detail: heatDetail,
      sampling: heatSampling,
      sampleMode: heatSampleMode,
      discrete: heatDiscrete,
      levelSoftness: heatLevelSoftness,
      concentration: heatConcentration,
      levels: levels ?? undefined,
      colorScheme: heatColorScheme,
      colorDirection: heatColorDirection,
      legendOrder: heatLegendOrder,
      boundaryLayerId: heatBoundaryLayerId || undefined,
      boundaryDataId: heatBoundaryLayerId
        ? polygonLayers.find(l => l.id === heatBoundaryLayerId)?.dataId
        : undefined,
      boundarySource: heatBoundaryLayerId
        ? polygonLayers.find(l => l.id === heatBoundaryLayerId)?.source
        : undefined,
      showOriginal: heatShowOriginal,
    }
  }

  // 保存设置（根据当前标签页决定保存哪个）
  const handleSave = () => {
    if (activeTab === 'color') {
      // 互斥前置：专题图层与热力图不能同时开启。
      // 必须在任何 onSave 回调之前判断两个开关的最终状态——否则 onSaveThematic 先、
      // onSaveHeatmap 后，分散在 LayerControl 各 handler 中检查会依赖调用顺序与 store
      // 旧状态，在"关一个开另一个"时产生时序误判。冲突时不保存任何内容并提示。
      if (showThematicTab && thematicEnabled && heatEnabled) {
        useToastStore.getState().show(
          colorSubTab === 'heatmap' ? t('map.conflictEnableHeatmap') : t('map.conflictEnableThematic')
        )
        return
      }
      // 热力图校验前置：启用但无可用数值字段/未选字段/选中字段为文本类时，阻断本次全部保存并提示
      if (showThematicTab && heatEnabled) {
        if (!loadingThematicSamples && hasFieldSamples && numericFieldOptions.length === 0) {
          setHeatError(t('map.heatmapNoNumericFields'))
          setColorSubTab('heatmap')
          return
        }
        if (!heatField) {
          setHeatError(t('map.heatmapFieldRequired'))
          setColorSubTab('heatmap')
          return
        }
        // 样本就绪后所选字段被识别为文本类：阻断，避免存了文本字段导致渲染为空
        // （基站图层清单与专题一致，含文本字段，因此这里必须逐字段校验；
        //  覆盖类型/是否共享/厂家为展示别名，需映射回真实字段名后再查样本）
        const heatSampleKey = sectorColorMode ? resolveSectorField(heatField) : heatField
        if (!loadingThematicSamples && hasFieldSamples && detectFieldType(thematicFieldSamples[heatSampleKey]) === 'text') {
          setHeatError(t('map.heatmapFieldNotNumeric'))
          setColorSubTab('heatmap')
          return
        }
      }
      // 总是同时保存基础配置与专题配置（两套独立存储，互不覆盖）
      onSaveColor?.(buildColorPayload())
      if (showThematicTab) {
        onSaveThematic?.(buildThematicPayload())
        // 热力图独立于专题保存（两者可共存；启用校验已在保存前完成）
        if (onSaveHeatmap) onSaveHeatmap(buildHeatmapPayload())
      }
    } else {
      // 修复：确保content不为空字符串，如果为空则使用默认值
      const validContent = (content && content !== '')
        ? content
        : (fieldOptions[0]?.value || 'name')
      onSave({ content: validContent, color, fontSize, fontFamily, bold, italic, shadow, background, backgroundColor })
    }
    onClose()
  }

  // 获取当前选中字段的显示名称
  const getSelectedFieldLabel = () => {
    const selected = fieldOptions.find(opt => opt.value === content)
    return selected?.label || content
  }

  /** 当前应预览的目标（随激活页/子页与表单值变化）；保存与预览共用 payload 构造 */
  type PreviewTarget =
    | { kind: 'label'; payload: LabelSettings }
    | { kind: 'color'; payload: LayerColorSettings }
    | { kind: 'thematic'; payload: ThematicSettings | null }
    | { kind: 'heatmap'; payload: HeatmapSettings | null }

  const buildPreviewTarget = (): PreviewTarget => {
    if (activeTab === 'label') {
      const validContent = (content && content !== '')
        ? content
        : (fieldOptions[0]?.value || 'name')
      return {
        kind: 'label',
        payload: {
          content: validContent, color, fontSize, fontFamily,
          bold, italic, shadow, background, backgroundColor,
        },
      }
    }
    if (colorSubTab === 'thematic') return { kind: 'thematic', payload: buildThematicPayload() }
    if (colorSubTab === 'heatmap') return { kind: 'heatmap', payload: buildHeatmapPayload() }
    return { kind: 'color', payload: buildColorPayload() }
  }

  const previewSig = (t: PreviewTarget): string => `${t.kind}|${JSON.stringify(t.payload)}`

  /** 预览"已下发基线"签名：用来打断 下发→重渲染→再下发 的自激循环 */
  const previewBaselineRef = useRef('')
  /**
   * 打开后的"初始化抑制"：props→表单 的同步 effect（及 fieldOptions 到达后的自动
   * 选字段）会程序化改变签名，抑制期内只把签名吸收进基线、不下发，保证打开瞬间
   * 不改变地图/不冒标签。
   */
  const previewSuppressRef = useRef(false)

  // 打开：置抑制并记录初始基线，350ms 后解除（覆盖表单同步）；关闭：复位
  useEffect(() => {
    if (isOpen) {
      previewSuppressRef.current = true
      previewBaselineRef.current = previewSig(buildPreviewTarget())
      const release = window.setTimeout(() => { previewSuppressRef.current = false }, 350)
      return () => window.clearTimeout(release)
    }
    previewSuppressRef.current = false
    previewBaselineRef.current = ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // 实时预览：仅签名实际变化（用户改值/切页）且不在初始化抑制期时 debounce 下发；
  // 下发引起的父级重渲染签名与基线相同 → 不再下发，循环终止。cleanup 清旧定时器。
  useEffect(() => {
    if (!isOpen) return
    const target = buildPreviewTarget()
    const sig = previewSig(target)
    if (sig === previewBaselineRef.current) return
    previewBaselineRef.current = sig
    if (previewSuppressRef.current) return
    const timer = window.setTimeout(() => {
      switch (target.kind) {
        case 'label': onPreview?.(target.payload); break
        case 'color': onPreviewColor?.(target.payload); break
        case 'thematic': onPreviewThematic?.(target.payload); break
        case 'heatmap': onPreviewHeatmap?.(target.payload); break
      }
    }, 200)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })

  // 如果弹窗未打开，不渲染任何内容
  if (!isOpen) return null

  return (
    <FloatingPanel
      title={title}
      onClose={() => { onCancel?.(); onClose() }}
      storageKey="npt.layerSettings.rect"
      initialRect={INITIAL_RECT}
      getBounds={() => document.querySelector('.map-container') as HTMLElement | null}
    >
      {/* 内容区 - 固定高度内滚动 */}
      <div className="flex-1 overflow-y-auto min-h-0 px-5 pt-4 pb-2">
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
                <div className="relative" ref={fieldDropdownRef}>
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
                className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
              />
            </div>

            {/* 字体（预设系统字体，按 CSS font-family 栈逐级回退） */}
            <div className="mb-4">
              <label className="block text-xs text-muted-foreground mb-2">{t('map.fontFamily')}</label>
              <select
                value={fontFamily}
                onChange={(e) => setFontFamily(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-border rounded bg-background text-foreground"
              >
                {FONT_FAMILY_OPTIONS.map((opt) => (
                  <option key={opt.label} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 字体效果：加粗 / 斜体 / 阴影 */}
            <div className="mb-4">
              <label className="block text-xs text-muted-foreground mb-2">{t('map.fontEffect')}</label>
              <div className="flex gap-1.5">
                {([
                  { key: 'bold', label: t('map.fontEffectBold'), active: bold, onToggle: () => setBold(!bold) },
                  { key: 'italic', label: t('map.fontEffectItalic'), active: italic, onToggle: () => setItalic(!italic) },
                  { key: 'shadow', label: t('map.fontEffectShadow'), active: shadow, onToggle: () => setShadow(!shadow) },
                ] as const).map((eff) => (
                  <button
                    key={eff.key}
                    type="button"
                    onClick={eff.onToggle}
                    className={`flex-1 px-3 py-1.5 text-xs rounded-md border transition-colors font-medium ${eff.active
                      ? 'bg-primary/10 text-primary border-primary/40'
                      : 'bg-background text-muted-foreground border-border hover:text-foreground'
                      }`}
                  >
                    {eff.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 字体背景：无 / 光晕 / 框形（互斥），halo/box 时可选背景颜色 */}
            <div className="mb-4">
              <label className="block text-xs text-muted-foreground mb-2">{t('map.labelBackground')}</label>
              <div className="flex gap-1.5 mb-2">
                {([
                  { key: 'none', label: t('map.labelBgNone') },
                  { key: 'halo', label: t('map.labelBgHalo') },
                  { key: 'box', label: t('map.labelBgBox') },
                ] as const).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setBackground(opt.key)}
                    className={`flex-1 px-3 py-1.5 text-xs rounded-md border transition-colors font-medium ${background === opt.key
                      ? 'bg-primary/10 text-primary border-primary/40'
                      : 'bg-background text-muted-foreground border-border hover:text-foreground'
                      }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {background !== 'none' && (
                <ColorField value={backgroundColor} onChange={setBackgroundColor} />
              )}
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
                <button
                  type="button"
                  onClick={() => setColorSubTab('heatmap')}
                  className={`flex-1 px-3 py-1.5 text-xs rounded-md transition-colors font-medium ${colorSubTab === 'heatmap'
                    ? 'bg-background text-primary shadow-sm border border-border'
                    : 'text-muted-foreground hover:text-foreground'
                    }`}
                >
                  {t('map.heatmapLayer')}
                </button>
              </div>
            )}

            {/* ===== 基础配置子页 ===== */}
            {colorSubTab === 'basic' && (
              <div className={thematicEnabled ? 'opacity-50 pointer-events-none select-none' : ''}>
                {thematicEnabled && (
                  <div className="mb-3 px-3 py-2 text-xs rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">
                    {t('map.thematicActiveHint')}
                  </div>
                )}
                {/* 图形大小（点图层基础配置新增：点要素半径设置） */}
                {isPointBasic && (
                  <div className="mb-4">
                    <label className="block text-xs text-muted-foreground mb-2">
                      {t('map.thematicPointSizeUnit', { size: pointSize })}
                    </label>
                    <input
                      type="range"
                      min={sizeMin}
                      max={sizeMax}
                      step="1"
                      value={pointSize}
                      onChange={(e) => setPointSize(Number(e.target.value))}
                      className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
                    />
                  </div>
                )}

                {/* 图形颜色（填充色）- 扇区图层默认按频点区分颜色，不提供图形颜色设置项 */}
                {!sectorColorMode && (
                  <div className="mb-4">
                    <label className="block text-xs text-muted-foreground mb-2">{t('map.fillColor')}</label>
                    <ColorField value={fillColor} onChange={setFillColor} allowNoFill />
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
                    className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
                  />
                </div>

                {/* 边框宽度（线状图层为"线宽"） */}
                <div className="mb-4">
                  <label className="block text-xs text-muted-foreground mb-2">
                    {isLineType
                      ? t('map.lineWidthUnit', { size: borderWidth })
                      : t('map.borderWidthUnit', { size: borderWidth })}
                  </label>
                  <input
                    type="range"
                    min="1"
                    max="8"
                    step="1"
                    value={borderWidth}
                    onChange={(e) => setBorderWidth(Number(e.target.value))}
                    className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
                  />
                </div>

                {/* 边框颜色 - 扇区图层按频点配色不提供；线状图层无描边项；
                    点/面图层提供「无色」选项且默认无色（不描边） */}
                {!sectorColorMode && !isLineType && (
                  <div className="mb-4">
                    <label className="block text-xs text-muted-foreground mb-2">{t('map.borderColor')}</label>
                    <ColorField
                      value={borderColor}
                      onChange={setBorderColor}
                      allowNoFill={borderColorSupportsNone}
                      noColorTitle={t('map.noBorderColor')}
                    />
                  </div>
                )}

                {/* 小区PCI渲染（仅基站扇区图层默认设置）：开关 + 模3/模30 方式 */}
                {sectorColorMode && (
                  <>
                    <div className="flex items-center justify-between mb-4">
                      <label className="text-xs text-muted-foreground">{t('map.pciRender')}</label>
                      <button
                        type="button"
                        onClick={() => setPciRenderEnabled(!pciRenderEnabled)}
                        className={`relative w-9 h-5 rounded-full transition-colors ${pciRenderEnabled ? 'bg-primary' : 'bg-muted'}`}
                      >
                        <span
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${pciRenderEnabled ? 'left-[18px]' : 'left-0.5'}`}
                        />
                      </button>
                    </div>
                    {pciRenderEnabled && (
                      <div className="mb-4">
                        <div className="flex gap-1.5">
                          {([3, 30] as const).map((mod) => (
                            <button
                              key={mod}
                              type="button"
                              onClick={() => setPciMod(mod)}
                              className={`flex-1 px-3 py-1.5 text-xs rounded-md border transition-colors font-medium ${pciMod === mod
                                ? 'bg-primary/10 text-primary border-primary/40'
                                : 'bg-background text-muted-foreground border-border hover:text-foreground'
                                }`}
                            >
                              {mod === 3 ? t('map.pciMod3') : t('map.pciMod30')}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
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
                    className={`relative w-9 h-5 rounded-full transition-colors ${thematicEnabled ? 'bg-primary' : 'bg-muted'}`}
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
                        className={`relative w-9 h-5 rounded-full transition-colors ${thematicShowStats ? 'bg-primary' : 'bg-muted'}`}
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
                                    className="p-1 rounded hover:bg-red-500/15 text-red-400 hover:text-red-600 transition-colors"
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
                                <div className="relative" ref={thematicTplRef}>
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
                                            className="p-1 rounded hover:bg-red-500/15 text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
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
                                  className="p-1 rounded hover:bg-red-500/15 text-red-400 hover:text-red-600 transition-colors"
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
                                  <div className="px-3 py-2 text-xs rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">
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
                                <div className="px-3 py-2 text-xs rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">
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
                                className="p-1 rounded hover:bg-red-500/15 text-red-400 hover:text-red-600 transition-colors"
                                title={t('map.thematicRemoveRange')}
                              >
                                <Trash2 size={12} />
                              </button>
                            )}
                          </div>
                        ))}
                        {/* 未覆盖配色提示 */}
                        {thematicCategories.length > 0 && getUncoveredValues(thematicFieldSamples[thematicField], thematicCategories).length > 0 && (
                          <div className="px-3 py-2 text-xs rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">
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
                            className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
                          />
                        </div>

                        {/* 图形透明度（线要素作用于线条透明度） */}
                        <div>
                          <label className="block text-xs text-muted-foreground mb-2">
                            {t('map.fillOpacityUnit', { value: thematicFillOpacityPct })}
                          </label>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="1"
                            value={thematicFillOpacityPct}
                            onChange={(e) => setThematicFillOpacityPct(Number(e.target.value))}
                            className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
                          />
                        </div>

                        {/* 边框颜色（线要素无描边，不提供此项；点/面支持无色且默认无色） */}
                        {thematicGeometryType !== 'line' && (
                          <div>
                            <label className="block text-xs text-muted-foreground mb-2">{t('map.borderColor')}</label>
                            <ColorField
                              value={thematicBorderColor}
                              onChange={setThematicBorderColor}
                              allowNoFill={borderColorSupportsNone}
                              noColorTitle={t('map.noBorderColor')}
                            />
                          </div>
                        )}

                    {/* 无样本提示 */}
                    {!loadingThematicSamples && thematicFieldType === null && (
                      <div className="px-3 py-2 text-xs rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">
                        {t('map.thematicNoDataHint')}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ===== 热力图子页 ===== */}
            {showThematicTab && colorSubTab === 'heatmap' && (
              <div className="space-y-4">
                {/* 启用开关 */}
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">{t('map.heatmapEnable')}</label>
                  <button
                    type="button"
                    onClick={() => { setHeatEnabled(!heatEnabled); setHeatError('') }}
                    className={`relative w-9 h-5 rounded-full transition-colors ${heatEnabled ? 'bg-primary' : 'bg-muted'}`}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${heatEnabled ? 'left-[18px]' : 'left-0.5'}`}
                    />
                  </button>
                </div>

                {!heatEnabled && (
                  <div className="px-3 py-2 text-xs rounded bg-muted/50 text-muted-foreground">
                    {t('map.heatmapDisabledHint')}
                  </div>
                )}

                {heatEnabled && (
                  <>
                    {/* 设置模板：保存当前各项设置 / 一键套用到同类图层 */}
                    <div className="pt-1">
                      <label className="block text-xs text-muted-foreground mb-2">{t('map.heatmapTemplate')}</label>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={heatTemplateName}
                          onChange={(e) => setHeatTemplateName(e.target.value)}
                          placeholder={t('map.heatmapTemplateName')}
                          className="flex-1 min-w-0 px-2 py-1 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const name = heatTemplateName.trim()
                            if (!name) return
                            onSaveHeatmapTemplate?.(name, buildHeatmapTemplateSettings())
                            setHeatTemplateName('')
                          }}
                          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors shrink-0"
                        >
                          <Plus size={12} />
                          {t('map.heatmapTemplateSave')}
                        </button>
                      </div>
                      {heatmapTemplates.length > 0 && (
                        <div className="mt-1.5">
                          {/* 模板选择：固化标签，下拉框另起一行 */}
                          <label className="block text-xs text-muted-foreground mb-1.5">
                            {t('map.heatmapTemplateApply')}
                          </label>
                          <div className="relative" ref={heatTplRef}>
                            <button
                              type="button"
                              onClick={() => setHeatTemplateDropdownOpen(!heatTemplateDropdownOpen)}
                              className="w-full px-2 py-1.5 text-xs border border-border rounded bg-background text-left flex items-center justify-between hover:border-primary/50 transition-colors"
                            >
                              <span className={`truncate ${heatSelectedTemplateName ? 'text-foreground' : 'text-muted-foreground'}`}>
                                {heatSelectedTemplateName || t('map.heatmapTemplatePlaceholder')}
                              </span>
                              <ChevronDown size={14} className={`transition-transform ${heatTemplateDropdownOpen ? 'rotate-180' : ''}`} />
                            </button>
                            {heatTemplateDropdownOpen && (
                              <div className="absolute z-20 w-full mt-1 bg-background border border-border rounded shadow-lg max-h-48 overflow-y-auto">
                                {heatmapTemplates.map((tmpl) => (
                                  <div key={tmpl.id} className="flex items-center px-2 py-1.5 hover:bg-muted transition-colors group">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        applyHeatmapTemplate(tmpl)
                                        setHeatTemplateDropdownOpen(false)
                                      }}
                                      className="flex-1 text-left text-xs truncate"
                                      title={tmpl.name}
                                    >
                                      {tmpl.name}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => onRemoveHeatmapTemplate?.(tmpl.id)}
                                      className="p-1 rounded hover:bg-red-500/15 text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                      title={t('map.thematicTemplateDelete')}
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 权重数值字段 + 渲染边界（双列） */}
                    <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-muted-foreground mb-2">{t('map.heatmapField')}</label>
                      {/* 基站图层清单与专题一致（不依赖样本），无需等待样本加载 */}
                      {loadingThematicSamples && !sectorColorMode ? (
                        <div className="w-full px-3 py-2 text-xs border border-border rounded bg-background text-muted-foreground flex items-center gap-2">
                          <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 4.824 3 7.938l3-2.647z"></path>
                          </svg>
                          <span>{t('map.loadingFields')}</span>
                        </div>
                      ) : heatFieldOptions.length === 0 ? (
                        <div className="px-3 py-2 text-xs rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">
                          {t('map.heatmapNoNumericFields')}
                        </div>
                      ) : (
                        <ThematicFieldDropdown
                          options={heatFieldOptions}
                          value={heatField}
                          onChange={(v) => { setHeatField(v); setHeatError('') }}
                          emptyText={t('map.noAvailableFields')}
                        />
                      )}
                    </div>

                    {/* 渲染边界：按面图层裁剪，避免颜色漫出范围 */}
                    <div>
                      <label className="block text-xs text-muted-foreground mb-2">{t('map.heatmapBoundary')}</label>
                      <select
                        value={heatBoundaryLayerId}
                        onChange={(e) => setHeatBoundaryLayerId(e.target.value)}
                        className="w-full px-3 py-2 text-xs border border-border rounded bg-background text-foreground"
                      >
                        <option value="">{t('map.heatmapBoundaryNone')}</option>
                        {polygonLayers.map(layer => (
                          <option key={layer.id} value={layer.id}>{layer.name}</option>
                        ))}
                      </select>
                    </div>
                    </div>

                    {/* 平滑强度+细节增强（一行）/ 栅格采样+对比度（一行） */}
                    <div className="grid grid-cols-2 gap-3">
                    {/* 平滑强度：搜索半径 = 平均点间距 × 该值 */}
                    <div>
                      <label className="block text-xs text-muted-foreground mb-2">
                        {t('map.heatmapSmoothUnit', { value: heatSmooth })}
                      </label>
                      <input
                        type="range" min="1" max="10" step="0.5" value={heatSmooth}
                        onChange={(e) => setHeatSmooth(Number(e.target.value))}
                        className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
                      />
                    </div>


                    {/* 细节增强：整体趋势场 ↔ 栅格细节场凸组合比例（0=纯平滑，融合不超界） */}
                    <div>
                      <label className="block text-xs text-muted-foreground mb-2">
                        {t('map.heatmapDetailUnit', { value: heatDetail })}
                      </label>
                      <input
                        type="range"
                        min={HEATMAP_PCT_RANGE.min}
                        max={HEATMAP_PCT_RANGE.max}
                        step="5" value={heatDetail}
                        onChange={(e) => setHeatDetail(Number(e.target.value))}
                        className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
                      />
                    </div>

                    {/* 高值集中度：紧随平滑强度/细节增强下方，横跨两列。
                        仅压缩高端色、突出真正 100% 点位（滑块 50=不变） */}
                    <div className="col-span-2">
                      <label className="block text-xs text-muted-foreground mb-2">
                        {t('map.heatmapConcentrationUnit', { value: concentrationSlider })}
                      </label>
                      <input
                        type="range" min="0" max="100" step="2"
                        value={concentrationSlider}
                        onChange={(e) => setHeatConcentration(gammaFromSlider(Number(e.target.value)))}
                        className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
                      />
                    </div>

                    {/* 采样方式（圆圈单选同一行）：栅格采样 IDW / 原始采样逐点渲染不栅格化 */}
                    <div>
                      <div className="flex items-center gap-4 mb-2">
                        {/* 栅格采样 */}
                        <button
                          type="button"
                          onClick={() => setHeatSampleMode('grid')}
                          className="flex items-center gap-1.5"
                        >
                          <span className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center transition-colors ${
                            heatSampleMode === 'grid' ? 'border-primary' : 'border-muted-foreground/40'
                          }`}>
                            {heatSampleMode === 'grid' && (
                              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                            )}
                          </span>
                          <span className={`text-xs ${heatSampleMode === 'grid' ? 'text-foreground' : 'text-muted-foreground'}`}>
                            {t('map.heatmapSampleModeGrid')}
                          </span>
                        </button>
                        {/* 原始采样 */}
                        <button
                          type="button"
                          onClick={() => setHeatSampleMode('original')}
                          className="flex items-center gap-1.5"
                        >
                          <span className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center transition-colors ${
                            heatSampleMode === 'original' ? 'border-primary' : 'border-muted-foreground/40'
                          }`}>
                            {heatSampleMode === 'original' && (
                              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                            )}
                          </span>
                          <span className={`text-xs ${heatSampleMode === 'original' ? 'text-foreground' : 'text-muted-foreground'}`}>
                            {t('map.heatmapSampleModeOriginal')}
                          </span>
                        </button>
                      </div>
                      {/* 栅格粒度滑杆：仅栅格采样模式启用 */}
                      <label className="block text-xs text-muted-foreground mb-2">
                        {t('map.heatmapSamplingUnit', { value: heatSampling })}
                      </label>
                      <input
                        type="range"
                        min={HEATMAP_SAMPLING_RANGE.min}
                        max={HEATMAP_SAMPLING_RANGE.max}
                        step="1" value={heatSampling}
                        disabled={heatSampleMode === 'original'}
                        onChange={(e) => setHeatSampling(Number(e.target.value))}
                        className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                    </div>

                    {/* 对比度：颜色映射对比度（只作用于地图着色，不影响图例颜色） */}
                    <div>
                      <label className="block text-xs text-muted-foreground mb-2">
                        {t('map.heatmapContrastUnit', { value: (heatContrastPct / 100).toFixed(2) })}
                      </label>
                      <input
                        type="range"
                        min={HEATMAP_CONTRAST_RANGE.min}
                        max={HEATMAP_CONTRAST_RANGE.max}
                        step="5" value={heatContrastPct}
                        onChange={(e) => setHeatContrastPct(Number(e.target.value))}
                        className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
                      />
                    </div>
                    </div>

                    {/* 分级方法 + 分级数/取整（双列） */}
                    <div className="grid grid-cols-2 gap-3">
                    {/* 分级方法（参考 Surfer Grid Appearance 的 Method） */}
                    <div>
                      <label className="block text-xs text-muted-foreground mb-2">{t('map.heatmapMethod')}</label>
                      <select
                        value={heatMethod}
                        // 换分级方法即重新自动分级，丢弃此前的手工编辑
                        onChange={(e) => { setHeatMethod(e.target.value as HeatmapLegendMethod); clearLevelOverrides() }}
                        className="w-full px-3 py-2 text-xs border border-border rounded bg-background text-foreground"
                      >
                        <option value="cellCount">{t('map.heatmapMethodCellCount')}</option>
                        <option value="valueRange">{t('map.heatmapMethodValueRange')}</option>
                      </select>
                    </div>

                    {/* 分级数 + 取整精度（同级一行） */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs text-muted-foreground mb-2">{t('map.heatmapInflections')}</label>
                        <select
                          value={heatInflections}
                          // 改级数即重新自动分级，丢弃此前的手工编辑
                          onChange={(e) => { setHeatInflections(Number(e.target.value)); clearLevelOverrides() }}
                          className="w-full px-3 py-2 text-xs border border-border rounded bg-background text-foreground"
                        >
                          {HEATMAP_INFLECTION_OPTIONS.map(n => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-2">{t('map.heatmapRound')}</label>
                        <select
                          value={heatRound}
                          onChange={(e) => setHeatRound(Number(e.target.value))}
                          className="w-full px-3 py-2 text-xs border border-border rounded bg-background text-foreground"
                        >
                          {HEATMAP_ROUND_OPTIONS.map(r => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    </div>

                    {/* 分级列表（可编辑）：色块改颜色、输入框改占比/区间值，与地图图例同源 */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-xs text-muted-foreground">
                          {heatMethod === 'cellCount' ? t('map.heatmapLegendPercentage') : t('map.heatmapLegendValue')}
                        </label>
                        <div className="flex items-center gap-2">
                          <label className="text-[11px] text-muted-foreground">{t('map.heatmapLegendOrder')}</label>
                          <select
                            value={heatLegendOrder}
                            onChange={(e) => setHeatLegendOrder(e.target.value as 'asc' | 'desc')}
                            className="px-1.5 py-0.5 text-[11px] border border-border rounded bg-background text-foreground"
                          >
                            <option value="desc">{t('map.heatmapLegendOrderDesc')}</option>
                            <option value="asc">{t('map.heatmapLegendOrderAsc')}</option>
                          </select>
                          {heatLevelOverrides && (
                            <button
                              type="button"
                              onClick={resetLevelsToDefault}
                              className="text-[11px] text-primary hover:underline"
                            >
                              {t('map.heatmapLevelsReset')}
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="border border-border rounded bg-background p-2 space-y-1 max-h-56 overflow-y-auto">
                        {previewLevels
                          .map((lv, index) => ({ lv, index }))
                          // 按色带位置排序后按「图例标签顺序」显示：用户可能把某级占比改到
                          // 与相邻级交叉，数组原序不再单调，必须先排序（index 仍指向原分级）
                          .sort((a, b) => a.lv.t - b.lv.t)
                          .map((row, idx, arr) => heatLegendOrder === 'asc' ? row : arr[arr.length - 1 - idx])
                          .map(({ lv, index }) => (
                            <HeatLevelRowShell
                              key={index}
                              open={heatColorPickerRow === index}
                              onClose={() => setHeatColorPickerRow(null)}
                            >
                              <div className="flex items-center gap-2 text-xs">
                                <button
                                  type="button"
                                  onClick={() => setHeatColorPickerRow(heatColorPickerRow === index ? null : index)}
                                  className="inline-block w-5 h-4 rounded-sm border border-border shrink-0"
                                  style={{ backgroundColor: lv.color ?? gradientColorAt(previewStops, lv.t) }}
                                  title={t('map.heatmapLevelColor')}
                                />
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={levelInputText(index, lv)}
                                  onChange={(e) => handleLevelInput(index, e.target.value)}
                                  onBlur={() => handleLevelBlur(index)}
                                  className="w-16 px-1 py-0.5 text-xs border border-border rounded bg-background text-foreground text-right tabular-nums"
                                />
                                <span className="text-muted-foreground">
                                  {heatMethod === 'cellCount' ? '%' : ''}
                                </span>
                                <span className="text-[11px] text-muted-foreground/70 tabular-nums ml-auto">
                                  {formatLegendValue(lv.value, heatRound)}
                                </span>
                              </div>
                              {heatColorPickerRow === index && (
                                <HeatLevelColorPicker
                                  value={lv.color}
                                  onChange={(c) => updateLevel(index, { color: c })}
                                  onAuto={() => updateLevel(index, { color: null })}
                                  onClose={() => setHeatColorPickerRow(null)}
                                />
                              )}
                            </HeatLevelRowShell>
                          ))}
                      </div>
                    </div>

                    {/* 配色方案 */}
                    <div>
                      <label className="block text-xs text-muted-foreground mb-2">{t('map.heatmapColorScheme')}</label>
                      <select
                        value={heatColorScheme}
                        onChange={(e) => setHeatColorScheme(e.target.value as HeatmapColorScheme)}
                        className="w-full px-3 py-2 text-xs border border-border rounded bg-background text-foreground"
                      >
                        <option value="default">{t('map.heatmapSchemeDefault')}</option>
                        <option value="warm">{t('map.heatmapSchemeWarm')}</option>
                        <option value="cool">{t('map.heatmapSchemeCool')}</option>
                        <option value="viridis">{t('map.heatmapSchemeViridis')}</option>
                      </select>
                    </div>

                    {/* 渲染方式（分级/连续）+ 半透明度（双列） */}
                    <div className="grid grid-cols-2 gap-3">
                    {/* 渲染方式：开=分级渲染（等值区域，默认），关=连续渐变 */}
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-muted-foreground">{t('map.heatmapDiscrete')}</label>
                      <button
                        type="button"
                        onClick={() => setHeatDiscrete(!heatDiscrete)}
                        className={`relative w-9 h-5 rounded-full transition-colors ${heatDiscrete ? 'bg-primary' : 'bg-muted'}`}
                      >
                        <span
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${heatDiscrete ? 'left-[18px]' : 'left-0.5'}`}
                        />
                      </button>
                    </div>

                    {/* 半透明度：插值层整体不透明度 */}
                    <div>
                      <label className="block text-xs text-muted-foreground mb-2">
                        {t('map.heatmapOpacityUnit', { value: heatOpacityPct })}
                      </label>
                      <input
                        type="range"
                        min={HEATMAP_OPACITY_RANGE.min}
                        max={HEATMAP_OPACITY_RANGE.max}
                        step="5" value={heatOpacityPct}
                        onChange={(e) => setHeatOpacityPct(Number(e.target.value))}
                        className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
                      />
                    </div>
                    </div>

                    {/* 分级边界柔化：仅分级模式显示（0=硬等值线、1=全连续） */}
                    {heatDiscrete && (
                      <div>
                        <label className="block text-xs text-muted-foreground mb-2">
                          {t('map.heatmapSoftnessUnit', { value: Math.round(heatLevelSoftness * 100) })}
                        </label>
                        <input
                          type="range" min="0" max="100" step="5"
                          value={Math.round(heatLevelSoftness * 100)}
                          onChange={(e) => setHeatLevelSoftness(Number(e.target.value) / 100)}
                          className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
                        />
                      </div>
                    )}

                    {/* 显示原图层开关 */}
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-muted-foreground">{t('map.heatmapShowOriginal')}</label>
                      <button
                        type="button"
                        onClick={() => setHeatShowOriginal(!heatShowOriginal)}
                        className={`relative w-9 h-5 rounded-full transition-colors ${heatShowOriginal ? 'bg-primary' : 'bg-muted'}`}
                      >
                        <span
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${heatShowOriginal ? 'left-[18px]' : 'left-0.5'}`}
                        />
                      </button>
                    </div>

                    {/* 校验错误 */}
                    {heatError && (
                      <div className="px-3 py-2 text-xs rounded bg-destructive/10 border border-destructive/20 text-destructive">
                        {heatError}
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
        <div className="flex gap-2 px-5 pb-4 pt-1">
          <button
            onClick={() => { onCancel?.(); onClose() }}
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
    </FloatingPanel>
  )
}