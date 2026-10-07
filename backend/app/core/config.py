"""
应用配置
"""

import os
import sys
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


def _bundle_dir() -> Path:
    """只读资源根：PyInstaller 冻结时为解包目录（sys._MEIPASS），否则为仓库根。"""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).parent.parent.parent.parent


def _data_root() -> Path:
    """可写数据根：NPT_DATA_ROOT 优先；桌面版（NPT_DESKTOP=1）默认
    %APPDATA%/NetworkPlanningTool；其余（服务器/开发）保持仓库根，行为不变。"""
    env_root = os.environ.get("NPT_DATA_ROOT")
    if env_root:
        return Path(env_root)
    if os.environ.get("NPT_DESKTOP", "").strip().lower() in ("1", "true", "yes"):
        appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(appdata) / "NetworkPlanningTool"
    return _bundle_dir()


# 桌面版没有 .env：默认沿用生产部署的地市清单（广东 21 市），NPT_CITY_PRESETS 仍可覆盖
_DESKTOP_DEFAULT_CITY_PRESETS = (
    "广州,韶关,深圳,珠海,汕头,佛山,江门,湛江,茂名,肇庆,惠州,梅州,"
    "汕尾,河源,阳江,清远,东莞,中山,潮州,揭阳,云浮"
)


def _city_presets_default() -> str:
    if os.environ.get("NPT_DESKTOP", "").strip().lower() in ("1", "true", "yes"):
        return _DESKTOP_DEFAULT_CITY_PRESETS
    return ""


_BUNDLE_DIR = _bundle_dir()
_DATA_ROOT = _data_root()


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

    # 目录配置：BUNDLE_DIR 为只读资源根（冻结时 _MEIPASS），DATA_ROOT 为可写数据根
    BUNDLE_DIR: Path = _BUNDLE_DIR
    DATA_ROOT: Path = _DATA_ROOT
    UPLOAD_DIR: Path = _DATA_ROOT / "uploads"
    OUTPUT_DIR: Path = _DATA_ROOT / "outputs"
    EXPORT_DIR: Path = _DATA_ROOT / "exports"
    LICENSE_DIR: Path = _DATA_ROOT / "licenses"
    DATA_DIR: Path = _DATA_ROOT / "data"
    APKS_DIR: Path = _DATA_ROOT / "apks"
    DESKTOP_RELEASES_DIR: Path = _DATA_ROOT / "desktop_releases"
    TEMPLATE_DIR: Path = _BUNDLE_DIR / "template"

    # 许可证配置 - 从环境变量读取
    NPT_LICENSE_SECRET_KEY: str = "network-planning-tool-secret-key-2024"
    NPT_LICENSE_EXPIRY_DAYS: int = 365

    # JWT 认证配置 - 从环境变量读取
    NPT_JWT_SECRET_KEY: str = "network-planning-tool-jwt-secret-key-2024"
    NPT_JWT_ALGORITHM: str = "HS256"
    NPT_JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440

    # 会话空闲超时（分钟）：连续无任何请求（含心跳）超过该时长才要求重新登录。
    # 期间换网络/IP（含 IPv4/IPv6 切换）不打断登录态；仅在新设备登录时踢掉旧会话。
    NPT_SESSION_IDLE_TIMEOUT_MINUTES: int = 180

    # 任务配置 - 从环境变量读取
    NPT_MAX_TASKS: int = 10
    NPT_TASK_TIMEOUT: int = 3600
    NPT_MAX_WORKERS: int = 3  # 进程池 Worker 数（4 核 ARM 留 1 核给系统）

    # 高德地图配置 - 从环境变量读取
    NPT_AMAP_API_KEY: str = ""
    NPT_AMAP_SECURITY_CODE: str = ""

    # 运行模式配置 - 从环境变量读取
    NPT_RELOAD: bool = False
    NPT_WORKERS: int = 1

    # 运行形态：桌面离线版（desktop/launcher.py 注入 NPT_DESKTOP=1）
    NPT_DESKTOP: bool = False

    # ===== 桌面版在线授权与 OTA（服务器侧签发 / 客户端侧消费）=====
    # 签发私钥（Ed25519 PEM）：优先环境变量，其次 LICENSE_DIR/license_private_key.pem
    NPT_LICENSE_PRIVATE_KEY: str = ""
    # 授权流程：precreate=管理员预建激活码（默认）；approve=客户端申请→管理员批准
    NPT_DESKTOP_ACTIVATION_MODE: str = "precreate"
    # 默认租约天数（管理员创建授权时可用 lease_days 覆盖）
    NPT_DESKTOP_LEASE_DAYS: int = 30
    # 客户端使用的服务器地址（桌面版 launcher 注入；服务器侧不用）
    NPT_SERVER_URL: str = "https://app.pengwc.asia"
    # 客户端更新渠道
    NPT_DESKTOP_CHANNEL: str = "stable"
    # 客户端构建版本（launcher 从打包内的 version.json 注入）
    NPT_DESKTOP_VERSION: str = ""
    # 桌面版允许点"稍后"的次数（超过后强制更新）
    NPT_DESKTOP_MAX_SNOOZE: int = 3
    # 共享模式后台同步轮询间隔（分钟）：轮询只比对修订号，有变化才整包同步
    NPT_DESKTOP_SYNC_INTERVAL_MINUTES: int = 1
    # 本地数据改动后触发上行的防抖秒数（连续写入只同步一次）
    NPT_DESKTOP_SYNC_DEBOUNCE_SECONDS: int = 3

    # 地图默认配置
    DEFAULT_MAP_CENTER: tuple = (39.9042, 116.4074)  # 北京
    DEFAULT_MAP_ZOOM: int = 10

    # PCI规划默认配置
    DEFAULT_PCI_DISTANCE_THRESHOLD: float = 3.0
    DEFAULT_PCI_MODULUS: int = 3

    # 邻区规划默认配置
    DEFAULT_NEIGHBOR_MAX_DISTANCE: float = 10.0
    DEFAULT_NEIGHBOR_MAX_COUNT: int = 32

    # 网优助手 LLM 配置（OpenAI 兼容协议，均可留空=未配置）=====
    # 兼容 DeepSeek/通义千问/豆包/本地 vLLM·Ollama 等任意 OpenAI 协议端点
    NPT_LLM_BASE_URL: str = ""       # 如 https://api.deepseek.com/v1
    NPT_LLM_API_KEY: str = ""
    NPT_LLM_MODEL: str = ""          # 如 deepseek-chat / qwen-plus
    NPT_LLM_TIMEOUT: int = 60        # 单次对话超时（秒）

    # 地市预设清单（逗号分隔）：注册/用户管理"地市"下拉的数据源。
    # 生产必须在 .env 中配置（如 NPT_CITY_PRESETS=郑州,洛阳,开封）；
    # 桌面版（NPT_DESKTOP=1）无 .env 时使用默认清单（见 _city_presets_default）。
    NPT_CITY_PRESETS: str = _city_presets_default()

    # APK 下载缓存配置（秒）
    # 默认 3600（1 小时），Cloudflare 边缘节点缓存后同区域下载秒级完成
    # APK 版本很少更新，可以设置较长缓存时间
    APK_CACHE_MAX_AGE: int = 3600

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
    def JWT_SECRET_KEY(self) -> str:
        return self.NPT_JWT_SECRET_KEY

    @property
    def JWT_ALGORITHM(self) -> str:
        return self.NPT_JWT_ALGORITHM

    @property
    def JWT_ACCESS_TOKEN_EXPIRE_MINUTES(self) -> int:
        return self.NPT_JWT_ACCESS_TOKEN_EXPIRE_MINUTES

    @property
    def SESSION_IDLE_TIMEOUT_MINUTES(self) -> int:
        return self.NPT_SESSION_IDLE_TIMEOUT_MINUTES

    @property
    def MAX_TASKS(self) -> int:
        return self.NPT_MAX_TASKS

    @property
    def TASK_TIMEOUT(self) -> int:
        return self.NPT_TASK_TIMEOUT

    @property
    def MAX_WORKERS(self) -> int:
        return self.NPT_MAX_WORKERS

    @property
    def AMAP_API_KEY(self) -> str:
        return self.NPT_AMAP_API_KEY

    @property
    def AMAP_SECURITY_CODE(self) -> str:
        return self.NPT_AMAP_SECURITY_CODE

    @property
    def CITY_PRESETS(self) -> List[str]:
        return [c.strip() for c in (self.NPT_CITY_PRESETS or "").split(",") if c.strip()]

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
