"""
API v1 路由
"""

from fastapi import APIRouter
from app.api.v1.endpoints import license, data, pci, neighbor, tac, map, geo_data, system, auth, admin_users, user_settings, websocket, app_versions, layer, distance_match

api_router = APIRouter()

# 注册各模块路由
api_router.include_router(license.router, prefix="/license", tags=["许可证管理"])
api_router.include_router(data.router, prefix="/data", tags=["数据管理"])
api_router.include_router(pci.router, prefix="/pci", tags=["PCI规划"])
api_router.include_router(neighbor.router, prefix="/neighbor", tags=["邻区规划"])
api_router.include_router(tac.router, prefix="/tac", tags=["TAC规划"])
api_router.include_router(map.router, prefix="/map", tags=["地图服务"])
api_router.include_router(geo_data.router, prefix="/data", tags=["地理化数据"])
api_router.include_router(system.router, prefix="/system", tags=["系统服务"])
api_router.include_router(auth.router, prefix="/auth", tags=["认证管理"])
api_router.include_router(user_settings.router, prefix="/user", tags=["用户设置"])
api_router.include_router(admin_users.router, prefix="/admin/users", tags=["用户管理"])
api_router.include_router(websocket.router, tags=["WebSocket实时通信"])
api_router.include_router(app_versions.router, prefix="/app-versions", tags=["APP版本管理"])
api_router.include_router(layer.router, prefix="/layer", tags=["图层制作"])
api_router.include_router(distance_match.router, prefix="/distance-match", tags=["批量距离匹配"])
