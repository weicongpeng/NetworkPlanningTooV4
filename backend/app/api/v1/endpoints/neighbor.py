"""
邻区规划API端点
"""
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request, Query, Response
from typing import Dict, Any
from datetime import datetime
from app.models.schemas import NeighborConfig, NeighborResult
from app.services.task_manager import task_manager
from app.core.security import get_current_user
from app.core.data_access import require_task_access

router = APIRouter()


@router.post("/plan", response_model=Dict[str, Any])
async def start_neighbor_planning(
    request: Request,
    background_tasks: BackgroundTasks,
    current_user=Depends(get_current_user),
) -> Dict[str, Any]:
    """启动邻区规划任务"""
    try:
        body = await request.json()
        config = NeighborConfig(**body)
        user_name = current_user.username if current_user else ""
        # 优先使用前端传入的用户自定义任务名称
        task_name = body.get("taskName") if isinstance(body, dict) else None
        if not task_name:
            task_name = f"邻区规划 - {datetime.now().strftime('%m/%d %H:%M')}"
        task_id = await task_manager.create_neighbor_task(config, task_name=task_name, user_name=user_name)
        return {
            "success": True,
            "data": {
                "taskId": task_id,
                "message": "邻区规划任务已启动"
            }
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/progress/{task_id}", response_model=Dict[str, Any])
async def get_neighbor_progress(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """获取邻区规划进度（只返回状态/统计，不返回完整结果）"""
    try:
        # 邻区结果可达 200MB+，进度轮询绝不能带完整 result：完成时由前端
        # 显式“查看/加载完整结果”再走 /result 接口。
        progress = task_manager.get_task_progress_meta(task_id)
        if progress is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        return {
            "success": True,
            "data": progress
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/result/{task_id}/meta", response_model=Dict[str, Any])
async def get_neighbor_result_meta(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """结果页轻量元数据：摘要 + 分页索引状态，不加载完整结果。"""
    try:
        from app.services import task_result_index_service as index_service

        meta = index_service.get_task_meta(task_id)
        if meta is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        if meta["status"] == "completed" and not meta["rowsReady"]:
            index_service.schedule_index(task_id, "neighbor")
        return {"success": True, "data": meta}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/result/{task_id}/sources", response_model=Dict[str, Any])
async def get_neighbor_result_sources(
    task_id: str,
    request: Request,
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    _group=Depends(require_task_access),
) -> Dict[str, Any]:
    """邻区结果按源小区分页；目标小区随源小区一并返回，保证表格分组不跨页。"""
    try:
        from starlette.concurrency import run_in_threadpool
        from app.services import task_result_index_service as index_service
        from app.api.v1.endpoints import _result_cache

        cached = _result_cache.not_modified(request, task_id)
        if cached is not None:
            return cached
        if not index_service.ensure_indexed(task_id, "neighbor"):
            return {"success": True, "data": {"preparing": True, "sources": [], "total": 0}}
        filters = {
            key: value for key, value in request.query_params.items()
            if key not in ("page", "page_size")
        }
        data = await run_in_threadpool(
            index_service.query_neighbor_sources, task_id, page, page_size, filters
        )
        _result_cache.apply_headers(request, response, task_id)
        return {"success": True, "data": data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/result/{task_id}/neighbors", response_model=Dict[str, Any])
async def get_neighbor_source_neighbors(
    task_id: str,
    request: Request,
    response: Response,
    source_site_id: str = Query(..., alias="sourceSiteId"),
    source_cell_id: str = Query(..., alias="sourceCellId"),
    _group=Depends(require_task_access),
) -> Dict[str, Any]:
    """地图点击源小区时按需取邻区关系，不再下发全量关系。"""
    try:
        from starlette.concurrency import run_in_threadpool
        from app.services import task_result_index_service as index_service
        from app.api.v1.endpoints import _result_cache

        cached = _result_cache.not_modified(request, task_id)
        if cached is not None:
            return cached
        if not index_service.ensure_indexed(task_id, "neighbor"):
            return {"success": True, "data": {"preparing": True, "rows": []}}
        rows = await run_in_threadpool(
            index_service.query_neighbor_relations, task_id, source_site_id, source_cell_id
        )
        _result_cache.apply_headers(request, response, task_id)
        return {"success": True, "data": {"rows": rows}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/result/{task_id}/rows", response_model=Dict[str, Any])
async def get_neighbor_result_rows(
    task_id: str,
    request: Request,
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    _group=Depends(require_task_access),
) -> Dict[str, Any]:
    """邻区结果扁平分页（导出预览/兼容调用）。"""
    try:
        from starlette.concurrency import run_in_threadpool
        from app.services import task_result_index_service as index_service
        from app.api.v1.endpoints import _result_cache

        cached = _result_cache.not_modified(request, task_id)
        if cached is not None:
            return cached
        if not index_service.ensure_indexed(task_id, "neighbor"):
            return {"success": True, "data": {"preparing": True, "rows": [], "total": 0}}
        filters = {
            key: value for key, value in request.query_params.items()
            if key not in ("page", "page_size")
        }
        data = await run_in_threadpool(
            index_service.query_rows, task_id, "neighbor", page, page_size, filters
        )
        _result_cache.apply_headers(request, response, task_id)
        return {"success": True, "data": data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/result/{task_id}", response_model=Dict[str, Any])
async def get_neighbor_result(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """获取邻区规划结果"""
    try:
        from starlette.concurrency import run_in_threadpool
        # 大结果解析/清洗是同步 CPU 活，必须丢线程池，避免阻塞事件循环
        result = await run_in_threadpool(task_manager.get_task_result, task_id)
        if result is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        return {
            "success": True,
            "data": result
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/history/{task_id}", response_model=Dict[str, Any])
async def delete_neighbor_history(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """删除指定的邻区规划历史任务"""
    try:
        success = task_manager.delete_task(task_id)
        if success:
            return {"success": True, "message": "任务已删除"}
        else:
            raise HTTPException(status_code=404, detail="任务删除失败或不存在")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/history", response_model=Dict[str, Any])
async def get_neighbor_history(
    page: int = Query(1, ge=1, description="页码（从 1 开始）"),
    page_size: int = Query(20, ge=1, le=100, description="每页条数"),
    current_user=Depends(get_current_user),
) -> Dict[str, Any]:
    """获取邻区规划历史任务列表（分页，按地市+运营商组隔离）"""
    try:
        results = task_manager.list_task_history(task_type="neighbor", page=page, page_size=page_size, user=current_user)
        return {"success": True, "data": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export/{task_id}")
async def export_neighbor_result(task_id: str, format: str = "xlsx", _group=Depends(require_task_access)):
    """导出邻区规划结果"""
    try:
        from fastapi.responses import FileResponse
        from starlette.concurrency import run_in_threadpool

        file_path = await run_in_threadpool(task_manager.export_result, task_id, format)
        if file_path is None:
            raise HTTPException(status_code=404, detail="任务不存在或导出失败")

        filename = f"neighbor_result_{task_id}.{format}"
        return FileResponse(
            path=file_path,
            filename=filename,
            media_type="application/octet-stream"
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/task/{task_id}", response_model=Dict[str, Any])
async def cancel_neighbor_task(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """取消邻区规划任务"""
    try:
        result = task_manager.cancel_task(task_id)
        return {
            "success": result,
            "message": "任务已取消" if result else "取消失败"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
