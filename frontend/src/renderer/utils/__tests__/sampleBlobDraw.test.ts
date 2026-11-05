/**
 * 原始采样色斑绘制（2D OriginalSamplesLayer 与 3D CesiumSamplesOverlay 共用）
 *
 * 重点锁"两端同源"这件事本身：半径档位与绘制细节只有一份实现，
 * 任一端改画法都会同时改到另一端，不会出现"3D 和 2D 长得不一样"。
 */
import { describe, expect, it } from 'vitest'
import { drawSampleBlobs, sampleBlobRMax } from '../sampleBlobDraw'
import { layoutSampleBlobs } from '../sampleBlobLayout'

/** 记录调用的假 2D 上下文（jsdom 无 canvas，用桩替代） */
function fakeCtx() {
  const stops: Array<{ offset: number; color: string }> = []
  const calls: string[] = []
  return {
    stops,
    calls,
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    beginPath: () => calls.push('beginPath'),
    closePath: () => calls.push('closePath'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    arc: () => calls.push('arc'),
    fill: () => calls.push('fill'),
    clip: (rule: string) => calls.push(`clip:${rule}`),
    set fillStyle(_v: unknown) { /* ignore */ },
    createRadialGradient: () => ({
      addColorStop: (offset: number, color: string) => stops.push({ offset, color }),
    }),
  } as unknown as CanvasRenderingContext2D & {
    stops: Array<{ offset: number; color: string }>
    calls: string[]
  }
}

const LUT = new Uint8ClampedArray(256 * 4)
for (let i = 0; i < 256; i++) { LUT[i * 4] = i; LUT[i * 4 + 1] = 0; LUT[i * 4 + 2] = 0; LUT[i * 4 + 3] = 255 }

describe('sampleBlobRMax', () => {
  it('屏幕半径上限与平滑强度联动（smooth 1→23px、10→50px）', () => {
    expect(sampleBlobRMax(1)).toBe(23)
    expect(sampleBlobRMax(10)).toBe(50)
    // 与 2D 原常量口径一致：20 + smooth×3
    expect(sampleBlobRMax(9)).toBe(47)
  })
})

describe('drawSampleBlobs', () => {
  it('中心不透明度 = 设置值，外缘羽化到 0', () => {
    const ctx = fakeCtx()
    drawSampleBlobs(ctx, [{ x: 10, y: 10, r: 20, tc: 1 }], {
      lut: LUT, opacity: 0.8, detail: 95, discreteLevels: 0,
    })
    const alphaOf = (c: string) => Number(c.split(',')[3].replace(')', ''))
    expect(ctx.stops.length).toBe(11)
    expect(alphaOf(ctx.stops[0].color)).toBeCloseTo(0.8, 5)
    expect(alphaOf(ctx.stops[ctx.stops.length - 1].color)).toBeCloseTo(0, 5)
  })

  it('给了裁剪路径就按 evenodd 裁剪（与栅格掩膜同规则）', () => {
    const ctx = fakeCtx()
    drawSampleBlobs(ctx, [{ x: 0, y: 0, r: 5, tc: 0.5 }], {
      lut: LUT, opacity: 1, detail: 95, discreteLevels: 0,
      buildClip: (c) => { c.moveTo(0, 0); c.lineTo(1, 1) },
    })
    expect(ctx.calls).toContain('clip:evenodd')
  })

  it('离散分级：色带位置量化成硬色环（相邻段同色）', () => {
    const ctx = fakeCtx()
    drawSampleBlobs(ctx, [{ x: 0, y: 0, r: 5, tc: 1 }], {
      lut: LUT, opacity: 1, detail: 95, discreteLevels: 4,
    })
    const reds = ctx.stops.map((s) => Number(s.color.slice(5).split(',')[0]))
    // 量化到 4 级：每个色带位置都落在 k/4 上（相邻段同色 → 硬色环）
    const step = 255 / 4
    for (const r of reds) {
      expect(Math.abs(r / step - Math.round(r / step))).toBeLessThan(0.02)
    }
    // 连续渐变档位远多于离散档（对照组：不量化时层次是连续变化的）
    const cont = fakeCtx()
    drawSampleBlobs(cont, [{ x: 0, y: 0, r: 5, tc: 1 }], {
      lut: LUT, opacity: 1, detail: 95, discreteLevels: 0,
    })
    const contReds = new Set(cont.stops.map((s) => Number(s.color.slice(5).split(',')[0])))
    expect(contReds.size).toBeGreaterThan(new Set(reds).size)
  })

  it('与 layoutSampleBlobs 串起来即得 2D/3D 共用的同一条渲染链路', () => {
    const items = layoutSampleBlobs(
      [{ x: 0, y: 0, baseR: 100, tc: 0.5 }, { x: 10, y: 0, baseR: 100, tc: 0.5 }],
      { rMin: 1.5, rMax: sampleBlobRMax(9) },
    )
    // 相邻 10px 的点被收缩到互不重叠（每斑 ≤5px）
    expect(items).toHaveLength(2)
    for (const it of items) expect(it.r).toBeLessThanOrEqual(5)
    const ctx = fakeCtx()
    expect(() => drawSampleBlobs(ctx, items, {
      lut: LUT, opacity: 1, detail: 95, discreteLevels: 0,
    })).not.toThrow()
  })
})
