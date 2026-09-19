# NetworkPlanningTooV3 — 网络规划工具 v3.0

## 项目概述

电信网络规划桌面应用 + Web 服务，提供地图可视化、邻区规划、PCI（物理小区标识）规划和 TAC（跟踪区域码）规划功能。

### 架构模式

```
Electron 桌面应用 / Web SPA ─── HTTP REST + WebSocket ─── FastAPI 后端
       │                                                       │
  React 18 + TypeScript + Vite                    Python 3 + FastAPI + SQLAlchemy
  Zustand (状态管理)                                 Pandas + GeoPandas (数据处理)
  Leaflet (地图渲染)                                 scikit-learn (空间索引)
  Tailwind CSS + Radix UI (组件库)                   asyncio (异步任务管理)
```

**三套运行形态：**
1. **Electron 桌面应用**（主模式）— Electron 主进程自动启动后端 Python 进程
2. **纯 Web 应用** — 仅启动 Vite 开发服务器，通过 Vite Proxy 转发 API 请求
3. **React Native 移动端**（`mobile-app/`）—— Expo 框架，Android APK 构建

### 核心功能模块

| 模块 | 功能 | 后端服务 | 前端页面 |
|------|------|---------|---------|
| **数据管理** | 上传/预览/删除工参数据(Excel/CSV/TXT/TAB/MIF) | `data_service.py`, `geo_data_service.py` | `DataPage.tsx` |
| **PCI 规划** | 物理小区标识规划，碰撞/混淆检测，模3/模30约束 | `pci_planning_service_v2.py` | `PCIPage.tsx` |
| **邻区规划** | 自动邻区关系规划，基于覆盖圆算法 | `neighbor_planning_v1_service.py` | `NeighborPage.tsx` |
| **TAC 规划** | 跟踪区域码规划，异TAC孤岛(插花)检测 | `tac_planning_service.py` | `TACPage.tsx`, `TACPlanningPage.tsx` |
| **地图可视化** | 在线(高德/OSM)/离线地图，工参展示，扇区渲染 | `geo_data_service.py`, `mapinfo_service.py` | `MapPage.tsx` |
| **许可证管理** | 许可证激活/验证/过期管理 | `license_service.py` | `LicensePage.tsx` |
| **用户管理** | JWT 认证，用户 CRUD，角色权限 | `auth_service.py` | `AdminUsersPage.tsx` |
| **APP 版本管理** | 移动端 APK 版本检查、上传、下载 | `app_versions.py` | `AppVersionsPage.tsx` |
| **系统服务** | 健康检查、配置查询、WebSocket 实时通信 | `system.py`, `websocket.py` | — |

---

## 项目结构

```
NetworkPlanningTooV3/
├── backend/                          # FastAPI 后端服务
│   ├── app/
│   │   ├── api/                       # API 路由层
│   │   │   ├── __init__.py            # FastAPI 应用创建 & 生命周期
│   │   │   └── v1/
│   │   │       ├── __init__.py        # 路由注册
│   │   │       └── endpoints/         # 各模块端点 (15个文件)
│   │   ├── algorithms/               # 核心规划算法
│   │   │   ├── pci_planning_service_v2.py
│   │   │   ├── pci_planning_v1_service.py
│   │   │   ├── neighbor_planning_v1_service.py
│   │   │   ├── distance_calculator.py
│   │   │   └── pci_collision_detector.py
│   │   ├── core/                      # 配置 & 异常
│   │   │   ├── config.py              # Settings 类 (NPT_ 环境变量)
│   │   │   └── exceptions.py
│   │   ├── models/                    # Pydantic 数据模型
│   │   │   └── schemas.py             # 764 行 - 所有请求/响应模型
│   │   ├── services/                  # 业务逻辑层 (13个文件)
│   │   │   ├── data_service.py        # 数据管理 (单例)
│   │   │   ├── task_manager.py        # 异步任务管理器 (单例, 3257行)
│   │   │   ├── websocket_manager.py   # WebSocket 连接管理
│   │   │   ├── tac_planning_service.py
│   │   │   ├── geo_data_service.py
│   │   │   ├── export_service.py
│   │   │   ├── mapinfo_service.py
│   │   │   ├── license_service.py
│   │   │   ├── auth_service.py
│   │   │   └── geo_field_detector.py
│   │   └── utils/                     # 工具函数
│   │       ├── coordinate_transformer.py
│   │       ├── hardware_fingerprint.py
│   │       └── layer_type_config.py
│   ├── main.py                        # 应用入口 & 编码处理
│   ├── requirements.txt
│   ├── Dockerfile
│   └── tests/                         # 单元测试 (7个文件)
├── frontend/                          # React 前端
│   ├── src/
│   │   └── renderer/
│   │       ├── main.tsx               # React 入口
│   │       ├── App.tsx                # 根组件 & 路由配置
│   │       ├── i18n.ts                # 国际化配置
│   │       ├── pages/                 # 页面组件 (19个文件)
│   │       ├── components/            # 通用组件
│   │       │   ├── Layout/           # 布局组件
│   │       │   └── Map/              # 地图组件 (18个文件)
│   │       ├── store/                 # Zustand 状态管理 (13个 store)
│   │       ├── services/              # Axios API 封装
│   │       ├── locales/               # 翻译文件 (zh.json / en.json)
│   │       ├── hooks/                 # 自定义 Hooks
│   │       ├── config/                # 前端配置
│   │       └── utils/                 # 工具函数
│   ├── vite.config.ts
│   └── package.json
├── shared/
│   └── types.ts                       # 前后端共享 TypeScript 类型 (422行)
├── mobile-app/                        # React Native (Expo) 移动端
├── scripts/                           # 构建/部署脚本
│   ├── build-backend.sh
│   ├── build-frontend.sh
│   ├── build-exe.bat / build-exe.ps1
│   ├── start-dev.ps1
│   └── run-tests.sh
├── template/                          # Excel 上传模板文件
├── data/                              # 上传数据存储目录 (gitignored)
├── exports/                           # 导出文件目录
├── outputs/                           # 规划结果输出目录
├── uploads/                           # 上传临时目录
├── docs/                              # 项目文档
│   └── plans/                        # 实施计划
└── 待规划小区/ 全量工参/ 输出文件/       # 中文数据目录 (gitignored)
```

---

## 构建与运行

### 开发环境快速启动

```bash
# 后端 (FastAPI)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py                          # http://127.0.0.1:8000
                                        # API docs: http://127.0.0.1:8000/docs

# 前端 (Vite dev server)
cd frontend
npm install
npm run dev:web                         # http://localhost:5173

# 或 Electron 桌面应用
npm run dev                             # Vite + Electron 同时启动
```

### 生产构建与部署

```bash
# 1. 构建前端
cd frontend && npm run build:vite       # 输出到 dist-renderer/

# 2. 后端自动提供静态文件服务
cd backend && python main.py            # NPT_RELOAD=false

# 3. 切换分支后更新
cd frontend && npm run build:vite && systemctl --user restart npt-backend
```

### 测试

```bash
cd backend
source .venv/bin/activate
pytest -v                               # 所有测试
pytest tests/test_pci_vectorization.py  # 单文件
pytest -k "test_name"                   # 匹配测试名
```

---

## 后端配置

所有配置通过 `NPT_` 前缀环境变量覆盖（详见 `backend/app/core/config.py` 的 `Settings` 类）：

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `NPT_HOST` | `0.0.0.0` | 监听地址 |
| `NPT_PORT` | `8000` | 监听端口 |
| `NPT_CORS_ORIGINS` | localhost:5173 | CORS 允许源（逗号分隔） |
| `NPT_RELOAD` | `false` | 开发热重载模式 |
| `NPT_WORKERS` | `1` | 进程数 |
| `NPT_JWT_SECRET_KEY` | (内建) | JWT 签名密钥 |
| `NPT_LICENSE_SECRET_KEY` | (内建) | 许可证签名密钥 |
| `NPT_AMAP_API_KEY` | (内建开发密钥) | 高德地图 API Key |
| `NPT_AMAP_SECURITY_CODE` | `""` | 高德地图安全码 |
| `NPT_MAX_TASKS` | `10` | 最大并发任务数 |
| `NPT_TASK_TIMEOUT` | `3600` | 任务超时（秒） |
| `NPT_MAX_WORKERS` | `3` | 进程池 Worker 数 |

`backend/.env` 文件可用于本地覆盖（已 gitignored）。

---

## 开发约定

### 前端代码规范

- **UI 文本国际化**：所有展示文本使用 `t()` 翻译函数（`useTranslation()` hook），禁止硬编码中文
- **组件内翻译**：子组件需在自己函数体内调用 `useTranslation()`，不从父组件传入 `t`
- **日期格式化**：根据 `i18n.language` 动态设置 locale（`en-US` / `zh-CN`）
- **搜索/过滤**：使用布尔值或原始数据比较，不用 `t()` 返回值
- **翻译 key 同步**：`locales/zh.json` 和 `locales/en.json` 必须同步添加

### 导入顺序

```typescript
// 前端
import React from 'react'               // 1. 外部库
import { apiClient } from '@/services'  // 2. 内部模块 (@/ 别名)
import type { DataItem } from '@shared' // 3. 类型导入 (type 关键字)
```

```python
# 后端
import asyncio                          # 1. 标准库
from fastapi import APIRouter           # 2. 第三方
from app.models.schemas import DataItem # 3. 内部
```

### 命名约定

| 位置 | 组件/类 | 函数/变量 | 常量 | 文件 |
|------|---------|----------|------|------|
| 前端 | PascalCase | camelCase | UPPER_SNAKE_CASE | kebab-case |
| 后端 | PascalCase | snake_case | UPPER_SNAKE_CASE | snake_case |

### Python 编码处理（Windows 兼容）

所有错误消息需做 GBK 安全处理：

```python
try:
    result = operation()
except Exception as e:
    safe_detail = str(e).encode("gbk", "replace").decode("gbk")
    raise HTTPException(status_code=400, detail=safe_detail)
```

CPU 密集型操作使用 `run_in_threadpool`：

```python
from fastapi.concurrency import run_in_threadpool
result = await run_in_threadpool(heavy_pandas_operation, df)
```

### SQLAlchemy 数据库

项目使用 SQLAlchemy + SQLite（`backend/npt.db`）。数据库用于存储：

- 用户账户（认证信息）
- 用户设置（UI 偏好）
- APP 版本记录（移动端 APK 元数据）
- 历史操作记录

---

## API 端点总览

所有端点挂载在 `/api/v1/` 下，完整路由注册见 `backend/app/api/v1/__init__.py`：

| 模块 | 前缀 | 端点文件 | 主要功能 |
|------|------|---------|---------|
| 认证 | `/auth` | `auth.py` | 登录/注册/Token 刷新 |
| 许可 | `/license` | `license.py` | 许可证状态/激活/上传 |
| 数据 | `/data` | `data.py` + `geo_data.py` | 上传/预览/列表/删除/模板下载 |
| PCI | `/pci` | `pci.py` | 规划/进度/结果/导出 |
| 邻区 | `/neighbor` | `neighbor.py` | 规划/进度/结果/导出 |
| TAC | `/tac` | `tac.py` | 规划/核查/进度/结果/导出 |
| 地图 | `/map` | `map.py` | 数据查询/在线配置/离线路径 |
| 系统 | `/system` | `system.py` | 健康检查/配置查询 |
| WebSocket | (根) | `websocket.py` | 实时进度推送 `/ws` |
| 用户 | `/user` | `user_settings.py` | 用户偏好设置 |
| 管理 | `/admin/users` | `admin_users.py` | 用户 CRUD |
| APP 版本 | `/app-versions` | `app_versions.py` | APK 上传/下载/版本检查 |

---

## 关键数据流

### 文件上传 → 数据处理

```
用户选择文件 → POST /api/v1/data/upload/excel
→ data_service 处理 → Pandas 解析 Excel (LTE/NR 分表)
→ 存储到 data/ 目录 → 更新 data/index.json 内存索引
```

### 异步规划任务

```
用户配置 → POST /api/v1/pci/plan
→ task_manager.create_pci_task()
→ asyncio.create_task(_run_pci_task)
→ pci_planning_service_v2 执行算法
→ progress_callback → WebSocket 推送 → 前端实时进度条
→ 完成后存储结果到 outputs/
```

### 前端双客户端模式

```typescript
// 普通 API 请求 (开发环境通过 Vite Proxy)
const apiClient = axios.create({ baseURL: '/api/v1', timeout: 300000 })

// 文件上传专用 (开发环境直连后端)
const uploadClient = axios.create({
  baseURL: isDev ? 'http://localhost:8000/api/v1' : '/api/v1',
  timeout: 300000
})
```

### 状态管理 (Zustand)

| Store | 用途 |
|-------|------|
| `authStore` | 认证状态、Token |
| `dataStore` | 数据文件列表 |
| `taskStore` | 异步任务进度 |
| `mapStore` | 地图状态（中心/缩放/图层） |
| `pciStore` | PCI 规划配置与结果 |
| `neighborStore` | 邻区规划配置与结果 |
| `tacStore` / `tacCheckStore` | TAC 核查状态 |
| `tacPlanningStore` | TAC 规划状态 |
| `licenseStore` | 许可证状态 |
| `downloadStore` | 下载管理 |
| `themeStore` | 主题设置 |
| `mapDataCacheStore` | 地图数据缓存 |

---

## 生产环境部署（Linux x86 + Cloudflare Tunnel）

当前生产环境运行在 **Ubuntu 24 (x86_64)**，通过 Cloudflare Tunnel 提供公网访问。

### 架构

```
用户浏览器 ──HTTPS──▶ Cloudflare Tunnel (app.pengwc.asia)
                   ──▶ localhost:8000 (FastAPI)
                     └─── 静态文件服务 (frontend/dist-renderer/)
```

### 系统服务

**`npt-backend.service`** (systemd) 管理后端进程：

```bash
systemctl --user restart npt-backend    # 重启后端
journalctl --user -u npt-backend -n 50  # 查看日志
tail -f /var/log/npt-backend.log        # 实时日志
```

**内存限制**：MemoryMax=2G，MemoryHigh=1.5G（systemd 配置）

### 更新步骤

```bash
# 1. 构建前端
cd frontend && npm run build:vite

# 2. 重启后端
systemctl --user restart npt-backend

# 3. 验证
curl http://localhost:8000/api/v1/system/status
```

### 关键注意事项

- 修改后端代码 → 仅重启 systemd 服务（`systemctl --user restart npt-backend`）
- 修改前端代码 → 必须先 `npm run build:vite`，然后重启后端
- 生成环境禁用 reload（`NPT_RELOAD=false`），避免 watchfiles 高 CPU
- API 环境：生产环境同域 `/api/v1/...` 访问（无 Vite Proxy）
- 编码：`UTF8JSONResponse`（`allow_nan=True`），前端用 `isFinite()` 处理非有限值
- APK 下载：SelectiveGZipMiddleware 跳过已压缩二进制文件的二次压缩

---

## 常见任务速查

| 任务 | 命令 |
|------|------|
| 启动后端开发 | `cd backend && python main.py` |
| 启动前端开发 | `cd frontend && npm run dev:web` |
| 前端构建 | `cd frontend && npm run build:vite` |
| 运行测试 | `cd backend && pytest -v` |
| 添加依赖 | 后端：编辑 `requirements.txt` → `.venv/bin/pip install -r requirements.txt` |
| 添加依赖 | 前端：`cd frontend && npm install <pkg>` |
| 后端系统服务 | `systemctl --user restart npt-backend` |
| 查看后端日志 | `journalctl --user -u npt-backend -n 50 --no-pager` |

---

## 文件上传数据格式

Excel 数据支持两种格式：

1. **新格式（推荐）**：`{ "LTE": [...], "NR": [...] }` — 按网络类型分工作表
   - 全量工参：工作表名 `LTE Project Parameters` / `NR Project Parameters`
   - 待规划小区：工作表名 `LTE` / `NR`

2. **旧格式**：`[...]` — 扁平列表，每条记录包含 `networkType` 字段

地理数据支持格式：`.xlsx`, `.csv`, `.txt`, `.tab`, `.mif`
自动识别图层类型：点状、扇区、多边形

---

## 前端技术栈速查

| 技术 | 用途 |
|------|------|
| React 18 + TypeScript | UI 框架 |
| Vite 5 | 构建工具 |
| Zustand | 状态管理 |
| Tailwind CSS | 样式框架 |
| Radix UI | 无头 UI 组件 (Dialog, Dropdown, Select, Tabs, Toast) |
| lucide-react | 图标库 |
| Leaflet + react-leaflet | 在线地图 |
| react-router-dom v6 | 路由 |
| i18next | 国际化 |
| vitest | 测试框架 |

---

## 添加新 API 端点的步骤

1. 在 `backend/app/api/v1/endpoints/` 创建新的端点文件
2. 在 `backend/app/api/v1/__init__.py` 注册路由（`api_router.include_router(...)`）
3. 在 `shared/types.ts` 添加对应的 TypeScript 类型
4. 在 `frontend/src/renderer/services/api.ts` 添加 API 调用函数
5. 如需持久化存储，添加 SQLAlchemy 模型并运行迁移
