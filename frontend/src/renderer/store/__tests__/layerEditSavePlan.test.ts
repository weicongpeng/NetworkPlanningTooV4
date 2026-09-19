/**
 * 增量保存计划（buildSavePlan）与保存后基底重排。
 *
 * 关注点：
 * - 无版本指纹 / 无变更 → 整层保存（保证不丢改动）
 * - 有基底 + 改属性/改几何 → 只回传变更要素（row=基底行号）
 * - 新增要素 row=null；删除要素按基底行号回传 deletes
 * - 保存成功后按当前数组顺序重排基底行号（与服务端写入行序一致）
 * - 服务端要素数不符（remapRows=false）→ 清空基底，下次自动整层保存
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { buildSavePlan, useLayerEditStore } from '../layerEditStore'

const feature = (id: string, name: string, lng = 114) => ({
  type: 'Feature' as const,
  properties: { name, _editId: id },
  geometry: { type: 'Point', coordinates: [lng, 23] },
})

function beginEditWith(features: any[], version: string | null = '"layer-1-100"') {
  const store = useLayerEditStore.getState()
  store.beginEdit('L1', 'D1', 'point', features, null, { version })
  return store
}

describe('buildSavePlan', () => {
  beforeEach(() => {
    useLayerEditStore.setState({ editableLayerId: null, workspaces: {}, clipboard: [] })
  })

  it('无版本指纹时整层保存', () => {
    beginEditWith([feature('e0', 'A'), feature('e1', 'B')], null)
    useLayerEditStore.getState().updateFeatureProperties('L1', 'e0', { name: 'A2' })
    const plan = buildSavePlan(useLayerEditStore.getState().getWorkspace('L1')!)
    expect(plan.mode).toBe('full')
    expect(plan.payload.geojson.features).toHaveLength(2)
  })

  it('改属性只回传该要素（row=基底行号）', () => {
    beginEditWith([feature('e0', 'A'), feature('e1', 'B'), feature('e2', 'C')])
    useLayerEditStore.getState().updateFeatureProperties('L1', 'e1', { name: 'B2' })
    const plan = buildSavePlan(useLayerEditStore.getState().getWorkspace('L1')!)
    expect(plan.mode).toBe('patch')
    expect(plan.payload.patch.base).toEqual({ count: 3, version: '"layer-1-100"' })
    expect(plan.payload.patch.upserts).toHaveLength(1)
    expect(plan.payload.patch.upserts[0].row).toBe(1)
    expect(plan.payload.patch.upserts[0].properties.name).toBe('B2')
    expect(plan.payload.patch.deletes).toEqual([])
  })

  it('改几何同样只回传该要素', () => {
    beginEditWith([feature('e0', 'A'), feature('e1', 'B')])
    useLayerEditStore.getState().updateFeatureGeometry('L1', 'e0', { type: 'Point', coordinates: [115, 24] })
    const plan = buildSavePlan(useLayerEditStore.getState().getWorkspace('L1')!)
    expect(plan.mode).toBe('patch')
    expect(plan.payload.patch.upserts).toHaveLength(1)
    expect(plan.payload.patch.upserts[0].geometry.coordinates).toEqual([115, 24])
  })

  it('新增要素 row=null，删除要素按基底行号', () => {
    beginEditWith([feature('e0', 'A'), feature('e1', 'B'), feature('e2', 'C')])
    const store = useLayerEditStore.getState()
    store.addFeature('L1', { type: 'Point', coordinates: [116, 25] }, { name: 'NEW' })
    store.deleteFeature('L1', 'e1')
    const plan = buildSavePlan(useLayerEditStore.getState().getWorkspace('L1')!)
    expect(plan.mode).toBe('patch')
    expect(plan.payload.patch.deletes).toEqual([1])
    const rows = plan.payload.patch.upserts.map((u: any) => u.row)
    expect(rows).toContain(null)          // 新增
    expect(rows).not.toContain(1)         // 被删除的行不回传 upsert
    expect(plan.payload.patch.upserts).toHaveLength(1)
  })

  it('新增后删除：无有效变更 → 无需写盘（mode=none）', () => {
    beginEditWith([feature('e0', 'A')])
    const store = useLayerEditStore.getState()
    const before = store.getWorkspace('L1')!.features.length
    store.addFeature('L1', { type: 'Point', coordinates: [116, 25] }, { name: 'TMP' })
    const addedId = useLayerEditStore.getState().getWorkspace('L1')!.features.slice(-1)[0].properties._editId
    store.deleteFeature('L1', addedId as string)
    const plan = buildSavePlan(useLayerEditStore.getState().getWorkspace('L1')!)
    expect(useLayerEditStore.getState().getWorkspace('L1')!.features).toHaveLength(before)
    expect(plan.mode).toBe('none')  // 无实际变更（changedIds 里只剩已删除的新增要素）
  })

  it('保存成功后重排基底行号：删除后再保存仍是增量', () => {
    beginEditWith([feature('e0', 'A'), feature('e1', 'B'), feature('e2', 'C')])
    const store = useLayerEditStore.getState()
    store.deleteFeature('L1', 'e1')
    store.markSaved('L1', { remapRows: true, version: '"layer-1-200"' })
    const ws = useLayerEditStore.getState().getWorkspace('L1')!
    expect(ws.baseRows).toEqual({ e0: 0, e2: 1 })   // 行序按当前数组顺序重排
    expect(ws.baseCount).toBe(2)
    expect(ws.version).toBe('"layer-1-200"')
    expect(ws.changedIds).toEqual({})

    useLayerEditStore.getState().updateFeatureProperties('L1', 'e2', { name: 'C2' })
    const plan = buildSavePlan(useLayerEditStore.getState().getWorkspace('L1')!)
    expect(plan.mode).toBe('patch')
    expect(plan.payload.patch.upserts[0].row).toBe(1)  // 重排后的行号
    expect(plan.payload.patch.base.count).toBe(2)
  })

  it('服务端要素数不符（remapRows=false）→ 清空基底，下次整层保存', () => {
    beginEditWith([feature('e0', 'A'), feature('e1', 'B')])
    useLayerEditStore.getState().updateFeatureProperties('L1', 'e0', { name: 'A2' })
    useLayerEditStore.getState().markSaved('L1', { remapRows: false, version: '"v2"' })
    const ws = useLayerEditStore.getState().getWorkspace('L1')!
    expect(ws.baseRows).toEqual({})
    expect(ws.version).toBeNull()

    useLayerEditStore.getState().updateFeatureProperties('L1', 'e1', { name: 'B2' })
    const plan = buildSavePlan(useLayerEditStore.getState().getWorkspace('L1')!)
    expect(plan.mode).toBe('full')
  })

  it('变更数超过上限时整层保存', () => {
    // 直接构造工作集状态（逐条 addFeature 会触发历史快照深拷贝，超大图层下不现实）
    const features = Array.from({ length: 20001 }, (_, i) => feature(`e${i}`, `N${i}`))
    const baseRows: Record<string, number | null> = {}
    const changedIds: Record<string, true> = {}
    features.forEach((f, i) => {
      baseRows[f.properties._editId] = i
      changedIds[f.properties._editId] = true
    })
    useLayerEditStore.setState({
      workspaces: {
        L1: {
          layerId: 'L1', dataId: 'D1', geometryType: 'point', baseStyle: null,
          features, dirty: true, changeCount: features.length, history: [],
          baseRows, changedIds, version: '"layer-1-100"', baseCount: features.length,
        },
      },
    })
    const plan = buildSavePlan(useLayerEditStore.getState().getWorkspace('L1')!)
    expect(plan.mode).toBe('full')
  })
})
