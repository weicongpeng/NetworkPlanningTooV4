"""
TAC规划API端点
"""

import asyncio
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request
from typing import Dict, Any
from datetime import datetime
from app.models.schemas import TACConfig, TACResult
from app.services.task_manager import task_manager
from app.core.security import get_current_user

router = APIRouter()


@router.post("/plan", response_model=Dict[str, Any])
async def start_tac_planning(
    request: Request, background_tasks: BackgroundTasks,
    current_user=Depends(get_current_user),
) -> Dict[str, Any]:
    """启动TAC核查任务"""
    try:
        body = await request.json()
        config = TACConfig(**body)
        user_name = current_user.username if current_user else ""
        # 优先使用前端传入的用户自定义任务名称
        task_name = body.get("taskName") if isinstance(body, dict) else None
        if not task_name:
            task_name = f"TAC核查 - {datetime.now().strftime('%m/%d %H:%M')}"
        task_id = await task_manager.create_tac_task(config, task_name=task_name, user_name=user_name)
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


@router.delete("/history/{task_id}", response_model=Dict[str, Any])
async def delete_tac_history(task_id: str) -> Dict[str, Any]:
    """删除指定的 TAC 核查历史任务"""
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
async def get_tac_history() -> Dict[str, Any]:
    """获取所有用户的 TAC 核查历史任务列表"""
    try:
        results = task_manager.list_task_history(task_type="tac")
        return {"success": True, "data": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/planning/plan", response_model=Dict[str, Any])
async def start_tac_planning_task(
    request: Request, background_tasks: BackgroundTasks,
    current_user=Depends(get_current_user),
) -> Dict[str, Any]:
    """启动TAC规划任务（数据驱动型）"""
    try:
        body = await request.json()
        config = TACConfig(**body)
        user_name = current_user.username if current_user else ""
        # 优先使用前端传入的用户自定义任务名称
        task_name = body.get("taskName") if isinstance(body, dict) else None
        if not task_name:
            task_name = f"TAC规划 - {datetime.now().strftime('%m/%d %H:%M')}"
        task_id = await task_manager.create_tac_planning_task(config, task_name=task_name, user_name=user_name)
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


@router.delete("/planning/history/{task_id}", response_model=Dict[str, Any])
async def delete_tac_planning_history(task_id: str) -> Dict[str, Any]:
    """删除指定的 TAC 规划历史任务"""
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


@router.get("/planning/history", response_model=Dict[str, Any])
async def get_tac_planning_history() -> Dict[str, Any]:
    """获取所有用户的 TAC 规划历史任务列表"""
    try:
        results = task_manager.list_task_history(task_type="tac_planning")
        return {"success": True, "data": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/planning/apply-to-params/{task_id}", response_model=Dict[str, Any])
async def apply_tac_planning_to_params(task_id: str) -> Dict[str, Any]:
    """
    将TAC规划结果应用到全量工参

    Phase 1（SQLite更新）通常 < 2 秒完成。
    Phase 2（Excel更新）在后台异步执行，用户无需等待。
    此端点会短轮询 Phase 1 最多 5 秒，尽快返回结果。
    """
    try:
        apply_task_id = await task_manager.create_apply_tac_planning_to_params_task(task_id)

        # 短轮询 Phase 1（最大等待 5 秒）
        for _ in range(25):
            await asyncio.sleep(0.2)
            progress = task_manager.get_task_progress(apply_task_id)
            if progress and progress.get("status") in ("completed", "failed"):
                result = task_manager.get_task_result(apply_task_id)
                return {
                    "success": True,
                    "data": {
                        "taskId": apply_task_id,
                        "result": result,
                        "message": result.get("message", "TAC应用完成") if result else "TAC应用完成"
                    }
                }

        return {
            "success": True,
            "data": {
                "taskId": apply_task_id,
                "message": "TAC规划应用到工参任务已启动，SQLite更新中..."
            }
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/planning/apply-to-params/progress/{apply_task_id}", response_model=Dict[str, Any])
async def get_apply_tac_planning_progress(apply_task_id: str) -> Dict[str, Any]:
    """获取TAC规划应用到工参任务进度"""
    try:
        progress = task_manager.get_task_progress(apply_task_id)
        if progress is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        return {"success": True, "data": progress}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/planning/apply-to-params/result/{apply_task_id}", response_model=Dict[str, Any])
async def get_apply_tac_planning_result(apply_task_id: str) -> Dict[str, Any]:
    """获取TAC规划应用到工参结果"""
    try:
        result = task_manager.get_task_result(apply_task_id)
        if result is None:
            raise HTTPException(status_code=404, detail="任务不存在或未完成")
        return {"success": True, "data": result}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/planning/history/{task_id}/mark-applied", response_model=Dict[str, Any])
async def mark_tac_planning_task_applied(task_id: str) -> Dict[str, Any]:
    """标记TAC规划任务为已应用（跨用户共享），同时清除地图缓存"""
    try:
        success = task_manager.mark_task_applied(task_id)
        if not success:
            raise HTTPException(status_code=404, detail="任务不存在")
        # 清除后端地图缓存，使扇区属性更新生效
        try:
            import app.api.v1.endpoints.map as map_module
            map_module._map_data_cache = None
            map_module._map_data_cache_time = 0
        except Exception:
            pass
        from app.services.mapinfo_service import clear_layer_cache
        clear_layer_cache()
        return {"success": True, "data": {"message": "任务已标记为已应用"}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
