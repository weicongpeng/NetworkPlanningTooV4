import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recoverable } from '../pageLoaders'

const RELOAD_KEY = 'chunk_reload_attempted'

describe('recoverable chunk 懒加载恢复', () => {
  const reload = vi.fn()

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    sessionStorage.clear()
    vi.stubGlobal('location', { ...window.location, reload })
  })

  it('加载成功时返回模块并清除刷新标记', async () => {
    sessionStorage.setItem(RELOAD_KEY, '1')
    const mod = { default: vi.fn() }
    const result = await recoverable(() => Promise.resolve(mod))()
    expect(result).toBe(mod)
    expect(sessionStorage.getItem(RELOAD_KEY)).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  it('首次加载失败时写入标记并自动刷新，Promise 挂起不抛错', async () => {
    const factory = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'))
    const promise = recoverable(factory)()
    await new Promise((r) => setTimeout(r, 0))

    expect(sessionStorage.getItem(RELOAD_KEY)).toBe('1')
    expect(reload).toHaveBeenCalledTimes(1)

    // 刷新期间返回的 Promise 不 settle，Suspense 不会渲染错误
    const settled = vi.fn()
    promise.then(settled, settled)
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).not.toHaveBeenCalled()
  })

  it('刷新后仍失败时抛错且不再刷新（防死循环）', async () => {
    sessionStorage.setItem(RELOAD_KEY, '1')
    const error = new TypeError('Failed to fetch dynamically imported module')
    await expect(recoverable(() => Promise.reject(error))()).rejects.toThrow(error)
    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(RELOAD_KEY)).toBeNull()
  })

  it('sessionStorage 不可用时直接抛错，不触发刷新', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const error = new Error('open failed')
    await expect(recoverable(() => Promise.reject(error))()).rejects.toThrow(error)
    expect(reload).not.toHaveBeenCalled()
  })
})
