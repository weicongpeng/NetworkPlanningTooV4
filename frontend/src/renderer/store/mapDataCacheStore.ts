import { create } from 'zustand'
import { DATA_REFRESH_EVENT } from './dataStore'

/**
 * 地图数据缓存 Store
 * 目的：页面切换时保持已加载的扇区/图层/地理数据，避免重复渲染和请求
 */

interface SectorCacheEntry {
  workbookId: string
  data: any[]
  loadedAt: number
  dirty: boolean
}

interface LayerCacheEntry {
  layerId: string
  bounds: any
  geojson?: any          // 后端已转 GCJ02 的 GeoJSON，缓存避免重新拉取/重建
  loadedAt: number
  /** 该 GeoJSON 对应的图层版本指纹（图层数据端点 ETag），增量保存基底校验用 */
  version?: string | null
}

interface GeoDataCacheEntry {
  dataId: string
  data: any
  loadedAt: number
}

// 最多缓存的 workbook 数（LRU淘汰）
const MAX_CACHED_WORKBOOKS = 5

interface MapDataCacheState {
  // 扇区缓存：key 为 workbookId
  sectors: Record<string, SectorCacheEntry>

  // 图层缓存：key 为 layerId
  layers: Record<string, LayerCacheEntry>

  // 地理化数据缓存：key 为 dataId
  geoData: Record<string, GeoDataCacheEntry>

  // 操作
  cacheSectors: (workbookId: string, data: any[]) => void
  getCachedSectors: (workbookId: string) => any[] | null
  cacheLayer: (layerId: string, bounds: any) => void
  cacheLayerGeoJSON: (layerId: string, geojson: any, version?: string | null) => void
  cacheGeoData: (dataId: string, data: any) => void

  // 标记脏数据（工参更新后调用）
  markSectorsDirty: (workbookIds?: string[]) => void
  markAllDirty: () => void
  /** 丢弃单个图层的缓存（保存后源文件已变，缓存 GeoJSON 立即失效） */
  invalidateLayer: (layerId: string) => void

  // 清除缓存
  clearAll: () => void
  clearSectors: () => void
  clearLayers: () => void
  clearGeoData: () => void
}

export const useMapDataCacheStore = create<MapDataCacheState>()((set, get) => ({
  sectors: {},
  layers: {},
  geoData: {},

  cacheSectors: (workbookId, data) => {
    set(state => {
      const entries = Object.entries(state.sectors)
      // LRU 淘汰：超过最大缓存数时删除最旧的
      if (entries.length >= MAX_CACHED_WORKBOOKS && !state.sectors[workbookId]) {
        const sorted = entries.sort(([, a], [, b]) => a.loadedAt - b.loadedAt)
        const toRemove = sorted[0][0]
        const { [toRemove]: _, ...rest } = state.sectors
        return {
          sectors: {
            ...rest,
            [workbookId]: { workbookId, data, loadedAt: Date.now(), dirty: false }
          }
        }
      }
      return {
        sectors: {
          ...state.sectors,
          [workbookId]: { workbookId, data, loadedAt: Date.now(), dirty: false }
        }
      }
    })
  },

  getCachedSectors: (workbookId) => {
    const cached = get().sectors[workbookId]
    // 持久化缓存：只有明确标记为脏时才失效，不依赖时间TTL
    if (cached && !cached.dirty) {
      return cached.data
    }
    return null
  },

  cacheLayer: (layerId, bounds) => {
    set(state => ({
      layers: {
        ...state.layers,
        [layerId]: { layerId, bounds, loadedAt: Date.now() }
      }
    }))
  },

  cacheLayerGeoJSON: (layerId, geojson, version) => {
    set(state => {
      const existing = state.layers[layerId]
      return {
        layers: {
          ...state.layers,
          [layerId]: {
            layerId,
            bounds: existing?.bounds ?? null,
            geojson,
            // 未显式传入版本时清空：避免"新 GeoJSON 配旧指纹"导致增量保存按错行写入
            version: version ?? null,
            loadedAt: Date.now()
          }
        }
      }
    })
  },

  cacheGeoData: (dataId, data) => {
    set(state => ({
      geoData: {
        ...state.geoData,
        [dataId]: { dataId, data, loadedAt: Date.now() }
      }
    }))
  },

  markSectorsDirty: (workbookIds) => {
    set(state => {
      const updated = { ...state.sectors }
      if (workbookIds && workbookIds.length > 0) {
        for (const id of workbookIds) {
          if (updated[id]) updated[id] = { ...updated[id], dirty: true }
        }
      } else {
        for (const key of Object.keys(updated)) {
          updated[key] = { ...updated[key], dirty: true }
        }
      }
      return { sectors: updated }
    })
  },

  markAllDirty: () => {
    set(state => {
      const sectors = { ...state.sectors }
      for (const key of Object.keys(sectors)) {
        sectors[key] = { ...sectors[key], dirty: true }
      }
      // 图层缓存的 GeoJSON 必须一并丢弃：远端（同组其他端）改写源文件后它已失效，
      // 只置 loadedAt=0 没用 —— 渲染器/导出/搜索都直接读 geojson 字段（不检查 loadedAt），
      // 保留旧值会让地图一直显示旧图层（"编辑后其他用户不刷新"的根因）。
      // bounds 保留（几何范围不变，图层定位/编辑会话仍可用）。
      const layers = { ...state.layers }
      for (const key of Object.keys(layers)) {
        layers[key] = { ...layers[key], geojson: undefined, version: null, loadedAt: 0 }
      }
      const geoData = { ...state.geoData }
      for (const key of Object.keys(geoData)) {
        geoData[key] = { ...geoData[key], loadedAt: 0 }
      }
      return { sectors, layers, geoData }
    })
  },

  invalidateLayer: (layerId) => {
    set(state => {
      if (!state.layers[layerId]) return state
      const layers = { ...state.layers }
      delete layers[layerId]
      return { layers }
    })
  },

  clearAll: () => set({ sectors: {}, layers: {}, geoData: {} }),
  clearSectors: () => set({ sectors: {} }),
  clearLayers: () => set({ layers: {} }),
  clearGeoData: () => set({ geoData: {} }),
}))

// 监听数据刷新事件，自动标记所有缓存为脏
// layer 范围（图层保存）：数据条目未变，仅由保存流程精确失效对应图层，不做全量失效
if (typeof window !== 'undefined') {
  window.addEventListener(DATA_REFRESH_EVENT, (e: Event) => {
    const scope = (e as CustomEvent)?.detail?.scope
    if (scope === 'layer') return
    useMapDataCacheStore.getState().markAllDirty()
  })
}
