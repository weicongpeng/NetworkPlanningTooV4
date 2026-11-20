import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface LicenseState {
  isAuthorized: boolean
  isLoading: boolean
  expiryDate: string | null
  remainingDays: number | null
  errorMessage: string | null

  /**
   * 基于 authStore.user 设置授权状态（由 ProtectedRoute 调用）。
   *
   * 期限取 `effective_license_expiry`（后端算好的实际适用期限：管理员恒为 null、
   * 非管理员取「自身例外期限 ?? 全局授权期限」），`license_expiry` 只是该用户
   * 单独设置的例外值，不能直接当门禁依据。
   */
  setFromUser: (user: {
    is_active: boolean
    license_expiry: string | null
    effective_license_expiry?: string | null
    is_admin?: boolean
  }) => void

  /** 设置加载状态 */
  setLoading: (loading: boolean) => void
}

export const useLicenseStore = create<LicenseState>()(
  persist(
    (set) => ({
      isAuthorized: false,
      isLoading: false,
      expiryDate: null,
      remainingDays: null,
      errorMessage: null,

      setFromUser: (user) => {
        if (!user.is_active) {
          set({
            isAuthorized: false,
            isLoading: false,
            expiryDate: null,
            remainingDays: 0,
            errorMessage: '账号已被禁用',
          })
          return
        }

        // 管理员默认享有全部功能且无需授权激活：权限无限期，不受全局授权期限限制
        if (user.is_admin) {
          set({
            isAuthorized: true,
            isLoading: false,
            expiryDate: null,
            remainingDays: -1,
            errorMessage: null,
          })
          return
        }

        const expiry = user.effective_license_expiry ?? user.license_expiry
        if (!expiry) {
          set({
            isAuthorized: true,
            isLoading: false,
            expiryDate: null,
            remainingDays: -1,
            errorMessage: null,
          })
          return
        }

        const now = new Date()
        const expiryDate = new Date(expiry)
        const remainingDays = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

        if (remainingDays < 0) {
          set({
            isAuthorized: false,
            isLoading: false,
            expiryDate: expiry,
            remainingDays: 0,
            errorMessage: '授权已过期，请联系管理员',
          })
        } else {
          set({
            isAuthorized: true,
            isLoading: false,
            expiryDate: expiry,
            remainingDays,
            errorMessage: null,
          })
        }
      },

      setLoading: (loading) => {
        set({ isLoading: loading })
      },
    }),
    {
      name: 'license-storage',
      partialize: (state) => ({
        isAuthorized: state.isAuthorized,
        expiryDate: state.expiryDate,
        remainingDays: state.remainingDays,
      }),
    }
  )
)
