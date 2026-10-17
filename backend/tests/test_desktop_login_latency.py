"""桌面端登录延迟：本机凭据有效时不再为网络干等。

背景：单机模式原先即使本机账号密码校验通过，也要 `await` 一次最长 4 秒的服务器
探测才返回登录结果——断网/网络差时用户就一直转圈。现在本机凭据有效时只等
STANDALONE_FAST_PROBE_SECONDS，超时就先用本机授权进页面，服务器结果到了再后台补账。
"""
from __future__ import annotations

import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.database import Base, User
from app.services.auth_service import auth_service


@pytest.fixture()
def login_env(tmp_path, monkeypatch):
    from app.api.v1.endpoints import desktop_local
    from app.core import startup_gate
    from app.core.config import settings
    from app.services import desktop_cloud_client as cloud

    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    monkeypatch.setattr(settings, "DATA_ROOT", tmp_path)
    monkeypatch.setattr(settings, "LICENSE_DIR", tmp_path / "licenses")
    monkeypatch.setattr(settings, "DESKTOP_PROFILE", "standalone")
    monkeypatch.setattr(settings, "NPT_SERVER_URL", "https://example.invalid")
    monkeypatch.setattr(cloud, "state_file", lambda: tmp_path / "cloud_state.json")
    settings.LICENSE_DIR.mkdir(parents=True, exist_ok=True)
    startup_gate.reset_for_tests()

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
    app.dependency_overrides[get_current_user] = lambda: None

    state_file = tmp_path / "sync_state.json"
    state_file.write_text(json.dumps({"run_mode": "offline"}), encoding="utf-8")
    import app.services.desktop_sync_service as sync_module

    monkeypatch.setattr(sync_module, "state_file", lambda: state_file)

    # 本机已有镜像账号（管理员免授权，单机模式可直接本地校验）
    db = TestingSession()
    try:
        db.add(
            User(
                username="alice",
                password_hash=auth_service.hash_password("pwd123"),
                is_admin=True,
                is_active=True,
                city="广州",
                operator="移动",
            )
        )
        db.commit()
    finally:
        db.close()

    yield SimpleEnv(
        client=TestClient(app),
        cloud=cloud,
        monkeypatch=monkeypatch,
        startup_gate=startup_gate,
        settings=settings,
    )

    startup_gate.reset_for_tests()


class SimpleEnv:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def _login(env, mode: str = "standalone", password: str = "pwd123"):
    return env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": password, "mode": mode, "remember": False},
    )


def test_slow_server_does_not_block_offline_login(login_env):
    """服务器探测慢于快速阈值：必须立刻用本机授权登录，而不是等满 4 秒。"""

    def _slow_login(*args, **kwargs):
        time.sleep(6)
        raise AssertionError("后台探测不该被等待")

    login_env.monkeypatch.setattr(login_env.cloud, "login", _slow_login)

    started = time.monotonic()
    resp = _login(login_env)
    elapsed = time.monotonic() - started

    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["offline"] is True
    assert data["user"]["username"] == "alice"
    assert data["access_token"]
    # 阈值 1.2s，留足本机 bcrypt 校验（慢机器可能 1 秒级）与开销
    assert elapsed < 3.0, f"登录耗时 {elapsed:.2f}s，仍在等服务器"


def test_fast_server_response_keeps_online_path(login_env):
    """服务器秒回时仍走在线路径（离线优先不能把在线语义吃掉）。"""
    payload = {
        "result": "ok",
        "mode": "standalone",
        "idle_logout_days": 2,
        "session_jti": "jti-1",
        "user": {
            "username": "alice",
            "is_admin": True,
            "city": "广州",
            "operator": "移动",
        },
    }
    login_env.monkeypatch.setattr(login_env.cloud, "login", lambda *a, **kw: payload)

    resp = _login(login_env)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["offline"] is False
    assert data["user"]["username"] == "alice"


def test_successful_login_releases_startup_gate(login_env):
    """登录成功必须放行后台重活队列。"""
    login_env.monkeypatch.setattr(
        login_env.cloud,
        "login",
        lambda *a, **kw: {
            "result": "ok",
            "mode": "standalone",
            "idle_logout_days": 2,
            "user": {"username": "alice", "is_admin": True, "city": "广州", "operator": "移动"},
        },
    )
    assert login_env.startup_gate.is_login_completed() is False
    assert _login(login_env).status_code == 200
    assert login_env.startup_gate.is_login_completed() is True


def test_offline_login_releases_startup_gate(login_env):
    """离线登录同样算「登录完成」，也要放行后台重活。"""
    def _unreachable(*args, **kwargs):
        raise login_env.cloud.CloudError(0, "网络不可达")

    login_env.monkeypatch.setattr(login_env.cloud, "login", _unreachable)
    resp = _login(login_env)
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["offline"] is True
    assert login_env.startup_gate.is_login_completed() is True
