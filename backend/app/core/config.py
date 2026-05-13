"""
应用配置
"""

import os
from typing import List, Optional
from pathlib import Path
from pydantic_settings import BaseSettings
from pydantic import field_validator


def _parse_cors_origins(v: Optional[str]) -> List[str]:
    """解析CORS配置字符串"""
    if v is None:
        return ["http://localhost:5173", "http://127.0.0.1:5173", "http://0.0.0.0:5173"]
    if isinstance(v, str):
        return [origin.strip() for origin in v.split(",")]
    return v


class Settings(BaseSettings):
    """应用配置类"""

    # 项目信息
    PROJECT_NAME: str = "网络规划工具"
    VERSION: str = "3.0.0"

    # API配置
    API_V1_STR: str = "/api/v1"

    # CORS配置 - 从环境变量读取
    NPT_CORS_ORIGINS: Optional[str] = None

    # 服务器配置 - 从环境变量读取
    NPT_HOST: str = "0.0.0.0"
    NPT_PORT: int = 8000

    # 目录配置
    BASE_DIR: Path = Path(__file__).parent.parent.parent.parent
    UPLOAD_DIR: Path = BASE_DIR / "uploads"
    OUTPUT_DIR: Path = BASE_DIR / "outputs"
    EXPORT_DIR: Path = BASE_DIR / "exports"
    LICENSE_DIR: Path = BASE_DIR / "licenses"
    DATA_DIR: Path = BASE_DIR / "data"
    TEMPLATE_DIR: Path = BASE_DIR / "template"

    # 许可证配置 - 从环境变量读取
    NPT_LICENSE_SECRET_KEY: str = "network-planning-tool-secret-key-2024"
    NPT_LICENSE_EXPIRY_DAYS: int = 365

    # 任务配置 - 从环境变量读取
    NPT_MAX_TASKS: int = 10
    NPT_TASK_TIMEOUT: int = 3600

    # 高德地图配置 - 从环境变量读取
    NPT_AMAP_API_KEY: str = ""
    NPT_AMAP_SECURITY_CODE: str = ""

    # 运行模式配置 - 从环境变量读取
    NPT_RELOAD: bool = False
    NPT_WORKERS: int = 1

    # 地图默认配置
    DEFAULT_MAP_CENTER: tuple = (39.9042, 116.4074)  # 北京
    DEFAULT_MAP_ZOOM: int = 10

    # PCI规划默认配置
    DEFAULT_PCI_DISTANCE_THRESHOLD: float = 3.0
    DEFAULT_PCI_MODULUS: int = 3

    # 邻区规划默认配置
    DEFAULT_NEIGHBOR_MAX_DISTANCE: float = 10.0
    DEFAULT_NEIGHBOR_MAX_COUNT: int = 32

    # 计算属性
    @property
    def BACKEND_CORS_ORIGINS(self) -> List[str]:
        return _parse_cors_origins(self.NPT_CORS_ORIGINS)

    @property
    def HOST(self) -> str:
        return self.NPT_HOST

    @property
    def PORT(self) -> int:
        return self.NPT_PORT

    @property
    def LICENSE_SECRET_KEY(self) -> str:
        return self.NPT_LICENSE_SECRET_KEY

    @property
    def LICENSE_EXPIRY_DAYS(self) -> int:
        return self.NPT_LICENSE_EXPIRY_DAYS

    @property
    def MAX_TASKS(self) -> int:
        return self.NPT_MAX_TASKS

    @property
    def TASK_TIMEOUT(self) -> int:
        return self.NPT_TASK_TIMEOUT

    @property
    def AMAP_API_KEY(self) -> str:
        return self.NPT_AMAP_API_KEY

    @property
    def AMAP_SECURITY_CODE(self) -> str:
        return self.NPT_AMAP_SECURITY_CODE

    @field_validator("NPT_CORS_ORIGINS", mode="before")
    @classmethod
    def validate_cors_origins(cls, v):
        if v is None:
            # 开发环境默认值
            return "http://localhost:5173,http://127.0.0.1:5173,http://0.0.0.0:5173"
        return v

    @field_validator("NPT_AMAP_API_KEY", mode="before")
    @classmethod
    def validate_amap_key(cls, v):
        if not v:
            # 开发环境使用默认密钥
            return "5299af602f4ee3cd7351c1bc7f32b1cb"
        return v

    @field_validator("NPT_LICENSE_SECRET_KEY", mode="before")
    @classmethod
    def validate_license_key(cls, v):
        if not v:
            return "network-planning-tool-secret-key-2024"
        return v

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = True
        extra = "ignore"


settings = Settings()
