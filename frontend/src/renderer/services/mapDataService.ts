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
import { userCacheSuffix } from '../utils/cacheKey'

// v2：扇区数据新增 managedElementId（网元ID）字段，旧缓存换键强制重建，避免属性框短暂显示 '-'
// 地图工参缓存按登录用户隔离（同浏览器切换账号不得读到他账号所在组的扇区数据）
const CACHE_KEY = () => `map_data_cache_v2${userCacheSuffix()}`
// 旧版缓存键：拿到新数据后清理，避免废弃缓存长期占用 IndexedDB 空间
const LEGACY_CACHE_KEY = 'map_data_cache'
const CACHE_TTL = 2 * 60 * 60 * 1000 // 2小时缓存（持久化，数据更新时通过版本号强制刷新）

// 数据版本键名 — 应用结果后递增版本号，地图强制重新加载
const DATA_VERSION_KEY = 'map_data_version'
function getDataVersion(): number {
  try { return Number(sessionStorage.getItem(DATA_VERSION_KEY)) || 0 } catch { return 0 }
}
function bumpDataVersion(): void {
  try { sessionStorage.setItem(DATA_VERSION_KEY, String(Date.now())) } catch { /* noop */ }
}

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
  /** 网元ID（全量工参「管理网元ID」，站点级） */
  managedElementId?: string
  networkType: 'LTE' | 'NR'
  earfcn?: number
  ssbFrequency?: number
  cell_cover_type?: number  // 小区覆盖类型: 1=室外小区(扇形60m/40度), 4=室内小区(圆形30m)
  mcc?: string  // 移动国家码
  mnc?: string  // 移动网络码
  is_shared?: string  // 是否共享
  first_group?: string  // 第一分组（厂家信息）
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
interface MemoryCacheEntry {
  data: MapDataResponse
  expiry: number
  version: number
}

export class MapDataService {
  // 内存缓存按登录用户分键：同一浏览器切换账号时绝不能读到上个账号（组）的数据
  private memoryCacheByUser = new Map<string, MemoryCacheEntry>()
  private readonly CACHE_DURATION = 60 * 60 * 1000 // 1小时缓存（持久化，仅在数据更新时失效）

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
   * 仅在极低缩放级别（< 8）且扇区数量极大时，按比例均匀采样。
   * SectorRendererSVG 已实现高效的视口剔除优化，视口外的扇区不会被渲染。
   * 均匀采样确保不同区域的扇区都能在地图上展示，避免 slice(0,N) 导致只显示名称排序靠前的扇区。
   */
  private applyLOD(sectors: RenderSectorData[], zoom: number): RenderSectorData[] {
    // 极低缩放级别时，限制返回数量以避免 DOM 元素过多
    if (zoom < 8 && sectors.length > 30000) {
      // 按步长均匀采样，保证各区域扇区都能在地图上展示
      const maxSectors = 30000
      const step = sectors.length / maxSectors
      const sampled: RenderSectorData[] = []
      for (let i = 0; i < sectors.length; i++) {
        const targetIdx = Math.floor(i / step)
        if (targetIdx === sampled.length) {
          sampled.push(sectors[i])
        }
      }
      return sampled
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
        // 提取小区标识。sector.id 可能是纯小区标识（'55'，全量工参解析入库）
        // 或 '基站_小区' 复合格式（'542685_55'，新站录入/历史数据）；小区标识本身不含下划线，
        // 取末段得到纯小区标识，避免属性弹窗"小区ID"显示成 '542685_55'。
        const rawCellId = sector.id || sector.cellId || sector.localCellId || sector.sectorId || ''
        const cellId = String(rawCellId).includes('_')
          ? String(rawCellId).split('_').pop()!
          : String(rawCellId)

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
          managedElementId: sector.managedElementId || site.managedElementId,
          networkType: site.networkType,
          earfcn: sector.earfcn || sector.earfcnDL,
          ssbFrequency: sector.ssbFrequency || sector.arfcnDL,
          cell_cover_type: cellCoverType,
          mcc: sector.mcc,
          mnc: sector.mnc,
          is_shared: sector.is_shared,
          first_group: sector.first_group,
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

  // 缓存有效性的最小扇区数 — 低于此值的缓存视为无效数据（后端错误/未就绪状态）
  private static readonly MIN_CACHED_SECTORS = 100

  /**
   * 获取地图数据（带缓存）
   * 优先从 IndexedDB 读取，未命中则从后端获取
   */
  async getMapData(zoom?: number, forceRefresh = false): Promise<MapDataResponse> {
    const cacheUserKey = userCacheSuffix()
    const memEntry = this.memoryCacheByUser.get(cacheUserKey)

    // 数据版本检查：如果 sessionStorage 记录了更新版本，强制刷新
    const latestVersion = getDataVersion()
    if (!forceRefresh && memEntry && latestVersion > memEntry.version) {
      console.log('[MapDataService] 检测到数据版本已更新，强制刷新')
      forceRefresh = true
    }

    // 检查内存缓存
    if (!forceRefresh && memEntry && Date.now() < memEntry.expiry) {
      console.log('[MapDataService] 使用内存缓存')
      return memEntry.data
    }

    // 尝试从 IndexedDB 读取（仅当未强制刷新时）
    if (!forceRefresh) {
      try {
        const cachedData = await indexedDBService.get<MapDataResponse>(CACHE_KEY())
        // 验证缓存数据有效性：扇区数量至少达到最小阈值
        if (cachedData) {
          const cachedTotal = (cachedData.lteSectors?.length || 0) + (cachedData.nrSectors?.length || 0)
          if (cachedTotal >= MapDataService.MIN_CACHED_SECTORS) {
            console.log('[MapDataService] 使用 IndexedDB 缓存')
            // 同步到内存缓存（按用户分键）
            this.memoryCacheByUser.set(cacheUserKey, {
              data: cachedData,
              expiry: Date.now() + this.CACHE_DURATION,
              version: getDataVersion(),
            })
            return cachedData
          } else {
            // 缓存数据量过少，视为无效，删除后重新获取
            console.warn(`[MapDataService] IndexedDB 缓存数据量异常（${cachedTotal} < ${MapDataService.MIN_CACHED_SECTORS}），丢弃并重新获取`)
            indexedDBService.delete(CACHE_KEY()).catch(() => {})
          }
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

      // 缓存到内存（按用户分键）
      this.memoryCacheByUser.set(cacheUserKey, {
        data: result,
        expiry: Date.now() + this.CACHE_DURATION,
        version: getDataVersion(),
      })

      // 仅在数据量正常时才写入 IndexedDB 持久缓存
      // 避免后端短暂异常时缓存空/部分数据导致地图长时间空白
      const totalSectors = result.lteSectors.length + result.nrSectors.length
      if (totalSectors >= MapDataService.MIN_CACHED_SECTORS) {
        try {
          await indexedDBService.set(CACHE_KEY(), result, CACHE_TTL)
          // 新数据已落盘，旧键不再需要
          indexedDBService.delete(LEGACY_CACHE_KEY).catch(() => {})
        } catch (error) {
          console.warn('[MapDataService] 写入 IndexedDB 缓存失败:', error)
        }
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

  /** 清空所有用户的内存缓存（登出/切换账号时调用） */
  clearAllInMemory(): void {
    this.memoryCacheByUser.clear()
  }

  /**
   * 刷新缓存（清除前端 + 后端所有地图缓存）
   */
  async clearCache(): Promise<void> {
    this.memoryCacheByUser.delete(userCacheSuffix())
    // 清除后端 _map_data_cache，确保下次请求重新读取最新 data.json
    try {
      await mapApi.clearCache()
    } catch (_) {
      // 后端清理非关键，即使失败也继续清理前端
    }
    try {
      await indexedDBService.delete(CACHE_KEY())
      await indexedDBService.delete(LEGACY_CACHE_KEY).catch(() => {})
      console.log('[MapDataService] 所有缓存已清除')
    } catch (error) {
      console.warn('[MapDataService] 清除 IndexedDB 缓存失败:', error)
    }
  }

  /**
   * 根据缩放级别更新数据（LOD）
   */
  async updateForZoom(zoom: number): Promise<MapDataResponse> {
    return this.getMapData(zoom, false)
  }
}

// 单例导出
export const mapDataService = new MapDataService()
export { bumpDataVersion }

/**
 * 清空所有用户的内存数据缓存（登录/登出切换账号时调用）。
 * IndexedDB 缓存本身按用户 id 分键不会串读，清内存可立即释放并杜绝 TTL 内残留。
 */
export function clearAllInMemoryMapCaches(): void {
  mapDataService.clearAllInMemory()
  _cellListCacheByUser.clear()
}

// ============================================================
// 轻量级小区列表服务（独立于地图数据，用于小区选择表格）
// ============================================================

/** 小区选择列表项（最小字段） */
export interface CellListItem {
  id: string
  name: string
  siteId: string
  networkType: 'LTE' | 'NR'
  frequency?: number
  pci?: number
  longitude?: number | null
  latitude?: number | null
}

/** 小区列表响应 */
interface CellListResponse {
  lte: CellListItem[]
  nr: CellListItem[]
  cacheVersion?: number
}

// 小区列表缓存同样按登录用户隔离
const _CELL_LIST_CACHE_KEY = () => `cell_list_cache${userCacheSuffix()}`
const _CELL_LIST_CACHE_TTL = 24 * 60 * 60 * 1000 // 24小时缓存
/** 缓存版本，递增以强制刷新缓存（接口数据格式变更时） */
// v5：小区经纬度改为只取小区自身值（不再回退站点坐标），旧缓存会残留错误坐标
const _CELL_LIST_CACHE_VERSION = 5

// 内存缓存（持久化，仅在数据更新时失效），按登录用户分键防止切账号串组
const _cellListCacheByUser = new Map<string, { data: CellListResponse; time: number }>()

/**
 * 获取小区选择列表（轻量级，跳过坐标转换和扇区验证）
 *
 * 与 getMapData() 的区别：
 * - 只返回 id/name/siteId/networkType 四个字段
 * - 调用后端轻量 API /map/cells
 * - 双缓存：内存（快速） + IndexedDB（持久化，应用重启后仍可用）
 */
export async function getCellList(): Promise<CellListResponse> {
  const userKey = userCacheSuffix()
  // 1. 检查内存缓存（按用户分键）
  const mem = _cellListCacheByUser.get(userKey)
  if (mem && Date.now() - mem.time < _CELL_LIST_CACHE_TTL) {
    console.log('[CellList] 使用内存缓存')
    return mem.data
  }

  // 2. 检查 IndexedDB 缓存（仅版本匹配时使用）
  try {
    const cached = await indexedDBService.get<CellListResponse>(_CELL_LIST_CACHE_KEY())
    if (cached && cached.cacheVersion === _CELL_LIST_CACHE_VERSION) {
      console.log('[CellList] 使用 IndexedDB 缓存')
      _cellListCacheByUser.set(userKey, { data: cached, time: Date.now() })
      return cached
    }
    // 版本不匹配时清除旧缓存
    if (cached && cached.cacheVersion !== _CELL_LIST_CACHE_VERSION) {
      console.log('[CellList] 缓存版本不匹配，清除旧缓存')
      indexedDBService.delete(_CELL_LIST_CACHE_KEY()).catch(() => {})
    }
  } catch (err) {
    // IndexedDB 读取失败，回退到网络请求
  }

  // 3. 从后端获取
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
      nr: dedupNr,
      cacheVersion: _CELL_LIST_CACHE_VERSION
    }

    // 写入双缓存（按用户分键）
    _cellListCacheByUser.set(userCacheSuffix(), { data, time: Date.now() })
    try {
      await indexedDBService.set(_CELL_LIST_CACHE_KEY(), data, _CELL_LIST_CACHE_TTL)
    } catch (err) {
      // IndexedDB 写入失败非关键
    }
    console.log(`[CellList] 获取完成: LTE=${data.lte.length}, NR=${data.nr.length}, API耗时=${(t1-t0).toFixed(0)}ms, 去重耗时=${(t2-t1).toFixed(0)}ms`)
    return data
  } catch (error) {
    console.error('[CellList] 获取失败:', error)
    return { lte: [], nr: [] }
  }
}

/**
 * 执行规划前小区必须具备的字段
 * - siteId: 基站ID；id: 小区ID；frequency: 频点；longitude/latitude: 经纬度
 */
export type CellRequiredField = 'siteId' | 'id' | 'frequency' | 'longitude' | 'latitude'

/** 存在字段缺失的小区 */
export interface CellMissingFields {
  id: string
  name: string
  missing: CellRequiredField[]
}

/**
 * 校验选中小区的必要字段完整性（经度/纬度/频点/基站ID/小区ID）
 *
 * @returns 存在缺失的小区列表（含每个小区缺失的字段），为空表示全部通过
 */
export function findCellsMissingRequiredFields(
  sectors: CellListItem[],
  selectedIds: Set<string>
): CellMissingFields[] {
  const invalid: CellMissingFields[] = []
  for (const s of sectors) {
    if (!selectedIds.has(s.id)) continue
    const missing: CellRequiredField[] = []
    if (!s.siteId) missing.push('siteId')
    if (!s.id) missing.push('id')
    if (s.frequency == null || !Number.isFinite(s.frequency)) missing.push('frequency')
    if (s.longitude == null || !Number.isFinite(s.longitude)) missing.push('longitude')
    if (s.latitude == null || !Number.isFinite(s.latitude)) missing.push('latitude')
    if (missing.length > 0) {
      invalid.push({ id: s.id, name: s.name || s.id, missing })
    }
  }
  return invalid
}

/**
 * 清除小区列表缓存（内存 + IndexedDB）
 */
export async function clearCellListCache(): Promise<void> {
  _cellListCacheByUser.delete(userCacheSuffix())
  try {
    await indexedDBService.delete(_CELL_LIST_CACHE_KEY())
  } catch (err) {
    // IndexedDB 删除失败非关键
  }
  console.log('[CellList] 缓存已清除')
}
