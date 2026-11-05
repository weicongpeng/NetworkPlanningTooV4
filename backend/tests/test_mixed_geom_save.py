"""混合几何保存：把点粘贴到面图层（基站复制→TAC 面图层粘贴）时的降级与校验。"""
import json
import tempfile
from pathlib import Path

import geopandas as gpd
from shapely.geometry import Polygon, Point

from app.services.tab_io import write_mapinfo_tab
from app.services.layer_edit_service import save_layer_geojson


def _poly_fc():
    def ring(x0, y0):
        return [[x0, y0], [x0 + 0.01, y0], [x0 + 0.01, y0 + 0.01], [x0, y0 + 0.01], [x0, y0]]
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"name": "p1"},
         "geometry": {"type": "Polygon", "coordinates": [ring(116.0, 39.0)]}},
        {"type": "Feature", "properties": {"name": "p2"},
         "geometry": {"type": "Polygon", "coordinates": [ring(116.1, 39.1)]}},
    ]}


def test_paste_point_into_polygon_layer(monkeypatch):
    tmp = Path(tempfile.mkdtemp())
    from app.core.config import settings
    monkeypatch.setattr(settings, "DATA_DIR", tmp, raising=False)

    # 面图层：先写入 2 个面
    gdf = gpd.GeoDataFrame(
        {"name": ["p1", "p2"]},
        geometry=[Polygon([(116.0, 39.0), (116.01, 39.0), (116.01, 39.01), (116.0, 39.01)]),
                  Polygon([(116.1, 39.1), (116.11, 39.1), (116.11, 39.11), (116.1, 39.11)])],
        crs="EPSG:4326",
    )
    write_mapinfo_tab(gdf, tmp / "tac.tab", geometry_type="Polygon")
    (tmp / "layers.json").write_text(json.dumps([{
        "id": "L1", "name": "tac", "type": "polygon",
        "metadata": {"source_file": str(tmp / "tac.tab")},
    }], ensure_ascii=False), encoding="utf-8")

    # 2 面 + 1 点（模拟粘贴基站要素）→ 混合几何
    fc = _poly_fc()
    fc["features"].append({
        "type": "Feature",
        "properties": {"name": "sector1", "pci": 123,
                       "attributes": json.dumps({"厂家": "华为"}, ensure_ascii=False)},
        "geometry": {"type": "Point", "coordinates": [116.05, 39.05]},
    })
    r = save_layer_geojson(str(tmp), "L1", fc)
    assert r["success"] is True
    # 混合写入失败时降级为面、跳过 1 个点；TAB 支持混合时 3 个都写入
    assert r["feature_count"] in (2, 3), r
    if r["feature_count"] == 2:
        assert r.get("skipped") == 1, r
    # 落盘结果可读，且粘贴要素带来的新属性列（pci）已扩展进 schema
    out = gpd.read_file(tmp / "tac.tab")
    assert len(out) == r["feature_count"]
    assert "pci" in out.columns, list(out.columns)
    row = out[out["name"] == "sector1"]
    if len(row) == 1:
        assert float(row.iloc[0]["pci"]) == 123.0


def test_nested_property_scalarized(monkeypatch):
    """属性值含嵌套对象时不应让整层保存失败（转为 JSON 字符串写入）。"""
    tmp = Path(tempfile.mkdtemp())
    from app.core.config import settings
    monkeypatch.setattr(settings, "DATA_DIR", tmp, raising=False)

    gdf = gpd.GeoDataFrame(
        {"name": ["p1"], "attributes": ["{}"]},
        geometry=[Point(116.0, 39.0)],
        crs="EPSG:4326",
    )
    write_mapinfo_tab(gdf, tmp / "pt.tab", geometry_type="Point")
    (tmp / "layers.json").write_text(json.dumps([{
        "id": "L1", "name": "pt", "type": "point",
        "metadata": {"source_file": str(tmp / "pt.tab")},
    }], ensure_ascii=False), encoding="utf-8")

    fc = {"type": "FeatureCollection", "features": [{
        "type": "Feature",
        "properties": {"name": "s1", "attributes": {"厂家": "华为", "band": 3}},
        "geometry": {"type": "Point", "coordinates": [116.001, 39.001]},
    }]}
    r = save_layer_geojson(str(tmp), "L1", fc)
    assert r["success"] is True and r["feature_count"] == 1
    out = gpd.read_file(tmp / "pt.tab")
    assert len(out) == 1
