/**
 * 地图工具 - 文件导出弹窗
 *
 * 列出所有已导入的文件（图层文件 TAB / 地理化表格 Excel），勾选后导出到本地：
 * - 图层文件：调用后端打包 .tab 及其依赖文件（.dat/.id/.map/.ind）为 zip 下载
 * - 表格文件：导出该文件的全部字段属性（含经纬度与几何类型）为 .xlsx
 */
import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { X, FileArchive, FileSpreadsheet, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { layerApi } from '../../services/api'
import { useMapDataCacheStore } from '../../store/mapDataCacheStore'
import type { LayerFileOption } from './LayerControl'

/** 可导出文件条目 */
export interface ExportFileItem {
  /** 数据集 id（= dataId） */
  id: string
  /** 图层 id（mapinfo 为图层 id；excel 与数据集 id 一致） */
  layerId: string
  name: string
  kind: 'mapinfo' | 'excel'
  /** 几何类型/子类型（展示用） */
  subLabel?: string
  /** 是否本工具新建的图层（true → TAB 套装 zip；false → 数据管理导入，下载原始文件） */
  toolCreated?: boolean
  /** 是否可编辑 TAB（.tab 源）：导入的可编辑图层保存后已重写 TAB，导出须取当前图层文件而非原始上传快照 */
  editable?: boolean
}

interface MapExportDialogProps {
  open: boolean
  onClose: () => void
  /** 图层文件（MapInfo/TAB）：导出弹窗只列图层文件，地理化数据不参与 */
  layerFiles: LayerFileOption[]
}

/** 取回表格文件的要素集合（优先用前端缓存，否则请求后端） */
async function fetchFeatureCollection(dataId: string, layerId: string): Promise<any | null> {
  const cached = useMapDataCacheStore.getState().layers[layerId]?.geojson
  if (cached) return cached
  try {
    const resp = await layerApi.getLayerData(dataId, layerId)
    return resp?.data || null
  } catch (e) {
    console.error('[MapExportDialog] 获取图层数据失败:', layerId, e)
    return null
  }
}

/** 几何 → 经纬度（取第一个坐标点） */
function firstCoordinate(geometry: any): [number, number] | null {
  const coords = geometry?.coordinates
  if (!coords) return null
  let cur: any = coords
  while (Array.isArray(cur) && typeof cur[0] !== 'number') {
    cur = cur[0]
  }
  if (Array.isArray(cur) && typeof cur[0] === 'number' && typeof cur[1] === 'number') {
    return [cur[0], cur[1]]
  }
  return null
}

export default function MapExportDialog({ open, onClose, layerFiles }: MapExportDialogProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>('')

  const files = useMemo<ExportFileItem[]>(() => {
    const list: ExportFileItem[] = []
    for (const f of layerFiles || []) {
      list.push({
        id: f.dataId,
        layerId: f.id,
        name: f.name,
        kind: 'mapinfo',
        subLabel: f.type,
        toolCreated: f.toolCreated,
        editable: f.editable,
      })
    }
    // 仅"图层文件"下的文件可导出（地理化数据不在此列表）
    return list
  }, [layerFiles])

  useEffect(() => {
    if (open) {
      setSelected(new Set())
      setResult('')
      setBusy(false)
    }
  }, [open])

  if (!open) return null

  const toggle = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const keyOf = (f: ExportFileItem) => `${f.kind}:${f.id}:${f.layerId}`

  const handleExport = async () => {
    const targets = files.filter(f => selected.has(keyOf(f)))
    if (targets.length === 0) return
    setBusy(true)
    setResult('')
    const failed: string[] = []
    let okCount = 0

    for (const f of targets) {
      try {
        if (f.kind === 'mapinfo' && (f.toolCreated || f.editable)) {
          // 可编辑 TAB 图层（工具新建 / 导入后已编辑保存）：打包当前图层文件。
          // 保存会把编辑结果整层重写进数据目录中的 TAB，导出必须取当前文件
          // 而非原始上传快照（否则导出的是编辑前状态）。
          await layerApi.downloadLayerZip(f.id, f.layerId, f.name)
        } else if (f.kind === 'mapinfo') {
          // 不可编辑的导入文件（MIF/KML 等，无法保存编辑）：下载原始上传文件
          const { blob, filename } = await layerApi.fetchDataFile(f.id, f.name)
          const blobUrl = window.URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = blobUrl
          link.download = filename
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          window.URL.revokeObjectURL(blobUrl)
          okCount++
        } else {
          // 表格文件：导出全部字段属性
          const fc = await fetchFeatureCollection(f.id, f.layerId)
          const features: any[] = fc?.features || []
          if (features.length === 0) {
            failed.push(f.name)
            continue
          }
          const fieldSet = new Set<string>()
          for (const ft of features) {
            Object.keys(ft?.properties || {}).forEach(k => fieldSet.add(k))
          }
          const fields = Array.from(fieldSet)
          const rows = features.map((ft: any) => {
            const row: Record<string, any> = {}
            for (const k of fields) {
              row[k] = (ft?.properties || {})[k]
            }
            const c = firstCoordinate(ft?.geometry)
            row[t('map.longitude') || '经度'] = c ? c[0] : ''
            row[t('map.latitude') || '纬度'] = c ? c[1] : ''
            row[t('map.geometryType') || '几何类型'] = ft?.geometry?.type || ''
            return row
          })
          const ws = XLSX.utils.json_to_sheet(rows)
          const wb = XLSX.utils.book_new()
          const sheetName = (f.name || 'sheet').slice(0, 30)
          XLSX.utils.book_append_sheet(wb, ws, sheetName)
          XLSX.writeFile(wb, `${f.name || 'export'}.xlsx`)
          okCount++
        }
      } catch (e) {
        console.error('[MapExportDialog] 导出失败:', f.name, e)
        failed.push(f.name)
      }
    }

    setBusy(false)
    setResult(
      failed.length === 0
        ? (t('map.exportDone', { count: okCount }) || `已导出 ${okCount} 个文件`)
        : (t('map.exportPartial', { ok: okCount, fail: failed.join('、') })
          || `已导出 ${okCount} 个，失败：${failed.join('、')}`),
    )
  }

  return (
    <div className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/20" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-lg p-5 w-[420px] flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <FileArchive size={16} className="text-primary" />
            {t('map.exportFiles') || '导出文件'}
          </div>
          <button className="text-muted-foreground hover:text-foreground transition-colors" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="text-xs text-muted-foreground">
          {t('map.exportFilesHint') || '勾选需要导出的文件：图层文件导出 TAB 及依赖文件（zip），表格文件导出全部字段属性（xlsx）'}
        </div>

        <div className="max-h-[320px] overflow-y-auto border border-border rounded-md">
          {files.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              {t('map.exportNoFiles') || '暂无可导出的文件'}
            </div>
          )}
          {files.map((f) => {
            const key = keyOf(f)
            const checked = selected.has(key)
            return (
              <label
                key={key}
                className="flex items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-muted cursor-pointer border-b border-border last:border-b-0"
              >
                <input type="checkbox" checked={checked} onChange={() => toggle(key)} />
                {f.kind === 'mapinfo'
                  ? <FileArchive size={13} className="text-muted-foreground flex-shrink-0" />
                  : <FileSpreadsheet size={13} className="text-muted-foreground flex-shrink-0" />}
                <span className="flex-1 truncate" title={f.name}>{f.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {f.kind === 'mapinfo' ? (t('map.tabLayer') || 'TAB图层') : (t('map.excelTable') || '表格')}
                  {f.subLabel ? ` · ${f.subLabel}` : ''}
                </span>
              </label>
            )
          })}
        </div>

        {result && (
          <div className="text-xs text-muted-foreground">{result}</div>
        )}

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="px-2 py-1 text-xs rounded text-foreground hover:bg-muted"
            onClick={() => setSelected(new Set(files.map(keyOf)))}
            disabled={busy || files.length === 0}
          >
            {t('map.selectAllFiles') || '全选'}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-1.5 text-xs rounded border border-border text-foreground hover:bg-muted"
              onClick={onClose}
            >
              {t('map.cancel') || '取消'}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 flex items-center gap-1"
              onClick={handleExport}
              disabled={busy || selected.size === 0}
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              {t('map.exportAction') || '导出'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
