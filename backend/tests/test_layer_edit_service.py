"""
图层编辑服务测试（新建空 TAB 图层 + 整层保存重写）

依赖 geopandas/pyogrio（GDAL 绑定），缺失时自动 skip。
"""
import json
from pathlib import Path

import pytest

pytest.importorskip("geopandas")
pytest.importorskip("pyogrio")

from app.core.config import settings  # noqa: E402
from app.services import layer_edit_service  # noqa: E402
from app.services.mapinfo_service import get_layer_data  # noqa: E402


@pytest.fixture
def temp_data_dir(tmp_path: Path, monkeypatch):
    """把 DATA_DIR/UPLOAD_DIR 重定向到临时目录，避免污染真实数据。"""
    data_dir = tmp_path / "data"
    upload_dir = tmp_path / "uploads"
    data_dir.mkdir(parents=True, exist_ok=True)
    upload_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "DATA_DIR", data_dir)
    monkeypatch.setattr(settings, "UPLOAD_DIR", upload_dir)
    # data_service 单例在首次构造时缓存了 index.json 路径，测试中需重定向
    from app.services.data_service import data_service
    monkeypatch.setattr(data_service, "data_index_file", data_dir / "index.json")
    return data_dir


@pytest.mark.parametrize("geom,expected", [
    ("point", "point"),
    ("line", "line"),
    ("polygon", "polygon"),
])
def test_create_empty_tab_layer(temp_data_dir, geom, expected):
    """三种几何类型建空层：配套文件齐全、layers.json/index 正确、可解析 0 要素。"""
    result = layer_edit_service.create_empty_tab_layer(f"测试_{geom}", geom, user_id=1)

    data_dir = temp_data_dir / result["data_id"]
    tab_path = data_dir / f"{result['name']}.tab"

    # 配套文件齐全
    assert tab_path.exists()
    assert tab_path.with_suffix(".dat").exists()
    assert (data_dir / "layers.json").exists()

    # layers.json 条目
    layers = json.loads((data_dir / "layers.json").read_text(encoding="utf-8"))
    assert len(layers) == 1
    entry = layers[0]
    assert entry["type"] == expected
    assert entry["feature_count"] == 0
    assert entry["id"] == result["layer_id"]
    assert entry["metadata"]["source_file"].endswith(".tab")

    # index.json 注册
    index = json.loads((temp_data_dir / "index.json").read_text(encoding="utf-8"))
    idx = index[result["data_id"]]
    assert idx["type"] == "map"
    assert idx["subType"] == "mapinfo"
    assert idx["status"] == "ready"
    assert idx["metadata"]["layerCount"] == 1

    # 通过图层数据端点链路读回：0 要素
    gj = get_layer_data(result["data_id"], result["layer_id"], data_dir)
    assert gj is not None
    assert gj.get("type") == "FeatureCollection"
    assert len(gj.get("features", [])) == 0


def test_create_invalid_geometry_raises(temp_data_dir):
    """不支持的几何类型应抛 ValueError。"""
    with pytest.raises(ValueError):
        layer_edit_service.create_empty_tab_layer("bad", "sphere")


def test_create_sanitizes_filename(temp_data_dir):
    """文件名非法字符被清洗，落盘文件不包含非法字符。"""
    result = layer_edit_service.create_empty_tab_layer('a/b:c?d*e"f', "point", user_id=1)
    data_dir = temp_data_dir / result["data_id"]
    tabs = list(data_dir.glob("*.tab"))
    assert len(tabs) == 1
    name = tabs[0].stem
    for ch in '/\\:?*"<>|':
        assert ch not in name


def _fc(features):
    return {"type": "FeatureCollection", "features": features}


def _point(lng, lat, name=None):
    props = {}
    if name is not None:
        props["name"] = name
    return {"type": "Feature", "properties": props,
            "geometry": {"type": "Point", "coordinates": [lng, lat]}}


def test_save_point_roundtrip_and_coord_transform(temp_data_dir):
    """保存后文件内为 WGS84，读回（get_layer_data）为 GCJ02，中文属性保留、内部字段剔除。"""
    from app.utils.coordinate_transformer import CoordinateTransformer
    from app.services.layer_edit_service import save_layer_geojson, _read_tab_gdf

    r = layer_edit_service.create_empty_tab_layer("保存测试", "point", user_id=1)
    did, lid = r["data_id"], r["layer_id"]
    tab = temp_data_dir / did / f"{r['name']}.tab"

    gcj = [(116.40, 39.90), (121.47, 31.23)]
    feats = []
    for i, (lng, lat) in enumerate(gcj):
        f = _point(lng, lat, name=f"点{i}")
        f["properties"]["_editId"] = f"e{i}"
        f["properties"]["_style"] = {"markerColor": "#fff"}
        feats.append(f)

    res = layer_edit_service.save_layer_geojson(did, lid, _fc(feats), user_id=1)
    assert res["feature_count"] == 2

    # 文件内坐标应为 WGS84（GCJ02 逆转换）
    gdf = _read_tab_gdf(tab)
    _, exp_lng = CoordinateTransformer.gcj02_to_wgs84(gcj[0][1], gcj[0][0])
    assert abs(gdf.geometry.iloc[0].x - exp_lng) < 1e-6
    # 中文属性保留
    assert gdf.iloc[0]["name"] == "点0"
    # 内部字段不落盘
    assert "_editId" not in gdf.columns and "_style" not in gdf.columns

    # 读回（下发链路）坐标 ≈ 原始 GCJ02（逆转换精度内，约数米）
    gj = get_layer_data(did, lid, temp_data_dir / did)
    back_lng = gj["features"][0]["geometry"]["coordinates"][0]
    assert abs(back_lng - gcj[0][0]) < 2e-5
    assert gj["features"][0]["properties"]["name"] == "点0"


def test_save_delete_all_then_rewrite(temp_data_dir):
    """删空后保存：0 要素可读、类型保留；再写回要素正常。"""
    from app.services.layer_edit_service import save_layer_geojson, _read_tab_gdf

    r = layer_edit_service.create_empty_tab_layer("删空测试", "point", user_id=1)
    did, lid = r["data_id"], r["layer_id"]
    tab = temp_data_dir / did / f"{r['name']}.tab"

    save_layer_geojson(did, lid, _fc([_point(116.4, 39.9, "a"), _point(116.5, 39.9, "b")]), user_id=1)
    assert len(_read_tab_gdf(tab)) == 2

    # 删空
    save_layer_geojson(did, lid, _fc([]), user_id=1)
    assert len(_read_tab_gdf(tab)) == 0
    gj = get_layer_data(did, lid, temp_data_dir / did)
    assert len(gj["features"]) == 0
    entry = json.loads((temp_data_dir / did / "layers.json").read_text("utf-8"))[0]
    assert entry["type"] == "point" and entry["feature_count"] == 0

    # 再写回
    save_layer_geojson(did, lid, _fc([_point(116.4, 39.9, "c")]), user_id=1)
    assert len(_read_tab_gdf(tab)) == 1


def test_save_extends_schema_for_new_scalar_keys(temp_data_dir):
    """粘贴跨源要素（如基站）携带的新标量属性键自动扩展进 schema；
    内部字段（下划线开头）与绘制样式键仍不落盘。"""
    from app.services.layer_edit_service import save_layer_geojson, _read_tab_gdf

    r = layer_edit_service.create_empty_tab_layer("schema测试", "point", user_id=1)
    did, lid = r["data_id"], r["layer_id"]
    tab = temp_data_dir / did / f"{r['name']}.tab"

    f = _point(116.4, 39.9)
    f["properties"]["pci"] = 123          # 粘贴基站带来的新标量属性 → 扩展列
    f["properties"]["azimuth"] = 30.5
    f["properties"]["_internal"] = "不应出现"   # 内部字段
    f["properties"]["markerColor"] = "#ff0000"  # 绘制样式键 → 不扩展
    save_layer_geojson(did, lid, _fc([f]), user_id=1)
    gdf = _read_tab_gdf(tab)
    assert "pci" in gdf.columns
    assert "azimuth" in gdf.columns
    assert "_internal" not in gdf.columns
    assert "markerColor" not in gdf.columns
    assert "name" in gdf.columns


def test_save_rejects_non_tab(temp_data_dir):
    """源文件非 .tab（MIF/KML）时保存应抛错。"""
    r = layer_edit_service.create_empty_tab_layer("非tab测试", "point", user_id=1)
    did, lid = r["data_id"], r["layer_id"]
    # 篡改为 .mif 源
    lj_path = temp_data_dir / did / "layers.json"
    layers = json.loads(lj_path.read_text("utf-8"))
    layers[0]["metadata"]["source_file"] = str(temp_data_dir / did / "fake.mif")
    lj_path.write_text(json.dumps(layers, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(ValueError):
        layer_edit_service.save_layer_geojson(did, lid, _fc([_point(1, 2)]), user_id=1)


def test_mixed_layer_save_point_line_polygon(temp_data_dir):
    """混合图层（默认 mixed）可同时写入点/线/面，读回三类型，layers.json 类型保持 mixed。"""
    from app.services.layer_edit_service import save_layer_geojson, _read_tab_gdf

    r = layer_edit_service.create_empty_tab_layer("混合", user_id=1)  # 不传几何 → mixed
    assert r["name"] == "混合"
    did, lid = r["data_id"], r["layer_id"]
    tab = temp_data_dir / did / f"{r['name']}.tab"
    entry = json.loads((temp_data_dir / did / "layers.json").read_text("utf-8"))[0]
    assert entry["type"] == "mixed"

    feats = [
        {"type": "Feature", "properties": {"name": "点"},
         "geometry": {"type": "Point", "coordinates": [116.4, 39.9]}},
        {"type": "Feature", "properties": {"name": "线"},
         "geometry": {"type": "LineString", "coordinates": [[116.4, 39.9], [116.41, 39.91]]}},
        {"type": "Feature", "properties": {"name": "面"},
         "geometry": {"type": "Polygon",
                      "coordinates": [[[116.4, 39.9], [116.41, 39.9], [116.41, 39.91], [116.4, 39.9]]]}},
    ]
    res = save_layer_geojson(did, lid, {"type": "FeatureCollection", "features": feats}, user_id=1)
    assert res["feature_count"] == 3

    gdf = _read_tab_gdf(tab)
    assert sorted(set(gdf.geom_type)) == ["LineString", "Point", "Polygon"]
    gj = get_layer_data(did, lid, temp_data_dir / did)
    assert sorted({f["geometry"]["type"] for f in gj["features"]}) == ["LineString", "Point", "Polygon"]
    # 类型仍为 mixed
    assert json.loads((temp_data_dir / did / "layers.json").read_text("utf-8"))[0]["type"] == "mixed"


def test_save_single_layer_upgrades_when_mixed_content(temp_data_dir):
    """单点图层写入线要素 → 自动升级为 mixed，避免写 Point 图层报错。"""
    from app.services.layer_edit_service import save_layer_geojson, _read_tab_gdf

    r = layer_edit_service.create_empty_tab_layer("升级", "point", user_id=1)
    did, lid = r["data_id"], r["layer_id"]
    tab = temp_data_dir / did / f"{r['name']}.tab"
    feats = [
        {"type": "Feature", "properties": {"name": "点"},
         "geometry": {"type": "Point", "coordinates": [116.4, 39.9]}},
        {"type": "Feature", "properties": {"name": "线"},
         "geometry": {"type": "LineString", "coordinates": [[116.4, 39.9], [116.41, 39.91]]}},
    ]
    save_layer_geojson(did, lid, {"type": "FeatureCollection", "features": feats}, user_id=1)
    gdf = _read_tab_gdf(tab)
    assert sorted(set(gdf.geom_type)) == ["LineString", "Point"]
    entry = json.loads((temp_data_dir / did / "layers.json").read_text("utf-8"))[0]
    assert entry["type"] == "mixed"


def test_build_layer_zip_bundles_all_tab_files(temp_data_dir):
    """保存后能把 MapInfo 全套文件（.tab/.dat/.id/.map）打包 zip，供"另存为"下载。"""
    import io, zipfile
    from app.services.layer_edit_service import save_layer_geojson, build_layer_zip, _read_tab_gdf

    r = layer_edit_service.create_empty_tab_layer("打包", user_id=1)
    did, lid = r["data_id"], r["layer_id"]
    feats = [{"type": "Feature", "properties": {"name": "点"},
              "geometry": {"type": "Point", "coordinates": [116.4, 39.9]}}]
    save_layer_geojson(did, lid, {"type": "FeatureCollection", "features": feats}, user_id=1)

    data, filename = build_layer_zip(did, lid)
    assert filename.endswith(".tab.zip")
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        # 4 个关联文件齐全
        assert any(n.endswith(".tab") for n in names)
        assert any(n.endswith(".dat") for n in names)
        assert any(n.endswith(".map") for n in names)
        assert any(n.endswith(".id") for n in names)


def test_empty_layer_has_default_attribute_column(temp_data_dir):
    """空图层必须带至少 1 个属性列（0 字段 .dat 无法被 MapInfo 驱动读回）。"""
    import geopandas as gpd
    result = layer_edit_service.create_empty_tab_layer("空层", "point", user_id=1)
    tab = temp_data_dir / result["data_id"] / f"{result['name']}.tab"
    gdf = gpd.read_file(tab, encoding="gbk")
    # 0 要素读回时 geopandas 不推断 geometry 列，但默认 name 属性列必须存在、行数为 0
    assert "name" in gdf.columns
    assert len(gdf) == 0
