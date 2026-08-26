"""
图层导入解析测试（tab/mif/kml）

覆盖：
- KML 图层类型识别 + <Style>/<styleUrl> 样式还原
- MIF 点要素 Symbol 样式还原（GDAL 不暴露样式列时的 .mif 文本兜底解析）
- TAB .map 文件样式解析（要素占位对齐）
- KML aabbggrr 颜色转换

依赖 geopandas/pyogrio，缺失时 pytest.skip（沿用 test_layer_service 的 _try_import 模式）。
"""
import pytest
from pathlib import Path

SAMPLE_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <Style id="lineStyle">
    <LineStyle><color>ff0000ff</color><width>3</width></LineStyle>
  </Style>
  <Style id="polyStyle">
    <PolyStyle><color>800000ff</color><fill>1</fill></PolyStyle>
  </Style>
  <StyleMap id="pointStyleMap">
    <Pair><key>normal</key><styleUrl>#pointStyle</styleUrl></Pair>
  </StyleMap>
  <Style id="pointStyle">
    <IconStyle><color>ffff0000</color><scale>1.5</scale></IconStyle>
  </Style>
  <Placemark><name>road1</name><styleUrl>#lineStyle</styleUrl>
    <LineString><coordinates>116.3,39.9,0 116.4,39.9,0</coordinates></LineString></Placemark>
  <Placemark><name>area1</name><Style><PolyStyle><color>8000ff00</color></PolyStyle></Style>
    <Polygon><outerBoundaryIs><LinearRing>
      <coordinates>116.3,39.9,0 116.4,39.9,0 116.4,40.0,0 116.3,39.9,0</coordinates>
    </LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><name>pt1</name><styleUrl>#pointStyleMap</styleUrl>
    <Point><coordinates>116.35,39.95,0</coordinates></Point></Placemark>
</Document>
</kml>
"""

SAMPLE_MIF = """Version 300
Charset "WindowsSimpChinese"
Delimiter ","
Columns 2
  NAME Char (20)
  VAL Integer
Data
  Symbol (35, 16711680, 12)
Point 116.3 39.9
  Symbol (35, 65280, 14)
Point 116.4 40.0
  Pen (2, 2, 0)
Line 116.3 39.9 116.5 40.1
"""

SAMPLE_MAP_FILE = """Version 300
Charset "WindowsSimpChinese"

Pen (1, 2, 0)
Brush (2, 16711680, 16777215)
Symbol (34, 0, 12)
Line (1, 2, 0, 32, 2, 0, 2, 2, 0, 0)
Region (1, 2, 0, 0, 32, 2, 0, 2, 2, 0, 0)
Text (4096, 0, 0, 0)
"""


def _try_import_mapinfo_parser():
    """延迟导入 MapInfoParser，依赖缺失时 pytest.skip。"""
    try:
        from app.services.mapinfo_service import MapInfoParser
        return MapInfoParser
    except Exception as e:
        pytest.skip(f"mapinfo_service 依赖缺失，跳过: {type(e).__name__}: {str(e)[:100]}")


def _require_geopandas():
    try:
        import geopandas  # noqa: F401
    except ImportError as e:
        pytest.skip(f"geopandas 缺失，跳过: {e}")


def test_kml_abgr_to_hex():
    """KML aabbggrr → #rrggbb 颜色转换"""
    MapInfoParser = _try_import_mapinfo_parser()
    assert MapInfoParser._kml_abgr_to_hex('ff0000ff') == '#ff0000'   # 红
    assert MapInfoParser._kml_abgr_to_hex('8000ff00') == '#00ff00'   # 绿（半透明）
    assert MapInfoParser._kml_abgr_to_hex('ff00ff00') == '#00ff00'   # alpha 忽略
    assert MapInfoParser._kml_abgr_to_hex('zz') is None              # 非法
    assert MapInfoParser._kml_abgr_to_hex('') is None


def test_parse_kml_line_layer_type_and_style(tmp_path):
    """KML LineString + LineStyle → line 图层类型，_style 还原 strokeColor/strokeWidth"""
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    kml = tmp_path / "roads.kml"
    kml.write_text(SAMPLE_KML, encoding="utf-8")

    layer = MapInfoParser.parse_file(kml)
    assert layer.type.value == "line"
    # 混合几何（点+线+面）必须全部保留——GDAL KML 驱动只读首个几何类型会丢要素，
    # 自研 XML 解析应完整保留全部 Placemark
    assert len(layer.features) == 3
    assert {f.type.value for f in layer.features} == {"point", "line", "polygon"}
    # 第 0 个要素是 LineString，应带 lineStyle 的样式
    line_feat = layer.features[0]
    assert line_feat.type.value == "line"
    style = line_feat.properties.get("_style")
    assert style is not None
    assert style.get("strokeColor") == "#ff0000"
    assert style.get("strokeWidth") == 3.0
    assert style.get("strokeOpacity") == 1.0


def test_parse_kml_polygon_style(tmp_path):
    """KML Polygon + PolyStyle → polygon 图层类型，_style 还原 fillColor/fillOpacity"""
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    kml = tmp_path / "areas.kml"
    kml.write_text(SAMPLE_KML, encoding="utf-8")

    layer = MapInfoParser.parse_file(kml)
    poly_feat = layer.features[1]
    assert poly_feat.type.value == "polygon"
    style = poly_feat.properties.get("_style")
    assert style is not None
    assert style.get("fillColor") == "#00ff00"
    assert style.get("fillOpacity") == 0.5  # alpha=0x80=128


def test_parse_kml_point_style_via_stylemap(tmp_path):
    """KML Point + styleUrl→StyleMap→IconStyle → point 图层类型，_style 还原 markerColor/markerSize"""
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    kml = tmp_path / "pts.kml"
    kml.write_text(SAMPLE_KML, encoding="utf-8")

    layer = MapInfoParser.parse_file(kml)
    pt_feat = layer.features[2]
    assert pt_feat.type.value == "point"
    style = pt_feat.properties.get("_style")
    assert style is not None
    # IconStyle color=ffff0000 → #0000ff (aabbggrr: rr=00,gg=00,bb=ff)；scale=1.5 → markerSize≈12
    assert style.get("markerColor") == "#0000ff"
    assert style.get("markerSize") == 12.0


def test_parse_mif_point_symbol_style(tmp_path):
    """MIF Point + Symbol → point 图层类型，_style 还原 markerSymbol/markerColor/markerSize
    （GDAL 不暴露样式列，走 .mif 文本兜底解析）"""
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    mif = tmp_path / "pts.mif"
    mif.write_text(SAMPLE_MIF, encoding="gbk")
    (tmp_path / "pts.mid").write_text("A,1\nB,2\nC,3\n", encoding="gbk")

    layer = MapInfoParser.parse_file(mif)
    assert layer.type.value == "point"
    assert len(layer.features) == 3
    # 第一个点是 Symbol(35, 16711680, 12)：35=星形, 16711680=#0000ff, size=12
    style = layer.features[0].properties.get("_style")
    assert style is not None
    assert style.get("markerSymbol") == 35
    assert style.get("markerColor") == "#0000ff"
    assert style.get("markerSize") == 12.0
    # 第二个点 Symbol(35, 65280, 14)：65280=#00ff00
    style2 = layer.features[1].properties.get("_style")
    assert style2 is not None
    assert style2.get("markerColor") == "#00ff00"
    assert style2.get("markerSize") == 14.0
    # 第三个要素是 Line，样式为 Pen（边框）
    style3 = layer.features[2].properties.get("_style")
    assert style3 is not None
    assert style3.get("strokeColor") == "#000000"
    assert style3.get("strokeWidth") == 2.0


def test_extract_tab_map_styles_alignment(tmp_path):
    """TAB .map 样式解析：按要素顺序对齐，空样式占位不导致错位"""
    MapInfoParser = _try_import_mapinfo_parser()
    map_file = tmp_path / "test.map"
    map_file.write_text(SAMPLE_MAP_FILE, encoding="gbk")

    styles = MapInfoParser._extract_tab_map_styles(map_file)
    assert styles is not None
    # 6 个对象行：面(Pen+Brush)、点(Symbol)、线(Line)、面(Region)、文本(Text) = 5 个要素
    assert len(styles) == 5
    # 要素 0 = 面（Pen + Brush 合并）
    s0 = styles[0]
    assert s0 is not None
    assert s0.get("strokeColor") == "#000000"
    assert s0.get("fillColor") == "#0000ff"
    assert s0.get("fillBgColor") == "#ffffff"
    # 要素 1 = 点（Symbol 34=circle, 黑色, size=12）
    s1 = styles[1]
    assert s1 is not None
    assert s1.get("markerSymbol") == 34
    assert s1.get("markerColor") == "#000000"
    assert s1.get("markerSize") == 12.0
    # 要素 2-4 = 线/面/文本（无样式 → None 占位，保证与 .dat 行序对齐）
    assert styles[2] is None
    assert styles[3] is None
    assert styles[4] is None


def test_extract_mif_styles_missing_file(tmp_path):
    """MIF 样式解析：文件不存在 → None（安全回退）"""
    MapInfoParser = _try_import_mapinfo_parser()
    assert MapInfoParser._extract_mif_styles(tmp_path / "nope.mif") is None
    assert MapInfoParser._extract_mif_styles(None) is None


def test_layer_default_style_fallback_per_layer():
    """无文件自带样式时：不同图层按名称取不同默认色（同层稳定），含透明度/大小，命名规则优先"""
    MapInfoParser = _try_import_mapinfo_parser()
    from app.services.mapinfo_service import GeometryType, _palette_color

    # 同名同类型 → 颜色稳定
    a1 = MapInfoParser._get_layer_default_style("任意图层名", GeometryType.POLYGON)
    a2 = MapInfoParser._get_layer_default_style("任意图层名", GeometryType.POLYGON)
    assert a1["fillColor"] == a2["fillColor"]

    # 不同图层 → 颜色不同（20 色板中至少取到多种颜色，不全部相同）
    colors = {
        MapInfoParser._get_layer_default_style(f"layer_{i}", GeometryType.POLYGON)["fillColor"]
        for i in range(10)
    }
    assert len(colors) >= 2

    # 各几何类型的关键字段齐全（前端 MapInfoLayer 依赖这些 key 渲染）
    pt = MapInfoParser._get_layer_default_style("layer_x", GeometryType.POINT)
    ln = MapInfoParser._get_layer_default_style("layer_x", GeometryType.LINE)
    pg = MapInfoParser._get_layer_default_style("layer_x", GeometryType.POLYGON)
    assert pt["markerColor"] == pt["color"] and pt["markerSize"] == 8
    assert ln["strokeColor"] and ln["strokeWidth"] == 2 and ln["opacity"] == 0.9
    assert pg["fillColor"] == pg["strokeColor"] and pg["fillOpacity"] == 0.35

    # 命名规则仍然优先于色板（道路红 / 水域蓝）
    assert MapInfoParser._get_layer_default_style("道路图层", GeometryType.LINE)["strokeColor"] == "#ff6b6b"
    assert MapInfoParser._get_layer_default_style("河流", GeometryType.POLYGON)["fillColor"] == "#4dabf7"

    # 色板取色稳定且合法（#rrggbb）
    c = _palette_color("站点图层")
    assert c == _palette_color("站点图层")
    assert len(c) == 7 and c.startswith("#")
