/**
 * IM 本地优先缓存（IndexedDB）：桌面端/网页端都可用，jsdom 下自动降级为空操作。
 * 只缓存每个会话最近一次的完整快照；服务端仍是权威源，加载后继续增量重验证。
 */
import type { ImMessage } from '../components/Im/types'

const DB_NAME = 'npt-im-cache'
const STORE = 'snapshots'
const VERSION = 1

export interface ImMessageSnapshot {
  key: string
  messages: ImMessage[]
  cursors?: { next: number | null; prev: number | null; hasMore: boolean }
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
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    })
  }
  return dbPromise
}

export async function readSnapshot(key: string): Promise<ImMessageSnapshot | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise(resolve => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      request.onsuccess = () => resolve((request.result as ImMessageSnapshot) || null)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function writeSnapshot(snapshot: ImMessageSnapshot): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(snapshot)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

export async function clearAllSnapshots(): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}
