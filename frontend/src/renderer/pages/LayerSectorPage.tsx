import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, Loader2, Download, CheckCircle2 } from 'lucide-react'
import { layerToolsApi, type LayerExcelInfo, type GenerateLayerResult } from '../services/api'
import { LayerAttributeConfig } from '../components/layer/LayerAttributeConfig'
import { LAYER_DEFAULT_PARAMS } from '../config/layer-config'

export default function LayerSectorPage() {
  const { t } = useTranslation()
  const [file, setFile] = useState<File | null>(null)
  const [filePath, setFilePath] = useState('')
  const [sourceFilename, setSourceFilename] = useState('')
  const [info, setInfo] = useState<LayerExcelInfo | null>(null)
  const [sheetName, setSheetName] = useState('')
  const [columns, setColumns] = useState<string[]>([])
  const [selectedFields, setSelectedFields] = useState<Record<string, string>>({})
  const [fieldMappings, setFieldMappings] = useState<Record<string, string>>({})
  const [radiusM, setRadiusM] = useState(LAYER_DEFAULT_PARAMS.sector.radiusM)
  const [beamwidth, setBeamwidth] = useState(LAYER_DEFAULT_PARAMS.sector.beamwidth)
  const [color, setColor] = useState(LAYER_DEFAULT_PARAMS.sector.color)
  const [format, setFormat] = useState<'tab' | 'mif' | 'kml'>('tab')
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<{ percent: number; step: string } | null>(null)
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<GenerateLayerResult | null>(null)
  const [error, setError] = useState('')

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    setResult(null)
    setError('')
    setInfo(null)
    setColumns([])
    setSheetName('')
    setUploading(true)
    setProgress({ percent: 0, step: 'uploading' })
    try {
      // 分块上传 + 进度
      const up = await layerToolsApi.uploadLayerFile(f, (p) => {
        setProgress({ percent: p.percent, step: p.step })
      })
      setFilePath(up.file_path)
      setSourceFilename(up.source_filename)
      // 读取 sheet/列
      setProgress({ percent: 100, step: 'reading' })
      const data = await layerToolsApi.getExcelInfo(up.file_path, up.source_filename)
      setInfo(data)
      setSheetName(data.sheets[0] || '')
      setColumns(data.columns[data.sheets[0]] || [])
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setUploading(false)
      setProgress(null)
    }
  }

  const handleSheetChange = (s: string) => {
    setSheetName(s)
    if (info) setColumns(info.columns[s] || [])
  }

  const handleGenerate = async () => {
    if (!filePath || !sheetName) {
      setError(t('layer.errSheet')); return
    }
    if (!fieldMappings.name || !fieldMappings.longitude || !fieldMappings.latitude || !fieldMappings.azimuth) {
      setError(t('layer.errMissingFields')); return
    }
    setGenerating(true)
    setError('')
    try {
      const data = await layerToolsApi.generateSector({
        filePath,
        sourceFilename,
        sheetName,
        nameCol: fieldMappings.name,
        lonCol: fieldMappings.longitude,
        latCol: fieldMappings.latitude,
        azimuthCol: fieldMappings.azimuth,
        attributes: Object.values(selectedFields),
        outputFormat: format,
        radiusM,
        beamwidth,
        color,
      })
      setResult(data)
    } catch (err: any) {
      setError(err?.message || String(err))
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
      <h1 className="text-base font-bold mb-6">{t('nav.layerTools')} · {t('layer.sectorLayer')}</h1>

      {/* ① 导入区（横跨） */}
      <label className="block p-6 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary transition-colors text-center">
        <FileUp className="mx-auto mb-2 text-muted-foreground" size={24} />
        <p className="text-sm">{file ? file.name : t('layer.uploadExcel')}</p>
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

      <div className="mt-6 grid grid-cols-5 gap-6">
        {/* 左栏（3/5） */}
        <div className="col-span-3 space-y-6">
          {/* ② Sheet 选择（常驻） */}
          <div className="p-4 bg-card border border-border rounded-lg">
            <label htmlFor="layer-sheet" className="block text-xs font-medium mb-2">{t('layer.selectSheet')}</label>
            <select id="layer-sheet" value={sheetName}
              onChange={e => handleSheetChange(e.target.value)}
              disabled={!info || info.sheets.length === 0}
              className="w-full h-9 px-2 text-sm border border-border rounded bg-card disabled:opacity-50">
              {info && info.sheets.length > 0
                ? info.sheets.map(s => <option key={s} value={s}>{s}</option>)
                : <option value="">{t('layer.importHint')}</option>}
            </select>
          </div>

          {/* ③ 属性配置（常驻） */}
          <div className="p-4 bg-card border border-border rounded-lg">
            {columns.length > 0 ? (
              <LayerAttributeConfig
                columns={columns}
                includeAzimuth
                selectedFields={selectedFields}
                onSelectedFieldsChange={setSelectedFields}
                fieldMappings={fieldMappings}
                onFieldMappingsChange={setFieldMappings}
              />
            ) : (
              <p className="text-xs text-muted-foreground py-8 text-center">{t('layer.importHint')}</p>
            )}
          </div>
        </div>

        {/* 右栏（2/5） */}
        <div className="col-span-2 space-y-6">
          {/* ④ 参数设置（常驻） */}
          <div className="p-4 bg-card border border-border rounded-lg">
            <p className="text-xs font-medium mb-3">{t('layer.params')}</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">{t('layer.radius')} (m)</label>
                <input type="number" value={radiusM} onChange={e => setRadiusM(Number(e.target.value))}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{t('layer.beamwidth')} (°)</label>
                <input type="number" value={beamwidth} onChange={e => setBeamwidth(Number(e.target.value))}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card" />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{t('layer.fillColor')}</label>
                <input type="color" value={color} onChange={e => setColor(e.target.value)}
                  className="w-full h-9 cursor-pointer" />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{t('layer.outputFormat')}</label>
                <select value={format} onChange={e => setFormat(e.target.value as any)}
                  className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
                  <option value="tab">TAB</option>
                  <option value="mif">MIF</option>
                  <option value="kml">KML</option>
                </select>
                {format === 'tab' && (
                  <p className="text-[10px] text-muted-foreground mt-1">{t('layer.colorTabHint')}</p>
                )}
              </div>
            </div>
          </div>

          {/* ⑤ 生成 + 下载 */}
          <div className="p-4 bg-card border border-border rounded-lg">
            <button onClick={handleGenerate} disabled={generating || !filePath || !sheetName}
              className="w-full px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium">
              {generating ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
              {t('layer.generate')}
            </button>
            {result && (
              <a href={result.download_url} download
                className="mt-3 w-full inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-green-600 text-white rounded-lg hover:opacity-90 text-sm">
                <Download size={16} /> {t('layer.download')} ({result.filename})
              </a>
            )}
            {result && <p className="mt-2 text-xs text-green-500 flex items-center gap-1"><CheckCircle2 size={14} /> {t('layer.uploadDone')}</p>}
          </div>
        </div>
      </div>

      {error && <p className="mt-4 text-xs text-red-500">{error}</p>}
    </div>
  )
}
