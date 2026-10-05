"""
数据管理API端点
"""

import asyncio
import gzip
import json
import os
import shutil
import time
import uuid
import logging
from pathlib import Path
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, Body, Form, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from typing import Dict, Any, List, Optional
from app.core.config import settings
from app.models.schemas import (
    UploadResponse,
    DataItem,
    CellCreateRequest,
    CellBatchCreateRequest,
    CellDupCheckRequest,
    CellSearchRequest,
    CellBulkUpdateRequest,
    UpdateParametersRequest,
    ImportPointsRequest,
)
from app.services.data_service import data_service, validate_excel_upload_contract
from app.core.security import get_current_user, require_data_import, require_data_delete, require_data_update, require_cell_entry, require_cell_query_update
from app.core.data_access import require_data_group_access

router = APIRouter()


@router.post("/import-points", response_model=Dict[str, Any])
async def import_points(
    request: ImportPointsRequest,
    current_user=Depends(require_data_import),
) -> Dict[str, Any]:
    """解析点数据"""
    try:
        points = await run_in_threadpool(data_service.parse_points, request.file_path)
        return {"success": True, "data": points}
    except ValueError as e:
        error_msg = str(e).replace("✗", "x").replace("✗", "x")
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=400, detail=safe_detail)
    except Exception as e:
        import traceback

        traceback.print_exc()
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/{data_id}/download")
async def download_file(data_id: str, _group=Depends(require_data_group_access)):
    """下载文件（原地更新后返回原始格式的 Excel，仅更新 PCI/TAC 值）"""
    try:
        data_dir = settings.DATA_DIR / data_id

        # 方案B：map 类型数据条目存在图层定义时，实时打包**当前图层文件**返回
        # （编辑保存整层重写的源文件），不再返回上传时刻的 original.zip 快照。
        # 打包失败（无图层/源文件缺失）时静默回退到下面的原始文件逻辑。
        try:
            if (data_dir / "layers.json").exists():
                from app.services.layer_edit_service import build_data_layers_zip
                zip_bytes, layer_count = await run_in_threadpool(build_data_layers_zip, data_id)
                if zip_bytes:
                    from urllib.parse import quote
                    idx = data_service.index.get(data_id) or {}
                    dl_name = idx.get("name") or "layers.zip"
                    if not dl_name.lower().endswith(".zip"):
                        dl_name = f"{dl_name}.zip"
                    return Response(
                        content=zip_bytes,
                        media_type="application/zip",
                        headers={
                            "Content-Disposition": f"attachment; filename*=utf-8''{quote(dl_name)}",
                            "Cache-Control": "no-cache",
                        },
                    )
        except Exception as e:
            print(f"[Download] 打包当前图层失败，回退原始文件: {data_id} {e}")

        # 按优先级查找原始文件
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

        # 备用：扫描 data 目录下此 ID 文件夹中的所有文件
        if not file_path and data_dir.exists():
            for item in data_dir.iterdir():
                if item.is_file() and item.suffix.lower() in ('.xlsx', '.xls', '.zip'):
                    file_path = item
                    print(f"[Download] 通过目录扫描找到文件: {file_path}")
                    break

        # 备用2：从 index 获取文件名，在 data 目录中按名查找
        if not file_path and data_id in data_service.index:
            stored_name = data_service.index[data_id].get("name", "")
            if stored_name:
                named_path = data_dir / stored_name
                if named_path.exists():
                    file_path = named_path
                    print(f"[Download] 通过索引文件名找到文件: {file_path}")

        # 备用3：清理上传文件名后缀
        if not file_path and data_id in data_service.index:
            stored_name = data_service.index[data_id].get("name", "")
            base_name = stored_name.rsplit(".", 1)[0] if "." in stored_name else stored_name
            for ext in (".xlsx", ".xls", ".zip"):
                named_path = data_dir / f"{base_name}{ext}"
                if named_path.exists():
                    file_path = named_path
                    print(f"[Download] 通过无后缀名查找找到文件: {file_path}")
                    break

        if not file_path:
            print(f"[Download] 未找到文件: data_id={data_id}, data_dir存在={data_dir.exists()}, index中存在={data_id in data_service.index}")
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

        # ===== 原地更新后：等待后台同步完成（替代旧版兜底同步，避免竞态条件） =====
        if data_id in data_service.index and data_service.index[data_id].get('inplace_updated'):
            info = data_service.index[data_id]

            if (
                file_path.suffix.lower() in ('.xlsx', '.xls')
                and file_path.exists()
                and not info.get('excel_synced')
            ):
                # 后台同步正在执行，等待其完成（后台线程直接更新 data_service.index）
                # 最多等待 30 秒（0.5 秒 × 60）
                print(f"[Download] 等待后台Excel同步完成: {data_id}")
                for _ in range(60):
                    time.sleep(0.5)
                    info = data_service.index.get(data_id, {})
                    if info and info.get('excel_synced'):
                        print(f"[Download] 后台Excel同步已完成: {data_id}")
                        break
                else:
                    print(f"[Download] 等待后台Excel同步超时（30s），继续使用当前文件: {data_id}")

        # 处理中文文件名编码 (RFC 5987)
        import urllib.parse

        encoded_filename = urllib.parse.quote(filename)
        headers = {
            "Content-Disposition": f"attachment; filename*=utf-8''{encoded_filename}",
            # 禁止浏览器缓存下载响应，确保应用 PCI/TAC 后下载的是最新版本
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
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


@router.post("/full-params/cells", response_model=Dict[str, Any])
async def add_cell(
    request: CellCreateRequest,
    current_user=Depends(require_cell_entry),
) -> Dict[str, Any]:
    """新站录入：向全量工参追加小区"""
    try:
        # 在线程池中运行同步的耗时操作（openpyxl 文件操作）
        result = await run_in_threadpool(
            data_service.add_cell_to_full_params,
            request.networkType.value,
            request.managedElementId,
            request.siteId,
            request.cellId,
            request.cellName,
            request.longitude,
            request.latitude,
            request.azimuth,
            request.height,
            request.frequency,
            request.ssbFrequency,
            request.cellCoverType,
            current_user.id,
            current_user.city,
            current_user.operator,
        )
        return {"success": True, "message": result.get("message", ""), "data": result}
    except ValueError as e:
        error_msg = str(e).replace("✗", "x")
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=400, detail=safe_detail)
    except Exception as e:
        import traceback
        traceback.print_exc()
        error_msg = str(e).replace("✗", "x")
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.post("/full-params/cells/batch", response_model=Dict[str, Any])
async def batch_add_cells(
    request: CellBatchCreateRequest,
    current_user=Depends(require_cell_entry),
) -> Dict[str, Any]:
    """批量新站录入：向全量工参一次追加多个小区（支持 LTE/NR 混合）

    一次性 Excel 打开/保存 + 单事务 SQLite 批量写入，高性能。
    """
    if not request.cells:
        raise HTTPException(status_code=400, detail="没有待录入的小区数据")

    try:
        result = await run_in_threadpool(
            data_service.batch_add_cells_to_full_params,
            [
                {
                    "networkType": c.networkType.value,
                    "managedElementId": c.managedElementId,
                    "siteId": c.siteId,
                    "cellId": c.cellId,
                    "cellName": c.cellName,
                    "longitude": c.longitude,
                    "latitude": c.latitude,
                    "azimuth": c.azimuth,
                    "height": c.height,
                    "frequency": c.frequency,
                    "ssbFrequency": c.ssbFrequency,
                    "cellCoverType": c.cellCoverType,
                    "mcc": c.mcc,
                    "mnc": c.mnc,
                    "userId": current_user.id,
                }
                for c in request.cells
            ],
            current_user.city,
            current_user.operator,
        )
        return {
            "success": result.get("success", False),
            "message": result.get("message", ""),
            "data": {
                "results": result.get("results", []),
                "total": result.get("total", 0),
                "successCount": result.get("successCount", 0),
            },
        }
    except ValueError as e:
        error_msg = str(e).replace("✗", "x")
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=400, detail=safe_detail)
    except Exception as e:
        import traceback
        traceback.print_exc()
        error_msg = str(e).replace("✗", "x")
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.post("/full-params/cells/check-duplicates", response_model=Dict[str, Any])
async def check_cell_duplicates(
    request: CellDupCheckRequest,
    current_user=Depends(require_cell_entry),
) -> Dict[str, Any]:
    """检查小区是否重复：LTE 按 基站_小区、NR 按 MCC_MNC_基站_小区 匹配库内记录"""
    if not request.cells:
        return {"success": True, "data": {"duplicates": [], "exists": {}}}

    try:
        cells = [
            {
                "siteId": c.siteId,
                "cellId": c.cellId,
                "networkType": c.networkType.value,
                "mcc": c.mcc,
                "mnc": c.mnc,
            }
            for c in request.cells
        ]
        result = await run_in_threadpool(
            data_service.check_cell_duplicates, cells,
            current_user.city, current_user.operator,
        )
        return {"success": True, "data": result}
    except Exception as e:
        import traceback
        traceback.print_exc()
        error_msg = str(e).replace("✗", "x")
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.post("/full-params/cells/search", response_model=Dict[str, Any])
async def search_cells(
    request: CellSearchRequest,
    current_user=Depends(require_cell_query_update),
) -> Dict[str, Any]:
    """查询/更新：智能搜索小区（小区名/网元ID/基站ID/站点名模糊匹配）"""
    try:
        result = await run_in_threadpool(
            data_service.search_cells,
            request.query,
            request.networkType.value if request.networkType else None,
            request.limit,
            None,  # workbook_id
            current_user.city,
            current_user.operator,
        )
        return {"success": True, "data": result}
    except Exception as e:
        import traceback
        traceback.print_exc()
        error_msg = str(e).replace("✗", "x")
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.post("/full-params/cells/bulk-update", response_model=Dict[str, Any])
async def bulk_update_cells(
    request: CellBulkUpdateRequest,
    current_user=Depends(require_cell_query_update),
) -> Dict[str, Any]:
    """查询/更新：批量更新 + 删除小区（一次事务，双写 DB + 全量工参 Excel）"""
    try:
        updates = [
            {"rowKey": u.rowKey, "networkType": u.networkType.value, "fields": u.fields}
            for u in request.updates
        ]
        deletes = [
            {"rowKey": d.rowKey, "networkType": d.networkType.value}
            for d in request.deletes
        ]
        result = await run_in_threadpool(
            data_service.bulk_update_cells,
            updates, deletes, current_user.id, None,
            current_user.city, current_user.operator,
        )
        # 有实际变更时失效地图数据缓存（30min TTL），否则地图扇区仍显示旧属性
        if result.get("success") and (result.get("updated") or result.get("deleted")):
            import app.api.v1.endpoints.map as map_module
            map_module.invalidate_map_data_cache()
        return {
            "success": result.get("success", False),
            "message": result.get("message", ""),
            "data": {
                "results": result.get("results", []),
                "updated": result.get("updated", 0),
                "deleted": result.get("deleted", 0),
            },
        }
    except ValueError as e:
        error_msg = str(e).replace("✗", "x")
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=400, detail=safe_detail)
    except Exception as e:
        import traceback
        traceback.print_exc()
        error_msg = str(e).replace("✗", "x")
        safe_detail = error_msg.encode("utf-8", "replace").decode("utf-8")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.post("/update-parameters", response_model=Dict[str, Any])
async def update_parameters(
    request: UpdateParametersRequest,
    current_user=Depends(require_data_update),
) -> Dict[str, Any]:
    """更新工参"""
    try:
        # 在线程池中运行同步的耗时操作，避免阻塞主线程
        from app.services.task_manager import task_manager

        task_id = await task_manager.create_update_params_task(
            request.fullParamId, request.currentParamId,
            username=current_user.username,
            user_id=current_user.id,
        )
        # 清除地图数据缓存
        import app.api.v1.endpoints.map as map_module
        map_module.invalidate_map_data_cache()
        return {
            "success": True,
            "data": {"taskId": task_id, "message": "工参更新任务已启动"},
        }
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


@router.get("/update-parameters/progress/{task_id}", response_model=Dict[str, Any])
async def get_update_params_progress(task_id: str) -> Dict[str, Any]:
    """获取工参更新进度/结果"""
    try:
        from app.services.task_manager import task_manager

        progress = task_manager.get_task_progress(task_id)
        if progress is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        return {"success": True, "data": progress}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/update-parameters/result/{task_id}", response_model=Dict[str, Any])
async def get_update_params_result(task_id: str) -> Dict[str, Any]:
    """获取工参更新结果"""
    try:
        from app.services.task_manager import task_manager

        result = task_manager.get_task_result(task_id)
        if result is None:
            raise HTTPException(status_code=404, detail="任务不存在或尚未完成")
        return {"success": True, "data": result}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/upload/excel", response_model=Dict[str, Any])
async def upload_excel(
    file: Optional[UploadFile] = File(None), file_path: Optional[str] = Form(None),
    overwrite: bool = Form(False),
    current_user=Depends(require_data_import),
) -> Dict[str, Any]:
    """上传Excel工参文件"""
    try:
        print(f"[API] upload_excel called")
        try:
            print(f"[API] file={file.filename if file else None}, file_path={file_path}, overwrite={overwrite}")
        except:
            print(f"[API] upload_excel: file_path encoding error")
        print(f"[API] file object: {file}")
        print(f"[API] file content_type: {file.content_type if file else None}")
    except:
        pass

    try:
        # 阶段1：保存文件并创建处理中索引（快速返回）
        result = await data_service.init_upload(
            file, file_path, user_id=current_user.id, overwrite=overwrite,
            city=current_user.city, operator=current_user.operator,
        )

        # 同名文件检测：未覆盖时返回提示
        if result.get("status") == "duplicate":
            return {
                "success": True,
                "data": result,
                "duplicate": True,
                "message": f"文件 \"{result.get('name')}\" 已存在，是否覆盖？"
            }

        data_id = result["id"]
        print(f"[API] upload_excel init done: id={data_id}")

        # 阶段2：后台异步处理（在线程池中执行，不阻塞事件循环）
        async def _background_process():
            try:
                await run_in_threadpool(data_service._process_upload_sync, data_id)
                print(f"[API] 后台处理完成: {data_id}")
                # 清除地图数据缓存
                import app.api.v1.endpoints.map as map_module
                map_module.invalidate_map_data_cache()
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
    file: Optional[UploadFile] = File(None),
    files: Optional[List[UploadFile]] = File(None),
    file_path: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
) -> Dict[str, Any]:
    """上传地图文件（支持 MapInfo TAB/MIF、KML、ZIP、离线地图）
    files: 配套文件列表（与主文件同 stem 的 .dat/.mid/.map/.id 等，浏览器模式补齐关联文件）"""
    try:
        try:
            print(f"[API] upload_map: file={file}, files={[f.filename for f in files] if files else None}, file_path={file_path}")
        except:
            print(f"[API] upload_map: file_path encoding error")
    except:
        pass
    try:
        result = await data_service.upload_map(
            file, file_path, files=files,
            user_id=current_user.id, city=current_user.city, operator=current_user.operator,
        )
        # 清除地图数据缓存
        import app.api.v1.endpoints.map as map_module
        map_module.invalidate_map_data_cache()
        return {"success": True, "data": result}
    except ValueError as e:
        print(f"[API] upload_map ValueError: {e}")
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=400, detail=safe_detail)
    except Exception as e:
        print(f"[API] upload_map Exception: {e}")
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.post("/map/layers/create", response_model=Dict[str, Any])
async def create_map_layer(
    payload: Dict[str, Any] = Body(...),
    current_user=Depends(require_data_import),
) -> Dict[str, Any]:
    """新建空图层（TAB / Shapefile / GeoJSON），创建后出现在"图层文件"组顶层。"""
    try:
        from app.services.layer_edit_service import create_empty_layer
        name = str(payload.get("name") or "").strip()
        geometry_type = str(
            payload.get("geometry_type") or payload.get("geometryType") or ""
        ).strip()
        fmt = str(payload.get("format") or "tab").strip().lower()
        if not name:
            raise ValueError("图层名称不能为空")
        result = await run_in_threadpool(
            create_empty_layer, name, geometry_type, fmt, current_user.id,
            current_user.city, current_user.operator,
        )
        # 清除地图数据缓存（连带清 MapInfo 图层缓存）
        import app.api.v1.endpoints.map as map_module
        map_module.invalidate_map_data_cache()
        return {"success": True, "data": result}
    except ValueError as e:
        print(f"[API] create_map_layer ValueError: {e}")
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=400, detail=safe_detail)
    except Exception as e:
        print(f"[API] create_map_layer Exception: {e}")
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.put("/{data_id}/layers/{layer_id}/data", response_model=Dict[str, Any])
async def save_layer_data(
    data_id: str,
    layer_id: str,
    request: Request,
    current_user=Depends(require_data_update),
    _group=Depends(require_data_group_access),
) -> Dict[str, Any]:
    """保存图层编辑结果（整层重写 TAB）。请求体 {geojson: FeatureCollection}（坐标为 GCJ02）。

    支持 gzip 压缩请求体（Content-Encoding: gzip，前端大图层保存默认压缩）。
    按 gzip 魔数检测而非仅看请求头：中间代理解压后可能残留请求头，魔数检测两边都兼容。
    """
    try:
        from app.services.layer_edit_service import save_layer_geojson
        from app.services.layer_patch_service import apply_layer_patch, LayerVersionConflict
        raw = await request.body()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            raise ValueError("请求体不是合法的 JSON")
        patch = payload.get("patch")
        if isinstance(patch, dict):
            # 增量保存：只回传变更要素，后端按行合并（基底版本不一致时 409，前端回退整层保存）
            result = await run_in_threadpool(
                apply_layer_patch, data_id, layer_id, patch, current_user.id
            )
        else:
            geojson = payload.get("geojson")
            if not isinstance(geojson, dict):
                raise ValueError("缺少 geojson 要素集合或 patch 增量")
            result = await run_in_threadpool(
                save_layer_geojson, data_id, layer_id, geojson, current_user.id
            )
        import app.api.v1.endpoints.map as map_module
        map_module.invalidate_map_data_cache()
        return {"success": True, "data": result}
    except LayerVersionConflict as e:
        print(f"[API] save_layer_data 基底版本冲突: {e}")
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=409, detail=safe_detail)
    except ValueError as e:
        print(f"[API] save_layer_data ValueError: {e}")
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=400, detail=safe_detail)
    except FileNotFoundError as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=404, detail=safe_detail)
    except Exception as e:
        print(f"[API] save_layer_data Exception: {e}")
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/{data_id}/layers/{layer_id}/download")
async def download_layer_bundle(data_id: str, layer_id: str, _group=Depends(require_data_group_access)):
    """下载图层的 MapInfo 全套关联文件（.tab/.dat/.id/.map），打包为 .tab.zip。"""
    try:
        from urllib.parse import quote
        from app.services.layer_edit_service import build_layer_zip
        zip_bytes, filename = await run_in_threadpool(build_layer_zip, data_id, layer_id)
        # 中文文件名必须走 RFC 5987 filename*（HTTP header 仅 latin-1，
        # 直接放 filename="中文名" 会触发 'latin-1' codec can't encode 500）
        encoded = quote(filename)
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={
                "Content-Disposition": f"attachment; filename*=utf-8''{encoded}",
                "Cache-Control": "no-cache",
            },
        )
    except ValueError as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=400, detail=safe_detail)
    except FileNotFoundError as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=404, detail=safe_detail)
    except Exception as e:
        print(f"[API] download_layer_bundle Exception: {e}")
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/list", response_model=Dict[str, Any])
async def list_data(
    page: int = 1, page_size: int = 50,
    current_user=Depends(get_current_user),
) -> Dict[str, Any]:
    """获取数据列表（支持分页，按（地市+运营商）组隔离；含网优助手基站参数/指标）"""
    try:
        from app.services.assistant import ingest_service as _ingest
        assistant_items = _ingest.list_datasets(current_user)

        # 主路径：使用内存索引（由 index.json 支持，传统文件处理逻辑）
        items = data_service.list_data(page=page, page_size=page_size, user=current_user)
        total = data_service.get_total_count(user=current_user)

        if items:
            merged = list(items) + assistant_items
            return {"success": True, "data": merged,
                    "total": total + len(assistant_items),
                    "page": page, "page_size": page_size}

        # 回退：从 SQLite 查询（兼容旧数据）
        try:
            workbooks = data_service.get_workbooks_from_db(user=current_user)
        except Exception:
            workbooks = None

        if workbooks:
            from app.services.assistant import ingest_service as _ingest
            assistant_items = _ingest.list_datasets(current_user)
            merged = list(workbooks) + assistant_items
            total = len(merged)
            start = (page - 1) * page_size
            paginated = merged[start:start + page_size]
            return {"success": True, "data": paginated, "total": total, "page": page, "page_size": page_size}

        from app.services.assistant import ingest_service as _ingest
        assistant_items = _ingest.list_datasets(current_user)
        return {"success": True, "data": assistant_items,
                "total": len(assistant_items), "page": page, "page_size": page_size}
    except Exception as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/{data_id}", response_model=Dict[str, Any])
async def get_data(data_id: str, _group=Depends(require_data_group_access)) -> Dict[str, Any]:
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
async def delete_data(data_id: str, force: bool = False, current_user=Depends(require_data_delete), _group=Depends(require_data_group_access)) -> Dict[str, Any]:
    """删除数据

    Args:
        data_id: 数据ID
        force: 是否强制删除（即使文件被占用也尝试从索引中移除）
    """
    try:
        # 网优助手基站参数/指标数据集走独立删除路径
        from app.services.assistant import ingest_service as _ingest
        if data_service.index.get(data_id) is None and _ingest.delete_dataset(data_id):
            return {"success": True, "message": "删除成功"}

        result = data_service.delete_data(data_id, force=force)
        message = "删除成功" if result else "删除失败"
        if force and result:
            message = "已从索引中移除（部分文件可能需要手动清理）"
        # 删除成功后清除地图数据缓存
        if result:
            import app.api.v1.endpoints.map as map_module
            map_module.invalidate_map_data_cache()
        return {"success": result, "message": message}
    except Exception as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/{data_id}/preview", response_model=Dict[str, Any])
async def preview_data(data_id: str, rows: int = 100, _group=Depends(require_data_group_access)) -> Dict[str, Any]:
    """预览数据"""
    try:
        # O(1) 索引查找，替代原来的 list_data() + next() O(N) 扫描
        data_info = data_service.index.get(data_id)
        if not data_info:
            raise HTTPException(status_code=404, detail="数据不存在")

        if data_info.get("type") != "excel":
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
async def get_layer_files(data_id: str, _group=Depends(require_data_group_access)) -> Dict[str, Any]:
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
async def get_layer_data(data_id: str, layer_id: str, request: Request, response: Response, _group=Depends(require_data_group_access)) -> Dict[str, Any]:
    """获取图层要素数据（GeoJSON格式）"""
    try:
        from app.services.mapinfo_service import get_layer_data, layer_version_etag
        from app.core.config import settings

        data_dir = settings.DATA_DIR / data_id
        if not data_dir.exists():
            raise HTTPException(status_code=404, detail="数据不存在")

        # 🔧 ETag 基于源文件 mtime（与 mapinfo_service 落盘缓存失效逻辑一致），
        # 浏览器刷新后文件未变则 304 复用，避免大 GeoJSON 重传（前端内存缓存刷新即失）
        etag = layer_version_etag(data_dir, layer_id)
        if etag and request.headers.get("if-none-match") == etag:
            return Response(status_code=304)

        # 🔧 预压缩 gzip 直出：命中 .geojson.gz 缓存时直接返回字节，跳过 json.dumps + gzip
        # （大数据层每请求省 ~5s；响应已带 Content-Encoding，中间件不会二次压缩）
        from app.services.mapinfo_service import get_layer_data_gz_bytes
        from fastapi.concurrency import run_in_threadpool
        gz_bytes = await run_in_threadpool(get_layer_data_gz_bytes, data_id, layer_id, data_dir)
        if gz_bytes is not None:
            # 🔧 重算 etag：首次请求在 get_layer_data_gz_bytes 内生成了 .mtime 文件
            if etag is None:
                etag = layer_version_etag(data_dir, layer_id)
            gz_response = Response(
                content=gz_bytes,
                media_type="application/json",
                headers={
                    "Content-Encoding": "gzip",
                    "Cache-Control": "private, max-age=0, must-revalidate",
                },
            )
            if etag:
                gz_response.headers["ETag"] = etag
            return gz_response

        # 回退：常规路径（gz 缓存生成失败时）
        geojson = await run_in_threadpool(get_layer_data, data_id, layer_id, data_dir)
        if geojson is None:
            raise HTTPException(status_code=404, detail="图层不存在")

        # 设置缓存头：ETag 命中时浏览器可 304 复用，避免大 GeoJSON 重传
        if etag:
            response.headers["ETag"] = etag
            response.headers["Cache-Control"] = "private, max-age=0, must-revalidate"

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
            prefix = "ProjectParameter"
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
            # 优先精确匹配规范文件名，找不到再按前缀搜索
            # （前缀匹配兼容服务器上尚未改名的旧模板 ProjectParameter_mongoose.xlsx）
            exact = template_dir / f"{prefix}.xlsx"
            if exact.is_file():
                template_file = exact
            else:
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
            download_filename = "ProjectParameter.xlsx"
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
async def get_data_columns(data_id: str, network_type: Optional[str] = None, _group=Depends(require_data_group_access)) -> Dict[str, Any]:
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
async def get_layer_columns(data_id: str, layer_id: str, _group=Depends(require_data_group_access)) -> Dict[str, Any]:
    """获取MapInfo图层的字段名列表

    Args:
        data_id: 数据ID
        layer_id: 图层ID
    """
    try:
        from app.services.mapinfo_service import get_layer_data
        from app.core.config import settings
        from fastapi.concurrency import run_in_threadpool

        data_dir = settings.DATA_DIR / data_id
        if not data_dir.exists():
            raise HTTPException(status_code=404, detail="数据不存在")

        # 获取图层数据（缓存未命中时 gpd 解析为 CPU 密集型，用线程池避免阻塞事件循环）
        layer_data = await run_in_threadpool(get_layer_data, data_id, layer_id, data_dir)
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
async def render_mobile_data(data_id: str, _group=Depends(require_data_group_access)) -> Dict[str, Any]:
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
            # MapInfo 文件：获取所有图层的 GeoJSON 数据
            # 坐标转换统一由 get_layer_data 内部完成（transform_coords=True，WGS84→GCJ02）
            from app.services.mapinfo_service import get_layer_data as get_mapinfo_layer_data

            layers_meta = data_info.get("metadata", {}).get("layers", [])
            data_dir = settings.DATA_DIR / data_id

            layers_result = []
            for layer_meta in layers_meta:
                try:
                    layer_id = layer_meta.get("id", "")
                    geojson = get_mapinfo_layer_data(data_id, layer_id, data_dir)
                    if geojson and "features" in geojson:
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
    current_user=Depends(require_data_import),
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
        # 会话属主：data_id 是上传会话 ID（索引中尚无该条目），不能用组门禁；
        # 归属校验改为会话级——仅创建者本人可续传/完成/取消
        "user_id": current_user.id,
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
    current_user=Depends(require_data_import),
) -> Dict[str, Any]:
    """上传单个分块"""
    session = _chunked_sessions.get(data_id)
    if not session or session.get("user_id") != current_user.id:
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
    current_user=Depends(require_data_import),
) -> Dict[str, Any]:
    """完成分块上传：重组文件、创建索引、启动后台处理"""
    session = _chunked_sessions.get(data_id)
    if not session or session.get("user_id") != current_user.id:
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

    if file_type == "layer":
        # 图层制作：只重组文件到 layer_tmp，不建 data 索引，返回 file_path
        # 前端后续用 file_path 调 /layer/excel-info 和 /layer/point|sector（上传只发生一次）
        layer_tmp = settings.UPLOAD_DIR / "layer_tmp"
        layer_tmp.mkdir(parents=True, exist_ok=True)
        dest = layer_tmp / f"src_{data_id[:8]}{ext}"
        shutil.move(str(file_path), str(dest))  # 同文件系统原子重命名，避免 uploads 根目录残留被 scan 迁入索引
        print(f"[ChunkedUpload] 图层文件已保存: {dest}")
        return {
            "success": True,
            "data": {
                "file_path": str(dest),
                "name": safe_filename,
                "source_filename": safe_filename,  # 原始文件名（未重命名），供 /layer/* 命名输出
            },
        }
    elif file_type == "geo_data":
        # 地理化数据：创建索引后异步处理（避免解析耗时阻塞请求）
        data_dir = settings.DATA_DIR / data_id
        data_dir.mkdir(parents=True, exist_ok=True)

        data_service.index[data_id] = {
            'id': data_id,
            'name': safe_filename,
            'type': 'excel',
            'fileType': 'geo_data',
            'user_id': current_user.id,
            'city': current_user.city,
            'operator': current_user.operator,
            'size': file_path.stat().st_size,
            'uploadDate': time.strftime("%Y-%m-%dT%H:%M:%S"),
            'status': 'processing',
        }

        async def _background_geo_process():
            try:
                import json
                from app.services.geo_data_service import GeoDataService
                geo_service = GeoDataService()

                parse_result = await run_in_threadpool(
                    geo_service.parse_geo_data,
                    str(file_path),
                    safe_filename,
                    current_user.id,  # user_id
                    data_id,  # geo_id
                    current_user.city,
                    current_user.operator,
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
        # 文件名契约 + 内部工作表强校验：失败直接 400，不建索引、不删旧文件
        if ext.lower() in (".xlsx", ".xls"):
            try:
                validate_excel_upload_contract(safe_filename, file_path)
            except ValueError as e:
                file_path.unlink(missing_ok=True)
                safe_detail = str(e).encode("gbk", "replace").decode("gbk")
                raise HTTPException(status_code=400, detail=safe_detail)

        # 同名旧文件不在此删除：后台解析成功后由 data_service 的"同组同类型替换"
        # 逻辑统一清理，避免新文件解析失败导致旧数据丢失。

        data_dir = settings.DATA_DIR / data_id
        data_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy(file_path, data_dir / f"original{ext}")

        data_service.index[data_id] = {
            "id": data_id,
            "name": safe_filename,
            "type": "excel",
            "fileType": "pending",
            "user_id": current_user.id,
            "city": current_user.city,
            "operator": current_user.operator,
            "size": file_path.stat().st_size,
            "uploadDate": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "status": "processing",
        }
        print(f"[ChunkedUpload] 索引条目已创建: {data_id}")

        async def _background_process():
            try:
                await run_in_threadpool(data_service._process_upload_sync, data_id)
                print(f"[ChunkedUpload] 后台处理完成: {data_id}")
                import app.api.v1.endpoints.map as map_module
                map_module.invalidate_map_data_cache()
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
async def cancel_chunked_upload(data_id: str, current_user=Depends(get_current_user)) -> Dict[str, Any]:
    """取消分块上传并清理临时文件"""
    session = _chunked_sessions.pop(data_id, None)
    if session and session.get("user_id") != current_user.id:
        # 非本人会话按不存在处理（不泄露会话存在性）
        _chunked_sessions[data_id] = session
        session = None
    if session:
        chunks_dir = Path(session["chunks_dir"])
        if chunks_dir.exists():
            shutil.rmtree(chunks_dir, ignore_errors=True)
        print(f"[ChunkedUpload] 会话已取消: {data_id}")
        return {"success": True, "message": "上传已取消"}
    return {"success": True, "message": "会话不存在，无需取消"}
