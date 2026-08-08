# 图层文件导入后地图渲染修复设计

**日期**: 2026-08-08
**分支**: layer-tools
**范围**: 数据管理的图层文件（压缩包）导入后，地图工具渲染的三个问题修复

---

## 1. 问题与根因

### 1.1 勾选图层半天不渲染（渲染效率）

**现象**: 图层压缩包导入后能在地图工具加载，但勾选对应图层时长时间渲染不出图形。

**根因**:
1. 地图挂载时 `loadMapInfoLayers()`（`OnlineMap.tsx:4906`）**串行** `await loadMapInfoLayer` 逐个加载所有图层（`:2762`），即使图层未勾选也全量构建 `MapInfoLayer`（`:2714`），只是不 `addTo`。
2. 每个图层首次加载：`layerApi.getLayerData` 拉数据 -> `MapInfoLayer.fromGeoJSON`（`:498`）对**所有要素**做同步坐标转换 `transformFeatureCoordinatesOptimized`（`:505`）+ 构建 `L.geoJSON`，全部在**主线程**阻塞。要素多时卡死 UI。
3. `mapDataCacheStore`（`store/mapDataCacheStore.ts`）的 `LayerCacheEntry` 只缓存 `bounds`，**不缓存转换后的 GeoJSON**，切页回来重算。

### 1.2 元素颜色不一致

**现象**: 图层文件渲染后，部分要素颜色不一致。

**根因**: `mapinfo_service.py` 的三层样式回退产生图层内异色：
1. `_infer_style_from_properties`（`:247`）**按要素属性关键词**分配不同颜色（水=蓝 `:330`、绿地=绿 `:339`、建筑=橙 `:348`、居民=黄 `:357`、商业=粉 `:366`、工业=靛 `:375`…），同一图层内要素颜色本就不同。
2. MapInfo `Pen`/`Symbol` 解析器（`_parse_style_value:128`）期望 `width,r,g,b,pattern` 多段逗号格式，但 GDAL/MIF 输出的是 `width,pattern,color_int` 单整数颜色（如 `16777215`=白）。单整数解析失败 -> `style` 为空 -> 回退到 `_infer_style_from_properties` 按属性分色 -> 颜色更乱。

### 1.3 WGS84 坐标位置偏移

**现象**: 加载的图层要素经纬度是 WGS84 坐标系，渲染后在高德地图上位置明显偏移。数据确认为外部真正的 WGS84 源。

**根因（待诊断确认）**: 转换代码**已存在**却仍偏移，运行时转换未正确生效：
- 压缩包路径：后端 `get_layer_data`（`mapinfo_service.py:1117` `_convert_to_geojson(transform_coords=False)`）发送原始 WGS84，前端 `MapInfoLayer.fromGeoJSON`（`:505`）做 WGS84->GCJ02。
- 数据为真 WGS84 却偏移，最可能断点：后端 `gpd.read_file`（`mapinfo_service.py:705`）未强制 CRS/未 `to_crs(epsg=4326)`，若 TAB/MIF 声明了非 WGS84 投影，坐标被读入时已偏移，前端再转一次仍错；或某几何类型（Polygon 嵌套环、MultiGeometry）前端转换未递归覆盖。

---

## 2. 修复方案（已确认）

### 2.1 渲染效率 -- 后端预转换 + 懒加载 + 缓存（问题1方案A）

**核心决策：坐标转换统一在后端做**（问题1与问题3协同，避免双重转换）。

1. **后端 `get_layer_data` 返回已转 GCJ02 的 GeoJSON**：
   - `_convert_to_geojson`（`mapinfo_service.py:1117`）改为 `transform_coords=True`（默认）。
   - 用已有的 `CoordinateTransformer.transform_geojson_coordinates`（`coordinate_transformer.py:211`）转换所有要素坐标。
   - 前端 `MapInfoLayer.fromGeoJSON`（`:505`）**移除** `transformFeatureCoordinatesOptimized` 调用，直接用转换后数据。

2. **前端懒加载**：
   - 地图挂载时**不再全量构建所有 MapInfoLayer**。`loadMapInfoLayers` 仅 `getLayerData` 拉取并缓存到 `mapDataCacheStore`，不立即 `fromGeoJSON`。
   - 首次勾选时才 `fromGeoJSON` 构建（此时数据已转好，构建快）。

3. **缓存转换后 GeoJSON**：
   - `mapDataCacheStore` 的 `LayerCacheEntry` 新增 `geojson` 字段，缓存后端返回的已转 GeoJSON。
   - 切页回来命中缓存直接构建，不重新拉取/转换。

4. **并发加载**：
   - `loadMapInfoLayers`（`OnlineMap.tsx:2755`）串行 `for await` 改并发（`Promise.all` + 限流，避免一次几十个请求）。

### 2.2 颜色一致性 -- 统一默认色 + 修复 Pen 解析（问题2方案A）

**决策：无样式要素全部统一一个默认色；仅文件自带样式正确解析后显示彩色。**

1. **废弃按属性关键词分色**：
   - `_infer_style_from_properties`（`mapinfo_service.py:247`）移除水/绿地/建筑/居民/商业/工业/道路类型等按属性分色逻辑，统一返回 `None`（无样式）。
   - 无样式要素由前端 `MapInfoLayer` 的 `DEFAULT_STYLES`（`MapInfoLayer.tsx:77`）统一着色（点 `#f59e0b`、线 `#8b5cf6`、面 `#10b981`）。

2. **修复 MapInfo `Pen`/`Symbol` 单整数颜色解析**（`mapinfo_service.py:128 _parse_style_value`）：
   - MapInfo 颜色是 24-bit 整数（BGR 顺序：`B*65536 + G*256 + R`），当前误按 `r,g,b` 三段解析。
   - 改为：识别 `Pen(width, pattern, color_int)` 三段格式，将 `color_int` 按 `R = int & 255, G = (int >> 8) & 255, B = (int >> 16) & 255` 还原成 `#rrggbb`。
   - `Brush(pattern, forecolor, backcolor)`、`Symbol(shape, color, size)` 同理修复单整数颜色。
   - 文件自带样式解析正确后，要素显示文件原色；解析失败的回退到统一默认色。

### 2.3 坐标偏移 -- 先诊断断点再针对性修复（问题3方案A）

**决策：先实测定位断点，再修；与问题1协同，后端统一做转换。**

1. **诊断步骤**（取一个已知偏移的图层文件）：
   - 对比三组坐标：后端 `get_layer_data` 返回的原始坐标、（启用后端转换后）转换后坐标、要素实际应在高德底图的位置。
   - 判断：后端 `gpd.read_file` 读入是否已偏移（CRS 问题）？转换是否生效？

2. **按断点修复**：
   - **若后端 CRS 问题**：`parse_file`（`mapinfo_service.py:705`）`gpd.read_file` 后加 `gdf = gdf.to_crs(epsg=4326)` 归一到 WGS84 经纬度，再由 2.1 的后端转换转 GCJ02。
   - **若前端转换漏几何类型**：因 2.1 已改为后端转换，前端转换代码移除，此分支自动消除；但需确保后端 `transform_geojson_coordinates` 对 Polygon 嵌套环、MultiGeometry 递归覆盖（已实现，`coordinate_transformer.py:211` 递归处理）。
   - **若双重转换**：增加坐标系标识字段，已知 GCJ02 数据跳过转换。

3. **与 2.1 协同**：2.1 已决定后端做转换（`transform_coords=True`），前端不转。2.3 的诊断结果决定后端转换的输入是否需要先 `to_crs(4326)` 归一。

---

## 3. 影响文件

| 文件 | 改动 |
|------|------|
| `backend/app/services/mapinfo_service.py` | `_convert_to_geojson` 默认 `transform_coords=True` 并实际转换；`_parse_style_value` 修复单整数颜色解析；`_infer_style_from_properties` 移除按属性分色；`parse_file` 按诊断结果加 `to_crs(4326)` |
| `frontend/src/renderer/components/Map/MapInfoLayer.tsx` | `fromGeoJSON` 移除前端坐标转换（`:505`）；样式应用保持现有 feature._style 优先 + DEFAULT_STYLES 回退 |
| `frontend/src/renderer/components/Map/OnlineMap.tsx` | `loadMapInfoLayers` 改并发 + 懒加载（挂载不构建未勾选图层，仅拉取缓存）；首次勾选才 `fromGeoJSON` |
| `frontend/src/renderer/store/mapDataCacheStore.ts` | `LayerCacheEntry` 新增 `geojson` 字段缓存后端返回的已转 GeoJSON |
| `backend/tests/test_layer_service.py` / `test_geo_field_detector.py` | 新增/更新：后端转换断言、单整数颜色解析断言、分色移除断言 |

---

## 4. 验证

### 4.1 问题1 -- 渲染效率
- 导入一个含大量要素（>1000）的图层压缩包，勾选图层后**秒级出图**（目标 <1s）。
- 切换到其他页面再切回地图，已勾选图层立即显示（命中缓存，不重新拉取/转换）。
- 地图挂载时 UI 不卡顿（未勾选图层不阻塞主线程）。

### 4.2 问题2 -- 颜色一致
- 同一图层内所有无样式要素颜色**完全一致**（点全橙、线全紫、面全绿）。
- 文件自带样式的要素显示文件原色（Pen 单整数颜色正确还原）。
- 不同图层无样式要素都用同一默认色（按确认：全部统一默认色）。

### 4.3 问题3 -- 坐标准确
- 外部 WGS84 图层要素在高德底图上位置准确，与工参扇区图、底图道路对齐，无偏移。
- 诊断报告记录断点位置与修复依据。

### 4.4 回归
- 后端测试全绿（新增转换、颜色解析断言）。
- 前端 `npx tsc --noEmit` 无新错误、`npm run build:vite` 成功。
- 既有图层（数据管理导入的点/扇区/多边形，走 `geo_data_service` 路径）渲染不受影响。

---

## 5. 实施顺序

1. **问题3诊断**（先做，结果决定后端转换输入是否需 `to_crs`）。
2. **问题2颜色修复**（后端独立改动，与问题1无耦合）。
3. **问题1+3后端转换**（`_convert_to_geojson` 转换 + 诊断修复，问题1和3在此合并）。
4. **问题1前端懒加载+缓存**。
5. **测试与验证**。

---

## 6. 风险

- **坐标系盲改风险**: 问题3若不诊断直接改 `to_crs`，可能在无 CRS 声明的经纬度数据上报错或无操作，引入新偏移。诊断先行可规避。
- **双重转换**: 问题1改后端转换后，若遗漏移除前端 `transformFeatureCoordinatesOptimized`，会双重偏移。需确保前端转换调用点全部移除。
- **颜色回归**: 移除按属性分色后，依赖该着色的用户可能不适应。但用户已确认要统一默认色，可接受。
