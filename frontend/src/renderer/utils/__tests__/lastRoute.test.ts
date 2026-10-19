import { describe, it, expect, beforeEach } from 'vitest'
import { saveLastRoute, getLastRoute } from '../lastRoute'

describe('lastRoute（重新登录后恢复页面）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('按用户名隔离记录与读取', () => {
    saveLastRoute('alice', '/map')
    saveLastRoute('bob', '/pci')
    expect(getLastRoute('alice')).toBe('/map')
    expect(getLastRoute('bob')).toBe('/pci')
  })

  it('首页与许可证页不恢复（返回 null）', () => {
    saveLastRoute('alice', '/')
    expect(getLastRoute('alice')).toBeNull()

    saveLastRoute('alice', '/license')
    expect(getLastRoute('alice')).toBeNull()
  })

  it('未提供用户名或路径非法时不记录', () => {
    expect(getLastRoute(null)).toBeNull()
    expect(getLastRoute(undefined)).toBeNull()
    expect(getLastRoute('')).toBeNull()

    saveLastRoute('alice', 'http://example.com')
    expect(getLastRoute('alice')).toBeNull()

    saveLastRoute('', '/map')
    expect(getLastRoute('')).toBeNull()
  })
})
