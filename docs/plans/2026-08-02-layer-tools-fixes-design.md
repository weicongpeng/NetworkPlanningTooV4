# 图层制作问题修复设计文档

**日期**: 2026-08-02
**状态**: 已确认
**模块**: 图层制作（扇区图层、点图层）

## 1. 需求概述

修复图层制作 5 项问题：多格式打包丢失 TAB 配套文件、导入框布局、标签持久化、txt/csv 支持、失败小区输出。

### 问题清单

| # | 问题 | 类型 |
|---|------|------|
| 1 | 多格式（tab+mif+kml）生成时 zip 缺少 TAB 的 map/id/dat 配套文件；单独 tab 正常 | 打包 bug |
| 2 | 导入框与左侧卡片对齐、高度减半、文字横向展开 | UI |
| 3 | 未导入文件时属性/关键字标签不显示 | 持久化 |
| 4 | 导入文件不支持 txt/csv | 功能 |
| 5 | 生成统计只显示计数，失败小区不列出 | 功能 |

## 2. 技术方案

### 2.1 多格式打包修复（问题 1）

**根因**（已复现）：`layer.py` 的 `_finalize_outputs` 多格式分支用 `out.is_dir()` 判断多文件格式，但 TAB 的 `to_file` 输出是 `.tab` **文件**（配套 `.dat/.id/.map` 在同父目录），`is_dir()` 为 False → 走 `else` 分支只写 `.tab` 文件。单格式 `_zip_layer` 用 `glob("{base}.*")` 正确收集。

**修复**：多格式分支改为按 `out.stem` glob 父目录同名文件：

```python
def _finalize_outputs(outs: list, formats: list) -> dict:
    if len(outs) == 1:
        return _finalize_output(outs[0], formats[0])
    base = outs[0].stem
    zip_path = outs[0].parent / f"{base}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for out in outs:
            # TAB/MIF 是多文件格式：收集同 base 的所有配套文件
            if out.suffix in (".tab", ".mif") or out.is_dir():
                for f in out.parent.glob(f"{out.stem}.*"):
                    if f.name != zip_path.name:
                        zf.write(f, arcname=f.name)
            else:
                zf.write(out, arcname=out.name)
    return {"filename": zip_path.name, "download_url": f"/layer-files/{zip_path.name}"}
```

**效果**：TAB 收集 `.tab/.dat/.id/.map` 4 个，MIF 收集 `.mif/.mid` 2 个，KML 单文件。

### 2.2 导入框布局（问题 2）

**当前**：导入区是横跨全宽的大 `label`（`p-6` 纵向堆叠图标+文字）。

**改为**：与左栏对齐（3/5 宽）、高度约减半、文字横向展开：

```tsx
<div className="grid grid-cols-5 gap-6 mb-6">
  <div className="col-span-3">
    <label className="block flex items-center gap-3 px-6 py-3 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary transition-colors">
      <FileUp className="text-muted-foreground" size={20} />
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{state.fileName || t('layer.uploadExcel')}</p>
        <p className="text-xs text-muted-foreground">{t('layer.acceptExcel')}</p>
      </div>
      <input type="file" className="hidden" accept=".xlsx,.xls,.txt,.csv" onChange={handleFile} disabled={uploading} />
    </label>
  </div>
  <div className="col-span-2" />  {/* 右栏留空或放进度 */}
</div>
```

- 图标 + 两行文字**横向**排列在 3/5 宽内
- 高度从 `p-6` 降为 `py-3`（减半）
- 右侧 2/5 留空（或进度条移入）

### 2.3 标签持久化（问题 3）

**根因**：`renderTabContent` 里 `ts.columns.length > 0 ? <LayerAttributeConfig/> : <p>importHint</p>`，未导入前不渲染属性配置。

**修复**：`LayerAttributeConfig` 改造，**标签常驻**：

- 列勾选区：`columns.length > 0` 时显示 checkbox 列表，否则显示"请先导入"占位
- 关键字匹配：4 个标签（标签名称/经度/纬度/方向角）**始终显示**，未导入时下拉禁用且值为空
- `renderTabContent` 删除三元，直接渲染 `<LayerAttributeConfig/>`

**效果**：未导入前看到完整表单结构（标题 + 标签 + 空下拉），导入后自动填充。

### 2.4 txt/csv 支持（问题 4）

**后端**：
- `ALLOWED_EXTS = {".xlsx", ".xls", ".txt", ".csv"}`
- `layer_service._read_sheet` 按扩展名分派：
  ```python
  def _read_sheet(self, file_path, sheet_name):
      ext = Path(file_path).suffix.lower()
      if ext in (".csv", ".txt"):
          return self._read_text(file_path)
      return pd.read_excel(file_path, sheet_name=sheet_name, engine="calamine")
  ```
- 新增 `_read_text`（自动分隔符 + UTF-8/GBK 回退）：
  ```python
  def _read_text(self, file_path):
      raw = Path(file_path).read_bytes()
      try:
          text = raw.decode("utf-8-sig")
      except UnicodeDecodeError:
          text = raw.decode("gbk", errors="replace")
      return pd.read_csv(io.StringIO(text), sep=None, engine="python")
  ```
- `get_sheet_info` 对文本文件返回 `{"sheets": ["默认"], "columns": {"默认": [...]}}`

**前端**：
- 上传 `accept=".xlsx,.xls,.txt,.csv"`
- Sheet 选择器：`info.sheets` 为 `["默认"]` 时下拉固定显示"默认"且禁用（或仅一项）

### 2.5 失败小区列表（问题 5）

**根因**：`stats.failures` 只有分类计数，无失败行明细。

**后端**：`stats` 增加 `failedDetails` 数组：

```json
"failedDetails": [
  { "row": 3, "name": "小区A", "reason": "missing_coord" },
  { "row": 7, "name": "小区B", "reason": "invalid_azimuth" }
]
```

- `row` = Excel 行号（源行 + 表头 + 1）
- `name` = name_col 值（可能为空）
- `reason` = 分类：`missing_coord`/`invalid_coord`/`invalid_azimuth`/`missing_name`
- 逐行校验时收集失败行（在 `generate_point_layer`/`generate_sector_layer` 中）

**前端**：`renderResult` 统计区下方 `<details>` 可展开表格：

```tsx
{stats.failed > 0 && stats.failedDetails?.length > 0 && (
  <details className="mt-2">
    <summary className="text-amber-600 cursor-pointer text-xs">
      {t('layer.statsFailures')} ({stats.failed})
    </summary>
    <div className="max-h-40 overflow-y-auto mt-1 border border-border rounded-lg text-xs">
      <table>行号/标签名/原因</table>
    </div>
  </details>
)}
```

- `failedDetails` > 100 条时只显示前 100 + "等共 X 条"，避免渲染卡顿
- 失败分类文字用现有 `layer.statsMissingCoord` 等 i18n key

## 3. 数据流

```
用户选文件（xlsx/xls/txt/csv）
  → 分块上传（.txt/.csv 也走 file_path 模式）
  → getExcelInfo：Excel → sheets+columns；txt/csv → ["默认"]+columns
  → 配置（Sheet 默认/列勾选/字段映射/参数/多格式）
  → generateSector|Point：
      逐行校验 → 收集 failedDetails → 生成各格式 → 打包 zip（含配套文件）
      → 返回 {filename, download_url, stats{failedDetails}}
  → 前端展示统计 + 失败小区列表 + 下载
```

## 4. 错误处理

- 多格式 zip：`glob` 收集不到配套文件时 zip 仍含 `.tab`（可下载，MapInfo 打开缺配套）
- txt/csv 编码：UTF-8-sig → GBK 回退，GBK errors="replace" 兜底
- txt/csv 无表头：`get_sheet_info` 列名用 `0,1,2...`，用户需手动映射
- 失败列表超长：前端截断显示

## 5. 测试计划

- **后端** `test_layer_api.py`：
  - 多格式 `tab,mif` zip 含 `.tab/.dat/.id/.map/.mif/.mid`
- **后端** `test_layer_service.py`：
  - GBK csv、制表符 txt、UTF-8 csv 各生成点图层回读完整
  - `stats.failedDetails` 含正确 row/name/reason
- **前端**：type-check 0 新增；手动验证布局/标签持久化/失败列表

## 6. 范围外（YAGNI）

- 失败明细导出为文件（用户选页面内展示）
- txt/csv 多 sheet（文本无 sheet 概念）
- 自定义分隔符指定（自动探测足够）
