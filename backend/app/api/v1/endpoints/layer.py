"""
图层制作 API 端点
"""
import json
import shutil
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, Form
from fastapi.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.security import require_data_import
from app.services.layer_service import LayerService

router = APIRouter()
layer_service = LayerService()


def _save_upload(file: Optional[UploadFile], file_path: Optional[str]) -> Path:
    """保存上传文件到临时目录，返回本地路径"""
    if not file and not file_path:
        raise HTTPException(status_code=400, detail="未提供文件")
    tmp_dir = settings.UPLOAD_DIR / "layers" / "_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    if file:
        name = f"src_{uuid.uuid4().hex[:8]}{Path(file.filename or 'src.xlsx').suffix}"
        dest = tmp_dir / name
        with open(dest, "wb") as f:
            f.write(file.file.read())
        return dest
    # file_path 模式（Electron 本地路径）
    src = Path(str(file_path).strip("\"'"))
    if not src.exists():
        raise HTTPException(status_code=400, detail=f"文件不存在: {src}")
    dest = tmp_dir / f"src_{uuid.uuid4().hex[:8]}{src.suffix}"
    shutil.copy2(src, dest)
    return dest


@router.post("/excel-info")
async def excel_info(
    file: Optional[UploadFile] = None,
    file_path: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """读取 Excel 的 sheet 列表和各 sheet 列名"""
    try:
        src = _save_upload(file, file_path)
        result = await run_in_threadpool(layer_service.get_sheet_info, str(src))
        return {"success": True, "data": result}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"解析失败: {str(e)}")


@router.post("/point")
async def generate_point(
    file: Optional[UploadFile] = None,
    file_path: Optional[str] = Form(None),
    sheet_name: str = Form(...),
    name_col: str = Form(...),
    lon_col: str = Form(...),
    lat_col: str = Form(...),
    attributes: str = Form("[]"),  # JSON 数组字符串
    output_format: str = Form("tab"),
    current_user=Depends(require_data_import),
):
    """生成点图层，返回下载 URL"""
    try:
        src = _save_upload(file, file_path)
        attr_list = json.loads(attributes) if attributes else []
        out = await run_in_threadpool(
            layer_service.generate_point_layer,
            str(src), sheet_name, name_col, lon_col, lat_col, attr_list, output_format,
        )
        return {"success": True, "data": {"filename": out.name, "download_url": f"/layer-files/{out.name}"}}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"生成失败: {str(e)}")


@router.post("/sector")
async def generate_sector(
    file: Optional[UploadFile] = None,
    file_path: Optional[str] = Form(None),
    sheet_name: str = Form(...),
    name_col: str = Form(...),
    lon_col: str = Form(...),
    lat_col: str = Form(...),
    azimuth_col: str = Form(...),
    radius_m: float = Form(3000.0),
    beamwidth: float = Form(40.0),
    attributes: str = Form("[]"),
    output_format: str = Form("tab"),
    current_user=Depends(require_data_import),
):
    """生成扇区图层，返回下载 URL"""
    try:
        src = _save_upload(file, file_path)
        attr_list = json.loads(attributes) if attributes else []
        out = await run_in_threadpool(
            layer_service.generate_sector_layer,
            str(src), sheet_name, name_col, lon_col, lat_col, azimuth_col,
            radius_m, beamwidth, attr_list, output_format,
        )
        return {"success": True, "data": {"filename": out.name, "download_url": f"/layer-files/{out.name}"}}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"生成失败: {str(e)}")
