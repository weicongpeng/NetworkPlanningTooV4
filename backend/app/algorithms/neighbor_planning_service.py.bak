"""
邻区规划服务
"""
import math
from typing import List, Dict, Optional, Tuple, Set, Callable, Awaitable
from dataclasses import dataclass, field
from enum import Enum
import asyncio

from app.algorithms.distance_calculator import DistanceCalculator, Point
from app.models.schemas import NetworkType


class RelationType(str, Enum):
    """邻区关系类型"""
    LTE_LTE = "LTE-LTE"
    LTE_NR = "LTE-NR"
    NR_LTE = "NR-LTE"
    NR_NR = "NR-NR"


@dataclass
class NeighborConfig:
    """邻区规划配置"""
    source_type: NetworkType
    target_type: NetworkType
    max_distance: float = 10.0  # 最大距离，单位：公里
    max_neighbors: int = 32  # 最大邻区数
    min_neighbors: int = 0  # 最小邻区数


@dataclass
class SectorInfo:
    """小区信息"""
    id: str
    site_id: str
    name: str
    longitude: float
    latitude: float
    azimuth: float
    beamwidth: float = 65.0
    height: float = 30.0
    pci: Optional[int] = None
    earfcn: Optional[int] = None
    arfcn: Optional[int] = None
    network_type: NetworkType = NetworkType.LTE


@dataclass
class NeighborRelation:
    """邻区关系"""
    source_sector: str
    source_sector_name: str
    target_sector: str
    target_sector_name: str
    target_site: str
    target_site_name: str
    distance: float
    bearing: float  # 方位角，单位：度
    relation_type: RelationType


@dataclass
class SectorNeighborResult:
    """小区邻区结果"""
    sector_id: str
    sector_name: str
    neighbors: List[NeighborRelation]
    neighbor_count: int = 0


@dataclass
class SiteNeighborResult:
    """站点邻区结果"""
    site_id: str
    site_name: str
    sectors: List[SectorNeighborResult]
    total_neighbors: int = 0


@dataclass
class NeighborPlanningResult:
    """邻区规划结果"""
    task_id: str
    status: str
    total_sites: int
    total_sectors: int
    total_neighbors: int
    avg_neighbors: float
    sites: List[SiteNeighborResult]
    progress: float = 0.0


class NeighborPlanningService:
    """邻区规划服务"""

    def __init__(self, config: NeighborConfig):
        self.config = config
        self.relation_type = self._get_relation_type()

    def _get_relation_type(self) -> RelationType:
        """获取关系类型"""
        if self.config.source_type == NetworkType.LTE and self.config.target_type == NetworkType.LTE:
            return RelationType.LTE_LTE
        elif self.config.source_type == NetworkType.LTE and self.config.target_type == NetworkType.NR:
            return RelationType.LTE_NR
        elif self.config.source_type == NetworkType.NR and self.config.target_type == NetworkType.LTE:
            return RelationType.NR_LTE
        else:
            return RelationType.NR_NR

    def _calculate_neighbor_score(
        self,
        source: SectorInfo,
        target: SectorInfo,
        distance: float,
        bearing: float
    ) -> float:
        """
        计算邻区得分（用于排序）

        Args:
            source: 源小区
            target: 目标小区
            distance: 距离
            bearing: 方位角

        Returns:
            得分，越高越优先
        """
        score = 0.0

        # 距离得分（距离越近得分越高）
        if distance < 1:
            score += 100
        elif distance < 3:
            score += 80
        elif distance < 5:
            score += 60
        elif distance < 10:
            score += 40
        else:
            score += 20

        # 方向得分（考虑扇区朝向）
        angle_diff = abs(bearing - source.azimuth)
        if angle_diff > 180:
            angle_diff = 360 - angle_diff

        # 在扇区波束宽度内，加分
        if angle_diff <= source.beamwidth / 2:
            score += 50
        elif angle_diff <= source.beamwidth:
            score += 30
        elif angle_diff <= 120:
            score += 10

        # 频率得分（同频优先）
        if self.config.source_type == self.config.target_type:
            if source.earfcn and target.earfcn and source.earfcn == target.earfcn:
                score += 20
            if source.arfcn and target.arfcn and source.arfcn == target.arfcn:
                score += 20

        return score

    def _filter_by_direction(
        self,
        source: SectorInfo,
        target: SectorInfo,
        bearing: float
    ) -> bool:
        """
        按方向过滤邻区

        Args:
            source: 源小区
            target: 目标小区
            bearing: 方位角

        Returns:
            是否符合方向要求
        """
        # 计算与扇区朝向的角度差
        angle_diff = abs(bearing - source.azimuth)
        if angle_diff > 180:
            angle_diff = 360 - angle_diff

        # 在扇区波束宽度内，或者角度差小于120度
        return angle_diff <= max(source.beamwidth, 120)

    def _find_neighbors_for_sector(
        self,
        source: SectorInfo,
        all_sectors: List[SectorInfo]
    ) -> List[NeighborRelation]:
        """
        为指定小区查找邻区

        Args:
            source: 源小区
            all_sectors: 所有小区列表

        Returns:
            邻区关系列表
        """
        source_point = Point(source.longitude, source.latitude)
        candidates = []

        # 筛选候选邻区
        for target in all_sectors:
            # 跳过自己
            if target.id == source.id:
                continue

            # 网络类型过滤
            if NetworkType(target.network_type) != self.config.target_type:
                continue

            # 计算距离
            distance = DistanceCalculator.calculate_distance(
                source.longitude, source.latitude,
                target.longitude, target.latitude
            )

            # 距离过滤
            if distance > self.config.max_distance:
                continue

            # 计算方位角
            bearing = DistanceCalculator.calculate_bearing(source_point, Point(target.longitude, target.latitude))

            # 方向过滤
            if not self._filter_by_direction(source, target, bearing):
                continue

            # 计算得分
            score = self._calculate_neighbor_score(source, target, distance, bearing)

            candidates.append({
                'target': target,
                'distance': distance,
                'bearing': bearing,
                'score': score
            })

        # 按得分排序
        candidates.sort(key=lambda x: x['score'], reverse=True)

        # 限制数量
        neighbors = []
        for candidate in candidates[:self.config.max_neighbors]:
            target = candidate['target']
            neighbors.append(NeighborRelation(
                source_sector=source.id,
                source_sector_name=source.name,
                target_sector=target.id,
                target_sector_name=target.name,
                target_site=target.site_id,
                target_site_name=target.site_id,
                distance=round(candidate['distance'], 2),
                bearing=round(candidate['bearing'], 1),
                relation_type=self.relation_type
            ))

        return neighbors

    def _add_co_site_neighbors(
        self,
        neighbors: List[NeighborRelation],
        source: SectorInfo,
        all_sectors: List[SectorInfo]
    ) -> List[NeighborRelation]:
        """
        添加同站邻区

        Args:
            neighbors: 现有邻区列表
            source: 源小区
            all_sectors: 所有小区列表

        Returns:
            更新后的邻区列表
        """
        # 找到同站的其他小区
        existing_target_ids = set(n.target_sector for n in neighbors)

        for sector in all_sectors:
            if sector.site_id == source.site_id and sector.id != source.id:
                if sector.id not in existing_target_ids:
                    # 计算距离（同站距离很小）
                    distance = DistanceCalculator.calculate_distance(
                        source.longitude, source.latitude,
                        sector.longitude, sector.latitude
                    )

                    neighbors.append(NeighborRelation(
                        source_sector=source.id,
                        source_sector_name=source.name,
                        target_sector=sector.id,
                        target_sector_name=sector.name,
                        target_site=sector.site_id,
                        target_site_name=sector.site_id,
                        distance=round(distance, 2),
                        bearing=round(abs(source.azimuth - sector.azimuth), 1),
                        relation_type=self.relation_type
                    ))

                    if len(neighbors) >= self.config.max_neighbors:
                        break

        return neighbors

    async def plan(
        self,
        sites_data: List[Dict],
        progress_callback: Optional[Callable[[float], Awaitable[None]]] = None
    ) -> NeighborPlanningResult:
        """
        执行邻区规划

        Args:
            sites_data: 站点数据列表
            progress_callback: 进度回调函数

        Returns:
            规划结果
        """
        task_id = f"neighbor_{asyncio.get_event_loop().time()}"

        # 解析数据
        source_sectors = []
        target_sectors = []

        for site in sites_data:
            for sector_data in site.get('sectors', []):
                sector = SectorInfo(
                    id=sector_data.get('id', ''),
                    site_id=site.get('id', ''),
                    name=sector_data.get('name', ''),
                    longitude=sector_data.get('longitude', 0),
                    latitude=sector_data.get('latitude', 0),
                    azimuth=sector_data.get('azimuth', 0),
                    beamwidth=sector_data.get('beamwidth', 65),
                    height=sector_data.get('height', 30),
                    pci=sector_data.get('pci'),
                    earfcn=sector_data.get('earfcn'),
                    arfcn=sector_data.get('arfcn'),
                    network_type=NetworkType(site.get('networkType', 'LTE'))
                )

                # 根据类型分类
                if NetworkType(site.get('networkType', 'LTE')) == self.config.source_type:
                    source_sectors.append(sector)

                if NetworkType(site.get('networkType', 'LTE')) == self.config.target_type:
                    target_sectors.append(sector)

        if not source_sectors:
            raise ValueError(f"没有找到{self.config.source_type.value}类型的源小区")

        if not target_sectors:
            raise ValueError(f"没有找到{self.config.target_type.value}类型的目标小区")

        # 按站点分组
        site_sectors: Dict[str, List[SectorInfo]] = {}
        for sector in source_sectors:
            if sector.site_id not in site_sectors:
                site_sectors[sector.site_id] = []
            site_sectors[sector.site_id].append(sector)

        # 规划结果
        site_results: List[SiteNeighborResult] = []
        total_neighbors = 0
        processed = 0
        total_sectors = len(source_sectors)

        # 为每个小区查找邻区
        for site_id, sectors in site_sectors.items():
            sector_results: List[SectorNeighborResult] = []

            for sector in sectors:
                # 查找邻区
                neighbors = self._find_neighbors_for_sector(sector, target_sectors)

                # 添加同站邻区
                neighbors = self._add_co_site_neighbors(neighbors, sector, target_sectors)

                # 确保至少有最小数量的邻区
                if len(neighbors) < self.config.min_neighbors:
                    # 补充最近的邻区
                    all_neighbors = self._find_neighbors_for_sector(sector, target_sectors)
                    while len(neighbors) < self.config.min_neighbors and len(all_neighbors) > len(neighbors):
                        for n in all_neighbors:
                            if n.target_sector not in [nn.target_sector for nn in neighbors]:
                                neighbors.append(n)
                                break

                sector_results.append(SectorNeighborResult(
                    sector_id=sector.id,
                    sector_name=sector.name,
                    neighbors=neighbors,
                    neighbor_count=len(neighbors)
                ))

                total_neighbors += len(neighbors)
                processed += 1

                if progress_callback:
                    await progress_callback(processed / total_sectors * 100)

            # 统计站点邻区数
            site_total = sum(s.neighbor_count for s in sector_results)
            site_results.append(SiteNeighborResult(
                site_id=site_id,
                site_name=sectors[0].site_id if sectors else site_id,
                sectors=sector_results,
                total_neighbors=site_total
            ))

        return NeighborPlanningResult(
            task_id=task_id,
            status="completed",
            total_sites=len(site_sectors),
            total_sectors=total_sectors,
            total_neighbors=total_neighbors,
            avg_neighbors=round(total_neighbors / total_sectors, 2) if total_sectors > 0 else 0,
            sites=site_results,
            progress=100.0
        )


async def run_neighbor_planning(
    config: NeighborConfig,
    sites_data: List[Dict],
    progress_callback: Optional[Callable[[float], Awaitable[None]]] = None
) -> Dict:
    """
    运行邻区规划

    Args:
        config: 规划配置
        sites_data: 站点数据
        progress_callback: 进度回调

    Returns:
        规划结果字典
    """
    service = NeighborPlanningService(config)
    result = await service.plan(sites_data, progress_callback)

    return {
        "taskId": result.task_id,
        "status": result.status,
        "progress": result.progress,
        "totalSites": result.total_sites,
        "totalSectors": result.total_sectors,
        "totalNeighbors": result.total_neighbors,
        "avgNeighbors": result.avg_neighbors,
        "results": [
            {
                "siteId": site.site_id,
                "siteName": site.site_name,
                "sectors": [
                    {
                        "sectorId": s.sector_id,
                        "sectorName": s.sector_name,
                        "neighbors": [
                            {
                                "sourceSector": n.source_sector,
                                "sourceSectorName": n.source_sector_name,
                                "targetSector": n.target_sector,
                                "targetSectorName": n.target_sector_name,
                                "targetSite": n.target_site,
                                "targetSiteName": n.target_site_name,
                                "distance": n.distance,
                                "bearing": n.bearing,
                                "relationType": n.relation_type.value
                            }
                            for n in s.neighbors
                        ],
                        "neighborCount": s.neighbor_count
                    }
                    for s in site.sectors
                ],
                "totalNeighbors": site.total_neighbors
            }
            for site in result.sites
        ]
    }
