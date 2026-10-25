"""
PCI核查API端点
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from typing import Dict, Any
from datetime import datetime
from app.models.schemas import PCICheckConfig
from app.services.task_manager import task_manager
from app.core.security import get_current_user
from app.core.data_access import require_task_access

router = APIRouter()


@router.post("/plan", response_model=Dict[str, Any])
async def start_pci_check(
    request: Request,
    current_user=Depends(get_current_user),
) -> Dict[str, Any]:
    """启动PCI核查任务"""
    try:
        body = await request.json()
        config = PCICheckConfig(**body)
        user_name = current_user.username if current_user else ""
        task_name = body.get("taskName") if isinstance(body, dict) else None
        if not task_name:
            task_name = f"PCI核查 - {datetime.now().strftime('%m/%d %H:%M')}"
        task_id = await task_manager.create_pci_check_task(config, task_name=task_name, user_name=user_name)
        return {
            "success": True,
            "data": {"taskId": task_id, "message": "PCI核查任务已启动"},
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/progress/{task_id}", response_model=Dict[str, Any])
async def get_pci_check_progress(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """获取PCI核查进度（只返回状态/统计）"""
    try:
        progress = task_manager.get_task_progress_meta(task_id)
        if not progress:
            raise HTTPException(status_code=404, detail="任务不存在")
        return {"success": True, "data": progress}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/result/{task_id}", response_model=Dict[str, Any])
async def get_pci_check_result(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """获取PCI核查结果"""
    try:
        from starlette.concurrency import run_in_threadpool

        result = await run_in_threadpool(task_manager.get_task_result, task_id)
        if not result:
            raise HTTPException(status_code=404, detail="任务结果不存在")
        return {"success": True, "data": result}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export/{task_id}")
async def export_pci_check_result(
    task_id: str,
    format: str = "xlsx",
    check_type: str = Query(None, alias="checkType", description="CSV 导出时必填的核查类型"),
    _group=Depends(require_task_access),
):
    """导出PCI核查结果（xlsx 每类一个 sheet，csv 按 checkType 单类导出）"""
    try:
        from starlette.concurrency import run_in_threadpool

        result = await run_in_threadpool(task_manager.get_task_result, task_id)
        if not result:
            raise HTTPException(status_code=404, detail="任务不存在")

        from app.services.export_service import export_pci_check_result as do_export

        return await do_export(task_id, result, format, check_type)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/history/{task_id}", response_model=Dict[str, Any])
async def delete_pci_check_history(task_id: str, _group=Depends(require_task_access)) -> Dict[str, Any]:
    """删除指定的 PCI 核查历史任务"""
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
async def get_pci_check_history(
    page: int = Query(1, ge=1, description="页码（从 1 开始）"),
    page_size: int = Query(20, ge=1, le=100, description="每页条数"),
    current_user=Depends(get_current_user),
) -> Dict[str, Any]:
    """获取 PCI 核查历史任务列表（分页，按地市+运营商组隔离）"""
    try:
        results = task_manager.list_task_history(
            task_type="pci_check", page=page, page_size=page_size, user=current_user
        )
        return {"success": True, "data": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
