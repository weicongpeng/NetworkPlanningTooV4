"""邻区预规划同频邻接口径快照

快照由重构前（全表扫描版）NeighborPlanner 生成，锁定向量化/网格化改造
前后同频邻接关系完全一致，防止后续调优改变邻区口径。
"""
import json
import math
from pathlib import Path

import pytest

from app.algorithms.neighbor_planning_v1_service import (
    NeighborConfig,
    run_same_freq_adjacency,
)
from app.algorithms.pci_check_types import NEIGHBOR_DEFAULT_PARAMS

LAT0 = 30.5
LON0 = 114.3
LON_KM_PER_DEG = 111.0 * math.cos(math.radians(LAT0))
SNAPSHOT_PATH = Path(__file__).parent / "fixtures" / "neighbor_adjacency_snapshot.json"


def _sector(sector_id, pci=1, earfcn=1650, east_m=0.0, north_m=0.0,
            azimuth=0.0, indoor=False):
    return {
        "id": sector_id,
        "name": f"c{sector_id}",
        "pci": pci,
        "earfcn": earfcn,
        "azimuth": azimuth,
        "latitude": LAT0 + north_m / 1000.0 / 111.0,
        "longitude": LON0 + east_m / 1000.0 / LON_KM_PER_DEG,
        "cell_cover_type": 4 if indoor else 1,
    }


def _site(site_id, sectors):
    return {
        "id": site_id,
        "name": site_id,
        "latitude": LAT0,
        "longitude": LON0,
        "sectors": sectors,
    }


def _dense_scene():
    """密集室外：250m 网格，3 扇区，同频+异频混合；含室外→室分"""
    sites = []
    for ix in range(4):
        for iy in range(4):
            sectors = [
                _sector(f"{ix}_{iy}_0", pci=(ix * 3 + iy) % 100, earfcn=1650,
                        east_m=ix * 250, north_m=iy * 250, azimuth=0),
                _sector(f"{ix}_{iy}_1", pci=(ix + iy * 2) % 100, earfcn=1650,
                        east_m=ix * 250, north_m=iy * 250, azimuth=120),
                _sector(f"{ix}_{iy}_2", pci=(ix * 2 + iy) % 100, earfcn=1850,
                        east_m=ix * 250, north_m=iy * 250, azimuth=240),
            ]
            if ix == 1 and iy == 1:
                sectors.append(_sector("indoor_1", pci=7, earfcn=1650,
                                       east_m=ix * 250 + 80, north_m=iy * 250 + 60,
                                       azimuth=90, indoor=True))
            sites.append(_site(f"S{ix}{iy}", sectors))
    return sites


def _sparse_scene():
    """稀疏室外：2.5km 间距，覆盖圆相交/背向，含无方位角"""
    sites = []
    for ix in range(3):
        for iy in range(3):
            azimuth = None if (ix == 2 and iy == 2) else (ix * 40 + iy * 30) % 360
            sectors = [
                _sector(f"{ix}_{iy}_a", pci=(ix * 5 + iy) % 50, earfcn=1650,
                        east_m=ix * 2500, north_m=iy * 2500, azimuth=azimuth),
                _sector(f"{ix}_{iy}_b", pci=(ix + iy * 5) % 50, earfcn=1850,
                        east_m=ix * 2500, north_m=iy * 2500,
                        azimuth=None if azimuth is None else (azimuth + 180) % 360),
            ]
            sites.append(_site(f"P{ix}{iy}", sectors))
    return sites


def _indoor_scene():
    """室分源：室分→室分 350m、室分→室外 1.5x 站间距"""
    sites = []
    for ix in range(3):
        for iy in range(3):
            sites.append(_site(f"O{ix}{iy}", [
                _sector(f"{ix}_{iy}_o", pci=10 + ix * 3 + iy, earfcn=1650,
                        east_m=ix * 400, north_m=iy * 400, azimuth=90),
            ]))
    sites.append(_site("I0", [
        _sector("i_a", pci=33, earfcn=1650, east_m=400, north_m=400,
                azimuth=0, indoor=True),
        _sector("i_b", pci=34, earfcn=1650, east_m=450, north_m=420,
                azimuth=0, indoor=True),
        _sector("i_c", pci=35, earfcn=1650, east_m=1200, north_m=410,
                azimuth=0, indoor=True),
    ]))
    return sites


def _truncation_scene():
    """同频候选 > 64，验证按距离截断"""
    sectors = []
    for k in range(80):
        angle = 2 * math.pi * k / 80
        sectors.append(_sector(
            f"n{k}", pci=k % 40, earfcn=1650,
            east_m=900 * math.cos(angle), north_m=900 * math.sin(angle),
            azimuth=(math.degrees(angle) + 180) % 360,
        ))
    return [
        _site("C", [_sector("center", pci=1, earfcn=1650, azimuth=0)]),
        _site("RING", sectors),
    ]


def _edge_scene():
    """缺频点 / 0 方位角 / 同站多频"""
    return [
        _site("E1", [
            _sector("a", pci=1, earfcn=None, azimuth=0),
            _sector("b", pci=2, earfcn=1650, azimuth=0),
            _sector("c", pci=3, earfcn=1650, azimuth=None),
        ]),
        _site("E2", [
            _sector("d", pci=4, earfcn=1650, east_m=200, azimuth=180),
        ]),
    ]


SCENES = {
    "dense": _dense_scene,
    "sparse": _sparse_scene,
    "indoor": _indoor_scene,
    "truncation": _truncation_scene,
    "edge": _edge_scene,
}


@pytest.mark.parametrize("scene_name", sorted(SCENES))
def test_same_freq_adjacency_matches_snapshot(scene_name):
    expected = {
        item["name"]: item["adjacency"]
        for item in json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    }[scene_name]
    sites = SCENES[scene_name]()
    config = NeighborConfig(
        source_type="LTE", target_type="LTE", **NEIGHBOR_DEFAULT_PARAMS
    )
    adjacency = run_same_freq_adjacency(config, sites, sites)
    actual = {key: sorted(targets) for key, targets in sorted(adjacency.items()) if targets}
    assert actual == expected
