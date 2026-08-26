/**
 * 要素属性字段取值工具（专题图层共用）
 *
 * 两类图层数据模型的属性存储方式不同，取值必须兼容两种结构：
 * - MapInfoLayer：扁平 `feature.properties`（后端 GeoJSON，含 `_style` 子对象）
 * - GeoDataLayer：嵌套 `item.properties.properties.<列>`（OnlineMap 把整条后端 item
 *   塞进 properties，原始列在嵌套 properties/attributes 内）
 *
 * 类型检测 / 唯一值提取 / 渲染取值必须全部走本函数，保证检测与渲染同源。
 */

/**
 * 从属性对象中解析字段值（两级查找：根级 → 嵌套 properties/attributes）
 * @param props 要素属性对象（可为 null/undefined）
 * @param field 字段名
 * @returns 字段值；未找到返回 undefined
 */
export function getFieldValue(props: Record<string, any> | null | undefined, field: string): any {
  if (!props || !field) return undefined
  if (props[field] !== undefined && props[field] !== null) return props[field]
  const nested = props.properties || props.attributes
  if (nested && typeof nested === 'object') {
    const v = (nested as Record<string, any>)[field]
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

/**
 * 判断值是否为"有效非空"（排除 '' / null / undefined / 纯空白）
 */
export function hasValue(v: any): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'string' && v.trim() === '') return false
  return true
}

/**
 * 判断值是否为数值（排除空字符串后 Number('')===0 陷阱）
 */
export function isNumericValue(v: any): boolean {
  if (!hasValue(v)) return false
  if (typeof v === 'number') return Number.isFinite(v)
  const s = String(v).trim()
  if (s === '') return false
  return Number.isFinite(Number(s))
}

/**
 * 将值转为数值；无法转换返回 null
 */
export function toNumber(v: any): number | null {
  if (!isNumericValue(v)) return null
  return Number(v)
}

/**
 * 专题未匹配/空值/未分配时的兜底色（需求：默认黑色）
 */
export const THEMATIC_FALLBACK_COLOR = '#000000'

/**
 * 属性值配色极限（唯一值不多于该数量时全量配色；超过后其余未分配的值渲染为黑色）
 */
export const THEMATIC_VALUE_LIMIT = 1800

/**
 * 字段值样本（含质心坐标，用于地理隔离配色：相邻位置的属性值分配差异大的颜色）
 */
export interface FieldValueSample {
  v: any      // 字段值
  lat: number // 该值要素的质心纬度
  lng: number // 该值要素的质心经度
}

/**
 * 按专题设置匹配原始字段值 → 颜色
 * 数值类：
 * - colorMode='range'（默认）：区间匹配（min 含、max 不含；末段 max 含；重叠取首个匹配）
 * - colorMode='value'：属性值精确匹配 valueColors
 * 文本类：值精确匹配，'__other__' 兜底
 * 未匹配/空值/未分配 → 黑色
 */
export function matchThematicColor(
  ts: {
    fieldType: 'numeric' | 'text'
    colorMode?: 'range' | 'value'
    ranges: { min: number; max: number; color: string }[]
    categories: { value: string; color: string }[]
    valueColors?: { value: string; color: string }[]
  },
  raw: any
): string {
  if (!hasValue(raw)) return THEMATIC_FALLBACK_COLOR

  if (ts.fieldType === 'numeric') {
    // 属性值配色模式：按值精确匹配
    if (ts.colorMode === 'value' && ts.valueColors?.length) {
      const str = String(raw)
      const matched = ts.valueColors.find(c => c.value === str)
      return matched?.color || THEMATIC_FALLBACK_COLOR
    }
    // 区间配色模式（默认）
    const idx = matchRangeIndex(ts, raw)
    return idx >= 0 ? ts.ranges[idx].color : THEMATIC_FALLBACK_COLOR
  }

  // 文本类
  const str = String(raw)
  let matched = ts.categories.find(c => c.value === str)
  if (!matched) matched = ts.categories.find(c => c.value === '__other__')
  return matched?.color || THEMATIC_FALLBACK_COLOR
}

/**
 * 匹配数值字段所属区间下标（min 含、max 不含；末段 max 含；重叠取首个匹配）
 * @returns 区间下标；无法匹配返回 -1
 */
export function matchRangeIndex(
  ts: { ranges: { min: number; max: number }[] },
  raw: any
): number {
  const num = toNumber(raw)
  if (num === null) return -1
  for (let i = 0; i < ts.ranges.length; i++) {
    const r = ts.ranges[i]
    const isLast = i === ts.ranges.length - 1
    if (num >= r.min && (isLast ? num <= r.max : num < r.max)) return i
  }
  return -1
}

/**
 * 生成 N 个互不相同的颜色（HSL 色相均匀分布）
 */
export function generateDistinctColors(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `hsl(${Math.round((i * 360) / Math.max(n, 1))}, 70%, 50%)`)
}

/**
 * 按质心空间位置生成地理隔离配色（黄金角色相）
 * - 按经度/纬度排序使空间相邻的属性值相邻
 * - 黄金角 137.508° 递进取色相：相邻序号的色相差固定较大，避免相邻位置同色
 */
export function generateGeoIsolatedColors(sortedCount: number): string[] {
  return Array.from({ length: sortedCount }, (_, i) => `hsl(${Math.round((i * 137.508) % 360)}, 70%, 50%)`)
}
