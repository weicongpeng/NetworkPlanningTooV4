import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Download, GripVertical, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** 虚拟滚动配置（与 TAC核查结果表一致） */
const ITEM_HEIGHT = 48
const VISIBLE_COUNT = 20
const BUFFER_COUNT = 5

export interface ResultColumn {
  key: string
  label: string
  defaultWidth: number
}

/** 核查类别（顺序即前端 Tab 顺序，与后端 CheckType 一一对应） */
export const CHECK_TYPES = [
  { key: 'reuse_distance', label: 'PCI复用距离过小', accent: 'red' },
  { key: 'collision', label: 'PCI冲突', accent: 'orange' },
  { key: 'confusion', label: 'PCI混淆', accent: 'purple' },
  { key: 'mod3_same_site', label: '同站模3冲突', accent: 'blue' },
  { key: 'mod3_facing', label: '对打模3冲突', accent: 'cyan' },
  { key: 'mod3_neighbor', label: '邻区模3冲突', accent: 'teal' },
  { key: 'mod30_same_site', label: '同站模30冲突', accent: 'amber' },
  { key: 'mod30_facing', label: '对打模30冲突', accent: 'lime' },
  { key: 'mod30_neighbor', label: '邻区模30冲突', accent: 'rose' },
] as const

export type CheckTypeKey = (typeof CHECK_TYPES)[number]['key']

/** 小区对公共列（列名与导出保持一致：核查→源、对照→目标） */
const PAIR_COLUMNS: ResultColumn[] = [
  { key: 'networkType', label: '制式', defaultWidth: 70 },
  { key: 'aSiteId', label: '源基站ID', defaultWidth: 110 },
  { key: 'aSiteName', label: '源基站名称', defaultWidth: 150 },
  { key: 'aSectorId', label: '源小区ID', defaultWidth: 90 },
  { key: 'aSectorName', label: '源小区名称', defaultWidth: 170 },
  { key: 'aPci', label: '源小区PCI', defaultWidth: 80 },
  { key: 'aFrequency', label: '源小区频点', defaultWidth: 90 },
  { key: 'aVendor', label: '源小区厂家', defaultWidth: 100 },
  { key: 'aCoverageType', label: '源小区覆盖类型', defaultWidth: 100 },
  { key: 'aMod', label: '源小区模值', defaultWidth: 80 },
  { key: 'bSiteId', label: '目标1-基站ID', defaultWidth: 110 },
  { key: 'bSiteName', label: '目标1-基站名称', defaultWidth: 150 },
  { key: 'bSectorId', label: '目标1-小区ID', defaultWidth: 90 },
  { key: 'bSectorName', label: '目标1-小区名称', defaultWidth: 170 },
  { key: 'bPci', label: '目标1-小区PCI', defaultWidth: 80 },
  { key: 'bFrequency', label: '目标1-小区频点', defaultWidth: 90 },
  { key: 'bVendor', label: '目标1-小区厂家', defaultWidth: 100 },
  { key: 'bCoverageType', label: '目标1-小区覆盖类型', defaultWidth: 100 },
  { key: 'bMod', label: '目标1-小区模值', defaultWidth: 80 },
  { key: 'distanceM', label: '源小区与目标1-小区距离(米)', defaultWidth: 90 },
]

/** 复用/冲突/混淆：CGI 与 PCI 合并，不展示模值与方位角 */
const CGI_PCI_COLUMNS: ResultColumn[] = [
  { key: 'networkType', label: '制式', defaultWidth: 70 },
  { key: 'aCgi', label: '检查CGI', defaultWidth: 110 },
  { key: 'aSiteName', label: '源基站名称', defaultWidth: 150 },
  { key: 'aSectorName', label: '源小区名称', defaultWidth: 170 },
  { key: 'aFrequency', label: '源小区频点', defaultWidth: 90 },
  { key: 'aVendor', label: '源小区厂家', defaultWidth: 100 },
  { key: 'aCoverageType', label: '源小区覆盖类型', defaultWidth: 100 },
  { key: 'bCgi', label: '目标1-CGI', defaultWidth: 110 },
  { key: 'bSiteName', label: '目标1-基站名称', defaultWidth: 150 },
  { key: 'bSectorName', label: '目标1-小区名称', defaultWidth: 170 },
  { key: 'bFrequency', label: '目标1-小区频点', defaultWidth: 90 },
  { key: 'bVendor', label: '目标1-小区厂家', defaultWidth: 100 },
  { key: 'bCoverageType', label: '目标1-小区覆盖类型', defaultWidth: 100 },
  { key: 'pci', label: '目标1-PCI', defaultWidth: 80 },
  { key: 'distanceM', label: '源小区与目标1-小区距离(米)', defaultWidth: 90 },
]

/** 同站模3/对打模3：只合并 CGI，保留 PCI、模值与方位角 */
const MOD_COLUMNS: ResultColumn[] = [
  { key: 'networkType', label: '制式', defaultWidth: 70 },
  { key: 'aCgi', label: '检查CGI', defaultWidth: 110 },
  { key: 'aSiteName', label: '源基站名称', defaultWidth: 150 },
  { key: 'aSectorName', label: '源小区名称', defaultWidth: 170 },
  { key: 'aPci', label: '源小区PCI', defaultWidth: 80 },
  { key: 'aFrequency', label: '源小区频点', defaultWidth: 90 },
  { key: 'aVendor', label: '源小区厂家', defaultWidth: 100 },
  { key: 'aCoverageType', label: '源小区覆盖类型', defaultWidth: 100 },
  { key: 'aMod', label: '源小区模值', defaultWidth: 80 },
  { key: 'bCgi', label: '目标1-CGI', defaultWidth: 110 },
  { key: 'bSiteName', label: '目标1-基站名称', defaultWidth: 150 },
  { key: 'bSectorName', label: '目标1-小区名称', defaultWidth: 170 },
  { key: 'bPci', label: '目标1-小区PCI', defaultWidth: 80 },
  { key: 'bFrequency', label: '目标1-小区频点', defaultWidth: 90 },
  { key: 'bVendor', label: '目标1-小区厂家', defaultWidth: 100 },
  { key: 'bCoverageType', label: '目标1-小区覆盖类型', defaultWidth: 100 },
  { key: 'bMod', label: '目标1-小区模值', defaultWidth: 80 },
  { key: 'distanceM', label: '源小区与目标1-小区距离(米)', defaultWidth: 90 },
]

/** 混淆类别的第二个同PCI邻小区列（与导出列口径一致） */
const CONFUSION_EXTRA_COLUMNS: ResultColumn[] = [
  { key: 'cCgi', label: '目标2-小区CGI', defaultWidth: 110 },
  { key: 'cSiteName', label: '目标2-小区基站名称', defaultWidth: 150 },
  { key: 'cSectorName', label: '目标2-小区名称', defaultWidth: 170 },
  { key: 'cPci', label: '目标2-小区PCI', defaultWidth: 90 },
  { key: 'cFrequency', label: '目标2-小区频点', defaultWidth: 90 },
  { key: 'cVendor', label: '目标2-小区厂家', defaultWidth: 100 },
  { key: 'cCoverageType', label: '目标2-小区覆盖类型', defaultWidth: 110 },
  { key: 'aToCDistanceM', label: '源小区与目标2-小区距离(米)', defaultWidth: 140 },
  { key: 'bToCDistanceM', label: '两个同PCI邻小区距离(米)', defaultWidth: 130 },
]

const REASON_COLUMN: ResultColumn = { key: 'reason', label: '问题描述', defaultWidth: 320 }

export function columnsForCheckType(checkType: CheckTypeKey): ResultColumn[] {
  // 类别已由上方页签标明，表内不再重复一列
  if (checkType === 'reuse_distance' || checkType === 'collision' || checkType === 'confusion') {
    const columns = checkType === 'confusion'
      ? [...CGI_PCI_COLUMNS, ...CONFUSION_EXTRA_COLUMNS]
      : CGI_PCI_COLUMNS
    return [...columns, REASON_COLUMN]
  }
  if (checkType === 'mod3_same_site' || checkType === 'mod3_facing') {
    return [...MOD_COLUMNS, REASON_COLUMN]
  }
  return [...PAIR_COLUMNS, REASON_COLUMN]
}

interface PCICheckResultTableProps {
  /** 当前类别的核查结果行 */
  rows: any[]
  checkType: CheckTypeKey
  exportState: 'idle' | 'exporting' | 'success'
  onExportAll: () => void
  onExportCsv: () => void
}

export function PCICheckResultTable({
  rows, checkType, exportState, onExportAll, onExportCsv
}: PCICheckResultTableProps) {
  const { t } = useTranslation()
  const columns = useMemo(() => columnsForCheckType(checkType), [checkType])
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)

  const [searchEnabled, setSearchEnabled] = useState(false)
  const [searchFilters, setSearchFilters] = useState<Record<string, string>>({})
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    () => Object.fromEntries(columns.map(col => [col.key, col.defaultWidth]))
  )
  const [resizingColumn, setResizingColumn] = useState<string | null>(null)
  const resizingStartX = useRef(0)
  const resizingStartWidth = useRef(0)
  const [scrollTop, setScrollTop] = useState(0)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  // 切换类别时重置筛选与列宽，避免残留上一类别的搜索词
  useEffect(() => {
    setSearchFilters({})
    setScrollTop(0)
    if (tableContainerRef.current) tableContainerRef.current.scrollTop = 0
    setColumnWidths(Object.fromEntries(columns.map(col => [col.key, col.defaultWidth])))
  }, [checkType, columns])

  useEffect(() => {
    if (!exportMenuOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setExportMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [exportMenuOpen])

  const columnLabel = (column: ResultColumn) => {
    const label = t(`pciCheck.column.${column.key}`) || column.label
    if (checkType === 'confusion') return label
    // 非混淆表格不区分目标1/目标2，统一显示“目标”
    return label.replace('目标1-', '目标').replace('Target1 ', 'Target ')
  }

  const filteredRows = useMemo(() => {
    const active = Object.entries(searchFilters).filter(([, value]) => value.trim())
    if (!searchEnabled || active.length === 0) return rows
    return rows.filter(row =>
      active.every(([key, value]) =>
        String(row[key] ?? '').toLowerCase().includes(value.trim().toLowerCase())
      )
    )
  }, [rows, searchFilters, searchEnabled])

  const virtualData = useMemo(() => {
    const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_COUNT)
    const endIndex = Math.min(
      filteredRows.length,
      Math.ceil((scrollTop + VISIBLE_COUNT * ITEM_HEIGHT) / ITEM_HEIGHT) + BUFFER_COUNT
    )
    return {
      startIndex,
      visibleData: filteredRows.slice(startIndex, endIndex),
      totalHeight: filteredRows.length * ITEM_HEIGHT,
      offsetY: startIndex * ITEM_HEIGHT
    }
  }, [scrollTop, filteredRows])

  const handleResizeStart = useCallback((columnKey: string, startX: number) => {
    setResizingColumn(columnKey)
    resizingStartX.current = startX
    resizingStartWidth.current = columnWidths[columnKey]
    document.body.classList.add('resizing-column')
  }, [columnWidths])

  useEffect(() => {
    if (!resizingColumn) return
    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(50, resizingStartWidth.current + (e.clientX - resizingStartX.current))
      setColumnWidths(prev => ({ ...prev, [resizingColumn]: newWidth }))
    }
    const handleMouseUp = () => {
      setResizingColumn(null)
      document.body.classList.remove('resizing-column')
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [resizingColumn])

  const renderCell = (row: any, key: string) => {
    const value = row[key]
    if (key === 'networkType') {
      return (
        <span className={`px-1.5 py-0.5 rounded text-[10px] ${value === 'LTE' ? 'bg-blue-500/10 text-blue-600' : 'bg-purple-500/10 text-purple-600'}`}>
          {value || '-'}
        </span>
      )
    }
    if (key === 'aCgi' || key === 'bCgi') {
      // 历史任务结果没有合并字段，按基站ID-小区ID回退
      const prefix = key.charAt(0)
      const cgi = value || (row[`${prefix}SiteId`] != null && row[`${prefix}SectorId`] != null
        ? `${row[`${prefix}SiteId`]}-${row[`${prefix}SectorId`]}`
        : null)
      return cgi ?? '-'
    }
    if (key === 'cCgi') {
      const cgi = value || (row.cSiteId != null && row.cSectorId != null ? `${row.cSiteId}-${row.cSectorId}` : null)
      return cgi ?? '-'
    }
    if (key === 'pci') {
      // PCI 列只展示目标1小区 PCI；历史任务结果没有新字段时回退 bPci
      const targetPci = row.bPci ?? value
      return targetPci == null || targetPci === '' ? '-' : String(targetPci)
    }
    if (key.endsWith('distanceM')) {
      return value == null ? '-' : Number(value).toFixed(1)
    }
    if (key === 'reason') {
      return <span title={String(value ?? '')}>{value ?? '-'}</span>
    }
    return value == null || value === '' ? '-' : String(value)
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="flex items-center justify-end gap-2 mb-3 shrink-0">
        <button
          onClick={() => {
            if (searchEnabled) setSearchFilters({})
            setSearchEnabled(!searchEnabled)
          }}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors text-sm ${searchEnabled ? 'bg-blue-400 text-white hover:bg-blue-500' : 'bg-muted hover:bg-muted/80'}`}
        >
          <Search size={16} />
          {t('pciCheck.search') || '搜索'}
        </button>
        <div className="relative" ref={exportMenuRef}>
          <button
            onClick={() => setExportMenuOpen(prev => !prev)}
            disabled={exportState !== 'idle'}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-muted hover:bg-muted/80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download size={16} />
            {exportState === 'exporting'
              ? (t('pciCheck.exporting') || '导出中')
              : exportState === 'success'
                ? (t('pciCheck.exportSuccess') || '已导出')
                : (t('pciCheck.export') || '导出')}
            <ChevronDown size={14} />
          </button>
          {exportMenuOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 min-w-[140px] rounded-lg border border-border bg-background shadow-lg py-1">
              <button
                onClick={() => { setExportMenuOpen(false); onExportAll() }}
                disabled={exportState !== 'idle'}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              >
                {t('pciCheck.exportAll') || '全部导出'}
              </button>
              <button
                onClick={() => { setExportMenuOpen(false); onExportCsv() }}
                disabled={exportState !== 'idle' || rows.length === 0}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              >
                {t('pciCheck.exportCsv') || '导出当前页'}
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        ref={tableContainerRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="overflow-x-auto overflow-y-auto flex-1 min-h-0"
      >
        <table className="w-full text-xs border-collapse table-fixed">
          <thead className="sticky top-0 z-20 bg-background border-b border-border shadow-sm">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className="text-left p-2 font-medium bg-background z-20 relative group border-r border-border"
                  style={{ width: `${columnWidths[column.key]}px`, minWidth: `${columnWidths[column.key]}px` }}
                >
                  <span className="block pr-3">{columnLabel(column)}</span>
                  {searchEnabled && (
                    <input
                      type="text"
                      value={searchFilters[column.key] || ''}
                      onChange={(e) => setSearchFilters(prev => ({ ...prev, [column.key]: e.target.value }))}
                      placeholder={t('pciCheck.search') || '搜索'}
                      className="mt-1 w-full p-1 border border-border rounded text-[10px] text-foreground bg-input placeholder:text-muted-foreground"
                    />
                  )}
                  <div
                    className={`table-resize-handle ${resizingColumn === column.key ? 'resizing' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      handleResizeStart(column.key, e.clientX)
                    }}
                  >
                    <GripVertical size={12} className="opacity-0 group-hover:opacity-40 text-muted-foreground absolute right-0.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr style={{ height: `${virtualData.offsetY}px` }}>
              <td colSpan={columns.length}></td>
            </tr>
            {virtualData.visibleData.map((row, index) => (
              <tr
                key={`${row.aSectorId}-${row.bSectorId}-${virtualData.startIndex + index}`}
                className="border-b hover:bg-muted/50"
                style={{ height: `${ITEM_HEIGHT}px` }}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className="p-2 border-r border-border truncate"
                    style={{
                      width: `${columnWidths[column.key]}px`,
                      minWidth: `${columnWidths[column.key]}px`,
                      maxWidth: `${columnWidths[column.key]}px`
                    }}
                    title={column.key.endsWith('Name') || column.key === 'reason' ? String(row[column.key] ?? '') : undefined}
                  >
                    {renderCell(row, column.key)}
                  </td>
                ))}
              </tr>
            ))}
            <tr style={{ height: `${virtualData.totalHeight - virtualData.offsetY - virtualData.visibleData.length * ITEM_HEIGHT}px` }}>
              <td colSpan={columns.length}></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
