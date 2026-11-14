# backend/app/api/v1/endpoints/table_merge.py
"""表格合并 API 端点

- POST /api/v1/table-merge/inspect：上传多个表格文件，返回每个文件的工作表与合并分组预览
- POST /api/v1/table-merge/merge：按分组合并并输出单个 Excel（/static 下载）
"""
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Tuple

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.security import require_data_import
from app.services.table_merge_service import (
    ALLOWED_EXTS,
    MERGE_MODES,
    MODE_STRUCTURE,
    SourceTable,
    build_output_filename,
    plan_merge,
    read_tables,
    write_merged_workbook,
)

router = APIRouter()


def _save_uploads(files: List[UploadFile]) -> List[Tuple[str, Path]]:
    """保存上传文件到临时目录，返回 [(原始文件名, 路径)]。"""
    tmp_dir = settings.UPLOAD_DIR / "table_merge_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    saved: List[Tuple[str, Path]] = []
    for idx, file in enumerate(files):
        name = (file.filename or f"table{idx + 1}").strip()
        suffix = Path(name).suffix.lower()
        if suffix not in ALLOWED_EXTS:
            raise HTTPException(
                status_code=400,
                detail=f"仅支持以下格式：{', '.join(sorted(ALLOWED_EXTS))}（不支持 {name}）",
            )
        dest = tmp_dir / f"src_{stamp}_{idx}{suffix}"
        with open(dest, "wb") as f:
            f.write(file.file.read())
        saved.append((name, dest))
    return saved


def _cleanup(paths: List[Path]) -> None:
    for path in paths:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass


def _read_all(saved: List[Tuple[str, Path]]) -> Tuple[List[SourceTable], List[Dict[str, str]], List[Dict[str, Any]]]:
    """读取所有文件的表；单个文件失败不影响其余文件。

    返回 (所有表, 读取失败的文件, 每个文件的工作表概览)。
    """
    tables: List[SourceTable] = []
    errors: List[Dict[str, str]] = []
    file_summaries: List[Dict[str, Any]] = []
    for name, path in saved:
        try:
            file_tables = read_tables(name, path)
        except Exception as e:  # noqa: BLE001 - 单文件解析失败降级为提示
            errors.append({"file_name": name, "error": str(e)})
            file_summaries.append({"file_name": name, "sheets": [], "error": str(e)})
            continue
        tables.extend(file_tables)
        file_summaries.append(
            {
                "file_name": name,
                "sheets": [
                    {
                        "sheet_name": t.sheet_name,
                        "columns": t.columns,
                        "row_count": len(t.rows),
                    }
                    for t in file_tables
                ],
                "error": None,
            }
        )
    return tables, errors, file_summaries


@router.post("/inspect")
async def inspect(
    files: List[UploadFile] = File(...),
    mode: str = Form(MODE_STRUCTURE),
    current_user=Depends(require_data_import),
):
    """解析上传的表格文件，返回工作表概览与合并分组预览（不产出文件）"""
    saved: List[Tuple[str, Path]] = []
    try:
        if mode not in MERGE_MODES:
            raise HTTPException(status_code=400, detail=f"不支持的合并模式: {mode}")
        saved = await run_in_threadpool(_save_uploads, files)
        tables, errors, file_summaries = await run_in_threadpool(_read_all, saved)
        if not tables:
            raise HTTPException(status_code=400, detail="未读取到任何有效表格（文件为空或格式不支持）")

        plans = await run_in_threadpool(plan_merge, tables, mode, False, False)
        groups = [
            {
                "output_sheet": plan.output_sheet,
                "columns": plan.columns,
                "total_rows": len(plan.rows),
                "sources": plan.sources,
            }
            for plan in plans
        ]
        return {
            "success": True,
            "data": {
                "files": file_summaries,
                "groups": groups,
                "errors": errors,
                "total_tables": len(tables),
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
        _cleanup([p for _, p in saved])


@router.post("/merge")
async def merge(
    files: List[UploadFile] = File(...),
    mode: str = Form(MODE_STRUCTURE),
    add_source: bool = Form(True),
    dedupe: bool = Form(False),
    current_user=Depends(require_data_import),
):
    """按相同格式合并多个表格文件，输出单个 Excel 文件"""
    saved: List[Tuple[str, Path]] = []
    try:
        if mode not in MERGE_MODES:
            raise HTTPException(status_code=400, detail=f"不支持的合并模式: {mode}")
        saved = await run_in_threadpool(_save_uploads, files)
        tables, errors, _ = await run_in_threadpool(_read_all, saved)
        if not tables:
            raise HTTPException(status_code=400, detail="未读取到任何有效表格（文件为空或格式不支持）")

        plans = await run_in_threadpool(plan_merge, tables, mode, add_source, dedupe)

        settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        filename = build_output_filename()
        out_path = settings.OUTPUT_DIR / filename
        await run_in_threadpool(write_merged_workbook, out_path, plans)

        sheets = [
            {
                "output_sheet": plan.output_sheet,
                "columns": plan.columns,
                "row_count": len(plan.rows),
                "source_count": len(plan.sources),
                "sources": plan.sources,
            }
            for plan in plans
        ]
        return {
            "success": True,
            "data": {
                "filename": filename,
                "download_url": f"/static/{filename}",
                "sheets": sheets,
                "total_rows": sum(s["row_count"] for s in sheets),
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
        raise HTTPException(status_code=500, detail=f"合并失败: {str(e)}")
    finally:
        _cleanup([p for _, p in saved])
