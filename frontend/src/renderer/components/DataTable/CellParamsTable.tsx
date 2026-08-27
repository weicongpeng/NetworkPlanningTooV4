import { useTranslation } from 'react-i18next'
import type { CellRow } from '@shared/types'

// 输入过滤（纯函数）：与新站录入行为一致
const filterDigits = (v: string) => v.replace(/\D/g, '')
const filterNumeric = (v: string) => v.replace(/[^\d.-]/g, '')

export interface CellParamsTableProps {
  /** 当前面板的行数据 */
  rows: CellRow[]
  activeTab: 'LTE' | 'NR'
  /** 列宽表（含拖拽调整后的值） */
  colWidths: Record<string, number>
  /** 列宽拖拽起始（父层 window 级监听实现） */
  onColResize: (e: React.MouseEvent, colKey: string) => void
  /** 通用字段变更（本组件已应用输入过滤，父层直接写入） */
  onFieldChange: (rowId: string, field: string, value: string | number) => void
  /** 方向角变更（父层做 0-360 校验） */
  onAzimuthChange: (rowId: string, value: string) => void
  /** 全局禁用（无全量工参/录入中） */
  disabled: boolean
  /** 翻译函数（可选，缺省用组件内 useTranslation） */
  t?: (key: string, opts?: any) => string
  // ---- 新站录入模式：复选框选择 + 立即删行 ----
  selectedRowIds?: Set<string>
  onToggleSelect?: (rowId: string) => void
  allSelected?: boolean
  onToggleSelectAll?: () => void
  onDeleteRow?: (rowId: string) => void
  /** 新站录入：行数 <= 1 时禁止删除 */
  deleteDisabled?: boolean
  /** 行完整校验（用于行复选框禁用），缺省视为完整 */
  isRowComplete?: (row: CellRow, nt: 'LTE' | 'NR') => boolean
  // ---- 查询/更新模式：删除标记 ----
  /** 已标记删除的行 id 集合（灰化 + 删除线） */
  deleteMarkedIds?: Set<string>
  onToggleDeleteMark?: (rowId: string) => void
  /** 查询/更新模式：隐藏复选框列 */
  hideCheckbox?: boolean
  // ---- 其他 ----
  /** 重复行标记（same=红 / cross=黄），键为 siteId_cellId */
  duplicateMap?: Record<string, 'same' | 'cross'>
  /** 展开态（输入框放大） */
  expanded?: boolean
}

export function CellParamsTable({
  rows,
  activeTab,
  colWidths,
  onColResize,
  onFieldChange,
  onAzimuthChange,
  disabled,
  t: propT,
  selectedRowIds,
  onToggleSelect,
  allSelected,
  onToggleSelectAll,
  onDeleteRow,
  deleteDisabled,
  isRowComplete,
  deleteMarkedIds,
  onToggleDeleteMark,
  hideCheckbox,
  duplicateMap,
  expanded,
}: CellParamsTableProps) {
  const { t: i18nT } = useTranslation()
  const t = propT ?? i18nT
  const isLte = activeTab === 'LTE'
  const labelCls = 'text-xs text-muted-foreground text-center leading-tight px-0.5 whitespace-nowrap'
  const inputCls = 'w-full min-w-[40px] px-1.5 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed'
  const inputClsExp = 'w-full min-w-[40px] px-2 py-1.5 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed'
  const curInputCls = expanded ? inputClsExp : inputCls

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          {!hideCheckbox && (
            <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 w-0'}>
              <input
                type="checkbox"
                checked={!!allSelected}
                onChange={onToggleSelectAll}
                disabled={disabled}
                className="cursor-pointer"
              />
            </th>
          )}
          <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 w-0'}>{/* 操作列 */}</th>
          <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 relative'} style={{ width: colWidths.managedElementId }}>
            {t('newCellEntry.fieldManagedElementId') || '网元ID'}
            <div className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/60" onMouseDown={e => onColResize(e, 'managedElementId')} />
          </th>
          <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 relative'} style={{ width: colWidths.siteId }}>
            {t('newCellEntry.fieldSiteIdLTE') || '基站ID'}
            <div className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/60" onMouseDown={e => onColResize(e, 'siteId')} />
          </th>
          <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 relative'} style={{ width: colWidths.cellId }}>
            {t('newCellEntry.fieldCellId') || '小区ID'}
            <div className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/60" onMouseDown={e => onColResize(e, 'cellId')} />
          </th>
          <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 relative'} style={{ width: colWidths.cellName }}>
            {t('newCellEntry.fieldCellName') || '小区名称'}
            <div className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/60" onMouseDown={e => onColResize(e, 'cellName')} />
          </th>
          <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 relative'} style={{ width: colWidths.mcc }}>
            {t('newCellEntry.fieldMCC') || 'MCC'}
            <div className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/60" onMouseDown={e => onColResize(e, 'mcc')} />
          </th>
          <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 relative'} style={{ width: colWidths.mnc }}>
            {t('newCellEntry.fieldMNC') || 'MNC'}
            <div className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/60" onMouseDown={e => onColResize(e, 'mnc')} />
          </th>
          <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 relative'} style={{ width: colWidths.longitude }}>
            {t('newCellEntry.fieldLongitude') || '经度'}
            <div className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/60" onMouseDown={e => onColResize(e, 'longitude')} />
          </th>
          <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 relative'} style={{ width: colWidths.latitude }}>
            {t('newCellEntry.fieldLatitude') || '纬度'}
            <div className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/60" onMouseDown={e => onColResize(e, 'latitude')} />
          </th>
          <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 relative'} style={{ width: colWidths.azimuth }}>
            {t('newCellEntry.fieldAzimuth') || '方向角'}
            <div className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/60" onMouseDown={e => onColResize(e, 'azimuth')} />
          </th>
          <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 relative'} style={{ width: isLte ? colWidths.frequency : colWidths.ssbFrequency }}>
            {isLte ? (t('newCellEntry.fieldFrequency') || '下行频点') : (t('newCellEntry.fieldSsbFrequency') || 'SSB频点')}
            <div className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/60" onMouseDown={e => onColResize(e, isLte ? 'frequency' : 'ssbFrequency')} />
          </th>
          <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 relative'} style={{ width: colWidths.cellCoverType }}>
            {t('newCellEntry.fieldCellCoverType') || '覆盖类型'}
            <div className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/60" onMouseDown={e => onColResize(e, 'cellCoverType')} />
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const complete = isRowComplete ? isRowComplete(row, activeTab) : true
          const isMarked = deleteMarkedIds?.has(row.id) ?? false
          return (
            <tr key={row.id} data-row-id={row.id} className={`${selectedRowIds?.has(row.id) ? 'bg-blue-50/50' : ''} ${
              duplicateMap?.[`${row.siteId}_${row.cellId}`] === 'same' ? 'bg-red-50' :
              duplicateMap?.[`${row.siteId}_${row.cellId}`] === 'cross' ? 'bg-amber-50' : ''
            } ${isMarked ? 'opacity-40 line-through' : ''}`}>
              {!hideCheckbox && (
                <td className="border border-border px-1 py-1 text-center">
                  <input
                    type="checkbox"
                    checked={selectedRowIds?.has(row.id) ?? false}
                    onChange={() => onToggleSelect?.(row.id)}
                    disabled={!complete || disabled}
                    className="cursor-pointer"
                  />
                </td>
              )}
              <td className="border border-border px-1 py-1 text-center">
                <button
                  onClick={() => onToggleDeleteMark ? onToggleDeleteMark(row.id) : onDeleteRow?.(row.id)}
                  disabled={disabled || (!onToggleDeleteMark && !!deleteDisabled)}
                  className="text-muted-foreground hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title={t('newCellEntry.deleteRow') || '删除'}
                >
                  <span className="text-xs">✕</span>
                </button>
              </td>
              <td className="border border-border px-1 py-1">
                <input className={curInputCls} data-field="managedElementId" type="text" inputMode="numeric" value={row.managedElementId} onChange={e => onFieldChange(row.id, 'managedElementId', filterDigits(e.target.value))} disabled={disabled} placeholder="" />
              </td>
              <td className="border border-border px-1 py-1">
                <input className={curInputCls} data-field="siteId" type="text" inputMode="numeric" value={row.siteId} onChange={e => onFieldChange(row.id, 'siteId', filterDigits(e.target.value))} disabled={disabled} placeholder="" />
              </td>
              <td className="border border-border px-1 py-1">
                <input className={curInputCls} data-field="cellId" type="text" inputMode="numeric" value={row.cellId} onChange={e => onFieldChange(row.id, 'cellId', filterDigits(e.target.value))} disabled={disabled} placeholder="" />
              </td>
              <td className="border border-border px-1 py-1">
                <input className={curInputCls} data-field="cellName" value={row.cellName} onChange={e => onFieldChange(row.id, 'cellName', e.target.value)} disabled={disabled} placeholder="" />
              </td>
              <td className="border border-border px-1 py-1">
                <input className={curInputCls} data-field="mcc" type="text" inputMode="numeric" value={row.mcc} onChange={e => onFieldChange(row.id, 'mcc', filterDigits(e.target.value))} disabled={disabled} placeholder="460" />
              </td>
              <td className="border border-border px-1 py-1">
                <select
                  className={curInputCls}
                  data-field="mnc"
                  value={row.mnc}
                  onChange={e => onFieldChange(row.id, 'mnc', e.target.value)}
                  disabled={disabled}
                >
                  <option value="11">11</option>
                  <option value="01">01</option>
                  <option value="00">00</option>
                </select>
              </td>
              <td className="border border-border px-1 py-1">
                <input className={curInputCls} data-field="longitude" type="text" inputMode="decimal" value={row.longitude} onChange={e => onFieldChange(row.id, 'longitude', filterNumeric(e.target.value))} disabled={disabled} placeholder="114.0" />
              </td>
              <td className="border border-border px-1 py-1">
                <input className={curInputCls} data-field="latitude" type="text" inputMode="decimal" value={row.latitude} onChange={e => onFieldChange(row.id, 'latitude', filterNumeric(e.target.value))} disabled={disabled} placeholder="23.0" />
              </td>
              <td className="border border-border px-1 py-1">
                <input className={curInputCls} data-field="azimuth" type="text" inputMode="numeric" value={row.azimuth} onChange={e => onAzimuthChange(row.id, e.target.value)} disabled={disabled} placeholder="0-360" />
              </td>
              <td className="border border-border px-1 py-1">
                {isLte ? (
                  <input className={curInputCls} data-field="frequency" type="text" inputMode="decimal" value={row.frequency} onChange={e => onFieldChange(row.id, 'frequency', filterNumeric(e.target.value))} disabled={disabled} placeholder="" />
                ) : (
                  <input className={curInputCls} data-field="ssbFrequency" type="text" inputMode="decimal" value={row.ssbFrequency} onChange={e => onFieldChange(row.id, 'ssbFrequency', filterNumeric(e.target.value))} disabled={disabled} placeholder="" />
                )}
              </td>
              <td className="border border-border px-1 py-1">
                <select
                  className={curInputCls}
                  data-field="cellCoverType"
                  value={row.cellCoverType}
                  onChange={e => onFieldChange(row.id, 'cellCoverType', parseInt(e.target.value))}
                  disabled={disabled}
                >
                  <option value={1}>{t('newCellEntry.cellCoverTypeOutdoor') || '室外站'}</option>
                  <option value={4}>{t('newCellEntry.cellCoverTypeIndoor') || '室分站'}</option>
                </select>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
