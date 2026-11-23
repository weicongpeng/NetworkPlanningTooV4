import { describe, it, expect } from 'vitest'
import { formatImportWarning, formatImportWarningTitle } from '../importWarnings'

/** 用 zh.json 的文案做替身，校验插值与制式前缀 */
const t = (key: string, options: Record<string, unknown> = {}) => {
  const dict: Record<string, string> = {
    'data.importWarnDuplicateColumns': '存在重复列名：{{columns}}（已自动取第一个同名列）',
    'data.importWarnCoordZero': '{{count}} 个小区经纬度缺失或为 0（地图上会落在原点）',
    'data.importWarnSectorIdMissing': '{{count}} 行小区标识为空（已分配临时编号并保留）',
    'data.importWarnSiteIdDropped': '已丢弃 {{count}} 行基站标识为空的数据',
    'data.importWarnSectorNameMissing': '未找到「小区名称」列（列名可能被误改），小区名称按「基站名称_小区标识」显示',
    'data.importWarnSingleNetwork': '文件只含 {{present}} 制式，请确认是否漏传 {{missing}} 工参',
    'data.importWarnTitle': '{{type}}文件「{{name}}」存在问题，数据已导入',
    'data.importWarnGenericType': '数据',
    'data.fullParams': '全量工参',
    'data.geoData': '地理化数据',
  }
  return (dict[key] || key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(options[k] ?? ''))
}

describe('formatImportWarning', () => {
  it('重复列名：拼接列名并带制式前缀', () => {
    expect(formatImportWarning({ code: 'duplicate_columns', network: 'NR', columns: ['小区名称'] }, t))
      .toBe('[NR] 存在重复列名：小区名称（已自动取第一个同名列）')
  })

  it('坐标缺失/为 0：带条数', () => {
    expect(formatImportWarning({ code: 'coord_zero', network: 'LTE', count: 12 }, t))
      .toBe('[LTE] 12 个小区经纬度缺失或为 0（地图上会落在原点）')
  })

  it('地理化数据坐标缺失/为 0：不带制式前缀', () => {
    expect(formatImportWarning({ code: 'coord_zero', count: 2 }, t))
      .toBe('2 个小区经纬度缺失或为 0（地图上会落在原点）')
  })

  it('小区标识为空、基站标识被丢弃：带条数', () => {
    expect(formatImportWarning({ code: 'sector_id_missing', network: 'NR', count: 3 }, t))
      .toBe('[NR] 3 行小区标识为空（已分配临时编号并保留）')
    expect(formatImportWarning({ code: 'site_id_dropped', network: 'NR', count: 5 }, t))
      .toBe('[NR] 已丢弃 5 行基站标识为空的数据')
  })

  it('缺「小区名称」列：提示回退为基站名称_小区标识', () => {
    expect(formatImportWarning({ code: 'sector_name_missing', network: 'NR' }, t))
      .toBe('[NR] 未找到「小区名称」列（列名可能被误改），小区名称按「基站名称_小区标识」显示')
  })

  it('单一制式：不带制式前缀，说明缺失的制式', () => {
    expect(formatImportWarning({ code: 'single_network', present: 'LTE', missing: 'NR' }, t))
      .toBe('文件只含 LTE 制式，请确认是否漏传 NR 工参')
  })

  it('未知 code 原样回显，避免新增后端类型时显示空白', () => {
    expect(formatImportWarning({ code: 'future_code', network: 'NR' }, t)).toBe('[NR] future_code')
  })
})

describe('formatImportWarningTitle', () => {
  it('地理化数据：标题指明入口类型与文件名', () => {
    expect(formatImportWarningTitle('geo_data', 'geo.xlsx', t))
      .toBe('地理化数据文件「geo.xlsx」存在问题，数据已导入')
  })

  it('全量工参：标题指明入口类型与文件名', () => {
    expect(formatImportWarningTitle('full_params', 'params.xlsx', t))
      .toBe('全量工参文件「params.xlsx」存在问题，数据已导入')
  })

  it('未知入口类型回退为通用「数据文件」', () => {
    expect(formatImportWarningTitle('unknown', 'x.xlsx', t))
      .toBe('数据文件「x.xlsx」存在问题，数据已导入')
  })
})
