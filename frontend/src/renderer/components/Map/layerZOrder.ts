/**
 * 图层层级（z-order）协调
 * 优先级规则（用户确认）：
 *   1. 只勾选某图层 → 该图层最上
 *   2. 多勾选 → 基站 > 图层文件 > 地理化数据 > 装饰图层
 *   3. 同类型内 → 控制面板顶部最高
 *   4. 只认最高层图层（无穿透）
 */

/** 图层类型 */
export type LayerZType = 'decoration' | 'geodata' | 'mapinfo' | 'sector'

/** 图层类型 rank（低→高 = 底→顶） */
export const LAYER_Z_TYPE_RANK: Record<LayerZType, number> = {
  decoration: 0, // 装饰图层
  geodata: 1,    // 地理化数据
  mapinfo: 2,    // 图层文件
  sector: 3,     // 基站
}

/** 待协调图层条目 */
export interface ZOrderLayer {
  type: LayerZType
  /** 同类型内面板排序；顶部=最高（值越大 rank 越高） */
  panelRank: number
  /** 把该图层渲染层 DOM 元素移到其 pane 顶部 */
  bringToFront: () => void
}

/** 计算 rank；rank 越大越靠上 */
export function computeZRank(type: LayerZType, panelRank: number): number {
  return LAYER_Z_TYPE_RANK[type] * 1000 + panelRank
}

/**
 * 按 rank 升序调用 bringToFront。
 * 最后调用的（rank 最大 = 最高优先级）最终置顶。
 * @param layers 勾选可见的图层（不含隐藏图层）
 */
export function reconcileZOrder(layers: ZOrderLayer[]): void {
  const sorted = [...layers].sort(
    (a, b) => computeZRank(a.type, a.panelRank) - computeZRank(b.type, b.panelRank)
  )
  for (const layer of sorted) {
    layer.bringToFront()
  }
}