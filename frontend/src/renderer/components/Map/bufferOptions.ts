/**
 * 缓冲区候选图层构建（纯函数，无 React / api 依赖，便于单测）
 *
 * 参考图层候选直接复用 attributeJoinOptions.buildLayer1Options（点/线/面全允许）。
 */
import type { BufferTargetRef } from '@shared/types'
import type { LayerFileOption } from './LayerControl'

export interface BufferTargetOption {
  key: string
  label: string
  ref: BufferTargetRef
}

/**
 * 保存目标候选：装饰图层（固定首项）+ 可写的 TAB 图层中
 * 几何类型为 polygon/mixed 的图层（点/线型 TAB 无法容纳缓冲多边形）。
 * 地理化数据 excel 不可写，不列入。
 *
 * 限定 format === 'tab'：缓冲区写入走后端增量保存，而增量保存目前只支持 TAB
 * （Shapefile/GeoJSON 的样式落在 .qml）。列出它们只会在保存时失败。
 */
export function buildBufferTargetOptions(
  layerFiles: LayerFileOption[],
): BufferTargetOption[] {
  const out: BufferTargetOption[] = [
    { key: 'decoration', label: '装饰图层', ref: { kind: 'decoration' } },
  ]
  for (const f of layerFiles) {
    if (f.editable !== true) continue
    if (f.format !== 'tab') continue
    if (f.type !== 'polygon' && f.type !== 'mixed') continue
    out.push({
      key: `mapinfo:${f.dataId}:${f.id}`,
      label: f.name,
      ref: { kind: 'mapinfo', dataId: f.dataId, layerId: f.id },
    })
  }
  return out
}
