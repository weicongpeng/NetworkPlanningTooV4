# 批量距离匹配功能修复与 UI 重构设计文档

**日期**: 2026-08-06
**状态**: 已确认
**分支**: layer-tools

## 1. 背景与目标

批量距离匹配功能存在以下问题，需修复并重构 UI：

1. **模板下载无反应**：端点 `GET /distance-match/template` 读取 `settings.TEMPLATE_DIR / 站点匹配清单-模板.xlsx`（=`backend/template/`），但文件实际被 git 跟踪在仓库根 `template/`，导致 404 → 前端「无反应」。
2. **匹配失败提示**：`/match` 强制读取「匹配站点」「全量站点」两个固定 sheet 名。用户选择非固定名的 sheet 后报「缺少工作表」→ 前端显示「匹配失败，请重试」。
3. **UI 层级混乱**：当前「匹配站点」「全量站点」各自独立上传框，全量站点来源下方还有一个多余的文件导入框，与需求不符。

### 目标（需求描述）

- 「文件导入」标签 + 文件导入框放在**页面顶层**，单一上传框。
- 导入文件后，下方是「匹配站点」和「全量站点」。
  - **匹配站点**：下方是导入文件的 sheet 名称下拉，选择对应的匹配站点清单。
  - **全量站点**：下方同样有导入文件 sheet 下拉；全量站点选择还可从**数据管理**中已导入的全量工参文件的 sheet 选择。
- **默认优先使用导入文件的数据**自动匹配「匹配站点」和「全量站点」数据源。
- 数据选择无误后点击「开始匹配」执行匹配，匹配完成输出结果下载链接按钮下载。

## 2. 关键决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 数据管理来源的「sheet 选择」 | **读取原始 Excel（`data/{data_id}/original.xlsx`）的真实 sheet 列表**，前端下拉选任意 sheet；original 缺失时兜底返回 `["LTE","NR"]` 网络分表 |
| 匹配站点数据源 | **仅从导入文件选 sheet**（来源固定为导入文件），可从任意 sheet 选，不局限于固定「匹配站点」sheet 名 |
| 数据管理来源列映射 | **自动识别 + 可手动改**（保留名称/经度/纬度下拉，复用 GeoFieldDetector 同源规则预选） |
| 后端修复范围 | **适配新 UI + 修复根因**（按所选 sheet 读取），不重写匹配算法（网格预筛 + 向量化 haversine 已正确） |
| 校验时机 | 从「导入时固定两 sheet 校验」改为「匹配时对用户所选 sheet 校验」；导入后仅用 `/layer/excel-info` 拿 sheet 列表 |
| `/parse` 端点 | **保留**（向后兼容），前端主流程不再调用 |

## 3. 术语

- **匹配站点**：需匹配的小区（用户从导入文件选 sheet，必须全部出现在输出中）→ 参考脚本中被迭代的基准表
- **全量站点**：候选匹配池（导入文件选 sheet 或 数据管理工参原始 Excel 选 sheet）→ 参考脚本中的候选表

## 4. 架构

### 4.1 整体流程

```
导入文件(单一上传) → chunkedUpload → file_path → /layer/excel-info → sheet 列表
  → 自动预选「匹配站点」「全量站点」sheet
匹配站点：sheet = 匹配站点（用户可改）
全量站点：
  ○ 导入文件 → 同一 file_path 选 sheet
  ● 数据管理 → data_id → 新接口 /data-sheets 读原始Excel真实sheet → 选 sheet + 列映射
填门限 → POST /match (match_sheet_name, full_source, full_sheet_name, ...)
  → 后端按所选 sheet 读取 → 校验 → 网格预筛 + haversine → xlsx
  → 返回 download_url → 前端下载按钮
```

### 4.2 后端模块

| 文件 | 改动 |
|---|---|
| `backend/app/api/v1/endpoints/distance_match.py` | 模板路径修复；`/match` 参数改造（按所选 sheet 读取）；新增 `/data-sheets` 接口 |
| `backend/app/services/distance_match_service.py` | 新增 `read_data_sheets`（读数据管理原始 Excel sheet 列表，兜底网络分表）；`load_full_sites_from_data` 支持按 sheet 读取原始 Excel |
| `backend/app/api/v1/endpoints/layer.py` | 复用（`/layer/excel-info` 已提供导入文件 sheet 列表） |
| `backend/tests/test_distance_match_api.py` | 重构 + 新增（按所选 sheet / data-sheets / 单sheet自匹配） |

### 4.3 前端模块

| 文件 | 改动 |
|---|---|
| `frontend/src/renderer/pages/DistanceMatchPage.tsx` | 重构页面：顶层单一文件导入框 + 匹配站点/全量站点 sheet 下拉 + 数据管理 sheet 选择 + 列映射 |
| `frontend/src/renderer/services/api.ts` | `distanceMatchApi` 改造：`match` 新签名 + 新增 `getDataSheets` |
| `frontend/src/renderer/locales/zh.json` / `en.json` | 同步 i18n key |

## 5. 后端详细设计

### 5.1 模板下载修复

端点 `GET /distance-match/template` 当前读 `settings.TEMPLATE_DIR / 站点匹配清单-模板.xlsx`。修复：读取仓库根 `template/站点匹配清单-模板.xlsx`（git 跟踪的实际路径），文件不存在时 404 提示。

### 5.2 新增 `/data-sheets` 接口

```
POST /distance-match/data-sheets
入参: data_id (Form)
逻辑:
  1. data_dir = settings.DATA_DIR / data_id
  2. original = data_dir / "original.xlsx"
  3. 若存在 → 读 sheet 列表 → {sheets: [...], source: "excel"}
  4. 否则 → data_service.get_data(data_id) 网络类型分表键 (LTE/NR/…) → {sheets: ["LTE","NR"], source: "network"}
返回: {success, data: {sheets, source}}
```

### 5.3 `/match` 端点参数改造

```
POST /distance-match/match (FormData)
  file_path          → 导入文件路径（上传）      [必传]
  match_sheet_name   → 匹配站点所在 sheet        [必传]
  max_distance_km    → 门限（>0）               [必传]
  full_source        → "file" | "data"          [必传]
  full_sheet_name    → 全量站点 sheet            [必传]
  full_data_id       → data 来源时必传
  full_name_col/lon_col/lat_col → data 来源可选手动映射（缺省自动识别）
```

- **匹配站点**：`read_arbitrary_sheet(file_path, match_sheet_name)`（自动识别 CELL/LON/LAT，过滤无效行，按 CELL 去重）
- **全量站点**：
  - `file` → 同一导入文件 `read_arbitrary_sheet(file_path, full_sheet_name)`
  - `data` → 新增 `load_full_sites_from_data_sheet(data_id, sheet_name)` 读 `data/{data_id}/original.xlsx` 指定 sheet；`original.xlsx` 缺失时回退现有 `load_full_sites_from_data`（JSON 分表 + 列映射）
- 统一校验（经纬度/CELL 空）→ 失败返回 `{success:false, data:{errors}}`
- 匹配算法不变（网格预筛 + 向量化 haversine）
- 成功返回 `{success:true, data:{filename, download_url}}`

### 5.4 `/parse` 取舍

保留端点（向后兼容 + 现有测试契约），但前端主流程不再调用。导入后改用 `/layer/excel-info` 拿 sheet 列表，校验移到 `/match`。

## 6. 前端详细设计

### 6.1 页面结构（`DistanceMatchPage.tsx`）

```
┌─ 批量距离匹配 ─────────────────────────────────────────┐
│ ① 文件导入（顶层，单一上传框 + 模板下载按钮）            │
│    ┌ [点击或拖拽上传 .xlsx] ┐  ← 仅此一个上传框          │
│    └ 模板下载（修复路径 bug）                          │
│                                                         │
│ ② 数据选择                                             │
│    匹配站点（来源：导入文件）                            │
│      工作表: [ 匹配站点 v ]  ← 导入文件的所有 sheet       │
│    全量站点（来源：○ 导入文件 ● 数据管理）               │
│      ○ 导入文件 → 工作表: [ 全量站点 v ]                │
│      ● 数据管理 → 数据文件[ v ] → sheet[ v ] → 列映射     │
│                                                         │
│ ③ 参数设置：相邻距离门限 (km) [____]                    │
│ ④ 开始匹配 [按钮]                                      │
│ ⑤ 结果下载：匹配完成 → [下载 匹配结果xxx.xlsx]           │
└─────────────────────────────────────────────────────────┘
```

### 6.2 状态结构

```ts
// 导入文件（顶层单一）
const [filePath, setFilePath] = useState('')      // 分块上传结果
const [fileName, setFileName] = useState('')
const [sheetList, setSheetList] = useState<string[]>([])  // 导入文件所有 sheet
// 匹配站点
const [matchSheet, setMatchSheet] = useState('')  // 默认预选「匹配站点」
// 全量站点
const [fullSource, setFullSource] = useState<'file' | 'data'>('file')  // 默认导入文件
const [fullSheet, setFullSheet] = useState('')    // file: 从导入文件选；data: 从数据管理选
// 数据管理
const [dataItems, setDataItems] = useState([])    // full_params 过滤
const [fullDataId, setFullDataId] = useState('')
const [dataSheets, setDataSheets] = useState<string[]>([])
const [columns, setColumns] = useState([])
const [nameCol, setNameCol] = useState('')
const [lonCol, setLonCol] = useState('')
const [latCol, setLatCol] = useState('')
// 参数/状态
const [maxDistanceKm, setMaxDistanceKm] = useState('')
const [matching, setMatching] = useState(false)
const [parseErrors, setParseErrors] = useState<ParseError[]>([])
const [result, setResult] = useState(null)
```

### 6.3 导入文件处理（`handleFile`）

1. `layerToolsApi.uploadLayerFile(f)` → `file_path`
2. `layerToolsApi.getExcelInfo(file_path, f.name)` → `sheets`
3. 预选：`matchSheet` ← 含「匹配站点」的 sheet，否则 sheets[0]；`fullSheet` ← 含「全量站点」的 sheet，否则 sheets[1]||sheets[0]
4. 切换来源时重置对应状态

### 6.4 全量站点来源切换

- `file` → 从 `sheetList` 选（默认已预选）
- `data` → 选 `dataItems` → 调新接口 `getDataSheets(dataId)` 拿真实 sheet → 选 sheet → 自动预选列映射（`autoPick`）

### 6.5 开始匹配（`handleMatch`）

- 前置校验：filePath、matchSheet、门限>0、（data 来源）fullDataId + fullSheet
- 调 `distanceMatchApi.match({...})`
- 成功 → 设 `result` 显示下载按钮
- 失败 `data.errors` → 渲染错误明细表（复用现有 `parseErrors` 展示）

### 6.6 API 封装（`api.ts`）

```ts
match(params: {
  filePath: string
  matchSheetName: string
  maxDistanceKm: number
  fullSource: 'file' | 'data'
  fullSheetName: string
  fullDataId?: string
  fullNameCol?: string  // 缺省自动识别
  fullLonCol?: string
  fullLatCol?: string
})
getDataSheets: async (dataId: string) → POST /distance-match/data-sheets → {sheets, source}
```

### 6.7 i18n（`zh.json` / `en.json` 同步）

新增/调整：
- `distanceMatch.fileImport`（已有）→ 顶层标签「文件导入」
- `distanceMatch.matchSheet`（「匹配站点工作表」）、`fullSheet`（「全量站点工作表」）
- `distanceMatch.fullSourceFile`（「导入文件」）、`fullSourceData`（「数据管理」）— 替换旧 uploadTab/dataTab
- 移除/废弃旧 key：`matchFile`/`fullSource`/`fullUpload`/`fullData`

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| 模板下载 404 | 修复路径后正常返回；后端仍兜底「模板文件不存在」提示 |
| 上传失败/取消 | `uploadStore` 进度 + 取消按钮（现有逻辑不变） |
| `/match` 校验失败（缺列/经纬度无效/CELL 空） | 返回 `{success:false, data:{errors:[{sheet,row,reason}]}}`，前端渲染**错误明细表**（sheet/行号/原因），阻止下载 |
| sheet 缺失（所选 sheet 不存在） | 后端 400 提示「缺少工作表: {name}」，前端选中状态清空重新选 |
| 数据管理原始 Excel 不存在 | `data-sheets` 兜底返回 `["LTE","NR"]` 网络分表 + `source:"network"`，前端仍可正常选择 |
| 门限非法（≤0/非数字） | 前端输入限制 + 后端 400 |
| 文件过期（file_path TTL） | 清空导入状态提示重新导入（同 LayerTools 模式） |

## 8. 测试（`backend/tests/test_distance_match_api.py`）

1. **模板下载** → 修复路径后断言 200 + 文件可解析
2. **`/match` 按所选 sheet**：
   - `match_sheet_name="匹配站点"`, `full_source="file"`, `full_sheet_name="全量站点"` → 成功
   - 单 sheet 文件：`match_sheet_name` 与 `full_sheet_name` 指向**同一 sheet**（匹配清单即全量池）→ 成功
   - `full_source="data"` → mock 数据管理工参读原始 sheet → 成功
3. **校验路径**：所选 sheet 缺列/越界经纬度/空 CELL → 400 结构化 errors
4. **数据管理 sheet 列表接口** `data-sheets`：正常返回 sheets；original 缺失回退 `["LTE","NR"]`
5. 兼容：旧 `/parse` 端点仍可用（保留测试）

## 9. 部署注意事项

- 模板文件位于仓库根 `template/站点匹配清单-模板.xlsx`，端点路径需与该位置一致
- 修改后端 → `systemctl restart npt-backend`；修改前端 → `npm run build:vite` + 重启后端

## 10. 参考脚本差异说明

参考脚本 `distance.py` 的算法（网格预筛 + haversine）在现服务已正确实现（向量化优化），本次**不重写算法**，仅修复「按所选 sheet 读取」与「模板路径」根因，重构 UI 层级。
