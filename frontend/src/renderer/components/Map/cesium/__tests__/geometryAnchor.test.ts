/**
 * 3D 几何锚点 / 质心 与 2D 口径一致（2026-10-14 用户报"较大的多边形要素标签显示在图形边框位置"）。
 *
 * 2D 的两个口径（务必一致，别混用）：
 * - 标签锚点 `MapInfoLayer._labelAnchorFromGeometry`：点=自身；线/面/Multi=**包围盒中心**
 *   （Leaflet `layer.getBounds().getCenter()`）
 * - 热力取点 `MapInfoLayer.geometryCentroid`：**全部顶点算术平均**（质心）
 *
 * 3D 早先两处都取"第一个坐标"，多边形就是外环首顶点 → 标签/热点贴在图形角上。
 */
import { describe, expect, it } from 'vitest'
import { geometryAnchor, geometryCentroid } from '../cesiumGeoJson'

/** 一个明显不对称的四边形（首顶点在左下角） */
const QUAD = {
  type: 'Polygon',
  coordinates: [[[110.0, 20.0], [110.0, 26.0], [118.0, 26.0], [118.0, 20.0], [110.0, 20.0]]],
}

describe('geometryAnchor（标签锚点 = 包围盒中心，对齐 2D MapInfoLayer）', () => {
  it('点要素取自身坐标', () => {
    expect(geometryAnchor({ type: 'Point', coordinates: [114.7, 23.7] })).toEqual([114.7, 23.7])
  })

  it('多边形取包围盒中心——不是外环首顶点（本次修复的正是这一条）', () => {
    const a = geometryAnchor(QUAD)!
    expect(a[0]).toBeCloseTo(114.0, 6)   // (110 + 118) / 2
    expect(a[1]).toBeCloseTo(23.0, 6)    // (20 + 26) / 2
    // 首顶点是 [110, 20]，若退回"取第一个坐标"会在角上
    expect(a).not.toEqual([110, 20])
  })

  it('线要素同样取包围盒中心', () => {
    const a = geometryAnchor({ type: 'LineString', coordinates: [[110, 20], [118, 26]] })!
    expect(a).toEqual([114, 23])
  })

  it('MultiPolygon 取整体包围盒中心（跨所有子几何）', () => {
    const a = geometryAnchor({
      type: 'MultiPolygon',
      coordinates: [
        [[[110, 20], [111, 21], [110, 21], [110, 20]]],
        [[[117, 25], [118, 26], [117, 26], [117, 25]]],
      ],
    })!
    expect(a[0]).toBeCloseTo(114, 6)  // (110 + 118) / 2
    expect(a[1]).toBeCloseTo(23, 6)   // (20 + 26) / 2
  })

  it('空几何 / 非法坐标返回 null', () => {
    expect(geometryAnchor({ type: 'LineString', coordinates: [] })).toBe(null)
    expect(geometryAnchor({ type: 'Polygon', coordinates: [['x', 'y']] })).toBe(null)
  })
})

describe('geometryCentroid（热力取点 = 顶点算术平均，对齐 2D geometryCentroid）', () => {
  it('不规则多边形的质心 ≠ 包围盒中心（两者本就不同源）', () => {
    // 五个顶点挤在左下角、一个顶点在右上角：质心明显偏左下
    const poly = {
      type: 'Polygon',
      coordinates: [[[110, 20], [110.1, 20.1], [110.2, 20], [110.1, 19.9], [110.05, 20.05], [118, 26]]],
    }
    const c = geometryCentroid(poly)!
    const b = geometryAnchor(poly)!
    expect(c[0]).toBeLessThan(b[0])
    expect(c[1]).toBeLessThan(b[1])
  })

  it('均匀环的质心 = 各顶点平均', () => {
    const c = geometryCentroid({
      type: 'LineString',
      coordinates: [[110, 20], [112, 22], [114, 24]],
    })!
    expect(c[0]).toBeCloseTo(112, 6)
    expect(c[1]).toBeCloseTo(22, 6)
  })

  it('空几何返回 null', () => {
    expect(geometryCentroid({ type: 'Polygon', coordinates: [] })).toBe(null)
  })
})
