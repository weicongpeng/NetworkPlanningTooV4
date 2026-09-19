"""图层增量保存（patch）：只回传变更要素，后端按行合并后整层重写。

覆盖点：
- 属性修改只影响目标行，其余行（含数值列 dtype）保持不变
- 几何修改（GCJ02→WGS84）、新增（追加末尾）、删除（按基底行号且保持顺序）
- 新属性键扩展 schema；_editStyle / _shape 写入样式持久化列
- 基底一致性：行数或版本（源文件 mtime）不符 → LayerVersionConflict（端点 409）
"""
import json

import geopandas as gpd
import pytest
from shapely.geometry import Point

from app.core.config import settings
from app.services.layer_edit_service import _read_tab_gdf, layer_version
from app.services.layer_patch_service import LayerVersionConflict, apply_layer_patch
from app.services.tab_io import write_mapinfo_tab
from app.utils.coordinate_transformer import CoordinateTransformer


@pytest.fixture()
def layer_env(tmp_path, monkeypatch):
    """临时 DATA_DIR + 单个可编辑 TAB 图层（3 个点，name/等级/数值 列）。"""
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path)
    # 不写 SQLite layers 表（避免污染生产库，保存链路本身不依赖它）
    monkeypatch.setattr("app.services.layer_edit_service._upsert_layer_metadata",
                        lambda **kw: None)

    data_id = "test-patch-data"
    layer_id = "layer-patch"
    data_dir = tmp_path / data_id
    data_dir.mkdir(parents=True)
    tab_path = data_dir / "增量测试.tab"
    gdf = gpd.GeoDataFrame(
        {"name": ["A", "B", "C"], "等级": ["1", "2", "3"], "数值": [1, 2, 3]},
        geometry=[Point(114.00, 23.00), Point(114.01, 23.01), Point(114.02, 23.02)],
        crs="EPSG:4326",
    )
    write_mapinfo_tab(gdf, tab_path, geometry_type="Point")
    (data_dir / "layers.json").write_text(
        json.dumps([{
            "id": layer_id, "name": "增量测试", "type": "point",
            "metadata": {"source_file": str(tab_path), "editable": True},
        }], ensure_ascii=False),
        encoding="utf-8",
    )
    return {"data_id": data_id, "layer_id": layer_id, "tab": tab_path}


def _base(env, count=3):
    return {"count": count, "version": layer_version(env["tab"], env["layer_id"])}


def _props(name, level, value):
    return {"name": name, "等级": level, "数值": value}


def test_patch_updates_single_row_and_keeps_others(layer_env):
    """属性增量：只改目标行，其余行与列 dtype 不变。"""
    res = apply_layer_patch(
        layer_env["data_id"], layer_env["layer_id"],
        {"base": _base(layer_env),
         "upserts": [{"row": 1, "properties": _props("B2", "2", 7)}]},
        user_id=1,
    )
    assert res["mode"] == "patch" and res["feature_count"] == 3

    g = _read_tab_gdf(layer_env["tab"])
    assert g["name"].tolist() == ["A", "B2", "C"]
    assert g["数值"].tolist() == [1, 7, 3]
    assert g["数值"].dtype == gpd.pd.Int64Dtype() or str(g["数值"].dtype).startswith("int")


def test_patch_geometry_update_and_append(layer_env):
    """几何增量（GCJ02→WGS84 逆转换）+ 新增要素追加到末尾。"""
    gcj_point = [114.05, 23.05]
    gcj_new = [114.03, 23.03]
    exp_lat, exp_lng = CoordinateTransformer.gcj02_to_wgs84(gcj_point[1], gcj_point[0])
    exp2_lat, exp2_lng = CoordinateTransformer.gcj02_to_wgs84(gcj_new[1], gcj_new[0])
    res = apply_layer_patch(
        layer_env["data_id"], layer_env["layer_id"],
        {"base": _base(layer_env),
         "upserts": [
             {"row": 0, "geometry": {"type": "Point", "coordinates": gcj_point},
              "properties": _props("A", "1", 1)},
             {"row": None, "geometry": {"type": "Point", "coordinates": gcj_new},
              "properties": {"name": "D", "新键": "x"}},
         ]},
        user_id=1,
    )
    assert res["feature_count"] == 4

    g = _read_tab_gdf(layer_env["tab"])
    assert g["name"].tolist() == ["A", "B", "C", "D"]
    assert "新键" in g.columns
    # TAB 坐标按 float32 存储，容差 1e-5 ≈ 1m
    assert g.iloc[0].geometry.x == pytest.approx(exp_lng, abs=1e-5)
    assert g.iloc[0].geometry.y == pytest.approx(exp_lat, abs=1e-5)
    assert g.iloc[3]["新键"] == "x"
    assert g.iloc[3].geometry.x == pytest.approx(exp2_lng, abs=1e-5)
    assert g.iloc[3].geometry.y == pytest.approx(exp2_lat, abs=1e-5)


def test_patch_delete_rows_preserve_order(layer_env):
    """删除按基底行号表达，剩余行保持原有顺序（不重排）。"""
    res = apply_layer_patch(
        layer_env["data_id"], layer_env["layer_id"],
        {"base": _base(layer_env), "upserts": [], "deletes": [1]},
        user_id=1,
    )
    assert res["feature_count"] == 2
    g = _read_tab_gdf(layer_env["tab"])
    assert g["name"].tolist() == ["A", "C"]


def test_patch_writes_style_and_meta_columns(layer_env):
    """编辑样式 / 圆元数据写入持久化列；无样式行留空。"""
    apply_layer_patch(
        layer_env["data_id"], layer_env["layer_id"],
        {"base": _base(layer_env),
         "upserts": [{"row": 2,
                      "properties": {**_props("C", "3", 3),
                                     "_editStyle": {"markerColor": "#ff0000"},
                                     "_shape": "circle"}}]},
        user_id=1,
    )
    g = _read_tab_gdf(layer_env["tab"])
    assert "NPT_FEATSYM" in g.columns and "NPT_FEATMETA" in g.columns
    assert json.loads(g.iloc[2]["NPT_FEATSYM"]) == {"markerColor": "#ff0000"}
    assert json.loads(g.iloc[2]["NPT_FEATMETA"]) == {"_shape": "circle"}
    assert str(g.iloc[0]["NPT_FEATSYM"]) in ("", "nan", "None")


def test_patch_internal_fields_not_written(layer_env):
    """内部字段（_editId / _style / _shape 等）不落普通属性列。"""
    apply_layer_patch(
        layer_env["data_id"], layer_env["layer_id"],
        {"base": _base(layer_env),
         "upserts": [{"row": 0, "properties": {**_props("A2", "1", 1),
                                               "_editId": "e1", "markerColor": "#fff"}}]},
        user_id=1,
    )
    g = _read_tab_gdf(layer_env["tab"])
    assert "_editId" not in g.columns and "markerColor" not in g.columns
    assert g["name"].tolist() == ["A2", "B", "C"]


@pytest.mark.parametrize("base", [
    {"count": 2},                      # 行数不符
    {"count": 3, "version": '"layer-patch-1.0"'},  # 版本（mtime）不符
])
def test_patch_conflict_raises(layer_env, base):
    """基底不一致（行数/版本）→ LayerVersionConflict，由端点转 409 让前端回退整层保存。"""
    with pytest.raises(LayerVersionConflict):
        apply_layer_patch(
            layer_env["data_id"], layer_env["layer_id"],
            {"base": base, "upserts": [{"row": 0, "properties": _props("X", "1", 1)}]},
            user_id=1,
        )


def test_patch_out_of_range_row_raises(layer_env):
    """越界行号 / 删除越界 → LayerVersionConflict（不静默写错行）。"""
    with pytest.raises(LayerVersionConflict):
        apply_layer_patch(
            layer_env["data_id"], layer_env["layer_id"],
            {"base": _base(layer_env), "upserts": [{"row": 99, "properties": {"name": "X"}}]},
            user_id=1,
        )
    with pytest.raises(LayerVersionConflict):
        apply_layer_patch(
            layer_env["data_id"], layer_env["layer_id"],
            {"base": _base(layer_env), "upserts": [], "deletes": [5]},
            user_id=1,
        )


def test_write_tab_keeps_names_when_geometry_not_last(tmp_path):
    """回归：几何列不在最后时，写盘列名不得错位（占位符只覆盖属性列）。

    增量保存的 gdf 来自读回结果并在末尾追加样式列，几何列位于中间；
    占位符若把几何列也算进去，几何列之后的列名会整体偏移一格（样式值写进 geometry 列）。
    """
    gdf = gpd.GeoDataFrame(
        {"name": ["A"], "等级": ["1"], "数值": [5]},
        geometry=[Point(114.0, 23.0)], crs="EPSG:4326",
    )
    gdf["NPT_FEATSYM"] = ['{"markerColor": "#f00"}']
    gdf["NPT_FEATMETA"] = ['{"_shape": "circle"}']
    tab = tmp_path / "列序.tab"
    write_mapinfo_tab(gdf, tab, geometry_type="Point")

    out = _read_tab_gdf(tab)
    assert list(out.columns) == ["name", "等级", "数值", "NPT_FEATSYM", "NPT_FEATMETA", "geometry"]
    assert out.iloc[0]["NPT_FEATSYM"] == '{"markerColor": "#f00"}'
    assert out.iloc[0]["NPT_FEATMETA"] == '{"_shape": "circle"}'
    assert out.iloc[0]["数值"] == 5
