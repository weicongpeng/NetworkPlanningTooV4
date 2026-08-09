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


# ---------------------------------------------------------------------------
# Task 3: MapInfo 单整数颜色解析（BGR 还原）
# MapInfo 官方规范: Color = R + G*256 + B*65536（R 在最低字节）。
# 16711680 = 0xFF0000 → B=0xFF → #0000ff（蓝色）。
# ---------------------------------------------------------------------------


def test_parse_pen_single_integer_color():
    """Pen(width, pattern, color_int) 单整数颜色按官方规范还原为 #rrggbb"""
    style = MapInfoParser._parse_style_value("Pen", "1,2,16711680")  # 16711680 = 0xFF0000 → #0000ff
    assert style is not None
    assert style["strokeColor"] == "#0000ff"
    assert style["strokeWidth"] == 1.0


def test_parse_pen_gdal_prefixed_format():
    """GDAL 读外部 MIF 时样式列带 'Pen (...)' 前缀+括号，应同样正确解析"""
    style = MapInfoParser._parse_style_value("MAPINFO_Pen", "Pen (2, 2, 16711680)")
    assert style is not None
    assert style["strokeColor"] == "#0000ff"
    assert style["strokeWidth"] == 2.0


def test_parse_pen_black_color():
    """单整数颜色 0（黑色）正确还原"""
    style = MapInfoParser._parse_style_value("Pen", "1,2,0")
    assert style is not None
    assert style["strokeColor"] == "#000000"


def test_parse_pen_rgb_components_unchanged():
    """多段 RGB 格式 (width,r,g,b,pattern) 不被破坏"""
    style = MapInfoParser._parse_style_value("Pen", "2,255,0,0,2")
    assert style is not None
    assert style["strokeColor"] == "#ff0000"
    assert style["strokeWidth"] == 2.0


def test_parse_brush_single_integer_color():
    """Brush(pattern, forecolor, [backcolor]) 单整数前景色还原"""
    style = MapInfoParser._parse_style_value("Brush", "2,16711680,16777215")
    assert style is not None
    assert style["fillColor"] == "#0000ff"
    assert style["fillBgColor"] == "#ffffff"  # 16777215 = 0xFFFFFF → #ffffff
    assert style["fill"] is True


def test_parse_symbol_single_integer_color():
    """Symbol(shape, color, size) 单整数颜色还原"""
    style = MapInfoParser._parse_style_value("Symbol", "34,16711680,12")
    assert style is not None
    assert style["markerColor"] == "#0000ff"
