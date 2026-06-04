"""测试 PCI 向量化距离计算的正确性"""
import numpy as np
import pytest
from app.algorithms.pci_planning_service_v2 import (
    PCIPlanningService, PlanningConfig, SiteSectorInfo
)
from app.models.schemas import NetworkType


class TestPCIReuseDistanceVectorization:
    @pytest.fixture
    def service(self):
        config = PlanningConfig(network_type=NetworkType.LTE)
        svc = PCIPlanningService(config)
        # 注入模拟数据
        svc.assigned_pcis = [
            (100, 39.9, 116.4, 100.0),   # (pci, lat, lon, earfcn)
            (100, 31.2, 121.5, 100.0),
            (101, 22.5, 114.1, 100.0),
        ]
        return svc

    def test_reuse_distance_with_assigned(self, service):
        """检查同 PCI 已分配小区的最小距离正确"""
        is_valid, min_dist = service.validate_pci_reuse_distance(
            candidate_pci=100, target_lat=30.0, target_lon=120.0,
            target_earfcn=100.0, exclude_sector_id="s1", all_sectors=[])
        assert min_dist > 0
        # 应与最近同 PCI 小区的距离一致
        from app.algorithms.distance_calculator import DistanceCalculator
        d1 = DistanceCalculator.calculate_distance(120.0, 30.0, 116.4, 39.9)
        d2 = DistanceCalculator.calculate_distance(120.0, 30.0, 121.5, 31.2)
        assert abs(min_dist - min(d1, d2)) < 1e-5

    def test_no_same_pci_assigned(self, service):
        """如果没有同 PCI 的小区，应跳过向量化检查"""
        is_valid, min_dist = service.validate_pci_reuse_distance(
            candidate_pci=999, target_lat=30.0, target_lon=120.0,
            target_earfcn=100.0, exclude_sector_id="s1", all_sectors=[])
        assert min_dist == float("inf")

    def test_different_frequency_skip(self, service):
        """非同频小区不应计入距离检查"""
        # assigned_pcis 的 earfcn=100，target_earfcn=200
        is_valid, min_dist = service.validate_pci_reuse_distance(
            candidate_pci=100, target_lat=30.0, target_lon=120.0,
            target_earfcn=200.0, exclude_sector_id="s1", all_sectors=[])
        assert min_dist == float("inf")

    def test_large_assigned_list_speed(self):
        """2000 个已分配小区不报错"""
        config = PlanningConfig(network_type=NetworkType.LTE)
        svc = PCIPlanningService(config)
        np.random.seed(42)
        for _ in range(2000):
            svc.assigned_pcis.append((
                np.random.randint(0, 504),
                np.random.uniform(20, 50),
                np.random.uniform(100, 130),
                100.0
            ))
        is_valid, min_dist = svc.validate_pci_reuse_distance(
            candidate_pci=100, target_lat=30.0, target_lon=120.0,
            target_earfcn=100.0, exclude_sector_id="s1", all_sectors=[])
        assert min_dist > 0
