"""
测试 DistanceCalculator 批量距离计算与 LRU 缓存

测试覆盖：
- test_single_pair_matches_scalar: 单对坐标向量化与标量一致
- test_batch_haversine_accuracy: 500 点误差 < 1cm
- test_lru_cache_hits: 同站多扇区缓存命中
- test_distance_matrix_shape: 矩阵形状/对角/对称
"""
import math

import numpy as np
import pytest

from app.algorithms.distance_calculator import DistanceCalculator, Point


class TestDistanceCalculator:
    """DistanceCalculator 批量方法与缓存测试"""

    def setup_method(self):
        """每个测试前清空缓存，确保测试独立"""
        DistanceCalculator._haversine_cached.cache_clear()

    def test_single_pair_matches_scalar(self):
        """单对坐标向量化结果与标量 haversine_distance 一致"""
        # 北京 -> 上海
        lat1, lon1 = 39.9042, 116.4074
        lat2, lon2 = 31.2304, 121.4737

        # 标量计算
        d_scalar = DistanceCalculator.haversine_distance(
            Point(lon1, lat1), Point(lon2, lat2)
        )

        # 向量化计算
        d_batch = DistanceCalculator.batch_haversine(
            np.array([lat1]), np.array([lon1]),
            np.array([lat2]), np.array([lon2]),
        )

        assert d_batch.shape == (1, 1), f"期望 shape (1,1)，得到 {d_batch.shape}"
        assert abs(d_batch[0, 0] - d_scalar) < 1e-10, (
            f"向量化结果 {d_batch[0, 0]} 与标量 {d_scalar} 不一致"
        )

    def test_batch_haversine_accuracy(self):
        """500 随机点：向量化结果与标量逐点比对，误差 < 1cm"""
        np.random.seed(42)
        n = 500
        lats = np.random.uniform(-90, 90, n)
        lons = np.random.uniform(-180, 180, n)

        # 计算第一个点与所有 500 点的批量距离
        d_batch = DistanceCalculator.batch_haversine(
            lats[:1], lons[:1], lats, lons
        )

        for i in range(n):
            d_scalar = DistanceCalculator.haversine_distance(
                Point(float(lons[i]), float(lats[i])),
                Point(float(lons[0]), float(lats[0])),
            )
            err = abs(d_batch[0, i] - d_scalar)
            assert err < 1e-8, (
                f"点 {i} 误差 {err:.2e} km > 1e-8 km (1cm)"
            )

    def test_lru_cache_hits(self):
        """同站多扇区：重复坐标命中 LRU 缓存"""
        lat, lon = 39.9042, 116.4074

        # 缓存初始状态
        info0 = DistanceCalculator._haversine_cached.cache_info()

        # 第一次调用：cache miss
        d1 = DistanceCalculator._haversine_cached(lat, lon, lat, lon)
        info1 = DistanceCalculator._haversine_cached.cache_info()
        assert info1.misses == info0.misses + 1, "第一次调用应为 cache miss"

        # 第二次相同坐标：cache hit
        d2 = DistanceCalculator._haversine_cached(lat, lon, lat, lon)
        info2 = DistanceCalculator._haversine_cached.cache_info()
        assert d1 == d2, "相同坐标应返回相同距离"
        assert info2.hits == info1.hits + 1, "第二次调用应为 cache hit"

        # 通过 haversine_distance 相同坐标：也为 cache hit
        d3 = DistanceCalculator.haversine_distance(
            Point(lon, lat), Point(lon, lat)
        )
        info3 = DistanceCalculator._haversine_cached.cache_info()
        assert abs(d3 - d1) < 1e-12, "haversine_distance 委托结果应一致"
        assert info3.hits == info2.hits + 1, (
            "通过 haversine_distance 相同坐标应命中 cache"
        )

    def test_distance_matrix_shape(self):
        """距离矩阵形状、对角线与对称性验证"""
        np.random.seed(123)
        n = 20
        lats = np.random.uniform(-90, 90, n)
        lons = np.random.uniform(-180, 180, n)

        mat = DistanceCalculator.batch_distance_matrix(lats, lons)

        # 形状
        assert mat.shape == (n, n), (
            f"期望 shape ({n},{n})，得到 {mat.shape}"
        )

        # 对角线为零
        diag = np.diag(mat)
        assert np.all(diag == 0.0), "对角线应全为零"

        # 对称性
        sym_diff = np.max(np.abs(mat - mat.T))
        assert sym_diff < 1e-12, f"矩阵不对称，最大差异 {sym_diff:.2e}"
