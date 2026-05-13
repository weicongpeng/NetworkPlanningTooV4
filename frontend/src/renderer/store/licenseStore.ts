import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface LicenseState {
  isAuthorized: boolean
  isLoading: boolean
  expiryDate: string | null
  remainingDays: number | null
  errorMessage: string | null
  checkAuthorization: () => Promise<void>
  refreshStatus: () => Promise<void>
}

export const useLicenseStore = create<LicenseState>()(
  persist(
    (set, get) => ({
      isAuthorized: false,
      isLoading: false,
      expiryDate: null,
      remainingDays: null,
      errorMessage: null,

      checkAuthorization: async () => {
        set({ isLoading: true })

        try {
          const response = await fetch('/api/v1/license/check')
          const result = await response.json()

          if (result.success) {
            const { valid } = result.data

            // 如果已授权，获取详细信息
            if (valid) {
              const statusResponse = await fetch('/api/v1/license/status')
              const statusResult = await statusResponse.json()

              if (statusResult.success && statusResult.data) {
                set({
                  isAuthorized: true,
                  isLoading: false,
                  expiryDate: statusResult.data.expiryDate || null,
                  remainingDays: statusResult.data.remainingDays || null,
                  errorMessage: null
                })
              } else {
                set({
                  isAuthorized: false,
                  isLoading: false,
                  errorMessage: '获取许可证状态失败'
                })
              }
            } else {
              // 获取错误消息
              const statusResponse = await fetch('/api/v1/license/status')
              const statusResult = await statusResponse.json()

              set({
                isAuthorized: false,
                isLoading: false,
                expiryDate: statusResult.data?.expiryDate || null,
                remainingDays: 0,
                errorMessage: statusResult.data?.errorMessage || '未授权'
              })
            }
          } else {
            set({
              isAuthorized: false,
              isLoading: false,
              errorMessage: '授权检查失败'
            })
          }
        } catch (error) {
          console.error('授权检查失败:', error)
          set({
            isAuthorized: false,
            isLoading: false,
            errorMessage: '授权检查失败，请检查网络连接'
          })
        }
      },

      refreshStatus: async () => {
        const { checkAuthorization } = get()
        await checkAuthorization()
      }
    }),
    {
      name: 'license-storage',
      onRehydrateStorage: () => (state) => {
        // 重新加载时再次检查授权状态
        if (state) {
          state.checkAuthorization()
        }
      }
    }
  )
)
