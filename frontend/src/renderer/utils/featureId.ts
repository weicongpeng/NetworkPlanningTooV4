/**
 * 要素标识字段提取
 *
 * 圈选/点选 MapInfo 图层要素时，需要从要素属性中提取唯一标识（用于 Set 去重与高亮匹配）。
 * 不同数据文件的标识列名不一致（如 LTE 工参用「小区名称」，NR 工参用「CELLNAME」），
 * 因此不能硬编码单个字段，需按候选列表取第一个非空值。
 *
 * 顺序即优先级：保持历史行为 "id → name → 小区名称 → OBJECTID" 的相对优先级，
 * 再补充常见电信小区标识列名；CGI 在 LTE/NR 数据中均为唯一字段，作为靠后的兜底。
 * 明确排除 CELL / CellID（如 NR 数据中 CellID 仅 49 个唯一值，会导致误高亮）。
 */
const FEATURE_ID_FIELDS = [
  'id', 'ID',
  'name', 'Name', 'NAME',
  '小区名称', 'CELLNAME', 'CELL_NAME', 'CELL NAME', 'CellName', 'cellName',
  '小区名', '站点名称', 'SECTOR_NAME', 'zhLabel',
  'OBJECTID', 'FID', 'CGI',
] as const

/**
 * 从要素属性中提取标识字段值
 * @param properties 要素属性对象（可为 null/undefined）
 * @returns 第一个非空候选字段的字符串值；无匹配时返回空串
 */
export function extractFeatureId(properties: Record<string, unknown> | null | undefined): string {
  if (!properties) return ''
  for (const key of FEATURE_ID_FIELDS) {
    const value = properties[key]
    if (value === undefined || value === null) continue
    const str = String(value).trim()
    if (str !== '') return str
  }
  return ''
}
