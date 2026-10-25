"""经纬度网格索引

按固定步长把点分桶，半径查询只需要扫描有限圈桶，用于把 O(N²) 的全量
距离比较降为邻域候选比较。桶宽在任意纬度都不小于 step_km，故半径 r 的
查询扫描 ceil(r/step)+1 圈桶不会漏点；返回的是桶粗筛结果，调用方仍需
按精确距离过滤。
"""

import math
from collections import defaultdict
from typing import Dict, List, Tuple

import numpy as np


class GridIndex:
    def __init__(self, lats: np.ndarray, lons: np.ndarray, step_km: float = 1.0) -> None:
        self.step_km = float(step_km)
        lats = np.asarray(lats, dtype=float)
        lons = np.asarray(lons, dtype=float)
        max_abs_lat = float(np.max(np.abs(lats))) if lats.size else 0.0
        self.lat_step = self.step_km / 111.0
        self.lon_step = self.step_km / (111.0 * max(0.2, math.cos(math.radians(max_abs_lat))))
        self._buckets: Dict[Tuple[int, int], List[int]] = defaultdict(list)
        for idx, (lat, lon) in enumerate(zip(lats, lons)):
            if math.isnan(lat) or math.isnan(lon):
                continue
            key = (math.floor(lat / self.lat_step), math.floor(lon / self.lon_step))
            self._buckets[key].append(idx)

    def query(self, lat: float, lon: float, radius_km: float) -> np.ndarray:
        """返回半径 radius_km 内（桶粗筛，含少量半径外点）的下标，升序"""
        rings = int(math.ceil(max(radius_km, 0.0) / self.step_km)) + 1
        center_x = math.floor(lat / self.lat_step)
        center_y = math.floor(lon / self.lon_step)
        found: List[int] = []
        for dx in range(-rings, rings + 1):
            for dy in range(-rings, rings + 1):
                found.extend(self._buckets.get((center_x + dx, center_y + dy), ()))
        return np.sort(np.asarray(found, dtype=np.int64)) if found else np.empty(0, dtype=np.int64)
