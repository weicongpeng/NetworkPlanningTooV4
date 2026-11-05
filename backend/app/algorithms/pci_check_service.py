"""
PCI核查服务

对勾选小区按 9 类规则核查 PCI 配置：
复用距离 / 冲突 / 混淆 / 同站模3 / 对打模3 / 邻区模3 / 同站模30 / 对打模30 / 邻区模30。
邻区类核查依赖一次内存预规划的同频邻区对（固定使用邻区规划默认参数），只在内存中存活，
核查结束即释放，不落盘、不呈现给用户。

核查口径：
- 制式单选，所有比较只在同制式内进行；核查小区=勾选小区，对照池=全量工参同制式小区
- 复用距离：同频 + PCI 相同 + 距离 ≤ 被核查小区类型（宏站/室分）的最小复用距离门限
- 冲突：邻区关联关闭时按复用距离口径输出；打开时不看距离，核查小区与其同频邻区 PCI 相同即冲突
- 混淆：仅在邻区关联打开时核查；核查小区的两个同频邻区 PCI 相同
- 同站模3：同站 + 同频，站内 ≤3 个小区时模3不能相同；>3 个时按小区ID顺序非连续分配，
  相邻小区模3相同才算异常（与 PCI 规划约束一致）
- 对打模3/模30：非同站 + 同频 + 距离 ≤ 对打门限 + 方位角互指（宏站/室分夹角门限分开），
  模3/模30 相同（对打模30 仅 NR）
- 同站模30（仅 NR）：同站 + 同频，模30 不能相同（与 NR 规划约束一致）
- 邻区模3/模30：邻区关联打开时，核查小区与同频邻区模值相同，几何口径已报出的对不重复

候选枚举/取值工具见 `pci_check_candidates`，核查类别与门限常量见 `pci_check_types`。
"""

import logging
from collections import defaultdict
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

from app.algorithms.pci_check_candidates import (
    coerce_azimuth,
    coerce_coord,
    coerce_float,
    coerce_int,
    distance_km,
    group_pairs,
    is_facing,
    meters,
    near_pairs,
    same_site_mod_pairs,
)
from app.algorithms.pci_check_neighbors import plan_same_freq_neighbors
from app.algorithms.pci_check_rows import (
    build_pair_row,
    collision_distance_reason,
    collision_reason,
    confusion_reason,
    facing_reason,
    mod_reason,
    reuse_reason,
)
from app.algorithms.pci_check_types import (
    MAX_CONFUSION_GROUP,
    NEIGHBOR_CANDIDATE_BAND_KM,
    CheckType,
    PCICheckParams,
)

logger = logging.getLogger(__name__)

MOD3_CATEGORIES = (
    CheckType.MOD3_SAME_SITE,
    CheckType.MOD3_FACING,
    CheckType.MOD3_NEIGHBOR,
)
MOD30_CATEGORIES = (
    CheckType.MOD30_SAME_SITE,
    CheckType.MOD30_FACING,
    CheckType.MOD30_NEIGHBOR,
)


class PCICheckService:
    """PCI核查服务（纯内存计算，不写文件、不建任务）"""

    def __init__(self) -> None:
        # 因工参数据不全被跳过的小区（口径与 TAC 核查一致，供 task_manager._collect_skipped_cells 复用）
        self.last_load_skipped: List[Dict] = []
        self._progress: Callable[[float], Any] = lambda progress: None
        self.params = PCICheckParams(network_type="LTE")

    # ============================== 入口 ==============================

    def run(
        self,
        sites: List[Dict],
        selected_keys: List[str],
        params: PCICheckParams,
        progress_callback: Optional[Callable[[float], Any]] = None,
    ) -> Dict[str, Any]:
        """执行 PCI 核查。

        Args:
            sites: 全量工参中本制式的站点列表（[{id, name, latitude, longitude, sectors: [...]}]）
            selected_keys: 勾选小区 id 列表（``siteId_sectorId`` 或裸 ``sectorId``）
            params: 核查参数（制式、门限、开关）
            progress_callback: 进度回调（0-100）

        Returns:
            {"results": {checkType: rows}, "summary": {checkType: count}, 统计字段...}
        """
        self.params = params
        self._progress = progress_callback or (lambda progress: None)

        cells = self.load_cells(sites, params.network_type)
        if not cells:
            skipped = f"（{len(self.last_load_skipped)} 个小区因工参数据不全被跳过）" if self.last_load_skipped else ""
            raise ValueError(f"全量工参中没有可核查的{params.network_type}小区数据{skipped}")

        selected_set = {str(key) for key in selected_keys or []}
        flags = np.array([self._is_selected(cell, selected_set) for cell in cells], dtype=bool)
        if not flags.any():
            raise ValueError("选中的小区均未在当前工参中匹配到，无可核查小区")

        arr = self._to_arrays(cells)
        self._progress(8)

        adjacency = self._plan_same_freq_neighbors(cells, arr, flags)
        self._progress(82)

        rows: Dict[CheckType, List[Dict]] = {}
        if params.enable_mod3_check:
            rows[CheckType.MOD3_SAME_SITE] = []
            self._check_same_site_mod(cells, arr, flags, rows[CheckType.MOD3_SAME_SITE], 3)
            rows[CheckType.MOD3_FACING] = []
            self._check_facing_mod(cells, arr, flags, rows[CheckType.MOD3_FACING], 3)
            self._progress(86)
        if params.network_type == "NR" and params.enable_mod30_check:
            rows[CheckType.MOD30_SAME_SITE] = []
            self._check_same_site_mod(cells, arr, flags, rows[CheckType.MOD30_SAME_SITE], 30)
            rows[CheckType.MOD30_FACING] = []
            self._check_facing_mod(cells, arr, flags, rows[CheckType.MOD30_FACING], 30)
            self._progress(89)

        if params.enable_reuse_check:
            rows[CheckType.REUSE_DISTANCE] = []
            self._check_reuse_based(cells, arr, flags, rows[CheckType.REUSE_DISTANCE], CheckType.REUSE_DISTANCE)
            self._progress(92)

        if params.enable_collision_check:
            rows[CheckType.COLLISION] = []
            if params.neighbor_assoc:
                self._check_neighbor_collision(cells, arr, flags, adjacency, rows[CheckType.COLLISION])
            else:
                self._check_reuse_based(cells, arr, flags, rows[CheckType.COLLISION], CheckType.COLLISION)
            self._progress(94)

        if params.enable_confusion_check and params.neighbor_assoc:
            rows[CheckType.CONFUSION] = []
            self._check_confusion(cells, arr, flags, adjacency, rows[CheckType.CONFUSION])
            self._progress(96)

        if params.neighbor_assoc and params.enable_mod3_check:
            skip_pairs = self._reported_pairs(rows, (CheckType.MOD3_SAME_SITE, CheckType.MOD3_FACING))
            rows[CheckType.MOD3_NEIGHBOR] = []
            self._check_mod_neighbor(cells, flags, adjacency, rows[CheckType.MOD3_NEIGHBOR], 3, skip_pairs)
            self._progress(98)
        if params.neighbor_assoc and params.network_type == "NR" and params.enable_mod30_check:
            skip_pairs = self._reported_pairs(rows, (CheckType.MOD30_SAME_SITE, CheckType.MOD30_FACING))
            rows[CheckType.MOD30_NEIGHBOR] = []
            self._check_mod_neighbor(cells, flags, adjacency, rows[CheckType.MOD30_NEIGHBOR], 30, skip_pairs)
        self._progress(99)

        neighbor_pair_count = sum(len(targets) for targets in adjacency.values())
        adjacency.clear()

        summary = {check_type.value: len(rows[check_type]) for check_type in rows}
        logger.info(
            "[PCICheck] 核查完成: 制式=%s, 核查小区=%d, 对照池=%d, 同频邻区对=%d, 分类命中=%s",
            params.network_type, int(flags.sum()), len(cells), neighbor_pair_count, summary,
        )
        return {
            "networkType": params.network_type,
            "macroPairDistanceM": meters(params.macro_pair_distance_km),
            "mixedPairDistanceM": meters(params.mixed_pair_distance_km),
            "indoorPairDistanceM": meters(params.indoor_pair_distance_km),
            "minReuseDistanceMacroM": meters(params.min_reuse_distance_macro_km),
            "minReuseDistanceIndoorM": meters(params.min_reuse_distance_indoor_km),
            "macroFacingAngleDeg": params.macro_facing_gate_deg,
            "indoorFacingAngleDeg": params.indoor_facing_gate_deg,
            "reuseCheck": params.enable_reuse_check,
            "collisionCheck": params.enable_collision_check,
            "confusionCheck": params.enable_confusion_check,
            "mod3Check": params.enable_mod3_check,
            "mod30Check": params.enable_mod30_check,
            "neighborAssoc": params.neighbor_assoc,
            "totalCells": int(flags.sum()),
            "poolCells": len(cells),
            "matchedKeys": [cell["key"] for cell, flag in zip(cells, flags) if flag],
            "neighborBandKm": NEIGHBOR_CANDIDATE_BAND_KM,
            "neighborPairCount": neighbor_pair_count,
            "skippedCells": self.last_load_skipped,
            "skippedCount": len(self.last_load_skipped),
            "summary": summary,
            "results": {check_type.value: rows[check_type] for check_type in rows},
        }

    @staticmethod
    def _reported_pairs(rows: Dict[CheckType, List[Dict]], categories: Tuple[CheckType, ...]) -> set:
        """收集已报出的小区对（无序），供关联邻区口径去重"""
        reported = set()
        for category in categories:
            for row in rows.get(category, []):
                reported.add(frozenset((
                    f"{row['aSiteId']}_{row['aSectorId']}",
                    f"{row['bSiteId']}_{row['bSectorId']}",
                )))
        return reported

    # ============================== 数据准备 ==============================

    def load_cells(self, sites: List[Dict], network_type: str) -> List[Dict]:
        """展平站点为小区列表，按「站点ID&小区ID」去重，记录被跳过的小区"""
        self.last_load_skipped = []
        seen: set = set()
        cells: List[Dict] = []

        for site in sites or []:
            site_id = site.get("id", "")
            site_name = site.get("name", "")
            for sector in site.get("sectors", []) or []:
                sector_id = sector.get("id", "")
                sector_name = sector.get("name", "")

                if not site_id or not sector_id:
                    self._record_skipped(site_id, site_name, sector_id, sector_name, "missing_ids")
                    continue

                longitude = coerce_coord(sector.get("longitude"))
                latitude = coerce_coord(sector.get("latitude"))
                if longitude is None or latitude is None:
                    self._record_skipped(site_id, site_name, sector_id, sector_name, "missing_coordinates")
                    continue

                unique_key = f"{site_id}&{sector_id}"
                if unique_key in seen:
                    continue
                seen.add(unique_key)

                pci = coerce_int(sector.get("pci"))
                if pci is None:
                    self._record_skipped(site_id, site_name, sector_id, sector_name, "missing_pci")
                    continue

                cells.append({
                    "siteId": str(site_id),
                    "siteName": "" if site_name is None else str(site_name),
                    "sectorId": str(sector_id),
                    "sectorName": "" if sector_name is None else str(sector_name),
                    "networkType": network_type,
                    "key": f"{site_id}_{sector_id}",
                    "longitude": longitude,
                    "latitude": latitude,
                    "pci": pci,
                    "frequency": coerce_float(
                        sector.get("earfcn") or sector.get("frequency") or sector.get("ssb_frequency")
                    ),
                    "azimuth": coerce_azimuth(sector.get("azimuth")),
                    "isIndoor": self._is_indoor(sector),
                    # 全量工参的“第一分组”即厂家列
                    "vendor": self._coerce_vendor(sector.get("first_group")),
                    "raw": sector,
                })

        logger.info("[PCICheck] 加载小区 %d 个，跳过 %d 个", len(cells), len(self.last_load_skipped))
        return cells

    @staticmethod
    def _is_indoor(sector: Dict) -> bool:
        """小区覆盖类型 4 为室分（与邻区规划/PCI规划口径一致）"""
        try:
            return int(float(sector.get("cell_cover_type", 1))) == 4
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _coerce_vendor(value: Any) -> str:
        """厂家取值；空值/Pandas 空值占位统一为空字符串"""
        if value is None:
            return ""
        text = str(value).strip()
        return "" if text.lower() in ("", "nan", "none") else text

    @staticmethod
    def _is_selected(cell: Dict, selected_set: set) -> bool:
        """与 TAC/PCI 规划一致的选中判定：siteId_sectorId 或裸 sectorId 命中即可"""
        return cell["key"] in selected_set or cell["sectorId"] in selected_set

    def _record_skipped(
        self, site_id: Any, site_name: Any, sector_id: Any, sector_name: Any, reason: str
    ) -> None:
        self.last_load_skipped.append({
            "siteId": "" if site_id is None else str(site_id),
            "siteName": "" if site_name is None else str(site_name),
            "sectorId": "" if sector_id is None else str(sector_id),
            "sectorName": "" if sector_name is None else str(sector_name),
            "reason": reason,
        })

    def _plan_same_freq_neighbors(
        self, cells: List[Dict], arr: Dict[str, Any], flags: np.ndarray
    ) -> Dict[int, List[int]]:
        """邻区关联链路入口（独立成方法便于测试替换预规划结果）"""
        return plan_same_freq_neighbors(cells, arr, flags, self.params, self._progress)

    def _to_arrays(self, cells: List[Dict]) -> Dict[str, Any]:
        """小区列表转为向量化所需的数组。

        同站判定口径：相同基站ID且经纬度相同的站点才算同站，site_codes 按
        (基站ID, 经度, 纬度) 编码；用于同站模值分组和对打排除同站。
        """
        site_codes: Dict[Tuple[str, float, float], int] = {}
        codes: List[int] = []
        for cell in cells:
            site_key = (cell["siteId"], round(cell["longitude"], 8), round(cell["latitude"], 8))
            code = site_codes.get(site_key)
            if code is None:
                code = len(site_codes)
                site_codes[site_key] = code
            codes.append(code)

        return {
            "lats": np.array([c["latitude"] for c in cells], dtype=float),
            "lons": np.array([c["longitude"] for c in cells], dtype=float),
            "pcis": np.array([c["pci"] for c in cells], dtype=np.int64),
            # 频点缺失以 -1 占位，任何同频判定都不成立；频点保留小数
            "freqs": np.array(
                [-1.0 if c["frequency"] is None else float(c["frequency"]) for c in cells],
                dtype=np.float64,
            ),
            "site_codes": np.array(codes, dtype=np.int64),
        }

    # ============================== 核查规则 ==============================

    def _check_same_site_mod(
        self, cells: List[Dict], arr: Dict[str, Any], flags: np.ndarray, rows: List[Dict], modulus: int
    ) -> None:
        """同站 + 同频模值核查：模3 超 3 小区按非连续分配，模30 严格不相同"""
        check_type = CheckType.MOD3_SAME_SITE if modulus == 3 else CheckType.MOD30_SAME_SITE
        for i, j in same_site_mod_pairs(cells, arr, modulus):
            if not (flags[i] or flags[j]):
                continue
            a, b = (i, j) if flags[i] else (j, i)
            rows.append(build_pair_row(
                check_type, cells, a, b, distance_km(cells, a, b), modulus=modulus,
                reason=mod_reason(cells[a], cells[b], cells[a]["pci"] % modulus, modulus, "同站同频"),
            ))

    def _check_facing_mod(
        self, cells: List[Dict], arr: Dict[str, Any], flags: np.ndarray, rows: List[Dict], modulus: int
    ) -> None:
        """对打：非同站 + 同频 + 距离 ≤ 对应类型对打门限 + 互指，模值相同"""
        check_type = CheckType.MOD3_FACING if modulus == 3 else CheckType.MOD30_FACING
        pcis = arr["pcis"]
        for i, j, dist in near_pairs(arr, self.params.max_pair_distance_km, exclude_same_site=True):
            gate_km = self.params.pair_distance_km(cells[i]["isIndoor"], cells[j]["isIndoor"])
            if dist > gate_km:
                continue
            same_pci = bool(pcis[i] == pcis[j])
            if not same_pci and int(pcis[i]) % modulus != int(pcis[j]) % modulus:
                continue
            indoor_involved = cells[i]["isIndoor"] or cells[j]["isIndoor"]
            if not is_facing(cells[i], cells[j], self.params.facing_gate_deg(indoor_involved)):
                continue
            if not (flags[i] or flags[j]):
                continue
            a, b = (i, j) if flags[i] else (j, i)
            rows.append(build_pair_row(
                check_type, cells, a, b, dist, modulus=modulus,
                reason=facing_reason(cells[a], cells[b], same_pci, dist, gate_km, modulus),
            ))

    def _check_reuse_based(
        self, cells: List[Dict], arr: Dict[str, Any], flags: np.ndarray, rows: List[Dict], check_type: CheckType
    ) -> None:
        """复用距离口径：同频 + PCI 相同 + 距离 ≤ 被核查小区类型的最小复用距离"""
        freqs, pcis = arr["freqs"], arr["pcis"]
        keys = [
            (float(freqs[i]), int(pcis[i])) if float(freqs[i]) >= 0 else None
            for i in range(len(pcis))
        ]
        for i, j, dist in group_pairs(keys, arr["lats"], arr["lons"], self.params.max_reuse_distance_km):
            if not (flags[i] or flags[j]):
                continue
            a, b = self._reuse_orientation(cells, flags, i, j)
            gate_km = self.params.reuse_distance_km(cells[a]["isIndoor"])
            if dist > gate_km:
                continue
            if check_type == CheckType.REUSE_DISTANCE:
                reason = reuse_reason(cells[a], dist, gate_km)
            else:
                reason = collision_distance_reason(cells[a], cells[b], dist, gate_km)
            rows.append(build_pair_row(check_type, cells, a, b, dist, modulus=None, reason=reason))

    def _reuse_orientation(
        self, cells: List[Dict], flags: np.ndarray, i: int, j: int
    ) -> Tuple[int, int]:
        """复用距离口径的输出方向：a 为被核查小区；两侧都勾选时取门限更大的一侧作为 a"""
        if flags[i] and flags[j]:
            gate_i = self.params.reuse_distance_km(cells[i]["isIndoor"])
            gate_j = self.params.reuse_distance_km(cells[j]["isIndoor"])
            return (i, j) if gate_i >= gate_j else (j, i)
        return (i, j) if flags[i] else (j, i)

    def _check_neighbor_collision(
        self,
        cells: List[Dict],
        arr: Dict[str, Any],
        flags: np.ndarray,
        adjacency: Dict[int, List[int]],
        rows: List[Dict],
    ) -> None:
        """PCI冲突（邻区关联打开）：核查小区同频邻区 PCI 相同，不看复用距离"""
        pcis = arr["pcis"]
        seen_pairs: set = set()
        for source, targets in adjacency.items():
            if not flags[source]:
                continue
            for target in targets:
                if int(pcis[source]) != int(pcis[target]):
                    continue
                pair = frozenset((source, target))
                if pair in seen_pairs:
                    continue
                seen_pairs.add(pair)
                dist = distance_km(cells, source, target)
                rows.append(build_pair_row(
                    CheckType.COLLISION, cells, source, target, dist, modulus=None,
                    reason=collision_reason(cells[source], cells[target], dist),
                ))

    def _check_confusion(
        self,
        cells: List[Dict],
        arr: Dict[str, Any],
        flags: np.ndarray,
        adjacency: Dict[int, List[int]],
        rows: List[Dict],
    ) -> None:
        """PCI混淆：核查小区的同频邻区列表中存在两个 PCI 相同的邻小区"""
        pcis = arr["pcis"]
        for source, targets in adjacency.items():
            if not flags[source] or len(targets) < 2:
                continue
            by_pci: Dict[int, List[int]] = defaultdict(list)
            for target in targets:
                by_pci[int(pcis[target])].append(target)

            for pci_value, group in by_pci.items():
                if len(group) < 2:
                    continue
                listed = group[:MAX_CONFUSION_GROUP]
                for offset in range(len(listed)):
                    for second in range(offset + 1, len(listed)):
                        first_idx, second_idx = listed[offset], listed[second]
                        row = build_pair_row(
                            CheckType.CONFUSION, cells, source, first_idx,
                            distance_km(cells, source, first_idx), modulus=None,
                            reason=confusion_reason(
                                cells[source], cells[first_idx], cells[second_idx],
                                pci_value, len(group), MAX_CONFUSION_GROUP
                            ),
                            third_idx=second_idx,
                        )
                        row["aToCDistanceM"] = meters(distance_km(cells, source, second_idx))
                        row["bToCDistanceM"] = meters(distance_km(cells, first_idx, second_idx))
                        rows.append(row)

    def _check_mod_neighbor(
        self,
        cells: List[Dict],
        flags: np.ndarray,
        adjacency: Dict[int, List[int]],
        rows: List[Dict],
        modulus: int,
        skip_pairs: set,
    ) -> None:
        """模值关联邻区：核查小区与同频邻区模值相同（几何口径没覆盖到的部分）"""
        check_type = CheckType.MOD3_NEIGHBOR if modulus == 3 else CheckType.MOD30_NEIGHBOR
        seen_pairs: set = set()
        for source, targets in adjacency.items():
            if not flags[source]:
                continue
            for target in targets:
                pair = frozenset((cells[source]["key"], cells[target]["key"]))
                if pair in skip_pairs or pair in seen_pairs:
                    continue
                if cells[source]["pci"] % modulus != cells[target]["pci"] % modulus:
                    continue
                seen_pairs.add(pair)
                dist = distance_km(cells, source, target)
                rows.append(build_pair_row(
                    check_type, cells, source, target, dist, modulus=modulus,
                    reason=mod_reason(
                        cells[source], cells[target], cells[source]["pci"] % modulus, modulus, "同频邻区"
                    ) + "（基于预规划邻区对，非现网邻区数据）",
                ))
