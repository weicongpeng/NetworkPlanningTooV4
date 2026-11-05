import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerEditStore } from '../layerEditStore'

describe('layerEditStore 节点合并相关状态', () => {
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

  it('snapEnabled 是独立开关：切工具/合并不影响它', () => {
    useLayerEditStore.getState().setSnapEnabled(true)
    useLayerEditStore.getState().setNodeMergeMode(true)
    expect(useLayerEditStore.getState().snapEnabled).toBe(true)
    useLayerEditStore.getState().setDrawTool('line')
    expect(useLayerEditStore.getState().snapEnabled).toBe(true)
    expect(useLayerEditStore.getState().nodeMergeMode).toBe(false)
  })

  it('setNodeMergeMode 开启时退出绘制与选择', () => {
    const s = useLayerEditStore.getState()
    s.setDrawTool('line')
    expect(useLayerEditStore.getState().drawTool).toBe('line')
    s.setNodeMergeMode(true)
    const st = useLayerEditStore.getState()
    expect(st.nodeMergeMode).toBe(true)
    expect(st.drawTool).toBe('none')
    expect(st.selectMode).toBe(false)
  })

  it('applyMergeResult：多要素一次写入、只压一条 history、一次撤销全部回退', () => {
    const store = useLayerEditStore.getState()
    const f1 = {
      type: 'Feature' as const,
      properties: { _editId: 'e1' },
      geometry: { type: 'LineString', coordinates: [[0, 0], [0, 1]] },
    }
    const f2 = {
      type: 'Feature' as const,
      properties: { _editId: 'e2' },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    }
    store.beginEdit('L1', 'D1', 'mixed', [f1, f2])

    const newG1 = { type: 'LineString', coordinates: [[0, 0], [0, 1], [1, 1]] }
    const newG2 = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] }
    useLayerEditStore.getState().applyMergeResult('L1', [
      { editId: 'e1', geometry: newG1 },
      { editId: 'e2', geometry: newG2 },
    ])

    const ws = useLayerEditStore.getState().getWorkspace('L1')!
    expect(ws.features.find((f) => f.properties._editId === 'e1')!.geometry).toEqual(newG1)
    expect(ws.features.find((f) => f.properties._editId === 'e2')!.geometry).toEqual(newG2)
    expect(ws.dirty).toBe(true)
    // 只压一条变更前快照
    expect(ws.history).toHaveLength(1)
    expect(ws.changedIds).toMatchObject({ e1: true, e2: true })

    // 一次 Ctrl+Z 同时回退两个要素
    useLayerEditStore.getState().undo('L1')
    const restored = useLayerEditStore.getState().getWorkspace('L1')!
    expect(restored.features.find((f) => f.properties._editId === 'e1')!.geometry)
      .toEqual({ type: 'LineString', coordinates: [[0, 0], [0, 1]] })
    expect(restored.features.find((f) => f.properties._editId === 'e2')!.geometry)
      .toEqual({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })
  })

  it('setEditableLayerId(null) 关闭合并模式但保留节点捕获', () => {
    const s = useLayerEditStore.getState()
    s.beginEdit('L1', 'D1', 'line', [])
    s.setSnapEnabled(true)
    s.setNodeMergeMode(true)
    s.setEditableLayerId(null)
    const st = useLayerEditStore.getState()
    expect(st.nodeMergeMode).toBe(false)
    expect(st.snapEnabled).toBe(true)
  })
})
