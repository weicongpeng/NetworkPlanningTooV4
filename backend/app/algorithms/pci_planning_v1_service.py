"""
PCI规划服务 V1 - 基于NetworkPlanningTool_V1.py的LTENRPCIPlanner类
实现优先级排序的PCI分配算法：
1. 最小复用距离（最高优先级）
2. 同站点模3/模30冲突避免
3. PCI分布均衡性
"""

import math
import uuid
from datetime import datetime
from typing import List, Dict, Optional, Tuple, Callable, Any, Set
from dataclasses import dataclass, field
from enum import Enum
import numpy as np
import pandas as pd
import asyncio
import logging

from app.algorithms.distance_calculator import DistanceCalculator

logger = logging.getLogger(__name__)


@dataclass
class PlanningConfig:
    """规划配置"""
    network_type: str  # "LTE" 或 "NR"
    reuse_distance_km: float = 3.0  # 最小PCI复用距离（公里）
    inherit_mod: bool = False  # 是否继承原PCI的模值
    pci_range: Optional[Tuple[int, int]] = None  # 自定义PCI范围
    
    # 常量
    LTE_MIN_PCI = 0
    LTE_MAX_PCI = 503
    NR_MIN_PCI = 0
    NR_MAX_PCI = 1007


@dataclass
class SectorPlanningResult:
    """小区规划结果"""
    sector_id: str
    sector_name: str
    site_id: str
    original_pci: Optional[int]
    new_pci: int
    original_mod: Optional[int]
    new_mod: int
    earfcn: Optional[float]
    frequency: Optional[float]
    ssb_frequency: Optional[float]
    longitude: float
    latitude: float
    assignment_reason: str
    min_reuse_distance: float
    min_distance_sector_name: str = ""
    first_group: Optional[str] = None
    network_type: Optional[str] = None
    tac: Optional[str] = None  # TAC规划值


@dataclass
class SitePlanningResult:
    """站点规划结果"""
    site_id: str
    site_name: str
    managed_element_id: Optional[str] = None
    sectors: List[SectorPlanningResult] = field(default_factory=list)


@dataclass
class PCIPlanningResult:
    """PCI规划结果"""
    task_id: str
    status: str
    total_sites: int
    total_sectors: int
    total_collisions: int
    total_confusions: int
    sites: List[SitePlanningResult] = field(default_factory=list)
    progress: float = 0.0


class LTENRPCIPlanner:
    """
    LTE/NR分离式PCI规划工具 - 基于V1代码
    
    核心算法：
    1. 最小复用距离约束 - 确保同频同PCI小区间距离≥阈值
    2. 同站点模值冲突避免 - 避免同基站小区模值相同
    3. PCI分布均衡性 - 优选复用距离接近阈值的PCI
    """
    
    def __init__(self, config: PlanningConfig):
        self.config = config
        self.reuse_distance_km = config.reuse_distance_km
        self.network_type = config.network_type
        self.inherit_mod = config.inherit_mod
        
        # 设置模值和PCI范围
        if self.network_type == "LTE":
            self.mod_value = 3
            self.dual_mod_requirement = False
            default_pci_range = list(range(0, 504))
        else:  # NR
            self.mod_value = 30
            self.dual_mod_requirement = True
            default_pci_range = list(range(0, 1008))
        
        # 使用自定义PCI范围或默认范围
        if config.pci_range:
            self.pci_range = list(range(config.pci_range[0], config.pci_range[1] + 1))
        else:
            self.pci_range = default_pci_range
        
        # 数据存储
        self.cells_to_plan_df = pd.DataFrame()  # 待规划小区DataFrame
        self.all_cells_df = pd.DataFrame()  # 全量小区DataFrame
        
        # 性能优化：按频点预分组
        self.all_cells_by_freq = {}
        
        logger.info(f"初始化{self.network_type}网络PCI规划工具")
        logger.info(f"同频PCI最小复用距离: {self.reuse_distance_km}km")
        logger.info(f"PCI范围: {min(self.pci_range)}-{max(self.pci_range)}")

    @staticmethod
    def normalize_id(val: Any) -> str:
        """归一化ID字段，处理 123, 123.0, '123' 为一致字符串"""
        if pd.isna(val):
            return ""
        try:
            # 尝试转为 float 后转为 int 再转为字符串，舍弃 .0
            return str(int(float(val)))
        except (ValueError, TypeError):
            return str(val).strip()
    
    def load_data_from_sites(self, cells_to_plan: List[Dict], all_cells: List[Dict]):
        """
        从站点数据加载小区信息到DataFrame
        """
        # 转换待规划小区为DataFrame
        plan_rows = []
        for site in cells_to_plan:
            site_id = site.get("id", "")
            for sector in site.get("sectors", []):
                plan_rows.append({
                    "enodeb_id": int(site_id) if site_id.isdigit() else site_id,
                    "cell_id": sector.get("id", ""),
                    "cell_name": sector.get("name", ""),
                    "pci": sector.get("pci"),
                    "lat": sector.get("latitude") or site.get("latitude", 0.0),
                    "lon": sector.get("longitude") or site.get("longitude", 0.0),
                    "earfcn_dl": sector.get("earfcn") or sector.get("frequency") or sector.get("ssb_frequency"),
                    "managed_element_id": site.get("managedElementId"),
                    "first_group": sector.get("firstGroup") or sector.get("first_group"),
                })
        
        self.cells_to_plan_df = pd.DataFrame(plan_rows)
        
        # 转换全量小区为DataFrame
        all_rows = []
        for site in all_cells:
            site_id = site.get("id", "")
            for sector in site.get("sectors", []):
                all_rows.append({
                    "enodeb_id": int(site_id) if site_id.isdigit() else site_id,
                    "cell_id": sector.get("id", ""),
                    "cell_name": sector.get("name", ""),
                    "pci": sector.get("pci"),
                    "lat": sector.get("latitude") or site.get("latitude", 0.0),
                    "lon": sector.get("longitude") or site.get("longitude", 0.0),
                    "earfcn_dl": sector.get("earfcn") or sector.get("frequency") or sector.get("ssb_frequency"),
                })
        
        self.all_cells_df = pd.DataFrame(all_rows)
        
        # 转换数值列
        numeric_cols = ['pci', 'lat', 'lon', 'earfcn_dl']
        for col in numeric_cols:
            if col in self.cells_to_plan_df.columns:
                self.cells_to_plan_df[col] = pd.to_numeric(self.cells_to_plan_df[col], errors='coerce')
            if col in self.all_cells_df.columns:
                self.all_cells_df[col] = pd.to_numeric(self.all_cells_df[col], errors='coerce')

        # 预先按频点对全量小区进行分组优化
        valid_all = self.all_cells_df.dropna(subset=['earfcn_dl', 'lat', 'lon']).copy()
        for freq, df in valid_all.groupby('earfcn_dl'):
            self.all_cells_by_freq[freq] = df

    def calculate_distance_vectorized(self, lat1: float, lon1: float, 
                                      lat2_array: np.ndarray, lon2_array: np.ndarray) -> np.ndarray:
        """向量化距离计算"""
        lat1_rad = np.radians(lat1)
        lon1_rad = np.radians(lon1)
        lat2_rad = np.radians(lat2_array)
        lon2_rad = np.radians(lon2_array)
        
        dlat = lat2_rad - lat1_rad
        dlon = lon2_rad - lon1_rad
        a = np.sin(dlat/2)**2 + np.cos(lat1_rad) * np.cos(lat2_rad) * np.sin(dlon/2)**2
        c = 2 * np.arcsin(np.sqrt(a))
        
        return c * 6371
    
    def get_same_site_cells(self, target_lat: float, target_lon: float, 
                           exclude_enodeb_id=None, exclude_cell_id=None) -> List[Dict]:
        """
        获取同站点的其他小区
        
        新规则（按用户要求调整）：
        1. 优先使用站点ID+小区经纬度匹配：站点ID相同 AND (经纬度相同 OR 经纬度差<10米)
        2. 如果站点ID不匹配，则使用坐标匹配：经纬度相同 OR 经纬度差<10米
        """
        if self.all_cells_df is None or self.all_cells_df.empty:
            return []
        
        same_site_cells = pd.DataFrame()
        
        if exclude_enodeb_id is not None:
            # 优先使用站点ID+经纬度匹配
            exclude_id_str = self.normalize_id(exclude_enodeb_id)
            tolerance = 0.0001  # 约10米
            
            # 站点ID相同 AND (经纬度相同 OR 经纬度差<10米)
            site_and_location_filter = (
                (self.all_cells_df['enodeb_id'].apply(self.normalize_id) == exclude_id_str) &
                (
                    ((self.all_cells_df['lat'] == target_lat) & (self.all_cells_df['lon'] == target_lon)) |
                    (
                        (abs(self.all_cells_df['lat'] - target_lat) < tolerance) &
                        (abs(self.all_cells_df['lon'] - target_lon) < tolerance)
                    )
                )
            )
            same_site_cells = self.all_cells_df[site_and_location_filter].copy()
        
        # 如果按站点ID+经纬度没搜到，则退化到纯坐标匹配
        if same_site_cells.empty:
            tolerance = 0.0001  # 约10米
            location_filter = (
                ((self.all_cells_df['lat'] == target_lat) & (self.all_cells_df['lon'] == target_lon)) |
                (
                    (abs(self.all_cells_df['lat'] - target_lat) < tolerance) &
                    (abs(self.all_cells_df['lon'] - target_lon) < tolerance)
                )
            )
            same_site_cells = self.all_cells_df[location_filter].copy()
        
        # 排除当前处理的小区自身
        if exclude_enodeb_id is not None and exclude_cell_id is not None:
            ex_id = self.normalize_id(exclude_enodeb_id)
            ex_cell = self.normalize_id(exclude_cell_id)
            same_site_cells = same_site_cells[
                ~((same_site_cells['enodeb_id'].apply(self.normalize_id) == ex_id) &
                  (same_site_cells['cell_id'].apply(self.normalize_id) == ex_cell))
            ]
        
        return same_site_cells.to_dict('records')

    def find_pci_conflicts(self, target_lat: float, target_lon: float, target_earfcn: float, 
                             exclude_enodeb=None, exclude_cell=None, search_radius=20.0) -> Dict[int, Tuple[float, str]]:
        """
        查找在指定范围内的所有同频小区冲突
        Returns: {pci: (min_distance, sector_name)}
        """
        freq_cells = self.all_cells_by_freq.get(target_earfcn)
        if freq_cells is None or freq_cells.empty:
            return {}

        # 粗略经纬度过滤（1度约111km，20km约0.2度）
        deg_pad = search_radius / 110.0
        nearby_cells = freq_cells[
            (abs(freq_cells['lat'] - target_lat) < deg_pad) &
            (abs(freq_cells['lon'] - target_lon) < deg_pad)
        ].copy()

        if nearby_cells.empty:
            return {}

        # 排除自身
        if exclude_enodeb is not None:
            ex_id = self.normalize_id(exclude_enodeb)
            ex_cell = self.normalize_id(exclude_cell)
            nearby_cells = nearby_cells[
                ~((nearby_cells['enodeb_id'].apply(self.normalize_id) == ex_id) &
                  (nearby_cells['cell_id'].apply(self.normalize_id) == ex_cell))
            ]

        if nearby_cells.empty:
            return {}

        # 精确距离计算
        distances = self.calculate_distance_vectorized(
            target_lat, target_lon,
            nearby_cells['lat'].values,
            nearby_cells['lon'].values
        )
        nearby_cells['dist'] = distances
        
        # 只保留搜索半径内的小区（加速后续找最优PCI）
        nearby_cells = nearby_cells[nearby_cells['dist'] < search_radius]
        
        # 按PCI分组获取最小距离和对应小区
        conflicts = {}
        for pci, group in nearby_cells.groupby('pci'):
            min_row = group.loc[group['dist'].idxmin()]
            conflicts[int(pci)] = (min_row['dist'], min_row['cell_name'])
            
        return conflicts

    def get_reuse_compliant_pcis(self, target_lat: float, target_lon: float, target_earfcn: float,
                                exclude_enodeb=None, exclude_cell=None,
                                target_mod: Optional[int] = None,
                                strict_site_mod: bool = True) -> List[Tuple[int, float, bool, float, str]]:
        """
        获取满足要求的PCI列表
        Returns: (pci, min_distance, has_mod_conflict, balance_score, min_distance_cell_name)
        """
        # 获取所有可能的PCI冲突（20km半径）
        pci_conflicts = self.find_pci_conflicts(target_lat, target_lon, target_earfcn, exclude_enodeb, exclude_cell)
        
        # 获取同站点模值和已使用的PCI（硬约束：同站点同频小区不能使用相同PCI）
        same_site_mods = set()
        same_site_mod3s = set()
        same_site_used_pcis = set()  # 新增：记录同站点同频小区已使用的PCI
        same_site_cells = self.get_same_site_cells(target_lat, target_lon, exclude_enodeb, exclude_cell)
        for cell in same_site_cells:
            # 只有同频点的小区才参与模值冲突检查 (按用户最新要求)
            cell_earfcn = cell.get('earfcn_dl')
            if cell_earfcn is not None and float(cell_earfcn) == float(target_earfcn):
                pci_val = cell.get('pci')
                if pd.notna(pci_val) and pci_val != -1:
                    pci_int = int(pci_val) # type: ignore
                    same_site_mods.add(pci_int % self.mod_value)
                    same_site_mod3s.add(pci_int % 3)
                    same_site_used_pcis.add(pci_int)  # 新增：记录已使用的PCI

        compliant_pcis = []
        
        # 确定候选动态范围
        if self.inherit_mod and target_mod is not None:
            candidates = [pci for pci in self.pci_range if pci % self.mod_value == target_mod]
        else:
            candidates = self.pci_range

        for pci in candidates:
            # 【硬约束】首先检查同站点同频小区是否已使用相同PCI
            # 这是最高优先级的检查，无论频点如何，同站点小区必须使用不同的PCI
            if pci in same_site_used_pcis:
                continue

            # 检查同站点模值（模30/模3）- 严格执行
            mod = pci % self.mod_value
            mod3 = pci % 3

            if strict_site_mod:
                if mod in same_site_mods:
                    continue
                if self.network_type == "NR" and self.dual_mod_requirement and mod3 in same_site_mod3s:
                    continue
            
            # 检查复用距离
            conflict = pci_conflicts.get(pci)
            if conflict:
                dist, name = conflict
                if dist < self.reuse_distance_km:
                    continue
            else:
                dist, name = float('inf'), ""

            # 均衡性得分
            balance_score = abs(dist - self.reuse_distance_km) if dist != float('inf') else 100.0
            
            compliant_pcis.append((pci, dist, False, balance_score, name))

        if not compliant_pcis:
            return []

        # 排序策略
        def sort_key(x):
            pci, dist, _, balance, _ = x
            return (
                # 满足距离
                0 if dist >= self.reuse_distance_km else 1,
                # 均衡性
                balance,
                # 距离越大越好
                -dist if dist != float('inf') else -100,
                # PCI小号优先
                pci
            )

        compliant_pcis.sort(key=sort_key)
        return compliant_pcis


    def calculate_preferred_mod3_for_cell(self, cell_id: str, same_site_cells: List[Dict]) -> Optional[int]:
        """
        计算同站小区的推荐mod3值（用于小区数>3的场景）
        
        规则：按每3个连续小区ID错开mod3分配
        - 小区1：mod3 = 0
        - 小区2：mod3 = 1
        - 小区3：mod3 = 2
        - 小区4：mod3 = 0
        - 小区5：mod3 = 1
        - ...
        
        参数:
            cell_id: 当前小区ID
            same_site_cells: 同站小区列表
        
        返回:
            推荐的mod3值，如果无法确定则返回None
        """
        if not same_site_cells:
            return None
        
        # 获取所有同站小区（包括当前小区），按小区ID排序
        all_site_cells = same_site_cells.copy()
        
        # 添加当前小区（临时）
        all_site_cells.append({
            'cell_id': cell_id,
            'pci': None
        })
        
        # 按小区ID排序（转换为数字或字符串）
        try:
            sorted_cells = sorted(all_site_cells, key=lambda x: int(str(self.normalize_id(x['cell_id']))))
        except (ValueError, TypeError):
            # 如果无法转换为数字，使用字符串排序
            sorted_cells = sorted(all_site_cells, key=lambda x: str(x['cell_id']))
        
        # 找到当前小区在排序后的位置
        current_index = -1
        for i, cell in enumerate(sorted_cells):
            if str(self.normalize_id(cell['cell_id'])) == str(self.normalize_id(cell_id)):
                current_index = i
                break
        
        if current_index == -1:
            return None
        
        # 计算推荐的mod3值：每3个连续小区错开
        preferred_mod3 = current_index % 3
        
        return preferred_mod3


    def assign_pci(self, row: pd.Series) -> Tuple[int, str, float, str]:
        """
        为单个小区分配PCI
        """
        enodeb_id = row['enodeb_id']
        cell_id = row['cell_id']
        lat, lon = row['lat'], row['lon']
        earfcn = row.get('earfcn_dl', 0)
        original_pci = row.get('pci')

        if pd.isna(lat) or pd.isna(lon):
            # 基站ID和PCI计算保底
            base = (int(enodeb_id) if str(enodeb_id).isdigit() else 0) + int(cell_id)
            pci = self.pci_range[base % len(self.pci_range)]
            return pci, 'no_location_fallback', 0.0, ""

        target_mod = int(original_pci) % self.mod_value if self.inherit_mod and pd.notna(original_pci) else None
        orig_threshold = self.reuse_distance_km
        
        # 生成动态降级步长
        _fallback_steps = set()
        for ratio in [0.8, 0.6, 0.4, 0.2]:
            d = round(orig_threshold * ratio, 1)
            if 0 < d < orig_threshold:
                _fallback_steps.add(d)
        for _fs in (1.5, 0.5, 0.1, 0.0):
            _fallback_steps.add(_fs)
        fallback_steps = sorted(_fallback_steps, reverse=True)


        # 获取所有PCI冲突信息（用于后续阶段）
        pci_conflicts = self.find_pci_conflicts(lat, lon, earfcn, enodeb_id, cell_id)
        
        # 获取同站小区
        same_site_cells = self.get_same_site_cells(lat, lon, enodeb_id, cell_id)
        same_freq_site_cells = [c for c in same_site_cells if c.get('earfcn_dl') is not None and float(c['earfcn_dl']) == float(earfcn)]
        
        # 计算同站同频小区的模值约束和已使用的PCI（硬约束）
        same_site_mods = set()
        same_site_mod3s = set()
        same_site_used_pcis = set()  # 新增：记录同站同频小区已使用的PCI
        for cell in same_freq_site_cells:
            pci_val = cell.get('pci')
            if pd.notna(pci_val) and pci_val != -1:
                pci_int = int(pci_val)
                same_site_mods.add(pci_int % self.mod_value)
                same_site_mod3s.add(pci_int % 3)
                same_site_used_pcis.add(pci_int)  # 新增：记录已使用的PCI
        
        # 如果同站同频小区数>=3，计算推荐的mod3值
        preferred_mod3 = None
        if len(same_freq_site_cells) >= 3:
            preferred_mod3 = self.calculate_preferred_mod3_for_cell(cell_id, same_freq_site_cells)
            print(f"[DEBUG] 同站{enodeb_id}有{len(same_freq_site_cells)}个同频小区，推荐mod3={preferred_mod3}")
        
        # 优先使用推荐mod3（如果存在）
        if preferred_mod3 is not None:
            target_mod = preferred_mod3
            print(f"[DEBUG] 使用推荐mod3={target_mod}替代继承模值")
        
        # 第一阶段：尝试同时满足模值约束和复用距离约束
        if target_mod is not None:
            compliant = self.get_reuse_compliant_pcis(lat, lon, earfcn, enodeb_id, cell_id, target_mod, strict_site_mod=True)
            if compliant:
                pci, dist, _, _, name = compliant[0]
                mod_source = "preferred" if preferred_mod3 is not None else "inherit"
                return pci, f'reuse_compliant_{orig_threshold}km_{mod_source}_mod', dist, name
        
        # 第二阶段：如果无法满足模值约束，使用推荐mod3并放宽复用距离要求
        if preferred_mod3 is not None:
            for step in fallback_steps:
                if step >= orig_threshold:
                    continue
                self.reuse_distance_km = step
                compliant = self.get_reuse_compliant_pcis(lat, lon, earfcn, enodeb_id, cell_id, preferred_mod3, strict_site_mod=True)
                self.reuse_distance_km = orig_threshold  # 恢复
                if compliant:
                    pci, dist, _, _, name = compliant[0]
                    reason = f'fallback_{step}km_preferred_mod3' if step > 0 else 'min_dist_preferred_mod3'
                    return pci, reason, dist, name
        
        # 第三阶段：不使用特定模值，但保持复用距离约束
        compliant = self.get_reuse_compliant_pcis(lat, lon, earfcn, enodeb_id, cell_id, None, strict_site_mod=True)
        if compliant:
            pci, dist, _, _, name = compliant[0]
            return pci, f'reuse_compliant_{orig_threshold}km_strict_site_mod', dist, name
        
        # 第四阶段：不使用特定模值，逐步降低复用距离要求
        for step in fallback_steps:
            if step >= orig_threshold:
                continue
            self.reuse_distance_km = step
            compliant = self.get_reuse_compliant_pcis(lat, lon, earfcn, enodeb_id, cell_id, None, strict_site_mod=True)
            self.reuse_distance_km = orig_threshold  # 恢复
            if compliant:
                pci, dist, _, _, name = compliant[0]
                reason = f'fallback_{step}km_strict_site_mod' if step > 0 else 'min_dist_strict_site_mod'
                return pci, reason, dist, name
        
        # 第五阶段：遍历所有PCI，选择满足同站约束的最佳PCI
        candidates = []
        for pci in self.pci_range:
            # 【硬约束】首先检查同站同频小区是否已使用相同PCI
            if pci in same_site_used_pcis:
                continue

            # 严格检查同站同频模约束（即使在其他约束失败时也必须遵守）
            mod = pci % self.mod_value
            mod3 = pci % 3
            if mod in same_site_mods:
                continue
            if self.network_type == "NR" and self.dual_mod_requirement and mod3 in same_site_mod3s:
                continue

            dist, name = pci_conflicts.get(pci, (999.0, ""))
            candidates.append((pci, dist, name))
        
        # 如果有满足同站模约束的PCI
        if candidates:
            candidates.sort(key=lambda x: (-x[1] if x[1] != 999.0 else 1000))
            best_pci, max_dist, best_name = candidates[0]
            constraint_status = "mod_violated" if len(same_site_mods) >= self.mod_value else "strict_site_mod"
            return best_pci, f'emergency_pci_{max_dist:.2f}km_{constraint_status}', max_dist, best_name
        
        # 第六阶段：如果同站同频小区数量 >= mod_value，必须放宽同站模约束
        # 但仍然保持【硬约束：同站同频小区不能使用相同PCI】
        # 优先使用推荐mod3（如果存在）
        if preferred_mod3 is not None:
            for pci in self.pci_range:
                # 【硬约束】跳过同站同频小区已使用的PCI
                if pci in same_site_used_pcis:
                    continue
                if pci % 3 == preferred_mod3:
                    dist, name = pci_conflicts.get(pci, (999.0, ""))
                    candidates.append((pci, dist, name))
            if candidates:
                candidates.sort(key=lambda x: (-x[1] if x[1] != 999.0 else 1000))
                best_pci, max_dist, best_name = candidates[0]
                constraint_status = "preferred_mod3_mod_violated"
                return best_pci, f'emergency_pci_{max_dist:.2f}km_{constraint_status}', max_dist, best_name
        
        # 最后的保底方案：选择距离最大的PCI（但仍然保持【硬约束：同站同频小区不能使用相同PCI】）
        candidates = []
        for pci in self.pci_range:
            # 【硬约束】跳过同站同频小区已使用的PCI
            if pci in same_site_used_pcis:
                continue
            dist, name = pci_conflicts.get(pci, (999.0, ""))
            candidates.append((pci, dist, name))

        if candidates:
            candidates.sort(key=lambda x: (-x[1] if x[1] != 999.0 else 1000))
            best_pci, max_dist, best_name = candidates[0]
            constraint_status = "all_constraints_violated"
            return best_pci, f'emergency_pci_{max_dist:.2f}km_{constraint_status}', max_dist, best_name
        
        # 极端情况：所有PCI都被同频同PCI小区占用，或剩余PCI都是同站同频小区已使用的
        # 必须选择一个未使用的PCI（硬约束：同站同频小区不能使用相同PCI）
        for fallback_pci in self.pci_range:
            if fallback_pci not in same_site_used_pcis:
                print(f"[WARNING] 同站({enodeb_id})无理想PCI，使用保底PCI {fallback_pci}（避开同站同频已用PCI）")
                return fallback_pci, f'emergency_pci_fallback_{fallback_pci}_999.00km', 999.0, ""

        # 绝对极端：所有PCI都被同站同频小区占用（理论上不应该发生，除非PCI范围太小）
        print(f"[ERROR] 同站({enodeb_id})所有PCI都被同站同频小区占用，使用第一个PCI（违反约束！）")
        return self.pci_range[0], 'emergency_pci_constraint_violation_999.00km', 999.0, ""

    async def plan(self, cells_to_plan: List[Dict], all_cells: List[Dict],
                  progress_callback: Optional[Callable[[float], Any]] = None) -> PCIPlanningResult:
        """执行PCI规划"""
        task_id = str(uuid.uuid4())
        self.load_data_from_sites(cells_to_plan, all_cells)
        
        if self.cells_to_plan_df.empty:
            return PCIPlanningResult(task_id, "failed", 0, 0, 0, 0)
        
        total = len(self.cells_to_plan_df)
        results_by_site = {}
        
        for idx, row in self.cells_to_plan_df.iterrows():
            new_pci, reason, min_dist, dist_name = self.assign_pci(row)
            
            # 更新内部全量表以供下一个小区参考
            mask = ((self.all_cells_df['enodeb_id'].astype(str) == str(row['enodeb_id'])) & 
                   (self.all_cells_df['cell_id'].astype(str) == str(row['cell_id'])))
            self.all_cells_df.loc[mask, 'pci'] = new_pci
            # 同时更新分组索引
            freq = row['earfcn_dl']
            if freq in self.all_cells_by_freq:
                g_mask = ((self.all_cells_by_freq[freq]['enodeb_id'].astype(str) == str(row['enodeb_id'])) & 
                          (self.all_cells_by_freq[freq]['cell_id'].astype(str) == str(row['cell_id'])))
                self.all_cells_by_freq[freq].loc[g_mask, 'pci'] = new_pci

            site_id = str(row['enodeb_id'])
            if site_id not in results_by_site:
                results_by_site[site_id] = {
                    "siteId": site_id, 
                    "managedElementId": row.get('managed_element_id'),
                    "sectors": []
                }
            
            orig_pci = row.get('pci')
            results_by_site[site_id]["sectors"].append({
                "sectorId": str(row['cell_id']),
                "sectorName": str(row.get('cell_name', '')),
                "originalPCI": int(orig_pci) if pd.notna(orig_pci) else None,
                "newPCI": int(new_pci),
                "originalMod": int(orig_pci) % self.mod_value if pd.notna(orig_pci) else None,
                "newMod": int(new_pci) % self.mod_value,
                "earfcn": row.get('earfcn_dl'),
                "longitude": row.get('lon', 0.0),
                "latitude": row.get('lat', 0.0),
                "assignmentReason": reason,
                "minReuseDistance": min_dist,
                "minDistanceSectorName": dist_name,
                "networkType": self.network_type,
                "firstGroup": row.get('first_group')
            })
            
            if progress_callback and idx % 10 == 0:
                if asyncio.iscoroutinefunction(progress_callback):
                    await progress_callback((idx + 1) / total * 100)
                else:
                    progress_callback((idx + 1) / total * 100)
        
        if progress_callback:
            if asyncio.iscoroutinefunction(progress_callback):
                await progress_callback(100.0)
            else:
                progress_callback(100.0)

        # 重新计算准确的最小复用距离（基于所有已规划小区）
        print(f"[PCI规划] 开始重新计算准确的最小复用距离")
        planned_cells = []
        for site_id, site_data in results_by_site.items():
            for sector in site_data["sectors"]:
                planned_cells.append({
                    "site_id": site_id,
                    "sector_id": sector["sectorId"],
                    "sector_name": sector["sectorName"],
                    "new_pci": sector["newPCI"],
                    "earfcn": sector["earfcn"],
                    "longitude": sector["longitude"],
                    "latitude": sector["latitude"],
                    "sector_ref": sector,  # 引用原sector对象，用于后续更新
                })

        # 计算每个小区的真实最小复用距离
        for i, cell in enumerate(planned_cells):
            min_distance = float("inf")
            min_distance_sector_name = None

            # 查找其他规划小区中同频同PCI的小区
            for j, other_cell in enumerate(planned_cells):
                if i == j:
                    continue

                # 检查是否同PCI
                if cell["new_pci"] != other_cell["new_pci"]:
                    continue

                # 检查是否同频
                cell_earfcn = cell["earfcn"]
                other_earfcn = other_cell["earfcn"]

                # 使用频点判断逻辑：两者都有值且差值<=0.1视为同频
                is_same_freq = False
                if cell_earfcn is not None and other_earfcn is not None:
                    try:
                        if abs(float(cell_earfcn) - float(other_earfcn)) <= 0.1:
                            is_same_freq = True
                    except (ValueError, TypeError):
                        pass

                if not is_same_freq:
                    continue

                # 计算距离
                dist = DistanceCalculator.calculate_distance(
                    cell["longitude"], cell["latitude"],
                    other_cell["longitude"], other_cell["latitude"]
                )

                if dist < min_distance:
                    min_distance = dist
                    min_distance_sector_name = other_cell["sector_name"]

            # 更新sector的minReuseDistance和minDistanceSectorName
            if min_distance != float("inf"):
                cell["sector_ref"]["minReuseDistance"] = min_distance
                cell["sector_ref"]["minDistanceSectorName"] = min_distance_sector_name

                # 更新assignment_reason，标注这是最终核查的真实距离
                original_reason = cell["sector_ref"].get("assignmentReason", "")
                if "最终核查" not in original_reason:
                    is_satisfied = min_distance >= self.reuse_distance_km
                    status_icon = "✅" if is_satisfied else "❌"
                    cell["sector_ref"]["assignmentReason"] = f"{original_reason} | {status_icon} 最终核查真实距离={min_distance:.2f}km"

        print(f"[PCI规划] 准确复用距离计算完成")

        # 映射回对象结构
        sites = []
        for site_id, data in results_by_site.items():
            sectors = [SectorPlanningResult(
                sector_id=s["sectorId"], sector_name=s["sectorName"], site_id=site_id,
                original_pci=s["originalPCI"], new_pci=s["newPCI"],
                original_mod=s["originalMod"], new_mod=s["newMod"],
                earfcn=s["earfcn"], frequency=None, ssb_frequency=None,
                longitude=s["longitude"], latitude=s["latitude"],
                assignment_reason=s["assignmentReason"], min_reuse_distance=s["minReuseDistance"],
                min_distance_sector_name=s["minDistanceSectorName"],
                first_group=s.get("firstGroup"),
                network_type=s.get("networkType")
            ) for s in data["sectors"]]
            sites.append(SitePlanningResult(site_id, f"Site_{site_id}", managed_element_id=data.get("managedElementId"), sectors=sectors))
            
        return PCIPlanningResult(task_id, "completed", len(sites), total, 0, 0, sites, 100.0)


async def run_pci_planning(
    config: PlanningConfig,
    cells_to_plan: List[Dict],
    progress_callback: Optional[Callable[[float], Any]] = None,
    all_cells: Optional[List[Dict]] = None,
    enable_tac_planning: bool = False,
    data_dir: Optional[str] = None
) -> Dict[str, Any]:
    """运行PCI规划入口"""
    planner = LTENRPCIPlanner(config)
    result = await planner.plan(cells_to_plan, all_cells or cells_to_plan, progress_callback)
    
    # 如果启用了TAC规划，执行TAC规划
    if enable_tac_planning and data_dir:
        try:
            logger.info(f"[PCI规划] 开始执行TAC规划...")
            from app.services.tac_planning_service import TACPlanningService
            from pathlib import Path
            
            tac_service = TACPlanningService(Path(data_dir))
            
            # 构建待规划小区列表
            cells_to_plan_for_tac = []
            for site in result.sites:
                site_data = {
                    "siteId": site.site_id,
                    "siteName": site.site_name,
                    "sectors": []
                }
                for sector in site.sectors:
                    sector_data = {
                        "sectorId": sector.sector_id,
                        "sectorName": sector.sector_name,
                        "longitude": sector.longitude,
                        "latitude": sector.latitude,
                    }
                    site_data["sectors"].append(sector_data)
                if site_data["sectors"]:
                    cells_to_plan_for_tac.append(site_data)
            
            # 执行TAC规划
            tac_results, planned_count, unplanned_count = tac_service.plan_tac_for_list(
                network_type=config.network_type,
                cells_to_plan=cells_to_plan_for_tac,
                progress_callback=None
            )
            
            # 将TAC规划结果合并到PCI规划结果中
            tac_result_map = {}
            for tac_result in tac_results:
                key = f"{tac_result.get('siteId', '')}_{tac_result.get('sectorId', '')}"
                tac_result_map[key] = tac_result.get("tac")
            
            # 更新PCI规划结果中的TAC值
            for site in result.sites:
                for sector in site.sectors:
                    keys_to_try = [
                        f"{site.site_id}_{sector.sector_id}",
                        sector.sector_id,
                    ]
                    for key in keys_to_try:
                        if key in tac_result_map:
                            sector.tac = tac_result_map[key]
                            break
            
            logger.info(f"[PCI规划] TAC规划完成: 已规划{planned_count}个小区, 未规划{unplanned_count}个小区")
        except Exception as e:
            logger.error(f"[PCI规划] TAC规划执行失败: {e}")
            import traceback
            traceback.print_exc()
    
    return {
        "taskId": result.task_id,
        "status": result.status,
        "totalSites": result.total_sites,
        "totalSectors": result.total_sectors,
        "collisions": result.total_collisions,
        "confusions": result.total_confusions,
        "networkType": config.network_type,
        "distanceThreshold": config.reuse_distance_km,
        "results": [
            {
                "siteId": site.site_id,
                "siteName": site.site_name,
                "sectors": [
                    {
                        "sectorId": s.sector_id, "sectorName": s.sector_name,
                        "originalPCI": s.original_pci, "newPCI": s.new_pci,
                        "originalMod": s.original_mod, "newMod": s.new_mod,
                        "earfcn": s.earfcn, "longitude": s.longitude, "latitude": s.latitude,
                        "assignmentReason": s.assignment_reason, "minReuseDistance": s.min_reuse_distance,
                        "minDistanceSectorName": s.min_distance_sector_name,
                        "networkType": getattr(s, "network_type", None) or s.__dict__.get("network_type") or config.network_type,
                        "firstGroup": getattr(s, "first_group", None) or s.__dict__.get("first_group"),
                        "tac": s.tac
                    }
                    for s in site.sectors
                ],
                "managedElementId": site.managed_element_id
            }
            for site in result.sites
        ]
    }
