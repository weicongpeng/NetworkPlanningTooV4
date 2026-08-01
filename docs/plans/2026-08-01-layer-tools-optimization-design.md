# 图层制作功能优化设计文档

**日期**: 2026-08-01
**状态**: 已确认
**模块**: 图层制作（扇区图层、点图层）

## 1. 需求概述

在现有图层制作功能基础上修复 8 项问题，覆盖上传效率、中文编码、持久化、进度反馈、输入框、命名、UI 合并及生成统计。

### 问题清单

| # | 问题 | 类型 |
|---|------|------|
| 1 | 上传文件报 Cloudflare "invalid/incomplete response"、"后端连接丢失" | 生产环境上传效率 |
| 2 | 生成的 TAB/MIF 图层在 MapInfo 打开中文乱码 | 编码兼容性 |
| 3 | 导入文件及配置切换页面后丢失 | 持久化 |
| 4 | 选择文件后进度条没有马上呈现 | 进度同步 |
| 5 | 半径/波瓣默认 50/50；输入框删空变 0、带前导 0；输出格式改勾选多选 | 输入/交互 |
| 6 | 下载文件名末尾 uuid 像乱码 | 命名规则 |
| 7 | 图层制作（扇区）与（点）页合并，菜单/卡片合并 | UI |
| 8 | 生成输出统计：总量/成功/失败 + 失败原因分类（新增） | 校验统计 |

## 2. 技术方案

### 2.1 上传效率（问题 1、4）

**根因**：Cloudflare Tunnel 边缘节点到 origin 连接在响应完成前断开（ARM 软加密吞吐有限）。分块越大单请求耗时越长，越容易触发超时窗口。

**改进**（`frontend/src/renderer/services/api.ts`）：

| 项 | 当前 | 改进 |
|----|------|------|
| 分块大小 | 3-50MB → 1MB | 3-50MB → **512KB**；>50MB → 保持 512KB |
| 块级超时 | 全局 300s | 每块请求 timeout 60s（`uploadClient` 单次请求配置） |
| 重试 | 3 次，退避 2/4/8s | 保持，但每块重试不影响已成功块 |
| 即时进度 | start 阶段 0% | start 请求前立即 `onProgress(1, '准备上传')`，首块完成即跳转 |

关键：块越小、单请求越快，越不易触发 Cloudflare origin 超时。

### 2.2 TAB/MIF 中文编码修复（问题 2）

**根因**：GDAL MapInfo 驱动写入 UTF-8 字节但声明 `Charset "Neutral"`，MapInfo 按 Windows-1252 解析 → 乱码。

**已验证方案**（`backend/app/services/layer_service.py`）：

```
1. 写前重命名: 中文字段名 → f0/f1/f2...（避免 GDAL 把中文列名打成下划线）
2. 写文件: gdf.to_file(..., encoding='GBK')  ← DAT/MID 字节变 GBK
3. 后处理 .tab:
   - !charset Neutral → !charset WindowsSimpChinese
   - Type NATIVE Charset "Neutral" → "WindowsSimpChinese"
   - 按字段顺序恢复中文列名（正则匹配 '  f\d+ (Type) ;' 行）
   - gbk 编码回写
4. 后处理 .mif:
   - Charset "Neutral" → "WindowsSimpChinese"
   - 恢复 Columns 块中文列名
   - gbk 编码回写
```

**验证结果**：TAB/MIF 写入 `encoding='GBK'` 后 DAT/MID 含 GBK 字节；补丁 charset + 恢复列名后 `geopandas.read_file` 回读 `['小区名称'] → ['基站A']` 完整。KML 天然 UTF-8 XML，无需处理。

**注意**：`_apply_color` 后处理读取文本需改用 `gbk` 解码（MIF），与写入编码一致；写入顺序为「先 GBK 写 + 列名/字符集补丁 → 再颜色补丁」。

### 2.3 持久化（问题 3）

**方案**：组件状态存 `sessionStorage`，路由切换后切回自动恢复。

```
LayerToolsPage 每 Tab 维护完整状态对象:
  { filePath, sourceFilename, fileName, sheetName, info,
    selectedFields, fieldMappings,
    radiusM, beamwidth, pointSize, color, formats[], result }

key: 'layerTools.sector' | 'layerTools.point'
写入: state 变化后 useEffect 写 sessionStorage
恢复: 挂载时读，有值则 setState
过期处理: filePath 被 TTL(24h) 清理后，生成时后端 400 → 前端提示"文件已过期，请重新导入"并清空状态
```

选 sessionStorage 而非 localStorage：刷新清空（用户预期"重来"），路由切换保留。

### 2.4 输入框修复（问题 5）

**根因**：`type="number"` + `Number('') === 0` 导致删空变 0、带前导 0。

**修复**：字符串受控 + 文本输入，提交转数字：

```
const [radiusM, setRadiusM] = useState('50')
<input type="text" inputMode="numeric" value={radiusM}
       onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setRadiusM(e.target.value) }} />
提交: parseFloat(radiusM) || 默认值
```

扇区默认 半径 `'50'`、波瓣 `'50'`（`LAYER_DEFAULT_PARAMS` 修改）。

### 2.5 输出格式多选 + 一次生成多格式打包（问题 5c）

**前端**：格式改复选框勾选（tab/mif/kml 多选，至少选 1）。

**后端** `layer.py`：
- `output_formats: str = Form("tab,mif,kml")`（逗号分隔）
- 对每个所选格式调用一次 `generate_*_layer`（同一 file_path + 校验结果缓存复用）
- 选 1 种：按当前逻辑（TAB/MIF 打包 zip，KML 单文件）
- 选 ≥2 种：所有结果统一打包进一个 zip
- 返回附加 `stats` 字段

### 2.6 命名规则（问题 6）

**改为**：去 uuid 后缀，冲突递增序号。

```
候选: {源文件名去扩展名}_{safe_sheet}.{ext}
已存在 → {base}_{safe_sheet}-1.{ext} → -2 ...
```

多格式同源各格式独立计数互不冲突；zip 内用各文件原名。

### 2.7 UI 合并（问题 7）

```
路由: /layer → LayerToolsPage（新合并页）
旧路由 /layer/sector、/layer/point 删除（或重定向）
侧边栏: 实用工具 → 图层制作（一项）
首页: 两张卡片 → 一张「图层制作」
页面内: Radix Tabs [扇区图制作] [点图制作]
  扇区: 参数 半径/波瓣/颜色 + azimuth 字段
  点图: 参数 点大小/颜色（无 azimuth）
  共用导入区、sheet选择、属性配置（两 Tab 状态独立）
```

### 2.8 逐行校验 + 生成统计（问题 8）

**改为**逐行校验，跳过无效行不阻断，输出统计。

**校验规则**（一行多分类只计一次失败，优先级：missing_coord > invalid_coord > invalid_azimuth > missing_name > missing_attrs）：

| 校验项 | 失败条件 | 分类 |
|--------|---------|------|
| 经纬度缺失 | 经/纬为空 | `missing_coord` |
| 经纬度格式 | 非数字 / 经度∉[-180,180] / 纬度∉[-90,90] | `invalid_coord` |
| 方位角(扇区) | 空 / 非数字 / ∉[0,360] | `invalid_azimuth` |
| 标签名称 | name 列空 | `missing_name` |
| 属性列 | 勾选属性列该行全空 | `missing_attrs` |

**返回**：

```json
{
  "success": true,
  "data": {
    "filename": "工参2026_LTE.zip",
    "download_url": "/layer-files/工参2026_LTE.zip",
    "stats": {
      "total": 5000, "success": 4987, "failed": 13,
      "failures": { "missing_coord": 5, "invalid_coord": 2,
                    "invalid_azimuth": 3, "missing_name": 2, "missing_attrs": 1 }
    }
  }
}
```

**边界**：`total=0` → 400；`success=0` → 400 + 统计明细；部分失败 → 正常生成 + 统计。

**前端展示**：结果区显示 `总量 X | 成功 X | 失败 X`，失败时显示分类计数。

## 3. 数据流

```
用户选文件
  → uploadLayerFile(file, onProgress)   // 512KB 分块 + 即时进度(1%→块级→100%)
  → getExcelInfo(file_path)             // 读 sheet/列
  → 配置（sheet/列勾选/字段映射/参数/多格式）
  → generateSector|Point(file_path, config, formats[], ...)
      → 后端逐行校验 → 生成各格式 → 打包 zip → 返回 {filename, download_url, stats}
  → 前端展示统计 + 下载
```

## 4. 错误处理

- 上传：块级 60s 超时 + 3 次重试 + 退避；失败取消会话
- 文件过期（TTL 清理后）：后端 400 → 前端提示"文件已过期，请重新导入"并清空
- `total=0` / `success=0`：400 + 统计明细
- 编码补丁后文件损坏：GBK 安全处理（项目规范）

## 5. 测试计划

- **后端** `test_layer_service.py`：
  - 中文列名/值 → TAB/MIF 输出回读完整（GBK 断言）
  - 逐行校验统计：部分无效行 → 跳过 + stats 正确
  - 命名：去 uuid + 冲突加序号
- **后端** `test_layer_api.py`：
  - output_formats 多格式打包 zip
  - stats 字段返回
- **前端**：type-check 0 新增；手动验证 Tab 合并、持久化、进度条、输入框、多格式勾选

## 6. 范围外（YAGNI）

- 断点续传（失败重传整文件，重试机制足够）
- 并发分块上传（单 worker 排队问题，保持串行）
- 跨会话持久化（刷新清空，TTL 机制不变）
- 逐行失败明细表（仅分类统计）
