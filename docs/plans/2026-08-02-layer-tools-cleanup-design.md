# 图层制作问题修复设计文档（历史清理/文案/UI布局）

**日期**: 2026-08-02
**状态**: 已确认
**模块**: 图层制作（扇区图层、点图层）

## 1. 需求概述

修复图层制作 3 项问题：文件支持提示缺 csv/txt、二次生成历史文件残留+zip 重复、UI 布局（导入区上移共享）。

### 问题清单

| # | 问题 | 类型 |
|---|------|------|
| 1 | 导入框文件支持提示未包含 csv/txt | 文案 |
| 2 | 二次生成同名文件残留磁盘 + zip 内容重复 | 清理/打包 bug |
| 3 | 导入文件应提升到最上层共享，扇区/点图下移 | UI |

## 2. 技术方案

### 2.1 文件支持提示（问题 1）

`acceptExcel` 文案补充 txt/csv：
- `zh.json`: `"支持 .xlsx / .xls / .txt / .csv"`
- `en.json`: `"Supports .xlsx / .xls / .txt / .csv"`

（后端 `ALLOWED_EXTS` 已含 txt/csv，仅前端文案未同步。）

### 2.2 历史文件清理（问题 2a）

**根因**：`_write` 用 `_unique_path` 加 `-1/-2` 后缀避免覆盖，但旧文件不删除，磁盘积累历史版本（`工参_LTE.*` 和 `工参_LTE-1.*` 并存）。

**方案**：`layer_service.py` 新增 `_cleanup_old_outputs`，在 `generate_point_layer`/`generate_sector_layer` 生成前调用，删除同 base 历史文件：

```python
def _cleanup_old_outputs(self, base: str):
    """生成前删除同 base 的历史输出（.tab/.dat/.id/.map/.mif/.mid/.zip）"""
    for f in self.output_dir.glob(f"{base}*"):
        if f.suffix in (".tab", ".dat", ".id", ".map", ".mif", ".mid", ".zip"):
            f.unlink(missing_ok=True)
```

调用位置（两个 generate 函数，`_read_sheet` 后）：

```python
base = _truncate_bytes(Path(source_filename or Path(file_path).name).stem, 100)
safe_sheet = _truncate_bytes(re.sub(r'[<>:"/\\|?*]', "_", sheet_name), 50)
self._cleanup_old_outputs(f"{base}_{safe_sheet}")
```

> `base` 与 `_write` 中的 fname 前缀一致。清理后 `_unique_path` 无冲突 → 直接生成 `工参_LTE.tab`（不再 `-1`）。磁盘只保留最新。

### 2.3 多格式打包去重（问题 2b）

**根因**：`_finalize_outputs` 中 tab 和 mif 共享 stem，各自 `glob("{stem}.*")` 匹配到对方，zip 内容重复（`工参_LTE.tab` 出现两次等）。

**方案**：`layer.py` `_finalize_outputs` 用 set 去重：

```python
written = set()
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
```

### 2.4 UI 布局（问题 3）

**根因**：导入区在 `Tabs.List` 下方，扇区/点图 Tab 与导入区平行。

**改为**：导入区提升到最上层（共享），加"文件导入"标签，Tabs 下移：

```
Tabs.Root
  [文件导入 标签]      ← 新增标题
  [导入区]             ← 上移共享
  Tabs.List (扇区图层 | 点图层)  ← 下移
  Tabs.Content sector
  Tabs.Content point
```

**新增 i18n key**：
- `zh.json`: `"fileImport": "文件导入"`
- `en.json`: `"fileImport": "File Import"`

## 3. 数据流

```
用户选文件（共享）
  → 分块上传 → getExcelInfo → 配置
  → generateSector|Point：
      生成前 _cleanup_old_outputs(base)  ← 删历史
      逐行校验 → 生成各格式 → 打包 zip（去重）→ 返回
  → 前端展示统计 + 下载
```

## 4. 错误处理

- 清理失败（文件占用）：`unlink(missing_ok=True)` 忽略
- zip 去重：set 保证唯一文件名
- 清理 glob 边界：只删指定后缀，避免误删源文件

## 5. 测试计划

- **后端** `test_layer_service.py`：
  - 二次生成后 output_dir 只含最新 base 文件（无 `-1` 后缀）
- **后端** `test_layer_api.py`：
  - 多格式 zip 内容无重复文件名
- **前端**：type-check 0 新增；手动验证布局/文案

## 6. 范围外（YAGNI）

- 历史文件回收站（直接删除）
- 跨 session 的历史版本保留（用户明确要求不保留）
