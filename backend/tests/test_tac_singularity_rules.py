"""TAC 插花判定规则回归测试

覆盖：
- 判定口径：`异TAC占比（= 1 − 本站TAC在周边的加权占比）≥ 阈值` 且 `本站TAC ≠ 周边主流TAC`
- 碎片化区域（周边无主流TAC）中，本站TAC在周边几乎不存在 → 应判插花（旧实现用主流占比判断会漏判）
- 本站TAC即周边主流 → 不判插花
- 复合键：不同站点共用相同 sectorId 时不得互相连坐，插花详情必须归属自身
"""
import math

import pytest

from app.services.tac_planning_service import SUGGEST_RECHECK_TEXT, TACPlanningService


def _cell(site_id: str, sector_id: str, lon: float, lat: float, tac, name: str = ""):
    return {
        "siteId": site_id,
        "sectorId": sector_id,
        "siteName": f"站点{site_id}",
        "sectorName": name or f"小区{site_id}_{sector_id}",
        "longitude": lon,
        "latitude": lat,
        "existingTac": tac,
    }


def _ring_neighbors(base_lon: float, base_lat: float, tac_counts: dict,
                    prefix: str = "N", radius_deg: float = 0.003):
    """把邻区均匀排布在基准坐标同一半径的圆环上

    距离权重 weight = 1/(distance+100) 只与距离有关，等半径可让各 TAC 的权重占比≈数量占比，
    避免最近邻区权重过大导致判定结果不可预期。
    """
    tacs = []
    for tac, count in tac_counts.items():
        tacs += [tac] * count
    total = len(tacs)
    cells = []
    for i, tac in enumerate(tacs):
        angle = 2 * math.pi * i / total
        dlat = radius_deg * math.sin(angle)
        dlon = radius_deg * math.cos(angle) / math.cos(math.radians(base_lat))
        cells.append(_cell(
            f"{prefix}{i + 1}", f"{i + 1}",
            base_lon + dlon, base_lat + dlat, tac,
        ))
    return cells


class TestSingularityCondition:
    def test_fragmented_area_flags_minority_tac(self, tmp_path):
        """周边TAC碎片化（无多数派）时，本站TAC在周边几乎不存在也应判插花"""
        svc = TACPlanningService(tmp_path)
        target = _cell("S1", "1", 114.70, 23.79, "1", name="碎片区目标小区")
        neighbors = _ring_neighbors(114.70, 23.79, {"2": 9, "3": 8, "4": 8})

        out = svc.check_tac_singularity(
            [target], [target] + neighbors, search_radius=1500, singularity_threshold=0.5
        )

        assert len(out) == 1
        rec = out[0]
        assert rec["sectorId"] == "1"
        assert rec["cellTacRatio"] == 0.0
        assert rec["异TAC占比"] == 100.0
        assert rec["异TAC占比"] == round(100 - rec["cellTacRatio"], 2)
        # 无多数派：主流TAC占比 < 50%（旧口径按主流占比判断会漏判本小区）
        assert rec["dominantTacRatio"] < 50

    def test_majority_cell_not_singularity(self, tmp_path):
        """本站TAC即周边主流 → 不判插花"""
        svc = TACPlanningService(tmp_path)
        target = _cell("S1", "1", 114.70, 23.79, "5", name="主流TAC小区")
        neighbors = _ring_neighbors(114.70, 23.79, {"5": 12, "7": 6})

        out = svc.check_tac_singularity(
            [target], [target] + neighbors, search_radius=1500, singularity_threshold=0.5
        )

        assert out == []

    def test_classic_island_is_singularity(self, tmp_path):
        """被另一种明确主流TAC包围的孤岛 → 判插花"""
        svc = TACPlanningService(tmp_path)
        target = _cell("S1", "1", 114.70, 23.79, "9", name="孤岛小区")
        neighbors = _ring_neighbors(114.70, 23.79, {"7": 19, "9": 1})

        out = svc.check_tac_singularity(
            [target], [target] + neighbors, search_radius=1500, singularity_threshold=0.5
        )

        assert len(out) == 1
        assert out[0]["dominantTac"] == "7"
        assert out[0]["异TAC占比"] > 80
        assert out[0]["cellTacRatio"] < 20

    def test_threshold_boundary(self, tmp_path):
        """异TAC占比约 64%：阈值 0.7 不判、阈值 0.5 判"""
        svc = TACPlanningService(tmp_path)
        target = _cell("S1", "1", 114.70, 23.79, "1", name="阈值边界小区")
        neighbors = _ring_neighbors(114.70, 23.79, {"1": 5, "2": 7, "3": 2})
        pool = [target] + neighbors

        strict = svc.check_tac_singularity(
            [target], pool, search_radius=1500, singularity_threshold=0.7
        )
        loose = svc.check_tac_singularity(
            [target], pool, search_radius=1500, singularity_threshold=0.5
        )

        assert strict == []
        assert len(loose) == 1
        assert 50 <= loose[0]["异TAC占比"] < 70


class TestCompositeKeyIdentity:
    def test_no_cross_site_collision_and_details_are_self(self, tmp_path):
        """两个站点共用相同 sectorId：只有真插花站点被标记，详情归属自身"""
        svc = TACPlanningService(tmp_path)
        cells = []
        # 站点A（1001）：本站TAC=5 即周边主流 → 不应判插花
        cells += [
            _cell("1001", "1", 114.70, 23.79, "5", name="A小区1"),
            _cell("1001", "2", 114.70, 23.79, "5", name="A小区2"),
        ]
        cells += _ring_neighbors(114.70, 23.79, {"5": 12, "7": 3}, prefix="A邻")
        # 站点B（2002）：本站TAC=9 在周边占比≈0、周边主流=7 → 应判插花
        cells += [
            _cell("2002", "1", 115.50, 24.50, "9", name="B小区1"),
            _cell("2002", "2", 115.50, 24.50, "9", name="B小区2"),
        ]
        cells += _ring_neighbors(115.50, 24.50, {"7": 12, "9": 1}, prefix="B邻")

        svc.load_tac_layers = lambda *a, **k: {}
        svc.load_cells = lambda *a, **k: cells
        svc.match_cell_to_tac = lambda cell, zones, network_type=None: "1"  # 图层TAC统一为1 → 全部"错配"

        results, _matched, _unmatched, _mismatched, singularity_count = svc.plan_tac(
            "LTE", True, {"search_radius": 1500, "singularity_threshold": 0.5}
        )

        by_key = {(r["siteId"], r["sectorId"]): r for r in results}
        # A 站两个小区与 B 站共用 sectorId 1/2：修复前会被 B 站连坐标记为插花
        for sid in ("1", "2"):
            assert by_key[("1001", sid)]["isSingularity"] is False
        # B 站两个小区判插花，且详情必须来自自身（修复前详情会取到 A 站同 id 小区）
        for sid in ("1", "2"):
            rec = by_key[("2002", sid)]
            assert rec["isSingularity"] is True
            details = rec["singularityDetails"]
            assert details["siteId"] == "2002"
            assert details["sectorId"] == sid
            assert details["sectorName"] == f"B小区{sid}"

        # 标记数 = B 站 2 个 + B 周边 1 个少数派(9) 小区
        assert singularity_count >= 2


class TestSuggestedTac:
    def test_suggested_tac_by_branch(self, tmp_path):
        """TAC建议值：插花→图层TAC；不一致且非插花→人工核查提示；一致→空"""
        svc = TACPlanningService(tmp_path)
        cells = []
        # 一致小区（现网TAC=图层TAC=5）→ 建议值为空
        cells.append(_cell("1001", "1", 114.00, 23.00, "5", name="一致小区"))
        cells += _ring_neighbors(114.00, 23.00, {"5": 12, "8": 2}, prefix="一邻")
        # 插花小区（现网9，周边主流7）→ 建议值取图层TAC
        cells.append(_cell("2002", "1", 115.00, 24.00, "9", name="插花小区"))
        cells += _ring_neighbors(115.00, 24.00, {"7": 12, "9": 1}, prefix="二邻")
        # 错配但非插花（现网TAC=5 即周边主流，图层TAC=1）→ 建议值为人工核查提示
        cells.append(_cell("3003", "1", 116.00, 25.00, "5", name="错配非插花小区"))
        cells += _ring_neighbors(116.00, 25.00, {"5": 12, "8": 2}, prefix="三邻")

        svc.load_tac_layers = lambda *a, **k: {}
        svc.load_cells = lambda *a, **k: cells

        def fake_match(cell, zones, network_type=None):
            # 站点1001 的图层TAC与其现网一致；其余站点图层TAC统一为 1（均错配）
            if str(cell["siteId"]) == "1001":
                return cell.get("existingTac")
            return "1"

        svc.match_cell_to_tac = fake_match

        results, *_ = svc.plan_tac(
            "LTE", True, {"search_radius": 1500, "singularity_threshold": 0.5}
        )
        by_key = {(r["siteId"], r["sectorId"]): r for r in results}

        consistent = by_key[("1001", "1")]
        assert consistent["isSingularity"] is False
        assert consistent["suggestedTac"] is None

        singularity = by_key[("2002", "1")]
        assert singularity["isSingularity"] is True
        assert singularity["suggestedTac"] == "1"  # 插花：取图层TAC

        mismatch_only = by_key[("3003", "1")]
        assert mismatch_only["isSingularity"] is False
        assert mismatch_only["suggestedTac"] == SUGGEST_RECHECK_TEXT


# 3000m 对应的纬度度数（1° 纬度 ≈ 111320m），用于按真实距离排布站点
_DEG_PER_3000M = 3000 / 111320.0


def _site_cells(site_id: str, lon: float, lat: float, tac, count: int = 3):
    """一个物理点上的多个小区（同坐标）"""
    return [_cell(site_id, str(i + 1), lon, lat, tac) for i in range(count)]


class TestSpacingFactorRadius:
    def test_radius_is_factor_times_mean_of_4_nearest(self, tmp_path):
        """沿经线每 3000m 一个站点：半径 = 系数 × 最近4个站间距均值"""
        svc = TACPlanningService(tmp_path)
        pool = []
        for i in range(5):  # S0..S4，间距 3000m
            pool += _site_cells(f"S{i}", 115.0, 23.0 + i * _DEG_PER_3000M, "1")

        radius_map = svc._build_search_radius_map(pool, spacing_factor=2.0)

        # S0 在最南端：最近4个站间距 = 3000/6000/9000/12000 → 均值 7500 → 半径 15000
        assert radius_map["S0_1"] == pytest.approx(15000, abs=50)
        assert radius_map["S0_3"] == pytest.approx(15000, abs=50)  # 同物理点的小区半径一致
        # S2 居中：3000/3000/6000/6000 → 均值 4500 → 半径 9000
        assert radius_map["S2_1"] == pytest.approx(9000, abs=50)

    def test_physical_points_merge_within_100m(self, tmp_path):
        """100m 内的两个小区合并为一个物理点（不重复计入站间距）"""
        svc = TACPlanningService(tmp_path)
        pool = [
            _cell("A", "1", 115.0, 23.0, "1"),
            _cell("A", "2", 115.0 + 0.00005, 23.0, "1"),  # 距 A_1 约 5m → 合并
        ]
        pool += _site_cells("B", 115.0, 23.0 + 1000 / 111320.0, "1", count=1)
        pool += _site_cells("C", 115.0, 23.0 + 2000 / 111320.0, "1", count=1)
        pool += _site_cells("D", 115.0, 23.0 + 3000 / 111320.0, "1", count=1)

        radius_map = svc._build_search_radius_map(pool, spacing_factor=2.0)

        # 合并后：最近4个 → 只有 1000/2000/3000 三个点 → 均值 2000 → 半径 4000
        assert radius_map["A_1"] == pytest.approx(4000, abs=50)
        assert radius_map["A_2"] == pytest.approx(4000, abs=50)

    def test_points_beyond_100m_not_merged(self, tmp_path):
        """相隔 150m 的两个小区算两个物理点（站间距要把对方算进去）"""
        svc = TACPlanningService(tmp_path)
        pool = [
            _cell("A", "1", 115.0, 23.0, "1"),
            _cell("B", "1", 115.0, 23.0 + 150 / 111320.0, "1"),  # 距 A_1 约 150m → 不合并
        ]
        pool += _site_cells("C", 115.0, 23.0 + 1000 / 111320.0, "1", count=1)
        pool += _site_cells("D", 115.0, 23.0 + 2000 / 111320.0, "1", count=1)
        pool += _site_cells("E", 115.0, 23.0 + 3000 / 111320.0, "1", count=1)

        radius_map = svc._build_search_radius_map(pool, spacing_factor=2.0)

        # A_1：150/1000/2000/3000 → 均值 1537.5 → 半径 3075；B_1：150/850/1850/2850 → 均值 1425 → 半径 2850
        assert radius_map["A_1"] == pytest.approx(3075, abs=50)
        assert radius_map["B_1"] == pytest.approx(2850, abs=50)

    def test_sparse_sites_detected_with_spacing_factor(self, tmp_path):
        """稀疏区域（1500m 内无邻区）：固定半径不判插花，站间距系数能判出（复现迴龙群光）"""
        svc = TACPlanningService(tmp_path)
        target = _site_cells("T1", 115.0, 23.0, "9")  # 本站 TAC=9，3 个小区同坐标
        neighbors = []
        for k in range(1, 5):  # 周边站间距 3000/6000/9000/12000m，TAC 均为 7
            neighbors += _site_cells(f"N{k}", 115.0, 23.0 + k * _DEG_PER_3000M, "7")
        pool = target + neighbors

        # 旧口径：1500m 内无邻区 → 直接跳过，不判插花
        assert svc.check_tac_singularity(target, pool, search_radius=1500) == []

        # 新口径：半径 = 2×(3000+6000+9000+12000)/4 = 15000m → 4 个站都在范围内 → 判插花
        out = svc.check_tac_singularity(target, pool, spacing_factor=2.0)
        assert len(out) == 3
        assert out[0]["dominantTac"] == "7"
        assert out[0]["cellTacRatio"] == 0.0
        assert out[0]["异TAC占比"] == 100.0
