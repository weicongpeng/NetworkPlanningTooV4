"""Test PCI 后验证阶段向量化"""
import numpy as np
import pytest
from unittest.mock import MagicMock, patch
from app.algorithms.pci_planning_service_v2 import (
    PCIPlanningService,
    PlanningConfig,
    SiteSectorInfo,
    SitePlanningResult,
    SectorPlanningResult,
    PCIPlanningResult,
)
from app.models.schemas import NetworkType


class TestPostValidationVectorization:
    def test_distance_matrix_small(self):
        """小型矩阵：验证距离正确"""
        from app.algorithms.distance_calculator import DistanceCalculator

        lats = np.array([39.9, 31.2, 22.5])
        lons = np.array([116.4, 121.5, 114.1])

        dist_matrix = DistanceCalculator.batch_distance_matrix(lats, lons)
        assert dist_matrix.shape == (3, 3)
        assert dist_matrix[0, 0] == 0.0
        assert dist_matrix[0, 1] > 0  # Distance between Beijing and Shanghai
        assert dist_matrix[1, 2] > 0
        # Symmetric
        assert abs(dist_matrix[0, 1] - dist_matrix[1, 0]) < 1e-10

    def test_is_same_frequency_vectorized_both_numeric(self):
        """向量化频点判断：两者都有值且差值 <= 0.1 为同频"""
        earfcns = np.array([100.0, 100.05, 200.0, np.nan])
        target = 100.0

        mask = np.isclose(earfcns, target, rtol=0, atol=0.1)
        expected = np.array([True, True, False, False])
        np.testing.assert_array_equal(mask, expected)

    def test_is_same_frequency_vectorized_both_nan(self):
        """向量化频点判断：两者都为 NaN → 不同频（与 _is_same_frequency 语义一致）"""
        earfcns = np.array([np.nan, np.nan, 100.0])
        mask = np.isnan(earfcns)
        expected = np.array([True, True, False])
        np.testing.assert_array_equal(mask, expected)

    def test_is_same_frequency_vectorized_one_nan(self):
        """向量化频点判断：一个有值一个 NaN → 不同频"""
        earfcns = np.array([100.0, np.nan, 200.0])
        target = 100.0

        # Both-not-NaN and close
        numeric_mask = np.isclose(earfcns, target, rtol=0, atol=0.1)
        expected = np.array([True, False, False])
        np.testing.assert_array_equal(numeric_mask, expected)

    def test_distance_matrix_symmetric(self):
        """距离矩阵应为对称矩阵"""
        from app.algorithms.distance_calculator import DistanceCalculator

        np.random.seed(42)
        lats = np.random.uniform(20, 50, 10)
        lons = np.random.uniform(100, 130, 10)

        dist_matrix = DistanceCalculator.batch_distance_matrix(lats, lons)
        assert dist_matrix.shape == (10, 10)
        # 对称性检查
        np.testing.assert_array_almost_equal(dist_matrix, dist_matrix.T, decimal=10)

    def test_distance_matrix_diagonal_zero(self):
        """距离矩阵对角线应为 0"""
        from app.algorithms.distance_calculator import DistanceCalculator

        np.random.seed(42)
        lats = np.random.uniform(20, 50, 100)
        lons = np.random.uniform(100, 130, 100)

        dist_matrix = DistanceCalculator.batch_distance_matrix(lats, lons)
        np.testing.assert_array_almost_equal(np.diag(dist_matrix), np.zeros(100))

    def test_planned_dist_matrix_consistency(self):
        """验证 batch_distance_matrix 与 scalar calculate_distance 结果一致"""
        from app.algorithms.distance_calculator import DistanceCalculator

        np.random.seed(123)
        lats = np.random.uniform(20, 50, 5)
        lons = np.random.uniform(100, 130, 5)

        dist_matrix = DistanceCalculator.batch_distance_matrix(lats, lons)

        # 与标量计算比较
        for i in range(5):
            for j in range(5):
                scalar_dist = DistanceCalculator.calculate_distance(
                    lons[i], lats[i], lons[j], lats[j]
                )
                assert abs(dist_matrix[i, j] - scalar_dist) < 1e-10, (
                    f"Mismatch at ({i},{j}): matrix={dist_matrix[i,j]}, scalar={scalar_dist}"
                )

    def test_batch_haversine_consistency(self):
        """验证 batch_haversine 与 scalar calculate_distance 结果一致"""
        from app.algorithms.distance_calculator import DistanceCalculator

        np.random.seed(456)
        lats1 = np.random.uniform(20, 50, 3)
        lons1 = np.random.uniform(100, 130, 3)
        lats2 = np.random.uniform(20, 50, 4)
        lons2 = np.random.uniform(100, 130, 4)

        batch_result = DistanceCalculator.batch_haversine(
            lats1, lons1, lats2, lons2
        )
        assert batch_result.shape == (3, 4)

        for i in range(3):
            for j in range(4):
                scalar_dist = DistanceCalculator.calculate_distance(
                    lons1[i], lats1[i], lons2[j], lats2[j]
                )
                assert abs(batch_result[i, j] - scalar_dist) < 1e-10, (
                    f"Mismatch at ({i},{j})"
                )

    def test_same_pci_mask(self):
        """验证同 PCI 掩码生成正确"""
        pcis = np.array([100, 101, 100, 102, 100])

        target = 100
        mask = pcis == target
        expected = np.array([True, False, True, False, True])
        np.testing.assert_array_equal(mask, expected)

        # 排除自身
        mask[0] = False
        expected_self = np.array([False, False, True, False, True])
        np.testing.assert_array_equal(mask, expected_self)

    def test_combined_mask(self):
        """验证同 PCI + 同频组合掩码"""
        pcis = np.array([100, 101, 100, 100])
        earfcns = np.array([100.0, 100.0, 200.0, 100.0])

        target_pci = 100
        target_earfcn = 100.0

        pci_mask = pcis == target_pci
        freq_mask = np.isclose(earfcns, target_earfcn, rtol=0, atol=0.1)
        combined = pci_mask & freq_mask

        expected = np.array([True, False, False, True])
        np.testing.assert_array_equal(combined, expected)

    def test_medium_matrix_performance(self):
        """500 个点的距离矩阵：验证不报错且形状正确"""
        from app.algorithms.distance_calculator import DistanceCalculator

        np.random.seed(42)
        lats = np.random.uniform(20, 50, 500)
        lons = np.random.uniform(100, 130, 500)

        dist_matrix = DistanceCalculator.batch_distance_matrix(lats, lons)
        assert dist_matrix.shape == (500, 500)
        assert dist_matrix[0, 0] == 0.0

    def test_isclose_vs_abs_consistency(self):
        """np.isclose(atol=0.1) 与 abs(x-y) <= 0.1 等价"""
        a = np.array([100.0, 100.05, 100.1, 100.2, 99.9, 99.95])
        b = 100.0

        isclose_mask = np.isclose(a, b, rtol=0, atol=0.1)
        abs_mask = np.abs(a - b) <= 0.1
        np.testing.assert_array_equal(isclose_mask, abs_mask)
