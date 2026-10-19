/**
 * NavigationPanel - 
 *
 * 
 * 1. 
 * 2. 
 * 3. 
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  LayoutAnimation, Platform, UIManager,
  Animated, PanResponder,
} from 'react-native';
import { useMapStore } from '../../store/mapStore';

// Android LayoutAnimation
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { MapViewRef } from '../Map/MapView';
import {
  getCurrentPosition, planRoute, planRoutes,
  startNavigation, stopNavigation, isNavigating,
  onNaviStateChange, NaviStateSnapshot, NaviMode, GpsSignalQuality,
  RouteData, selectReroute,
} from '../../services/navigationService';
import { wgs84ToGcj02 } from '../../utils/coordinate';

interface Props {
  visible: boolean;
  destLat: number;   // WGS84
  destLng: number;   // WGS84
  destName: string;
  onClose: () => void;
  mapRef: React.RefObject<MapViewRef>;
  // null = GPS 定位
  originLat?: number;
  originLng?: number;
  // 面板可见性回调
  onPanelVisibleChange: (visible: boolean) => void;
}

/** GPS/N*/
function GpsSignalIndicator({ quality }: { quality: GpsSignalQuality }) {
  const config: Record<GpsSignalQuality, { icon: string; color: string; label: string }> = {
    excellent: { icon: '●●●●', color: '#4CAF50', label: '优' },
    good: { icon: '●●●○', color: '#8BC34A', label: '良' },
    weak: { icon: '●○○○', color: '#FF9800', label: '弱' },
    none: { icon: '○○○○', color: '#F44336', label: '无' },
  };
  const { icon, color, label } = config[quality];
  return (
    <View style={styles.signalContainer}>
      <Text style={[styles.signalIcon, { color }]}>{icon}</Text>
    </View>
  );
}

/** */
function formatDist(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} 公里`;
  return `${Math.round(meters)} 米`;
}

/**  */
function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分钟`;
  return `${s}秒`;
}

const MODE_OPTIONS: { key: NaviMode; label: string; icon: string }[] = [
  { key: 'drive', label: '驾车', icon: '🚗' },
  { key: 'walk', label: '步行', icon: '🚶' },
];

export default function NavigationPanel({
  visible, destLat, destLng, destName, onClose, mapRef, originLat, originLng, onPanelVisibleChange,
}: Props) {
  // y
  const [setupMode, setSetupMode] = useState(true);
  const [naviMode, setNaviMode] = useState<NaviMode>('drive');
  const [startPos, setStartPos] = useState<{ lat: number; lng: number } | null>(null);
  const [routePreview, setRoutePreview] = useState<{
    distance: number; duration: number;
  } | null>(null);
  const [recommendedRoute, setRecommendedRoute] = useState<RouteData | null>(null);
  const [alternateRoute, setAlternateRoute] = useState<RouteData | null>(null);
  const [selectedRouteKey, setSelectedRouteKey] = useState<'recommended' | 'alternate'>('recommended');
  const [rerouteOptions, setRerouteOptions] = useState<{ recommended: RouteData; alternate: RouteData | null } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const gpsSignal = useMapStore(s => s.gpsSignal);

  // 
  const [navState, setNavState] = useState<NaviStateSnapshot | null>(null);
  const [statusText, setStatusText] = useState('准备出发');
  const [panelExpanded, setPanelExpanded] = useState(true);
  // setupMode cleanup
  const [naviRouteKey, setNaviRouteKey] = useState(0);

  // ]
  const slideAnim = useRef(new Animated.Value(1)).current;
  const panY = useRef(0);

  // /
  const animatePanel = useCallback((expanded: boolean) => {
    setPanelExpanded(expanded);
    Animated.timing(slideAnim, {
      toValue: expanded ? 1 : 0,
      duration: 250,
      useNativeDriver: false, // heightnative driver
    }).start();
  }, [slideAnim]);

  const togglePanel = useCallback(() => {
    animatePanel(!panelExpanded);
  }, [panelExpanded, animatePanel]);

  //  - 
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // 
        return Math.abs(gestureState.dy) > 5 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx);
      },
      onPanResponderMove: (_, gestureState) => {
        // 
        if (panelExpanded) {
          // 
          const newValue = Math.max(0, 1 - gestureState.dy / 100);
          slideAnim.setValue(Math.min(1, newValue));
        } else {
          // 
          const newValue = Math.min(1, -gestureState.dy / 100);
          slideAnim.setValue(Math.max(0, newValue));
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (panelExpanded) {
          // 
          if (gestureState.dy > 30) {
            animatePanel(false);
          } else {
            animatePanel(true);
          }
        } else {
          // 
          if (gestureState.dy < -30) {
            animatePanel(true);
          } else {
            animatePanel(false);
          }
        }
      },
    })
  ).current;

  // 
  const resetState = useCallback(() => {
    setSetupMode(true);
    setRoutePreview(null);
    setRecommendedRoute(null);
    setAlternateRoute(null);
    setSelectedRouteKey('recommended');
    setRerouteOptions(null);
    setNavState(null);
    setErrorMsg('');
    setStatusText('准备出发');
    setIsLoading(false);
  }, []);

  // - 
  useEffect(() => {
    if (visible) {
      resetState();
      // 
      onPanelVisibleChange?.(false);
    } else {
      // 
      onPanelVisibleChange?.(true);
    }
  }, [visible]);

  //
  useEffect(() => {
    const unsub = onNaviStateChange((state) => {
      //
      if (!state.isNavigating) {
        return;
      }
      setNavState(state);
      if (state.isNavigating && state.routeData) {
        const step = state.routeData.steps[state.currentStepIndex];
        if (step) {
          setStatusText(step.instruction || '正在导航...');
        }
      }
      // 处理重规划选项
      if (state.rerouteOptions) {
        setRerouteOptions(state.rerouteOptions);
      }
      //
      if (state.isNavigating && state.currentPosition && mapRef.current) {
        const [gcjLat, gcjLng] = wgs84ToGcj02(
          state.currentPosition[0],
          state.currentPosition[1],
        );
        const heading = state.heading != null ? state.heading : 0;
        mapRef.current.updateUserLocation(gcjLat, gcjLng, heading);
        //  auto-fit3 zoom
        mapRef.current.startAutoFit();

        // 更新路线
        if (state.routeData) {
          const fromIdx = state.prevStepEndIndex > 0 ? state.prevStepEndIndex : 0;
          mapRef.current.updateRemainingRoute(state.routeData.flatPolyline, fromIdx);
        }
        // 重规划时显示备选路线
        if (state.rerouteOptions && state.rerouteOptions.alternate) {
          mapRef.current.addAlternateRoute(state.rerouteOptions.alternate.flatPolyline);
        }

        // 路口接近判定：100 米内标记为 approaching，触发地图自动放大
        // 与 navigationService.checkAndAnnounceApproach 的 100 米播报阈值保持一致
        let approachingTurn = false;
        if (state.routeData && state.currentStepIndex < state.routeData.steps.length - 1) {
          //  polyline
          const nextStepStart = state.routeData.steps[state.currentStepIndex + 1].polyline[0];
          if (nextStepStart) {
            const R = 6371000;
            const toRad = (d: number) => (d * Math.PI) / 180;
            const dLat = toRad(nextStepStart[1] - gcjLat);
            const dLng = toRad(nextStepStart[0] - gcjLng);
            const a = Math.sin(dLat / 2) ** 2
              + Math.cos(toRad(gcjLat)) * Math.cos(toRad(nextStepStart[1]))
                * Math.sin(dLng / 2) ** 2;
            const distMeters = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            approachingTurn = distMeters < 100;
          }
        }
        // +++
        // getNavZoom
        mapRef.current.setNavContext(
          state.remainingDistance,
          approachingTurn,
          state.mode,
          state.currentSpeedMps || 0,
        );
      }
    });

    return unsub;
  }, []);

  // 导航开始后渲染地图路线（使用已选路线，不重新规划）
  useEffect(() => {
    if (setupMode || !startPos || !mapRef.current || naviRouteKey === 0) return;
    // 使用用户选择的路线渲染地图，不重新规划
    const selectedRoute = selectedRouteKey === 'alternate' && alternateRoute ? alternateRoute : recommendedRoute;
    if (!selectedRoute || !mapRef.current) return;
    mapRef.current.clearRoute();
    mapRef.current.addRoute(selectedRoute.flatPolyline);
    if (alternateRoute && selectedRouteKey !== 'alternate') {
      mapRef.current.addAlternateRoute(alternateRoute.flatPolyline);
    }
    mapRef.current.fitRouteBounds(selectedRoute.flatPolyline, selectedRoute.totalDistance);
    const [gcjLat, gcjLng] = wgs84ToGcj02(startPos.lat, startPos.lng);
    mapRef.current.updateUserLocation(gcjLat, gcjLng, 0);
    mapRef.current.startAutoFit();
  }, [naviRouteKey]);

  // 
  const getOrigin = useCallback(async () => {
    if (originLat !== undefined && originLng !== undefined) {
      return { lat: originLat, lng: originLng };
    }
    const pos = await getCurrentPosition();
    if (pos) return pos;
    if (startPos) {
      console.log('[NavigationPanel] getOrigin: )');
      return startPos;
    }
    return null;
  }, [originLat, originLng, startPos]);

  // 路线规划
  useEffect(() => {
    if (!visible || !setupMode) return;
    // 导航进行中不重新规划路线，避免覆盖 isLoading 状态
    if (isNavigating()) return;
    (async () => {
      setIsLoading(true);
      setErrorMsg('');
      const origin = await getOrigin();
      if (!origin) {
        setErrorMsg('无法获取起点位置');
        setIsLoading(false);
        return;
      }
      setStartPos(origin);
      try {
        const { recommended, alternate } = await planRoutes(
          [origin.lat, origin.lng],
          [destLat, destLng],
          naviMode,
        );
        setRecommendedRoute(recommended);
        setAlternateRoute(alternate);
        setSelectedRouteKey('recommended');
        const selectedRoute = recommended;
        setRoutePreview({ distance: selectedRoute.totalDistance, duration: selectedRoute.totalDuration });
        // 地图渲染
        if (mapRef.current) {
          mapRef.current.clearRoute();
          mapRef.current.addRoute(selectedRoute.flatPolyline);
          if (alternate) {
            mapRef.current.addAlternateRoute(alternate.flatPolyline);
          }
          mapRef.current.fitRouteBounds(selectedRoute.flatPolyline, selectedRoute.totalDistance);
          const [destGcjLat, destGcjLng] = wgs84ToGcj02(destLat, destLng);
          mapRef.current.showDestinationMarker(destGcjLat, destGcjLng, destName);
          const [gcjLat, gcjLng] = wgs84ToGcj02(origin.lat, origin.lng);
          mapRef.current.updateUserLocation(gcjLat, gcjLng, 0);
        }
      } catch (e: any) {
        setErrorMsg(e.message || '路线规划失败，请重试');
      }
      setIsLoading(false);
    })();
    return () => {
      if (mapRef.current && !isNavigating()) {
        mapRef.current.clearRoute();
        mapRef.current.hideDestinationMarker();
      }
    };
  }, [visible, setupMode, naviMode]);

  // 
  const handleModeChange = (mode: NaviMode) => {
    setNaviMode(mode);
    setRoutePreview(null);
    setRecommendedRoute(null);
    setAlternateRoute(null);
    setSelectedRouteKey('recommended');
    setErrorMsg('');
  };

  // 
  const handleSelectRoute = useCallback((key: 'recommended' | 'alternate') => {
    setSelectedRouteKey(key);
    const route = key === 'alternate' && alternateRoute ? alternateRoute : recommendedRoute;
    if (!route || !mapRef.current) return;
    setRoutePreview({ distance: route.totalDistance, duration: route.totalDuration });
    mapRef.current.clearRoute();
    mapRef.current.addRoute(route.flatPolyline);
    // 未选中的路线作为备选显示
    const otherRoute = key === 'alternate' ? recommendedRoute : alternateRoute;
    if (otherRoute) {
      mapRef.current.addAlternateRoute(otherRoute.flatPolyline);
    }
    mapRef.current.fitRouteBounds(route.flatPolyline, route.totalDistance);
  }, [recommendedRoute, alternateRoute, mapRef]);

  const handleStartNavi = async () => {
    const selectedRoute = selectedRouteKey === 'alternate' && alternateRoute ? alternateRoute : recommendedRoute;
    if (!selectedRoute) {
      setErrorMsg('请先规划路线');
      return;
    }
    setIsLoading(true);
    try {
      const success = await startNavigation(
        { lat: destLat, lng: destLng },
        destName,
        naviMode,
        startPos || undefined,
        selectedRoute,
      );
      if (success) {
        setSetupMode(false);
        //
        if (mapRef.current) {
          const [destGcjLat, destGcjLng] = wgs84ToGcj02(destLat, destLng);
          mapRef.current.showDestinationMarker(destGcjLat, destGcjLng, destName);
        }
        // zoom=17
        if (mapRef.current && startPos) {
          const [gcjLat, gcjLng] = wgs84ToGcj02(startPos.lat, startPos.lng);
          mapRef.current.moveCamera(gcjLat, gcjLng, 17);
        }
        //  auto-fitzoom
        if (mapRef.current) {
          mapRef.current.startAutoFit();
        }
        //  naviRouteKey  useEffect setupMode cleanup
        setTimeout(() => setNaviRouteKey(k => k + 1), 50);
      } else {
        setErrorMsg('请检查 GPS 权限后重试');
      }
    } catch (e: any) {
      console.error('[NavigationPanel] startNavigation error:', e?.message || e);
      setErrorMsg('启动导航失败: ' + (e?.message || '未知错误'));
    } finally {
      setIsLoading(false);
    }
  };

  // 
  const handleStopNavi = useCallback(() => {
    stopNavigation();
    if (mapRef.current) {
      mapRef.current.stopAutoFit();
      mapRef.current.clearRoute();
      mapRef.current.hideDestinationMarker();
      mapRef.current.clearUserLocation();
      setTimeout(() => {
        mapRef.current.hideDestinationMarker();
        mapRef.current.clearRoute();
      }, 100);
    }
    setSetupMode(true);
    setNavState(null);
    setStatusText('准备出发');
    onClose();
  }, [mapRef, onClose]);

  //
  const handleClose = () => {
    if (isNavigating()) {
      // 导航中：先结束导航再关闭，避免用户体感“卡死”
      stopNavigation();
    }
    if (mapRef.current) {
      mapRef.current.clearRoute();
      mapRef.current.hideDestinationMarker();
      mapRef.current.clearUserLocation();
    }
    onClose();
  };

  if (!visible) return null;

  // === y ===
  const renderSetup = () => (
    <View style={styles.panel}>
      {/* 关闭按钮 */}
      <View style={styles.header}>
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>x</Text>
        </TouchableOpacity>
      </View>

      {/* 起点/终点 */}
      <View style={styles.routeInfo}>
        <View style={styles.routeRow}>
          <View style={[styles.dot, styles.startDot]} />
          <Text style={styles.routeLabel}>起点</Text>
          <Text style={styles.routeText} numberOfLines={1}>
            {startPos ? `${startPos.lat.toFixed(5)}, ${startPos.lng.toFixed(5)}` : '正在获取起点...'}
          </Text>
          {gpsSignal.quality !== 'none' && (
            <GpsSignalIndicator quality={gpsSignal.quality} />
          )}
        </View>
        <View style={styles.routeLine} />
        <View style={styles.routeRow}>
          <View style={[styles.dot, styles.endDot]} />
          <Text style={styles.routeLabel}>终点</Text>
          <Text style={styles.routeText} numberOfLines={1}>
            {destName || `${destLat.toFixed(5)}, ${destLng.toFixed(5)}`}
          </Text>
        </View>
      </View>

      {/*  */}
      <View style={styles.modeRow}>
        {MODE_OPTIONS.map(opt => (
          <TouchableOpacity
            key={opt.key}
            style={[styles.modeBtn, naviMode === opt.key && styles.modeBtnActive]}
            onPress={() => handleModeChange(opt.key)}
          >
            <Text style={styles.modeIcon}>{opt.icon}</Text>
            <Text style={[styles.modeLabel, naviMode === opt.key && styles.modeLabelActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/*  */}
      {isLoading && (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color="#007AFF" />
          <Text style={styles.loadingText}>规划路线中...</Text>
        </View>
      )}
      {errorMsg ? (
        <Text style={styles.errorMsg}>{errorMsg}</Text>
      ) : null}
      {/* 路线选择 */}
      {recommendedRoute && !isLoading && (
        <View style={styles.routeOptionsContainer}>
          <TouchableOpacity
            style={[styles.routeOptionCard, selectedRouteKey === 'recommended' && styles.routeOptionSelected]}
            onPress={() => alternateRoute && handleSelectRoute('recommended')}
            activeOpacity={0.7}
          >
            <View style={styles.routeOptionHeader}>
              <View style={[styles.routeOptionDot, { backgroundColor: '#007AFF' }]} />
              <Text style={styles.routeOptionLabel}>推荐路线</Text>
              <Text style={styles.routeOptionDist}>{formatDist(recommendedRoute.totalDistance)}</Text>
            </View>
            <Text style={styles.routeOptionTime}>耗时 {formatDuration(recommendedRoute.totalDuration)}</Text>
          </TouchableOpacity>
          {alternateRoute && (
            <TouchableOpacity
              style={[styles.routeOptionCard, selectedRouteKey === 'alternate' && styles.routeOptionSelected]}
              onPress={() => handleSelectRoute('alternate')}
              activeOpacity={0.7}
            >
              <View style={styles.routeOptionHeader}>
                <View style={[styles.routeOptionDot, { backgroundColor: '#90CAF9' }]} />
                <Text style={styles.routeOptionLabel}>备选路线</Text>
                <Text style={styles.routeOptionDist}>{formatDist(alternateRoute.totalDistance)}</Text>
              </View>
              <Text style={styles.routeOptionTime}>耗时 {formatDuration(alternateRoute.totalDuration)}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* */}
      <TouchableOpacity
        style={[styles.startBtn, isLoading && styles.startBtnDisabled]}
        onPress={handleStartNavi}
        disabled={isLoading || !!errorMsg}
      >
        <Text style={styles.startBtnText}>
          {isLoading ? '准备中...' : '开始导航'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  // === ===
  const renderNavigating = () => {
    const state = navState;

    // e
    const containerHeight = slideAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [72, 196], // 2px()96px()
    });

    return (
      <Animated.View
        {...panResponder.panHandlers}
        style={[
          styles.panel,
          { height: containerHeight, overflow: 'hidden' }
        ]}
      >
        {/* */}
        <View style={styles.collapsedBar}>
          <Text style={styles.collapsedMode}>
            {state.mode === 'drive' ? '🚗 驾车' : '🚶 步行'}
          </Text>
          <GpsSignalIndicator quality={state.gpsSignal.quality || 'none'} />
          <Text style={styles.collapsedDest} numberOfLines={1}>
            {destName || ''}
          </Text>
          <TouchableOpacity onPress={handleStopNavi} style={styles.exitBtnSmall} activeOpacity={0.5}>
            <Text style={styles.exitBtnSmallText}>退出</Text>
          </TouchableOpacity>
        </View>

        {/*  */}
        <View style={styles.expandedContent}>
          {/* 重规划路线选择 */}
          {rerouteOptions && (
            <View style={styles.rerouteBanner}>
              <Text style={styles.rerouteBannerText}>已重新规划，请选择路线：</Text>
              <View style={styles.rerouteBtnRow}>
                <TouchableOpacity
                  style={[styles.rerouteBtn, { backgroundColor: '#007AFF' }]}
                  onPress={() => {
                    selectReroute('recommended');
                    setRerouteOptions(null);
                    if (mapRef.current && rerouteOptions) {
                      mapRef.current.clearAlternateRoute();
                    }
                  }}
                >
                  <Text style={styles.rerouteBtnText}>推荐路线 {formatDist(rerouteOptions.recommended.totalDistance)}</Text>
                </TouchableOpacity>
                {rerouteOptions.alternate && (
                  <TouchableOpacity
                    style={[styles.rerouteBtn, { backgroundColor: '#64B5F6' }]}
                    onPress={() => {
                      selectReroute('alternate');
                      setRerouteOptions(null);
                      if (mapRef.current && rerouteOptions) {
                        mapRef.current.clearAlternateRoute();
                      }
                    }}
                  >
                    <Text style={styles.rerouteBtnText}>备选路线 {formatDist(rerouteOptions.alternate.totalDistance)}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
          {/*  */}
          <View style={styles.instructionRow}>
            <Text style={styles.instructionText} numberOfLines={2}>
              {statusText}
            </Text>
          </View>

          {/* / */}
          <View style={styles.naviStats}>
            <View style={styles.statItem}>
              <Text style={styles.statValue}>
                {state ? formatDist(state.remainingDistance) : '--'}
              </Text>
              <Text style={styles.statLabel}>剩余距离</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>
                {state ? formatDuration(state.remainingDuration) : '--'}
              </Text>
              <Text style={styles.statLabel}>剩余时间</Text>
            </View>
          </View>
        </View>
      </Animated.View>
    );
  };

  return (
    <View style={styles.overlayContainer} pointerEvents="box-none">
      {visible && (
        <>
          {/* \ */}
          {setupMode && (
            <View style={styles.overlayBackdrop} pointerEvents="auto" />
          )}
          {/*  */}
          <View style={styles.container}>
            {setupMode ? renderSetup() : renderNavigating()}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlayContainer: {
    position: 'absolute',
    left: 0, right: 0, top: 0, bottom: 0,
    zIndex: 1000,
  },
  overlayBackdrop: {
    position: 'absolute',
    left: 0, right: 0, top: 0, bottom: 0,
  },
  container: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 12,
  },

  // 
  panel: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },

  // 
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeBtnText: {
    fontSize: 16,
    color: '#666',
    fontWeight: 'bold',
  },

  // 
  routeInfo: {
    paddingLeft: 8,
    marginBottom: 12,
  },
  routeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  startDot: {
    backgroundColor: '#4CAF50',
  },
  endDot: {
    backgroundColor: '#E53935',
  },
  routeLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
    marginRight: 6,
  },
  routeLine: {
    width: 2,
    height: 16,
    backgroundColor: '#ddd',
    marginLeft: 12,
  },
  routeText: {
    fontSize: 13,
    color: '#666',
    flex: 1,
  },

  // 
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  modeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#f5f5f5',
    borderWidth: 1.5,
    borderColor: '#eee',
  },
  modeBtnActive: {
    backgroundColor: '#E3F2FD',
    borderColor: '#007AFF',
  },
  modeIcon: {
    fontSize: 16,
    marginRight: 4,
  },
  modeLabel: {
    fontSize: 14,
    color: '#666',
    fontWeight: '600',
  },
  modeLabelActive: {
    color: '#007AFF',
  },

  // /
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    gap: 8,
  },
  loadingText: {
    fontSize: 13,
    color: '#888',
  },
  errorMsg: {
    fontSize: 13,
    color: '#E53935',
    textAlign: 'center',
    paddingVertical: 8,
  },
  previewRow: {
    paddingVertical: 8,
    alignItems: 'center',
  },
  previewText: {
    fontSize: 13,
    color: '#555',
  },

  // 
  startBtn: {
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  startBtnDisabled: {
    opacity: 0.6,
  },
  startBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: 'bold',
  },

  // === ===
  // 
  collapseHandle: {
    alignItems: 'center',
    paddingVertical: 6,
    marginTop: -8,
  },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#ddd',
    marginBottom: 2,
  },
  handleArrow: {
    fontSize: 10,
    color: '#aaa',
    lineHeight: 12,
  },
  collapsedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 12,
  },
  collapsedMode: {
    fontSize: 16,
    marginRight: 6,
  },
  collapsedDest: {
    flex: 1,
    fontSize: 14,
    fontWeight: 'bold',
    color: '#333',
  },
  collapsedStats: {
    fontSize: 12,
    color: '#666',
    marginHorizontal: 8,
  },
  exitBtnSmall: {
    backgroundColor: '#E53935',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 5,
    overflow: 'hidden',
  },
  exitBtnSmallText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },

  expandedContent: {
    // 
  },
  instructionRow: {
    backgroundColor: '#F0F8FF',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  instructionText: {
    fontSize: 16,
    color: '#333',
    lineHeight: 22,
  },

  naviStats: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f9f9f9',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#333',
  },
  statLabel: {
    fontSize: 11,
    color: '#999',
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 24,
    backgroundColor: '#e0e0e0',
  },

  signalContainer: {
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.05)',
    marginLeft: 4,
  },
  signalIcon: {
    fontSize: 10,
    fontWeight: 'bold',
    letterSpacing: -1,
  },

  // 路线选择卡片
  routeOptionsContainer: {
    marginBottom: 8,
    gap: 6,
  },
  routeOptionCard: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#f5f5f5',
    borderWidth: 1.5,
    borderColor: '#eee',
  },
  routeOptionSelected: {
    borderColor: '#007AFF',
    backgroundColor: '#E3F2FD',
  },
  routeOptionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  routeOptionDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  routeOptionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
    flex: 1,
  },
  routeOptionDist: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#333',
  },
  routeOptionTime: {
    fontSize: 11,
    color: '#888',
    marginTop: 2,
    marginLeft: 18,
  },

  // 重规划选择
  rerouteBanner: {
    backgroundColor: '#FFF3E0',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  rerouteBannerText: {
    fontSize: 13,
    color: '#E65100',
    fontWeight: '600',
    marginBottom: 8,
  },
  rerouteBtnRow: {
    flexDirection: 'row',
    gap: 8,
  },
  rerouteBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  rerouteBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: 'bold',
  },
});

