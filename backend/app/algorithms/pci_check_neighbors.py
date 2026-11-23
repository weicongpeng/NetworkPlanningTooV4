"""
PCI核查邻区预规划

冲突/混淆/模值邻区核查共用一次内存内的同频邻区对预规划；这里只保留同频邻接表，
规划原始结果用完即弃，不落盘、不呈现。
"""

import logging
from collections import defaultdict
from typing import Any, Callable, Dict, List

import numpy as np

from app.algorithms.neighbor_planning_v1_service import (
    NeighborConfig as NeighborPlanningConfig,
    run_same_freq_adjacency,
)
from app.algorithms.pci_check_candidates import cells_within_band
from app.algorithms.pci_check_types import (
    NEIGHBOR_CANDIDATE_BAND_KM,
    NEIGHBOR_DEFAULT_PARAMS,
    PCICheckParams,
)

logger = logging.getLogger(__name__)


def needs_neighbor_planning(params: PCICheckParams) -> bool:
    """邻区关联打开且存在依赖邻区对的核查类别时才需要预规划"""
    return params.neighbor_assoc and (
        params.enable_collision_check
        or params.enable_confusion_check
        or params.enable_mod3_check
        or (params.network_type == "NR" and params.enable_mod30_check)
    )


def plan_same_freq_neighbors(
    cells: List[Dict],
    arr: Dict[str, Any],
    flags: np.ndarray,
    params: PCICheckParams,
    progress: Callable[[float], Any],
) -> Dict[int, List[int]]:
    """用邻区规划默认参数在内存预规划邻区对，只保留同频邻接关系。

    目标池按 NEIGHBOR_CANDIDATE_BAND_KM 裁剪到核查小区周边：邻区规划成本约为
    勾选数 × 目标池大小，裁掉远端小区是最直接的提速手段，且不影响带宽内的核查结果。

    Returns:
        {源小区下标: [同频邻小区下标, ...]}
    """
    if not needs_neighbor_planning(params):
        return {}

    index_of_key = {cell["key"]: idx for idx, cell in enumerate(cells)}
    selected_cells = [cell for cell, selected in zip(cells, flags) if selected]
    if not selected_cells:
        return {}

    planning_config = NeighborPlanningConfig(
        source_type=params.network_type,
        target_type=params.network_type,
        **NEIGHBOR_DEFAULT_PARAMS,
    )

    def on_planning_progress(value: float) -> None:
        # 邻区预规划占整条链路绝大部分耗时，进度映射到 8%~80% 避免长时间停滞
        progress(8 + max(0.0, min(float(value), 100.0)) * 0.72)

    band_indices = cells_within_band(arr, flags, NEIGHBOR_CANDIDATE_BAND_KM)
    target_cells = [cells[i] for i in band_indices]

    adjacency_by_key = run_same_freq_adjacency(
        planning_config,
        _build_sites(selected_cells),
        _build_sites(target_cells),
        on_planning_progress,
    )

    adjacency: Dict[int, List[int]] = defaultdict(list)
    for source_key, target_keys in adjacency_by_key.items():
        source_idx = index_of_key.get(source_key)
        if source_idx is None:
            continue
        for target_key in target_keys:
            target_idx = index_of_key.get(target_key)
            if target_idx is None or target_idx == source_idx:
                continue
            if not _same_frequency(arr, source_idx, target_idx):
                continue
            adjacency[source_idx].append(target_idx)

    logger.info("[PCICheck] 同频邻区对预规划完成: 服务小区 %d 个", len(adjacency))
    return adjacency


def _build_sites(cells: List[Dict]) -> List[Dict]:
    """由已加载小区重建站点结构，保证邻区预规划与核查用的是同一份去重后的数据"""
    by_site: Dict[str, Dict] = {}
    for cell in cells:
        site = by_site.get(cell["siteId"])
        if site is None:
            site = {
                "id": cell["siteId"],
                "name": cell["siteName"],
                "latitude": cell["latitude"],
                "longitude": cell["longitude"],
                "sectors": [],
            }
            by_site[cell["siteId"]] = site
        site["sectors"].append(cell["raw"])
    return list(by_site.values())


def _same_frequency(arr: Dict[str, Any], i: int, j: int) -> bool:
    """同频判定：任一侧频点缺失按异频处理（与邻区规划口径一致）"""
    freq_i = float(arr["freqs"][i])
    return freq_i >= 0 and freq_i == float(arr["freqs"][j])
