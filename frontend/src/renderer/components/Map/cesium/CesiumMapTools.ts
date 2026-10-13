/**
 * Cesium 地图工具：测距 / 抓取坐标。
 *
 * - 测距：单击连续加点，贴地折线 + 端点 + 实时累计距离（米），双击结束，Esc 清空
 * - 抓取坐标：单击把地面 WGS84 经纬度回调给上层，并加一个临时标记
 *
 * 与编辑会话互斥（上层同一时刻只会激活一种工具）。
 */
import { calculateDistance } from '../../../utils/coordinate'

export class CesiumMapTools {
  /** 打点（定位）标记专用数据源——与测距分离，切换工具时不会被一起清掉 */
  readonly captureSource: any
  /** 测距痕迹专用数据源 */
  readonly measureSource: any
  private handler: any
  private active: 'measure' | 'capture' | null = null
  private measurePoints: Array<[number, number]> = [] // WGS84 [lng,lat]

  constructor(
    private C: any,
    private viewer: any,
    private onCapture: (lng: number, lat: number) => void,
  ) {
    this.captureSource = new C.CustomDataSource('map-tools-capture')
    this.measureSource = new C.CustomDataSource('map-tools-measure')
    viewer.dataSources.add(this.captureSource)
    viewer.dataSources.add(this.measureSource)
    this.handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas)
    this.handler.setInputAction((e: any) => this.onClick(e.position), C.ScreenSpaceEventType.LEFT_CLICK)
    this.handler.setInputAction(() => this.onDoubleClick(), C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
  }

  private pickGround(windowPos: any): [number, number] | null {
    const { scene } = this.viewer
    const ray = scene.camera.getPickRay(windowPos)
    let cartesian = ray ? scene.globe.pick(ray, scene) : null
    if (!cartesian) cartesian = scene.camera.pickEllipsoid(windowPos, scene.globe.ellipsoid)
    if (!cartesian) return null
    const carto = this.C.Cartographic.fromCartesian(cartesian)
    return [this.C.Math.toDegrees(carto.longitude), this.C.Math.toDegrees(carto.latitude)]
  }

  /**
   * 切换工具。
   *
   * **打点（定位）标记必须保留**：高德侧切到别的工具后已打的点仍在图上，只有工具栏「清除」
   * 才擦掉。早先这里对任何模式变化都 `removeAll()`，导致"打点后再点其他工具，打点就没了"。
   * 测距痕迹则相反——退出测距就该清掉未完成的那一段。
   */
  setMode(mode: 'measure' | 'capture' | null): void {
    if (this.active === mode) return
    const prev = this.active
    this.active = mode
    if (prev === 'measure' || mode === 'measure') {
      this.measurePoints = []
      this.renderMeasure()
    }
  }

  /** 清除打点（定位）标记 */
  clearCapture(): void {
    this.captureSource.entities.removeAll()
  }

  /** 清除测距痕迹 */
  clearMeasure(): void {
    this.measurePoints = []
    this.renderMeasure()
  }

  private onClick(position: any) {
    if (!this.active) return
    const g = this.pickGround(position)
    if (!g) return

    if (this.active === 'capture') {
      // 每次打点只保留当前一个点（与高德侧一致）
      this.captureSource.entities.removeAll()
      this.addCaptureMarker(g)
      // 回传 WGS84（与 OnlineMap 抓取坐标口径一致）
      this.onCapture(g[0], g[1])
      return
    }

    // 测距：累加并重建
    this.measurePoints.push(g)
    this.renderMeasure()
  }

  private onDoubleClick() {
    if (this.active === 'measure') {
      this.measurePoints = [] // 结束当前一段（保留画面，下一段重新累计）
    }
  }

  /** 打点（定位）标记 */
  private addCaptureMarker(g: [number, number]) {
    const C = this.C
    this.captureSource.entities.add(new C.Entity({
      position: C.Cartesian3.fromDegrees(g[0], g[1]),
      point: {
        pixelSize: 10,
        color: C.Color.fromCssColorString('#ef4444'),
        outlineColor: C.Color.WHITE, outlineWidth: 2,
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }))
  }

  /** 外部（如搜索定位）追加一个定位标记，与打点标记同源 */
  addLocationMarker(lng: number, lat: number): void {
    this.addCaptureMarker([lng, lat])
  }

  private addMeasureMarker(g: [number, number]) {
    const C = this.C
    this.measureSource.entities.add(new C.Entity({
      position: C.Cartesian3.fromDegrees(g[0], g[1]),
      point: {
        pixelSize: 10,
        color: C.Color.fromCssColorString('#ef4444'),
        outlineColor: C.Color.WHITE, outlineWidth: 2,
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }))
  }

  private renderMeasure() {
    const C = this.C
    this.measureSource.entities.removeAll()
    const pts = this.measurePoints
    if (pts.length === 0) return

    // 端点
    pts.forEach((g) => this.addMeasureMarker(g))

    // 折线
    if (pts.length >= 2) {
      this.measureSource.entities.add(new C.Entity({
        polyline: {
          positions: C.Cartesian3.fromDegreesArray(pts.flatMap((p) => p)),
          width: 2,
          material: C.Color.fromCssColorString('#f97316'),
          clampToGround: true,
        },
      }))
    }

    // 累计距离标签（末端）
    let total = 0
    for (let i = 1; i < pts.length; i++) {
      total += calculateDistance(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0])
    }
    const text = total >= 1000
      ? `${(total / 1000).toFixed(2)} km`
      : `${Math.round(total)} m`
    const last = pts[pts.length - 1]
    this.measureSource.entities.add(new C.Entity({
      position: C.Cartesian3.fromDegrees(last[0], last[1]),
      label: {
        text,
        font: '12px sans-serif',
        fillColor: C.Color.WHITE,
        showBackground: true,
        backgroundColor: C.Color.fromCssColorString('#f97316').withAlpha(0.9),
        pixelOffset: new C.Cartesian2(10, -10),
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }))
  }

  destroy() {
    try { this.handler.destroy() } catch { /* ignore */ }
    this.viewer.dataSources.remove(this.captureSource)
    this.viewer.dataSources.remove(this.measureSource)
  }
}
