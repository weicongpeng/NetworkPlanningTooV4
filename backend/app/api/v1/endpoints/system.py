"""
System endpoints for service discovery
"""
from typing import Any, Dict

from fastapi import APIRouter
from pydantic import BaseModel
import socket

router = APIRouter(tags=["系统服务"])

class SystemInfo(BaseModel):
    """系统信息响应模型"""
    version: str
    backend_ip: str
    backend_port: int
    # 运行形态：桌面版为 True（前端据此跳过登录页、走本机免登录会话）
    desktop_mode: bool = False

def get_local_ip() -> str:
    """获取本机IP地址"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

@router.get("/status")
async def health_check():
    """
    健康检查端点（轻量级，用于入口检测 / 负载均衡）

    返回 200 表示服务正常运行，无额外负载。
    专为 go.pengwc.asia 入口检测跳板设计。
    """
    return {"status": "ok"}


@router.get("/info", response_model=SystemInfo)
async def get_system_info():
    """
    获取系统信息，用于服务发现

    返回后端的版本号、IP地址和端口号，
    方便手机APP等客户端进行连接。
    注意：响应是裸模型（无 success/data 包裹），手机端依赖该形状，不要改。
    """
    from app.core.config import settings

    return SystemInfo(
        version="1.0.0",
        backend_ip=get_local_ip(),
        backend_port=8000,
        desktop_mode=bool(settings.NPT_DESKTOP),
    )


@router.get("/desktop-mode")
async def get_desktop_mode() -> Dict[str, Any]:
    """运行形态探测（前端在登录前调用）：标准 {success, data} 包裹，避免形状歧义。"""
    from app.core.config import settings

    return {"success": True, "data": {"desktop_mode": bool(settings.NPT_DESKTOP)}}