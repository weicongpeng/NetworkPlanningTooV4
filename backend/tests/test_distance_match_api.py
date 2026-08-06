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


def _make_full_sheet_excel() -> str:
    """创建仅含「全量站点」sheet 的全量站点工参文件"""
    tmp = tempfile.mktemp(suffix=".xlsx")
    with pd.ExcelWriter(tmp) as w:
        pd.DataFrame([{"CELL": "F1", "LON": 116.001, "LAT": 39.0}]).to_excel(w, sheet_name="全量站点", index=False)
    return tmp


def test_match_full_file_path():
    """full_file_path 模式：全量站点文件仅含「全量站点」sheet 也应成功"""
    path = _make_list_excel()
    full_path = _make_full_sheet_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f, open(full_path, "rb") as ff:
            resp = client.post(
                "/api/v1/distance-match/match",
                data={"max_distance_km": "1.0", "full_file_path": full_path},
                files={"file": ("list.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["data"]["filename"].startswith("匹配结果")
    finally:
        for p in (path, full_path):
            if os.path.exists(p):
                os.unlink(p)


def test_match_full_data_id(monkeypatch):
    """full_data_id 模式：从数据管理工参读取全量站点"""
    path = _make_list_excel()
    client = _make_client()
    from app.services import data_service as ds_mod
    monkeypatch.setattr(
        ds_mod.data_service,
        "get_data",
        lambda data_id: {"LTE": [{"CELL": "F1", "LON": 116.001, "LAT": 39.0}]},
    )
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/distance-match/match",
                data={
                    "max_distance_km": "1.0",
                    "full_data_id": "d1",
                    "full_network_type": "LTE",
                    "full_name_col": "CELL",
                    "full_lon_col": "LON",
                    "full_lat_col": "LAT",
                },
                files={"file": ("list.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["data"]["filename"].startswith("匹配结果")
    finally:
        if os.path.exists(path):
            os.unlink(path)


def test_match_file_path_non_upload():
    """file_path 模式：通过 match_file_path 直接指定清单路径（非上传）"""
    path = _make_list_excel()
    client = _make_client()
    try:
        resp = client.post(
            "/api/v1/distance-match/match",
            data={"max_distance_km": "1.0", "match_file_path": path},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
    finally:
        if os.path.exists(path):
            os.unlink(path)


def test_match_output_file_written():
    """match 成功后在 OUTPUT_DIR 生成输出文件"""
    path = _make_list_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/distance-match/match",
                data={"max_distance_km": "1.0"},
                files={"file": ("list.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            )
        assert resp.status_code == 200
        body = resp.json()
        out_file = settings.OUTPUT_DIR / body["data"]["filename"]
        assert out_file.is_file()
    finally:
        if os.path.exists(path):
            os.unlink(path)


def test_parse_csv_rejected():
    """CSV 上传应返回 400（仅支持 Excel .xlsx/.xls）"""
    tmp = tempfile.mktemp(suffix=".csv")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("CELL,LON,LAT\nM1,116.0,39.0\n")
    client = _make_client()
    try:
        with open(tmp, "rb") as f:
            resp = client.post(
                "/api/v1/distance-match/parse",
                files={"file": ("list.csv", f, "text/csv")},
            )
        assert resp.status_code == 400
        assert "仅支持 Excel 文件" in str(resp.json()["detail"])
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def test_data_sheets_endpoint_fallback(monkeypatch):
    """data-sheets 在 original 缺失时兜底返回网络分表"""
    client = _make_client()
    from app.services import data_service as ds_mod
    monkeypatch.setattr(ds_mod.data_service, "get_data", lambda data_id: {"LTE": [{"CELL": "A"}], "NR": [{"CELL": "B"}]})
    resp = client.post("/api/v1/distance-match/data-sheets", data={"data_id": "d1"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["data"]["source"] == "network"
    assert set(body["data"]["sheets"]) == {"LTE", "NR"}


def test_data_sheets_endpoint_excel(tmp_path, monkeypatch):
    """data-sheets 返回原始 Excel 真实 sheet"""
    client = _make_client()
    import pandas as pd
    from app.services import distance_match_service as dms
    # 构造 data/{d1}/original.xlsx
    d1 = tmp_path / "d1"
    d1.mkdir()
    original = d1 / "original.xlsx"
    with pd.ExcelWriter(original) as w:
        pd.DataFrame({"CELL": ["A"], "LON": [1.0], "LAT": [1.0]}).to_excel(w, sheet_name="LTE Project Parameters", index=False)
        pd.DataFrame({"CELL": ["B"], "LON": [1.0], "LAT": [1.0]}).to_excel(w, sheet_name="NR Project Parameters", index=False)
    monkeypatch.setattr(dms.settings, "DATA_DIR", tmp_path)
    resp = client.post("/api/v1/distance-match/data-sheets", data={"data_id": "d1"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["data"]["source"] == "excel"
    assert "LTE Project Parameters" in body["data"]["sheets"]


def test_data_sheets_endpoint_not_found(monkeypatch):
    """data-sheets 对不存在的 data_id 返回 400"""
    client = _make_client()
    from app.services import data_service as ds_mod
    monkeypatch.setattr(ds_mod.data_service, "get_data", lambda data_id: None)
    resp = client.post("/api/v1/distance-match/data-sheets", data={"data_id": "ghost"})
    assert resp.status_code == 400


def test_data_sheets_endpoint_metadata_only(monkeypatch):
    """data-sheets 对 processing 元数据 dict 兜底返回默认网络分表"""
    client = _make_client()
    from app.services import data_service as ds_mod
    monkeypatch.setattr(ds_mod.data_service, "get_data", lambda data_id: {"id": "x", "name": "y", "fileType": "full_params", "status": "processing"})
    resp = client.post("/api/v1/distance-match/data-sheets", data={"data_id": "d1"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["data"]["source"] == "network"
    assert set(body["data"]["sheets"]) == {"LTE", "NR"}
