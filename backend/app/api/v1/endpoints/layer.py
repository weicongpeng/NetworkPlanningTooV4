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

# 允许的输入文件扩展名（工参 Excel）
ALLOWED_EXTS = {".xlsx", ".xls"}


def _save_upload(file: Optional[UploadFile], file_path: Optional[str]) -> Path:
    """保存上传文件到临时目录，返回本地路径

    临时目录为 `uploads/layer_tmp`（layers 的兄弟目录，不在 /layer-files 挂载树内），
    避免原始工参文件被未认证下载。调用方负责在 finally 中删除返回的临时文件。
    """
    if not file and not file_path:
        raise HTTPException(status_code=400, detail="未提供文件")
    tmp_dir = settings.UPLOAD_DIR / "layer_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    if file:
        suffix = Path(file.filename or "src.xlsx").suffix.lower()
        if suffix not in ALLOWED_EXTS:
            raise HTTPException(status_code=400, detail="仅支持 Excel 文件（.xlsx/.xls）")
        name = f"src_{uuid.uuid4().hex[:8]}{suffix}"
        dest = tmp_dir / name
        with open(dest, "wb") as f:
            f.write(file.file.read())
        return dest
    # file_path 模式（Electron 本地路径）
    src = Path(str(file_path).strip("\"'"))
    if not src.is_file():
        raise HTTPException(status_code=400, detail=f"文件不存在: {src.name}")
    if src.suffix.lower() not in ALLOWED_EXTS:
        raise HTTPException(status_code=400, detail="仅支持 Excel 文件（.xlsx/.xls）")
    dest = tmp_dir / f"src_{uuid.uuid4().hex[:8]}{src.suffix.lower()}"
    shutil.copy2(src, dest)
    return dest


@router.post("/excel-info")
async def excel_info(
    file: Optional[UploadFile] = None,
    file_path: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """读取 Excel 的 sheet 列表和各 sheet 列名"""
    src = None
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
    finally:
        if src is not None:
            src.unlink(missing_ok=True)


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
    src = None
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
    finally:
        if src is not None:
            src.unlink(missing_ok=True)


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
    src = None
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
    finally:
        if src is not None:
            src.unlink(missing_ok=True)
