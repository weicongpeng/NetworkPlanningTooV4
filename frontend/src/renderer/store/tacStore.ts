/**
 * @deprecated 请使用 tacCheckStore.ts 替代。保留以保持向后兼容。
 * TAC核查配置存储（仅持久化网络类型偏好）
 *
 * taskId 和 result 改用 taskStore 管理（与 PCI/邻区规划统一）
 * 避免从 localStorage 恢复旧结果时自动应用到地图
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface TACState {
  config: {
    networkType: 'LTE' | 'NR'
  } | null
  setConfig: (config: { networkType: 'LTE' | 'NR' }) => void
}

export const useTACStore = create<TACState>()(
  persist(
    (set) => ({
      config: { networkType: 'LTE' },
      setConfig: (config) => set({ config }),
    }),
    {
      name: 'tac-storage',
      partialize: (state) => ({
        config: state.config
      })
    }
  )
)
