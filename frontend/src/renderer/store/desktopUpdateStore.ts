import { create } from 'zustand'
import type { DesktopUpdateStatus } from '@shared/types'

/**
 * 桌面端 OTA 手动检查的交接点：「系统设置 → 版本 → 检查更新」把检查结果交给
 * 全局 DesktopUpdateDialog 展示与下载，避免维护两套更新 UI。
 */
interface DesktopUpdateState {
  /** 系统设置页发起的检查结果（非空即请求弹窗展示） */
  requested: DesktopUpdateStatus | null
  requestCheck: (status: DesktopUpdateStatus) => void
  clearRequest: () => void
}

export const useDesktopUpdateStore = create<DesktopUpdateState>((set) => ({
  requested: null,
  requestCheck: (status) => set({ requested: status }),
  clearRequest: () => set({ requested: null }),
}))
