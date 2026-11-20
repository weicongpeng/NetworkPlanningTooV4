/**
 * 原始采样点色斑绘制（2D `OriginalSamplesLayer` 与 3D `CesiumSamplesOverlay` **共用**）
 *
 * 抽出来而不是各写一份，是为了保证两端"原始采样"渲染出的斑**逐像素同源**：
 * 半径档位、色带层次跨度、离散色环、边缘羽化全部在这里，改一处两端同时生效。
 */
import type { LaidBlob } from './sampleBlobLayout'

/** 最小像素半径（低于此仍画成小点，避免密集区斑消失） */
export const SAMPLE_BLOB_R_MIN_PX = 1.5
/** 屏幕半径上限基数（px） */
export const SAMPLE_BLOB_R_MAX_BASE = 20
/** 平滑强度对半径上限的系数：rMax = 20 + smooth×3（smooth 1→23px、10→50px） */
export const SAMPLE_BLOB_R_MAX_SMOOTH_K = 3

/** 屏幕空间斑半径上限：放大后斑不再变大 */
export function sampleBlobRMax(smooth: number | undefined): number {
  const n = Math.min(10, Math.max(1, smooth ?? 4))
  return SAMPLE_BLOB_R_MAX_BASE + n * SAMPLE_BLOB_R_MAX_SMOOTH_K
}

export interface SampleBlobDrawOptions {
  /** 色带 RGBA LUT（buildGradientLut 产物，256 色） */
  lut: Uint8ClampedArray
  /** 整体不透明度 0~1 */
  opacity: number
  /** 细节增强 0~100：单点色斑沿色带向下的颜色层次跨度 */
  detail: number
  /** 离散分级数（≥2 时形成硬色环；0=连续） */
  discreteLevels: number
  /**
   * 边界裁剪路径：由调用方按自己的坐标系投影后绘制（evenodd，支持多面/洞）。
   * 不传 = 不裁剪。
   */
  buildClip?: ((ctx: CanvasRenderingContext2D) => void) | null
}

/** 径向分段数：连续梯度呈现色带的色相环，离散时相邻段同色形成硬色环 */
const RADIAL_STEPS = 10

export function drawSampleBlobs(
  ctx: CanvasRenderingContext2D,
  items: LaidBlob[],
  opts: SampleBlobDrawOptions,
): void {
  const { lut, opacity, detail, discreteLevels, buildClip } = opts
  const a0 = opacity <= 0 ? 0 : opacity >= 1 ? 1 : opacity
  if (a0 === 0 || items.length === 0) return

  // 细节增强 → 颜色层次跨度：色斑从中心 t=tc 沿色带向低端过渡，
  // detail=0 仅微降（近似单色柔和斑），detail=100 几乎降到色带底端（完整色环层次）
  const span = 0.05 + 0.9 * Math.min(1, Math.max(0, detail / 100))

  ctx.save()
  if (buildClip) {
    ctx.beginPath()
    buildClip(ctx)
    ctx.clip('evenodd')
  }

  for (const it of items) {
    const grad = ctx.createRadialGradient(it.x, it.y, 0, it.x, it.y, it.r)
    for (let s = 0; s <= RADIAL_STEPS; s++) {
      const f = s / RADIAL_STEPS
      let t = it.tc * (1 - span * f)
      // 离散分级：量化到 N 级 → 同心硬色环
      if (discreteLevels >= 2) t = Math.floor(t * discreteLevels) / discreteLevels
      const li = (t <= 0 ? 0 : t >= 1 ? 255 : (t * 255) | 0) << 2
      // 不透明度：中心 60% 半径内保持 opacity 完全不透明，仅外缘 40% smoothstep 羽化
      let af: number
      if (f <= 0.6) {
        af = a0
      } else {
        const g = (f - 0.6) / 0.4
        af = a0 * (1 - g * g * (3 - 2 * g))
      }
      grad.addColorStop(f, `rgba(${lut[li]},${lut[li + 1]},${lut[li + 2]},${af})`)
    }
    ctx.beginPath()
    ctx.fillStyle = grad
    ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}
