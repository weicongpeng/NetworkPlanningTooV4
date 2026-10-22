// backend metadata.importWarnings（全量工参导入提醒）→ 前端可读文案
// 由 data_service._add_import_warning 生成，均为非致命问题：数据已导入，仅提示源文件需修正

export interface ImportWarning {
  code: string
  network?: string
  count?: number
  columns?: string[]
  present?: string
  missing?: string
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 单条提醒 → 文案；未知 code 原样回显，便于后端新增类型时不至于空白 */
export function formatImportWarning(warning: ImportWarning, t: Translate): string {
  const prefix = warning.network ? `[${warning.network}] ` : ''
  switch (warning.code) {
    case 'duplicate_columns':
      return prefix + t('data.importWarnDuplicateColumns', { columns: (warning.columns || []).join('、') })
    case 'coord_zero':
      return prefix + t('data.importWarnCoordZero', { count: warning.count ?? 0 })
    case 'sector_id_missing':
      return prefix + t('data.importWarnSectorIdMissing', { count: warning.count ?? 0 })
    case 'site_id_dropped':
      return prefix + t('data.importWarnSiteIdDropped', { count: warning.count ?? 0 })
    case 'sector_name_missing':
      return prefix + t('data.importWarnSectorNameMissing')
    case 'single_network':
      return t('data.importWarnSingleNetwork', { present: warning.present ?? '', missing: warning.missing ?? '' })
    default:
      return prefix + warning.code
  }
}
