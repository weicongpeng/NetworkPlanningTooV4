"""
TAC规划服务STRtree空间索引优化测试

遵循TDD方法论:
- RED: 先编写测试验证当前行为
- GREEN: 实现STRtree优化
- REFACTOR: 清理和优化代码
"""

import pytest
import time
from pathlib import Path
from shapely.geometry import Point, Polygon
from app.services.tac_planning_service import TACPlanningService, STRTREE_AVAILABLE


class TestTACPlanningServiceSTRtree:
    """TAC规划服务空间索引测试"""

    @pytest.fixture
    def sample_tac_zones(self):
        """创建示例TAC区域数据"""
        # 创建3个TAC区域（多边形）
        poly1 = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
        poly2 = Polygon([(10, 0), (20, 0), (20, 10), (10, 10)])
        poly3 = Polygon([(0, 10), (20, 10), (20, 20), (0, 20)])

        return {
            "1": (poly1, "左侧区域"),
            "2": (poly2, "右侧区域"),
            "3": (poly3, "上方区域"),
        }

    @pytest.fixture
    def sample_cells(self):
        """创建示例小区数据"""
        return [
            {"sectorId": "cell_1", "longitude": 5, "latitude": 5},
            {"sectorId": "cell_2", "longitude": 15, "latitude": 5},
            {"sectorId": "cell_3", "longitude": 10, "latitude": 15},
            {"sectorId": "cell_4", "longitude": 25, "latitude": 5},
        ]

    def test_match_cell_to_tac_basic(self, sample_tac_zones, sample_cells):
        """测试基本的点面匹配功能（线性搜索）"""
        service = TACPlanningService(data_dir=Path("."))

        result = service.match_cell_to_tac(sample_cells[0], sample_tac_zones)
        assert result == "1"

        result = service.match_cell_to_tac(sample_cells[1], sample_tac_zones)
        assert result == "2"

        result = service.match_cell_to_tac(sample_cells[2], sample_tac_zones)
        assert result == "3"

        result = service.match_cell_to_tac(sample_cells[3], sample_tac_zones)
        assert result is None

    @pytest.mark.skipif(not STRTREE_AVAILABLE, reason="STRtree not available")
    def test_match_cell_to_tac_with_strtree(self, sample_tac_zones, sample_cells):
        """测试使用 STRtree 的点面匹配功能"""
        service = TACPlanningService(data_dir=Path("."))

        # 构建 STRtree 索引
        service._build_strtree_index("LTE", sample_tac_zones)

        # 使用 STRtree 匹配
        result = service.match_cell_to_tac(sample_cells[0], sample_tac_zones, network_type="LTE")
        assert result == "1"

        result = service.match_cell_to_tac(sample_cells[1], sample_tac_zones, network_type="LTE")
        assert result == "2"

        result = service.match_cell_to_tac(sample_cells[2], sample_tac_zones, network_type="LTE")
        assert result == "3"

        result = service.match_cell_to_tac(sample_cells[3], sample_tac_zones, network_type="LTE")
        assert result is None

    def test_performance_comparison(self, sample_tac_zones):
        """性能对比测试：线性搜索 vs STRtree"""
        service = TACPlanningService(data_dir=Path("."))

        num_cells = 100
        test_cells = [
            {"sectorId": f"cell_{i}", "longitude": i * 0.2, "latitude": 5}
            for i in range(num_cells)
        ]

        # 测试线性搜索
        start = time.perf_counter()
        for cell in test_cells:
            service.match_cell_to_tac(cell, sample_tac_zones)
        linear_time = time.perf_counter() - start

        print(f"Linear search {num_cells} cells: {linear_time:.4f}s")

        # 测试 STRtree（如果可用）
        if STRTREE_AVAILABLE:
            service._build_strtree_index("LTE", sample_tac_zones)

            start = time.perf_counter()
            for cell in test_cells:
                service.match_cell_to_tac(cell, sample_tac_zones, network_type="LTE")
            strtree_time = time.perf_counter() - start

            print(f"STRtree search {num_cells} cells: {strtree_time:.4f}s")
            print(f"Speedup: {linear_time / strtree_time:.2f}x")

    @pytest.mark.skipif(not STRTREE_AVAILABLE, reason="STRtree not available")
    def test_strtree_query_method(self):
        """测试 STRtree 查询方法"""
        from shapely.strtree import STRtree

        poly1 = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
        poly2 = Polygon([(10, 0), (20, 0), (20, 10), (10, 10)])

        tree = STRtree([poly1, poly2])
        point = Point(5, 5)

        candidates = tree.query(point)
        assert len(candidates) > 0


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
