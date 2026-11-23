"""数据组入口鉴权依赖

按（地市+运营商）组校验用户对 `/{data_id}` 路由的访问权：
- 管理员放行；
- 普通用户仅可访问同组数据；
- 存量无标记数据（组信息 NULL）仅管理员；
- 失败一律 404（不泄露数据存在性）。
"""
from fastapi import Depends, HTTPException, Request

from app.core.security import get_current_user


async def require_data_group_access(data_id: str, current_user=Depends(get_current_user)):
    """FastAPI 依赖：校验 path 上 data_id 的组访问权，失败返回 404。

    与 get_current_user 共享同一请求级缓存，不产生额外鉴权开销。
    """
    from app.services.data_service import data_service  # 延迟导入避免服务层循环依赖
    if not data_service.check_access(data_id, current_user):
        raise HTTPException(status_code=404, detail="数据不存在")
    return current_user


def ensure_task_access(task_id: str, current_user) -> None:
    """校验当前用户可访问指定任务（（地市+运营商）组一致）。

    任务不存在 / 用户组缺失 / 跨组访问一律抛 404，避免通过响应差异探测任务存在性。
    """
    from app.services.data_group import user_group
    from app.services.task_manager import task_manager

    group = user_group(current_user)
    if group is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    task_group = task_manager.get_task_group(task_id)
    if task_group is None or task_group != group:
        raise HTTPException(status_code=404, detail="任务不存在")


async def require_task_access(request: Request, current_user=Depends(get_current_user)):
    """FastAPI 依赖：校验路径参数 task_id / apply_task_id 对应任务的组访问权。

    与 get_current_user 共享同一请求级缓存，不产生额外鉴权开销。
    """
    task_id = request.path_params.get("task_id") or request.path_params.get("apply_task_id")
    if not task_id:
        raise HTTPException(status_code=404, detail="任务不存在")
    ensure_task_access(task_id, current_user)
    return current_user
