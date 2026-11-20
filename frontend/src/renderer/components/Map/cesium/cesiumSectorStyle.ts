/**
 * 扇区最终样式解析（框架无关纯函数）——复刻 SectorRendererSVG._sectorBaseStyle，
 * 但不依赖 Leaflet，供 Cesium 侧调用。只编排现有的配色纯函数，不修改 OnlineMap 侧。
 *
 * 填充色优先级：频点/网络配色 → PCI 模渲染 → 专题配色。
 * 边框/透明度：SECTOR_CONFIG → 默认设置覆盖 → 专题覆盖。
 */
import { getSectorColor, SECTOR_CONFIG } from '../../../config/sector-config'
import type { RenderSectorData } from '../../../services/mapDataService'
import { getPciModColor } from '../../../utils/pciModColor'
import { matchThematicColor, getFieldValue } from '../../../utils/fieldValue'
import { pciDataSyncService } from '../../../services/pciDataSyncService'
import type { ThematicSettings } from '../LabelSettingsModal'

export interface SectorColorOverrides {
  fillOpacity?: number
  borderWidth?: number
}

export interface SectorStyleContext {
  /** PCI 模渲染开关（默认设置） */
  pciRender?: { enabled?: boolean; mod?: 3 | 30 } | null
  /** PCI 模调色板（buildPciModPalette 构建） */
  pciPalette?: string[] | null
  /** 参与 PCI 渲染的频点列表 */
  pciFrequencies?: number[]
  /** 专题设置 */
  thematic?: ThematicSettings | null
  /** 默认设置覆盖（图形透明度/边框宽度） */
  colorOverrides?: SectorColorOverrides | null
}

export interface ResolvedSectorStyle {
  fillColor: string
  strokeColor: string
  strokeWidth: number
  fillOpacity: number
}

/** 工作频点：frequency → ssbFrequency → earfcn；正有限数，否则 null */
export function getSectorFrequency(sector: RenderSectorData): number | null {
  for (const raw of [sector.frequency, sector.ssbFrequency, sector.earfcn]) {
    const num = Number(raw)
    if (Number.isFinite(num) && num > 0) return num
  }
  return null
}

/** PCI 值：优先规划应用后的同步值，再回退工参 pci；须整数，否则 null */
export function getSectorPCI(sector: RenderSectorData): number | null {
  let raw: unknown
  try {
    // 与 SectorRenderer 一致：规划应用后的 PCI 同步值优先
    if (sector.siteId && sector.sectorId) {
      const synced = pciDataSyncService.findSector(sector.siteId, sector.sectorId)
      if (synced && synced.syncedPCI !== undefined) raw = synced.syncedPCI
    }
  } catch { /* ignore */ }
  if (raw === undefined || raw === null) raw = sector.pci
  const num = Number(raw)
  return Number.isInteger(num) ? num : null
}

/** 解析单个扇区最终样式 */
export function resolveSectorStyle(
  sector: RenderSectorData,
  ctx: SectorStyleContext,
): ResolvedSectorStyle {
  const colors = getSectorColor(sector)
  const config = SECTOR_CONFIG[sector.networkType]

  let fillColor = colors.fillColor

  // PCI 模渲染
  if (ctx.pciRender?.enabled && ctx.pciPalette) {
    const frequency = getSectorFrequency(sector)
    const pci = frequency !== null ? getSectorPCI(sector) : null
    const freqIndex = frequency !== null
      ? (ctx.pciFrequencies ?? []).indexOf(frequency)
      : -1
    if (pci !== null && freqIndex >= 0) {
      fillColor = getPciModColor(ctx.pciPalette, freqIndex, ctx.pciRender.mod ?? 3, pci)
    }
  }

  // 专题配色
  if (ctx.thematic?.enabled && ctx.thematic.field) {
    const thematicColor = matchThematicColor(
      ctx.thematic,
      getFieldValue(sector as unknown as Record<string, unknown>, ctx.thematic.field),
    )
    if (thematicColor) fillColor = thematicColor
  }

  let strokeColor = config.strokeColor || '#000000'
  let strokeWidth = config.strokeWidth || 0.5
  let fillOpacity = config.opacity

  // 默认设置覆盖
  if (ctx.colorOverrides) {
    if (typeof ctx.colorOverrides.fillOpacity === 'number') fillOpacity = ctx.colorOverrides.fillOpacity
    if (typeof ctx.colorOverrides.borderWidth === 'number') strokeWidth = ctx.colorOverrides.borderWidth
  }

  // 专题覆盖（透明度/边框色/图形大小）
  // 扇区属面状图层，「图形大小」语义为**边框宽度**（与 2D SectorRendererSVG 及图层文件一致）
  if (ctx.thematic?.enabled) {
    if (typeof ctx.thematic.fillOpacity === 'number') fillOpacity = ctx.thematic.fillOpacity
    if (ctx.thematic.borderColor) strokeColor = ctx.thematic.borderColor
    if (typeof ctx.thematic.pointSize === 'number') strokeWidth = ctx.thematic.pointSize
  }

  return { fillColor, strokeColor, strokeWidth, fillOpacity }
}
