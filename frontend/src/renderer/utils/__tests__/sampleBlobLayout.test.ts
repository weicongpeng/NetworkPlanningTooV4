import { describe, it, expect } from 'vitest'
import { layoutSampleBlobs, type ProjectedPoint } from '../sampleBlobLayout'

const OPTS = { rMin: 1.5, rMax: 50 }

function pts(...coords: [number, number, number?][]): ProjectedPoint[] {
  return coords.map(([x, y, r]) => ({ x, y, baseR: r ?? 20, tc: 0.5 }))
}

describe('layoutSampleBlobs', () => {
  it('空输入返回空数组', () => {
    expect(layoutSampleBlobs([], OPTS)).toEqual([])
  })

  it('坐标完全重合的多点合并为一个', () => {
    const out = layoutSampleBlobs(
      pts([100, 100], [100, 100], [100.2, 99.9]),
      OPTS
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ x: 100, y: 100 })
  })

  it('稀疏远点：期望半径未超上限时 r 取 min(baseR, rMax)', () => {
    const out = layoutSampleBlobs(pts([0, 0, 30], [10000, 10000, 80]), OPTS)
    expect(out[0].r).toBe(30)
    expect(out[1].r).toBe(50) // baseR=80 被 rMax 钳制
  })

  it('极小半径抬到 rMin', () => {
    const out = layoutSampleBlobs(pts([0, 0, 0.1], [10000, 0, 0.2]), OPTS)
    expect(out[0].r).toBe(1.5)
    expect(out[1].r).toBe(1.5)
  })

  it('规则格网点：任意两斑边缘不重叠', () => {
    const input: ProjectedPoint[] = []
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 20; j++) {
        input.push({ x: i * 12, y: j * 12, baseR: 40, tc: 0.5 })
      }
    }
    const out = layoutSampleBlobs(input, OPTS)
    expect(out).toHaveLength(400)
    // 格网间距 12 → r ≤ 6；检查所有点对
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const dx = out[i].x - out[j].x
        const dy = out[i].y - out[j].y
        const d = Math.hypot(dx, dy)
        expect(d + 1e-6).toBeGreaterThanOrEqual(out[i].r + out[j].r)
      }
    }
  })

  it('随机点：任意两斑边缘不重叠', () => {
    // 确定性伪随机
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const input: ProjectedPoint[] = []
    for (let i = 0; i < 600; i++) {
      input.push({ x: rand() * 800, y: rand() * 600, baseR: 25, tc: rand() })
    }
    const out = layoutSampleBlobs(input, OPTS)
    expect(out.length).toBeGreaterThan(300)
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const d = Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y)
        // 契约：相距 ≥ 2×rMin 的点对绝不重叠；更近的非重合点各自抬到 rMin，
        // 允许轻微重叠（亚 3px，视觉上只是小点）
        if (d >= 2 * OPTS.rMin) {
          expect(d + 1e-6).toBeGreaterThanOrEqual(out[i].r + out[j].r)
        }
      }
    }
    expect(out.every(b => b.r >= 1.5 && b.r <= 50)).toBe(true)
  })

  it('密集簇 + 孤立点：簇内收缩、孤立点不受影响', () => {
    const input: ProjectedPoint[] = [
      { x: 0, y: 0, baseR: 40, tc: 0.1 },
      { x: 6, y: 0, baseR: 40, tc: 0.2 },
      { x: 12, y: 0, baseR: 40, tc: 0.3 },
      { x: 3000, y: 3000, baseR: 40, tc: 0.9 },
    ]
    const out = layoutSampleBlobs(input, OPTS)
    expect(out).toHaveLength(4)
    const cluster = out.filter(b => b.x < 100)
    const isolated = out.find(b => b.x > 1000)!
    expect(cluster.every(b => b.r <= 3 + 1e-6)).toBe(true)
    expect(isolated.r).toBe(40)
  })

  it('50k 点性能 < 300ms（防退化回 O(n²)）', () => {
    let seed = 777
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const input: ProjectedPoint[] = []
    for (let i = 0; i < 50000; i++) {
      input.push({ x: rand() * 4000, y: rand() * 4000, baseR: 20, tc: rand() })
    }
    const t0 = performance.now()
    const out = layoutSampleBlobs(input, OPTS)
    const elapsed = performance.now() - t0
    expect(out.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(300)
  }, 10000)
})
