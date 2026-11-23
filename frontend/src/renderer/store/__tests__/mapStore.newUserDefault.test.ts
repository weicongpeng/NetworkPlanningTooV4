/**
 * 新注册用户的默认底图（回归锁定，2026-10-14 用户要求）。
 *
 * 需求：默认地图源 = 天地图矢量图（tdt-vector），新用户（本地与服务端都没有自己的设置时）
 * 必须落到默认值，不能继承同一浏览器里上一账号 / 匿名会话遗留的设置。
 *
 * 背景：reloadUserMapSettings() 的三段式（本地 rehydrate → 服务端拉取 → 兜底默认）里，
 * 兜底条件依赖 readPersistedMapSettings(key)，任何"提前把上一用户设置写进新用户 key"的
 * 改动都会让新用户继承旧设置（表现为"刚注册的用户默认还是高德矢量图"）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/api', () => ({
  userSettingsApi: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  },
}))

// 装饰要素走 IndexedDB（jsdom 无实现），与本用例无关
vi.mock('../../services/decorationStorage', () => ({
  loadDecorations: vi.fn(async () => []),
  saveDecorations: vi.fn(async () => {}),
}))

const USER1_KEY = 'map-settings-user-1'

/** 写入 auth-storage（mapStore 的 getStorageKey 从这里解析当前用户） */
function setLoggedInUser(id: number, username: string) {
  localStorage.setItem('auth-storage', JSON.stringify({
    state: { user: { id, username } },
    version: 0,
  }))
}

/** 上一账号（user 1）遗留的地图设置：老默认「高德矢量图」 */
const LEGACY_USER1_SETTINGS = {
  mapSource: 'amap-vector',
  layerVisibility: { lte: true, nr: true },
  colorSettingsMap: {},
  labelSettingsMap: {},
}

describe('新用户默认底图', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('新用户（本地与服务端均无设置）→ 默认天地图矢量图，不继承上一账号的高德设置', async () => {
    // 同一浏览器：user 1 用过地图（本地落了一份 amap-vector 快照），随后注册 user 2
    setLoggedInUser(1, 'admin')
    localStorage.setItem(USER1_KEY, JSON.stringify({
      state: { mapSettings: LEGACY_USER1_SETTINGS },
      version: 0,
    }))

    const { userSettingsApi } = await import('../../services/api')
    vi.mocked(userSettingsApi.getSettings).mockResolvedValue({
      success: true,
      data: { user_id: 2, settings: {}, updated_at: null },
    } as any)

    const { useMapStore, reloadUserMapSettings } = await import('../mapStore')
    // 模块加载时按 user 1 的 auth 水合（内存里已经是高德）
    expect(useMapStore.getState().mapSettings.mapSource).toBe('amap-vector')

    // 注册 / 登录 user 2（本地无 user 2 快照，服务端也没有设置）
    setLoggedInUser(2, 'newbie')
    await reloadUserMapSettings()

    expect(useMapStore.getState().mapSettings.mapSource).toBe('tdt-vector')
  })

  it('新用户的服务端设置非空时：以服务端为准（不被本地默认覆盖）', async () => {
    setLoggedInUser(1, 'admin')
    localStorage.setItem(USER1_KEY, JSON.stringify({
      state: { mapSettings: LEGACY_USER1_SETTINGS },
      version: 0,
    }))

    const { userSettingsApi } = await import('../../services/api')
    vi.mocked(userSettingsApi.getSettings).mockResolvedValue({
      success: true,
      data: {
        user_id: 2,
        settings: { mapSource: 'amap-satellite' },
        updated_at: '2026-10-14T00:00:00Z',
      },
    } as any)

    const { useMapStore, reloadUserMapSettings } = await import('../mapStore')
    setLoggedInUser(2, 'newbie')
    await reloadUserMapSettings()

    expect(useMapStore.getState().mapSettings.mapSource).toBe('amap-satellite')
  })
})
