"""
System endpoints for service discovery
"""
from fastapi import APIRouter
from pydantic import BaseModel
import socket

router = APIRouter(tags=["系统服务"])

class SystemInfo(BaseModel):
    """系统信息响应模型"""
    version: str
    backend_ip: str
    backend_port: int

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

@router.get("/info", response_model=SystemInfo)
async def get_system_info():
    """
    获取系统信息，用于服务发现

    返回后端的版本号、IP地址和端口号，
    方便手机APP等客户端进行连接
    """
    return SystemInfo(
        version="1.0.0",
        backend_ip=get_local_ip(),
        backend_port=8000
    )