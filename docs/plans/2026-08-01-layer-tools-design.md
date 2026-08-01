# 图层制作功能设计文档

**日期**: 2026-08-01
**状态**: 已确认
**模块**: 实用工具 / 图层制作（扇区图层、点图层）

## 1. 需求概述

在应用侧边栏"地图工具"下方新增"实用工具"菜单，其下新增"图层制作"功能，并根据导入的 Excel 工参文件创建 tab / mif / kml 格式的扇区图层和点图层。

### 功能要点
1. **入口**: 侧边栏"实用工具"分组下新增"图层制作"，同时加入首页卡片。
2. **两个页面**: 扇区图层制作页面、点图层制作页面。
3. **交互流程**: Excel 导入 → sheet 选择（单选）→ 加载列名并勾选 → 自动匹配关键字 → 参数设置 → 生成下载。
4. **生成方式**: 后端统一生成，保存到后端 uploads 目录，前端提供下载链接（生产部署为网页应用，无法直接写本地磁盘路径）。
5. **坐标系**: 输入 Excel 的经纬度为 WGS84 (EPSG:4326)。
6. **国际化**: 所有模块中英文翻译不遗漏。

## 2. 技术方案调研

| 方案 | 原理 | 性能实测 | 结论 |
|------|------|---------|------|
| **A. pyogrio + geopandas（推荐）** | pyogrio 内置预编译 GDAL/OGR 绑定，无需安装 GDAL 二进制，直接读写 MapInfo/KML | 1 万扇区 生成 0.82s + 写入 TAB 0.12s | ✅ 最快、零额外依赖（已在环境内） |
| B. 手写 TAB/MIF 文本模板 | 自行拼接 MapInfo 文本格式 | 中等 | ❌ 需处理 DAT/ID/MAP 二进制副文件、坐标表、样式语法，易出错 |
| C. 调用外部工具（MapInfo/QGIS） | 依赖桌面软件或 CLI | 慢、需安装 | ❌ 不适合 Web 部署 |

**推荐方案 A**：本项目 `backend/.venv` 已安装 `geopandas + shapely + pyogrio`，直接 `gdf.to_file(path, driver='MapInfo File'/'KML')` 写入，纯 C 实现效率最高。扇区几何用与前端 `SectorRendererSVG._fastDestination` 相同的 Flat-Earth 近似算法移植到后端。

**性能实测**（Python 3，本机）：
- 生成 10,000 个扇形多边形: 0.824s（12,132 个/秒）
- 写入 10,000 个扇区到 TAB: 0.119s

## 3. 总体架构

```
前端 (React)                          后端 (FastAPI)
┌─────────────────────────┐          ┌───────────────────────────────┐
│ 侧边栏"实用工具"分组        │          │ POST /api/v1/layer/sector     │
│  └─ "图层制作" → 两个页面   │          │ POST /api/v1/layer/point      │
│ 扇区图层制作页面            │──HTTP──▶│ POST /api/v1/layer/excel-info │
│ 点图层制作页面              │          │ (读取sheet/列信息)              │
│ (Excel导入/Sheet选择/      │          │        │                      │
│  列勾选/参数设置/生成)      │          │        ▼                      │
└─────────────────────────┘          │ LayerService (pyogrio写入)    │
                                     │  ├─ 读Excel(calamine引擎)      │
首页卡片新增"图层制作"           │  ├─ 字段检测(GeoFieldDetector)  │
                                     │  ├─ 扇区/点几何生成             │
                                     │  └─ to_file → uploads/layers/   │
                                     └───────────────────────────────┘
```

- 新增页面路由：`/layer/sector`（扇区图层）、`/layer/point`（点图层）
- 新增后端模块：`layer.py`（端点）+ `layer_service.py`（业务）
- 保存位置：统一 `backend/uploads/layers/`

## 4. 前端设计

### 4.1 侧边栏 + 首页入口

- **侧边栏** (`MainLayout.tsx`)：在地图工具下方新增分组 `实用工具`（key: `nav.tools`），子项 `图层制作`（key: `nav.layerTools`），图标 `Wrench`。
- **首页卡片** (`HomePage.tsx`)：新增 `FeatureCard`，标题 `图层制作`，跳转 `/layer/sector`，图标 `Wrench`，蓝紫色。

### 4.2 扇区图层页面 `/layer/sector`

单页向导式，从上到下四步：

1. **Excel 工参导入栏**：拖拽/点击上传（复用 DataPage 导入样式）。
2. **数据源选择**：Sheet 下拉（单选）+ 数据预览表格（前 5 行）。
3. **图层属性设置**：
   - 列名复选框列表（全部列，勾选 = 纳入图层属性）
   - 自动匹配关键字：标签名称 / 经度 / 纬度 / 方向角（下拉，默认自动匹配，可改）
   - 参数设置：半径(m)、填充颜色(取色器)、波瓣夹角°(默认 40)、输出格式(tab/mif/kml)
4. **生成按钮** → 成功后弹出文件下载（后端返回下载 URL）。

### 4.3 点图层页面 `/layer/point`

结构同上，差异：
- 属性映射只需 标签名称 / 经度 / 纬度。
- 参数为 点大小(px)、填充颜色、输出格式(tab/mif/kml)。

### 4.4 组件拆分

- 新建 `pages/LayerSectorPage.tsx`、`pages/LayerPointPage.tsx`（骨架相同，参数配置不同）。
- 复用 `UploadArea` 导入样式、`LoadingSpinner`（已存在）。
- 抽公共组件 `components/layer/LayerAttributeConfig.tsx`（列勾选 + 关键字匹配）。

## 5. 后端设计

### 5.1 新增端点 `backend/app/api/v1/endpoints/layer.py`

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/v1/layer/excel-info` | POST | 上传 Excel → 返回 `{sheets: [], columns: {sheet名: 列名[]}}`（不落库） |
| `/api/v1/layer/sector` | POST | 生成扇区图层（multipart: file + 配置 JSON） |
| `/api/v1/layer/point` | POST | 生成点图层 |

注册方式：在 `backend/app/api/v1/__init__.py` 中 `api_router.include_router(layer.router, prefix="/layer", tags=["图层制作"])`。

### 5.2 新增服务 `backend/app/services/layer_service.py`

```
generate_sector_layer(file, config) -> {file_url}
  1. pd.ExcelFile(engine='calamine') 读指定 sheet
  2. 校验经/纬度列数值合法（复用 GeoFieldDetector.validate_coordinates）
  3. 对每行用 Flat-Earth 算法生成楔形 Polygon（角度: 方向角±夹角/2，半径转米）
  4. 构建 GeoDataFrame(geometry=扇区Polygon, crs=EPSG:4326, 属性=勾选列)
  5. gdf.to_file(uploads/layers/xxx.tab/.mif/.kml, driver=MapInfo File/KML)

generate_point_layer(file, config) -> {file_url}
  1-2 同上；3. 点 = Point(lng, lat)；4-5 同上（driver 同扇区）
```

- **WGS84**：直接 `crs='EPSG:4326'`。
- **样式**：MapInfo 图层样式由用户在 MapInfo/QGIS 中设置，后端不嵌入颜色（简化）；KML 用 `Icon`/`Style` 支持颜色点标记（可选增强）。
- **性能**：10 万行以内秒级完成；大文件用 `run_in_threadpool` 包裹（与现有模式一致）。
- **错误处理**：GBK 安全处理（项目规范）、坐标无效返回 400 含示例数据。

### 5.3 扇区几何算法（Flat-Earth 近似）

移植自 `frontend/src/renderer/components/Map/SectorRendererSVG.tsx`：

```python
import numpy as np

def fast_destination(lat, lng, azimuth_deg, distance_m):
    """快速计算终点坐标 (Flat-Earth Approximation)"""
    rad = azimuth_deg * np.pi / 180
    meters_per_lat = 111319.9
    meters_per_lng = 111319.9 * np.cos(np.radians(lat))
    dlat = distance_m * np.cos(rad) / meters_per_lat
    dlng = distance_m * np.sin(rad) / meters_per_lng
    return lat + dlat, lng + dlng

def sector_polygon(lat, lng, azimuth, beamwidth, radius_m, arc_points=30):
    """生成扇形多边形（楔形）"""
    half = beamwidth / 2
    start, end = azimuth - half, azimuth + half
    pts = [(lat, lng)]
    for i in range(1, arc_points):
        a = start + (end - start) * i / arc_points
        pts.append(fast_destination(lat, lng, a, radius_m))
    pts.append(fast_destination(lat, lng, end, radius_m))
    pts.append((lat, lng))
    return Polygon(pts)
```

### 5.4 翻译文件

新增 key 到 `zh.json` + `en.json`（需求6）：
- `nav.tools`（实用工具）、`nav.layerTools`（图层制作）
- `layer.*`：导入、sheet 选择、列勾选、关键字匹配、参数设置、生成、下载等全部文案。

## 6. 数据流与错误处理

**生成流程**：选文件 → 后端解析 sheet/列 → 前端勾选配置 → POST 生成 → 返回文件 → 前端展示下载链接。

**错误场景**：
- 无经纬度列 → 400 + 提示
- 坐标无效（<50% 有效）→ 400 + 示例数据
- 文件非 Excel → 400
- sheet 不存在 → 400
- 生成失败 → 500

**下载方式**：FastAPI 返回 `FileResponse` 或前端 `apiClient.get(url, {responseType:'blob'})`。

## 7. 测试计划

- **后端**：pytest 测试 `layer_service`（点/扇区/三种格式各生成一次，断言文件存在 + 可被 `geopandas.read_file` 读回、坐标正确）。
- **前端**：type-check + 手动验证页面流程。

## 8. 范围外（YAGNI）

- 多 sheet 批量生成（当前单选 sheet，可重复操作分别生成）
- 图层样式内嵌颜色到 MapInfo 格式（由用户后续在 MapInfo/QGIS 中设置）
- MIF 与 TAB 差异样式处理
- Electron 本地路径直接写入（生产为网页应用）
