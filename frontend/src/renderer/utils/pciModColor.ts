/**
 * 小区PCI渲染配色（同频点 + 同模3/模30 才同色）
 *
 * 每个"频点 × 模值"组合对应一个颜色：
 * - 同频点且同模值 → 同色；同频点异模值 / 异频点即使模值相同 → 不同色；
 * - 组合按 频点序号 × mod + 模值 线性编号，用黄金角 HSL 生成
 *   freqCount × mod 色（见 fieldValue.generateGeoIsolatedColors），
 *   相邻组合色相差大、整体均匀。
 */

import { generateGeoIsolatedColors } from './fieldValue'

/** PCI 取模方式：3 或 30 */
export type PciMod = 3 | 30

/** 单个频点的PCI模值统计 */
export interface PciRenderFreqStats {
  /** 频点值 */
  frequency: number
  /** 各模值的小区数（长度 = mod） */
  counts: number[]
  /** 该频点下有有效PCI的小区数 */
  total: number
}

/** 小区PCI渲染图例统计（按频点分组） */
export interface PciRenderStats {
  /** 各频点的模值统计（频点升序） */
  frequencies: PciRenderFreqStats[]
  /** 有有效频点+PCI的小区总数 */
  total: number
  /** 有频点但无有效PCI的小区数 */
  noPci: number
  /** 无有效频点的小区数（不参与PCI渲染，保持原配色） */
  noFrequency: number
}

/**
 * 构建某扇区图层的PCI渲染调色板（freqCount 个频点 × mod 个模值）。
 */
export function buildPciModPalette(freqCount: number, mod: PciMod): string[] {
  return generateGeoIsolatedColors(freqCount * mod)
}

/**
 * 取"频点 × 模值"组合在调色板中的颜色。
 * @param palette buildPciModPalette 生成的调色板
 * @param freqIndex 频点在有序频点列表中的序号
 * @param mod 取模方式
 * @param pci 小区PCI（取模值先归一化到 [0, mod)，兼容异常负值）
 */
export function getPciModColor(
  palette: string[],
  freqIndex: number,
  mod: PciMod,
  pci: number
): string {
  const modValue = ((pci % mod) + mod) % mod
  return palette[freqIndex * mod + modValue]
}
