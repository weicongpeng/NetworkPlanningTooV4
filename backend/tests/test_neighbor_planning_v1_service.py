"""
邻区规划 v1 算法测试 - 聚焦 同频/异频 各自 max_neighbors 上限

回归背景：原算法只对"候选邻区"截断，强制邻区(300m/160m)与兜底邻区不受限，
导致小区邻区总数可远超 max_neighbors（如待规划小区 41733-31 出现 85 个邻区）。
修复后：最终邻区按源/目标小区 EARFCN 是否相同分为 同频/异频 两类，
每类分别按评分排序并截断到 max_neighbors（总数 = 同频≤N + 异频≤N）。
"""
import math

import pytest

from app.algorithms.neighbor_planning_v1_service import NeighborPlanner, NeighborConfig


def _make_sector(site_id: str, cell_id: str, lat: float, lon: float,
                 earfcn, azimuth: float = 0.0, cover_type: int = 1) -> dict:
    """构造一个扇区字典（与 load_data_from_sites 期望的字段一致）"""
    return {
        "id": cell_id,
        "name": f"{site_id}_{cell_id}",
        "pci": int(cell_id) % 503,
        "latitude": lat,
        "longitude": lon,
        "earfcn": earfcn,
        "azimuth": azimuth,
        "cell_cover_type": cover_type,
    }


def _make_site(site_id: str, sectors: list) -> dict:
    """构造一个站点字典"""
    first = sectors[0]
    return {
        "id": site_id,
        "latitude": first["latitude"],
        "longitude": first["longitude"],
        "sectors": sectors,
    }


def _point_at(lat: float, lon: float, bearing_deg: float, dist_km: float) -> tuple:
    """从 (lat, lon) 沿 bearing 方向偏移 dist_km，返回 (lat, lon)。"""
    r = 6371.0
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    brg = math.radians(bearing_deg)
    ang = dist_km / r
    lat2 = math.asin(math.sin(lat1) * math.cos(ang) +
                     math.cos(lat1) * math.sin(ang) * math.cos(brg))
    lon2 = lon1 + math.atan2(math.sin(brg) * math.sin(ang) * math.cos(lat1),
                             math.cos(ang) - math.sin(lat1) * math.sin(lat2))
    return math.degrees(lat2), math.degrees(lon2)


def _build_targets(count: int, earfcn, center_lat: float = 0.0, center_lon: float = 0.0,
                   ring_km: float = 0.15, start_idx: int = 0) -> list:
    """在源小区周围环形布置 count 个目标小区（均落在 300m 强制邻区内）。"""
    sites = []
    for i in range(count):
        lat, lon = _point_at(center_lat, center_lon, (360.0 / count) * i, ring_km)
        site_id = f"TGT{i + start_idx}"
        sites.append(_make_site(site_id, [
            _make_sector(site_id, f"1", lat, lon, earfcn, azimuth=(360.0 / count) * i),
        ]))
    return sites


def _plan(planner: NeighborPlanner) -> list:
    """对唯一的源小区执行邻区规划"""
    source_row = planner.source_cells_df.iloc[0]
    return planner.plan_neighbors_for_cell(source_row)


@pytest.fixture
def planner_factory():
    """构造一个已加载源/目标数据的 NeighborPlanner"""

    def _build(source_sites, target_sites, max_neighbors=10):
        config = NeighborConfig(
            source_type="LTE",
            target_type="LTE",
            max_neighbors=max_neighbors,
            coverage_distance_factor=1.0,
            coverage_radius_factor=1.0,
        )
        planner = NeighborPlanner(config)
        planner.load_data_from_sites(source_sites, target_sites)
        return planner

    return _build


SOURCE_LAT, SOURCE_LON = 0.0, 0.0


def _source_sites() -> list:
    """单个源小区（EARFCN=100），位于原点"""
    return [_make_site("SRC", [
        _make_sector("SRC", "1", SOURCE_LAT, SOURCE_LON, 100, azimuth=0.0),
    ])]


class TestPerFrequencyCap:
    """同频/异频 各自按 max_neighbors 上限"""

    def test_same_freq_capped_at_max_neighbors(self, planner_factory):
        # 20 个同频(EARFCN=100)目标，max_neighbors=10 → 同频只保留 10 个
        targets = _build_targets(20, earfcn=100)
        planner = planner_factory(_source_sites(), targets, max_neighbors=10)
        neighbors = _plan(planner)
        same = [n for n in neighbors if n.target_earfcn == 100]
        assert len(neighbors) == 10
        assert len(same) == 10

    def test_inter_freq_capped_at_max_neighbors(self, planner_factory):
        # 20 个异频(EARFCN=200)目标，max_neighbors=10 → 异频只保留 10 个
        targets = _build_targets(20, earfcn=200)
        planner = planner_factory(_source_sites(), targets, max_neighbors=10)
        neighbors = _plan(planner)
        assert len(neighbors) == 10
        assert all(n.target_earfcn == 200 for n in neighbors)

    def test_total_can_exceed_max_neighbors_when_both_freqs(self, planner_factory):
        # 20 同频 + 20 异频，max_neighbors=10 → 总数 20（同频 10 + 异频 10）
        targets = _build_targets(20, earfcn=100) + _build_targets(20, earfcn=200, start_idx=100)
        planner = planner_factory(_source_sites(), targets, max_neighbors=10)
        neighbors = _plan(planner)
        same = [n for n in neighbors if n.target_earfcn == 100]
        inter = [n for n in neighbors if n.target_earfcn == 200]
        assert len(neighbors) == 20
        assert len(same) == 10
        assert len(inter) == 10

    def test_forced_neighbors_also_count_toward_cap(self, planner_factory):
        # 所有目标都在 300m 内（全为强制邻区），同频/异频各自仍被截断到 max_neighbors
        targets = _build_targets(15, earfcn=100) + _build_targets(15, earfcn=200, start_idx=100)
        planner = planner_factory(_source_sites(), targets, max_neighbors=10)
        neighbors = _plan(planner)
        assert len(neighbors) == 20
        assert sum(1 for n in neighbors if n.target_earfcn == 100) == 10
        assert sum(1 for n in neighbors if n.target_earfcn == 200) == 10

    def test_missing_frequency_classified_as_inter(self, planner_factory):
        # 目标无 EARFCN → 视为异频（不占用同频预算）
        targets = _build_targets(5, earfcn=None)
        targets += _build_targets(5, earfcn=100, start_idx=100)
        planner = planner_factory(_source_sites(), targets, max_neighbors=10)
        neighbors = _plan(planner)
        same = [n for n in neighbors if n.target_earfcn == 100]
        assert len(neighbors) == 10  # 5 同频 + 5 异频
        assert len(same) == 5

    def test_no_duplicate_target_keys(self, planner_factory):
        # 合并候选/兜底/强制后不出现重复目标
        targets = _build_targets(20, earfcn=100) + _build_targets(20, earfcn=200, start_idx=100)
        planner = planner_factory(_source_sites(), targets, max_neighbors=10)
        neighbors = _plan(planner)
        keys = [n.target_key for n in neighbors]
        assert len(keys) == len(set(keys))


class TestNeighborScores:
    """评分排序：同频/异频 各自按评分降序保留"""

    def test_higher_score_kept_within_cap(self, planner_factory):
        # 距离越近评分越高，被截断掉的应是较远的小区
        targets = _build_targets(20, earfcn=100)
        # 把前 10 个目标放到 80m 处（更近），其余保持 150m
        for i, site in enumerate(targets):
            if i < 10:
                lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, (360.0 / 20) * i, 0.08)
                site["latitude"] = lat
                site["longitude"] = lon
                site["sectors"][0]["latitude"] = lat
                site["sectors"][0]["longitude"] = lon
        planner = planner_factory(_source_sites(), targets, max_neighbors=10)
        neighbors = _plan(planner)
        assert len(neighbors) == 10
        # 保留的 10 个目标全部来自 80m 的近距离组
        kept_distances = sorted(n.distance for n in neighbors)
        assert all(d <= 0.1 for d in kept_distances)
