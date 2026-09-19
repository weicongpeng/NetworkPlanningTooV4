import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, Loader2, Download, CheckCircle2, AlertCircle, Ruler, UploadCloud } from 'lucide-react'
import { distanceMatchApi, dataApi, layerToolsApi } from '../services/api'
import { uploadStore } from '../store/uploadStore'

type FullSource = 'file' | 'data'

interface ParseError { sheet: string; row: number; reason: string }

// ===== sessionStorage 持久化（镜像 LayerToolsPage 模式：切页不丢失，刷新/新开/登录清除） =====
const STORAGE_KEY = 'distanceMatch.shared'
// 模块级：整页首次加载生成一次；路由切换不重估（状态保留），F5 重估（旧状态视为过期清除）
const PAGE_LOAD_ID = Math.random().toString(36).slice(2)

interface SharedState {
  filePath: string
  fileName: string
  sheetList: string[]
  matchSheet: string
  fullSource: FullSource
  fullSheet: string
  fullDataId: string
  dataSheets: string[]
  maxDistanceKm: string
  matching: boolean
  result: { filename: string; download_url: string } | null
  parseErrors: ParseError[]
  error: string
}

function emptyShared(): SharedState {
  return {
    filePath: '', fileName: '', sheetList: [], matchSheet: '',
    fullSource: 'file', fullSheet: '', fullDataId: '', dataSheets: [],
    maxDistanceKm: '', matching: false, result: null, parseErrors: [], error: '',
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

export default function DistanceMatchPage() {
  const { t } = useTranslation()

  // 持久化状态一次性初始化（切页切回恢复；F5/新开 tab 由 pageLoadId 判定为过期 → 空）
  const initialShared = useRef(loadShared()).current

  // ===== 导入文件（顶层单一） =====
  const [filePath, setFilePath] = useState(initialShared.filePath)
  const [fileName, setFileName] = useState(initialShared.fileName)
  const [sheetList, setSheetList] = useState<string[]>(initialShared.sheetList)

  // ===== 匹配站点（来源固定为导入文件） =====
  const [matchSheet, setMatchSheet] = useState(initialShared.matchSheet)

  // ===== 相邻站点来源 =====
  const [fullSource, setFullSource] = useState<FullSource>(initialShared.fullSource)
  const [fullSheet, setFullSheet] = useState(initialShared.fullSheet)   // file: 导入文件 sheet；data: 工参文件 sheet

  // ===== 工参文件来源 =====
  const [dataItems, setDataItems] = useState<any[]>([])
  const [fullDataId, setFullDataId] = useState(initialShared.fullDataId)
  const [dataSheets, setDataSheets] = useState<string[]>(initialShared.dataSheets)

  // ===== 参数 =====
  const [maxDistanceKm, setMaxDistanceKm] = useState(initialShared.maxDistanceKm)

  // ===== 状态 =====
  const [matching, setMatching] = useState(initialShared.matching)
  const [parseErrors, setParseErrors] = useState<ParseError[]>(initialShared.parseErrors)
  const [result, setResult] = useState<{ filename: string; download_url: string } | null>(initialShared.result)
  const [error, setError] = useState(initialShared.error)

  // ===== 模块级上传进度（chunkedUpload 后台更新，切页不丢失） =====
  const [uploadProgress, setUploadProgress] = useState(uploadStore.get())
  useEffect(() => uploadStore.subscribe(setUploadProgress), [])
  const uploading = uploadProgress.active

  // ===== sessionStorage 持久化 ref + 统一写回 =====
  const sharedRef = useRef<SharedState>({
    filePath, fileName, sheetList, matchSheet, fullSource, fullSheet,
    fullDataId, dataSheets, maxDistanceKm, matching, result, parseErrors, error,
  })
  useEffect(() => {
    sharedRef.current = {
      filePath, fileName, sheetList, matchSheet, fullSource, fullSheet,
      fullDataId, dataSheets, maxDistanceKm, matching, result, parseErrors, error,
    }
  })
  // 同步写 sessionStorage（不依赖 setState 执行，防止组件卸载丢写）
  const persistShared = (updater: (prev: SharedState) => SharedState) => {
    const next = updater(sharedRef.current)
    sharedRef.current = next
    saveShared(next)
  }
  useEffect(() => {
    saveShared({
      filePath, fileName, sheetList, matchSheet, fullSource, fullSheet,
      fullDataId, dataSheets, maxDistanceKm, matching, result, parseErrors, error,
    })
  }, [filePath, fileName, sheetList, matchSheet, fullSource, fullSheet, fullDataId, dataSheets, maxDistanceKm, matching, result, parseErrors, error])

  // 数据管理下拉加载（excel + ready，过滤全量工参 full_params）；恢复的 fullDataId 仍存在才保留
  useEffect(() => {
    dataApi.list(1, 100, true).then(res => {
      if (res.success && res.data) {
        const items = res.data.filter((d: any) => d.type === 'excel' && d.status === 'ready' && d.fileType === 'full_params')
        setDataItems(items)
        if (initialShared.fullDataId && items.some((d: any) => d.id === initialShared.fullDataId)) {
          setFullDataId(initialShared.fullDataId)
        } else {
          // items 已按 fileType==='full_params' 过滤，直接取第一条即可
          setFullDataId(items[0]?.id || '')
        }
      }
    }).catch(() => setError(t('distanceMatch.loadDataErr') || '加载数据列表失败'))
  }, [])

  // 恢复的文件校验：filePath 存在 → getExcelInfo 刷新 sheetList 并纠正失效选择；文件被 TTL 清扫 → 清空导入提示重导
  useEffect(() => {
    if (!filePath) return
    let cancelled = false
    layerToolsApi.getExcelInfo(filePath, fileName).then(info => {
      if (cancelled) return
      if (info?.sheets?.length) {
        setSheetList(info.sheets)
        if (!info.sheets.includes(matchSheet)) {
          const next = info.sheets.find((s: string) => s.includes('匹配站点')) || info.sheets[0]
          setMatchSheet(next || '')
          persistShared(s => ({ ...s, matchSheet: next || '' }))
        }
        if (fullSource === 'file' && !info.sheets.includes(fullSheet)) {
          const next = info.sheets.find((s: string) => s.includes('相邻站点')) || info.sheets[1] || info.sheets[0]
          setFullSheet(next || '')
          persistShared(s => ({ ...s, fullSheet: next || '' }))
        }
      }
    }).catch(() => {
      if (cancelled) return
      setFilePath(''); setFileName(''); setSheetList([]); setMatchSheet('')
      persistShared(s => ({ ...s, filePath: '', fileName: '', sheetList: [], matchSheet: '' }))
      setError(t('distanceMatch.fileExpired') || '文件已过期，请重新导入')
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 工参文件来源 → 读取原始 Excel 真实 sheet 列表 + 默认预选（保留有效的恢复 fullSheet）
  useEffect(() => {
    if (fullSource !== 'data' || !fullDataId) {
      setDataSheets([]); setFullSheet('')
      return
    }
    let cancelled = false
    distanceMatchApi.getDataSheets(fullDataId).then(res => {
      if (cancelled) return
      if (res.success && res.data?.sheets?.length) {
        setDataSheets(res.data.sheets)
        // source==='network' 时 sheet 值即 LTE/NR（网络类型）；保留有效恢复值否则选第一个
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
      await distanceMatchApi.downloadTemplate()
    } catch {
      setError(t('distanceMatch.templateDownloadErr') || '模板下载失败，请重试')
    }
  }

  // 顶层单一导入框：上传 → 读 sheet 列表 → 自动预选匹配站点/相邻站点
  const handleFile = async (f: File) => {
    setParseErrors([]); setError(''); setResult(null)
    setSheetList([]); setMatchSheet('')
    persistShared(s => ({ ...s, parseErrors: [], error: '', result: null, sheetList: [], matchSheet: '' }))
    // 仅 file 来源清空/预选全量 sheet（data 来源由工参文件 sheet effect 管理，避免覆盖）
    if (fullSource === 'file') { setFullSheet(''); persistShared(s => ({ ...s, fullSheet: '' })) }
    uploadStore._set({ active: true, percent: 1, step: 'uploading', sessionId: '', fileName: f.name })
    try {
      const up = await layerToolsApi.uploadLayerFile(f)
      setFilePath(up.file_path)
      setFileName(f.name)
      persistShared(s => ({ ...s, filePath: up.file_path, fileName: f.name }))
      uploadStore._set({ active: true, percent: 100, step: 'reading', sessionId: '', fileName: f.name })
      const info = await layerToolsApi.getExcelInfo(up.file_path, f.name)
      if (info?.sheets?.length) {
        setSheetList(info.sheets)
        // 默认预选：匹配站点←含「匹配站点」的 sheet；相邻站点←含「相邻站点」或 sheets[1]||sheets[0]
        const find = (kw: string, fallbackIdx: number) =>
          info.sheets.find((s: string) => s.includes(kw)) || info.sheets[fallbackIdx] || info.sheets[0] || ''
        const m = find('匹配站点', 0)
        setMatchSheet(m)
        if (fullSource === 'file') setFullSheet(find('相邻站点', 1))
        persistShared(s => ({ ...s, sheetList: info.sheets, matchSheet: m, fullSheet: s.fullSource === 'file' ? find('相邻站点', 1) : s.fullSheet }))
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
    if (v === fullSource) return // 重复点击当前来源不重置
    setFullSource(v)
    setFullSheet('') // 切换来源后重新选择对应 sheet
  }

  const handleMatch = async () => {
    setError(''); setResult(null)
    const km = parseFloat(maxDistanceKm)
    if (!filePath) { setError(t('distanceMatch.errNoFile') || '请先导入文件'); return }
    if (!matchSheet) { setError(t('distanceMatch.errSheet') || '请选择匹配站点工作表'); return }
    if (!(km > 0)) { setError(t('distanceMatch.errThreshold') || '请输入大于 0 的距离门限'); return }
    if (fullSource === 'file' && !fullSheet) { setError(t('distanceMatch.errSheet') || '请选择相邻站点工作表'); return }
    if (fullSource === 'data' && (!fullDataId || !fullSheet)) {
      setError(t('distanceMatch.errMapping') || '请选择数据文件并选择工作表'); return
    }

    setMatching(true)
    // 持久化 matching 状态（切页不丢失，F5 刷新重置）
    persistShared(s => ({ ...s, matching: true, result: null, error: '' }))
    try {
      const res = await distanceMatchApi.match({
        filePath,
        matchSheetName: matchSheet,
        maxDistanceKm: km,
        fullSource,
        fullSheetName: fullSheet,
        fullDataId: fullSource === 'data' ? fullDataId : undefined,
      })
      if (res.success && res.data?.download_url) {
        const newResult = { filename: res.data.filename, download_url: res.data.download_url }
        persistShared(s => ({ ...s, matching: false, result: newResult, error: '' }))
        setResult(newResult)
      } else if (res.data?.errors?.length) {
        persistShared(s => ({ ...s, matching: false, error: '' }))
        setParseErrors(res.data.errors)
      } else {
        persistShared(s => ({ ...s, matching: false, result: null, error: t('distanceMatch.errUnknown') || '匹配失败，请重试' }))
        setError(t('distanceMatch.errUnknown') || '匹配失败，请重试')
      }
    } catch (e: any) {
      persistShared(s => ({ ...s, matching: false, result: null, error: e?.message || String(e) }))
      setError(e?.message || String(e))
    } finally { setMatching(false) }
  }

  const progressText = () => {
    if (!uploadProgress.active) return ''
    if (uploadProgress.step === 'uploading') return t('layer.uploading').replace('{percent}', String(uploadProgress.percent))
    if (uploadProgress.step === 'reading') return t('layer.reading')
    return t('layer.done')
  }

  const sheetSelectCls = "w-full h-9 px-2 text-sm border border-border rounded bg-card"

  return (
    <div className="p-8 max-w-6xl">
      <h1 className="text-base font-bold mb-6 flex items-center gap-2">
        <Ruler size={18} /> {t('nav.distanceMatch')}
      </h1>

      {/* ① 文件导入（顶层，单一上传框 + 模板下载） */}
      <div className="mb-6 p-4 bg-card border border-border rounded-lg">
        <p className="text-xs font-medium mb-3 flex items-center gap-2">
          <FileUp size={14} /> {t('distanceMatch.fileImport')}
          <button type="button" onClick={handleDownloadTemplate}
            className="ml-auto text-xs text-primary hover:underline">
            {t('distanceMatch.templateDownload')}
          </button>
        </p>

        <label className="block flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer hover:border-primary transition-colors">
          <UploadCloud className="text-muted-foreground shrink-0" size={20} />
          <span className="text-sm truncate flex-1">{fileName || t('distanceMatch.uploadHint')}</span>
          <input type="file" className="hidden" accept=".xlsx,.xls"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} disabled={uploading} />
        </label>

        {/* 上传进度条 + 状态 + 取消（模块级 uploadStore：切页不丢失） */}
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
        <p className="text-xs font-medium mb-4">{t('distanceMatch.dataSelect')}</p>

        {/* 匹配站点（来源固定为导入文件） */}
        <div className="mb-5">
          <p className="text-xs font-medium mb-1">{t('distanceMatch.matchSite')}</p>
          <div className="max-w-xs">
            <select value={matchSheet} onChange={e => setMatchSheet(e.target.value)}
              disabled={!sheetList.length} className={sheetSelectCls}>
              {!sheetList.length && <option value="">{t('distanceMatch.uploadHint')}</option>}
              {sheetList.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* 相邻站点（来源：导入文件 / 数据管理） */}
        <div>
          <p className="text-xs font-medium mb-1">{t('distanceMatch.fullSite')}</p>
          <div className="flex gap-4 mb-2">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" checked={fullSource === 'file'} onChange={() => handleFullSourceChange('file')} />
              {t('distanceMatch.fullSourceFile')}
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" checked={fullSource === 'data'} onChange={() => handleFullSourceChange('data')} />
              {t('distanceMatch.fullSourceData')}
            </label>
          </div>

          {fullSource === 'file' ? (
            <div className="max-w-xs">
              <select value={fullSheet} onChange={e => setFullSheet(e.target.value)}
                disabled={!sheetList.length} className={sheetSelectCls}>
                {!sheetList.length && <option value="">{t('distanceMatch.uploadHint')}</option>}
                {sheetList.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="dm-data-file" className="block text-xs font-medium mb-1">{t('distanceMatch.dataFile')}</label>
                <select id="dm-data-file" value={fullDataId}
                  onChange={e => { setFullDataId(e.target.value); setDataSheets([]); setFullSheet('') }}
                  className={sheetSelectCls}>
                  {dataItems.length === 0 && <option value="">{t('distanceMatch.loadDataErr')}</option>}
                  {dataItems.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="dm-data-sheet" className="block text-xs font-medium mb-1">{t('distanceMatch.sheetName')}</label>
                <select id="dm-data-sheet" value={fullSheet} onChange={e => setFullSheet(e.target.value)}
                  disabled={!dataSheets.length} className={sheetSelectCls}>
                  {!dataSheets.length && <option value="">{t('distanceMatch.uploadHint')}</option>}
                  {dataSheets.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ③ 参数设置 */}
      <div className="mb-6 p-4 bg-card border border-border rounded-lg">
        <p className="text-xs font-medium mb-3">{t('distanceMatch.params')}</p>
        <div className="max-w-xs">
          <label htmlFor="dm-max-distance" className="block text-xs font-medium mb-1">{t('distanceMatch.maxDistance')} (km)</label>
          <input id="dm-max-distance" value={maxDistanceKm} inputMode="decimal"
            onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setMaxDistanceKm(e.target.value) }}
            placeholder="1.0" className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
        </div>
      </div>

      {/* ④ 开始匹配 */}
      <div className="mb-6 p-4 bg-card border border-border rounded-lg">
        <button onClick={handleMatch} disabled={matching || uploading}
          className="w-full px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium">
          {matching ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
          {t('distanceMatch.start')}
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
            <AlertCircle size={14} /> {t('distanceMatch.invalidData')}
          </p>
          <div className="max-h-40 overflow-y-auto">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-amber-500/10">
                <tr className="border-b border-amber-500/20">
                  <th className="px-2 py-1 font-medium">{t('distanceMatch.sheet')}</th>
                  <th className="px-2 py-1 font-medium">{t('distanceMatch.row')}</th>
                  <th className="px-2 py-1 font-medium">{t('distanceMatch.reason')}</th>
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
                {t('distanceMatch.more').replace('{count}', String(parseErrors.length - 100))}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ⑤ 匹配结果下载 */}
      {result && (
        <div className="p-4 bg-card border border-border rounded-lg">
          <a href={result.download_url + '?_t=' + Date.now()} download
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-green-600 text-white rounded-lg hover:opacity-90 text-sm">
            <Download size={16} /> {t('distanceMatch.download')} ({result.filename})
          </a>
          <p className="mt-2 text-xs text-green-600 flex items-center gap-1">
            <CheckCircle2 size={14} /> {t('distanceMatch.matchDone')}
          </p>
        </div>
      )}
    </div>
  )
}
