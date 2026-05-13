// mobile-app/app/(tabs)/index.tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, StyleSheet, Alert, TouchableOpacity, Text,
  Modal, FlatList, Switch, TextInput, Platform, StatusBar as RNStatusBar
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
import { wgs84ToGcj02 } from '../../src/utils/coordinate';
import { getCurrentPosition, isNavigating as checkIsNavigating, stopNavigation } from '../../src/services/navigationService';

type SearchMode = 'place' | 'parameter' | 'coordinate';

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const {
    mapType, setMapType, setBackendInfo, setConnected,
    measureMode, measureFinished, addMarker, addMeasurePoint,
    toggleMeasureMode, finishMeasure, clearMeasure,
    layers, toggleLayer, lteSectors, nrSectors,
    setSectors, setSelectedSector, selectedSector,
    setSearchMarker, markers, coordinateMode, setCoordinateMode,
    clearMarkers, measurePoints,
    markerMode, toggleMarkerMode, setMarkerMode,
    pendingNavi, setPendingNavi,
    navUiHidden,
  } = useMapStore();

  const [selectedLocation, setSelectedLocation] = useState<{
    lat: number; lng: number; name: string;
  } | null>(null);
  const [mapCenter, setMapCenter] = useState<[number, number] | undefined>(undefined);
  const [searchMode, setSearchMode] = useState<SearchMode>('place');
  const [overlapSectors, setOverlapSectors] = useState<SectorData[]>([]);
  const [showOverlapModal, setShowOverlapModal] = useState(false);
  const [showSectorMenu, setShowSectorMenu] = useState(false);
  const [sectorMenuPos, setSectorMenuPos] = useState({ x: 0, y: 0 });
  const sectorBtnRef = useRef<View>(null);
  const mapRef = useRef<MapViewRef>(null);

  // 打点重命名弹框状态
  const [showMarkerNameModal, setShowMarkerNameModal] = useState(false);
  const [pendingMarkerCoords, setPendingMarkerCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [markerNameInput, setMarkerNameInput] = useState('');

  const prevCenterRef = useRef<string | null>(null);
  const [showNaviPanel, setShowNaviPanel] = useState(false);
  // 导航面板显示时隐藏顶部工具栏
  const [showToolbar, setShowToolbar] = useState(true);

  // 图层菜单状态
  const [dataList, setDataList] = useState<any[]>([]);
  const [loadingLayers, setLoadingLayers] = useState(false);
  const [expandedSubMenu, setExpandedSubMenu] = useState<'tab' | 'geo' | null>(null);

  // 当 pendingNavi 被设置时，自动打开导航面板
  useEffect(() => {
    if (pendingNavi) {
      setShowNaviPanel(true);
    }
  }, [pendingNavi]);

  useEffect(() => {
    connectToBackend();
  }, []);

  const connectToBackend = async () => {
    try {
      const info = await apiService.getSystemInfo();
      setBackendInfo(info.backend_ip, info.backend_port);
      setConnected(true);
      await loadSectors();
    } catch (error) {
      console.error('Failed to connect to backend:', error);
      setConnected(false);
    }
  };

  // 加载图层数据列表
  const loadDataList = async () => {
    try {
      setLoadingLayers(true);
      const response = await apiService.getDataList();
      if (response.success) {
        setDataList(response.data || []);
      }
    } catch (error) {
      console.error('Failed to load data list:', error);
    } finally {
      setLoadingLayers(false);
    }
  };

  // 处理TAB图层点击
  const handleTabLayerPress = async () => {
    if (expandedSubMenu === 'tab') {
      setExpandedSubMenu(null);
      return;
    }
    setExpandedSubMenu('tab');
    await loadDataList();
  };

  // 处理地理化数据点击
  const handleGeoDataPress = async () => {
    if (expandedSubMenu === 'geo') {
      setExpandedSubMenu(null);
      return;
    }
    setExpandedSubMenu('geo');
    await loadDataList();
  };

  // 通过后端接口加载渲染数据 - 使用 WebView 的 HTTP 加载函数，避免 injectJavaScript 大小限制
  const loadMobileRenderData = async (dataId: string, dataName?: string) => {
    try {
      const injectJS = (code: string) => mapRef.current?.injectJavaScript(code);

      // 获取后端 API 地址
      const baseUrl = await apiService.getCurrentBaseUrl();
      if (!baseUrl) {
        Alert.alert('错误', '未连接后端服务器');
        return;
      }

      // 先获取数据元信息（用于判断数据类型和图层数量）
      const response = await apiService.getMobileRenderData(dataId);
      if (!response.success || !response.data) {
        Alert.alert('错误', '无法获取渲染数据');
        return;
      }
      const renderData = response.data;

      if (renderData.dataType === 'tab') {
        const layers = renderData.layers || [];
        if (layers.length === 0) {
          Alert.alert('提示', '该文件没有可用的图层');
          return;
        }
        // 使用 WebView 的 HTTP 加载函数，无大小限制
        if (layers.length === 1) {
          injectJS(`window.loadTabLayerFromAPI('${baseUrl}', '${dataId}', '${layers[0].id}');`);
          Alert.alert('成功', `TAB图层 "${layers[0].name}" 已加载到地图`);
        } else {
          Alert.alert(
            '选择图层',
            `该文件包含 ${layers.length} 个图层`,
            layers.slice(0, 5).map((l: any) => ({
              text: l.name || l.id,
              onPress: () => {
                injectJS(`window.loadTabLayerFromAPI('${baseUrl}', '${dataId}', '${l.id}');`);
                Alert.alert('成功', `TAB图层 "${l.name}" 已加载到地图`);
              }
            })).concat([{ text: '取消', style: 'cancel' as const }])
          );
        }
      } else if (renderData.dataType === 'geo') {
        const features = renderData.features || [];
        if (features.length === 0) {
          Alert.alert('提示', '该文件中没有数据');
          return;
        }
        // 使用 WebView 的 HTTP 加载函数，无大小限制
        injectJS(`window.loadGeoDataFromAPI('${baseUrl}', '${dataId}');`);
        Alert.alert('成功', `已加载 "${dataName || dataId}" (${features.length}条)`);
      } else {
        Alert.alert('错误', '不支持的数据类型');
      }
    } catch (error) {
      console.error('[MapScreen] 加载渲染数据失败:', error);
      Alert.alert('错误', '加载渲染数据失败:' + String(error));
    }
  };

  // 获取过滤后的数据列表（根据当前子菜单类型）
  const filteredTabData = dataList.filter(item => item.type === 'map' || item.subType === 'mapinfo');
  const filteredGeoData = dataList.filter(item => item.type === 'excel' && (item.geometryType != null || item.fileType === 'geo_data'));

  const loadSectors = async () => {
    try {
      const response = await apiService.getSectors();
      if (response.success && response.data) {
        const rawLte: any[] = response.data.lte || [];
        const rawNr: any[] = response.data.nr || [];

        const lte: SectorData[] = rawLte.map((s: any) => ({
          id: s.id,
          name: s.name || '未命名',
          siteId: s.siteId,
          sectorId: s.sectorId,
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
        }));

        const nr: SectorData[] = rawNr.map((s: any) => ({
          id: s.id,
          name: s.name || '未命名',
          siteId: s.siteId,
          sectorId: s.sectorId,
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
        }));

        console.log(`[MapScreen] 扇区加载完成: LTE=${lte.length}, NR=${nr.length}`);
        setSectors(lte, nr);
      }
    } catch (error) {
      console.error('Failed to load sectors:', error);
    }
  };

  const handleMapInteraction = useCallback(() => {
    if (showSectorMenu) {
      setShowSectorMenu(false);
      setExpandedSubMenu(null);
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
      // 打点模式：弹出重命名弹框
      const now = new Date();
      const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
      setPendingMarkerCoords({ lat, lng });
      setMarkerNameInput(`打点 ${timeStr}`);
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
  }, [measureMode, coordinateMode, addMeasurePoint, showSectorMenu, markerMode, addMarker]);

  const handleLongPress = useCallback((lat: number, lng: number) => {
    // AMap 返回 GCJ-02，存储为 WGS84
    const [wgsLat, wgsLng] = gcj02ToWgs84(lat, lng);
    addMarker(wgsLat, wgsLng, `标记 ${Date.now()}`);
    if (!measureMode && !coordinateMode) {
      setSelectedLocation({ lat, lng, name: '已添加标记' });
    }
  }, [measureMode, coordinateMode, addMarker]);

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
      if (searchMode === 'coordinate' || searchMode === 'parameter') {
        // coordinate: 用户输入 WGS84；parameter: 后端返回 WGS84
        // 均转换为 GCJ-02 用于高德地图定位
        const [gcjLat, gcjLng] = wgs84ToGcj02(lat, lng);
        setSelectedLocation({ lat: gcjLat, lng: gcjLng, name: result.name });
        setSearchMarker({ lat: gcjLat, lng: gcjLng, name: result.name });
        setMapCenter([gcjLat, gcjLng]);

      } else {
        // place 模式：高德 POI 接口返回的已是 GCJ-02，直接使用
        setSelectedLocation({ lat, lng, name: result.name });
        setSearchMarker({ lat, lng, name: result.name });
        setMapCenter([lat, lng]);
      }
    } else {
      Alert.alert('错误', '无效的坐标');
    }
  };

  const handleToggleMapType = () => {
    setShowSectorMenu(false);
    setMapType(mapType === 'roadmap' ? 'satellite' : 'roadmap');
  };

  // 定位到手机当前位置
  const handleLocateMe = useCallback(async () => {
    const pos = await getCurrentPosition();
    if (pos && mapRef?.current) {
      const [gcjLat, gcjLng] = wgs84ToGcj02(pos.lat, pos.lng);
      mapRef.current.locateMe(gcjLat, gcjLng, 16);
    } else {
      Alert.alert('定位失败', '无法获取当前位置，请检查GPS权限');
    }
  }, []);

  const handleClear = () => {
    setShowSectorMenu(false);
    setMarkerMode(false);
    setCoordinateMode(false);
    if (checkIsNavigating()) {
      stopNavigation();
    }
    clearMeasure();
    clearMarkers();
    setSelectedLocation(null);
    setSearchMarker(null);
    setSelectedSector(null);
    setShowNaviPanel(false);
    setPendingNavi(null);
    const injectJS = (code: string) => mapRef.current?.injectJavaScript(code);
    injectJS('Object.keys(tabLayerGroups).forEach(function(k) { window.removeTabLayer(k); });');
    injectJS('Object.keys(geoDataLayerGroups).forEach(function(k) { window.removeGeoDataLayer(k); });');
    if (mapRef?.current) {
      mapRef.current.clearRoute();
      mapRef.current.hideDestinationMarker();
      mapRef.current.clearUserLocation();
      mapRef.current.stopAutoFit();
    }
  };

  const handleConfirmMarkerName = () => {
    if (pendingMarkerCoords) {
      const name = markerNameInput.trim() || '未命名';
      // AMap 返回 GCJ-02，存储为 WGS84
      const [wgsLat, wgsLng] = gcj02ToWgs84(pendingMarkerCoords.lat, pendingMarkerCoords.lng);
      addMarker(wgsLat, wgsLng, name);
    }
    setShowMarkerNameModal(false);
    setPendingMarkerCoords(null);
    setMarkerNameInput('');
  };

  const handleCancelMarkerName = () => {
    setShowMarkerNameModal(false);
    setPendingMarkerCoords(null);
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
          : '搜索地点或小区...'
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
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>选择扇区</Text>
          <Text style={styles.modalSubtitle}>
            该位置有 {overlapSectors.length} 个重叠扇区
          </Text>
          <FlatList
            data={overlapSectors}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.overlapItem}
                onPress={() => handleSelectOverlapSector(item)}
              >
                <View style={[styles.networkDot, {
                  backgroundColor: item.networkType === 'LTE' ? '#4CAF50' : '#2196F3'
                }]} />
                <View style={styles.overlapItemInfo}>
                  <Text style={styles.overlapItemName}>{item.name}</Text>
                  <Text style={styles.overlapItemDetail}>
                    {item.networkType} | {item.siteId || ''} | PCI: {item.pci || 'N/A'}
                  </Text>
                </View>
              </TouchableOpacity>
            )}
            style={styles.overlapList}
          />
          <TouchableOpacity
            style={styles.modalCancelBtn}
            onPress={() => setShowOverlapModal(false)}
          >
            <Text style={styles.modalCancelText}>取消</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <View style={styles.mapContainer}>
        <MapViewComponent
          ref={mapRef}
          initialCenter={mapCenter}
          showSatellite={mapType === 'satellite'}
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
                style={[styles.toolBtn, measureMode && styles.toolBtnActive]}
                onPress={() => {
                  setShowSectorMenu(false);
                  if (checkIsNavigating()) {
                    Alert.alert('提示', '请先结束导航再使用测距功能');
                    return;
                  }
                  toggleMeasureMode();
                }}
              >
                <Text style={[styles.toolBtnText, measureMode && styles.toolBtnTextActive]}>
                  {measureMode ? '退出测距' : '测距'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.toolBtn, styles.clearToolBtn]} onPress={handleClear}>
                <Text style={[styles.toolBtnText, styles.clearToolBtnText]}>清除</Text>
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
              <TouchableOpacity
                style={[styles.toolBtn, markerMode && styles.toolBtnActive]}
                onPress={() => {
                  setShowSectorMenu(false);
                  if (checkIsNavigating()) {
                    Alert.alert('提示', '请先结束导航再使用打点功能');
                    return;
                  }
                  toggleMarkerMode();
                }}
              >
                <Text style={[styles.toolBtnText, markerMode && styles.toolBtnTextActive]}>
                  {markerMode ? '退出打点' : '打点'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.mapTypeBtn} onPress={handleToggleMapType}>
                <Text style={styles.mapTypeBtnText}>
                  {mapType === 'roadmap' ? '卫星' : '地图'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        <MeasureControl />
        <MarkerList />
        {!navUiHidden && (
          <TouchableOpacity style={styles.locateBtn} onPress={handleLocateMe}>
            <Text style={styles.locateBtnText}>📍</Text>
          </TouchableOpacity>
        )}
      </View>
      {!navUiHidden && showSectorMenu && (
        <View
          style={[styles.sectorDropdown, { top: sectorMenuPos.y, left: sectorMenuPos.x }]}
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
              <Text style={styles.sectorLayerName}>LTE</Text>
            </View>
            <View style={styles.checkboxContainer}>
              <View style={styles.checkboxOuter}>
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
              <Text style={styles.sectorLayerName}>NR</Text>
            </View>
            <View style={styles.checkboxContainer}>
              <View style={styles.checkboxOuter}>
                {layers.nr.visible && (
                  <View style={styles.checkboxCheck}>
                    <Text style={styles.checkboxTickText}>✓</Text>
                  </View>
                )}
              </View>
            </View>
          </TouchableOpacity>
          <View style={styles.dropdownDivider} />
          <TouchableOpacity style={styles.sectorMenuItem} activeOpacity={0.7} onPress={handleTabLayerPress}>
            <View style={styles.sectorLayerInfo}>
              <View style={[styles.sectorColorDot, { backgroundColor: '#FF9800' }]} />
              <Text style={styles.sectorLayerName}>TAB图层</Text>
            </View>
            <Text style={[styles.dropdownArrow, expandedSubMenu === 'tab' && styles.dropdownArrowExpanded]}>›</Text>
          </TouchableOpacity>
          {/* TAB图层子菜单 */}
          {expandedSubMenu === 'tab' && (
            <View style={styles.subMenu}>
              {loadingLayers ? (
                <Text style={styles.subMenuLoading}>加载中...</Text>
              ) : filteredTabData.length === 0 ? (
                <Text style={styles.subMenuEmpty}>暂无可用图层</Text>
              ) : (
                filteredTabData.slice(0, 5).map((item, index) => (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.subMenuItem}
                    activeOpacity={0.7}
                    onPress={() => {
                      setExpandedSubMenu(null);
                      setShowSectorMenu(false);
                      loadMobileRenderData(item.id, item.name);
                    }}
                  >
                    <Text style={styles.subMenuItemName} numberOfLines={1}>
                      {item.name || `文件 ${index + 1}`}
                    </Text>
                  </TouchableOpacity>
                ))
              )}
              {filteredTabData.length > 5 && (
                <Text style={styles.subMenuMore}>+{filteredTabData.length - 5} 更多</Text>
              )}
            </View>
          )}
          <TouchableOpacity style={styles.sectorMenuItem} activeOpacity={0.7} onPress={handleGeoDataPress}>
            <View style={styles.sectorLayerInfo}>
              <View style={[styles.sectorColorDot, { backgroundColor: '#9C27B0' }]} />
              <Text style={styles.sectorLayerName}>地理化数据</Text>
            </View>
            <Text style={[styles.dropdownArrow, expandedSubMenu === 'geo' && styles.dropdownArrowExpanded]}>›</Text>
          </TouchableOpacity>
          {/* 地理化数据子菜单 */}
          {expandedSubMenu === 'geo' && (
            <View style={styles.subMenu}>
              {loadingLayers ? (
                <Text style={styles.subMenuLoading}>加载中...</Text>
              ) : filteredGeoData.length === 0 ? (
                <Text style={styles.subMenuEmpty}>暂无可用图层</Text>
              ) : (
                filteredGeoData.slice(0, 5).map((item, index) => (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.subMenuItem}
                    activeOpacity={0.7}
                    onPress={() => {
                      setExpandedSubMenu(null);
                      setShowSectorMenu(false);
                      loadMobileRenderData(item.id, item.name);
                    }}
                  >
                    <Text style={styles.subMenuItemName} numberOfLines={1}>
                      {item.name || `文件 ${index + 1}`}
                    </Text>
                  </TouchableOpacity>
                ))
              )}
              {filteredGeoData.length > 5 && (
                <Text style={styles.subMenuMore}>+{filteredGeoData.length - 5} 更多</Text>
              )}
            </View>
          )}
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
        <View style={styles.markerNameModalOverlay}>
          <View style={styles.markerNameModalContent}>
            <Text style={styles.markerNameModalTitle}>标记名称</Text>
            <TextInput
              style={styles.markerNameInput}
              value={markerNameInput}
              onChangeText={setMarkerNameInput}
              placeholder="输入标记名称"
              autoFocus={true}
              selectTextOnFocus={true}
            />
            <View style={styles.markerNameModalActions}>
              <TouchableOpacity style={styles.markerNameModalBtn} onPress={handleCancelMarkerName}>
                <Text style={styles.markerNameModalBtnText}>取消</Text>
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
  mapTypeBtn: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  mapTypeBtnText: {
    fontSize: 12,
    color: '#333',
  },
  toolBar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 4,
    marginTop: 4,
    zIndex: 100,
  },
  toolBtn: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  toolBtnActive: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  toolBtnText: {
    fontSize: 12,
    color: '#333',
  },
  toolBtnTextActive: {
    color: '#fff',
  },
  clearToolBtn: {
    backgroundColor: 'rgba(255,107,107,0.95)',
    borderColor: '#ff6b6b',
  },
  clearToolBtnText: {
    color: '#fff',
    fontWeight: '600',
  },
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
    width: 150,
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
    paddingVertical: 8,
  },
  sectorLayerInfo: { flexDirection: 'row', alignItems: 'center' },
  checkboxContainer: {
    paddingLeft: 12,
  },
  checkboxOuter: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#ccc',
    justifyContent: 'center',
    alignItems: 'center',
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
    fontSize: 13,
    fontWeight: 'bold',
    lineHeight: 15,
    marginTop: -1,
  },
  sectorColorDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  sectorLayerName: { fontSize: 12, color: '#333' },
  dropdownSection: {
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    marginBottom: 4,
  },
  dropdownSectionTitle: {
    fontSize: 11,
    color: '#888',
    fontWeight: '600',
  },
  dropdownDivider: {
    height: 1,
    backgroundColor: '#eee',
    marginVertical: 4,
  },
  dropdownArrow: {
    fontSize: 14,
    color: '#999',
    transform: [{ rotate: '0deg' }],
  },
  dropdownArrowExpanded: {
    transform: [{ rotate: '90deg' }],
  },
  subMenu: {
    backgroundColor: '#f7f8fa',
    borderRadius: 6,
    marginHorizontal: 4,
    marginVertical: 2,
    paddingVertical: 4,
  },
  subMenuLoading: {
    textAlign: 'center',
    color: '#999',
    fontSize: 12,
    paddingVertical: 8,
  },
  subMenuEmpty: {
    textAlign: 'center',
    color: '#bbb',
    fontSize: 12,
    paddingVertical: 8,
  },
  subMenuItem: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 0,
  },
  subMenuItemName: {
    fontSize: 12,
    color: '#555',
    paddingLeft: 4,
  },
  subMenuMore: {
    fontSize: 11,
    color: '#aaa',
    textAlign: 'center',
    paddingVertical: 4,
  },
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
