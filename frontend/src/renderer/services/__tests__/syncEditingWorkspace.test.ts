/**
 * 编辑态图层与服务器同步（共享模式 last-write-wins）。
 *
 * 回归：打开「编辑」开关后图层被隐藏，常规刷新只重建可见图层，编辑工作集
 * （编辑会话渲染的快照）得不到更新——同组其他用户保存后，编辑态下地图
 * 不变化，关闭编辑开关后才同步。
 */
import { vi, beforeEach, describe, it, expect } from 'vitest'

const { getLayerDataMock } = vi.hoisted(() => ({
  getLayerDataMock: vi.fn(),
}))

vi.mock('../api', () => ({
  layerApi: {
    getLayerDataWithVersion: getLayerDataMock,
  },
}))

import { syncEditingWorkspaceFromServer } from '../syncEditingWorkspace'
import { DECORATION_LAYER_ID, useLayerEditStore } from '../../store/layerEditStore'
import { useMapDataCacheStore } from '../../store/mapDataCacheStore'

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

function serverResponse(etag: string | null, bases: number[]) {
  return { data: { type: 'FeatureCollection', features: bases.map(polyFeature) }, version: etag }
}

describe('syncEditingWorkspaceFromServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLayerEditStore.getState().resetForUserSwitch()
    useMapDataCacheStore.getState().clearAll()
  })

  it('未打开编辑开关时不请求、返回 null', async () => {
    const r = await syncEditingWorkspaceFromServer()
    expect(r).toBeNull()
    expect(getLayerDataMock).not.toHaveBeenCalled()
  })

  it('装饰图层为本机手绘数据，跳过服务器同步', async () => {
    useLayerEditStore.getState().beginEdit(
      DECORATION_LAYER_ID, '__decoration__', 'polygon', [polyFeature(114.7)], { version: null })
    const r = await syncEditingWorkspaceFromServer()
    expect(r).toBeNull()
    expect(getLayerDataMock).not.toHaveBeenCalled()
  })

  it('服务器版本与工作集基底相同（自己保存后的广播回声）：不重置，保留撤销历史', async () => {
    const s = useLayerEditStore.getState()
    s.beginEdit('layer-a', 'data-1', 'polygon', [polyFeature(114.7)], { version: '"v2"' })
    // 本机未保存修改（撤销栈 1 条、2 个要素）
    s.addFeature('layer-a', { type: 'Point', coordinates: [114.9, 23.9] })
    getLayerDataMock.mockResolvedValue(serverResponse('"v2"', [114.7]))

    const r = await syncEditingWorkspaceFromServer()

    expect(r).toEqual({ layerId: 'layer-a', updated: false, hadUnsavedChanges: false })
    const ws = useLayerEditStore.getState().getWorkspace('layer-a')!
    expect(ws.features).toHaveLength(2)          // 未被服务器数据替换
    expect(ws.history).toHaveLength(1)          // 撤销历史保留
    expect(getLayerDataMock).toHaveBeenCalledTimes(1)
  })

  it('服务器版本更新：以服务器数据整体重置（last-write-wins），并报告覆盖了未保存修改', async () => {
    const s = useLayerEditStore.getState()
    s.beginEdit('layer-a', 'data-1', 'polygon', [polyFeature(114.7)], { version: '"v1"' })
    s.addFeature('layer-a', { type: 'Point', coordinates: [114.9, 23.9] })
    getLayerDataMock.mockResolvedValue(serverResponse('"v3"', [114.1, 114.2, 114.3]))

    const r = await syncEditingWorkspaceFromServer()

    expect(r).toEqual({ layerId: 'layer-a', updated: true, hadUnsavedChanges: true })
    const ws = useLayerEditStore.getState().getWorkspace('layer-a')!
    expect(ws.features).toHaveLength(3)
    expect(ws.version).toBe('"v3"')
    expect(ws.dirty).toBe(false)
    expect(ws.history).toEqual([])
    // 图层缓存同步为最新（关闭编辑开关恢复原图层时直接命中）
    const cached = useMapDataCacheStore.getState().layers['layer-a']
    expect(cached.geojson.features).toHaveLength(3)
    expect(cached.version).toBe('"v3"')
  })

  it('版本指纹缺失时无法判同，仍以服务器数据为准更新', async () => {
    const s = useLayerEditStore.getState()
    s.beginEdit('layer-a', 'data-1', 'polygon', [polyFeature(114.7)], { version: null })
    getLayerDataMock.mockResolvedValue(serverResponse(null, [114.5]))

    const r = await syncEditingWorkspaceFromServer()

    expect(r?.updated).toBe(true)
    expect(useLayerEditStore.getState().getWorkspace('layer-a')!.features).toHaveLength(1)
  })

  it('并发调用共享同一次回源请求', async () => {
    useLayerEditStore.getState().beginEdit(
      'layer-a', 'data-1', 'polygon', [polyFeature(114.7)], { version: '"v1"' })
    let resolveReq: (v: unknown) => void = () => {}
    getLayerDataMock.mockImplementation(() => new Promise((res) => { resolveReq = res }))

    const p1 = syncEditingWorkspaceFromServer()
    const p2 = syncEditingWorkspaceFromServer()
    expect(getLayerDataMock).toHaveBeenCalledTimes(1)
    resolveReq(serverResponse('"v9"', [114.7]))
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual(r2)
    expect(r1?.updated).toBe(true)
  })

  it('回源失败时返回 null 且不抛出（网络异常不应打断刷新流程）', async () => {
    useLayerEditStore.getState().beginEdit(
      'layer-a', 'data-1', 'polygon', [polyFeature(114.7)], { version: '"v1"' })
    getLayerDataMock.mockRejectedValue(new Error('network'))
    const r = await syncEditingWorkspaceFromServer()
    expect(r).toBeNull()
    // 失败后下一次调用仍可正常发起（inFlight 已释放）
    getLayerDataMock.mockResolvedValue(serverResponse('"v2"', [114.7]))
    const r2 = await syncEditingWorkspaceFromServer()
    expect(r2?.updated).toBe(true)
  })
})
