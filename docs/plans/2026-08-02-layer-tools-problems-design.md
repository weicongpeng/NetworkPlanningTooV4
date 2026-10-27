# 图层制作问题修复设计文档（共享导入/UI/默认格式/字段名清洗/历史清理）

**日期**: 2026-08-02
**状态**: 已确认
**模块**: 图层制作（扇区图层、点图层）
**分支**: layer-tools

## 1. 需求概述

修复图层制作 5 项问题：

| # | 问题 | 类型 |
|---|------|------|
| 1 | 扇区/点图层不共享导入数据，各自单独导入 | UI/状态 |
| 2 | 文件导入与导入框 UI 与下方卡片风格不一致 | UI |
| 3 | 输出格式 TAB/MIF/KML 应默认全勾选 | 配置 |
| 4 | 点图层 TAB 在 MapInfo 打不开；zip 内重复带序号同名文件 | 后端 bug |
| 5 | 扇区图层下载 29.3MB（比之前大 10 倍），疑似打包历史文件 | 后端 bug |

## 2. 根因分析（已验证）

### 2.1 问题 4：TAB/MIF 打不开 — 字段名含非法字符

扇区源工参列名含空格（`SITE ID`、`CELL ID`、`SITE NAME`）等 MapInfo **非法字段名字符**。

- TAB：`Failed to parse field definition at line 9`（GDAL 解析失败）
- MIF：`Too many lines in MIF head`

**验证**：手动把 `SITE ID` → `SITE_ID` 后 TAB 可正常读回。GDAL 生成时把字段名重命名为 `f0/f1` 占位名写入，`_mapinfo_postprocess` 恢复原列名时把含空格的非法名写回，导致解析失败。

### 2.2 问题 4/5：zip 重复序号文件 + 历史残留

- `_cleanup_old_outputs` 清理后缀列表**漏了 `.kml`**，历史 `-1/-2/-3.kml` 残留磁盘
- `_finalize_outputs` 打包用 `glob("{stem}.*")` 前缀匹配，把带序号的残留文件也收进 zip
- 磁盘 `uploads/layers/` 已积累 **201GB** 历史文件

**验证**：`5G&4G基站配置表-0724_5G.zip` 内含 `xxx.kml` + `xxx-3.kml` 两份，共 8 个文件、解压 117MB。

### 2.3 问题 5：下载 29.3MB

`.dat` 达 35-69MB，是 MapInfo TAB 定长记录格式的**结构性膨胀**（55 字段含大量 `Char(254)` 定长占位 × ~8000 行）。字段名清洗后大小不变，非历史文件打包导致，但 zip 去重 + 历史清理后下载量恢复为单套文件。

## 3. 技术方案

### 3.1 共享导入数据（问题 1）

文件导入从 TabState 提升为**页面级共享状态**：

```ts
interface SharedFile {
  filePath: string
  sourceFilename: string
  fileName: string
  sheetName: string
  info: LayerExcelInfo | null
  columns: string[]
}
```

- 导入区写 `sharedFile`，不再写 `sectorState`/`pointState`
- 扇区/点图 Tab 各自持有 `selectedFields`、`fieldMappings`、参数（互不干扰）
- 两份 Tab 都读 `sharedFile` → 一份文件同时作用于两页
- `sharedFile` 也写入 sessionStorage 持久化

### 3.2 导入框 UI 统一（问题 2）

导入区改为卡片风格，与下方卡片一致：

- 外层容器：`bg-card border border-border rounded-lg p-4`
- 标签：`text-xs font-medium`
- 内部保留虚线上传区（`border-2 border-dashed`），但尺寸/圆角/颜色对齐卡片内元素

### 3.3 输出格式默认全勾选（问题 3）

`emptyTabState` 的 `formats` 由 `['tab']` 改为 `['tab', 'mif', 'kml']`。
已持久化的旧状态覆盖默认值，无需迁移。

### 3.4 字段名清洗（问题 4 根因修复）

新增清洗函数，TAB/MIF 恢复列名前先清洗：

```python
_MAPINFO_INVALID = re.compile(r'[^\w一-鿿]+')  # 空格等非字母数字/下划线/中文

def _sanitize_field_name(name: str) -> str:
    """MapInfo 字段名清洗：非法字符（空格等）替换为下划线，去重相邻下划线，去首尾"""
    cleaned = _MAPINFO_INVALID.sub("_", name)
    cleaned = re.sub(r'_+', "_", cleaned).strip("_")
    return cleaned
```

- `SITE ID` → `SITE_ID`，`小区名字` → `小区名字`（保留中文）
- 在 `_mapinfo_postprocess` 恢复列名时先清洗再写入
- 同时用于 KML 字段名（KML 无此约束但保持一致）
- 注意：清洗后可能重名（`SITE ID` 与 `SITE_ID`），需去重处理

### 3.5 读回验证（问题 4 用户核心诉求）

生成 TAB/MIF/KML 后用 pyogrio/XML 读回验证：

```python
def _verify_readable(out_path: Path, expected_rows: int, output_format: str):
    """生成后读回验证：文件可解析且行数一致，否则抛 ValueError"""
```

- TAB/MIF：`pyogrio.read_dataframe` 读回，断言行数 = 成功数
- KML：`xml.etree.ElementTree.fromstring` 验证 XML 合法
- 验证失败 → 抛错，不交付坏文件

### 3.6 历史清理 + 打包去重（问题 4b/5）

**清理列表补 `.kml`**：

```python
_CLEANUP_SUFFIXES = (".tab", ".dat", ".id", ".map", ".mif", ".mid", ".zip", ".kml")
```

**打包改用精确文件名收集**（不 glob 前缀匹配历史）：

```python
def _companion_files(out: Path) -> list:
    """TAB: {stem}.tab/.dat/.id/.map；MIF: {stem}.mif/.mid；KML: {stem}.kml"""
```

`_finalize_outputs` 对每个 `out` 只收集其精确配套文件，杜绝历史残留混入 zip。

**历史文件一次清理**：部署时手动清一次 `uploads/layers/`（释放 201GB），此后靠清理逻辑持续维护。

## 4. 数据流

```
用户选文件（共享导入）
  → 上传 → getExcelInfo → 写 sharedFile
  → 扇区/点图 Tab 各自读 sharedFile 配置
  → generateSector|Point：
      生成前 _cleanup_old_outputs(base)（含 .kml）← 删历史
      字段名清洗（空格→下划线）
      逐行校验 → 剔除失败行 → 生成各格式
      _verify_readable 读回验证 ← 确保可用
      打包 zip（精确配套收集，去重）→ 返回
  → 前端展示统计 + 下载
```

## 5. 错误处理

- 字段名清洗后重名 → 追加序号去重（`SITE_ID` → `SITE_ID_2`）
- 读回验证失败 → 抛 `ValueError("生成文件校验失败...")`，返回 400
- 清理失败（文件占用）→ `unlink(missing_ok=True)` 忽略
- 打包只收集精确配套文件，天然排除历史残留

## 6. 测试计划

- **后端 `test_layer_service.py`**：
  - 含空格列名（`SITE ID`/`CELL ID`）→ TAB/MIF 生成后 `pyogrio` 可读，字段名已转下划线
  - 清洗后重名 → 自动去重不崩溃
  - 读回验证通过：行数 = 成功数
  - 读回验证失败（模拟损坏文件）→ 抛 ValueError
- **后端 `test_layer_api.py`**：
  - 多格式 zip 内无重复文件名（含 `.kml` 场景）
  - 二次生成后 output_dir 无 `-1/-2` 历史残留
- **前端**：type-check 0 新增；手动验证共享导入/UI/默认勾选

## 7. 范围外（YAGNI）

- 历史文件回收站（直接删除）
- 跨 session 历史版本保留（用户明确要求不保留）
- `.dat` 结构性压缩（MapInfo TAB 固有格式特性，通过字段名清洗 + 默认少字段缓解）
