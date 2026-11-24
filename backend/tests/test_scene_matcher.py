"""场景图层匹配与合并列顺序测试。"""

from types import SimpleNamespace

import openpyxl
import pandas as pd
from shapely.geometry import Polygon

from app.services.data_service import DataService, data_service
from app.services.scene_matcher import DEFAULT_SCENE_NAME, SceneMatcher


def test_zte_merge_columns_scene_name_after_coverage_type():
    columns = DataService.ZTE_MERGE_COLUMNS
    assert columns[columns.index("小区覆盖类型") + 1] == "场景名称"


def test_scene_matcher_point_in_polygon_and_default():
    matcher = SceneMatcher(data_service=SimpleNamespace(index={}))
    matcher._entries = [
        (Polygon([(113, 23), (114, 23), (114, 24), (113, 24)]), "城区"),
        (Polygon([(114, 23), (115, 23), (115, 24), (114, 24)]), "乡镇"),
    ]
    matcher.available = True

    assert matcher.match(113.5, 23.5) == "城区"
    assert matcher.match(114.5, 23.5) == "乡镇"
    # 边界上按命中处理（与 TAC 规划一致）
    assert matcher.match(114, 23.5) == "城区"
    # 有效坐标未命中 → 农村
    assert matcher.match(116, 26) == DEFAULT_SCENE_NAME
    # 空 / 0 / 非数字 / 超范围 / NaN → None（工参留空）
    for bad in (None, "", "abc", 0, 0.0, float("nan")):
        assert matcher.match(bad, 23.5) is None, bad
        assert matcher.match(113.5, bad) is None, bad
    assert matcher.match(200, 23.5) is None      # 经度超范围
    assert matcher.match(113.5, -91) is None    # 纬度超范围


def test_scene_matcher_without_layer_warns_and_defaults():
    matcher = SceneMatcher(data_service=SimpleNamespace(index={}))
    assert matcher.load("测试市", "移动") is False
    assert "场景图层" in matcher.warning
    assert matcher.match(113.5, 23.5) == DEFAULT_SCENE_NAME
    assert matcher.match(0, 0) is None


def test_load_specific_layer_checks_group():
    """用户指定的场景图层必须属于当前数据组（接口层已做 404，服务层再兜底）。"""
    ds = SimpleNamespace(index={
        "mine": {"name": "场景图层", "city": "河源", "operator": "电信"},
        "other": {"name": "场景图层", "city": "其他市", "operator": "移动"},
    })
    matcher = SceneMatcher(ds)
    assert matcher.load("河源", "电信", data_id="other") is False
    assert "不属于当前数据组" in matcher.warning
    assert matcher.load("河源", "电信", data_id="missing") is False


def test_scene_name_from_layer_field_or_name():
    columns = ["场景名称", "OBJECTID"]
    row = {"场景名称": "高铁", "OBJECTID": 1}
    assert SceneMatcher._scene_name_from_row(row, columns, "场景图层") == "高铁"
    assert SceneMatcher._scene_name_from_row({"OBJECTID": 1}, columns, "市区") == "市区"


def test_scene_name_uses_name_attribute_not_uuid_or_generic_layer_name():
    """真实场景图层要素属性是 NAME=一般城区核心区域，不能回退成 UUID 或文件名。"""
    columns = ["city", "NAME", "area"]
    row = {"city": "河源", "NAME": "一般城区核心区域", "area": 12.3}
    assert SceneMatcher._scene_name_from_row(row, columns, "场景图层") == "一般城区核心区域"

    uuid = "d13faff7-2d0d-487f-a9d3-e45422482408"
    assert SceneMatcher._scene_name_from_row({"NAME": uuid}, columns, "场景图层") == DEFAULT_SCENE_NAME


def test_vector_files_skip_uuid_cache(tmp_path):
    """缓存 GeoJSON 以图层 UUID 命名，不能当作场景图层读取。"""
    import json

    uuid = "d13faff7-2d0d-487f-a9d3-e45422482408"
    (tmp_path / "场景图层.tab").write_text("source", encoding="utf-8")
    (tmp_path / "layers.json").write_text(json.dumps([
        {"id": uuid, "name": "场景图层", "metadata": {"source_file": str(tmp_path / "场景图层.tab")}}
    ]), encoding="utf-8")
    cache_dir = tmp_path / ".cache" / "v4"
    cache_dir.mkdir(parents=True)
    (cache_dir / f"{uuid}.geojson").write_text("{}", encoding="utf-8")

    files = SceneMatcher._vector_files_for_dir(tmp_path)
    assert [p.name for p in files] == ["场景图层.tab"]


def test_zte_enrich_output_includes_scene_column():
    df = pd.DataFrame({"eNBId": ["1", "2"], "cellLocalId": ["2", "3"]})
    lookup = pd.DataFrame(
        {"经度": [113.5, 0], "纬度": [23.5, 0]}, index=pd.Index(["1_2", "2_3"])
    )
    matcher = SceneMatcher(data_service=SimpleNamespace(index={}))
    matcher._entries = [(Polygon([(113, 23), (114, 23), (114, 24), (113, 24)]), "城区")]
    matcher.available = True

    enriched, matched = DataService._zte_enrich(df, lookup, "LTE", matcher)

    assert matched == 2
    assert list(enriched.columns[:len(DataService.ZTE_MERGE_COLUMNS)]) == list(DataService.ZTE_MERGE_COLUMNS)
    assert enriched["场景名称"].iloc[0] == "城区"
    assert pd.isna(enriched["场景名称"].iloc[1])  # 0,0 无效坐标留空（None/NaN 写出均为空单元格）


def test_update_sheet_inserts_and_fills_scene_column(monkeypatch):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["CGI", "是否共享", "eNodeB标识", "小区标识", "小区经度", "小区纬度"])
    ws.append([])
    ws.append([])
    ws.append(["1-1", "否", "1", "1", 113.5, 23.5])
    ws.append(["1-2", "否", "1", "2", 115, 25])
    ws.append(["1-3", "否", "1", "3", 0, 23.5])

    monkeypatch.setattr(data_service, "_load_current_params", lambda *args, **kwargs: {})
    matcher = SceneMatcher(data_service=SimpleNamespace(index={}))
    matcher._entries = [(Polygon([(113, 23), (114, 23), (114, 24), (113, 24)]), "城区")]
    matcher.available = True

    data_service._update_sheet(ws, SimpleNamespace(), "LTE", matcher)

    header = [c.value for c in ws[1]]
    assert header[2] == "场景名称"  # 「是否共享」右侧
    assert ws.cell(4, 3).value == "城区"
    assert ws.cell(5, 3).value == DEFAULT_SCENE_NAME
    assert ws.cell(6, 3).value is None  # 经度为 0 → 留空
