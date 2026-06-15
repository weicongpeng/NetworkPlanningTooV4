import { create } from 'zustand'

interface DownloadState {
  /** Currently downloading item IDs */
  downloadingIds: Set<string>
  /** Progress percentage per item (0-100) */
  progress: Record<string, number>
  /** Status text per item */
  statusText: Record<string, string>

  // Actions
  startDownload: (id: string, name: string) => void
  updateProgress: (id: string, percent: number, status?: string) => void
  finishDownload: (id: string) => void
  failDownload: (id: string, error: string) => void
  isDownloading: (id: string) => boolean
}

export const useDownloadStore = create<DownloadState>()((set, get) => ({
  downloadingIds: new Set(),
  progress: {},
  statusText: {},

  startDownload: (id, name) => {
    set(state => {
      const next = new Set(state.downloadingIds)
      next.add(id)
      return {
        downloadingIds: next,
        progress: { ...state.progress, [id]: 0 },
        statusText: { ...state.statusText, [id]: `正在下载 ${name}...` },
      }
    })
  },

  updateProgress: (id, percent, status) => {
    set(state => ({
      progress: { ...state.progress, [id]: percent },
      statusText: status ? { ...state.statusText, [id]: status } : state.statusText,
    }))
  },

  finishDownload: (id) => {
    set(state => {
      const next = new Set(state.downloadingIds)
      next.delete(id)
      const newProgress = { ...state.progress }
      delete newProgress[id]
      const newStatus = { ...state.statusText }
      delete newStatus[id]
      return { downloadingIds: next, progress: newProgress, statusText: newStatus }
    })
  },

  failDownload: (id, error) => {
    set(state => {
      const next = new Set(state.downloadingIds)
      next.delete(id)
      const newProgress = { ...state.progress }
      delete newProgress[id]
      const newStatus = { ...state.statusText }
      delete newStatus[id]
      return { downloadingIds: next, progress: newProgress, statusText: newStatus }
    })
  },

  isDownloading: (id) => get().downloadingIds.has(id),
}))
