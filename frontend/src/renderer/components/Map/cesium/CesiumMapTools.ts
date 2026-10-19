/**
 * Cesium 地图工具：测距 / 抓取坐标。
 *
 * **测距交互与 2D（OnlineMap 的 measureMode）对齐**：
 * - 左键逐点加点；8 像素内的重复点丢弃（双击不会多加一个点）
 * - 移动鼠标时显示跟随光标的预览线与「已有点累计 + 当前段」距离
 * - **右键结束**当前测量：保留轨迹 + 「总长」标签 + 删除按钮，测量工具不退出
 * - Esc / Delete 清空全部测量（Delete 同时清打点标记），Backspace 撤销上一个点
 * - 测距中光标为十字（crosshair），退出测距复位
 *
 * 打点（定位）：单击把地面 WGS84 经纬度回调给上层并加一个标记，**可以同时打多个点**
 * （自动编号「打点1/打点2…」）；切工具不清已打的点，只有工具栏「清除」/ Delete 才擦掉。
 * 「选择」工具点击已有标记可编辑经纬度、重命名、复制属性、删除（面板由宿主渲染，
 * 命中通过 `onCapturePick` 回调上报）。
 *
 * 与编辑会话互斥（上层同一时刻只会激活一种工具）。
 */
import { calculateDistance } from '../../../utils/coordinate'

type Pos = [number, number] // WGS84 [lng, lat]

/** 已完成并保留在地图上的一条测量 */
interface FinishedTrace {
  pts: Pos[]
  total: number
  /** 本条测量在 finishedSource 里的全部实体（删除时按引用移除） */
  entities: any[]
  deleteEntity: any
}

/** 一个定位打点（与 2D `captureProperties` 同口径） */
export interface CapturePoint {
  id: string
  /** 标记名（可重命名，默认「打点N」） */
  name: string
  /** WGS84 经度 */
  lng: number
  /** WGS84 纬度 */
  lat: number
}

/** 连点去抖阈值（像素）：与 2D OnlineMap 的 8px 判重同口径 */
const DUPLICATE_CLICK_PX = 8

export class CesiumMapTools {
  /** 打点（定位）标记专用数据源——与测距分离，切换工具时不会被一起清掉 */
  readonly captureSource: any
  /** 正在进行的那一段测量（结束/撤销时清空） */
  readonly measureSource: any
  /** 已结束的测量（总长 + 删除按钮），切换工具也不清 */
  readonly finishedSource: any

  private handler: any
  private active: 'measure' | 'capture' | null = null
  /** 已打的定位点（可多个，切工具不清） */
  private captures: CapturePoint[] = []
  private captureSeq = 0
  private measurePoints: Pos[] = []
  private lastPointPx: { x: number; y: number } | null = null
  private finished: FinishedTrace[] = []

  // 正在进行的测量的构成要素（撤销上一个点时按引用移除）
  private pointEntities: any[] = []
  private segmentEntities: any[] = []
  private runningLabel: any = null

  /**
   * 跟随光标的预览线与距离标签。
   * 用 CallbackProperty 每帧取最新值，避免每次鼠标移动都重建实体（重建会在拖动时明显掉帧）。
   */
  private previewLine: any = null
  private previewLabel: any = null
  private previewPositions: any[] = []
  private previewText = ''
  private previewPos: any = null

  constructor(
    private C: any,
    private viewer: any,
    private onCapture: (lng: number, lat: number) => void,
    private t: (key: string) => string = (k) => k,
    /** 点中已有的定位标记时上报（宿主据此打开编辑面板，屏幕坐标用于定位面板） */
    private onCapturePick: (
      point: CapturePoint, screen: { x: number; y: number },
    ) => void = () => {},
  ) {
    this.captureSource = new C.CustomDataSource('map-tools-capture')
    this.measureSource = new C.CustomDataSource('map-tools-measure')
    this.finishedSource = new C.CustomDataSource('map-tools-measure-finished')
    viewer.dataSources.add(this.captureSource)
    viewer.dataSources.add(this.measureSource)
    viewer.dataSources.add(this.finishedSource)
    const ET = C.ScreenSpaceEventType
    this.handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas)
    this.handler.setInputAction((e: any) => this.onLeftClick(e.position), ET.LEFT_CLICK)
    this.handler.setInputAction((e: any) => this.onMouseMove(e.endPosition), ET.MOUSE_MOVE)
    // 右键结束测量：与 2D 一致（2D 是右键 → finishMeasurement）
    this.handler.setInputAction(() => this.finishMeasurement(), ET.RIGHT_CLICK)
  }

  private pickGround(windowPos: any): Pos | null {
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
   * 测距痕迹则分两段：已结束的保留在图上，未完成的这一段随退出清除。
   */
  setMode(mode: 'measure' | 'capture' | null): void {
    if (this.active === mode) return
    const prev = this.active
    this.active = mode
    if (prev === 'measure') this.clearInProgress()
    this.applyCursor()
  }

  /** 清除全部打点（定位）标记 */
  clearCapture(): void {
    this.captures = []
    this.captureSeq = 0
    this.captureSource.entities.removeAll()
  }

  /** 当前全部打点（供宿主渲染列表/刷新面板） */
  getCapturePoints(): CapturePoint[] {
    return this.captures.map((c) => ({ ...c }))
  }

  /** 重命名打点（同步刷新地图上的标签） */
  renameCapturePoint(id: string, name: string): void {
    const p = this.captures.find((c) => c.id === id)
    if (!p) return
    p.name = name
    this.refreshCaptureEntity(id)
  }

  /** 移动打点到新经纬度（面板里改经纬度后调用） */
  moveCapturePoint(id: string, lng: number, lat: number): void {
    const p = this.captures.find((c) => c.id === id)
    if (!p) return
    p.lng = lng
    p.lat = lat
    this.refreshCaptureEntity(id)
  }

  /** 删除单个打点 */
  removeCapturePoint(id: string): void {
    const idx = this.captures.findIndex((c) => c.id === id)
    if (idx < 0) return
    this.captures.splice(idx, 1)
    const e = this.captureEntity(id)
    if (e) this.captureSource.entities.remove(e)
  }

  private captureEntity(id: string): any {
    const list = this.captureSource.entities.values
    for (const e of list) if (e?.captureId === id) return e
    return null
  }

  /** 重建某个打点的实体（改名/移位后位置与文字都要跟着变） */
  private refreshCaptureEntity(id: string): void {
    const p = this.captures.find((c) => c.id === id)
    const e = this.captureEntity(id)
    if (!p || !e) return
    e.position = this.C.Cartesian3.fromDegrees(p.lng, p.lat)
    if (e.label) e.label.text = p.name
  }

  /**
   * 屏幕位置是否命中某个已打的定位标记。
   * 命中后由 `onCapturePick` 上报；宿主（「选择」工具激活时）据此打开编辑面板。
   */
  pickCapture(position: any): CapturePoint | null {
    if (this.captures.length === 0) return null
    let picks: any[] = []
    try {
      picks = this.viewer.scene.drillPick(position, 12) ?? []
    } catch { return null }
    for (const pk of picks) {
      const id = pk?.id?.captureId
      if (!id) continue
      const p = this.captures.find((c) => c.id === id)
      if (p) return { ...p }
    }
    return null
  }

  /** 清除全部测量痕迹（含已完成的） */
  clearMeasure(): void {
    this.clearInProgress()
    this.finished = []
    this.finishedSource.entities.removeAll()
  }

  /**
   * 键盘快捷键（由宿主在 window keydown 里转发）。
   * @returns 是否已消费该按键
   */
  handleKeyDown(e: KeyboardEvent): boolean {
    if (this.active !== 'measure') return false
    if (e.key === 'Escape' || e.key === 'Delete') {
      this.clearMeasure()
      // 与 2D 一致：Delete 连打点标记一起清
      if (e.key === 'Delete') this.clearCapture()
      return true
    }
    if (e.key === 'Backspace') {
      this.undoLastPoint()
      return true
    }
    return false
  }

  private applyCursor(): void {
    const canvas = this.viewer?.scene?.canvas
    if (!canvas) return
    canvas.style.cursor = this.active === 'measure' ? 'crosshair' : ''
  }

  // ===== 输入事件 =====

  private onLeftClick(position: any) {
    if (!this.active) return

    // 点在某条已完成测量的删除按钮上：删掉那一条，不再加点
    if (this.active === 'measure' && this.hitDeleteButton(position)) return

    const g = this.pickGround(position)
    if (!g) return

    if (this.active === 'capture') {
      // 点中已有的标记 → 交给宿主打开展性面板（编辑经纬度/重命名/复制/删除），不再新加一个点
      const hit = this.pickCapture(position)
      if (hit) { this.onCapturePick(hit, { x: position.x, y: position.y }); return }
      this.addCaptureMarker(g)
      // 回传 WGS84（与 OnlineMap 抓取坐标口径一致）
      this.onCapture(g[0], g[1])
      return
    }

    // 源头去抖：双击时浏览器会连发两次 click，第二次落点与上一次几乎重合。
    // 按像素距离判重（同 2D OnlineMap.handleMapClick 的 8px 阈值）
    if (this.lastPointPx
      && Math.hypot(position.x - this.lastPointPx.x, position.y - this.lastPointPx.y)
        < DUPLICATE_CLICK_PX) return

    this.measurePoints.push(g)
    this.lastPointPx = { x: position.x, y: position.y }
    this.pointEntities.push(this.measureSource.entities.add(this.markerEntity(g)))

    if (this.measurePoints.length >= 2) {
      const a = this.measurePoints[this.measurePoints.length - 2]
      this.segmentEntities.push(this.measureSource.entities.add(this.lineEntity([a, g])))
    }
    this.updateRunningLabel()
  }

  private onMouseMove(position: any) {
    if (this.active !== 'measure' || this.measurePoints.length === 0) {
      this.setPreviewVisible(false)
      return
    }
    const g = this.pickGround(position)
    // 拾取不到地面（相机外/地形未就绪）时别留着上一帧的预览线误导
    if (!g) { this.setPreviewVisible(false); return }
    const last = this.measurePoints[this.measurePoints.length - 1]
    const seg = calculateDistance(last[1], last[0], g[1], g[0])
    this.previewPositions = this.C.Cartesian3.fromDegreesArray([last[0], last[1], g[0], g[1]])
    this.previewPos = this.C.Cartesian3.fromDegrees(g[0], g[1])
    this.previewText = this.formatDistance(this.cumulative() + seg)
    this.setPreviewVisible(true)
  }

  // ===== 测量绘制 =====

  /** 结束当前测量：把痕迹固化到 finishedSource（带总长标签与删除按钮） */
  finishMeasurement(): void {
    if (this.active !== 'measure') return
    const pts = this.measurePoints
    if (pts.length < 2) { this.setPreviewVisible(false); return }
    const total = this.cumulative()
    this.drawFinishedTrace([...pts], total)
    this.clearInProgress()
  }

  /** 撤销上一个测量点 */
  undoLastPoint(): void {
    if (this.measurePoints.length <= 1) {
      if (this.measurePoints.length === 1) this.clearInProgress()
      return
    }
    this.measurePoints.pop()
    const marker = this.pointEntities.pop()
    if (marker) this.measureSource.entities.remove(marker)
    const seg = this.segmentEntities.pop()
    if (seg) this.measureSource.entities.remove(seg)
    // 下一次点击的落点判重要以撤销后的最后一点为准
    this.lastPointPx = null
    this.updateRunningLabel()
    this.setPreviewVisible(false)
  }

  private clearInProgress(): void {
    this.measurePoints = []
    this.lastPointPx = null
    this.pointEntities = []
    this.segmentEntities = []
    this.runningLabel = null
    /**
     * 预览实体必须一起置空。
     * `entities.removeAll()` 会把 previewLine/previewLabel 从数据源里摘掉，但引用还在；
     * 引用不清空的话 `setPreviewVisible(true)` 会走"已存在"分支，只给两个孤儿实体设
     * `show=true` 而不再重建 —— 于是"结束一次测量/切一次工具之后，预览线就再也不出现了"。
     */
    this.previewLine = null
    this.previewLabel = null
    this.previewPositions = []
    this.previewText = ''
    this.previewPos = null
    this.measureSource.entities.removeAll()
    this.setPreviewVisible(false)
  }

  /** 已有点（不含预览段）的累计距离 */
  private cumulative(): number {
    let total = 0
    for (let i = 1; i < this.measurePoints.length; i++) {
      const a = this.measurePoints[i - 1]
      const b = this.measurePoints[i]
      total += calculateDistance(a[1], a[0], b[1], b[0])
    }
    return total
  }

  private formatDistance(meters: number): string {
    return `${meters.toFixed(2)}${this.t('map.meters') || '米'}`
  }

  /** 更新（或创建）当前测量的累计距离标签 */
  private updateRunningLabel(): void {
    const C = this.C
    const pts = this.measurePoints
    if (pts.length === 0) {
      if (this.runningLabel) this.runningLabel.label.show = false
      return
    }
    const last = pts[pts.length - 1]
    const text = pts.length === 1
      ? (this.t('map.measureStartPoint') || '起点')
      : this.formatDistance(this.cumulative())
    if (this.runningLabel) {
      this.runningLabel.position = C.Cartesian3.fromDegrees(last[0], last[1])
      this.runningLabel.label.text = text
      this.runningLabel.label.show = true
      return
    }
    this.runningLabel = this.measureSource.entities.add(new C.Entity({
      position: C.Cartesian3.fromDegrees(last[0], last[1]),
      label: {
        text,
        font: 'bold 12px sans-serif',
        fillColor: C.Color.fromCssColorString('#ef4444'),
        showBackground: true,
        backgroundColor: C.Color.WHITE.withAlpha(0.85),
        pixelOffset: new C.Cartesian2(0, -18),
        verticalOrigin: C.VerticalOrigin.BOTTOM,
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }))
  }

  /**
   * 预览线 / 预览标签。
   * 只在首次显示时创建实体，之后靠 CallbackProperty 取值更新——拖动过程中不重建实体，
   * 否则每帧 removeAll + add 会让 3D 明显掉帧。
   */
  private setPreviewVisible(visible: boolean) {
    const C = this.C
    if (!visible) {
      if (this.previewLine) this.previewLine.show = false
      if (this.previewLabel) this.previewLabel.show = false
      return
    }
    if (this.previewLine && this.previewLabel) {
      this.previewLine.show = true
      this.previewLabel.show = true
      return
    }
    const positionsProp = new C.CallbackProperty(() => this.previewPositions, false)
    this.previewLine = this.measureSource.entities.add(new C.Entity({
      polyline: {
        positions: positionsProp,
        width: 2,
        material: C.Color.fromCssColorString('#ef4444').withAlpha(0.5),
        clampToGround: true,
        show: true,
      },
    }))
    this.previewLabel = this.measureSource.entities.add(new C.Entity({
      position: new C.CallbackProperty(() => this.previewPos, false),
      label: {
        text: new C.CallbackProperty(() => this.previewText, false),
        font: 'bold 12px sans-serif',
        fillColor: C.Color.fromCssColorString('#ef4444'),
        showBackground: true,
        backgroundColor: C.Color.WHITE.withAlpha(0.85),
        pixelOffset: new C.Cartesian2(10, 10),
        verticalOrigin: C.VerticalOrigin.TOP,
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        show: true,
      },
    }))
  }

  /** 把一条完成的测量画到 finishedSource（轨迹 + 总长标签 + 删除按钮） */
  private drawFinishedTrace(pts: Pos[], total: number) {
    const C = this.C
    const last = pts[pts.length - 1]
    const entities: any[] = []

    entities.push(this.finishedSource.entities.add(this.lineEntity(pts)))
    for (const p of pts) entities.push(this.finishedSource.entities.add(this.markerEntity(p)))

    entities.push(this.finishedSource.entities.add(new C.Entity({
      position: C.Cartesian3.fromDegrees(last[0], last[1]),
      label: {
        text: `${this.t('map.totalDistance') || '总长'} ${this.formatDistance(total)}`,
        font: 'bold 13px sans-serif',
        fillColor: C.Color.fromCssColorString('#ef4444'),
        showBackground: true,
        backgroundColor: C.Color.WHITE.withAlpha(0.9),
        pixelOffset: new C.Cartesian2(0, -18),
        verticalOrigin: C.VerticalOrigin.BOTTOM,
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })))

    const deleteEntity = this.finishedSource.entities.add(new C.Entity({
      position: C.Cartesian3.fromDegrees(last[0], last[1]),
      label: {
        text: '×',
        font: 'bold 14px sans-serif',
        fillColor: C.Color.WHITE,
        showBackground: true,
        backgroundColor: C.Color.fromCssColorString('#ef4444'),
        backgroundPadding: new C.Cartesian2(4, 2),
        pixelOffset: new C.Cartesian2(0, 4),
        verticalOrigin: C.VerticalOrigin.TOP,
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }))
    entities.push(deleteEntity)
    this.finished.push({ pts, total, entities, deleteEntity })
  }

  /** 点击是否落在某条测量的删除按钮上；命中则删除该条 */
  private hitDeleteButton(position: any): boolean {
    if (this.finished.length === 0) return false
    let picks: any[] = []
    try {
      picks = this.viewer.scene.drillPick(position, 12) ?? []
    } catch { return false }
    for (const p of picks) {
      const idx = this.finished.findIndex((tr) => tr.deleteEntity === p?.id)
      if (idx < 0) continue
      const trace = this.finished[idx]
      for (const e of trace.entities) {
        try { this.finishedSource.entities.remove(e) } catch { /* ignore */ }
      }
      this.finished.splice(idx, 1)
      return true
    }
    return false
  }

  // ===== 图元构造 =====

  /** 测距端点：白底红边圆点 */
  private markerEntity(g: Pos) {
    const C = this.C
    return new C.Entity({
      position: C.Cartesian3.fromDegrees(g[0], g[1]),
      point: {
        pixelSize: 10,
        color: C.Color.WHITE,
        outlineColor: C.Color.fromCssColorString('#ef4444'),
        outlineWidth: 2,
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  /** 测距折线（贴地） */
  private lineEntity(pts: Pos[]) {
    const C = this.C
    return new C.Entity({
      polyline: {
        positions: C.Cartesian3.fromDegreesArray(pts.flatMap((p) => p)),
        width: 2,
        material: C.Color.fromCssColorString('#ef4444'),
        clampToGround: true,
      },
    })
  }

  /**
   * 打点（定位）标记。
   * **可同时存在多个**（与 2D 一致）：每个点自动编号「打点N」，带名称标签；
   * 只有工具栏「清除」/ Delete / 面板里的删除按钮才移除。
   */
  private addCaptureMarker(g: Pos, label?: string) {
    const C = this.C
    this.captureSeq += 1
    const id = `capture-${Date.now()}-${this.captureSeq}`
    const name = label ?? `${this.t('map.capturePoint') || '打点'}${this.captureSeq}`
    this.captures.push({ id, name, lng: g[0], lat: g[1] })
    const e = this.captureSource.entities.add(new C.Entity({
      position: C.Cartesian3.fromDegrees(g[0], g[1]),
      point: {
        pixelSize: 10,
        color: C.Color.fromCssColorString('#ef4444'),
        outlineColor: C.Color.WHITE, outlineWidth: 2,
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: name,
        font: '12px sans-serif',
        fillColor: C.Color.fromCssColorString('#ef4444'),
        showBackground: true,
        backgroundColor: C.Color.WHITE.withAlpha(0.85),
        pixelOffset: new C.Cartesian2(0, -12),
        verticalOrigin: C.VerticalOrigin.BOTTOM,
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }))
    // 拾取标识：pickCapture 靠它把点击结果映射回具体的打点
    e.captureId = id
  }

  /** 外部（如搜索定位）追加一个定位标记，与打点标记同源；可自带名称 */
  addLocationMarker(lng: number, lat: number, label?: string): void {
    this.addCaptureMarker([lng, lat], label)
  }

  destroy() {
    try { this.handler.destroy() } catch { /* ignore */ }
    this.applyCursor()
    this.viewer.dataSources.remove(this.captureSource)
    this.viewer.dataSources.remove(this.measureSource)
    this.viewer.dataSources.remove(this.finishedSource)
  }
}
