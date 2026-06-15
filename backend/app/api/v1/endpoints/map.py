"""
地图服务API端点
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from typing import Dict, Any, Optional, List
from app.models.schemas import OnlineMapConfig, OfflineMapConfig, MapData
from app.core.config import settings
from app.core.security import get_current_user
import logging
import json
import time
import uuid
import httpx

router = APIRouter()

# 地图数据缓存
_map_data_cache: Optional[Dict[str, Any]] = None
_map_data_cache_time: float = 0
_map_data_cache_ttl: int = 1800  # 缓存30分钟（数据变更时主动失效）


def _filter_sites_by_bbox(sites: List[Dict], min_lat: float, max_lat: float, min_lon: float, max_lon: float) -> List[Dict]:
    """根据边界框筛选站点"""
    filtered = []
    for site in sites:
        lat = site.get('latitude', 0)
        lon = site.get('longitude', 0)
        if min_lat <= lat <= max_lat and min_lon <= lon <= max_lon:
            filtered.append(site)
    return filtered


@router.get("/data", response_model=Dict[str, Any])
async def get_map_data(
    min_lat: Optional[float] = None,
    max_lat: Optional[float] = None,
    min_lon: Optional[float] = None,
    max_lon: Optional[float] = None,
    limit: int = 10000,
    current_user=Depends(get_current_user),
) -> Dict[str, Any]:
    """获取地图数据 - 从已导入的Excel数据中聚合
    
    优先级：
    1. 只读取fileType为"full_params"的数据（最新的全量工参）
    2. 忽略"full_params_backup"等备份文件
    
    参数:
    - min_lat/max_lat/min_lon/max_lon: 边界框筛选（可选）
    - limit: 最大返回站点数（默认10000）
    """
    try:
        from app.services.data_service import data_service
        global _map_data_cache, _map_data_cache_time

        # 检查缓存是否有效
        current_time = time.time()
        if _map_data_cache is None or (current_time - _map_data_cache_time) > _map_data_cache_ttl:
            # 缓存失效，重新加载数据
            _map_data_cache = await run_in_threadpool(_load_map_data_from_files, data_service)
            _map_data_cache_time = current_time

        all_sites = _map_data_cache.get("sites", [])
        bounds = _map_data_cache.get("bounds", {})
        center = _map_data_cache.get("center", {})

        # 如果提供了边界框参数，进行筛选
        if min_lat is not None and max_lat is not None and min_lon is not None and max_lon is not None:
            all_sites = _filter_sites_by_bbox(all_sites, min_lat, max_lat, min_lon, max_lon)

        # 限制返回数量
        if len(all_sites) > limit:
            all_sites = all_sites[:limit]

        return {
            "success": True,
            "data": {
                "sites": all_sites,
                "bounds": bounds,
                "center": center,
                "total": len(all_sites)
            }
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _load_map_data_from_files(data_service) -> Dict[str, Any]:
    """从 SQLite 加载地图数据（优化版：直接 SQL 查询，跳过 ORM 开销）"""
    from app.services.data_service import SessionLocal
    from app.models.database import Workbook, Site, Sector

    db = SessionLocal()
    try:
        # 只取最新的 full_params 工作簿
        wb = db.query(Workbook).filter(
            Workbook.file_type == "full_params",
            Workbook.status == "ready"
        ).order_by(Workbook.created_at.desc()).first()

        if not wb:
            wb = db.query(Workbook).filter(
                Workbook.file_type == "full_params"
            ).order_by(Workbook.created_at.desc()).first()

        if not wb:
            return {"sites": [], "bounds": _default_bounds(), "center": _default_center()}

        data_id = wb.id

        # 批量加载站点
        sites_raw = db.query(Site).filter(Site.workbook_id == data_id).all()
        if not sites_raw:
            return {"sites": [], "bounds": _default_bounds(), "center": _default_center()}

        # 批量加载扇区
        sectors_raw = db.query(Sector).filter(Sector.workbook_id == data_id).all()

        # 构建扇区索引: {site_id_fk: [sector_dict, ...]}
        sectors_by_site: Dict[int, List[Dict]] = {}
        for s in sectors_raw:
            if s.site_id_fk is not None:
                sec_dict = {
                    "id": s.sector_id,
                    "siteId": s.sector_id.split("_")[0] if "_" in s.sector_id else "",
                    "name": s.name or "",
                    "longitude": s.longitude or 0.0,
                    "latitude": s.latitude or 0.0,
                    "azimuth": s.azimuth or 0.0,
                    "beamwidth": s.beamwidth or 65.0,
                    "height": s.height or 30.0,
                    "pci": s.pci,
                    "cell_cover_type": s.cell_cover_type or 1,
                    "tac": s.tac,
                    "frequency": s.frequency,
                    "mcc": s.mcc,
                    "mnc": s.mnc,
                    "is_shared": s.is_shared,
                }
                sectors_by_site.setdefault(s.site_id_fk, []).append(sec_dict)

        # 构建站点列表 + 边界计算
        all_sites = []
        min_lat, max_lat = 90.0, -90.0
        min_lon, max_lon = 180.0, -180.0

        for site in sites_raw:
            lat = site.latitude or 0.0
            lon = site.longitude or 0.0
            if 0 < lat < 90:
                min_lat = min(min_lat, lat)
                max_lat = max(max_lat, lat)
            if 0 < lon < 180:
                min_lon = min(min_lon, lon)
                max_lon = max(max_lon, lon)

            site_entry = {
                "id": site.site_id,
                "name": site.name or "Unknown",
                "longitude": lon,
                "latitude": lat,
                "networkType": site.network_type,
                "sectors": sectors_by_site.get(site.id, []),
            }
            if site.managed_element_id:
                site_entry["managedElementId"] = site.managed_element_id
            if site.mcc:
                site_entry["mcc"] = site.mcc
            if site.mnc:
                site_entry["mnc"] = site.mnc
            all_sites.append(site_entry)

        # 计算边界
        lat_buffer = max((max_lat - min_lat) * 0.1, 0.01)
        lon_buffer = max((max_lon - min_lon) * 0.1, 0.01)

        return {
            "sites": all_sites,
            "bounds": {
                "north": max_lat + lat_buffer,
                "south": max(0, min_lat - lat_buffer),
                "east": max_lon + lon_buffer,
                "west": max(0, min_lon - lon_buffer),
            },
            "center": {
                "latitude": (min_lat + max_lat) / 2,
                "longitude": (min_lon + max_lon) / 2,
            },
        }
    finally:
        db.close()


def _default_bounds():
    return {
        "north": 23.5, "south": 23.0,
        "east": 114.5, "west": 114.0,
    }


def _default_center():
    return {"latitude": 23.25, "longitude": 114.25}


@router.get("/cells", response_model=Dict[str, Any])
async def get_cell_list(limit: int = 50000) -> Dict[str, Any]:
    """获取小区选择列表（轻量API，不含坐标转换）
    
    比 /api/v1/map/data 轻量许多：
    - 只返回 id/name/siteId/networkType 四个字段
    - 跳过扇区验证、坐标转换、边界计算
    - 复用 _load_map_data_from_files() 的缓存机制
    """
    try:
        from app.services.data_service import data_service
        global _map_data_cache, _map_data_cache_time

        # 复用地图数据的文件缓存
        current_time = time.time()
        if _map_data_cache is None or (current_time - _map_data_cache_time) > _map_data_cache_ttl:
            _map_data_cache = await run_in_threadpool(_load_map_data_from_files, data_service)
            _map_data_cache_time = current_time

        all_sites = _map_data_cache.get("sites", [])
        cells_lte: List[Dict[str, Any]] = []
        cells_nr: List[Dict[str, Any]] = []
        dedup_set: set = set()

        for site in all_sites:
            site_name = site.get("name", "")
            network_type = site.get("networkType", "")
            site_id = site.get("id") or site.get("siteId") or ""
            sectors = site.get("sectors") or []

            for sector in sectors:
                cell_id = sector.get("id") or sector.get("cellId") or sector.get("sectorId") or ""
                unique_key = f"{site_id}_{cell_id}"

                # 去重：同一站点下相同ID的扇区只保留一个
                if unique_key in dedup_set:
                    continue
                dedup_set.add(unique_key)

                sector_name = sector.get("name") or site_name or unique_key

                cell_item = {
                    "id": unique_key,
                    "name": sector_name,
                    "siteId": site_id,
                    "networkType": network_type,
                    "frequency": sector.get("frequency"),
                    "pci": sector.get("pci")
                }

                if network_type == "LTE":
                    cells_lte.append(cell_item)
                elif network_type == "NR":
                    cells_nr.append(cell_item)

                if len(cells_lte) + len(cells_nr) >= limit:
                    break
            if len(cells_lte) + len(cells_nr) >= limit:
                break

        return {
            "success": True,
            "data": {
                "lte": cells_lte,
                "nr": cells_nr,
                "total": len(cells_lte) + len(cells_nr)
            }
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sectors", response_model=Dict[str, Any])
async def get_sectors_mobile(
    network_type: Optional[str] = None,
) -> Dict[str, Any]:
    """获取扇区数据（移动端优化版）

    返回扁平化的扇区数组（不按基站分组），只包含渲染所需的核心字段。
    数据量约为 /api/v1/map/data 的 15-20%（去除基站级嵌套和冗余字段）。
    适合通过 React Native WebView 或 axios 在移动端加载。
    """
    try:
        from app.services.data_service import data_service
        global _map_data_cache, _map_data_cache_time

        current_time = time.time()
        if _map_data_cache is None or (current_time - _map_data_cache_time) > _map_data_cache_ttl:
            _map_data_cache = await run_in_threadpool(_load_map_data_from_files, data_service)
            _map_data_cache_time = current_time

        all_sites = _map_data_cache.get("sites", [])

        lte_sectors: List[Dict[str, Any]] = []
        nr_sectors: List[Dict[str, Any]] = []

        # 扇区级去重集合（同一站点 + sectorId 只保留一个）
        dedup_set: set = set()

        for site in all_sites:
            site_network = site.get("networkType", "")
            site_lat = site.get("latitude")
            site_lon = site.get("longitude")
            site_name = site.get("name", "")
            site_id = str(site.get("id") or site.get("siteId") or "")
            sectors: list = site.get("sectors") or []

            for sector in sectors:
                sector_raw_id = sector.get("id") or ""
                sector_cell_id = sector.get("cellId") or sector.get("sectorId") or ""

                # 跨站点唯一ID: siteId + sectorRawId
                # 注意：sector.id 在同一站点内唯一，但不同站点的扇区可能ID相同
                if sector_raw_id and site_id:
                    unique_id = f"{site_id}_{sector_raw_id}"
                elif sector_cell_id and site_id:
                    unique_id = f"{site_id}_{sector_cell_id}"
                elif site_id:
                    unique_id = f"{site_id}_{len(dedup_set)}"
                else:
                    unique_id = str(uuid.uuid4())

                # 去重
                if unique_id in dedup_set:
                    continue
                dedup_set.add(unique_id)

                item = {
                    "id": unique_id,
                    "name": sector.get("name") or site_name or unique_id,
                    "siteId": site_id,
                    "sectorId": sector_raw_id or sector_cell_id,
                    "latitude": sector.get("latitude") if sector.get("latitude") is not None else site_lat,
                    "longitude": sector.get("longitude") if sector.get("longitude") is not None else site_lon,
                    "networkType": site_network or "LTE",
                    "azimuth": sector.get("azimuth"),
                    "beamwidth": sector.get("beamwidth"),
                    "height": sector.get("height"),
                    "cell_cover_type": sector.get("cell_cover_type"),
                    "pci": sector.get("pci"),
                    "frequency": sector.get("frequency"),
                    "tac": sector.get("tac"),
                    "earfcn": sector.get("earfcn"),
                    "ssbFrequency": sector.get("ssbFrequency"),
                    "mcc": sector.get("mcc"),
                    "mnc": sector.get("mnc"),
                    "is_shared": sector.get("is_shared"),
                }
                if site_network == "NR":
                    nr_sectors.append(item)
                else:
                    lte_sectors.append(item)

        # 按网络类型过滤
        if network_type and network_type.upper() == "LTE":
            nr_sectors = []
        elif network_type and network_type.upper() == "NR":
            lte_sectors = []

        return {
            "success": True,
            "data": {
                "lte": lte_sectors,
                "nr": nr_sectors,
                "lteCount": len(lte_sectors),
                "nrCount": len(nr_sectors),
            }
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cache/clear", response_model=Dict[str, Any])
async def clear_map_cache() -> Dict[str, Any]:
    """清除地图数据缓存"""
    invalidate_map_data_cache()
    return {"success": True, "message": "地图数据缓存已清除"}


def invalidate_map_data_cache():
    """清除地图数据缓存和 MapInfo 图层缓存（供其他模块调用）"""
    global _map_data_cache, _map_data_cache_time
    _map_data_cache = None
    _map_data_cache_time = 0
    try:
        from app.services.mapinfo_service import clear_layer_cache
        clear_layer_cache()
    except ImportError:
        pass


@router.get("/online-config", response_model=Dict[str, Any])
async def get_online_config() -> Dict[str, Any]:
    """获取在线地图配置（高德地图）"""
    try:
        return {
            "success": True,
            "data": {
                "provider": "amap",
                "apiKey": settings.AMAP_API_KEY,
                "securityCode": settings.AMAP_SECURITY_CODE,
                "center": settings.DEFAULT_MAP_CENTER,
                "zoom": settings.DEFAULT_MAP_ZOOM
            }
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/offline-path", response_model=Dict[str, Any])
async def get_offline_path() -> Dict[str, Any]:
    """获取离线地图路径"""
    try:
        # TODO: 从配置中获取离线地图路径
        return {
            "success": True,
            "data": {
                "path": ""
            }
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/online-config", response_model=Dict[str, Any])
async def update_online_config(config: OnlineMapConfig) -> Dict[str, Any]:
    """更新在线地图配置"""
    try:
        # TODO: 保存在线地图配置
        return {
            "success": True,
            "message": "配置已保存"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/offline-path", response_model=Dict[str, Any])
async def update_offline_path(config: OfflineMapConfig) -> Dict[str, Any]:
    """更新离线地图路径"""
    try:
        # TODO: 保存离线地图路径
        return {
            "success": True,
            "message": "路径已保存"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------- 导航路线规划代理 ----------

AMAP_DIRECTION_API = "https://restapi.amap.com/v3/direction"
AMAP_IP_LOCATION_API = "https://restapi.amap.com/v3/ip"

MODE_MAP = {
    "drive": "driving",
    "walk": "walking",
    "bicycling": "bicycling",
}


@router.get("/ip-location", response_model=Dict[str, Any])
async def get_ip_location():
    """通过高德 IP 定位获取当前位置（兜底方案，适合室内/无 GPS 环境）
    
    注意：IP 定位精度较低（城市级），仅作为无法获取精确位置时的兜底。
    精度说明：
    - WiFi 环境：约 100m-1km
    - 移动网络：约 1km-5km
    - 宽带/企业网络：可能不准
    """
    params = {
        "key": settings.AMAP_API_KEY,
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(AMAP_IP_LOCATION_API, params=params)
            data = resp.json()

        if data.get("status") != "1":
            info = data.get("info", "未知错误")
            return {"success": False, "error": f"IP定位失败: {info}"}

        # 解析返回数据
        # 返回格式: {rectangle:"minlng,minlat,maxlng,maxlat", location:"lng,lat", ...}
        location = data.get("location", "")
        if not location:
            return {"success": False, "error": "IP定位未返回坐标"}

        lng, lat = location.split(",")
        rectangle = data.get("rectangle", "")
        accuracy = "unknown"
        
        if rectangle:
            # 根据边界框估算精度
            parts = rectangle.split(",")
            if len(parts) == 4:
                min_lng, min_lat, max_lng, max_lat = map(float, parts)
                # 粗略估算精度（米）
                accuracy = f"{int(max(abs(max_lng - min_lng) * 111000, int(abs(max_lat - min_lat) * 111000)))}m"

        return {
            "success": True,
            "data": {
                "lat": float(lat),
                "lng": float(lng),
                "accuracy": accuracy,
                "source": "ip",
                "city": data.get("city", ""),
                "province": data.get("province", ""),
            }
        }
    except httpx.TimeoutException:
        return {"success": False, "error": "IP定位请求超时"}
    except Exception as e:
        return {"success": False, "error": f"IP定位失败: {str(e)}"}


@router.get("/direction", response_model=Dict[str, Any])
async def get_direction(
    origin: str = Query(..., description="起点坐标 lng,lat（GCJ-02）"),
    destination: str = Query(..., description="终点坐标 lng,lat（GCJ-02）"),
    mode: str = Query("drive", description="出行方式: drive/walk/bicycling"),
):
    """代理高德路径规划API（避免在前端暴露Web Service Key）

    参数必须使用 GCJ-02 坐标系（高德坐标系）。
    起点/终点格式: "116.397428,39.90923"
    """
    api_mode = MODE_MAP.get(mode, "driving")
    url = f"{AMAP_DIRECTION_API}/{api_mode}"

    params = {
        "key": settings.AMAP_API_KEY,
        "origin": origin,
        "destination": destination,
    }
    # 仅驾车模式添加 strategy 参数（步行/骑行不支持）
    if api_mode == "driving":
        params["strategy"] = "0"

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, params=params)
            data = resp.json()

        # 高德API v3 (驾车/步行): status="1" 表示成功
        # 高德API v4 (骑行): errcode=0 表示成功
        is_v3_success = data.get("status") == "1"
        is_v4_success = data.get("errcode") == 0

        if not is_v3_success and not is_v4_success:
            # 优先使用v3错误格式，否则使用v4错误格式
            info = data.get("info", data.get("errmsg", "未知错误"))
            infocode = data.get("infocode", data.get("errcode", ""))
            detail = f"方向规划失败: {info}"
            if infocode:
                detail += f" (code: {infocode})"
            return {"success": False, "error": detail}

        # v3 API: 数据在 data.route 下
        # v4 API: 数据在 data.data 下
        if is_v4_success:
            route_data = data.get("data", {})
        else:
            route_data = data.get("route", {})

        return {"success": True, "data": route_data}
    except httpx.TimeoutException:
        return {"success": False, "error": "请求高德API超时"}
    except Exception as e:
        return {"success": False, "error": f"请求高德API失败: {str(e)}"}
