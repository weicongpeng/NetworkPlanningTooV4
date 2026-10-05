"""
图层导入解析测试（tab/mif/kml）

覆盖：
- KML 图层类型识别 + <Style>/<styleUrl> 样式还原
- MIF 点要素 Symbol 样式还原（GDAL 不暴露样式列时的 .mif 文本兜底解析）
- TAB 真实样式：OGR 样式串（PEN/BRUSH/SYMBOL）→ _style 结构转换与要素对齐
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
Point 116.3 39.9
  Symbol (35, 16711680, 12)
Point 116.4 40.0
  Symbol (35, 65280, 14)
Line 116.3 39.9 116.5 40.1
  Pen (2, 2, 0)
"""

# GDAL 依据 .map 对象样式生成的 OGR 样式串（取自真实 TAB 图层，见 ogr_style_reader）
OGR_STYLE_PEN_SOLID = 'PEN(w:1px,c:#000000,id:"mapinfo-pen-2,ogr-pen-0",cap:r,j:r)'
OGR_STYLE_PEN_DASHED = 'PEN(w:1px,c:#d0e0ff,id:"mapinfo-pen-24,ogr-pen-7",p:"4 1 1 1 1px",cap:r,j:r)'
OGR_STYLE_BRUSH_HOLLOW = 'BRUSH(fc:#000000,bc:#ffffff,id:"mapinfo-brush-1,ogr-brush-1")'
OGR_STYLE_BRUSH_SOLID = 'BRUSH(fc:#a0ffff,bc:#ffffff,id:"mapinfo-brush-2,ogr-brush-0")'
OGR_STYLE_SYMBOL_FONT = 'SYMBOL(a:0,c:#ff0000,s:4pt,id:"font-sym-41,ogr-sym-9",f:"Map Symbols")'
OGR_STYLE_SYMBOL_SHAPE = 'SYMBOL(a:0,c:#0000ff,s:15pt,id:"mapinfo-sym-34,ogr-sym-3")'


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
    # 第一个点是 Symbol(35, 16711680, 12)：35=星形, 16711680=0xFF0000=红, size=12
    style = layer.features[0].properties.get("_style")
    assert style is not None
    assert style.get("markerSymbol") == 35
    assert style.get("markerColor") == "#ff0000"
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


def test_extract_tab_styles_alignment(tmp_path, monkeypatch):
    """TAB 样式解析：按要素顺序对齐，无样式要素占位 None 不导致错位"""
    MapInfoParser = _try_import_mapinfo_parser()
    from app.services import mapinfo_service

    tab_file = tmp_path / "test.tab"
    tab_file.write_text('!table\n', encoding="gbk")
    monkeypatch.setattr(
        mapinfo_service, "read_feature_style_strings",
        lambda path: [OGR_STYLE_PEN_SOLID, None, OGR_STYLE_SYMBOL_FONT],
    )

    styles = MapInfoParser._extract_tab_styles(tab_file)
    assert styles is not None
    assert len(styles) == 3
    assert styles[0]["strokeColor"] == "#000000"
    assert styles[1] is None          # 无样式要素占位
    assert styles[2]["markerColor"] == "#ff0000"


def test_extract_tab_styles_unavailable(tmp_path, monkeypatch):
    """GDAL 样式串不可用（返回 None）或文件不存在 → None（回退默认配色）"""
    MapInfoParser = _try_import_mapinfo_parser()
    from app.services import mapinfo_service

    tab_file = tmp_path / "test.tab"
    tab_file.write_text('!table\n', encoding="gbk")
    monkeypatch.setattr(mapinfo_service, "read_feature_style_strings", lambda path: None)
    assert MapInfoParser._extract_tab_styles(tab_file) is None
    assert MapInfoParser._extract_tab_styles(tmp_path / "nope.tab") is None
    assert MapInfoParser._extract_tab_styles(None) is None


def test_parse_ogr_style_string_pen():
    """OGR 样式串 PEN：实线取色/线宽，虚线图案映射 dasharray"""
    MapInfoParser = _try_import_mapinfo_parser()

    solid = MapInfoParser._parse_ogr_style_string(OGR_STYLE_PEN_SOLID)
    assert solid["stroke"] is True
    assert solid["strokeColor"] == "#000000"
    assert solid["strokeWidth"] == 1.0
    assert "strokeDasharray" not in solid

    dashed = MapInfoParser._parse_ogr_style_string(OGR_STYLE_PEN_DASHED)
    assert dashed["strokeColor"] == "#d0e0ff"
    assert dashed["strokeDasharray"]        # 图案 24 = 虚线/点划线


def test_parse_ogr_style_string_brush_pattern1_means_hollow():
    """OGR 样式串 BRUSH：图案 1 = 空心（必须显式关填充，否则 fc 的黑色会渲染成黑面）"""
    MapInfoParser = _try_import_mapinfo_parser()

    hollow = MapInfoParser._parse_ogr_style_string(OGR_STYLE_BRUSH_HOLLOW)
    assert hollow["fill"] is False
    assert hollow["fillPattern"] == 1
    assert "fillColor" not in hollow

    solid = MapInfoParser._parse_ogr_style_string(OGR_STYLE_BRUSH_SOLID)
    assert solid["fill"] is True
    assert solid["fillColor"] == "#a0ffff"
    assert solid["fillOpacity"] == 0.8
    assert "fillBgColor" not in solid       # 白色背景不写入


def test_parse_ogr_style_string_symbol():
    """OGR 样式串 SYMBOL：只取颜色/尺寸，不输出 markerSymbol（点统一用 Canvas 圆点渲染）"""
    MapInfoParser = _try_import_mapinfo_parser()

    font = MapInfoParser._parse_ogr_style_string(OGR_STYLE_SYMBOL_FONT)
    assert font["markerColor"] == "#ff0000"
    assert font["markerSize"] == 4.0
    assert "markerSymbol" not in font
    assert "markerType" not in font

    shape = MapInfoParser._parse_ogr_style_string(OGR_STYLE_SYMBOL_SHAPE)
    assert shape["markerColor"] == "#0000ff"
    assert shape["markerSize"] == 15.0
    assert "markerSymbol" not in shape


def test_parse_ogr_style_string_empty():
    """空/无法识别的样式串 → None"""
    MapInfoParser = _try_import_mapinfo_parser()
    assert MapInfoParser._parse_ogr_style_string(None) is None
    assert MapInfoParser._parse_ogr_style_string("") is None
    assert MapInfoParser._parse_ogr_style_string("FONT(f:1)") is None


def test_read_feature_style_strings_unavailable(tmp_path):
    """OGR 样式串读取：文件不存在/非矢量文件 → None（不抛异常，回退默认配色）"""
    from app.services.ogr_style_reader import read_feature_style_strings

    assert read_feature_style_strings(tmp_path / "nope.tab") is None
    junk = tmp_path / "junk.tab"
    junk.write_text("not a mapinfo file", encoding="utf-8")
    assert read_feature_style_strings(junk) is None


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


# ---------------------------------------------------------------------------
# Shapefile(.shp) / GeoJSON 导入
# ---------------------------------------------------------------------------

QML_MARKER_CATEGORIZED = """<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.28" styleCategories="Symbology">
  <renderer-v2 type="categorizedSymbol" attr="TYPE" symbollevels="0" forceraster="0">
    <categories>
      <category value="宏站" symbol="0" label="宏站" render="true"/>
      <category value="微站" symbol="1" label="微站" render="true"/>
    </categories>
    <symbols>
      <symbol name="0" type="marker" alpha="1">
        <layer class="SimpleMarker" pass="0" locked="0" enabled="1">
          <prop k="color" v="255,0,0,255"/>
          <prop k="outline_color" v="0,0,0,255"/>
          <prop k="outline_width" v="0.4"/>
          <prop k="name" v="triangle"/>
          <prop k="size" v="3"/>
          <prop k="style" v="solid"/>
        </layer>
      </symbol>
      <symbol name="1" type="marker" alpha="0.8">
        <layer class="SimpleMarker" pass="0" locked="0" enabled="1">
          <prop k="color" v="0,128,255,255"/>
          <prop k="name" v="square"/>
          <prop k="size" v="2"/>
        </layer>
      </symbol>
    </symbols>
  </renderer-v2>
</qgis>
"""

QML_FILL_SINGLE = """<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.28">
  <renderer-v2 type="singleSymbol">
    <symbols>
      <symbol name="0" type="fill" alpha="0.5">
        <layer class="SimpleFill" pass="0">
          <prop k="color" v="0,255,0,255"/>
          <prop k="outline_color" v="255,0,0,255"/>
          <prop k="outline_width" v="0.5"/>
          <prop k="style" v="solid"/>
          <prop k="outline_style" v="solid"/>
        </layer>
      </symbol>
    </symbols>
  </renderer-v2>
</qgis>
"""

QML_LINE_SINGLE = """<qgis version="3.28" xmlns="http://qgis.org/x">
  <renderer-v2 type="singleSymbol">
    <symbols>
      <symbol name="0" type="line" alpha="1">
        <layer class="SimpleLine" pass="0">
          <prop k="line_color" v="51,102,255,255"/>
          <prop k="line_width" v="0.8"/>
        </layer>
      </symbol>
    </symbols>
  </renderer-v2>
</qgis>
"""


def _write_shapefile(tmp_path, name, gdf):
    """写出 shapefile（UTF-8 + .cpg），返回 .shp 路径。"""
    shp = tmp_path / f"{name}.shp"
    gdf.to_file(shp, driver="ESRI Shapefile", encoding="utf-8")
    return shp


def test_qgis_color_conversion():
    """QGIS 颜色串（R,G,B[,A] / #hex）→ #rrggbb；完全透明返回 None"""
    MapInfoParser = _try_import_mapinfo_parser()
    assert MapInfoParser._qgis_color("255,0,0,255") == "#ff0000"
    assert MapInfoParser._qgis_color("0,128,255,255") == "#0080ff"
    assert MapInfoParser._qgis_color("0,0,0,0") is None      # 全透明
    assert MapInfoParser._qgis_color("#abcdef") == "#abcdef"
    assert MapInfoParser._qgis_color("255,0") is None        # 分量不足
    assert MapInfoParser._qgis_color("") is None
    assert MapInfoParser._qgis_color(None) is None


def test_parse_qml_categorized_marker_styles(tmp_path):
    """QGIS .qml categorizedSymbol → 按属性值逐要素配色（含点形状/大小换算）"""
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    import geopandas as gpd
    from shapely.geometry import Point

    gdf = gpd.GeoDataFrame(
        {"NAME": ["A", "B", "C"], "TYPE": ["宏站", "微站", "宏站"]},
        geometry=[Point(114.0, 22.0), Point(114.1, 22.1), Point(114.2, 22.2)],
        crs="EPSG:4326",
    )
    shp = _write_shapefile(tmp_path, "stations", gdf)
    (tmp_path / "stations.qml").write_text(QML_MARKER_CATEGORIZED, encoding="utf-8")

    layer = MapInfoParser.parse_file(shp)
    assert layer.type.value == "point"
    assert len(layer.features) == 3
    s0 = layer.features[0].properties["_style"]
    s1 = layer.features[1].properties["_style"]
    s2 = layer.features[2].properties["_style"]
    # 宏站 → 红色三角；微站 → 蓝色方块（alpha=0.8）
    assert s0["markerColor"] == "#ff0000"
    assert s0["markerSymbol"] == "triangle"
    assert s1["markerColor"] == "#0080ff"
    assert s1["markerSymbol"] == "square"
    assert s1["fillOpacity"] == 0.8
    assert s2["markerColor"] == "#ff0000"
    # QGIS size 为直径(mm) → app markerSize 为半径(px)
    assert s0["markerSize"] == pytest.approx(3 * 3.7795 / 2, abs=0.1)
    # 无 outline_color 的分类不应写入描边色
    assert s1.get("color") == "none"


def test_parse_qml_single_symbol_fill_and_line(tmp_path):
    """QGIS .qml singleSymbol：面 SimpleFill / 线 SimpleLine（含带命名空间的 qml）"""
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    import geopandas as gpd
    from shapely.geometry import LineString, Polygon

    poly = gpd.GeoDataFrame(
        {"N": [1]},
        geometry=[Polygon([(114.0, 22.0), (114.1, 22.0), (114.1, 22.1), (114.0, 22.0)])],
        crs="EPSG:4326",
    )
    shp_poly = _write_shapefile(tmp_path, "areas", poly)
    (tmp_path / "areas.qml").write_text(QML_FILL_SINGLE, encoding="utf-8")

    layer = MapInfoParser.parse_file(shp_poly)
    style = layer.features[0].properties["_style"]
    assert style["fillColor"] == "#00ff00"
    assert style["fillOpacity"] == 0.5
    assert style["strokeColor"] == "#ff0000"
    assert style["strokeWidth"] == pytest.approx(0.5 * 3.7795, abs=0.1)

    line = gpd.GeoDataFrame(
        {"N": [1]}, geometry=[LineString([(114.0, 22.0), (114.1, 22.1)])], crs="EPSG:4326"
    )
    shp_line = _write_shapefile(tmp_path, "roads", line)
    # 带 xmlns 的 .qml 同样要能解析（ElementTree 的 '{*}' 通配不匹配无命名空间标签）
    (tmp_path / "roads.qml").write_text(QML_LINE_SINGLE, encoding="utf-8")

    layer_line = MapInfoParser.parse_file(shp_line)
    s = layer_line.features[0].properties["_style"]
    assert s["strokeColor"] == "#3366ff"
    assert s["strokeWidth"] == pytest.approx(0.8 * 3.7795, abs=0.1)


def test_shapefile_crs_reprojected_to_wgs84(tmp_path):
    """带 .prj 的投影坐标系 shp → 自动重投影到 WGS84"""
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    import geopandas as gpd
    from shapely.geometry import Point

    gdf = gpd.GeoDataFrame(
        {"N": ["A"]}, geometry=[Point(500000, 2700000)], crs="EPSG:4547"
    )
    expected = gdf.to_crs(4326).geometry.iloc[0]
    shp = _write_shapefile(tmp_path, "proj", gdf)

    layer = MapInfoParser.parse_file(shp)
    x, y = layer.features[0].coordinates
    assert abs(x - expected.x) < 1e-6
    assert abs(y - expected.y) < 1e-6
    assert 113 < x < 115 and 23 < y < 25


def test_shapefile_utf8_attributes_not_mojibake(tmp_path):
    """SHP 属性按 .cpg/DBF 声明解码（不强制 GBK，避免 UTF-8 中文变乱码）"""
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    import geopandas as gpd
    from shapely.geometry import Point

    # 字段名受 DBF 10 字节上限约束（UTF-8 中文最多 3 字），此处只验证中文值解码
    gdf = gpd.GeoDataFrame(
        {"站名": ["基站A"], "PCI": [10]},
        geometry=[Point(114.0, 22.0)],
        crs="EPSG:4326",
    )
    shp = _write_shapefile(tmp_path, "cn", gdf)

    layer = MapInfoParser.parse_file(shp)
    props = layer.features[0].properties
    assert props["站名"] == "基站A"
    assert props["PCI"] == 10


def test_parse_geojson_simplestyle(tmp_path):
    """GeoJSON simplestyle-spec 属性 → _style（面 fill/stroke、点 marker-color）"""
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    import json

    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "name": "区域一",
                    "fill": "#ffcc00",
                    "fill-opacity": 0.25,
                    "stroke": "#003366",
                    "stroke-width": 3,
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[114.0, 22.0], [114.1, 22.0], [114.1, 22.1], [114.0, 22.0]]],
                },
            },
            {
                "type": "Feature",
                "properties": {"name": "点一", "marker-color": "#123456", "marker-size": "large"},
                "geometry": {"type": "Point", "coordinates": [114.05, 22.05]},
            },
        ],
    }
    gj = tmp_path / "zones.geojson"
    gj.write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")

    layer = MapInfoParser.parse_file(gj)
    assert layer.type.value == "polygon"
    assert len(layer.features) == 2

    poly = layer.features[0].properties["_style"]
    assert poly["fillColor"] == "#ffcc00"
    assert poly["fillOpacity"] == 0.25
    assert poly["strokeColor"] == "#003366"
    assert poly["strokeWidth"] == 3.0

    # 缺失字段被 pandas 补成 NaN，不得当作颜色/宽度写入 _style
    assert poly.get("markerColor") is None

    pt = layer.features[1].properties["_style"]
    assert pt["markerColor"] == "#123456"
    assert pt["markerSize"] == 14
    assert pt["color"] == "#123456"


def test_geojson_without_simplestyle_falls_back_to_default(tmp_path):
    """无 simplestyle 属性的 GeoJSON → 回退图层默认配色，且属性完整保留"""
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    import json

    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "点一"},
                "geometry": {"type": "Point", "coordinates": [114.05, 22.05]},
            }
        ],
    }
    gj = tmp_path / "plain.geojson"
    gj.write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")

    layer = MapInfoParser.parse_file(gj)
    props = layer.features[0].properties
    assert props["name"] == "点一"
    assert props["_style"] is not None  # 默认配色而非无样式


def test_looks_like_geojson_file(tmp_path):
    """layers.json 等元数据不会被当作 GeoJSON 图层"""
    from app.services.mapinfo_service import looks_like_geojson_file

    (tmp_path / "layers.json").write_text('[{"id": "x", "feature_count": 3}]', encoding="utf-8")
    (tmp_path / "ok.geojson").write_text(
        '{"type":"FeatureCollection","features":[]}', encoding="utf-8"
    )
    assert looks_like_geojson_file(tmp_path / "layers.json") is False
    assert looks_like_geojson_file(tmp_path / "ok.geojson") is True


def test_parse_directory_picks_up_shp_and_geojson(tmp_path):
    """目录解析同时覆盖 .shp 与 .geojson，且忽略配套文件与元数据 json"""
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    import geopandas as gpd
    from shapely.geometry import Point

    gdf = gpd.GeoDataFrame(
        {"N": ["A"]}, geometry=[Point(114.0, 22.0)], crs="EPSG:4326"
    )
    _write_shapefile(tmp_path, "stations", gdf)
    (tmp_path / "zones.geojson").write_text(
        '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":'
        '{"type":"Point","coordinates":[114.1,22.1]}}]}',
        encoding="utf-8",
    )
    (tmp_path / "layers.json").write_text('[]', encoding="utf-8")

    layers = MapInfoParser.parse_directory(tmp_path)
    names = sorted(l.name for l in layers)
    assert names == ["stations", "zones"]
    # .shx/.dbf/.prj/.cpg 不产生独立图层
    assert len(layers) == 2


def test_detect_file_type_new_formats():
    """新格式扩展名识别"""
    MapInfoParser = _try_import_mapinfo_parser()
    assert MapInfoParser.detect_file_type("a.shp") == "shp"
    assert MapInfoParser.detect_file_type("a.geojson") == "geojson"
    assert MapInfoParser.detect_file_type("a.json") == "json"
    assert MapInfoParser.detect_file_type("a.shx") is None
    assert MapInfoParser.detect_file_type("a.dbf") is None
    assert MapInfoParser.detect_file_type("a.prj") is None


def test_qgis_markerline_symbol_uses_marker_color(tmp_path):
    """QGIS MarkerLine（点阵列线符号）→ 取内部 SimpleMarker 的颜色作为线色"""
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    import geopandas as gpd
    from shapely.geometry import LineString

    qml = """<qgis version="3.28">
  <renderer-v2 type="singleSymbol">
    <symbols>
      <symbol name="0" type="line" alpha="1">
        <layer class="MarkerLine" pass="0">
          <prop k="interval" v="3"/>
          <symbol name="marker" type="marker">
            <layer class="SimpleMarker" pass="0">
              <prop k="color" v="255,0,255,255"/>
              <prop k="size" v="2"/>
            </layer>
          </symbol>
        </layer>
      </symbol>
    </symbols>
  </renderer-v2>
</qgis>
"""
    line = gpd.GeoDataFrame(
        {"N": [1]}, geometry=[LineString([(114.0, 22.0), (114.1, 22.1)])], crs="EPSG:4326"
    )
    shp = _write_shapefile(tmp_path, "dashed", line)
    (tmp_path / "dashed.qml").write_text(qml, encoding="utf-8")

    layer = MapInfoParser.parse_file(shp)
    style = layer.features[0].properties["_style"]
    assert style["strokeColor"] == "#ff00ff"


def test_qml_symbol_without_supported_layer_returns_none(tmp_path):
    """符号里没有受支持的图层类（如纯 MarkerLine 无内层标记）→ 返回 None 走默认配色"""
    MapInfoParser = _try_import_mapinfo_parser()
    import xml.etree.ElementTree as ET

    sym = ET.fromstring(
        '<symbol name="0" type="line"><layer class="MarkerLine"><prop k="interval" v="3"/></layer></symbol>'
    )
    assert MapInfoParser._qgis_symbol_to_style(sym) is None


def test_geojson_sparse_properties_are_json_safe(tmp_path):
    """GeoJSON 要素间字段不齐（pandas 用 NaN 补齐）→ 归一为 null，不得出现 NaN 字面量。

    回归：json.dumps 默认把 NaN 写成非法 JSON 字面量 NaN，Starlette 响应
    （allow_nan=False）会 500，浏览器 JSON.parse 直接抛错导致整层无法渲染。
    """
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    import json

    (tmp_path / "mixed.geojson").write_text(
        json.dumps({
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature", "properties": {"name": "A", "PCI": 1, "fill": "#ff0000"},
                 "geometry": {"type": "Point", "coordinates": [114.0, 22.0]}},
                {"type": "Feature", "properties": {"name": "B", "PCI": 2},
                 "geometry": {"type": "Point", "coordinates": [114.1, 22.1]}},
            ],
        }, ensure_ascii=False),
        encoding="utf-8",
    )

    layer = MapInfoParser.parse_file(tmp_path / "mixed.geojson")
    # 缺失字段归一为 None（而非 NaN）
    assert layer.features[1].properties["fill"] is None
    # 整层可被严格 JSON 编码（allow_nan=False 等价 Starlette JSONResponse）
    json.dumps([f.properties for f in layer.features], ensure_ascii=False, allow_nan=False)


def test_shapefile_empty_dbf_value_is_json_safe(tmp_path):
    """SHP 空 DBF 数值字段 → None，不得写出 NaN 字面量"""
    _require_geopandas()
    MapInfoParser = _try_import_mapinfo_parser()
    import json
    import geopandas as gpd
    from shapely.geometry import Point

    gdf = gpd.GeoDataFrame(
        {"名称": ["A", "B"], "PCI": [1, None]},
        geometry=[Point(114.0, 22.0), Point(114.1, 22.1)],
        crs="EPSG:4326",
    )
    shp = _write_shapefile(tmp_path, "nulls", gdf)

    layer = MapInfoParser.parse_file(shp)
    assert layer.features[1].properties["PCI"] is None
    json.dumps([f.properties for f in layer.features], ensure_ascii=False, allow_nan=False)


def test_json_safe_value_normalizes_pandas_types():
    """_json_safe_value：NaN/NaT/±Inf → None；Timestamp → ISO；numpy 标量 → 原生"""
    MapInfoParser = _try_import_mapinfo_parser()
    import pandas as pd

    f = MapInfoParser._json_safe_value
    assert f(float("nan")) is None
    assert f(float("inf")) is None
    assert f(float("-inf")) is None
    assert f(pd.NaT) is None
    assert f(pd.Timestamp("2020-01-01")) == "2020-01-01T00:00:00"
    assert f("s") == "s"
    assert f(5) == 5
    assert f(None) is None
    assert f(True) is True
