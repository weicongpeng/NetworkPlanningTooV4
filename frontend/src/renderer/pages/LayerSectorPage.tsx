import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, Loader2, Download, CheckCircle2 } from 'lucide-react'
import { layerToolsApi, type LayerExcelInfo, type GenerateLayerResult } from '../services/api'
import { LayerAttributeConfig } from '../components/layer/LayerAttributeConfig'
import { LAYER_DEFAULT_PARAMS } from '../config/layer-config'

export default function LayerSectorPage() {
  const { t } = useTranslation()
  const [file, setFile] = useState<File | null>(null)
  const [info, setInfo] = useState<LayerExcelInfo | null>(null)
  const [sheetName, setSheetName] = useState('')
  const [columns, setColumns] = useState<string[]>([])
  const [selectedFields, setSelectedFields] = useState<Record<string, string>>({})
  const [fieldMappings, setFieldMappings] = useState<Record<string, string>>({})
  const [radiusM, setRadiusM] = useState(LAYER_DEFAULT_PARAMS.sector.radiusM)
  const [beamwidth, setBeamwidth] = useState(LAYER_DEFAULT_PARAMS.sector.beamwidth)
  const [color, setColor] = useState(LAYER_DEFAULT_PARAMS.sector.color)
  const [format, setFormat] = useState<'tab' | 'mif' | 'kml'>('tab')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<GenerateLayerResult | null>(null)
  const [error, setError] = useState('')

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    setResult(null)
    setError('')
    try {
      const data = await layerToolsApi.getExcelInfo(f)
      setInfo(data)
      setSheetName(data.sheets[0] || '')
      setColumns(data.columns[data.sheets[0]] || [])
    } catch (err: any) {
      setError(err?.message || String(err))
    }
  }

  const handleSheetChange = (s: string) => {
    setSheetName(s)
    if (info) setColumns(info.columns[s] || [])
  }

  const handleGenerate = async () => {
    if (!file || !sheetName) {
      setError(t('layer.errSheet')); return
    }
    if (!fieldMappings.name || !fieldMappings.longitude || !fieldMappings.latitude || !fieldMappings.azimuth) {
      setError(t('layer.errMissingFields')); return
    }
    setLoading(true)
    setError('')
    try {
      const data = await layerToolsApi.generateSector({
        file, sheetName,
        nameCol: fieldMappings.name,
        lonCol: fieldMappings.longitude,
        latCol: fieldMappings.latitude,
        azimuthCol: fieldMappings.azimuth,
        attributes: Object.values(selectedFields),
        outputFormat: format,
        radiusM,
        beamwidth,
      })
      setResult(data)
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-base font-bold mb-6">{t('nav.layerTools')} · {t('layer.sectorLayer')}</h1>

      {/* ① 导入 */}
      <label className="block p-6 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary transition-colors text-center">
        <FileUp className="mx-auto mb-2 text-muted-foreground" size={24} />
        <p className="text-sm">{file ? file.name : t('layer.uploadExcel')}</p>
        <p className="text-xs text-muted-foreground mt-1">{t('layer.acceptExcel')}</p>
        <input type="file" className="hidden" accept=".xlsx,.xls" onChange={handleFile} />
      </label>

      {/* ② Sheet 选择 */}
      {info && info.sheets.length > 0 && (
        <div className="mt-6 space-y-2">
          <label htmlFor="layer-sheet" className="block text-xs font-medium">{t('layer.selectSheet')}</label>
          <select id="layer-sheet" value={sheetName} onChange={e => handleSheetChange(e.target.value)}
            className="w-full h-9 px-2 text-sm border border-border rounded bg-card">
            {info.sheets.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      )}

      {/* ③ 属性配置 */}
      {columns.length > 0 && (
        <div className="mt-6 p-4 bg-card border border-border rounded-lg">
          <LayerAttributeConfig
            columns={columns}
            includeAzimuth
            selectedFields={selectedFields}
            onSelectedFieldsChange={setSelectedFields}
            fieldMappings={fieldMappings}
            onFieldMappingsChange={setFieldMappings}
          />
        </div>
      )}

      {/* ④ 参数设置 */}
      {columns.length > 0 && (
        <div className="mt-6 p-4 bg-card border border-border rounded-lg grid grid-cols-2 gap-4">
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
          </div>
        </div>
      )}

      {error && <p className="mt-4 text-xs text-red-500">{error}</p>}

      {/* 生成 + 下载 */}
      <div className="mt-6 flex items-center gap-4">
        <button onClick={handleGenerate} disabled={loading || !file || !sheetName}
          className="px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 text-sm font-medium">
          {loading ? <Loader2 size={16} className="animate-spin inline mr-2" /> : null}
          {t('layer.generate')}
        </button>
        {result && (
          <a href={result.download_url} download
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-green-600 text-white rounded-lg hover:opacity-90 text-sm">
            <Download size={16} /> {t('layer.download')}
          </a>
        )}
        {result && <CheckCircle2 className="text-green-500" size={18} />}
      </div>
    </div>
  )
}
