/**
 * 桌面端同组同步落地后地图扇区不渲染的回归。
 *
 * 复现路径：后台同步落地前 /map/data 返回空 → 空结果被写进 1 小时内存缓存；
 * 同步落地时地图页未挂载，收不到 DATA_REFRESH_EVENT 的 refreshData()，
 * triggerDataRefresh 原先又只清 getCellList 缓存 → 首次进地图命中空缓存，扇区不渲染
 * （数据管理页读 index.json 却已显示全量工参文件）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  mapApi: {
    getData: vi.fn(),
    getCells: vi.fn(),
    clearCache: vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('../indexedDBService', () => ({
  indexedDBService: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}))

import { mapDataService, invalidateMapDataCaches } from '../mapDataService'
import { mapApi } from '../api'
import { indexedDBService } from '../indexedDBService'

describe('同组同步落地后的地图扇区缓存', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mapDataService.clearAllInMemory()
    vi.mocked(indexedDBService.get).mockResolvedValue(null as never)
    vi.mocked(mapApi.getData).mockResolvedValue({ data: { sites: [] } } as never)
    sessionStorage.clear()
  })

  it('同步前取到的空扇区不写进内存缓存：下一次仍回源', async () => {
    await mapDataService.getMapData()
    await mapDataService.getMapData()
    expect(mapApi.getData).toHaveBeenCalledTimes(2)
  })

  it('invalidateMapDataCaches 清 IndexedDB 缓存并递增数据版本号', () => {
    const before = Number(sessionStorage.getItem('map_data_version') || 0)
    invalidateMapDataCaches()
    // 当前用户键 + 旧版兼容键都要删，否则重启后仍可能命中持久化的旧扇区
    expect(indexedDBService.delete).toHaveBeenCalledTimes(2)
    expect(Number(sessionStorage.getItem('map_data_version') || 0)).toBeGreaterThan(before)
  })
})
