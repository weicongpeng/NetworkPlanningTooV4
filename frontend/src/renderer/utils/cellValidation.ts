/**
 * 小区选择阶段必要字段校验（执行规划/核查前调用）
 *
 * 与 services/mapDataService.ts 的 findCellsMissingRequiredFields 配合：
 * 后者纯数据校验，本模块负责把校验结果拼成可展示的国际化错误消息。
 */

import type { CellListItem } from '../services/mapDataService'
import { findCellsMissingRequiredFields } from '../services/mapDataService'

/** 必要字段的展示标签（由调用方传入已翻译文本） */
export interface CellFieldLabels {
  siteId: string
  cellId: string
  frequency: string
  longitude: string
  latitude: string
}

export interface BuildMissingCellsErrorOptions {
  /** 字段展示标签 */
  labels: CellFieldLabels
  /** 主消息模板，含 {{count}}、{{examples}} 占位 */
  mainTemplate: string
  /** 单小区缺失字段模板，含 {{fields}} 占位（如 "缺少：{{fields}}"） */
  missingTemplate: string
  /** 语言，控制分隔符与括号，默认 'zh' */
  lang?: 'zh' | 'en'
  /** 明细最多列出的小区数，默认 5 */
  exampleLimit?: number
}

/**
 * 校验选中小区的必要字段（经度/纬度/频点/基站ID/小区ID），
 * 全部齐全返回 null；存在缺失返回拼好的错误消息。
 */
export function buildMissingCellsError(
  sectors: CellListItem[],
  selectedIds: Set<string>,
  options: BuildMissingCellsErrorOptions
): string | null {
  const { labels, mainTemplate, missingTemplate, lang = 'zh', exampleLimit = 5 } = options
  const missingCells = findCellsMissingRequiredFields(sectors, selectedIds)
  if (missingCells.length === 0) return null

  const fieldLabelMap: Record<string, string> = {
    siteId: labels.siteId,
    id: labels.cellId,
    frequency: labels.frequency,
    longitude: labels.longitude,
    latitude: labels.latitude,
  }

  const fieldSep = lang === 'en' ? ', ' : '、'
  const itemSep = lang === 'en' ? '; ' : '；'
  const openBracket = lang === 'en' ? '(' : '（'
  const closeBracket = lang === 'en' ? ')' : '）'

  const examples = missingCells
    .slice(0, exampleLimit)
    .map(c => {
      const fields = c.missing.map(f => fieldLabelMap[f]).join(fieldSep)
      return `${c.name}${openBracket}${missingTemplate.replace('{{fields}}', fields)}${closeBracket}`
    })
    .join(itemSep)

  return mainTemplate
    .replace('{{count}}', String(missingCells.length))
    .replace('{{examples}}', examples)
}
