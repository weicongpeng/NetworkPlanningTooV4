# backend/app/services/distance_match_service.py
"""批量距离匹配服务：网格预筛 + haversine + xlsx 输出"""
import math
from typing import List, Dict, Tuple

import numpy as np
import pandas as pd
from openpyxl import Workbook

# 输出列名（固定，含备注）
OUTPUT_COLUMNS = [
    "匹配站点名称", "匹配站点经度", "匹配站点纬度",
    "全量站点名称", "全量站点经度", "全量站点纬度",
    "距离（km）", "备注",
]
UNMATCHED_NOTE = "无匹站点匹配"

# 校验常量
LON_MIN, LON_MAX = -180.0, 180.0
LAT_MIN, LAT_MAX = -90.0, 90.0
# 名称列识别（模板固定列名，含必要容错）
NAME_ALIASES = ["CELL", "小区名称", "小区名", "NAME", "站点名称"]
LON_ALIASES = ["LON", "经度", "LONGITUDE"]
LAT_ALIASES = ["LAT", "纬度", "LATITUDE"]


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """列名归一化：把常见变体映射到 CELL/LON/LAT。缺列抛 ValueError。"""
    cols = {str(c).strip().upper(): c for c in df.columns}
    name_col = next((cols.get(a.upper()) for a in NAME_ALIASES if a.upper() in cols), None)
    lon_col = next((cols.get(a.upper()) for a in LON_ALIASES if a.upper() in cols), None)
    lat_col = next((cols.get(a.upper()) for a in LAT_ALIASES if a.upper() in cols), None)
    missing = []
    if name_col is None:
        missing.append("CELL")
    if lon_col is None:
        missing.append("LON")
    if lat_col is None:
        missing.append("LAT")
    if missing:
        raise ValueError(f"缺少必需列: {', '.join(missing)}")
    out = df[[name_col, lon_col, lat_col]].copy()
    out.columns = ["CELL", "LON", "LAT"]
    return out


def read_match_file(file_path: str) -> Dict[str, pd.DataFrame]:
    """读取清单 Excel 的两个 sheet，返回 {'匹配站点': df, '全量站点': df}（已归一化列名）。
    缺 sheet 抛 ValueError。"""
    try:
        xls = pd.ExcelFile(file_path, engine="calamine")
    except ImportError:
        # calamine 未安装时回退到默认引擎（openpyxl，仅支持 .xlsx）
        xls = pd.ExcelFile(file_path)
    sheets = {s.strip(): s for s in xls.sheet_names}
    required = {"匹配站点", "全量站点"}
    missing_sheets = [s for s in required if s not in sheets]
    if missing_sheets:
        raise ValueError(f"缺少工作表: {', '.join(missing_sheets)}")
    result = {}
    for key in required:
        df = pd.read_excel(xls, sheet_name=sheets[key])
        result[key] = _normalize_columns(df)
    return result


def validate_sheet(df: pd.DataFrame, sheet_name: str) -> List[Dict[str, object]]:
    """校验经纬度格式/有效性/CELL 非空，返回 [{sheet,row,reason}]"""
    errors: List[Dict[str, object]] = []
    lon = pd.to_numeric(df["LON"], errors="coerce")
    lat = pd.to_numeric(df["LAT"], errors="coerce")
    for i in range(len(df)):
        row_no = i + 2  # Excel 行号（含表头）
        cell = df.iloc[i]["CELL"]
        if pd.isna(cell) or (isinstance(cell, str) and not cell.strip()):
            errors.append({"sheet": sheet_name, "row": row_no, "reason": "站点名称为空"})
        if lon.isna().iloc[i]:
            errors.append({"sheet": sheet_name, "row": row_no, "reason": "经度格式无效"})
        elif not (LON_MIN <= lon.iloc[i] <= LON_MAX):
            errors.append({"sheet": sheet_name, "row": row_no, "reason": "经度超出有效范围"})
        if lat.isna().iloc[i]:
            errors.append({"sheet": sheet_name, "row": row_no, "reason": "纬度格式无效"})
        elif not (LAT_MIN <= lat.iloc[i] <= LAT_MAX):
            errors.append({"sheet": sheet_name, "row": row_no, "reason": "纬度超出有效范围"})
    return errors


def validate_all(match_df: pd.DataFrame, full_df: pd.DataFrame) -> List[Dict[str, object]]:
    return validate_sheet(match_df, "匹配站点") + validate_sheet(full_df, "全量站点")


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Haversine 球面距离，返回 km"""
    r = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def match_sites(
    match_df: pd.DataFrame,
    full_df: pd.DataFrame,
    max_distance_km: float,
) -> Tuple[List[tuple], List[str]]:
    """返回 (results, unmatched)。
    results: [(匹配CELL, 匹配LON, 匹配LAT, 全量CELL, 全量LON, 全量LAT, 距离km), ...]
    unmatched: [匹配CELL, ...]（无命中）"""
    if max_distance_km <= 0:
        raise ValueError("相邻距离门限必须大于 0")
    match_df = match_df.copy()
    full_df = full_df.copy()
    match_df["LON"] = pd.to_numeric(match_df["LON"], errors="coerce")
    match_df["LAT"] = pd.to_numeric(match_df["LAT"], errors="coerce")
    full_df["LON"] = pd.to_numeric(full_df["LON"], errors="coerce")
    full_df["LAT"] = pd.to_numeric(full_df["LAT"], errors="coerce")

    full_lon = full_df["LON"].to_numpy()
    full_lat = full_df["LAT"].to_numpy()
    full_cell = full_df["CELL"].to_numpy()

    results: List[tuple] = []
    unmatched: List[str] = []
    for _, row in match_df.iterrows():
        lon, lat, cell = row["LON"], row["LAT"], row["CELL"]
        if pd.isna(lon) or pd.isna(lat):
            continue  # 校验已拦截，防御
        dlat = max_distance_km / 110.574
        dlon = max_distance_km / (111.320 * math.cos(math.radians(lat)))
        mask = (
            (full_lon >= lon - dlon) & (full_lon <= lon + dlon) &
            (full_lat >= lat - dlat) & (full_lat <= lat + dlat)
        )
        idxs = np.where(mask)[0]
        hits = []
        for j in idxs:
            d = haversine_km(lon, lat, full_lon[j], full_lat[j])
            if d <= max_distance_km:
                hits.append((cell, lon, lat, full_cell[j], full_lon[j], full_lat[j], round(d, 4)))
        if hits:
            results.extend(hits)
        else:
            unmatched.append(cell)
    return results, unmatched


def build_output_excel(
    out_path: str,
    match_df: pd.DataFrame,
    results: List[tuple],
    unmatched: List[str],
) -> str:
    """生成输出 xlsx（8 列），返回 out_path。匹配站点全部保留，无命中行备注。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "匹配结果"
    ws.append(OUTPUT_COLUMNS)

    unmatched_set = set(unmatched)
    for _, row in match_df.iterrows():
        cell = row["CELL"]
        if cell in unmatched_set:
            ws.append([cell, row["LON"], row["LAT"], None, None, None, None, UNMATCHED_NOTE])
    for (c1, lon1, lat1, c2, lon2, lat2, d) in results:
        ws.append([c1, lon1, lat1, c2, lon2, lat2, d, None])

    wb.save(out_path)
    return out_path


def build_output_filename() -> str:
    """返回 匹配结果{YYYYMMDD_HHMMSS}.xlsx"""
    from datetime import datetime
    return f"匹配结果{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"


def load_full_params_from_data(
    data_id: str,
    network_type: str,
    name_col: str,
    lon_col: str,
    lat_col: str,
) -> pd.DataFrame:
    """从数据管理已导入工参读取全量站点（LTE/NR 分表），归一化列名。
    返回 df 列 = [CELL, LON, LAT]。"""
    from app.services.data_service import data_service
    data = data_service.get_data(data_id)
    if not isinstance(data, dict):
        raise ValueError("数据不存在或无法读取")
    key = network_type.upper()
    rows = data.get(key, [])
    if not rows:
        raise ValueError(f"数据中不存在网络类型 {key} 的数据")
    df = pd.DataFrame(rows)
    for col in (name_col, lon_col, lat_col):
        if col not in df.columns:
            raise ValueError(f"列 {col} 不存在于该工参数据")
    out = df[[name_col, lon_col, lat_col]].copy()
    out.columns = ["CELL", "LON", "LAT"]
    return out
