# 图层制作样式修复 设计文档

## 1. 问题与根因

### 1.1 扇区/点图输出互相覆盖

**现象**: 在扇区图层页面生成扇区图层后，切换到点图层页面生成点图，下载的文件仍是扇区图层；反之亦然。

**根因**: `_write` 的输出文件名 = `{源文件名stem}_{sheet名}`，扇区与点图共用同一文件名。服务器端二次生成用同名 zip 覆盖旧文件，但浏览器对相同 URL 的第二次下载触发缓存重验证（相同 mtime/etag 返回 304），命中本地缓存的**旧类型 zip**。

```
扇区: sample_LTE.tab  →  zip: sample_LTE.zip
点图: sample_LTE.tab  →  zip: sample_LTE.zip   ← 同名！URL 相同，浏览器缓存 304
```

**修复**: 文件名加入图层类型标记：

```
扇区: sample_LTE_sector.tab  →  sample_LTE_sector.zip
点图: sample_LTE_point.tab   →  sample_LTE_point.zip
```

`_cleanup_old_outputs` 清理前缀同步改为 `{base}_{sheet}_sector` / `{base}_{sheet}_point`，保证扇区/点图各自独立清理，互不删除对方输出。

### 1.2 填充颜色实为边框颜色

**现象**: 用户设置的"填充颜色"只改变图形的边框，图形内部没有填充。

**根因**:
- **KML 扇区**: GDAL 写 KML 时在 Polygon 后自动追加 `<Style><LineStyle>...</LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>`。该样式位于本函数注入的 `<Style><PolyStyle><color>...</color></PolyStyle></Style>` **之后**，KML 中后写的 Style 覆盖先写的 → 我们的填充被 `<fill>0</fill>` 覆盖，扇区显示为空心（只显示描边）。
- **MIF 扇区**: `Pen` 是边框，`Brush` 才是填充。旧实现只改 Brush 前景色，Pen 保持黑色。

**修复**:
- **KML 扇区**: 用正则**改写** GDAL 自带的样式为 `<LineStyle>(边框)</LineStyle><PolyStyle>(填充 + fill=1 + outline=1)</PolyStyle>`，每个 Placemark 恰好一个 Style。
- **MIF 扇区**: `Pen` 颜色 = 边框色，`Brush` 前景 = 填充色。
- **MIF/KML 点**: 点无填充概念，颜色按边框语义应用到 Symbol / IconStyle。

### 1.3 透明度

新增 `opacity`（0-1）参数。KML 颜色格式为 `aabbggrr`（alpha 为首字节），通过 `_kml_color_with_alpha` 把 opacity 写入 alpha 通道。MIF/TAB 不支持透明度（MapInfo 格式无透明度概念）。

### 1.4 导入卡片宽度

导入卡片原为页面全宽（`max-w-6xl` 内通栏）。修复为 `grid-cols-5` + `col-span-3`，与下方 Tab 内容左栏（col-span-3）宽度对齐。

## 2. 参数语义（前后端一致）

| 参数 | 扇区 | 点图 |
|------|------|------|
| 边框颜色 borderColor | KML LineStyle / MIF Pen / TAB 忽略 | KML IconStyle / MIF Symbol / TAB 忽略 |
| 填充颜色 fillColor | KML PolyStyle / MIF Brush / TAB 忽略 | 忽略（无填充概念） |
| 透明度 opacity (0-1) | KML alpha 通道 / MIF TAB 忽略 | KML alpha 通道 / MIF TAB 忽略 |

## 3. API 变更

`POST /api/v1/layer/sector` 与 `/api/v1/layer/point` 新增可选表单参数：

- `border_color: str` — #RRGGBB
- `fill_color: str` — #RRGGBB
- `opacity: float` — 0-1

旧 `color` 参数保留兼容：扇区同时应用于边框与填充；点图按边框语义。

## 4. 兼容性

- 旧 `sessionStorage` 中只有 `color`（原"填充颜色"实为边框色）→ 迁移为 `borderColor`；扇区还填充 `fillColor`。
- 旧 `color` API 参数继续工作。
- 测试更新：文件名断言加 `_point`/`_sector`；新增边框/填充/透明度断言。

## 5. 验证

- 后端 122 测试全绿（含 69 个图层测试）。
- 前端 `npm run build:vite` 成功。
- KML 读回验证：每 Placemark 恰好一个 Style，可被 pyogrio 读取。
