"""桌面端共享模式：历史任务导出 + 「已应用」标记与网页端同口径。

回归背景（2026-11-04 用户报）：
1. 桌面端历史任务结果页导出报「导出失败：任务不存在」——镜像任务只在 task_results
   里，`/pci/export` 与 `export_result` 只认内存 tasks，网页端（任务在内存/索引里）正常；
2. 桌面端与网页端部分历史任务的「应用」图标不一致——网页端历史列表用**当前工参**
   动态判定，桌面端镜像行拿到的清单只带存储标记，工参换过/改过之后两边长期分歧。
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models.database import Base, Sector, Site, TaskResult, Workbook
from app.services.data_service import data_service
from app.services.task_manager import TaskManager, task_manager

WB_ID = "wb-shared-export"
CITY, OPERATOR = "河源", "联通"
PCI_RESULT = {
    "status": "completed",
    "networkType": "LTE",
    "results": [{
        "siteId": "S1",
        "siteName": "站点S1",
        "sectors": [{"sectorId": "32", "newPCI": 486, "tac": "33807", "networkType": "LTE"}],
    }],
}


@pytest.fixture()
def temp_db(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr("app.core.database.SessionLocal", Session)
    monkeypatch.setattr("app.services.task_manager.SessionLocal", Session, raising=False)
    monkeypatch.setattr(
        data_service,
        "index",
        {WB_ID: {"fileType": "full_params", "city": CITY, "operator": OPERATOR,
                 "uploadDate": "2026-11-04T00:00:00"}},
    )
    monkeypatch.setattr(
        TaskManager, "_resolve_full_params_id",
        staticmethod(lambda city=None, operator=None: WB_ID),
    )
    TaskManager._sector_values_cache = {}
    try:
        yield Session
    finally:
        TaskManager._sector_values_cache = {}


def _seed_params(Session, *, pci=486, tac=33807):
    db = Session()
    try:
        db.add(Workbook(id=WB_ID, user_id=1, city=CITY, operator=OPERATOR, name="全量工参",
                        file_type="full_params", status="completed",
                        created_at="2026-11-04T00:00:00"))
        db.flush()
        site = Site(workbook_id=WB_ID, user_id=1, city=CITY, operator=OPERATOR,
                    site_id="S1", name="站点S1", network_type="LTE")
        db.add(site)
        db.flush()
        db.add(Sector(workbook_id=WB_ID, user_id=1, site_id_fk=site.id,
                      sector_id="32", pci=pci, tac=tac))
        db.commit()
    finally:
        db.close()


def _add_task(Session, *, task_id="t-shared-1", is_applied=0, result=PCI_RESULT,
              applied_values=None, origin="shared"):
    db = Session()
    try:
        db.add(TaskResult(
            task_id=task_id, task_type="pci", task_name="PCI规划", user_name="tester",
            status="completed", city=CITY, operator=OPERATOR,
            created_at="2026-11-04T01:00:00", origin=origin,
            is_applied=is_applied,
            result_json=json.dumps(result) if result is not None else None,
            applied_values_json=json.dumps(
                applied_values if applied_values is not None else {"S1_32": [486, "33807"]}
            ),
        ))
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------- 导出

def test_export_history_task_not_in_memory(temp_db):
    """镜像/历史任务（不在内存 tasks）必须能导出：类型/状态取 DB，结果取 DB。"""
    _seed_params(temp_db)
    task_manager.tasks.pop("t-shared-1", None)
    _add_task(temp_db)

    assert task_manager.get_task_status("t-shared-1") == "completed"
    path = task_manager.export_result("t-shared-1", "xlsx")
    assert path is not None and path.endswith(".xlsx")

    from pathlib import Path

    assert Path(path).is_file() and Path(path).stat().st_size > 0


def test_export_unknown_task_returns_none(temp_db):
    assert task_manager.get_task_status("no-such-task") is None
    assert task_manager.export_result("no-such-task", "xlsx") is None


def test_export_skips_unfinished_history_task(temp_db):
    _add_task(temp_db, task_id="t-unfinished")
    db = temp_db()
    try:
        db.query(TaskResult).filter(TaskResult.task_id == "t-unfinished").update(
            {"status": "processing"}
        )
        db.commit()
    finally:
        db.close()

    assert task_manager.get_task_status("t-unfinished") == "processing"
    assert task_manager.export_result("t-unfinished", "xlsx") is None
