"""
MapInfo TAB 写入共享 helper

供"新建空 TAB 图层"与"编辑保存整层重写"使用。
- 使用 pyogrio.raw.write 写 MapInfo File（GBK 编码、EPSG:4326）
- 中文字段名写前以 f0..fN ASCII 占位，写后恢复（GDAL 会把中文列名打成 '_'）
- 字符串列按 GBK 字节宽转 U{width}，避免 GDAL 写成 Char(254) 导致 .dat 膨胀
- 原地覆写前先删除 stem 四件套（.tab/.dat/.id/.map/.ind），否则 pyogrio 报
  "Unable to create new layers in this single file dataset"

注意（实测）：MapInfo .dat 至少需要 1 个属性字段，0 字段的空表无法被驱动读回
（"contains only 0 fields"）。因此新建空图层默认带 name 列，整层重写按旧 schema
（必有列）写。
"""
import re
from pathlib import Path
from typing import List, Optional

import numpy as np
import pandas as pd
import geopandas as gpd
import pyogrio
from shapely import wkb

from app.services.layer_service import _sanitize_field_name, _dedupe_field_names

# MapInfo TAB 同 stem 配套文件后缀
TAB_STEM_SUFFIXES = (".tab", ".dat", ".id", ".map", ".ind")

_TAB_DRIVER = "MapInfo File"
_TAB_ENCODING = "GBK"


def _tab_stem_files(tab_path: Path) -> List[Path]:
    """收集与 tab_path 同 stem 的 MapInfo 配套文件（大小写不敏感）。

    用户上传的 MapInfo 文件常见大写后缀（.TAB/.DAT/.MAP/.ID），而
    Path.with_suffix 按字面替换后缀，只生成小写名 —— 逐字面 unlink 会漏删
    大写文件，残留的 .tab 使 pyogrio 报 "Unable to create new layers in
    this single file dataset"（整层重写保存失败的根因）。这里扫描同目录
    按 stem（忽略大小写）+ 后缀集合匹配；目录不可枚举时回退字面匹配。
    """
    tab_path = Path(tab_path)
    results: List[Path] = []
    stem = tab_path.stem.lower()
    try:
        for f in tab_path.parent.iterdir():
            if not f.is_file():
                continue
            if f.stem.lower() == stem and f.suffix.lower() in TAB_STEM_SUFFIXES:
                results.append(f)
    except OSError:
        pass
    for ext in TAB_STEM_SUFFIXES:
        p = tab_path.with_suffix(ext)
        if p not in results:
            results.append(p)
    return results


def remove_tab_stem(tab_path: Path) -> None:
    """删除与 tab_path 同 stem 的 MapInfo 配套文件（原地覆写前调用）。"""
    for f in _tab_stem_files(tab_path):
        try:
            f.unlink(missing_ok=True)
        except OSError as e:
            print(f"[tab_io] 删除配套文件失败 {f}: {e}")


def to_u_array(vals: pd.Series) -> np.ndarray:
    """字符串列 → numpy U{width}，width = 最大 GBK 字节长度（上限 254，至少 1）。

    与 layer_service.LayerService._to_u_array 一致：字节宽 ≥ 字符宽，
    取字节长作 U 宽度可保证中文不截断且字段宽恰好容纳实际内容。
    """
    lst = vals.astype(str).tolist()
    maxbytes = max((len(v.encode("gbk", errors="replace")) for v in lst), default=1)
    width = max(1, min(254, maxbytes))
    return np.array(lst, dtype=f"U{width}")


def build_field_data(gdf: gpd.GeoDataFrame, attr_cols: List[str]) -> list:
    """属性列 → pyogrio.raw.write 的 field_data（与 layer_service._build_field_data 一致）。

    字符串/日期/布尔列转定宽 U{GBK字节长}；数值列保持 int64/float64。
    """
    field_data = []
    for col in attr_cols:
        s = gdf[col]
        if pd.api.types.is_datetime64_any_dtype(s.dtype):
            vals = s.dt.strftime("%Y-%m-%d %H:%M:%S").fillna("")
            field_data.append(to_u_array(vals))
        elif pd.api.types.is_bool_dtype(s.dtype):
            field_data.append(to_u_array(s.astype(str)))
        elif pd.api.types.is_integer_dtype(s.dtype):
            field_data.append(s.fillna(0).astype("int64").to_numpy())
        elif pd.api.types.is_float_dtype(s.dtype):
            field_data.append(s.to_numpy(dtype="float64"))
        else:
            field_data.append(to_u_array(s.fillna("").astype(str)))
    return field_data


def _backup_stem_files(tab_path: Path) -> List[Path]:
    """收集需备份的配套文件：先按大小写不敏感扫描，再兜底字面 with_suffix 路径。"""
    return _tab_stem_files(Path(tab_path))


def _postprocess_tab(tab_path: Path, sanitized_cols: list) -> None:
    """TAB 后处理：charset 改 WindowsSimpChinese + 恢复中文列名（f0..fN → 真实列名）。"""
    text = tab_path.read_text(encoding="gbk", errors="replace")
    text = text.replace("!charset Neutral", "!charset WindowsSimpChinese")
    text = text.replace('Charset "Neutral"', 'Charset "WindowsSimpChinese"')
    idx = {"n": 0}

    def _restore(m):
        i = idx["n"]
        idx["n"] += 1
        if i < len(sanitized_cols):
            return f"  {sanitized_cols[i]} {m.group(1)}"
        return m.group(0)

    text = re.sub(
        r"  f\d+ ((?:Char|Character) \(\d+\) ;|Float ;|Integer ;|Smallint ;|LargeInt ;|Decimal ;|Date ;|DateTime ;)",
        _restore,
        text,
    )
    tab_path.write_text(text, encoding="gbk", errors="replace")


def write_mapinfo_tab(gdf: gpd.GeoDataFrame, out_path: Path,
                      geometry_type: Optional[str] = None) -> None:
    """把 GeoDataFrame 写为 MapInfo TAB（GBK、EPSG:4326）。

    Args:
        gdf: GeoDataFrame，crs 应为 EPSG:4326；可为 0 要素。
        out_path: 目标 .tab 路径；若已存在会先删除同 stem 配套文件（原地覆写）。
        geometry_type: 0 要素时必须显式指定 'Point'/'LineString'/'Polygon'/'Multi...'；
                       有要素时缺省取首要素几何类型。

    保证：0 要素写入时 gdf 至少含 1 个属性列（否则 .dat 0 字段非法、无法读回）。
    """
    out_path = Path(out_path)
    if len(gdf) == 0 and geometry_type is None:
        raise ValueError("0 要素写入 TAB 必须显式指定 geometry_type")
    if len(gdf.columns) <= 1:  # 仅 geometry 列，无属性列
        raise ValueError("TAB 至少需要 1 个属性列（0 字段 .dat 无法被 MapInfo 驱动读回）")

    remove_tab_stem(out_path)
    if out_path.exists():
        raise RuntimeError(f"无法删除已存在的 TAB 文件（可能被占用或只读）: {out_path}")

    orig_cols = list(gdf.columns)
    geom_name = gdf.geometry.name
    attr_cols = [c for c in orig_cols if c != geom_name]
    # 占位符只覆盖属性列：几何列不写入 .tab 字段列表，若把它算进来，
    # 几何列位于中间（如读回后追加样式列的 gdf）时后置列名会整体错位一格。
    sanitized_cols = _dedupe_field_names(
        [_sanitize_field_name(str(c), i) for i, c in enumerate(attr_cols)]
    )
    field_names = [f"f{i}" for i in range(len(attr_cols))]
    field_data = build_field_data(gdf, attr_cols)
    geoms_wkb = [wkb.dumps(g) for g in gdf.geometry]
    if geometry_type is None:
        geometry_type = gdf.geometry.geom_type.iloc[0]

    pyogrio.raw.write(
        str(out_path),
        geometry=geoms_wkb,
        field_data=field_data,
        fields=field_names,
        geometry_type=geometry_type,
        crs="EPSG:4326",
        driver=_TAB_DRIVER,
        encoding=_TAB_ENCODING,
    )
    _postprocess_tab(out_path, sanitized_cols)


def verify_tab_readable(tab_path: Path, expected_rows: int, label: str = "TAB") -> None:
    """读回校验：文件可解析且要素数一致，否则抛 ValueError。

    pyogrio 对 TAB / Shapefile / GeoJSON 通用，label 仅用于报错时标明格式。
    """
    try:
        info = pyogrio.read_info(str(tab_path))
        count = info["features"]
        if count == -1:
            count = len(pyogrio.read_dataframe(str(tab_path)))
        if count != expected_rows:
            raise ValueError(f"读回行数不一致（期望 {expected_rows}，实际 {count}）")
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"{label} 文件校验失败（不可读）: {e}") from e
