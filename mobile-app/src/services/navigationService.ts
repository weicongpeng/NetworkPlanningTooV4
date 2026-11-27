/**
 * 
 * GPS API  TTS
 * 
 * 
 * - NWiFi/)GPS
 * -  accuracy GPS 
 * -  GPS N
 */
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import * as KeepAwake from 'expo-keep-awake';
import * as TaskManager from 'expo-task-manager';
import { AppState, AppStateStatus, Platform } from 'react-native';
import axios from 'axios';
import { wgs84ToGcj02 } from '../utils/coordinate';
import { getEffectiveApiUrl } from '../utils/config';
import { useMapStore } from '../store/mapStore';
import { compassService } from './compassService';

/** */
const LOCATION_TASK_NAME = 'navi-background-location-task';

/** API */
async function getDirectionProxyUrl(): Promise<string> {
  const apiUrl = await getEffectiveApiUrl();
  return `${apiUrl}/map/direction`;
}

export type NaviMode = 'drive' | 'walk' | 'bicycling';

/** GPS */
export type GpsSignalQuality = 'excellent' | 'good' | 'weak' | 'none';

/** GPS */
export interface GpsSignalInfo {
  quality: GpsSignalQuality;
  accuracy: number | null;
  source: 'gps' | 'network' | 'cache' | 'ip' | 'amap-web' | 'unknown';
  lastUpdateTime: number;
}

/**  */
export interface RouteStep {
  instruction: string;
  polyline: [number, number][];  // [lng, lat][] GCJ-02
  distance: number;
  duration: number;
  road: string;
}

/**  */
export interface RouteData {
  steps: RouteStep[];
  totalDistance: number;
  totalDuration: number;
  flatPolyline: [number, number][];  // [lng, lat] GCJ-02
  /** 每个步骤终点在 flatPolyline 中的索引（长度 === steps.length）。
   *  必须在解析路线时通过简化映射计算，不能用"原始 steps 点数累计"代替——
   *  flatPolyline 经过 simplifyPolyline 抽稀，两套索引体系不一致会导致
   *  路口播报/步骤切换定位错误（历史上"路口不播报"的根因）。 */
  stepEndFlatIndices: number[];
  origin: [number, number];
  destination: [number, number];
}

/** */
export interface NaviStateSnapshot {
  isNavigating: boolean;
  currentStepIndex: number;
  currentPosition: [number, number] | null;  // WGS84
  heading: number | null;
  prevStepEndIndex: number;  // flatPolyline 上的索引
  remainingDistance: number;  // 米
  remainingDuration: number;  // 秒
  elapsedSec: number;
  destLat: number;
  destLng: number;
  destName: string;
  mode: NaviMode;
  routeData: RouteData | null;
  currentSpeedMps: number;  // m/s
  gpsSignal: GpsSignalInfo;
  rerouteOptions: { recommended: RouteData; alternate: RouteData | null } | null;
  /** 到达终点播报文案（非 null 表示已到达终点，用于 UI 文字播报） */
  arrivalMessage: string | null;
}

type NaviCallback = (state: NaviStateSnapshot) => void;

// ===  ===
let _isNavigating = false;
let _routeData: RouteData | null = null;
let _currentStepIndex = 0;
let _currentPosition: [number, number] | null = null;   // WGS84
let _currentPositionGcj: [number, number] | null = null; // GCJ-02
let _currentHeading: number | null = null;              // 
let _destLat = 0;
let _destLng = 0;
let _destName = '';
let _mode: NaviMode = 'drive';
let _elapsedSec = 0;
let _timerInterval: ReturnType<typeof setInterval> | null = null;
let _locationSub: Location.LocationSubscription | null = null;
// _headingSub 已废弃：compassService 自管理生命周期，保留变量仅为兼容旧引用
let _headingSub: { remove: () => void } | null = null;
let _compassHeading: number | null = null;  // 罗盘磁力计朝向（更实时，已支持竖屏）
let _lastHeadingNotifyTime = 0;              // 上次因朝向变化触发 notify 的时间
const HEADING_NOTIFY_MIN_INTERVAL = 100;     // 朝向变化通知最小间隔(ms)，避免过于频繁
// === heading 源按速度切换 ===
// 磁力计罗盘在静止/低速时实时反映手机朝向；但行车时车内金属+发动机电磁+颠簸
// 会让磁力计持续乱跳（死区/跳变确认只能滤瞬时干扰，挡不住持续抖动）。
// 高速行驶时 GPS heading（速度向量方向）稳定且与行驶方向一致，应优先使用。
let _headingSource: 'compass' | 'gps' = 'compass';
let _gpsHeadingStreak = 0;                   // 连续满足"GPS heading 可用且速度足够"的次数
const HEADING_GPS_MIN_SPEED = 3.5;           // 切换到 GPS heading 的速度阈值(m/s ≈ 12.6km/h)
const HEADING_COMPASS_MAX_SPEED = 2.5;       // 回落罗盘的速度阈值(m/s)，迟滞防止边界抖动
const HEADING_GPS_CONFIRM_COUNT = 2;         // 连续 N 次满足才切换，防抖
// === heading 输出层低通平滑（最后防线，与来源无关）===
// 速度切换依赖可靠的速度值：网络定位的 speed 常为 null/0、内部速度滞后数秒，
// 低速场景(步行/电动车/堵车)永远用罗盘，手持抖动(10-30°快速往复)直接传导到图标。
// 一阶指数低通 tau=200ms：10Hz 抖动衰减约 13 倍(10°→<1°)，90° 转弯 ~460ms 达 90%，
// 视觉上表现为图标平滑转动而非抖动。
let _headingSmoothed: number | null = null;
let _headingSmoothTime = 0;
const HEADING_SMOOTH_TAU_MS = 200;
const HEADING_OUTPUT_DEADZONE = 1.5;         // 输出死区(°)，滤除平滑残差

/** 最短角度差，结果 [-180, 180) */
function shortestAngleDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
function norm360(a: number): number { return ((a % 360) + 360) % 360; }

/** 对输出给 UI 的 heading 做一阶指数低通 + 死区；返回平滑后的角度 */
function smoothHeadingOutput(target: number): number {
  const now = Date.now();
  if (_headingSmoothed === null || _headingSmoothTime === 0) {
    _headingSmoothed = norm360(target);
    _headingSmoothTime = now;
    return _headingSmoothed;
  }
  const dt = Math.min(500, Math.max(16, now - _headingSmoothTime));
  _headingSmoothTime = now;
  const delta = shortestAngleDelta(_headingSmoothed, norm360(target));
  if (Math.abs(delta) <= HEADING_OUTPUT_DEADZONE) return _headingSmoothed;
  const alpha = dt / (HEADING_SMOOTH_TAU_MS + dt);
  _headingSmoothed = norm360(_headingSmoothed + alpha * delta);
  return _headingSmoothed;
}
let _lastSpokenStepIndex = -1;
let _callbacks: NaviCallback[] = [];
let _arrivalCallback: (() => void) | null = null;
// 到达终点状态：_arrived 防止位置连续更新重复触发播报；_arrivalMessage 同步给 UI 做文字播报
let _arrived = false;
let _arrivalMessage: string | null = null;
let _elapsedTimer: ReturnType<typeof setInterval> | null = null;
let _startTime = 0;
let _autoHideTimer: ReturnType<typeof setTimeout> | null = null;
let _locationTrackingActive = false;
let _rerouteOptions: { recommended: RouteData; alternate: RouteData | null } | null = null;

// 
let _isKeepAwakeActive = false;
let _appState: AppStateStatus = 'active';
let _isPausedDueToBackground = false;
let _wasNavigatingBeforePause = false;

// GPS
let _cachedPosition: { lat: number; lng: number; timestamp: number; accuracy: number; source: string } | null = null;
const POSITION_CACHE_TTL = 5 * 60 * 1000; // 5
// 缓存"快路径"门槛：仅足够新鲜且高精度的缓存才直接命中作为导航起点。
// 宽松缓存(5分钟/低精度)只作为所有实时定位失败后的最后兜底——
// 否则 5 分钟前的位置(用户可能已移动数公里)或 IP 城市级缓存(精度5km)
// 会被直接当作规划起点，导致室内导航规划错误。
const CACHE_FAST_PATH_MAX_AGE_MS = 60 * 1000;
const CACHE_FAST_PATH_MAX_ACCURACY = 50;
// 系统 lastKnown 兜底：不满足快路径门槛但系统认为仍可信的最近位置，
// 在所有实时定位失败时优于 IP 城市级中心(通常精度远好于 5km)
let _lastKnownFallback: { lat: number; lng: number; accuracy: number; timestamp: number } | null = null;

// 高德 Web 模糊定位提供者（由 MapView 的 WebView 注册，室内无 GPS 时兜底）
type AmapWebLocationResult = { lat: number; lng: number; accuracy: number; source: string } | null;
let _amapLocationProvider: (() => Promise<AmapWebLocationResult>) | null = null;
export function registerAmapLocationProvider(fn: (() => Promise<AmapWebLocationResult>) | null) {
  _amapLocationProvider = fn;
}

// GPS
let _gpsSignal: GpsSignalInfo = {
  quality: 'none',
  accuracy: null,
  source: 'unknown',
  lastUpdateTime: 0,
};
let _lastPositionUpdateTime = 0;
let _signalCheckTimer: ReturnType<typeof setInterval> | null = null;
let _tunnelModeTimer: ReturnType<typeof setInterval> | null = null;
let _tunnelModeActive = false;
let _speedBeforeTunnel = 0; // 进入隧道前的速度 (m/s)
let _lastGpsPositionBeforeTunnel: [number, number] | null = null; // 最后一个有效GPS位置
const SIGNAL_CHECK_INTERVAL = 5000;
const SIGNAL_NONE_TIMEOUT = 15000;
const TUNNEL_MODE_START_TIMEOUT = 10000; // GPS丢失10秒后进入隧道模式
const TUNNEL_PREDICTION_INTERVAL = 2000; // 隧道模式位置预测间隔
const GPS_ACCURACY_EXCELLENT = 10;
const GPS_ACCURACY_GOOD = 30;
const GPS_ACCURACY_WEAK = 100;
// lastKnown 位置仅在足够新鲜(≤30s)且精度可接受(≤100m)时才直接采用；
// 否则视为历史位置（如刚从户外进入室内），继续走基站/WiFi 网络定位竞速，避免按历史位置规划
const LAST_KNOWN_FRESH_MS = 30 * 1000;
const NETWORK_ACCURACY_THRESHOLD = 65;

// 
let _currentTrackingAccuracy: Location.Accuracy = Location.Accuracy.BestForNavigation;
let _accuracySwitchCooldown = 0;
const ACCURACY_SWITCH_COOLDOWN = 15000;

// 
let _approachingSpoken: Set<number> = new Set();

// 
let _lastDeviateCheckTime = 0;
let _deviateAlertGiven = false;
let _deviateConfirmCount = 0; // 连续检测到偏航的次数
let _routeStartIdx = 0;
let _isRerouting = false;
let _startedWithFuzzyOrigin = false; // 以网络/IP 模糊定位起步的导航，GPS/北斗恢复后自动重规划一次
let _plannedOrigin: [number, number] | null = null; // 规划路线时使用的起点 [lat, lng] WGS84，用于判断起步模糊定位的偏差
const FUZZY_ORIGIN_REROUTE_MIN_OFFSET = 150; // 精确位置与规划起点偏差超过该值(米)才触发自动重规划
const NO_POSITION_DOWNGRADE_TIMEOUT = 8000; // 启动追踪后无任何位置回调的超时降级阈值(ms)

let _lastDeviateAlertTime = 0;
let _rerouteSuccessCount = 0;
// GPS
let _stepEntryIndex = 0;  // flatPolyline
let _stepForwardProgress = 0;  // .0-1.0
let _lastForwardNearestIdx = 0;  // 
let _forwardOnlyMode = false;  // 
let _lastSpokenTime = 0;  // 
let _stepTransitionCooldown = 0;  //
const STEP_TRANSITION_COOLDOWN_MS = 8000;  //
let _distanceTraveledInStep = 0;  //
const MIN_DISTANCE_TO_TRANSITION = 50;  //
const MIN_DISTANCE_FOR_NEXT_STEP = 20;  //

// ========== 提前播报系统（精简版） ==========
// 设计原则：
// 1. 启动时播报全程总览（距离/耗时）
// 2. 行程中仅在路口前 ~100 米播报一次转向指导
// 3. 移除远距离提前播报和路口兜底播报，避免冗余打扰
// 播报阶段：near(路口前 100 米指导)
type AnnouncePhase = 'near';
// 记录每个步骤已播报的阶段，避免重复播报
// key: stepIndex, value: Set<AnnouncePhase>
let _announcedPhases: Map<number, Set<AnnouncePhase>> = new Map();
// 上次播报时间戳，用于全局防抖
let _lastAnnounceTime = 0;
// 最小播报间隔（毫秒），避免连续播报堆积
const MIN_ANNOUNCE_INTERVAL_MS = 2500;
// 路口播报距离：基础 100 米，高速时按速度自适应提前
const ANNOUNCE_NEAR_BASE_DIST = 100;      // 基础距离（米）- 用户要求路口前 100 米播报
const ANNOUNCE_NEAR_SPEED_FACTOR = 4;     // 速度乘数（秒）：dist = max(100, speed * 4)
const ANNOUNCE_NEAR_MAX_DIST = 300;       // 最近提前距离上限（米）
// 复杂路口额外提前距离（匝道/环岛/多分叉）
const COMPLEX_INTERSECTION_EXTRA_DIST = 100;

/**
 * Bexpo-task-manager 
 *
 * Location.startLocationUpdatesAsync 
 * ""
 *
 * 
 * 1. UI 
 * 2. UI
 *    UI 
 */
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error('[NaviService] :', error.message);
    return;
  }
  if (!_isNavigating || !_locationTrackingActive) return;
  const locations = data.locations;
  if (!locations || locations.length === 0) return;
  processLocationUpdate(locations[locations.length - 1]);
});

// 
interface PositionRecord {
  lat: number;
  lng: number;
  timestamp: number;
}
let _positionHistory: PositionRecord[] = [];  // 
let _lastSpeedCalcTime = 0;
let _currentSpeed = 0;  // /
let _remainingDuration = 0;  // 
const SPEED_CALC_INTERVAL = 5000;  // 5
const SPEED_HISTORY_MAX_AGE = 30000;  // 0
const MIN_SPEED_WALK = 1.0;   // m/s
const MIN_SPEED_BICYCLE = 3.0;  // m/s
const MIN_SPEED_DRIVE = 5.0;  // m/s

// 
const _routeCache = new Map<string, { data: RouteData; timestamp: number }>();
const ROUTE_CACHE_TTL = 5 * 60 * 1000; // 5
const DEVIATE_THRESHOLD_METERS = 100; // 偏航判定基础阈值（米）
const DEVIATE_CHECK_INTERVAL = 2000; // 偏航检测间隔（毫秒）
const REROUTE_COOLDOWN = 10000; // 重规划冷却
const DEVIATE_ALERT_COOLDOWN = 10000; // 偏航提醒冷却
const DEVIATE_CONFIRM_COUNT = 1; // 连续检测到偏航的次数才确认（1=立即触发）

function getRouteCacheKey(origin: [number, number], dest: [number, number], mode: NaviMode): string {
  return `${origin[0].toFixed(5)},${origin[1].toFixed(5)}_${dest[0].toFixed(5)},${dest[1].toFixed(5)}_${mode}`;
}

/** */
export function onNaviStateChange(cb: NaviCallback): () => void {
  _callbacks.push(cb);
  return () => { _callbacks = _callbacks.filter(c => c !== cb); };
}

/**  */
export function onArrival(cb: () => void): void {
  _arrivalCallback = cb;
}

/** UI*/
export function resetNavUiAutoHide(): void {
  if (!_isNavigating) return;
  useMapStore.getState().setNavUiHidden(false);
  if (_autoHideTimer) {
    clearTimeout(_autoHideTimer);
  }
  _autoHideTimer = setTimeout(() => {
    if (_isNavigating) {
      useMapStore.getState().setNavUiHidden(true);
    }
  }, 3000);
}

function notify() {
  updateSpeedAndRemainingTime();
  updateGpsSignalState();

  const snapshot: NaviStateSnapshot = {
    isNavigating: _isNavigating,
    currentStepIndex: _currentStepIndex,
    currentPosition: _currentPosition,
    heading: _currentHeading,
    prevStepEndIndex: _routeData && _currentPositionGcj
      ? findNearestPointOnPolyline(_currentPositionGcj[0], _currentPositionGcj[1], _routeData.flatPolyline)
      : 0,
    remainingDistance: calcRemainingDistance(),
    remainingDuration: _remainingDuration,
    elapsedSec: _elapsedSec,
    destLat: _destLat,
    destLng: _destLng,
    destName: _destName,
    mode: _mode,
    routeData: _routeData,
    gpsSignal: { ..._gpsSignal },
    currentSpeedMps: _currentSpeed,
    rerouteOptions: _rerouteOptions,
    arrivalMessage: _arrivalMessage,
  };
  _callbacks.forEach(cb => cb(snapshot));
}

function updateGpsSignalState() {
  const now = Date.now();
  const timeSinceLastUpdate = now - _lastPositionUpdateTime;

  if (_lastPositionUpdateTime === 0 || timeSinceLastUpdate > SIGNAL_NONE_TIMEOUT) {
    _gpsSignal = { quality: 'none', accuracy: null, source: 'unknown', lastUpdateTime: _lastPositionUpdateTime };
  } else if (_gpsSignal.accuracy !== null) {
    const acc = _gpsSignal.accuracy;
    if (_gpsSignal.source === 'gps' || (_gpsSignal.source !== 'network' && acc <= GPS_ACCURACY_GOOD)) {
      if (acc <= GPS_ACCURACY_EXCELLENT) {
        _gpsSignal.quality = 'excellent';
      } else if (acc <= GPS_ACCURACY_GOOD) {
        _gpsSignal.quality = 'good';
      } else if (acc <= GPS_ACCURACY_WEAK) {
        _gpsSignal.quality = 'weak';
      } else {
        _gpsSignal.quality = 'weak';
      }
    } else {
      _gpsSignal.quality = acc <= NETWORK_ACCURACY_THRESHOLD ? 'good' : 'weak';
    }
  }

  useMapStore.getState().setGpsSignal({ ..._gpsSignal });
}

function classifyPositionSource(accuracy: number | null): 'gps' | 'network' {
  if (accuracy === null) return 'network';
  if (accuracy <= GPS_ACCURACY_GOOD) return 'gps';
  return 'network';
}

// ========== GPS  ==========

/** 定位失败原因枚举 */
export type LocationErrorReason =
  | 'permission_denied'       // 权限被拒绝
  | 'service_disabled'        // 系统位置服务未开启
  | 'gps_provider_disabled'   // GPS 提供者不可用
  | 'network_provider_disabled' // 网络定位提供者不可用
  | 'timeout'                 // 定位超时
  | 'all_methods_failed';     // 所有定位方式均失败

/** 最后一次定位失败的原因 */
let _lastLocationError: LocationErrorReason | null = null;

/** 获取最后一次定位失败的原因 */
export function getLastLocationError(): LocationErrorReason | null {
  return _lastLocationError;
}

/** 检查系统位置服务状态，返回诊断信息 */
export async function checkLocationServices(): Promise<{
  serviceEnabled: boolean;
  gpsAvailable: boolean;
  networkAvailable: boolean;
  permissionGranted: boolean;
}> {
  const result = {
    serviceEnabled: false,
    gpsAvailable: false,
    networkAvailable: false,
    permissionGranted: false,
  };

  try {
    // 1. 检查权限
    const { status } = await Location.getForegroundPermissionsAsync();
    result.permissionGranted = status === 'granted';
  } catch (_) {}

  try {
    // 2. 检查系统位置服务是否开启
    const enabled = await Location.hasServicesEnabledAsync();
    result.serviceEnabled = enabled;
  } catch (_) {}

  try {
    // 3. 检查 GPS 和网络定位提供者状态
    const providerStatus = await Location.getProviderStatusAsync();
    result.gpsAvailable = providerStatus.gpsAvailable ?? false;
    result.networkAvailable = providerStatus.networkAvailable ?? false;
  } catch (_) {}

  return result;
}

/** 通用超时包装，防止 Location API 在 Android 11 上挂起 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      console.warn(`[NaviService] withTimeout: ${label} timed out (${timeoutMs}ms)`);
      reject(new Error(`${label} timeout`));
    }, timeoutMs);
    promise
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

/** 请求定位权限（带超时保护） */
export async function requestLocationPermission(): Promise<boolean> {
  try {
    const { status } = await withTimeout(
      Location.requestForegroundPermissionsAsync(),
      10000,
      'requestForegroundPermissionsAsync',
    );
    console.log(`[NaviService] requestLocationPermission: status=${status}`);
    return status === 'granted';
  } catch (e: any) {
    console.warn('[NaviService] requestLocationPermission failed:', e.message);
    return false;
  }
}

/**
 * Android 10+ 
 * 
 */
export async function requestNaviPermissions(): Promise<boolean> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return false;
  // Android 10+ 
  try {
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') {
      console.warn('[NaviService] location bg status denied');
    }
  } catch (e: any) {
    console.warn('[NaviService]  iOS :', e.message || e);
  }
  return true;
}

/**  getCurrentPositionAsync  */
function getCurrentPositionWithTimeout(
  options: { accuracy: Location.Accuracy },
  timeoutMs: number,
): Promise<Location.LocationObject> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('GPS')), timeoutMs);
    Location.getCurrentPositionAsync(options)
      .then((pos) => { clearTimeout(timer); resolve(pos); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * 
 * 
 * 
 * 1. 5
 * 2. 
 * 3. NWiFi/)GPS
 *    - NBalanced
 *    - GPSHigh0
 *    - GPS
 * 4. 
 * 5.  IP 
 */
export async function getCurrentPosition(): Promise<{ lat: number; lng: number } | null> {
  console.log('[NaviService] getCurrentPosition: ');
  _lastLocationError = null;

  // 1. 缓存快路径：仅高精度(≤50m)且新鲜(≤60s)的缓存直接命中。
  //    低精度(IP城市级)或陈旧缓存不直接采用，继续走实时竞速；
  //    它们仅保留为所有实时定位失败后的兜底(见第6步)。
  if (_cachedPosition) {
    const age = Date.now() - _cachedPosition.timestamp;
    const acc = _cachedPosition.accuracy ?? 999;
    if (age < CACHE_FAST_PATH_MAX_AGE_MS && acc <= CACHE_FAST_PATH_MAX_ACCURACY) {
      console.log(`[NaviService] getCurrentPosition: 快路径缓存命中(${Math.round(age / 1000)}s前, acc:${Math.round(acc)}m)`);
      _gpsSignal = {
        quality: 'good',
        accuracy: _cachedPosition.accuracy || null,
        source: (_cachedPosition.source as GpsSignalInfo['source']) || 'cache',
        lastUpdateTime: _cachedPosition.timestamp,
      };
      _lastPositionUpdateTime = Date.now();
      useMapStore.getState().setGpsSignal({ ..._gpsSignal });
      return { lat: _cachedPosition.lat, lng: _cachedPosition.lng };
    }
    console.log(`[NaviService] getCurrentPosition: 缓存不满足快路径门槛(${Math.round(age / 1000)}s前, acc:${Math.round(acc)}m)，继续实时定位`);
  }

  // 2. 
  const ok = await requestLocationPermission();
  if (!ok) {
    console.log('[NaviService] getCurrentPosition: ');
    _lastLocationError = 'permission_denied';
    _gpsSignal = { quality: 'none', accuracy: null, source: 'unknown', lastUpdateTime: 0 };
    useMapStore.getState().setGpsSignal({ ..._gpsSignal });
    return null;
  }

  // 2.5 检查系统位置服务是否开启（仅诊断，带超时）
  try {
    const serviceEnabled = await withTimeout(
      Location.hasServicesEnabledAsync(),
      3000,
      'hasServicesEnabledAsync',
    );
    if (!serviceEnabled) {
      console.warn('[NaviService] getCurrentPosition: hasServicesEnabledAsync=false，但继续尝试定位');
    } else {
      console.log('[NaviService] getCurrentPosition: 位置服务已开启');
    }
  } catch (e: any) {
    console.log('[NaviService] getCurrentPosition: hasServicesEnabled error:', e.message);
  }

  // 2.6 检查 GPS/网络定位提供者状态（仅诊断，带超时）
  let gpsProviderAvailable = true;
  let networkProviderAvailable = true;
  try {
    const providerStatus = await withTimeout(
      Location.getProviderStatusAsync(),
      3000,
      'getProviderStatusAsync',
    );
    gpsProviderAvailable = providerStatus.gpsAvailable ?? true;
    networkProviderAvailable = providerStatus.networkAvailable ?? true;
    console.log(`[NaviService] getCurrentPosition: GPS=${gpsProviderAvailable}, N=${networkProviderAvailable}`);
    if (!gpsProviderAvailable && !networkProviderAvailable) {
      console.warn('[NaviService] getCurrentPosition: getProviderStatus GPS/N 均不可用，但继续尝试定位（可能为 Android 11 误报）');
    }
  } catch (e: any) {
    console.log('[NaviService] getCurrentPosition: getProviderStatus error:', e.message);
  }

  // 3. Android: enableNetworkProviderAsync 改为非阻塞
  //    此函数在某些 Android 11 ROM 上会弹出系统对话框且 Promise 永远不 resolve，
  //    导致整个定位流程卡死。改为 fire-and-forget，不阻塞后续定位。
  if (Platform.OS === 'android') {
    console.log('[NaviService] getCurrentPosition: enableNetworkProvider (非阻塞)...');
    withTimeout(
      Location.enableNetworkProviderAsync(),
      3000,
      'enableNetworkProviderAsync',
    ).then(() => {
      console.log('[NaviService] getCurrentPosition: enableNetworkProvider done');
    }).catch((e: any) => {
      console.log('[NaviService] getCurrentPosition: enableNetworkProvider error:', e.message);
    });
    // 不 await，直接继续
  }

  // 4. getLastKnownPosition（带超时，Android 11 上可能比 getCurrentPosition 更可靠）
  try {
    console.log('[NaviService] getCurrentPosition: getLastKnownPosition (maxAge=5min)...');
    const lastPos = await withTimeout(
      Location.getLastKnownPositionAsync({ maxAge: 5 * 60 * 1000 }),
      5000,
      'getLastKnownPositionAsync',
    );
    if (lastPos && lastPos.coords) {
      const age = Date.now() - lastPos.timestamp;
      const lastAcc = lastPos.coords.accuracy || 999;
      // 仅在足够新鲜(≤30s)且精度可接受(≤100m)时直接采用 lastKnown。
      // 若拿到的是几分钟内的历史精确位置（如刚从户外进入室内，GPS 缓存 5 分钟内仍可命中），
      // 直接返回会导致导航/定位按历史位置规划；此时跳过，继续走并行竞速让基站/WiFi 定位参与。
      if (age <= LAST_KNOWN_FRESH_MS && lastAcc <= GPS_ACCURACY_WEAK) {
        const result = { lat: lastPos.coords.latitude, lng: lastPos.coords.longitude };
        const source = classifyPositionSource(lastPos.coords.accuracy);
        _cachedPosition = { ...result, timestamp: Date.now(), accuracy: lastPos.coords.accuracy ?? 999, source };
        _gpsSignal = {
          quality: (lastPos.coords.accuracy || 999) <= GPS_ACCURACY_GOOD ? 'good' : 'weak',
          accuracy: lastPos.coords.accuracy,
          source,
          lastUpdateTime: Date.now(),
        };
        _lastPositionUpdateTime = Date.now();
        useMapStore.getState().setGpsSignal({ ..._gpsSignal });
        console.log(`[NaviService] getCurrentPosition: getLastKnownPosition (${Math.round(age / 1000)}s ago), acc:${Math.round(lastAcc)}m`);
        return result;
      }
      console.log(`[NaviService] getCurrentPosition: getLastKnownPosition 新鲜度/精度不足 (${Math.round(age / 1000)}s前, acc:${Math.round(lastAcc)}m)，跳过继续竞速`);
      // 保存为兜底：所有实时定位失败时，它比 IP 城市级中心更接近真实位置
      _lastKnownFallback = {
        lat: lastPos.coords.latitude,
        lng: lastPos.coords.longitude,
        accuracy: lastAcc,
        timestamp: lastPos.timestamp,
      };
    }
    console.log('[NaviService] getCurrentPosition: getLastKnownPosition -> null');
  } catch (e: any) {
    console.log('[NaviService] getCurrentPosition: getLastKnownPosition error:', e.message);
  }

  // 5. 并行竞速：网络定位 + GPS定位 + watchPositionAsync 同时发起
  //    Android 11 上 getCurrentPositionAsync 可能卡死，但 watchPositionAsync 能工作
  //    因此三者并行，谁先返回有效结果就用谁
  console.log('[NaviService] getCurrentPosition: 3路并行竞速 (N+GPS+watch)...');
  _gpsSignal = { quality: 'none', accuracy: null, source: 'unknown', lastUpdateTime: 0 };
  useMapStore.getState().setGpsSignal({ ..._gpsSignal });

  type PositionResult = { lat: number; lng: number; accuracy: number; source: GpsSignalInfo['source'] } | null;

  /** 多个定位 Promise 中第一个非 null 结果胜出；全部失败 resolve(null)。resolve 幂等，先到先用。 */
  const firstNonNull = (promises: Promise<PositionResult>[]): Promise<PositionResult> =>
    new Promise<PositionResult>((resolve) => {
      let pending = promises.length;
      if (pending === 0) { resolve(null); return; }
      promises.forEach(p => p.then(r => {
        if (r) { pending = -1; resolve(r); return; }
        if (pending > 0 && --pending === 0) resolve(null);
      }));
    });

  const gpsTimeout = 15000;
  const networkTimeout = 8000;
  const watchTimeout = 8000;  // watchPositionAsync 超时与网络定位一致

  // 5.1 网络定位
  const networkPromise: Promise<PositionResult> = getCurrentPositionWithTimeout(
    { accuracy: Location.Accuracy.Balanced },
    networkTimeout,
  ).then(pos => {
    const acc = pos.coords.accuracy || 999;
    const source = classifyPositionSource(acc);
    console.log(`[NaviService] getCurrentPosition: N done, acc:${Math.round(acc)}m, source:${source}`);
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: acc, source } as PositionResult;
  }).catch(e => {
    console.log('[NaviService] getCurrentPosition: N failed:', e.message);
    return null as PositionResult;
  });

  // 5.2 GPS 定位
  const gpsPromise: Promise<PositionResult> = getCurrentPositionWithTimeout(
    { accuracy: Location.Accuracy.High },
    gpsTimeout,
  ).then(pos => {
    const acc = pos.coords.accuracy || 999;
    const source = classifyPositionSource(acc);
    console.log(`[NaviService] getCurrentPosition: GPS done, acc:${Math.round(acc)}m, source:${source}`);
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: acc, source } as PositionResult;
  }).catch(e => {
    console.log('[NaviService] getCurrentPosition: GPS failed:', e.message);
    return null as PositionResult;
  });

  // 5.3 watchPositionAsync 并行竞速（Android 11 关键兜底）
  //     修复 subscription 清理：先用局部变量存储，确保回调中能正确清理
  //     注意精度必须用 Low 而非 Lowest：Lowest 映射为被动监听(NO_POWER/PASSIVE)，
  //     室内无其它 App 触发定位时永不回调，只能等超时；Low 走 NETWORK_PROVIDER 主动定位
  const watchPromise: Promise<PositionResult> = new Promise<PositionResult>((resolve) => {
    let sub: Location.LocationSubscription | null = null;
    let settled = false;

    const finish = (result: PositionResult) => {
      if (settled) return;
      settled = true;
      if (sub) { sub.remove(); sub = null; }
      resolve(result);
    };

    const timer = setTimeout(() => {
      console.log('[NaviService] getCurrentPosition: watch timeout');
      finish(null);
    }, watchTimeout);

    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Low, timeInterval: 500, distanceInterval: 0 },
      (loc) => {
        clearTimeout(timer);
        const acc = loc.coords.accuracy || 999;
        const source = classifyPositionSource(acc);
        console.log(`[NaviService] getCurrentPosition: watch done, acc:${Math.round(acc)}m, source:${source}`);
        finish({ lat: loc.coords.latitude, lng: loc.coords.longitude, accuracy: acc, source });
      },
    ).then(s => {
      sub = s;
      // 如果已经 settled（超时），立即清理
      if (settled && sub) { sub.remove(); sub = null; }
    }).catch(e => {
      console.log('[NaviService] getCurrentPosition: watch setup failed:', e.message);
      clearTimeout(timer);
      finish(null);
    });
  });

  // 5.3b 高德 Web 模糊定位并行竞速（室内主力：WiFi/基站融合定位，不依赖 GMS，
  //       expo-location 在室内/国产 ROM 上可能整体无响应，该通道经常是唯一可用来源。
  //      过去它在三路全败后才串行调用，室内最坏多等 ~24s；现在并行参与竞速）
  const amapInRace = !!_amapLocationProvider;
  const amapPromise: Promise<PositionResult> = _amapLocationProvider
    ? _amapLocationProvider().then(r => {
        if (!r) return null as PositionResult;
        const acc = r.accuracy || 2000;
        const src: GpsSignalInfo['source'] = r.source === 'ip' ? 'ip' : 'amap-web';
        console.log(`[NaviService] getCurrentPosition: amap-web done, acc:${Math.round(acc)}m`);
        return { lat: r.lat, lng: r.lng, accuracy: acc, source: src } as PositionResult;
      }).catch(e => {
        console.log('[NaviService] getCurrentPosition: amap-web failed:', e?.message || e);
        return null as PositionResult;
      })
    : Promise.resolve(null as PositionResult);

  // 5.4 优先等待网络定位（通常最快），同时 GPS 和 watch 在后台竞速
  const networkResult = await networkPromise;
  if (networkResult) {
    const result = { lat: networkResult.lat, lng: networkResult.lng };
    _cachedPosition = { ...networkResult, timestamp: Date.now() };
    _gpsSignal = {
      quality: networkResult.accuracy <= GPS_ACCURACY_GOOD ? 'good' : 'weak',
      accuracy: networkResult.accuracy,
      source: networkResult.source,
      lastUpdateTime: Date.now(),
    };
    _lastPositionUpdateTime = Date.now();
    useMapStore.getState().setGpsSignal({ ..._gpsSignal });
    console.log(`[NaviService] getCurrentPosition: -> N [${networkResult.lat.toFixed(6)}, ${networkResult.lng.toFixed(6)}], acc:${Math.round(networkResult.accuracy)}m`);

    // 后台静默等待 GPS 更精确结果来更新缓存
    gpsPromise.then(gpsResult => {
      if (gpsResult && gpsResult.accuracy < networkResult.accuracy) {
        _cachedPosition = { ...gpsResult, timestamp: Date.now() };
        _gpsSignal = {
          quality: gpsResult.accuracy <= GPS_ACCURACY_GOOD ? 'good' : 'weak',
          accuracy: gpsResult.accuracy,
          source: gpsResult.source,
          lastUpdateTime: Date.now(),
        };
        useMapStore.getState().setGpsSignal({ ..._gpsSignal });
        console.log(`[NaviService] getCurrentPosition: GPS late update, acc:${Math.round(gpsResult.accuracy)}m`);
      }
    });
    // 也等待 watch 结果来更新缓存
    watchPromise.then(watchResult => {
      if (watchResult && watchResult.accuracy < networkResult.accuracy) {
        _cachedPosition = { ...watchResult, timestamp: Date.now() };
        _gpsSignal = {
          quality: watchResult.accuracy <= GPS_ACCURACY_GOOD ? 'good' : 'weak',
          accuracy: watchResult.accuracy,
          source: watchResult.source,
          lastUpdateTime: Date.now(),
        };
        useMapStore.getState().setGpsSignal({ ..._gpsSignal });
        console.log(`[NaviService] getCurrentPosition: watch late update, acc:${Math.round(watchResult.accuracy)}m`);
      }
    });

    return result;
  }

  // 5.5 网络定位失败，GPS / watch / 高德Web 三路并行，谁先返回有效结果用谁
  //     （室内场景 expo-location 的 GPS/watch 经常整体超时，高德Web 是唯一可用来源，
  //       与其等 15s 后串行兜底，不如并行竞速先到先用）
  console.log('[NaviService] getCurrentPosition: N failed, racing GPS/watch/amap-web...');
  const winner = await firstNonNull([gpsPromise, watchPromise, amapPromise]);

  if (winner) {
    const { lat, lng, accuracy, source } = winner;
    const result = { lat, lng };
    _cachedPosition = { ...result, timestamp: Date.now(), accuracy, source };
    _gpsSignal = {
      quality: accuracy <= GPS_ACCURACY_GOOD ? 'good' : 'weak',
      accuracy,
      source,
      lastUpdateTime: Date.now(),
    };
    _lastPositionUpdateTime = Date.now();
    useMapStore.getState().setGpsSignal({ ..._gpsSignal });
    console.log(`[NaviService] getCurrentPosition: -> ${source} [${lat.toFixed(6)}, ${lng.toFixed(6)}], acc:${Math.round(accuracy)}m`);

    // 后台静默等待更精确的 GPS 结果来更新缓存
    gpsPromise.then(gpsResult => {
      if (gpsResult && gpsResult.accuracy < accuracy) {
        _cachedPosition = { ...gpsResult, timestamp: Date.now() };
        _gpsSignal = {
          quality: gpsResult.accuracy <= GPS_ACCURACY_GOOD ? 'good' : 'weak',
          accuracy: gpsResult.accuracy,
          source: gpsResult.source,
          lastUpdateTime: Date.now(),
        };
        useMapStore.getState().setGpsSignal({ ..._gpsSignal });
        console.log(`[NaviService] getCurrentPosition: GPS late update, acc:${Math.round(gpsResult.accuracy)}m`);
      }
    });

    return result;
  }

  // 5.6 并行竞速全部失败，降级重试：Low 精度主动网络定位
  //     （不用 Lowest：它是被动监听，室内无其它 App 定位时永不回调）
  console.log('[NaviService] getCurrentPosition: all parallel races failed, retry with Low...');
  try {
    const retryPos = await getCurrentPositionWithTimeout(
      { accuracy: Location.Accuracy.Low },
      8000,
    );
    const acc = retryPos.coords.accuracy || 999;
    const source = classifyPositionSource(acc);
    console.log(`[NaviService] getCurrentPosition: retry Low done, acc:${Math.round(acc)}m, source:${source}`);
    const result = { lat: retryPos.coords.latitude, lng: retryPos.coords.longitude };
    _cachedPosition = { ...result, timestamp: Date.now(), accuracy: acc, source };
    _gpsSignal = {
      quality: 'weak',
      accuracy: acc,
      source,
      lastUpdateTime: Date.now(),
    };
    _lastPositionUpdateTime = Date.now();
    useMapStore.getState().setGpsSignal({ ..._gpsSignal });
    return result;
  } catch (e: any) {
    console.log('[NaviService] getCurrentPosition: retry Low failed:', e.message);
  }

  // 6. 缓存兜底：实时定位全部失败时，5 分钟内的缓存位置可用（好过直接失败；
  //    快路径已在第 1 步做过新鲜度/精度筛选，这里是最后手段）
  if (_cachedPosition && Date.now() - _cachedPosition.timestamp < POSITION_CACHE_TTL) {
    const age = Date.now() - _cachedPosition.timestamp;
    console.log(`[NaviService] getCurrentPosition: 实时定位全失败，使用缓存兜底(${Math.round(age / 1000)}s前, acc:${Math.round(_cachedPosition.accuracy)}m)`);
    _gpsSignal = { quality: 'weak', accuracy: _cachedPosition.accuracy || null, source: 'cache', lastUpdateTime: _cachedPosition.timestamp };
    useMapStore.getState().setGpsSignal({ ..._gpsSignal });
    return { lat: _cachedPosition.lat, lng: _cachedPosition.lng };
  }

  // 6.5 高德 Web 模糊定位兜底（WebView 内 AMap.Geolocation：WiFi/基站融合定位，
  //     室内无 GPS 时可用，不依赖 GMS；其内部失败时自动回落 IP 城市级）
  //     已在 5.3b 并行竞速中尝试过时跳过，避免重复等待
  if (_amapLocationProvider && !amapInRace) {
    try {
      console.log('[NaviService] getCurrentPosition: 尝试高德Web模糊定位...');
      const r = await _amapLocationProvider();
      if (r) {
        const src = r.source === 'ip' ? 'ip' : 'amap-web';
        _cachedPosition = { lat: r.lat, lng: r.lng, timestamp: Date.now(), accuracy: r.accuracy || 5000, source: src };
        _gpsSignal = { quality: 'weak', accuracy: r.accuracy || 5000, source: src, lastUpdateTime: Date.now() };
        _lastPositionUpdateTime = Date.now();
        useMapStore.getState().setGpsSignal({ ..._gpsSignal });
        console.log(`[NaviService] getCurrentPosition: -> ${src} [${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}], acc:${Math.round(r.accuracy || 0)}m`);
        return { lat: r.lat, lng: r.lng };
      }
      console.log('[NaviService] getCurrentPosition: 高德Web模糊定位失败');
    } catch (e: any) {
      console.log('[NaviService] getCurrentPosition: 高德Web模糊定位异常', e.message || e);
    }
  }

  // 6.8 系统 lastKnown 兜底：比 IP 城市级中心更接近真实位置（室内步行 5 分钟内移动有限）
  if (_lastKnownFallback) {
    const ageMin = Math.round((Date.now() - _lastKnownFallback.timestamp) / 60000);
    console.log(`[NaviService] getCurrentPosition: 使用 lastKnown 兜底(${ageMin}分钟前, acc:${Math.round(_lastKnownFallback.accuracy)}m)`);
    const result = { lat: _lastKnownFallback.lat, lng: _lastKnownFallback.lng };
    _cachedPosition = { ...result, timestamp: Date.now(), accuracy: _lastKnownFallback.accuracy, source: 'cache' };
    _gpsSignal = { quality: 'weak', accuracy: _lastKnownFallback.accuracy, source: 'cache', lastUpdateTime: _lastKnownFallback.timestamp };
    _lastPositionUpdateTime = Date.now();
    useMapStore.getState().setGpsSignal({ ..._gpsSignal });
    return result;
  }

  // 7.  IP  GPS/N
  try {
    console.log('[NaviService] getCurrentPosition:  IP ..');
    const currentApiUrl = await getEffectiveApiUrl();
    const res = await axios.get(`${currentApiUrl}/map/ip-location`, { timeout: 10000 });
    const ipResult = res.data;
    if (ipResult && ipResult.success && ipResult.data) {
      const { lat, lng, source, city } = ipResult.data;
      // 格式校验：坐标必须是有效数字且在中国范围内，防止后端异常数据污染规划
      if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)
        || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        console.log('[NaviService] getCurrentPosition: IP 返回坐标无效 -', JSON.stringify(ipResult.data));
      } else {
        const ipPos = { lat, lng };
        _cachedPosition = { ...ipPos, timestamp: Date.now(), accuracy: 5000, source: 'ip' };
        _gpsSignal = { quality: 'weak', accuracy: 5000, source: 'ip', lastUpdateTime: Date.now() };
        _lastPositionUpdateTime = Date.now();
        useMapStore.getState().setGpsSignal({ ..._gpsSignal });
        console.log(`[NaviService] getCurrentPosition: IP [${lat}, ${lng}], =${source}, =${city}`);
        return ipPos;
      }
    }
    console.log('[NaviService] getCurrentPosition: IP -', ipResult?.error || '');
  } catch (e: any) {
    console.log('[NaviService] getCurrentPosition: IP -', e.message);
  }

  console.log('[NaviService] getCurrentPosition: ');
  _lastLocationError = 'all_methods_failed';
  _gpsSignal = { quality: 'none', accuracy: null, source: 'unknown', lastUpdateTime: 0 };
  useMapStore.getState().setGpsSignal({ ..._gpsSignal });
  return null;
}

// ========== REST API=========

function parseAmapPolyline(polylineStr: string): [number, number][] {
  return polylineStr.split(';').filter(Boolean).map(seg => {
    const [lng, lat] = seg.split(',').map(Number);
    return [lng, lat] as [number, number];
  });
}

/** API*/
const AMAP_REST_KEY = '5299af602f4ee3cd7351c1bc7f32b1cb';

/** 单条路线规划（内部使用） */
async function planSingleRoute(
  originWgs: [number, number],
  destWgs: [number, number],
  mode: NaviMode = 'drive',
  strategy: number = 0,
): Promise<RouteData | null> {
  const [oLat, oLng] = wgs84ToGcj02(originWgs[0], originWgs[1]);
  const [dLat, dLng] = wgs84ToGcj02(destWgs[0], destWgs[1]);
  const originStr = `${oLng},${oLat}`;
  const destStr = `${dLng},${dLat}`;

  const cacheKey = `${oLat.toFixed(5)},${oLng.toFixed(5)}_${dLat.toFixed(5)},${dLng.toFixed(5)}_${mode}_s${strategy}`;
  const cached = _routeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ROUTE_CACHE_TTL) {
    console.log('[NaviService] planSingleRoute: 缓存命中');
    return cached.data;
  }

  // 先尝试后端代理
  try {
    const directionUrl = await getDirectionProxyUrl();
    console.log('[NaviService] planSingleRoute via proxy:', directionUrl, { origin: originStr, destination: destStr, mode, strategy });

    const res = await axios.get(directionUrl, {
      params: { origin: originStr, destination: destStr, mode, strategy: strategy },
      timeout: 20000,
    });
    const result = res.data;

    if (result.success && result.data && result.data.paths && result.data.paths.length > 0) {
      const route = parseAmapRouteResult(result.data, mode, oLat, oLng, dLat, dLng);
      if (route) {
        _routeCache.set(cacheKey, { data: route, timestamp: Date.now() });
        trimRouteCache();
        return route;
      }
    }
    console.warn('[NaviService] planSingleRoute: 代理返回无效数据，尝试直接调用高德API');
  } catch (e: any) {
    console.warn('[NaviService] planSingleRoute: 代理请求失败，尝试直接调用高德API:', e.message || e);
  }

  // Fallback: 直接调用高德 REST API
  try {
    return await planSingleRouteDirect(originStr, destStr, mode, strategy, oLat, oLng, dLat, dLng, cacheKey);
  } catch (e: any) {
    console.error(`[NaviService] planSingleRoute error (strategy=${strategy}):`, e.message || e);
    return null;
  }
}

/** 直接调用高德 REST API 规划路线 */
async function planSingleRouteDirect(
  originStr: string, destStr: string,
  mode: NaviMode, strategy: number,
  oLat: number, oLng: number, dLat: number, dLng: number,
  cacheKey: string,
): Promise<RouteData | null> {
  const amapModeMap: Record<NaviMode, string> = {
    drive: 'driving',
    walk: 'walking',
    bicycling: 'bicycling',
  };
  const amapMode = amapModeMap[mode] || 'driving';
  const url = `https://restapi.amap.com/v3/direction/${amapMode}`;

  console.log(`[NaviService] planSingleRouteDirect: ${url}, strategy=${strategy}`);

  const params: any = {
    key: AMAP_REST_KEY,
    origin: originStr,
    destination: destStr,
    output: 'json',
  };
  // 驾车模式支持 strategy 参数
  if (mode === 'drive') {
    params.strategy = strategy;
  }

  const res = await axios.get(url, { params, timeout: 20000 });
  const data = res.data;

  if (data.status !== '1' || !data.route || !data.route.paths || data.route.paths.length === 0) {
    console.error('[NaviService] 高德API返回错误:', data.info || '无可用路线');
    return null;
  }

  const route = parseAmapRouteResult(data.route, mode, oLat, oLng, dLat, dLng);
  if (route) {
    _routeCache.set(cacheKey, { data: route, timestamp: Date.now() });
    trimRouteCache();
  }
  return route;
}

/** 解析高德路线规划返回的单条 path */
function parseAmapPath(
  path: any,
  mode: NaviMode,
  oLat: number, oLng: number,
  dLat: number, dLng: number,
): RouteData {
  const steps: RouteStep[] = (path.steps || []).map((step: any) => ({
    instruction: step.instruction || '',
    polyline: parseAmapPolyline(step.polyline || ''),
    distance: parseFloat(step.distance) || 0,
    duration: parseFloat(step.duration) || 0,
    road: step.road || '',
  }));

  const rawPoints = steps.flatMap(s => s.polyline);
  // 每个步骤终点在原始拼接数组中的索引（steps 间首尾点通常重合，但点数累计仍唯一确定步骤边界）
  const stepEndRawIndices: number[] = [];
  let accPts = 0;
  for (const s of steps) {
    accPts += s.polyline.length;
    stepEndRawIndices.push(accPts - 1);
  }

  const { points: flatPolyline, srcIndices } = simplifyPolyline(
    rawPoints,
    mode === 'walk' ? 10 : 5
  );

  // 将"原始数组中的步骤终点索引"映射为"抽稀后 flatPolyline 中的索引"
  // srcIndices 单调递增（抽稀是保序采样），二分查找最近的采样位置
  const stepEndFlatIndices = stepEndRawIndices.map(rawIdx => mapRawIndexToFlat(srcIndices, rawIdx));

  return {
    steps,
    totalDistance: parseFloat(path.distance) || 0,
    totalDuration: parseFloat(path.duration) || 0,
    flatPolyline,
    stepEndFlatIndices,
    origin: [oLat, oLng],
    destination: [dLat, dLng],
  };
}

/** 在单调递增的 srcIndices 中找最接近 rawIdx 的下标（二分） */
function mapRawIndexToFlat(srcIndices: number[], rawIdx: number): number {
  let lo = 0;
  let hi = srcIndices.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (srcIndices[mid] < rawIdx) lo = mid + 1;
    else hi = mid;
  }
  // lo 是第一个 >= rawIdx 的位置；比较 lo 与 lo-1 哪个更近
  if (lo > 0 && Math.abs(srcIndices[lo - 1] - rawIdx) <= Math.abs(srcIndices[lo] - rawIdx)) {
    return lo - 1;
  }
  return lo;
}

/** 解析高德路线规划返回的 route 数据（支持多条路线） */
function parseAmapRouteResult(
  routeData: any,
  mode: NaviMode,
  oLat: number, oLng: number,
  dLat: number, dLng: number,
): RouteData | null {
  if (!routeData.paths || routeData.paths.length === 0) return null;
  return parseAmapPath(routeData.paths[0], mode, oLat, oLng, dLat, dLng);
}

/** 解析高德路线规划返回的所有路线 */
function parseAmapRouteResults(
  routeData: any,
  mode: NaviMode,
  oLat: number, oLng: number,
  dLat: number, dLng: number,
): RouteData[] {
  if (!routeData.paths || routeData.paths.length === 0) return [];
  return routeData.paths
    .map((path: any) => parseAmapPath(path, mode, oLat, oLng, dLat, dLng))
    .filter((r: RouteData | null): r is RouteData => r !== null);
}

/** 清理路线缓存 */
function trimRouteCache() {
  if (_routeCache.size > 20) {
    const oldest = Array.from(_routeCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    _routeCache.delete(oldest[0]);
  }
}

/** 多路线规划：返回推荐路线和备选路线 */
export async function planRoutes(
  originWgs: [number, number],
  destWgs: [number, number],
  mode: NaviMode = 'drive',
): Promise<{ recommended: RouteData; alternate: RouteData | null }> {
  if (mode !== 'drive') {
    // 步行/骑行：只请求一条路线
    const recommended = await planSingleRoute(originWgs, destWgs, mode, 0);
    if (!recommended) throw new Error('路线规划失败，请重试');
    return { recommended, alternate: null };
  }

  // 驾车模式：推荐路线用高德推荐(strategy=10)，备选路线用不走高速(strategy=13)
  // strategy=13 是高德 v3 API 中最可靠的"不走高速"策略，保证返回不走高速的路线
  // 高德驾车 strategy 参数说明：
  //   10: 高德默认推荐，返回多条路线（躲避拥堵+路程较短+缩短时间）
  //   13: 不走高速，返回一条不走高速的路线
  const [oLat, oLng] = wgs84ToGcj02(originWgs[0], originWgs[1]);
  const [dLat, dLng] = wgs84ToGcj02(destWgs[0], destWgs[1]);
  const originStr = `${oLng},${oLat}`;
  const destStr = `${dLng},${dLat}`;

  // 同时请求推荐路线和不走高速路线
  const [recommendedRoutes, noHighwayRoute] = await Promise.all([
    planMultipleRoutesDirect(originStr, destStr, mode, 10, oLat, oLng, dLat, dLng),
    planSingleRouteDirect(originStr, destStr, mode, 13, oLat, oLng, dLat, dLng,
      `${oLat.toFixed(5)},${oLng.toFixed(5)}_${dLat.toFixed(5)},${dLng.toFixed(5)}_drive_s13`),
  ]);

  // 推荐路线：优先使用 strategy=10 的第一条
  const recommended = recommendedRoutes[0] || noHighwayRoute;
  if (!recommended) throw new Error('路线规划失败，请重试');

  // 备选路线：不走高速路线(strategy=13)
  // 只要不走高速路线存在且与推荐路线不同就展示
  let alternate: RouteData | null = null;
  if (noHighwayRoute) {
    // 通过路线距离判断是否为不同路线（距离差异>1%即视为不同路线）
    const distDiff = Math.abs(noHighwayRoute.totalDistance - recommended.totalDistance) / recommended.totalDistance;
    if (distDiff > 0.01) {
      alternate = noHighwayRoute;
      console.log(`[NaviService] planRoutes: 备选(不走高速)距离差异${(distDiff * 100).toFixed(1)}%`);
    } else {
      // 距离几乎相同，可能是同一条路线（起终点之间没有高速）
      console.log(`[NaviService] planRoutes: 不走高速路线与推荐路线距离差异仅${(distDiff * 100).toFixed(1)}%，视为相同路线`);
    }
  }

  // 如果不走高速路线不可用或与推荐相同，尝试从推荐路线的第二条作为备选
  if (!alternate && recommendedRoutes.length >= 2) {
    const distDiff = Math.abs(recommendedRoutes[1].totalDistance - recommended.totalDistance) / recommended.totalDistance;
    if (distDiff > 0.01) {
      alternate = recommendedRoutes[1];
      console.log(`[NaviService] planRoutes: 备选(推荐第二条)距离差异${(distDiff * 100).toFixed(1)}%`);
    }
  }

  console.log(`[NaviService] planRoutes: 推荐=${Math.round(recommended.totalDistance)}m, 备选=${alternate ? Math.round(alternate.totalDistance) + 'm' : '无'}`);
  return { recommended, alternate };
}

/** 直接调用高德 API 获取多条路线 */
async function planMultipleRoutesDirect(
  originStr: string, destStr: string,
  mode: NaviMode, strategy: number,
  oLat: number, oLng: number, dLat: number, dLng: number,
): Promise<RouteData[]> {
  const amapModeMap: Record<NaviMode, string> = {
    drive: 'driving',
    walk: 'walking',
    bicycling: 'bicycling',
  };
  const amapMode = amapModeMap[mode] || 'driving';
  const url = `https://restapi.amap.com/v3/direction/${amapMode}`;

  console.log(`[NaviService] planMultipleRoutesDirect: ${url}, strategy=${strategy}`);

  try {
    const params: any = {
      key: AMAP_REST_KEY,
      origin: originStr,
      destination: destStr,
      output: 'json',
      strategy,
    };

    const res = await axios.get(url, { params, timeout: 20000 });
    const data = res.data;

    if (data.status !== '1' || !data.route || !data.route.paths || data.route.paths.length === 0) {
      console.warn('[NaviService] planMultipleRoutesDirect: 高德API返回错误:', data.info || '无可用路线');
      return [];
    }

    const routes = parseAmapRouteResults(data.route, mode, oLat, oLng, dLat, dLng);
    console.log(`[NaviService] planMultipleRoutesDirect: 解析到${routes.length}条路线`);
    return routes;
  } catch (e: any) {
    console.warn('[NaviService] planMultipleRoutesDirect 失败:', e.message || e);
    return [];
  }
}

/** 兼容旧接口：单条路线规划 */
export async function planRoute(
  originWgs: [number, number],
  destWgs: [number, number],
  mode: NaviMode = 'drive',
  strategy: number = 2,
): Promise<RouteData | null> {
  return planSingleRoute(originWgs, destWgs, mode, strategy);
}

/** Douglas-Peucker 均匀采样抽稀；返回抽稀后的点及每个点在原始数组中的索引（保序、单调递增） */
function simplifyPolyline(
  points: [number, number][],
  tolerance: number,
): { points: [number, number][]; srcIndices: number[] } {
  if (points.length <= 2) {
    return { points, srcIndices: points.map((_, i) => i) };
  }

  //
  let totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    totalLength += haversine(points[i-1][1], points[i-1][0], points[i][1], points[i][0]);
  }

  // 短路线不抽稀，原样返回（索引恒等映射）
  if (totalLength < 500) {
    return { points, srcIndices: points.map((_, i) => i) };
  }

  //
  const simplified: [number, number][] = [points[0]];
  const srcIndices: number[] = [0];
  const targetCount = Math.max(50, Math.min(points.length, Math.floor(totalLength / tolerance)));
  const step = (points.length - 1) / targetCount;

  for (let i = 1; i < targetCount; i++) {
    const idx = Math.round(i * step);
    simplified.push(points[idx]);
    srcIndices.push(idx);
  }
  simplified.push(points[points.length - 1]);
  srcIndices.push(points.length - 1);

  return { points: simplified, srcIndices };
}

// ==========  ==========

/**  */
export async function startNavigation(
  destWgs: { lat: number; lng: number },
  name: string,
  mode: NaviMode = 'drive',
  originWgs?: { lat: number; lng: number },
  prePlannedRoute?: RouteData,
): Promise<boolean> {
  // 1.  + 
  const ok = await requestNaviPermissions();
  if (!ok) {
    console.log('[NaviService] startNavigation: ');
    return false;
  }

  // 2. 
  let origin = originWgs;
  if (!origin) {
    console.log('[NaviService] startNavigation: ..');
    const pos = await getCurrentPosition();
    if (!pos) {
      console.log('[NaviService] startNavigation: ');
      return false;
    }
    origin = pos;
    console.log(`[NaviService] startNavigation:  [${origin.lat.toFixed(6)}, ${origin.lng.toFixed(6)}]`);
  }

  _currentPosition = [origin.lat, origin.lng];
  _currentPositionGcj = wgs84ToGcj02(origin.lat, origin.lng);
  _plannedOrigin = [origin.lat, origin.lng];
  _destLat = destWgs.lat;
  _destLng = destWgs.lng;
  _destName = name;
  _mode = mode;

  // 3. 路线
  let route: RouteData | null = prePlannedRoute || null;
  if (!route) {
    try {
      route = await planRoute(
        [origin.lat, origin.lng],
        [destWgs.lat, destWgs.lng],
        mode,
      );
    } catch (e: any) {
      console.error('[NaviService] startNavigation planRoute error:', e.message || e);
      return false;
    }
  }
  if (!route) return false;

  _routeData = route;
  _currentStepIndex = 0;
  _lastSpokenStepIndex = -1;
  _arrived = false;
  _arrivalMessage = null;
  _approachingSpoken = new Set();
  resetAnnounceState();
  _elapsedSec = 0;
  _startTime = Date.now();
  _isNavigating = true;
  _lastDeviateCheckTime = 0;
  _deviateAlertGiven = false;
  _deviateConfirmCount = 0;
  _isRerouting = false;
  // 起点是否为模糊定位（网络/IP/高德Web），GPS/北斗恢复后将自动重规划一次
  _startedWithFuzzyOrigin = _gpsSignal.source !== 'gps' && (_gpsSignal.accuracy === null || _gpsSignal.accuracy > GPS_ACCURACY_GOOD);
  if (_startedWithFuzzyOrigin) {
    console.log(`[NaviService] 以模糊定位起步(source=${_gpsSignal.source}, acc=${_gpsSignal.accuracy})，GPS恢复后将自动重规划`);
  }
  // 
  _stepEntryIndex = 0;
  _stepForwardProgress = 0;
  _lastForwardNearestIdx = 0;
  _forwardOnlyMode = true;
  _distanceTraveledInStep = 0;
  _stepTransitionCooldown = 0;
  useMapStore.getState().setIsNavigating(true);
  useMapStore.getState().setNavUiHidden(false);
  useMapStore.getState().setMarkerMode(false);
  if (useMapStore.getState().measureMode) {
    useMapStore.getState().clearMeasure();
  }

  notify();

  // 4. GPS
  startLocationTracking();

  // 5. 
  _elapsedTimer = setInterval(() => {
    _elapsedSec = Math.floor((Date.now() - _startTime) / 1000);
    notify();
  }, 1000);

  // 6. 启动播报：全程总览（距离 + 预计到达时间）
  speakRouteOverview();

  // 7.  AppState 
  startKeepAwake();
  setupAppStateListener();

  // 8. 3UI
  _autoHideTimer = setTimeout(() => {
    if (_isNavigating) {
      useMapStore.getState().setNavUiHidden(true);
    }
  }, 3000);

  return true;
}

/**  */
export function stopNavigation(): void {
  _isNavigating = false;
  stopLocationTracking();
  if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = null; }
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  if (_autoHideTimer) { clearTimeout(_autoHideTimer); _autoHideTimer = null; }
  _routeData = null;
  _rerouteOptions = null;
  _currentStepIndex = 0;
  _currentPosition = null;
  _currentPositionGcj = null;
  _currentHeading = null;
  _compassHeading = null;
  _headingSource = 'compass';
  _gpsHeadingStreak = 0;
  _headingSmoothed = null;
  _headingSmoothTime = 0;
  _plannedOrigin = null;
  _positionHistory = [];
  _lastSpeedCalcTime = 0;
  _currentSpeed = 0;
  _remainingDuration = 0;
  _gpsSignal = { quality: 'none', accuracy: null, source: 'unknown', lastUpdateTime: 0 };
  _lastPositionUpdateTime = 0;
  _accuracySwitchCooldown = 0;
  _startedWithFuzzyOrigin = false;
  _arrived = false;
  _arrivalMessage = null;
  // 
  _stepEntryIndex = 0;
  _stepForwardProgress = 0;
  _lastForwardNearestIdx = 0;
  _forwardOnlyMode = false;
  Speech.stop();
  useMapStore.getState().setIsNavigating(false);
  useMapStore.getState().setNavUiHidden(false);
  useMapStore.getState().setGpsSignal({ ..._gpsSignal });
  // 
  stopKeepAwake();
  //  AppState 
  removeAppStateListener();
}

// ========== ==========

/** */
function startKeepAwake() {
  if (_isKeepAwakeActive) return;
  _isKeepAwakeActive = true;
  try {
    //  "navi" 
    KeepAwake.activateKeepAwake('navi');
    console.log('[NaviService] ');  } catch (e: any) {
    console.error('[NaviService] ', e.message || e);
  }
}

/**  */
function stopKeepAwake() {
  if (!_isKeepAwakeActive) return;
  _isKeepAwakeActive = false;
  try {
    KeepAwake.deactivateKeepAwake('navi');
    console.log('[NaviService] ');  } catch (e: any) {
    console.error('[NaviService] :', e.message || e);
  }
}

/** */
function handleAppStateChange(nextAppState: AppStateStatus) {
  const wasActive = _appState === 'active';
  _appState = nextAppState;
  console.log(`[NaviService] AppState : ${_appState}`);

  // y
  if (nextAppState === 'background' || nextAppState === 'inactive') {
    if (_isNavigating && !_isPausedDueToBackground) {
      console.log('[NaviService] y');
      _wasNavigatingBeforePause = true;
      _isPausedDueToBackground = true;
      // 
      Speech.stop();
      // 
    }
  }

  // 
  if (nextAppState === 'active' && _isPausedDueToBackground) {
    console.log('[NaviService] ');
    _isPausedDueToBackground = false;
    // UI
    if (_currentPosition) {
      updateStepProgress();
      notify();
    }
    // 从后台恢复时不主动播报当前步骤，避免过了路口还重复播报
    // checkAndAnnounceApproach 会在下次位置更新时自然处理提前播报
  }
}

/**  AppState */
let _appStateSubscription: { remove: () => void } | null = null;

function setupAppStateListener() {
  if (_appStateSubscription) return;
  try {
    _appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
    console.log('[NaviService] AppState ');
  } catch (e: any) {
    console.error('[NaviService]  AppState ', e.message);
  }
}

/**  AppState */
function removeAppStateListener() {
  if (_appStateSubscription) {
    _appStateSubscription.remove();
    _appStateSubscription = null;
    console.log('[NaviService] AppState ');
  }
}

/** y*/
export function isPausedDueToBackground(): boolean {
  return _isPausedDueToBackground;
}

/** */
export function getAppState(): AppStateStatus {
  return _appState;
}

function startLocationTracking() {
  stopLocationTracking();

  console.log(`[NaviService] startLocationTracking: :${_mode})`);

  _currentTrackingAccuracy = Location.Accuracy.BestForNavigation;
  _accuracySwitchCooldown = 0;

  console.log(`[NaviService] startLocationTracking:  ${accuracyLabel(_currentTrackingAccuracy)}`);

  //  startLocationUpdatesAsync
  // API  expo-task-manager
  // yGPS
  _locationTrackingActive = true;

  (async () => {
    try {
      // 安全停止旧任务（可能已被系统回收，忽略 TaskNotFoundException）
      try {
        if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
          await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
        }
      } catch (_: any) {
        // TaskNotFoundException: 任务已不存在，无需处理
      }

      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: _currentTrackingAccuracy,
        distanceInterval: 1,
        timeInterval: 500,
        foregroundService: {
          notificationTitle: '网优伴侣',
          notificationBody: '正在导航中',
          notificationColor: '#007AFF',
        },
        showsBackgroundLocationIndicator: false,
      });
      console.log('[NaviService] startLocationTracking: ');
    } catch (e: any) {
      console.error('[NaviService] startLocationUpdatesAsync :', e.message || e);
    }
  })();

  // 独立监听设备罗盘朝向（磁力计 + 加速度计），更新频率远高于 GPS heading
  // 在静止或低速时也能实时反映手机朝向
  // 使用自定义 compassService 替代 expo-location 的 watchHeadingAsync
  // 解决手机竖屏导航时方向指示错乱问题（平放和竖屏自适应）
  (async () => {
    try {
      await compassService.start((newHeading) => {
        if (!_isNavigating) return;
        if (newHeading === null || isNaN(newHeading)) return;

        _compassHeading = newHeading;
        // 行车速度足够时已切换到 GPS heading（速度向量方向，不受车内电磁/颠簸影响），
        // 罗盘值仅记录不输出，避免抖动传导到方向指示图标
        if (_headingSource === 'gps') return;
        // 输出层低通平滑：手持抖动(10-30°快速往复)在此被滤除，图标平滑跟随
        _currentHeading = smoothHeadingOutput(newHeading);

        // 朝向变化满足最小通知间隔时，触发 UI 更新
        const now = Date.now();
        if (now - _lastHeadingNotifyTime >= HEADING_NOTIFY_MIN_INTERVAL) {
          _lastHeadingNotifyTime = now;
          if (!_isPausedDueToBackground) {
            notify();
          }
        }
      });
      console.log('[NaviService] compassService: 罗盘监听已启动');
    } catch (e: any) {
      console.warn('[NaviService] compassService 启动失败:', e.message || e);
      // 罗盘不可用时不影响导航，回退到 GPS heading
    }
  })();

  startSignalQualityMonitor();
}

function accuracyLabel(acc: Location.Accuracy): string {
  switch (acc) {
    case Location.Accuracy.BestForNavigation: return 'BestForNavigation(GPS)';
    case Location.Accuracy.High: return 'High(GPS)';
    case Location.Accuracy.Balanced: return 'Balanced()';
    case Location.Accuracy.Lowest: return 'Lowest()';
    default: return String(acc);
  }
}

function checkAndSwitchAccuracy(currentAccuracy: number, source: 'gps' | 'network') {
  const now = Date.now();
  if (now < _accuracySwitchCooldown) return;

  // GPS精度差时降级到Balanced，恢复时升级回BestForNavigation
  if (currentAccuracy > GPS_ACCURACY_WEAK && _currentTrackingAccuracy === Location.Accuracy.BestForNavigation) {
    console.log(`[NaviService] GPS弱(${Math.round(currentAccuracy)}m)，降级精度`);
    _currentTrackingAccuracy = Location.Accuracy.Balanced;
    _accuracySwitchCooldown = now + ACCURACY_SWITCH_COOLDOWN;
    applyNewAccuracy();
  } else if (source === 'gps' && currentAccuracy <= GPS_ACCURACY_GOOD && _currentTrackingAccuracy !== Location.Accuracy.BestForNavigation) {
    console.log(`[NaviService] GPS恢复(${Math.round(currentAccuracy)}m)，升级精度`);
    _currentTrackingAccuracy = Location.Accuracy.BestForNavigation;
    _accuracySwitchCooldown = now + ACCURACY_SWITCH_COOLDOWN;
    applyNewAccuracy();
  }
}

/**  */
function applyNewAccuracy() {
  if (!_isNavigating) return;
  (async () => {
    try {
      // 安全停止旧任务再以新精度启动
      try {
        if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
          await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
        }
      } catch (_: any) {
        // TaskNotFoundException: 忽略
      }

      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: _currentTrackingAccuracy,
        distanceInterval: 1,
        timeInterval: 500,
        foregroundService: {
          notificationTitle: '网优伴侣',
          notificationBody: '正在导航中',
          notificationColor: '#007AFF',
        },
        showsBackgroundLocationIndicator: false,
      });
      console.log(`[NaviService]  ${accuracyLabel(_currentTrackingAccuracy)}`);
    } catch (e: any) {
      console.error('[NaviService] :', e.message || e);
    }
  })();
}

/**
 *  watchPositionAsync 
 * TaskManager 
 */
function processLocationUpdate(loc: Location.LocationObject) {
  if (!_isNavigating || !_locationTrackingActive) return;
  const { latitude, longitude, heading, accuracy: locAccuracy } = loc.coords;
  _currentPosition = [latitude, longitude];
  _currentPositionGcj = wgs84ToGcj02(latitude, longitude);

  // === heading 源按速度切换（核心防抖：行车时不再使用磁力计）===
  // 低速/静止：罗盘磁力计（实时反映手机朝向）
  // 高速行车：GPS heading（速度向量方向，稳定，不受车内金属/电磁/颠簸影响）
  const gpsHeadingValid = heading !== null && heading !== undefined && !isNaN(heading) && heading >= 0;
  const rawSpeed = loc.coords.speed;
  const speedForHeading = (rawSpeed !== null && rawSpeed !== undefined && rawSpeed >= 0)
    ? rawSpeed
    : _currentSpeed;

  if (gpsHeadingValid && speedForHeading >= HEADING_GPS_MIN_SPEED) {
    _gpsHeadingStreak++;
  } else {
    _gpsHeadingStreak = 0;
  }
  if (_headingSource !== 'gps' && _gpsHeadingStreak >= HEADING_GPS_CONFIRM_COUNT) {
    _headingSource = 'gps';
    console.log(`[NaviService] heading源切换到GPS (speed=${speedForHeading.toFixed(1)}m/s)`);
  } else if (_headingSource === 'gps' && (!gpsHeadingValid || speedForHeading < HEADING_COMPASS_MAX_SPEED)) {
    _headingSource = 'compass';
    _gpsHeadingStreak = 0;
    console.log(`[NaviService] heading源回落罗盘 (speed=${speedForHeading.toFixed(1)}m/s, valid=${gpsHeadingValid})`);
  }

  if (_headingSource === 'gps' && gpsHeadingValid) {
    _currentHeading = smoothHeadingOutput(heading);
  } else if (_compassHeading !== null) {
    _currentHeading = smoothHeadingOutput(_compassHeading);
  } else if (gpsHeadingValid) {
    _currentHeading = smoothHeadingOutput(heading);
  }

  const acc = locAccuracy || 999;
  const source = classifyPositionSource(locAccuracy);
  _lastPositionUpdateTime = Date.now();

  // GPS恢复时退出隧道模式
  if (_tunnelModeActive) {
    console.log('[NaviService] GPS恢复，退出隧道模式');
    stopTunnelMode();
  }

  _gpsSignal = {
    quality: acc <= GPS_ACCURACY_EXCELLENT ? 'excellent'
      : acc <= GPS_ACCURACY_GOOD ? 'good'
      : 'weak',
    accuracy: locAccuracy,
    source,
    lastUpdateTime: Date.now(),
  };

  _cachedPosition = {
    lat: latitude,
    lng: longitude,
    timestamp: Date.now(),
    accuracy: locAccuracy ?? 999,
    source,
  };

  console.log(`[NaviService] : [${latitude.toFixed(6)}, ${longitude.toFixed(6)}], : ${Math.round(acc)}m, : ${_gpsSignal.quality}, : ${source}`);

  checkAndSwitchAccuracy(acc, source);

  // 模糊定位起步：收到首个高精度位置后自动重规划一次路线。
  // 注意不能限定 source==='gps'：室内场景只能收到 network/amap-web 来源的
  // 高精度 WiFi 定位（精度可达 20-30m），限定 gps 会导致室内永远不纠正。
  // 加偏差门槛：仅当精确位置与规划起点明显不符(>150m)时才重规划，避免起点本就准确时的无谓规划。
  if (_startedWithFuzzyOrigin && acc <= GPS_ACCURACY_GOOD) {
    _startedWithFuzzyOrigin = false;
    const offset = _plannedOrigin
      ? haversine(latitude, longitude, _plannedOrigin[0], _plannedOrigin[1])
      : Infinity;
    if (offset > FUZZY_ORIGIN_REROUTE_MIN_OFFSET) {
      console.log(`[NaviService] 精确位置恢复(source=${source}, 与规划起点偏差${Math.round(offset)}m)，自动重规划路线`);
      reroute();
    } else {
      console.log(`[NaviService] 精确位置与规划起点偏差仅${Math.round(offset)}m，无需重规划`);
    }
  }

  //  TTS / UI  / 
  // 
  if (_isPausedDueToBackground) return;

  updateStepProgress();
  notify();

  if (checkArrival()) {
    handleArrival();
  }
}

function startSignalQualityMonitor() {
  stopSignalQualityMonitor();
  _signalCheckTimer = setInterval(() => {
    if (!_isNavigating) {
      stopSignalQualityMonitor();
      return;
    }
    const now = Date.now();
    // 无位置看门狗：追踪以 BestForNavigation(纯GPS级) 启动后室内长时间无回调时，
    // 自动降级 Balanced 网络定位，保证室内也能持续输出模糊位置
    if (_locationTrackingActive && _currentTrackingAccuracy === Location.Accuracy.BestForNavigation) {
      const noPosTooLong = _lastPositionUpdateTime === 0
        ? now - _startTime > NO_POSITION_DOWNGRADE_TIMEOUT
        : now - _lastPositionUpdateTime > NO_POSITION_DOWNGRADE_TIMEOUT;
      if (noPosTooLong && now >= _accuracySwitchCooldown) {
        console.log('[NaviService] 无位置回调看门狗触发，降级到Balanced网络定位');
        _currentTrackingAccuracy = Location.Accuracy.Balanced;
        _accuracySwitchCooldown = now + ACCURACY_SWITCH_COOLDOWN;
        applyNewAccuracy();
      }
    }
    if (_lastPositionUpdateTime > 0 && now - _lastPositionUpdateTime > SIGNAL_NONE_TIMEOUT) {
      if (_gpsSignal.quality !== 'none') {
        console.log(`[NaviService] GPS丢失: ${(now - _lastPositionUpdateTime) / 1000}秒`);
        _gpsSignal = { quality: 'none', accuracy: null, source: 'unknown', lastUpdateTime: _lastPositionUpdateTime };
        useMapStore.getState().setGpsSignal({ ..._gpsSignal });
        notify();
      }
    }
    // GPS丢失超过阈值后启动隧道模式
    // 仅限驾车且速度足够时启用：步行/室内 GPS 丢失时 _currentSpeed 可能残留小速度，
    // 误触发隧道模式会沿路线虚假推进位置，导致播报和剩余距离错乱
    if (_lastPositionUpdateTime > 0 && now - _lastPositionUpdateTime > TUNNEL_MODE_START_TIMEOUT) {
      if (!_tunnelModeActive && _mode === 'drive' && _currentSpeed >= MIN_SPEED_DRIVE) {
        startTunnelMode();
      }
    }
  }, SIGNAL_CHECK_INTERVAL);
}

function stopSignalQualityMonitor() {
  if (_signalCheckTimer) {
    clearInterval(_signalCheckTimer);
    _signalCheckTimer = null;
  }
}

// ========== 隧道模式 ==========
/** 启动隧道模式：GPS丢失时根据进入前速度沿路线预测位置 */
function startTunnelMode() {
  if (_tunnelModeActive) return;
  _tunnelModeActive = true;
  _speedBeforeTunnel = _currentSpeed;
  _lastGpsPositionBeforeTunnel = _currentPositionGcj ? [_currentPositionGcj[0], _currentPositionGcj[1]] : null;
  console.log(`[NaviService] 进入隧道模式，速度=${_speedBeforeTunnel.toFixed(1)}m/s`);

  _tunnelModeTimer = setInterval(() => {
    if (!_isNavigating || !_routeData || !_currentPositionGcj) {
      stopTunnelMode();
      return;
    }
    // 沿路线 polyline 推进预测位置
    const flat = _routeData.flatPolyline;
    if (!flat || flat.length < 2) return;

    const moveMeters = _speedBeforeTunnel * (TUNNEL_PREDICTION_INTERVAL / 1000);
    let remaining = moveMeters;
    let predLat = _currentPositionGcj[0];
    let predLng = _currentPositionGcj[1];

    // 从当前位置沿 polyline 向前推进
    for (let i = _routeStartIdx; i < flat.length - 1 && remaining > 0; i++) {
      const segDist = haversine(flat[i][1], flat[i][0], flat[i + 1][1], flat[i + 1][0]);
      const distToSeg = haversine(predLat, predLng, flat[i][1], flat[i][0]);

      if (distToSeg < 50) {
        // 当前位置在这个线段附近
        if (segDist <= remaining) {
          predLat = flat[i + 1][1];
          predLng = flat[i + 1][0];
          remaining -= segDist;
          _routeStartIdx = i + 1;
        } else {
          // 按比例插值
          const ratio = remaining / segDist;
          predLat = predLat + (flat[i + 1][1] - predLat) * ratio;
          predLng = predLng + (flat[i + 1][0] - predLng) * ratio;
          remaining = 0;
        }
      }
    }

    _currentPositionGcj = [predLat, predLng];
    // 更新步骤进度和UI
    updateStepProgress();
    notify();
    console.log(`[NaviService] 隧道模式: 推进${moveMeters.toFixed(0)}m, 位置=${predLat.toFixed(5)},${predLng.toFixed(5)}`);
  }, TUNNEL_PREDICTION_INTERVAL);
}

/** 停止隧道模式：GPS恢复后调用 */
function stopTunnelMode() {
  if (!_tunnelModeActive) return;
  _tunnelModeActive = false;
  if (_tunnelModeTimer) {
    clearInterval(_tunnelModeTimer);
    _tunnelModeTimer = null;
  }
  _speedBeforeTunnel = 0;
  _lastGpsPositionBeforeTunnel = null;
  console.log('[NaviService] 退出隧道模式');
}

function stopLocationTracking() {
  _locationTrackingActive = false;
  stopSignalQualityMonitor();
  stopTunnelMode();
  if (_locationSub) {
    _locationSub.remove();
    _locationSub = null;
  }
  // 清理罗盘朝向监听（compassService 替代 expo-location 的 watchHeadingAsync）
  compassService.stop();
  _headingSub = null;
  _compassHeading = null;
  // 
  Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)
    .then((running) => {
      if (running) {
        return Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }
    })
    .catch((e: any) => {
      console.error('[NaviService] :', e.message || e);
    });
}

// ==========  ==========

/** Haversine */
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcRemainingDistance(): number {
  if (!_routeData || !_currentPositionGcj) return 0;
  const flat = _routeData.flatPolyline;
  if (flat.length === 0) return 0;
  // 
  const [gcjLat, gcjLng] = _currentPositionGcj;
  // 
  const nearestIdx = findNearestPointOnPolyline(gcjLat, gcjLng, flat);
  // 
  let remaining = 0;
  // nearestIdx 
  const [nlng, nlat] = flat[nearestIdx];
  remaining += haversine(gcjLat, gcjLng, nlat, nlng);
  // nearestIdx 
  for (let i = nearestIdx; i < flat.length - 1; i++) {
    remaining += haversine(flat[i][1], flat[i][0], flat[i + 1][1], flat[i + 1][0]);
  }
  return remaining;
}

/** / */
function calculateCurrentSpeed(): number {
  const now = Date.now();

  // 
  _positionHistory = _positionHistory.filter(
    (p) => now - p.timestamp <= SPEED_HISTORY_MAX_AGE
  );

  if (_positionHistory.length < 2) {
    return 0;
  }

  // 
  let totalDistance = 0;
  let totalTime = 0;

  for (let i = 1; i < _positionHistory.length; i++) {
    const prev = _positionHistory[i - 1];
    const curr = _positionHistory[i];
    const dist = haversine(prev.lat, prev.lng, curr.lat, curr.lng);
    const time = (curr.timestamp - prev.timestamp) / 1000;
    if (time > 0) {
      totalDistance += dist;
      totalTime += time;
    }
  }

  if (totalTime <= 0) return 0;

  // 
  const avgSpeed = totalDistance / totalTime;

  // 
  const minSpeed = _mode === 'walk' ? MIN_SPEED_WALK
    : _mode === 'bicycling' ? MIN_SPEED_BICYCLE
      : MIN_SPEED_DRIVE;

  // 
  return Math.max(avgSpeed, minSpeed * 0.3);
}

/**  */
function updateSpeedAndRemainingTime() {
  const now = Date.now();

  // 
  if (_currentPosition) {
    const lastRecord = _positionHistory[_positionHistory.length - 1];
    if (!lastRecord ||
        lastRecord.lat !== _currentPosition[0] ||
        lastRecord.lng !== _currentPosition[1]) {
      _positionHistory.push({
        lat: _currentPosition[0],
        lng: _currentPosition[1],
        timestamp: now,
      });
    }
  }

  // 
  if (now - _lastSpeedCalcTime < SPEED_CALC_INTERVAL) {
    return;
  }
  _lastSpeedCalcTime = now;

  // 
  _positionHistory = _positionHistory.filter(
    (p) => now - p.timestamp <= SPEED_HISTORY_MAX_AGE
  );

  // 
  _currentSpeed = calculateCurrentSpeed();

  // 
  const remainingDist = calcRemainingDistance();

  // 
  if (_currentSpeed > 0 && remainingDist > 0) {
    _remainingDuration = Math.round(remainingDist / _currentSpeed);
  } else if (remainingDist > 0) {
    // 
    if (_routeData && _routeData.totalDuration > 0 && _routeData.totalDistance > 0) {
      const avgRouteSpeed = _routeData.totalDistance / _routeData.totalDuration;
      _remainingDuration = Math.round(remainingDist / avgRouteSpeed);
    } else {
      _remainingDuration = 0;
    }
  } else {
    _remainingDuration = 0;
  }

  console.log(`[NaviService] : ${_currentSpeed.toFixed(2)}m/s, : ${Math.round(remainingDist)}m, : ${_remainingDuration}s`);
}

function findNearestPointOnPolyline(lat: number, lng: number, polyline: [number, number][]): number {
  let minDist = Infinity;
  let minIdx = 0;
  for (let i = 0; i < polyline.length; i++) {
    const d = haversine(lat, lng, polyline[i][1], polyline[i][0]);
    if (d < minDist) {
      minDist = d;
      minIdx = i;
    }
  }
  return minIdx;
}

/** 计算点到折线的最短距离（考虑线段，而非仅顶点） */
function distToPolyline(lat: number, lng: number, polyline: [number, number][]): number {
  if (polyline.length === 0) return Infinity;
  if (polyline.length === 1) return haversine(lat, lng, polyline[0][1], polyline[0][0]);

  let minDist = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = distToSegment(lat, lng, polyline[i], polyline[i + 1]);
    if (d < minDist) {
      minDist = d;
    }
  }
  return minDist;
}

/** 计算点到线段的最短距离（投影到线段上，取垂直距离或端点距离） */
function distToSegment(lat: number, lng: number, a: [number, number], b: [number, number]): number {
  // 将经纬度近似转为平面坐标（米），适用于短距离
  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  const cosLat = Math.cos(toRad(lat));

  const px = lng * cosLat * R * Math.PI / 180;
  const py = lat * R * Math.PI / 180;
  const ax = a[0] * Math.cos(toRad(a[1])) * R * Math.PI / 180;
  const ay = a[1] * R * Math.PI / 180;
  const bx = b[0] * Math.cos(toRad(b[1])) * R * Math.PI / 180;
  const by = b[1] * R * Math.PI / 180;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    // 线段退化为点
    return haversine(lat, lng, a[1], a[0]);
  }

  // 投影参数 t，clamp 到 [0, 1]
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  // 投影点坐标
  const projLat = (ay + t * dy) / (R * Math.PI / 180);
  const projLng = (ax + t * dx) / (cosLat * R * Math.PI / 180);

  return haversine(lat, lng, projLat, projLng);
}

function updateStepProgress() {
  if (!_routeData || !_currentPositionGcj) return;
  const [gcjLat, gcjLng] = _currentPositionGcj;
  const flat = _routeData.flatPolyline;
  if (flat.length === 0) return;

  //
  const nearestIdx = findNearestPointOnPolyline(gcjLat, gcjLng, flat);
  // 使用点到线段距离检测偏航，避免简化 polyline 后顶点间距大导致误判
  const distToRoute = distToPolyline(gcjLat, gcjLng, flat);

  // 
  const now = Date.now();
  if (now - _lastDeviateCheckTime > DEVIATE_CHECK_INTERVAL) {
    _lastDeviateCheckTime = now;
    checkAndHandleDeviation(distToRoute, nearestIdx);
  }

  // GPS2
  // 步骤边界一律使用 stepEndFlatIndices（解析时通过抽稀映射预计算），
  // 不能用"原始 steps 点数累计"——flatPolyline 已抽稀，两套索引体系不一致
  const steps = _routeData.steps;
  const stepEnds = _routeData.stepEndFlatIndices;
  if (!stepEnds || stepEnds.length !== steps.length) return;
  const stepStartIdx = _currentStepIndex > 0 ? stepEnds[_currentStepIndex - 1] : 0;
  const stepEndIdx = stepEnds[_currentStepIndex];

  // Q
  let effectiveIdx = nearestIdx;
  
  if (_forwardOnlyMode) {
    //  entry 
    if (nearestIdx < _stepEntryIndex) {
      // GPS
      effectiveIdx = _lastForwardNearestIdx;
    } else if (nearestIdx > _lastForwardNearestIdx + 30) {
      // GPS0
      effectiveIdx = Math.min(nearestIdx, _lastForwardNearestIdx + 10);
    }
  }

  // 
  _lastForwardNearestIdx = effectiveIdx;

  // GPS
  if (_currentStepIndex < steps.length) {
    const stepPoints = steps[_currentStepIndex].polyline;
    // 
    if (stepPoints.length >= 2) {
      const startPoint = stepPoints[0];
      const distFromStart = haversine(gcjLat, gcjLng, startPoint[1], startPoint[0]);
      _distanceTraveledInStep = Math.max(_distanceTraveledInStep, distFromStart);
    }
  }

  // 
  if (effectiveIdx >= stepEndIdx - 2 && _currentStepIndex < steps.length - 1) {
    // 
    // GPS
    const hasMovedEnough = _distanceTraveledInStep >= MIN_DISTANCE_TO_TRANSITION;
    if (now >= _stepTransitionCooldown && hasMovedEnough) {
      _currentStepIndex++;
      _stepEntryIndex = stepEndIdx;
      _stepForwardProgress = 0;
      _stepTransitionCooldown = now + STEP_TRANSITION_COOLDOWN_MS;  // 
      _distanceTraveledInStep = 0;  // 
      // 不再在步骤切换后播报，改为由 checkAndAnnounceApproach 提前播报
      // 避免过了路口才播报的问题
      _approachingSpoken.add(_currentStepIndex - 1);
    }
    // k
  } else if (effectiveIdx < stepStartIdx && _currentStepIndex > 0) {
    // 1
    //
    let newStepIndex = 0;
    for (let i = 0; i < steps.length; i++) {
      if (effectiveIdx <= stepEnds[i]) {
        newStepIndex = i;
        break;
      }
    }
    if (newStepIndex !== _currentStepIndex) {
      _currentStepIndex = newStepIndex;
      _stepEntryIndex = newStepIndex > 0 ? stepEnds[newStepIndex - 1] : 0;
      // 回退时不播报，避免GPS漂移导致重复播报
    }
  } else {
    // 
    const stepLength = stepEndIdx - stepStartIdx;
    if (stepLength > 0) {
      _stepForwardProgress = (effectiveIdx - stepStartIdx) / stepLength;
    }
  }

  // 提前预判播报：根据距离下一个路口的距离，速度自适应地提前播报
  // 替代旧的 150m 固定阈值逻辑，解决播报滞后和红绿灯路口未播报问题
  checkAndAnnounceApproach();
}

/** 偏航检测与处理 */
function checkAndHandleDeviation(distToRoute: number, _nearestIdx: number) {
  if (!_routeData || !_currentPositionGcj) return;

  const now = Date.now();
  // 根据 GPS 精度动态调整偏航阈值：精度越差阈值越宽松
  const gpsAccuracy = _gpsSignal.accuracy || 10;
  const effectiveThreshold = Math.max(DEVIATE_THRESHOLD_METERS, gpsAccuracy * 2);

  if (distToRoute > effectiveThreshold) {
    _deviateConfirmCount++;
    // 需要连续多次检测到偏航才确认，避免 GPS 瞬时飘移导致误判
    if (_deviateConfirmCount >= DEVIATE_CONFIRM_COUNT) {
      if (!_deviateAlertGiven && now - _lastDeviateAlertTime > DEVIATE_ALERT_COOLDOWN) {
        _deviateAlertGiven = true;
        _lastDeviateAlertTime = now;
        // TTS
        Speech.stop();
        setTimeout(() => {
          safeSpeak('已偏离路线，正在重新规划', { language: 'zh-CN', rate: 0.9 });
        }, 100);
        reroute();
      }
    }
  } else {
    // 回到路线上，重置偏航计数
    _deviateConfirmCount = 0;
    if (_deviateAlertGiven) {
      _deviateAlertGiven = false;
    }
  }
}

/** 重规划路线 */
async function reroute() {
  if (_isRerouting) return;
  if (!_currentPositionGcj || !_routeData) return;
  if (!_isNavigating) return;

  _isRerouting = true;
  console.log('[NaviService] reroute: 重新规划...');

  try {
    const { recommended, alternate } = await planRoutes(
      _currentPosition!,
      [_destLat, _destLng],
      _mode,
    );

    if (!_isNavigating) { _isRerouting = false; return; }

    // 设置重规划选项，通知 UI 显示选择
    _rerouteOptions = { recommended, alternate };
    _routeData = recommended;
    _routeStartIdx = 0;
    _deviateAlertGiven = false;

    _currentSpeed = 0;
    _positionHistory = [];
    _lastSpeedCalcTime = 0;

    const flat = recommended.flatPolyline;
    const gcjPos = _currentPositionGcj;

    if (flat.length >= 2 && gcjPos) {
      let nearestIdx = 0;
      let minDist = Infinity;
      for (let i = 0; i < flat.length; i++) {
        const d = haversine(gcjPos[0], gcjPos[1], flat[i][1], flat[i][0]);
        if (d < minDist) { minDist = d; nearestIdx = i; }
      }

      const stepEnds = recommended.stepEndFlatIndices;
      let newStepIdx = recommended.steps.length - 1;
      for (let i = 0; i < stepEnds.length; i++) {
        if (nearestIdx <= stepEnds[i]) { newStepIdx = i; break; }
      }

      _currentStepIndex = newStepIdx;
      _lastSpokenStepIndex = -1;
      _stepEntryIndex = 0;
      _stepForwardProgress = 0;
      _lastForwardNearestIdx = Math.max(0, nearestIdx - 5);
      _forwardOnlyMode = true;
      _distanceTraveledInStep = 0;
      _stepTransitionCooldown = Date.now() + 2000;
      _approachingSpoken = new Set();
      resetAnnounceState();

      console.log(`[NaviService] reroute: 步数=${recommended.steps.length}, 当前步=${newStepIdx}, 最近点=${nearestIdx}/${flat.length}`);
    } else {
      _currentStepIndex = 0;
      _lastSpokenStepIndex = -1;
      _stepEntryIndex = 0;
      _stepForwardProgress = 0;
      _lastForwardNearestIdx = 0;
      _forwardOnlyMode = true;
      _distanceTraveledInStep = 0;
      _stepTransitionCooldown = 0;
      _approachingSpoken = new Set();
      resetAnnounceState();
    }

    _rerouteSuccessCount++;

    Speech.stop();
    setTimeout(() => {
      // 重规划仅播报简短提示，转向指导由 checkAndAnnounceApproach 在路口前 100 米统一处理
      safeSpeak('路线已重新规划', { language: 'zh-CN' });
    }, 200);

    notify();
    console.log(`[NaviService] reroute: 完成 (${_rerouteSuccessCount})`);
  } catch (e: any) {
    console.warn('[NaviService] reroute: 失败', e.message || e);
    setTimeout(() => { _deviateAlertGiven = false; }, DEVIATE_ALERT_COOLDOWN);
  }

  _isRerouting = false;
}

/** 用户选择重规划路线 */
export function selectReroute(key: 'recommended' | 'alternate') {
  if (!_rerouteOptions) return;
  const route = key === 'alternate' && _rerouteOptions.alternate
    ? _rerouteOptions.alternate
    : _rerouteOptions.recommended;
  _routeData = route;
  _rerouteOptions = null;

  // 重新计算当前步骤（使用解析时预计算的抽稀映射索引）
  const flat = route.flatPolyline;
  const gcjPos = _currentPositionGcj;
  if (flat.length >= 2 && gcjPos) {
    let nearestIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < flat.length; i++) {
      const d = haversine(gcjPos[0], gcjPos[1], flat[i][1], flat[i][0]);
      if (d < minDist) { minDist = d; nearestIdx = i; }
    }
    const stepEnds = route.stepEndFlatIndices;
    let newStepIdx = route.steps.length - 1;
    for (let i = 0; i < stepEnds.length; i++) {
      if (nearestIdx <= stepEnds[i]) { newStepIdx = i; break; }
    }
    _currentStepIndex = newStepIdx;
  } else {
    _currentStepIndex = 0;
  }
  _lastSpokenStepIndex = -1;
  _stepEntryIndex = 0;
  _stepForwardProgress = 0;
  _forwardOnlyMode = true;
  _distanceTraveledInStep = 0;
  _stepTransitionCooldown = Date.now() + 2000;
  _approachingSpoken = new Set();
  resetAnnounceState();

  notify();
}

function checkArrival(): boolean {
  if (!_routeData || !_currentPositionGcj) return false;
  const [gcjLat, gcjLng] = _currentPositionGcj;
  const destGcj = _routeData.destination;
  const dist = haversine(gcjLat, gcjLng, destGcj[1], destGcj[0]);
  return dist < 50; // 50
}

function handleArrival() {
  // 到达后位置仍会连续更新并反复命中 checkArrival，只处理第一次到达
  if (_arrived) return;
  _arrived = true;

  // 语音 + 文字播报：已到达终点XXX
  _arrivalMessage = `已到达终点${_destName || '目的地'}`;
  safeSpeak(_arrivalMessage, { language: 'zh-CN', rate: 0.85 });
  notify(); // 通知 UI（导航面板状态栏）显示到达文案

  _arrivalCallback?.();

  // 播报完成后停止导航；不清除路线，导航轨迹保留在地图上
  setTimeout(() => stopNavigation(), 5000);
}

// ========== TTS  ==========
/**
 * 受语音播报开关控制的 TTS 包装
 * 关闭 ttsEnabled 时直接跳过，避免导航过程中产生任何语音
 * 注意：传入空串时仍会调用 Speech.speak（用于清空当前播报队列的占位）
 */
function safeSpeak(text: string, options?: Speech.SpeechOptions): void {
  const appSettings = useMapStore.getState().appSettings;
  const ttsEnabled = appSettings?.ttsEnabled ?? true;
  if (!ttsEnabled) return;
  if (!text) {
    // 空串仅用于清空当前播报队列
    Speech.stop();
    return;
  }
  // expo-speech 的 speak() 返回 void（不是 Promise），不能用 .catch()。
  // 错误通过 SpeechOptions.onError 回调处理。
  Speech.speak(text, {
    ...options,
    onError: (e: Error) => {
      console.error('[NaviService] Speech.speak error:', e?.message || e);
    },
  });
}

/** 判断指令是否包含转向动作（需要播报），直行路段不需要播报 */
function isTurnInstruction(instruction: string): boolean {
  if (!instruction) return false;
  // 转向关键词
  const turnKeywords = ['左转', '右转', '掉头', '向左', '向右', '左前方', '右前方',
    '左后方', '右后方', '进入', '驶出', '上匝道', '下匝道', '进入环岛',
    '靠左', '靠右', '直行向', '出口'];
  return turnKeywords.some(kw => instruction.includes(kw));
}

/** 判断是否为复杂路口（多分叉/匝道/环岛等容易走错的场景） */
function isComplexIntersection(instruction: string): boolean {
  if (!instruction) return false;
  const complexKeywords = ['匝道', '环岛', '立交桥', '枢纽', '分叉', '分流',
    '进入高速', '驶出高速', '进入环路', '出口', '交汇处', '枢纽互通'];
  return complexKeywords.some(kw => instruction.includes(kw));
}

/** 距离文案格式化 */
function formatDistanceText(distMeters: number): string {
  if (distMeters >= 1000) {
    return `${(distMeters / 1000).toFixed(1)}公里`;
  }
  return `${Math.round(distMeters)}米`;
}

/** 计算速度自适应的路口播报阈值（默认 100 米，高速时按速度提前） */
function getNearAnnounceDist(): number {
  const speed = Math.max(_currentSpeed, 0); // m/s
  const speedBasedDist = speed * ANNOUNCE_NEAR_SPEED_FACTOR;
  return Math.min(
    Math.max(ANNOUNCE_NEAR_BASE_DIST, speedBasedDist),
    ANNOUNCE_NEAR_MAX_DIST
  );
}

/** 检查并标记某个步骤的某个播报阶段是否已执行 */
function hasAnnounced(stepIndex: number, phase: AnnouncePhase): boolean {
  const phases = _announcedPhases.get(stepIndex);
  return phases ? phases.has(phase) : false;
}

/** 标记某个步骤的某个播报阶段已执行 */
function markAnnounced(stepIndex: number, phase: AnnouncePhase): void {
  if (!_announcedPhases.has(stepIndex)) {
    _announcedPhases.set(stepIndex, new Set());
  }
  _announcedPhases.get(stepIndex)!.add(phase);
}

/** 重置所有播报状态（启动导航/重规划时调用） */
function resetAnnounceState(): void {
  _announcedPhases.clear();
  _lastAnnounceTime = 0;
  _lastSpokenStepIndex = -1;
}

/**
 * 构建路口播报文案
 * 格式：
 *   - 转向：前方路口右转进入XX道路
 *   - 直行：前方路口直行进入XX道路
 *   - 复杂路口（匝道/环岛等）：保留原始 instruction 完整内容
 */
function buildIntersectionAnnouncement(nextStep: RouteStep, isComplex: boolean): string {
  const roadName = nextStep.road;
  const isTurn = isTurnInstruction(nextStep.instruction);

  // 复杂路口保留完整指令（匝道/环岛等容易走错的场景，instruction 通常已含详细描述）
  if (isComplex) {
    if (roadName && !nextStep.instruction.includes(roadName)) {
      return `前方${nextStep.instruction}进入${roadName}`;
    }
    return `前方${nextStep.instruction}`;
  }

  if (isTurn) {
    // 转向指令：构建 "前方路口右转进入XX道路" 格式
    if (roadName && nextStep.instruction.includes(roadName)) {
      // instruction 已含道路名（高德 API 常见返回格式）
      return `前方路口${nextStep.instruction}`;
    }
    if (roadName) {
      // 拼接道路名
      return `前方路口${nextStep.instruction}进入${roadName}`;
    }
    // 无道路名时只播报转向动作
    return `前方路口${nextStep.instruction}`;
  }

  // 直行通过路口（红绿灯路口）
  if (roadName) {
    return `前方路口直行进入${roadName}`;
  }
  return `前方路口直行通过`;
}

/**
 * 路口提前播报核心逻辑（精简版）
 * 在每次位置更新时调用，仅在路口前 ~100 米播报一次转向指导
 * - near: 路口前 100 米指导（速度自适应，高速时更早）
 */
function checkAndAnnounceApproach(): void {
  if (!_routeData || !_currentPositionGcj) return;
  const steps = _routeData.steps;
  if (steps.length === 0) return;

  const [gcjLat, gcjLng] = _currentPositionGcj;
  const now = Date.now();

  // 当前步骤的结束点就是下一个路口
  // 播报的是"下一步"的指令（即到达当前步骤终点后要做什么）
  const currentStepIdx = _currentStepIndex;
  if (currentStepIdx >= steps.length - 1) return; // 已是最后一步，无需提前播报

  const nextStepIdx = currentStepIdx + 1;
  const nextStep = steps[nextStepIdx];
  if (!nextStep || !nextStep.instruction) return;

  // 当前步骤终点（路口）在 flatPolyline 中的索引——直接使用解析时预计算的
  // 抽稀映射索引。绝不能用"原始 steps 点数累计"代替：flatPolyline 已抽稀，
  // 索引错位会导致路口位置错误（播报过早/过晚/完全不播）
  const stepEnds = _routeData.stepEndFlatIndices;
  if (!stepEnds || stepEnds.length !== steps.length) return;
  const stepEndIdx = stepEnds[currentStepIdx];

  const flat = _routeData.flatPolyline;
  if (stepEndIdx == null || stepEndIdx >= flat.length) return;

  // 计算到路口的距离
  const endPoint = flat[stepEndIdx];
  const distToIntersection = haversine(gcjLat, gcjLng, endPoint[1], endPoint[0]);

  // 判断是否为复杂路口
  const isComplex = isComplexIntersection(nextStep.instruction);
  const nearDist = getNearAnnounceDist() + (isComplex ? COMPLEX_INTERSECTION_EXTRA_DIST : 0);

  // === Near 阶段：路口前 100 米播报转向指导 ===
  if (distToIntersection <= nearDist && distToIntersection > 15) {
    if (!hasAnnounced(nextStepIdx, 'near')) {
      // 全局防抖：距离上次播报至少 MIN_ANNOUNCE_INTERVAL_MS
      if (now - _lastAnnounceTime < MIN_ANNOUNCE_INTERVAL_MS) return;
      markAnnounced(nextStepIdx, 'near');
      _lastAnnounceTime = now;
      _lastSpokenStepIndex = nextStepIdx;

      const announcement = buildIntersectionAnnouncement(nextStep, isComplex);
      safeSpeak(announcement, { language: 'zh-CN', rate: 0.9 });
      return;
    }
  }
}

/**
 * 启动播报：全程总览
 * 播报全程距离和预计到达时间，例如：
 * "全程12.5公里，预计25分钟到达"
 */
function speakRouteOverview(): void {
  if (!_routeData) return;
  const totalDist = _routeData.totalDistance;
  const totalDur = _routeData.totalDuration;
  const destName = _destName || '目的地';

  const distText = formatDistanceText(totalDist);
  const durText = formatDurationText(totalDur);

  safeSpeak(`全程${distText}，预计${durText}到达${destName}`, { language: 'zh-CN', rate: 0.9 });
}

/** 格式化时长（秒 -> 中文） */
function formatDurationText(seconds: number): string {
  if (!seconds || seconds <= 0) return '未知时间';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (remainMin === 0) {
    return `${hours}小时`;
  }
  return `${hours}小时${remainMin}分钟`;
}

function speakStep(stepIndex: number) {
  // 此函数已废弃，启动播报改用 speakRouteOverview()
  // 行程中路口转向指导由 checkAndAnnounceApproach 统一管理
  void stepIndex;
  return;
}

// ========== ==========
export function getNaviState(): NaviStateSnapshot {
  return {
    isNavigating: _isNavigating,
    currentStepIndex: _currentStepIndex,
    currentPosition: _currentPosition,
    prevStepEndIndex: _routeData && _currentPositionGcj
      ? findNearestPointOnPolyline(_currentPositionGcj[0], _currentPositionGcj[1], _routeData.flatPolyline)
      : 0,
    remainingDistance: calcRemainingDistance(),
    remainingDuration: _remainingDuration,
    elapsedSec: _elapsedSec,
    destLat: _destLat,
    destLng: _destLng,
    destName: _destName,
    mode: _mode,
    routeData: _routeData,
    heading: _currentHeading,
    gpsSignal: { ..._gpsSignal },
    currentSpeedMps: _currentSpeed,
    rerouteOptions: _rerouteOptions,
    arrivalMessage: _arrivalMessage,
  };
}

export function isNavigating(): boolean {
  return _isNavigating;
}

/** GCJ-02 */
export function getCurrentPositionGcj(): [number, number] | null {
  return _currentPositionGcj;
}

/**  heading */
export function getCurrentHeading(): number | null {
  return _currentHeading;
}

/** m/s zoom */
export function getCurrentSpeedMps(): number {
  return _currentSpeed;
}
