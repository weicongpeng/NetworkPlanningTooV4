/**
 * 小区列表内存缓存的按用户隔离测试
 *
 * 回归：切换（地市+运营商）账号后，新用户在数据管理无数据时，
 * PCI/邻区/TAC 页面的"小区选择"列表曾命中上一用户的内存缓存而显示别组小区。
 */
import { vi, beforeEach, it, expect } from 'vitest'

const { getCellsMock, indexedGet } = vi.hoisted(() => ({
  getCellsMock: vi.fn(),
  indexedGet: vi.fn().mockResolvedValue(null),
}))

vi.mock('../api', () => ({
  mapApi: {
    getCells: getCellsMock,
    getData: vi.fn(),
    clearCache: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../indexedDBService', () => ({
  indexedDBService: {
    get: indexedGet,
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}))

import { getCellList, clearCellListCache, clearAllInMemoryMapCaches } from '../mapDataService'

function setLoginUserId(id: number | null) {
  if (id == null) {
    localStorage.removeItem('auth-storage')
  } else {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id } } }))
  }
}

const groupAData = { lte: [{ id: 'a-cell', name: 'A组小区', siteId: 'a-site', networkType: 'LTE' }], nr: [], cacheVersion: 4 }
const groupBEmpty = { lte: [], nr: [], cacheVersion: 4 }

describe('getCellList 按登录用户隔离', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearAllInMemoryMapCaches()
  })

  it('用户A获取后切换到用户B，B不应读到A的内存缓存（B组无数据时为空）', async () => {
    setLoginUserId(1)
    getCellsMock.mockResolvedValueOnce({ success: true, data: groupAData })

    const first = await getCellList()
    expect(first.lte).toHaveLength(1)
    expect(getCellsMock).toHaveBeenCalledTimes(1)

    // 切换账号（新用户、新组，后端无数据）
    setLoginUserId(2)
    getCellsMock.mockResolvedValueOnce({ success: true, data: groupBEmpty })

    const second = await getCellList()
    expect(second.lte).toHaveLength(0)
    expect(getCellsMock).toHaveBeenCalledTimes(2)

    // 切回用户A：A仍命中自己的缓存，不再请求
    setLoginUserId(1)
    const again = await getCellList()
    expect(again.lte).toHaveLength(1)
    expect(getCellsMock).toHaveBeenCalledTimes(2)
  })

  it('clearCellListCache 只清当前登录用户的缓存', async () => {
    setLoginUserId(1)
    getCellsMock.mockResolvedValue({ success: true, data: groupAData })
    await getCellList()

    setLoginUserId(2)
    await clearCellListCache()
    expect(getCellsMock).toHaveBeenCalledTimes(1)

    // A 的缓存仍在
    setLoginUserId(1)
    await getCellList()
    expect(getCellsMock).toHaveBeenCalledTimes(1)
  })
})

/**
 * 回归：桌面端「小区选择」列表空白。
 * 桌面端是"先启动应用 → 登录后后台同步 → 用户打开规划页"，很容易在同步落地前
 * 就把空列表取到；空结果一旦写进缓存（内存 + IndexedDB，24h），同步完成后仍是空的。
 */
describe('getCellList 空结果不入缓存', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearAllInMemoryMapCaches()
  })

  it('服务端返回空列表时不写缓存，下次仍会重新请求', async () => {
    setLoginUserId(1)
    getCellsMock.mockResolvedValue({ success: true, data: { lte: [], nr: [] } })

    const first = await getCellList()
    expect(first.lte).toHaveLength(0)
    expect(first.nr).toHaveLength(0)

    const second = await getCellList()
    expect(second.lte).toHaveLength(0)
    // 第二次仍打后端 = 没有被"空结果"缓存住
    expect(getCellsMock).toHaveBeenCalledTimes(2)
  })

  it('空结果之后服务端有数据时能正常取到（同步落地场景）', async () => {
    setLoginUserId(1)
    getCellsMock.mockResolvedValueOnce({ success: true, data: { lte: [], nr: [] } })
    await getCellList()

    getCellsMock.mockResolvedValueOnce({ success: true, data: groupAData })
    const afterSync = await getCellList()
    expect(afterSync.lte).toHaveLength(1)
  })
})
