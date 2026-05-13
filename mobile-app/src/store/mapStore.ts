import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GpsSignalInfo } from '../services/navigationService';

export interface SectorData {
  id: string;
  name: string;
  siteId?: string;
  sectorId?: string;
  latitude: number;
  longitude: number;
  networkType: 'LTE' | 'NR';
  frequency?: number;
  pci?: number;
  tac?: number;
  azimuth?: number;
  beamwidth?: number;
  height?: number;
  cell_cover_type?: number;
  earfcn?: number;
  ssbFrequency?: number;
  mcc?: string;
  mnc?: string;
  is_shared?: string;
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
}

export const useMapStore = create<MapState>()(
  persist(
    (set) => ({
      backendIp: '',
      backendPort: 8000,
      isConnected: false,
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
    }),
    {
      name: 'map-store-favorites',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ favorites: state.favorites }),
      merge: (persistedState, currentState) => {
        // 只恢复favorites，其他状态保持当前值
        const persisted = persistedState as any;
        return {
          ...currentState,
          favorites: persisted?.favorites || currentState.favorites,
        };
      },
    }
  )
);
