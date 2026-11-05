import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { mapDataService, getCellList, clearCellListCache } from '../services/mapDataService'
import { extractCellIdsFromFile, matchCellIds } from '../utils/cellFileHelper'
import { DATA_REFRESH_EVENT } from '../store/dataStore'
import { usePCICheckStore } from '../store/pciCheckStore'
import type { CellListItem } from '../services/mapDataService'

/**
 * PCI核查的小区选择：小区列表加载、勾选维护、待核查小区文件导入
 *
 * 勾选同步到 pciCheckStore 持久化，切到别的页面再回来仍能看到自己的勾选；
 * 工参在别处被重新上传时（DATA_REFRESH_EVENT）清缓存重载列表，保证与当前数据一致。
 */
export function usePCICheckCells(onError: (message: string) => void) {
  const { t } = useTranslation()
  const [cellListData, setCellListData] = useState<{ lte: CellListItem[]; nr: CellListItem[] }>({ lte: [], nr: [] })
  const [cellListLoading, setCellListLoading] = useState(false)
  const [cellFileUploading, setCellFileUploading] = useState(false)
  const [selectedCellIds, setSelectedCellIds] = useState<Set<string>>(
    () => new Set(usePCICheckStore.getState().selectedCellIds)
  )
  const cellFileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    usePCICheckStore.getState().setSelectedCellIds(Array.from(selectedCellIds))
  }, [selectedCellIds])

  const loadCellList = useCallback(async () => {
    setCellListLoading(true)
    try {
      const data = await getCellList()
      setCellListData({ lte: data.lte || [], nr: data.nr || [] })
    } catch (err) {
      console.error('[usePCICheckCells] 加载小区列表失败:', err)
    } finally {
      setCellListLoading(false)
    }
  }, [])

  useEffect(() => {
    loadCellList()
  }, [loadCellList])

  useEffect(() => {
    const handleDataRefresh = async () => {
      try {
        await mapDataService.clearCache()
        clearCellListCache()
        loadCellList()
      } catch (err) {
        console.warn('[usePCICheckCells] 数据刷新失败:', err)
      }
    }
    window.addEventListener(DATA_REFRESH_EVENT, handleDataRefresh)
    return () => window.removeEventListener(DATA_REFRESH_EVENT, handleDataRefresh)
  }, [loadCellList])

  const toggleCell = (cellId: string) => {
    setSelectedCellIds(prev => {
      const next = new Set(prev)
      if (next.has(cellId)) next.delete(cellId)
      else next.add(cellId)
      return next
    })
  }

  const selectAll = (filteredIds: string[]) => {
    const allSelected = filteredIds.length > 0 && filteredIds.every(id => selectedCellIds.has(id))
    setSelectedCellIds(prev => {
      const next = new Set(prev)
      if (allSelected) filteredIds.forEach(id => next.delete(id))
      else filteredIds.forEach(id => next.add(id))
      return next
    })
  }

  const clearSelections = () => setSelectedCellIds(new Set())

  const handleCellFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.name.toLowerCase().startsWith('cell-tree')) {
      onError(t('pciCheck.cellFilePrefixError') || '文件名必须以"cell-tree"开头')
      e.target.value = ''
      return
    }
    setCellFileUploading(true)
    try {
      const extractedIds = await extractCellIdsFromFile(file)
      if (extractedIds.length === 0) {
        onError(t('pciCheck.noCellIdsExtracted') || '未能从文件中提取到小区ID，请检查文件格式')
        return
      }
      // 匹配优先于上传：先刷新列表再按当前工参匹配
      clearCellListCache()
      const data = await getCellList()
      setCellListData({ lte: data.lte || [], nr: data.nr || [] })
      const matchedIds = matchCellIds(extractedIds, [...data.lte, ...data.nr].map(item => item.id))
      if (matchedIds.length > 0) setSelectedCellIds(new Set(matchedIds))
      else onError(t('pciCheck.noMatchingCells') || '未匹配到任何小区，请检查文件内容与当前工参数据是否一致')
    } catch (err: any) {
      console.error('[usePCICheckCells] 处理待核查小区文件失败:', err)
      onError(err.message || (t('pciCheck.cellFileUploadFailed') || '待核查小区文件处理失败'))
    } finally {
      setCellFileUploading(false)
      e.target.value = ''
    }
  }

  return {
    cellListData,
    cellListLoading,
    cellFileUploading,
    cellFileInputRef,
    selectedCellIds,
    setSelectedCellIds,
    toggleCell,
    selectAll,
    clearSelections,
    handleCellFileChange,
  }
}
