import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Tabs from '@radix-ui/react-tabs'
import { FileUp, Loader2, Download, CheckCircle2 } from 'lucide-react'
import { layerToolsApi, type LayerExcelInfo, type GenerateLayerResult } from '../services/api'
import { LayerAttributeConfig } from '../components/layer/LayerAttributeConfig'
import { LAYER_DEFAULT_PARAMS } from '../config/layer-config'

interface TabState {
  filePath: string
  sourceFilename: string
  fileName: string
  sheetName: string
  info: LayerExcelInfo | null
  columns: string[]
  selectedFields: Record<string, string>
  fieldMappings: Record<string, string>
  radiusM: number
  beamwidth: number
  pointSize: number
  color: string
  format: 'tab' | 'mif' | 'kml'
  result: GenerateLayerResult | null
  error: string
}

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
    radiusM: type === 'sector' ? LAYER_DEFAULT_PARAMS.sector.radiusM : 0,
    beamwidth: type === 'sector' ? LAYER_DEFAULT_PARAMS.sector.beamwidth : 0,
    pointSize: type === 'point' ? LAYER_DEFAULT_PARAMS.point.pointSize : 0,
    color: type === 'sector' ? LAYER_DEFAULT_PARAMS.sector.color : LAYER_DEFAULT_PARAMS.point.color,
    format: 'tab',
    result: null,
    error: '',
  }
}

export default function LayerToolsPage() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'sector' | 'point'>('sector')
  const [sectorState, setSectorState] = useState<TabState>(emptyTabState('sector'))
  const [pointState, setPointState] = useState<TabState>(emptyTabState('point'))
  const [uploading, setUploading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState<{ percent: number; step: string } | null>(null)

  // 当前激活 Tab 的 state
  const state = activeTab === 'sector' ? sectorState : pointState
  const setState = (updater: (s: TabState) => TabState) => {
    if (activeTab === 'sector') setSectorState(s => updater(s))
    else setPointState(s => updater(s))
  }

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setState(s => ({ ...s, result: null, error: '', info: null, columns: [], sheetName: '' }))
    setUploading(true)
    setProgress({ percent: 0, step: 'uploading' })
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
    if (activeTab === 'sector') {
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
    setState(s => ({ ...s, error: '' }))
    try {
      let data: GenerateLayerResult
      if (activeTab === 'sector') {
        data = await layerToolsApi.generateSector({
          filePath: state.filePath,
          sourceFilename: state.sourceFilename,
          sheetName: state.sheetName,
          nameCol: state.fieldMappings.name,
          lonCol: state.fieldMappings.longitude,
          latCol: state.fieldMappings.latitude,
          azimuthCol: state.fieldMappings.azimuth,
          attributes: Object.values(state.selectedFields),
          outputFormat: state.format,
          radiusM: state.radiusM,
          beamwidth: state.beamwidth,
          color: state.color,
        })
      } else {
        data = await layerToolsApi.generatePoint({
          filePath: state.filePath,
          sourceFilename: state.sourceFilename,
          sheetName: state.sheetName,
          nameCol: state.fieldMappings.name,
          lonCol: state.fieldMappings.longitude,
          latCol: state.fieldMappings.latitude,
          attributes: Object.values(state.selectedFields),
          outputFormat: state.format,
          color: state.color,
        })
      }
      setState(s => ({ ...s, result: data }))
    } catch (err: any) {
      setState(s => ({ ...s, error: err?.message || String(err) }))
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

        {/* ① 导入区（横跨，共用） */}
        <label className="block p-6 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary transition-colors text-center">
          <FileUp className="mx-auto mb-2 text-muted-foreground" size={24} />
          <p className="text-sm">{state.fileName || t('layer.uploadExcel')}</p>
          <p className="text-xs text-muted-foreground mt-1">{t('layer.acceptExcel')}</p>
          <input type="file" className="hidden" accept=".xlsx,.xls" onChange={handleFile} disabled={uploading} />
        </label>

        {/* 进度条 + 状态 */}
        {uploading && progress && (
          <div className="mt-3">
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress.percent}%` }} />
            </div>
            <p className="text-xs text-muted-foreground mt-1">{progressText()}</p>
          </div>
        )}

        {/* 扇区 Tab */}
        <Tabs.Content value="sector" className="mt-6 data-[state=inactive]:hidden">
          <div className="grid grid-cols-5 gap-6">
            {/* 左栏（3/5） */}
            <div className="col-span-3 space-y-6">
              {/* ② Sheet 选择 */}
              <div className="p-4 bg-card border border-border rounded-lg">
                <label htmlFor="layer-sheet-sector" className="block text-xs font-medium mb-2">{t('layer.selectSheet')}</label>
                <select id="layer-sheet-sector" value={sectorState.sheetName}
                  onChange={e => {
                    setSectorState(s => ({ ...s, sheetName: e.target.value, columns: s.info?.columns[e.target.value] || [] }))
                  }}
                  disabled={!sectorState.info || sectorState.info.sheets.length === 0}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card disabled:opacity-50">
                  {sectorState.info && sectorState.info.sheets.length > 0
                    ? sectorState.info.sheets.map(s => <option key={s} value={s}>{s}</option>)
                    : <option value="">{t('layer.importHint')}</option>}
                </select>
              </div>

              {/* ③ 属性配置（含方位角） */}
              <div className="p-4 bg-card border border-border rounded-lg">
                {sectorState.columns.length > 0 ? (
                  <LayerAttributeConfig
                    columns={sectorState.columns}
                    includeAzimuth
                    selectedFields={sectorState.selectedFields}
                    onSelectedFieldsChange={(v) => setSectorState(s => ({ ...s, selectedFields: v }))}
                    fieldMappings={sectorState.fieldMappings}
                    onFieldMappingsChange={(v) => setSectorState(s => ({ ...s, fieldMappings: v }))}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground py-8 text-center">{t('layer.importHint')}</p>
                )}
              </div>
            </div>

            {/* 右栏（2/5） */}
            <div className="col-span-2 space-y-6">
              {/* ④ 参数设置（扇区） */}
              <div className="p-4 bg-card border border-border rounded-lg">
                <p className="text-xs font-medium mb-3">{t('layer.params')}</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium mb-1">{t('layer.radius')} (m)</label>
                    <input type="number" value={sectorState.radiusM} onChange={e => setSectorState(s => ({ ...s, radiusM: Number(e.target.value) }))}
                      className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">{t('layer.beamwidth')} (°)</label>
                    <input type="number" value={sectorState.beamwidth} onChange={e => setSectorState(s => ({ ...s, beamwidth: Number(e.target.value) }))}
                      className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">{t('layer.fillColor')}</label>
                    <input type="color" value={sectorState.color} onChange={e => setSectorState(s => ({ ...s, color: e.target.value }))}
                      className="w-full h-9 cursor-pointer" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">{t('layer.outputFormat')}</label>
                    <select value={sectorState.format} onChange={e => setSectorState(s => ({ ...s, format: e.target.value as any }))}
                      className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
                      <option value="tab">TAB</option>
                      <option value="mif">MIF</option>
                      <option value="kml">KML</option>
                    </select>
                    {sectorState.format === 'tab' && (
                      <p className="text-[10px] text-muted-foreground mt-1">{t('layer.colorTabHint')}</p>
                    )}
                  </div>
                </div>
              </div>

              {/* ⑤ 生成 + 下载 */}
              <div className="p-4 bg-card border border-border rounded-lg">
                <button onClick={handleGenerate} disabled={generating || !sectorState.filePath || !sectorState.sheetName}
                  className="w-full px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium">
                  {generating ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
                  {t('layer.generate')}
                </button>
                {sectorState.result && (
                  <a href={sectorState.result.download_url} download
                    className="mt-3 w-full inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-green-600 text-white rounded-lg hover:opacity-90 text-sm">
                    <Download size={16} /> {t('layer.download')} ({sectorState.result.filename})
                  </a>
                )}
                {sectorState.result && <p className="mt-2 text-xs text-green-500 flex items-center gap-1"><CheckCircle2 size={14} /> {t('layer.uploadDone')}</p>}
              </div>
            </div>
          </div>

          {sectorState.error && <p className="mt-4 text-xs text-red-500">{sectorState.error}</p>}
        </Tabs.Content>

        {/* 点图 Tab */}
        <Tabs.Content value="point" className="mt-6 data-[state=inactive]:hidden">
          <div className="grid grid-cols-5 gap-6">
            {/* 左栏（3/5） */}
            <div className="col-span-3 space-y-6">
              {/* ② Sheet 选择 */}
              <div className="p-4 bg-card border border-border rounded-lg">
                <label htmlFor="layer-sheet-point" className="block text-xs font-medium mb-2">{t('layer.selectSheet')}</label>
                <select id="layer-sheet-point" value={pointState.sheetName}
                  onChange={e => {
                    setPointState(s => ({ ...s, sheetName: e.target.value, columns: s.info?.columns[e.target.value] || [] }))
                  }}
                  disabled={!pointState.info || pointState.info.sheets.length === 0}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card disabled:opacity-50">
                  {pointState.info && pointState.info.sheets.length > 0
                    ? pointState.info.sheets.map(s => <option key={s} value={s}>{s}</option>)
                    : <option value="">{t('layer.importHint')}</option>}
                </select>
              </div>

              {/* ③ 属性配置（无方位角） */}
              <div className="p-4 bg-card border border-border rounded-lg">
                {pointState.columns.length > 0 ? (
                  <LayerAttributeConfig
                    columns={pointState.columns}
                    includeAzimuth={false}
                    selectedFields={pointState.selectedFields}
                    onSelectedFieldsChange={(v) => setPointState(s => ({ ...s, selectedFields: v }))}
                    fieldMappings={pointState.fieldMappings}
                    onFieldMappingsChange={(v) => setPointState(s => ({ ...s, fieldMappings: v }))}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground py-8 text-center">{t('layer.importHint')}</p>
                )}
              </div>
            </div>

            {/* 右栏（2/5） */}
            <div className="col-span-2 space-y-6">
              {/* ④ 参数设置（点图） */}
              <div className="p-4 bg-card border border-border rounded-lg">
                <p className="text-xs font-medium mb-3">{t('layer.params')}</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium mb-1">{t('layer.pointSize')}</label>
                    <input type="number" value={pointState.pointSize} onChange={e => setPointState(s => ({ ...s, pointSize: Number(e.target.value) }))}
                      className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">{t('layer.fillColor')}</label>
                    <input type="color" value={pointState.color} onChange={e => setPointState(s => ({ ...s, color: e.target.value }))}
                      className="w-full h-9 cursor-pointer" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">{t('layer.outputFormat')}</label>
                    <select value={pointState.format} onChange={e => setPointState(s => ({ ...s, format: e.target.value as any }))}
                      className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
                      <option value="tab">TAB</option>
                      <option value="mif">MIF</option>
                      <option value="kml">KML</option>
                    </select>
                    {pointState.format === 'tab' && (
                      <p className="text-[10px] text-muted-foreground mt-1">{t('layer.colorTabHint')}</p>
                    )}
                  </div>
                </div>
              </div>

              {/* ⑤ 生成 + 下载 */}
              <div className="p-4 bg-card border border-border rounded-lg">
                <button onClick={handleGenerate} disabled={generating || !pointState.filePath || !pointState.sheetName}
                  className="w-full px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium">
                  {generating ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
                  {t('layer.generate')}
                </button>
                {pointState.result && (
                  <a href={pointState.result.download_url} download
                    className="mt-3 w-full inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-green-600 text-white rounded-lg hover:opacity-90 text-sm">
                    <Download size={16} /> {t('layer.download')} ({pointState.result.filename})
                  </a>
                )}
                {pointState.result && <p className="mt-2 text-xs text-green-500 flex items-center gap-1"><CheckCircle2 size={14} /> {t('layer.uploadDone')}</p>}
              </div>
            </div>
          </div>

          {pointState.error && <p className="mt-4 text-xs text-red-500">{pointState.error}</p>}
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}
