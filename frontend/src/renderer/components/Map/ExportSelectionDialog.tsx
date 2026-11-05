import { useState, useEffect } from 'react'
import { X, FileSpreadsheet } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ExportSelectionDialogProps {
  open: boolean
  /** 默认文件名（含 .xlsx 扩展名，用户可修改） */
  defaultName: string
  onClose: () => void
  /** 确认导出回调，fileName 为清理后的完整文件名（含 .xlsx） */
  onConfirm: (fileName: string) => void
}

/** 文件名非法字符（Windows/Linux 通用）：\ / : * ? " < > | */
const INVALID_FILE_NAME_CHARS = /[\\/:*?"<>|]/g

/**
 * 选中要素导出命名对话框：用户确认文件名后再触发下载
 */
export default function ExportSelectionDialog({ open, defaultName, onClose, onConfirm }: ExportSelectionDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(defaultName)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setName(defaultName)
      setError('')
    }
  }, [open, defaultName])

  if (!open) return null

  const handleSubmit = () => {
    const cleaned = name.trim().replace(INVALID_FILE_NAME_CHARS, '_')
    if (!cleaned) {
      setError(t('map.exportFileNameRequired') || '请输入文件名')
      return
    }
    onConfirm(/\.xlsx$/i.test(cleaned) ? cleaned : `${cleaned}.xlsx`)
    onClose()
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
            <FileSpreadsheet size={16} className="text-primary" />
            {t('map.exportSelectionTitle') || '导出选中要素'}
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
            {t('map.exportFileName') || '文件名'}
          </label>
          <input
            type="text"
            value={name}
            autoFocus
            maxLength={100}
            onChange={(e) => {
              setName(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
            className="px-2.5 py-1.5 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary"
          />
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
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            {t('common.confirm') || '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
