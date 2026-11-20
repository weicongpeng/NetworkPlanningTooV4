"""桌面授权以「用户管理」为真源：数据组 + 许可证到期自动同步。

用户口径（2026-10-10）：「桌面授权」页的「到期 / 租约」「数据组」不再自己维护，
而是跟随「用户管理」的「许可证到期」与「地市 + 运营商」；编辑授权弹窗只保留
「无操作退出登录时长（天）」，删除按钮下线。
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from .test_desktop_license_cloud import MACHINE_A, cloud_env  # noqa: F401


def _make_user(cloud_env, username="sync-user", *, city=None, operator=None, days=None):
    from app.models.database import User

    db = cloud_env.session_factory()
    try:
        user = User(
            username=username,
            password_hash="x",
            is_admin=False,
            city=city,
            operator=operator,
            license_expiry=(datetime.now() + timedelta(days=days)) if days is not None else None,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user.id
    finally:
        db.close()


def _create_bound_license(cloud_env, username, bind=True, **overrides):
    payload = {"licensee_username": username}
    if bind:
        payload["username"] = username
    payload.update(overrides)
    resp = cloud_env.client.post("/api/v1/desktop-licenses", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def test_admin_list_follows_user_group_and_expiry(cloud_env):
    """列表：数据组与到期取自绑定账号（用户管理），并把组回写到授权记录。"""
    user_id = _make_user(cloud_env, "sync-user", city="河源", operator="联通", days=10)
    expected_expire = (datetime.now() + timedelta(days=10)).date().isoformat()
    record = _create_bound_license(cloud_env, "sync-user", lease_days=30)

    resp = cloud_env.client.get("/api/v1/desktop-licenses")
    assert resp.status_code == 200, resp.text
    item = next(i for i in resp.json()["data"]["items"] if i["id"] == record["id"])

    assert (item["city"], item["operator"]) == ("河源", "联通")
    assert item["expire_date"] == expected_expire
    assert item["user_license_expiry"] == expected_expire

    # 授权记录已回写数据组（客户端同步用哪一组以记录为准，必须与展示一致）
    from app.models.database import DesktopLicense

    db = cloud_env.session_factory()
    try:
        row = db.query(DesktopLicense).filter(DesktopLicense.id == record["id"]).first()
        assert (row.city, row.operator) == ("河源", "联通")
        assert row.user_id == user_id
    finally:
        db.close()


def test_license_expire_follows_user_expiry_on_activate(cloud_env):
    """签发许可的到期日 = 用户管理的「许可证到期」，而不是「今天 + 租约天数」。"""
    _make_user(cloud_env, "sync-user", city="惠州", operator="电信", days=45)
    record = _create_bound_license(cloud_env, "sync-user", lease_days=30)

    activated = cloud_env.client.post(
        "/api/v1/desktop-cloud/license/activate",
        json={"activation_code": record["activation_code"], "machine_code": MACHINE_A},
    )
    assert activated.status_code == 200, activated.text
    data = activated.json()["data"]
    expected = (datetime.now() + timedelta(days=45)).date().isoformat()
    assert data["expire_date"] == expected

    from app.services import desktop_signing

    payload = desktop_signing.verify_license(data["license_file"])
    assert payload["expire_date"] == expected
    # 数据组随账号（用户管理）
    assert payload["city"] == "惠州" and payload["operator"] == "电信"


def test_unbound_license_keeps_lease_expiry(cloud_env):
    """未绑定账号（预建激活码）时沿用租约推算，不受用户管理影响。"""
    record = _create_bound_license(cloud_env, "no-user-license", bind=False, lease_days=30)
    resp = cloud_env.client.get("/api/v1/desktop-licenses")
    item = next(i for i in resp.json()["data"]["items"] if i["id"] == record["id"])
    assert item["user_license_expiry"] is None
    assert item["expire_date"] is None or item["expire_date"] >= (
        datetime.now() - timedelta(days=1)
    ).date().isoformat()


def test_edit_keeps_only_idle_logout(cloud_env):
    """编辑授权：只接受无操作退出登录时长；组/到期不在这里维护。"""
    _make_user(cloud_env, "sync-user", city="河源", operator="联通", days=20)
    record = _create_bound_license(cloud_env, "sync-user", lease_days=30)

    resp = cloud_env.client.put(
        f"/api/v1/desktop-licenses/{record['id']}", json={"idle_logout_days": 5}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["idle_logout_days"] == 5

    # 列表里数据组仍跟随用户管理（没有被本次编辑改掉）
    items = cloud_env.client.get("/api/v1/desktop-licenses").json()["data"]["items"]
    item = next(i for i in items if i["id"] == record["id"])
    assert (item["city"], item["operator"]) == ("河源", "联通")
