"""
PCI规划API端点
"""

import os
import uuid
import shutil
import re
import asyncio
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request, Query
from pydantic import ValidationError
from typing import Dict, Any, Optional
from app.models.schemas import PCIConfig, PCIResult, NetworkType
from app.services.task_manager import task_manager
from app.services.data_service import data_service
from app.core.config import settings
from app.core.security import get_current_user
from app.core.data_access import require_task_access, ensure_task_access

router = APIRouter()


@router.post("/plan", response_model=Dict[str, Any])
async def start_pci_planning(
    request: Request, background_tasks: BackgroundTasks,
    current_user=Depends(get_current_user),
) -> Dict[str, Any]:
    """启动PCI规划任务 - 增强参数验证"""
    try:
        # 手动解析和验证以提供更友好的错误消息
        body = await request.json()

        try:
            config = PCIConfig(**body)
        except ValidationError as e:
            # 提取验证错误并生成友好的错误消息
            errors = []
            for error in e.errors():
                loc = " -> ".join(str(l) for l in error["loc"])
                msg = error["msg"]
                errors.append(f"{loc}: {msg}")

            error_detail = "; ".join(errors)
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "参数验证失败",
                    "errors": error_detail
                }
            )

        # 提取任务名称（可选字段）
        task_name = body.get("taskName") if isinstance(body, dict) else None
        user_name = current_user.username if current_user else None

        # 创建任务（携带任务名称和当前用户名）
        task_id = await task_manager.create_pci_task(config, task_name=task_name, user_name=user_name)
        return {
            "success": True,
            "data": {"taskId": task_id, "message": "PCI规划任务已启动"},
        }
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))





@router.get("/progress/{task_id}", response_model=Dict[str, Any])
async def get_pci_progress(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """获取PCI规划进度（只返回状态/统计）"""
    try:
        progress = task_manager.get_task_progress_meta(task_id)
        if progress is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        return {"success": True, "data": progress}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/result/{task_id}", response_model=Dict[str, Any])
async def get_pci_result(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """获取PCI规划结果"""
    try:
        from starlette.concurrency import run_in_threadpool

        result = await run_in_threadpool(task_manager.get_task_result, task_id)
        if result is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        return {"success": True, "data": result}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export/{task_id}")
async def export_pci_result(task_id: str, format: str = "xlsx", _group=Depends(require_task_access)):
    """导出PCI规划结果"""
    from fastapi.responses import FileResponse
    from starlette.concurrency import run_in_threadpool

    # 检查任务是否存在（只取元数据，避免为状态判断加载完整结果）
    task_data = task_manager.get_task_progress_meta(task_id)
    if task_data is None:
        raise HTTPException(status_code=404, detail="任务不存在")

    # 检查任务是否完成
    if task_data.get("status") != "completed":
        raise HTTPException(status_code=400, detail=f"任务未完成（当前状态: {task_data.get('status', '未知')}）")

    # 执行导出
    file_path = await run_in_threadpool(task_manager.export_result, task_id, format)
    if file_path is None:
        raise HTTPException(status_code=500, detail="导出失败，请查看后端日志获取详细信息")

    filename = f"pci_result_{task_id}.{format}"
    return FileResponse(
        path=file_path, filename=filename, media_type="application/octet-stream"
    )


@router.delete("/task/{task_id}", response_model=Dict[str, Any])
async def cancel_pci_task(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """取消PCI规划任务"""
    try:
        result = task_manager.cancel_task(task_id)
        return {"success": result, "message": "任务已取消" if result else "取消失败"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/apply-to-params/{task_id}", response_model=Dict[str, Any])
async def apply_pci_to_params(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """
    将PCI规划结果应用到全量工参

    Phase 1（SQLite更新）通常 < 2 秒完成。
    Phase 2（Excel更新）在后台异步执行，用户无需等待。
    此端点会短轮询 Phase 1 最多 5 秒，尽快返回结果。
    """
    try:
        apply_task_id = await task_manager.create_apply_pci_to_params_task(task_id)

        # 短轮询 Phase 1（SQLite 快路径），最大等待 5 秒
        for _ in range(25):  # 25 * 0.2s = 5s
            await asyncio.sleep(0.2)
            progress = task_manager.get_task_progress(apply_task_id)
            if progress and progress.get("status") in ("completed", "failed"):
                result = task_manager.get_task_result(apply_task_id)
                return {
                    "success": True,
                    "data": {
                        "taskId": apply_task_id,
                        "result": result,
                        "message": result.get("message", "PCI应用完成") if result else "PCI应用完成"
                    }
                }

        # Phase 1 未在 5 秒内完成，返回 taskId 由前端轮询
        return {
            "success": True,
            "data": {
                "taskId": apply_task_id,
                "message": "PCI应用到工参任务已启动，SQLite更新中..."
            }
        }
    except ValueError as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=400, detail=safe_detail)
    except Exception as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.post("/apply-batch", response_model=Dict[str, Any])
async def apply_pci_batch(request: Dict[str, Any], current_user=Depends(get_current_user)) -> Dict[str, Any]:
    """
    批量将多个PCI规划结果应用到全量工参

    收集所有指定任务的规划结果，合并后一次性更新SQLite和Excel。
    相比逐个应用，避免了重复的文件IO和DB操作，大幅提升效率。
    """
    try:
        task_ids = request.get("taskIds", [])
        if not task_ids or not isinstance(task_ids, list):
            raise HTTPException(status_code=400, detail="请提供有效的taskIds列表")
        # 跨组隔离：仅允许应用本组任务
        for _tid in task_ids:
            ensure_task_access(_tid, current_user)

        apply_task_id = await task_manager.create_apply_pci_batch_task(task_ids)

        # 短轮询 Phase 1（SQLite 快路径），最大等待 10 秒
        for _ in range(50):  # 50 * 0.2s = 10s
            await asyncio.sleep(0.2)
            progress = task_manager.get_task_progress(apply_task_id)
            if progress and progress.get("status") in ("completed", "failed"):
                result = task_manager.get_task_result(apply_task_id)
                return {
                    "success": True,
                    "data": {
                        "taskId": apply_task_id,
                        "result": result,
                        "message": result.get("message", "PCI批量应用完成") if result else "PCI批量应用完成"
                    }
                }

        return {
            "success": True,
            "data": {
                "taskId": apply_task_id,
                "message": "PCI批量应用到工参任务已启动..."
            }
        }
    except ValueError as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=400, detail=safe_detail)
    except HTTPException:
        raise
    except Exception as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)


@router.get("/apply-to-params/progress/{apply_task_id}", response_model=Dict[str, Any])
async def get_apply_pci_progress(apply_task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """获取PCI应用到工参任务进度"""
    try:
        progress = task_manager.get_task_progress(apply_task_id)
        if progress is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        return {"success": True, "data": progress}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/history", response_model=Dict[str, Any])
async def get_pci_history(
    page: int = Query(1, ge=1, description="页码（从 1 开始）"),
    page_size: int = Query(20, ge=1, le=100, description="每页条数"),
    current_user=Depends(get_current_user),
) -> Dict[str, Any]:
    """获取 PCI 规划历史任务列表（分页，按地市+运营商组隔离）"""
    try:
        results = task_manager.list_task_history(task_type="pci", page=page, page_size=page_size, user=current_user)
        return {"success": True, "data": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/history/{task_id}", response_model=Dict[str, Any])
async def delete_pci_history(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """删除指定的 PCI 规划历史任务"""
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


@router.get("/apply-to-params/result/{apply_task_id}", response_model=Dict[str, Any])
async def get_apply_pci_result(apply_task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """获取PCI应用到工参结果"""
    try:
        result = task_manager.get_task_result(apply_task_id)
        if result is None:
            raise HTTPException(status_code=404, detail="任务不存在或未完成")
        return {"success": True, "data": result}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/history/{task_id}/mark-applied", response_model=Dict[str, Any])
async def mark_pci_task_applied(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """标记PCI规划任务为已应用（跨用户共享），同时清除地图缓存"""
    try:
        success = task_manager.mark_task_applied(task_id)
        if not success:
            raise HTTPException(status_code=404, detail="任务不存在")
        # 清除后端地图缓存，使扇区属性更新生效
        try:
            import app.api.v1.endpoints.map as map_module
            map_module.invalidate_map_data_cache()
        except Exception:
            pass
        from app.services.mapinfo_service import clear_layer_cache
        clear_layer_cache()
        return {"success": True, "data": {"message": "任务已标记为已应用"}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
