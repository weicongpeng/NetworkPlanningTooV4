"""
距离计算工具
"""
import math
from typing import Tuple, List
from dataclasses import dataclass


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
        lon1_rad, lat1_rad = point1.to_radian()
        lon2_rad, lat2_rad = point2.to_radian()

        dlat = lat2_rad - lat1_rad
        dlon = lon2_rad - lon1_rad

        a = (math.sin(dlat / 2) ** 2 +
             math.cos(lat1_rad) * math.cos(lat2_rad) *
             math.sin(dlon / 2) ** 2)

        c = 2 * math.asin(math.sqrt(a))

        return cls.EARTH_RADIUS * c

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
