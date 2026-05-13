"""
PCI规划服务
"""
import random
import math
from typing import List, Dict, Optional, Tuple, Callable, Awaitable
from dataclasses import dataclass, field
from enum import Enum
import asyncio

from app.algorithms.distance_calculator import DistanceCalculator, Point
from app.algorithms.pci_collision_detector import (
    PCICollisionDetector,
    PCIConflict,
    SectorInfo,
    ConflictType
)
from app.models.schemas import NetworkType


@dataclass
class PlanningConfig:
    """规划配置"""
    network_type: NetworkType
    distance_threshold: float = 3.0  # 距离阈值，单位：公里
    pci_modulus: int = 3  # PCI模数（3或30）
    enable_collision_check: bool = True
    enable_confusion_check: bool = True

    # PCI范围
    LTE_MIN_PCI = 0
    LTE_MAX_PCI = 503
    NR_MIN_PCI = 0
    NR_MAX_PCI = 1007


@dataclass
class SiteSectorInfo:
    """站点小区信息"""
    id: str
    site_id: str
    name: str
    longitude: float
    latitude: float
    azimuth: float
    beamwidth: float = 65.0
    height: float = 30.0
    pci: Optional[int] = None


@dataclass
class SectorPlanningResult:
    """小区规划结果"""
    sector_id: str
    sector_name: str
    original_pci: Optional[int]
    new_pci: int
    collision_count: int = 0
    confusion_count: int = 0
    conflicts: List[PCIConflict] = field(default_factory=list)


@dataclass
class SitePlanningResult:
    """站点规划结果"""
    site_id: str
    site_name: str
    sectors: List[SectorPlanningResult]
    total_collisions: int = 0
    total_confusions: int = 0


@dataclass
class PCIPlanningResult:
    """PCI规划结果"""
    task_id: str
    status: str
    total_sites: int
    total_sectors: int
    total_collisions: int
    total_confusions: int
    sites: List[SitePlanningResult]
    progress: float = 0.0


class PCIPlanningService:
    """PCI规划服务"""

    def __init__(self, config: PlanningConfig):
        self.config = config
        self.detector = PCICollisionDetector(distance_threshold=config.distance_threshold)

    def _get_pci_range(self) -> Tuple[int, int]:
        """获取PCI范围"""
        if self.config.network_type == NetworkType.LTE:
            return self.config.LTE_MIN_PCI, self.config.LTE_MAX_PCI
        else:
            return self.config.NR_MIN_PCI, self.config.NR_MAX_PCI

    def _convert_to_sector_info(self, sectors: List[SiteSectorInfo]) -> List[SectorInfo]:
        """转换为SectorInfo"""
        return [
            SectorInfo(
                id=s.id,
                site_id=s.site_id,
                name=s.name,
                longitude=s.longitude,
                latitude=s.latitude,
                azimuth=s.azimuth,
                beamwidth=s.beamwidth,
                pci=s.pci if s.pci is not None else -1
            )
            for s in sectors
        ]

    def _analyze_neighbors(
        self,
        target_sector: SiteSectorInfo,
        all_sectors: List[SiteSectorInfo]
    ) -> List[SiteSectorInfo]:
        """分析邻区关系"""
        neighbors = []
        target_point = Point(target_sector.longitude, target_sector.latitude)

        for sector in all_sectors:
            if sector.id == target_sector.id:
                continue

            distance = DistanceCalculator.calculate_distance(
                target_sector.longitude, target_sector.latitude,
                sector.longitude, sector.latitude
            )

            # 在距离阈值内的是邻区
            if distance <= self.config.distance_threshold:
                neighbors.append(sector)

        return neighbors

    def _assign_pci_greedy(
        self,
        sector: SiteSectorInfo,
        assigned_sectors: List[SectorInfo],
        all_sectors: List[SiteSectorInfo]
    ) -> int:
        """使用贪心算法分配PCI"""
        min_pci, max_pci = self._get_pci_range()
        modulus = self.config.pci_modulus

        # 获取邻区
        neighbors = self._analyze_neighbors(sector, all_sectors)

        # 收集邻区已使用的PCI
        used_pci = set()
        used_mod = set()

        for neighbor in neighbors:
            if neighbor.pci is not None:
                used_pci.add(neighbor.pci)
                used_mod.add(neighbor.pci % modulus)

        # 尝试分配PCI
        for pci in range(min_pci, max_pci + 1):
            # 检查PCI是否已被使用
            if pci in used_pci:
                continue

            # 检查模冲突
            if pci % modulus in used_mod:
                continue

            return pci

        # 如果没有找到，随机分配一个可用的
        available = [pci for pci in range(min_pci, max_pci + 1) if pci not in used_pci]
        if available:
            return random.choice(available)

        # 最后的选择：随机分配
        return random.randint(min_pci, max_pci)

    def _assign_pci_with_mod(
        self,
        sector: SiteSectorInfo,
        assigned_sectors: List[SectorInfo],
        all_sectors: List[SiteSectorInfo],
        preferred_mod: int
    ) -> int:
        """使用指定模数分配PCI"""
        min_pci, max_pci = self._get_pci_range()
        modulus = self.config.pci_modulus

        # 获取邻区
        neighbors = self._analyze_neighbors(sector, all_sectors)
        used_pci = set(s.pci for s in neighbors if s.pci is not None)

        # 优先选择指定模数的PCI
        for pci in range(preferred_mod, max_pci + 1, modulus):
            if pci not in used_pci:
                return pci

        # 如果没有找到，选择其他可用的
        for pci in range(min_pci, max_pci + 1):
            if pci not in used_pci:
                return pci

        return random.randint(min_pci, max_pci)

    async def plan(
        self,
        sites_data: List[Dict],
        progress_callback: Optional[Callable[[float], Awaitable[None]]] = None
    ) -> PCIPlanningResult:
        """
        执行PCI规划

        Args:
            sites_data: 站点数据列表
            progress_callback: 进度回调函数

        Returns:
            规划结果
        """
        task_id = f"pci_{random.randint(10000, 99999)}"

        # 解析数据
        all_sectors = []
        for site in sites_data:
            for sector_data in site.get('sectors', []):
                all_sectors.append(SiteSectorInfo(
                    id=sector_data.get('id', ''),
                    site_id=site.get('id', ''),
                    name=sector_data.get('name', ''),
                    longitude=sector_data.get('longitude', 0),
                    latitude=sector_data.get('latitude', 0),
                    azimuth=sector_data.get('azimuth', 0),
                    beamwidth=sector_data.get('beamwidth', 65),
                    height=sector_data.get('height', 30),
                    pci=sector_data.get('pci')
                ))

        total_sectors = len(all_sectors)
        total_sites = len(sites_data)

        # 按站点分组
        site_sectors: Dict[str, List[SiteSectorInfo]] = {}
        for sector in all_sectors:
            if sector.site_id not in site_sectors:
                site_sectors[sector.site_id] = []
            site_sectors[sector.site_id].append(sector)

        # 规划结果
        site_results: List[SitePlanningResult] = []
        total_collisions = 0
        total_confusions = 0

        # 为每个小区分配PCI
        assigned_sectors: List[SectorInfo] = []
        processed = 0

        for site_id, sectors in site_sectors.items():
            site_name = sectors[0].site_id if sectors else site_id
            sector_results: List[SectorPlanningResult] = []

            # 按方位角排序，优先分配
            sectors.sort(key=lambda s: s.azimuth)

            for i, sector in enumerate(sectors):
                # 分配PCI
                if self.config.pci_modulus == 3:
                    # 3个扇区，分别使用模3余0、1、2
                    preferred_mod = i % 3
                    new_pci = self._assign_pci_with_mod(
                        sector, assigned_sectors, all_sectors, preferred_mod
                    )
                else:
                    new_pci = self._assign_pci_greedy(sector, assigned_sectors, all_sectors)

                # 更新小区PCI
                original_pci = sector.pci
                sector.pci = new_pci

                # 创建结果
                sector_info = SectorInfo(
                    id=sector.id,
                    site_id=sector.site_id,
                    name=sector.name,
                    longitude=sector.longitude,
                    latitude=sector.latitude,
                    azimuth=sector.azimuth,
                    beamwidth=sector.beamwidth,
                    pci=new_pci
                )
                assigned_sectors.append(sector_info)

                # 检测冲突
                conflicts = self.detector.detect_all(
                    assigned_sectors,
                    self.config.enable_collision_check,
                    self.config.enable_confusion_check
                )

                collision_count = sum(1 for c in conflicts if c.type == ConflictType.COLLISION)
                confusion_count = sum(1 for c in conflicts if c.type == ConflictType.CONFUSION)

                sector_results.append(SectorPlanningResult(
                    sector_id=sector.id,
                    sector_name=sector.name,
                    original_pci=original_pci,
                    new_pci=new_pci,
                    collision_count=collision_count,
                    confusion_count=confusion_count,
                    conflicts=[c for c in conflicts if c.sector1 == sector.id or c.sector2 == sector.id]
                ))

                processed += 1
                if progress_callback:
                    await progress_callback(processed / total_sectors * 100)

            # 统计站点冲突
            site_collisions = sum(s.collision_count for s in sector_results)
            site_confusions = sum(s.confusion_count for s in sector_results)

            total_collisions += site_collisions
            total_confusions += site_confusions

            site_results.append(SitePlanningResult(
                site_id=site_id,
                site_name=site_name,
                sectors=sector_results,
                total_collisions=site_collisions,
                total_confusions=site_confusions
            ))

        return PCIPlanningResult(
            task_id=task_id,
            status="completed",
            total_sites=total_sites,
            total_sectors=total_sectors,
            total_collisions=total_collisions,
            total_confusions=total_confusions,
            sites=site_results,
            progress=100.0
        )

    def optimize_pci(
        self,
        sectors: List[SiteSectorInfo],
        max_iterations: int = 100
    ) -> List[SiteSectorInfo]:
        """
        优化PCI分配（使用模拟退火算法）

        Args:
            sectors: 小区列表
            max_iterations: 最大迭代次数

        Returns:
            优化后的小区列表
        """
        min_pci, max_pci = self._get_pci_range()

        # 初始温度
        temperature = 100.0
        cooling_rate = 0.95

        best_sectors = sectors.copy()
        best_conflicts = float('inf')

        for iteration in range(max_iterations):
            # 随机选择一个小区，改变其PCI
            sector_index = random.randint(0, len(sectors) - 1)
            old_pci = sectors[sector_index].pci

            # 随机选择新PCI
            new_pci = random.randint(min_pci, max_pci)
            sectors[sector_index].pci = new_pci

            # 计算冲突数
            sector_infos = self._convert_to_sector_info(sectors)
            conflicts = self.detector.count_conflicts(
                sector_infos,
                self.config.enable_collision_check,
                self.config.enable_confusion_check
            )
            total_conflicts = conflicts['total']

            # 如果更好，接受
            if total_conflicts < best_conflicts:
                best_conflicts = total_conflicts
                best_sectors = sectors.copy()
            else:
                # 以一定概率接受
                probability = math.exp(-(total_conflicts - best_conflicts) / temperature)
                if random.random() > probability:
                    sectors[sector_index].pci = old_pci  # 撤销

            # 降温
            temperature *= cooling_rate

        return best_sectors


async def run_pci_planning(
    config: PlanningConfig,
    sites_data: List[Dict],
    progress_callback: Optional[Callable[[float], Awaitable[None]]] = None
) -> Dict:
    """
    运行PCI规划

    Args:
        config: 规划配置
        sites_data: 站点数据
        progress_callback: 进度回调

    Returns:
        规划结果字典
    """
    service = PCIPlanningService(config)
    result = await service.plan(sites_data, progress_callback)

    return {
        "taskId": result.task_id,
        "status": result.status,
        "progress": result.progress,
        "totalSites": result.total_sites,
        "totalSectors": result.total_sectors,
        "collisions": result.total_collisions,
        "confusions": result.total_confusions,
        "results": [
            {
                "siteId": site.site_id,
                "siteName": site.site_name,
                "sectors": [
                    {
                        "sectorId": s.sector_id,
                        "sectorName": s.sector_name,
                        "originalPCI": s.original_pci,
                        "newPCI": s.new_pci,
                        "collisionCount": s.collision_count,
                        "confusionCount": s.confusion_count
                    }
                    for s in site.sectors
                ],
                "totalCollisions": site.total_collisions,
                "totalConfusions": site.total_confusions
            }
            for site in result.sites
        ]
    }
