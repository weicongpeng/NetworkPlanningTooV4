"""管理员修改用户组（地市+运营商）后历史数据级联迁移测试"""
import pytest
from sqlalchemy import text

from app.core.database import SessionLocal
from app.services.data_group import migrate_group_data
from app.services.data_service import data_service

OLD = ("ZZ迁移旧市", "移动")
NEW = ("ZZ迁移新市", "移动")
OTHER = ("ZZ迁移他市", "联通")


@pytest.fixture()
def seeded():
    """造两个同组用户及各自的历史数据，测试后清理。"""
    db = SessionLocal()
    try:
        def _mk_user(username, city, operator):
            db.execute(
                text(
                    "INSERT INTO users (username, password_hash, is_admin, is_active, "
                    "must_change_password, total_usage_seconds, user_type, city, operator, created_at) "
                    "VALUES (:u, 'x', 0, 1, 0, 0, 'pc', :c, :o, '2026-09-18T00:00:00')"
                ),
                {"u": username, "c": city, "o": operator},
            )
            db.commit()
            rid = db.execute(text("SELECT id FROM users WHERE username=:u"), {"u": username}).scalar_one()
            return rid

        u1 = _mk_user("zz_mig_u1", OLD[0], OLD[1])
        u2 = _mk_user("zz_mig_u2", OLD[0], OLD[1])
        u3 = _mk_user("zz_mig_u3", OTHER[0], OTHER[1])

        yield {"db": db, "u1": u1, "u2": u2, "u3": u3}
    finally:
        # 按外键依赖顺序清理（子表先于 workbooks），再删用户
        for table in ("sectors", "sites", "station_param_rows", "station_metric_rows",
                      "workbooks", "geo_files", "layers"):
            db.execute(text(f"DELETE FROM {table} WHERE city LIKE 'ZZ迁移%'"))
        db.execute(text("DELETE FROM task_results WHERE city LIKE 'ZZ迁移%'"))
        db.execute(text("DELETE FROM users WHERE username LIKE 'zz_mig_%'"))
        db.commit()
        db.close()


def _seed_rows(db, uid, city, operator, task_username, task_id):
    """在每张表插一行；返回各表受影响行数校验所需。"""
    # workbook + site + sector（workbook_id 用纯字符串，绕开真实文件）
    wb = f"zz-wb-{uid}-{city}"
    db.execute(text(
        "INSERT INTO workbooks (id, user_id, city, operator, name, file_type, status, created_at) "
        "VALUES (:id, :uid, :c, :o, 'n', 'full_params', 'ready', '2026-09-18')"),
        {"id": wb, "uid": uid, "c": city, "o": operator})
    db.execute(text(
        "INSERT INTO sites (workbook_id, user_id, city, operator, site_id, network_type) "
        "VALUES (:wb, :uid, :c, :o, 's1', 'LTE')"),
        {"wb": wb, "uid": uid, "c": city, "o": operator})
    db.execute(text(
        "INSERT INTO sectors (workbook_id, user_id, city, operator, sector_id) "
        "VALUES (:wb, :uid, :c, :o, 'sec1')"),
        {"wb": wb, "uid": uid, "c": city, "o": operator})
    db.execute(text(
        "INSERT INTO geo_files (id, user_id, city, operator, filename, file_path, geometry_type, created_at) "
        "VALUES (:id, :uid, :c, :o, 'f', '/tmp/x', 'point', '2026-09-18')"),
        {"id": f"zz-gf-{uid}-{city}", "uid": uid, "c": city, "o": operator})
    db.execute(text(
        "INSERT INTO layers (id, user_id, city, operator, name, file_path, layer_type, geometry_type, created_at) "
        "VALUES (:id, :uid, :c, :o, 'l', '/tmp/y', 'tab', 'point', '2026-09-18')"),
        {"id": f"zz-ly-{uid}-{city}", "uid": uid, "c": city, "o": operator})
    db.execute(text(
        "INSERT INTO station_param_rows (workbook_id, user_id, city, operator, cell_name, params_json, created_at) "
        "VALUES (:wb, :uid, :c, :o, 'cell1', '{}', '2026-09-18')"),
        {"wb": wb, "uid": uid, "c": city, "o": operator})
    db.execute(text(
        "INSERT INTO station_metric_rows (workbook_id, user_id, city, operator, cell_name, "
        "metric_time, metric_name, created_at) VALUES (:wb, :uid, :c, :o, 'cell1', "
        "'2026-09-18 00:00:00', 'm', '2026-09-18')"),
        {"wb": wb, "uid": uid, "c": city, "o": operator})
    db.execute(text(
        "INSERT INTO task_results (task_id, task_type, user_name, city, operator, status, created_at) "
        "VALUES (:tid, 'pci', :un, :c, :o, 'completed', '2026-09-18')"),
        {"tid": task_id, "un": task_username, "c": city, "o": operator})
    db.commit()


def _count(db, table, city, operator, where_extra="", params=None):
    sql = f"SELECT COUNT(*) FROM {table} WHERE city=:c AND operator=:o{where_extra}"
    p = {"c": city, "o": operator}
    if params:
        p.update(params)
    return db.execute(text(sql), p).scalar_one()


def test_migrate_user_scope_only_own_data(seeded, monkeypatch):
    db = seeded["db"]
    u1, u2 = seeded["u1"], seeded["u2"]
    _seed_rows(db, u1, OLD[0], OLD[1], "zz_mig_u1", "zz-task-u1")
    _seed_rows(db, u2, OLD[0], OLD[1], "zz_mig_u2", "zz-task-u2")

    # index.json 条目：u1/u2 各一条
    fake_index = {
        "i1": {"user_id": u1, "city": OLD[0], "operator": OLD[1]},
        "i2": {"user_id": u2, "city": OLD[0], "operator": OLD[1]},
    }
    monkeypatch.setattr(data_service, "index", fake_index)
    saved = []
    monkeypatch.setattr(data_service, "_save_index", lambda: saved.append(1))
    monkeypatch.setattr(data_service, "_invalidate_cell_search_index", lambda: None)

    result = migrate_group_data(
        db, user_id=u1, username="zz_mig_u1",
        old_city=OLD[0], old_operator=OLD[1],
        new_city=NEW[0], new_operator=NEW[1],
        scope="user",
    )

    # 8 张表各迁 1 行
    assert result["total"] == 8
    for table in ("workbooks", "sites", "sectors", "geo_files", "layers",
                  "station_param_rows", "station_metric_rows", "task_results"):
        assert _count(db, table, NEW[0], NEW[1]) == 1, table
        assert _count(db, table, OLD[0], OLD[1]) == 1, f"{table} 同组他人数据不应迁移"

    # 索引：只迁 u1 的
    assert fake_index["i1"]["city"] == NEW[0]
    assert fake_index["i2"]["city"] == OLD[0]
    assert result["index_entries"] == 1
    assert saved  # 索引已保存


def test_migrate_group_scope_moves_everyone(seeded, monkeypatch):
    db = seeded["db"]
    u1, u2, u3 = seeded["u1"], seeded["u2"], seeded["u3"]
    _seed_rows(db, u1, OLD[0], OLD[1], "zz_mig_u1", "zz-task-u1")
    _seed_rows(db, u2, OLD[0], OLD[1], "zz_mig_u2", "zz-task-u2")
    _seed_rows(db, u3, OTHER[0], OTHER[1], "zz_mig_u3", "zz-task-u3")

    monkeypatch.setattr(data_service, "index", {})
    monkeypatch.setattr(data_service, "_save_index", lambda: None)
    monkeypatch.setattr(data_service, "_invalidate_cell_search_index", lambda: None)

    result = migrate_group_data(
        db, user_id=u1, username="zz_mig_u1",
        old_city=OLD[0], old_operator=OLD[1],
        new_city=NEW[0], new_operator=NEW[1],
        scope="group",
    )

    assert result["total"] == 16  # 旧组两人 × 8 表
    assert _count(db, "workbooks", OLD[0], OLD[1]) == 0
    assert _count(db, "workbooks", NEW[0], NEW[1]) == 2
    # 其他组不动
    assert _count(db, "workbooks", OTHER[0], OTHER[1]) == 1


def test_migrate_overwrites_target_singleton_workbook(seeded, monkeypatch):
    """迁入组已有同类型单例工参时：迁入的覆盖原有的（删除旧工参及其子表行）"""
    db = seeded["db"]
    u1 = seeded["u1"]
    _seed_rows(db, u1, OLD[0], OLD[1], "zz_mig_u1", "zz-task-u1")

    # 新组已存在一份其他用户的 full_params + 站点/扇区
    db.execute(text(
        "INSERT INTO users (username, password_hash, is_admin, is_active, "
        "must_change_password, total_usage_seconds, user_type, city, operator, created_at) "
        "VALUES ('zz_mig_new', 'x', 0, 1, 0, 0, 'pc', :c, :o, '2026-09-18')"),
        {"c": NEW[0], "o": NEW[1]})
    db.execute(text(
        "INSERT INTO workbooks (id, user_id, city, operator, name, file_type, status, created_at) "
        "VALUES ('zz-wb-stale', (SELECT id FROM users WHERE username='zz_mig_new'), "
        ":c, :o, 'stale', 'full_params', 'ready', '2026-09-18')"),
        {"c": NEW[0], "o": NEW[1]})
    db.execute(text(
        "INSERT INTO sites (workbook_id, user_id, city, operator, site_id, network_type) "
        "VALUES ('zz-wb-stale', (SELECT id FROM users WHERE username='zz_mig_new'), "
        ":c, :o, 'stale-site', 'LTE')"),
        {"c": NEW[0], "o": NEW[1]})
    db.commit()

    # 让 delete_data 的文件操作走空转（data 目录不存在即跳过），索引用临时 dict
    monkeypatch.setattr(data_service, "index", {})
    monkeypatch.setattr(data_service, "_save_index", lambda: None)
    monkeypatch.setattr(data_service, "_invalidate_cell_search_index", lambda: None)

    result = migrate_group_data(
        db, user_id=u1, username="zz_mig_u1",
        old_city=OLD[0], old_operator=OLD[1],
        new_city=NEW[0], new_operator=NEW[1],
        scope="user",
    )

    # 新组只有迁入的那份 full_params，旧工参 workbook/sites/sectors 已删除
    wbs = db.execute(text(
        "SELECT id FROM workbooks WHERE city=:c AND operator=:o AND file_type='full_params'"),
        {"c": NEW[0], "o": NEW[1]}).fetchall()
    assert [r[0] for r in wbs] == [f"zz-wb-{u1}-{OLD[0]}"]
    assert db.execute(text(
        "SELECT COUNT(*) FROM sites WHERE workbook_id='zz-wb-stale'")).scalar_one() == 0
    assert "zz-wb-stale" in result["overwritten_workbooks"]


def test_migrate_keeps_target_singleton_when_none_moved(seeded, monkeypatch):
    """迁入范围不含某单例类型时，新组已有该类型工参保留（不追加也不误删）"""
    db = seeded["db"]
    u1 = seeded["u1"]
    # 仅造一条 geo_files（非单例）
    db.execute(text(
        "INSERT INTO geo_files (id, user_id, city, operator, filename, file_path, "
        "geometry_type, created_at) VALUES ('zz-gf-only', :uid, :c, :o, 'f', '/x', 'point', '2026-09-18')"),
        {"uid": u1, "c": OLD[0], "o": OLD[1]})
    db.commit()
    # 新组已有 full_params
    db.execute(text(
        "INSERT INTO workbooks (id, user_id, city, operator, name, file_type, status, created_at) "
        "VALUES ('zz-wb-keep', :uid, :c, :o, 'keep', 'full_params', 'ready', '2026-09-18')"),
        {"uid": seeded["u3"], "c": NEW[0], "o": NEW[1]})
    db.commit()

    monkeypatch.setattr(data_service, "index", {})
    monkeypatch.setattr(data_service, "_save_index", lambda: None)
    monkeypatch.setattr(data_service, "_invalidate_cell_search_index", lambda: None)

    result = migrate_group_data(
        db, user_id=u1, username="zz_mig_u1",
        old_city=OLD[0], old_operator=OLD[1],
        new_city=NEW[0], new_operator=NEW[1],
        scope="user",
    )
    assert result["overwritten_workbooks"] == []
    assert db.execute(text(
        "SELECT COUNT(*) FROM workbooks WHERE id='zz-wb-keep'")).scalar_one() == 1


def test_invalid_scope_rejected(seeded):
    db = seeded["db"]
    with pytest.raises(ValueError):
        migrate_group_data(
            db, user_id=seeded["u1"], username="zz_mig_u1",
            old_city=OLD[0], old_operator=OLD[1],
            new_city=NEW[0], new_operator=NEW[1],
            scope="bogus",
        )
