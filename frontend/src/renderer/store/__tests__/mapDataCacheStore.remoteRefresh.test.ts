import { beforeEach, describe, expect, it } from 'vitest'

import { DATA_REFRESH_EVENT } from '../dataStore'
import { useMapDataCacheStore } from '../mapDataCacheStore'

const GEOJSON = { type: 'FeatureCollection', features: [] }

describe('mapDataCacheStore 同组数据变更刷新', () => {
  beforeEach(() => {
    useMapDataCacheStore.getState().clearAll()
  })

  it('markAllDirty 丢弃图层 GeoJSON（远端编辑后必须重新拉取）', () => {
    useMapDataCacheStore.getState().cacheLayerGeoJSON('layer-1', GEOJSON, '"v1"')
    expect(useMapDataCacheStore.getState().layers['layer-1'].geojson).toBe(GEOJSON)

    useMapDataCacheStore.getState().markAllDirty()

    const cached = useMapDataCacheStore.getState().layers['layer-1']
    expect(cached.geojson).toBeUndefined()
    expect(cached.version).toBeNull()
  })

  it('DATA_REFRESH_EVENT(full) 自动标脏；scope=layer 保留本机保存后的精确缓存', () => {
    useMapDataCacheStore.getState().cacheLayerGeoJSON('layer-1', GEOJSON, '"v1"')

    // 本机保存：仅由保存链路精确失效目标图层，不做全量失效
    window.dispatchEvent(new CustomEvent(DATA_REFRESH_EVENT, { detail: { scope: 'layer' } }))
    expect(useMapDataCacheStore.getState().layers['layer-1'].geojson).toBe(GEOJSON)

    // 同组其他端变更：全量失效，地图重建时回源
    window.dispatchEvent(new CustomEvent(DATA_REFRESH_EVENT, { detail: { scope: 'full' } }))
    expect(useMapDataCacheStore.getState().layers['layer-1'].geojson).toBeUndefined()
  })
})
