import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, Loader2, Download, CheckCircle2, AlertCircle, Ruler, UploadCloud } from 'lucide-react'
import { distanceMatchApi, dataApi, layerToolsApi } from '../services/api'
import { uploadStore } from '../store/uploadStore'

type FullSource = 'upload' | 'data'

interface ParseError { sheet: string; row: number; reason: string }

export default function DistanceMatchPage() {
  const { t } = useTranslation()

  // ===== 匹配站点清单文件 =====
  const [matchFilePath, setMatchFilePath] = useState('')
  const [matchFileName, setMatchFileName] = useState('')

  // ===== 全量站点来源 =====
  const [fullSource, setFullSource] = useState<FullSource>('upload')
  const [fullFilePath, setFullFilePath] = useState('')
  const [fullFileName, setFullFileName] = useState('')
  const [dataItems, setDataItems] = useState<any[]>([])
  const [fullDataId, setFullDataId] = useState('')
  const [networkType, setNetworkType] = useState<'LTE' | 'NR'>('LTE')
  const [columns, setColumns] = useState<string[]>([])
  const [nameCol, setNameCol] = useState('')
  const [lonCol, setLonCol] = useState('')
  const [latCol, setLatCol] = useState('')

  // ===== 参数 =====
  const [maxDistanceKm, setMaxDistanceKm] = useState('')

  // ===== 状态 =====
  const [matching, setMatching] = useState(false)
  const [parseErrors, setParseErrors] = useState<ParseError[]>([])
  const [result, setResult] = useState<{ filename: string; download_url: string } | null>(null)
  const [error, setError] = useState('')

  // ===== 模块级上传进度（chunkedUpload 后台更新，切页不丢失）=====
  const [uploadProgress, setUploadProgress] = useState(uploadStore.get())
  useEffect(() => uploadStore.subscribe(setUploadProgress), [])
  const uploading = uploadProgress.active

  // 列加载请求序号（防过期响应）：切换数据文件时旧请求返回后丢弃
  const colReqRef = useRef(0)
  // 记录上次自动预选的数据文件 id：切换网络类型（文件未变）时保留用户手动映射
  const autoPickFileRef = useRef('')

  const resetMapping = () => { setNameCol(''); setLonCol(''); setLatCol('') }

  // 按 GeoFieldDetector 同源规则自动预选列映射
  const autoPick = (cols: string[]) => {
    const pick = (patterns: string[]) => {
      const lower = cols.map(c => c.toLowerCase())
      for (const p of patterns) {
        const idx = lower.indexOf(p.toLowerCase())
        if (idx >= 0) return cols[idx]
      }
      for (const p of patterns) {
        const idx = lower.findIndex(c => c.includes(p.toLowerCase()))
        if (idx >= 0) return cols[idx]
      }
      return ''
    }
    setNameCol(pick(['cell_name', 'sector_name', 'name', 'cellname', '小区名称', '小区名']) || cols[0] || '')
    setLonCol(pick(['longitude', 'lon', 'long', '经度']) || '')
    setLatCol(pick(['latitude', 'lat', '纬度']) || '')
  }

  // 数据管理下拉加载（excel + ready，默认高亮全量工参）
  useEffect(() => {
    dataApi.list(1, 100, true).then(res => {
      if (res.success && res.data) {
        const items = res.data.filter((d: any) => d.type === 'excel' && d.status === 'ready')
        setDataItems(items)
        const full = items.find((d: any) => (d.name || '').toLowerCase().includes('projectparameter_mongoose'))
        if (full) setFullDataId(full.id)
        else if (items[0]) setFullDataId(items[0].id)
      }
    }).catch(() => setError(t('distanceMatch.loadDataErr') || '加载数据列表失败'))
  }, [])

  // 数据文件 → 列加载 + 自动预选（防竞态 + 网络类型切换不清空手动映射）
  useEffect(() => {
    if (!fullDataId) {
      setColumns([]); resetMapping(); autoPickFileRef.current = ''
      return
    }
    const reqId = ++colReqRef.current
    const fileChanged = autoPickFileRef.current !== fullDataId
    dataApi.getColumns(fullDataId, networkType).then(res => {
      if (reqId !== colReqRef.current) return // 过期响应，忽略
      if (res.success && res.data?.columns) {
        const cols = res.data.columns
        setColumns(cols)
        if (fileChanged) {
          // 数据文件切换：全量自动预选
          autoPick(cols)
          autoPickFileRef.current = fullDataId
        } else {
          // 网络类型切换（数据文件未变）：保留用户手动映射，仅清理已不存在的列
          const nextName = nameCol && cols.includes(nameCol) ? nameCol : ''
          const nextLon = lonCol && cols.includes(lonCol) ? lonCol : ''
          const nextLat = latCol && cols.includes(latCol) ? latCol : ''
          if (!nextName && !nextLon && !nextLat) {
            autoPick(cols)
            autoPickFileRef.current = fullDataId
          } else {
            setNameCol(nextName); setLonCol(nextLon); setLatCol(nextLat)
          }
        }
      } else {
        setColumns([]); resetMapping()
      }
    }).catch(() => {
      if (reqId === colReqRef.current) { setColumns([]); resetMapping() }
    })
  }, [fullDataId, networkType])

  const handleMatchFile = async (f: File) => {
    setParseErrors([]); setError(''); setResult(null)
    uploadStore._set({ active: true, percent: 1, step: 'uploading', sessionId: '', fileName: f.name })
    try {
      const up = await layerToolsApi.uploadLayerFile(f)
      setMatchFilePath(up.file_path)
      setMatchFileName(f.name)
      // 导入时校验（设计 §4）：/parse 校验失败 → 错误明细立即展示
      uploadStore._set({ active: true, percent: 100, step: 'reading', sessionId: '', fileName: f.name })
      try {
        const parseRes = await distanceMatchApi.parse(up.file_path)
        if (parseRes.data?.errors?.length) {
          setParseErrors(parseRes.data.errors)
        }
      } catch (parseErr: any) {
        setError(parseErr?.message || String(parseErr))
      }
    } catch (e: any) {
      if (e?.message === '已取消') {
        uploadStore._set({ active: false, step: '', sessionId: '', fileName: '' })
        return
      }
      setError(e?.message || String(e))
    } finally { uploadStore._set({ active: false }) }
  }

  const handleFullFile = async (f: File) => {
    setParseErrors([]); setError(''); setResult(null)
    uploadStore._set({ active: true, percent: 1, step: 'uploading', sessionId: '', fileName: f.name })
    try {
      const up = await layerToolsApi.uploadLayerFile(f)
      setFullFilePath(up.file_path)
      setFullFileName(f.name)
    } catch (e: any) {
      if (e?.message === '已取消') {
        uploadStore._set({ active: false, step: '', sessionId: '', fileName: '' })
        return
      }
      setError(e?.message || String(e))
    } finally { uploadStore._set({ active: false }) }
  }

  const handleMatch = async () => {
    setError(''); setResult(null)
    // 导入校验未通过时阻止匹配，提示用户修复后重新导入
    if (parseErrors.length > 0) {
      setError(t('distanceMatch.errFixImport') || '请先修复导入数据的异常后重新导入')
      return
    }
    setParseErrors([])
    const km = parseFloat(maxDistanceKm)
    if (!matchFilePath) { setError(t('distanceMatch.errNoFile') || '请先导入匹配站点清单'); return }
    if (!(km > 0)) { setError(t('distanceMatch.errThreshold') || '请输入大于 0 的距离门限'); return }
    if (fullSource === 'data' && (!fullDataId || !nameCol || !lonCol || !latCol)) {
      setError(t('distanceMatch.errMapping') || '请选择数据文件并配置完整列映射'); return
    }

    setMatching(true)
    try {
      const res = await distanceMatchApi.match({
        matchFilePath,
        maxDistanceKm: km,
        fullFilePath: fullSource === 'upload' ? fullFilePath : undefined,
        fullDataId: fullSource === 'data' ? fullDataId : undefined,
        fullNetworkType: networkType,
        fullNameCol: nameCol, fullLonCol: lonCol, fullLatCol: latCol,
      })
      if (res.success && res.data?.download_url) {
        setResult({ filename: res.data.filename, download_url: res.data.download_url })
      } else if (res.data?.errors?.length) {
        setParseErrors(res.data.errors)
      } else {
        setError(t('distanceMatch.errUnknown') || '匹配失败，请重试')
      }
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally { setMatching(false) }
  }

  const progressText = () => {
    if (!uploadProgress.active) return ''
    if (uploadProgress.step === 'uploading') return t('layer.uploading').replace('{percent}', String(uploadProgress.percent))
    if (uploadProgress.step === 'reading') return t('layer.reading')
    return t('layer.done')
  }

  return (
    <div className="p-8 max-w-6xl">
      <h1 className="text-base font-bold mb-6 flex items-center gap-2">
        <Ruler size={18} /> {t('nav.distanceMatch')}
      </h1>

      {/* ① 文件导入 */}
      <div className="mb-6 p-4 bg-card border border-border rounded-lg">
        <p className="text-xs font-medium mb-3 flex items-center gap-2">
          <FileUp size={14} /> {t('distanceMatch.fileImport')}
          <button type="button" onClick={() => distanceMatchApi.downloadTemplate()}
            className="ml-auto text-xs text-primary hover:underline">
            {t('distanceMatch.templateDownload')}
          </button>
        </p>

        <p className="text-xs text-muted-foreground mb-1">{t('distanceMatch.matchFile')}</p>
        <label className="block flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer hover:border-primary transition-colors">
          <UploadCloud className="text-muted-foreground shrink-0" size={20} />
          <span className="text-sm truncate flex-1">{matchFileName || t('distanceMatch.uploadHint')}</span>
          <input type="file" className="hidden" accept=".xlsx,.xls"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleMatchFile(f) }} disabled={uploading} />
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

        <div className="mt-4">
          <p className="text-xs font-medium mb-2">{t('distanceMatch.fullSource')}</p>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" checked={fullSource === 'upload'} onChange={() => setFullSource('upload')} />
              {t('distanceMatch.fullUpload')}
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" checked={fullSource === 'data'} onChange={() => setFullSource('data')} />
              {t('distanceMatch.fullData')}
            </label>
          </div>

          {fullSource === 'upload' ? (
            <label className="mt-2 block flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer hover:border-primary transition-colors">
              <UploadCloud className="text-muted-foreground shrink-0" size={20} />
              <span className="text-sm truncate flex-1">{fullFileName || t('distanceMatch.uploadHint')}</span>
              <input type="file" className="hidden" accept=".xlsx,.xls"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFullFile(f) }} disabled={uploading} />
            </label>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="dm-data-file" className="block text-xs font-medium mb-1">{t('distanceMatch.dataFile')}</label>
                <select id="dm-data-file" value={fullDataId} onChange={e => setFullDataId(e.target.value)}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
                  {dataItems.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="dm-network-type" className="block text-xs font-medium mb-1">{t('distanceMatch.networkType')}</label>
                <select id="dm-network-type" value={networkType} onChange={e => setNetworkType(e.target.value as 'LTE' | 'NR')}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
                  <option value="LTE">LTE</option>
                  <option value="NR">NR</option>
                </select>
              </div>
              <div>
                <label htmlFor="dm-name-col" className="block text-xs font-medium mb-1">{t('distanceMatch.nameCol')}</label>
                <select id="dm-name-col" value={nameCol} onChange={e => setNameCol(e.target.value)}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="dm-lon-col" className="block text-xs font-medium mb-1">{t('distanceMatch.lonCol')}</label>
                <select id="dm-lon-col" value={lonCol} onChange={e => setLonCol(e.target.value)}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="dm-lat-col" className="block text-xs font-medium mb-1">{t('distanceMatch.latCol')}</label>
                <select id="dm-lat-col" value={latCol} onChange={e => setLatCol(e.target.value)}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ② 参数设置 */}
      <div className="mb-6 p-4 bg-card border border-border rounded-lg">
        <p className="text-xs font-medium mb-3">{t('distanceMatch.params')}</p>
        <div className="max-w-xs">
          <label htmlFor="dm-max-distance" className="block text-xs font-medium mb-1">{t('distanceMatch.maxDistance')} (km)</label>
          <input id="dm-max-distance" value={maxDistanceKm} inputMode="decimal"
            onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setMaxDistanceKm(e.target.value) }}
            placeholder="1.0" className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
        </div>
      </div>

      {/* ③ 开始匹配 */}
      <div className="mb-6 p-4 bg-card border border-border rounded-lg">
        <button onClick={handleMatch} disabled={matching || uploading}
          className="w-full px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium">
          {matching ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
          {t('distanceMatch.start')}
        </button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* 校验错误明细 */}
      {parseErrors.length > 0 && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg text-xs">
          <p className="text-amber-700 font-medium mb-2 flex items-center gap-1">
            <AlertCircle size={14} /> {t('distanceMatch.invalidData')}
          </p>
          <div className="max-h-40 overflow-y-auto">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-amber-50">
                <tr className="border-b border-amber-200">
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

      {/* ④ 匹配结果下载 */}
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
