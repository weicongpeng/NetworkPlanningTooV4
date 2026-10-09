import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { UserInfo } from '@shared/types'
import { authApi, desktopLoginApi, systemApi } from '../services/api'

/** 桌面端运行模式：共享模式（与网页端一致）/ 单机模式（单独授权、权限全开） */
export type DesktopRunMode = 'shared' | 'standalone' | null

interface AuthState {
  token: string | null
  user: UserInfo | null
  isAuthenticated: boolean
  isLoading: boolean
  /** 运行形态：True=桌面版（本机后端），由公开的 /system/info 探测得到 */
  desktopMode: boolean
  /** 桌面形态探测是否已完成（未完成前不渲染登录页，避免闪一下） */
  desktopProbed: boolean
  /** 桌面形态探测失败的原因（仅用于启动探测提示） */
  desktopError: string | null
  /** 桌面端运行模式：登录后确定，持久化以便刷新后保持 */
  desktopRunMode: DesktopRunMode
  /** 单机模式本次为离线登录（本机授权登录，联网后自动校验授权） */
  desktopOffline: boolean
  /** 单机模式已提交授权申请、等待管理员批准的账号 */
  desktopPendingUsername: string | null
  /** 桌面端最后一次登录的账号与运行模式（持久化的只是展示用信息，不含密码） */
  lastDesktopLogin: { username: string; mode: 'shared' | 'standalone' } | null
  /**
   * 桌面端：用户本次是「主动退出登录」，登录页不要再自动登录。
   * 「记住账号密码」的语义是下次打开软件自动登录，退出后同一次会话内必须等用户点登录。
   */
  desktopAutoLoginSuppressed: boolean

  login: (
    username: string,
    password: string,
    desktopMode?: 'shared' | 'standalone',
    /** 桌面端：是否记住账号密码（本机加密保存，供下次自动登录） */
    remember?: boolean,
  ) => Promise<string | null>
  register: (username: string, password: string, confirmPassword: string, city: string, operator: string, equipmentVendor?: string) => Promise<void>
  logout: () => Promise<void>
  fetchUser: () => Promise<void>
  changePassword: (oldPassword: string, newPassword: string, confirmPassword: string) => Promise<void>
  probeDesktopMode: () => Promise<void>
  setDesktopPendingUsername: (username: string | null) => void
  /** 更新桌面端离线/在线状态（离线登录或心跳探测到网络变化时调用） */
  setDesktopOffline: (offline: boolean) => void
  applyDesktopLogin: (data: { access_token?: string; token?: string; user?: any; mode?: string; offline?: boolean }) => void
  /** 用本机后端回传的账号信息刷新本地用户（权限位被管理员改动后即时生效） */
  applyServerUser: (nextUser: UserInfo) => void
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
      desktopMode: false,
      desktopProbed: false,
      desktopError: null,
      desktopRunMode: null,
      desktopOffline: false,
      desktopPendingUsername: null,
      lastDesktopLogin: null,
      desktopAutoLoginSuppressed: false,

      login: async (username: string, password: string, desktopRunMode?: 'shared' | 'standalone', remember?: boolean) => {
        clearUserDataCaches()
        set({ isLoading: true })
        try {
          // 桌面版：走本机后端代理登录，返回 result=pending 表示单机授权待管理员批准
          if (desktopRunMode) {
            const result: any = await desktopLoginApi.login({
              username, password, mode: desktopRunMode,
              remember: remember !== false,
            })
            const data = result?.data || {}
            if (data.result === 'pending') {
              set({ isLoading: false, desktopRunMode, desktopPendingUsername: username })
              return null
            }
            if (!data.access_token) {
              throw new Error((result as any)?.message || '登录失败')
            }
            set({
              token: data.access_token,
              user: data.user,
              isAuthenticated: true,
              isLoading: false,
              desktopRunMode: data.mode || desktopRunMode,
              desktopOffline: Boolean(data.offline),
              desktopPendingUsername: null,
              desktopAutoLoginSuppressed: false,
              lastDesktopLogin: {
                username,
                mode: (data.mode || desktopRunMode || 'shared') as 'shared' | 'standalone',
              },
            })
            return null
          }

          const result: any = await authApi.login({ username, password, client_type: 'pc' })
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

      setDesktopPendingUsername: (username: string | null) => set({ desktopPendingUsername: username }),

      setDesktopOffline: (offline: boolean) => {
        if (get().desktopOffline !== offline) set({ desktopOffline: offline })
      },

  register: async (username: string, password: string, confirmPassword: string, city: string, operator: string) => {
    clearUserDataCaches()
    set({ isLoading: true })
    try {
      // 桌面端：注册请求经本机后端代理到服务器（账号建在服务器上，注册即登录）
      if (get().desktopMode) {
        const res: any = await desktopLoginApi.register({
          username,
          password,
          confirm_password: confirmPassword,
          city,
          operator,
        })
        const data = res?.data || {}
        if (!data.access_token) {
          throw new Error(res?.message || '注册失败')
        }
        set({
          token: data.access_token,
          user: data.user,
          isAuthenticated: true,
          isLoading: false,
          desktopRunMode: data.mode || 'shared',
          desktopPendingUsername: null,
          lastDesktopLogin: { username, mode: 'shared' },
        })
        return
      }

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
          desktopRunMode: null,
          desktopOffline: false,
          desktopPendingUsername: null,
          // 主动退出后停留在登录页，等用户点登录；重新打开软件时仍按「记住账号密码」自动登录
          desktopAutoLoginSuppressed: get().desktopMode,
        })
        // 登出后清空所有用户的内存数据缓存，杜绝下一账号 TTL 内读到本组数据
        clearUserDataCaches()
      },

      fetchUser: async () => {
        try {
          const result = await authApi.getMe()
          if (result.success && result.data) {
            const runMode = (result.data as any).desktop_run_mode
            set({
              user: result.data,
              isAuthenticated: true,
              // 桌面端运行模式以服务端为准（刷新页面后恢复）
              desktopRunMode: runMode || get().desktopRunMode,
            })
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

      probeDesktopMode: async () => {
        if (get().desktopProbed) return
        let desktopMode = false
        let desktopError: string | null = null
        try {
          // 优先用专用的包裹结构接口；/system/info 是给手机 APP 做服务发现的，
          // 返回裸模型（无 success/data），两种形状都要认。
          let payload: any = null
          try {
            const primary: any = await systemApi.desktopMode()
            payload = primary?.data ?? primary
          } catch {
            const fallback: any = await systemApi.info()
            payload = fallback?.data ?? fallback
          }
          desktopMode = Boolean(payload?.desktop_mode)
        } catch (error: any) {
          desktopMode = false
          desktopError = `运行形态探测失败：${error?.message || error}`
        }
        set({ desktopMode, desktopProbed: true, desktopError })
      },

      applyDesktopLogin: (data) => {
        const token = data?.access_token || data?.token
        if (!token || !data?.user) return
        clearUserDataCaches()
        set({
          token,
          user: data.user,
          isAuthenticated: true,
          desktopRunMode: (data.mode || 'standalone') as DesktopRunMode,
          desktopOffline: Boolean(data.offline),
          desktopPendingUsername: null,
          desktopAutoLoginSuppressed: false,
        })
      },

      applyServerUser: (nextUser) => {
        // 只在权限/授权期限相关字段变化时更新，避免周期性心跳触发无意义的重渲染
        const current = get().user
        const keys: (keyof UserInfo)[] = [
          'is_admin', 'is_active',
          'can_data_import', 'can_data_delete', 'can_data_update',
          'can_cell_entry', 'can_cell_query_update', 'can_assistant',
          // 联网校验授权后会续期并镜像到期日：让授权门禁即时拿到新期限
          'license_expiry', 'effective_license_expiry',
        ]
        const differs = (key: keyof UserInfo) => {
          const prev = current?.[key]
          const next = nextUser[key]
          // 权限位按布尔比较（null/false 等价）；授权期限按值比较（null 与空串等价）
          if (typeof prev === 'boolean' || typeof next === 'boolean') {
            return Boolean(prev) !== Boolean(next)
          }
          return (prev ?? '') !== (next ?? '')
        }
        if (!current || keys.some(differs)) set({ user: nextUser })
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        token: state.token,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        desktopRunMode: state.desktopRunMode,
        // 桌面端记住最后一次登录的账号与模式：未超过「无操作 X 天退出」时凭
        // 持久化的令牌自动登录（这里不存密码）；要换模式则退出后重新登录
        lastDesktopLogin: state.lastDesktopLogin,
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
