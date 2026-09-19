import { describe, it, expect } from 'vitest'
import { orderWithIds, panelRankFromIndex, isLayerSelectable, computeZRank, LAYER_Z_TYPE_RANK } from '../layerZOrder'

describe('orderWithIds', () => {
  it('按持久化顺序排列已存在的 id', () => {
    expect(orderWithIds(['b', 'a'], ['a', 'b'])).toEqual(['b', 'a'])
  })

  it('新增 id（未收录）按自然顺序追加到底部', () => {
    expect(orderWithIds(['a'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('持久化中已不存在的 id 被剔除', () => {
    expect(orderWithIds(['a', 'x', 'b'], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('stored 为 undefined 时返回自然顺序', () => {
    expect(orderWithIds(undefined, ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('去重：stored 与当前列表中的重复 id 只保留一次', () => {
    expect(orderWithIds(['a', 'a'], ['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('panelRankFromIndex', () => {
  it('索引 0（面板最上）rank 最大', () => {
    expect(panelRankFromIndex(0, 3)).toBe(2)
    expect(panelRankFromIndex(1, 3)).toBe(1)
    expect(panelRankFromIndex(2, 3)).toBe(0)
  })

  it('类内 panelRank 不会跨入相邻类型区间（< 1000）', () => {
    const total = 500
    expect(panelRankFromIndex(0, total)).toBeLessThan(1000)
    // 最低类型最高位仍低于上一类型最低位
    const geoTop = computeZRank('geodata', panelRankFromIndex(0, total))
    const mapinfoBottom = computeZRank('mapinfo', panelRankFromIndex(total - 1, total))
    expect(geoTop).toBeLessThan(mapinfoBottom)
  })
})

describe('isLayerSelectable', () => {
  it('selectableMap 未收录该 id 时默认可选（true）', () => {
    expect(isLayerSelectable({}, 'any-layer')).toBe(true)
    expect(isLayerSelectable(undefined, 'any-layer')).toBe(true)
  })

  it('显式 false 时不可选', () => {
    expect(isLayerSelectable({ 'lte-sectors': false }, 'lte-sectors')).toBe(false)
  })

  it('显式 true 时可选', () => {
    expect(isLayerSelectable({ x: true }, 'x')).toBe(true)
  })
})

describe('跨类型层级固定：基站 > 图层文件 > 地理化数据 > 装饰图层', () => {
  it('类型 rank 满足 sector > mapinfo > geodata > decoration', () => {
    expect(LAYER_Z_TYPE_RANK.sector).toBeGreaterThan(LAYER_Z_TYPE_RANK.mapinfo)
    expect(LAYER_Z_TYPE_RANK.mapinfo).toBeGreaterThan(LAYER_Z_TYPE_RANK.geodata)
    expect(LAYER_Z_TYPE_RANK.geodata).toBeGreaterThan(LAYER_Z_TYPE_RANK.decoration)
  })

  it('低类型类内最高位仍低于高类型类内最低位', () => {
    const rank = (type: keyof typeof LAYER_Z_TYPE_RANK, index: number, total: number) =>
      computeZRank(type, panelRankFromIndex(index, total))
    // 地理化数据类内第 0 位 < 图层文件类内最底位
    expect(rank('geodata', 0, 10)).toBeLessThan(rank('mapinfo', 9, 10))
    // 图层文件类内第 0 位 < 基站类内最底位
    expect(rank('mapinfo', 0, 10)).toBeLessThan(rank('sector', 9, 10))
    // 装饰类内最高 < 地理化数据最底
    expect(rank('decoration', 0, 1)).toBeLessThan(rank('geodata', 9, 10))
  })
})
