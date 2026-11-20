# 图层制作样式修复 Implementation Plan

**Goal:** 修复图层制作 3 项问题：扇区/点图输出互相覆盖、边框/填充/透明度样式、导入卡片宽度对齐。

**根因分析:**
1. **Issue 1（扇区/点图互相覆盖）**: `_write` 输出文件名 = `{源文件名}_{sheet}`，扇区与点图同名。切换 Tab 生成另一类型时，服务器用同名 zip 覆盖，但浏览器缓存（304 重验证）仍返回旧类型 zip → "生成扇区下载还是点图"。修复：文件名加 `_sector`/`_point` 类型标记，互不覆盖；`_cleanup_old_outputs` 也按类型前缀清理。
2. **Issue 2（填充颜色实为边框色）**: KML 扇区 GDAL 自带 `<PolyStyle><fill>0</fill></PolyStyle>` 样式覆盖注入的填充 → 显示空心。修复：重写 GDAL 样式为 LineStyle(边框)+PolyStyle(fill=1,outline=1)。MIF 扇区 Pen 颜色=边框色、Brush 前景=填充色。新增 `opacity`（透明度）作用于 KML alpha 通道。
3. **Issue 3（导入卡片过宽）**: 导入卡片原为全宽。修复：改用 `grid-cols-5` + `col-span-3` 与下方左栏卡片对齐。

**Tech Stack:** React 18 + TypeScript + Tailwind；FastAPI + pyogrio/geopandas。

**设计文档:** `docs/plans/2026-08-02-layer-tools-style-fixes-design.md`

---

## 改动清单

### 后端

| 文件 | 改动 |
|------|------|
| `backend/app/services/layer_service.py` | `_write` 加 `layer_type` 参数 → 文件名追加 `_sector`/`_point`；`_apply_color` → `_apply_style(border_color, fill_color, opacity)`；新增 `_kml_color_with_alpha`；KML 扇区重写 GDAL 样式 |
| `backend/app/api/v1/endpoints/layer.py` | `/sector`、`/point` 端点加 `border_color`/`fill_color`/`opacity` 表单参数；清理前缀按类型（`{base}_{sheet}_sector`/`_point`） |

### 前端

| 文件 | 改动 |
|------|------|
| `frontend/src/renderer/services/api.ts` | `GenerateLayerParams` 加 `borderColor`/`fillColor`/`opacity`；两个 generate 调用透传 |
| `frontend/src/renderer/pages/LayerToolsPage.tsx` | TabState 加 `borderColor`/`fillColor`/`opacity`；参数网格改为 边框颜色/填充颜色(扇区)/透明度；`handleGenerate` 传新参数；sessionStorage 旧 `color` → `borderColor` 迁移 |
| `frontend/src/renderer/config/layer-config.ts` | `LAYER_DEFAULT_PARAMS` 拆 border/fill/opacity |
| `frontend/src/renderer/locales/zh.json` / `en.json` | 新增 `borderColor`/`opacity`，更新 `colorTabHint` |

### 测试

- `backend/tests/test_layer_service.py`: 更新文件名断言（`_point`/`_sector`）；新增扇区/点图异名、边框/填充/透明度断言
- `backend/tests/test_layer_api.py`: 更新文件名断言；新增样式参数端到端测试、扇区/点图异名测试

## 验证

- [x] 后端测试全绿：`pytest tests/test_layer_service.py tests/test_layer_api.py`（69 passed）
- [x] 全量后端测试：`pytest`（122 passed）
- [x] 前端构建：`npm run build:vite` 成功
- [x] 手工验证：扇区 KML 每 Placemark 恰好一个 Style（含 LineStyle+PolyStyle），可读回
