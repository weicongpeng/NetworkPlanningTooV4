"""
TAC规划API端点
"""

from fastapi import APIRouter, HTTPException, BackgroundTasks
from typing import Dict, Any
from app.models.schemas import TACConfig, TACResult
from app.services.task_manager import task_manager

router = APIRouter()


@router.post("/plan", response_model=Dict[str, Any])
async def start_tac_planning(
    config: TACConfig, background_tasks: BackgroundTasks
) -> Dict[str, Any]:
    """启动TAC规划任务"""
    try:
        task_id = await task_manager.create_tac_task(config)
        return {
            "success": True,
            "data": {"taskId": task_id, "message": "TAC规划任务已启动"},
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/progress/{task_id}", response_model=Dict[str, Any])
async def get_tac_progress(task_id: str) -> Dict[str, Any]:
    """获取TAC规划进度"""
    try:
        progress = task_manager.get_task_progress(task_id)
        if not progress:
            raise HTTPException(status_code=404, detail="任务不存在")
        return {"success": True, "data": progress}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/result/{task_id}", response_model=Dict[str, Any])
async def get_tac_result(task_id: str) -> Dict[str, Any]:
    """获取TAC规划结果"""
    try:
        result = task_manager.get_task_result(task_id)
        if not result:
            raise HTTPException(status_code=404, detail="任务不存在")
        return {"success": True, "data": result}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export/{task_id}")
async def export_tac_result(task_id: str, format: str = "xlsx"):
    """导出TAC规划结果"""
    try:
        # 从任务管理器获取任务结果
        result = task_manager.get_task_result(task_id)
        if not result:
            raise HTTPException(status_code=404, detail="任务不存在")

        # 导出文件
        from app.services.export_service import export_tac_result

        return await export_tac_result(task_id, result, format)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/planning/plan", response_model=Dict[str, Any])
async def start_tac_planning_task(
    config: TACConfig, background_tasks: BackgroundTasks
) -> Dict[str, Any]:
    """启动TAC规划任务（数据驱动型）"""
    try:
        task_id = await task_manager.create_tac_planning_task(config)
        return {
            "success": True,
            "data": {"taskId": task_id, "message": "TAC规划任务已启动"},
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
 
 
@router.get("/planning/progress/{task_id}", response_model=Dict[str, Any])
async def get_tac_planning_progress(task_id: str) -> Dict[str, Any]:
    """获取TAC规划任务进度"""
    try:
        progress = task_manager.get_task_progress(task_id)
        if not progress:
            raise HTTPException(status_code=404, detail="任务不存在")
        return {"success": True, "data": progress}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
 
 
@router.get("/planning/result/{task_id}", response_model=Dict[str, Any])
async def get_tac_planning_result_data(task_id: str) -> Dict[str, Any]:
    """获取TAC规划任务结果"""
    try:
        result = task_manager.get_task_result(task_id)
        if not result:
            raise HTTPException(status_code=404, detail="任务不存在")
        return {"success": True, "data": result}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
 
 
@router.get("/planning/export/{task_id}")
async def export_tac_planning_result_file(task_id: str, format: str = "xlsx"):
    """导出TAC规划任务结果"""
    try:
        # 从任务管理器获取任务结果 (使用统一的 export_result)
        # 或者使用专用的 export_tac_planning_result (如果需要特殊格式)
        from app.services.export_service import export_tac_planning_result
        result = task_manager.get_task_result(task_id)
        if not result:
            raise HTTPException(status_code=404, detail="任务不存在")
        return await export_tac_planning_result(task_id, result, format)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
