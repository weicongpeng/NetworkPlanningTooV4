import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import * as Tabs from '@radix-ui/react-tabs'
import { FileUp, Loader2, Download, CheckCircle2 } from 'lucide-react'
import { layerToolsApi, type LayerExcelInfo, type GenerateLayerResult } from '../services/api'
import { LayerAttributeConfig } from '../components/layer/LayerAttributeConfig'
import { LAYER_DEFAULT_PARAMS } from '../config/layer-config'

type LayerFormat = 'tab' | 'mif' | 'kml'
const ALL_FORMATS: LayerFormat[] = ['tab', 'mif', 'kml']

interface TabState {
  filePath: string
  sourceFilename: string
  fileName: string
  sheetName: string
  info: LayerExcelInfo | null
  columns: string[]
  selectedFields: Record<string, string>
  fieldMappings: Record<string, string>
  radiusM: string          // 字符串受控，避免删空变 0 / 前导 0
  beamwidth: string
  pointSize: string
  color: string
  formats: LayerFormat[]   // 多格式勾选
  result: GenerateLayerResult | null
  error: string
}

const STORAGE_KEYS = { sector: 'layerTools.sector', point: 'layerTools.point' }

function emptyTabState(type: 'sector' | 'point'): TabState {
  return {
    filePath: '',
    sourceFilename: '',
    fileName: '',
    sheetName: '',
    info: null,
    columns: [],
    selectedFields: {},
    fieldMappings: {},
    radiusM: type === 'sector' ? String(LAYER_DEFAULT_PARAMS.sector.radiusM) : '',
    beamwidth: type === 'sector' ? String(LAYER_DEFAULT_PARAMS.sector.beamwidth) : '',
    pointSize: type === 'point' ? String(LAYER_DEFAULT_PARAMS.point.pointSize) : '',
    color: type === 'sector' ? LAYER_DEFAULT_PARAMS.sector.color : LAYER_DEFAULT_PARAMS.point.color,
    formats: ['tab'],
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
      return { ...emptyTabState(type), ...saved }
    }
  } catch { /* ignore */ }
  return emptyTabState(type)
}

function saveState(key: string, s: TabState) {
  try { sessionStorage.setItem(key, JSON.stringify(s)) } catch { /* ignore */ }
}

export default function LayerToolsPage() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'sector' | 'point'>('sector')
  const [sectorState, setSectorState] = useState<TabState>(() => loadState(STORAGE_KEYS.sector, 'sector'))
  const [pointState, setPointState] = useState<TabState>(() => loadState(STORAGE_KEYS.point, 'point'))
  const [uploading, setUploading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState<{ percent: number; step: string } | null>(null)

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

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setState(s => ({ ...s, result: null, error: '', info: null, columns: [], sheetName: '' }))
    setUploading(true)
    setProgress({ percent: 1, step: 'uploading' })
    try {
      const up = await layerToolsApi.uploadLayerFile(f, (p) => {
        setProgress({ percent: p.percent, step: p.step })
      })
      setProgress({ percent: 100, step: 'reading' })
      const data = await layerToolsApi.getExcelInfo(up.file_path, up.source_filename)
      setState(s => ({
        ...s,
        filePath: up.file_path,
        sourceFilename: up.source_filename,
        fileName: f.name,
        info: data,
        sheetName: data.sheets[0] || '',
        columns: data.columns[data.sheets[0]] || [],
      }))
    } catch (err: any) {
      setState(s => ({ ...s, error: err?.message || String(err) }))
    } finally {
      setUploading(false)
      setProgress(null)
    }
  }

  const handleGenerate = async () => {
    if (!state.filePath || !state.sheetName) {
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
      const base = {
        filePath: state.filePath,
        sourceFilename: state.sourceFilename,
        sheetName: state.sheetName,
        nameCol: state.fieldMappings.name,
        lonCol: state.fieldMappings.longitude,
        latCol: state.fieldMappings.latitude,
        attributes: Object.values(state.selectedFields),
        outputFormats: state.formats,
        color: state.color,
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
      // 文件过期（后端 TTL 清理后 file_path 失效）→ 清空状态提示重新导入
      const msg = err?.message || String(err)
      if (/文件不存在|文件已过期/.test(msg)) {
        setState(s => ({ ...s, error: t('layer.fileExpired'), filePath: '', fileName: '', info: null, columns: [] }))
      } else {
        setState(s => ({ ...s, error: msg }))
      }
    } finally {
      setGenerating(false)
    }
  }

  const progressText = () => {
    if (!progress) return ''
    if (progress.step === 'uploading') return t('layer.uploading').replace('{percent}', String(progress.percent))
    if (progress.step === 'reading') return t('layer.reading')
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

  const renderParams = (ts: TabState, setTab: (u: (s: TabState) => TabState) => void) => (
    <div className="grid grid-cols-2 gap-4">
      {isSector ? (
        <>
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
        </>
      ) : (
        <div>
          <label className="block text-xs font-medium mb-1">{t('layer.pointSize')}</label>
          <input {...numberInput(ts.pointSize, (v) => setTab(s => ({ ...s, pointSize: v })))}
            className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
        </div>
      )}
      <div>
        <label className="block text-xs font-medium mb-1">{t('layer.fillColor')}</label>
        <input type="color" value={ts.color} onChange={e => setTab(s => ({ ...s, color: e.target.value }))}
          className="w-full h-9 cursor-pointer" />
      </div>
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
      <a href={ts.result.download_url} download
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

  // 渲染 Tab 内容（扇区/点图共用骨架，参数和校验差异）
  const renderTabContent = (ts: TabState, setTab: (u: (s: TabState) => TabState) => void, includeAzimuth: boolean) => (
    <div className="grid grid-cols-5 gap-6">
      {/* 左栏（3/5） */}
      <div className="col-span-3 space-y-6">
        {/* ② Sheet 选择 */}
        <div className="p-4 bg-card border border-border rounded-lg">
          <label htmlFor={`layer-sheet-${activeTab}`} className="block text-xs font-medium mb-2">{t('layer.selectSheet')}</label>
          <select id={`layer-sheet-${activeTab}`} value={ts.sheetName}
            onChange={e => setTab(s => ({ ...s, sheetName: e.target.value, columns: s.info?.columns[e.target.value] || [] }))}
            disabled={!ts.info || ts.info.sheets.length <= 1}
            className="w-full h-9 px-2 text-sm border border-border rounded bg-card disabled:opacity-50">
            {ts.info && ts.info.sheets.length > 0
              ? ts.info.sheets.map(s => <option key={s} value={s}>{s}</option>)
              : <option value="">{t('layer.importHint')}</option>}
          </select>
        </div>

        {/* ③ 属性配置 */}
        <div className="p-4 bg-card border border-border rounded-lg">
          <LayerAttributeConfig
            columns={ts.columns}
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
          <button onClick={handleGenerate} disabled={generating || !ts.filePath || !ts.sheetName}
            className="w-full px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium">
            {generating ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
            {t('layer.generate')}
          </button>
          {renderResult(ts)}
        </div>
      </div>
    </div>
  )

  return (
    <div className="p-8 max-w-6xl">
      <h1 className="text-base font-bold mb-6">{t('nav.layerTools')}</h1>

      <Tabs.Root value={activeTab} onValueChange={(v) => setActiveTab(v as 'sector' | 'point')}>
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

        {/* ① 导入区（与左栏对齐，高度减半，文字横向） */}
        <div className="grid grid-cols-5 gap-6 mb-6">
          <div className="col-span-3">
            <label className="block flex items-center gap-3 px-6 py-3 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary transition-colors">
              <FileUp className="text-muted-foreground shrink-0" size={20} />
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">{state.fileName || t('layer.uploadExcel')}</p>
                <p className="text-xs text-muted-foreground">{t('layer.acceptExcel')}</p>
              </div>
              <input type="file" className="hidden" accept=".xlsx,.xls,.txt,.csv" onChange={handleFile} disabled={uploading} />
            </label>

            {/* 进度条 + 状态 */}
            {uploading && progress && (
              <div className="mt-2">
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress.percent}%` }} />
                </div>
                <p className="text-xs text-muted-foreground mt-1">{progressText()}</p>
              </div>
            )}
          </div>
          <div className="col-span-2" />
        </div>

        {/* 扇区 Tab */}
        <Tabs.Content value="sector" className="mt-6 data-[state=inactive]:hidden">
          {renderTabContent(sectorState, (u) => setSectorState(s => u(s)), true)}
          {sectorState.error && <p className="mt-4 text-xs text-red-500">{sectorState.error}</p>}
        </Tabs.Content>

        {/* 点图 Tab */}
        <Tabs.Content value="point" className="mt-6 data-[state=inactive]:hidden">
          {renderTabContent(pointState, (u) => setPointState(s => u(s)), false)}
          {pointState.error && <p className="mt-4 text-xs text-red-500">{pointState.error}</p>}
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}
