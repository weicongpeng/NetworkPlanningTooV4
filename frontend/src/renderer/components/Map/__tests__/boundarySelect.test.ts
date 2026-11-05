/**
 * "边界选择"纯函数 helper 测试
 *
 * 覆盖：面几何识别、Polygon/MultiPolygon → 外环拆解（坐标顺序保持）、
 * 跨外环/跨图层命中按 id 去重合并。
 */
import { describe, it, expect } from 'vitest'
import {
  isPolygonGeometry,
  boundaryOuterRings,
  mergeById,
  geometryAnchor,
} from '../../../services/boundarySelection'

describe('isPolygonGeometry', () => {
  it('Polygon / MultiPolygon 返回 true', () => {
    expect(isPolygonGeometry({ type: 'Polygon', coordinates: [] })).toBe(true)
    expect(isPolygonGeometry({ type: 'MultiPolygon', coordinates: [] })).toBe(true)
  })

  it('Point / LineString 等非面几何返回 false', () => {
    expect(isPolygonGeometry({ type: 'Point', coordinates: [] })).toBe(false)
    expect(isPolygonGeometry({ type: 'LineString', coordinates: [] })).toBe(false)
    expect(isPolygonGeometry({ type: 'MultiLineString', coordinates: [] })).toBe(false)
  })

  it('null / undefined / 无 type 返回 false', () => {
    expect(isPolygonGeometry(null)).toBe(false)
    expect(isPolygonGeometry(undefined)).toBe(false)
    expect(isPolygonGeometry({})).toBe(false)
  })
})

describe('boundaryOuterRings', () => {
  it('Polygon 返回 1 个外环（取 coordinates[0]，点顺序保持）', () => {
    const ring = [[114.7, 23.7], [114.8, 23.7], [114.8, 23.8], [114.7, 23.7]]
    const rings = boundaryOuterRings({ type: 'Polygon', coordinates: [ring, [[114.72, 23.72]]] })
    expect(rings).toHaveLength(1)
    expect(rings[0]).toBe(ring) // 外环引用与点顺序不被改动
  })

  it('MultiPolygon 返回每个 polygon 的外环', () => {
    const ringA = [[114.7, 23.7], [114.8, 23.7], [114.7, 23.7]]
    const ringB = [[115.7, 24.7], [115.8, 24.7], [115.7, 24.7]]
    const rings = boundaryOuterRings({
      type: 'MultiPolygon',
      coordinates: [[ringA], [ringB], []], // 第三个空 polygon 被过滤
    })
    expect(rings).toHaveLength(2)
    expect(rings[0]).toBe(ringA)
    expect(rings[1]).toBe(ringB)
  })

  it('非面几何 / 异常坐标返回空数组', () => {
    expect(boundaryOuterRings({ type: 'Point', coordinates: [1, 2] })).toEqual([])
    expect(boundaryOuterRings(null)).toEqual([])
    expect(boundaryOuterRings({ type: 'Polygon', coordinates: [] })).toEqual([])
  })
})

describe('geometryAnchor', () => {
  it('Point 返回自身坐标（[lng,lat] → {lat,lng}）', () => {
    expect(geometryAnchor({ type: 'Point', coordinates: [114.7, 23.7] }))
      .toEqual({ lat: 23.7, lng: 114.7 })
  })

  it('LineString：返回全部顶点包围盒中心（非顶点平均）', () => {
    // 顶点 lng 范围 114~115、lat 范围 23~24（含偏内点，证明是包围盒中心而非顶点平均）
    const a = geometryAnchor({
      type: 'LineString',
      coordinates: [[114.0, 23.0], [114.2, 24.0], [115.0, 23.2]],
    })
    expect(a).toEqual({ lat: 23.5, lng: 114.5 })
  })

  it('Polygon（不规则）：外环全部顶点包围盒中心', () => {
    const a = geometryAnchor({
      type: 'Polygon',
      coordinates: [[
        [114.0, 23.0], [115.0, 23.0], [115.0, 24.0],
        [114.2, 24.0], [114.0, 23.0],
      ]],
    })
    expect(a).toEqual({ lat: 23.5, lng: 114.5 })
  })

  it('MultiPolygon：所有部分顶点合并后的包围盒中心', () => {
    const a = geometryAnchor({
      type: 'MultiPolygon',
      coordinates: [
        [[[114.0, 23.0], [114.0, 23.0]]],
        [[[115.0, 24.0], [115.0, 24.0]]],
      ],
    })
    expect(a).toEqual({ lat: 23.5, lng: 114.5 })
  })

  it('null / 无有效坐标返回 null', () => {
    expect(geometryAnchor(null)).toBe(null)
    expect(geometryAnchor({ type: 'LineString', coordinates: [] })).toBe(null)
  })
})

describe('mergeById', () => {
  it('按 id 去重合并：重复 id 只保留首次的属性', () => {
    const dst: { ids: Set<string>, props: any[] } = { ids: new Set<string>(), props: [] }
    mergeById(dst, [
      { id: '1', properties: { name: 'first' } },
      { id: '2', properties: { name: 'second' } },
    ])
    // 模拟 MultiPolygon 另一外环的重复命中（id=1）+ 新命中（id=3）
    mergeById(dst, [
      { id: '1', properties: { name: 'duplicate' } },
      { id: '3', properties: { name: 'third' } },
    ])
    expect(Array.from(dst.ids).sort()).toEqual(['1', '2', '3'])
    expect(dst.props).toHaveLength(3)
    expect(dst.props.find((p: any) => p.name === 'first')).toBeTruthy()
    expect(dst.props.find((p: any) => p.name === 'duplicate')).toBeFalsy()
  })

  it('空 id 的项被跳过', () => {
    const dst: { ids: Set<string>, props: any[] } = { ids: new Set<string>(), props: [] }
    mergeById(dst, [{ id: '', properties: { x: 1 } }])
    expect(dst.ids.size).toBe(0)
    expect(dst.props).toHaveLength(0)
  })
})
