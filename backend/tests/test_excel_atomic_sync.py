"""工参文件原子写 + 数据集包完整性校验。

背景（2026-11-04 线上问题）：PCI「应用到工参」后，后台线程用 openpyxl 原地
`wb.save(original.xlsx)` 反写，写出期间文件是半截 zip；并发读取（下载 /
桌面端数据集打包 / 推送导入）拿到半截文件即报
`CalamineError: Cannot detect file format`。更糟的是桌面端推送的坏包在
`install_package` 里「先删后插」，解析失败时已经把本组唯一一份全量工参删掉了，
表现为「PCI 写入工参失败，此时工参无法使用」。
"""
from __future__ import annotations

import json
import logging
import zipfile

import pytest
from openpyxl import Workbook

from app.core.config import settings


def _make_workbook(path, sheet_name: str = "LTE Project Parameters", rows: int = 5):
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_name
    ws.append(["eNodeB标识", "小区标识", "PCI", "TAC"])
    for i in range(rows):
        ws.append([1000 + i, i, 10 + i, 5000])
    wb.save(path)
    return path


def _make_package(tmp_path, data_id: str, source_bytes: bytes, name: str = "ProjectParameter_x.xlsx"):
    zip_path = tmp_path / f"{data_id}.zip"
    meta = {
        "version": 1,
        "data_id": data_id,
        "entry": {"id": data_id, "name": name, "type": "excel", "fileType": "full_params",
                  "status": "ready"},
    }
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("meta.json", json.dumps(meta, ensure_ascii=False))
        zf.writestr("source.xlsx", source_bytes)
    return zip_path


# ---------------------------------------------------------------- 原子写

def test_save_workbook_atomic_keeps_original_on_failure(tmp_path):
    """写失败（磁盘满 / 进程被杀的同构场景）绝不能把原文件写坏。"""
    from app.utils.file_integrity import assert_zip_intact, save_workbook_atomic

    target = _make_workbook(tmp_path / "original.xlsx")
    before = target.read_bytes()

    class _BoomWorkbook:
        def save(self, path):
            with open(path, "wb") as f:  # 模拟写到一半失败：留下半截文件
                f.write(b"PK\x03\x04truncated")
            raise OSError("disk full")

    with pytest.raises(OSError):
        save_workbook_atomic(_BoomWorkbook(), target)

    assert target.read_bytes() == before  # 原文一字未动
    assert_zip_intact(target)
    assert not list(tmp_path.glob(".*.tmp"))  # 临时文件不残留


def test_save_workbook_atomic_replaces_completely(tmp_path):
    from app.utils.file_integrity import assert_zip_intact, save_workbook_atomic

    target = _make_workbook(tmp_path / "original.xlsx", rows=3)
    old_inode = target.stat().st_ino

    wb = Workbook()
    ws = wb.active
    ws.title = "LTE Project Parameters"
    ws.append(["eNodeB标识", "小区标识", "PCI"])
    for i in range(200):
        ws.append([i, i, i])
    save_workbook_atomic(wb, target)

    assert_zip_intact(target)  # 目标路径上始终是完整文件
    assert target.stat().st_ino != old_inode or target.stat().st_size > 0
    assert not list(tmp_path.glob(".*.tmp"))


def test_sync_excel_from_sqlite_writes_atomically(tmp_path, monkeypatch):
    """应用 PCI 后的后台反写走原子替换，结束后文件仍可解析。"""
    from app.services.data_service import data_service
    from app.services.task_manager import TaskManager
    from app.utils.file_integrity import assert_zip_intact

    data_id = "atomic-sync-0001"
    data_dir = settings.DATA_DIR / data_id
    data_dir.mkdir(parents=True, exist_ok=True)
    target = _make_workbook(data_dir / "original.xlsx")

    data_service.index[data_id] = {
        "id": data_id, "name": "ProjectParameter_atomic.xlsx", "type": "excel",
        "fileType": "full_params", "status": "ready",
        "inplace_updated": True, "excel_synced": False,
    }
    try:
        TaskManager._sync_excel_from_sqlite(data_id, logging.getLogger(__name__))
        assert_zip_intact(target)
        assert data_service.index[data_id]["excel_synced"] is True
        assert data_service.index[data_id]["inplace_updated"] is True
        assert not list(data_dir.glob(".*.tmp"))
    finally:
        data_service.index.pop(data_id, None)


# ---------------------------------------------------------------- 数据包完整性

def test_build_package_refuses_corrupt_source(tmp_path):
    """损坏的工参不能被静默打包上行（否则只是把损坏扩散到对端）。"""
    from app.services import desktop_dataset_packager as pkg
    from app.services.data_service import data_service

    data_id = "pkg-corrupt-0001"
    data_dir = settings.DATA_DIR / data_id
    data_dir.mkdir(parents=True, exist_ok=True)
    _make_workbook(data_dir / "original.xlsx")

    data_service.index[data_id] = {
        "id": data_id, "name": "ProjectParameter_x.xlsx", "type": "excel",
        "fileType": "full_params", "status": "ready",
    }
    try:
        # 正常情况能打包
        package = pkg.build_package(data_id)
        assert package["path"].is_file()

        # 模拟并发反写留下的半截文件
        (data_dir / "original.xlsx").write_bytes(b"PK\x03\x04half")
        with pytest.raises(pkg.DatasetPackageError) as exc:
            pkg.build_package(data_id)
        assert "损坏" in str(exc.value)
    finally:
        data_service.index.pop(data_id, None)


def test_install_package_rejects_corrupt_source_without_deleting(tmp_path, monkeypatch):
    """坏包必须在删除旧数据集之前被拒绝 —— 否则工参被删光且不可用。"""
    from app.services import desktop_dataset_packager as pkg
    from app.services.data_service import data_service

    data_id = "pkg-install-0001"
    data_dir = settings.DATA_DIR / data_id
    data_dir.mkdir(parents=True, exist_ok=True)
    live = _make_workbook(data_dir / "original.xlsx")
    live_bytes = live.read_bytes()
    settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (settings.UPLOAD_DIR / f"{data_id}.xlsx").write_bytes(live_bytes)

    old_entry = {
        "id": data_id, "name": "ProjectParameter_keep.xlsx", "type": "excel",
        "fileType": "full_params", "status": "ready", "user_id": 1,
        "city": "河源", "operator": "电信",
    }
    data_service.index[data_id] = dict(old_entry)
    try:
        bad = _make_package(tmp_path, data_id, b"PK\x03\x04not-a-real-xlsx")
        with pytest.raises(pkg.DatasetPackageError) as exc:
            pkg.install_package(bad, user_id=1, city="河源", operator="电信")
        assert "损坏" in str(exc.value)

        # 旧数据集原样保留（文件 + 索引条目）
        assert live.read_bytes() == live_bytes
        assert (settings.UPLOAD_DIR / f"{data_id}.xlsx").read_bytes() == live_bytes
        assert data_service.index[data_id]["name"] == old_entry["name"]
    finally:
        data_service.index.pop(data_id, None)


def test_install_package_rolls_back_when_import_fails(tmp_path, monkeypatch):
    """包能通过 zip 校验但解析失败时，回滚旧数据集（文件 + 索引 + 撤销墓碑）。"""
    from app.services import dataset_revision_service as revs
    from app.services import desktop_dataset_packager as pkg
    from app.services.data_service import data_service

    data_id = "pkg-rollback-0001"
    data_dir = settings.DATA_DIR / data_id
    data_dir.mkdir(parents=True, exist_ok=True)
    live = _make_workbook(data_dir / "original.xlsx")
    live_bytes = live.read_bytes()
    settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (settings.UPLOAD_DIR / f"{data_id}.xlsx").write_bytes(live_bytes)

    old_entry = {
        "id": data_id, "name": "ProjectParameter_keep.xlsx", "type": "excel",
        "fileType": "full_params", "status": "ready", "user_id": 1,
        "city": "河源", "operator": "电信",
    }
    data_service.index[data_id] = dict(old_entry)

    # 合法 zip（能过完整性校验）但内容不是 Excel → 导入阶段报 Cannot detect file format
    bogus = tmp_path / "bogus.xlsx"
    with zipfile.ZipFile(bogus, "w") as zf:
        zf.writestr("not_excel.txt", "x")

    try:
        bad = _make_package(tmp_path, data_id, bogus.read_bytes())
        with pytest.raises(pkg.DatasetPackageError):
            pkg.install_package(bad, user_id=1, city="河源", operator="电信")

        assert live.read_bytes() == live_bytes
        assert data_service.index.get(data_id, {}).get("name") == old_entry["name"]
        assert (revs.get(data_id) or {}).get("deleted") is False
        assert not list(settings.DATA_DIR.glob(f".{data_id}.bak*"))
    finally:
        data_service.index.pop(data_id, None)
        revs.remove(data_id)
