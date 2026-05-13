"""
邻区规划服务 V1 - 基于NetworkPlanningTool_V1.py的覆盖圆算法
实现智能邻区选择：
1. 覆盖圆相交判断 - 判断两小区覆盖范围是否重叠
2. 智能评分选择 - 基于距离和方位角评分
3. 扇区分布均衡 - 确保邻区来自不同方向
"""

import math
import uuid
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


@dataclass
class NeighborConfig:
    """邻区规划配置"""
    source_type: str  # "LTE" 或 "NR"
    target_type: str  # "LTE" 或 "NR"
    max_neighbors: int = 64  # 最大邻区数
    coverage_distance_factor: float = 1.0  # 覆盖圆距离系数
    coverage_radius_factor: float = 1.0  # 覆盖圆半径系数


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
        
        # 默认覆盖距离（米）
        self.default_coverage_distance = 1000.0
        
        # 数据存储
        self.source_cells_df = None
        self.target_cells_df = None
        
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
    
    def calculate_distance(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """计算两点之间的距离（公里）"""
        lat1_rad = math.radians(lat1)
        lon1_rad = math.radians(lon1)
        lat2_rad = math.radians(lat2)
        lon2_rad = math.radians(lon2)
        
        dlat = lat2_rad - lat1_rad
        dlon = lon2_rad - lon1_rad
        a = math.sin(dlat/2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon/2)**2
        c = 2 * math.asin(math.sqrt(a))
        
        return c * 6371
    
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
        计算邻区评分 - 评分越高优先级越高
        主要考虑：
        1. 对打邻区（主小区朝向的邻区）优先级更高
        2. 距离越近评分越高
        3. 方向角匹配度越好评分越高

        Args:
            distance: 距离（公里）
            angle_diff: 角度差（已废弃，仅保留兼容性）
            facing_diff: 主小区方位角与目标小区背向角度差（对打关系）
            pointing_diff: 目标小区方位角与主小区方向的角度差（内向关系）
            is_forward_cell: 是否为对打邻区（主小区朝向的邻区）
        """
        # 距离评分（距离越近分数越高）
        distance_score = max(0, 10 - distance)

        # 方向角评分
        if facing_diff is not None and pointing_diff is not None:
            # 对打邻区（主小区朝向的目标小区）评分更高
            # facing_diff: 目标小区背向与主小区方位角差（对打关系）
            # pointing_diff: 目标小区朝向与主小区位置差（内向关系）
            if is_forward_cell:
                # 对打邻区：优先考虑 facing_diff
                angle_score = max(0, (180 - facing_diff) / 18)  # 0-10分
                # 对打邻区额外加分
                angle_score += 3
            else:
                # 内向邻区：考虑 pointing_diff，但评分打折
                angle_score = max(0, (180 - pointing_diff) / 18) * 0.6  # 0-6分
        elif angle_diff is not None:
            angle_score = max(0, (180 - angle_diff) / 18)  # 0-10分
        else:
            angle_score = 5  # 无方向角信息时给中等分

        return distance_score + angle_score
    
    def get_cell_key(self, row: pd.Series) -> str:
        """获取小区唯一标识"""
        return f"{row['enodeb_id']}_{row['cell_id']}"
    
    def calculate_site_spacing(self, source_row: pd.Series) -> float:
        """
        计算站间距：待规划小区到周边最近5个室外站点的平均距离

        规则：
        1. 只考虑室外站点（室分站点不参加计算）
        2. 100米内的小区都算同站点，这些站点不计入
        3. 取最近5个站点的平均距离作为站间距

        Returns:
            站间距（公里），如果无法计算则返回默认值 0.5
        """
        if self.target_cells_df is None or self.target_cells_df.empty:
            return 0.5  # 默认站间距 500米

        source_lat = source_row.get('lat')
        source_lon = source_row.get('lon')
        source_enodeb_id = str(source_row.get('enodeb_id', ''))

        if pd.isna(source_lat) or pd.isna(source_lon):
            return 0.5

        # 收集所有室外站点距离（按站点去重，100米内算同站点）
        site_distances = []

        for _, target_row in self.target_cells_df.iterrows():
            target_lat = target_row.get('lat')
            target_lon = target_row.get('lon')
            target_enodeb_id = str(target_row.get('enodeb_id', ''))

            if pd.isna(target_lat) or pd.isna(target_lon):
                continue

            # 跳过自身站点
            if source_enodeb_id == target_enodeb_id:
                continue

            # 检查是否是室分站点（cell_cover_type=4表示室内小区）
            cell_cover_type = target_row.get('cell_cover_type')
            if cell_cover_type == 4:
                continue

            # 计算距离
            distance = self.calculate_distance(source_lat, source_lon, target_lat, target_lon)

            # 100米内算同站点，不计入
            if distance < 0.1:  # 0.1公里 = 100米
                continue

            site_distances.append({
                'enodeb_id': target_enodeb_id,
                'distance': distance
            })

        if not site_distances:
            return 0.5  # 默认站间距

        # 按站点ID去重，保留每个站点的最小距离
        site_min_distances = {}
        for site_info in site_distances:
            site_id = site_info['enodeb_id']
            dist = site_info['distance']
            if site_id not in site_min_distances or dist < site_min_distances[site_id]:
                site_min_distances[site_id] = dist

        # 获取所有站点距离并排序
        unique_distances = sorted(site_min_distances.values())

        # 取最近5个站点的平均距离作为站间距
        nearest_5 = unique_distances[:5]
        avg_spacing = sum(nearest_5) / len(nearest_5) if nearest_5 else 0.5

        logger.debug(f"站间距计算: 源站点={source_enodeb_id}, 最近{len(nearest_5)}个站点, 平均距离={avg_spacing:.3f}km")

        return avg_spacing

    def plan_neighbors_for_cell(self, source_row: pd.Series) -> List[NeighborRelation]:
        """为单个源小区规划邻区 - 三步骤筛选逻辑

        筛选步骤：
        第一步：距离优先选择（强制邻区，无需后续筛选）
           - 室外-室外：300米内站点的所有小区作为邻区
           - 室分到室外/室外到室分：160米内

        第二步：使用最大邻区数、距离系数、半径系数筛选候选邻区
           - 对剩余候选使用覆盖圆相交判断

        第三步：根据站间距筛选候选邻区
           - 待规划小区到候选邻区距离需小于1.8倍站间距
           - 站间距计算时室分小区不参与，只计算室外小区之间的距离

        最终结果 = 第一步 + 第二步 + 第三步的合集（去重）
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
        step1_remaining_candidates = []  # 剩余候选

        for _, target_row in self.target_cells_df.iterrows():
            target_key = self.get_cell_key(target_row)

            # 跳过自身
            if source_key == target_key:
                continue

            target_lat = target_row.get('lat')
            target_lon = target_row.get('lon')
            target_cover_type = target_row.get('cell_cover_type', 1)
            is_target_indoor = (target_cover_type == 4)

            if pd.isna(target_lat) or pd.isna(target_lon):
                continue

            # 计算距离
            distance = self.calculate_distance(source_lat, source_lon, target_lat, target_lon)

            # 规则1：室外-室外300米内站点的所有小区作为邻区
            if not is_source_indoor and not is_target_indoor:
                if distance <= 0.30:  # 300米
                    step1_forced_neighbors.append((target_row, distance))
                    forced_neighbor_keys.add(target_key)
                    continue

            # 规则2：室分到室外/室外到室分160米内
            if (is_source_indoor and not is_target_indoor) or (not is_source_indoor and is_target_indoor):
                if distance <= 0.16:  # 160米
                    step1_forced_neighbors.append((target_row, distance))
                    forced_neighbor_keys.add(target_key)
                    continue

            # 其他情况进入剩余候选
            step1_remaining_candidates.append((target_row, distance))

        logger.debug(f"第一步距离筛选: 源小区={source_key}, 强制邻区={len(step1_forced_neighbors)}, 剩余候选={len(step1_remaining_candidates)}")

        # ========== 第二步：使用距离系数、半径系数筛选候选邻区 ==========
        # 对剩余候选使用覆盖圆相交判断
        step2_candidates = []

        # 获取源小区的覆盖圆
        if pd.notna(source_azimuth):
            source_center_lat, source_center_lon = self.calculate_coverage_circle_center(
                source_lat, source_lon, source_azimuth,
                self.coverage_distance_factor, self.default_coverage_distance
            )
        else:
            source_center_lat, source_center_lon = source_lat, source_lon

        source_radius = self.calculate_coverage_radius(
            self.default_coverage_distance, self.coverage_radius_factor
        )

        for target_row, distance in step1_remaining_candidates:
            target_key = self.get_cell_key(target_row)
            target_lat = target_row.get('lat')
            target_lon = target_row.get('lon')
            target_azimuth = target_row.get('azimuth')
            target_cover_type = target_row.get('cell_cover_type', 1)
            is_target_indoor = (target_cover_type == 4)

            # 室分到室分：限制160米以内
            if is_source_indoor and is_target_indoor:
                if distance <= 0.16:
                    step2_candidates.append((target_row, distance))
                continue

            # 获取目标小区的覆盖圆
            if pd.notna(target_azimuth):
                target_center_lat, target_center_lon = self.calculate_coverage_circle_center(
                    target_lat, target_lon, target_azimuth,
                    self.coverage_distance_factor, self.default_coverage_distance
                )
            else:
                target_center_lat, target_center_lon = target_lat, target_lon

            target_radius = self.calculate_coverage_radius(
                self.default_coverage_distance, self.coverage_radius_factor
            )

            # 判断覆盖圆是否相交
            is_intersecting = self.are_coverage_circles_intersecting(
                source_center_lat, source_center_lon, source_radius,
                target_center_lat, target_center_lon, target_radius
            )

            if is_intersecting:
                step2_candidates.append((target_row, distance))

        logger.debug(f"第二步覆盖圆筛选: 候选数={len(step2_candidates)}")

        # ========== 第三步：根据站间距筛选候选邻区 ==========
        # 待规划小区到候选邻区距离需小于1.8倍站间距
        # 站间距计算时室分小区不参与，只计算室外小区之间的距离
        step3_candidates = []

        if step2_candidates:
            # 计算站间距（只计算室外小区之间的距离，室分不参与）
            site_spacing = self.calculate_site_spacing(source_row)
            max_distance_threshold = 1.8 * site_spacing  # 1.8倍站间距

            logger.debug(f"第三步站间距筛选: 源小区={source_key}, 站间距={site_spacing:.3f}km, 阈值={max_distance_threshold:.3f}km")

            for target_row, distance in step2_candidates:
                target_key = self.get_cell_key(target_row)
                target_cover_type = target_row.get('cell_cover_type', 1)
                is_target_indoor = (target_cover_type == 4)

                # 室分到室分：已经在第二步限制在160米内，直接通过
                if is_source_indoor and is_target_indoor:
                    step3_candidates.append((target_row, distance))
                    continue

                # 室外小区：检查是否满足1.8倍站间距
                if distance < max_distance_threshold:
                    step3_candidates.append((target_row, distance))

        logger.debug(f"第三步站间距筛选后: 候选数={len(step3_candidates)}")

        # ========== 第四步：兜底逻辑 - 站点稀疏时的邻区补充 ==========
        # 当站点稀疏（周边站点数量少）时，按"距离 <= 平均站间距"添加兜底邻区
        # 规则：
        # 1. 如果候选邻区数量少于4个（或少于周边站点数），说明站点稀疏
        # 2. 从第一步剩余候选中（排除强制邻区后），对于满足距离 <= 平均站间距的候选小区，补充添加为邻区
        # 注意：这里直接从第一步剩余候选中筛选，因为第二步的覆盖圆判断可能过滤掉所有候选
        step4_fallback_neighbors = []

        if step1_remaining_candidates:
            # 计算第一步剩余候选中的站点数量
            unique_target_sites = set()
            for target_row, _ in step1_remaining_candidates:
                target_enodeb_id = str(target_row.get('enodeb_id', ''))
                unique_target_sites.add(target_enodeb_id)

            site_count = len(unique_target_sites)
            candidate_count = len(step3_candidates)

            # 触发条件：候选邻区数量少于4个，或少于周边站点数
            # 这两种情况都说明站点稀疏，需要兜底
            needs_fallback = candidate_count < min(4, site_count) if site_count > 0 else candidate_count < 4

            if needs_fallback:
                site_spacing = self.calculate_site_spacing(source_row)

                logger.debug(f"第四步兜底逻辑: 源小区={source_key}, 剩余候选站点数={site_count}, 第三步候选数={candidate_count}, 站间距={site_spacing:.3f}km")

                for target_row, distance in step1_remaining_candidates:
                    target_key = self.get_cell_key(target_row)
                    target_cover_type = target_row.get('cell_cover_type', 1)
                    is_target_indoor = (target_cover_type == 4)

                    # 跳过已在强制邻区中的
                    if target_key in forced_neighbor_keys:
                        continue

                    # 跳过室分到室分
                    if is_source_indoor and is_target_indoor:
                        continue

                    # 兜底条件：距离 <= 平均站间距
                    if distance <= site_spacing:
                        step4_fallback_neighbors.append((target_row, distance))

        logger.debug(f"第四步兜底逻辑后: 补充邻区数={len(step4_fallback_neighbors)}")

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
            if pd.notna(source_azimuth) and pd.notna(target_azimuth):
                facing_diff = self.calculate_angle_difference(source_azimuth, (target_azimuth + 180) % 360)
                pointing_diff = self.calculate_angle_difference(target_azimuth, source_to_target_azimuth)
                # 对打邻区判断：目标小区背向与主小区方位角差小于目标小区朝向与主小区位置差
                is_forward = facing_diff < pointing_diff
            else:
                is_forward = False

            # 强制邻区直接添加，保留原有评分逻辑（不受对打/内向影响）
            angle_diff = min(facing_diff, pointing_diff) if facing_diff is not None else None
            score = self.calculate_neighbor_score(distance, angle_diff)

            neighbor = NeighborRelation(
                source_key=source_key,
                target_key=target_key,
                distance=round(distance, 3),
                angle_diff=round(angle_diff, 1) if angle_diff else None,
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
            if pd.notna(source_azimuth) and pd.notna(target_azimuth):
                facing_diff = self.calculate_angle_difference(source_azimuth, (target_azimuth + 180) % 360)
                pointing_diff = self.calculate_angle_difference(target_azimuth, source_to_target_azimuth)
                # 对打邻区判断：facing_diff < pointing_diff 表示目标小区在主小区朝向方向
                is_forward = facing_diff < pointing_diff
            else:
                is_forward = False

            # 使用新的评分函数，对打邻区优先级更高
            angle_diff = min(facing_diff, pointing_diff) if facing_diff is not None else None
            score = self.calculate_neighbor_score(distance, angle_diff, facing_diff, pointing_diff, is_forward)

            neighbor = NeighborRelation(
                source_key=source_key,
                target_key=target_key,
                distance=round(distance, 3),
                angle_diff=round(angle_diff, 1) if angle_diff else None,
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

        # 候选邻区按评分排序并限制数量
        candidate_neighbors.sort(key=lambda x: x.score, reverse=True)
        # 候选邻区数量 = 最大邻区数 - 强制邻区数 - 兜底邻区数
        remaining_slots = max(0, self.max_neighbors - len(forced_neighbors) - len(step4_fallback_neighbors))
        selected_candidates = candidate_neighbors[:remaining_slots]

        # 构建兜底邻区列表
        fallback_neighbors = []
        fallback_keys = set()  # 记录兜底邻区的key，避免重复
        for target_row, distance in step4_fallback_neighbors:
            target_key = self.get_cell_key(target_row)
            target_azimuth = target_row.get('azimuth')

            source_to_target_azimuth = self.calculate_azimuth_angle(source_lat, source_lon, target_row['lat'], target_row['lon'])

            # 计算角度差
            facing_diff = None
            pointing_diff = None
            if pd.notna(source_azimuth) and pd.notna(target_azimuth):
                facing_diff = self.calculate_angle_difference(source_azimuth, (target_azimuth + 180) % 360)
                pointing_diff = self.calculate_angle_difference(target_azimuth, source_to_target_azimuth)
                # 对打邻区判断
                is_forward = facing_diff < pointing_diff
            else:
                is_forward = False

            # 使用新的评分函数，对打邻区优先级更高
            angle_diff = min(facing_diff, pointing_diff) if facing_diff is not None else None
            score = self.calculate_neighbor_score(distance, angle_diff, facing_diff, pointing_diff, is_forward)
            # 兜底邻区整体评分稍低
            score *= 0.8

            neighbor = NeighborRelation(
                source_key=source_key,
                target_key=target_key,
                distance=round(distance, 3),
                angle_diff=round(angle_diff, 1) if angle_diff else None,
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
            fallback_neighbors.append(neighbor)
            fallback_keys.add(target_key)

        # 最终结果 = 强制邻区 + 兜底邻区 + 选中的候选邻区
        final_neighbors = forced_neighbors + fallback_neighbors + selected_candidates

        logger.debug(f"最终结果: 强制邻区={len(forced_neighbors)}, 兜底邻区={len(fallback_neighbors)}, 候选邻区={len(selected_candidates)}, 总计={len(final_neighbors)}")

        return final_neighbors
    
    async def plan(self, source_sites: List[Dict], target_sites: List[Dict],
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
        
        # 为每个源小区规划邻区
        for idx, source_row in self.source_cells_df.iterrows():
            neighbors = self.plan_neighbors_for_cell(source_row)
            
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
            
            # 更新进度
            if progress_callback:
                progress = (idx + 1) / total_cells * 100
                await progress_callback(progress)
            
            # 手动交出控制权，避免阻塞事件循环
            if idx % 10 == 0:
                import asyncio
                await asyncio.sleep(0)
        
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


async def run_neighbor_planning(
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
    result = await planner.plan(
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
