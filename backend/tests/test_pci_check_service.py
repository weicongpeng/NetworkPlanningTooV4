"""
PCI核查算法测试

覆盖 9 类核查规则的正反例、开关组合、邻区对仅内存、工参不全跳过记录。
冲突/混淆用固定邻接表做单测，另有一条走真实邻区预规划的集成用例。
"""

import math
from pathlib import Path

import numpy as np
import pytest

from app.algorithms.pci_check_candidates import cells_within_band
from app.algorithms.pci_check_types import CheckType, PCICheckParams
from app.algorithms.pci_check_service import PCICheckService

LAT0 = 30.5
LON0 = 114.3
# 纬度 LAT0 处经度 1 度对应的公里数
LON_KM_PER_DEG = 111.0 * math.cos(math.radians(LAT0))


def make_sector(sector_id, pci, earfcn, *, east_m=0.0, north_m=0.0, azimuth=0.0, name=None,
                indoor=False):
    """按相对偏移（米）构造扇区工参行"""
    return {
        "id": sector_id,
        "name": name or f"小区{sector_id}",
        "pci": pci,
        "earfcn": earfcn,
        "azimuth": azimuth,
        "latitude": LAT0 + north_m / 1000.0 / 111.0,
        "longitude": LON0 + east_m / 1000.0 / LON_KM_PER_DEG,
        "cell_cover_type": 4 if indoor else 1,
    }


def make_sites(*groups):
    """groups: [(site_id, (sector, ...)), ...]"""
    return [
        {
            "id": site_id,
            "name": f"站点{site_id}",
            "latitude": LAT0,
            "longitude": LON0,
            "sectors": list(sectors),
        }
        for site_id, sectors in groups
    ]


def site_with(site_id, *sectors):
    return (site_id, sectors)


def run_check(sites, selected_keys, *, network_type="LTE", pair_km=None,
              macro_pair_km=0.2, mixed_pair_km=0.1, indoor_pair_km=0.05,
              reuse_macro_km=2.0, reuse_indoor_km=0.5,
              macro_angle=90.0, indoor_angle=60.0,
              reuse_check=True, collision_check=True, confusion_check=True,
              mod3_check=True, mod30_check=True, neighbor_assoc=False):
    service = PCICheckService()
    params = PCICheckParams(
        network_type=network_type,
        macro_pair_distance_km=pair_km if pair_km is not None else macro_pair_km,
        mixed_pair_distance_km=pair_km if pair_km is not None else mixed_pair_km,
        indoor_pair_distance_km=pair_km if pair_km is not None else indoor_pair_km,
        min_reuse_distance_macro_km=reuse_macro_km,
        min_reuse_distance_indoor_km=reuse_indoor_km,
        macro_facing_gate_deg=macro_angle,
        indoor_facing_gate_deg=indoor_angle,
        enable_reuse_check=reuse_check,
        enable_collision_check=collision_check,
        enable_confusion_check=confusion_check,
        enable_mod3_check=mod3_check,
        enable_mod30_check=mod30_check,
        neighbor_assoc=neighbor_assoc,
    )
    return service, service.run(sites, selected_keys, params)


def stub_adjacency(monkeypatch, pairs_by_key):
    """把邻区预规划替换为固定同频邻接表，让冲突/混淆单测与算法实现解耦"""

    def _stub(self, cells, arr, flags):
        index = {cell["key"]: idx for idx, cell in enumerate(cells)}
        adjacency = {}
        for source_key, target_keys in pairs_by_key.items():
            if source_key not in index or not all(key in index for key in target_keys):
                continue
            adjacency[index[source_key]] = [index[key] for key in target_keys]
        return adjacency

    monkeypatch.setattr(PCICheckService, "_plan_same_freq_neighbors", _stub)


def snapshot_dirs():
    """输出/导出目录的文件快照，用于断言核查不产生任何落盘副产物"""
    from app.core.config import settings

    captured = set()
    for root in (settings.OUTPUT_DIR, settings.EXPORT_DIR):
        base = Path(root)
        if base.exists():
            captured |= {str(p) for p in base.rglob("*") if p.is_file()}
    return captured


# ============================== 同站模3 ==============================

class TestMod3SameSite:
    def test_same_site_same_freq_same_mod3_is_reported(self):
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100),
            make_sector("2", 3, 100),
        ))
        _, result = run_check(sites, ["S1_1"])
        rows = result["results"][CheckType.MOD3_SAME_SITE.value]
        assert len(rows) == 1
        row = rows[0]
        assert {row["aSectorId"], row["bSectorId"]} == {"1", "2"}
        assert row["modulus"] == 3 and row["aMod"] == 0 and row["bMod"] == 0
        assert "同站同频" in row["reason"]

    def test_staggered_mod3_is_clean(self):
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100),
            make_sector("2", 1, 100),
        ))
        _, result = run_check(sites, ["S1_1"])
        assert result["results"][CheckType.MOD3_SAME_SITE.value] == []

    def test_different_frequency_is_not_compared(self):
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100),
            make_sector("2", 3, 200),
        ))
        _, result = run_check(sites, ["S1_1"])
        assert result["results"][CheckType.MOD3_SAME_SITE.value] == []

    def test_same_pci_on_same_site_also_hits_reuse_distance(self):
        """PCI 相同会同时命中同站模3与复用距离过小：分类各自成表，不做跨类去重"""
        sites = make_sites(site_with("S1",
            make_sector("1", 5, 100),
            make_sector("2", 5, 100),
        ))
        _, result = run_check(sites, ["S1_1"])
        assert len(result["results"][CheckType.MOD3_SAME_SITE.value]) == 1
        assert len(result["results"][CheckType.REUSE_DISTANCE.value]) == 1
        assert "且 PCI 相同" in result["results"][CheckType.MOD3_SAME_SITE.value][0]["reason"]

    def test_unselected_peer_still_appears_as_reference_side(self):
        """对照池取全量同制式小区：未勾选小区作为对端出现，勾选端始终在 a 侧"""
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100),
            make_sector("2", 3, 100),
            make_sector("3", 6, 100),
        ))
        _, result = run_check(sites, ["S1_1"])
        rows = result["results"][CheckType.MOD3_SAME_SITE.value]
        assert {row["aSectorId"] for row in rows} == {"1"}
        assert {row["bSectorId"] for row in rows} == {"2", "3"}

    def test_over_three_cells_allow_non_adjacent_reuse(self):
        """超过 3 个同频小区：0/1/2/0 按非连续分配，不算异常"""
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100),
            make_sector("2", 1, 100),
            make_sector("3", 2, 100),
            make_sector("4", 3, 100),
        ))
        _, result = run_check(sites, ["S1_1"])
        assert result["results"][CheckType.MOD3_SAME_SITE.value] == []

    def test_over_three_cells_report_adjacent_same_mod3(self):
        """超过 3 个同频小区：相邻（按小区ID排序）模3 相同才算异常"""
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100),
            make_sector("2", 3, 100),
            make_sector("3", 1, 100),
            make_sector("4", 2, 100),
        ))
        _, result = run_check(sites, ["S1_1"])
        rows = result["results"][CheckType.MOD3_SAME_SITE.value]
        assert len(rows) == 1
        assert {rows[0]["aSectorId"], rows[0]["bSectorId"]} == {"1", "2"}

    def test_three_cells_still_require_distinct_mod3(self):
        """站内 3 个同频小区仍要求模3 两两不同：0/0/1 报出重复对"""
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100),
            make_sector("2", 3, 100),
            make_sector("3", 1, 100),
        ))
        _, result = run_check(sites, ["S1_1"])
        assert len(result["results"][CheckType.MOD3_SAME_SITE.value]) == 1


# ============================== 对打模3 ==============================

class TestMod3Facing:
    def test_facing_cells_within_gate_are_reported(self):
        """A 朝东、B 朝西，150 米互指 → 对打模3"""
        sites = make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=90)),
            site_with("S2", make_sector("1", 3, 100, east_m=150, azimuth=270)),
        )
        _, result = run_check(sites, ["S1_1"])
        rows = result["results"][CheckType.MOD3_FACING.value]
        assert len(rows) == 1
        assert rows[0]["aSiteId"] == "S1" and rows[0]["bSiteId"] == "S2"
        assert 140 < rows[0]["distanceM"] < 160

    def test_back_to_back_cells_are_not_facing(self):
        """背打（方位角互背）不算对打"""
        sites = make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=270)),
            site_with("S2", make_sector("1", 3, 100, east_m=200, azimuth=90)),
        )
        _, result = run_check(sites, ["S1_1"])
        assert result["results"][CheckType.MOD3_FACING.value] == []

    def test_outside_pair_distance_is_not_facing(self):
        """超出宏-宏对打门限（默认200米）不报"""
        sites = make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=90)),
            site_with("S2", make_sector("1", 3, 100, east_m=500, azimuth=270)),
        )
        _, result = run_check(sites, ["S1_1"])
        assert result["results"][CheckType.MOD3_FACING.value] == []

    def test_macro_to_indoor_and_indoor_to_indoor_distances(self):
        """宏-室分默认100米、室-室默认50米，分别独立判定"""
        macro_indoor = make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=90)),
            site_with("S2", make_sector("1", 3, 100, east_m=80, azimuth=270, indoor=True)),
        )
        _, result = run_check(macro_indoor, ["S1_1"])
        assert len(result["results"][CheckType.MOD3_FACING.value]) == 1

        _, mixed_far = run_check(
            make_sites(
                site_with("S1", make_sector("1", 0, 100, azimuth=90)),
                site_with("S2", make_sector("1", 3, 100, east_m=120, azimuth=270, indoor=True)),
            ),
            ["S1_1"],
        )
        assert mixed_far["results"][CheckType.MOD3_FACING.value] == []

        indoor_pair = make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=90, indoor=True)),
            site_with("S2", make_sector("1", 3, 100, east_m=30, azimuth=270, indoor=True)),
        )
        _, indoor_result = run_check(indoor_pair, ["S1_1"])
        assert len(indoor_result["results"][CheckType.MOD3_FACING.value]) == 1

        _, indoor_far = run_check(
            make_sites(
                site_with("S1", make_sector("1", 0, 100, azimuth=90, indoor=True)),
                site_with("S2", make_sector("1", 3, 100, east_m=80, azimuth=270, indoor=True)),
            ),
            ["S1_1"],
        )
        assert indoor_far["results"][CheckType.MOD3_FACING.value] == []

    def test_pair_distances_can_be_overridden(self):
        """三类对打距离均可由用户设置"""
        sites = make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=90)),
            site_with("S2", make_sector("1", 3, 100, east_m=80, azimuth=270, indoor=True)),
        )
        _, result = run_check(sites, ["S1_1"], mixed_pair_km=0.05)
        assert result["results"][CheckType.MOD3_FACING.value] == []

    def test_same_pci_facing_is_reported_with_pci_note(self):
        sites = make_sites(
            site_with("S1", make_sector("1", 7, 100, azimuth=90)),
            site_with("S2", make_sector("1", 7, 100, east_m=150, azimuth=270)),
        )
        _, result = run_check(sites, ["S1_1"])
        rows = result["results"][CheckType.MOD3_FACING.value]
        assert len(rows) == 1
        assert "PCI 同为 7" in rows[0]["reason"]

    def test_missing_azimuth_degrades_to_distance_only(self):
        """工参缺方位角时退化为仅距离判定"""
        sites = make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=None)),
            site_with("S2", make_sector("1", 3, 100, east_m=120, azimuth=None)),
        )
        _, result = run_check(sites, ["S1_1"])
        assert len(result["results"][CheckType.MOD3_FACING.value]) == 1

    def test_same_site_requires_same_coordinates(self):
        """相同基站ID但经纬度不同不算同站：不报同站模3"""
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100),
            make_sector("2", 3, 100, east_m=10),
        ))
        _, result = run_check(sites, ["S1_1"])
        assert result["results"][CheckType.MOD3_SAME_SITE.value] == []

    def test_same_site_cells_are_excluded_from_facing(self):
        """同站小区只走同站模3，不重复计入对打"""
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100, azimuth=90),
            make_sector("2", 3, 100, azimuth=270),
        ))
        _, result = run_check(sites, ["S1_1"])
        assert result["results"][CheckType.MOD3_FACING.value] == []
        assert len(result["results"][CheckType.MOD3_SAME_SITE.value]) == 1

    def test_macro_gate_is_wider_than_indoor_gate(self):
        """方位角偏差 70°：宏站门限 90° 通过，室分门限 60° 不通过"""
        sites = make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=160)),
            site_with("S2", make_sector("1", 3, 100, east_m=150, azimuth=270)),
        )
        _, macro_result = run_check(sites, ["S1_1"])
        assert len(macro_result["results"][CheckType.MOD3_FACING.value]) == 1

        sites[0]["sectors"][0]["cell_cover_type"] = 4
        _, indoor_result = run_check(sites, ["S1_1"])
        assert indoor_result["results"][CheckType.MOD3_FACING.value] == []

    def test_gate_defaults_can_be_overridden(self):
        """前端可自定义宏站/室分夹角门限"""
        sites = make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=160)),
            site_with("S2", make_sector("1", 3, 100, east_m=150, azimuth=270)),
        )
        _, result = run_check(sites, ["S1_1"], macro_angle=60.0)
        assert result["results"][CheckType.MOD3_FACING.value] == []


# ============================== 复用距离 ==============================

class TestReuseDistance:
    def _sites(self, *, indoor=False):
        return make_sites(
            site_with("S1", make_sector("1", 100, 100, indoor=indoor)),
            site_with("S2", make_sector("1", 100, 100, east_m=1500)),
        )

    def test_same_pci_within_reuse_distance_is_reported(self):
        _, result = run_check(self._sites(), ["S1_1"])
        rows = result["results"][CheckType.REUSE_DISTANCE.value]
        assert len(rows) == 1
        assert 1400 < rows[0]["distanceM"] < 1600
        assert "最小复用距离 2000 米" in rows[0]["reason"]

    def test_reuse_distance_shrinking_clears_the_pair(self):
        """复用距离收到 1 公里后，2 公里外的同PCI小区不再命中"""
        _, result = run_check(self._sites(), ["S1_1"], reuse_macro_km=1.0)
        assert result["results"][CheckType.REUSE_DISTANCE.value] == []

    def test_indoor_cell_uses_indoor_reuse_gate(self):
        """被核查小区为室分时按室分门限 1 公里：2 公里外的同PCI小区不命中"""
        _, result = run_check(self._sites(indoor=True), ["S1_1"])
        assert result["results"][CheckType.REUSE_DISTANCE.value] == []

        _, wider = run_check(self._sites(indoor=True), ["S1_1"], reuse_indoor_km=3.0)
        assert len(wider["results"][CheckType.REUSE_DISTANCE.value]) == 1

    def test_both_selected_mixed_types_use_wider_gate(self):
        """双端都勾选且宏/室分门限不同时，按两侧较宽门限判定，宏站端作为核查侧"""
        sites = make_sites(
            site_with("S1", make_sector("1", 100, 100, indoor=True)),
            site_with("S2", make_sector("1", 100, 100, east_m=1500)),
        )
        _, result = run_check(sites, ["S1_1", "S2_1"])
        rows = result["results"][CheckType.REUSE_DISTANCE.value]
        assert len(rows) == 1
        assert rows[0]["aSiteId"] == "S2"
        assert "最小复用距离 2000 米" in rows[0]["reason"]

    def test_different_frequency_same_pci_is_clean(self):
        sites = make_sites(
            site_with("S1", make_sector("1", 100, 100)),
            site_with("S2", make_sector("1", 100, 300, east_m=500)),
        )
        _, result = run_check(sites, ["S1_1"])
        assert result["results"][CheckType.REUSE_DISTANCE.value] == []

    def test_float_frequency_is_preserved_and_compared(self):
        """频点保留浮点精度：1870.5 参与同频比较并原值输出"""
        sites = make_sites(
            site_with("S1", make_sector("1", 100, 1870.5)),
            site_with("S2", make_sector("1", 100, 1870.5, east_m=100)),
        )
        _, result = run_check(sites, ["S1_1"])
        rows = result["results"][CheckType.REUSE_DISTANCE.value]
        assert len(rows) == 1
        assert rows[0]["aFrequency"] == 1870.5

        _, different = run_check(
            make_sites(
                site_with("S1", make_sector("1", 100, 1870.5)),
                site_with("S2", make_sector("1", 100, 1870.25, east_m=100)),
            ),
            ["S1_1"],
        )
        assert different["results"][CheckType.REUSE_DISTANCE.value] == []


# ============================== NR 模30 ==============================

class TestMod30:
    def test_nr_same_mod30_on_same_site_is_reported(self):
        """同站同频模30 与 NR 规划约束一致：站内不能相同"""
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100),
            make_sector("2", 30, 100),
        ))
        _, result = run_check(sites, ["S1_1"], network_type="NR")
        rows = result["results"][CheckType.MOD30_SAME_SITE.value]
        assert len(rows) == 1
        assert rows[0]["modulus"] == 30
        assert rows[0]["aMod"] == 0 and rows[0]["bMod"] == 0

    def test_lte_does_not_run_same_site_mod30(self):
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100),
            make_sector("2", 30, 100),
        ))
        _, result = run_check(sites, ["S1_1"], network_type="LTE")
        assert CheckType.MOD30_SAME_SITE.value not in result["results"]

    def test_nr_facing_mod30_is_reported(self):
        """不同站点同频对打且模30 相同 → 对打模30"""
        sites = make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=90)),
            site_with("S2", make_sector("1", 30, 100, east_m=150, azimuth=270)),
        )
        _, result = run_check(sites, ["S1_1"], network_type="NR")
        rows = result["results"][CheckType.MOD30_FACING.value]
        assert len(rows) == 1
        assert rows[0]["modulus"] == 30
        assert "模30" in rows[0]["reason"]

    def test_nr_facing_mod30_outside_pair_distance_is_clean(self):
        sites = make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=90)),
            site_with("S2", make_sector("1", 30, 100, east_m=500, azimuth=270)),
        )
        _, result = run_check(sites, ["S1_1"], network_type="NR", pair_km=0.3)
        assert result["results"][CheckType.MOD30_FACING.value] == []

    def test_nr_different_mod30_is_clean(self):
        sites = make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=90)),
            site_with("S2", make_sector("1", 31, 100, east_m=150, azimuth=270)),
        )
        _, result = run_check(sites, ["S1_1"], network_type="NR")
        assert result["results"][CheckType.MOD30_FACING.value] == []

    def test_nr_mod30_neighbor_requires_association(self, monkeypatch):
        stub_adjacency(monkeypatch, {"S1_1": ["S2_1"]})
        sites = make_sites(
            site_with("S1", make_sector("1", 0, 100)),
            site_with("S2", make_sector("1", 30, 100, east_m=4000)),
        )
        _, result = run_check(sites, ["S1_1"], network_type="NR", neighbor_assoc=True)
        rows = result["results"][CheckType.MOD30_NEIGHBOR.value]
        assert len(rows) == 1
        assert rows[0]["modulus"] == 30

        _, without = run_check(sites, ["S1_1"], network_type="NR", neighbor_assoc=False)
        assert CheckType.MOD30_NEIGHBOR.value not in without["results"]


# ============================== 冲突 / 混淆（固定邻接表单测） ==============================

class TestCollisionAndConfusionWithStubbedNeighbors:
    def test_collision_from_same_freq_neighbor(self, monkeypatch):
        stub_adjacency(monkeypatch, {"S1_1": ["S2_1"]})
        sites = make_sites(
            site_with("S1", make_sector("1", 120, 100)),
            site_with("S2", make_sector("1", 120, 100, east_m=800)),
        )
        _, result = run_check(sites, ["S1_1"], neighbor_assoc=True)
        rows = result["results"][CheckType.COLLISION.value]
        assert len(rows) == 1
        assert rows[0]["aPci"] == rows[0]["bPci"] == 120
        assert "非现网邻区数据" in rows[0]["reason"]

    def test_different_pci_neighbors_are_clean(self, monkeypatch):
        stub_adjacency(monkeypatch, {"S1_1": ["S2_1", "S3_1"]})
        sites = make_sites(
            site_with("S1", make_sector("1", 120, 100)),
            site_with("S2", make_sector("1", 121, 100, east_m=800)),
            site_with("S3", make_sector("1", 122, 100, east_m=900)),
        )
        _, result = run_check(sites, ["S1_1"], neighbor_assoc=True)
        assert result["results"][CheckType.COLLISION.value] == []
        assert result["results"][CheckType.CONFUSION.value] == []

    def test_confusion_reports_two_same_pci_neighbors(self, monkeypatch):
        """服务小区的两个同频邻区 PCI 相同 → 混淆，输出 A/B/C 三个小区"""
        stub_adjacency(monkeypatch, {"S1_1": ["S2_1", "S3_1"]})
        sites = make_sites(
            site_with("S1", make_sector("1", 120, 100)),
            site_with("S2", make_sector("1", 200, 100, east_m=800)),
            site_with("S3", make_sector("1", 200, 100, east_m=900, north_m=100)),
        )
        _, result = run_check(sites, ["S1_1"], neighbor_assoc=True)
        rows = result["results"][CheckType.CONFUSION.value]
        assert len(rows) == 1
        row = rows[0]
        assert row["aSiteId"] == "S1"
        assert {row["bSiteId"], row["cSiteId"]} == {"S2", "S3"}
        assert row["bPci"] == row["cPci"] == 200
        assert "终端易混淆" in row["reason"]
        assert row["bToCDistanceM"] > 0 and row["aToCDistanceM"] > 0

    def test_confusion_truncates_oversized_group(self, monkeypatch):
        """同 PCI 邻区数量过多时只输出前 10 个的组合，避免结果爆炸"""
        targets = [f"S{i}_1" for i in range(2, 14)]
        stub_adjacency(monkeypatch, {"S1_1": targets})
        sites = make_sites(
            site_with("S1", make_sector("1", 120, 100)),
            *[site_with(f"S{i}", make_sector("1", 200, 100, east_m=i * 150)) for i in range(2, 14)]
        )
        _, result = run_check(sites, ["S1_1"], neighbor_assoc=True)
        rows = result["results"][CheckType.CONFUSION.value]
        assert len(rows) == 45  # C(10, 2)
        assert "仅输出前 10 个的组合" in rows[0]["reason"]

    def test_neighbors_of_unchecked_cell_are_not_output(self, monkeypatch):
        """只有勾选小区作为服务侧才输出冲突/混淆"""
        stub_adjacency(monkeypatch, {"S2_1": ["S3_1", "S4_1"]})
        sites = make_sites(
            site_with("S1", make_sector("1", 1, 100)),
            site_with("S2", make_sector("1", 200, 100, east_m=800)),
            site_with("S3", make_sector("1", 200, 100, east_m=900)),
            site_with("S4", make_sector("1", 200, 100, east_m=1000)),
        )
        _, result = run_check(sites, ["S1_1"], neighbor_assoc=True)
        assert result["results"][CheckType.COLLISION.value] == []
        assert result["results"][CheckType.CONFUSION.value] == []


class TestCollisionWithoutNeighborAssociation:
    """邻区关联关闭时，冲突退化为复用距离口径；混淆不核查"""

    def test_collision_within_reuse_distance_is_reported(self):
        sites = make_sites(
            site_with("S1", make_sector("1", 120, 100)),
            site_with("S2", make_sector("1", 120, 100, east_m=1500)),
        )
        _, result = run_check(sites, ["S1_1"], neighbor_assoc=False)
        rows = result["results"][CheckType.COLLISION.value]
        assert len(rows) == 1
        assert "最小复用距离 2000 米" in rows[0]["reason"]

    def test_collision_outside_reuse_distance_is_clean(self):
        sites = make_sites(
            site_with("S1", make_sector("1", 120, 100)),
            site_with("S2", make_sector("1", 120, 100, east_m=4000)),
        )
        _, result = run_check(sites, ["S1_1"], neighbor_assoc=False)
        assert result["results"][CheckType.COLLISION.value] == []

    def test_indoor_gate_is_used_for_collision(self):
        sites = make_sites(
            site_with("S1", make_sector("1", 120, 100, indoor=True)),
            site_with("S2", make_sector("1", 120, 100, east_m=2000)),
        )
        _, result = run_check(sites, ["S1_1"], neighbor_assoc=False)
        assert result["results"][CheckType.COLLISION.value] == []

    def test_confusion_is_skipped_without_association(self, monkeypatch):
        stub_adjacency(monkeypatch, {"S1_1": ["S2_1", "S3_1"]})
        sites = make_sites(
            site_with("S1", make_sector("1", 120, 100)),
            site_with("S2", make_sector("1", 200, 100, east_m=800)),
            site_with("S3", make_sector("1", 200, 100, east_m=900)),
        )
        _, result = run_check(sites, ["S1_1"], neighbor_assoc=False)
        assert CheckType.CONFUSION.value not in result["results"]

    def test_neighbor_collision_ignores_reuse_distance(self, monkeypatch):
        """邻区关联打开后，4 公里外的同PCI邻区仍判为冲突"""
        stub_adjacency(monkeypatch, {"S1_1": ["S2_1"]})
        sites = make_sites(
            site_with("S1", make_sector("1", 120, 100)),
            site_with("S2", make_sector("1", 120, 100, east_m=4000)),
        )
        _, result = run_check(sites, ["S1_1"], neighbor_assoc=True)
        assert len(result["results"][CheckType.COLLISION.value]) == 1


# ============================== 邻区预规划集成 ==============================

class TestNeighborPrePlanningIntegration:
    def test_real_planner_finds_collision_and_writes_nothing(self):
        """走真实邻区预规划：100 米内同频同PCI 的强制邻区应报冲突，且不产生任何落盘副产物"""
        before = snapshot_dirs()
        sites = make_sites(
            site_with("S1", make_sector("1", 88, 100, azimuth=90)),
            site_with("S2", make_sector("1", 88, 100, east_m=100, azimuth=270)),
        )
        service, result = run_check(sites, ["S1_1"], neighbor_assoc=True)

        assert result["neighborPairCount"] > 0
        assert len(result["results"][CheckType.COLLISION.value]) == 1
        # 返回值只含本次启用类别的核查结果，不夹带邻区规划明细
        assert set(result["results"].keys()) <= {ct.value for ct in CheckType}
        assert result["results"][CheckType.MOD3_NEIGHBOR.value] == []
        assert "neighborResults" not in result
        assert snapshot_dirs() == before


# ============================== 数据加载与跳过 ==============================

class TestResultRowColumns:
    def test_row_includes_cgi_vendor_coverage_and_merged_pci(self):
        """厂家取工参“第一分组”，覆盖类型按小区覆盖类型映射为室分/室外"""
        sites = make_sites(
            site_with("S1", {**make_sector("1", 88, 100, indoor=True), "first_group": "厂家A"}),
            site_with("S2", {**make_sector("1", 88, 100, east_m=100), "first_group": "厂家B"}),
        )
        _, result = run_check(sites, ["S1_1"], neighbor_assoc=False)
        row = result["results"][CheckType.REUSE_DISTANCE.value][0]
        assert row["aCgi"] == "S1-1" and row["bCgi"] == "S2-1"
        assert row["aVendor"] == "厂家A" and row["bVendor"] == "厂家B"
        assert row["aCoverageType"] == "室分" and row["bCoverageType"] == "室外"
        # PCI 列只填目标小区 PCI
        assert row["pci"] == 88


class TestExportCategorised:
    """每类问题各自成表导出（xlsx 一类一个 sheet，csv 按类型单文件）"""

    @staticmethod
    def _row(check_type, name, pci_a, pci_b, **extra):
        return {
            "checkType": check_type,
            "checkTypeName": name,
            "networkType": "LTE",
            "modulus": None,
            "aCgi": "S1-1", "aSiteId": "S1", "aSiteName": "站点1", "aSectorId": "1", "aSectorName": "小区1",
            "aPci": pci_a, "aFrequency": 100, "aMod": None,
            "aVendor": "厂家A", "aCoverageType": "室外",
            "aLongitude": 114.3, "aLatitude": 30.5, "aAzimuth": 0,
            "bCgi": "S2-1", "bSiteId": "S2", "bSiteName": "站点2", "bSectorId": "1", "bSectorName": "小区2",
            "bPci": pci_b, "bFrequency": 100, "bMod": None,
            "bVendor": "厂家B", "bCoverageType": "室分",
            "bLongitude": 114.31, "bLatitude": 30.51, "bAzimuth": 90,
            "pci": str(pci_a) if pci_a == pci_b else f"{pci_a} / {pci_b}",
            "distanceM": 1200.0,
            "reason": f"{name}测试",
            **extra,
        }

    def _result(self):
        return {
            "networkType": "LTE",
            "summary": {"collision": 1, "mod3_same_site": 1},
            "results": {
                "collision": [self._row("collision", "PCI冲突", 120, 120)],
                "mod3_same_site": [self._row("mod3_same_site", "同站模3冲突", 0, 3, modulus=3, aMod=0, bMod=0)],
                "confusion": [],
                "mod3_facing": [],
                "reuse_distance": [],
                "mod30_same_site": [],
                "mod30_facing": [],
                "mod30_neighbor": [],
            },
        }

    @pytest.mark.asyncio
    async def test_xlsx_writes_one_sheet_per_hit_category(self, tmp_path, monkeypatch):
        from openpyxl import load_workbook

        from app.core.config import settings
        from app.services.export_service import export_pci_check_result

        monkeypatch.setattr(settings, "EXPORT_DIR", tmp_path)
        response = await export_pci_check_result("t-export", self._result(), "xlsx")

        workbook = load_workbook(response.path)
        assert workbook.sheetnames == ["PCI冲突", "同站模3冲突"]
        sheet = workbook["PCI冲突"]
        headers = [cell.value for cell in sheet[1]]
        assert headers[0] == "核查类型"
        assert "检查CGI" in headers and "目标CGI" in headers and "目标PCI" in headers
        assert "源小区厂家" in headers and "目标小区名称" in headers
        assert "源小区方位角" not in headers and "模数" not in headers
        assert "核查小区PCI" not in headers
        assert sheet.cell(row=2, column=headers.index("核查类型") + 1).value == "PCI冲突"

        mod_sheet = workbook["同站模3冲突"]
        mod_headers = [cell.value for cell in mod_sheet[1]]
        assert "检查CGI" in mod_headers and "目标CGI" in mod_headers
        assert "模数" not in mod_headers
        assert "源小区模值" in mod_headers and "源小区方位角" in mod_headers

    @pytest.mark.asyncio
    async def test_pci_column_exports_target_pci(self, tmp_path, monkeypatch):
        """PCI 列只导出目标小区 PCI，历史结果的合并旧值也要被覆盖"""
        import csv

        from app.core.config import settings
        from app.services.export_service import export_pci_check_result

        monkeypatch.setattr(settings, "EXPORT_DIR", tmp_path)
        result = {"results": {"reuse_distance": [self._row("reuse_distance", "PCI复用距离过小", 100, 120)]}}
        response = await export_pci_check_result("t-pci", result, "csv", "reuse_distance")
        with open(response.path, newline="", encoding="utf-8-sig") as handle:
            rows = list(csv.DictReader(handle))
        assert rows[0]["目标PCI"] == "120"
        assert rows[0]["源小区与目标小区距离(米)"] == "1200.0"

    @pytest.mark.asyncio
    async def test_confusion_headers_keep_target1_target2(self, tmp_path, monkeypatch):
        """混淆类别是唯一区分目标1/目标2的表格"""
        import csv

        from app.core.config import settings
        from app.services.export_service import export_pci_check_result

        monkeypatch.setattr(settings, "EXPORT_DIR", tmp_path)
        row = self._row(
            "confusion", "PCI混淆", 120, 120,
            cCgi="S3-1", cSiteId="S3", cSiteName="站点3", cSectorId="1",
            cSectorName="小区3", cPci=120, cFrequency=100, cVendor="厂家C",
            cCoverageType="室外", cLongitude=114.32, cLatitude=30.52, cAzimuth=180,
            aToCDistanceM=800.0, bToCDistanceM=400.0,
        )
        response = await export_pci_check_result(
            "t-confusion", {"results": {"confusion": [row]}}, "csv", "confusion"
        )
        with open(response.path, newline="", encoding="utf-8-sig") as handle:
            headers = list(next(csv.DictReader(handle)).keys())
        assert "目标1-CGI" in headers and "目标1-PCI" in headers
        assert "目标2-小区CGI" in headers and "目标2-小区PCI" in headers

    @pytest.mark.asyncio
    async def test_unmerged_category_uses_source_target_headers(self, tmp_path, monkeypatch):
        """未合并 CGI/PCI 的类别：核查→源、对照→目标，核查类型保持原样"""
        import csv

        from app.core.config import settings
        from app.services.export_service import export_pci_check_result

        monkeypatch.setattr(settings, "EXPORT_DIR", tmp_path)
        result = {
            "results": {"mod3_neighbor": [self._row("mod3_neighbor", "邻区模3冲突", 0, 3, modulus=3)]},
        }
        response = await export_pci_check_result("t-neighbor", result, "csv", "mod3_neighbor")
        with open(response.path, newline="", encoding="utf-8-sig") as handle:
            rows = list(csv.DictReader(handle))
        headers = list(rows[0].keys())
        assert "核查类型" in headers
        assert "源基站ID" in headers and "源小区名称" in headers and "源小区频点" in headers
        assert "目标基站ID" in headers and "目标小区频点" in headers
        assert "核查基站ID" not in headers and "对照小区频点" not in headers

    @pytest.mark.asyncio
    async def test_csv_requires_check_type(self, tmp_path, monkeypatch):
        from app.core.config import settings
        from app.services.export_service import export_pci_check_result

        monkeypatch.setattr(settings, "EXPORT_DIR", tmp_path)
        with pytest.raises(ValueError, match="CSV 导出需指定有效的核查类型"):
            await export_pci_check_result("t-csv", self._result(), "csv")

    @pytest.mark.asyncio
    async def test_csv_exports_single_category(self, tmp_path, monkeypatch):
        import csv

        from app.core.config import settings
        from app.services.export_service import export_pci_check_result

        monkeypatch.setattr(settings, "EXPORT_DIR", tmp_path)
        response = await export_pci_check_result("t-csv", self._result(), "csv", "collision")

        with open(response.path, newline="", encoding="utf-8-sig") as handle:
            rows = list(csv.DictReader(handle))
        assert len(rows) == 1
        assert rows[0]["核查类型"] == "PCI冲突"

    @pytest.mark.asyncio
    async def test_empty_result_raises(self, tmp_path, monkeypatch):
        from app.core.config import settings
        from app.services.export_service import export_pci_check_result

        monkeypatch.setattr(settings, "EXPORT_DIR", tmp_path)
        with pytest.raises(ValueError, match="没有可导出的核查结果"):
            await export_pci_check_result("t-none", {"results": {}}, "xlsx")


class TestNeighborCandidateBand:
    """邻区预规划目标池裁剪：只保留核查小区周边带宽内的小区"""

    def _two_clusters(self):
        """A 簇（核查小区所在）与 B 簇（远超带宽）"""
        return make_sites(
            site_with("SA1", make_sector("1", 10, 100)),
            site_with("SA2", make_sector("1", 10, 100, east_m=1000)),
            site_with("SB1", make_sector("1", 10, 100, east_m=30000)),
            site_with("SB2", make_sector("1", 10, 100, east_m=31000)),
        )

    def _arrays(self, sites, selected):
        service = PCICheckService()
        cells = service.load_cells(sites, "LTE")
        flags = np.array([service._is_selected(c, set(selected)) for c in cells], dtype=bool)
        return service, cells, service._to_arrays(cells), flags

    def test_cells_outside_band_are_pruned(self):
        service, cells, arr, flags = self._arrays(self._two_clusters(), ["SA1_1"])
        kept = cells_within_band(arr, flags, 10.0)
        assert {cells[i]["siteId"] for i in kept} == {"SA1", "SA2"}

    def test_pruned_far_pair_does_not_produce_collision(self):
        """30 公里外的同频同PCI小区不进入邻区规划 → 不报冲突；但同带宽内的同PCI对仍报"""
        service, result = run_check(self._two_clusters(), ["SA1_1"], neighbor_assoc=True)
        collisions = result["results"][CheckType.COLLISION.value]
        assert {row["bSiteId"] for row in collisions} == {"SA2"}

    def test_band_is_exact_distance_not_grid_margin(self):
        """带宽按精确距离判定：8公里内保留、15公里剔除（网格放大半径会误留远端小区）"""
        sites = make_sites(
            site_with("S1", make_sector("1", 10, 100)),
            site_with("S8", make_sector("1", 10, 100, east_m=8000)),
            site_with("S15", make_sector("1", 10, 100, east_m=15000)),
        )
        service = PCICheckService()
        cells = service.load_cells(sites, "LTE")
        flags = np.array([service._is_selected(c, {"S1_1"}) for c in cells], dtype=bool)
        kept = {cells[i]["siteId"] for i in cells_within_band(service._to_arrays(cells), flags, 10.0)}
        assert kept == {"S1", "S8"}

    def test_dense_pool_keeps_every_cell(self):
        """全部小区都在带宽内时不裁剪，结果与不裁剪一致"""
        sites = make_sites(
            site_with("S1", make_sector("1", 10, 100)),
            site_with("S2", make_sector("1", 10, 100, east_m=2000)),
            site_with("S3", make_sector("1", 10, 100, east_m=4000)),
        )
        service = PCICheckService()
        cells = service.load_cells(sites, "LTE")
        flags = np.array([service._is_selected(c, {"S1_1"}) for c in cells], dtype=bool)
        arr = service._to_arrays(cells)
        assert len(cells_within_band(arr, flags, 10.0)) == len(cells)


class TestCheckSwitches:
    """各类核查开关与“邻区关联”口径"""

    MOD3_CATEGORIES = (
        CheckType.MOD3_SAME_SITE.value,
        CheckType.MOD3_FACING.value,
        CheckType.MOD3_NEIGHBOR.value,
    )
    MOD30_CATEGORIES = (
        CheckType.MOD30_SAME_SITE.value,
        CheckType.MOD30_FACING.value,
        CheckType.MOD30_NEIGHBOR.value,
    )

    def _sites(self):
        """S1_1 勾选；S2_1 在 200 米对打位；S3_1 在 2 公里（几何口径够不到）"""
        return make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=90)),
            site_with("S2", make_sector("1", 3, 100, east_m=150, azimuth=270)),
            site_with("S3", make_sector("1", 6, 100, east_m=2000, azimuth=270)),
        )

    def test_mod3_switch_off_skips_all_mod3_categories(self):
        _, result = run_check(self._sites(), ["S1_1"], mod3_check=False, neighbor_assoc=True)
        assert not set(self.MOD3_CATEGORIES) & set(result["results"].keys())
        # 其余类别不受影响
        assert CheckType.REUSE_DISTANCE.value in result["results"]

    def test_mod30_switch_off_skips_nr_mod30_categories(self):
        _, result = run_check(self._sites(), ["S1_1"], network_type="NR",
                              mod30_check=False, neighbor_assoc=True)
        assert not set(self.MOD30_CATEGORIES) & set(result["results"].keys())
        assert CheckType.MOD3_FACING.value in result["results"]

    def test_neighbor_off_skips_neighbor_categories(self):
        _, result = run_check(self._sites(), ["S1_1"], neighbor_assoc=False)
        assert not set(self.MOD3_CATEGORIES[2:]) & set(result["results"].keys())
        assert CheckType.CONFUSION.value not in result["results"]

    def test_neighbor_on_adds_pairs_beyond_geometry_gate(self, monkeypatch):
        stub_adjacency(monkeypatch, {"S1_1": ["S2_1", "S3_1"]})
        _, result = run_check(self._sites(), ["S1_1"], neighbor_assoc=True)
        neighbor_rows = result["results"][CheckType.MOD3_NEIGHBOR.value]
        # S2_1 已由对打模3报出，不重复；只剩 2 公里外的 S3_1
        assert {row["bSiteId"] for row in neighbor_rows} == {"S3"}
        assert "基于预规划邻区对" in neighbor_rows[0]["reason"]
        assert len(result["results"][CheckType.MOD3_FACING.value]) == 1

    def test_neighbor_on_adds_mod30_pairs(self, monkeypatch):
        """4 公里外的同频邻区超出对打口径，由关联邻区补出模30冲突"""
        stub_adjacency(monkeypatch, {"S1_1": ["S2_1"]})
        sites = make_sites(
            site_with("S1", make_sector("1", 0, 100)),
            site_with("S2", make_sector("1", 30, 100, east_m=4000)),
        )
        _, result = run_check(sites, ["S1_1"], network_type="NR", neighbor_assoc=True)
        rows = result["results"][CheckType.MOD30_NEIGHBOR.value]
        assert len(rows) == 1
        assert rows[0]["modulus"] == 30
        assert rows[0]["aMod"] == 0 and rows[0]["bMod"] == 0

    def test_mod30_neighbor_dedupes_facing_pairs(self, monkeypatch):
        """对打模30已报的小区对不在邻区类别里重复"""
        stub_adjacency(monkeypatch, {"S1_1": ["S2_1"]})
        sites = make_sites(
            site_with("S1", make_sector("1", 0, 100, azimuth=90)),
            site_with("S2", make_sector("1", 30, 100, east_m=150, azimuth=270)),
        )
        _, result = run_check(sites, ["S1_1"], network_type="NR", neighbor_assoc=True)
        assert len(result["results"][CheckType.MOD30_FACING.value]) == 1
        assert result["results"][CheckType.MOD30_NEIGHBOR.value] == []

    def test_reuse_switch_off_skips_reuse_category(self):
        _, result = run_check(self._sites(), ["S1_1"], reuse_check=False)
        assert CheckType.REUSE_DISTANCE.value not in result["results"]

    def test_collision_switch_off_skips_collision(self):
        _, result = run_check(self._sites(), ["S1_1"], collision_check=False)
        assert CheckType.COLLISION.value not in result["results"]

    def test_confusion_switch_off_skips_confusion(self, monkeypatch):
        stub_adjacency(monkeypatch, {"S1_1": ["S2_1", "S3_1"]})
        _, result = run_check(self._sites(), ["S1_1"], confusion_check=False, neighbor_assoc=True)
        assert CheckType.CONFUSION.value not in result["results"]

    def test_all_checks_off_skips_neighbor_planning(self):
        _, result = run_check(
            self._sites(), ["S1_1"], neighbor_assoc=True,
            reuse_check=False, collision_check=False, confusion_check=False,
            mod3_check=False, mod30_check=False,
        )
        assert result["results"] == {}
        assert result["neighborPairCount"] == 0

    def test_switches_echoed_in_result(self):
        _, result = run_check(self._sites(), ["S1_1"], mod3_check=False, neighbor_assoc=True)
        assert result["mod3Check"] is False
        assert result["neighborAssoc"] is True
        assert result["macroPairDistanceM"] == 200.0
        assert result["mixedPairDistanceM"] == 100.0
        assert result["indoorPairDistanceM"] == 50.0
        assert result["minReuseDistanceMacroM"] == 2000.0
        assert result["minReuseDistanceIndoorM"] == 500.0
        assert result["macroFacingAngleDeg"] == 90.0
        assert result["indoorFacingAngleDeg"] == 60.0


class TestLoadCellsAndSkips:
    def test_missing_pci_is_skipped_with_reason(self):
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100),
            {"id": "2", "name": "无PCI小区", "pci": None, "earfcn": 100, "azimuth": 0,
             "latitude": LAT0, "longitude": LON0},
        ))
        service, result = run_check(sites, ["S1_1", "S1_2"])
        assert {item["sectorId"]: item["reason"] for item in service.last_load_skipped} == {"2": "missing_pci"}

    def test_missing_coordinates_is_skipped(self):
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100),
            {"id": "2", "name": "无坐标", "pci": 1, "earfcn": 100, "azimuth": 0,
             "latitude": 0, "longitude": None},
        ))
        _, result = run_check(sites, ["S1_1", "S1_2"])
        assert any(i["reason"] == "missing_coordinates" for i in result["skippedCells"])

    def test_duplicate_cells_are_deduped(self):
        sector = make_sector("1", 0, 100)
        sites = [{"id": "S1", "name": "站点", "latitude": LAT0, "longitude": LON0,
                  "sectors": [sector, dict(sector)]}]
        assert len(PCICheckService().load_cells(sites, "LTE")) == 1

    def test_bare_sector_id_selection_still_matches(self):
        """选中列表用裸小区ID（与前端两种 key 形式兼容）"""
        sites = make_sites(site_with("S1",
            make_sector("1", 0, 100),
            make_sector("2", 3, 100),
        ))
        _, result = run_check(sites, ["1"])
        assert len(result["results"][CheckType.MOD3_SAME_SITE.value]) == 1

    def test_missing_frequency_cell_is_not_compared(self):
        """频点缺失按异频处理，任何同频类核查都不报"""
        sites = make_sites(
            site_with("S1", {**make_sector("1", 0, 100), "earfcn": None}),
            site_with("S2", make_sector("1", 0, 100, east_m=100)),
        )
        _, result = run_check(sites, ["S1_1"], pair_km=3.0)
        assert result["results"][CheckType.REUSE_DISTANCE.value] == []
        assert result["results"][CheckType.MOD3_FACING.value] == []

    def test_selection_without_match_raises(self):
        sites = make_sites(site_with("S1", make_sector("1", 0, 100)))
        with pytest.raises(ValueError, match="无可核查小区"):
            run_check(sites, ["NOT_EXIST_9"])

    def test_empty_params_raises(self):
        with pytest.raises(ValueError, match="没有可核查"):
            run_check([], ["S1_1"])
