"""结果明细行索引：分页、搜索、按源小区分组与地图数据。"""
from __future__ import annotations

import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models.database import Base, TaskResult, TaskResultRow
from app.services import task_result_index_service as index_service


@pytest.fixture()
def index_db(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr("app.core.database.SessionLocal", Session)
    monkeypatch.setattr(index_service, "SessionLocal", Session)
    try:
        yield Session
    finally:
        engine.dispose()


def _add_task(Session, task_id: str, task_type: str, result: dict, summary: dict | None = None):
    db = Session()
    try:
        db.add(TaskResult(
            task_id=task_id,
            task_type=task_type,
            task_name=task_id,
            user_name="tester",
            status="completed",
            city="河源",
            operator="联通",
            created_at="2026-10-20T10:00:00",
            summary_json=json.dumps(summary) if summary else None,
            cell_count=(summary or {}).get("cellCount"),
            result_json=json.dumps(result, ensure_ascii=False),
        ))
        db.commit()
    finally:
        db.close()


def _neighbor_result():
    return {
        "totalSectors": 3,
        "totalNeighbors": 3,
        "results": [
            {"relationType": "LTE-LTE", "sourceSiteId": "S1", "sourceCellId": "1",
             "sourceCellName": "A", "sourcePci": 10, "sourceFrequency": 1850,
             "targetSiteId": "S2", "targetCellId": "1", "targetCellName": "B",
             "targetPci": 11, "targetFrequency": 1850, "distance": 0.2},
            {"relationType": "LTE-LTE", "sourceSiteId": "S1", "sourceCellId": "1",
             "sourceCellName": "A", "sourcePci": 10, "sourceFrequency": 1850,
             "targetSiteId": "S3", "targetCellId": "1", "targetCellName": "C",
             "targetPci": 12, "targetFrequency": 1850, "distance": 0.5},
            {"relationType": "LTE-LTE", "sourceSiteId": "S2", "sourceCellId": "2",
             "sourceCellName": "D", "sourcePci": 20, "sourceFrequency": 1850,
             "targetSiteId": "S1", "targetCellId": "1", "targetCellName": "A",
             "targetPci": 10, "targetFrequency": 1850, "distance": 0.3},
        ],
    }


def test_neighbor_index_paging_and_grouping(index_db):
    _add_task(index_db, "t-nb", "neighbor", _neighbor_result(),
              {"totalNeighbors": 3, "cellCount": 3})

    assert index_service.index_task_result("t-nb", "neighbor", _neighbor_result()) == 3
    assert index_service.is_ready("t-nb") is True

    page = index_service.query_rows("t-nb", "neighbor", page=2, page_size=2)
    assert page["total"] == 3
    assert len(page["rows"]) == 1
    assert page["rows"][0]["targetCellName"] == "A"

    filtered = index_service.query_rows(
        "t-nb", "neighbor", page=1, page_size=10, filters={"sourceCellName": "A"}
    )
    assert filtered["total"] == 2

    sources = index_service.query_neighbor_sources("t-nb", page=1, page_size=1)
    assert sources["total"] == 2
    assert sources["sources"][0]["sourceCellId"] == "1"
    assert len(sources["sources"][0]["targets"]) == 2

    relations = index_service.query_neighbor_relations("t-nb", "S2", "2")
    assert len(relations) == 1
    assert relations[0]["targetSiteId"] == "S1"


def test_tac_index_search_and_map(index_db):
    result = {
        "totalCells": 2,
        "results": [
            {"siteId": "S1", "sectorId": "1", "siteName": "站点1", "sectorName": "小区1",
             "networkType": "LTE", "longitude": 114.1, "latitude": 23.1,
             "tac": "100", "existingTac": "100", "matched": True, "isSingularity": False},
            {"siteId": "S2", "sectorId": "2", "siteName": "站点2", "sectorName": "小区2",
             "networkType": "LTE", "longitude": 114.2, "latitude": 23.2,
             "tac": "200", "existingTac": "300", "matched": False, "isSingularity": True,
             "singularityDetails": {"dominantTac": "200"}},
        ],
    }
    _add_task(index_db, "t-tac", "tac", result, {"totalCells": 2, "cellCount": 2})

    assert index_service.index_task_result("t-tac", "tac", result) == 2

    page = index_service.query_rows("t-tac", "tac", page=1, page_size=10,
                                    filters={"matched": "未匹配"})
    assert page["total"] == 1
    assert page["rows"][0]["siteId"] == "S2"

    map_rows = index_service.query_map_rows("t-tac", "tac")
    assert len(map_rows) == 2
    assert map_rows[1]["singularityDetails"]["dominantTac"] == "200"


def test_meta_uses_summary_without_result(index_db):
    _add_task(index_db, "t-meta", "tac", {"results": []}, {"totalCells": 9, "cellCount": 9})
    meta = index_service.get_task_meta("t-meta")
    assert meta["summary"] == {"totalCells": 9, "cellCount": 9}
    assert meta["rowsReady"] is False
    assert meta["rowCount"] == 0


def test_backfill_pending_builds_metadata_and_rows(index_db):
    result = _neighbor_result()
    _add_task(index_db, "t-old", "neighbor", result, None)

    assert index_service.backfill_pending(limit=5) == 1
    meta = index_service.get_task_meta("t-old")
    assert meta["rowsReady"] is True
    assert meta["rowCount"] == 3
    assert meta["summary"]["totalNeighbors"] == 3
