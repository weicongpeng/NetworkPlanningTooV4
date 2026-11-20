/**
 * 专题图例统计（各配色区间的要素数 / 总数 / 未匹配数）。
 *
 * 算法与 2D 侧三处实现（`SectorRendererSVG.computeThematicStats`、
 * `MapInfoLayer` / `GeoDataLayer` 的同名逻辑）**逐条对齐**——2D 与 3D 的图例必须给出同样的数字，
 * 否则同一份专题设置在两边的图例对不上。这里抽成纯函数供 Cesium 侧复用。
 */
import { getFieldValue, matchRangeIndex } from './fieldValue'
import type { ThematicSettings } from '../components/Map/LabelSettingsModal'

export interface ThematicStats {
  /** 每个配色区间的要素数，下标与设置里的 ranges / valueColors / categories 对齐 */
  counts: number[]
  /** 参与统计的要素总数 */
  total: number
  /** 未落到任何区间（含兜底分类之外）的要素数 */
  other: number
}

/**
 * @param settings 专题设置（未启用 / 无配色规则时返回 null）
 * @param items    待统计对象（扇区或要素 properties）
 */
export function computeThematicStats(
  settings: ThematicSettings | null | undefined,
  items: Array<Record<string, any>>,
): ThematicStats | null {
  if (!settings?.enabled || items.length === 0) return null

  const isRange = settings.fieldType === 'numeric'
    && settings.colorMode !== 'value' && settings.ranges.length > 0
  const isValue = settings.fieldType === 'numeric'
    && settings.colorMode === 'value' && (settings.valueColors?.length ?? 0) > 0
  const isText = settings.fieldType === 'text' && settings.categories.length > 0
  if (!isRange && !isValue && !isText) return null

  const bucketCount = isRange
    ? settings.ranges.length
    : isValue ? settings.valueColors!.length : settings.categories.length
  const counts = new Array<number>(bucketCount).fill(0)
  let total = 0
  let other = 0

  const valueIndex = isValue
    ? new Map(settings.valueColors!.map((c, i) => [c.value, i]))
    : null
  const otherIdx = isText ? settings.categories.findIndex(c => c.value === '__other__') : -1
  const categoryIndex = isText
    ? new Map(settings.categories.map((c, i) => [c.value, i]))
    : null

  for (const item of items) {
    const raw = getFieldValue(item, settings.field)
    if (isRange) {
      total++
      const idx = matchRangeIndex(settings, raw)
      if (idx >= 0) counts[idx]++
      else other++
    } else if (isValue) {
      total++
      if (raw === undefined || raw === null || raw === '') { other++; continue }
      const idx = valueIndex!.get(String(raw))
      if (idx !== undefined) counts[idx]++
      else other++
    } else {
      total++
      if (raw === undefined || raw === null || raw === '') {
        if (otherIdx >= 0) counts[otherIdx]++
        else other++
        continue
      }
      const idx = categoryIndex!.get(String(raw))
      if (idx !== undefined) counts[idx]++
      else if (otherIdx >= 0) counts[otherIdx]++
      else other++
    }
  }

  return { counts, total, other }
}
