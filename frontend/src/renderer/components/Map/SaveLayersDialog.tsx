import { useState, useEffect } from 'react'
import { X, Save, Download, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface DirtyLayerItem {
  layerId: string
  name: string
  changeCount: number
}

interface SaveLayersDialogProps {
  open: boolean
  dirtyLayers: DirtyLayerItem[]
  saving?: boolean
  onClose: () => void
  /** 保存勾选的图层（传入选中的 layerId 列表） */
  onSave: (layerIds: string[]) => void
  /** 另存为：先保存到库，再下载该图层 MapInfo 全套文件 zip */
  onSaveAs: (layerIds: string[]) => void
}

export default function SaveLayersDialog({ open, dirtyLayers, saving, onClose, onSave, onSaveAs }: SaveLayersDialogProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (open) {
      // 默认全选
      const init: Record<string, boolean> = {}
      dirtyLayers.forEach((l) => { init[l.layerId] = true })
      setSelected(init)
    }
  }, [open, dirtyLayers])

  if (!open) return null

  const selectedIds = dirtyLayers.filter((l) => selected[l.layerId]).map((l) => l.layerId)
  const allSelected = selectedIds.length === dirtyLayers.length && dirtyLayers.length > 0

  const toggle = (id: string) => setSelected((s) => ({ ...s, [id]: !s[id] }))
  const toggleAll = () => {
    const next = !allSelected
    const init: Record<string, boolean> = {}
    dirtyLayers.forEach((l) => { init[l.layerId] = next })
    setSelected(init)
  }

  return (
    <div
      className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/20"
      onClick={saving ? undefined : onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-lg p-5 w-[400px] max-h-[70vh] flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Save size={16} className="text-primary" />
            {t('map.saveLayersTitle') || '保存图层'}
          </div>
          <button className="text-muted-foreground hover:text-foreground transition-colors" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {dirtyLayers.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
            <AlertCircle size={14} />
            {t('map.noDirtyLayers') || '没有需要保存的图层'}
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground">
              {t('map.saveLayersHint') || '以下图层有未保存的编辑，勾选后保存到 MapInfo TAB 文件：'}
            </div>
            <div className="flex flex-col gap-1 overflow-y-auto pr-1">
              <label className="flex items-center gap-2 px-2 py-1.5 text-xs text-foreground cursor-pointer hover:bg-muted rounded">
                <input type="checkbox" className="layer-standard-checkbox" checked={allSelected} onChange={toggleAll} />
                <span className="font-medium">{t('common.selectAll') || '全选'}</span>
              </label>
              {dirtyLayers.map((l) => (
                <label
                  key={l.layerId}
                  className="flex items-center gap-2 px-2 py-1.5 text-xs text-foreground cursor-pointer hover:bg-muted rounded"
                >
                  <input type="checkbox" className="layer-standard-checkbox" checked={!!selected[l.layerId]} onChange={() => toggle(l.layerId)} />
                  <span className="flex-1 truncate">{l.name}</span>
                  <span className="text-amber-500 shrink-0">
                    {t('map.changesCount', { count: l.changeCount }) || `${l.changeCount} 处更改`}
                  </span>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 mt-1">
          <button
            onClick={() => onSaveAs(selectedIds)}
            disabled={saving || selectedIds.length === 0}
            title={t('map.saveAsHint') || '保存并下载该图层 MapInfo 全套文件（.tab/.dat/.id/.map）的 zip 压缩包'}
            className="px-3 py-1.5 text-xs rounded border border-border text-foreground hover:bg-muted hover:text-primary transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            <Download size={13} />
            {t('map.saveAs') || '另存为'}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:bg-muted transition-colors disabled:opacity-50"
          >
            {t('common.cancel') || '取消'}
          </button>
          <button
            onClick={() => onSave(selectedIds)}
            disabled={saving || selectedIds.length === 0}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-1.5"
          >
            <Save size={13} />
            {saving ? (t('common.saving') || '保存中…') : (t('common.save') || '保存')}
          </button>
        </div>
      </div>
    </div>
  )
}
