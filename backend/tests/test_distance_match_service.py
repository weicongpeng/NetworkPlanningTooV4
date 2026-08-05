# backend/tests/test_distance_match_service.py
import math
import os
import pandas as pd
import tempfile
from openpyxl import load_workbook

from app.services.distance_match_service import (
    haversine_km,
    match_sites,
    validate_sheet,
    build_output_excel,
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
