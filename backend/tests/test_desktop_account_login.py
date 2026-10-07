"""桌面端账号登录（与网页端共用账号）：共享模式自动签发 / 单机模式申请批准 / 登录次数。"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import get_db
from app.core.security import get_current_admin_user
from app.models.database import Base, DesktopLicense, User

MACHINE_A = "AAAA-BBBB-CCCC-DDDD"


@pytest.fixture()
def login_env(tmp_path, monkeypatch):
    """临时 SQLite + 临时 Ed25519 密钥对 + 授权服务器侧的最小应用。"""
    from app.api.v1.endpoints import desktop_cloud, desktop_licenses
    from app.core.config import settings

    private_key = Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_hex = (
        private_key.public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        .hex()
    )

    monkeypatch.setenv("NPT_LICENSE_PRIVATE_KEY", private_pem)
    monkeypatch.setenv("NPT_LICENSE_PUBLIC_KEY_HEX", public_hex)
    monkeypatch.setattr(settings, "NPT_DESKTOP_LEASE_DAYS", 30)

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    def override_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(desktop_cloud.router, prefix="/api/v1/desktop-cloud")
    app.include_router(desktop_licenses.router, prefix="/api/v1/desktop-licenses")
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin_user] = lambda: SimpleNamespace(
        username="admin", is_admin=True
    )

    db = TestingSession()
    from app.services.auth_service import auth_service

    user = User(
        username="alice",
        password_hash=auth_service.hash_password("alice-pwd"),
        is_admin=False,
        is_active=True,
        must_change_password=False,
        city="广州",
        operator="移动",
        can_data_import=True,
    )
    groupless = User(
        username="bob",
        password_hash=auth_service.hash_password("bob-pwd"),
        is_admin=False,
        is_active=True,
        must_change_password=False,
    )
    db.add_all([user, groupless])
    db.commit()
    db.close()

    yield SimpleNamespace(
        client=TestClient(app),
        session_factory=TestingSession,
        settings=settings,
        monkeypatch=monkeypatch,
    )


def _login(client, username, password="", mode="shared", machine=MACHINE_A, **extra):
    return client.post(
        "/api/v1/desktop-cloud/auth/login",
        json={
            "username": username,
            "password": password,
            "mode": mode,
            "machine_code": machine,
            **extra,
        },
    )


def test_shared_login_uses_web_account_and_group(login_env):
    """共享模式：同一账号、同一数据组，登录即自动签发许可（同步凭证）。"""
    resp = _login(login_env.client, "alice", "alice-pwd", mode="shared")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["result"] == "ok"
    assert data["mode"] == "shared"
    assert data["user"]["username"] == "alice"
    assert data["user"]["city"] == "广州" and data["user"]["operator"] == "移动"
    assert data["user"]["can_data_import"] is True
    # 组归属跟随账号，共享模式下该桌面端即属于这一组
    assert data["city"] == "广州" and data["operator"] == "移动"
    assert data["license_file"]

    # 再次登录复用同一张许可，不会重复建单
    resp2 = _login(login_env.client, "alice", "alice-pwd", mode="shared")
    assert resp2.json()["data"]["license_id"] == data["license_id"]


def test_shared_login_rejects_bad_password(login_env):
    resp = _login(login_env.client, "alice", "wrong", mode="shared")
    assert resp.status_code == 401


def test_shared_login_requires_account_group(login_env):
    """共享模式按分组共享，账号没有组就无法参与共享。"""
    resp = _login(login_env.client, "bob", "bob-pwd", mode="shared")
    assert resp.status_code == 400
    assert "数据组" in resp.json()["detail"]


def test_standalone_login_pending_then_approved(login_env):
    """单机模式：首次登录建待批准申请，管理员在「桌面授权」页确认后拿到许可。"""
    resp = _login(login_env.client, "alice", "alice-pwd", mode="standalone")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["result"] == "pending"
    assert data["status"] == "pending"

    license_id = data["license_id"]
    approve = login_env.client.post(
        f"/api/v1/desktop-licenses/{license_id}/approve", json={"idle_logout_days": 5}
    )
    assert approve.status_code == 200, approve.text

    poll = login_env.client.post(
        "/api/v1/desktop-cloud/auth/poll",
        json={"username": "alice", "machine_code": MACHINE_A},
    )
    assert poll.status_code == 200, poll.text
    polled = poll.json()["data"]
    assert polled["result"] == "ok"
    assert polled["idle_logout_days"] == 5
    assert polled["login_count"] == 1
    assert polled["license_file"]


def test_standalone_login_counts_logins(login_env):
    """历史登录次数：每次联机登录累加。"""
    first = _login(login_env.client, "alice", "alice-pwd", mode="standalone")
    license_id = first.json()["data"]["license_id"]
    assert login_env.client.post(
        f"/api/v1/desktop-licenses/{license_id}/approve", json={}
    ).status_code == 200

    assert _login(login_env.client, "alice", "alice-pwd", mode="standalone").json()["data"][
        "login_count"
    ] == 1
    assert _login(login_env.client, "alice", "alice-pwd", mode="standalone").json()["data"][
        "login_count"
    ] == 2

    # 断网期间本机记账的登录次数，联机时补报
    third = _login(login_env.client, "alice", "alice-pwd", mode="standalone", offline_logins=3)
    assert third.json()["data"]["login_count"] == 6


def test_login_issues_session_and_kicks_previous_login(login_env):
    """同一账号以最后登录为准：新登录会注销该账号其它 pc/desktop 会话。"""
    first = _login(login_env.client, "alice", "alice-pwd", mode="shared")
    assert first.status_code == 200, first.text
    jti_first = first.json()["data"].get("session_jti")
    assert jti_first

    # 本机（或其它端）拿这个会话标识校验 → 有效
    license_file = first.json()["data"]["license_file"]
    check = login_env.client.post(
        "/api/v1/desktop-cloud/auth/session-check",
        json={"license_file": license_file, "machine_code": MACHINE_A, "session_jti": jti_first},
    )
    assert check.status_code == 200, check.text
    assert check.json()["data"]["valid"] is True

    # 同一账号再次登录（另一台桌面端/网页端）→ 上一次登录被踢下线
    second = _login(login_env.client, "alice", "alice-pwd", mode="shared")
    assert second.json()["data"]["session_jti"] != jti_first

    kicked = login_env.client.post(
        "/api/v1/desktop-cloud/auth/session-check",
        json={"license_file": license_file, "machine_code": MACHINE_A, "session_jti": jti_first},
    )
    assert kicked.json()["data"]["valid"] is False


def test_session_check_rejects_unknown_or_invalid_license(login_env):
    resp = login_env.client.post(
        "/api/v1/desktop-cloud/auth/session-check",
        json={"license_file": "bad", "machine_code": MACHINE_A, "session_jti": "x"},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["valid"] is False

    ok = _login(login_env.client, "alice", "alice-pwd", mode="shared")
    resp2 = login_env.client.post(
        "/api/v1/desktop-cloud/auth/session-check",
        json={
            "license_file": ok.json()["data"]["license_file"],
            "machine_code": MACHINE_A,
            "session_jti": "",
        },
    )
    assert resp2.json()["data"]["valid"] is False


def test_standalone_default_idle_logout_days(login_env):
    """无操作退出登录时长默认 2 天，随许可下发到本机。"""
    first = _login(login_env.client, "alice", "alice-pwd", mode="standalone")
    license_id = first.json()["data"]["license_id"]
    login_env.client.post(f"/api/v1/desktop-licenses/{license_id}/approve", json={})

    ok = _login(login_env.client, "alice", "alice-pwd", mode="standalone")
    assert ok.json()["data"]["idle_logout_days"] == 2

    from app.services import desktop_signing

    payload = desktop_signing.verify_license(ok.json()["data"]["license_file"])
    assert payload["idle_logout_days"] == 2
    assert payload["mode"] == "standalone"
    assert payload["username"] == "alice"


def test_license_list_filters_shared_records(login_env):
    """共享模式登录自动签发的许可不占「桌面授权」页（默认只看单机授权）。"""
    assert _login(login_env.client, "alice", "alice-pwd", mode="shared").status_code == 200
    _login(login_env.client, "alice", "alice-pwd", mode="standalone")

    standalone = login_env.client.get("/api/v1/desktop-licenses?mode=standalone")
    assert standalone.json()["data"]["total"] == 1
    shared = login_env.client.get("/api/v1/desktop-licenses?mode=shared")
    assert shared.json()["data"]["total"] == 1
    # 单机授权记录带上登录次数与退出时长，管理页据此展示
    item = standalone.json()["data"]["items"][0]
    assert item["idle_logout_days"] == 2
    assert "login_count" in item


def test_standalone_rejected_login_blocked(login_env):
    first = _login(login_env.client, "alice", "alice-pwd", mode="standalone")
    license_id = first.json()["data"]["license_id"]
    assert login_env.client.post(
        f"/api/v1/desktop-licenses/{license_id}/reject", json={"note": "不同意"}
    ).status_code == 200

    resp = _login(login_env.client, "alice", "alice-pwd", mode="standalone")
    assert resp.status_code == 403
    assert "拒绝" in resp.json()["detail"]


def test_precreated_license_claimable_by_bound_account(login_env):
    """管理员预建并绑定账号的单机授权，该用户登录时直接认领。"""
    created = login_env.client.post(
        "/api/v1/desktop-licenses",
        json={"licensee_username": "alice", "username": "alice", "idle_logout_days": 3},
    )
    assert created.status_code == 200, created.text
    assert created.json()["data"]["username"] == "alice"

    resp = _login(login_env.client, "alice", "alice-pwd", mode="standalone")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["result"] == "ok"
    assert data["idle_logout_days"] == 3
    assert data["license_id"] == created.json()["data"]["id"]


def test_desktop_login_is_public_and_updates_mode(login_env):
    """授权记录的模式随登录写入，供管理页与本机权限策略区分。"""
    _login(login_env.client, "alice", "alice-pwd", mode="shared")
    db = login_env.session_factory()
    try:
        record = db.query(DesktopLicense).filter(DesktopLicense.mode == "shared").first()
        assert record is not None
        assert record.username == "alice"
        assert record.user_id is not None
        assert record.status == "active"
    finally:
        db.close()
