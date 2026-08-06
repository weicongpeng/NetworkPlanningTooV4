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
    load_full_sites_from_data_sheet,
    match_sites,
    read_arbitrary_sheet,
    read_data_sheets,
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


@router.post("/data-sheets")
async def data_sheets(
    data_id: str = Form(...),
    current_user=Depends(require_data_import),
):
    """返回数据管理工参原始 Excel 的真实 sheet 列表（缺失时兜底网络分表）"""
    try:
        sheets, source = await run_in_threadpool(
            read_data_sheets, str(settings.DATA_DIR / data_id / "original.xlsx")
        )
        return {"success": True, "data": {"sheets": sheets, "source": source}}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"读取数据工作表失败: {str(e)}")


@router.post("/match")
async def match(
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    match_sheet_name: Optional[str] = Form(None),
    max_distance_km: float = Form(...),
    full_source: Optional[str] = Form(None),
    full_sheet_name: Optional[str] = Form(None),
    full_data_id: Optional[str] = Form(None),
    full_name_col: Optional[str] = Form(None),
    full_lon_col: Optional[str] = Form(None),
    full_lat_col: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """执行批量距离匹配：按所选 sheet 读取匹配/全量站点，返回下载 URL"""
    tmp, is_tmp = None, False
    try:
        if max_distance_km <= 0:
            raise HTTPException(status_code=400, detail="相邻距离门限必须大于 0")
        if not match_sheet_name or not match_sheet_name.strip():
            raise HTTPException(status_code=400, detail="匹配站点工作表名称不能为空")
        if not full_sheet_name or not full_sheet_name.strip():
            raise HTTPException(status_code=400, detail="全量站点工作表名称不能为空")
        if full_source not in ("file", "data"):
            raise HTTPException(status_code=400, detail="full_source 必须为 file 或 data")

        # 解析清单文件（上传或 file_path）
        tmp, is_tmp = _resolve_list_file(file, file_path)

        # 匹配站点：从导入文件所选 sheet 读取
        match_df = await run_in_threadpool(
            read_arbitrary_sheet, tmp, match_sheet_name,
        )

        # 全量站点：数据管理原始 Excel 的指定 sheet，或同一导入文件的指定 sheet
        if full_source == "data":
            if not full_data_id:
                raise HTTPException(status_code=400, detail="从数据管理读取全量站点需提供 full_data_id")
            full_df = await run_in_threadpool(
                load_full_sites_from_data_sheet,
                full_data_id, full_sheet_name,
                full_name_col, full_lon_col, full_lat_col,
            )
        else:
            full_df = await run_in_threadpool(
                read_arbitrary_sheet, tmp, full_sheet_name,
            )

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
