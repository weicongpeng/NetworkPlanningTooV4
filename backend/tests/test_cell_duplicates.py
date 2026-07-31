"""制式分离查重与新站录入重复消息测试"""
import pytest

from app.services.data_service import data_service


def test_duplicate_message_same_type():
    """同制式重复 → '已重复，信息已更新覆盖'"""
    assert data_service._duplicate_message("NR", "NR", "X") == "[NR]小区 X 已重复，信息已更新覆盖"
    assert data_service._duplicate_message("LTE", "LTE", "Y") == "[LTE]小区 Y 已重复，信息已更新覆盖"
    assert data_service._duplicate_message("LTE", None, "Z") == "[LTE]小区 Z 已重复，信息已更新覆盖"


def test_duplicate_message_cross_type():
    """跨制式重复 → '已在[其他制式]工参中存在，请检查'"""
    assert data_service._duplicate_message("LTE", "NR", "X") == "[LTE]小区 X 已在[NR]工参中存在，请检查"
    assert data_service._duplicate_message("NR", "LTE", "Y") == "[NR]小区 Y 已在[LTE]工参中存在，请检查"


@pytest.fixture()
def dup_env():
    """构造含 LTE/NR 小区的全量工参环境（纯 DB fixture，供后续任务复用）"""
    import uuid
    from app.core.database import SessionLocal
    from app.models.database import Workbook, Site, Sector

    db = SessionLocal()
    wb_id = f"test-{uuid.uuid4()}"
    db.add(Workbook(
        id=wb_id, user_id=1, name="dup-test", file_type="full_params",
        status="completed", created_at="2026-07-31",
    ))
    # 先 commit Workbook，再 flush Site：
    # models 未声明 relationship()，SQLAlchemy 无法按 FK 依赖排序 insert，
    # 若在同一个 flush 中同时插入 Workbook 与 Site，Site 会先被写入而违反外键。
    db.commit()
    site_lte = Site(
        workbook_id=wb_id, user_id=1, site_id="111", name="LTE站",
        network_type="LTE", longitude=1.0, latitude=1.0,
    )
    db.add(site_lte)
    db.flush()
    db.add(Sector(
        site_id_fk=site_lte.id, workbook_id=wb_id, user_id=1,
        sector_id="111_1", name="LTE小区", longitude=1.0, latitude=1.0, azimuth=0,
    ))
    site_nr = Site(
        workbook_id=wb_id, user_id=1, site_id="222", name="NR站",
        network_type="NR", longitude=2.0, latitude=2.0,
    )
    db.add(site_nr)
    db.flush()
    db.add(Sector(
        site_id_fk=site_nr.id, workbook_id=wb_id, user_id=1,
        sector_id="222_1", name="NR小区", longitude=2.0, latitude=2.0, azimuth=0,
    ))
    db.commit()

    # 注入 index，让 data_service 能定位 full_params 文件。
    # 实现按插入顺序取第一个 full_params，若 index 中已存在真实 full_params 条目
    # 会先于本 fixture 的 wb_id 被选中，导致查重针对错误的 workbook。
    # 因此临时移除既有 full_params 条目，仅保留本 fixture 注入项，teardown 时恢复。
    saved_index = dict(data_service.index)
    saved_full_params = [
        (k, v) for k, v in saved_index.items()
        if isinstance(v, dict) and v.get("fileType") == "full_params"
    ]
    for k, _ in saved_full_params:
        data_service.index.pop(k)
    data_service.index[wb_id] = {"fileType": "full_params"}
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
        # 无论 DB 清理是否成功，都必须恢复共享单例 index，
        # 否则 fixture 的 wb_id 会永久残留在 index 中污染后续测试。
        data_service.index.clear()
        data_service.index.update(saved_index)


def test_check_duplicates_returns_network_type_flags(dup_env):
    """同一 CGI 返回 {lte, nr} 双制式标记"""
    result = data_service.check_cell_duplicates([
        {"siteId": "111", "cellId": "1", "networkType": "NR"},   # 库中为 LTE → lte=True
        {"siteId": "222", "cellId": "1", "networkType": "NR"},   # 库中为 NR → nr=True
        {"siteId": "999", "cellId": "9", "networkType": "NR"},   # 不存在
        {"siteId": "", "cellId": "", "networkType": "NR"},       # 空 siteId/cellId → 跳过，不产生 key
    ])
    assert result["exists"]["111_1"] == {"lte": True, "nr": False}
    assert result["exists"]["222_1"] == {"lte": False, "nr": True}
    assert result["exists"]["999_9"] == {"lte": False, "nr": False}
    assert "111_1" in result["duplicates"]
    assert "222_1" in result["duplicates"]
    assert "999_9" not in result["duplicates"]
    assert "" not in result["exists"]


def test_check_duplicates_endpoint_smoke(dup_env):
    """check-duplicates 端点用新 schema 返回双制式结构（端到端冒烟）"""
    from fastapi.testclient import TestClient
    from app.api import create_app
    from app.core.database import SessionLocal, init_db
    from app.models.database import User
    from app.services.auth_service import auth_service

    # 确保 users 表存在（不依赖 app lifespan）
    init_db()

    username = "dup_smoke_user"
    db = SessionLocal()
    try:
        # 构造具备 can_cell_entry 权限的测试用户 + 合法 token。
        # 该 token 未创建 UserSession 记录 → is_token_revoked 与 verify_session_ip 均放行。
        existing = auth_service.get_user_by_username(db, username)
        if existing:
            db.delete(existing)
            db.commit()
        user, err = auth_service.create_user(db, username, "Test@12345")
        assert err is None, f"创建测试用户失败: {err}"
        user.can_cell_entry = True
        db.commit()
        db.refresh(user)
        token, _ = auth_service.create_access_token(user.id, user.username, False)
    finally:
        db.close()

    # 不使用 with 语句创建 TestClient：跳过 lifespan，避免 cleanup_index()
    # 清掉 dup_env fixture 注入的全量工参 index 条目，导致查重找不到目标文件。
    try:
        client = TestClient(create_app())
        resp = client.post(
            "/api/v1/data/full-params/cells/check-duplicates",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "cells": [
                    {"siteId": "111", "cellId": "1", "networkType": "NR"},   # 库中 LTE → lte=True
                    {"siteId": "222", "cellId": "1", "networkType": "NR"},   # 库中 NR → nr=True
                    {"siteId": "999", "cellId": "9", "networkType": "NR"},   # 不存在
                ]
            },
        )
        assert resp.status_code == 200, f"HTTP {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["success"] is True
        data = body["data"]
        assert data["exists"]["111_1"] == {"lte": True, "nr": False}
        assert data["exists"]["222_1"] == {"lte": False, "nr": True}
        assert data["exists"]["999_9"] == {"lte": False, "nr": False}
        assert "111_1" in data["duplicates"]
        assert "222_1" in data["duplicates"]
        assert "999_9" not in data["duplicates"]
    finally:
        # 无论断言是否通过，都清理测试用户，避免泄漏用户行
        db = SessionLocal()
        try:
            user = auth_service.get_user_by_username(db, username)
            if user:
                db.delete(user)
                db.commit()
        finally:
            db.close()
