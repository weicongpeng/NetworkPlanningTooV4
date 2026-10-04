/**
 * 小区PCI渲染配色工具测试（同频点 + 同模值 才同色）
 *
 * 覆盖：同频同模同色、同频异模异色、异频同模异色、
 * PCI 取模正确（大值/负值归一化）、调色板长度 = 频点数 × mod。
 */
import { describe, it, expect } from 'vitest'
import { buildPciModPalette, getPciModColor } from '../../../utils/pciModColor'

describe('小区PCI渲染配色 buildPciModPalette / getPciModColor', () => {
  it('调色板长度 = 频点数 × mod', () => {
    expect(buildPciModPalette(2, 3)).toHaveLength(6)
    expect(buildPciModPalette(3, 30)).toHaveLength(90)
  })

  it('同频点且同模值 → 颜色相同（PCI 相差 mod 的整数倍）', () => {
    const palette = buildPciModPalette(3, 3)
    expect(getPciModColor(palette, 1, 3, 100)).toBe(getPciModColor(palette, 1, 3, 103))
    const palette30 = buildPciModPalette(3, 30)
    expect(getPciModColor(palette30, 2, 30, 100)).toBe(getPciModColor(palette30, 2, 30, 130))
  })

  it('同频点不同模值 → 颜色不同', () => {
    const palette = buildPciModPalette(2, 3)
    expect(getPciModColor(palette, 0, 3, 0)).not.toBe(getPciModColor(palette, 0, 3, 1))
    expect(getPciModColor(palette, 0, 3, 1)).not.toBe(getPciModColor(palette, 0, 3, 2))
    const palette30 = buildPciModPalette(2, 30)
    expect(getPciModColor(palette30, 1, 30, 5)).not.toBe(getPciModColor(palette30, 1, 30, 6))
  })

  it('不同频点即使模值相同 → 颜色不同', () => {
    const palette = buildPciModPalette(3, 3)
    expect(getPciModColor(palette, 0, 3, 0)).not.toBe(getPciModColor(palette, 1, 3, 0))
    expect(getPciModColor(palette, 0, 3, 2)).not.toBe(getPciModColor(palette, 2, 3, 2))
    const palette30 = buildPciModPalette(3, 30)
    expect(getPciModColor(palette30, 0, 30, 10)).not.toBe(getPciModColor(palette30, 1, 30, 10))
  })

  it('PCI 取模正确：大值 PCI 映射到对应模值颜色', () => {
    // 500 % 30 = 20
    const palette30 = buildPciModPalette(2, 30)
    expect(getPciModColor(palette30, 1, 30, 500)).toBe(getPciModColor(palette30, 1, 30, 20))
    // 100 % 3 = 1
    const palette = buildPciModPalette(2, 3)
    expect(getPciModColor(palette, 0, 3, 100)).toBe(getPciModColor(palette, 0, 3, 1))
  })

  it('异常负值 PCI：归一化到 [0, mod) 后取色', () => {
    const palette = buildPciModPalette(2, 3)
    expect(getPciModColor(palette, 0, 3, -1)).toBe(getPciModColor(palette, 0, 3, 2))
    const palette30 = buildPciModPalette(2, 30)
    expect(getPciModColor(palette30, 1, 30, -1)).toBe(getPciModColor(palette30, 1, 30, 29))
  })
})
