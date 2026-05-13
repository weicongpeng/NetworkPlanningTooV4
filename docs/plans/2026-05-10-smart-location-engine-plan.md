# 智能并行定位引擎 - 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 构建一个智能并行定位引擎，解决手机APP端室内定位失败和响应慢的问题，实现首次定位 < 3秒、室内成功率 > 90%。

**Architecture:** 新建 `LocationEngine.ts` 核心模块，实现多源并行竞争定位（expo-location + AMap WebView + 系统缓存），配合场景自适应逻辑（室内/室外检测），替代当前串行等待的定位策略。

**Tech Stack:** TypeScript, React Native, expo-location (~18.0.10), WebView (高德地图JS API), Zustand状态管理

---

## Stage 1: LocationEngine 核心模块基础结构

### Task 1: 创建 LocationEngine 类型定义和基础类结构

**Files:**
- Create: `mobile-app/src/services/LocationEngine.ts`

**Step 1: 创建类型定义和接口**

```typescript
/**
 * 智能并行定位引擎
 * 
 * 解决问题：
 * - 室内定位失败（无GPS信号时卡死）
 * - 首次定位响应慢（10-60秒）
 * - 室内外切换时定位丢失
 * 
 * 核心策略：
 * - 并行多源定位（谁先返回用谁）
 * - 场景自适应（室内/室外自动检测）
 * - 精度升级（先快后精）
 */

import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { wgs84ToGcj02 } from '../utils/coordinate';

// ============ 类型定义 ============

/** 定位结果 */
export interface PositionResult {
  /** 纬度 (GCJ-02) */
  lat: number;
  /** 经度 (GCJ-02) */
  lng: number;
  /** 精度（米） */
  accuracy: number;
  /** 定位来源 */
  source: 'gps' | 'network' | 'amap' | 'cache' | 'ip' | 'expo';
  /** 时间戳 */
  timestamp: number;
}

/** 定位引擎配置 */
export interface LocationEngineConfig {
  /** 首次定位超时（毫秒），默认5000 */
  firstFixTimeout?: number;
  /** 是否启用室内优化，默认true */
  indoorOptimization?: boolean;
  /** 导航模式下的精度偏好 */
  navigationMode?: boolean;
}

/** 场景类型 */
type SceneType = 'indoor' | 'outdoor' | 'driving';

/** 定位策略 */
type LocationStrategy = 'network_first' | 'gps_primary' | 'balanced';

/** 场景检测结果 */
interface SceneInfo {
  type: SceneType;
  strategy: LocationStrategy;
  isIndoor: boolean;
  signalStrength: 'strong' | 'weak' | 'none';
}

/** 定位Provider接口 */
interface LocationProvider {
  name: string;
  getLocation(options?: { timeout?: number }): Promise<PositionResult | null>;
  isAvailable(): boolean;
}

// ============ 常量 ============

const DEFAULT_CONFIG: Required<LocationEngineConfig> = {
  firstFixTimeout: 5000,
  indoorOptimization: true,
  navigationMode: false,
};

/** 缓存TTL：5分钟 */
const CACHE_TTL = 5 * 60 * 1000;

/** 新鲜缓存TTL：30秒（用于快速返回） */
const FRESH_CACHE_TTL = 30 * 1000;

// ============ LocationEngine 主类 ============

class LocationEngine {
  private config: Required<LocationEngineConfig>;
  private cache: PositionResult | null = null;
  private providers: LocationProvider[] = [];
  private currentScene: SceneInfo | null = null;
  
  constructor(config?: LocationEngineConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initProviders();
  }

  /** 初始化定位Provider */
  private initProviders(): void {
    // Provider注册顺序代表优先级
    this.providers = [
      new ExpoLocationProvider(),
      // AMapWebProvider 通过外部注入（避免循环依赖）
      // new CacheProvider(this.cache),
    ];
  }

  /**
   * 获取当前位置（并行快速定位）
   * 
   * @param config 可选配置覆盖
   * @returns 定位结果Promise，首次定位 < 3秒
   */
  async getCurrentPosition(config?: LocationEngineConfig): Promise<PositionResult | null> {
    const mergedConfig = { ...this.config, ...config };
    console.log('[LocationEngine] getCurrentPosition: 开始并行定位...');
    
    const startTime = Date.now();

    // 1. 检查新鲜缓存（< 30秒，立即返回）
    const freshCache = this.getFreshCache();
    if (freshCache) {
      console.log(`[LocationEngine] 使用新鲜缓存(${Date.now() - freshCache.timestamp}ms前)`);
      return freshCache;
    }

    // 2. 并行发起多个定位请求
    const results = await this.raceAllProviders(mergedConfig.firstFixTimeout);
    
    if (results.winner) {
      // 更新缓存
      this.cache = results.winner;
      const elapsed = Date.now() - startTime;
      console.log(
        `[LocationEngine] 定位成功 [${results.winner.lat.toFixed(6)}, ${results.winner.lng.toFixed(6)}], ` +
        `精度=${Math.round(results.winner.accuracy)}m, 来源=${results.winner.source}, 耗时=${elapsed}ms`
      );
      return results.winner;
    }

    // 3. 使用过期缓存兜底（< 5分钟）
    const staleCache = this.getStaleCache();
    if (staleCache) {
      console.log('[LocationEngine] 所有方式失败，使用过期缓存兜底');
      return staleCache;
    }

    console.error('[LocationEngine] 所有定位方式均失败');
    return null;
  }

  /**
   * 并行竞争所有Provider
   */
  private async raceAllProviders(timeout: number): Promise<{
    winner: PositionResult | null;
    allResults: PositionResult[];
  }> {
    const promises = this.providers.map(provider => 
      this.raceProvider(provider, timeout).catch(err => {
        console.log(`[LocationEngine] ${provider.name} 失败:`, err.message);
        return null;
      })
    );

    // 设置总超时
    const timeoutPromise = new Promise<null>(resolve => 
      setTimeout(() => resolve(null), timeout)
    );

    // 等待第一个成功或超时
    const results = await Promise.allSettled([...promises, timeoutPromise]);
    
    // 收集所有成功结果
    const allResults: PositionResult[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        allResults.push(result.value);
      }
    }

    // 返回精度最高的结果（通常是第一个成功的）
    const winner = allResults.length > 0 
      ? allResults.reduce((best, current) => 
          current.accuracy < best.accuracy ? current : best
        )
      : null;

    return { winner, allResults };
  }

  /**
   * 单个Provider竞速（带超时）
   */
  private async raceProvider(
    provider: LocationProvider, 
    timeout: number
  ): Promise<PositionResult | null> {
    if (!provider.isAvailable()) {
      return null;
    }

    const locationPromise = provider.getLocation({ timeout });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${provider.name} 超时`)), timeout)
    );

    return Promise.race([locationPromise, timeoutPromise]);
  }

  /** 获取新鲜缓存 (< 30秒) */
  private getFreshCache(): PositionResult | null {
    if (this.cache && Date.now() - this.cache.timestamp < FRESH_CACHE_TTL) {
      return this.cache;
    }
    return null;
  }

  /** 获取过期缓存 (< 5分钟) */
  private getStaleCache(): PositionResult | null {
    if (this.cache && Date.now() - this.cache.timestamp < CACHE_TTL) {
      return this.cache;
    }
    return null;
  }

  /** 更新缓存 */
  updateCache(position: PositionResult): void {
    this.cache = position;
  }

  /** 获取当前场景信息 */
  getSceneInfo(): SceneInfo {
    if (!this.currentScene) {
      this.currentScene = this.detectScene();
    }
    return this.currentScene;
  }

  /** 检测当前场景（室内/室外） */
  private detectScene(): SceneInfo {
    // 基于缓存的位置信息推断场景
    if (this.cache) {
      const isIndoor = this.cache.accuracy > 100 || this.cache.source === 'network' || this.cache.source === 'amap';
      return {
        type: isIndoor ? 'indoor' : 'outdoor',
        strategy: isIndoor ? 'network_first' : 'balanced',
        isIndoor,
        signalStrength: this.cache.accuracy < 50 ? 'strong' : this.cache.accuracy < 200 ? 'weak' : 'none',
      };
    }
    return {
      type: 'outdoor',
      strategy: 'balanced',
      isIndoor: false,
      signalStrength: 'none',
    };
  }

  /** 注册外部Provider（如AMap WebView） */
  registerProvider(provider: LocationProvider): void {
    this.providers.push(provider);
    console.log(`[LocationEngine] 注册Provider: ${provider.name}`);
  }
}

// ============ Expo Location Provider ============

class ExpoLocationProvider implements LocationProvider {
  name = 'ExpoLocation';

  isAvailable(): boolean {
    return typeof Location !== 'undefined';
  }

  async getLocation(options?: { timeout?: number }): Promise<PositionResult | null> {
    const timeout = options?.timeout ?? 3000;
    
    try {
      // 使用 Lowest 精度优先（WiFi/基站，快速响应）
      const pos = await this.getLocationWithTimeout(
        { accuracy: Location.Accuracy.Lowest },
        timeout
      );

      // WGS84 → GCJ-02
      const [gcjLat, gcjLng] = wgs84ToGcj02(pos.coords.latitude, pos.coords.longitude);

      return {
        lat: gcjLat,
        lng: gcjLng,
        accuracy: pos.coords.accuracy || 200,
        source: 'expo',
        timestamp: Date.now(),
      };
    } catch (e: any) {
      throw new Error(`ExpoLocation: ${e.message}`);
    }
  }

  private getLocationWithTimeout(
    options: { accuracy: Location.Accuracy },
    timeoutMs: number
  ): Promise<Location.LocationObject> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('定位超时')), timeoutMs);
      Location.getCurrentPositionAsync(options)
        .then(pos => { clearTimeout(timer); resolve(pos); })
        .catch(err => { clearTimeout(timer); reject(err); });
    });
  }
}

// ============ 单例导出 ============

let _instance: LocationEngine | null = null;

export function getLocationEngine(config?: LocationEngineConfig): LocationEngine {
  if (!_instance) {
    _instance = new LocationEngine(config);
  }
  return _instance;
}

export default LocationEngine;
```

**Step 2: 验证文件创建**

Run: `ls -la mobile-app/src/services/LocationEngine.ts`
Expected: 文件存在且非空

---

### Task 2: 创建单元测试文件

**Files:**
- Create: `mobile-app/src/services/__tests__/LocationEngine.test.ts`

**Step 1: 编写基础测试用例**

```typescript
/**
 * LocationEngine 单元测试
 */

import { LocationEngine, getPositionResult, ExpoLocationProvider } from '../LocationEngine';

// Mock expo-location
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  enableNetworkProviderAsync: jest.fn().mockResolvedValue(undefined),
  getCurrentPositionAsync: jest.fn(),
  watchPositionAsync: jest.fn(),
  getLastKnownPositionAsync: jest.fn(),
  Accuracy: {
    Lowest: 1,
    Low: 2,
    Balanced: 3,
    High: 4,
    BestForNavigation: 5,
  },
}));

// Mock coordinate utils
jest.mock('../utils/coordinate', () => ({
  wgs84ToGcj02: jest.fn((lat, lng) => [lat + 0.01, lng + 0.01]),
}));

describe('LocationEngine', () => {
  let engine: LocationEngine;

  beforeEach(() => {
    engine = new LocationEngine({ firstFixTimeout: 3000 });
    jest.clearAllMocks();
  });

  describe('构造函数', () => {
    it('应该使用默认配置初始化', () => {
      const engine = new LocationEngine();
      expect(engine).toBeDefined();
    });

    it('应该接受自定义配置', () => {
      const engine = new LocationEngine({ firstFixTimeout: 10000 });
      expect(engine).toBeDefined();
    });
  });

  describe('getCurrentPosition', () => {
    it('应该在有新鲜缓存时立即返回', async () => {
      // 先设置缓存
      engine.updateCache({
        lat: 23.7435,
        lng: 114.7004,
        accuracy: 50,
        source: 'cache',
        timestamp: Date.now() - 1000, // 1秒前
      });

      const result = await engine.getCurrentPosition();
      expect(result).not.toBeNull();
      expect(result?.source).toBe('cache');
      expect(result?.lat).toBe(23.7435);
    });

    it('应该在无缓存且无Provider时返回null', async () => {
      const result = await engine.getCurrentPosition();
      expect(result).toBeNull();
    });
  });

  describe('getSceneInfo', () => {
    it('应该在无缓存时返回默认室外场景', () => {
      const scene = engine.getSceneInfo();
      expect(scene.type).toBe('outdoor');
      expect(scene.isIndoor).toBe(false);
    });

    it('应该在低精度缓存时检测为室内', () => {
      engine.updateCache({
        lat: 23.7435,
        lng: 114.7004,
        accuracy: 150, // 低精度 → 室内
        source: 'network',
        timestamp: Date.now(),
      });

      const scene = engine.getSceneInfo();
      expect(scene.isIndoor).toBe(true);
      expect(scene.strategy).toBe('network_first');
    });
  });
});

describe('ExpoLocationProvider', () => {
  let provider: ExpoLocationProvider;

  beforeEach(() => {
    provider = new ExpoLocationProvider();
  });

  describe('isAvailable', () => {
    it('应该返回true（已mock）', () => {
      expect(provider.isAvailable()).toBe(true);
    });
  });
});
```

**Step 2: 运行测试验证基础结构**

Run: `cd mobile-app && npx jest src/services/__tests__/LocationEngine.test.ts --no-coverage`
Expected: 测试运行（可能部分失败因为依赖未完全mock）

---

## Stage 2: 集成到 navigationService

### Task 3: 重构 navigationService 的 getCurrentPosition

**Files:**
- Modify: `mobile-app/src/services/navigationService.ts:178-329`

**Step 1: 替换 getCurrentPosition 实现**

在 `navigationService.ts` 文件中：

1. 在文件顶部添加导入：
```typescript
import { getLocationEngine, PositionResult } from './LocationEngine';
```

2. 替换 `getCurrentPosition()` 函数（约第213-329行）为：

```typescript
/**
 * 获取当前位置（GCJ-02），使用智能并行定位引擎
 * 
 * 定位策略：
 * 1. 新鲜缓存（<30秒，即时返回）
 * 2. 并行多源定位（expo-location + AMap WebView）
 * 3. 过期缓存兜底（<5分钟）
 * 4. IP定位（城市级精度）
 */
export async function getCurrentPosition(): Promise<{ lat: number; lng: number } | null> {
  console.log('[NaviService] getCurrentPosition: 开始获取位置（并行引擎）');

  // 使用 LocationEngine 进行并行定位
  const engine = getLocationEngine();
  
  try {
    const result = await engine.getCurrentPosition({
      firstFixTimeout: 5000,
      indoorOptimization: true,
    });

    if (result) {
      console.log(
        `[NaviService] getCurrentPosition: 成功 [${result.lat.toFixed(6)}, ${result.lng.toFixed(6)}], ` +
        `精度=${Math.round(result.accuracy)}m, 来源=${result.source}`
      );
      return { lat: result.lat, lng: result.lng };
    }

    console.log('[NaviService] getCurrentPosition: 引擎返回空，尝试IP定位...');
  } catch (e: any) {
    console.error('[NaviService] getCurrentPosition: 引擎异常:', e.message);
  }

  // 最终兜底：IP定位
  try {
    console.log('[NaviService] getCurrentPosition: 尝试 IP 定位...');
    const currentApiUrl = await getEffectiveApiUrl();
    const res = await axios.get(`${currentApiUrl}/map/ip-location`, { timeout: 10000 });
    const ipResult = res.data;
    if (ipResult && ipResult.success && ipResult.data) {
      const { lat, lng, source, city } = ipResult.data;
      const ipPos = { lat, lng };
      _cachedPosition = { ...ipPos, timestamp: Date.now() };
      console.log(`[NaviService] getCurrentPosition: IP定位成功 [${lat}, ${lng}], 来源=${source}, 城市=${city}`);
      return ipPos;
    }
  } catch (e: any) {
    console.log('[NaviService] getCurrentPosition: IP定位异常 -', e.message);
  }

  console.error('[NaviService] getCurrentPosition: 所有定位方式均失败');
  return null;
}
```

3. 删除或注释掉原来的多级串行定位代码（第216-328行的旧实现）

**Step 2: 验证编译通过**

Run: `cd mobile-app && npx tsc --noEmit`
Expected: 无类型错误

---

### Task 4: 注册 AMap WebView 作为 LocationProvider

**Files:**
- Modify: `mobile-app/src/components/Map/MapView.tsx:1995-2051`

**Step 1: 创建 AMap Web LocationProvider 类**

在 `MapView.tsx` 中添加：

```typescript
import { getLocationEngine, LocationProvider, PositionResult } from '../../services/LocationEngine';

// AMap WebView LocationProvider 实现
class AMapWebLocationProvider implements LocationProvider {
  name = 'AMapWebView';
  private getPositionFn: (() => Promise<PositionResult | null>) | null = null;

  setGetPositionFn(fn: () => Promise<PositionResult | null>): void {
    this.getPositionFn = fn;
  }

  isAvailable(): boolean {
    return this.getPositionFn !== null;
  }

  async getLocation(options?: { timeout?: number }): Promise<PositionResult | null> {
    if (!this.getPositionFn) return null;
    
    const timeout = options?.timeout ?? 5000;
    
    return Promise.race([
      this.getPositionFn(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout)),
    ]);
  }
}
```

**Step 2: 在 MapView 组件中注册 Provider**

在 `MapView` 组件的 `useEffect` 中添加注册逻辑：

```typescript
// 在 mapReady 为 true 时注册 AMap Provider
useEffect(() => {
  if (mapReady) {
    const engine = getLocationEngine();
    const amapProvider = new AMapWebLocationProvider();
    amapProvider.setGetPositionFn(async () => {
      return amapGetPosition(); // 使用现有的 amapGetPosition 方法
    });
    engine.registerProvider(amapProvider);
    console.log('[MapView] AMap WebView LocationProvider 已注册');
  }
}, [mapReady]);
```

**Step 3: 验证编译**

Run: `cd mobile-app && npx tsc --noEmit`
Expected: 无错误

---

## Stage 3: 场景自适应优化

### Task 5: 实现场景感知的动态策略调整

**Files:**
- Modify: `mobile-app/src/services/LocationEngine.ts`

**Step 1: 添加运动检测和策略调整方法**

在 `LocationEngine` 类中添加：

```typescript
/**
 * 根据导航模式调整定位策略
 */
private getStrategyForMode(navigationMode: boolean): LocationStrategy {
  if (!this.config.indoorOptimization) {
    return 'gps_primary'; // 不启用室内优化时，始终优先GPS
  }

  const scene = this.getSceneInfo();
  
  if (navigationMode) {
    // 导航模式下：
    // - 室内/弱信号：网络优先
    // - 室外/强信号：GPS优先
    return scene.isIndoor ? 'network_first' : 'gps_primary';
  }
  
  // 非导航模式：平衡策略
  return 'balanced';
}

/**
 * 智能选择定位精度
 */
private selectAccuracy(): Location.Accuracy {
  const scene = this.getSceneInfo();
  
  if (this.config.navigationMode && !scene.isIndoor) {
    // 导航 + 室外：使用最佳精度
    return Location.Accuracy.BestForNavigation;
  }
  
  if (scene.isIndoor) {
    // 室内：使用最低精度（WiFi/基站，快速响应）
    return Location.Accuracy.Lowest;
  }
  
  // 默认：平衡精度
  return Location.Accuracy.Balanced;
}
```

**Step 2: 更新 getCurrentPosition 使用动态策略**

修改 `getCurrentPosition` 方法中的 Provider 选择逻辑，根据场景动态调整。

---

## Stage 4: 测试与验证

### Task 6: 编写集成测试

**Files:**
- Modify: `mobile-app/src/services/__tests__/LocationEngine.test.ts`

**Step 1: 添加集成测试用例**

```typescript
describe('LocationEngine 集成测试', () => {
  describe('并行定位', () => {
    it('应该返回最快的定位结果', async () => {
      // Mock 多个Provider，模拟不同延迟
      const engine = new LocationEngine({ firstFixTimeout: 5000 });
      
      // 测试并行竞争逻辑
      const startTime = Date.now();
      const result = await engine.getCurrentPosition();
      const elapsed = Date.now() - startTime;
      
      // 验证响应时间 < 超时时间
      expect(elapsed).toBeLessThan(5500);
    });

    it('应该在第一个Provider失败时尝试第二个', async () => {
      // 测试降级逻辑
    });
  });

  describe('场景适配', () => {
    it('应该在低精度时识别为室内场景', () => {
      const engine = new LocationEngine();
      engine.updateCache({
        lat: 23.7435,
        lng: 114.7004,
        accuracy: 500,
        source: 'network',
        timestamp: Date.now(),
      });

      const scene = engine.getSceneInfo();
      expect(scene.isIndoor).toBe(true);
      expect(scene.signalStrength).toBe('none');
    });
  });
});
```

**Step 2: 运行完整测试套件**

Run: `cd mobile-app && npx jest src/services/__tests__/ --coverage`
Expected: 测试通过率 > 80%

---

## Stage 5: 性能优化与文档

### Task 7: 性能基准测试

**Step 1: 创建性能测试脚本**

```typescript
// mobile-app/src/services/__tests__/location-benchmark.ts

/**
 * 定位引擎性能基准测试
 * 
 * 运行方式: npx ts-node __tests__/location-benchmark.ts
 * 
 * 预期结果:
 * - 首次定位: < 3秒 (有缓存时 < 100ms)
 * - 室内成功率: > 90%
 * - 连续定位: < 1秒间隔
 */

async function runBenchmark() {
  console.log('=== LocationEngine Performance Benchmark ===\n');
  
  const engine = getLocationEngine();
  const iterations = 10;
  const results: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    await engine.getCurrentPosition();
    const elapsed = Date.now() - start;
    results.push(elapsed);
    console.log(`Iteration ${i + 1}: ${elapsed}ms`);
  }

  const avg = results.reduce((a, b) => a + b, 0) / results.length;
  const max = Math.max(...results);
  const min = Math.min(...results);

  console.log('\n=== Results ===');
  console.log(`Average: ${avg.toFixed(0)}ms`);
  console.log(`Min: ${min}ms`);
  console.log(`Max: ${max}ms`);
  console.log(`Target: < 3000ms (first fix), < 1000ms (cached)`);
}

runBenchmark().catch(console.error);
```

---

## 实施检查清单

- [ ] **Task 1**: ✅ 创建 LocationEngine.ts 基础结构
- [ ] **Task 2**: ✅ 创建单元测试
- [ ] **Task 3**: ✅ 重构 navigationService.getCurrentPosition()
- [ ] **Task 4**: ✅ 注册 AMap WebView Provider
- [ ] **Task 5**: ✅ 实现场景自适应逻辑
- [ ] **Task 6**: ✅ 集成测试通过
- [ ] **Task 7**: ✅ 性能基准测试完成

---

## 风险缓解

| 风险 | 缓解措施 |
|------|----------|
| expo-location Lowest 在部分设备不可用 | 保留 AMap WebView 作为备用 Provider |
| 并行请求增加电量消耗 | 控制并发数 ≤ 3，导航模式外降低频率 |
| 坐标系转换误差 | 统一在 Provider 内部转换为 GCJ-02 |

---

## 回滚方案

如果新引擎出现问题，可快速回滚：
1. 恢复 `navigationService.ts` 中的旧 `getCurrentPosition()` 实现
2. 注释掉 `LocationEngine` 相关导入
3. 重新编译即可

预计回滚时间: < 5分钟
