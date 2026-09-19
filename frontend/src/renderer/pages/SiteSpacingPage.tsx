import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, Loader2, Download, CheckCircle2, AlertCircle, Ruler, UploadCloud } from 'lucide-react'
import { siteSpacingApi, dataApi, layerToolsApi } from '../services/api'
import { uploadStore } from '../store/uploadStore'

type FullSource = 'file' | 'data'

interface ParseError { sheet: string; row: number; reason: string }

// ===== sessionStorage 持久化（镜像 DistanceMatchPage 模式：切页不丢失，刷新/新开/登录清除） =====
const STORAGE_KEY = 'siteSpacing.shared'
const PAGE_LOAD_ID = Math.random().toString(36).slice(2)

interface SharedState {
  filePath: string
  fileName: string
  fileExt: string             // .xlsx/.xls/.csv/.txt
  sheetList: string[]
  sheet: string
  fullSource: FullSource
  fullSheet: string
  fullDataId: string
  dataSheets: string[]
  kNeighbors: string
  calculating: boolean
  result: { filename: string; download_url: string; total?: number; counted?: number; overall_avg_km?: number; k?: number } | null
  parseErrors: ParseError[]
  parseTotal: number
  error: string
}

function emptyShared(): SharedState {
  return {
    filePath: '', fileName: '', fileExt: '', sheetList: [], sheet: '',
    fullSource: 'file', fullSheet: '', fullDataId: '', dataSheets: [],
    kNeighbors: '5', calculating: false, result: null,
    parseErrors: [], parseTotal: 0, error: '',
  }
}

function loadShared(): SharedState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw)
      if (saved && saved.pageLoadId === PAGE_LOAD_ID) {
        const { pageLoadId, ...rest } = saved
        return { ...emptyShared(), ...rest }
      }
    }
  } catch { /* ignore */ }
  return emptyShared()
}

function saveShared(s: SharedState) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ pageLoadId: PAGE_LOAD_ID, ...s })) } catch { /* ignore */ }
}

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.(xlsx|xls|csv|txt)$/i)
  return m ? `.${m[1].toLowerCase()}` : ''
}

export default function SiteSpacingPage() {
  const { t } = useTranslation()

  const initialShared = useRef(loadShared()).current

  // ===== 导入文件（单一） =====
  const [filePath, setFilePath] = useState(initialShared.filePath)
  const [fileName, setFileName] = useState(initialShared.fileName)
  const [fileExt, setFileExt] = useState(initialShared.fileExt)
  const [sheetList, setSheetList] = useState<string[]>(initialShared.sheetList)

  // ===== 站点来源（仅在 file 模式下需要选 sheet） =====
  const [fullSource, setFullSource] = useState<FullSource>(initialShared.fullSource)
  const [sheet, setSheet] = useState(initialShared.sheet)
  const [fullSheet, setFullSheet] = useState(initialShared.fullSheet)

  // ===== 工参文件来源 =====
  const [dataItems, setDataItems] = useState<any[]>([])
  const [fullDataId, setFullDataId] = useState(initialShared.fullDataId)
  const [dataSheets, setDataSheets] = useState<string[]>(initialShared.dataSheets)

  // ===== 参数 =====
  const [kNeighbors, setKNeighbors] = useState(initialShared.kNeighbors)

  // ===== 状态 =====
  const [calculating, setCalculating] = useState(initialShared.calculating)
  const [parseErrors, setParseErrors] = useState<ParseError[]>(initialShared.parseErrors)
  const [parseTotal, setParseTotal] = useState(initialShared.parseTotal)
  const [result, setResult] = useState<SharedState['result']>(initialShared.result)
  const [error, setError] = useState(initialShared.error)

  // ===== 模块级上传进度 =====
  const [uploadProgress, setUploadProgress] = useState(uploadStore.get())
  useEffect(() => uploadStore.subscribe(setUploadProgress), [])
  const uploading = uploadProgress.active

  // ===== sessionStorage 持久化 ref + 统一写回 =====
  const sharedRef = useRef<SharedState>({
    filePath, fileName, fileExt, sheetList, sheet, fullSource, fullSheet,
    fullDataId, dataSheets, kNeighbors, calculating, result, parseErrors, parseTotal, error,
  })
  useEffect(() => {
    sharedRef.current = {
      filePath, fileName, fileExt, sheetList, sheet, fullSource, fullSheet,
      fullDataId, dataSheets, kNeighbors, calculating, result, parseErrors, parseTotal, error,
    }
  })
  const persistShared = (updater: (prev: SharedState) => SharedState) => {
    const next = updater(sharedRef.current)
    sharedRef.current = next
    saveShared(next)
  }
  useEffect(() => {
    saveShared({
      filePath, fileName, fileExt, sheetList, sheet, fullSource, fullSheet,
      fullDataId, dataSheets, kNeighbors, calculating, result, parseErrors, parseTotal, error,
    })
  }, [filePath, fileName, fileExt, sheetList, sheet, fullSource, fullSheet, fullDataId, dataSheets, kNeighbors, calculating, result, parseErrors, parseTotal, error])

  // 数据管理下拉加载（excel + ready，过滤全量工参 full_params）
  useEffect(() => {
    dataApi.list(1, 100, true).then(res => {
      if (res.success && res.data) {
        const items = (res.data as any[]).filter((d: any) => d.type === 'excel' && d.status === 'ready' && d.fileType === 'full_params')
        setDataItems(items)
        if (initialShared.fullDataId && items.some((d: any) => d.id === initialShared.fullDataId)) {
          setFullDataId(initialShared.fullDataId)
        } else {
          // items 已按 fileType==='full_params' 过滤，直接取第一条即可
          setFullDataId(items[0]?.id || '')
        }
      }
    }).catch(() => setError(t('siteSpacing.loadDataErr') || '加载数据列表失败'))
  }, [])

  // 恢复的文件校验：filePath 存在 → getExcelInfo 刷新 sheetList 并纠正失效选择
  useEffect(() => {
    if (!filePath || fileExt !== '.xlsx' && fileExt !== '.xls') {
      // CSV/TXT 无 sheet 概念
      if (filePath && (fileExt === '.csv' || fileExt === '.txt')) {
        setSheetList([])
        setSheet('')
        persistShared(s => ({ ...s, sheetList: [], sheet: '' }))
      }
      return
    }
    let cancelled = false
    layerToolsApi.getExcelInfo(filePath, fileName).then(info => {
      if (cancelled) return
      if (info?.sheets?.length) {
        setSheetList(info.sheets)
        if (!info.sheets.includes(sheet)) {
          setSheet(info.sheets[0] || '')
          persistShared(s => ({ ...s, sheet: info.sheets[0] || '' }))
        }
      }
    }).catch(() => {
      if (cancelled) return
      setFilePath(''); setFileName(''); setFileExt(''); setSheetList([]); setSheet('')
      persistShared(s => ({ ...s, filePath: '', fileName: '', fileExt: '', sheetList: [], sheet: '' }))
      setError(t('siteSpacing.fileExpired') || '文件已过期，请重新导入')
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 工参文件来源 → 读取原始 Excel 真实 sheet 列表 + 默认预选
  useEffect(() => {
    if (fullSource !== 'data' || !fullDataId) {
      setDataSheets([]); setFullSheet('')
      return
    }
    let cancelled = false
    siteSpacingApi.getDataSheets(fullDataId).then(res => {
      if (cancelled) return
      if (res.success && res.data?.sheets?.length) {
        setDataSheets(res.data.sheets)
        setFullSheet(s => (s && res.data!.sheets.includes(s)) ? s : (res.data!.sheets[0] || ''))
      } else {
        setDataSheets([]); setFullSheet('')
      }
    }).catch(() => {
      if (!cancelled) { setDataSheets([]); setFullSheet('') }
    })
    return () => { cancelled = true }
  }, [fullSource, fullDataId])

  const handleDownloadTemplate = async () => {
    try {
      await siteSpacingApi.downloadTemplate()
    } catch {
      setError(t('siteSpacing.templateDownloadErr') || '模板下载失败，请重试')
    }
  }

  // 顶层单一导入框
  const handleFile = async (f: File) => {
    setParseErrors([]); setParseTotal(0); setError(''); setResult(null)
    setSheetList([]); setSheet('')
    persistShared(s => ({ ...s, parseErrors: [], parseTotal: 0, error: '', result: null, sheetList: [], sheet: '' }))
    if (fullSource === 'file') { setFullSheet(''); persistShared(s => ({ ...s, fullSheet: '' })) }
    const ext = extOf(f.name)
    if (!ext) {
      setError(t('siteSpacing.errFormat') || '文件格式不支持，请上传 .xlsx/.xls/.csv/.txt')
      return
    }
    uploadStore._set({ active: true, percent: 1, step: 'uploading', sessionId: '', fileName: f.name })
    try {
      const up = await layerToolsApi.uploadLayerFile(f)
      setFilePath(up.file_path)
      setFileName(f.name)
      setFileExt(ext)
      persistShared(s => ({ ...s, filePath: up.file_path, fileName: f.name, fileExt: ext }))
      uploadStore._set({ active: true, percent: 100, step: 'reading', sessionId: '', fileName: f.name })
      // Excel 才读取 sheet 列表
      if (ext === '.xlsx' || ext === '.xls') {
        const info = await layerToolsApi.getExcelInfo(up.file_path, f.name)
        if (info?.sheets?.length) {
          setSheetList(info.sheets)
          const first = info.sheets[0] || ''
          setSheet(first)
          if (fullSource === 'file') setFullSheet(first)
          persistShared(s => ({ ...s, sheetList: info.sheets, sheet: first, fullSheet: fullSource === 'file' ? first : s.fullSheet }))
        }
      } else {
        // CSV/TXT：单表，sheet = 文件名（后端按 sheet_name 读第一个表）
        setSheetList([])
        setSheet('')
        if (fullSource === 'file') setFullSheet('')
        persistShared(s => ({ ...s, sheetList: [], sheet: '', fullSheet: fullSource === 'file' ? '' : s.fullSheet }))
      }
    } catch (e: any) {
      if (e?.message === '已取消') {
        uploadStore._set({ active: false })
        return
      }
      setError(e?.message || String(e))
    } finally { uploadStore._set({ active: false }) }
  }

  const handleFullSourceChange = (v: FullSource) => {
    if (v === fullSource) return
    setFullSource(v)
    setFullSheet('') // 切换来源后重新选择对应 sheet
  }

  const handleCalculate = async () => {
    setError(''); setResult(null); setParseErrors([]); setParseTotal(0)
    const k = parseInt(kNeighbors, 10)
    if (fullSource === 'file' && !filePath) { setError(t('siteSpacing.errNoFile') || '请先导入文件'); return }
    if (fullSource === 'data' && (!fullDataId || !fullSheet)) {
      setError(t('siteSpacing.errMapping') || '请选择数据文件并选择工作表'); return
    }
    if (fullSource === 'file' && (fileExt === '.xlsx' || fileExt === '.xls') && !fullSheet) {
      setError(t('siteSpacing.errSheet') || '请选择工作表'); return
    }
    if (!(k > 0)) { setError(t('siteSpacing.errK') || '请输入大于 0 的最近站点数'); return }

    setCalculating(true)
    persistShared(s => ({ ...s, calculating: true, result: null, error: '', parseErrors: [], parseTotal: 0 }))
    try {
      const res = await siteSpacingApi.calculate({
        filePath: fullSource === 'file' ? filePath : undefined,
        k,
        fullSource,
        fullSheetName: fullSource === 'file' ? fullSheet : fullSheet,
        fullDataId: fullSource === 'data' ? fullDataId : undefined,
      })
      if (res.success && res.data?.download_url) {
        const newResult = {
          filename: res.data.filename,
          download_url: res.data.download_url,
          total: res.data.total,
          counted: res.data.counted,
          overall_avg_km: res.data.overall_avg_km,
          k: res.data.k,
        }
        persistShared(s => ({ ...s, calculating: false, result: newResult, error: '' }))
        setResult(newResult)
      } else if (res.data?.errors?.length) {
        persistShared(s => ({ ...s, calculating: false, error: '' }))
        setParseTotal((res.data as any).total || 0)
        setParseErrors(res.data.errors)
      } else {
        persistShared(s => ({ ...s, calculating: false, result: null, error: t('siteSpacing.errUnknown') || '计算失败，请重试' }))
        setError(t('siteSpacing.errUnknown') || '计算失败，请重试')
      }
    } catch (e: any) {
      persistShared(s => ({ ...s, calculating: false, result: null, error: e?.message || String(e) }))
      setError(e?.message || String(e))
    } finally { setCalculating(false) }
  }

  const progressText = () => {
    if (!uploadProgress.active) return ''
    if (uploadProgress.step === 'uploading') return t('layer.uploading').replace('{percent}', String(uploadProgress.percent))
    if (uploadProgress.step === 'reading') return t('layer.reading')
    return t('layer.done')
  }

  const sheetSelectCls = "w-full h-9 px-2 text-sm border border-border rounded bg-card"

  // 是否需要选 sheet（Excel 才有 sheet 概念）
  const needsSheet = fileExt === '.xlsx' || fileExt === '.xls'

  return (
    <div className="p-8 max-w-6xl">
      <h1 className="text-base font-bold mb-6 flex items-center gap-2">
        <Ruler size={18} /> {t('nav.siteSpacing')}
      </h1>

      {/* ① 文件导入 */}
      <div className="mb-6 p-4 bg-card border border-border rounded-lg">
        <p className="text-xs font-medium mb-3 flex items-center gap-2">
          <FileUp size={14} /> {t('siteSpacing.fileImport')}
          <button type="button" onClick={handleDownloadTemplate}
            className="ml-auto text-xs text-primary hover:underline">
            {t('siteSpacing.templateDownload')}
          </button>
        </p>

        <label className="block flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer hover:border-primary transition-colors">
          <UploadCloud className="text-muted-foreground shrink-0" size={20} />
          <span className="text-sm truncate flex-1">{fileName || t('siteSpacing.uploadHint')}</span>
          <input type="file" className="hidden" accept=".xlsx,.xls,.csv,.txt"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} disabled={uploading} />
        </label>

        {uploading && uploadProgress.percent > 0 && (
          <div className="mt-2">
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary transition-all duration-300" style={{ width: `${uploadProgress.percent}%` }} />
            </div>
            <div className="flex items-center justify-between mt-1">
              <p className="text-xs text-muted-foreground">{progressText()}</p>
              <button type="button" onClick={() => uploadStore.cancel()}
                className="text-xs text-muted-foreground hover:text-red-500 underline underline-offset-2 transition-colors">
                {t('layer.cancelUpload')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ② 数据选择 */}
      <div className="mb-6 p-4 bg-card border border-border rounded-lg">
        <p className="text-xs font-medium mb-4">{t('siteSpacing.dataSelect')}</p>

        <div className="mb-5">
          <p className="text-xs font-medium mb-2">{t('siteSpacing.fullSource')}</p>
          <div className="flex gap-4 mb-2">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" checked={fullSource === 'file'} onChange={() => handleFullSourceChange('file')} />
              {t('siteSpacing.fullSourceFile')}
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" checked={fullSource === 'data'} onChange={() => handleFullSourceChange('data')} />
              {t('siteSpacing.fullSourceData')}
            </label>
          </div>

          {fullSource === 'file' ? (
            needsSheet ? (
              <div className="max-w-xs">
                <label className="block text-xs font-medium mb-1">{t('siteSpacing.sheetName')}</label>
                <select value={fullSheet} onChange={e => setFullSheet(e.target.value)}
                  disabled={!sheetList.length} className={sheetSelectCls}>
                  {!sheetList.length && <option value="">{t('siteSpacing.uploadHint')}</option>}
                  {sheetList.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('siteSpacing.csvTxtHint') || 'CSV/TXT 文件无工作表概念，将直接读取全部内容'}</p>
            )
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">{t('siteSpacing.dataFile')}</label>
                <select value={fullDataId}
                  onChange={e => { setFullDataId(e.target.value); setDataSheets([]); setFullSheet('') }}
                  className={sheetSelectCls}>
                  {dataItems.length === 0 && <option value="">{t('siteSpacing.loadDataErr')}</option>}
                  {dataItems.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{t('siteSpacing.sheetName')}</label>
                <select value={fullSheet} onChange={e => setFullSheet(e.target.value)}
                  disabled={!dataSheets.length} className={sheetSelectCls}>
                  {!dataSheets.length && <option value="">{t('siteSpacing.uploadHint')}</option>}
                  {dataSheets.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ③ 参数设置 */}
      <div className="mb-6 p-4 bg-card border border-border rounded-lg">
        <p className="text-xs font-medium mb-3">{t('siteSpacing.params')}</p>
        <div className="max-w-xs">
          <label className="block text-xs font-medium mb-1">{t('siteSpacing.kNeighbors')}</label>
          <input value={kNeighbors} inputMode="numeric"
            onChange={e => { if (/^\d*$/.test(e.target.value)) setKNeighbors(e.target.value) }}
            placeholder="5" className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
          <p className="mt-1 text-xs text-muted-foreground">{t('siteSpacing.kNeighborsHint') || '计算每个站点到最近 K 个站点的平均距离'}</p>
        </div>
      </div>

      {/* ④ 开始计算 */}
      <div className="mb-6 p-4 bg-card border border-border rounded-lg">
        <button onClick={handleCalculate} disabled={calculating || uploading}
          className="w-full px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium">
          {calculating ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
          {t('siteSpacing.start')}
        </button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-600 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* 校验错误明细 */}
      {parseErrors.length > 0 && (
        <div className="mb-6 p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs">
          <p className="text-amber-400 font-medium mb-2 flex items-center gap-1">
            <AlertCircle size={14} /> {t('siteSpacing.invalidData')}
            {parseTotal > 0 && <span className="text-muted-foreground ml-2">（{t('siteSpacing.parsedTotal').replace('{count}', String(parseTotal))}）</span>}
          </p>
          <div className="max-h-40 overflow-y-auto">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-amber-500/10">
                <tr className="border-b border-amber-500/20">
                  <th className="px-2 py-1 font-medium">{t('siteSpacing.sheet')}</th>
                  <th className="px-2 py-1 font-medium">{t('siteSpacing.row')}</th>
                  <th className="px-2 py-1 font-medium">{t('siteSpacing.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {parseErrors.slice(0, 100).map((e, i) => (
                  <tr key={i} className="border-b border-amber-100">
                    <td className="px-2 py-1">{e.sheet}</td>
                    <td className="px-2 py-1">{e.row}</td>
                    <td className="px-2 py-1">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parseErrors.length > 100 && (
              <p className="px-2 py-1 text-amber-600">
                {t('siteSpacing.more').replace('{count}', String(parseErrors.length - 100))}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ⑤ 结果下载 */}
      {result && (
        <div className="p-4 bg-card border border-border rounded-lg space-y-3">
          <p className="text-xs text-muted-foreground flex items-center gap-2">
            <CheckCircle2 size={14} className="text-green-600" />
            {t('siteSpacing.calcDone').replace('{total}', String(result.total || 0)).replace('{k}', String(result.k || 0))}
          </p>

          {/* 汇总信息 */}
          <div className="grid grid-cols-3 gap-3 p-3 bg-muted/40 rounded-md">
            <div>
              <div className="text-xs text-muted-foreground">{t('siteSpacing.summaryTotal')}</div>
              <div className="text-lg font-semibold text-foreground">{result.total ?? 0}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('siteSpacing.summaryCounted')}</div>
              <div className="text-lg font-semibold text-foreground">{result.counted ?? 0}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('siteSpacing.summaryOverall')}</div>
              <div className="text-lg font-semibold text-foreground">{(result.overall_avg_km ?? 0).toFixed(4)}</div>
            </div>
          </div>

          <a href={result.download_url + '?_t=' + Date.now()} download
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-green-600 text-white rounded-lg hover:opacity-90 text-sm">
            <Download size={16} /> {t('siteSpacing.download')} ({result.filename})
          </a>
        </div>
      )}
    </div>
  )
}
