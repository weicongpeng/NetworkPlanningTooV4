/**
 * 3D 地理化数据扇区几何与 2D（GeoDataLayer._renderSectors）的一致性锁定。
 *
 * 此前 3D 侧无论文件是不是扇区型，都把每行数据渲染成 Point（屏幕上就是一个圆点），
 * 与 2D 的扇形渲染不一致。
 */
import { describe, it, expect } from 'vitest'
import {
  geoDataSectorRing,
  isGeoDataDot,
  GEO_DATA_SECTOR_RADIUS_M,
  GEO_DATA_SECTOR_LOD_ZOOM,
} from '../cesiumGeoJson'

const LAT = 23.7433
const LNG = 114.6974

/** 粗略米距（与实现同口径的平地近似，仅用于断言量级） */
function metersFrom(lat: number, lng: number): number {
  const dLat = (lat - LAT) * 111320
  const dLng = (lng - LNG) * 111320 * Math.cos((LAT * Math.PI) / 180)
  return Math.hypot(dLat, dLng)
}

describe('geoDataSectorRing', () => {
  it('环首尾闭合，且首点为站点位置', () => {
    const ring = geoDataSectorRing(LAT, LNG, 30, 65)
    expect(ring[0]).toEqual([LNG, LAT])
    expect(ring[ring.length - 1]).toEqual([LNG, LAT])
  })

  it('采样点数 = max(6, ceil(波束/5)) + 2 个闭合点（对齐 2D）', () => {
    // 波束 65° → ceil(13) = 13 → 13+1 个弧点 + 首尾各一个中心点
    expect(geoDataSectorRing(LAT, LNG, 30, 65)).toHaveLength(13 + 3)
    // 波束 10° → max(6, 2) = 6
    expect(geoDataSectorRing(LAT, LNG, 30, 10)).toHaveLength(6 + 3)
  })

  it('所有弧点到站点距离 ≈ 半径 80 米', () => {
    const ring = geoDataSectorRing(LAT, LNG, 120, 65)
    for (const [lng, lat] of ring.slice(1, -1)) {
      expect(metersFrom(lat, lng)).toBeCloseTo(GEO_DATA_SECTOR_RADIUS_M, -1)
    }
  })

  it('方位角 0°（正北）时弧线全部落在站点北侧', () => {
    const ring = geoDataSectorRing(LAT, LNG, 0, 40)
    for (const [, lat] of ring.slice(1, -1)) {
      expect(lat).toBeGreaterThan(LAT)
    }
  })

  it('方位角 90°（正东）时弧线全部落在站点东侧', () => {
    const ring = geoDataSectorRing(LAT, LNG, 90, 40)
    for (const [lng] of ring.slice(1, -1)) {
      expect(lng).toBeGreaterThan(LNG)
    }
  })

  it('扇形张角随波束变化：40° 的横向跨度小于 120°', () => {
    const span = (beam: number) => {
      const ring = geoDataSectorRing(LAT, LNG, 0, beam).slice(1, -1)
      const lngs = ring.map((p) => p[0])
      return Math.max(...lngs) - Math.min(...lngs)
    }
    expect(span(40)).toBeLessThan(span(120))
  })
})

describe('isGeoDataDot（圆点 vs 扇形判定，对齐 2D）', () => {
  it('方位角 360°（全向覆盖）→ 圆点', () => {
    expect(isGeoDataDot({ azimuth: 360, cell_cover_type: 1 }, 15)).toBe(true)
  })

  it('室内小区（cell_cover_type=4）→ 圆点', () => {
    expect(isGeoDataDot({ azimuth: 30, cell_cover_type: 4 }, 15)).toBe(true)
  })

  it('低 zoom（≤ LOD 阈值）→ 圆点', () => {
    expect(isGeoDataDot({ azimuth: 30, cell_cover_type: 1 }, GEO_DATA_SECTOR_LOD_ZOOM)).toBe(true)
    expect(isGeoDataDot({ azimuth: 30, cell_cover_type: 1 }, GEO_DATA_SECTOR_LOD_ZOOM + 1)).toBe(false)
  })

  it('室外定向小区 + 正常 zoom → 扇形', () => {
    expect(isGeoDataDot({ azimuth: 30, cell_cover_type: 1 }, 15)).toBe(false)
  })

  it('缺字段时按 2D 默认（方位角 0°、室外）→ 扇形', () => {
    expect(isGeoDataDot({}, 15)).toBe(false)
    expect(isGeoDataDot({ azimuth: null, cell_cover_type: null }, 15)).toBe(false)
  })
})
