/**
 * SectorSVGLayer 小区PCI渲染测试
 *
 * 渲染条件：同频点且同 PCI 模3/模30 才同色；且图例只展示控制面板
 * 已勾选可见的频点（与频点复选框状态一致）。
 * 覆盖：默认关闭、同频同模/异模、异频同模、模30、勾选门控、
 * 无频点/无PCI小区、关闭回切、专题优先、图例统计、
 * 字符串/非整数 PCI。
 */
import { describe, it, expect } from 'vitest'
import { SectorSVGLayer } from '../SectorRendererSVG'
import { getPciModColor, buildPciModPalette } from '../../../utils/pciModColor'
import { getSectorColor } from '../../../config/sector-config'
import type { ThematicSettings } from '../LabelSettingsModal'

const FULL_OVERRIDES = { fillOpacity: 1, borderWidth: 1 }

/** 构造扇区（频点/PCI 可定制） */
function makeSector(id: string, networkType: 'LTE' | 'NR', extra: Record<string, unknown> = {}) {
  return { id, name: `小区${id}`, networkType, ...extra }
}

/**
 * 创建图层并在控制面板勾选指定频点。
 * setFrequenciesVisibility 与频点复选框同源：传入 true 的频点才可见。
 */
function setupLayer(sectors: Record<string, unknown>[], checkedFrequencies: number[] = []) {
  const layer = new SectorSVGLayer({ sectors: sectors as any, zoom: 12 })
  if (checkedFrequencies.length > 0) {
    layer.setFrequenciesVisibility(new Map(checkedFrequencies.map(f => [f, true])))
  }
  return layer
}

describe('SectorSVGLayer 小区PCI渲染', () => {
  it('默认关闭：填充色为网络类型/频点配色', () => {
    const sector = makeSector('l1', 'LTE', { frequency: 100, pci: 100 })
    const layer = setupLayer([sector], [100])
    expect((layer as any)._sectorBaseStyle(sector).fillColor)
      .toBe(getSectorColor(sector).fillColor)
  })

  it('同频点同模值（PCI=100 与 PCI=103）→ 同色', () => {
    const s1 = makeSector('l1', 'LTE', { frequency: 100, pci: 100 })
    const s2 = makeSector('l2', 'LTE', { frequency: 100, pci: 103 })
    const layer = setupLayer([s1, s2], [100])
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 3 })
    const style1 = (layer as any)._sectorBaseStyle(s1).fillColor
    const style2 = (layer as any)._sectorBaseStyle(s2).fillColor
    expect(style1).toBe(style2)
    // 与调色板组合色一致（频点序号0 × 3 + 模值1）
    expect(style1).toBe(getPciModColor(buildPciModPalette(1, 3), 0, 3, 100))
  })

  it('同频点不同模值（PCI=100 与 101）→ 异色', () => {
    const s1 = makeSector('l1', 'LTE', { frequency: 100, pci: 100 })
    const s2 = makeSector('l2', 'LTE', { frequency: 100, pci: 101 })
    const layer = setupLayer([s1, s2], [100])
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 3 })
    expect((layer as any)._sectorBaseStyle(s1).fillColor)
      .not.toBe((layer as any)._sectorBaseStyle(s2).fillColor)
  })

  it('不同频点即使模值相同（PCI%3 均为 1）→ 异色', () => {
    const s1 = makeSector('l1', 'LTE', { frequency: 100, pci: 100 })
    const s2 = makeSector('l2', 'LTE', { frequency: 200, pci: 130 }) // 130%3=1
    const layer = setupLayer([s1, s2], [100, 200])
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 3 })
    expect((layer as any)._sectorBaseStyle(s1).fillColor)
      .not.toBe((layer as any)._sectorBaseStyle(s2).fillColor)
  })

  it('开启模30：填充色 = 频点 × 30 + PCI%30 组合颜色', () => {
    const sector = makeSector('n1', 'NR', { frequency: 500, pci: 500 })
    const layer = setupLayer([sector], [500])
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 30 })
    // 500 % 30 = 20
    expect((layer as any)._sectorBaseStyle(sector).fillColor)
      .toBe(getPciModColor(buildPciModPalette(1, 30), 0, 30, 500))
  })

  it('勾选频点下无有效PCI：保持原配色，计入 noPci', () => {
    const sector = makeSector('l1', 'LTE', { frequency: 100 })
    const layer = setupLayer([sector], [100])
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 3 })
    expect((layer as any)._sectorBaseStyle(sector).fillColor)
      .toBe(getSectorColor(sector).fillColor)
    expect(layer.getPciRenderStats()!.noPci).toBe(1)
  })

  it('无有效频点：保持原配色，计入 noFrequency（不看PCI/勾选）', () => {
    const sector = makeSector('l1', 'LTE', { pci: 100 })
    const layer = setupLayer([sector])
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 3 })
    expect((layer as any)._sectorBaseStyle(sector).fillColor)
      .toBe(getSectorColor(sector).fillColor)
    const stats = layer.getPciRenderStats()!
    expect(stats.noFrequency).toBe(1)
    expect(stats.noPci).toBe(0)
    expect(stats.total).toBe(0)
    expect(stats.frequencies).toEqual([])
  })

  it('频点解析回退：frequency 缺失时勾选的 ssbFrequency/earfcn 入图例', () => {
    const s1 = makeSector('n1', 'NR', { ssbFrequency: 700, pci: 100 })
    const s2 = makeSector('n2', 'NR', { earfcn: 800, pci: 100 })
    const layer = setupLayer([s1, s2], [700, 800])
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 30 })
    const stats = layer.getPciRenderStats()!
    expect(stats.frequencies.map(f => f.frequency)).toEqual([700, 800])
    expect(stats.total).toBe(2)
  })

  it('未勾选任何频点：图例统计无频点分组、total/noPci 均为 0', () => {
    const s1 = makeSector('l1', 'LTE', { frequency: 100, pci: 100 })
    const s2 = makeSector('l2', 'LTE', { frequency: 100 })
    const layer = setupLayer([s1, s2]) // 不勾选
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 3 })
    const stats = layer.getPciRenderStats()!
    expect(stats.frequencies).toEqual([])
    expect(stats.total).toBe(0)
    expect(stats.noPci).toBe(0)
    // PCI 配色不生效：扇区保持原配色（pciFrequencies 为空 → 频点序号 -1 门控）
    expect((layer as any)._sectorBaseStyle(s1).fillColor)
      .toBe(getSectorColor(s1).fillColor)
  })

  it('只勾选部分频点：未勾选频点不进图例，其小区（含无PCI）一律不计', () => {
    // 频点100：PCI 100；频点200：PCI 130（模1）+ 无PCI 1
    const sectors = [
      makeSector('l1', 'LTE', { frequency: 100, pci: 100 }),
      makeSector('l2', 'LTE', { frequency: 200, pci: 130 }),
      makeSector('l3', 'LTE', { frequency: 200 }),
    ]
    const layer = setupLayer(sectors, [100]) // 仅勾选100
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 3 })
    const stats = layer.getPciRenderStats()!
    expect(stats.frequencies.map(f => f.frequency)).toEqual([100])
    expect(stats.total).toBe(1)
    expect(stats.noPci).toBe(0) // 频点200下无PCI小区不计入
  })

  it('频点勾选状态变化后统计同步：取消勾选 → 频点移出图例', () => {
    const s1 = makeSector('l1', 'LTE', { frequency: 100, pci: 100 })
    const s2 = makeSector('l2', 'LTE', { frequency: 200, pci: 130 })
    const layer = setupLayer([s1, s2], [100, 200])
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 3 })
    expect(layer.getPciRenderStats()!.frequencies.map(f => f.frequency)).toEqual([100, 200])
    // 控制面板取消勾选频点200（与频点复选框同入口）
    layer.setFrequencyVisibility(200, false)
    const stats = layer.getPciRenderStats()!
    expect(stats.frequencies.map(f => f.frequency)).toEqual([100])
    expect(stats.total).toBe(1)
    // 重新勾选 → 恢复
    layer.setFrequencyVisibility(200, true)
    expect(layer.getPciRenderStats()!.frequencies.map(f => f.frequency)).toEqual([100, 200])
  })

  it('关闭PCI渲染后：恢复频点配色', () => {
    const sector = makeSector('l1', 'LTE', { frequency: 100, pci: 100 })
    const layer = setupLayer([sector], [100])
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 3 })
    expect(layer.getPciRenderStats()).not.toBeNull()
    layer.setColorOverrides(FULL_OVERRIDES)
    expect((layer as any)._sectorBaseStyle(sector).fillColor)
      .toBe(getSectorColor(sector).fillColor)
  })

  it('专题图层启用时：专题色优先于PCI配色', () => {
    const sector = makeSector('l1', 'LTE', { frequency: 100, pci: 100 })
    const layer = setupLayer([sector], [100])
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 3 })
    const thematic: ThematicSettings = {
      enabled: true,
      field: 'networkType',
      fieldType: 'text',
      pointSize: 8,
      ranges: [],
      categories: [{ value: 'LTE', color: '#123456' }],
    }
    layer.setThematicOverrides(thematic)
    expect((layer as any)._sectorBaseStyle(sector).fillColor).toBe('#123456')
  })

  it('图例统计：仅勾选频点按升序分组，counts/total 自洽', () => {
    // 频点 200: PCI 130(模1)；频点 100: PCI 100(模1)、101(模2)、无PCI 1；无频点 1
    const sectors = [
      makeSector('l1', 'LTE', { frequency: 200, pci: 130 }),
      makeSector('l2', 'LTE', { frequency: 100, pci: 100 }),
      makeSector('l3', 'LTE', { frequency: 100, pci: 101 }),
      makeSector('l4', 'LTE', { frequency: 100 }),
      makeSector('l5', 'LTE', { pci: 100 }),
    ]
    const layer = setupLayer(sectors, [100, 200])
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 3 })
    const stats = layer.getPciRenderStats()!
    expect(stats.frequencies.map(f => f.frequency)).toEqual([100, 200])
    const g100 = stats.frequencies[0]
    expect(g100.counts).toEqual([0, 1, 1])
    expect(g100.total).toBe(2)
    const g200 = stats.frequencies[1]
    expect(g200.counts).toEqual([0, 1, 0])
    expect(g200.total).toBe(1)
    expect(stats.total).toBe(3)
    expect(stats.noPci).toBe(1)
    expect(stats.noFrequency).toBe(1)
  })

  it('字符串型PCI可解析为整数时正常取模；"N/A"/100.5 在勾选频点下计 noPci', () => {
    const s1 = makeSector('l1', 'LTE', { frequency: 100, pci: '100' })
    const s2 = makeSector('l2', 'LTE', { frequency: 100, pci: 'N/A' })
    const s3 = makeSector('l3', 'LTE', { frequency: 100, pci: 100.5 })
    const layer = setupLayer([s1, s2, s3], [100])
    layer.setColorOverrides({ ...FULL_OVERRIDES, pciRenderEnabled: true, pciMod: 3 })
    expect((layer as any)._sectorBaseStyle(s1).fillColor)
      .toBe(getPciModColor(buildPciModPalette(1, 3), 0, 3, 100))
    const stats = layer.getPciRenderStats()!
    expect(stats.total).toBe(1)
    expect(stats.noPci).toBe(2)
  })

  it('PCI渲染关闭时：图例统计为 null', () => {
    const sector = makeSector('l1', 'LTE', { frequency: 100, pci: 100 })
    const layer = setupLayer([sector], [100])
    layer.setColorOverrides(FULL_OVERRIDES)
    expect(layer.getPciRenderStats()).toBeNull()
  })
})
