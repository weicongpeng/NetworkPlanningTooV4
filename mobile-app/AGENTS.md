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

- `App.tsx` — 应用入口，组合 `SafeAreaProvider` + `NavigationContainer` + 根栈导航
- `app/navigation/AppNavigator.tsx` — 根栈：Tabs / 聊天 / 群资料 / 转发 / 数据管理 / 收藏
- `app/` — 路由层（Expo Router 风格目录，实际用 React Navigation）
  - `app/(tabs)/` — 3 个底部 Tab：地图、通讯（消息/通讯录两栏）、我的
    - `index.tsx` (地图主屏)
    - `communication.tsx` (通讯 tab，默认消息栏) / `messages.tsx` / `contacts.tsx` (以 embedded 子页复用)
    - `profile.tsx` (我的：账号/数据/个性设置/关于四组入口，登录与设置弹层)
    - `data.tsx` / `favorites.tsx` 已改为根栈二级页，从「我的」进入
  - `app/chat/` — `ChatScreen` / `GroupInfoScreen` / `ForwardScreen`
- `src/components/Im/` — 会话行、消息气泡（网址可点）、四控件输入区、@选择、媒体灯箱（渐进加载 + 捏合缩放 + WebView 视频 + 编辑/下载/转发/查看）、Canvas 图片标注器、明暗配色
- `src/components/Profile/` — 我的页共用行组件、资料编辑（头像/昵称）、更新检查、登录/设置弹层、样式与后端地址设置
- `src/services/`
  - `api.ts` (axios 单例，通用 `request()`，运行时动态解析 baseURL)
  - `imApi.ts` / `imAttachment.ts` / `imWebSocket.ts` (协作沟通 REST、分片附件、WS 轻通知+轮询)
  - `cacheService.ts` / `navigationService.ts` / `auth.ts` 等原有服务
- `src/store/mapStore.ts` — 地图状态；`src/store/imStore.ts` — IM 会话/消息/游标/未读/实时状态
- `src/types/im.ts` — IM 前后端契约类型与展示辅助
- `src/utils/` — `coordinate.ts`、`clusterManager.ts`、`viewportFilter.ts`、`config.ts`、`navigation.ts` (根栈/Tab 跳转)、`linkify.ts` (网址切分)

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

- **状态管理**: 地图状态走 `useMapStore`，IM 状态走 `src/store/imStore.ts`（同为 Zustand，不引入新状态库）；只有 `favorites` 走 `persist` + AsyncStorage 持久化
- **Zustand v5 selector**: 必须返回稳定引用，禁止在 selector 里写 `|| []`、`.map()` 或对象字面量（会触发 `getSnapshot should be cached` 无限重渲染）；空集合用 `imStore.ts` 导出的 `EMPTY_MESSAGES` / `EMPTY_ATTACHMENTS`
- **IM 原生依赖**: `expo-image-picker` 必须在 `imAttachment.ts` 里 `try/catch` 安全加载，旧 APK 缺模块时不得阻断启动；不要为此新增其它原生库，图片缩放用 RN 内置 `PanResponder`
- **401 会话失效**: 后端空闲阈值为 180 分钟，隔夜必然过期；`api.ts` / `auth.ts` 的带 token 请求遇到 401 一律 `reportUnauthorized` → `sessionGuard.invalidateSession()` 清凭证、停 IM 链路、置全局未登录并显示重登入口。心跳 `useHeartbeat()` 必须挂在 `App.tsx` 根组件，不能放 Tab 页（懒加载会漏跑）
- **媒体预览**: 视频复用已装的 `react-native-webview` + 签名直链 HTML5 `<video>`；图片先显示已预热的缩略图再后台换全图，点击图片本身退出，视频仍点媒体外暗色区域退出；图片标注用 WebView Canvas 导出 dataURL 存本地后交系统分享面板，禁止新增播放器/绘图原生依赖
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