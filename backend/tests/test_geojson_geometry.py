"""GeoJSON 几何批量构建（数组快路径）与旧逐要素路径的一致性。

背景：图层保存的坐标逆转换 + shapely 几何构建原为逐点 Python 递归
（86 万节点图层约需 8 秒）；改为 numpy 数组化 + 整层一次向量化转换后，
此处确保几何结果与旧路径完全一致，且回退路径（z 值/未知类型/非法结构）不丢要素。
"""
import json

import pytest

pytest.importorskip("shapely")

import numpy as np  # noqa: E402
from shapely.geometry import shape  # noqa: E402

from app.utils.coordinate_transformer import CoordinateTransformer as CT  # noqa: E402
from app.utils.geojson_geometry import build_geometries, transform_coordinate_lists  # noqa: E402


def _old_path(geom):
    """旧实现：逐点递归逆转换 + shapely.shape。"""
    coords = CT.transform_geojson_coordinates_batch(geom["coordinates"], from_wgs84=False)
    return shape({"type": geom["type"], "coordinates": coords})


GEOMS = {
    "Point": {"type": "Point", "coordinates": [114.05, 23.10]},
    "MultiPoint": {"type": "MultiPoint", "coordinates": [[114.05, 23.10], [114.06, 23.11]]},
    "LineString": {"type": "LineString", "coordinates": [[114.05, 23.10], [114.06, 23.11], [114.07, 23.12]]},
    "MultiLineString": {"type": "MultiLineString",
                        "coordinates": [[[114.05, 23.10], [114.06, 23.11]], [[114.08, 23.13], [114.09, 23.14]]]},
    "Polygon": {"type": "Polygon",
                "coordinates": [[[114.05, 23.10], [114.06, 23.10], [114.06, 23.11], [114.05, 23.10]]]},
    "PolygonWithHole": {"type": "Polygon", "coordinates": [
        [[114.05, 23.10], [114.10, 23.10], [114.10, 23.15], [114.05, 23.10]],
        [[114.06, 23.11], [114.08, 23.11], [114.08, 23.13], [114.06, 23.11]],
    ]},
    "MultiPolygon": {"type": "MultiPolygon", "coordinates": [
        [[[114.05, 23.10], [114.06, 23.10], [114.06, 23.11], [114.05, 23.10]]],
        [[[114.08, 23.13], [114.09, 23.13], [114.09, 23.14], [114.08, 23.13]]],
    ]},
}


@pytest.mark.parametrize("name", list(GEOMS))
def test_build_geometries_matches_legacy_path(name):
    """标准几何类型：数组快路径结果与旧逐点路径逐坐标完全一致。"""
    geom = GEOMS[name]
    [built] = build_geometries([geom], from_wgs84=False)
    assert built.geom_type == _old_path(geom).geom_type
    assert built.equals_exact(_old_path(geom), 0.0)


def test_build_geometries_mixed_batch_keeps_order():
    """混合类型批量构建：结果与输入等长、顺序一致。"""
    geoms = [GEOMS["Point"], GEOMS["LineString"], GEOMS["PolygonWithHole"], GEOMS["MultiPolygon"]]
    built = build_geometries(geoms, from_wgs84=False)
    assert [g.geom_type for g in built] == ["Point", "LineString", "Polygon", "MultiPolygon"]
    for g, src in zip(built, geoms):
        assert g.equals_exact(_old_path(src), 0.0)


def test_build_geometries_z_falls_back():
    """含 z 值的坐标走通用回退路径（保留第三维，不静默丢弃）。"""
    geom = {"type": "LineString", "coordinates": [[114.05, 23.10, 12.5], [114.06, 23.11, 13.0]]}
    [built] = build_geometries([geom], from_wgs84=False)
    assert built.has_z
    assert built.equals_exact(_old_path(geom), 0.0)


def test_build_geometries_invalid_returns_none():
    """非法/空几何返回 None（调用方按原逻辑跳过），不影响同批其它要素。"""
    geoms = [None, {}, {"type": "LineString", "coordinates": []},
             {"type": "LineString", "coordinates": [[114.05, 23.10]]},
             GEOMS["Point"]]
    built = build_geometries(geoms, from_wgs84=False)
    assert built[:4] == [None, None, None, None]
    assert built[4] is not None and not built[4].is_empty


def test_build_geometries_transforms_outside_china_unchanged():
    """境外坐标不纠偏：与标量结果一致（数组路径不引入额外偏移）。"""
    geom = {"type": "LineString", "coordinates": [[10.0, 20.0], [11.0, 21.0]]}
    [built] = build_geometries([geom], from_wgs84=False)
    assert list(built.coords) == [(10.0, 20.0), (11.0, 21.0)]


def test_build_geometries_from_wgs84_direction():
    """from_wgs84=True 时做 WGS84→GCJ02，与批量标量转换一致。"""
    geom = {"type": "Point", "coordinates": [114.05, 23.10]}
    [built] = build_geometries([geom], from_wgs84=True)
    exp_lat, exp_lng = CT.wgs84_to_gcj02(23.10, 114.05)
    assert built.x == pytest.approx(exp_lng, abs=1e-12)
    assert built.y == pytest.approx(exp_lat, abs=1e-12)


COORDS = [
    [114.05, 23.10],                                                     # Point
    [[114.05, 23.10], [114.06, 23.11], [114.07, 23.12]],                  # LineString
    [[[114.05, 23.10], [114.06, 23.10], [114.06, 23.11], [114.05, 23.10]]],  # Polygon
    [[[114.05, 23.10], [114.10, 23.10], [114.10, 23.15], [114.05, 23.10]],
     [[114.06, 23.11], [114.08, 23.11], [114.08, 23.13], [114.06, 23.11]]],  # 带洞
    [[[[114.05, 23.10], [114.06, 23.10], [114.06, 23.11], [114.05, 23.10]]]],  # MultiPolygon
    [[114.05, 23.10, 12.5], [114.06, 23.11, 13.0]],                       # 带 z
    [114.05, 23.10, 7.0],                                                 # Point 带 z
    [],                                                                   # 空
    [[1.0, 1.0]],                                                         # 单点线（旧路径会抛错）
]


def _tupled(node):
    """模拟解析器产物：点坐标用 tuple，容器用 list。"""
    if isinstance(node, list) and node and isinstance(node[0], (int, float)):
        return tuple(node)
    if isinstance(node, list):
        return [_tupled(child) for child in node]
    return node


def test_transform_coordinate_lists_matches_scalar_path():
    """嵌套坐标批量转换与逐点递归结果完全一致（含 z 值、空结构与 tuple 输入）。"""
    for from_wgs84 in (True, False):
        for raw in COORDS:
            coords = _tupled(raw)
            [built] = transform_coordinate_lists([coords], from_wgs84=from_wgs84)
            expected = CT.transform_geojson_coordinates_batch(coords, from_wgs84=from_wgs84)
            assert built == expected, f"不一致: {raw} (from_wgs84={from_wgs84})"


def test_transform_coordinate_lists_keeps_structure_and_order():
    """批量转换保持列表长度与嵌套层级，非法元素不影响其它元素。"""
    out = transform_coordinate_lists(COORDS, from_wgs84=False)
    assert len(out) == len(COORDS)
    assert out[0] == pytest.approx([114.0448, 23.1025], abs=1e-3)
    assert isinstance(out[1][0], list) and len(out[1]) == 3
    assert len(out[2][0]) == 4 and isinstance(out[2][0][0], list)
    assert len(out[5][0]) == 3  # z 值保留
    assert out[7] == []
