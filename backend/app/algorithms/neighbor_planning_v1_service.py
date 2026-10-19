"""
邻区规划服务 V1 - 基于NetworkPlanningTool_V1.py的覆盖圆算法
实现智能邻区选择：
1. 覆盖圆相交判断 - 判断两小区覆盖范围是否重叠
2. 智能评分选择 - 基于距离和方位角评分
3. 扇区分布均衡 - 确保邻区来自不同方向
"""

import math
import uuid
from functools import lru_cache
from datetime import datetime
from typing import List, Dict, Optional, Tuple, Callable, Any, Set
from dataclasses import dataclass, field
from enum import Enum
import numpy as np
import pandas as pd
import logging

logger = logging.getLogger(__name__)


class RelationType(str, Enum):
    """邻区关系类型"""
    LTE_LTE = "LTE-LTE"
    LTE_NR = "LTE-NR"
    NR_LTE = "NR-LTE"
    NR_NR = "NR-NR"


# 源朝向闸门（度）：目标须在源天线方位角前向 ±120° 内才算覆盖可达。
# 覆盖圆是各向同性圆、仅向天线方向偏移半径的一半，天线背后仍有约 0.28km
# 覆盖范围，单靠圆相交会把背后 1km 内的"背打"小区误判为邻区；因此叠加朝向
# 闸门——背后方向（偏角 > 120°）不靠覆盖圆/远端补足添加（300m 内强制邻区除外）。
# 与 V2 参考实现 is_in_direction 的 max(beamwidth, 120°) 阈值一致。
DIRECTION_GATE_DEG = 120.0


@dataclass
class NeighborConfig:
    """邻区规划配置"""
    source_type: str  # "LTE" 或 "NR"
    target_type: str  # "LTE" 或 "NR"
    max_neighbors: int = 64  # 最大邻区数（每频）
    coverage_distance_factor: float = 1.0  # 覆盖圆距离系数
    coverage_radius_factor: float = 1.0  # 覆盖圆半径系数
    # 以下为前端可配置的场景门限（默认值=算法内部经验值）
    dense_spacing_threshold_km: float = 1.0   # 密集/稀疏门限：平均站间距<该值为密集
    dense_multiplier: float = 1.3             # 密集场景全量添加半径倍数
    outdoor_to_indoor_max_km: float = 0.6     # 室外→室分最大距离（公里，600米）
    indoor_to_indoor_radius_km: float = 0.35  # 室分→室分距离（公里，350米）
    indoor_to_outdoor_multiplier: float = 1.5 # 室分→室外全量半径倍数
    outdoor_spacing_site_count: int = 9       # 室外源站间距取最近N个室外站


@dataclass
class NeighborRelation:
    """邻区关系"""
    source_key: str
    target_key: str
    distance: float
    angle_diff: Optional[float]
    source_cell_name: str
    target_cell_name: str
    source_enodeb_id: str
    target_enodeb_id: str
    score: float = 0.0
    source_pci: Optional[int] = None
    target_pci: Optional[int] = None
    source_earfcn: Optional[int] = None
    target_earfcn: Optional[int] = None
    relation_type: str = ""


@dataclass
class NeighborPlanningResult:
    """邻区规划结果"""
    task_id: str
    status: str
    total_sites: int
    total_sectors: int
    total_neighbors: int
    avg_neighbors: float
    results: List[Dict] = field(default_factory=list)
    progress: float = 0.0


class NeighborPlanner:
    """
    邻区规划工具 - 基于V1代码的覆盖圆算法
    
    核心算法：
    1. 覆盖圆算法 - 计算小区覆盖范围，判断是否相交
    2. 智能邻区选择 - 基于距离和方向角评分排序
    3. 分布均衡 - 确保邻区来自不同方向
    """
    
    def __init__(self, config: NeighborConfig):
        self.config = config
        self.max_neighbors = config.max_neighbors
        self.coverage_distance_factor = config.coverage_distance_factor
        self.coverage_radius_factor = config.coverage_radius_factor
        # 前端可配置场景门限
        self.dense_spacing_threshold_km = config.dense_spacing_threshold_km
        self.dense_multiplier = config.dense_multiplier
        self.outdoor_to_indoor_max_km = config.outdoor_to_indoor_max_km
        self.indoor_to_indoor_radius_km = config.indoor_to_indoor_radius_km
        self.indoor_to_outdoor_multiplier = config.indoor_to_outdoor_multiplier
        self.outdoor_spacing_site_count = config.outdoor_spacing_site_count

        # 默认覆盖距离（米）
        self.default_coverage_distance = 1000.0
        
        # 数据存储
        self.source_cells_df = None
        self.target_cells_df = None

        # 站间距缓存（同基站的小区共享计算结果）
        self._site_spacing_cache: Dict[str, float] = {}
        
        logger.info(f"初始化邻区规划工具")
        logger.info(f"源网络: {config.source_type}, 目标网络: {config.target_type}")
        logger.info(f"最大邻区数: {self.max_neighbors}")
    
    def load_data_from_sites(self, source_sites: List[Dict], target_sites: List[Dict]):
        """
        从站点数据加载小区信息到DataFrame
        """
        # 转换源小区为DataFrame
        source_rows = []
        for site in source_sites:
            site_id = site.get("id", "")
            for sector in site.get("sectors", []):
                row = {
                    "enodeb_id": site_id,
                    "cell_id": sector.get("id", ""),
                    "cell_name": sector.get("name", ""),
                    "pci": sector.get("pci"),
                    "lat": sector.get("latitude", site.get("latitude", 0.0)),
                    "lon": sector.get("longitude", site.get("longitude", 0.0)),
                    "earfcn": sector.get("earfcn") or sector.get("frequency") or sector.get("ssb_frequency"),
                    "azimuth": sector.get("azimuth"),
                    "network_type": self.config.source_type,
                    "cell_cover_type": sector.get("cell_cover_type", 1)  # 默认室外小区
                }
                source_rows.append(row)

        self.source_cells_df = pd.DataFrame(source_rows)
        logger.info(f"加载源小区: {len(self.source_cells_df)} 个")
        
        # 转换目标小区为DataFrame
        target_rows = []
        for site in target_sites:
            site_id = site.get("id", "")
            for sector in site.get("sectors", []):
                row = {
                    "enodeb_id": site_id,
                    "cell_id": sector.get("id", ""),
                    "cell_name": sector.get("name", ""),
                    "pci": sector.get("pci"),
                    "lat": sector.get("latitude", site.get("latitude", 0.0)),
                    "lon": sector.get("longitude", site.get("longitude", 0.0)),
                    "earfcn": sector.get("earfcn") or sector.get("frequency") or sector.get("ssb_frequency"),
                    "azimuth": sector.get("azimuth"),
                    "network_type": self.config.target_type,
                    "cell_cover_type": sector.get("cell_cover_type", 1)  # 默认室外小区
                }
                target_rows.append(row)

        self.target_cells_df = pd.DataFrame(target_rows)
        logger.info(f"加载目标小区: {len(self.target_cells_df)} 个")
        
        # 转换数值列
        numeric_cols = ['pci', 'lat', 'lon', 'earfcn', 'azimuth', 'cell_cover_type']
        for col in numeric_cols:
            if col in self.source_cells_df.columns:
                self.source_cells_df[col] = pd.to_numeric(self.source_cells_df[col], errors='coerce')
            if col in self.target_cells_df.columns:
                self.target_cells_df[col] = pd.to_numeric(self.target_cells_df[col], errors='coerce')

        # 预存储 NumPy 数组供向量化距离计算使用
        self._target_lats_arr = self.target_cells_df['lat'].values.astype(float)
        self._target_lons_arr = self.target_cells_df['lon'].values.astype(float)
        self._target_valid_mask = ~(np.isnan(self._target_lats_arr) | np.isnan(self._target_lons_arr))

        # 预计算目标小区覆盖圆数据（仅依赖目标小区自身数据，与源小区无关）
        target_clats = []
        target_clons = []
        target_radii = []
        for _, row in self.target_cells_df.iterrows():
            if pd.notna(row.get('azimuth')):
                clat, clon = self.calculate_coverage_circle_center(
                    row['lat'], row['lon'], row['azimuth'],
                    self.coverage_distance_factor, self.default_coverage_distance
                )
            else:
                clat, clon = row['lat'], row['lon']
            radius = self.calculate_coverage_radius(
                self.default_coverage_distance, self.coverage_radius_factor
            )
            target_clats.append(clat)
            target_clons.append(clon)
            target_radii.append(radius)

        self._target_center_lats = np.array(target_clats, dtype=float)
        self._target_center_lons = np.array(target_clons, dtype=float)
        self._target_radii = np.array(target_radii, dtype=float)
    
    @staticmethod
    @lru_cache(maxsize=500000)
    def calculate_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """计算两点之间的距离（公里）—— 结果已缓存，同一坐标对只计算一次"""
        lat1_rad = math.radians(lat1)
        lon1_rad = math.radians(lon1)
        lat2_rad = math.radians(lat2)
        lon2_rad = math.radians(lon2)

        dlat = lat2_rad - lat1_rad
        dlon = lon2_rad - lon1_rad
        a = math.sin(dlat/2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon/2)**2
        c = 2 * math.asin(math.sqrt(a))

        return c * 6371

    def _batch_distances_to_targets(self, source_lat: float, source_lon: float) -> np.ndarray:
        """NumPy 向量化：一次计算源小区到所有目标小区的距离（比逐对 Python 循环快 ~500 倍）"""
        lat1_rad = math.radians(source_lat)
        lon1_rad = math.radians(source_lon)
        slat = np.radians(self._target_lats_arr)
        slon = np.radians(self._target_lons_arr)
        dlat = slat - lat1_rad
        dlon = slon - lon1_rad
        a = np.sin(dlat * 0.5) ** 2 + math.cos(lat1_rad) * np.cos(slat) * np.sin(dlon * 0.5) ** 2
        return (2 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))) * 6371

    def calculate_azimuth_angle(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """计算从点1到点2的方位角（度）- 北为0度，顺时针"""
        lat1_rad = math.radians(lat1)
        lon1_rad = math.radians(lon1)
        lat2_rad = math.radians(lat2)
        lon2_rad = math.radians(lon2)
        
        dlon = lon2_rad - lon1_rad
        y = math.sin(dlon) * math.cos(lat2_rad)
        x = math.cos(lat1_rad) * math.sin(lat2_rad) - math.sin(lat1_rad) * math.cos(lat2_rad) * math.cos(dlon)
        bearing = math.atan2(y, x)
        bearing = math.degrees(bearing)
        bearing = (bearing + 360) % 360
        
        return bearing
    
    def calculate_angle_difference(self, azimuth1: float, azimuth2: float) -> float:
        """计算两个方向角之间的差值（0-180度）"""
        diff = abs(azimuth1 - azimuth2)
        return min(diff, 360 - diff)

    def calculate_forward_diff(self, src_lat: float, src_lon: float, src_azimuth: float,
                               tgt_lat: float, tgt_lon: float) -> float:
        """源天线方位角 与 源→目标方位角 的夹角（0-180度）。

        值越小表示目标越处在源小区天线的主覆盖方向（对打/顺向）；
        接近 180° 表示目标在源天线背后（背打）。
        """
        src_to_tgt_bearing = self.calculate_azimuth_angle(src_lat, src_lon, tgt_lat, tgt_lon)
        return self.calculate_angle_difference(src_azimuth, src_to_tgt_bearing)
    
    def calculate_coverage_circle_center(self, lat: float, lon: float, azimuth: float,
                                        distance_factor: float, coverage_distance: float) -> Tuple[float, float]:
        """
        计算覆盖圆圆心位置
        圆心位于天线方向角方向上，距离为覆盖距离的一半乘以距离系数
        """
        offset_distance = (coverage_distance / 2) * distance_factor / 1000  # 转换为公里
        
        lat_rad = math.radians(lat)
        lon_rad = math.radians(lon)
        azimuth_rad = math.radians(azimuth)
        
        # 计算偏移后的位置
        angular_distance = offset_distance / 6371
        
        center_lat = math.asin(
            math.sin(lat_rad) * math.cos(angular_distance) +
            math.cos(lat_rad) * math.sin(angular_distance) * math.cos(azimuth_rad)
        )
        
        center_lon = lon_rad + math.atan2(
            math.sin(azimuth_rad) * math.sin(angular_distance) * math.cos(lat_rad),
            math.cos(angular_distance) - math.sin(lat_rad) * math.sin(center_lat)
        )
        
        return math.degrees(center_lat), math.degrees(center_lon)
    
    def calculate_coverage_radius(self, coverage_distance: float, radius_factor: float) -> float:
        """计算覆盖圆半径（公里）"""
        return (coverage_distance * radius_factor) / 1000
    
    def are_coverage_circles_intersecting(self, center1_lat: float, center1_lon: float, radius1: float,
                                         center2_lat: float, center2_lon: float, radius2: float) -> bool:
        """判断两个覆盖圆是否相交"""
        center_distance = self.calculate_distance(center1_lat, center1_lon, center2_lat, center2_lon)
        return center_distance <= (radius1 + radius2)
    
    def calculate_neighbor_score(self, distance: float, angle_diff: Optional[float],
                                  facing_diff: Optional[float] = None,
                                  pointing_diff: Optional[float] = None,
                                  is_forward_cell: bool = False) -> float:
        """
        计算邻区评分 - 评分越高优先级越高（评分仅用于同距离下的排序 tiebreak，
        候选截断以距离优先）。
        主要考虑：
        1. 双向对打邻区（两小区天线互相朝向）优先级最高
        2. 源小区天线正打向的目标（顺向）次之
        3. 距离越近评分越高

        Args:
            distance: 距离（公里）
            angle_diff: 角度差（min(facing, pointing)，强制邻区简单评分用）
            facing_diff: 源天线方位角 与 源→目标方位角 的夹角（0=源正打目标）
            pointing_diff: 目标天线方位角 与 目标→源方位角 的夹角（0=目标正打源）
            is_forward_cell: 是否为双向对打（两小区天线互相朝向前向半球）
        """
        # 距离评分（距离越近分数越高）
        distance_score = max(0, 10 - distance)

        # 方向角评分
        if facing_diff is not None and pointing_diff is not None:
            if is_forward_cell:
                # 双向对打：两个朝向都要对上，取较差的偏角，额外加分
                angle_score = max(0, (180 - max(facing_diff, pointing_diff)) / 18) + 3
            else:
                # 非对打：主要看源天线是否打向目标（facing_diff 越小越正对），
                # 背向源（facing_diff 大）角度分趋近 0
                angle_score = max(0, (180 - facing_diff) / 18) * 0.8  # 0-8分
        elif angle_diff is not None:
            angle_score = max(0, (180 - angle_diff) / 18)  # 0-10分
        else:
            angle_score = 5  # 无方向角信息时给中等分

        return distance_score + angle_score

    @staticmethod
    def _is_same_frequency(src_earfcn, tgt_earfcn) -> bool:
        """判断源/目标小区是否同频（EARFCN/SSB 频点相同）。

        任一侧频点缺失时按异频处理（更保守，避免同频类别超限）。
        """
        if src_earfcn is None or tgt_earfcn is None:
            return False
        try:
            return int(src_earfcn) == int(tgt_earfcn)
        except (ValueError, TypeError):
            return False

    def get_cell_key(self, row: pd.Series) -> str:
        """获取小区唯一标识"""
        return f"{row['enodeb_id']}_{row['cell_id']}"
    
    def calculate_site_spacing(self, source_row: pd.Series) -> float:
        """
        计算小区平均站间距：待规划小区到周边最近 N 个室外物理站点的平均距离

        N 按源小区类型取值：
          - 室分源（cell_cover_type=4，室分→室外）：最近 8 个室外站点
          - 室外源（室外→室外、室外→室分）：最近 N 个室外站点（配置项，默认9）

        规则：
        1. 只考虑室外站点（室分目标 cell_cover_type=4 不参与计算）
        2. 相同经纬度的站点算 1 个物理站点（共址/多系统同址只计一次），
           按 (纬度, 经度) 去重，100米内（同站/共址）不计入
        3. 取最近 N 个室外物理站点的平均距离作为站间距

        Returns:
            站间距（公里），如果无法计算则返回默认值 0.5
        """
        if self.target_cells_df is None or self.target_cells_df.empty:
            return 0.5  # 默认站间距 500米

        source_lat = source_row.get('lat')
        source_lon = source_row.get('lon')
        source_enodeb_id = str(source_row.get('enodeb_id', ''))
        # 室分源取最近8个室外站，室外源取最近 N 个室外站（前端可配置）
        is_source_indoor = (source_row.get('cell_cover_type', 1) == 4)
        nearest_count = 8 if is_source_indoor else self.outdoor_spacing_site_count

        # 同基站、同类型小区共享站间距计算结果（缓存键含类型，避免室外/室分混用）
        cache_key = f"{source_enodeb_id}:{'in' if is_source_indoor else 'out'}"
        if cache_key in self._site_spacing_cache:
            return self._site_spacing_cache[cache_key]

        if pd.isna(source_lat) or pd.isna(source_lon):
            return 0.5

        # 物理站点位置 -> 最小距离（相同经纬度算1个站点）
        # round(...,6) 约 0.1m 精度，足以合并共址站点、区分真实不同站点
        site_min_distances: Dict[tuple, float] = {}

        for _, target_row in self.target_cells_df.iterrows():
            target_lat = target_row.get('lat')
            target_lon = target_row.get('lon')

            if pd.isna(target_lat) or pd.isna(target_lon):
                continue

            # 室分站点不参与站间距计算
            if target_row.get('cell_cover_type') == 4:
                continue

            # 计算距离
            distance = self.calculate_distance(source_lat, source_lon, target_lat, target_lon)

            # 100米内算同站点（含自身/共址），不计入
            if distance < 0.1:  # 0.1公里 = 100米
                continue

            # 相同经纬度算1个物理站点，保留该位置的最小距离
            pos_key = (round(float(target_lat), 6), round(float(target_lon), 6))
            if pos_key not in site_min_distances or distance < site_min_distances[pos_key]:
                site_min_distances[pos_key] = distance

        if not site_min_distances:
            return 0.5  # 默认站间距

        # 获取所有物理站点距离并排序
        unique_distances = sorted(site_min_distances.values())

        # 取最近 N 个室外物理站点的平均距离作为站间距
        nearest_n = unique_distances[:nearest_count]
        avg_spacing = sum(nearest_n) / len(nearest_n) if nearest_n else 0.5

        logger.debug(f"站间距计算: 源站点={source_enodeb_id}, 源类型={'室分' if is_source_indoor else '室外'}, "
                     f"最近{len(nearest_n)}个室外站点, 平均距离={avg_spacing:.3f}km")

        # 缓存该基站（同类型）的结果，供同站其他小区复用
        self._site_spacing_cache[cache_key] = avg_spacing
        return avg_spacing

    def plan_neighbors_for_cell(self, source_row: pd.Series) -> List[NeighborRelation]:
        """为单个源小区规划邻区 - 分层候选 + 距离优先截断

        筛选步骤：
        第一步：距离优先选择（强制邻区）
           - 室外-室外：300米内站点的所有小区作为邻区
           - 室分到室外/室外到室分：160米内

        第二步：按源/目标小区类型与站间距分场景筛选候选
           - 站间距 = 到周边室外物理站点的平均距离（相同经纬度算1站、剔除室分站）：
             室外源取最近N个室外站（默认9，前端可配）；室分源取最近8个室外站
           - 室外→室分（硬规则，与密集/稀疏无关）：距离 ≤ 600米 且 在源天线
             前向±120°内才添加；>600米 或 背向的室分一律不添加
           - 室外→室外：
             · 密集（站间距 < 1000米）：1.3倍站间距范围内全量添加（不判朝向）
             · 稀疏（站间距 ≥ 1000米）：仅按覆盖圆相交添加，再由每频最大邻区数截断
           - 室分源（全向，不做覆盖圆/朝向判断）：
             · 室分→室分：350米内添加
             · 室分→室外：站间距>350米按1.5倍站间距全量添加，否则350米内添加

        最终结果 = 第一步强制邻区 + 第二步候选（去重），同频/异频各自按
        (距离升序, 评分降序) 截断到 max_neighbors（每频门限）。
        """
        if self.target_cells_df is None or self.target_cells_df.empty:
            return []

        source_key = self.get_cell_key(source_row)
        source_lat = source_row.get('lat')
        source_lon = source_row.get('lon')
        source_azimuth = source_row.get('azimuth')
        source_cover_type = source_row.get('cell_cover_type', 1)  # 1=室外, 4=室分
        source_site_id = str(source_row.get('enodeb_id', ''))

        if pd.isna(source_lat) or pd.isna(source_lon):
            return []

        # 判断源小区是否为室分站点
        is_source_indoor = (source_cover_type == 4)

        # 用于去重的集合
        forced_neighbor_keys = set()

        # ========== 第一步：距离优先选择（强制邻区） ==========
        step1_forced_neighbors = []  # 强制邻区
        step1_remaining_candidates = []  # 剩余候选（附带 DataFrame 行号供后续快速查预计算数据）

        # 使用 NumPy 一次批量计算到所有目标小区的距离
        all_distances = self._batch_distances_to_targets(source_lat, source_lon)

        for i, (_, target_row) in enumerate(self.target_cells_df.iterrows()):
            target_key = self.get_cell_key(target_row)

            # 跳过自身
            if source_key == target_key:
                continue

            # 跳过缺少经纬度的行（预计算掩码）
            if not self._target_valid_mask[i]:
                continue

            target_cover_type = target_row.get('cell_cover_type', 1)
            is_target_indoor = (target_cover_type == 4)

            # 查询批量计算结果（O(1) 数组访问替代逐对 Haversine）
            distance = float(all_distances[i])

            # 规则：室外-室外300米内站点的所有小区作为强制邻区
            # （室分相关不在此强制——室外→室分按第二步"≤1km且前向"硬规则，
            #   室分源按第二步 350m/1.5倍站间距 规则，避免背向室分被误加强制）
            if not is_source_indoor and not is_target_indoor:
                if distance <= 0.30:  # 300米
                    step1_forced_neighbors.append((target_row, distance))
                    forced_neighbor_keys.add(target_key)
                    continue

            # 其他情况进入剩余候选（带行号索引），交给第二步场景化筛选
            step1_remaining_candidates.append((i, target_row, distance))

        logger.debug(f"第一步距离筛选: 源小区={source_key}, 强制邻区={len(step1_forced_neighbors)}, 剩余候选={len(step1_remaining_candidates)}")

        # ========== 第二步：按源/目标小区类型与站间距分场景筛选候选 ==========
        step2_candidates = []

        # 小区平均站间距（相同经纬度算1站，剔除室分目标）：
        # 室外源取最近N(默认9，前端可配)个室外站，室分源取最近8个室外站。
        site_spacing = self.calculate_site_spacing(source_row)

        # 室外场景阈值（门限均前端可配置）：站间距 < dense_spacing_threshold 为密集，
        # 按 dense_multiplier 倍站间距全量添加；≥门限为稀疏，按覆盖圆相交 + 每频门限。
        dense_spacing_threshold = self.dense_spacing_threshold_km
        dense_multiplier = self.dense_multiplier
        outdoor_is_dense = site_spacing < dense_spacing_threshold
        dense_radius = dense_multiplier * site_spacing             # 密集全量半径

        # 室分场景阈值（前端可配置）
        INDOOR_NEIGHBOR_RADIUS_KM = self.indoor_to_indoor_radius_km  # 室分-室分距离
        OUTDOOR_TO_INDOOR_MAX_KM = self.outdoor_to_indoor_max_km     # 室外→室分最远距离
        # 室分-室外：站间距>室分距离时按 indoor_to_outdoor_multiplier 倍站间距，否则至少按该距离
        indoor_outdoor_radius = (
            self.indoor_to_outdoor_multiplier * site_spacing
            if site_spacing > INDOOR_NEIGHBOR_RADIUS_KM
            else INDOOR_NEIGHBOR_RADIUS_KM
        )

        # 稀疏场景覆盖圆距离按站间距缩放：固定1km覆盖距离在农村大站间距(2km+)时
        # 半径仅约0.5km、对打最多够到约1.5km，够不着邻区导致只剩本站邻区。
        # 稀疏时覆盖距离取站间距，使覆盖圆前向可达约1.5倍站间距、背向仍不相交。
        # 注意：coverage_distance 单位为米（default=1000），site_spacing 单位为公里，需 ×1000
        effective_coverage_distance = (
            self.default_coverage_distance if outdoor_is_dense
            else max(self.default_coverage_distance, site_spacing * 1000.0)
        )

        # 源小区覆盖圆（室外稀疏场景使用，距离按站间距缩放）
        if pd.notna(source_azimuth):
            source_center_lat, source_center_lon = self.calculate_coverage_circle_center(
                source_lat, source_lon, source_azimuth,
                self.coverage_distance_factor, effective_coverage_distance
            )
        else:
            source_center_lat, source_center_lon = source_lat, source_lon

        source_radius = self.calculate_coverage_radius(
            effective_coverage_distance, self.coverage_radius_factor
        )

        for i, target_row, distance in step1_remaining_candidates:
            is_target_indoor = (target_row.get('cell_cover_type', 1) == 4)

            if is_source_indoor:
                # 室分源（全向覆盖，不做覆盖圆/朝向判断）
                if is_target_indoor:
                    # 室分-室分：350米内添加
                    if distance <= INDOOR_NEIGHBOR_RADIUS_KM:
                        step2_candidates.append((target_row, distance))
                else:
                    # 室分-室外：1.5倍站间距（站间距>350米）或至少350米内全量添加
                    if distance < indoor_outdoor_radius:
                        step2_candidates.append((target_row, distance))
                continue

            # 室外源 → 室外→室分：硬规则（与密集/稀疏无关）
            if is_target_indoor:
                # 距离 > 1000米的室分不添加；≤1000米且在源天线前向±120°内才添加
                # （背向室分不添加）。源无方位角信息时仅按距离判断。
                if distance <= OUTDOOR_TO_INDOOR_MAX_KM:
                    if pd.isna(source_azimuth):
                        step2_candidates.append((target_row, distance))
                    else:
                        forward_diff = self.calculate_forward_diff(
                            source_lat, source_lon, source_azimuth,
                            target_row['lat'], target_row['lon']
                        )
                        if forward_diff <= DIRECTION_GATE_DEG:
                            step2_candidates.append((target_row, distance))
                continue

            # 室外源 → 室外→室外
            if outdoor_is_dense:
                # 密集（站间距<1km）：1.3倍站间距范围内全量添加（不判朝向）
                if distance < dense_radius:
                    step2_candidates.append((target_row, distance))
                continue

            # 稀疏（站间距≥1km）：仅按覆盖圆相交添加，再由每频最大邻区数截断。
            # 覆盖圆距离按站间距缩放（effective_coverage_distance），故目标覆盖圆
            # 也用同一距离实时计算（预计算数组用固定1km，稀疏时够不着邻区）。
            target_azimuth = target_row.get('azimuth')
            if pd.notna(target_azimuth):
                tclat, tclon = self.calculate_coverage_circle_center(
                    target_row['lat'], target_row['lon'], target_azimuth,
                    self.coverage_distance_factor, effective_coverage_distance
                )
            else:
                tclat, tclon = target_row['lat'], target_row['lon']
            trad = self.calculate_coverage_radius(
                effective_coverage_distance, self.coverage_radius_factor
            )
            center_dist = self.calculate_distance(
                source_center_lat, source_center_lon, tclat, tclon
            )
            if center_dist <= (source_radius + trad):
                step2_candidates.append((target_row, distance))

        logger.debug(
            f"第二步场景筛选: 源小区={source_key}, 站间距={site_spacing:.3f}km, "
            f"源类型={'室分' if is_source_indoor else '室外'}, "
            f"场景={'密集(1.5x全量)' if (not is_source_indoor and outdoor_is_dense) else '室分/稀疏'}, "
            f"候选数={len(step2_candidates)}"
        )

        step3_candidates = step2_candidates

        # ========== 合并结果并去重 ==========
        # 最终结果 = 第一步 + 第三步的合集（第二步是中间过程）
        # 注意：强制邻区（第一步）应该无条件保留，不受max_neighbors限制

        # 强制邻区：无条件保留
        forced_neighbors = []
        for target_row, distance in step1_forced_neighbors:
            target_key = self.get_cell_key(target_row)
            target_azimuth = target_row.get('azimuth')

            source_to_target_azimuth = self.calculate_azimuth_angle(source_lat, source_lon, target_row['lat'], target_row['lon'])

            # 计算角度差
            facing_diff = None
            pointing_diff = None
            # 100米内视为同站：两点重合/极近时方位角无意义
            # （calculate_azimuth_angle 对重合点返回伪值0°，会错误压低同站邻区评分）
            if pd.notna(source_azimuth) and pd.notna(target_azimuth) and distance >= 0.1:
                # facing_diff：源天线方位角 与 源→目标方位角 的夹角（小=源正打目标）
                facing_diff = self.calculate_angle_difference(source_azimuth, source_to_target_azimuth)
                # pointing_diff：目标天线方位角 与 目标→源方位角 的夹角（小=目标正打源）；
                # 目标→源 = (源→目标)+180，旧代码误用 源→目标 导致方向反 180°
                pointing_diff = self.calculate_angle_difference(
                    target_azimuth, (source_to_target_azimuth + 180) % 360
                )
                # 双向对打：两小区天线各自朝向对方（偏角均在前向半球 <90° 内）
                is_forward = facing_diff < 90 and pointing_diff < 90
            else:
                is_forward = False

            # 强制邻区直接添加，保留原有评分逻辑（不受对打/内向影响）
            angle_diff = min(facing_diff, pointing_diff) if facing_diff is not None else None
            score = self.calculate_neighbor_score(distance, angle_diff)

            neighbor = NeighborRelation(
                source_key=source_key,
                target_key=target_key,
                distance=round(distance, 3),
                angle_diff=round(angle_diff, 1) if angle_diff is not None else None,
                source_cell_name=str(source_row.get('cell_name', '')),
                target_cell_name=str(target_row.get('cell_name', '')),
                source_enodeb_id=str(source_row.get('enodeb_id', '')),
                target_enodeb_id=str(target_row.get('enodeb_id', '')),
                score=score,
                source_pci=source_row.get('pci'),
                target_pci=target_row.get('pci'),
                source_earfcn=source_row.get('earfcn'),
                target_earfcn=target_row.get('earfcn'),
                relation_type=f"{self.config.source_type}-{self.config.target_type}"
            )
            forced_neighbors.append(neighbor)

        # 候选邻区：需要评分排序并限制数量
        candidate_neighbors = []
        for target_row, distance in step3_candidates:
            target_key = self.get_cell_key(target_row)

            # 跳过已经在强制邻区中的
            if target_key in forced_neighbor_keys:
                continue

            target_azimuth = target_row.get('azimuth')

            source_to_target_azimuth = self.calculate_azimuth_angle(source_lat, source_lon, target_row['lat'], target_row['lon'])

            # 计算角度差
            facing_diff = None
            pointing_diff = None
            # 100米内视为同站：两点重合/极近时方位角无意义
            # （calculate_azimuth_angle 对重合点返回伪值0°，会错误压低同站邻区评分）
            if pd.notna(source_azimuth) and pd.notna(target_azimuth) and distance >= 0.1:
                # facing_diff：源天线方位角 与 源→目标方位角 的夹角（小=源正打目标）
                facing_diff = self.calculate_angle_difference(source_azimuth, source_to_target_azimuth)
                # pointing_diff：目标天线方位角 与 目标→源方位角 的夹角（小=目标正打源）；
                # 目标→源 = (源→目标)+180，旧代码误用 源→目标 导致方向反 180°
                pointing_diff = self.calculate_angle_difference(
                    target_azimuth, (source_to_target_azimuth + 180) % 360
                )
                # 双向对打：两小区天线各自朝向对方（偏角均在前向半球 <90° 内）
                is_forward = facing_diff < 90 and pointing_diff < 90
            else:
                is_forward = False

            # 使用新的评分函数，对打邻区优先级更高
            angle_diff = min(facing_diff, pointing_diff) if facing_diff is not None else None
            score = self.calculate_neighbor_score(distance, angle_diff, facing_diff, pointing_diff, is_forward)

            neighbor = NeighborRelation(
                source_key=source_key,
                target_key=target_key,
                distance=round(distance, 3),
                angle_diff=round(angle_diff, 1) if angle_diff is not None else None,
                source_cell_name=str(source_row.get('cell_name', '')),
                target_cell_name=str(target_row.get('cell_name', '')),
                source_enodeb_id=str(source_row.get('enodeb_id', '')),
                target_enodeb_id=str(target_row.get('enodeb_id', '')),
                score=score,
                source_pci=source_row.get('pci'),
                target_pci=target_row.get('pci'),
                source_earfcn=source_row.get('earfcn'),
                target_earfcn=target_row.get('earfcn'),
                relation_type=f"{self.config.source_type}-{self.config.target_type}"
            )
            candidate_neighbors.append(neighbor)

        # 候选邻区（近端层 + 远端补足层）不在本层截断：
        # 最终在合并后按 同频/异频 各自 (距离升序, 评分降序) 截断到 max_neighbors
        selected_candidates = candidate_neighbors

        # ========== 合并 + 同频/异频分类 + 各自上限截断 ==========
        # "最大邻区数(max_neighbors)" 指 同频 与 异频 各自的上限：
        # 每小区最终邻区 = 同频前 max_neighbors + 异频前 max_neighbors。
        # 强制邻区(第一步)也纳入各自频率类别的上限，但按距离优先排序时
        # 同站(0km)与300米内强制邻区距离最近，必然排在截断线之内；
        # 近端层填满后，远端补足层（含所打方向的较远邻区）按距离递补，
        # 直到达到 max_neighbors 或候选耗尽。
        # 合并前先去重（近端层/远端层可能包含同一目标，避免重复出现）。
        combined_neighbors = forced_neighbors + selected_candidates
        seen_keys = set()
        unique_neighbors = []
        for n in combined_neighbors:
            if n.target_key not in seen_keys:
                seen_keys.add(n.target_key)
                unique_neighbors.append(n)

        same_freq_neighbors = []
        inter_freq_neighbors = []
        for n in unique_neighbors:
            if self._is_same_frequency(n.source_earfcn, n.target_earfcn):
                same_freq_neighbors.append(n)
            else:
                inter_freq_neighbors.append(n)

        # 距离优先排序：同站(0km)、300米内强制邻区、近端候选必须先占满名额，
        # 再考虑远端邻区；距离相同时按方向角评分（对打/内向）排序。
        # 旧逻辑仅按 score 降序：距离分(10-d)在1km内区分度不足，角度分(0~13)主导，
        # 远端对打邻区评分反超同站/近端邻区，候选超上限时近端被截断漏配。
        same_freq_neighbors.sort(key=lambda x: (x.distance, -x.score))
        inter_freq_neighbors.sort(key=lambda x: (x.distance, -x.score))

        # 每频门限截断：同频/异频各自最多 max_neighbors 个
        final_neighbors = same_freq_neighbors[:self.max_neighbors] + inter_freq_neighbors[:self.max_neighbors]

        logger.debug(
            f"最终结果: 同频={len(same_freq_neighbors[:self.max_neighbors])}, "
            f"异频={len(inter_freq_neighbors[:self.max_neighbors])}, "
            f"总计={len(final_neighbors)}, 上限={self.max_neighbors}(同频/异频各限)"
        )

        return final_neighbors
    
    def plan(self, source_sites: List[Dict], target_sites: List[Dict],
             progress_callback: Optional[Callable[[float], Any]] = None) -> NeighborPlanningResult:
        """
        执行邻区规划
        """
        task_id = str(uuid.uuid4())
        
        # 加载数据
        self.load_data_from_sites(source_sites, target_sites)
        
        if self.source_cells_df is None or self.source_cells_df.empty:
            return NeighborPlanningResult(
                task_id=task_id,
                status="failed",
                total_sites=0,
                total_sectors=0,
                total_neighbors=0,
                avg_neighbors=0.0
            )
        
        total_cells = len(self.source_cells_df)
        all_neighbors = []
        results_by_site = {}

        # 预收集源小区数据为 dict，确保跨线程序列化安全
        source_rows_dicts: List[Dict] = []
        for _idx, row in self.source_cells_df.iterrows():
            source_rows_dicts.append(row.to_dict())

        # 从配置读取工作线程数，或根据 CPU 核数计算
        try:
            from app.core.config import settings
            max_workers = settings.MAX_WORKERS
        except Exception:
            max_workers = min(3, os.cpu_count() or 4)

        total_cells_int = len(source_rows_dicts)

        # 预分配结果列表以保持原始顺序
        neighbor_results: List[Optional[Tuple[Dict, List[NeighborRelation]]]] = [None] * total_cells_int

        def process_one_cell(source_row_dict: Dict) -> Tuple[Dict, List[NeighborRelation]]:
            """处理单个源小区的邻区规划（在 ThreadPoolExecutor 工作线程中执行）

            每线程使用独立的 NeighborPlanner 实例和 _site_spacing_cache，
            确保线程安全。只读数据（numpy 数组、DataFrame、config）共享访问。
            """
            planner = NeighborPlanner.__new__(NeighborPlanner)
            planner.config = self.config
            planner.max_neighbors = self.max_neighbors
            planner.coverage_distance_factor = self.coverage_distance_factor
            planner.coverage_radius_factor = self.coverage_radius_factor
            planner.default_coverage_distance = self.default_coverage_distance
            planner.dense_spacing_threshold_km = self.dense_spacing_threshold_km
            planner.dense_multiplier = self.dense_multiplier
            planner.outdoor_to_indoor_max_km = self.outdoor_to_indoor_max_km
            planner.indoor_to_indoor_radius_km = self.indoor_to_indoor_radius_km
            planner.indoor_to_outdoor_multiplier = self.indoor_to_outdoor_multiplier
            planner.outdoor_spacing_site_count = self.outdoor_spacing_site_count
            planner.target_cells_df = self.target_cells_df
            planner._target_lats_arr = self._target_lats_arr
            planner._target_lons_arr = self._target_lons_arr
            planner._target_valid_mask = self._target_valid_mask
            planner._target_center_lats = self._target_center_lats
            planner._target_center_lons = self._target_center_lons
            planner._target_radii = self._target_radii
            planner._site_spacing_cache = {}  # 每线程独立缓存

            source_row = pd.Series(source_row_dict)
            neighbors = planner.plan_neighbors_for_cell(source_row)
            return source_row_dict, neighbors

        # 并行执行：ThreadPoolExecutor 优于 ProcessPoolExecutor，
        # 因为 numpy 运算会释放 GIL，且零数据拷贝开销
        from concurrent.futures import ThreadPoolExecutor, as_completed

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(process_one_cell, row_dict): idx
                for idx, row_dict in enumerate(source_rows_dicts)
            }

            total_completed = 0
            for future in as_completed(futures):
                idx = futures[future]
                source_row_dict, neighbors = future.result()
                neighbor_results[idx] = (source_row_dict, neighbors)

                total_completed += 1
                if progress_callback:
                    progress_callback(total_completed / total_cells_int * 100)

        # 按原始顺序汇总结果
        for source_row_dict, neighbors in neighbor_results:
            source_row = pd.Series(source_row_dict)
            site_id = str(source_row['enodeb_id'])
            sector_id = str(source_row['cell_id'])
            cell_name = str(source_row.get('cell_name', ''))

            if site_id not in results_by_site:
                results_by_site[site_id] = {
                    "siteId": site_id,
                    "siteName": f"Site_{site_id}",
                    "sectors": []
                }

            sector_neighbors = []
            for n in neighbors:
                sector_neighbors.append({
                    "targetSector": n.target_key,
                    "targetSectorName": n.target_cell_name,
                    "targetSite": n.target_enodeb_id,
                    "targetSiteName": f"Site_{n.target_enodeb_id}",
                    "distance": n.distance,
                    "bearing": n.angle_diff if n.angle_diff else 0,
                    "relationType": f"{self.config.source_type}-{self.config.target_type}"
                })
                all_neighbors.append(n)

            results_by_site[site_id]["sectors"].append({
                "sectorId": sector_id,
                "sectorName": cell_name,
                "neighbors": sector_neighbors,
                "neighborCount": len(sector_neighbors)
            })

        total_neighbors = len(all_neighbors)
        avg_neighbors = total_neighbors / total_cells if total_cells > 0 else 0.0
        
        # 统计唯一源基站
        unique_source_sites = set(n.source_enodeb_id for n in all_neighbors)
        
        # 构建扁平化结果列表
        flat_results = []
        for n in all_neighbors:
            # source_key 和 target_key 格式为 "enodeb_id_cell_id"
            # 注意：cell_id 本身可能包含下划线，所以应该使用第一个下划线作为分隔符
            # 例如: "370185_1_2" 表示 enodeb_id="370185", cell_id="1_2"

            def extract_site_cell(key: str) -> tuple:
                """提取 site_id 和 cell_id，处理 cell_id 包含下划线的情况"""
                if '_' not in key:
                    return key, ''
                first_underscore_idx = key.index('_')
                site_id = key[:first_underscore_idx]
                cell_id = key[first_underscore_idx + 1:]
                return site_id, cell_id

            source_site_id, source_cell_id = extract_site_cell(n.source_key)
            target_site_id, target_cell_id = extract_site_cell(n.target_key)

            flat_results.append({
                "relationType": n.relation_type,
                "sourceSiteId": source_site_id,  # 对应前端的 siteId
                "sourceCellId": source_cell_id,  # 对应前端的 sectorId
                "sourceCellName": n.source_cell_name,
                "sourcePci": int(n.source_pci) if pd.notna(n.source_pci) else None,
                "sourceFrequency": int(n.source_earfcn) if pd.notna(n.source_earfcn) else None,
                "targetSiteId": target_site_id,  # 对应前端的 siteId
                "targetCellId": target_cell_id,  # 对应前端的 sectorId
                "targetCellName": n.target_cell_name,
                "targetPci": int(n.target_pci) if pd.notna(n.target_pci) else None,
                "targetFrequency": int(n.target_earfcn) if pd.notna(n.target_earfcn) else None,
                "distance": n.distance,
                "bearing": n.angle_diff
            })
        
        return NeighborPlanningResult(
            task_id=task_id,
            status="completed",
            total_sites=len(unique_source_sites),
            total_sectors=total_cells,
            total_neighbors=total_neighbors,
            avg_neighbors=round(avg_neighbors, 2),
            results=flat_results,
            progress=100.0
        )


def run_neighbor_planning(
    config: NeighborConfig,
    source_sites: List[Dict],
    target_sites: List[Dict],
    progress_callback: Optional[Callable[[float], Any]] = None
) -> Dict[str, Any]:
    """
    运行邻区规划

    Args:
        config: 规划配置
        source_sites: 待规划小区（源小区）列表
        target_sites: 全网小区（目标小区）列表
        progress_callback: 进度回调

    Returns:
        规划结果字典
    """
    planner = NeighborPlanner(config)

    # 执行规划
    result = planner.plan(
        source_sites,
        target_sites,
        progress_callback
    )
    
    # 转换为字典格式
    return {
        "taskId": result.task_id,
        "status": result.status,
        "totalSites": result.total_sites,
        "totalSectors": result.total_sectors,
        "totalNeighbors": result.total_neighbors,
        "avgNeighbors": result.avg_neighbors,
        "results": result.results
    }
