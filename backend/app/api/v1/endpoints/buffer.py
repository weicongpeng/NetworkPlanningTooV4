"""
绘制缓冲区 API 端点

POST   /plan              创建并启动任务（创建前逐 data_id 校验组访问权）
GET    /progress/{id}     查询进度
GET    /result/{id}       查询结果
"""
from typing import Optional
from typing_extensions import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

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


class BufferTargetBody(BaseModel):
    """缓冲图形保存目标：装饰图层或已有 MapInfo TAB 图层"""
    kind: Literal["decoration", "mapinfo"]
    dataId: Optional[str] = None
    layerId: Optional[str] = None


class BufferRequest(BaseModel):
    source: LayerRefBody
    target: BufferTargetBody
    radius: float = Field(..., gt=0, le=2_000_000)   # 米
    segments: int = Field(12, ge=4, le=360)         # 每圈段数
    mode: Literal["each", "dissolve"]               # 每要素 / 合并


@router.post("/plan")
async def create_buffer(req: BufferRequest, current_user=Depends(get_current_user)):
    """创建缓冲区任务，返回 taskId"""
    from app.services.data_service import data_service

    # 逐 data_id 校验组访问权（管理员同样按组隔离）；不通过返回 404，不泄露存在性
    refs = [req.source]
    if req.target.kind == "mapinfo":
        refs.append(req.target)
    for ref in refs:
        if ref.kind in ("mapinfo", "geodata"):
            if not ref.dataId or not data_service.check_access(ref.dataId, current_user):
                raise HTTPException(status_code=404, detail="所选图层不存在")

    cfg = {
        "source": req.source.dict(),
        "target": req.target.dict(),
        "radius": req.radius,
        "segments": req.segments,
        "mode": req.mode,
    }
    username = getattr(current_user, "username", "") or ""
    task_id = await task_manager.create_buffer_task(
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
