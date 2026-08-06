# backend/app/services/distance_match_service.py
"""批量距离匹配服务：网格预筛 + haversine + xlsx 输出"""
import math
from pathlib import Path
from typing import List, Dict, Tuple

import numpy as np
import pandas as pd
from openpyxl import Workbook

from app.core.config import settings

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
NAME_ALIASES = ["CELL", "小区名称", "小区名", "NAME", "站点名称", "基站名称", "CGI"]
LON_ALIASES = ["LON", "经度", "LONGITUDE", "基站经度", "小区经度"]
LAT_ALIASES = ["LAT", "纬度", "LATITUDE", "基站纬度", "小区纬度"]


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


def read_arbitrary_sheet(
    file_path: str,
    sheet_name: str,
    name_col: str = None,
    lon_col: str = None,
    lat_col: str = None,
) -> pd.DataFrame:
    """读取任意 sheet（匹配站点/全量站点通用）：按指定列映射或自动识别 CELL/LON/LAT。

    支持数据管理全量工参的复杂表头：第 1 行为「中文名 + \\n 分隔元数据」（如
    '基站经度\\neNodeB Longitude double:[-180..180]'），第 2-3 行为描述文本
    （如 '非必填'），第 4 行起为数据。检测到含 \\n 时清理列名为中文名并按
    skiprows=3 读取；否则按常规 header=0 读取。

    返回 [CELL, LON, LAT]，过滤无效行（CELL 空 / 经纬度非数值）并按 CELL 去重。
    缺 sheet 或缺列抛 ValueError。"""
    try:
        xls = pd.ExcelFile(file_path, engine="calamine")
    except ImportError:
        # calamine 未安装时回退到默认引擎（openpyxl，仅支持 .xlsx）
        xls = pd.ExcelFile(file_path)
    sheets = {s.strip(): s for s in xls.sheet_names}
    key = sheets.get(sheet_name) or sheets.get(sheet_name.strip())
    if key is None:
        raise ValueError(f"缺少工作表: {sheet_name}")

    # 探测复杂表头：第 1 行含 \n 分隔的元数据
    header_row = pd.read_excel(xls, sheet_name=key, header=None, nrows=1).iloc[0]
    clean_columns: List[str] = []
    is_complex = False
    for col in header_row:
        col_str = str(col).strip() if pd.notna(col) else ""
        if "\n" in col_str:
            is_complex = True
            # 提取第一个 \n 之前的中文名称（与 data_service._parse_full_params_sheet 一致）
            clean_columns.append(col_str.split("\n")[0].strip())
        else:
            clean_columns.append(col_str)

    if is_complex:
        # 复杂表头通常占 3 行（第 4 行起是数据）
        df = pd.read_excel(xls, sheet_name=key, header=None, skiprows=3)
        if df.shape[1] != len(clean_columns):
            # 兜底：列数不匹配时退化为 1 行表头重读
            df = pd.read_excel(xls, sheet_name=key, header=None, skiprows=1)
            if df.shape[1] != len(clean_columns):
                raise ValueError(f"工作表 {sheet_name} 列数与表头不匹配")
        df.columns = clean_columns
    else:
        df = pd.read_excel(xls, sheet_name=key)

    # 列映射：显式指定优先，缺省自动识别
    if name_col and lon_col and lat_col:
        for col in (name_col, lon_col, lat_col):
            if col not in df.columns:
                raise ValueError(f"列 {col} 不存在于工作表 {sheet_name}")
        out = df[[name_col, lon_col, lat_col]].copy()
        out.columns = ["CELL", "LON", "LAT"]
    else:
        out = _normalize_columns(df)

    # 过滤无效行（CELL 空 / 经纬度非数值）+ 按 CELL 去重
    out["LON"] = pd.to_numeric(out["LON"], errors="coerce")
    out["LAT"] = pd.to_numeric(out["LAT"], errors="coerce")
    cell = out["CELL"]
    valid = cell.notna() & ~(cell.astype(str).str.strip().eq("")) & out["LON"].notna() & out["LAT"].notna()
    out = out.loc[valid].copy()
    return out.drop_duplicates(subset=["CELL"], keep="first").reset_index(drop=True)


def read_data_sheets(excel_path: str) -> Tuple[List[str], str]:
    """读取数据管理工参原始 Excel 的真实 sheet 列表。

    返回 (sheets, source)：
    - original.xlsx 存在 → (真实 sheet 名列表, "excel")
    - 否则 → (网络分表键列表, "network")  # 兜底：data.json 已解析成 LTE/NR 分表
    """
    p = Path(excel_path)
    if p.is_file() and p.suffix.lower() in (".xlsx", ".xls"):
        try:
            xls = pd.ExcelFile(p, engine="calamine")
        except ImportError:
            # calamine 未安装时回退到默认引擎（openpyxl，仅支持 .xlsx）
            xls = pd.ExcelFile(p)
        return list(xls.sheet_names), "excel"
    # 兜底：网络分表键（get_data 的 dict key）
    from app.services.data_service import data_service
    data = data_service.get_data(p.parent.name)
    if data is None:
        raise ValueError(f"数据不存在: {p.parent.name}")
    if isinstance(data, dict):
        keys = [k for k in data.keys() if isinstance(k, str) and k not in (
            "id", "name", "fileType", "status", "errorMessage", "message",
        )]
        if keys:
            return keys, "network"
    # 数据存在但无网络分表键（如 processing/error 元数据），返回默认网络类型
    return ["LTE", "NR"], "network"


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
    """Haversine 球面距离，返回 km（arctan2 形式，数值稳定）"""
    r = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _haversine_np(
    lon1: float, lat1: float,
    lon2: np.ndarray, lat2: np.ndarray,
) -> np.ndarray:
    """numpy 向量化 haversine（arctan2 形式，数值稳定），返回 km 数组"""
    r = 6371.0
    lon1_r, lat1_r = math.radians(lon1), math.radians(lat1)
    lon2_r = np.radians(lon2)
    lat2_r = np.radians(lat2)
    dphi = lat2_r - lat1_r
    dlambda = lon2_r - lon1_r
    a = np.sin(dphi / 2) ** 2 + np.cos(lat1_r) * np.cos(lat2_r) * np.sin(dlambda / 2) ** 2
    return 2 * r * np.arctan2(np.sqrt(a), np.sqrt(1 - a))


def match_sites(
    match_df: pd.DataFrame,
    full_df: pd.DataFrame,
    max_distance_km: float,
) -> Tuple[List[tuple], List[str]]:
    """返回 (results, unmatched)。
    results: [(匹配CELL, 匹配LON, 匹配LAT, 全量CELL, 全量LON, 全量LAT, 距离km), ...]
    unmatched: [匹配CELL, ...]（无命中）"""
    if not math.isfinite(max_distance_km) or max_distance_km <= 0:
        raise ValueError("相邻距离门限必须大于 0")
    match_df = match_df.copy()
    full_df = full_df.copy()
    match_df["LON"] = pd.to_numeric(match_df["LON"], errors="coerce")
    match_df["LAT"] = pd.to_numeric(match_df["LAT"], errors="coerce")
    full_df["LON"] = pd.to_numeric(full_df["LON"], errors="coerce")
    full_df["LAT"] = pd.to_numeric(full_df["LAT"], errors="coerce")

    # 预筛候选数组 hoisting：避免每行标量访问 full_df
    full_lon = full_df["LON"].to_numpy(dtype=float)
    full_lat = full_df["LAT"].to_numpy(dtype=float)
    full_cell = full_df["CELL"].to_numpy()

    dlat_deg = max_distance_km / 110.574  # 纬度跨度恒定

    results: List[tuple] = []
    unmatched: List[str] = []
    for _, row in match_df.iterrows():
        lon, lat, cell = row["LON"], row["LAT"], row["CELL"]
        if pd.isna(lon) or pd.isna(lat):
            # 校验应在上游拦截；此处不静默丢弃，违反“匹配站点全部出现”
            raise ValueError("存在经纬度无效的匹配站点，请先校验数据")
        # 经度跨度依赖 cos(lat)，clamp 到 epsilon 避免 |lat|=90 除零；仅扩大预筛超集
        cos_lat = max(math.cos(math.radians(lat)), 1e-6)
        dlon_deg = max_distance_km / (111.320 * cos_lat)
        mask = (
            (full_lon >= lon - dlon_deg) & (full_lon <= lon + dlon_deg) &
            (full_lat >= lat - dlat_deg) & (full_lat <= lat + dlat_deg)
        )
        idxs = np.where(mask)[0]
        if idxs.size == 0:
            unmatched.append(cell)
            continue
        # 向量化 haversine：对全部候选一次算出距离，无 Python 内层循环
        dists = _haversine_np(lon, lat, full_lon[idxs], full_lat[idxs])
        keep = dists <= max_distance_km
        if not np.any(keep):
            unmatched.append(cell)
            continue
        sel_lon = full_lon[idxs[keep]]
        sel_lat = full_lat[idxs[keep]]
        sel_cell = full_cell[idxs[keep]]
        sel_dist = np.round(dists[keep], 4)
        results.extend(
            (cell, lon, lat, c2, lo2, la2, float(d))
            for c2, lo2, la2, d in zip(sel_cell, sel_lon, sel_lat, sel_dist)
        )
    return results, unmatched


def build_output_excel(
    out_path: str,
    match_df: pd.DataFrame,
    results: List[tuple],
    unmatched: List[str],
) -> str:
    """生成输出 xlsx（8 列），返回 out_path。匹配站点全部保留，无命中行备注。
    输出按 match_df 行序交错排列：每行先输出命中结果，无命中则输出备注行。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "匹配结果"
    ws.append(OUTPUT_COLUMNS)

    unmatched_set = set(unmatched)
    r_idx = 0  # results 中顺序指针（match_sites 按 match_df 行序产出，同行的命中连续）
    for _, row in match_df.iterrows():
        cell = row["CELL"]
        # 输出该匹配站点的全部命中行（results 中连续属于它的行）
        while r_idx < len(results) and results[r_idx][0] == cell:
            ws.append(results[r_idx])
            r_idx += 1
        # 若无任何命中 → 备注行
        if cell in unmatched_set:
            ws.append([cell, row["LON"], row["LAT"], None, None, None, None, UNMATCHED_NOTE])

    # 防御：results 末尾剩余（正常不会发生，保留以确保完整性）
    while r_idx < len(results):
        ws.append(results[r_idx])
        r_idx += 1

    wb.save(out_path)
    return out_path


def build_output_filename() -> str:
    """返回 匹配结果{YYYYMMDD_HHMMSSffffff}.xlsx（含微秒，避免同秒并发碰撞）"""
    from datetime import datetime
    return f"匹配结果{datetime.now().strftime('%Y%m%d_%H%M%S%f')}.xlsx"


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


def load_full_sites_from_data(
    data_id: str,
    network_type: str,
    name_col: str = None,
    lon_col: str = None,
    lat_col: str = None,
) -> pd.DataFrame:
    """从数据管理已导入工参读取全量站点（LTE/NR 分表）。

    列映射显式指定优先，缺省自动识别（_normalize_columns）。返回 df 列 = [CELL, LON, LAT]。"""
    from app.services.data_service import data_service
    data = data_service.get_data(data_id)
    if not isinstance(data, dict):
        raise ValueError("数据不存在或无法读取")
    key = network_type.upper()
    rows = data.get(key, [])
    if not rows:
        raise ValueError(f"数据中不存在网络类型 {key} 的数据")
    df = pd.DataFrame(rows)
    if name_col and lon_col and lat_col:
        for col in (name_col, lon_col, lat_col):
            if col not in df.columns:
                raise ValueError(f"列 {col} 不存在于该工参数据")
        out = df[[name_col, lon_col, lat_col]].copy()
        out.columns = ["CELL", "LON", "LAT"]
        return out
    return _normalize_columns(df)


def load_full_sites_from_data_sheet(
    data_id: str,
    sheet_name: str,
    name_col: str = None,
    lon_col: str = None,
    lat_col: str = None,
) -> pd.DataFrame:
    """从数据管理工参的原始 Excel 读取指定 sheet 作为全量站点。

    优先 data/{data_id}/original.xlsx 的真实 sheet；文件缺失时回退
    load_full_sites_from_data（JSON 分表 + 列映射，sheet_name 即网络类型）。
    返回 df 列 = [CELL, LON, LAT]。"""
    data_dir = settings.DATA_DIR / data_id
    original = data_dir / "original.xlsx"
    if original.is_file():
        # 列名以所选 sheet 的列名为准（覆盖 load_full_sites 的自动识别）
        return read_arbitrary_sheet(str(original), sheet_name, name_col, lon_col, lat_col)
    # 回退：网络类型分表（sheet_name 即网络类型，如 LTE/NR）
    return load_full_sites_from_data(data_id, sheet_name, name_col, lon_col, lat_col)
