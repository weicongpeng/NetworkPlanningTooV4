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
    assert "Symbol (35,4886745," in text
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
    """扇区 KML + 颜色 → PolyStyle color，且可读回"""
    result, _ = service.generate_sector_layer(
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
    """KML 颜色注入后 XML 合法，且 Style 在 Placemark 内（严格查看器可渲染）"""
    import xml.etree.ElementTree as ET
    result, _ = service.generate_sector_layer(
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
    """导出文件名 = 源文件名 + sheet 名（去 uuid）"""
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
    assert out.stem == "工参2026_LTE"
    assert out.suffix == ".tab"


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
    assert out.stem == "工参2026_LTE"


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


def test_output_filename_conflict_appends_suffix(tmp_path):
    """同名文件已存在 → 追加 -1/-2 序号"""
    path = tmp_path / "源.xlsx"
    df = pd.DataFrame({"NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9]})
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="LTE", index=False)
    svc = LayerService(output_dir=tmp_path)
    (tmp_path / "源_LTE.tab").write_text("x")   # 预置冲突
    out1, _ = svc.generate_point_layer(str(path), "LTE", "NAME", "LONGITUDE", "LATITUDE", ["NAME"], "tab")
    out2, _ = svc.generate_point_layer(str(path), "LTE", "NAME", "LONGITUDE", "LATITUDE", ["NAME"], "tab")
    assert out1.name == "源_LTE-1.tab"
    assert out2.name == "源_LTE-2.tab"


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
