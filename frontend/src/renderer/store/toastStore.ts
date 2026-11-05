import { create } from 'zustand'

export interface ToastItem {
  id: string
  title: string
}

interface ToastState {
  toasts: ToastItem[]
  /** 弹出一条轻提示（自动消失由 Toaster 的 duration 处理） */
  show: (title: string) => void
  dismiss: (id: string) => void
}

let seq = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (title) =>
    set((state) => ({
      toasts: [...state.toasts, { id: `toast-${Date.now()}-${seq++}`, title }],
    })),
  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))
