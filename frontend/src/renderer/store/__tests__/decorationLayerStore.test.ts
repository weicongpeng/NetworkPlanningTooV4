/**
 * 装饰图层：工作集播种（seedWorkspace）与本地持久化（mapStore.decorationFeatures）。
 *
 * 关注点：
 * - seedWorkspace 只写工作集，不打开编辑开关（editableLayerId 不变）、不置脏、无撤销历史
 * - 已有工作集不被播种覆盖（未保存更改不丢）
 * - mapStore.decorationFeatures 默认空、可写可清
 * - rehydrate 合并旧持久化数据时，装饰要素缺省为空（不沿用上一用户的内存数据）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useLayerEditStore } from '../layerEditStore'
import { useMapStore } from '../mapStore'

const feature = (id: string, name: string) => ({
  type: 'Feature' as const,
  properties: { name, _editId: id },
  geometry: { type: 'Point', coordinates: [114, 23] },
})

describe('layerEditStore.seedWorkspace', () => {
  beforeEach(() => {
    useLayerEditStore.setState({ editableLayerId: null, workspaces: {}, clipboard: [] })
  })

  it('只写工作集，不打开编辑开关、不置脏、无历史', () => {
    useLayerEditStore.getState().seedWorkspace('decoration-layer', '__decoration__', 'mixed', [
      feature('e0', '标注1'),
      feature('e1', '标注2'),
    ])
    const s = useLayerEditStore.getState()
    expect(s.editableLayerId).toBeNull()
    const ws = s.getWorkspace('decoration-layer')!
    expect(ws.dataId).toBe('__decoration__')
    expect(ws.geometryType).toBe('mixed')
    expect(ws.features).toHaveLength(2)
    expect(ws.dirty).toBe(false)
    expect(ws.changeCount).toBe(0)
    expect(ws.history).toEqual([])
    expect(ws.version).toBeNull()
    expect(ws.baseRows).toEqual({ e0: 0, e1: 1 })
    expect(ws.baseCount).toBe(2)
  })

  it('已有工作集不被播种覆盖（未保存更改保留）', () => {
    useLayerEditStore.getState().seedWorkspace('decoration-layer', '__decoration__', 'mixed', [feature('e0', '旧')])
    useLayerEditStore.getState().addFeature('decoration-layer', { type: 'Point', coordinates: [115, 24] }, { name: '新' })
    // 再次播种（模拟重新打开编辑开关/页面恢复）
    useLayerEditStore.getState().seedWorkspace('decoration-layer', '__decoration__', 'mixed', [feature('e9', '持久化')])
    const ws = useLayerEditStore.getState().getWorkspace('decoration-layer')!
    expect(ws.features).toHaveLength(2)
    expect(ws.features.map(f => f.properties.name)).toEqual(['旧', '新'])
  })

  it('播种要素补齐 _editId（缺省时自动生成）', () => {
    useLayerEditStore.getState().seedWorkspace('decoration-layer', '__decoration__', 'mixed', [
      { type: 'Feature', properties: { name: '无ID' }, geometry: { type: 'Point', coordinates: [114, 23] } },
    ])
    const ws = useLayerEditStore.getState().getWorkspace('decoration-layer')!
    expect(ws.features[0].properties._editId).toBeTruthy()
  })
})

describe('mapStore.decorationFeatures', () => {
  beforeEach(() => {
    useMapStore.setState({ decorationFeatures: [] })
  })

  it('默认空数组，可写入与清空', () => {
    expect(useMapStore.getState().decorationFeatures).toEqual([])
    useMapStore.getState().setDecorationFeatures([feature('e0', 'A')])
    expect(useMapStore.getState().decorationFeatures).toHaveLength(1)
    useMapStore.getState().clearDecorationFeatures()
    expect(useMapStore.getState().decorationFeatures).toEqual([])
  })

  it('rehydrate 旧持久化数据（无 decorationFeatures 键）时不沿用内存中的旧要素', async () => {
    // 先写内存旧数据（此时仍写向默认 key），再切 key 并写入不含 decorationFeatures 的旧格式数据，
    // 否则 setState 的自动持久化会把旧要素写进目标 key，rehydrate 读到的就是"新"数据了
    useMapStore.setState({ decorationFeatures: [feature('stale', '上一用户')] })
    const key = 'map-settings-test-decoration'
    localStorage.setItem(key, JSON.stringify({ state: { mapSettings: { mapType: 'roadmap' } } }))
    useMapStore.persist.setOptions({ name: key })

    await useMapStore.persist.rehydrate()

    expect(useMapStore.getState().decorationFeatures).toEqual([])
  })
})
