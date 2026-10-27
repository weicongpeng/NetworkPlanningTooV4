"""TAC 图层/全量工参解析的组隔离回归测试

防止本组无数据时回退到其他组数据（PCI/TAC 规划结果带跨组 TAC 值的根因）。
"""
import pytest

from app.models.schemas import DataItem, DataType, DataStatus


def _item(id: str, city: str | None, operator: str | None,
          file_type: str = "tac_layer", item_type: DataType = DataType.MAP) -> DataItem:
    return DataItem(
        id=id, name=f"{id}.zip", type=item_type, fileType=file_type,
        size=1, uploadDate="2026-09-19", status=DataStatus.READY,
        city=city, operator=operator,
    )


@pytest.fixture()
def tac_service(tmp_path, monkeypatch):
    from app.services.tac_planning_service import TACPlanningService
    from app.services.data_service import data_service

    # 组 A 的数据目录下放一个 4G_TAC.TAB（内容为假文件，发现后读取会失败，
    # 但隔离测试只验证"能否发现文件"，在 geopandas 读取之前就已区分成败）
    dir_a = tmp_path / "itemA"
    dir_a.mkdir()
    (dir_a / "4G_TAC.TAB").write_bytes(b"fake tab")

    svc = TACPlanningService(tmp_path, data_service=data_service)
    return svc, data_service, dir_a


class TestLoadTacLayersGroupIsolation:
    def test_missing_group_raises(self, tac_service):
        svc, data_service, _ = tac_service
        monkeypatch_items = [
            _item("itemA", "河源", "电信"),
        ]
        # 通过替换真实 data_service.list_data 实现
        import app.services.data_service as ds_mod
        orig = data_service.list_data
        data_service.list_data = lambda *a, **k: monkeypatch_items
        try:
            with pytest.raises(ValueError, match="缺少数据组"):
                svc.load_tac_layers("LTE", city=None, operator=None)
        finally:
            data_service.list_data = orig

    def test_other_group_layer_invisible(self, tac_service):
        """本组无 TAC 图层、别组有时：必须报未找到，绝不跨组读取"""
        svc, data_service, _ = tac_service
        orig = data_service.list_data
        data_service.list_data = lambda *a, **k: [_item("itemA", "河源", "电信")]
        try:
            with pytest.raises(ValueError, match="未找到TAC图层"):
                svc.load_tac_layers("LTE", city="深圳", operator="移动")
        finally:
            data_service.list_data = orig

    def test_no_global_data_dir_fallback(self, tac_service, monkeypatch):
        """全局 DATA_DIR 下存在别组目录时，不在本组条目内就不能被 rglob 兜底发现"""
        svc, data_service, dir_a = tac_service
        # 另一组的 TAB 直接放在 DATA_DIR 根（模拟历史全局文件）
        (svc.data_dir / "4G_TAC.TAB").write_bytes(b"fake")
        # 本组没有任何条目
        monkeypatch.setattr(data_service, "list_data", lambda *a, **k: [])
        with pytest.raises(ValueError, match="未找到TAC图层"):
            svc.load_tac_layers("LTE", city="深圳", operator="移动")

    def test_own_group_layer_is_discovered(self, tac_service, monkeypatch):
        """本组条目目录中的 TAB 应被发现（会进入 geopandas 读取阶段）"""
        svc, data_service, _ = tac_service
        monkeypatch.setattr(data_service, "list_data",
                            lambda *a, **k: [_item("itemA", "深圳", "移动")])
        # 假 TAB 文件无法被 geopandas 解析，抛出的应是读取错误而非"未找到"
        with pytest.raises(Exception) as exc:
            svc.load_tac_layers("LTE", city="深圳", operator="移动")
        assert "未找到TAC图层" not in str(exc.value)


class TestFullParamsNoGlobalFallback:
    def test_resolve_full_params_id_requires_group(self):
        from app.services.task_manager import TaskManager
        assert TaskManager._resolve_full_params_id(None, None) is None
        assert TaskManager._resolve_full_params_id("河源", None) is None

    def test_find_full_params_item_requires_group(self):
        from app.services.task_manager import TaskManager
        tm = TaskManager.__new__(TaskManager)
        assert tm._find_full_params_item(None, None) is None
        assert tm._find_full_params_item("河源", None) is None


class TestLoadCellsGroupIsolation:
    def test_load_cells_empty_without_group(self, tac_service):
        svc, data_service, _ = tac_service
        assert svc.load_cells("LTE", city=None, operator=None) == []

    def test_load_cells_other_group_invisible(self, monkeypatch):
        """index 中只有别组 full_params 时，本组加载结果必须为空"""
        from app.services.tac_planning_service import TACPlanningService
        from app.services.data_service import data_service
        from app.core.config import settings

        svc = TACPlanningService(settings.DATA_DIR, data_service=data_service)
        fake_index = {
            "other": {"type": "excel", "fileType": "full_params",
                      "name": "ProjectParameter.xlsx", "city": "河源", "operator": "电信",
                      "uploadDate": "2026-09-19"},
        }
        monkeypatch.setattr(data_service, "index", fake_index)
        assert svc.load_cells("LTE", city="深圳", operator="移动") == []
