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


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    """清掉内存限流桶：同文件用例共用 TestClient 的同一个客户端 IP，
    不限流会让后段用例撞上 login 的 20 次/5 分钟上限而收到 429。
    """
    from app.api.v1.endpoints import desktop_cloud

    desktop_cloud._rl_buckets.clear()
    yield
    desktop_cloud._rl_buckets.clear()


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


def _set_alice_expiry(login_env, *, days):
    from datetime import datetime, timedelta

    db = login_env.session_factory()
    try:
        row = db.query(User).filter(User.username == "alice").first()
        row.license_expiry = datetime.now() + timedelta(days=days) if days is not None else None
        db.commit()
    finally:
        db.close()


def test_login_payload_carries_effective_expiry(login_env):
    """登录响应要带「用户管理」里的实际到期日：桌面端据此镜像到本机账号，
    否则本机 effective_license_expiry 恒为空，前端门禁永远认为已授权。"""
    _set_alice_expiry(login_env, days=10)
    resp = _login(login_env.client, "alice", "alice-pwd", mode="shared")
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["user"]["effective_license_expiry"]


def test_shared_login_rejects_expired_account(login_env):
    """账号在「用户管理」里已过期 → 桌面端登录被拦截（与网页端一致，不再放行）。"""
    _set_alice_expiry(login_env, days=-1)
    resp = _login(login_env.client, "alice", "alice-pwd", mode="shared")
    assert resp.status_code in (401, 403), resp.text
    assert "过期" in resp.json()["detail"]


def test_shared_login_rejects_bad_password(login_env):
    resp = _login(login_env.client, "alice", "wrong", mode="shared")
    assert resp.status_code == 401


def test_shared_login_requires_account_group(login_env):
    """共享模式按分组共享，账号没有组就无法参与共享。"""
    resp = _login(login_env.client, "bob", "bob-pwd", mode="shared")
    assert resp.status_code == 400
    assert "数据组" in resp.json()["detail"]


def test_standalone_admin_login_auto_issued_without_approval(login_env):
    """管理员完全免授权：单机模式直接签发 active 许可，不需要批准，也不受限换机/禁用。"""
    from app.services.auth_service import auth_service

    db = login_env.session_factory()
    try:
        db.add(User(
            username="root", password_hash=auth_service.hash_password("root-pwd"),
            is_admin=True, is_active=True, must_change_password=False,
            city="广州", operator="移动",
        ))
        db.commit()
    finally:
        db.close()

    resp = _login(login_env.client, "root", "root-pwd", mode="standalone")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["result"] == "ok" and data["license_file"]
    assert data["mode"] == "standalone"

    # 换台机器也直接可用（管理员免授权 → 不套用单机"绑定机器"限制）
    other = _login(login_env.client, "root", "root-pwd", mode="standalone",
                   machine="ZZZZ-ZZZZ-ZZZZ-ZZZZ")
    assert other.status_code == 200, other.text
    assert other.json()["data"]["machine_code"] == "ZZZZ-ZZZZ-ZZZZ-ZZZZ"

    # 授权被禁用过也照常签发（管理员不参与授权管控）
    db = login_env.session_factory()
    try:
        db.query(DesktopLicense).filter(DesktopLicense.username == "root").update(
            {DesktopLicense.status: "disabled"}
        )
        db.commit()
    finally:
        db.close()
    again = _login(login_env.client, "root", "root-pwd", mode="standalone",
                   machine="ZZZZ-ZZZZ-ZZZZ-ZZZZ")
    assert again.status_code == 200, again.text
    assert again.json()["data"]["result"] == "ok"


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


def test_session_check_refreshes_client_version(login_env):
    """心跳顺带上报版本 →「桌面授权」页的「当前版本」列 OTA 后立即刷新。"""
    resp = _login(login_env.client, "alice", "alice-pwd", mode="shared", client_version="0.0.13")
    assert resp.status_code == 200, resp.text
    license_file = resp.json()["data"]["license_file"]
    jti = resp.json()["data"]["session_jti"]

    check = login_env.client.post(
        "/api/v1/desktop-cloud/auth/session-check",
        json={
            "license_file": license_file,
            "machine_code": MACHINE_A,
            "session_jti": jti,
            "client_version": "0.0.14",
        },
    )
    assert check.status_code == 200, check.text

    db = login_env.session_factory()
    try:
        record = db.query(DesktopLicense).order_by(DesktopLicense.id.desc()).first()
        assert record is not None
        assert record.client_version == "0.0.14"
    finally:
        db.close()


def test_client_version_mirrors_to_all_records_of_machine(login_env):
    """「当前版本」是整台机器的属性：同机器其它记录（单机/共享）一起刷新。

    客户端只会上报给当前正在使用的那条授权，而「桌面授权」页默认只看单机记录：
    只回写当前记录时，用共享模式跑着的机器升级后，单机记录会停在升级前的旧版本
    （v0.0.17 显示成 v0.0.15）。其它机器上的记录不受影响。
    """
    # 同机器的单机记录（申请 → 批准），版本停在 0.0.15
    standalone = _login(
        login_env.client, "alice", "alice-pwd", mode="standalone", client_version="0.0.15"
    )
    standalone_id = standalone.json()["data"]["license_id"]
    assert (
        login_env.client.post(
            f"/api/v1/desktop-licenses/{standalone_id}/approve", json={}
        ).status_code
        == 200
    )

    # 另一台机器上的记录：不应被本机的上报改动
    other = _login(
        login_env.client,
        "alice",
        "alice-pwd",
        mode="standalone",
        machine="ZZZZ-ZZZZ-ZZZZ-ZZZZ",
        client_version="0.0.9",
    )
    other_id = other.json()["data"]["license_id"]
    assert (
        login_env.client.post(
            f"/api/v1/desktop-licenses/{other_id}/approve", json={}
        ).status_code
        == 200
    )

    # 本机改走共享模式并升级到 0.0.17 → 同机器的单机记录也要跟着刷新
    shared = _login(login_env.client, "alice", "alice-pwd", mode="shared", client_version="0.0.17")
    assert shared.status_code == 200, shared.text
    license_file = shared.json()["data"]["license_file"]
    jti = shared.json()["data"]["session_jti"]

    # 心跳上报的版本同样镜像（OTA 升级后不必等下一次登录）
    check = login_env.client.post(
        "/api/v1/desktop-cloud/auth/session-check",
        json={
            "license_file": license_file,
            "machine_code": MACHINE_A,
            "session_jti": jti,
            "client_version": "0.0.18",
        },
    )
    assert check.status_code == 200, check.text

    db = login_env.session_factory()
    try:
        versions = {row.id: row.client_version for row in db.query(DesktopLicense).all()}
    finally:
        db.close()
    assert versions[standalone_id] == "0.0.18"
    assert versions[other_id] == "0.0.9"


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


def test_session_check_returns_current_permissions(login_env):
    """心跳回传账号当前权限位：管理员在「用户管理 → 编辑」改动后桌面端可即时同步。"""
    from app.services.auth_service import auth_service

    ok = _login(login_env.client, "alice", "alice-pwd", mode="shared")
    data = ok.json()["data"]

    def check() -> dict:
        resp = login_env.client.post(
            "/api/v1/desktop-cloud/auth/session-check",
            json={
                "license_file": data["license_file"],
                "machine_code": MACHINE_A,
                "session_jti": data["session_jti"],
            },
        )
        assert resp.status_code == 200, resp.text
        return resp.json()["data"]

    payload = check()
    assert payload["valid"] is True
    assert payload["user"]["username"] == "alice"
    assert payload["user"]["can_data_import"] is True
    assert payload["user"]["can_assistant"] is False

    # 管理员改权限（取消数据导入、授予网优助手）→ 下一次心跳即拿到新值
    db = login_env.session_factory()
    try:
        alice = db.query(User).filter(User.username == "alice").first()
        auth_service.update_user(
            db, alice.id, {"can_data_import": False, "can_assistant": True}
        )
    finally:
        db.close()

    updated = check()
    assert updated["user"]["can_data_import"] is False
    assert updated["user"]["can_assistant"] is True


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


def test_shared_login_marks_user_online_as_desktop(login_env):
    """桌面端共享模式登录在服务器记 client_type='desktop' 会话。

    用户管理页的「桌面端」在线状态必须能看到它——原先的在线统计只算 pc/app，
    桌面端用户会恒显示离线。
    """
    from app.services.auth_service import auth_service

    _login(login_env.client, "alice", "alice-pwd", mode="shared")

    db = login_env.session_factory()
    try:
        alice = db.query(User).filter(User.username == "alice").first()
        assert auth_service.is_user_online_by_client_type(db, alice.id, "desktop") is True
        assert auth_service.is_user_online_by_client_type(db, alice.id, "pc") is False

        _, _, stats = auth_service.get_all_users(db)
        assert stats["online_desktop"] == 1
        assert stats["online"] == 1  # 桌面端在线同样计入总在线数
        assert stats["online_pc"] == 0 and stats["online_app"] == 0
    finally:
        db.close()


def test_session_check_refreshes_last_activity(login_env):
    """session-check 就是桌面端心跳（默认 60s）：必须刷新 last_activity。

    否则用户空闲超过 5 分钟后，会被「用户管理」的 5 分钟活跃窗口误报为离线。
    """
    from datetime import datetime, timedelta, timezone

    from app.models.database import UserSession
    from app.services.auth_service import auth_service

    ok = _login(login_env.client, "alice", "alice-pwd", mode="shared")
    data = ok.json()["data"]
    jti = data["session_jti"]

    db = login_env.session_factory()
    try:
        db.query(UserSession).filter(UserSession.token_jti == jti).update(
            {UserSession.last_activity: datetime.now(timezone.utc) - timedelta(minutes=30)}
        )
        db.commit()
        alice = db.query(User).filter(User.username == "alice").first()
        assert auth_service.is_user_online_by_client_type(db, alice.id, "desktop") is False
    finally:
        db.close()

    check = login_env.client.post(
        "/api/v1/desktop-cloud/auth/session-check",
        json={
            "license_file": data["license_file"],
            "machine_code": MACHINE_A,
            "session_jti": jti,
        },
    )
    assert check.json()["data"]["valid"] is True

    db = login_env.session_factory()
    try:
        alice = db.query(User).filter(User.username == "alice").first()
        assert auth_service.is_user_online_by_client_type(db, alice.id, "desktop") is True
    finally:
        db.close()
