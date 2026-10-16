"""桌面端本机登录：账号镜像 / 运行模式 / 离线登录 / 单机模式限制共享同步。"""
from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta
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
from app.core.security import get_current_user
from app.models.database import Base, User
from app.services.auth_service import auth_service

MACHINE_CODE_KEY = "NPT_TEST_MACHINE"


@pytest.fixture()
def local_env(tmp_path, monkeypatch):
    """桌面本机形态：临时数据根 +  licences 目录 + 最小应用 + 真实 SQLite。"""
    from app.api.v1.endpoints import desktop_local
    from app.core.config import settings
    from app.services import desktop_cloud_client as cloud
    from app.services.desktop_signing import sign_license
    from app.utils.machine_code import get_machine_code

    private_key = Ed25519PrivateKey.generate()
    public_hex = (
        private_key.public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        .hex()
    )
    monkeypatch.setenv("NPT_LICENSE_PUBLIC_KEY_HEX", public_hex)
    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    monkeypatch.setattr(settings, "LICENSE_DIR", tmp_path / "licenses")
    monkeypatch.setattr(settings, "DATA_ROOT", tmp_path)
    # 当前配置档：本文件以单机模式登录用例为主；共享模式用例内部切到 shared 档
    monkeypatch.setattr(settings, "DESKTOP_PROFILE", "standalone")
    monkeypatch.setattr(settings, "NPT_SERVER_URL", "https://example.invalid")
    monkeypatch.setattr(cloud, "state_file", lambda: tmp_path / "cloud_state.json")
    settings.LICENSE_DIR.mkdir(parents=True, exist_ok=True)
    machine = get_machine_code()

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
    app.include_router(desktop_local.router, prefix="/api/v1/desktop")
    app.dependency_overrides[get_db] = override_db
    current = {"user": None}
    app.dependency_overrides[get_current_user] = lambda: current["user"]

    state_file = tmp_path / "sync_state.json"
    state_file.write_text(json.dumps({"run_mode": "offline"}), encoding="utf-8")

    import app.services.desktop_sync_service as sync_module

    monkeypatch.setattr(sync_module, "state_file", lambda: state_file)

    def make_license(mode="standalone", username="alice", days=30, issued_via="online") -> str:
        private_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        from app.services import desktop_signing

        monkeypatch.setenv("NPT_LICENSE_PRIVATE_KEY", private_pem.decode())
        return sign_license(
            {
                "v": 1,
                "license_id": 3,
                "subject": username,
                "machine_code": machine,
                "lease_days": days,
                "issued_via": issued_via,
                "issued_at": "2026-01-01 00:00:00",
                "expire_date": (date.today() + timedelta(days=days)).isoformat(),
                "features": ["all"],
                "mode": mode,
                "username": username,
                "idle_logout_days": 2,
            }
        )

    yield SimpleNamespace(
        client=TestClient(app),
        cloud=cloud,
        monkeypatch=monkeypatch,
        settings=settings,
        session_factory=TestingSession,
        make_license=make_license,
        current_user=current,
        machine=machine,
        tmp_path=tmp_path,
        desktop_local=desktop_local,
    )


def _server_ok(**overrides):
    payload = {
        "result": "ok",
        "mode": "shared",
        "license_file": "signed",
        "license_id": 3,
        "idle_logout_days": 2,
        "login_count": 1,
        "user": {
            "username": "alice",
            "is_admin": False,
            "city": "广州",
            "operator": "移动",
            "can_data_import": True,
        },
    }
    payload.update(overrides)
    return payload


def test_login_mirrors_web_account(local_env):
    local_env.monkeypatch.setattr(local_env.settings, "DESKTOP_PROFILE", "shared")
    """登录成功后本机镜像出同名账号，组与权限位照搬网页端。"""
    local_env.monkeypatch.setattr(
        local_env.cloud, "login", lambda *a, **kw: _server_ok()
    )
    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "shared"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["access_token"]
    assert data["mode"] == "shared"

    db = local_env.session_factory()
    try:
        row = db.query(User).filter(User.username == "alice").first()
        assert row is not None
        assert row.city == "广州" and row.operator == "移动"
        assert row.can_data_import is True
        assert row.desktop_run_mode == "shared"
        # 密码哈希落本机，单机模式断网登录时可校验
        assert auth_service.verify_password("pwd123", row.password_hash)
    finally:
        db.close()


def test_shared_login_starts_sync(local_env):
    local_env.monkeypatch.setattr(local_env.settings, "DESKTOP_PROFILE", "shared")
    """共享模式登录置为共享并触发一次同步（延后后台跑，失败不阻断登录）。"""
    import app.services.desktop_sync_service as sync_module

    calls = []
    local_env.monkeypatch.setattr(local_env.cloud, "login", lambda *a, **kw: _server_ok())
    local_env.monkeypatch.setattr(
        sync_module, "sync_once", lambda: calls.append(True) or {"pulled": 0}
    )
    # 登录优先：真实延后 5s，这里缩短以便断言"最终会跑"
    local_env.monkeypatch.setattr(local_env.desktop_local, "LOGIN_SYNC_DELAY_SECONDS", 0.1)

    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "shared"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["sync_started"] is True
    assert sync_module.run_mode() == "shared"
    for _ in range(60):  # 同步延后由定时器触发，短暂等待
        if calls:
            break
        time.sleep(0.05)
    assert calls


def test_register_proxies_then_logs_in(local_env):
    local_env.monkeypatch.setattr(local_env.settings, "DESKTOP_PROFILE", "shared")
    """桌面端注册：先经服务器建号（含数据组），再自动以共享模式登录。"""
    seen = {}
    local_env.monkeypatch.setattr(
        local_env.cloud,
        "register",
        lambda username, password, city, operator: seen.update(
            {"username": username, "city": city, "operator": operator}
        )
        or {"username": username},
    )
    local_env.monkeypatch.setattr(
        local_env.cloud, "login", lambda *a, **kw: _server_ok()
    )

    resp = local_env.client.post(
        "/api/v1/desktop/register",
        json={
            "username": "alice",
            "password": "pwd123",
            "confirm_password": "pwd123",
            "city": "广州",
            "operator": "移动",
        },
    )
    assert resp.status_code == 200, resp.text
    assert seen == {"username": "alice", "city": "广州", "operator": "移动"}
    data = resp.json()["data"]
    assert data["access_token"] and data["mode"] == "shared"

    db = local_env.session_factory()
    try:
        row = db.query(User).filter(User.username == "alice").first()
        assert row is not None and row.city == "广州"
    finally:
        db.close()


def test_register_rejects_weak_input(local_env):
    """注册校验与网页端一致：短用户名/短密码/两次不一致/缺组都拒绝。"""
    for payload in (
        {"username": "ab", "password": "pwd123", "confirm_password": "pwd123", "city": "广州", "operator": "移动"},
        {"username": "alice", "password": "123", "confirm_password": "123", "city": "广州", "operator": "移动"},
        {"username": "alice", "password": "pwd123", "confirm_password": "pwd456", "city": "广州", "operator": "移动"},
        {"username": "alice", "password": "pwd123", "confirm_password": "pwd123", "city": "", "operator": "移动"},
    ):
        resp = local_env.client.post("/api/v1/desktop/register", json=payload)
        assert resp.status_code == 400, resp.text


def test_standalone_login_pending(local_env):
    local_env.monkeypatch.setattr(
        local_env.cloud,
        "login",
        lambda *a, **kw: {"result": "pending", "status": "pending", "mode": "standalone"},
    )
    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "standalone"},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["result"] == "pending"
    db = local_env.session_factory()
    try:
        assert db.query(User).filter(User.username == "alice").first() is None
    finally:
        db.close()


def test_standalone_login_forces_offline(local_env):
    """单机模式不共享数据：登录后同步模式强制离线，且不能切回共享。"""
    # 组兜底依赖地市预设：CI 无 .env 时预设为空，这里显式放行（与其它用例一致）
    local_env.monkeypatch.setattr(
        local_env.settings, "NPT_CITY_PRESETS", "广州,河源,惠州,深圳", raising=False
    )
    local_env.monkeypatch.setattr(
        local_env.cloud,
        "login",
        lambda *a, **kw: _server_ok(mode="standalone", user={
            "username": "alice", "is_admin": False, "city": None, "operator": None,
        }),
    )
    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "standalone"},
    )
    assert resp.status_code == 200, resp.text

    db = local_env.session_factory()
    try:
        row = db.query(User).filter(User.username == "alice").first()
        # 单机兜底：账号没有组也要有组，否则上传的数据自己都看不见
        assert row.city and row.operator
        local_env.current_user["user"] = row
    finally:
        db.close()

    denied = local_env.client.put("/api/v1/desktop/run-mode", json={"mode": "shared"})
    assert denied.status_code == 403


def test_offline_login_when_server_unreachable(local_env):
    """单机模式服务器不可达时，凭本机许可 + 本机密码哈希仍可登录。"""
    license_file = local_env.make_license()
    (local_env.settings.LICENSE_DIR / "license.nptlic").write_text(
        license_file, encoding="utf-8"
    )

    def boom(*a, **kw):
        raise local_env.cloud.CloudError(0, "无法连接授权服务器")

    local_env.monkeypatch.setattr(local_env.cloud, "login", boom)
    local_env.monkeypatch.setattr(
        local_env.desktop_local, "_issue_local_token", lambda db, user, days=None: "offline-token"
    )

    # 本机还没有账号 → 拒绝（必须先联机登录一次建立本地账号）
    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "standalone"},
    )
    assert resp.status_code == 502

    db = local_env.session_factory()
    try:
        db.add(
            User(
                username="alice",
                password_hash=auth_service.hash_password("pwd123"),
                is_active=True,
                desktop_run_mode="standalone",
            )
        )
        db.commit()
    finally:
        db.close()

    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "standalone"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["offline"] is True
    assert data["token"] == "offline-token"
    # 登录次数本地记账，下次联机补报
    state = json.loads((local_env.tmp_path / "cloud_state.json").read_text(encoding="utf-8"))
    assert state["pending_offline_logins"] == 1


def test_standalone_login_short_probe_then_offline(local_env):
    """单机模式本地凭据有效：服务器只做短时探测，连不上立即离线登录。"""
    (local_env.settings.LICENSE_DIR / "license.nptlic").write_text(
        local_env.make_license(), encoding="utf-8"
    )
    db = local_env.session_factory()
    try:
        db.add(
            User(
                username="alice",
                password_hash=auth_service.hash_password("pwd123"),
                is_active=True,
                desktop_run_mode="standalone",
            )
        )
        db.commit()
    finally:
        db.close()

    seen = {}
    local_env.monkeypatch.setattr(
        local_env.desktop_local,
        "STANDALONE_ONLINE_PROBE_SECONDS",
        1,
    )

    def boom(*args, **kwargs):
        seen.update(kwargs)
        raise local_env.cloud.CloudError(0, "无法连接授权服务器")

    local_env.monkeypatch.setattr(local_env.cloud, "login", boom)

    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "standalone"},
    )

    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["offline"] is True
    assert data["verify_pending"] is True
    assert data["mode"] == "standalone"
    # 探测用的是短超时（不让用户干等完整超时）
    assert seen.get("timeout") == 1
    state = json.loads((local_env.tmp_path / "cloud_state.json").read_text(encoding="utf-8"))
    # 旧会话标识被清除、留下待联网校验标记；登录次数本地记账
    assert "session_jti" not in state
    assert state["needs_license_verify"] is True
    assert state["pending_offline_logins"] == 1


def test_standalone_login_server_error_falls_back_offline(local_env):
    """服务器 5xx 且本地凭据有效：不锁死用户，离线登录并等待联网后校验。"""
    (local_env.settings.LICENSE_DIR / "license.nptlic").write_text(
        local_env.make_license(), encoding="utf-8"
    )
    db = local_env.session_factory()
    try:
        db.add(
            User(
                username="alice",
                password_hash=auth_service.hash_password("pwd123"),
                is_active=True,
                desktop_run_mode="standalone",
            )
        )
        db.commit()
    finally:
        db.close()

    def boom(*args, **kwargs):
        raise local_env.cloud.CloudError(503, "服务暂时不可用")

    local_env.monkeypatch.setattr(local_env.cloud, "login", boom)
    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "standalone"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["offline"] is True


def test_standalone_login_business_error_still_blocks(local_env):
    """授权被禁用等业务错误：即使本地许可仍有效也要拦住（管理员已撤销）。"""
    (local_env.settings.LICENSE_DIR / "license.nptlic").write_text(
        local_env.make_license(), encoding="utf-8"
    )
    db = local_env.session_factory()
    try:
        db.add(
            User(
                username="alice",
                password_hash=auth_service.hash_password("pwd123"),
                is_active=True,
                desktop_run_mode="standalone",
            )
        )
        db.commit()
    finally:
        db.close()

    def denied(*args, **kwargs):
        raise local_env.cloud.CloudError(403, "该账号的单机授权已被禁用，请联系管理员")

    local_env.monkeypatch.setattr(local_env.cloud, "login", denied)
    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "standalone"},
    )
    assert resp.status_code == 403, resp.text
    assert "禁用" in resp.json()["detail"]


def test_standalone_expired_license_prompts_expiry(local_env):
    """本机许可已过期且断网：提示授权过期（而非笼统的无法连接服务器）。"""
    expired = local_env.make_license(days=-1)
    (local_env.settings.LICENSE_DIR / "license.nptlic").write_text(expired, encoding="utf-8")

    def boom(*a, **kw):
        raise local_env.cloud.CloudError(0, "无法连接授权服务器")

    local_env.monkeypatch.setattr(local_env.cloud, "login", boom)
    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "standalone"},
    )

    assert resp.status_code == 403, resp.text
    detail = resp.json()["detail"]
    assert "过期" in detail and "联网" in detail


def test_standalone_offline_login_accepts_shared_license(local_env):
    """已授权用户（本机许可是共享模式）断网也能进单机模式：不再要求联网切换。

    2026-10-09 调整：单机模式离线登录只要求"本机许可有效 + 归属账号匹配 + 本机密码正确"，
    许可模式（shared/standalone）不再阻断；需要联网的续期/校验等有网后再做。
    """
    shared = local_env.make_license(mode="shared")
    (local_env.settings.LICENSE_DIR / "license.nptlic").write_text(shared, encoding="utf-8")

    def boom(*a, **kw):
        raise local_env.cloud.CloudError(0, "无法连接授权服务器")

    local_env.monkeypatch.setattr(local_env.cloud, "login", boom)
    local_env.monkeypatch.setattr(
        local_env.desktop_local, "_issue_local_token", lambda db, user, days=None: "offline-token"
    )
    # 本机镜像账号（此前联机登录过）
    db = local_env.session_factory()
    try:
        db.add(User(username="alice", password_hash=auth_service.hash_password("pwd123"), is_active=True))
        db.commit()
    finally:
        db.close()

    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "standalone"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["offline"] is True
    assert data["access_token"] == "offline-token"


def test_standalone_offline_login_admin_without_license(local_env):
    """管理员完全免授权：本机无许可，凭本机镜像管理员账号 + 密码也能离线登录。"""
    def boom(*a, **kw):
        raise local_env.cloud.CloudError(0, "无法连接授权服务器")

    local_env.monkeypatch.setattr(local_env.cloud, "login", boom)
    local_env.monkeypatch.setattr(
        local_env.desktop_local, "_issue_local_token", lambda db, user, days=None: "admin-token"
    )
    db = local_env.session_factory()
    try:
        db.add(User(
            username="root", password_hash=auth_service.hash_password("pwd123"),
            is_active=True, is_admin=True, city="河源", operator="电信",
        ))
        db.commit()
    finally:
        db.close()

    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "root", "password": "pwd123", "mode": "standalone"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["offline"] is True and data["access_token"] == "admin-token"
    assert data["user"]["is_admin"] is True


def test_last_login_remember_roundtrip(local_env):
    """勾选「记住」→ 加密保存并可读回（落盘无明文）；取消勾选 → 清除。"""
    local_env.monkeypatch.setattr(
        local_env.cloud, "login",
        lambda *a, **kw: _server_ok(mode="standalone", user={
            "username": "alice", "is_admin": False, "city": "河源", "operator": "电信",
        }),
    )
    local_env.monkeypatch.setattr(
        local_env.desktop_local, "_issue_local_token", lambda db, user, days=None: "tok"
    )

    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "standalone", "remember": True},
    )
    assert resp.status_code == 200, resp.text

    got = local_env.client.get("/api/v1/desktop/last-login")
    assert got.status_code == 200
    saved = got.json()["data"]
    assert saved["username"] == "alice" and saved["password"] == "pwd123"
    assert saved["mode"] == "standalone"
    # 落盘必须是密文（不能出现明文密码）
    raw = (local_env.settings.DATA_ROOT / "last_login.json").read_bytes()
    assert b"pwd123" not in raw

    # 取消勾选再登录 → 清除已保存的凭据
    resp2 = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "standalone", "remember": False},
    )
    assert resp2.status_code == 200, resp2.text
    assert local_env.client.get("/api/v1/desktop/last-login").json()["data"] is None


def test_verify_pending_license_once_renews_and_clears_flag(local_env):
    """联网后用许可续期通道校验授权：成功即清除待校验标记。"""
    (local_env.settings.LICENSE_DIR / "license.nptlic").write_text(
        local_env.make_license(), encoding="utf-8"
    )
    local_env.cloud.save_state(needs_license_verify=True, license_error="旧错误")

    local_env.monkeypatch.setattr(
        local_env.cloud,
        "renew_local_license",
        lambda: {"expire_date": "2026-12-31"},
    )
    result = local_env.desktop_local.verify_pending_license_once()

    assert result == "2026-12-31"
    state = local_env.cloud.load_state()
    assert not state.get("needs_license_verify")
    assert not state.get("license_error")


def test_verify_pending_license_renews_expired_license(local_env):
    """离线期间授权过期：联网校验时经续期通道换回有效许可并回传新到期日。"""
    (local_env.settings.LICENSE_DIR / "license.nptlic").write_text(
        local_env.make_license(days=-1), encoding="utf-8"
    )
    local_env.cloud.save_state(needs_license_verify=True)
    local_env.monkeypatch.setattr(
        local_env.cloud, "renew_local_license", lambda: {"expire_date": "2026-12-31"}
    )

    data = local_env.desktop_local.check_session_once()

    assert data["license_verified"] is True
    assert data["license_expire_date"] == "2026-12-31"
    assert not local_env.cloud.load_state().get("needs_license_verify")


def test_verify_pending_license_once_records_disabled_error(local_env):
    """服务器明确拒绝（授权被禁用）：记录错误供前端提示，并停止重试。"""
    (local_env.settings.LICENSE_DIR / "license.nptlic").write_text(
        local_env.make_license(), encoding="utf-8"
    )
    local_env.cloud.save_state(needs_license_verify=True)

    def denied():
        raise local_env.cloud.CloudError(403, "该授权已被禁用，请联系管理员")

    local_env.monkeypatch.setattr(local_env.cloud, "renew_local_license", denied)
    result = local_env.desktop_local.verify_pending_license_once()

    assert result is None
    state = local_env.cloud.load_state()
    assert not state.get("needs_license_verify")
    assert "禁用" in state["license_error"]
    # 错误也会随巡检结果带给前端
    data = local_env.desktop_local.check_session_once()
    assert "禁用" in data["license_error"]


def test_verify_pending_license_once_skips_offline_issued(local_env):
    """离线导入的许可无法在线续期：直接清除标记，不误报授权异常。"""
    (local_env.settings.LICENSE_DIR / "license.nptlic").write_text(
        local_env.make_license(issued_via="offline"), encoding="utf-8"
    )
    local_env.cloud.save_state(needs_license_verify=True)
    local_env.monkeypatch.setattr(
        local_env.cloud,
        "renew_local_license",
        lambda: (_ for _ in ()).throw(AssertionError("离线许可不应尝试续期")),
    )

    assert local_env.desktop_local.verify_pending_license_once() is None
    assert not local_env.cloud.load_state().get("needs_license_verify")


def test_shared_login_error_propagates(local_env):
    local_env.monkeypatch.setattr(local_env.settings, "DESKTOP_PROFILE", "shared")
    """共享模式不做离线兜底：服务器不可用就直接失败。"""
    def boom(*a, **kw):
        raise local_env.cloud.CloudError(0, "无法连接授权服务器")

    local_env.monkeypatch.setattr(local_env.cloud, "login", boom)
    resp = local_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "shared"},
    )
    assert resp.status_code == 502


def test_auth_poll_completes_login(local_env):
    """管理员批准后轮询接口直接建立登录态（无需重输密码）。"""
    (local_env.settings.LICENSE_DIR / "license.nptlic").write_text(
        local_env.make_license(), encoding="utf-8"
    )
    local_env.monkeypatch.setattr(
        local_env.cloud,
        "poll_login",
        lambda username: _server_ok(mode="standalone"),
    )
    local_env.monkeypatch.setattr(
        local_env.desktop_local, "_issue_local_token", lambda db, user, days=None: "poll-token"
    )
    resp = local_env.client.post(
        "/api/v1/desktop/auth-poll", json={"username": "alice"}
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    # 必须与 /desktop/login 同形状：前端轮询按 result + access_token 判定登录完成
    assert data["result"] == "ok"
    assert data["token"] == "poll-token"
    assert data["access_token"] == "poll-token"
    assert data["user"]["username"] == "alice"
    assert data["mode"] == "standalone"

    db = local_env.session_factory()
    try:
        row = db.query(User).filter(User.username == "alice").first()
        assert row is not None and row.desktop_run_mode == "standalone"
    finally:
        db.close()


def test_session_check_syncs_permissions_to_mirror(local_env):
    """心跳把服务器当前权限位同步到本机镜像账号（管理员改权限无需重登）。"""
    import app.core.database as core_database
    from app.models.database import User as UserModel

    # 本机镜像读写走 SessionLocal（生产是真实库），测试里指到临时库
    local_env.monkeypatch.setattr(core_database, "SessionLocal", local_env.session_factory)

    db = local_env.session_factory()
    try:
        db.add(
            UserModel(
                username="alice",
                password_hash="x",
                is_admin=True,
                is_active=True,
                can_data_import=True,
            )
        )
        db.commit()
    finally:
        db.close()

    local_env.cloud.save_state(session_jti="jti-1")
    local_env.monkeypatch.setattr(
        local_env.cloud,
        "session_check",
        lambda jti: {
            "valid": True,
            "user": {
                "username": "alice",
                "is_admin": False,
                "can_data_import": True,
                "can_assistant": True,
                # 用户管理里的实际到期日：必须镜像到本机，否则到期后桌面端仍被判为已授权
                "effective_license_expiry": "2030-03-04T00:00:00",
            },
        },
    )

    result = local_env.desktop_local.check_session_once()
    assert result["valid"] is True
    assert result["user"]["can_assistant"] is True  # 回传同步后的账号载荷供前端刷新
    assert result["user"]["effective_license_expiry"]  # 前端门禁据此判定

    db = local_env.session_factory()
    try:
        row = db.query(UserModel).filter(UserModel.username == "alice").first()
        assert row is not None
        assert row.is_admin is False  # 管理员位被撤销 → 同步
        assert row.can_data_import is True
        assert row.can_assistant is True  # 新授予的权限 → 同步
        assert row.license_expiry == datetime(2030, 3, 4)  # 到期日 → 同步
    finally:
        db.close()


def test_mirror_local_expiry_handles_expired_and_unlimited():
    """到期日镜像：服务器给的已过期日期要原样落到本机（门禁据此拦人），
    未设期限（无限期）则清空本机值，避免旧日期一直卡着不放行/误拦。"""
    from app.api.v1.endpoints.desktop_local import _mirror_local_expiry
    from app.models.database import User as UserModel

    row = UserModel(username="u", password_hash="x")
    _mirror_local_expiry(row, {"effective_license_expiry": "2020-01-02T00:00:00"})
    assert row.license_expiry == datetime(2020, 1, 2)

    # effective_license_expiry 优先于用户自身的例外期限
    _mirror_local_expiry(
        row,
        {"effective_license_expiry": "2031-05-06T00:00:00", "license_expiry": "2020-01-01T00:00:00"},
    )
    assert row.license_expiry == datetime(2031, 5, 6)

    _mirror_local_expiry(row, {"effective_license_expiry": None, "license_expiry": None})
    assert row.license_expiry is None


def test_auth_poll_still_pending(local_env):
    local_env.monkeypatch.setattr(
        local_env.cloud,
        "poll_login",
        lambda username: {"result": "pending", "status": "pending"},
    )
    resp = local_env.client.post(
        "/api/v1/desktop/auth-poll", json={"username": "alice"}
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["result"] == "pending"


def test_session_check_never_kicks_on_server_error(monkeypatch):
    """服务器 5xx / 网络异常不得判为"已在别处登录"：断网时必须能继续用。"""
    from app.services import desktop_cloud_client as cloud

    def _boom(*args, **kwargs):
        raise cloud.CloudError(503, "服务暂时不可用")

    monkeypatch.setattr(cloud, "_license_file_text", lambda: "fake-license")
    monkeypatch.setattr(cloud, "_request", _boom)

    result = cloud.session_check("jti-1")

    assert result["valid"] is True
    assert result.get("offline") is True


def test_check_session_once_keeps_login_when_offline(local_env):
    """单机模式断网：心跳按有效处理，不注销本机登录、不写 kicked 标记。"""
    local_env.cloud.save_state(session_jti="jti-offline", kicked=False, kicked_reason=None)
    local_env.monkeypatch.setattr(
        local_env.cloud,
        "session_check",
        lambda jti: {"valid": True, "offline": True, "reason": "无法连接授权服务器"},
    )

    result = local_env.desktop_local.check_session_once()

    assert result["valid"] is True
    assert result.get("offline") is True
    assert not local_env.cloud.load_state().get("kicked")


def test_login_shared_sync_is_deferred(local_env):
    local_env.monkeypatch.setattr(local_env.settings, "DESKTOP_PROFILE", "shared")
    """登录优先：共享模式登录只切换运行模式，同步延后到登录流程之后再跑。"""
    from types import SimpleNamespace

    dl = local_env.desktop_local
    calls: list = []
    started: list = []

    class FakeTimer:
        def __init__(self, interval, fn):
            started.append(interval)
            self.fn = fn
            self.daemon = False

        def start(self):
            calls.append("timer-started")

    local_env.monkeypatch.setattr(dl, "threading", SimpleNamespace(Timer=FakeTimer))
    local_env.monkeypatch.setattr(
        "app.services.desktop_sync_service.set_run_mode",
        lambda mode: calls.append(f"mode:{mode}"),
    )
    local_env.monkeypatch.setattr(dl, "_run_sync_once", lambda: calls.append("sync"))

    dl._start_shared_sync()

    assert calls == ["mode:shared", "timer-started"]
    assert started == [dl.LOGIN_SYNC_DELAY_SECONDS]
    assert "sync" not in calls  # 同步不得在登录路径上同步执行
