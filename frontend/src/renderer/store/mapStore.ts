import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { LabelSettings, LayerColorSettings, ThematicSettings, ThematicTemplate } from '../components/Map/LabelSettingsModal'
import { userSettingsApi } from '../services/api'

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
  // 专题图层设置（按图层ID）
  thematicSettingsMap: Record<string, ThematicSettings>
  // 专题区间配色模板列表
  thematicTemplates: ThematicTemplate[]
  // 频点自定义配色（key: `${networkType}:${frequency}`）
  frequencyCustomColors: Record<string, { color: string; strokeColor: string }>
  // 已加载的数据源ID列表
  loadedWorkbookIds: string[]
  loadedGeoDataIds: string[]
  loadedLayerIds: string[]
  // 全局地图展示控制
  globalShowMap: boolean
}

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
  thematicSettingsMap: {},
  thematicTemplates: [],
  frequencyCustomColors: {},
  loadedWorkbookIds: [],
  loadedGeoDataIds: [],
  loadedLayerIds: [],
  globalShowMap: false,
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
  setThematicSettings: (layerId: string, settings: ThematicSettings | null) => void
  setThematicTemplates: (templates: ThematicTemplate[]) => void
  setFrequencyCustomColors: (colors: Record<string, { color: string; strokeColor: string }>) => void
  setLoadedWorkbookIds: (ids: string[]) => void
  setLoadedGeoDataIds: (ids: string[]) => void
  setLoadedLayerIds: (ids: string[]) => void
  setGlobalShowMap: (show: boolean) => void

  // 后端同步
  _syncToBackend: () => Promise<void>
  _syncFromBackend: () => Promise<boolean>
  _lastSyncSettings: string  // JSON 快照，用于检测变化
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

      setThematicTemplates: (templates) => {
        set((state) => ({
          mapSettings: { ...state.mapSettings, thematicTemplates: templates },
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

      // ===== 后端同步 =====
      _lastSyncSettings: '',

      _syncToBackend: async () => {
        try {
          const settings = get().mapSettings
          const json = JSON.stringify(settings)
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
            set((state) => ({
              mapSettings: { ...state.mapSettings, ...serverSettings },
              _lastSyncSettings: JSON.stringify(state.mapSettings),
            }))
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
        mapSettings: {
          ...state.mapSettings,
          // 不保存 loaded*Ids 到 localStorage（它们来自动态数据）
          loadedWorkbookIds: state.mapSettings.loadedWorkbookIds,
          loadedGeoDataIds: state.mapSettings.loadedGeoDataIds,
          loadedLayerIds: state.mapSettings.loadedLayerIds,
          labelSettingsMap: state.mapSettings.labelSettingsMap,
          colorSettingsMap: state.mapSettings.colorSettingsMap,
          thematicSettingsMap: state.mapSettings.thematicSettingsMap,
          thematicTemplates: state.mapSettings.thematicTemplates,
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
          mapSettings: {
            ...currentState.mapSettings,
            ...persistedSettings,
            colorSettingsMap: persistedSettings?.colorSettingsMap ?? {},
            labelSettingsMap: persistedSettings?.labelSettingsMap ?? {},
            thematicSettingsMap: persistedSettings?.thematicSettingsMap ?? {},
            thematicTemplates: persistedSettings?.thematicTemplates ?? [],
            frequencyCustomColors: persistedSettings?.frequencyCustomColors ?? {},
          },
        }
      },
    }
  )
)

// ===== 后端同步节流 =====
let _syncTimer: ReturnType<typeof setTimeout> | null = null
function scheduleBackendSync(state: MapState) {
  if (_syncTimer) clearTimeout(_syncTimer)
  _syncTimer = setTimeout(() => {
    _syncTimer = null
    state._syncToBackend()
  }, 3000) // 3秒防抖
}

/**
 * 当用户登录状态变化时调用，重新加载用户设置
 * - 在 authStore 的 login/logout 完成后调用
 * - 会更新 localStorage key 为当前用户的专用 key
 */
export async function reloadUserMapSettings(): Promise<void> {
  const state = useMapStore.getState()

  // 先清除当前定时器
  if (_syncTimer) {
    clearTimeout(_syncTimer)
    _syncTimer = null
  }

  // 尝试从后端加载设置
  const loaded = await state._syncFromBackend()

  if (!loaded) {
    // 后端无该用户设置。仅当 localStorage 也无该用户数据时才重置为默认，
    // 否则保留本地已持久化的设置，避免刷新/后端同步尚未完成时误清空用户配置。
    const key = getStorageKey()
    let hasLocalSettings = false
    try {
      const raw = localStorage.getItem(key)
      if (raw) {
        const parsed = JSON.parse(raw)
        hasLocalSettings = !!parsed?.state?.mapSettings
      }
    } catch { /* ignore */ }
    if (!hasLocalSettings) {
      state.resetMapSettings()
    }
  }
}

/**
 * 获取当前用户的存储 key（用于外部判断 localStorage 是否切换）
 */
export function getCurrentMapStorageKey(): string {
  return getStorageKey()
}
