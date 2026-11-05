import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GpsSignalInfo } from '../services/navigationService';
import { CacheMeta } from '../types/data';

export interface SectorData {
  id: string;
  name: string;
  siteName?: string;
  siteId?: string;
  sectorId?: string;
  vendor?: string;
  latitude: number;
  longitude: number;
  networkType: 'LTE' | 'NR';
  frequency?: number;
  pci?: number;
  tac?: number;
  azimuth?: number;
  beamwidth?: number;
  height?: number;
  cell_cover_type?: number | string;
  earfcn?: number;
  ssbFrequency?: number;
  mcc?: string;
  mnc?: string;
  is_shared?: string;
  /** 导入工参文件中未映射到已知字段的原始列数据 */
  extraFields?: Record<string, any>;
}

export interface MarkerPoint {
  id: string;
  lat: number;
  lng: number;
  name: string;
  createdAt: number;
}

export interface MeasurePoint {
  lat: number;
  lng: number;
}

export interface SearchMarker {
  lat: number;
  lng: number;
  name: string;
}

/** 导航轨迹条目（用户记录） */
export interface NavTrackItem {
  id: string;
  startTime: number;
  endTime: number;
  distance: number;       // 米
  duration: number;       // 秒
  startName?: string;
  endName?: string;
}

/** 应用个性化设置（用户设置） */
export interface AppSettings {
  autoSync: boolean;   // 启动时自动同步工参
  ttsEnabled: boolean; // 导航语音播报
}

function calculateTotalDistance(points: MeasurePoint[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += getDistance(points[i].lat, points[i].lng, points[i + 1].lat, points[i + 1].lng);
  }
  return total;
}

function getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c * 1000; // meters
}

interface MapState {
  backendIp: string;
  backendPort: number;
  isConnected: boolean;
  // ===== 登录状态（仅会话级，不持久化）=====
  // 用于全站判断是否登录，未登录时其他 Tab 显示预览但不可操作
  isLoggedIn: boolean;
  currentUser: { id?: string | number; username: string; email?: string; city?: string; operator?: string; user_type?: string; [k: string]: any } | null;
  setLoggedIn: (user: MapState['currentUser']) => void;
  clearLoggedIn: () => void;
  // ===== 地图配置 =====
  mapType: 'roadmap' | 'satellite';
  layers: {
    lte: { visible: boolean };
    nr: { visible: boolean };
  };
  lteSectors: SectorData[];
  nrSectors: SectorData[];
  selectedSector: SectorData | null;
  markers: MarkerPoint[];
  favorites: MarkerPoint[];
  measurePoints: MeasurePoint[];
  measureMode: boolean;
  measureFinished: boolean;
  totalDistance: number | null;
  searchMarker: SearchMarker | null;
  markerMode: boolean;
  coordinateMode: boolean;
  markerCoordinateMode: boolean;
  editingMarker: MarkerPoint | null;
  // 缓存相关状态
  cacheAvailable: boolean;
  cacheUpdatedAt: string | null;
  cacheLoading: boolean;
  addMarker: (lat: number, lng: number, name?: string) => void;
  removeMarker: (id: string) => void;
  clearMarkers: () => void;
  updateMarkerName: (id: string, name: string) => void;
  addFavorite: (marker: MarkerPoint) => void;
  removeFavorite: (id: string) => void;
  clearFavorites: () => void;
  setEditingMarker: (marker: MarkerPoint | null) => void;
  addMeasurePoint: (lat: number, lng: number) => void;
  removeLastMeasurePoint: () => void;
  clearMeasure: () => void;
  toggleMeasureMode: () => void;
  setMeasureMode: (mode: boolean) => void;
  finishMeasure: () => void;
  toggleMarkerMode: () => void;
  setMarkerMode: (mode: boolean) => void;
  setCoordinateMode: (mode: boolean) => void;
  setBackendInfo: (ip: string, port: number) => void;
  setConnected: (connected: boolean) => void;
  setMapType: (type: 'roadmap' | 'satellite') => void;
  toggleLayer: (type: 'lte' | 'nr') => void;
  setSectors: (lte: SectorData[], nr: SectorData[]) => void;
  setSelectedSector: (sector: SectorData | null) => void;
  setSearchMarker: (marker: SearchMarker | null) => void;
  focusLocation: { lat: number; lng: number } | null;
  setFocusLocation: (loc: { lat: number; lng: number } | null) => void;
  // 全局导航触发（从标记列表/收藏页面唤起导航面板）
  pendingNavi: { lat: number; lng: number; name: string } | null;
  setPendingNavi: (navi: { lat: number; lng: number; name: string } | null) => void;
  isNavigating: boolean;
  setIsNavigating: (navigating: boolean) => void;
  navUiHidden: boolean;
  setNavUiHidden: (hidden: boolean) => void;
  gpsSignal: GpsSignalInfo;
  setGpsSignal: (signal: GpsSignalInfo) => void;
  // 深色模式
  darkMode: boolean;
  setDarkMode: (dark: boolean) => void;
  // ===== 用户个性化设置 + 用户记录（与登录状态解耦，退出登录后仍保留）=====
  appSettings: AppSettings;
  setAppSettings: (next: Partial<AppSettings>) => void;
  navTracks: NavTrackItem[];
  addNavTrack: (item: NavTrackItem) => void;
  clearNavTracks: () => void;
  // 缓存相关方法
  setCacheAvailable: (available: boolean) => void;
  setCacheUpdatedAt: (at: string | null) => void;
  setCacheLoading: (loading: boolean) => void;
}

export const useMapStore = create<MapState>()(
  persist(
    (set) => ({
      backendIp: '',
      backendPort: 8000,
      isConnected: false,
      // 登录状态（仅会话内有效，重启 APP 需重新从 AsyncStorage 恢复）
      isLoggedIn: false,
      currentUser: null,
      setLoggedIn: (user) => set({ isLoggedIn: !!user, currentUser: user }),
      clearLoggedIn: () => set({ isLoggedIn: false, currentUser: null }),
      mapType: 'roadmap',
      layers: {
        lte: { visible: false },
        nr: { visible: false },
      },
      lteSectors: [],
      nrSectors: [],
      selectedSector: null,
      markers: [],
      favorites: [],
      measurePoints: [],
      measureMode: false,
      measureFinished: false,
      totalDistance: null,
      searchMarker: null,
      focusLocation: null,
      markerMode: false,
      coordinateMode: false,
      markerCoordinateMode: false,
      editingMarker: null,
      pendingNavi: null,
      isNavigating: false,
      navUiHidden: false,
      gpsSignal: { quality: 'none', accuracy: null, source: 'unknown', lastUpdateTime: 0 },
      // 深色模式
      darkMode: false,
      // 用户个性化设置 + 记录
      appSettings: { autoSync: true, ttsEnabled: true },
      navTracks: [],
      // 缓存状态
      cacheAvailable: false,
      cacheUpdatedAt: null,
      cacheLoading: false,
      addMarker: (lat, lng, name = '') => set((state) => ({
        markers: [...state.markers, { id: `marker-${Date.now()}`, lat, lng, name, createdAt: Date.now() }]
      })),
      removeMarker: (id) => set((state) => ({
        markers: state.markers.filter(m => m.id !== id)
      })),
      clearMarkers: () => set({ markers: [] }),
      updateMarkerName: (id, name) => set((state) => ({
        markers: state.markers.map(m => m.id === id ? { ...m, name } : m),
        favorites: state.favorites.map(m => m.id === id ? { ...m, name } : m),
      })),
      addFavorite: (marker) => set((state) => {
        if (state.favorites.some(f => f.id === marker.id)) return state;
        return { favorites: [...state.favorites, { ...marker, createdAt: Date.now() }] };
      }),
      removeFavorite: (id) => set((state) => ({
        favorites: state.favorites.filter(m => m.id !== id)
      })),
      clearFavorites: () => set({ favorites: [] }),
      setEditingMarker: (marker) => set({ editingMarker: marker }),
      addMeasurePoint: (lat, lng) => set((state) => {
        const newPoints = [...state.measurePoints, { lat, lng }];
        const distance = calculateTotalDistance(newPoints);
        return { measurePoints: newPoints, totalDistance: distance, measureFinished: false };
      }),
      removeLastMeasurePoint: () => set((state) => {
        const newPoints = state.measurePoints.slice(0, -1);
        return { measurePoints: newPoints, totalDistance: newPoints.length > 1 ? calculateTotalDistance(newPoints) : null };
      }),
      clearMeasure: () => set({ measurePoints: [], totalDistance: null, measureFinished: false }),
      toggleMeasureMode: () => set((state) => {
        if (state.isNavigating) {
          return state;
        }
        if (state.markerMode) {
          return { measureMode: true, markerMode: false, measurePoints: [], totalDistance: null, measureFinished: false };
        }
        return { measureMode: !state.measureMode, measurePoints: state.measureMode ? state.measurePoints : [], measureFinished: false };
      }),
      finishMeasure: () => set({ measureMode: false, measureFinished: true }),
      toggleMarkerMode: () => set((state) => {
        if (state.isNavigating) {
          return state;
        }
        const newMarkerMode = !state.markerMode;
        if (state.measureMode && newMarkerMode) {
          return { markerMode: newMarkerMode, measureMode: false, measurePoints: [], totalDistance: null, measureFinished: false };
        }
        return { markerMode: newMarkerMode };
      }),
      setMarkerMode: (mode) => set({ markerMode: mode }),
      setMeasureMode: (mode) => set({ measureMode: mode }),
      setCoordinateMode: (mode) => set({ coordinateMode: mode }),
      setBackendInfo: (ip, port) => set({ backendIp: ip, backendPort: port }),
      setConnected: (connected) => set({ isConnected: connected }),
      setMapType: (type) => set({ mapType: type }),
      toggleLayer: (type) =>
        set((state) => ({
          layers: { ...state.layers, [type]: { visible: !state.layers[type].visible } },
        })),
      setSectors: (lte, nr) => set({ lteSectors: lte, nrSectors: nr }),
      setSelectedSector: (sector) => set({ selectedSector: sector }),
      setSearchMarker: (marker) => set({ searchMarker: marker }),
      setFocusLocation: (loc) => set({ focusLocation: loc }),
      setPendingNavi: (navi) => set({ pendingNavi: navi }),
      setIsNavigating: (navigating) => set({ isNavigating: navigating }),
      setNavUiHidden: (hidden) => set({ navUiHidden: hidden }),
      setGpsSignal: (signal) => set({ gpsSignal: signal }),
      // 深色模式
      setDarkMode: (dark) => set({ darkMode: dark }),
      // 用户个性化设置 + 记录
      setAppSettings: (next) => set((state) => ({ appSettings: { ...state.appSettings, ...next } })),
      addNavTrack: (item) => set((state) => ({ navTracks: [...state.navTracks, item] })),
      clearNavTracks: () => set({ navTracks: [] }),
      // 缓存相关方法
      setCacheAvailable: (available) => set({ cacheAvailable: available }),
      setCacheUpdatedAt: (at) => set({ cacheUpdatedAt: at }),
      setCacheLoading: (loading) => set({ cacheLoading: loading }),
    }),
    {
      name: 'map-store-favorites',
      storage: createJSONStorage(() => AsyncStorage),
      // 持久化用户设置(主题) + 用户记录(收藏、轨迹、个性配置)；
      // 登录状态走 auth 服务,与此处解耦,退出登录不影响这些数据。
      partialize: (state) => ({
        favorites: state.favorites,
        darkMode: state.darkMode,
        appSettings: state.appSettings,
        navTracks: state.navTracks,
      }),
      merge: (persistedState, currentState) => {
        // 恢复持久化的字段,缺失则用当前默认值
        const persisted = persistedState as Partial<MapState> | undefined;
        return {
          ...currentState,
          favorites: persisted?.favorites || currentState.favorites,
          darkMode: persisted?.darkMode ?? currentState.darkMode,
          appSettings: persisted?.appSettings
            ? { ...currentState.appSettings, ...persisted.appSettings }
            : currentState.appSettings,
          navTracks: persisted?.navTracks || currentState.navTracks,
        };
      },
    }
  )
);
