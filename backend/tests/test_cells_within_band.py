"""PCI 目标池裁剪：全选短路与网格候选的正确定性"""
import numpy as np

from app.algorithms.distance_calculator import DistanceCalculator
from app.algorithms.pci_check_candidates import cells_within_band


def _arr(lats, lons):
    return {"lats": np.array(lats, dtype=float), "lons": np.array(lons, dtype=float)}


def _brute_force(arr, flags, band_km):
    selected = np.nonzero(flags)[0]
    keep = []
    for idx in range(len(arr["lats"])):
        dist = DistanceCalculator.batch_haversine(
            np.array([arr["lats"][idx]]), np.array([arr["lons"][idx]]),
            arr["lats"][selected], arr["lons"][selected],
        )
        if float(dist.min()) <= band_km:
            keep.append(idx)
    return keep


def test_select_all_short_circuits_distance_matrix():
    lats = [30.5, 30.6, 30.7, 40.0]
    lons = [114.3, 114.4, 114.5, 116.0]
    arr = _arr(lats, lons)
    flags = np.ones(len(lats), dtype=bool)
    assert cells_within_band(arr, flags, 10.0) == [0, 1, 2, 3]


def test_empty_selection_returns_empty():
    arr = _arr([30.5, 30.6], [114.3, 114.4])
    assert cells_within_band(arr, np.zeros(2, dtype=bool), 10.0) == []


def test_grid_matches_bruteforce_on_scattered_points():
    rng = np.random.default_rng(42)
    lats = 30.5 + rng.uniform(0.0, 0.3, 300)
    lons = 114.3 + rng.uniform(0.0, 0.3, 300)
    flags = rng.random(300) < 0.2
    arr = _arr(lats, lons)
    assert cells_within_band(arr, flags, 10.0) == _brute_force(arr, flags, 10.0)
