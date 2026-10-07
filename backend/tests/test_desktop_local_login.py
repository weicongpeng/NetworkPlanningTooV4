"""桌面端本机登录：账号镜像 / 运行模式 / 离线登录 / 单机模式限制共享同步。"""
from __future__ import annotations

import json
import time
from datetime import date, timedelta
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

    def make_license(mode="standalone", username="alice", days=30) -> str:
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
                "issued_via": "online",
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
    # 离线登录次数本地记账，下次联机补报
    state = json.loads((local_env.tmp_path / "cloud_state.json").read_text(encoding="utf-8"))
    assert state["pending_offline_logins"] == 1


def test_shared_login_error_propagates(local_env):
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
            },
        },
    )

    result = local_env.desktop_local.check_session_once()
    assert result["valid"] is True
    assert result["user"]["can_assistant"] is True  # 回传同步后的账号载荷供前端刷新

    db = local_env.session_factory()
    try:
        row = db.query(UserModel).filter(UserModel.username == "alice").first()
        assert row is not None
        assert row.is_admin is False  # 管理员位被撤销 → 同步
        assert row.can_data_import is True
        assert row.can_assistant is True  # 新授予的权限 → 同步
    finally:
        db.close()


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
