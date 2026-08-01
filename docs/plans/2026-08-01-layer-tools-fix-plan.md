# 图层制作功能修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复图层制作工具在生产外网导入大文件报 Cloudflare 超时问题，并优化页面交互（进度提示、控件常驻、两栏布局、导出命名规则）。

**Architecture:** 复用现有分块上传机制（`chunkedUpload` 前端 + `/data/upload/start|chunk|complete` 后端），后端 `complete` 增加 `file_type='layer'` 分支只重组文件不建索引，返回 `file_path`。前端 `layerToolsApi` 改为基于 `file_path` 调用（上传只发生一次）。页面重构为两栏布局，控件常驻 + 进度提示。后端 `layer_service._write` 按"源文件名_sheet名"命名。

**Tech Stack:** Python (FastAPI, pandas, geopandas) / TypeScript (React 18, i18next, Tailwind, lucide-react)

---

## Task 1: 后端 complete 增加 file_type='layer' 分支

**Files:**
- Modify: `backend/app/api/v1/endpoints/data.py`（`complete_chunked_upload`，约 line 1001-1150）

### Step 1: Write the failing test

追加到 `backend/tests/test_layer_api.py`：

```python
def test_chunked_upload_layer_file_type():
    """分块上传 + file_type='layer' 应重组文件返回 file_path，不建 data 索引"""
    import pandas as pd, tempfile, os
    from pathlib import Path
    from app.core.config import settings

    # 构造小 Excel
    path = tempfile.mktemp(suffix=".xlsx")
    pd.DataFrame({"NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9]}).to_excel(path, sheet_name="S", index=False)
    file_size = os.path.getsize(path)
    chunk_size = 2 * 1024 * 1024
    total_chunks = 1

    app = create_app()
    client = TestClient(app)

    try:
        # start
        r = client.post("/api/v1/data/upload/start",
            data={"filename": "test.xlsx", "total_chunks": "1", "total_size": str(file_size)})
        assert r.status_code == 200
        data_id = r.json()["data"]["id"]

        # chunk
        with open(path, "rb") as f:
            r2 = client.post(f"/api/v1/data/upload/{data_id}/chunk",
                data={"chunk_index": "0"},
                files={"file": ("chunk", f, "application/octet-stream")})
        assert r2.status_code == 200

        # complete with file_type='layer'
        r3 = client.post(f"/api/v1/data/upload/{data_id}/complete",
            data={"filename": "test.xlsx", "file_type": "layer"})
        assert r3.status_code == 200
        body = r3.json()
        assert body["success"] is True
        assert "file_path" in body["data"]
        # 断言返回的 file_path 指向 layer_tmp 目录且文件存在
        fp = body["data"]["file_path"]
        assert "layer_tmp" in fp
        assert Path(fp).exists()

        # 断言没有创建 data 索引（layer 类型不建索引）
        from app.services.data_service import data_service
        assert data_id not in data_service.index
    finally:
        os.remove(path)
```

> 需要 import `create_app`（`from app.api import create_app`）和 `TestClient`（已在文件顶部）。若 `_make_client` helper 存在，用它代替手动 dependency_override。

### Step 2: Run test to verify it fails

```bash
cd backend && .venv/bin/python -m pytest tests/test_layer_api.py::test_chunked_upload_layer_file_type -v
```

Expected: FAIL — `KeyError: 'file_path'`（complete 未返回 file_path，走默认 excel 分支）

### Step 3: Implement

在 `backend/app/api/v1/endpoints/data.py` 的 `complete_chunked_upload` 中，`if file_type == "geo_data":` 分支之前（约 line 1054 前）插入 `file_type == "layer"` 分支：

```python
    if file_type == "layer":
        # 图层制作：只重组文件到 layer_tmp，不建 data 索引，返回 file_path
        # 前端后续用 file_path 调用 /layer/excel-info 和 /layer/point|sector（上传只发生一次）
        layer_tmp = settings.UPLOAD_DIR / "layer_tmp"
        layer_tmp.mkdir(parents=True, exist_ok=True)
        # 复用已重组的 file_path（上面已从分块重组到 settings.UPLOAD_DIR / f"{data_id}{ext}"）
        dest = layer_tmp / f"src_{data_id[:8]}{ext}"
        shutil.copy(file_path, dest)
        # 清理 uploads 根目录的重组临时文件
        try:
            file_path.unlink(missing_ok=True)
        except Exception:
            pass
        print(f"[ChunkedUpload] 图层文件已保存: {dest}")
        return {
            "success": True,
            "data": {
                "file_path": str(dest),
                "name": safe_filename,
            },
        }
    elif file_type == "geo_data":
```

> 注意：`file_path` 变量名在 complete 中已被占用（重组后的文件路径，约 line 1044 `file_path = settings.UPLOAD_DIR / f"{data_id}{ext}"`）。上面代码用 `file_path` 指向重组文件，`dest` 是 layer_tmp 目标。若变量名冲突，改用其他名（如 `reassembled_path`）。

### Step 4: Run test to verify it passes

```bash
cd backend && .venv/bin/python -m pytest tests/test_layer_api.py -v
```

Expected: PASS（含新增的 chunked layer 测试）

### Step 5: Commit

```bash
git add backend/app/api/v1/endpoints/data.py backend/tests/test_layer_api.py
git commit -m "feat: 分块上传支持 file_type=layer 仅重组不建索引"
```

---

## Task 2: 后端 layer.py 端点改用 file_path 模式

**Files:**
- Modify: `backend/app/api/v1/endpoints/layer.py`

### Step 1: Write the failing test

追加到 `backend/tests/test_layer_api.py`：

```python
def test_layer_endpoints_accept_file_path():
    """图层端点应接受 file_path（已上传文件路径）而非必须 file 上传"""
    import pandas as pd, tempfile, os
    from pathlib import Path

    path = tempfile.mktemp(suffix=".xlsx")
    pd.DataFrame({"NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9]}).to_excel(path, sheet_name="S", index=False)

    app = create_app()
    client = TestClient(app)

    try:
        # excel-info 传 file_path
        r = client.post("/api/v1/layer/excel-info",
            data={"file_path": path})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["success"] is True
        assert "S" in body["data"]["sheets"]

        # sector 传 file_path（需含方位角，用非零值）
        r2 = client.post("/api/v1/layer/sector",
            data={"file_path": path, "sheet_name": "S", "name_col": "NAME",
                  "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                  "azimuth_col": "AZIMUTH", "attributes": '["NAME"]',
                  "output_format": "kml"})
        assert r2.status_code == 200, r2.text
    finally:
        os.remove(path)
```

> 注意：上面测试的 Excel 没有 AZIMUTH 列，sector 会因"方位角列全为 0 或空值"失败。测试数据需含 `AZIMUTH: [120.0]` 列。修正测试数据。

### Step 2: Run test to verify it fails

```bash
cd backend && .venv/bin/python -m pytest tests/test_layer_api.py::test_layer_endpoints_accept_file_path -v
```

Expected: FAIL — 400（`_save_upload` 的 file_path 模式要求文件存在，但测试用临时路径，可能因路径校验或其它原因失败）

### Step 3: Implement

`backend/app/api/v1/endpoints/layer.py` 改造 `_save_upload` 支持已上传文件路径：

```python
def _save_upload(file: Optional[UploadFile], file_path: Optional[str]) -> Path:
    """返回 Excel 文件的本地路径。
    优先用 file_path（分块上传已保存到 layer_tmp），否则从 file 写入临时文件。
    调用方负责在 finally 中删除返回的路径。
    """
    tmp_dir = settings.UPLOAD_DIR / "layer_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    # 分块上传模式：file_path 指向 layer_tmp 中已重组文件
    if file_path:
        src = Path(str(file_path).strip("\"'"))
        if not src.is_file():
            raise HTTPException(status_code=400, detail=f"文件不存在: {src.name}")
        if src.suffix.lower() not in ALLOWED_EXTS:
            raise HTTPException(status_code=400, detail="仅支持 Excel 文件（.xlsx/.xls）")
        return src  # 直接返回，调用方 finally 删除

    # 直接上传模式（兼容旧调用）
    if not file:
        raise HTTPException(status_code=400, detail="未提供文件")
    suffix = Path(file.filename or "src.xlsx").suffix.lower()
    if suffix not in ALLOWED_EXTS:
        raise HTTPException(status_code=400, detail="仅支持 Excel 文件（.xlsx/.xls）")
    name = f"src_{uuid.uuid4().hex[:8]}{suffix}"
    dest = tmp_dir / name
    with open(dest, "wb") as f:
        f.write(file.file.read())
    return dest
```

> 三个端点（excel_info/generate_point/generate_sector）已接收 `file_path: Optional[str] = Form(None)` 参数，无需改签名。`_save_upload` 优先用 file_path。

### Step 4: Run test to verify it passes

```bash
cd backend && .venv/bin/python -m pytest tests/test_layer_api.py -v
```

Expected: PASS（新增 file_path 测试）

### Step 5: Commit

```bash
git add backend/app/api/v1/endpoints/layer.py backend/tests/test_layer_api.py
git commit -m "feat: 图层端点支持 file_path 模式（分块上传后复用）"
```

---

## Task 3: 后端 layer_service 导出文件命名规则

**Files:**
- Modify: `backend/app/services/layer_service.py`

### Step 1: Write the failing test

追加到 `backend/tests/test_layer_service.py`：

```python
def test_output_filename_uses_source_and_sheet():
    """导出文件名 = 源文件名 + sheet 名 + 短 uuid + 扩展名"""
    import pandas as pd
    path = tmp_path / "工参2026.xlsx"
    pd.DataFrame({"NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9]}).to_excel(path, sheet_name="LTE", index=False)
    svc = LayerService(output_dir=tmp_path)
    out = svc.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="tab",
        source_filename="工参2026.xlsx",
    )
    assert out.stem.startswith("工参2026_LTE_")
    assert out.suffix == ".tab"
```

> 需要 `source_filename` 参数（Task 3 新增）。若 `generate_point_layer` 尚无该参数，测试会 TypeError（fail）。可先让 `generate_*_layer` 从 `file_path` 自动取源文件名（`Path(file_path).stem`），则无需额外参数。**推荐后者**：`_write` 内部从 file_path 推导源文件名，无需改调用签名。

### Step 2: Run test to verify it fails

```bash
cd backend && .venv/bin/python -m pytest tests/test_layer_service.py::test_output_filename_uses_source_and_sheet -v
```

Expected: FAIL — 文件名是 `layer_{uuid}` 而非 `工参2026_LTE_...`

### Step 3: Implement

`backend/app/services/layer_service.py` 改造 `_write`：

```python
def _write(self, gdf: gpd.GeoDataFrame, output_format: str,
           source_filename: str, sheet_name: str) -> Path:
    """写入文件，返回路径。文件名 = 源文件名 + sheet名 + 短uuid"""
    if output_format not in DRIVER_MAP:
        raise ValueError(f"不支持的输出格式: {output_format}")
    base = Path(source_filename).stem
    safe_sheet = re.sub(r'[<>:"/\\|?*]', "_", sheet_name)
    fname = f"{base}_{safe_sheet}_{uuid.uuid4().hex[:8]}{EXT_MAP[output_format]}"
    out_path = self.output_dir / fname
    gdf.to_file(out_path, driver=DRIVER_MAP[output_format])
    return out_path
```

在 `generate_point_layer`/`generate_sector_layer` 中调用 `_write` 时传入源文件名：

```python
# generate_point_layer 内
out = self._write(gdf, output_format, source_filename=Path(file_path).name, sheet_name=sheet_name)

# generate_sector_layer 内（同样）
```

> 需要确认 `import re` 已在文件顶部（颜色注入已用 re，应有）。若没有，加 `import re`。

### Step 4: Run test to verify it passes

```bash
cd backend && .venv/bin/python -m pytest tests/test_layer_service.py -v
```

Expected: PASS

### Step 5: Commit

```bash
git add backend/app/services/layer_service.py backend/tests/test_layer_service.py
git commit -m "feat: 图层导出文件名=源文件名+sheet名"
```

---

## Task 4: 前端 layerToolsApi 改为 file_path + 分块上传 + 进度

**Files:**
- Modify: `frontend/src/renderer/services/api.ts`

### Step 1: Write the failing test（type-check / 手动）

前端无测试框架强约束，用 type-check + 手动验证。改造 `layerToolsApi`：

```typescript
// 图层制作 API（生成新图层，区别于读取已有图层的 layerApi）
export const layerToolsApi = {
  // 分块上传 Excel 文件，返回 file_path（进度回调）
  uploadLayerFile: async (
    file: File,
    onProgress?: (p: { percent: number; step: 'uploading' | 'assembling' | 'reading' }) => void,
  ): Promise<{ file_path: string }> => {
    // 复用 chunkedUpload 的分块逻辑，但需要进度回调
    // 方案：抽一个带 onProgress 的分块上传变体，或直接在 layerToolsApi 内实现
    ...
  },

  // 读取 Excel 的 sheet 和列信息（用 file_path）
  getExcelInfo: async (filePath: string): Promise<LayerExcelInfo> => {
    const formData = new FormData()
    formData.append('file_path', filePath)
    const res = await uploadClient.post('/layer/excel-info', formData)
    return res.data
  },

  // 生成扇区图层（用 file_path）
  generateSector: async (params: GenerateLayerParams): Promise<GenerateLayerResult> => {
    const formData = new FormData()
    formData.append('file_path', params.filePath)
    formData.append('sheet_name', params.sheetName)
    // ... 其余同现有
    if (params.radiusM) formData.append('radius_m', String(params.radiusM))
    ...
    const res = await uploadClient.post('/layer/sector', formData)
    return res.data
  },

  // 生成点图层（用 file_path）
  generatePoint: async (params: GenerateLayerParams): Promise<GenerateLayerResult> => {
    const formData = new FormData()
    formData.append('file_path', params.filePath)
    ...
    const res = await uploadClient.post('/layer/point', formData)
    return res.data
  },
}
```

`GenerateLayerParams` 类型改造：

```typescript
export interface GenerateLayerParams {
  filePath: string        // 分块上传后的服务器路径（替代 file）
  sheetName: string
  nameCol: string
  lonCol: string
  latCol: string
  azimuthCol?: string
  attributes: string[]
  outputFormat: 'tab' | 'mif' | 'kml'
  radiusM?: number
  beamwidth?: number
  color?: string
}
```

**`uploadLayerFile` 实现**：复用 `chunkedUpload` 的核心分块逻辑。当前 `chunkedUpload` 无进度回调，且返回 `result`（body）。两种方案：
- **方案 A（推荐）**：给 `chunkedUpload` 加可选 `onProgress` 回调参数，layerToolsApi 调用时传入。改动小，复用完整。
- **方案 B**：在 layerToolsApi 内复制分块逻辑。重复代码。

推荐方案 A：给 `chunkedUpload(file, basePath, fileType, onProgress?)` 加第 4 参。

### Step 2: Implement 分块上传进度

修改 `chunkedUpload` 签名加 `onProgress`：

```typescript
async function chunkedUpload(
  file: File,
  basePath: string,
  fileType?: string,
  onProgress?: (percent: number) => void,
): Promise<any> {
  ...
  for (let i = 0; i < totalChunks; i++) {
    ...
    await uploadClient.post(...)
    onProgress?.(Math.round(((i + 1) / totalChunks) * 99))
    ...
  }
  ...
  onProgress?.(100)
  return result
}
```

`layerToolsApi.uploadLayerFile`：

```typescript
uploadLayerFile: async (file, onProgress) => {
  onProgress?.({ percent: 0, step: 'uploading' })
  const result = await chunkedUpload(file, '/data/upload', 'layer', (p) => {
    onProgress?.({ percent: p, step: 'uploading' })
  })
  onProgress?.({ percent: 100, step: 'assembling' })
  const filePath = result?.data?.file_path
  if (!filePath) {
    throw new Error('文件上传失败，未获取到文件路径')
  }
  return { file_path: filePath }
}
```

### Step 3: Verify

```bash
cd frontend && npm run type-check 2>&1 | grep -E "api.ts:(9[0-9][0-9]|10[0-2][0-9])" || echo "api.ts 无新增错误"
cd frontend && npm run type-check 2>&1 | grep -c "error TS"  # 基线 259，不新增
```

### Step 4: Commit

```bash
git add frontend/src/renderer/services/api.ts
git commit -m "feat: 图层API改file_path+分块上传+进度回调"
```

---

## Task 5: 前端页面两栏布局 + 控件常驻 + 进度条

**Files:**
- Modify: `frontend/src/renderer/pages/LayerSectorPage.tsx`
- Modify: `frontend/src/renderer/pages/LayerPointPage.tsx`
- Modify: `frontend/src/renderer/locales/zh.json`、`en.json`（进度/占位文案）

### Step 1: 翻译 key

新增到两个 locale 文件的 `layer` 对象（同步）：

zh:
```json
"uploadProgress": "上传中 {percent}%",
"assembling": "文件重组中...",
"reading": "读取列名中...",
"uploadDone": "上传完成",
"importHint": "请先导入 Excel 文件",
"noFile": "未选择文件"
```
en:
```json
"uploadProgress": "Uploading {percent}%",
"assembling": "Assembling file...",
"reading": "Reading columns...",
"uploadDone": "Upload complete",
"importHint": "Please import an Excel file first",
"noFile": "No file selected"
```

### Step 2: 页面状态改造

`LayerSectorPage.tsx` 状态增加：

```typescript
const [uploadProgress, setUploadProgress] = useState<{ percent: number; step: string } | null>(null)
const [filePath, setFilePath] = useState<string>('')
const [uploading, setUploading] = useState(false)
```

`handleFile` 改造为分块上传 + 进度：

```typescript
const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const f = e.target.files?.[0]
  if (!f) return
  setFile(f)
  setResult(null)
  setError('')
  setUploading(true)
  try {
    // 分块上传 + 进度
    const { file_path } = await layerToolsApi.uploadLayerFile(f, (p) => {
      setUploadProgress(p)
    })
    setFilePath(file_path)
    setUploadProgress({ percent: 100, step: 'reading' })
    // 读取 sheet/列
    const data = await layerToolsApi.getExcelInfo(file_path)
    setInfo(data)
    setSheetName(data.sheets[0] || '')
    setColumns(data.columns[data.sheets[0]] || [])
    setUploadProgress({ percent: 100, step: 'done' })
  } catch (err: any) {
    setError(err?.message || String(err))
  } finally {
    setUploading(false)
  }
}
```

`handleGenerate` 传 `filePath` 替代 `file`：

```typescript
const data = await layerToolsApi.generateSector({
  filePath, sheetName,
  nameCol: fieldMappings.name,
  ...
})
```

### Step 3: 两栏布局 JSX

重构 `return` 为两栏：

```tsx
return (
  <div className="p-8 max-w-6xl">
    <h1 className="text-base font-bold mb-6">{t('nav.layerTools')} · {t('layer.sectorLayer')}</h1>

    {/* ① 导入区（横跨） */}
    <label className="block p-6 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary transition-colors text-center">
      <FileUp className="mx-auto mb-2 text-muted-foreground" size={24} />
      <p className="text-sm">{file ? file.name : t('layer.uploadExcel')}</p>
      <p className="text-xs text-muted-foreground mt-1">{t('layer.acceptExcel')}</p>
      <input type="file" className="hidden" accept=".xlsx,.xls" onChange={handleFile} disabled={uploading} />
    </label>

    {/* 进度条 + 状态 */}
    {uploading && uploadProgress && (
      <div className="mt-3">
        <div className="h-2 bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-primary transition-all duration-300"
            style={{ width: `${uploadProgress.percent}%` }} />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {uploadProgress.step === 'uploading' ? t('layer.uploadProgress').replace('{percent}', String(uploadProgress.percent))
            : uploadProgress.step === 'assembling' ? t('layer.assembling')
            : uploadProgress.step === 'reading' ? t('layer.reading')
            : t('layer.uploadDone')}
        </p>
      </div>
    )}

    <div className="mt-6 grid grid-cols-5 gap-6">
      {/* 左栏（3/5）：Sheet + 属性 */}
      <div className="col-span-3 space-y-6">
        {/* ② Sheet 选择（常驻，无文件禁用） */}
        <div className="p-4 bg-card border border-border rounded-lg">
          <label htmlFor="layer-sheet" className="block text-xs font-medium mb-2">{t('layer.selectSheet')}</label>
          <select id="layer-sheet" value={sheetName}
            onChange={e => handleSheetChange(e.target.value)}
            disabled={!info || info.sheets.length === 0}
            className="w-full h-9 px-2 text-sm border border-border rounded bg-card disabled:opacity-50">
            {info && info.sheets.length > 0
              ? info.sheets.map(s => <option key={s} value={s}>{s}</option>)
              : <option value="">{t('layer.importHint')}</option>}
          </select>
        </div>

        {/* ③ 属性配置（常驻，无列禁用） */}
        <div className="p-4 bg-card border border-border rounded-lg">
          {columns.length > 0 ? (
            <LayerAttributeConfig ... />
          ) : (
            <p className="text-xs text-muted-foreground py-4 text-center">{t('layer.importHint')}</p>
          )}
        </div>
      </div>

      {/* 右栏（2/5）：参数 + 生成 + 下载 */}
      <div className="col-span-2 space-y-6">
        {/* ④ 参数设置（常驻） */}
        <div className="p-4 bg-card border border-border rounded-lg grid grid-cols-2 gap-4">
          ... 半径/波瓣/颜色/格式（常驻，禁用由 columns 控制）
        </div>

        {/* ⑤ 生成 + 下载 */}
        <div className="p-4 bg-card border border-border rounded-lg">
          <button onClick={handleGenerate} disabled={loading || !filePath || !sheetName} className="w-full ...">
            ...
          </button>
          {result && <a href={result.download_url} download className="...">...</a>}
        </div>
      </div>
    </div>

    {error && <p className="mt-4 text-xs text-red-500">{error}</p>}
  </div>
)
```

### Step 4: Verify

```bash
cd frontend && npm run type-check 2>&1 | grep -E "LayerSectorPage|LayerPointPage" || echo "页面无错误"
cd frontend && npm run type-check 2>&1 | grep -c "error TS"  # 基线 259，不新增
```

### Step 5: Commit

```bash
git add frontend/src/renderer/pages/LayerSectorPage.tsx frontend/src/renderer/pages/LayerPointPage.tsx frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json
git commit -m "feat: 图层页面两栏布局+进度条+控件常驻"
```

---

## Task 6: 集成验证 + 回归

**Files:** 无

### Step 1: 后端全量测试

```bash
cd backend && .venv/bin/python -m pytest -v
```

Expected: 全部 PASS（既有 80 + 新增）

### Step 2: 前端 type-check + lint

```bash
cd frontend && npm run type-check && npm run lint
```

Expected: 无新增错误

### Step 3: 手动端到端验证

1. 启动后端 + 前端
2. 进入扇区页面，导入含 `NAME/LONGITUDE/LATITUDE/AZIMUTH` 的 xlsx
3. 确认分块上传 + 进度条（上传中→重组→读取→完成）
4. 确认两栏布局：左（Sheet+属性）右（参数+生成+下载），控件常驻
5. 生成 → 下载，确认文件名 = `源文件名_sheet名_uuid.ext`
6. 重复验证点图层页面、mif/kml 格式

### Step 4: Commit（若有遗留修复）

```bash
git add -A
git commit -m "fix: 图层功能修复集成"
```

---

## 风险与注意事项

1. **`chunkedUpload` 对 layer 类型不轮询**：layer 的 complete 不建 data 索引，`result.data.status` 非 processing，阶段4轮询被跳过。验证此路径（Task 1 测试覆盖）。
2. **`file_path` 变量名冲突**：complete 中 `file_path` 已占用（重组路径），layer 分支用 `dest` 作目标名。Task 1 代码已处理。
3. **临时文件清理**：layer 的 file_path 由端点 `finally` 删除。chunked complete 移动文件到 layer_tmp 后，upload 根目录的重组文件应清理（Task 1 代码 `file_path.unlink`）。
4. **前端 `GenerateLayerParams.file` → `filePath`**：类型变更影响页面调用（Task 5 改造）。type-check 会捕获遗漏。
5. **`chunkedUpload` 加第4参 onProgress**：不影响现有调用（参数可选）。
6. **命名含中文/特殊字符**：源文件名或 sheet 名含中文时，文件名可含中文（文件系统支持）。非法字符（`<>:"/\|?*`）用 `re.sub` 替换。长度限制：源文件名可能很长，建议截断（如保留前 80 字符）。

## 范围外（YAGNI）

- 断点续传
- 并发分块上传
- 图层文件历史管理
