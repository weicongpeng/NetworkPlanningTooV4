// mobile-app/app/(tabs)/index.tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, StyleSheet, Alert, TouchableOpacity, Text,
  Modal, FlatList, Switch, TextInput, Platform, StatusBar as RNStatusBar,
  Appearance
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapViewComponent, { MapViewRef } from '../../src/components/Map/MapView';
import LayerControl from '../../src/components/Map/LayerControl';
import SectorInfoPanel from '../../src/components/Map/SectorInfoPanel';
import SearchBar, { SearchResult } from '../../src/components/Search/SearchBar';
import NavControl from '../../src/components/Navigation/NavControl';
import MarkerList from '../../src/components/Marker/MarkerList';
import MeasureControl from '../../src/components/Measure/MeasureControl';
import NavigationPanel from '../../src/components/Navigation/NavigationPanel';
import { useMapStore, SectorData } from '../../src/store/mapStore';
import { gcj02ToWgs84 } from '../../src/utils/coordinate';
import { apiService } from '../../src/services/api';
import * as FileSystem from 'expo-file-system';
import { cacheService } from '../../src/services/cacheService';
import { wgs84ToGcj02 } from '../../src/utils/coordinate';
import { getCurrentPosition, isNavigating as checkIsNavigating, stopNavigation } from '../../src/services/navigationService';
import * as Location from 'expo-location';
import AuthGuard from '../../src/components/Auth/AuthGuard';

type SearchMode = 'place' | 'parameter' | 'coordinate';

const LIGHT_COLORS = {
  bg: '#f5f5f5', card: '#FFFFFF', cardBorder: '#E5E5E5', divider: '#EEEEEE',
  textPrimary: '#1A1A1A', textSecondary: '#666666', textMuted: '#999999',
  accent: '#007AFF', danger: '#E53935', inputBg: '#f0f0f0',
  overlayBg: 'rgba(0,0,0,0.4)',
} as const;

const DARK_COLORS = {
  bg: '#2B2B2F', card: '#36363A', cardBorder: '#4A4A50', divider: '#424248',
  textPrimary: '#E8E6E3', textSecondary: '#B0AEA8', textMuted: '#8A8880',
  accent: '#7EB6F6', danger: '#F07070', inputBg: '#3A3A3F',
  overlayBg: 'rgba(0,0,0,0.55)',
} as const;

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const darkMode = useMapStore((s) => s.darkMode);
  const COLORS = darkMode ? DARK_COLORS : LIGHT_COLORS;

  useEffect(() => {
    Appearance.setColorScheme(darkMode ? 'dark' : 'light');
  }, [darkMode]);

  const {
    mapType, setMapType, setBackendInfo, setConnected,
    measureMode, measureFinished, addMarker, addMeasurePoint,
    toggleMeasureMode, setMeasureMode, finishMeasure, clearMeasure,
    layers, toggleLayer, lteSectors, nrSectors,
    setSectors, setSelectedSector, selectedSector,
    setSearchMarker, markers, coordinateMode, setCoordinateMode,
    clearMarkers, measurePoints,
    markerMode, toggleMarkerMode, setMarkerMode,
    pendingNavi, setPendingNavi,
    focusLocation, setFocusLocation,
    navUiHidden,
    updateMarkerName, removeMarker,
  } = useMapStore();

  const [selectedLocation, setSelectedLocation] = useState<{
    lat: number; lng: number; name: string;
  } | null>(null);
  const [mapCenter, setMapCenter] = useState<[number, number] | undefined>(undefined);
  const [searchMode, setSearchMode] = useState<SearchMode>('parameter');
  const [overlapSectors, setOverlapSectors] = useState<SectorData[]>([]);
  const [showOverlapModal, setShowOverlapModal] = useState(false);
  const [showSectorMenu, setShowSectorMenu] = useState(false);
  const [sectorMenuPos, setSectorMenuPos] = useState({ x: 0, y: 0 });
  const sectorBtnRef = useRef<View>(null);
  const mapRef = useRef<MapViewRef>(null);

  // 打点重命名弹框状态
  const [showMarkerNameModal, setShowMarkerNameModal] = useState(false);
  const [pendingMarkerCoords, setPendingMarkerCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [pendingMarkerId, setPendingMarkerId] = useState<string | null>(null);
  const [markerNameInput, setMarkerNameInput] = useState('');

  const prevCenterRef = useRef<string | null>(null);
  // 非导航模式下的位置+朝向持续跟踪
  const locationSubRef = useRef<Location.LocationSubscription | null>(null);
  const headingSubRef = useRef<Location.LocationSubscription | null>(null);
  const isTrackingRef = useRef(false);
  const trackedPositionRef = useRef<{ lat: number; lng: number } | null>(null);
  const trackedHeadingRef = useRef<number>(0);
  const [showNaviPanel, setShowNaviPanel] = useState(false);
  // 导航面板显示时隐藏顶部工具栏
  const [showToolbar, setShowToolbar] = useState(true);

  // 当 pendingNavi 被设置时，自动打开导航面板
  useEffect(() => {
    if (pendingNavi) {
      setShowNaviPanel(true);
    }
  }, [pendingNavi]);

  useEffect(() => {
    initializeApp();
    return () => {
      // 组件卸载时停止非导航模式的位置跟踪
      if (locationSubRef.current) {
        locationSubRef.current.remove();
        locationSubRef.current = null;
      }
      if (headingSubRef.current) {
        headingSubRef.current.remove();
        headingSubRef.current = null;
      }
      isTrackingRef.current = false;
    };
  }, []);

  const initializeApp = async () => {
    // 1. 初始化缓存系统
    await cacheService.init();

    // 2. 尝试从缓存加载数据（优先）
    const cachedSectors = await cacheService.getCachedSectors();
    // 检查缓存数据来源：手动上传的文件优先，不应用后端数据覆盖
    const meta = await cacheService.getMeta();
    const isFromPhone = meta?.fullParamsInfo?.fromPhone === true;

    if (cachedSectors) {
      const lte = (cachedSectors.lte || []).map((s: any) => ({
        id: s.id, name: s.name || '未命名', siteName: s.siteName, siteId: s.siteId, sectorId: s.sectorId,
        vendor: s.vendor,
        latitude: s.latitude, longitude: s.longitude, networkType: 'LTE' as const,
        frequency: s.frequency, pci: s.pci, tac: s.tac, azimuth: s.azimuth,
        beamwidth: s.beamwidth, height: s.height, cell_cover_type: s.cell_cover_type,
        earfcn: s.earfcn, ssbFrequency: s.ssbFrequency, mcc: s.mcc, mnc: s.mnc, is_shared: s.is_shared,
        extraFields: s.extraFields,
      }));
      const nr = (cachedSectors.nr || []).map((s: any) => ({
        id: s.id, name: s.name || '未命名', siteName: s.siteName, siteId: s.siteId, sectorId: s.sectorId,
        vendor: s.vendor,
        latitude: s.latitude, longitude: s.longitude, networkType: 'NR' as const,
        frequency: s.frequency, pci: s.pci, tac: s.tac, azimuth: s.azimuth,
        beamwidth: s.beamwidth, height: s.height, cell_cover_type: s.cell_cover_type,
        earfcn: s.earfcn, ssbFrequency: s.ssbFrequency, mcc: s.mcc, mnc: s.mnc, is_shared: s.is_shared,
        extraFields: s.extraFields,
      }));
      setSectors(lte, nr);
      console.log(`[MapScreen] 从缓存加载扇区: LTE=${lte.length}, NR=${nr.length}, 来源=${isFromPhone ? '本地上传' : '后端缓存'}`);
    }

    // 3. 读取"自动同步"开关（关闭后只读本地缓存，不发起远程请求）
    const autoSyncEnabled = useMapStore.getState().appSettings.autoSync;
    if (!autoSyncEnabled) {
      console.log('[MapScreen] 自动同步已关闭，跳过远程同步');
      // 仍探测一次后端可达性，仅更新连接状态供 UI 展示（不下载任何数据）
      try {
        const info = await apiService.getSystemInfo();
        setBackendInfo(info.backend_ip, info.backend_port);
        setConnected(true);
      } catch {
        setConnected(false);
        if (!cachedSectors) {
          Alert.alert('提示', '自动同步已关闭且本地无缓存数据。请在"数据"页面手动加载或打开自动同步。');
        }
      }
      return;
    }

    // 4. 尝试连接后端获取最新数据
    try {
      const info = await apiService.getSystemInfo();
      setBackendInfo(info.backend_ip, info.backend_port);
      setConnected(true);

      // autoSync 开启时：已有工参数据则不覆盖，只有工参数据为空才从后端拉取。
      // 用户手动删除工参缓存后，cachedSectors 为 null，下次启动会自动重新拉取。
      const hasLocalData = cachedSectors &&
        ((cachedSectors.lte && cachedSectors.lte.length > 0) ||
         (cachedSectors.nr && cachedSectors.nr.length > 0));
      if (hasLocalData) {
        console.log('[MapScreen] 本地已有工参数据，跳过后端同步');
      } else {
        await loadSectorsFromBackend();
      }

      // 4. 首次启动自动缓存（手动上传的数据不覆盖）
      const isFirst = await cacheService.isFirstLaunch();
      if (isFirst) {
        console.log('[MapScreen] 首次启动，自动缓存数据...');
        if (isFromPhone) {
          // 手动上传的数据保留，只缓存地理化数据和图层
          await cacheService.cacheGeoDataFromBackend();
          await cacheService.cacheLayersFromBackend();
          console.log('[MapScreen] 首次缓存完成（保留本地上传工参）');
        } else {
          await cacheService.cacheAllFromBackend((msg) => console.log('[AutoCache]', msg));
          console.log('[MapScreen] 首次缓存完成');
        }
        await cacheService.markFirstLaunchDone();
      }
    } catch (error) {
      console.error('Failed to connect to backend:', error);
      setConnected(false);
      if (!cachedSectors) {
        Alert.alert('提示', '无法连接后端且本地无缓存数据。请先在"数据"页面导入数据或连接后端。');
      }
    }
  };

  const loadSectorsFromBackend = async () => {
    try {
      const response = await apiService.getSectors();
      if (response.success && response.data) {
        const rawLte: any[] = response.data.lte || [];
        const rawNr: any[] = response.data.nr || [];

        const lte: SectorData[] = rawLte.map((s: any) => ({
          id: s.id,
          name: s.name || '未命名',
          siteName: s.siteName,
          siteId: s.siteId,
          sectorId: s.sectorId,
          vendor: s.vendor,
          latitude: s.latitude,
          longitude: s.longitude,
          networkType: 'LTE' as const,
          frequency: s.frequency,
          pci: s.pci,
          tac: s.tac,
          azimuth: s.azimuth,
          beamwidth: s.beamwidth,
          height: s.height,
          cell_cover_type: s.cell_cover_type,
          earfcn: s.earfcn,
          ssbFrequency: s.ssbFrequency,
          mcc: s.mcc,
          mnc: s.mnc,
          is_shared: s.is_shared,
          extraFields: s.extraFields,
        }));

        const nr: SectorData[] = rawNr.map((s: any) => ({
          id: s.id,
          name: s.name || '未命名',
          siteName: s.siteName,
          siteId: s.siteId,
          sectorId: s.sectorId,
          vendor: s.vendor,
          latitude: s.latitude,
          longitude: s.longitude,
          networkType: 'NR' as const,
          frequency: s.frequency,
          pci: s.pci,
          tac: s.tac,
          azimuth: s.azimuth,
          beamwidth: s.beamwidth,
          height: s.height,
          cell_cover_type: s.cell_cover_type,
          earfcn: s.earfcn,
          ssbFrequency: s.ssbFrequency,
          mcc: s.mcc,
          mnc: s.mnc,
          is_shared: s.is_shared,
          extraFields: s.extraFields,
        }));

        console.log(`[MapScreen] 扇区加载完成: LTE=${lte.length}, NR=${nr.length}`);
        setSectors(lte, nr);

        // 同步写入缓存文件，确保下次启动可从本地加载（无需重复请求后端）
        try {
          const data = { lte: rawLte, nr: rawNr };
          await FileSystem.writeAsStringAsync(
            `${FileSystem.documentDirectory}cache/fullParams/sectors.json`,
            JSON.stringify(data)
          );
          // 统计站点数
          const lteSiteIds = new Set(rawLte.map((s: any) => s.siteId).filter(Boolean));
          const nrSiteIds = new Set(rawNr.map((s: any) => s.siteId).filter(Boolean));
          // 获取源文件名
          let sourceFileName = '后端同步';
          try {
            const listResp = await apiService.getDataList();
            if (listResp.success) {
              const items = Array.isArray(listResp.data) ? listResp.data : listResp.data?.items || [];
              const fpItem = items.find((i: any) => i.fileType === 'full_params');
              if (fpItem?.name) sourceFileName = fpItem.name;
            }
          } catch { /* 忽略 */ }
          await cacheService.updateMeta(meta => ({
            ...meta,
            dataTypes: { ...meta.dataTypes, fullParams: true },
            lastRefreshAt: new Date().toISOString(),
            fullParamsInfo: {
              sourceFileName,
              lteSiteCount: lteSiteIds.size,
              lteSectorCount: rawLte.length,
              nrSiteCount: nrSiteIds.size,
              nrSectorCount: rawNr.length,
              cachedAt: new Date().toISOString(),
              fromPhone: false,
            },
          }));
          console.log('[MapScreen] 扇区数据已写入缓存');
        } catch (cacheErr) {
          console.error('[MapScreen] 写入缓存失败:', cacheErr);
        }
      }
    } catch (error) {
      console.error('Failed to load sectors:', error);
    }
  };

  const handleMapInteraction = useCallback(() => {
    if (showSectorMenu) {
      setShowSectorMenu(false);
    }
  }, [showSectorMenu]);

  const handleMapPress = useCallback((lat: number, lng: number) => {
    console.log('[MapScreen] handleMapPress:', lat, lng);
    if (showSectorMenu) {
      console.log('[MapScreen] handleMapPress ignored: sector menu is open');
      setShowSectorMenu(false);
      return;
    }
    if (markerMode) {
      // 打点模式：先添加标记显示在地图上，同时弹出重命名弹框
      const now = new Date();
      const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
      const defaultName = `打点 ${timeStr}`;
      // AMap 返回 GCJ-02，存储为 WGS84
      const [wgsLat, wgsLng] = gcj02ToWgs84(lat, lng);
      addMarker(wgsLat, wgsLng, defaultName);
      // 记录刚添加的标记 ID（addMarker 用 Date.now() 生成 ID）
      const newId = `marker-${Date.now()}`;
      setPendingMarkerCoords({ lat, lng });
      setPendingMarkerId(newId);
      setMarkerNameInput(defaultName);
      setShowMarkerNameModal(true);
      return;
    }
    if (measureMode) {
      addMeasurePoint(lat, lng);
    } else if (coordinateMode) {
      // Coordinate mode: map press does nothing
      // Coordinate lookup is done via search input, not map tap
      return;
    } else {
      // 空白地图点击不设置 selectedLocation，避免无意义地弹出导航控件
      setSelectedLocation(null);
    }
  }, [measureMode, coordinateMode, addMeasurePoint, showSectorMenu, markerMode]);

  const handleLongPress = useCallback((lat: number, lng: number) => {
    // 测距/打点模式下屏蔽长按，避免操作冲突
    if (measureMode || markerMode) return;
    // AMap 返回 GCJ-02，存储为 WGS84
    const [wgsLat, wgsLng] = gcj02ToWgs84(lat, lng);
    addMarker(wgsLat, wgsLng, `标记 ${Date.now()}`);
    if (!coordinateMode) {
      setSelectedLocation({ lat, lng, name: '已添加标记' });
    }
  }, [measureMode, markerMode, coordinateMode, addMarker]);

  const handleSectorOverlap = useCallback((sectors: SectorData[], lat: number, lng: number) => {
    setOverlapSectors(sectors);
    setShowOverlapModal(true);
    setSelectedLocation({ lat, lng, name: `${sectors.length} 个重叠扇区` });
  }, []);

  const handleSelectOverlapSector = useCallback((sector: SectorData) => {
    setSelectedSector(sector);
    setShowOverlapModal(false);
    setOverlapSectors([]);
  }, [setSelectedSector]);

  const handleResultSelect = (result: SearchResult) => {
    const [lng, lat] = result.location.split(',').map(Number);
    if (!isNaN(lat) && !isNaN(lng)) {
      if (searchMode === 'coordinate') {
        // coordinate: 用户输入 WGS84，转换为 GCJ-02 用于高德地图定位
        const [gcjLat, gcjLng] = wgs84ToGcj02(lat, lng);
        setSelectedLocation({ lat: gcjLat, lng: gcjLng, name: result.name });
        setSearchMarker({ lat: gcjLat, lng: gcjLng, name: result.name });
        // 直接调用 moveCamera 移动地图到目标位置
        if (mapRef.current) {
          mapRef.current.moveCamera(gcjLat, gcjLng, 16);
        }
      } else if (searchMode === 'parameter') {
        // parameter: 后端返回 WGS84，转换为 GCJ-02 用于高德地图定位
        // 不设置 selectedLocation（避免触发底部 NavControl），改用 SectorInfoPanel 展示扇区属性
        const [gcjLat, gcjLng] = wgs84ToGcj02(lat, lng);
        setSearchMarker({ lat: gcjLat, lng: gcjLng, name: result.name });
        // 直接调用 moveCamera 移动地图到目标位置
        if (mapRef.current) {
          mapRef.current.moveCamera(gcjLat, gcjLng, 16);
        }
        // 若存在 sectorId，在 lteSectors + nrSectors 中查找对应扇区并弹出属性面板
        if (result.sectorId) {
          const sector = [...lteSectors, ...nrSectors].find((s) => s.id === result.sectorId);
          if (sector) {
            setSelectedSector(sector);
          }
        }
      } else {
        // place 模式：高德 POI 接口返回的已是 GCJ-02，直接使用
        setSelectedLocation({ lat, lng, name: result.name });
        setSearchMarker({ lat, lng, name: result.name });
        // 直接调用 moveCamera 移动地图到目标位置
        if (mapRef.current) {
          mapRef.current.moveCamera(lat, lng, 16);
        }
      }
    } else {
      Alert.alert('错误', '无效的坐标');
    }
  };

  const handleToggleMapType = () => {
    setShowSectorMenu(false);
    setMapType(mapType === 'roadmap' ? 'satellite' : 'roadmap');
  };

  // 停止非导航模式的位置+朝向跟踪
  const stopLocationTracking = useCallback(() => {
    if (locationSubRef.current) {
      locationSubRef.current.remove();
      locationSubRef.current = null;
    }
    if (headingSubRef.current) {
      headingSubRef.current.remove();
      headingSubRef.current = null;
    }
    isTrackingRef.current = false;
    trackedPositionRef.current = null;
    trackedHeadingRef.current = 0;
    if (mapRef.current) {
      mapRef.current.clearUserLocation();
    }
  }, []);

  // 非导航模式下更新地图位置标记（位置+朝向）
  const updateTrackedLocation = useCallback(() => {
    if (!isTrackingRef.current || !mapRef.current) return;
    const pos = trackedPositionRef.current;
    if (pos) {
      mapRef.current.updateUserLocation(pos.lat, pos.lng, trackedHeadingRef.current);
    }
  }, []);

  // 定位到手机当前位置，并启动持续位置+朝向跟踪
  const handleLocateMe = useCallback(async () => {
    // 如果已在跟踪，先停止再重新启动
    stopLocationTracking();

    const pos = await getCurrentPosition();
    if (!pos || !mapRef?.current) {
      Alert.alert('定位失败', '无法获取当前位置，请检查GPS权限');
      return;
    }

    const [gcjLat, gcjLng] = wgs84ToGcj02(pos.lat, pos.lng);
    trackedPositionRef.current = { lat: gcjLat, lng: gcjLng };
    mapRef.current.locateMe(gcjLat, gcjLng, 16);
    isTrackingRef.current = true;

    // 启动持续位置跟踪
    try {
      locationSubRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 2 },
        (loc) => {
          if (!isTrackingRef.current || !mapRef.current) return;
          // 导航模式由 NavigationPanel 管理，此处不更新
          if (checkIsNavigating()) return;
          const { latitude, longitude } = loc.coords;
          const [gLat, gLng] = wgs84ToGcj02(latitude, longitude);
          trackedPositionRef.current = { lat: gLat, lng: gLng };
          updateTrackedLocation();
        },
      );
    } catch (e: any) {
      console.warn('[MapScreen] watchPositionAsync 失败:', e.message);
    }

    // 启动罗盘朝向跟踪
    try {
      let lastHeadingNotifyTime = 0;
      headingSubRef.current = await Location.watchHeadingAsync((headingData) => {
        if (!isTrackingRef.current || !mapRef.current) return;
        if (checkIsNavigating()) return;
        const heading = headingData.trueHeading;
        if (heading < 0 || isNaN(heading)) return;

        // 节流：100ms 最小间隔
        const now = Date.now();
        if (now - lastHeadingNotifyTime < 100) return;
        lastHeadingNotifyTime = now;

        trackedHeadingRef.current = heading;
        updateTrackedLocation();
      });
    } catch (e: any) {
      console.warn('[MapScreen] watchHeadingAsync 失败:', e.message);
    }
  }, [stopLocationTracking, updateTrackedLocation]);

  const handleClear = () => {
    // 关闭所有弹层/模式
    setShowSectorMenu(false);
    setMarkerMode(false);
    setCoordinateMode(false);
    setMeasureMode(false);
    setShowNaviPanel(false);
    setPendingNavi(null);

    // 导航中：先停掉（避免后台位置任务继续跑）
    if (checkIsNavigating()) {
      stopNavigation();
    }
    // 同时停止非导航模式的位置跟踪
    stopLocationTracking();

    // 清空业务层 store：测距点、打点（不影响收藏）、选中状态、搜索标记、焦点
    clearMeasure();
    clearMarkers();
    setSelectedLocation(null);
    setSearchMarker(null);
    setSelectedSector(null);
    setFocusLocation(null);

    // 地图窗口层：只清除测距/打点/导航/搜索标记，保留扇区图层
    if (mapRef?.current) {
      mapRef.current.clearOverlays();
      // 兜底：逐个清理导航相关
      mapRef.current.clearRoute();
      mapRef.current.hideDestinationMarker();
      mapRef.current.clearUserLocation();
      mapRef.current.stopAutoFit();
    }
  };

  const handleConfirmMarkerName = () => {
    if (pendingMarkerId) {
      const name = markerNameInput.trim() || '未命名';
      updateMarkerName(pendingMarkerId, name);
    }
    setShowMarkerNameModal(false);
    setPendingMarkerCoords(null);
    setPendingMarkerId(null);
    setMarkerNameInput('');
  };

  const handleCancelMarkerName = () => {
    // 取消时删除已添加的标记
    if (pendingMarkerId) {
      removeMarker(pendingMarkerId);
    }
    setShowMarkerNameModal(false);
    setPendingMarkerCoords(null);
    setPendingMarkerId(null);
    setMarkerNameInput('');
  };

  const handleModeChange = (mode: SearchMode) => {
    setSearchMode(mode);
    setCoordinateMode(mode === 'coordinate');
  };

  // Sync search mode when coordinate mode changes externally
  useEffect(() => {
    if (coordinateMode && searchMode !== 'coordinate') {
      setSearchMode('coordinate');
    }
  }, [coordinateMode]);

  // Navigate to search result center
  useEffect(() => {
    if (mapCenter) {
      const key = `${mapCenter[0]},${mapCenter[1]}`;
      if (prevCenterRef.current !== key) {
        prevCenterRef.current = key;
      }
      // Reset after consumed
      const timer = setTimeout(() => setMapCenter(undefined), 100);
      return () => clearTimeout(timer);
    }
  }, [mapCenter]);

  const handleSearch = useCallback(() => {}, []);

  const renderSearchBar = () => (
    <SearchBar
      onSearch={handleSearch}
      onResultSelect={handleResultSelect}
      onModeChange={handleModeChange}
      placeholder={
        searchMode === 'coordinate'
          ? '输入经纬度，如: 113.123,23.456'
          : '搜索小区名/基站ID...'
      }
    />
  );

  const renderOverlapModal = () => (
    <Modal
      animationType="slide"
      transparent={true}
      visible={showOverlapModal}
      onRequestClose={() => setShowOverlapModal(false)}
      statusBarTranslucent={true}
    >
      <View style={[styles.modalOverlay, { backgroundColor: COLORS.overlayBg }]}>
        <View style={[styles.modalContent, { backgroundColor: COLORS.card }]}>
          <Text style={[styles.modalTitle, { color: COLORS.textPrimary }]}>选择扇区</Text>
          <Text style={[styles.modalSubtitle, { color: COLORS.textMuted }]}>
            该位置有 {overlapSectors.length} 个重叠扇区
          </Text>
          <FlatList
            data={overlapSectors}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.overlapItem, { borderBottomColor: COLORS.divider }]}
                onPress={() => handleSelectOverlapSector(item)}
              >
                <View style={[styles.networkDot, {
                  backgroundColor: item.networkType === 'LTE' ? '#4CAF50' : '#2196F3'
                }]} />
                <View style={styles.overlapItemInfo}>
                  <Text style={[styles.overlapItemName, { color: COLORS.textPrimary }]}>{item.name}</Text>
                  <Text style={[styles.overlapItemDetail, { color: COLORS.textSecondary }]}>
                    {item.networkType} | {item.siteId || ''} | PCI: {item.pci || 'N/A'}
                  </Text>
                </View>
              </TouchableOpacity>
            )}
            style={styles.overlapList}
          />
          <TouchableOpacity
            style={[styles.modalCancelBtn, { backgroundColor: COLORS.inputBg }]}
            onPress={() => setShowOverlapModal(false)}
          >
            <Text style={[styles.modalCancelText, { color: COLORS.textSecondary }]}>取消</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  return (
    <AuthGuard>
      <View style={[styles.container, { backgroundColor: COLORS.bg }]}>
        <StatusBar style={darkMode ? 'light' : 'dark'} />
      <View style={styles.mapContainer}>
        <MapViewComponent
          ref={mapRef}
          initialCenter={mapCenter}
          showSatellite={mapType === 'satellite'}
          focusLocation={focusLocation}
          onMapPress={handleMapPress}
          onLongPress={handleLongPress}
          onSectorOverlap={handleSectorOverlap}
          onMeasureFinish={finishMeasure}
          onMeasureClear={clearMeasure}
          onMapInteraction={handleMapInteraction}
        />
        {!navUiHidden && showToolbar && (
          <View style={[styles.topControls, { top: insets.top + 4 }]}>
            {renderSearchBar()}
            <View style={styles.toolBar}>
              <TouchableOpacity
                style={[styles.toolBtn, { backgroundColor: COLORS.card, borderColor: COLORS.cardBorder }, measureMode && styles.toolBtnActive]}
                onPress={() => {
                  setShowSectorMenu(false);
                  if (checkIsNavigating()) {
                    Alert.alert('提示', '请先结束导航再使用测距功能');
                    return;
                  }
                  toggleMeasureMode();
                }}
              >
                <Text style={[styles.toolBtnText, { color: COLORS.textPrimary }, measureMode && styles.toolBtnTextActive]}>
                  测距
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolBtn, { backgroundColor: COLORS.card, borderColor: COLORS.cardBorder }, markerMode && styles.toolBtnActive]}
                onPress={() => {
                  setShowSectorMenu(false);
                  if (checkIsNavigating()) {
                    Alert.alert('提示', '请先结束导航再使用打点功能');
                    return;
                  }
                  toggleMarkerMode();
                }}
              >
                <Text style={[styles.toolBtnText, { color: COLORS.textPrimary }, markerMode && styles.toolBtnTextActive]}>
                  打点
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.toolBtn, { backgroundColor: COLORS.card, borderColor: COLORS.cardBorder }]} onPress={handleClear}>
                <Text style={[styles.toolBtnText, { color: COLORS.textPrimary }]}>清除</Text>
              </TouchableOpacity>
              <View style={styles.layerControlWrapper}>
                <LayerControl
                  ref={sectorBtnRef}
                  active={showSectorMenu}
                  onPress={() => {
                    if (!showSectorMenu) {
                      sectorBtnRef.current?.measureInWindow((x, y, width, height) => {
          setSectorMenuPos({ x, y: y + height + 54 });
          setShowSectorMenu(true);
        });
                    } else {
                      setShowSectorMenu(false);
                    }
                  }}
                />
              </View>
              <TouchableOpacity style={[styles.toolBtn, { backgroundColor: COLORS.card, borderColor: COLORS.cardBorder }]} onPress={handleToggleMapType}>
                <Text style={[styles.toolBtnText, { color: COLORS.textPrimary }]}>
                  {mapType === 'roadmap' ? '卫星' : '地图'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        <MeasureControl />
        <MarkerList />
        {!navUiHidden && (
          <TouchableOpacity style={[styles.locateBtn, { backgroundColor: COLORS.card, borderColor: COLORS.cardBorder }]} onPress={handleLocateMe}>
            <Text style={styles.locateBtnText}>📍</Text>
          </TouchableOpacity>
        )}
      </View>
      {!navUiHidden && showSectorMenu && (
        <View
          style={[
            styles.sectorDropdown,
            { top: sectorMenuPos.y, left: Math.max(4, sectorMenuPos.x), backgroundColor: COLORS.card },
          ]}
          collapsable={false}
        >
          {/* LTE 图层行 */}
          <TouchableOpacity
            style={styles.sectorMenuItem}
            activeOpacity={0.7}
            onPress={() => toggleLayer('lte')}
          >
            <View style={styles.sectorLayerInfo}>
              <View style={[styles.sectorColorDot, { backgroundColor: '#4CAF50' }]} />
              <Text style={[styles.sectorLayerName, { color: COLORS.textPrimary }]}>LTE</Text>
            </View>
            <View style={styles.checkboxContainer}>
              <View style={[styles.checkboxOuter, { borderColor: COLORS.cardBorder, backgroundColor: COLORS.card }]}>
                {layers.lte.visible && (
                  <View style={styles.checkboxCheck}>
                    <Text style={styles.checkboxTickText}>✓</Text>
                  </View>
                )}
              </View>
            </View>
          </TouchableOpacity>
          {/* NR 图层行 */}
          <TouchableOpacity
            style={styles.sectorMenuItem}
            activeOpacity={0.7}
            onPress={() => toggleLayer('nr')}
          >
            <View style={styles.sectorLayerInfo}>
              <View style={[styles.sectorColorDot, { backgroundColor: '#2196F3' }]} />
              <Text style={[styles.sectorLayerName, { color: COLORS.textPrimary }]}>NR</Text>
            </View>
            <View style={styles.checkboxContainer}>
              <View style={[styles.checkboxOuter, { borderColor: COLORS.cardBorder, backgroundColor: COLORS.card }]}>
                {layers.nr.visible && (
                  <View style={styles.checkboxCheck}>
                    <Text style={styles.checkboxTickText}>✓</Text>
                  </View>
                )}
              </View>
            </View>
          </TouchableOpacity>
        </View>
      )}
      {selectedLocation && !measureMode && !markerMode && !navUiHidden && (
        <NavControl
          latitude={selectedLocation.lat}
          longitude={selectedLocation.lng}
          name={selectedLocation.name}
        />
      )}
      {!navUiHidden && <SectorInfoPanel />}
      {renderOverlapModal()}
      <NavigationPanel
        visible={showNaviPanel}
        destLat={pendingNavi?.lat ?? 0}
        destLng={pendingNavi?.lng ?? 0}
        destName={pendingNavi?.name ?? '目的地'}
        onClose={() => {
          setShowNaviPanel(false);
          setPendingNavi(null);
          setShowToolbar(true);
        }}
        onPanelVisibleChange={setShowToolbar}
        mapRef={mapRef as any}
      />

      {/* 打点重命名弹框 */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={showMarkerNameModal}
        onRequestClose={handleCancelMarkerName}
      >
        <View style={[styles.markerNameModalOverlay, { backgroundColor: COLORS.overlayBg }]}>
          <View style={[styles.markerNameModalContent, { backgroundColor: COLORS.card }]}>
            <Text style={[styles.markerNameModalTitle, { color: COLORS.textPrimary }]}>标记名称</Text>
            <TextInput
              style={[styles.markerNameInput, { borderColor: COLORS.cardBorder, backgroundColor: COLORS.inputBg, color: COLORS.textPrimary }]}
              value={markerNameInput}
              onChangeText={setMarkerNameInput}
              placeholder="输入标记名称"
              placeholderTextColor={COLORS.textMuted}
              autoFocus={true}
              selectTextOnFocus={true}
            />
            <View style={styles.markerNameModalActions}>
              <TouchableOpacity style={[styles.markerNameModalBtn, { backgroundColor: COLORS.inputBg }]} onPress={handleCancelMarkerName}>
                <Text style={[styles.markerNameModalBtnText, { color: COLORS.textSecondary }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.markerNameModalBtn, styles.markerNameModalBtnPrimary]} onPress={handleConfirmMarkerName}>
                <Text style={[styles.markerNameModalBtnText, styles.markerNameModalBtnPrimaryText]}>确定</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 图层选择弹框 - 已废弃，改用内嵌子菜单 */}
      </View>
    </AuthGuard>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  mapContainer: {
    flex: 1,
    zIndex: 1,
  },
  topControls: {
    position: 'absolute',
    left: 8,
    right: 8,
    zIndex: 100,
    elevation: 100,
  },
  toolBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    zIndex: 100,
  },
  toolBtn: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    minWidth: 56,
    alignItems: 'center',
  },
  toolBtnActive: {
    backgroundColor: '#2563EB',
    borderColor: '#1D4ED8',
  },
  toolBtnText: {
    fontSize: 12,
    color: '#1A1A1A',
    fontWeight: '500',
  },
  toolBtnTextActive: {
    color: '#fff',
  },
  clearToolBtn: {},
  clearToolBtnText: {},
  layerControlWrapper: {
    position: 'relative',
    zIndex: 999,
    elevation: 999,
  },
  sectorDropdown: {
    position: 'absolute',
    top: 0,
    left: 0,
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
    width: 75,
    maxWidth: '50%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    zIndex: 999999,
    elevation: 999999,
  },
  sectorMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  sectorLayerInfo: { flexDirection: 'row', alignItems: 'center' },
  checkboxContainer: {
    paddingLeft: 4,
  },
  checkboxOuter: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#ccc',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  checkboxCheck: {
    width: 20,
    height: 20,
    borderRadius: 4,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxTickText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
    lineHeight: 20,
  },
  sectorColorDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  sectorLayerName: { fontSize: 12, color: '#333' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    maxHeight: '60%',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 4,
  },
  modalSubtitle: {
    fontSize: 13,
    color: '#888',
    marginBottom: 12,
  },
  overlapList: {
    maxHeight: 300,
  },
  overlapItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  networkDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  overlapItemInfo: {
    flex: 1,
  },
  overlapItemName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  overlapItemDetail: {
    fontSize: 12,
    color: '#888',
    marginTop: 2,
  },
  modalCancelBtn: {
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
  },
  modalCancelText: {
    fontSize: 15,
    color: '#666',
    fontWeight: '600',
  },
  markerNameModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: '35%',
  },
  markerNameModalContent: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: '80%',
    maxWidth: 320,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 10,
  },
  markerNameModalTitle: {
    fontSize: 17,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 12,
    textAlign: 'center',
  },
  markerNameInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#333',
    marginBottom: 16,
  },
  markerNameModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  markerNameModalBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#f5f5f5',
  },
  markerNameModalBtnPrimary: {
    backgroundColor: '#007AFF',
  },
  markerNameModalBtnText: {
    fontSize: 15,
    color: '#666',
    fontWeight: '600',
  },
  markerNameModalBtnPrimaryText: {
    color: '#fff',
  },
  locateBtn: {
    position: 'absolute',
    bottom: 62,
    right: 6,
    backgroundColor: 'rgba(255,255,255,0.95)',
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ddd',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 6,
    zIndex: 60,
  },
  locateBtnText: {
    fontSize: 20,
  },
  // 图层选择弹框样式
  layerModalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    maxHeight: '70%',
  },
  layerModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  layerModalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
  },
  layerModalClose: {
    fontSize: 28,
    color: '#999',
    paddingHorizontal: 8,
  },
  layerModalLoading: {
    padding: 40,
    alignItems: 'center',
  },
  layerModalLoadingText: {
    fontSize: 14,
    color: '#666',
  },
  layerModalEmpty: {
    padding: 40,
    alignItems: 'center',
  },
  layerModalEmptyText: {
    fontSize: 16,
    color: '#666',
    marginBottom: 8,
  },
  layerModalEmptyHint: {
    fontSize: 12,
    color: '#999',
  },
  layerList: {
    maxHeight: 400,
  },
  layerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  layerItemInfo: {
    flex: 1,
  },
  layerItemName: {
    fontSize: 14,
    color: '#333',
    marginBottom: 2,
  },
  layerItemType: {
    fontSize: 12,
    color: '#888',
  },
});
