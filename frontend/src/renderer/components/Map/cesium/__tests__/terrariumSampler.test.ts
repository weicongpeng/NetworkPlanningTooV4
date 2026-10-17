/**
 * terrarium 高程采样纯函数锁定。
 *
 * 背景：免费 Cesium WorldTerrain 在中国全境没有高程数据（实测 ≈-13m），
 * 等高线改用 AWS terrarium 瓦片。这里锁住解码公式与 zoom 选择规则。
 */
import { describe, it, expect } from 'vitest'
import { terrariumDecode, terrariumZoomFor } from '../cesiumTerrarium'

describe('terrariumDecode', () => {
  it(' elevation = R×256 + G + B/256 - 32768 ', () => {
    // 海平面附近：编码值 = 32768 → R=128, G=0
    expect(terrariumDecode(128, 0, 0)).toBe(0)
    // 重庆城区 ~250m：v = 33018 → R=128, G=250
    expect(terrariumDecode(128, 250, 0)).toBe(250)
    // 拉萨 ~3650m：v = 36418 → R=142, G=66
    expect(terrariumDecode(142, 66, 0)).toBe(3650)
    // B 通道提供亚米精度：0.25m
    expect(terrariumDecode(128, 0, 64)).toBe(0.25)
  })

  it('负高程（海平面下）也能解', () => {
    // v = 32768 - 30 = 32738 → R=127, G=226
    expect(terrariumDecode(127, 226, 0)).toBe(-30)
  })
})

describe('terrariumZoomFor', () => {
  it('跨度越大 zoom 越低', () => {
    const city = terrariumZoomFor(0.1)     // ~10km 视野 → z13
    const county = terrariumZoomFor(0.4)   // ~40km 视野 → z11
    const province = terrariumZoomFor(2)   // ~200km 视野 → z10（触底）
    expect(county).toBeLessThan(city)
    expect(province).toBeLessThan(county)
  })

  it('夹在 [10, 13]：城市级不低、全国级不高', () => {
    expect(terrariumZoomFor(0.001)).toBe(13)   // 极小跨度 → 上限
    expect(terrariumZoomFor(60)).toBe(10)      // 极大跨度 → 下限
    expect(terrariumZoomFor(0)).toBe(10)       // 非法输入兜底
    expect(terrariumZoomFor(-1)).toBe(10)
  })

  it('10km 视野取 z12~z13（SRTM 30m 源的甜点区）', () => {
    const z = terrariumZoomFor(0.1)
    expect(z).toBeGreaterThanOrEqual(12)
    expect(z).toBeLessThanOrEqual(13)
  })
})
