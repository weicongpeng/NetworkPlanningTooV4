import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { btn } from '../utils/buttonStyles'

interface TaskConfigModalProps {
  open: boolean
  title: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  confirmDisabled?: boolean
  children: React.ReactNode
}

export function TaskConfigModal({
  open,
  title,
  confirmLabel,
  onConfirm,
  onCancel,
  confirmDisabled = false,
  children,
}: TaskConfigModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }

    document.addEventListener('keydown', handleEscape)
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === overlayRef.current) onCancel()
      }}
    >
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/40 animate-in fade-in duration-150" />

      {/* 弹窗 */}
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl mx-4 animate-in zoom-in-95 duration-150">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg hover:bg-muted/80 transition-colors text-muted-foreground hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-5 py-4">{children}</div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
          <button onClick={onCancel} className={btn.secondary}>
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={btn.primary}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
