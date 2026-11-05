"""编辑保存保留图层配色的测试（修复：pyogrio 裸写 TAB 样式全丢变黑）。

覆盖：
- _resolve_feature_style：_editStyle 优先 / _style 兜底 / 分段存储 / 全空
- _feature_mif_rows：点/线/面 → MIF Pen/Brush/Symbol；无色哨兵；透明度两档
- _inject_mif_styles：MIF 逐几何块替换样式，None 要素保留原行
- 端到端：整层保存、增量保存（未变更要素兜底 + 追加）后样式不丢
"""
import json

import geopandas as gpd
import pytest
from shapely.geometry import Point, LineString, Polygon

from app.services.layer_edit_service import (
    _resolve_feature_style, _feature_mif_rows, _inject_mif_styles,
    _write_styled_layer_tab, save_layer_geojson, read_tab_native_styles,
    layer_version,
)
from app.services.layer_patch_service import apply_layer_patch


# ---------------------------------------------------------------------------
# _resolve_feature_style
# ---------------------------------------------------------------------------

def test_resolve_style_edit_overrides_native():
    st = _resolve_feature_style(
        "line",
        es={"color": "#00ff00", "weight": 3, "dashArray": "5,5"},
        ns={"strokeColor": "#ff0000", "strokeWidth": 1},
    )
    assert st["strokeColor"] == "#00ff00"
    assert st["strokeWidth"] == 3
    assert st["strokeDash"] == "5,5"


def test_resolve_style_native_fallback():
    st = _resolve_feature_style("polygon", ns={
        "strokeColor": "#112233", "strokeWidth": 2,
        "fillColor": "#445566", "fillOpacity": 0.8, "fill": True})
    assert st["strokeColor"] == "#112233"
    assert st["fillColor"] == "#445566"
    assert st["fillOpacity"] == 0.8
    assert st["fillOff"] is None


def test_resolve_style_segmented_edit_style():
    # _editStyle 按几何分段存储
    st = _resolve_feature_style(
        "point",
        es={"point": {"markerColor": "#abcdef", "markerSize": 8}},
        ns={"markerColor": "#000000"},
    )
    assert st["markerColor"] == "#abcdef"
    assert st["markerSize"] == 8


def test_resolve_style_all_empty_returns_none():
    assert _resolve_feature_style("line") is None
    assert _resolve_feature_style("line", es={}, ns={}) is None


def test_resolve_style_native_stroke_off():
    st = _resolve_feature_style("line", ns={"stroke": False})
    assert st["strokeOff"] is True


# ---------------------------------------------------------------------------
# _feature_mif_rows
# ---------------------------------------------------------------------------

def test_mif_rows_point():
    st = _resolve_feature_style("point", ns={"markerColor": "#ff0000", "markerSize": 9})
    rows = _feature_mif_rows(st)
    assert rows == ["Symbol (34,16711680,9)"]


def test_mif_rows_point_no_color_omits_symbol():
    st = _resolve_feature_style("point", ns={"markerColor": "none", "markerSize": 9})
    assert _feature_mif_rows(st) == []


def test_mif_rows_line_solid_and_dash():
    st = _resolve_feature_style("line", ns={"strokeColor": "#0000ff", "strokeWidth": 2})
    assert _feature_mif_rows(st) == ["Pen (2,2,255)"]

    st = _resolve_feature_style(
        "line", es={"color": "#000000", "weight": 1, "dashArray": "5,5"})
    assert _feature_mif_rows(st) == ["Pen (1,3,0)"]


def test_mif_rows_polygon_brush_two_levels():
    # 不透明 → 实心 Brush(2, fc, bc)
    st = _resolve_feature_style("polygon", ns={
        "strokeColor": "#ff0000", "fillColor": "#ff0000", "fillOpacity": 0.8})
    rows = _feature_mif_rows(st)
    assert rows[0] == "Pen (1,2,16711680)"
    assert rows[1] == "Brush (2,16711680,16777215)"

    # 高透明 → 空心 Brush(1, fc)
    st = _resolve_feature_style("polygon", ns={
        "strokeColor": "#00ff00", "fillColor": "#00ff00", "fillOpacity": 0.2})
    assert _feature_mif_rows(st)[1] == "Brush (1,65280)"


def test_mif_rows_polygon_fill_off():
    st = _resolve_feature_style("polygon", ns={"fill": False, "strokeColor": "#000000"})
    rows = _feature_mif_rows(st)
    assert rows == ["Pen (1,2,0)", "Brush (1,0)"]


def test_mif_rows_polygon_native_pattern_preserved():
    # 原生图案填充（pattern 5）：原样写回，不压成实心/空心两档
    st = _resolve_feature_style("polygon", ns={
        "strokeColor": "#ff0000", "fillColor": "#00ff00",
        "fillPattern": 5, "fill": True})
    rows = _feature_mif_rows(st)
    assert rows == ["Pen (1,2,16711680)", "Brush (5,65280)"]


def test_mif_pen_row_invalid_color_falls_back_black():
    st = _resolve_feature_style("line", es={"color": "#zz00ff", "weight": 1})
    assert _feature_mif_rows(st) == ["Pen (1,2,0)"]


# ---------------------------------------------------------------------------
# _inject_mif_styles
# ---------------------------------------------------------------------------

SAMPLE_MIF = """Version 300
Charset "WindowsSimpChinese"
Delimiter ","
CoordSys Earth Projection 1, 104
Columns 1
  f0 Char(254)
Data

Point 114 24
    Symbol (35,0,12)
Line 114 24 114.01 24.01
    Pen (1,2,0)
Region 1
  4
114 24
114.01 24
114.01 24.01
114 24
    Pen (1,2,0)
    Brush (1,0,16777215)
"""


def test_inject_mif_styles_per_feature():
    styles = [
        _resolve_feature_style("point", ns={"markerColor": "#ff0000", "markerSize": 9}),
        _resolve_feature_style("line", ns={"strokeColor": "#00ff00", "strokeWidth": 3}),
        _resolve_feature_style("polygon", ns={
            "strokeColor": "#0000ff", "fillColor": "#0000ff", "fillOpacity": 0.8}),
    ]
    out = _inject_mif_styles(SAMPLE_MIF, styles)
    assert "Symbol (34,16711680,9)" in out
    assert "Pen (3,2,65280)" in out
    assert "Pen (1,2,255)" in out
    assert "Brush (2,255,16777215)" in out
    # 默认行已剔除
    assert "Symbol (35,0,12)" not in out
    # 坐标数据保留
    assert "114.01 24.01" in out


def test_inject_mif_styles_count_mismatch_raises():
    # MultiPoint/Collection 展开导致块数 > 样式数：显式抛异常而非错位注入
    styles = [
        _resolve_feature_style("point", ns={"markerColor": "#ff0000", "markerSize": 9}),
        _resolve_feature_style("line", ns={"strokeColor": "#00ff00"}),
    ]
    with pytest.raises(ValueError, match="不一致"):
        _inject_mif_styles(SAMPLE_MIF, styles)
    with pytest.raises(ValueError, match="不一致"):
        _inject_mif_styles(SAMPLE_MIF, styles + [None, None])


def test_inject_mif_styles_none_preserved():
    # 中间要素无样式信息 → 原 Pen 行保留
    styles = [
        _resolve_feature_style("point", ns={"markerColor": "#ff0000", "markerSize": 9}),
        None,
        None,
    ]
    out = _inject_mif_styles(SAMPLE_MIF, styles)
    assert "Symbol (34,16711680,9)" in out
    # 线要素的默认行原样保留（出现 2 次：线 + 面边框）
    assert out.count("Pen (1,2,0)") == 2
    assert "Brush (1,0,16777215)" in out


# ---------------------------------------------------------------------------
# 端到端 fixtures
# ---------------------------------------------------------------------------

def _make_styled_tab(path):
    """造一个带配色的 mixed TAB：红面 / 蓝线 / 绿点。返回 gdf。"""
    gdf = gpd.GeoDataFrame(
        {"name": ["poly", "line", "pt"]},
        geometry=[
            Polygon([(114.0, 24.0), (114.02, 24.0), (114.02, 24.02), (114.0, 24.0)]),
            LineString([(114.01, 24.01), (114.03, 24.03)]),
            Point(114.015, 24.015),
        ],
        crs="EPSG:4326",
    )
    styles = [
        _resolve_feature_style("polygon", ns={
            "stroke": True, "strokeColor": "#ff0000", "strokeWidth": 2,
            "fill": True, "fillColor": "#ff0000", "fillOpacity": 0.8}),
        _resolve_feature_style("line", ns={
            "stroke": True, "strokeColor": "#0000ff", "strokeWidth": 2}),
        _resolve_feature_style("point", ns={"markerColor": "#00ff00", "markerSize": 9}),
    ]
    _write_styled_layer_tab(gdf, styles, path, "Unknown")
    return gdf


def _register_layer(data_dir, tab, entry_type="mixed"):
    entry = {
        "id": data_dir.name, "name": tab.stem, "type": entry_type,
        "feature_count": 3,
        "metadata": {"source_file": str(tab), "feature_count": 3},
    }
    (data_dir / "layers.json").write_text(
        json.dumps([entry]), encoding="utf-8")
    return entry


def test_full_save_preserves_colors(tmp_path, monkeypatch):
    monkeypatch.setattr("app.core.config.settings.DATA_DIR", tmp_path)
    data_id = "data-1"
    data_dir = tmp_path / data_id
    data_dir.mkdir()
    tab = data_dir / "x.tab"
    _make_styled_tab(tab)
    _register_layer(data_dir, tab)

    # 模拟前端工作集：原要素 properties 带后端注入的 _style
    native = read_tab_native_styles(tab)
    geoms = [
        {"type": "Polygon", "coordinates": [[
            [114.0, 24.0], [114.02, 24.0], [114.02, 24.02], [114.0, 24.0]]]},
        {"type": "LineString", "coordinates": [
            [114.01, 24.01], [114.03, 24.03]]},
        {"type": "Point", "coordinates": [114.015, 24.015]},
    ]
    features = [
        {"type": "Feature", "geometry": geoms[0],
         "properties": {"name": "poly", "_style": native[0]}},
        {"type": "Feature", "geometry": geoms[1],
         "properties": {"name": "line", "_style": native[1]}},
        {"type": "Feature", "geometry": geoms[2],
         "properties": {"name": "pt", "_style": native[2]}},
    ]
    r = save_layer_geojson(data_id, data_id,
                           {"type": "FeatureCollection", "features": features},
                           user_id=1)
    assert r["success"] and r["feature_count"] == 3

    styles = read_tab_native_styles(tab)
    assert styles[0]["fillColor"] == "#ff0000"
    assert styles[1]["strokeColor"] == "#0000ff"
    assert styles[2]["markerColor"] == "#00ff00"


def test_patch_save_preserves_unaffected_and_appends(tmp_path, monkeypatch):
    monkeypatch.setattr("app.core.config.settings.DATA_DIR", tmp_path)
    data_id = "data-2"
    data_dir = tmp_path / data_id
    data_dir.mkdir()
    tab = data_dir / "x.tab"
    _make_styled_tab(tab)
    _register_layer(data_dir, tab)

    patch = {
        "base": {"count": 3, "version": layer_version(tab, data_id)},
        "upserts": [
            # 修改 row1（线），样式与原色一致
            {"row": 1,
             "geometry": {"type": "LineString", "coordinates": [
                 [114.01, 24.01], [114.03, 24.03]]},
             "properties": {"name": "line2",
                            "_editStyle": {"color": "#0000ff", "weight": 2}}},
            # 追加黄点
            {"row": None,
             "geometry": {"type": "Point", "coordinates": [114.02, 24.02]},
             "properties": {"name": "newpt",
                            "_editStyle": {"markerColor": "#ffff00", "markerSize": 10}}},
        ],
        "deletes": [],
    }
    r = apply_layer_patch(data_id, data_id, patch, user_id=1)
    assert r["success"] and r["feature_count"] == 4

    styles = read_tab_native_styles(tab)
    # 未变更的面/点按旧 .map 样式兜底
    assert styles[0]["fillColor"] == "#ff0000"
    assert styles[1]["strokeColor"] == "#0000ff"
    assert styles[2]["markerColor"] == "#00ff00"
    assert styles[3]["markerColor"] == "#ffff00"


def test_patch_save_pasted_feature_native_style_preserved(tmp_path, monkeypatch):
    """从其他图层复制粘贴的追加要素（只带 _style、无 _editStyle），保存后保留原生配色。"""
    monkeypatch.setattr("app.core.config.settings.DATA_DIR", tmp_path)
    data_id = "data-paste"
    data_dir = tmp_path / data_id
    data_dir.mkdir()
    tab = data_dir / "x.tab"
    _make_styled_tab(tab)
    _register_layer(data_dir, tab)

    # 粘贴一个红色面（模拟复制时随要素带走的 _style）
    pasted_style = {
        "stroke": True, "strokeColor": "#ff0000", "strokeWidth": 2,
        "fill": True, "fillColor": "#ff0000", "fillOpacity": 0.8}
    patch = {
        "base": {"count": 3, "version": layer_version(tab, data_id)},
        "upserts": [{
            "row": None,
            "geometry": {"type": "Polygon", "coordinates": [[
                [114.03, 24.03], [114.05, 24.03], [114.05, 24.05], [114.03, 24.03]]]},
            "properties": {"name": "pasted", "_style": pasted_style},
        }],
        "deletes": [],
    }
    r = apply_layer_patch(data_id, data_id, patch, user_id=1)
    assert r["success"] and r["feature_count"] == 4

    styles = read_tab_native_styles(tab)
    assert styles[3]["fillColor"] == "#ff0000"
    assert styles[3]["strokeColor"] == "#ff0000"
    # 原有要素不受影响
    assert styles[1]["strokeColor"] == "#0000ff"


def test_full_save_pasted_feature_native_style_preserved(tmp_path, monkeypatch):
    """整层保存：粘贴要素（_keepStyle，只带 _style）颜色同样保留。"""
    monkeypatch.setattr("app.core.config.settings.DATA_DIR", tmp_path)
    data_id = "data-paste-full"
    data_dir = tmp_path / data_id
    data_dir.mkdir()
    tab = data_dir / "x.tab"
    _make_styled_tab(tab)
    _register_layer(data_dir, tab)

    native = read_tab_native_styles(tab)
    features = []
    geoms = [
        {"type": "Polygon", "coordinates": [[
            [114.0, 24.0], [114.02, 24.0], [114.02, 24.02], [114.0, 24.0]]]},
        {"type": "LineString", "coordinates": [
            [114.01, 24.01], [114.03, 24.03]]},
        {"type": "Point", "coordinates": [114.015, 24.015]},
    ]
    names = ["poly", "line", "pt"]
    for name, geom, ns in zip(names, geoms, native):
        features.append({"type": "Feature", "geometry": geom,
                         "properties": {"name": name, "_style": ns}})
    # 粘贴的追加要素：无 _editStyle，只带 _style
    features.append({
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [114.03, 24.03]},
        "properties": {"name": "pasted",
                       "_style": {"markerColor": "#ffff00", "markerSize": 10}},
    })
    save_layer_geojson(data_id, data_id,
                       {"type": "FeatureCollection", "features": features},
                       user_id=1)
    styles = read_tab_native_styles(tab)
    assert styles[3]["markerColor"] == "#ffff00"


def test_patch_save_delete_filters_styles(tmp_path, monkeypatch):
    """删除行后样式列表必须同步过滤，否则行数错位导致 verify 失败。"""
    monkeypatch.setattr("app.core.config.settings.DATA_DIR", tmp_path)
    data_id = "data-3"
    data_dir = tmp_path / data_id
    data_dir.mkdir()
    tab = data_dir / "x.tab"
    _make_styled_tab(tab)
    _register_layer(data_dir, tab)

    patch = {
        "base": {"count": 3, "version": layer_version(tab, data_id)},
        "upserts": [],
        "deletes": [2],  # 删除绿点
    }
    r = apply_layer_patch(data_id, data_id, patch, user_id=1)
    assert r["success"] and r["feature_count"] == 2
    styles = read_tab_native_styles(tab)
    assert styles[0]["fillColor"] == "#ff0000"
    assert styles[1]["strokeColor"] == "#0000ff"
