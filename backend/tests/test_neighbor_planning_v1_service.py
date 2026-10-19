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


class TestDistancePriority:
    """候选邻区距离优先：同站/近端邻区不得被远端邻区挤出截断。

    回归背景（41733-12 漏配）：同站同方位角异频小区（如 F/D 双层网）距离为 0，
    但旧评分中重合点方位角算出伪值 0°、facing_diff=180，角度分极低；
    且距离分(10-d)在 1km 内区分度不足、角度分(0~13)主导排序，
    导致远端"对打"邻区评分反超同站/近端邻区，候选数超 max_neighbors 时近端被截断。
    修复后排序键为 (distance 升序, score 降序)，100m 内不计算方位角。
    """

    @staticmethod
    def _dual_freq_source():
        """源站含同方位角异频双小区：-12(EARFCN=1870,az=0) 待规划，-11(EARFCN=1850) 同站"""
        return [_make_site("41733", [
            _make_sector("41733", "12", SOURCE_LAT, SOURCE_LON, 1870, azimuth=0.0),
            _make_sector("41733", "11", SOURCE_LAT, SOURCE_LON, 1850, azimuth=0.0),
        ])]

    @staticmethod
    def _facing_sites(prefix, count, dist_start, dist_end, earfcn=1850):
        """双向对打异频小区：分布在源正前方 ±30° 扇面，方位角朝向源（互相正对）"""
        sites = []
        for i in range(count):
            brg = -30.0 + 60.0 * i / max(count - 1, 1)
            d = dist_start + (dist_end - dist_start) * i / max(count - 1, 1)
            lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, brg, d)
            site_id = f"{prefix}{i}"
            sites.append(_make_site(site_id, [
                _make_sector(site_id, "1", lat, lon, earfcn, azimuth=(brg + 180) % 360),
            ]))
        return sites

    def _build_over_cap_case(self, planner_factory, max_neighbors=10):
        """稀疏对打场景：4个1.2km对打站(定站间距=1.2km稀疏) + 14个1.3~1.7km对打站，
        异频候选 = 同站1 + 4近 + 14远 = 19 个，超过 max_neighbors=10。"""
        source = self._dual_freq_source()
        control = self._facing_sites("CTL", 4, 1.2, 1.2)
        far = self._facing_sites("FAR", 14, 1.3, 1.7)
        targets = [source[0]] + control + far
        planner = planner_factory(source, targets, max_neighbors=max_neighbors)
        return planner, _plan(planner)  # 规划 iloc[0] = 41733-12(1870)

    def test_same_site_inter_freq_kept_when_over_cap(self, planner_factory):
        _, neighbors = self._build_over_cap_case(planner_factory)
        same_site = [n for n in neighbors if n.target_enodeb_id == "41733"]
        assert len(same_site) == 1
        assert same_site[0].target_key == "41733_11"
        assert same_site[0].distance == 0.0

    def test_nearer_facing_preferred_over_farer(self, planner_factory):
        _, neighbors = self._build_over_cap_case(planner_factory)
        inter = [n for n in neighbors if n.target_earfcn == 1850]
        assert len(inter) == 10  # 同站1 + 近端对打4 + 远端对打5（截断到门限）
        ctl_kept = [n for n in inter if n.target_enodeb_id.startswith("CTL")]
        far_kept = [n for n in inter if n.target_enodeb_id.startswith("FAR")]
        assert len(ctl_kept) == 4  # 近端对打站全部保留
        assert len(far_kept) == 5  # 远端对打站按距离保留最近的5个
        # 距离优先：保留的远端邻区距离升序，且都比近端站远
        far_dists = [n.distance for n in far_kept]
        assert far_dists == sorted(far_dists)
        assert min(n.distance for n in far_kept) > max(n.distance for n in ctl_kept)

    def test_kept_neighbors_sorted_by_distance(self, planner_factory):
        _, neighbors = self._build_over_cap_case(planner_factory)
        inter = [n for n in neighbors if n.target_earfcn == 1850]
        distances = [n.distance for n in inter]
        assert distances == sorted(distances)  # 同站(0km)排第一，整体距离升序
        assert distances[0] == 0.0

    def test_same_site_has_no_bogus_bearing(self, planner_factory):
        # 重合点方位角无意义：100m 内不计算角度，angle_diff 应为 None
        planner, neighbors = self._build_over_cap_case(planner_factory)
        same_site = [n for n in neighbors if n.target_enodeb_id == "41733"]
        assert len(same_site) == 1
        assert same_site[0].angle_diff is None


class TestSiteSpacingAndScenarios:
    """站间距计算（最近10个物理站点 / 相同经纬度去重 / 剔除室分）与两场景规划：
      - 密集（站间距 < 1000米）：2.5倍站间距范围内全量添加（不做覆盖圆/朝向判断）
      - 稀疏（站间距 ≥ 1000米）：覆盖圆相交 + 朝向闸门(±120°)
    """

    @staticmethod
    def _fan_sites(prefix, count, ring_km, earfcn, az_toward_source=False,
                   brg_start=-100.0, brg_end=100.0):
        """在源(az=0)前向扇面内均匀布置 count 个站点。

        默认方位角 -100°~+100°，全部落在 ±120° 朝向闸门内（源天线所打方向）；
        az_toward_source=True 时目标方位角朝向源（双向对打）。
        """
        sites = []
        for i in range(count):
            brg = (brg_start + (brg_end - brg_start) * i / max(count - 1, 1)) % 360
            lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, brg, ring_km)
            site_id = f"{prefix}{i}"
            az = (brg + 180) % 360 if az_toward_source else brg
            sites.append(_make_site(site_id, [
                _make_sector(site_id, "1", lat, lon, earfcn, azimuth=az),
            ]))
        return sites

    @staticmethod
    def _single_source(earfcn=1870, az=0.0):
        return [_make_site("SRC", [
            _make_sector("SRC", "1", SOURCE_LAT, SOURCE_LON, earfcn, azimuth=az),
        ])]

    @staticmethod
    def _spacing_targets():
        # 20 个室外站，距离 0.5~2.4km（每站递增 0.1km）
        targets = []
        for i in range(20):
            d = 0.5 + 0.1 * i
            lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, i * 18.0, d)
            site_id = f"SP{i}"
            targets.append(_make_site(site_id, [
                _make_sector(site_id, "1", lat, lon, 1850, azimuth=(i * 18.0 + 180) % 360),
            ]))
        return targets

    def test_site_spacing_outdoor_uses_nearest_9(self, planner_factory):
        targets = self._spacing_targets()
        planner = planner_factory(self._single_source(), targets, max_neighbors=64)
        spacing = planner.calculate_site_spacing(planner.source_cells_df.iloc[0])
        # 室外源取最近9站距离 0.5~1.3km → 平均 0.9km
        assert spacing == pytest.approx(0.9, abs=0.02)

    def test_site_spacing_indoor_uses_nearest_8(self, planner_factory):
        targets = self._spacing_targets()
        # 室分源
        indoor_src = [_make_site("IN", [
            _make_sector("IN", "1", SOURCE_LAT, SOURCE_LON, 1870, azimuth=0.0, cover_type=4),
        ])]
        planner = planner_factory(indoor_src, targets, max_neighbors=64)
        spacing = planner.calculate_site_spacing(planner.source_cells_df.iloc[0])
        # 室分源取最近8站距离 0.5~1.2km → 平均 0.85km
        assert spacing == pytest.approx(0.85, abs=0.02)

    def test_site_spacing_dedups_same_coordinates(self, planner_factory):
        # 10 个 0.5km 站 + 5 个与首站同经纬度但不同站ID的共址站（相同经纬度算1站）
        base = self._fan_sites("NEAR", 10, 0.5, 1850, az_toward_source=True)
        colocated = []
        first_lat, first_lon = base[0]["latitude"], base[0]["longitude"]
        for k in range(5):
            sid = f"CO{k}"
            colocated.append(_make_site(sid, [
                _make_sector(sid, "1", first_lat, first_lon, 1850, azimuth=0.0),
            ]))
        planner = planner_factory(self._single_source(), base + colocated, max_neighbors=64)
        spacing = planner.calculate_site_spacing(planner.source_cells_df.iloc[0])
        # 共址站同经纬度只算 1 个物理站点，最近10站仍为 0.5km 量级
        assert spacing == pytest.approx(0.5, abs=0.05)

    def test_dense_scenario_adds_all_within_1_3x_including_behind(self, planner_factory):
        # 10 个 0.5km 前向站 → 站间距≈0.5km(<1km) 密集场景，全量半径=1.3*0.5=0.65km
        targets = self._fan_sites("NEAR", 10, 0.5, 1850, az_toward_source=True)
        # 背后 0.6km（<0.65km）：密集场景不做朝向判断，应全量添加
        lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, 180.0, 0.6)
        targets.append(_make_site("P_BACK", [
            _make_sector("P_BACK", "1", lat, lon, 1850, azimuth=0.0),
        ]))
        # 前向 0.8km（>0.65km）：超出全量半径，不添加
        lat2, lon2 = _point_at(SOURCE_LAT, SOURCE_LON, 0.0, 0.8)
        targets.append(_make_site("P_FAR", [
            _make_sector("P_FAR", "1", lat2, lon2, 1850, azimuth=180.0),
        ]))
        planner = planner_factory(self._single_source(), targets, max_neighbors=64)
        neighbors = _plan(planner)
        kept = {n.target_enodeb_id for n in neighbors}
        assert "P_BACK" in kept                 # 密集：1.3x 内背后邻区也全量加
        assert "P_FAR" not in kept              # 超 1.3x 站间距不加
        assert sum(1 for k in kept if k.startswith("NEAR")) == 10  # 近端站全加

    def test_dense_scenario_includes_indoor_targets(self, planner_factory):
        # 室外源密集场景：1.3倍站间距内的室分目标也全量添加（室外→室分）
        targets = self._fan_sites("NEAR", 10, 0.5, 1850, az_toward_source=True)
        # 0.6km 室分站（<0.65km 全量半径）
        lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, 60.0, 0.6)
        targets.append(_make_site("IN600", [
            _make_sector("IN600", "1", lat, lon, 1850, azimuth=0.0, cover_type=4),
        ]))
        planner = planner_factory(self._single_source(), targets, max_neighbors=64)
        neighbors = _plan(planner)
        assert any(n.target_enodeb_id == "IN600" for n in neighbors)

    def test_dense_outdoor_to_indoor_behind_excluded(self, planner_factory):
        # 密集(站间距≈0.5km，全量半径0.65km)：室外→室分，前向室分加、背向室分不加
        targets = self._fan_sites("NEAR", 10, 0.5, 1850, az_toward_source=True)
        # 前向 60°、0.6km 室分（<0.65km，前向）：加
        lat_f, lon_f = _point_at(SOURCE_LAT, SOURCE_LON, 60.0, 0.6)
        targets.append(_make_site("IN_FWD", [
            _make_sector("IN_FWD", "1", lat_f, lon_f, 1850, azimuth=0.0, cover_type=4),
        ]))
        # 背向 180°、0.6km 室分（<0.65km 但在源天线背面）：不加
        lat_b, lon_b = _point_at(SOURCE_LAT, SOURCE_LON, 180.0, 0.6)
        targets.append(_make_site("IN_BACK", [
            _make_sector("IN_BACK", "1", lat_b, lon_b, 1850, azimuth=0.0, cover_type=4),
        ]))
        planner = planner_factory(self._single_source(), targets, max_neighbors=64)
        neighbors = _plan(planner)
        kept = {n.target_enodeb_id for n in neighbors}
        assert "IN_FWD" in kept
        assert "IN_BACK" not in kept


class TestIndoorRules:
    """室分场景（室分源全向，不做覆盖圆/朝向判断）：
       - 室分→室分：350米内添加
       - 室分→室外：站间距(到最近8个室外站)>350米按1.5倍站间距全量，否则350米内
    """

    @staticmethod
    def _indoor_source():
        return [_make_site("IN", [
            _make_sector("IN", "1", SOURCE_LAT, SOURCE_LON, 1870, azimuth=0.0, cover_type=4),
        ])]

    def test_indoor_to_indoor_within_350m(self, planner_factory):
        targets = [
            # 同站室分（距离0）
            _make_site("IN", [_make_sector("IN", "2", SOURCE_LAT, SOURCE_LON, 1850,
                                           azimuth=0.0, cover_type=4)]),
        ]
        # 300m 室分（<350m，加）
        lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, 0.0, 0.30)
        targets.append(_make_site("II300", [
            _make_sector("II300", "1", lat, lon, 1850, azimuth=0.0, cover_type=4),
        ]))
        # 500m 室分（>350m，不加）
        lat2, lon2 = _point_at(SOURCE_LAT, SOURCE_LON, 90.0, 0.50)
        targets.append(_make_site("II500", [
            _make_sector("II500", "1", lat2, lon2, 1850, azimuth=0.0, cover_type=4),
        ]))
        planner = planner_factory(self._indoor_source(), targets, max_neighbors=64)
        neighbors = _plan(planner)
        kept = {n.target_enodeb_id for n in neighbors}
        assert "IN" in kept          # 同站室分
        assert "II300" in kept       # 300m < 350m
        assert "II500" not in kept   # 500m > 350m

    def test_indoor_to_outdoor_1_5x_spacing(self, planner_factory):
        # 10 个室外站 0.6km → 室分到最近10室外站平均≈0.6km(>350m) → 全量半径=1.5*0.6=0.9km
        targets = TestSiteSpacingAndScenarios._fan_sites("OUT", 10, 0.6, 1850, az_toward_source=True)
        # 室外探针：0.8km（<0.9，加）、1.0km（>0.9，不加）
        lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, 45.0, 0.8)
        targets.append(_make_site("O800", [
            _make_sector("O800", "1", lat, lon, 1850, azimuth=225.0),
        ]))
        lat2, lon2 = _point_at(SOURCE_LAT, SOURCE_LON, -45.0, 1.0)
        targets.append(_make_site("O1000", [
            _make_sector("O1000", "1", lat2, lon2, 1850, azimuth=135.0),
        ]))
        planner = planner_factory(self._indoor_source(), targets, max_neighbors=64)
        neighbors = _plan(planner)
        kept = {n.target_enodeb_id for n in neighbors}
        assert "O800" in kept        # 0.8km < 0.9km 全量半径
        assert "O1000" not in kept   # 1.0km 超出


class TestDirectionGate:
    """稀疏场景（站间距 ≥ 1000米）：覆盖圆相交 + 朝向闸门（目标须在源天线
    前向 ±120° 内，背打排除）。300m 内强制邻区不受闸门影响。

    回归背景：覆盖圆是各向同性圆、仅向天线方向偏移半径一半，天线背后仍有
    覆盖，单靠圆相交会把背后小区误判为邻区（对打没加、背打反加）。
    """

    @staticmethod
    def _source():
        return [_make_site("SRC", [
            _make_sector("SRC", "1", SOURCE_LAT, SOURCE_LON, 1870, azimuth=0.0),
        ])]

    def _sparse_ctl(self):
        # 8 个 1.2km 双向对打站（±60°扇面，均互相正对）→ 最近4站=1.2km 稀疏
        return TestSiteSpacingAndScenarios._fan_sites(
            "CTL", 8, 1.2, 1850, az_toward_source=True, brg_start=-60.0, brg_end=60.0)

    @staticmethod
    def _sparse_planner_factor05(targets):
        """以生产系数0.5构造稀疏场景规划器（源 az=0 单扇区）"""
        config = NeighborConfig(
            source_type="LTE", target_type="LTE", max_neighbors=64,
            coverage_distance_factor=0.5, coverage_radius_factor=0.5,
        )
        planner = NeighborPlanner(config)
        src = [_make_site("SRC", [
            _make_sector("SRC", "1", SOURCE_LAT, SOURCE_LON, 1870, azimuth=0.0),
        ])]
        planner.load_data_from_sites(src, targets)
        return planner

    def test_sparse_coverage_intersecting_added(self):
        # 系数0.5稀疏：前向覆盖圆相交（≤1.5km对打）小区添加
        targets = TestSiteSpacingAndScenarios._fan_sites(
            "CTL", 8, 1.2, 1850, az_toward_source=True, brg_start=-60.0, brg_end=60.0)
        planner = self._sparse_planner_factor05(targets)
        assert planner.calculate_site_spacing(planner.source_cells_df.iloc[0]) >= 1.0
        neighbors = _plan(planner)
        assert len(neighbors) == 8     # 1.2km 前向对打站覆盖圆相交，全部添加

    def test_sparse_behind_noncoverage_not_added(self):
        # 稀疏：覆盖圆不相交的背向站点不添加（已还原为"仅覆盖圆+每频门限"）
        targets = TestSiteSpacingAndScenarios._fan_sites(
            "CTL", 8, 1.2, 1850, az_toward_source=True, brg_start=-60.0, brg_end=60.0)
        # 背向站（方位角背向源、az远离），系数0.5下覆盖圆不相交
        for name, d in [("B1", 1.3), ("B2", 1.4), ("B3", 1.5)]:
            lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, 180.0, d)
            targets.append(_make_site(name, [
                _make_sector(name, "1", lat, lon, 1850, azimuth=180.0),
            ]))
        planner = self._sparse_planner_factor05(targets)
        neighbors = _plan(planner)
        kept = {n.target_enodeb_id for n in neighbors}
        assert "B1" not in kept and "B2" not in kept and "B3" not in kept  # 非相交背向站不加

    def test_sparse_large_spacing_coverage_scales_to_reach(self):
        # 稀疏站间距2km + 系数0.5：覆盖圆距离按站间距缩放(2km)，对打邻区在
        # 前向约1.5倍站间距(3km)内相交——修复前固定1km覆盖圆够不着2km邻区，只剩本站。
        targets = TestSiteSpacingAndScenarios._fan_sites(
            "CTL", 8, 2.0, 1850, az_toward_source=True, brg_start=-60.0, brg_end=60.0)
        planner = self._sparse_planner_factor05(targets)
        assert planner.calculate_site_spacing(planner.source_cells_df.iloc[0]) >= 1.0
        neighbors = _plan(planner)
        assert len(neighbors) == 8        # 2km 对打邻区经覆盖圆缩放后全部加入
        # 背向2km站不加（方向性保留）
        lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, 180.0, 2.0)
        targets.append(_make_site("BACK", [
            _make_sector("BACK", "1", lat, lon, 1850, azimuth=180.0)]))
        planner2 = self._sparse_planner_factor05(targets)
        kept = {n.target_enodeb_id for n in _plan(planner2)}
        assert "BACK" not in kept

    def test_sparse_forward_noncoverage_far_facing_not_added(self):
        # 系数0.5稀疏：前向但覆盖圆不相交的远距对打站（2km > 1.5km 可达）不添加
        targets = TestSiteSpacingAndScenarios._fan_sites(
            "CTL", 8, 1.2, 1850, az_toward_source=True, brg_start=-60.0, brg_end=60.0)
        lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, 0.0, 2.0)
        targets.append(_make_site("FARFACE", [
            _make_sector("FARFACE", "1", lat, lon, 1850, azimuth=180.0),  # 正对源但2km
        ]))
        planner = self._sparse_planner_factor05(targets)
        neighbors = _plan(planner)
        assert not any(n.target_enodeb_id == "FARFACE" for n in neighbors)

    def test_outdoor_to_indoor_hard_rule(self, planner_factory):
        # 室外→室分硬规则（与稀疏/密集无关）：≤600米且前向才加；>600米 或 背向不加
        targets = self._sparse_ctl()
        lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, 0.0, 0.5)
        targets.append(_make_site("IN_FWD", [
            _make_sector("IN_FWD", "1", lat, lon, 1850, azimuth=0.0, cover_type=4)]))
        lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, 180.0, 0.5)
        targets.append(_make_site("IN_BACK", [
            _make_sector("IN_BACK", "1", lat, lon, 1850, azimuth=0.0, cover_type=4)]))
        lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, 0.0, 0.8)
        targets.append(_make_site("IN_FAR", [
            _make_sector("IN_FAR", "1", lat, lon, 1850, azimuth=0.0, cover_type=4)]))
        planner = planner_factory(self._source(), targets, max_neighbors=64)
        neighbors = _plan(planner)
        kept = {n.target_enodeb_id for n in neighbors}
        assert "IN_FWD" in kept       # ≤600米 前向：加
        assert "IN_BACK" not in kept  # ≤600米 背向：不加
        assert "IN_FAR" not in kept   # 800米>600米：不加

    def test_forced_close_neighbor_not_affected_by_gate(self, planner_factory):
        # 稀疏场景下，300m 内强制邻区不受朝向闸门影响（极近站间切换必需）
        targets = TestSiteSpacingAndScenarios._fan_sites("CTL", 12, 1.2, 1850, az_toward_source=True)
        lat, lon = _point_at(SOURCE_LAT, SOURCE_LON, 180.0, 0.15)  # 背后 150m
        targets.append(_make_site("CLOSEBACK", [
            _make_sector("CLOSEBACK", "1", lat, lon, 1850, azimuth=0.0),
        ]))
        planner = planner_factory(self._source(), targets, max_neighbors=64)
        neighbors = _plan(planner)
        assert any(n.target_enodeb_id == "CLOSEBACK" for n in neighbors)


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
