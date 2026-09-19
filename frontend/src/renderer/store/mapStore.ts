import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { LabelSettings, LayerColorSettings, ThematicSettings, ThematicTemplate, HeatmapSettings, HeatmapTemplate } from '../components/Map/LabelSettingsModal'
import type { LayerZType } from '../components/Map/layerZOrder'
import { userSettingsApi } from '../services/api'
import type { DrawGeometryType, DrawStyleSettings } from '@shared/types'

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
  // 装饰图层
  decorationLayerVisible: boolean
  // 装饰图层标签可见性
  decorationLabelVisible: boolean
  // 底图可见性
  baseMapVisible: boolean
  // 扇区标签可见性
  sectorLabelVisibility: Record<string, boolean>
  // 点文件标签可见性
  pointFileLabelVisibility: Record<string, boolean>
  // 图层文件(MapInfo)标签可见性
  layerFileLabelVisibility: Record<string, boolean>
  // 地图类型
  mapType: 'roadmap' | 'satellite'
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
  decorationLayerVisible: false,
  decorationLabelVisible: false,
  baseMapVisible: true,
  sectorLabelVisibility: { 'lte-sectors': false, 'nr-sectors': false },
  pointFileLabelVisibility: {},
  layerFileLabelVisibility: {},
  mapType: 'roadmap',
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

  // ===== 按用户持久化的地图设置 =====
  mapSettings: UserMapSettings
  setMapSettings: (settings: Partial<UserMapSettings>) => void
  resetMapSettings: () => void

  // 便捷方法
  setLayerVisibility: (lte: boolean, nr: boolean) => void
  setLayerFileVisibility: (fileId: string, visible: boolean) => void
  setPointFileVisibility: (fileId: string, visible: boolean) => void
  setDecorationLayerVisible: (visible: boolean) => void
  setDecorationLabelVisible: (visible: boolean) => void
  setBaseMapVisible: (visible: boolean) => void
  setSectorLabelVisibility: (layer: string, visible: boolean) => void
  setPointFileLabelVisibility: (fileId: string, visible: boolean) => void
  setLayerFileLabelVisibility: (fileId: string, visible: boolean) => void
  setMapType: (type: 'roadmap' | 'satellite') => void
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

      setDecorationLayerVisible: (visible) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, decorationLayerVisible: visible },
        }))
        scheduleBackendSync(get())
      },

      setDecorationLabelVisible: (visible) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, decorationLabelVisible: visible },
        }))
        scheduleBackendSync(get())
      },

      setBaseMapVisible: (visible) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, baseMapVisible: visible },
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

      setMapType: (type) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, mapType: type },
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
            set((state) => {
              const merged = migrateSectorColorDefaults({ ...state.mapSettings, ...serverSettings })
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
        return {
          ...currentState,
          ...persisted,
          mapSettings: migrateSectorColorDefaults({
            ...currentState.mapSettings,
            ...persistedSettings,
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
          }),
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
  if (useMapStore.persist.getOptions().name !== key) {
    useMapStore.persist.setOptions({ name: key })
  }

  if (key === 'map-settings-anonymous') {
    // 退出登录：切换到匿名视图，不把上一用户的地图设置留在内存，
    // 同时保证重置只写入匿名 key，不破坏该用户自己的本地数据。
    const local = readPersistedMapSettings(key)
    useMapStore.setState({
      mapSettings: local ? { ...DEFAULT_MAP_SETTINGS, ...local } : { ...DEFAULT_MAP_SETTINGS },
      // 同步快照一并清空：否则匿名态的修改会被误判为"未同步改动"回推给下一个登录用户
      _lastSyncSettings: '',
    })
    return
  }

  // 登录：先用该用户本地持久化数据恢复（后端不可用时也能保住配置），再合并服务端设置。
  await useMapStore.persist.rehydrate()
  const loaded = await useMapStore.getState()._syncFromBackend()
  // 本地与服务端都没有该用户的设置时才用默认值（避免把上一个匿名会话的设置带到新用户）
  if (!loaded && !readPersistedMapSettings(key)) {
    useMapStore.setState({ mapSettings: { ...DEFAULT_MAP_SETTINGS }, _lastSyncSettings: '' })
  }
}

/**
 * 获取当前用户的存储 key（用于外部判断 localStorage 是否切换）
 */
export function getCurrentMapStorageKey(): string {
  return getStorageKey()
}
