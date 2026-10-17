/**
 * CesiumJS 3D 地图——OnlineMap 的「同构替身」。
 *
 * 使用与 OnlineMap 完全相同的 props（ComponentProps）与命令式接口（OnlineMapRef），
 * MapPage 只在挂载点按 mapProvider 切换，其余调用点零改动。
 *
 * 协调内容：
 * - Viewer / 全球地形 / OSM 建筑 3D Tiles
 * - LTE/NR 扇区图层（CesiumSectorLayer）：视口剔除、LOD、标签、配色、规划高亮、白名单
 * - 点击：扇区 → onSectorClick；建筑 → 属性面板
 *
 * 后续阶段补齐图层文件/地理化/编辑/工具（对应 ref 方法由 no-op 替换）。
 */
import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState,
  type ComponentProps,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useToastStore } from '../../../store/toastStore'
import { OnlineMap, type OnlineMapRef } from '../OnlineMap'
import { loadCesium } from '../../../services/cesiumLoader'
import { mapStateService } from '../../../services/mapStateService'
import { mapDataService } from '../../../services/mapDataService'
import type { RenderSectorData } from '../../../services/mapDataService'
import {
  useMapStore, CESIUM_QUALITY_PRESETS, type CesiumQuality,
} from '../../../store/mapStore'
import { gcj02ToWgs84, wgs84ToGcj02 } from '../../../utils/coordinate'
import { CesiumSectorLayer, type CameraView } from './CesiumSectorLayer'
import type { SectorStyleContext } from './cesiumSectorStyle'
import type { PlanningHighlight } from './cesiumHighlight'
import { buildPciModPalette } from '../../../utils/pciModColor'
import { CesiumGeoJsonLayer } from './CesiumGeoJsonLayer'
import {
  transformFeatureCollection,
  transformFeatureCollectionAsync,
  transformGeometry,
  geoDataSectorRing,
  isGeoDataDot,
  GEO_DATA_SECTOR_LOD_ZOOM,
  featureSelectionId,
  geometryCentroid,
  emptyBounds,
  hasBounds,
  extendBounds,
  extendBoundsWithPoint,
} from './cesiumGeoJson'
import { layerApi, dataApi } from '../../../services/api'
import { CesiumEditSession } from './CesiumEditSession'
import { SectorInfoPanel } from '../SectorInfoPanel'
import { FeatureInfoPanel } from '../FeatureInfoPanel'
import { CesiumMapTools, type CapturePoint } from './CesiumMapTools'
import { CapturePointPanel } from '../CapturePointPanel'
import { CesiumLabelOverlay } from './CesiumLabelOverlay'
import { createCameraMoveProbe } from './cesiumCameraProbe'
import { useLayerEditStore } from '../../../store/layerEditStore'
import { useMapDataCacheStore } from '../../../store/mapDataCacheStore'
import {
  amapTileUrl,
  tiandituTileUrl,
  TIANDITU_SUBDOMAINS,
  TIANDITU_NATIVE_MAX_ZOOM,
  DEFAULT_TIANDITU_KEY,
} from '../../../config/mapSources'
import { createAmapImageryProvider } from './amapImageryProvider'
import { createContourLayer } from './cesiumContours'
import {
  CesiumSelectionSession,
  type SelectionTarget,
} from './CesiumSelectionSession'
import { orderWithIds, isLayerSelectable } from '../layerZOrder'
import { selectionManager } from '../../../services/selectionManager'
import { CesiumHeatmapLayer } from './CesiumHeatmapLayer'
import type { HeatmapSettings } from '../LabelSettingsModal'
import {
  collectBoundaryPolygons,
  collectGeoDataPolygons,
  type HeatBoundary,
} from '../../../utils/heatSurface'
import { heatSettingsSignature } from '../HeatmapLayerManager'
import type { HeatPoint } from '../../../utils/heatmap'
import { getFieldValue, toNumber } from '../../../utils/fieldValue'
import { resolveSectorField } from '../../../config/sector-config'

type CesiumMapProps = ComponentProps<typeof OnlineMap>

/** Web Mercator 赤道每像素米数（zoom 0） */
const EQUATOR_MPP = 156543.03392

function zoomToHeight(zoom: number, lat: number, hPx: number, fovy: number): number {
  const mpp = (EQUATOR_MPP * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom)
  return (mpp * hPx) / (2 * Math.tan(fovy / 2))
}
function heightToZoom(height: number, lat: number, hPx: number, fovy: number): number {
  const mpp = (height * 2 * Math.tan(fovy / 2)) / hPx
  return Math.round(Math.log((EQUATOR_MPP * Math.cos((lat * Math.PI) / 180)) / mpp) / Math.LN2)
}

type LayerKey = 'lte' | 'nr'
const LAYER_IDS: Record<LayerKey, string> = { lte: 'lte-sectors', nr: 'nr-sectors' }

/** 图层取数的并发上限：并发取数能显著缩短"打开多个图层"的等待，但也不能一次打满后端 */
const GEO_FETCH_CONCURRENCY = 4

/**
 * 渲染崩溃自恢复的次数上限。
 * 正常情况下一次都不该触发；若真是"每帧必崩"的确定性错误，无限重拉只会无限刷屏。
 */
const MAX_RENDER_RECOVERIES = 3

/**
 * 相机移动过程中"标签候选集"的刷新节流（ms）。
 * 见 postRender 里的说明：候选集只在相机停下后刷新会导致移动时标签不跟着走。
 */
const LABEL_SYNC_THROTTLE_MS = 150

/**
 * 相机移动中的渲染分辨率缩放（交互降级）。
 *
 * 平移/缩放是最高频的卡顿场景，而 GPU 填充成本 ≈ 像素数（= resolutionScale²）。
 * 移动中把分辨率压到 0.75（像素量降到约 56%），停下后恢复清晰度档位设定的值 ——
 * 交互流畅度优先，静止观感不变。
 */
const INTERACTION_RESOLUTION_SCALE = 0.75

/**
 * 等浏览器真正画出一帧（双 rAF：第一帧提交 React 的 DOM 变更，第二帧确保已合成上屏）。
 * 用于在开始同步重活前先把"渲染中"的动画标记显示出来。
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 16); return }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

/**
 * 从拾取结果里取出扇区数据。
 *
 * 扇区面/边框已改批量图元，`scene.pick` 返回的 `id` 是 `GeometryInstance.id`（我们放的 `{ sector }`）；
 * 扇区**标签**仍是 Entity（`id` 是 Entity，数据挂在 `sectorData` 上）。两种都要认。
 */
function sectorFromPick(picked: any): RenderSectorData | null {
  const id = picked?.id
  if (!id) return null
  if (id.sector) return id.sector as RenderSectorData
  if (id.sectorData) return id.sectorData as RenderSectorData
  return null
}

/**
 * 热力渲染边界多边形 GCJ02 → WGS84。
 * 后端给出的边界多边形是 GCJ02（与 2D 显示链路一致），Cesium 侧一切按 WGS84 对齐。
 */
function toWgs84Boundary(polygons: HeatBoundary): HeatBoundary {
  return polygons.map((rings) => rings.map((ring) => ring.map(([lng, lat]) => {
    const [wlat, wlng] = gcj02ToWgs84(lat, lng)
    return [wlng, wlat]
  })))
}

/**
 * 从拾取结果里取出图层要素（含所属图层 id）。
 *
 * 图层要素现在走批量图元：`GeometryInstance.id` / `PointPrimitive.id` / `Label.id` 都是
 * `{ feature, layerId }`。为了兼容仍走 Entity 的路径（如有），两种形状都认。
 */
function pickGeo(picked: any): {
  feature: any
  layerId: string
  selectionId: string
} | null {
  if (!picked) return null
  // Primitive 返回 { primitive, id }；Point/LabelCollection 直接返回图元本身
  for (const cand of [picked.id, picked]) {
    if (!cand) continue
    if (cand.geoFeature) {
      return { feature: cand.geoFeature, layerId: cand.geoLayerId, selectionId: '' }
    }
    if (cand.feature && cand.layerId) {
      return {
        feature: cand.feature,
        layerId: cand.layerId,
        selectionId: String(cand.selectionId ?? ''),
      }
    }
  }
  return null
}

/**
 * 单行地理化数据 → GeoJSON Feature（WGS84）。
 *
 * 对等 2D `GeoDataLayer._renderSectors`：
 * - 扇区型文件（`geometryType/type === 'sector'`）且非全向/非室内/非低 zoom → 扇形（半径 80 米）
 * - 其余（点型文件、方位角 360°、室内小区、低 zoom）→ 点
 * 2D 侧走 `getCellCoverStyle` 之外的独立规则，这里保持一致。
 */
function buildGeoDataFeature(
  file: { geometryType?: string; type?: string },
  row: any,
  zoom: number,
): any {
  const isSectorFile = file.geometryType === 'sector' || file.type === 'sector'
  if (isSectorFile && !isGeoDataDot(row, zoom)) {
    const azimuth = row.azimuth ?? 0
    const beamwidth = row.beamwidth || 65
    return {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [geoDataSectorRing(row.latitude, row.longitude, azimuth, beamwidth)],
      },
      properties: row,
    }
  }
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
    properties: row,
  }
}

/** 扇区颜色设置（默认设置/PCI 渲染） */
interface SectorColorSettings {
  fillOpacity?: number
  borderWidth?: number
  pciRenderEnabled?: boolean
  pciMod?: 3 | 30
}

export const CesiumMap = forwardRef<OnlineMapRef, CesiumMapProps>((props, ref) => {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<any>(null)
  const tilesetRef = useRef<any>(null)
  /**
   * 清晰度档位设定的渲染分辨率基准（静止时用这个值；相机移动中临时压低，
   * 停下后恢复，见 camera.changed 里的交互降级）。
   */
  const baseResolutionScaleRef = useRef(1)
  // 图层编辑会话（绘制/顶点/圈选；无可编辑图层时不渲染内容）
  const editSessionRef = useRef<CesiumEditSession | null>(null)
  // 测距 / 抓取坐标工具
  const mapToolsRef = useRef<CesiumMapTools | null>(null)
  // 值热力面（按图层 id 复用）
  const heatmapsRef = useRef<Map<string, CesiumHeatmapLayer>>(new Map())
  /** 热力渲染取消令牌：每次请求 +1，await 回来后令牌对不上就放弃（防止关掉后又贴回来） */
  const heatTokenRef = useRef<Map<string, number>>(new Map())
  /** 上次请求渲染时的设置指纹（用于跳过"设置没变且已画出来"的重复重算） */
  const heatReqRef = useRef<Map<string, string>>(new Map())
  /**
   * 3D 底图层（高德卫星/矢量）与其当前类型。
   * Cesium 的 imageryLayers.get(0) 是底图，热力面等其它 imagery 层挂在它之上；
   * 换底图时必须只替换这一层（不能 removeAll，否则热力面会被一起清掉）。
   */
  const baseImageryLayerRef = useRef<any>(null)
  /** 期望的底图类型（由地图类型切换设置） */
  const baseKindRef = useRef<'satellite' | 'roadmap'>('satellite')
  /** 已经建好的底图类型（与期望不同才重建底图） */
  const appliedBaseKindRef = useRef<'satellite' | 'roadmap' | null>(null)
  /** 底图建好时的高德「矢量注记」开关（矢量底图两版，变了要重建） */
  const appliedVectorAnnotationsRef = useRef<boolean | null>(null)
  /** 3D 影像底图上叠加的天地图影像注记 cia 层（只删自己创建的这层） */
  const ciaAnnotationLayerRef = useRef<any>(null)
  /** cia 层建好时用的天地图 Key（Key 换了要重建该层） */
  const appliedCiaKeyRef = useRef<string | null>(null)
  /** 等高线图层管理器；仅在设置开启时创建（createContourLayer 返回的对象） */
  const contourRef = useRef<{ update: () => Promise<void>; destroy: () => void } | null>(null)
  /** 底图类型切换的触发计数（ref API 里 setMapType 改动 ref 后靠它触发重建） */
  const [baseKindVersion, setBaseKindVersion] = useState(0)
  // 正在渲染热力面的图层数（>0 时在地图中央显示动画标记）
  const [heatmapBusy, setHeatmapBusy] = useState(0)
  /** 正在加载的图层名（图层取数 / 建批量图元时显示，非 null 即提示） */
  const [loadingLayer, setLoadingLayer] = useState<string | null>(null)
  // 圈选 / 点选会话
  const selectionRef = useRef<CesiumSelectionSession | null>(null)
  /**
   * 圈选图形框覆盖层（SVG）。
   * 贴地图元（clampToGround）在拖动中每帧重建永远等不到地形瓦片出图 → 框根本不显示，
   * 所以框改画在这张屏幕空间 SVG 上（与 2D Leaflet 的 SVG renderer 同机制）。
   */
  const selectionOverlayRef = useRef<SVGSVGElement>(null)
  /**
   * 标签覆盖层（Canvas）：基站 / 图层文件 / 地理化 / 装饰的标签统一在这里防重叠绘制，
   * 与 2D 的 LabelLayoutManager 同一套算法（见 labelLayoutCore）。
   */
  const labelCanvasRef = useRef<HTMLCanvasElement>(null)
  const labelOverlayRef = useRef<CesiumLabelOverlay | null>(null)
  /**
   * 「原始采样」热力覆盖层的宿主（每个热力层在里面建自己的 canvas）。
   * 与 2D 一样是屏幕空间逐点色斑，必须叠在 Cesium 画布之上、标签之下。
   */
  const heatSamplesHostRef = useRef<HTMLDivElement>(null)
  const [selectionTip, setSelectionTip] = useState('')
  const [selectedCount, setSelectedCount] = useState(0)
  // 扇区属性框（手形工具点击查属性）+ 重叠扇区列表
  const [sectorInfo, setSectorInfo] = useState<RenderSectorData | null>(null)
  const [overlapSectors, setOverlapSectors] = useState<RenderSectorData[]>([])
  const [sectorInfoPos, setSectorInfoPos] = useState<{ x: number; y: number } | null>(null)
  const sectorLayersRef = useRef<Record<LayerKey, CesiumSectorLayer | null>>({ lte: null, nr: null })
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  // 相机方位角（度，0=正北）；指南针指针据此旋转
  const [headingDeg, setHeadingDeg] = useState(0)
  // 地理化数据扇区的 LOD 桶：低 zoom 退化为圆点（对齐 2D GeoDataLayer.LOD_THRESHOLD）
  const [geoLodLow, setGeoLodLow] = useState(true)
  const [featureInfo, setFeatureInfo] = useState<Array<[string, unknown]>>([])
  const [geoInfo, setGeoInfo] = useState<{
    layerId: string
    props: Record<string, unknown>
    position: { x: number; y: number }
  } | null>(null)
  /** 定位打点属性面板（「选择」工具点击已有打点标记时打开） */
  const [capturePanel, setCapturePanel] = useState<CapturePoint | null>(null)
  const [capturePanelPos, setCapturePanelPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

  const { mapSettings, decorationFeatures, locationPoints } = useMapStore() as any
  const mapSettingsRef = useRef(mapSettings)
  mapSettingsRef.current = mapSettings
  const decorationFeaturesRef = useRef(decorationFeatures)
  decorationFeaturesRef.current = decorationFeatures
  const locationPointsRef = useRef(locationPoints)
  locationPointsRef.current = locationPoints
  const propsRef = useRef(props)
  propsRef.current = props
  /** i18n 取值器（命令式类里用，避免闭包捕获过期语言） */
  const tRef = useRef(t)
  tRef.current = t

  // 动态配置（命令式方法写入）
  const visibilityRef = useRef<Record<LayerKey, boolean>>({
    lte: props.initialLayerVisibility?.lte ?? false,
    nr: props.initialLayerVisibility?.nr ?? false,
  })
  const colorSettingsRef = useRef<Record<string, SectorColorSettings>>({})
  const highlightRef = useRef<PlanningHighlight>({})
  const whitelistRef = useRef<Set<string> | null>(null)
  const selectionIdsRef = useRef<Set<string> | null>(null)
  // 图层文件（含地理化）：id → CesiumGeoJsonLayer
  const geoJsonLayersRef = useRef<Map<string, CesiumGeoJsonLayer>>(new Map())
  // 各图层已加载的原始 GeoJSON 引用（相同则跳过重复转换）
  const rawGeoRef = useRef<Map<string, unknown>>(new Map())
  // 装饰图层（固定 id）
  const decorationLayerRef = useRef<CesiumGeoJsonLayer | null>(null)
  // 图层同步序号（快速连续变化时只处理最新一轮）
  const geoRunRef = useRef(0)

  /** 计算当前相机视野（WGS84 范围 + 等价 zoom + 逐点米/像素） */
  function getCameraView(): CameraView | null {
    const viewer = viewerRef.current
    const C = (window as any).Cesium
    if (!viewer || !C) return null
    const camera = viewer.camera
    const canvasH = viewer.canvas.clientHeight
    const fovy = camera.frustum.fovy
    const carto = camera.positionCartographic
    const lat = C.Math.toDegrees(carto.latitude)
    const zoom = heightToZoom(carto.height, lat, canvasH, fovy)
    const rect = camera.computeViewRectangle()
    let south = lat - 0.01, north = lat + 0.01, west = C.Math.toDegrees(carto.longitude) - 0.01, east = west + 0.02
    if (rect) {
      south = C.Math.toDegrees(rect.south)
      north = C.Math.toDegrees(rect.north)
      west = C.Math.toDegrees(rect.west)
      east = C.Math.toDegrees(rect.east)
    }
    return { south, north, west, east, zoom }
  }

  /** 把当前全部配置推给扇区图层；then 用当前视野重建 */
  function syncAll() {
    const viewer = viewerRef.current
    if (!viewer) return
    const p = propsRef.current
    const ms = mapSettingsRef.current
    const view = getCameraView()
    if (!view) return

    ;(Object.keys(LAYER_IDS) as LayerKey[]).forEach((key) => {
      const layer = sectorLayersRef.current[key]
      if (!layer) return
      const layerId = LAYER_IDS[key]
      const freqList = (key === 'lte' ? p.frequencies?.lte : p.frequencies?.nr) ?? []
      const visibleFreqs = freqList.filter((f) => f.visible).map((f) => f.frequency)
      // 颜色设置以 store 为准：MapPage 保存配色时只调用 2D 地图的 ref（3D 模式下
      // onlineMapRef 为 null，命令式路径走不到这里），若只读本地 ref，3D 的基站扇区
      // 就永远吃不到保存的透明度/边框/PCI 设置（表现为"只有 2D 生效"）。
      // 本地 ref 保留给命令式 setSectorColorSettings 兜底。
      const colorSet = ms.colorSettingsMap?.[layerId] ?? colorSettingsRef.current[layerId]

      const ctx: SectorStyleContext = {
        colorOverrides: colorSet
          ? { fillOpacity: colorSet.fillOpacity, borderWidth: colorSet.borderWidth }
          : null,
        pciRender: colorSet?.pciRenderEnabled
          ? { enabled: true, mod: colorSet.pciMod ?? 3 }
          : null,
        pciPalette: colorSet?.pciRenderEnabled
          ? buildPciModPalette(visibleFreqs.length, colorSet.pciMod ?? 3)
          : null,
        pciFrequencies: visibleFreqs,
        thematic: ms.thematicSettingsMap?.[layerId] ?? null,
      }

      layer.setStyleContext(ctx)
      layer.setHighlight(highlightRef.current)
      layer.setWhitelist(whitelistRef.current)
      layer.setSelectionIds(selectionIdsRef.current)
      layer.setRenderMode(p.mode ?? 'default')
      layer.setLabels(!!p.sectorLabelVisibility?.[layerId], p.labelSettingsMap?.[layerId] ?? null)
      // 热力替换模式（enabled && !showOriginal）下原扇区图形隐藏，只留热力面
      layer.setVisible(visibilityRef.current[key] && !isHeatmapReplacement(layerId))
      layer.update(view)
    })

    // 圈选高亮同步到图层文件 / 地理化数据 / 装饰图层。
    // 早先只推给扇区图层 → 基站能高亮、图层文件与地理化数据圈选后毫无反应。
    // 图层内部会判断"选中集合没变就不重建"（否则每次相机停下都全量重建）。
    for (const layer of geoJsonLayersRef.current.values()) {
      layer.setSelectionIds(selectionIdsRef.current)
      // 视野推给图层（视口裁剪用）：配置变化时按当前视野重建，键没变则不重建
      layer.setView(view)
    }
    decorationLayerRef.current?.setView(view)
    decorationLayerRef.current?.setSelectionIds(selectionIdsRef.current)
    syncLabels()
    // 数据/设置变化后重放热力面（指纹未变时 CesiumHeatmapLayer 内部会跳过重算）
    replayHeatmaps()
  }

  /**
   * 把各图层的标签候选推给统一覆盖层（CesiumLabelOverlay）。
   *
   * 3D 早期是"每个要素一个 Cesium Label Entity/图元"，既不防重叠，又跟着相机停下时的
   * 全量重建一起增删（几千个标签 → 卡顿）。现在对齐 2D：只注册候选，
   * 由覆盖层在屏幕空间做真实文本矩形的贪心避让后批量画到一张 Canvas 上。
   */
  function syncLabels() {
    const overlay = labelOverlayRef.current
    if (!overlay) return
    const p = propsRef.current
    const ms = mapSettingsRef.current
    const view = getCameraView()

    // 基站（LTE / NR）
    for (const key of Object.keys(LAYER_IDS) as LayerKey[]) {
      const id = LAYER_IDS[key]
      const layer = sectorLayersRef.current[key]
      const enabled = !!p.sectorLabelVisibility?.[id]
      if (!layer || !enabled || !layer.isVisible() || !view) {
        overlay.removeSource(id)
        continue
      }
      overlay.setCandidates(id, layer.labelCandidates(view))
    }

    // 图层文件 / 地理化数据
    for (const [fileId, layer] of geoJsonLayersRef.current) {
      const isGeoData = (p.pointFiles ?? []).some((x: any) => x.id === fileId)
      const labelVis = isGeoData
        ? ms.pointFileLabelVisibility?.[fileId]
        : ms.layerFileLabelVisibility?.[fileId]
      if (!labelVis || !layer.isVisible()) {
        overlay.removeSource(fileId)
        continue
      }
      overlay.setCandidates(fileId, layer.labelCandidates(view))
    }

    // 装饰图层（含定位点）
    const deco = decorationLayerRef.current
    if (!deco || !ms.decorationLabelVisible) overlay.removeSource('decoration-layer')
    else overlay.setCandidates('decoration-layer', deco.labelCandidates(view))
  }

  /** 同步图层文件 + 地理化数据（layerFiles / pointFiles 结构一致） */
  async function syncGeoJsonLayers(runId = 0) {
    const viewer = viewerRef.current
    if (!viewer) return
    const C = (window as any).Cesium
    const p = propsRef.current
    const ms = mapSettingsRef.current
    const files = [
      ...(p.layerFiles ?? []).map((f: any) => ({ f, isGeoData: false })),
      ...(p.pointFiles ?? []).map((f: any) => ({ f, isGeoData: true })),
    ]
    const liveIds = new Set<string>()
    /** 本轮真正换了数据的图层（它们的热力面必须重算） */
    const dataChanged = new Set<string>()
    const zoom = getCameraView()?.zoom ?? 15

    // ===== 阶段 1：应用配置（同步、很快）。图层先建出来并处于正确显隐，
    // 这样即便随后被新一轮取代提前返回，也不会残留"该隐的图层还画着"。=====
    const pending: Array<{
      f: any
      isGeoData: boolean
      layer: CesiumGeoJsonLayer
      geojson: any
      alreadyWgs84: boolean
    }> = []
    for (const { f, isGeoData } of files) {
      liveIds.add(f.id)
      let layer = geoJsonLayersRef.current.get(f.id)
      if (!layer) {
        layer = new CesiumGeoJsonLayer(C, viewer, f.id)
        geoJsonLayersRef.current.set(f.id, layer)
      }

      const labelVis = isGeoData
        ? ms.pointFileLabelVisibility?.[f.id]
        : ms.layerFileLabelVisibility?.[f.id]
      // 显隐按来源取对应开关（与 MapPage 的写入路径一致，避免两个 map 互相污染），
      // 未设置时回退 layerFile.visible 字段
      // 用户勾选真值决定要不要取数据；热力替换模式下原图形隐藏但数据仍要取
      // ——热力面就是用这批数据算出来的。
      const { userVisible, visible } = resolveLayerVisibility(f.id)
      // 刻意不传 defaultStyle：后端在命名规则未命中时会按图层名给一个固定颜色
      // （`_palette_color`），若把它当作渲染底色会盖掉逐要素的 `_style`（MapInfo 要素色 /
      // KML Style / RSRP 分级色），整层会被刷成同一种颜色。2D `MapInfoLayer` 同样不用它。
      layer.applyConfig({
        visible,
        color: ms.colorSettingsMap?.[f.id] ?? null,
        thematic: ms.thematicSettingsMap?.[f.id] ?? null,
        labelEnabled: !!labelVis,
        label: ms.labelSettingsMap?.[f.id] ?? null,
      })
      // 先推当前视野：数据到手时（阶段 3 的 setFeatureCollection）直接按视野裁剪建图元，
      // 避免"先全量建一遍、再裁剪重建一遍"的双倍构建
      layer.setView(getCameraView())
      if (!userVisible) continue
      // 缓存里已有 → 不需要取数，直接进"应用数据"阶段
      const cached = f.sourceType === 'excel'
        ? null
        : useMapDataCacheStore.getState().layers[f.id]?.geojson
      if (cached) {
        pending.push({ f, isGeoData, layer, geojson: cached, alreadyWgs84: false })
        continue
      }
      pending.push({ f, isGeoData, layer, geojson: null, alreadyWgs84: false })
    }

    // ===== 阶段 2：并行取数（限并发）。
    // 早先是 `for` 里逐个 await，N 个图层的网络等待会线性叠加；改成并发后
    // 总耗时从 Σ(每层) 降到 max(每层) —— 这是"打开多个图层时卡"最直接的原因。=====
    const needFetch = pending.filter((x) => !x.geojson)
    if (needFetch.length > 0) {
      let cursor = 0
      const worker = async (): Promise<void> => {
        // 无限循环 + 越界 return：并发 worker 的常用写法，用 for(;;) 让意图明确
        for (;;) {
          const idx = cursor++
          if (idx >= needFetch.length) return
          const item = needFetch[idx]
          setLoadingLayer(item.f.name)
          try {
            if (item.f.sourceType === 'excel') {
              // Excel 地理化数据：dataApi.get 返回原始 WGS84 行（坐标不转换）
              const res = await dataApi.get(item.f.dataId)
              let rows = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
              rows = rows.filter((r: any) => r && r.longitude != null && r.latitude != null)
              item.geojson = { features: rows.map((r: any) => buildGeoDataFeature(item.f, r, zoom)) }
              item.alreadyWgs84 = true
            } else {
              const fetched = await layerApi.getLayerDataWithVersion(item.f.dataId, item.f.id)
              item.geojson = fetched.data
              if (item.geojson) {
                useMapDataCacheStore.getState()
                  .cacheLayerGeoJSON(item.f.id, item.geojson, fetched.version)
              }
            }
          } catch (e: any) {
            console.warn('[NPT-LAYER] load failed', item.f.name, e?.message)
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(GEO_FETCH_CONCURRENCY, needFetch.length) }, worker),
      )
      if (geoRunRef.current !== runId) { setLoadingLayer(null); return } // 已被更新一轮取代
    }

    // ===== 阶段 3：逐个应用数据（分块转换 + 建图元，每块之间让出一帧）=====
    for (const item of pending) {
      const { f, layer } = item
      const geojson = item.geojson
      if (!geojson || rawGeoRef.current.get(f.id) === geojson) continue
      if (geoRunRef.current !== runId) { setLoadingLayer(null); return }
      // 提示放在 await 之前：转换与建图元都是主线程重活，先亮提示再算
      setLoadingLayer(f.name)
      await nextPaint()
      if (geoRunRef.current !== runId) { setLoadingLayer(null); return }
      rawGeoRef.current.set(f.id, geojson)
      // 大图层的 GCJ02→WGS84 转换按块跑，每块让一帧，避免整段占住主线程
      const wgs84 = item.alreadyWgs84
        ? geojson
        : await transformFeatureCollectionAsync(geojson)
      if (geoRunRef.current !== runId) { setLoadingLayer(null); return }
      layer.setFeatureCollection(wgs84)
      dataChanged.add(f.id)
      console.log('[NPT-LAYER] loaded', f.name, geojson?.features?.length ?? 0, 'features')
    }
    setLoadingLayer(null)

    // 移除已不存在的图层（连同批量图元与其热力面一起释放）
    for (const [id, layer] of [...geoJsonLayersRef.current]) {
      if (!liveIds.has(id)) {
        layer.destroy()
        geoJsonLayersRef.current.delete(id)
        rawGeoRef.current.delete(id)
        const heat = heatmapsRef.current.get(id)
        if (heat) { cancelPendingHeat(id); heat.destroy(); heatmapsRef.current.delete(id) }
        heatReqRef.current.delete(id)
      }
    }

    syncDecoration()
    syncLabels()
    /**
     * 数据就绪后重放热力面。
     * 热力渲染依赖图层要素（取几何锚点算权重），而取数是异步的——首屏 `syncAll` 跑重放时
     * 数据还没到，点集为空 → 什么都没画，之后也没有任何重试，于是"保存了热力配置，
     * 切回地图页只有空图例、必须重新进设置页才渲染"。数据到了这里补一次就行。
     */
    replayHeatmaps(dataChanged)
  }

  /** 同步装饰图层（装饰要素 + 定位点） */
  function syncDecoration() {
    const viewer = viewerRef.current
    if (!viewer) return
    const C = (window as any).Cesium
    const ms = mapSettingsRef.current
    if (!decorationLayerRef.current) {
      decorationLayerRef.current = new CesiumGeoJsonLayer(C, viewer, 'decoration-layer')
    }
    const layer = decorationLayerRef.current

    const decoFeatures = (decorationFeaturesRef.current ?? []).map((f: unknown) => ({ ...(f as object) }))
    const pointFeatures = (locationPointsRef.current ?? []).map((p: any) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: { id: p.id, name: p.label ?? '' },
    }))
    const fc = { type: 'FeatureCollection', features: [...decoFeatures, ...pointFeatures] }
    layer.setView(getCameraView())
    layer.setFeatureCollection(transformFeatureCollection(fc))
    layer.applyConfig({
      visible: true,
      labelEnabled: !!ms.decorationLabelVisible,
      label: ms.decorationLabelVisible
        ? { content: 'name', fontSize: 12, color: '#000000' } as any
        : null,
    })
  }

  // ===== 圈选 / 点选：目标图层解析与要素收集（对等 OnlineMap.getSelectionTarget） =====

  /** 圈选目标：z-order 最高且"可选"开关打开的图层（基站 > 图层文件 > 地理化 > 装饰） */
  function resolveSelectionTarget(): SelectionTarget {
    const p = propsRef.current
    const order = p.layerOrder
    const selectable = p.selectableMap ?? {}
    const ms = mapSettingsRef.current

    // 1. 基站
    for (const id of orderWithIds(order?.sector, ['lte-sectors', 'nr-sectors'])) {
      const visible = id === 'lte-sectors' ? visibilityRef.current.lte : visibilityRef.current.nr
      if (visible && isLayerSelectable(selectable, id)) {
        return { kind: 'sector', networkType: id === 'lte-sectors' ? 'lte' : 'nr' }
      }
    }
    // 2. 图层文件（MapInfo）
    const mapInfoFiles = (p.layerFiles ?? []) as any[]
    for (const id of orderWithIds(order?.mapinfo, mapInfoFiles.map((f) => f.id))) {
      const f = mapInfoFiles.find((x) => x.id === id)
      if (!f) continue
      const vis = ms.layerFileVisibility?.[id] ?? f.visible
      if (vis && isLayerSelectable(selectable, id)) return { kind: 'layer', layerId: id }
    }
    // 3. 地理化数据
    const geoFiles = (p.pointFiles ?? []) as any[]
    for (const id of orderWithIds(order?.geodata, geoFiles.map((f) => f.id))) {
      const f = geoFiles.find((x) => x.id === id)
      if (!f) continue
      const vis = ms.pointFileVisibility?.[id] ?? f.visible
      if (vis && isLayerSelectable(selectable, id)) return { kind: 'layer', layerId: id }
    }
    // 4. 装饰图层
    if (p.decorationLayerVisible !== false && isLayerSelectable(selectable, 'decoration-layer')) {
      return { kind: 'decoration' }
    }
    return null
  }

  /** 指定图层的全部要素（CesiumGeoJsonLayer 持有的是已转 WGS84 的 GeoJSON） */
  function layerSelectables(layerId: string) {
    const layer = geoJsonLayersRef.current.get(layerId)
    if (!layer) return []
    // id 口径必须与图层渲染/搜索弹窗一致（见 featureSelectionId 注释）
    return layer.getFeatures().map((f: any, i: number) => ({
      id: featureSelectionId(f.properties, layerId, i),
      geometry: f.geometry,
      properties: (f.properties ?? {}) as Record<string, unknown>,
    }))
  }

  /** 收起所有属性框（点空白处 / 平移地图时调用） */
  function closeInfoPanels() {
    setGeoInfo(null)
    setSectorInfo(null)
    setOverlapSectors([])
    setCapturePanel(null)
  }

  // ===== 值热力面（与 2D 共用计算与栅格化，见 CesiumHeatmapLayer） =====

  /**
   * 该图层是否处于热力「替换模式」：热力启用且「显示原图层」关闭。
   * 此时原图形与标签必须隐藏，只留热力面 —— 与 2D `OnlineMap.isHeatmapReplacement` 同语义。
   * 所有"按勾选状态恢复原图层可见性"的路径都要经过此判定，否则兜底显隐会把已隐藏的原图层重新显示出来。
   */
  function isHeatmapReplacement(layerId: string): boolean {
    const hs = mapSettingsRef.current.heatmapSettingsMap?.[layerId] as HeatmapSettings | undefined
    return !!(hs?.enabled && hs.field && !hs.showOriginal)
  }

  /**
   * 解析某图层当前的可见性：
   * - `userVisible`：用户勾选真值（只有它决定要不要取数据）
   * - `visible`：叠加热力替换模式后的最终显隐
   * 显隐规则只此一处，避免 sync 路径与热力开关路径各写一份而分叉。
   */
  function resolveLayerVisibility(fileId: string): { userVisible: boolean; visible: boolean } {
    const p = propsRef.current
    const ms = mapSettingsRef.current
    const isGeoData = (p.pointFiles ?? []).some((x: any) => x.id === fileId)
    const f = [...(p.layerFiles ?? []), ...(p.pointFiles ?? [])]
      .find((x: any) => x.id === fileId) as any
    const vis = isGeoData ? ms.pointFileVisibility?.[fileId] : ms.layerFileVisibility?.[fileId]
    const userVisible = vis !== undefined ? !!vis : !!f?.visible
    return { userVisible, visible: userVisible && !isHeatmapReplacement(fileId) }
  }

  /**
   * 热力开关变化后重算原图层显隐。
   *
   * 替换模式下原图形要隐藏、关掉热力后要恢复显示；而显隐只在 sync 路径重算，
   * 不补这一步就会出现「关掉热力图，原图层还是不见」。
   * 这里只重算显隐，不重新取数（避免每次切换热力都打一轮网络请求）。
   */
  function refreshHeatVisibility() {
    syncAll() // 扇区显隐（含替换模式判定）
    for (const [id, layer] of geoJsonLayersRef.current) {
      layer.setVisible(resolveLayerVisibility(id).visible)
    }
  }

  /** 收集某图层的热力点（WGS84）。扇区取 originalLat/Lng，图层要素取几何锚点 */
  function collectHeatPoints(layerId: string, field: string): HeatPoint[] {
    const key: LayerKey | null = layerId === 'lte-sectors' ? 'lte'
      : layerId === 'nr-sectors' ? 'nr' : null
    if (key) {
      // 与 2D SectorRendererSVG.getHeatPoints 同口径：展示别名先映射回真实字段，非数值跳过
      const realField = resolveSectorField(field)
      const out: HeatPoint[] = []
      for (const s of sectorLayersRef.current[key]?.getAllSectors() ?? []) {
        const w = toNumber((s as unknown as Record<string, unknown>)[realField])
        if (w === null) continue
        if (!Number.isFinite(s.originalLat) || !Number.isFinite(s.originalLng)) continue
        out.push({ lat: s.originalLat, lng: s.originalLng, weight: w })
      }
      return out
    }
    const layer = geoJsonLayersRef.current.get(layerId)
    if (!layer) return []
    const out: HeatPoint[] = []
    for (const f of layer.getFeatures() as any[]) {
      const props = (f.properties ?? {}) as Record<string, unknown>
      const w = toNumber(getFieldValue(props, field))
      if (w === null) continue
      // 与 2D `MapInfoLayer.getHeatPoints` 同口径：面/线要素的热力权重取**顶点质心**，
      // 早先取的是"第一个坐标"（多边形的外环首顶点）→ 大面要素的热点被顶到图形角上
      const anchor = geometryCentroid(f.geometry)
      if (!anchor) continue
      out.push({ lat: anchor[1], lng: anchor[0], weight: w })
    }
    return out
  }

  /**
   * 作废某图层挂起中的热力渲染（取消令牌）。
   *
   * `renderHeatmapFor` 里有两个 await（取边界 + 等一帧），期间用户可能已经把热力关掉、
   * 把图层隐藏或删掉了。没有令牌时那次渲染仍会在 await 之后照常 `addImageryProvider`，
   * 贴出一个**不在 heatmapsRef 里**的孤儿图层 —— 后续所有移除路径都找不到它，
   * 表现就是"热力关不掉，只能刷新页面"。
   */
  function cancelPendingHeat(layerId: string) {
    heatTokenRef.current.set(layerId, (heatTokenRef.current.get(layerId) ?? 0) + 1)
  }

  /** 热力面还该显示吗：设置启用 + 源图层处于勾选可见状态且仍存在 */
  function isHeatActive(layerId: string): boolean {
    const p = propsRef.current
    const key: LayerKey | null = layerId === 'lte-sectors' ? 'lte'
      : layerId === 'nr-sectors' ? 'nr' : null
    if (key) return !!visibilityRef.current[key]
    const exists = [...(p.layerFiles ?? []), ...(p.pointFiles ?? [])]
      .some((f: any) => f.id === layerId)
    return exists && resolveLayerVisibility(layerId).userVisible
  }

  /**
   * 渲染某图层的热力面；settings 为 null / 未启用 / 源图层不可见时移除。
   * 边界多边形从后端取（GCJ02）后转 WGS84 —— Cesium 侧一切都按 WGS84 对齐。
   */
  async function renderHeatmapFor(layerId: string, settings: HeatmapSettings | null) {
    cancelPendingHeat(layerId)
    const token = heatTokenRef.current.get(layerId) ?? 0
    let layer = heatmapsRef.current.get(layerId)
    if (!settings?.enabled || !settings.field || !isHeatActive(layerId)) {
      if (layer) { layer.remove(); heatmapsRef.current.delete(layerId) }
      heatReqRef.current.delete(layerId)
      return
    }
    if (!layer) {
      const C = (window as any).Cesium
      const viewer = viewerRef.current
      if (!C || !viewer) return
      layer = new CesiumHeatmapLayer(C, viewer, layerId, heatSamplesHostRef.current)
      heatmapsRef.current.set(layerId, layer)
    }
    /**
     * 提示必须在任何 await **之前**亮起。
     * 早先它排在 `await loadHeatBoundary()` 之后——边界是网络请求（几百毫秒到数秒），
     * 于是"点了确定之后要等网络回来才出现'正在渲染热力图'"，看起来就是慢了一拍。
     * IDW 插值 + 逐像素着色是同步重活，先让浏览器真正画出一帧再算，界面才不会僵住。
     */
    setHeatmapBusy((n) => n + 1)
    await nextPaint()
    try {
      const boundary = await loadHeatBoundary(settings)
      if (heatTokenRef.current.get(layerId) !== token) return // 期间被关掉/换了一轮
      layer.render(collectHeatPoints(layerId, settings.field), settings, boundary)
    } finally {
      setHeatmapBusy((n) => Math.max(0, n - 1))
    }
  }

  /** 加载热力渲染边界多边形（GCJ02 → WGS84） */
  async function loadHeatBoundary(settings: HeatmapSettings): Promise<HeatBoundary | null> {
    const layerId = settings.boundaryLayerId
    if (!layerId) return null
    try {
      let polygons: HeatBoundary | null = null
      if ((settings.boundarySource ?? 'mapinfo') === 'excel') {
        const resp = await dataApi.get(settings.boundaryDataId ?? '')
        polygons = collectGeoDataPolygons(resp?.data)
      } else {
        let geojson = useMapDataCacheStore.getState().layers[layerId]?.geojson
        if (!geojson && settings.boundaryDataId) {
          const resp = await layerApi.getLayerData(settings.boundaryDataId, layerId)
          if (resp.success && resp.data) geojson = resp.data
        }
        polygons = collectBoundaryPolygons(geojson)
      }
      return polygons ? toWgs84Boundary(polygons) : null
    } catch (e) {
      console.warn('[CesiumMap] 热力边界加载失败:', layerId, e)
      return null
    }
  }

  /**
   * 重放所有已启用的热力设置（设置变化 / 数据就绪 / 图层显隐变化 / 首次进入 3D）。
   *
   * 幂等靠"上次请求的设置指纹"记账：指纹没变且已经画出来了就跳过，避免每次同步都
   * 重跑一遍 IDW（`forceIds` 里的图层例外——它们的数据刚变，必须重算）。
   * 反过来，源图层被取消勾选 / 被删除 / 热力被关掉时，这里负责把残留的热力面摘掉。
   */
  function replayHeatmaps(forceIds?: Set<string>) {
    const map = (mapSettingsRef.current.heatmapSettingsMap ?? {}) as Record<string, HeatmapSettings>
    for (const [layerId, settings] of Object.entries(map)) {
      if (!settings?.enabled || !settings.field) continue
      if (!isHeatActive(layerId)) continue
      const sig = heatSettingsSignature(settings)
      const existing = heatmapsRef.current.get(layerId)
      if (!forceIds?.has(layerId) && existing?.isRendered()
        && heatReqRef.current.get(layerId) === sig) continue
      heatReqRef.current.set(layerId, sig)
      void renderHeatmapFor(layerId, settings)
    }
    // 已关掉 / 源图层已隐藏或删除的，把残留热力面摘掉
    for (const [layerId, layer] of [...heatmapsRef.current]) {
      if (!map[layerId]?.enabled || !isHeatActive(layerId)) {
        cancelPendingHeat(layerId)
        layer.destroy()
        heatmapsRef.current.delete(layerId)
        heatReqRef.current.delete(layerId)
      }
    }
  }

  /** 图层 id → 显示名（属性框副标题） */
  function layerDisplayName(layerId: string): string {
    const p = propsRef.current
    const all = [...(p.layerFiles ?? []), ...(p.pointFiles ?? [])] as any[]
    return all.find((f) => f.id === layerId)?.name ?? layerId
  }

  /** 装饰图层要素（store 里是 GCJ02，转 WGS84） */
  function decorationSelectables() {
    const feats = (useMapStore.getState().decorationFeatures ?? []) as any[]
    return feats.map((f, i) => ({
      // 与装饰图层（decoration-layer）渲染侧同一套 id 口径
      id: featureSelectionId(f.properties, 'decoration-layer', i),
      geometry: f.geometry ? transformGeometry(f.geometry) : null,
      properties: (f.properties ?? {}) as Record<string, unknown>,
    })).filter((f) => !!f.geometry)
  }

  /**
   * 扇区点击（对等 OnlineMap.handleSectorClick 的地图工具页语义）：
   * - 规划页面（PCI/TAC/邻区）→ 走 onSectorClick 回调
   * - 「选择」工具 → 只高亮并纳入选中态（不弹属性框）
   * - 「手形」工具 → 点击查属性；同点有多个重叠扇区时先给列表
   */
  function handleSectorClick(sector: RenderSectorData, windowPos: { x: number; y: number }) {
    const p = propsRef.current
    if ((p.mode ?? 'default') !== 'default') {
      p.onSectorClick?.(sector)
      return
    }
    const selectMode = useLayerEditStore.getState().selectMode
    if (selectMode && !p.mapDragTool) {
      selectionRef.current?.selectSingle(String(sector.id), {
        ...sector, _layerType: sector.networkType,
      } as unknown as Record<string, unknown>)
      return
    }
    if (!p.mapDragTool) return

    const viewer = viewerRef.current
    const C = (window as any).Cesium
    const overlaps: RenderSectorData[] = []
    if (viewer && C) {
      const picks: any[] = viewer.scene.drillPick(windowPos, 12)
      for (const pk of picks) {
        const s = sectorFromPick(pk)
        if (s && !overlaps.some((x) => String(x.id) === String(s.id))) overlaps.push(s)
      }
    }
    if (overlaps.length === 0) overlaps.push(sector)
    setSectorInfoPos({ x: windowPos.x, y: windowPos.y })
    setOverlapSectors(overlaps)
    setSectorInfo(overlaps.length > 1 ? null : sector)
  }

  // 初始化
  useEffect(() => {
    let disposed = false

    async function init() {
      const container = containerRef.current
      if (!container) return
      try {
        const initialZoom = mapStateService.getState().zoom
        const [C, mapData] = await Promise.all([
          loadCesium(),
          mapDataService.getMapData(initialZoom),
        ])
        C.Ion.defaultAccessToken = mapSettingsRef.current.cesiumIonToken

        const viewer = new C.Viewer(container, {
          // 底图：高德卫星影像（原为天地图影像）。
          // 高德瓦片是 GCJ02 而 Cesium 场景是 WGS84，必须走 createAmapImageryProvider
          // 做瓦片级纠偏，否则底图会相对工参/图层整体偏 100~700 米
          baseLayer: new C.ImageryLayer(
            createAmapImageryProvider(C, amapTileUrl('satellite'))),
          terrain: C.Terrain.fromWorldTerrain(),
          animation: false,
          timeline: false,
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          fullscreenButton: false,
          infoBox: false,
          selectionIndicator: false,
        })
        if (disposed) { viewer.destroy(); return }
        viewerRef.current = viewer
        /**
         * 场景渲染效果瘦身（3D 性能优化，与 2D 观感拉齐）。
         *
         * 这些效果都是逐像素/逐帧的全屏 shader 开销，而本工具的视角是城市级：
         * - `enableLighting`：太阳光照逐帧算太阳方位、改全局光照 uniform，让卫星影像
         *   （本身就是"拍好的照片"）随虚拟时间变色。2D 高德卫星没有任何光照，
         *   关掉才与 2D 一致，也省掉整帧的光照计算。
         * - `skyAtmosphere` / `globe.showGroundAtmosphere` / `fog`：大气与雾的
         *   全屏后效，城市级视角下观感贡献极小。
         * - `sun` / `moon`：天空里的两个 billboard，关光照后没有存在意义。
         *
         * 清晰度档位（resolutionScale / FXAA / SSE）走下方独立 effect，与此处不冲突。
         */
        try {
          viewer.scene.globe.enableLighting = false
          viewer.scene.skyAtmosphere.show = false
          viewer.scene.globe.showGroundAtmosphere = false
          viewer.scene.fog.enabled = false
          viewer.scene.sun.show = false
          viewer.scene.moon.show = false
        } catch {
          // 理论上 1.146 全都有；个别开关缺失不该拦住整个地图初始化
        }
        // 记录底图层（imageryLayers[0] = 构造时传入的 baseLayer）：
        // 后续换底图只替换这一层，不 removeAll（否则会清掉热力面等 imagery 层）
        baseImageryLayerRef.current = viewer.imageryLayers.get(0)
        appliedBaseKindRef.current = 'satellite'
        appliedVectorAnnotationsRef.current = false
        // 调试钩子：暴露 viewer 与编辑 store，便于外部检查 3D 场景/编辑状态
        const winHook = window as unknown as Record<string, unknown>
        winHook.__nptCesiumViewer = viewer
        winHook.__nptLayerEditStore = useLayerEditStore

        const tileset = await C.createOsmBuildingsAsync()
        // 3D Tiles 的遍历/加载成本主要由屏幕空间误差阈值决定：默认 16（越早细化越精细）。
        // 本工具是城市级俯瞰视角，建筑在屏幕上通常只有几十像素，32 的细化阈值
        // 观感几乎无差，但显著减少瓦片遍历与加载量（Cesium 专项优化）。
        tileset.maximumScreenSpaceError = 32
        viewer.scene.primitives.add(tileset)
        tilesetRef.current = tileset

        // 扇区图层
        const lteLayer = new CesiumSectorLayer(C, viewer, 'LTE')
        const nrLayer = new CesiumSectorLayer(C, viewer, 'NR')
        lteLayer.setRenderData(mapData.lteSectors as RenderSectorData[])
        nrLayer.setRenderData(mapData.nrSectors as RenderSectorData[])
        sectorLayersRef.current = { lte: lteLayer, nr: nrLayer }

        // 初始相机（GCJ02 → WGS84）
        const saved = mapStateService.getState()
        const [wlat, wlng] = gcj02ToWgs84(saved.center[0], saved.center[1])
        viewer.scene.camera.setView({
          destination: C.Cartesian3.fromDegrees(
            wlng, wlat,
            zoomToHeight(saved.zoom, wlat, container.clientHeight, viewer.camera.frustum.fovy)),
        })

        // 点击：扇区 → onSectorClick；GeoJSON 要素 → 属性；建筑 → 高亮 + 属性
        let selectedTile: any = null
        const handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas)
        handler.setInputAction((movement: any) => {
          // 绘制/圈选工具激活时，点击交由编辑会话消费（加顶点/点选），
          // 不弹建筑/要素属性面板（与 Leaflet 编辑态 stopPropagation 一致）
          const edit = useLayerEditStore.getState()
          if (edit.editableLayerId && (edit.drawTool !== 'none' || edit.selectMode)) return
          // 测距 / 抓取坐标 / 圈选激活时，点击由对应会话消费
          if (propsRef.current.measureMode || propsRef.current.captureMode) return
          if ((propsRef.current.selectionMode ?? 'none') !== 'none') return
          // 定位打点：与 2D 一致，「选择」工具点击已有标记 → 打开属性面板
          // （编辑经纬度 / 重命名 / 复制属性 / 删除），点空白仍照常走扇区与要素拾取
          if (useLayerEditStore.getState().selectMode) {
            const capHit = mapToolsRef.current?.pickCapture(movement.position)
            if (capHit) {
              // 只收起其它属性框（不能用 closeInfoPanels：它会把 capturePanel 一起清掉）
              setGeoInfo(null)
              setSectorInfo(null)
              setOverlapSectors([])
              setCapturePanel(capHit)
              setCapturePanelPos({ x: movement.position.x, y: movement.position.y })
              return
            }
          }
          const picked = viewer.scene.pick(movement.position)
          const pickedSector = sectorFromPick(picked)
          if (pickedSector) {
            handleSectorClick(pickedSector, movement.position)
            return
          }
          const pickedGeo = pickGeo(picked)
          if (pickedGeo) {
            const featProps = (pickedGeo.feature.properties ?? {}) as Record<string, unknown>
            // 与高德侧一致：「选择」工具只高亮，手形工具才弹属性框
            if (useLayerEditStore.getState().selectMode && !propsRef.current.mapDragTool) {
              selectionRef.current?.selectSingle(
                pickedGeo.selectionId, { ...featProps, _layerType: 'MapInfo' })
              return
            }
            if (!propsRef.current.mapDragTool) return
            setGeoInfo({
              layerId: pickedGeo.layerId,
              props: featProps,
              position: { x: movement.position.x, y: movement.position.y },
            })
            setFeatureInfo([])
            setSectorInfo(null)
            setOverlapSectors([])
            return
          }
          if (selectedTile) { selectedTile.color = C.Color.WHITE; selectedTile = null }
          if (picked instanceof C.Cesium3DTileFeature) {
            selectedTile = picked
            picked.color = C.Color.YELLOW.withAlpha(0.9)
            const propsOut: Array<[string, unknown]> = []
            picked.getPropertyIds().forEach((name: string) =>
              propsOut.push([name, picked.getProperty(name)]))
            setFeatureInfo(propsOut)
            closeInfoPanels()
          } else {
            setFeatureInfo([])
            // 点到空白处：三类属性框（建筑/要素/扇区）一并收起。
            // 早先这里漏了扇区属性框 → 点空白处扇区属性框一直挂着不退出。
            closeInfoPanels()
          }
        }, C.ScreenSpaceEventType.LEFT_CLICK)

        // 相机移动：防抖重建扇区（视口剔除）+ 回写 mapStateService + 更新指南针
        let moveTimer: ReturnType<typeof setTimeout> | null = null
        let headingTimer: ReturnType<typeof setTimeout> | null = null
        /** 交互中（降分辨率）标记：true = 已压低 resolutionScale，停下后要恢复 */
        let interacting = false
        viewer.camera.changed.addEventListener(() => {
          const carto = viewer.camera.positionCartographic
          const lat = C.Math.toDegrees(carto.latitude)
          const lng = C.Math.toDegrees(carto.longitude)
          const [glat, glng] = wgs84ToGcj02(lat, lng)
          mapStateService.setState({
            center: [glat, glng],
            zoom: heightToZoom(carto.height, lat, container.clientHeight, viewer.camera.frustum.fovy),
          })
          // 交互中降渲染分辨率：一次交互只压一次（连续 changed 事件不重复设置），
          // 像素量降到约 56%，停下后在 moveTimer 里恢复清晰度
          if (!interacting) {
            interacting = true
            viewer.resolutionScale = Math.min(
              baseResolutionScaleRef.current, INTERACTION_RESOLUTION_SCALE)
          }
          // 指南针：方位角变化较碎，节流到 ~100ms 更新一次
          if (!headingTimer) {
            headingTimer = setTimeout(() => {
              headingTimer = null
              setHeadingDeg(C.Math.toDegrees(viewer.camera.heading))
            }, 100)
          }
          // 平移/缩放后属性框跟随的锚点已失效 → 收起（与高德侧"移动地图即关闭属性框"一致）
          if (!moveTimer) closeInfoPanels()
          if (moveTimer) clearTimeout(moveTimer)
          moveTimer = setTimeout(() => {
            moveTimer = null
            interacting = false
            // 卸载/销毁后迟到的一次恢复：viewer 已毁时写属性会抛错
            if (viewer.isDestroyed()) return
            // 恢复清晰度档位设定的渲染分辨率（静止观感不变）
            viewer.resolutionScale = baseResolutionScaleRef.current
            const view = getCameraView()
            if (view) {
              sectorLayersRef.current.lte?.update(view)
              sectorLayersRef.current.nr?.update(view)
              // GeoJSON 图层视口裁剪重建：与扇区同时机（停下才重建，移动中不重建）。
              // 图层内部按视野分档键去重，视野没实质变化不会重建
              for (const layer of geoJsonLayersRef.current.values()) layer.setView(view)
              decorationLayerRef.current?.setView(view)
              // 跨过地理化数据扇区 LOD 阈值时才重建（圆点 ↔ 扇形）
              setGeoLodLow(view.zoom <= GEO_DATA_SECTOR_LOD_ZOOM)
            }
            syncLabels()
            // 等高线：相机停下后按新视野重新采样（模块内有同视野守卫，重复调用无害）
            void contourRef.current?.update()
          }, 350)
        })
        /**
         * 覆盖层（圈选框 + 标签）跟随相机：在 `scene.postRender` 里**逐帧比较相机状态**，
         * 只要相机动过就重绘，与底图严格同帧。
         *
         * 不能用 `camera.changed` 事件驱动（早先的做法）：它受 `percentageChanged` 阈值
         * （这里为 0.25＝相机变化 25% 才触发）限制，小幅平移/缩放根本不触发 →
         * 标签停在旧的屏幕位置、看起来"不跟随要素移动、错位"。
         * 2D 的 `LabelLayoutManager` 是 Leaflet 每个 `move` 帧都重绘，这里必须等价。
         *
         * 比较 `positionWC` / `directionWC` / `upWC`（Cesium 每帧原地更新的公开属性，
         * 免去 `viewMatrix` getter 的 updateMembers 计算）+ 画布尺寸（窗口 resize 改变视锥）。
         * 具体探测实现在 `cesiumCameraProbe.ts`（小步移动必须也被识别，见该文件注释）。
         */
        const overlayCameraMoved = createCameraMoveProbe()
        /**
         * 候选集刷新节流（ms）。
         *
         * 覆盖层每帧只是把已有候选重新投影（所以标签会跟着地图走），但**候选集本身**
         * 原先只在"相机停下 350ms"后才刷新（`syncLabels`）。持续平移/缩放时视野已经变了、
         * 候选还是旧的：旧候选被投影到屏幕外 → 画面上一个标签都没有，而新进入视野的
         * 要素一直没标签 —— 表现为"标签不随地图走"。
         * 这里在移动过程中按节流补刷新，让候选集始终对应当前视野。
         */
        let lastLabelSyncAt = 0
        viewer.scene.postRender.addEventListener(() => {
          if (!overlayCameraMoved(viewer.camera, viewer.canvas?.clientWidth ?? 0)) return
          selectionRef.current?.refreshOverlay()
          // 「原始采样」热力是屏幕空间逐点色斑，与标签同理由：相机一动就要重投影重画
          for (const heat of heatmapsRef.current.values()) heat.drawSamplesNow()
          labelOverlayRef.current?.drawNow()
          const now = performance.now()
          if (now - lastLabelSyncAt >= LABEL_SYNC_THROTTLE_MS) {
            lastLabelSyncAt = now
            syncLabels()
          }
        })
        // 相机变化 10% 就触发重建 → 交互中重建过密；放宽到 25%，只在明显移动后重建
        // （仅用于上方的防抖重建路径，覆盖层重绘不依赖它）
        viewer.camera.percentageChanged = 0.25
        /**
         * 刻意**不**开启 `scene.pickTranslucentDepth`（2026-10-14 修"缩放必崩 _target"的根因）。
         *
         * 该开关只影响 `scene.pickPosition`（半透明几何的深度拾取），**不影响 `scene.pick`
         * 能不能点到半透明要素** —— 点击命中靠的是"近乎全透明的命中面"那一招（见
         * `CesiumGeoJsonLayer` 里 alpha 0.01 的说明），与这个开关无关。
         *
         * 但相机控制器在**滚轮缩放的每一步**（相机高度 < 150km，即所有城市级缩放）都会内部调用
         * `scene.pickPositionWorldCoordinates`；开关打开时它走 `renderTranslucentDepthForPick`
         * —— 一次"把整个场景重绘进 pick-depth framebuffer"的旁路渲染。该旁路有已知缺陷
         * （CesiumGS/cesium#12617，标题就是本错误，至今 open）：图元被 remove/add（正是扇区随
         * 缩放重建时）会让它拿到已销毁/undefined 的纹理，抛
         * `TypeError: Cannot read properties of undefined (reading '_target')`；
         * 错误落在渲染循环里 → Cesium 停掉渲染循环 + 插全屏错误浮层 = 3D 页面"冻结、点不动"。
         * 保持默认 false，缩放就不再走那条旁路。
         *
         * 曾经误以为"半透明几何不可拾取"要靠它解决：其实 `scene.pick`（点击命中）本来就拾取
         * 半透明图元（贴地面也一样），真正让"点透明面没反应"消失的是那层 alpha 0.01 的命中面。
         */

        /**
         * 渲染崩溃自恢复。一次渲染异常会留下两个后果，都要处理：
         *
         * 1) 渲染循环停止：Cesium 的渲染循环里任何未捕获异常都会走
         *    `catch { _useDefaultRenderLoop = false; _renderLoopRunning = false }` —— 循环**永久停止**。
         *    `useDefaultRenderLoop` 的 setter 在 `_renderLoopRunning === false` 时会重启循环，
         *    所以接 `scene.renderError` 后重新置 true 把它拉起来。
         * 2) 全屏错误浮层：Cesium 还会往地图容器里插一层 `.cesium-widget-errorPanel`
         *    （带 OK 按钮、盖住整个地图并吞掉鼠标事件）。即使渲染循环恢复了，
         *    用户看到的仍是"页面冻结、无法操作"—— 恢复成功后必须把这层浮层摘掉。
         *
         * 细节：不立刻重启。错误被 `Scene.render` 的 tryAndCatch 吞掉时，旧渲染链上还挂着
         * 一帧，立刻置 true 会让新旧两条链同时渲染（双重渲染、越拖越卡）；等它自行退出后再拉起。
         *
         * 限次数：只为挡"每帧必崩"的确定性错误（无限重拉＝无限刷屏）。距上次错误 8 秒以上
         * 视为新一轮，计数归零 —— 交互触发型错误（缩放时偶发）不会几次就用光恢复额度。
         */
        let renderRecoveries = 0
        let lastRenderErrorAt = 0
        viewer.scene.renderError.addEventListener((_scene: unknown, error: unknown) => {
          console.error('[CesiumMap] 渲染出错（已尝试恢复渲染循环）:', error)
          const now = Date.now()
          if (now - lastRenderErrorAt > 8000) renderRecoveries = 0
          lastRenderErrorAt = now
          if (renderRecoveries >= MAX_RENDER_RECOVERIES) return
          renderRecoveries += 1
          window.setTimeout(() => {
            try {
              if (viewer.isDestroyed()) return
              if (!viewer.useDefaultRenderLoop) {
                viewer.useDefaultRenderLoop = false
                viewer.useDefaultRenderLoop = true
              }
              containerRef.current
                ?.querySelectorAll('.cesium-widget-errorPanel')
                .forEach((el) => el.remove())
            } catch (e) {
              console.error('[CesiumMap] 恢复渲染循环失败:', e)
            }
          }, 120)
        })

        // 图层编辑会话：viewer 就绪即创建（无工作集时零渲染）
        editSessionRef.current = new CesiumEditSession(C, viewer)
        // 圈选 / 点选会话（高亮直接写回扇区与 GeoJSON 图层；图形框画在 SVG 覆盖层上）
        selectionRef.current = new CesiumSelectionSession(C, viewer, {
          getTarget: resolveSelectionTarget,
          getSectors: (networkType) => {
            const layer = sectorLayersRef.current[networkType]
            return layer && layer.isVisible() ? layer.getAllSectors() : []
          },
          getLayerFeatures: layerSelectables,
          getDecorationFeatures: decorationSelectables,
          applyHighlight: (ids) => {
            selectionIdsRef.current = ids.size > 0 ? ids : null
            syncAll()
          },
          onSelectionChange: (count) => setSelectedCount(count),
          onTip: (tip) => setSelectionTip(tip),
          t: (key, opts) => t(key, opts) as string,
        }, selectionOverlayRef.current)
        labelOverlayRef.current = new CesiumLabelOverlay(C, viewer, labelCanvasRef.current)
        // 测距 / 抓取坐标工具
        mapToolsRef.current = new CesiumMapTools(
          C, viewer,
          (lng, lat) => propsRef.current.onCaptureCoord?.(lng, lat),
          (key) => tRef.current(key),
          (point, screen) => { setCapturePanel(point); setCapturePanelPos(screen) },
        )

        setLoading(false)
        setReady(true)
        syncAll()
        syncGeoJsonLayers()
      } catch (e: any) {
        if (!disposed) {
          setLoadError(e?.message ? String(e.message) : 'Cesium 初始化失败')
          setLoading(false)
        }
      }
    }

    init()
    return () => {
      disposed = true
      try { mapToolsRef.current?.destroy() } catch { /* ignore */ }
      mapToolsRef.current = null
      try { editSessionRef.current?.destroy() } catch { /* ignore */ }
      editSessionRef.current = null
      try { selectionRef.current?.destroy() } catch { /* ignore */ }
      selectionRef.current = null
      try { labelOverlayRef.current?.destroy() } catch { /* ignore */ }
      labelOverlayRef.current = null
      for (const h of heatmapsRef.current.values()) {
        try { h.destroy() } catch { /* ignore */ }
      }
      heatmapsRef.current.clear()
      try { sectorLayersRef.current.lte?.destroy() } catch { /* ignore */ }
      try { sectorLayersRef.current.nr?.destroy() } catch { /* ignore */ }
      try { viewerRef.current?.destroy() } catch { /* ignore */ }
      viewerRef.current = null
      tilesetRef.current = null
      sectorLayersRef.current = { lte: null, nr: null }
      geoJsonLayersRef.current.clear()
      rawGeoRef.current.clear()
      decorationLayerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // props 变化（模式/频点/标签/标签配置/专题）→ 重新推送
  useEffect(() => {
    if (!ready) return
    syncAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ready,
    props.mode,
    props.frequencies,
    props.sectorLabelVisibility,
    props.labelSettingsMap,
    // 保存配色（不透明度/边框/PCI）必须能推到 3D：与 2D 拉齐
    mapSettings.colorSettingsMap,
    mapSettings.thematicSettingsMap,
    // 热力设置变化必须能触发重放：3D 侧热力面只在"设置对话框确定"和同步路径里渲染，
    // 不监听它就会出现"保存了配置、切回地图页只剩空图例"。
    mapSettings.heatmapSettingsMap,
  ])

  /**
   * 基站图层（LTE/NR）显隐跟随外部勾选状态（首屏设置恢复 / 切换账号）。
   *
   * 3D 的显隐只存在 visibilityRef 里、平时由命令式 setLayerVisibility 更新；不监听这个
   * prop 就会停在**挂载那一刻**的值（往往是上一账号的 mapSettings 或默认值），
   * 表现为"控制面板里没勾选的基站图层，3D 地图上还画着"。2D 侧 OnlineMap 有等价的同步 effect。
   */
  useEffect(() => {
    const next: Record<LayerKey, boolean> = {
      lte: props.initialLayerVisibility?.lte ?? false,
      nr: props.initialLayerVisibility?.nr ?? false,
    }
    let changed = false
    for (const key of Object.keys(next) as LayerKey[]) {
      if (visibilityRef.current[key] !== next[key]) {
        visibilityRef.current[key] = next[key]
        changed = true
      }
    }
    if (changed && ready) syncAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, props.initialLayerVisibility?.lte, props.initialLayerVisibility?.nr])

  // 图层文件 / 地理化 / 装饰配置变化 → 重新同步图层
  useEffect(() => {
    if (!ready) return
    const runId = ++geoRunRef.current
    syncGeoJsonLayers(runId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ready,
    props.layerFiles,
    props.pointFiles,
    mapSettings.colorSettingsMap,
    mapSettings.thematicSettingsMap,
    mapSettings.pointFileLabelVisibility,
    mapSettings.layerFileLabelVisibility,
    mapSettings.layerFileVisibility,
    mapSettings.pointFileVisibility,
    mapSettings.labelSettingsMap,
    mapSettings.decorationLabelVisible,
    decorationFeatures,
    locationPoints,
    geoLodLow,
  ])

  // 测距 / 抓取坐标工具模式切换
  useEffect(() => {
    const tools = mapToolsRef.current
    if (!tools) return
    if (props.measureMode) tools.setMode('measure')
    else if (props.captureMode) tools.setMode('capture')
    else tools.setMode(null)
  }, [props.measureMode, props.captureMode])

  // 圈选模式切换：进入圈选时禁用相机旋转/平移/倾斜（否则拖框会同时转动地球），滚轮缩放保留
  useEffect(() => {
    const mode = props.selectionMode ?? 'none'
    selectionRef.current?.setMode(mode)
    const viewer = viewerRef.current
    if (!viewer) return
    const ctrl = viewer.scene.screenSpaceCameraController
    const active = mode !== 'none'
    ctrl.enableRotate = !active
    ctrl.enableTranslate = !active
    ctrl.enableTilt = !active
    ctrl.enableLook = !active
    return () => {
      ctrl.enableRotate = true
      ctrl.enableTranslate = true
      ctrl.enableTilt = true
      ctrl.enableLook = true
    }
  }, [props.selectionMode, ready])

  // 多边形闭合：双击（与高德侧一致）
  useEffect(() => {
    if (!ready) return
    const viewer = viewerRef.current
    const C = (window as any).Cesium
    if (!viewer || !C) return
    const handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas)
    handler.setInputAction(() => {
      if (propsRef.current.selectionMode === 'polygon') selectionRef.current?.finishPolygon()
    }, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    return () => { try { handler.destroy() } catch { /* ignore */ } }
  }, [ready])

  // Ctrl+C：复制选中要素属性为 TSV（可直接粘贴到 Excel），与高德侧提示一致
  useEffect(() => {
    if (!ready) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.key === 'c' && (e.ctrlKey || e.metaKey))) return
      const picked = selectionRef.current?.getSelectedProperties() ?? []
      if (picked.length === 0) return
      // 复用 selectionManager 的复制实现：navigator.clipboard 不可用时回退 execCommand，
      // 直接调 navigator.clipboard 在部分环境（非安全上下文/未聚焦）会静默失败
      void selectionManager.copyToClipboard(picked).then((res) => {
        setSelectionTip((prev) => {
          const suffix = res.success
            ? (t('map.copiedExcelHint') || '属性文本已复制，可直接粘贴到 Excel')
            : (t('map.copyFailed') || '复制失败，请检查浏览器剪贴板权限')
          return prev ? `${prev}；${suffix}` : suffix
        })
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ready, t])

  /**
   * 测距 / 圈选的键盘快捷键（对等 2D OnlineMap 的全局 keydown）：
   * - 测距中：Esc / Delete 清空测量（Delete 连打点标记一起清），Backspace 撤销上一个点
   * - 圈选中：Esc / Backspace 撤销多边形上一个顶点；Esc（未绘制中）取消当前选中
   * 输入框聚焦时不响应（否则网页端其它表单里的 Backspace 会误删测量点）。
   */
  useEffect(() => {
    if (!ready) return
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
      if (mapToolsRef.current?.handleKeyDown(e)) return
      selectionRef.current?.handleKeyDown(e)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ready])

  /**
   * 3D 底图（高德）与影像注记（天地图 cia）。
   *
   * - **底图**：高德卫星影像（`webst style=6`）；也可切到高德矢量。原为天地图影像，
   *   按要求换成高德；高德瓦片是 GCJ02 而 Cesium 场景是 WGS84，所以统一走
   *   `createAmapImageryProvider` 做瓦片级纠偏（否则底图会相对工参/图层整体偏 100~700 米）。
   * - **矢量底图的注记**：沿用设置 → 高德页签的「矢量注记」开关（开=官方 `style=8`
   *   自带注记，关=`ltype=11` 无注记版），与 2D 同一口径；矢量底图本身已含注记，无需再叠。
   * - **影像注记**：影像类底图（当前即高德卫星）上叠**天地图 cia**，与 2D 的卫星图同一张
   *   注记（天地图是 WGS84、Cesium 场景也是 WGS84，**不需要**纠偏，直接 UrlTemplate 即可）。
   *   开关在设置 → CesiumJS 页签的「影像注记」，默认开。
   */
  useEffect(() => {
    if (!ready) return
    const viewer = viewerRef.current
    const C = (window as any).Cesium
    if (!viewer || !C) return
    const layers = viewer.imageryLayers
    const kind = baseKindRef.current

    // 底图：类型或矢量注记开关变了才换（先加新的、再删旧的，避免中间空一帧）
    const vectorAnnotations = mapSettings.amapAnnotations?.vector !== false
    if (!baseImageryLayerRef.current
      || appliedBaseKindRef.current !== kind
      || appliedVectorAnnotationsRef.current !== vectorAnnotations) {
      try {
        const next = layers.addImageryProvider(
          createAmapImageryProvider(C, amapTileUrl(
            kind === 'satellite' ? 'satellite' : 'vector',
            { vectorAnnotations },
          )),
          0,
        )
        const old = baseImageryLayerRef.current
        baseImageryLayerRef.current = next
        appliedBaseKindRef.current = kind
        appliedVectorAnnotationsRef.current = vectorAnnotations
        if (old) { try { layers.remove(old, true) } catch { /* ignore */ } }
      } catch (e) {
        console.warn('[CesiumMap] 底图加载失败:', e)
      }
    }

    // 影像注记：只叠天地图 cia，且只加/删**自己创建**的这一层
    // （绝不能 imageryLayers.removeAll()——热力面也是 imagery 层，会被一起清掉）。
    const wantCia = kind === 'satellite' && mapSettings.cesiumImageAnnotation !== false
    const ciaKey = mapSettingsRef.current.tiandituApiKey || DEFAULT_TIANDITU_KEY
    const ciaStale = !!ciaAnnotationLayerRef.current && appliedCiaKeyRef.current !== ciaKey
    if ((wantCia && !ciaAnnotationLayerRef.current) || ciaStale || (!wantCia && ciaAnnotationLayerRef.current)) {
      try {
        // 先删旧的（Key 变更/底图切走/开关关闭都走这里），再加新的
        const old = ciaAnnotationLayerRef.current
        ciaAnnotationLayerRef.current = null
        appliedCiaKeyRef.current = null
        if (old) { try { layers.remove(old, true) } catch { /* ignore */ } }
        if (wantCia) {
          const provider = new C.UrlTemplateImageryProvider({
            url: tiandituTileUrl('cia', ciaKey),
            subdomains: TIANDITU_SUBDOMAINS,
            minimumLevel: 3,
            maximumLevel: TIANDITU_NATIVE_MAX_ZOOM,  // 服务端只有到 18 级
            credit: '天地图',
            hasAlpha: true,                        // cia 是带透明通道的 PNG
          })
          ciaAnnotationLayerRef.current = layers.addImageryProvider(provider)
          appliedCiaKeyRef.current = ciaKey
        }
      } catch (e) {
        console.warn('[CesiumMap] 影像注记图层加载失败:', e)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, baseKindVersion, mapSettings.amapAnnotations, mapSettings.cesiumImageAnnotation, mapSettings.tiandituApiKey])

  /**
   * 等高线：按设置开关创建 / 销毁图层管理器（默认关闭）。
   *
   * 采样地形是异步且开销随视野平方增长，所以既不进逐帧渲染循环、也不在相机移动过程中
   * 采样 —— 只在开关变化时建/拆，以及相机停下后由 `camera.changed` 的 350ms 节流触发
   * （见 viewer 初始化处）。模块内部还有"同一视野不重算"守卫。
   */
  useEffect(() => {
    if (!ready) return
    const viewer = viewerRef.current
    const C = (window as any).Cesium
    if (!viewer || !C) return

    if (!mapSettings.cesiumContours) {
      contourRef.current?.destroy()
      contourRef.current = null
      return
    }
    if (!contourRef.current) {
      contourRef.current = createContourLayer({
        C,
        viewer,
        // 高程瓦片整体取不到（断网/被拦）时给一次明确提示，避免"开了开关什么都没发生"
        onSamplerError: () => {
          useToastStore.getState().show(
            t('map.contourTerrainUnavailable') || '地形高程数据暂不可用，等高线未渲染（联网后恢复）',
          )
        },
      })
      void contourRef.current.update()
    }
    return () => {
      contourRef.current?.destroy()
      contourRef.current = null
    }
  }, [ready, mapSettings.cesiumContours])

  // 暴露当前图层文件给编辑会话（打开现有图层编辑时据此查找 dataId/sourceType）
  useEffect(() => {
    const win = window as unknown as Record<string, unknown>
    win.__nptLayerFiles =
      [...(props.layerFiles ?? []), ...(props.pointFiles ?? [])]
  }, [props.layerFiles, props.pointFiles])

  // 3D 清晰度档位（右键「设置」→ CesiumJS）：映射到 resolutionScale / FXAA / 屏幕空间误差
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !ready) return
    const tier = mapSettings.cesiumQuality as CesiumQuality | undefined
    const preset = (tier && CESIUM_QUALITY_PRESETS[tier]) || CESIUM_QUALITY_PRESETS.smooth
    const dpr = window.devicePixelRatio || 1
    // resolutionScale > 1：按高于 CSS 像素的分辨率渲染再缩回，文字与影像更锐（成本 ×DPR²）
    const base = Math.min(dpr, preset.maxResolutionScale)
    baseResolutionScaleRef.current = base
    viewer.resolutionScale = base
    viewer.scene.fxaa = preset.fxaa
    viewer.scene.globe.maximumScreenSpaceError = preset.maximumScreenSpaceError
  }, [ready, mapSettings.cesiumQuality])

  // 建筑样式（由右键「设置」→ CesiumJS 页签控制；仅影响 OSM 建筑）
  const styleMode = mapSettings.cesiumBuildingStyle
  useEffect(() => {
    const C = (window as any).Cesium
    const tileset = tilesetRef.current
    if (!C || !tileset) return
    if (styleMode === 'material') {
      tileset.style = new C.Cesium3DTileStyle({
        defines: { material: "${feature['building:material']}" },
        color: {
          conditions: [
            ["${material} === null", "color('white')"],
            ["${material} === 'glass'", "color('skyblue', 0.5)"],
            ["${material} === 'concrete'", "color('grey')"],
            ["${material} === 'brick'", "color('indianred')"],
            ["${material} === 'stone'", "color('lightslategrey')"],
            ["${material} === 'metal'", "color('lightgrey')"],
            ["${material} === 'steel'", "color('lightsteelblue')"],
            ["true", "color('white')"],
          ],
        },
      })
    } else if (styleMode === 'height') {
      tileset.style = new C.Cesium3DTileStyle({
        color: {
          conditions: [
            ["${feature['cesium#estimatedHeight']} < 20", "color('lightgreen')"],
            ["${feature['cesium#estimatedHeight']} < 50", "color('yellow')"],
            ["${feature['cesium#estimatedHeight']} < 100", "color('orange')"],
            ["true", "color('red')"],
          ],
        },
      })
    } else if (styleMode === 'hideLow') {
      tileset.style = new C.Cesium3DTileStyle({ show: "${feature['cesium#estimatedHeight']} >= 20" })
    } else {
      tileset.style = new C.Cesium3DTileStyle()
    }
    // ready 变化后重跑：tileset 是异步创建的，首帧可能还没就绪，
    // 否则持久化的非默认样式在重新进入 3D 时不会生效
  }, [styleMode, ready])

  useImperativeHandle(ref, (): OnlineMapRef => {
    const noop = () => {}
    const noopAsync = () => Promise.resolve()
    return {
      flyTo: (latLng, zoom) => {
        const viewer = viewerRef.current
        if (!viewer) return
        const C = (window as any).Cesium
        const [wlat, wlng] = gcj02ToWgs84(latLng[0], latLng[1])
        const h = zoom !== undefined
          ? zoomToHeight(zoom, wlat, viewer.canvas.clientHeight, viewer.camera.frustum.fovy)
          : viewer.camera.positionCartographic.height
        viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(wlng, wlat, h) })
      },
      fitBounds: (latLngs) => {
        const viewer = viewerRef.current
        if (!viewer || latLngs.length === 0) return
        const C = (window as any).Cesium
        const wgs = latLngs.map((p) => gcj02ToWgs84(p[0], p[1]))
        const lats = wgs.map((p) => p[0])
        const lngs = wgs.map((p) => p[1])
        viewer.camera.flyTo({
          destination: C.Rectangle.fromDegrees(
            Math.min(...lngs), Math.min(...lats),
            Math.max(...lngs), Math.max(...lats)),
        })
      },
      setSearchMarker: noop,
      clearSearchMarker: noop,
      setLayerVisibility: (layer, visible) => {
        const key: LayerKey = layer === 'lte' ? 'lte' : 'nr'
        visibilityRef.current[key] = visible
        syncAll()
      },
      setSectorLabelVisibility: noop,
      setPointFileLabelVisibility: noop,
      setMapInfoLayerVisibility: noop,
      refreshLayerData: noopAsync,
      setMapType: (type) => {
        // 3D 底图在高德卫星 / 高德矢量之间切换；注记层随之切换（见上方底图与注记的 effect）。
        // 这里只改"期望类型"再触发重建 —— 不再 removeAll（那会把热力面等 imagery 层一起清掉）
        baseKindRef.current = type === 'satellite' ? 'satellite' : 'roadmap'
        setBaseKindVersion((v) => v + 1)
      },
      setLayerFileLabelVisibility: noop,
      setLayerColorSettings: noop,
      setSectorColorSettings: (layerId, settings) => {
        if (settings === null) delete colorSettingsRef.current[layerId]
        else colorSettingsRef.current[layerId] = settings
        syncAll()
      },
      getPciRenderStats: () => null,
      refreshSectorColors: () => syncAll(),
      setLayerThematicSettings: noop,
      setSectorThematicSettings: () => syncAll(),
      setLayerHeatmapSettings: (fileId, settings) => {
        void renderHeatmapFor(fileId, settings)
        refreshHeatVisibility()
      },
      setSectorHeatmapSettings: (layerId, settings) => {
        void renderHeatmapFor(layerId, settings)
        refreshHeatVisibility()
      },
      getHeatmapStats: (layerId) => heatmapsRef.current.get(layerId)?.getStats() ?? null,
      replayHeatmapSettings: () => replayHeatmaps(),
      getSectorThematicStats: (layerId) => {
        const key: LayerKey | null = layerId === 'lte-sectors' ? 'lte'
          : layerId === 'nr-sectors' ? 'nr' : null
        return key ? sectorLayersRef.current[key]?.getThematicStats() ?? null : null
      },
      getLayerThematicStats: (fileId) => {
        const key: LayerKey | null = fileId === 'lte-sectors' ? 'lte'
          : fileId === 'nr-sectors' ? 'nr' : null
        if (key) return sectorLayersRef.current[key]?.getThematicStats() ?? null
        return geoJsonLayersRef.current.get(fileId)?.getThematicStats() ?? null
      },
      toggleMapType: noop,
      setFrequencyVisibility: () => syncAll(),
      setCustomLayerVisibility: noop,
      setDecorationLabelVisibility: noop,
      setBaseMapVisibility: (visible) => {
        const viewer = viewerRef.current
        if (viewer) viewer.imageryLayers.get(0) &&
          (viewer.imageryLayers.get(0).show = visible)
      },
      refreshData: noopAsync,
      addLocationMarker: (marker) => {
        // 经纬度抓取/外部定位标记（WGS84）：与打点标记同源，切工具不会被清掉
        mapToolsRef.current?.addLocationMarker(marker.lng, marker.lat)
      },
      clearLocationMarkers: () => mapToolsRef.current?.clearCapture(),
      clearMeasurements: () => mapToolsRef.current?.clearMeasure(),
      setLayerFileLabelSettings: noop,
      setMeasureMode: (enabled) => mapToolsRef.current?.setMode(enabled ? 'measure' : null),
      setNeighborHighlight: (config) => {
        highlightRef.current = { ...highlightRef.current, neighbor: config }
        syncAll()
      },
      clearNeighborHighlight: () => {
        highlightRef.current = { ...highlightRef.current, neighbor: null }
        syncAll()
      },
      setSectorIdWhitelist: (whitelist) => {
        whitelistRef.current = whitelist
        syncAll()
      },
      clearSectorIdWhitelist: () => {
        whitelistRef.current = null
        syncAll()
      },
      setPCIHighlightMode: (config) => {
        highlightRef.current = { ...highlightRef.current, pci: config }
        syncAll()
      },
      clearPCIHighlight: () => {
        highlightRef.current = { ...highlightRef.current, pci: null }
        syncAll()
      },
      setTACHighlightMode: (config) => {
        highlightRef.current = { ...highlightRef.current, tac: config }
        syncAll()
      },
      clearSelectionHighlight: () => {
        selectionIdsRef.current = null
        selectionRef.current?.clearSelection()
        setSelectedCount(0)
        setSelectionTip('')
        syncAll()
      },
      setSelectionHighlight: (ids) => {
        selectionIdsRef.current = ids
        syncAll()
      },
      /** 图层预览：把相机飞到该图层要素的全貌范围（对齐高德侧 focusLayer） */
      focusLayer: (fileId) => {
        const viewer = viewerRef.current
        const C = (window as any).Cesium
        if (!viewer || !C) return
        const b = emptyBounds()

        if (fileId === 'lte-sectors' || fileId === 'nr-sectors') {
          const key: LayerKey = fileId === 'lte-sectors' ? 'lte' : 'nr'
          for (const s of sectorLayersRef.current[key]?.getAllSectors() ?? []) {
            extendBoundsWithPoint(b, s.originalLng, s.originalLat)
          }
        } else if (fileId === 'decoration-layer') {
          for (const f of decorationSelectables()) extendBounds(b, f.geometry)
          for (const p of (locationPointsRef.current ?? []) as any[]) {
            if (p?.lng != null && p?.lat != null) {
              const [wlat, wlng] = gcj02ToWgs84(p.lat, p.lng)
              extendBoundsWithPoint(b, wlng, wlat)
            }
          }
        } else {
          const layer = geoJsonLayersRef.current.get(fileId)
          for (const f of layer?.getFeatures() ?? []) extendBounds(b, (f as any).geometry)
        }

        if (!hasBounds(b)) return
        // 单点/极小范围时给一个最小跨度，否则 Rectangle 退化会让相机贴到地面
        const minSpan = 1e-4
        const west = b.west, east = Math.max(b.east, b.west + minSpan)
        const south = b.south, north = Math.max(b.north, b.south + minSpan)
        viewer.camera.flyTo({
          destination: C.Rectangle.fromDegrees(west, south, east, north),
        })
      },
      /**
       * 搜索定位（图层文件 / 地理化数据）：等图层就绪 → 红色描边高亮目标要素 → 飞行定位。
       * 与 2D `OnlineMap.locateLayerFeature` 同口径：入参是 **GCJ02** 渲染坐标，
       * Cesium 侧一切按 WGS84，需先转换。
       */
      locateLayerFeature: async (opts) => {
        const findLayer = () => {
          const l = geoJsonLayersRef.current.get(opts.layerId)
          return l && l.isVisible() ? l : null
        }
        // 大图层首次取数 + 建批量图元要等一会儿（同 2D：最多 30s、每 200ms 试一次）
        let layer = findLayer()
        const deadline = Date.now() + 30000
        while (!layer && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200))
          layer = findLayer()
        }
        if (!layer) {
          console.warn('[CesiumMap] locateLayerFeature: 图层未加载或不可见', opts.layerId)
          return false
        }
        // 清掉其它高亮，只留目标要素（红色描边即搜索定位高亮，与 2D 一致）
        selectionIdsRef.current = new Set([String(opts.featureId)])
        syncAll()

        const viewer = viewerRef.current
        const C = (window as any).Cesium
        if (!viewer || !C) return true
        if (opts.bounds) {
          const [[s, w], [n, e]] = opts.bounds
          const [ws, ww] = gcj02ToWgs84(s, w)
          const [wn, we] = gcj02ToWgs84(n, e)
          viewer.camera.flyTo({ destination: C.Rectangle.fromDegrees(ww, ws, we, wn) })
          return true
        }
        if (opts.center) {
          const [wlat, wlng] = gcj02ToWgs84(opts.center[0], opts.center[1])
          const carto = viewer.camera.positionCartographic
          const curZoom = heightToZoom(
            carto.height, C.Math.toDegrees(carto.latitude),
            viewer.canvas.clientHeight, viewer.camera.frustum.fovy)
          viewer.camera.flyTo({
            destination: C.Cartesian3.fromDegrees(
              wlng, wlat,
              zoomToHeight(Math.max(curZoom, 16), wlat,
                viewer.canvas.clientHeight, viewer.camera.frustum.fovy)),
          })
        }
        return true
      },
      /** 清除搜索定位的要素高亮（图层文件 / 地理化数据） */
      clearLayerFeatureHighlight: () => {
        selectionIdsRef.current = null
        syncAll()
      },
      locateSector: (opts) => {
        const viewer = viewerRef.current
        if (!viewer) return
        const C = (window as any).Cesium
        const [wlat, wlng] = gcj02ToWgs84(opts.lat, opts.lng)
        viewer.camera.flyTo({
          destination: C.Cartesian3.fromDegrees(wlng, wlat,
            opts.zoom !== undefined
              ? zoomToHeight(opts.zoom, wlat, viewer.canvas.clientHeight, viewer.camera.frustum.fovy)
              : viewer.camera.positionCartographic.height),
        })
      },
      clearSectorHighlight: noop,
      getPointFileData: () => ({}),
      setSectorLabelSettings: () => syncAll(),
      clearCaptureMarkers: () => mapToolsRef.current?.clearCapture(),
      clearShapeSelection: () => {
        editSessionRef.current?.clearSelection()
        selectionRef.current?.clearShape()
      },
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="w-full h-full" />

      {/*
        圈选图形框覆盖层（拖框预览 + 松手后的终态框）。
        用屏幕空间 SVG 而非 Cesium 贴地图元：贴地图元要等地形瓦片就绪才出图，
        拖动中每帧重建等于永远画不出来（表现为"圈选没有框"）。
      */}
      <svg
        ref={selectionOverlayRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-[900]"
        aria-hidden="true"
      />
      {/*
        「原始采样」热力覆盖层的宿主：每个热力图层在里面自建一张 canvas（叠放顺序=创建顺序）。
        屏幕空间逐点色斑，与 2D 的 OriginalSamplesLayer 同一套画法；放在标签覆盖层之下。
      */}
      <div
        ref={heatSamplesHostRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-[901]"
        aria-hidden="true"
      />
      {/*
        标签覆盖层：基站 / 图层文件 / 地理化 / 装饰的标签统一在这里防重叠绘制。
        与 2D 的 LabelLayoutManager 同一套算法，避免逐要素 Cesium 标签既不防重叠又拖垮帧率。
      */}
      <canvas
        ref={labelCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-[902]"
        aria-hidden="true"
      />

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/40 text-foreground text-xs">
          {t('map.loading')}
        </div>
      )}
      {!!loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/60 text-destructive text-xs px-6 text-center">
          {loadError}
        </div>
      )}

      {/* 指南针：指针随相机方位角旋转，点击回正北（方位角归零） */}
      {!loading && !loadError && (
        <button
          onClick={() => {
            const viewer = viewerRef.current
            if (!viewer) return
            const C = (window as any).Cesium
            if (!C) return
            const cam = viewer.camera
            cam.setView({
              orientation: {
                heading: 0,
                pitch: cam.pitch,
                roll: 0,
              },
            })
            setHeadingDeg(0)
          }}
          className="absolute top-28 right-3 z-[1000] w-9 h-9 flex items-center justify-center rounded-full bg-card/95 border border-border shadow-md text-muted-foreground hover:text-primary hover:bg-muted transition-colors"
          title={t('map.compassReset') || '回正北'}
          aria-label={t('map.compassReset') || '回正北'}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" style={{ transform: `rotate(${-headingDeg}deg)` }}>
            {/* 北向指针（红） */}
            <polygon points="12,3 15,12 12,10 9,12" fill="#ef4444" />
            {/* 南向指针 */}
            <polygon points="12,21 9,12 12,14 15,12" fill="currentColor" opacity="0.55" />
          </svg>
        </button>
      )}

      {/* 图层要素属性框（与高德侧同一个组件） */}
      <FeatureInfoPanel
        visible={!!geoInfo}
        properties={geoInfo?.props ?? null}
        subtitle={geoInfo ? layerDisplayName(geoInfo.layerId) : undefined}
        position={geoInfo?.position}
        viewportBounds={containerRef.current?.getBoundingClientRect() ?? null}
        onClose={() => setGeoInfo(null)}
      />

      {/* 定位打点属性面板（「选择」工具点击已有打点：改经纬度 / 重命名 / 复制 / 删除） */}
      {!!capturePanel && (
        <CapturePointPanel
          point={capturePanel}
          position={capturePanelPos}
          viewportBounds={containerRef.current
            ? { width: containerRef.current.clientWidth, height: containerRef.current.clientHeight }
            : null}
          onRename={(name) => {
            mapToolsRef.current?.renameCapturePoint(capturePanel.id, name)
            setCapturePanel({ ...capturePanel, name })
          }}
          onMove={(lng, lat) => {
            mapToolsRef.current?.moveCapturePoint(capturePanel.id, lng, lat)
            setCapturePanel({ ...capturePanel, lng, lat })
          }}
          onCopy={() => {
            void selectionManager.copyToClipboard([{
              [t('map.labelName') || '标签']: capturePanel.name,
              [t('map.longitude') || '经度']: capturePanel.lng.toFixed(6),
              [t('map.latitude') || '纬度']: capturePanel.lat.toFixed(6),
            }])
          }}
          onDelete={() => {
            mapToolsRef.current?.removeCapturePoint(capturePanel.id)
            setCapturePanel(null)
          }}
          onClose={() => setCapturePanel(null)}
          t={t}
        />
      )}

      {/*
        居中动画标记：热力图渲染中 / 图层加载中。
        IDW 插值与图层批量图元重建都是同步重活，不提示会让界面看着像卡死；
        提示在所有 await **之前**就亮起（调用方保证），所以用户点了操作立刻能看到。
        文案统一用 `map.loading`（与 2D 同键），不再带具体图层名。
      */}
      {(heatmapBusy > 0 || !!loadingLayer) && (
        <div className="absolute inset-0 z-[1100] flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card/95 border border-border shadow-lg">
            <svg
              width="18" height="18" viewBox="0 0 24 24" fill="none"
              className="animate-spin text-primary"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            <span className="text-xs text-foreground">
              {t('map.loading')}
            </span>
          </div>
        </div>
      )}

      {/* 圈选提示条（与高德侧同款：底部居中，显示选中数量与复制提示） */}
      {selectionTip && (props.selectionMode ?? 'none') !== 'none' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[1000] px-3 py-1.5 rounded-md bg-card/95 border border-border shadow-md text-xs text-foreground whitespace-nowrap">
          {selectionTip}
          {selectedCount > 0 && (
            <span className="ml-2 text-primary">{selectedCount}</span>
          )}
        </div>
      )}

      {/* 重叠扇区列表（手形工具点击同点多个扇区）：选中某项进入属性框，可返回 */}
      {overlapSectors.length > 1 && (
        <div
          className="absolute z-[1001] w-52 max-h-64 overflow-y-auto bg-card/95 border border-border rounded-lg shadow-lg"
          style={{
            left: Math.min(sectorInfoPos?.x ?? 0, Math.max(0, (containerRef.current?.clientWidth ?? 400) - 216)),
            top: Math.min(sectorInfoPos?.y ?? 0, Math.max(0, (containerRef.current?.clientHeight ?? 400) - 200)),
          }}
        >
          <div className="px-3 py-1.5 text-xs font-semibold text-foreground border-b border-border">
            {t('map.overlapSectors') || '重叠扇区'}
          </div>
          {overlapSectors.map((s) => (
            <button
              key={String(s.id)}
              onClick={() => { setSectorInfo(s); setOverlapSectors([]) }}
              className="w-full text-left px-3 py-1.5 text-xs text-foreground hover:bg-muted hover:text-primary transition-colors"
            >
              {s.name || s.sectorId || String(s.id)}
              <span className="ml-1 text-muted-foreground">{s.networkType}</span>
            </button>
          ))}
        </div>
      )}

      {/* 扇区属性框（与高德侧同一个组件） */}
      <SectorInfoPanel
        sector={sectorInfo}
        visible={!!sectorInfo}
        position={sectorInfoPos ?? undefined}
        viewportBounds={containerRef.current?.getBoundingClientRect() ?? null}
        onClose={() => { setSectorInfo(null); setOverlapSectors([]) }}
        onBack={overlapSectors.length === 0 && sectorInfoPos ? () => {
          // 回到重叠列表
          const viewer = viewerRef.current
          const C = (window as any).Cesium
          const list: RenderSectorData[] = []
          if (viewer && C && sectorInfoPos) {
            for (const pk of viewer.scene.drillPick({ x: sectorInfoPos.x, y: sectorInfoPos.y }, 12)) {
              const s = sectorFromPick(pk)
              if (s && !list.some((x) => String(x.id) === String(s.id))) list.push(s)
            }
          }
          if (list.length > 1) { setOverlapSectors(list); setSectorInfo(null) }
        } : undefined}
      />

      {featureInfo.length > 0 && (
        <div className="absolute bottom-4 left-3 z-[1000] max-w-xs bg-card/95 border border-border rounded-lg p-3">
          <div className="text-xs font-semibold text-foreground mb-1">
            {t('map.buildingProps') || '建筑属性'}
          </div>
          <div className="space-y-0.5 max-h-52 overflow-y-auto">
            {featureInfo.map(([name, value]) => (
              <div key={name} className="text-[11px] text-muted-foreground break-all">
                <span className="text-foreground">{name}</span>: {String(value)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
})

CesiumMap.displayName = 'CesiumMap'
