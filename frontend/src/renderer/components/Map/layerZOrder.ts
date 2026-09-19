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

/**
 * 把持久化的类内顺序与当前实际图层 id 合并：
 * 先按 stored 顺序保留仍存在的 id，再把新出现的 id 按自然顺序追加到底部。
 * @param stored 持久化的 id 顺序（索引 0 = 面板最上），可能为 undefined
 * @param currentIds 当前类别下实际存在的图层 id（自然顺序）
 */
export function orderWithIds(stored: string[] | undefined, currentIds: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of stored ?? []) {
    if (currentIds.includes(id) && !seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  for (const id of currentIds) {
    if (!seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  return result
}

/**
 * 类内面板顺序索引 → panelRank：索引 0（面板最上）rank 最大。
 * 同类图层数量远小于 1000，panelRank 不会跨入相邻类型区间。
 */
export function panelRankFromIndex(index: number, total: number): number {
  return total - 1 - index
}

/**
 * 图层"可选"开关判定：selectableMap 未收录该 id 时默认可选（true）。
 */
export function isLayerSelectable(selectableMap: Record<string, boolean> | undefined, layerId: string): boolean {
  return selectableMap?.[layerId] !== false
}