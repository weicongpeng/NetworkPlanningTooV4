"""
条件选择（图层属性空间连接）API 端点

POST   /plan              创建并启动任务（创建前逐 data_id 校验组访问权）
GET    /progress/{id}     查询进度
GET    /result/{id}       查询结果
GET    /download/{id}     下载 xlsx（文件名由前端指定）
"""
from typing import Optional
from typing_extensions import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.core.data_access import require_task_access
from app.core.security import get_current_user
from app.services.task_manager import task_manager

router = APIRouter()


class LayerRefBody(BaseModel):
    """图层引用：kind 决定来源与取数方式"""
    kind: Literal["sector", "mapinfo", "geodata"]
    dataId: Optional[str] = None        # mapinfo / geodata 的数据集 id
    layerId: Optional[str] = None       # mapinfo 的图层 id
    networkType: Optional[str] = None   # sector: LTE / NR / all


class JoinRequest(BaseModel):
    layer1: LayerRefBody
    condition: Literal["within"] = "within"  # 目前仅支持"在...之内"
    layer2: LayerRefBody


@router.post("/plan")
async def create_join(req: JoinRequest, current_user=Depends(get_current_user)):
    """创建条件选择任务，返回 taskId"""
    from app.services.data_service import data_service

    # 逐 data_id 校验组访问权（管理员同样按组隔离）；不通过返回 404，不泄露存在性
    refs = [req.layer1, req.layer2]
    for ref in refs:
        if ref.kind in ("mapinfo", "geodata"):
            if not ref.dataId or not data_service.check_access(ref.dataId, current_user):
                raise HTTPException(status_code=404, detail="所选图层不存在")

    cfg = {"layer1": req.layer1.dict(), "condition": req.condition, "layer2": req.layer2.dict()}
    username = getattr(current_user, "username", "") or ""
    task_id = await task_manager.create_attribute_join_task(
        cfg, username=username,
        city=getattr(current_user, "city", None),
        operator=getattr(current_user, "operator", None),
    )
    return {"success": True, "data": {"taskId": task_id}}


@router.get("/progress/{task_id}")
async def get_progress(task_id: str, _user=Depends(require_task_access)):
    """任务进度（完成时返回 result，否则返回状态/进度）"""
    data = task_manager.get_task_progress(task_id)
    if data is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {"success": True, "data": data}


@router.get("/result/{task_id}")
async def get_result(task_id: str, _user=Depends(require_task_access)):
    """任务结果"""
    data = task_manager.get_task_result(task_id)
    if data is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {"success": True, "data": data}


@router.get("/download/{task_id}")
async def download_file(task_id: str, _user=Depends(require_task_access)):
    """下载条件选择 Excel（不设 filename，由前端 a.download 命名）"""
    result = task_manager.get_task_result(task_id)
    if not result:
        raise HTTPException(status_code=404, detail="任务结果不存在")
    export_path = result.get("exportPath")
    if not export_path:
        raise HTTPException(status_code=404, detail="结果文件不存在")

    from pathlib import Path
    path = Path(export_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="结果文件已被清理，请重新执行条件选择")

    return FileResponse(
        path=str(path),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
