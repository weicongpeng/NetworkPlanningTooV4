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
    """Point/LineString/Polygon 坐标全部被 WGS84→GCJ02 转换

    使用 parse_file 真实产出的 tuple 坐标结构（shapely coords）：
    - Point   → [x, y]（list 套数字）
    - Line    → [(x,y), (x,y), ...]（list 套 tuple）
    - Polygon → [[(x,y), ...]]（list 套 ring，ring 内是 tuple）
    """
    layer = _make_layer([
        MapInfoFeature(id="p", type=GeometryType.POINT, coordinates=[116.397, 39.908], properties={}),
        MapInfoFeature(id="l", type=GeometryType.LINE,
                       coordinates=[(116.397, 39.908), (116.398, 39.909)], properties={}),
        MapInfoFeature(id="poly", type=GeometryType.POLYGON,
                       coordinates=[[(116.397, 39.908), (116.398, 39.908),
                                     (116.398, 39.909), (116.397, 39.908)]], properties={}),
    ])
    out = _convert_to_geojson(layer, transform_coords=True)
    for f in out["features"]:
        geojson = f["geometry"]["coordinates"]
        # 递归取第一个坐标对（list 或 tuple 都可能）
        stack = [geojson]
        first = None
        while stack:
            c = stack.pop()
            if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
                first = c
                break
            if isinstance(c, (list, tuple)):
                stack.extend(c)
        assert first is not None
        assert first[0] != 116.397 or first[1] != 39.908, f"geometry {f['geometry']['type']} 未转换"
        # 输出应为 GeoJSON 标准 list（不是 tuple）
        assert isinstance(first, list), f"geometry {f['geometry']['type']} 输出应为 list，实际 {type(first)}"


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


def test_infer_style_from_properties_returns_none():
    """按属性关键词分色已废弃，无显式样式时返回 None（统一默认色）"""
    import pandas as pd
    row = pd.Series({"name": "某水域公园绿地建筑", "geometry": None})
    style = MapInfoParser._infer_style_from_properties(row, GeometryType.POLYGON)
    assert style is None  # 不再按 '水'/'绿地'/'建筑' 分色


# ---------------------------------------------------------------------------
# 第二轮：tuple 坐标转换 + 批量转换一致性
# parse_file 用 shapely 产出 tuple 坐标（Line→[(x,y)], Polygon→[[(x,y)]]），
# 转换后必须输出 GeoJSON 标准 list 结构。
# ---------------------------------------------------------------------------


def test_transform_coordinates_tuple_line():
    """tuple 结构 LineString 被转换且输出为 list"""
    from app.utils.coordinate_transformer import CoordinateTransformer
    line = [(116.397, 39.908), (116.398, 39.909)]
    out = CoordinateTransformer.transform_geojson_coordinates(line)
    assert out != line
    assert isinstance(out[0], list)
    assert out[0][0] != 116.397  # 经度已偏移


def test_transform_coordinates_tuple_polygon():
    """tuple 结构 Polygon 被转换且输出为 list"""
    from app.utils.coordinate_transformer import CoordinateTransformer
    poly = [[(116.397, 39.908), (116.398, 39.908), (116.398, 39.909), (116.397, 39.908)]]
    out = CoordinateTransformer.transform_geojson_coordinates(poly)
    assert out != poly
    assert isinstance(out[0], list)
    assert isinstance(out[0][0], list)
    assert out[0][0][0] != 116.397


def test_transform_coordinates_keeps_z():
    """含 z 值坐标转换后保留 z"""
    from app.utils.coordinate_transformer import CoordinateTransformer
    line3d = [(116.397, 39.908, 100), (116.398, 39.909, 200)]
    out = CoordinateTransformer.transform_geojson_coordinates(line3d)
    assert out[0][2] == 100
    assert out[1][2] == 200


def test_transform_coordinates_batch_matches_scalar():
    """批量转换与标量转换对 Point/Line/Polygon 输出一致"""
    from app.utils.coordinate_transformer import CoordinateTransformer
    cases = [
        [116.397, 39.908],
        [(116.397, 39.908), (116.398, 39.909)],
        [[(116.397, 39.908), (116.398, 39.908), (116.398, 39.909), (116.397, 39.908)]],
        [(116.397, 39.908, 100), (116.398, 39.909, 200)],
    ]
    for coords in cases:
        scalar = CoordinateTransformer.transform_geojson_coordinates(coords)
        batch = CoordinateTransformer.transform_geojson_coordinates_batch(coords)
        assert scalar == batch, f"batch 与 scalar 不一致: {coords}"
