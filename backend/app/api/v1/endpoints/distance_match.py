"""批量距离匹配 API 端点"""
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from app.core.config import settings
from app.core.security import require_data_import
from app.services.distance_match_service import (
    build_output_excel,
    build_output_filename,
    load_full_params_from_data,
    match_sites,
    read_data_sheets,
    read_full_sheet_only,
    read_match_file,
    validate_all,
)

router = APIRouter()

# 仅支持 Excel 多 sheet 格式（calamine 引擎不支持 CSV/TXT）
ALLOWED_EXTS = {".xlsx", ".xls"}

TEMPLATE_FILENAME = "站点匹配清单-模板.xlsx"


def _save_upload_file(file: UploadFile) -> str:
    """保存上传文件到临时目录，返回路径。调用方 finally 删除。"""
    suffix = Path(file.filename or "list.xlsx").suffix.lower()
    if suffix not in ALLOWED_EXTS:
        raise HTTPException(status_code=400, detail="仅支持 Excel 文件（.xlsx/.xls）")
    tmp_dir = settings.UPLOAD_DIR / "distance_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    dest = tmp_dir / f"src_{datetime.now().strftime('%Y%m%d%H%M%S%f')}{suffix}"
    with open(dest, "wb") as f:
        f.write(file.file.read())
    return str(dest)


def _resolve_list_file(file: Optional[UploadFile], file_path: Optional[str]) -> tuple:
    """解析清单文件来源：上传文件保存临时路径，或 file_path 直用。
    返回 (路径, 是否为本端点自建临时文件)。"""
    if file:
        return _save_upload_file(file), True
    if file_path:
        p = file_path.strip("\"'")
        if not Path(p).is_file():
            raise HTTPException(status_code=400, detail=f"文件不存在: {Path(p).name}")
        return p, False
    raise HTTPException(status_code=400, detail="未提供文件")


@router.post("/parse")
async def parse(
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """解析并校验上传的清单（含「匹配站点」「全量站点」两个 sheet）"""
    tmp, is_tmp = None, False
    try:
        tmp, is_tmp = _resolve_list_file(file, file_path)
        sheets = await run_in_threadpool(read_match_file, tmp)
        errors = validate_all(sheets["匹配站点"], sheets["全量站点"])
        return {
            "success": len(errors) == 0,
            "data": {
                "match_total": len(sheets["匹配站点"]),
                "full_total": len(sheets["全量站点"]),
                "errors": errors,
            },
        }
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"解析失败: {str(e)}")
    finally:
        if is_tmp and tmp:
            Path(tmp).unlink(missing_ok=True)


# 数据管理工参 dict 中的元数据键（网络分表键除外）
METADATA_KEYS = {"id", "name", "fileType", "status", "errorMessage", "message"}


@router.post("/data-sheets")
async def data_sheets(
    data_id: str = Form(...),
    current_user=Depends(require_data_import),
):
    """读取数据管理工参的 sheet 列表（数据管理来源的全量站点 sheet 下拉）"""
    try:
        data_dir = settings.DATA_DIR / data_id
        original = data_dir / "original.xlsx"
        if original.is_file():
            sheets, _ = await run_in_threadpool(read_data_sheets, str(original))
            return {"success": True, "data": {"sheets": sheets, "source": "excel"}}
        # 兜底：原始 Excel 缺失 → 网络分表键（data.json 已解析成 LTE/NR 分表）
        from app.services.data_service import data_service
        data = data_service.get_data(data_id)
        if isinstance(data, dict):
            keys = [k for k in data.keys() if isinstance(k, str) and k not in METADATA_KEYS]
            if keys:
                return {"success": True, "data": {"sheets": keys, "source": "network"}}
        return {"success": True, "data": {"sheets": ["LTE", "NR"], "source": "network"}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取数据工作表失败: {str(e)}")


@router.post("/match")
async def match(
    file: Optional[UploadFile] = File(None),
    match_file_path: Optional[str] = Form(None),
    max_distance_km: float = Form(...),
    full_file_path: Optional[str] = Form(None),
    full_data_id: Optional[str] = Form(None),
    full_network_type: Optional[str] = Form(None),
    full_name_col: Optional[str] = Form(None),
    full_lon_col: Optional[str] = Form(None),
    full_lat_col: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """执行批量距离匹配，返回下载 URL"""
    tmp, is_tmp = None, False
    try:
        if max_distance_km <= 0:
            raise HTTPException(status_code=400, detail="相邻距离门限必须大于 0")

        # 匹配站点清单（上传文件）
        tmp, is_tmp = _resolve_list_file(file, match_file_path)

        # 读取清单：包含「匹配站点」「全量站点」两个 sheet
        sheets = await run_in_threadpool(read_match_file, tmp)
        match_df = sheets["匹配站点"]
        full_df = sheets["全量站点"]

        # 全量站点来源二选一：上传文件 或 数据管理工参
        if full_file_path:
            full_path = full_file_path.strip("\"'")
            if not Path(full_path).is_file():
                raise HTTPException(status_code=400, detail=f"全量站点文件不存在: {Path(full_path).name}")
            # 全量站点工参只要求「全量站点」sheet（不要求「匹配站点」sheet）
            full_df = await run_in_threadpool(read_full_sheet_only, full_path)
        elif full_data_id:
            if not (full_name_col and full_lon_col and full_lat_col):
                raise HTTPException(status_code=400, detail="从数据管理读取全量站点需提供列映射")
            full_df = await run_in_threadpool(
                load_full_params_from_data,
                full_data_id, full_network_type or "LTE",
                full_name_col, full_lon_col, full_lat_col,
            )
        # 否则用清单内的「全量站点」sheet

        # 校验（两种来源统一）
        errors = validate_all(match_df, full_df)
        if errors:
            return {"success": False, "data": {"errors": errors}}

        results, unmatched = await run_in_threadpool(match_sites, match_df, full_df, max_distance_km)

        settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        filename = build_output_filename()
        out_path = settings.OUTPUT_DIR / filename
        await run_in_threadpool(build_output_excel, str(out_path), match_df, results, unmatched)

        return {"success": True, "data": {"filename": filename, "download_url": f"/static/{filename}"}}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"匹配失败: {str(e)}")
    finally:
        if is_tmp and tmp:
            Path(tmp).unlink(missing_ok=True)


@router.get("/template")
async def template(current_user=Depends(require_data_import)):
    """下载站点匹配清单模板"""
    template_path = settings.TEMPLATE_DIR / TEMPLATE_FILENAME
    if not template_path.is_file():
        raise HTTPException(status_code=404, detail="模板文件不存在")
    return FileResponse(
        path=str(template_path),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=TEMPLATE_FILENAME,
    )
