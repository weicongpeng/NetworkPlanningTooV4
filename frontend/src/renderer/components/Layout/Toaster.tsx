import * as Toast from '@radix-ui/react-toast'
import { AlertTriangle } from 'lucide-react'
import { useToastStore } from '../../store/toastStore'

/**
 * 全局轻提示：自包含 Radix Toast Provider，挂载到 MainLayout 后全应用可用。
 * Viewport 固定在顶部居中，约 3 秒后自动消失。
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  return (
    <Toast.Provider swipeDirection="down" duration={3000}>
      {toasts.map((item) => (
        <Toast.Root
          key={item.id}
          defaultOpen
          onOpenChange={(open) => {
            if (!open) dismiss(item.id)
          }}
          className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg border border-border bg-background text-foreground shadow-lg"
        >
          <AlertTriangle size={15} className="shrink-0 text-amber-500" />
          <Toast.Title className="flex-1 text-xs leading-snug">{item.title}</Toast.Title>
        </Toast.Root>
      ))}
      <Toast.Viewport
        className="fixed top-0 left-1/2 -translate-x-1/2 z-[2000] flex flex-col gap-2 p-4
                   w-[min(92vw,440px)] list-none outline-none"
      />
    </Toast.Provider>
  )
}
