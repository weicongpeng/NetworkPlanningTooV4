/**
 * 地图数据服务
 *
 * 负责：
 * - 从后端获取最新全量工参数据
 * - 过滤无效数据（缺失经纬度、方位角等）
 * - 坐标系转换 (WGS84 → GCJ02)
 * - 按网络类型分类 (LTE/NR)
 * - 应用LOD策略筛选数据
 * - 使用 IndexedDB 持久化缓存
 */

import { mapApi } from './api'
import { CoordinateTransformer } from '../utils/coordinate'
import { SECTOR_VALIDATION, getLODLevel } from '../config/sector-config'
import { indexedDBService } from './indexedDBService'

const CACHE_KEY = 'map_data_cache'
const CACHE_TTL = 10 * 60 * 1000 // 10分钟缓存

/**
 * 扇区数据接口
 */
export interface SectorData {
  id: string
  name: string
  latitude: number
  longitude: number
  azimuth: number
  beamwidth: number
  pci?: number
  tac?: number
  frequency?: number
  height?: number
  siteId?: string
  sectorId?: string
  networkType: 'LTE' | 'NR'
  earfcn?: number
  ssbFrequency?: number
  cell_cover_type?: number  // 小区覆盖类型: 1=室外小区(扇形60m/40度), 4=室内小区(圆形30m)
  mcc?: string  // 移动国家码
  mnc?: string  // 移动网络码
  is_shared?: string  // 是否共享
  attributes?: Record<string, string>  // 撒点文件的额外属性（用于标签显示）
}

/**
 * 扇区渲染数据（已转换坐标）
 */
export interface RenderSectorData extends SectorData {
  /** GCJ02坐标（用于显示） */
  displayLat: number
  displayLng: number
  /** WGS84坐标（原始数据） */
  originalLat: number
  originalLng: number
}

/**
 * 地图数据响应
 */
export interface MapDataResponse {
  lteSectors: RenderSectorData[]
  nrSectors: RenderSectorData[]
  center: {
    latitude: number
    longitude: number
  }
  bounds: {
    north: number
    south: number
    east: number
    west: number
  }
}

/**
 * 数据验证结果
 */
export interface ValidationResult {
  valid: SectorData[]
  invalid: Array<{ data: SectorData; reason: string }>
  stats: {
    total: number
    validCount: number
    invalidCount: number
    missingLat: number
    missingLng: number
    missingAzimuth: number
    outOfRange: number
  }
}

/**
 * 地图数据服务类
 */
export class MapDataService {
  private cachedData: MapDataResponse | null = null
  private cacheExpiry: number = 0
  private readonly CACHE_DURATION = 60000 // 1分钟缓存

  /**
   * 验证扇区数据有效性
   *
   * 过滤条件：
   * - 必须有经纬度
   * - 必须有方位角
   * - 经纬度在有效范围内
   * - 方位角在有效范围内 (0-360)
   */
  private validateSectors(sectors: SectorData[]): ValidationResult {
    const valid: SectorData[] = []
    const invalid: Array<{ data: SectorData; reason: string }> = []
    const stats = {
      total: sectors.length,
      validCount: 0,
      invalidCount: 0,
      missingLat: 0,
      missingLng: 0,
      missingAzimuth: 0,
      outOfRange: 0
    }

    for (const sector of sectors) {
      let isValid = true
      let reason = ''

      // 检查纬度
      if (sector.latitude === null || sector.latitude === undefined || isNaN(sector.latitude)) {
        isValid = false
        reason = '缺失纬度'
        stats.missingLat++
      } else if (sector.latitude < SECTOR_VALIDATION.latitudeRange.min || sector.latitude > SECTOR_VALIDATION.latitudeRange.max) {
        isValid = false
        reason = `纬度超出范围: ${sector.latitude}`
        stats.outOfRange++
      }

      // 检查经度
      if (sector.longitude === null || sector.longitude === undefined || isNaN(sector.longitude)) {
        isValid = false
        if (!reason) reason = '缺失经度'
        stats.missingLng++
      } else if (sector.longitude < SECTOR_VALIDATION.longitudeRange.min || sector.longitude > SECTOR_VALIDATION.longitudeRange.max) {
        isValid = false
        if (!reason) reason = `经度超出范围: ${sector.longitude}`
        stats.outOfRange++
      }

      // 检查方位角
      if (sector.azimuth === null || sector.azimuth === undefined || isNaN(sector.azimuth)) {
        isValid = false
        if (!reason) reason = '缺失方位角'
        stats.missingAzimuth++
      } else if (sector.azimuth < SECTOR_VALIDATION.azimuthRange.min || sector.azimuth > SECTOR_VALIDATION.azimuthRange.max) {
        isValid = false
        if (!reason) reason = `方位角超出范围: ${sector.azimuth}`
        stats.outOfRange++
      }

      if (isValid) {
        valid.push(sector)
        stats.validCount++
      } else {
        invalid.push({ data: sector, reason })
        stats.invalidCount++
      }
    }

    return { valid, invalid, stats }
  }

  /**
   * 将WGS84坐标转换为GCJ02坐标
   */
  private transformCoordinates(sectors: SectorData[]): RenderSectorData[] {
    return sectors.map(sector => {
      const [displayLat, displayLng] = CoordinateTransformer.wgs84ToGcj02(
        sector.latitude,
        sector.longitude
      )

      return {
        ...sector,
        displayLat,
        displayLng,
        originalLat: sector.latitude,
        originalLng: sector.longitude
      }
    })
  }

  /**
   * 按网络类型分类扇区
   */
  private classifyByNetworkType(sectors: RenderSectorData[]): {
    lte: RenderSectorData[]
    nr: RenderSectorData[]
  } {
    const lte: RenderSectorData[] = []
    const nr: RenderSectorData[] = []

    for (const sector of sectors) {
      if (sector.networkType === 'LTE') {
        lte.push(sector)
      } else if (sector.networkType === 'NR') {
        nr.push(sector)
      }
    }

    return { lte, nr }
  }

  /**
   * 应用LOD策略筛选数据
   *
   * 修复：移除 maxSectors 限制，依赖 Leaflet 的视口剔除优化
   * SectorRendererSVG 已实现高效的视口剔除逻辑 (lines 116-129)
   * 视口外的扇区不会被渲染，保证性能
   *
   * 仅在极低缩放级别（< 10）应用采样优化，避免 DOM 元素过多
   */
  private applyLOD(sectors: RenderSectorData[], zoom: number): RenderSectorData[] {
    // 极低缩放级别时，限制返回数量以避免性能问题
    if (zoom < 10 && sectors.length > 5000) {
      // 使用数组截取而非随机抽样，保证数据一致性
      return sectors.slice(0, 5000)
    }

    // 其他情况返回全部扇区，依赖 SectorRendererSVG 的视口剔除优化
    return sectors
  }

  /**
   * 从站点数据中提取扇区数据
   *
   * 后端返回的数据结构：
   * {
   *   sites: [
   *     {
   *       id, name, latitude, longitude, networkType,
   *       sectors: [
   *         { id, siteId, name, azimuth, beamwidth, ... }
   *       ]
   *     }
   *   ]
   * }
   *
   * 去重规则：
   * - LTE: 使用 eNodeB标识(siteId) + 小区标识(sector.id) 作为唯一键
   * - NR: 使用 gNodeB标识(siteId) + 小区标识(sector.id) 作为唯一键
   * - 使用物理点（站点坐标）渲染扇区
   */
  private extractSectorsFromSites(sites: any[]): SectorData[] {
    const sectors: SectorData[] = []
    const dedupSet = new Set<string>() // 用于去重
    const coverTypeStats = { type1: 0, type4: 0, other: 0 }
    const coordSourceStats = { sectorCoords: 0, siteCoords: 0 }  // 坐标来源统计

    for (const site of sites) {
      if (!site.sectors || !Array.isArray(site.sectors)) {
        continue
      }

      const siteId = site.id || site.siteId || `unknown_site_${Math.random().toString(36).substr(2, 9)}`

      for (const sector of site.sectors) {
        // 提取小区标识
        const cellId = sector.id || sector.cellId || sector.localCellId || sector.sectorId

        // LTE: eNodeB标识 + 小区标识
        // NR: gNodeB标识 + 小区标识
        const uniqueKey = `${siteId}_${cellId}`

        // 去重检查
        if (dedupSet.has(uniqueKey)) {
          continue
        }
        dedupSet.add(uniqueKey)

        // 获取小区覆盖类型，默认为室外小区(1)
        const cellCoverType = sector.cell_cover_type ?? 1

        // 统计覆盖类型
        if (cellCoverType === 1) coverTypeStats.type1++
        else if (cellCoverType === 4) coverTypeStats.type4++
        else coverTypeStats.other++

        // 优先使用扇区独立坐标，回退到站点坐标
        // 这样可以正确处理不同扇区有不同物理位置的情况
        const sectorLat = sector.latitude ?? site.latitude
        const sectorLng = sector.longitude ?? site.longitude

        // 记录坐标来源（用于调试）
        const coordSource = sector.latitude ? 'sector' : 'site'

        sectors.push({
          id: uniqueKey,
          name: sector.name || site.name || `${siteId}_${cellId}`,
          latitude: sectorLat,
          longitude: sectorLng,
          azimuth: sector.azimuth || 0,
          beamwidth: sector.beamwidth || 65,
          pci: sector.pci,
          tac: sector.tac,
          frequency: sector.frequency || sector.earfcn || sector.earfcnDL,
          height: sector.height || site.height,
          siteId: siteId,
          sectorId: cellId,
          networkType: site.networkType,
          earfcn: sector.earfcn || sector.earfcnDL,
          ssbFrequency: sector.ssbFrequency || sector.arfcnDL,
          cell_cover_type: cellCoverType,
          mcc: sector.mcc,
          mnc: sector.mnc,
          is_shared: sector.is_shared
        })

        // 统计坐标来源
        if (coordSource === 'sector') {
          coordSourceStats.sectorCoords++
        } else {
          coordSourceStats.siteCoords++
        }
      }
    }

    // 生产环境移除调试日志，避免性能影响

    return sectors
  }

  /**
   * 计算边界和中心点
   */
  private calculateBounds(sectors: RenderSectorData[]): {
    center: { latitude: number; longitude: number }
    bounds: { north: number; south: number; east: number; west: number }
  } {
    if (sectors.length === 0) {
      // 默认：北京
      return {
        center: { latitude: 39.9042, longitude: 116.4074 },
        bounds: {
          north: 40.0042,
          south: 39.8042,
          east: 116.5074,
          west: 116.3074
        }
      }
    }

    let minLat = Infinity
    let maxLat = -Infinity
    let minLng = Infinity
    let maxLng = -Infinity

    // 使用显示坐标（GCJ02）计算边界
    for (const sector of sectors) {
      const lat = sector.displayLat
      const lng = sector.displayLng

      minLat = Math.min(minLat, lat)
      maxLat = Math.max(maxLat, lat)
      minLng = Math.min(minLng, lng)
      maxLng = Math.max(maxLng, lng)
    }

    const centerLat = (minLat + maxLat) / 2
    const centerLng = (minLng + maxLng) / 2

    // 添加边界缓冲
    const latBuffer = (maxLat - minLat) * 0.1
    const lngBuffer = (maxLng - minLng) * 0.1

    return {
      center: {
        latitude: centerLat,
        longitude: centerLng
      },
      bounds: {
        north: maxLat + latBuffer,
        south: Math.max(0, minLat - latBuffer),
        east: maxLng + lngBuffer,
        west: Math.max(0, minLng - lngBuffer)
      }
    }
  }

  /**
   * 获取地图数据（带缓存）
   * 优先从 IndexedDB 读取，未命中则从后端获取
   */
  async getMapData(zoom?: number, forceRefresh = false): Promise<MapDataResponse> {
    // 检查内存缓存
    if (!forceRefresh && this.cachedData && Date.now() < this.cacheExpiry) {
      console.log('[MapDataService] 使用内存缓存')
      return this.cachedData
    }

    // 尝试从 IndexedDB 读取
    if (!forceRefresh) {
      try {
        const cachedData = await indexedDBService.get<MapDataResponse>(CACHE_KEY)
        if (cachedData) {
          console.log('[MapDataService] 使用 IndexedDB 缓存')
          // 同步到内存缓存
          this.cachedData = cachedData
          this.cacheExpiry = Date.now() + this.CACHE_DURATION
          return cachedData
        }
      } catch (error) {
        console.warn('[MapDataService] 读取 IndexedDB 缓存失败:', error)
      }
    }

    try {
      // 从后端获取数据
      console.log('[MapDataService] 从后端获取地图数据')
      const response = await mapApi.getData()
      const rawSites = response.data?.sites || []

      // 提取扇区数据
      const allSectors = this.extractSectorsFromSites(rawSites)

      // 验证数据
      const validation = this.validateSectors(allSectors)

      // 转换坐标
      const validSectors = this.transformCoordinates(validation.valid)

      // 分类
      const { lte, nr } = this.classifyByNetworkType(validSectors)

      // 应用LOD策略
      const currentZoom = zoom ?? 12
      const filteredLte = this.applyLOD(lte, currentZoom)
      const filteredNr = this.applyLOD(nr, currentZoom)

      // 计算边界和中心点
      const allValidSectors = [...filteredLte, ...filteredNr]
      const { center, bounds } = this.calculateBounds(allValidSectors)

      const result: MapDataResponse = {
        lteSectors: filteredLte,
        nrSectors: filteredNr,
        center,
        bounds
      }

      // 缓存到内存
      this.cachedData = result
      this.cacheExpiry = Date.now() + this.CACHE_DURATION

      // 缓存到 IndexedDB
      try {
        await indexedDBService.set(CACHE_KEY, result, CACHE_TTL)
      } catch (error) {
        console.warn('[MapDataService] 写入 IndexedDB 缓存失败:', error)
      }

      return result
    } catch (error) {
      console.error('[MapDataService] 加载数据失败:', error)

      // 返回空数据
      return {
        lteSectors: [],
        nrSectors: [],
        center: { latitude: 39.9042, longitude: 116.4074 },
        bounds: {
          north: 40.0042,
          south: 39.8042,
          east: 116.5074,
          west: 116.3074
        }
      }
    }
  }

  /**
   * 刷新缓存
   */
  async clearCache(): Promise<void> {
    this.cachedData = null
    this.cacheExpiry = 0
    try {
      await indexedDBService.delete(CACHE_KEY)
      console.log('[MapDataService] 缓存已清除')
    } catch (error) {
      console.warn('[MapDataService] 清除 IndexedDB 缓存失败:', error)
    }
  }

  /**
   * 根据缩放级别更新数据（LOD）
   */
  async updateForZoom(zoom: number): Promise<MapDataResponse> {
    return this.getMapData(zoom, true)
  }
}

// 单例导出
export const mapDataService = new MapDataService()

// ============================================================
// 轻量级小区列表服务（独立于地图数据，用于小区选择表格）
// ============================================================

/** 小区选择列表项（最小字段） */
export interface CellListItem {
  id: string
  name: string
  siteId: string
  networkType: 'LTE' | 'NR'
}

/** 小区列表响应 */
interface CellListResponse {
  lte: CellListItem[]
  nr: CellListItem[]
}

// 独立缓存（10分钟，与后端缓存TTL一致，减少跨期错配）
let _cellListCache: { data: CellListResponse | null; time: number } = {
  data: null, time: 0
}
const _CELL_LIST_CACHE_TTL = 10 * 60 * 1000

/**
 * 获取小区选择列表（轻量级，跳过坐标转换和扇区验证）
 *
 * 与 getMapData() 的区别：
 * - 只返回 id/name/siteId/networkType 四个字段
 * - 调用后端轻量 API /map/cells
 * - 独立缓存（10分钟 TTL）
 * - 不经过 IndexedDB
 */
export async function getCellList(): Promise<CellListResponse> {
  // 检查缓存
  if (_cellListCache.data && Date.now() - _cellListCache.time < _CELL_LIST_CACHE_TTL) {
    console.log('[CellList] 使用内存缓存')
    return _cellListCache.data
  }

  try {
    const t0 = performance.now()
    console.log('[CellList] 从后端获取小区列表')
    const response = await mapApi.getCells()
    const t1 = performance.now()

    // 去重：使用 Set 确保 id 唯一，防御后端脏数据
    const seen = new Set<string>()
    const dedupLte: CellListItem[] = []
    const dedupNr: CellListItem[] = []
    for (const item of (response?.data?.lte || [])) {
      if (!seen.has(item.id)) { seen.add(item.id); dedupLte.push(item) }
    }
    for (const item of (response?.data?.nr || [])) {
      if (!seen.has(item.id)) { seen.add(item.id); dedupNr.push(item) }
    }
    const t2 = performance.now()

    const data: CellListResponse = {
      lte: dedupLte,
      nr: dedupNr
    }

    // 写入缓存
    _cellListCache = { data, time: Date.now() }
    console.log(`[CellList] 获取完成: LTE=${data.lte.length}, NR=${data.nr.length}, API耗时=${(t1-t0).toFixed(0)}ms, 去重耗时=${(t2-t1).toFixed(0)}ms`)
    return data
  } catch (error) {
    console.error('[CellList] 获取失败:', error)
    return { lte: [], nr: [] }
  }
}

/**
 * 清除小区列表缓存（当工参数据重新导入时调用）
 */
export function clearCellListCache(): void {
  _cellListCache = { data: null, time: 0 }
  console.log('[CellList] 缓存已清除')
}
