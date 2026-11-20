import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Combine,
  UploadCloud,
  Loader2,
  Download,
  CheckCircle2,
  AlertCircle,
  X,
  FileSpreadsheet,
} from 'lucide-react'
import {
  tableMergeApi,
  type TableMergeInspectData,
  type TableMergeMode,
  type TableMergeResultData,
} from '../services/api'

const cardCls = 'p-4 bg-card border border-border rounded-lg'

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export default function TableMergePage() {
  const { t } = useTranslation()

  // ===== 文件与设置 =====
  const [files, setFiles] = useState<File[]>([])
  const [mode, setMode] = useState<TableMergeMode>('structure')
  const [addSource, setAddSource] = useState(true)
  const [dedupe, setDedupe] = useState(false)

  // ===== 状态 =====
  const [inspecting, setInspecting] = useState(false)
  const [merging, setMerging] = useState(false)
  const [inspectData, setInspectData] = useState<TableMergeInspectData | null>(null)
  const [result, setResult] = useState<TableMergeResultData | null>(null)
  const [error, setError] = useState('')

  const inputRef = useRef<HTMLInputElement>(null)

  /** 解析文件：返回分组预览（后端按所选合并模式分组） */
  const runInspect = useCallback(async (list: File[], mergeMode: TableMergeMode) => {
    if (!list.length) {
      setInspectData(null)
      return
    }
    setInspecting(true)
    try {
      const res = await tableMergeApi.inspect(list, mergeMode)
      if (res.success && res.data) {
        setInspectData(res.data)
      } else {
        setInspectData(null)
      }
    } catch (e: any) {
      setInspectData(null)
      setError(e?.message || t('tableMerge.errInspect'))
    } finally {
      setInspecting(false)
    }
  }, [t])

  /** 选择文件：追加（同名同大小视为重复），随后重新解析预览 */
  const handleFiles = useCallback(async (list: FileList | null) => {
    if (!list || !list.length) return
    const incoming = Array.from(list)
    const next = [...files]
    for (const file of incoming) {
      if (!next.some(f => f.name === file.name && f.size === file.size)) {
        next.push(file)
      }
    }
    setFiles(next)
    setResult(null)
    setError('')
    await runInspect(next, mode)
    if (inputRef.current) inputRef.current.value = ''
  }, [files, mode, runInspect])

  const removeFile = useCallback(async (index: number) => {
    const next = files.filter((_, i) => i !== index)
    setFiles(next)
    setResult(null)
    setError('')
    if (next.length) {
      await runInspect(next, mode)
    } else {
      setInspectData(null)
    }
  }, [files, mode, runInspect])

  const clearAll = useCallback(() => {
    setFiles([])
    setInspectData(null)
    setResult(null)
    setError('')
    if (inputRef.current) inputRef.current.value = ''
  }, [])

  /** 切换合并方式 → 重新解析（分组随模式变化） */
  const handleModeChange = useCallback(async (next: TableMergeMode) => {
    setMode(next)
    setResult(null)
    if (files.length) {
      await runInspect(files, next)
    }
  }, [files, runInspect])

  const handleMerge = useCallback(async () => {
    if (!files.length) {
      setError(t('tableMerge.noFiles'))
      return
    }
    setMerging(true)
    setError('')
    try {
      const res = await tableMergeApi.merge(files, { mode, addSource, dedupe })
      if (res.success && res.data?.download_url) {
        setResult(res.data)
      } else {
        setError(t('tableMerge.errMerge'))
      }
    } catch (e: any) {
      setError(e?.message || t('tableMerge.errMerge'))
    } finally {
      setMerging(false)
    }
  }, [files, mode, addSource, dedupe, t])

  const partialErrors = inspectData?.errors?.length
    ? inspectData.errors
    : (result?.errors?.length ? result.errors : [])
  const busy = inspecting || merging

  return (
    <div className="p-6 w-full h-full min-h-0 flex flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-base font-bold flex items-center gap-2">
          <Combine size={18} className="text-primary" /> {t('nav.tableMerge')}
        </h1>
        <p className="text-xs text-muted-foreground mt-1">{t('tableMerge.subtitle')}</p>
      </div>

      {/* 顶部：文件选择 / 合并设置 / 执行 */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 shrink-0">
        {/* ① 文件选择（多选） */}
        <div className={cardCls}>
          <p className="text-xs font-medium mb-3 flex items-center gap-2">
            <FileSpreadsheet size={14} /> {t('tableMerge.fileSelect')}
            {files.length > 0 && (
              <button type="button" onClick={clearAll}
                className="ml-auto text-xs text-muted-foreground hover:text-red-500 underline underline-offset-2 transition-colors">
                {t('tableMerge.clearAll')}
              </button>
            )}
          </p>

          <label className="flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer hover:border-primary transition-colors">
            <UploadCloud className="text-muted-foreground shrink-0" size={20} />
            <span className="text-sm truncate flex-1">
              {files.length
                ? t('tableMerge.fileCount', { count: files.length })
                : t('tableMerge.uploadHint')}
            </span>
            <input ref={inputRef} type="file" className="hidden" multiple
              accept=".xlsx,.xls,.xlsm,.csv,.txt"
              onChange={e => handleFiles(e.target.files)} disabled={busy} />
          </label>

          {files.length > 0 && (
            <ul className="mt-3 space-y-1 max-h-40 overflow-y-auto">
              {files.map((file, index) => (
                <li key={`${file.name}-${file.size}-${index}`}
                  className="flex items-center gap-2 px-2 py-1 rounded bg-muted/50 text-xs">
                  <FileSpreadsheet size={13} className="shrink-0 text-muted-foreground" />
                  <span className="truncate flex-1" title={file.name}>{file.name}</span>
                  <span className="text-muted-foreground shrink-0">{formatSize(file.size)}</span>
                  <button type="button" onClick={() => removeFile(index)} disabled={busy}
                    title={t('tableMerge.removeFile')}
                    className="shrink-0 text-muted-foreground hover:text-red-500 transition-colors">
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ② 合并设置 */}
        <div className={cardCls}>
          <p className="text-xs font-medium mb-3">{t('tableMerge.settings')}</p>

          <p className="text-xs font-medium mb-1">{t('tableMerge.modeLabel')}</p>
          <div className="space-y-1.5 mb-3">
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input type="radio" className="mt-0.5" checked={mode === 'structure'}
                onChange={() => handleModeChange('structure')} disabled={busy} />
              <span>
                {t('tableMerge.modeStructure')}
                <span className="block text-muted-foreground">{t('tableMerge.modeStructureHint')}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input type="radio" className="mt-0.5" checked={mode === 'sheet'}
                onChange={() => handleModeChange('sheet')} disabled={busy} />
              <span>
                {t('tableMerge.modeSheet')}
                <span className="block text-muted-foreground">{t('tableMerge.modeSheetHint')}</span>
              </span>
            </label>
          </div>

          <label className="flex items-center gap-2 text-xs cursor-pointer mb-1.5">
            <input type="checkbox" checked={addSource} disabled={busy}
              onChange={e => setAddSource(e.target.checked)} />
            {t('tableMerge.addSource')}
          </label>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={dedupe} disabled={busy}
              onChange={e => setDedupe(e.target.checked)} />
            {t('tableMerge.dedupe')}
          </label>
        </div>

        {/* ③ 合并输出 */}
        <div className={cardCls}>
          <p className="text-xs font-medium mb-3">{t('tableMerge.output')}</p>
          <p className="text-xs text-muted-foreground mb-4">{t('tableMerge.outputHint')}</p>
          <button onClick={handleMerge} disabled={busy || !files.length}
            className="w-full px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium">
            {merging
              ? <Loader2 size={16} className="animate-spin inline mr-2" />
              : <Combine size={16} className="inline mr-2" />}
            {merging ? t('tableMerge.merging') : t('tableMerge.start')}
          </button>
          {inspecting && (
            <p className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" /> {t('tableMerge.inspecting')}
            </p>
          )}
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-600 flex items-start gap-2 shrink-0">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* 部分文件解析失败（其余文件继续合并） */}
      {partialErrors.length > 0 && (
        <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs shrink-0">
          <p className="text-amber-500 font-medium mb-1 flex items-center gap-1">
            <AlertCircle size={14} /> {t('tableMerge.partialError')}
          </p>
          <ul className="space-y-0.5 text-amber-600">
            {partialErrors.map((item, i) => (
              <li key={i} className="truncate" title={item.error}>{item.file_name}：{item.error}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 合并分组预览 */}
      {inspectData && inspectData.groups.length > 0 && (
        <div className="flex-1 min-h-0 overflow-auto">
          <p className="text-xs font-medium text-foreground mb-2 flex items-center gap-2">
            {t('tableMerge.preview')}
            <span className="text-muted-foreground font-normal">
              {t('tableMerge.previewHint', { count: inspectData.groups.length })}
            </span>
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {inspectData.groups.map(group => (
              <div key={group.output_sheet} className={cardCls}>
                <div className="flex items-center gap-2 mb-2">
                  <FileSpreadsheet size={14} className="text-primary shrink-0" />
                  <span className="text-sm font-medium truncate" title={group.output_sheet}>
                    {group.output_sheet}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground mb-2">
                  <span>{t('tableMerge.columnCount', { count: group.columns.length })}</span>
                  <span>{t('tableMerge.rowCount', { count: group.total_rows })}</span>
                  <span>{t('tableMerge.sourceCount', { count: group.sources.length })}</span>
                </div>
                <p className="text-xs mb-1 text-foreground">{t('tableMerge.sources')}</p>
                <ul className="space-y-0.5 mb-2">
                  {group.sources.map((source, i) => (
                    <li key={i} className="text-xs text-muted-foreground truncate" title={`${source.file_name} / ${source.sheet_name}`}>
                      {source.file_name} / {source.sheet_name}（{source.row_count}）
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground truncate" title={group.columns.join(', ')}>
                  {group.columns.join('、')}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 合并结果 */}
      {result && (
        <div className="shrink-0 p-4 bg-card border border-border rounded-lg space-y-3">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-[16rem]">
              <p className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle2 size={14} /> {t('tableMerge.merged')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('tableMerge.totalRows', { count: result.total_rows })}
              </p>
            </div>
            <a href={result.download_url + '?_t=' + Date.now()} download
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-primary text-white rounded-lg hover:opacity-90 text-sm shrink-0">
              <Download size={16} /> {t('tableMerge.download')} ({result.filename})
            </a>
          </div>

          <table className="w-full text-left npt-resizable">
            <thead>
              <tr className="border-b border-border">
                <th className="px-2 py-1 text-xs font-medium">{t('tableMerge.sheetName')}</th>
                <th className="px-2 py-1 text-xs font-medium">{t('tableMerge.rows')}</th>
                <th className="px-2 py-1 text-xs font-medium">{t('tableMerge.sourceCountLabel')}</th>
                <th className="px-2 py-1 text-xs font-medium">{t('tableMerge.sources')}</th>
              </tr>
            </thead>
            <tbody>
              {result.sheets.map(sheet => (
                <tr key={sheet.output_sheet} className="border-b border-border/60">
                  <td className="px-2 py-1 text-xs">{sheet.output_sheet}</td>
                  <td className="px-2 py-1 text-xs">{sheet.row_count}</td>
                  <td className="px-2 py-1 text-xs">{sheet.source_count}</td>
                  <td className="px-2 py-1 text-xs text-muted-foreground truncate">
                    {sheet.sources.map(s => `${s.file_name} / ${s.sheet_name}`).join('、')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
