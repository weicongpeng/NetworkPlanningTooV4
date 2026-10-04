/**
 * 图层编辑会话：在可编辑 TAB 图层上绘制/选中/删除/拖拽顶点编辑点线面。
 *
 * - 独立 SVG pane（canvas renderer 无法挂逐要素事件/把手），高于数据图层
 * - 支持混合图层：同一图层可同时含点/线/面，样式按每个要素自身几何类型取 drawStyleMap
 * - 工作集真相源在 layerEditStore；本类负责把 workspace 要素渲染到地图，
 *   并把绘制/编辑结果通过 store action 提交后 rebuild
 * - 绘制交互仿 OnlineMap 圈选/测距：单击加顶点、双击/右键完成、Backspace 删末点、Esc 取消
 *   面预设形状：三角形=单击3个点闭合；圆形=第一点为圆心、移动定半径、再击完成；
 *   方形=两点为对角线（四内角为直角）
 * - 顶点编辑用手写 draggable divIcon 把手（Leaflet 1.9 core 无 L.Edit.Poly）
 * - 面/线支持整体旋转把手（拖动绕形心旋转）；圆/椭圆用 4 个轴端把手调整半径（可成椭圆）
 * - 编辑态（非绘制/非手形工具）按住要素左键拖动可整体移位
 *
 * 坐标均为 GCJ02（地图渲染坐标），保存回 TAB 时由后端逆转换为 WGS84。
 */
import L from 'leaflet'
import i18n from '../../i18n'
import { useLayerEditStore, type CopiedFeature } from '../../store/layerEditStore'
import { useMapStore } from '../../store/mapStore'
import type { DrawTool } from '@shared/types'
import { resolvePointShape } from './MapInfoLayer'
import { layerHitAt, CLICK_HIT_TOLERANCE_PX, type FeatureHitType } from './mapHitTest'
import { geometryAnchor } from '../../services/boundarySelection'
import { buildLineArrows } from './lineArrows'
import { getFieldValue, matchThematicColor, NO_FILL_COLOR } from '../../utils/fieldValue'
import type { ThematicSettings } from './LabelSettingsModal'
import {
  analyzeRingInRect,
  alignRingToReference,
  insideSegmentPoints,
  type MMPoint,
  type MMRect,
} from './nodeMergeGeometry'

const EDIT_PANE = 'nptEditPane'
const HANDLE_PANE = 'nptEditHandlePane'

const SELECT_COLOR = '#f59e0b'
/** 节点合并：可编辑命中边框颜色（橙，与选中体系一致） */
const MERGE_EDIT_COLOR = '#f59e0b'
/** 节点合并：不可编辑参考边框颜色（蓝） */
const MERGE_REF_COLOR = '#38bdf8'
/** 节点合并拖框判定为点击的最小位移（像素） */
const MERGE_MIN_DRAG_PX = 4

type GeomKind = 'point' | 'line' | 'polygon'

/** 节点合并的不可编辑参考来源（OnlineMap 注入：可见且非当前编辑层的图层） */
export interface MergeReferenceSource {
  id: string
  name: string
  layer: L.Layer
}

/** 框内单段边框命中（环已去闭合点） */
interface MergeRingHit {
  ring: L.LatLng[]
  closed: boolean
  /** 框内段（入口交点→中间顶点→出口交点） */
  seg: L.LatLng[]
}

interface MergeEditableHit extends MergeRingHit {
  editId: string
  leaf: any
  geomType: string
  /** Multi* 部件索引（Polygon 外环/LineString 恒为 0） */
  partIndex: number
  /** 原 LineString 首尾重合（用线表达闭合环）时，写回后补回闭合重复点 */
  lineClosed: boolean
}

interface MergeRefHit extends MergeRingHit {
  candidateKey: string
  sourceName: string
  leaf: any
  geomType: string
  partIndex: number
}

/** 一个可被点选的参考要素候选（同一 leaf 多环合并为一个候选） */
interface MergeCandidate {
  key: string
  /** 来源图层 id（执行前复查可见性用） */
  sourceId: string
  name: string
  leaf: any
  hits: MergeRefHit[]
}

const DEFAULT_STYLES: Record<GeomKind, any> = {
  point: { markerShape: 'circle', markerSize: 8, markerColor: '#ff6b6b', borderColor: '#cc2b2b' },
  line: { color: '#ff6b6b', weight: 2.5, opacity: 0.95, dashArray: '' },
  polygon: { fillColor: '#ff6b6b', fillOpacity: 0.3, borderColor: '#cc2b2b', borderWidth: 2 },
}

/** 原始要素的兜底样式：与 MapInfoLayer 渲染默认值一致，保证进入编辑前后观感不变 */
const ORIG_DEFAULT_STYLES: Record<GeomKind, any> = {
  // 点：默认半径 6、填充 0.8 不透明、无描边（MapInfoLayer 默认边框色为无色哨兵，不画白边）
  point: { markerColor: '#f59e0b', markerRadius: 6, fillOpacity: 0.8, borderColor: NO_FILL_COLOR },
  line: { color: '#8b5cf6', weight: 3, opacity: 1, dashArray: '' },
  polygon: { fillColor: '#10b981', fillOpacity: 0.3, borderColor: '#10b981', borderWidth: 2, borderDash: '' },
}

/** 要素整体拖动阈值（像素）：小于该位移视为点击选中，不移动图形（防误触） */
const FEATURE_DRAG_THRESHOLD_PX = 5

/** 自动捕获节点容差（像素）：光标悬浮/绘制落点 */
const SNAP_TOLERANCE_PX = 14
/** 自动捕获节点容差（像素）：拖动节点时的吸附力（更大，便于靠近即吸附） */
const SNAP_TOLERANCE_DRAG_PX = 34
/** "跨元素双击"补判时间窗（ms）：点要素首次 click 落在图形、第二次落在新出现的把手 */
const DOUBLE_CLICK_MS = 400

/** 圆/椭圆参数（度坐标空间；rot 为绕中心旋转弧度） */
interface EllipseMeta { cx: number; cy: number; rx: number; ry: number; rot: number }

/** GeoJSON 几何类型 → 点/线/面分类（支持 Multi*）。 */
function geomKind(type: string): GeomKind {
  if (type === 'Point' || type === 'MultiPoint') return 'point'
  if (type === 'LineString' || type === 'MultiLineString') return 'line'
  return 'polygon'
}

export class LayerEditSession {
  private map: L.Map
  private editLayer: L.GeoJSON | null = null
  /** 编辑态圈选高亮层 */
  private shapeSelectLayer: L.GeoJSON | null = null
  private handleGroup: L.LayerGroup
  /** 线要素命中代理层：透明加粗线转发点击事件（原生 SVG 细线极难点中） */
  private hitGroup: L.LayerGroup
  /** 线要素方向箭头装饰层（"带方向线段的线"样式；divIcon 标记，不参与命中） */
  private lineArrowGroup: L.LayerGroup
  /** 当前工作集中"带方向线段"的线要素渲染层（rebuild 时收集，选中态切换仅重画这些） */
  private arrowLineLeaves: any[] = []
  private layerId: string | null = null
  private selectedEditId: string | null = null
  /** 点要素首次点击（落在图形上、把手尚未创建）的时间与 editId：供把手 click 补判双击 */
  private pointClickAt = 0
  private pointClickEditId: string | null = null
  /** 当前选中要素中被点选的顶点下标集合（Delete 键批量删除） */
  private vertexSel: Set<number> = new Set()

  // ---------- 自动捕获节点（S 键开关） ----------
  /** 自动捕获节点开关（英文输入法按 S 切换，编辑态生效） */
  private snapEnabled = false
  /** 捕获提示圈标记 */
  private snapMarker: L.Marker | null = null
  private snapHintTimer: number | null = null
  /** 其他可见图层节点来源（OnlineMap 提供，返回可见图层渲染层，不受"可选"开关控制） */
  private snapSourceProvider: (() => L.Layer[]) | null = null
  /** 候选节点缓存（latlng，构建一次；rebuild 失效） */
  private snapCache: L.LatLng[] | null = null
  /** 与 snapCache 一一对应的容器像素坐标（地图移动/缩放后重投影，避免每帧逐点投影） */
  private snapPx: Float64Array | null = null
  private snapPxDirty = true
  private boundSnapMapDirty: () => void = () => { this.snapPxDirty = true }
  /**
   * 外部工具（测量/打点）激活标志：由 OnlineMap 同步。
   * 捕获开启时这些工具的悬停同样显示捕获标记与十字光标，落点吸附走 snapLatLng()。
   */
  private externalSnapFeedback = false

  // ---------- 节点合并（拖框对齐到参考图层边框） ----------
  private nodeMergeMode = false
  private referenceSourceProvider: (() => MergeReferenceSource[]) | null = null
  private mergeRect: L.Rectangle | null = null
  private mergeEditableGroup: L.LayerGroup | null = null
  private mergeRefGroup: L.LayerGroup | null = null
  private mergeDrag: { startPx: L.Point; startLL: L.LatLng; moved: boolean } | null = null
  /** 本次拖框命中的可编辑环（mouseup 执行用） */
  private mergeEditableHits: MergeEditableHit[] = []
  /** 松开后等待用户点击蓝色候选要素；null=未在等待 */
  private mergePendingCandidates: MergeCandidate[] | null = null
  /** 真实拖框后吞掉浏览器尾随的 click（mousedown→mouseup 手势后 click 仍会派发） */
  private mergeSuppressNextClick = false
  private mergeRaf = 0
  private mergeLastBounds: L.LatLngBounds | null = null
  /** document 级 mouseup 兜底清理（鼠标在容器外松开时复位拖框态） */
  private boundMergeDocMouseUp: () => void
  private boundMergeMouseDown: (e: L.LeafletMouseEvent) => void
  private boundMergeMouseUp: (e: L.LeafletMouseEvent) => void

  // 绘制中间态
  private drawTool: DrawTool = 'none'
  private drawPoints: L.LatLng[] = []
  private tempLayer: any = null
  private tempVertexMarkers: L.CircleMarker[] = []
  /** 工具栏"选择"工具激活态：激活时点击要素选中、双击要素弹属性/风格配置 */
  private selectMode = false
  /** 当前编辑图层名称（属性弹窗副标题用） */
  private layerName: string | null = null

  /** 手形（地图拖拽）工具激活标志：激活时禁用要素整体拖动（由 OnlineMap 同步） */
  isPanToolActive = false

  // 要素整体拖动中间态（编辑态按住左键移位）
  private featureDrag: {
    leaf: any
    startLL: L.LatLng
    startPt: L.Point
    orig: any
    moved: boolean
  } | null = null

  /**
   * 最近一次按下左键的位置（像素）：用于区分"点击选中"与"拖动"。
   * 按住→拖动的浏览器手势在抬起后仍会补发 click，位移超过阈值时视为拖动，
   * 不选中要素、也不清空已有选中（"拖动不选中，点击才选中"）。
   */
  private pointerDownPt: L.Point | null = null

  private boundMapClick: (e: L.LeafletMouseEvent) => void
  private boundMouseMove: (e: L.LeafletMouseEvent) => void
  private boundDblClick: (e: L.LeafletMouseEvent) => void
  private boundContextMenu: (e: L.LeafletMouseEvent) => void
  private boundFeatureDragMove: (e: L.LeafletMouseEvent) => void
  private boundFeatureDragUp: () => void
  /** 地图级按下记录（空白处按下也要记，供地图 click 判定是否拖动） */
  private boundPointerDown: (e: L.LeafletMouseEvent) => void

  constructor(map: L.Map) {
    this.map = map
    if (!map.getPane(EDIT_PANE)) {
      const pane = map.createPane(EDIT_PANE)
      pane.style.zIndex = '650'
      pane.style.pointerEvents = 'auto'
    }
    if (!map.getPane(HANDLE_PANE)) {
      const hpane = map.createPane(HANDLE_PANE)
      hpane.style.zIndex = '660'
      hpane.style.pointerEvents = 'auto'
    }
    this.handleGroup = L.layerGroup().addTo(map)
    this.hitGroup = L.layerGroup().addTo(map)
    this.lineArrowGroup = L.layerGroup().addTo(map)

    // 节点捕获/合并初始态跟随 store（工具栏按钮可能在会话创建前已切换）
    this.snapEnabled = !!useLayerEditStore.getState().snapEnabled
    // 容器外松开时 map 不派发 mouseup：已拖框则按最终 bounds 完成，否则清预览；
    // 容器内松开时 map handler 先执行并置空 mergeDrag，此回调随后变为空操作
    this.boundMergeDocMouseUp = () => {
      const drag = this.mergeDrag
      this.mergeDrag = null
      if (this.mergeRaf) { cancelAnimationFrame(this.mergeRaf); this.mergeRaf = 0 }
      if (!drag) return
      if (drag.moved && this.mergeLastBounds) this.finalizeMerge(this.mergeLastBounds)
      else this.clearMergeOverlay()
    }
    if (useLayerEditStore.getState().nodeMergeMode) this.setNodeMergeMode(true)
    this.boundMapClick = (e) => this.handleMapClick(e)
    this.boundMouseMove = (e) => this.handleMouseMove(e)
    this.boundDblClick = (e) => this.handleDblClick(e)
    this.boundContextMenu = (e) => this.handleContextMenu(e)
    this.boundFeatureDragMove = (e) => this.handleFeatureDragMove(e)
    this.boundFeatureDragUp = () => this.handleFeatureDragUp()
    this.boundPointerDown = (e) => { this.pointerDownPt = e.containerPoint }
    this.boundMergeMouseDown = (e) => this.handleMergeMouseDown(e)
    this.boundMergeMouseUp = (e) => this.handleMergeMouseUp(e)
    map.on('click', this.boundMapClick)
    map.on('mousemove', this.boundMouseMove)
    map.on('dblclick', this.boundDblClick)
    map.on('contextmenu', this.boundContextMenu)
    map.on('mousedown', this.boundPointerDown)
    map.on('mousedown', this.boundMergeMouseDown)
    map.on('mouseup', this.boundMergeMouseUp)
    // 捕获像素缓存失效：地图平移/缩放/resize 后需重投影（moveend 后首次 mousemove 重建一次）
    map.on('move zoom viewreset resize', this.boundSnapMapDirty)
  }

  isDrawing(): boolean {
    return this.drawTool !== 'none'
  }

  isEditing(): boolean {
    return this.layerId !== null
  }

  /** 当前编辑图层名（属性框副标题用；未设置时返回 null） */
  getLayerName(): string | null {
    return this.layerName
  }

  /** 当前圈选选中要素数（底部提示条"删除"按钮同步用） */
  getShapeSelectedCount(): number {
    return this.shapeSelectedIds.size
  }

  /**
   * 命中检测：返回编辑层渲染要素中精确命中给定点的要素（手形工具点击弹属性框用）。
   * 与数据图层口径一致（mapHitTest.layerHitAt）：面按填充包含判定，
   * 仅边框容差命中记为 border（弱命中），点/线按像素距离 —— 避免包围盒覆盖
   * 或边框线条交叠就误弹重叠列表。
   */
  getFeaturesAtPoint(latLng: L.LatLng): Array<{ properties: Record<string, any>; geometry: any; hitType: FeatureHitType; distancePx: number }> {
    if (!this.editLayer) return []
    const out: Array<{ properties: Record<string, any>; geometry: any; hitType: FeatureHitType; distancePx: number }> = []
    this.editLayer.eachLayer((layer: any) => {
      const f = layer?.feature
      if (!f) return
      let hit: ReturnType<typeof layerHitAt> = null
      try {
        hit = layerHitAt(this.map, layer, latLng, CLICK_HIT_TOLERANCE_PX)
      } catch { /* 忽略无位置信息的图层 */ }
      if (hit) {
        out.push({ properties: f.properties || {}, geometry: f.geometry, hitType: hit.type, distancePx: hit.distancePx })
      }
    })
    return out
  }

  /**
   * 编辑会话全部要素的地理范围（图层预览用：装饰图层编辑态由会话渲染，常显显示层已被摘除）
   * @returns LatLngBounds；无要素/未渲染返回 null
   */
  getFeaturesBounds(): L.LatLngBounds | null {
    if (!this.editLayer) return null
    const bounds = L.latLngBounds([])
    let has = false
    this.editLayer.eachLayer((layer: any) => {
      try {
        if (typeof layer.getLatLng === 'function') {
          bounds.extend(layer.getLatLng())
          has = true
        } else if (typeof layer.getBounds === 'function') {
          bounds.extend(layer.getBounds())
          has = true
        }
      } catch { /* 忽略单要素异常 */ }
    })
    return has ? bounds : null
  }

  // ---------- 工作集加载/清除 ----------

  /** 加载（或切换）编辑图层工作集（要素已在 layerEditStore.workspaces 中，可为混合几何）。 */
  setWorkspace(layerId: string, layerName?: string | null) {
    const sameLayer = this.layerId === layerId
    this.layerId = layerId
    if (layerName !== undefined) this.layerName = layerName
    // 仅切换图层时复位绘制态；同图层要素变化（绘制落点/拖拽/删除/撤销）不得打断
    // 当前绘制工具 —— 否则点工具画完第一个点就被停掉（"只能画一个点"的根因）。
    if (!sameLayer) this.stopDraw()
    // 同一图层内的要素变化（拖拽/删除/插入顶点、撤销）仅重建，保留选中与顶点把手；
    // 切换图层时才清空选中。
    if (!sameLayer) this.deselect()
    this.rebuild()
  }

  /** 退出编辑：移除编辑层与把手（store 工作集保留，未保存更改不丢）。 */
  clear() {
    this.setNodeMergeMode(false)
    this.stopDraw()
    this.deselect()
    this.clearShapeSelection()
    this.hitGroup.clearLayers()
    this.arrowLineLeaves = []
    this.lineArrowGroup.clearLayers()
    if (this.editLayer) {
      this.map.removeLayer(this.editLayer)
      this.editLayer = null
    }
    this.layerId = null
  }

  destroy() {
    this.clear()
    this.map.off('click', this.boundMapClick)
    this.map.off('mousemove', this.boundMouseMove)
    this.map.off('dblclick', this.boundDblClick)
    this.map.off('contextmenu', this.boundContextMenu)
    this.map.off('mousedown', this.boundPointerDown)
    this.map.off('mousemove', this.boundFeatureDragMove)
    this.map.off('mouseup', this.boundFeatureDragUp)
    this.map.off('mousedown', this.boundMergeMouseDown)
    this.map.off('mouseup', this.boundMergeMouseUp)
    document.removeEventListener('mouseup', this.boundMergeDocMouseUp)
    this.map.off('move zoom viewreset resize', this.boundSnapMapDirty)
    if (this.mergeRaf) cancelAnimationFrame(this.mergeRaf)
    if (this.mergeEditableGroup) { this.map.removeLayer(this.mergeEditableGroup); this.mergeEditableGroup = null }
    if (this.mergeRefGroup) { this.map.removeLayer(this.mergeRefGroup); this.mergeRefGroup = null }
    this.map.removeLayer(this.handleGroup)
    this.map.removeLayer(this.hitGroup)
    this.map.removeLayer(this.lineArrowGroup)
  }

  // ---------- 渲染 ----------

  private currentWorkspace() {
    return this.layerId ? useLayerEditStore.getState().getWorkspace(this.layerId) : undefined
  }

  /**
   * 要素渲染样式优先级：要素自身 _editStyle（属性弹窗里配置的风格）
   * > 新绘制要素用 drawStyleMap / 原要素按编辑前渲染优先级还原
   *   （图层用户配色 baseStyle > 要素自带 _style > MapInfoLayer 默认 > 专题配色最优先）。
   * 注：MapInfo 原生自带 _style 字段，故要素级样式用 _editStyle 键避免冲突。
   */
  private styleFor(kind: GeomKind, feature?: any): any {
    const own = feature?.properties?._editStyle
    if (own && typeof own === 'object') {
      // 点/线/面分段存储时按几何类型取，整体存储时直接返回
      const seg = (own as any)[kind]
      if (seg && typeof seg === 'object') return seg
      // 仅当该样式确属当前几何类型时才整体返回（避免把点样式误用于面）
      const kindOfStyle =
        own.markerShape !== undefined || (own.markerSize !== undefined && own.markerColor !== undefined)
          ? 'point'
          : own.fillColor !== undefined
            ? 'polygon'
            : 'line'
      if (kindOfStyle === kind) return own
    }
    const isNew = this.isNewFeature(feature)
    if (isNew) {
      const saved = useMapStore.getState().mapSettings.drawStyleMap?.[kind]
      return saved || DEFAULT_STYLES[kind]
    }
    // 原始要素：还原编辑前的渲染配色（打开编辑开关不应改变图形配色）。
    // 优先级与 MapInfoLayer 一致：默认 < 要素自带 _style < 图层用户配色(baseStyle) < 专题设置。
    const merged: any = { ...ORIG_DEFAULT_STYLES[kind], ...(this.nativeStyleFor(kind, feature) || {}) }
    const base = this.currentWorkspace()?.baseStyle?.[kind] || {}
    for (const [k, v] of Object.entries(base)) {
      // 仅覆盖用户/文件真正配置过的键（未配置的键保持 undefined，避免发明颜色覆盖要素原生配色）
      if (v !== undefined && v !== null && v !== '') (merged as any)[k] = v
    }
    const ts = this.thematicSettingsFor()
    if (ts && ts.field) {
      const c = matchThematicColor(ts, getFieldValue(feature?.properties, ts.field))
      if (c) {
        if (kind === 'point') {
          merged.markerColor = c
          merged.fillColor = c
          if (ts.pointSize) {
            // 与 MapInfoLayer 一致：专题点大小即 circleMarker 半径；形状图标直径 = 半径×2
            merged.markerRadius = ts.pointSize
            merged.markerIconPx = Math.max(12, Math.min(36, ts.pointSize * 2))
          }
          if (ts.borderColor) merged.borderColor = ts.borderColor
          merged.fillOpacity = ts.fillOpacity ?? merged.fillOpacity ?? 1
        } else if (kind === 'line') {
          merged.color = c
          if (ts.pointSize) merged.weight = ts.pointSize
          if (typeof ts.fillOpacity === 'number') merged.opacity = ts.fillOpacity
        } else {
          merged.fillColor = c
          merged.borderColor = ts.borderColor || (c === NO_FILL_COLOR ? merged.borderColor : c)
          if (typeof ts.fillOpacity === 'number') merged.fillOpacity = ts.fillOpacity
          if (ts.pointSize) merged.borderWidth = ts.pointSize
        }
      }
    }
    return merged
  }

  /** 当前图层生效的专题设置（未启用返回 null） */
  private thematicSettingsFor(): ThematicSettings | null {
    if (!this.layerId) return null
    const ts = useMapStore.getState().mapSettings.thematicSettingsMap?.[this.layerId] as
      | ThematicSettings
      | undefined
    return ts?.enabled ? ts : null
  }

  /**
   * 要素自带 _style（后端注入的 MapInfo/KML 原生样式）按几何类型归一化为编辑会话样式键。
   * 键缺失保持 undefined（不发明默认值），由 ORIG_DEFAULT_STYLES / baseStyle 兜底。
   */
  private nativeStyleFor(kind: GeomKind, feature: any): any | null {
    const s = feature?.properties?._style
    if (!s || typeof s !== 'object') return null
    if (kind === 'point') {
      const st: any = {
        markerColor: s.markerColor ?? s.fillColor,
        markerSize: s.markerSize ?? s.radius,
        borderColor: s.strokeColor,
      }
      const shape = resolvePointShape(s.markerSymbol)
      if (shape) st.markerShape = shape
      if (st.markerSize !== undefined) {
        // 与 MapInfoLayer 渲染约定一致：circleMarker 半径 = markerSize；形状图标直径 clamp(2×markerSize)
        st.markerRadius = st.markerSize
        st.markerIconPx = Math.max(12, Math.min(36, Math.round(st.markerSize * 2)))
      }
      return st
    }
    if (kind === 'line') {
      return {
        color: s.strokeColor ?? s.color,
        weight: s.strokeWidth,
        opacity: s.strokeOpacity,
        dashArray: s.strokeDasharray,
      }
    }
    const st: any = {
      fillColor: s.fillColor,
      fillOpacity: s.fillOpacity,
      borderColor: s.strokeColor,
      borderWidth: s.strokeWidth,
      borderDash: s.strokeDasharray,
    }
    // KML <fill>0</fill>（无填充）：与 MapInfoLayer 一致，仅显示边框
    if (s.fill === false) st.fillOpacity = 0
    return st
  }

  private pathOptions(kind: GeomKind, feature: any, selected: boolean): L.PathOptions {
    const st = this.styleFor(kind, feature)
    if (kind === 'point') {
      // 图形颜色无色（markerColor='none'）：点镂空仅显示边框（与 MapInfoLayer 一致）
      const noFill = st.markerColor === NO_FILL_COLOR
      // 边框：未配置（undefined）或无色哨兵均不描边 —— MapInfoLayer 默认不画白边
      const noStroke = !selected && (st.borderColor === undefined || st.borderColor === NO_FILL_COLOR)
      return {
        pane: EDIT_PANE,
        // 原始要素 markerRadius 与 MapInfoLayer 渲染一致（半径 = markerSize）；
        // 新绘制要素沿用绘制样式约定（markerSize 视为直径）
        radius: st.markerRadius ?? (st.markerSize ?? 8) / 2 + 1,
        color: selected ? SELECT_COLOR : (noStroke ? '#000000' : st.borderColor),
        stroke: selected || !noStroke,
        weight: selected ? 3 : 2,
        fillColor: noFill ? 'transparent' : (st.markerColor || '#ff6b6b'),
        fillOpacity: noFill ? 0 : (st.fillOpacity ?? 0.8),
        fill: !noFill,
      } as L.PathOptions
    }
    if (kind === 'line') {
      const color = selected ? SELECT_COLOR : st.color
      // 线色为无色哨兵（'none'）：不描边（与 MapInfoLayer 渲染一致），color 置占位色避免非法值
      const noStroke = !selected && color === NO_FILL_COLOR
      return {
        pane: EDIT_PANE,
        color: noStroke ? '#8b5cf6' : color,
        stroke: !noStroke,
        weight: selected ? 3.5 : st.weight ?? 2.5,
        opacity: st.opacity ?? 0.95,
        dashArray: selected ? '6,3' : st.dashArray || undefined,
      } as L.PathOptions
    }
    return {
      pane: EDIT_PANE,
      color: selected ? SELECT_COLOR : st.borderColor || st.fillColor,
      weight: selected ? 3 : st.borderWidth ?? 2,
      fillColor: st.fillColor === 'none' ? 'transparent' : (st.fillColor || '#ff6b6b'),
      fillOpacity: st.fillColor === 'none' ? 0 : (st.fillOpacity ?? 0.3),
      dashArray: selected ? '6,3' : st.borderDash || undefined,
    } as L.PathOptions
  }

  /** 非圆形的点要素用 SVG divIcon 渲染（circle 仍用 circleMarker，量大时更快）。 */
  private pointDivIcon(st: any, selected: boolean): L.DivIcon {
    // markerIconPx：原始要素按 MapInfoLayer 约定（直径 = clamp(2×markerSize)）；
    // 新绘制要素沿用绘制样式约定（markerSize 即图标尺寸）
    const size = Math.max(6, Number(st.markerIconPx ?? st.markerSize ?? 8))
    const s = size + 4
    // 图形颜色无色：SVG fill="none"（镂空仅描边）
    const fill = st.markerColor === NO_FILL_COLOR ? 'none' : (st.markerColor || '#ff6b6b')
    // 边框：未配置（undefined）或无色哨兵均不描边（与 MapInfoLayer 默认一致，不画白边）
    const noStroke = !selected && (st.borderColor === undefined || st.borderColor === NO_FILL_COLOR)
    const stroke = selected ? SELECT_COLOR : (noStroke ? 'none' : st.borderColor)
    const sw = selected ? 2.5 : 2
    const paint = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"`
    let body: string
    switch (st.markerShape) {
      case 'square':
        body = `<rect x="2" y="2" width="${s - 4}" height="${s - 4}" rx="1" ${paint}/>`
        break
      case 'diamond':
        body = `<polygon points="${s / 2},2 ${s - 2},${s / 2} ${s / 2},${s - 2} 2,${s / 2}" ${paint}/>`
        break
      case 'triangle':
        body = `<polygon points="${s / 2},2 ${s - 2},${s - 2} 2,${s - 2}" ${paint}/>`
        break
      case 'triangle_down':
        body = `<polygon points="2,2 ${s - 2},2 ${s / 2},${s - 2}" ${paint}/>`
        break
      case 'star': {
        // 与 MapInfoLayer.pointShapeIconDataUri 的 32px 星形等比缩放
        const k = s / 32
        const star: Array<[number, number]> = [
          [16, 2], [19, 11], [29, 11], [21, 17], [24, 27],
          [16, 21], [8, 27], [11, 17], [3, 11], [13, 11],
        ]
        body = `<polygon points="${star.map((p) => `${p[0] * k},${p[1] * k}`).join(' ')}" ${paint}/>`
        break
      }
      case 'landmark':
        body =
          `<path d="M${s / 2} 2 L${s - 3} ${s * 0.31} L${s / 2} ${s * 0.53} L3 ${s * 0.31} Z" ${paint}/>` +
          `<rect x="3" y="${s * 0.375}" width="${s - 6}" height="${s * 0.125}" ${paint}/>` +
          `<rect x="${s * 0.375}" y="${s * 0.5}" width="${s * 0.25}" height="${s * 0.34}" ${paint}/>`
        break
      case 'pin':
        body = `<path d="M${s / 2} ${s - 2} C${s * 0.2} ${s * 0.58} ${s * 0.2} ${s * 0.2} ${s / 2} ${s * 0.2} C${s * 0.8} ${s * 0.2} ${s * 0.8} ${s * 0.58} ${s / 2} ${s - 2} Z" ${paint}/><circle cx="${s / 2}" cy="${s * 0.42}" r="${s * 0.12}" fill="#fff"/>`
        break
      default:
        body = `<circle cx="${s / 2}" cy="${s / 2}" r="${(s - 4) / 2}" ${paint}/>`
    }
    return L.divIcon({
      pane: EDIT_PANE,
      className: '',
      iconSize: [s, s],
      iconAnchor: [s / 2, s / 2],
      html: `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">${body}</svg>`,
    })
  }

  /** 点要素是否为 divIcon 标记（非 circleMarker） */
  private isIconPoint(st: any): boolean {
    return (st.markerShape || 'circle') !== 'circle'
  }

  /** 应用/取消选中高亮：circleMarker 改样式，divIcon 标记换图标。 */
  private applySelectStyle(leaf: any, selected: boolean) {
    if (!leaf) return
    const kind = this.featureKind(leaf)
    const isMarker = typeof leaf.setIcon === 'function' && typeof leaf.setStyle !== 'function'
    if (isMarker) {
      leaf.setIcon(this.pointDivIcon(this.styleFor(kind, leaf.feature), selected))
      return
    }
    leaf.setStyle?.(this.pathOptions(kind, leaf?.feature, selected))
  }

  private isNewFeature(feature: any): boolean {
    return !!(feature?.properties?._isNew)
  }

  /** 从 store 工作集重建编辑层（增删/样式变化后调用）。 */
  rebuild() {
    if (!this.layerId) return
    const ws = useLayerEditStore.getState().getWorkspace(this.layerId)
    if (!ws) return
    // 要素重建后节点缓存失效（拖动/新增顶点改变了节点集合）
    this.snapCache = null
    this.snapPx = null
    this.snapPxDirty = true

    if (this.editLayer) {
      this.map.removeLayer(this.editLayer)
      this.editLayer = null
    }
    this.clearHandles()

    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: ws.features as any,
    }
    this.editLayer = L.geoJSON(data as any, {
      pane: EDIT_PANE,
      // 点要素
      pointToLayer: (feature, latlng) => {
        const kind = geomKind(feature.geometry.type)
        const selected = (feature.properties?._editId === this.selectedEditId)
        const st = this.styleFor(kind, feature)
        if (this.isIconPoint(st)) {
          return L.marker(latlng, { pane: EDIT_PANE, icon: this.pointDivIcon(st, selected) })
        }
        return L.circleMarker(latlng, this.pathOptions(kind, feature, selected))
      },
      // 线/面要素
      style: (feature) => {
        const kind = feature?.geometry ? geomKind(feature.geometry.type) : 'polygon'
        const selected = (feature?.properties?._editId === this.selectedEditId)
        return this.pathOptions(kind, feature, selected)
      },
      onEachFeature: (feature, layer) => {
        this.bindFeatureEvents(layer, feature, layer)
        const editId = (feature.properties?._editId as string) || null
        if (editId && editId === this.selectedEditId) {
          (layer as any).bringToFront?.()
        }
      },
    })
    this.editLayer.addTo(this.map)

    // 线要素命中代理：原生 SVG 路径命中区域 ≈ 线宽（默认 2.5px），细线极难点中。
    // 叠加一条完全透明（opacity:0 不影响事件命中）、14px+ 加粗的同形折线转发事件；
    // 不可用 0.01：道路中心线等密集线图层，半透明黑色粗边叠加会形成沿线阴影。
    // 同时收集"带方向线段"的线要素，供下方方向箭头渲染（选中态切换只需重画这些）。
    this.hitGroup.clearLayers()
    this.arrowLineLeaves = []
    this.editLayer.eachLayer((leaf: any) => {
      if (this.featureKind(leaf) !== 'line') return
      const st = this.styleFor('line', leaf.feature)
      if (st.arrow) this.arrowLineLeaves.push(leaf)
      const proxy = L.polyline(leaf.getLatLngs(), {
        pane: EDIT_PANE,
        stroke: true,
        color: '#000000',
        weight: Math.max(14, (st.weight ?? 2.5) + 12),
        opacity: 0,
        fill: false,
        interactive: true,
      } as any)
      this.bindFeatureEvents(proxy, leaf.feature, leaf)
      proxy.addTo(this.hitGroup as any)
    })
    this.rebuildLineArrows()

    // 恢复选中把手
    if (this.selectedEditId) {
      const leaf = this.findLeafLayer(this.selectedEditId)
      if (leaf) this.showHandles(leaf)
    }
  }

  /**
   * 重建"带方向线段的线"箭头装饰（候选要素由 rebuild 时的 arrowLineLeaves 提供）。
   * 箭头用线色渲染，选中时随线条一起变为选中色。
   */
  private rebuildLineArrows() {
    this.lineArrowGroup.clearLayers()
    for (const leaf of this.arrowLineLeaves) {
      const feature = leaf?.feature
      if (!feature) continue
      const st = this.styleFor('line', feature)
      if (!st?.arrow) continue
      const selected = feature.properties?._editId === this.selectedEditId
      const color = selected ? SELECT_COLOR : st.color
      // 线色为无色哨兵（不描边）时不画箭头
      if (!color || color === NO_FILL_COLOR) continue
      const markers = buildLineArrows(leaf.getLatLngs(), {
        color,
        opacity: st.opacity ?? 0.95,
        pane: EDIT_PANE,
      })
      for (const m of markers) this.lineArrowGroup.addLayer(m)
    }
  }

  /**
   * 本次手势是否为"拖动"：按下点与抬起点（click 事件位置）的位移超过阈值。
   * 浏览器在手势结束后仍会补发 click，拖动需据此与点击区分。
   */
  private isDragGesture(e: { containerPoint?: L.Point; latlng?: L.LatLng }): boolean {
    const down = this.pointerDownPt
    if (!down) return false
    const up = e.containerPoint || (e.latlng ? this.map.latLngToContainerPoint(e.latlng) : null)
    if (!up) return false
    return down.distanceTo(up) > FEATURE_DRAG_THRESHOLD_PX
  }

  /** 要素交互事件绑定（真实渲染层与线命中代理共用；realLeaf 为真实渲染层）。 */
  private bindFeatureEvents(target: L.Layer, feature: any, realLeaf: any) {
    const editId = (feature.properties?._editId as string) || null
    target.on('click', (e: any) => {
      // 绘制中放行点击（不拦截）：让地图 click 继续加顶点/落点。
      // 否则点击落在既有要素上会被 stopPropagation 吞掉，
      // 图层要素覆盖的区域内完全无法绘制（"绘制工具无效"的根因）。
      if (this.drawTool !== 'none') return
      // 选中/编辑规则：需激活工具栏"选择"工具，否则点击要素不产生选中与端点。
      // （编辑开关关闭时由 OnlineMap 的"选择"工具路径处理：仅高亮、不可编辑）
      if (!this.selectMode) return
      L.DomEvent.stopPropagation(e)
      // 拖动不选中：在图形上按住拖动（位移超阈值）后浏览器仍补发 click，
      // 该手势视为拖动，不选中要素（选中只由"点击"触发）
      if (this.isDragGesture(e)) return
      this.select(editId, realLeaf)
    })
    // 按住左键拖动整体移位（编辑态 + "选择"工具激活 + 非绘制 + 非手形工具）。
    // 只有"已点选（选中）"的要素才能整体移动：未选中的要素按住左键不移动，
    // 单击先选中、再按住拖动才位移（避免误拖与"拖走了别的图形"）。
    target.on('mousedown', (e: any) => {
      // 记录按下位置（供 click 判定是否拖动）；未选中要素的按下不 stopPropagation，
      // 由地图级记录兜底，值一致
      this.pointerDownPt = e.containerPoint || this.map.latLngToContainerPoint(e.latlng)
      if (this.drawTool !== 'none' || !this.selectMode || this.isPanToolActive || this.featureDrag) return
      if (!editId || editId !== this.selectedEditId) return
      L.DomEvent.stopPropagation(e)
      this.beginFeatureDrag(realLeaf, e.latlng, e.containerPoint)
    })
    // 双击要素（"选择"工具激活时）弹出图形属性 + 风格配置
    target.on('dblclick', (e: any) => {
      L.DomEvent.stopPropagation(e)
      if (this.drawTool !== 'none' || !this.selectMode) return
      this.select(editId, realLeaf)
      useLayerEditStore.getState().setInspectFeature({
        layerId: this.layerId!,
        layerName: this.layerName || undefined,
        editId: editId || undefined,
        geometry: feature.geometry,
        properties: feature.properties,
        editable: true,
      })
    })
  }

  /** 样式设置变化后刷新渲染。 */
  refreshStyle() {
    if (this.layerId) this.rebuild()
  }

  private featureKind(leaf: any): GeomKind {
    return geomKind(leaf?.feature?.geometry?.type || 'Point')
  }

  private findLeafLayer(editId: string): L.Layer | null {
    if (!this.editLayer) return null
    let found: L.Layer | null = null
    this.editLayer.eachLayer((layer: any) => {
      if (layer?.feature?.properties?._editId === editId) found = layer
    })
    return found
  }

  // ---------- 几何结构工具（保持 Multi/洞结构，修复拖顶点坍缩） ----------

  /** 环闭合（LatLng） */
  private closeLatLngs(ring: L.LatLng[]): L.LatLng[] {
    if (ring.length > 1) {
      const a = ring[0]
      const b = ring[ring.length - 1]
      if (a.lat !== b.lat || a.lng !== b.lng) return [...ring, L.latLng(a.lat, a.lng)]
    }
    return ring
  }

  /** 环去闭合点（仅首尾坐标相同时去除，避免误删真实顶点） */
  private openRing(ring: L.LatLng[]): L.LatLng[] {
    if (ring.length > 1) {
      const a = ring[0]
      const b = ring[ring.length - 1]
      if (a.lat === b.lat && a.lng === b.lng) return ring.slice(0, -1)
    }
    return ring
  }

  /**
   * leaf 是否为 MultiPolygon 结构（三层：部件 → 环组[外环,洞...] → 环点）。
   * Polygon 带洞只有两层（环组 → 环点）；两种结构的 internal[0][0]
   * 分别是"环组数组"与 LatLng。
   */
  private isMultiPolygonLeaf(leaf: any): boolean {
    const internal = (leaf as any)._latlngs
    return (
      Array.isArray(internal) && internal.length > 0
      && Array.isArray(internal[0]) && Array.isArray(internal[0][0])
      && !(internal[0][0] instanceof L.LatLng)
    )
  }

  /**
   * 面/线的"环"数组：用内部 _latlngs 保留多部件/洞。
   * 注意 Leaflet 的 getLatLngs() 只返回第一部分（Polygon 返回扁平外环），
   * 直接用它替换会丢掉洞/其他部件（旧实现据此把带洞面与 Multi 面打平，是
   * "拖顶点整个图形坍缩为一条直线"的根因）。
   * MultiPolygon 三层结构在此展平为环列表（各部件外环/洞依次排列），
   * 供顶点编辑等既有逻辑统一处理；写回时 ringAccessor 还原嵌套。
   */
  private partsOf(leaf: any): L.LatLng[][] {
    const internal = (leaf as any)._latlngs
    if (Array.isArray(internal) && internal.length > 0 && Array.isArray(internal[0])) {
      if (this.isMultiPolygonLeaf(leaf)) {
        return (internal as any[][]).reduce(
          (acc: L.LatLng[][], group) => acc.concat(group as L.LatLng[]),
          [] as L.LatLng[][],
        )
      }
      return internal as L.LatLng[][]
    }
    const ll = leaf.getLatLngs()
    return [Array.isArray(ll) ? (ll as L.LatLng[]) : []] as L.LatLng[][]
  }

  /**
   * 面要素首个外环的读取/替换（保持 Multi/洞结构）。
   */
  private ringAccessor(leaf: any, isPoly: boolean): { getRing(): L.LatLng[]; setRing(r: L.LatLng[]): void } {
    return {
      getRing: (): L.LatLng[] => {
        // MultiPolygon：第一部件的外环（_latlngs[0][0]）；其余取展平环列表第一个
        if (this.isMultiPolygonLeaf(leaf)) {
          return leaf._latlngs[0][0] || []
        }
        const parts = this.partsOf(leaf)
        return parts[0] || []
      },
      setRing: (r: L.LatLng[]) => {
        const closed = isPoly ? this.closeLatLngs(r) : r
        if (this.isMultiPolygonLeaf(leaf)) {
          // 还原三层嵌套：只替换第一部件外环，该部件的洞与其余部件保持
          const internal = leaf._latlngs
          const firstGroup = internal[0]
          leaf.setLatLngs([[closed, ...firstGroup.slice(1)], ...internal.slice(1)])
          return
        }
        const parts = this.partsOf(leaf)
        if (parts.length > 1) {
          // 多部件/带洞：只替换第一个环，其余保持
          leaf.setLatLngs([closed, ...parts.slice(1)])
        } else {
          leaf.setLatLngs(closed)
        }
      },
    }
  }

  /** 从 leaf 当前结构重建 GeoJSON geometry（保持原类型/多部件/洞）。 */
  private geometryFromLeaf(leaf: any): any {
    const t: string = leaf.feature?.geometry?.type || 'Polygon'
    const toCoords = (ring: L.LatLng[]) => ring.map((p) => [p.lng, p.lat] as [number, number])
    const closeR = (ring: L.LatLng[]) => this.closedRing(toCoords(ring))
    if (t === 'Point' || t === 'MultiPoint') {
      const pts: L.LatLng[] = t === 'Point' ? [leaf.getLatLng()] : (leaf.getLatLngs() as L.LatLng[])
      const coords = pts.map((p) => [p.lng, p.lat])
      return { type: t, coordinates: t === 'Point' ? coords[0] : coords }
    }
    const parts = this.partsOf(leaf)
    if (t === 'LineString') return { type: t, coordinates: toCoords(parts[0] || []) }
    if (t === 'MultiLineString') return { type: t, coordinates: parts.map(toCoords) }
    if (t === 'MultiPolygon') {
      // 保留部件嵌套：每部件 [外环, 洞...]（不能用展平 parts，否则洞被当成独立部件）
      return {
        type: t,
        coordinates: leaf._latlngs.map((group: L.LatLng[][]) =>
          group.map((ring: L.LatLng[]) => closeR(ring))),
      }
    }
    // Polygon：parts[0] = 外环，其余为洞
    return { type: 'Polygon', coordinates: parts.map(closeR) }
  }

  private closedRing(ring: Array<[number, number]>): Array<[number, number]> {
    if (ring.length > 1) {
      const first = ring[0]
      const last = ring[ring.length - 1]
      if (first[0] !== last[0] || first[1] !== last[1]) return [...ring, first]
    }
    return ring
  }

  private ringCentroid(ring: L.LatLng[]): L.LatLng {
    let sx = 0
    let sy = 0
    for (const p of ring) {
      sx += p.lng
      sy += p.lat
    }
    const n = Math.max(1, ring.length)
    return L.latLng(sy / n, sx / n)
  }

  /** 深拷贝嵌套 LatLng 结构（要素整体拖动用） */
  private cloneLatLngs(node: any): any {
    if (Array.isArray(node)) return node.map((n) => this.cloneLatLngs(n))
    const p = node as L.LatLng
    return L.latLng(p.lat, p.lng)
  }

  /** 嵌套 LatLng 结构整体平移 */
  private translateLatLngs(node: any, dLat: number, dLng: number): any {
    if (Array.isArray(node)) return node.map((n) => this.translateLatLngs(n, dLat, dLng))
    const p = node as L.LatLng
    return L.latLng(p.lat + dLat, p.lng + dLng)
  }

  /** 嵌套 LatLng 结构绕中心旋转（度坐标空间） */
  private rotateLatLngs(node: any, c: L.LatLng, delta: number): any {
    if (Array.isArray(node)) return node.map((n) => this.rotateLatLngs(n, c, delta))
    const p = node as L.LatLng
    const dx = p.lng - c.lng
    const dy = p.lat - c.lat
    const cos = Math.cos(delta)
    const sin = Math.sin(delta)
    return L.latLng(c.lat + dx * sin + dy * cos, c.lng + dx * cos - dy * sin)
  }

  // ---------- 选中/删除/顶点把手 ----------

  private select(editId: string | null, leafLayer?: L.Layer) {
    if (!editId) return
    this.deselect()
    this.selectedEditId = editId
    this.vertexSel.clear()
    const leaf: any = leafLayer || this.findLeafLayer(editId)
    if (leaf) {
      this.applySelectStyle(leaf, true)
      leaf.bringToFront?.()
      this.showHandles(leaf)
      // 点要素：记录首次点击（落在图形、把手刚创建），供把手 click 补判"跨元素双击"
      if (this.featureKind(leaf) === 'point') {
        this.pointClickAt = Date.now()
        this.pointClickEditId = editId
      }
    }
    this.rebuildLineArrows()
  }

  /** 打开点要素的图形属性弹窗（双击 / 跨元素双击补判共用）。 */
  private openPointInspect(editId: string, leaf: any) {
    useLayerEditStore.getState().setInspectFeature({
      layerId: this.layerId!,
      layerName: this.layerName || undefined,
      editId,
      geometry: leaf.feature.geometry,
      properties: leaf.feature.properties,
      editable: true,
    })
  }

  private deselect() {
    if (this.selectedEditId) {
      const leaf: any = this.findLeafLayer(this.selectedEditId)
      if (leaf) {
        this.applySelectStyle(leaf, false)
      }
    }
    this.selectedEditId = null
    this.vertexSel.clear()
    this.clearHandles()
    this.rebuildLineArrows()
  }

  private clearHandles() {
    this.handleGroup.clearLayers()
    this.snapMarker = null
  }

  // ---------- 自动捕获节点实现 ----------

  /** 注入其他可见图层的渲染层来源（OnlineMap 提供） */
  setSnapSourceProvider(p: (() => L.Layer[]) | null) {
    this.snapSourceProvider = p
    this.invalidateSnapCache()
  }

  /** 图层增删/显隐/加载完成后由 OnlineMap 调用：节点候选缓存失效（下次 mousemove 重建） */
  invalidateSnapCache() {
    this.snapCache = null
    this.snapPx = null
    this.snapPxDirty = true
  }

  isSnapEnabled(): boolean {
    return this.snapEnabled
  }

  setSnapEnabled(on: boolean) {
    this.snapEnabled = on
    if (!on) {
      this.clearSnapMarker()
      this.updateSnapCursor(false)
    }
    this.showSnapHint(on
      ? (i18n.t('map.snapOn') || '自动捕获节点：开（再按 S 关闭）')
      : (i18n.t('map.snapOff') || '自动捕获节点：关'))
  }

  toggleSnapEnabled(): boolean {
    this.setSnapEnabled(!this.snapEnabled)
    return this.snapEnabled
  }

  /**
   * 外部工具（测量/打点）落点吸附：捕获开启且命中附近节点时返回节点坐标并显示捕获标记，
   * 否则原样返回（不改变捕获开关状态）。
   */
  snapLatLng(ll: L.LatLng): L.LatLng {
    return this.applySnap(ll)
  }

  /** 测量/打点等外部工具的悬停捕获反馈开关（由 OnlineMap 按工具态同步） */
  setExternalSnapFeedback(on: boolean) {
    if (this.externalSnapFeedback === on) return
    this.externalSnapFeedback = on
    if (!on) {
      this.clearSnapMarker()
      // 清除捕获留下的内联光标（绘制/选择工具各自管理光标，不在此清理，
      // 否则会误删绘制态的十字光标）
      if (!this.selectMode && this.drawTool === 'none') {
        this.map.getContainer()?.style.removeProperty('cursor')
      }
    }
  }

  // ---------- 节点合并（拖框对齐边框） ----------

  /** 注入不可编辑参考图层来源（OnlineMap 提供：可见且非当前编辑层） */
  setReferenceSourceProvider(p: (() => MergeReferenceSource[]) | null) {
    this.referenceSourceProvider = p
  }

  /** 节点合并开关：开启后左键拖框；关闭时清除矩形/高亮/候选等待态 */
  setNodeMergeMode(on: boolean) {
    if (this.nodeMergeMode === on) return
    this.nodeMergeMode = on
    this.mergeDrag = null
    if (this.mergeRaf) { cancelAnimationFrame(this.mergeRaf); this.mergeRaf = 0 }
    this.clearMergeOverlay()
    const c = this.map.getContainer()
    if (on) {
      c.style.setProperty('cursor', 'crosshair', 'important')
      this.showMapHint(i18n.t('map.mergeModeOn') || '节点合并：按住左键拖框选择相邻边框')
    } else {
      c.style.removeProperty('cursor')
    }
  }

  /** 地图容器顶部临时提示条（1.8s 淡出；sticky 不淡出，由 clearMapHint 主动清除） */
  private showMapHint(text: string, sticky = false) {
    const c = this.map.getContainer()
    let el = c.querySelector(':scope > .npt-snap-hint') as HTMLElement | null
    if (!el) {
      el = document.createElement('div')
      el.className = 'npt-snap-hint'
      el.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:900;' +
        'background:rgba(0,0,0,0.72);color:#fff;font-size:12px;padding:4px 12px;border-radius:6px;' +
        'pointer-events:none;transition:opacity .5s;white-space:nowrap;'
      c.appendChild(el)
    }
    el.textContent = text
    el.style.opacity = '1'
    if (this.snapHintTimer) window.clearTimeout(this.snapHintTimer)
    if (!sticky) {
      this.snapHintTimer = window.setTimeout(() => { if (el) el.style.opacity = '0' }, 1800)
    }
  }

  private clearMapHint() {
    if (this.snapHintTimer) window.clearTimeout(this.snapHintTimer)
    const el = this.map.getContainer()?.querySelector(':scope > .npt-snap-hint') as HTMLElement | null
    if (el) el.style.opacity = '0'
  }

  private showSnapHint(text: string) {
    this.showMapHint(text)
  }

  /** 收集一个渲染层（L.GeoJSON）内所有可捕获节点 */
  private collectLayerVertices(layer: any, out: L.LatLng[]) {
    if (!layer || typeof layer.eachLayer !== 'function') return
    layer.eachLayer((leaf: any) => {
      const f = leaf?.feature
      if (!f) return
      if (leaf.getLatLng) {
        // 点要素
        out.push(leaf.getLatLng())
        return
      }
      if (typeof leaf.getLatLngs !== 'function') return
      // 线/面：getLatLngs 可能嵌套（Multi*），递归展平
      const flat: L.LatLng[] = []
      const walk = (arr: any[]) => {
        for (const it of arr) {
          if (it && typeof it.lat === 'number' && typeof it.lng === 'number') flat.push(it as L.LatLng)
          else if (Array.isArray(it)) walk(it)
        }
      }
      walk(leaf.getLatLngs() || [])
      flat.forEach((ll) => {
        out.push(ll)
      })
    })
  }

  private buildSnapCache() {
    const pts: L.LatLng[] = []
    if (this.editLayer) this.collectLayerVertices(this.editLayer, pts)
    if (this.snapSourceProvider) {
      let layers: L.Layer[] = []
      try { layers = this.snapSourceProvider() || [] } catch { /* ignore */ }
      for (const l of layers) this.collectLayerVertices(l, pts)
    }
    this.snapCache = pts
    this.snapPx = null
    this.snapPxDirty = true
  }

  /** 重投影候选节点到当前容器像素（仅地图移动/缩放后执行一次） */
  private rebuildSnapPx() {
    const pts = this.snapCache || []
    const arr = new Float64Array(pts.length * 2)
    for (let i = 0; i < pts.length; i++) {
      const p = this.map.latLngToContainerPoint(pts[i])
      arr[i * 2] = p.x
      arr[i * 2 + 1] = p.y
    }
    this.snapPx = arr
    this.snapPxDirty = false
  }

  /**
   * 查找光标附近（tolerancePx 像素内）最近的可捕获节点。
   * 候选 = 当前编辑工作集全部节点 + 所有打开的可见图层节点（节点不显示也可捕获）。
   * excludeLatLng：拖动顶点时排除被拖顶点原位置（含面环闭合重复点，坐标相同一并排除）。
   *
   * 性能：候选节点像素坐标缓存在 Float64Array，仅在地图移动/缩放后重投影一次；
   * mousemove 时只做一次光标投影 + 类型数组线性扫描（数十万节点 <2ms）。
   */
  findSnapNode(cursor: L.LatLng, tolerancePx = SNAP_TOLERANCE_PX, excludeLatLng?: L.LatLng): { latlng: L.LatLng } | null {
    if (!this.snapEnabled) return null
    if (!this.snapCache) this.buildSnapCache()
    const pts = this.snapCache!
    if (pts.length === 0) return null
    // 地图平移/缩放过程中像素坐标失效，跳过本次（moveend 后首次 mousemove 重建）
    if (this.snapPxDirty || !this.snapPx || this.snapPx.length !== pts.length * 2) this.rebuildSnapPx()
    const px = this.snapPx!
    const isExcluded = (ll: L.LatLng) =>
      !!excludeLatLng &&
      Math.abs(ll.lat - excludeLatLng.lat) < 1e-9 &&
      Math.abs(ll.lng - excludeLatLng.lng) < 1e-9
    const cp = this.map.latLngToContainerPoint(cursor)
    const tol2 = tolerancePx * tolerancePx
    let bestIdx = -1
    let bestD2 = tol2
    for (let i = 0; i < pts.length; i++) {
      const dx = px[i * 2] - cp.x
      const dy = px[i * 2 + 1] - cp.y
      const d2 = dx * dx + dy * dy
      if (d2 <= bestD2) {
        const ll = pts[i]
        if (isExcluded(ll)) continue
        bestD2 = d2
        bestIdx = i
      }
    }
    return bestIdx >= 0 ? { latlng: pts[bestIdx] } : null
  }

  /** 绘制/预览落点吸附：命中则显示捕获圈并返回节点坐标 */
  private applySnap(ll: L.LatLng): L.LatLng {
    if (!this.snapEnabled) return ll
    const hit = this.findSnapNode(ll)
    if (hit) {
      this.showSnapMarker(hit.latlng)
      return hit.latlng
    }
    this.clearSnapMarker()
    return ll
  }

  private showSnapMarker(ll: L.LatLng) {
    if (!this.snapMarker) {
      this.snapMarker = L.marker(ll, {
        pane: HANDLE_PANE,
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: '',
          iconSize: [30, 30],
          iconAnchor: [15, 15],
          // 大尺寸十字光标（替代原橙色小圆点）
          html: '<div style="position:relative;width:30px;height:30px;">' +
            '<div style="position:absolute;left:14px;top:0;width:2px;height:30px;background:#f59e0b;box-shadow:0 0 4px rgba(245,158,11,0.9);"></div>' +
            '<div style="position:absolute;left:0;top:14px;width:30px;height:2px;background:#f59e0b;box-shadow:0 0 4px rgba(245,158,11,0.9);"></div>' +
            '<div style="position:absolute;left:10px;top:10px;width:9px;height:9px;border:2px solid #fff;background:#f59e0b;border-radius:50%;"></div>' +
            '</div>',
        }),
      })
      this.snapMarker.addTo(this.handleGroup)
    } else {
      this.snapMarker.setLatLng(ll)
    }
  }

  private clearSnapMarker() {
    if (this.snapMarker) {
      this.handleGroup.removeLayer(this.snapMarker)
      this.snapMarker = null
    }
  }

  /** 捕获命中时光标变十字（靠近节点）；否则恢复默认 */
  private updateSnapCursor(near: boolean) {
    const c = this.map.getContainer()
    if (!c) return
    // 绘制态本身已是十字光标，无需覆盖
    if (this.drawTool !== 'none') return
    if (near && this.snapEnabled && (this.selectMode || this.externalSnapFeedback)) {
      // 内联 !important 优先于样式表 !important（手形工具的 .map-drag-active
      // 用 cursor: grab !important 接管光标，普通内联样式会被覆盖，导致
      // 切到手形后"捕获看起来退出"——这里用同级优先的内联声明强制十字）
      c.style.setProperty('cursor', 'crosshair', 'important')
    } else if (this.selectMode) {
      // 移除内联声明，交还给当前工具的 CSS 光标（手形 grab / 默认箭头）
      c.style.removeProperty('cursor')
    }
    // 外部工具（测量/打点）非命中时不触碰光标：工具自身的十字光标继续生效，
    // 退出工具时由 setExternalSnapFeedback(false) 统一清理
  }

  /** 顶点把手图标：白底橙框；点选后红底（Delete 键可批量删除点选顶点） */
  private handleIcon(selected: boolean = false): L.DivIcon {
    const bg = selected ? '#ef4444' : '#fff'
    const border = selected ? '#b91c1c' : '#f59e0b'
    return L.divIcon({
      pane: HANDLE_PANE,
      className: '',
      iconSize: [12, 12],
      iconAnchor: [6, 6],
      html: `<div style="width:10px;height:10px;background:${bg};border:2px solid ${border};border-radius:2px;box-shadow:0 0 2px rgba(0,0,0,0.5);"></div>`,
    })
  }

  /** 边中点把手图标（拉伸=插入新顶点，蓝色小圆点） */
  private midpointIcon(): L.DivIcon {
    return L.divIcon({
      pane: HANDLE_PANE,
      className: '',
      iconSize: [10, 10],
      iconAnchor: [5, 5],
      html: '<div style="width:8px;height:8px;background:#3b82f6;border:1.5px solid #fff;border-radius:50%;box-shadow:0 0 2px rgba(0,0,0,0.5);"></div>',
    })
  }

  /** 整体旋转把手图标（蓝色圆形 ↻） */
  private rotateIcon(): L.DivIcon {
    return L.divIcon({
      pane: HANDLE_PANE,
      className: '',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
      html: '<div style="width:16px;height:16px;border:2px solid #3b82f6;border-radius:50%;background:#fff;box-shadow:0 0 2px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;font-size:10px;color:#3b82f6;font-weight:700;line-height:1;">↻</div>',
    })
  }

  /** 圆/椭圆轴端把手图标（蓝色实心圆点） */
  private ellipseHandleIcon(): L.DivIcon {
    return L.divIcon({
      pane: HANDLE_PANE,
      className: '',
      iconSize: [12, 12],
      iconAnchor: [6, 6],
      html: '<div style="width:9px;height:9px;background:#3b82f6;border:1.5px solid #fff;border-radius:50%;box-shadow:0 0 2px rgba(0,0,0,0.5);"></div>',
    })
  }

  private showHandles(leaf: any) {
    this.clearHandles()
    if (!this.layerId) return
    const editId: string = leaf.feature?.properties?._editId
    if (!editId) return
    const kind = this.featureKind(leaf)
    const icon = this.handleIcon()

    if (kind === 'point') {
      const ll: L.LatLng = leaf.getLatLng()
      const m = L.marker(ll, { icon, draggable: !!this.selectMode, pane: HANDLE_PANE, zIndexOffset: 1000 })
      let origLL: L.LatLng | null = null
      // 拖动过程中最后应用的位置（吸附后的坐标）——dragend 必须提交它而不是
      // 把手当前位置：Leaflet 拖拽在每次 mousemove 都会把把手移回光标处，
      // 覆盖 setLatLng 写入的吸附坐标，导致点要素"吸附不精准"
      let lastPos: L.LatLng | null = null
      m.on('dragstart', () => { origLL = m.getLatLng(); lastPos = null })
      m.on('drag', (e: any) => {
        // 仅"选择"工具激活时可拖动编辑（切出手形/其他工具后元素与节点不可移动）
        if (!this.selectMode || this.isPanToolActive) return
        let p: L.LatLng = e.target.getLatLng()
        // 自动捕获：点要素拖动同样吸附其他图层节点（排除自身原位置）
        if (this.snapEnabled) {
          const hit = this.findSnapNode(p, SNAP_TOLERANCE_DRAG_PX, origLL || undefined)
          if (hit) {
            p = hit.latlng
            this.showSnapMarker(p)
            e.target.setLatLng(p)
          } else {
            this.clearSnapMarker()
          }
        }
        lastPos = p
        leaf.setLatLng(p)
      })
      m.on('dragend', (e: any) => {
        this.clearSnapMarker()
        // 提交最后应用的（吸附后）位置，并把把手校正到位
        const p = lastPos || (e.target.getLatLng() as L.LatLng)
        m.setLatLng(p)
        leaf.setLatLng(p)
        useLayerEditStore.getState().updateFeatureGeometry(this.layerId!, editId, {
          type: leaf.feature.geometry.type || 'Point',
          coordinates: [p.lng, p.lat],
        })
        this.rebuild()
      })
      // 把手与点要素位置重合：首次点击落在图形（把手尚未创建），选中后把手
      // 覆盖上来，第二次点击落在把手——两次 click 分属两元素，两边都收不到
      // dblclick（点图形双击打不开属性弹窗的根因）。
      // 1) 把手 click：与图形首次点击间隔足够短时补判为双击
      m.on('click', (e: any) => {
        L.DomEvent.stopPropagation(e)
        if (this.drawTool !== 'none' || !this.selectMode) return
        if (this.pointClickEditId === editId && Date.now() - this.pointClickAt < DOUBLE_CLICK_MS) {
          this.openPointInspect(editId, leaf)
        }
        this.pointClickAt = 0
        this.pointClickEditId = null
      })
      // 2) 把手 dblclick：要素已选中（把手本就存在）时再双击
      m.on('dblclick', (e: any) => {
        L.DomEvent.stopPropagation(e)
        if (this.drawTool !== 'none' || !this.selectMode) return
        this.openPointInspect(editId, leaf)
      })
      m.addTo(this.handleGroup)
      return
    }

    const isPoly = kind === 'polygon'

    // 圆/椭圆要素：4 个轴端把手（调整半径→可成椭圆）+ 整体旋转把手
    const emeta = isPoly ? this.ellipseMeta(leaf.feature) : null
    if (emeta) {
      this.showEllipseHandles(leaf, editId, emeta)
      return
    }

    const acc = this.ringAccessor(leaf, isPoly)
    // 去闭合点后再生成把手，避免首尾点重叠出现重复把手
    const ring = this.openRing(acc.getRing())

    // 顶点把手：拖拽移动（可吸附捕获节点）+ 左键点选（红显，Delete 键批量删除）+ 右键直接删除
    ring.forEach((v: L.LatLng, i: number) => {
      const m = L.marker(v, { icon: this.handleIcon(this.vertexSel.has(i)), draggable: !!this.selectMode, pane: HANDLE_PANE, zIndexOffset: 1000 })
      let dragged = false
      let origLL: L.LatLng | null = null
      m.on('dragstart', () => {
        origLL = m.getLatLng()
        dragged = false
      })
      m.on('drag', (e: any) => {
        // 仅"选择"工具激活时可拖动编辑（切出手形/其他工具后节点不可移动）
        if (!this.selectMode || this.isPanToolActive) return
        dragged = true
        let ll: L.LatLng = e.target.getLatLng()
        // 自动捕获：拖动过程吸附到其他图层/本图层其他节点（排除被拖顶点自身原位置）
        if (this.snapEnabled) {
          const hit = this.findSnapNode(ll, SNAP_TOLERANCE_DRAG_PX, origLL || undefined)
          if (hit) {
            ll = hit.latlng
            this.showSnapMarker(ll)
            e.target.setLatLng(ll)
          } else {
            this.clearSnapMarker()
          }
        }
        const r = [...acc.getRing()]
        if (r[i]) {
          r[i] = ll
          acc.setRing(r)
        }
      })
      m.on('dragend', () => {
        this.clearSnapMarker()
        useLayerEditStore.getState().updateFeatureGeometry(
          this.layerId!, editId, this.geometryFromLeaf(leaf),
        )
        this.rebuild()
      })
      // 左键点选顶点：再次点击取消；点选后 Delete/Backspace 删除所有点选顶点
      m.on('click', (e: any) => {
        L.DomEvent.stopPropagation(e)
        if (dragged) {
          dragged = false
          return
        }
        if (this.vertexSel.has(i)) this.vertexSel.delete(i)
        else this.vertexSel.add(i)
        m.setIcon(this.handleIcon(this.vertexSel.has(i)))
      })
      m.on('contextmenu', (e: any) => {
        L.DomEvent.stopPropagation(e)
        L.DomEvent.preventDefault(e.originalEvent || e)
        this.deleteVertexAt(leaf, editId, isPoly, i)
      })
      m.addTo(this.handleGroup)
    })

    // 边中点把手（拉伸=插入新顶点）：相邻顶点之间
    for (let i = 0; i < ring.length - 1; i++) {
      this.addMidpointHandle(leaf, editId, isPoly, i + 1, ring[i], ring[i + 1])
    }
    // 面补一条闭合边中点（首点 ↔ 尾点）
    if (isPoly && ring.length >= 3) {
      this.addMidpointHandle(leaf, editId, isPoly, ring.length, ring[ring.length - 1], ring[0])
    }

    // 整体旋转把手（面）：拖动绕形心任意旋转
    if (isPoly && ring.length >= 3) {
      this.addRotateHandle(leaf, editId)
    }
  }

  /** 整体旋转把手：置于形心上方 44px，拖动实时旋转、松开提交。 */
  private addRotateHandle(leaf: any, editId: string) {
    const acc = this.ringAccessor(leaf, true)
    const center = this.ringCentroid(acc.getRing())
    const pt = this.map.latLngToContainerPoint(center)
    const start = this.map.containerPointToLatLng(L.point(pt.x, pt.y - 44))
    const startAngle = Math.atan2(start.lat - center.lat, start.lng - center.lng)
    const orig = this.cloneLatLngs(leaf.getLatLngs())
    const hasMeta = !!this.ellipseMeta(leaf.feature)
    const meta0 = this.ellipseMeta(leaf.feature)

    const m = L.marker(start, { icon: this.rotateIcon(), draggable: !!this.selectMode, pane: HANDLE_PANE, zIndexOffset: 1001 })
    m.on('drag', (e: any) => {
      if (!this.selectMode || this.isPanToolActive) return
      const p = e.target.getLatLng()
      const ang = Math.atan2(p.lat - center.lat, p.lng - center.lng)
      const delta = ang - startAngle
      if (hasMeta && meta0) {
        // 圆/椭圆：按元数据重新生成旋转后的环（保持元数据一致）
        const ring = this.ellipseRing({ ...meta0, rot: meta0.rot + delta }).map((c) => L.latLng(c[1], c[0]))
        leaf.setLatLngs([this.closeLatLngs(ring)])
      } else {
        leaf.setLatLngs(this.rotateLatLngs(orig, center, delta))
      }
    })
    m.on('dragend', (e: any) => {
      const p = e.target.getLatLng()
      const ang = Math.atan2(p.lat - center.lat, p.lng - center.lng)
      const delta = ang - startAngle
      if (hasMeta && meta0) {
        const meta: EllipseMeta = { ...meta0, rot: meta0.rot + delta }
        useLayerEditStore.getState().updateFeatureGeometry(this.layerId!, editId, {
          type: 'Polygon',
          coordinates: [this.closedRing(this.ellipseRing(meta))],
        } as any)
        useLayerEditStore.getState().updateFeatureProperties(this.layerId!, editId, {
          _shape: 'circle',
          _ellipse: meta,
        })
      } else {
        leaf.setLatLngs(this.rotateLatLngs(orig, center, delta))
        useLayerEditStore.getState().updateFeatureGeometry(
          this.layerId!, editId, this.geometryFromLeaf(leaf),
        )
      }
      this.rebuild()
    })
    m.addTo(this.handleGroup)
  }

  /** 圆/椭圆轴端把手：拖动调整 rx/ry（可成椭圆）+ 顶部旋转把手。 */
  private showEllipseHandles(leaf: any, editId: string, meta: EllipseMeta) {
    const apply = (e: EllipseMeta) => {
      const ring = this.ellipseRing(e).map((c) => L.latLng(c[1], c[0]))
      leaf.setLatLngs([this.closeLatLngs(ring)])
    }
    // 4 个轴端把手：局部 +x/-x/+y/-y
    const axes: Array<{ lx: number; ly: number }> = [
      { lx: 1, ly: 0 }, { lx: 0, ly: 1 }, { lx: -1, ly: 0 }, { lx: 0, ly: -1 },
    ]
    axes.forEach(({ lx, ly }) => {
      const cos = Math.cos(meta.rot)
      const sin = Math.sin(meta.rot)
      const wx = meta.cx + lx * meta.rx * cos - ly * meta.ry * sin
      const wy = meta.cy + lx * meta.rx * sin + ly * meta.ry * cos
      const m = L.marker(L.latLng(wy, wx), {
        icon: this.ellipseHandleIcon(), draggable: !!this.selectMode, pane: HANDLE_PANE, zIndexOffset: 1000,
      })
      let isXAxis = lx !== 0
      m.on('dragstart', () => { isXAxis = lx !== 0 })
      m.on('drag', (e: any) => {
        if (!this.selectMode || this.isPanToolActive) return
        const p = e.target.getLatLng()
        const dx = p.lng - meta.cx
        const dy = p.lat - meta.cy
        // 把手位置逆旋转回局部坐标，按所在轴更新对应半径
        const lxx = dx * cos + dy * sin
        const lyy = -dx * sin + dy * cos
        const next: EllipseMeta = {
          ...meta,
          rx: isXAxis ? Math.max(1e-7, Math.abs(lxx)) : meta.rx,
          ry: isXAxis ? meta.ry : Math.max(1e-7, Math.abs(lyy)),
        }
        apply(next)
        ;(m as any).__nextMeta = next
      })
      m.on('dragend', () => {
        const next: EllipseMeta = (m as any).__nextMeta || meta
        useLayerEditStore.getState().updateFeatureGeometry(this.layerId!, editId, {
          type: 'Polygon',
          coordinates: [this.closedRing(this.ellipseRing(next))],
        } as any)
        useLayerEditStore.getState().updateFeatureProperties(this.layerId!, editId, {
          _shape: 'circle',
          _ellipse: next,
        })
        this.rebuild()
      })
      m.addTo(this.handleGroup)
    })
    this.addRotateHandle(leaf, editId)
  }

  /** 边中点把手：拖拽到目标位置后在该边插入新顶点（拉伸）。insertIndex = 新顶点插入位置。 */
  private addMidpointHandle(
    leaf: any,
    editId: string,
    isPoly: boolean,
    insertIndex: number,
    a: L.LatLng,
    b: L.LatLng,
  ) {
    const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2)
    const m = L.marker(mid, { icon: this.midpointIcon(), draggable: !!this.selectMode, pane: HANDLE_PANE, zIndexOffset: 999 })
    const acc = this.ringAccessor(leaf, isPoly)
    m.on('dragend', (e: any) => {
      const p = e.target.getLatLng()
      const ring = this.openRing(acc.getRing())
      const next = [...ring.slice(0, insertIndex), p, ...ring.slice(insertIndex)]
      acc.setRing(next)
      useLayerEditStore.getState().updateFeatureGeometry(
        this.layerId!, editId, this.geometryFromLeaf(leaf),
      )
      this.rebuild()
    })
    m.addTo(this.handleGroup)
  }

  /** 删除选中的单个顶点（右键顶点把手触发）。线至少 2 点、面至少 3 点。 */
  private deleteVertexAt(leaf: any, editId: string, isPoly: boolean, index: number) {
    if (!this.layerId) return
    const acc = this.ringAccessor(leaf, isPoly)
    const ring = this.openRing(acc.getRing())
    const min = isPoly ? 3 : 2
    if (ring.length <= min) return
    const next = [...ring]
    next.splice(index, 1)
    // 删除后顶点下标整体前移，点选集合作废
    this.vertexSel.clear()
    acc.setRing(next)
    useLayerEditStore.getState().updateFeatureGeometry(
      this.layerId, editId, this.geometryFromLeaf(leaf),
    )
    this.rebuild()
  }

  /** 删除当前点选的所有顶点（Delete/Backspace 键，红显把手）。 */
  private deleteSelectedVertices() {
    if (!this.layerId || !this.selectedEditId || this.vertexSel.size === 0) return
    const leaf: any = this.findLeafLayer(this.selectedEditId)
    if (!leaf) return
    const kind = this.featureKind(leaf)
    // 圆/椭圆无自由顶点（由轴端把手控制），忽略点选集
    if (kind === 'point' || this.ellipseMeta(leaf.feature)) {
      this.vertexSel.clear()
      return
    }
    const isPoly = kind === 'polygon'
    const acc = this.ringAccessor(leaf, isPoly)
    const ring = this.openRing(acc.getRing())
    const min = isPoly ? 3 : 2
    const idxs = [...this.vertexSel].filter((i) => i >= 0 && i < ring.length).sort((a, b) => b - a)
    if (idxs.length === 0 || ring.length - idxs.length < min) return
    for (const i of idxs) ring.splice(i, 1)
    this.vertexSel.clear()
    acc.setRing(ring)
    useLayerEditStore.getState().updateFeatureGeometry(
      this.layerId, this.selectedEditId, this.geometryFromLeaf(leaf),
    )
    this.rebuild()
  }

  /** 删除当前选中要素（Delete 键）。 */
  deleteSelected() {
    if (!this.layerId || this.drawTool !== 'none' || !this.selectedEditId) return
    useLayerEditStore.getState().deleteFeature(this.layerId, this.selectedEditId)
    this.deselect()
    this.rebuild()
  }

  // ---------- 编辑态圈选（复制/剪贴板/批量删除） ----------

  /** 最近一次圈选命中的要素 editId 集合（Delete/Backspace 批量删除用） */
  private shapeSelectedIds: Set<string> = new Set()

  /**
   * 圈选：返回工作集要素中与给定形状相交的要素（几何 + 完整属性），并在编辑层上高亮。
   * 供"编辑模式下圈选图形元素并复制到剪切板"使用（形状为 L.Circle / L.Rectangle / L.Polygon）。
   * @param append true 时与已有圈选结果取并集（边界选择 MultiPolygon 逐外环收集时使用）
   * @param byAnchor true 时仅按要素锚点（归属经纬度）判定（边界选择口径，
   *                 保证相邻边界不会重复选中同一要素）；false 为任一顶点口径（普通圈选）
   */
  selectInShape(shape: L.Layer, append: boolean = false, byAnchor: boolean = false): CopiedFeature[] {
    if (!this.layerId) return []
    const ws = useLayerEditStore.getState().getWorkspace(this.layerId)
    if (!ws) return []
    const pointTest = this.shapePointTester(shape)
    const newHits = (ws.features as any[]).filter((f: any) => {
      if (byAnchor) {
        const anchor = geometryAnchor(f.geometry)
        return anchor ? pointTest(L.latLng(anchor.lat, anchor.lng)) : false
      }
      return this.featureVertices(f).some((p) => pointTest(p))
    })
    let hits: any[]
    if (append) {
      // 与已有命中按 _editId 去重合并，高亮整体重画
      const seen = new Set(this.shapeSelectedIds)
      hits = (ws.features as any[]).filter(
        (f: any) => seen.has(f.properties?._editId),
      )
      for (const f of newHits) {
        const id = f.properties?._editId
        if (id && seen.has(id)) continue
        if (id) seen.add(id)
        hits.push(f)
      }
    } else {
      hits = newHits
    }
    this.shapeSelectedIds = new Set(
      hits.map((f: any) => f.properties?._editId).filter((id: any): id is string => !!id),
    )
    this.showShapeSelectionHighlight(hits)
    return hits.map((f: any) => ({ geometry: f.geometry, properties: f.properties || {} }))
  }

  /**
   * 批量删除圈选选中的要素（Delete/Backspace 触发）。返回删除数量。
   * 走 store.deleteFeatures 一次写入：只拍一份历史快照、订阅侧只 rebuild 一次，
   * 避免逐个删除（N 次深拷贝 + N 次全图层重建）在大批量选中时卡死页面。
   */
  deleteShapeSelected(): number {
    if (!this.layerId || this.shapeSelectedIds.size === 0) return 0
    const store = useLayerEditStore.getState()
    const ids = Array.from(this.shapeSelectedIds)
    const n = store.deleteFeatures(this.layerId, ids)
    this.shapeSelectedIds.clear()
    this.clearShapeSelection()
    // 单选要素若在被删集合内则一并取消选中
    if (this.selectedEditId && ids.includes(this.selectedEditId)) this.deselect()
    // store 写入已经订阅触发一次 setWorkspace→rebuild；此处再 rebuild 一次保证
    // deselect 后的选中样式/把手清除（O(M)，两次全量重建对大批量仍可接受）
    this.rebuild()
    return n
  }

  /** 清除圈选选中（选中集合 + 高亮图层）。供 Esc / 清除按钮 / 删除后调用。 */
  clearShapeSelection() {
    this.shapeSelectedIds.clear()
    this.clearShapeSelectLayer()
  }

  /** 仅移除圈选高亮图层（保留选中集合）——showShapeSelectionHighlight 重画前用。 */
  private clearShapeSelectLayer() {
    if (this.shapeSelectLayer) {
      this.map.removeLayer(this.shapeSelectLayer)
      this.shapeSelectLayer = null
    }
  }

  private showShapeSelectionHighlight(features: any[]) {
    // 只清旧高亮图层，不清 shapeSelectedIds ——
    // 否则 selectInShape 里"先记集合、后画高亮"的顺序会把集合清空，
    // 导致圈选后"删除"按钮/键盘 Delete 拿到空集合而删不掉要素。
    this.clearShapeSelectLayer()
    if (!features.length) return
    this.shapeSelectLayer = L.geoJSON({ type: 'FeatureCollection', features } as any, {
      pane: EDIT_PANE,
      interactive: false,
      style: { color: SELECT_COLOR, weight: 3, dashArray: '6,3', fillColor: SELECT_COLOR, fillOpacity: 0.1 } as any,
      pointToLayer: (_f, latlng) =>
        L.circleMarker(latlng, {
          pane: EDIT_PANE,
          interactive: false,
          radius: 9,
          color: SELECT_COLOR,
          weight: 3,
          fillColor: SELECT_COLOR,
          fillOpacity: 0.2,
        }),
    }).addTo(this.map)
  }

  /**
   * 形状对单个点的命中测试（圆=距离；多边形=包围盒粗筛 + 射线法）。
   * 顶点口径（普通圈选）与锚点口径（边界选择）共用此单点测试。
   */
  private shapePointTester(shape: L.Layer): (p: L.LatLng) => boolean {
    const anyShape = shape as any
    if (typeof anyShape.getRadius === 'function' && typeof anyShape.getLatLng === 'function') {
      const c = anyShape.getLatLng() as L.LatLng
      const r = anyShape.getRadius() as number
      return (p: L.LatLng) => c.distanceTo(p) <= r
    }
    const ring: L.LatLng[] = (anyShape.getLatLngs?.() || [])[0] || []
    const bounds: L.LatLngBounds | undefined = typeof anyShape.getBounds === 'function'
      ? anyShape.getBounds()
      : undefined
    if (!ring.length || !bounds) return () => false
    return (p: L.LatLng) => {
      if (!bounds.contains(p)) return false
      let inside = false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i].lng
        const yi = ring[i].lat
        const xj = ring[j].lng
        const yj = ring[j].lat
        const intersect = ((yi > p.lat) !== (yj > p.lat)) &&
          (p.lng < (xj - xi) * (p.lat - yi) / (yj - yi) + xi)
        if (intersect) inside = !inside
      }
      return inside
    }
  }

  /** 要素几何的所有顶点（支持 Point/LineString/Polygon 及 Multi*，坐标按 [lng, lat] 遍历） */
  private featureVertices(f: any): L.LatLng[] {
    const out: L.LatLng[] = []
    const walk = (c: any, depth: number) => {
      if (!Array.isArray(c) || depth > 3) return
      if (typeof c[0] === 'number' && typeof c[1] === 'number') {
        out.push(L.latLng(c[1], c[0]))
        return
      }
      for (const item of c) walk(item, depth + 1)
    }
    walk(f?.geometry?.coordinates, 0)
    return out
  }

  // ---------- 圆/椭圆 ----------

  /** 要素的圆/椭圆元数据；旧数据（多顶点近圆面）启发式识别为圆。 */
  private ellipseMeta(feature: any): EllipseMeta | null {
    const e = feature?.properties?._ellipse
    if (e && typeof e.cx === 'number' && typeof e.cy === 'number'
      && typeof e.rx === 'number' && typeof e.ry === 'number') {
      return { cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry, rot: e.rot || 0 }
    }
    if (feature?.geometry?.type === 'Polygon') {
      const ring = feature.geometry.coordinates?.[0] as Array<[number, number]> | undefined
      if (ring && ring.length >= 24) {
        let sx = 0
        let sy = 0
        for (const c of ring) {
          sx += c[0]
          sy += c[1]
        }
        const cx = sx / ring.length
        const cy = sy / ring.length
        let minX = Infinity
        let maxX = -Infinity
        let minY = Infinity
        let maxY = -Infinity
        let dMin = Infinity
        let dMax = 0
        for (const [x, y] of ring) {
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
          minY = Math.min(minY, y)
          maxY = Math.max(maxY, y)
          const d = Math.hypot(x - cx, y - cy)
          dMin = Math.min(dMin, d)
          dMax = Math.max(dMax, d)
        }
        // 各顶点到形心距离近似相等 → 视为圆
        if (dMax > 0 && dMin / dMax > 0.9) {
          return { cx, cy, rx: (maxX - minX) / 2, ry: (maxY - minY) / 2, rot: 0 }
        }
      }
    }
    return null
  }

  /** 椭圆参数 → 环（度坐标空间；rot 为绕中心旋转）。 */
  private ellipseRing(e: EllipseMeta, n = 48): Array<[number, number]> {
    const cos = Math.cos(e.rot)
    const sin = Math.sin(e.rot)
    const ring: Array<[number, number]> = []
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2
      const lx = e.rx * Math.cos(t)
      const ly = e.ry * Math.sin(t)
      ring.push([e.cx + lx * cos - ly * sin, e.cy + lx * sin + ly * cos])
    }
    return ring
  }

  /** 圆心 + 半径（米）→ 椭圆元数据（rx/ry 按度换算，屏幕上呈圆形）。 */
  private circleMeta(center: L.LatLng, radiusMeters: number): EllipseMeta {
    const dLat = radiusMeters / 111320
    const dLng = radiusMeters / (111320 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)))
    return { cx: center.lng, cy: center.lat, rx: dLng, ry: dLat, rot: 0 }
  }

  // ---------- 要素整体拖动（编辑态按住左键移位） ----------

  private beginFeatureDrag(leaf: any, startLL: L.LatLng, startPt?: L.Point) {
    const kind = this.featureKind(leaf)
    const orig = kind === 'point' ? leaf.getLatLng() : leaf.getLatLngs()
    this.featureDrag = {
      leaf,
      startLL,
      startPt: startPt || this.map.latLngToContainerPoint(startLL),
      orig: this.cloneLatLngs(orig),
      moved: false,
    }
    this.map.on('mousemove', this.boundFeatureDragMove)
    this.map.on('mouseup', this.boundFeatureDragUp)
    // 兜底：鼠标在地图外松开时 Leaflet 不派发 mouseup，用 document 监听结束拖动
    document.addEventListener('mouseup', this.boundFeatureDragUp, { once: true })
    this.map.getContainer().style.cursor = 'grabbing'
  }

  private handleFeatureDragMove(e: L.LeafletMouseEvent) {
    const st = this.featureDrag
    if (!st) return
    // 防抖：位移未超过阈值视为点击（选中），不移动图形，避免手抖误触拖动
    if (!st.moved) {
      const pt = (e as any).containerPoint || this.map.latLngToContainerPoint(e.latlng)
      if (pt.distanceTo(st.startPt) < FEATURE_DRAG_THRESHOLD_PX) return
      st.moved = true
    }
    const dLat = e.latlng.lat - st.startLL.lat
    const dLng = e.latlng.lng - st.startLL.lng
    if (Math.abs(dLat) < 1e-12 && Math.abs(dLng) < 1e-12) return
    const moved = this.translateLatLngs(st.orig, dLat, dLng)
    if (this.featureKind(st.leaf) === 'point') st.leaf.setLatLng(moved)
    else st.leaf.setLatLngs(moved)
  }

  private handleFeatureDragUp() {
    const st = this.featureDrag
    this.map.off('mousemove', this.boundFeatureDragMove)
    this.map.off('mouseup', this.boundFeatureDragUp)
    document.removeEventListener('mouseup', this.boundFeatureDragUp)
    this.featureDrag = null
    if (this.map.getContainer()) {
      this.map.getContainer().style.cursor = this.drawTool !== 'none' ? 'crosshair' : ''
    }
    if (!st || !st.moved || !this.layerId) return
    const editId = st.leaf?.feature?.properties?._editId
    if (!editId) return
    useLayerEditStore.getState().updateFeatureGeometry(
      this.layerId, editId, this.geometryFromLeaf(st.leaf),
    )
    this.rebuild()
  }

  // ---------- 绘制 ----------

  /**
   * 新建要素落点时把当前绘制样式快照写入属性（_editStyle）：
   * 保存到 TAB（后端 NPT_FEATSYM 列）后刷新/重新加载仍按原样式渲染，
   * 否则新要素仅靠 _isNew 动态取 drawStyleMap，样式在刷新后丢失（方形点变圆的根因）。
   */
  private drawStyleProps(kind: GeomKind): Record<string, any> {
    const st = useMapStore.getState().mapSettings.drawStyleMap?.[kind]
    return st ? { _editStyle: JSON.parse(JSON.stringify(st)) } : {}
  }

  /** 线绘制预设是否为"曲线"（平滑曲线贯穿各顶点）。 */
  private lineCurveEnabled(): boolean {
    const st: any = useMapStore.getState().mapSettings.drawStyleMap?.line
    return st?.shape === 'curve'
  }

  /** Catmull-Rom 样条加密：返回贯穿 pts 各顶点的平滑曲线采样点（保留原顶点位置）。 */
  private curveLatLngs(pts: L.LatLng[]): L.LatLng[] {
    if (pts.length < 3) return pts
    const STEPS = 12
    const P = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))]
    const out: L.LatLng[] = []
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = P(i - 1)
      const p1 = P(i)
      const p2 = P(i + 1)
      const p3 = P(i + 2)
      for (let j = 0; j < STEPS; j++) {
        const t = j / STEPS
        const t2 = t * t
        const t3 = t2 * t
        const lat = 0.5 * (2 * p1.lat + (-p0.lat + p2.lat) * t
          + (2 * p0.lat - 5 * p1.lat + 4 * p2.lat - p3.lat) * t2
          + (-p0.lat + 3 * p1.lat - 3 * p2.lat + p3.lat) * t3)
        const lng = 0.5 * (2 * p1.lng + (-p0.lng + p2.lng) * t
          + (2 * p0.lng - 5 * p1.lng + 4 * p2.lng - p3.lng) * t2
          + (-p0.lng + 3 * p1.lng - 3 * p2.lng + p3.lng) * t3)
        out.push(L.latLng(lat, lng))
      }
    }
    out.push(pts[pts.length - 1])
    return out
  }

  startDraw(tool: DrawTool) {
    if (!this.layerId) return
    if (tool === this.drawTool) {
      this.stopDraw()
      return
    }
    this.stopDraw()
    if (tool === 'none') return
    this.drawTool = tool
    this.deselect()
    this.drawPoints = []
    this.map.getContainer().style.cursor = 'crosshair'
  }

  stopDraw() {
    this.drawTool = 'none'
    this.clearTemp()
    if (this.map.getContainer()) this.map.getContainer().style.cursor = ''
  }

  /** 工具栏"选择"工具开关：与绘制互斥，激活时退出绘制。
   *  关闭时取消选中并清除把手 —— 切出"选择"工具后要素/节点不可再移动、编辑。 */
  setSelectMode(on: boolean) {
    this.selectMode = on
    if (on) {
      this.stopDraw()
      return
    }
    this.deselect()
    this.clearSnapMarker()
    this.updateSnapCursor(false)
  }

  /** 清除绘制临时图形（不改变 drawTool，用于一次图形完成后的复位）。 */
  private clearTemp() {
    this.drawPoints = []
    if (this.tempLayer) {
      this.map.removeLayer(this.tempLayer)
      this.tempLayer = null
    }
    this.tempVertexMarkers.forEach((m) => this.map.removeLayer(m))
    this.tempVertexMarkers = []
  }

  private handleMapClick(e: L.LeafletMouseEvent) {
    if (!this.layerId) return
    // 节点合并：先消费拖框手势的尾随 click（C1），不做任何取消动作
    if (this.mergeSuppressNextClick) {
      this.mergeSuppressNextClick = false
      return
    }
    // 节点合并：候选要素的 click 已 stopPropagation；落到地图空白 = 取消候选等待
    if (this.nodeMergeMode) {
      if (this.mergePendingCandidates) this.cancelMergePending()
      return
    }
    if (this.drawTool === 'none') {
      // 点击空白处（要素 click 已 stopPropagation）→ 取消选中。
      // 拖动（位移超阈值）不算点击：空白处拖动不清空已有选中（"只有点击才改变选中"）
      if (this.isDragGesture(e)) return
      if (this.selectedEditId) this.deselect()
      return
    }
    // 自动捕获：落点吸附到附近节点（节点不可见也可捕获）
    const ll = this.applySnap(e.latlng)
    if (this.drawTool === 'point') {
      useLayerEditStore.getState().addFeature(this.layerId, {
        type: 'Point',
        coordinates: [ll.lng, ll.lat],
      }, this.drawStyleProps('point'))
      // 保持点工具激活，可连续绘制多个点（与线/面一致；Esc/再点"绘制点"按钮退出）
      this.rebuild()
    } else {
      this.addVertex(ll)
      // 面预设自动收尾：三角形 3 点闭合；圆/方 2 点成图
      if (this.drawTool === 'polygon') {
        const preset = this.polygonPreset()
        if (preset === 'triangle' && this.drawPoints.length >= 3) this.finishDraw()
        else if (preset && preset !== 'triangle' && this.drawPoints.length >= 2) this.finishDraw()
      }
    }
  }

  /** 当前面绘制预设形状（'polygon'/未设置表示逐点绘制）。 */
  private polygonPreset(): 'circle' | 'square' | 'triangle' | null {
    const st = useMapStore.getState().mapSettings.drawStyleMap?.polygon as any
    const s = st?.shape
    return s === 'circle' || s === 'square' || s === 'triangle' ? s : null
  }

  /** 方形：两点为对角线、四内角为直角 → 环 = [p1, m+rot90(v), p2, m-rot90(v)]。 */
  private diagonalSquareRing(p1: L.LatLng, p2: L.LatLng): Array<[number, number]> {
    const mx = (p1.lng + p2.lng) / 2
    const my = (p1.lat + p2.lat) / 2
    const vx = (p2.lng - p1.lng) / 2
    const vy = (p2.lat - p1.lat) / 2
    return [
      [p1.lng, p1.lat],
      [mx - vy, my + vx],
      [p2.lng, p2.lat],
      [mx + vy, my - vx],
    ]
  }

  private addVertex(ll: L.LatLng) {
    this.drawPoints.push(ll)
    const marker = L.circleMarker(ll, {
      pane: EDIT_PANE,
      radius: 3,
      color: '#fff',
      weight: 1.5,
      fillColor: SELECT_COLOR,
      fillOpacity: 1,
      interactive: false,
    })
    marker.addTo(this.map)
    this.tempVertexMarkers.push(marker)
    this.renderTemp()
  }

  private renderTemp(mouseLL?: L.LatLng) {
    if (this.tempLayer) {
      this.map.removeLayer(this.tempLayer)
      this.tempLayer = null
    }
    if (this.drawPoints.length === 0) return
    const opts: L.PathOptions = {
      pane: EDIT_PANE,
      color: SELECT_COLOR,
      weight: 2,
      dashArray: '5,5',
      fill: false,
      interactive: false,
    }
    let pts = mouseLL ? [...this.drawPoints, mouseLL] : [...this.drawPoints]
    if (this.drawTool === 'line' && this.lineCurveEnabled() && pts.length >= 2) {
      // 曲线预设实时预览：平滑曲线贯穿已落点 + 鼠标位置
      pts = this.curveLatLngs(pts)
    }
    if (this.drawTool === 'polygon') {
      const preset = this.polygonPreset()
      if (preset && this.drawPoints.length >= 1 && mouseLL) {
        // 规则图形实时虚线预览：
        // 圆 = 首点为圆心、鼠标距离为半径；方 = 两点对角线；三角 = 已落点 + 鼠标闭环
        if (preset === 'circle' && this.drawPoints.length >= 1) {
          const meta = this.circleMeta(this.drawPoints[0], this.drawPoints[0].distanceTo(mouseLL))
          pts = this.ellipseRing(meta).map((c) => L.latLng(c[1], c[0]))
        } else if (preset === 'square' && this.drawPoints.length === 1) {
          pts = this.diagonalSquareRing(this.drawPoints[0], mouseLL).map((c) => L.latLng(c[1], c[0]))
        }
      } else if (preset && preset !== 'triangle' && this.drawPoints.length >= 2) {
        const p2 = this.drawPoints[1]
        if (preset === 'circle') {
          const meta = this.circleMeta(this.drawPoints[0], this.drawPoints[0].distanceTo(p2))
          pts = this.ellipseRing(meta).map((c) => L.latLng(c[1], c[0]))
        } else {
          pts = this.diagonalSquareRing(this.drawPoints[0], p2).map((c) => L.latLng(c[1], c[0]))
        }
      }
    }
    if (this.drawTool === 'polygon') {
      this.tempLayer = L.polygon(pts, { ...opts, fillOpacity: 0.08, fill: true } as any)
    } else {
      this.tempLayer = L.polyline(pts, opts)
    }
    this.tempLayer.addTo(this.map)
  }

  private handleMouseMove(e: L.LeafletMouseEvent) {
    // 节点合并模式：左键拖框更新矩形预览（高亮经 rAF 节流重建）；
    // 未拖框时也直接返回，避免节点捕获的光标/标记干扰
    if (this.nodeMergeMode) {
      // 按键已松开（如容器外松开后回到地图）：复位拖框，不更新矩形
      if (this.mergeDrag && (e.originalEvent as MouseEvent).buttons === 0) {
        this.mergeDrag = null
        if (this.mergeRaf) { cancelAnimationFrame(this.mergeRaf); this.mergeRaf = 0 }
        return
      }
      if (this.mergeDrag) {
        const px = this.map.mouseEventToContainerPoint(e.originalEvent)
        if (!this.mergeDrag.moved && px.distanceTo(this.mergeDrag.startPx) >= MERGE_MIN_DRAG_PX) {
          this.mergeDrag.moved = true
        }
        if (this.mergeDrag.moved) this.updateMergeRect(L.latLngBounds(this.mergeDrag.startLL, e.latlng))
      }
      return
    }
    // 自动捕获：靠近节点光标变十字 + 显示捕获标记。
    // "选择"工具，或测量/打点等外部工具激活时生效（手形/其他工具下不显示捕获反馈）
    if (this.drawTool === 'none') {
      if (this.snapEnabled && (this.selectMode || this.externalSnapFeedback)) {
        const hit = this.findSnapNode(e.latlng)
        if (hit) {
          this.showSnapMarker(hit.latlng)
          this.updateSnapCursor(true)
        } else {
          this.clearSnapMarker()
          this.updateSnapCursor(false)
        }
      }
      return
    }
    if (this.drawTool === 'point') {
      // 点工具无预览图形，但同样显示捕获标记（落点已在 handleMapClick 吸附）
      if (this.snapEnabled) {
        const hit = this.findSnapNode(e.latlng)
        if (hit) this.showSnapMarker(hit.latlng)
        else this.clearSnapMarker()
      }
      return
    }
    // 绘制中：吸附后用节点坐标实时预览
    if (this.snapEnabled) {
      const hit = this.findSnapNode(e.latlng)
      if (hit) {
        this.showSnapMarker(hit.latlng)
        this.renderTemp(hit.latlng)
        return
      }
      this.clearSnapMarker()
    }
    if (this.drawPoints.length === 0) return
    this.renderTemp(e.latlng)
  }

  private handleDblClick(e: L.LeafletMouseEvent) {
    if (this.drawTool === 'none' || this.drawTool === 'point') return
    L.DomEvent.stopPropagation(e)
    // 双击的第二次 click 会多加一个顶点，去掉
    if (this.drawPoints.length) this.drawPoints.pop()
    this.finishDraw()
  }

  private handleContextMenu(e: L.LeafletMouseEvent) {
    if (this.drawTool === 'none' || this.drawTool === 'point') return
    L.DomEvent.preventDefault(e.originalEvent || e)
    this.finishDraw()
  }

  private finishDraw() {
    const pts = [...this.drawPoints]
    const tool = this.drawTool
    this.clearTemp()
    if (!this.layerId) return
    let committed = false
    if (tool === 'line' && pts.length >= 2) {
      // "曲线"预设：Catmull-Rom 平滑曲线贯穿各顶点（几何直接加密，编辑/保存/刷新形态不变）
      const finalPts = this.lineCurveEnabled() ? this.curveLatLngs(pts) : pts
      useLayerEditStore.getState().addFeature(this.layerId, {
        type: 'LineString',
        coordinates: finalPts.map((p) => [p.lng, p.lat]),
      }, this.drawStyleProps('line'))
      committed = true
    } else if (tool === 'polygon') {
      const preset = this.polygonPreset()
      if (preset === 'circle' && pts.length >= 2) {
        // 圆：第一点为圆心，两点距离为半径
        const meta = this.circleMeta(pts[0], pts[0].distanceTo(pts[1]))
        useLayerEditStore.getState().addFeature(this.layerId, {
          type: 'Polygon',
          coordinates: [this.closedRing(this.ellipseRing(meta))],
        }, { ...this.drawStyleProps('polygon'), _shape: 'circle', _ellipse: meta })
        committed = true
      } else if (preset === 'square' && pts.length >= 2) {
        // 方形：两点为对角线，四内角为直角
        useLayerEditStore.getState().addFeature(this.layerId, {
          type: 'Polygon',
          coordinates: [this.closedRing(this.diagonalSquareRing(pts[0], pts[1]))],
        }, this.drawStyleProps('polygon'))
        committed = true
      } else if (pts.length >= 3) {
        // 三角形（3 点）或普通多边形（≥3 点）：依次连线闭合
        const ring = pts.map((p) => [p.lng, p.lat] as [number, number])
        useLayerEditStore.getState().addFeature(this.layerId, {
          type: 'Polygon',
          coordinates: [this.closedRing(ring)],
        }, this.drawStyleProps('polygon'))
        committed = true
      }
    }
    if (committed) {
      this.rebuild()
      // 保持线/面绘制工具激活，可连续绘制（Esc/再点按钮退出）
      this.drawTool = tool
      this.drawPoints = []
      this.map.getContainer().style.cursor = 'crosshair'
    } else {
      this.drawTool = 'none'
      this.map.getContainer().style.cursor = ''
      useLayerEditStore.getState().setDrawTool('none')
    }
  }

  /** 键盘：Esc 取消绘制（含点工具）/ Backspace 删末点 / Delete 删选中 / S 切换自动捕获节点。返回是否处理。 */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.layerId) return false
    // S 键：切换自动捕获节点（仅编辑态、无组合键、非输入框聚焦）。
    // 状态以 layerEditStore 为单一真相源（工具栏按钮共用），OnlineMap 监听后同步回会话。
    if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return false
      useLayerEditStore.getState().toggleSnapEnabled()
      return true
    }
    // Esc：节点合并中取消候选等待/框选预览（不退出模式）。
    // 没有可取消的东西时放行，避免屏蔽其他 UI 的 Esc（弹窗/下拉等）。
    if (e.key === 'Escape' && this.nodeMergeMode) {
      if (this.mergePendingCandidates) { this.cancelMergePending(); return true }
      if (this.mergeRect) { this.clearMergeOverlay(); return true }
      return false
    }
    if (this.drawTool !== 'none') {
      if (e.key === 'Escape') {
        this.stopDraw()
        useLayerEditStore.getState().setDrawTool('none')
        return true
      }
      if (e.key === 'Backspace' && this.drawTool !== 'point') {
        this.drawPoints.pop()
        this.renderTemp()
        const m = this.tempVertexMarkers.pop()
        if (m) this.map.removeLayer(m)
        return true
      }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.drawTool === 'none') {
      // 圈选批量删除优先：编辑态圈选命中的要素可整体删除
      if (this.shapeSelectedIds.size > 0) {
        this.deleteShapeSelected()
        return true
      }
      if (this.selectedEditId) {
        // 有点选顶点时优先删除顶点，否则删除整个选中要素
        if (this.vertexSel.size > 0) {
          this.deleteSelectedVertices()
          return true
        }
        this.deleteSelected()
        return true
      }
    }
    return false
  }

  // ==================== 节点合并实现 ====================

  private handleMergeMouseDown(e: L.LeafletMouseEvent) {
    if (!this.nodeMergeMode || !this.layerId) return
    if (e.originalEvent.button !== 0) return
    // 候选点选阶段：拖框停用，点击交与候选 click（选中）/ map click（空白取消）
    if (this.mergePendingCandidates) return
    this.mergeDrag = {
      startPx: this.map.mouseEventToContainerPoint(e.originalEvent),
      startLL: e.latlng,
      moved: false,
    }
    // 容器外松开时 map 不派发 mouseup：document 兜底复位，避免零按键移动继续拖矩形
    document.addEventListener('mouseup', this.boundMergeDocMouseUp, { once: true })
  }

  private handleMergeMouseUp(e: L.LeafletMouseEvent) {
    if (!this.nodeMergeMode || !this.mergeDrag) return
    const drag = this.mergeDrag
    this.mergeDrag = null
    if (this.mergeRaf) { cancelAnimationFrame(this.mergeRaf); this.mergeRaf = 0 }
    const endPx = this.map.mouseEventToContainerPoint(e.originalEvent)
    // 位移过小视为点击：丢弃本次框选（不吞尾随 click，留给候选取消等语义）
    if (!drag.moved || endPx.distanceTo(drag.startPx) < MERGE_MIN_DRAG_PX) {
      this.clearMergeOverlay()
      return
    }
    // 真实拖框：浏览器在 mouseup 后还会派发一个 click（dragging/boxZoom 已禁用，
    // Leaflet 不抑制），吞掉它，避免多候选提示/候选层被"空白取消"立刻清掉。
    this.mergeSuppressNextClick = true
    window.setTimeout(() => { this.mergeSuppressNextClick = false }, 0)
    this.finalizeMerge(L.latLngBounds(drag.startLL, e.latlng))
  }

  /** 拖拽中：更新虚线矩形，框内双色高亮经 rAF 节流重建 */
  private updateMergeRect(bounds: L.LatLngBounds) {
    if (!this.mergeRect) {
      this.mergeRect = L.rectangle(bounds, {
        color: MERGE_EDIT_COLOR,
        weight: 1.5,
        dashArray: '4,3',
        fill: false,
        interactive: false,
        pane: HANDLE_PANE,
      }).addTo(this.map)
    } else {
      this.mergeRect.setBounds(bounds)
    }
    this.mergeLastBounds = bounds
    if (!this.mergeRaf) {
      this.mergeRaf = requestAnimationFrame(() => {
        this.mergeRaf = 0
        if (this.mergeLastBounds) this.renderMergePreview(this.mergeLastBounds)
      })
    }
  }

  private ensureMergeGroups() {
    if (!this.mergeEditableGroup) {
      this.mergeEditableGroup = L.layerGroup().addTo(this.map)
      this.mergeRefGroup = L.layerGroup().addTo(this.map)
    }
  }

  /** 清除矩形/双色高亮/候选等待（保留模式开关与十字光标） */
  private clearMergeOverlay() {
    if (this.mergeRect) { this.map.removeLayer(this.mergeRect); this.mergeRect = null }
    this.mergeEditableGroup?.clearLayers()
    this.mergeRefGroup?.clearLayers()
    this.mergeEditableHits = []
    this.mergePendingCandidates = null
    this.mergeLastBounds = null
    this.clearMapHint()
  }

  private cancelMergePending() {
    this.clearMergeOverlay()
    this.showMapHint(i18n.t('map.mergeCanceled') || '已取消选择参考图形')
  }

  /** GeoJSON 几何 → 可参与合并的外环/线环（点要素、洞、圆/椭圆由调用方过滤） */
  private enumGeomRings(geometry: any): Array<{
    coords: Array<[number, number]>; closed: boolean; partIndex: number; geomType: string
  }> {
    if (!geometry) return []
    const t = geometry.type
    const c = geometry.coordinates
    if (t === 'LineString') {
      return Array.isArray(c) ? [{ coords: c, closed: false, partIndex: 0, geomType: t }] : []
    }
    if (t === 'MultiLineString') {
      return Array.isArray(c) ? c.map((line: any, i: number) => ({ coords: line, closed: false, partIndex: i, geomType: t })) : []
    }
    if (t === 'Polygon') {
      return Array.isArray(c?.[0]) ? [{ coords: c[0], closed: true, partIndex: 0, geomType: t }] : []
    }
    if (t === 'MultiPolygon') {
      return Array.isArray(c) ? c.map((poly: any, i: number) => ({ coords: poly[0], closed: true, partIndex: i, geomType: t })) : []
    }
    return []
  }

  private coordsToRing(coords: Array<[number, number]>): L.LatLng[] {
    return this.openRing(coords.map((c) => L.latLng(c[1], c[0])))
  }

  /** 要素包围盒与框选矩形粗筛（不相交直接跳过，大图层下避免逐边求交） */
  private leafIntersectsRect(leaf: any, bounds: L.LatLngBounds): boolean {
    const b = typeof leaf.getBounds === 'function' ? leaf.getBounds() : null
    return b ? b.intersects(bounds) : true
  }

  /** 单段边框的框内段折线（纯算法实现，非 single 返回 null） */
  private segOf(ring: L.LatLng[], closed: boolean, rect: MMRect): L.LatLng[] | null {
    const pts = insideSegmentPoints(ring as MMPoint[], closed, rect)
    return pts ? pts.map((p) => L.latLng(p.lat, p.lng)) : null
  }

  private isCircleFeature(f: any): boolean {
    return !!f?.properties?._ellipse || f?.properties?._shape === 'circle'
  }

  /** LineString 原始坐标首尾重合（用线表达闭合环）标记 */
  private lineOriginallyClosed(coords: Array<[number, number]>): boolean {
    return coords.length > 1 && coords[0][0] === coords[coords.length - 1][0]
      && coords[0][1] === coords[coords.length - 1][1]
  }

  /** 收集框内"单段进出"的可编辑边框 */
  private collectEditableHits(rect: MMRect): { hits: MergeEditableHit[]; circles: number } {
    const hits: MergeEditableHit[] = []
    let circles = 0
    const bounds = L.latLngBounds([rect.south, rect.west], [rect.north, rect.east])
    this.editLayer?.eachLayer((leaf: any) => {
      const f = leaf?.feature
      const editId = f?.properties?._editId as string | undefined
      if (!editId) return
      if (this.isCircleFeature(f)) { circles++; return }
      if (!this.leafIntersectsRect(leaf, bounds)) return
      for (const r of this.enumGeomRings(f.geometry)) {
        const ring = this.coordsToRing(r.coords)
        const a = analyzeRingInRect(ring as MMPoint[], r.closed, rect)
        if (a.status !== 'single') continue
        const seg = this.segOf(ring, r.closed, rect)
        if (!seg) continue
        hits.push({
          editId, leaf, geomType: r.geomType, partIndex: r.partIndex,
          ring, closed: r.closed, seg,
          lineClosed: r.geomType === 'LineString' && this.lineOriginallyClosed(r.coords),
        })
      }
    })
    return { hits, circles }
  }

  /** 收集框内"单段进出"的不可编辑参考边框（跨所有可见非编辑图层） */
  private collectRefHits(rect: MMRect): MergeRefHit[] {
    const out: MergeRefHit[] = []
    const sources = this.referenceSourceProvider?.() ?? []
    const bounds = L.latLngBounds([rect.south, rect.west], [rect.north, rect.east])
    for (const src of sources) {
      (src.layer as any).eachLayer?.((leaf: any) => {
        const f = leaf?.feature
        if (!f || this.isCircleFeature(f)) return
        if (!this.leafIntersectsRect(leaf, bounds)) return
        const key = `${src.id}#${leaf._leaflet_id ?? Math.random().toString(36).slice(2)}`
        for (const r of this.enumGeomRings(f.geometry)) {
          const ring = this.coordsToRing(r.coords)
          const a = analyzeRingInRect(ring as MMPoint[], r.closed, rect)
          if (a.status !== 'single') continue
          const seg = this.segOf(ring, r.closed, rect)
          if (!seg) continue
          out.push({
            candidateKey: key,
            sourceName: src.name,
            leaf,
            geomType: r.geomType,
            partIndex: r.partIndex,
            ring,
            closed: r.closed,
            seg,
          })
        }
      })
    }
    return out
  }

  /**
   * 画一段高亮边框：可见虚线始终 pointer-events:none（C2：避免兄弟 path 遮挡
   * 下方透明命中线）；interactive=true 时另叠一条 16px 透明 halo 接收点击，
   * 有 onClick 则点选候选，无 onClick 则仅吞掉点击（点橙线不触发"空白取消"）。
   * drawVertices=false 用于拖拽预览（省掉逐节点 circleMarker，减少每帧 SVG 增删）。
   */
  private drawSeg(
    group: L.LayerGroup,
    seg: L.LatLng[],
    color: string,
    interactive: boolean,
    onClick?: () => void,
    drawVertices = true,
  ) {
    if (interactive) {
      const hit = L.polyline(seg, { pane: HANDLE_PANE, interactive: true, color, weight: 16, opacity: 0 } as any)
      hit.on('click', (ev: any) => {
        L.DomEvent.stopPropagation(ev)
        onClick?.()
      })
      hit.addTo(group)
    }
    L.polyline(seg, {
      pane: HANDLE_PANE, interactive: false,
      color, weight: 3, dashArray: '5,3', fill: false,
    } as any).addTo(group)
    if (!drawVertices) return
    for (const p of seg) {
      L.circleMarker(p, {
        pane: HANDLE_PANE,
        radius: 4,
        color: '#ffffff',
        weight: 1.5,
        fillColor: color,
        fillOpacity: 1,
        interactive: false,
      }).addTo(group)
    }
  }

  /** 拖拽中重绘双色高亮（非交互、省略节点 marker，由 rAF 节流） */
  private renderMergePreview(bounds: L.LatLngBounds) {
    this.ensureMergeGroups()
    this.mergeEditableGroup!.clearLayers()
    this.mergeRefGroup!.clearLayers()
    const rect: MMRect = {
      south: bounds.getSouth(), west: bounds.getWest(),
      north: bounds.getNorth(), east: bounds.getEast(),
    }
    const { hits } = this.collectEditableHits(rect)
    const refHits = this.collectRefHits(rect)
    this.mergeEditableHits = hits
    for (const h of hits) this.drawSeg(this.mergeEditableGroup!, h.seg, MERGE_EDIT_COLOR, false, undefined, false)
    for (const h of refHits) this.drawSeg(this.mergeRefGroup!, h.seg, MERGE_REF_COLOR, false, undefined, false)
  }

  /** 松开鼠标：校验（编辑段+参考段）→ 单候选直接执行，多候选进入地图点选 */
  private finalizeMerge(bounds: L.LatLngBounds) {
    const rect: MMRect = {
      south: bounds.getSouth(), west: bounds.getWest(),
      north: bounds.getNorth(), east: bounds.getEast(),
    }
    const { hits: editableHits, circles } = this.collectEditableHits(rect)
    const refHits = this.collectRefHits(rect)
    this.mergeEditableHits = editableHits
    this.ensureMergeGroups()
    this.mergeEditableGroup!.clearLayers()
    this.mergeRefGroup!.clearLayers()
    for (const h of editableHits) this.drawSeg(this.mergeEditableGroup!, h.seg, MERGE_EDIT_COLOR, false)

    if (editableHits.length === 0) {
      // 矩形与高亮一并清除，仅保留提示
      this.clearMergeOverlay()
      this.showMapHint(
        circles > 0
          ? (i18n.t('map.mergeSkippedCircle') || '框内仅命中圆/椭圆要素，圆/椭圆不参与节点合并')
          : (i18n.t('map.mergeNoEditableInBox') || '框内没有可编辑图形的边框：请打开一个图层的"编辑"开关后重画框选'),
      )
      return
    }
    if (refHits.length === 0) {
      this.clearMergeOverlay()
      this.showMapHint(i18n.t('map.mergeNoReferenceInBox') || '框内没有不可编辑图层的边框：请再打开至少一个参考图层')
      return
    }

    // 参考要素按 leaf 归组（同一图形多环算一个候选），key 前缀即来源图层 id
    const candMap = new Map<string, MergeCandidate>()
    for (const h of refHits) {
      let cand = candMap.get(h.candidateKey)
      if (!cand) {
        cand = {
          key: h.candidateKey,
          sourceId: h.candidateKey.split('#')[0],
          name: h.sourceName,
          leaf: h.leaf,
          hits: [],
        }
        candMap.set(h.candidateKey, cand)
      }
      cand.hits.push(h)
    }
    const candidates = [...candMap.values()]
    // 单候选：直接执行（executeMerge 完成后统一清高亮，无需先画蓝层）
    if (candidates.length === 1) {
      this.executeMerge(candidates[0], rect)
      return
    }
    // 多候选：蓝色段可点选；橙色段改画为"仅吞点击"（点橙线不触发空白取消），等待用户选择
    this.mergePendingCandidates = candidates
    this.mergeEditableGroup!.clearLayers()
    for (const h of editableHits) this.drawSeg(this.mergeEditableGroup!, h.seg, MERGE_EDIT_COLOR, true)
    this.mergeRefGroup!.clearLayers()
    for (const cand of candidates) {
      for (const h of cand.hits) {
        this.drawSeg(this.mergeRefGroup!, h.seg, MERGE_REF_COLOR, true, () => this.executeMerge(cand, rect))
      }
    }
    this.showMapHint(
      i18n.t('map.mergeClickTarget', { count: candidates.length })
        || `框内有 ${candidates.length} 个参考图形，点击要吸附的蓝色边框（Esc 取消）`,
      true,
    )
  }

  /** 用候选图形的框内段节点替换全部可编辑命中段，少补多删，一次写入（一次撤销） */
  private executeMerge(cand: MergeCandidate, rect: MMRect) {
    if (!this.layerId) return
    // 候选等待期间其来源图层可能已被隐藏：放弃执行，要求重新框选
    const stillVisible = (this.referenceSourceProvider?.() ?? []).some((s) => s.id === cand.sourceId)
    if (!stillVisible) {
      this.clearMergeOverlay()
      this.showMapHint(i18n.t('map.mergeReferenceHidden') || '参考图层已隐藏，请重新框选')
      return
    }
    const updates = new Map<string, { editId: string; geometry: any }>()
    let aligned = 0
    let skipped = 0
    // 端点平面距离平方（中纬度经度修正），用于在参考要素的多个框内段中选最近段
    const segDist2 = (a: L.LatLng, b: L.LatLng) => {
      const k = Math.cos(((a.lat + b.lat) * Math.PI) / 360)
      const dl = (a.lng - b.lng) * k
      return dl * dl + (a.lat - b.lat) ** 2
    }
    for (const h of this.mergeEditableHits) {
      // 同类几何（线对线、面对面）中取框内段端点总距离最小的参考环；
      // 环向（正反）由 alignRingToReference 内部按端点就近翻转
      let refRing: L.LatLng[] | null = null
      let bestD = Infinity
      const hEn = h.seg[0]
      const hEx = h.seg[h.seg.length - 1]
      for (const rh of cand.hits) {
        if (rh.closed !== h.closed) continue
        const rEn = rh.seg[0]
        const rEx = rh.seg[rh.seg.length - 1]
        const d = Math.min(
          segDist2(hEn, rEn) + segDist2(hEx, rEx),
          segDist2(hEn, rEx) + segDist2(hEx, rEn),
        )
        if (d < bestD) { bestD = d; refRing = rh.ring }
      }
      if (!refRing) { skipped++; continue }
      const res = alignRingToReference(h.ring as MMPoint[], refRing as MMPoint[], h.closed, rect)
      if (!res.ok || !res.ring) { skipped++; continue }

      // 替换 GeoJSON geometry 的对应部件（面闭合、洞保留、Multi* 只改命中部件）
      const geom = JSON.parse(JSON.stringify(h.leaf.feature.geometry))
      const nextCoords = res.ring.map((p) => [p.lng, p.lat] as [number, number])
      if (h.geomType === 'LineString') {
        // 原始为首尾重合的闭合线时补回闭合重复点
        geom.coordinates = h.lineClosed ? this.closedRing(nextCoords) : nextCoords
      } else if (h.geomType === 'Polygon') {
        geom.coordinates = [this.closedRing(nextCoords), ...geom.coordinates.slice(1)]
      } else if (h.geomType === 'MultiLineString') {
        geom.coordinates[h.partIndex] = nextCoords
      } else if (h.geomType === 'MultiPolygon') {
        geom.coordinates[h.partIndex] = [this.closedRing(nextCoords), ...geom.coordinates[h.partIndex].slice(1)]
      }
      h.leaf.feature.geometry = geom
      h.leaf.setLatLngs(this.geomToLeafletLatLngs(geom))
      updates.set(h.editId, { editId: h.editId, geometry: geom })
      aligned++
    }
    if (aligned > 0) {
      // 只写 store：OnlineMap 订阅工作集变化后统一 setWorkspace→rebuild（避免重复全量重建）
      useLayerEditStore.getState().applyMergeResult(this.layerId, [...updates.values()])
    }
    this.clearMergeOverlay()
    // clearMergeOverlay 不恢复光标：开关保持开启（与圈选工具一致，便于连续合并）
    if (aligned > 0) {
      const key = skipped > 0 ? 'map.mergeAlignedSkipped' : 'map.mergeAligned'
      this.showMapHint(
        i18n.t(key, { aligned, skipped })
          || `节点合并完成：已对齐 ${aligned} 个边框${skipped ? `，跳过 ${skipped} 个` : ''}（Ctrl+Z 撤销）`,
      )
    } else {
      this.showMapHint(i18n.t('map.mergeNothingAligned') || '参考边框与可编辑边框类型不匹配（线/面需一致），未做对齐')
    }
  }

  /** 替换后的 GeoJSON geometry → Leaflet setLatLngs 入参 */
  private geomToLeafletLatLngs(geom: any): any {
    const toRing = (coords: Array<[number, number]>) => coords.map((c) => L.latLng(c[1], c[0]))
    switch (geom.type) {
      case 'LineString':
        return toRing(geom.coordinates)
      case 'Polygon':
        return geom.coordinates.map(toRing)
      case 'MultiLineString':
        return geom.coordinates.map((line: any) => toRing(line))
      case 'MultiPolygon':
        return geom.coordinates.map((poly: any) => poly.map(toRing))
      default:
        return []
    }
  }
}
