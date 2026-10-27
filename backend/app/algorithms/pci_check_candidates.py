"""
PCI核查候选枚举与工参取值工具

全部为纯函数：输入「小区数组视图」（lats/lons/freqs/site_codes）或小区 dict，
输出满足距离/同频/同站条件的小区对，供核查服务按类别消费。
"""

import math
from collections import defaultdict
from typing import Any, Dict, Iterator, List, Optional, Tuple

import numpy as np

from app.algorithms.distance_calculator import DistanceCalculator, Point
from app.algorithms.grid_index import GridIndex
from app.algorithms.pci_check_types import MOD3_SAME_SITE_EXEMPTION_COUNT

# 分块计算距离的行数，控制单次 numpy 矩阵规模
DISTANCE_CHUNK = 512


def coerce_coord(value: Any) -> Optional[float]:
    """坐标转 float；None/空/0/非数字/NaN/Inf 均视为缺失"""
    if value is None or isinstance(value, bool):
        return None
    try:
        coord = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(coord) or coord == 0:
        return None
    return coord


def coerce_azimuth(value: Any) -> Optional[float]:
    """方位角转 float；0 是合法值，仅缺失/越界返回 None"""
    if value is None or isinstance(value, bool):
        return None
    try:
        azimuth = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(azimuth) or azimuth < 0 or azimuth >= 360:
        return None
    return azimuth


def coerce_int(value: Any) -> Optional[int]:
    """整数取值；None/空串/非数字返回 None"""
    if value is None or isinstance(value, bool) or (isinstance(value, float) and not math.isfinite(value)):
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(float(text))
    except (TypeError, ValueError):
        return None


def coerce_float(value: Any) -> Optional[float]:
    """浮点取值；None/空串/非数字返回 None（频点保留小数）"""
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        number = float(text)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def meters(distance_km: float) -> float:
    """公里转米，保留 1 位小数"""
    return round(distance_km * 1000, 1)


def angle_within(azimuth: float, bearing: float, gate_deg: float) -> bool:
    """判断目标方位是否落在天线方位角 ±gate_deg 内"""
    diff = abs((azimuth - bearing + 180.0) % 360.0 - 180.0)
    return diff <= gate_deg


def grid_steps(arr: Dict[str, Any], max_km: float) -> Tuple[float, float]:
    """按 max_km 生成经纬度网格步长（度）。

    经度步长取数据集内最大绝对纬度，保证任何位置的网格都不小于 max_km，
    3×3 邻域搜索不会漏掉门限内的点对。
    """
    max_abs_lat = float(np.max(np.abs(arr["lats"])))
    lat_step = max_km / 111.0
    lon_step = max_km / (111.0 * max(0.2, math.cos(math.radians(max_abs_lat))))
    return lat_step, lon_step


def bucket_keys(arr: Dict[str, Any], max_km: float) -> List[Tuple[int, int]]:
    """每个小区的网格桶坐标"""
    lat_step, lon_step = grid_steps(arr, max_km)
    lats, lons = arr["lats"], arr["lons"]
    return [
        (math.floor(float(lats[i]) / lat_step), math.floor(float(lons[i]) / lon_step))
        for i in range(len(lats))
    ]


def cells_within_band(arr: Dict[str, Any], flags: np.ndarray, band_km: float) -> List[int]:
    """返回距任一核查小区不超过 band_km 的小区下标（精确距离，分块向量化）"""
    lats, lons = arr["lats"], arr["lons"]
    selected = np.nonzero(flags)[0]
    if selected.size == 0:
        return []
    if selected.size == len(lats):
        # 全量勾选时目标池就是全量，无需再做 O(N²) 距离裁剪
        return list(range(len(lats)))

    total = len(lats)
    keep = np.zeros(total, dtype=bool)
    grid = GridIndex(lats[selected], lons[selected], step_km=band_km)
    selected_lats = lats[selected]
    selected_lons = lons[selected]
    for idx in range(total):
        if not np.isfinite(lats[idx]) or not np.isfinite(lons[idx]):
            continue
        near = grid.query(float(lats[idx]), float(lons[idx]), band_km)
        if near.size == 0:
            continue
        dist = DistanceCalculator.batch_haversine(
            np.array([lats[idx]]), np.array([lons[idx]]),
            selected_lats[near], selected_lons[near],
        )
        keep[idx] = float(dist.min()) <= band_km
    return [int(i) for i in np.nonzero(keep)[0]]


def group_pairs(
    keys: List[Optional[Tuple]], lats: np.ndarray, lons: np.ndarray, max_km: float
) -> Iterator[Tuple[int, int, float]]:
    """同组（如 同频同PCI）内枚举距离 ≤ max_km 的 i<j 小区对"""
    by_group: Dict[Tuple, List[int]] = defaultdict(list)
    for idx, key in enumerate(keys):
        if key is not None:
            by_group[key].append(idx)

    for members in by_group.values():
        if len(members) < 2:
            continue
        member_arr = np.array(members, dtype=np.int64)
        for start in range(0, len(member_arr), DISTANCE_CHUNK):
            block = member_arr[start:start + DISTANCE_CHUNK]
            dist = DistanceCalculator.batch_haversine(
                lats[block], lons[block], lats[member_arr], lons[member_arr]
            )
            for offset in range(len(block)):
                i = int(block[offset])
                for j_pos in np.nonzero((member_arr > i) & (dist[offset] <= max_km))[0]:
                    yield i, int(member_arr[j_pos]), float(dist[offset][j_pos])


def near_pairs(
    arr: Dict[str, Any], max_km: float, exclude_same_site: bool
) -> Iterator[Tuple[int, int, float]]:
    """经纬度网格枚举 max_km 内、同频的 i<j 小区对（对打距离小、必须用网格）"""
    lats, lons, freqs = arr["lats"], arr["lons"], arr["freqs"]
    codes = arr["site_codes"]
    if np.count_nonzero(freqs >= 0) == 0:
        return

    buckets: Dict[Tuple[int, int], List[int]] = defaultdict(list)
    for idx, key in enumerate(bucket_keys(arr, max_km)):
        if freqs[idx] >= 0:
            buckets[key].append(idx)

    for (bucket_x, bucket_y), members in buckets.items():
        candidates = list(members)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx or dy:
                    candidates.extend(buckets.get((bucket_x + dx, bucket_y + dy), ()))
        cand = np.array(candidates, dtype=np.int64)
        for i in members:
            dist = DistanceCalculator.batch_haversine(
                lats[np.array([i])], lons[np.array([i])], lats[cand], lons[cand]
            )[0]
            mask = (cand > i) & (freqs[cand] == freqs[i]) & (dist <= max_km)
            if exclude_same_site:
                mask &= codes[cand] != codes[i]
            for pos in np.nonzero(mask)[0]:
                yield i, int(cand[pos]), float(dist[pos])


def is_facing(cell_a: Dict, cell_b: Dict, gate_deg: float) -> bool:
    """对打判定：两小区主瓣互相朝向；任一侧缺方位角则退化为仅距离判定"""
    azimuth_a, azimuth_b = cell_a["azimuth"], cell_b["azimuth"]
    if azimuth_a is None or azimuth_b is None:
        return True
    origin = Point(cell_a["longitude"], cell_a["latitude"])
    target = Point(cell_b["longitude"], cell_b["latitude"])
    bearing = DistanceCalculator.calculate_bearing(origin, target)
    return (
        angle_within(azimuth_a, bearing, gate_deg)
        and angle_within(azimuth_b, (bearing + 180.0) % 360.0, gate_deg)
    )


def distance_km(cells: List[Dict], i: int, j: int) -> float:
    """两个小区间的球面距离（公里）"""
    return DistanceCalculator.calculate_distance(
        cells[i]["longitude"], cells[i]["latitude"], cells[j]["longitude"], cells[j]["latitude"]
    )


def same_site_mod_pairs(
    cells: List[Dict], arr: Dict[str, Any], modulus: int
) -> Iterator[Tuple[int, int]]:
    """枚举同站同频模值异常对。

    模3 站内同频小区超过 3 个时按 PCI 规划的非连续分配规则判定：按小区ID排序后，
    只有相邻位置模3 相同才算异常；3 个及以内仍要求两两模3 不能相同。
    模30 不受此豁免，与 NR 规划约束一致：同站同频模30 一律不能相同。
    """
    groups: Dict[Tuple[int, float], List[int]] = defaultdict(list)
    freqs = arr["freqs"]
    for idx in range(len(cells)):
        if freqs[idx] >= 0:
            groups[(int(arr["site_codes"][idx]), float(freqs[idx]))].append(idx)

    for members in groups.values():
        if len(members) < 2:
            continue
        if modulus == 3 and len(members) > MOD3_SAME_SITE_EXEMPTION_COUNT:
            ordered = sorted(members, key=lambda idx: cell_order_key(cells[idx]))
            for pos in range(len(ordered) - 1):
                i, j = ordered[pos], ordered[pos + 1]
                if int(arr["pcis"][i]) % 3 == int(arr["pcis"][j]) % 3:
                    yield i, j
            continue
        for pos, i in enumerate(members):
            for j in members[pos + 1:]:
                if int(arr["pcis"][i]) % modulus == int(arr["pcis"][j]) % modulus:
                    yield i, j


def cell_order_key(cell: Dict) -> Tuple[int, Any]:
    """小区ID排序键：数字ID按数值，其余按字符串排在后面"""
    sector_id = str(cell["sectorId"])
    try:
        return 0, int(float(sector_id))
    except (TypeError, ValueError):
        return 1, sector_id
