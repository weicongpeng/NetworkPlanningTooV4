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

from app.algorithms.grid_index import GridIndex

logger = logging.getLogger(__name__)


# ============================== 向量化工具 ==============================

def _haversine_matrix(
    lats1: np.ndarray, lons1: np.ndarray, lats2: np.ndarray, lons2: np.ndarray
) -> np.ndarray:
    """两组坐标的球面距离矩阵（公里），与 calculate_distance 同口径"""
    lat1 = np.radians(lats1)[:, None]
    lon1 = np.radians(lons1)[:, None]
    lat2 = np.radians(lats2)[None, :]
    lon2 = np.radians(lons2)[None, :]
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    a = np.clip(a, 0.0, 1.0)
    return 2 * np.arcsin(np.sqrt(a)) * 6371


def _haversine_vector(
    lat1: float, lon1: float, lats2: np.ndarray, lons2: np.ndarray
) -> np.ndarray:
    """单点到多点距离（公里）"""
    return _haversine_matrix(
        np.array([lat1], dtype=float), np.array([lon1], dtype=float), lats2, lons2
    )[0]


def _bearings(
    lat1: float, lon1: float, lats2: np.ndarray, lons2: np.ndarray
) -> np.ndarray:
    """单点到多点的方位角（度，北=0，顺时针），与 calculate_azimuth_angle 同口径"""
    lat1_r = math.radians(lat1)
    lon1_r = math.radians(lon1)
    lat2_r = np.radians(lats2)
    lon2_r = np.radians(lons2)
    dlon = lon2_r - lon1_r
    y = np.sin(dlon) * np.cos(lat2_r)
    x = np.cos(lat1_r) * np.sin(lat2_r) - np.sin(lat1_r) * np.cos(lat2_r) * np.cos(dlon)
    return np.degrees(np.arctan2(y, x)) % 360.0


def _int_or_none(value: Any) -> Optional[int]:
    """整数化：None/NaN 返回 None（与 pd.notna 口径一致）"""
    if value is None or value != value:
        return None
    return int(value)


def _coverage_centers(
    lats: np.ndarray, lons: np.ndarray, azimuths_deg: np.ndarray,
    distance_factor: float, coverage_distance: float,
) -> Tuple[np.ndarray, np.ndarray]:
    """批量覆盖圆圆心，与 calculate_coverage_circle_center 同口径"""
    offset_km = (coverage_distance / 2) * distance_factor / 1000
    angular = offset_km / 6371
    lat_r = np.radians(lats)
    lon_r = np.radians(lons)
    az_r = np.radians(azimuths_deg)
    center_lat = np.arcsin(
        np.sin(lat_r) * np.cos(angular)
        + np.cos(lat_r) * np.sin(angular) * np.cos(az_r)
    )
    center_lon = lon_r + np.arctan2(
        np.sin(az_r) * np.sin(angular) * np.cos(lat_r),
        np.cos(angular) - np.sin(lat_r) * np.sin(center_lat),
    )
    return np.degrees(center_lat), np.degrees(center_lon)




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
    outdoor_spacing_site_count: int = 11      # 室外源站间距取最近N个室外站


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
        # 源小区（按物理位置）预取的候选目标下标，避免每小区扫描全目标池
        self._source_candidates: Dict[Tuple[str, float, float, bool], np.ndarray] = {}
        self._target_grid: Optional[GridIndex] = None
        self._outdoor_grid: Optional[GridIndex] = None
        
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

        self._init_target_arrays()
        self._target_grid = None
        self._outdoor_grid = None
        self._source_candidates = {}

    def _init_target_arrays(self) -> None:
        """预提取目标小区的 NumPy 数组，后续规则筛选不再逐行访问 pandas Series"""
        df = self.target_cells_df
        if df is None or df.empty:
            self._target_lats_arr = np.empty(0, dtype=float)
            self._target_lons_arr = np.empty(0, dtype=float)
            self._target_azimuths = np.empty(0, dtype=float)
            self._target_cover_types = np.empty(0, dtype=np.int64)
            self._target_pcis = np.empty(0, dtype=float)
            self._target_freqs = np.empty(0, dtype=float)
            self._target_keys: List[str] = []
            self._target_keys_arr = np.empty(0, dtype=object)
            self._target_cell_names: List[str] = []
            self._target_enodeb_ids: List[str] = []
            self._target_valid_mask = np.empty(0, dtype=bool)
            self._target_center_lats = np.empty(0, dtype=float)
            self._target_center_lons = np.empty(0, dtype=float)
            self._target_radii = np.empty(0, dtype=float)
            self._outdoor_site_lats = np.empty(0, dtype=float)
            self._outdoor_site_lons = np.empty(0, dtype=float)
            self._target_span = 0.0
            return

        self._target_lats_arr = df['lat'].to_numpy(dtype=float)
        self._target_lons_arr = df['lon'].to_numpy(dtype=float)
        self._target_valid_mask = ~(
            np.isnan(self._target_lats_arr) | np.isnan(self._target_lons_arr)
        )
        self._target_azimuths = df['azimuth'].to_numpy(dtype=float)
        self._target_cover_types = (
            df['cell_cover_type'].fillna(1).to_numpy(dtype=np.int64)
        )
        self._target_pcis = df['pci'].to_numpy(dtype=float)
        self._target_freqs = df['earfcn'].to_numpy(dtype=float)
        self._target_enodeb_ids = [str(v) for v in df['enodeb_id'].tolist()]
        cell_ids = [str(v) for v in df['cell_id'].tolist()]
        self._target_keys = [
            f"{enodeb}_{cell}" for enodeb, cell in zip(self._target_enodeb_ids, cell_ids)
        ]
        self._target_keys_arr = np.asarray(self._target_keys, dtype=object)
        self._target_cell_names = [str(v) for v in df['cell_name'].tolist()]

        # 覆盖圆数据只依赖目标小区自身，与源小区无关
        safe_azimuths = np.where(np.isnan(self._target_azimuths), 0.0, self._target_azimuths)
        center_lats, center_lons = _coverage_centers(
            self._target_lats_arr, self._target_lons_arr, safe_azimuths,
            self.coverage_distance_factor, self.default_coverage_distance,
        )
        has_azimuth = ~np.isnan(self._target_azimuths)
        self._target_center_lats = np.where(has_azimuth, center_lats, self._target_lats_arr)
        self._target_center_lons = np.where(has_azimuth, center_lons, self._target_lons_arr)
        self._target_radii = np.full(
            len(df),
            self.calculate_coverage_radius(
                self.default_coverage_distance, self.coverage_radius_factor
            ),
            dtype=float,
        )

        # 室外物理站点（100m 内共址去重）供站间距计算复用
        outdoor_mask = self._target_valid_mask & (self._target_cover_types != 4)
        outdoor_lats = self._target_lats_arr[outdoor_mask]
        outdoor_lons = self._target_lons_arr[outdoor_mask]
        if outdoor_lats.size:
            positions = np.stack(
                [np.round(outdoor_lats, 6), np.round(outdoor_lons, 6)], axis=1
            )
            _, first = np.unique(positions, axis=0, return_index=True)
            self._outdoor_site_lats = outdoor_lats[first]
            self._outdoor_site_lons = outdoor_lons[first]
        else:
            self._outdoor_site_lats = np.empty(0, dtype=float)
            self._outdoor_site_lons = np.empty(0, dtype=float)

        self._target_span = self._compute_target_span()

    def _compute_target_span(self) -> float:
        """目标池包围盒对角线，作为邻域搜索的终止半径（只算一次）"""
        lats = self._target_lats_arr[self._target_valid_mask]
        lons = self._target_lons_arr[self._target_valid_mask]
        if lats.size < 2:
            return 0.0
        max_abs_lat = float(np.max(np.abs(lats)))
        lat_span = float(np.max(lats) - np.min(lats)) * 111.0
        lon_span = float(np.max(lons) - np.min(lons)) * 111.0 * math.cos(math.radians(max_abs_lat))
        return math.hypot(lat_span, lon_span)

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

    def _batch_distances_to_targets(
        self, source_lat: float, source_lon: float, indices: Optional[np.ndarray] = None
    ) -> np.ndarray:
        """NumPy 向量化：一次计算源小区到目标（或候选目标）的距离"""
        lat1_rad = math.radians(source_lat)
        lon1_rad = math.radians(source_lon)
        target_lats = self._target_lats_arr if indices is None else self._target_lats_arr[indices]
        target_lons = self._target_lons_arr if indices is None else self._target_lons_arr[indices]
        slat = np.radians(target_lats)
        slon = np.radians(target_lons)
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

    def get_cell_key(self, row: Any) -> str:
        """获取小区唯一标识"""
        return f"{row['enodeb_id']}_{row['cell_id']}"
    
    def calculate_site_spacing(self, source_row: Any) -> float:
        """
        计算小区平均站间距：待规划小区到周边最近 N 个室外物理站点的平均距离

        N 按源小区类型取值：
          - 室分源（cell_cover_type=4，室分→室外）：最近 8 个室外站点
          - 室外源（室外→室外、室外→室分）：最近 N 个室外站点（配置项，默认11）

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
        if pd.isna(source_lat) or pd.isna(source_lon):
            return 0.5

        cache_key = self._spacing_cache_key(source_row, source_lat, source_lon)
        if cache_key in self._site_spacing_cache:
            return self._site_spacing_cache[cache_key]

        spacing = self._nearest_outdoor_spacing(
            float(source_lat), float(source_lon), self._nearest_spacing_count(source_row)
        )
        if spacing is None:
            return 0.5

        logger.debug(
            f"站间距计算: 源站点={cache_key}, 源类型={'室分' if self._row_is_indoor(source_row) else '室外'}, "
            f"平均距离={spacing:.3f}km"
        )
        self._site_spacing_cache[cache_key] = spacing
        return spacing

    @staticmethod
    def _row_is_indoor(row) -> bool:
        cover = row.get('cell_cover_type', 1)
        return False if cover is None or pd.isna(cover) else cover == 4

    def _spacing_cache_key(self, row, lat: float, lon: float) -> str:
        """同坐标、同类型小区共享站间距（缓存键含类型，避免室外/室分混用）"""
        type_tag = 'in' if self._row_is_indoor(row) else 'out'
        return (
            f"{str(row.get('enodeb_id', ''))}:{round(float(lat), 6)}:"
            f"{round(float(lon), 6)}:{type_tag}"
        )

    def _nearest_spacing_count(self, row) -> int:
        """室分源取最近 8 个室外站，室外源取最近 N 个（前端可配置）"""
        return 8 if self._row_is_indoor(row) else self.outdoor_spacing_site_count

    def _nearest_outdoor_spacing(
        self, lat: float, lon: float, nearest_count: int
    ) -> Optional[float]:
        """网格逐圈检索最近 N 个室外物理站的平均距离；无有效站点返回 None"""
        if self._outdoor_site_lats.size == 0:
            return None
        if self._outdoor_grid is None:
            self._outdoor_grid = GridIndex(self._outdoor_site_lats, self._outdoor_site_lons)
        max_radius = max(self._target_span, 1.0)
        radius = 3.0
        while True:
            query_radius = min(radius, max_radius)
            candidate = self._outdoor_grid.query(lat, lon, query_radius)
            if candidate.size:
                distances = _haversine_vector(
                    lat, lon, self._outdoor_site_lats[candidate], self._outdoor_site_lons[candidate]
                )
                distances = distances[distances >= 0.1]
                enough = distances.size >= nearest_count
                if enough or radius >= max_radius:
                    if distances.size == 0:
                        return None
                    keep = min(nearest_count, distances.size)
                    nearest = np.partition(distances, keep - 1)[:keep]
                    return float(np.mean(nearest))
            if radius >= max_radius:
                return None
            radius *= 2

    def _precompute_site_spacing(self, source_rows: List[Dict]) -> None:
        """按站点键批量预热站间距，供逐小区规划直接复用"""
        if self._outdoor_site_lats.size == 0:
            return
        pending: Dict[str, Tuple[float, float, int]] = {}
        for row in source_rows:
            lat, lon = row.get('lat'), row.get('lon')
            if lat is None or lon is None or pd.isna(lat) or pd.isna(lon):
                continue
            key = self._spacing_cache_key(row, lat, lon)
            if key in self._site_spacing_cache or key in pending:
                continue
            pending[key] = (float(lat), float(lon), self._nearest_spacing_count(row))
        for key, (lat, lon, nearest_count) in pending.items():
            spacing = self._nearest_outdoor_spacing(lat, lon, nearest_count)
            if spacing is not None:
                self._site_spacing_cache[key] = spacing

    def plan_neighbors_for_cell(
        self, source_row: Any, candidate_indices: Optional[np.ndarray] = None
    ) -> List[NeighborRelation]:
        """为单个源小区规划邻区 - 分层候选 + 距离优先截断

        筛选步骤：
        第一步：距离优先选择（强制邻区）
           - 室外-室外：300米内站点的所有小区作为邻区
           - 室分到室外/室外到室分：160米内

        第二步：按源/目标小区类型与站间距分场景筛选候选
           - 站间距 = 到周边室外物理站点的平均距离（相同经纬度算1站、剔除室分站）：
             室外源取最近N个室外站（默认11，前端可配）；室分源取最近8个室外站
           - 室外→室分（硬规则，与密集/稀疏无关）：300米内室分免朝向直接入
             候选；>300米须距离 ≤ 600米 且在源天线前向±120°内才添加；
             >600米 或 背向的室分一律不添加
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

        source_lat = source_row.get('lat')
        source_lon = source_row.get('lon')
        if pd.isna(source_lat) or pd.isna(source_lon):
            return []

        if candidate_indices is None:
            candidate_indices = self._candidate_indices_for(source_row)
        if candidate_indices is None:
            candidate_indices = np.arange(len(self._target_lats_arr), dtype=np.int64)
        if candidate_indices.size == 0:
            return []

        source_key = self.get_cell_key(source_row)
        is_source_indoor = self._row_is_indoor(source_row)
        distances = self._batch_distances_to_targets(source_lat, source_lon, candidate_indices)
        forced_idx, forced_dist, remaining_idx, remaining_dist = self._first_pass(
            source_key, candidate_indices, distances, is_source_indoor
        )
        candidate_idx, candidate_dist = self._second_pass(
            source_row, remaining_idx, remaining_dist, is_source_indoor
        )
        forced_neighbors = self._build_neighbors(source_row, forced_idx, forced_dist, forced=True)
        candidate_neighbors = self._build_neighbors(
            source_row, candidate_idx, candidate_dist, forced=False
        )
        return self._finalize_neighbors(forced_neighbors, candidate_neighbors)

    def _first_pass(
        self, source_key: str, indices: np.ndarray, distances: np.ndarray, is_source_indoor: bool
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """第一步：室外-室外 300m 内为强制邻区，其余进入第二步"""
        base = self._target_valid_mask[indices] & (self._target_keys_arr[indices] != source_key)
        if is_source_indoor:
            forced_mask = np.zeros_like(base)
        else:
            forced_mask = (
                base
                & (self._target_cover_types[indices] != 4)
                & (distances <= 0.30)
            )
        remaining_mask = base & ~forced_mask
        return (
            indices[forced_mask], distances[forced_mask],
            indices[remaining_mask], distances[remaining_mask],
        )

    def _second_pass(
        self, source_row, indices: np.ndarray, distances: np.ndarray, is_source_indoor: bool
    ) -> Tuple[np.ndarray, np.ndarray]:
        """第二步：按源/目标小区类型与站间距分场景筛选候选"""
        if indices.size == 0:
            return indices, distances
        site_spacing = self.calculate_site_spacing(source_row)
        target_indoor = self._target_cover_types[indices] == 4
        selected = np.zeros(indices.size, dtype=bool)

        if is_source_indoor:
            # 室分源（全向覆盖，不做覆盖圆/朝向判断）
            selected |= target_indoor & (distances <= self.indoor_to_indoor_radius_km)
            indoor_outdoor_radius = (
                self.indoor_to_outdoor_multiplier * site_spacing
                if site_spacing > self.indoor_to_indoor_radius_km
                else self.indoor_to_indoor_radius_km
            )
            selected |= ~target_indoor & (distances < indoor_outdoor_radius)
        else:
            selected |= self._outdoor_to_indoor_mask(source_row, indices, distances, target_indoor)
            selected |= self._outdoor_to_outdoor_mask(
                source_row, indices, distances, target_indoor, site_spacing
            )

        logger.debug(
            f"第二步场景筛选: 源小区={self.get_cell_key(source_row)}, 站间距={site_spacing:.3f}km, "
            f"源类型={'室分' if is_source_indoor else '室外'}, 候选数={int(selected.sum())}"
        )
        return indices[selected], distances[selected]

    def _outdoor_to_indoor_mask(
        self, source_row, indices: np.ndarray, distances: np.ndarray, target_indoor: np.ndarray
    ) -> np.ndarray:
        """室外源→室分：300m 内免朝向；300~600m 须落在源天线前向 ±120°"""
        within = target_indoor & (distances <= self.outdoor_to_indoor_max_km)
        selected = within & (distances <= 0.30)
        far = within & ~selected
        source_azimuth = source_row.get('azimuth')
        if pd.isna(source_azimuth):
            return within
        if not far.any():
            return selected

        far_idx = indices[far]
        bearings = _bearings(
            float(source_row['lat']), float(source_row['lon']),
            self._target_lats_arr[far_idx], self._target_lons_arr[far_idx],
        )
        diff = np.abs(float(source_azimuth) - bearings)
        diff = np.minimum(diff, 360.0 - diff)
        selected_far = far.copy()
        selected_far[far] = diff <= DIRECTION_GATE_DEG
        return selected | selected_far

    def _outdoor_to_outdoor_mask(
        self, source_row, indices: np.ndarray, distances: np.ndarray,
        target_indoor: np.ndarray, site_spacing: float,
    ) -> np.ndarray:
        """室外源→室外：密集按 1.3×站间距全量；稀疏按覆盖圆相交"""
        outdoor = ~target_indoor
        if site_spacing < self.dense_spacing_threshold_km:
            return outdoor & (distances < self.dense_multiplier * site_spacing)

        selected = np.zeros(indices.size, dtype=bool)
        target_idx = indices[outdoor]
        if target_idx.size == 0:
            return selected

        effective_distance = max(self.default_coverage_distance, site_spacing * 1000.0)
        target_azimuths = self._target_azimuths[target_idx]
        has_azimuth = ~np.isnan(target_azimuths)
        center_lats, center_lons = _coverage_centers(
            self._target_lats_arr[target_idx], self._target_lons_arr[target_idx],
            np.where(has_azimuth, target_azimuths, 0.0),
            self.coverage_distance_factor, effective_distance,
        )
        center_lats = np.where(has_azimuth, center_lats, self._target_lats_arr[target_idx])
        center_lons = np.where(has_azimuth, center_lons, self._target_lons_arr[target_idx])

        source_lat = float(source_row['lat'])
        source_lon = float(source_row['lon'])
        source_azimuth = source_row.get('azimuth')
        if pd.notna(source_azimuth):
            source_center_lat, source_center_lon = self.calculate_coverage_circle_center(
                source_lat, source_lon, source_azimuth,
                self.coverage_distance_factor, effective_distance,
            )
        else:
            source_center_lat, source_center_lon = source_lat, source_lon

        center_dist = _haversine_vector(
            source_center_lat, source_center_lon, center_lats, center_lons
        )
        radius_sum = 2 * self.calculate_coverage_radius(
            effective_distance, self.coverage_radius_factor
        )
        selected[outdoor] = center_dist <= radius_sum
        return selected

    def _build_neighbors(
        self, source_row, indices: np.ndarray, distances: np.ndarray, forced: bool
    ) -> List[NeighborRelation]:
        """把通过筛选的目标转为邻区关系（强制邻区用简化评分，候选邻区含对打加分）

        方位角/评分整批向量化：单源候选数常有几十到几百个，逐邻区调用 Python
        math 函数是旧实现的主要耗时点。
        """
        if indices.size == 0:
            return []
        source_key = self.get_cell_key(source_row)
        source_lat = float(source_row['lat'])
        source_lon = float(source_row['lon'])
        source_azimuth = source_row.get('azimuth')
        source_cell_name = str(source_row.get('cell_name', ''))
        source_enodeb_id = str(source_row.get('enodeb_id', ''))
        source_pci = source_row.get('pci')
        source_earfcn = source_row.get('earfcn')
        relation_type = f"{self.config.source_type}-{self.config.target_type}"

        has_source_az = pd.notna(source_azimuth)
        target_azimuths = self._target_azimuths[indices]
        has_target_az = ~np.isnan(target_azimuths)
        bearings = _bearings(
            source_lat, source_lon,
            self._target_lats_arr[indices], self._target_lons_arr[indices],
        )
        # 100米内视为同站：两点重合/极近时方位角无意义，会错误压低同站邻区评分
        pair_valid = has_source_az & has_target_az & (distances >= 0.1)
        facing = np.zeros(indices.size, dtype=float)
        pointing = np.zeros(indices.size, dtype=float)
        if has_source_az:
            facing = np.abs(float(source_azimuth) - bearings)
            facing = np.minimum(facing, 360.0 - facing)
            # 目标→源 = (源→目标)+180
            pointing = np.abs(
                np.where(has_target_az, target_azimuths, 0.0) - ((bearings + 180.0) % 360.0)
            )
            pointing = np.minimum(pointing, 360.0 - pointing)
        angle_diff = np.full(indices.size, np.nan, dtype=float)
        if pair_valid.any():
            angle_diff[pair_valid] = np.minimum(facing, pointing)[pair_valid]
        is_forward = pair_valid & (facing < 90.0) & (pointing < 90.0)

        angle_score = np.full(indices.size, 5.0, dtype=float)  # 无方向角信息时给中等分
        if forced:
            angle_score[pair_valid] = np.maximum(
                0.0, (180.0 - angle_diff[pair_valid]) / 18.0
            )
        else:
            non_forward = pair_valid & ~is_forward
            angle_score[non_forward] = np.maximum(
                0.0, (180.0 - facing[non_forward]) / 18.0
            ) * 0.8
            angle_score[is_forward] = np.maximum(
                0.0, (180.0 - np.maximum(facing, pointing)[is_forward]) / 18.0
            ) + 3.0
        scores = np.maximum(0.0, 10.0 - distances) + angle_score

        target_keys = self._target_keys
        target_cell_names = self._target_cell_names
        target_enodeb_ids = self._target_enodeb_ids
        target_pcis = self._target_pcis
        target_freqs = self._target_freqs
        angle_diffs = angle_diff.tolist()
        neighbors: List[NeighborRelation] = []
        for pos, target_idx in enumerate(indices.tolist()):
            angle_diff_value = angle_diffs[pos]
            neighbors.append(NeighborRelation(
                source_key=source_key,
                target_key=target_keys[target_idx],
                distance=round(float(distances[pos]), 3),
                angle_diff=(
                    None if math.isnan(angle_diff_value) else round(angle_diff_value, 1)
                ),
                source_cell_name=source_cell_name,
                target_cell_name=target_cell_names[target_idx],
                source_enodeb_id=source_enodeb_id,
                target_enodeb_id=target_enodeb_ids[target_idx],
                score=float(scores[pos]),
                source_pci=source_pci,
                target_pci=target_pcis[target_idx],
                source_earfcn=source_earfcn,
                target_earfcn=target_freqs[target_idx],
                relation_type=relation_type,
            ))
        return neighbors

    def _finalize_neighbors(
        self, forced_neighbors: List[NeighborRelation], candidate_neighbors: List[NeighborRelation]
    ) -> List[NeighborRelation]:
        """合并去重后按同频/异频各自 (距离升序, 评分降序) 截断到 max_neighbors"""
        seen_keys = set()
        unique_neighbors = []
        for neighbor in forced_neighbors + candidate_neighbors:
            if neighbor.target_key not in seen_keys:
                seen_keys.add(neighbor.target_key)
                unique_neighbors.append(neighbor)

        same_freq_neighbors = []
        inter_freq_neighbors = []
        for neighbor in unique_neighbors:
            if self._is_same_frequency(neighbor.source_earfcn, neighbor.target_earfcn):
                same_freq_neighbors.append(neighbor)
            else:
                inter_freq_neighbors.append(neighbor)

        same_freq_neighbors.sort(key=lambda x: (x.distance, -x.score))
        inter_freq_neighbors.sort(key=lambda x: (x.distance, -x.score))
        final_neighbors = (
            same_freq_neighbors[:self.max_neighbors]
            + inter_freq_neighbors[:self.max_neighbors]
        )
        logger.debug(
            f"最终结果: 同频={len(final_neighbors) - len(inter_freq_neighbors[:self.max_neighbors])}, "
            f"异频={len(inter_freq_neighbors[:self.max_neighbors])}, "
            f"总计={len(final_neighbors)}, 上限={self.max_neighbors}(同频/异频各限)"
        )
        return final_neighbors

    def _source_context_key(self, source_row) -> Optional[Tuple[str, float, float, bool]]:
        """源小区物理位置键；坐标缺失返回 None"""
        lat = source_row.get('lat')
        lon = source_row.get('lon')
        if lat is None or lon is None or pd.isna(lat) or pd.isna(lon):
            return None
        return (
            str(source_row.get('enodeb_id', '')),
            round(float(lat), 6),
            round(float(lon), 6),
            self._row_is_indoor(source_row),
        )

    def _candidate_indices_for(self, source_row) -> Optional[np.ndarray]:
        """返回源小区预取的候选目标下标；None 表示未预热（调用方回退全量）"""
        key = self._source_context_key(source_row)
        if key is None:
            return np.empty(0, dtype=np.int64)
        return self._source_candidates.get(key)

    def _search_radius(self, site_spacing: float) -> float:
        """邻区规则可能触达的最大距离

        密集场景不做覆盖圆，半径取 1.3×站间距与室分规则；稀疏场景覆盖圆相交
        上界为 ECD×(2×半径系数+距离系数)，ECD=max(1km, 站间距)。
        """
        radius = max(
            0.30,
            self.outdoor_to_indoor_max_km,
            self.indoor_to_indoor_radius_km,
            self.indoor_to_outdoor_multiplier * site_spacing,
        )
        if site_spacing < self.dense_spacing_threshold_km:
            return max(radius, self.dense_multiplier * site_spacing)
        coverage_factor = 2 * self.coverage_radius_factor + self.coverage_distance_factor
        return max(radius, max(1.0, site_spacing) * max(1.0, coverage_factor))

    def _build_source_candidates(self, source_rows: List[Dict]) -> None:
        """按源物理位置预取候选目标下标：邻区只可能落在规则最大半径内"""
        if self._target_grid is None:
            self._target_grid = GridIndex(self._target_lats_arr, self._target_lons_arr)
        self._source_candidates = {}
        for row in source_rows:
            key = self._source_context_key(row)
            if key is None or key in self._source_candidates:
                continue
            spacing = self.calculate_site_spacing(row)
            radius = self._search_radius(spacing)
            candidate = self._target_grid.query(key[1], key[2], radius)
            if candidate.size:
                # 网格桶是粗筛，按精确距离收敛到规则真正触达的范围
                distances = _haversine_vector(
                    key[1], key[2],
                    self._target_lats_arr[candidate], self._target_lons_arr[candidate],
                )
                candidate = candidate[distances <= radius]
            self._source_candidates[key] = candidate

    def _prepare_source_context(self, source_rows: List[Dict]) -> None:
        """规划开始前一次性预热站间距与候选索引"""
        self._precompute_site_spacing(source_rows)
        self._build_source_candidates(source_rows)

    def plan_same_freq_adjacency(
        self, source_sites: List[Dict], target_sites: List[Dict],
        progress_callback: Optional[Callable[[float], Any]] = None,
    ) -> Dict[str, List[str]]:
        """只产出同频邻接表 {源小区key: [同频邻区key]}，不构造完整规划结果"""
        self.load_data_from_sites(source_sites, target_sites)
        if self.source_cells_df is None or self.source_cells_df.empty:
            return {}

        source_rows_dicts: List[Dict] = self.source_cells_df.to_dict('records')
        total = len(source_rows_dicts)
        if total == 0:
            return {}
        self._prepare_source_context(source_rows_dicts)

        # 单小区计算以 Python 标量/小数组为主，线程池受 GIL 限制反而更慢，串行执行
        adjacency: Dict[str, List[str]] = {}
        for completed, source_row_dict in enumerate(source_rows_dicts, start=1):
            neighbors = self.plan_neighbors_for_cell(source_row_dict)
            source_key = f"{source_row_dict.get('enodeb_id', '')}_{source_row_dict.get('cell_id', '')}"
            adjacency[source_key] = [
                n.target_key for n in neighbors
                if self._is_same_frequency(n.source_earfcn, n.target_earfcn)
            ]
            if progress_callback:
                progress_callback(completed / total * 100)
        return adjacency

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
        results_by_site = {}

        # 预收集源小区数据为 dict，逐小区规划与结果汇总都按该顺序进行
        source_rows_dicts: List[Dict] = self.source_cells_df.to_dict('records')

        # 站间距/候选索引在规划前一次性预热，后续逐小区复用
        self._prepare_source_context(source_rows_dicts)

        total_cells_int = len(source_rows_dicts)

        # 串行执行：单小区计算以 Python 标量/小数组为主，线程池受 GIL 限制反而更慢
        neighbor_results: List[Tuple[Dict, List[NeighborRelation]]] = []
        for completed, source_row_dict in enumerate(source_rows_dicts, start=1):
            neighbor_results.append(
                (source_row_dict, self.plan_neighbors_for_cell(source_row_dict))
            )
            if progress_callback:
                progress_callback(completed / total_cells_int * 100)

        # 按原始顺序汇总结果：源侧字段每小区只算一次，避免 73 万级邻区逐行重复取值
        total_neighbors = 0
        unique_source_sites = set()
        flat_results = []
        relation_type = f"{self.config.source_type}-{self.config.target_type}"
        for source_row_dict, neighbors in neighbor_results:
            site_id = str(source_row_dict['enodeb_id'])
            sector_id = str(source_row_dict['cell_id'])
            cell_name = str(source_row_dict.get('cell_name', ''))
            source_site_id, _, source_cell_id = (
                f"{source_row_dict.get('enodeb_id', '')}_{source_row_dict.get('cell_id', '')}"
            ).partition('_')
            source_pci = _int_or_none(source_row_dict.get('pci'))
            source_earfcn = _int_or_none(source_row_dict.get('earfcn'))

            if site_id not in results_by_site:
                results_by_site[site_id] = {
                    "siteId": site_id,
                    "siteName": f"Site_{site_id}",
                    "sectors": []
                }

            sector_neighbors = []
            for n in neighbors:
                target_site_id = n.target_enodeb_id
                target_cell_id = n.target_key[len(target_site_id) + 1:]
                target_site_name = f"Site_{target_site_id}"
                sector_neighbors.append({
                    "targetSector": n.target_key,
                    "targetSectorName": n.target_cell_name,
                    "targetSite": target_site_id,
                    "targetSiteName": target_site_name,
                    "distance": n.distance,
                    "bearing": n.angle_diff if n.angle_diff else 0,
                    "relationType": relation_type
                })
                flat_results.append({
                    "relationType": relation_type,
                    "sourceSiteId": source_site_id,  # 对应前端的 siteId
                    "sourceCellId": source_cell_id,  # 对应前端的 sectorId
                    "sourceCellName": n.source_cell_name,
                    "sourcePci": source_pci,
                    "sourceFrequency": source_earfcn,
                    "targetSiteId": target_site_id,  # 对应前端的 siteId
                    "targetCellId": target_cell_id,  # 对应前端的 sectorId
                    "targetCellName": n.target_cell_name,
                    "targetPci": _int_or_none(n.target_pci),
                    "targetFrequency": _int_or_none(n.target_earfcn),
                    "distance": n.distance,
                    "bearing": n.angle_diff
                })

            total_neighbors += len(neighbors)
            if neighbors:
                unique_source_sites.add(site_id)
            results_by_site[site_id]["sectors"].append({
                "sectorId": sector_id,
                "sectorName": cell_name,
                "neighbors": sector_neighbors,
                "neighborCount": len(sector_neighbors)
            })

        avg_neighbors = total_neighbors / total_cells if total_cells > 0 else 0.0

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


def run_same_freq_adjacency(
    config: NeighborConfig,
    source_sites: List[Dict],
    target_sites: List[Dict],
    progress_callback: Optional[Callable[[float], Any]] = None,
) -> Dict[str, List[str]]:
    """内存预规划并只返回同频邻接表，供 PCI 核查等只关心邻接关系的场景使用"""
    return NeighborPlanner(config).plan_same_freq_adjacency(
        source_sites, target_sites, progress_callback
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
