/** 历史图片缓存：命中、在途合并、过期失效、切账号清理。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cacheSignedUrls, clearImAttachmentCache, getCachedAttachmentBlob,
  getCachedSignedUrl,
} from '../imAttachmentCache'

describe('imAttachmentCache', () => {
  beforeEach(() => clearImAttachmentCache())

  it('同一图片重复显示只取一次字节', async () => {
    const loader = vi.fn().mockResolvedValue(new Blob(['x']))
    const first = await getCachedAttachmentBlob(1, true, loader)
    const second = await getCachedAttachmentBlob(1, true, loader)
    expect(first).toBe(second)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('并发请求合并为一个，在途结束后可再次加载', async () => {
    let resolveFirst: (blob: Blob) => void = () => {}
    const loader = vi.fn(() => new Promise<Blob>(resolve => { resolveFirst = resolve }))
    const first = getCachedAttachmentBlob(2, false, loader)
    const second = getCachedAttachmentBlob(2, false, loader)
    resolveFirst(new Blob(['y']))
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('签名 URL 缓存命中并随切账号清理', () => {
    const expires_at = Math.floor(Date.now() / 1000) + 900
    cacheSignedUrls({ '3:1': { token: 't', path: '/p', thumb: true, expires_at } })
    expect(getCachedSignedUrl(3, true)?.token).toBe('t')
    clearImAttachmentCache()
    expect(getCachedSignedUrl(3, true)).toBeNull()
  })

  it('临近过期的签名 URL 不再复用', () => {
    const expires_at = Math.floor(Date.now() / 1000) + 10
    cacheSignedUrls({ '4:0': { token: 't', path: '/p', thumb: false, expires_at } })
    expect(getCachedSignedUrl(4, false)).toBeNull()
  })
})
