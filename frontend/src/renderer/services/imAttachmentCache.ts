/**
 * 历史消息附件的内存缓存：签名 URL（短时）+ Blob（有界 LRU）+ 在途请求去重。
 *
 * 共享桌面模式下每张图片原先都要走一次 relay JSON；这里让同一张图片在一次会话中
 * 只取一次字节，滚动回滚时直接命中内存；重启后还能命中 IndexedDB 的磁盘副本，
 * 连本机 HTTP 都不发。不缓存 ObjectURL：它由各组件自己创建/释放，
 * 避免跨组件 revoke 导致「第二次打开空白」。
 */
import { clearAllBlobs, readBlob, writeBlob } from './imLocalCache'

export interface ImSignedAttachmentInfo {
  token: string
  path: string
  thumb: boolean
  expires_at: number
  /** 共享桌面模式下由本机后端补成可直接 GET 的绝对地址 */
  url?: string
}

const MAX_BLOBS = 160
/** 单张超过 12MB 的附件不走浏览器 IndexedDB，避免和后端磁盘缓存重复占空间 */
const MAX_DISK_BLOB_BYTES = 12 * 1024 * 1024
const blobs = new Map<string, Blob>()
const signed = new Map<string, ImSignedAttachmentInfo>()
const inFlight = new Map<string, Promise<Blob>>()
/** null=尚未探测；false=当前后端不支持签名直链（老服务器），不再重复尝试 */
let signedUrlsAvailable: boolean | null = null

const keyOf = (id: number, thumb: boolean) => `${id}:${thumb ? 1 : 0}`

function touch<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key)
  map.set(key, value)
}

/** 批量缓存 relay 换来的短时签名 URL；带 url 的条目说明当前后端支持直链 */
export function cacheSignedUrls(tokens: Record<string, ImSignedAttachmentInfo>): void {
  const entries = Object.entries(tokens || {})
  if (!entries.length) return
  let usable = false
  for (const [key, info] of entries) {
    signed.set(key, info)
    if (info.url) usable = true
  }
  if (usable) signedUrlsAvailable = true
  else if (signedUrlsAvailable === null) signedUrlsAvailable = false
}

export function getCachedSignedUrl(id: number, thumb: boolean): ImSignedAttachmentInfo | null {
  const info = signed.get(keyOf(id, thumb))
  if (!info) return null
  // 过期前 30s 不再复用，避免下载到一半 token 失效
  if (info.expires_at * 1000 - 30_000 < Date.now()) {
    signed.delete(keyOf(id, thumb))
    return null
  }
  touch(signed, keyOf(id, thumb), info)
  return info
}

export function signedUrlsUsable(): boolean | null {
  return signedUrlsAvailable
}

export function disableSignedUrls(): void {
  signedUrlsAvailable = false
}

/**
 * 取附件字节：命中缓存直接返回；同一 key 的并发请求合并为一个。
 * loader 由调用方提供（优先签名直链，失败回退本地接口），失败会清掉在途记录以便重试。
 */
export async function getCachedAttachmentBlob(
  id: number,
  thumb: boolean,
  loader: () => Promise<Blob>,
): Promise<Blob> {
  const key = keyOf(id, thumb)
  const cached = blobs.get(key)
  if (cached) {
    touch(blobs, key, cached)
    return cached
  }
  const pending = inFlight.get(key)
  if (pending) return pending

  const task = (async () => {
    // 磁盘副本优先：应用重启 / WebView 刷新后内存为空，但历史图片仍可秒开。
    const disk = await readBlob(key)
    if (disk) {
      touch(blobs, key, disk)
      return disk
    }
    const blob = await loader()
    touch(blobs, key, blob)
    // 大文件交给本机后端的 remote-cache（2GB 配额），浏览器里不再存一份；
    // 签名直链已过期也不影响复用磁盘字节。
    if (blob.size <= MAX_DISK_BLOB_BYTES) void writeBlob(key, blob).catch(() => {})
    while (blobs.size > MAX_BLOBS) {
      const oldest = blobs.keys().next().value as string | undefined
      if (!oldest) break
      blobs.delete(oldest)
    }
    return blob
  })().finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, task)
  return task
}

/** 切账号 / 退出登录：绝不能把上一账号看过的图片带过去 */
export function clearImAttachmentCache(): void {
  blobs.clear()
  signed.clear()
  inFlight.clear()
  signedUrlsAvailable = null
  void clearAllBlobs()
}
