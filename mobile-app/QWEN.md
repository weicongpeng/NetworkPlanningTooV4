# 工参地图 (gongcan-map) — QWEN.md

## 项目概述

**工参地图 (gongcan-map)** v2.0.2 — React Native (Expo SDK 52) Android 移动应用,专为通信网络规划/优化工程师设计。在地图上展示 LTE/NR 通信基站扇区数据,支持 GPS 导航、距离测量、收藏打点、离线缓存与本地文件导入。

**包名**: `com.networkplanning.mobile` | **仅打包 Android 平台**

## 常用命令

```bash
npm start              # 启动 Expo dev server (Metro bundler)
npm run android        # 在 Android 设备/模拟器运行 debug APK
npm run ios            # 在 iOS 运行(未配置,不可用)
npm run build:android  # 出 release APK (--variant release)
```

项目**未配置测试框架**与 lint 脚本。TypeScript strict 模式已开启。

## 架构总览

### 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| 核心框架 | React Native + Expo SDK | 0.76.9 / 52.0.0 |
| 导航 | React Navigation (bottom-tabs + native-stack) | 7.x |
| 状态管理 | Zustand (带 persist 中间件) | 5.0.12 |
| 地图 | `react-native-amap3d` (原生高德) + WebView 桥接 | 3.2.4 |
| 地图渲染 | 内嵌 AMap JS API (WebView) | v2.0 |
| 定位 | `expo-location` (前后台) + `expo-task-manager` | 18.x |
| 语音 | `expo-speech` (TTS 导航播报) | 13.x |
| 网络 | axios + fetch (含动态 baseURL) | 1.15.1 |
| 文件解析 | xlsx (Excel) + papaparse (CSV) + jszip (ZIP) | — |
| 聚类/空间索引 | supercluster + rbush | 8.x / 4.x |
| 持久化 | `@react-native-async-storage/async-storage` | 1.22.x |
| 本地缓存 | `expo-file-system` 文件系统 + AsyncStorage 元数据 | 18.x |

### 目录结构

```
mobile-app/
├── App.tsx                    # 应用入口 (SafeAreaProvider + NavigationContainer + 版本检查)
├── app/
│   ├── _layout.tsx            # 根布局 (仅 SafeAreaProvider + StatusBar)
│   ├── +html.tsx              # Web fallback
│   └── (tabs)/
│       ├── _layout.tsx        # 自定义 TabBar (4 tab: 地图/数据/收藏/我的, 支持导航时隐藏)
│       ├── index.tsx          # 地图主屏 (1.1k+ 行, 业务核心)
│       ├── data.tsx           # 数据管理 (刷新/导入/缓存状态, 717 行)
│       ├── favorites.tsx      # 收藏点列表 (323 行)
│       ├── profile.tsx        # "我的" Tab (登录注册/设置/导航记录/版本更新, 1.5k+ 行)
│       └── settings.tsx       # 后端地址配置 (402 行)
├── src/
│   ├── components/
│   │   ├── Auth/              # 登录鉴权组件
│   │   ├── Map/
│   │   │   └── MapView.tsx    # 核心地图 (WebView 封装 AMap JS, 829 行, 26+ ref 方法)
│   │   ├── Marker/
│   │   │   └── MarkerList.tsx # 标记列表
│   │   ├── Measure/
│   │   │   └── MeasureControl.tsx  # 距离测量控制
│   │   ├── Navigation/
│   │   │   ├── NavigationPanel.tsx # 导航面板 (~25k 行, 最大文件)
│   │   │   └── NavControl.tsx      # 导航触发控件
│   │   └── Search/
│   │       └── SearchBar.tsx  # 扇区参数搜索/POI 搜索
│   ├── services/
│   │   ├── api.ts             # axios 封装, 动态 baseURL, 登录态 token 注入 (184 行)
│   │   ├── auth.ts            # 用户认证 (login/register/logout/ping/fetchMe) (~250 行)
│   │   ├── cacheService.ts    # 本地文件缓存 + 首次启动自动缓存 (~67k 行)
│   │   ├── navigationService.ts   # GPS 定位 + 路径规划 + TTS 播报 + 偏航检测 (~54k 行)
│   │   ├── dataParser.ts      # Excel/CSV/GeoJSON/MIF 解析 (~1.1k 行)
│   │   ├── streamingParser.ts # 流式解析器 (大文件分块读取, >5MB/5000行)
│   │   ├── asyncParser.ts     # 异步解析器 (中等文件分片处理)
│   │   ├── downloadService.ts # APK 下载 + Tailscale 直连加速 (~263 行)
│   │   ├── compassService.ts  # 方向传感器
│   │   └── navi.ts            # 导航辅助函数
│   ├── store/
│   │   └── mapStore.ts        # Zustand 全局状态 (扇区/标记/收藏/测量/导航/缓存, 323 行)
│   ├── types/
│   │   └── data.ts            # 共享类型: CacheMeta, ImportResult, GeoJSON, ParsedSector 等
│   ├── hooks/
│   │   ├── useRestoreAuth.ts  # 启动时从 AsyncStorage 恢复登录态
│   │   └── useHeartbeat.ts    # 每 5 分钟 auth/ping 保活
│   └── utils/
│       ├── config.ts          # API 地址解析 (自定义/环境变量/LAN IP/localhost)
│       ├── coordinate.ts      # WGS84 ↔ GCJ02 坐标转换 (含中国境外判断)
│       ├── clusterManager.ts  # Supercluster 聚类管理 (20000+ 点)
│       ├── viewportFilter.ts  # RBush 空间索引视窗筛选
│       └── templateGenerator.ts  # 工参模板文件生成
```

### 配置 / 构建文件

| 文件 | 作用 |
|------|------|
| `app.json` | Expo 配置 (slug/icon/permissions/runtimeVersion) |
| `eas.json` | EAS Build: `development`(debug APK) + `preview`(release APK, `EXPO_PUBLIC_API_URL` 覆盖) |
| `.env` | `EXPO_PUBLIC_API_URL=https://app.pengwc.asia` (gitignored, 本地配置) |
| `tsconfig.json` | `strict: true`, `paths: { "@/*": ["./src/*"] }` |
| `package.json` | Node >=20.0 <22.0 |
| `.nvmrc` | Node 20 |
| `android/` | 原生 Android 项目 (build.gradle, AndroidManifest.xml, proguard 等) |

### 数据流关键路径

1. **地图渲染**: `index.tsx` → `cacheService.getCachedSectors()` 读本地缓存 → 调 `apiService.getSystemInfo()/getSectors()` 拿最新 → 写入 `useMapStore.setSectors()` → 传给 `MapView` 在 AMap WebView 中渲染
2. **大文件导入**: `data.tsx` 调 `expo-document-picker` → `parseImportedFile()` 自动选择 `streamingParser` (>5MB/5000行) 或 `asyncParser` → 写入缓存目录 + 刷新 `useMapStore` 缓存状态
3. **导航**: `NavigationPanel` 调 `navigationService.planRoute()` → 高德路径规划 → `expo-location` 实时定位 → `expo-speech` TTS 播报

### 坐标系统

中国境内必须做 **WGS84 ↔ GCJ02 转换** (`src/utils/coordinate.ts`):
- **WGS84**: GPS 标准坐标, 后端/文件导入数据使用
- **GCJ02**: 国测局坐标(火星坐标), 高德地图使用
- 后端返回 WGS84, 地图显示用 GCJ02
- 境外坐标 (>73-135°E / >0-53°N) 跳过转换

## 后端 API 地址解析

`src/utils/config.ts` → `getEffectiveApiBaseUrl()` 优先级:

1. **用户自定义** — AsyncStorage `@npt_custom_api_url` (settings.tsx 中可热切换)
2. **环境变量** — `EXPO_PUBLIC_API_URL`
3. **LAN IP** — 从 `Constants.expoConfig?.hostUri` 推导 (Expo 调试模式)
4. **回退** — `http://localhost:8000`

所有 API 路径自动加 `/api/v1` 前缀。**后端为 FastAPI 项目, 同仓库 `../backend/` 目录。**

## 关键约定

### 状态管理 (Zustand)
- 全局状态全部走 `useMapStore` (`src/store/mapStore.ts`), 不要引入新状态库
- 只有 `favorites` (收藏) 走 `persist` + AsyncStorage 持久化, 其他状态重启后清空
- 登录状态为会话级 (不持久化), 通过 `useRestoreAuth` hook 在 App.tsx 启动时从 AsyncStorage 恢复

### 服务单例
- `apiService` (`src/services/api.ts`), `cacheService` (`src/services/cacheService.ts`) 已导出单例, 直接导入使用, 不要重复实例化
- `auth.ts` 使用独立 axios 实例 (不走 apiService 拦截器, 避免循环)

### 缓存系统
- 目录: `FileSystem.documentDirectory}cache/{fullParams|geoData|layers|meta}/`
- 首次启动自动缓存全量数据, 优先读本地缓存, 后台刷新
- 加新缓存类型需在 `CACHE_DIRS` 注册

### WebView 通信
- `MapView.tsx` 通过 `injectJavaScript` 调用 AMap JS API
- JS ↔ Native 通过 `window.ReactNativeWebView.postMessage()` 协议通信

### 性能优化
- **20000+ 点数据**: 必须走 `clusterManager` (Supercluster) + `viewportFilter` (RBush), 禁止一次性 setState 全部点
- **大文件 (>5MB 或 >5000行)**: 自动用流式解析 (`streamingParser`), 每批处理后让出主线程 (`yieldToUI`) 防 ANR
- **中等文件**: 使用 `asyncParser` (InteractionManager + 分片处理)

### UI
- 文案为简体中文
- 亮/暗色主题通过 `darkMode` 状态切换, 每个页面定义自己的 `LIGHT_COLORS` / `DARK_COLORS` 常量
- 搜索支持三种模式: `parameter` (扇区参数), `place` (POI 名称), `coordinate` (经纬度)

### 认证
- 登录请求必须带 `client_type: "app"` (后端基于此区分 APP 端与 Web 端)
- 登录后所有请求通过 apiService 拦截器自动附加 `Authorization: Bearer <token>` + `X-Client: app`
- `useHeartbeat` hook 每 5 分钟调 `auth/ping` 保持会话在线

### 文件解析
- 支持格式: xlsx, xls, csv, json (GeoJSON 格式), mif
- 自动字段检测: 根据行表头匹配预定义 `FIELD_PATTERNS` / `LTE_COLUMN_MAP` / `NR_COLUMN_MAP` 多别名 (中英文)
- 解析过程中跳过空行/无效经纬度/境外坐标/重复行, 生成 `SkipStats` 报告

## 现有文档

- `IMPLEMENTATION_PLAN.md` — 大文件解析性能优化 (流式/聚类/视窗筛选, 4 阶段已完成)
- `docs/` — 5 篇完整技术文档 (架构/模块/数据流/API/部署)
- `.codebuddy/plans/mobile-app-offline-enhancement_*.md` — 离线缓存改造方案 (已完成 phase 1-5)
- `Development_Guidelines_CN.md` / `Development_Guidelines_EN.md` — 开发指南
- `CLAUDE.md` — Codex.ai 项目上下文
- `AGENTS.md` — Codex.ai 代理上下文

## 依赖安装记录

```bash
npm install supercluster rbush    # 已安装 (聚类 + 空间索引)
```

## APK 下载 / OTA 更新

- App.tsx 启动时自动检查版本 (`apiService.checkAppVersion()`)
- 新版本提示 → 通过 `downloadService.downloadAndInstall()` 下载 + `expo-sharing` 调起安装器
- 下载优先走 Tailscale 直连 (`https://armbian.tail362392.ts.net`) 绕过 Cloudflare Tunnel 限速
- 构建: `npm run build:android` 或 `eas build --profile preview --platform android`
- preview 渠道默认 `EXPO_PUBLIC_API_URL=https://apk.pengwc.asia`
- EAS projectId: `0ced5215-39c6-4472-9497-65dc2d2a9da5`
