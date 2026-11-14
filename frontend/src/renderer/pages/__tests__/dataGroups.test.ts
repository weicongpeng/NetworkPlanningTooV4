import { describe, it, expect } from 'vitest'
import type { DataItem } from '@shared/types'

// 只测纯逻辑：mock 掉 DataPage 的重依赖（store / api / 子组件），
// 避免把整个页面拉进测试环境
const { DATA_GROUPS, dataGroupKeyOf, groupDataItems } = await import('../DataPage')

function item(overrides: Partial<DataItem> & Record<string, unknown> = {}): DataItem {
  return {
    id: 'id-1',
    name: 'test.xlsx',
    type: 'excel',
    size: 100,
    uploadDate: '2026-11-11T12:00:00',
    status: 'ready',
    ...overrides,
  } as DataItem
}

describe('已导入数据六大类', () => {
  it('固定六类，顺序与「导入数据」框一致', () => {
    expect(DATA_GROUPS.map(g => g.key)).toEqual([
      'full_params', 'current_params', 'map_layer', 'geo_data',
      'station_params', 'station_metrics',
    ])
    expect(DATA_GROUPS.map(g => g.label)).toEqual([
      '全量工参', '现网工参', '图层文件', '地理化数据', '基站参数', '基站指标',
    ])
  })

  it('每类图标与「导入数据」框对应入口一致', () => {
    // UPLOAD_ICON_KIND：full_params=excel / current_params=current_params /
    // map_layer=layers / geo_data=geo_point / station_params / station_metrics
    expect(DATA_GROUPS.map(g => g.icon)).toEqual([
      'excel', 'current_params', 'layers', 'geo_point',
      'station_params', 'station_metrics',
    ])
  })

  it('按导入路径 fileType 归类', () => {
    expect(dataGroupKeyOf(item({ fileType: 'full_params' }))).toBe('full_params')
    expect(dataGroupKeyOf(item({ fileType: 'target_cells' }))).toBe('full_params')
    expect(dataGroupKeyOf(item({ fileType: 'default' }))).toBe('full_params')
    expect(dataGroupKeyOf(item({ fileType: 'current_params' }))).toBe('current_params')
    expect(dataGroupKeyOf(item({ fileType: 'geo_data' }))).toBe('geo_data')
    // 助手数据集的 fileType 未在共享类型中声明，运行时按字符串判定
    expect(dataGroupKeyOf(item({ fileType: 'station_params' as DataItem['fileType'] }))).toBe('station_params')
    expect(dataGroupKeyOf(item({ fileType: 'station_metrics' as DataItem['fileType'] }))).toBe('station_metrics')
  })

  it('图层文件的多种 fileType 都归入图层文件', () => {
    for (const ft of ['map_layer', 'tac_layer', 'mapinfo_layer']) {
      expect(dataGroupKeyOf(item({ type: 'map', fileType: ft as DataItem['fileType'] }))).toBe('map_layer')
    }
  })

  it('历史无导入路径的条目按内容兜底', () => {
    expect(dataGroupKeyOf(item({ type: 'excel' }))).toBe('full_params')
    expect(dataGroupKeyOf(item({ type: 'map' }))).toBe('map_layer')
  })

  it('BaselineLab* 网管导出包（与图层文件同为 ZIP）归现网工参', () => {
    // 存量索引里被误标成 map_layer / 没有 fileType，也按包名纠正
    expect(dataGroupKeyOf(item({
      name: 'BaselineLab_20261111.zip', type: 'map',
      fileType: 'map_layer' as DataItem['fileType'],
    }))).toBe('current_params')
    expect(dataGroupKeyOf(item({
      name: 'baselinelab_test.zip', type: 'map',
    }))).toBe('current_params')
    // 正常图层包不受影响
    expect(dataGroupKeyOf(item({
      name: 'city_layers.zip', type: 'map',
      fileType: 'map_layer' as DataItem['fileType'],
    }))).toBe('map_layer')
  })

  it('归桶保留原顺序、六类齐全（含空类）', () => {
    const items = [
      item({ id: '1', name: 'a.xlsx', fileType: 'full_params' }),
      item({ id: '2', name: 'b.zip', type: 'map', fileType: 'map_layer' as DataItem['fileType'] }),
      item({ id: '3', name: 'c.xlsx', fileType: 'full_params' }),
      item({ id: '4', name: 'd.xlsx', fileType: 'station_params' as DataItem['fileType'] }),
    ]
    const groups = groupDataItems(items)
    expect([...groups.keys()]).toEqual(DATA_GROUPS.map(g => g.key))
    expect(groups.get('full_params')!.map(x => x.id)).toEqual(['1', '3'])
    expect(groups.get('map_layer')!.map(x => x.id)).toEqual(['2'])
    expect(groups.get('station_params')!.map(x => x.id)).toEqual(['4'])
    expect(groups.get('current_params')).toEqual([])
    expect(groups.get('geo_data')).toEqual([])
    expect(groups.get('station_metrics')).toEqual([])
  })

  it('空列表也返回六个空桶', () => {
    const groups = groupDataItems([])
    expect(groups.size).toBe(6)
    for (const list of groups.values()) expect(list).toEqual([])
  })
})
