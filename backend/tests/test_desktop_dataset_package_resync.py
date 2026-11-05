"""数据集打包必须基于「已回写的 Excel」，同一数据集重复导入不能翻倍。

回归背景（2026-11-04 用户报「桌面端地图扇区 PCI 为空、历史任务应用状态两端不一致」）：
- 应用 PCI 后 `inplace_updated=True` / `excel_synced=False`，Excel 回写是后台任务；
  历史列表读取工参缓存时会把 `inplace_updated` 置回 False（表示"已消费"），
  打包若按它判断就会直接发旧 Excel —— 对端记下新修订号却拿到应用前的内容，
  rev 相同后再也不会重拉，两端永久分叉。
- `_save_to_sqlite` 对同一 data_id 只做追加，网页端覆盖上传同名工参会让
  小区行翻倍（同一小区两条 Site/Sector），应用 PCI 只更新其中一份。
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.models.database import Base, Sector, Site, Workbook
from app.services import data_service as data_service_module
from app.services import desktop_dataset_packager as packager
from app.services.data_service import data_service
from app.services.task_manager import TaskManager


@pytest.fixture(autouse=True)
def _empty_index(monkeypatch):
    """隔离单例索引：绝不能让测试写进真实的 index.json。"""
    monkeypatch.setattr(data_service, "index", {})
    monkeypatch.setattr(data_service, "_save_index", lambda *a, **kw: None)


@pytest.fixture()
def temp_db(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr("app.core.database.SessionLocal", Session)
    monkeypatch.setattr(data_service_module, "SessionLocal", Session)
    return Session


def _entry(data_id: str, *, excel_synced: bool, inplace: bool) -> dict:
    entry = {"fileType": "full_params", "inplace_updated": inplace, "excel_synced": excel_synced}
    data_service.index[data_id] = dict(entry)
    return entry


def test_package_resyncs_when_inplace_flag_consumed_but_excel_not_synced(tmp_path, monkeypatch):
    """inplace_updated 被历史列表消费后，仍要按 excel_synced 回写再打包。"""
    data_id = "wb-resync"
    data_dir = settings.DATA_DIR / data_id
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "original.xlsx").write_bytes(b"placeholder")
    entry = _entry(data_id, excel_synced=False, inplace=False)  # 已被消费

    calls: list = []

    def _sync(did, _logger):
        calls.append(did)
        data_service.index[did]["excel_synced"] = True

    monkeypatch.setattr(TaskManager, "_sync_excel_from_sqlite", staticmethod(_sync))
    packager._ensure_excel_synced(data_id, entry)

    assert calls == [data_id]


def test_package_refuses_when_excel_writeback_fails(tmp_path, monkeypatch):
    """回写没成功时拒绝打包旧文件（宁可同步失败重试，也不发过期工参）。"""
    data_id = "wb-resync-fail"
    (settings.DATA_DIR / data_id).mkdir(parents=True, exist_ok=True)
    (settings.DATA_DIR / data_id / "original.xlsx").write_bytes(b"placeholder")
    entry = _entry(data_id, excel_synced=False, inplace=False)

    # _sync_excel_from_sqlite 内部吞异常只记日志 → excel_synced 仍为 False
    monkeypatch.setattr(
        TaskManager, "_sync_excel_from_sqlite", staticmethod(lambda did, _logger: None)
    )
    with pytest.raises(packager.DatasetPackageError):
        packager._ensure_excel_synced(data_id, entry)


def test_save_to_sqlite_replaces_rows_on_reimport(temp_db, tmp_path, monkeypatch):
    """同一 data_id 二次导入必须替换旧小区行，而不是追加。"""
    data_id = "wb-reimport"
    file_path = tmp_path / f"{data_id}.xlsx"
    file_path.write_bytes(b"placeholder")
    parsed = {
        "LTE": [{
            "id": "S1", "name": "站点S1", "longitude": 114.0, "latitude": 23.0,
            "sectors": [{"id": "32", "name": "小区32", "pci": 486, "tac": "33807"}],
        }]
    }

    for _ in range(2):
        data_service._save_to_sqlite(
            data_id=data_id, filename="工参.xlsx", file_type="full_params", user_id=1,
            parsed_data=parsed, metadata={}, file_path=file_path,
            city="河源", operator="联通",
        )

    db = temp_db()
    try:
        assert db.query(Workbook).filter(Workbook.id == data_id).count() == 1
        assert db.query(Site).filter(Site.workbook_id == data_id).count() == 1
        sectors = db.query(Sector).filter(Sector.workbook_id == data_id).all()
        assert len(sectors) == 1 and sectors[0].pci == 486
    finally:
        db.close()
