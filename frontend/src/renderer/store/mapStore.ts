import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { LabelSettings, LayerColorSettings, ThematicSettings, ThematicTemplate, HeatmapSettings, HeatmapTemplate, DEFAULT_HEATMAP_SETTINGS, HEATMAP_SETTINGS_VERSION } from '../components/Map/LabelSettingsModal'
import type { LayerZType } from '../components/Map/layerZOrder'
import { userSettingsApi } from '../services/api'
import type { DrawGeometryType, DrawStyleSettings } from '@shared/types'
// 仅类型引用（layerEditStore 不反向依赖本文件，无循环）：装饰图层工作集要素与编辑要素同构
import type { EditFeature } from './layerEditStore'
import { loadDecorations, saveDecorations } from '../services/decorationStorage'
import { DEFAULT_CESIUM_ION_TOKEN } from '../services/cesiumLoader'
import {
  DEFAULT_TIANDITU_KEY,
  type AmapAnnotations,
  type MapSource,
  type TiandituAnnotations,
} from '../config/mapSources'

/**
 * CesiumJS 建筑（OSM 3D Tiles）着色方式。
 * 控制入口在地图页右键「设置」→ CesiumJS 页签（原为地图右上角悬浮下拉）。
 */
export type CesiumBuildingStyle = 'material' | 'height' | 'hideLow' | 'none'

/**
 * CesiumJS 3D 清晰度档位。控制入口在右键「设置」→ CesiumJS 页签。
 *
 * 3D 底图看起来比 2D 高德卫星糊，主因是渲染管线而非瓦片源（两家都是 256×256、原生 z18）：
 * Cesium 的 `resolutionScale` 默认 1.0，按 **CSS 像素**渲染再被浏览器放大到设备像素，
 * 而 Leaflet 的 `<img>` 瓦片由浏览器按**设备像素**合成。高分屏（DPR>1）下差距明显。
 * 另外 Cesium 按屏幕空间误差选影像层级、且默认开 FXAA，都会再柔化一点。
 *
 * 清晰度与性能直接冲突（分辨率 ×DPR² 的渲染成本），所以交给用户按机器性能取舍。
 */
export type CesiumQuality = 'smooth' | 'balanced' | 'sharp'

export interface CesiumQualityPreset {
  /** resolutionScale 上限（实际取 min(devicePixelRatio, 该值)） */
  maxResolutionScale: number
  /** 抗锯齿后处理（关掉更锐，代价是边缘锯齿） */
  fxaa: boolean
  /** 地形/影像的屏幕空间误差上限（越小越早加载高层级瓦片，越清晰也越吃性能） */
  maximumScreenSpaceError: number
}

/** 档位 → Cesium 参数。smooth 即改造前的默认行为，保证不改默认观感。 */
export const CESIUM_QUALITY_PRESETS: Record<CesiumQuality, CesiumQualityPreset> = {
  smooth: { maxResolutionScale: 1, fxaa: true, maximumScreenSpaceError: 2 },
  balanced: { maxResolutionScale: 1.5, fxaa: false, maximumScreenSpaceError: 1.5 },
  sharp: { maxResolutionScale: 2, fxaa: false, maximumScreenSpaceError: 1 },
}

/**
 * 定位点接口
 */
export interface LocationPoint {
  id: string
  lng: number
  lat: number
  label?: string  // 用户自定义标签名称
  createdAt?: number  // 创建时间戳
}

/**
 * 图例浮窗的布局（专题/热力图各一份，按用户持久化）
 * - x/y 为相对地图容器左上角的像素位置；未设置时沿用默认锚点（专题右上、热力右下）
 * - width/height 未设置时按内容自适应
 */
export interface LegendLayout {
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface UserMapSettings {
  // 图层可见性
  layerVisibility: { lte: boolean; nr: boolean }
  // 图层文件可见性（MapInfo 文件 / Excel 点文件）
  layerFileVisibility: Record<string, boolean>
  pointFileVisibility: Record<string, boolean>
  // 装饰图层标签可见性（装饰图层本身恒显、不可关闭）
  decorationLabelVisible: boolean
  // 扇区标签可见性
  sectorLabelVisibility: Record<string, boolean>
  // 点文件标签可见性
  pointFileLabelVisibility: Record<string, boolean>
  // 图层文件(MapInfo)标签可见性
  layerFileLabelVisibility: Record<string, boolean>
  /**
   * 地图源（唯一真源）：高德矢量/卫星、天地图矢量/卫星、3D（CesiumJS）、空地图。
   * 由工具栏「地图切换」下拉切换；设置框只配置各引擎的 Key/Token，不切图。
   */
  mapSource: MapSource
  // 高德地图 API Key（高德瓦片默认免 key，留空即可，可填自己的）
  amapApiKey: string
  // 天地图 Key（出厂带默认值，UI 脱敏、可更换）
  tiandituApiKey: string
  // 天地图注记图层显隐（矢量注记 cva / 影像注记 cia / 地形注记 cta）
  tiandituAnnotations: TiandituAnnotations
  // 高德注记叠加层显隐（矢量注记 / 影像注记）。
  // 高德卫星影像本身不含注记，影像注记层是"卫星图有地名"的唯一来源。
  amapAnnotations: AmapAnnotations
  // Cesium ion Access Token（出厂带默认值，UI 脱敏、可更换）
  cesiumIonToken: string
  // CesiumJS 场景注记显隐（三维地名 eva）
  cesiumAnnotations: { placeName: boolean }
  /** CesiumJS 建筑样式：按材料着色 / 按高度着色 / 隐藏 20m 以下 / 默认 */
  cesiumBuildingStyle: CesiumBuildingStyle
  /** CesiumJS 3D 清晰度档位 */
  cesiumQuality: CesiumQuality
  // 标签设置（按图层ID）
  labelSettingsMap: Record<string, LabelSettings>
  // 图层颜色设置（按图层ID）
  colorSettingsMap: Record<string, LayerColorSettings>
  // 新建/绘制图层的点线面样式（按几何类型 point/line/polygon）
  drawStyleMap: Partial<Record<DrawGeometryType, DrawStyleSettings>>
  // 专题图层设置（按图层ID）
  thematicSettingsMap: Record<string, ThematicSettings>
  // 热力图设置（按图层ID）
  heatmapSettingsMap: Record<string, HeatmapSettings>
  // 专题区间配色模板列表
  thematicTemplates: ThematicTemplate[]
  // 热力图设置模板列表
  heatmapTemplates: HeatmapTemplate[]
  // 频点自定义配色（key: `${networkType}:${frequency}`）
  frequencyCustomColors: Record<string, { color: string; strokeColor: string }>
  // 已加载的数据源ID列表
  loadedWorkbookIds: string[]
  loadedGeoDataIds: string[]
  loadedLayerIds: string[]
  // 全局地图展示控制
  globalShowMap: boolean
  /**
   * 各类别内部图层顺序（控制面板上下拖拽），key=类别，value=图层 id 数组（索引 0 = 面板最上）。
   * 跨类别层级固定：基站 > 图层文件 > 地理化数据 > 装饰图层（见 layerZOrder.ts）。
   * 未收录的图层 id 由运行时按自然顺序追加到底部。
   */
  layerOrder: LayerOrderMap
  /**
   * 图层"可选"开关（控制面板鼠标箭头按钮），key=图层 id。
   * 未收录视为 true；圈选/选择只作用于 z-order 最高且该开关打开的图层。
   */
  selectableMap: Record<string, boolean>
  /**
   * 图例浮窗布局（key: 'thematic' | 'heatmap'），支持拖拽移动/缩放后持久化。
   */
  legendLayout: Record<string, LegendLayout>
}

/** 图层类别（复用 layerZOrder.ts 的 LayerZType，避免双源漂移） */
export type LayerCategory = LayerZType

/** 各类别内部图层面板顺序（图层 id 数组，索引 0 = 最上） */
export type LayerOrderMap = Record<LayerCategory, string[]>

const DEFAULT_MAP_SETTINGS: UserMapSettings = {
  layerVisibility: { lte: true, nr: true },
  layerFileVisibility: {},
  pointFileVisibility: {},
  decorationLabelVisible: false,
  sectorLabelVisibility: { 'lte-sectors': false, 'nr-sectors': false },
  pointFileLabelVisibility: {},
  layerFileLabelVisibility: {},
  // 默认底图取天地图矢量：与高德矢量观感接近，且无需高德 Key 即可出图
  mapSource: 'tdt-vector',
  amapApiKey: '',
  tiandituApiKey: DEFAULT_TIANDITU_KEY,
  tiandituAnnotations: { vector: true, image: true, terrain: true },
  // 影像注记默认开（高德卫星图本身没有注记，不开就是一张"没地名"的影像）；
  // 矢量注记默认关：高德矢量底图已把路网注记烘进底图，叠加只会重复描一遍
  amapAnnotations: { vector: false, image: true },
  cesiumIonToken: DEFAULT_CESIUM_ION_TOKEN,
  cesiumAnnotations: { placeName: true },
  cesiumBuildingStyle: 'material',
  cesiumQuality: 'smooth',
  labelSettingsMap: {},
  colorSettingsMap: {},
  drawStyleMap: {},
  thematicSettingsMap: {},
  heatmapSettingsMap: {},
  thematicTemplates: [],
  heatmapTemplates: [],
  frequencyCustomColors: {},
  loadedWorkbookIds: [],
  loadedGeoDataIds: [],
  loadedLayerIds: [],
  globalShowMap: false,
  layerOrder: {
    sector: ['lte-sectors', 'nr-sectors'],
    mapinfo: [],
    geodata: [],
    decoration: ['decoration-layer'],
  },
  selectableMap: {},
  legendLayout: {},
}

interface MapState {
  locationPoints: LocationPoint[]
  addLocationPoint: (point: LocationPoint) => void
  clearLocationPoints: () => void
  updateLocationPointLabel: (id: string, label: string) => void

  /**
   * 装饰图层要素（用户在装饰图层上绘制/打点的图形，GCJ02）。
   * 顶层字段（同 locationPoints）：进 localStorage、按用户隔离；不进 mapSettings（不落后端）。
   * 编辑期真源是 layerEditStore.workspaces['decoration-layer']，工作集变更后单向回写到这里。
   */
  decorationFeatures: EditFeature[]
  setDecorationFeatures: (features: EditFeature[]) => void
  clearDecorationFeatures: () => void

  // ===== 按用户持久化的地图设置 =====
  mapSettings: UserMapSettings
  setMapSettings: (settings: Partial<UserMapSettings>) => void
  resetMapSettings: () => void

  // 便捷方法
  setLayerVisibility: (lte: boolean, nr: boolean) => void
  setLayerFileVisibility: (fileId: string, visible: boolean) => void
  setPointFileVisibility: (fileId: string, visible: boolean) => void
  setDecorationLabelVisible: (visible: boolean) => void
  setMapSource: (source: MapSource) => void
  /** 天地图注记图层显隐（局部合并） */
  setTiandituAnnotation: (key: keyof TiandituAnnotations, visible: boolean) => void
  setAmapAnnotation: (key: keyof AmapAnnotations, visible: boolean) => void
  /** CesiumJS 场景注记显隐（目前只有三维地名） */
  setCesiumPlaceNameVisible: (visible: boolean) => void
  /** CesiumJS 建筑着色方式 */
  setCesiumBuildingStyle: (style: CesiumBuildingStyle) => void
  /** CesiumJS 3D 清晰度档位 */
  setCesiumQuality: (quality: CesiumQuality) => void
  setSectorLabelVisibility: (layer: string, visible: boolean) => void
  setPointFileLabelVisibility: (fileId: string, visible: boolean) => void
  setLayerFileLabelVisibility: (fileId: string, visible: boolean) => void
  setLabelSettings: (layerId: string, settings: LabelSettings) => void
  setColorSettings: (layerId: string, settings: LayerColorSettings | null) => void
  setDrawStyle: (geomType: DrawGeometryType, settings: DrawStyleSettings) => void
  setThematicSettings: (layerId: string, settings: ThematicSettings | null) => void
  setHeatmapSettings: (layerId: string, settings: HeatmapSettings | null) => void
  setThematicTemplates: (templates: ThematicTemplate[]) => void
  setHeatmapTemplates: (templates: HeatmapTemplate[]) => void
  setFrequencyCustomColors: (colors: Record<string, { color: string; strokeColor: string }>) => void
  setLoadedWorkbookIds: (ids: string[]) => void
  setLoadedGeoDataIds: (ids: string[]) => void
  setLoadedLayerIds: (ids: string[]) => void
  setGlobalShowMap: (show: boolean) => void
  /** 更新某个类别内部的图层顺序（拖拽排序后调用） */
  setLayerOrder: (category: LayerCategory, orderedIds: string[]) => void
  /** 设置某图层"可选"开关（鼠标箭头按钮） */
  setLayerSelectable: (layerId: string, selectable: boolean) => void
  /** 设置图例浮窗布局（拖拽/缩放后调用；null 恢复默认锚点） */
  setLegendLayout: (key: string, layout: LegendLayout | null) => void

  // 后端同步
  _syncToBackend: () => Promise<void>
  _syncFromBackend: () => Promise<boolean>
  /**
   * 最后一次与服务端一致的设置 JSON 快照（持久化）。
   * 与当前 mapSettings 不一致即表示本地有未同步成功的改动，
   * 登录恢复时优先保留本地并回推，避免被服务端旧数据回退。
   */
  _lastSyncSettings: string
}

/**
 * 根据当前登录用户获取 localStorage key
 * 未登录使用 "map-settings-anonymous"
 */
function getStorageKey(): string {
  try {
    const stored = localStorage.getItem('auth-storage')
    if (stored) {
      const parsed = JSON.parse(stored)
      const user = parsed?.state?.user
      if (user?.id) {
        return `map-settings-user-${user.id}`
      }
    }
  } catch { /* ignore */ }
  return 'map-settings-anonymous'
}

/** 基站（扇区）图层"默认设置"旧默认值：图形透明度 60% / 边框宽度 2px */
const LEGACY_SECTOR_COLOR_DEFAULTS = { fillOpacity: 0.6, borderWidth: 2 }
/** 基站（扇区）图层"默认设置"新默认值：图形透明度 100% / 边框宽度 1px（与 SECTOR_CONFIG 一致） */
const SECTOR_COLOR_DEFAULTS = { fillOpacity: 1, borderWidth: 1 }

/**
 * 基站图层默认设置迁移：把仍是旧默认值（60% / 2px）的已保存条目升级为新默认值（100% / 1px）。
 * 用户在旧版本打开弹窗点过保存后会把旧默认值写进 colorSettingsMap，若不迁移，
 * 这些图层会一直按旧默认渲染、弹窗也显示旧值，新默认对老账号不生效。
 * 只精确匹配旧默认值，用户自定义过的值不受影响。
 */
function migrateSectorColorDefaults(settings: UserMapSettings): UserMapSettings {
  const colorMap = settings.colorSettingsMap
  if (!colorMap) return settings
  let changed = false
  const next = { ...colorMap }
  for (const id of ['lte-sectors', 'nr-sectors']) {
    const entry = next[id]
    if (!entry) continue
    if (entry.fillOpacity === LEGACY_SECTOR_COLOR_DEFAULTS.fillOpacity
      && entry.borderWidth === LEGACY_SECTOR_COLOR_DEFAULTS.borderWidth) {
      next[id] = { ...entry, ...SECTOR_COLOR_DEFAULTS }
      changed = true
    }
  }
  return changed ? { ...settings, colorSettingsMap: next } : settings
}

/**
 * 地图源迁移：旧版本用 `mapType`（roadmap/satellite）+ `mapProvider`（amap/cesium）
 * + `baseMapVisible` 三个字段描述底图，新版收敛为单一 `mapSource`。
 * 已存在 `mapSource` 的（新版）原样返回。
 */
function migrateMapSource<T extends Record<string, unknown>>(settings: T): T {
  if (settings.mapSource) return settings
  const legacy = settings as Record<string, unknown>
  let source: MapSource = 'amap-vector'
  if (legacy.mapProvider === 'cesium') source = 'cesium'
  else if (legacy.baseMapVisible === false) source = 'none'
  else if (legacy.mapType === 'satellite') source = 'amap-satellite'
  return { ...settings, mapSource: source }
}

/** 热力图 v3 的旧默认值：v3→v4 时仍是这些值的字段升到新默认（用户改过的值保持，见下） */
const LEGACY_HEATMAP_DEFAULTS = { smooth: 2, sampling: 1, contrast: 0.5, concentration: 1 }

/**
 * 热力图设置迁移（smoothVersion < 当前版本）。
 *
 * **旧版语义修复（无标记条目）**：
 * 旧版 smooth 只参与粗网格半径（`globalR = smooth × 点间距`），而 detail≈95 时细节场
 * 占 95%，细节核半径只由「栅格采样」决定 → 旧 smooth 对渲染**完全无效**
 * （实测 smooth=3/5/9 渲染逐像素相同）。新版 smooth 真正决定细节核宽度，同一数值
 * 会显著改变高值扩散范围，而旧值不携带任何用户意图 → 无版本标记的一律归到新默认，
 * 否则老图层会一直按旧默认 9（≈6.8×点距，比修复前更糊）渲染，用户以为修复没生效。
 *
 * 旧版 sampling 是「细节斑点大小」的倍数（`核半径 = 1.5×点间距×sampling`），新版是
 * 「采样网格边长」的倍数，同一数值含义不同：旧值 24 在新版下让网格粗到 18×点间距，
 * 细节场直接失去意义（用户实测"高值扩散成一大片"）。故同样归一到新默认。
 *
 * **v3 → v4 默认值调整**：平滑强度/栅格采样/对比度/高值集中度换新默认。与基站图层
 * 默认值迁移同理——用户点过保存后旧默认值会写进条目，若不迁移，弹窗与地图都还显示/按
 * 旧默认走，新默认对已保存条目不生效。只精确匹配旧默认值，用户自定义过的值不受影响。
 * 模板同规则迁移。
 */
export function migrateHeatmapSmooth<T extends {
  heatmapSettingsMap?: Record<string, HeatmapSettings>
  heatmapTemplates?: HeatmapTemplate[]
}>(settings: T): T {
  const remap = <T extends {
    smooth?: number; sampling?: number; smoothVersion?: number
    contrast?: number; concentration?: number
    discrete?: boolean; levelSoftness?: number
  }>(entry: T): T => {
    const v = entry.smoothVersion
    if (v === HEATMAP_SETTINGS_VERSION) return entry
    const out = { ...entry }
    // 旧版（无标记）：smooth/sampling 归一（见上）
    if (v === undefined) {
      out.smooth = DEFAULT_HEATMAP_SETTINGS.smooth
      out.sampling = DEFAULT_HEATMAP_SETTINGS.sampling
    } else if (v === 3) {
      // v3 → v4：仅换默认值的字段，命中旧默认才升级
      if (out.smooth === LEGACY_HEATMAP_DEFAULTS.smooth) out.smooth = DEFAULT_HEATMAP_SETTINGS.smooth
      if (out.sampling === LEGACY_HEATMAP_DEFAULTS.sampling) out.sampling = DEFAULT_HEATMAP_SETTINGS.sampling
      if (out.contrast === LEGACY_HEATMAP_DEFAULTS.contrast) out.contrast = DEFAULT_HEATMAP_SETTINGS.contrast
      if (out.concentration === LEGACY_HEATMAP_DEFAULTS.concentration) out.concentration = DEFAULT_HEATMAP_SETTINGS.concentration
    }
    // discrete 保留原值（默认 false=连续渐变；用户可在设置里主动开启分级）
    out.discrete = entry.discrete ?? false
    out.levelSoftness = entry.levelSoftness ?? DEFAULT_HEATMAP_SETTINGS.levelSoftness
    out.smoothVersion = HEATMAP_SETTINGS_VERSION
    return out
  }
  let changed = false
  const heatMap = settings.heatmapSettingsMap
  const nextHeat: Record<string, HeatmapSettings> = {}
  if (heatMap) {
    for (const [id, entry] of Object.entries(heatMap)) {
      const mapped = remap(entry)
      if (mapped !== entry) changed = true
      nextHeat[id] = mapped
    }
  }
  const nextTemplates = settings.heatmapTemplates?.map((tmpl) => {
    const mapped = remap(tmpl.settings)
    if (mapped === tmpl.settings) return tmpl
    changed = true
    return { ...tmpl, settings: mapped }
  })
  if (!changed) return settings
  return {
    ...settings,
    ...(heatMap ? { heatmapSettingsMap: nextHeat } : {}),
    ...(nextTemplates ? { heatmapTemplates: nextTemplates } : {}),
  }
}

export const useMapStore = create<MapState>()(
  persist(
    (set, get) => ({
      locationPoints: [],
      addLocationPoint: (point) => {
        set((state) => ({
          locationPoints: [...state.locationPoints, point]
        }))
      },
      clearLocationPoints: () => {
        set({ locationPoints: [] })
      },
      updateLocationPointLabel: (id: string, label: string) => {
        set((state) => ({
          locationPoints: state.locationPoints.map(p =>
            p.id === id ? { ...p, label } : p
          )
        }))
      },

      decorationFeatures: [],
      setDecorationFeatures: (features) => {
        set({ decorationFeatures: features })
        // 防抖写入 IndexedDB（高频编辑不逐次写盘）
        if (_decoSaveTimer) clearTimeout(_decoSaveTimer)
        _decoSaveTimer = setTimeout(() => {
          _decoSaveTimer = null
          saveDecorations(getStorageKey(), features).catch((e) =>
            console.error('[DecorationStorage] 保存失败:', e))
        }, 500)
      },
      clearDecorationFeatures: () => {
        set({ decorationFeatures: [] })
      },

      // ===== 按用户持久化的地图设置 =====
      mapSettings: { ...DEFAULT_MAP_SETTINGS },

      setMapSettings: (partial) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, ...partial },
        }))
        // 异步同步到后端（节流）
        scheduleBackendSync(get())
      },

      resetMapSettings: () => {
        set({ mapSettings: { ...DEFAULT_MAP_SETTINGS } })
        scheduleBackendSync(get())
      },

      setLayerVisibility: (lte, nr) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, layerVisibility: { lte, nr } },
        }))
        scheduleBackendSync(get())
      },

      setLayerFileVisibility: (fileId, visible) => {
        set((state) => ({
          mapSettings: {
            ...state.mapSettings,
            layerFileVisibility: { ...state.mapSettings.layerFileVisibility, [fileId]: visible },
          },
        }))
        scheduleBackendSync(get())
      },

      setPointFileVisibility: (fileId, visible) => {
        set((state) => ({
          mapSettings: {
            ...state.mapSettings,
            pointFileVisibility: { ...state.mapSettings.pointFileVisibility, [fileId]: visible },
          },
        }))
        scheduleBackendSync(get())
      },

      setDecorationLabelVisible: (visible) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, decorationLabelVisible: visible },
        }))
        scheduleBackendSync(get())
      },

      setMapSource: (source) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, mapSource: source },
        }))
        scheduleBackendSync(get())
      },

      setTiandituAnnotation: (key, visible) => {
        set((state) => ({
          mapSettings: {
            ...state.mapSettings,
            tiandituAnnotations: { ...state.mapSettings.tiandituAnnotations, [key]: visible },
          },
        }))
        scheduleBackendSync(get())
      },

      setAmapAnnotation: (key, visible) => {
        set((state) => ({
          mapSettings: {
            ...state.mapSettings,
            amapAnnotations: { ...state.mapSettings.amapAnnotations, [key]: visible },
          },
        }))
        scheduleBackendSync(get())
      },

      setCesiumBuildingStyle: (style) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, cesiumBuildingStyle: style },
        }))
        scheduleBackendSync(get())
      },

      setCesiumQuality: (quality) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, cesiumQuality: quality },
        }))
        scheduleBackendSync(get())
      },

      setCesiumPlaceNameVisible: (visible) => {
        set((state) => ({
          mapSettings: {
            ...state.mapSettings,
            cesiumAnnotations: { ...state.mapSettings.cesiumAnnotations, placeName: visible },
          },
        }))
        scheduleBackendSync(get())
      },

      setSectorLabelVisibility: (layer, visible) => {
        set((state) => ({
          mapSettings: {
            ...state.mapSettings,
            sectorLabelVisibility: { ...state.mapSettings.sectorLabelVisibility, [layer]: visible },
          },
        }))
        scheduleBackendSync(get())
      },

      setPointFileLabelVisibility: (fileId, visible) => {
        set((state) => ({
          mapSettings: {
            ...state.mapSettings,
            pointFileLabelVisibility: { ...state.mapSettings.pointFileLabelVisibility, [fileId]: visible },
          },
        }))
        scheduleBackendSync(get())
      },

      setLayerFileLabelVisibility: (fileId, visible) => {
        set((state) => ({
          mapSettings: {
            ...state.mapSettings,
            layerFileLabelVisibility: { ...state.mapSettings.layerFileLabelVisibility, [fileId]: visible },
          },
        }))
        scheduleBackendSync(get())
      },


      setLabelSettings: (layerId, settings) => {
        set((state) => ({
          mapSettings: {
            ...state.mapSettings,
            labelSettingsMap: { ...state.mapSettings.labelSettingsMap, [layerId]: settings },
          },
        }))
        scheduleBackendSync(get())
      },

      setColorSettings: (layerId, settings) => {
        set((state) => {
          const next = { ...state.mapSettings.colorSettingsMap }
          if (settings === null) {
            delete next[layerId]
          } else {
            next[layerId] = settings
          }
          return {
            mapSettings: { ...state.mapSettings, colorSettingsMap: next },
          }
        })
        scheduleBackendSync(get())
      },

      setDrawStyle: (geomType, settings) => {
        set((state) => ({
          mapSettings: {
            ...state.mapSettings,
            drawStyleMap: { ...state.mapSettings.drawStyleMap, [geomType]: settings },
          },
        }))
        scheduleBackendSync(get())
      },

      setThematicSettings: (layerId, settings) => {
        set((state) => {
          const next = { ...state.mapSettings.thematicSettingsMap }
          if (settings === null) {
            delete next[layerId]
          } else {
            next[layerId] = settings
          }
          return {
            mapSettings: { ...state.mapSettings, thematicSettingsMap: next },
          }
        })
        scheduleBackendSync(get())
      },

      setHeatmapSettings: (layerId, settings) => {
        set((state) => {
          const next = { ...state.mapSettings.heatmapSettingsMap }
          if (settings === null) {
            delete next[layerId]
          } else {
            next[layerId] = settings
          }
          return {
            mapSettings: { ...state.mapSettings, heatmapSettingsMap: next },
          }
        })
        scheduleBackendSync(get())
      },

      setThematicTemplates: (templates) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, thematicTemplates: templates },
        }))
        scheduleBackendSync(get())
      },

      setHeatmapTemplates: (templates) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, heatmapTemplates: templates },
        }))
        scheduleBackendSync(get())
      },

      setFrequencyCustomColors: (colors) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, frequencyCustomColors: colors },
        }))
        scheduleBackendSync(get())
      },

      setLoadedWorkbookIds: (ids) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, loadedWorkbookIds: ids },
        }))
        scheduleBackendSync(get())
      },

      setLoadedGeoDataIds: (ids) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, loadedGeoDataIds: ids },
        }))
        scheduleBackendSync(get())
      },

      setLoadedLayerIds: (ids) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, loadedLayerIds: ids },
        }))
        scheduleBackendSync(get())
      },

      setGlobalShowMap: (show) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, globalShowMap: show },
        }))
        scheduleBackendSync(get())
      },

      setLayerOrder: (category, orderedIds) => {
        set((state) => ({
          mapSettings: {
            ...state.mapSettings,
            layerOrder: { ...state.mapSettings.layerOrder, [category]: orderedIds },
          },
        }))
        scheduleBackendSync(get())
      },

      setLayerSelectable: (layerId, selectable) => {
        set((state) => ({
          mapSettings: {
            ...state.mapSettings,
            selectableMap: { ...state.mapSettings.selectableMap, [layerId]: selectable },
          },
        }))
        scheduleBackendSync(get())
      },

      setLegendLayout: (key, layout) => {
        set((state) => {
          const next = { ...state.mapSettings.legendLayout }
          if (layout === null) {
            delete next[key]
          } else {
            next[key] = layout
          }
          return { mapSettings: { ...state.mapSettings, legendLayout: next } }
        })
        scheduleBackendSync(get())
      },

      // ===== 后端同步 =====
      _lastSyncSettings: '',

      _syncToBackend: async () => {
        try {
          const settings = get().mapSettings
          const json = stableStringify(settings)
          await userSettingsApi.updateSettings(settings as any)
          set({ _lastSyncSettings: json })
          console.log('[mapStore] 已同步设置到后端')
        } catch (err: any) {
          // 静默失败（如未登录、网络错误），localStorage 仍保留
          if (err?.code !== 401) {
            console.warn('[mapStore] 同步设置到后端失败:', err?.message)
          }
        }
      },

      _syncFromBackend: async () => {
        try {
          const res = await userSettingsApi.getSettings()
          if (res.success && res.data?.settings && Object.keys(res.data.settings).length > 0) {
            const serverSettings = res.data.settings as Partial<UserMapSettings>
            const current = get()
            // 本地存在未同步成功的改动（如退出前 3 秒防抖未落地/同步失败）时，
            // 不用服务端旧数据覆盖本地，改为把本地改动推回服务端
            const hasUnsyncedLocal = current._lastSyncSettings !== ''
              && current._lastSyncSettings !== stableStringify(current.mapSettings)
            if (hasUnsyncedLocal) {
              console.log('[mapStore] 本地存在未同步设置，跳过服务端覆盖并回推')
              scheduleBackendSync(current)
              return true
            }
            // 服务端可能还是旧格式（mapType/mapProvider/baseMapVisible），先迁移再合并，
            // 否则会把本地 mapSource 之外的旧字段一起带进来、且丢掉服务端的引擎选择
            const serverHasLegacyMapFields =
              'mapType' in serverSettings || 'mapProvider' in serverSettings
              || 'baseMapVisible' in serverSettings
            const serverMapSettings = serverHasLegacyMapFields
              ? migrateMapSource(serverSettings as Record<string, unknown>) as Partial<UserMapSettings>
              : serverSettings
            set((state) => {
              const merged = migrateHeatmapSmooth(migrateSectorColorDefaults({
                ...state.mapSettings,
                ...serverMapSettings,
                tiandituAnnotations: {
                  ...state.mapSettings.tiandituAnnotations,
                  ...serverMapSettings.tiandituAnnotations,
                },
                amapAnnotations: {
                  ...state.mapSettings.amapAnnotations,
                  ...serverMapSettings.amapAnnotations,
                },
                cesiumAnnotations: {
                  ...state.mapSettings.cesiumAnnotations,
                  ...serverMapSettings.cesiumAnnotations,
                },
                cesiumBuildingStyle:
                  serverMapSettings.cesiumBuildingStyle ?? state.mapSettings.cesiumBuildingStyle,
                cesiumQuality:
                  serverMapSettings.cesiumQuality ?? state.mapSettings.cesiumQuality,
              }))
              return {
                mapSettings: merged,
                _lastSyncSettings: stableStringify(merged),
              }
            })
            console.log('[mapStore] 已从后端加载设置')
            return true
          }
        } catch {
          // 静默失败
        }
        return false
      },
    }),
    {
      name: getStorageKey(), // 初始 key，在 rehydrate 后会动态更新
      partialize: (state) => ({
        locationPoints: state.locationPoints,
        // decorationFeatures 改存 IndexedDB（可能超 localStorage 5MB 限额），不在此持久化
        _lastSyncSettings: state._lastSyncSettings,
        mapSettings: {
          ...state.mapSettings,
          // 不保存 loaded*Ids 到 localStorage（它们来自动态数据）
          loadedWorkbookIds: state.mapSettings.loadedWorkbookIds,
          loadedGeoDataIds: state.mapSettings.loadedGeoDataIds,
          loadedLayerIds: state.mapSettings.loadedLayerIds,
          labelSettingsMap: state.mapSettings.labelSettingsMap,
          colorSettingsMap: state.mapSettings.colorSettingsMap,
          drawStyleMap: state.mapSettings.drawStyleMap,
          thematicSettingsMap: state.mapSettings.thematicSettingsMap,
          heatmapSettingsMap: state.mapSettings.heatmapSettingsMap,
          thematicTemplates: state.mapSettings.thematicTemplates,
          heatmapTemplates: state.mapSettings.heatmapTemplates,
          frequencyCustomColors: state.mapSettings.frequencyCustomColors,
        },
      }),
      // 兼容旧版本持久化数据：rehydrate 时保证新增字段始终存在，
      // 否则旧 localStorage 中缺 key 的 mapSettings 会整体覆盖默认值，导致 colorSettingsMap 为 undefined
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<MapState> | undefined
        const persistedSettings = persisted?.mapSettings
        // _lastSyncSettings 是迁移前的快照：不同步迁移会让 hasUnsyncedLocal 误判为真，
        // 从而跳过服务端设置覆盖并把本地设置回推（可能覆盖其它设备上更新的设置）
        let lastSyncSettings = persisted?._lastSyncSettings ?? ''
        if (lastSyncSettings) {
          try {
            lastSyncSettings = stableStringify(migrateHeatmapSmooth(JSON.parse(lastSyncSettings)))
          } catch {
            // 解析失败保持原值，退回原行为
          }
        }
        return {
          ...currentState,
          ...persisted,
          // 缺省即空数组：不能沿用 currentState（切换用户 rehydrate 时会把上一用户的装饰要素带过来）
          decorationFeatures: persisted?.decorationFeatures ?? [],
          _lastSyncSettings: lastSyncSettings,
          mapSettings: migrateHeatmapSmooth(migrateSectorColorDefaults(migrateMapSource({
            ...currentState.mapSettings,
            ...persistedSettings,
            tiandituAnnotations: {
              ...currentState.mapSettings.tiandituAnnotations,
              ...persistedSettings?.tiandituAnnotations,
            },
            amapAnnotations: {
              ...currentState.mapSettings.amapAnnotations,
              ...persistedSettings?.amapAnnotations,
            },
            cesiumAnnotations: {
              ...currentState.mapSettings.cesiumAnnotations,
              ...persistedSettings?.cesiumAnnotations,
            },
            cesiumBuildingStyle:
              persistedSettings?.cesiumBuildingStyle ?? currentState.mapSettings.cesiumBuildingStyle,
            cesiumQuality:
              persistedSettings?.cesiumQuality ?? currentState.mapSettings.cesiumQuality,
            colorSettingsMap: persistedSettings?.colorSettingsMap ?? {},
            drawStyleMap: persistedSettings?.drawStyleMap ?? {},
            labelSettingsMap: persistedSettings?.labelSettingsMap ?? {},
            thematicSettingsMap: persistedSettings?.thematicSettingsMap ?? {},
            heatmapSettingsMap: persistedSettings?.heatmapSettingsMap ?? {},
            thematicTemplates: persistedSettings?.thematicTemplates ?? [],
            heatmapTemplates: persistedSettings?.heatmapTemplates ?? [],
            frequencyCustomColors: persistedSettings?.frequencyCustomColors ?? {},
            layerOrder: {
              sector: persistedSettings?.layerOrder?.sector ?? currentState.mapSettings.layerOrder.sector,
              mapinfo: persistedSettings?.layerOrder?.mapinfo ?? [],
              geodata: persistedSettings?.layerOrder?.geodata ?? [],
              decoration: persistedSettings?.layerOrder?.decoration ?? currentState.mapSettings.layerOrder.decoration,
            },
            selectableMap: persistedSettings?.selectableMap ?? {},
            legendLayout: persistedSettings?.legendLayout ?? {},
          }))),
        }
      },
    }
  )
)

/**
 * 稳定的 JSON 序列化（对象 key 排序）：用于比较 mapSettings 是否与上次同步一致，
 * 避免因 key 顺序差异（版本升级新增字段等）误判为"本地有未同步改动"
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

// ===== 后端同步节流 =====
let _syncTimer: ReturnType<typeof setTimeout> | null = null
function scheduleBackendSync(state: MapState) {
  if (_syncTimer) clearTimeout(_syncTimer)
  _syncTimer = setTimeout(() => {
    _syncTimer = null
    state._syncToBackend()
  }, 3000) // 3秒防抖
}

/** 装饰要素 IndexedDB 防抖保存计时器 */
let _decoSaveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 加载指定 key 的装饰要素：IndexedDB 为主；为空时回退旧 localStorage
 * 中的数据并自动迁移到 IndexedDB。
 */
export async function loadUserDecorations(key: string): Promise<EditFeature[]> {
  const stored = await loadDecorations(key)
  if (stored.length > 0) return stored
  const legacy = readPersistedDecorationFeatures(key)
  if (legacy.length > 0) {
    saveDecorations(key, legacy).catch(() => {})
  }
  return legacy
}

/** 读取指定 localStorage key 下已持久化的装饰图层要素（无数据返回空数组） */
function readPersistedDecorationFeatures(key: string): EditFeature[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const features = parsed?.state?.decorationFeatures
    return Array.isArray(features) ? features : []
  } catch {
    return []
  }
}

/** 读取指定 localStorage key 下已持久化的 mapSettings（无数据返回 null） */
function readPersistedMapSettings(key: string): Partial<UserMapSettings> | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const settings = parsed?.state?.mapSettings
    return settings && typeof settings === 'object' ? settings : null
  } catch {
    return null
  }
}

/**
 * 当用户登录状态变化时调用，重新加载用户设置
 * - 在 authStore 的 login/logout 完成后调用
 * - 先把 persist key 切换到当前用户的专用 key，再恢复该用户的设置
 *
 * 说明：zustand persist 的 name 只在 store 创建时计算一次，登录/退出后必须
 * 显式 setOptions 切换，否则写入会落在旧 key 上（下次登录读不到本地设置，
 * 退出时的重置还会把默认值写回上一用户的数据里）。
 */
export async function reloadUserMapSettings(): Promise<void> {
  // 清除待执行的防抖同步，避免切换用户后再把旧用户的设置写入/覆盖
  if (_syncTimer) {
    clearTimeout(_syncTimer)
    _syncTimer = null
  }

  const key = getStorageKey()
  // 该用户在本机是否已有自己的设置快照 —— 必须在**任何 set 之前**判断。
  // persist 包装过的 setState 会立刻把当前内存态（可能还是上一账号/匿名会话的）写进新 key，
  // 之后再读必然非空，"本地与服务端都没有 → 用默认值"的兜底就永远不生效
  // （表现为：刚注册的用户继承了上一个账号的底图，默认天地图矢量图不生效）。
  const hadPersistedSettings = readPersistedMapSettings(key) !== null
  if (useMapStore.persist.getOptions().name !== key) {
    useMapStore.persist.setOptions({ name: key })
  }

  if (key === 'map-settings-anonymous') {
    // 退出登录：切换到匿名视图，不把上一用户的地图设置留在内存，
    // 同时保证重置只写入匿名 key，不破坏该用户自己的本地数据。
    const local = readPersistedMapSettings(key)
    const decoFeatures = await loadUserDecorations(key)
    useMapStore.setState({
      mapSettings: local ? { ...DEFAULT_MAP_SETTINGS, ...local } : { ...DEFAULT_MAP_SETTINGS },
      // 装饰要素与定位点同属用户私有数据：按 key 从 IndexedDB 恢复（匿名时为匿名数据）
      decorationFeatures: decoFeatures,
      // 同步快照一并清空：否则匿名态的修改会被误判为"未同步改动"回推给下一个登录用户
      _lastSyncSettings: '',
    })
    return
  }

  // 登录：先用该用户本地持久化数据恢复（后端不可用时也能保住配置），再合并服务端设置。
  await useMapStore.persist.rehydrate()
  const loaded = await useMapStore.getState()._syncFromBackend()
  // 装饰要素改存 IndexedDB，rehydrate 不携带：显式按 key 恢复。
  // IndexedDB 不可用（隐私模式/被禁用）时不阻断后面的默认值兜底。
  let decoFeatures: EditFeature[] = []
  try {
    decoFeatures = await loadUserDecorations(key)
  } catch { /* 装饰要素读取失败非关键 */ }
  useMapStore.setState({ decorationFeatures: decoFeatures })
  // 本地与服务端都没有该用户的设置时才用默认值（避免把上一个账号/匿名会话的设置带到新用户）。
  // 用 hadPersistedSettings（进入本函数时的快照）而不是此刻再读 localStorage：
  // 上面的 setState 已经把内存态写进新 key 了。
  if (!loaded && !hadPersistedSettings) {
    useMapStore.setState({
      mapSettings: { ...DEFAULT_MAP_SETTINGS },
      _lastSyncSettings: '',
    })
  }
}

/**
 * 获取当前用户的存储 key（用于外部判断 localStorage 是否切换）
 */
export function getCurrentMapStorageKey(): string {
  return getStorageKey()
}
