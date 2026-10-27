"""TAC 核查/规划：工参数据不全跳过异常小区的回归测试

覆盖：
- load_cells / load_planning_cells 记录被跳过的小区（缺 ID / 缺经纬度 / 非数字坐标）
- 站点级坐标回退不误判为跳过
- TaskManager._collect_skipped_cells 的选中过滤、"工参中未找到"补录与去重
"""
import pytest


@pytest.fixture()
def tac_service(tmp_path):
    from app.services.tac_planning_service import TACPlanningService
    from app.services.data_service import data_service
    return TACPlanningService(tmp_path, data_service=data_service)


class TestLoadCellsSkipped:
    def test_records_skipped_cells_and_keeps_valid(self, tac_service, monkeypatch):
        from app.services.data_service import data_service

        svc = tac_service
        fake_index = {
            "fp1": {"type": "excel", "fileType": "full_params",
                    "name": "ProjectParameter.xlsx", "city": "河源", "operator": "电信",
                    "uploadDate": "2026-09-19"},
        }
        fake_data = {
            "LTE": [
                {"id": "S1", "name": "基站1", "sectors": [
                    {"id": "1", "name": "正常小区", "longitude": 114.9, "latitude": 24.2},
                ]},
                {"id": "S2", "name": "基站2", "sectors": [
                    {"id": "2", "name": "零坐标", "longitude": 0, "latitude": 0},
                    {"id": "3", "name": "非数字坐标", "longitude": "abc", "latitude": 24.2},
                    {"id": "4", "name": "空坐标", "longitude": None, "latitude": None},
                ]},
                {"id": "", "name": "无站ID", "sectors": [
                    {"id": "5", "name": "缺站ID小区", "longitude": 114.9, "latitude": 24.2},
                ]},
            ],
        }
        monkeypatch.setattr(data_service, "index", fake_index)
        monkeypatch.setattr(data_service, "get_data_from_db", lambda data_id: fake_data)

        cells = svc.load_cells("LTE", city="河源", operator="电信")

        # 只有坐标/ID齐全的小区进入核查（非数字坐标不再让任务崩）
        assert [c["sectorId"] for c in cells] == ["1"]
        reasons = {(s["sectorId"], s["reason"]) for s in svc.last_load_skipped}
        assert ("2", "missing_coordinates") in reasons
        assert ("3", "missing_coordinates") in reasons
        assert ("4", "missing_coordinates") in reasons
        assert ("5", "missing_ids") in reasons
        assert len(svc.last_load_skipped) == 4

    def test_skipped_reset_on_each_load(self, tac_service, monkeypatch):
        """第二次加载前必须重置上次的跳过记录"""
        from app.services.data_service import data_service

        svc = tac_service
        monkeypatch.setattr(data_service, "index", {
            "fp1": {"type": "excel", "fileType": "full_params",
                    "name": "ProjectParameter.xlsx", "city": "河源", "operator": "电信",
                    "uploadDate": "2026-09-19"},
        })
        monkeypatch.setattr(data_service, "get_data_from_db", lambda data_id: {
            "LTE": [{"id": "S1", "name": "基站1", "sectors": [
                {"id": "1", "name": "正常", "longitude": 114.9, "latitude": 24.2},
                {"id": "2", "name": "无坐标"},
            ]}],
        })
        assert len(svc.load_cells("LTE", city="河源", operator="电信")) == 1
        assert len(svc.last_load_skipped) == 1

        monkeypatch.setattr(data_service, "get_data_from_db", lambda data_id: {
            "LTE": [{"id": "S1", "name": "基站1", "sectors": [
                {"id": "1", "name": "正常", "longitude": 114.9, "latitude": 24.2},
            ]}],
        })
        cells = svc.load_cells("LTE", city="河源", operator="电信")
        assert len(cells) == 1
        assert svc.last_load_skipped == []


class TestLoadPlanningCellsSkipped:
    def test_site_coord_fallback_not_skipped(self, tac_service):
        svc = tac_service
        data = [
            {"id": "S1", "name": "基站1", "longitude": 114.9, "latitude": 24.2, "sectors": [
                {"id": "1", "name": "用站坐标"},
            ]},
            {"id": "S2", "name": "基站2", "sectors": [
                {"id": "2", "name": "站与小区都缺坐标"},
            ]},
        ]
        cells = svc.load_planning_cells(data)

        assert [c["sectorId"] for c in cells] == ["1"]
        assert cells[0]["longitude"] == 114.9
        assert len(svc.last_load_skipped) == 1
        skipped = svc.last_load_skipped[0]
        assert skipped["sectorId"] == "2"
        assert skipped["reason"] == "missing_coordinates"


class TestCollectSkippedCells:
    def test_keeps_selected_records_and_adds_not_in_params(self):
        from app.services.task_manager import TaskManager

        loaded = [
            {"siteId": "S1", "siteName": "基站1", "sectorId": "1",
             "sectorName": "缺坐标小区", "reason": "missing_coordinates"},
            {"siteId": "S9", "siteName": "基站9", "sectorId": "9",
             "sectorName": "未选中小区", "reason": "missing_coordinates"},
        ]
        selected = {"S1_1", "S9_9", "S2_2"}
        used_keys = {"S3_3", "3"}

        out = TaskManager._collect_skipped_cells(loaded, used_keys, selected)

        assert {(c["sectorId"], c["reason"]) for c in out} == {
            ("1", "missing_coordinates"),
            ("9", "missing_coordinates"),
            ("S2_2", "not_in_params"),
        }

    def test_dedup_and_used_keys_suppression(self):
        from app.services.task_manager import TaskManager

        # 同一条跳过记录出现两次 → 只保留一条
        loaded = [
            {"siteId": "S1", "sectorId": "1", "reason": "missing_ids"},
            {"siteId": "S1", "sectorId": "1", "reason": "missing_ids"},
        ]
        # 选中 id 命中 used_keys（实际已核查）→ 不再补 not_in_params
        out = TaskManager._collect_skipped_cells(loaded, {"S1_1", "1", "S5_5"}, {"S1_1", "S5_5"})
        assert len(out) == 1
        assert out[0]["sectorId"] == "1"

    def test_reason_summary(self):
        from app.services.task_manager import TaskManager

        summary = TaskManager._format_skipped_reason_summary([
            {"reason": "missing_coordinates"},
            {"reason": "missing_coordinates"},
            {"reason": "not_in_params"},
        ])
        assert "缺经纬度 2 个" in summary
        assert "工参中未找到 1 个" in summary
