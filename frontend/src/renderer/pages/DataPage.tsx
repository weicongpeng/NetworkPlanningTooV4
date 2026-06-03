import { useState, useEffect, useCallback } from 'react'
import { Upload, FileSpreadsheet, Trash2, Download, Loader2, AlertCircle, RefreshCw, CheckCircle2, Layers, FileDown, MapPin, Navigation, CheckSquare, Square } from 'lucide-react'
import { useDataStore } from '../store/dataStore'
import { dataApi } from '../services/api'
import type { DataItem } from '@shared/types'
import { DATA_REFRESH_EVENT, triggerDataRefresh } from '../store/dataStore'
import { mapDataService } from '../services/mapDataService'
import { indexedDBService } from '../services/indexedDBService'
import { useTranslation } from 'react-i18next'

export function DataPage() {
  const { t } = useTranslation()
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
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set())

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

  // 初始化数据列表 + 监听跨页面刷新事件
  useEffect(() => {
    fetchList(1, 50)

    // 监听数据刷新事件（从其他页面触发，如PCI应用后）
    const handleDataRefresh = () => {
      console.log('[DataPage] 收到数据刷新事件，正在刷新列表...')
      fetchList(1, 50, true)  // 强制刷新，忽略缓存
    }

    window.addEventListener(DATA_REFRESH_EVENT, handleDataRefresh)

    return () => {
      window.removeEventListener(DATA_REFRESH_EVENT, handleDataRefresh)
    }
  }, []) // 修复：移除 fetchList 依赖，使用空依赖数组，避免事件监听器被反复移除/添加导致事件丢失

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
      } else {
        setUploadStatus(prev => ({ ...prev, [context]: 'error' }))
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
      } else {
        setUploadStatus(prev => ({ ...prev, [context]: 'error' }))
        setTimeout(() => setUploadStatus(prev => ({ ...prev, [context]: 'idle' })), 3000)
      }
    }
  }

  const handleDownload = async (item: DataItem) => {
    setDownloadingIds(prev => new Set(prev).add(item.id))
    try {
        console.log('[Download] Requesting:', item.id);
        const url = `/api/v1/data/${item.id}/download`;

        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const blob = await response.blob();
        if (blob.size === 0) throw new Error(t('data.emptyFile') || '文件内容为空');

        const filename = item.name || 'download';

        // 优先使用 File System Access API 弹出保存对话框
        if ('showSaveFilePicker' in window) {
            try {
                const opts = {
                    suggestedName: filename,
                    types: [{
                        description: 'Excel File',
                        accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] }
                    }]
                };
                // 根据扩展名调整 types
                if (filename.endsWith('.zip')) {
                    opts.types = [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }];
                }
                const handle = await (window as any).showSaveFilePicker(opts);
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                console.log('[Download] Saved via File Picker:', filename);
                return;
            } catch (pickerErr: any) {
                // 用户取消或 API 不可用，回退到 a.click
                if (pickerErr.name === 'AbortError') {
                    console.log('[Download] User cancelled save dialog');
                    return;
                }
                console.warn('[Download] showSaveFilePicker failed, falling back:', pickerErr);
            }
        }

        // 后备方案：a.click() 触发下载
        const blobUrl = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();

        setTimeout(() => {
            document.body.removeChild(link);
            window.URL.revokeObjectURL(blobUrl);
        }, 100);

        console.log('[Download] Success (fallback)');
    } catch (err: any) {
        console.error('[Download] Failed:', err);
        alert(`${t('data.downloadFailed') || '下载失败'}: ${err.message || (t('data.unknownError') || '未知错误')}`)
    } finally {
        setDownloadingIds(prev => {
            const next = new Set(prev)
            next.delete(item.id)
            return next
        })
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
            await fetchList(1, 50, true)
            await mapDataService.clearCache()
            triggerDataRefresh()
          } else {
            alert(`${t('data.forceDeleteFailed') || '强制删除失败。请尝试：'}\n1. ${t('data.forceDeleteCloseExcel') || '关闭所有 Excel 文件'}\n2. ${t('data.forceDeleteRestartApp') || '重启应用后再试'}\n3. ${t('data.forceDeleteManually') || '手动删除 data 目录下的对应文件夹'}`)
          }
        } else {
          alert(t('data.deleteCancelled') || '删除已取消。')
        }
      } else {
        await fetchList(1, 50, true)
        await mapDataService.clearCache()
        triggerDataRefresh()
      }
    } catch (err: any) {
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

  const handleUpdateParameters = async () => {
     if (!selectedFullParamId || !selectedCurrentParamId) return

     setUpdateSuccess(null)
     try {
         const result = await updateParameters(selectedFullParamId, selectedCurrentParamId)
         console.log('Update parameters result:', result);

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
         } else {
             // 更新失败（后端返回错误状态且列表中也未找到新文件）
             throw new Error(result?.message || t('data.updateFailed') || '工参更新失败')
         }
     } catch (err: any) {
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
        <h1 className="text-3xl font-bold">{t('data.title')}</h1>
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
            <h2 className="text-xl font-semibold mb-2">{t('data.importData') || '导入数据'}</h2>

             <div className="space-y-2">
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
            <div className="bg-card p-3 rounded-lg border border-border -mt-6">
                <h2 className="text-xl font-semibold mb-2">{t('data.updateParameters') || '工参更新'}</h2>
                <div className="space-y-4">
                    <div>
                        <select
                            className="w-full p-2 border rounded-md bg-background text-sm"
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
                    </div>
                    <div>
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
                        className="w-full py-2 px-4 bg-blue-400 text-white rounded-md hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        {isUpdating ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                        {isUpdating ? (t('data.updating') || '更新中...') : (t('data.startUpdate') || '开始更新')}
                    </button>
                </div>
            </div>
        </div>

        {/* 数据列表 */}
        <div className="bg-card p-6 rounded-lg border border-border h-full">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">{t('data.importedData') || '已导入数据'}</h2>
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
                    onClick={handleBatchDelete}
                    disabled={selectedIds.size === 0 || batchDeleting}
                    className="text-xs px-2.5 py-1 rounded border bg-background border-border text-red-500 hover:bg-red-50 hover:border-red-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-background disabled:hover:border-border transition-colors flex items-center gap-1"
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
                      onClick={(e) => toggleSelectItem(item.id, e)}
                      className="p-1.5 hover:bg-background rounded text-muted-foreground hover:text-primary transition-colors"
                      title={selectedIds.has(item.id) ? (t('data.deselectItem') || '取消选择') : (t('data.selectItem') || '选择')}
                    >
                      {selectedIds.has(item.id) ? (
                        <CheckSquare size={16} className="text-primary" />
                      ) : (
                        <Square size={16} />
                      )}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDownload(item)
                      }}
                      disabled={downloadingIds.has(item.id)}
                      className="p-2 hover:bg-background rounded text-primary disabled:opacity-50 disabled:cursor-wait"
                      title={downloadingIds.has(item.id) ? (t('data.downloading') || '下载中...') : (t('data.download') || '下载')}
                    >
                      {downloadingIds.has(item.id) ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(item)
                      }}
                      className="p-2 hover:bg-background rounded text-red-500"
                      title={t('data.delete') || '删除'}
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

      {/* 数据预览 */}
      <div className="mt-8 bg-card p-6 rounded-lg border border-border">
        <h2 className="text-xl font-semibold mb-4">{t('data.preview') || '数据预览'}</h2>
        {!selectedId ? (
          <p className="text-muted-foreground text-center py-8">
            {t('data.selectToPreview') || '请选择数据查看预览'}
          </p>
        ) : (
          <DataPreview dataId={selectedId} />
        )}
      </div>
    </div>
  )
}

function DataPreview({ dataId }: { dataId: string }) {
  const { t: tPreview } = useTranslation()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchData() {
      setLoading(true)
      setError(null)
      try {
        const response = await fetch(`/api/v1/data/${dataId}`)
        const result = await response.json()
        // 后端返回 { success: true, data: ... }
        setData(result.success ? result.data : null)
      } catch (err) {
        console.error('Failed to fetch data:', err)
        setError(tPreview('data.loadFailed') || '加载数据失败')
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [dataId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="animate-spin" />
        <span className="ml-2 text-muted-foreground">{tPreview('data.loading') || '加载中...'}</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-16 text-red-500">
        <AlertCircle size={20} className="mr-2" />
        <span>{error}</span>
      </div>
    )
  }

  if (!data) {
    return <p className="text-muted-foreground text-center py-8">{tPreview('data.cannotLoadData') || '无法加载数据'}</p>
  }

  // 处理失败状态
  if (data.status === 'error') {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-red-500">
        <AlertCircle size={24} className="mb-3" />
        <p className="text-sm font-medium text-center mb-1">
          {tPreview('data.processingFailed') || '文件处理失败'}
        </p>
        {data.errorMessage && (
          <p className="text-xs text-muted-foreground text-center max-w-md mt-1 px-4">
            {data.errorMessage}
          </p>
        )}
        <p className="text-xs text-muted-foreground mt-3">
          {tPreview('data.deleteAndRetry') || '请删除后重新上传'}
        </p>
      </div>
    )
  }

  // 如果是文件列表（ZIP文件）
  if (data.files) {
      return (
          <div>
              <p className="text-sm text-muted-foreground mb-4">
                  {tPreview('data.containsFiles', { count: data.files.length }) || `包含 ${data.files.length} 个文件`}
              </p>
              <div className="max-h-60 overflow-y-auto border rounded-md">
                  <ul className="divide-y">
                      {data.files.map((file: string, index: number) => (
                          <li key={index} className="p-2 text-sm hover:bg-muted/50">
                              {file}
                          </li>
                      ))}
                  </ul>
              </div>
          </div>
      )
  }

  return (
    <div>
      <p className="text-sm text-muted-foreground mb-4">
        {tPreview('data.siteCount', { count: Array.isArray(data) ? data.length : 0 }) || `共 ${Array.isArray(data) ? data.length : 0} 个基站`}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left p-2">{tPreview('data.siteId') || '基站ID'}</th>
              <th className="text-left p-2">{tPreview('data.siteName') || '基站名称'}</th>
              <th className="text-left p-2">{tPreview('data.networkType') || '网络类型'}</th>
              <th className="text-left p-2">{tPreview('data.longitude') || '经度'}</th>
              <th className="text-left p-2">{tPreview('data.latitude') || '纬度'}</th>
              <th className="text-left p-2">{tPreview('data.sectorCount') || '小区数'}</th>
            </tr>
          </thead>
          <tbody>
            {Array.isArray(data) && data.slice(0, 50).map((site: any) => (
              <tr key={site.id} className="border-b hover:bg-muted/50">
                <td className="p-2">{site.id}</td>
                <td className="p-2">{site.name}</td>
                <td className="p-2">{site.networkType}</td>
                <td className="p-2">{site.longitude?.toFixed(6)}</td>
                <td className="p-2">{site.latitude?.toFixed(6)}</td>
                <td className="p-2">{site.sectors?.length || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
