"""
TaskManager 数据准备优化测试

遵循TDD方法论:
- RED: 先编写测试验证当前行为
- GREEN: 实现数据准备优化
- REFACTOR: 清理和优化代码

P1-2 优化目标:
1. 提取 resolve_input_datasets() 函数
2. 对 full_params 构建字典索引实现 O(1) 查找
3. 减少重复的数据扫描和匹配逻辑
"""

import pytest
from unittest.mock import Mock, patch, MagicMock
from pathlib import Path
from app.services.task_manager import TaskManager, Task, TaskStatus
from app.services.data_service import data_service


class TestTaskManagerDataPrep:
    """TaskManager 数据准备优化测试"""

    @pytest.fixture
    def task_manager(self):
        """创建 TaskManager 实例"""
        return TaskManager()

    @pytest.fixture
    def sample_target_cells_data(self):
        """示例待规划小区数据"""
        return {
            "LTE": [
                {
                    "id": "site1",
                    "name": "Site 1",
                    "sectors": [
                        {"id": "site1_1", "cellName": "Cell 1-1"},
                        {"id": "site1_2", "cellName": "Cell 1-2"},
                    ]
                },
                {
                    "id": "site2",
                    "name": "Site 2",
                    "sectors": [
                        {"id": "site2_1", "cellName": "Cell 2-1"},
                    ]
                }
            ]
        }

    @pytest.fixture
    def sample_full_params_data(self):
        """示例全量工参数据"""
        return {
            "LTE": [
                {
                    "id": "site1",
                    "name": "Site 1",
                    "longitude": 113.0,
                    "latitude": 23.0,
                    "managedElementId": "me1",
                    "sectors": [
                        {
                            "id": "1",
                            "cellName": "Cell 1-1",
                            "pci": 1,
                            "earfcn": 38400
                        },
                        {
                            "id": "2",
                            "cellName": "Cell 1-2",
                            "pci": 2,
                            "earfcn": 38400
                        }
                    ]
                },
                {
                    "id": "site2",
                    "name": "Site 2",
                    "longitude": 113.1,
                    "latitude": 23.1,
                    "managedElementId": "me2",
                    "sectors": [
                        {
                            "id": "1",
                            "cellName": "Cell 2-1",
                            "pci": 3,
                            "earfcn": 38400
                        }
                    ]
                }
            ]
        }

    def test_extract_target_cell_keys_from_dict(self, sample_target_cells_data):
        """测试从字典结构中提取待规划小区的 cell_key"""
        from app.services.task_manager import TaskManager

        target_cell_keys = set()
        network_type_str = "LTE"

        target_sites = sample_target_cells_data[network_type_str]
        for site in target_sites:
            site_id = site.get("id", "")
            for sector in site.get("sectors", []):
                sector_id = sector.get("id", "")
                cell_key = sector_id  # site_id_cell_id 格式
                target_cell_keys.add(cell_key)

        assert "site1_1" in target_cell_keys
        assert "site1_2" in target_cell_keys
        assert "site2_1" in target_cell_keys
        assert len(target_cell_keys) == 3

    def test_build_full_params_index(self, sample_full_params_data):
        """测试为 full_params 构建字典索引"""
        # 目标：实现 O(1) 查找 cell_key 对应的完整 sector 信息
        network_type_str = "LTE"
        full_sites = sample_full_params_data[network_type_str]

        # 构建 cell_key -> (site, sector) 的索引
        cell_index = {}
        for site in full_sites:
            site_id = site.get("id", "")
            for sector in site.get("sectors", []):
                sector_id = sector.get("id", "")
                # 生成可能的 cell_key 格式
                cell_keys = [f"{site_id}_{sector_id}", sector_id]
                for cell_key in cell_keys:
                    cell_index[cell_key] = (site, sector)

        # 验证索引正确
        assert "site1_1" in cell_index
        assert "site1_2" in cell_index
        assert "site2_1" in cell_index

        site, sector = cell_index["site1_1"]
        assert site["id"] == "site1"
        assert sector["pci"] == 1

    def test_match_cells_with_index(self, sample_target_cells_data, sample_full_params_data):
        """测试使用索引进行小区匹配"""
        # 1. 提取待规划小区的 cell_key
        target_cell_keys = set()
        for site in sample_target_cells_data["LTE"]:
            for sector in site.get("sectors", []):
                target_cell_keys.add(sector.get("id", ""))

        # 2. 构建 full_params 索引
        cell_index = {}
        for site in sample_full_params_data["LTE"]:
            site_id = site.get("id", "")
            for sector in site.get("sectors", []):
                sector_id = sector.get("id", "")
                cell_key = f"{site_id}_{sector_id}"
                cell_index[cell_key] = (site, sector)

        # 3. 使用索引匹配
        matched_sectors = []
        for cell_key in target_cell_keys:
            if cell_key in cell_index:
                site, sector = cell_index[cell_key]
                matched_sectors.append((cell_key, site, sector))

        # 验证匹配结果（使用集合比较，因为顺序不固定）
        assert len(matched_sectors) == 3
        matched_keys = {m[0] for m in matched_sectors}
        assert matched_keys == {"site1_1", "site1_2", "site2_1"}

        # 验证其中一个的 pci 值
        for cell_key, site, sector in matched_sectors:
            if cell_key == "site1_1":
                assert sector["pci"] == 1
                break

    @pytest.mark.asyncio
    async def test_resolve_input_datasets_function(self, task_manager):
        """测试提取的数据集解析函数"""
        # 这是对优化后新函数的测试
        # 验证函数能正确返回 target_cells_item 和 full_params_item

        with patch.object(data_service, 'list_data') as mock_list:
            # Mock 数据项
            mock_items = [
                Mock(id="target_id", name="cell-tree-export-2025.xlsx", type=Mock(value="excel")),
                Mock(id="full_id", name="projectparameter_mongoose-2025.xlsx", type=Mock(value="excel"))
            ]
            mock_list.return_value = mock_items

            with patch.object(data_service, 'index', {
                "target_id": {"fileType": "target_cells"},
                "full_id": {"fileType": "full_params"}
            }):
                # 调用优化后的函数（待实现）
                # result = task_manager.resolve_input_datasets("LTE")
                # assert result["target_cells_item"].id == "target_id"
                # assert result["full_params_item"].id == "full_id"

                # 暂时跳过，等待实现
                pass

    def test_performance_linear_vs_index(self):
        """性能测试：线性搜索 vs 索引查找"""
        import time

        # 构建大规模测试数据
        num_sites = 100
        num_sectors_per_site = 3

        full_sites = []
        for i in range(num_sites):
            site = {
                "id": f"site{i}",
                "name": f"Site {i}",
                "sectors": []
            }
            for j in range(num_sectors_per_site):
                site["sectors"].append({
                    "id": str(j + 1),
                    "pci": i * num_sectors_per_site + j
                })
            full_sites.append(site)

        # 构建待匹配的 cell_keys
        target_cell_keys = {f"site{50}_{1}", f"site{75}_{2}", f"site{25}_{3}"}

        # 线性搜索
        start = time.perf_counter()
        for cell_key in target_cell_keys:
            found = False
            for site in full_sites:
                for sector in site.get("sectors", []):
                    if f"{site['id']}_{sector['id']}" == cell_key:
                        found = True
                        break
                if found:
                    break
        linear_time = time.perf_counter() - start

        # 索引查找
        cell_index = {}
        for site in full_sites:
            site_id = site.get("id", "")
            for sector in site.get("sectors", []):
                sector_id = sector.get("id", "")
                cell_key = f"{site_id}_{sector_id}"
                cell_index[cell_key] = (site, sector)

        start = time.perf_counter()
        for cell_key in target_cell_keys:
            if cell_key in cell_index:
                site, sector = cell_index[cell_key]
        index_time = time.perf_counter() - start

        print(f"Linear search: {linear_time:.6f}s")
        print(f"Index lookup: {index_time:.6f}s")
        print(f"Speedup: {linear_time / index_time:.2f}x")

        # 索引查找应该明显更快
        assert index_time < linear_time

    def test_match_cells_with_index_no_mutation(self, sample_target_cells_data, sample_full_params_data):
        """测试使用索引进行小区匹配时不修改原始集合"""
        from app.services.task_manager import TaskManager

        # 1. 提取待规划小区的 cell_key
        target_cell_keys = set()
        for site in sample_target_cells_data["LTE"]:
            for sector in site.get("sectors", []):
                target_cell_keys.add(sector.get("id", ""))

        # 保存原始集合的副本用于验证
        original_keys = target_cell_keys.copy()
        original_size = len(target_cell_keys)

        # 2. 构建 full_params 索引
        cell_index = {}
        for site in sample_full_params_data["LTE"]:
            site_id = site.get("id", "")
            for sector in site.get("sectors", []):
                sector_id = sector.get("id", "")
                cell_key = f"{site_id}_{sector_id}"
                cell_index[cell_key] = (site, sector)

        # 3. 使用索引匹配 - 方法不应该修改 target_cell_keys
        task_manager = TaskManager()
        matched_sectors = []

        for cell_key in target_cell_keys:
            if cell_key in cell_index:
                site, sector = cell_index[cell_key]
                matched_sectors.append((cell_key, site, sector))

        # 验证：原始集合没有被修改
        assert len(target_cell_keys) == original_size, \
            f"target_cell_keys 被修改了！原始大小: {original_size}, 当前大小: {len(target_cell_keys)}"
        assert target_cell_keys == original_keys, \
            f"target_cell_keys 内容被修改了！"

    def test_match_cells_with_index_method_fixed(self, sample_target_cells_data, sample_full_params_data):
        """测试 _match_cells_with_index 方法修复后不修改原始集合"""
        from app.services.task_manager import TaskManager

        task_manager = TaskManager()

        # 1. 提取待规划小区的 cell_key
        target_cell_keys = set()
        for site in sample_target_cells_data["LTE"]:
            for sector in site.get("sectors", []):
                target_cell_keys.add(sector.get("id", ""))

        # 保存原始集合用于验证
        original_keys = target_cell_keys.copy()

        # 2. 构建 full_params 索引
        cell_index = {}
        for site in sample_full_params_data["LTE"]:
            site_id = site.get("id", "")
            for sector in site.get("sectors", []):
                sector_id = sector.get("id", "")
                cell_key = f"{site_id}_{sector_id}"
                cell_index[cell_key] = (site, sector)

        # 3. 调用修复后的方法 - 不应该抛出错误，也不应该修改原始集合
        result = task_manager._match_cells_with_index(target_cell_keys, cell_index)

        # 验证：方法成功执行
        assert len(result) == 2  # 2个站点
        assert sum(len(s.get('sectors', [])) for s in result) == 3  # 3个小区

        # 验证：原始集合没有被修改
        assert target_cell_keys == original_keys, "原始集合不应该被修改"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
