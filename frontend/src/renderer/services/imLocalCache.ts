/**
 * IM 本地优先缓存（IndexedDB）：消息快照 / 会话与通讯录元数据 / 附件字节。
 *
 * 主流桌面 IM（WhatsApp / Telegram / Slack）的共同做法：本地存储是快路径，
 * 服务端只在后台增量同步。这里沿用同一原则——打开会话先渲染磁盘上的历史，
 * 网络刷新不阻塞 UI；图片命中本地副本后连 HTTP 都不发。
 *
 * 服务端仍是数据权威；快照/元数据按 im_user_id 前缀隔离，切账号不清磁盘缓存，
 * 避免每次登录（桌面端每次启动）都重读公网导致聊天框空白。jsdom 下自动降级为空操作。
 */
import type { ImMessage } from '../components/Im/types'

const DB_NAME = 'npt-im-cache'
const STORE_SNAPSHOTS = 'snapshots'
const STORE_META = 'meta'
const STORE_BLOBS = 'blobs'
const VERSION = 2

/** 有界磁盘缓存：最多 400 张图 / 256MB，避免长期占用用户磁盘 */
const MAX_BLOBS = 400
const MAX_BLOB_BYTES = 256 * 1024 * 1024

export interface ImMessageSnapshot {
  key: string
  messages: ImMessage[]
  cursors?: { next: number | null; prev: number | null; hasMore: boolean }
  savedAt: number
}

interface BlobRecord {
  key: string
  blob: Blob
  size: number
  savedAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (!dbPromise) {
    dbPromise = new Promise(resolve => {
      let request: IDBOpenDBRequest
      try {
        request = indexedDB.open(DB_NAME, VERSION)
      } catch {
        resolve(null)
        return
      }
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
          db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains(STORE_BLOBS)) {
          db.createObjectStore(STORE_BLOBS, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    })
  }
  return dbPromise
}

function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(db => {
    if (!db) return null
    return new Promise<T | null>(resolve => {
      try {
        const request = run(db.transaction(store, mode).objectStore(store))
        request.onsuccess = () => resolve(request.result ?? null)
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  })
}

function write(store: string, value: unknown): Promise<void> {
  return openDb().then(db => {
    if (!db) return
    return new Promise<void>(resolve => {
      try {
        const tx = db.transaction(store, 'readwrite')
        tx.objectStore(store).put(value)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  })
}

export async function readSnapshot(key: string): Promise<ImMessageSnapshot | null> {
  return withStore<ImMessageSnapshot>(STORE_SNAPSHOTS, 'readonly', s => s.get(key))
}

/** 启动时一次性取出该账号的全部会话历史，之后打开聊天窗口无需再读磁盘/等网络。 */
export async function readAllSnapshots(prefix: string): Promise<ImMessageSnapshot[]> {
  const rows = await withStore<ImMessageSnapshot[]>(
    STORE_SNAPSHOTS, 'readonly', s => s.getAll())
  return (rows || []).filter(row => String(row?.key || '').startsWith(prefix))
}

export function writeSnapshot(snapshot: ImMessageSnapshot): Promise<void> {
  return write(STORE_SNAPSHOTS, snapshot)
}

export interface ImMetaRecord<T> {
  key: string
  value: T
  savedAt: number
}

export async function readMeta<T>(key: string): Promise<T | null> {
  const row = await withStore<ImMetaRecord<T>>(STORE_META, 'readonly', s => s.get(key))
  return row?.value ?? null
}

export function writeMeta<T>(key: string, value: T): Promise<void> {
  return write(STORE_META, { key, value, savedAt: Date.now() } satisfies ImMetaRecord<T>)
}

export async function readBlob(key: string): Promise<Blob | null> {
  const row = await withStore<BlobRecord>(STORE_BLOBS, 'readonly', s => s.get(key))
  return row?.blob ?? null
}

/** 写入附件字节；超限时按 savedAt 淘汰最旧的副本（LRU 近似）。 */
export async function writeBlob(key: string, blob: Blob): Promise<void> {
  await write(STORE_BLOBS, {
    key, blob, size: blob.size, savedAt: Date.now(),
  } satisfies BlobRecord)
  const rows = await withStore<BlobRecord[]>(STORE_BLOBS, 'readonly', s => s.getAll())
  if (!rows || rows.length <= MAX_BLOBS) return
  const total = rows.reduce((sum, row) => sum + (row.size || 0), 0)
  if (rows.length <= MAX_BLOBS && total <= MAX_BLOB_BYTES) return
  const ordered = [...rows].sort((a, b) => a.savedAt - b.savedAt)
  let count = rows.length
  let bytes = total
  for (const row of ordered) {
    if (count <= MAX_BLOBS && bytes <= MAX_BLOB_BYTES) break
    const db = await openDb()
    if (!db) break
    await new Promise<void>(resolve => {
      try {
        const tx = db.transaction(STORE_BLOBS, 'readwrite')
        tx.objectStore(STORE_BLOBS).delete(row.key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
    count -= 1
    bytes -= row.size || 0
  }
}

export async function clearAllSnapshots(): Promise<void> {
  return clearStore(STORE_SNAPSHOTS)
}

export async function clearAllMeta(): Promise<void> {
  return clearStore(STORE_META)
}

export async function clearAllBlobs(): Promise<void> {
  return clearStore(STORE_BLOBS)
}

function clearStore(store: string): Promise<void> {
  return openDb().then(db => {
    if (!db) return
    return new Promise<void>(resolve => {
      try {
        const tx = db.transaction(store, 'readwrite')
        tx.objectStore(store).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  })
}
