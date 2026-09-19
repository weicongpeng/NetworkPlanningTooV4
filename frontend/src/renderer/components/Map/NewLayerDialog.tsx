import { useState, useEffect } from 'react'
import { X, FilePlus2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { layerApi } from '../../services/api'

interface NewLayerDialogProps {
  open: boolean
  onClose: () => void
  /** 创建成功回调（返回新图层 id / 数据 id / 名称） */
  onCreated: (r: { data_id: string; layer_id: string; name: string }) => void
}

export default function NewLayerDialog({ open, onClose, onCreated }: NewLayerDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setName('')
      setError('')
    }
  }, [open])

  if (!open) return null

  const handleSubmit = async () => {
    const finalName = name.trim()
    if (!finalName) {
      setError(t('map.layerNameRequired') || '请输入图层名称')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      // 新建为混合图层：同一图层可绘制点、线、面要素
      const resp = await layerApi.createLayer({ name: finalName })
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
            className="px-2.5 py-1.5 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary"
          />
          <span className="text-[11px] text-muted-foreground/80 mt-1">
            {t('map.newLayerMixedHint') || '新建图层可同时绘制点、线、面要素'}
          </span>
        </div>

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
