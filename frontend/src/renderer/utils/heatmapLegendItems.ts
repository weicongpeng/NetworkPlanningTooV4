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
 * 构建热力图图例项：只取「控制面板已勾选可见、且已启用热力图」的图层。
 *
 * 图层列表是唯一真源，设置表仅按图层 id 补配置。未勾选的图层、以及设置 key
 * 与当前图层对不上的历史残留（跨端同步 / 图层删除后遗留的 enabled 设置）都不出
 * 图例——否则会出现「UUID - 字段」这类与当前图层无关的字段标题，且画面颜色
 * 与图例不符。与专题图例口径一致（visible && enabled）。
 */
export function buildHeatmapLegendItems(
  settingsMap: Record<string, HeatmapSettings> | undefined,
  layers: HeatmapLegendSource[],
): HeatmapLegendEntry[] {
  const map = settingsMap || {}
  const items: HeatmapLegendEntry[] = []
  for (const layer of layers) {
    const settings = map[layer.id]
    if (layer.visible && settings?.enabled) {
      items.push({ id: layer.id, name: layer.name, settings })
    }
  }
  return items
}
