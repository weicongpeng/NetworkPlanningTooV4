# 手机APP地图工具设计方案

## 1. 背景与目标

### 现有系统
- **桌面端**: Electron + React (Vite) + FastAPI 后端
- **后端服务**: 运行于 `http://127.0.0.1:8000`，提供 REST API 和 WebSocket
- **地图模块**: 基于高德 JS SDK Web 版实现

### 新增目标
- 开发 Android APP 作为前端，通过局域网访问 PC 后端
- 实现完整地图工具功能 + 高德导航
- 不影响现有桌面端功能

## 2. 技术方案

### 跨平台框架
**React Native + Expo**
- 理由：与现有前端技术栈一致，可复用部分 UI 代码
- Expo 简化开发和构建流程
- 高德地图有成熟的 React Native SDK 支持

### 地图与导航
**高德地图 SDK (Android)**
- 地图展示：高德 Flutter/Android SDK
- 导航功能：高德路径规划 + 实时导航
- 需申请高德 Android SDK Key

### 通信架构
```
┌─────────────────┐         ┌─────────────────┐
│   Android APP   │  HTTP   │   PC 后端       │
│  (React Native) │◄──────►│  (FastAPI)      │
│                 │  WebSocket  port:8000   │
└─────────────────┘         └─────────────────┘
```

- APP 通过局域网 `http://<PC_IP>:8000` 访问后端
- 后端需配置 CORS 允许跨域访问

## 3. 功能范围

### P0 核心功能（必须实现）
| 功能 | 说明 |
|------|------|
| 地图显示 | 高德地图，卫星图/矢量图切换 |
| 搜索定位 | 地名搜索、工参搜索、坐标定位 |
| 工参图层 | LTE/NR 扇区图层叠加显示 |
| 导航 | 高德 SDK 路径规划 + 导航 |

### P1 基础工具
| 功能 | 说明 |
|------|------|
| 打点标注 | 地图点击打点，保存标注 |
| 测距工具 | 测量两点/多点间距离 |
| 清除标记 | 清除所有临时标记 |

### P2 高级工具（可选）
| 功能 | 说明 |
|------|------|
| 圈选工具 | 矩形/圆形/多边形框选扇区 |
| 离线地图 | 支持离线地图瓦片 |

## 4. 模块设计

### 4.1 项目结构
```
mobile-app/
├── app/                      # Expo 入口
│   ├── +html.tsx
│   └── _layout.tsx
├── src/
│   ├── components/           # 通用组件
│   │   ├── Map/
│   │   │   ├── MapView.tsx      # 地图组件
│   │   │   ├── LayerControl.tsx # 图层控制
│   │   │   └── SectorLayer.tsx   # 扇区图层
│   │   ├── Search/
│   │   │   └── SearchBar.tsx
│   │   └── Navigation/
│   │       └── NavControl.tsx
│   ├── screens/
│   │   └── MapScreen.tsx     # 地图主页面
│   ├── services/
│   │   ├── api.ts            # 后端API调用
│   │   ├── amap.ts           # 高德SDK封装
│   │   └── navi.ts           # 导航服务
│   ├── store/
│   │   └── mapStore.ts       # 状态管理
│   └── utils/
│       ├── coordinate.ts     # 坐标转换
│       └── config.ts         # 配置管理
├── android/                  # Android 原生代码
│   └── app/src/main/java/
│       └── .../
└── package.json
```

### 4.2 依赖清单
| 依赖 | 版本 | 说明 |
|------|------|------|
| expo | ~52 | 开发框架 |
| react-native | 0.76 | React Native 核心 |
| @amap/amap-react-native | ^2 | 高德地图 React Native SDK |
| @react-navigation/native | ^7 | 导航 |
| axios | ^1 | HTTP 客户端 |
| zustand | ^5 | 状态管理 |

### 4.3 API 接口（复用现有后端）
| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/v1/map/data` | GET | 获取工参数据 |
| `/api/v1/map/online-config` | GET | 获取在线地图配置 |
| `/api/v1/geo-data/layers` | GET | 获取图层数据 |
| `/api/v1/data/list` | GET | 获取数据列表 |
| `/api/v1/data/{id}/preview` | GET | 获取数据预览 |

## 5. 后端适配

### 5.1 CORS 配置
修改 `backend/app/api/__init__.py`，支持局域网访问：
```python
allow_origins=[
    "http://localhost:*",
    "http://127.0.0.1:*",
    "http://<PC_IP>:*",  # 动态获取
]
```

### 5.2 服务发现（可选）
- 后端提供 `/api/v1/system/info` 接口，返回后端版本和IP
- APP 启动时自动发现同局域网后端

## 6. 高德SDK配置

### 6.1 申请 Key
访问 [高德开放平台](https://console.amap.com/dev/key/app) 创建 Android 应用，申请：
- **Web JS API Key** (已有，用于桌面端)
- **Android SDK Key** (新增，用于APP)

### 6.2 配置信息
```typescript
// src/utils/config.ts
export const AMAP_CONFIG = {
  androidKey: 'YOUR_ANDROID_SDK_KEY',
  webJsKey: '5299af602f4ee3cd7351c1bc7f32b1cb', // 桌面端已有
  securityJsCode: 'YOUR_SECURITY_JS_CODE',
}
```

## 7. 安全考虑

- 后端 CORS 仅允许已配置的域名访问
- API 请求不包含敏感认证信息（内网使用）
- 地图数据通过 HTTPS（生产环境）

## 8. 实施计划

### Phase 1: 项目搭建
- [ ] 初始化 Expo 项目
- [ ] 配置高德 SDK
- [ ] 基础地图显示

### Phase 2: 核心功能
- [ ] 搜索定位
- [ ] 工参图层
- [ ] 后端API对接

### Phase 3: 工具功能
- [ ] 打点标注
- [ ] 测距工具
- [ ] 清除标记

### Phase 4: 导航功能
- [ ] 高德导航 SDK 集成
- [ ] 路径规划
- [ ] 实时导航

### Phase 5: 优化与测试
- [ ] 性能优化
- [ ] 适配测试
- [ ] 桌面端回归测试
