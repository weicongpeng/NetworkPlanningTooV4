/**
 * 「上次停留页面」记录（按用户名隔离，持久化到 localStorage）。
 *
 * 用途：重新登录后回到退出前的页面，避免每次登录都落在首页。
 * 由已登录状态下的路由变化写入，登录成功后由 LoginModal 读取并跳转。
 */

const KEY_PREFIX = 'last-route-'

/** 未登录即可访问的页面，不参与记录与恢复 */
const EXCLUDED_PREFIXES = ['/license']

function isExcluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some(
    prefix => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)
  )
}

export function saveLastRoute(username: string | null | undefined, path: string): void {
  if (!username || !path.startsWith('/') || isExcluded(path)) return
  try {
    localStorage.setItem(KEY_PREFIX + username, path)
  } catch {
    /* 隐私模式等不可写场景忽略 */
  }
}

/** 返回上次停留页面路径；无记录、首页或未登录页面返回 null（无需跳转） */
export function getLastRoute(username: string | null | undefined): string | null {
  if (!username) return null
  try {
    const path = localStorage.getItem(KEY_PREFIX + username)
    if (!path || !path.startsWith('/') || path === '/' || isExcluded(path)) return null
    return path
  } catch {
    return null
  }
}
