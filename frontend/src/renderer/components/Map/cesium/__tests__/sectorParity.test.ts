/**
 * Cesium 扇区渲染与高德侧（SectorRendererSVG）的一致性锁定。
 *
 * 这两个数字口径此前不一致：Cesium 侧用 `getCellCoverStyle().radius`（固定 10 米），
 * 高德侧是**恒定屏幕像素半径**（室外 16px / 室内 8px，随 zoom 换算成米）。
 * 结果 3D 里扇区小到几乎不可见，点不中、圈不到。
 */
import { describe, it, expect } from 'vitest'
import {
  sectorRadius, arcPointsCount, circlePointsCount,
  sampleCenteredOn, MAX_RENDER_SECTORS, metersPerPixelQuantized,
} from '../CesiumSectorLayer'
import type { CameraView } from '../CesiumSectorLayer'
import type { RenderSectorData } from '../../../../services/mapDataService'

/** 只带半径换算所需字段的最小扇区 */
function sector(overrides: Partial<RenderSectorData> = {}): RenderSectorData {
  return {
    id: '1',
    networkType: 'LTE',
    originalLat: 23.7433,
    originalLng: 114.6974,
    displayLat: 23.7467,
    displayLng: 114.7017,
    cell_cover_type: 1, // 室外：扇形
    azimuth: 0,
    beamwidth: 40,
    ...overrides,
  } as unknown as RenderSectorData
}

/** 只用 zoom 公式的视野（不提供 metersPerPixelAt → 回退 Web Mercator） */
function view(zoom: number): CameraView {
  return { south: 0, north: 0, west: 0, east: 0, zoom }
}

/** 高德侧公式：16px × 米/像素（见 SectorRendererSVG._calculateRadius） */
function amapRadius(zoom: number, lat: number): number {
  const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom)
  return Math.max(5, Math.min(5000, 16 * mpp))
}

/**
 * 量化允许的最大相对偏差：米/像素按 2^1/8 分档（≈9%，档位比早先的 1/32 粗，
 * 换更少的重建次数），worst case 偏差即 2^(1/8)-1。
 * 3D 半径 = 目标像素 × 量化后的米/像素，所以与高德侧的偏差也在这个量级。
 */
const MPP_MAX_REL_ERR = Math.pow(2, 1 / 8) - 1

describe('扇区半径：与高德侧恒定像素口径一致', () => {
  it('室外扇区半径 = 16px × 米/像素（同一 zoom 下与高德侧相同，量化偏差 ≤9%）', () => {
    for (const zoom of [10, 12, 14, 16, 18]) {
      const r = sectorRadius(sector(), view(zoom), false)
      const amap = amapRadius(zoom, 23.7433)
      expect(r).toBeGreaterThan(amap * (1 - MPP_MAX_REL_ERR) - 1e-9)
      expect(r).toBeLessThan(amap * (1 + MPP_MAX_REL_ERR) + 1e-9)
    }
  })

  it('室内扇区半径 = 室外的一半（对齐 SectorRendererSVG 的 indoorRadius）', () => {
    const indoor = sector({ cell_cover_type: 4 })
    for (const zoom of [10, 12, 14, 16]) {
      const outdoorR = sectorRadius(sector(), view(zoom), false)
      expect(sectorRadius(indoor, view(zoom), false)).toBeCloseTo(outdoorR / 2, 6)
    }
  })

  it('不再是固定 10 米：低 zoom 明显放大，高 zoom 明显缩小', () => {
    const low = sectorRadius(sector(), view(8), false)
    const high = sectorRadius(sector(), view(18), false)
    expect(low).toBeGreaterThan(100)
    expect(high).toBeLessThan(10)
  })

  it('邻区高亮放大 1.15 倍', () => {
    const base = sectorRadius(sector(), view(14), false)
    expect(sectorRadius(sector(), view(14), true)).toBeCloseTo(base * 1.15, 6)
  })

  it('半径钳制在 [5, 5000] 米', () => {
    expect(sectorRadius(sector(), view(22), false)).toBeGreaterThanOrEqual(5)
    expect(sectorRadius(sector(), view(0), false)).toBeLessThanOrEqual(5000)
  })

  it('提供 metersPerPixelAt 时按其换算（3D 透视路径，量化后偏差 ≤9%）', () => {
    const v: CameraView = { ...view(12), metersPerPixelAt: () => 50 }
    // 16px × 50m/px ≈ 800m，量化到 2^1/8 档位后有小幅偏差
    const r = sectorRadius(sector(), v, false)
    expect(r).toBeGreaterThan(800 * (1 - MPP_MAX_REL_ERR) - 1e-9)
    expect(r).toBeLessThan(800 * (1 + MPP_MAX_REL_ERR) + 1e-9)
  })

  it('量化让同一档位内的米/像素完全一致（平移/旋转不改变几何）', () => {
    // 档宽 2^(1/8)-1 ≈ 9%：量化值即档位中心，±4.4% 内必同档，取 ±2% 稳定不越界
    const center = metersPerPixelQuantized(() => 44.4758)
    const lo = metersPerPixelQuantized(() => center * 0.98)
    const hi = metersPerPixelQuantized(() => center * 1.02)
    // 同档内取值必须逐位相同 —— 这是"不随相机微动重建"的根据
    expect(lo).toBe(center)
    expect(hi).toBe(center)
    // 明显跨档则必须不同（否则量化就没起作用）
    expect(metersPerPixelQuantized(() => center * 1.5)).not.toBe(center)
  })
})

describe('重建量封顶：大网规模下保证单次重建代价有界', () => {
  /** 生成以 (lat,lng) 为中心、按行列铺开的扇区 */
  function grid(n: number): RenderSectorData[] {
    const out: RenderSectorData[] = []
    for (let i = 0; i < n; i++) {
      out.push(sector({
        id: String(i),
        originalLat: 23.7433 + (i % 100) * 0.01,
        originalLng: 114.6974 + Math.floor(i / 100) * 0.01,
      }))
    }
    return out
  }

  it('MAX_RENDER_SECTORS 是有限的正整数（重建量封顶）', () => {
    expect(Number.isInteger(MAX_RENDER_SECTORS)).toBe(true)
    expect(MAX_RENDER_SECTORS).toBeGreaterThan(0)
  })

  it('超出上限时截断到上限条数', () => {
    const list = grid(6000)
    const view: CameraView = {
      south: 23.74, north: 23.80, west: 114.69, east: 114.75, zoom: 15,
    }
    expect(sampleCenteredOn(list, view, MAX_RENDER_SECTORS)).toHaveLength(MAX_RENDER_SECTORS)
  })

  it('截断时优先保留靠近视野中心的扇区（用户看的是屏幕中心）', () => {
    const list = grid(6000)
    const view: CameraView = {
      south: 23.74, north: 23.80, west: 114.69, east: 114.75, zoom: 15,
    }
    const picked = sampleCenteredOn(list, view, 100)
    const cLat = (view.south + view.north) / 2
    const cLng = (view.west + view.east) / 2
    const far = picked[picked.length - 1]
    const dist = Math.hypot(far.originalLat - cLat, far.originalLng - cLng)
    // 保留集合里的最远点，不应比被丢弃的最近点更近
    const dropped = list.filter((x) => !picked.includes(x))
    const nearestDropped = Math.min(
      ...dropped.map((x) => Math.hypot(x.originalLat - cLat, x.originalLng - cLng)))
    expect(dist).toBeLessThanOrEqual(nearestDropped + 1e-9)
  })

  it('未超上限时原样返回（不改变既有渲染）', () => {
    const list = grid(50)
    const view: CameraView = {
      south: 23.74, north: 23.80, west: 114.69, east: 114.75, zoom: 15,
    }
    expect(sampleCenteredOn(list, view, MAX_RENDER_SECTORS)).toHaveLength(50)
  })
})

describe('弧线/圆形采样点数：与高德侧分档一致', () => {
  it('默认模式弧线点数分档 12 / 20 / 30 / 40', () => {
    expect(arcPointsCount(10, false)).toBe(12)
    expect(arcPointsCount(12, false)).toBe(12)
    expect(arcPointsCount(13, false)).toBe(20)
    expect(arcPointsCount(15, false)).toBe(20)
    expect(arcPointsCount(16, false)).toBe(30)
    expect(arcPointsCount(17, false)).toBe(30)
    expect(arcPointsCount(18, false)).toBe(40)
  })

  it('PCI 规划模式弧线点数分档 6 / 8 / 10', () => {
    expect(arcPointsCount(10, true)).toBe(6)
    expect(arcPointsCount(14, true)).toBe(8)
    expect(arcPointsCount(18, true)).toBe(10)
  })

  it('圆形点数分档 20 / 32 / 48 / 64；PCI 模式恒为 8', () => {
    expect(circlePointsCount(10, false)).toBe(20)
    expect(circlePointsCount(14, false)).toBe(32)
    expect(circlePointsCount(16, false)).toBe(48)
    expect(circlePointsCount(18, false)).toBe(64)
    expect(circlePointsCount(18, true)).toBe(8)
  })
})
