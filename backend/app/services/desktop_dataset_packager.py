"""桌面端共享模式：数据集打包 / 解包（服务器 ←→ 桌面端以「整个数据集」为单位同步）。

打包内容：
- meta.json：index.json 中的数据条目快照（含 name/type/fileType/metadata…）
- excel 类型（工参）：源文件（**先从 SQLite 反写**，保证 PCI/TAC 应用结果不丢）
- map 类型：`data/<data_id>/` 下的全部图层文件（TAB 全套 + layers.json）
- geo_data 类型（地理化数据）：`data/<data_id>/` 下的全部内容（真身是 default.json，
  源 Excel 只是解析输入）+ 源文件副本（供接收端反向 push 时再次打包）

解包落盘的硬性要求（踩过/会踩的坑）：
- **先删后插**：`_save_to_sqlite` 只 upsert Workbook + 追加 Site/Sector，
  不删旧行；同一 data_id 二次导入会让小区数量翻倍。
- **map / geo_data 类型不走 Excel 管线**：直接落文件 + 写 index 条目（+ 补 Layer / GeoFile 表行）。
  geo_data 若误走 `_process_upload_sync`，会被工参解析覆盖 `fileType` 并抹掉 `geometryType`，
  且 default.json 缺失——表现为接收端「扇区」标注丢失、地图回退成工参渲染。
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
from app.utils.file_integrity import assert_zip_intact, is_zip_based

logger = logging.getLogger(__name__)

PACKAGE_VERSION = 1
META_NAME = "meta.json"
SOURCE_PREFIX = "source"


class DatasetPackageError(Exception):
    """打包/解包失败。"""


def _is_geo_entry(entry: Dict[str, Any]) -> bool:
    """地理化数据：数据体是 data/<id>/default.json，必须整目录同步。"""
    return entry.get("fileType") == "geo_data"


# ---------------------------------------------------------------- 内部工具

def _entry(data_id: str) -> Dict[str, Any]:
    from app.services.data_service import data_service

    entry = data_service.index.get(data_id)
    if entry is None:
        raise DatasetPackageError(f"数据集不存在：{data_id}")
    return entry


def _ensure_excel_synced(data_id: str, entry: Dict[str, Any]) -> None:
    """SQLite 才是权威：原地更新（应用 PCI/TAC）后必须先把结果反写回 Excel 再打包。

    否则桌面端拿到的是应用结果之前的旧文件。

    ⚠ 判据必须是 `excel_synced`（Excel 是否已回写），**不能**用 `inplace_updated`：
    后者会被历史列表的工参缓存读取消费（`_load_current_sector_values` 置回 False），
    而 Excel 回写是应用后的后台任务。应用后只要有人刷新历史列表，标记就变 False，
    此时按它判断会直接打包旧 Excel —— 对端记下新修订号却拿到旧内容，rev 相同后
    再也不会重拉（桌面端地图 PCI 为空、历史任务应用状态长期不一致的根因）。
    """
    if entry.get("excel_synced") is not False:
        return
    source = settings.DATA_DIR / data_id / "original.xlsx"
    if not source.is_file():
        # 非 xlsx 源（xls/zip）无法回写，沿用旧行为：记录告警后按源文件打包
        logger.warning(f"[数据集打包] 源文件不是 original.xlsx，无法回写应用结果: {data_id}")
        return
    try:
        from app.services.task_manager import TaskManager

        TaskManager._sync_excel_from_sqlite(data_id, logger)
    except Exception as exc:  # noqa: BLE001
        # 回写失败绝不能继续打包旧文件：那会让对端把旧内容永久当成新版本
        raise DatasetPackageError(f"工参回写失败，拒绝打包旧数据（{data_id}）：{exc}") from exc
    from app.services.data_service import data_service

    if (data_service.index.get(data_id) or {}).get("excel_synced") is not True:
        # _sync_excel_from_sqlite 内部会吞异常只记日志，这里必须再用标记确认
        raise DatasetPackageError(f"工参尚未完成数据库回写，请稍后重试（{data_id}）")


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


def _assert_source_intact(src: Path) -> None:
    """源文件是 zip 容器（xlsx/zip）时校验完整性，损坏则拒绝同步。

    一个被截断的 original.xlsx 若无校验地打包上行，对端解包时才会在解析阶段
    报「Cannot detect file format」，而那时的「先删后插」已经把对端唯一一份
    工参删掉了。宁可在这里失败并保留对端数据。
    """
    if not is_zip_based(src):
        return
    try:
        assert_zip_intact(src, "数据集源文件")
    except ValueError as exc:
        raise DatasetPackageError(
            f"{exc}。已损坏的文件不会同步到其它终端，请重新上传全量工参"
        ) from exc


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
    is_geo = _is_geo_entry(entry)
    # 目录型数据集：map 的图层文件、geo_data 的 default.json 都在 data/<id>/ 下
    packs_directory = entry_type == "map" or is_geo

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

            if packs_directory:
                data_dir = settings.DATA_DIR / data_id
                if not data_dir.is_dir():
                    raise DatasetPackageError(f"数据目录缺失：{data_dir}")
                for f in sorted(data_dir.rglob("*")):
                    if not f.is_file():
                        continue
                    zf.write(f, str(f.relative_to(data_dir)))
                if is_geo:
                    # 源文件一并入包：接收端恢复 uploads/ 后，反向 push 才能再次打包
                    try:
                        src = _locate_source_file(data_id, entry)
                    except DatasetPackageError:
                        src = None
                    if src is not None:
                        zf.write(src, f"{SOURCE_PREFIX}{src.suffix.lower()}")
            else:
                _ensure_excel_synced(data_id, entry)
                src = _locate_source_file(data_id, entry)
                _assert_source_intact(src)
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
    is_geo = _is_geo_entry(source_entry)
    backup: Dict[str, Any] = {}

    # 1. 解到临时目录（Windows 下不能直接覆盖可能被 GDAL 占用的文件）
    #    校验必须在删除旧数据之前完成：包损坏时若已先删了唯一的全量工参，
    #    本机/同组的工参就彻底不可用了。
    extract_root = Path(tempfile.mkdtemp(prefix="npt-unpkg-"))
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_root)

        src = None
        if entry_type != "map" and not is_geo:
            for cand in sorted(extract_root.glob(f"{SOURCE_PREFIX}.*")):
                src = cand
                break
            if src is None:
                raise DatasetPackageError("数据包缺少源数据文件")
            _assert_source_intact(src)

        # 2. 已存在 → 备份后彻底删除（含文件/SQLite 行/索引），避免二次导入导致小区翻倍。
        #    解析失败时用备份回滚：否则一个内容不合法的包会把本机/同组唯一一份工参删掉，
        #    用户看到的就是「工参无法使用」。
        if data_id in data_service.index:
            backup = _backup_dataset(data_id)
            data_service.delete_data(data_id, force=True)
        shutil.rmtree(settings.DATA_DIR / data_id, ignore_errors=True)
        for ext in (".xlsx", ".xls", ".zip"):
            (settings.UPLOAD_DIR / f"{data_id}{ext}").unlink(missing_ok=True)

        settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
        data_dir = settings.DATA_DIR / data_id

        if entry_type == "map" or is_geo:
            data_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(extract_root), str(data_dir))
            (data_dir / META_NAME).unlink(missing_ok=True)
            if is_geo:
                # 源文件恢复到 uploads/（与 geo_data 上传路径一致），供反向 push 再次打包
                for cand in sorted(data_dir.glob(f"{SOURCE_PREFIX}.*")):
                    ext = cand.suffix.lower()
                    settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(cand, settings.UPLOAD_DIR / f"{data_id}{ext}")
                    cand.unlink(missing_ok=True)
                    break
        else:
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
        # 包内 layers.json 的 source_file 是打包机器上的绝对路径（Windows/POSIX 各不相同），
        # 必须按接收方当前数据根重写，否则网页端 / 另一端保存图层会报「图层源文件不存在」。
        try:
            from app.services.layer_paths import rebase_layer_entries

            layers, _ = rebase_layer_entries(data_dir)
            if layers:
                metadata = new_entry.setdefault("metadata", {})
                metadata["layers"] = layers
                metadata["layerCount"] = len(layers)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[数据集解包] 图层路径校正失败（按原路径继续）{data_id}: {exc}")
        data_service.index[data_id] = new_entry
        data_service._save_index()
        _upsert_layers(data_id, new_entry, user_id, city, operator)
    elif is_geo:
        # 地理化数据不走工参 Excel 管线：条目原样落地（保住 fileType/geometryType/metadata）
        new_entry["status"] = "ready"
        new_entry.pop("errorMessage", None)
        data_service.index[data_id] = new_entry
        data_service._save_index()
        _upsert_geo_file(data_id, new_entry, user_id, city, operator)
    else:
        new_entry["status"] = "processing"
        data_service.index[data_id] = new_entry
        data_service._save_index()
        try:
            # 走既有导入管线：解析 Excel → 写 SQLite，复用原 data_id 与组章
            data_service._process_upload_sync(data_id)
            live = data_service.index.get(data_id) or {}
            if live.get("status") == "error":
                raise DatasetPackageError(live.get("errorMessage") or "数据集导入失败")
        except BaseException:
            # 旧数据集已在步骤 2 删除，导入失败必须回滚，否则本机工参彻底不可用
            _restore_dataset(data_id, backup)
            raise

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

    _discard_dataset_backup(backup)
    return {"data_id": data_id, "type": entry_type}


def _backup_dataset(data_id: str) -> Dict[str, Any]:
    """覆盖安装前备份本机已有数据集（数据目录 + uploads 副本 + 索引条目）。

    备份用 `.{data_id}.bak` 命名，不会被 delete_data 的 `{data_id}.*` 通配删掉。
    """
    from app.services.data_service import data_service

    backup: Dict[str, Any] = {"entry": dict(data_service.index.get(data_id) or {})}
    live_dir = settings.DATA_DIR / data_id
    if live_dir.is_dir():
        bak_dir = settings.DATA_DIR / f".{data_id}.bak"
        shutil.rmtree(bak_dir, ignore_errors=True)
        try:
            shutil.move(str(live_dir), str(bak_dir))
            backup["dir"] = bak_dir
        except OSError as exc:
            logger.warning(f"[数据集解包] 数据目录备份失败（继续安装）{data_id}: {exc}")
    uploads = []
    for ext in (".xlsx", ".xls", ".zip"):
        src = settings.UPLOAD_DIR / f"{data_id}{ext}"
        if src.is_file():
            bak = settings.UPLOAD_DIR / f".{data_id}.bak{ext}"
            try:
                shutil.copy2(src, bak)
                uploads.append((bak, src.name))
            except OSError as exc:
                logger.warning(f"[数据集解包] 上传副本备份失败 {src}: {exc}")
    backup["uploads"] = uploads
    return backup


def _discard_dataset_backup(backup: Dict[str, Any]) -> None:
    bak_dir = backup.get("dir")
    if bak_dir is not None:
        shutil.rmtree(bak_dir, ignore_errors=True)
    for bak, _name in backup.get("uploads") or []:
        Path(bak).unlink(missing_ok=True)


def _restore_dataset(data_id: str, backup: Dict[str, Any]) -> None:
    """安装失败后回滚到备份：文件 + 索引条目 + 墓碑撤销 + 按原文件重建 SQLite 行。"""
    if not backup:
        return
    from app.services.data_service import data_service

    try:
        shutil.rmtree(settings.DATA_DIR / data_id, ignore_errors=True)
        bak_dir = backup.get("dir")
        if bak_dir is not None and bak_dir.is_dir():
            shutil.move(str(bak_dir), str(settings.DATA_DIR / data_id))
        for bak, name in backup.get("uploads") or []:
            if Path(bak).is_file():
                shutil.copy2(bak, settings.UPLOAD_DIR / name)
        entry = backup.get("entry") or {}
        if entry:
            data_service.index[data_id] = entry
            data_service._save_index()
            # delete_data 写下了墓碑，回滚必须撤销，否则各端会把这条数据当已删除
            try:
                data_service._bump_revision(data_id, deleted=False)
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[数据集解包] 回滚修订号失败 {data_id}: {exc}")
            # 文件回来了，但 SQLite 行已被删：按原文件重新入库，否则列表/地图看到空工参
            try:
                data_service._process_upload_sync(data_id)
            except Exception as exc:  # noqa: BLE001
                logger.error(f"[数据集解包] 回滚后重建 SQLite 行失败 {data_id}: {exc}")
        logger.warning(f"[数据集解包] 安装失败，已回滚原数据集: {data_id}")
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[数据集解包] 回滚失败 {data_id}: {exc}")
    _discard_dataset_backup(backup)


def _upsert_layers(
    data_id: str, entry: Dict[str, Any], user_id: int, city: Optional[str], operator: Optional[str]
) -> None:
    """map 类型：按压缩包内的图层清单补 SQLite layers 元数据行。"""
    try:
        from app.services.layer_edit_service import _upsert_layer_metadata
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[数据集解包] 图层元数据模块不可用: {exc}")
        return

    from app.services.layer_paths import resolve_layer_source_path

    layers = (entry.get("metadata") or {}).get("layers") or []
    data_dir = settings.DATA_DIR / data_id
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        layer_id = layer.get("id") or layer.get("layer_id")
        if not layer_id:
            continue
        resolved = resolve_layer_source_path(data_dir, layer)
        if resolved is not None:
            file_path = str(resolved)
        else:
            file_field = layer.get("file_path") or layer.get("file") or layer.get("path") or ""
            rel = Path(file_field).name if file_field else ""
            file_path = str(data_dir / rel) if rel else str(data_dir)
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


def _upsert_geo_file(
    data_id: str, entry: Dict[str, Any], user_id: int, city: Optional[str], operator: Optional[str]
) -> None:
    """geo_data 类型：补 SQLite geo_files 元数据行。

    地理化数据没有 Workbook/Site/Sector 行，启动对账（data_service 校验索引）以
    「geo_files 有行 或 data/<id>/default.json 存在」为有效依据；缺行会让接收端
    的条目在下次重启被当作无效索引删掉。复用 geo_data_service 的元数据写入，
    保证字段（field_mapping/created_at 等）与上传路径一致。
    """
    try:
        from app.services.geo_data_service import _save_geo_file_metadata
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[数据集解包] 地理化元数据模块不可用: {exc}")
        return

    metadata = entry.get("metadata") or {}
    data_dir = settings.DATA_DIR / data_id
    try:
        _save_geo_file_metadata(
            user_id=user_id,
            filename=entry.get("name") or data_id,
            file_path=str(data_dir / "default.json"),
            geometry_type=entry.get("geometryType") or "point",
            field_mapping=metadata.get("fieldMapping") or {},
            point_count=int(metadata.get("pointCount") or 0),
            bbox=metadata.get("bbox"),
            file_size=entry.get("size"),
            geo_id=data_id,
            city=city,
            operator=operator,
            import_warnings=metadata.get("importWarnings"),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[数据集解包] 地理化元数据写入失败 {data_id}: {exc}")
