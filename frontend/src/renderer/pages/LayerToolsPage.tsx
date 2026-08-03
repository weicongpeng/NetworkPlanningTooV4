import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import * as Tabs from '@radix-ui/react-tabs'
import * as Select from '@radix-ui/react-select'
import { FileUp, Loader2, Download, CheckCircle2, ChevronDown } from 'lucide-react'
import { layerToolsApi, type LayerExcelInfo, type GenerateLayerResult } from '../services/api'
import { uploadStore } from '../store/uploadStore'
import { LayerAttributeConfig } from '../components/layer/LayerAttributeConfig'
import { LAYER_DEFAULT_PARAMS, PRESET_COLORS } from '../config/layer-config'

type LayerFormat = 'tab' | 'mif' | 'kml'
const ALL_FORMATS: LayerFormat[] = ['tab', 'mif', 'kml']

// 页面级共享文件状态：一份文件同时作用于扇区/点图两个 Tab
interface SharedFile {
  filePath: string
  sourceFilename: string
  fileName: string
  sheetName: string
  info: LayerExcelInfo | null
  columns: string[]
}

const SHARED_STORAGE_KEY = 'layerTools.shared'

function emptySharedFile(): SharedFile {
  return { filePath: '', sourceFilename: '', fileName: '', sheetName: '', info: null, columns: [] }
}

function loadSharedFile(): SharedFile {
  try {
    const raw = sessionStorage.getItem(SHARED_STORAGE_KEY)
    if (raw) return { ...emptySharedFile(), ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return emptySharedFile()
}

interface TabState {
  _v: number              // 状态版本标记：2=已迁移到 0-100 透明度语义；迁移只对旧版 payload 执行一次
  selectedFields: Record<string, string>
  fieldMappings: Record<string, string>
  radiusM: string          // 字符串受控，避免删空变 0 / 前导 0
  beamwidth: string
  lineWidth: string
  pointSize: string
  pointShape: string
  borderColor: string      // 边框颜色（扇区）
  fillColor: string        // 填充颜色（扇区内部；点图存颜色用）
  opacity: string          // 透明度 0-100（字符串受控；0=不透明，100=全透明）
  color: string            // 旧字段兼容（保留读写，避免旧 sessionStorage 数据丢失）
  formats: LayerFormat[]   // 多格式勾选
  result: GenerateLayerResult | null
  error: string
}

const STORAGE_KEYS = { sector: 'layerTools.sector', point: 'layerTools.point' }

function emptyTabState(type: 'sector' | 'point'): TabState {
  const dp = type === 'sector' ? LAYER_DEFAULT_PARAMS.sector : LAYER_DEFAULT_PARAMS.point
  return {
    _v: 2,                 // 当前版本：0-100 透明度语义
    selectedFields: {},
    fieldMappings: {},
    radiusM: type === 'sector' ? String(LAYER_DEFAULT_PARAMS.sector.radiusM) : '',
    beamwidth: type === 'sector' ? String(LAYER_DEFAULT_PARAMS.sector.beamwidth) : '',
    lineWidth: type === 'sector' ? String(LAYER_DEFAULT_PARAMS.sector.lineWidth) : '',
    pointSize: type === 'point' ? String(LAYER_DEFAULT_PARAMS.point.pointSize) : '',
    pointShape: type === 'point' ? LAYER_DEFAULT_PARAMS.point.pointShape : '',
    borderColor: dp.borderColor,
    // 点图 Tab 用 fillColor 存颜色（后端点图颜色按边框语义应用，border_color 接收 fillColor）
    fillColor: type === 'sector' ? LAYER_DEFAULT_PARAMS.sector.fillColor : dp.borderColor,
    opacity: String(dp.opacity),
    color: dp.borderColor,   // 旧字段兼容
    formats: ['tab', 'mif', 'kml'],
    result: null,
    error: '',
  }
}

// 从 sessionStorage 恢复状态（页面内保留：切换路由切回后不丢失）
function loadState(key: string, type: 'sector' | 'point'): TabState {
  try {
    const raw = sessionStorage.getItem(key)
    if (raw) {
      const saved = JSON.parse(raw)
      // 已带版本标记（_v === 2）→ 已迁移过，直接采用，不再跑启发式迁移（避免每次刷新改掉用户重输的值）
      if (saved._v === 2) return { ...emptyTabState(type), ...saved }
      // 旧版（v1）payload 迁移，仅执行一次：
      // 迁移1：旧版只有 color（原"填充颜色"实为边框色），新版拆分为 borderColor/fillColor/opacity
      if (saved.color && !saved.borderColor) saved.borderColor = saved.color
      if (saved.color && !saved.fillColor && type === 'sector') saved.fillColor = saved.color
      // 迁移2：点图旧 borderColor（存着颜色值）→ 新 fillColor（点图 Tab 用 fillColor 存颜色）
      if (type === 'point' && saved.borderColor && !saved.fillColor) saved.fillColor = saved.borderColor
      // 迁移3：透明度语义从 0-1（不透明度）反转为 0-100（透明度）。旧 0.6（不透明度 60%）→ 新 40
      // 检测旧语义：数值在 (0,1] 区间（旧值范围）。排除 0：新默认 0（完全不透明）会在挂载后立即写入
      // sessionStorage，若把 0 也当旧值迁移，页面刷新会把默认值 0 错迁为 100（全透明）
      const savedOpacity = Number(saved.opacity)
      if (saved.opacity !== undefined && saved.opacity !== '' && savedOpacity > 0 && savedOpacity <= 1) {
        saved.opacity = String(Math.round((1 - savedOpacity) * 100))
      }
      return { ...emptyTabState(type), ...saved, _v: 2 }
    }
  } catch { /* ignore */ }
  return emptyTabState(type)
}

function saveState(key: string, s: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(s)) } catch { /* ignore */ }
}

export default function LayerToolsPage() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'sector' | 'point'>('sector')
  const [sectorState, setSectorState] = useState<TabState>(() => loadState(STORAGE_KEYS.sector, 'sector'))
  const [pointState, setPointState] = useState<TabState>(() => loadState(STORAGE_KEYS.point, 'point'))
  // 页面级共享文件（一份文件同时作用于扇区/点图两个 Tab）——模块级 store，
  // 切页不丢失：上传/解析完成后写入模块级 + sessionStorage，组件卸载后成功结果仍保留
  const [sharedFile, setSharedFile] = useState<SharedFile>(() => loadSharedFile())
  // 模块级 ref：persistSharedFile 里读取最新 sharedFile（避免闭包过期）
  const sharedFileRef = useRef(sharedFile)
  // 保持 ref 与 state 同步
  useEffect(() => { sharedFileRef.current = sharedFile }, [sharedFile])
  // persistSharedFile：直接计算新值并写 sessionStorage（不依赖 React setState 执行，
  // 否则 getExcelInfo 完成时组件已卸载 → updater 不执行 → sessionStorage 未写入 → 切回空文件）
  const persistSharedFile = (f: SharedFile | ((prev: SharedFile) => SharedFile)) => {
    const next = typeof f === 'function' ? f(sharedFileRef.current) : f
    sharedFileRef.current = next
    saveState(SHARED_STORAGE_KEY, next)
    setSharedFile(next)
  }
  const [generating, setGenerating] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  // 模块级上传进度：chunkedUpload 后台更新，切页不丢失，本组件订阅实时渲染
  const [uploadProgress, setUploadProgress] = useState(uploadStore.get())
  useEffect(() => uploadStore.subscribe(setUploadProgress), [])
  const uploading = uploadProgress.active

  // 持久化：state 变化写 sessionStorage
  useEffect(() => saveState(STORAGE_KEYS.sector, sectorState), [sectorState])
  useEffect(() => saveState(STORAGE_KEYS.point, pointState), [pointState])

  // 当前激活 Tab 的 state
  const state = activeTab === 'sector' ? sectorState : pointState
  const setState = (updater: (s: TabState) => TabState) => {
    if (activeTab === 'sector') setSectorState(s => updater(s))
    else setPointState(s => updater(s))
  }

  const isSector = activeTab === 'sector'

  // 点形状选项（KML SVG / MIF Symbol shape 编号一致；icon 为形状预览 SVG）
  const POINT_SHAPES = [
    { value: 'circle', label: t('layer.shapeCircle'),
      icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 shrink-0"><circle cx="8" cy="8" r="6" fill="currentColor" /></svg> },
    { value: 'square', label: t('layer.shapeSquare'),
      icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 shrink-0"><rect x="2" y="2" width="12" height="12" fill="currentColor" /></svg> },
    { value: 'diamond', label: t('layer.shapeDiamond'),
      icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 shrink-0"><polygon points="8,2 14,8 8,14 2,8" fill="currentColor" /></svg> },
    { value: 'triangle', label: t('layer.shapeTriangle'),
      icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 shrink-0"><polygon points="8,2 14,14 2,14" fill="currentColor" /></svg> },
    { value: 'triangle_down', label: t('layer.shapeTriangleDown'),
      icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 shrink-0"><polygon points="2,2 14,2 8,14" fill="currentColor" /></svg> },
    { value: 'landmark', label: t('layer.shapeLandmark'),
      icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 shrink-0"><rect x="3" y="6" width="10" height="8" fill="currentColor" /><rect x="4" y="2" width="8" height="2" fill="currentColor" /></svg> },
    { value: 'pin', label: t('layer.shapePin'),
      icon: <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 shrink-0"><path d="M8 1c-3 0-5 2-5 5 0 3 5 9 5 9s5-6 5-9c0-3-2-5-5-5z" fill="currentColor" /></svg> },
  ]

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    await processFile(f)
  }

  // 处理单个文件（点击选择 / 拖拽导入共用）
  const processFile = async (f: File) => {
    // 上传中忽略新的 drop/点击，避免并发重复上传
    if (uploading) return
    // 重新导入：文件变化 → 清空两个 Tab 的旧结果/错误（result 绑定 sharedFile，
    // 保证切换 Tab 后不会显示指向旧文件的失效下载按钮）
    setSectorState(s => ({ ...s, result: null, error: '' }))
    setPointState(s => ({ ...s, result: null, error: '' }))
    // 导入区是页面级共享的：上传前清空共享文件（只作用于共享状态，两个 Tab 的配置各自保留）
    persistSharedFile(() => emptySharedFile())
    // 模块级进度：chunkedUpload 内部 trackProgress 会写入并暴露取消句柄
    uploadStore._set({ active: true, percent: 1, step: 'uploading', sessionId: '', fileName: f.name })
    try {
      const up = await layerToolsApi.uploadLayerFile(f, (p) => {
        // 进度回调同步模块级（chunkedUpload 已写 percent，此处补 step）
        uploadStore._set({ percent: p.percent, step: p.step })
      })
      uploadStore._set({ percent: 100, step: 'reading' })
      const data = await layerToolsApi.getExcelInfo(up.file_path, up.source_filename)
      persistSharedFile(() => ({
        filePath: up.file_path,
        sourceFilename: up.source_filename,
        fileName: f.name,
        info: data,
        sheetName: data.sheets[0] || '',
        columns: data.columns[data.sheets[0]] || [],
      }))
    } catch (err: any) {
      // 用户主动取消：不提示错误（chunkedUpload 抛'已取消'），静默复位
      if (err?.message === '已取消') {
        uploadStore._set({ active: false, step: '', sessionId: '', fileName: '' })
        uploadStore._setCancel(null)
        return
      }
      // 上传失败：共享文件已清空，错误提示到两个 Tab 各自的 error 上
      const msg = err?.message || String(err)
      setSectorState(s => ({ ...s, error: msg }))
      setPointState(s => ({ ...s, error: msg }))
    } finally {
      uploadStore._set({ active: false })
    }
  }

  const handleGenerate = async () => {
    if (!sharedFile.filePath || !sharedFile.sheetName) {
      setState(s => ({ ...s, error: t('layer.errSheet') }))
      return
    }
    if (state.formats.length === 0) {
      setState(s => ({ ...s, error: t('layer.errNoFormat') }))
      return
    }
    if (isSector) {
      if (!state.fieldMappings.name || !state.fieldMappings.longitude || !state.fieldMappings.latitude || !state.fieldMappings.azimuth) {
        setState(s => ({ ...s, error: t('layer.errMissingFields') }))
        return
      }
    } else {
      if (!state.fieldMappings.name || !state.fieldMappings.longitude || !state.fieldMappings.latitude) {
        setState(s => ({ ...s, error: t('layer.errMissingFieldsPoint') }))
        return
      }
    }
    setGenerating(true)
    setState(s => ({ ...s, error: '', result: null }))
    try {
      // 透明度：前端 0-100 滑块值 → 后端 opacity(0-1，语义为透明度)
      // v=0 → opacity=0 → 不透明；v=100 → opacity=1 → 全透明。注意不是 (100-v)/100！
      const v = Number.isFinite(parseFloat(state.opacity)) ? parseFloat(state.opacity) : 0
      const base = {
        filePath: sharedFile.filePath,
        sourceFilename: sharedFile.sourceFilename,
        sheetName: sharedFile.sheetName,
        nameCol: state.fieldMappings.name,
        lonCol: state.fieldMappings.longitude,
        latCol: state.fieldMappings.latitude,
        attributes: Object.values(state.selectedFields),
        outputFormats: state.formats,
        color: isSector ? state.borderColor : state.fillColor,
        borderColor: isSector ? state.borderColor : state.fillColor,
        fillColor: state.fillColor,
        lineWidth: parseInt(state.lineWidth) || 2,
        pointSize: parseFloat(state.pointSize) || LAYER_DEFAULT_PARAMS.point.pointSize,
        pointShape: state.pointShape,
        opacity: v / 100
      }
      const data = isSector
        ? await layerToolsApi.generateSector({
            ...base,
            azimuthCol: state.fieldMappings.azimuth,
            radiusM: parseFloat(state.radiusM) || LAYER_DEFAULT_PARAMS.sector.radiusM,
            beamwidth: parseFloat(state.beamwidth) || LAYER_DEFAULT_PARAMS.sector.beamwidth,
          })
        : await layerToolsApi.generatePoint(base)
      setState(s => ({ ...s, result: data }))
    } catch (err: any) {
      // 文件过期（后端 TTL 清理后 file_path 失效）→ 清空共享文件提示重新导入
      const msg = err?.message || String(err)
      if (/文件不存在|文件已过期/.test(msg)) {
        persistSharedFile(() => ({ ...emptySharedFile() }))
        setState(s => ({ ...s, error: t('layer.fileExpired') }))
      } else {
        setState(s => ({ ...s, error: msg }))
      }
    } finally {
      setGenerating(false)
    }
  }

  const progressText = () => {
    if (!uploadProgress.active) return ''
    if (uploadProgress.step === 'uploading') return t('layer.uploading').replace('{percent}', String(uploadProgress.percent))
    if (uploadProgress.step === 'reading') return t('layer.reading')
    return t('layer.done')
  }

  const formatFailures = (failures: Record<string, number>, labels: Record<string, string>) => {
    return Object.entries(failures)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${labels[k] || k} ${v}`)
      .join(' · ')
  }

  // 参数输入框（字符串受控，只允许数字/小数点）
  const numberInput = (value: string, onChange: (v: string) => void) => ({
    type: 'text' as const,
    inputMode: 'numeric' as const,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      if (/^\d*\.?\d*$/.test(e.target.value)) onChange(e.target.value)
    },
  })

  // 常用色块快捷选择
  const colorSwatches = (value: string, onChange: (v: string) => void) => (
    <div className="flex flex-wrap gap-1 mt-1">
      {PRESET_COLORS.map(c => {
        const selected = value.toLowerCase() === c.toLowerCase()
        return (
          <button key={c} type="button"
            onClick={() => onChange(c)}
            aria-label={t('layer.colorSwatch', { color: c })}
            aria-pressed={selected}
            title={c}
            className={`w-5 h-5 rounded-sm border ${selected ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
            style={{ backgroundColor: c }} />
        )
      })}
    </div>
  )

  const renderParams = (ts: TabState, setTab: (u: (s: TabState) => TabState) => void) => (
    <div className="grid grid-cols-2 gap-4">
      {isSector ? (
        // 扇区：半径 / 波瓣夹角 / 线宽 同一行（3 列）
        <div className="col-span-2 grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium mb-1">{t('layer.radius')} (m)</label>
            <input {...numberInput(ts.radiusM, (v) => setTab(s => ({ ...s, radiusM: v })))}
              className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">{t('layer.beamwidth')} (°)</label>
            <input {...numberInput(ts.beamwidth, (v) => setTab(s => ({ ...s, beamwidth: v })))}
              className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">{t('layer.lineWidth')}</label>
            <input {...numberInput(ts.lineWidth, (v) => setTab(s => ({ ...s, lineWidth: v })))}
              placeholder="2" className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
          </div>
        </div>
      ) : (
        // 点图：点大小 / 点形状 同一行（2 列）
        <div className="col-span-2 grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium mb-1">{t('layer.pointSize')}</label>
            <input {...numberInput(ts.pointSize, (v) => setTab(s => ({ ...s, pointSize: v })))}
              className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">{t('layer.pointShape')}</label>
            <ShapeSelect
              value={ts.pointShape}
              shapes={POINT_SHAPES}
              onValueChange={(v) => setTab(s => ({ ...s, pointShape: v }))}
            />
          </div>
        </div>
      )}
      {/* 颜色：扇区显示"边框颜色"（borderColor state）；点图显示"填充颜色"（fillColor state） */}
      <div>
        <label className="block text-xs font-medium mb-1">
          {isSector ? t('layer.borderColor') : t('layer.fillColor')}
        </label>
        <input type="color" value={isSector ? ts.borderColor : ts.fillColor}
          onChange={e => isSector
            ? setTab(s => ({ ...s, borderColor: e.target.value, color: e.target.value }))
            : setTab(s => ({ ...s, fillColor: e.target.value, color: e.target.value }))}
          className="w-full h-9 cursor-pointer" />
        {colorSwatches(isSector ? ts.borderColor : ts.fillColor, (v) => isSector
          ? setTab(s => ({ ...s, borderColor: v, color: v }))
          : setTab(s => ({ ...s, fillColor: v, color: v })))}
      </div>
      {/* 填充颜色（仅扇区；点图颜色已由上面"填充颜色"块承载） */}
      {isSector && (
        <div>
          <label className="block text-xs font-medium mb-1">{t('layer.fillColor')}</label>
          <input type="color" value={ts.fillColor} onChange={e => setTab(s => ({ ...s, fillColor: e.target.value }))}
            className="w-full h-9 cursor-pointer" />
          {colorSwatches(ts.fillColor, (v) => setTab(s => ({ ...s, fillColor: v })))}
        </div>
      )}
      {/* 透明度 0-100：0=不透明，100=全透明（仅扇区；点图无透明度概念） */}
      {isSector && (
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-1">{t('layer.opacity')}</label>
          <input {...numberInput(ts.opacity, (v) => setTab(s => ({ ...s, opacity: v })))}
            placeholder="0"
            className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
          <p className="text-[10px] text-muted-foreground mt-1">{t('layer.opacityHint')}</p>
        </div>
      )}
      {/* 输出格式多选勾选 */}
      <div className="col-span-2">
        <label className="block text-xs font-medium mb-1">{t('layer.formats')}</label>
        <div className="flex gap-4">
          {ALL_FORMATS.map(fmt => (
            <label key={fmt} className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={ts.formats.includes(fmt)}
                onChange={e => {
                  const formats = e.target.checked
                    ? [...ts.formats, fmt]
                    : ts.formats.filter(f => f !== fmt)
                  if (formats.length > 0) setTab(s => ({ ...s, formats }))
                }}
              />
              {fmt.toUpperCase()}
            </label>
          ))}
        </div>
        {ts.formats.includes('tab') && !ts.formats.some(f => f !== 'tab') && (
          <p className="text-[10px] text-muted-foreground mt-1">{t('layer.colorTabHint')}</p>
        )}
      </div>
    </div>
  )

  const reasonLabel = (reason: string): string => {
    const map: Record<string, string> = {
      missing_coord: t('layer.statsMissingCoord'),
      invalid_coord: t('layer.statsInvalidCoord'),
      invalid_azimuth: t('layer.statsInvalidAzimuth'),
      missing_name: t('layer.statsMissingName'),
    }
    return map[reason] || reason
  }

  const renderResult = (ts: TabState) => ts.result && (
    <div className="mt-3">
      <a href={ts.result.download_url + '?_t=' + Date.now()} download
        className="w-full inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-green-600 text-white rounded-lg hover:opacity-90 text-sm">
        <Download size={16} /> {t('layer.download')} ({ts.result.filename})
      </a>
      {ts.result.stats && (
        <div className="mt-2 text-xs space-y-1">
          <p className="text-green-600 flex items-center gap-1">
            <CheckCircle2 size={14} />
            {t('layer.statsTotal')} {ts.result.stats.total} | {t('layer.statsSuccess')} {ts.result.stats.success}
            {ts.result.stats.failed > 0 && ` | ${t('layer.statsFailed')} ${ts.result.stats.failed}`}
          </p>
          {ts.result.stats.failed > 0 && (
            <p className="text-amber-600">
              {t('layer.statsFailures')}: {formatFailures(ts.result.stats.failures, {
                missing_coord: t('layer.statsMissingCoord'),
                invalid_coord: t('layer.statsInvalidCoord'),
                invalid_azimuth: t('layer.statsInvalidAzimuth'),
                missing_name: t('layer.statsMissingName'),
              })}
            </p>
          )}

          {/* 失败小区明细列表（可展开） */}
          {ts.result.stats.failed > 0 && ts.result.stats.failedDetails && ts.result.stats.failedDetails.length > 0 && (
            <details className="mt-2">
              <summary className="text-amber-600 cursor-pointer text-xs flex items-center gap-1">
                {t('layer.statsFailures')} ({ts.result.stats.failed})
              </summary>
              <div className="max-h-40 overflow-y-auto mt-1 border border-border rounded-lg text-xs">
                <table className="w-full text-left">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border">
                      <th className="px-2 py-1 font-medium">{t('layer.statsRow')}</th>
                      <th className="px-2 py-1 font-medium">{t('layer.statsName')}</th>
                      <th className="px-2 py-1 font-medium">{t('layer.statsReason')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ts.result.stats.failedDetails.slice(0, 100).map((d, i) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="px-2 py-1">{d.row}</td>
                        <td className="px-2 py-1 truncate max-w-[8rem]">{d.name || '-'}</td>
                        <td className="px-2 py-1">{reasonLabel(d.reason)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {ts.result.stats.failedDetails.length > 100 && (
                  <p className="px-2 py-1 text-muted-foreground">
                    {t('layer.statsMore').replace('{count}', String(ts.result.stats.failedDetails.length - 100))}
                  </p>
                )}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  )

  // 渲染 Tab 内容（扇区/点图共用骨架，参数和校验差异；文件共享，读 sharedFile）
  const renderTabContent = (
    ts: TabState,
    setTab: (u: (s: TabState) => TabState) => void,
    file: SharedFile,
    onSheetChange: (sheet: string) => void,
    includeAzimuth: boolean,
  ) => (
    <div className="grid grid-cols-5 gap-6">
      {/* 左栏（3/5） */}
      <div className="col-span-3 space-y-6">
        {/* ② Sheet 选择 */}
        <div className="p-4 bg-card border border-border rounded-lg">
          <label htmlFor={`layer-sheet-${activeTab}`} className="block text-xs font-medium mb-2">{t('layer.selectSheet')}</label>
          <select id={`layer-sheet-${activeTab}`} value={file.sheetName}
            onChange={e => onSheetChange(e.target.value)}
            disabled={!file.info || file.info.sheets.length <= 1}
            className="w-full h-9 px-2 text-sm border border-border rounded bg-card disabled:opacity-50">
            {file.info && file.info.sheets.length > 0
              ? file.info.sheets.map(s => <option key={s} value={s}>{s}</option>)
              : <option value="">{t('layer.importHint')}</option>}
          </select>
        </div>

        {/* ③ 属性配置 */}
        <div className="p-4 bg-card border border-border rounded-lg">
          <LayerAttributeConfig
            columns={file.columns}
            includeAzimuth={includeAzimuth}
            selectedFields={ts.selectedFields}
            onSelectedFieldsChange={(v) => setTab(s => ({ ...s, selectedFields: v }))}
            fieldMappings={ts.fieldMappings}
            onFieldMappingsChange={(v) => setTab(s => ({ ...s, fieldMappings: v }))}
          />
        </div>
      </div>

      {/* 右栏（2/5） */}
      <div className="col-span-2 space-y-6">
        {/* ④ 参数设置 */}
        <div className="p-4 bg-card border border-border rounded-lg">
          <p className="text-xs font-medium mb-3">{t('layer.params')}</p>
          {renderParams(ts, setTab)}
        </div>

        {/* ⑤ 生成 + 下载 */}
        <div className="p-4 bg-card border border-border rounded-lg">
          <button onClick={handleGenerate} disabled={generating || !file.filePath || !file.sheetName}
            className="w-full px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium">
            {generating ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
            {t('layer.generate')}
          </button>
          {renderResult(ts)}
        </div>
      </div>
    </div>
  )

  // 共享文件 Sheet 切换：只改 sharedFile（两个 Tab 的配置各自保留）
  const handleSheetChange = (sheet: string) => {
    persistSharedFile(f => ({ ...f, sheetName: sheet, columns: f.info?.columns[sheet] || [] }))
  }

  // 切换 Tab：清空非激活 Tab 的旧下载结果（按钮+统计），避免交叉显示；配置各自保留
  const handleTabChange = (v: 'sector' | 'point') => {
    setActiveTab(v)
    if (v === 'point') setSectorState(s => ({ ...s, result: null }))
    else setPointState(s => ({ ...s, result: null }))
  }

  return (
    <div className="p-8 max-w-6xl">
      <h1 className="text-base font-bold mb-6">{t('nav.layerTools')}</h1>

      <Tabs.Root value={activeTab} onValueChange={(v) => handleTabChange(v as 'sector' | 'point')}>
        {/* ① 文件导入（共享，最上层，宽度与下方左栏卡片对齐：grid-cols-5 中占 col-span-3） */}
        <div className="mb-6 grid grid-cols-5 gap-6">
          <div className="col-span-3 p-4 bg-card border border-border rounded-lg">
            <p className="text-xs font-medium mb-3">{t('layer.fileImport')}</p>
            <label
              onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
              onDragLeave={(e) => {
                // 仅在真正离开 label（而非移到内部子元素）时取消高亮，避免拖拽高亮闪烁
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragActive(false)
              }}
              onDrop={(e) => { e.preventDefault(); setDragActive(false); const f = e.dataTransfer.files?.[0]; if (f) processFile(f) }}
              className={`block flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${dragActive ? 'border-primary bg-primary/5' : 'border-border hover:border-primary'}`}>
              <FileUp className="text-muted-foreground shrink-0" size={20} />
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">{sharedFile.fileName || (dragActive ? t('layer.dropHere') : t('layer.uploadExcel'))}</p>
                <p className="text-xs text-muted-foreground">{t('layer.acceptExcel')}</p>
              </div>
              <input type="file" className="hidden" accept=".xlsx,.xls,.txt,.csv" onChange={handleFile} disabled={uploading} />
            </label>

            {/* 进度条 + 状态（模块级进度：切页不丢失，回来实时恢复）+ 取消按钮 */}
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
        </div>

        {/* ② 扇区/点图 Tab（下移） */}
        <Tabs.List className="flex gap-2 mb-6 border-b border-border" aria-label={t('nav.layerTools')}>
          <Tabs.Trigger value="sector"
            className="px-4 py-2 text-sm font-medium rounded-t-lg transition-colors data-[state=active]:bg-card data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:text-foreground">
            {t('layer.sectorLayer')}
          </Tabs.Trigger>
          <Tabs.Trigger value="point"
            className="px-4 py-2 text-sm font-medium rounded-t-lg transition-colors data-[state=active]:bg-card data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:text-foreground">
            {t('layer.pointLayer')}
          </Tabs.Trigger>
        </Tabs.List>

        {/* 扇区 Tab */}
        <Tabs.Content value="sector" className="mt-6 data-[state=inactive]:hidden">
          {renderTabContent(sectorState, (u) => setSectorState(s => u(s)), sharedFile, handleSheetChange, true)}
          {sectorState.error && <p className="mt-4 text-xs text-red-500">{sectorState.error}</p>}
        </Tabs.Content>

        {/* 点图 Tab */}
        <Tabs.Content value="point" className="mt-6 data-[state=inactive]:hidden">
          {renderTabContent(pointState, (u) => setPointState(s => u(s)), sharedFile, handleSheetChange, false)}
          {pointState.error && <p className="mt-4 text-xs text-red-500">{pointState.error}</p>}
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

// 点形状下拉（Radix Select，支持选项内嵌 SVG 图标 —— 原生 <option> 不渲染 HTML/SVG）
interface ShapeOption {
  value: string
  label: string
  icon: React.ReactNode
}

function ShapeSelect({ value, shapes, onValueChange }: {
  value: string
  shapes: ShapeOption[]
  onValueChange: (v: string) => void
}) {
  return (
    <Select.Root value={value} onValueChange={onValueChange}>
      <Select.Trigger asChild>
        <button type="button"
          className="inline-flex items-center justify-between gap-2 w-full h-9 px-2 text-sm border border-border rounded bg-card hover:border-primary transition-colors">
          <Select.Value placeholder="..." />
          <Select.Icon><ChevronDown size={16} className="text-muted-foreground" /></Select.Icon>
        </button>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content position="popper" sideOffset={4}
          className="z-50 min-w-[var(--radix-select-trigger-width)] max-h-72 overflow-y-auto bg-card border border-border rounded-lg shadow-lg">
          <Select.Viewport className="p-1">
            {shapes.map(s => (
              <Select.Item key={s.value} value={s.value}
                className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer outline-none data-[highlighted]:bg-primary/10 data-[selected]:text-primary">
                <Select.ItemIndicator className="absolute left-1.5">
                  <CheckCircle2 size={14} />
                </Select.ItemIndicator>
                {s.icon}
                <Select.ItemText>{s.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
