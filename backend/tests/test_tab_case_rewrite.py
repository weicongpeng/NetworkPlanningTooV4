"""临时验证：大写后缀 .TAB 源文件的整层重写保存（大小写不敏感删除 + 小写路径归一）。"""
import json
import tempfile
from pathlib import Path

import geopandas as gpd
from shapely.geometry import Point

from app.services.tab_io import write_mapinfo_tab, verify_tab_readable
from app.services.layer_edit_service import save_layer_geojson


def test_uppercase_tab_source_rewrite(monkeypatch):
    tmp = Path(tempfile.mkdtemp())
    from app.core.config import settings
    monkeypatch.setattr(settings, "DATA_DIR", tmp, raising=False)
    # 模拟导入的大写后缀 TAB（含配套文件）
    for ext in (".TAB", ".DAT", ".MAP", ".ID"):
        (tmp / f"河源5G-TAC{ext}").write_bytes(b"x")
    # 造一个可读 TAB（小写写出后重命名为大写，模拟用户原始文件）
    gdf = gpd.GeoDataFrame(
        {"name": ["a"], "NPT_FEATSYM": [""], "NPT_FEATMETA": [""]},
        geometry=gpd.GeoSeries([Point(116, 39)], crs="EPSG:4326"),
    )
    write_mapinfo_tab(gdf, tmp / "河源5G-TAC.tab", geometry_type="Point")
    for ext in (".tab", ".dat", ".map", ".id"):
        (tmp / f"河源5G-TAC{ext}").replace(tmp / f"河源5G-TAC{ext.upper()}")
    (tmp / "layers.json").write_text(json.dumps([{
        "id": "L1", "name": "河源5G-TAC", "type": "point",
        "metadata": {"source_file": str(tmp / "河源5G-TAC.TAB")},
    }], ensure_ascii=False), encoding="utf-8")

    geojson = {"type": "FeatureCollection", "features": [{
        "type": "Feature",
        "properties": {"name": "p1", "_editId": "e1", "_isNew": True,
                       "_editStyle": {"markerShape": "square", "markerSize": 8,
                                      "markerColor": "#ff0000"}},
        "geometry": {"type": "Point", "coordinates": [116.001, 39.001]},
    }]}
    r = save_layer_geojson(str(tmp.parent / tmp.name), "L1", geojson)
    assert r["success"] is True and r["feature_count"] == 1

    files = sorted(f.name for f in tmp.iterdir()
                   if f.suffix.lower() in {".tab", ".dat", ".map", ".id"})
    # 旧大写配套文件已清除，新文件为小写后缀（stem 本身含 5G-TAC 大写属正常）
    assert all(f.suffix == f.suffix.lower() for f in
               [tmp / n for n in files]), files

    entry = json.loads((tmp / "layers.json").read_text(encoding="utf-8"))[0]
    sf = Path(entry["metadata"]["source_file"])
    assert sf.exists(), f"source_file 路径不存在: {sf}"
    assert sf.suffix == ".tab"
    verify_tab_readable(sf, 1)

    # 二次保存（旧 schema 已含 NPT 列）仍成功
    r2 = save_layer_geojson(str(tmp), "L1", geojson)
    assert r2["success"] is True

    # 导出链路：build_layer_zip 打包的必须是保存后的当前 TAB（含编辑后要素）
    import io
    import zipfile
    from app.services.layer_edit_service import build_layer_zip, build_data_layers_zip
    zip_bytes, filename = build_layer_zip(str(tmp), "L1")
    assert filename == "河源5G-TAC.tab.zip"
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()
        assert "河源5G-TAC.tab" in names, names
        gdf_out = gpd.read_file(io.BytesIO(zip_bytes), engine="pyogrio")
        assert len(gdf_out) == 1

    # 方案B：数据条目级下载打包当前图层 + uploadDate 时间戳同步
    data_zip, n = build_data_layers_zip(str(tmp))
    assert n >= 1
    with zipfile.ZipFile(io.BytesIO(data_zip)) as zf:
        assert "河源5G-TAC.tab" in zf.namelist()
    from app.services.data_service import data_service
    # 注册临时条目并隔离 _save_index（避免污染真实 index.json）
    monkeypatch.setattr(data_service, "_save_index", lambda: None, raising=False)
    data_service.index[str(tmp)] = {
        "id": str(tmp), "name": "5G TAC.zip", "type": "map", "subType": "mapinfo",
        "size": 0, "uploadDate": "2020-01-01T00:00:00", "status": "ready", "metadata": {},
    }
    save_layer_geojson(str(tmp), "L1", geojson)
    idx = data_service.index.get(str(tmp))
    assert idx is not None
    assert idx["uploadDate"] > "2020-01-01T00:00:00"
    data_service.index.pop(str(tmp), None)
