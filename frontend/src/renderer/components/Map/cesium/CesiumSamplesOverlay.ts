/**
 * Cesium「原始采样」热力覆盖层——对等 2D 的 `OriginalSamplesLayer`。
 *
 * 2D 的原始采样是**屏幕空间逐点色斑**：半径按当前 zoom 的米/像素换算、上限若干像素、
 * 最近邻防重叠，缩放时随地图重投影重画。3D 必须用同一套口径，否则同一份数据在两端
 * 会完全两个样子（栅格模式两端共用同一张栅格，所以只有"原始采样"会出现这种差异）。
 *
 * 因此这里**不走栅格贴图**，而是：
 * - 一张贴满地图容器的屏幕空间 canvas，画法与 2D 共用 `utils/sampleBlobDraw`
 * - 相机每帧变化（`scene.postRender`）就按当前相机重投影重画 —— 与 2D 的
 *   "zoom/move 后重投影重绘"同语义
 * - 米/像素取**该点局部**的透视尺度（2D 无透视，正俯视时两者一致；斜视时近大远小，
 *   这是 3D 本身应有的表现）
 *
 * 坐标：WGS84（Cesium 场景基准）。
 */
import type { HeatPoint } from '../../../utils/heatmap'
import type { HeatBoundary } from '../../../utils/heatSurface'
import { layoutSampleBlobs, type ProjectedPoint } from '../../../utils/sampleBlobLayout'
import {
  drawSampleBlobs,
  SAMPLE_BLOB_R_MIN_PX,
  sampleBlobRMax,
} from '../../../utils/sampleBlobDraw'

/** 逐点渲染输入（与 2D `OriginalSamplesData` 同构） */
export interface CesiumSampleBlobData {
  points: HeatPoint[]
  /** 逐点地理半径（米，与 points 对齐） */
  pointRadii: Float64Array
  /** 值 → 色带位置 0~1 */
  mapValue: (v: number) => number
  /** 色带 RGBA LUT（buildGradientLut 产物） */
  lut: Uint8ClampedArray
  /** 整体不透明度 0~1 */
  opacity: number
  /** 边界裁剪多边形（[lng,lat]，evenodd），null=不裁剪 */
  boundary: HeatBoundary | null
  /** 细节增强 0~100 */
  detail: number
  /** 离散分级数（≥2 时硬色环；0=连续） */
  discreteLevels: number
  /** 平滑强度 1~10：与屏幕半径上限联动 */
  smooth?: number
}

export class CesiumSamplesOverlay {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private data: CesiumSampleBlobData | null = null
  /** 上次 backing 尺寸（CSS 像素），尺寸变了才重建 backing（重建会清空画布） */
  private cssW = 0
  private cssH = 0
  /**
   * 逐点笛卡尔坐标缓存（WGS84 椭球面，每点 3 个分量）。
   *
   * 绘制路径是**每帧 × 每点**：不缓存的话每次重画都要对全部点重跑一遍
   * `Cartesian3.fromDegrees`（三角函数 + 对象分配）。点集是静态的，换数据时算一次即可。
   */
  private cartesians: Float64Array | null = null
  /** 预计算失败（拿不到笛卡尔坐标）时退化为每帧现算，见 ensureCartesians */
  private cartesianFallback = false
  /**
   * 复用给遮挡剔除的坐标替身（避免每帧每点分配）。
   * `EllipsoidalOccluder.isPointVisible` 只读 x/y/z（平面点积），普通对象即可，
   * 也不依赖 Cesium 构造器在极端环境下的可用性。
   */
  private scratch = { x: 0, y: 0, z: 0 }

  constructor(
    private C: any,
    private viewer: any,
    host?: HTMLElement | null,
  ) {
    if (!host) return
    const canvas = document.createElement('canvas')
    canvas.style.position = 'absolute'
    canvas.style.left = '0'
    canvas.style.top = '0'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.pointerEvents = 'none'
    host.appendChild(canvas)
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
  }

  /** 数据/设置变化：替换并重画。传 null 清空（切回栅格模式时用） */
  setData(data: CesiumSampleBlobData | null): void {
    this.data = data
    this.cartesians = null // 点集变了，缓存失效
    this.cartesianFallback = false
    this.drawNow()
  }

  /**
   * 预计算逐点笛卡尔坐标（换数据后第一次绘制时算一次）。
   *
   * 放在绘制路径里懒加载（而不是 setData 里算）：jsdom / 无 2D 上下文的环境下
   * drawNow 会提前返回，碰不到这里的 Cesium 调用。
   */
  private ensureCartesians(): boolean {
    const data = this.data
    if (!data || data.points.length === 0) return false
    if (this.cartesians) return true
    if (this.cartesianFallback) return false
    try {
      const n = data.points.length
      const arr = new Float64Array(n * 3)
      for (let i = 0; i < n; i++) {
        const p = data.points[i]
        const c = this.C.Cartesian3.fromDegrees(p.lng, p.lat, 0)
        arr[i * 3] = c.x
        arr[i * 3 + 1] = c.y
        arr[i * 3 + 2] = c.z
      }
      this.cartesians = arr
      return true
    } catch {
      this.cartesianFallback = true
      return false
    }
  }

  /** 相机变化后重画（宿主在 postRender 里调用） */
  drawNow(): void {
    const canvas = this.canvas
    const ctx = this.ctx
    if (!canvas || !ctx) return
    const viewer = this.viewer
    const scene = viewer?.scene
    if (!scene) return

    const w = canvas.clientWidth || viewer.canvas?.clientWidth || 0
    const h = canvas.clientHeight || viewer.canvas?.clientHeight || 0
    if (!(w > 0) || !(h > 0)) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (this.cssW !== w || this.cssH !== h
      || canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      // 重设 width/height 自动清空 backing
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      this.cssW = w
      this.cssH = h
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const data = this.data
    if (!data) return
    const { points, pointRadii, mapValue, lut, opacity, boundary, detail, discreteLevels, smooth } =
      data
    if (points.length === 0) return

    const C = this.C
    const rMax = sampleBlobRMax(smooth)
    const camera = viewer.camera
    const fovy = camera?.frustum?.fovy ?? Math.PI / 3
    const tanHalfFovy = Math.tan(fovy / 2)
    const camPos = camera.positionWC
    // 地平线遮挡：地球背面的点必须剔除（2D 没有遮挡问题，3D 不剔除会画到屏幕另一端）
    const occluder = new C.EllipsoidalOccluder(scene.globe?.ellipsoid ?? C.Ellipsoid.WGS84, camPos)
    // 逐点笛卡尔坐标缓存（静态点集只算一次）；拿不到时退化为每帧现算
    const cart = this.ensureCartesians() ? this.cartesians : null

    const projected: ProjectedPoint[] = []
    for (let i = 0; i < points.length; i++) {
      const p = points[i]
      let cx: number
      let cy: number
      let cz: number
      if (cart) {
        cx = cart[i * 3]
        cy = cart[i * 3 + 1]
        cz = cart[i * 3 + 2]
      } else {
        const c = C.Cartesian3.fromDegrees(p.lng, p.lat, 0)
        cx = c.x
        cy = c.y
        cz = c.z
      }
      // 遮挡剔除**放在投影之前**：它是一个点积，而投影要跑一整套矩阵运算 + 分配。
      // 万级点集缩放时视口内通常只有几百个点，先剔除可省掉绝大部分投影开销
      this.scratch.x = cx
      this.scratch.y = cy
      this.scratch.z = cz
      if (!occluder.isPointVisible(this.scratch)) continue
      const cartesian = new C.Cartesian3(cx, cy, cz)
      const sp = C.SceneTransforms.worldToWindowCoordinates(scene, cartesian)
      if (!sp) continue
      if (sp.x < -rMax || sp.y < -rMax || sp.x > w + rMax || sp.y > h + rMax) continue
      // 该点处的局部"米/像素"：2D 用 zoom 的定值，3D 用该点深度上的透视尺度
      const dist = C.Cartesian3.distance(camPos, cartesian)
      const metersPerPixel = (2 * dist * tanHalfFovy) / h
      if (!(metersPerPixel > 0)) continue
      const baseR = pointRadii[i] / metersPerPixel
      if (!(baseR > 0.05)) continue
      const t = mapValue(p.weight)
      projected.push({ x: sp.x, y: sp.y, baseR, tc: t <= 0 ? 0 : t >= 1 ? 1 : t })
    }

    const items = layoutSampleBlobs(projected, { rMin: SAMPLE_BLOB_R_MIN_PX, rMax })
    drawSampleBlobs(ctx, items, {
      lut,
      opacity,
      detail,
      discreteLevels,
      buildClip: this.buildClipPath(boundary, occluder),
    })
  }

  /** 边界裁剪路径（窗口像素环 + evenodd，与 2D 的 layerPoint 环同规则） */
  private buildClipPath(
    boundary: HeatBoundary | null,
    occluder: any,
  ): ((ctx: CanvasRenderingContext2D) => void) | null {
    if (!boundary || boundary.length === 0) return null
    const scene = this.viewer?.scene
    if (!scene) return null
    return (c) => {
      for (const polygon of boundary) {
        for (const ring of polygon) {
          let started = false
          for (const [lng, lat] of ring) {
            const cartesian = this.C.Cartesian3.fromDegrees(lng, lat, 0)
            if (!occluder.isPointVisible(cartesian)) continue
            const sp = this.C.SceneTransforms.worldToWindowCoordinates(scene, cartesian)
            if (!sp) continue
            if (started) c.lineTo(sp.x, sp.y)
            else { c.moveTo(sp.x, sp.y); started = true }
          }
          if (started) c.closePath()
        }
      }
    }
  }

  destroy(): void {
    this.data = null
    this.cartesians = null
    if (this.canvas?.parentNode) this.canvas.parentNode.removeChild(this.canvas)
    this.canvas = null
    this.ctx = null
  }
}
