# 批量距离匹配功能设计文档

**日期**: 2026-08-05
**状态**: 已确认
**分支**: layer-tools

## 1. 背景与目标

在项目中新增「批量距离匹配」功能，替代原有的独立脚本 `/home/pwc/NetworkPlanningTooV3/批量距离匹配脚本/distance.py`，将其集成到 Web/Electron 应用中。

用户上传「匹配站点」清单（按模板填写），并指定「全量站点」（上传清单文件 **或** 从数据管理已导入的工参读取），按设定的距离门限输出「匹配站点」对应「全量站点」的匹配结果清单。

### 目标
1. 前端：左侧边栏 + 首页新增「批量距离匹配」入口，页面包含「文件导入」「参数设置」「开始匹配」「匹配结果下载」四个区块
2. 文件导入处提供「模版下载」；匹配结果文件名 `匹配结果+时间戳后缀.xlsx`
3. 后端参考 `distance.py` 实现匹配逻辑，输出固定 8 列
4. 导入数据后台智能校验（经纬度格式/有效性），异常时提示用户调整后重新导入

## 2. 关键决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 距离门限语义 | 单一参数 `max_distance_km`，单位 **千米(km)**，最大匹配距离（参考脚本的 `sep` 网格预筛 + `max_dis` 米截断合并为一个 km 门限） |
| 多命中处理 | 一个「匹配站点」在门限内命中多个「全量站点」时，**输出全部命中对**（与参考脚本一致） |
| 列名识别（上传文件） | 固定列名 `CELL` / `LON` / `LAT`，缺列即报错 |
| 全量站点来源 | 支持两种：① 上传清单文件（sheet「全量站点」）；② **数据管理已导入工参**（需选数据文件 + 网络类型 + 列映射） |
| 数据管理来源列映射 | `GeoFieldDetector` 同源规则**自动预选 + 可手动改**下拉 |
| 无命中输出 | 行保留（匹配站点名称 + 备注「无匹站点匹配」），保证匹配站点全部出现在输出中 |
| 输出单位 | 距离（km），4 位小数 |

## 3. 术语

- **匹配站点**：需匹配的小区（用户导入清单，必须全部出现在输出中）→ 参考脚本中被迭代的基准表
- **全量站点**：候选匹配池（上传清单文件 或 数据管理工参）→ 参考脚本中的候选表

## 4. 架构

### 4.1 整体流程

```
匹配站点清单文件(上传) ─┐
                         ├─→ 后端 /parse 校验 → (失败) 错误明细返回前端 → 用户调整重新导入
全量站点(上传文件 OR 数据管理工参) ─┤
                         │
                         └─→ 后端 /match (max_distance_km) → 网格预筛 + haversine → 输出 xlsx
                                                                              ↓
                                        前端下载按钮 ←─ /static/匹配结果{时间戳}.xlsx
```

### 4.2 后端模块

| 文件 | 职责 |
|---|---|
| `backend/app/services/distance_match_service.py` | 核心匹配服务：解析清单、校验、网格预筛、haversine、生成 xlsx |
| `backend/app/api/v1/endpoints/distance_match.py` | API 端点（3 个） |
| `backend/template/站点匹配清单-模板.xlsx` | 模板文件（从参考脚本目录复制） |
| `backend/tests/test_distance_match.py` | 单元测试 |

### 4.3 前端模块

| 文件 | 职责 |
|---|---|
| `frontend/src/renderer/pages/DistanceMatchPage.tsx` | 页面（文件导入 + 参数设置 + 开始匹配 + 结果下载） |
| `frontend/src/renderer/App.tsx` | 注册路由 `/distance-match` |
| `frontend/src/renderer/components/Layout/MainLayout.tsx` | 侧边栏新增导航项（`Ruler` 图标） |
| `frontend/src/renderer/pages/HomePage.tsx` | 首页新增 FeatureCard |
| `frontend/src/renderer/services/api.ts` | `distanceMatchApi` 封装 |
| `frontend/src/renderer/locales/zh.json` / `en.json` | i18n 文案 |

## 5. 后端详细设计

### 5.1 匹配算法（`distance_match_service.py`）

参考 `distance.py`，保留网格预筛思路，合并为单个 km 门限：

```python
def haversine_km(lon1, lat1, lon2, lat2):
    """Haversine 球面距离，返回 km"""
    ...

def match_sites(match_df, full_df, max_distance_km):
    """match_df: 匹配站点 DataFrame(CELL/LON/LAT)
       full_df: 全量站点 DataFrame(CELL/LON/LAT)
       返回所有 (匹配站点, 全量站点, 距离km) 命中对 + 无命中匹配站点清单"""
    results = []
    unmatched = []
    for _, row in match_df.iterrows():
        lon, lat = row["LON"], row["LAT"]
        # 门限 → 度：Δlat = km/110.574, Δlon = km/(111.320*cos(lat))
        dlat = max_distance_km / 110.574
        dlon = max_distance_km / (111.320 * math.cos(math.radians(lat)))
        # 向量化网格预筛（numpy）
        mask = (full_df["LON"] >= lon - dlon) & (full_df["LON"] <= lon + dlon) & \
               (full_df["LAT"] >= lat - dlat) & (full_df["LAT"] <= lat + dlat)
        candidates = full_df[mask]
        hits = []
        for _, crow in candidates.iterrows():
            d = haversine_km(lon, lat, crow["LON"], crow["LAT"])
            if d <= max_distance_km:
                hits.append((row["CELL"], row["LON"], row["LAT"],
                             crow["CELL"], crow["LON"], crow["LAT"], round(d, 4)))
        if hits:
            results.extend(hits)
        else:
            unmatched.append(row["CELL"])
    return results, unmatched
```

性能：全量站点上构建一次 numpy 数组，匹配站点逐行预筛，避免 O(N×M) 全量计算。

### 5.2 输出 Excel（列名固定）

| 列 | 来源 |
|---|---|
| 匹配站点名称 | 匹配站点 `CELL` |
| 匹配站点经度 | 匹配站点 `LON` |
| 匹配站点纬度 | 匹配站点 `LAT` |
| 全量站点名称 | 命中全量站点 `CELL`；无命中行留空 |
| 全量站点经度 | 命中全量站点 `LON`；无命中行留空 |
| 全量站点纬度 | 命中全量站点 `LAT`；无命中行留空 |
| 距离（km） | 命中保留 4 位小数；无命中行留空 |
| 备注 | 无命中填「无匹站点匹配」，命中留空 |

文件名：`匹配结果{YYYYMMDD_HHMMSS}.xlsx`，写入 `settings.OUTPUT_DIR`，经 `/static/` 挂载下载（挂载已存在于 `backend/app/api/__init__.py`）。

### 5.3 校验规则（`_validate`）

对「匹配站点」和「全量站点」统一校验：

| 规则 | 错误提示 |
|---|---|
| sheet 缺失 | 「缺少工作表：{sheet名}」 |
| 必需列缺失（CELL/LON/LAT） | 「缺少必需列：{列名}」 |
| 经纬度非数字 | 「{sheet} 第{row}行：经纬度格式无效」 |
| 经纬度越界（LON∉[-180,180] 或 LAT∉[-90,90]） | 「{sheet} 第{row}行：经度/纬度超出有效范围」 |
| CELL 为空 | 「{sheet} 第{row}行：站点名称为空」 |

有任一错误 → 拒绝匹配，返回结构化错误列表 `{sheet, row, reason}`。

### 5.4 API 端点（`/api/v1/distance-match`）

#### `POST /parse` — 解析 + 校验上传清单
- 入参：`file_path`（分块上传结果）
- 逻辑：读取两个 sheet（「全量站点」「匹配站点」），校验列名/经纬度
- 返回：`{success, data: {match_total, full_total, columns_valid: bool, errors: [...]}}`
- 前端据此决定是否允许「开始匹配」

#### `POST /match` — 执行匹配
- 入参（FormData）：
  - `match_file_path`：匹配站点清单文件路径（上传）
  - `max_distance_km`：距离门限（float，>0）
  - 全量站点来源（二选一）：
    - `full_file_path`：全量站点清单文件路径（上传）
    - `full_data_id` + `full_network_type` + `full_name_col` + `full_lon_col` + `full_lat_col`：从数据管理工参读取 + 列映射
- 逻辑：`run_in_threadpool` 包裹匹配；校验失败返回 400 带结构化错误
- 返回：`{success, data: {filename, download_url}}`

#### `GET /template` — 模板下载
- 返回 `FileResponse(backend/template/站点匹配清单-模板.xlsx, filename="站点匹配清单-模板.xlsx")`（UTF-8 文件名正确处理）

### 5.5 从数据管理读取全量站点（`_load_full_params_from_data`）

```python
def load_full_params_from_data(data_id, network_type, name_col, lon_col, lat_col):
    data = data_service.get_data(data_id)   # {LTE:[...], NR:[...]} 分表
    rows = data.get(network_type.upper(), [])
    df = pd.DataFrame(rows)[[name_col, lon_col, lat_col]]
    df.columns = ["CELL", "LON", "LAT"]     # 归一化
    return df
```

随后与上传文件走同一套校验 + 匹配逻辑。

## 6. 前端详细设计

### 6.1 页面结构（`DistanceMatchPage.tsx`）

对齐 `LayerToolsPage` 的卡片式布局：

```
┌─ 批量距离匹配 ─────────────────────────────┐
│ ① 文件导入（含「模版下载」按钮）              │
│    ┌ 匹配站点清单: [拖拽/点击上传 .xlsx/.csv] │
│    └ 全量站点来源: ○ 上传清单文件  ● 从数据管理 │
│       ├ (上传文件) → 拖拽上传                 │
│       └ (数据管理) → 数据文件下拉 / 网络类型 / 列映射(名称/经度/纬度) │
│ ② 参数设置                                   │
│    ┌ 相邻距离门限 (km): [____]               │
│ ③ 开始匹配                                   │
│    ┌ [开始匹配] (Loading 态)                 │
│    │ 校验失败 → 错误明细列表 (sheet/行号/原因) │
│ ④ 匹配结果下载                               │
│    ┌ [下载 匹配结果20260805_153000.xlsx]      │
└──────────────────────────────────────────────┘
```

### 6.2 交互细节

- **上传**：复用 `chunkedUpload` 分块上传（同 LayerTools），`uploadStore` 进度 + 取消
- **全量站点来源切换**：Radix Radio/单选；切换时清空相关状态
- **数据管理来源**：
  - 数据文件下拉：`dataApi.list(1, 100, true)` 过滤 `type === 'excel'`，默认高亮 `projectparameter_mongoose`（全量工参）
  - 网络类型：LTE / NR 单选（工参分表）
  - 列映射：三个下拉，用 `dataApi.getColumns(dataId, networkType)` 获取列名，经度/纬度/名称用 `GeoFieldDetector` 同源规则自动预选，可手动改
- **参数**：门限数字输入，只允许正数，前端校验 > 0
- **开始匹配**：先调 `/parse`（若校验失败展示错误清单并中止），再调 `/match`
- **结果下载**：绿色按钮 `<a href={download_url} download>`

### 6.3 i18n

`zh.json` / `en.json` 同步新增（不硬编码中文）：
- `nav.distanceMatch`、`home.distanceMatchDesc`
- 页面文案：文件导入/模版下载/全量站点来源/数据管理/网络类型/列映射/相邻距离门限/开始匹配/匹配结果下载/错误明细等

## 7. 数据流

```
选择匹配站点文件 → chunkedUpload → file_path
选择全量站点来源：
  上传 → chunkedUpload → full_file_path
  数据管理 → full_data_id + network_type + 列映射
填门限 km → POST /match
  → 后端 run_in_threadpool(match_sites) → 写 OUTPUT_DIR/匹配结果{ts}.xlsx
  → 返回 {filename, download_url}
前端渲染下载按钮 → 点击 <a download>
```

## 8. 错误处理

| 场景 | 处理 |
|---|---|
| 上传失败 | 前端 uploadStore 错误提示 |
| `/parse` 校验失败 | 页面内错误明细表（sheet/行号/原因），提示调整后重新导入 |
| `/match` 校验失败（400） | 同上，结构化错误透传 |
| 门限非法（≤0/非数字） | 前端输入限制 + 后端 400 |
| 数据管理工参读取失败（data_id 失效/表缺失） | 前端 toast + 重新选择 |
| 文件过期（file_path TTL） | 清空共享文件提示重新导入（同 LayerTools `文件不存在|文件已过期` 模式） |

## 9. 测试（`backend/tests/test_distance_match.py`）

1. **haversine 正确性**：已知坐标对（如 (116.397, 39.908) ↔ (116.397, 39.918)，约 1.11km）
2. **网格预筛边界**：恰好在门限上/外的点
3. **输出完整性**：列名齐全；匹配站点全部出现；无命中行备注「无匹站点匹配」；多命中全部输出
4. **校验路径**：缺 sheet / 缺列 / 越界经纬度 / 非数字经纬度 / 空 CELL 各报错
5. **模板下载**：`GET /template` 返回 200 且文件可解析
6. **数据管理来源**：mock `get_data` 返回 LTE 分表，验证列映射 + 归一化

## 10. 部署注意事项

- 模板文件 `backend/template/站点匹配清单-模板.xlsx` 需随仓库提交
- 输出目录用现有 `OUTPUT_DIR`（`/static/` 已挂载，无需新增静态挂载）
- 修改后端 → `systemctl restart npt-backend`；修改前端 → `npm run build:vite` + 重启后端

## 11. 参考脚本差异说明

| 参考脚本 | 本设计 |
|---|---|
| CSV 直读（gbk） | Excel 多 sheet（模板结构），pandas 读取 |
| 双参数（sep 度 + max_dis 米） | 单参数 `max_distance_km`（km） |
| 输出 CSV | 输出 xlsx（8 列，含备注） |
| 无校验 | 后台智能校验（经纬度格式/有效性） |
| CELL1,LON1,LAT1,CELL2,... | 中文明细列名 + 备注 |
| 无全量来源选择 | 支持上传文件 + 数据管理工参双来源 |
