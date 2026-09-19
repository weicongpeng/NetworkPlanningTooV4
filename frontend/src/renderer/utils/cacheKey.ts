/**
 * IndexedDB 缓存 key 按用户隔离后缀。
 *
 * 数据列表 / 地图工参 / 小区列表等缓存原先全局单 key，同一浏览器切换
 * （地市+运营商）账号时会在 TTL 内读到上一账号的数据，表现为跨组"串数据"。
 * 以 auth-storage 中的用户 id 作后缀隔离；未登录返回 _anon，永不命中真实用户缓存。
 */
export function userCacheSuffix(): string {
  try {
    const stored = localStorage.getItem('auth-storage')
    if (!stored) return '_anon'
    const parsed = JSON.parse(stored)
    const id = parsed?.state?.user?.id
    return id != null ? `_u${id}` : '_anon'
  } catch {
    return '_anon'
  }
}
