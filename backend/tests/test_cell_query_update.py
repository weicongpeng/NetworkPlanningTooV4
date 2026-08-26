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
