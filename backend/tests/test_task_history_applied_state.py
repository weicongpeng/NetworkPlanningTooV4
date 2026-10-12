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


def _seed_work_params(Session, *, sector_id="32", pci=486, tac=33807, extra_sectors=None):
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
        for sid, sid_pci, sid_tac in [(sector_id, pci, tac)] + list(extra_sectors or []):
            db.add(Sector(
                workbook_id=WB_ID, user_id=1, site_id_fk=site.id,
                sector_id=sid, pci=sid_pci, tac=sid_tac,
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


_UNSET = object()


def _add_pci_task(Session, *, task_id="t-verify-pci", sector_id="32.0", pci=486.0, tac="33807",
                  result=_UNSET, origin="local"):
    db = Session()
    try:
        payload = {
            "results": [{
                "siteId": "S1",
                "sectors": [{"sectorId": sector_id, "newPCI": pci, "tac": tac}],
            }]
        } if result is _UNSET else result
        db.add(TaskResult(
            task_id=task_id, task_type="pci", task_name="PCI规划", user_name="tester",
            status="completed", city="河源", operator="联通",
            created_at="2026-10-10T01:00:00",
            origin=origin,
            result_json=json.dumps(payload) if payload is not None else None,
        ))
        db.commit()
    finally:
        db.close()


def _set_result(Session, task_id, result):
    """模拟结果按需落地（`_fetch_shared_task_result` 写回本机 + 清验证缓存）。"""
    db = Session()
    try:
        row = db.query(TaskResult).filter(TaskResult.task_id == task_id).first()
        row.result_json = json.dumps(result)
        db.commit()
    finally:
        db.close()
    TaskManager._history_verify_cache.pop(task_id, None)


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


def test_applied_state_follows_pci_value_rotation(params_db):
    """PCI 值在小区之间轮换（总量不变）也必须让状态重新判定（2026-10-12）。

    规划应用最常见的形态就是 PCI 值在小空间内轮换（480/481/482 → 482/480/481），
    SUM(pci) 这种裸聚合对此完全不变。若内容指纹不敏感，验证缓存不会失效，
    列表会继续显示旧的「已应用」，违背"工参变更后重新匹配"的要求。
    """
    _seed_work_params(params_db, sector_id="32", pci=486, extra_sectors=[("33", 487, 33807)])
    _add_pci_task(params_db, task_id="t-rotate", result={
        "results": [{
            "siteId": "S1",
            "sectors": [
                {"sectorId": "32", "newPCI": 486},
                {"sectorId": "33", "newPCI": 487},
            ],
        }],
    })
    assert _applied_of("t-rotate") is True

    # 两个小区的 PCI 互换：总和、数量都不变
    db = params_db()
    try:
        s32 = db.query(Sector).filter(Sector.workbook_id == WB_ID, Sector.sector_id == "32").first()
        s33 = db.query(Sector).filter(Sector.workbook_id == WB_ID, Sector.sector_id == "33").first()
        s32.pci, s33.pci = 487, 486
        db.commit()
    finally:
        db.close()
    assert _applied_of("t-rotate") is False


def test_mirror_row_applied_state_uses_result_when_available(params_db):
    """镜像任务的判定来源：本机无结果 → 沿用同步标记；结果落地 → 按当前工参动态比对。

    桌面端正是据此在同步时预拉取小结果（见 desktop_sync_service.PREPULL_RESULT_TYPES），
    让两种来源给出同一答案，避免"点查看后应用状态跳变"。
    """
    _seed_work_params(params_db)                      # 工参 pci=486, tac=33807
    _add_pci_task(params_db, task_id="t-mirror", result=None, origin="shared")
    assert _applied_of("t-mirror") is False           # 无结果 → 沿用同步来的标记（0）

    # "查看"触发结果按需落地 → 改走动态比对：规划值与当前工参一致 → 已应用
    _set_result(params_db, "t-mirror", {
        "results": [{"siteId": "S1", "sectors": [{"sectorId": "32", "newPCI": 486, "tac": "33807"}]}],
    })
    assert _applied_of("t-mirror") is True

    # 工参再变化 → 立即回到未应用（缓存不能把上一次的结论钉住）
    _rewrite_work_params(params_db, pci=100)
    assert _applied_of("t-mirror") is False


def test_result_without_comparable_values_keeps_synced_flag(params_db):
    """结果里没有可比的 PCI/TAC 值（如空 results）时不能凭空判成"已应用"。"""
    _seed_work_params(params_db)
    _add_pci_task(params_db, task_id="t-empty", result={"results": []}, origin="shared")

    assert _applied_of("t-empty") is False            # 沿用标记，而不是空结果的 True

    _add_pci_task(params_db, task_id="t-nb", result={"results": [{"siteId": "S1"}]})
    assert _applied_of("t-nb") is False
