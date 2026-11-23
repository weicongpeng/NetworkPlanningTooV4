"""图层制作 TAB 原生样式写入测试（临时 MIF 中转 → GDAL 转 TAB）。

覆盖：
- 扇区 TAB：Pen 线宽/颜色、Brush 填充色、透明度两档（实心/空心）
- 点 TAB：Symbol 颜色/大小/形状编号
- 中文列名、中文值、charset、Char 宽度在中转后不劣化
- 转换失败时回退为无样式 TAB（不阻断出图）
- 读侧能读 MIF 样式（回归：GDALOpenEx 误用 UPDATE 标志导致 MIF 打不开）

依赖真实 geopandas/pyogrio/GDAL 与 pyogrio 自带 libgdal；缺失或为 mock 时跳过。
"""
import math

import pandas as pd
import pytest

from app.services.layer_service import LayerService, tab_opacity_brush_pattern

SAMPLE_DATA = {
    "NAME": ["CellA", "CellB"],
    "LONGITUDE": [116.3, 116.4],
    "LATITUDE": [39.9, 40.0],
    "AZIMUTH": [0.0, 120.0],
    "PCI": [100, 200],
}


def _require_real_gdal():
    """真实 GDAL 环境不可用（未安装或 conftest mock）时跳过。"""
    try:
        import geopandas as gpd
        import pyogrio
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"缺少 geopandas/pyogrio: {exc}")
    if not hasattr(pyogrio, "raw") or not hasattr(gpd, "points_from_xy"):
        pytest.skip("geopandas/pyogrio 为 mock（测试环境缺真实依赖）")
    from app.services.ogr_style_reader import find_libgdal
    if not find_libgdal():
        pytest.skip("未找到 libgdal（TAB 样式转换不可用）")


@pytest.fixture
def sample_excel(tmp_path):
    path = tmp_path / "sample.xlsx"
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        pd.DataFrame(SAMPLE_DATA).to_excel(writer, sheet_name="LTE", index=False)
    return path


@pytest.fixture
def service(tmp_path):
    return LayerService(output_dir=tmp_path)


def _styles(path):
    from app.services.ogr_style_reader import read_feature_style_strings
    styles = read_feature_style_strings(path)
    assert styles, f"读不到样式串: {path}"
    return styles[0]


# ---------------------------------------------------------------------------
# 透明度两档（不依赖 GDAL）
# ---------------------------------------------------------------------------

def test_tab_opacity_two_bands():
    """TAB 透明度只做两档：>0.5 空心（1），否则实心（2）；非法/NaN → 实心"""
    assert tab_opacity_brush_pattern(0.0) == 2
    assert tab_opacity_brush_pattern(0.5) == 2      # 默认值落在实心档，填充色可见
    assert tab_opacity_brush_pattern(0.51) == 1
    assert tab_opacity_brush_pattern(1.0) == 1
    assert tab_opacity_brush_pattern(None) == 2
    assert tab_opacity_brush_pattern("abc") == 2
    assert tab_opacity_brush_pattern(math.nan) == 2


# ---------------------------------------------------------------------------
# 扇区（面）：Pen 线宽/颜色 + Brush 填充
# ---------------------------------------------------------------------------

def test_tab_sector_pen_and_solid_brush(service, sample_excel):
    """扇区 TAB：Pen = 边框色 + 线宽，Brush = 填充色 + 实心（透明度 ≤ 0.5）"""
    _require_real_gdal()
    out, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="tab",
        border_color="#FFFF00", fill_color="#FF0000", opacity=0.3, line_width=5,
    )
    style = _styles(out)
    assert 'PEN(w:5px,c:#ffff00' in style
    assert 'BRUSH(fc:#ff0000,bc:#ffffff,id:"mapinfo-brush-2' in style


def test_tab_sector_transparent_brush_is_hollow(service, sample_excel):
    """扇区 TAB：透明度 0.8 → Brush 图案 1（空心，只留边框）"""
    _require_real_gdal()
    out, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="tab",
        border_color="#FFFF00", fill_color="#FF0000", opacity=0.8, line_width=3,
    )
    style = _styles(out)
    assert 'PEN(w:3px,c:#ffff00' in style
    assert "mapinfo-brush-1" in style
    assert "mapinfo-brush-2" not in style


def test_tab_sector_line_width_clamped(service, sample_excel):
    """线宽超出 MapInfo 的 1-7 档位时被夹紧"""
    _require_real_gdal()
    out, _ = service.generate_sector_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        azimuth_col="AZIMUTH", radius_m=3000, beamwidth=40.0,
        attributes=["NAME"], output_format="tab",
        border_color="#FFFF00", fill_color="#FF0000", line_width=20,
    )
    assert "PEN(w:7px" in _styles(out)


# ---------------------------------------------------------------------------
# 点：Symbol 形状编号/颜色/大小
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("shape,symbol", [
    ("circle", 34), ("square", 32), ("diamond", 33),
    ("triangle", 40), ("triangle_down", 41), ("landmark", 42), ("pin", 38),
])
def test_tab_point_shape_symbol_number(service, sample_excel, shape, symbol):
    """点 TAB：形状 → MapInfo Symbol 编号（与 POINT_SHAPE_MIF 一致）"""
    _require_real_gdal()
    out, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="tab",
        border_color="#0000FF", point_size=15, point_shape=shape,
    )
    style = _styles(out)
    assert f'id:"mapinfo-sym-{symbol}' in style
    assert "c:#0000ff" in style
    assert "s:15pt" in style


# ---------------------------------------------------------------------------
# 数据无损：中文列名/值/charset/Char 宽度
# ---------------------------------------------------------------------------

def test_tab_style_keeps_chinese_fields_and_width(service, tmp_path):
    """中文列名与值可读回，charset 为 WindowsSimpChinese，Char 宽度不放大到 254"""
    _require_real_gdal()
    path = tmp_path / "工参.xlsx"
    pd.DataFrame({"小区名称": ["基站A"], "经度": [116.4], "纬度": [39.9]}).to_excel(
        path, sheet_name="LTE", index=False)
    out, _ = service.generate_point_layer(
        file_path=str(path), sheet_name="LTE",
        name_col="小区名称", lon_col="经度", lat_col="纬度",
        attributes=["小区名称"], output_format="tab", border_color="#FF0000",
    )
    import geopandas as gpd
    gdf = gpd.read_file(out)
    assert "小区名称" in gdf.columns
    assert gdf["小区名称"].tolist() == ["基站A"]
    tab_text = out.read_text(encoding="gbk", errors="replace")
    assert "WindowsSimpChinese" in tab_text
    assert "小区名称 Char (5) ;" in tab_text      # "基站A" = 5 GBK 字节，未膨胀成 Char(254)
    assert _styles(out)


# ---------------------------------------------------------------------------
# 降级与读侧回归
# ---------------------------------------------------------------------------

def test_tab_style_conversion_failure_falls_back(service, sample_excel, monkeypatch):
    """转换失败 → 记日志并回退无样式 TAB，文件仍可读（不阻断出图）"""
    _require_real_gdal()
    from app.services import layer_service

    def _boom(*args, **kwargs):
        raise RuntimeError("模拟转换失败")

    monkeypatch.setattr(layer_service, "convert_mif_to_tab", _boom)
    out, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="tab", border_color="#0000FF",
    )
    import geopandas as gpd
    assert out.exists() and len(gpd.read_file(out)) == 2


def test_convert_mif_to_tab_missing_source_raises(tmp_path):
    """源文件不存在 → RuntimeError（调用方据此降级）"""
    _require_real_gdal()
    from app.services.tab_style_writer import convert_mif_to_tab

    with pytest.raises(RuntimeError):
        convert_mif_to_tab(tmp_path / "nope.mif", tmp_path / "out.tab")


def test_read_mif_styles_via_gdal(service, sample_excel):
    """回归：MIF 样式可读（此前 GDALOpenEx 误用 UPDATE 标志，MIF 直接打不开）"""
    _require_real_gdal()
    out, _ = service.generate_point_layer(
        file_path=str(sample_excel), sheet_name="LTE",
        name_col="NAME", lon_col="LONGITUDE", lat_col="LATITUDE",
        attributes=["NAME"], output_format="mif", border_color="#4A90D9",
    )
    style = _styles(out)
    assert "c:#4a90d9" in style
    assert "SYMBOL(" in style
