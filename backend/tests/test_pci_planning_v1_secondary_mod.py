"""PCI 规划 V1 次级模约束（LTE 模6 / NR 模4）回归测试。

约束：待分配小区与「同站同频 ∪ 对打同频」小区的 PCI 模6(LTE)/模4(NR) 不相等；
优先级低于主模(模3/模30)：无可行 PCI 时先放宽次级模、仍强制主模。

全仓此前无 v1 LTENRPCIPlanner 的测试（旧 test_pci_*.py 测的都是死代码 v2）。
"""
import numpy as np
import pytest

from app.algorithms.pci_planning_v1_service import LTENRPCIPlanner, PlanningConfig
from app.algorithms.pci_check_candidates import coerce_azimuth, is_facing, near_pairs
from app.algorithms.pci_check_types import PCICheckParams
from app.models.schemas import NetworkType, PCIConfig

LAT0, LON0, FREQ = 39.9, 116.4, 100.0


def sector(cid, lat, lon, azi, pci, cover=1, freq=FREQ):
    return {
        "id": cid,
        "name": f"cell-{cid}",
        "latitude": lat,
        "longitude": lon,
        "azimuth": azi,
        "cell_cover_type": cover,
        "frequency": freq,
        "pci": pci,
    }


def site(sid, sectors):
    return {
        "id": sid,
        "name": f"site-{sid}",
        "latitude": sectors[0]["latitude"],
        "longitude": sectors[0]["longitude"],
        "sectors": sectors,
    }


def target():
    """待规划小区：1 号站，方位角 0（朝正北），无原 PCI。"""
    return sector("T", LAT0, LON0, 0.0, None)


def build(all_sectors_by_site, network_type="LTE", **cfg):
    """构造 planner：cells_to_plan 只含目标小区，all_cells 含全部背景小区。"""
    cells_to_plan = [site("1", [target()])]
    all_cells = [site(sid, secs) for sid, secs in all_sectors_by_site]
    config = PlanningConfig(network_type=network_type, reuse_distance_km=3.0,
                            inherit_mod=False, pci_range=None, **cfg)
    planner = LTENRPCIPlanner(config)
    planner.load_data_from_sites(cells_to_plan, all_cells)
    return planner


def assign(planner):
    row = planner.cells_to_plan_df.iloc[0]
    return planner.assign_pci(row)  # (new_pci, reason, min_dist, name)


def facing_sectors(specs):
    """specs: [(cid, pci, dlat, azimuth)]，统一放在 2 号站（非同站）、同频、正北方向。"""
    return [sector(cid, LAT0 + dlat, LON0, azi, pci) for cid, pci, dlat, azi in specs]


# ---------------------------------------------------------------------------
# U1 / U2：LTE 模6 约束开启生效、关闭放行
# ---------------------------------------------------------------------------

class TestLTEMod6:
    @staticmethod
    def _planner(**cfg):
        # 同站同频 S1/S2（与目标同址同频）；对打同频 F1/F2（正北、互指）
        same_site = [
            sector("S1", LAT0, LON0, 180.0, 0),
            sector("S2", LAT0, LON0, 180.0, 1),
        ]
        facing = facing_sectors([
            ("F1", 2, 0.0005, 180.0),
            ("F2", 3, 0.0007, 180.0),
        ])
        return build([("1", [target()] + same_site), ("2", facing)], **cfg)

    def test_u1_enabled_avoids_forbidden_mod6(self):
        planner = self._planner()
        assert planner.secondary_mod_value == 6
        assert planner.enable_secondary_mod is True

        # 先确认「对打同频」确实被识别（保证约束不是只靠同站部分）
        same = planner.get_same_site_cells(LAT0, LON0, "1", "T")
        keys = {(planner.normalize_id(c['enodeb_id']), planner.normalize_id(c['cell_id'])) for c in same}
        facing = planner.get_facing_cells(LAT0, LON0, FREQ, 0.0, False, "1", "T", keys)
        assert {c['cell_id'] for c in facing} == {"F1", "F2"}

        new_pci, reason, _, _ = assign(planner)
        # 同站同频 %6={0,1} + 对打同频 %6={2,3} → 禁用集合 {0,1,2,3}
        assert new_pci % 6 not in {0, 1, 2, 3}
        # 主模(mod3)仍必须满足：同站模3={0,1}，故必须落在 %3=2
        assert new_pci % 3 == 2

    def test_u2_disabled_does_not_filter(self):
        planner = self._planner(use_mod6=False)
        assert planner.enable_secondary_mod is False

        forbidden = {0, 1, 2, 3}
        with_filter = planner.get_reuse_compliant_pcis(
            LAT0, LON0, FREQ, "1", "T", forbidden_secondary_mods=forbidden)
        without_filter = planner.get_reuse_compliant_pcis(
            LAT0, LON0, FREQ, "1", "T", forbidden_secondary_mods=None)

        assert all(p[0] % 6 not in forbidden for p in with_filter)
        assert any(p[0] % 6 in forbidden for p in without_filter)

        _, reason, _, _ = assign(planner)
        assert "_secondary_mod_relaxed" not in reason


# ---------------------------------------------------------------------------
# U3：NR 模4 约束开启，且模30 / 模3 主约束仍满足
# ---------------------------------------------------------------------------

class TestNRMod4:
    def test_u3_enabled_preserves_mod4_and_primary(self):
        # 同站同频 pci 0/1（%30={0,1}, %3={0,1}, %4={0,1}）；
        # 对打同频 pci 2（%4=2）→ 禁用集合 {0,1,2}，%4=3 可用
        same_site = [
            sector("S1", LAT0, LON0, 180.0, 0),
            sector("S2", LAT0, LON0, 180.0, 1),
        ]
        facing = facing_sectors([("F1", 2, 0.0005, 180.0)])
        planner = build([("1", [target()] + same_site), ("2", facing)], network_type="NR")
        assert planner.secondary_mod_value == 4

        new_pci, reason, _, _ = assign(planner)
        assert new_pci % 4 == 3
        assert new_pci % 30 not in {0, 1}   # 模30 主约束
        assert new_pci % 3 == 2            # NR 叠加的模3 主约束
        assert "_secondary_mod_relaxed" not in reason


# ---------------------------------------------------------------------------
# U4（核心）：优先级——无解时先放宽次级模、仍保留主模
# ---------------------------------------------------------------------------

class TestPriority:
    @staticmethod
    def _cells(network_type):
        # 同站同频 pci 0/1（主模集合只占 2 类，留出余量）
        same_site = [
            sector("S1", LAT0, LON0, 180.0, 0),
            sector("S2", LAT0, LON0, 180.0, 1),
        ]
        if network_type == "LTE":
            # 对打同频补齐 %6={2,3,4,5} → 禁用集合占满 6 类
            facing = facing_sectors([
                ("F1", 2, 0.0005, 180.0),
                ("F2", 3, 0.0007, 180.0),
                ("F3", 4, 0.0009, 180.0),
                ("F4", 5, 0.0011, 180.0),
            ])
            forbidden = set(range(6))
        else:
            # NR：对打补齐 %4={2,3} → 禁用集合占满 4 类
            facing = facing_sectors([
                ("F1", 2, 0.0005, 180.0),
                ("F2", 3, 0.0007, 180.0),
            ])
            forbidden = set(range(4))
        return [("1", [target()] + same_site), ("2", facing)], forbidden

    @pytest.mark.parametrize("network_type,primary_mod", [("LTE", 3), ("NR", 30)])
    def test_u4_secondary_relaxed_before_primary(self, network_type, primary_mod):
        sites_spec, forbidden = self._cells(network_type)

        # 1) 全约束（含次级模）确实无解
        planner_on = build(sites_spec, network_type=network_type)
        compliant = planner_on.get_reuse_compliant_pcis(
            LAT0, LON0, FREQ, "1", "T", forbidden_secondary_mods=forbidden)
        assert compliant == []

        # 2) 开启：落到降级阶段，reason 标记次级模被放宽
        new_pci, reason, _, _ = assign(planner_on)
        assert "_secondary_mod_relaxed" in reason
        assert "emergency_pci_" in reason
        # 3) 主模仍满足（同站主模集合 = {0,1}）
        assert new_pci % primary_mod not in {0, 1}
        if network_type == "NR":
            assert new_pci % 3 == 2
        # 4) 次级模确被放弃
        assert new_pci % planner_on.secondary_mod_value in forbidden

        # 5) 关闭：阶段 1~4 即可求解，不触发放宽
        cfg_off = {"use_mod6": False} if network_type == "LTE" else {"use_mod4": False}
        planner_off = build(sites_spec, network_type=network_type, **cfg_off)
        _, reason_off, _, _ = assign(planner_off)
        assert "_secondary_mod_relaxed" not in reason_off


# ---------------------------------------------------------------------------
# U5 / U6：对打几何口径、同站排除
# ---------------------------------------------------------------------------

class TestFacingGeometry:
    @staticmethod
    def _cells():
        return [
            ("T", LAT0, LON0, 0.0, None),          # 自身
            ("S1", LAT0, LON0, 180.0, 0),         # 同站（同址），须被 same_site_keys 排除
            ("F1", LAT0 + 0.0005, LON0, 180.0, 2),  # 正北、互指 → 对打
            ("B1", LAT0 + 0.0007, LON0, 0.0, 3),    # 同向（背向目标）→ 非对打
            ("M1", LAT0 + 0.0009, LON0, None, 4),    # 缺方位角 → 退化为仅距离判定 → 对打
            ("O1", LAT0 + 0.003, LON0, 180.0, 5),    # 超出对打距离门限 → 排除
        ]

    def test_u5_facing_set(self):
        cells = self._cells()
        planner = build([("1", [sector(*c) for c in cells[:2]]),
                         ("2", [sector(*c) for c in cells[2:]])])
        same = planner.get_same_site_cells(LAT0, LON0, "1", "T")
        keys = {(planner.normalize_id(c['enodeb_id']), planner.normalize_id(c['cell_id'])) for c in same}
        got = {c['cell_id'] for c in planner.get_facing_cells(
            LAT0, LON0, FREQ, 0.0, False, "1", "T", keys)}
        assert got == {"F1", "M1"}

    def test_u5_missing_azimuth_is_none(self):
        # 关键坑：DataFrame 里缺失方位角是 NaN，必须经 coerce_azimuth 转 None
        assert coerce_azimuth(float('nan')) is None
        assert coerce_azimuth(None) is None
        assert coerce_azimuth(0.0) == 0.0
        assert is_facing({"azimuth": 0.0, "longitude": LON0, "latitude": LAT0},
                         {"azimuth": None, "longitude": LON0, "latitude": LAT0 + 0.0005},
                         90.0) is True

    def test_u6_same_site_excluded(self):
        cells = self._cells()
        planner = build([("1", [sector(*c) for c in cells[:2]]),
                         ("2", [sector(*c) for c in cells[2:]])])
        # 不传同站排除时，同址的 S1 会被当作对打；传入后必须被排除
        without = {c['cell_id'] for c in planner.get_facing_cells(
            LAT0, LON0, FREQ, 0.0, False, "1", "T", set())}
        assert "S1" in without
        same = planner.get_same_site_cells(LAT0, LON0, "1", "T")
        keys = {(planner.normalize_id(c['enodeb_id']), planner.normalize_id(c['cell_id'])) for c in same}
        with_keys = {c['cell_id'] for c in planner.get_facing_cells(
            LAT0, LON0, FREQ, 0.0, False, "1", "T", keys)}
        assert "S1" not in with_keys


# ---------------------------------------------------------------------------
# U9：规划侧对打集合与核查侧 near_pairs 口径一致
# ---------------------------------------------------------------------------

class TestCheckParity:
    def test_u9_same_ruler_as_check(self):
        # 同站小区经纬度完全相同，消除规划侧(siteId+10m)与核查侧(siteId+精确坐标)编码差异
        cells = [
            {"key": ("1", "T"), "lat": LAT0, "lon": LON0, "azi": 0.0, "site": 0},
            {"key": ("1", "S1"), "lat": LAT0, "lon": LON0, "azi": 180.0, "site": 0},
            {"key": ("2", "F1"), "lat": LAT0 + 0.0005, "lon": LON0, "azi": 180.0, "site": 1},
            {"key": ("3", "B1"), "lat": LAT0 + 0.0007, "lon": LON0, "azi": 0.0, "site": 2},
            {"key": ("4", "M1"), "lat": LAT0 + 0.0009, "lon": LON0, "azi": None, "site": 3},
            {"key": ("5", "O1"), "lat": LAT0 + 0.003, "lon": LON0, "azi": 180.0, "site": 4},
        ]
        arr = {
            "lats": np.array([c["lat"] for c in cells]),
            "lons": np.array([c["lon"] for c in cells]),
            "freqs": np.array([FREQ] * len(cells)),
            "site_codes": np.array([c["site"] for c in cells]),
        }
        params = PCICheckParams(network_type="LTE")

        def chk(c):
            return {"azimuth": coerce_azimuth(c["azi"]),
                    "longitude": c["lon"], "latitude": c["lat"]}

        check_facing = set()
        for i, j, dist in near_pairs(arr, params.max_pair_distance_km, exclude_same_site=True):
            if i != 0:
                continue
            gate_km = params.pair_distance_km(False, False)
            if dist > gate_km:
                continue
            if is_facing(chk(cells[0]), chk(cells[j]), params.facing_gate_deg(False)):
                check_facing.add(cells[j]["key"][1])

        # 规划侧
        planner = build([
            ("1", [sector("T", LAT0, LON0, 0.0, None),
                   sector("S1", LAT0, LON0, 180.0, 0)]),
            ("2", [sector("F1", LAT0 + 0.0005, LON0, 180.0, 2)]),
            ("3", [sector("B1", LAT0 + 0.0007, LON0, 0.0, 3)]),
            ("4", [sector("M1", LAT0 + 0.0009, LON0, None, 4)]),
            ("5", [sector("O1", LAT0 + 0.003, LON0, 180.0, 5)]),
        ])
        same = planner.get_same_site_cells(LAT0, LON0, "1", "T")
        keys = {(planner.normalize_id(c['enodeb_id']), planner.normalize_id(c['cell_id'])) for c in same}
        plan_facing = {c['cell_id'] for c in planner.get_facing_cells(
            LAT0, LON0, FREQ, 0.0, False, "1", "T", keys)}

        assert check_facing == {"F1", "M1"}
        assert plan_facing == check_facing


# ---------------------------------------------------------------------------
# U7 / U8：配置贯通、默认值、制式选择、import 冒烟
# ---------------------------------------------------------------------------

class TestConfigWiring:
    def test_u7_schema_defaults_and_override(self):
        assert PCIConfig(networkType=NetworkType.LTE).useMod6 is True
        assert PCIConfig(networkType=NetworkType.LTE).useMod4 is True
        assert PCIConfig(networkType=NetworkType.NR, useMod6=False).useMod6 is False
        assert PCIConfig(networkType=NetworkType.NR, useMod4=False).useMod4 is False

    def test_u7_planning_config_defaults(self):
        assert PlanningConfig(network_type="LTE").use_mod6 is True
        assert PlanningConfig(network_type="NR").use_mod4 is True

    @pytest.mark.parametrize("network_type,expected", [
        ("LTE", False),  # LTE 只看 use_mod6
        ("NR", True),    # NR 只看 use_mod4
    ])
    def test_u7_planner_picks_switch_by_network_type(self, network_type, expected):
        cfg = PlanningConfig(network_type=network_type, use_mod6=False, use_mod4=True)
        planner = LTENRPCIPlanner(cfg)
        assert planner.enable_secondary_mod is expected

    def test_u8_import_smoke(self):
        assert LTENRPCIPlanner.__name__ == "LTENRPCIPlanner"
        assert LTENRPCIPlanner(PlanningConfig(network_type="LTE")).secondary_mod_value == 6
        assert LTENRPCIPlanner(PlanningConfig(network_type="NR")).secondary_mod_value == 4
