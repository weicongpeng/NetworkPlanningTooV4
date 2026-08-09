"""
图层渲染修复测试

覆盖:
- _convert_to_geojson 坐标转换（WGS84→GCJ02）
- MapInfo Pen/Brush/Symbol 单整数颜色 BGR 还原
- 按属性关键词分色废弃
"""
from typing import Dict, Any

from app.services.mapinfo_service import (
    _convert_to_geojson,
    MapInfoLayer,
    MapInfoFeature,
    MapInfoParser,
    GeometryType,
)


def _make_layer(features, layer_type=GeometryType.POLYGON, name="diag") -> MapInfoLayer:
    return MapInfoLayer(id="t1", name=name, type=layer_type, features=features, metadata={})


def test_convert_to_geojson_transform_coords_true():
    """transform_coords=True 时坐标被 WGS84→GCJ02 转换"""
    layer = _make_layer([
        MapInfoFeature(id="f1", type=GeometryType.POINT,
                       coordinates=[116.397, 39.908],  # 北京天安门 WGS84
                       properties={}),
    ], layer_type=GeometryType.POINT)
    out = _convert_to_geojson(layer, transform_coords=True)
    gcj = out["features"][0]["geometry"]["coordinates"]
    # 转换后应偏离 WGS84（GCJ02 在北京约偏移 ~550m，经度/纬度皆有变化）
    assert gcj[0] != 116.397 or gcj[1] != 39.908


def test_convert_to_geojson_transforms_all_geometry_types():
    """Point/LineString/Polygon 坐标全部被 WGS84→GCJ02 转换"""
    layer = _make_layer([
        MapInfoFeature(id="p", type=GeometryType.POINT, coordinates=[116.397, 39.908], properties={}),
        MapInfoFeature(id="l", type=GeometryType.LINE,
                       coordinates=[[116.397, 39.908], [116.398, 39.909]], properties={}),
        MapInfoFeature(id="poly", type=GeometryType.POLYGON,
                       coordinates=[[[116.397, 39.908], [116.398, 39.908],
                                     [116.398, 39.909], [116.397, 39.908]]], properties={}),
    ])
    out = _convert_to_geojson(layer, transform_coords=True)
    for f in out["features"]:
        geojson = f["geometry"]["coordinates"]
        # 递归取第一个坐标对
        stack = [geojson]
        first = None
        while stack:
            c = stack.pop()
            if isinstance(c, list) and c and isinstance(c[0], (int, float)):
                first = c
                break
            if isinstance(c, list):
                stack.extend(c)
        assert first is not None
        assert first[0] != 116.397 or first[1] != 39.908, f"geometry {f['geometry']['type']} 未转换"
