"""桌面端共享模式：数据集打包 / 解包（服务器 ←→ 桌面端以「整个数据集」为单位同步）。

打包内容：
- meta.json：index.json 中的数据条目快照（含 name/type/fileType/metadata…）
- excel 类型：源文件（**先从 SQLite 反写**，保证 PCI/TAC 应用结果不丢）
- map 类型：`data/<data_id>/` 下的全部图层文件（TAB 全套 + layers.json）

解包落盘的硬性要求（踩过/会踩的坑）：
- **先删后插**：`_save_to_sqlite` 只 upsert Workbook + 追加 Site/Sector，
  不删旧行；同一 data_id 二次导入会让小区数量翻倍。
- **map 类型不走 Excel 管线**：直接落文件 + 写 index 条目 + 补 Layer 表行。
- Windows 文件锁：先解到临时目录再整体替换，不要直接覆盖 GDAL 正打开的文件。
"""
from __future__ import annotations

import hashlib
import json
import logging
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)

PACKAGE_VERSION = 1
META_NAME = "meta.json"
SOURCE_PREFIX = "source"


class DatasetPackageError(Exception):
    """打包/解包失败。"""


# ---------------------------------------------------------------- 内部工具

def _entry(data_id: str) -> Dict[str, Any]:
    from app.services.data_service import data_service

    entry = data_service.index.get(data_id)
    if entry is None:
        raise DatasetPackageError(f"数据集不存在：{data_id}")
    return entry


def _ensure_excel_synced(data_id: str, entry: Dict[str, Any]) -> None:
    """SQLite 才是权威：原地更新（应用 PCI/TAC）后必须先把结果反写回 Excel 再打包。

    否则桌面端拿到的会是应用结果之前的旧文件。
    """
    if not entry.get("inplace_updated") or entry.get("excel_synced"):
        return
    try:
        from app.services.task_manager import TaskManager

        TaskManager._sync_excel_from_sqlite(data_id, logger)
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[数据集打包] Excel 反写失败（将打包当前文件）{data_id}: {exc}")


def _locate_source_file(data_id: str, entry: Dict[str, Any]) -> Path:
    """按与「下载」一致的优先级定位源数据文件。"""
    data_dir = settings.DATA_DIR / data_id
    candidates = [
        data_dir / "original.xlsx",
        data_dir / "original.zip",
        settings.UPLOAD_DIR / f"{data_id}.xlsx",
        settings.UPLOAD_DIR / f"{data_id}.zip",
    ]
    name = entry.get("name") or ""
    if name:
        candidates.append(data_dir / name)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    if data_dir.is_dir():
        for item in sorted(data_dir.iterdir()):
            if item.is_file() and item.suffix.lower() in (".xlsx", ".xls", ".zip"):
                return item
    raise DatasetPackageError(f"数据集源文件缺失：{data_id}")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- 打包

def build_package(data_id: str, *, workdir: Optional[Path] = None) -> Dict[str, Any]:
    """把数据集打包成 zip。返回 {"path", "size", "sha256", "type", "entry"}。

    调用方负责删除返回的临时文件（path 位于独立临时目录）。
    """
    entry = _entry(data_id)
    entry_type = entry.get("type") or "excel"

    tmp_root = Path(tempfile.mkdtemp(prefix="npt-pkg-", dir=str(workdir) if workdir else None))
    zip_path = tmp_root / f"{data_id}.zip"

    try:
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(
                META_NAME,
                json.dumps(
                    {"version": PACKAGE_VERSION, "data_id": data_id, "entry": entry},
                    ensure_ascii=False,
                ),
            )

            if entry_type == "map":
                data_dir = settings.DATA_DIR / data_id
                if not data_dir.is_dir():
                    raise DatasetPackageError(f"图层数据目录缺失：{data_dir}")
                for f in sorted(data_dir.rglob("*")):
                    if not f.is_file():
                        continue
                    zf.write(f, str(f.relative_to(data_dir)))
            else:
                _ensure_excel_synced(data_id, entry)
                src = _locate_source_file(data_id, entry)
                zf.write(src, f"{SOURCE_PREFIX}{src.suffix.lower()}")
    except Exception:
        shutil.rmtree(tmp_root, ignore_errors=True)
        raise

    return {
        "path": zip_path,
        "size": zip_path.stat().st_size,
        "sha256": _sha256(zip_path),
        "type": entry_type,
        "entry": entry,
    }


def read_package_meta(zip_path: Path) -> Dict[str, Any]:
    with zipfile.ZipFile(zip_path, "r") as zf:
        if META_NAME not in zf.namelist():
            raise DatasetPackageError("数据包缺少 meta.json")
        return json.loads(zf.read(META_NAME).decode("utf-8"))


# ---------------------------------------------------------------- 解包

def install_package(
    zip_path: Path,
    *,
    user_id: int,
    city: Optional[str],
    operator: Optional[str],
    username: Optional[str] = None,
) -> Dict[str, Any]:
    """把数据包落到本机（覆盖同名数据集），返回 {"data_id", "type"}。

    始终以接收方用户的组覆盖包内的组：pull/push 双方向都只在同组内发生，
    强制盖章可杜绝跨组污染（即使包被人手工篡改）。
    """
    from app.services.data_service import data_service

    meta = read_package_meta(zip_path)
    if int(meta.get("version") or 0) != PACKAGE_VERSION:
        raise DatasetPackageError(f"不支持的数据包版本：{meta.get('version')}")
    source_entry = meta.get("entry") or {}
    data_id = str(meta.get("data_id") or "").strip()
    if not data_id:
        raise DatasetPackageError("数据包缺少 data_id")
    entry_type = source_entry.get("type") or "excel"

    # 1. 已存在 → 彻底删除（含文件/SQLite 行/索引），避免二次导入导致小区翻倍
    if data_id in data_service.index:
        data_service.delete_data(data_id, force=True)
    shutil.rmtree(settings.DATA_DIR / data_id, ignore_errors=True)
    for ext in (".xlsx", ".xls", ".zip"):
        (settings.UPLOAD_DIR / f"{data_id}{ext}").unlink(missing_ok=True)

    # 2. 解到临时目录（Windows 下不能直接覆盖可能被 GDAL 占用的文件）
    extract_root = Path(tempfile.mkdtemp(prefix="npt-unpkg-"))
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_root)

        settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
        data_dir = settings.DATA_DIR / data_id

        if entry_type == "map":
            data_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(extract_root), str(data_dir))
            (data_dir / META_NAME).unlink(missing_ok=True)
        else:
            src = None
            for cand in sorted(extract_root.glob(f"{SOURCE_PREFIX}.*")):
                src = cand
                break
            if src is None:
                raise DatasetPackageError("数据包缺少源数据文件")
            ext = src.suffix.lower()
            settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, settings.UPLOAD_DIR / f"{data_id}{ext}")
            data_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, data_dir / f"original{ext}")
    finally:
        shutil.rmtree(extract_root, ignore_errors=True)

    # 3. 写索引条目（覆盖包名具体)。源条目的 city/operator 一律用接收方组覆盖
    new_entry = dict(source_entry)
    new_entry.update({
        "id": data_id,
        "user_id": user_id,
        "city": city,
        "operator": operator,
    })
    if username:
        new_entry["userName"] = username
    new_entry.pop("inplace_updated", None)
    new_entry.pop("excel_synced", None)

    from app.services.data_service import data_service  # noqa: F811

    if entry_type == "map":
        new_entry["status"] = "ready"
        new_entry.pop("errorMessage", None)
        data_service.index[data_id] = new_entry
        data_service._save_index()
        _upsert_layers(data_id, new_entry, user_id, city, operator)
    else:
        new_entry["status"] = "processing"
        data_service.index[data_id] = new_entry
        data_service._save_index()
        # 走既有导入管线：解析 Excel → 写 SQLite，复用原 data_id 与组章
        data_service._process_upload_sync(data_id)
        live = data_service.index.get(data_id) or {}
        if live.get("status") == "error":
            raise DatasetPackageError(live.get("errorMessage") or "数据集导入失败")

    # 4. 修订号：上面的 delete_data 会写墓碑，导入成功后必须复位
    try:
        from app.services import dataset_revision_service as revs

        revs.bump(data_id, deleted=False)
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[数据集解包] 修订号复位失败（非致命）{data_id}: {exc}")

    # 5. 失效缓存
    try:
        from app.services.layer_edit_service import clear_layer_cache

        clear_layer_cache(data_id)
    except Exception:
        pass
    try:
        data_service._invalidate_cell_search_index()
    except Exception:
        pass
    try:
        from app.api.v1.endpoints.map import invalidate_map_data_cache

        invalidate_map_data_cache()
    except Exception:
        pass

    return {"data_id": data_id, "type": entry_type}


def _upsert_layers(
    data_id: str, entry: Dict[str, Any], user_id: int, city: Optional[str], operator: Optional[str]
) -> None:
    """map 类型：按压缩包内的图层清单补 SQLite layers 元数据行。"""
    try:
        from app.services.layer_edit_service import _upsert_layer_metadata
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[数据集解包] 图层元数据模块不可用: {exc}")
        return

    layers = (entry.get("metadata") or {}).get("layers") or []
    data_dir = settings.DATA_DIR / data_id
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        layer_id = layer.get("id") or layer.get("layer_id")
        if not layer_id:
            continue
        file_field = layer.get("file_path") or layer.get("file") or layer.get("path") or ""
        rel = Path(file_field).name if file_field else ""
        resolved = (data_dir / rel) if rel else None
        file_path = str(resolved) if resolved and resolved.exists() else str(data_dir / rel)
        try:
            _upsert_layer_metadata(
                layer_id=layer_id,
                name=layer.get("name") or layer_id,
                file_path=file_path,
                geom_value=layer.get("geometry_type") or layer.get("layer_type") or "mixed",
                feature_count=int(layer.get("feature_count") or 0),
                file_size=layer.get("file_size"),
                user_id=user_id,
                city=city,
                operator=operator,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[数据集解包] 图层元数据写入失败 {layer_id}: {exc}")
