import { describe, it, expect } from 'vitest'
import {
  analyzeRingInRect,
  alignRingToReference,
  type MMPoint,
  type MMRect,
} from '../nodeMergeGeometry'

// P(lat, lng)：竖边 = lng 恒定、lat 变化
const P = (lat: number, lng: number): MMPoint => ({ lat, lng })

/** 框选矩形：夹住东侧竖边 lng≥10 的中段 lat∈[2,8]（典型"相邻边框对齐"场景） */
const RECT: MMRect = { south: 2, west: 8, north: 8, east: 12 }

describe('analyzeRingInRect', () => {
  it('开放线 外→内→外：single，entry/exit 正确（含同边两穿）', () => {
    // 先沿 lng0 北上，再沿 lat0 东行：竖边 lng10 扫过矩形
    const ring = [P(0, 0), P(0, 10), P(10, 10)]
    const a = analyzeRingInRect(ring, false, RECT)
    expect(a.status).toBe('single')
    expect(a.crossings).toHaveLength(2)
    expect(a.crossings[0].enter).toBe(true)
    expect(a.crossings[1].enter).toBe(false)
    // 竖边 (lat0,lng10)→(lat10,lng10) 同边穿入 lat=2、穿出 lat=8
    expect(a.crossings[0].pt).toMatchObject({ lat: 2, lng: 10 })
    expect(a.crossings[1].pt).toMatchObject({ lat: 8, lng: 10 })
  })

  it('完全不相交 → none', () => {
    const ring = [P(-5, -5), P(-4, -4)]
    expect(analyzeRingInRect(ring, false, RECT).status).toBe('none')
  })

  it('整条线在框内 → none（全包含，跳过）', () => {
    const ring = [P(3, 9), P(7, 11)]
    expect(analyzeRingInRect(ring, false, RECT).status).toBe('none')
  })

  it('多次进出（W 形 6 交点）→ ambiguous', () => {
    // lat 3/5/7 均在 [2,8] 内，lng 在 5↔10 间往返 → 每横边一穿，共 6 个
    const ring = [P(3, 5), P(3, 10), P(5, 5), P(5, 10), P(7, 5), P(7, 10)]
    expect(analyzeRingInRect(ring, false, RECT).status).toBe('ambiguous')
  })

  it('开放线起点在框内（内→外→内）→ ambiguous', () => {
    const ring = [P(3, 9), P(3, 0), P(7, 0), P(7, 9)]
    expect(analyzeRingInRect(ring, false, RECT).status).toBe('ambiguous')
  })

  it('闭合矩形环东边在框内 → single（同边两穿，一进一出）', () => {
    // 顺时针矩形：西南→东南→东北→西北
    const ring = [P(0, 0), P(0, 10), P(10, 10), P(10, 0)]
    const a = analyzeRingInRect(ring, true, RECT)
    expect(a.status).toBe('single')
    expect(a.crossings[0].enter).toBe(true)
    expect(a.crossings[1].enter).toBe(false)
  })

  it('闭合环框内段跨索引 0（沿边序先遇 exit）也能识别为 single', () => {
    // 角部矩形包住东北角，环从东北起笔，exit 在 e0、entry 在闭合边
    const cornerRect: MMRect = { south: 8, west: 8, north: 12, east: 12 }
    const ring = [P(10, 10), P(10, 0), P(0, 0), P(0, 10)]
    const a = analyzeRingInRect(ring, true, cornerRect)
    expect(a.status).toBe('single')
    expect(a.crossings[0].enter).toBe(true)
  })
})

describe('alignRingToReference - 开放线', () => {
  // 可编辑：东侧竖边在同一条长边上（无框内中间顶点）
  const editable = [P(0, 0), P(0, 10), P(10, 10)]
  // 参考：东侧竖边带 3 个框内顶点
  const ref = [P(0, 0), P(0, 10), P(3, 10), P(5, 10), P(7, 10), P(10, 10)]

  it('以参考节点为准补点：结果框内段节点与参考完全一致', () => {
    const r = alignRingToReference(editable, ref, false, RECT)
    expect(r.ok).toBe(true)
    expect(r.ring).toEqual([
      P(0, 0), P(0, 10), // 框外前段保留
      P(2, 10),                         // 参考入口交点
      P(3, 10), P(5, 10), P(7, 10),    // 参考框内节点
      P(8, 10),                         // 参考出口交点
      P(10, 10),                        // 框外后顶点保留
    ])
    // 开放线不追加闭合点
    expect(r.ring![0]).not.toEqual(r.ring![r.ring!.length - 1])
  })

  it('可编辑节点过多时删点：结果仍与参考段一致', () => {
    // 框内 5 个多余中间节点（避开 rect 的 lat=2/8 边界，防止顶点压边退化）
    const dense = [P(0, 0), P(0, 10), P(1, 10), P(3, 10), P(4, 10), P(5, 10), P(6, 10), P(7, 10), P(9, 10), P(10, 10)]
    const r = alignRingToReference(dense, ref, false, RECT)
    expect(r.ok).toBe(true)
    expect(r.ring).toEqual([
      P(0, 0), P(0, 10), P(1, 10),
      P(2, 10),
      P(3, 10), P(5, 10), P(7, 10),
      P(8, 10),
      P(9, 10), P(10, 10),
    ])
  })

  it('参考方向相反时自动反向匹配', () => {
    const refReverse = [...ref].reverse()
    const r = alignRingToReference(editable, refReverse, false, RECT)
    expect(r.ok).toBe(true)
    // 沿可编辑方向（南→北）结果与正向参考一致
    expect(r.ring).toEqual([
      P(0, 0), P(0, 10),
      P(2, 10),
      P(3, 10), P(5, 10), P(7, 10),
      P(8, 10),
      P(10, 10),
    ])
  })

  it('可编辑无单段进出 → ok=false', () => {
    const r = alignRingToReference([P(-5, -5), P(-4, -4)], ref, false, RECT)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('editable-not-single')
  })

  it('参考全包含（none）→ ok=false', () => {
    const r = alignRingToReference(editable, [P(3, 9), P(7, 11)], false, RECT)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('reference-not-single')
  })
})

describe('alignRingToReference - 闭合面', () => {
  // 顺时针矩形，东边 lng10
  const editable = [P(0, 0), P(0, 10), P(10, 10), P(10, 0)]
  // 参考矩形：东边多 2 个节点
  const ref = [P(0, 0), P(0, 10), P(4, 10), P(6, 10), P(10, 10), P(10, 0)]

  it('替换框内段、保留框外段，节点数 = 参考段 + 框外边', () => {
    const r = alignRingToReference(editable, ref, true, RECT)
    expect(r.ok).toBe(true)
    // 同边两穿：竖边起点 (0,10)/终点 (10,10) 均在框外，都属框外段保留顶点
    expect(r.ring).toEqual([
      P(2, 10),
      P(4, 10), P(6, 10),
      P(8, 10),
      P(10, 10), P(10, 0), P(0, 0), P(0, 10),
    ])
    // 返回开放环（调用方负责补闭合点）
    expect(r.ring![0]).not.toEqual(r.ring![r.ring!.length - 1])
  })

  it('框内段跨索引 0（角部矩形）时仍正确组装', () => {
    const cornerRect: MMRect = { south: 8, west: 8, north: 12, east: 12 }
    // 从东北起笔：exit 在北边 e0、entry 在东边闭合边
    const ed2 = [P(10, 10), P(10, 0), P(0, 0), P(0, 10)]
    // 参考：东边上多 (lat9,lng10) 节点
    const rf2 = [P(10, 10), P(9, 10), P(6, 10), P(4, 10), P(0, 10), P(0, 0), P(10, 0)]
    const r = alignRingToReference(ed2, rf2, true, cornerRect)
    expect(r.ok).toBe(true)
    expect(r.ring).toEqual([
      P(8, 10),            // 参考入口（东边 lat8）
      P(9, 10), P(10, 10), // 参考框内顶点（沿匹配方向）
      P(10, 8),            // 参考出口（北边 lng8）
      P(10, 0), P(0, 0), P(0, 10), // 框外顶点
    ])
  })
})
