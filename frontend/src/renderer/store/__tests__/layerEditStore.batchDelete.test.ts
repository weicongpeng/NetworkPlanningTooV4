import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerEditStore } from '../layerEditStore'

/**
 * 批量删除 deleteFeatures 测试
 *
 * 修复回归：边界选择大批量选中后逐个删除（deleteFeature × N）会产生 N 次
 * JSON 深拷贝历史 + N 次全图层重建（O(N²)），页面卡死。批量删除必须
 * 一次写入、只压一条 history、返回实际删除数。
 */
describe('layerEditStore deleteFeatures 批量删除', () => {
  beforeEach(() => {
    useLayerEditStore.setState({
      editableLayerId: null,
      drawTool: 'none',
      selectMode: false,
      snapEnabled: false,
      nodeMergeMode: false,
      workspaces: {},
      clipboard: [],
      inspectFeature: null,
    })
  })

  function makeFeature(editId: string) {
    return {
      type: 'Feature' as const,
      properties: { _editId: editId },
      geometry: { type: 'Point', coordinates: [0, 0] },
    }
  }

  it('一次删除多个要素：剩余要素正确、返回实际删除数', () => {
    const store = useLayerEditStore.getState()
    store.beginEdit('L1', 'D1', 'point', [
      makeFeature('e1'), makeFeature('e2'), makeFeature('e3'),
    ])

    const n = useLayerEditStore.getState().deleteFeatures('L1', ['e1', 'e3'])
    expect(n).toBe(2)

    const ws = useLayerEditStore.getState().getWorkspace('L1')!
    expect(ws.features.map((f) => f.properties._editId)).toEqual(['e2'])
  })

  it('只压一条 history：一次撤销可回退全部删除', () => {
    const store = useLayerEditStore.getState()
    store.beginEdit('L1', 'D1', 'point', [
      makeFeature('e1'), makeFeature('e2'), makeFeature('e3'),
    ])
    const historyBefore = useLayerEditStore.getState().getWorkspace('L1')!.history.length

    useLayerEditStore.getState().deleteFeatures('L1', ['e1', 'e2', 'e3'])

    const ws = useLayerEditStore.getState().getWorkspace('L1')!
    expect(ws.history.length).toBe(historyBefore + 1)

    useLayerEditStore.getState().undo('L1')
    const restored = useLayerEditStore.getState().getWorkspace('L1')!
    expect(restored.features.map((f) => f.properties._editId).sort()).toEqual(['e1', 'e2', 'e3'])
  })

  it('不存在的 id / 空数组 / 不存在的图层：不产生变更', () => {
    const store = useLayerEditStore.getState()
    store.beginEdit('L1', 'D1', 'point', [makeFeature('e1')])

    expect(useLayerEditStore.getState().deleteFeatures('L1', ['nope'])).toBe(0)
    expect(useLayerEditStore.getState().deleteFeatures('L1', [])).toBe(0)
    expect(useLayerEditStore.getState().deleteFeatures('NOPE', ['e1'])).toBe(0)

    const ws = useLayerEditStore.getState().getWorkspace('L1')!
    expect(ws.features.map((f) => f.properties._editId)).toEqual(['e1'])
  })
})
