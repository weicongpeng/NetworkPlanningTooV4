// 常用色块预设
export const PRESET_COLORS = [
  '#FF0000', '#00FF00', '#0000FF', '#FFFF00',
  '#FF00FF', '#00FFFF', '#000000', '#FFFFFF',
]

// 图层制作关键字匹配规则（与后端 GeoFieldDetector 保持一致）
export interface LayerFieldMatch {
  type: 'name' | 'longitude' | 'latitude' | 'azimuth' | 'polygon'
  labelKey: string
  patterns: string[]
}

export const LAYER_FIELD_MATCHES: LayerFieldMatch[] = [
  { type: 'name', labelKey: 'layer.fieldName', patterns: ['名称', 'name', '小区名', '站名', 'cell_name', 'site_name'] },
  { type: 'longitude', labelKey: 'layer.fieldLongitude', patterns: ['经度', 'longitude', 'lng', 'lon', 'long', 'x'] },
  { type: 'latitude', labelKey: 'layer.fieldLatitude', patterns: ['纬度', 'latitude', 'lat', 'y'] },
  { type: 'azimuth', labelKey: 'layer.fieldAzimuth', patterns: ['方位角', '方向角', 'azimuth', 'azi', 'azim', 'bearing'] },
  { type: 'polygon', labelKey: 'layer.fieldPolygon', patterns: ['polygon', '多边形', '轮廓', '边界', '坐标串', 'geometry'] },
]

// 自动匹配：对给定列名列表，找出每个字段最匹配的列
export function autoMatchFields(columns: string[], includeAzimuth: boolean,
                                includePolygon = false): Record<string, string> {
  const result: Record<string, string> = {}
  const lowerCols = columns.map(c => c.toLowerCase())
  for (const match of LAYER_FIELD_MATCHES) {
    if (match.type === 'azimuth' && !includeAzimuth) continue
    if (match.type === 'polygon' && !includePolygon) continue
    // 面状图不使用经纬度列（坐标合并在 polygon 列中）
    if (includePolygon && (match.type === 'longitude' || match.type === 'latitude')) continue
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

// 默认参数（扇区半径 50m、波瓣夹角 50°、边框黄/填充红/线宽2；点大小 12、圆形、蓝色）
export const LAYER_DEFAULT_PARAMS = {
  sector: {
    radiusM: 50,
    beamwidth: 50,
    lineWidth: 2,
    borderColor: '#FFFF00',   // 边框黄色
    fillColor: '#FF0000',     // 填充红色
  },
  point: {
    pointSize: 12,            // 点大小默认 12
    pointShape: 'circle',
    borderColor: '#0000FF',   // 默认蓝色
  },
  polygon: {
    lineWidth: 2,
    borderColor: '#FFFF00',   // 边框黄色
    fillColor: '#FF0000',     // 填充红色
  },
}
