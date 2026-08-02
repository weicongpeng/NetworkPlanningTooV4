"""
图层制作服务

根据 Excel 工参文件生成 MapInfo (TAB/MIF) 和 KML 格式的图层文件。
使用 pyogrio + geopandas 写入（内置 GDAL/OGR 绑定，无需安装 GDAL）。
扇区几何使用 Flat-Earth 近似算法（与前端 SectorRendererSVG 一致）。
"""
import io
import math
import re
from pathlib import Path
from typing import List, Optional

import pandas as pd
import geopandas as gpd
from shapely.geometry import Point, Polygon

# 输出格式 → pyogrio driver 名
DRIVER_MAP = {
    "tab": "MapInfo File",
    "mif": "MapInfo File",
    "kml": "KML",
}
# 扩展名
EXT_MAP = {"tab": ".tab", "mif": ".mif", "kml": ".kml"}

# 点形状 → MapInfo Symbol shape 编号
POINT_SHAPE_MIF = {
    "circle": 35, "square": 33, "diamond": 36,
    "triangle": 40, "triangle_down": 41, "landmark": 42, "pin": 38,
}


# MapInfo 非法字段名字符（非字母数字/下划线/中文）
_MAPINFO_INVALID = re.compile(r"[^\w一-鿿]+")

# 生成前清理的历史输出后缀（含 -1/-2 序号残留）
_CLEANUP_SUFFIXES = (".tab", ".dat", ".id", ".map", ".mif", ".mid", ".zip", ".kml")


def _sanitize_field_name(name: str) -> str:
    """MapInfo 字段名清洗：非法字符（空格等）→ 下划线，合并相邻下划线，去首尾。"""
    cleaned = _MAPINFO_INVALID.sub("_", name)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
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
                   radius_m: float, arc_points: int = 30) -> Polygon:
    """生成扇形（楔形）多边形
    角度以正北为 0，顺时针。azimuth ± beamwidth/2 构成扇区两边界，弧线 arc_points 段。
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


def _kml_color_with_alpha(color: Optional[str], opacity: float) -> Optional[str]:
    """KML aabbggrr + 指定透明度 opacity(0-1)。非法颜色返回 None"""
    c = hex_to_kml_color(color)
    if c is None:
        return None
    a = max(0.0, min(1.0, float(opacity)))
    return f"{int(round(a * 255)):02x}{c[2:]}"


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
               layer_type: str = "") -> Path:
        """写入文件，返回路径。文件名 = 源文件名 + sheet名 + 图层类型标记（去uuid，冲突加序号）。
        中文编码：TAB/MIF 写前重命名列名为 ASCII 占位 + encoding='GBK' + 写后恢复列名。
        base 按 100 字节、sheet 按 50 字节截断，总长 < ext4 NAME_MAX 255。
        layer_type: 'sector'/'point' 追加到文件名，保证扇区与点图不同文件（不互相覆盖）。
        """
        if output_format not in DRIVER_MAP:
            raise ValueError(f"不支持的输出格式: {output_format}")
        base = _truncate_bytes(Path(source_filename).stem, 100)
        safe_sheet = _truncate_bytes(re.sub(r'[<>:"/\\|?*]', "_", sheet_name), 50)
        type_tag = "_sector" if layer_type == "sector" else "_point"
        fname = f"{base}_{safe_sheet}{type_tag}{EXT_MAP[output_format]}"
        out_path = self._unique_path(self.output_dir / fname)
        if output_format in ("tab", "mif"):
            # 重命名中文列为 ASCII 占位名 → GBK 写入 → 恢复（清洗字段名：空格→下划线，去重）
            orig_cols = list(gdf.columns)
            sanitized_cols = _dedupe_field_names([_sanitize_field_name(c) for c in orig_cols])
            rename = {c: f"f{i}" for i, c in enumerate(orig_cols)}
            gdf_ascii = gdf.rename(columns=rename)
            gdf_ascii.to_file(out_path, driver=DRIVER_MAP[output_format], encoding="GBK")
            self._mapinfo_postprocess(out_path, output_format, sanitized_cols)
        else:
            gdf.to_file(out_path, driver=DRIVER_MAP[output_format])
        return out_path

    def _apply_style(self, out_path: Path, output_format: str,
                     border_color: Optional[str], fill_color: Optional[str],
                     opacity: Optional[float], is_point: bool,
                     line_width: Optional[int] = None,
                     point_size: Optional[float] = None,
                     point_shape: Optional[str] = None) -> Path:
        """后处理注入样式：边框颜色/填充颜色/透明度/线宽（仅 MIF/KML，TAB 无颜色支持）。

        MIF 扇区: Pen 颜色 = 边框色，Brush 前景 = 填充色（背景保留白色）。
        MIF 点:   Symbol (shape, 颜色, size) = 点形状映射 + 边框色 + 点大小。
        KML 扇区: LineStyle color=边框色 + PolyStyle color=填充色(带透明度) + outline=1。
                  GDAL 自身会在 Polygon 后写 LineStyle+PolyStyle(fill=0) 样式，
                  该样式位于本函数注入的 Style 之后、作用更优先，故需同时改写 GDAL 样式。
        KML 点:   IconStyle color=边框色 + scale 由点大小决定 + Icon href=形状 SVG Data URI。

        非法颜色/透明度或 TAB 直接返回原文件。MIF 使用 GBK 编码（与 _write GBK 输出一致）。
        """
        if output_format not in ("mif", "kml"):
            return out_path
        if output_format == "mif":
            text = out_path.read_text(encoding="gbk", errors="replace")
            mif_border = hex_to_mapinfo_color(border_color)
            if is_point:
                # 点 Symbol (shape, 颜色, size) 替换：形状映射 + 边框色 + 点大小
                if mif_border is not None:
                    shape = POINT_SHAPE_MIF.get(point_shape or "circle", 35)
                    size = int(point_size or 12)
                    text = re.sub(
                        r'Symbol \((\d+),(\d+),(\d+)\)',
                        lambda m: f'Symbol ({shape},{mif_border},{size})', text,
                    )
            else:
                mif_fill = hex_to_mapinfo_color(fill_color)
                # 扇区 Pen 颜色 = 边框色、线宽 = pen_width；Brush 前景 = 填充色
                pen_width = max(1, min(7, int(line_width or 2)))
                if mif_border is not None:
                    text = re.sub(
                        r'Pen \((\d+),(\d+),(\d+)\)',
                        lambda m: f'Pen ({m.group(1)},{mif_border},{pen_width})', text,
                    )
                if mif_fill is not None:
                    text = re.sub(
                        r'Brush \((\d+),(\d+),(\d+)\)',
                        lambda m: f'Brush ({m.group(1)},{mif_fill},{m.group(3)})', text,
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
            kml_opacity = opacity if opacity is not None else 1.0
            if is_point:
                if hex_to_kml_color(border_color) is None:
                    return out_path
                scale = 1.0
                if point_size is not None:
                    scale = max(0.3, min(3.0, point_size / 8 * 0.6))
                style = (
                    f'<Style><IconStyle>'
                    f'<color>{_kml_color_with_alpha(border_color, kml_opacity)}</color>'
                    f'<scale>{scale:.2f}</scale>'
                    f'</IconStyle></Style>'
                )
                # 点 KML 无 GDAL 自带样式 → 内联注入到 <Placemark ...> 后作为第一个子元素
                text = re.sub(
                    r'(<Placemark[^>]*>)',
                    lambda m: m.group(1) + '\n' + style,
                    text,
                )
            else:
                kml_border = hex_to_kml_color(border_color)
                kml_fill = _kml_color_with_alpha(fill_color, kml_opacity)
                # 至少一个颜色有效才改写
                if kml_border is None and kml_fill is None:
                    return out_path
                parts = []
                if kml_border is not None:
                    width = int(line_width or 2)
                    width = max(1, min(7, width))
                    parts.append(
                        f'<LineStyle>'
                        f'<color>{_kml_color_with_alpha(border_color, kml_opacity)}</color>'
                        f'<width>{width}</width>'
                        f'</LineStyle>'
                    )
                if kml_fill is not None:
                    parts.append(
                        f'<PolyStyle>'
                        f'<color>{kml_fill}</color>'
                        f'<fill>1</fill><outline>1</outline>'
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
        border_color/fill_color/opacity: 样式参数。点图层颜色按边框语义应用
        （点无填充概念），fill_color 忽略。TAB 不支持颜色。
        point_size: 点大小（像素，MIF Symbol size / KML scale）。
        point_shape: 点形状（circle/square/diamond/triangle/triangle_down/landmark/pin，
        MIF Symbol shape 编号、KML SVG 图标）。
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
        out = self._write(gdf, output_format,
                          source_filename=source_filename or Path(file_path).name,
                          sheet_name=sheet_name, layer_type="point")
        out = self._apply_style(
            out, output_format,
            border_color=border_color or color, fill_color=None,
            opacity=opacity, is_point=True,
            point_size=point_size, point_shape=point_shape,
        )
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
        透明度=opacity（作用于填充/边框/点的整体透明度）。line_width: 描边线宽（像素，clamp 1-7）。
        TAB 不支持颜色。
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
                          sheet_name=sheet_name, layer_type="sector")
        out = self._apply_style(
            out, output_format,
            border_color=border_color or color,
            fill_color=fill_color or color,
            opacity=opacity, is_point=False,
            line_width=line_width,
        )
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
