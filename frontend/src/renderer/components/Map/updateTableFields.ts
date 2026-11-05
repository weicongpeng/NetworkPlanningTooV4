/**
 * 更新表：图形固有属性字段定义 + 表行组装 + 写回属性注入（纯函数，便于单测）
 *
 * 两套列名并存是有意为之：
 * - `excelHeader`：导出 Excel 用的易读全称（不受长度限制）
 * - `writeName`：写回源图层用的字段名，必须 ≤10 UTF-8 字节 —— Shapefile 的 DBF
 *   字段名超限会被 GDAL 按字节洗钱，读回直接 UnicodeDecodeError，文件报废；
 *   MapInfo TAB 虽无此限制，但统一用短名可让两种源的产物列名一致。
 *   坐标集不写回：TAB 的文本字段宽度是 Char(254)，长坐标串会被截断丢数据。
 *
 * 坐标集同时提供 GCJ02 与 WGS84 两套；Excel 单元格上限 32767 字符是 Excel 规范
 * 硬限制（写不进去，无法解除），超长的坐标集按完整坐标对自动切成多列输出。
 * 面积对外一律用 km²、周长一律用 km（内部按 m / m² 计算后换算）。
 */
import { gcj02ToWgs84 } from '../../utils/coordinate'
import { formatCoordText, measureGeometry, type GeometryMeasure, type LngLat } from './updateTableGeometry'

/** 字段唯一 key（UI 勾选 / 测试用） */
export type IntrinsicFieldKey =
  | 'lon' | 'lat' | 'lonWgs' | 'latWgs' | 'coords' | 'coordsWgs'
  | 'length' | 'perimeter' | 'area' | 'nodes'
  | 'cx' | 'cy' | 'cxWgs' | 'cyWgs'

/** 适用图形；'all' 之外只对指定类别出值，其余留空 */
export type FieldScope = 'all' | 'line' | 'polygon' | 'linePolygon'

export interface IntrinsicFieldDef {
  key: IntrinsicFieldKey
  /** Excel 表头 */
  excelHeader: string
  /** 写回源图层的字段名（≤10 字节）；null = 不写回 */
  writeName: string | null
  scope: FieldScope
  /** 单位（仅用于 UI 展示） */
  unit?: string
  /** UI 说明 */
  hint: string
  /** 文本值超长时是否自动分列（Excel 单元格 32767 字符上限） */
  splittable?: boolean
  /** 历史遗留的无单位写回列名：源图层存在该列时写回会整列删除，换成带单位的 writeName */
  legacyWriteName?: string
}

export const INTRINSIC_FIELDS: IntrinsicFieldDef[] = [
  { key: 'lon', excelHeader: '经度(GCJ02)', writeName: '经度', scope: 'all', unit: '°', hint: '点=自身；线/面=第一个节点' },
  { key: 'lat', excelHeader: '纬度(GCJ02)', writeName: '纬度', scope: 'all', unit: '°', hint: '点=自身；线/面=第一个节点' },
  { key: 'lonWgs', excelHeader: '经度(WGS84)', writeName: '经度W', scope: 'all', unit: '°', hint: '上述点按 WGS84 纠偏输出' },
  { key: 'latWgs', excelHeader: '纬度(WGS84)', writeName: '纬度W', scope: 'all', unit: '°', hint: '上述点按 WGS84 纠偏输出' },
  { key: 'coords', excelHeader: '坐标集(GCJ02)', writeName: null, scope: 'linePolygon', splittable: true, hint: '"经度 纬度"成对、半角逗号分隔；多环/多部件以分号分隔（仅导出，不写回）' },
  { key: 'coordsWgs', excelHeader: '坐标集(WGS84)', writeName: null, scope: 'linePolygon', splittable: true, hint: '按 WGS84 纠偏后的坐标集（仅导出，不写回）' },
  // 写回列名带单位后缀：属性表里只有列名、没有单位行，不写单位会分不清量纲。
  // 仍受 ≤10 字节约束（SHP DBF），故单位一律用 ASCII（km2 而非 km²，后者 2 字节会超限）。
  { key: 'length', excelHeader: '长度(m)', writeName: '长度m', legacyWriteName: '长度', scope: 'line', unit: 'm', hint: '线状图形长度' },
  { key: 'perimeter', excelHeader: '周长(km)', writeName: '周长km', legacyWriteName: '周长', scope: 'polygon', unit: 'km', hint: '面状图形周长（含洞）' },
  { key: 'area', excelHeader: '面积(km²)', writeName: '面积km2', legacyWriteName: '面积', scope: 'polygon', unit: 'km²', hint: '面状图形面积（已扣除洞）' },
  { key: 'nodes', excelHeader: '节点数', writeName: '节点数', scope: 'all', unit: '个', hint: '图形顶点总数' },
  { key: 'cx', excelHeader: '中心经度(GCJ02)', writeName: '中心经', scope: 'linePolygon', unit: '°', hint: '面=面积加权质心；线=顶点平均' },
  { key: 'cy', excelHeader: '中心纬度(GCJ02)', writeName: '中心纬', scope: 'linePolygon', unit: '°', hint: '面=面积加权质心；线=顶点平均' },
  { key: 'cxWgs', excelHeader: '中心经度(WGS84)', writeName: '中心经W', scope: 'linePolygon', unit: '°', hint: '中心点按 WGS84 纠偏输出' },
  { key: 'cyWgs', excelHeader: '中心纬度(WGS84)', writeName: '中心纬W', scope: 'linePolygon', unit: '°', hint: '中心点按 WGS84 纠偏输出' },
]

/** 该字段是否适用于当前图形类别 */
export function fieldApplies(def: IntrinsicFieldDef, kind: GeometryMeasure['kind']): boolean {
  if (kind === null) return false
  if (def.scope === 'all') return true
  if (def.scope === 'linePolygon') return kind === 'line' || kind === 'polygon'
  return def.scope === kind
}

/** 单个字段的取值（不适用返回 null → 表里留空） */
function fieldValue(def: IntrinsicFieldDef, m: GeometryMeasure): string | number | null {
  if (!fieldApplies(def, m.kind)) return null
  switch (def.key) {
    case 'lon': return m.first ? round(m.first[0]) : null
    case 'lat': return m.first ? round(m.first[1]) : null
    case 'lonWgs': return m.first ? round(gcj02ToWgs84(m.first[1], m.first[0])[1]) : null
    case 'latWgs': return m.first ? round(gcj02ToWgs84(m.first[1], m.first[0])[0]) : null
    case 'coords': return m.coordText || null
    case 'coordsWgs': return wgsCoordText(m.rings) || null
    case 'length': return m.lengthM === null ? null : round(m.lengthM, 2)
    case 'perimeter': return m.perimeterM === null ? null : round(m.perimeterM / 1000, 6)
    case 'area': return m.areaM2 === null ? null : round(m.areaM2 / 1_000_000, 6)
    case 'nodes': return m.nodeCount
    case 'cx': return m.center ? round(m.center[0]) : null
    case 'cy': return m.center ? round(m.center[1]) : null
    case 'cxWgs': return m.center ? round(gcj02ToWgs84(m.center[1], m.center[0])[1]) : null
    case 'cyWgs': return m.center ? round(gcj02ToWgs84(m.center[1], m.center[0])[0]) : null
    default: return null
  }
}

function round(v: number, decimals = 6): number {
  const f = Math.pow(10, decimals)
  return Math.round(v * f) / f
}

/** 坐标环逐点 GCJ02→WGS84 后拼成坐标集文本 */
function wgsCoordText(rings: LngLat[][]): string {
  return formatCoordText(
    rings.map((ring) => ring.map(([lng, lat]) => {
      const [wLat, wLng] = gcj02ToWgs84(lat, lng)
      return [wLng, wLat] as LngLat
    })),
  )
}

/**
 * Excel 单元格最多 32767 字符（Excel 规范硬限制，无法解除），超长坐标集按完整
 * 坐标对切成多段，由 `buildExportRows` 展开成多列。
 */
const MAX_CELL_CHARS = 32000

export function splitCoordText(text: string, maxLen = MAX_CELL_CHARS): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let cur = ''
  for (const pair of text.split(',')) {
    const next = cur ? `${cur},${pair}` : pair
    if (next.length > maxLen && cur) {
      chunks.push(cur)
      cur = pair
    } else {
      cur = next
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}

/** 导出表的一行：原属性按原键，追加列写在后面 */
export interface UpdateTableBuildResult {
  /** 全部列（原属性列在前，追加列在后） */
  headers: string[]
  rows: Array<Record<string, string | number | null>>
  /** 无几何、跳过的要素数 */
  skipped: number
  /** 参与计算的要素数 */
  features: number
  /** 因超长而被展开成多列的字段（Excel 单元格 32767 字符上限） */
  splits: Array<{ key: IntrinsicFieldKey; columns: number }>
}

/** 原属性表里需要排除的内部键（绘制样式 / MapInfo 落盘样式等，导出给用户无意义） */
function isInternalPropKey(key: string): boolean {
  return key.startsWith('_') || key.startsWith('NPT_')
}

/**
 * 组装导出表：每行 = 原属性（去内部键）+ 所选追加字段。
 * 几何为空的要素仍保留（属性不丢），但追加列全空并计入 skipped。
 */
export function buildExportRows(
  featureCollection: any,
  keys: IntrinsicFieldKey[],
): UpdateTableBuildResult {
  const features: any[] = Array.isArray(featureCollection?.features) ? featureCollection.features : []
  const defs = INTRINSIC_FIELDS.filter((d) => keys.includes(d.key))

  const propKeys: string[] = []
  const rows: Array<{ base: Record<string, any>; extra: Record<string, string | number | string[] | null> }> = []
  /** 每个可拆分字段实际需要的最大分段数 */
  const chunkCounts = new Map<IntrinsicFieldKey, number>()
  let skipped = 0

  for (const f of features) {
    const props: Record<string, any> = f?.properties || {}
    for (const k of Object.keys(props)) {
      if (isInternalPropKey(k) || propKeys.includes(k)) continue
      propKeys.push(k)
    }
    const m = measureGeometry(f?.geometry)
    if (m.kind === null) skipped++
    const base: Record<string, any> = {}
    for (const k of Object.keys(props)) {
      if (isInternalPropKey(k)) continue
      base[k] = props[k] ?? null
    }
    const extra: Record<string, string | number | string[] | null> = {}
    for (const d of defs) {
      const v = fieldValue(d, m)
      if (d.splittable && typeof v === 'string' && v) {
        const chunks = splitCoordText(v)
        extra[d.key] = chunks.length > 1 ? chunks : v
        chunkCounts.set(d.key, Math.max(chunkCounts.get(d.key) ?? 1, chunks.length))
      } else {
        extra[d.key] = v
      }
    }
    rows.push({ base, extra })
  }

  // 追加列：不超长时一列，超长时展开为「表头(1)…表头(n)」多列
  const columns: Array<{ key: IntrinsicFieldKey; index: number }> = []
  const appended: string[] = []
  const splits: Array<{ key: IntrinsicFieldKey; columns: number }> = []
  for (const d of defs) {
    const n = chunkCounts.get(d.key) ?? 1
    if (n > 1) splits.push({ key: d.key, columns: n })
    for (let i = 0; i < n; i++) {
      appended.push(n > 1 ? `${d.excelHeader}(${i + 1})` : d.excelHeader)
      columns.push({ key: d.key, index: i })
    }
  }

  // 原属性中若与追加列表头重名，追加列覆盖同名原值（以图形固有属性为准）
  const baseKeys = propKeys.filter((k) => !appended.includes(k))
  const outRows = rows.map(({ base, extra }) => {
    const row: Record<string, string | number | null> = {}
    for (const k of baseKeys) row[k] = base[k] ?? null
    columns.forEach((c, i) => {
      const v = extra[c.key]
      row[appended[i]] = Array.isArray(v) ? (v[c.index] ?? '') : (c.index === 0 ? (v ?? null) : '')
    })
    return row
  })

  return {
    headers: [...baseKeys, ...appended],
    rows: outRows,
    skipped,
    features: features.length,
    splits,
  }
}

/** 写回结果：新 FeatureCollection + 冲突信息 + 待删除的历史列 */
export interface ApplyFieldsResult {
  geojson: any
  /** 源图层已存在同名列而被跳过的追加列名（避免覆盖用户原有数据） */
  conflicts: string[]
  /** 源图层里与本次写回列同义、但不带单位的历史列名（写回时应整列删除） */
  legacyColumns: string[]
  skipped: number
}

/**
 * 把所选字段（坐标集除外，它不写回）注入每个要素的 properties，返回可直接完整保存的
 * FeatureCollection。原属性中与写回列名重名的列**跳过不改**（conflicts 里列出）。
 */
export function applyFieldsToGeojson(
  featureCollection: any,
  keys: IntrinsicFieldKey[],
): ApplyFieldsResult {
  const features: any[] = Array.isArray(featureCollection?.features) ? featureCollection.features : []
  const defs = INTRINSIC_FIELDS.filter((d) => keys.includes(d.key) && d.writeName)

  let skipped = 0
  const measured = features.map((f) => {
    const m = measureGeometry(f?.geometry)
    if (m.kind === null) skipped++
    return m
  })

  // 已有同名列：整表扫描（只看前 200 条以控开销）判断冲突
  const existing = new Set<string>()
  for (const f of features.slice(0, 200)) {
    for (const k of Object.keys(f?.properties || {})) existing.add(k)
  }
  const conflicts = defs.filter((d) => existing.has(d.writeName!)).map((d) => d.writeName!)
  const usable = defs.filter((d) => !conflicts.includes(d.writeName!))
  // 历史无单位列：只有当本次确实要写入它的带单位版本时才删，避免误删用户自己的同名列
  const legacyColumns = usable
    .filter((d) => d.legacyWriteName && existing.has(d.legacyWriteName))
    .map((d) => d.legacyWriteName!)

  const newFeatures = features.map((f, i) => {
    const props: Record<string, any> = { ...(f?.properties || {}) }
    for (const d of usable) {
      const v = fieldValue(d, measured[i])
      props[d.writeName!] = v === null ? '' : v
    }
    for (const legacy of legacyColumns) delete props[legacy]
    return { ...f, properties: props }
  })

  return {
    geojson: { type: 'FeatureCollection', features: newFeatures },
    conflicts,
    legacyColumns,
    skipped,
  }
}
