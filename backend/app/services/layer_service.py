"""
图层制作服务

根据 Excel 工参文件生成 MapInfo (TAB/MIF) 和 KML 格式的图层文件。
使用 pyogrio + geopandas 写入（内置 GDAL/OGR 绑定，无需安装 GDAL）。
扇区几何使用 Flat-Earth 近似算法（与前端 SectorRendererSVG 一致）。
"""
import math
import re
import uuid
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

    def _read_sheet(self, file_path: str, sheet_name: str) -> pd.DataFrame:
        """读取指定 sheet，返回 DataFrame
        显式指定 calamine engine，保证 .xls 与 .xlsx 均可读取（无需 xlrd/xlwt）。
        """
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

    def _write(self, gdf: gpd.GeoDataFrame, output_format: str,
               source_filename: str, sheet_name: str) -> Path:
        """写入文件，返回路径。文件名 = 源文件名 + sheet名 + 短uuid。
        base 按 100 字节、sheet 按 50 字节截断，总长 ~165 字节 < ext4 NAME_MAX 255。
        """
        if output_format not in DRIVER_MAP:
            raise ValueError(f"不支持的输出格式: {output_format}")
        base = _truncate_bytes(Path(source_filename).stem, 100)
        safe_sheet = _truncate_bytes(re.sub(r'[<>:"/\\|?*]', "_", sheet_name), 50)
        fname = f"{base}_{safe_sheet}_{uuid.uuid4().hex[:8]}{EXT_MAP[output_format]}"
        out_path = self.output_dir / fname
        gdf.to_file(out_path, driver=DRIVER_MAP[output_format])
        return out_path

    def _apply_color(self, out_path: Path, output_format: str,
                     color: Optional[str], is_point: bool) -> Path:
        """后处理注入颜色（仅 MIF/KML，TAB 无颜色支持）
        MIF 替换 Symbol/Brush 样式行；KML 在每个 Placemark 内注入内联 Style。
        非法颜色或 TAB 直接返回原文件。
        """
        if output_format not in ("mif", "kml") or not color:
            return out_path
        text = out_path.read_text(encoding="utf-8", errors="replace")
        if output_format == "mif":
            mif_color = hex_to_mapinfo_color(color)
            if mif_color is None:
                return out_path
            if is_point:
                # 替换点 Symbol 颜色: Symbol (35,0,12) → Symbol (35,<color>,<size>) 保留原 size
                text = re.sub(
                    r'Symbol \((\d+),(\d+),(\d+)\)',
                    lambda m: f'Symbol ({m.group(1)},{mif_color},{m.group(3)})', text,
                )
            else:
                # 替换扇区 Brush: Brush (1,0,16777215) → Brush (2,<color>,16777215) 保留背景
                text = re.sub(
                    r'Brush \((\d+),(\d+),(\d+)\)',
                    lambda m: f'Brush ({m.group(1)},{mif_color},{m.group(3)})', text,
                )
        elif output_format == "kml":
            kml_color = hex_to_kml_color(color)
            if kml_color is None:
                return out_path
            # 防御：已注入过 Style 则跳过，避免重复注入
            if "<PolyStyle><color>" in text or "<IconStyle><color>" in text:
                return out_path
            if is_point:
                style = f'<Style><IconStyle><color>{kml_color}</color></IconStyle></Style>'
            else:
                style = f'<Style><PolyStyle><color>{kml_color}</color></PolyStyle></Style>'
            # 内联注入到 <Placemark ...> 之后作为其第一个子元素（严格查看器才能渲染）
            text = re.sub(
                r'(<Placemark[^>]*>)',
                lambda m: m.group(1) + '\n' + style,
                text,
            )
        out_path.write_text(text, encoding="utf-8")
        return out_path

    def generate_point_layer(self, file_path: str, sheet_name: str,
                             name_col: str, lon_col: str, lat_col: str,
                             attributes: List[str], output_format: str,
                             color: Optional[str] = None,
                             source_filename: Optional[str] = None):
        """生成点图层，返回 (输出文件路径, stats_dict)。
        stats 包含 total/success/failed/failures 分类计数。
        source_filename: 原始源文件名（未被 _save_upload 重命名），用于输出文件命名。
        不提供时回退到 file_path 的文件名。
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
                          sheet_name=sheet_name)
        out = self._apply_color(out, output_format, color, is_point=True)

        stats = {
            "total": int(len(df)),
            "success": int(valid.sum()),
            "failed": int(len(df) - valid.sum()),
            "failures": {k: int(v) for k, v in failures.items()},
        }
        return out, stats

    def generate_sector_layer(self, file_path: str, sheet_name: str,
                              name_col: str, lon_col: str, lat_col: str,
                              azimuth_col: str, radius_m: float, beamwidth: float,
                              attributes: List[str], output_format: str,
                              color: Optional[str] = None,
                              source_filename: Optional[str] = None):
        """生成扇区图层，返回 (输出文件路径, stats_dict)。
        stats 包含 total/success/failed/failures 分类计数。
        source_filename: 原始源文件名（未被 _save_upload 重命名），用于输出文件命名。
        不提供时回退到 file_path 的文件名。
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
                          sheet_name=sheet_name)
        out = self._apply_color(out, output_format, color, is_point=False)

        stats = {
            "total": int(len(df)),
            "success": int(valid.sum()),
            "failed": int(len(df) - valid.sum()),
            "failures": {k: int(v) for k, v in failures.items()},
        }
        return out, stats

    def get_sheet_info(self, file_path: str) -> dict:
        """读取 Excel 的 sheet 列表和各 sheet 列名"""
        xls = pd.ExcelFile(file_path, engine="calamine")
        sheets = xls.sheet_names
        columns = {}
        for s in sheets:
            df = pd.read_excel(xls, sheet_name=s, nrows=1)
            columns[s] = [str(c) for c in df.columns]
        return {"sheets": sheets, "columns": columns}
