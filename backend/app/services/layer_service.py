"""
图层制作服务

根据 Excel 工参文件生成 MapInfo (TAB/MIF) 和 KML 格式的图层文件。
使用 pyogrio + geopandas 写入（内置 GDAL/OGR 绑定，无需安装 GDAL）。
扇区几何使用 Flat-Earth 近似算法（与前端 SectorRendererSVG 一致）。
"""
import io
import math
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
import geopandas as gpd
import pyogrio
from shapely import wkb
from shapely.geometry import Point, Polygon

from app.services.tab_style_writer import convert_mif_to_tab

# 输出格式 → pyogrio driver 名
DRIVER_MAP = {
    "tab": "MapInfo File",
    "mif": "MapInfo File",
    "kml": "KML",
}
# 扩展名
EXT_MAP = {"tab": ".tab", "mif": ".mif", "kml": ".kml"}

# 点形状 → MapInfo Symbol shape 编号（MapInfo 3.0 Symbols：34=Circle 32=Square 33=Diamond 35=Star）
# 修正：原 circle=35(Star)/square=33(Diamond)/diamond=36 全部错位 → 34/32/33
POINT_SHAPE_MIF = {
    "circle": 34, "square": 32, "diamond": 33,
    "triangle": 40, "triangle_down": 41, "landmark": 42, "pin": 38,
}

# 填充无色（空心点）用的空心符号：实测 38=空心正方形、40=空心圆、41=空心五角星、42=空心正三角；
# 39=空心菱形按"实心编号 +6"的规律推断（38/40/41/42 均符合该规律），若 MapInfo 中显示不符需实测修正。
POINT_SHAPE_MIF_HOLLOW = {
    "circle": 40, "square": 38, "diamond": 39,
    "triangle": 40, "triangle_down": 41, "landmark": 42, "pin": 38,
}

# 无色哨兵（与前端 utils/fieldValue.NO_FILL_COLOR 一致）：该颜色不绘制
NO_FILL_COLOR = "none"


def is_no_color(value: Optional[str]) -> bool:
    """颜色参数是否为"无色"哨兵。仅识别 'none'（缺省/非法值仍按原语义处理）。"""
    return isinstance(value, str) and value.strip().lower() == NO_FILL_COLOR


# MapInfo 非法字段名字符（非字母数字/下划线/中文）
_MAPINFO_INVALID = re.compile(r"[^\w一-鿿]+")

# 生成前清理的历史输出后缀（含 -1/-2 序号残留）
_CLEANUP_SUFFIXES = (".tab", ".dat", ".id", ".map", ".mif", ".mid", ".zip", ".kml")


def _sanitize_field_name(name: str, index: int = 0) -> str:
    """MapInfo 字段名清洗：非法字符（空格等）→ 下划线，合并相邻下划线，去首尾。

    MapInfo 用表达式解析器读 .tab 字段定义行，以数字开头的名字会被当作数字字面量，
    打开表时报 "Expression does not evaluate to a column or table name."（GDAL 严格
    清洗同样会把首字符替换为 '_'）。故数字开头补 '_' 前缀；清洗后为空（如列名只有
    符号"%"）时回退 Field{index+1}，否则会写出无名字段行。
    """
    cleaned = _MAPINFO_INVALID.sub("_", name)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    if not cleaned:
        return f"Field{index + 1}"
    if cleaned[0].isdigit():
        cleaned = "_" + cleaned
    return cleaned


def _dedupe_field_names(names: list) -> list:
    """清洗后字段名去重：重名追加 _2/_3 序号，保持相对顺序。合成名也占用，避免二次碰撞。"""
    used = set()
    result = []
    for n in names:
        if n not in used:
            used.add(n)
            result.append(n)
        else:
            i = 2
            while f"{n}_{i}" in used:
                i += 1
            unique = f"{n}_{i}"
            used.add(unique)
            result.append(unique)
    return result


def fast_destination(lat: float, lng: float, azimuth_deg: float, distance_m: float) -> tuple:
    """快速计算终点坐标 (Flat-Earth Approximation)
    移植自前端 SectorRendererSVG._fastDestination
    """
    rad = azimuth_deg * math.pi / 180
    meters_per_lat = 111319.9
    meters_per_lng = 111319.9 * math.cos(math.radians(lat))
    dlat = distance_m * math.cos(rad) / meters_per_lat
    dlng = distance_m * math.sin(rad) / meters_per_lng
    return lat + dlat, lng + dlng


def sector_polygon(lat: float, lng: float, azimuth: float, beamwidth: float,
                   radius_m: float, arc_points: int = 16) -> Polygon:
    """生成扇形（楔形）多边形
    角度以正北为 0，顺时针。azimuth ± beamwidth/2 构成扇区两边界，弧线 arc_points 段。
    默认 16 段（每扇区 18 顶点）：相比原 30 段（32 顶点）MIF 文件体积降 ~44%，
    MapInfo 拖拽更流畅，弧线在制图比例下仍平滑。
    """
    half = beamwidth / 2
    start, end = azimuth - half, azimuth + half
    pts = [(lng, lat)]
    for i in range(1, arc_points):
        a = start + (end - start) * i / arc_points
        lat2, lng2 = fast_destination(lat, lng, a, radius_m)
        pts.append((lng2, lat2))
    lat2, lng2 = fast_destination(lat, lng, end, radius_m)
    pts.append((lng2, lat2))
    pts.append((lng, lat))
    return Polygon(pts)


def tab_opacity_brush_pattern(opacity: Optional[float]) -> int:
    """TAB 透明度 → Brush 图案（只做两档）。

    MapInfo 的原生 Pen/Brush 样式没有 alpha 通道，半透明存不进去，因此 TAB 只区分：
    透明度 > 0.5 → 1（无填充/空心，只留边框）；否则 2（实心填充）。
    界面语义为 0=不透明、1=全透明（默认 0.5），默认值落在实心档，填充色可见。
    非法/NaN → 2（实心）。
    """
    try:
        t = float(opacity)
    except (TypeError, ValueError):
        return 2
    if not math.isfinite(t):
        return 2
    return 1 if t > 0.5 else 2


def hex_to_mapinfo_color(color: Optional[str]) -> Optional[int]:
    """#RRGGBB → MapInfo 十进制 RGB (R*65536+G*256+B)。非法/None 返回 None"""
    if not color:
        return None
    c = color.strip().lstrip('#')
    if len(c) != 6:
        return None
    try:
        r = int(c[0:2], 16); g = int(c[2:4], 16); b = int(c[4:6], 16)
        return r * 65536 + g * 256 + b
    except ValueError:
        return None


def mif_opacity_brush_pattern(opacity: Optional[float]) -> int:
    """MIF 透明度 → Brush pattern 档位（官方规范：pattern≥3 且省略 backcolor 即透明填充）。
    MIF 无 alpha 通道，用【稀疏大颗粒】pattern 模拟半透明（透过点阵看到底下内容）：
      透明度越高 → pattern 越稀疏（颗粒越稀，越透明）。
    pattern 2=实心（不透明）；12/13/14=稀疏点阵（密度 0.06/0.12/0.25）；15=细斜线。
    非法/NaN → 0（不透明）。"""
    try:
        t = float(opacity)
    except (TypeError, ValueError):
        return 2
    if not math.isfinite(t):
        return 2
    t = max(0.0, min(1.0, t))
    if t <= 0:
        return 2                       # 实心不透明
    if t <= 0.33:
        return 15                      # 细斜线（低透明）
    if t <= 0.66:
        return 14                      # 对角点阵
    if t <= 0.9:
        return 13                      # 稀疏网格点
    return 12                          # 稀疏大颗粒点（最透明）


def hex_to_kml_color(color: Optional[str]) -> Optional[str]:
    """#RRGGBB → KML aabbggrr (alpha=ff)。非法/None 返回 None"""
    if not color:
        return None
    c = color.strip().lstrip('#')
    if len(c) != 6:
        return None
    try:
        r = c[0:2]; g = c[2:4]; b = c[4:6]
        return f'ff{b}{g}{r}'.lower()
    except ValueError:
        return None


def svg_point_icon(shape: str, color: str, hollow: bool = False) -> str:
    """生成点形状的 SVG Data URI（KML Icon href，完全离线可用）。

    hollow=True：填充颜色=无色 → 只描边不填充（空心点），描边色用轮廓色。
    """
    from urllib.parse import quote
    fill = color or "#FF0000"
    svgs = {
        "circle": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12" fill="{fill}" stroke="#fff" stroke-width="2"/></svg>',
        "square": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="4" y="4" width="24" height="24" rx="2" fill="{fill}" stroke="#fff" stroke-width="2"/></svg>',
        "diamond": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="16,3 29,16 16,29 3,16" fill="{fill}" stroke="#fff" stroke-width="2"/></svg>',
        "triangle": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="16,3 29,29 3,29" fill="{fill}" stroke="#fff" stroke-width="2"/></svg>',
        "triangle_down": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="3,3 29,3 16,29" fill="{fill}" stroke="#fff" stroke-width="2"/></svg>',
        "landmark": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M16 3 L28 10 L16 17 L4 10 Z" fill="{fill}" stroke="#fff" stroke-width="2"/><rect x="4" y="12" width="24" height="4" fill="{fill}" stroke="#fff" stroke-width="1"/><rect x="12" y="16" width="8" height="10" fill="{fill}" stroke="#fff" stroke-width="1"/></svg>',
        "pin": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M16 2 C9 2 4 7 4 14 C4 23 16 30 16 30 C16 30 28 23 28 14 C28 7 23 2 16 2 Z" fill="{fill}" stroke="#fff" stroke-width="2"/><circle cx="16" cy="13" r="4" fill="#fff"/></svg>',
    }
    hollow_svgs = {
        "circle": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="11" fill="none" stroke="{fill}" stroke-width="3"/></svg>',
        "square": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="5" y="5" width="22" height="22" rx="1" fill="none" stroke="{fill}" stroke-width="3"/></svg>',
        "diamond": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="16,3 29,16 16,29 3,16" fill="none" stroke="{fill}" stroke-width="3" stroke-linejoin="round"/></svg>',
        "triangle": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="16,3 29,29 3,29" fill="none" stroke="{fill}" stroke-width="3" stroke-linejoin="round"/></svg>',
        "triangle_down": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><polygon points="3,3 29,3 16,29" fill="none" stroke="{fill}" stroke-width="3" stroke-linejoin="round"/></svg>',
        "landmark": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M16 3 L28 10 L16 17 L4 10 Z" fill="none" stroke="{fill}" stroke-width="2"/><rect x="4" y="12" width="24" height="4" fill="none" stroke="{fill}" stroke-width="1.5"/><rect x="12" y="16" width="8" height="10" fill="none" stroke="{fill}" stroke-width="1.5"/></svg>',
        "pin": f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M16 2 C9 2 4 7 4 14 C4 23 16 30 16 30 C16 30 28 23 28 14 C28 7 23 2 16 2 Z" fill="none" stroke="{fill}" stroke-width="3"/><circle cx="16" cy="13" r="4" fill="none" stroke="{fill}" stroke-width="2"/></svg>',
    }
    table = hollow_svgs if hollow else svgs
    svg = table.get(shape, table["circle"])
    return "data:image/svg+xml," + quote(svg, safe='')


def _kml_color_with_alpha(color: Optional[str], transparency: float) -> Optional[str]:
    """KML aabbggrr + 指定透明度 transparency(0=不透明, 1=全透明)。非法颜色/透明度返回 None"""
    c = hex_to_kml_color(color)
    if c is None:
        return None
    try:
        t = float(transparency)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(t):
        return None  # NaN/Inf → 视为非法透明度
    t = max(0.0, min(1.0, t))
    alpha = round((1 - t) * 255)
    return f"{alpha:02x}{c[2:]}"


def _truncate_bytes(s: str, max_bytes: int) -> str:
    """按 UTF-8 字节截断，避免截断中文字符中间（ext4 NAME_MAX=255 字节）"""
    b = s.encode('utf-8')
    if len(b) <= max_bytes:
        return s
    return b[:max_bytes].decode('utf-8', errors='ignore')


class LayerService:
    """图层制作服务"""

    def __init__(self, output_dir: Optional[Path] = None):
        from app.core.config import settings
        self.output_dir = output_dir or (settings.UPLOAD_DIR / "layers")
        self.output_dir.mkdir(parents=True, exist_ok=True)

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
        """读取指定 sheet，返回 DataFrame。
        显式指定 calamine engine，保证 .xls 与 .xlsx 均可读取（无需 xlrd/xlwt）。
        txt/csv 无 sheet 概念，忽略 sheet_name。
        """
        ext = Path(file_path).suffix.lower()
        if ext in (".csv", ".txt"):
            return self._read_text(file_path)
        try:
            return pd.read_excel(file_path, sheet_name=sheet_name, engine="calamine")
        except ValueError as e:
            raise ValueError(f"Sheet 不存在: {sheet_name}") from e

    def _coerce_coords(self, df: pd.DataFrame, lon_col: str, lat_col: str):
        """逐行校验经纬度，返回 (lon, lat, valid_mask, failures)
        failures: dict 分类计数（missing_coord / invalid_coord）
        不再整列报错，改为跳过无效行。
        """
        failures = {"missing_coord": 0, "invalid_coord": 0}
        lon = pd.to_numeric(df[lon_col], errors="coerce")
        lat = pd.to_numeric(df[lat_col], errors="coerce")
        missing = lon.isna() | lat.isna()
        failures["missing_coord"] += int(missing.sum())
        invalid = ~missing & (~lon.between(-180, 180) | ~lat.between(-90, 90))
        failures["invalid_coord"] += int(invalid.sum())
        valid = ~missing & ~invalid
        return lon, lat, valid, failures

    def _collect_failed_details(self, df: pd.DataFrame, valid: pd.Series,
                                lon_col: str, lat_col: str,
                                azimuth_col: Optional[str] = None,
                                name_col: Optional[str] = None) -> list:
        """收集失败行明细（row/name/reason）。预计算数值数组避免逐行 pd.to_numeric。
        row = Excel 行号（表头 1 行 + 数据索引 + 1）。"""
        # 预计算数值数组（向量化，性能好）
        lon_arr = pd.to_numeric(df[lon_col], errors="coerce").to_numpy() if lon_col in df.columns else None
        lat_arr = pd.to_numeric(df[lat_col], errors="coerce").to_numpy() if lat_col in df.columns else None
        azi_arr = None
        if azimuth_col and azimuth_col in df.columns:
            azi_arr = pd.to_numeric(df[azimuth_col], errors="coerce").to_numpy()
        name_arr = df[name_col].astype(str) if (name_col and name_col in df.columns) else None

        details = []
        for pos, i in enumerate(df.index):
            if valid.iloc[pos]:
                continue
            reason = None
            lon = None if lon_arr is None else lon_arr[pos]
            lat = None if lat_arr is None else lat_arr[pos]
            # 坐标缺失
            if lon_arr is None or lat_arr is None or pd.isna(lon) or pd.isna(lat):
                reason = "missing_coord"
            # 坐标格式错（超出范围）
            elif not (-180 <= lon <= 180) or not (-90 <= lat <= 90):
                reason = "invalid_coord"
            # 方位角无效（扇区）
            elif azi_arr is not None and (pd.isna(azi_arr[pos]) or not (0 <= azi_arr[pos] <= 360)):
                reason = "invalid_azimuth"
            # 标签名缺失
            elif name_arr is not None and str(name_arr.iloc[pos]).strip() in ("", "nan"):
                reason = "missing_name"
            # 兜底（理论上不会到这）
            reason = reason or "unknown"
            nm = "" if name_arr is None else str(name_arr.iloc[pos])
            details.append({
                "row": int(i) + 2,   # Excel 行号 = 数据索引 + 表头 + 1
                "name": "" if nm.strip() in ("", "nan") else nm,
                "reason": reason,
            })
        return details

    def _build_gdf(self, df: pd.DataFrame, lon: pd.Series, lat: pd.Series,
                   valid: pd.Series, attributes: List[str], geometry_cols,
                   keep_cols_extra: Optional[List[str]] = None) -> gpd.GeoDataFrame:
        """构建 GeoDataFrame，仅保留有效坐标行和勾选属性列
        keep_cols_extra: 额外保留的列（如 name_col，即使不在 attributes 中也保留）。
        """
        if not attributes:
            raise ValueError("请至少选择一个图层属性列")
        sub = df.loc[valid].copy()
        keep = [c for c in sub.columns if c in attributes]
        if not keep:
            raise ValueError("所选属性列在数据中不存在，请检查属性列选择")
        if keep_cols_extra:
            for c in keep_cols_extra:
                if c and c in sub.columns and c not in keep:
                    keep.append(c)
        sub = sub[keep]
        gdf = gpd.GeoDataFrame(sub, geometry=geometry_cols, crs="EPSG:4326")
        return gdf

    def _ensure_kml_name(self, gdf: gpd.GeoDataFrame, name_col: str) -> gpd.GeoDataFrame:
        """KML 写入前把 name_col 列重命名为 'Name'（GDAL KML 驱动约定），使标签名生效。
        若 name_col 已名为 'Name'，或 gdf 中已存在 'Name' 列则跳过，避免覆盖。
        """
        if not name_col or name_col not in gdf.columns or name_col == "Name":
            return gdf
        if "Name" in gdf.columns:
            return gdf
        return gdf.rename(columns={name_col: "Name"})

    def _unique_path(self, path: Path) -> Path:
        """同名文件已存在 → 追加 -1/-2 序号"""
        if not path.exists():
            return path
        stem, ext = path.stem, path.suffix
        i = 1
        while (self.output_dir / f"{stem}-{i}{ext}").exists():
            i += 1
        return self.output_dir / f"{stem}-{i}{ext}"

    def _cleanup_old_outputs(self, base: str):
        """生成前删除同 base 的历史输出（.tab/.dat/.id/.map/.mif/.mid/.zip/.kml）。
        保证同一源文件+sheet 只保留最新一次生成结果。"""
        for f in self.output_dir.glob(f"{base}*"):
            if f.suffix in _CLEANUP_SUFFIXES:
                f.unlink(missing_ok=True)

    def _mapinfo_postprocess(self, out_path: Path, output_format: str,
                             sanitized_cols: list) -> Path:
        """MapInfo TAB/MIF 后处理：修正 charset 声明为 WindowsSimpChinese + 恢复列名。
        写入前 GDAL 要求字段名仅 ASCII（中文会被打成 '_' 并可能引发 GBK 解码问题），
        故 _write 先重命名为 f0/f1... 占位名 + encoding='GBK' 写入，此处按字段顺序恢复清洗后的
        列名（已由 _write 经 _sanitize_field_name/_dedupe_field_names 处理），
        并把 charset 从 Neutral 改为 WindowsSimpChinese（MapInfo Pro 正确解析 GBK）。
        """
        enc = "gbk"
        text = out_path.read_text(encoding=enc, errors="replace")
        text = text.replace("!charset Neutral", "!charset WindowsSimpChinese")
        text = text.replace('Charset "Neutral"', 'Charset "WindowsSimpChinese"')
        if output_format == "tab":
            idx = {"n": 0}
            def _restore(m):
                i = idx["n"]; idx["n"] += 1
                if i < len(sanitized_cols):
                    return f"  {sanitized_cols[i]} {m.group(1)}"
                return m.group(0)
            # 匹配字段定义行: '  f0 Char (254) ;' / '  f1 Float ;' / '  f2 LargeInt ;' 等
            text = re.sub(
                r"  f\d+ ((?:Char|Character) \(\d+\) ;|Float ;|Integer ;|Smallint ;|LargeInt ;|Decimal ;|Date ;|DateTime ;)",
                _restore, text,
            )
        elif output_format == "mif":
            lines = text.splitlines()
            out_lines, in_cols, ci = [], False, 0
            for ln in lines:
                m = re.match(r"^  f\d+( Char\(\d+\)| Float| Integer| Smallint| LargeInt| Character| Decimal| Date| DateTime)", ln)
                if m and in_cols and ci < len(sanitized_cols):
                    ln = f"  {sanitized_cols[ci]}{m.group(1)}"; ci += 1
                if ln.startswith("Columns"):
                    in_cols = True
                elif in_cols and ln.strip() == "Data":
                    in_cols = False
                out_lines.append(ln)
            text = "\n".join(out_lines)
        out_path.write_text(text, encoding=enc)
        return out_path

    def _write(self, gdf: gpd.GeoDataFrame, output_format: str,
               source_filename: str, sheet_name: str,
               layer_type: str = "",
               style: Optional[Dict[str, Any]] = None) -> Path:
        """写入文件（含样式注入），返回路径。文件名 = 源文件名 + sheet名 + 图层类型标记。
        中文编码：TAB/MIF 写前重命名列名为 ASCII 占位 + encoding='GBK' + 写后恢复列名。
        base 按 100 字节、sheet 按 50 字节截断，总长 < ext4 NAME_MAX 255。
        layer_type: 'sector'/'point' 追加到文件名，保证扇区与点图不同文件（不互相覆盖）。
        style: 样式参数（见 _apply_style 的签名键）；TAB 带样式时经临时 MIF 中转，见
        _write_styled_tab。为 None 或无有效颜色时只写数据不注入样式。
        """
        if output_format not in DRIVER_MAP:
            raise ValueError(f"不支持的输出格式: {output_format}")
        base = _truncate_bytes(Path(source_filename).stem, 100)
        safe_sheet = _truncate_bytes(re.sub(r'[<>:"/\\|?*]', "_", sheet_name), 50)
        type_tag = "_sector" if layer_type == "sector" else "_point"
        fname = f"{base}_{safe_sheet}{type_tag}{EXT_MAP[output_format]}"
        out_path = self._unique_path(self.output_dir / fname)
        if output_format in ("tab", "mif"):
            sanitized_cols = self._sanitized_columns(gdf)
            if output_format == "tab" and self._has_effective_style(style):
                return self._write_styled_tab(gdf, out_path, sanitized_cols, style)
            self._write_mapinfo_raw(gdf, out_path, output_format, sanitized_cols)
        else:
            gdf.to_file(out_path, driver=DRIVER_MAP[output_format])
        if self._has_effective_style(style):
            self._apply_style(out_path, output_format, **style)
        return out_path

    @staticmethod
    def _has_effective_style(style: Optional[Dict[str, Any]]) -> bool:
        """样式是否需要注入：至少有一个能解析的颜色（点看边框色，面看边框/填充色）。

        没有有效颜色时走普通写入路径，避免为无样式需求多走一次 MIF 中转。
        """
        if not style:
            return False
        return any(
            hex_to_mapinfo_color(style.get(key)) is not None
            for key in ("border_color", "fill_color")
        )

    @staticmethod
    def _sanitized_columns(gdf: gpd.GeoDataFrame) -> list:
        """属性列名 → MapInfo 合法列名（写前占位名与写后恢复列名共用同一顺序）。

        占位符只覆盖属性列：几何列不写入 .tab 字段列表，算进来会让后置列名整体错位。
        """
        geom_name = gdf.geometry.name
        attr_cols = [c for c in gdf.columns if c != geom_name]
        return _dedupe_field_names(
            [_sanitize_field_name(c, i) for i, c in enumerate(attr_cols)]
        )

    def _write_mapinfo_raw(self, gdf: gpd.GeoDataFrame, out_path: Path, output_format: str,
                           sanitized_cols: list, patch_names: bool = True) -> None:
        """按 MapInfo 写前约定落盘：f0..fN ASCII 占位列名 + GBK + 实际字节宽度。

        关键：字符串列按实际 GBK 字节长度转 U{width} 再写，否则 GDAL 把每个字符串列
        都写成 Char(254)（MapInfo 最大宽度），导致 .dat/.mid 体积放大 20-70 倍。
        patch_names=False 时只修 charset、保留占位列名（供中转文件转换后再统一恢复列名）。
        """
        geom_name = gdf.geometry.name
        attr_cols = [c for c in gdf.columns if c != geom_name]
        field_names = [f"f{i}" for i in range(len(attr_cols))]
        field_data = self._build_field_data(gdf, attr_cols)
        geoms_wkb = [wkb.dumps(g) for g in gdf.geometry]
        geom_type = gdf.geometry.geom_type.iloc[0]
        pyogrio.raw.write(
            str(out_path),
            geometry=geoms_wkb,
            field_data=field_data,
            fields=field_names,
            geometry_type=geom_type,
            crs="EPSG:4326",
            driver=DRIVER_MAP[output_format],
            encoding="GBK",
        )
        self._mapinfo_postprocess(out_path, output_format, sanitized_cols if patch_names else [])

    def _write_styled_tab(self, gdf: gpd.GeoDataFrame, out_path: Path,
                          sanitized_cols: list, style: Dict[str, Any]) -> Path:
        """TAB 带样式：先写临时 MIF（样式完整），再用 GDAL 转换成 TAB。

        MITAB 驱动只认 OGR 样式串，pyogrio 写 TAB 时给不了样式（UPDATE 模式补写也不行，
        实测 SetFeature 后样式不落盘），而带样式的 MIF → TAB 转换走 GDAL 的创建路径
        （CreateTABFeature → WritePenDef/WriteBrushDef/WriteSymbolDef），样式会进 .map
        定义表，MapInfo 即可读到。流程：
          临时 MIF（GBK + f0..fN 占位列名）→ _apply_style 注入 Pen/Brush/Symbol
          → 转成 TAB → 修 TAB 的 charset/中文列名 → 删除临时 MIF。
        透明度：TAB 无 alpha，用 tab_opacity_brush_pattern 的两档（实心/空心）。
        转换失败不影响出图：记日志并回退为无样式的普通 TAB（用户仍能拿到文件）。
        """
        tmp_dir = Path(tempfile.mkdtemp(prefix="npt_tab_style_"))
        try:
            tmp_mif = tmp_dir / f"{out_path.stem}.mif"
            self._write_mapinfo_raw(gdf, tmp_mif, "mif", sanitized_cols, patch_names=False)
            tmp_style = dict(style)
            # 填充无色 → Brush pattern 1（无填充，优先于透明度档位）；否则 TAB 无 alpha，只做两档
            if is_no_color(tmp_style.get("fill_color")):
                tmp_style["brush_pattern"] = 1
            else:
                tmp_style["brush_pattern"] = tab_opacity_brush_pattern(tmp_style.get("opacity"))
            self._apply_style(tmp_mif, "mif", **tmp_style)
            convert_mif_to_tab(tmp_mif, out_path)
            self._mapinfo_postprocess(out_path, "tab", sanitized_cols)
            return out_path
        except Exception as exc:  # noqa: BLE001 — 样式是增强项，失败不能阻断出图
            print(f"[LayerStyle] TAB 样式写入失败，回退无样式 TAB: {exc}")
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        # 回退：清掉可能残留的半成品配套文件后按普通路径重写（局部导入避免与 tab_io 循环依赖）
        from app.services.tab_io import remove_tab_stem
        remove_tab_stem(out_path)
        self._write_mapinfo_raw(gdf, out_path, "tab", sanitized_cols)
        return out_path

    def _build_field_data(self, gdf: gpd.GeoDataFrame, attr_cols: List[str]) -> list:
        """属性列 → pyogrio.raw.write 的 field_data。

        字符串/日期/布尔列转定宽 U{GBK字节长}（GDAL 据此写 Char(字节宽)，而非 Char(254)）；
        数值列保持 int64/float64（→ LargeInt/Float，无宽度膨胀）。
        """
        field_data = []
        for col in attr_cols:
            s = gdf[col]
            if pd.api.types.is_datetime64_any_dtype(s.dtype):
                vals = s.dt.strftime("%Y-%m-%d %H:%M:%S").fillna("")
                field_data.append(self._to_u_array(vals))
            elif pd.api.types.is_bool_dtype(s.dtype):
                field_data.append(self._to_u_array(s.astype(str)))
            elif pd.api.types.is_integer_dtype(s.dtype):
                field_data.append(s.fillna(0).astype("int64").to_numpy())
            elif pd.api.types.is_float_dtype(s.dtype):
                field_data.append(s.to_numpy(dtype="float64"))
            else:
                field_data.append(self._to_u_array(s.fillna("").astype(str)))
        return field_data

    @staticmethod
    def _to_u_array(vals: pd.Series) -> np.ndarray:
        """字符串列 → numpy U{width}，width = 最大 GBK 字节长度（上限 254，至少 1）。

        U{width} 为字符宽、MapInfo Char(width) 为字节宽；因字节宽 ≥ 字符宽，
        取字节长作 U 宽度可保证中文不截断且字段宽恰好容纳实际内容。
        """
        lst = vals.astype(str).tolist()
        maxbytes = max((len(v.encode("gbk")) for v in lst), default=1)
        width = max(1, min(254, maxbytes))
        return np.array(lst, dtype=f"U{width}")

    def _apply_style(self, out_path: Path, output_format: str,
                     border_color: Optional[str], fill_color: Optional[str],
                     opacity: Optional[float], is_point: bool,
                     line_width: Optional[int] = None,
                     point_size: Optional[float] = None,
                     point_shape: Optional[str] = None,
                     brush_pattern: Optional[int] = None,
                     hollow: bool = False) -> Path:
        """后处理注入样式：边框颜色/填充颜色/透明度/线宽（MIF 文本改写、KML 内联样式）。

        MIF 扇区: Pen 颜色 = 边框色，Brush 前景 = 填充色（背景保留白色）。
        MIF 点:   Symbol (shape, 颜色, size) = 点形状映射 + 边框色 + 点大小。
        KML 扇区: LineStyle color=边框色 + PolyStyle color=填充色(带透明度) + outline=1。
                  GDAL 自身会在 Polygon 后写 LineStyle+PolyStyle(fill=0) 样式，
                  该样式位于本函数注入的 Style 之后、作用更优先，故需同时改写 GDAL 样式。
        KML 点:   IconStyle color=边框色 + scale 由点大小决定 + Icon href=形状 SVG Data URI。

        颜色为"无色"哨兵（'none'）时：MIF 边框 → Pen pattern 1（无边框）、填充 → Brush
        pattern 1（无填充/空心面）；KML 边框 → 不写 LineStyle 且 PolyStyle outline=0、
        填充 → PolyStyle fill=0。
        hollow=True（点图层填充无色）：MIF Symbol 换空心符号（颜色用轮廓色），KML 用只描边的
        空心 SVG 图标。

        TAB 不在这里处理：TAB 的 Pen/Brush/Symbol 只能由 GDAL 从 OGR 样式串写进 .map，
        故 TAB 走「临时带样式 MIF → GDAL 转换」，见 _write_styled_tab（那里的中间 MIF 也会
        调用本函数，并用 brush_pattern 覆盖成 TAB 的两档透明度）。
        brush_pattern: 直接指定 MIF Brush 图案（不传则按透明度用 mif_opacity_brush_pattern 近似）。
        非法颜色/透明度或非 MIF/KML 格式直接返回原文件。MIF 使用 GBK 编码（与 _write 一致）。
        """
        if output_format not in ("mif", "kml"):
            return out_path
        if output_format == "mif":
            text = out_path.read_text(encoding="gbk", errors="replace")
            mif_border = hex_to_mapinfo_color(border_color)
            if is_point:
                # 点 Symbol (shape, 颜色, size) 替换：形状映射 + 边框色 + 点大小
                if mif_border is not None:
                    shapes = POINT_SHAPE_MIF_HOLLOW if hollow else POINT_SHAPE_MIF
                    shape = shapes.get(point_shape or "circle", 34)
                    size = int(point_size or 12)
                    text = re.sub(
                        r'Symbol \((\d+),(\d+),(\d+)\)',
                        lambda m: f'Symbol ({shape},{mif_border},{size})', text,
                    )
            else:
                mif_fill = hex_to_mapinfo_color(fill_color)
                # 扇区 Pen 颜色 = 边框色、线宽 = pen_width；Brush 前景 = 填充色
                pen_width = max(1, min(7, int(line_width or 2)))
                if is_no_color(border_color):
                    # 边框无色：Pen pattern 1 = 无边框（颜色位保留原值，不生效）
                    text = re.sub(
                        r'Pen \((\d+),(\d+),(\d+)\)',
                        lambda m: f'Pen ({pen_width},1,{m.group(3)})', text,
                    )
                elif mif_border is not None:
                    # MapInfo Pen (width, pattern, color)：线宽进 width、保留原 pattern、颜色进 color
                    # 修复前错误写为 (1, mif_border, pen_width) → 颜色进 pattern 位（0-71）
                    # 导致白色边框 16777215 报 Invalid stylevalue，线宽也从未生效
                    text = re.sub(
                        r'Pen \((\d+),(\d+),(\d+)\)',
                        lambda m: f'Pen ({pen_width},{m.group(2)},{mif_border})', text,
                    )
                if is_no_color(fill_color):
                    # 填充无色：Brush pattern 1 = 无填充（镂空，只留边框）
                    text = re.sub(
                        r'Brush \((\d+),(\d+),(\d+)\)',
                        lambda m: f'Brush (1,{m.group(2)})', text,
                    )
                elif mif_fill is not None:
                    # MapInfo Brush (pattern, forecolor, backcolor)。GDAL 默认 pattern=1（无填充/透明），
                    # 保留会导致设置填充色仍显示空白 → 实心 pattern=2 使填充色生效。
                    # MIF 无 alpha 通道，透明度用【稀疏大颗粒 pattern】模拟（官方规范：
                    # pattern≥3 且省略 backcolor = 透明填充）。透明度越高颗粒越稀。
                    # brush_pattern 显式传入时用它（TAB 中转时用两档：实心/空心）。
                    pattern = brush_pattern if brush_pattern is not None else mif_opacity_brush_pattern(opacity)
                    if pattern == 2:
                        # 不透明：实心 + 保留 backcolor
                        text = re.sub(
                            r'Brush \((\d+),(\d+),(\d+)\)',
                            lambda m: f'Brush (2,{mif_fill},{m.group(3)})', text,
                        )
                    else:
                        # 透明填充：稀疏 pattern + 省略 backcolor（Brush(pattern, fg)）
                        text = re.sub(
                            r'Brush \((\d+),(\d+),(\d+)\)',
                            lambda m: f'Brush ({pattern},{mif_fill})', text,
                        )
            out_path.write_text(text, encoding="gbk")
        elif output_format == "kml":
            text = out_path.read_text(encoding="utf-8", errors="replace")
            # 防御：已注入过样式则跳过（用我们注入的独特标记判断）。
            # 注意：GDAL 扇区 KML 自带 <Style><LineStyle>...<fill>0</fill> 样式，
            # 不能以 "<Style>" 是否存在作判断；扇区以 <outline> 为标记（GDAL 不写 outline），
            # 点以 <IconStyle> 为标记（GDAL 点 KML 不写 IconStyle）。
            if (is_point and "<IconStyle><color>" in text) or (not is_point and "<outline>" in text):
                return out_path
            # 透明度语义：0=不透明、1=全透明；未显式传透明度 → 完全不透明（transparency=0）
            kml_transparency = opacity if opacity is not None else 0.0
            if is_point:
                if hex_to_kml_color(border_color) is None:
                    return out_path
                href = svg_point_icon(point_shape or "circle", border_color, hollow=hollow)
                scale = 1.0
                if point_size is not None:
                    scale = max(0.3, min(3.0, point_size / 8 * 0.6))
                style = (
                    f'<Style><IconStyle>'
                    f'<color>{_kml_color_with_alpha(border_color, kml_transparency)}</color>'
                    f'<scale>{scale:.2f}</scale>'
                    f'<Icon><href>{href}</href></Icon>'
                    f'</IconStyle></Style>'
                )
                # 点 KML 无 GDAL 自带样式 → 内联注入到 <Placemark ...> 后作为第一个子元素
                text = re.sub(
                    r'(<Placemark[^>]*>)',
                    lambda m: m.group(1) + '\n' + style,
                    text,
                )
            else:
                border_none = is_no_color(border_color)
                fill_none = is_no_color(fill_color)
                kml_border = None if border_none else hex_to_kml_color(border_color)
                kml_fill = None if fill_none else _kml_color_with_alpha(fill_color, kml_transparency)
                if border_none and fill_none:
                    return out_path      # 边框与填充都无色：无样式可写（前端已拦截）
                if kml_border is None and kml_fill is None:
                    return out_path      # 颜色非法
                parts = []
                if kml_border is not None:
                    width = int(line_width or 2)
                    width = max(1, min(7, width))
                    parts.append(
                        f'<LineStyle>'
                        f'<color>{_kml_color_with_alpha(border_color, kml_transparency)}</color>'
                        f'<width>{width}</width>'
                        f'</LineStyle>'
                    )
                if fill_none:
                    # 填充无色：镂空（不填充，只显示边框）
                    parts.append('<PolyStyle><fill>0</fill><outline>1</outline></PolyStyle>')
                elif kml_fill is not None:
                    # 边框无色时 outline=0，否则 Google Earth 会用默认黑边描边
                    outline = 0 if border_none else 1
                    parts.append(
                        f'<PolyStyle>'
                        f'<color>{kml_fill}</color>'
                        f'<fill>1</fill><outline>{outline}</outline>'
                        f'</PolyStyle>'
                    )
                style = f'<Style>{"".join(parts)}</Style>'
                # 改写 GDAL 自身写入的样式（fill=0 会覆盖我们的填充），
                # 替换后每个 Placemark 恰好一个 Style（KML schema 只允许一个）
                text = re.sub(
                    r'<Style><LineStyle><color>[0-9a-fA-F]{8}</color></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>',
                    lambda m: style,
                    text,
                )
            out_path.write_text(text, encoding="utf-8")
        return out_path

    def _verify_readable(self, out_path: Path, expected_rows: int, output_format: str):
        """生成后读回验证：文件可解析且行数一致，否则抛 ValueError。"""
        try:
            if output_format == "kml":
                import xml.etree.ElementTree as ET
                root = ET.fromstring(out_path.read_text(encoding="utf-8", errors="replace"))
                # 通配命名空间匹配（兼容带/不带 kml 命名空间）
                count = len(root.findall(".//{*}Placemark"))
                if count != expected_rows:
                    raise ValueError(
                        f"读回行数不一致（期望 {expected_rows}，实际 {count}）"
                    )
                return
            import pyogrio
            info = pyogrio.read_info(str(out_path))
            count = info["features"]
            if count == -1:
                # MIF 等驱动不报告特征数（需全量扫描），改用实际读取统计行数
                count = len(pyogrio.read_dataframe(str(out_path)))
            if count != expected_rows:
                raise ValueError(
                    f"读回行数不一致（期望 {expected_rows}，实际 {count}）"
                )
        except ValueError:
            raise
        except Exception as e:
            raise ValueError(f"生成文件校验失败（{output_format} 不可读）: {str(e)}") from e

    def generate_point_layer(self, file_path: str, sheet_name: str,
                             name_col: str, lon_col: str, lat_col: str,
                             attributes: List[str], output_format: str,
                             color: Optional[str] = None,
                             source_filename: Optional[str] = None,
                             border_color: Optional[str] = None,
                             fill_color: Optional[str] = None,
                             opacity: Optional[float] = None,
                             point_size: Optional[float] = None,
                             point_shape: Optional[str] = None):
        """生成点图层，返回 (输出文件路径, stats_dict)。
        stats 包含 total/success/failed/failures 分类计数。
        source_filename: 原始源文件名（未被 _save_upload 重命名），用于输出文件命名。
        不提供时回退到 file_path 的文件名。
        border_color/fill_color/opacity: 样式参数。fill_color 为颜色时按填充色绘制点（无填充概念，
        兼容旧调用把颜色放在 border_color/color）；fill_color 为"无色"哨兵时生成空心点，
        border_color 作为空心轮廓色。TAB 经临时 MIF 中转写入原生样式，
        透明度只做两档（实心/空心，见 tab_opacity_brush_pattern）。
        point_size: 点大小（像素，MIF/MapInfo Symbol size、KML scale）。
        point_shape: 点形状（circle/square/diamond/triangle/triangle_down/landmark/pin，
        MIF/MapInfo Symbol shape 编号、KML SVG 图标）。
        """
        df = self._read_sheet(file_path, sheet_name)
        lon, lat, coord_valid, failures = self._coerce_coords(df, lon_col, lat_col)

        # 标签名缺失校验
        if name_col and name_col in df.columns:
            name_missing = df[name_col].isna() | (df[name_col].astype(str).str.strip() == "")
            failures["missing_name"] = int(name_missing.sum())
        else:
            failures["missing_name"] = 0
            name_missing = pd.Series([False] * len(df), index=df.index)

        valid = coord_valid & ~name_missing

        if valid.sum() == 0:
            raise ValueError(
                f"全部行校验失败（成功 0/{len(df)}），请检查数据"
            )

        geoms = [Point(x, y) for x, y in zip(lon[valid], lat[valid])]
        gdf = self._build_gdf(df, lon, lat, valid, attributes, geoms, keep_cols_extra=[name_col])
        if output_format == "kml":
            gdf = self._ensure_kml_name(gdf, name_col)
        # 填充颜色为"无色"（'none'）→ 空心点：符号换空心形状、用轮廓色（border_color）绘制；
        # 否则用填充色绘制（fill_color 缺省时回退 border_color/color，兼容旧调用）
        no_fill = is_no_color(fill_color)
        symbol_color = (border_color or color) if no_fill else (fill_color or border_color or color)
        out = self._write(gdf, output_format,
                          source_filename=source_filename or Path(file_path).name,
                          sheet_name=sheet_name, layer_type="point",
                          style=dict(border_color=symbol_color, fill_color=None,
                                     opacity=opacity, is_point=True,
                                     point_size=point_size, point_shape=point_shape,
                                     hollow=no_fill))
        self._verify_readable(out, int(valid.sum()), output_format)

        stats = {
            "total": int(len(df)),
            "success": int(valid.sum()),
            "failed": int(len(df) - valid.sum()),
            "failures": {k: int(v) for k, v in failures.items()},
            "failedDetails": self._collect_failed_details(
                df, valid, lon_col, lat_col, name_col=name_col,
            ),
        }
        return out, stats

    def generate_sector_layer(self, file_path: str, sheet_name: str,
                              name_col: str, lon_col: str, lat_col: str,
                              azimuth_col: str, radius_m: float, beamwidth: float,
                              attributes: List[str], output_format: str,
                              color: Optional[str] = None,
                              source_filename: Optional[str] = None,
                              border_color: Optional[str] = None,
                              fill_color: Optional[str] = None,
                              opacity: Optional[float] = None,
                              line_width: Optional[float] = None):
        """生成扇区图层，返回 (输出文件路径, stats_dict)。
        stats 包含 total/success/failed/failures 分类计数。
        source_filename: 原始源文件名（未被 _save_upload 重命名），用于输出文件命名。
        不提供时回退到 file_path 的文件名。
        border_color/fill_color/opacity: 样式参数。扇区边框色=border_color、填充=fill_color、
        透明度=opacity。两色均支持"无色"哨兵（'none'）：边框无色 → 不描边、填充无色 → 镂空。
        line_width: 描边线宽（像素，clamp 1-7）。
        TAB 经临时 MIF 中转写入原生样式，透明度只做两档（实心/空心）。
        """
        df = self._read_sheet(file_path, sheet_name)
        lon, lat, coord_valid, failures = self._coerce_coords(df, lon_col, lat_col)

        # 方位角校验
        failures["invalid_azimuth"] = 0
        azi = pd.to_numeric(df[azimuth_col], errors="coerce")
        azi_ok = azi.between(0, 360) & azi.notna()
        failures["invalid_azimuth"] += int((~azi_ok).sum())

        # 标签名缺失校验
        if name_col and name_col in df.columns:
            name_missing = df[name_col].isna() | (df[name_col].astype(str).str.strip() == "")
            failures["missing_name"] = int(name_missing.sum())
        else:
            failures["missing_name"] = 0
            name_missing = pd.Series([False] * len(df), index=df.index)

        valid = coord_valid & azi_ok & ~name_missing
        if valid.sum() == 0:
            raise ValueError(
                f"全部行校验失败（成功 0/{len(df)}），请检查数据"
            )
        # 全零/全空方位角列会被 between(0,360) 静默接受，导致所有扇区退化为朝北楔形
        nonzero = azi_ok & (azi > 0)
        if nonzero.sum() == 0:
            raise ValueError("方位角列全为 0 或空值，无法生成有效扇区，请检查方位角列选择")
        geoms = [
            sector_polygon(y, x, a, beamwidth, radius_m)
            for x, y, a in zip(lon[valid], lat[valid], azi[valid])
        ]
        gdf = self._build_gdf(df, lon, lat, valid, attributes, geoms, keep_cols_extra=[name_col])
        if output_format == "kml":
            gdf = self._ensure_kml_name(gdf, name_col)
        out = self._write(gdf, output_format,
                          source_filename=source_filename or Path(file_path).name,
                          sheet_name=sheet_name, layer_type="sector",
                          style=dict(border_color=border_color or color,
                                     fill_color=fill_color or color,
                                     opacity=opacity, is_point=False,
                                     line_width=line_width))
        self._verify_readable(out, int(valid.sum()), output_format)

        stats = {
            "total": int(len(df)),
            "success": int(valid.sum()),
            "failed": int(len(df) - valid.sum()),
            "failures": {k: int(v) for k, v in failures.items()},
            "failedDetails": self._collect_failed_details(
                df, valid, lon_col, lat_col,
                azimuth_col=azimuth_col, name_col=name_col,
            ),
        }
        return out, stats

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
