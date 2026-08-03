# 图层制作问题修复 设计文档

**日期**: 2026-08-03
**范围**: 图层制作 5 项问题修复（TAB 样式、点图层 TAB 无效、透明度逻辑、拖拽导入、多格式导出旧文件）

---

## 1. 问题与根因

### 1.1 TAB 图层颜色/线宽/透明度无样式 + 点图层 TAB 点大小/点形状无效

**现象**: 
- 扇区 TAB 图层生成后无颜色/线宽/透明度样式
- 点图层 TAB 生成后点大小/点形状设置无效；MIF 正常

**根因（已实测验证）**: MapInfo TAB 是**混合格式**——文本 `.tab` 定义字段 + 二进制 `.map`/`.dat` 存储几何与**样式**。GDAL mitab 驱动**不支持写样式**：

- 实测给 GDAL 写入的 TAB 加 `ogr_style` 字段（`PEN(color:#000000,width:3)+BRUSH(color:#FF0000)`），读回时 `.map` 二进制与无样式完全一致 → `ogr_style` 仅作为普通字段保留，**不应用为样式**。
- MIF→TAB 转换同样丢样式（GDAL 读 MIF 时不读样式）。
- `pyogrio.write_dataframe` / `pyogrio.raw.write` 均无 `feature_styles` 参数。

MIF 能生效是因为 MIF 是**纯文本**格式（`Pen`/`Brush`/`Symbol` 直接改文本即可，当前 `_apply_style` 已实现）。

**结论**: 后端**无法**通过 GDAL 给 TAB 注入颜色/线宽/透明度/点大小/点形状。这是 MapInfo 格式 + 工具链的硬限制。

### 1.2 透明度逻辑反了

**现象**: 扇区制作透明度数值越大出来的图形越不透明，正确应为数值越大越透明。

**根因**: 后端 `_kml_color_with_alpha(color, opacity)` 直接 `alpha = opacity * 255`，把 opacity 当**不透明度**（0.6 → 60% 不透明）。前端也是 0-1 语义。

### 1.3 点图层"边框颜色"标签

**现象**: 点图层参数项叫"边框颜色"。

**根因**: 点无边框/填充之分，颜色实际应用到 MIF Symbol 前景色 / KML SVG 图标填充色。标签语义不贴切。

### 1.4 文件导入拖拽无反应

**现象**: 导入区文案写"点击或拖拽导入"，但拖拽文件无反应。

**根因**: `<label>` 只绑了 `<input type="file">` 的 `onChange`，**没有 `onDragOver`/`onDrop` 处理器**。

### 1.5 多格式导出旧文件 / 只有 MIF

**现象**: 
- 分别勾选 TAB/MIF/KML 多次导出，下载文件日期是 2 小时前，疑似打包了旧数据。
- 勾选 tab+mif 导出，只有 MIF 文件。

**根因（浏览器缓存）**: `_finalize_outputs` 的 zip 文件名 = `outs[0].stem`（**不含格式组合**）。`sample_LTE_point.zip` 这个 URL 在单格式 tab、tab+mif、tab+mif+kml 三种情况下**完全相同**，但 zip 内容不同 → 浏览器对相同 URL 触发缓存重验证（304），命中旧 zip → 下载到旧文件 / 只有 MIF。

> 注：`test_point_endpoint_multi_format_zip` 等测试通过是因为 TestClient 无浏览器缓存，真实浏览器必现此问题。

---

## 2. 修复方案

### 2.1 TAB 样式 → 接受 TAB 无样式（保持现状 + 强化提示）

- 后端零改动。
- 更新前端 `colorTabHint` 文案：TAB 格式不支持样式（颜色/线宽/透明度/点大小/点形状），仅 MIF/KML 生效。

### 2.2 透明度逻辑反转

**后端** `layer_service.py`:
- 参数语义从"不透明度"改为"透明度"：`alpha = round((1 - transparency) * 255)`。
- 内部改名：`_kml_color_with_alpha(color, transparency)`，`kml_opacity` → `kml_transparency`。
- MIF/TAB 仍不支持透明度（MapInfo 格式无此概念）。

**前端** `LayerToolsPage.tsx`:
- 透明度输入范围改 **0-100**（0=完全不透明，100=全透明），默认 **0**（实心）。
- 提交时 `transparency = (100 - opacity) / 100` 传后端（后端语义 `alpha = (1 - transparency)*255` → `alpha = opacity`，前端 0-100 的 `opacity` 数值直接等于 KML alpha 百分比，直观）。
- 旧 sessionStorage 迁移：旧 `opacity 0-1` → 新 `opacity = round((1 - old) * 100)`（0.6 → 40）。

### 2.3 点图"边框颜色"→"填充颜色"

- 前端：点图 Tab 的颜色标签用 `layer.fillColor`（"填充颜色"），状态字段 `borderColor`→`fillColor`。
- API 参数名不变（点图后端本就一个颜色，应用到 MIF Symbol 前景色 / KML SVG 填充色）。
- 扇区 Tab 不变（边框颜色 + 填充颜色两个）。

### 2.4 拖拽导入

前端 `<label>` 补拖拽事件：
- 新增 `dragActive` state。
- `onDragOver`：`preventDefault` + 高亮（`dragActive=true`）。
- `onDragLeave`：`dragActive=false`。
- `onDrop`：`preventDefault` + `dragActive=false` + 取 `e.dataTransfer.files[0]` 调 `processFile(file)`。
- `handleFile` 重构为 `processFile(file)`，input `onChange` 与 drop 共用。

### 2.5 多格式导出旧文件 → 缓存双保险

**后端** `endpoints/layer.py`:
- zip 文件名加**格式组合**：`sample_LTE_point_tab-mif-kml.zip`。
  - 单格式 tab → `_tab.zip`，tab+mif → `_tab-mif.zip`，tab+mif+kml → `_tab-mif-kml.zip`。不同组合 URL 不同，浏览器不冲突。
  - KML 单文件也加格式标记。
- `_finalize_outputs` / `_finalize_output` 签名接收 `formats` 组合生成后缀。
- 更新相关测试断言。

**前端** `LayerToolsPage.tsx`:
- 下载链接加 **cache-bust**：`download_url + '?_t=' + Date.now()`，同组合重复导出也强制拉新。

---

## 3. 参数语义（修复后）

| 参数 | 扇区 | 点图 |
|------|------|------|
| 边框颜色 borderColor | KML LineStyle / MIF Pen / TAB 忽略 | 无（点无边框） |
| 填充颜色 fillColor | KML PolyStyle / MIF Brush / TAB 忽略 | KML SVG 填充 / MIF Symbol 前景 / TAB 忽略 |
| 透明度 opacity (0-100) | KML alpha 通道（0=实心 100=透明）/ MIF TAB 忽略 | KML alpha 通道 / MIF TAB 忽略 |
| 线宽 lineWidth | KML LineStyle width / MIF Pen 第3参数 / TAB 忽略 | 无 |
| 点大小 pointSize | 无 | KML scale / MIF Symbol size / TAB 忽略 |
| 点形状 pointShape | 无 | KML SVG 图标 / MIF Symbol shape / TAB 忽略 |

## 4. API 变更

后端 `/sector` `/point` 参数不变（`border_color`/`fill_color`/`opacity`）。`opacity` 语义改为透明度（0-1，前端传 `(100-v)/100`）。zip 文件名加格式组合后缀。

## 5. 兼容性

- 旧 `sessionStorage` 的 `opacity 0-1` → 迁移 `round((1-old)*100)`。
- 旧 `color` 参数继续兼容（点图按填充语义应用）。
- TAB 样式保持现状（本来就不支持）。

## 6. 验证

- 后端测试全绿：`pytest tests/test_layer_service.py tests/test_layer_api.py`。
- 前端 `npm run build:vite` 成功。
- 手工验证：
  1. 透明度滑块 0/50/100 导出 KML，检查 alpha 通道（ff/80/00）。
  2. 拖拽文件到导入框 → 正常上传解析。
  3. 分别勾选 tab / tab+mif / tab+mif+kml 导出，zip 文件名含对应格式组合，浏览器强制拉新。
  4. 点图 Tab 颜色标签显示"填充颜色"。
