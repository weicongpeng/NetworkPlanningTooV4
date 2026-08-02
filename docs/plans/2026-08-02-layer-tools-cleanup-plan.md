# 图层制作历史清理/文案/UI布局 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复图层制作 3 项问题（文件支持提示缺 txt/csv、二次生成历史文件残留+zip 重复、UI 布局导入区上移共享）

**Architecture:** 后端 `layer_service.py` 加 `_cleanup_old_outputs` 生成前删同 base 历史文件；`layer.py` 的 `_finalize_outputs` 用 set 去重；前端 `LayerToolsPage.tsx` 导入区上移+加"文件导入"标签、Tabs 下移，`locales` 文案加 txt/csv。

**Tech Stack:** FastAPI + geopandas/pyogrio + React + Radix Tabs

**设计文档:** `docs/plans/2026-08-02-layer-tools-cleanup-design.md`（已提交 `8af8019`）

---

## 全局约定

- **测试命令**：`cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_service.py tests/test_layer_api.py -q 2>&1 | tail -5`
- **类型检查**：`cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep -E "LayerToolsPage|api.ts" | grep -vE "api.ts\(158|api.ts\(1306|MainLayout.tsx\(128" || echo "NO_TYPE_ERRORS_IN_TOUCHED_FILES"`
- **提交规范**：`Co-Authored-By: Claude <noreply@anthropic.com>`
- 分支：`layer-tools`
- 仓库有大量无关改动（mobile-app/、.omc/ 等），**只用 `git add <具体文件>`，不用 `git add -A`**

---

### Task 1: 后端历史文件清理（问题 2a）

**Files:**
- Modify: `backend/app/services/layer_service.py`（加 `_cleanup_old_outputs` + 两个 generate 函数调用）
- Test: `backend/tests/test_layer_service.py`

**Step 1: 写失败测试**

在 `test_layer_service.py` 末尾追加：

```python
def test_repeat_generate_cleans_old_outputs(service, tmp_path):
    """二次生成后 output_dir 只保留最新 base 文件（无 -1 后缀历史残留）"""
    path = tmp_path / "工参.xlsx"
    df = pd.DataFrame({"NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)

    # 第一次生成
    out1, _ = service.generate_point_layer(
        str(path), "LTE", "NAME", "LONGITUDE", "LATITUDE", ["NAME"], "tab",
        source_filename="工参.xlsx",
    )
    assert out1.name == "工参_LTE.tab"

    # 第二次生成（应清理旧的，产出同名而非 -1）
    out2, _ = service.generate_point_layer(
        str(path), "LTE", "NAME", "LONGITUDE", "LATITUDE", ["NAME"], "tab",
        source_filename="工参.xlsx",
    )
    assert out2.name == "工参_LTE.tab"
    # 无 -1 历史残留
    assert not (tmp_path / "工参_LTE-1.tab").exists()
```

**Step 2: 运行测试验证失败**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_service.py::test_repeat_generate_cleans_old_outputs -q 2>&1 | tail -8`
Expected: FAIL — 第二次生成产出 `工参_LTE-1.tab`（`_unique_path` 加后缀）

**Step 3: 实现**

在 `layer_service.py` 加 `_cleanup_old_outputs`：

```python
def _cleanup_old_outputs(self, base: str):
    """生成前删除同 base 的历史输出（.tab/.dat/.id/.map/.mif/.mid/.zip）"""
    for f in self.output_dir.glob(f"{base}*"):
        if f.suffix in (".tab", ".dat", ".id", ".map", ".mif", ".mid", ".zip"):
            f.unlink(missing_ok=True)
```

在 `generate_point_layer` 和 `generate_sector_layer` 的 `_read_sheet` 后、生成前调用。两个函数在 `_read_sheet` 后有类似结构，插入：

```python
        df = self._read_sheet(file_path, sheet_name)
        # 生成前清理同 base 历史输出（base = 源文件名stem + sheet 名）
        base = _truncate_bytes(Path(source_filename or Path(file_path).name).stem, 100)
        safe_sheet = _truncate_bytes(re.sub(r'[<>:"/\\|?*]', "_", sheet_name), 50)
        self._cleanup_old_outputs(f"{base}_{safe_sheet}")
```

> 注意：`source_filename` 在函数签名中是可选参数。`generate_point_layer` 的 `source_filename` 参数已存在，直接用。确保清理放在 `_read_sheet` 之后（避免空文件也触发），且 `_write` 中仍用 `source_filename` 生成 fname。

**Step 4: 运行测试验证通过**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_service.py -q 2>&1 | tail -5`
Expected: 全部 PASS

**Step 5: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add backend/app/services/layer_service.py backend/tests/test_layer_service.py
git commit -m "feat: 图层生成前清理同base历史文件（不保留历史版本）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 后端 zip 去重（问题 2b）

**Files:**
- Modify: `backend/app/api/v1/endpoints/layer.py:46-62`（`_finalize_outputs`）
- Test: `backend/tests/test_layer_api.py`

**Step 1: 写失败测试**

在 `test_layer_api.py` 末尾追加：

```python
def test_multi_format_zip_no_duplicate_names():
    """多格式 zip 无重复文件名（tab/mif 共享 stem 时去重）"""
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
        # 无重复文件名
        assert len(names) == len(set(names)), f"zip 内容重复: {names}"
        # 仍含全部配套文件
        suffixes = {Path(n).suffix for n in names}
        assert {".tab", ".dat", ".id", ".map", ".mif", ".mid"}.issubset(suffixes)
    finally:
        os.remove(path)
```

**Step 2: 运行测试验证失败**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_api.py::test_multi_format_zip_no_duplicate_names -q 2>&1 | tail -8`
Expected: FAIL — zip 内容有重复（tab 和 mif 各自 glob 匹配对方）

**Step 3: 实现**

修改 `_finalize_outputs` 加 set 去重：

```python
def _finalize_outputs(outs: list, formats: list) -> dict:
    """单格式：TAB/MIF 打包 zip，KML 单文件；多格式：统一打包 zip。
    TAB 输出是 .tab 文件（配套 .dat/.id/.map 在同父目录），MIF 同理。
    tab/mif 共享 stem 时各自 glob 会匹配对方，用 written set 去重。"""
    if len(outs) == 1:
        return _finalize_output(outs[0], formats[0])
    base = outs[0].stem
    zip_path = outs[0].parent / f"{base}.zip"
    written = set()  # 已写入的文件名，去重
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for out in outs:
            if out.suffix in (".tab", ".mif") or out.is_dir():
                for f in out.parent.glob(f"{out.stem}.*"):
                    if f.name != zip_path.name and f.name not in written:
                        zf.write(f, arcname=f.name)
                        written.add(f.name)
            else:
                if out.name not in written:
                    zf.write(out, arcname=out.name)
                    written.add(out.name)
    return {"filename": zip_path.name, "download_url": f"/layer-files/{zip_path.name}"}
```

**Step 4: 运行测试验证通过**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_api.py -q 2>&1 | tail -5`
Expected: 全部 PASS

**Step 5: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add backend/app/api/v1/endpoints/layer.py backend/tests/test_layer_api.py
git commit -m "fix: 多格式zip去重（tab/mif共享stem时避免重复打包）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 前端文案 + UI 布局（问题 1、3）

**Files:**
- Modify: `frontend/src/renderer/pages/LayerToolsPage.tsx`（导入区上移 + "文件导入"标签）
- Modify: `frontend/src/renderer/locales/zh.json` / `en.json`

**Step 1: i18n 文案**

`zh.json`：
- `acceptExcel`: `"支持 .xlsx / .xls / .txt / .csv"`
- 新增 `"fileImport": "文件导入"`

`en.json`：
- `acceptExcel`: `"Supports .xlsx / .xls / .txt / .csv"`
- 新增 `"fileImport": "File Import"`

**Step 2: LayerToolsPage 布局调整**

当前结构（导入区在 Tabs.List 下方）：
```tsx
<Tabs.Root value={activeTab} onValueChange={...}>
  <Tabs.List>...</Tabs.List>
  {/* ① 导入区 */}
  <div className="grid grid-cols-5 gap-6 mb-6">...</div>
  <Tabs.Content value="sector">...</Tabs.Content>
  <Tabs.Content value="point">...</Tabs.Content>
</Tabs.Root>
```

改为（导入区+"文件导入"标签上移到 Tabs.List 前）：
```tsx
<Tabs.Root value={activeTab} onValueChange={...}>
  {/* ① 文件导入（共享，最上层） */}
  <div className="mb-6">
    <p className="text-sm font-bold mb-2">{t('layer.fileImport')}</p>
    <div className="grid grid-cols-5 gap-6">
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
  </div>

  {/* ② 扇区/点图 Tab（下移） */}
  <Tabs.List className="flex gap-2 mb-6 border-b border-border" aria-label={t('nav.layerTools')}>
    ...
  </Tabs.List>
  <Tabs.Content value="sector">...</Tabs.Content>
  <Tabs.Content value="point">...</Tabs.Content>
</Tabs.Root>
```

**Step 3: 验证**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep -E "LayerToolsPage" || echo "NO_TYPE_ERRORS_IN_TOUCHED_FILES"`
Expected: NO_TYPE_ERRORS_IN_TOUCHED_FILES

**Step 4: Commit**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add frontend/src/renderer/pages/LayerToolsPage.tsx frontend/src/renderer/locales/
git commit -m "feat: 文件导入区上移共享+“文件导入”标签+支持txt/csv提示

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 回归验证 + 收尾

**Step 1: 后端全量测试**

Run: `cd /home/pwc/NetworkPlanningTooV3/backend && .venv/bin/python -m pytest tests/test_layer_service.py tests/test_layer_api.py -q 2>&1 | tail -5`
Expected: 全部 PASS

**Step 2: 前端类型检查**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx tsc --noEmit 2>&1 | grep -E "LayerToolsPage|api.ts" | grep -vE "api.ts\(158|api.ts\(1306|MainLayout.tsx\(128" || echo "NO_TYPE_ERRORS_IN_TOUCHED_FILES"`
Expected: NO_TYPE_ERRORS_IN_TOUCHED_FILES

**Step 3: 前端构建**

Run: `cd /home/pwc/NetworkPlanningTooV3/frontend && npx vite build 2>&1 | tail -5`
Expected: build 成功

**Step 4: Commit（如有收尾改动）**

```bash
cd /home/pwc/NetworkPlanningTooV3
git add backend/ frontend/
git commit -m "chore: 图层制作历史清理/文案/UI布局回归验证

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 执行顺序与依赖

```
Task 1 (历史清理) ──┐
Task 2 (zip去重)   ──┼── 后端独立，可并行
Task 3 (前端布局)  ──┘
Task 4 (回归)
```

Task 1-3 相互独立（不同文件），可并行或顺序执行；Task 4 收尾。

## 风险与注意

- **`_cleanup_old_outputs` glob 边界**：`glob(f"{base}*")` 匹配 `工参_LTE` 和 `工参_LTE-1` 等，但只删指定后缀（.tab/.dat/.id/.map/.mif/.mid/.zip），不会误删源文件 `.xlsx`。
- **清理时机**：放在 `_read_sheet` 之后（文件能读才清，避免空文件误删），生成前。
- **`_unique_path` 与清理协作**：清理后无冲突，直接产出 `工参_LTE.tab`（不再 `-1`）。
- **zip 去重**：set 记录已写文件名，tab/mif 共享 stem 不再重复。
- **预存类型错误**：api.ts(158/1306)、MainLayout(128) 是预存，排除。
