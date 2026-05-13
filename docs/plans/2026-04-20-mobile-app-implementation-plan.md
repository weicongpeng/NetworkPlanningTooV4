# NetworkPlanningTooV3 手机APP 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 开发Android手机APP，通过局域网连接PC后端，实现完整地图工具功能和高德导航

**Architecture:** React Native (Expo) 跨平台APP，集成高德地图SDK Android版，通过HTTP/WebSocket与PC后端通信。后端CORS配置支持局域网访问，桌面端功能不受影响。

**Tech Stack:** React Native (Expo SDK 52), 高德地图SDK Android, axios, zustand

---

## Phase 1: 项目搭建

### Task 1: 创建 Expo 项目

**Files:**
- Create: `mobile-app/package.json`
- Create: `mobile-app/app.json`
- Create: `mobile-app/tsconfig.json`

**Step 1: 创建项目目录和配置文件**

```json
// mobile-app/package.json
{
  "name": "network-planning-mobile",
  "version": "1.0.0",
  "main": "expo/App.tsx",
  "scripts": {
    "start": "expo start",
    "android": "expo run:android",
    "build:android": "expo run:android --variant release"
  },
  "dependencies": {
    "expo": "~52.0.0",
    "react": "18.3.1",
    "react-native": "0.76.9",
    "@react-navigation/native": "^7.0.0",
    "@react-navigation/native-stack": "^7.0.0",
    "react-native-screens": "~4.4.0",
    "react-native-safe-area-context": "~4.14.0",
    "axios": "^1.7.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@types/react": "~18.3.0",
    "typescript": "~5.3.0"
  }
}
```

```json
// mobile-app/app.json
{
  "expo": {
    "name": "网络规划工具",
    "slug": "network-planning-mobile",
    "version": "1.0.0",
    "platforms": ["android"],
    "android": {
      "package": "com.networkplanning.mobile",
      "permissions": ["ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION"]
    }
  }
}
```

**Step 2: 初始化项目**

```bash
cd D:/mycode/NetworkPlanningTooV3
mkdir -p mobile-app
cd mobile-app
npx create-expo-app@latest . --template blank-typescript
```

**Step 3: Commit**

```bash
git add mobile-app/
git commit -m "feat(mobile): initial Expo project setup"
```

---

### Task 2: 配置后端CORS支持局域网访问

**Files:**
- Modify: `backend/app/api/__init__.py`

**Step 1: 查看当前CORS配置**

```python
# 查看 backend/app/api/__init__.py 中的 CORS 配置
```

**Step 2: 修改CORS配置**

```python
# backend/app/api/__init__.py
from fastapi.middleware.cors import CORSMiddleware
import socket

def get_local_ip():
    """获取本机局域网IP"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"

local_ip = get_local_ip()

origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    f"http://{local_ip}:5173",
    f"http://{local_ip}:8000",
    "http://localhost:8000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=f"http://.*:({5173|8000})",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**Step 3: 测试CORS生效**

启动后端后，从手机访问 `http://<PC_IP>:8000/docs` 验证CORS

**Step 4: Commit**

```bash
git add backend/app/api/__init__.py
git commit -m "fix(backend): enable CORS for LAN access from mobile app"
```

---

### Task 3: 添加服务发现接口

**Files:**
- Create: `backend/app/api/v1/endpoints/system.py`
- Modify: `backend/app/api/v1/__init__.py`

**Step 1: 创建 system.py**

```python
# backend/app/api/v1/endpoints/system.py
from fastapi import APIRouter
from pydantic import BaseModel
import socket

router = APIRouter(prefix="/system", tags=["system"])

class SystemInfo(BaseModel):
    version: str
    backend_ip: str
    backend_port: int

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"

@router.get("/info", response_model=SystemInfo)
async def get_system_info():
    return SystemInfo(
        version="1.0.0",
        backend_ip=get_local_ip(),
        backend_port=8000
    )
```

**Step 2: 注册路由**

```python
# backend/app/api/v1/__init__.py
from app.api.v1.endpoints import system, data, pci, neighbor, tac, geo_data, map, license, websocket

api_router = APIRouter()
api_router.include_router(system.router)
# ... 其他路由
```

**Step 3: Commit**

```bash
git add backend/app/api/v1/endpoints/system.py backend/app/api/v1/__init__.py
git commit -m "feat(backend): add system info endpoint for service discovery"
```

---

## Phase 2: 基础地图功能

### Task 4: 创建项目基础结构

**Files:**
- Create: `mobile-app/src/utils/config.ts`
- Create: `mobile-app/src/utils/coordinate.ts`
- Create: `mobile-app/src/services/api.ts`
- Create: `mobile-app/src/store/mapStore.ts`

**Step 1: 创建配置工具**

```typescript
// mobile-app/src/utils/config.ts

const AMAP_CONFIG = {
  androidKey: 'YOUR_ANDROID_SDK_KEY',
  webJsKey: '5299af602f4ee3cd7351c1bc7f32b1cb',
};

const BACKEND_CONFIG = {
  baseUrl: 'http://localhost:8000',
  apiPrefix: '/api/v1',
};

export { AMAP_CONFIG, BACKEND_CONFIG };
```

**Step 2: 创建坐标转换工具**

```typescript
// mobile-app/src/utils/coordinate.ts

// WGS84 to GCJ02
export function wgs84ToGcj02(lat: number, lng: number): [number, number] {
  // 高德SDK内部处理，此处仅作参考
  return [lat, lng];
}

// GCJ02 to WGS84
export function gcj02ToWgs84(lat: number, lng: number): [number, number] {
  // 高德SDK内部处理，此处仅作参考
  return [lat, lng];
}
```

**Step 3: 创建API服务**

```typescript
// mobile-app/src/services/api.ts
import axios, { AxiosInstance } from 'axios';
import { BACKEND_CONFIG } from '../utils/config';

class ApiService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: BACKEND_CONFIG.baseUrl + BACKEND_CONFIG.apiPrefix,
      timeout: 30000,
    });
  }

  async getSystemInfo() {
    const response = await this.client.get('/system/info');
    return response.data;
  }

  async getMapData() {
    const response = await this.client.get('/map/data');
    return response.data;
  }

  async getLayers(dataId: string) {
    const response = await this.client.get(`/geo-data/layers/${dataId}`);
    return response.data;
  }

  async getDataList() {
    const response = await this.client.get('/data/list');
    return response.data;
  }

  async searchPlace(keyword: string) {
    const apiKey = '5299af602f4ee3cd7351c1bc7f32b1cb';
    const url = `https://restapi.amap.com/v3/place/text?key=${apiKey}&keywords=${encodeURIComponent(keyword)}&output=json`;
    const response = await fetch(url);
    return response.json();
  }
}

export const apiService = new ApiService();
```

**Step 4: 创建状态管理**

```typescript
// mobile-app/src/store/mapStore.ts
import { create } from 'zustand';

interface MapState {
  backendIp: string;
  backendPort: number;
  isConnected: boolean;
  mapType: 'roadmap' | 'satellite';
  layers: {
    lte: { visible: boolean };
    nr: { visible: boolean };
  };
  setBackendInfo: (ip: string, port: number) => void;
  setConnected: (connected: boolean) => void;
  setMapType: (type: 'roadmap' | 'satellite') => void;
  toggleLayer: (type: 'lte' | 'nr') => void;
}

export const useMapStore = create<MapState>((set) => ({
  backendIp: '',
  backendPort: 8000,
  isConnected: false,
  mapType: 'roadmap',
  layers: {
    lte: { visible: true },
    nr: { visible: true },
  },
  setBackendInfo: (ip, port) => set({ backendIp: ip, backendPort: port }),
  setConnected: (connected) => set({ isConnected: connected }),
  setMapType: (type) => set({ mapType: type }),
  toggleLayer: (type) =>
    set((state) => ({
      layers: {
        ...state.layers,
        [type]: { visible: !state.layers[type].visible },
      },
    })),
}));
```

**Step 5: Commit**

```bash
git add mobile-app/src/
git commit -m "feat(mobile): add project base structure and utilities"
```

---

### Task 5: 创建地图主页面

**Files:**
- Create: `mobile-app/app/+html.tsx`
- Create: `mobile-app/app/_layout.tsx`
- Create: `mobile-app/app/(tabs)/index.tsx`

**Step 1: 创建入口文件**

```tsx
// mobile-app/app/+html.tsx
import { ScrollView, StyleSheet } from 'react-native';

export function redirect() {
  return <ScrollView />;
}
```

```tsx
// mobile-app/app/_layout.tsx
import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="+html" options={{ headerShown: false }} />
    </Stack>
  );
}
```

**Step 2: 创建地图页面**

```tsx
// mobile-app/app/(tabs)/index.tsx
import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useMapStore } from '../../src/store/mapStore';
import { apiService } from '../../src/services/api';

export default function MapScreen() {
  const { backendIp, isConnected, setBackendInfo, setConnected } = useMapStore();
  const [searchKeyword, setSearchKeyword] = useState('');

  useEffect(() => {
    // 连接后端获取服务信息
    const connect = async () => {
      try {
        const info = await apiService.getSystemInfo();
        setBackendInfo(info.backend_ip, info.backend_port);
        setConnected(true);
      } catch (error) {
        console.error('Failed to connect:', error);
        setConnected(false);
      }
    };
    connect();
  }, []);

  return (
    <View style={styles.container}>
      <Text>地图页面 - {isConnected ? `已连接 ${backendIp}` : '未连接'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
```

**Step 3: Commit**

```bash
git add mobile-app/app/
git commit -m "feat(mobile): add basic map screen"
```

---

## Phase 3: 高德地图SDK集成

### Task 6: 安装高德地图SDK

**Step 1: 安装依赖**

```bash
cd mobile-app
npx expo install @amap/amap-react-native
npx expo install react-native-amap-geolocation
```

**Step 2: 配置 Android 权限**

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

**Step 3: 配置高德Key**

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<meta-data
  android:name="com.amap.api.API_KEY"
  android:value="YOUR_ANDROID_SDK_KEY" />
```

**Step 4: Commit**

```bash
git add mobile-app/
git commit -m "feat(mobile): integrate AMap SDK"
```

---

### Task 7: 创建地图组件

**Files:**
- Create: `mobile-app/src/components/Map/MapView.tsx`

**Step 1: 创建地图组件**

```tsx
// mobile-app/src/components/Map/MapView.tsx
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import AMapLoader from '@amap/amap-react-native';
import { AMAP_CONFIG } from '../../utils/config';

interface MapViewProps {
  initialCenter?: [number, number];
  initialZoom?: number;
  showSatellite?: boolean;
  onMapPress?: (lat: number, lng: number) => void;
}

export default function MapView({
  initialCenter = [39.908823, 116.397470],
  initialZoom = 12,
  showSatellite = false,
  onMapPress,
}: MapViewProps) {
  const mapRef = useRef<any>(null);

  useEffect(() => {
    initMap();
  }, []);

  const initMap = async () => {
    try {
      await AMapLoader.load({
        key: AMAP_CONFIG.androidKey,
        version: '2.0',
      });
    } catch (error) {
      console.error('Failed to load AMap:', error);
    }
  };

  const handleMapClick = (e: any) => {
    if (onMapPress) {
      const { latitude, longitude } = e.nativeEvent.coordinate;
      onMapPress(latitude, longitude);
    }
  };

  return (
    <View style={styles.container}>
      <AMapView
        ref={mapRef}
        style={styles.map}
        initialRegion={{
          latitude: initialCenter[0],
          longitude: initialCenter[1],
          latitudeDelta: 0.0922,
          longitudeDelta: 0.0421,
        }}
        mapType={showSatellite ? 'Satellite' : 'Standard'}
        onPress={handleMapClick}
        showsUserLocation={true}
        showsCompass={true}
        showsScale={true}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
});
```

**Step 2: Commit**

```bash
git add mobile-app/src/components/Map/
git commit -m "feat(mobile): add MapView component with AMap SDK"
```

---

## Phase 4: 搜索功能

### Task 8: 添加搜索栏组件

**Files:**
- Create: `mobile-app/src/components/Search/SearchBar.tsx`

**Step 1: 创建搜索栏**

```tsx
// mobile-app/src/components/Search/SearchBar.tsx
import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, Text, StyleSheet } from 'react-native';

interface SearchResult {
  name: string;
  address: string;
  location: string;
}

interface SearchBarProps {
  onSearch: (keyword: string) => void;
  onResultSelect: (result: SearchResult) => void;
  placeholder?: string;
}

export default function SearchBar({
  onSearch,
  onResultSelect,
  placeholder = '搜索地点...',
}: SearchBarProps) {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);

  const handleSearch = async () => {
    if (!keyword.trim()) return;
    onSearch(keyword);
    // 调用高德搜索API
    const searchResults = await searchPlace(keyword);
    setResults(searchResults);
    setShowResults(true);
  };

  const searchPlace = async (kw: string): Promise<SearchResult[]> => {
    const apiKey = '5299af602f4ee3cd7351c1bc7f32b1cb';
    const url = `https://restapi.amap.com/v3/place/text?key=${apiKey}&keywords=${encodeURIComponent(kw)}&output=json`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.status === '1' && data.pois) {
      return data.pois.map((poi: any) => ({
        name: poi.name,
        address: poi.address || '',
        location: poi.location,
      }));
    }
    return [];
  };

  return (
    <View style={styles.container}>
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={keyword}
          onChangeText={setKeyword}
          placeholder={placeholder}
          onSubmitEditing={handleSearch}
          returnKeyType="search"
        />
        <TouchableOpacity style={styles.searchButton} onPress={handleSearch}>
          <Text>搜索</Text>
        </TouchableOpacity>
      </View>
      {showResults && results.length > 0 && (
        <View style={styles.results}>
          {results.map((result, index) => (
            <TouchableOpacity
              key={index}
              style={styles.resultItem}
              onPress={() => {
                onResultSelect(result);
                setShowResults(false);
              }}
            >
              <Text style={styles.resultName}>{result.name}</Text>
              <Text style={styles.resultAddress}>{result.address}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 10,
    backgroundColor: '#fff',
  },
  inputContainer: {
    flexDirection: 'row',
    gap: 10,
  },
  input: {
    flex: 1,
    height: 40,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 10,
  },
  searchButton: {
    paddingHorizontal: 20,
    backgroundColor: '#007AFF',
    borderRadius: 8,
    justifyContent: 'center',
  },
  results: {
    marginTop: 10,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
  },
  resultItem: {
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
  },
  resultName: {
    fontSize: 14,
    fontWeight: 'bold',
  },
  resultAddress: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
});
```

**Step 2: Commit**

```bash
git add mobile-app/src/components/Search/
git commit -m "feat(mobile): add SearchBar component"
```

---

## Phase 5: 导航功能

### Task 9: 集成高德导航SDK

**Files:**
- Create: `mobile-app/src/services/navi.ts`

**Step 1: 创建导航服务**

```typescript
// mobile-app/src/services/navi.ts
import { Platform, Linking } from 'react-native';

interface NaviParams {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  mode?: 'drive' | 'walk' | 'bus';
}

export async function startNavi(params: NaviParams): Promise<void> {
  const { startLat, startLng, endLat, endLng, mode = 'drive' } = params;

  if (Platform.OS === 'android') {
    // Android: 调用高德导航 Intent
    const scheme = `amapuri://route/${mode}?sourceApplication=NetworkPlanning&slat=${startLat}&slng=${startLng}&sname=起点&dlat=${endLat}&dlng=${endLng}&dname=终点&dev=0&m=0`;
    try {
      await Linking.openURL(scheme);
    } catch (error) {
      console.error('Failed to open navigation:', error);
      // 如果没有安装高德地图，引导用户安装
      await Linking.openURL('market://details/com.autonavi.minimap');
    }
  }
}

export async function startNaviToCoord(lat: number, lng: number, name?: string): Promise<void> {
  if (Platform.OS === 'android') {
    // 获取当前位置（简化处理，实际需要获取GPS位置）
    const scheme = `amapuri://route/drive?sourceApplication=NetworkPlanning&dlat=${lat}&dlng=${lng}&dname=${name || '目的地'}&dev=0&m=0`;
    try {
      await Linking.openURL(scheme);
    } catch (error) {
      console.error('Failed to open navigation:', error);
    }
  }
}
```

**Step 2: 创建导航控制组件**

```tsx
// mobile-app/src/components/Navigation/NavControl.tsx
import React from 'react';
import { TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { startNaviToCoord } from '../../services/navi';

interface NavControlProps {
  latitude: number;
  longitude: number;
  name?: string;
}

export default function NavControl({ latitude, longitude, name }: NavControlProps) {
  const handleNavigate = async () => {
    await startNaviToCoord(latitude, longitude, name);
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.button} onPress={handleNavigate}>
        <Text style={styles.buttonText}>导航到这里</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 10,
    backgroundColor: '#fff',
  },
  button: {
    backgroundColor: '#007AFF',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
```

**Step 3: Commit**

```bash
git add mobile-app/src/services/navi.ts mobile-app/src/components/Navigation/
git commit -m "feat(mobile): add navigation service with AMap integration"
```

---

## Phase 6: 完整地图页面整合

### Task 10: 整合地图页面

**Files:**
- Modify: `mobile-app/app/(tabs)/index.tsx`

**Step 1: 更新地图页面**

```tsx
// mobile-app/app/(tabs)/index.tsx
import React, { useState } from 'react';
import { View, StyleSheet, SafeAreaView } from 'react-native';
import MapView from '../../src/components/Map/MapView';
import SearchBar from '../../src/components/Search/SearchBar';
import NavControl from '../../src/components/Navigation/NavControl';
import { useMapStore } from '../../src/store/mapStore';

interface SearchResult {
  name: string;
  address: string;
  location: string;
}

export default function MapScreen() {
  const { mapType, setMapType } = useMapStore();
  const [selectedLocation, setSelectedLocation] = useState<{
    lat: number;
    lng: number;
    name: string;
  } | null>(null);

  const handleMapPress = (lat: number, lng: number) => {
    setSelectedLocation({ lat, lng, name: '' });
  };

  const handleResultSelect = (result: SearchResult) => {
    const [lng, lat] = result.location.split(',').map(Number);
    setSelectedLocation({ lat, lng, name: result.name });
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.searchContainer}>
        <SearchBar
          onSearch={() => {}}
          onResultSelect={handleResultSelect}
          placeholder="搜索地点或小区..."
        />
      </View>
      <View style={styles.mapContainer}>
        <MapView
          initialCenter={selectedLocation ? [selectedLocation.lat, selectedLocation.lng] : undefined}
          showSatellite={mapType === 'satellite'}
          onMapPress={handleMapPress}
        />
      </View>
      {selectedLocation && (
        <NavControl
          latitude={selectedLocation.lat}
          longitude={selectedLocation.lng}
          name={selectedLocation.name}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  searchContainer: {
    zIndex: 10,
  },
  mapContainer: {
    flex: 1,
  },
});
```

**Step 2: Commit**

```bash
git add mobile-app/app/
git commit -m "feat(mobile): integrate map screen with search and navigation"
```

---

## Phase 7: 桌面端回归测试

### Task 11: 桌面端功能验证

**Step 1: 启动后端服务**

```bash
cd backend
python main.py
```

**Step 2: 启动桌面前端**

```bash
cd frontend
npm run dev
```

**Step 3: 验证功能**

- [ ] 地图显示正常
- [ ] 搜索定位正常
- [ ] PCI规划正常
- [ ] 邻区规划正常
- [ ] TAC规划正常
- [ ] CORS配置不影响本地localhost访问

**Step 4: Commit**

```bash
git commit -m "test: verify desktop functionality after mobile app development"
```

---

## 实施顺序

1. Task 1: 创建 Expo 项目
2. Task 2: 配置后端CORS支持局域网访问
3. Task 3: 添加服务发现接口
4. Task 4: 创建项目基础结构
5. Task 5: 创建地图主页面
6. Task 6: 安装高德地图SDK
7. Task 7: 创建地图组件
8. Task 8: 添加搜索栏组件
9. Task 9: 集成高德导航SDK
10. Task 10: 整合地图页面
11. Task 11: 桌面端回归测试

---

## 风险与注意事项

1. **高德SDK Key申请**: 需要同时申请Android SDK Key和Web JS API Key
2. **局域网发现**: 手机需要知道PC的IP地址，或者通过服务发现接口自动获取
3. **坐标系统**: 高德地图使用GCJ02坐标系，需要注意与WGS84的转换
4. **性能**: React Native地图性能可能不如原生，后续可考虑优化

---

## 测试计划

### 单元测试
- 坐标转换工具测试
- API服务测试
- 状态管理测试

### 集成测试
- 后端API调用测试
- 高德地图加载测试
- 导航功能测试

### 回归测试
- 桌面端所有功能验证
- CORS配置对桌面端无影响验证
