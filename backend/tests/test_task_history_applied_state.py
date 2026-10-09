"""历史任务「已应用」状态必须严格跟随当前全量工参（桌面端历史列表 · 操作列）。

回归背景（2026-10-10 用户报「应用状态仍与工参不匹配」）：
- 只看 workbook id 做缓存键 → 导入/同步一份内容不同但 id 相同的工参时，
  最长 5 分钟内判定的仍是旧值（TTL 兜底才会重算）；
- 规划结果里的 siteId/sectorId 常是浮点写法（"32.0"），而 SQLite 里存的是 "32"；
- PCI/TAC 也可能一边是 486、另一边是 "486.0"，字符串直比会误判为不一致。

口径：操作列一律把规划结果与**当前全量工参的 PCI/TAC 列值**比对，一致即「已应用」
（高亮消失），不一致即「未应用」（保持高亮）。
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models.database import Base, Site, Sector, TaskResult, Workbook
from app.services.data_service import data_service
from app.services.task_manager import TaskManager, task_manager

WB_ID = "wb-history-verify"
USER = SimpleNamespace(city="河源", operator="联通", is_admin=False)


@pytest.fixture()
def params_db(monkeypatch):
    """内存 SQLite + 一份全量工参；TaskManager 与 core.database 的会话都指向它。"""
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
        {
            WB_ID: {
                "fileType": "full_params",
                "city": "河源",
                "operator": "联通",
                "uploadDate": "2026-10-10T00:00:00",
            }
        },
    )
    monkeypatch.setattr(
        TaskManager, "_resolve_full_params_id", staticmethod(lambda city=None, operator=None: WB_ID)
    )
    TaskManager._sector_values_cache = {}
    TaskManager._history_verify_cache.clear()
    try:
        yield Session
    finally:
        TaskManager._sector_values_cache = {}
        TaskManager._history_verify_cache.clear()


def _seed_work_params(Session, *, sector_id="32", pci=486, tac=33807):
    db = Session()
    try:
        db.add(Workbook(
            id=WB_ID, user_id=1, city="河源", operator="联通", name="全量工参",
            file_type="full_params", status="completed", created_at="2026-10-10T00:00:00",
        ))
        db.flush()
        site = Site(
            workbook_id=WB_ID, user_id=1, city="河源", operator="联通",
            site_id="S1", name="站点S1", network_type="LTE",
        )
        db.add(site)
        db.flush()
        db.add(Sector(
            workbook_id=WB_ID, user_id=1, site_id_fk=site.id,
            sector_id=sector_id, pci=pci, tac=tac,
        ))
        db.commit()
    finally:
        db.close()


def _rewrite_work_params(Session, *, pci=None, tac=None):
    """同 id 原地改写工参内容（模拟"导入新工参"沿用同一数据集 id 的场景）。"""
    db = Session()
    try:
        row = db.query(Sector).filter(Sector.workbook_id == WB_ID).first()
        if pci is not None:
            row.pci = pci
        if tac is not None:
            row.tac = tac
        db.commit()
    finally:
        db.close()


def _add_pci_task(Session, *, task_id="t-verify-pci", sector_id="32.0", pci=486.0, tac="33807"):
    db = Session()
    try:
        db.add(TaskResult(
            task_id=task_id, task_type="pci", task_name="PCI规划", user_name="tester",
            status="completed", city="河源", operator="联通",
            created_at="2026-10-10T01:00:00",
            result_json=json.dumps({
                "results": [{
                    "siteId": "S1",
                    "sectors": [{"sectorId": sector_id, "newPCI": pci, "tac": tac}],
                }]
            }),
        ))
        db.commit()
    finally:
        db.close()


def _applied_of(task_id: str) -> bool:
    history = task_manager.list_task_history(task_type="pci", page=1, page_size=20, user=USER)
    row = next(t for t in history["tasks"] if t["taskId"] == task_id)
    return row["isApplied"]


def test_applied_state_follows_current_work_params(params_db):
    """同一份工参 id 内容改写后，操作列状态必须立即跟着变（不等 TTL）。"""
    _seed_work_params(params_db)
    _add_pci_task(params_db)

    # 结果里是 "32.0"/486.0/"33807"，工参里是 "32"/486/33807 → 归一化后判定一致
    assert _applied_of("t-verify-pci") is True

    # PCI 被改写 → 不再一致
    _rewrite_work_params(params_db, pci=487)
    assert _applied_of("t-verify-pci") is False

    # 改回来 → 重新一致（缓存不能把上一次的"不一致"钉住）
    _rewrite_work_params(params_db, pci=486)
    assert _applied_of("t-verify-pci") is True


def test_applied_state_follows_tac_of_current_work_params(params_db):
    """TAC 数值同理：工参 tac 变化后立即反映到状态上。"""
    _seed_work_params(params_db, tac=33807)
    _add_pci_task(params_db, task_id="t-verify-tac", tac="33807")

    assert _applied_of("t-verify-tac") is True

    _rewrite_work_params(params_db, tac=33808)
    assert _applied_of("t-verify-tac") is False
