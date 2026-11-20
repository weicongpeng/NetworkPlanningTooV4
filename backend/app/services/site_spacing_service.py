# backend/app/services/site_spacing_service.py
"""平均站间距计算服务：3D 单位球面 Cartesian + 批量点积 KNN

算法说明：
- 将每个站点的 (lat, lon) 投影到单位球面 3D 坐标 (x, y, z)
  · x = cos(lat) * cos(lon)
  · y = cos(lat) * sin(lon)
  · z = sin(lat)
- 在单位球面上，点积 p1·p2 = cos(α)，其中 α 为球面角（弧度）
- 点积越大 = 距离越近，因此 K 近邻 = 点积最大的 K 个点
- 实现：批量矩阵乘法 (B, 3) @ (3, N) = (B, N) 计算点积
- argpartition 仅取 K 个最大（小 O(N) 而非 sort 的 O(N log N)）
- 最后将 chord 距离转 haversine km

为什么不用 scipy：项目无 scipy 依赖，pure numpy 已能达到 1万站 < 5s、10万站 < 60s 的性能。
"""
import math
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from openpyxl import Workbook

from app.core.config import settings

# 输出列名（固定）
OUTPUT_COLUMNS = [
    "站点名称", "经度", "纬度", "平均站间距(km)", "参与计算邻居数",
]

# 校验常量
LON_MIN, LON_MAX = -180.0, 180.0
LAT_MIN, LAT_MAX = -90.0, 90.0

# 名称列识别（与 distance_match_service 一致）
NAME_ALIASES = ["CELL", "小区名称", "小区名", "标签名称", "标签名", "NAME", "站点名称", "基站名称", "CGI"]
LON_ALIASES = ["LON", "经度", "LONGITUDE", "基站经度", "小区经度"]
LAT_ALIASES = ["LAT", "纬度", "LATITUDE", "基站纬度", "小区纬度"]


def _normalize_columns(df: pd.DataFrame, strict: bool = False) -> pd.DataFrame:
    """列名归一化：把常见变体映射到 CELL/LON/LAT。
    strict=True 时严格要求列名完全匹配（用于前端列名智能匹配失败时的提示）。
    缺列抛 ValueError。
    """
    cols = {str(c).strip().upper(): c for c in df.columns}
    name_col = next((cols.get(a.upper()) for a in NAME_ALIASES if a.upper() in cols), None)
    lon_col = next((cols.get(a.upper()) for a in LON_ALIASES if a.upper() in cols), None)
    lat_col = next((cols.get(a.upper()) for a in LAT_ALIASES if a.upper() in cols), None)
    missing = []
    if name_col is None:
        missing.append("CELL（标签名称）")
    if lon_col is None:
        missing.append("LON（经度）")
    if lat_col is None:
        missing.append("LAT（纬度）")
    if missing:
        raise ValueError(
            f"无法识别以下列：{', '.join(missing)}。"
            f"请确保列名包含 标签名称（CELL/小区名称/站点名称）、经度（LON/经度）、纬度（LAT/纬度）之一。"
        )
    out = df[[name_col, lon_col, lat_col]].copy()
    out.columns = ["CELL", "LON", "LAT"]
    return out


def _validate_sheet(df: pd.DataFrame, sheet_name: str = "") -> List[Dict[str, object]]:
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


def _read_table(file_path: str) -> pd.DataFrame:
    """读取表格文件：xlsx/xls → sheet 0；csv/txt → 自动探测编码与分隔符。

    返回 df（未做列名归一化，调用方决定）。
    """
    p = Path(file_path)
    ext = p.suffix.lower()
    if ext in (".xlsx", ".xls"):
        try:
            xls = pd.ExcelFile(file_path, engine="calamine")
        except ImportError:
            xls = pd.ExcelFile(file_path)
        return pd.read_excel(xls, sheet_name=xls.sheet_names[0])
    # csv / txt：尝试多种编码
    encodings = ["utf-8", "utf-8-sig", "gbk", "gb18030", "latin-1"]
    last_err: Optional[Exception] = None
    for enc in encodings:
        try:
            # sep=None 让 pandas 自动嗅探（csv.Sniffer）
            return pd.read_csv(file_path, encoding=enc, sep=None, engine="python")
        except UnicodeDecodeError as e:
            last_err = e
            continue
        except Exception as e:
            last_err = e
            continue
    raise ValueError(f"无法读取 CSV/TXT 文件（尝试编码：{', '.join(encodings)}）：{last_err}")


def read_sites_file(file_path: str) -> pd.DataFrame:
    """读取文件中的站点（仅一个逻辑表，列归一化为 CELL/LON/LAT），过滤无效行。

    支持 .xlsx / .xls / .csv / .txt：
    - Excel：读第一个 sheet
    - CSV/TXT：自动探测编码与分隔符
    """
    df = _read_table(file_path)
    out = _normalize_columns(df)
    out["LON"] = pd.to_numeric(out["LON"], errors="coerce")
    out["LAT"] = pd.to_numeric(out["LAT"], errors="coerce")
    cell = out["CELL"]
    valid = cell.notna() & ~(cell.astype(str).str.strip().eq("")) & out["LON"].notna() & out["LAT"].notna()
    out = out.loc[valid].copy()
    return out.drop_duplicates(subset=["CELL"], keep="first").reset_index(drop=True)


def validate_sites_file(file_path: str) -> List[Dict[str, object]]:
    """校验文件中的全部行（用于前端错误明细）。"""
    df = _read_table(file_path)
    df = _normalize_columns(df)
    return _validate_sheet(df, sheet_name=Path(file_path).name)


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Haversine 球面距离，返回 km（arctan2 形式，数值稳定）"""
    r = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _latlon_to_unit_xyz(lat_deg: np.ndarray, lon_deg: np.ndarray) -> np.ndarray:
    """(lat, lon) deg → 单位球面 3D Cartesian (N, 3) float32
    使用 float32 节省内存：精度对 KNN 距离排序足够（相对误差 ~1e-7）
    """
    lat_r = np.radians(lat_deg.astype(np.float32))
    lon_r = np.radians(lon_deg.astype(np.float32))
    cos_lat = np.cos(lat_r)
    return np.stack(
        [cos_lat * np.cos(lon_r), cos_lat * np.sin(lon_r), np.sin(lat_r)],
        axis=1,
    )


def _chord_to_haversine_km(chord: np.ndarray) -> np.ndarray:
    """chord 长度（0~2）→ haversine km。chord = 2*sin(α/2)，α = 2*arcsin(chord/2)"""
    r = 6371.0
    half = np.clip(chord.astype(np.float32) * 0.5, 0.0, 1.0)
    return r * 2.0 * np.arcsin(half)


def _haversine_np(
    lon1: np.ndarray, lat1: np.ndarray,
    lon2: np.ndarray, lat2: np.ndarray,
) -> np.ndarray:
    """向量化 haversine，输入支持 (B,1) 与 (B,K) 广播，返回 km（与标量 haversine_km 等价）"""
    r = 6371.0
    lon1_r = np.radians(lon1)
    lat1_r = np.radians(lat1)
    lon2_r = np.radians(lon2)
    lat2_r = np.radians(lat2)
    dphi = lat2_r - lat1_r
    dlambda = lon2_r - lon1_r
    a = np.sin(dphi / 2) ** 2 + np.cos(lat1_r) * np.cos(lat2_r) * np.sin(dlambda / 2) ** 2
    return 2 * r * np.arctan2(np.sqrt(a), np.sqrt(1 - a))


def compute_avg_spacing(
    cells: List[str],
    lons: List[float],
    lats: List[float],
    k: int,
) -> List[Tuple[str, float, float, float, int]]:
    """对每个站点计算到最近 K 个站点的平均距离。

    返回 [(CELL, LON, LAT, 平均距离km, 参与计算邻居数), ...]，
    按输入顺序输出。当某站点邻居数 < K 时（数据集太小），按实际可用数计算。
    站点自身排除在 K 近邻之外（自距=0 无意义）。

    算法（批量 3D 点积 KNN）：
    1. 转单位球面 3D 坐标 (N, 3) float32
    2. 分批点积：query (B,3) @ xyz.T (3,N) = (B,N) 一次算一批
    3. argpartition 取 K+1 个最大点积（含自身），剔除自身后保留 K 个
    4. 用欧式距离（chord）转 haversine
    """
    if k <= 0:
        raise ValueError("最近站点数必须大于 0")
    n = len(cells)
    if n == 0:
        return []
    if n < 2:
        return [(cells[0], lons[0], lats[0], 0.0, 0)]

    # 有效 K：不超过其他站点数
    effective_k = min(k, n - 1)

    xyz = _latlon_to_unit_xyz(np.asarray(lats, dtype=float), np.asarray(lons, dtype=float))
    # 预计算每个点到自身的点积位置（自身点积 = 1.0）
    # 我们的实现：top K+1 中若包含自身索引，则用 K+1 替代，保证选出 K 个其他点

    # 批大小：经验值。500 批×1万 ≈ 40MB（float32），平衡速度与内存
    batch_size = 500
    out: List[Tuple[str, float, float, float, int]] = []

    for start in range(0, n, batch_size):
        end = min(start + batch_size, n)
        q = xyz[start:end]                          # (B, 3)
        dots = q @ xyz.T                              # (B, N)  球面 cos(α)
        # 自身点积 = 1.0 一定在 top K+1 中。设置对角线为 -inf 即可排除
        # 但广播对角线赋值在 (B, N) 上需逐行设置
        rows = np.arange(end - start)
        cols = np.arange(start, end)
        dots[rows, cols] = -np.inf

        # 取 K+1 个最大（其中第 1 个可能是其他站点），剔除自身（已置 -inf）后剩 K
        # 注意：effective_k 可能 < K+1（极小数据集）。用 min(effective_k+1, N) 防止越界
        kth = min(effective_k, dots.shape[1] - 1)
        top_idx = np.argpartition(-dots, kth=kth, axis=1)[:, :kth]  # (B, kth) 未排序

        # 计算每行 top_idx 对应的精确 haversine 距离
        # gather 邻居经纬度 → (B, kth)
        neighbor_lons = np.asarray(lons, dtype=float)[top_idx]         # (B, kth)
        neighbor_lats = np.asarray(lats, dtype=float)[top_idx]         # (B, kth)
        q_lon = np.asarray(lons, dtype=float)[start:end][:, None]     # (B, 1)
        q_lat = np.asarray(lats, dtype=float)[start:end][:, None]     # (B, 1)
        # 向量化 haversine（B, kth）
        dists_km = _haversine_np(q_lon, q_lat, neighbor_lons, neighbor_lats)
        # 每行平均
        avg = dists_km.mean(axis=1).astype(np.float64)
        # 参与计算邻居数（实际取到几个：可能 < effective_k 当 dot 极小但这里总能达到）
        actual_k = (dists_km.shape[1])

        for j, idx in enumerate(range(start, end)):
            out.append((cells[idx], lons[idx], lats[idx], float(round(avg[j], 4)), actual_k))

    return out


def compute_overall_stats(
    results: List[Tuple[str, float, float, float, int]],
) -> Dict[str, float]:
    """对所有站点的平均站间距再次求平均，得到整体平均站间距。

    - 仅纳入 actual_k > 0 的站点（单点/无邻居无意义）
    - total = results 总条数
    - counted = 实际参与统计的站点数
    """
    counted = [r for r in results if r[4] > 0]
    if counted:
        avg_km = sum(r[3] for r in counted) / len(counted)
    else:
        avg_km = 0.0
    return {
        "total": len(results),
        "counted": len(counted),
        "overall_avg_km": round(avg_km, 4),
    }


def build_output_excel(
    out_path: str,
    results: List[Tuple[str, float, float, float, int]],
    stats: Optional[Dict[str, float]] = None,
) -> str:
    """生成输出 xlsx：
    - Sheet 1「站间距结果」：每个站点的平均站间距明细
    - Sheet 2「汇总」：整体平均站间距 + 参与计算站点数（可选）

    stats 为 None 时不创建汇总 sheet（向后兼容旧调用方）。
    """
    wb = Workbook()
    ws = wb.active
    ws.title = "站间距结果"
    ws.append(OUTPUT_COLUMNS)
    for row in results:
        ws.append(row)

    if stats is not None:
        ws2 = wb.create_sheet(title="汇总")
        ws2.append(["指标", "数值"])
        ws2.append(["总站点数", stats.get("total", 0)])
        ws2.append(["参与计算站点数", stats.get("counted", 0)])
        ws2.append(["整体平均站间距(km)", stats.get("overall_avg_km", 0.0)])

    wb.save(out_path)
    return out_path


def build_output_filename() -> str:
    """返回 站间距结果{YYYYMMDD_HHMMSSffffff}.xlsx（含微秒，避免并发碰撞）"""
    return f"站间距结果{datetime.now().strftime('%Y%m%d_%H%M%S%f')}.xlsx"
