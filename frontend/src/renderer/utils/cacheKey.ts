/**
 * IndexedDB 缓存 key 按用户隔离后缀。
 *
 * 数据列表 / 地图工参 / 小区列表等缓存原先全局单 key，同一浏览器切换
 * （地市+运营商）账号时会在 TTL 内读到上一账号的数据，表现为跨组"串数据"。
 * 以 auth-storage 中的用户 id 作后缀隔离；未登录返回 _anon，永不命中真实用户缓存。
 *
 * 桌面端同一账号在共享/单机两种运行模式下各有一套独立数据库，镜像用户 id
 * 可能相同，因此额外按运行模式（desktopRunMode）分后缀，杜绝跨数据空间串缓存；
 * 网页端 desktopRunMode 为 null，后缀保持原样，不影响既有网页端缓存命中。
 */
export function userCacheSuffix(): string {
  try {
    const stored = localStorage.getItem('auth-storage')
    if (!stored) return '_anon'
    const parsed = JSON.parse(stored)
    const id = parsed?.state?.user?.id
    if (id == null) return '_anon'
    const runMode = parsed?.state?.desktopRunMode
    const modeSuffix =
      runMode === 'standalone' ? '_dstandalone'
      : runMode === 'shared' ? '_dshared'
      : ''
    return `_u${id}${modeSuffix}`
  } catch {
    return '_anon'
  }
}
