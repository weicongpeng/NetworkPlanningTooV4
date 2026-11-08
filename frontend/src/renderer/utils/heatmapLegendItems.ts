import type { HeatmapSettings } from '../components/Map/LabelSettingsModal'

export interface HeatmapLegendSource {
  id: string
  name: string
  visible: boolean
}

export interface HeatmapLegendEntry {
  id: string
  name: string
  settings: HeatmapSettings
}

/**
 * 构建热力图图例项：以「已启用的热力图设置」为真源，图层列表只用来补名字。
 *
 * 桌面端同组同步/重新导入后，图层 id 可能与保存设置时的 id 不一致，或图层列表
 * 仍在异步加载。仅按 id 精确匹配会让整个图例静默消失（专题图例恰好匹配上就正常），
 * 因此对未匹配到的已启用设置做兜底条目，保证图例一定出现、用户能看出配置状态。
 */
export function buildHeatmapLegendItems(
  settingsMap: Record<string, HeatmapSettings> | undefined,
  layers: HeatmapLegendSource[],
): HeatmapLegendEntry[] {
  const map = settingsMap || {}
  const items: HeatmapLegendEntry[] = []
  const matched = new Set<string>()

  for (const layer of layers) {
    const settings = map[layer.id]
    if (layer.visible && settings?.enabled) {
      items.push({ id: layer.id, name: layer.name, settings })
      matched.add(layer.id)
    }
  }

  for (const [id, settings] of Object.entries(map)) {
    if (!settings?.enabled || matched.has(id)) continue
    items.push({ id, name: id, settings })
  }

  return items
}
