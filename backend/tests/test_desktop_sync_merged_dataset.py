"""桌面端共享模式同步：现网工参合并（中兴）产物必须保真跨端。

回归点（用户报告：工参更新(中兴)后合并文件在桌面端/网页端同组用户间不同步）：

- 合并产物按整目录打包，包内没有 `source.*` 标记；解包不能再强制找源文件，
  否则 pull/push 都抛「数据包缺少源数据文件」
- 解包必须原样落地 `fileType=merged_current_params` 与 metadata，不得走工参
  Excel 解析管线（列结构与全量工参不同）
- 接收端必须补 Workbook 元数据行，避免重启对账时条目被当残余清掉
"""
from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

MERGED_ID = "merged-zte-1"


@pytest.fixture()
def merged_env(tmp_path, monkeypatch):
    from app.core.config import settings
    from app.services.data_service import data_service

    data_dir = tmp_path / "data"
    upload_dir = tmp_path / "uploads"
    (data_dir / MERGED_ID).mkdir(parents=True)
    upload_dir.mkdir(parents=True)

    monkeypatch.setattr(settings, "DATA_ROOT", tmp_path)
    monkeypatch.setattr(settings, "DATA_DIR", data_dir)
    monkeypatch.setattr(settings, "UPLOAD_DIR", upload_dir)
    monkeypatch.setattr(settings, "OUTPUT_DIR", tmp_path / "outputs")
    monkeypatch.setattr(data_service, "index", {})
    monkeypatch.setattr(data_service, "data_index_file", data_dir / "index.json")
    monkeypatch.setattr("app.services.dataset_revision_service.bump", lambda *a, **kw: None)

    # 最小可用 xlsx（仅验证同步链路，不解析单元格）
    wb = __import__("openpyxl").Workbook()
    wb.active.title = "4G现网工参(中兴)"
    wb.save(data_dir / MERGED_ID / "original.xlsx")

    entry = {
        "id": MERGED_ID,
        "name": "现网4G5G工参(中兴)_20261122190825",
        "type": "excel",
        "fileType": "merged_current_params",
        "size": 1024,
        "status": "ready",
        "user_id": 1,
        "city": "河源",
        "operator": "电信",
        "metadata": {"sheets": [{"name": "4G现网工参(中兴)", "rows": 1, "matched": 1}]},
    }
    data_service.index[MERGED_ID] = dict(entry)
    return {"data_dir": data_dir, "entry": entry, "data_service": data_service}


def _pack() -> Path:
    from app.services.desktop_dataset_packager import build_package

    return Path(build_package(MERGED_ID)["path"])


def test_package_has_payload_without_source_marker(merged_env):
    names = zipfile.ZipFile(_pack()).namelist()
    assert "meta.json" in names
    assert "original.xlsx" in names
    assert not any(n.startswith("source.") for n in names)


def test_install_keeps_merged_entry_and_registers_workbook(merged_env, monkeypatch):
    from app.services import desktop_dataset_packager as packager
    from app.services.data_service import data_service

    def _must_not_run(*_a, **_kw):  # pragma: no cover - 只在回归时触发
        raise AssertionError("合并产物不得走工参 Excel 解析管线")

    monkeypatch.setattr(data_service, "_process_upload_sync", _must_not_run)
    upserts = []
    monkeypatch.setattr(
        packager, "_upsert_merged_workbook",
        lambda data_id, entry, user_id, city, operator: upserts.append(
            (data_id, user_id, city, operator)
        ),
    )

    zip_path = _pack()
    result = packager.install_package(
        zip_path, user_id=7, city="广州", operator="移动", username="peer"
    )

    assert result == {"data_id": MERGED_ID, "type": "excel"}
    entry = data_service.index[MERGED_ID]
    assert entry["fileType"] == "merged_current_params"
    assert entry["metadata"] == merged_env["entry"]["metadata"]
    assert entry["status"] == "ready"
    assert entry["city"] == "广州" and entry["operator"] == "移动"
    assert (merged_env["data_dir"] / MERGED_ID / "original.xlsx").is_file()
    assert upserts == [(MERGED_ID, 7, "广州", "移动")]
