# API 和服务层

## API 服务 (src/services/api.ts)

### 概述

基于 axios 封装的后端 API 调用服务，支持运行时动态切换后端地址。提供扇区数据、图层数据、搜索等接口。

### ApiService 类

#### 地址管理

| 方法 | 签名 | 说明 |
|------|------|------|
| `updateApiUrl` | `(url: string) => void` | 更新 API 地址，自动去除尾部 `/api/v1` |
| `resetApiUrl` | `() => void` | 重置 API 地址到自动发现模式 |
| `getCurrentBaseUrl` | `() => string` | 获取当前 baseURL（不含 `/api/v1`） |
| `getFullApiUrl` | `() => string` | 获取完整 API 地址（baseUrl + `/api/v1`） |
| `testConnection` | `(url: string) => Promise<boolean>` | 测试后端连接性 |

#### 核心数据 API

| 方法 | 签名 | 说明 |
|------|------|------|
| `getSystemInfo` | `() => Promise<SystemInfo>` | 获取系统信息 |
| `getSectors` | `(timeoutMs?: number) => Promise<SectorResponse>` | 获取扇区数据（GET `/map/sectors`），默认超时 120 秒 |
| `getLayers` | `(dataId: number) => Promise<LayerListResponse>` | 获取图层列表 |
| `getLayerData` | `(dataId: number, layerId: number) => Promise<LayerDataResponse>` | 获取图层数据 |
| `getMobileRenderData` | `(dataId: number) => Promise<RenderDataResponse>` | 获取移动端渲染数据（GCJ02 已转换） |
| `getDataList` | `() => Promise<DataListResponse>` | 获取数据列表 |
| `downloadRawJson` | `(path: string) => Promise<any>` | 下载原始 JSON |

#### 搜索 API

| 方法 | 签名 | 说明 |
|------|------|------|
| `searchParameter` | `(keyword: string) => Promise<SectorData[]>` | 扇区参数搜索（本地过滤，按名称/PCI/频点等） |
| `searchPlace` | `(keyword: string) => Promise<PlaceResult[]>` | 高德 POI 搜索 |

### 请求拦截器

```typescript
// 每次请求前自动获取最新 API 地址
axiosInstance.interceptors.request.use((config) => {
  const effectiveUrl = getEffectiveApiUrl();
  config.baseURL = effectiveUrl;
  return config;
});
```

### 导出

```typescript
export const apiService = new ApiService();
```

单例导出，业务模块直接导入使用。

### 依赖关系

- `config.ts`: `getEffectiveApiUrl`, `getEffectiveApiBaseUrl`, `setCustomApiUrl`, `resetCustomApiUrl`, `testApiConnection`
- `axios`: HTTP 客户端
- 被 `cacheService.ts` 调用

---

## 缓存服务 (src/services/cacheService.ts)

### 概述

管理本地文件缓存系统：首次启动自动从后端下载全量数据缓存、后续启动优先读本地缓存、支持手动刷新和本地文件导入。

### CacheService 类

#### 初始化

| 方法 | 签名 | 说明 |
|------|------|------|
| `init` | `() => Promise<void>` | 创建缓存目录 |
| `isFirstLaunch` | `() => Promise<boolean>` | 检测是否首次启动 |
| `markFirstLaunchDone` | `() => Promise<void>` | 标记首次启动完成 |

#### 元数据管理

| 方法 | 签名 | 说明 |
|------|------|------|
| `getMeta` | `() => Promise<CacheMeta>` | 从 AsyncStorage 读取缓存元数据 |
| `updateMeta` | `(meta: Partial<CacheMeta>) => Promise<void>` | 更新缓存元数据 |

#### 后端下载缓存

| 方法 | 签名 | 说明 |
|------|------|------|
| `cacheAllFromBackend` | `(onProgress?: (p: number) => void) => Promise<void>` | 首次启动一键缓存全量数据 |
| `cacheFullParamsFromBackend` | `() => Promise<void>` | 缓存全量工参（扇区） |
| `cacheGeoDataFromBackend` | `() => Promise<void>` | 缓存地理化数据 |
| `cacheLayersFromBackend` | `() => Promise<void>` | 缓存图层文件 |
| `refreshAllFromBackend` | `(onProgress?: (p: number) => void) => Promise<void>` | 手动刷新全部缓存 |

#### 本地读取

| 方法 | 签名 | 说明 |
|------|------|------|
| `getCachedSectors` | `() => Promise<{lte: SectorData[], nr: SectorData[]} \| null>` | 读取缓存的扇区数据 |
| `getCachedGeoDataList` | `() => Promise<GeoDataItem[]>` | 读取缓存的地理化数据列表 |
| `getCachedLayerList` | `() => Promise<LayerItem[]>` | 读取缓存的图层数据列表 |

#### 文件导入

| 方法 | 签名 | 说明 |
|------|------|------|
| `importFile` | `(fileUri: string, fileName: string, onProgress?: (p: ImportProgress) => void) => Promise<ImportResult>` | 导入本地文件（支持 SAF/临时文件拷贝/直接读取三种策略） |

#### 文件删除

| 方法 | 签名 | 说明 |
|------|------|------|
| `deleteCachedData` | `(type: DataFileType) => Promise<void>` | 删除指定类型的缓存数据 |

#### 文件导出

| 方法 | 签名 | 说明 |
|------|------|------|
| `exportCachedData` | `(type: DataFileType) => Promise<string>` | 导出缓存数据为文件，返回文件路径 |

### 缓存目录结构

```typescript
const CACHE_ROOT = `${FileSystem.documentDirectory}cache/`;
const CACHE_DIRS = {
  fullParams: `${CACHE_ROOT}fullParams/`,    // 全量工参
  geoData:    `${CACHE_ROOT}geoData/`,       // 地理化数据
  layers:     `${CACHE_ROOT}layers/`,        // 图层文件
  meta:       `${CACHE_ROOT}meta/`,          // 元数据 (实际用 AsyncStorage)
};
```

### 文件读取策略

```typescript
// importFile() 中的三级回退策略
async readFile(fileUri: string): Promise<string> {
  // 1. SAF (Storage Access Framework) - Android 5.0+
  if (Platform.OS === 'android') {
    try {
      const content = await FileSystem.readAsStringAsync(fileUri);
      return content;
    } catch {}
  }
  
  // 2. 拷贝到临时目录再读取
  try {
    const tempPath = `${FileSystem.cacheDirectory}${Date.now()}_${fileName}`;
    await FileSystem.copyAsync({ from: fileUri, to: tempPath });
    const content = await FileSystem.readAsStringAsync(tempPath);
    await FileSystem.deleteAsync(tempPath);
    return content;
  } catch {}
  
  // 3. 直接读取
  return FileSystem.readAsStringAsync(fileUri);
}
```

### 依赖关系

- `apiService`: 调用 `getSectors`, `getDataList`, `getMobileRenderData`, `getLayers`, `getLayerData`
- `dataParser.ts`: `parseImportedFile`, `parseFullParamsExcel` 等
- `streamingParser.ts`: `parseFileStreaming`, `isLargeFile`
- `asyncParser.ts`: `parseFileAsync`
- `coordinate.ts`: `wgs84ToGcj02`
- `expo-file-system`, `@react-native-async-storage/async-storage`, `xlsx`, `jszip`

---

## 导航服务 (src/services/navigationService.ts)

### 概述

完整的导航引擎：GPS 定位（多策略降级）、路径规划（高德 API）、实时位置跟踪、TTS 语音播报、偏航检测与重新规划、后台定位保活。

### 导出的类型

```typescript
type NaviMode = 'drive' | 'walk' | 'bicycling';

type GpsSignalQuality = 'excellent' | 'good' | 'weak' | 'none';

interface GpsSignalInfo {
  quality: GpsSignalQuality;
  accuracy?: number;         // 米
  satellites?: number;
  hasFix: boolean;
}

interface RouteStep {
  instruction: string;       // 导航指令
  distance: number;          // 距离（米）
  duration: number;          // 时长（秒）
  path: [number, number][];  // 坐标路径
}

interface RouteData {
  steps: RouteStep[];
  totalDistance: number;
  totalDuration: number;
  path: [number, number][];
}

interface NaviStateSnapshot {
  isNavigating: boolean;
  currentPosition: { lat: number; lng: number } | null;
  remainingDistance: number;
  remainingDuration: number;
  currentStep: RouteStep | null;
  speed: number;             // m/s
  mode: NaviMode;
}
```

### 导出的函数

| 函数 | 签名 | 说明 |
|------|------|------|
| `onNaviStateChange` | `(cb: (snapshot: NaviStateSnapshot) => void) => () => void` | 订阅导航状态变化，返回取消订阅函数 |
| `onArrival` | `(cb: () => void) => () => void` | 订阅到达事件 |
| `resetNavUiAutoHide` | `() => void` | 重置 UI 自动隐藏计时器 |
| `requestLocationPermission` | `() => Promise<boolean>` | 请求定位权限 |
| `requestNaviPermissions` | `() => Promise<boolean>` | 请求导航所需权限（含后台定位） |
| `getCurrentPosition` | `() => Promise<{lat: number, lng: number} \| null>` | 多策略定位（缓存→权限→网络→最后已知→GPS→IP） |
| `planRoute` | `(start: {lat, lng}, end: {lat, lng}, mode: NaviMode) => Promise<RouteData \| null>` | 路径规划（高德 API） |
| `startNavigation` | `(route: RouteData, mode: NaviMode) => void` | 开始导航 |
| `stopNavigation` | `() => void` | 停止导航 |
| `isNavigating` | `() => boolean` | 是否正在导航 |

### 内部核心机制

#### 后台定位任务

```typescript
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) return;
  const { locations } = data;
  const location = locations[0];
  
  // WGS84 → GCJ02 转换
  const [gcjLat, gcjLng] = wgs84ToGcj02(
    location.coords.latitude,
    location.coords.longitude
  );
  
  // 更新位置缓存
  positionCache.set({ lat: gcjLat, lng: gcjLng, timestamp: Date.now() });
  
  // 评估 GPS 信号质量
  updateGpsSignalState(location);
  
  // 偏航检测
  if (isNavigating()) {
    checkDeviation({ lat: gcjLat, lng: gcjLng });
  }
  
  // 通知状态变化
  notifyStateChange();
});
```

#### GPS 信号质量评估

```typescript
function updateGpsSignalState(location: Location) {
  const accuracy = location.coords.accuracy;
  const satellites = location.coords.satellitesUsed;
  
  let quality: GpsSignalQuality;
  if (!accuracy || accuracy > 50) quality = 'none';
  else if (accuracy > 20) quality = 'weak';
  else if (accuracy > 10) quality = 'good';
  else quality = 'excellent';
  
  const signalInfo: GpsSignalInfo = {
    quality,
    accuracy,
    satellites,
    hasFix: accuracy !== undefined && accuracy < 100,
  };
  
  // 更新 store
  useMapStore.getState().setGpsSignal(signalInfo);
}
```

#### 偏航检测

```typescript
const DEVIATE_THRESHOLD_METERS = 100; // 100 米

function checkDeviation(currentPos: {lat: number, lng: number}) {
  if (!currentRoute) return;
  
  // 计算当前位置到路线的垂直距离
  const distance = distanceToRoute(currentPos, currentRoute.path);
  
  if (distance > DEVIATE_THRESHOLD_METERS) {
    // 偏航，重新规划路线
    TTS.speak('您已偏离路线，正在重新规划');
    planRoute(currentPos, destination, mode).then(newRoute => {
      if (newRoute) {
        currentRoute = newRoute;
        notifyStateChange();
      }
    });
  }
}
```

#### 多策略定位

```typescript
async function getCurrentPosition() {
  // 1. 位置缓存（5 分钟 TTL）
  const cached = positionCache.get();
  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
    return { lat: cached.lat, lng: cached.lng };
  }
  
  // 2. 检查权限
  const { status } = await Location.getForegroundPermissionsAsync();
  if (status !== 'granted') return null;
  
  // 3. 网络定位（快速但精度低）
  try {
    const loc = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return { lat: loc.coords.latitude, lng: loc.coords.longitude };
  } catch {}
  
  // 4. 最后已知位置
  const lastKnown = await Location.getLastKnownPositionAsync();
  if (lastKnown) {
    return { lat: lastKnown.coords.latitude, lng: lastKnown.coords.longitude };
  }
  
  // 5. GPS 定位（高精度但慢）
  try {
    const loc = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });
    return { lat: loc.coords.latitude, lng: loc.coords.longitude };
  } catch {}
  
  // 6. IP 定位（回退）
  return null;
}
```

#### TTS 语音播报

```typescript
function speakInstruction(instruction: string) {
  if (!ttsAvailable) return;
  
  Speech.speak(instruction, {
    language: 'zh-CN',
    rate: 1.0,
    pitch: 1.0,
  });
}
```

### 依赖关系

- `expo-location`: 定位核心
- `expo-speech`: TTS 播报
- `expo-keep-awake`: 屏幕常亮
- `expo-task-manager`: 后台定位任务
- `coordinate.ts`: `wgs84ToGcj02`
- `config.ts`: `getEffectiveApiUrl`（路径规划代理）
- `useMapStore`: 更新 `gpsSignal`, `navUiHidden`
- 被 `NavigationPanel` 和 `MapView` 使用

---

## 数据解析器 (src/services/dataParser.ts)

### 概述

解析多种格式的本地文件（Excel/CSV/GeoJSON/MIF），转换为 GeoJSON Feature 格式。

### 核心函数

| 函数 | 签名 | 说明 |
|------|------|------|
| `parseImportedFile` | `(arrayBuffer: ArrayBuffer, fileName: string) => ImportResult` | 自动检测文件类型并解析 |
| `parseFullParamsExcel` | `(arrayBuffer: ArrayBuffer) => {lte: SectorData[], nr: SectorData[]}` | 解析 LTE/NR 工参 Excel |
| `parseFullParamsSheet` | `(sheet: any, networkType: 'LTE' \| 'NR') => SectorData[]` | 解析单个工作表 |
| `parseRowsToFlatSectors` | `(rows: any[][], headers: string[], fields: FieldMapping, networkType: 'LTE' \| 'NR') => SectorData[]` | 扁平化扇区数据 |
| `parseGeoDataExcel` | `(arrayBuffer: ArrayBuffer) => GeoJsonFeatureCollection` | 解析点/面数据 |
| `parsePointData` | `(rows: any[][], headers: string[], fields: FieldMapping) => GeoJsonFeature[]` | 点数据解析 + WGS84→GCJ02 转换 |
| `parsePolygonData` | `(rows: any[][], headers: string[], fields: FieldMapping) => GeoJsonFeature[]` | 面数据解析 |
| `detectFields` | `(headers: string[]) => FieldMapping` | 自动识别经纬度/方位角/名称等字段 |
| `findColumn` | `(headers: string[], keywords: string[]) => number` | 模糊匹配列名 |

### 字段检测逻辑

```typescript
interface FieldMapping {
  lonIndex: number;        // 经度列索引
  latIndex: number;        // 纬度列索引
  azimuthIndex?: number;   // 方位角列索引
  beamwidthIndex?: number; // 波束宽度列索引
  heightIndex?: number;    // 天线挂高列索引
  nameIndex?: number;      // 名称列索引
  pciIndex?: number;       // PCI 列索引
  earfcnIndex?: number;    // 频点列索引
}

function detectFields(headers: string[]): FieldMapping {
  const lonIndex = findColumn(headers, ['经度', 'longitude', 'lng', 'lon', 'x']);
  const latIndex = findColumn(headers, ['纬度', 'latitude', 'lat', 'y']);
  const azimuthIndex = findColumn(headers, ['方位角', 'azimuth', 'az']);
  const beamwidthIndex = findColumn(headers, ['波束宽度', 'beamwidth', 'bw']);
  const heightIndex = findColumn(headers, ['挂高', 'height', '天线高度']);
  const nameIndex = findColumn(headers, ['名称', 'name', '站点名', '小区名']);
  const pciIndex = findColumn(headers, ['pci', '物理小区id']);
  const earfcnIndex = findColumn(headers, ['频点', 'earfcn', 'ssb']);
  
  return { lonIndex, latIndex, azimuthIndex, beamwidthIndex, heightIndex, nameIndex, pciIndex, earfcnIndex };
}

function findColumn(headers: string[], keywords: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i].toLowerCase().trim();
    for (const keyword of keywords) {
      if (header.includes(keyword.toLowerCase())) {
        return i;
      }
    }
  }
  return -1;
}
```

### 坐标转换时机

```typescript
// 在生成 GeoJsonFeature 前立即转换
function rowToFeature(row: any[], headers: string[], fields: FieldMapping, index: number): GeoJsonFeature {
  const lon = parseFloat(row[fields.lonIndex]);
  const lat = parseFloat(row[fields.latIndex]);
  
  // WGS84 → GCJ02
  const [gcjLat, gcjLng] = wgs84ToGcj02(lat, lon);
  
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [gcjLng, gcjLat],
    },
    properties: {
      id: index,
      name: fields.nameIndex >= 0 ? row[fields.nameIndex] : `Point ${index}`,
      // ... 其他属性
    },
  };
}
```

---

## 流式解析器 (src/services/streamingParser.ts)

### 概述

处理大文件（>5MB 或 >5000 行），分块读取避免内存溢出。

### 核心函数

| 函数 | 签名 | 说明 |
|------|------|------|
| `parseFileStreaming` | `(arrayBuffer: ArrayBuffer, fileName: string, options: StreamParseOptions) => Promise<ParseResult>` | 流式解析入口 |
| `parseExcelStreaming` | `(arrayBuffer: ArrayBuffer, options: StreamParseOptions) => Promise<ParseResult>` | Excel 流式解析 |
| `parseCsvStreaming` | `(csvContent: string, options: StreamParseOptions) => Promise<ParseResult>` | CSV 流式解析 |
| `isLargeFile` | `(fileSize: number, rowEstimate?: number) => boolean` | 判断是否大文件 |
| `yieldToUI` | `() => Promise<void>` | 让出主线程 |

### 配置参数

```typescript
const BATCH_SIZE = 2000;        // 每批读取行数
const YIELD_INTERVAL = 100;     // 每处理 100 行让出一次
```

### Excel 流式解析流程

```typescript
async function parseExcelStreaming(arrayBuffer: ArrayBuffer, options: StreamParseOptions) {
  // 1. 读取工作簿元数据 (不读内容)
  const workbook = XLSX.read(arrayBuffer, { type: 'array', sheetRows: 0 });
  
  // 2. 读取表头 (前 5 行)
  const headerData = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 0 });
  
  // 3. 检测表头行 (找包含经纬度字段的行)
  let headerRowIndex = -1;
  for (let i = 0; i < 5; i++) {
    const headers = headerData[i];
    const fields = detectFields(headers);
    if (fields.lonIndex >= 0 && fields.latIndex >= 0) {
      headerRowIndex = i;
      break;
    }
  }
  
  // 4. 获取数据范围
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const dataRowCount = range.e.r - headerRowIndex;
  const totalBatches = Math.ceil(dataRowCount / BATCH_SIZE);
  
  // 5. 分块读取和处理
  const allFeatures: GeoJsonFeature[] = [];
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const startRow = headerRowIndex + 1 + batchIndex * BATCH_SIZE;
    const endRow = Math.min(startRow + BATCH_SIZE, range.e.r);
    
    // 5.1 读取当前块
    const batchData = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      range: { s: { r: startRow, c: 0 }, e: { r: endRow, c: maxCol } },
    });
    
    // 5.2 转换为 GeoJSON Features
    const batchFeatures: GeoJsonFeature[] = [];
    for (let i = 0; i < batchData.length; i++) {
      const row = batchData[i];
      const feature = rowToFeature(row, headers, fields, startRow + i);
      batchFeatures.push(feature);
      
      // 5.3 定期让出主线程
      if (i % YIELD_INTERVAL === 0) await yieldToUI();
    }
    
    allFeatures.push(...batchFeatures);
    
    // 5.4 回调通知进度
    const processedRows = (batchIndex + 1) * BATCH_SIZE;
    options.onProgress?.({
      fileName: options.fileName,
      progress: Math.min(100, Math.round(processedRows / dataRowCount * 100)),
      status: 'processing',
      message: `已处理 ${processedRows}/${dataRowCount} 行`,
    });
    
    await options.onBatch?.(batchFeatures, batchIndex);
    
    // 5.5 每批处理后让出主线程
    await yieldToUI();
  }
  
  return { features: allFeatures, totalCount: allFeatures.length, geometryType: 'point', headers };
}
```

### CSV 流式解析

```typescript
async function parseCsvStreaming(csvContent: string, options: StreamParseOptions) {
  return new Promise<ParseResult>((resolve, reject) => {
    const allFeatures: GeoJsonFeature[] = [];
    let headers: string[] = [];
    let fields: FieldMapping;
    let totalRows = 0;
    let currentBatch: GeoJsonFeature[] = [];
    let batchIndex = 0;
    
    Papa.parse(csvContent, {
      header: true,
      chunkSize: 1024 * 64,  // 64KB chunks
      chunk: async (results, parser) => {
        if (headers.length === 0) {
          headers = results.meta.fields || [];
          fields = detectFields(headers);
        }
        
        const rows = results.data;
        for (const row of rows) {
          const feature = rowToFeature(row, headers, fields, totalRows);
          currentBatch.push(feature);
          totalRows++;
          
          if (currentBatch.length >= options.batchSize || 1000) {
            allFeatures.push(...currentBatch);
            await options.onBatch?.(currentBatch, batchIndex);
            currentBatch = [];
            batchIndex++;
            await yieldToUI();
          }
        }
        
        options.onProgress?.({
          fileName: options.fileName,
          progress: 0,  // CSV 无法预知总行数
          status: 'processing',
          message: `已处理 ${totalRows} 行`,
        });
      },
      complete: () => {
        if (currentBatch.length > 0) {
          allFeatures.push(...currentBatch);
        }
        resolve({ features: allFeatures, totalCount: totalRows, geometryType: 'point', headers });
      },
      error: (error) => reject(error),
    });
  });
}
```

---

## 异步解析器 (src/services/asyncParser.ts)

### 概述

处理中等文件（1MB-5MB），使用 InteractionManager + 分片处理。

### 核心函数

| 函数 | 签名 | 说明 |
|------|------|------|
| `parseFileAsync` | `(arrayBuffer: ArrayBuffer, fileName: string, options: AsyncParseOptions) => Promise<ParseResult>` | 异步解析入口 |
| `parseExcelAsync` | `(arrayBuffer: ArrayBuffer, options: AsyncParseOptions) => Promise<ParseResult>` | Excel 异步解析 |
| `processInChunks` | `<T, R>(items: T[], processor: (item: T, index: number) => R \| null, options: AsyncParseOptions) => Promise<R[]>` | 分片处理数组 |
| `yieldToMainThread` | `() => Promise<void>` | 使用 setImmediate 让出主线程 |

### 配置参数

```typescript
const chunkSize = 100;        // 每 100 行报告进度
const yieldInterval = 50;     // 每 50 行让出一次
```

### 分片处理机制

```typescript
export async function processInChunks<T, R>(
  items: T[],
  processor: (item: T, index: number) => R | null,
  options: AsyncParseOptions = {}
): Promise<R[]> {
  const { chunkSize = 100, yieldInterval = 50, onProgress } = options;
  const results: R[] = [];
  
  // 等待交互空闲
  await waitForInteraction();
  
  for (let i = 0; i < items.length; i++) {
    const result = processor(items[i], i);
    if (result !== null) results.push(result);
    
    // 定期让出主线程
    if (i % yieldInterval === 0 && i > 0) {
      await yieldToMainThread();
    }
    
    // 进度回调
    if (i % chunkSize === 0) {
      const percentage = Math.round(i / items.length * 100);
      onProgress?.({ processed: i, total: items.length, percentage });
    }
  }
  
  return results;
}

const waitForInteraction = () => new Promise<void>(resolve => {
  InteractionManager.runAfterInteractions(() => resolve());
});

const yieldToMainThread = () => new Promise<void>(resolve => {
  setImmediate(resolve);
});
```

---

## 配置管理 (src/utils/config.ts)

### 概述

管理后端 API 地址解析、高德地图配置、连接测试。

### 导出的常量/函数

| 导出 | 类型 | 说明 |
|------|------|------|
| `AMAP_CONFIG` | `{ androidKey: string; webJsKey: string }` | 高德地图 Key 配置 |
| `API_PREFIX` | `string` | API 路径前缀 `/api/v1` |
| `getEffectiveApiBaseUrl` | `() => Promise<string>` | 按优先级解析后端地址 |
| `getEffectiveApiUrl` | `() => Promise<string>` | 返回完整 API 地址（baseUrl + /api/v1） |
| `setCustomApiUrl` | `(url: string) => Promise<void>` | 保存用户自定义地址 |
| `resetCustomApiUrl` | `() => Promise<void>` | 清除自定义地址 |
| `getCustomApiUrl` | `() => Promise<string \| null>` | 读取已保存的自定义地址 |
| `testApiConnection` | `(url: string) => Promise<boolean>` | 测试后端连接 |
| `BACKEND_CONFIG` | `{ defaultUrl: string; backupUrl: string }` | 静态回退值 |

### API 地址解析优先级

```typescript
async function getEffectiveApiBaseUrl(): Promise<string> {
  // 1. 用户自定义地址（AsyncStorage）
  const customUrl = await getCustomApiUrl();
  if (customUrl) return customUrl;
  
  // 2. 环境变量
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL;
  }
  
  // 3. LAN IP（从 Expo hostUri 推导）
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const lanIp = hostUri.split(':')[0];
    return `http://${lanIp}:8000`;
  }
  
  // 4. 回退
  return 'http://localhost:8000';
}
```

### 连接测试

```typescript
async function testApiConnection(url: string): Promise<boolean> {
  try {
    const fullUrl = url.endsWith('/api/v1') ? url : `${url}/api/v1`;
    const response = await fetch(`${fullUrl}/system/info`, {
      method: 'GET',
      timeout: 5000,
    });
    return response.ok;
  } catch (error) {
    return false;
  }
}
```

---

## 服务层依赖关系图

```
┌─────────────────────────────────────────────────────────────┐
│                      页面组件层                               │
│  index.tsx / data.tsx / favorites.tsx / settings.tsx         │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┬────────────┐
        ▼                         ▼            ▼
┌──────────────┐  ┌──────────────────┐  ┌──────────────┐
│  MapView.tsx │  │ NavigationPanel  │  │  其他组件    │
└──────┬───────┘  └────────┬─────────┘  └──────┬───────┘
       │                   │                    │
       │                   ▼                    │
       │          ┌──────────────────┐          │
       │          │ navigationService│          │
       │          │   (导航服务)     │          │
       │          └────────┬─────────┘          │
       │                   │                    │
       ▼                   ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                      useMapStore (Zustand)                   │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
┌──────────────────┐    ┌──────────────────┐
│  cacheService    │    │  apiService      │
│   (缓存服务)     │───▶│   (API 服务)     │
└────────┬─────────┘    └────────┬─────────┘
         │                       │
         ▼                       ▼
┌─────────────────────────────────────────────────────────────┐
│                      数据解析层                               │
│  dataParser / streamingParser / asyncParser                  │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                      工具层 (utils/)                         │
│  - config.ts (API 地址解析)                                  │
│  - coordinate.ts (WGS84↔GCJ02 转换)                         │
│  - clusterManager.ts (Supercluster 聚类)                    │
│  - viewportFilter.ts (RBush 视窗过滤)                       │
└─────────────────────────────────────────────────────────────┘
```
