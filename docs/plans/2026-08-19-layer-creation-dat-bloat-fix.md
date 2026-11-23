# 图层制作功能修复：.dat 体积 20 倍膨胀 + MIF 导入失败

## Context

图层制作模块（`layer_service.py`）生成 MapInfo TAB/MIF/KML 图层，用户把产物导入"数据管理 → 图层文件"后在
地图上无法渲染（TAB），或导入报错（MIF）。用户提供关键线索：**同一数据源，图层制作生成的 `.dat` 比正常能在地图
识别的图层文件大 20 多倍**。

## 根因分析（已实测验证）

### 根因 1（主因，匹配用户线索）：字符串字段全部写成 `Char(254)`

`layer_service.py` 的 `_write()` 用 `gdf.to_file(driver="MapInfo File", encoding="GBK")` 写 TAB/MIF。
GDAL/pyogrio 的 MapInfo 驱动对 `object`/字符串列**统一写 `Char (254)`（MapInfo 最大字符宽）**，而非按实际内容
定宽。

实测证据：
- `韶关…sector.tab` 声明 66 个字段，其中约 57 个 `Char (254)`；`.dat` = **248 MB**，而几何 `.map` 仅 3.5 MB。
- `中兴…sector`（8113 行 × 55 列）`.dat` = **71 MB**，`.map` 仅 1.3 MB。
- 复现：8 字符的字符串列，`gdf.to_file` 生成 `Char (254)`，`.dat` 体积 = 行数 × 254 字节 × 字符串列数。

正常 MapInfo（MapInfo Pro 手作）按实际内容定宽（如 `Char(10)`/`Char(54)`），故 `.dat` 小 20-70 倍。

**后果**：`.dat` 巨大 → `gpd.read_file` 解析慢（71MB→2.4s，248MB→10s+）、GeoJSON 巨大（8113 要素→19MB）、
地图首次渲染触发 Cloudflare 524 / axios 超时 → **"无法在地图上渲染图形"**。

### 根因 2：MIF 单文件导入错误要求 `.tab`+`.dat` 配套

`data_service.py` 的 `upload_map()` 非 ZIP 分支对所有 MapInfo 文件一律要求 `.tab` 和 `.dat` 配套文件。
但 **MIF 格式的配套文件是 `.mid`**（不含 `.tab`/`.dat`）。单 `.mif` 文件导入 → "缺少配套文件" 报错。
且 `.mid` 的查找目录用 `settings.UPLOAD_DIR`，而图层产物在 `UPLOAD_DIR/layers/`，更找不到。

（MIF 打包成 ZIP 导入则走 `parse_mapinfo_files`，实测可正常解析 8113 个 polygon；问题只在单文件导入路径。）

### 根因 3：`status="partial"` 不在 DataStatus 枚举内

`upload_map()` 在"解析失败但有错误清单"时把 `status` 设为 `"partial"`，而 `DataStatus` 枚举只有
`processing/ready/error`。`list_data` 里 `DataItem(**data_copy)` 抛 pydantic 校验错，这些条目被静默跳过，
数据管理列表里看不到。

## Approach（修复方案）

### 修复 1：`layer_service.py` 写 TAB/MIF 时按 GBK 字节长度定宽字符串字段

改用 `pyogrio.raw.write` + numpy `U{width}` 定宽数组写字段（已实测 `U{width}` → `Char(width)`，数据不截断）：
- 字符串/日期/布尔列 → `U{最大GBK字节长}`（上限 254），GDAL 据此写 `Char(字节宽)`；
- 数值列保持 int64/float64（→ LargeInt/Float，本就无膨胀）；
- 几何用 WKB + `geometry_type` 写入；
- 字段名仍用 `f0..fN` ASCII 占位 + 写后 `_mapinfo_postprocess` 恢复（复用现有逻辑，正则已兼容）。

验证基准（实测）：3 个中文字段的小样例，`.dat` 从 762+ 字节降到 223/379 字节，`小区名称 Char(14)`、
`CGI Char(14)`、`备注 Char(54)`，读回中文/几何完全一致。

### 修复 2：`data_service.py` `upload_map` 按格式区分配套文件

- MIF（`.mif`）：配套要求 `.mid`（存在性检查 + 从 `UPLOAD_DIR/layers/` 与 `UPLOAD_DIR` 查找复制）；
- TAB（`.tab`）：保持现有 `.dat/.map/.id` 要求。
- 找不到配套时才报"缺少配套文件"。

### 修复 3：`schemas.py` DataStatus 增加 `PARTIAL = "partial"`

让 `status="partial"` 的条目能被 `list_data` 正常返回（不再被静默跳过）。

## Files to modify

- `backend/app/services/layer_service.py`（根因 1：`_write` + 新增 `_build_field_data` / `_to_u_array` + import numpy/pyogrio/wkb）
- `backend/app/services/data_service.py`（根因 2：`upload_map` 的 MIF 配套文件逻辑）
- `backend/app/models/schemas.py`（根因 3：DataStatus 加 PARTIAL）

## Reuse

- `layer_service._mapinfo_postprocess` / `_sanitize_field_name` / `_dedupe_field_names`：字段名恢复与清洗逻辑保持不变。
- `mapinfo_service.MapInfoParser.parse_file`：读取端无需改动（`Charset WindowsSimpChinese` + 无 encoding 回退已能正确解析）。
- `pyogrio.raw.write`：已内置（geopandas 依赖），无需新增第三方库。

## Steps

- [x] 1. `layer_service.py`：顶部 import `numpy` / `pyogrio` / `shapely.wkb`
- [x] 2. `layer_service.py`：重写 `_write` 的 tab/mif 分支为 `pyogrio.raw.write`（WKB + 定宽 U 字段 + f0..fN 占位名）
- [x] 3. `layer_service.py`：新增 `_build_field_data` 与 `_to_u_array`（字符串按 GBK 字节宽、数值原样）
- [x] 4. `data_service.py`：`upload_map` 非 ZIP 分支按 `.mif`→`.mid` / `.tab`→`.dat` 区分配套文件，并从 `UPLOAD_DIR/layers` 查找；同时修复 `shutil` 局部导入遮蔽导致单文件导入 UnboundLocalError→500 的根因
- [x] 5. `schemas.py`：`DataStatus` 增加 `PARTIAL = "partial"`（`list_data` 同步映射）
- [ ] 6. 清理历史错误状态条目（index.json 中 3 个 `status=partial` 的 `电联扇区图层20260731.zip`）——枚举修复后已可见，暂不需清理

## Verification

- [x] 后端单测：252 个测试全部通过（含 `test_layer_service.py` 59 个）
- [x] 规模验证：10000 行扇区 TAB `.dat` 旧写法估算 12.7MB → 新写法 1.1MB（缩小 11.5 倍），字段 `Char(14)/Char(22)/Char(58)` 而非 `Char(254)`
- [x] 读回校验：`gpd.read_file` 读到正确中文字段名、Polygon/Point 几何、日期（转字符串）、行数一致
- [x] 样式注入：MIF 扇区 Pen/Brush、点 Symbol (32,16711680,16) 均正常
- [x] 导入回归：单 `.mif` 文件导入实测——自动从 `uploads/layers` 复制 `.mid`，解析 8113 要素，status=ready，无 500
- [x] 列表回归：`DataStatus.PARTIAL` 已加入枚举，`list_data` 不再抛 pydantic 校验错
