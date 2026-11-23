import { beforeEach, describe, expect, it } from 'vitest'
import { userCacheSuffix } from '../cacheKey'

describe('userCacheSuffix 缓存隔离后缀', () => {
  beforeEach(() => localStorage.clear())

  it('未登录或无存储时返回匿名后缀', () => {
    expect(userCacheSuffix()).toBe('_anon')
    localStorage.setItem('auth-storage', 'not-json')
    expect(userCacheSuffix()).toBe('_anon')
  })

  it('网页端（无运行模式）后缀只含用户 id，保持历史键不变', () => {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: { id: 7 } } }))
    expect(userCacheSuffix()).toBe('_u7')
  })

  it('桌面端同一账号共享/单机两档后缀不同，互不串缓存', () => {
    localStorage.setItem(
      'auth-storage',
      JSON.stringify({ state: { user: { id: 1 }, desktopRunMode: 'shared' } }),
    )
    expect(userCacheSuffix()).toBe('_u1_dshared')

    localStorage.setItem(
      'auth-storage',
      JSON.stringify({ state: { user: { id: 1 }, desktopRunMode: 'standalone' } }),
    )
    expect(userCacheSuffix()).toBe('_u1_dstandalone')
  })

  it('切档重启后登录前（无 user）返回匿名后缀，不命中任一档缓存', () => {
    localStorage.setItem(
      'auth-storage',
      JSON.stringify({ state: { user: null, desktopRunMode: 'standalone' } }),
    )
    expect(userCacheSuffix()).toBe('_anon')
  })
})
