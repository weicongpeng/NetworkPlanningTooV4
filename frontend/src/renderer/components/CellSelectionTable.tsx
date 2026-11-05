/**
 * CellSelectionTable - 小区选择表格（虚拟滚动版）
 *
 * 优势：
 * - 仅渲染可视区域内的行（约25行+5行缓冲），而非全量渲染
 * - 支持搜索过滤、全选/取消全选
 * - 统一的样式和交互，与规划结果表格风格一致
 */

import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { Search, Loader2, Check, Upload, Download, Play } from 'lucide-react'
import { btn } from '../utils/buttonStyles'

const ITEM_HEIGHT = 40
const OVERSCAN = 5

export interface CellSector {
  id: string
  siteId?: string
  name?: string
  frequency?: number
  pci?: number
  longitude?: number | null
  latitude?: number | null
}

/** 列过滤字段 → 取值文本（大小写不敏感的模糊匹配基础） */
const COLUMN_ACCESSORS: Record<string, (sector: CellSector) => string> = {
  siteId: s => s.siteId ?? '',
  cellId: s => s.id,
  cellFreq: s => s.frequency == null ? '' : String(s.frequency),
  cellPci: s => s.pci == null ? '' : String(s.pci),
  cellName: s => s.name ?? '',
  cellLng: s => s.longitude == null ? '' : String(s.longitude),
  cellLat: s => s.latitude == null ? '' : String(s.latitude),
}

/** 表头下方过滤行的列顺序与宽度，与表头保持一致 */
const FILTER_COLUMNS: Array<{ key: string; width: string; fallbackLabel: string }> = [
  { key: 'siteId', width: 'w-[80px] shrink-0', fallbackLabel: '基站ID' },
  { key: 'cellId', width: 'w-[80px] shrink-0', fallbackLabel: '小区ID' },
  { key: 'cellFreq', width: 'w-[90px] shrink-0', fallbackLabel: '频点' },
  { key: 'cellPci', width: 'w-[70px] shrink-0', fallbackLabel: 'PCI' },
  { key: 'cellName', width: 'flex-1 min-w-0', fallbackLabel: '小区名称' },
  { key: 'cellLng', width: 'w-[95px] shrink-0', fallbackLabel: '经度' },
  { key: 'cellLat', width: 'w-[85px] shrink-0', fallbackLabel: '纬度' },
]

export interface CellSelectionTableProps {
  /** 当前网络类型的小区列表 */
  sectors: CellSector[]
  /** 已选中小区ID的Set */
  selectedCellIds: Set<string>
  /** 切换小区选中状态 */
  onToggleCell: (cellId: string) => void
  /** 全选回调（传入当前搜索过滤后的小区ID列表） */
  onSelectAll: (filteredIds: string[]) => void
  /** 清空选择回调 */
  onClearSelections: () => void
  /** 选中数量展示文本（可选） */
  selectedCountText?: string
  /** 搜索框占位文本（可选） */
  searchPlaceholder?: string
  /** 是否启用「搜索」按钮 + 表头下方按列模糊过滤（默认关闭，保持其他页面原样） */
  enableColumnSearch?: boolean
  /** 加载状态 */
  loading?: boolean
  /** 列标题文本（可选，用于国际化） */
  columnLabels?: {
    siteId: string
    cellId: string
    cellName: string
    cellFreq: string
    cellPci: string
    cellLng?: string
    cellLat?: string
    selectAll: string
    clearSelections: string
    uploadCellFile?: string
    downloadCellTemplate?: string
    search?: string
  }
  /** 上传待规划小区文件回调 */
  onUploadCellFile?: () => void
  /** 下载待规划小区模板回调 */
  onDownloadCellTemplate?: () => void
  /** 上传中状态 */
  uploading?: boolean
  /** 执行按钮回调 */
  onExecute?: () => void
  /** 执行按钮标签 */
  executeLabel?: string
  /** 执行按钮是否禁用 */
  executeDisabled?: boolean
  /** 任务是否正在执行中 */
  isExecuting?: boolean
  /** 执行进度 (0-100) */
  executionProgress?: number
  /** 禁用交互（执行中禁止勾选操作） */
  disabled?: boolean
}

export const CellSelectionTable = ({
  sectors,
  selectedCellIds,
  onToggleCell,
  onSelectAll,
  onClearSelections: _onClearSelections,
  selectedCountText,
  searchPlaceholder = '搜索基站ID、小区ID或名称...',
  enableColumnSearch = false,
  loading = false,
  columnLabels,
  onUploadCellFile,
  onDownloadCellTemplate,
  uploading = false,
  onExecute,
  executeLabel = '执行',
  executeDisabled = true,
  isExecuting = false,
  executionProgress = 0,
  disabled = false,
}: CellSelectionTableProps) => {
  const [searchValue, setSearchValue] = useState('')
  const [columnSearchEnabled, setColumnSearchEnabled] = useState(false)
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({})
  const [scrollTop, setScrollTop] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // 搜索过滤：全局关键字 + 按列模糊匹配
  const filtered = useMemo(() => {
    const globalQuery = searchValue.toLowerCase()
    const activeColumns = Object.entries(columnFilters).filter(([, value]) => value.trim())
    if (!globalQuery && activeColumns.length === 0) return sectors
    return sectors.filter(s => {
      if (globalQuery && !(
        (s.siteId || '').toLowerCase().includes(globalQuery) ||
        s.id.toLowerCase().includes(globalQuery) ||
        (s.name || '').toLowerCase().includes(globalQuery)
      )) return false
      return activeColumns.every(([key, value]) =>
        COLUMN_ACCESSORS[key](s).toLowerCase().includes(value.trim().toLowerCase())
      )
    })
  }, [sectors, searchValue, columnFilters])

  // 虚拟滚动计算 —— 当过滤后结果能完全显示时，直接渲染全部（无需滚动）
  const { visibleData, totalHeight, offsetY } = useMemo(() => {
    if (filtered.length === 0) return { visibleData: [] as CellSector[], totalHeight: 0, offsetY: 0 }
    const containerHeight = containerRef.current?.clientHeight || 600
    const totalH = filtered.length * ITEM_HEIGHT
    // 内容高度 ≤ 容器高度：渲染全部，无需虚拟滚动
    if (totalH <= containerHeight) {
      return { visibleData: filtered, totalHeight: totalH, offsetY: 0 }
    }
    const startIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN)
    const endIdx = Math.min(
      filtered.length,
      Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + OVERSCAN
    )
    return {
      visibleData: filtered.slice(startIdx, endIdx),
      totalHeight: totalH,
      offsetY: startIdx * ITEM_HEIGHT
    }
  }, [filtered, scrollTop])

  // 搜索时重置滚动位置
  useEffect(() => {
    setScrollTop(0)
    if (containerRef.current) containerRef.current.scrollTop = 0
  }, [searchValue, columnFilters])

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  const colLabels = columnLabels ?? {
    siteId: '基站ID',
    cellId: '小区ID',
    cellName: '小区名称',
    cellFreq: '频点',
    cellPci: 'PCI',
    cellLng: '经度',
    cellLat: '纬度',
    selectAll: '全选',
    clearSelections: '清空选择'
  }

  // 经纬度格式化：6 位小数，无效值显示 '-'
  const formatCoord = (v?: number | null) =>
    v != null && isFinite(v) ? v.toFixed(6) : '-'

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <Loader2 className="animate-spin" size={24} />
        <span className="ml-2 text-sm">加载中...</span>
      </div>
    )
  }

  // 判断当前搜索过滤后的小区是否都已选中
  const allSelected = filtered.length > 0 && filtered.every(s => selectedCellIds.has(s.id))
  const someSelected = filtered.some(s => selectedCellIds.has(s.id))
  const noneSelected = !someSelected

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 操作栏：搜索 + 选中计数 */}
      <div className="flex items-center gap-2 mb-2 shrink-0">
        <div className="relative flex-1 min-w-0">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={searchValue}
            onChange={e => setSearchValue(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full pl-7 pr-3 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary"
          />
        </div>
        {enableColumnSearch && (
          <button
            onClick={() => {
              if (columnSearchEnabled) setColumnFilters({})
              setColumnSearchEnabled(prev => !prev)
            }}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs transition-colors shrink-0 ${
              columnSearchEnabled ? 'bg-blue-400 text-white hover:bg-blue-500' : 'bg-card border border-border hover:bg-muted/80'
            }`}
            title={columnLabels?.search || '搜索'}
          >
            <Search size={14} />
            {columnLabels?.search || '搜索'}
          </button>
        )}
        {onUploadCellFile && (
          <button
            onClick={onUploadCellFile}
            disabled={uploading || disabled}
            className="p-1.5 text-xs bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            title={columnLabels?.uploadCellFile || '上传待规划小区文件'}
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          </button>
        )}
        {onDownloadCellTemplate && (
          <button
            onClick={onDownloadCellTemplate}
            disabled={disabled}
            className="p-1.5 text-xs bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            title={columnLabels?.downloadCellTemplate || '下载待规划小区模板'}
          >
            <Download size={14} />
          </button>
        )}
        <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
          {selectedCountText ?? `已选中 ${selectedCellIds.size} 个小区`}
        </span>

        {/* 执行按钮 */}
        {onExecute && (
          <button
            onClick={onExecute}
            disabled={executeDisabled || isExecuting}
            className={`${btn.primary} ${isExecuting ? 'btn-task-executing' : ''} shrink-0`}
          >
            {isExecuting ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>{executeLabel} ({executionProgress}%)</span>
              </>
            ) : (
              <>
                <Play size={16} />
                <span>{executeLabel}</span>
              </>
            )}
          </button>
        )}
      </div>


      {/* 表格区域：无数据才整块占位，过滤无命中时保留表头与过滤行以便修改关键字 */}
      {sectors.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <p>暂无小区数据</p>
        </div>
      ) : (
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="overflow-y-auto overflow-x-hidden rounded-lg border border-border flex-1 min-h-0"
        >
          <div
            className="relative w-full"
            style={{ height: totalHeight, minHeight: '100%' }}
          >
            {/* 固定表头，使用 sticky 定位 */}
            <div className="sticky top-0 z-10 bg-background border-b border-border shadow-sm">
              <div className="flex text-[10px] font-medium">
                <div className="p-2 bg-muted border-r border-border w-10 shrink-0 flex items-center justify-center">
                  <button
                    onClick={() => !disabled && onSelectAll(filtered.map(s => s.id))}
                    disabled={disabled}
                    className="w-4 h-4 rounded-sm border flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      borderColor: noneSelected ? 'hsl(var(--muted-foreground))' : '#3b82f6',
                      backgroundColor: noneSelected ? 'transparent' : '#3b82f6',
                    }}
                  >
                    {allSelected && (
                      <Check size={12} className="text-white" />
                    )}
                    {someSelected && !allSelected && (
                      <div className="w-[6px] h-[6px] bg-white rounded-[1px]" />
                    )}
                  </button>
                </div>
                <div className="p-2 bg-muted border-r border-border w-[80px] shrink-0">{colLabels.siteId}</div>
                <div className="p-2 bg-muted border-r border-border w-[80px] shrink-0">{colLabels.cellId}</div>
                <div className="p-2 bg-muted border-r border-border w-[90px] shrink-0">{colLabels.cellFreq}</div>
                <div className="p-2 bg-muted border-r border-border w-[70px] shrink-0">{colLabels.cellPci}</div>
                <div className="p-2 bg-muted border-r border-border flex-1 min-w-0">{colLabels.cellName}</div>
                <div className="p-2 bg-muted border-r border-border w-[95px] shrink-0">{colLabels.cellLng ?? '经度'}</div>
                <div className="p-2 bg-muted w-[85px] shrink-0">{colLabels.cellLat ?? '纬度'}</div>
              </div>
              {enableColumnSearch && columnSearchEnabled && (
                <div className="flex text-[10px]">
                  <div className="p-1 bg-card border-t border-r border-border w-10 shrink-0" />
                  {FILTER_COLUMNS.map((column) => (
                    <div key={column.key} className={`p-1 bg-card border-t border-r border-border ${column.width}`}>
                      <input
                        type="text"
                        value={columnFilters[column.key] || ''}
                        onChange={e => setColumnFilters(prev => ({ ...prev, [column.key]: e.target.value }))}
                        aria-label={`${column.fallbackLabel}筛选`}
                        className="w-full px-1 py-0.5 border border-border rounded text-[10px] text-foreground bg-input focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 过滤无命中提示（表头保留可继续改关键字） */}
            {filtered.length === 0 && (
              <div className="p-4 text-center text-xs text-muted-foreground">无匹配小区</div>
            )}

            {/* 虚拟滚动内容 */}
            <div
              className="w-full"
              style={{ transform: `translateY(${offsetY}px)` }}
            >
              {visibleData.map(sector => (
                <div
                  key={sector.id}
                  onClick={() => !disabled && onToggleCell(sector.id)}
                  className={`flex transition-colors text-xs border-b border-border ${
                    disabled ? 'cursor-not-allowed' : 'cursor-pointer'
                  } ${
                    selectedCellIds.has(sector.id)
                      ? 'bg-blue-500/10'
                      : disabled ? 'bg-card' : 'bg-card hover:bg-muted/50'
                  }`}
                  style={{ height: ITEM_HEIGHT }}
                >
                  <div className="p-2 border-r border-border w-10 shrink-0 flex items-center">
                    <div
                      className={`w-4 h-4 rounded-sm border flex items-center justify-center ${
                        selectedCellIds.has(sector.id)
                          ? 'bg-blue-500 border-blue-500'
                          : 'border-border'
                      }`}
                    >
                      {selectedCellIds.has(sector.id) && (
                        <Check size={12} className="text-white" />
                      )}
                    </div>
                  </div>
                  <div
                    className="p-2 font-mono truncate border-r border-border w-[80px] shrink-0"
                    title={sector.siteId || 'N/A'}
                    style={{ lineHeight: `${ITEM_HEIGHT - 16}px` }}
                  >
                    {sector.siteId || 'N/A'}
                  </div>
                  <div
                    className="p-2 font-mono truncate border-r border-border w-[80px] shrink-0"
                    title={sector.id.split('_').pop() || sector.id}
                    style={{ lineHeight: `${ITEM_HEIGHT - 16}px` }}
                  >
                    {sector.id.split('_').pop() || sector.id}
                  </div>
                  <div
                    className="p-2 font-mono truncate border-r border-border w-[90px] shrink-0"
                    title={sector.frequency != null ? String(sector.frequency) : '-'}
                    style={{ lineHeight: `${ITEM_HEIGHT - 16}px` }}
                  >
                    {sector.frequency != null ? sector.frequency : '-'}
                  </div>
                  <div
                    className="p-2 font-mono truncate border-r border-border w-[70px] shrink-0"
                    title={sector.pci != null ? String(sector.pci) : '-'}
                    style={{ lineHeight: `${ITEM_HEIGHT - 16}px` }}
                  >
                    {sector.pci != null ? sector.pci : '-'}
                  </div>
                  <div
                    className="p-2 truncate border-r border-border flex-1 min-w-0"
                    title={sector.name}
                    style={{ lineHeight: `${ITEM_HEIGHT - 16}px` }}
                  >
                    {sector.name}
                  </div>
                  <div
                    className="p-2 font-mono truncate border-r border-border w-[95px] shrink-0"
                    title={formatCoord(sector.longitude)}
                    style={{ lineHeight: `${ITEM_HEIGHT - 16}px` }}
                  >
                    {formatCoord(sector.longitude)}
                  </div>
                  <div
                    className="p-2 font-mono truncate w-[85px] shrink-0"
                    title={formatCoord(sector.latitude)}
                    style={{ lineHeight: `${ITEM_HEIGHT - 16}px` }}
                  >
                    {formatCoord(sector.latitude)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default CellSelectionTable
