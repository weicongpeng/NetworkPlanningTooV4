# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目概述

**工参地图 (gongcan-map)** — React Native (Expo SDK 52) Android 移动应用,用于在地图上展示 LTE/NR 通信基站扇区数据,支持 GPS 导航、距离测量、收藏打点、离线缓存与本地文件导入。当前仅打包 Android 平台 (见 `app.json`)。

## 常用命令

```bash
npm start              # 启动 Expo dev server
npm run android        # 在 Android 设备/模拟器运行
npm run ios            # 在 iOS 运行(未配置打包)
npm run build:android  # 出 release APK
```

项目**未配置测试框架**与 lint 脚本 (`package.json` 只有 start/android/ios/build:android)。`tsconfig.json` 开启 strict 模式;`tsc_errors.txt` 位于根目录用于记录历史类型错误。

## 架构概览

### 目录分层

- `App.tsx` — 应用入口,组合 `SafeAreaProvider` + `NavigationContainer` + Tab 布局
- `app/` — 路由层(Expo Router 风格目录,但实际用 React Navigation,无路由文件即路由)
  - `app/_layout.tsx` — 根布局
  - `app/(tabs)/` — 4 个底部 Tab 页面:
    - `index.tsx` (地图主屏,1k+ 行,业务核心)
    - `data.tsx` (数据管理:刷新/导入/缓存状态)
    - `favorites.tsx` (收藏点列表)
    - `settings.tsx` (后端地址配置)
  - `app/(tabs)/_layout.tsx` — 自定义底部 TabBar(支持导航时隐藏)
- `src/components/` — 按功能分的 UI 组件
  - `Map/MapView.tsx` (核心,封装 AMap WebView)
  - `Navigation/NavigationPanel.tsx` (导航面板,~25k 行)
  - `Search/SearchBar.tsx` `Marker/MarkerList.tsx` 等
- `src/services/` — 业务服务层
  - `api.ts` (axios 封装,运行时动态解析 baseURL)
  - `cacheService.ts` (本地文件缓存 + 首次启动自动缓存,~67k 行,核心)
  - `navigationService.ts` (GPS 定位 + 路径规划 + TTS,~54k 行,核心)
  - `dataParser.ts` `streamingParser.ts` `asyncParser.ts` (Excel/CSV/GeoJSON/MIF 解析)
  - `navi.ts` (导航辅助)
- `src/store/mapStore.ts` — Zustand 全局状态(扇区/标记/收藏/测量/导航/缓存)
- `src/types/data.ts` — 共享类型:缓存元数据、解析结果、GeoJSON 特征
- `src/utils/` — `coordinate.ts` (WGS84↔GCJ02 转换)、`clusterManager.ts` (Supercluster)、`viewportFilter.ts` (RBush 空间索引)、`config.ts` (API 地址解析)

### 数据流关键路径

1. **地图渲染**: `index.tsx` → `cacheService.getCachedSectors()` 优先读本地缓存 → 调 `apiService.getSystemInfo()/getSectors()` 拿最新 → 写入 `useMapStore.setSectors()` → 传给 `MapView` 在 AMap WebView 中渲染
2. **大文件导入**: `data.tsx` 调 `expo-document-picker` → `parseImportedFile()` 自动选择 `streamingParser` (>5MB/5000行) 或 `asyncParser` → 写入缓存目录 + 刷新 `useMapStore` 缓存状态
3. **导航**: `NavigationPanel` 调 `navigationService.planRoute()` → 高德路径规划 → 实时 `expo-location` 定位 → `expo-speech` TTS 播报

### 坐标系统

中国境内必须做 **WGS84 ↔ GCJ02 转换**(`src/utils/coordinate.ts`)。后端返回 WGS84,地图显示用 GCJ02(高德)。所有地图绘制/距离计算前需用 `wgs84ToGcj02()`/`gcj02ToWgs84()`。

## 后端 API 地址解析优先级

`src/utils/config.ts` 中 `getEffectiveApiBaseUrl()` 解析顺序:

1. 用户在 `settings.tsx` 自定义地址(AsyncStorage `@npt_custom_api_url`,运行时可热切换)
2. 环境变量 `EXPO_PUBLIC_API_URL`
3. 从 `Constants.expoConfig?.hostUri` 推导 LAN IP
4. 回退 `http://localhost:8000`

所有 API 路径会自动加 `/api/v1` 前缀。

## 关键约定

- **状态管理**: 全部走 `useMapStore`(Zustand),不要引入新状态库;只有 `favorites` 走 `persist` + AsyncStorage 持久化
- **缓存目录**: `FileSystem.documentDirectory}cache/{fullParams|geoData|layers|meta}/` — 加新缓存类型需在 `CACHE_DIRS` 注册
- **服务单例**: `apiService` `cacheService` 已导出单例,业务模块直接导入,不要重复实例化
- **WebView 通信**: `MapView.tsx` 通过 `injectJavaScript` 调 AMap,JS↔Native 用约定的 `postMessage` 协议
- **懒加载**: 20000+ 点数据时必须走 `clusterManager` + `viewportFilter`,禁止一次性 setState 全部点
- **本地解析**: 大文件 (>5MB 或 >5000行) 自动用流式解析,加 UI 让出 (yieldToUI) 防 ANR
- **响应式中文**: UI 文案为简体中文,保留原注释语言

## 配置文件

- `app.json` — Expo 配置(slug/packagerOpts.customHostUrl/permissions)
- `eas.json` — EAS Build 配置,preview 渠道默认 `https://apk.pengwc.asia`
- `.env` — `EXPO_PUBLIC_API_URL=https://app.pengwc.asia` (被 .gitignore 排除,本地配置)
- `tsconfig.json` — `strict: true`,`paths: { "@/*": ["./src/*"] }`

## 现有计划文档

- `IMPLEMENTATION_PLAN.md` — 大文件解析性能优化(流式/聚类/视窗筛选)的实施记录
- `.codebuddy/plans/mobile-app-offline-enhancement_*.md` — 离线缓存改造方案(已完成 phase 1-5)


<claude-mem-context>
# Memory Context

# claude-mem status

This project has no memory yet. The current session will seed it; subsequent sessions will receive auto-injected context for relevant past work.

Memory injection starts on your second session in a project.

`/learn-codebase` is available if the user wants to front-load the entire repo into memory in a single pass (~5 minutes on a typical repo, optional). Otherwise memory builds passively as work happens.

Live activity: http://localhost:37777
How it works: `/how-it-works`

This message disappears once the first observation lands.
</claude-mem-context>