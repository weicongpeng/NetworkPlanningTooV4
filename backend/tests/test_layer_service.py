"""
图层制作服务测试
遵循TDD方法论: RED → GREEN → REFACTOR
"""
import pytest
import pandas as pd
from pathlib import Path
from app.services.layer_service import (
    fast_destination,
    sector_polygon,
    LayerService,
)

SAMPLE_DATA = {
    "NAME": ["CellA", "CellB"],
    "LONGITUDE": [116.3, 116.4],
    "LATITUDE": [39.9, 40.0],
    "AZIMUTH": [0.0, 120.0],
    "PCI": [100, 200],
}


@pytest.fixture
def sample_excel(tmp_path: Path) -> Path:
    """创建包含经纬度/方位角的示例 Excel"""
    path = tmp_path / "sample.xlsx"
    df = pd.DataFrame(SAMPLE_DATA)
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    return path


@pytest.fixture
def service(tmp_path: Path) -> LayerService:
    return LayerService(output_dir=tmp_path)


def test_fast_destination_returns_expected_offset():
    """测试 Flat-Earth 终点计算"""
    lat, lng = fast_destination(39.9, 116.3, azimuth_deg=0.0, distance_m=1000)
    # 正北方向 1000m ≈ 0.00898 纬度（111319.9 m/度）
    assert abs(lat - 39.9 - 1000 / 111319.9) < 1e-5
    assert abs(lng - 116.3) < 1e-5


def test_sector_polygon_geometry():
    """测试扇形多边形：含中心点、包含在半径圆内"""
    poly = sector_polygon(39.9, 116.3, azimuth=0.0, beamwidth=40.0, radius_m=1000)
    assert poly.geom_type == "Polygon"
    assert poly.area > 0
    from shapely.geometry import Point
    center = Point(116.3, 39.9)
    assert poly.distance(center) < 1000 / 111319.9 * 1.1


def test_generate_point_layer(service, sample_excel):
    """生成点图层并断言可读回"""
    result, _ = service.generate_point_layer(
        file_path=str(sample_excel),
        sheet_name="LTE",
        name_col="NAME",
        lon_col="LONGITUDE",
        lat_col="LATITUDE",
        attributes=["NAME", "PCI"],
        output_format="tab",
    )
    assert result.exists()
    import geopandas as gpd
    gdf = gpd.read_file(result)
    assert len(gdf) == 2
    assert list(gdf.columns) == ["NAME", "PCI", "geometry"]
    assert gdf.crs.to_epsg() == 4326


def test_verify_readable_rejects_corrupt(service, tmp_path):
    """读回验证：损坏文件 → 抛 ValueError"""
    out = tmp_path / "bad.tab"
    out.write_text("!table\n!version 300\n", encoding="gbk")  # 缺字段定义
    with pytest.raises(ValueError, match="校验失败"):
        service._verify_readable(out, 1, "tab")


def test_verify_readable_rejects_wrong_count(service, sample_excel):
    """读回验证：行数与期望不一致 → 抛「读回行数不一致」ValueError"""
    out, stats = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME", "PCI"], output_format="tab",
    )
    assert stats["success"] == 2
    # 正确行数 → 不抛错
    service._verify_readable(out, 2, "tab")
    # 错误行数 → 抛「读回行数不一致」
    with pytest.raises(ValueError, match="读回行数不一致"):
        service._verify_readable(out, 99, "tab")


def test_verify_readable_mif_fallback_ok(service, sample_excel):
    """读回验证：MIF 驱动 read_info 返回 -1 → 回退实际读取统计行数，正确行数通过"""
    out, stats = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME", "PCI"], output_format="mif",
    )
    assert stats["success"] == 2
    service._verify_readable(out, 2, "mif")   # -1 回退成功路径
    with pytest.raises(ValueError, match="读回行数不一致"):
        service._verify_readable(out, 99, "mif")


def test_verify_readable_kml_counts_placemarks(service, sample_excel):
    """读回验证：KML 解析后统计 Placemark 数量与期望行数比对"""
    out, stats = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME", "PCI"], output_format="kml",
    )
    assert stats["success"] == 2
    service._verify_readable(out, 2, "kml")
    with pytest.raises(ValueError, match="读回行数不一致"):
        service._verify_readable(out, 99, "kml")


def test_generate_point_layer_readback_ok(service, sample_excel):
    """生成后读回验证通过：行数 = 成功数"""
    out, stats = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME", "PCI"], output_format="tab",
    )
    assert stats["success"] == 2
    # 生成流程内部已调用 _verify_readable，未抛错即通过
    assert out.exists()


def test_generate_sector_layer(service, sample_excel):
    """生成扇区图层并断言几何为多边形"""
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel),
        sheet_name="LTE",
        name_col="NAME",
        lon_col="LONGITUDE",
        lat_col="LATITUDE",
        azimuth_col="AZIMUTH",
        radius_m=3000,
        beamwidth=40.0,
        attributes=["NAME", "PCI"],
        output_format="mif",
    )
    assert result.exists()
    import geopandas as gpd
    gdf = gpd.read_file(result)
    assert len(gdf) == 2
    assert all(g.geom_type == "Polygon" for g in gdf.geometry)


def test_generate_sector_layer_kml(service, sample_excel):
    """扇区图层输出 KML 格式"""
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel),
        sheet_name="LTE",
        name_col="NAME",
        lon_col="LONGITUDE",
        lat_col="LATITUDE",
        azimuth_col="AZIMUTH",
        radius_m=3000,
        beamwidth=40.0,
        attributes=["NAME"],
        output_format="kml",
    )
    assert result.exists()
    assert result.suffix == ".kml"
    content = result.read_text(encoding="utf-8")
    assert "<kml" in content.lower()


def test_all_rows_invalid_raises(service, tmp_path):
    """所有行坐标无效 → 仍抛 ValueError（success=0）"""
    path = tmp_path / "bad.xlsx"
    df = pd.DataFrame({"NAME": ["X"], "LONGITUDE": [999], "LATITUDE": [999]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="S", index=False)
    with pytest.raises(ValueError, match="校验失败"):
        service.generate_point_layer(
            file_path=str(path), sheet_name="S",
            name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
            attributes=["NAME"], output_format="tab",
        )


def test_read_sheet_uses_calamine_engine(service, sample_excel, monkeypatch):
    """断言 _read_sheet 显式使用 calamine engine（支持 .xls 无 xlrd）"""
    captured = {}

    def fake_read_excel(*args, **kwargs):
        captured["engine"] = kwargs.get("engine")
        captured["sheet_name"] = kwargs.get("sheet_name")
        return pd.DataFrame(SAMPLE_DATA)

    monkeypatch.setattr("app.services.layer_service.pd.read_excel", fake_read_excel)
    df = service._read_sheet(str(sample_excel), "LTE")
    assert captured["engine"] == "calamine"
    assert captured["sheet_name"] == "LTE"
    assert len(df) == 2


def test_empty_attributes_raises(service, sample_excel):
    """空属性列表应抛 ValueError（避免仅 FID+geometry 的无意义输出）"""
    with pytest.raises(ValueError, match="属性列"):
        service.generate_point_layer(
            file_path=str(sample_excel), sheet_name="LTE",
            name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
            attributes=[], output_format="tab",
        )


def test_non_existent_attribute_raises(service, sample_excel):
    """属性列在数据中不存在应抛 ValueError"""
    with pytest.raises(ValueError, match="属性列"):
        service.generate_point_layer(
            file_path=str(sample_excel), sheet_name="LTE",
            name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
            attributes=["NOT_A_COLUMN"], output_format="tab",
        )


def test_all_zero_azimuth_raises(service, tmp_path):
    """全零方位角列应抛 ValueError（避免扇区退化为朝北楔形）"""
    path = tmp_path / "zero_azi.xlsx"
    df = pd.DataFrame({
        "NAME": ["A", "B"],
        "LONGITUDE": [116.3, 116.4],
        "LATITUDE": [39.9, 40.0],
        "AZIMUTH": [0.0, 0.0],
    })
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    with pytest.raises(ValueError, match="方位角"):
        service.generate_sector_layer(
            file_path=str(path), sheet_name="LTE",
            name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
            azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
            attributes=["NAME"], output_format="mif",
        )


def test_mif_point_color_injected(service, sample_excel):
    """点 MIF + 颜色 → Symbol 颜色替换为 MapInfo 十进制 RGB，且可读回"""
    result, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="mif", color="#4A90D9",
    )
    assert result.suffix == ".mif"
    text = result.read_text(encoding="utf-8", errors="replace")
    assert "Symbol (34,4886745," in text
    import geopandas as gpd
    gdf = gpd.read_file(result)
    assert len(gdf) == 2


def test_mif_sector_color_injected(service, sample_excel):
    """扇区 MIF + 颜色 → Brush 颜色替换，且可读回"""
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="mif", color="#4A90D9",
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    assert "Brush (" in text
    assert "4886745" in text
    import geopandas as gpd
    gdf = gpd.read_file(result)
    assert len(gdf) == 2
    assert all(g.geom_type == "Polygon" for g in gdf.geometry)


def test_kml_point_color_injected(service, sample_excel):
    """点 KML + 颜色 → IconStyle color 为 aabbggrr，且可读回"""
    result, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="kml", color="#4A90D9",
    )
    assert result.suffix == ".kml"
    text = result.read_text(encoding="utf-8", errors="replace")
    assert "<color>ffd9904a</color>" in text
    import geopandas as gpd
    gdf = gpd.read_file(result)
    assert len(gdf) == 2


def test_kml_sector_color_injected(service, sample_excel):
    """扇区 KML + 颜色 → LineStyle(边框)+PolyStyle(fill,outline=1)，且可读回"""
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="kml",
        border_color="#4A90D9", fill_color="#4A90D9",
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    # 边框 LineStyle + 填充 PolyStyle（opacity 默认 1 → ff）
    assert "<LineStyle><color>ffd9904a</color>" in text
    assert "<PolyStyle><color>ffd9904a</color>" in text
    assert "<fill>1</fill>" in text
    assert "<outline>1</outline>" in text
    import geopandas as gpd
    gdf = gpd.read_file(result)
    assert len(gdf) == 2


def test_tab_color_ignored(service, sample_excel):
    """TAB + 颜色 → 正常生成（不注入，不报错）"""
    result, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="tab", color="#4A90D9",
    )
    assert result.exists()
    assert result.suffix == ".tab"


def test_invalid_color_ignored(service, sample_excel):
    """非法颜色 → 不注入，文件正常生成"""
    result, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="mif", color="zzz",
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    assert "Symbol (35,0,12)" in text  # 保持默认颜色
    assert "4886745" not in text


def test_mif_sector_border_and_fill_colors(service, sample_excel):
    """扇区 MIF：Pen 颜色=边框色，Brush 前景=填充色（互不相同）"""
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="mif",
        border_color="#000000", fill_color="#FF0000",
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    assert "Pen (2,2,0)" in text        # 黑色边框 = MapInfo 十进制 0，线宽默认 2 进 width 位、pattern 保留 GDAL 2
    assert "Brush (2,16711680," in text  # 红色填充 = 65536*255，pattern=2 实心填充（pattern=1 无填充会空白）
    import geopandas as gpd
    gdf = gpd.read_file(result)
    assert len(gdf) == 2


def test_mif_sector_fill_pattern_is_solid(service, sample_excel):
    """扇区 MIF 填充必须用实心 pattern=2（GDAL 默认 pattern=1 无填充，
    设置填充色仍空白；pattern=2 才显示填充色）"""
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="mif",
        border_color="#000000", fill_color="#FF0000",
    )
    text = result.read_text(encoding="gbk", errors="replace")
    assert "Brush (2,16711680," in text
    assert "Brush (1," not in text   # 绝不再出现无填充 pattern=1


def test_mif_sector_opacity_uses_sparse_pattern(service, sample_excel):
    """扇区 MIF 透明度：官方规范认可方式 = pattern≥3 且省略 backcolor（透明填充）。
    MIF 无 alpha 通道，用稀疏大颗粒 pattern（12-14）+ 省略 backcolor 实现半透明，
    视觉是透过稀疏点阵看到底下内容（非颜色变浅、非密集网格）。
    opacity=0 → 实心 pattern=2 保留 backcolor；opacity>0 → 稀疏 pattern 省略 backcolor。"""
    # opacity=0 → 实心不透明（pattern=2，保留 backcolor）
    r0, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="mif",
        border_color="#000000", fill_color="#FF0000", opacity=0.0,
    )
    t0 = r0.read_text(encoding="gbk", errors="replace")
    assert "Brush (2,16711680,16777215)" in t0   # 实心 + 原色 + backcolor（不透明）

    # opacity=0.5 → 稀疏 pattern（>2）且省略 backcolor → "Brush (<pattern>,16711680)"
    r5, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="mif",
        border_color="#000000", fill_color="#FF0000", opacity=0.5,
    )
    t5 = r5.read_text(encoding="gbk", errors="replace")
    import re
    brush5 = re.search(r'Brush \((\d+),(\d+)(?:,(\d+))?\)', t5)
    assert brush5, f"未找到 Brush: {t5[:200]}"
    pat5 = int(brush5.group(1))
    assert pat5 > 2 and pat5 != 1, f"半透明应使用非实心稀疏 pattern>2，实际 {pat5}"
    assert brush5.group(3) is None, f"透明填充应省略 backcolor，实际 {brush5.group(0)}"
    assert int(brush5.group(2)) == 16711680   # 填充色不变（#FF0000）

    # opacity=1 → 更稀疏 pattern（透明度越高，颗粒越稀）
    r1, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="mif",
        border_color="#000000", fill_color="#FF0000", opacity=1.0,
    )
    t1 = r1.read_text(encoding="gbk", errors="replace")
    brush1 = re.search(r'Brush \((\d+),(\d+)(?:,(\d+))?\)', t1)
    assert brush1 and int(brush1.group(1)) > 2
    assert brush1.group(3) is None
    # 透明度 1.0 的 pattern 应比 0.5 更稀疏（pattern 编号更靠近稀疏端）
    assert int(brush1.group(1)) < pat5, f"透明度越高应越稀疏，实际 {brush1.group(1)} > {pat5}"


def test_kml_sector_opacity_applied(service, sample_excel):
    """扇区 KML：透明度语义（0=不透明、1=全透明）下 transparency=0.5 → alpha=80 (128)"""
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="kml",
        border_color="#FF0000", fill_color="#00FF00", opacity=0.5,
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    # 红色 #FF0000 → KML 边框 800000ff；绿色 #00FF00 → 填充 8000ff00（alpha=(1-0.5)*255=128）
    assert "<LineStyle><color>800000ff</color>" in text
    assert "<PolyStyle><color>8000ff00</color>" in text
    import xml.etree.ElementTree as ET
    root = ET.fromstring(text)  # XML 仍合法


def test_kml_point_opacity_applied(service, sample_excel):
    """点 KML：透明度语义（0=不透明、1=全透明）下 transparency=0.5 → alpha=80"""
    result, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="kml",
        border_color="#FF0000", opacity=0.5,
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    assert "<IconStyle><color>800000ff</color>" in text
    import xml.etree.ElementTree as ET
    root = ET.fromstring(text)  # XML 仍合法


def test_kml_sector_opacity_semantics(service, sample_excel):
    """透明度语义：0=不透明(alpha=ff)、1=全透明(alpha=00)"""
    # opacity=0 → transparency=0 → alpha=255=ff（不透明）
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="kml",
        border_color="#FF0000", fill_color="#00FF00", opacity=0.0,
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    assert "<LineStyle><color>ff0000ff</color>" in text   # alpha=ff
    assert "<PolyStyle><color>ff00ff00</color>" in text
    # opacity=1 → transparency=1 → alpha=0=00（全透明）
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="kml",
        border_color="#FF0000", fill_color="#00FF00", opacity=1.0,
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    assert "<LineStyle><color>000000ff</color>" in text   # alpha=00
    assert "<PolyStyle><color>0000ff00</color>" in text


def test_kml_name_col_uses_cell_id(service, sample_excel):
    """KML name_col 生效：name_col=CELL_ID 时 <name> 取该列值"""
    result, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME", "PCI"], output_format="kml",
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    assert "<name>CellA</name>" in text
    assert "<name>CellB</name>" in text


def test_kml_color_inline_xml_valid(service, sample_excel):
    """扇区 KML 样式注入后 XML 合法：每个 Placemark 恰好一个 Style，含 LineStyle+PolyStyle"""
    import xml.etree.ElementTree as ET
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="kml",
        border_color="#4A90D9", fill_color="#4A90D9",
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    # XML 可解析
    root = ET.fromstring(text)
    ns = {"kml": "http://www.opengis.net/kml/2.2"}
    placemarks = root.findall(".//kml:Placemark", ns)
    assert len(placemarks) == 2
    for pm in placemarks:
        # 每个 Placemark 恰好一个 Style（KML schema 只允许一个）
        styles = pm.findall("kml:Style", ns)
        assert len(styles) == 1, f"每个 Placemark 应恰好一个 Style，实际 {len(styles)}"
        style = styles[0]
        line_style = style.find("kml:LineStyle", ns)
        assert line_style is not None
        line_color = line_style.find("kml:color", ns)
        assert line_color is not None
        assert line_color.text == "ffd9904a"
        poly_style = style.find("kml:PolyStyle", ns)
        assert poly_style is not None
        color_el = poly_style.find("kml:color", ns)
        assert color_el is not None
        assert color_el.text == "ffd9904a"


def test_output_filename_uses_source_and_sheet(tmp_path):
    """导出文件名 = 源文件名 + sheet 名 + 图层类型标记（去 uuid）"""
    path = tmp_path / "工参2026.xlsx"
    df = pd.DataFrame({
        "NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9],
    })
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    svc = LayerService(output_dir=tmp_path)
    out, _ = svc.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="tab",
    )
    assert out.stem == "工参2026_LTE_point"
    assert out.suffix == ".tab"


def test_sector_point_output_names_distinct(tmp_path):
    """扇区与点图同源同 sheet → 文件名不同（_sector/_point），互不覆盖"""
    path = tmp_path / "src.xlsx"
    df = pd.DataFrame({
        "NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9],
        "AZIMUTH": [90.0],
    })
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    svc = LayerService(output_dir=tmp_path)
    p_out, _ = svc.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="tab",
    )
    s_out, _ = svc.generate_sector_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="tab",
    )
    assert p_out.name != s_out.name
    assert p_out.stem.endswith("_point")
    assert s_out.stem.endswith("_sector")
    # 两个文件都各自存在（未被清理）
    assert p_out.exists()
    assert s_out.exists()


def test_source_filename_param_honored(tmp_path):
    """显式传 source_filename → 输出文件名以它开头（覆盖从 file_path 推导，应对 _save_upload 重命名）"""
    path = tmp_path / "src_abcd1234.xlsx"
    pd.DataFrame({
        "NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9],
    }).to_excel(path, sheet_name="LTE", index=False)
    svc = LayerService(output_dir=tmp_path)
    out, _ = svc.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="tab",
        source_filename="工参2026.xlsx",
    )
    assert out.stem == "工参2026_LTE_point"


def test_long_chinese_filename_truncated(tmp_path):
    """超长中文文件名（80 字=240 字节）+ 长 sheet → 旧 char 截断产出的 >255 字节文件名会 OSError。
    修复后按字节截断，不崩溃，输出文件名在 ext4 255 字节内。"""
    long_name = "工" * 80  # 240 字节 stem；+ .xlsx 扩展名 = 245 字节，文件可创建（NAME_MAX=255）
    path = tmp_path / f"{long_name}.xlsx"
    pd.DataFrame({
        "NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9],
    }).to_excel(path, sheet_name="长" * 10, index=False)  # sheet 名 30 字节
    svc = LayerService(output_dir=tmp_path)
    out, _ = svc.generate_point_layer(
        file_path=str(path), sheet_name="长" * 10,
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="tab",
    )
    assert out.exists()
    # ext4 255 字节限制
    assert len(out.name.encode("utf-8")) < 255
    # 输出文件名以被截断的源文件名前缀开头，并保留完整 sheet 名
    assert out.stem.startswith("工")
    assert "长" * 10 in out.stem


def test_sheet_name_illegal_chars_sanitized(tmp_path):
    """sheet 名含非法字符（Excel 允许的 <>）→ 输出文件名中替换为 _"""
    path = tmp_path / "源数据.xlsx"
    pd.DataFrame({
        "NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9],
    }).to_excel(path, sheet_name="LTE<NR>", index=False)
    svc = LayerService(output_dir=tmp_path)
    out, _ = svc.generate_point_layer(
        file_path=str(path), sheet_name="LTE<NR>",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="tab",
    )
    assert out.stem.startswith("源数据_LTE_")
    assert "LTE" in out.stem and "NR" in out.stem
    assert "<" not in out.stem and ">" not in out.stem


def test_row_validation_skips_invalid_rows_and_reports_stats(service, tmp_path):
    """部分无效行 → 跳过无效行不阻断，返回 stats 统计"""
    path = tmp_path / "mixed.xlsx"
    df = pd.DataFrame({
        "NAME": ["A", "B", "C", "D", "E"],
        "LONGITUDE": [116.3, None, 999, 116.4, 116.5],   # B缺坐标 C超范围
        "LATITUDE": [39.9, 39.8, 39.7, 40.0, 40.1],
        "PCI": [1, 2, 3, 4, None],
    })
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, stats = service.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME", "PCI"], output_format="tab",
    )
    assert stats["total"] == 5
    assert stats["success"] == 3        # A, D, E 通过
    assert stats["failed"] == 2
    assert stats["failures"]["missing_coord"] == 1   # B
    assert stats["failures"]["invalid_coord"] == 1   # C
    import geopandas as gpd
    gdf = gpd.read_file(out)
    assert len(gdf) == 3


def test_sector_azimuth_validation_stats(service, tmp_path):
    """扇区方位角无效行被跳过并计入 invalid_azimuth"""
    path = tmp_path / "azi.xlsx"
    df = pd.DataFrame({
        "NAME": ["A", "B"],
        "LONGITUDE": [116.3, 116.4],
        "LATITUDE": [39.9, 40.0],
        "AZIMUTH": [120.0, 500.0],     # B 方位角无效
    })
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, stats = service.generate_sector_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=50, beamwidth=50,
        attributes=["NAME"], output_format="tab",
    )
    assert stats["total"] == 2
    assert stats["success"] == 1
    assert stats["failed"] == 1
    assert stats["failures"]["invalid_azimuth"] == 1


def test_tab_chinese_fields_readable(service, tmp_path):
    """中文列名+中文值 → TAB 输出回读完整（字段名与值均中文）"""
    path = tmp_path / "工参.xlsx"
    df = pd.DataFrame({"小区名称": ["基站A"], "经度": [116.4], "纬度": [39.9]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, _ = service.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="小区名称", lon_col="经度", lat_col="纬度",
        attributes=["小区名称"], output_format="tab",
    )
    import geopandas as gpd
    gdf = gpd.read_file(out)
    assert "小区名称" in gdf.columns
    assert gdf["小区名称"].tolist() == ["基站A"]
    tab = out.read_text(encoding="gbk", errors="replace")
    assert "WindowsSimpChinese" in tab


def test_mif_chinese_fields_readable(service, tmp_path):
    """中文列名+值 → MIF 输出回读完整"""
    path = tmp_path / "工参.xlsx"
    df = pd.DataFrame({"小区名称": ["基站A"], "经度": [116.4], "纬度": [39.9]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, _ = service.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="小区名称", lon_col="经度", lat_col="纬度",
        attributes=["小区名称"], output_format="mif",
    )
    import geopandas as gpd
    gdf = gpd.read_file(out)
    assert "小区名称" in gdf.columns
    assert gdf["小区名称"].tolist() == ["基站A"]
    mif = out.read_text(encoding="gbk", errors="replace")
    assert "WindowsSimpChinese" in mif


def test_mapinfo_field_name_sanitized(service, tmp_path):
    """含空格列名（SITE ID/CELL ID）→ TAB 生成后可读，字段名转下划线"""
    path = tmp_path / "工参.xlsx"
    df = pd.DataFrame({"SITE ID": ["A"], "CELL ID": ["B"], "经度": [116.4], "纬度": [39.9]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, _ = service.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="SITE ID", lon_col="经度", lat_col="纬度",
        attributes=["SITE ID", "CELL ID"], output_format="tab",
    )
    import geopandas as gpd
    gdf = gpd.read_file(out)  # 修复前：Failed to parse field definition
    assert "SITE_ID" in gdf.columns
    assert "CELL_ID" in gdf.columns


def test_mapinfo_field_name_dedupe(service, tmp_path):
    """清洗后重名（SITE ID 与 SITE_ID）且与合成名 SITE_ID_2 碰撞
    → 自动加序号去重（SITE_ID_2_2），不崩溃、无重复字段名"""
    path = tmp_path / "d.xlsx"
    df = pd.DataFrame({
        "SITE ID": ["A"], "SITE_ID": ["B"], "SITE_ID_2": ["C"],
        "经度": [116.4], "纬度": [39.9],
    })
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, _ = service.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="SITE ID", lon_col="经度", lat_col="纬度",
        attributes=["SITE ID", "SITE_ID", "SITE_ID_2"], output_format="tab",
    )
    import geopandas as gpd
    gdf = gpd.read_file(out)
    # 精确断言：第三个字段避开已占用的 SITE_ID_2，改为 SITE_ID_2_2
    assert list(gdf.columns) == ["SITE_ID", "SITE_ID_2", "SITE_ID_2_2", "geometry"]
    # 无重复字段名（MapInfo Pro 拒绝重复字段名）
    fields = [c for c in gdf.columns if c != "geometry"]
    assert len(fields) == len(set(fields)) == 3


def test_cleanup_old_outputs_removes_history(tmp_path):
    """_cleanup_old_outputs 删除同 base 历史输出（含 -1/-2 后缀），保留其它 base"""
    svc = LayerService(output_dir=tmp_path)
    # 预置同 base 历史 + 另一 base 文件 + 源 Excel
    (tmp_path / "源_LTE.tab").write_text("x")
    (tmp_path / "源_LTE.dat").write_text("x")
    (tmp_path / "源_LTE-1.tab").write_text("x")
    (tmp_path / "源_LTE-1.zip").write_text("x")
    (tmp_path / "其他_LTE.tab").write_text("x")   # 不同 base，不应删
    svc._cleanup_old_outputs("源_LTE")
    assert not (tmp_path / "源_LTE.tab").exists()
    assert not (tmp_path / "源_LTE.dat").exists()
    assert not (tmp_path / "源_LTE-1.tab").exists()
    assert not (tmp_path / "源_LTE-1.zip").exists()
    assert (tmp_path / "其他_LTE.tab").exists()    # 不同 base 保留


def test_cleanup_old_outputs_removes_kml_history(tmp_path):
    """_cleanup_old_outputs 补删 .kml 历史（-1/-2 后缀）"""
    svc = LayerService(output_dir=tmp_path)
    (tmp_path / "源_LTE-1.kml").write_text("x")
    (tmp_path / "源_LTE-2.kml").write_text("x")
    svc._cleanup_old_outputs("源_LTE")
    assert not (tmp_path / "源_LTE-1.kml").exists()
    assert not (tmp_path / "源_LTE-2.kml").exists()


def test_read_text_csv_gbk(service, tmp_path):
    """GBK 编码 csv → 自动编码回退读取，列名/值完整"""
    path = tmp_path / "工参.csv"
    raw = "小区名称,经度,纬度\n基站A,116.4,39.9\n".encode("gbk")
    path.write_bytes(raw)
    df = service._read_sheet(str(path), "默认")
    assert "小区名称" in df.columns
    assert df["小区名称"].tolist() == ["基站A"]


def test_read_text_txt_tab(service, tmp_path):
    """制表符分隔 txt → 自动探测分隔符读取"""
    path = tmp_path / "工参.txt"
    raw = "小区名称\t经度\t纬度\n基站B\t116.5\t40.0\n".encode("utf-8")
    path.write_bytes(raw)
    df = service._read_sheet(str(path), "默认")
    assert "小区名称" in df.columns
    assert df["小区名称"].tolist() == ["基站B"]


def test_get_sheet_info_txt_returns_default(service, tmp_path):
    """txt/csv 的 get_sheet_info 返回 sheets=['默认']"""
    path = tmp_path / "工参.csv"
    raw = "小区名称,经度,纬度\n基站A,116.4,39.9\n".encode("utf-8")
    path.write_bytes(raw)
    info = service.get_sheet_info(str(path))
    assert info["sheets"] == ["默认"]
    assert "小区名称" in info["columns"]["默认"]


def test_failed_details_in_stats(service, tmp_path):
    """stats.failedDetails 含失败行（row/name/reason）"""
    path = tmp_path / "mixed.xlsx"
    df = pd.DataFrame({
        "NAME": ["A", "B", "C"],
        "LONGITUDE": [116.3, None, 999],
        "LATITUDE": [39.9, 39.8, 39.7],
    })
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, stats = service.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="tab",
    )
    assert stats["failed"] == 2
    details = stats["failedDetails"]
    assert len(details) == 2
    reasons = {d["name"]: d["reason"] for d in details}
    assert reasons["B"] == "missing_coord"
    assert reasons["C"] == "invalid_coord"
    for d in details:
        assert d["row"] in (3, 4)   # 表头 1 + 数据行索引 + 1


def test_failed_details_in_sector_stats(service, tmp_path):
    """扇区失败明细含方位角无效"""
    path = tmp_path / "azi.xlsx"
    df = pd.DataFrame({
        "NAME": ["A", "B"],
        "LONGITUDE": [116.3, 116.4],
        "LATITUDE": [39.9, 40.0],
        "AZIMUTH": [120.0, 500.0],
    })
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    out, stats = service.generate_sector_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=50, beamwidth=50,
        attributes=["NAME"], output_format="tab",
    )
    assert stats["failed"] == 1
    assert stats["failedDetails"][0]["name"] == "B"
    assert stats["failedDetails"][0]["reason"] == "invalid_azimuth"


def test_kml_sector_line_width(service, sample_excel):
    """扇区 KML + line_width → LineStyle width"""
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="kml",
        border_color="#4A90D9", fill_color="#4A90D9", line_width=4,
    )
    text = result.read_text(encoding="utf-8")
    assert "<width>4</width>" in text


def test_mif_sector_line_width(service, sample_excel):
    """扇区 MIF + line_width → Pen 第3参数"""
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="mif",
        border_color="#4A90D9", fill_color="#4A90D9", line_width=4,
    )
    text = result.read_text(encoding="gbk", errors="replace")
    assert "Pen (4,2,4886745)" in text


def test_kml_point_icon_injected(service, sample_excel):
    """点 KML + 形状/大小 → IconStyle 含 Icon/href(SVG Data URI) 和 scale"""
    result, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="kml",
        border_color="#FF0000", point_shape="square", point_size=12,
    )
    text = result.read_text(encoding="utf-8")
    assert "data:image/svg+xml," in text
    assert "<Icon><href>" in text
    assert "<scale>0.90</scale>" in text  # 12/8*0.6=0.9
    import xml.etree.ElementTree as ET
    root = ET.fromstring(text)  # XML 合法


def test_mif_point_shape_applied(service, sample_excel):
    """点 MIF + 形状/大小 → Symbol (shape, color, size)"""
    result, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="mif",
        border_color="#FF0000", point_shape="square", point_size=10,
    )
    text = result.read_text(encoding="gbk", errors="replace")
    assert "Symbol (32,16711680,10)" in text  # square=32, 红色, size=10


def test_kml_point_scale_default(service, sample_excel):
    """点 KML 无 point_size → scale 默认 1.00"""
    result, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="kml",
        border_color="#4A90D9",
    )
    text = result.read_text(encoding="utf-8")
    assert "<scale>1.00</scale>" in text


def test_kml_opacity_nan_safe(service, sample_excel):
    """透明度 NaN/非法 → 不抛错，KML 正常生成（回退不注入该样式颜色或跳过）"""
    # NaN opacity 不应使 round() 抛 ValueError
    out, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="kml",
        border_color="#4A90D9", opacity=float("nan"),
    )
    assert out.exists()
    text = out.read_text(encoding="utf-8")
    assert "<kml" in text.lower()
    import xml.etree.ElementTree as ET
    ET.fromstring(text)  # XML 合法


def test_mif_sector_pen_parameter_order(service, sample_excel):
    """扇区 MIF Pen 参数顺序：(width, pattern, color)，颜色进 color 位、线宽进 width 位。
    白色边框 #FFFFFF=16777215 不应进入 pattern 位（0-71），否则 MapInfo 报 Invalid stylevalue"""
    result, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="mif",
        border_color="#FFFFFF", fill_color="#4A90D9", line_width=4,
    )
    text = result.read_text(encoding="gbk", errors="replace")
    # Pen (width=4, pattern=2(GDAL默认), color=16777215) —— 颜色在第三位
    assert "Pen (4,2,16777215)" in text
    # pattern 位绝不出现颜色值（<=71）
    import re
    for m in re.finditer(r'Pen \((\d+),(\d+),(\d+)\)', text):
        assert int(m.group(2)) <= 71, f"pattern 位越界: {m.group(0)}"


def test_mif_point_shape_codes_corrected(service, sample_excel):
    """点形状符号编号纠正：circle=34、square=32、diamond=33"""
    # circle
    r1, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="mif",
        border_color="#FF0000", point_shape="circle", point_size=10,
    )
    assert "Symbol (34,16711680,10)" in r1.read_text(encoding="gbk", errors="replace")
    # square
    r2, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="mif",
        border_color="#FF0000", point_shape="square", point_size=10,
    )
    assert "Symbol (32,16711680,10)" in r2.read_text(encoding="gbk", errors="replace")
    # diamond
    r3, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="mif",
        border_color="#FF0000", point_shape="diamond", point_size=10,
    )
    assert "Symbol (33,16711680,10)" in r3.read_text(encoding="gbk", errors="replace")


# ============================================================
# MapInfo .tab charset 规范化（修复电联扇区图层 zip 无法显示问题）
# ============================================================

def _try_import_mapinfo_parser():
    """延迟导入 MapInfoParser，依赖缺失时 pytest.skip。"""
    try:
        from app.services.mapinfo_service import MapInfoParser, get_last_parse_errors
        return MapInfoParser, get_last_parse_errors
    except Exception as e:
        pytest.skip(f"mapinfo_service 依赖缺失，跳过: {type(e).__name__}: {str(e)[:100]}")


def test_normalize_tab_charset_changes_neutral_to_windows_simp_chinese(tmp_path):
    """覆盖电联扇区图层场景：!charset Neutral 应被规范化为 WindowsSimpChinese。
    同时改 Definition Table 中 Type NATIVE Charset 行（GDAL 同时检查两处）。"""
    MapInfoParser, _ = _try_import_mapinfo_parser()

    tab = tmp_path / "河源电联_LTE.tab"
    tab.write_text(
        "!table\n"
        "!version 300\n"
        "!charset Neutral\n"
        "\n"
        "Definition Table\n"
        '  Type NATIVE Charset "Neutral"\n'
        "  Fields 19\n"
        "    CGI Char (10) ;\n"
        "    CellLongitude Float ;\n",
        encoding="utf-8",
    )

    MapInfoParser._normalize_tab_charset(tab)
    content = tab.read_text(encoding="utf-8")

    assert "Neutral" not in content, f"❌ Neutral 残留: {content!r}"
    assert "WindowsSimpChinese" in content
    assert content.count("WindowsSimpChinese") == 2, (
        f"❌ 应替换 2 处（顶头 + Type 行），实际 {content.count('WindowsSimpChinese')}: {content!r}"
    )


def test_normalize_tab_charset_idempotent_for_already_correct_file(tmp_path):
    """已经是 WindowsSimpChinese 的文件不应被修改（幂等性，避免无谓写盘）。"""
    MapInfoParser, _ = _try_import_mapinfo_parser()

    tab = tmp_path / "河源5G-TAC.tab"
    original = (
        "!table\n"
        "!version 300\n"
        "!charset WindowsSimpChinese\n"
        '  Type NATIVE Charset "WindowsSimpChinese"\n'
    )
    tab.write_text(original, encoding="utf-8")

    MapInfoParser._normalize_tab_charset(tab)
    assert tab.read_text(encoding="utf-8") == original, "❌ 已被修改的 WindowsSimpChinese 文件"


def test_normalize_tab_charset_safe_for_nonexistent_and_none(tmp_path):
    """不存在的文件 / None 输入应安全跳过，不抛异常。"""
    MapInfoParser, _ = _try_import_mapinfo_parser()

    # 不存在文件路径
    MapInfoParser._normalize_tab_charset(tmp_path / "nonexistent.tab")  # 不抛
    # None 输入
    MapInfoParser._normalize_tab_charset(None)  # 不抛


def test_normalize_tab_charset_preserves_gbk_field_names_bytewise(tmp_path):
    """关键回归测试：GBK 编码的 .tab 文件，规范化后字段名字节必须保持原样。

    历史 bug：之前实现用 read_text(encoding="utf-8", errors="ignore")，
    导致：
      - GBK 字节 0xC7 0xB7 ("是否") 被 UTF-8 误读为拉丁字符 Ƿ (U+01F7)
      - 非合法 UTF-8 的 GBK 字节（如 0xB3 0xA7 = "厂"）被 errors="ignore" 丢弃
      - 字段名变空、Definition Table 结构被破坏
      - fiona 报 "Failed to parse field definition at line 11/12"

    修复后：必须用字节级替换 b"Neutral" → b"WindowsSimpChinese"，
    不重新编码整个文件。GBK 字节序列保持不变。
    """
    MapInfoParser, _ = _try_import_mapinfo_parser()

    # 模拟电联扇区图层的真实 .tab：GBK 编码 + CRLF + 中文字段名
    # 直接用 bytes([...]) 构造 GBK 字节，避免 Python 字符串字面量把 \xca 解读为 Unicode U+00CA
    gbk_bytes = (
        b"!table\r\n"
        b"!version 300\r\n"
        b"!charset Neutral\r\n"
        b"\r\n"
        b"Definition Table\r\n"
        b'  Type NATIVE Charset "Neutral"\r\n'
        b"  Fields 19\r\n"
        # 是否共享
        b"    " + bytes([0xCA, 0xC7, 0xB7, 0xF1, 0xB9, 0xB2, 0xCF, 0xED]) + b" Char (1) ;\r\n"
        b"    CGI Char (10) ;\r\n"
        # 厂家
        b"    " + bytes([0xB3, 0xA7, 0xBC, 0xD2]) + b" Char (5) ;\r\n"
        # 区域
        b"    " + bytes([0xD5, 0xFE, 0xD3, 0xF2]) + b" Char (2) ;\r\n"
        # 站高
        b"    " + bytes([0xD4, 0xBE, 0xB8, 0xDF]) + b" Char (5) ;\r\n"
        # 覆盖
        b"    " + bytes([0xB7, 0xFE, 0xB7, 0xC6]) + b" Char (1) ;\r\n"
    )
    tab = tmp_path / "河源电联_LTE.tab"
    tab.write_bytes(gbk_bytes)

    # 记录原始 GBK 字节
    original_bytes = tab.read_bytes()
    assert bytes([0xCA, 0xC7]) in original_bytes  # 是否 GBK 起始字节
    assert bytes([0xB3, 0xA7]) in original_bytes  # 厂家 GBK 起始字节

    # 执行规范化
    MapInfoParser._normalize_tab_charset(tab)

    new_bytes = tab.read_bytes()
    # 1. charset 已替换
    assert b"WindowsSimpChinese" in new_bytes
    assert b"Neutral" not in new_bytes
    # 2. **GBK 字段名字节保持原样**（核心断言：bytewise preservation）
    assert bytes([0xCA, 0xC7, 0xB7, 0xF1, 0xB9, 0xB2, 0xCF, 0xED]) in new_bytes, "GBK '是否共享' 字节必须保留"
    assert bytes([0xB3, 0xA7, 0xBC, 0xD2]) in new_bytes, "GBK '厂家' 字节必须保留"
    assert bytes([0xD5, 0xFE, 0xD3, 0xF2]) in new_bytes, "GBK '区域' 字节必须保留"
    assert bytes([0xD4, 0xBE, 0xB8, 0xDF]) in new_bytes, "GBK '站高' 字节必须保留"
    assert bytes([0xB7, 0xFE, 0xB7, 0xC6]) in new_bytes, "GBK '覆盖' 字节必须保留"
    # 3. CRLF 行结束符保持不变
    assert b"\r\n" in new_bytes
    # 4. **关键**：除了 b"Neutral" → b"WindowsSimpChinese" 的替换，其他字节必须完全一致
    expected_bytes = original_bytes.replace(b"Neutral", b"WindowsSimpChinese")
    assert new_bytes == expected_bytes, (
        "字节级替换必须仅替换 Neutral → WindowsSimpChinese，"
        "其他字节（包括 GBK 字段名、CRLF）必须完全保留"
    )
