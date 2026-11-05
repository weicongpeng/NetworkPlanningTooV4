/**
 * 条件选择候选图层构建（纯函数，无 React / api 依赖，便于单测）
 */
import type { AttributeJoinLayerRef } from '@shared/types'
import type { SectorLayerOption, LayerFileOption } from './LayerControl'

/** 候选分组（固定 key，渲染时再翻译，避免依赖翻译文本做逻辑） */
export type JoinGroup = 'baseStation' | 'layerFiles' | 'geoData'

export interface JoinOption {
  key: string
  group: JoinGroup
  label: string
  ref: AttributeJoinLayerRef
  /** 是否为面状（决定能否进入图层2） */
  isPolygon: boolean
}

export const JOIN_GROUP_ORDER: JoinGroup[] = ['baseStation', 'layerFiles', 'geoData']

/** 图层1候选：基站扇区 + 图层文件 + 地理化数据（不要求可见，按存储读取） */
export function buildLayer1Options(
  layers: SectorLayerOption[],
  layerFiles: LayerFileOption[],
  pointFiles: LayerFileOption[],
): JoinOption[] {
  const out: JoinOption[] = []
  for (const l of layers) {
    out.push({
      key: `sector:${l.id}:${l.type}`,
      group: 'baseStation',
      label: l.label,
      ref: { kind: 'sector', networkType: l.type },
      isPolygon: false,
    })
  }
  for (const f of layerFiles) {
    out.push({
      key: `mapinfo:${f.dataId}:${f.id}`,
      group: 'layerFiles',
      label: f.name,
      ref: { kind: 'mapinfo', dataId: f.dataId, layerId: f.id },
      isPolygon: f.type === 'polygon' || f.type === 'mixed',
    })
  }
  for (const f of pointFiles) {
    out.push({
      key: `geodata:${f.dataId}`,
      group: 'geoData',
      label: f.name,
      ref: { kind: 'geodata', dataId: f.dataId },
      isPolygon: f.type === 'polygon' || f.geometryType === 'polygon',
    })
  }
  return out
}

/** 图层2候选：仅面状图层（扇区不参与） */
export function buildLayer2Options(all: JoinOption[]): JoinOption[] {
  return all.filter((o) => o.isPolygon)
}
