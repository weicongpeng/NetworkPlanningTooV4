/**
 * 邻区数据同步服务
 *
 * 负责将邻区规划结果中的扇区信息同步到全量工参数据，
 * 并提供源小区-目标小区关系查询功能。
 *
 * 数据流程：
 * 1. 从mapDataService获取全量工参数据
 * 2. 根据邻区规划结果提取涉及的扇区
 * 3. 提供源小区->目标小区关系查询
 */

import { mapDataService, RenderSectorData } from './mapDataService'

/**
 * 邻区关系记录
 */
interface NeighborRelation {
  sourceSiteId: string
  sourceCellId: string
  sourceCellName: string
  sourceFrequency: number | null
  sourcePci: number | null
  targetSiteId: string
  targetCellId: string
  targetCellName: string
  targetFrequency: number | null
  targetPci: number | null
  distance: number
  relationType: string
}

/**
 * 扇区标识（用于匹配）
 */
interface SectorIdentifier {
  siteId: string
  cellId: string
  cellName?: string
}

/**
 * 邻区规划结果
 */
interface NeighborPlanningResult {
  results: NeighborRelation[]
}

/**
 * 同步后的扇区数据（扩展RenderSectorData）
 */
interface SyncedSectorData extends RenderSectorData {
  /** 是否在邻区规划结果中 */
  isInNeighborResult: boolean
  /** 角色：source-源小区, target-目标小区, both-两者都是, null-不在结果中 */
  neighborRole: 'source' | 'target' | 'both' | null
}

/**
 * 源小区的邻区关系
 */
interface SourceNeighborRelations {
  sourceSiteId: string
  sourceCellId: string
  sourceCellName: string
  sourceFrequency: number | null
  sourcePci: number | null
  sourceKey: string
  targets: Array<{
    targetSiteId: string
    targetCellId: string
    targetCellName: string
    targetFrequency: number | null
    targetPci: number | null
    targetKey: string
    distance: number
  }>
}

/**
 * 邻区数据同步服务类
 */
export class NeighborDataSyncService {
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

  /** 邻区关系列表 */
  private neighborRelations: NeighborRelation[] = []

  /** 源小区->目标小区映射 */
  private sourceToTargetsMap = new Map<string, SourceNeighborRelations>()

  /** 已加载的网络类型标记 */
  private loadedNetworkTypes: {
    lte: boolean
    nr: boolean
  } = { lte: false, nr: false }

  /**
   * 初始化同步服务，加载全量工参数据
   */
  async initialize(): Promise<void> {
    try {
      // 从mapDataService获取全量工参数据
      const mapData = await mapDataService.getMapData()

      // 创建数据副本（深拷贝）
      this.fullParamsData = {
        lte: JSON.parse(JSON.stringify(mapData.lteSectors)),
        nr: JSON.parse(JSON.stringify(mapData.nrSectors))
      }

      // 初始化同步数据
      this.syncedData = {
        lte: this.fullParamsData.lte.map(s => ({
          ...s,
          isInNeighborResult: false,
          neighborRole: null
        })),
        nr: this.fullParamsData.nr.map(s => ({
          ...s,
          isInNeighborResult: false,
          neighborRole: null
        }))
      }

      console.log('[NeighborDataSyncService] 初始化完成', {
        lte: this.syncedData.lte.length,
        nr: this.syncedData.nr.length
      })
    } catch (error) {
      console.error('[NeighborDataSyncService] 初始化失败:', error)
      throw error
    }
  }

  /**
   * 设置全量工参数据（用于邻区规划模式初始化）
   */
  setFullParamsData(data: {
    lte: RenderSectorData[]
    nr: RenderSectorData[]
  }): void {
    // 创建数据副本（深拷贝）
    this.fullParamsData = {
      lte: JSON.parse(JSON.stringify(data.lte)),
      nr: JSON.parse(JSON.stringify(data.nr))
    }

    // 初始化同步数据
    this.syncedData = {
      lte: this.fullParamsData.lte.map(s => ({
        ...s,
        isInNeighborResult: false,
        neighborRole: null
      })),
      nr: this.fullParamsData.nr.map(s => ({
        ...s,
        isInNeighborResult: false,
        neighborRole: null
      }))
    }

    console.log('[NeighborDataSyncService] 全量工参数据已设置', {
      lte: this.fullParamsData.lte.length,
      nr: this.fullParamsData.nr.length
    })
  }

  /**
   * 获取全量工参数据（用于邻区规划模式地图渲染）
   */
  getFullParamsData(): {
    lte: SyncedSectorData[]
    nr: SyncedSectorData[]
  } | null {
    return this.syncedData
  }

  /**
   * 设置邻区规划结果
   */
  setNeighborResults(results: NeighborPlanningResult): void {
    this.neighborRelations = results.results || []
    console.log('[NeighborDataSyncService] 邻区规划结果已加载', {
      count: this.neighborRelations.length,
      sampleData: this.neighborRelations.slice(0, 3).map(r => ({
        sourceSiteId: r.sourceSiteId,
        sourceCellId: r.sourceCellId,
        sourceSiteIdType: typeof r.sourceSiteId,
        sourceCellIdType: typeof r.sourceCellId,
        targetSiteId: r.targetSiteId,
        targetCellId: r.targetCellId
      }))
    })

    // 记录当前全量数据样本
    if (this.fullParamsData) {
      const allSectors = [...this.fullParamsData.lte, ...this.fullParamsData.nr]
      console.log('[NeighborDataSyncService] 全量工参数据样本', {
        totalLte: this.fullParamsData.lte.length,
        totalNr: this.fullParamsData.nr.length,
        sampleSectors: allSectors.slice(0, 5).map(s => ({
          id: s.id,
          siteId: s.siteId,
          siteIdType: typeof s.siteId,
          sectorId: s.sectorId,
          sectorIdType: typeof s.sectorId,
          name: s.name
        }))
      })
    }

    // 重新同步数据
    this.resyncData()
  }

  /**
   * 重新同步所有数据
   */
  private resyncData(): void {
    console.log('[NeighborDataSyncService] resyncData 调用', {
      hasSyncedData: !!this.syncedData,
      hasFullParamsData: !!this.fullParamsData,
      syncedDataLteLength: this.syncedData?.lte.length,
      syncedDataNrLength: this.syncedData?.nr.length,
      fullParamsLteLength: this.fullParamsData?.lte.length,
      fullParamsNrLength: this.fullParamsData?.nr.length
    })

    if (!this.syncedData || !this.fullParamsData) {
      console.log('[NeighborDataSyncService] resyncData 提前返回：数据未就绪')
      return
    }

    // 重置同步数据
    this.syncedData.lte = this.fullParamsData.lte.map(s => ({
      ...s,
      isInNeighborResult: false,
      neighborRole: null
    }))
    this.syncedData.nr = this.fullParamsData.nr.map(s => ({
      ...s,
      isInNeighborResult: false,
      neighborRole: null
    }))

    // 清空源小区->目标小区映射
    this.sourceToTargetsMap.clear()

    // 构建扇区快速查找映射（优化性能）
    const sectorMap = new Map<string, RenderSectorData>()
    const allSectors = [...this.fullParamsData.lte, ...this.fullParamsData.nr]
    for (const sector of allSectors) {
      sectorMap.set(sector.id, sector)
      // 同时添加 siteId_sectorId 作为键
      if (sector.siteId && sector.sectorId) {
        const key = `${String(sector.siteId).trim()}_${String(sector.sectorId).trim()}`
        sectorMap.set(key, sector)
      }
    }
    
    console.log('[NeighborDataSyncService] 构建扇区快速查找映射完成', {
      totalSectors: sectorMap.size
    })

    // 构建扇区角色映射
    const sectorRoles = new Map<string, 'source' | 'target' | 'both'>()

    console.log('[NeighborDataSyncService] 开始构建扇区角色映射', {
      totalRelations: this.neighborRelations.length,
      totalLteSectors: this.fullParamsData.lte.length,
      totalNrSectors: this.fullParamsData.nr.length
    })

    let matchedSources = 0
    let matchedTargets = 0

    for (const relation of this.neighborRelations) {
      // 处理源小区 - 使用快速查找
      const sourceKey = `${String(relation.sourceSiteId).trim()}_${String(relation.sourceCellId).trim()}`
      const sourceMatch = sectorMap.get(sourceKey)
      if (sourceMatch) {
        matchedSources++
        // 使用扇区的实际id
        const sourceKey = sourceMatch.id
        const currentSourceRole = sectorRoles.get(sourceKey) || 'source'
        sectorRoles.set(sourceKey, currentSourceRole === 'target' ? 'both' : 'source')

        // 构建源小区->目标小区映射
        if (!this.sourceToTargetsMap.has(sourceKey)) {
          this.sourceToTargetsMap.set(sourceKey, {
            sourceSiteId: sourceMatch.siteId || relation.sourceSiteId,
            sourceCellId: sourceMatch.sectorId || relation.sourceCellId,
            sourceCellName: sourceMatch.name || relation.sourceCellName,
            sourceFrequency: sourceMatch.frequency || sourceMatch.earfcn || sourceMatch.ssbFrequency || relation.sourceFrequency,
            sourcePci: sourceMatch.pci || relation.sourcePci,
            sourceKey,
            targets: []
          })
        }
      }

      // 处理目标小区
      const targetKey = `${String(relation.targetSiteId).trim()}_${String(relation.targetCellId).trim()}`
      const targetMatch = sectorMap.get(targetKey)
      if (targetMatch) {
        matchedTargets++
        // 使用扇区的实际id
        const targetKey = targetMatch.id
        const currentTargetRole = sectorRoles.get(targetKey) || 'target'
        sectorRoles.set(targetKey, currentTargetRole === 'source' ? 'both' : 'target')

        // 添加到源小区的目标列表
        if (sourceMatch) {
          const sourceKey = sourceMatch.id
          const sourceEntry = this.sourceToTargetsMap.get(sourceKey)
          if (sourceEntry) {
            sourceEntry.targets.push({
              targetSiteId: targetMatch.siteId || relation.targetSiteId,
              targetCellId: targetMatch.sectorId || relation.targetCellId,
              targetCellName: targetMatch.name || relation.targetCellName,
              targetFrequency: targetMatch.frequency || targetMatch.earfcn || targetMatch.ssbFrequency || relation.targetFrequency,
              targetPci: targetMatch.pci || relation.targetPci,
              targetKey,
              distance: relation.distance
            })
          }
        }
      }
    }

    console.log('[NeighborDataSyncService] 扇区角色映射构建完成', {
      matchedSources,
      matchedTargets,
      totalSectorRoles: sectorRoles.size
    })

    // 应用角色到同步数据
    const updateSectorRole = (sectors: SyncedSectorData[]) => {
      let matched = 0
      for (const sector of sectors) {
        const role = sectorRoles.get(sector.id)
        if (role) {
          sector.neighborRole = role
          sector.isInNeighborResult = true
          matched++
        }
      }

      console.log('[NeighborDataSyncService] updateSectorRole 完成', {
        totalSectors: sectors.length,
        matched,
        unmatched: sectors.length - matched
      })
    }

    updateSectorRole(this.syncedData.lte)
    updateSectorRole(this.syncedData.nr)

    console.log('[NeighborDataSyncService] 数据同步完成', {
      totalSectors: (this.syncedData.lte.length + this.syncedData.nr.length),
      involvedSectors: sectorRoles.size,
      sources: this.sourceToTargetsMap.size
    })
  }

  /**
   * 在数据中查找扇区（支持多种字段名匹配和类型转换）
   */
  private findSectorInData(siteId: string, cellId: string): RenderSectorData | null {
    const allSectors = [...this.fullParamsData!.lte, ...this.fullParamsData!.nr]

    // 标准化输入（转换为字符串，去除首尾空格）
    const normalizedSiteId = String(siteId).trim()
    const normalizedCellId = String(cellId).trim()

    const found = allSectors.find(s => {
      // 标准化扇区字段
      const sectorSiteId = s.siteId !== undefined ? String(s.siteId).trim() : ''
      const sectorSectorId = s.sectorId !== undefined ? String(s.sectorId).trim() : ''

      // 1. 精确匹配扇区ID (格式: siteId_cellId)
      const expectedId = `${normalizedSiteId}_${normalizedCellId}`
      if (s.id === expectedId) {
        console.log('[NeighborDataSyncService] 通过ID匹配', { expectedId, sectorId: s.id })
        return true
      }

      // 2. siteId + sectorId 匹配（都使用字符串比较）
      if (sectorSiteId === normalizedSiteId && sectorSectorId === normalizedCellId) {
        console.log('[NeighborDataSyncService] 通过siteId+sectorId匹配', {
          normalized: `${normalizedSiteId}_${normalizedCellId}`,
          actual: `${sectorSiteId}_${sectorSectorId}`
        })
        return true
      }

      // 3. 尝试其他字段（cellId, localCellId）
      const sectorCellId = (s as any).cellId !== undefined ? String((s as any).cellId).trim() : ''
      if (sectorCellId && sectorSiteId === normalizedSiteId && sectorCellId === normalizedCellId) {
        console.log('[NeighborDataSyncService] 通过siteId+cellId匹配')
        return true
      }

      const sectorLocalCellId = (s as any).localCellId !== undefined ? String((s as any).localCellId).trim() : ''
      if (sectorLocalCellId && sectorSiteId === normalizedSiteId && sectorLocalCellId === normalizedCellId) {
        console.log('[NeighborDataSyncService] 通过siteId+localCellId匹配')
        return true
      }

      return false
    })

    if (!found) {
      console.warn('[NeighborDataSyncService] 未找到匹配扇区', {
        search: `${normalizedSiteId}_${normalizedCellId}`,
        inputTypes: { siteId: typeof siteId, cellId: typeof cellId },
        searchValues: { normalizedSiteId, normalizedCellId },
        totalSectors: allSectors.length
      })
    }

    return found || null
  }

  /**
   * 根据源小区查找目标小区列表
   */
  findTargetsBySource(sourceSiteId: string, sourceCellId: string): SourceNeighborRelations | null {
    // 使用下划线分隔，与sector.id格式一致
    const key = `${sourceSiteId}_${sourceCellId}`
    return this.sourceToTargetsMap.get(key) || null
  }

  /**
   * 根据siteId和sectorId查找扇区
   */
  findSector(siteId: string, sectorId: string): SyncedSectorData | null {
    if (!this.syncedData) {
      return null
    }

    const key = `${siteId}-${sectorId}`
    const allSectors = [...this.syncedData.lte, ...this.syncedData.nr]

    return allSectors.find(s => {
      // 尝试多种匹配方式
      // 1. siteId + sectorId
      if (s.siteId === siteId && s.sectorId === sectorId) {
        return true
      }
      // 2. siteId + cellId
      if ('cellId' in s && s.siteId === siteId && (s as any).cellId === sectorId) {
        return true
      }
      // 3. siteId + localCellId
      if ('localCellId' in s && s.siteId === siteId && (s as any).localCellId === sectorId) {
        return true
      }
      // 4. siteId + id
      if ('id' in s && s.siteId === siteId && (s as any).id === sectorId) {
        return true
      }
      // 5. 也尝试直接用id字段匹配
      if (s.id === key) return true

      return false
    }) || null
  }

  /**
   * 获取同步后的数据
   */
  getSyncedData(): {
    lte: SyncedSectorData[]
    nr: SyncedSectorData[]
  } | null {
    return this.syncedData
  }

  /**
   * 获取所有源小区列表
   */
  getAllSources(): SourceNeighborRelations[] {
    return Array.from(this.sourceToTargetsMap.values())
  }

  /**
   * 获取邻区规划结果中涉及的所有扇区（用于地图渲染）
   */
  getInvolvedSectors(): {
    lte: SyncedSectorData[]
    nr: SyncedSectorData[]
  } | null {
    if (!this.syncedData) {
      console.log('[NeighborDataSyncService] getInvolvedSectors: syncedData is null')
      return null
    }

    // 只返回在邻区规划结果中的扇区
    const lteSectors = this.syncedData.lte.filter(s => s.isInNeighborResult)
    const nrSectors = this.syncedData.nr.filter(s => s.isInNeighborResult)

    console.log('[NeighborDataSyncService] getInvolvedSectors 调用', {
      totalLte: this.syncedData.lte.length,
      totalNr: this.syncedData.nr.length,
      lteWithFlag: lteSectors.length,
      nrWithFlag: nrSectors.length,
      sampleLteFlags: this.syncedData.lte.slice(0, 5).map(s => ({ id: s.id, flag: s.isInNeighborResult })),
      sampleNrFlags: this.syncedData.nr.slice(0, 5).map(s => ({ id: s.id, flag: s.isInNeighborResult }))
    })

    return {
      lte: lteSectors,
      nr: nrSectors
    }
  }

  /**
   * 设置已加载的网络类型标记
   */
  setLoadedNetworkTypes(types: { lte: boolean; nr: boolean }): void {
    this.loadedNetworkTypes = types
    console.log('[NeighborDataSyncService] 已加载网络类型标记', types)
  }

  /**
   * 获取已加载的网络类型标记
   */
  getLoadedNetworkTypes(): { lte: boolean; nr: boolean } {
    return this.loadedNetworkTypes
  }

  /**
   * 清除所有同步数据
   */
  clear(): void {
    this.fullParamsData = null
    this.syncedData = null
    this.neighborRelations = []
    this.sourceToTargetsMap.clear()
    this.loadedNetworkTypes = { lte: false, nr: false }
    console.log('[NeighborDataSyncService] 数据已清除')
  }
}

// 单例导出
export const neighborDataSyncService = new NeighborDataSyncService()
