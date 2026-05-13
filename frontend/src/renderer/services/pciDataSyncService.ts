/**
 * PCI数据同步服务
 *
 * 负责将PCI规划结果的新PCI同步到全量工参数据（内存中），
 * 并提供同频同PCI扇区查找功能。
 *
 * 数据流程：
 * 1. 从mapDataService获取全量工参数据
 * 2. 将PCI规划结果的新PCI同步到对应扇区
 * 3. 基于同步后的数据查找同频同PCI扇区
 */

import { mapDataService, RenderSectorData } from './mapDataService'

/**
 * PCI规划结果中的扇区数据
 */
interface PCIResultSector {
  siteId: string
  sectorId: string
  newPCI: number
  frequency: number | null
  earfcn: number | null
  ssb_frequency: number | null
  latitude: number | null
  longitude: number | null
  [key: string]: any
}

/**
 * PCI规划结果
 */
interface PCIPlanningResult {
  results: Array<{
    siteId: string
    siteName: string
    sectors: PCIResultSector[]
  }>
}

/**
 * 同步后的扇区数据（扩展RenderSectorData）
 */
interface SyncedSectorData extends RenderSectorData {
  /** 同步后的PCI（可能来自规划结果） */
  syncedPCI?: number
  /** 是否是规划结果中的扇区 */
  isPlannedSector: boolean
}

/**
 * PCI数据同步服务类
 */
export class PCIDataSyncService {
  /** 全量工参原始数据（副本） */
  private fullParamsData: {
    lte: RenderSectorData[]
    nr: RenderSectorData[]
  } | null = null

  /** 同步后的数据 */
  private syncedData: {
    lte: SyncedSectorData[]
    nr: SyncedSectorData[]
  } | null = null

  /** 临时工参副本（PCI规划同频同PCI地理化显示专用，不写入真实工参） */
  private pciTempData: {
    lte: SyncedSectorData[]
    nr: SyncedSectorData[]
  } | null = null

  /** PCI规划结果映射表 */
  private pciResultsMap = new Map<string, PCIResultSector>()

  /**
   * 初始化同步服务，加载全量工参数据
   */
  async initialize(): Promise<void> {
    try {
      // 从mapDataService获取全量工参数据（优先使用缓存）
      const mapData = await mapDataService.getMapData()

      // 检查是否有数据
      if (!mapData.lteSectors.length && !mapData.nrSectors.length) {
        console.warn('[PCIDataSyncService] 未找到全量工参数据，初始化为空数据')
        this.fullParamsData = { lte: [], nr: [] }
        this.syncedData = { lte: [], nr: [] }
        return
      }

      // 创建数据副本（深拷贝）
      this.fullParamsData = {
        lte: JSON.parse(JSON.stringify(mapData.lteSectors)),
        nr: JSON.parse(JSON.stringify(mapData.nrSectors))
      }

      // 初始化同步数据
      this.syncedData = {
        lte: this.fullParamsData.lte.map(s => ({
          ...s,
          syncedPCI: s.pci,
          isPlannedSector: false
        })),
        nr: this.fullParamsData.nr.map(s => ({
          ...s,
          syncedPCI: s.pci,
          isPlannedSector: false
        }))
      }

      console.log('[PCIDataSyncService] 初始化完成', {
        lte: this.syncedData.lte.length,
        nr: this.syncedData.nr.length
      })
    } catch (error: any) {
      console.warn('[PCIDataSyncService] 初始化失败:', error?.message || error)
      // 初始化为空数据，不抛出错误
      this.fullParamsData = { lte: [], nr: [] }
      this.syncedData = { lte: [], nr: [] }
    }
  }

  /**
   * 设置PCI规划结果
   * 创建临时工参副本，将规划后的PCI更新到副本中
   * 临时工参只用于PCI规划同频同PCI地理化显示，不写入真实工参
   */
  setPCIResults(results: PCIPlanningResult): void {
    // 构建规划结果映射表
    this.pciResultsMap.clear()

    for (const site of results.results || []) {
      for (const sector of site.sectors || []) {
        // 规划结果中的sectorId可能是组合格式（如"540951_0"）或纯数字格式（如"0"）
        // 需要统一处理为 siteId_sectorId 格式
        let key: string
        const sectorIdStr = String(sector.sectorId).trim()

        // 如果sectorId已经包含siteId（组合格式），直接使用
        if (sectorIdStr.includes('_') && sectorIdStr.startsWith(String(site.siteId))) {
          key = sectorIdStr
        } else {
          // 否则拼接为 siteId_sectorId 格式
          key = this.getSectorKey(site.siteId, sector.sectorId)
        }

        this.pciResultsMap.set(key, {
          ...sector,
          siteId: site.siteId
        })

        console.log('[PCIDataSyncService] 规划结果映射', {
          siteId: site.siteId,
          sectorId: sector.sectorId,
          key,
          newPCI: sector.newPCI
        })
      }
    }

    console.log('[PCIDataSyncService] PCI规划结果已加载', {
      count: this.pciResultsMap.size
    })

    // 创建临时工参副本，将规划后的PCI更新到副本中
    this.createTempDataWithUpdatedPCI()
  }

  /**
   * 创建临时工参副本，将规划后的PCI更新到副本中
   * 临时工参只用于PCI规划同频同PCI地理化显示
   */
  private createTempDataWithUpdatedPCI(): void {
    if (!this.fullParamsData) {
      console.warn('[PCIDataSyncService] 全量工参数据未初始化，无法创建临时工参副本')
      return
    }

    console.log('[PCIDataSyncService] 开始创建临时工参副本（用于同频同PCI地理化显示）')

    // 创建全量工参的深拷贝，并初始化 syncedPCI 和 isPlannedSector
    const tempLTE = JSON.parse(JSON.stringify(this.fullParamsData.lte)).map((s: any) => ({
      ...s,
      syncedPCI: s.pci,
      isPlannedSector: false
    }))

    const tempNR = JSON.parse(JSON.stringify(this.fullParamsData.nr)).map((s: any) => ({
      ...s,
      syncedPCI: s.pci,
      isPlannedSector: false
    }))

    // 应用规划后的PCI到临时副本
    let appliedCount = 0
    let failedCount = 0
    const failedKeys: string[] = []

    for (const [key, pciResult] of this.pciResultsMap) {
      let found = false

      // 在LTE数据中查找
      for (const sector of tempLTE) {
        const sKey = this.getSectorKey(sector.siteId || '', sector.sectorId || '')
        if (sKey === key || sector.id === key) {
          sector.syncedPCI = pciResult.newPCI
          sector.isPlannedSector = true
          found = true
          appliedCount++
          break
        }
      }

      // 在NR数据中查找
      if (!found) {
        for (const sector of tempNR) {
          const sKey = this.getSectorKey(sector.siteId || '', sector.sectorId || '')
          if (sKey === key || sector.id === key) {
            sector.syncedPCI = pciResult.newPCI
            sector.isPlannedSector = true
            found = true
            appliedCount++
            break
          }
        }
      }

      if (!found) {
        failedCount++
        failedKeys.push(key)
      }
    }

    this.pciTempData = {
      lte: tempLTE,
      nr: tempNR
    }

    console.log('[PCIDataSyncService] 临时工参副本创建完成', {
      lteCount: tempLTE.length,
      nrCount: tempNR.length,
      appliedCount,
      failedCount,
      failedKeys: failedKeys.slice(0, 10)
    })
  }

  /**
   * 同步单个扇区的PCI
   * @returns 同步是否成功
   */
  syncSectorPCI(siteId: string, sectorId: string, newPCI: number): boolean {
    // sectorId可能是组合格式（如"540951_0"）或纯数字格式（如"0"）
    // 需要统一处理为 siteId_sectorId 格式
    let key: string
    const sectorIdStr = String(sectorId).trim()

    // 如果sectorId已经包含siteId（组合格式），直接使用
    if (sectorIdStr.includes('_') && sectorIdStr.startsWith(String(siteId))) {
      key = sectorIdStr
    } else {
      // 否则拼接为 siteId_sectorId 格式
      key = this.getSectorKey(siteId, sectorId)
    }

    const pciResult = this.pciResultsMap.get(key)

    if (!this.syncedData) {
      console.warn('[PCIDataSyncService] 数据未初始化')
      return false
    }

    let synced = false

    // 更新LTE或NR数据
    const updateSector = (sectors: SyncedSectorData[]) => {
      const sector = sectors.find(s => {
        // 尝试多种匹配方式，因为mapDataService中id的构建有优先级
        // id = `${siteId}_${cellId}`, 其中 cellId = sector.id || sector.cellId || sector.localCellId || sector.sectorId
        const sKey = this.getSectorKey(s.siteId || '', s.sectorId || '')
        if (sKey === key) return true

        // 也尝试直接用id字段匹配
        if (s.id === key) return true

        // 尝试其他匹配方式，增强可靠性
        if (s.id && key.includes('_')) {
          const parts = key.split('_')
          if (parts.length === 2) {
            // 尝试匹配站点ID和扇区ID的组合
            if (s.id.includes(parts[0]) && s.id.includes(parts[1])) {
              return true
            }
          }
        }

        return false
      })

      if (sector) {
        const oldPCI = sector.syncedPCI
        sector.syncedPCI = newPCI
        sector.isPlannedSector = true
        synced = true
        console.log('[PCIDataSyncService] 成功同步扇区PCI', {
          siteId,
          inputSectorId: sectorId,
          key,
          oldPCI,
          newPCI,
          matchedSectorId: sector.id,
          sectorName: sector.name,
          isPlannedSector: sector.isPlannedSector
        })
      }
    }

    updateSector(this.syncedData.lte)
    updateSector(this.syncedData.nr)

    // 同时更新映射表（用于后续查找）
    if (pciResult) {
      pciResult.newPCI = newPCI
      this.pciResultsMap.set(key, pciResult)
    }

    if (!synced) {
      console.warn('[PCIDataSyncService] 未找到匹配的扇区，同步失败', {
        siteId,
        sectorId,
        key,
        availableLTE: this.syncedData.lte.slice(0, 3).map(s => ({ id: s.id, name: s.name })),
        availableNR: this.syncedData.nr.slice(0, 3).map(s => ({ id: s.id, name: s.name }))
      })
    }

    return synced
  }

  /**
   * 查找同频同PCI的所有扇区（使用规划后的PCI）
   *
   * 查找逻辑：
   * 1. 遍历所有扇区
   * 2. 排除规划结果中的扇区（isPlannedSector === true）
   * 3. 排除当前选中的扇区
   * 4. 使用同步后的PCI（syncedPCI）进行匹配
   *
   * 这样可以正确显示：
   * - 点击规划结果中的小区（规划后PCI=100）
   * - 蓝色高亮显示：全量工参中**未规划**但原本PCI=100的小区
   * - 不会高亮：规划结果中其他被规划为PCI=100的小区
   *
   * @param pci PCI值（规划后的PCI）
   * @param frequency 频点值
   * @param excludeSiteId 排除的站点ID（当前选中的小区）
   * @param excludeSectorId 排除的扇区ID（当前选中的小区）
   * @param networkType 可选，按网络类型过滤（'LTE' 或 'NR'）
   */
  findSameFrequencyPCI(pci: number, frequency: number | null, excludeSiteId?: string, excludeSectorId?: string, networkType?: string): SyncedSectorData[] {
    const syncedData = this.getSyncedData()
    if (!syncedData) {
      console.warn('[PCIDataSyncService] 数据未初始化')
      return []
    }

    // 根据网络类型过滤数据（使用 getSyncedData() 返回的数据，优先临时工参副本）
    let allSectors: SyncedSectorData[]
    if (networkType === 'LTE') {
      allSectors = syncedData.lte
    } else if (networkType === 'NR') {
      allSectors = syncedData.nr
    } else {
      // 未指定网络类型，搜索所有扇区
      allSectors = [...syncedData.lte, ...syncedData.nr]
    }

    const syncedDataForLog = this.getSyncedData()
    console.log('[PCIDataSyncService] 按网络类型过滤查找同频同PCI扇区', {
      networkType,
      totalSectorsToSearch: allSectors.length,
      lteCount: syncedDataForLog?.lte.length || 0,
      nrCount: syncedDataForLog?.nr.length || 0
    })

    // 如果frequency为null，尝试从规划结果中获取
    let effectiveFrequency = frequency
    if (frequency === null && excludeSiteId && excludeSectorId) {
      // sectorId可能是组合格式（如"540951_0"）或纯数字格式（如"0"）
      // 需要统一处理为 siteId_sectorId 格式
      let key: string
      const sectorIdStr = String(excludeSectorId).trim()

      // 如果sectorId已经包含siteId（组合格式），直接使用
      if (sectorIdStr.includes('_') && sectorIdStr.startsWith(String(excludeSiteId))) {
        key = sectorIdStr
      } else {
        // 否则拼接为 siteId_sectorId 格式
        key = this.getSectorKey(excludeSiteId, excludeSectorId)
      }

      const pciResult = this.pciResultsMap.get(key)
      if (pciResult) {
        effectiveFrequency = pciResult.frequency || pciResult.earfcn || pciResult.ssb_frequency || null
        console.log('[PCIDataSyncService] 从规划结果中获取频点', {
          siteId: excludeSiteId,
          sectorId: excludeSectorId,
          key,
          frequency: effectiveFrequency
        })
      }
    }

    // 构建排除扇区的键（用于排除当前选中的扇区）
    let excludeKey: string | null = null
    if (excludeSiteId && excludeSectorId) {
      const sectorIdStr = String(excludeSectorId).trim()
      if (sectorIdStr.includes('_') && sectorIdStr.startsWith(String(excludeSiteId))) {
        excludeKey = sectorIdStr
      } else {
        excludeKey = this.getSectorKey(excludeSiteId, excludeSectorId)
      }
    }

    // 查找所有同频同PCI的扇区（排除当前选中扇区）
    const result = allSectors.filter(sector => {
      // 排除当前选中的扇区（以防万一）
      if (excludeKey) {
        const sectorKey = this.getSectorKey(sector.siteId || '', sector.sectorId || '')
        if (sectorKey === excludeKey || sector.id === excludeKey) {
          return false
        }
      }

      // 使用同步后的PCI进行匹配
      // 注意：对于未规划的小区，syncedPCI 等于原始 pci
      // 这样可以正确匹配：规划后PCI=100 与 全量工参中原本PCI=100的小区
      if (sector.syncedPCI !== pci) {
        return false
      }

      // 如果频点仍然为null，只匹配PCI（记录警告）
      if (effectiveFrequency === null) {
        console.warn('[PCIDataSyncService] 频点为null，只匹配PCI，可能包含非同频扇区', {
          sectorId: sector.id,
          sectorName: sector.name,
          pci: sector.syncedPCI
        })
        return true
      }

      // 匹配频点（支持多种频点字段）
      const sectorFreq = sector.frequency || sector.earfcn || sector.ssbFrequency
      return sectorFreq === effectiveFrequency
    })

    console.log('[PCIDataSyncService] 查找同频同PCI（使用规划后PCI，返回所有同频同PCI扇区）', {
      pci,
      inputFrequency: frequency,
      effectiveFrequency,
      excludeKey,
      count: result.length,
      description: '所有同频同PCI扇区数量（包括规划结果中的扇区）',
      firstFew: result.slice(0, 5).map(s => ({
        id: s.id,
        name: s.name,
        originalPCI: s.pci,
        syncedPCI: s.syncedPCI,
        isPlannedSector: s.isPlannedSector,
        sectorFreq: s.frequency || s.earfcn || s.ssbFrequency,
        pciMatch: s.syncedPCI === pci,
        freqMatch: effectiveFrequency === null ? null : (s.frequency || s.earfcn || s.ssbFrequency) === effectiveFrequency
      }))
    })

    return result
  }

  /**
   * 根据siteId和sectorId查找扇区
   */
  findSector(siteId: string, sectorId: string): SyncedSectorData | null {
    const syncedData = this.getSyncedData()
    if (!syncedData) {
      return null
    }

    // sectorId可能是组合格式（如"540951_0"）或纯数字格式（如"0"）
    // 需要统一处理为 siteId_sectorId 格式
    let key: string
    const sectorIdStr = String(sectorId).trim()

    // 如果sectorId已经包含siteId（组合格式），直接使用
    if (sectorIdStr.includes('_') && sectorIdStr.startsWith(String(siteId))) {
      key = sectorIdStr
    } else {
      // 否则拼接为 siteId_sectorId 格式
      key = this.getSectorKey(siteId, sectorId)
    }

    const allSectors = [...syncedData.lte, ...syncedData.nr]

    return allSectors.find(s => {
      // 尝试多种匹配方式
      const sKey = this.getSectorKey(s.siteId || '', s.sectorId || '')
      if (sKey === key) return true

      // 也尝试直接用id字段匹配
      if (s.id === key) return true

      return false
    }) || null
  }

  /**
   * 获取同步后的数据
   * 优先返回临时工参副本（如果存在），否则返回普通同步数据
   * 临时工参包含规划后的PCI，用于同频同PCI地理化显示
   * 兜底：如果没有临时工参副本但有pciResultsMap，使用syncedData临时更新syncedPCI
   */
  getSyncedData(): {
    lte: SyncedSectorData[]
    nr: SyncedSectorData[]
  } | null {
    // 优先返回临时工参副本
    if (this.pciTempData) {
      return this.pciTempData
    }

    // 兜底：如果没有临时工参，但有pciResultsMap，就使用syncedData并临时更新syncedPCI
    if (this.syncedData && this.pciResultsMap.size > 0) {
      console.log('[PCIDataSyncService] 未找到pciTempData，使用syncedData并临时更新syncedPCI', {
        pciResultsCount: this.pciResultsMap.size,
        lteCount: this.syncedData.lte.length,
        nrCount: this.syncedData.nr.length
      })

      // 创建syncedData的副本，并根据pciResultsMap更新syncedPCI
      const tempLTE = JSON.parse(JSON.stringify(this.syncedData.lte)).map((s: any) => ({ ...s }))
      const tempNR = JSON.parse(JSON.stringify(this.syncedData.nr)).map((s: any) => ({ ...s }))

      // 应用规划后的PCI
      let appliedCount = 0
      for (const [key, pciResult] of this.pciResultsMap) {
        let found = false

        // 在LTE数据中查找
        for (const sector of tempLTE) {
          const sKey = this.getSectorKey(sector.siteId || '', sector.sectorId || '')
          if (sKey === key || sector.id === key) {
            sector.syncedPCI = pciResult.newPCI
            sector.isPlannedSector = true
            found = true
            appliedCount++
            break
          }
        }

        // 在NR数据中查找
        if (!found) {
          for (const sector of tempNR) {
            const sKey = this.getSectorKey(sector.siteId || '', sector.sectorId || '')
            if (sKey === key || sector.id === key) {
              sector.syncedPCI = pciResult.newPCI
              sector.isPlannedSector = true
              found = true
              appliedCount++
              break
            }
          }
        }
      }

      console.log('[PCIDataSyncService] 兜底更新完成', {
        appliedCount,
        totalResults: this.pciResultsMap.size
      })

      return { lte: tempLTE, nr: tempNR }
    }

    return this.syncedData
  }

  /**
   * 获取更新后的完整PCI数据，供扇区图层使用
   * 确保返回的数据中每个扇区都使用同步后的PCI值
   * 优先使用临时工参副本（如果存在），否则使用普通同步数据
   */
  getUpdatedPCIData(): {
    lte: RenderSectorData[]
    nr: RenderSectorData[]
  } | null {
    const syncedData = this.getSyncedData()
    if (!syncedData) {
      console.warn('[PCIDataSyncService] 数据未初始化，无法获取更新后的PCI数据')
      return null
    }

    console.log('[PCIDataSyncService] 获取更新后的完整PCI数据（使用临时工参副本：' + !!this.pciTempData + '）')

    // 转换同步后的数据，确保每个扇区都使用同步后的PCI值
    const updatedLTE = syncedData.lte.map(sector => ({
      ...sector,
      // 关键：对于规划扇区，pci字段应设置为syncedPCI（规划后的新PCI）
      // 对于未规划扇区，syncedPCI等于原始pci，所以直接使用syncedPCI即可
      pci: (sector as SyncedSectorData).syncedPCI !== undefined ? (sector as SyncedSectorData).syncedPCI : sector.pci
    }))

    const updatedNR = syncedData.nr.map(sector => ({
      ...sector,
      pci: (sector as SyncedSectorData).syncedPCI !== undefined ? (sector as SyncedSectorData).syncedPCI : sector.pci
    }))

    // 验证数据一致性（仅当使用临时工参副本时验证）
    if (this.pciTempData) {
      this.verifyUpdatedPCIData(updatedLTE, updatedNR)
    }

    return {
      lte: updatedLTE,
      nr: updatedNR
    }
  }

  /**
   * 验证更新后的PCI数据一致性
   */
  private verifyUpdatedPCIData(lteData: RenderSectorData[], nrData: RenderSectorData[]): void {
    // 统计规划扇区数量
    const plannedSectors = [
      ...lteData.filter((s: any) => s.isPlannedSector),
      ...nrData.filter((s: any) => s.isPlannedSector)
    ]

    // 验证规划扇区的pci字段是否等于syncedPCI
    let mismatchCount = 0
    const mismatches: Array<{
      id: string
      name: string
      pci?: number
      syncedPCI?: number
    }> = []

    for (const sector of plannedSectors) {
      const syncedPCI = (sector as any).syncedPCI
      if (syncedPCI !== undefined && sector.pci !== syncedPCI) {
        mismatchCount++
        mismatches.push({
          id: sector.id,
          name: sector.name,
          pci: sector.pci,
          syncedPCI
        })
      }
    }

    console.log('[PCIDataSyncService] 验证更新后的PCI数据', {
      lteCount: lteData.length,
      nrCount: nrData.length,
      plannedSectorsCount: plannedSectors.length,
      mismatchCount,
      mismatches: mismatches.slice(0, 5),
      // 显示前5个规划扇区的详细信息
      plannedSample: lteData.concat(nrData)
        .filter((s: any) => s.isPlannedSector)
        .slice(0, 5)
        .map(s => ({
          id: s.id,
          name: s.name,
          originalPCI: (s as any).pci,
          syncedPCI: (s as any).syncedPCI,
          isPlannedSector: (s as any).isPlannedSector,
          finalPCI: s.pci
        }))
    })

    if (mismatchCount > 0) {
      console.error('[PCIDataSyncService] 发现PCI数据不一致！规划扇区的pci字段未正确设置为syncedPCI', {
        mismatchCount,
        mismatches
      })
    }
  }

  /**
   * 清除所有同步数据
   */
  clear(): void {
    this.fullParamsData = null
    this.syncedData = null
    this.pciResultsMap.clear()
    console.log('[PCIDataSyncService] 数据已清除')
  }

  /**
   * 生成扇区唯一标识
   */
  private getSectorKey(siteId: string, sectorId: string): string {
    return `${siteId}_${sectorId}`
  }
}

// 单例导出
export const pciDataSyncService = new PCIDataSyncService()
