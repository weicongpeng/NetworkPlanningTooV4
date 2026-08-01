"""
图层制作服务

根据 Excel 工参文件生成 MapInfo (TAB/MIF) 和 KML 格式的图层文件。
使用 pyogrio + geopandas 写入（内置 GDAL/OGR 绑定，无需安装 GDAL）。
扇区几何使用 Flat-Earth 近似算法（与前端 SectorRendererSVG 一致）。
"""
import math
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
        """校验经纬度合法，非法抛异常"""
        lon = pd.to_numeric(df[lon_col], errors="coerce")
        lat = pd.to_numeric(df[lat_col], errors="coerce")
        valid = lon.between(-180, 180) & lat.between(-90, 90) & lon.notna() & lat.notna()
        if valid.sum() == 0:
            raise ValueError("经纬度数据无效，请检查经纬度列选择")
        if valid.sum() < len(df) * 0.5:
            raise ValueError(f"有效坐标少于50%（{valid.sum()}/{len(df)}），请检查数据质量")
        return lon, lat, valid

    def _build_gdf(self, df: pd.DataFrame, lon: pd.Series, lat: pd.Series,
                   valid: pd.Series, attributes: List[str], geometry_cols) -> gpd.GeoDataFrame:
        """构建 GeoDataFrame，仅保留有效坐标行和勾选属性列"""
        if not attributes:
            raise ValueError("请至少选择一个图层属性列")
        sub = df.loc[valid].copy()
        keep = [c for c in sub.columns if c in attributes]
        if not keep:
            raise ValueError("所选属性列在数据中不存在，请检查属性列选择")
        sub = sub[keep]
        gdf = gpd.GeoDataFrame(sub, geometry=geometry_cols, crs="EPSG:4326")
        return gdf

    def _write(self, gdf: gpd.GeoDataFrame, output_format: str) -> Path:
        """写入文件，返回路径"""
        if output_format not in DRIVER_MAP:
            raise ValueError(f"不支持的输出格式: {output_format}")
        fname = f"layer_{uuid.uuid4().hex[:12]}{EXT_MAP[output_format]}"
        out_path = self.output_dir / fname
        gdf.to_file(out_path, driver=DRIVER_MAP[output_format])
        return out_path

    def generate_point_layer(self, file_path: str, sheet_name: str,
                             name_col: str, lon_col: str, lat_col: str,
                             attributes: List[str], output_format: str) -> Path:
        """生成点图层，返回输出文件路径"""
        df = self._read_sheet(file_path, sheet_name)
        lon, lat, valid = self._coerce_coords(df, lon_col, lat_col)
        geoms = [Point(x, y) for x, y in zip(lon[valid], lat[valid])]
        gdf = self._build_gdf(df, lon, lat, valid, attributes, geoms)
        return self._write(gdf, output_format)

    def generate_sector_layer(self, file_path: str, sheet_name: str,
                              name_col: str, lon_col: str, lat_col: str,
                              azimuth_col: str, radius_m: float, beamwidth: float,
                              attributes: List[str], output_format: str) -> Path:
        """生成扇区图层，返回输出文件路径"""
        df = self._read_sheet(file_path, sheet_name)
        lon, lat, valid = self._coerce_coords(df, lon_col, lat_col)
        azi = pd.to_numeric(df[azimuth_col], errors="coerce")
        azi_ok = azi.between(0, 360) & azi.notna()
        valid = valid & azi_ok
        if valid.sum() == 0:
            raise ValueError("方位角数据无效，请检查方位角列选择（0-360度）")
        # 全零/全空方位角列会被 between(0,360) 静默接受，导致所有扇区退化为朝北楔形
        nonzero = azi_ok & (azi > 0)
        if nonzero.sum() == 0:
            raise ValueError("方位角列全为 0 或空值，无法生成有效扇区，请检查方位角列选择")
        geoms = [
            sector_polygon(y, x, a, beamwidth, radius_m)
            for x, y, a in zip(lon[valid], lat[valid], azi[valid])
        ]
        gdf = self._build_gdf(df, lon, lat, valid, attributes, geoms)
        return self._write(gdf, output_format)

    def get_sheet_info(self, file_path: str) -> dict:
        """读取 Excel 的 sheet 列表和各 sheet 列名"""
        xls = pd.ExcelFile(file_path, engine="calamine")
        sheets = xls.sheet_names
        columns = {}
        for s in sheets:
            df = pd.read_excel(xls, sheet_name=s, nrows=1)
            columns[s] = [str(c) for c in df.columns]
        return {"sheets": sheets, "columns": columns}
