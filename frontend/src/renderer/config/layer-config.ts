// 图层制作关键字匹配规则（与后端 GeoFieldDetector 保持一致）
export interface LayerFieldMatch {
  type: 'name' | 'longitude' | 'latitude' | 'azimuth'
  labelKey: string
  patterns: string[]
}

export const LAYER_FIELD_MATCHES: LayerFieldMatch[] = [
  { type: 'name', labelKey: 'layer.fieldName', patterns: ['名称', 'name', '小区名', '站名', 'cell_name', 'site_name'] },
  { type: 'longitude', labelKey: 'layer.fieldLongitude', patterns: ['经度', 'longitude', 'lng', 'lon', 'long', 'x'] },
  { type: 'latitude', labelKey: 'layer.fieldLatitude', patterns: ['纬度', 'latitude', 'lat', 'y'] },
  { type: 'azimuth', labelKey: 'layer.fieldAzimuth', patterns: ['方位角', '方向角', 'azimuth', 'azi', 'azim', 'bearing'] },
]

// 自动匹配：对给定列名列表，找出每个字段最匹配的列
export function autoMatchFields(columns: string[], includeAzimuth: boolean): Record<string, string> {
  const result: Record<string, string> = {}
  const lowerCols = columns.map(c => c.toLowerCase())
  for (const match of LAYER_FIELD_MATCHES) {
    if (match.type === 'azimuth' && !includeAzimuth) continue
    let found: string | null = null
    // 精确匹配优先（含单字符 x/y 仅精确）
    for (let i = 0; i < columns.length; i++) {
      if (match.patterns.some(p => p.toLowerCase() === lowerCols[i])) { found = columns[i]; break }
    }
    // 模糊匹配仅用多字符 pattern（长度>1），避免单字符误报（如 year 含 y 被误判为纬度）
    if (!found) {
      const fuzzyPatterns = match.patterns.filter(p => p.length > 1)
      for (let i = 0; i < columns.length; i++) {
        if (fuzzyPatterns.some(p => lowerCols[i].includes(p.toLowerCase()))) { found = columns[i]; break }
      }
    }
    if (found) result[match.type] = found
  }
  return result
}

// 默认参数（扇区半径 50m、波瓣夹角 50°）
export const LAYER_DEFAULT_PARAMS = {
  sector: {
    radiusM: 50,
    beamwidth: 50,
    borderColor: '#4A90D9',
    fillColor: '#4A90D9',
    opacity: 0.6,
  },
  point: {
    pointSize: 8,
    borderColor: '#FF0000',
    opacity: 1,
  },
}
