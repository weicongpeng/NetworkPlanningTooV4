/**
 * TAC数据同步服务
 *
 * 负责管理TAC核查结果，并提供查找功能。
 * 支持按TAC值查找小区，以及查找指定扇区。
 */

import { mapDataService, RenderSectorData } from './mapDataService'
import type { CellTACResult, TACSingularityDetails } from '@shared/types'

/**
 * 同步后的扇区数据（扩展RenderSectorData）
 */
interface SyncedSectorData extends RenderSectorData {
  /** 同步后的TAC（可能来自核查结果） */
  syncedTAC?: string
  /** 是否是插花小区 */
  isSingularity?: boolean
  /** 插花详情 */
  singularityDetails?: TACSingularityDetails
}

/**
 * TAC核查结果
 */
interface TACCheckResult {
  results: CellTACResult[]
  singularityCount?: number
}

/**
 * TAC数据同步服务类
 */
export class TACDataSyncService {
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

  /** TAC核查结果映射表 */
  private tacResultsMap = new Map<string, CellTACResult>()

  /** 插花小区映射表 */
  private singularityMap = new Map<string, TACSingularityDetails>()

  /**
   * 初始化同步服务，加载全量工参数据
   */
  async initialize(): Promise<void> {
    try {
      // 从mapDataService获取全量工参数据（使用缓存，避免重复后端请求）
      const mapData = await mapDataService.getMapData()

      // 检查是否有数据
      if (!mapData.lteSectors.length && !mapData.nrSectors.length) {
        console.warn('[TACDataSyncService] 未找到全量工参数据，初始化为空数据')
        this.fullParamsData = { lte: [], nr: [] }
        this.syncedData = { lte: [], nr: [] }
        return
      }

      // 保存原始数据
      this.fullParamsData = {
        lte: mapData.lteSectors,
        nr: mapData.nrSectors,
      }

      // 初始化同步数据
      this.syncedData = {
        lte: this.fullParamsData.lte.map(s => ({ ...s, isPlannedSector: false })),
        nr: this.fullParamsData.nr.map(s => ({ ...s, isPlannedSector: false })),
      }

      console.log('[TACDataSyncService] 初始化完成', {
        lte: this.syncedData.lte.length,
        nr: this.syncedData.nr.length,
      })
    } catch (error) {
      console.error('[TACDataSyncService] 初始化失败:', error)
      this.fullParamsData = { lte: [], nr: [] }
      this.syncedData = { lte: [], nr: [] }
      throw error
    }
  }

  /**
   * 设置TAC核查结果
   */
  setTACResults(result: TACCheckResult): void {
    if (!this.syncedData) {
      console.warn('[TACDataSyncService] 数据未初始化，无法设置TAC结果')
      return
    }

    console.log('[TACDataSyncService] 设置TAC核查结果', {
      results: result.results.length,
      singularityCount: result.singularityCount,
    })

    // 构建TAC结果映射表
    this.tacResultsMap.clear()
    this.singularityMap.clear()

    for (const cellResult of result.results) {
      const key = `${cellResult.siteId}_${cellResult.sectorId}`
      this.tacResultsMap.set(key, cellResult)

      // 如果是插花小区，记录插花详情
      if (cellResult.isSingularity && cellResult.singularityDetails) {
        this.singularityMap.set(key, cellResult.singularityDetails)
      }
    }

    // 同步TAC值到全量工参数据
    for (const networkType of ['lte', 'nr'] as const) {
      for (const sector of this.syncedData[networkType]) {
        const key = `${sector.siteId}_${sector.id}`
        const tacResult = this.tacResultsMap.get(key)

        if (tacResult) {
          sector.syncedTAC = tacResult.tac || undefined
          sector.isSingularity = tacResult.isSingularity
          sector.singularityDetails = tacResult.singularityDetails
        }
      }
    }

    console.log('[TACDataSyncService] TAC核查结果已同步', {
      syncedTAC: this.tacResultsMap.size,
      singularity: this.singularityMap.size,
    })
  }

  /**
   * 查找指定扇区
   */
  findSector(siteId: string, sectorId: string): SyncedSectorData | null {
    if (!this.syncedData) return null

    const key = `${siteId}_${sectorId}`

    // 先从LTE中查找
    const lteSector = this.syncedData.lte.find(s => s.id === key || `${s.siteId}_${s.sectorId}` === key)
    if (lteSector) return lteSector

    // 再从NR中查找
    const nrSector = this.syncedData.nr.find(s => s.id === key || `${s.siteId}_${s.sectorId}` === key)
    if (nrSector) return nrSector

    return null
  }

  /**
   * 查找指定TAC的所有小区
   */
  findSectorsByTAC(tac: string, networkType?: 'LTE' | 'NR'): SyncedSectorData[] {
    if (!this.syncedData) return []

    const networks: Array<'lte' | 'nr'> = networkType === 'LTE' ? ['lte'] : networkType === 'NR' ? ['nr'] : ['lte', 'nr']

    const results: SyncedSectorData[] = []

    for (const nt of networks) {
      for (const sector of this.syncedData[nt]) {
        if (sector.syncedTAC === tac || String(sector.tac || '') === tac) {
          results.push(sector)
        }
      }
    }

    return results
  }

  /**
   * 查找周边主流TAC的小区
   */
  findDominantTAC(dominantTac: string, networkType?: 'LTE' | 'NR'): SyncedSectorData[] {
    return this.findSectorsByTAC(dominantTac, networkType)
  }

  /**
   * 获取同步后的数据
   */
  getSyncedData(): { lte: SyncedSectorData[]; nr: SyncedSectorData[] } | null {
    return this.syncedData
  }

  /**
   * 清除所有数据
   */
  clear(): void {
    this.fullParamsData = null
    this.syncedData = null
    this.tacResultsMap.clear()
    this.singularityMap.clear()
    console.log('[TACDataSyncService] 数据已清除')
  }
}

// 单例实例
export const tacDataSyncService = new TACDataSyncService()
