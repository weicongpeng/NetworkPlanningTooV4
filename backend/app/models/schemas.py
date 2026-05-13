"""
数据模型定义
"""

from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Optional, List, Dict, Any, TypeVar, Generic, Union
from datetime import datetime
from enum import Enum

T = TypeVar("T")


class NetworkType(str, Enum):
    """网络类型枚举"""

    LTE = "LTE"
    NR = "NR"


class TaskStatus(str, Enum):
    """任务状态枚举"""

    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class DataType(str, Enum):
    """数据类型枚举"""

    EXCEL = "excel"
    MAP = "map"


class DataStatus(str, Enum):
    """数据状态枚举"""

    PROCESSING = "processing"
    READY = "ready"
    ERROR = "error"


# ============== 许可证相关 ==============
class LicenseStatus(BaseModel):
    """许可证状态"""

    valid: bool
    expiryDate: str
    licensee: str
    licenseKey: Optional[str] = None
    features: Optional[List[str]] = None
    version: Optional[str] = None
    errorMessage: Optional[str] = None
    remainingDays: Optional[int] = None


class LicenseActivateRequest(BaseModel):
    """许可证激活请求"""

    license_key: str


class LicenseResponse(BaseModel):
    """许可证响应"""

    success: bool
    message: Optional[str] = None


class UpdateParametersRequest(BaseModel):
    """工参更新请求"""

    fullParamId: str
    currentParamId: str


class ImportPointsRequest(BaseModel):
    """导入点数据请求"""

    file_path: str


# ============== 数据管理相关 ==============
class UploadResponse(BaseModel):
    """上传响应"""

    id: str
    name: str
    status: str


class DataItem(BaseModel):
    """数据项"""

    id: str
    name: str
    type: DataType
    fileType: Optional[str] = None  # 添加fileType字段
    originalPath: Optional[str] = None  # 原始文件路径
    size: int
    uploadDate: str
    status: DataStatus
    metadata: Optional[Dict[str, Any]] = None
    geometryType: Optional[str] = None  # 几何类型：point, sector, polygon


class SectorData(BaseModel):
    """小区数据"""

    id: str
    siteId: str
    name: str
    longitude: float
    latitude: float
    azimuth: float
    beamwidth: float = Field(default=65)
    height: float = Field(default=30)
    pci: Optional[int] = None
    earfcn: Optional[int] = None
    arfcn: Optional[int] = None
    cell_cover_type: Optional[int] = Field(
        default=1, description="小区覆盖类型: 1=室外小区, 4=室内小区"
    )
    is_shared: Optional[str] = None


class SiteData(BaseModel):
    """基站数据"""

    id: str
    name: str
    longitude: float
    latitude: float
    networkType: NetworkType
    pci: Optional[int] = None
    earfcn: Optional[int] = None
    arfcn: Optional[int] = None
    sectors: List[SectorData] = []


# ============== PCI规划相关 ==============
class PCIRange(BaseModel):
    """PCI范围 - 增强验证"""

    min: int = Field(default=0, ge=0, description="PCI最小值")
    max: int = Field(default=503, ge=0, description="PCI最大值")

    @field_validator('max')
    @classmethod
    def max_must_be_greater_than_min(cls, v: int, info) -> int:
        """验证最大值必须大于最小值"""
        if 'min' in info.data and v <= info.data['min']:
            raise ValueError(
                f'PCI最大值({v})必须大于最小值({info.data["min"]})'
            )
        return v

    @field_validator('min', 'max')
    @classmethod
    def validate_non_negative(cls, v: int) -> int:
        """验证PCI值非负"""
        if v < 0:
            raise ValueError('PCI值不能为负数')
        return v


class PCIConfig(BaseModel):
    """PCI规划配置 - 增强验证"""

    networkType: NetworkType
    distanceThreshold: float = Field(
        default=3.0,
        ge=0.1,
        le=50.0,
        description="复用距离阈值(公里)，范围0.1-50.0"
    )
    pciModulus: int = Field(
        default=3,
        ge=1,
        le=50,
        description="PCI模数，LTE通常为3，NR通常为30"
    )
    inheritModulus: bool = Field(
        default=False,
        description="是否继承全量工参小区对应的模3或模30"
    )
    pciRange: Optional[PCIRange] = Field(
        default=None,
        description="自定义PCI范围"
    )
    enableTACPlanning: bool = Field(
        default=False,
        description="是否同步执行TAC规划"
    )
    selectedCellIds: Optional[List[str]] = Field(
        default=None,
        description="选中的小区ID列表（格式：siteId_sectorId），当提供时使用选中小区的数据而非待规划小区文件"
    )
    customRules: Optional[List[Dict[str, Any]]] = None

    @field_validator('pciModulus')
    @classmethod
    def pci_modulus_must_match_network_type(
        cls, v: int, info
    ) -> int:
        """验证PCI模数与网络类型匹配"""
        if 'networkType' in info.data:
            network_type = info.data['networkType']
            if network_type == NetworkType.LTE and v not in [1, 3]:
                raise ValueError(
                    f'LTE网络pciModulus必须为1或3，当前值为{v}'
                )
            if network_type == NetworkType.NR and v not in [1, 3, 30]:
                raise ValueError(
                    f'NR网络pciModulus必须为1、3或30，当前值为{v}'
                )
        return v

    @model_validator(mode='after')
    def validate_pci_range_for_network(self) -> 'PCIConfig':
        """验证PCI范围与网络类型匹配"""
        if self.pciRange:
            LTE_MAX = 503
            NR_MAX = 1007

            if self.networkType == NetworkType.LTE:
                if self.pciRange.min > LTE_MAX or self.pciRange.max > LTE_MAX:
                    raise ValueError(
                        f'LTE网络PCI范围必须在0-{LTE_MAX}之间，'
                        f'当前范围为{self.pciRange.min}-{self.pciRange.max}'
                    )
            elif self.networkType == NetworkType.NR:
                if self.pciRange.min > NR_MAX or self.pciRange.max > NR_MAX:
                    raise ValueError(
                        f'NR网络PCI范围必须在0-{NR_MAX}之间，'
                        f'当前范围为{self.pciRange.min}-{self.pciRange.max}'
                    )

            # 验证min < max (已在PCIRange中验证，这里作为双重保障)
            if self.pciRange.min >= self.pciRange.max:
                raise ValueError(
                    f'PCI最小值({self.pciRange.min})必须小于最大值({self.pciRange.max})'
                )

        return self


class PCIConflict(BaseModel):
    """PCI冲突"""

    type: str  # 'collision' or 'confusion'
    sector1: str
    sector2: str
    pci: int


class SectorPCIResult(BaseModel):
    """小区PCI规划结果"""

    sectorId: str
    sectorName: str
    originalPCI: Optional[int] = None
    newPCI: int
    collisionCount: int = 0
    confusionCount: int = 0
    tac: Optional[str] = Field(
        default=None,
        description="TAC规划值"
    )


class SitePCIResult(BaseModel):
    """基站PCI规划结果"""

    siteId: str
    siteName: str
    sectors: List[SectorPCIResult]
    conflicts: Optional[List[PCIConflict]] = None


class PCIResult(BaseModel):
    """PCI规划结果"""

    taskId: str
    status: TaskStatus
    progress: float = Field(ge=0, le=100)
    totalSites: int
    collisions: int
    confusions: int
    results: List[SitePCIResult] = []
    startTime: str
    endTime: Optional[str] = None


# ============== 邻区规划相关 ==============
class NeighborConfig(BaseModel):
    """邻区规划配置 - 增强验证"""

    planningType: str = Field(
        default="LTE-LTE", description="邻区规划类型: LTE-LTE, NR-NR, NR-LTE"
    )
    maxDistance: Optional[float] = Field(
        default=3.0,
        ge=0.1,
        le=100.0,
        description="已弃用，改用覆盖圆算法"
    )
    maxNeighbors: int = Field(
        default=32,
        ge=1,
        le=512,
        description="每小区最大邻区数，受规划类型限制"
    )
    coverageDistanceFactor: float = Field(
        default=0.56,
        ge=0.1,
        le=2.0,
        description="覆盖圆距离系数(k)，范围0.1-2.0，默认5/9≈0.556"
    )
    coverageRadiusFactor: float = Field(
        default=0.56,
        ge=0.1,
        le=2.0,
        description="覆盖圆半径系数(m)，范围0.1-2.0，默认5/9≈0.556"
    )
    customRules: Optional[List[Dict[str, Any]]] = None
    selectedCellIds: Optional[List[str]] = Field(
        default=None,
        description="前端选中的小区ID列表（格式：siteId_sectorId）。如有值则不使用待规划小区文件，直接使用选中的小区进行规划"
    )

    @field_validator('planningType')
    @classmethod
    def validate_planning_type(cls, v: str) -> str:
        """验证规划类型"""
        valid_types = ['LTE-LTE', 'NR-NR', 'NR-LTE']
        if v not in valid_types:
            raise ValueError(
                f'规划类型必须是以下之一: {", ".join(valid_types)}，当前值为{v}'
            )
        return v

    @model_validator(mode='after')
    def validate_max_neighbors_for_planning_type(self) -> 'NeighborConfig':
        """验证最大邻区数与规划类型匹配"""
        # 根据规划类型设置最大邻区数限制
        max_neighbors_limits = {
            'LTE-LTE': 256,
            'NR-NR': 512,
            'NR-LTE': 512
        }

        limit = max_neighbors_limits.get(self.planningType, 512)

        if self.maxNeighbors > limit:
            raise ValueError(
                f'{self.planningType}规划类型最多配置{limit}条邻区关系，'
                f'当前值为{self.maxNeighbors}'
            )

        return self

    @model_validator(mode='after')
    def validate_coverage_factors(self) -> 'NeighborConfig':
        """验证覆盖圆系数的合理性"""
        # 验证距离系数和半径系数的合理性
        # 覆盖圆系数过小会导致覆盖范围过小，可能找不到邻区
        # 覆盖圆系数过大会导致覆盖范围过大，可能产生过多无效邻区

        if self.coverageDistanceFactor < 0.1:
            raise ValueError(
                f'覆盖圆距离系数不能小于0.1，当前值为{self.coverageDistanceFactor}'
            )
        if self.coverageDistanceFactor > 2.0:
            raise ValueError(
                f'覆盖圆距离系数不能大于2.0，当前值为{self.coverageDistanceFactor}'
            )

        if self.coverageRadiusFactor < 0.1:
            raise ValueError(
                f'覆盖圆半径系数不能小于0.1，当前值为{self.coverageRadiusFactor}'
            )
        if self.coverageRadiusFactor > 2.0:
            raise ValueError(
                f'覆盖圆半径系数不能大于2.0，当前值为{self.coverageRadiusFactor}'
            )

        # 验证两个系数的乘积不应过大（避免覆盖范围过大）
        # 覆盖圆的实际影响与两个系数的乘积相关
        factor_product = self.coverageDistanceFactor * self.coverageRadiusFactor
        if factor_product > 3.0:
            raise ValueError(
                f'覆盖圆距离系数和半径系数的乘积({factor_product:.2f})过大，'
                f'可能导致覆盖范围过大而产生过多无效邻区。建议减小其中一个或两个系数。'
            )

        return self

    @property
    def sourceType(self) -> NetworkType:
        """从planningType解析源网络类型"""
        return NetworkType(self.planningType.split("-")[0])

    @property
    def targetType(self) -> NetworkType:
        """从planningType解析目标网络类型"""
        return NetworkType(self.planningType.split("-")[1])


class NeighborRelation(BaseModel):
    """邻区关系"""

    sourceSector: str
    targetSector: str
    targetSite: str
    distance: float
    relationType: str  # 'LTE-LTE', 'LTE-NR', 'NR-LTE', 'NR-NR'


class SectorNeighborResult(BaseModel):
    """小区邻区规划结果"""

    sectorId: str
    sectorName: str
    neighbors: List[NeighborRelation] = []


class SiteNeighborResult(BaseModel):
    """基站邻区规划结果"""

    siteId: str
    siteName: str
    sectors: List[SectorNeighborResult]


class NeighborResult(BaseModel):
    """邻区规划结果"""

    taskId: str
    status: TaskStatus
    progress: float = Field(ge=0, le=100)
    totalSites: int
    totalNeighbors: int
    avgNeighbors: float
    results: List[SiteNeighborResult] = []
    startTime: str
    endTime: Optional[str] = None


# ============== TAC规划相关 ==============
class TACConfig(BaseModel):
    """TAC规划配置"""

    networkType: NetworkType = Field(
        default=NetworkType.LTE, description="网络类型: LTE 或 NR"
    )
    enableSingularityCheck: bool = Field(
        default=True, description="是否启用TAC插花检测"
    )
    singularityConfig: Optional[Dict[str, Any]] = Field(
        default={
            "search_radius": 1500,
            "azimuth_tolerance": 60,
            "singularity_threshold": 0.5,
        },
        description="TAC插花检测配置",
    )
    selectedCellIds: Optional[List[str]] = Field(
        default=None,
        description="选中的小区ID列表（格式：siteId_sectorId），当提供时使用选中小区的数据而非待规划小区文件"
    )


class CellTACResult(BaseModel):
    """小区TAC分配结果"""

    sectorId: str
    sectorName: str
    siteId: str
    siteName: str
    networkType: NetworkType
    longitude: float
    latitude: float
    tac: Optional[str] = None
    existingTac: Optional[str] = None
    firstGroup: Optional[str] = None
    tacAreaName: Optional[str] = None
    matched: bool = False
    isSingularity: bool = Field(default=False, description="是否是TAC插花小区")
    singularityDetails: Optional[Dict[str, Any]] = Field(
        default=None, description="TAC插花详情"
    )


class TACResult(BaseModel):
    """TAC规划结果"""

    taskId: str
    status: TaskStatus
    progress: float = Field(ge=0, le=100)
    totalCells: int = 0
    matchedCells: int = 0
    unmatchedCells: int = 0
    singularityCount: int = Field(default=0, description="TAC插花小区数量")
    results: List[CellTACResult] = []
    startTime: str
    endTime: Optional[str] = None
    error: Optional[str] = None


# ============== 地图相关 ==============
class OnlineMapConfig(BaseModel):
    """在线地图配置"""

    provider: str = Field(default="openstreetmap")
    apiKey: Optional[str] = None
    style: str = Field(default="standard")


class OfflineMapConfig(BaseModel):
    """离线地图配置"""

    path: str
    format: str = Field(default="mbtiles")
    minZoom: int = Field(default=0, ge=0, le=20)
    maxZoom: int = Field(default=18, ge=0, le=20)


class MapBounds(BaseModel):
    """地图边界"""

    north: float
    south: float
    east: float
    west: float


class MapCenter(BaseModel):
    """地图中心"""

    latitude: float
    longitude: float


class MapData(BaseModel):
    """地图数据"""

    sites: List[SiteData] = []
    bounds: MapBounds
    center: MapCenter


# ============== 通用响应 ==============
class ApiResponse(BaseModel, Generic[T]):
    """通用API响应"""

    success: bool
    data: Optional[T] = None
    message: Optional[str] = None
    code: Optional[int] = None
