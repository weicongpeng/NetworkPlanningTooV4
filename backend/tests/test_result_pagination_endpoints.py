"""结果分页接口：meta / sources / rows / map 与 ETag。"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models.database import Base, TaskResult
from app.services import task_result_index_service as index_service


@pytest.fixture()
def api_env(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr("app.core.database.SessionLocal", Session)
    monkeypatch.setattr(index_service, "SessionLocal", Session)

    from app.api import create_app
    from app.core.data_access import require_task_access

    app = create_app()
    app.dependency_overrides[require_task_access] = lambda: ("河源", "联通")
    client = TestClient(app)
    return Session, client


def _seed_neighbor(Session):
    result = {
        "totalSectors": 2,
        "totalNeighbors": 2,
        "results": [
            {"relationType": "LTE-LTE", "sourceSiteId": "S1", "sourceCellId": "1",
             "sourceCellName": "A", "sourcePci": 10, "sourceFrequency": 1850,
             "targetSiteId": "S2", "targetCellId": "1", "targetCellName": "B",
             "targetPci": 11, "targetFrequency": 1850, "distance": 0.2},
            {"relationType": "LTE-LTE", "sourceSiteId": "S2", "sourceCellId": "2",
             "sourceCellName": "C", "sourcePci": 20, "sourceFrequency": 1850,
             "targetSiteId": "S1", "targetCellId": "1", "targetCellName": "A",
             "targetPci": 10, "targetFrequency": 1850, "distance": 0.3},
        ],
    }
    db = Session()
    try:
        db.add(TaskResult(
            task_id="t-nb", task_type="neighbor", task_name="邻区", user_name="tester",
            status="completed", city="河源", operator="联通",
            created_at="2026-10-20T10:00:00",
            summary_json=json.dumps({"totalNeighbors": 2, "cellCount": 2}),
            cell_count=2,
            result_json=json.dumps(result, ensure_ascii=False),
        ))
        db.commit()
    finally:
        db.close()
    index_service.index_task_result("t-nb", "neighbor", result)


def test_neighbor_pagination_endpoints(api_env):
    Session, client = api_env
    _seed_neighbor(Session)

    meta = client.get("/api/v1/neighbor/result/t-nb/meta")
    assert meta.status_code == 200
    assert meta.json()["data"]["rowsReady"] is True
    assert meta.json()["data"]["summary"]["cellCount"] == 2

    sources = client.get("/api/v1/neighbor/result/t-nb/sources?page=1&page_size=10")
    assert sources.status_code == 200
    data = sources.json()["data"]
    assert data["total"] == 2
    assert len(data["sources"]) == 2
    etag = sources.headers.get("etag")
    assert etag
    assert client.get(
        "/api/v1/neighbor/result/t-nb/sources?page=1&page_size=10",
        headers={"If-None-Match": etag},
    ).status_code == 304

    rows = client.get("/api/v1/neighbor/result/t-nb/rows?page=1&page_size=1")
    assert rows.status_code == 200
    assert rows.json()["data"]["total"] == 2
    assert rows.json()["data"]["rows"][0]["targetCellName"] == "B"

    relations = client.get(
        "/api/v1/neighbor/result/t-nb/neighbors?sourceSiteId=S1&sourceCellId=1"
    )
    assert relations.status_code == 200
    assert relations.json()["data"]["rows"][0]["targetSiteId"] == "S2"


def test_tac_pagination_and_map(api_env):
    Session, client = api_env
    result = {
        "networkType": "LTE",
        "totalCells": 2,
        "results": [
            {"siteId": "S1", "sectorId": "1", "siteName": "站点1", "sectorName": "小区1",
             "networkType": "LTE", "longitude": 114.1, "latitude": 23.1,
             "tac": "100", "existingTac": "100", "matched": True, "isSingularity": False},
            {"siteId": "S2", "sectorId": "2", "siteName": "站点2", "sectorName": "小区2",
             "networkType": "LTE", "longitude": 114.2, "latitude": 23.2,
             "tac": "200", "existingTac": "300", "matched": False, "isSingularity": True},
        ],
    }
    db = Session()
    try:
        db.add(TaskResult(
            task_id="t-tac", task_type="tac", task_name="TAC", user_name="tester",
            status="completed", city="河源", operator="联通",
            created_at="2026-10-20T10:00:00",
            summary_json=json.dumps({"networkType": "LTE", "totalCells": 2, "cellCount": 2}),
            cell_count=2,
            result_json=json.dumps(result, ensure_ascii=False),
        ))
        db.commit()
    finally:
        db.close()
    index_service.index_task_result("t-tac", "tac", result)

    rows = client.get("/api/v1/tac/result/t-tac/rows?page=1&page_size=10&networkType=LTE")
    assert rows.status_code == 200
    assert rows.json()["data"]["total"] == 2

    filtered = client.get("/api/v1/tac/result/t-tac/rows?page=1&page_size=10&matched=未匹配")
    assert filtered.json()["data"]["total"] == 1

    map_resp = client.get("/api/v1/tac/result/t-tac/map")
    assert map_resp.status_code == 200
    assert len(map_resp.json()["data"]["rows"]) == 2
