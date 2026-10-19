import { useState, useEffect } from 'react'
import { X, FilePlus2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { layerApi } from '../../services/api'

/** 新建图层的输出格式（与后端 create_empty_layer 的 fmt 取值一致） */
export type LayerFormat = 'tab' | 'shp' | 'geojson'
/** 图层几何类型；mixed=同一图层可绘制点/线/面 */
export type LayerGeometry = 'mixed' | 'point' | 'line' | 'polygon'

const FORMATS: LayerFormat[] = ['tab', 'shp', 'geojson']
const GEOMETRIES: LayerGeometry[] = ['mixed', 'point', 'line', 'polygon']

interface NewLayerDialogProps {
  open: boolean
  onClose: () => void
  /** 创建成功回调（返回新图层 id / 数据 id / 名称 / 几何类型 / 格式） */
  onCreated: (r: {
    data_id: string
    layer_id: string
    name: string
    geometry_type?: string
    format?: string
  }) => void
}

export default function NewLayerDialog({ open, onClose, onCreated }: NewLayerDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [format, setFormat] = useState<LayerFormat>('tab')
  const [geometry, setGeometry] = useState<LayerGeometry>('mixed')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setName('')
      setFormat('tab')
      setGeometry('mixed')
      setError('')
    }
  }, [open])

  if (!open) return null

  // Shapefile 单文件只能存一种几何类型，选中时不给"混合"选项；已选混合则回落到点
  const geometryOptions = format === 'shp'
    ? GEOMETRIES.filter((g) => g !== 'mixed')
    : GEOMETRIES
  const effectiveGeometry: LayerGeometry =
    format === 'shp' && geometry === 'mixed' ? 'point' : geometry

  const handleFormatChange = (next: LayerFormat) => {
    setFormat(next)
    if (next === 'shp' && geometry === 'mixed') setGeometry('point')
  }

  const handleSubmit = async () => {
    const finalName = name.trim()
    if (!finalName) {
      setError(t('map.layerNameRequired') || '请输入图层名称')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const resp = await layerApi.createLayer({
        name: finalName,
        format,
        geometryType: effectiveGeometry,
      })
      if (resp.success && resp.data) {
        onCreated(resp.data)
        onClose()
      } else {
        setError((resp as any)?.message || t('map.createLayerFailed') || '创建失败')
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || t('map.createLayerFailed') || '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const selectClass =
    'px-2.5 py-1.5 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary'

  return (
    <div
      className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/20"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-lg p-5 w-[380px] flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <FilePlus2 size={16} className="text-primary" />
            {t('map.newLayerTitle') || '新建图层'}
          </div>
          <button
            className="text-muted-foreground hover:text-foreground transition-colors"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground">
            {t('map.layerName') || '图层名称'}
          </label>
          <input
            type="text"
            value={name}
            autoFocus
            maxLength={50}
            placeholder={t('map.layerNamePlaceholder') || '例如：规划站点'}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
            className={selectClass}
          />
        </div>

        <div className="flex gap-2">
          <div className="flex flex-col gap-1.5 flex-1">
            <label className="text-xs text-muted-foreground">
              {t('map.layerFormat') || '图层格式'}
            </label>
            <select
              value={format}
              onChange={(e) => handleFormatChange(e.target.value as LayerFormat)}
              className={selectClass}
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {t(`map.layerFormat_${f}`) || f}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5 flex-1">
            <label className="text-xs text-muted-foreground">
              {t('map.layerGeometry') || '几何类型'}
            </label>
            <select
              value={effectiveGeometry}
              onChange={(e) => setGeometry(e.target.value as LayerGeometry)}
              className={selectClass}
            >
              {geometryOptions.map((g) => (
                <option key={g} value={g}>
                  {t(`map.layerGeometry_${g}`) || g}
                </option>
              ))}
            </select>
          </div>
        </div>

        <span className="text-[11px] text-muted-foreground/80 -mt-2">
          {format === 'shp'
            ? (t('map.newLayerShpHint') || 'Shapefile 单文件只支持一种几何类型，且字段名上限 10 字节（超长中文名会自动转写）')
            : (t('map.newLayerMixedHint') || '新建图层可同时绘制点、线、面要素')}
        </span>

        {error && <div className="text-xs text-destructive">{error}</div>}

        <div className="flex justify-end gap-2 mt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:bg-muted transition-colors"
          >
            {t('common.cancel') || '取消'}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {submitting ? (t('common.submitting') || '创建中…') : (t('common.create') || '创建')}
          </button>
        </div>
      </div>
    </div>
  )
}
