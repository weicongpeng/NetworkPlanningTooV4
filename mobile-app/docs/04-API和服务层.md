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

## 协作沟通（IM）服务层

移动端复用网页端 `/api/v1/im/*`，后端零改动；`apiService.request()` 统一动态 baseURL + Bearer + `X-Client: app`。

| 文件 | 职责 |
|---|---|
| `src/services/imApi.ts` | 会话/消息/通讯录/成员/撤回/转发/附件的 REST 封装；短时签名图片直链按 `id:thumb` 缓存，过期前 30s 不复用 |
| `src/services/imAttachment.ts` | 拍照/相册/文件选择、2MB base64 分片上传、Bearer 回退下载、`expo-sharing` 打开 |
| `src/services/imWebSocket.ts` | `wss(s)://<当前 API 地址>/api/v1/ws/tasks?token=<JWT>`，25s 心跳、2 次重连后降级轮询 |
| `src/store/imStore.ts` | 会话/消息分桶、`after_id` 游标、未读、在线、@草稿、轮询与切账号清理 |

关键口径：SQLite 是消息真源，WS 只推 `im_message` / `im_recall` / `im_presence` 的 id；正文由 REST 增量拉取并按 id 去重，游标只由 `next_cursor` 推进，发送成功不推进游标；切后台停轮询、回前台 resync。

补充说明：

- **头像/昵称**：`PUT /im/avatar`（`< 256KB` 的 png/jpeg/webp/gif data URL）、`PUT /im/nickname`（≤24 字），与网页端写同一 `users` 表；保存后 `loadContacts()` 刷新手机通讯录，电脑端在通讯录校准或刷新页面后显示。
- **发送性能**：分片读取+上传并发 3（后端 `write_chunk` 带锁按 offset 写入，顺序无关）；发送前插入乐观本地图片消息，发送响应用 `client_msg_id` 直接替换，省掉一次增量拉取；一页消息批量预热签名链接，避免每张缩略图各发一次请求。
- **进入会话**：通讯录点人优先命中本地 `direct` 会话零请求直达；新建会话只打一次 `POST /conversations`，列表刷新放后台。
- **原生模块容错**：`expo-image-picker` 未编译进安装包时，拍照给出明确提示、相册降级到 `expo-document-picker`；重新出包后能力自动恢复。

- **会话失效**：带 token 请求返回 401 时由 `src/services/sessionGuard.ts` 统一清理，不再把 `长时间未操作，请重新登录` 当普通 IM 错误红字显示；`useHeartbeat()` 挂在 `App.tsx` 根组件保证 5 分钟 ping 不漏跑。

- **网址与视频**：文本 URL 由 `src/utils/linkify.ts` 切分后用 `Linking.openURL` 打开；`video/*` 附件走 `MediaLightbox` 的 WebView `<video>`，打开前强制刷新签名直链（TTL 15 分钟，避免播放中途 Range 请求 403），签名不可用时降级系统播放器。

- **媒体打开与交互**：图片点击先用会话页已预热的 `thumb=true` 签名瞬时显示、后台再换全图；视频直接复用缓存签名，WebView 显示加载圈。灯箱底部为编辑/下载/转发/查看；「查看」网格直接读签名缓存，点击缩略图切换媒体；图片标注用 WebView Canvas 画圈+文字后导出 dataURL 存本地，通过系统分享面板交付。

- **打开会话定位**：进入会话用 `onContentSizeChange` 的真实内容高度 + `onLayout` 的视口高度算 `scrollToOffset`，并在下一帧补定位，覆盖已加载会话重新打开的场景；加载更早消息保持视口，新消息仅在用户已处于底部时跟随。
- **图片打开与翻页**：消息气泡加载缩略图时即下载到本地缓存，灯箱打开只读本地文件（无网络等待）且去掉淡入动画；未放大时左右滑动超过 60px 切换上/下一张媒体。

- **历史消息本地缓存**：`src/services/imMessageCache.ts` 按 username 分桶，把每会话最近 300 条消息写入 `documentDirectory/im_chat_cache/`；进入会话先渲染缓存再按游标增量同步，翻页/发送/撤回后落盘，切账号只清内存不清各自缓存。消息列表用 `windowSize=7` / `maxToRenderPerBatch=10` / `removeClippedSubviews` 降低长列表渲染开销。

- **图片预览防闪**：灯箱底层常驻本地缩略图，全图作为上层 Image 叠加、`onLoadEnd` 后才显现，不再替换底层 uri，避免「显示→消失→显示」。

- **编辑页手势**：Canvas 双指缩放（1–4 倍）与单指画圈互不干扰；点 T 进入文字放置模式，点击图片坐标后 RN 弹输入框，确认后在该坐标绘制。
- **消息页流畅度**：消息缓存写盘 500ms 防抖；会话/聊天列表启用窗口化渲染；聊天滚动定位同帧只调度一次；轮询、WS 通知与重连的增量同步每轮最多 2 页，进入会话仍补 10 页；401 仅对 `/im/`、`/auth/me`、`/admin/` 生效，避免公开接口偶发 401 误清登录态、弹出遮罩挡住点击。

- **灯箱翻页**：`PanResponder` 在首次渲染创建，回调必须通过 ref 读取最新的 `onSwitchByOffset`，否则每次滑动都从初次打开的那张计算 +1/-1，表现为只能看前后两张。
- **编辑页**：含图片 dataURL 的 HTML 落本地文件按 `HTML_VERSION`（当前 v7）复用；工具为画笔/尖头箭头/文字三选一，颜色条独立选择并应用于当前工具；Canvas 快照栈支持右上角 ↶/↷ 撤销重做；画笔用二次贝塞尔按中点平滑绘制，箭头从按下点到当前点画单条 butt 线端 + 三角尖头；文字模式下点击图片坐标，在该屏幕位置放 TextInput 光标并唤起系统键盘。

- **消息多选转发**：右上角不再常驻「转发」；长按消息进入多选并选中该条，点击其它消息切换选中，顶部出现「转发(n)」「取消」；多选态长按仍弹引用/复制/撤回菜单。
- **编辑页加载**：HTML 仍按 `HTML_VERSION` 落本地文件复用（省去重复生成 dataURL），但 WebView 用已验证的 `source={{html}}` 而非 `file://` URI——后者在 Android 上曾导致整页黑屏。

- **编辑页文字所见即所得**：输入每个字符都通过 `renderPendingText` 实时画到点击坐标（基于 beginText 快照重绘），TextInput 文字透明只留光标；换位置/切工具/导出/撤销时先 `finishText` 固化当前画面，文字始终以光标位置为起点，不产生偏移。

- **编辑页落点精度**：触摸监听从 `canvas` 提到 `document`，覆盖图片外的黑边区域；`point()` 把超出图片范围的坐标 clamp 到图片边界，保证任何位置都能落笔/落字；文字光标输入框移到 WebView 容器内相对定位，`clientX/clientY` 与 WebView 内坐标一致，不再被 header 偏移影响，光标跟手。

- **通讯 tab**：底栏由 4 个收敛为 3 个（地图 / 通讯 / 我的）；`communication.tsx` 内分「消息 / 通讯录」两栏，默认消息栏，未读数显示在两栏切换处与通讯 tab 角标。
- **编辑页形状工具**：工具栏在画笔/箭头/文字之外新增矩形 ▭ 与椭圆 ○，拖动范围实时预览；与颜色选择、撤销重做共用同一套 Canvas 快照与工具状态。

- **通讯子栏**：消息/通讯录不再渲染各自的页头标题与消息页刷新按钮（两栏切换处已有标题，聚焦与下拉刷新仍生效）；新建群入口与通讯录搜索框同一行。

- **我的页分组**：原「工具」分组标题改为「个性设置」（设置、我的足迹两项不变）；底部 tab 图标均为 View 自绘：地图=定位图钉（水滴+镂空），通讯=消息气泡+三个省略点，我的=人形剪影。
