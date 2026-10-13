import axios from 'axios'
import type {
  ApiResponse,
  CellBulkUpdateResultItem,
  CellSearchItem,
  LicenseStatus,
  MachineInfo,
  DesktopCloudStatus,
  DesktopLicenseRecord,
  DesktopReleaseInfo,
  DesktopUpdateStatus,
  NeighborConfig,
  NeighborResult,
  PCIConfig,
  PCIResult,
  UploadResponse,
  DataItem,
  TaskProgress,
  LoginRequest,
  RegisterRequest,
  ChangePasswordRequest,
  ResetPasswordRequest,
  TokenResponse,
  RegisterOptions,
  UserInfo,
  UserListResponse,
  UserUpdateRequest,
  UserDetailResponse,
  AttributeJoinRequest,
  AttributeJoinStats,
  BufferRequest,
  BufferStats,
} from '@shared/types'
import { uploadStore } from '../store/uploadStore'

const API_BASE_URL = '/api/v1'

// 开发环境下的直接后端 URL（绕过 Vite 代理的 multipart/form-data 问题）
// 使用环境变量配置
const DEV_BACKEND_URL = import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.hostname}:8000/api/v1`

// 检测是否是开发环境
const isDev = import.meta.env.DEV

console.log('[API] Environment:', { isDev, API_BASE_URL, DEV_BACKEND_URL })

/**
 * 从 auth-storage 读取当前登录 token（axios 拦截器之外的原生 fetch 请求用）。
 * 上传/下载类请求走原生 fetch，必须显式携带，否则后端要求登录的端点返回 401。
 */
export function getStoredAuthToken(): string | null {
  try {
    const stored = localStorage.getItem('auth-storage')
    if (!stored) return null
    const parsed = JSON.parse(stored)
    return parsed?.state?.token || null
  } catch {
    return null
  }
}

// 创建axios实例
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 300000,
  headers: {
    'Content-Type': 'application/json'
  }
})

// 创建专门用于文件上传的 axios 实例（不设置默认 Content-Type）
// 在开发环境中直接访问后端，避免 Vite 代理的 multipart/form-data 问题
const uploadClient = axios.create({
  baseURL: isDev ? DEV_BACKEND_URL : API_BASE_URL,
  timeout: 300000
})

// uploadClient 请求拦截器 - 用于调试
uploadClient.interceptors.request.use(
  (config) => {
    console.log('[uploadClient Request]', {
      url: config.url,
      method: config.method,
      headers: config.headers,
      dataType: config.data instanceof FormData ? 'FormData' : typeof config.data,
      // 如果是 FormData，打印 entries
      formDataEntries: config.data instanceof FormData
        ? Array.from(config.data.entries()).map(([key, value]) => [
            key,
            value instanceof File ? `File(${value.name}, ${value.size} bytes, ${value.type})` : value
          ])
        : 'N/A'
    })
    // 附加认证 token（与 apiClient 拦截器一致，分块上传端点已挂权限校验）
    const stored = localStorage.getItem('auth-storage')
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        const token = parsed?.state?.token
        if (token) {
          config.headers.Authorization = `Bearer ${token}`
        }
      } catch { /* ignore parse errors */ }
    }
    // 不要修改 Content-Type，让 axios 自动处理 FormData
    return config
  },
  (error) => {
    console.error('[uploadClient Request Error]', error)
    return Promise.reject(error)
  }
)

// 请求拦截器
apiClient.interceptors.request.use(
  (config) => {
    // 添加认证 token
    const stored = localStorage.getItem('auth-storage')
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        const token = parsed?.state?.token
        if (token) {
          config.headers.Authorization = `Bearer ${token}`
        }
      } catch { /* ignore parse errors */ }
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器
apiClient.interceptors.response.use(
  (response) => {
    // 对于二进制响应类型，直接返回完整的响应对象
    // 因为此时response.data已经是Blob或ArrayBuffer对象，不需要再解包
    if (response.request.responseType === 'blob' || response.request.responseType === 'arraybuffer') {
      return response
    }
    // 显式声明 _returnFullResponse 的请求同样返回完整响应（用于读取 ETag 等响应头，如图层版本指纹）
    if ((response.config as any)?._returnFullResponse) {
      return response
    }
    // 对于其他响应类型，返回response.data
    // 保持与API签名一致：返回 ApiResponse<T>
    return response.data
  },
  async (error) => {
    console.error('API Error:', error)

    // 网络错误（无响应）：自动重试一次
    if (!error.response && error.request) {
      const config = error.config
      // 防止无限重试
      if (config && !config._retry) {
        config._retry = true
        console.log('[API] 网络错误，1秒后自动重试:', config.url)
        await new Promise(resolve => setTimeout(resolve, 1000))
        try {
          const retryResponse = await axios(config)
          return retryResponse.data
        } catch (retryError: any) {
          // 重试也失败，返回统一错误
          return Promise.reject({
            success: false,
            message: '网络连接失败，请检查后端服务是否启动',
            code: 0
          })
        }
      }
      return Promise.reject({
        success: false,
        message: '网络连接失败，请检查后端服务是否启动',
        code: 0
      })
    }

    // 处理错误响应，返回统一格式
    if (error.response) {
      // 兼容detail和message字段
      let message = error.message

      // 对于二进制响应类型，尝试从Blob中读取错误详情
      if (error.response.request.responseType === 'blob' || error.response.request.responseType === 'arraybuffer') {
        const blob = error.response.data
        if (blob && blob instanceof Blob && blob.size > 0) {
          return new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => {
              try {
                const text = reader.result as string
                const errData = JSON.parse(text)
                const detail = errData.detail || errData.message || message
                reject(new Error(detail))
              } catch {
                reject(new Error(message))
              }
            }
            reader.onerror = () => reject(new Error(message))
            reader.readAsText(blob)
          })
        }
        return Promise.reject(new Error(message))
      }

      const data = error.response.data
      if (data) {
        // 后端FastAPI使用detail字段
        if (typeof data === 'string') {
          message = data
        } else if (data.detail) {
          message = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
        } else if (data.message) {
          message = data.message
        }
      }

      // 返回标准错误对象
      const errorObj = {
        success: false,
        message: message || '请求失败',
        code: error.response.status
      }

      // 401 未认证时清除本地认证状态
      if (error.response.status === 401) {
        try {
          localStorage.removeItem('auth-storage')
          window.dispatchEvent(new CustomEvent('auth:required'))
        } catch { /* ignore */ }
      }

      return Promise.reject(errorObj)
    }

    // 其他错误
    return Promise.reject({
      success: false,
      message: error.message || '未知错误',
      code: -1
    })
  }
)

// 为 uploadClient 添加相同的响应拦截器
uploadClient.interceptors.response.use(
  (response) => {
    return response.data
  },
  async (error) => {
    console.error('Upload API Error:', error)

    // 网络错误：自动重试一次
    if (!error.response && error.request) {
      const config = error.config
      if (config && !config._retry) {
        config._retry = true
        console.log('[UploadClient] 网络错误，1秒后自动重试:', config.url)
        await new Promise(resolve => setTimeout(resolve, 1000))
        try {
          const retryResponse = await axios(config)
          return retryResponse.data
        } catch {
          return Promise.reject({
            success: false,
            message: '网络连接失败，上传请求无法发送到后端',
            code: 0
          })
        }
      }
      return Promise.reject({
        success: false,
        message: '网络连接失败，上传请求无法发送到后端',
        code: 0
      })
    }

    // 处理错误响应，返回统一格式
    if (error.response) {
      let message = error.message

      const data = error.response.data
      if (data) {
        if (typeof data === 'string') {
          message = data
        } else if (data.detail) {
          message = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
        } else if (data.message) {
          message = data.message
        }
      }

      const errorObj = {
        success: false,
        message: message || '请求失败',
        code: error.response.status
      }
      return Promise.reject(errorObj)
    } else if (error.request) {
      return Promise.reject({
        success: false,
        message: '网络连接失败，请检查后端服务是否启动',
        code: 0
      })
    }

    return Promise.reject({
      success: false,
      message: error.message || '未知错误',
      code: -1
    })
  }
)

// 桌面版授权管理（管理员，按用户授权 + 激活码）
/** 桌面授权编辑字段；city/operator 为该桌面端的数据组（null=由桌面端自选） */
export interface DesktopLicensePayload {
  licensee_username?: string
  organization?: string
  lease_days?: number
  note?: string
  city?: string | null
  operator?: string | null
  /** 单机用户无操作自动退出登录的时长（天） */
  idle_logout_days?: number
  /** 绑定的网页端账号（桌面端与网页端共用同一账号权限） */
  username?: string
}

export const desktopLicensesApi = {
  list: async (
    page = 1,
    pageSize = 20,
    status?: string,
    keyword?: string,
    mode?: 'standalone' | 'shared',
  ): Promise<ApiResponse<{ total: number; items: DesktopLicenseRecord[] }>> => {
    const params: Record<string, any> = { page, page_size: pageSize }
    if (status) params.status = status
    if (keyword) params.keyword = keyword
    // 共享模式登录会自动签发许可（无需管理），默认只看单机授权
    if (mode) params.mode = mode
    return apiClient.get('/desktop-licenses', { params })
  },

  create: async (data: DesktopLicensePayload): Promise<ApiResponse<DesktopLicenseRecord>> => {
    return apiClient.post('/desktop-licenses', data)
  },

  update: async (
    id: number,
    data: DesktopLicensePayload,
  ): Promise<ApiResponse<DesktopLicenseRecord>> => {
    return apiClient.put(`/desktop-licenses/${id}`, data)
  },

  remove: async (id: number): Promise<ApiResponse<any>> => {
    return apiClient.delete(`/desktop-licenses/${id}`)
  },

  action: async (
    id: number,
    action: 'approve' | 'reject' | 'disable' | 'enable' | 'unbind' | 'regenerate-code',
    data?: { lease_days?: number; note?: string },
  ): Promise<ApiResponse<DesktopLicenseRecord>> => {
    return apiClient.post(`/desktop-licenses/${id}/${action}`, data || {})
  },
}

// 桌面版安装包管理（管理员，OTA 分发）
export const desktopReleasesApi = {
  list: async (page = 1, pageSize = 20, channel?: string): Promise<ApiResponse<{ total: number; items: DesktopReleaseInfo[] }>> => {
    const params: Record<string, any> = { page, page_size: pageSize }
    if (channel) params.channel = channel
    return apiClient.get('/desktop-releases', { params })
  },

  /** 分片上传安装包（1MB/块，绕 Cloudflare 100MB 限制；complete 步骤带管理员 token）
   *  @param onProgress 可选进度回调（0-100）：分片占比 3-98，合并落盘阶段 99，完成 100
   */
  upload: async (formData: FormData, onProgress?: (percent: number) => void) => {
    const file = formData.get('file') as File
    const version = (formData.get('version') as string) || ''
    const channel = (formData.get('channel') as string) || 'stable'
    const releaseNotes = (formData.get('release_notes') as string) || ''
    const isLatest = formData.get('is_latest') !== 'false'

    if (!file) throw new Error('请选择安装包文件')
    if (!version) throw new Error('请输入版本号')

    const basePath = '/desktop-releases/chunked'
    const CHUNK_SIZE = 1024 * 1024
    const MAX_RETRIES = 5
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

    const startForm = new FormData()
    startForm.append('filename', file.name)
    startForm.append('total_chunks', String(totalChunks))
    startForm.append('total_size', String(file.size))
    const startResp = await uploadClient.post(`${basePath}/start`, startForm)
    const uploadId = startResp.data?.id || startResp.data?.data?.id
    if (!uploadId) throw new Error('无法创建上传会话')
    onProgress?.(3)

    for (let i = 0; i < totalChunks; i++) {
      const chunk = file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size))
      let retries = 0
      let success = false
      while (!success && retries < MAX_RETRIES) {
        try {
          const chunkForm = new FormData()
          chunkForm.append('file', chunk)
          chunkForm.append('chunk_index', String(i))
          await uploadClient.post(`${basePath}/${uploadId}/chunk`, chunkForm)
          success = true
          onProgress?.(3 + Math.round(((i + 1) / totalChunks) * 95))
        } catch {
          retries++
          if (retries >= MAX_RETRIES) {
            throw new Error(`分块 ${i + 1}/${totalChunks} 上传失败，已重试 ${MAX_RETRIES} 次`)
          }
          await new Promise((r) => setTimeout(r, Math.pow(2, retries - 1) * 1000))
        }
      }
    }

    onProgress?.(99)
    const completeForm = new FormData()
    completeForm.append('version', version)
    completeForm.append('channel', channel)
    completeForm.append('release_notes', releaseNotes)
    completeForm.append('is_latest', isLatest ? 'true' : 'false')

    let authToken = ''
    try {
      const stored = localStorage.getItem('auth-storage')
      if (stored) authToken = JSON.parse(stored)?.state?.token || ''
    } catch { /* ignore */ }

    const headers: Record<string, string> = {}
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`
    const resp = await uploadClient.post(`${basePath}/${uploadId}/complete`, completeForm, { headers })
    onProgress?.(100)
    return resp
  },

  /** 最新桌面安装包公开信息（网页端「下载应用 → 电脑端」用，不需要登录） */
  latestPublic: async (channel = 'stable') => {
    return apiClient.get('/desktop-cloud/releases/latest', { params: { channel } })
  },

  update: async (
    id: number,
    data: { version?: string; channel?: string; release_notes?: string; is_latest?: boolean },
  ) => {
    const form = new FormData()
    if (data.version !== undefined) form.append('version', data.version)
    if (data.channel !== undefined) form.append('channel', data.channel)
    if (data.release_notes !== undefined) form.append('release_notes', data.release_notes)
    if (data.is_latest !== undefined) form.append('is_latest', data.is_latest ? 'true' : 'false')
    return apiClient.put(`/desktop-releases/${id}`, form)
  },

  setLatest: async (id: number) => {
    return apiClient.post(`/desktop-releases/${id}/set-latest`)
  },

  delete: async (id: number) => {
    return apiClient.delete(`/desktop-releases/${id}`)
  },
}

// 桌面版本机 OTA（仅桌面版可用；网页端返回 404）
export const desktopUpdateApi = {
  status: async (): Promise<ApiResponse<DesktopUpdateStatus>> => {
    return apiClient.get('/desktop/update/status')
  },
  download: async (version?: string): Promise<ApiResponse<{ phase: string }>> => {
    return apiClient.post('/desktop/update/download', { version })
  },
  progress: async (): Promise<ApiResponse<{ phase: string; downloaded: number; total: number; error?: string }>> => {
    return apiClient.get('/desktop/update/progress')
  },
  install: async (): Promise<ApiResponse<{ exiting: boolean; message: string }>> => {
    return apiClient.post('/desktop/update/install')
  },
  /** 「后台运行」：转入后台更新，关掉窗口也会继续下载并自动安装 */
  background: async (): Promise<ApiResponse<{ phase: string; background: boolean; version?: string | null }>> => {
    return apiClient.post('/desktop/update/background')
  },
}

// 许可证API
export const licenseApi = {
  // 获取许可证状态
  getStatus: async (): Promise<ApiResponse<LicenseStatus>> => {
    return apiClient.get('/license/status')
  },

  // 激活许可证
  activate: async (licenseKey: string): Promise<ApiResponse<{ success: boolean }>> => {
    return apiClient.post('/license/activate', { license_key: licenseKey })
  },

  // 上传许可证文件
  upload: async (file: File): Promise<ApiResponse<{ success: boolean }>> => {
    const formData = new FormData()
    formData.append('file', file)
    return uploadClient.post('/license/upload', formData)
  },

  // 桌面端：本机机器码（供厂商签发绑定授权）
  getMachineInfo: async (): Promise<ApiResponse<MachineInfo>> => {
    return apiClient.get('/license/machine-info')
  },

  // 管理员更新全局授权期限
  updateExpiry: async (expiryDate: string | null): Promise<ApiResponse<any>> => {
    return apiClient.post('/license/update-expiry', { expiry_date: expiryDate }) as any
  },
}

// 桌面版在线授权（本机后端 → 授权服务器；仅桌面版可用，网页端返回 404）
export const desktopCloudApi = {
  // 本机 + 云端状态
  getStatus: async (): Promise<ApiResponse<DesktopCloudStatus>> => {
    return apiClient.get('/desktop/cloud-status')
  },

  // 用激活码在线激活
  activate: async (activationCode: string): Promise<ApiResponse<DesktopCloudStatus>> => {
    return apiClient.post('/desktop/cloud-activate', { activation_code: activationCode })
  },

  // 用现有许可续期
  renew: async (): Promise<ApiResponse<DesktopCloudStatus>> => {
    return apiClient.post('/desktop/cloud-renew')
  },

  // 提交授权申请（服务器需开启 approve 模式）
  apply: async (data: {
    applicant_name: string
    organization?: string
    note?: string
  }): Promise<ApiResponse<{ request_id: number; status: string }>> => {
    return apiClient.post('/desktop/cloud-apply', data)
  },

  // 轮询申请结果（批准后本机自动完成激活）
  pollApply: async (): Promise<
    ApiResponse<{ status: string; message?: string; activated: boolean; status_detail?: DesktopCloudStatus }>
  > => {
    return apiClient.get('/desktop/cloud-apply')
  },

  // 共享模式数据同步状态（供同步指示器展示进度/冲突）
  getSyncStatus: async (): Promise<ApiResponse<DesktopSyncStatus>> => {
    return apiClient.get('/desktop/sync-status') as any
  },

  // 登录态校验：同一账号在别处登录时返回 valid=false；单机模式顺带返回离线状态与授权校验结果
  getSessionStatus: async (): Promise<
    ApiResponse<{
      valid: boolean
      reason?: string
      offline?: boolean
      skipped?: boolean
      user?: UserInfo
      /** 联网后自动校验授权成功（一次性，附续期后的到期日） */
      license_verified?: boolean
      license_expire_date?: string
      /** 服务器明确拒绝的授权异常（被禁用/解绑/换机等），供前端提示 */
      license_error?: string
    }>
  > => {
    return apiClient.get('/desktop/session-status') as any
  },

  // 手机 APP 最新版本（桌面端取服务器的最新版，返回可扫码的绝对下载地址）
  appVersion: async (): Promise<ApiResponse<any>> => {
    return apiClient.get('/desktop/app-version') as any
  },
}

/** 桌面端登录结果（共享模式直接可用；单机模式可能返回 pending 等待管理员批准） */
export interface DesktopLoginResult {
  token?: string
  access_token?: string
  user?: any
  mode?: 'shared' | 'standalone'
  offline?: boolean
  /** 共享模式：登录即触发同组数据同步 */
  sync_started?: boolean
  idle_logout_days?: number
  license?: any
  /** result=pending 时表示单机授权申请已提交，等待管理员在「桌面授权」页确认 */
  result?: 'ok' | 'pending'
  status?: string
  message?: string
  license_id?: number
}

// 桌面版账号登录：与网页端同一套账号（仅桌面版可用，网页端返回 404）
export const desktopLoginApi = {
  login: async (data: {
    username: string
    password: string
    mode: 'shared' | 'standalone'
    /** 记住账号密码（勾选后本机加密保存，登录页可自动登录） */
    remember?: boolean
  }): Promise<ApiResponse<DesktopLoginResult>> => {
    return apiClient.post('/desktop/login', data) as any
  },

  /** 最近一次记住的登录账号/密码（本机加密存储；没保存过返回 null） */
  getLastLogin: async (): Promise<ApiResponse<{ username: string; password: string; mode: 'shared' | 'standalone' } | null>> => {
    return apiClient.get('/desktop/last-login') as any
  },

  /** 清除记住的账号/密码 */
  deleteLastLogin: async (): Promise<ApiResponse<null>> => {
    return apiClient.delete('/desktop/last-login') as any
  },

  /** 单机模式：轮询「申请授权」结果，管理员批准后直接返回登录态 */
  poll: async (username: string): Promise<ApiResponse<DesktopLoginResult>> => {
    return apiClient.post('/desktop/auth-poll', { username }) as any
  },

  /** 桌面端注册选项：地市/运营商取自服务器（注册时选数据组） */
  options: async (): Promise<ApiResponse<{ cities: string[]; operators: string[] }>> => {
    return apiClient.get('/desktop/register-options') as any
  },

  /** 桌面端注册：与网页端同一套字段，注册成功后自动以共享模式登录 */
  register: async (data: {
    username: string
    password: string
    confirm_password: string
    city: string
    operator: string
  }): Promise<ApiResponse<DesktopLoginResult>> => {
    return apiClient.post('/desktop/register', data) as any
  },

  /**
   * 把「应用名 + 运行模式 + 实时同步状态」写到桌面窗口标题栏。
   * 网页端 / 非桌面壳返回 403，调用方静默忽略即可。
   */
  setWindowTitle: async (title: string): Promise<ApiResponse<{ title: string }>> => {
    return apiClient.post('/desktop/window-title', { title }) as any
  },

  /**
   * 地图页「全屏」：让桌面主窗口进入系统级全屏（覆盖整个屏幕、无标题栏）。
   * 网页端 / 非桌面壳（含旧版桌面端）返回 403/404，调用方回退浏览器 Fullscreen API。
   */
  setFullscreen: async (fullscreen: boolean): Promise<ApiResponse<{ fullscreen: boolean }>> => {
    return apiClient.post('/desktop/fullscreen', { fullscreen }) as any
  },
}

/** 桌面共享模式同步状态 */
export interface DesktopSyncStatus {
  desktop: boolean
  run_mode: 'shared' | 'offline'
  /** 正在同步中（前端据此展示动画） */
  syncing: boolean
  server_url: string
  activated: boolean
  last_sync_at: string | null
  last_error: string | null
  last_result?: {
    pulled?: number
    pushed?: number
    deleted?: number
    conflicts?: number
    errors?: string[]
    /** 同组任务历史同步统计（桌面端共享模式） */
    tasks?: {
      pulled?: number
      pushed?: number
      deleted?: number
      /** 元数据/已应用标记被更新的任务数 */
      updated?: number
      /** 镜像任务结果预拉取条数（只影响历史列表的「已应用」判定） */
      results_pulled?: number
      errors?: string[]
    }
  } | null
  pending_uploads: number
  conflicts: { data_id: string; name: string; server_rev: number; local_rev: number }[]
  synced_datasets: number
}

/** 桌面端登录态校验结果（同一账号在别处登录时 valid=false） */
export interface DesktopSessionStatus {
  valid: boolean
  reason?: string
  offline?: boolean
}

// ===== 优化后的分块上传（动态分块 + 串行 + 指数退避） =====
//
// 场景：大文件通过 Cloudflare Tunnel（约 37KB/s，120s 超时限制）上传
// 生产环境后端单 worker（NPT_WORKERS=1），并行上传会导致请求排队超时（502），
// 因此保持串行上传，配合动态分块大小和指数退避重试。
// 优化策略：
//   1. 统一 512KB 分块：Cloudflare Tunnel 下最稳，单块 ~0.3-0.5s 完成
//   2. 串行上传：避免单 worker 排队超时
//   3. 指数退避重试：失败后 2s → 4s → 8s 等待
//   4. 专用状态查询：从 /data/{id} 查询状态，替代全量列表轮询
//
const MAX_CHUNK_RETRIES = 3      // 每块最多重试 3 次

/** 统一 512KB 分块（Cloudflare Tunnel 下最稳，单块 ~0.3-0.5s 完成） */
function calcChunkSize(_fileSize: number): number {
  return 512 * 1024               // 统一 512KB
}

/** 指数退避延时 */
function backoffDelay(retries: number): number {
  return Math.pow(2, retries + 1) * 1000  // 2s → 4s → 8s
}

/**
 * 执行串行分块上传：start → chunk×N（串行）→ complete → polling
 * 串行避免后端单 worker（NPT_WORKERS=1）下并行请求排队导致 Cloudflare 502
 * @param file 要上传的文件
 * @param basePath 上传端点的基础路径（如 '/data/upload'）
 * @param fileType 可选的文件类型：'excel' | 'geo_data' | 'layer'
 * @param onProgress 可选的分块进度回调（1 立即反馈, 2 start 前, 3-99 分块进度, 100 complete 后）
 * @param trackProgress 是否写入模块级 uploadStore（跨页恢复进度 + 取消按钮），仅图层制作上传启用
 */
async function chunkedUpload(
  file: File,
  basePath: string,
  fileType?: string,
  onProgress?: (percent: number) => void,
  trackProgress?: boolean,
): Promise<any> {
  onProgress?.(1)                     // 立即显示 1%，start 请求前就有反馈
  const chunkSize = calcChunkSize(file.size)
  const totalChunks = Math.ceil(file.size / chunkSize)
  console.log(`[chunkedUpload] 开始分块上传: ${file.name}, 大小: ${file.size}, 分块大小: ${(chunkSize/1024).toFixed(0)}KB, 分块数: ${totalChunks}`)

  // 取消标志：取消后中止后续分块，complete 阶段抛错
  let cancelled = false
  const abortCtrl = new AbortController()   // 取消时立即中止进行中的分块请求

  // 阶段1: 初始化上传会话
  const startForm = new FormData()
  startForm.append('filename', file.name)
  startForm.append('total_chunks', String(totalChunks))
  startForm.append('total_size', String(file.size))

  onProgress?.(2)                     // start 请求发起前
  const startResp = await uploadClient.post(`${basePath}/start`, startForm)
  const dataId = startResp.data?.id || startResp.data?.data?.id
  if (!dataId) {
    throw new Error('无法创建上传会话')
  }
  console.log(`[chunkedUpload] 会话已创建: ${dataId}`)

  if (trackProgress) {
    // 模块级进度：记录会话 id + 文件名，暴露取消句柄
    uploadStore._set({ active: true, percent: 2, step: 'uploading', sessionId: dataId, fileName: file.name })
    uploadStore._setCancel(() => {
      cancelled = true
      // 立即中止进行中的请求（避免等待 60s 超时）+ 调后端取消清理分块
      abortCtrl.abort()
      uploadStore._set({ active: false, step: '', sessionId: '', fileName: '' })
      uploadStore._setCancel(null)   // 释放取消句柄，避免下轮误触发
      try { uploadClient.post(`${basePath}/${dataId}/cancel`) } catch { /* ignore */ }
    })
  }

  // 阶段2: 串行上传分块（单 worker 后端 + Cloudflare Tunnel 需避免排队超时）
  for (let i = 0; i < totalChunks; i++) {
    if (cancelled) break            // 用户取消：中止后续分块
    const start = i * chunkSize
    const end = Math.min(start + chunkSize, file.size)
    const chunk = file.slice(start, end)

    let retries = 0
    let success = false

    while (!success && retries < MAX_CHUNK_RETRIES) {
      try {
        const chunkForm = new FormData()
        chunkForm.append('file', chunk)
        chunkForm.append('chunk_index', String(i))

        await uploadClient.post(`${basePath}/${dataId}/chunk`, chunkForm, {
          timeout: 60000,          // 单块 60s，超时即触发重试
          signal: abortCtrl.signal, // 取消时立即中止请求
        })
        success = true
        onProgress?.(Math.round(((i + 1) / totalChunks) * 99))  // 99% 封顶，留给 complete
        if (trackProgress) uploadStore._set({ percent: Math.round(((i + 1) / totalChunks) * 99) })
        console.log(`[chunkedUpload] 分块 ${i + 1}/${totalChunks} 完成 (${end - start} 字节)`)
      } catch (err) {
        if (cancelled) break        // 用户取消：不重试、不报分块失败
        retries++
        console.warn(`[chunkedUpload] 分块 ${i + 1}/${totalChunks} 失败 (重试 ${retries}/${MAX_CHUNK_RETRIES}):`, (err as any)?.message || err)
        if (retries >= MAX_CHUNK_RETRIES) {
          // 取消上传会话
          try { await uploadClient.post(`${basePath}/${dataId}/cancel`) } catch { /* ignore */ }
          if (trackProgress) {
            uploadStore._set({ active: false, step: '', sessionId: '', fileName: '' })
            uploadStore._setCancel(null)
          }
          throw new Error(`分块 ${i + 1}/${totalChunks} 上传失败，已重试 ${MAX_CHUNK_RETRIES} 次`)
        }
        const delay = backoffDelay(retries)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  // 用户取消：中止上传（不调用 complete），报告已取消
  if (cancelled) {
    throw new Error('已取消')
  }

  // 阶段3: 完成上传（触发后台处理）
  const completeForm = new FormData()
  completeForm.append('filename', file.name)
  if (fileType) {
    completeForm.append('file_type', fileType)
  }

  const completeResp = await uploadClient.post(`${basePath}/${dataId}/complete`, completeForm)
  onProgress?.(100)
  if (trackProgress) uploadStore._set({ percent: 100, step: 'reading' })
  console.log('[chunkedUpload] 文件重组完成，开始后台处理')

  const result = completeResp

  // 阶段4: 轮询等待后台处理完成（使用 /data/list 查询，比单 ID 查询在 Cloudflare Tunnel 下更稳定）
  if (result?.data?.status === 'processing' && result?.data?.id) {
    const pollDataId = result.data.id
    console.log('[chunkedUpload] 后台处理中 (id=' + pollDataId + ')，开始轮询等待...')

    const maxWait = 300000  // 最长等待 5 分钟
    const pollInterval = 2000  // 每 2 秒检查一次
    const startTime = Date.now()

    while (Date.now() - startTime < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval))

      let found: any = null
      try {
        // 使用 /data/list 轮询（Cloudflare Tunnel 下比 /data/{id} 更稳定）
        // 传入 cacheBust=true 避免浏览器缓存
        const listResult: any = await apiClient.get('/data/list?page=1&page_size=100&_t=' + Date.now())
        const items = listResult?.data || listResult || []
        found = Array.isArray(items) ? items.find((item: any) => item.id === pollDataId) : null
      } catch (pollErr: any) {
        // 502 等错误时等待稍长再重试，避免频繁请求压垮后端
        console.warn('[chunkedUpload] 轮询出错（2s后重试）:', pollErr?.message || pollErr)
        await new Promise(r => setTimeout(r, 2000))
        continue
      }

      // 后台处理结果必须在 try 之外判断：失败要抛出真实原因，不能被上面的 catch 当成网络错误吞掉重试
      if (found?.status === 'ready') {
        console.log('[chunkedUpload] 后台处理完成:', pollDataId)
        result.data.status = 'ready'
        result.data.fileType = found.fileType
        break
      }
      if (found?.status === 'error') {
        console.error('[chunkedUpload] 后台处理失败:', pollDataId, found.errorMessage)
        throw new Error(found.errorMessage || '文件处理失败')
      }
    }

    if (result?.data?.status !== 'ready') {
      console.warn('[chunkedUpload] 轮询超时，但文件可能仍在处理中')
    }
  }

  // 上传完成：清理模块级进度（cancel 句柄由组件/下次上传重置）
  if (trackProgress) uploadStore._set({ active: false, step: 'done' })
  return result
}


// 数据管理API
export const dataApi = {
  // 上传工参文件 - 使用分块上传（解决 Cloudflare 524 超时）+ 异步处理轮询
  uploadExcel: async (file: File | null, filePath?: string): Promise<ApiResponse<UploadResponse>> => {
    console.log('[uploadExcel] START - file:', file, 'filePath:', filePath)

    // 验证输入
    if (!file) {
      console.error('[uploadExcel] ERROR: file is null or undefined!')
      throw new Error('请选择要上传的文件')
    }

    console.log('[uploadExcel] file info:', { name: file.name, size: file.size, type: file.type })

    // 所有文件都走分块上传（避免 Cloudflare 524 超时）
    // 小文件也会走分块流程，但只有 1 个分块，开销很小
    return await chunkedUpload(file, '/data/upload')
  },

  /** 上传地图文件并保存到服务器 - 使用原生 fetch API
   * @param file 主文件（.tab/.mif/.kml/.zip 等）
   * @param filePath Electron 本地真实路径（后端据此在源文件夹查找关联文件）
   * @param extraFiles 配套文件列表（浏览器模式无路径时，同 stem 的 .dat/.mid/.map/.id 一起上传）
   */
  uploadMap: async (file: File | null, filePath?: string, extraFiles?: File[]): Promise<ApiResponse<any>> => {
    console.log('[uploadMap] START - file:', file, 'filePath:', filePath, 'extraFiles:', extraFiles?.map(f => f.name))

    // 验证输入
    if (!file) {
      console.error('[uploadMap] ERROR: file is null or undefined!')
      throw new Error('请选择要上传的文件')
    }

    const formData = new FormData()

    // 确保文件被正确添加
    formData.append('file', file)
    console.log('[uploadMap] Added file to FormData:', {
      name: file.name,
      size: file.size,
      type: file.type
    })

    // 配套文件（同 stem）作为 files 列表字段
    if (extraFiles && extraFiles.length > 0) {
      for (const extra of extraFiles) {
        formData.append('files', extra)
      }
      console.log('[uploadMap] Added companion files:', extraFiles.map(f => f.name))
    }

    if (filePath && filePath !== 'undefined' && filePath !== 'null') {
      formData.append('file_path', filePath)
      console.log('[uploadMap] Added file_path:', filePath)
    } else {
      console.log('[uploadMap] Skipping file_path (not provided or invalid)')
    }

    // 验证 FormData
    const formDataEntries = Array.from(formData.entries())
    console.log('[uploadMap] FormData entries:', formDataEntries.map(([key, value]) => [
      key,
      value instanceof File ? `File(${value.name}, ${value.size}b)` : value
    ]))

    // 使用原生 fetch API 发送请求
    const url = `${API_BASE_URL}/data/upload/map`

    // Cloudflare Tunnel 会周期性断开（网关层 502/503/504，约数分钟一次），
    // 上传请求撞上断开窗口会失败。网关层错误重试有意义：tunnel 断开后 1-10s 自动重连，重试大概率成功。
    const MAX_RETRIES = 2
    let lastError: string | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = attempt * 2500 // 2.5s / 5s
        console.log(`[uploadMap] 网关错误，${delay / 1000}s 后重试 (第 ${attempt} 次)...`)
        await new Promise(r => setTimeout(r, delay))
      }
      try {
        console.log(`[uploadMap] Sending fetch request to: ${url} (attempt ${attempt + 1})`)

        const uploadHeaders: Record<string, string> = {}
        const uploadToken = getStoredAuthToken()
        if (uploadToken) uploadHeaders.Authorization = `Bearer ${uploadToken}`
        const response = await fetch(url, {
          method: 'POST',
          body: formData,
          headers: uploadHeaders,
        })

        console.log('[uploadMap] Response status:', response.status)

        if (!response.ok) {
          const errorText = await response.text()
          const isGatewayErr = response.status === 502 || response.status === 503 || response.status === 504
          if (isGatewayErr && attempt < MAX_RETRIES) {
            lastError = `网关错误(${response.status})，准备重试`
            console.warn(`[uploadMap] ${lastError}`)
            continue
          }
          console.error('[uploadMap] Error response:', errorText)
          throw new Error(`上传失败: ${response.status} ${errorText}`)
        }

        const result = await response.json()
        console.log('[uploadMap] Success response:', result)
        return result
      } catch (err: any) {
        // 网络层异常（连接重置/超时，fetch 自身抛错）同样重试
        if (attempt < MAX_RETRIES) {
          lastError = `网络错误: ${err?.message || err}`
          console.warn(`[uploadMap] ${lastError}，准备重试`)
          continue
        }
        throw err
      }
    }
    throw new Error(`上传失败: ${lastError || '未知错误'}`)
  },

  /** 上传地理化数据文件 - 使用分块上传（解决 Cloudflare 524 超时） */
  uploadGeoData: async (file: File | null, filePath?: string): Promise<ApiResponse<any>> => {
    console.log('[uploadGeoData] START - file:', file, 'filePath:', filePath)

    // 验证输入
    if (!file) {
      console.error('[uploadGeoData] ERROR: file is null or undefined!')
      throw new Error('请选择要上传的文件')
    }

    console.log('[uploadGeoData] file info:', { name: file.name, size: file.size, type: file.type })

    // 使用分块上传避免 Cloudflare 524 超时，标记为 geo_data 类型
    return await chunkedUpload(file, '/data/upload', 'geo_data')
  },

  // 获取数据列表（支持分页，支持绕过缓存）
  list: async (page: number = 1, pageSize: number = 50, cacheBust: boolean = false): Promise<ApiResponse<DataItem[]> & { total?: number }> => {
    const cacheParam = cacheBust ? `&_t=${Date.now()}` : ''
    return apiClient.get(`/data/list?page=${page}&page_size=${pageSize}${cacheParam}`)
  },

  // 删除数据
  delete: async (id: string, force: boolean = false): Promise<ApiResponse<{ success: boolean }>> => {
    return apiClient.delete(`/data/${id}${force ? '?force=true' : ''}`)
  },

  /** 删除数据（内部方法，支持强制删除） */
  deleteData: async (dataId: string, force: boolean = false): Promise<boolean> => {
    try {
      const res = await apiClient.delete<ApiResponse<{ success: boolean }>>(`/data/${dataId}${force ? '?force=true' : ''}`)
      // Axios interceptor should have returned res.data, but to be safe:
      return (res as any).success || (res.data as any)?.success || false
    } catch (error) {
      console.error('Delete data error:', error)
      return false
    }
  },

  // 获取数据详情
  get: async (id: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/data/${id}`)
  },

  // 工参更新（异步任务）
  updateParameters: async (fullParamId: string, currentParamId: string): Promise<ApiResponse<{ taskId: string; message: string }>> => {
    return apiClient.post('/data/update-parameters', { fullParamId, currentParamId })
  },

  /** 获取工参更新任务进度 */
  getUpdateParamsProgress: async (taskId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/data/update-parameters/progress/${taskId}`)
  },

  /** 获取工参更新任务结果 */
  getUpdateParamsResult: async (taskId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/data/update-parameters/result/${taskId}`)
  },

  // 导入点数据
  importPoints: async (filePath: string): Promise<ApiResponse<any[]>> => {
    return apiClient.post('/data/import-points', { file_path: filePath })
  },

  // 下载模板
  downloadTemplate: async (templateType: 'full_params' | 'target_cells'): Promise<void> => {
    const url = `/data/template/${templateType}`

    // 强制使用 Fetch + Blob 模式，这种方式在 Electron 和浏览器中最稳定
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)

    const blob = await response.blob()
    if (blob.size === 0) throw new Error('文件内容为空')

    // 直接根据templateType设置文件名
    let filename = 'template.xlsx'
    if (templateType === 'full_params') {
      filename = 'ProjectParameter.xlsx'
    } else if (templateType === 'target_cells') {
      filename = 'cell-tree-export.xlsx'
    }

    // 从响应头获取文件名作为备选（如果CORS允许的话）
    const contentDisposition = response.headers.get('content-disposition')
    console.log('[Template Download] Content-Disposition header:', contentDisposition)

    if (contentDisposition) {
      // 尝试多种文件名解析方式
      // 1. 标准 filename 格式: filename="filename"
      let filenameMatch = contentDisposition.match(/filename="([^"]+)"/i)
      if (filenameMatch) {
        filename = filenameMatch[1]
        console.log('[Template Download] Parsed filename from header (standard):', filename)
      } else {
        // 2. 简单 filename 格式: filename=filename
        filenameMatch = contentDisposition.match(/filename=([^;]+)/i)
        if (filenameMatch) {
          filename = filenameMatch[1]
          console.log('[Template Download] Parsed filename from header (simple):', filename)
        }
      }
    }

    console.log('[Template Download] Final filename:', filename, 'Blob size:', blob.size)

    const blobUrl = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = blobUrl
    link.setAttribute('download', filename)
    document.body.appendChild(link)
    link.click()

    // 清理
    setTimeout(() => {
      document.body.removeChild(link)
      window.URL.revokeObjectURL(blobUrl)
    }, 100)

    console.log('[Template Download] Success:', filename)
  },

  // 获取工参数据的列名
  getColumns: async (dataId: string, networkType?: 'LTE' | 'NR'): Promise<ApiResponse<{ columns: string[]; networkType?: string; total: number }>> => {
    const params = networkType ? `?network_type=${networkType}` : ''
    return apiClient.get(`/data/${dataId}/columns${params}`)
  },

  // 新站录入：向全量工参追加小区
  addCell: async (data: {
    networkType: 'LTE' | 'NR'
    managedElementId: string
    siteId: string
    cellId: string
    cellName: string
    longitude: number
    latitude: number
    azimuth: number
    frequency?: string
    ssbFrequency?: string
    cellCoverType: number
  }): Promise<ApiResponse<any>> => {
    return apiClient.post('/data/full-params/cells', data)
  },

  // 批量新站录入：一次提交多个小区（支持 LTE/NR 混合）
  batchAddCells: async (cells: Array<{
    networkType: 'LTE' | 'NR'
    managedElementId: string
    siteId: string
    cellId: string
    cellName: string
    mcc?: string
    mnc?: string
    longitude: number
    latitude: number
    height?: number
    azimuth: number
    frequency?: string
    ssbFrequency?: string
    cellCoverType: number
  }>): Promise<ApiResponse<{ results: Array<{ index: number; networkType: string; cellName: string; siteId: string; cellId: string; success: boolean; message: string }>; total: number; successCount: number }>> => {
    return apiClient.post('/data/full-params/cells/batch', { cells })
  },

  // 批量查重：LTE 按 基站_小区、NR 按 MCC_MNC_基站_小区 检查是否已存在于数据库
  checkCellDuplicates: async (cells: Array<{ siteId: string; cellId: string; networkType?: 'LTE' | 'NR'; mcc?: string; mnc?: string }>): Promise<ApiResponse<{ duplicates: string[]; exists: Record<string, { lte: boolean; nr: boolean }> }>> => {
    return apiClient.post('/data/full-params/cells/check-duplicates', { cells })
  },

  // 查询/更新：智能搜索小区
  searchCells: async (query: string, networkType?: 'LTE' | 'NR', limit = 20): Promise<ApiResponse<CellSearchItem[]>> => {
    return apiClient.post('/data/full-params/cells/search', { query, networkType, limit })
  },

  // 查询/更新：批量更新 + 删除小区
  bulkUpdateCells: async (payload: {
    updates: Array<{ rowKey: string; networkType: 'LTE' | 'NR'; fields: Record<string, string | number | undefined> }>
    deletes: Array<{ rowKey: string; networkType: 'LTE' | 'NR' }>
  }): Promise<ApiResponse<{ results: CellBulkUpdateResultItem[]; updated: number; deleted: number }>> => {
    return apiClient.post('/data/full-params/cells/bulk-update', payload)
  },

  // 清理无效索引
  cleanupIndex: async (): Promise<ApiResponse<{ removed: number; items: Array<{ id: string; name: string; reason: string }> }>> => {
    return apiClient.post('/data/cleanup/index')
  }
}

// PCI规划API
export const pciApi = {
  // 开始规划
  plan: async (config: PCIConfig): Promise<ApiResponse<{ taskId: string; message: string }>> => {
    return apiClient.post('/pci/plan', config)
  },

  // 获取规划进度
  getProgress: async (taskId: string): Promise<ApiResponse<TaskProgress>> => {
    return apiClient.get(`/pci/progress/${taskId}`)
  },

  // 获取规划结果
  getResult: async (taskId: string): Promise<ApiResponse<PCIResult>> => {
    return apiClient.get(`/pci/result/${taskId}`)
  },

  // 导出结果
  export: async (taskId: string, format: 'xlsx' | 'csv'): Promise<Blob> => {
    const response = await apiClient.get(`/pci/export/${taskId}`, {
      responseType: 'blob',
      params: { format }
    })
    // 注意：对于blob响应，响应拦截器会返回完整的响应对象，而不是response.data
    // 因此需要直接访问response.data获取Blob对象
    return response.data  // Blob直接返回data
  },

  // 应用到工参（异步任务模式）
  applyToParams: async (taskId: string): Promise<ApiResponse<{ taskId: string; message: string }>> => {
    return apiClient.post(`/pci/apply-to-params/${taskId}`)
  },

  // 批量应用到工参（合并多个任务结果，一次更新）
  applyBatch: async (taskIds: string[]): Promise<ApiResponse<any>> => {
    return apiClient.post('/pci/apply-batch', { taskIds })
  },

  // 获取应用到工参进度
  getApplyProgress: async (applyTaskId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/pci/apply-to-params/progress/${applyTaskId}`)
  },

  // 获取历史任务列表
  getHistory: async (page = 1, pageSize = 20): Promise<ApiResponse<any[]>> => {
    return apiClient.get('/pci/history', { params: { page, page_size: pageSize } })
  },

  // 删除历史任务
  deleteHistory: async (taskId: string): Promise<ApiResponse<any>> => {
    return apiClient.delete(`/pci/history/${taskId}`)
  },

  // 获取应用到工参结果
  getApplyResult: async (applyTaskId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/pci/apply-to-params/result/${applyTaskId}`)
  },

  // 标记任务为已应用
  markApplied: async (taskId: string): Promise<ApiResponse<any>> => {
    return apiClient.post(`/pci/history/${taskId}/mark-applied`)
  }
}

// TAC核查API
export const tacApi = {
  // 开始核查
  plan: async (config: any): Promise<ApiResponse<{ taskId: string; message: string }>> => {
    return apiClient.post('/tac/plan', config)
  },

  // 获取核查进度
  getProgress: async (taskId: string): Promise<ApiResponse<TaskProgress>> => {
    return apiClient.get(`/tac/progress/${taskId}`)
  },

  // 获取核查结果
  getResult: async (taskId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/tac/result/${taskId}`)
  },

  // 获取历史任务列表
  getHistory: async (page = 1, pageSize = 20): Promise<ApiResponse<any[]>> => {
    return apiClient.get('/tac/history', { params: { page, page_size: pageSize } })
  },

  // 删除历史任务
  deleteHistory: async (taskId: string): Promise<ApiResponse<any>> => {
    return apiClient.delete(`/tac/history/${taskId}`)
  },

  // 导出核查结果
  export: async (taskId: string, format: 'xlsx' | 'csv'): Promise<Blob> => {
    const response = await apiClient.get(`/tac/export/${taskId}`, {
      responseType: 'blob',
      params: { format }
    })
    return response.data
  }
}

// TAC规划API
export const tacPlanningApi = {
  // 开始规划
  plan: async (config: any): Promise<ApiResponse<{ taskId: string; message: string }>> => {
    return apiClient.post('/tac/planning/plan', config)
  },

  // 获取规划进度
  getProgress: async (taskId: string): Promise<ApiResponse<TaskProgress>> => {
    return apiClient.get(`/tac/planning/progress/${taskId}`)
  },

  // 获取历史任务列表
  getHistory: async (page = 1, pageSize = 20): Promise<ApiResponse<any[]>> => {
    return apiClient.get('/tac/planning/history', { params: { page, page_size: pageSize } })
  },

  // 删除历史任务
  deleteHistory: async (taskId: string): Promise<ApiResponse<any>> => {
    return apiClient.delete(`/tac/planning/history/${taskId}`)
  },

  // 获取规划结果
  getResult: async (taskId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/tac/planning/result/${taskId}`)
  },

  // 导出规划结果
  export: async (taskId: string, format: 'xlsx' | 'csv'): Promise<Blob> => {
    const response = await apiClient.get(`/tac/planning/export/${taskId}`, {
      responseType: 'blob',
      params: { format }
    })
    return response.data
  },

  // 应用到工参（异步任务模式）
  applyToParams: async (taskId: string): Promise<ApiResponse<{ taskId: string; message: string }>> => {
    return apiClient.post(`/tac/planning/apply-to-params/${taskId}`)
  },

  // 批量应用到工参
  applyBatch: async (taskIds: string[]): Promise<ApiResponse<any>> => {
    return apiClient.post('/tac/planning/apply-batch', { taskIds })
  },

  // 获取应用到工参进度
  getApplyProgress: async (applyTaskId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/tac/planning/apply-to-params/progress/${applyTaskId}`)
  },

  // 获取应用到工参结果
  getApplyResult: async (applyTaskId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/tac/planning/apply-to-params/result/${applyTaskId}`)
  },

  // 标记任务为已应用
  markApplied: async (taskId: string): Promise<ApiResponse<any>> => {
    return apiClient.post(`/tac/planning/history/${taskId}/mark-applied`)
  }
}

// 邻区规划API
export const neighborApi = {
  // 开始规划
  plan: async (config: NeighborConfig): Promise<ApiResponse<{ taskId: string; message: string }>> => {
    return apiClient.post('/neighbor/plan', config)
  },

  // 获取规划进度
  getProgress: async (taskId: string): Promise<ApiResponse<TaskProgress>> => {
    return apiClient.get(`/neighbor/progress/${taskId}`)
  },

  // 获取规划结果
  getResult: async (taskId: string): Promise<ApiResponse<NeighborResult>> => {
    return apiClient.get(`/neighbor/result/${taskId}`)
  },

  // 获取历史任务列表
  getHistory: async (page = 1, pageSize = 20): Promise<ApiResponse<any[]>> => {
    return apiClient.get('/neighbor/history', { params: { page, page_size: pageSize } })
  },

  // 删除历史任务
  deleteHistory: async (taskId: string): Promise<ApiResponse<any>> => {
    return apiClient.delete(`/neighbor/history/${taskId}`)
  },

  // 导出结果
  export: async (taskId: string, format: 'xlsx' | 'csv'): Promise<Blob> => {
    const response = await apiClient.get(`/neighbor/export/${taskId}`, {
      responseType: 'blob',
      params: { format }
    })
    return response.data
  }
}

// 地图API
export const mapApi = {
  // 获取地图数据
  getData: async (): Promise<ApiResponse<any>> => {
    return apiClient.get('/map/data')
  },

  // 获取小区选择列表（轻量API）
  getCells: async (): Promise<ApiResponse<{ lte: any[]; nr: any[]; total: number }>> => {
    return apiClient.get('/map/cells')
  },

  // 获取在线地图配置
  getOnlineConfig: async (): Promise<ApiResponse<any>> => {
    return apiClient.get('/map/online-config')
  },

  // 获取离线地图路径
  getOfflinePath: async (): Promise<ApiResponse<{ path: string }>> => {
    return apiClient.get('/map/offline-path')
  },

  // 清除地图缓存
  clearCache: async (): Promise<ApiResponse<any>> => {
    return apiClient.post('/map/cache/clear')
  }
}

/**
 * 文本 gzip 压缩（浏览器 CompressionStream，无需第三方库）。
 * 用于大图层保存请求体压缩；环境不支持或压缩失败时返回 null（调用方回退明文请求）。
 */
async function gzipText(text: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

// 图层文件API
export const layerApi = {
  // 获取数据集的图层文件列表
  getLayers: async (dataId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/data/${dataId}/layers`)
  },

  // 获取图层要素数据
  // 大图层首次请求（缓存未命中时后端 gpd 解析 + 坐标转换）可能较慢，单独放宽超时
  getLayerData: async (dataId: string, layerId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/data/${dataId}/layers/${layerId}/data`, { timeout: 600000 })
  },

  // 获取图层的字段名列表（同样调用 get_layer_data，放宽超时）
  getLayerColumns: async (dataId: string, layerId: string): Promise<ApiResponse<{ fields: string[]; layerId: string; total: number }>> => {
    return apiClient.get(`/data/${dataId}/layers/${layerId}/columns`, { timeout: 600000 })
  },

  // 新建空图层（format: tab/shp/geojson；geometryType 可选，默认 mixed。
  // Shapefile 单文件只支持一种几何类型，mixed 会被后端拒绝）
  createLayer: async (payload: { name: string; geometryType?: string; format?: string }): Promise<ApiResponse<{ data_id: string; layer_id: string; name: string; geometry_type?: string; format?: string }>> => {
    return apiClient.post('/data/map/layers/create', payload)
  },

  // 保存图层编辑结果（整层重写 TAB；geojson 坐标为 GCJ02）
  // payload 二选一：
  //   { geojson }  整层保存（大图层首次保存 / 无版本指纹时）
  //   { patch }    增量保存（只回传变更要素，base 携带基底要素数与版本指纹；服务端冲突返回 409）
  // 请求体 gzip 压缩（大图层 40MB → ~13MB，上传耗时大幅缩短）；不支持 CompressionStream 时回退明文
  saveLayerData: async (
    dataId: string,
    layerId: string,
    payload: { geojson?: any; patch?: any },
  ): Promise<ApiResponse<{ success: boolean; feature_count: number; mode?: 'full' | 'patch'; version?: string }>> => {
    const url = `/data/${dataId}/layers/${layerId}/data`
    const gz = await gzipText(JSON.stringify(payload))
    if (gz) {
      return apiClient.put(url, gz, {
        timeout: 600000,
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      })
    }
    return apiClient.put(url, payload, { timeout: 600000 })
  },

  // 获取图层要素数据 + 版本指纹（ETag = "<layerId>-<源文件 mtime>"）
  // 版本指纹用于增量保存的基底校验：与服务端不一致时回退整层保存，避免按错行覆盖
  getLayerDataWithVersion: async (
    dataId: string,
    layerId: string,
  ): Promise<{ data: any; version: string | null }> => {
    const response = await apiClient.get(`/data/${dataId}/layers/${layerId}/data`, {
      timeout: 600000,
      headers: { 'Content-Type': 'application/json' },
      _returnFullResponse: true,
    } as any)
    const payload = response.data || {}
    return { data: payload?.data ?? payload, version: response.headers?.etag ?? null }
  },

  // 下载图层的 MapInfo 全套文件（.tab/.dat/.id/.map）zip（"另存为"）
  downloadLayerZip: async (dataId: string, layerId: string, layerName: string): Promise<void> => {
    const { blob, filename } = await layerApi.fetchLayerZip(dataId, layerId, layerName)
    const blobUrl = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = blobUrl
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(blobUrl)
  },

  // 仅取回 zip 内容（供"另存为"先弹系统路径选择框再写入，不直接触发浏览器下载）
  fetchLayerZip: async (
    dataId: string,
    layerId: string,
    layerName: string,
  ): Promise<{ blob: Blob; filename: string }> => {
    // 用 apiClient（baseURL /api/v1 + 自动附带鉴权头）而非裸 fetch，
    // 否则缺 /api/v1 前缀会 404 或命中 SPA 回退，导致只得到损坏的单文件而非 zip
    const response = await apiClient.get(`/data/${dataId}/layers/${layerId}/download`, {
      responseType: 'blob',
    })
    const blob = response.data as Blob
    if (!blob || blob.size === 0) throw new Error('文件内容为空')

    // 解析文件名：优先 filename*=（RFC5987，UTF-8），回退 filename=，再回退图层名
    let filename = `${layerName || 'layer'}.tab.zip`
    const cd = response.headers?.['content-disposition']
    if (cd) {
      const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i)
      if (star) {
        filename = decodeURIComponent(star[1].replace(/"/g, ''))
      } else {
        const plain = cd.match(/filename="([^"]+)"/i) || cd.match(/filename=([^;]+)/i)
        if (plain) filename = plain[1].trim().replace(/"/g, '')
      }
    }
    return { blob, filename }
  },

  // 数据管理导入文件的原始文件下载（与数据管理页"下载"同源端点，返回上传时的原文件）
  fetchDataFile: async (dataId: string, fallbackName: string): Promise<{ blob: Blob; filename: string }> => {
    const response = await apiClient.get(`/data/${dataId}/download`, {
      responseType: 'blob',
    })
    const blob = response.data as Blob
    if (!blob || blob.size === 0) throw new Error('文件内容为空')
    // 解析文件名：优先 filename*=（RFC5987，UTF-8），回退 filename=
    let filename = fallbackName || 'file'
    const cd = response.headers?.['content-disposition']
    if (cd) {
      const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i)
      if (star) {
        filename = decodeURIComponent(star[1].replace(/"/g, ''))
      } else {
        const plain = cd.match(/filename="([^"]+)"/i) || cd.match(/filename=([^;]+)/i)
        if (plain) filename = plain[1].trim().replace(/"/g, '')
      }
    }
    return { blob, filename }
  }
}

// ===== 条件选择（图层属性空间连接）=====
export const attributeJoinApi = {
  // 创建并启动任务，返回 taskId
  plan: async (body: AttributeJoinRequest): Promise<ApiResponse<{ taskId: string }>> => {
    return apiClient.post('/attribute-join/plan', body)
  },
  // 查询进度（完成时 data 为结果统计）
  getProgress: async (taskId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/attribute-join/progress/${taskId}`)
  },
  // 查询结果
  getResult: async (taskId: string): Promise<ApiResponse<AttributeJoinStats>> => {
    return apiClient.get(`/attribute-join/result/${taskId}`)
  },
  // 下载 xlsx（blob；文件名由调用方指定）
  download: async (taskId: string): Promise<Blob> => {
    const response = await apiClient.get(`/attribute-join/download/${taskId}`, {
      responseType: 'blob',
    })
    const blob = response.data as Blob
    if (!blob || blob.size === 0) throw new Error('文件内容为空')
    return blob
  },
}

// ===== 绘制缓冲区 =====
export const bufferApi = {
  // 创建并启动任务，返回 taskId
  plan: async (body: BufferRequest): Promise<ApiResponse<{ taskId: string }>> => {
    return apiClient.post('/buffer/plan', body)
  },
  // 查询进度（完成时 data 为结果统计）
  getProgress: async (taskId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/buffer/progress/${taskId}`)
  },
  // 查询结果
  getResult: async (taskId: string): Promise<ApiResponse<BufferStats>> => {
    return apiClient.get(`/buffer/result/${taskId}`)
  },
}

// ===== 图层制作（生成 tab/mif/kml）=====
export interface LayerExcelInfo {
  sheets: string[]
  columns: Record<string, string[]>
}

export interface GenerateLayerResult {
  filename: string
  download_url: string
  stats?: {
    total: number
    success: number
    failed: number
    failures: Record<string, number>
    failedDetails?: Array<{ row: number; name: string; reason: string }>
  }
}

export interface GenerateLayerParams {
  filePath: string        // 分块上传后的服务器路径
  sourceFilename?: string // 原始源文件名（用于输出命名）
  sheetName: string
  nameCol: string
  lonCol: string
  latCol: string
  azimuthCol?: string
  attributes: string[]
  outputFormats: Array<'tab' | 'mif' | 'kml'>  // 多格式
  outputFormat?: 'tab' | 'mif' | 'kml'          // 旧单值，兼容
  radiusM?: number
  beamwidth?: number
  lineWidth?: number
  pointSize?: number
  pointShape?: string
  color?: string
  // 样式：边框颜色/填充颜色/透明度（0-1，0=不透明 1=全透明，前端 0-100 映射到 0-1）
  borderColor?: string
  fillColor?: string
  opacity?: number
}

export interface LayerUploadResult {
  file_path: string
  source_filename: string
  name: string
}

// 图层制作 API（生成新图层，区别于读取已有图层的 layerApi）
export const layerToolsApi = {
  // 分块上传 Excel 文件，返回 file_path + source_filename（进度回调）
  uploadLayerFile: async (
    file: File,
    onProgress?: (p: { percent: number; step: 'uploading' | 'assembling' | 'done' }) => void,
  ): Promise<LayerUploadResult> => {
    onProgress?.({ percent: 0, step: 'uploading' })
    const result = await chunkedUpload(file, '/data/upload', 'layer', (p) => {
      onProgress?.({ percent: p, step: 'uploading' })
    }, true)   // trackProgress：写入模块级 uploadStore（跨页恢复 + 取消按钮）
    const data = result?.data
    if (!data?.file_path) {
      throw new Error('文件上传失败，未获取到文件路径')
    }
    onProgress?.({ percent: 100, step: 'done' })
    return {
      file_path: data.file_path,
      source_filename: data.source_filename || file.name,
      name: data.name || file.name,
    }
  },

  // 读取 Excel 的 sheet 和列信息（用 file_path）
  getExcelInfo: async (filePath: string, sourceFilename?: string): Promise<LayerExcelInfo> => {
    const formData = new FormData()
    formData.append('file_path', filePath)
    if (sourceFilename) formData.append('source_filename', sourceFilename)
    const res = await uploadClient.post('/layer/excel-info', formData)
    return res.data
  },

  // 生成扇区图层（用 file_path）
  generateSector: async (params: GenerateLayerParams): Promise<GenerateLayerResult> => {
    const formData = new FormData()
    formData.append('file_path', params.filePath)
    if (params.sourceFilename) formData.append('source_filename', params.sourceFilename)
    formData.append('sheet_name', params.sheetName)
    formData.append('name_col', params.nameCol)
    formData.append('lon_col', params.lonCol)
    formData.append('lat_col', params.latCol)
    formData.append('azimuth_col', params.azimuthCol || '')
    formData.append('attributes', JSON.stringify(params.attributes))
    // 多格式优先，兼容旧单值
    formData.append('output_formats', (params.outputFormats || [params.outputFormat!]).join(','))
    if (params.radiusM) formData.append('radius_m', String(params.radiusM))
    if (params.beamwidth) formData.append('beamwidth', String(params.beamwidth))
    if (params.lineWidth) formData.append('line_width', String(params.lineWidth))
    if (params.color) formData.append('color', params.color)
    if (params.borderColor) formData.append('border_color', params.borderColor)
    if (params.fillColor) formData.append('fill_color', params.fillColor)
    if (params.opacity != null) formData.append('opacity', String(params.opacity))
    const res = await uploadClient.post('/layer/sector', formData)
    return res.data
  },

  // 生成点图层（用 file_path）
  generatePoint: async (params: GenerateLayerParams): Promise<GenerateLayerResult> => {
    const formData = new FormData()
    formData.append('file_path', params.filePath)
    if (params.sourceFilename) formData.append('source_filename', params.sourceFilename)
    formData.append('sheet_name', params.sheetName)
    formData.append('name_col', params.nameCol)
    formData.append('lon_col', params.lonCol)
    formData.append('lat_col', params.latCol)
    formData.append('attributes', JSON.stringify(params.attributes))
    // 多格式优先，兼容旧单值
    formData.append('output_formats', (params.outputFormats || [params.outputFormat!]).join(','))
    if (params.color) formData.append('color', params.color)
    if (params.borderColor) formData.append('border_color', params.borderColor)
    if (params.fillColor) formData.append('fill_color', params.fillColor)
    if (params.opacity != null) formData.append('opacity', String(params.opacity))
    if (params.pointSize) formData.append('point_size', String(params.pointSize))
    if (params.pointShape) formData.append('point_shape', params.pointShape)
    const res = await uploadClient.post('/layer/point', formData)
    return res.data
  },
}

// ===== 平均站间距计算 =====
export interface SiteSpacingParseError {
  sheet: string
  row: number
  reason: string
}

export interface SiteSpacingParseResult {
  success: boolean
  data: {
    total: number
    errors: SiteSpacingParseError[]
  }
}

/** 结果行分页预览（站间距 / 距离匹配共用形状） */
export interface ResultRowsPage {
  success: boolean
  data: {
    columns: string[]
    total: number
    offset: number
    limit: number
    rows: (string | number | null)[][]
  }
}

export interface SiteSpacingResult {
  success: boolean
  data: {
    filename: string
    /** 结果行文件的标识（= 结果 Excel 的 stem），用于分页预览 */
    result_id?: string
    download_url: string
    total: number
    counted: number
    overall_avg_km: number
    k: number
    errors?: SiteSpacingParseError[]
  }
}

export const siteSpacingApi = {
  // 解析 + 校验站点文件
  parse: async (filePath: string): Promise<SiteSpacingParseResult> => {
    const formData = new FormData()
    formData.append('file_path', filePath)
    return uploadClient.post('/site-spacing/parse', formData)
  },

  // 读取数据管理工参原始 Excel 的真实 sheet 列表（缺失时兜底网络分表）
  getDataSheets: async (dataId: string): Promise<ApiResponse<{ sheets: string[]; source: 'excel' | 'network' }>> => {
    const formData = new FormData()
    formData.append('data_id', dataId)
    return uploadClient.post('/site-spacing/data-sheets', formData)
  },

  // 执行平均站间距计算
  calculate: async (params: {
    filePath?: string
    k: number
    fullSource: 'file' | 'data'
    fullSheetName: string
    fullDataId?: string
    fullNameCol?: string
    fullLonCol?: string
    fullLatCol?: string
  }): Promise<SiteSpacingResult> => {
    const formData = new FormData()
    if (params.filePath) formData.append('file_path', params.filePath)
    formData.append('k', String(params.k))
    formData.append('full_source', params.fullSource)
    formData.append('full_sheet_name', params.fullSheetName)
    if (params.fullDataId) {
      formData.append('full_data_id', params.fullDataId)
      if (params.fullNameCol) formData.append('full_name_col', params.fullNameCol)
      if (params.fullLonCol) formData.append('full_lon_col', params.fullLonCol)
      if (params.fullLatCol) formData.append('full_lat_col', params.fullLatCol)
    }
    return uploadClient.post('/site-spacing/calculate', formData)
  },

  // 分页读取结果行（页内列表懒加载）
  preview: async (params: {
    resultId: string
    offset?: number
    limit?: number
  }): Promise<ResultRowsPage> => {
    const formData = new FormData()
    formData.append('result_id', params.resultId)
    formData.append('offset', String(params.offset ?? 0))
    if (params.limit != null) formData.append('limit', String(params.limit))
    return uploadClient.post('/site-spacing/preview', formData)
  },

  // 模板下载（带认证，blob 方式）
  downloadTemplate: async (): Promise<void> => {
    const res = await uploadClient.get('/site-spacing/template', { responseType: 'blob' })
    const blob = res as unknown as Blob
    if (!(blob instanceof Blob) || blob.size === 0) throw new Error('模板下载失败：文件内容为空')
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = '站间距计算-模板.xlsx'
    document.body.appendChild(link)
    link.click()
    setTimeout(() => {
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
    }, 100)
  },
}

// ===== 批量距离匹配 =====
export interface DistanceMatchParseError {
  sheet: string
  row: number
  reason: string
}

export interface DistanceMatchParseResult {
  success: boolean
  data: {
    match_total: number
    full_total: number
    errors: DistanceMatchParseError[]
  }
}

export interface DistanceMatchResult {
  success: boolean
  data: {
    filename: string
    /** 结果行文件的标识（= 结果 Excel 的 stem），用于分页预览 */
    result_id?: string
    download_url: string
    total?: number
    errors?: DistanceMatchParseError[]
  }
}

export const distanceMatchApi = {
  // 解析 + 校验清单
  parse: async (filePath: string): Promise<DistanceMatchParseResult> => {
    const formData = new FormData()
    formData.append('file_path', filePath)
    return uploadClient.post('/distance-match/parse', formData)
  },

  // 读取数据管理工参原始 Excel 的真实 sheet 列表（缺失时兜底网络分表）
  getDataSheets: async (dataId: string): Promise<ApiResponse<{ sheets: string[]; source: 'excel' | 'network' }>> => {
    const formData = new FormData()
    formData.append('data_id', dataId)
    return uploadClient.post('/distance-match/data-sheets', formData)
  },

  // 执行匹配（相邻站点：上传文件 或 数据管理工参，二选一）
  match: async (params: {
    filePath: string
    matchSheetName: string
    maxDistanceKm: number
    fullSource: 'file' | 'data'
    fullSheetName: string
    fullDataId?: string
    fullNameCol?: string
    fullLonCol?: string
    fullLatCol?: string
  }): Promise<DistanceMatchResult> => {
    const formData = new FormData()
    formData.append('file_path', params.filePath)
    formData.append('match_sheet_name', params.matchSheetName)
    formData.append('max_distance_km', String(params.maxDistanceKm))
    formData.append('full_source', params.fullSource)
    formData.append('full_sheet_name', params.fullSheetName)
    if (params.fullDataId) {
      formData.append('full_data_id', params.fullDataId)
      if (params.fullNameCol) formData.append('full_name_col', params.fullNameCol)
      if (params.fullLonCol) formData.append('full_lon_col', params.fullLonCol)
      if (params.fullLatCol) formData.append('full_lat_col', params.fullLatCol)
    }
    return uploadClient.post('/distance-match/match', formData)
  },

  // 分页读取结果行（页内列表懒加载）
  preview: async (params: {
    resultId: string
    offset?: number
    limit?: number
  }): Promise<ResultRowsPage> => {
    const formData = new FormData()
    formData.append('result_id', params.resultId)
    formData.append('offset', String(params.offset ?? 0))
    if (params.limit != null) formData.append('limit', String(params.limit))
    return uploadClient.post('/distance-match/preview', formData)
  },

  // 模板下载（带认证，blob 方式）
  downloadTemplate: async (): Promise<void> => {
    const res = await uploadClient.get('/distance-match/template', { responseType: 'blob' })
    // uploadClient 拦截器对 blob 响应已解包为 Blob（直接返回 response.data）
    const blob = res as unknown as Blob
    if (!(blob instanceof Blob) || blob.size === 0) throw new Error('模板下载失败：文件内容为空')
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = '站点匹配清单-模板.xlsx'
    document.body.appendChild(link)
    link.click()
    setTimeout(() => {
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
    }, 100)
  },
}

/**
 * 🔥 后端连接状态管理
 * 提供健康检查轮询和连接状态通知，以便前端组件可以响应后端掉线
 */
export type ConnectionStatus = 'connected' | 'disconnected' | 'checking'

let _connectionListeners: Array<(status: ConnectionStatus) => void> = []
let _currentStatus: ConnectionStatus = 'connected'
let _healthCheckTimer: ReturnType<typeof setInterval> | null = null

/** 获取当前连接状态 */
export function getConnectionStatus(): ConnectionStatus {
  return _currentStatus
}

/** 订阅连接状态变化 */
export function onConnectionChange(listener: (status: ConnectionStatus) => void): () => void {
  _connectionListeners.push(listener)
  return () => {
    _connectionListeners = _connectionListeners.filter(l => l !== listener)
  }
}

function _notifyStatus(status: ConnectionStatus) {
  _currentStatus = status
  for (const listener of _connectionListeners) {
    try { listener(status) } catch { /* ignore */ }
  }
}

/** 手动执行健康检查 */
export async function checkHealth(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const resp = await fetch('/health', { signal: controller.signal })
    clearTimeout(timeout)
    if (resp.ok) {
      if (_currentStatus !== 'connected') {
        console.log('[HealthCheck] ✅ 后端已恢复连接')
        _notifyStatus('connected')
      }
      return true
    }
    return false
  } catch {
    if (_currentStatus !== 'disconnected') {
      console.warn('[HealthCheck] ❌ 后端连接丢失')
      _notifyStatus('disconnected')
    }
    return false
  }
}

/**
 * 启动健康检查轮询
 * @param intervalMs 检查间隔（默认 15 秒）
 */
export function startHealthCheck(intervalMs: number = 15000): void {
  stopHealthCheck()
  _healthCheckTimer = setInterval(checkHealth, intervalMs)
  // 立即执行一次
  checkHealth()
}

/** 停止健康检查轮询 */
export function stopHealthCheck(): void {
  if (_healthCheckTimer) {
    clearInterval(_healthCheckTimer)
    _healthCheckTimer = null
  }
}

export default apiClient

// ============== 认证API ==============
export const authApi = {
  login: async (data: LoginRequest): Promise<ApiResponse<TokenResponse>> => {
    return apiClient.post('/auth/login', data) as any
  },

  getOptions: async (): Promise<ApiResponse<RegisterOptions>> => {
    return apiClient.get('/auth/options') as any
  },

  register: async (data: RegisterRequest): Promise<ApiResponse<TokenResponse>> => {
    return apiClient.post('/auth/register', data) as any
  },

  getMe: async (): Promise<ApiResponse<UserInfo>> => {
    return apiClient.get('/auth/me') as any
  },

  ping: async (): Promise<ApiResponse<{ last_activity: string }>> => {
    return apiClient.post('/auth/ping') as any
  },

  logout: async (): Promise<ApiResponse<any>> => {
    return apiClient.post('/auth/logout') as any
  },

  changePassword: async (data: ChangePasswordRequest): Promise<ApiResponse<any>> => {
    return apiClient.post('/auth/change-password', data) as any
  },

  /** 桌面版免登录会话（仅 NPT_DESKTOP=1 的本机后端可用，服务器返回 404） */
}

/** 系统信息（公开）：含运行形态标识，桌面端据此走免登录 */
export const systemApi = {
  info: async (): Promise<ApiResponse<{ version: string; desktop_mode: boolean }>> => {
    return apiClient.get('/system/info') as any
  },

  /** 运行形态探测专用：标准 {success, data} 包裹（/system/info 是裸模型，给手机端用） */
  desktopMode: async (): Promise<ApiResponse<{ desktop_mode: boolean }>> => {
    return apiClient.get('/system/desktop-mode') as any
  },
}

// ============== 管理员用户管理API ==============
export const adminUserApi = {
  listUsers: async (page: number = 1, pageSize: number = 20, search?: string, isActive?: boolean): Promise<ApiResponse<UserListResponse>> => {
    const params: any = { page, page_size: pageSize }
    if (search) params.search = search
    if (isActive !== undefined) params.is_active = isActive
    return apiClient.get('/admin/users/', { params }) as any
  },

  createUser: async (data: RegisterRequest & { is_admin?: boolean; license_expiry?: string | null }): Promise<ApiResponse<UserInfo>> => {
    return apiClient.post('/admin/users/', data) as any
  },

  getUser: async (userId: number): Promise<ApiResponse<UserDetailResponse>> => {
    return apiClient.get(`/admin/users/${userId}`) as any
  },

  updateUser: async (userId: number, data: UserUpdateRequest): Promise<ApiResponse<UserInfo>> => {
    return apiClient.put(`/admin/users/${userId}`, data) as any
  },

  deleteUser: async (userId: number): Promise<ApiResponse<any>> => {
    return apiClient.delete(`/admin/users/${userId}`) as any
  },

  resetPassword: async (userId: number, data: ResetPasswordRequest): Promise<ApiResponse<any>> => {
    return apiClient.post(`/admin/users/${userId}/reset-password`, data) as any
  },
}

// ============== 用户个性化设置 API ==============
// 存储用户的图层控制、标签设置等个性化配置，按用户持久化
export const userSettingsApi = {
  /** 获取当前用户的个性化设置 */
  getSettings: async (): Promise<ApiResponse<{ user_id: number; settings: Record<string, any>; updated_at: string | null }>> => {
    return apiClient.get('/user/settings') as any
  },

  /** 更新当前用户的个性化设置（全量替换） */
  updateSettings: async (settings: Record<string, any>): Promise<ApiResponse<{ user_id: number; settings: Record<string, any>; updated_at: string }>> => {
    return apiClient.put('/user/settings', { settings }) as any
  },
}

// ============== APP 版本管理 API ==============
export const appVersionsApi = {
  /** 获取版本列表（管理员） */
  list: async (page = 1, pageSize = 20) => {
    const res = await apiClient.get('/app-versions', { params: { page, page_size: pageSize } })
    return res  // apiClient 拦截器已返回 response.data
  },

  /** 获取最新版本（公开） */
  getLatest: async () => {
    const res = await apiClient.get('/app-versions/latest')
    return res  // apiClient 拦截器已返回 response.data
  },

  /**
   * 上传新版本（管理员）- 使用分块上传避免 Cloudflare 413 限制
   * APK 文件通常 >100MB，Cloudflare 默认限制 100MB。
   * 使用 1MB 分块（比数据文件 500KB 更大，减少分块数）和指数退避重试。
   */
  upload: async (formData: FormData) => {
    const file = formData.get('file') as File
    const version = formData.get('version') as string
    const changelog = (formData.get('changelog') as string) || ''
    const isLatest = formData.get('is_latest') === 'true'

    if (!file) throw new Error('请选择 APK 文件')
    if (!version) throw new Error('请输入版本号')

    const basePath = '/app-versions/chunked'
    // APK 分块使用 1MB（比数据文件的 500KB 更大），减少分块数量降低出错概率
    const APK_CHUNK_SIZE = 1024 * 1024
    const APK_MAX_RETRIES = 5
    const totalChunks = Math.ceil(file.size / APK_CHUNK_SIZE)
    console.log(`[AppVersions] 分块上传 APK: ${file.name}, 大小: ${file.size}, 分块数: ${totalChunks} (${APK_CHUNK_SIZE / 1024}KB/块)`)

    // 阶段1: 初始化上传会话
    const startForm = new FormData()
    startForm.append('filename', file.name)
    startForm.append('total_chunks', String(totalChunks))
    startForm.append('total_size', String(file.size))
  const startResp = await uploadClient.post(`${basePath}/start`, startForm)
    const uploadId = startResp.data?.id || startResp.data?.data?.id
    if (!uploadId) throw new Error('无法创建上传会话')

    // 阶段2: 逐块上传（指数退避重试）
    for (let i = 0; i < totalChunks; i++) {
      const start = i * APK_CHUNK_SIZE
      const end = Math.min(start + APK_CHUNK_SIZE, file.size)
      const chunk = file.slice(start, end)

      let retries = 0
      let success = false
      while (!success && retries < APK_MAX_RETRIES) {
        try {
          const chunkForm = new FormData()
          chunkForm.append('file', chunk)
          chunkForm.append('chunk_index', String(i))
          await uploadClient.post(`${basePath}/${uploadId}/chunk`, chunkForm)
          success = true
          console.log(`[AppVersions] 分块 ${i + 1}/${totalChunks} 上传完成`)
        } catch {
          retries++
          if (retries >= APK_MAX_RETRIES) {
            try { await uploadClient.post(`${basePath}/${uploadId}/cancel`) } catch { /* ignore */ }
            throw new Error(`分块 ${i + 1}/${totalChunks} 上传失败，已重试 ${APK_MAX_RETRIES} 次`)
          }
          // 指数退避：1s → 2s → 4s → 8s
          const backoff = Math.pow(2, retries - 1) * 1000
          console.warn(`[AppVersions] 分块 ${i + 1}/${totalChunks} 重试 ${retries}/${APK_MAX_RETRIES} (等待 ${backoff}ms)`)
          await new Promise(r => setTimeout(r, backoff))
        }
      }
    }

    // 阶段3: 完成上传（传递版本信息）- 需要管理员 token
    const completeForm = new FormData()
    completeForm.append('version', version)
    completeForm.append('changelog', changelog)
    if (isLatest) completeForm.append('is_latest', 'true')

    // 手动从 localStorage 获取 auth token（uploadClient 无自动拦截器）
    let authToken = ''
    try {
      const stored = localStorage.getItem('auth-storage')
      if (stored) {
        const parsed = JSON.parse(stored)
        authToken = parsed?.state?.token || ''
      }
    } catch { /* ignore */ }

    const completeHeaders: Record<string, string> = {}
    if (authToken) {
      completeHeaders['Authorization'] = `Bearer ${authToken}`
    }

    const result = await uploadClient.post(`${basePath}/${uploadId}/complete`, completeForm, {
      headers: completeHeaders,
    })
    return result
  },

  /** 编辑版本（管理员） */
  update: async (id: number, data: { version?: string; changelog?: string; is_latest?: boolean }) => {
    const res = await apiClient.put(`/app-versions/${id}`, data)
    return res
  },

  /** 删除版本（管理员） */
  delete: async (id: number) => {
    const res = await apiClient.delete(`/app-versions/${id}`)
    return res
  },

  /** 扫描导入本地 APK 文件（管理员）
   *  将 apks/ 目录下未注册的 .apk 文件导入数据库 */
  importLocal: async (params?: { mark_latest?: boolean; changelog?: string }) => {
    const formData = new FormData()
    // 必须至少发送一个字段，避免空 FormData 导致 FastAPI 解析失败
    formData.append('mark_latest', params?.mark_latest !== undefined ? String(params.mark_latest) : 'true')
    if (params?.changelog) formData.append('changelog', params.changelog)
    const res = await apiClient.post('/app-versions/import-local', formData)
    return res
  },
}

// ==================== 网优助手 ====================
export interface AssistantChart {
  type: 'line' | 'bar' | 'scatter' | string
  title?: string
  xAxis?: any[]
  yAxis?: any[]
  series?: any[]
  points?: any[]
  center?: [number, number]
}
export interface AssistantDataset {
  id: string
  name: string
  fileType: 'station_params' | 'station_metrics'
  status?: string
  size?: number
  createdAt?: string
  fields?: string[]
  rowCount?: number
  granularity?: string
  timeRange?: [string, string]
}
export interface LLMConfig {
  protocol?: string
  base_url?: string
  model?: string
  timeout?: number
  has_api_key?: boolean
  api_key_masked?: string
  configured?: boolean
}
export const assistantApi = {
  /** 读取大模型配置（密钥脱敏） */
  getLlmConfig: async (): Promise<LLMConfig> => apiClient.get('/assistant/config'),

  /** 保存大模型配置（api_key 传空串表示不修改） */
  saveLlmConfig: async (cfg: {
    protocol?: string; base_url?: string; api_key?: string; model?: string; timeout?: number
  }): Promise<{ success: boolean; configured: boolean }> => apiClient.put('/assistant/config', cfg),

  /** 测试连接 */
  testLlmConfig: async (): Promise<{ success: boolean; reply?: string; error?: string }> =>
    apiClient.post('/assistant/config/test'),

  /** 对话 */
  chat: async (messages: { role: string; content: string }[]): Promise<{
    success: boolean; configured: boolean; reply: string;
    charts: AssistantChart[]; message?: string
  }> => apiClient.post('/assistant/chat', { messages }),

  /** 数据集列表 */
  listDatasets: async (): Promise<{ success: boolean; data: AssistantDataset[]; total: number }> =>
    apiClient.get('/assistant/datasets'),

  /** 上传基站参数/指标文件（后台解析，返回 pollKey） */
  uploadDataset: async (file: File, dataType: 'station_params' | 'station_metrics') => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('data_type', dataType)
    return uploadClient.post('/assistant/datasets/upload', fd)
  },

  /** 轮询上传解析状态 */
  uploadStatus: async (pollKey: string): Promise<{ status: string; result?: AssistantDataset; error?: string }> =>
    apiClient.get(`/assistant/datasets/upload-status?poll_key=${encodeURIComponent(pollKey)}`),

  /** 删除数据集 */
  deleteDataset: async (id: string): Promise<{ success: boolean }> =>
    apiClient.delete(`/assistant/datasets/${id}`),
}
