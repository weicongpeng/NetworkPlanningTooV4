"""索引污染与自愈：测试不得写生产 index.json，启动对账要能清幽灵、找回丢失数据。

回归背景（2026-10-07 线上事故）：
- `data_service` 是进程级单例，`data_index_file` 在构造时固化为生产路径；
  测试把 `settings.DATA_DIR` 指向 tmp 后，写索引仍落到生产 `data/index.json`，
  把用户正常数据的索引条目覆盖丢失，并混入一批 pytest 临时条目
  （"空图层/打包/升级/删空测试"等 name，source_file 指向 /tmp/pytest-*）。
- 启动期间 `cleanup_index()` 用被切换的数据根判断"目录不存在"，把生产条目
  当无效项删除；随后任意 `_save_index()` 把删除落盘，数据索引永久丢失。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.data_service import data_service


@pytest.fixture()
def isolated_index(tmp_path, monkeypatch):
    """把 data/uploads 目录与索引文件都指向临时目录，并模拟"生产绑定"。"""
    data_dir = tmp_path / "data"
    upload_dir = tmp_path / "uploads"
    data_dir.mkdir(parents=True, exist_ok=True)
    upload_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr("app.core.config.settings.DATA_DIR", data_dir)
    monkeypatch.setattr("app.core.config.settings.UPLOAD_DIR", upload_dir)
    monkeypatch.setattr(data_service, "_bound_data_dir", data_dir)
    monkeypatch.setattr(data_service, "data_index_file", data_dir / "index.json")
    monkeypatch.setattr(data_service, "index", {})
    yield data_dir, upload_dir


def test_save_index_does_not_write_stale_root(tmp_path, monkeypatch):
    """核心防护：实例绑定的数据根已切换时，写索引不得落到旧（生产）路径。

    历史事故就发生在"测试把 data_index_file 恢复成构造时的生产路径"之后：
    settings.DATA_DIR 已是 tmp，但 self.data_index_file 仍指向生产 → 覆盖生产索引。
    """
    prod_root = tmp_path / "prod"
    prod_data = prod_root / "data"
    prod_data.mkdir(parents=True, exist_ok=True)

    # 模拟"生产时刻的构造"：实例绑定生产根
    monkeypatch.setattr(data_service, "_bound_data_dir", prod_data)
    monkeypatch.setattr(data_service, "data_index_file", prod_data / "index.json")

    # 模拟测试：数据根切到 tmp，但（错误地）把索引路径"恢复"成生产路径
    test_data = tmp_path / "sandbox" / "data"
    test_data.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr("app.core.config.settings.DATA_DIR", test_data)

    monkeypatch.setattr(data_service, "index", {"sandbox": {"id": "sandbox", "name": "测试条目"}})
    data_service._save_index()

    assert (test_data / "index.json").is_file(), "应写入当前数据根"
    assert not (prod_data / "index.json").exists(), "绝不能写进旧（生产）数据根"


def test_cleanup_keeps_entries_with_data_artifacts(isolated_index, monkeypatch):
    """清理无效索引时：目录缺失但 uploads 还有文件（或 DB 有记录）的条目不能删。"""
    data_dir, upload_dir = isolated_index
    keep_upload = "11111111-1111-4111-8111-111111111111"
    keep_db = "22222222-2222-4222-8222-222222222222"
    ghost = "33333333-3333-4333-8333-333333333333"

    (upload_dir / f"{keep_upload}.tab").write_text("tab", encoding="utf-8")
    monkeypatch.setattr(
        data_service, "_known_db_ids", lambda: {keep_db}
    )
    monkeypatch.setattr(data_service, "index", {
        keep_upload: {"id": keep_upload, "name": "数据还在.tab", "type": "map"},
        keep_db: {"id": keep_db, "name": "DB有记录.xlsx", "type": "excel"},
        ghost: {"id": ghost, "name": "幽灵条目.tab", "type": "map"},
    })

    result = data_service.cleanup_index()

    assert result["removed"] == 1
    assert ghost not in data_service.index
    assert keep_upload in data_service.index and keep_db in data_service.index
    # 清理结果必须落盘，否则下次 reload 又从 index.json 读回来
    saved = json.loads((data_dir / "index.json").read_text(encoding="utf-8"))
    assert ghost not in saved and keep_upload in saved


def test_reconcile_removes_ghosts_and_recovers_orphans(isolated_index, monkeypatch):
    """启动对账：清掉无文件的幽灵条目，把磁盘上还在的数据恢复成索引条目。"""
    data_dir, upload_dir = isolated_index
    ghost = "44444444-4444-4444-8444-444444444444"
    orphan_upload = "55555555-5555-4555-8555-555555555555"
    orphan_dir = "66666666-6666-4666-8666-666666666666"

    # 幽灵：索引里有、目录与 uploads 都没有（测试残留典型形态）
    monkeypatch.setattr(data_service, "index", {
        ghost: {"id": ghost, "name": "空层.tab", "type": "map", "subType": "mapinfo"},
    })
    # 孤儿 1：data 目录空了，但 uploads 文件还在
    (upload_dir / f"{orphan_upload}.tab").write_text("tab", encoding="utf-8")
    (data_dir / orphan_upload).mkdir(exist_ok=True)
    # 孤儿 2：data 目录里有文件、uploads 也有
    layer_dir = data_dir / orphan_dir
    layer_dir.mkdir()
    (layer_dir / "RSRP.tab").write_text("tab", encoding="utf-8")
    (upload_dir / f"{orphan_dir}.tab").write_text("tab", encoding="utf-8")

    monkeypatch.setattr(data_service, "_known_db_ids", lambda: set())
    monkeypatch.setattr(
        data_service, "_recovered_group", lambda: (1, "admin", "河源", "电信")
    )
    monkeypatch.setattr(data_service, "_reconcile_allowed", lambda: True)

    result = data_service._reconcile_index()

    assert result["removed"] == ["空层.tab"]
    assert set(result["recovered"]) == {"RSRP.tab", f"{orphan_upload}.tab"}
    assert ghost not in data_service.index
    assert data_service.index[orphan_dir]["type"] == "map"
    assert data_service.index[orphan_dir]["subType"] == "mapinfo"
    assert data_service.index[orphan_dir]["city"] == "河源"
    assert data_service.index[orphan_dir]["recovered"] is True

    saved = json.loads((data_dir / "index.json").read_text(encoding="utf-8"))
    assert ghost not in saved and orphan_dir in saved


def test_reconcile_skips_when_data_root_switched(isolated_index, monkeypatch):
    """数据根被切换（测试/迁移）时不得执行自愈，避免用临时判断改生产索引。"""
    data_dir, _upload_dir = isolated_index
    monkeypatch.setattr(data_service, "_bound_data_dir", data_dir.parent / "other-root")
    monkeypatch.setattr(data_service, "index", {"x": {"id": "x"}})

    # 真实判定：绑定的数据根与当前不一致 → 拒绝执行
    monkeypatch.setattr(
        data_service.__class__, "_reconcile_allowed", data_service.__class__._reconcile_allowed
    )
    assert data_service._reconcile_allowed() is False

    result = data_service._reconcile_index()

    assert result.get("skipped") is True
    assert data_service.index == {"x": {"id": "x"}}
    assert not (data_dir / "index.json").exists()


def test_reconcile_skipped_in_pytest_even_when_root_matches(isolated_index):
    """即使数据根与绑定点一致，测试进程也不得执行自愈（不得改生产索引）。"""
    from app.core.config import settings

    data_dir, _upload_dir = isolated_index
    assert data_dir == settings.DATA_DIR  # 绑定点已对齐（模拟生产）
    assert data_service._reconcile_allowed() is False


def test_purge_stale_tmp_layer_rows(isolated_index, monkeypatch):
    """指向 /tmp 且文件已不存在的图层行要清掉（否则重建索引时又变幽灵条目）。"""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from app.models.database import Base, Layer

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    monkeypatch.setattr("app.services.data_service.SessionLocal", Session)

    db = Session()
    from datetime import datetime

    now = datetime.now().isoformat()
    # pytest 残留：即使文件还在（临时目录尚未清理）也要删
    pytest_file = "/tmp/pytest-of-pwc/pytest-9/x/data/a/打包.shp"
    Path(pytest_file).parent.mkdir(parents=True, exist_ok=True)
    Path(pytest_file).write_text("shp", encoding="utf-8")

    db.add_all([
        Layer(id="t1", user_id=1, name="打包", layer_type="mapinfo", geometry_type="point",
              feature_count=0, file_size=0, created_at=now, file_path=pytest_file),
        Layer(id="l1", user_id=1, name="真实图层", layer_type="mapinfo", geometry_type="point",
              feature_count=0, file_size=0, created_at=now,
              file_path="/home/pwc/NetworkPlanningTooV3/data/keep/真实图层.tab"),
    ])
    db.commit()
    db.close()

    purged = data_service._purge_stale_layer_rows()

    assert purged == 1
    db = Session()
    try:
        names = [row.name for row in db.query(Layer).all()]
    finally:
        db.close()
    assert names == ["真实图层"]
