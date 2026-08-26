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
}

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
  /** 加载状态 */
  loading?: boolean
  /** 列标题文本（可选，用于国际化） */
  columnLabels?: {
    siteId: string
    cellId: string
    cellName: string
    cellFreq: string
    cellPci: string
    selectAll: string
    clearSelections: string
    uploadCellFile?: string
    downloadCellTemplate?: string
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
  const [scrollTop, setScrollTop] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // 搜索过滤
  const filtered = useMemo(() => {
    if (!searchValue) return sectors
    const q = searchValue.toLowerCase()
    return sectors.filter(s =>
      (s.siteId || '').toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      (s.name || '').toLowerCase().includes(q)
    )
  }, [sectors, searchValue])

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
  }, [searchValue])

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  const colLabels = columnLabels ?? {
    siteId: '基站ID',
    cellId: '小区ID',
    cellName: '小区名称',
    cellFreq: '频点',
    cellPci: 'PCI',
    selectAll: '全选',
    clearSelections: '清空选择'
  }

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


      {/* 表格区域 */}
      {filtered.length === 0 ? (
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
                <div className="p-2 bg-muted flex-1 min-w-0">{colLabels.cellName}</div>
              </div>
            </div>

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
                      ? 'bg-blue-50/50'
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
                    className="p-2 truncate flex-1 min-w-0"
                    title={sector.name}
                    style={{ lineHeight: `${ITEM_HEIGHT - 16}px` }}
                  >
                    {sector.name}
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
