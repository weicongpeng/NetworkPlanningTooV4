"""残余条目自动清理：空壳数据集必须自动清掉，健康数据不能被误删。

背景（2026-10-07 线上问题）：网页端「已导入数据」里存在 data/<id>/ 是**空目录**、
只剩 uploads/<id>.mif 残留文件的条目——索引里有、数据体没有，表现为：
- 网页端一直列出来，删除后又会因 uploads 残留文件被启动自愈"恢复"回来（删不掉）
- 共享模式桌面端每轮同步都尝试打包空包失败 → 永久显示「同步异常」
"""
from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models.database import Base
from app.services.data_service import data_service


@pytest.fixture()
def isolated_index(tmp_path, monkeypatch):
    """把 data/uploads 目录、索引文件与 SQLite session 都指向临时目录。"""
    data_dir = tmp_path / "data"
    upload_dir = tmp_path / "uploads"
    data_dir.mkdir(parents=True, exist_ok=True)
    upload_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr("app.core.config.settings.DATA_DIR", data_dir)
    monkeypatch.setattr("app.core.config.settings.UPLOAD_DIR", upload_dir)
    monkeypatch.setattr(data_service, "_bound_data_dir", data_dir)
    monkeypatch.setattr(data_service, "data_index_file", data_dir / "index.json")
    monkeypatch.setattr(data_service, "index", {})

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr("app.services.data_service.SessionLocal", Session)
    yield data_dir, upload_dir


def test_prune_removes_husk_entries(isolated_index, monkeypatch):
    """空目录 + uploads 残留文件的 0 要素空壳条目 → 自动清掉，连残留文件一起清。"""
    data_dir, upload_dir = isolated_index
    husk = "77777777-7777-4777-8777-777777777777"
    healthy = "88888888-8888-4888-8888-888888888888"

    (data_dir / husk).mkdir()
    (upload_dir / f"{husk}.mif").write_text("mif", encoding="utf-8")
    healthy_dir = data_dir / healthy
    healthy_dir.mkdir()
    (healthy_dir / "图层.tab").write_text("tab", encoding="utf-8")
    (upload_dir / f"{healthy}.tab").write_text("tab", encoding="utf-8")

    monkeypatch.setattr(data_service, "index", {
        husk: {"id": husk, "name": "残留图层.mif", "type": "map", "subType": "mapinfo",
               "city": "河源", "operator": "电信"},
        healthy: {"id": healthy, "name": "正常图层.tab", "type": "map", "subType": "mapinfo",
                  "city": "河源", "operator": "电信"},
    })
    monkeypatch.setattr(data_service, "_reconcile_allowed", lambda: True)
    monkeypatch.setattr(data_service, "_bump_revision", lambda *a, **kw: None)

    result = data_service.prune_residual_entries()

    assert result["removed"] == ["残留图层.mif"]
    assert husk not in data_service.index
    assert healthy in data_service.index
    # 残留文件一并清掉：否则启动自愈会按它把条目再"恢复"回来（删不掉的根源）
    assert not (upload_dir / f"{husk}.mif").exists()
    assert not (data_dir / husk).exists()
    assert (upload_dir / f"{healthy}.tab").exists()


def test_delete_clears_upload_artifacts_of_any_extension(isolated_index, monkeypatch):
    """删除数据集时 uploads/<id>.* 必须全清（xlsx / zip / mif / tab…）。"""
    data_dir, upload_dir = isolated_index
    data_id = "99999999-9999-4999-8999-999999999999"
    (data_dir / data_id).mkdir()
    (data_dir / data_id / "original.xlsx").write_text("x", encoding="utf-8")
    (upload_dir / f"{data_id}.xlsx").write_text("x", encoding="utf-8")
    (upload_dir / f"{data_id}.mif").write_text("m", encoding="utf-8")

    monkeypatch.setattr(data_service, "index", {
        data_id: {"id": data_id, "name": "数据.xlsx", "type": "excel", "fileType": "full_params"},
    })
    monkeypatch.setattr(data_service, "_bump_revision", lambda *a, **kw: None)

    assert data_service.delete_data(data_id, force=True) is True
    assert data_id not in data_service.index
    assert not any(upload_dir.glob(f"{data_id}.*")), "任意后缀的上传残留都要清掉"


def test_is_packagable_matches_packaging_rules(isolated_index, monkeypatch):
    """可打包判定：目录型看目录有没有文件，表格型看源文件，导入中不判为残余。"""
    data_dir, _upload_dir = isolated_index
    empty_map = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    full_map = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    excel_ok = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    excel_lost = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    processing = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

    (data_dir / empty_map).mkdir()
    (data_dir / full_map).mkdir()
    (data_dir / full_map / "图层.tab").write_text("tab", encoding="utf-8")
    (data_dir / excel_ok).mkdir()
    (data_dir / excel_ok / "original.xlsx").write_text("x", encoding="utf-8")
    (data_dir / excel_lost).mkdir()

    monkeypatch.setattr(data_service, "index", {
        empty_map: {"id": empty_map, "type": "map"},
        full_map: {"id": full_map, "type": "map"},
        excel_ok: {"id": excel_ok, "type": "excel", "fileType": "full_params"},
        excel_lost: {"id": excel_lost, "type": "excel", "fileType": "full_params"},
        processing: {"id": processing, "type": "excel", "status": "processing"},
    })
    monkeypatch.setattr(data_service, "_known_db_ids", lambda: set())

    assert data_service.is_packagable(empty_map) is False
    assert data_service.is_packagable(full_map) is True
    assert data_service.is_packagable(excel_ok) is True
    assert data_service.is_packagable(excel_lost) is False
    assert data_service.is_packagable(processing) is True  # 导入中不算残余


def test_reconcile_no_longer_revives_husks(isolated_index, monkeypatch):
    """空目录 + uploads 残留文件不再恢复成条目（那种组合就是删不掉的残余）。"""
    data_dir, upload_dir = isolated_index
    husk = "12121212-1212-4121-8121-121212121212"
    real = "13131313-1313-4131-8131-131313131313"

    (data_dir / husk).mkdir()
    (upload_dir / f"{husk}.tab").write_text("tab", encoding="utf-8")
    (data_dir / real).mkdir()
    (data_dir / real / "镇界.tab").write_text("tab", encoding="utf-8")

    monkeypatch.setattr(data_service, "index", {})
    monkeypatch.setattr(data_service, "_known_db_ids", lambda: set())
    monkeypatch.setattr(
        data_service, "_recovered_group", lambda: (1, "admin", "河源", "电信")
    )
    monkeypatch.setattr(data_service, "_reconcile_allowed", lambda: True)
    monkeypatch.setattr(data_service, "_bump_revision", lambda *a, **kw: None)

    result = data_service._reconcile_index()

    assert husk not in data_service.index, "空壳不得再恢复成条目"
    assert result["recovered"] == ["镇界.tab"]
    assert data_service.index[real]["city"] == "河源"
