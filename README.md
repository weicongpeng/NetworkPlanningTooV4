# NetworkPlanningTooV3 · 网优引擎

面向电信网络规划的一体化工具：工参数据管理、PCI / 邻区 / TAC 规划、地图可视化与图层制作，支持 Web 与 Android 双端。

> 部署入口：https://app.pengwc.asia

## 功能概览

### 规划算法

- **PCI 规划**：物理小区标识规划，支持碰撞 / 混淆检测，模 3、模 30 约束；结果可直接「应用到工参」
- **邻区规划**：基于覆盖圆的自动邻区关系规划，同频 / 异频分别按上限截断，候选按距离优先
- **TAC 核查与规划**：跟踪区域码核查与规划，支持异 TAC 孤岛（插花）检测，跳过小区显式提示

### 地图与图层

- **地图可视化**：在线（高德 / OSM）与离线地图，LTE / NR 扇区渲染，缩放级别自适应 LOD
- **专题与热力**：频点 / TAC / PCI 模着色、专题图层、按字段值插值的值热力面（IDW）
- **标签引擎**：统一标签布局引擎，屏幕空间防重叠
- **图层制作**：Excel 工参 → 点 / 扇区图层，导出 TAB / MIF / KML
- **图层编辑**：绘制、顶点编辑、吸附、测量、圈选、节点合并、逐要素样式、属性字段增改
- **图层工具**：条件选择（两图层按空间包含连接导出单表）、绘制缓冲区（测地线口径，each / dissolve）
- **搜索与导出**：Ctrl+F 跨图层搜索定位、图例浮窗、地图导出

### 数据管理

- 支持 Excel / CSV / TXT / TAB / MIF 上传，自动识别点状 / 扇区图层
- 全量工参导入（强制 ProjectParameter 前缀与工作表校验）、重复行检测
- 小区查询 / 批量更新 / 删除、新站录入，SQLite 单事务 + Excel 双写

### 平台能力

- 用户与权限体系（JWT + 权限位），管理员用户管理
- **数据组隔离**：按（地市 + 运营商）分组，数据归组所有，管理员同样按组隔离
- 网优助手：基于 LLM 的工参问答（Function Calling，只读查询）
- APP 版本管理：APK 分片上传与分发（绕过 Cloudflare 100MB 限制）
- 工具集：批量距离匹配、站间距计算、频点换算（LTE / NR / GSCN）
- 中英文双语、深浅色主题与多配色

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 18 · TypeScript · Vite 5 · Zustand · Tailwind CSS · Radix UI · lucide-react |
| 地图 | Leaflet · react-leaflet · 高德地图 |
| 后端 | FastAPI 0.115 · SQLAlchemy 2.0 · Pydantic 2 · Uvicorn |
| 数据 | SQLite（WAL，权威数据源）+ Excel 双写；geopandas / shapely / pyproj / pyogrio |
| 算法 | scikit-learn（BallTree）、numpy |
| 移动端 | Expo / React Native（`mobile-app/`） |
| 测试 | pytest（后端）· Vitest + Testing Library（前端） |

## 架构

```
浏览器 / mobile-app (Expo, JWT)
   │ HTTPS  app.pengwc.asia → cloudflared → localhost:8000
   ▼
FastAPI (backend/app/)
   ├─ /api/v1/*         REST 端点
   ├─ /api/v1/ws/tasks  WebSocket 任务进度推送
   ├─ /static           outputs/ 静态文件
   ├─ /layer-files      uploads/layers 图层文件
   └─ SPA 兜底          frontend/dist-renderer/index.html
        │
   services/     业务逻辑：数据 / 任务 / 图层 / 认证 / 助手
        │
   algorithms/   PCI、邻区、距离
        │
   存储：data/data.db (SQLite，权威) + data/<id>/original.xlsx (双写)
        + data/index.json (内存索引) + outputs/ + exports/ + uploads/
```

前端构建产物由后端以 SPA 方式同域托管，因此**没有独立的 Web 服务器**，前后端共用 8000 端口。

## 快速开始

### 环境要求

- Node.js 18+、npm
- Python 3.11+
- GDAL / geopandas（图层与地理数据处理；Windows 可用 `install_geopandas.bat` 或 `conda install -c conda-forge gdal`）

### 后端

```bash
cd backend
python -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python main.py                                       # http://127.0.0.1:8000
```

- API 文档：http://127.0.0.1:8000/docs
- 首次启动自动建库并创建默认管理员 `admin` / `admin123`（首次登录强制改密）

### 前端

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

开发模式下 Vite 代理 `/api`、`/layer-files` → `localhost:8000`，`/ws` → `ws://localhost:8000`。

### 配置

后端环境变量以 `NPT_` 为前缀，复制 `backend/.env.example` 为 `backend/.env` 后填写，常用项：

```bash
NPT_HOST=127.0.0.1
NPT_PORT=8000
NPT_JWT_SECRET_KEY=change-this-to-a-strong-random-key
NPT_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
NPT_AMAP_API_KEY=your_amap_api_key
NPT_SESSION_IDLE_TIMEOUT_MINUTES=180
NPT_MAX_TASKS=10
NPT_TASK_TIMEOUT=3600
```

网优助手另需 `NPT_LLM_BASE_URL` / `NPT_LLM_API_KEY` / `NPT_LLM_MODEL`（OpenAI 兼容协议）。

## 构建与部署

生产环境为 Linux + systemd + Cloudflare Tunnel。

```bash
# 1. 构建前端
cd frontend && npm run build:vite        # 产物 frontend/dist-renderer/

# 2. 重启后端（后端代码改动 / 前端构建后均需执行）
systemctl restart npt-backend
```

- systemd 单元 `/etc/systemd/system/npt-backend.service`：`ExecStart=.../backend/.venv/bin/python3 main.py`，`NPT_RELOAD=false`，`MemoryMax=2G`
- 日志：`journalctl -u npt-backend -n 100 --no-pager` 或 `tail -f /var/log/npt-backend.log`
- 详细步骤见 `NetworkPlanningTooV3-部署指南.md`、`NetworkPlanningTooV3-linux服务器版本部署指南.md`

## 测试

```bash
# 后端
cd backend && python -m pytest tests/ -v

# 前端
cd frontend && npm run test              # vitest run
cd frontend && npm run type-check        # tsc --noEmit
cd frontend && npm run lint              # eslint
```

`scripts/run-tests.sh` 可依次执行前后端测试。

## 项目结构

```
NetworkPlanningTooV3/
├── backend/                  # FastAPI 后端
│   ├── app/
│   │   ├── api/v1/endpoints/ # REST 端点（19 个模块）
│   │   ├── services/         # 业务逻辑（数据/任务/图层/认证/助手）
│   │   ├── algorithms/       # PCI、邻区、距离算法
│   │   ├── models/           # SQLAlchemy 表 + Pydantic 模型
│   │   ├── core/             # 配置、数据库、安全、数据组鉴权
│   │   └── utils/            # 坐标转换、Excel、几何工具
│   ├── tests/                # pytest
│   └── main.py
├── frontend/                 # Vite + React 前端
│   ├── src/renderer/
│   │   ├── pages/            # 页面组件
│   │   ├── components/Map/   # 地图与图层编辑（41 个源文件）
│   │   ├── store/            # Zustand 状态（16 个）
│   │   ├── services/         # API 封装与地图数据服务
│   │   ├── utils/            # 坐标、配色、热力场等纯函数
│   │   └── locales/          # zh.json / en.json
│   └── dist-renderer/        # 构建产物（由后端托管）
├── mobile-app/               # Expo / React Native 移动端（独立工程）
├── shared/types.ts           # 前后端共享类型
├── data/                     # SQLite 主库、上传文件、索引
├── docs/plans/               # 设计与实施文档（按日期）
└── scripts/                  # 构建与测试脚本
```

## 开发约定

- **坐标系**：前端渲染与图层编辑使用 GCJ02，后端持久化 WGS84，跨端按既有链路转换
- **数据组隔离**：所有数据查询/写入路径必须接组门禁（`services/data_group.py`、`core/data_access.py`），管理员同样按组隔离
- **多语言**：UI 文本一律用 `t()`，新增 key 需同时更新 `locales/zh.json` 与 `en.json`
- **提交规范**：GitHub Flow（禁止直接提交 / 强推 main），Conventional Commits，原子提交
- 完整的架构说明与开发约束见 `CLAUDE.md` 与 `CODEBUDDY.md`

## 文档

| 文档 | 内容 |
|------|------|
| `CLAUDE.md` / `CODEBUDDY.md` | 代码架构、常用命令、开发约束 |
| `AGENTS.md` | 协作与技术规范 |
| `NetworkPlanningTooV3-部署指南.md` | 部署指南 |
| `NetworkPlanningTooV3-linux服务器版本部署指南.md` | Linux 服务器部署 |
| `docs/plans/` | 各功能设计与实施文档 |
| `docs/LICENSE_GUIDE.md` | 许可证说明 |
