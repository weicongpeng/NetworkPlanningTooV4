import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { UserInfo } from '@shared/types'
import { authApi } from '../services/api'

interface AuthState {
  token: string | null
  user: UserInfo | null
  isAuthenticated: boolean
  isLoading: boolean

  login: (username: string, password: string) => Promise<string | null>
  register: (username: string, password: string, confirmPassword: string, city: string, operator: string, equipmentVendor?: string) => Promise<void>
  logout: () => Promise<void>
  fetchUser: () => Promise<void>
  changePassword: (oldPassword: string, newPassword: string, confirmPassword: string) => Promise<void>
}

/** 清空按用户隔离的内存数据缓存（登录前/登出后调用，防止切换账号读到上一账号的组数据） */
function clearUserDataCaches() {
  import('../services/mapDataService')
    .then(({ clearAllInMemoryMapCaches }) => clearAllInMemoryMapCaches())
    .catch(() => { /* 缓存清理非关键 */ })
  // 数据管理列表是内存态（非持久化），切账号时清空，避免新用户短暂看到上一账号数据
  import('./dataStore')
    .then(({ useDataStore }) =>
      useDataStore.setState({ items: [], total: 0, currentPage: 1, error: null })
    )
    .catch(() => { /* 非关键 */ })
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      isAuthenticated: false,
      isLoading: false,

      login: async (username: string, password: string, clientType?: 'pc' | 'app') => {
        clearUserDataCaches()
        set({ isLoading: true })
        try {
          const result: any = await authApi.login({ username, password, client_type: clientType || 'pc' })
          if (result.success && result.data) {
            set({
              token: result.data.access_token,
              user: result.data.user,
              isAuthenticated: true,
              isLoading: false,
            })
            return result.warning || null
          } else {
            throw new Error((result as any).message || '登录失败')
          }
        } catch (error: any) {
          set({ isLoading: false })
          throw error
        }
      },

      register: async (username: string, password: string, confirmPassword: string, city: string, operator: string) => {
        clearUserDataCaches()
        set({ isLoading: true })
        try {
          const result = await authApi.register({ username, password, confirm_password: confirmPassword, city, operator })
          if (result.success && result.data) {
            set({
              token: result.data.access_token,
              user: result.data.user,
              isAuthenticated: true,
              isLoading: false,
            })
          } else {
            throw new Error((result as any).message || '注册失败')
          }
        } catch (error: any) {
          set({ isLoading: false })
          throw error
        }
      },

      logout: async () => {
        try {
          await authApi.logout()
        } catch {
          // 即使服务端登出失败也清除本地状态
        }
        // 重新登录清除批量距离匹配持久化状态（初始登录语义）
        try { sessionStorage.removeItem('distanceMatch.shared') } catch { /* ignore */ }
        set({
          token: null,
          user: null,
          isAuthenticated: false,
        })
        // 登出后清空所有用户的内存数据缓存，杜绝下一账号 TTL 内读到本组数据
        clearUserDataCaches()
      },

      fetchUser: async () => {
        try {
          const result = await authApi.getMe()
          if (result.success && result.data) {
            set({ user: result.data, isAuthenticated: true })
          }
        } catch {
          // Token 无效，清除认证状态
          set({
            token: null,
            user: null,
            isAuthenticated: false,
          })
        }
      },

      changePassword: async (oldPassword: string, newPassword: string, confirmPassword: string) => {
        set({ isLoading: true })
        try {
          const result = await authApi.changePassword({
            old_password: oldPassword,
            new_password: newPassword,
            confirm_password: confirmPassword,
          })
          if (result.success) {
            set({ isLoading: false })
          } else {
            throw new Error((result as any).message || '修改密码失败')
          }
        } catch (error: any) {
          set({ isLoading: false })
          throw error
        }
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        token: state.token,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        if (state && state.token) {
          // 恢复时验证 token 是否有效
          state.fetchUser()
        }
      },
    }
  )
)
