# 图层制作功能修复设计文档

**日期**: 2026-08-01
**状态**: 已确认
**模块**: 图层制作（扇区图层、点图层）

## 1. 需求概述

修复图层制作工具在生产环境外网导入大文件报 Cloudflare 超时的问题，并优化页面交互与布局。

### 问题清单
1. **Cloudflare 524 / 120s Proxy Read Timeout**：图层制作三个端点（`excel-info`/`point`/`sector`）都是同步 multipart 上传整个文件，大文件在 Cloudflare Tunnel 下传输 + 解析超时。
2. **无进度提示**：导入文件过程没有动态加载进度提示。
3. **控件导入后才渲染**：Sheet/参数配置等控件在导入数据完成后才渲染，未持久化固定。
4. **需上下翻页**：页面纵向堆叠，需滚动查看全部控件。
5. **导出文件命名**：当前 `layer_{uuid}`，需改为 **源数据文件名 + 选择的 sheet 名**。

## 2. 技术方案

### 2.1 分块上传（核心修复）

**复用现有分块上传机制**，后端 `data.py` 的 `/upload/{id}/complete` 增加 `file_type='layer'` 分支：

```
前端 chunkedUpload(file, '/data/upload', 'layer')    ← 复用现有函数，第三个参数传 'layer'
   → POST /data/upload/start {filename, total_chunks, total_size}
   → POST /data/upload/{id}/chunk × N（串行，带重试，calcChunkSize 自动分块）
   → POST /data/upload/{id}/complete {file_type: 'layer'}
       ├─ 重组分块 → uploads/layer_tmp/src_xxx.xlsx
       ├─ 不创建 data 索引（与工参/地理数据不同）
       └─ 返回 {success, data: {file_path: 'uploads/layer_tmp/src_xxx.xlsx'}}
```

**关键设计：上传只发生一次。** 分块上传拿到 `file_path` 后，`excel-info` 和 `generate` 都用 `file_path` 参数（后端从本地读文件，不再走网络上传）。

**后端 `layer.py` 端点改造**：
- `_save_upload` 支持传入已上传的 `file_path`（校验存在 + 扩展名 `.xlsx/.xls`）→ 直接返回该路径，不重复写临时文件
- `excel-info`/`point`/`sector` 优先用 `file_path` 参数，不再需要 `file` 参数
- 成功处理后删除临时文件（沿用现有 `finally` 清理逻辑）

**前端 `layerToolsApi` 改造**：
- 新增 `uploadLayerFile(file, onProgress)`：封装分块上传 + 进度回调，返回 `file_path`
- `getExcelInfo` 改为：接收 `file_path`（不接收 File），POST `/layer/excel-info` 传 `file_path`
- `generateSector`/`generatePoint` 改为：接收 `file_path`（不接收 File）

### 2.2 进度提示

`uploadLayerFile(file, onProgress)` 的 `onProgress` 回调：

| 阶段 | percent | step | 状态文字 |
|------|---------|------|---------|
| 分块上传中 | 0-99 | `uploading` | 上传中 {percent}% |
| complete 后 | 100 | `assembling` | 文件重组中... |
| excel-info 读取 | 100 | `reading` | 读取列名中... |

页面显示进度条 + 状态文字（复用现有 `LoadingSpinner` 或自建进度条）。

### 2.3 控件持久化固定

所有控件**常驻显示**，不再 `{columns.length > 0 && ...}` 条件渲染：
- 导入前：Sheet/属性/参数控件**禁用 + 占位**（灰显）
- 导入后：填充数据，控件启用
- 生成按钮始终可见，无文件/未选择 sheet 时禁用
- 空状态提示：未导入文件时属性区显示"请先导入 Excel 文件"

### 2.4 两栏布局

```
┌─────────────────────────────────────────────────┐
│  ① 导入区（横跨）                                  │
│  [拖拽/点击上传]  [进度条+状态]  [文件名]          │
├──────────────────────────┬──────────────────────┤
│  ② Sheet 选择            │  ④ 参数设置           │
│  [下拉]                  │  [半径][波瓣]          │
│  ③ 图层属性（列勾选+匹配）│  [颜色][格式]          │
│  [checkbox 列表]         │  ⑤ 生成按钮+下载      │
│  [关键字匹配下拉]         │  [生成][下载]          │
└──────────────────────────┴──────────────────────┘
```

- 左栏（约 60%）：导入后显示 Sheet 选择 + 属性配置（列勾选 + 关键字匹配）
- 右栏（约 40%）：参数设置 + 生成按钮 + 下载（常驻面板）
- 页面整体高度可控，无需上下翻页

### 2.5 导出文件命名规则

**源数据文件名 + 选择的 sheet 名**：

```python
# 后端 layer_service.py _write 改造
def _write(self, gdf, output_format, source_filename: str, sheet_name: str) -> Path:
    # 源文件名去掉扩展名，sheet 名安全化（去空格/非法字符）
    base = Path(source_filename).stem
    safe_sheet = re.sub(r'[<>:"/\\|?*]', "_", sheet_name)
    fname = f"{base}_{safe_sheet}_{uuid.uuid4().hex[:8]}{EXT_MAP[output_format]}"
    out_path = self.output_dir / fname
    gdf.to_file(out_path, driver=DRIVER_MAP[output_format])
    return out_path
```

- 例：源文件 `工参2026.xlsx` + sheet `LTE` → `工参2026_LTE_a1b2c3d4.tab`
- 保留 uuid 短后缀避免同名文件冲突（同文件同 sheet 重复生成）
- `generate_point_layer`/`generate_sector_layer` 增加 `source_filename` 参数（来自 `_save_upload` 返回的路径 `stem`）
- 端点 `_finalize_output` 用新文件名返回下载 URL

## 3. 数据流

```
用户选择文件
  → uploadLayerFile(file, onProgress)  // 分块上传，进度回调
      → POST /data/upload/start
      → POST /data/upload/{id}/chunk × N（进度 0-99%）
      → POST /data/upload/{id}/complete {file_type: 'layer'}
      → 返回 {file_path}  // 进度 100%
  → getExcelInfo(file_path)  // 读取 sheet/列（本地读，快）
  → 填充 Sheet 下拉 + 列勾选 + 关键字匹配（控件启用）
  → generateSector/GeneratePoint(file_path, config)
  → 返回 {filename, download_url}（含命名规则）
  → 下载
```

## 4. 错误处理

- 分块上传失败：沿用现有重试机制（MAX_CHUNK_RETRIES=3 + 指数退避），失败显示错误
- `file_path` 不存在 / 扩展名不合法：400
- 大文件处理：`run_in_threadpool` 包裹（沿用现有模式）
- 临时文件清理：`finally` 删除（沿用现有模式）

## 5. 测试计划

- **后端**：`test_layer_api.py` 增加 file_path 模式测试（excel-info/point/sector 传 file_path）、命名规则断言（文件名含源文件名 + sheet 名）
- **后端**：`test_layer_service.py` 增加命名测试（`_write` 传 source_filename/sheet_name）
- **前端**：type-check 0 新增；手动验证两栏布局、进度条、控件常驻

## 6. 范围外（YAGNI）

- 断点续传（当前失败重传整个文件，已有重试机制足够）
- 并发分块上传（当前串行，避免单 worker 排队超时）
- 图层文件历史管理
