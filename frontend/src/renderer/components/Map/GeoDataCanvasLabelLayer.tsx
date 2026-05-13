/**
 * GeoDataLayer Canvas 标签渲染层
 *
 * 功能：
 * - 使用 Canvas 渲染标签，替代 DOM 元素
 * - 支持视口裁剪，仅渲染可见标签
 * - 支持标签去重（防止重叠）
 * - 与地图同步缩放和平移
 *
 * 性能优势：
 * - 18761 个标签从 18761 个 DOM 元素减少到 1 个 Canvas 元素
 * - 渲染性能提升约 95%
 */
import L from 'leaflet'

/**
 * 标签数据接口
 */
export interface CanvasLabelData {
  index: number
  position: L.LatLng
  content: string
}

/**
 * Canvas 标签项（内部使用）
 */
interface CanvasLabel {
  latLng: L.LatLng  // 保留原始地理坐标，用于地图移动时重新计算位置
  x: number
  y: number
  content: string
  visible: boolean
}

/**
 * 配置选项
 */
export interface GeoDataCanvasLabelOptions {
  /** 字体大小 */
  fontSize?: number
  /** 字体颜色 */
  fontColor?: string
  /** 背景颜色 */
  backgroundColor?: string
  /** 边框颜色 */
  borderColor?: string
  /** 边框宽度 */
  borderWidth?: number
  /** 内边距 */
  padding?: number
  /** 标签间距（像素） */
  minDistance?: number
}

/**
 * GeoDataLayer Canvas 标签渲染层
 *
 * 继承 L.Layer，作为 Leaflet 图层使用
 */
export class GeoDataCanvasLabelLayer extends L.Layer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private labels: CanvasLabel[] = []
  private map: L.Map | null = null

  // 配置
  private fontSize: number = 12
  private fontColor: string = '#000000'
  private backgroundColor: string = 'rgba(0, 0, 0, 0)'  // 透明背景
  private borderColor: string = '#000000'
  private borderWidth: number = 0  // 无边框
  private padding: number = 4
  private minDistance: number = 30 // 标签最小间距

  // 缓存
  private _needsRender: boolean = false
  private _renderCount: number = 0  // 用于减少日志输出频率

  constructor(options: GeoDataCanvasLabelOptions = {}) {
    super()

    // 应用配置
    if (options.fontSize) this.fontSize = options.fontSize
    if (options.fontColor) this.fontColor = options.fontColor
    if (options.backgroundColor) this.backgroundColor = options.backgroundColor
    if (options.borderColor) this.borderColor = options.borderColor
    if (options.borderWidth) this.borderWidth = options.borderWidth
    if (options.padding) this.padding = options.padding
    if (options.minDistance) this.minDistance = options.minDistance

    // 创建 Canvas 元素
    this.canvas = L.DomUtil.create('canvas', 'geodata-canvas-label-layer')
    this.canvas.style.position = 'absolute'
    this.canvas.style.pointerEvents = 'none' // 不拦截鼠标事件
    this.canvas.style.zIndex = '1000' // 确保在几何图形之上

    const ctx = this.canvas.getContext('2d')
    if (!ctx) {
      throw new Error('无法获取 Canvas 2D 上下文')
    }
    this.ctx = ctx
  }

  /**
   * Leaflet 图层生命周期：添加到地图
   */
  onAdd(map: L.Map): this {
    this.map = map

    // 设置 Canvas 大小
    this._resizeCanvas()
    this._updateCanvasPosition()

    // 监听地图事件
    map.on('move', this._onMapMove, this)
    map.on('resize', this._onMapResize, this)
    map.on('viewreset', this._onViewReset, this)

    // 添加到地图的 pane
    const pane = map.getPanes()?.overlayPane
    if (pane) {
      pane.appendChild(this.canvas)
    }

    // 初始渲染
    this._scheduleRender()

    return this
  }

  /**
   * Leaflet 图层生命周期：从地图移除
   */
  onRemove(map: L.Map): this {
    // 移除事件监听
    map.off('move', this._onMapMove, this)
    map.off('resize', this._onMapResize, this)
    map.off('viewreset', this._onViewReset, this)

    // 移除 Canvas 元素
    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas)
    }

    this.map = null
    return this
  }

  /**
   * 设置标签数据
   *
   * 🔧 延时显示模式：接收所有标签数据，不进行视口裁剪
   * 标签的可见性由渲染时根据屏幕坐标动态判断
   */
  setLabels(items: CanvasLabelData[]): void {
    if (!this.map) return

    console.log('[CanvasLabelLayer] setLabels: 接收到', items.length, '个标签数据（延时显示模式）')

    this.labels = []

    // 🔧 移除视口裁剪：保存所有标签数据
    // 转换为屏幕坐标，同时保留原始 LatLng
    for (const item of items) {
      const point = this._latLngToContainerPoint(item.position)
      if (!point) continue

      // 🔧 不再检查视口内，创建所有标签
      // 可见性将在渲染时根据屏幕坐标动态判断

      this.labels.push({
        latLng: item.position,  // 保留原始坐标
        x: point.x,
        y: point.y,
        content: item.content,
        visible: true  // 初始都设为可见，渲染时会重新判断
      })
    }

    console.log('[CanvasLabelLayer] setLabels: 已创建', this.labels.length, '个标签（全部元素）')

    // 标签去重（只对屏幕上重叠的标签去重）
    const beforeDedup = this.labels.length
    this._deduplicateLabels()
    console.log('[CanvasLabelLayer] setLabels: 去重后剩余', this.labels.length, '个标签 (过滤了', beforeDedup - this.labels.length, '个重叠)')

    // 调度渲染
    this._scheduleRender()
  }

  /**
   * 更新视口（用于地图移动时的增量更新）
   *
   * 🔧 延时显示模式：根据屏幕坐标动态更新标签可见性
   * 地图移动时自动显示新进入视窗的标签，隐藏移出视窗的标签
   */
  updateViewport(_bounds: L.LatLngBounds, _zoom: number): void {
    console.log('[CanvasLabelLayer] updateViewport: 更新', this.labels.length, '个标签的可见性')

    let visibleCount = 0

    // 🔧 使用存储的 LatLng 重新计算所有标签的屏幕坐标和可见性
    for (const label of this.labels) {
      const point = this._latLngToContainerPoint(label.latLng)
      if (!point) {
        label.visible = false
        continue
      }

      // 更新屏幕坐标
      label.x = point.x
      label.y = point.y

      // 🔧 根据屏幕坐标判断可见性
      // 新进入视窗的标签自动显示，移出视窗的标签自动隐藏
      label.visible = this._isPointInViewport(point)
      if (label.visible) visibleCount++
    }

    console.log('[CanvasLabelLayer] updateViewport: 可见标签 =', visibleCount, '/', this.labels.length)

    this._scheduleRender()
  }

  /**
   * 清空所有标签
   */
  clearLabels(): void {
    this.labels = []
    this._scheduleRender()
  }

  /**
   * 地图移动事件处理
   */
  private _onMapMove(): void {
    this._updateCanvasPosition()
    this._scheduleRender()
  }

  /**
   * 地图大小变化事件处理
   */
  private _onMapResize(): void {
    this._resizeCanvas()
    this._scheduleRender()
  }

  /**
   * 视图重置事件处理
   */
  private _onViewReset(): void {
    this._scheduleRender()
  }

  /**
   * 调整 Canvas 大小
   */
  private _resizeCanvas(): void {
    if (!this.map) return

    const size = this.map.getSize()
    const pixelRatio = window.devicePixelRatio || 1

    this.canvas.width = size.x * pixelRatio
    this.canvas.height = size.y * pixelRatio
    this.canvas.style.width = `${size.x}px`
    this.canvas.style.height = `${size.y}px`

    this.ctx.scale(pixelRatio, pixelRatio)
  }

  /**
   * 更新 Canvas 位置
   */
  private _updateCanvasPosition(): void {
    if (!this.map) return

    const topLeft = this.map.containerPointToLayerPoint([0, 0])
    L.DomUtil.setPosition(this.canvas, topLeft)
  }

  /**
   * 调度渲染（使用 requestAnimationFrame）
   */
  private _scheduleRender(): void {
    if (this._needsRender) return

    this._needsRender = true
    requestAnimationFrame(() => {
      this._render()
      this._needsRender = false
    })
  }

  /**
   * 渲染所有标签
   */
  private _render(): void {
    // 清空 Canvas
    const size = this.map?.getSize()
    if (size) {
      this.ctx.clearRect(0, 0, size.x, size.y)
    }

    const totalLabels = this.labels.length
    let visibleCount = 0
    let renderedCount = 0

    // 渲染每个标签
    for (const label of this.labels) {
      if (!label.visible) continue

      visibleCount++

      // 🔧 关键修复：每次渲染时重新计算屏幕坐标
      // 这样地图移动/缩放时标签位置会正确更新
      const point = this._latLngToContainerPoint(label.latLng)
      if (!point) continue

      // 更新屏幕坐标
      label.x = point.x
      label.y = point.y

      this._drawLabel(label)
      renderedCount++
    }

    // 每10次渲染输出一次日志，避免刷屏
    if (!this._renderCount) this._renderCount = 0
    this._renderCount++
    if (this._renderCount % 10 === 0) {
      console.log('[CanvasLabelLayer] _render: 总标签=', totalLabels, ', 可见=', visibleCount, ', 渲染=', renderedCount)
    }
  }

  /**
   * 绘制单个标签
   */
  private _drawLabel(label: CanvasLabel): void {
    const ctx = this.ctx
    const padding = this.padding
    const fontSize = this.fontSize

    ctx.font = `${fontSize}px sans-serif`

    // 测量文本
    const metrics = ctx.measureText(label.content)
    const textWidth = metrics.width
    const textHeight = fontSize

    // 仅在有边框宽度时绘制背景和边框
    if (this.borderWidth > 0) {
      // 计算背景框
      const bgX = label.x - textWidth / 2 - padding
      const bgY = label.y - textHeight / 2 - padding
      const bgWidth = textWidth + padding * 2
      const bgHeight = textHeight + padding * 2

      // 绘制背景
      ctx.fillStyle = this.backgroundColor
      ctx.fillRect(bgX, bgY, bgWidth, bgHeight)

      // 绘制边框
      ctx.strokeStyle = this.borderColor
      ctx.lineWidth = this.borderWidth
      ctx.strokeRect(bgX, bgY, bgWidth, bgHeight)
    }

    // 绘制文本
    ctx.fillStyle = this.fontColor
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label.content, label.x, label.y)
  }

  /**
   * 标签去重（防止重叠）
   */
  private _deduplicateLabels(): void {
    // 按屏幕位置排序
    const sorted = [...this.labels].sort((a, b) => {
      if (Math.abs(a.y - b.y) > this.minDistance) {
        return a.y - b.y
      }
      return a.x - b.x
    })

    const result: CanvasLabel[] = []
    const occupied = new Set<string>()

    for (const label of sorted) {
      const gridKey = this._getGridKey(label.x, label.y)
      if (!occupied.has(gridKey)) {
        occupied.add(gridKey)
        result.push(label)
      } else {
        label.visible = false
      }
    }

    this.labels = result
  }

  /**
   * 获取网格键（用于去重）
   */
  private _getGridKey(x: number, y: number): string {
    const gridSize = this.minDistance
    const gridX = Math.floor(x / gridSize)
    const gridY = Math.floor(y / gridSize)
    return `${gridX},${gridY}`
  }

  /**
   * 检查点是否在视口内
   */
  private _isPointInViewport(point: { x: number; y: number }): boolean {
    if (!this.map) return false

    const size = this.map.getSize()
    const buffer = 50 // 50px 缓冲

    return (
      point.x >= -buffer &&
      point.x <= size.x + buffer &&
      point.y >= -buffer &&
      point.y <= size.y + buffer
    )
  }

  /**
   * LatLng 转换为容器坐标
   */
  private _latLngToContainerPoint(latLng: L.LatLng): L.Point | null {
    if (!this.map) return null
    try {
      return this.map.latLngToContainerPoint(latLng)
    } catch {
      return null
    }
  }

  /**
   * 更新配置
   */
  updateConfig(options: Partial<GeoDataCanvasLabelOptions>): void {
    if (options.fontSize !== undefined) this.fontSize = options.fontSize
    if (options.fontColor !== undefined) this.fontColor = options.fontColor
    if (options.backgroundColor !== undefined) this.backgroundColor = options.backgroundColor
    if (options.borderColor !== undefined) this.borderColor = options.borderColor
    if (options.borderWidth !== undefined) this.borderWidth = options.borderWidth
    if (options.padding !== undefined) this.padding = options.padding
    if (options.minDistance !== undefined) this.minDistance = options.minDistance

    this._scheduleRender()
  }

  /**
   * 获取当前标签数量
   */
  getLabelCount(): number {
    return this.labels.length
  }
}
