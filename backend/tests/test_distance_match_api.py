# backend/tests/test_distance_match_api.py
import os
import tempfile
import pandas as pd
from fastapi.testclient import TestClient

from app.api import create_app
from app.core.config import settings
from app.core.security import require_data_import


def _make_client():
    app = create_app()
    app.dependency_overrides[require_data_import] = lambda: None
    return TestClient(app)


def _make_list_excel() -> str:
    """创建含「匹配站点」「全量站点」两个 sheet 的清单文件"""
    tmp = tempfile.mktemp(suffix=".xlsx")
    with pd.ExcelWriter(tmp) as w:
        pd.DataFrame([{"CELL": "M1", "LON": 116.0, "LAT": 39.0}]).to_excel(w, sheet_name="匹配站点", index=False)
        pd.DataFrame([{"CELL": "F1", "LON": 116.001, "LAT": 39.0}]).to_excel(w, sheet_name="全量站点", index=False)
    return tmp


def test_template_download():
    client = _make_client()
    resp = client.get("/api/v1/distance-match/template")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert len(resp.content) > 0


def test_parse_valid():
    path = _make_list_excel()
    client = _make_client()
    with open(path, "rb") as f:
        resp = client.post(
            "/api/v1/distance-match/parse",
            files={"file": ("list.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["data"]["match_total"] == 1
    assert body["data"]["full_total"] == 1
    assert body["data"]["errors"] == []


def test_parse_missing_sheet():
    tmp = tempfile.mktemp(suffix=".xlsx")
    pd.DataFrame([{"CELL": "A", "LON": 116.0, "LAT": 39.0}]).to_excel(tmp, sheet_name="匹配站点", index=False)
    client = _make_client()
    with open(tmp, "rb") as f:
        resp = client.post(
            "/api/v1/distance-match/parse",
            files={"file": ("list.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
    assert resp.status_code == 400
    assert "全量站点" in str(resp.json()["detail"])


def test_match_valid():
    path = _make_list_excel()
    client = _make_client()
    with open(path, "rb") as f:
        resp = client.post(
            "/api/v1/distance-match/match",
            data={"max_distance_km": "1.0"},
            files={"file": ("list.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["data"]["filename"].startswith("匹配结果")
    assert body["data"]["filename"].endswith(".xlsx")
    assert body["data"]["download_url"].startswith("/static/")


def test_match_invalid_threshold():
    path = _make_list_excel()
    client = _make_client()
    with open(path, "rb") as f:
        resp = client.post(
            "/api/v1/distance-match/match",
            data={"max_distance_km": "0"},
            files={"file": ("list.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
    assert resp.status_code == 400
