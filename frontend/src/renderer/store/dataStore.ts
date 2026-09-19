import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { dataApi } from '../services/api'
import { mapApi } from '../services/api'
import { indexedDBService } from '../services/indexedDBService'
import type { DataItem, ApiResponse } from '@shared/types'
import { useTaskStore } from './taskStore'
import { clearCellListCache, bumpDataVersion } from '../services/mapDataService'
import { userCacheSuffix } from '../utils/cacheKey'

const CACHE_TTL_5MIN = 5 * 60 * 1000

// 数据列表缓存按登录用户隔离（同浏览器切换账号时不得读到他账号的数据）
const dataListCacheKey = () => `data_list_cache${userCacheSuffix()}`

// 全局数据更新事件名称
export const DATA_REFRESH_EVENT = 'data-list-refresh'

// 防抖：2 秒内多次触发只发送一次事件，避免多页面同时响应产生惊群效应
let _lastRefreshTime = 0
const REFRESH_DEBOUNCE_MS = 2000

/** 刷新范围：full=数据增删/上传（各页面全量刷新）；layer=仅图层内容变化（地图页跳过扇区数据重载） */
export type DataRefreshScope = 'full' | 'layer'

// 触发数据刷新事件（用于跨页面通信）
// scope='layer' 由"图层保存"触发：数据条目本身未变（仅图层内容与上传时间），
// 地图页无需重载扇区数据/重绘，避免保存后地图卡顿数秒。
export function triggerDataRefresh(scope: DataRefreshScope = 'full') {
  const now = Date.now()
  if (now - _lastRefreshTime < REFRESH_DEBOUNCE_MS) return
  _lastRefreshTime = now
  // 清除小区列表缓存，确保各页面新建任务时获取最新数据
  clearCellListCache()
  window.dispatchEvent(new CustomEvent(DATA_REFRESH_EVENT, { detail: { scope } }))
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
  isAddingCell: boolean  // 新站录入专用 loading 状态
  error: string | null
  fetchList: (page?: number, pageSize?: number, forceRefresh?: boolean) => Promise<void>
  uploadExcel: (file: File, context?: string) => Promise<boolean>
  uploadMap: (file: File, context?: string, extraFiles?: File[]) => Promise<boolean>
  uploadGeoData: (file: File, filePath?: string) => Promise<boolean>
  deleteItem: (id: string) => Promise<boolean>
  updateParameters: (fullParamId: string, currentParamId: string) => Promise<ApiResponse<{ newFileId: string; newFileName: string; savedToOriginal: boolean } | null>>
  downloadTemplate: (templateType: 'full_params' | 'target_cells') => Promise<void>
  addCell: (data: {
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
  }) => Promise<{ success: boolean; message?: string; data?: any }>
  batchAddCells: (cells: Array<{
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
  }>) => Promise<{ success: boolean; message?: string; data?: any }>
}

export const useDataStore = create<DataState>((set, get) => ({
  items: [],
  total: 0,
  currentPage: 1,
  pageSize: 50,
  loading: false,
  uploadingType: null,
  isUpdating: false,
  isAddingCell: false,
  error: null,

  fetchList: async (page: number = 1, pageSize: number = 50, forceRefresh: boolean = false) => {
    set({ loading: true, error: null })

    // 尝试从缓存读取
    if (!forceRefresh) {
      try {
        const cached = await indexedDBService.get<DataListCache>(dataListCacheKey())
        if (cached && cached.page === page && cached.pageSize === pageSize) {
          // 检查缓存是否过期
          const now = Date.now()
          if (now - cached.timestamp < CACHE_TTL_5MIN) {
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
        await indexedDBService.set(dataListCacheKey(), cacheData, CACHE_TTL_5MIN)
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

  uploadMap: async (file: File, context: string = 'map', extraFiles?: File[]) => {
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

      console.log('Upload Map:', file.name, 'Path:', filePath, 'Companions:', extraFiles?.map(f => f.name));

      await dataApi.uploadMap(file, filePath, extraFiles)
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
      // 删除后清除 IndexedDB 缓存（不内部刷新列表，由调用方统一处理刷新）
      await indexedDBService.delete(dataListCacheKey())
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

      // 1. 创建异步任务（立即返回 taskId，避免 Cloudflare 120s 超时）
      const response = await dataApi.updateParameters(fullParamId, currentParamId)
      const actualTaskId = response?.data?.taskId

      if (!actualTaskId) {
        throw new Error(response?.message || '启动工参更新任务失败')
      }

      // 2. 轮询等待后台任务完成（最长 10 分钟）
      const maxWait = 600000  // 10 min
      const pollInterval = 2000  // 每 2 秒检查一次
      const startTime = Date.now()
      let finalResult: any = null

      while (Date.now() - startTime < maxWait) {
        await new Promise(r => setTimeout(r, pollInterval))

        try {
          const progressResp = await dataApi.getUpdateParamsProgress(actualTaskId)
          const progressData = progressResp?.data

          if (progressData?.status === 'completed') {
            finalResult = progressData
            break
          } else if (progressData?.status === 'failed') {
            throw new Error(progressData?.error || '工参更新失败')
          }
          // status === 'processing' 或 'pending'，继续轮询
        } catch (pollErr: any) {
          // 404 表示任务索引尚未持久化，继续轮询
          if (pollErr?.code === 404) {
            continue
          }
          throw pollErr
        }
      }

      useTaskStore.getState().completeTask(taskId)

      if (finalResult) {
        set({ isUpdating: false })
        return {
          success: true,
          data: {
            newFileId: finalResult.newFileId,
            newFileName: finalResult.newFileName,
            savedToOriginal: finalResult.savedToOriginal,
          }
        }
      }

      // 超时但后台可能仍在处理，视为失败
      set({ isUpdating: false })
      return { success: false, message: '工参更新超时，请稍后刷新数据列表查看结果', data: null }
    } catch (error: any) {
      // 任务失败 - 不在store中设置error（由页面组件处理异常后的刷新逻辑）
      useTaskStore.getState().failTask(taskId, error.message || '工参更新失败')

      set({ isUpdating: false })
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
  },

  // 新站录入
  addCell: async (data) => {
    set({ isAddingCell: true, error: null })
    try {
      const result = await dataApi.addCell(data)
      if (result?.success) {
        // 录入成功后刷新列表 + 清除缓存
        await get().fetchList(1, 50, true)
        await clearCellListCache()
        bumpDataVersion()
        try { await mapApi.clearCache() } catch (_) {}
        set({ isAddingCell: false })
        return { success: true, message: result.message, data: result.data }
      }
      set({ isAddingCell: false })
      return { success: false, message: result?.message || '录入失败' }
    } catch (error: any) {
      set({
        error: error.message || '录入失败',
        isAddingCell: false,
      })
      return { success: false, message: error.message || '录入失败' }
    }
  },

  // 批量新站录入
  batchAddCells: async (cells) => {
    set({ isAddingCell: true, error: null })
    try {
      const result = await dataApi.batchAddCells(cells)
      if (result?.success) {
        // 成功后刷新数据列表
        await get().fetchList(1, 50, true)
        // 清除所有缓存层，确保小区选择列表能立即看到新数据
        await clearCellListCache()                         // ① 前端 getCellList 缓存（内存 + IndexedDB）
        bumpDataVersion()                                  // ② sessionStorage 版本号（mapDataService 强制刷新）
        try { await mapApi.clearCache() } catch (_) {}    // ③ 后端 30min 内存缓存
        set({ isAddingCell: false })
        return { success: true, message: result.message, data: result.data }
      }
      set({ isAddingCell: false })
      return { success: false, message: result?.message || '批量录入失败', data: result?.data }
    } catch (error: any) {
      set({
        error: error.message || '批量录入失败',
        isAddingCell: false,
      })
      return { success: false, message: error.message || '批量录入失败' }
    }
  }
}))
