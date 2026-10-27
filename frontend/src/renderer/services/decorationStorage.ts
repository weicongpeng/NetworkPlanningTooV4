/**
 * 装饰图层要素 IndexedDB 持久化
 *
 * 装饰要素可能很大（如缓冲区批量生成的多边形），localStorage 约 5MB 限额会触发
 * QuotaExceededError 导致页面崩溃；IndexedDB 容量充裕（通常数百 MB）。
 * 按 mapStore 的用户存储 key（map-settings-user-<id> / map-settings-anonymous）隔离。
 */
import type { EditFeature } from '../store/layerEditStore'

const DB_NAME = 'NPTDecorationDB'
const DB_VERSION = 1
const STORE_NAME = 'decoration'

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return dbPromise
}

/** 读取指定用户的装饰要素（不存在/失败返回空数组） */
export async function loadDecorations(storageKey: string): Promise<EditFeature[]> {
  try {
    const db = await openDB()
    const data = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).get(storageKey)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return Array.isArray(data) ? (data as EditFeature[]) : []
  } catch (e) {
    console.error('[DecorationStorage] 读取失败:', e)
    return []
  }
}

/** 保存指定用户的装饰要素 */
export async function saveDecorations(
  storageKey: string, features: EditFeature[],
): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(features, storageKey)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
