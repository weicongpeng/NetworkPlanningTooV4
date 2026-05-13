/**
 * IndexedDB 缓存服务
 * 用于持久化缓存地图数据和其他大数据，减少重复网络请求
 */

const DB_NAME = 'NetworkPlanningToolDB'
const DB_VERSION = 1
const STORE_NAME = 'mapDataCache'

interface CacheEntry<T> {
  key: string
  data: T
  timestamp: number
  ttl: number // 缓存有效期（毫秒）
}

class IndexedDBService {
  private db: IDBDatabase | null = null
  private initPromise: Promise<void> | null = null

  /**
   * 初始化 IndexedDB
   */
  async init(): Promise<void> {
    if (this.db) return
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => {
        console.error('[IndexedDB] 打开数据库失败')
        reject(request.error)
      }

      request.onsuccess = () => {
        this.db = request.result
        console.log('[IndexedDB] 数据库已打开')
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' })
          store.createIndex('timestamp', 'timestamp', { unique: false })
          console.log('[IndexedDB] 创建对象存储:', STORE_NAME)
        }
      }
    })

    return this.initPromise
  }

  /**
   * 存储数据到缓存
   * @param key 缓存键
   * @param data 要缓存的数据
   * @param ttl 缓存有效期（毫秒），默认5分钟
   */
  async set<T>(key: string, data: T, ttl: number = 5 * 60 * 1000): Promise<void> {
    await this.init()
    if (!this.db) throw new Error('IndexedDB 未初始化')

    const entry: CacheEntry<T> = {
      key,
      data,
      timestamp: Date.now(),
      ttl
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.put(entry)

      request.onsuccess = () => {
        console.log(`[IndexedDB] 数据已缓存: ${key}`)
        resolve()
      }
      request.onerror = () => {
        console.error(`[IndexedDB] 缓存数据失败: ${key}`)
        reject(request.error)
      }
    })
  }

  /**
   * 从缓存获取数据
   * @param key 缓存键
   * @returns 缓存的数据，如果不存在或已过期则返回 null
   */
  async get<T>(key: string): Promise<T | null> {
    await this.init()
    if (!this.db) return null

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(key)

      request.onsuccess = () => {
        const entry: CacheEntry<T> | undefined = request.result

        if (!entry) {
          console.log(`[IndexedDB] 缓存未命中: ${key}`)
          resolve(null)
          return
        }

        // 检查缓存是否过期
        const now = Date.now()
        if (now - entry.timestamp > entry.ttl) {
          console.log(`[IndexedDB] 缓存已过期: ${key}`)
          // 删除过期数据
          this.delete(key)
          resolve(null)
          return
        }

        console.log(`[IndexedDB] 缓存命中: ${key}`)
        resolve(entry.data)
      }

      request.onerror = () => {
        console.error(`[IndexedDB] 获取缓存失败: ${key}`)
        reject(request.error)
      }
    })
  }

  /**
   * 删除缓存数据
   * @param key 缓存键
   */
  async delete(key: string): Promise<void> {
    await this.init()
    if (!this.db) return

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.delete(key)

      request.onsuccess = () => {
        console.log(`[IndexedDB] 缓存已删除: ${key}`)
        resolve()
      }
      request.onerror = () => {
        console.error(`[IndexedDB] 删除缓存失败: ${key}`)
        reject(request.error)
      }
    })
  }

  /**
   * 清空所有缓存
   */
  async clear(): Promise<void> {
    await this.init()
    if (!this.db) return

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.clear()

      request.onsuccess = () => {
        console.log('[IndexedDB] 所有缓存已清空')
        resolve()
      }
      request.onerror = () => {
        console.error('[IndexedDB] 清空缓存失败')
        reject(request.error)
      }
    })
  }

  /**
   * 清理过期缓存
   */
  async cleanExpired(): Promise<void> {
    await this.init()
    if (!this.db) return

    const now = Date.now()

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const index = store.index('timestamp')
      const request = index.openCursor()

      let deletedCount = 0

      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          const entry: CacheEntry<any> = cursor.value
          if (now - entry.timestamp > entry.ttl) {
            cursor.delete()
            deletedCount++
          }
          cursor.continue()
        } else {
          console.log(`[IndexedDB] 清理了 ${deletedCount} 条过期缓存`)
          resolve()
        }
      }

      request.onerror = () => {
        console.error('[IndexedDB] 清理过期缓存失败')
        reject(request.error)
      }
    })
  }

  /**
   * 检查缓存是否存在且有效
   * @param key 缓存键
   */
  async has(key: string): Promise<boolean> {
    const data = await this.get(key)
    return data !== null
  }
}

// 导出单例实例
export const indexedDBService = new IndexedDBService()
