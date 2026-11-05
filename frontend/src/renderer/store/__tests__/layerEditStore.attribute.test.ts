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

describe('layerEditStore.addFeature 字段继承（手绘/粘贴要素与既有要素字段一致）', () => {
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

  const baseFeature = (editId: string, props: Record<string, any> = {}) => ({
    type: 'Feature' as const,
    properties: { _editId: editId, ...props },
    geometry: { type: 'Point', coordinates: [0, 0] },
  })

  it('手绘新要素继承图层既有字段（null 占位），仍标记 _isNew', () => {
    const store = useLayerEditStore.getState()
    store.beginEdit('L1', 'D1', 'point', [baseFeature('e1', { 名称: '贝岭镇', 编码: '7150' })])

    useLayerEditStore.getState().addFeature('L1', { type: 'Point', coordinates: [1, 2] })
    const drawn = useLayerEditStore.getState().getWorkspace('L1')!.features[1]
    // 面板据此显示既有字段（可直接填值），不再"暂无属性信息"
    expect(drawn.properties.名称).toBeNull()
    expect(drawn.properties.编码).toBeNull()
    expect(drawn.properties._isNew).toBe(true)
    // 既有要素不受影响
    expect(useLayerEditStore.getState().getWorkspace('L1')!.features[0].properties.名称).toBe('贝岭镇')
  })

  it('传入属性优先于继承：粘贴要素保留自带值，目标图层独有字段补 null', () => {
    const store = useLayerEditStore.getState()
    store.beginEdit('L1', 'D1', 'point', [baseFeature('e1', { 名称: 'A', 备注: 'x' })])

    useLayerEditStore.getState().addFeature('L1', { type: 'Point', coordinates: [3, 4] },
      { 名称: '粘贴值', _keepStyle: true })
    const pasted = useLayerEditStore.getState().getWorkspace('L1')!.features[1]
    expect(pasted.properties.名称).toBe('粘贴值')
    expect(pasted.properties.备注).toBeNull()
    // 粘贴保留原配色：不标 _isNew，也不落 _keepStyle 内部标记
    expect('_isNew' in pasted.properties).toBe(false)
    expect('_keepStyle' in pasted.properties).toBe(false)
  })

  it('内部字段与样式保留键不参与继承', () => {
    const store = useLayerEditStore.getState()
    store.beginEdit('L1', 'D1', 'point', [
      baseFeature('e1', { 名称: 'A', fillColor: '#f00', NPT_FEATSYM: '{}' }),
    ])

    useLayerEditStore.getState().addFeature('L1', { type: 'Point', coordinates: [5, 6] })
    const drawn = useLayerEditStore.getState().getWorkspace('L1')!.features[1]
    expect(drawn.properties.名称).toBeNull()
    expect('fillColor' in drawn.properties).toBe(false)
    expect('NPT_FEATSYM' in drawn.properties).toBe(false)
  })

  it('回归：先绘制再添加字段，后续绘制的新要素同样带该字段（存在性校验与面板一致）', () => {
    const store = useLayerEditStore.getState()
    store.beginEdit('L1', 'D1', 'point', [baseFeature('e1', { 名称: 'A' })])

    // 第一个手绘要素：面板无字段 → 用"添加属性"新增字段
    useLayerEditStore.getState().addFeature('L1', { type: 'Point', coordinates: [1, 1] })
    const first = useLayerEditStore.getState().getWorkspace('L1')!.features[1].properties._editId as string
    expect(useLayerEditStore.getState().addFeatureAttribute('L1', first, '等级', 'A')).toBeNull()

    // 第二个手绘要素：继承图层既有字段（含新增的"等级"），不会"看不到字段却提示已存在"
    useLayerEditStore.getState().addFeature('L1', { type: 'Point', coordinates: [2, 2] })
    const drawnFeatures = useLayerEditStore.getState().getWorkspace('L1')!.features.slice(1)
    for (const f of drawnFeatures) {
      expect('等级' in f.properties).toBe(true)
      expect('名称' in f.properties).toBe(true)
    }
    // 既有字段名仍按图层口径拒绝（提示改为"请直接在属性列表填值"）
    const second = drawnFeatures[1].properties._editId as string
    expect(useLayerEditStore.getState().addFeatureAttribute('L1', second, '等级', 'B')).toBe('exists')
    expect(useLayerEditStore.getState().addFeatureAttribute('L1', second, '新字段', 'v')).toBeNull()
  })
})
