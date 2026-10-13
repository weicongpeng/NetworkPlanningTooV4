/**
 * Cesium 值热力面图层。
 *
 * 与 2D **共用同一套计算与栅格化**（`computeHeatComputation` + `renderHeatRaster`）：
 * 覆盖半径推导、分位基准、分级、色带、边界裁剪全部同源，所以同一个热力设置在两端渲染出的
 * 颜色分布与图例数字一致。差别只在"怎么贴这张图"：
 * - 2D：`L.ImageOverlay`（Leaflet 显示坐标 GCJ02）
 * - 3D：`SingleTileImageryProvider` 把同一张位图铺在同样的地理矩形上（Cesium 是 WGS84）
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
import type { HeatmapSettings } from '../LabelSettingsModal'
import type { HeatmapStats } from '../HeatmapLayerManager'
import type { HeatPoint } from '../../../utils/heatmap'
import type { HeatBoundary } from '../../../utils/heatSurface'

export class CesiumHeatmapLayer {
  private layer: any = null
  private stats: HeatmapStats | null = null
  /** 上次渲染的「设置 + 点集」指纹：不变就跳过 IDW 重算（很贵） */
  private sig = ''

  constructor(
    private C: any,
    private viewer: any,
    readonly layerId: string,
  ) {}

  getStats(): HeatmapStats | null {
    return this.stats
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
    const sig = `${heatSettingsSignature(settings)}|${fingerprintHeatPoints(points)}|${boundary ? 'b' : '-'}`
    // 设置与点集都没变：保留现有图层，直接复用统计（缩放平移不重算）
    if (this.layer && sig === this.sig) return this.stats

    const comp = computeHeatComputation(points, settings)
    if (!comp) {
      this.remove()
      return null
    }
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
    this.stats = null
    this.sig = ''
  }

  destroy(): void {
    this.removeLayer()
  }

  private removeLayer(): void {
    if (!this.layer) return
    try { this.viewer.imageryLayers.remove(this.layer, true) } catch { /* ignore */ }
    this.layer = null
  }
}
