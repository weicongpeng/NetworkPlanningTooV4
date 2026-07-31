import { useState, useEffect, useCallback, useRef } from 'react'
import { Upload, FileSpreadsheet, Trash2, Download, Loader2, AlertCircle, RefreshCw, CheckCircle2, Layers, FileDown, MapPin, Navigation, CheckSquare, Square, ScrollText, Maximize2, Minimize2 } from 'lucide-react'
import { useDataStore } from '../store/dataStore'
import { dataApi } from '../services/api'
import type { DataItem } from '@shared/types'
import { DATA_REFRESH_EVENT, triggerDataRefresh } from '../store/dataStore'
import { mapDataService } from '../services/mapDataService'
import { indexedDBService } from '../services/indexedDBService'
import { useDownloadStore } from '../store/downloadStore'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../store/authStore'

export function DataPage() {
  const { t } = useTranslation()
  // 细粒度权限：管理员自动拥有全部权限
  const currentUser = useAuthStore((s) => s.user)
  const isAdmin = !!currentUser?.is_admin
  const permImport = isAdmin || !!currentUser?.can_data_import
  const permDelete = isAdmin || !!currentUser?.can_data_delete
  const permUpdate = isAdmin || !!currentUser?.can_data_update
  const permCellEntry = isAdmin || !!currentUser?.can_cell_entry

  const [selectedId, setSelectedId] = useState<string | null>(null)

  // 批量选择状态
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchDeleting, setBatchDeleting] = useState(false)

  // 工参更新相关状态
  const [selectedFullParamId, setSelectedFullParamId] = useState<string>('')
  const [selectedCurrentParamId, setSelectedCurrentParamId] = useState<string>('')
  const [updateSuccess, setUpdateSuccess] = useState<string | null>(null)

  // 上传成功消息
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null)

  // 各上传项的状态
  const [uploadStatus, setUploadStatus] = useState<Record<string, 'idle' | 'success' | 'error'>>({
    full_params: 'idle',
    current_params: 'idle',
    map_layer: 'idle',
    geo_data: 'idle',
  })

  // 下载状态跟踪
  const downloadStore = useDownloadStore()

  // 操作日志（持久化到 sessionStorage，退出登录/刷新页面时清除）
  interface LogEntry {
    id: number
    time: string
    type: 'upload' | 'download' | 'delete' | 'update' | 'terminal' | 'info' | 'error'
    message: string
    detail?: string
    status?: 'running' | 'success' | 'error'
    // 用于去重覆盖的 key（同一操作的多次状态变更共用同一 key）
    opKey?: string
  }
  // 模块级持久化存储（页面切换保留，刷新页面后自然消失）
  const _store: { entries: LogEntry[]; id: number } = (window as any).__nptLog || ((window as any).__nptLog = { entries: [], id: 0 })

  const [logs, setLogs] = useState<LogEntry[]>(_store.entries)
  const LOG_STORAGE_KEY = 'npt_operation_logs'
  const logEndRef = useRef<HTMLDivElement>(null)

  // 退出登录时清除日志
  useEffect(() => {
    const handleLogout = () => {
      _store.entries = []
      setLogs([])
      try { sessionStorage.removeItem(LOG_STORAGE_KEY) } catch {}
    }
    window.addEventListener('auth:logout', handleLogout)
    return () => window.removeEventListener('auth:logout', handleLogout)
  }, [])

  const addLog = useCallback((
    type: LogEntry['type'],
    message: string,
    status?: LogEntry['status'],
    detail?: string,
    opKey?: string,
  ) => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    _store.id += 1
    const entry: LogEntry = { id: _store.id, time, type, message, status, detail, opKey }

    // 直接在模块级数组上操作，避免 React 闭包问题
    const arr = _store.entries
    let replaced = false
    if (opKey && arr.length > 0) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].opKey === opKey) { arr[i] = entry; replaced = true; break }
      }
    }
    if (!replaced) {
      if (arr.length >= 200) arr.shift()
      arr.push(entry)
    }
    // 用新数组引用触发 React 重渲染
    setLogs([...arr])
  }, [])

  // 自动滚动到最新日志
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  const {
    items,
    loading,
    uploadingType,
    isUpdating,
    error,
    fetchList,
    uploadExcel,
    uploadMap,
    uploadGeoData,
    deleteItem,
    updateParameters,
  } = useDataStore()

  // 打开数据页时刷新用户权限（感知管理员的最新权限配置）
  useEffect(() => {
    useAuthStore.getState().fetchUser()
  }, [])

  // 初始化数据列表 + 监听跨页面刷新事件
  useEffect(() => {
    fetchList(1, 50, true)  // forceRefresh=true 跳过 IndexedDB 缓存，确保同步状态最新

    // 监听数据刷新事件（从其他页面触发，如PCI应用后）
    const handleDataRefresh = () => {
      console.log('[DataPage] 收到数据刷新事件，正在刷新列表...')
      fetchList(1, 50, true)
    }

    window.addEventListener(DATA_REFRESH_EVENT, handleDataRefresh)

    return () => {
      window.removeEventListener(DATA_REFRESH_EVENT, handleDataRefresh)
    }
  }, [])

  // 定时轮询：挂载后始终运行，每 5 秒检查是否有需要同步的文件
  // 只有检测到 excelSynced===false 时才发起带 forceRefresh 的 API 请求
  // 从不自终止（避免缓存导致误判），组件卸载时自动清理
  useEffect(() => {
    const timer = setInterval(() => {
      const current = useDataStore.getState().items
      if (current.some(item => item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined))) {
        fetchList(1, 50, true)  // forceRefresh=true 跳过 IndexedDB 缓存
      }
    }, 5000)

    return () => clearInterval(timer)
  }, [fetchList])

  const isDesktop = !!(window as any).electronAPI

  const handleDownloadTemplate = async (templateType: 'full_params' | 'target_cells' | 'geo_data') => {
    try {
      // 确定下载文件名
      let filename: string
      if (templateType === 'full_params') {
        filename = 'ProjectParameter_mongoose.xlsx'
      } else if (templateType === 'target_cells') {
        filename = 'cell-tree-export.xlsx'
      } else if (templateType === 'geo_data') {
        filename = 'GeoDataTemplate.zip'
      } else {
        filename = 'template.xlsx'
      }
      const url = `/api/v1/data/template/${templateType}`

      console.log('[Template Download] Requesting:', templateType, 'as', filename)

      // 强制使用 Fetch + Blob 模式
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)

      const blob = await response.blob()
      if (blob.size === 0) throw new Error(t('data.emptyFile') || '文件内容为空')

      console.log('[Template Download] Blob size:', blob.size)

      // 优先使用 File System Access API 弹出保存对话框
      if ('showSaveFilePicker' in window) {
        try {
          const ext = filename.endsWith('.zip') ? '.zip' : '.xlsx';
          const opts: any = {
            suggestedName: filename,
            types: ext === '.zip'
              ? [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }]
              : [{ description: 'Excel File', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }]
          };
          const handle = await (window as any).showSaveFilePicker(opts);
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          console.log('[Template Download] Saved via File Picker:', filename);
          return;
        } catch (pickerErr: any) {
          if (pickerErr.name === 'AbortError') {
            console.log('[Template Download] User cancelled');
            return;
          }
          console.warn('[Template Download] showSaveFilePicker failed, falling back:', pickerErr);
        }
      }

      const blobUrl = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = blobUrl
      link.setAttribute('download', filename)
      document.body.appendChild(link)
      link.click()

      setTimeout(() => {
        document.body.removeChild(link)
        window.URL.revokeObjectURL(blobUrl)
      }, 100)

      console.log('[Template Download] Success:', filename)
    } catch (err: any) {
      console.error('[Template Download] Failed:', err)
      alert(`${t('data.downloadTemplateFailed') || '下载模板失败'}: ${err.message || (t('data.unknownError') || '未知错误')}`)
    }
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>, type: 'excel' | 'map', context: string) => {
    const files = Array.from(event.target.files || [])
    if (files.length === 0) return

    // 详尽日志
    console.log('[Upload] Starting upload process')
    console.log('[Upload] Mode:', isDesktop ? 'Desktop' : 'Web Browser')
    console.log('[Upload] Files:', files.map(f => f.name).join(', '))
    console.log('[Upload] Type:', type, 'Context:', context)

    const fileNames = files.map(f => f.name).join(', ')
    addLog('upload', `开始${context === 'geo_data' ? '地理化' : context === 'full_params' ? '全量工参' : context === 'current_params' ? '现网工参' : context === 'map_layer' ? '图层' : ''}上传: ${fileNames}`, 'running', undefined, `upload:${fileNames}`)

    // 根据类型选择上传函数
    let uploadFn
    if (context === 'geo_data') {
      uploadFn = uploadGeoData
    } else {
      uploadFn = type === 'excel' ? uploadExcel : uploadMap
    }

    // 设置上传状态为进行中
    setUploadStatus(prev => ({ ...prev, [context]: 'idle' }))

    // 多选文件上传逻辑（仅用于图层文件）
    if (files.length > 1) {
      console.log('[Upload] Multiple files detected, processing sequentially')
      let allSuccess = true

      for (const file of files) {
        let filePath = (file as any).path

        if (!filePath && (window as any).electronAPI?.getFilePath) {
          try {
            filePath = await (window as any).electronAPI.getFilePath(file)
          } catch (e) {
            console.error('[Upload] Error getting path:', e)
          }
        }

        console.log('[Upload] Path Captured:', filePath || 'NULL (Browser Restriction)')

        // 修复：uploadExcel/uploadMap 的第二个参数是 context，不是 filePath
        const success = context === 'geo_data'
          ? await uploadFn(file, filePath || undefined)
          : await uploadFn(file, context)
        if (!success) {
          allSuccess = false
        }
      }

      if (allSuccess) {
        event.target.value = ''
        setUploadStatus(prev => ({ ...prev, [context]: 'success' }))
        setTimeout(() => setUploadStatus(prev => ({ ...prev, [context]: 'idle' })), 3000)

        // 清除地图数据缓存，确保 pciDataSyncService 能获取到最新数据
        await mapDataService.clearCache()

        // 触发数据刷新事件，通知其他页面（PCI、邻区、TAC）重新加载数据
        triggerDataRefresh()
        console.log('[DataPage] 已触发数据刷新事件')
        addLog('upload', `上传成功: ${fileNames}`, 'success', undefined, `upload:${fileNames}`)
      } else {
        setUploadStatus(prev => ({ ...prev, [context]: 'error' }))
        addLog('upload', `上传失败: ${fileNames}`, 'error', undefined, `upload:${fileNames}`)
        setTimeout(() => setUploadStatus(prev => ({ ...prev, [context]: 'idle' })), 3000)
      }
    } else {
      // 单文件上传
      const file = files[0]

      let filePath = (file as any).path

      if (!filePath && (window as any).electronAPI?.getFilePath) {
        try {
          filePath = await (window as any).electronAPI.getFilePath(file)
        } catch (e) {
          console.error('[Upload] Error getting path:', e)
        }
      }

      console.log('[Upload] Path Captured:', filePath || 'NULL (Browser Restriction)')

      // 修复：uploadExcel/uploadMap 的第二个参数是 context，不是 filePath
      const success = context === 'geo_data'
        ? await uploadFn(file, filePath || undefined)
        : await uploadFn(file, context)
      if (success) {
        event.target.value = ''
        setUploadStatus(prev => ({ ...prev, [context]: 'success' }))
        setTimeout(() => setUploadStatus(prev => ({ ...prev, [context]: 'idle' })), 3000)

        // 清除地图数据缓存，确保 pciDataSyncService 能获取到最新数据
        await mapDataService.clearCache()

        // 上传成功提示横幅（紫色）
        let successMessage = ''
        switch (context) {
          case 'geo_data':
            successMessage = `${t('data.geoDataSuccess') || '地理化数据上传成功'}！${t('data.geoDataImported', { name: file.name, count: items.filter(i => i.fileType === 'geo_data').length + 1 }) || `「${file.name}」已导入 ${items.filter(i => i.fileType === 'geo_data').length + 1} 个数据文件`}`
            break
          case 'full_params':
            successMessage = `${t('data.fullParamsSuccess') || '全量工参上传成功'}！${t('data.fullParamsImported', { name: file.name }) || `「${file.name}」已导入`}`
            break
          case 'current_params':
            successMessage = `${t('data.currentParamsSuccess') || '现网工参上传成功'}！${t('data.currentParamsImported', { name: file.name }) || `「${file.name}」已导入`}`
            break
          case 'map_layer':
            successMessage = `${t('data.mapLayerSuccess') || '图层文件上传成功'}！${t('data.mapLayerImported', { name: file.name }) || `「${file.name}」已导入`}`
            break
        }
        if (successMessage) {
          setUploadSuccess(successMessage)
          setTimeout(() => setUploadSuccess(null), 3000)
        }

        // 触发数据刷新事件，通知其他页面（PCI、邻区、TAC）重新加载数据
        triggerDataRefresh()
        console.log('[DataPage] 已触发数据刷新事件')
        addLog('upload', `上传成功: ${file.name}`, 'success', undefined, `upload:${file.name}`)
      } else {
        setUploadStatus(prev => ({ ...prev, [context]: 'error' }))
        addLog('upload', `上传失败: ${file.name}`, 'error', undefined, `upload:${file.name}`)
        setTimeout(() => setUploadStatus(prev => ({ ...prev, [context]: 'idle' })), 3000)
      }
    }
  }

  const handleDownload = async (item: DataItem) => {
    const store = useDownloadStore.getState()
    if (store.isDownloading(item.id)) return
    store.startDownload(item.id, item.name || item.id)

    try {
        console.log('[Download] Requesting:', item.id)
        const url = `/api/v1/data/${item.id}/download`
        const filename = item.name || 'download'

        // 使用 fetch + stream reader 追踪下载进度
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        const contentLength = response.headers.get('content-length')
        const total = contentLength ? parseInt(contentLength, 10) : 0
        let loaded = 0

        const reader = response.body!.getReader()
        const chunks: Uint8Array[] = []

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          loaded += value.length
          if (total > 0) {
            const pct = Math.round((loaded / total) * 100)
            store.updateProgress(item.id, pct,
              `下载中 ${pct}% (${(loaded/1024/1024).toFixed(1)}MB / ${(total/1024/1024).toFixed(1)}MB)`)
          } else {
            store.updateProgress(item.id, -1, `下载中 ${(loaded/1024/1024).toFixed(1)}MB...`)
          }
        }

        const blob = new Blob(chunks)
        if (blob.size === 0) throw new Error(t('data.emptyFile') || '文件内容为空')

        store.updateProgress(item.id, 100, '正在保存...')

        // 弹出保存对话框 (File System Access API, Electron/Chromium 支持)
        if ('showSaveFilePicker' in window) {
          try {
            const opts: any = {
              suggestedName: filename,
              types: filename.endsWith('.zip')
                ? [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }]
                : [{ description: 'Excel File', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
            }
            const handle = await (window as any).showSaveFilePicker(opts)
            // 用户确认保存对话框后才记录日志（取消不记录）
            addLog('download', `开始下载: ${item.name}`, 'running', undefined, `download:${item.id}`)
            const writable = await handle.createWritable()
            await writable.write(blob)
            await writable.close()
            console.log('[Download] Saved via File Picker:', filename)
            addLog('download', `下载成功: ${item.name}`, 'success', undefined, `download:${item.id}`)
            store.finishDownload(item.id)
            return
          } catch (pickerErr: any) {
            if (pickerErr.name === 'AbortError') {
              console.log('[Download] User cancelled save dialog')
              store.finishDownload(item.id)
              return
            }
            console.warn('[Download] showSaveFilePicker failed, falling back:', pickerErr)
          }
        }

        // 后备：a.click() 触发浏览器下载（无取消对话框，直接记录）
        addLog('download', `开始下载: ${item.name}`, 'running', undefined, `download:${item.id}`)
        const blobUrl = window.URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = blobUrl
        link.setAttribute('download', filename)
        document.body.appendChild(link)
        link.click()
        setTimeout(() => {
          document.body.removeChild(link)
          window.URL.revokeObjectURL(blobUrl)
        }, 100)
        console.log('[Download] Success (fallback)')
        addLog('download', `下载成功: ${item.name}`, 'success', undefined, `download:${item.id}`)
        store.finishDownload(item.id)
    } catch (err: any) {
        console.error('[Download] Failed:', err)
        addLog('download', `下载失败: ${item.name}`, 'error', err.message, `download:${item.id}`)
        store.failDownload(item.id, err.message)
        alert(`${t('data.downloadFailed') || '下载失败'}: ${err.message || (t('data.unknownError') || '未知错误')}`)
    }
  }

  const handleDelete = async (item: DataItem) => {
    const itemName = item.name || (t('data.unknownFile') || '未知文件')

    // 确认删除
    const confirmed = confirm(`${t('data.deleteConfirm', { name: itemName }) || `确定要删除 "${itemName}" 吗？`}\n\n${t('data.deleteWarning') || '删除后将无法恢复，且会影响使用该数据的规划结果。'}`)
    if (!confirmed) return

    try {
      // 先尝试普通删除
      let result = await deleteItem(item.id)

      // 如果删除失败，询问是否强制删除
      if (!result) {
        const forceDelete = confirm(
          `${t('data.forceDeleteTip') || '删除失败：文件可能正在被其他程序使用。'}\n\n` +
          `${t('data.forceDeleteConfirm') || '是否要强制删除？'}\n` +
          `• ${t('data.forceDeleteRemoveIndex') || '强制删除会从索引中移除该数据'}\n` +
          `• ${t('data.forceDeleteManualCleanup') || '部分文件可能需要手动清理'}\n` +
          `• ${t('data.forceDeleteClosePrograms') || '建议先关闭相关程序后再试'}`
        )

        if (forceDelete) {
          // 使用 dataApi 的强制删除
          result = await dataApi.delete(item.id, true)
          if (result?.success) {
            alert(t('data.indexRemoved') || '已从索引中移除。如果后续遇到问题，请刷新页面或重新导入数据。')
            addLog('delete', `强制删除成功: ${itemName}`, 'success', undefined, `delete:${item.id}`)
            await fetchList(1, 50, true)
            await mapDataService.clearCache()
            triggerDataRefresh()
          } else {
            addLog('delete', `强制删除失败: ${itemName}`, 'error', undefined, `delete:${item.id}`)
            alert(`${t('data.forceDeleteFailed') || '强制删除失败。请尝试：'}\n1. ${t('data.forceDeleteCloseExcel') || '关闭所有 Excel 文件'}\n2. ${t('data.forceDeleteRestartApp') || '重启应用后再试'}\n3. ${t('data.forceDeleteManually') || '手动删除 data 目录下的对应文件夹'}`)
          }
        } else {
          alert(t('data.deleteCancelled') || '删除已取消。')
        }
      } else {
        addLog('delete', `删除成功: ${itemName}`, 'success', undefined, `delete:${item.id}`)
        await fetchList(1, 50, true)
        await mapDataService.clearCache()
        triggerDataRefresh()
      }
    } catch (err: any) {
      addLog('delete', `删除失败: ${itemName}`, 'error', err.message, `delete:${item.id}`)
      console.error('[Delete] Failed:', err)
      alert(`${t('data.deleteFailed') || '删除失败'}: ${err.message || (t('data.unknownError') || '未知错误')}\n\n${t('data.deleteFailedReason') || '可能原因：'}\n• ${t('data.deleteFailedInUse') || '文件正在被其他程序使用'}\n• ${t('data.deleteFailedPermission') || '磁盘权限不足'}\n• ${t('data.deleteFailedIndex') || '索引文件损坏'}`)
    }
  }

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return

    const confirmed = confirm(
      `${t('data.batchDeleteConfirm', { count: selectedIds.size }) || `确定要删除选中的 ${selectedIds.size} 个文件吗？`}\n\n${t('data.deleteWarning') || '删除后将无法恢复，且会影响使用该数据的规划结果。'}`
    )
    if (!confirmed) return

    setBatchDeleting(true)
    let successCount = 0
    let failCount = 0

    for (const id of selectedIds) {
      try {
        const result = await deleteItem(id)
        if (result) {
          successCount++
        } else {
          failCount++
        }
      } catch {
        failCount++
      }
    }

    setBatchDeleting(false)
    setSelectedIds(new Set())
    addLog('delete', `批量删除完成: 成功 ${successCount} 个, 失败 ${failCount} 个`, failCount > 0 ? 'error' : 'success')
    // 批量删除完成后统一刷新一次（deleteItem 已不内部刷新，避免 IndexedDB 缓存竞争）
    await indexedDBService.delete('data_list_cache')
    await fetchList(1, 50, true)
    await mapDataService.clearCache()
    triggerDataRefresh()

    if (failCount > 0) {
      alert(`${t('data.batchDeleteResult', { success: successCount, fail: failCount }) || `删除完成：成功 ${successCount} 个，失败 ${failCount} 个`}`)
    }
  }

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(items.map(item => item.id)))
    }
  }, [selectedIds.size, items])

  const toggleSelectItem = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const allSelected = items.length > 0 && selectedIds.size === items.length
  const hasSyncingItems = items.some(item => item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined))

  const handleUpdateParameters = async () => {
     if (!selectedFullParamId || !selectedCurrentParamId) return

     setUpdateSuccess(null)
     addLog('update', '开始工参更新...', 'running', undefined, 'update:params')

     // 记录上一次接收到的日志行数，避免重复
     let lastLogCount = 0

     try {
         const result = await updateParameters(selectedFullParamId, selectedCurrentParamId)
         console.log('Update parameters result:', result);

         // 获取 taskId 用于轮询后端终端日志
         const taskId = result?.data?.taskId;
         if (taskId) {
             const pollInterval = setInterval(async () => {
                 try {
                     const resp = await fetch(`/api/v1/data/update-parameters/progress/${taskId}`)
                     const json = await resp.json()
                     if (json?.success && json?.data?.logMessages) {
                         const msgs = json.data.logMessages as string[]
                         // 只添加新增的行
                         for (let i = lastLogCount; i < msgs.length; i++) {
                             addLog('terminal', msgs[i], undefined, undefined, `terminal:update:${i}`)
                         }
                         lastLogCount = msgs.length
                     }
                     // 任务完成或失败时停止轮询
                     if (json?.data?.status === 'completed' || json?.data?.status === 'failed') {
                         clearInterval(pollInterval)
                     }
                 } catch { /* 轮询失败不阻塞主流程 */ }
             }, 1000)
             // 30 秒后自动停止轮询，防止泄漏
             setTimeout(() => clearInterval(pollInterval), 30000)
         }

         // 根据后端返回的 newFileId 检查新文件是否出现在列表中
         const newFileId = result?.data?.newFileId;
         const newFileName = result?.data?.newFileName;
         const savedToOriginal = result?.data?.savedToOriginal;

         // 轮询刷新列表，最多重试 5 次，确保新文件出现
         let newFileFound = false;
         for (let i = 0; i < 5; i++) {
             await fetchList(1, 50, true);
             const updatedItems = useDataStore.getState().items;
             if (newFileId && updatedItems.some(item => item.id === newFileId)) {
                 newFileFound = true;
                 break;
             }
             // 每次等待时间递增
             await new Promise(r => setTimeout(r, 500 * (i + 1)));
         }

         if (result?.success || newFileFound) {
             if (savedToOriginal && newFileName) {
                 // 从列表中查找具有 originalPath 的文件以构造完整路径
                 const items = useDataStore.getState().items;
                 const matchedFile = newFileId ? items.find(i => i.id === newFileId) : null;
                 if (matchedFile?.originalPath) {
                     const originalDir = matchedFile.originalPath.substring(0, matchedFile.originalPath.lastIndexOf('\\') + 1);
                     const fullPath = `${originalDir}${newFileName}`;
                     setUpdateSuccess(`${t('data.updateSuccess') || '更新成功'}！${t('data.savedTo') || '已保存至：'}\n${fullPath}`)
                 } else if (matchedFile?.originalPath) {
                     setUpdateSuccess(`${t('data.updateSuccess') || '更新成功'}！${t('data.savedToSystemNoPath') || '文件已保存在系统内 (由于未记录原路径，无法写回原文件夹)，请手动下载。'}`)
                 } else {
                     setUpdateSuccess(`${t('data.updateSuccess') || '更新成功'}！${t('data.savedToSystem') || '文件已保存在系统内，请手动下载。'}`)
                 }
             } else {
                 setUpdateSuccess(`${t('data.updateSuccess') || '更新成功'}！${t('data.savedToSystem') || '文件已保存在系统内，请手动下载。'}`)
             }

             setSelectedFullParamId('')
             setSelectedCurrentParamId('')
             addLog('update', '工参更新完成', 'success', newFileName || '', 'update:params')
         } else {
             // 更新失败（后端返回错误状态且列表中也未找到新文件）
             throw new Error(result?.message || t('data.updateFailed') || '工参更新失败')
         }
     } catch (err: any) {
         addLog('update', '工参更新失败', 'error', err.message, 'update:params')
         console.error('Update failed:', err);
         // 从多种可能的错误结构中提取消息
         const errorMsg = err?.message || err?.data?.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
         console.error(`[工参更新] 错误详情: ${errorMsg}`, {
           fullParamId: selectedFullParamId,
           currentParamId: selectedCurrentParamId,
           error: err
         });

         // 发生错误时也尝试刷新列表，看更新是否实际成功
         try {
             console.log('[工参更新] 尝试刷新列表检查实际状态...')
             await fetchList(1, 50, true)
             const newItems = useDataStore.getState().items
             const hasNewFullParam = newItems.some(i => i.fileType === 'full_params' && i.id !== selectedFullParamId)
             if (hasNewFullParam) {
                 setUpdateSuccess(`${t('data.updateSuccess') || '更新成功'}！${t('data.savedToSystem') || '文件已保存在系统内。'}`)
                 setSelectedFullParamId('')
                 setSelectedCurrentParamId('')
                 return
             }
         } catch {
             // 刷新失败不影响错误提示
         }

         setUpdateSuccess(null);
         alert(`${t('data.updateFailed') || '工参更新失败'}: ${errorMsg}\n\n${t('data.updateFailedHint') || '提示：'} ${t('data.tryRefreshHint') || '请尝试刷新数据列表后重试。如果问题持续，请重启后端服务。'}`);
     }
   }

  // 筛选文件列表
  const fullParamFiles = items.filter(i => i.fileType === 'full_params')
  const currentParamFiles = items.filter(i => i.type === 'map')

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-base font-bold">{t('data.title')}</h1>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3 text-red-700">
          <AlertCircle size={20} />
          <span>{error}</span>
          <button onClick={() => fetchList(1, 50, true)} className="ml-auto text-sm underline">{t('data.retry') || '重试'}</button>
        </div>
      )}
      
      {/* 成功提示 */}
      {updateSuccess && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg flex items-center gap-3 text-green-700 whitespace-pre-wrap">
          <CheckCircle2 size={20} className="shrink-0" />
          <span className="flex-grow">{updateSuccess}</span>
          <button
            onClick={() => setUpdateSuccess(null)}
            className="text-green-700 hover:text-green-900 transition-colors duration-200 p-1 hover:bg-green-100 rounded-full"
            aria-label={t('data.close') || '关闭'}
          >
            ✕
          </button>
        </div>
      )}

      {/* 上传成功提示 */}
      {uploadSuccess && (
        <div className="mb-6 p-4 bg-purple-50 border border-purple-200 rounded-lg flex items-center gap-3 text-purple-700">
          <CheckCircle2 size={20} className="shrink-0" />
          <span className="flex-grow">{uploadSuccess}</span>
          <button
            onClick={() => setUploadSuccess(null)}
            className="text-purple-700 hover:text-purple-900 transition-colors duration-200 p-1 hover:bg-purple-100 rounded-full"
            aria-label={t('data.close') || '关闭'}
          >
            ✕
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="space-y-8">
            {/* 文件上传 */}
            <div className="bg-card p-3 rounded-lg border border-border">
            <h2 className="text-base font-semibold mb-2">{t('data.importData') || '导入数据'}</h2>
            {!permImport && (
              <p className="text-xs text-muted-foreground mb-2 bg-muted/40 px-2 py-1 rounded">
                {t('data.noPermission', '无权限，请联系管理员')}
              </p>
            )}

             <div className={`space-y-2 ${permImport ? '' : 'opacity-50 pointer-events-none'}`}>
                <div className="flex items-center gap-2">
                    <div className="flex-1">
                        <UploadArea
                            title={t('data.fullParams') || '全量工参'}
                            accept=".xlsx,.xls"
                            onUpload={(e) => handleFileUpload(e, 'excel', 'full_params')}
                            loading={loading && uploadingType === 'full_params'}
                            icon={<FileSpreadsheet size={20} />}
                            inline={true}
                            status={uploadStatus.full_params}
                        />
                    </div>
                    <div className="w-24">
                        <button
                            onClick={() => handleDownloadTemplate('full_params')}
                            className="w-full px-2 py-1.5 bg-blue-500 text-white rounded text-xs hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                            title={t('data.downloadTemplate') || '下载全量工参模板'}
                        >
                            <FileDown size={12} />
                            <span>{t('data.template') || '模板'}</span>
                        </button>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex-1">
                        <UploadArea
                            title={t('data.currentParams') || '现网工参'}
                            accept=".zip"
                            onUpload={(e) => handleFileUpload(e, 'map', 'current_params')}
                            loading={loading && uploadingType === 'current_params'}
                            icon={<Upload size={20} />}
                            inline={true}
                            description={t('data.currentParamsDesc') || '中兴网管300脚本导出数据'}
                            status={uploadStatus.current_params}
                        />
                    </div>
                    <div className="w-24">
                        {/* 现网工参不需要模板下载 */}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex-1">
                        <UploadArea
                            title={t('data.mapLayer') || '图层文件'}
                            accept=".zip,.tab,.mif"
                            onUpload={(e) => handleFileUpload(e, 'map', 'map_layer')}
                            loading={loading && uploadingType === 'map_layer'}
                            icon={<Layers size={20} />}
                            multiple={true}
                            inline={true}
                            status={uploadStatus.map_layer}
                            description={t('data.mapLayerDesc') || '支持ZIP/TAB/MIF，TAB需配套DAT文件'}
                        />
                    </div>
                    <div className="w-24">
                        {/* 图层文件不需要模板下载 */}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex-1">
                        <UploadArea
                            title={t('data.geoData') || '地理化数据'}
                            accept=".xlsx,.xls,.csv,.txt"
                            onUpload={(e) => handleFileUpload(e, 'excel', 'geo_data')}
                            loading={loading && uploadingType === 'geo_data'}
                            icon={<MapPin size={20} className="text-purple-600" />}
                            description={t('data.geoDataDesc') || '自动识别点状/扇区'}
                            inline={true}
                            status={uploadStatus.geo_data}
                            multiple={true}
                        />
                    </div>
                    <div className="w-24">
                        <button
                            onClick={() => handleDownloadTemplate('geo_data')}
                            className="w-full px-2 py-1.5 bg-blue-500 text-white rounded text-xs hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                            title={t('data.downloadTemplate') || '下载模板'}
                        >
                            <FileDown size={12} />
                            <span>{t('data.template') || '模板'}</span>
                        </button>
                    </div>
                </div>
            </div>
            </div>

            {/* 工参更新 */}
            <div className={`bg-card p-3 rounded-lg border border-border -mt-6 ${permUpdate ? '' : 'opacity-50 pointer-events-none'}`}>
                <h2 className="text-base font-semibold mb-2">{t('data.updateParameters') || '工参更新'}</h2>
                {!permUpdate && (
                  <p className="text-xs text-muted-foreground mb-2 bg-muted/40 px-2 py-1 rounded">
                    {t('data.noPermission', '无权限，请联系管理员')}
                  </p>
                )}
                <div className="flex items-end gap-2">
                  <div className="flex-1 min-w-0">
                    <select
                        className="w-full p-2 border rounded-md bg-background text-sm mb-2"
                        value={selectedFullParamId}
                        onChange={(e) => setSelectedFullParamId(e.target.value)}
                        title={t('data.selectFullParams') || '选择全量工参'}
                    >
                        <option value="" disabled>{t('data.selectFullParams') || '选择全量工参'}</option>
                        {fullParamFiles.map(f => (
                            <option key={f.id} value={f.id}>
                                {f.name} {f.originalPath ? '✓' : `(${t('data.noPath') || '无路径'})`}
                            </option>
                        ))}
                    </select>
                    <select
                        className="w-full p-2 border rounded-md bg-background text-sm"
                        value={selectedCurrentParamId}
                        onChange={(e) => setSelectedCurrentParamId(e.target.value)}
                        title={t('data.selectCurrentParams') || '选择现网工参 (ZIP)'}
                    >
                        <option value="" disabled>{t('data.selectCurrentParams') || '选择现网工参 (ZIP)'}</option>
                        {currentParamFiles.map(f => (
                            <option key={f.id} value={f.id}>{f.name}</option>
                        ))}
                    </select>
                  </div>
                  <button
                      onClick={handleUpdateParameters}
                      disabled={isUpdating || !selectedFullParamId || !selectedCurrentParamId}
                      className="shrink-0 h-[calc(2.25rem*2+0.5rem)] px-3 bg-blue-400 text-white rounded-md hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center justify-center gap-0.5 text-xs font-medium transition-colors"
                  >
                      {isUpdating ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                      {isUpdating ? (t('data.updating') || '更新中') : (t('data.startUpdate') || '开始更新')}
                  </button>
                </div>
            </div>

            {/* 新站录入 */}
            <NewCellEntryCard
                fullParamFiles={fullParamFiles}
                addLog={addLog}
                disabled={!permCellEntry}
            />
        </div>

        {/* 数据列表 */}
        <div className="bg-card p-6 rounded-lg border border-border h-full">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold">{t('data.importedData') || '已导入数据'}</h2>
            <div className="flex items-center gap-2">
              {items.length > 0 && (
                <>
                  <button
                    onClick={toggleSelectAll}
                    className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                      allSelected
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-border hover:bg-muted'
                    }`}
                  >
                    {allSelected ? (t('data.deselectAll') || '取消全选') : (t('data.selectAll') || '全选')}
                  </button>
                  <button
                    onClick={() => { if (!permDelete) return; handleBatchDelete() }}
                    disabled={!permDelete || selectedIds.size === 0 || batchDeleting || hasSyncingItems}
                    className="text-xs px-2.5 py-1 rounded border bg-background border-border text-red-500 hover:bg-red-50 hover:border-red-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-background disabled:hover:border-border transition-colors flex items-center gap-1"
                    title={!permDelete ? (t('data.noPermission', '无权限，请联系管理员')) : (hasSyncingItems ? (t('data.syncingDisabled') || '同步中不可操作') : '')}
                  >
                    {batchDeleting ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                    {t('data.batchDelete') || '删除'}
                    {selectedIds.size > 0 && ` (${selectedIds.size})`}
                  </button>
                </>
              )}
              <button
                onClick={() => { fetchList(1, 50, true); setSelectedIds(new Set()) }}
                disabled={loading}
                className="text-sm text-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
              >
                {loading && <Loader2 size={12} className="animate-spin" />}
                {loading ? (t('data.refreshing') || '刷新中...') : (t('data.refresh') || '刷新')}
              </button>
            </div>
          </div>

          {/* 全量工参同步中提醒横幅 */}
          {hasSyncingItems && (
            <div className="mb-3 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-lg flex items-center gap-2.5">
              <Loader2 size={16} className="animate-spin text-amber-500" />
              <span className="text-sm text-amber-700 font-medium">
                {t('data.excelSyncing') || 'Excel同步中...'}
              </span>
              <span className="text-xs text-amber-500 ml-auto">
                {t('data.syncingWait') || '后台正在写入数据，操作暂时锁定'}
              </span>
            </div>
          )}

          {items.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              {t('data.noData') || '暂无数据，请先导入'}
            </p>
          ) : (
            <div className="space-y-2 max-h-[600px] overflow-y-auto">
              {items.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${
                    selectedIds.has(item.id)
                      ? 'bg-primary/5 border-primary/30 ring-1 ring-primary/20'
                      : selectedId === item.id
                      ? 'bg-primary/10 border-primary'
                      : 'bg-muted border-border hover:bg-muted/80'
                  }`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {/* 文件类型图标 */}
                      <div className={`p-1.5 rounded-md ${
                        item.fileType === 'geo_data' ? 'bg-purple-100' :
                        item.fileType === 'full_params' ? 'bg-blue-100' :
                        item.fileType === 'target_cells' ? 'bg-orange-100' :
                        item.type === 'excel' ? 'bg-green-100' :
                        item.type === 'map' ? 'bg-cyan-100' :
                        'bg-gray-100'
                      }`}>
                        {item.fileType === 'geo_data' ? (
                          item.geometryType === 'sector'
                            ? <Navigation size={16} className="text-purple-600" />
                            : <MapPin size={16} className="text-purple-600" />
                        ) : item.fileType === 'full_params' ? (
                          <FileSpreadsheet size={16} className="text-blue-600" />
                        ) : item.fileType === 'target_cells' ? (
                          <FileSpreadsheet size={16} className="text-orange-600" />
                        ) : item.type === 'excel' ? (
                          <FileSpreadsheet size={16} className="text-green-600" />
                        ) : item.subType === 'mapinfo' ? (
                          <Layers size={16} className="text-cyan-600" />
                        ) : (
                          <Upload size={16} className="text-gray-600" />
                        )}
                      </div>
                      <span className="truncate font-medium" title={item.name}>{item.name}</span>
                      {/* 文件类型标签 */}
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-0.5 ${
                        item.status === 'error'
                          ? 'bg-red-100 text-red-700'
                          : item.fileType === 'geo_data'
                          ? 'bg-purple-100 text-purple-700'
                          : item.fileType === 'full_params'
                          ? 'bg-blue-100 text-blue-700'
                          : item.fileType === 'target_cells'
                          ? 'bg-orange-100 text-orange-700'
                          : item.fileType === 'current_params'
                          ? 'bg-indigo-100 text-indigo-700'
                          : item.subType === 'mapinfo'
                          ? 'bg-cyan-100 text-cyan-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}>
                        {item.status === 'error'
                          ? <>
                              <AlertCircle size={10} />
                              {(t('data.failed') || '处理失败')}
                            </>
                          : item.fileType === 'geo_data'
                          ? (item.geometryType === 'sector' ? (t('data.sectorData') || '扇区数据') : (t('data.geo') || '地理化'))
                          : item.fileType === 'full_params'
                          ? (t('data.fullParamsLabel') || '全量工参')
                          : item.fileType === 'target_cells'
                          ? (t('data.toPlan') || '待规划')
                          : item.fileType === 'current_params'
                          ? (t('data.currentParamsLabel') || '现网工参')
                          : item.subType === 'mapinfo'
                          ? 'MapInfo'
                          : item.type === 'excel'
                          ? 'Excel'
                          : 'ZIP'}
                      </span>
                      {/* 路径记录状态 */}
                      {item.originalPath && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 flex items-center gap-0.5">
                          <CheckCircle2 size={10} />
                          {t('data.recorded') || '已记录'}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1.5 flex items-center gap-3">
                      <span>
                        {item.fileType === 'geo_data' ? (
                          <>
                            {item.geometryType === 'sector'
                              ? `${item.metadata?.pointCount || 0} ${t('data.sectors') || '个扇区'}`
                              : `${item.metadata?.pointCount || 0} ${t('data.points') || '个点'}`}
                          </>
                        ) : item.type === 'excel' ? (
                            item.metadata?.LTESiteCount || item.metadata?.NRSiteCount
                                ? [
                                    item.metadata?.LTESiteCount ? `LTE ${item.metadata.LTESiteCount}站/${item.metadata.LTESectorCount}小区` : null,
                                    item.metadata?.NRSiteCount ? `NR ${item.metadata.NRSiteCount}站/${item.metadata.NRSectorCount}小区` : null
                                  ].filter(Boolean).join(' · ')
                                : (item.fileType === 'full_params'
                                    ? (t('data.fullParamsData') || '全量工参数据')
                                    : (item.fileType === 'target_cells'
                                        ? (t('data.targetCellsData') || '待规划小区数据')
                                        : (item.fileType === 'default' && item.metadata?.siteCount
                                            ? `${item.metadata.siteCount} ${t('data.baseStations') || '个基站'}`
                                            : (t('data.excelData') || 'Excel 数据'))))
                        ) : (
                            item.type === 'map'
                                ? (item.subType === 'mapinfo'
                                    ? `${item.metadata?.layerCount || 0} ${t('data.layers') || '个图层'}`
                                    : (t('data.zipFile') || '压缩文件'))
                                : (t('data.unknownType') || '未知类型')
                        )}
                      </span>
                      <span className="text-[10px] opacity-60">
                        {/* 时间格式: YYYY/M/D HH:mm username */}
                        {(() => {
                          const d = new Date(item.uploadDate)
                          const pad = (n: number) => String(n).padStart(2, '0')
                          const timeStr = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
                          const userName = (item as any).userName || (item as any).user_name || ''
                          return `${timeStr}${userName ? ' ' + userName : ''}`
                        })()}
                      </span>
                      {(item as any).remark && (
                        <span className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
                          {(item as any).remark}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 items-center">
                    <button
                      onClick={(e) => {
                        if (loading || item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined)) return
                        toggleSelectItem(item.id, e)
                      }}
                      className={`p-1.5 rounded transition-colors ${loading || item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined) ? 'text-muted-foreground/30 cursor-not-allowed' : 'hover:bg-background text-muted-foreground hover:text-primary'}`}
                      disabled={loading || item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined)}
                      title={loading ? (t('data.loading') || '加载中...') : (item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined) ? (t('data.syncingDisabled') || '同步中不可操作') : (selectedIds.has(item.id) ? (t('data.deselectItem') || '取消选择') : (t('data.selectItem') || '选择')))}
                    >
                      {selectedIds.has(item.id) ? (
                        <CheckSquare size={16} className="text-primary" />
                      ) : (
                        <Square size={16} />
                      )}
                    </button>
                    {loading ? (
                      <div className="p-2 text-muted-foreground/50" title={t('data.loading') || '加载中...'}>
                        <Loader2 size={14} className="animate-spin text-muted-foreground" />
                      </div>
                    ) : item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined) ? (
                      <div className="p-2 text-muted-foreground flex items-center gap-1.5" title={t('data.excelSyncing') || 'Excel同步中...'}>
                        <Loader2 size={14} className="animate-spin text-amber-500" />
                        <span className="text-[10px] text-amber-600">{t('data.syncing') || '同步中'}</span>
                      </div>
                    ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDownload(item)
                      }}
                      disabled={downloadStore.downloadingIds.has(item.id)}
                      className="p-2 hover:bg-background rounded text-primary disabled:opacity-50 disabled:cursor-wait relative group"
                      title={downloadStore.downloadingIds.has(item.id)
                        ? (downloadStore.statusText[item.id] || (t('data.downloading') || '下载中...'))
                        : (t('data.download') || '下载')}
                    >
                      {downloadStore.downloadingIds.has(item.id) ? (
                        <div className="flex flex-col items-center gap-0.5">
                          <Loader2 size={16} className="animate-spin text-blue-500" />
                          {downloadStore.progress[item.id] > 0 && (
                            <span className="text-[9px] font-mono text-blue-600 leading-none">
                              {downloadStore.progress[item.id]}%
                            </span>
                          )}
                        </div>
                      ) : <Download size={16} />}
                    </button>
                    )}
                    <button
                      onClick={(e) => {
                        if (!permDelete || loading || item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined)) return
                        e.stopPropagation()
                        handleDelete(item)
                      }}
                      className={`p-2 rounded ${!permDelete || loading || item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined) ? 'text-red-500/30 cursor-not-allowed' : 'hover:bg-background text-red-500'}`}
                      disabled={!permDelete || loading || item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined)}
                      title={!permDelete ? (t('data.noPermission', '无权限，请联系管理员')) : (loading ? (t('data.loading') || '加载中...') : (item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined) ? (t('data.syncingDisabled') || '同步中不可删除') : (t('data.delete') || '删除')))}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 运行结果 */}
      <div className="mt-8 bg-card rounded-lg border border-border overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <ScrollText size={16} className="text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t('data.operationLog') || '运行结果'}</h2>
            {logs.length > 0 && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
                {logs.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {logs.length > 0 && (
              <button
                onClick={() => {
              _store.entries = []
              setLogs([])
            }}
                className="text-[11px] px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                {t('data.clearLog') || '清除'}
              </button>
            )}
          </div>
        </div>
        <div className="max-h-[280px] overflow-y-auto p-0">
          {logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <ScrollText size={28} className="opacity-30 mb-3" />
              <p className="text-xs">{t('data.noLogs') || '暂无运行记录'}</p>
              <p className="text-[10px] opacity-60 mt-1">{t('data.noLogsHint') || '执行上传、下载、删除等操作后，记录将出现在这里'}</p>
            </div>
          ) : (
            <div className="divide-y divide-border/40">
              {logs.map((entry) => (
                <div
                  key={entry.id}
                  className="px-5 py-2.5 hover:bg-muted/20 transition-colors animate-in fade-in slide-in-from-bottom-1 duration-200"
                >
                  <div className="flex items-start gap-3">
                    <span className="text-[10px] font-mono text-muted-foreground/60 mt-0.5 shrink-0 w-14 text-right">
                      {entry.time}
                    </span>
                    <span className={`shrink-0 mt-0.5 ${
                      entry.type === 'upload' ? 'text-blue-500' :
                      entry.type === 'download' ? 'text-green-500' :
                      entry.type === 'delete' ? 'text-red-500' :
                      entry.type === 'update' ? 'text-amber-500' :
                      entry.type === 'terminal' ? 'text-zinc-400' :
                      entry.type === 'error' ? 'text-red-500' :
                      'text-muted-foreground'
                    }`}>
                      {entry.type === 'terminal' ? (
                        <span className="text-[9px] font-mono font-bold opacity-70">&gt;</span>
                      ) : entry.status === 'running' ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : entry.status === 'success' ? (
                        <CheckCircle2 size={12} />
                      ) : entry.status === 'error' ? (
                        <AlertCircle size={12} />
                      ) : (
                        <div className="w-3 h-3 rounded-full bg-current opacity-40" />
                      )}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium font-mono ${
                          entry.type === 'terminal' ? 'text-emerald-600' :
                          entry.status === 'running' ? 'text-foreground' :
                          entry.status === 'success' ? 'text-green-700' :
                          entry.status === 'error' ? 'text-red-600' :
                          'text-foreground'
                        }`}>
                          {entry.message}
                        </span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                          entry.type === 'upload' ? 'bg-blue-100 text-blue-700' :
                          entry.type === 'download' ? 'bg-green-100 text-green-700' :
                          entry.type === 'delete' ? 'bg-red-100 text-red-700' :
                          entry.type === 'update' ? 'bg-amber-100 text-amber-700' :
                          entry.type === 'terminal' ? 'bg-zinc-100 text-zinc-600' :
                          entry.type === 'error' ? 'bg-red-100 text-red-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>
                          {entry.type === 'upload' ? '上传' :
                           entry.type === 'download' ? '下载' :
                           entry.type === 'delete' ? '删除' :
                           entry.type === 'update' ? '更新' :
                           entry.type === 'terminal' ? '终端' :
                           entry.type === 'error' ? '错误' : '信息'}
                        </span>
                      </div>
                      {entry.detail && (
                        <p className="text-[10px] text-muted-foreground/70 mt-0.5 truncate">
                          {entry.detail}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function UploadArea({
  title,
  accept,
  onUpload,
  icon,
  loading = false,
  multiple = false,
  description,
  inline = false,
  status = 'idle'
}: {
  title: string
  accept: string
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
  icon: React.ReactNode
  loading?: boolean
  multiple?: boolean
  description?: string
  inline?: boolean
  status?: 'idle' | 'success' | 'error'
}) {
  const { t } = useTranslation()
  // 根据状态获取边框颜色
  const getBorderClass = () => {
    if (loading) return 'border-muted bg-muted/50 cursor-not-allowed'
    if (status === 'success') return 'border-green-500 bg-green-50 hover:bg-green-100'
    if (status === 'error') return 'border-red-500 bg-red-50 hover:bg-red-100'
    return 'border-border hover:border-primary hover:bg-primary/5'
  }

  if (inline) {
    // 行内布局：标签和上传框在同一行
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium whitespace-nowrap w-20 text-right">{title}：</span>
        <label className={`flex-1 flex items-center justify-center h-8 border-2 border-dashed rounded cursor-pointer transition-all duration-200 ${getBorderClass()}`}>
          <div className="flex items-center gap-2 px-3 text-muted-foreground">
            {loading ? (
              <>
                <Loader2 className="animate-spin text-primary" size={14} />
                <p className="text-xs text-primary font-medium whitespace-nowrap">{t('data.parsing') || '解析中...'}</p>
              </>
            ) : status === 'success' ? (
              <>
                <CheckCircle2 className="text-green-500" size={14} />
                <p className="text-xs text-green-600 font-medium whitespace-nowrap">{t('data.uploadSuccess') || '上传成功'}</p>
              </>
            ) : status === 'error' ? (
              <>
                <AlertCircle className="text-red-500" size={14} />
                <p className="text-xs text-red-600 font-medium whitespace-nowrap">{t('data.uploadFailed') || '上传失败'}</p>
              </>
            ) : (
              <>
                <span className="flex-shrink-0">{icon}</span>
                <p className="text-xs whitespace-nowrap">
                  {t('data.clickToUpload') || '点击上传'} {accept}
                </p>
                {description && (
                  <span className="text-[10px] text-muted-foreground ml-1 whitespace-nowrap hidden sm:inline">· {description}</span>
                )}
              </>
            )}
          </div>
          <input
            type="file"
            className="hidden"
            accept={accept}
            onChange={onUpload}
            disabled={loading}
            multiple={multiple}
          />
        </label>
      </div>
    )
  }

  // 默认布局（垂直布局）
  return (
    <div>
      <label className="block text-xs font-medium mb-0.5">{title}</label>
      <label className={`flex flex-col items-start justify-center w-full h-10 border-2 border-dashed rounded cursor-pointer transition-all duration-200 ${getBorderClass()}`}>
        <div className="flex flex-row items-center gap-3 w-full px-3 text-muted-foreground">
          {loading ? (
            <>
              <Loader2 className="animate-spin text-primary" size={16} />
              <p className="text-xs text-primary font-medium">{t('data.parsing') || '解析中...'}</p>
            </>
          ) : status === 'success' ? (
            <>
              <CheckCircle2 className="text-green-500" size={16} />
              <p className="text-xs text-green-600 font-medium">{t('data.uploadSuccess') || '上传成功'}</p>
            </>
          ) : status === 'error' ? (
            <>
              <AlertCircle className="text-red-500" size={16} />
              <p className="text-xs text-red-600 font-medium">{t('data.uploadFailed') || '上传失败'}</p>
            </>
          ) : (
            <>
              <span className="flex-shrink-0 transition-transform duration-200 group-hover:scale-110">{icon}</span>
              <p className="text-xs flex-1 text-center">
                {t('data.clickToUpload') || '点击上传'} {accept}
              </p>
            </>
          )}
        </div>
        {description && !loading && status === 'idle' && (
          <p className="text-[10px] text-muted-foreground mt-1 px-2">{description}</p>
        )}
        <input
          type="file"
          className="hidden"
          accept={accept}
          onChange={onUpload}
          disabled={loading}
          multiple={multiple}
        />
      </label>
    </div>
  )
}

function NewCellEntryCard({
  fullParamFiles,
  addLog,
  disabled,
}: {
  fullParamFiles: DataItem[]
  addLog: (type: any, message: string, status?: any, detail?: string, opKey?: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const { batchAddCells, isAddingCell } = useDataStore()

  const [activeTab, setActiveTab] = useState<'LTE' | 'NR'>('LTE')
  const [rows, setRows] = useState<{ LTE: CellRow[]; NR: CellRow[] }>({
    LTE: Array.from({ length: 3 }, () => createEmptyRow()),
    NR: Array.from({ length: 3 }, () => createEmptyRow()),
  })
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set())
  const [batchResults, setBatchResults] = useState<Array<{ index: number; networkType: string; cellName: string; siteId: string; cellId: string; success: boolean; message: string }> | null>(null)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [importing, setImporting] = useState(false) // 一键导入进行中（覆盖预查重阶段，保证即时反馈）
  const [duplicateMap, setDuplicateMap] = useState<Record<string, 'same' | 'cross'>>({})

  const hasFullParams = fullParamFiles.length > 0

  function createEmptyRow(): CellRow {
    return {
      id: `row_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      managedElementId: '',
      siteId: '',
      cellId: '',
      cellName: '',
      mcc: '460',
      mnc: '11',
      longitude: '',
      latitude: '',
      azimuth: '',
      frequency: '',
      ssbFrequency: '',
      cellCoverType: 1,
    }
  }

  /** 创建 n 行空行（默认 3 行） */
  function createEmptyRows(n = 3): CellRow[] {
    return Array.from({ length: n }, () => createEmptyRow())
  }

  // ---- Validation helpers ----
  const isNumeric = (v: string) => /^-?\d+(\.\d+)?$/.test(v.trim())
  const isInteger = (v: string) => /^-?\d+$/.test(v.trim())
  /** Check if string is a float or integer (positive) */
  const isFloat = (v: string) => /^-?\d+(\.\d+)?$/.test(v.trim())

  /** Filter: keep only digits for integer fields */
  const filterDigits = (v: string) => v.replace(/\D/g, '')
  /** Filter: keep digits, dot, minus for numeric fields */
  const filterNumeric = (v: string) => v.replace(/[^\d.\-]/g, '')

  const isRowComplete = (row: CellRow, nt: 'LTE' | 'NR') => {
    const freqOk = nt === 'LTE' ? isFloat(row.frequency) : isFloat(row.ssbFrequency)
    const azi = parseInt(row.azimuth)
    const aziValid = isInteger(row.azimuth) && !isNaN(azi) && azi >= 0 && azi <= 360
    return isInteger(row.managedElementId)
      && isInteger(row.siteId)
      && isInteger(row.cellId)
      && row.cellName.trim() !== ''
      && isNumeric(row.longitude)
      && isNumeric(row.latitude)
      && aziValid
      && freqOk
      && (!row.mcc.trim() || isInteger(row.mcc))
      && row.mnc.trim().length === 2 && isInteger(row.mnc)
  }

  // Copy rows from selected checkboxes
  const copyRows = () => {
    const selected = rows[activeTab].filter(r => selectedRowIds.has(r.id))
    if (selected.length === 0) return
    const copies = selected.map(r => ({
      ...createEmptyRow(),
      managedElementId: r.managedElementId,
      siteId: r.siteId,
      cellId: r.cellId,
      cellName: r.cellName,
      mcc: r.mcc,
      mnc: r.mnc,
      longitude: r.longitude,
      latitude: r.latitude,
      azimuth: r.azimuth,
      frequency: r.frequency,
      ssbFrequency: r.ssbFrequency,
      cellCoverType: r.cellCoverType,
    }))
    setRows(prev => ({
      ...prev,
      [activeTab]: [...prev[activeTab], ...copies],
    }))
    setSelectedRowIds(new Set())
  }

  const copyButtonEnabled = selectedRowIds.size > 0
    && rows[activeTab].filter(r => selectedRowIds.has(r.id)).every(r => isRowComplete(r, activeTab))

  const deleteRow = (rowId: string) => {
    setRows(prev => {
      const tabRows = prev[activeTab]
      if (tabRows.length <= 1) return prev
      return {
        ...prev,
        [activeTab]: tabRows.filter(r => r.id !== rowId),
      }
    })
    setSelectedRowIds(prev => { const next = new Set(prev); next.delete(rowId); return next })
  }

  const updateRow = (rowId: string, field: string, value: string | number) => {
    setRows(prev => ({
      ...prev,
      [activeTab]: prev[activeTab].map(r =>
        r.id === rowId ? { ...r, [field]: value } : r
      ),
    }))
  }

  // 多行多列粘贴：从 Excel/文本复制 tab 分隔内容，按列顺序填充并自动扩充行数
  const handlePaste = (e: React.ClipboardEvent) => {
    if (!hasFullParams || isAddingCell) return
    const text = e.clipboardData.getData('text/plain')
    if (!text.includes('\t') && !text.includes('\n')) return // 单格粘贴交给浏览器默认
    e.preventDefault()

    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== '')
    if (lines.length === 0) return

    // 粘贴锚点：只接管聚焦在表格行内的粘贴
    const activeTr = (document.activeElement as HTMLElement | null)?.closest?.('tr') as HTMLTableRowElement | null
    const anchorId = activeTr?.dataset?.rowId
    if (!anchorId) return // 聚焦不在表格行内,不接管粘贴
    const idx = rows[activeTab].findIndex(r => r.id === anchorId)
    const anchor = idx >= 0 ? idx : 0

    const isLteTab = activeTab === 'LTE'
    // 列顺序：网元ID、基站ID、小区ID、小区名称、MCC、MNC、经度、纬度、方向角、频点、覆盖类型
    const nextRows = rows[activeTab].map(r => ({ ...r }))
    let rowIdx = anchor
    for (const line of lines) {
      const cols = line.split('\t')
      const get = (i: number) => (cols[i] ?? '').trim()
      const base = nextRows[rowIdx] ?? createEmptyRow()
      const next: CellRow = {
        ...base,
        managedElementId: get(0) ? filterDigits(get(0)) : base.managedElementId,
        siteId: get(1) ? filterDigits(get(1)) : base.siteId,
        cellId: get(2) ? filterDigits(get(2)) : base.cellId,
        cellName: get(3) || base.cellName,
        mcc: get(4) ? filterDigits(get(4)) : base.mcc,
        mnc: get(5) ? filterDigits(get(5)).slice(0, 2) : base.mnc,
        longitude: get(6) ? filterNumeric(get(6)) : base.longitude,
        latitude: get(7) ? filterNumeric(get(7)) : base.latitude,
        azimuth: get(8) ? filterDigits(get(8)) : base.azimuth,
        frequency: isLteTab && get(9) ? filterNumeric(get(9)) : base.frequency,
        ssbFrequency: !isLteTab && get(9) ? filterNumeric(get(9)) : base.ssbFrequency,
        cellCoverType: get(10) ? (parseInt(get(10), 10) === 4 ? 4 : 1) : base.cellCoverType,
      }
      if (rowIdx < nextRows.length) nextRows[rowIdx] = next
      else nextRows.push(next)
      rowIdx++
    }
    setRows(prev => ({ ...prev, [activeTab]: nextRows }))
  }

  const toggleRowSelection = (rowId: string) => {
    setSelectedRowIds(prev => {
      const next = new Set(prev)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
  }

  const toggleSelectAll = () => {
    const tabRows = rows[activeTab]
    const completeRows = tabRows.filter(r => isRowComplete(r, activeTab))
    const allCompleteSelected = completeRows.every(r => selectedRowIds.has(r.id))
    if (allCompleteSelected) {
      setSelectedRowIds(new Set())
    } else {
      setSelectedRowIds(new Set(completeRows.map(r => r.id)))
    }
  }

  const resetAll = () => {
    setRows({ LTE: createEmptyRows(), NR: createEmptyRows() })
    setSelectedRowIds(new Set())
    setBatchResults(null)
    setBatchError(null)
    setDuplicateMap({})
  }

  // Collect all non-empty rows from both tabs
  const collectValidRows = () => {
    const all: Array<{
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
    }> = []

    for (const nt of ['LTE', 'NR'] as const) {
      for (const r of rows[nt]) {
        const hasData = r.managedElementId.trim() || r.siteId.trim() || r.cellId.trim() || r.cellName.trim()
        if (!hasData) continue

        // Validate all fields
        const ntValid = isRowComplete(r, nt)
        if (!ntValid) continue

        all.push({
          networkType: nt,
          managedElementId: r.managedElementId.trim(),
          siteId: r.siteId.trim(),
          cellId: r.cellId.trim(),
          cellName: r.cellName.trim(),
          mcc: r.mcc.trim() || undefined,
          mnc: r.mnc.trim() || undefined,
          longitude: parseFloat(r.longitude),
          latitude: parseFloat(r.latitude),
          azimuth: parseFloat(r.azimuth),
          frequency: nt === 'LTE' ? r.frequency.trim() : undefined,
          ssbFrequency: nt === 'NR' ? r.ssbFrequency.trim() : undefined,
          cellCoverType: r.cellCoverType,
        })
      }
    }
    return all
  }

  const handleBatchImport = async () => {
    if (!hasFullParams || importing) return

    setImporting(true)
    try {
      setBatchResults(null)
    setBatchError(null)
    setDuplicateMap({})

    // 本次批量录入全程复用的日志 opKey，确保 "running" 条目被完成/失败条目覆盖
    const batchOpKey = `batchCellEntry:${Date.now()}`

    const validRows = collectValidRows()

    if (validRows.length === 0) {
      setBatchError(t('newCellEntry.noDataToImport') || '没有待导入的数据，请至少填写一行的必填字段')
      setTimeout(() => setBatchError(null), 5000)
      return
    }

    // 查重：按制式检查 CGI (siteId_cellId) 是否已存在于数据库
    try {
      const dupCheck = await dataApi.checkCellDuplicates(
        validRows.map(r => ({ siteId: r.siteId, cellId: r.cellId, networkType: r.networkType }))
      )
      const exists = dupCheck?.data?.exists
      if (exists && Object.keys(exists).length > 0) {
        // 分类：same=同制式重复(红)，cross=跨制式重复(橙)
        const dupMap: Record<string, 'same' | 'cross'> = {}
        for (const r of validRows) {
          const key = `${r.siteId}_${r.cellId}`
          const hit = exists[key]
          if (!hit) continue
          const panel = r.networkType === 'LTE' ? 'lte' : 'nr'
          const other = r.networkType === 'LTE' ? 'nr' : 'lte'
          if (hit[panel]) dupMap[key] = 'same'
          else if (hit[other]) dupMap[key] = 'cross'
        }
        setDuplicateMap(dupMap)
        const dupKeys = Object.keys(dupMap)

        if (dupKeys.length > 0) {
          const crossNames = validRows
            .filter(r => dupMap[`${r.siteId}_${r.cellId}`] === 'cross')
            .map(r => r.cellName)
            .join('、')
          const sameNames = validRows
            .filter(r => dupMap[`${r.siteId}_${r.cellId}`] === 'same')
            .map(r => r.cellName)
            .join('、')
          const dupMsgs = [
            crossNames ? t('newCellEntry.crossTypeDuplicate', { names: crossNames }) : '',
            sameNames ? t('newCellEntry.sameTypeDuplicate', { names: sameNames }) : '',
          ].filter(Boolean).join('；')
          if (dupMsgs) {
            setBatchError(dupMsgs)
            setTimeout(() => setBatchError(null), 8000)
          }
          // 过滤掉重复行（同制式 + 跨制式），只导入不重复的
          const uniqueRows = validRows.filter(r => !dupMap[`${r.siteId}_${r.cellId}`])
          if (uniqueRows.length === 0) {
            return // 全部重复
          }
          addLog('upload', `批量新站录入: ${uniqueRows.length} 条（跳过 ${validRows.length - uniqueRows.length} 条重复）`, 'running', undefined, batchOpKey)
          const result = await batchAddCells(uniqueRows)
          if (result?.success && result?.data?.results) {
            const results = result.data.results as Array<{ index: number; networkType: string; cellName: string; siteId: string; cellId: string; success: boolean; message: string }>
            setBatchResults(results)
            const successCount = results.filter(r => r.success).length
            addLog('upload', `批量新站录入完成: 成功 ${successCount}/${results.length}`, successCount === results.length ? 'success' : 'warning', undefined, batchOpKey)
            setRows({ LTE: createEmptyRows(), NR: createEmptyRows() })
            setSelectedRowIds(new Set())
            setDuplicateMap({})
          }
          return
        }
      }
    } catch (_) {
      // 查重失败不影响导入
    }

    addLog('upload', `批量新站录入: ${validRows.length} 条`, 'running', undefined, batchOpKey)

    try {
      const result = await batchAddCells(validRows)
      if (result?.success && result?.data?.results) {
        const results = result.data.results as Array<{ index: number; networkType: string; cellName: string; siteId: string; cellId: string; success: boolean; message: string }>
        setBatchResults(results)
        const successCount = results.filter(r => r.success).length
        addLog('upload', `批量新站录入完成: 成功 ${successCount}/${results.length}`, successCount === results.length ? 'success' : 'warning', undefined, batchOpKey)
        setRows({ LTE: createEmptyRows(), NR: createEmptyRows() })
        setSelectedRowIds(new Set())
      } else {
        const errMsg = result?.message || (t('newCellEntry.cellEntryFailed') || '批量录入失败')
        setBatchError(errMsg)
        addLog('upload', `批量新站录入失败: ${errMsg}`, 'error', undefined, batchOpKey)
        setTimeout(() => setBatchError(null), 5000)
      }
    } catch (err: any) {
      const errMsg = err.message || (t('newCellEntry.cellEntryFailed') || '批量录入失败')
      setBatchError(errMsg)
      addLog('upload', `批量新站录入失败: ${errMsg}`, 'error', undefined, batchOpKey)
      setTimeout(() => setBatchError(null), 5000)
    }
    } finally {
      setImporting(false)
    }
  }

  const isLte = activeTab === 'LTE'
  const inputCls = 'w-full min-w-[70px] px-1.5 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed'
  const inputClsExp = 'w-full min-w-[100px] px-2 py-1.5 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed'
  const labelCls = 'text-xs text-muted-foreground text-center leading-tight px-0.5 whitespace-nowrap'
  const curInputCls = expanded ? inputClsExp : inputCls

  // Count total valid rows across both tabs
  const totalRows = rows.LTE.filter(r => r.managedElementId.trim() || r.siteId.trim() || r.cellId.trim() || r.cellName.trim()).length
    + rows.NR.filter(r => r.managedElementId.trim() || r.siteId.trim() || r.cellId.trim() || r.cellName.trim()).length

  // Check if all complete rows in active tab are selected
  const completeInTab = rows[activeTab].filter(r => isRowComplete(r, activeTab))
  const allSelected = completeInTab.length > 0 && completeInTab.every(r => selectedRowIds.has(r.id))

  // ---- Render the main card (used both inline and in overlay) ----
  const renderCardContent = () => (
    <>
      <div className={`flex items-center justify-between ${expanded ? 'mb-4' : 'mb-2'}`}>
        <h2 className={`font-semibold ${expanded ? 'text-lg' : 'text-base'}`}>{t('newCellEntry.title') || '新站录入'}</h2>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
          title={expanded ? (t('newCellEntry.collapse') || '缩回') : (t('newCellEntry.expand') || '展开')}
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={14} />}
        </button>
      </div>

      {disabled && (
        <div className="px-3 py-2 bg-muted/40 border border-border rounded-lg text-xs text-muted-foreground mb-3">
          {t('data.noPermission', '无权限，请联系管理员')}
        </div>
      )}

      {!hasFullParams && (
        <div className={`px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg ${expanded ? 'text-sm mb-4' : 'text-xs mb-3'} text-amber-700`}>
          {t('newCellEntry.noFullParams') || '请先上传全量工参文件'}
        </div>
      )}

      {batchError && (
        <div className={`px-3 py-2 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 ${expanded ? 'text-sm mb-4' : 'text-xs mb-3'} text-red-700`}>
          <AlertCircle size={14} />
          <span>{batchError}</span>
          <button onClick={() => setBatchError(null)} className="ml-auto text-red-500 hover:text-red-700">✕</button>
        </div>
      )}

      <div className="flex items-center gap-3 mb-3">
        <div className="flex gap-2">
          {(['LTE', 'NR'] as const).map(nt => (
            <button
              key={nt}
              onClick={() => { setActiveTab(nt); setBatchResults(null); setBatchError(null); setSelectedRowIds(new Set()); setDuplicateMap({}) }}
              className={`px-3 py-1 rounded-md text-xs border transition-colors ${
                activeTab === nt
                  ? 'bg-primary/10 border-primary text-primary font-medium'
                  : 'bg-background border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {nt}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground ml-auto">
          LTE: {rows.LTE.filter(r => r.managedElementId.trim() || r.siteId.trim() || r.cellId.trim() || r.cellName.trim()).length}
          &nbsp; NR: {rows.NR.filter(r => r.managedElementId.trim() || r.siteId.trim() || r.cellId.trim() || r.cellName.trim()).length}
        </span>
      </div>

      {/* Multi-row table */}
      <div className={expanded ? 'overflow-x-auto' : 'overflow-x-auto'} onPaste={handlePaste}>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 w-0'}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  disabled={isAddingCell || !hasFullParams}
                  className="cursor-pointer"
                />
              </th>
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30 w-0'}>{/* 操作列 */}</th>
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30'}>{t('newCellEntry.fieldManagedElementId') || '网元ID'}</th>
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30'}>{t('newCellEntry.fieldSiteIdLTE') || '基站ID'}</th>
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30'}>{t('newCellEntry.fieldCellId') || '小区ID'}</th>
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30'}>{t('newCellEntry.fieldCellName') || '小区名称'}</th>
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30'}>{t('newCellEntry.fieldMCC') || 'MCC'}</th>
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30'}>{t('newCellEntry.fieldMNC') || 'MNC'}</th>
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30'}>{t('newCellEntry.fieldLongitude') || '经度'}</th>
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30'}>{t('newCellEntry.fieldLatitude') || '纬度'}</th>
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30'}>{t('newCellEntry.fieldAzimuth') || '方向角'}</th>
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30'}>{isLte ? (t('newCellEntry.fieldFrequency') || '下行频点') : (t('newCellEntry.fieldSsbFrequency') || 'SSB频点')}</th>
              <th className={labelCls + ' border border-border px-1 py-1 bg-muted/30'}>{t('newCellEntry.fieldCellCoverType') || '覆盖类型'}</th>
            </tr>
          </thead>
          <tbody>
            {rows[activeTab].map((row) => {
              const complete = isRowComplete(row, activeTab)
              return (
                <tr key={row.id} data-row-id={row.id} className={`${selectedRowIds.has(row.id) ? 'bg-blue-50/50' : ''} ${
                  duplicateMap[`${row.siteId}_${row.cellId}`] === 'same' ? 'bg-red-50' :
                  duplicateMap[`${row.siteId}_${row.cellId}`] === 'cross' ? 'bg-amber-50' : ''
                }`}>
                  <td className="border border-border px-1 py-1 text-center">
                    <input
                      type="checkbox"
                      checked={selectedRowIds.has(row.id)}
                      onChange={() => toggleRowSelection(row.id)}
                      disabled={!complete || isAddingCell || !hasFullParams}
                      className="cursor-pointer"
                    />
                  </td>
                  <td className="border border-border px-1 py-1 text-center">
                    <button
                      onClick={() => deleteRow(row.id)}
                      disabled={isAddingCell || rows[activeTab].length <= 1}
                      className="text-muted-foreground hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      title={t('newCellEntry.deleteRow') || '删除'}
                    >
                      <span className="text-xs">✕</span>
                    </button>
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input className={curInputCls} type="text" inputMode="numeric" value={row.managedElementId} onChange={e => updateRow(row.id, 'managedElementId', filterDigits(e.target.value))} disabled={!hasFullParams || isAddingCell} placeholder="" />
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input className={curInputCls} type="text" inputMode="numeric" value={row.siteId} onChange={e => updateRow(row.id, 'siteId', filterDigits(e.target.value))} disabled={!hasFullParams || isAddingCell} placeholder="" />
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input className={curInputCls} type="text" inputMode="numeric" value={row.cellId} onChange={e => updateRow(row.id, 'cellId', filterDigits(e.target.value))} disabled={!hasFullParams || isAddingCell} placeholder="" />
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input className={curInputCls} value={row.cellName} onChange={e => updateRow(row.id, 'cellName', e.target.value)} disabled={!hasFullParams || isAddingCell} placeholder="" />
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input className={curInputCls} type="text" inputMode="numeric" value={row.mcc} onChange={e => updateRow(row.id, 'mcc', filterDigits(e.target.value))} disabled={!hasFullParams || isAddingCell} placeholder="460" />
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input
                      className={curInputCls}
                      list="mnc-options"
                      value={row.mnc}
                      onChange={e => updateRow(row.id, 'mnc', filterDigits(e.target.value).slice(0, 2))}
                      disabled={!hasFullParams || isAddingCell}
                      placeholder="11"
                    />
                    <datalist id="mnc-options">
                      <option value="11" />
                      <option value="01" />
                    </datalist>
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input className={curInputCls} type="text" inputMode="decimal" value={row.longitude} onChange={e => updateRow(row.id, 'longitude', filterNumeric(e.target.value))} disabled={!hasFullParams || isAddingCell} placeholder="114.0" />
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input className={curInputCls} type="text" inputMode="decimal" value={row.latitude} onChange={e => updateRow(row.id, 'latitude', filterNumeric(e.target.value))} disabled={!hasFullParams || isAddingCell} placeholder="23.0" />
                  </td>
                  <td className="border border-border px-1 py-1">
                    <input className={curInputCls} type="text" inputMode="numeric" value={row.azimuth} onChange={e => updateRow(row.id, 'azimuth', filterDigits(e.target.value))} disabled={!hasFullParams || isAddingCell} placeholder="0-360" />
                  </td>
                  <td className="border border-border px-1 py-1">
                    {isLte ? (
                      <input className={curInputCls} type="text" inputMode="decimal" value={row.frequency} onChange={e => updateRow(row.id, 'frequency', filterNumeric(e.target.value))} disabled={!hasFullParams || isAddingCell} placeholder="" />
                    ) : (
                      <input className={curInputCls} type="text" inputMode="decimal" value={row.ssbFrequency} onChange={e => updateRow(row.id, 'ssbFrequency', filterNumeric(e.target.value))} disabled={!hasFullParams || isAddingCell} placeholder="" />
                    )}
                  </td>
                  <td className="border border-border px-1 py-1">
                    <select
                      className={curInputCls}
                      value={row.cellCoverType}
                      onChange={e => updateRow(row.id, 'cellCoverType', parseInt(e.target.value))}
                      disabled={!hasFullParams || isAddingCell}
                    >
                      <option value={1}>{t('newCellEntry.cellCoverTypeOutdoor') || '室外站'}</option>
                      <option value={4}>{t('newCellEntry.cellCoverTypeIndoor') || '室分站'}</option>
                    </select>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Copy Row button */}
      <div className="mt-2">
        <button
          onClick={copyRows}
          disabled={!copyButtonEnabled || isAddingCell || !hasFullParams}
          className={`px-3 py-1 text-xs rounded-md border border-dashed border-border bg-muted/20 ${copyButtonEnabled ? 'text-blue-500 hover:bg-blue-50 hover:border-blue-300' : 'text-muted-foreground'} disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1`}
        >
          + {t('newCellEntry.addRow') || '复制行'}
          {selectedRowIds.size > 0 && <span className="text-xs">({selectedRowIds.size})</span>}
        </button>
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-between mt-3">
        <span className="text-xs text-muted-foreground leading-relaxed max-w-[50%]">
          {t('newCellEntry.cellCoverTypeDesc') || '涉及大量数据录入建议在"已导入数据"下载工参文件录入后导入'}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={resetAll}
            disabled={isAddingCell}
            className="px-3 py-1.5 text-xs rounded-md border border-border bg-background text-muted-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t('newCellEntry.reset') || '重置'}
          </button>
          <button
            onClick={handleBatchImport}
            disabled={totalRows === 0 || importing || !hasFullParams}
            className="px-4 py-1.5 text-xs font-medium rounded-md bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
          >
            {importing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            {importing ? (t('data.saving') || '录入中...') : (t('newCellEntry.batchImport') || '一键导入')}
            {totalRows > 0 && !importing && <span className="text-blue-100">({totalRows})</span>}
          </button>
        </div>
      </div>

      {/* Import results — at bottom of card */}
      {batchResults && batchResults.length > 0 && (
        <div className="mt-3 px-3 py-2 bg-muted/50 border border-border rounded-lg text-xs">
          <div className="flex items-center gap-2 mb-1.5 font-medium text-foreground">
            <CheckCircle2 size={14} />
            <span>{t('newCellEntry.importResults') || '导入结果'}</span>
            <button onClick={() => setBatchResults(null)} className="ml-auto text-muted-foreground hover:text-foreground">✕</button>
          </div>
          {batchResults.map((r, i) => (
            <div key={i} className={`flex items-center gap-1.5 py-0.5 ${r.success ? 'text-green-600' : 'text-red-600'}`}>
              <span className="font-medium">#{r.index + 1}</span>
              <span>[{r.networkType}]</span>
              <span>{r.cellName}({r.siteId}_{r.cellId})</span>
              <span className="ml-auto">{r.success ? '✓' : '✗'} {r.message}</span>
            </div>
          ))}
          <div className="mt-1.5 pt-1.5 border-t border-border text-muted-foreground">
            {t('newCellEntry.importSummary', {
              total: batchResults.length,
              success: batchResults.filter(r => r.success).length,
              fail: batchResults.filter(r => !r.success).length,
            }) || `共 ${batchResults.length} 条，成功 ${batchResults.filter(r => r.success).length} 条，失败 ${batchResults.filter(r => !r.success).length} 条`}
          </div>
        </div>
      )}
    </>
  )

  // ---- If expanded, render as fixed overlay ----
  if (expanded) {
    return (
      <div className="fixed inset-0 z-[9999] bg-black/40 backdrop-blur-sm flex items-start justify-center pt-8 overflow-y-auto" style={{ paddingLeft: '280px' }}>
        <div className={`bg-card rounded-xl shadow-2xl border border-border w-full mx-6 overflow-hidden ${disabled ? 'opacity-50 pointer-events-none' : ''}`} style={{ maxWidth: 'min(90vw, 1400px)' }}>
          <div className="p-5">
            {renderCardContent()}
          </div>
        </div>
      </div>
    )
  }

  // ---- Normal inline mode ----
  return (
    <div className={`bg-card p-3 rounded-lg border border-border -mt-6 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      {renderCardContent()}
    </div>
  )
}

interface CellRow {
  id: string
  managedElementId: string
  siteId: string
  cellId: string
  cellName: string
  mcc: string
  mnc: string
  longitude: string
  latitude: string
  azimuth: string
  frequency: string
  ssbFrequency: string
  cellCoverType: number
}
