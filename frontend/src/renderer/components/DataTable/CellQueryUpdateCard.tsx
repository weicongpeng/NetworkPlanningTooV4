import { useState, useEffect, useRef } from 'react'
import { Loader2, CheckCircle2, AlertCircle, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { dataApi } from '../../services/api'
import { CellParamsTable } from './CellParamsTable'
import type { CellRow, CellSearchItem, CellBulkUpdateResultItem, DataItem } from '@shared/types'

// ---- 变更计算（纯函数，导出便于单测） ----
export interface CellChangeUpdate {
  rowKey: string
  networkType: 'LTE' | 'NR'
  diff: Record<string, [string, string]>
  fields: Record<string, string | number>
}
export interface CellChangeDelete {
  rowKey: string
  networkType: 'LTE' | 'NR'
  cellName: string
  siteId: string
  cellId: string
}
export function computeCellChanges(
  original: CellRow[],
  edited: CellRow[],
  deleteMarked: Set<string>,
  activeTab: 'LTE' | 'NR',
): { updates: CellChangeUpdate[]; deletes: CellChangeDelete[] } {
  const updates: CellChangeUpdate[] = []
  const deletes: CellChangeDelete[] = []
  const byId = new Map(original.map(r => [r.id, r]))
  for (const row of edited) {
    const orig = byId.get(row.id)
    if (!orig) continue
    if (deleteMarked.has(row.id)) {
      deletes.push({ rowKey: row.rowKey ?? row.id, networkType: activeTab, cellName: row.cellName, siteId: row.siteId, cellId: row.cellId })
      continue
    }
    const diff: Record<string, [string, string]> = {}
    const fields: Record<string, string | number> = {}
    const keys = ['managedElementId', 'siteId', 'cellId', 'cellName', 'mcc', 'mnc', 'longitude', 'latitude', 'azimuth', 'frequency', 'ssbFrequency', 'cellCoverType'] as const
    for (const k of keys) {
      const o = String(orig[k] ?? '').trim()
      const n = String(row[k] ?? '').trim()
      if (o !== n) {
        diff[k] = [o, n]
        fields[k] = row[k] as string | number
      }
    }
    if (Object.keys(diff).length > 0) {
      updates.push({ rowKey: row.rowKey ?? row.id, networkType: activeTab, diff, fields })
    }
  }
  return { updates, deletes }
}

// 字段键 → newCellEntry 翻译键（确认弹窗 diff 展示用）
const FIELD_LABEL_KEYS: Record<string, string> = {
  managedElementId: 'fieldManagedElementId',
  siteId: 'fieldSiteIdLTE',
  cellId: 'fieldCellId',
  cellName: 'fieldCellName',
  mcc: 'fieldMCC',
  mnc: 'fieldMNC',
  longitude: 'fieldLongitude',
  latitude: 'fieldLatitude',
  azimuth: 'fieldAzimuth',
  frequency: 'fieldFrequency',
  ssbFrequency: 'fieldSsbFrequency',
  cellCoverType: 'fieldCellCoverType',
}

interface QueryResultRow {
  rowKey: string
  type: 'update' | 'delete'
  success: boolean
  message: string
  display: string
}

export function CellQueryUpdateCard({
  fullParamFiles,
  addLog,
  disabled,
}: {
  fullParamFiles: DataItem[]
  addLog: (type: any, message: string, status?: any, detail?: string, opKey?: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()

  const [activeTab, setActiveTab] = useState<'LTE' | 'NR'>('LTE')
  const [origRows, setOrigRows] = useState<{ LTE: CellRow[]; NR: CellRow[] }>({ LTE: [], NR: [] })
  const [rows, setRows] = useState<{ LTE: CellRow[]; NR: CellRow[] }>({ LTE: [], NR: [] })
  const [deleteMarked, setDeleteMarked] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<CellSearchItem[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [searching, setSearching] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmData, setConfirmData] = useState<{ updates: CellChangeUpdate[]; deletes: CellChangeDelete[] } | null>(null)
  const [updating, setUpdating] = useState(false)
  const [batchResults, setBatchResults] = useState<QueryResultRow[] | null>(null)
  const [batchError, setBatchError] = useState<string | null>(null)

  // 搜索防抖定时器 + 过期响应序号
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)

  // 列宽：默认宽度表 + localStorage 持久化
  const DEFAULT_COL_WIDTHS: Record<string, number> = {
    managedElementId: 52, siteId: 52, cellId: 52, cellName: 175,
    mcc: 52, mnc: 52, longitude: 70, latitude: 70,
    azimuth: 52, frequency: 52, ssbFrequency: 52, cellCoverType: 70,
  }
  const COL_WIDTHS_KEY = 'npt_cell_query_col_widths'
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem(COL_WIDTHS_KEY)
      return saved ? { ...DEFAULT_COL_WIDTHS, ...JSON.parse(saved) } : DEFAULT_COL_WIDTHS
    } catch { return DEFAULT_COL_WIDTHS }
  })

  const hasFullParams = fullParamFiles.length > 0
  const totalRows = rows.LTE.length + rows.NR.length

  // 卸载时清理防抖定时器
  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [])

  // ---- 搜索 ----
  const handleSearchChange = (q: string) => {
    setSearchQuery(q)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    const seq = ++searchSeq.current
    if (!q.trim()) {
      setSearchResults([])
      setShowDropdown(false)
      setHighlightIndex(-1)
      setSearching(false)
      return
    }
    setSearching(true)
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await dataApi.searchCells(q.trim(), activeTab)
        if (seq !== searchSeq.current) return // 过期响应丢弃
        setSearchResults(res?.data ?? [])
        setShowDropdown(true)
      } catch {
        if (seq !== searchSeq.current) return
        setSearchResults([])
        setShowDropdown(false)
      } finally {
        if (seq === searchSeq.current) setSearching(false)
      }
    }, 300)
  }

  const toCellRow = (item: CellSearchItem): CellRow => ({
    id: `qrow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    managedElementId: item.managedElementId ?? '',
    siteId: item.siteId,
    cellId: item.cellId,
    cellName: item.cellName,
    mcc: item.mcc ?? '',
    mnc: item.mnc ?? '',
    longitude: item.longitude != null ? String(item.longitude) : '',
    latitude: item.latitude != null ? String(item.latitude) : '',
    azimuth: item.azimuth != null ? String(item.azimuth) : '',
    frequency: item.frequency != null ? String(item.frequency) : '',
    ssbFrequency: item.ssbFrequency != null ? String(item.ssbFrequency) : '',
    cellCoverType: item.cellCoverType,
    rowKey: item.rowKey,
  })

  // 选择搜索结果：rowKey 已存在则忽略（去重），否则追加到 rows + origRows
  const selectSearchItem = (item: CellSearchItem) => {
    if (rows[activeTab].some(r => r.rowKey === item.rowKey)) {
      setShowDropdown(false)
      return
    }
    const newRow = toCellRow(item)
    setRows(prev => ({ ...prev, [activeTab]: [...prev[activeTab], newRow] }))
    setOrigRows(prev => ({ ...prev, [activeTab]: [...prev[activeTab], { ...newRow }] }))
    setSearchQuery('')
    setSearchResults([])
    setShowDropdown(false)
    setHighlightIndex(-1)
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex(i => (searchResults.length === 0 ? -1 : Math.min(i + 1, searchResults.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex(i => Math.max(i - 1, -1))
    } else if (e.key === 'Enter') {
      if (showDropdown && highlightIndex >= 0 && searchResults[highlightIndex]) {
        e.preventDefault()
        selectSearchItem(searchResults[highlightIndex])
      }
    } else if (e.key === 'Escape') {
      setShowDropdown(false)
    }
  }

  // ---- 行编辑 ----
  const updateRow = (rowId: string, field: string, value: string | number) => {
    setRows(prev => ({
      ...prev,
      [activeTab]: prev[activeTab].map(r => (r.id === rowId ? { ...r, [field]: value } : r)),
    }))
  }

  const filterDigits = (v: string) => v.replace(/\D/g, '')

  // 方向角输入：过滤数字后若超范围(>360)则提示并拒绝写入
  const handleAzimuthChange = (rowId: string, value: string) => {
    const cleaned = filterDigits(value)
    if (cleaned === '') { updateRow(rowId, 'azimuth', ''); return } // 允许清空
    const num = parseInt(cleaned, 10)
    if (!isNaN(num) && num > 360) {
      setBatchError(t('newCellEntry.azimuthRangeError') || '方向角必须在 0-360 之间')
      setTimeout(() => setBatchError(null), 3000)
      return
    }
    updateRow(rowId, 'azimuth', cleaned)
  }

  // ---- 删除标记 ----
  const toggleDeleteMark = (rowId: string) => {
    setDeleteMarked(prev => {
      const next = new Set(prev)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
  }

  // ---- 更新按钮：聚合 LTE/NR 两页签变更 ----
  const handleUpdateClick = () => {
    if (!hasFullParams || disabled || updating) return
    if (totalRows === 0) {
      setBatchError(t('queryUpdate.selectResultFirst') || '请先从搜索结果选择小区')
      setTimeout(() => setBatchError(null), 3000)
      return
    }
    const updates: CellChangeUpdate[] = []
    const deletes: CellChangeDelete[] = []
    for (const nt of ['LTE', 'NR'] as const) {
      const changes = computeCellChanges(origRows[nt], rows[nt], deleteMarked, nt)
      updates.push(...changes.updates)
      deletes.push(...changes.deletes)
    }
    if (updates.length === 0 && deletes.length === 0) {
      setBatchError(t('queryUpdate.confirmEmpty') || '没有变更内容')
      setTimeout(() => setBatchError(null), 3000)
      return
    }
    setConfirmData({ updates, deletes })
    setConfirmOpen(true)
  }

  // ---- 确认执行：批量更新 + 删除 ----
  const handleConfirmExecute = async () => {
    if (!confirmData || updating) return
    const { updates, deletes } = confirmData
    const opKey = `cellQueryUpdate:${Date.now()}`
    // 行显示名快照（成功后表格清空，结果仍可展示）
    const displayMap = new Map<string, string>()
    for (const u of updates) displayMap.set(u.rowKey, u.diff.cellName?.[1] || u.rowKey)
    for (const d of deletes) displayMap.set(d.rowKey, `${d.cellName} (${d.siteId}_${d.cellId})`)

    setUpdating(true)
    addLog('update', `查询/更新: 更新 ${updates.length} 条，删除 ${deletes.length} 条`, 'running', undefined, opKey)
    try {
      const res = await dataApi.bulkUpdateCells({
        updates: updates.map(u => ({ rowKey: u.rowKey, networkType: u.networkType, fields: u.fields })),
        deletes: deletes.map(d => ({ rowKey: d.rowKey, networkType: d.networkType })),
      })
      if (res?.success && res?.data?.results) {
        const results: CellBulkUpdateResultItem[] = res.data.results
        setBatchResults(results.map(r => ({ ...r, display: displayMap.get(r.rowKey) ?? r.rowKey })))
        const okCount = results.filter(r => r.success).length
        const failCount = results.length - okCount
        addLog('update', t('queryUpdate.updateSuccess', { ok: okCount, fail: failCount }) || `更新完成：成功 ${okCount} 条，失败 ${failCount} 条`, failCount === 0 ? 'success' : 'warning', undefined, opKey)
        setConfirmOpen(false)
        setConfirmData(null)
        // 成功后清空表格/标记/搜索
        setRows({ LTE: [], NR: [] })
        setOrigRows({ LTE: [], NR: [] })
        setDeleteMarked(new Set())
        setSearchQuery('')
        setSearchResults([])
        setShowDropdown(false)
        setHighlightIndex(-1)
      } else {
        const errMsg = res?.message || (t('queryUpdate.updateFailed', { msg: '' }) || '更新失败')
        setBatchError(errMsg)
        addLog('update', `查询/更新失败: ${errMsg}`, 'error', undefined, opKey)
        setTimeout(() => setBatchError(null), 5000)
      }
    } catch (err: any) {
      const errMsg = err?.message || '更新失败'
      setBatchError(errMsg)
      addLog('update', `查询/更新失败: ${errMsg}`, 'error', undefined, opKey)
      setTimeout(() => setBatchError(null), 5000)
    } finally {
      setUpdating(false)
    }
  }

  // ---- 清空 ----
  const resetAll = () => {
    setRows({ LTE: [], NR: [] })
    setOrigRows({ LTE: [], NR: [] })
    setDeleteMarked(new Set())
    setSearchQuery('')
    setSearchResults([])
    setShowDropdown(false)
    setHighlightIndex(-1)
    setBatchResults(null)
    setBatchError(null)
  }

  // ---- 列宽拖拽 ----
  const startColResize = (e: React.MouseEvent, colKey: string) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = colWidths[colKey] ?? DEFAULT_COL_WIDTHS[colKey] ?? 70
    let lastWidth = startWidth
    const onMove = (ev: MouseEvent) => {
      if (ev.buttons === 0) { onUp(); return } // 丢失 mouseup 时兜底
      const delta = ev.clientX - startX
      const next = Math.max(40, startWidth + delta)
      lastWidth = next
      setColWidths(prev => ({ ...prev, [colKey]: next }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      try {
        const merged = { ...DEFAULT_COL_WIDTHS, ...colWidths, [colKey]: lastWidth }
        localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(merged))
      } catch { /* ignore */ }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 确认弹窗 diff 字段标签
  const fieldLabel = (k: string) => {
    const key = FIELD_LABEL_KEYS[k]
    return key ? (t(`newCellEntry.${key}`) || k) : k
  }

  // ---- 渲染 ----
  const renderContent = () => (
    <>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-base font-semibold">{t('queryUpdate.title') || '查询/更新'}</h2>
        <span className="text-xs text-muted-foreground">
          LTE: {rows.LTE.length}&nbsp; NR: {rows.NR.length}
        </span>
      </div>

      {disabled && (
        <div className="px-3 py-2 bg-muted/40 border border-border rounded-lg text-xs text-muted-foreground mb-3">
          {t('data.noPermission', '无权限，请联系管理员')}
        </div>
      )}

      {!hasFullParams && (
        <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs mb-3 text-amber-700">
          {t('newCellEntry.noFullParams') || '请先上传全量工参文件'}
        </div>
      )}

      {batchError && (
        <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-xs mb-3 text-red-700">
          <AlertCircle size={14} />
          <span>{batchError}</span>
          <button onClick={() => setBatchError(null)} className="ml-auto text-red-500 hover:text-red-700">✕</button>
        </div>
      )}

      {/* LTE/NR 页签 + 更新/清空 */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex gap-2">
          {(['LTE', 'NR'] as const).map(nt => (
            <button
              key={nt}
              onClick={() => {
                if (searchTimer.current) clearTimeout(searchTimer.current)
                setActiveTab(nt)
                setSearchResults([])
                setShowDropdown(false)
                setHighlightIndex(-1)
              }}
              className={`px-3 py-1 rounded-md text-xs border transition-colors ${
                activeTab === nt
                  ? 'bg-primary/10 border-primary text-primary font-medium'
                  : 'bg-background border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {nt}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={resetAll}
            disabled={!hasFullParams || disabled || updating}
            className="px-3 py-1.5 text-xs rounded-md border border-border bg-background text-muted-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t('queryUpdate.clear') || '清空'}
          </button>
          <button
            onClick={handleUpdateClick}
            disabled={!hasFullParams || disabled || updating || totalRows === 0}
            className="px-4 py-1.5 text-xs font-medium rounded-md bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
          >
            {updating ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            {updating ? (t('queryUpdate.updateRunning') || '更新中...') : (t('queryUpdate.update') || '更新')}
          </button>
        </div>
      </div>

      {/* 搜索框 + 下拉 */}
      <div className="relative mb-1">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => handleSearchChange(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          onFocus={() => { if (searchResults.length > 0) setShowDropdown(true) }}
          onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
          disabled={!hasFullParams || disabled || updating}
          placeholder={t('queryUpdate.searchPlaceholder') || '输入小区名称/网元ID/基站ID/基站名称搜索'}
          className="w-full pl-8 pr-8 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
        />
        {searching && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground animate-spin" />}
        {showDropdown && searchResults.length > 0 && (
          <ul className="absolute z-20 mt-1 w-full bg-card border border-border rounded-md shadow-lg max-h-56 overflow-y-auto">
            {searchResults.map((item, i) => (
              <li
                key={item.rowKey}
                onMouseDown={e => { e.preventDefault(); selectSearchItem(item) }}
                onMouseEnter={() => setHighlightIndex(i)}
                className={`px-3 py-2 text-xs cursor-pointer flex items-center justify-between gap-2 ${i === highlightIndex ? 'bg-primary/10' : 'hover:bg-muted'}`}
              >
                <span className="font-medium text-foreground truncate">{item.cellName}</span>
                <span className="text-muted-foreground shrink-0">
                  {item.siteId}_{item.cellId}{item.siteName ? ` · ${item.siteName}` : ''} ({item.networkType})
                </span>
              </li>
            ))}
          </ul>
        )}
        {showDropdown && searchQuery.trim() !== '' && !searching && searchResults.length === 0 && (
          <div className="absolute z-20 mt-1 w-full bg-card border border-border rounded-md shadow-lg px-3 py-2 text-xs text-muted-foreground">
            {t('queryUpdate.noResult') || '无匹配结果'}
          </div>
        )}
      </div>
      <div className="text-[10px] text-muted-foreground/70 mb-1">
        {t('queryUpdate.searchHint') || '支持模糊匹配，选中后追加到下方表格'}
      </div>

      {/* 表格 */}
      <div className="overflow-x-auto">
        <CellParamsTable
          rows={rows[activeTab]}
          activeTab={activeTab}
          colWidths={colWidths}
          onColResize={startColResize}
          onFieldChange={updateRow}
          onAzimuthChange={handleAzimuthChange}
          disabled={!hasFullParams || disabled || updating}
          hideCheckbox
          deleteMarkedIds={deleteMarked}
          onToggleDeleteMark={toggleDeleteMark}
          duplicateMap={{}}
          t={t}
        />
      </div>

      {/* 结果 */}
      {batchResults && batchResults.length > 0 && (
        <div className="mt-3 px-3 py-2 bg-muted/50 border border-border rounded-lg text-xs">
          <div className="flex items-center gap-2 mb-1.5 font-medium text-foreground">
            <CheckCircle2 size={14} />
            <span>{t('queryUpdate.resultTitle') || '操作结果'}</span>
            <button onClick={() => setBatchResults(null)} className="ml-auto text-muted-foreground hover:text-foreground">✕</button>
          </div>
          {batchResults.map((r, i) => (
            <div key={i} className={`flex items-center gap-1.5 py-0.5 ${r.success ? 'text-green-600' : 'text-red-600'}`}>
              <span className="font-medium shrink-0">
                [{r.type === 'delete' ? (t('queryUpdate.confirmDeleteLabel') || '删除') : (t('queryUpdate.confirmUpdateLabel') || '更新')}]
              </span>
              <span className="truncate">{r.display}</span>
              <span className="ml-auto shrink-0">{r.success ? '✓' : '✗'} {r.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* 确认弹窗（fixed 内联 overlay） */}
      {confirmOpen && confirmData && (
        <div className="fixed inset-0 z-[9999] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card rounded-xl shadow-2xl border border-border w-full max-w-lg overflow-hidden">
            <div className="p-5 max-h-[70vh] overflow-y-auto">
              <h3 className="text-base font-semibold mb-3">{t('queryUpdate.confirmTitle') || '确认更新/删除'}</h3>
              {confirmData.updates.length > 0 && (
                <div className="mb-3">
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    {t('queryUpdate.confirmUpdateLabel') || '更新'} ({confirmData.updates.length})
                  </div>
                  <div className="max-h-48 overflow-y-auto border border-border rounded-md divide-y divide-border">
                    {confirmData.updates.map((u, i) => (
                      <div key={i} className="px-2 py-1.5 text-xs">
                        <div className="font-medium text-foreground">
                          [{u.networkType}] {u.diff.cellName?.[1] || u.rowKey}
                        </div>
                        <div className="text-muted-foreground space-y-0.5">
                          {Object.entries(u.diff).map(([k, [oldV, newV]]) => (
                            <div key={k} className="flex items-center gap-1">
                              <span>{fieldLabel(k)}:</span>
                              <span className="line-through text-red-500">{oldV || t('queryUpdate.emptyValue') || '(空)'}</span>
                              <span>→</span>
                              <span className="text-green-600">{newV || t('queryUpdate.emptyValue') || '(空)'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {confirmData.deletes.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    {t('queryUpdate.confirmDeleteLabel') || '删除'} ({confirmData.deletes.length})
                  </div>
                  <div className="max-h-40 overflow-y-auto border border-border rounded-md divide-y divide-border">
                    {confirmData.deletes.map((d, i) => (
                      <div key={i} className="px-2 py-1.5 text-xs text-red-600">
                        [{d.networkType}] {d.cellName} ({d.siteId}_{d.cellId})
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="px-5 py-3 flex items-center justify-end gap-2 border-t border-border">
              <button
                onClick={() => { setConfirmOpen(false); setConfirmData(null) }}
                disabled={updating}
                className="px-4 py-1.5 text-xs rounded-md border border-border bg-background text-muted-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {t('queryUpdate.confirmCancel') || '取消'}
              </button>
              <button
                onClick={handleConfirmExecute}
                disabled={updating}
                className="px-4 py-1.5 text-xs font-medium rounded-md bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
              >
                {updating ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {updating ? (t('queryUpdate.updateRunning') || '更新中...') : (t('queryUpdate.confirmExecute') || '确认执行')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  return (
    <div className={`bg-card p-3 rounded-lg border border-border -mt-6 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      {renderContent()}
    </div>
  )
}
