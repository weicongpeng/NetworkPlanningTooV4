"""
邻区规划API端点
"""
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request, Query
from typing import Dict, Any
from datetime import datetime
from app.models.schemas import NeighborConfig, NeighborResult
from app.services.task_manager import task_manager
from app.core.security import get_current_user

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
async def get_neighbor_progress(task_id: str) -> Dict[str, Any]:
    """获取邻区规划进度"""
    try:
        progress = task_manager.get_task_progress(task_id)
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


@router.get("/result/{task_id}", response_model=Dict[str, Any])
async def get_neighbor_result(task_id: str) -> Dict[str, Any]:
    """获取邻区规划结果"""
    try:
        result = task_manager.get_task_result(task_id)
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
async def delete_neighbor_history(task_id: str) -> Dict[str, Any]:
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
) -> Dict[str, Any]:
    """获取所有用户的邻区规划历史任务列表（分页）"""
    try:
        results = task_manager.list_task_history(task_type="neighbor", page=page, page_size=page_size)
        return {"success": True, "data": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export/{task_id}")
async def export_neighbor_result(task_id: str, format: str = "xlsx"):
    """导出邻区规划结果"""
    try:
        from fastapi.responses import FileResponse

        file_path = task_manager.export_result(task_id, format)
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
async def cancel_neighbor_task(task_id: str) -> Dict[str, Any]:
    """取消邻区规划任务"""
    try:
        result = task_manager.cancel_task(task_id)
        return {
            "success": result,
            "message": "任务已取消" if result else "取消失败"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
