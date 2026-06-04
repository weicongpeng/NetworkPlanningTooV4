"""
距离计算工具
"""
import math
from functools import lru_cache
from typing import Tuple, List
from dataclasses import dataclass

import numpy as np


@dataclass
class Point:
    """地理坐标点"""
    longitude: float
    latitude: float

    def to_radian(self) -> Tuple[float, float]:
        """转换为弧度"""
        return math.radians(self.longitude), math.radians(self.latitude)


class DistanceCalculator:
    """距离计算器"""

    EARTH_RADIUS = 6371.0  # 地球半径，单位：公里

    @staticmethod
    @lru_cache(maxsize=500000)
    def _haversine_cached(lat1_deg: float, lon1_deg: float, lat2_deg: float, lon2_deg: float) -> float:
        """
        使用Haversine公式计算两点间的大圆距离（带 LRU 缓存）
        以度数输入，内部转为弧度计算

        Args:
            lat1_deg: 起始点纬度
            lon1_deg: 起始点经度
            lat2_deg: 终点纬度
            lon2_deg: 终点经度

        Returns:
            距离，单位：公里
        """
        lat1_rad = math.radians(lat1_deg)
        lon1_rad = math.radians(lon1_deg)
        lat2_rad = math.radians(lat2_deg)
        lon2_rad = math.radians(lon2_deg)

        dlat = lat2_rad - lat1_rad
        dlon = lon2_rad - lon1_rad

        a = (math.sin(dlat / 2) ** 2 +
             math.cos(lat1_rad) * math.cos(lat2_rad) *
             math.sin(dlon / 2) ** 2)

        # 浮点舍入防护（与 batch_haversine 的 np.clip 保持一致）
        a = max(0.0, min(1.0, a))
        c = 2 * math.asin(math.sqrt(a))

        return DistanceCalculator.EARTH_RADIUS * c

    @classmethod
    def haversine_distance(cls, point1: Point, point2: Point) -> float:
        """
        使用Haversine公式计算两点间的大圆距离

        Args:
            point1: 起始点 (经度, 纬度)
            point2: 终点 (经度, 纬度)

        Returns:
            距离，单位：公里
        """
        return cls._haversine_cached(
            point1.latitude, point1.longitude,
            point2.latitude, point2.longitude
        )

    @classmethod
    def euclidean_distance(cls, point1: Point, point2: Point) -> float:
        """
        计算欧几里得距离（适用于小范围）

        Args:
            point1: 起始点 (经度, 纬度)
            point2: 终点 (经度, 纬度)

        Returns:
            距离，单位：公里
        """
        # 1度约等于111公里
        dx = (point2.longitude - point1.longitude) * 111 * math.cos(math.radians(point1.latitude))
        dy = (point2.latitude - point1.latitude) * 111

        return math.sqrt(dx ** 2 + dy ** 2)

    @classmethod
    def calculate_distance(cls, lon1: float, lat1: float, lon2: float, lat2: float) -> float:
        """
        计算两点间距离

        Args:
            lon1: 起始点经度
            lat1: 起始点纬度
            lon2: 终点经度
            lat2: 终点纬度

        Returns:
            距离，单位：公里
        """
        return cls.haversine_distance(Point(lon1, lat1), Point(lon2, lat2))

    @classmethod
    def batch_haversine(
        cls,
        lats1: np.ndarray,
        lons1: np.ndarray,
        lats2: np.ndarray,
        lons2: np.ndarray,
    ) -> np.ndarray:
        """
        批量 Haversine 距离计算（numpy 向量化）

        使用 numpy broadcasting 计算两组坐标间所有配对的距离。

        Args:
            lats1: 第一组纬度, shape (N,)
            lons1: 第一组经度, shape (N,)
            lats2: 第二组纬度, shape (M,)
            lons2: 第二组经度, shape (M,)

        Returns:
            (N, M) 距离矩阵，单位：公里
        """
        lat1_rad = np.radians(lats1)
        lon1_rad = np.radians(lons1)
        lat2_rad = np.radians(lats2)
        lon2_rad = np.radians(lons2)

        # Broadcasting: (N,1) - (1,M) -> (N,M)
        dlat = lat2_rad[np.newaxis, :] - lat1_rad[:, np.newaxis]
        dlon = lon2_rad[np.newaxis, :] - lon1_rad[:, np.newaxis]

        a = (
            np.sin(dlat / 2) ** 2
            + np.cos(lat1_rad[:, np.newaxis])
            * np.cos(lat2_rad[np.newaxis, :])
            * np.sin(dlon / 2) ** 2
        )

        # 浮点保护：避免因舍入误差导致 arcsin 域外
        a = np.clip(a, 0.0, 1.0)
        c = 2 * np.arcsin(np.sqrt(a))

        return cls.EARTH_RADIUS * c

    @classmethod
    def batch_distance_matrix(cls, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
        """
        计算 N 个点之间的全量 NxN 距离矩阵

        Args:
            lats: 纬度数组, shape (N,)
            lons: 经度数组, shape (N,)

        Returns:
            (N, N) 对称距离矩阵，单位：公里
        """
        return cls.batch_haversine(lats, lons, lats, lons)

    @classmethod
    def find_within_radius(cls, center: Point, points: List[Point], radius: float) -> List[int]:
        """
        查找半径范围内的点

        Args:
            center: 中心点
            points: 点列表
            radius: 半径，单位：公里

        Returns:
            在半径范围内的点的索引列表
        """
        result = []
        for i, point in enumerate(points):
            distance = cls.haversine_distance(center, point)
            if distance <= radius:
                result.append(i)
        return result

    @classmethod
    def calculate_bearing(cls, point1: Point, point2: Point) -> float:
        """
        计算从点1到点2的方位角

        Args:
            point1: 起始点
            point2: 终点

        Returns:
            方位角，单位：度，范围[0, 360)
        """
        lon1_rad, lat1_rad = point1.to_radian()
        lon2_rad, lat2_rad = point2.to_radian()

        dlon = lon2_rad - lon1_rad

        x = (math.sin(dlon) * math.cos(lat2_rad))
        y = (math.cos(lat1_rad) * math.sin(lat2_rad) -
             math.sin(lat1_rad) * math.cos(lat2_rad) * math.cos(dlon))

        bearing = math.atan2(x, y)
        bearing = math.degrees(bearing)
        bearing = (bearing + 360) % 360

        return bearing
