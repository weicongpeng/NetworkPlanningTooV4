# 图层文件地图渲染修复实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复图层压缩包导入地图工具后的三个问题：勾选渲染慢、元素颜色不一致、WGS84坐标偏移。

**Architecture:** 坐标转换统一在后端做（问题1与3协同），前端只负责渲染。后端 `get_layer_data` 返回已转 GCJ02 的 GeoJSON；前端懒加载 + 缓存转换后数据。颜色上：无样式要素统一默认色，并修复 MapInfo `Pen`/`Symbol` 单整数颜色解析。坐标偏移先诊断断点再修。

**Tech Stack:** FastAPI (Python/geopandas/shapely), React 18 + Leaflet + TypeScript, Zustand, pytest。

**设计文档:** `docs/plans/2026-08-08-layer-rendering-fix-design.md`

---

## 阶段0：建立测试基线（先跑通现有测试）

**Files:**
- Test: `backend/tests/`（现有测试）

**Step 1: 确认现有测试通过**

Run: `cd backend && python -m pytest tests/test_layer_service.py tests/test_geo_field_detector.py -q`
Expected: 全部 PASS。若失败，先修复基线的环境问题（geopandas/shapely mock 已由 conftest 提供）。

**Step 2: 记录基线**

如果有失败，记录具体失败项，在后续改动前先解决，避免污染本次改动判断。

---

## Task 1: 问题3诊断 —— 定位 WGS84 偏移断点

**目的:** 在写任何修复代码前，先实测确认偏移到底发生在后端读入还是前端转换。这是问题3修复的前提，也决定后端转换是否需要先 `to_crs(4326)`。

**Files:**
- Create: `backend/tests/test_mapinfo_style.py`（含诊断用测试）
- Inspect: `backend/app/services/mapinfo_service.py:705`（`gpd.read_file`）、`:1117`（`_convert_to_geojson`）

**Step 1: 确认后端 `_convert_to_geojson` 当前坐标行为**

写一个诊断测试，验证 `_convert_to_geojson(transform_coords=True)` 实际会转换坐标（用已知偏移点验证）：

```python
# backend/tests/test_mapinfo_style.py
from app.services.mapinfo_service import _convert_to_geojson, MapInfoLayer, MapInfoFeature, GeometryType

def test_convert_to_geojson_transform_coords_true():
    """transform_coords=True 时坐标被 WGS84→GCJ02 转换"""
    layer = MapInfoLayer(
        id="t1", name="diag", type=GeometryType.POINT,
        features=[MapInfoFeature(id="f1", type=GeometryType.POINT,
                                 coordinates=[116.397, 39.908],  # 北京天安门 WGS84
                                 properties={})],
    )
    out = _convert_to_geojson(layer, transform_coords=True)
    gcj = out["features"][0]["geometry"]["coordinates"]
    # 转换后应偏离 WGS84（GCJ02 在北京约偏移 ~550m，经度/纬度皆有变化）
    assert gcj[0] != 116.397 or gcj[1] != 39.908
```

**Step 2: 运行诊断测试**

Run: `cd backend && python -m pytest tests/test_mapinfo_style.py::test_convert_to_geojson_transform_coords_true -v`
Expected: FAIL（当前 `transform_coords` 参数接了但未实际转换，`_convert_to_geojson` 循环里坐标直接透传）。**这个 FAIL 即证明断点在转换未生效。**

**Step 3: 记录诊断结论到设计文档**

在 `docs/plans/2026-08-08-layer-rendering-fix-design.md` 的 2.3 节补充实测结论：转换代码存在但 `_convert_to_geojson` 未真正执行转换（参数未接线）。若实际手感是"即使前端转换了仍偏"，则需再确认后端 `gpd.read_file` 读入的 CRS——可在 task 执行时用真实图层文件跑一次 `gdf.crs` 打印确认。

**Step 4: Commit**

```bash
git add backend/tests/test_mapinfo_style.py
git commit -m "test: 诊断图层坐标转换断点（transform_coords未接线）"
```

> 注：此测试会 FAIL，属于诊断步骤。Task 2 修复后该测试转绿。

---

## Task 2: 后端 `_convert_to_geojson` 实际执行坐标转换（问题1+3核心）

**Files:**
- Modify: `backend/app/services/mapinfo_service.py:1117-1165`（`_convert_to_geojson`）
- Test: `backend/tests/test_mapinfo_style.py`

**Step 1: 写失败测试 —— 验证 Point/Line/Polygon 三类几何都转换**

```python
def test_convert_to_geojson_transforms_all_geometry_types():
    """Point/LineString/Polygon 坐标全部被 WGS84→GCJ02 转换"""
    layer = MapInfoLayer(
        id="t2", name="diag2", type=GeometryType.POLYGON,
        features=[
            MapInfoFeature(id="p", type=GeometryType.POINT, coordinates=[116.397, 39.908], properties={}),
            MapInfoFeature(id="l", type=GeometryType.LINE, coordinates=[[116.397, 39.908], [116.398, 39.909]], properties={}),
            MapInfoFeature(id="poly", type=GeometryType.POLYGON,
                           coordinates=[[[116.397, 39.908], [116.398, 39.908], [116.398, 39.909], [116.397, 39.908]]],
                           properties={}),
        ],
        type=GeometryType.POLYGON,
    )
    out = _convert_to_geojson(layer, transform_coords=True)
    for f in out["features"]:
        geojson = f["geometry"]["coordinates"]
        # 递归取第一个坐标对
        stack = [geojson]
        first = None
        while stack:
            c = stack.pop()
            if isinstance(c, list) and c and isinstance(c[0], (int, float)):
                first = c
                break
            if isinstance(c, list):
                stack.extend(c)
        assert first[0] != 116.397 or first[1] != 39.908, f"geometry {f['geometry']['type']} 未转换"
```

**Step 2: 运行测试确认失败**

Run: `cd backend && python -m pytest tests/test_mapinfo_style.py -v`
Expected: FAIL（坐标透传未转换）。

**Step 3: 实现 —— `_convert_to_geojson` 接线转换**

修改 `_convert_to_geojson`（`mapinfo_service.py:1117`）：

```python
def _convert_to_geojson(layer: MapInfoLayer, transform_coords: bool = True) -> Dict:
    """
    将 MapInfo 图层转换为 GeoJSON 格式

    坐标转换统一在后端进行（transform_coords=True 默认），
    前端不再做 WGS84→GCJ02，避免双重转换导致偏移。

    Args:
        layer: MapInfo 图层
        transform_coords: 是否转换坐标（默认True，后端统一转换）
    """
    from app.utils.coordinate_transformer import CoordinateTransformer

    features = []

    for feature in layer.features:
        geometry = {}
        coordinates = feature.coordinates

        if transform_coords:
            coordinates = CoordinateTransformer.transform_geojson_coordinates(coordinates)

        if feature.type == GeometryType.POINT:
            geometry = {"type": "Point", "coordinates": coordinates}
        elif feature.type == GeometryType.LINE:
            geometry = {"type": "LineString", "coordinates": coordinates}
        elif feature.type == GeometryType.POLYGON:
            geometry = {"type": "Polygon", "coordinates": coordinates}

        features.append({
            "type": "Feature",
            "geometry": geometry,
            "properties": feature.properties
        })

    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "name": layer.name,
            "layerType": layer.type.value
        }
    }
```

> 注意：`transform_geojson_coordinates`（`coordinate_transformer.py:211`）已递归处理嵌套坐标（Polygon 环、MultiGeometry），无需额外改动。

**Step 4: 运行测试确认通过**

Run: `cd backend && python -m pytest tests/test_mapinfo_style.py -v`
Expected: PASS（Point/Line/Polygon 全部转换）。

**Step 5: 回归 —— 确认默认行为是转换**

Run: `cd backend && python -m pytest tests/test_mapinfo_style.py -q`
Expected: PASS。

**Step 6: Commit**

```bash
git add backend/app/services/mapinfo_service.py backend/tests/test_mapinfo_style.py
git commit -m "fix: 后端 get_layer_data 统一做 WGS84→GCJ02 坐标转换"
```

---

## Task 3: 修复 MapInfo 单整数颜色解析（问题2）

**Files:**
- Modify: `backend/app/services/mapinfo_service.py:128-222`（`_parse_style_value`）
- Test: `backend/tests/test_mapinfo_style.py`

**背景:** MapInfo 颜色是 24-bit 整数（BGR 顺序），GDAL/MIF 输出 `Pen(width, pattern, color_int)` 三段，当前解析器误按 `r,g,b` 多段逗号解析，导致单整数颜色解析失败 → 回退到按属性分色。

**Step 1: 写失败测试 —— 单整数颜色还原**

```python
def test_parse_pen_single_integer_color():
    """Pen(width, pattern, color_int) 单整数颜色按 BGR 还原为 #rrggbb"""
    style = MapInfoParser._parse_style_value("Pen", "1,2,16711680")  # 16711680 = 0x00FF0000 → BGR: R=0,G=0,B=255 → #0000ff
    assert style is not None
    assert style["strokeColor"] == "#ff0000"  # 需按实际 BGR 约定断言，执行时用真实值校准
    assert style["strokeWidth"] == 1.0
```

> 执行时：先确认 `CoordinateTransformer` 或现有代码对 MapInfo 颜色整数的位序约定。MapInfo 标准：`color = R + G*256 + B*65536`（低位 R）。`16711680` 应还原为 `#0000ff`。断言值以实际还原结果为准，但**必须**验证单整数路径被正确解析（而非解析失败返回 None）。

**Step 2: 运行测试确认失败**

Run: `cd backend && python -m pytest tests/test_mapinfo_style.py::test_parse_pen_single_integer_color -v`
Expected: FAIL（当前解析 `len(parts)>=4` 才读颜色，三段输入 `"1,2,16711680"` 走不到颜色分支，`strokeColor` 缺失）。

**Step 3: 实现 —— 支持单整数颜色**

在 `_parse_style_value` 的 PEN 分支（`mapinfo_service.py:151`）增加单整数颜色识别：

```python
# 解析 PEN (线样式)
if 'pen' in style_type_lower:
    parts = value_str.split(',')
    if len(parts) >= 2:
        try:
            result['stroke'] = True
            result['strokeWidth'] = float(parts[0]) if parts[0] else 1
            # MapInfo Pen 两种格式：
            #  1) width,pattern,color_int  (GDAL/MIF 三段，color 为 24-bit BGR 整数)
            #  2) width,r,g,b,pattern      (多段 RGB)
            if len(parts) >= 3:
                color_int = int(parts[2])
                # MapInfo BGR: R + G*256 + B*65536
                r = color_int & 255
                g = (color_int >> 8) & 255
                b = (color_int >> 16) & 255
                result['strokeColor'] = f'#{r:02x}{g:02x}{b:02x}'
            elif len(parts) >= 4:
                r = int(parts[1]); g = int(parts[2]); b = int(parts[3])
                result['strokeColor'] = f'#{r:02x}{g:02x}{b:02x}'
            if len(parts) >= 5:
                result['strokeDasharray'] = MapInfoParser._get_dash_pattern(int(parts[4]) if parts[4].isdigit() else 1)
        except (ValueError, IndexError):
            pass
```

> BRUSH / SYMBOL 分支同理支持单整数颜色（执行时按相同 BGR 约定处理）。BRUSH 的 `Brush(pattern, forecolor, backcolor)`、SYMBOL 的 `Symbol(shape, color, size)` 中 color 为单整数时走 BGR 还原。

**Step 4: 运行测试确认通过**

Run: `cd backend && python -m pytest tests/test_mapinfo_style.py -v`
Expected: PASS。

**Step 5: Commit**

```bash
git add backend/app/services/mapinfo_service.py backend/tests/test_mapinfo_style.py
git commit -m "fix: MapInfo Pen/Brush/Symbol 单整数颜色按 BGR 还原"
```

---

## Task 4: 移除按属性关键词分色（问题2）

**Files:**
- Modify: `backend/app/services/mapinfo_service.py:247-419`（`_infer_style_from_properties`）
- Test: `backend/tests/test_mapinfo_style.py`

**Step 1: 写失败测试 —— 属性不再产生异色**

```python
def test_infer_style_from_properties_returns_none():
    """按属性关键词分色已废弃，无显式样式时返回 None（统一默认色）"""
    import pandas as pd
    row = pd.Series({"name": "某水域公园绿地建筑", "geometry": None})
    style = MapInfoParser._infer_style_from_properties(row, GeometryType.POLYGON)
    assert style is None  # 不再按 '水'/'绿地'/'建筑' 分色
```

**Step 2: 运行测试确认失败**

Run: `cd backend && python -m pytest tests/test_mapinfo_style.py::test_infer_style_from_properties_returns_none -v`
Expected: FAIL（当前返回 `{'fill':'绿色'...}` 等异色）。

**Step 3: 实现 —— 直接返回 None**

将 `_infer_style_from_properties`（`mapinfo_service.py:247`）函数体替换为：

```python
@staticmethod
def _infer_style_from_properties(row: Any, geom_type: GeometryType) -> Optional[Dict[str, Any]]:
    """
    从属性值推断样式（已废弃按属性关键词分色）

    统一由前端 DEFAULT_STYLES 着色，保证同一图层内颜色一致。
    保留函数签名以兼容调用方，直接返回 None。
    """
    return None
```

**Step 4: 运行测试确认通过 + 回归**

Run: `cd backend && python -m pytest tests/test_mapinfo_style.py -v`
Expected: PASS。

Run: `cd backend && python -m pytest tests/test_layer_service.py tests/test_geo_field_detector.py -q`
Expected: 全部 PASS（确认未破坏现有图层创建测试）。

**Step 5: Commit**

```bash
git add backend/app/services/mapinfo_service.py backend/tests/test_mapinfo_style.py
git commit -m "fix: 废弃按属性关键词分色，无样式要素统一默认色"
```

---

## Task 5: 前端 MapInfoLayer 移除坐标转换（问题1+3协同）

**Files:**
- Modify: `frontend/src/renderer/components/Map/MapInfoLayer.tsx:498-508`（`fromGeoJSON`）
- Test: `frontend/src/renderer/components/Map/MapInfoLayer.tsx`（类型检查）

**Step 1: 移除前端坐标转换调用**

在 `fromGeoJSON`（`MapInfoLayer.tsx:498`）中，删除 `transformFeatureCoordinatesOptimized` 调用，直接使用后端已转换数据：

```typescript
static async fromGeoJSON(options: MapInfoLayerOptions): Promise<MapInfoLayer> {
    const mapInfoLayer = new MapInfoLayer(options)

    // 后端 get_layer_data 已统一做 WGS84→GCJ02 转换（transform_coords=True）
    // 前端不再转换，避免双重转换导致位置偏移
    const transformedData = options.data

    if (IS_DEV) console.log('[MapInfoLayer] 使用后端已转换数据，要素数:', transformedData.features.length)

    // 创建 GeoJSON 图层（使用后端已转换数据）
    mapInfoLayer.geoJSONLayer = L.geoJSON(transformedData, {
        // ... 其余 pointToLayer / style / onEachFeature 保持不变
    })
    // ... 其余不变
}
```

**Step 2: 确认无残留调用**

Run: `grep -n "transformFeatureCoordinates\|transformGeoJSONCoordinates\|collectCoordinates" frontend/src/renderer/components/Map/MapInfoLayer.tsx`
Expected: 仅剩函数定义（`transformFeatureCoordinatesOptimized` 等函数本身可保留供其他调用方，但 `fromGeoJSON` 内不再调用）。若这些函数无其他调用方，可一并删除（DRY）。

**Step 3: 类型检查**

Run: `cd frontend && npx tsc --noEmit`
Expected: 无新错误。

**Step 4: Commit**

```bash
git add frontend/src/renderer/components/Map/MapInfoLayer.tsx
git commit -m "refactor: 前端 MapInfoLayer 移除坐标转换，改用后端已转换数据"
```

---

## Task 6: 前端懒加载 + 缓存转换后 GeoJSON（问题1）

**Files:**
- Modify: `frontend/src/renderer/store/mapDataCacheStore.ts`（`LayerCacheEntry` 加 `geojson`）
- Modify: `frontend/src/renderer/components/Map/OnlineMap.tsx:2755-2764`（`loadMapInfoLayers` 懒加载+并发）
- Modify: `frontend/src/renderer/components/Map/OnlineMap.tsx:2455-2750`（`loadMapInfoLayer` 从缓存取/存）

**Step 1: 扩展 `mapDataCacheStore` 缓存 GeoJSON**

在 `mapDataCacheStore.ts` 的 `LayerCacheEntry` 加 `geojson` 字段：

```typescript
interface LayerCacheEntry {
  layerId: string
  bounds: any
  geojson?: any          // 后端已转 GCJ02 的 GeoJSON，缓存避免重新拉取/重建
  loadedAt: number
}
```

并新增 action（仿 `cacheLayer`）：
```typescript
cacheLayerGeoJSON: (layerId: string, geojson: any) => void
```

**Step 2: `loadMapInfoLayers` 改懒加载 + 并发**

让挂载时只拉取数据并缓存，不构建 `MapInfoLayer`；未勾选图层不阻塞主线程：

```typescript
const loadMapInfoLayers = useCallback(async () => {
    if (!mapInstanceRef.current) return
    const allFiles = [...layerFiles, ...pointFiles]
    console.log('[OnlineMap] 加载图层数据（懒加载，不构建图层）:', allFiles.length)

    // 并发拉取数据并缓存（限流，避免一次几十个请求）
    const CHUNK = 5
    for (let i = 0; i < allFiles.length; i += CHUNK) {
        const chunk = allFiles.slice(i, i + CHUNK)
        await Promise.all(chunk.map(layerFile => prefetchLayerData(layerFile)))
    }
}, [layerFiles, pointFiles])
```

新增 `prefetchLayerData`：只 `getLayerData` 拉取，存入 `mapDataCacheStore`，不构建。首次勾选时 `loadMapInfoLayer` 从缓存取 geojson 构建。

**Step 3: `loadMapInfoLayer` 从缓存取/存**

- 开头：若 `mapDataCacheStore` 有该 layer 的 `geojson`，直接用缓存构建，跳过 `getLayerData`。
- 构建后：存入 `mapDataCacheStore`。

**Step 4: 保持已勾选图层实时渲染**

挂载完成后，对 `visible=true` 的图层仍触发构建（从缓存取 geojson 构建并 `addTo`），保证进入地图即显示。

**Step 5: 类型检查 + 构建**

Run: `cd frontend && npx tsc --noEmit`
Expected: 无新错误。
Run: `cd frontend && npm run build:vite`
Expected: 成功。

**Step 6: Commit**

```bash
git add frontend/src/renderer/store/mapDataCacheStore.ts frontend/src/renderer/components/Map/OnlineMap.tsx
git commit -m "perf: 图层懒加载+缓存转换后GeoJSON，勾选秒级出图"
```

---

## Task 7: 完整验证与回归

**Files:**
- Test: `backend/tests/`、`frontend`

**Step 1: 后端全量测试**

Run: `cd backend && python -m pytest -q`
Expected: 全部 PASS（含新增 `test_mapinfo_style.py`）。

**Step 2: 前端类型 + 构建**

Run: `cd frontend && npx tsc --noEmit && npm run build:vite`
Expected: 无错误，构建成功。

**Step 3: 手工验证（对照设计文档 §4）**

1. **问题1**: 导入 >1000 要素的图层压缩包，勾选图层秒级出图（<1s）；切页回来立即显示（命中缓存）。
2. **问题2**: 同一图层无样式要素颜色完全一致；文件自带样式显示文件原色。
3. **问题3**: 外部 WGS84 图层要素在高德底图位置准确，与工参扇区、底图对齐，无偏移。

**Step 4: 更新设计文档**

在 `docs/plans/2026-08-08-layer-rendering-fix-design.md` 的 §4 验证结果处补勾选状态和实测截图/数据。

**Step 5: Commit**

```bash
git add docs/plans/2026-08-08-layer-rendering-fix-design.md
git commit -m "docs: 图层渲染修复验证结果"
```

---

## 风险与注意

- **双重转换**: Task 2 后端转换 + Task 5 移除前端转换必须成对完成，否则会双重偏移。若只做其一，位置反而更偏。
- **颜色位序**: Task 3 的单整数颜色还原需先确认 MapInfo BGR 约定（`R + G*256 + B*65536`），断言值以实际还原为准，但必须验证单整数路径被正确解析。
- **懒加载回归**: Task 6 改动 `loadMapInfoLayers` 后，需确保已勾选图层进入地图即显示，不能因懒加载导致首屏无图层。
- **诊断先行**: Task 1 的 FAIL 测试是诊断证据，Task 2 修复后转绿。若诊断发现偏移其实是 CRS 读入问题（`gpd.read_file` 未归一），需在 Task 2 前补 `parse_file` 的 `to_crs(epsg=4326)`。