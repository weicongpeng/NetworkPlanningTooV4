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
