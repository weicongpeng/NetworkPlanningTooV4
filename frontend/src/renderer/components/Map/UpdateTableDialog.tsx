/**
 * 更新表弹窗
 *
 * 给已导入的图层文件追加以图形固有属性（经纬度 / 长度 / 面积 / 周长 / 节点数 /
 * 中心点 / 坐标集），产出形式二选一或都做：
 * - 导出 Excel：原属性列 + 追加列（追加在原有数据后面）
 * - 写回图层：把追加列写进源图层文件的属性表（走现有整层保存链路，不经过 Excel）
 *
 * 计算全在前端完成：几何取图层 GeoJSON（后端已转 GCJ02），WGS84 版本在输出前换算。
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as XLSX from 'xlsx'
import { X, Table2, AlertTriangle, Check, Loader2, Download, Save } from 'lucide-react'
import { layerApi } from '../../services/api'
import { useMapDataCacheStore } from '../../store/mapDataCacheStore'
import { useLayerEditStore } from '../../store/layerEditStore'
import { invalidateLayerFieldCache, type LayerFileOption } from './LayerControl'
import {
  INTRINSIC_FIELDS,
  buildExportRows,
  applyFieldsToGeojson,
  type IntrinsicFieldKey,
} from './updateTableFields'

interface Props {
  open: boolean
  onClose: () => void
  /** 已导入的图层文件候选 */
  layerFiles: LayerFileOption[]
  /** 写回成功回调（由地图页负责失效缓存 / 重绘 / 刷新列表） */
  onSaved?: (layerId: string) => void
}

/** 取回图层的完整要素集合（优先前端缓存，否则请求后端） */
async function fetchFeatureCollection(dataId: string, layerId: string): Promise<any | null> {
  const cached = useMapDataCacheStore.getState().layers[layerId]?.geojson
  if (cached) return cached
  try {
    const resp = await layerApi.getLayerData(dataId, layerId)
    return resp?.data || null
  } catch (e) {
    console.error('[UpdateTableDialog] 获取图层数据失败:', layerId, e)
    return null
  }
}

/** 触发浏览器下载 blob */
function saveBlobAs(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

/**
 * Excel 单元格最多 32767 字符（规范硬限制）。坐标集已按列拆分，这里只给其余
 * 超长文本兜底截断，避免整表写出失败。
 */
function clampCell(v: string | number | null): string | number {
  if (typeof v !== 'string' || v.length <= 32767) return v ?? ''
  return v.slice(0, 32767)
}

function dateStamp(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

export default function UpdateTableDialog({ open, onClose, layerFiles, onSaved }: Props) {
  const { t } = useTranslation()
  const [layerKey, setLayerKey] = useState('')
  const [selected, setSelected] = useState<Set<IntrinsicFieldKey>>(new Set(INTRINSIC_FIELDS.map((d) => d.key)))
  const [busy, setBusy] = useState<'export' | 'write' | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [result, setResult] = useState<string>('')

  useEffect(() => {
    if (open) {
      setLayerKey('')
      setSelected(new Set(INTRINSIC_FIELDS.map((d) => d.key)))
      setBusy(null)
      setErrorMsg('')
      setResult('')
    }
  }, [open])

  const layer = useMemo(
    () => layerFiles.find((f) => f.id === layerKey) || null,
    [layerFiles, layerKey],
  )

  // 写回前置条件：有源文件且可编辑（TAB / SHP / GeoJSON），且当前没有未保存的编辑改动
  const writeBlockReason = useMemo(() => {
    if (!layer) return ''
    if (!layer.editable) return t('map.updateTableNotEditable') || '该图层源文件不可写回'
    if (useLayerEditStore.getState().isDirty(layer.id)) {
      return t('map.updateTableDirtyBlock') || '该图层有未保存的编辑改动，请先保存后再写回'
    }
    return ''
  }, [layer, t])

  if (!open) return null

  const toggleField = (key: IntrinsicFieldKey) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const keys = INTRINSIC_FIELDS.filter((d) => selected.has(d.key)).map((d) => d.key)

  const withFeatureCollection = async (
    action: (fc: any) => Promise<void>,
  ) => {
    if (!layer) return
    setErrorMsg('')
    setResult('')
    const fc = await fetchFeatureCollection(layer.dataId, layer.id)
    const count = Array.isArray(fc?.features) ? fc.features.length : 0
    if (!fc || count === 0) {
      setErrorMsg(t('map.updateTableNoFeatures') || '该图层没有可用的图形要素')
      return
    }
    try {
      await action(fc)
    } catch (e: any) {
      setErrorMsg(e?.response?.data?.detail || e?.message || t('map.updateTableFailed') || '更新表失败')
    }
  }

  const handleExport = async () => {
    if (!layer || keys.length === 0 || busy) return
    setBusy('export')
    await withFeatureCollection(async (fc) => {
      const built = buildExportRows(fc, keys)
      const aoa = [
        built.headers,
        ...built.rows.map((row) => built.headers.map((h) => clampCell(row[h]))),
      ]
      const sheet = XLSX.utils.aoa_to_sheet(aoa)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1')
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
      saveBlobAs(
        new Blob([buf], { type: 'application/octet-stream' }),
        `${layer.name}_更新表_${dateStamp()}.xlsx`,
      )
      const splitTip = built.splits.length > 0
        ? (t('map.updateTableSplit') || '超长坐标集已自动分列') + '：' +
          built.splits.map((s) => `${INTRINSIC_FIELDS.find((d) => d.key === s.key)?.excelHeader} → ${s.columns} 列`).join('、')
        : ''
      setResult(
        (t('map.updateTableExported', { count: built.features }) || `已导出 ${built.features} 条记录`) +
        (built.skipped > 0 ? (t('map.updateTableSkipped', { skip: built.skipped }) || `（${built.skipped} 条无图形）`) : '') +
        (splitTip ? `；${splitTip}` : ''),
      )
    })
    setBusy(null)
  }

  const handleWriteBack = async () => {
    if (!layer || writeBlockReason || busy) return
    if (!window.confirm(t('map.updateTableWriteConfirm', { name: layer.name }) || `确认把所选属性列写回图层「${layer.name}」的属性表？此操作会修改源文件。`)) return
    setBusy('write')
    await withFeatureCollection(async (fc) => {
      const { geojson, conflicts, legacyColumns, skipped } = applyFieldsToGeojson(fc, keys)
      if (legacyColumns.length > 0) {
        const tip = (t('map.updateTableDropLegacy', { names: legacyColumns.join('、') })
          || `源图层存在不带单位的历史列「${legacyColumns.join('、')}」，本次将删除这些旧列、改用带单位的新列。是否继续？`)
        if (!window.confirm(tip)) return
      }
      await layerApi.saveLayerData(layer.dataId, layer.id, {
        geojson,
        dropFields: legacyColumns,
      })
      // 属性表已改写：字段候选（标签内容/专题配色下拉）缓存必须失效，否则看不到新列
      invalidateLayerFieldCache(layer.dataId, layer.id)
      onSaved?.(layer.id)
      const skipTip = skipped > 0
        ? t('map.updateTableSkipped', { skip: skipped }) || `（${skipped} 条无图形）`
        : ''
      const conflictTip = conflicts.length > 0
        ? (t('map.updateTableConflict') || '已存在同名列被跳过') + '：' + conflicts.join('、')
        : ''
      setResult(
        (t('map.updateTableWritten', { name: layer.name }) || `已写回图层「${layer.name}」`) +
        skipTip + (conflictTip ? `；${conflictTip}` : ''),
      )
    })
    setBusy(null)
  }

  const selectCls =
    'px-2.5 py-1.5 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary w-full'

  return (
    <div
      className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/20"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-lg p-5 w-[480px] flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Table2 size={16} className="text-primary" />
            {t('map.updateTable') || '更新表'}
          </div>
          {!busy && (
            <button className="text-muted-foreground hover:text-foreground transition-colors" onClick={onClose}>
              <X size={16} />
            </button>
          )}
        </div>

        {/* 图层文件 */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground">
            {t('map.updateTableLayer') || '图层文件'}
          </label>
          <select
            value={layerKey}
            disabled={!!busy}
            onChange={(e) => { setLayerKey(e.target.value); setResult(''); setErrorMsg('') }}
            className={selectCls}
          >
            <option value="" disabled>{t('map.pleaseSelect') || '请选择'}</option>
            {(layerFiles || []).map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </div>

        {/* 追加字段勾选 */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs text-muted-foreground">
              {t('map.updateTableFields') || '追加属性字段'}
            </label>
            <span className="text-[11px] text-muted-foreground">
              {selected.size}/{INTRINSIC_FIELDS.length}
            </span>
          </div>
          <div className="max-h-56 overflow-y-auto rounded border border-border divide-y divide-border">
            {INTRINSIC_FIELDS.map((def) => (
              <label
                key={def.key}
                className="flex items-start gap-2 px-2.5 py-1.5 text-xs cursor-pointer hover:bg-muted/60 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selected.has(def.key)}
                  disabled={!!busy}
                  onChange={() => toggleField(def.key)}
                  className="mt-0.5"
                />
                <span className="flex-1">
                  <span className="text-foreground">{def.excelHeader}</span>
                  <span className="ml-1 text-[11px] text-muted-foreground">
                    {[def.unit, def.writeName ? `${t('map.updateTableWriteAs') || '写回列名'} ${def.writeName}` : (t('map.updateTableExportOnly') || '仅导出')].filter(Boolean).join(' · ')}
                  </span>
                  <span className="block text-[11px] text-muted-foreground/80">{def.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* 结果 / 错误 */}
        {result && (
          <div className="flex items-start gap-2 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
            <Check size={13} className="mt-0.5 shrink-0" />
            <span>{result}</span>
          </div>
        )}
        {errorMsg && (
          <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}
        {layer && writeBlockReason && (
          <div className="text-[11px] text-amber-600 dark:text-amber-400">{writeBlockReason}</div>
        )}

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 mt-1">
          <button
            onClick={onClose}
            disabled={!!busy}
            className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:bg-muted transition-colors disabled:opacity-50"
          >
            {t('common.cancel') || '取消'}
          </button>
          <button
            onClick={handleWriteBack}
            disabled={!layer || !!busy || !!writeBlockReason || keys.length === 0}
            title={writeBlockReason || undefined}
            className="px-3 py-1.5 text-xs rounded border border-border text-foreground hover:bg-muted transition-colors flex items-center gap-1 disabled:opacity-50"
          >
            {busy === 'write' ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {t('map.updateTableWriteBack') || '写回图层'}
          </button>
          <button
            onClick={handleExport}
            disabled={!layer || !!busy || keys.length === 0}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity flex items-center gap-1 disabled:opacity-50"
          >
            {busy === 'export' ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {t('map.updateTableExport') || '导出表格'}
          </button>
        </div>
      </div>
    </div>
  )
}
