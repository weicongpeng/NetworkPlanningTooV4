"""
坐标转换工具 - WGS84 (GPS) ↔ GCJ02 (高德/腾讯地图)

坐标系说明:
- WGS84: GPS原始坐标系，国际上通用的坐标系
- GCJ02: 火星坐标系，高德、腾讯等中国地图服务使用
- BD09: 百度坐标系，在GCJ02基础上再次加密

转换场景:
1. GPS设备获取的坐标(WGS84) → 需要显示在高德地图 → 转换为GCJ02
2. 高德API返回的坐标(GCJ02) → 需要存储为标准坐标 → 转换为WGS84
3. 高德Place API搜索结果(GCJ02) → 存储或与其他数据对比 → 转换为WGS84
"""

import math
import numpy as np
from typing import Tuple, List, Dict, Any


class CoordinateTransformer:
    """
    坐标转换器类 - WGS84 ↔ GCJ02
    """

    # WGS84 转 GCJ02 的常数
    _X_PI = (math.pi * 3000.0) / 180.0
    _A = 6378245.0  # 长半轴
    _EE = 0.00669342162296594323  # 扁率

    # 中国边界
    _CHINA_BOUNDS = {
        'lng_min': 72.004,
        'lng_max': 137.8347,
        'lat_min': 0.8293,
        'lat_max': 55.8271
    }

    @staticmethod
    def _is_in_china(lat: float, lng: float) -> bool:
        """
        判断是否在中国境内（粗略判断）
        不在中国境内不需要转换
        """
        return (CoordinateTransformer._CHINA_BOUNDS['lng_min'] <= lng <=
                CoordinateTransformer._CHINA_BOUNDS['lng_max'] and
                CoordinateTransformer._CHINA_BOUNDS['lat_min'] <= lat <=
                CoordinateTransformer._CHINA_BOUNDS['lat_max'])

    @staticmethod
    def _transform_lat(x: float, y: float) -> float:
        """WGS84 转 GCJ02 纬度变换算法"""
        ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
        ret += ((20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0) / 3.0
        ret += ((20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0) / 3.0
        ret += ((160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0) / 3.0
        return ret

    @staticmethod
    def _transform_lon(x: float, y: float) -> float:
        """WGS84 转 GCJ02 经度变换算法"""
        ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
        ret += ((20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0) / 3.0
        ret += ((20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0) / 3.0
        ret += ((150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0) / 3.0
        return ret

    @staticmethod
    def wgs84_to_gcj02(wgs_lat: float, wgs_lng: float) -> Tuple[float, float]:
        """
        将 WGS84 坐标转换为 GCJ02 坐标

        使用场景:
        - GPS设备获取的坐标需要显示在高德地图上
        - 标准WGS84坐标数据需要在地图上渲染

        Args:
            wgs_lat: WGS84 纬度
            wgs_lng: WGS84 经度

        Returns:
            GCJ02 坐标 (纬度, 经度)
        """
        # 不在中国境内不需要转换
        if not CoordinateTransformer._is_in_china(wgs_lat, wgs_lng):
            return wgs_lat, wgs_lng

        d_lat = CoordinateTransformer._transform_lat(wgs_lng - 105.0, wgs_lat - 35.0)
        d_lng = CoordinateTransformer._transform_lon(wgs_lng - 105.0, wgs_lat - 35.0)
        rad_lat = (wgs_lat / 180.0) * math.pi
        magic = math.sin(rad_lat)
        magic = 1 - CoordinateTransformer._EE * magic * magic
        sqrt_magic = math.sqrt(magic)
        d_lat = (d_lat * 180.0) / (((CoordinateTransformer._A * (1 - CoordinateTransformer._EE)) /
                                     (magic * sqrt_magic)) * math.pi)
        d_lng = (d_lng * 180.0) / (CoordinateTransformer._A / sqrt_magic *
                                   math.cos(rad_lat) * math.pi)
        mg_lat = wgs_lat + d_lat
        mg_lng = wgs_lng + d_lng

        return mg_lat, mg_lng

    @staticmethod
    def wgs84_to_gcj02_batch(
        wgs_lats: np.ndarray, wgs_lngs: np.ndarray
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        批量将 WGS84 坐标转换为 GCJ02 坐标（numpy 向量化版本）

        Args:
            wgs_lats: WGS84 纬度数组
            wgs_lngs: WGS84 经度数组

        Returns:
            GCJ02 坐标 (纬度数组, 经度数组)
        """
        # 不在中国境内的不需要转换
        in_china = (
            (wgs_lngs >= CoordinateTransformer._CHINA_BOUNDS['lng_min']) &
            (wgs_lngs <= CoordinateTransformer._CHINA_BOUNDS['lng_max']) &
            (wgs_lats >= CoordinateTransformer._CHINA_BOUNDS['lat_min']) &
            (wgs_lats <= CoordinateTransformer._CHINA_BOUNDS['lat_max'])
        )

        # 初始化结果为原始坐标
        gcj_lats = wgs_lats.copy()
        gcj_lngs = wgs_lngs.copy()

        # 只转换中国境内的坐标
        if in_china.any():
            x = wgs_lngs[in_china] - 105.0
            y = wgs_lats[in_china] - 35.0

            d_lat = CoordinateTransformer._transform_lat_batch(x, y)
            d_lng = CoordinateTransformer._transform_lon_batch(x, y)

            rad_lat = (wgs_lats[in_china] / 180.0) * np.pi
            magic = np.sin(rad_lat)
            magic = 1 - CoordinateTransformer._EE * magic * magic
            sqrt_magic = np.sqrt(magic)
            d_lat = (d_lat * 180.0) / (
                (CoordinateTransformer._A * (1 - CoordinateTransformer._EE)) /
                (magic * sqrt_magic) * np.pi
            )
            d_lng = (d_lng * 180.0) / (
                CoordinateTransformer._A / sqrt_magic *
                np.cos(rad_lat) * np.pi
            )

            gcj_lats[in_china] = wgs_lats[in_china] + d_lat
            gcj_lngs[in_china] = wgs_lngs[in_china] + d_lng

        return gcj_lats, gcj_lngs

    @staticmethod
    def _transform_lat_batch(x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """批量 WGS84→GCJ02 纬度变换"""
        ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * np.sqrt(np.abs(x))
        ret += ((20.0 * np.sin(6.0 * x * np.pi) + 20.0 * np.sin(2.0 * x * np.pi)) * 2.0) / 3.0
        ret += ((20.0 * np.sin(y * np.pi) + 40.0 * np.sin(y / 3.0 * np.pi)) * 2.0) / 3.0
        ret += ((160.0 * np.sin(y / 12.0 * np.pi) + 320 * np.sin(y * np.pi / 30.0)) * 2.0) / 3.0
        return ret

    @staticmethod
    def _transform_lon_batch(x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """批量 WGS84→GCJ02 经度变换"""
        ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * np.sqrt(np.abs(x))
        ret += ((20.0 * np.sin(6.0 * x * np.pi) + 20.0 * np.sin(2.0 * x * np.pi)) * 2.0) / 3.0
        ret += ((20.0 * np.sin(x * np.pi) + 40.0 * np.sin(x / 3.0 * np.pi)) * 2.0) / 3.0
        ret += ((150.0 * np.sin(x / 12.0 * np.pi) + 300.0 * np.sin(x / 30.0 * np.pi)) * 2.0) / 3.0
        return ret

    @staticmethod
    def gcj02_to_wgs84(gcj_lat: float, gcj_lng: float) -> Tuple[float, float]:
        """
        将 GCJ02 坐标转换为 WGS84 坐标

        使用场景:
        - 高德API返回的坐标需要存储为标准坐标
        - 高德Place API搜索结果需要与其他WGS84数据对比

        注意: 这是近似算法，精度约1-2米

        Args:
            gcj_lat: GCJ02 纬度
            gcj_lng: GCJ02 经度

        Returns:
            WGS84 坐标 (纬度, 经度)
        """
        # 不在中国境内不需要转换
        if not CoordinateTransformer._is_in_china(gcj_lat, gcj_lng):
            return gcj_lat, gcj_lng

        d_lat = CoordinateTransformer._transform_lat(gcj_lng - 105.0, gcj_lat - 35.0)
        d_lng = CoordinateTransformer._transform_lon(gcj_lng - 105.0, gcj_lat - 35.0)
        rad_lat = (gcj_lat / 180.0) * math.pi
        magic = math.sin(rad_lat)
        magic = 1 - CoordinateTransformer._EE * magic * magic
        sqrt_magic = math.sqrt(magic)
        d_lat = (d_lat * 180.0) / (((CoordinateTransformer._A * (1 - CoordinateTransformer._EE)) /
                                     (magic * sqrt_magic)) * math.pi)
        d_lng = (d_lng * 180.0) / (CoordinateTransformer._A / sqrt_magic *
                                   math.cos(rad_lat) * math.pi)
        mg_lat = gcj_lat + d_lat
        mg_lng = gcj_lng + d_lng

        # 逆向转换: WGS84 = GCJ02 - 偏移
        return gcj_lat * 2 - mg_lat, gcj_lng * 2 - mg_lng

    @staticmethod
    def transform_geojson_coordinates(coordinates: Any, from_wgs84: bool = True) -> Any:
        """
        转换 GeoJSON 坐标

        Args:
            coordinates: GeoJSON 坐标 (可能是单个点、线、或面)
            from_wgs84: True 表示从 WGS84 转换到 GCJ02，False 表示从 GCJ02 转换到 WGS84

        Returns:
            转换后的坐标
        """
        if from_wgs84:
            transform_func = CoordinateTransformer.wgs84_to_gcj02
        else:
            transform_func = CoordinateTransformer.gcj02_to_wgs84

        # Point: [longitude, latitude]
        if isinstance(coordinates, list) and len(coordinates) > 0:
            first_item = coordinates[0]
            # 检查是否是数字（坐标点）
            if isinstance(first_item, (int, float)):
                if len(coordinates) >= 2:
                    lng, lat = coordinates[0], coordinates[1]
                    new_lat, new_lng = transform_func(lat, lng)
                    return [new_lng, new_lat] + coordinates[2:]
                return coordinates
            # 递归处理嵌套坐标（Line 的点列、Polygon 环、MultiGeometry）
            else:
                return [CoordinateTransformer.transform_geojson_coordinates(coord, from_wgs84)
                        for coord in coordinates]

        return coordinates


def wgs84_to_gcj02(lat: float, lng: float) -> Tuple[float, float]:
    """便捷函数: WGS84 转 GCJ02"""
    return CoordinateTransformer.wgs84_to_gcj02(lat, lng)


def gcj02_to_wgs84(lat: float, lng: float) -> Tuple[float, float]:
    """便捷函数: GCJ02 转 WGS84"""
    return CoordinateTransformer.gcj02_to_wgs84(lat, lng)


def calculate_distance(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """
    计算两点之间的距离（使用Haversine公式）

    Args:
        lat1: 第一个点的纬度
        lng1: 第一个点的经度
        lat2: 第二个点的纬度
        lng2: 第二个点的经度

    Returns:
        两点之间的距离（米）
    """
    R = 6378137  # 地球半径（米）
    d_lat = (lat2 - lat1) * math.pi / 180
    d_lng = (lng2 - lng1) * math.pi / 180
    a = (math.sin(d_lat / 2) * math.sin(d_lat / 2) +
         math.cos(lat1 * math.pi / 180) * math.cos(lat2 * math.pi / 180) *
         math.sin(d_lng / 2) * math.sin(d_lng / 2))
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c
