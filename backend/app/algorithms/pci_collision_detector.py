"""
PCI冲突检测器
"""

from typing import List, Dict, Tuple, Set, Optional
from dataclasses import dataclass
from enum import Enum


class ConflictType(str, Enum):
    """冲突类型"""

    COLLISION = "collision"  # PCI冲突（相同PCI）
    CONFUSION = "confusion"  # PCI混淆（PCI模3/模30相同）
    MOD3_CONFLICT = "mod3_conflict"  # Mod3冲突（下行RS碰撞，2端口MIMO）
    MOD6_CONFLICT = "mod6_conflict"  # Mod6冲突（下行RS碰撞，单端口）
    MOD30_CONFLICT = "mod30_conflict"  # Mod30冲突（上行RS碰撞）


@dataclass
class PCIConflict:
    """PCI冲突信息"""

    type: ConflictType
    sector1: str  # 小区ID
    sector2: str  # 小区ID
    pci: int
    pci1: int  # 第一个小区的PCI
    pci2: int  # 第二个小区的PCI
    distance: float  # 距离，单位：公里
    reason: str
    frequency1: Optional[float] = None  # 第一个小区的频点
    frequency2: Optional[float] = None  # 第二个小区的频点
    is_same_frequency: bool = False  # 是否同频


@dataclass
class SectorInfo:
    """小区信息"""

    id: str
    site_id: str
    name: str
    longitude: float
    latitude: float
    azimuth: float
    beamwidth: float
    pci: int
    earfcn: Optional[float] = None  # 频点，用于判断同频


class PCICollisionDetector:
    """PCI冲突检测器"""

    def __init__(self, distance_threshold: float = 3.0):
        """
        初始化检测器

        Args:
            distance_threshold: 距离阈值，单位：公里
        """
        self.distance_threshold = distance_threshold

    def detect_all(
        self,
        sectors: List[SectorInfo],
        enable_collision: bool = True,
        enable_confusion: bool = True,
        enable_mod3: bool = True,
        enable_mod6: bool = False,
        enable_mod30: bool = True,
        check_same_frequency_only: bool = False,
    ) -> List[PCIConflict]:
        """
        检测所有PCI冲突

        Args:
            sectors: 小区列表
            enable_collision: 是否检测PCI冲突
            enable_confusion: 是否检测PCI混淆
            enable_mod3: 是否检测Mod3冲突（默认True，2端口MIMO）
            enable_mod6: 是否检测Mod6冲突（单端口系统）
            enable_mod30: 是否检测Mod30冲突（上行RS）
            check_same_frequency_only: 是否只检测同频小区冲突

        Returns:
            冲突列表
        """
        conflicts = []

        for i in range(len(sectors)):
            for j in range(i + 1, len(sectors)):
                sector1 = sectors[i]
                sector2 = sectors[j]

                # 计算距离
                from app.algorithms.distance_calculator import DistanceCalculator, Point

                distance = DistanceCalculator.calculate_distance(
                    sector1.longitude,
                    sector1.latitude,
                    sector2.longitude,
                    sector2.latitude,
                )

                # 只检查距离阈值内的小区
                if distance > self.distance_threshold:
                    continue

                # 判断是否同频（如果频点信息存在）
                is_same_frequency = True
                if hasattr(sector1, "earfcn") and hasattr(sector2, "earfcn"):
                    if sector1.earfcn is not None and sector2.earfcn is not None:
                        if abs(sector1.earfcn - sector2.earfcn) >= 0.1:
                            is_same_frequency = False

                # 如果只检查同频，且是异频，则跳过
                if check_same_frequency_only and not is_same_frequency:
                    continue

                # 检测PCI冲突
                if enable_collision and sector1.pci == sector2.pci:
                    conflicts.append(
                        PCIConflict(
                            type=ConflictType.COLLISION,
                            sector1=sector1.id,
                            sector2=sector2.id,
                            pci1=sector1.pci,
                            pci2=sector2.pci,
                            pci=sector1.pci,
                            distance=distance,
                            frequency1=getattr(sector1, "earfcn", None),
                            frequency2=getattr(sector2, "earfcn", None),
                            is_same_frequency=is_same_frequency,
                            reason=f"小区{sector1.name}和{sector2.name}使用相同PCI={sector1.pci}",
                        )
                    )

                # 检测Mod3冲突（下行RS碰撞，2端口MIMO）
                if enable_mod3 and is_same_frequency:
                    if sector1.pci % 3 == sector2.pci % 3:
                        conflicts.append(
                            PCIConflict(
                                type=ConflictType.MOD3_CONFLICT,
                                sector1=sector1.id,
                                sector2=sector2.id,
                                pci1=sector1.pci,
                                pci2=sector2.pci,
                                pci=sector1.pci,
                                distance=distance,
                                frequency1=getattr(sector1, "earfcn", None),
                                frequency2=getattr(sector2, "earfcn", None),
                                is_same_frequency=is_same_frequency,
                                reason=f"小区{sector1.name}和{sector2.name}的PCI模3相同({sector1.pci % 3}) - 下行RS碰撞（2端口MIMO）",
                            )
                        )

                # 检测Mod6冲突（下行RS碰撞，单端口）
                if enable_mod6 and is_same_frequency:
                    if sector1.pci % 6 == sector2.pci % 6:
                        conflicts.append(
                            PCIConflict(
                                type=ConflictType.MOD6_CONFLICT,
                                sector1=sector1.id,
                                sector2=sector2.id,
                                pci1=sector1.pci,
                                pci2=sector2.pci,
                                pci=sector1.pci,
                                distance=distance,
                                frequency1=getattr(sector1, "earfcn", None),
                                frequency2=getattr(sector2, "earfcn", None),
                                is_same_frequency=is_same_frequency,
                                reason=f"小区{sector1.name}和{sector2.name}的PCI模6相同({sector1.pci % 6}) - 下行RS碰撞（单端口）",
                            )
                        )

                # 检测Mod30冲突（上行RS碰撞）
                if enable_mod30 and is_same_frequency:
                    if sector1.pci % 30 == sector2.pci % 30:
                        conflicts.append(
                            PCIConflict(
                                type=ConflictType.MOD30_CONFLICT,
                                sector1=sector1.id,
                                sector2=sector2.id,
                                pci1=sector1.pci,
                                pci2=sector2.pci,
                                pci=sector1.pci,
                                distance=distance,
                                frequency1=getattr(sector1, "earfcn", None),
                                frequency2=getattr(sector2, "earfcn", None),
                                is_same_frequency=is_same_frequency,
                                reason=f"小区{sector1.name}和{sector2.name}的PCI模30相同({sector1.pci % 30}) - 上行RS碰撞",
                            )
                        )

        return conflicts

    def detect_collision(self, sectors: List[SectorInfo], pci: int) -> List[str]:
        """
        检测哪些小区与指定PCI冲突

        Args:
            sectors: 小区列表
            pci: 要检测的PCI

        Returns:
            冲突的小区ID列表
        """
        conflicts = []
        for sector in sectors:
            if sector.pci == pci:
                conflicts.append(sector.id)
        return conflicts

    def detect_confusion(
        self, sectors: List[SectorInfo], pci: int, modulus: int = 3
    ) -> List[str]:
        """
        检测哪些小区与指定PCI混淆

        Args:
            sectors: 小区列表
            pci: 要检测的PCI
            modulus: 模数（3或30）

        Returns:
            混淆的小区ID列表
        """
        confusions = []
        for sector in sectors:
            if sector.pci % modulus == pci % modulus:
                confusions.append(sector.id)
        return confusions

    def check_pci_availability(
        self,
        sectors: List[SectorInfo],
        pci: int,
        exclude_sector_id: str = None,
        modulus: int = 3,
        target_longitude: float = None,
        target_latitude: float = None,
    ) -> Tuple[bool, List[str]]:
        """
        检查PCI是否可用

        Args:
            sectors: 小区列表
            pci: 要检查的PCI
            exclude_sector_id: 排除的小区ID（用于检查当前小区）
            modulus: 模数
            target_longitude: 目标经度
            target_latitude: 目标纬度

        Returns:
            (是否可用, 冲突原因列表)
        """
        reasons = []

        # 过滤掉排除的小区
        check_sectors = [s for s in sectors if s.id != exclude_sector_id]

        for sector in check_sectors:
            # 计算距离
            from app.algorithms.distance_calculator import DistanceCalculator

            distance = DistanceCalculator.calculate_distance(
                target_longitude if target_longitude is not None else sector.longitude,
                target_latitude if target_latitude is not None else sector.latitude,
                sector.longitude,
                sector.latitude,
            )

            # 超过距离阈值的不检查
            if distance > self.distance_threshold:
                continue

            # 检查冲突
            if sector.pci == pci:
                reasons.append(f"与小区{sector.name}PCI冲突")
                continue

            # 检查混淆
            if sector.pci % modulus == pci % modulus:
                reasons.append(f"与小区{sector.name}PCI模{modulus}混淆")

        return len(reasons) == 0, reasons

    def get_available_pci_range(
        self,
        sectors: List[SectorInfo],
        min_pci: int = 0,
        max_pci: int = 503,
        modulus: int = 3,
        target_longitude: float = None,
        target_latitude: float = None,
    ) -> List[int]:
        """
        获取可用的PCI列表

        Args:
            sectors: 小区列表
            min_pci: 最小PCI值
            max_pci: 最大PCI值（LTE: 503, NR: 1007）
            modulus: 模数
            target_longitude: 目标经度（用于距离检查）
            target_latitude: 目标纬度（用于距离检查）

        Returns:
            可用的PCI列表
        """
        available = []
        occupied = set()

        # 收集已占用的PCI
        for sector in sectors:
            occupied.add(sector.pci)

        # 检查每个PCI
        for pci in range(min_pci, max_pci + 1):
            if pci not in occupied:
                # 检查模冲突
                has_conflict = False
                for sector in sectors:
                    if sector.pci % modulus == pci % modulus:
                        # 需要检查距离（只检查同模数的）
                        from app.algorithms.distance_calculator import (
                            DistanceCalculator,
                        )

                        distance = DistanceCalculator.calculate_distance(
                            target_longitude
                            if target_longitude is not None
                            else sector.longitude,
                            target_latitude
                            if target_latitude is not None
                            else sector.latitude,
                            sector.longitude,
                            sector.latitude,
                        )
                        if distance <= self.distance_threshold:
                            has_conflict = True
                            break

                if not has_conflict:
                    available.append(pci)

        return available

    def count_conflicts(
        self,
        sectors: List[SectorInfo],
        enable_collision: bool = True,
        enable_confusion: bool = True,
        enable_mod3: bool = True,
        enable_mod6: bool = False,
        enable_mod30: bool = True,
        check_same_frequency_only: bool = False,
    ) -> Dict[str, int]:
        """
        统计冲突数量

        Args:
            sectors: 小区列表
            enable_collision: 是否统计PCI冲突
            enable_confusion: 是否统计PCI混淆
            enable_mod3: 是否统计Mod3冲突
            enable_mod6: 是否统计Mod6冲突
            enable_mod30: 是否统计Mod30冲突
            check_same_frequency_only: 是否只统计同频冲突

        Returns:
            统计结果字典
        """
        conflicts = self.detect_all(
            sectors,
            enable_collision,
            enable_confusion,
            enable_mod3,
            enable_mod6,
            enable_mod30,
            check_same_frequency_only,
        )

        collision_count = sum(1 for c in conflicts if c.type == ConflictType.COLLISION)
        confusion_count = sum(1 for c in conflicts if c.type == ConflictType.CONFUSION)
        mod3_count = sum(1 for c in conflicts if c.type == ConflictType.MOD3_CONFLICT)
        mod6_count = sum(1 for c in conflicts if c.type == ConflictType.MOD6_CONFLICT)
        mod30_count = sum(1 for c in conflicts if c.type == ConflictType.MOD30_CONFLICT)

        return {
            "total": len(conflicts),
            "collisions": collision_count,
            "confusions": confusion_count,
            "mod3_conflicts": mod3_count,
            "mod6_conflicts": mod6_count,
            "mod30_conflicts": mod30_count,
        }
