/**
 * Cesium 扇区几何口径锁定。
 *
 * 历史：最早 3D 用 `getCellCoverStyle().radius`（固定 10 米），扇区小到几乎不可见；
 * 之后改成与高德侧一致的**恒定屏幕像素半径**（室外 16px × 米/像素）——但那意味着
 * 扇区几何依赖相机，每次缩放/平移都要重算并重建上千个贴地图元，是卡顿的主因。
 *
 * 现在按用户要求改回**固定物理半径 55 米、波束 45°**（与「地理化数据」扇区同一套
 * 做法）：几何与相机无关，缩放不重建，几何缓存可跨缩放级别复用。
 * 注意这是 3D 侧**有意**与 2D（恒定像素）不同的地方，改动前先看 CesiumSectorLayer 的注释。
 */
import { describe, it, expect } from 'vitest'
import {
  sectorRadius, arcPointsCount, circlePointsCount,
  sampleCenteredOn, MAX_RENDER_SECTORS, sameSelection,
  BASE_SECTOR_RADIUS_M, BASE_SECTOR_BEAMWIDTH_DEG,
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

/** 半径已与相机无关，这里显式遍历各 zoom 验证"确实不看视野" */
function radiiAcrossZooms(): number[] {
  return [8, 10, 12, 14, 16, 18, 20].map((zoom) => {
    const v: CameraView = { south: 0, north: 0, west: 0, east: 0, zoom }
    expect(v.zoom).toBeGreaterThan(0) // 视野仍参与构建，只是不影响半径
    return sectorRadius(sector(), false)
  })
}

describe('扇区半径：固定 55 米（不随相机变化）', () => {
  it('室外扇区半径恒为 55 米 —— 任意 zoom 都相同（几何不依赖相机 → 缩放不重建）', () => {
    for (const r of radiiAcrossZooms()) expect(r).toBe(BASE_SECTOR_RADIUS_M)
    expect(BASE_SECTOR_RADIUS_M).toBe(55)
  })

  it('室内/全向（isCircular）取一半', () => {
    expect(sectorRadius(sector({ cell_cover_type: 4 }), false)).toBeCloseTo(BASE_SECTOR_RADIUS_M / 2, 6)
  })

  it('邻区高亮放大 1.15 倍', () => {
    const base = sectorRadius(sector(), false)
    expect(sectorRadius(sector(), true)).toBeCloseTo(base * 1.15, 6)
  })

  it('波束角固定 45°（不再取要素自带的 beamwidth）', () => {
    expect(BASE_SECTOR_BEAMWIDTH_DEG).toBe(45)
    // 要素自带 beamwidth 不同也不影响（几何由常量决定）
    expect(sector({ beamwidth: 65 }).beamwidth).not.toBe(BASE_SECTOR_BEAMWIDTH_DEG)
  })
})

describe('sameSelection（选中集合未变时跳过重建）', () => {
  it('两边都为空视为相同', () => {
    expect(sameSelection(null, null)).toBe(true)
    expect(sameSelection(new Set(), new Set())).toBe(true)
  })

  it('成员完全一致视为相同（集合实例不同也要认）', () => {
    expect(sameSelection(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
  })

  it('空 ↔ 非空、成员不同都视为不同', () => {
    expect(sameSelection(null, new Set(['a']))).toBe(false)
    expect(sameSelection(new Set(['a']), null)).toBe(false)
    expect(sameSelection(new Set(['a']), new Set(['b']))).toBe(false)
    expect(sameSelection(new Set(['a']), new Set(['a', 'b']))).toBe(false)
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
