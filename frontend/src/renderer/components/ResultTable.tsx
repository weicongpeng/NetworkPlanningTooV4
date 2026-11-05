import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Loader2 } from 'lucide-react'

/**
 * 工具类结果列表：内部滚动 + 触底懒加载。
 *
 * 结果行数可能很大（站间距=站点数、距离匹配=匹配×命中多对多），因此：
 * - 不整表渲染：按 offset/limit 分页拉取，滚到底部再拉下一页
 * - 高度自适应浏览器：外层 flex 撑满，表格区域 `flex-1 min-h-0 overflow-auto`
 * - 表头 sticky，滚动时保持可见
 *
 * 由调用方提供 `loadPage(offset, limit)`；换结果时改 `resetKey` 即可重置列表。
 */

export const RESULT_PAGE_SIZE = 200

export interface ResultRowsPageData {
  columns: string[]
  total: number
  rows: (string | number | null)[][]
}

interface ResultTableProps {
  /** 换结果（如重新计算）时改变此值以重置已加载的行 */
  resetKey: string
  /** 拉取一页；由调用方接各自的后端 preview 接口 */
  loadPage: (offset: number, limit: number) => Promise<ResultRowsPageData>
  /** 表格最小高度（未加载完成时避免塌陷） */
  emptyHint?: string
}

export function ResultTable({ resetKey, loadPage, emptyHint }: ResultTableProps) {
  const { t } = useTranslation()

  const [columns, setColumns] = useState<string[]>([])
  const [rows, setRows] = useState<(string | number | null)[][]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  // 用 ref 承载「是否还有下一页」与「是否正在加载」：IntersectionObserver 回调
  // 只创建一次，闭包里的 state 会过期
  const stateRef = useRef({ loaded: 0, total: 0, loading: false, done: false, failed: false })

  // loadPage 经 ref 取用：调用方常以 useCallback([...t]) 包装，identity 可能每次渲染都变；
  // 若直接进依赖数组，会让下面的「换结果重置」effect 反复触发 → 无限重复拉取
  const loadPageRef = useRef(loadPage)
  useEffect(() => { loadPageRef.current = loadPage }, [loadPage])

  const loadMore = useCallback(async () => {
    const s = stateRef.current
    if (s.loading || s.done || s.failed) return
    s.loading = true
    setLoading(true)
    try {
      const page = await loadPageRef.current(s.loaded, RESULT_PAGE_SIZE)
      setColumns(page.columns)
      setRows((prev) => (s.loaded === 0 ? page.rows : prev.concat(page.rows)))
      s.total = page.total
      s.loaded += page.rows.length
      setTotal(page.total)
      // 空页或已取满 → 结束（防后端 total 与实际行数不一致时死循环）
      if (page.rows.length === 0 || s.loaded >= page.total) s.done = true
    } catch (e: any) {
      s.failed = true
      setError(e?.message || String(e))
    } finally {
      s.loading = false
      setLoading(false)
    }
  }, [])

  // 换结果：清空并重新拉第一页
  useEffect(() => {
    stateRef.current = { loaded: 0, total: 0, loading: false, done: false, failed: false }
    setColumns([])
    setRows([])
    setTotal(0)
    setError('')
    void loadMore()
  }, [resetKey, loadMore])

  // 触底加载：哨兵进入视口即拉下一页
  useEffect(() => {
    const root = scrollRef.current
    const target = sentinelRef.current
    if (!root || !target) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore()
      },
      { root, rootMargin: '200px' },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [loadMore])

  if (error) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center gap-2 text-xs text-red-500">
        <AlertCircle size={14} /> {error}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-xs text-muted-foreground">
        {loading ? <Loader2 size={16} className="animate-spin" /> : (emptyHint || t('common.noData', '暂无数据'))}
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto border border-border rounded-md">
        <table className="w-full text-xs">
          <thead className="bg-muted sticky top-0 z-10">
            <tr>
              <th className="px-2 py-2 text-left text-muted-foreground font-medium w-14">#</th>
              {columns.map((c) => (
                <th key={c} className="px-3 py-2 text-left text-muted-foreground font-medium whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-border hover:bg-muted/30 transition-colors">
                <td className="px-2 py-1.5 text-muted-foreground/60 tabular-nums">{i + 1}</td>
                {row.map((cell, j) => (
                  <td key={j} className="px-3 py-1.5 text-foreground whitespace-nowrap">
                    {cell === null || cell === undefined || cell === '' ? '-' : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {/* 触底哨兵：进入视口即加载下一页 */}
        <div ref={sentinelRef} className="h-8 flex items-center justify-center text-xs text-muted-foreground">
          {loading
            ? <Loader2 size={13} className="animate-spin" />
            : stateRef.current.done
              ? t('common.allLoaded', '已全部加载')
              : ''}
        </div>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground shrink-0">
        {t('common.loadedOfTotal', '已加载 {{loaded}} / {{total}} 条', { loaded: rows.length, total })}
      </p>
    </div>
  )
}
