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
    result = service.generate_point_layer(
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


def test_generate_sector_layer(service, sample_excel):
    """生成扇区图层并断言几何为多边形"""
    result = service.generate_sector_layer(
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
    result = service.generate_sector_layer(
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


def test_invalid_coordinates_raises(service, tmp_path):
    """非法经纬度（如 999）应抛异常"""
    path = tmp_path / "bad.xlsx"
    df = pd.DataFrame({"NAME": ["X"], "LONGITUDE": [999], "LATITUDE": [999]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="S", index=False)
    with pytest.raises(ValueError, match="经纬度"):
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
    result = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="mif", color="#4A90D9",
    )
    assert result.suffix == ".mif"
    text = result.read_text(encoding="utf-8", errors="replace")
    assert "Symbol (35,4886745," in text
    import geopandas as gpd
    gdf = gpd.read_file(result)
    assert len(gdf) == 2


def test_mif_sector_color_injected(service, sample_excel):
    """扇区 MIF + 颜色 → Brush 颜色替换，且可读回"""
    result = service.generate_sector_layer(
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
    result = service.generate_point_layer(
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
    """扇区 KML + 颜色 → PolyStyle color，且可读回"""
    result = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="kml", color="#4A90D9",
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    assert "<PolyStyle><color>ffd9904a" in text
    import geopandas as gpd
    gdf = gpd.read_file(result)
    assert len(gdf) == 2


def test_tab_color_ignored(service, sample_excel):
    """TAB + 颜色 → 正常生成（不注入，不报错）"""
    result = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="tab", color="#4A90D9",
    )
    assert result.exists()
    assert result.suffix == ".tab"


def test_invalid_color_ignored(service, sample_excel):
    """非法颜色 → 不注入，文件正常生成"""
    result = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="mif", color="zzz",
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    assert "Symbol (35,0,12)" in text  # 保持默认颜色
    assert "4886745" not in text


def test_kml_name_col_uses_cell_id(service, sample_excel):
    """KML name_col 生效：name_col=CELL_ID 时 <name> 取该列值"""
    result = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME", "PCI"], output_format="kml",
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    assert "<name>CellA</name>" in text
    assert "<name>CellB</name>" in text


def test_kml_color_inline_xml_valid(service, sample_excel):
    """KML 颜色注入后 XML 合法，且 Style 在 Placemark 内（严格查看器可渲染）"""
    import xml.etree.ElementTree as ET
    result = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="kml", color="#4A90D9",
    )
    text = result.read_text(encoding="utf-8", errors="replace")
    # XML 可解析
    root = ET.fromstring(text)
    ns = {"kml": "http://www.opengis.net/kml/2.2"}
    placemarks = root.findall(".//kml:Placemark", ns)
    assert len(placemarks) == 2
    for pm in placemarks:
        # Style 必须是 Placemark 的直接子元素
        style = pm.find("kml:Style", ns)
        assert style is not None, "Style 必须在 Placemark 内"
        poly_style = style.find("kml:PolyStyle", ns)
        assert poly_style is not None
        color_el = poly_style.find("kml:color", ns)
        assert color_el is not None
        assert color_el.text == "ffd9904a"


def test_output_filename_uses_source_and_sheet(tmp_path):
    """导出文件名 = 源文件名 + sheet 名 + 短 uuid + 扩展名"""
    path = tmp_path / "工参2026.xlsx"
    df = pd.DataFrame({
        "NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9],
    })
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    svc = LayerService(output_dir=tmp_path)
    out = svc.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="tab",
    )
    # 命名 = 源文件名(stem) + sheet 名 + 短uuid
    assert out.stem.startswith("工参2026_LTE_")
    assert out.suffix == ".tab"
