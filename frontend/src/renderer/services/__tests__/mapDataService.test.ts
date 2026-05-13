/**
 * MapDataService 单元测试
 *
 * 测试内容：
 * 1. 扇区坐标提取逻辑（优先使用扇区独立坐标）
 * 2. 小区覆盖类型统计
 * 3. 数据验证和过滤
 */

import { MapDataService } from '../mapDataService'

describe('MapDataService', () => {
  let service: MapDataService

  beforeEach(() => {
    service = new MapDataService()
    jest.clearAllMocks()
  })

  describe('扇区坐标提取逻辑', () => {
    /**
     * 测试用例1: 扇区有独立坐标时应优先使用扇区坐标
     *
     * 模拟场景：
     * - 站点坐标: (23.7, 114.7)
     * - 扇区1坐标: (23.701, 114.701)
     * - 扇区2坐标: (23.702, 114.702)
     *
     * 预期结果：
     * - 扇区1应使用其独立坐标 (23.701, 114.701)
     * - 扇区2应使用其独立坐标 (23.702, 114.702)
     */
    it('应优先使用扇区独立坐标而非站点坐标', async () => {
      // Mock 后端响应数据
      const mockSites = [
        {
          id: 'site1',
          name: '测试站点',
          latitude: 23.7,
          longitude: 114.7,
          networkType: 'NR',
          sectors: [
            {
              id: 'sector1',
              name: '扇区1',
              latitude: 23.701,
              longitude: 114.701,
              azimuth: 0,
              cell_cover_type: 1
            },
            {
              id: 'sector2',
              name: '扇区2',
              latitude: 23.702,
              longitude: 114.702,
              azimuth: 120,
              cell_cover_type: 1
            }
          ]
        }
      ]

      // Mock API 响应
      jest.spyOn(service as any, 'transformCoordinates').mockImplementation(
        (sectors: any[]) => sectors.map(s => ({ ...s, displayLat: s.latitude, displayLng: s.longitude }))
      )

      // 调用提取方法
      const extractedSectors = (service as any).extractSectorsFromSites(mockSites)

      // 验证：扇区使用了各自独立坐标
      expect(extractedSectors).toHaveLength(2)
      expect(extractedSectors[0].latitude).toBe(23.701)
      expect(extractedSectors[0].longitude).toBe(114.701)
      expect(extractedSectors[1].latitude).toBe(23.702)
      expect(extractedSectors[1].longitude).toBe(114.702)

      // 验证：坐标未被强制对齐到站点坐标
      expect(extractedSectors[0].latitude).not.toBe(mockSites[0].latitude)
      expect(extractedSectors[1].latitude).not.toBe(mockSites[0].latitude)
    })

    /**
     * 测试用例2: 扇区无独立坐标时应回退到站点坐标
     */
    it('扇区无独立坐标时应回退到站点坐标', async () => {
      const mockSites = [
        {
          id: 'site1',
          name: '测试站点',
          latitude: 23.7,
          longitude: 114.7,
          networkType: 'LTE',
          sectors: [
            {
              id: 'sector1',
              name: '扇区1',
              // 无 latitude/longitude，应使用站点坐标
              azimuth: 0,
              cell_cover_type: 1
            }
          ]
        }
      ]

      jest.spyOn(service as any, 'transformCoordinates').mockImplementation(
        (sectors: any[]) => sectors.map(s => ({ ...s, displayLat: s.latitude, displayLng: s.longitude }))
      )

      const extractedSectors = (service as any).extractSectorsFromSites(mockSites)

      // 验证：扇区使用了站点坐标
      expect(extractedSectors).toHaveLength(1)
      expect(extractedSectors[0].latitude).toBe(23.7)
      expect(extractedSectors[0].longitude).toBe(114.7)
    })
  })

  describe('小区覆盖类型统计', () => {
    /**
     * 测试用例3: 验证小区覆盖类型统计
     */
    it('应正确统计室内和室外小区数量', async () => {
      const mockSites = [
        {
          id: 'site1',
          name: '测试站点',
          latitude: 23.7,
          longitude: 114.7,
          networkType: 'NR',
          sectors: [
            { id: 'sector1', cell_cover_type: 1, azimuth: 0 },
            { id: 'sector2', cell_cover_type: 1, azimuth: 120 },
            { id: 'sector3', cell_cover_type: 4, azimuth: 240 },
            { id: 'sector4', cell_cover_type: 4, azimuth: 0 },
            { id: 'sector5', cell_cover_type: 4, azimuth: 120 }
          ]
        }
      ]

      jest.spyOn(service as any, 'transformCoordinates').mockImplementation(
        (sectors: any[]) => sectors.map(s => ({ ...s, displayLat: s.latitude, displayLng: s.longitude }))
      )

      // 捕获 console.log 输出
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation()

      const extractedSectors = (service as any).extractSectorsFromSites(mockSites)

      // 验证：提取了5个扇区
      expect(extractedSectors).toHaveLength(5)

      // 验证：日志中包含覆盖类型统计
      const logCalls = consoleSpy.mock.calls
      const statsLog = logCalls.find(call =>
        call[0] === '[MapDataService] 提取扇区数据完成:' &&
        (call[1] as any).coverTypeStats
      )

      expect(statsLog).toBeDefined()
      expect((statsLog![1] as any).coverTypeStats.type1).toBe(2)  // 2个室外小区
      expect((statsLog![1] as any).coverTypeStats.type4).toBe(3)  // 3个室内小区

      consoleSpy.mockRestore()
    })
  })

  describe('数据验证', () => {
    /**
     * 测试用例4: 验证无效数据过滤
     */
    it('应过滤缺失经纬度或方位角的无效数据', async () => {
      const invalidSectors = [
        { id: 's1', latitude: null, longitude: 114.7, azimuth: 0 },    // 缺失纬度
        { id: 's2', latitude: 23.7, longitude: null, azimuth: 0 },     // 缺失经度
        { id: 's3', latitude: 23.7, longitude: 114.7, azimuth: null }, // 缺失方位角
        { id: 's4', latitude: 23.7, longitude: 114.7, azimuth: 0 }     // 有效
      ]

      const result = (service as any).validateSectors(invalidSectors)

      // 验证：只有1条有效数据
      expect(result.valid).toHaveLength(1)
      expect(result.invalid).toHaveLength(3)
      expect(result.stats.validCount).toBe(1)
      expect(result.stats.invalidCount).toBe(3)
      expect(result.stats.missingLat).toBe(1)
      expect(result.stats.missingLng).toBe(1)
      expect(result.stats.missingAzimuth).toBe(1)
    })

    /**
     * 测试用例5: 验证经纬度范围检查
     */
    it('应过滤超出范围的经纬度', async () => {
      const outOfRangeSectors = [
        { id: 's1', latitude: 100, longitude: 114.7, azimuth: 0 },     // 纬度超出范围
        { id: 's2', latitude: 23.7, longitude: 200, azimuth: 0 },      // 经度超出范围
        { id: 's3', latitude: 23.7, longitude: 114.7, azimuth: 400 },   // 方位角超出范围
        { id: 's4', latitude: 23.7, longitude: 114.7, azimuth: 0 }      // 有效
      ]

      const result = (service as any).validateSectors(outOfRangeSectors)

      // 验证：只有1条有效数据，3条超出范围
      expect(result.valid).toHaveLength(1)
      expect(result.invalid).toHaveLength(3)
      expect(result.stats.outOfRange).toBe(3)
    })
  })

  describe('坐标转换', () => {
    /**
     * 测试用例6: 验证 WGS84 到 GCJ02 坐标转换
     */
    it('应正确转换 WGS84 坐标到 GCJ02', async () => {
      const wgs84Sectors = [
        { id: 's1', latitude: 23.7, longitude: 114.7, azimuth: 0 }
      ]

      const result = (service as any).transformCoordinates(wgs84Sectors)

      // 验证：转换后的坐标存在且与原始坐标不同（WGS84→GCJ02会有偏移）
      expect(result).toHaveLength(1)
      expect(result[0].displayLat).toBeDefined()
      expect(result[0].displayLng).toBeDefined()
      expect(result[0].originalLat).toBe(23.7)
      expect(result[0].originalLng).toBe(114.7)

      // GCJ02 坐标应该与 WGS84 不同（有偏移）
      const latDiff = Math.abs(result[0].displayLat - 23.7)
      const lngDiff = Math.abs(result[0].displayLng - 114.7)
      expect(latDiff).toBeGreaterThan(0)
      expect(lngDiff).toBeGreaterThan(0)
    })
  })
})
