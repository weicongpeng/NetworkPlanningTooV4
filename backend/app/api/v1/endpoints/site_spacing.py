"""平均站间距计算 API 端点"""
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from app.core.config import settings
from app.core.security import require_data_import
from app.services.distance_match_service import (
    load_full_sites_from_data_sheet,
    read_arbitrary_sheet,
    read_data_sheets,
)
from app.services.site_spacing_service import (
    build_output_excel,
    build_output_filename,
    compute_avg_spacing,
    compute_overall_stats,
    read_sites_file,
    validate_sites_file,
)

router = APIRouter()

# 支持：Excel（calamine 引擎）+ CSV/TXT（自动编码探测）
ALLOWED_EXTS = {".xlsx", ".xls", ".csv", ".txt"}
TEMPLATE_FILENAME = "站间距计算-模板.xlsx"


def _save_upload_file(file: UploadFile) -> str:
    """保存上传文件到临时目录，返回路径。调用方 finally 删除。"""
    suffix = Path(file.filename or "sites.xlsx").suffix.lower()
    if suffix not in ALLOWED_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"仅支持以下格式：{', '.join(sorted(ALLOWED_EXTS))}",
        )
    tmp_dir = settings.UPLOAD_DIR / "site_spacing_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    dest = tmp_dir / f"src_{datetime.now().strftime('%Y%m%d%H%M%S%f')}{suffix}"
    with open(dest, "wb") as f:
        f.write(file.file.read())
    return str(dest)


def _resolve_sites_file(file: Optional[UploadFile], file_path: Optional[str]) -> tuple:
    """解析站点文件来源：上传文件保存临时路径，或 file_path 直用。
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
    """解析并校验上传的站点文件（仅校验，不计算）"""
    tmp, is_tmp = None, False
    try:
        tmp, is_tmp = _resolve_sites_file(file, file_path)
        errors, total = await run_in_threadpool(_parse_and_count, tmp)
        return {
            "success": len(errors) == 0,
            "data": {
                "total": total,
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


def _parse_and_count(file_path: str) -> tuple:
    """返回 (errors, total)"""
    errors = validate_sites_file(file_path)
    # total = 解析后 df 行数（去重前），给前端展示
    df = read_sites_file(file_path)
    return errors, len(df)


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


@router.post("/calculate")
async def calculate(
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    k: int = Form(...),
    full_source: str = Form(...),
    full_sheet_name: str = Form(...),
    full_data_id: Optional[str] = Form(None),
    full_name_col: Optional[str] = Form(None),
    full_lon_col: Optional[str] = Form(None),
    full_lat_col: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """执行平均站间距计算：按所选来源读取站点，KNN 站间距，返回下载 URL

    full_source=file: 从 file/file_path 读取（与 match 站点同源）
    full_source=data: 从数据管理工参的 full_data_id + full_sheet_name 读取
    """
    tmp, is_tmp = None, False
    try:
        if k <= 0:
            raise HTTPException(status_code=400, detail="最近站点数必须大于 0")
        if full_source not in ("file", "data"):
            raise HTTPException(status_code=400, detail="full_source 必须为 file 或 data")

        # 解析来源
        if full_source == "data":
            if not full_data_id:
                raise HTTPException(status_code=400, detail="从数据管理读取站点需提供 full_data_id")
            if not full_sheet_name or not full_sheet_name.strip():
                raise HTTPException(status_code=400, detail="工作表名称不能为空")
            df = await run_in_threadpool(
                load_full_sites_from_data_sheet,
                full_data_id, full_sheet_name,
                full_name_col, full_lon_col, full_lat_col,
            )
        else:
            if not full_sheet_name or not full_sheet_name.strip():
                raise HTTPException(status_code=400, detail="工作表名称不能为空")
            tmp, is_tmp = _resolve_sites_file(file, file_path)
            df = await run_in_threadpool(
                read_arbitrary_sheet, tmp, full_sheet_name,
            )

        if len(df) < 2:
            raise HTTPException(
                status_code=400,
                detail=f"有效站点数 {len(df)} 不足以计算站间距（至少需要 2 个）",
            )

        cells = df["CELL"].tolist()
        lons = df["LON"].astype(float).tolist()
        lats = df["LAT"].astype(float).tolist()

        results = await run_in_threadpool(compute_avg_spacing, cells, lons, lats, k)
        stats = await run_in_threadpool(compute_overall_stats, results)

        settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        filename = build_output_filename()
        out_path = settings.OUTPUT_DIR / filename
        await run_in_threadpool(build_output_excel, str(out_path), results, stats)

        return {
            "success": True,
            "data": {
                "filename": filename,
                "download_url": f"/static/{filename}",
                "total": stats["total"],
                "counted": stats["counted"],
                "overall_avg_km": stats["overall_avg_km"],
                "k": k,
            },
        }
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"计算失败: {str(e)}")
    finally:
        if is_tmp and tmp:
            Path(tmp).unlink(missing_ok=True)


@router.get("/template")
async def template(current_user=Depends(require_data_import)):
    """下载平均站间距计算模板"""
    template_path = settings.TEMPLATE_DIR / TEMPLATE_FILENAME
    if not template_path.is_file():
        raise HTTPException(status_code=404, detail="模板文件不存在")
    return FileResponse(
        path=str(template_path),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=TEMPLATE_FILENAME,
    )
