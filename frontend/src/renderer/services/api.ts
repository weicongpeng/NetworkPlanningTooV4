import axios from 'axios'
import type {
  ApiResponse,
  LicenseStatus,
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
  UserInfo,
  UserListResponse,
  UserUpdateRequest,
  UserDetailResponse,
} from '@shared/types'

const API_BASE_URL = '/api/v1'

// 开发环境下的直接后端 URL（绕过 Vite 代理的 multipart/form-data 问题）
// 使用环境变量配置
const DEV_BACKEND_URL = import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.hostname}:8000/api/v1`

// 检测是否是开发环境
const isDev = import.meta.env.DEV

console.log('[API] Environment:', { isDev, API_BASE_URL, DEV_BACKEND_URL })

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

  // 管理员更新全局授权期限
  updateExpiry: async (expiryDate: string | null): Promise<ApiResponse<any>> => {
    return apiClient.post('/license/update-expiry', { expiry_date: expiryDate }) as any
  },
}

// ===== 优化后的分块上传（动态分块 + 串行 + 指数退避） =====
//
// 场景：大文件通过 Cloudflare Tunnel（约 37KB/s，120s 超时限制）上传
// 生产环境后端单 worker（NPT_WORKERS=1），并行上传会导致请求排队超时（502），
// 因此保持串行上传，配合动态分块大小和指数退避重试。
// 优化策略：
//   1. 动态分块大小：小文件(2MB) / 中等文件(1MB) / 大文件(512KB)
//   2. 串行上传：避免单 worker 排队超时
//   3. 指数退避重试：失败后 2s → 4s → 8s 等待
//   4. 专用状态查询：从 /data/{id} 查询状态，替代全量列表轮询
//
const MAX_CHUNK_RETRIES = 3      // 每块最多重试 3 次

/** 根据文件大小动态计算分块大小 */
function calcChunkSize(fileSize: number): number {
  if (fileSize < 3 * 1024 * 1024) {
    return 2 * 1024 * 1024       // < 3MB → 2MB 分块（极小文件直接 1-2 块传完）
  } else if (fileSize < 50 * 1024 * 1024) {
    return 1024 * 1024            // 3-50MB → 1MB 分块（~27s/块，避免健康检测超时）
  }
  return 512 * 1024               // > 50MB → 512KB 分块（确保每块在 15s 内完成）
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
 * @param fileType 可选的文件类型：'excel' | 'geo_data'
 */
async function chunkedUpload(
  file: File,
  basePath: string,
  fileType?: string
): Promise<any> {
  const chunkSize = calcChunkSize(file.size)
  const totalChunks = Math.ceil(file.size / chunkSize)
  console.log(`[chunkedUpload] 开始分块上传: ${file.name}, 大小: ${file.size}, 分块大小: ${(chunkSize/1024).toFixed(0)}KB, 分块数: ${totalChunks}`)

  // 阶段1: 初始化上传会话
  const startForm = new FormData()
  startForm.append('filename', file.name)
  startForm.append('total_chunks', String(totalChunks))
  startForm.append('total_size', String(file.size))

  const startResp = await uploadClient.post(`${basePath}/start`, startForm)
  const dataId = startResp.data?.id || startResp.data?.data?.id
  if (!dataId) {
    throw new Error('无法创建上传会话')
  }
  console.log(`[chunkedUpload] 会话已创建: ${dataId}`)

  // 阶段2: 串行上传分块（单 worker 后端 + Cloudflare Tunnel 需避免排队超时）
  for (let i = 0; i < totalChunks; i++) {
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

        await uploadClient.post(`${basePath}/${dataId}/chunk`, chunkForm)
        success = true
        console.log(`[chunkedUpload] 分块 ${i + 1}/${totalChunks} 完成 (${end - start} 字节)`)
      } catch (err) {
        retries++
        console.warn(`[chunkedUpload] 分块 ${i + 1}/${totalChunks} 失败 (重试 ${retries}/${MAX_CHUNK_RETRIES}):`, (err as any)?.message || err)
        if (retries >= MAX_CHUNK_RETRIES) {
          // 取消上传会话
          try { await uploadClient.post(`${basePath}/${dataId}/cancel`) } catch { /* ignore */ }
          throw new Error(`分块 ${i + 1}/${totalChunks} 上传失败，已重试 ${MAX_CHUNK_RETRIES} 次`)
        }
        const delay = backoffDelay(retries)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  // 阶段3: 完成上传（触发后台处理）
  const completeForm = new FormData()
  completeForm.append('filename', file.name)
  if (fileType) {
    completeForm.append('file_type', fileType)
  }

  const completeResp = await uploadClient.post(`${basePath}/${dataId}/complete`, completeForm)
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

      try {
        // 使用 /data/list 轮询（Cloudflare Tunnel 下比 /data/{id} 更稳定）
        // 传入 cacheBust=true 避免浏览器缓存
        const listResult: any = await apiClient.get('/data/list?page=1&page_size=100&_t=' + Date.now())
        const items = listResult?.data || listResult || []
        const found = Array.isArray(items) ? items.find((item: any) => item.id === pollDataId) : null

        if (found) {
          if (found.status === 'ready') {
            console.log('[chunkedUpload] 后台处理完成:', pollDataId)
            result.data.status = 'ready'
            result.data.fileType = found.fileType
            break
          } else if (found.status === 'error') {
            console.error('[chunkedUpload] 后台处理失败:', pollDataId)
            throw new Error(found.errorMessage || '文件处理失败')
          }
        }
      } catch (pollErr: any) {
        // 502 等错误时等待稍长再重试，避免频繁请求压垮后端
        console.warn('[chunkedUpload] 轮询出错（2s后重试）:', pollErr?.message || pollErr)
        await new Promise(r => setTimeout(r, 2000))
      }
    }

    if (result?.data?.status !== 'ready') {
      console.warn('[chunkedUpload] 轮询超时，但文件可能仍在处理中')
    }
  }

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

  /** 上传地图文件并保存到服务器 - 使用原生 fetch API */
  uploadMap: async (file: File | null, filePath?: string): Promise<ApiResponse<any>> => {
    console.log('[uploadMap] START - file:', file, 'filePath:', filePath)

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
    console.log('[uploadMap] Sending fetch request to:', url)

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    })

    console.log('[uploadMap] Response status:', response.status)

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[uploadMap] Error response:', errorText)
      throw new Error(`上传失败: ${response.status} ${errorText}`)
    }

    const result = await response.json()
    console.log('[uploadMap] Success response:', result)
    return result
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
      filename = 'ProjectParameter_mongoose.xlsx'
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
    azimuth: number
    frequency?: string
    ssbFrequency?: string
    cellCoverType: number
  }>): Promise<ApiResponse<{ results: Array<{ index: number; networkType: string; cellName: string; siteId: string; cellId: string; success: boolean; message: string }>; total: number; successCount: number }>> => {
    return apiClient.post('/data/full-params/cells/batch', { cells })
  },

  // 批量查重：按制式检查 CGI (siteId_cellId) 是否已存在于数据库
  checkCellDuplicates: async (cells: Array<{ siteId: string; cellId: string; networkType?: 'LTE' | 'NR' }>): Promise<ApiResponse<{ duplicates: string[]; exists: Record<string, { lte: boolean; nr: boolean }> }>> => {
    return apiClient.post('/data/full-params/cells/check-duplicates', { cells })
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
  getHistory: async (): Promise<ApiResponse<any[]>> => {
    return apiClient.get('/pci/history')
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
  getHistory: async (): Promise<ApiResponse<any[]>> => {
    return apiClient.get('/tac/history')
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
  getHistory: async (): Promise<ApiResponse<any[]>> => {
    return apiClient.get('/tac/planning/history')
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
  getHistory: async (): Promise<ApiResponse<any[]>> => {
    return apiClient.get('/neighbor/history')
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

// 图层文件API
export const layerApi = {
  // 获取数据集的图层文件列表
  getLayers: async (dataId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/data/${dataId}/layers`)
  },

  // 获取图层要素数据
  getLayerData: async (dataId: string, layerId: string): Promise<ApiResponse<any>> => {
    return apiClient.get(`/data/${dataId}/layers/${layerId}/data`)
  },

  // 获取图层的字段名列表
  getLayerColumns: async (dataId: string, layerId: string): Promise<ApiResponse<{ fields: string[]; layerId: string; total: number }>> => {
    return apiClient.get(`/data/${dataId}/layers/${layerId}/columns`)
  }
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

    const completeHeaders = {}
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
