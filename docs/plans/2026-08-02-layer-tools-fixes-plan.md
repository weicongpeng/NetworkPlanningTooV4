# 图层制作问题修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复图层制作 5 项问题（多格式打包丢失 TAB 配套文件、导入框布局、标签持久化、txt/csv 支持、失败小区列表）

**Architecture:** 后端 `layer.py` 修 `_finalize_outputs` 打包 + `ALLOWED_EXTS` 加 txt/csv + stats 加 failedDetails；`layer_service.py` 加 `_read_text` 分派 txt/csv + 逐行收集失败明细；前端 `LayerToolsPage.tsx` 改导入框布局/标签常驻/失败列表，`LayerAttributeConfig.tsx` 改标签持久化。

**Tech Stack:** FastAPI + geopandas/pyogrio + React + Radix Tabs + sessionStorage

**设计文档:** `docs/plans/2026-08-02-layer-tools-fixes-design.md`（已提交 `aa66f1c`）

---

## 全局约定

- **测试命令**：`cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_service.py tests/test_layer_api.py -q 2>&1 | tail -5`
- **类型检查**：`cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep -E "LayerToolsPage|LayerAttributeConfig|api.ts" | grep -vE "api.ts\(158|api.ts\(1305" || echo "NO_TYPE_ERRORS_IN_TOUCHED_FILES"`
- **提交规范**：`Co-Authored-By: Claude <noreply@anthropic.com>`
- 分支：`layer-tools`
- 仓库有大量无关改动（mobile-app/、.omc/ 等），**只用 `git add <具体文件>`，不用 `git add -A`**

---

### Task 1: 后端多格式打包修复（问题 1）

**Files:**
- Modify: `backend/app/api/v1/endpoints/layer.py:46-62`（`_finalize_outputs`）
- Test: `backend/tests/test_layer_api.py`

**Step 1: 写失败测试**

在 `test_layer_api.py` 末尾追加：

```python
def test_point_endpoint_multi_format_zip_includes_tab_companions():
    """output_formats=tab,mif → zip 含 TAB 全部配套文件（.tab/.dat/.id/.map）和 MIF（.mif/.mid）"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE", "name_col": "NAME",
                    "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                    "attributes": '["NAME"]', "output_formats": "tab,mif",
                },
            )
        assert resp.status_code == 200
        dl = client.get(resp.json()["data"]["download_url"])
        assert dl.status_code == 200
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            names = zf.namelist()
        suffixes = {Path(n).suffix for n in names}
        # TAB 4 文件 + MIF 2 文件
        assert {".tab", ".dat", ".id", ".map", ".mif", ".mid"}.issubset(suffixes)
    finally:
        os.remove(path)
```

**Step 2: 运行测试验证失败**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_api.py::test_point_endpoint_multi_format_zip_includes_tab_companions -q 2>&1 | tail -8`
Expected: FAIL — zip 只含 `.tab/.mif`，缺 `.dat/.id/.map/.mid`

**Step 3: 实现修复**

修改 `_finalize_outputs`：

```python
def _finalize_outputs(outs: list, formats: list) -> dict:
    """单格式：TAB/MIF 打包 zip，KML 单文件；多格式：统一打包 zip。
    TAB 输出是 .tab 文件（配套 .dat/.id/.map 在同父目录），MIF 同理（.mif/.mid）。
    用 out.stem glob 父目录收集全部配套文件，保证 zip 完整。"""
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

**Step 4: 运行测试验证通过**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_api.py -q 2>&1 | tail -5`
Expected: 全部 PASS（含新增 + 原有 `test_point_endpoint_multi_format_zip`）

**Step 5: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add backend/app/api/v1/endpoints/layer.py backend/tests/test_layer_api.py
git commit -m "fix: 多格式打包收集TAB/MIF全部配套文件（glob同名）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 后端 txt/csv 支持（问题 4 后端部分）

**Files:**
- Modify: `backend/app/api/v1/endpoints/layer.py:22`（ALLOWED_EXTS）
- Modify: `backend/app/services/layer_service.py:101-108`（_read_sheet）+ `:377-385`（get_sheet_info）
- Test: `backend/tests/test_layer_service.py`

**Step 1: 写失败测试**

```python
def test_read_text_csv_gbk(service, tmp_path):
    """GBK 编码 csv → 自动编码回退读取，列名/值完整"""
    path = tmp_path / "工参.csv"
    raw = "小区名称,经度,纬度\n基站A,116.4,39.9\n".encode("gbk")
    path.write_bytes(raw)
    df = service._read_sheet(str(path), "默认")
    assert "小区名称" in df.columns
    assert df["小区名称"].tolist() == ["基站A"]


def test_read_text_txt_tab(service, tmp_path):
    """制表符分隔 txt → 自动探测分隔符读取"""
    path = tmp_path / "工参.txt"
    raw = "小区名称\t经度\t纬度\n基站B\t116.5\t40.0\n".encode("utf-8")
    path.write_bytes(raw)
    df = service._read_sheet(str(path), "默认")
    assert "小区名称" in df.columns
    assert df["小区名称"].tolist() == ["基站B"]


def test_get_sheet_info_txt_returns_default(service, tmp_path):
    """txt/csv 的 get_sheet_info 返回 sheets=['默认']"""
    path = tmp_path / "工参.csv"
    raw = "小区名称,经度,纬度\n基站A,116.4,39.9\n".encode("utf-8")
    path.write_bytes(raw)
    info = service.get_sheet_info(str(path))
    assert info["sheets"] == ["默认"]
    assert "小区名称" in info["columns"]["默认"]
```

**Step 2: 运行测试验证失败**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_service.py::test_read_text_csv_gbk tests/test_layer_service.py::test_read_text_txt_tab tests/test_layer_service.py::test_get_sheet_info_txt_returns_default -q 2>&1 | tail -8`
Expected: FAIL — `pd.read_excel` 对 csv 报错

**Step 3: 实现**

`layer_service.py` 加 `_read_text`，改造 `_read_sheet` 和 `get_sheet_info`：

```python
# 文件顶部加 import io
import io

def _read_text(self, file_path: str) -> pd.DataFrame:
    """读取 CSV/TXT：自动探测分隔符，UTF-8 → GBK 编码回退。
    返回 DataFrame，列名为首行。"""
    raw = Path(file_path).read_bytes()
    try:
        text = raw.decode("utf-8-sig")   # 兼容 BOM
    except UnicodeDecodeError:
        text = raw.decode("gbk", errors="replace")
    return pd.read_csv(io.StringIO(text), sep=None, engine="python")

def _read_sheet(self, file_path: str, sheet_name: str) -> pd.DataFrame:
    """读取指定 sheet，返回 DataFrame。txt/csv 无 sheet 概念，忽略 sheet_name。"""
    ext = Path(file_path).suffix.lower()
    if ext in (".csv", ".txt"):
        return self._read_text(file_path)
    try:
        return pd.read_excel(file_path, sheet_name=sheet_name, engine="calamine")
    except ValueError as e:
        raise ValueError(f"Sheet 不存在: {sheet_name}") from e

def get_sheet_info(self, file_path: str) -> dict:
    """读取文件的 sheet 列表和各 sheet 列名。txt/csv 返回 ['默认']。"""
    ext = Path(file_path).suffix.lower()
    if ext in (".csv", ".txt"):
        df = self._read_text(file_path)
        return {"sheets": ["默认"], "columns": {"默认": [str(c) for c in df.columns]}}
    xls = pd.ExcelFile(file_path, engine="calamine")
    sheets = xls.sheet_names
    columns = {}
    for s in sheets:
        df = pd.read_excel(xls, sheet_name=s, nrows=1)
        columns[s] = [str(c) for c in df.columns]
    return {"sheets": sheets, "columns": columns}
```

`layer.py` 的 `ALLOWED_EXTS`：

```python
ALLOWED_EXTS = {".xlsx", ".xls", ".txt", ".csv"}
```

**Step 4: 运行测试验证通过**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_service.py -q 2>&1 | tail -5`
Expected: 全部 PASS（含新增 3 + 原有）

**Step 5: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add backend/app/services/layer_service.py backend/app/api/v1/endpoints/layer.py backend/tests/test_layer_service.py
git commit -m "feat: 图层制作支持txt/csv导入（自动分隔符+UTF8/GBK回退）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 后端失败小区明细（问题 5 后端部分）

**Files:**
- Modify: `backend/app/services/layer_service.py:275-370`（generate_point_layer/generate_sector_layer）
- Test: `backend/tests/test_layer_service.py`

**Step 1: 写失败测试**

```python
def test_failed_details_in_stats(service, tmp_path):
    """stats.failedDetails 含失败行（row/name/reason）"""
    path = tmp_path / "mixed.xlsx"
    df = pd.DataFrame({
        "NAME": ["A", "B", "C"],
        "LONGITUDE": [116.3, None, 999],
        "LATITUDE": [39.9, 39.8, 39.7],
    })
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, stats = service.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="tab",
    )
    assert stats["failed"] == 2
    details = stats["failedDetails"]
    assert len(details) == 2
    # B: missing_coord, C: invalid_coord；row 从 3 开始（表头 1 + 数据 2 行）
    reasons = {d["name"]: d["reason"] for d in details}
    assert reasons["B"] == "missing_coord"
    assert reasons["C"] == "invalid_coord"
    # row = Excel 行号：A 是第2行，B 是第3行，C 是第4行
    for d in details:
        assert d["row"] in (3, 4)
```

**Step 2: 运行测试验证失败**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_service.py::test_failed_details_in_stats -q 2>&1 | tail -8`
Expected: FAIL — stats 无 `failedDetails` 键

**Step 3: 实现**

在 `generate_point_layer` 中收集失败明细。核心：逐行确定每行失败原因。在现有 `_coerce_coords` 基础上补充：

```python
def _row_reason(self, df, i, lon_col, lat_col, azimuth_col=None, name_col=None):
    """返回第 i 行的失败原因（None = 通过）。优先级：坐标 > 方位角 > 标签名。"""
    lon = pd.to_numeric(df[lon_col], errors="coerce").iloc[i]
    lat = pd.to_numeric(df[lat_col], errors="coerce").iloc[i]
    if pd.isna(lon) or pd.isna(lat):
        return "missing_coord"
    if not (-180 <= lon <= 180) or not (-90 <= lat <= 90):
        return "invalid_coord"
    if azimuth_col is not None and azimuth_col in df.columns:
        azi = pd.to_numeric(df[azimuth_col], errors="coerce").iloc[i]
        if pd.isna(azi) or not (0 <= azi <= 360):
            return "invalid_azimuth"
    if name_col and name_col in df.columns:
        nm = df[name_col].iloc[i]
        if pd.isna(nm) or str(nm).strip() == "":
            return "missing_name"
    return None
```

在 `generate_point_layer` 的 stats 构造前加：

```python
        failed_details = []
        for i in df.index:
            if valid.loc[i]:
                continue
            reason = self._row_reason(df, df.index.get_loc(i), lon_col, lat_col,
                                      name_col=name_col)
            nm = str(df[name_col].iloc[i]) if (name_col and name_col in df.columns and not pd.isna(df[name_col].iloc[i])) else ""
            failed_details.append({
                "row": int(i) + 2,   # Excel 行号 = 数据索引 + 表头 + 1
                "name": nm,
                "reason": reason or "unknown",
            })
```

在 stats dict 中加：

```python
        stats = {
            "total": int(len(df)),
            "success": int(valid.sum()),
            "failed": int(len(df) - valid.sum()),
            "failures": {k: int(v) for k, v in failures.items()},
            "failedDetails": failed_details,
        }
```

> **注意**：`df.index` 在 `pd.read_excel` 后是 `0,1,2...`（RangeIndex）。若源 Excel 有默认索引则 `i` 就是 0-based 行号，`row = i + 2`（表头 1 行 + 索引偏移）。若源数据从第 2 行开始（无默认索引），`i` 仍是 0-based，`row = i + 2` 正确表示 Excel 行号。

`generate_sector_layer` 同样改造（`_row_reason` 传 `azimuth_col`）。

**Step 4: 运行测试验证通过**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_service.py -q 2>&1 | tail -5`
Expected: 全部 PASS

**Step 5: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add backend/app/services/layer_service.py backend/tests/test_layer_service.py
git commit -m "feat: 图层生成统计增加失败小区明细（行号/标签名/原因）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 前端导入框布局 + 标签持久化（问题 2、3）

**Files:**
- Modify: `frontend/src/renderer/pages/LayerToolsPage.tsx`（导入框 + renderTabContent）
- Modify: `frontend/src/renderer/components/layer/LayerAttributeConfig.tsx`（标签常驻）
- Modify: `frontend/src/renderer/services/api.ts`（GenerateLayerResult 加 stats 类型 —— 若未含）
- Test: `frontend/src/renderer/locales/zh.json` / `en.json`

**Step 1: LayerAttributeConfig 标签常驻**

改造 `LayerAttributeConfig.tsx`：

```tsx
return (
  <div className="space-y-4">
    {/* 列勾选 */}
    <div>
      <p className="text-xs font-medium mb-2">{t('layer.selectAttributes')}</p>
      <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto border border-border rounded-lg p-3">
        {columns.length > 0 ? columns.map(col => (
          <label key={col} className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={!!selectedFields[col]} onChange={e => toggleAttribute(col, e.target.checked)} />
            <span className="truncate">{col}</span>
          </label>
        )) : (
          <p className="text-xs text-muted-foreground col-span-2 py-4 text-center">{t('layer.importHint')}</p>
        )}
      </div>
    </div>

    {/* 关键字匹配（标签常驻，值空时禁用） */}
    <div className="space-y-2">
      <p className="text-xs font-medium">{t('layer.keywordMatch')}</p>
      {fieldTypes.map(f => (
        <div key={f.type} className="flex items-center gap-2">
          <label htmlFor={`layer-field-${f.type}`} className="text-xs text-muted-foreground w-20">{t(f.labelKey)}</label>
          <select
            id={`layer-field-${f.type}`}
            value={fieldMappings[f.type] || ''}
            onChange={e => onFieldMappingsChange({ ...fieldMappings, [f.type]: e.target.value })}
            disabled={columns.length === 0}
            className="flex-1 h-8 px-2 text-xs border border-border rounded bg-card disabled:opacity-50"
          >
            <option value="">{t('layer.selectColumn')}</option>
            {columns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      ))}
    </div>
  </div>
)
```

**Step 2: LayerToolsPage 导入框布局 + renderTabContent**

导入区改为与左栏（3/5）对齐、高度减半、文字横向：

```tsx
{/* ① 导入区（与左栏对齐，高度减半，文字横向） */}
<div className="grid grid-cols-5 gap-6 mb-6">
  <div className="col-span-3">
    <label className="block flex items-center gap-3 px-6 py-3 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary transition-colors">
      <FileUp className="text-muted-foreground shrink-0" size={20} />
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{state.fileName || t('layer.uploadExcel')}</p>
        <p className="text-xs text-muted-foreground">{t('layer.acceptExcel')}</p>
      </div>
      <input type="file" className="hidden" accept=".xlsx,.xls,.txt,.csv" onChange={handleFile} disabled={uploading} />
    </label>
    {uploading && progress && (
      <div className="mt-2">
        <div className="h-2 bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress.percent}%` }} />
        </div>
        <p className="text-xs text-muted-foreground mt-1">{progressText()}</p>
      </div>
    )}
  </div>
  <div className="col-span-2" />
</div>
```

`renderTabContent` 中删掉三元，直接渲染 `LayerAttributeConfig`：

```tsx
{/* ③ 属性配置（标签常驻） */}
<div className="p-4 bg-card border border-border rounded-lg">
  <LayerAttributeConfig
    columns={ts.columns}
    includeAzimuth={includeAzimuth}
    selectedFields={ts.selectedFields}
    onSelectedFieldsChange={(v) => setTab(s => ({ ...s, selectedFields: v }))}
    fieldMappings={ts.fieldMappings}
    onFieldMappingsChange={(v) => setTab(s => ({ ...s, fieldMappings: v }))}
  />
</div>
```

**Step 3: Sheet 选择器对 txt/csv 固定"默认"**

```tsx
<select ... disabled={!ts.info || ts.info.sheets.length === 0 || ts.info.sheets.length === 1}
  ...
  {ts.info && ts.info.sheets.length > 0
    ? ts.info.sheets.map(s => <option key={s} value={s}>{s}</option>)
    : <option value="">{t('layer.importHint')}</option>}
</select>
```

当 `sheets.length === 1`（txt/csv 的 `["默认"]` 或单 sheet Excel）时下拉禁用。可选：单 sheet 时隐藏下拉显示"默认"。

**Step 4: 验证**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep -E "LayerToolsPage|LayerAttributeConfig" || echo "NO_TYPE_ERRORS_IN_TOUCHED_FILES"`
Expected: NO_TYPE_ERRORS_IN_TOUCHED_FILES

**Step 5: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/pages/LayerToolsPage.tsx frontend/src/renderer/components/layer/LayerAttributeConfig.tsx frontend/src/renderer/services/api.ts frontend/src/renderer/locales/
git commit -m "feat: 导入框布局调整+属性/关键字标签常驻

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 前端失败小区列表展示（问题 5 前端部分）

**Files:**
- Modify: `frontend/src/renderer/pages/LayerToolsPage.tsx`（renderResult）
- Modify: `frontend/src/renderer/services/api.ts`（GenerateLayerResult.stats.failedDetails 类型）
- Modify: `frontend/src/renderer/locales/zh.json` / `en.json`

**Step 1: api.ts 类型**

`GenerateLayerResult` 的 stats 加 `failedDetails`：

```typescript
export interface GenerateLayerResult {
  filename: string
  download_url: string
  stats?: {
    total: number
    success: number
    failed: number
    failures: Record<string, number>
    failedDetails?: Array<{ row: number; name: string; reason: string }>
  }
}
```

**Step 2: i18n keys**

`zh.json` 的 `layer` 加：
```json
"statsRow": "行号",
"statsName": "标签名",
"statsReason": "失败原因",
"statsMore": "等共 {count} 条"
```
`en.json` 对应：
```json
"statsRow": "Row",
"statsName": "Name",
"statsReason": "Reason",
"statsMore": "... and {count} more"
```

**Step 3: renderResult 失败列表**

```tsx
{ts.result.stats.failed > 0 && ts.result.stats.failedDetails && ts.result.stats.failedDetails.length > 0 && (
  <details className="mt-2">
    <summary className="text-amber-600 cursor-pointer text-xs flex items-center gap-1">
      <span>{t('layer.statsFailures')} ({ts.result.stats.failed})</span>
    </summary>
    <div className="max-h-40 overflow-y-auto mt-1 border border-border rounded-lg text-xs">
      <table className="w-full text-left">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-border">
            <th className="px-2 py-1 font-medium">{t('layer.statsRow')}</th>
            <th className="px-2 py-1 font-medium">{t('layer.statsName')}</th>
            <th className="px-2 py-1 font-medium">{t('layer.statsReason')}</th>
          </tr>
        </thead>
        <tbody>
          {ts.result.stats.failedDetails.slice(0, 100).map((d, i) => (
            <tr key={i} className="border-b border-border/50">
              <td className="px-2 py-1">{d.row}</td>
              <td className="px-2 py-1 truncate max-w-[8rem]">{d.name || '-'}</td>
              <td className="px-2 py-1">{reasonLabel(d.reason, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {ts.result.stats.failedDetails.length > 100 && (
        <p className="px-2 py-1 text-muted-foreground">
          {t('layer.statsMore').replace('{count}', String(ts.result.stats.failedDetails.length - 100))}
        </p>
      )}
    </div>
  </details>
)}
```

定义 `reasonLabel`：

```typescript
const reasonLabel = (reason: string, t: any) => {
  const map: Record<string, string> = {
    missing_coord: t('layer.statsMissingCoord'),
    invalid_coord: t('layer.statsInvalidCoord'),
    invalid_azimuth: t('layer.statsInvalidAzimuth'),
    missing_name: t('layer.statsMissingName'),
  }
  return map[reason] || reason
}
```

**Step 4: 验证**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep -E "LayerToolsPage|api.ts" | grep -vE "api.ts\(158|api.ts\(1305" || echo "NO_TYPE_ERRORS_IN_TOUCHED_FILES"`
Expected: NO_TYPE_ERRORS_IN_TOUCHED_FILES

**Step 5: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/pages/LayerToolsPage.tsx frontend/src/renderer/services/api.ts frontend/src/renderer/locales/
git commit -m "feat: 生成统计展示失败小区明细列表（行号/标签名/原因）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 回归验证 + 收尾

**Step 1: 后端全量测试**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_service.py tests/test_layer_api.py -q 2>&1 | tail -5`
Expected: 全部 PASS

**Step 2: 前端类型检查**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep -E "LayerToolsPage|LayerAttributeConfig|api.ts" | grep -vE "api.ts\(158|api.ts\(1305" || echo "NO_TYPE_ERRORS_IN_TOUCHED_FILES"`
Expected: NO_TYPE_ERRORS_IN_TOUCHED_FILES

**Step 3: 前端构建**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx vite build 2>&1 | tail -5`
Expected: build 成功

**Step 4: 检查无遗留引用**

Run: `grep -rn "importHint" frontend/src/renderer/components/layer/ frontend/src/renderer/pages/LayerToolsPage.tsx`
Expected: `importHint` 仅在 LayerAttributeConfig 内使用（标签常驻后不再出现在 renderTabContent 三元）

**Step 5: Commit（如有收尾改动）**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add -u frontend/ backend/
git commit -m "chore: 图层制作问题修复回归验证

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 执行顺序与依赖

```
Task 1 (打包修复) ──┐
Task 2 (txt/csv)  ──┼── 后端独立，可并行
Task 3 (失败明细)  ──┘
Task 4 (布局+标签) ──→ Task 5 (失败列表) ──→ Task 6 (回归)
```

Task 1-3 后端独立可并行；Task 4-5 前端顺序依赖；Task 6 收尾。

## 风险与注意

- **`_finalize_outputs` glob**：`out.stem` 收集父目录同名文件，可能误收其他文件的同名不同后缀（少见，同名同 basename 不同扩展名是目标配套文件，符合预期）
- **txt/csv 编码**：GBK 文件 `errors="replace"` 兜底，极端混合编码可能部分乱码
- **`_row_reason` 性能**：逐行 `pd.to_numeric(...).iloc[i]` 对 10 万行较慢。优化：先向量化算好 lon/lat/azi 数组，再逐行判断。实现时用预计算数组。
- **row 行号**：`i + 2`（表头 1 行）。若源 Excel 表头在首行，数据第 2 行起，`i=0` → row=2 正确。
- **前端 accept**：`.txt,.csv` 需同步到上传 input。
- **预存类型错误**：api.ts(158/1305)、MainLayout(128) 是预存，排除。
