"""小区选择列表（/api/v1/map/cells）经纬度口径回归

背景：一个站点行（Site）下可能挂多个逻辑站点的小区（共 BBU/站址），站点级坐标取自该行
第一条小区。历史上 /map/cells 在小区自身坐标为 0/缺失时回退到站点级坐标，导致"实际无
经纬度"的小区在 PCI/TAC/邻区等页面的小区选择列表里显示出同站点行里别的小区的坐标，
与数据管理「查询/修改」（直接取小区自身坐标）不一致，也会让缺坐标的小区绕过执行前校验。

用例：站点有坐标，小区 A 有自己的坐标，小区 B 坐标为 0，小区 C 坐标为 NULL
     → A 取自身坐标，B/C 必须为 None（与查询/修改一致）
"""
import pytest
from datetime import datetime


# 用独立组（韶关|移动）避免与其它用例共用（深圳|移动）工参和地图缓存
TEST_CITY = "韶关"
TEST_OPERATOR = "移动"
TEST_WB_ID = "test-map-cells-wb-coords"
TEST_USERNAME = "map_cells_coords_user"


@pytest.fixture()
def seeded_cells():
    from app.core.database import SessionLocal
    from app.models.database import Workbook, Site, Sector
    from app.services.auth_service import auth_service

    db = SessionLocal()
    try:
        old = auth_service.get_user_by_username(db, TEST_USERNAME)
        if old:
            db.query(Sector).filter(Sector.workbook_id == TEST_WB_ID).delete()
            db.query(Site).filter(Site.workbook_id == TEST_WB_ID).delete()
            db.query(Workbook).filter(Workbook.id == TEST_WB_ID).delete()
            auth_service.delete_user(db, old.id)
            db.commit()

        user, err = auth_service.create_user(
            db, TEST_USERNAME, "Test@12345", city=TEST_CITY, operator=TEST_OPERATOR
        )
        assert user is not None, err

        db.add(Workbook(id=TEST_WB_ID, user_id=user.id, city=TEST_CITY, operator=TEST_OPERATOR,
                        name="coords.xlsx", file_type="full_params", status="ready",
                        created_at=datetime.now().isoformat()))
        db.flush()
        site = Site(workbook_id=TEST_WB_ID, user_id=user.id, city=TEST_CITY, operator=TEST_OPERATOR,
                    site_id="9001", name="共站址站点", longitude=114.0, latitude=22.0,
                    network_type="LTE")
        db.add(site)
        db.flush()
        for cell_id, name, lon, lat in (
            ("1", "有自身坐标的小区", 114.5, 22.5),
            ("2", "坐标为0的小区", 0.0, 0.0),
            ("3", "坐标为NULL的小区", None, None),
        ):
            db.add(Sector(site_id_fk=site.id, workbook_id=TEST_WB_ID, user_id=user.id,
                          city=TEST_CITY, operator=TEST_OPERATOR, sector_id=cell_id,
                          name=name, longitude=lon, latitude=lat, azimuth=60.0, pci=10))
        db.commit()
        yield user.id
    finally:
        db.close()
        db = SessionLocal()
        try:
            db.query(Sector).filter(Sector.workbook_id == TEST_WB_ID).delete()
            db.query(Site).filter(Site.workbook_id == TEST_WB_ID).delete()
            db.query(Workbook).filter(Workbook.id == TEST_WB_ID).delete()
            old = auth_service.get_user_by_username(db, TEST_USERNAME)
            if old:
                auth_service.delete_user(db, old.id)
            db.commit()
        finally:
            db.close()


def test_map_cells_uses_cell_own_coords(seeded_cells):
    """小区选择列表经纬度只取小区自身值，不回退站点坐标"""
    from fastapi.testclient import TestClient
    from app.api import create_app
    import app.api.v1.endpoints.map as map_module

    client = TestClient(create_app())
    map_module._map_data_cache.clear()
    map_module._map_data_cache_time.clear()
    try:
        resp = client.post("/api/v1/auth/login",
                           json={"username": TEST_USERNAME, "password": "Test@12345"})
        assert resp.status_code == 200, resp.text
        token = resp.json()["data"]["access_token"]

        resp = client.get("/api/v1/map/cells",
                          headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200, resp.text
        by_id = {c["id"]: c for c in resp.json()["data"]["lte"] if c["siteId"] == "9001"}
        assert set(by_id) == {"9001_1", "9001_2", "9001_3"}

        # 有自身坐标：原样返回
        assert (by_id["9001_1"]["longitude"], by_id["9001_1"]["latitude"]) == (114.5, 22.5)
        # 坐标 0 / NULL：不得回退成站点坐标 (114.0, 22.0)，应为 None
        assert (by_id["9001_2"]["longitude"], by_id["9001_2"]["latitude"]) == (None, None)
        assert (by_id["9001_3"]["longitude"], by_id["9001_3"]["latitude"]) == (None, None)
    finally:
        map_module._map_data_cache.clear()
        map_module._map_data_cache_time.clear()
