"""
图层制作 API 端点
"""
import json
import re
import shutil
import uuid
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, Form
from fastapi.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.security import require_data_import
from app.services.layer_service import LayerService, _truncate_bytes

router = APIRouter()
layer_service = LayerService()

# 允许的输入文件扩展名（工参 Excel/文本）
ALLOWED_EXTS = {".xlsx", ".xls", ".txt", ".csv"}


def _companion_files(out: Path) -> list:
    """TAB/MIF 的精确配套文件（不含历史序号残留）。TAB: .tab/.dat/.id/.map；MIF: .mif/.mid；KML: .kml 单文件。"""
    stem = out.stem
    if out.suffix == ".tab":
        return [out.parent / f"{stem}{s}" for s in (".tab", ".dat", ".id", ".map") if (out.parent / f"{stem}{s}").exists()]
    if out.suffix == ".mif":
        return [out.parent / f"{stem}{s}" for s in (".mif", ".mid") if (out.parent / f"{stem}{s}").exists()]
    return [out]


def _fmt_tag(formats: list) -> str:
    """格式组合后缀：['tab']→'_tab'，['tab','mif']→'_tab-mif'，['kml']→'_kml'；空列表→''"""
    if not formats:
        return ""
    return "_" + "-".join(f for f in formats if f)


def _zip_layer(out_path: Path, fmt_tag: str = "") -> Path:
    """把同名图层文件打包成 zip（TAB 含 .tab/.dat/.id/.map，MIF 含 .mif/.mid），返回 zip 路径。
    zip 文件名含格式组合后缀（fmt_tag），不同格式组合 URL 不同，隔离浏览器缓存。"""
    base = out_path.stem
    zip_path = out_path.parent / f"{base}{fmt_tag}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in _companion_files(out_path):
            if f.name != zip_path.name:
                zf.write(f, arcname=f.name)
    return zip_path


def _finalize_output(out: Path, output_format: str, fmt_tag: str = "") -> dict:
    """根据输出格式确定下载文件名/URL：TAB/MIF 多文件打包成 zip（含格式后缀），KML 单文件直接返回"""
    if output_format in ("tab", "mif"):
        zip_path = _zip_layer(out, fmt_tag)
        return {"filename": zip_path.name, "download_url": f"/layer-files/{zip_path.name}"}
    # KML 单文件
    return {"filename": out.name, "download_url": f"/layer-files/{out.name}"}


def _finalize_outputs(outs: list, formats: list, fmt_tag: str = "") -> dict:
    """单格式：TAB/MIF 打包 zip（含格式后缀），KML 单文件；多格式：统一打包 zip（含格式组合后缀）。
    TAB 输出是 .tab 文件（配套 .dat/.id/.map 在同父目录），MIF 同理（.mif/.mid）。
    _companion_files 按精确 stem 收集配套，不同格式配套集合互不相交（无需去重）。
    zip 文件名含格式组合后缀，不同格式组合 URL 不同，隔离浏览器缓存。"""
    if len(outs) == 1:
        return _finalize_output(outs[0], formats[0], fmt_tag)
    # 多格式 → 统一打包 zip
    base = outs[0].stem
    zip_path = outs[0].parent / f"{base}{fmt_tag}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for out in outs:
            for f in _companion_files(out):
                if f.name != zip_path.name:
                    zf.write(f, arcname=f.name)
    return {"filename": zip_path.name, "download_url": f"/layer-files/{zip_path.name}"}


def _save_upload(file: Optional[UploadFile], file_path: Optional[str],
                 source_filename: Optional[str] = None) -> tuple:
    """返回 (Excel 本地路径副本, 原始文件名)。调用方 finally 删除副本。

    file_path 模式复制到新的 src_{uuid}.xlsx（不改动原分块文件，可多次复用；端点永不对
    客户端传入的原路径 unlink，避免任意文件删除）。原分块文件由 layer_tmp TTL 清扫统一管理。
    file 模式写入临时文件。

    source_filename: 客户端显式携带的原始文件名（分块上传时由 complete 端点提供，
    避免 _save_upload 重命名 src_{uuid}.xlsx 导致输出文件名丢失原始名）。不提供时
    file 模式用 file.filename，file_path 模式用 file_path 的文件名。
    """
    if not file and not file_path:
        raise HTTPException(status_code=400, detail="未提供文件")
    tmp_dir = settings.UPLOAD_DIR / "layer_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    if file_path:
        src = Path(str(file_path).strip("\"'"))
        if not src.is_file():
            raise HTTPException(status_code=400, detail=f"文件不存在: {src.name}")
        if src.suffix.lower() not in ALLOWED_EXTS:
            raise HTTPException(status_code=400, detail="仅支持 Excel 文件（.xlsx/.xls）")
        dest = tmp_dir / f"src_{uuid.uuid4().hex[:8]}{src.suffix.lower()}"
        shutil.copy2(src, dest)  # 复制到独立临时文件，finally 删副本
        original_name = source_filename or Path(file_path).name
        return dest, original_name

    suffix = Path(file.filename or "src.xlsx").suffix.lower()
    if suffix not in ALLOWED_EXTS:
        raise HTTPException(status_code=400, detail="仅支持 Excel 文件（.xlsx/.xls）")
    name = f"src_{uuid.uuid4().hex[:8]}{suffix}"
    dest = tmp_dir / name
    with open(dest, "wb") as f:
        f.write(file.file.read())
    original_name = source_filename or (file.filename or "src.xlsx")
    return dest, original_name


@router.post("/excel-info")
async def excel_info(
    file: Optional[UploadFile] = None,
    file_path: Optional[str] = Form(None),
    source_filename: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """读取 Excel 的 sheet 列表和各 sheet 列名"""
    src = None
    try:
        src, _ = _save_upload(file, file_path, source_filename)
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
    output_formats: Optional[str] = Form(None),   # 逗号分隔多选，优先
    output_format: str = Form("tab"),             # 旧单值，兼容
    color: Optional[str] = Form(None),            # 旧单值：点图按边框语义应用
    border_color: Optional[str] = Form(None),
    fill_color: Optional[str] = Form(None),
    opacity: Optional[float] = Form(None),        # 0-1
    point_size: Optional[float] = Form(None),     # 点大小（像素，MIF Symbol size / KML scale）
    point_shape: Optional[str] = Form(None),      # 点形状（circle/square/diamond/triangle/triangle_down/landmark/pin）
    source_filename: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """生成点图层，返回下载 URL + stats"""
    src = None
    try:
        src, original_name = _save_upload(file, file_path, source_filename)
        attr_list = json.loads(attributes) if attributes else []
        fmt_list = [f.strip() for f in (output_formats or output_format).split(",") if f.strip()] or ["tab"]

        # 生成前清理同 base 历史输出（base = 源文件名stem + sheet 名 + 图层类型），只清一次
        # 类型标记保证扇区/点图各自独立清理，互不删除对方的输出
        _base = _truncate_bytes(Path(original_name).stem, 100)
        _safe_sheet = re.sub(r'[<>:"/\\|?*]', "_", sheet_name)
        layer_service._cleanup_old_outputs(f"{_base}_{_safe_sheet}_point")

        outs, stats = [], None
        for fmt in fmt_list:
            out, stats = await run_in_threadpool(
                layer_service.generate_point_layer,
                str(src), sheet_name, name_col, lon_col, lat_col,
                attr_list, fmt, color or None, original_name,
                border_color or color, None, opacity,
                point_size, point_shape,
            )
            outs.append(out)
        return {"success": True, "data": {**_finalize_outputs(outs, fmt_list, _fmt_tag(fmt_list)), "stats": stats}}
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
    output_formats: Optional[str] = Form(None),   # 逗号分隔多选，优先
    output_format: str = Form("tab"),             # 旧单值，兼容
    color: Optional[str] = Form(None),            # 旧单值：边框/填充缺省时同时应用
    border_color: Optional[str] = Form(None),
    fill_color: Optional[str] = Form(None),
    opacity: Optional[float] = Form(None),        # 0-1
    line_width: Optional[float] = Form(None),     # 描边线宽（像素，clamp 1-7）
    source_filename: Optional[str] = Form(None),
    current_user=Depends(require_data_import),
):
    """生成扇区图层，返回下载 URL + stats"""
    src = None
    try:
        src, original_name = _save_upload(file, file_path, source_filename)
        attr_list = json.loads(attributes) if attributes else []
        fmt_list = [f.strip() for f in (output_formats or output_format).split(",") if f.strip()] or ["tab"]

        # 生成前清理同 base 历史输出（base = 源文件名stem + sheet 名 + 图层类型），只清一次
        # 类型标记保证扇区/点图各自独立清理，互不删除对方的输出
        _base = _truncate_bytes(Path(original_name).stem, 100)
        _safe_sheet = re.sub(r'[<>:"/\\|?*]', "_", sheet_name)
        layer_service._cleanup_old_outputs(f"{_base}_{_safe_sheet}_sector")

        outs, stats = [], None
        for fmt in fmt_list:
            out, stats = await run_in_threadpool(
                layer_service.generate_sector_layer,
                str(src), sheet_name, name_col, lon_col, lat_col, azimuth_col,
                radius_m, beamwidth, attr_list, fmt,
                color or None, original_name,
                border_color or color, fill_color or color, opacity,
                line_width,
            )
            outs.append(out)
        return {"success": True, "data": {**_finalize_outputs(outs, fmt_list, _fmt_tag(fmt_list)), "stats": stats}}
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
