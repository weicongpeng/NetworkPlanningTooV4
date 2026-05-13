import { create } from 'zustand'
import { dataApi } from '../services/api'
import type { DataItem, ApiResponse } from '@shared/types'
import { useTaskStore } from './taskStore'
import { indexedDBService } from '../services/indexedDBService'

const DATA_LIST_CACHE_KEY = 'data_list_cache'
const DATA_LIST_CACHE_TTL = 5 * 60 * 1000 // 5分钟缓存

// 全局数据更新事件名称
export const DATA_REFRESH_EVENT = 'data-list-refresh'

// 触发数据刷新事件（用于跨页面通信）
export function triggerDataRefresh() {
  window.dispatchEvent(new CustomEvent(DATA_REFRESH_EVENT))
}

interface DataListCache {
  items: DataItem[]
  total: number
  page: number
  pageSize: number
  timestamp: number
}

interface DataState {
  items: DataItem[]
  total: number
  currentPage: number
  pageSize: number
  loading: boolean
  uploadingType: string | null
  isUpdating: boolean  // 工参更新专用 loading 状态
  error: string | null
  fetchList: (page?: number, pageSize?: number, forceRefresh?: boolean) => Promise<void>
  uploadExcel: (file: File, context?: string) => Promise<boolean>
  uploadMap: (file: File, context?: string) => Promise<boolean>
  uploadGeoData: (file: File, filePath?: string) => Promise<boolean>
  deleteItem: (id: string) => Promise<boolean>
  updateParameters: (fullParamId: string, currentParamId: string) => Promise<ApiResponse<{ newFileId: string; newFileName: string; savedToOriginal: boolean } | null>>
  downloadTemplate: (templateType: 'full_params' | 'target_cells') => Promise<void>
}

export const useDataStore = create<DataState>((set, get) => ({
  items: [],
  total: 0,
  currentPage: 1,
  pageSize: 50,
  loading: false,
  uploadingType: null,
  isUpdating: false,
  error: null,

  fetchList: async (page: number = 1, pageSize: number = 50, forceRefresh: boolean = false) => {
    set({ loading: true, error: null })

    // 尝试从缓存读取
    if (!forceRefresh) {
      try {
        const cached = await indexedDBService.get<DataListCache>(DATA_LIST_CACHE_KEY)
        if (cached && cached.page === page && cached.pageSize === pageSize) {
          // 检查缓存是否过期
          const now = Date.now()
          if (now - cached.timestamp < DATA_LIST_CACHE_TTL) {
            console.log('[DataStore] 使用缓存的数据列表')
            set({
              items: cached.items,
              total: cached.total,
              currentPage: page,
              pageSize: pageSize,
              loading: false
            })
            return
          }
        }
      } catch (error) {
        console.warn('[DataStore] 读取缓存失败:', error)
      }
    }

    try {
      const response: ApiResponse<DataItem[]> & { total?: number } = await dataApi.list(page, pageSize, forceRefresh)
      const items = response.data || []
      const total = response.total || items.length

      // 更新状态
      set({
        items,
        total,
        currentPage: page,
        pageSize: pageSize,
        loading: false
      })

      // 缓存结果
      try {
        const cacheData: DataListCache = {
          items,
          total,
          page,
          pageSize,
          timestamp: Date.now()
        }
        await indexedDBService.set(DATA_LIST_CACHE_KEY, cacheData, DATA_LIST_CACHE_TTL)
      } catch (error) {
        console.warn('[DataStore] 写入缓存失败:', error)
      }
    } catch (error: any) {
      set({
        error: error.message || '获取数据列表失败',
        loading: false
      })
    }
  },

  uploadExcel: async (file: File, context: string = 'excel') => {
    console.log('[dataStore.uploadExcel] START - file:', file, 'context:', context)

    set({ loading: true, uploadingType: context, error: null })
    try {
      // 获取文件全路径 (仅在Electron环境下有效)
      let filePath = (file as any).path;

      console.log('[dataStore.uploadExcel] Initial file.path:', filePath)

      // 尝试使用暴露的 electronAPI (更安全/新版推荐方式)
      // 修复：添加 await 等待 Promise 解析
      if (!filePath && (window as any).electronAPI?.getFilePath) {
          try {
              filePath = await (window as any).electronAPI.getFilePath(file);
              console.log('[dataStore.uploadExcel] Got file path from electronAPI:', filePath);
          } catch (e) {
              console.warn('[dataStore.uploadExcel] Failed to get path via electronAPI:', e);
          }
      }

      console.log('[dataStore.uploadExcel] Final filePath:', filePath)
      console.log('[dataStore.uploadExcel] File object:', {
        name: file?.name,
        size: file?.size,
        type: file?.type,
        isFile: file instanceof File
      })

      await dataApi.uploadExcel(file, filePath)
      await get().fetchList(1, 50, true)  // 上传成功后强制刷新
      set({ loading: false, uploadingType: null })
      return true
    } catch (error: any) {
      console.error('[dataStore.uploadExcel] ERROR:', error)
      set({
        error: error.message || '上传失败',
        loading: false,
        uploadingType: null
      })
      return false
    }
  },

  uploadMap: async (file: File, context: string = 'map') => {
    set({ loading: true, uploadingType: context, error: null })
    try {
      let filePath = (file as any).path;
      
      if (!filePath && (window as any).electronAPI?.getFilePath) {
          try {
              // 修复：添加 await 等待 Promise 解析
              filePath = await (window as any).electronAPI.getFilePath(file);
              console.log('Got file path from electronAPI:', filePath);
          } catch (e) {
              console.warn('Failed to get path via electronAPI:', e);
          }
      }
      
      console.log('Upload Map:', file.name, 'Path:', filePath);

      await dataApi.uploadMap(file, filePath)
      await get().fetchList(1, 50, true)  // 上传成功后强制刷新
      set({ loading: false, uploadingType: null })
      return true
    } catch (error: any) {
      set({
        error: error.message || '上传失败',
        loading: false,
        uploadingType: null
      })
      return false
    }
  },

  deleteItem: async (id: string) => {
    set({ loading: true, error: null })
    try {
      await dataApi.delete(id)
      await get().fetchList(1, 50, true)  // 删除成功后强制刷新
      set({ loading: false })
      return true
    } catch (error: any) {
      set({
        error: error.message || '删除失败',
        loading: false
      })
      return false
    }
  },

  updateParameters: async (fullParamId: string, currentParamId: string) => {
    set({ isUpdating: true, error: null })

    // 生成任务ID用于全局跟踪
    const taskId = `param_update_${fullParamId}_${currentParamId}`

    try {
      // 在全局任务store中开始任务
      useTaskStore.getState().startTask(taskId, 'parameter_update', '正在更新工参...')

      const response = await dataApi.updateParameters(fullParamId, currentParamId)
      await get().fetchList(1, 50, true)  // 更新成功后强制刷新

      // 任务完成
      useTaskStore.getState().completeTask(taskId)

      set({ isUpdating: false })
      return response
    } catch (error: any) {
      // 任务失败
      useTaskStore.getState().failTask(taskId, error.message || '工参更新失败')

      set({
        error: error.message || '工参更新失败',
        isUpdating: false
      })
      return { success: false, message: error.message || '工参更新失败', data: null }
    }
  },

  downloadTemplate: async (templateType: 'full_params' | 'target_cells') => {
    await dataApi.downloadTemplate(templateType)
  },

  uploadGeoData: async (file: File, filePath?: string) => {
    console.log('[dataStore.uploadGeoData] START - file:', file, 'filePath:', filePath)

    set({ loading: true, uploadingType: 'geo_data', error: null })
    try {
      // 获取文件全路径 (仅在Electron环境下有效)
      let finalFilePath = filePath

      if (!finalFilePath && (window as any).electronAPI?.getFilePath) {
        try {
          finalFilePath = await (window as any).electronAPI.getFilePath(file)
          console.log('[dataStore.uploadGeoData] Got file path from electronAPI:', finalFilePath)
        } catch (e) {
          console.warn('[dataStore.uploadGeoData] Failed to get path via electronAPI:', e)
        }
      }

      console.log('[dataStore.uploadGeoData] Final filePath:', finalFilePath)

      await dataApi.uploadGeoData(file, finalFilePath)
      await get().fetchList(1, 50, true)  // 上传成功后强制刷新
      set({ loading: false, uploadingType: null })
      return true
    } catch (error: any) {
      console.error('[dataStore.uploadGeoData] ERROR:', error)

      // 解析错误信息，提供更友好的提示
      let errorMsg = error.message || '上传失败'

      // 如果后端返回了详细错误，提取关键信息
      if (errorMsg.includes('未找到必需的经纬度字段')) {
        errorMsg = '未找到经纬度字段，请确保表格包含经度、纬度或 longitude、latitude 等列'
      } else if (errorMsg.includes('有效数据少于50%')) {
        errorMsg = '有效数据少于50%，请检查坐标值是否在有效范围内（经度-180~180，纬度-90~90）'
      } else if (errorMsg.includes('编码不支持')) {
        errorMsg = '文件编码不支持，请使用 UTF-8 或 GBK 编码'
      } else if (errorMsg.includes('格式无法识别')) {
        errorMsg = '文件格式无法识别，请确保使用正确的分隔符'
      }

      set({
        error: errorMsg,
        loading: false,
        uploadingType: null
      })
      return false
    }
  },

  // 获取工参更新任务的状态（从全局任务store中获取）
  getUpdateTaskStatus: () => {
    // 检查是否有正在运行的 parameter_update 类型任务
    const runningTasks = useTaskStore.getState().getRunningTasks()
    const hasUpdateTask = runningTasks.some(task => task.type === 'parameter_update')
    return hasUpdateTask ? 'running' : 'idle'
  }
}))
