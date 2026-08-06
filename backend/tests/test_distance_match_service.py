# backend/tests/test_distance_match_service.py
import math
import os
import pandas as pd
import tempfile
import numpy as np
import pytest
from openpyxl import load_workbook

from app.services.distance_match_service import (
    haversine_km,
    match_sites,
    validate_sheet,
    validate_all,
    build_output_excel,
    build_output_filename,
    read_match_file,
    _normalize_columns,
    load_full_params_from_data,
)


def _df(data):
    return pd.DataFrame(data, columns=["CELL", "LON", "LAT"])


def test_haversine_known_distance():
    """北京天安门 (116.397, 39.908) → 向北 1 度 (116.397, 40.908) 约 111.2 km"""
    d = haversine_km(116.397, 39.908, 116.397, 40.908)
    assert 110.0 < d < 113.0, f"实际 {d}"


def test_haversine_zero():
    assert haversine_km(116.0, 39.0, 116.0, 39.0) == 0.0


def test_match_basic():
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    full = _df([
        {"CELL": "F1", "LON": 116.001, "LAT": 39.0},   # ~0.1km
        {"CELL": "F2", "LON": 116.1, "LAT": 39.0},      # ~11km
    ])
    results, unmatched = match_sites(match, full, max_distance_km=1.0)
    assert len(results) == 1
    assert results[0][0] == "M1" and results[0][3] == "F1"
    assert results[0][6] < 1.0
    assert unmatched == []


def test_match_multiple_hits():
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    full = _df([
        {"CELL": "F1", "LON": 116.0005, "LAT": 39.0},
        {"CELL": "F2", "LON": 116.001, "LAT": 39.0},
    ])
    results, unmatched = match_sites(match, full, max_distance_km=1.0)
    assert len(results) == 2  # 多命中全部输出


def test_match_unmatched_note():
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    full = _df([{"CELL": "F1", "LON": 116.5, "LAT": 39.5}])
    results, unmatched = match_sites(match, full, max_distance_km=1.0)
    assert results == []
    assert unmatched == ["M1"]


def test_match_boundary():
    """恰好在门限上（≈门限）应命中；门外不应命中"""
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    # 1 度纬度 ≈ 111.19 km，0.01 度 ≈ 1.1119 km
    full = _df([{"CELL": "F1", "LON": 116.0, "LAT": 39.005}])  # ~0.556km
    results, _ = match_sites(match, full, max_distance_km=0.6)
    assert len(results) == 1
    results2, _ = match_sites(match, full, max_distance_km=0.5)
    assert len(results2) == 0


def test_validate_sheet_ok():
    df = _df([{"CELL": "A", "LON": 116.0, "LAT": 39.0}])
    errors = validate_sheet(df, "匹配站点")
    assert errors == []


def test_validate_sheet_invalid_lon():
    df = _df([{"CELL": "A", "LON": 999.0, "LAT": 39.0}])
    errors = validate_sheet(df, "匹配站点")
    assert len(errors) == 1
    assert "经度" in errors[0]["reason"]


def test_validate_sheet_non_numeric():
    df = _df([{"CELL": "A", "LON": "abc", "LAT": 39.0}])
    errors = validate_sheet(df, "匹配站点")
    assert len(errors) == 1
    assert "无效" in errors[0]["reason"]


def test_validate_sheet_empty_cell():
    df = _df([{"CELL": None, "LON": 116.0, "LAT": 39.0}])
    errors = validate_sheet(df, "匹配站点")
    assert len(errors) == 1
    assert "名称" in errors[0]["reason"]


def test_validate_sheet_empty_cell_nan():
    """真实 Excel 空格读入为 float NaN，必须被捕获"""
    df = _df([{"CELL": float("nan"), "LON": 116.0, "LAT": 39.0}])
    errors = validate_sheet(df, "匹配站点")
    assert len(errors) == 1
    assert "名称" in errors[0]["reason"]


def test_build_output_excel_columns_and_unmatched():
    """输出列名 8 列；无命中行备注正确；文件可解析"""
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    full = _df([{"CELL": "F1", "LON": 116.001, "LAT": 39.0}])
    results, unmatched = match_sites(match, full, max_distance_km=1.0)
    out = tempfile.mktemp(suffix=".xlsx")
    build_output_excel(out, match, results, unmatched)
    wb = load_workbook(out)
    ws = wb["匹配结果"]
    headers = [c.value for c in ws[1]]
    assert headers == [
        "匹配站点名称", "匹配站点经度", "匹配站点纬度",
        "全量站点名称", "全量站点经度", "全量站点纬度",
        "距离（km）", "备注",
    ]
    assert ws.max_row == 2  # 1 头 + 1 命中
    os.unlink(out)


def test_build_output_excel_unmatched_row():
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    full = _df([{"CELL": "F1", "LON": 116.5, "LAT": 39.5}])
    results, unmatched = match_sites(match, full, max_distance_km=1.0)
    out = tempfile.mktemp(suffix=".xlsx")
    build_output_excel(out, match, results, unmatched)
    wb = load_workbook(out)
    ws = wb["匹配结果"]
    row2 = [c.value for c in ws[2]]
    assert row2[0] == "M1"
    assert row2[3] is None and row2[6] is None
    assert row2[7] == "无匹站点匹配"
    os.unlink(out)


# ---------------------------------------------------------------------------
# Minor 9 补充的边界 / 错误路径测试
# ---------------------------------------------------------------------------


def _write_match_xlsx(sheets: dict) -> str:
    """把 {sheet名: DataFrame} 写入临时 .xlsx，返回路径"""
    path = tempfile.mktemp(suffix=".xlsx")
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        for name, df in sheets.items():
            df.to_excel(writer, sheet_name=name, index=False)
    return path


def test_validate_sheet_empty_lat():
    df = _df([{"CELL": "A", "LON": 116.0, "LAT": None}])
    errors = validate_sheet(df, "匹配站点")
    assert len(errors) == 1
    assert "纬度" in errors[0]["reason"]


def test_validate_sheet_empty_lat_nan():
    df = _df([{"CELL": "A", "LON": 116.0, "LAT": float("nan")}])
    errors = validate_sheet(df, "匹配站点")
    assert len(errors) == 1
    assert "纬度" in errors[0]["reason"]


def test_validate_all_covers_both_sheets():
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    full = _df([{"CELL": "F1", "LON": 999.0, "LAT": 39.0}])  # 经度越界
    errors = validate_all(match, full)
    assert len(errors) == 1
    assert errors[0]["sheet"] == "全量站点"
    assert "经度" in errors[0]["reason"]


def test_match_sites_raises_on_nan_coordinate():
    match = _df([{"CELL": "M1", "LON": float("nan"), "LAT": 39.0}])
    full = _df([{"CELL": "F1", "LON": 116.0, "LAT": 39.0}])
    with pytest.raises(ValueError, match="经纬度无效"):
        match_sites(match, full, max_distance_km=1.0)


def test_match_sites_raises_on_non_finite_threshold():
    match = _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}])
    full = _df([{"CELL": "F1", "LON": 116.0, "LAT": 39.0}])
    with pytest.raises(ValueError, match="大于 0"):
        match_sites(match, full, max_distance_km=float("nan"))
    with pytest.raises(ValueError, match="大于 0"):
        match_sites(match, full, max_distance_km=0.0)


def test_match_sites_lat90_boundary():
    """lat=±90 不应除零崩溃；门限很小则应无命中（或正常命中）"""
    match = _df([{"CELL": "M1", "LON": 0.0, "LAT": 90.0}])
    full = _df([{"CELL": "F1", "LON": 0.5, "LAT": 89.999}])
    results, unmatched = match_sites(match, full, max_distance_km=0.1)
    # cos(90)=0 被 clamp 到 1e-6 → dlon 极大，但 dlat 门限仅 0.1km 极小，
    # 候选先按纬度跨度（0.1/110.574 deg）预筛 → 89.999 与 90 差 0.001 deg ≈ 0.11km > 0.1km 门限
    assert results == []
    assert unmatched == ["M1"]
    # 大范围门限则应命中且不崩溃
    results2, unmatched2 = match_sites(match, full, max_distance_km=5.0)
    assert len(results2) == 1
    assert unmatched2 == []


def test_read_match_file_missing_sheet():
    path = _write_match_xlsx({"匹配站点": _df([{"CELL": "A", "LON": 116.0, "LAT": 39.0}])})
    with pytest.raises(ValueError, match="全量站点"):
        read_match_file(path)
    os.unlink(path)


def test_read_match_file_missing_column():
    bad = pd.DataFrame([{"FOO": "A", "LON": 116.0, "LAT": 39.0}])  # 缺名称列（FOO 不在别名表）
    path = _write_match_xlsx({
        "匹配站点": _df([{"CELL": "A", "LON": 116.0, "LAT": 39.0}]),
        "全量站点": bad,
    })
    with pytest.raises(ValueError, match="缺少必需列"):
        read_match_file(path)
    os.unlink(path)


def test_read_match_file_ok():
    path = _write_match_xlsx({
        "匹配站点": _df([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}]),
        "全量站点": _df([{"CELL": "F1", "LON": 116.0, "LAT": 39.0}]),
    })
    result = read_match_file(path)
    assert set(result.keys()) == {"匹配站点", "全量站点"}
    assert list(result["匹配站点"].columns) == ["CELL", "LON", "LAT"]
    os.unlink(path)


def test_normalize_columns_alias_handling():
    """小写/带空格/别名列名都能归一化到 CELL/LON/LAT"""
    raw = pd.DataFrame([{" 经度 ": 116.0, " 纬度 ": 39.0, " 站点名称 ": "A"}])
    out = _normalize_columns(raw)
    assert list(out.columns) == ["CELL", "LON", "LAT"]
    assert out.iloc[0].tolist() == ["A", 116.0, 39.0]


def test_normalize_columns_missing_required():
    raw = pd.DataFrame([{"LON": 116.0, "LAT": 39.0}])  # 缺名称列
    with pytest.raises(ValueError, match="缺少必需列"):
        _normalize_columns(raw)


def test_build_output_excel_preserves_row_order():
    """输出应按 match_df 行序交错：M1 命中 → M2 无命中 → M3 命中"""
    match = _df([
        {"CELL": "M1", "LON": 116.0, "LAT": 39.0},
        {"CELL": "M2", "LON": 117.0, "LAT": 40.0},
        {"CELL": "M3", "LON": 118.0, "LAT": 41.0},
    ])
    full = _df([
        {"CELL": "F1", "LON": 116.001, "LAT": 39.0},   # M1 命中
        {"CELL": "F2", "LON": 118.001, "LAT": 41.0},   # M3 命中
    ])
    results, unmatched = match_sites(match, full, max_distance_km=1.0)
    assert unmatched == ["M2"]
    assert len(results) == 2  # M1→F1, M3→F2

    out = tempfile.mktemp(suffix=".xlsx")
    build_output_excel(out, match, results, unmatched)
    wb = load_workbook(out)
    ws = wb["匹配结果"]
    rows = [list(c.value for c in row) for row in ws.iter_rows(min_row=2, values_only=False)]
    # 期望顺序：M1命中, M2无命中, M3命中
    assert rows[0][0] == "M1" and rows[0][3] == "F1"  # M1→F1 命中
    assert rows[1][0] == "M2" and rows[1][7] == "无匹站点匹配"  # M2 无命中
    assert rows[2][0] == "M3" and rows[2][3] == "F2"  # M3→F2 命中
    assert len(rows) == 3
    os.unlink(out)


def test_build_output_excel_multi_hit_one_row():
    """同一匹配站点命中多个全量站点时，多行连续输出"""
    match = _df([
        {"CELL": "M1", "LON": 116.0, "LAT": 39.0},
        {"CELL": "M2", "LON": 117.0, "LAT": 40.0},
    ])
    full = _df([
        {"CELL": "F1", "LON": 116.0005, "LAT": 39.0},
        {"CELL": "F2", "LON": 116.001, "LAT": 39.0},
    ])
    results, unmatched = match_sites(match, full, max_distance_km=1.0)
    # M1 命中 F1+F2, M2 无命中
    assert len(results) == 2
    assert unmatched == ["M2"]

    out = tempfile.mktemp(suffix=".xlsx")
    build_output_excel(out, match, results, unmatched)
    wb = load_workbook(out)
    ws = wb["匹配结果"]
    rows = [list(c.value for c in row) for row in ws.iter_rows(min_row=2, values_only=False)]
    # 顺序：M1→F1, M1→F2, M2无命中
    assert rows[0][0] == "M1" and rows[0][3] == "F1"
    assert rows[1][0] == "M1" and rows[1][3] == "F2"
    assert rows[2][0] == "M2" and rows[2][7] == "无匹站点匹配"
    assert len(rows) == 3
    os.unlink(out)


def test_build_output_filename_format():
    import re
    name = build_output_filename()
    assert re.match(r"^匹配结果\d{8}_\d{12}\.xlsx$", name), f"实际 {name}"


def test_load_full_params_from_data_invalid_id(monkeypatch):
    """data_service.get_data 返回 None → ValueError"""
    from app.services import data_service as ds_mod
    monkeypatch.setattr(ds_mod.data_service, "get_data", lambda data_id: None)
    with pytest.raises(ValueError, match="数据不存在"):
        load_full_params_from_data("nope", "LTE", "CELL", "LON", "LAT")


def test_load_full_params_from_data_non_dict(monkeypatch):
    """get_data 返回非 dict → ValueError"""
    from app.services import data_service as ds_mod
    monkeypatch.setattr(ds_mod.data_service, "get_data", lambda data_id: ["not", "dict"])
    with pytest.raises(ValueError, match="数据不存在"):
        load_full_params_from_data("x", "LTE", "CELL", "LON", "LAT")


def test_load_full_params_from_data_missing_network(monkeypatch):
    from app.services import data_service as ds_mod
    monkeypatch.setattr(ds_mod.data_service, "get_data", lambda data_id: {"NR": []})
    with pytest.raises(ValueError, match="LTE"):
        load_full_params_from_data("x", "LTE", "CELL", "LON", "LAT")


def test_load_full_params_from_data_missing_column(monkeypatch):
    from app.services import data_service as ds_mod
    rows = [{"CELL": "A", "LON": 116.0, "LAT": 39.0}]
    monkeypatch.setattr(ds_mod.data_service, "get_data", lambda data_id: {"LTE": rows})
    with pytest.raises(ValueError, match="LATITUDE"):
        load_full_params_from_data("x", "LTE", "CELL", "LON", "LATITUDE")


def test_load_full_params_from_data_ok(monkeypatch):
    from app.services import data_service as ds_mod
    rows = [{"CELL": "A", "LON": 116.0, "LAT": 39.0}]
    monkeypatch.setattr(ds_mod.data_service, "get_data", lambda data_id: {"LTE": rows})
    df = load_full_params_from_data("x", "LTE", "CELL", "LON", "LAT")
    assert list(df.columns) == ["CELL", "LON", "LAT"]
    assert df.iloc[0].tolist() == ["A", 116.0, 39.0]


# ---------------------------------------------------------------------------
# 数据管理原始 Excel sheet 读取（UI 重构 Task 1）
# ---------------------------------------------------------------------------


def test_read_data_sheets_from_original_excel(tmp_path):
    """original.xlsx 存在时返回真实 sheet 列表"""
    from app.services.distance_match_service import read_data_sheets
    excel = tmp_path / "original.xlsx"
    with pd.ExcelWriter(excel) as w:
        pd.DataFrame({"CELL": ["A"], "LON": [1.0], "LAT": [1.0]}).to_excel(w, sheet_name="LTE Project Parameters", index=False)
        pd.DataFrame({"CELL": ["B"], "LON": [1.0], "LAT": [1.0]}).to_excel(w, sheet_name="NR Project Parameters", index=False)
    sheets, source = read_data_sheets(str(excel))
    assert source == "excel"
    assert "LTE Project Parameters" in sheets
    assert "NR Project Parameters" in sheets


def test_read_data_sheets_fallback_network(monkeypatch, tmp_path):
    """original.xlsx 缺失时兜底返回网络分表键 (LTE/NR)"""
    from app.services.distance_match_service import read_data_sheets
    from app.services import data_service as ds_mod
    monkeypatch.setattr(ds_mod.data_service, "get_data", lambda data_id: {"LTE": [{"CELL": "A"}], "NR": [{"CELL": "B"}]})
    sheets, source = read_data_sheets(str(tmp_path / "nonexistent" / "original.xlsx"))
    assert source == "network"
    assert sheets == ["LTE", "NR"]


def test_load_full_sites_from_data_sheet_fallback(monkeypatch, tmp_path):
    """original.xlsx 缺失时回退 load_full_sites_from_data"""
    from app.services.distance_match_service import load_full_sites_from_data_sheet
    import pandas as pd
    monkeypatch.setattr(
        "app.services.distance_match_service.load_full_sites_from_data",
        lambda data_id, net, nc, loc, lac: pd.DataFrame([{"CELL": "F1", "LON": 1.0, "LAT": 1.0}]),
    )
    df = load_full_sites_from_data_sheet("d1", "LTE", "CELL", "LON", "LAT")
    assert list(df.columns) == ["CELL", "LON", "LAT"]
    assert len(df) == 1


def test_read_arbitrary_sheet_complex_header(tmp_path):
    """复杂表头（3行，\\n分隔元数据）的工参 sheet 应正确读取"""
    from app.services.distance_match_service import read_arbitrary_sheet
    excel = tmp_path / "params.xlsx"
    with pd.ExcelWriter(excel, engine="openpyxl") as w:
        # 模拟复杂表头：第1行中文名+元数据，第2-3行描述，第4行起数据
        raw = pd.DataFrame([
            ["CGI", "基站经度\neNodeB Longitude double:[-180..180]", "基站纬度\neNodeB Latitude\ndouble:[-90..90]"],
            ["非必填", "非必填", "非必填"],
            ["非必填", "非必填", "非必填"],
            ["F1", "116.001", "39.0"],
        ])
        raw.to_excel(w, sheet_name="LTE Project Parameters", index=False, header=False)
    df = read_arbitrary_sheet(str(excel), "LTE Project Parameters")
    assert list(df.columns) == ["CELL", "LON", "LAT"]
    assert len(df) == 1
    assert df.iloc[0]["CELL"] == "F1"


def test_read_arbitrary_sheet_dedup(tmp_path):
    """按 CELL 去重"""
    from app.services.distance_match_service import read_arbitrary_sheet
    excel = tmp_path / "dup.xlsx"
    with pd.ExcelWriter(excel, engine="openpyxl") as w:
        pd.DataFrame([{"CELL": "A", "LON": 1.0, "LAT": 1.0},
                      {"CELL": "A", "LON": 2.0, "LAT": 2.0}]).to_excel(w, sheet_name="全量", index=False)
    df = read_arbitrary_sheet(str(excel), "全量")
    assert len(df) == 1
    assert df.iloc[0]["LON"] == 1.0  # keep first
