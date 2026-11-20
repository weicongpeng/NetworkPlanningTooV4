import { describe, it, expect } from 'vitest'
import { autoMatchFields } from '../layer-config'

// 表头与后端 layer_service._TEMPLATE_SPECS 一致：模板下载后上传必须能自动完成字段映射，
// 否则用户按模板填好数据仍要手工逐列选择
const SECTOR_TEMPLATE_COLUMNS = ['小区名称', '经度', '纬度', '方位角', '覆盖类型', 'PCI', '频点']
const POINT_TEMPLATE_COLUMNS = ['小区名称', '经度', '纬度', 'PCI', '频点']

describe('autoMatchFields', () => {
  it('扇区图层模板表头全部自动匹配（含方位角与覆盖类型）', () => {
    expect(autoMatchFields(SECTOR_TEMPLATE_COLUMNS, true, false, true)).toEqual({
      name: '小区名称',
      longitude: '经度',
      latitude: '纬度',
      azimuth: '方位角',
      coverage: '覆盖类型',
    })
  })

  it('点图层模板表头全部自动匹配（不映射方位角/覆盖类型）', () => {
    expect(autoMatchFields(POINT_TEMPLATE_COLUMNS, false)).toEqual({
      name: '小区名称',
      longitude: '经度',
      latitude: '纬度',
    })
  })
})
