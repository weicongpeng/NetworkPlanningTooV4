/**
 * NavigationPanel - 全功能导航面板
 *
 * 三种状态：
 * 1. 设置模式：选择出行方式，确认起点/终点，点击"开始导航"
 * 2. 导航中：显示实时导航信息（剩余距离、时间、下一指令）
 * 3. 结束：导航完成摘要
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  LayoutAnimation, Platform, UIManager,
  Animated, PanResponder,
} from 'react-native';
import { useMapStore } from '../../store/mapStore';

// Android 需要启用 LayoutAnimation
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { MapViewRef } from '../Map/MapView';
import {
  requestLocationPermission, getCurrentPosition, planRoute,
  startNavigation, stopNavigation, isNavigating,
  onNaviStateChange, NaviStateSnapshot, NaviMode, GpsSignalQuality,
} from '../../services/navigationService';
import { wgs84ToGcj02 } from '../../utils/coordinate';

interface Props {
  visible: boolean;
  destLat: number;   // WGS84
  destLng: number;   // WGS84
  destName: string;
  onClose: () => void;
  mapRef?: React.RefObject<MapViewRef>;
  // 可指定起点（null = 使用GPS自动获取）
  originLat?: number;
  originLng?: number;
  // 导航面板显示状态回调，用于隐藏/显示顶部工具栏
  onPanelVisibleChange?: (visible: boolean) => void;
}

/** 定位信号质量指示器（GPS/网络定位综合信号） */
function GpsSignalIndicator({ quality }: { quality: GpsSignalQuality }) {
  const config: Record<GpsSignalQuality, { icon: string; color: string; label: string }> = {
    excellent: { icon: '●●●●', color: '#4CAF50', label: '定位信号强' },
    good: { icon: '●●●○', color: '#8BC34A', label: '定位信号良好' },
    weak: { icon: '●●○○', color: '#FF9800', label: '信号弱(网络定位)' },
    none: { icon: '●○○○', color: '#F44336', label: '无定位信号' },
  };
  const { icon, color, label } = config[quality];
  return (
    <View style={styles.signalContainer}>
      <Text style={[styles.signalIcon, { color }]}>{icon}</Text>
    </View>
  );
}

/** 格式化距离 */
function formatDist(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

/** 格式化时长（秒） */
function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

const MODE_OPTIONS: { key: NaviMode; label: string; icon: string }[] = [
  { key: 'drive', label: '驾车', icon: '🚗' },
  { key: 'walk', label: '步行', icon: '🚶' },
  { key: 'bicycling', label: '骑行', icon: '🚲' },
];

export default function NavigationPanel({
  visible, destLat, destLng, destName, onClose, mapRef, originLat, originLng, onPanelVisibleChange,
}: Props) {
  // 设置阶段
  const [setupMode, setSetupMode] = useState(true);
  const [naviMode, setNaviMode] = useState<NaviMode>('drive');
  const [startPos, setStartPos] = useState<{ lat: number; lng: number } | null>(null);
  const [routePreview, setRoutePreview] = useState<{
    distance: number; duration: number;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const gpsSignal = useMapStore(s => s.gpsSignal);

  // 导航中
  const [navState, setNavState] = useState<NaviStateSnapshot | null>(null);
  const [statusText, setStatusText] = useState('准备导航...');
  const [panelExpanded, setPanelExpanded] = useState(true);
  // 用于在导航模式下重新绘制路线（解决setupMode cleanup时序问题）
  const [naviRouteKey, setNaviRouteKey] = useState(0);

  // 面板滑动动画
  const slideAnim = useRef(new Animated.Value(1)).current;
  const panY = useRef(0);

  // 切换展开/折叠（带动画）
  const animatePanel = useCallback((expanded: boolean) => {
    setPanelExpanded(expanded);
    Animated.timing(slideAnim, {
      toValue: expanded ? 1 : 0,
      duration: 250,
      useNativeDriver: false, // height动画不支持native driver
    }).start();
  }, [slideAnim]);

  const togglePanel = useCallback(() => {
    animatePanel(!panelExpanded);
  }, [panelExpanded, animatePanel]);

  // 滑动手势 - 整个面板可上下滑动
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // 只响应垂直滑动
        return Math.abs(gestureState.dy) > 5 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx);
      },
      onPanResponderMove: (_, gestureState) => {
        // 根据滑动方向实时更新动画值
        if (panelExpanded) {
          // 展开状态：向下滑动收起
          const newValue = Math.max(0, 1 - gestureState.dy / 100);
          slideAnim.setValue(Math.min(1, newValue));
        } else {
          // 收起状态：向上滑动展开
          const newValue = Math.min(1, -gestureState.dy / 100);
          slideAnim.setValue(Math.max(0, newValue));
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (panelExpanded) {
          // 展开状态：向下滑动超过阈值则收起
          if (gestureState.dy > 30) {
            animatePanel(false);
          } else {
            animatePanel(true);
          }
        } else {
          // 收起状态：向上滑动超过阈值则展开
          if (gestureState.dy < -30) {
            animatePanel(true);
          } else {
            animatePanel(false);
          }
        }
      },
    })
  ).current;

  // 重置状态
  const resetState = useCallback(() => {
    setSetupMode(true);
    setRoutePreview(null);
    setNavState(null);
    setErrorMsg('');
    setStatusText('准备导航...');
    setIsLoading(false);
  }, []);

  // 可见性变化 - 重置状态
  useEffect(() => {
    if (visible) {
      resetState();
      // 导航面板显示时立即隐藏顶部工具栏（包括预览阶段）
      onPanelVisibleChange?.(false);
    } else {
      // 导航面板关闭时恢复顶部工具栏
      onPanelVisibleChange?.(true);
    }
  }, [visible]);

  // 监听导航状态
  useEffect(() => {
    const unsub = onNaviStateChange((state) => {
      // 如果导航已结束，忽略状态更新（避免停止后的延迟刷新）
      if (!state.isNavigating) {
        return;
      }
      setNavState(state);
      if (state.isNavigating && state.routeData) {
        const step = state.routeData.steps[state.currentStepIndex];
        if (step) {
          setStatusText(step.instruction || '导航中...');
        }
      }
      // 导航中更新地图上的用户位置（含方向角）
      if (state.isNavigating && state.currentPosition && mapRef?.current) {
        const [gcjLat, gcjLng] = wgs84ToGcj02(
          state.currentPosition[0],
          state.currentPosition[1],
        );
        const heading = state.heading !== null && state.heading !== undefined ? state.heading : undefined;
        mapRef.current.updateUserLocation(gcjLat, gcjLng, heading);
        // 启动 auto-fit：用户 3 秒无操作后自动恢复到当前位置+zoom=18
        mapRef.current.startAutoFit();
      }
    });
    return unsub;
  }, []);

  // 进入导航模式后重新绘制路线（解决setupMode cleanup时序导致路线消失的问题）
  useEffect(() => {
    if (setupMode || !startPos || !mapRef?.current || naviRouteKey === 0) return;
    let cancelled = false;
    (async () => {
      const route = await planRoute(
        [startPos.lat, startPos.lng],
        [destLat, destLng],
        naviMode,
      );
      if (cancelled || !route || !mapRef?.current) return;
      mapRef.current.clearRoute();
      mapRef.current.addRoute(route.flatPolyline);
      mapRef.current.fitRouteBounds(route.flatPolyline, route.totalDistance);
      const [gcjLat, gcjLng] = wgs84ToGcj02(startPos.lat, startPos.lng);
      mapRef.current.updateUserLocation(gcjLat, gcjLng);
      // 启用 auto-fit: 用户3秒无操作自动恢复到当前位置+zoom=18
      mapRef.current.startAutoFit();
    })();
    return () => { cancelled = true; };
  }, [naviRouteKey]);

  // 获取起点
  const getOrigin = useCallback(async () => {
    if (originLat !== undefined && originLng !== undefined) {
      return { lat: originLat, lng: originLng };
    }
    const pos = await getCurrentPosition();
    if (pos) return pos;
    if (startPos) {
      console.log('[NavigationPanel] getOrigin: 定位失败，使用已有起点坐标');
      return startPos;
    }
    return null;
  }, [originLat, originLng, startPos]);

  // 加载路线预览
  useEffect(() => {
    if (!visible || !setupMode) return;
    (async () => {
      setIsLoading(true);
      setErrorMsg('');
      const origin = await getOrigin();
      if (!origin) {
        setErrorMsg('无法获取当前位置，请确保已开启定位权限并移至开阔区域');
        setIsLoading(false);
        return;
      }
      setStartPos(origin);
      // 预览路线
      try {
        const route = await planRoute(
          [origin.lat, origin.lng],
          [destLat, destLng],
          naviMode,
        );
        if (route) {
          setRoutePreview({ distance: route.totalDistance, duration: route.totalDuration });
          // 在地图上绘制路线预览
          if (mapRef?.current) {
            mapRef.current.clearRoute();
            mapRef.current.addRoute(route.flatPolyline);
            mapRef.current.fitRouteBounds(route.flatPolyline, route.totalDistance);
            // 显示目的地标记（带名称标签）
            const [destGcjLat, destGcjLng] = wgs84ToGcj02(destLat, destLng);
            mapRef.current.showDestinationMarker(destGcjLat, destGcjLng, destName);
            // 如果有起点坐标，也移动视野到起点附近作为兜底
            if (origin) {
              const [gcjLat, gcjLng] = wgs84ToGcj02(origin.lat, origin.lng);
              mapRef.current.updateUserLocation(gcjLat, gcjLng);
            }
          }
        } else {
          setErrorMsg('未找到可用的导航路线');
        }
      } catch (e: any) {
        setErrorMsg(e?.message || '路线规划失败，请检查网络');
      }
      setIsLoading(false);
    })();
    return () => {
      // 关闭时清除路线和标记
      if (mapRef?.current && !isNavigating()) {
        mapRef.current.clearRoute();
        mapRef.current.hideDestinationMarker();
      }
    };
  }, [visible, setupMode, naviMode]);

  // 模式切换时重新加载预览
  const handleModeChange = (mode: NaviMode) => {
    setNaviMode(mode);
    setRoutePreview(null);
    setErrorMsg('');
  };

  // 开始导航
  const handleStartNavi = async () => {
    setIsLoading(true);
    const success = await startNavigation(
      { lat: destLat, lng: destLng },
      destName,
      naviMode,
      startPos || undefined,
    );
    setIsLoading(false);
    if (success) {
      setSetupMode(false);
      // 在地图上显示目的地标记（带小区名称标签）
      if (mapRef?.current) {
        const [destGcjLat, destGcjLng] = wgs84ToGcj02(destLat, destLng);
        mapRef.current.showDestinationMarker(destGcjLat, destGcjLng, destName);
      }
      // 导航开始时立即将地图视图切换到当前位置，zoom=19
      if (mapRef?.current && startPos) {
        const [gcjLat, gcjLng] = wgs84ToGcj02(startPos.lat, startPos.lng);
        mapRef.current.moveCamera(gcjLat, gcjLng, 19);
      }
      // 启动 auto-fit：用户3秒无操作自动恢复到当前位置+zoom=19
      if (mapRef?.current) {
        mapRef.current.startAutoFit();
      }
      // 触发 naviRouteKey 变化，让 useEffect 绘制路线（延迟确保 setupMode cleanup 先运行）
      setTimeout(() => setNaviRouteKey(k => k + 1), 50);
    } else {
      setErrorMsg('导航启动失败，请检查GPS和网络连接');
    }
  };

  // 结束导航
  const handleStopNavi = useCallback(() => {
    stopNavigation();
    if (mapRef?.current) {
      mapRef.current.stopAutoFit();
      mapRef.current.clearRoute();
      mapRef.current.hideDestinationMarker();
      mapRef.current.clearUserLocation();
      setTimeout(() => {
        mapRef.current?.hideDestinationMarker();
        mapRef.current?.clearRoute();
      }, 100);
    }
    setSetupMode(true);
    setNavState(null);
    setStatusText('准备导航...');
    onClose();
  }, [mapRef, onClose]);

  // 关闭（非导航状态）
  const handleClose = () => {
    if (isNavigating()) return; // 导航中不能关闭
    if (mapRef?.current) {
      mapRef.current.clearRoute();
      mapRef.current.hideDestinationMarker();
      mapRef.current.clearUserLocation();
    }
    onClose();
  };

  if (!visible) return null;

  // === 导航设置界面 ===
  const renderSetup = () => (
    <View style={styles.panel}>
      {/* 标题 */}
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>{destName || '目的地'}</Text>
        <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>✕</Text>
        </TouchableOpacity>
      </View>

      {/* 起点/终点信息 */}
      <View style={styles.routeInfo}>
        <View style={styles.routeRow}>
          <View style={[styles.dot, styles.startDot]} />
          <Text style={styles.routeText} numberOfLines={1}>
            {startPos ? `${startPos.lat.toFixed(5)}, ${startPos.lng.toFixed(5)}` : '获取位置中...'}
          </Text>
          {gpsSignal.quality !== 'none' && (
            <GpsSignalIndicator quality={gpsSignal.quality} />
          )}
        </View>
        <View style={styles.routeLine} />
        <View style={styles.routeRow}>
          <View style={[styles.dot, styles.endDot]} />
          <Text style={styles.routeText} numberOfLines={1}>
            {destName || `${destLat.toFixed(5)}, ${destLng.toFixed(5)}`}
          </Text>
        </View>
      </View>

      {/* 模式选择 */}
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

      {/* 路线预览 */}
      {isLoading && (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color="#007AFF" />
          <Text style={styles.loadingText}>正在规划路线...</Text>
        </View>
      )}
      {errorMsg ? (
        <Text style={styles.errorMsg}>{errorMsg}</Text>
      ) : null}
      {routePreview && !isLoading && (
        <View style={styles.previewRow}>
          <Text style={styles.previewText}>
            距离: {formatDist(routePreview.distance)} | 预计: {formatDuration(routePreview.duration)}
          </Text>
        </View>
      )}

      {/* 开始导航按钮 */}
      <TouchableOpacity
        style={[styles.startBtn, isLoading && styles.startBtnDisabled]}
        onPress={handleStartNavi}
        disabled={isLoading || !!errorMsg}
      >
        <Text style={styles.startBtnText}>
          {isLoading ? '规划中...' : '开始导航'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  // === 导航中界面 ===
  const renderNavigating = () => {
    const state = navState;

    // 面板容器高度动画：收起时只保留顶部信息条高度，展开时刚好包裹内容无留白
    const containerHeight = slideAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [72, 196], // 收起时72px(只显示信息条)，展开时196px(刚好容纳内容)
    });

    return (
      <Animated.View
        {...panResponder.panHandlers}
        style={[
          styles.panel,
          { height: containerHeight, overflow: 'hidden' }
        ]}
      >
        {/* 精简信息条（始终可见） */}
        <View style={styles.collapsedBar}>
          <Text style={styles.collapsedMode}>
            {state?.mode === 'drive' ? '🚗' : state?.mode === 'walk' ? '🚶' : '🚲'}
          </Text>
          <GpsSignalIndicator quality={state?.gpsSignal?.quality || 'none'} />
          <Text style={styles.collapsedDest} numberOfLines={1}>
            → {destName || '目的地'}
          </Text>
          <TouchableOpacity onPress={handleStopNavi} style={styles.exitBtnSmall} activeOpacity={0.5}>
            <Text style={styles.exitBtnSmallText}>结束</Text>
          </TouchableOpacity>
        </View>

        {/* 展开内容 */}
        <View style={styles.expandedContent}>
          {/* 下一路口指示 */}
          <View style={styles.instructionRow}>
            <Text style={styles.instructionText} numberOfLines={2}>
              {statusText}
            </Text>
          </View>

          {/* 距离/时间信息 */}
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
              <Text style={styles.statLabel}>预计剩余</Text>
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
          {/* 遮罩层：阻止点击地图区域（不可关闭面板，仅阻挡触摸穿透） */}
          {setupMode && (
            <View style={styles.overlayBackdrop} pointerEvents="auto" />
          )}
          {/* 底部面板 */}
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

  // 通用面板
  panel: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },

  // 头部
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    flex: 1,
    marginRight: 8,
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

  // 路线信息
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

  // 模式选择
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

  // 加载/错误
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

  // 开始按钮
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

  // === 导航中 ===
  // 折叠手柄
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
    // 展开内容的容器样式
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
});
