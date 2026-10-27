// 模块级上传进度单例（非 React store）：chunkedUpload 后台更新，组件订阅实时渲染
// 切页不丢失：上传任务在组件卸载后仍在后台执行，模块级 store 记录进度，组件重挂载时恢复

export interface UploadProgress {
  active: boolean
  percent: number        // 0-100
  step: string           // 'uploading' | 'reading' | 'done'
  sessionId: string      // 分块上传会话 id（用于取消）
  fileName: string       // 上传文件名
}

type Listener = (p: UploadProgress) => void

let current: UploadProgress = { active: false, percent: 0, step: '', sessionId: '', fileName: '' }
let cancelFn: (() => void) | null = null
const listeners = new Set<Listener>()

export const uploadStore = {
  get(): UploadProgress { return current },
  subscribe(l: Listener): () => void {
    listeners.add(l)
    return () => { listeners.delete(l) }
  },
  _set(p: Partial<UploadProgress>) {
    current = { ...current, ...p }
    listeners.forEach(l => l(current))
  },
  _setCancel(fn: (() => void) | null) { cancelFn = fn },
  cancel() { cancelFn?.() },
}
