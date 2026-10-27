"""
绘制缓冲区服务测试

缓冲核心几何使用真实算法（AEQD + shapely），参考图层通过 monkeypatch 替换
load_layer_features（合成 shapely 要素，不依赖真实文件）；mapinfo 保存链路
monkeypatch _resolve_layer_target / _read_tab_gdf / apply_layer_patch。
"""
import math
from pathlib import Path

import geopandas as gpd
import pytest

from shapely.geometry import Point, LineString, MultiPoint
from shapely.ops import transform

from app.services import buffer_service as svc
from app.services.attribute_join_service import JoinFeature
from app.services.buffer_service import run_buffer
from app.services.layer_patch_service import LayerVersionConflict


def hav(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


@pytest.fixture(autouse=True)
def _patch_loader(monkeypatch):
    """默认空参考图层；各用例自行覆盖。"""
    monkeypatch.setattr(svc, "load_layer_features", lambda ref, g=None: ([], []))
    return monkeypatch


def _cfg(target=None, radius=1000.0, segments=12, mode="each"):
    return {
        "source": {"kind": "mapinfo", "dataId": "d1", "layerId": "l1"},
        "target": target or {"kind": "decoration"},
        "radius": radius,
        "segments": segments,
        "mode": mode,
    }


def _load(monkeypatch, feats, skipped=None):
    monkeypatch.setattr(
        svc, "load_layer_features", lambda ref, g=None: (feats, skipped or [])
    )


# ============================ 缓冲核心几何 ============================

def test_point_buffer_each_two_polygons(monkeypatch):
    lat, lon = 45.0, 116.0
    _load(monkeypatch, [
        JoinFeature("a", {}, Point(lon, lat)),
        JoinFeature("b", {}, Point(lon + 0.02, lat + 0.01)),
    ])
    stats = run_buffer(_cfg(radius=1000, segments=12))
    assert stats["savedTo"] == "decoration"
    assert stats["inputCount"] == 2
    assert stats["resultCount"] == 2

    # 每个缓冲外环顶点距各自 GCJ02 中心约等于半径（0.6% 内；装饰层几何为 GCJ02）
    from app.utils.coordinate_transformer import CoordinateTransformer
    for f, (clat, clon) in zip(stats["features"], [(lat, lon), (lat + 0.01, lon + 0.02)]):
        ring = f["geometry"]["coordinates"][0]
        assert len(ring) == 13  # 12 段 + 闭合点
        glat, glon = CoordinateTransformer.wgs84_to_gcj02(clat, clon)
        ds = [hav(glat, glon, la, lo) for lo, la in ring[:-1]]
        assert min(ds) > 994 and max(ds) < 1006


def test_dissolve_overlapping_fuses_to_polygon(monkeypatch):
    # 近点（缓冲重叠）：重叠区域融合为一体，输出单个 Polygon（无重叠边界）
    _load(monkeypatch, [
        JoinFeature("a", {}, Point(116.0, 45.0)),
        JoinFeature("b", {}, Point(116.004, 45.0)),
    ])
    stats = run_buffer(_cfg(radius=1000, mode="dissolve"))
    assert stats["resultCount"] == 1
    geom = stats["features"][0]["geometry"]
    assert geom["type"] == "Polygon"


def test_dissolve_far_points_single_multipolygon(monkeypatch):
    # 远点（缓冲不相交）：仍是单个图层要素 MultiPolygon，含两个互不相连部分
    _load(monkeypatch, [
        JoinFeature("a", {}, Point(116.0, 45.0)),
        JoinFeature("b", {}, Point(116.2, 45.0)),
    ])
    stats = run_buffer(_cfg(radius=500, mode="dissolve"))
    assert stats["resultCount"] == 1
    geom = stats["features"][0]["geometry"]
    assert geom["type"] == "MultiPolygon"
    assert len(geom["coordinates"]) == 2


def test_line_buffer_width(monkeypatch):
    # 短南北直线，赤道附近，缓冲后垂直于线方向宽 ≈ 2R
    line = LineString([(116.0, 1.0), (116.0, 1.01)])
    _load(monkeypatch, [JoinFeature("l", {}, line)])
    stats = run_buffer(_cfg(radius=300))
    assert stats["resultCount"] == 1
    poly = stats["features"][0]["geometry"]
    assert poly["type"] == "Polygon"
    # 投回局部 AEQD：x 方向包围盒（垂直于南北线）≈ 600m
    from shapely.geometry import shape
    fwd_crs = "+proj=aeqd +lat_0=1.005 +lon_0=116.0 +datum=WGS84 +units=m"
    from pyproj import Transformer
    fwd = Transformer.from_crs("EPSG:4326", fwd_crs, always_xy=True).transform
    b = transform(fwd, shape(poly)).bounds
    assert 590 < b[2] - b[0] < 610


def test_multipoint_each_explodes(monkeypatch):
    mp = MultiPoint([(116.0, 45.0), (116.02, 45.0)])
    _load(monkeypatch, [JoinFeature("m", {}, mp)])
    stats = run_buffer(_cfg(radius=500))
    assert stats["resultCount"] == 2


def test_segments_mapping(monkeypatch):
    _load(monkeypatch, [JoinFeature("a", {}, Point(116.0, 45.0))])
    stats = run_buffer(_cfg(radius=200, segments=4))
    ring = stats["features"][0]["geometry"]["coordinates"][0]
    assert len(ring) == 5  # quad_segs=1 → 4 段
    stats12 = run_buffer(_cfg(radius=200, segments=12))
    assert len(stats12["features"][0]["geometry"]["coordinates"][0]) == 13


def test_decoration_properties_empty(monkeypatch):
    _load(monkeypatch, [JoinFeature("a", {"名称": "x"}, Point(116.0, 45.0))])
    stats = run_buffer(_cfg())
    # 只写几何：属性为空字典，不复制源属性
    assert stats["features"][0]["properties"] == {}


# ============================ 校验与异常 ============================

def test_invalid_radius():
    for r in (0, -10, 3_000_000):
        with pytest.raises(ValueError):
            run_buffer(_cfg(radius=r))


def test_invalid_segments():
    for s in (2, 400):
        with pytest.raises(ValueError):
            run_buffer(_cfg(segments=s))


def test_invalid_mode():
    with pytest.raises(ValueError):
        run_buffer(_cfg(mode="xxx"))


def test_empty_source_raises(monkeypatch):
    _load(monkeypatch, [])
    with pytest.raises(ValueError, match="无有效要素"):
        run_buffer(_cfg())


def test_all_skipped_raises(monkeypatch):
    _load(monkeypatch, [], [JoinFeature("a", {}, None, reason="missing_coordinates")])
    with pytest.raises(ValueError, match="经纬度"):
        run_buffer(_cfg())


def test_skipped_reported_in_stats(monkeypatch):
    skipped = [JoinFeature("a", {"名称": "缺坐标"}, None, reason="missing_coordinates")]
    _load(monkeypatch, [JoinFeature("b", {}, Point(116.0, 45.0))], skipped)
    stats = run_buffer(_cfg())
    assert stats["skippedCount"] == 1
    assert stats["skippedDetails"][0]["reason"] == "missing_coordinates"


def test_too_many_outputs(monkeypatch):
    _load(monkeypatch, [
        JoinFeature("a", {}, Point(116.0, 45.0)),
        JoinFeature("b", {}, Point(116.02, 45.0)),
    ])
    monkeypatch.setattr(svc, "MAX_OUTPUT_FEATURES", 1)
    with pytest.raises(ValueError, match="要素过多"):
        run_buffer(_cfg(radius=500))


def test_mapinfo_target_missing_info():
    with pytest.raises(ValueError):
        run_buffer(_cfg(target={"kind": "mapinfo"}))


# ============================ mapinfo 保存链路 ============================

def test_mapinfo_target_patch(monkeypatch):
    _load(monkeypatch, [JoinFeature("a", {}, Point(116.0, 45.0))])

    monkeypatch.setattr(svc, "_resolve_layer_target",
                        lambda d, l: ("data_dir", {}, Path("x.tab"), "polygon"))
    base_gdf = gpd.GeoDataFrame(
        {"geometry": [Point(116.0, 45.0), Point(116.01, 45.0)]},
        geometry="geometry", crs="EPSG:4326",
    )
    monkeypatch.setattr(svc, "_read_tab_gdf", lambda p: base_gdf)
    monkeypatch.setattr(svc, "layer_version", lambda p, l: '"v1"')

    captured = {}

    def _apply(d, l, patch, user_id=1):
        captured["patch"] = patch

    monkeypatch.setattr(svc, "apply_layer_patch", _apply)
    import app.api.v1.endpoints.map as map_module
    monkeypatch.setattr(map_module, "invalidate_map_data_cache", lambda: None)

    stats = run_buffer(_cfg(target={"kind": "mapinfo", "dataId": "d1", "layerId": "l1"}))
    assert stats["savedTo"] == "mapinfo"
    assert stats["layerId"] == "l1"

    patch = captured["patch"]
    assert patch["base"] == {"count": 2, "version": '"v1"'}
    assert patch["deletes"] == []
    assert len(patch["upserts"]) == 1
    upsert = patch["upserts"][0]
    assert upsert["row"] is None
    assert upsert["properties"] == {}
    # 几何已是 GCJ02：国内 GCJ 经度相对 WGS 有正向偏移（首环点 lng > 116）
    ring = upsert["geometry"]["coordinates"][0]
    assert any(lo > 116.0 for lo, la in ring)


def test_mapinfo_version_conflict_retries(monkeypatch):
    _load(monkeypatch, [JoinFeature("a", {}, Point(116.0, 45.0))])
    monkeypatch.setattr(svc, "_resolve_layer_target",
                        lambda d, l: ("data_dir", {}, Path("x.tab"), "polygon"))
    monkeypatch.setattr(svc, "_read_tab_gdf",
                        lambda p: gpd.GeoDataFrame(geometry=[Point(116, 45)], crs=4326))
    monkeypatch.setattr(svc, "layer_version", lambda p, l: '"v1"')

    def _raise(d, l, patch, user_id=1):
        raise LayerVersionConflict("changed")

    monkeypatch.setattr(svc, "apply_layer_patch", _raise)
    with pytest.raises(ValueError, match="请重试"):
        run_buffer(_cfg(target={"kind": "mapinfo", "dataId": "d1", "layerId": "l1"}))
