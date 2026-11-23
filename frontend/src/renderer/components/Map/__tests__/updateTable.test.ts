/**
 * 更新表：图形固有属性计算与拼表
 *
 * 覆盖：点/线/带洞面/MultiPolygon 的度量与坐标集格式、GCJ02→WGS84 纠偏、
 * 导出表列序、内部字段剔除、写回时的同名列冲突保护。
 */
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { measureGeometry } from '../updateTableGeometry'
import {
  INTRINSIC_FIELDS,
  buildExportRows,
  applyFieldsToGeojson,
  fieldApplies,
  splitCoordText,
  type IntrinsicFieldKey,
} from '../updateTableFields'
import { gcj02ToWgs84 } from '../../../utils/coordinate'

const ALL_KEYS = INTRINSIC_FIELDS.map((d) => d.key)

/** 单位方格（约 1km × 1.1km），坐标 GCJ02 */
function squarePolygon(): any {
  const lng0 = 113.9
  const lat0 = 22.5
  const step = 0.01
  const ring = [
    [lng0, lat0],
    [lng0 + step, lat0],
    [lng0 + step, lat0 + step],
    [lng0, lat0 + step],
    [lng0, lat0],
  ]
  return { type: 'Polygon', coordinates: [ring] }
}

describe('measureGeometry', () => {
  it('点：定位点与中心点都是自身，节点数 1', () => {
    const m = measureGeometry({ type: 'Point', coordinates: [114.1, 22.6] })
    expect(m.kind).toBe('point')
    expect(m.first).toEqual([114.1, 22.6])
    expect(m.center).toEqual([114.1, 22.6])
    expect(m.nodeCount).toBe(1)
    expect(m.lengthM).toBeNull()
    expect(m.areaM2).toBeNull()
  })

  it('线：长度取 Haversine 累加，定位点是首节点', () => {
    const m = measureGeometry({
      type: 'LineString',
      coordinates: [[113.9, 22.5], [113.91, 22.5]],
    })
    expect(m.kind).toBe('line')
    expect(m.first).toEqual([113.9, 22.5])
    expect(m.nodeCount).toBe(2)
    expect(m.lengthM).toBeGreaterThan(1000)
    expect(m.lengthM).toBeLessThan(1100)
    expect(m.perimeterM).toBeNull()
    expect(m.areaM2).toBeNull()
  })

  it('面：周长与面积均为正，且周长约等于四边之和', () => {
    const m = measureGeometry(squarePolygon())
    expect(m.kind).toBe('polygon')
    expect(m.nodeCount).toBe(5)
    expect(m.areaM2!).toBeGreaterThan(0)
    expect(m.perimeterM!).toBeGreaterThan(4000)
    expect(m.lengthM).toBeNull()
    // 约 0.01° × 0.01° 的方格 ≈ 1.2 km²
    expect(m.areaM2! / 1e6).toBeGreaterThan(1)
    expect(m.areaM2! / 1e6).toBeLessThan(2)
    // 质心落在方块中部
    expect(m.center![0]).toBeGreaterThan(113.9)
    expect(m.center![0]).toBeLessThan(113.91)
  })

  it('带洞的面：面积扣除洞、周长包含洞环', () => {
    const solid = measureGeometry(squarePolygon())
    const holeRing = [
      [113.903, 22.503],
      [113.907, 22.503],
      [113.907, 22.507],
      [113.903, 22.507],
      [113.903, 22.503],
    ]
    const withHole = measureGeometry({
      type: 'Polygon',
      coordinates: [squarePolygon().coordinates[0], holeRing],
    })
    expect(withHole.areaM2!).toBeLessThan(solid.areaM2!)
    expect(withHole.perimeterM!).toBeGreaterThan(solid.perimeterM!)
    expect(withHole.nodeCount).toBe(10)
  })

  it('MultiPolygon：各部件面积相加，坐标集以分号分段', () => {
    const part = squarePolygon().coordinates[0]
    const shifted = part.map(([lng, lat]: number[]) => [lng + 0.1, lat])
    const m = measureGeometry({ type: 'MultiPolygon', coordinates: [[part], [shifted]] })
    const single = measureGeometry(squarePolygon())
    expect(m.nodeCount).toBe(10)
    expect(m.areaM2!).toBeCloseTo(single.areaM2! * 2, -2)
    expect(m.coordText.split(';')).toHaveLength(2)
  })

  it('坐标集格式：经度 纬度成对、半角逗号分隔、6 位小数', () => {
    const m = measureGeometry({
      type: 'LineString',
      coordinates: [[114.655926, 23.606362], [114.655537, 23.606362]],
    })
    expect(m.coordText).toBe('114.655926 23.606362,114.655537 23.606362')
  })

  it('空几何返回 kind=null（调用方据此统计跳过数）', () => {
    expect(measureGeometry(null).kind).toBeNull()
    expect(measureGeometry({ type: 'Point', coordinates: [] }).kind).toBeNull()
    expect(measureGeometry(undefined).kind).toBeNull()
  })
})

describe('updateTableFields', () => {
  it('写回列名带单位后缀（属性表里没有单位行，光看列名要能分清量纲）', () => {
    const name = (k: IntrinsicFieldKey) => INTRINSIC_FIELDS.find((d) => d.key === k)!.writeName
    expect(name('length')).toBe('长度m')
    expect(name('perimeter')).toBe('周长km')
    expect(name('area')).toBe('面积km2')
  })

  it('写回列名不超过 10 UTF-8 字节（Shapefile DBF 硬约束）', () => {
    for (const def of INTRINSIC_FIELDS) {
      if (!def.writeName) continue
      const bytes = new Blob([def.writeName]).size
      expect(bytes, `${def.writeName} 超长`).toBeLessThanOrEqual(10)
    }
  })

  it('坐标集不参与写回（TAB 文本字段会被截断到 254 字符）', () => {
    expect(INTRINSIC_FIELDS.find((d) => d.key === 'coords')!.writeName).toBeNull()
  })

  it('WGS84 经纬度按 gcj02ToWgs84 纠偏输出', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [114.1, 22.6] }, properties: { name: 'A' } },
      ],
    }
    const built = buildExportRows(fc, ['lon', 'lat', 'lonWgs', 'latWgs'] as IntrinsicFieldKey[])
    const [wgsLat, wgsLng] = gcj02ToWgs84(22.6, 114.1)
    const row = built.rows[0]
    expect(row['经度(GCJ02)']).toBe(114.1)
    expect(Number(row['经度(WGS84)'])).toBeCloseTo(wgsLng, 5)
    expect(Number(row['纬度(WGS84)'])).toBeCloseTo(wgsLat, 5)
    expect(Number(row['经度(WGS84)'])).not.toBeCloseTo(114.1, 4)
  })

  it('导出表列序：原属性在前、追加列在后，且剔除下划线/NPT_ 内部键', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: { 编号: 'p1', _editStyle: { color: 'red' }, NPT_FEATSYM: 'x' },
        },
      ],
    }
    const built = buildExportRows(fc, ['lon', 'lat', 'nodes'] as IntrinsicFieldKey[])
    expect(built.headers.slice(0, 1)).toEqual(['编号'])
    expect(built.headers.slice(1)).toEqual(['经度(GCJ02)', '纬度(GCJ02)', '节点数'])
    expect(built.headers.some((h) => h.startsWith('_') || h.startsWith('NPT_'))).toBe(false)
    expect(built.features).toBe(1)
    expect(built.skipped).toBe(0)
  })

  it('无几何的要素保留属性、追加列留空并计入跳过', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: null, properties: { 编号: 'p1' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { 编号: 'p2' } },
      ],
    }
    const built = buildExportRows(fc, ['lon'] as IntrinsicFieldKey[])
    expect(built.skipped).toBe(1)
    expect(built.rows[0]['经度(GCJ02)']).toBeNull()
    expect(built.rows[0]['编号']).toBe('p1')
    expect(built.rows[1]['经度(GCJ02)']).toBe(1)
  })

  it('写回：追加列进入 properties，坐标集不写回', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: 'A' } },
      ],
    }
    const { geojson } = applyFieldsToGeojson(fc, ALL_KEYS)
    const props = geojson.features[0].properties
    expect(props.name).toBe('A')
    expect(props['经度']).toBe(1)
    expect(props['节点数']).toBe(1)
    expect(props['坐标集']).toBeUndefined()
  })

  it('面积以平方千米输出', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: squarePolygon(), properties: { id: 1 } }],
    }
    const built = buildExportRows(fc, ['area'] as IntrinsicFieldKey[])
    const km2 = Number(built.rows[0]['面积(km²)'])
    expect(built.headers).toContain('面积(km²)')
    expect(km2).toBeGreaterThan(1)
    expect(km2).toBeLessThan(2)
  })

  it('坐标集同时输出 GCJ02 与 WGS84 两套，WGS 版逐点纠偏', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[114.655926, 23.606362], [114.655537, 23.606362]] },
          properties: { id: 1 },
        },
      ],
    }
    const built = buildExportRows(fc, ['coords', 'coordsWgs'] as IntrinsicFieldKey[])
    const gcj = String(built.rows[0]['坐标集(GCJ02)'])
    const wgs = String(built.rows[0]['坐标集(WGS84)'])
    expect(gcj).toBe('114.655926 23.606362,114.655537 23.606362')
    expect(wgs.split(',')).toHaveLength(2)
    const [wLat, wLng] = gcj02ToWgs84(23.606362, 114.655926)
    expect(wgs.split(',')[0]).toBe(`${wLng.toFixed(6)} ${wLat.toFixed(6)}`)
    expect(wgs).not.toBe(gcj)
  })

  it('坐标集超 32767 字符时自动展开成多列（Excel 单元格上限）', () => {
    const ring: number[][] = []
    for (let i = 0; i < 2000; i++) ring.push([113.9 + i * 0.0001, 22.5])
    const fc = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: { id: 1 } }],
    }
    const built = buildExportRows(fc, ['coords'] as IntrinsicFieldKey[])
    expect(built.splits).toEqual([{ key: 'coords', columns: expect.any(Number) }])
    const columns = built.headers.filter((h) => h.startsWith('坐标集(GCJ02)'))
    expect(columns.length).toBeGreaterThan(1)
    // 每段都不超过 Excel 上限，且拼接后无数据丢失
    const parts = built.splits[0].columns
    const joined = Array.from({ length: parts }, (_, i) => built.rows[0][`坐标集(GCJ02)(${i + 1})`]).join(',')
    for (let i = 0; i < parts; i++) {
      expect(String(built.rows[0][`坐标集(GCJ02)(${i + 1})`]).length).toBeLessThanOrEqual(32000)
    }
    expect(joined.split(',')).toHaveLength(2000)
  })

  it('超长坐标集能真正写出 xlsx（不再抛 Text length must not exceed 32767）', () => {
    const ring: number[][] = []
    for (let i = 0; i < 3000; i++) ring.push([113.9 + i * 0.0001, 22.5 + (i % 7) * 0.0001])
    const fc = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { id: 1 } }],
    }
    const built = buildExportRows(fc, ALL_KEYS)
    const aoa = [built.headers, ...built.rows.map((r) => built.headers.map((h) => r[h] ?? ''))]
    expect(() => XLSX.write(
      (() => {
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1')
        return wb
      })(),
      { bookType: 'xlsx', type: 'array' },
    )).not.toThrow()
  })

  it('splitCoordText：按完整坐标对切分，不截断单个坐标', () => {
    const text = Array.from({ length: 10 }, (_, i) => `113.90000${i} 22.50000${i}`).join(',')
    const chunks = splitCoordText(text, 50)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(50)
      expect(c.split(',')).toHaveLength(2) // 每段始终是完整的坐标对
    }
    expect(chunks.join(',')).toBe(text)
  })

  it('写回：历史无单位列被识别为待删除，并从属性里剔除', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: squarePolygon(),
          properties: { 名称: 'A', 面积: 1.2, 长度: 900 },
        },
      ],
    }
    const { geojson, legacyColumns } = applyFieldsToGeojson(fc, ALL_KEYS)
    expect(legacyColumns).toEqual(expect.arrayContaining(['面积']))
    const props = geojson.features[0].properties
    expect(props['面积km2']).toBeGreaterThan(0)
    expect(props['面积']).toBeUndefined()
    expect(props['名称']).toBe('A')
  })

  it('写回：源图层已有同名列时不覆盖，列入冲突清单', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { 经度: '原有经度', name: 'A' } },
      ],
    }
    const { geojson, conflicts } = applyFieldsToGeojson(fc, ALL_KEYS)
    expect(conflicts).toContain('经度')
    expect(geojson.features[0].properties['经度']).toBe('原有经度')
    expect(geojson.features[0].properties['纬度']).toBe(2)
  })

  it('字段按图形类别过滤：面不该有长度，线不该有面积/周长', () => {
    const line = measureGeometry({ type: 'LineString', coordinates: [[1, 2], [1.1, 2]] })
    const polygon = measureGeometry(squarePolygon())
    const byKey = (k: IntrinsicFieldKey) => INTRINSIC_FIELDS.find((d) => d.key === k)!
    expect(fieldApplies(byKey('length'), line.kind)).toBe(true)
    expect(fieldApplies(byKey('length'), polygon.kind)).toBe(false)
    expect(fieldApplies(byKey('area'), polygon.kind)).toBe(true)
    expect(fieldApplies(byKey('area'), line.kind)).toBe(false)
    expect(fieldApplies(byKey('nodes'), 'point')).toBe(true)
    expect(fieldApplies(byKey('nodes'), null)).toBe(false)
  })
})
