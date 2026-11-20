/**
 * 编辑态「刷新」（右键刷新 / 同组他人改动触发的自动刷新）工作集重置口径。
 *
 * 编辑会话渲染的是打开编辑开关时播种的工作集快照，原图层重建对它无效；
 * refreshLayerData / refreshData 在编辑态必须以服务器最新 GeoJSON 调
 * resetWorkspace，否则编辑态下刷新看起来完全无效。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerEditStore } from '../layerEditStore'

function polyFeature(base: number) {
  return {
    type: 'Feature' as const,
    geometry: {
      type: 'Polygon' as const,
      coordinates: [[[base, base + 0.1], [base + 0.1, base + 0.1], [base + 0.1, base + 0.2], [base, base + 0.1]]],
    },
    properties: {},
  }
}

describe('layerEditStore.resetWorkspace', () => {
  beforeEach(() => {
    useLayerEditStore.getState().resetForUserSwitch()
  })

  it('以服务器最新数据整体替换工作集，丢弃未保存修改与撤销历史', () => {
    const s = useLayerEditStore.getState()
    s.beginEdit('layer-a', 'data-1', 'polygon', [polyFeature(114.7)], { version: '"v1"' })
    // 本机产生一次未保存修改（脏标记 + 撤销历史）
    s.addFeature('layer-a', { type: 'Point', coordinates: [114.9, 23.9] })
    const dirty = useLayerEditStore.getState().getWorkspace('layer-a')!
    expect(dirty.dirty).toBe(true)
    expect(dirty.history.length).toBe(1)
    expect(dirty.features.length).toBe(2)
    expect(useLayerEditStore.getState().editableLayerId).toBe('layer-a')

    // 模拟服务器最新整层数据（同事保存后的版本，共 3 个要素）
    const serverFeatures = [polyFeature(114.1), polyFeature(114.2), polyFeature(114.3)]
    useLayerEditStore.getState().resetWorkspace('layer-a', serverFeatures as any, '"v2"')

    const ws = useLayerEditStore.getState().getWorkspace('layer-a')!
    expect(ws.features.length).toBe(3)
    expect(ws.dirty).toBe(false)
    expect(ws.changeCount).toBe(0)
    expect(ws.history).toEqual([])
    expect(ws.changedIds).toEqual({})
    expect(ws.version).toBe('"v2"')
    expect(ws.baseCount).toBe(3)
    // 重置后每个要素都有 _editId 且基底行号已重建
    expect(ws.features.every((f) => !!f.properties?._editId)).toBe(true)
    expect(Object.keys(ws.baseRows).sort()).toEqual(
      ws.features.map((f) => f.properties._editId as string).sort())
    // 仍处于编辑态（刷新不退出编辑开关）
    expect(useLayerEditStore.getState().editableLayerId).toBe('layer-a')
  })

  it('工作集不存在（未打开过编辑）时忽略，不凭空创建', () => {
    useLayerEditStore.getState().resetWorkspace('layer-x', [polyFeature(114.7)] as any, '"v9"')
    expect(useLayerEditStore.getState().getWorkspace('layer-x')).toBeUndefined()
    expect(Object.keys(useLayerEditStore.getState().workspaces)).toEqual([])
  })
})
