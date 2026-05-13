"""
自定义异常类
用于更细粒度的异常处理和错误恢复
"""

class NetworkPlanningError(Exception):
    """网络规划工具基础异常类"""
    pass


class DataLoadError(NetworkPlanningError):
    """数据加载失败异常"""
    pass


class DataParseError(NetworkPlanningError):
    """数据解析失败异常"""
    pass


class FileValidationError(NetworkPlanningError):
    """文件验证失败异常"""
    pass


class ConfigurationError(NetworkPlanningError):
    """配置错误异常"""
    pass


class PlanningError(NetworkPlanningError):
    """规划任务执行失败异常"""
    pass


class TaskTimeoutError(NetworkPlanningError):
    """任务超时异常"""
    pass


class ResourceLimitError(NetworkPlanningError):
    """资源限制异常（内存、文件大小等）"""
    pass


class ExternalServiceError(NetworkPlanningError):
    """外部服务调用失败异常"""
    pass
