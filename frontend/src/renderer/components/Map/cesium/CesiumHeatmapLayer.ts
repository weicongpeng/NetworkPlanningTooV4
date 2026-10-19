/**
 * Cesium 值热力面图层。
 *
 * **栅格采样**（默认）与 2D **共用同一套计算与栅格化**（`computeHeatComputation` +
 * `renderHeatRaster`）：覆盖半径推导、分位基准、分级、色带、边界裁剪全部同源，所以同一个
 * 热力设置在两端渲染出的颜色分布与图例数字一致。差别只在"怎么贴这张图"：
 * - 2D：`L.ImageOverlay`（Leaflet 显示坐标 GCJ02）
 * - 3D：`SingleTileImageryProvider` 把同一张位图铺在同样的地理矩形上（Cesium 是 WGS84）
 *
 * **原始采样**不栅格化：2D 走 `OriginalSamplesLayer`（屏幕空间逐点色斑，随缩放重投影），
 * 3D 走 `CesiumSamplesOverlay`（同一套画法，随相机重投影）。两者共用
 * `utils/sampleBlobLayout` + `utils/sampleBlobDraw`，保证逐斑同源 ——
 * 早先 3D 不认 `sampleMode`、一律走 IDW 栅格，于是"原始采样"在两端完全是两种图。
 *
 * 坐标：本类只认 WGS84 点集与 WGS84 边界——Cesium 场景里扇区/图层都是按 WGS84 渲染的，
 * 用 WGS84 出图才能与它们严格对齐（2D 侧走 GCJ02，两边各自用自己显示链路的基准）。
 */
import {
  computeHeatComputation,
  renderHeatRaster,
  heatSettingsSignature,
  fingerprintHeatPoints,
} from '../HeatmapLayerManager'
import { DEFAULT_HEATMAP_SETTINGS, type HeatmapSettings } from '../LabelSettingsModal'
import type { HeatmapStats } from '../HeatmapLayerManager'
import type { HeatPoint } from '../../../utils/heatmap'
import type { HeatBoundary } from '../../../utils/heatSurface'
import { buildGradientLut, resolveHeatGradient, resolveLevelGradient } from '../../../utils/heatmap'
import { CesiumSamplesOverlay } from './CesiumSamplesOverlay'

export class CesiumHeatmapLayer {
  private layer: any = null
  /** 「原始采样」模式的逐点色斑覆盖层（栅格模式下为 null） */
  private samples: CesiumSamplesOverlay | null = null
  /** 是否有正在显示的「原始采样」色斑（供 render 判断能否跳过重算） */
  private samplesActive = false
  private stats: HeatmapStats | null = null
  /** 上次渲染的「设置 + 点集」指纹：不变就跳过 IDW 重算（很贵） */
  private sig = ''
  /** 是否已经尝试渲染过（含"范围退化画不出来"这种结果）——供宿主的幂等重放判断 */
  private rendered = false
  /**
   * 已销毁标记。
   * 宿主的渲染流程是异步的（取边界 → 等一帧 → 同步 IDW），期间本层可能已被移除销毁。
   * 没有这个标记时，那次迟到的 `render()` 会把图重新贴回去，且新贴的图层不在宿主的
   * 热力表里的 → 再也摘不掉（"热力关不掉，只能刷新页面"）。
   */
  private destroyed = false

  constructor(
    private C: any,
    private viewer: any,
    readonly layerId: string,
    /** 「原始采样」覆盖层的宿主容器（贴满地图的一层 div） */
    samplesHost?: HTMLElement | null,
  ) {
    if (samplesHost) {
      this.samples = new CesiumSamplesOverlay(C, viewer, samplesHost)
    }
  }

  /** 相机变化后重画「原始采样」色斑（宿主在 postRender 里调用；其它模式是空操作） */
  drawSamplesNow(): void {
    this.samples?.drawNow()
  }

  getStats(): HeatmapStats | null {
    return this.stats
  }

  /** 是否已尝试渲染过（宿主据此跳过"设置没变"的重复请求） */
  isRendered(): boolean {
    return this.rendered
  }

  /**
   * 渲染/更新热力面。
   * @returns 图例统计；无有效点或范围退化时返回 null（并移除既有图层）
   */
  render(
    points: HeatPoint[],
    settings: HeatmapSettings,
    boundary: HeatBoundary | null,
  ): HeatmapStats | null {
    if (this.destroyed) return null // 迟到的异步渲染：本层已销毁，不能再贴图
    this.rendered = true
    const sig = `${heatSettingsSignature(settings)}|${fingerprintHeatPoints(points)}|${boundary ? 'b' : '-'}`
    // 设置与点集都没变：保留现有图层，直接复用统计（缩放平移不重算）。
    // 原始采样没有 imagery layer，用 samplesActive 判断是否已有渲染
    if (sig === this.sig && (this.layer || this.samplesActive)) return this.stats

    const comp = computeHeatComputation(points, settings)
    if (!comp) {
      this.remove()
      return null
    }

    /**
     * 「原始采样」：与 2D 一样走**屏幕空间逐点色斑**，不栅格化。
     *
     * 栅格模式两端共用同一张栅格所以天然一致；原始采样在 2D 是随缩放重投影的逐点圆斑，
     * 若 3D 仍走 IDW 栅格（原实现），同一份数据两端就完全是两种图 —— 半径口径、
     * 是否跨点融合、缩放时是否变大都不同。这里改成与 2D 同一套覆盖层画法。
     */
    if (comp.isOriginal) {
      this.removeLayer()
      this.stats = comp.stats
      this.sig = sig
      this.rendered = true
      this.samplesActive = true
      this.samples?.setData({
        points: comp.normalized.points,
        pointRadii: comp.pointRadii,
        mapValue: comp.mapValue,
        // 色带与 2D `paintOriginal` 同构（含颜色方向镜像与自定义级色），保证与图例同源
        lut: buildGradientLut(resolveLevelGradient(
          resolveHeatGradient(settings.colorScheme, settings.colorDirection),
          comp.stats.levels,
          settings.colorDirection,
        )),
        opacity: settings.opacity ?? 1,
        boundary,
        detail: settings.detail ?? DEFAULT_HEATMAP_SETTINGS.detail!,
        discreteLevels: settings.discrete
          ? Math.max(2, settings.inflections ?? DEFAULT_HEATMAP_SETTINGS.inflections!)
          : 0,
        smooth: settings.smooth,
      })
      return this.stats
    }
    // 栅格模式：原始采样的逐点覆盖层必须清掉（模式切换兜底）
    this.samplesActive = false
    this.samples?.setData(null)

    const raster = renderHeatRaster(comp, settings, boundary)
    if (!raster) {
      // 范围退化（点完全重合）：保留统计供图例显示，但不铺图
      this.removeLayer()
      this.stats = comp.stats
      this.sig = ''
      return this.stats
    }

    try {
      const provider = new this.C.SingleTileImageryProvider({
        url: raster.canvas.toDataURL('image/png'),
        rectangle: this.C.Rectangle.fromDegrees(
          raster.bounds.west, raster.bounds.south, raster.bounds.east, raster.bounds.north),
        tileWidth: raster.canvas.width,
        tileHeight: raster.canvas.height,
      })
      // 先建后删：新层建失败时不至于把旧层也弄丢
      const next = this.viewer.imageryLayers.addImageryProvider(provider)
      this.removeLayer()
      this.layer = next
    } catch (e) {
      console.warn('[CesiumHeatmapLayer] 热力面贴图失败:', e)
      this.removeLayer()
      this.stats = comp.stats
      this.sig = ''
      return this.stats
    }

    this.stats = comp.stats
    this.sig = sig
    return this.stats
  }

  /** 移除热力面（保留统计，供图例在关闭前最后一次读取） */
  remove(): void {
    this.removeLayer()
    this.samplesActive = false
    this.samples?.setData(null)
    this.stats = null
    this.sig = ''
    this.rendered = false
  }

  destroy(): void {
    this.destroyed = true
    this.remove()
    try { this.samples?.destroy() } catch { /* ignore */ }
    this.samples = null
  }

  private removeLayer(): void {
    if (!this.layer) return
    try { this.viewer.imageryLayers.remove(this.layer, true) } catch { /* ignore */ }
    this.layer = null
  }
}
