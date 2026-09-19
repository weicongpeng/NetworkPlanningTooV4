"""网优助手 API

- POST   /assistant/datasets/upload  上传基站参数/指标文件（后台解析入库）
- GET    /assistant/datasets         数据集列表
- DELETE /assistant/datasets/{id}    删除数据集（含行数据与文件）
- POST   /assistant/chat             对话（function calling）
- GET    /assistant/config           模型配置状态
"""
import logging
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.security import require_assistant
from app.services.assistant import chat_service, ingest_service, llm_client, llm_config

router = APIRouter()
logger = logging.getLogger(__name__)

_UPLOAD_STATUS: Dict[str, Dict[str, Any]] = {}


@router.get("/config")
async def get_config(current_user=Depends(require_assistant)) -> Dict[str, Any]:
    """大模型配置（api_key 脱敏，不回传明文）"""
    pub = llm_config.public_config()
    return {"configured": llm_client.is_configured(), **pub}


@router.put("/config")
async def update_config(payload: Dict[str, Any], current_user=Depends(require_assistant)) -> Dict[str, Any]:
    """保存大模型配置（需导入/管理权限）。api_key 传空串表示不修改。"""
    allowed = {k: payload[k] for k in ("protocol", "base_url", "api_key", "model", "timeout") if k in payload}
    if "timeout" in allowed:
        try:
            allowed["timeout"] = max(5, int(allowed["timeout"]))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="超时必须是整数秒")
    llm_config.save_config(allowed)
    return {"success": True, "config": llm_config.public_config(),
            "configured": llm_client.is_configured()}


@router.post("/config/test")
async def test_config(current_user=Depends(require_assistant)) -> Dict[str, Any]:
    """用当前配置发一条极简对话，验证连通性"""
    try:
        msg = llm_client.chat(
            [{"role": "user", "content": "ping，回复 OK"}], tools=None, temperature=0)
        return {"success": True, "reply": (msg.get("content") or "")[:50]}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/datasets/upload")
async def upload_dataset(
    file: UploadFile = File(...),
    data_type: str = Form(...),  # station_params / station_metrics
    current_user=Depends(require_assistant),
):
    if data_type not in (ingest_service.PARAM_TYPE, ingest_service.METRIC_TYPE):
        raise HTTPException(status_code=400, detail="data_type 必须是 station_params 或 station_metrics")

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in (".xlsx", ".xls", ".csv", ".txt"):
        raise HTTPException(status_code=400, detail="仅支持 .xlsx/.xls/.csv/.txt 文件")

    # 落临时文件，后台线程解析
    tmp = Path(tempfile.mkdtemp(dir=str(settings.UPLOAD_DIR))) / f"raw{suffix}"
    tmp.write_bytes(await file.read())
    uid = current_user.id if hasattr(current_user, "id") else None

    async def _process():
        try:
            result = await run_in_threadpool(
                ingest_service.ingest_file, str(tmp), file.filename, uid,
                current_user.city, current_user.operator)
            _UPLOAD_STATUS[file.filename] = {"status": "ready", "result": result}
        except Exception as e:
            logger.exception("assistant ingest failed")
            _UPLOAD_STATUS[file.filename] = {"status": "error", "error": str(e)}

    _UPLOAD_STATUS[file.filename] = {"status": "processing"}
    import asyncio
    asyncio.create_task(_process())

    return {"success": True, "filename": file.filename, "status": "processing",
            "pollKey": file.filename}


@router.get("/datasets/upload-status")
async def upload_status(poll_key: str, current_user=Depends(require_assistant)) -> Dict[str, Any]:
    st = _UPLOAD_STATUS.get(poll_key)
    if not st:
        return {"status": "unknown"}
    return st


@router.get("/datasets")
async def list_datasets(current_user=Depends(require_assistant)) -> Dict[str, Any]:
    items = ingest_service.list_datasets(current_user)
    return {"success": True, "data": items, "total": len(items)}


@router.delete("/datasets/{dataset_id}")
async def delete_dataset(dataset_id: str, current_user=Depends(require_assistant)) -> Dict[str, Any]:
    ok = ingest_service.delete_dataset(dataset_id)
    if not ok:
        raise HTTPException(status_code=404, detail="数据集不存在或类型不匹配")
    return {"success": True}


@router.post("/chat")
async def chat(payload: Dict[str, Any], current_user=Depends(require_assistant)) -> Dict[str, Any]:
    history: List[Dict[str, str]] = payload.get("messages") or []
    # 只保留 role/content，过滤异常结构
    history = [{"role": m.get("role", "user"), "content": m.get("content", "")}
               for m in history if m.get("content")]
    if not history:
        raise HTTPException(status_code=400, detail="消息不能为空")
    try:
        result = await run_in_threadpool(chat_service.chat, history, current_user)
        return {"success": True, **result}
    except Exception as e:
        logger.exception("assistant chat failed")
        raise HTTPException(status_code=500, detail=str(e))
