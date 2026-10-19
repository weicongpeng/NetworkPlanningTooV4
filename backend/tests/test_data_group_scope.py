"""按（地市+运营商）组隔离数据空间 — 数据组模块测试

覆盖计划步骤 10 的可自动化部分：
- validate_group / index_entry_visible / check_access / group_sql_filter 可见性规则
- /auth/options 公开选项端点
- 注册组校验（缺项/非法地市/非法运营商 → 400）
- 任务历史按组隔离（TaskResult.city/operator 过滤）
"""
import json
import pytest
from datetime import datetime


class FakeUser:
    def __init__(self, is_admin=False, city=None, operator=None):
        self.is_admin = is_admin
        self.city = city
        self.operator = operator


@pytest.fixture()
def isolated_index(monkeypatch):
    """把 data_service.index 换成临时 dict，避免污染真实索引"""
    from app.services.data_service import data_service
    fake_index = {}
    monkeypatch.setattr(data_service, "index", fake_index)
    return fake_index


@pytest.fixture()
def city_presets(monkeypatch):
    """临时地市清单，避免依赖部署 .env"""
    from app.core.config import settings
    monkeypatch.setattr(settings, "NPT_CITY_PRESETS", "郑州,洛阳,深圳")
    return settings.CITY_PRESETS


# ---------------------------------------------------------------------------
# data_group 纯函数
# ---------------------------------------------------------------------------
def test_operators_constant():
    from app.services.data_group import OPERATORS
    assert OPERATORS == ["移动", "联通", "电信", "广电"]


def test_validate_group(city_presets):
    from app.services.data_group import validate_group
    assert validate_group("深圳", "移动") is None
    assert validate_group("郑州", "广电") is None
    assert validate_group(None, "移动") == "请选择地市"
    assert validate_group("深圳", None) == "请选择运营商"
    assert validate_group("纽约", "移动") == "地市「纽约」不在预设列表中"
    assert validate_group("深圳", "格林威尔") == "运营商「格林威尔」无效，仅支持：移动、联通、电信、广电"


def test_index_entry_visible(city_presets):
    """管理员与普通用户一律按组隔离，不设跨组特权"""
    from app.services.data_group import index_entry_visible
    admin = FakeUser(is_admin=True, city="深圳", operator="移动")
    a = FakeUser(city="深圳", operator="移动")
    b = FakeUser(city="洛阳", operator="联通")
    nogroup = FakeUser(city=None, operator=None)

    legacy = {"name": "legacy"}                     # 存量：缺组键（启动迁移后归主管理员组）
    own = {"name": "own", "city": "深圳", "operator": "移动"}
    other = {"name": "other", "city": "洛阳", "operator": "联通"}

    assert index_entry_visible(own, a) is True
    assert index_entry_visible(other, a) is False
    assert index_entry_visible(legacy, a) is False  # NULL 组条目任何组都不可见
    assert index_entry_visible(legacy, admin) is False  # 管理员同样按组
    assert index_entry_visible(other, admin) is False  # 管理员不能跨组
    assert index_entry_visible(own, admin) is True      # 管理员可见本组
    assert index_entry_visible(own, nogroup) is False  # 组缺失用户不可见任何数据
    assert index_entry_visible(own, None) is True   # 系统内部调用放行


def test_group_sql_filter(city_presets):
    from app.services.data_group import group_sql_filter
    from app.models.database import Workbook
    # 管理员同样按组过滤，仅系统调用（None）不过滤
    f_admin = group_sql_filter(Workbook.city, Workbook.operator,
                               FakeUser(is_admin=True, city="深圳", operator="移动"))
    assert f_admin is not None
    assert group_sql_filter(Workbook.city, Workbook.operator, None) is None
    f = group_sql_filter(Workbook.city, Workbook.operator, FakeUser(city="深圳", operator="移动"))
    assert f is not None
    f2 = group_sql_filter(Workbook.city, Workbook.operator, FakeUser())
    assert f2 is not None  # 组缺失 → 永假条件


def test_check_access(isolated_index, city_presets):
    from app.services.data_service import data_service
    admin = FakeUser(is_admin=True, city="深圳", operator="移动")
    a = FakeUser(city="深圳", operator="移动")
    b = FakeUser(city="洛阳", operator="联通")

    isolated_index["d1"] = {"name": "own", "city": "深圳", "operator": "移动"}
    isolated_index["d2"] = {"name": "other", "city": "洛阳", "operator": "联通"}
    isolated_index["d3"] = {"name": "legacy"}  # 存量无组

    assert data_service.check_access("d1", a) is True
    assert data_service.check_access("d2", a) is False
    assert data_service.check_access("d1", b) is False
    assert data_service.check_access("d3", a) is False
    assert data_service.check_access("d3", admin) is False  # 管理员同样不能跨组/见存量 NULL
    assert data_service.check_access("d1", admin) is True   # 管理员可见本组
    assert data_service.check_access("missing", a) is False
    assert data_service.check_access("missing", None) is True


def test_list_data_group_scoped(isolated_index, city_presets):
    from app.services.data_service import data_service
    a = FakeUser(city="深圳", operator="移动")
    b = FakeUser(city="洛阳", operator="联通")
    admin = FakeUser(is_admin=True, city="深圳", operator="移动")
    isolated_index["d1"] = {
        "id": "d1", "name": "f.xlsx", "type": "excel", "status": "ready",
        "city": "深圳", "operator": "移动", "uploadDate": "2026-01-01",
    }
    isolated_index["d2"] = {
        "id": "d2", "name": "g.xlsx", "type": "excel", "status": "ready",
        "city": "洛阳", "operator": "联通", "uploadDate": "2026-01-02",
    }
    names_a = [i.id for i in data_service.list_data(user=a)]
    names_b = [i.id for i in data_service.list_data(user=b)]
    names_admin = [i.id for i in data_service.list_data(user=admin)]
    assert names_a == ["d1"]
    assert names_b == ["d2"]
    assert names_admin == ["d1"]  # 管理员同样仅见本组


# ---------------------------------------------------------------------------
# HTTP 端点
# ---------------------------------------------------------------------------
def test_auth_options_endpoint(city_presets):
    from fastapi.testclient import TestClient
    from app.api import create_app

    client = TestClient(create_app())
    resp = client.get("/api/v1/auth/options")
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["data"]["cities"] == ["郑州", "洛阳", "深圳"]
    assert body["data"]["operators"] == ["移动", "联通", "电信", "广电"]


def test_register_group_validation(city_presets):
    """注册组校验：缺项/非法地市/非法运营商 → 400；合法组合可注册（随后清理）"""
    from fastapi.testclient import TestClient
    from app.api import create_app
    from app.core.database import SessionLocal
    from app.models.database import User
    from app.services.auth_service import auth_service

    client = TestClient(create_app())

    # 预清理历史运行残留，保证可重复执行
    _db = SessionLocal()
    try:
        _u = auth_service.get_user_by_username(_db, "grp_ok_user")
        if _u:
            auth_service.delete_user(_db, _u.id)
    finally:
        _db.close()

    def _register(username, city, operator):
        return client.post("/api/v1/auth/register", json={
            "username": username, "password": "Test@12345",
            "confirm_password": "Test@12345", "city": city, "operator": operator,
        })

    # 缺地市（schema 层 422） / 非法地市 / 非法运营商 → 400
    assert _register("grp_missing_city", "", "移动").status_code == 422
    assert _register("grp_bad_city", "纽约", "移动").status_code == 400
    assert _register("grp_bad_operator", "深圳", "格林威尔").status_code == 400

    # 合法注册成功，随后清理
    resp = _register("grp_ok_user", "深圳", "移动")
    assert resp.status_code == 200, resp.text
    db = SessionLocal()
    try:
        u = auth_service.get_user_by_username(db, "grp_ok_user")
        assert u is not None
        assert u.city == "深圳" and u.operator == "移动"
        auth_service.delete_user(db, u.id)
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 任务历史按组隔离
# ---------------------------------------------------------------------------
def test_list_task_history_group_filter(city_presets):
    from app.services.task_manager import TaskManager
    from app.core.database import SessionLocal
    from app.models.database import TaskResult

    tm = TaskManager()
    admin = FakeUser(is_admin=True, city="深圳", operator="移动")
    a = FakeUser(city="深圳", operator="移动")
    b = FakeUser(city="洛阳", operator="联通")

    db = SessionLocal()
    try:
        rows = [
            TaskResult(task_id="grp_hist_a", task_type="pci", task_name="A组任务",
                       user_name="tester_a", status="COMPLETED", result_json="{}",
                       created_at=datetime.now(), city="深圳", operator="移动"),
            TaskResult(task_id="grp_hist_b", task_type="pci", task_name="B组任务",
                       user_name="tester_b", status="COMPLETED", result_json="{}",
                       created_at=datetime.now(), city="洛阳", operator="联通"),
            TaskResult(task_id="grp_hist_legacy", task_type="pci", task_name="存量任务",
                       user_name="tester_c", status="COMPLETED", result_json="{}",
                       created_at=datetime.now(), city=None, operator=None),
        ]
        for r in rows:
            db.add(r)
        db.commit()
    finally:
        db.close()

    try:
        ids_admin = {t["taskId"] for t in tm.list_task_history(task_type="pci", page=1, page_size=100, user=admin)["tasks"]}
        ids_a = {t["taskId"] for t in tm.list_task_history(task_type="pci", page=1, page_size=100, user=a)["tasks"]}
        ids_b = {t["taskId"] for t in tm.list_task_history(task_type="pci", page=1, page_size=100, user=b)["tasks"]}
        nogroup = tm.list_task_history(task_type="pci", page=1, page_size=100, user=FakeUser())["tasks"]

        assert "grp_hist_a" in ids_a and "grp_hist_b" not in ids_a
        assert "grp_hist_legacy" not in ids_a
        assert "grp_hist_b" in ids_b and "grp_hist_a" not in ids_b
        assert ids_admin == {"grp_hist_a"}  # 管理员同样仅见本组（存量 NULL 组不可见）
        assert nogroup == []
    finally:
        db = SessionLocal()
        try:
            for tid in ("grp_hist_a", "grp_hist_b", "grp_hist_legacy"):
                row = db.query(TaskResult).filter(TaskResult.task_id == tid).first()
                if row:
                    db.delete(row)
            db.commit()
        finally:
            db.close()


# ---------------------------------------------------------------------------
# 任务创建组盖章（端点未传组时按发起人兜底解析）
# ---------------------------------------------------------------------------
def test_task_group_resolution_fallback(city_presets):
    """_task_group：显式组优先；缺失时按发起人用户名解析；无法解析保持 (None, None)"""
    from app.core.database import SessionLocal
    from app.services.auth_service import auth_service
    from app.services.task_manager import TaskManager

    db = SessionLocal()
    try:
        user, err = auth_service.create_user(db, "grp_task_user", "Test@12345",
                                             city="深圳", operator="移动")
        assert user is not None, err
        uid = user.id
    finally:
        db.close()

    try:
        assert TaskManager._task_group(None, None, "grp_task_user") == ("深圳", "移动")
        assert TaskManager._task_group("洛阳", "联通", "grp_task_user") == ("洛阳", "联通")
        assert TaskManager._task_group(None, None, "no_such_user") == (None, None)
        assert TaskManager._task_group(None, None, None) == (None, None)
    finally:
        db = SessionLocal()
        try:
            auth_service.delete_user(db, uid)
        finally:
            db.close()


# ---------------------------------------------------------------------------
# 误归组任务启动纠正（_fix_misattributed_task_groups）
# ---------------------------------------------------------------------------
def _main_admin_group():
    """与 database._fix_misattributed_task_groups 相同的定位规则（测试辅助）"""
    from app.core.database import SessionLocal
    from app.models.database import User

    db = SessionLocal()
    try:
        admin = (db.query(User)
                 .filter(User.is_admin == True,  # noqa: E712
                         User.city.isnot(None), User.city != "",
                         User.operator.isnot(None), User.operator != "")
                 .order_by(User.id.asc())
                 .first())
        return (admin.city, admin.operator) if admin else None
    finally:
        db.close()


def test_fix_misattributed_task_groups(city_presets):
    """行组==主管理员组但创建人属其他组的任务行按创建人组重盖章；
    组==行组的创建人（含主管理员本人）与不存在用户的行不动；幂等"""
    from app.core.database import SessionLocal, _fix_misattributed_task_groups
    from app.models.database import TaskResult
    from app.services.auth_service import auth_service

    main = _main_admin_group()
    admin_city, admin_operator = main if main else ("深圳", "移动")
    # 另一组：与主管理员组不同即可
    other = ("洛阳", "联通") if (admin_city, admin_operator) != ("洛阳", "联通") else ("深圳", "移动")

    db = SessionLocal()
    user_ids = []
    try:
        if main is None:
            a, _ = auth_service.create_user(db, "grp_fix_admin", "Test@12345",
                                            is_admin=True, city=admin_city, operator=admin_operator)
            user_ids.append(a.id)
        u, _ = auth_service.create_user(db, "grp_fix_user", "Test@12345",
                                        city=other[0], operator=other[1])
        same, _ = auth_service.create_user(db, "grp_fix_same", "Test@12345",
                                           city=admin_city, operator=admin_operator)
        user_ids.extend([u.id, same.id])

        rows = [
            # 误归：行组为主管理员组，创建人属其他组 → 应纠正
            TaskResult(task_id="grp_fix_mis", task_type="pci", task_name="误归任务",
                       user_name="grp_fix_user", status="COMPLETED", result_json="{}",
                       created_at=datetime.now(), city=admin_city, operator=admin_operator),
            # 行组与创建人组一致 → 不动（主管理员本人的任务即此种）
            TaskResult(task_id="grp_fix_ok", task_type="pci", task_name="正常任务",
                       user_name="grp_fix_same", status="COMPLETED", result_json="{}",
                       created_at=datetime.now(), city=admin_city, operator=admin_operator),
            # 创建人不存在 → 不动
            TaskResult(task_id="grp_fix_ghost", task_type="pci", task_name="未知用户任务",
                       user_name="grp_fix_ghost", status="COMPLETED", result_json="{}",
                       created_at=datetime.now(), city=admin_city, operator=admin_operator),
        ]
        for r in rows:
            db.add(r)
        db.commit()
    finally:
        db.close()

    try:
        assert _fix_misattributed_task_groups()["fixed"] == 1

        db = SessionLocal()
        try:
            mis = db.query(TaskResult).filter(TaskResult.task_id == "grp_fix_mis").first()
            assert (mis.city, mis.operator) == other
            ok = db.query(TaskResult).filter(TaskResult.task_id == "grp_fix_ok").first()
            assert (ok.city, ok.operator) == (admin_city, admin_operator)
            ghost = db.query(TaskResult).filter(TaskResult.task_id == "grp_fix_ghost").first()
            assert (ghost.city, ghost.operator) == (admin_city, admin_operator)
        finally:
            db.close()

        # 幂等：再次执行无变更
        assert _fix_misattributed_task_groups()["fixed"] == 0
    finally:
        db = SessionLocal()
        try:
            for tid in ("grp_fix_mis", "grp_fix_ok", "grp_fix_ghost"):
                row = db.query(TaskResult).filter(TaskResult.task_id == tid).first()
                if row:
                    db.delete(row)
            for uid in user_ids:
                auth_service.delete_user(db, uid)
            db.commit()
        finally:
            db.close()


# ---------------------------------------------------------------------------
# /api/v1/map/cells 小区选择列表按组隔离
# ---------------------------------------------------------------------------
def test_map_cells_group_isolation(city_presets):
    """不同组用户调用 /map/cells 仅见本组工参小区；未登录 401"""
    from fastapi.testclient import TestClient
    from app.api import create_app
    from app.core.database import SessionLocal
    from app.models.database import Workbook, Site, Sector
    from app.services.auth_service import auth_service
    import app.api.v1.endpoints.map as map_module

    db = SessionLocal()
    user_ids = []
    try:
        # 预清理历史运行残留，保证可重复执行
        for name in ("grp_map_a", "grp_map_b"):
            old = auth_service.get_user_by_username(db, name)
            if old:
                for wb_id in ("grp-map-wb-a", "grp-map-wb-b"):
                    db.query(Sector).filter(Sector.workbook_id == wb_id).delete()
                    db.query(Site).filter(Site.workbook_id == wb_id).delete()
                    db.query(Workbook).filter(Workbook.id == wb_id).delete()
                auth_service.delete_user(db, old.id)
        db.commit()

        ua, err_a = auth_service.create_user(db, "grp_map_a", "Test@12345", city="深圳", operator="移动")
        ub, err_b = auth_service.create_user(db, "grp_map_b", "Test@12345", city="洛阳", operator="联通")
        assert ua is not None, err_a
        assert ub is not None, err_b
        user_ids.extend([ua.id, ub.id])

        def _seed(wb_id, uid, city, operator, site_code):
            db.add(Workbook(id=wb_id, user_id=uid, city=city, operator=operator,
                            name=f"{site_code}.xlsx", file_type="full_params",
                            status="ready", created_at=datetime.now().isoformat()))
            db.flush()  # 先落 Workbook，满足 sites.workbook_id 外键
            db.add(Site(workbook_id=wb_id, user_id=uid, city=city, operator=operator,
                        site_id=f"{site_code}S1", name=f"{site_code}站1",
                        longitude=114.0, latitude=22.0, network_type="LTE"))
            db.flush()
            site_pk = db.query(Site).filter(Site.workbook_id == wb_id).first().id
            db.add(Sector(site_id_fk=site_pk, workbook_id=wb_id, user_id=uid,
                          city=city, operator=operator, sector_id="55",
                          name=f"{site_code}小区", longitude=114.0, latitude=22.0,
                          azimuth=60.0, pci=10))

        _seed("grp-map-wb-a", ua.id, "深圳", "移动", "SITE_A")
        _seed("grp-map-wb-b", ub.id, "洛阳", "联通", "SITE_B")
        db.commit()
    finally:
        db.close()

    client = TestClient(create_app())

    def _login(username):
        resp = client.post("/api/v1/auth/login",
                           json={"username": username, "password": "Test@12345"})
        assert resp.status_code == 200, resp.text
        return resp.json()["data"]["access_token"]

    # 清掉后端地图缓存，避免复用其它用例的全局缓存
    map_module._map_data_cache.clear()
    map_module._map_data_cache_time.clear()

    try:
        # 未登录 → 401（原实现无鉴权，任何匿名请求都能拿到全部组小区）
        assert client.get("/api/v1/map/cells").status_code == 401

        ra = client.get("/api/v1/map/cells",
                        headers={"Authorization": f"Bearer {_login('grp_map_a')}"})
        assert ra.status_code == 200, ra.text
        ids_a = {c["siteId"] for c in ra.json()["data"]["lte"]}
        assert "SITE_AS1" in ids_a and "SITE_BS1" not in ids_a

        rb = client.get("/api/v1/map/cells",
                        headers={"Authorization": f"Bearer {_login('grp_map_b')}"})
        assert rb.status_code == 200, rb.text
        ids_b = {c["siteId"] for c in rb.json()["data"]["lte"]}
        assert "SITE_BS1" in ids_b and "SITE_AS1" not in ids_b
    finally:
        map_module._map_data_cache.clear()
        map_module._map_data_cache_time.clear()
        db = SessionLocal()
        try:
            for wb_id in ("grp-map-wb-a", "grp-map-wb-b"):
                db.query(Sector).filter(Sector.workbook_id == wb_id).delete()
                db.query(Site).filter(Site.workbook_id == wb_id).delete()
                db.query(Workbook).filter(Workbook.id == wb_id).delete()
            for uid in user_ids:
                auth_service.delete_user(db, uid)
            db.commit()
        finally:
            db.close()


# ---------------------------------------------------------------------------
# 任务结果端点跨组访问拒绝（/pci/result/{task_id} 等按 id 访问的任务端点）
# ---------------------------------------------------------------------------
def test_task_result_cross_group_denied(city_presets):
    """同组可读自己的任务结果；跨组与未登录一律拒绝（404/401，不泄露存在性）"""
    from fastapi.testclient import TestClient
    from app.api import create_app
    from app.core.database import SessionLocal
    from app.models.database import TaskResult
    from app.services.auth_service import auth_service

    db = SessionLocal()
    user_ids = []
    try:
        for name in ("grp_task_a", "grp_task_b"):
            old = auth_service.get_user_by_username(db, name)
            if old:
                auth_service.delete_user(db, old.id)
        db.commit()
        ua, err_a = auth_service.create_user(db, "grp_task_a", "Test@12345", city="深圳", operator="移动")
        ub, err_b = auth_service.create_user(db, "grp_task_b", "Test@12345", city="洛阳", operator="联通")
        assert ua is not None, err_a
        assert ub is not None, err_b
        user_ids.extend([ua.id, ub.id])
        db.add(TaskResult(task_id="grp_task_res_a", task_type="pci", task_name="A组PCI",
                          user_name="grp_task_a", status="COMPLETED",
                          result_json=json.dumps({"results": []}, ensure_ascii=False),
                          created_at=datetime.now(), city="深圳", operator="移动"))
        db.commit()
    finally:
        db.close()

    client = TestClient(create_app())

    def _login(username):
        resp = client.post("/api/v1/auth/login",
                           json={"username": username, "password": "Test@12345"})
        assert resp.status_code == 200, resp.text
        return resp.json()["data"]["access_token"]

    try:
        # 未登录 → 401
        assert client.get("/api/v1/pci/result/grp_task_res_a").status_code == 401
        # 同组 → 200
        ra = client.get("/api/v1/pci/result/grp_task_res_a",
                        headers={"Authorization": f"Bearer {_login('grp_task_a')}"})
        assert ra.status_code == 200, ra.text
        # 跨组 → 404（不泄露任务存在性）
        rb = client.get("/api/v1/pci/result/grp_task_res_a",
                        headers={"Authorization": f"Bearer {_login('grp_task_b')}"})
        assert rb.status_code == 404
        # 未知任务 → 404
        ru = client.get("/api/v1/pci/result/no_such_task",
                        headers={"Authorization": f"Bearer {_login('grp_task_a')}"})
        assert ru.status_code == 404
        # 跨组删除 → 404 且行仍在
        rd = client.delete("/api/v1/pci/history/grp_task_res_a",
                           headers={"Authorization": f"Bearer {_login('grp_task_b')}"})
        assert rd.status_code == 404
        db = SessionLocal()
        try:
            assert db.query(TaskResult).filter(
                TaskResult.task_id == "grp_task_res_a").first() is not None
        finally:
            db.close()
    finally:
        db = SessionLocal()
        try:
            row = db.query(TaskResult).filter(TaskResult.task_id == "grp_task_res_a").first()
            if row:
                db.delete(row)
            for uid in user_ids:
                auth_service.delete_user(db, uid)
            db.commit()
        finally:
            db.close()
