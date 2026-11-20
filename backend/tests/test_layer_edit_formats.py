"""Shapefile / GeoJSON 图层编辑保存的格式相关测试。

覆盖：
- QML 样式往返（写侧 qml_style_writer ↔ 读侧 _qgis_symbol_to_style）不漂移
- RuleRenderer 的 $id 过滤解析（逐要素配色）
- DBF 字段名净化（10 字节上限，不得切断多字节字符）
- 字段名映射 sidecar 往返

依赖 geopandas/pyogrio，缺失时 pytest.skip（沿用 test_mapinfo_import 的模式）。
"""
import json

import pytest
from pathlib import Path


def _try_import(module: str, attr: str = None):
    import importlib

    try:
        mod = importlib.import_module(module)
        return getattr(mod, attr) if attr else mod
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"{module} 依赖缺失，跳过: {type(e).__name__}: {str(e)[:100]}")


def _require_geopandas():
    _try_import("geopandas")


def _parser():
    return _try_import("app.services.mapinfo_service", "MapInfoParser")


def _writer():
    return _try_import("app.services.qml_style_writer")


def _gdf(n, geom_type="point"):
    import geopandas as gpd
    from shapely.geometry import Point, LineString, Polygon

    geom = {
        "point": lambda: Point(114.0, 22.0),
        "line": lambda: LineString([(114.0, 22.0), (114.1, 22.1)]),
        "polygon": lambda: Polygon([(114.0, 22.0), (114.1, 22.0), (114.1, 22.1), (114.0, 22.0)]),
    }[geom_type]
    return gpd.GeoDataFrame({"a": list(range(n))}, geometry=[geom() for _ in range(n)], crs="EPSG:4326")


# ---------------------------------------------------------------- QML 往返

def _read_styles(qml_path, n, geom_type):
    """写出的 .qml 读回后的渲染词汇样式列表。"""
    P = _parser()
    return P._parse_qml_styles(qml_path, _gdf(n, geom_type))


def _write(qml_path, kind, write_styles):
    """写词汇样式 → .qml（自动补 kind）。"""
    W = _writer()
    return W.write_layer_qml(qml_path, kind, [dict(s, kind=kind) for s in write_styles])


def _resolve(kind, read_style):
    """渲染词汇样式 → 写词汇样式（保存时走的合并逻辑）。"""
    from app.services.layer_edit_service import _resolve_feature_style
    return _resolve_feature_style(kind, ns=read_style)


def test_qml_roundtrip_point(tmp_path):
    """点样式：颜色/大小/形状 经 .qml 往返后稳定"""
    qml = tmp_path / "p.qml"
    _write(qml, "point", [{"markerColor": "#e31a1c", "markerSize": 8}])
    read = _read_styles(qml, 2, "point")
    assert read and all(read), "写出的 .qml 未解析出样式"
    assert read[0]["markerColor"] == "#e31a1c"
    assert read[0]["markerSize"] == pytest.approx(8, abs=0.2)
    assert read[0]["markerSymbol"] == "circle"

    # 二次往返不漂移
    _write(qml, "point", [_resolve("point", read[0])] * 2)
    assert _read_styles(qml, 2, "point")[0] == read[0]


def test_qml_roundtrip_point_shape(tmp_path):
    """点形状（正方形）往返保真"""
    qml = tmp_path / "p.qml"
    _write(qml, "point", [{"markerColor": "#33a02c", "markerSize": 12, "markerSymbol": "square"}])
    read = _read_styles(qml, 1, "point")
    assert read[0]["markerSymbol"] == "square"
    assert read[0]["markerSize"] == pytest.approx(12, abs=0.2)


def test_qml_roundtrip_line(tmp_path):
    """线样式：颜色/线宽 往返保真且稳定"""
    qml = tmp_path / "l.qml"
    _write(qml, "line", [{"strokeColor": "#1f78b4", "strokeWidth": 3}])
    read = _read_styles(qml, 2, "line")
    assert read and all(read)
    assert read[0]["strokeColor"] == "#1f78b4"
    assert read[0]["strokeWidth"] == pytest.approx(3, abs=0.2)

    _write(qml, "line", [_resolve("line", read[0])] * 2)
    assert _read_styles(qml, 2, "line")[0] == read[0]


def test_qml_roundtrip_polygon(tmp_path):
    """面样式：填充色/透明度/描边 往返保真且稳定"""
    qml = tmp_path / "f.qml"
    _write(qml, "polygon", [{
        "fillColor": "#ff9900", "fillOpacity": 0.6,
        "strokeColor": "#003366", "strokeWidth": 2,
    }])
    read = _read_styles(qml, 2, "polygon")
    assert read and all(read)
    assert read[0]["fillColor"] == "#ff9900"
    assert read[0]["fillOpacity"] == pytest.approx(0.6, abs=0.02)
    assert read[0]["strokeColor"] == "#003366"
    assert read[0]["strokeWidth"] == pytest.approx(2, abs=0.2)

    _write(qml, "polygon", [_resolve("polygon", read[0])] * 2)
    assert _read_styles(qml, 2, "polygon")[0] == read[0]


def test_qml_line_none_color_is_hollow(tmp_path):
    """线无色（'none' 哨兵）→ line_style=no → 读回仍是 'none'（不漂移成黑色）"""
    qml = tmp_path / "l.qml"
    _write(qml, "line", [{"strokeColor": "none"}])
    read = _read_styles(qml, 1, "line")
    assert read[0]["strokeColor"] == "none"


def test_qml_polygon_no_fill(tmp_path):
    """面无填充 → style=no → 读回 fill=False"""
    qml = tmp_path / "f.qml"
    _write(qml, "polygon", [{"fillOff": True, "strokeColor": "#003366"}])
    read = _read_styles(qml, 1, "polygon")
    assert read[0].get("fill") is False
    assert read[0]["strokeColor"] == "#003366"


def test_qml_per_feature_rule_renderer(tmp_path):
    """逐要素配色 → RuleRenderer 按 $id 回填到正确的行"""
    qml = tmp_path / "mixed.qml"
    _write(qml, "point", [
        {"markerColor": "#e31a1c", "markerSize": 8},
        {"markerColor": "#33a02c", "markerSize": 8},
        {"markerColor": "#e31a1c", "markerSize": 8},  # 与第 0 行同色 → 合并到同一条 rule
    ])
    text = qml.read_text(encoding="utf-8")
    assert "RuleRenderer" in text, "逐要素配色应使用 RuleRenderer"
    assert "$id IN (0,2)" in text, f"同色要素未合并到一条 rule:\n{text}"

    read = _read_styles(qml, 3, "point")
    assert read[0]["markerColor"] == "#e31a1c"
    assert read[1]["markerColor"] == "#33a02c"
    assert read[2]["markerColor"] == "#e31a1c"


def test_qml_single_symbol_when_uniform(tmp_path):
    """全部要素同色 → singleSymbol（不生成 rule 列表）"""
    qml = tmp_path / "same.qml"
    _write(qml, "point", [{"markerColor": "#e31a1c", "markerSize": 8}] * 3)
    assert "singleSymbol" in qml.read_text(encoding="utf-8")


def test_qml_unstyled_rows_stay_none(tmp_path):
    """无显式样式的要素读回为 None（走图层默认配色），不被套用他人样式"""
    W = _writer()
    qml = tmp_path / "partial.qml"
    W.write_layer_qml(qml, "point", [{"markerColor": "#e31a1c", "kind": "point"}, None])
    read = _read_styles(qml, 2, "point")
    assert read[0] is not None
    assert read[1] is None


def test_qml_no_styles_removes_stale_file(tmp_path):
    """样式被全部清空时删除旧 .qml，避免重新导入读出已删除的配色"""
    W = _writer()
    qml = tmp_path / "s.qml"
    W.write_layer_qml(qml, "point", [{"markerColor": "#e31a1c", "kind": "point"}])
    assert qml.exists()
    W.write_layer_qml(qml, "point", [None])
    assert not qml.exists(), "无样式时应删除旧 .qml"


def test_qml_rule_id_parser():
    """$id 过滤表达式解析：只认本工具写出的两种形式"""
    P = _parser()
    assert P._qml_rule_ids("$id = 3") == [3]
    assert P._qml_rule_ids("$id IN (0,2,5)") == [0, 2, 5]
    assert P._qml_rule_ids("$id IN ( 1 , 4 )") == [1, 4]
    # 无法识别的复杂表达式一律不套用，避免规则错配到别的要素
    assert P._qml_rule_ids('"PCI" > 5') == []
    assert P._qml_rule_ids("") == []
    assert P._qml_rule_ids(None) == []


# ------------------------------------------------------- DBF 字段名净化

def test_dbf_safe_name_limits_bytes_and_keeps_chars_intact():
    """DBF 字段名 ≤10 字节且不切断多字节字符（截断到字节中间会写坏文件）"""
    from app.services.layer_edit_service import _dbf_safe_name

    # 4 个中文 = 12 字节 → 必须截到 3 个字（9 字节），而不是留下半个字符
    safe = _dbf_safe_name("小区名称", 0)
    assert len(safe.encode("utf-8")) <= 10
    assert safe == "小区名"
    safe.encode("utf-8").decode("utf-8")  # 可解码 = 未切断字符

    # ASCII 超 10 字节 → 直接截断
    assert _dbf_safe_name("abcdefghijk", 0) == "abcdefghij"

    # 已合规的名字原样保留（保证导入的 Shapefile 往返不变）
    assert _dbf_safe_name("PCI", 0) == "PCI"
    assert _dbf_safe_name("名称", 0) == "名称"


def test_dbf_safe_name_falls_back_for_empty():
    """清洗后为空的列名回退 Field{n}，不写出无名字段"""
    from app.services.layer_edit_service import _dbf_safe_name
    assert _dbf_safe_name("%%%", 2) == "Field3"


# ------------------------------------------------ 新建 + 保存端到端（SHP/GeoJSON）

@pytest.fixture
def temp_data_dir(tmp_path, monkeypatch):
    """把 DATA_DIR/UPLOAD_DIR 重定向到临时目录，避免污染真实数据。"""
    from app.core.config import settings
    from app.services.data_service import data_service

    data_dir = tmp_path / "data"
    upload_dir = tmp_path / "uploads"
    data_dir.mkdir(parents=True, exist_ok=True)
    upload_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "DATA_DIR", data_dir)
    monkeypatch.setattr(settings, "UPLOAD_DIR", upload_dir)
    monkeypatch.setattr(data_service, "data_index_file", data_dir / "index.json")
    return data_dir


def _feature_collection(props_list, style_list=None):
    """构造前端提交的 FeatureCollection（GCJ02，含逐要素 _editStyle）。"""
    feats = []
    for i, props in enumerate(props_list):
        p = dict(props)
        if style_list:
            p["_editStyle"] = style_list[i]
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [114.0 + i * 0.01, 22.0 + i * 0.01]},
            "properties": p,
        })
    return {"type": "FeatureCollection", "features": feats}


def test_shapefile_create_rejects_mixed_geometry(temp_data_dir):
    """新建 Shapefile 时 mixed 几何必须被拒（单文件只支持一种几何类型）"""
    from app.services.layer_edit_service import create_empty_layer

    with pytest.raises(ValueError, match="单一几何类型|一种几何类型"):
        create_empty_layer("混合层", "mixed", "shp", user_id=1)


def test_shapefile_save_roundtrip_with_chinese_fieldnames(temp_data_dir):
    """Shapefile 保存：中文长字段名被安全转写、文件可独立读回、样式写入 .qml"""
    from app.services.layer_edit_service import create_empty_layer, save_layer_geojson
    import geopandas as gpd

    r = create_empty_layer("站点", "point", "shp", user_id=1)
    data_dir = temp_data_dir / r["data_id"]
    shp = data_dir / "站点.shp"
    assert shp.exists(), "新建未产出 .shp"

    # 「小区名称」12 字节 > DBF 上限 → 必须转写，否则写出的文件读不回
    fc = _feature_collection(
        [{"小区名称": "南宁基站A", "PCI": 12}, {"小区名称": "桂林基站B", "PCI": 345}],
        [{"markerColor": "#e31a1c", "markerSize": 8}, {"markerColor": "#33a02c", "markerSize": 8}],
    )
    res = save_layer_geojson(r["data_id"], r["layer_id"], fc, user_id=1)
    assert res["feature_count"] == 2

    # 独立读回（等价 QGIS/GDAL 打开）：能读、几何与属性正确
    back = gpd.read_file(shp)
    assert len(back) == 2
    assert list(back.columns)[0] == "小区名" or "小区名" in list(back.columns)
    assert back.iloc[0]["PCI"] == 12

    # 字段名映射 sidecar 记录了原名 → 存储名
    sidecar = data_dir / "站点.nptfields.json"
    assert sidecar.exists(), "缺少字段名映射 sidecar"
    mapping = json.loads(sidecar.read_text(encoding="utf-8"))
    assert mapping["小区名称"] == "小区名"

    # 配套文件齐全
    for ext in (".shp", ".shx", ".dbf", ".prj", ".cpg"):
        assert (data_dir / f"站点{ext}").exists(), f"缺少 {ext}"
    assert (data_dir / "站点.qml").exists(), "缺少样式 .qml"


def test_shapefile_reimport_restores_display_names_and_styles(temp_data_dir):
    """闭环：保存后的 Shapefile 重新解析，列名还原为原名、逐要素配色还原"""
    from app.services.layer_edit_service import create_empty_layer, save_layer_geojson
    from app.services.mapinfo_service import MapInfoParser

    r = create_empty_layer("闭环", "point", "shp", user_id=1)
    data_dir = temp_data_dir / r["data_id"]
    fc = _feature_collection(
        [{"小区名称": "A"}, {"小区名称": "B"}],
        [{"markerColor": "#e31a1c", "markerSize": 8}, {"markerColor": "#33a02c", "markerSize": 8}],
    )
    save_layer_geojson(r["data_id"], r["layer_id"], fc, user_id=1)

    layer = MapInfoParser.parse_file(data_dir / "闭环.shp")
    assert "小区名称" in layer.features[0].properties, "列名未还原为显示名"
    assert layer.features[0].properties["_style"]["markerColor"] == "#e31a1c"
    assert layer.features[1].properties["_style"]["markerColor"] == "#33a02c"


def test_geojson_save_roundtrip_keeps_chinese_fieldnames(temp_data_dir):
    """GeoJSON 保存：中文长字段名原样保留（无 DBF 限制），样式写入 .qml"""
    from app.services.layer_edit_service import create_empty_layer, save_layer_geojson
    import geopandas as gpd

    r = create_empty_layer("小区", "point", "geojson", user_id=1)
    data_dir = temp_data_dir / r["data_id"]
    gj = data_dir / "小区.geojson"
    assert gj.exists()

    fc = _feature_collection(
        [{"小区名称": "南宁基站A", "地市": "南宁"}],
        [{"markerColor": "#1f78b4", "markerSize": 10}],
    )
    res = save_layer_geojson(r["data_id"], r["layer_id"], fc, user_id=1)
    assert res["feature_count"] == 1

    back = gpd.read_file(gj)
    assert "小区名称" in list(back.columns), "GeoJSON 不应改写字段名"
    assert back.iloc[0]["地市"] == "南宁"
    assert (data_dir / "小区.qml").exists(), "缺少样式 .qml"


def test_shapefile_mixed_geometry_skips_and_reports(temp_data_dir):
    """往 Shapefile 图层粘贴异类几何：按声明几何过滤并明确报告跳过数（不静默写丢）"""
    from app.services.layer_edit_service import create_empty_layer, save_layer_geojson

    r = create_empty_layer("点层", "point", "shp", user_id=1)
    fc = _feature_collection([{"n": "A"}])
    fc["features"].append({
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": [[114.0, 22.0], [114.1, 22.1]]},
        "properties": {"n": "B"},
    })
    res = save_layer_geojson(r["data_id"], r["layer_id"], fc, user_id=1)
    assert res["feature_count"] == 1
    assert res.get("skipped") == 1
    assert "跳过" in (res.get("warning") or "")


def test_layer_zip_packages_format_specific_files(temp_data_dir):
    """导出 zip 按格式打包：SHP 六件套 + .qml + 字段映射 sidecar"""
    import io
    import zipfile

    from app.services.layer_edit_service import (
        build_layer_zip, create_empty_layer, save_layer_geojson,
    )

    r = create_empty_layer("打包", "point", "shp", user_id=1)
    # 必须带逐要素样式，否则 .qml 不会被写出（无样式时删除旧 .qml 是预期行为）
    save_layer_geojson(r["data_id"], r["layer_id"],
                       _feature_collection([{"小区名称": "A"}],
                                           [{"markerColor": "#e31a1c", "markerSize": 8}]),
                       user_id=1)

    blob, filename = build_layer_zip(r["data_id"], r["layer_id"])
    assert filename.endswith(".shp.zip")
    names = sorted(zipfile.ZipFile(io.BytesIO(blob)).namelist())
    for ext in (".shp", ".shx", ".dbf", ".prj", ".cpg", ".qml"):
        assert any(n.endswith(ext) for n in names), f"zip 缺少 {ext}: {names}"
    assert any(n.endswith("nptfields.json") for n in names), f"zip 缺少字段映射: {names}"
