"""
数据管理API端点
"""

import asyncio
import os
import shutil
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException, Body, Form
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from typing import Dict, Any, List, Optional
from app.core.config import settings
from app.models.schemas import (
    UploadResponse,
    DataItem,
    UpdateParametersRequest,
    ImportPointsRequest,
)
from app.services.data_service import data_service

router = APIRouter()


@router.post("/import-points", response_model=Dict[str, Any])
async def import_points(request: ImportPointsRequest) -> Dict[str, Any]:
    """解析点数据"""
    try:
        points = await run_in_threadpool(data_service.parse_points, request.file_path)
        return {"success": True, "data": points}
    except ValueError as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=400, detail=safe_detail)
    except Exception as e:
        import traceback

        traceback.print_exc()
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/{data_id}/download")
async def download_file(data_id: str):
    """下载原始文件"""
    try:
        # 获取文件信息
        data_dir = settings.DATA_DIR / data_id
        file_path = data_dir / "original.xlsx"

        # 按优先级查找原始文件：xlsx -> zip
        candidates = [
            data_dir / "original.xlsx",
            data_dir / "original.zip",
            settings.UPLOAD_DIR / f"{data_id}.xlsx",
            settings.UPLOAD_DIR / f"{data_id}.zip",
        ]
        file_path = None
        for candidate in candidates:
            if candidate.exists():
                file_path = candidate
                break

        if not file_path:
            raise HTTPException(status_code=404, detail="文件不存在")

        # 获取原始文件名
        default_name = "download.xlsx" if file_path.suffix == ".xlsx" else "download.zip"
        if data_id in data_service.index:
            stored_name = data_service.index[data_id].get("name", default_name)
            # 确保扩展名一致
            if not stored_name.lower().endswith(file_path.suffix.lower()):
                stored_name = stored_name + file_path.suffix
            filename = stored_name
        else:
            filename = default_name

        # 处理中文文件名编码 (RFC 5987)
        import urllib.parse

        encoded_filename = urllib.parse.quote(filename)
        headers = {
            "Content-Disposition": f"attachment; filename*=utf-8''{encoded_filename}"
        }

        # 根据文件类型设置正确的媒体类型
        if file_path.suffix.lower() == ".zip":
            media_type = "application/zip"
        else:
            media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

        return FileResponse(
            path=file_path,
            filename=filename,
            headers=headers,
            media_type=media_type,
        )
    except HTTPException:
        raise
    except Exception as e:
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/update-parameters", response_model=Dict[str, Any])
async def update_parameters(request: UpdateParametersRequest) -> Dict[str, Any]:
    """更新工参"""
    try:
        # 在线程池中运行同步的耗时操作，避免阻塞主线程
        result = await run_in_threadpool(
            data_service.update_parameters, request.fullParamId, request.currentParamId
        )
        # 工参更新成功后清除地图数据缓存
        import app.api.v1.endpoints.map as map_module
        map_module._map_data_cache = None
        map_module._map_data_cache_time = 0
        return {"success": True, "message": "工参更新成功", "data": result}
    except ValueError as e:
        # 确保错误信息是安全的，避免GBK编码错误
        error_msg = str(e)
        # 显式替换可能导致编码问题的Unicode字符
        error_msg = error_msg.replace("\u2717", "x").replace("✗", "x")
        # 使用UTF-8编码处理，然后解码为字符串
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=400, detail=safe_detail)
    except Exception as e:
        import traceback

        traceback.print_exc()
        # 确保错误信息是安全的，避免GBK编码错误
        error_msg = str(e)
        # 显式替换可能导致编码问题的Unicode字符
        error_msg = error_msg.replace("\u2717", "x").replace("✗", "x")
        # 使用UTF-8编码处理，然后解码为字符串
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.post("/upload/excel", response_model=Dict[str, Any])
async def upload_excel(
    file: Optional[UploadFile] = File(None), file_path: Optional[str] = Form(None)
) -> Dict[str, Any]:
    """上传Excel工参文件"""
    try:
        print(f"[API] upload_excel called")
        try:
            print(f"[API] file={file.filename if file else None}, file_path={file_path}")
        except:
            print(f"[API] upload_excel: file_path encoding error")
        print(f"[API] file object: {file}")
        print(f"[API] file content_type: {file.content_type if file else None}")
    except:
        pass

    try:
        # 阶段1：保存文件并创建处理中索引（快速返回）
        result = await data_service.init_upload(file, file_path)
        data_id = result["id"]
        print(f"[API] upload_excel init done: id={data_id}")

        # 阶段2：后台异步处理（在线程池中执行，不阻塞事件循环）
        async def _background_process():
            try:
                await run_in_threadpool(data_service._process_upload_sync, data_id)
                print(f"[API] 后台处理完成: {data_id}")
                # 清除地图数据缓存
                import app.api.v1.endpoints.map as map_module
                map_module._map_data_cache = None
                map_module._map_data_cache_time = 0
            except Exception as e:
                print(f"[API] 后台处理失败: {data_id}: {e}")

        asyncio.create_task(_background_process())

        # 立即返回（处理中状态）
        return {"success": True, "data": result}
    except ValueError as e:
        try:
            print(f"[API] upload_excel ValueError: {e}")
        except:
            pass
        import traceback
        traceback.print_exc()
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=400, detail=safe_detail)
    except Exception as e:
        try:
            print(f"[API] upload_excel Exception: {e}")
        except:
            pass
        import traceback
        traceback.print_exc()
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.post("/upload/map", response_model=Dict[str, Any])
async def upload_map(
    file: Optional[UploadFile] = File(None), file_path: Optional[str] = Form(None)
) -> Dict[str, Any]:
    """上传地图文件"""
    try:
        try:
            print(f"[API] upload_map: file={file}, file_path={file_path}")
        except:
            print(f"[API] upload_map: file_path encoding error")
    except:
        pass
    try:
        result = await data_service.upload_map(file, file_path)
        # 清除地图数据缓存
        import app.api.v1.endpoints.map as map_module
        map_module._map_data_cache = None
        map_module._map_data_cache_time = 0
        return {"success": True, "data": result}
    except ValueError as e:
        print(f"[API] upload_map ValueError: {e}")
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=400, detail=safe_detail)
    except Exception as e:
        print(f"[API] upload_map Exception: {e}")
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/list", response_model=Dict[str, Any])
async def list_data(page: int = 1, page_size: int = 50) -> Dict[str, Any]:
    """获取数据列表（支持分页）"""
    try:
        items = data_service.list_data(page=page, page_size=page_size)
        total = data_service.get_total_count()
        return {"success": True, "data": items, "total": total, "page": page, "page_size": page_size}
    except Exception as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/{data_id}", response_model=Dict[str, Any])
async def get_data(data_id: str) -> Dict[str, Any]:
    """获取数据详情"""
    try:
        data = data_service.get_data(data_id)
        if data is None:
            raise HTTPException(status_code=404, detail="数据不存在")
        return {"success": True, "data": data}
    except HTTPException:
        raise
    except Exception as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.delete("/{data_id}", response_model=Dict[str, Any])
async def delete_data(data_id: str, force: bool = False) -> Dict[str, Any]:
    """删除数据

    Args:
        data_id: 数据ID
        force: 是否强制删除（即使文件被占用也尝试从索引中移除）
    """
    try:
        result = data_service.delete_data(data_id, force=force)
        message = "删除成功" if result else "删除失败"
        if force and result:
            message = "已从索引中移除（部分文件可能需要手动清理）"
        # 删除成功后清除地图数据缓存
        if result:
            import app.api.v1.endpoints.map as map_module
            map_module._map_data_cache = None
            map_module._map_data_cache_time = 0
        return {"success": result, "message": message}
    except Exception as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/{data_id}/preview", response_model=Dict[str, Any])
async def preview_data(data_id: str, rows: int = 100) -> Dict[str, Any]:
    """预览数据"""
    try:
        items = data_service.list_data()
        data_item = next((item for item in items if item.id == data_id), None)

        if not data_item:
            raise HTTPException(status_code=404, detail="数据不存在")

        if data_item.type.value != "excel":
            raise HTTPException(status_code=400, detail="只支持Excel文件预览")

        preview = data_service.preview_data(data_id, rows)
        if preview is None:
            raise HTTPException(status_code=404, detail="预览失败")

        return {"success": True, "data": preview}
    except HTTPException:
        raise
    except Exception as e:
        import traceback

        traceback.print_exc()
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/{data_id}/layers", response_model=Dict[str, Any])
async def get_layer_files(data_id: str) -> Dict[str, Any]:
    """获取MapInfo图层文件列表"""
    try:
        data = data_service.get_data(data_id)
        if data is None:
            raise HTTPException(status_code=404, detail="数据不存在")

        # 检查是否为MapInfo类型
        from app.services.data_service import data_service as ds

        if data_id in ds.index:
            data_info = ds.index[data_id]
            if data_info.get("subType") != "mapinfo":
                return {
                    "success": True,
                    "data": {"layers": [], "message": "该文件不是MapInfo图层文件"},
                }

            layers = data_info.get("metadata", {}).get("layers", [])
            return {
                "success": True,
                "data": {"layers": layers, "layerCount": len(layers)},
            }

        return {"success": True, "data": {"layers": [], "layerCount": 0}}
    except HTTPException:
        raise
    except Exception as e:
        import traceback

        traceback.print_exc()
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/{data_id}/layers/{layer_id}/data", response_model=Dict[str, Any])
async def get_layer_data(data_id: str, layer_id: str) -> Dict[str, Any]:
    """获取图层要素数据（GeoJSON格式）"""
    try:
        from app.services.mapinfo_service import get_layer_data
        from app.core.config import settings

        data_dir = settings.DATA_DIR / data_id
        if not data_dir.exists():
            raise HTTPException(status_code=404, detail="数据不存在")

        geojson = get_layer_data(data_id, layer_id, data_dir)
        if geojson is None:
            raise HTTPException(status_code=404, detail="图层不存在")

        return {"success": True, "data": geojson}
    except HTTPException:
        raise
    except Exception as e:
        import traceback

        traceback.print_exc()
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/template/{template_type}")
async def download_template(template_type: str):
    """下载模板文件

    Args:
        template_type: 模板类型，'full_params'、'target_cells' 或 'geo_data'
    """
    try:
        from app.core.config import settings
        from fastapi.responses import StreamingResponse
        import mimetypes

        # 确定模板文件名前缀
        if template_type == "full_params":
            prefix = "ProjectParameter_mongoose"
            description = "全量工参模板"
        elif template_type == "target_cells":
            prefix = "cell-tree-export"
            description = "待规划小区模板"
        elif template_type == "geo_data":
            prefix = "GeoDataTemplate"
            description = "地理化数据模板"
        else:
            raise HTTPException(
                status_code=400, detail=f"不支持的模板类型: {template_type}"
            )

        # 在 template 目录中查找匹配的文件
        template_dir = settings.TEMPLATE_DIR
        if not template_dir.exists():
            raise HTTPException(
                status_code=404, detail="模板目录不存在，请先上传模板文件"
            )

        # 查找模板文件
        template_file = None

        # 对于 geo_data，直接查找完整的 zip 文件名
        if template_type == "geo_data":
            target_filename = "GeoDataTemplate.zip"
            template_file = template_dir / target_filename
            if not template_file.exists():
                template_file = None
        else:
            # 对于其他类型，使用前缀搜索
            for file in template_dir.iterdir():
                if file.is_file() and file.name.startswith(prefix):
                    template_file = file
                    break

        if not template_file:
            raise HTTPException(
                status_code=404,
                detail=f"未找到{description}文件，请确保已上传{prefix}相关文件到template目录",
            )

        # 获取文件大小
        file_size = template_file.stat().st_size
        print(
            f"[API] Found template file: {template_file.name}, size: {file_size} bytes"
        )

        # 自动检测MIME类型
        media_type, _ = mimetypes.guess_type(str(template_file))
        if not media_type:
            # 根据文件扩展名设置默认类型
            if template_file.suffix == ".zip":
                media_type = "application/zip"
            else:
                media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

        # 使用原始文件名（不带时间戳后缀）
        if template_type == "full_params":
            download_filename = "ProjectParameter_mongoose.xlsx"
        elif template_type == "target_cells":
            download_filename = "cell-tree-export.xlsx"
        elif template_type == "geo_data":
            download_filename = "GeoDataTemplate.zip"
        else:
            download_filename = template_file.name

        # 使用标准的Content-Disposition格式
        content_disposition = f'attachment; filename="{download_filename}"'

        print(
            f"[API] download_template: template_type={template_type}, file={template_file.name}, download_as={download_filename}, media_type={media_type}"
        )
        print(f"[API] Content-Disposition: {content_disposition}")

        # 直接使用FileResponse返回文件
        return FileResponse(
            path=template_file,
            filename=download_filename,
            media_type=media_type,
            headers={"Content-Disposition": content_disposition},
        )
    except HTTPException:
        raise
    except Exception as e:
        import traceback

        traceback.print_exc()
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/{data_id}/columns", response_model=Dict[str, Any])
async def get_data_columns(data_id: str, network_type: Optional[str] = None) -> Dict[str, Any]:
    """获取工参数据的列名列表

    Args:
        data_id: 数据ID
        network_type: 网络类型 (LTE 或 NR)，可选。如果不指定则返回所有网络的列名
    """
    try:
        preview = data_service.preview_data(data_id, rows=1)
        if preview is None:
            raise HTTPException(status_code=404, detail="数据不存在")

        columns = preview.get("columns", [])

        # 如果指定了网络类型，返回该网络类型的列名
        if network_type:
            # 从data.json中获取网络类型对应的列名
            data = data_service.get_data(data_id)
            if data and isinstance(data, dict):
                if network_type.upper() in data:
                    # 获取该网络类型的实际数据
                    network_data = data[network_type.upper()]
                    if network_data and len(network_data) > 0:
                        # 返回第一条数据的所有键
                        columns = list(network_data[0].keys())

        return {
            "success": True,
            "data": {
                "columns": columns,
                "networkType": network_type,
                "total": len(columns)
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/{data_id}/layers/{layer_id}/columns", response_model=Dict[str, Any])
async def get_layer_columns(data_id: str, layer_id: str) -> Dict[str, Any]:
    """获取MapInfo图层的字段名列表

    Args:
        data_id: 数据ID
        layer_id: 图层ID
    """
    try:
        from app.services.mapinfo_service import get_layer_data
        from app.core.config import settings

        data_dir = settings.DATA_DIR / data_id
        if not data_dir.exists():
            raise HTTPException(status_code=404, detail="数据不存在")

        # 获取图层数据
        layer_data = get_layer_data(data_id, layer_id, data_dir)
        if not layer_data or "features" not in layer_data:
            raise HTTPException(status_code=404, detail="图层数据不存在")

        # 提取所有字段名（排除几何字段和样式字段）
        excluded_fields = {"_style", "MAPINFO_pen", "PEN", "MAPINFO_brush", "BRUSH",
                          "MAPINFO_symbol", "SYMBOL", "MAPINFO_font", "FONT",
                          "MI_Style", "MI_Styles"}

        # 从第一个要素获取字段名
        fields = []
        if layer_data["features"] and len(layer_data["features"]) > 0:
            properties = layer_data["features"][0].get("properties", {})
            fields = [k for k in properties.keys() if k not in excluded_fields]

        return {
            "success": True,
            "data": {
                "fields": fields,
                "layerId": layer_id,
                "total": len(fields)
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)



@router.get("/{data_id}/render-mobile", response_model=Dict[str, Any])
async def render_mobile_data(data_id: str) -> Dict[str, Any]:
    """移动端数据渲染接口 - 返回可直接渲染的数据（坐标已转换GCJ02）
    
    根据数据类型自动处理：
    - MapInfo文件：返回 GeoJSON，坐标已转为 GCJ02
    - 地理化数据(Excel)：返回 features 数组 + geometryType
    """
    try:
        if data_id not in data_service.index:
            raise HTTPException(status_code=404, detail="数据不存在")
        
        data_info = data_service.index[data_id]
        data_type = data_info.get("type", "")
        
        if data_type == "map":
            # MapInfo 文件：获取所有图层的 GeoJSON 数据（坐标转换 GCJ02）
            from app.services.mapinfo_service import get_layer_data as get_mapinfo_layer_data
            from app.utils.coordinate_transformer import CoordinateTransformer
            
            layers_meta = data_info.get("metadata", {}).get("layers", [])
            data_dir = settings.DATA_DIR / data_id
            
            layers_result = []
            for layer_meta in layers_meta:
                try:
                    layer_id = layer_meta.get("id", "")
                    geojson = get_mapinfo_layer_data(data_id, layer_id, data_dir)
                    if geojson and "features" in geojson:
                        # 转换坐标 WGS84 → GCJ02
                        for feature in geojson["features"]:
                            if feature.get("geometry") and feature["geometry"].get("coordinates"):
                                feature["geometry"]["coordinates"] = \
                                    CoordinateTransformer.transform_geojson_coordinates(
                                        feature["geometry"]["coordinates"], from_wgs84=True
                                    )
                        layers_result.append({
                            "id": layer_id,
                            "name": layer_meta.get("name", layer_id),
                            "type": layer_meta.get("type", "polygon"),
                            "geojson": geojson
                        })
                except Exception as e:
                    print(f"[render_mobile] MapInfo 图层 {layer_meta.get('name','')} 处理失败: {e}")
            
            return {
                "success": True,
                "data": {
                    "dataType": "tab",
                    "layers": layers_result
                }
            }
            
        elif data_type == "excel":
            # 地理化数据：获取 features 数组与 geometryType
            geometry_type = data_info.get("geometryType", "point")
            
            import json
            data_dir = settings.DATA_DIR / data_id
            data_file = data_dir / "default.json"
            
            features = []
            if data_file.exists():
                with open(data_file, "r", encoding="utf-8") as f:
                    features = json.load(f)
            
            return {
                "success": True,
                "data": {
                    "dataType": "geo",
                    "geometryType": geometry_type,
                    "features": features,
                    "pointCount": len(features)
                }
            }
        else:
            raise HTTPException(status_code=400, detail=f"不支持的数据类型: {data_type}")
            
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cleanup/index", response_model=Dict[str, Any])
async def cleanup_index() -> Dict[str, Any]:
    """清理无效索引项（文件不存在但索引中存在的项）"""
    try:
        result = data_service.cleanup_index()
        return {
            "success": True,
            "message": f"清理完成，移除了 {result.get('removed', 0)} 个无效索引项",
            "data": result
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


# ===== 分块上传端点（解决 Cloudflare Tunnel 524 超时问题） =====
# 大文件通过 Cloudflare 隧道上传时速度较慢（约 37KB/s），
# 超过 120s 会触发 Cloudflare 的 524 Proxy Read Timeout。
# 通过将文件切分为 500KB 的小块分别上传，每块可在 15s 内完成。
#
# 流程: /upload/start -> /upload/{id}/chunk (N次) -> /upload/{id}/complete
# 完成 /complete 后返回与 /upload/excel 相同的响应格式（含 polling 状态）

# 内存中的分块上传会话存储（服务器重启后会丢失，但可重新上传）
_chunked_sessions: Dict[str, Dict[str, Any]] = {}


@router.post("/upload/start")
async def start_chunked_upload(
    filename: str = Form(...),
    total_chunks: int = Form(...),
    total_size: int = Form(...),
) -> Dict[str, Any]:
    """初始化分块上传会话"""
    data_id = str(uuid.uuid4())
    chunks_dir = settings.UPLOAD_DIR / f"chunks_{data_id}"
    chunks_dir.mkdir(parents=True, exist_ok=True)

    import re

    safe_filename = re.sub(r'[<>:"/\\|?*]', "_", filename)
    if len(safe_filename) > 100:
        name_part, text_ext = os.path.splitext(safe_filename)
        safe_filename = name_part[:90] + text_ext

    _chunked_sessions[data_id] = {
        "filename": safe_filename,
        "chunks_dir": str(chunks_dir),
        "total_chunks": total_chunks,
        "total_size": total_size,
        "received": set(),
        "created_at": time.time(),
    }

    print(f"[ChunkedUpload] 会话已创建: {data_id}, 文件: {safe_filename}, 分块: {total_chunks}")

    return {
        "success": True,
        "data": {
            "id": data_id,
            "total_chunks": total_chunks,
        }
    }


@router.post("/upload/{data_id}/chunk")
async def upload_chunk(
    data_id: str,
    chunk_index: int = Form(...),
    file: UploadFile = File(...),
) -> Dict[str, Any]:
    """上传单个分块"""
    session = _chunked_sessions.get(data_id)
    if not session:
        raise HTTPException(status_code=404, detail="上传会话不存在或已过期")

    content = await file.read()
    chunk_path = Path(session["chunks_dir"]) / f"chunk_{chunk_index:06d}"
    chunk_path.write_bytes(content)
    session["received"].add(chunk_index)

    return {
        "chunk_index": chunk_index,
        "size": len(content),
        "received": len(session["received"]),
        "total": session["total_chunks"],
    }


@router.post("/upload/{data_id}/complete")
async def complete_chunked_upload(
    data_id: str,
    filename: str = Form(...),
    file_type: str = Form("excel"),
) -> Dict[str, Any]:
    """完成分块上传：重组文件、创建索引、启动后台处理"""
    session = _chunked_sessions.get(data_id)
    if not session:
        raise HTTPException(status_code=404, detail="上传会话不存在或已过期")

    chunks_dir = Path(session["chunks_dir"])
    total = session["total_chunks"]

    # 验证所有分块已接收
    if len(session["received"]) != total:
        missing = [i for i in range(total) if i not in session["received"]]
        safe_detail = f"缺失 {len(missing)} 个分块: {missing}"
        raise HTTPException(status_code=400, detail=safe_detail)

    # 重组文件
    safe_filename = session["filename"]

    # 清理旧的会话记录（在重组前，防止并发问题）
    del _chunked_sessions[data_id]

    ext = os.path.splitext(safe_filename)[1]
    if not ext:
        ext = ".xlsx"

    file_path = settings.UPLOAD_DIR / f"{data_id}{ext}"

    print(f"[ChunkedUpload] 开始重组文件: {data_id}")
    with open(file_path, "wb") as out:
        for i in range(total):
            chunk_path = chunks_dir / f"chunk_{i:06d}"
            if not chunk_path.exists():
                shutil.rmtree(chunks_dir, ignore_errors=True)
                raise HTTPException(
                    status_code=400, detail=f"分块 {i} 不存在，上传可能已损坏"
                )
            out.write(chunk_path.read_bytes())

    # 清理分块目录
    shutil.rmtree(chunks_dir, ignore_errors=True)

    print(f"[ChunkedUpload] 文件重组完成: {file_path}, 大小: {file_path.stat().st_size:,} 字节")

    if file_type == "geo_data":
        # 地理化数据：创建索引后异步处理（避免解析耗时阻塞请求）
        data_dir = settings.DATA_DIR / data_id
        data_dir.mkdir(parents=True, exist_ok=True)

        data_service.index[data_id] = {
            'id': data_id,
            'name': safe_filename,
            'type': 'excel',
            'fileType': 'geo_data',
            'size': file_path.stat().st_size,
            'uploadDate': time.strftime("%Y-%m-%dT%H:%M:%S"),
            'status': 'processing',
        }
        data_service._save_index()

        async def _background_geo_process():
            try:
                import json
                from app.services.geo_data_service import GeoDataService
                geo_service = GeoDataService()

                parse_result = await run_in_threadpool(
                    geo_service.parse_geo_data,
                    str(file_path),
                    safe_filename
                )

                json_path = data_dir / 'default.json'
                with open(json_path, 'w', encoding='utf-8') as f:
                    json.dump(parse_result['data'], f, ensure_ascii=False, indent=2)

                data_service.index[data_id].update({
                    'geometryType': parse_result['geometryType'],
                    'sourceType': 'excel',
                    'size': len(str(parse_result['data'])),
                    'status': 'ready',
                    'metadata': {
                        'pointCount': parse_result['pointCount']
                    }
                })
                data_service._save_index()
                print(f"[ChunkedUpload] 地理化数据解析完成: {data_id}")
            except Exception as e:
                import traceback
                traceback.print_exc()
                data_service.index[data_id].update({
                    'status': 'error',
                    'errorMessage': str(e),
                })
                data_service._save_index()
                print(f"[ChunkedUpload] 地理化数据解析失败: {data_id}: {e}")

        asyncio.create_task(_background_geo_process())

        return {
            "success": True,
            "data": {
                "id": data_id,
                "name": safe_filename,
                "status": "processing",
                "fileType": "geo_data",
            },
        }
    else:
        # 默认：Excel 工参数据处理
        data_dir = settings.DATA_DIR / data_id
        data_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy(file_path, data_dir / "original.xlsx")

        data_service.index[data_id] = {
            "id": data_id,
            "name": safe_filename,
            "type": "excel",
            "fileType": "pending",
            "size": file_path.stat().st_size,
            "uploadDate": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "status": "processing",
        }
        data_service._save_index()
        print(f"[ChunkedUpload] 索引条目已创建: {data_id}")

        async def _background_process():
            try:
                await run_in_threadpool(data_service._process_upload_sync, data_id)
                print(f"[ChunkedUpload] 后台处理完成: {data_id}")
                import app.api.v1.endpoints.map as map_module
                map_module._map_data_cache = None
                map_module._map_data_cache_time = 0
            except Exception as e:
                print(f"[ChunkedUpload] 后台处理失败: {data_id}: {e}")

        asyncio.create_task(_background_process())

        return {
            "success": True,
            "data": {
                "id": data_id,
                "name": safe_filename,
                "status": "processing",
                "fileType": "pending",
            },
        }


@router.post("/upload/{data_id}/cancel")
async def cancel_chunked_upload(data_id: str) -> Dict[str, Any]:
    """取消分块上传并清理临时文件"""
    session = _chunked_sessions.pop(data_id, None)
    if session:
        chunks_dir = Path(session["chunks_dir"])
        if chunks_dir.exists():
            shutil.rmtree(chunks_dir, ignore_errors=True)
        print(f"[ChunkedUpload] 会话已取消: {data_id}")
        return {"success": True, "message": "上传已取消"}
    return {"success": True, "message": "会话不存在，无需取消"}
