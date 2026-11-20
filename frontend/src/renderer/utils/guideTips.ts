/**
 * 页面冒泡引导：对所有登录用户（网页端 / 桌面端共享·单机）生效。
 * 两个独立的限制维度：
 * - 登录周期内：每条文案只出现一次（刷新网页不重弹，重新登录才算新周期）；
 * - 跨周期累计：每条文案累计展示 30 次后永久停止。
 * 纯逻辑（计数 / 会话去重持久化 / 配置）与 UI 分离，便于单测。
 */

/** 用户停留在对应模块超过该时长才触发气泡：3 秒 */
export const GUIDE_TIP_TRIGGER_DELAY_MS = 3 * 1000
/** 气泡显示后的默认停留时长：2 分钟 */
export const GUIDE_TIP_DURATION_MS = 2 * 60 * 1000
/** 每条提示按账号累计最多展示次数，达到后不再提示 */
export const GUIDE_TIP_MAX_SHOWS = 30

export interface GuideTip {
  /** 与页面元素 data-guide 值一致的锚点 id */
  id: string
  /** zh/en locales 中的文案 key */
  i18nKey: string
  /** 生效的页面路径（精确匹配） */
  routes: string[]
}

/** 提示清单：页面通过 data-guide 标注锚点，锚点只在「合适时机」渲染 */
export const GUIDE_TIPS: GuideTip[] = [
  { id: 'pci-new-task', i18nKey: 'guide.pciNewTask', routes: ['/pci'] },
  { id: 'result-show-map', i18nKey: 'guide.resultShowMap', routes: ['/pci', '/neighbor', '/tac'] },
  { id: 'data-import-to-map', i18nKey: 'guide.dataImportToMap', routes: ['/data'] },
  { id: 'imported-download', i18nKey: 'guide.importedDownload', routes: ['/data'] },
  { id: 'cell-tools-expand', i18nKey: 'guide.cellToolsExpand', routes: ['/data'] },
  { id: 'map-layer-control', i18nKey: 'guide.mapLayerControl', routes: ['/map'] },
  { id: 'map-search-switch', i18nKey: 'guide.mapSearchSwitch', routes: ['/map'] },
  { id: 'map-source-switch', i18nKey: 'guide.mapSourceSwitch', routes: ['/map'] },
  { id: 'map-drag-tool', i18nKey: 'guide.mapDragTool', routes: ['/map'] },
  { id: 'map-clear-markers', i18nKey: 'guide.mapClearMarkers', routes: ['/map'] },
]

/** 把登录令牌折叠成短指纹（不落盘原始 token）；令牌变化即视为新登录周期 */
export function sessionFingerprint(token: string | null | undefined): string {
  if (!token) return 'anonymous'
  let h = 0
  for (let i = 0; i < token.length; i++) h = (Math.imul(h, 31) + token.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// ---- 维度一：跨周期累计次数（按账号，localStorage） ----

const countsKey = (username: string) => `npt-guide-counts:v1:${username}`

/** 读取该账号每条提示已展示次数（localStorage 不可用/损坏时按空处理） */
export function getTipShowCounts(username: string): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(countsKey(username)) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const counts: Record<string, number> = {}
    for (const [id, n] of Object.entries(parsed)) {
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) counts[id] = Math.floor(n)
    }
    return counts
  } catch {
    return {}
  }
}

/** 是否还能向该账号展示这条提示（未达 30 次累计上限） */
export function canShowTip(username: string, id: string): boolean {
  return (getTipShowCounts(username)[id] || 0) < GUIDE_TIP_MAX_SHOWS
}

/** 记一次展示；调用方保证只在气泡真正触发显示时调一次，避免重复计数 */
export function bumpTipShowCount(username: string, id: string): void {
  try {
    const counts = getTipShowCounts(username)
    counts[id] = (counts[id] || 0) + 1
    localStorage.setItem(countsKey(username), JSON.stringify(counts))
  } catch {
    /* 隐私模式 / 配额限制：无法持久化计数，退化为不计数，不影响功能 */
  }
}

// ---- 维度二：登录周期内「已展示」去重 ----

const sessionKey = (username: string) => `npt-guide-session:v1:${username}`

/**
 * 本登录周期已展示过的提示 id。
 * 记录里存的是上一次登录周期的令牌指纹；指纹不同即视为新周期，返回空（并在首次标记时覆盖）。
 * 刷新网页令牌不变 → 已提示的文案不再出现；重新登录令牌变化 → 新周期可再提示。
 */
export function getSessionShown(username: string, fp: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(sessionKey(username)) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    if (parsed.fp !== fp) return []
    return Array.isArray(parsed.shown)
      ? parsed.shown.filter((x: unknown): x is string => typeof x === 'string')
      : []
  } catch {
    return []
  }
}

/** 标记某条提示已在本登录周期展示（幂等） */
export function markSessionShown(username: string, fp: string, id: string): void {
  try {
    const shown = getSessionShown(username, fp)
    if (!shown.includes(id)) {
      localStorage.setItem(sessionKey(username), JSON.stringify({ fp, shown: [...shown, id] }))
    }
  } catch {
    /* 隐私模式 / 配额限制：本周期内退化为可重复提示，不影响功能 */
  }
}
