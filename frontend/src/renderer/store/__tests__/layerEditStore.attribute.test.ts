import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerEditStore } from '../layerEditStore'

function mkFeature(editId: string) {
  return {
    type: 'Feature' as const,
    properties: { _editId: editId, name: `n-${editId}` },
    geometry: { type: 'Point', coordinates: [0, 0] },
  }
}

describe('layerEditStore addFeatureAttribute（图层级新增属性字段）', () => {
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

  it('成功：所有要素补齐字段，仅目标要素带值且只标记目标变更，压一条历史', () => {
    const store = useLayerEditStore.getState()
    store.beginEdit('L1', 'D1', 'mixed', [mkFeature('e1'), mkFeature('e2'), mkFeature('e3')])

    const err = useLayerEditStore.getState().addFeatureAttribute('L1', 'e2', '等级', 'A')
    expect(err).toBeNull()

    const ws = useLayerEditStore.getState().getWorkspace('L1')!
    const get = (id: string) => ws.features.find((f) => f.properties._editId === id)!.properties
    expect(get('e1')['等级']).toBeNull()
    expect(get('e2')['等级']).toBe('A')
    expect(get('e3')['等级']).toBeNull()
    // 已有字段不被破坏
    expect(get('e2').name).toBe('n-e2')
    // 仅目标要素标记变更（增量保存只回传它，后端追加列后其余行默认空）
    expect(ws.changedIds).toMatchObject({ e2: true })
    expect(Object.keys(ws.changedIds)).toHaveLength(1)
    expect(ws.dirty).toBe(true)
    expect(ws.history).toHaveLength(1)
  })

  it('字段已存在于图层（任一要素）→ 返回错误且不产生变更', () => {
    const store = useLayerEditStore.getState()
    store.beginEdit('L1', 'D1', 'mixed', [mkFeature('e1'), mkFeature('e2')])

    const err = useLayerEditStore.getState().addFeatureAttribute('L1', 'e1', 'name', 'x')
    expect(err).toBeTruthy()
    const ws = useLayerEditStore.getState().getWorkspace('L1')!
    expect(ws.dirty).toBe(false)
    expect(ws.history).toHaveLength(0)
  })

  it('非法字段名：空串 / 下划线前缀 / 绘制样式保留键 → 返回错误', () => {
    const store = useLayerEditStore.getState()
    store.beginEdit('L1', 'D1', 'mixed', [mkFeature('e1')])

    expect(useLayerEditStore.getState().addFeatureAttribute('L1', 'e1', '  ', 'x')).toBeTruthy()
    expect(useLayerEditStore.getState().addFeatureAttribute('L1', 'e1', '_内部', 'x')).toBeTruthy()
    expect(useLayerEditStore.getState().addFeatureAttribute('L1', 'e1', 'color', 'x')).toBeTruthy()
    expect(useLayerEditStore.getState().addFeatureAttribute('L1', 'e1', 'NPT_FEATSYM', 'x')).toBeTruthy()

    const ws = useLayerEditStore.getState().getWorkspace('L1')!
    expect(ws.dirty).toBe(false)
  })

it('editId 不存在（脏态/竞态）→ 返回 noFeature 且不产生变更', () => {
    const store = useLayerEditStore.getState()
    store.beginEdit('L1', 'D1', 'mixed', [mkFeature('e1')])

    const code = useLayerEditStore.getState().addFeatureAttribute('L1', 'ghost-id', 'f', 'x')
    expect(code).toBe('noFeature')
    const ws = useLayerEditStore.getState().getWorkspace('L1')!
    expect(ws.dirty).toBe(false)
    expect(ws.history).toHaveLength(0)
    expect(ws.changedIds).toEqual({})
  })

  it('非法字段名：数字开头 / 含空格或符号 → 返回 invalidName', () => {
    const store = useLayerEditStore.getState()
    store.beginEdit('L1', 'D1', 'mixed', [mkFeature('e1')])

    expect(useLayerEditStore.getState().addFeatureAttribute('L1', 'e1', '1abc', 'x')).toBe('invalidName')
    expect(useLayerEditStore.getState().addFeatureAttribute('L1', 'e1', 'a b', 'x')).toBe('invalidName')
    expect(useLayerEditStore.getState().addFeatureAttribute('L1', 'e1', '等级%', 'x')).toBe('invalidName')
    // 中文开头合法、中文与数字混合合法
    expect(useLayerEditStore.getState().addFeatureAttribute('L1', 'e1', '等级1', 'x')).toBeNull()

    const ws = useLayerEditStore.getState().getWorkspace('L1')!
    // 前三次失败不入历史
    expect(ws.history).toHaveLength(1)
  })

  it('一次撤销回退：全部要素上的新增字段被移除', () => {
    const store = useLayerEditStore.getState()
    store.beginEdit('L1', 'D1', 'mixed', [mkFeature('e1'), mkFeature('e2')])
    useLayerEditStore.getState().addFeatureAttribute('L1', 'e1', 'remark', 'hello')

    useLayerEditStore.getState().undo('L1')
    const ws = useLayerEditStore.getState().getWorkspace('L1')!
    for (const f of ws.features) {
      expect('remark' in f.properties).toBe(false)
    }
    expect(ws.dirty).toBe(false)
  })
})
