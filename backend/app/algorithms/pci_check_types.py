"""
PCI核查领域定义：核查类别、参数与门限常量

单独成模块，供核查服务与导出服务共用，避免结果表构造反向依赖算法实现。
"""

from dataclasses import dataclass
from enum import Enum


class CheckType(str, Enum):
    """PCI核查类别"""

    REUSE_DISTANCE = "reuse_distance"
    COLLISION = "collision"
    CONFUSION = "confusion"
    MOD3_SAME_SITE = "mod3_same_site"
    MOD3_FACING = "mod3_facing"
    MOD3_NEIGHBOR = "mod3_neighbor"
    MOD30_SAME_SITE = "mod30_same_site"
    MOD30_FACING = "mod30_facing"
    MOD30_NEIGHBOR = "mod30_neighbor"


CHECK_TYPE_NAMES = {
    CheckType.REUSE_DISTANCE: "PCI复用距离过小",
    CheckType.COLLISION: "PCI冲突",
    CheckType.CONFUSION: "PCI混淆",
    CheckType.MOD3_SAME_SITE: "同站模3冲突",
    CheckType.MOD3_FACING: "对打模3冲突",
    CheckType.MOD3_NEIGHBOR: "邻区模3冲突",
    CheckType.MOD30_SAME_SITE: "同站模30冲突",
    CheckType.MOD30_FACING: "对打模30冲突",
    CheckType.MOD30_NEIGHBOR: "邻区模30冲突",
}

# 邻区预规划固定使用邻区规划页面默认参数（frontend/src/renderer/store/neighborStore.ts defaultConfig）
NEIGHBOR_DEFAULT_PARAMS = {
    "max_neighbors": 64,
    "coverage_distance_factor": 0.5,
    "coverage_radius_factor": 0.5,
    "dense_spacing_threshold_km": 1.0,
    "dense_multiplier": 1.3,
    "outdoor_to_indoor_max_km": 0.6,
    "indoor_to_indoor_radius_km": 0.35,
    "indoor_to_outdoor_multiplier": 1.5,
    "outdoor_spacing_site_count": 11,
}

# 邻区预规划的目标池裁剪带宽（公里）。
# 邻区规划默认参数下，单个源小区最远可加到 1.5×站间距（室分→室外）或 1.25×max(1km,站间距)
# （稀疏覆盖圆：圆心偏移0.25×ECD + 两侧半径1.0×ECD），因此只有站间距>6.7公里的
# 极端稀疏场景才会超出本带宽；超出部分的邻区对不参与冲突/混淆核查，其余类别不受影响。
NEIGHBOR_CANDIDATE_BAND_KM = 10.0

# 混淆核查里同 PCI 邻区组的组合上限，避免异常数据下结果量爆炸
MAX_CONFUSION_GROUP = 10

# 仅同站核查才有"超过 3 个同频小区按非连续分配"的判定口径
MOD3_SAME_SITE_EXEMPTION_COUNT = 3


@dataclass
class PCICheckParams:
    """PCI核查参数"""

    network_type: str
    min_reuse_distance_macro_km: float = 2.0
    min_reuse_distance_indoor_km: float = 0.5
    macro_pair_distance_km: float = 0.2
    mixed_pair_distance_km: float = 0.1
    indoor_pair_distance_km: float = 0.05
    macro_facing_gate_deg: float = 90.0
    indoor_facing_gate_deg: float = 60.0
    enable_collision_check: bool = True
    enable_confusion_check: bool = True
    enable_mod3_check: bool = True
    enable_mod30_check: bool = True
    enable_reuse_check: bool = True
    """邻区关联开关：冲突/混淆/模值邻区核查统一由它控制"""
    neighbor_assoc: bool = True

    def reuse_distance_km(self, is_indoor: bool) -> float:
        """按被核查小区类型取最小复用距离门限（公里）"""
        return self.min_reuse_distance_indoor_km if is_indoor else self.min_reuse_distance_macro_km

    @property
    def max_reuse_distance_km(self) -> float:
        """两类门限中的较大值，用于生成候选对后按类型过滤"""
        return max(self.min_reuse_distance_macro_km, self.min_reuse_distance_indoor_km)

    def pair_distance_km(self, first_indoor: bool, second_indoor: bool) -> float:
        """按站点类型组合取对打距离门限：宏-宏 / 宏-室分 / 室-室"""
        if first_indoor and second_indoor:
            return self.indoor_pair_distance_km
        if first_indoor or second_indoor:
            return self.mixed_pair_distance_km
        return self.macro_pair_distance_km

    @property
    def max_pair_distance_km(self) -> float:
        """三类门限中的较大值，用于生成候选对后按类型过滤"""
        return max(
            self.macro_pair_distance_km,
            self.mixed_pair_distance_km,
            self.indoor_pair_distance_km,
        )

    def facing_gate_deg(self, indoor_involved: bool) -> float:
        """对打夹角门限：任一侧为室分时采用室分门限"""
        return self.indoor_facing_gate_deg if indoor_involved else self.macro_facing_gate_deg
