/**
 * 规划模式高亮样式解析（框架无关纯函数）。
 *
 * 根据渲染模式与高亮配置决定单个扇区颜色，视觉对等 SectorRendererSVG：
 * - PCI 规划：选中扇区红、同频同 PCI 关联扇区橙，其余返回 null（走基础配色）
 * - 邻区规划：源小区红、目标小区蓝、其余白
 * - TAC 核查：按 TAC 配色、选中红框、插花（isSingularity）紫框
 * - 默认模式：返回 null（走基础配色）
 */
import type { RenderSectorData } from '../../../services/mapDataService'
import { tacColorMapper } from '../../../utils/tacColors'
import type {
  PCIHighlightConfig,
  TACHighlightConfig,
  NeighborHighlightConfig,
} from '../SectorRendererSVG'
import type { ResolvedSectorStyle } from './cesiumSectorStyle'

export interface PlanningHighlight {
  pci?: PCIHighlightConfig | null
  neighbor?: NeighborHighlightConfig | null
  tac?: TACHighlightConfig | null
}

export function resolvePlanningStyle(
  sector: RenderSectorData,
  renderMode: string,
  hl: PlanningHighlight,
): ResolvedSectorStyle | null {
  const id = String(sector.id)

  if (renderMode === 'pci-planning') {
    const cfg = hl.pci
    if (cfg && id === String(cfg.selectedId)) {
      return { fillColor: '#ef4444', strokeColor: '#000000', strokeWidth: 3, fillOpacity: 0.9 }
    }
    if (cfg && cfg.relatedIds.map(String).includes(id)) {
      return { fillColor: '#f97316', strokeColor: '#000000', strokeWidth: 2, fillOpacity: 0.9 }
    }
    return null // 名单内其余扇区：基础配色
  }

  if (renderMode === 'neighbor-planning') {
    const cfg = hl.neighbor
    if (cfg && id === String(cfg.sourceSectorId)) {
      return {
        fillColor: cfg.sourceColor || '#FF0000',
        strokeColor: '#000000', strokeWidth: 3, fillOpacity: 0.9,
      }
    }
    if (cfg && cfg.targetSectorIds.has(id)) {
      return {
        fillColor: cfg.targetColor || '#0000FF',
        strokeColor: '#000000', strokeWidth: 2, fillOpacity: 0.85,
      }
    }
    return { fillColor: '#FFFFFF', strokeColor: '#000000', strokeWidth: 1.5, fillOpacity: 1 }
  }

  if (renderMode === 'tac-check') {
    const cfg = hl.tac
    const sectorTac = (sector as unknown as { syncedTAC?: number }).syncedTAC || sector.tac
    const networkType = cfg?.networkType || sector.networkType
    const selected = !!cfg && id === String(cfg.selectedId)
    const singularity = (sector as unknown as { isSingularity?: boolean }).isSingularity

    let style: ResolvedSectorStyle
    if (sectorTac) {
      const tacColor = tacColorMapper.getColor(String(sectorTac), networkType)
      style = {
        fillColor: tacColor.color,
        strokeColor: selected ? '#FF0000' : tacColor.strokeColor,
        strokeWidth: selected ? 6 : 1.5,
        fillOpacity: selected ? 1 : 0.85,
      }
    } else {
      style = {
        fillColor: '#E5E7EB',
        strokeColor: selected ? '#FF0000' : '#9CA3AF',
        strokeWidth: selected ? 6 : 1.5,
        fillOpacity: 0.8,
      }
    }
    // 插花小区：紫色边框
    if (singularity) {
      style = { ...style, strokeColor: '#A855F7', strokeWidth: 2.5 }
    }
    return style
  }

  return null
}
