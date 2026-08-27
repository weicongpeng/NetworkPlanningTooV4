"""查询/更新：搜索 + 批量更新/删除测试"""
import pytest
from app.services.data_service import data_service


@pytest.fixture()
def query_env():
    """构造含 LTE/NR 多个站点/小区 + 全量工参 Excel 的环境（DB + 文件系统隔离）"""
    import uuid
    from app.core.database import SessionLocal
    from app.models.database import Workbook, Site, Sector

    wb_id = f"test-q-{uuid.uuid4()}"
    db = SessionLocal()
    db.add(Workbook(id=wb_id, user_id=1, name="q-test", file_type="full_params",
                    status="completed", created_at="2026-08-26"))
    db.commit()

    def _site(site_id, name, nt, lon, lat, me):
        s = Site(workbook_id=wb_id, user_id=1, site_id=site_id, name=name,
                 network_type=nt, longitude=lon, latitude=lat, managed_element_id=me)
        db.add(s)
        db.flush()
        return s

    lte = _site("111", "天河一号站", "LTE", 113.0, 23.0, "2001")
    nr = _site("222", "天河二号站", "NR", 113.1, 23.1, "2002")
    db.add(Sector(site_id_fk=lte.id, workbook_id=wb_id, user_id=1, sector_id="111_1",
                  name="TH-1", longitude=113.0, latitude=23.0, azimuth=0,
                  frequency=1825.0, cell_cover_type=1))
    db.add(Sector(site_id_fk=lte.id, workbook_id=wb_id, user_id=1, sector_id="111_2",
                  name="TH-2", longitude=113.0, latitude=23.0, azimuth=120))
    db.add(Sector(site_id_fk=nr.id, workbook_id=wb_id, user_id=1, sector_id="222_1",
                  name="NR-1", longitude=113.1, latitude=23.1, azimuth=0,
                  frequency=327040.0, cell_cover_type=4))
    db.commit()
    db.close()
    yield wb_id

    db = SessionLocal()
    try:
        for s in db.query(Sector).filter(Sector.workbook_id == wb_id).all():
            db.delete(s)
        for s in db.query(Site).filter(Site.workbook_id == wb_id).all():
            db.delete(s)
        wb = db.query(Workbook).filter(Workbook.id == wb_id).first()
        if wb:
            db.delete(wb)
        db.commit()
    finally:
        db.close()


def test_search_by_cell_name(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("TH-", workbook_id=query_env)
    names = {i["cellName"] for i in r}
    assert names == {"TH-1", "TH-2"}


def test_search_by_site_id(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("222", workbook_id=query_env)
    assert {i["cellName"] for i in r} == {"NR-1"}


def test_search_by_me_id(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("2001", workbook_id=query_env)
    assert {i["cellName"] for i in r} == {"TH-1", "TH-2"}


def test_search_by_site_name(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("天河", workbook_id=query_env)
    assert {i["cellName"] for i in r} == {"TH-1", "TH-2", "NR-1"}
    assert {i["siteName"] for i in r} == {"天河一号站", "天河二号站"}


def test_search_case_insensitive_and_rowkey(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("th-1", workbook_id=query_env)
    assert len(r) == 1
    item = r[0]
    assert item["rowKey"].count(":") == 1          # "site_id:sector_id"
    assert item["networkType"] == "LTE"


def test_search_network_type_filter(query_env):
    data_service._invalidate_cell_search_index()
    r = data_service.search_cells("天河", network_type="NR", workbook_id=query_env)
    assert {i["cellName"] for i in r} == {"NR-1"}


def test_search_empty_result_and_limit(query_env):
    data_service._invalidate_cell_search_index()
    assert data_service.search_cells("不存在", workbook_id=query_env) == []
    r = data_service.search_cells("天", limit=1, workbook_id=query_env)
    assert len(r) == 1  # 只返回 1 条


@pytest.fixture()
def excel_env(query_env, tmp_path, monkeypatch):
    """query_env 之上叠加隔离文件系统 + 最小全量工参 Excel"""
    from openpyxl import Workbook
    from app.core.config import settings
    from app.services.data_service import data_service

    monkeypatch.setattr(settings, "DATA_DIR", tmp_path)
    monkeypatch.setattr(data_service, "data_index_file", tmp_path / "index.json")

    excel_path = tmp_path / query_env / "original.xlsx"
    excel_path.parent.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    lte_ws = wb.active
    lte_ws.title = "LTE Project Parameters"
    lte_ws.append(["管理网元ID", "eNodeB标识", "小区标识", "小区名称",
                   "小区经度", "小区纬度", "天线方向角", "下行链路的中心载频", "小区覆盖类型"])
    lte_ws.append(["2001", 111, 1, "TH-1", 113.0, 23.0, 0, 1825.0, 1])
    lte_ws.append(["2001", 111, 2, "TH-2", 113.0, 23.0, 120, 1825.0, 1])
    nr_ws = wb.create_sheet("NR Project Parameters")
    nr_ws.append(["管理网元ID", "gNodeB标识", "小区标识", "小区名称",
                  "小区经度", "小区纬度", "天线方向角", "填写SSB频点", "小区覆盖类型"])
    nr_ws.append(["2002", 222, 1, "NR-1", 113.1, 23.1, 0, 327040.0, 4])
    wb.save(excel_path)
    wb.close()

    data_service.index[query_env] = {"fileType": "full_params", "id": query_env}
    yield query_env
    data_service.index.pop(query_env, None)


def test_validate_cell_fields(query_env):
    ok, errs = data_service.validate_cell_fields({
        "managedElementId": "2001", "siteId": "111", "cellId": "1",
        "cellName": "X", "mnc": "11", "longitude": 113, "latitude": 23,
        "azimuth": 120, "frequency": "1825", "cellCoverType": 1,
    }, "LTE")
    assert ok and not errs


def test_validate_cell_fields_out_of_range(query_env):
    ok, errs = data_service.validate_cell_fields({
        "managedElementId": "2001", "siteId": "111", "cellId": "1",
        "cellName": "X", "mnc": "1", "longitude": 999, "latitude": 999,
        "azimuth": 999, "frequency": "abc", "cellCoverType": 4,
    }, "LTE")
    assert not ok
    joined = "；".join(errs)
    assert "经度" in joined and "纬度" in joined and "方向角" in joined
    assert "MNC" in joined and "频点" in joined


def test_bulk_update_cell(excel_env):
    from app.core.database import SessionLocal
    from app.models.database import Sector

    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("TH-1", workbook_id=excel_env)[0]
    row_key = hit["rowKey"]

    res = data_service.bulk_update_cells(
        [{"rowKey": row_key, "networkType": "LTE", "fields": {"cellName": "TH-1-改", "azimuth": 90}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["updated"] == 1 and res["deleted"] == 0
    item = res["results"][0]
    assert item["success"] and item["type"] == "update"

    db = SessionLocal()
    try:
        s = db.query(Sector).filter(Sector.id == int(row_key.split(":")[1])).first()
        assert s.name == "TH-1-改" and s.azimuth == 90
    finally:
        db.close()
    names = {i["cellName"] for i in data_service.search_cells("TH-1-改", workbook_id=excel_env)}
    assert "TH-1-改" in names

    # Excel 双写断言：改名/方向角已写入 LTE sheet
    # 归一化比较（Excel 单元格值可能是 int/float/str，如 '2001'/111/'1'）
    from openpyxl import load_workbook
    from pathlib import Path
    from app.core.config import settings
    wb = load_workbook(Path(settings.DATA_DIR) / excel_env / "original.xlsx")
    lte_ws = wb["LTE Project Parameters"]
    rows = list(lte_ws.iter_rows(min_row=2, values_only=True))

    def _norm(v):
        try:
            f = float(str(v).strip())
            return str(int(f)) if f == int(f) else str(f)
        except (ValueError, TypeError):
            return str(v).strip()

    updated_row = [r for r in rows if _norm(r[0]) == "2001" and _norm(r[1]) == "111" and _norm(r[2]) == "1"]
    assert updated_row, "Excel 中找不到 TH-1 数据行"
    assert updated_row[0][3] == "TH-1-改" and _norm(updated_row[0][6]) == "90"
    wb.close()


def test_bulk_update_rekey_and_conflict(excel_env):
    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("TH-2", workbook_id=excel_env)[0]

    # 改键到已占用 (111_1) → 冲突拒绝
    res = data_service.bulk_update_cells(
        [{"rowKey": hit["rowKey"], "networkType": "LTE", "fields": {"cellId": "1"}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"] is False
    assert "占用" in res["results"][0]["message"] or "重复" in res["results"][0]["message"]

    # 改键到新站 999（原地改键）
    res = data_service.bulk_update_cells(
        [{"rowKey": hit["rowKey"], "networkType": "LTE",
          "fields": {"siteId": "999", "cellId": "9", "cellName": "TH-2-新"}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"]
    names = {i["cellName"] for i in data_service.search_cells("999", workbook_id=excel_env)}
    assert "TH-2-新" in names

    # Excel 双写断言：改键后新键 (999,9) 已写入 LTE sheet，旧键 (111,2) 行消失
    # 归一化比较（Excel 单元格值可能是 int/float/str，如 '999'/'9'）
    from openpyxl import load_workbook
    from pathlib import Path
    from app.core.config import settings
    wb = load_workbook(Path(settings.DATA_DIR) / excel_env / "original.xlsx")
    lte_ws = wb["LTE Project Parameters"]
    rows = list(lte_ws.iter_rows(min_row=2, values_only=True))

    def _norm(v):
        try:
            f = float(str(v).strip())
            return str(int(f)) if f == int(f) else str(f)
        except (ValueError, TypeError):
            return str(v).strip()

    new_key_rows = [r for r in rows if _norm(r[1]) == "999" and _norm(r[2]) == "9"]
    assert new_key_rows, "Excel 中找不到改键后 (999,9) 行"
    assert new_key_rows[0][3] == "TH-2-新"
    assert not any(_norm(r[1]) == "111" and _norm(r[2]) == "2" for r in rows), "旧键 (111,2) 行应已改键"
    wb.close()


def test_bulk_update_cross_type_occupied(excel_env):
    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("TH-2", network_type="LTE", workbook_id=excel_env)[0]
    res = data_service.bulk_update_cells(
        [{"rowKey": hit["rowKey"], "networkType": "LTE", "fields": {"siteId": "222", "cellId": "1"}}],
        [], user_id=1, workbook_id=excel_env,
    )
    assert res["results"][0]["success"] is False
    assert "NR" in res["results"][0]["message"]


def test_bulk_delete_cascades_site(excel_env):
    from app.core.database import SessionLocal
    from app.models.database import Site

    data_service._invalidate_cell_search_index()
    hits = data_service.search_cells("TH-", workbook_id=excel_env)  # TH-1 + TH-2
    res = data_service.bulk_update_cells(
        [],
        [{"rowKey": h["rowKey"], "networkType": "LTE"} for h in hits],
        user_id=1, workbook_id=excel_env,
    )
    assert res["deleted"] == 2
    db = SessionLocal()
    try:
        assert db.query(Site).filter(Site.workbook_id == excel_env, Site.site_id == "111").first() is None
        assert db.query(Site).filter(Site.workbook_id == excel_env, Site.site_id == "222").first() is not None
    finally:
        db.close()

    # Excel 双写断言：LTE sheet 中 (111,1)/(111,2) 行已删除
    from openpyxl import load_workbook
    from pathlib import Path
    from app.core.config import settings
    wb = load_workbook(Path(settings.DATA_DIR) / excel_env / "original.xlsx")
    lte_ws = wb["LTE Project Parameters"]
    rows = list(lte_ws.iter_rows(min_row=2, values_only=True))
    lte_rows = [r for r in rows if r[0] == "2001"]
    assert not any(r[1] == 111 for r in lte_rows), "Excel 中 (111,*) 行应已删除"
    wb.close()


def test_bulk_delete_multiple_same_key_rows(excel_env, tmp_path, monkeypatch):
    """同键多行删除回归：Excel 中三行同 (111,1)，全删且保留其他行"""
    from openpyxl import Workbook, load_workbook
    from app.core.config import settings
    from pathlib import Path

    # 在 excel_env 基础上，向 LTE sheet 追加两行 (111,1) 副本（共 3 行同键）
    ex_path = Path(settings.DATA_DIR) / excel_env / "original.xlsx"
    # 先还原: bulk 前 Excel 目前含 TH-1(111,1)、TH-2(111,2)；追加 (111,1) 副本
    wb = load_workbook(ex_path)
    lte_ws = wb["LTE Project Parameters"]
    base_row = [r for r in lte_ws.iter_rows(min_row=2, values_only=True)
                if r[1] == 111 and r[2] == 1][0]
    for _ in range(2):
        lte_ws.append(base_row)
    wb.save(ex_path)
    wb.close()

    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("TH-1", workbook_id=excel_env)[0]

    res = data_service.bulk_update_cells(
        [],
        [{"rowKey": hit["rowKey"], "networkType": "LTE"}],
        user_id=1, workbook_id=excel_env,
    )
    assert res["deleted"] == 1  # DB 侧只删 1 条（主键唯一）

    # Excel 侧：同键 (111,1) 的所有行都应删除（self 删除语义）
    wb = load_workbook(ex_path)
    lte_ws = wb["LTE Project Parameters"]
    rows = list(lte_ws.iter_rows(min_row=2, values_only=True))
    assert not any(r[1] == 111 and r[2] == 1 for r in rows), "Excel 中同键 (111,1) 行应全部删除"
    assert any(r[1] == 111 and r[2] == 2 for r in rows), "TH-2 (111,2) 行应保留"
    wb.close()


def test_search_endpoint_smoke(query_env):
    """search 端点端到端冒烟：注入 index + 鉴权用户 + token"""
    from fastapi.testclient import TestClient
    from app.core.database import SessionLocal, init_db
    from app.models.database import User
    from app.services.auth_service import auth_service
    from app.api import create_app
    from app.services.data_service import data_service

    # 注入 index（同 dup_env 模式：临时移除既有 full_params 条目）
    saved_index = dict(data_service.index)
    for k in [k for k, v in saved_index.items()
              if isinstance(v, dict) and v.get("fileType") == "full_params"]:
        data_service.index.pop(k)
    data_service.index[query_env] = {"fileType": "full_params"}

    init_db()
    username = "q_search_user"
    db = SessionLocal()
    try:
        existing = auth_service.get_user_by_username(db, username)
        if existing:
            db.delete(existing)
            db.commit()
        user, err = auth_service.create_user(db, username, "Test@12345")
        assert err is None
        user.can_cell_entry = True
        db.commit()
        db.refresh(user)
        token, _ = auth_service.create_access_token(user.id, user.username, False)
    finally:
        db.close()

    try:
        client = TestClient(create_app())
        resp = client.post(
            "/api/v1/data/full-params/cells/search",
            headers={"Authorization": f"Bearer {token}"},
            json={"query": "天河", "limit": 20},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert len(data) == 3
        assert {i["siteName"] for i in data} == {"天河一号站", "天河二号站"}
    finally:
        db = SessionLocal()
        try:
            user = auth_service.get_user_by_username(db, username)
            if user:
                db.delete(user)
                db.commit()
        finally:
            db.close()
        data_service.index.clear()
        data_service.index.update(saved_index)


def test_bulk_update_endpoint_smoke(excel_env):
    """bulk-update 端点端到端冒烟：搜索→改小区名→确认→落库"""
    from fastapi.testclient import TestClient
    from app.core.database import SessionLocal, init_db
    from app.models.database import User, Sector
    from app.services.auth_service import auth_service
    from app.api import create_app
    from app.services.data_service import data_service

    init_db()
    username = "q_update_user"
    db = SessionLocal()
    try:
        existing = auth_service.get_user_by_username(db, username)
        if existing:
            db.delete(existing)
            db.commit()
        user, err = auth_service.create_user(db, username, "Test@12345")
        assert err is None
        user.can_cell_entry = True
        db.commit()
        db.refresh(user)
        token, _ = auth_service.create_access_token(user.id, user.username, False)
    finally:
        db.close()

    data_service._invalidate_cell_search_index()
    hit = data_service.search_cells("NR-1", workbook_id=excel_env)[0]
    row_key = hit["rowKey"]

    # 端点内部通过 _find_full_params_id() 定位全量工参（不显式传 workbook_id）；
    # 与 test_search_endpoint_smoke 同模式，临时移除历史残留的 full_params 条目，
    # 确保定位到本用例注入的 excel_env（而非真实 index.json/SQLite 的历史条目）
    saved_index = dict(data_service.index)
    for k in [k for k, v in saved_index.items()
              if isinstance(v, dict) and v.get("fileType") == "full_params"]:
        data_service.index.pop(k)
    data_service.index[excel_env] = {"fileType": "full_params", "id": excel_env}

    try:
        client = TestClient(create_app())
        resp = client.post(
            "/api/v1/data/full-params/cells/bulk-update",
            headers={"Authorization": f"Bearer {token}"},
            json={"updates": [{"rowKey": row_key, "networkType": "NR",
                               "fields": {"cellName": "NR-1-改"}}], "deletes": []},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["success"] is True
        assert body["data"]["updated"] == 1
        assert body["data"]["results"][0]["success"] is True
    finally:
        db = SessionLocal()
        try:
            user = auth_service.get_user_by_username(db, username)
            if user:
                db.delete(user)
                db.commit()
        finally:
            db.close()
        data_service.index.clear()
        data_service.index.update(saved_index)
