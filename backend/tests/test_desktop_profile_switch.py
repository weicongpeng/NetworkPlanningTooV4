"""共享/单机配置档切换：跨档登录短路、一次性凭据、重启端点。

核心隔离保证：登录请求的模式与当前运行档不一致时，当前档数据库不得出现
镜像账号/会话，只写目标档标记与加密的一次性凭据，由重启后的目标档消费。
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.database import Base, User


@pytest.fixture()
def switch_env(tmp_path, monkeypatch):
    from app.api.v1.endpoints import desktop_local
    from app.core.config import settings
    from app.services import desktop_cloud_client as cloud

    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    monkeypatch.setattr(settings, "DATA_ROOT", tmp_path)
    monkeypatch.setattr(settings, "LICENSE_DIR", tmp_path / "licenses")
    monkeypatch.setattr(settings, "DESKTOP_PROFILE", "standalone")

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    def override_db():
        db = testing_session()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(desktop_local.router, prefix="/api/v1/desktop")
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: None

    # 跨档短路必须发生在任何服务器请求之前：若被调用即说明隔离失效
    def _forbidden_cloud_call(*a, **kw):
        raise AssertionError("跨档登录不得请求授权服务器")

    monkeypatch.setattr(cloud, "login", _forbidden_cloud_call)
    monkeypatch.setattr(cloud, "register", _forbidden_cloud_call)

    yield SimpleNamespace(
        client=TestClient(app),
        settings=settings,
        tmp_path=tmp_path,
        session_factory=testing_session,
        monkeypatch=monkeypatch,
    )


# ----------------------------------------------------------------- 登录跨档

def test_cross_profile_login_short_circuits_without_touching_current_db(switch_env):
    resp = switch_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "shared", "remember": True},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["restart_required"] is True
    assert data["mode"] == "shared"
    assert "access_token" not in data

    # 当前档数据库不得产生镜像账号
    db = switch_env.session_factory()
    try:
        assert db.query(User).filter(User.username == "alice").first() is None
    finally:
        db.close()

    # 目标档已记账，供 launcher 重启选档
    marker = json.loads((switch_env.tmp_path / "active_profile.json").read_text("utf-8"))
    assert marker["mode"] == "shared"
    # 一次性凭据已加密落盘（非明文）
    assert (switch_env.tmp_path / "pending_login.json").is_file()


def test_same_profile_login_is_not_short_circuited(switch_env):
    """同档请求不返回 restart_required（继续走正常登录；网络失败按错误返回而非短路）。"""
    from app.services.desktop_cloud_client import CloudError

    def _cloud_unavailable(*a, **kw):
        raise CloudError(0, "网络不可达")

    switch_env.monkeypatch.setattr(
        "app.services.desktop_cloud_client.login", _cloud_unavailable
    )
    resp = switch_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "standalone"},
    )
    # 同档走真实登录链路：网络不可达是 5xx，且绝不会带重启标记
    assert resp.status_code >= 400
    assert "restart_required" not in (resp.json().get("data") or {})


# ----------------------------------------------------------------- 注册跨档

def test_cross_profile_register_short_circuits_before_server_call(switch_env):
    resp = switch_env.client.post(
        "/api/v1/desktop/register",
        json={
            "username": "newbie",
            "password": "pwd123",
            "confirm_password": "pwd123",
            "city": "广州",
            "operator": "移动",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["restart_required"] is True
    assert data["mode"] == "shared"

    # 当前档无账号写入
    db = switch_env.session_factory()
    try:
        assert db.query(User).filter(User.username == "newbie").first() is None
    finally:
        db.close()

    # 切到目标档后消费，凭据含注册所需全部字段
    switch_env.monkeypatch.setattr(switch_env.settings, "DESKTOP_PROFILE", "shared")
    pending = switch_env.client.get("/api/v1/desktop/pending-login").json()["data"]
    assert pending["kind"] == "register"
    assert pending["username"] == "newbie"
    assert pending["city"] == "广州" and pending["operator"] == "移动"


# ------------------------------------------------------------- 凭据一次性

def test_pending_login_consumed_once_and_requires_matching_profile(switch_env):
    """跨档凭据：档不匹配时**保留**、匹配时消费一次。

    回归背景：旧实现在 finally 里无条件删除凭据（而档匹配校验在删除之后），
    导致旧进程/重复读取把凭据提前销毁 → 重启后的新进程取不到凭据 →
    退回用"记住的旧模式"自动登录 → 再次判定跨档 → 二次重启弹窗。
    """
    # standalone 档请求共享登录
    resp = switch_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "bob", "password": "secret", "mode": "shared"},
    )
    assert resp.json()["data"]["restart_required"] is True

    # 仍在原档消费：档不匹配 → 返回 null，但凭据必须**保留**（重启后新档还要用）
    pending = switch_env.client.get("/api/v1/desktop/pending-login").json()["data"]
    assert pending is None
    assert (switch_env.tmp_path / "pending_login.json").exists()

    # 切到正确档后直接消费同一个凭据（不需要重新发起切换请求）
    switch_env.monkeypatch.setattr(switch_env.settings, "DESKTOP_PROFILE", "shared")
    pending = switch_env.client.get("/api/v1/desktop/pending-login").json()["data"]
    assert pending == {
        "kind": "login",
        "username": "bob",
        "password": "secret",
        "mode": "shared",
        "remember": True,
    }
    # 读后即删：第二次消费为空
    assert switch_env.client.get("/api/v1/desktop/pending-login").json()["data"] is None


def test_pending_login_absent_returns_null(switch_env):
    assert switch_env.client.get("/api/v1/desktop/pending-login").json()["data"] is None


# --------------------------------------------------- 当前运行档（登录页据此自动登录）

def test_profile_endpoint_returns_running_profile(switch_env):
    """登录页必须按**实际运行档**预填与自动登录。

    回归背景：跨档重启后「记住的 mode」是切换前的旧值，照它登录会再次被
    判定为跨档 → 二次重启弹窗。前端改为读这个接口。
    """
    assert switch_env.client.get("/api/v1/desktop/profile").json()["data"] == {
        "profile": "standalone",
    }
    switch_env.monkeypatch.setattr(switch_env.settings, "DESKTOP_PROFILE", "shared")
    assert switch_env.client.get("/api/v1/desktop/profile").json()["data"] == {
        "profile": "shared",
    }


# ----------------------------------------------------------------- 重启端点

def test_restart_unsupported_off_windows(switch_env, monkeypatch):
    # 测试环境为 Linux：脚本拉起不支持，返回 false 供前端提示手动重启
    import os as _os

    monkeypatch.setattr(_os, "name", "posix")
    resp = switch_env.client.post("/api/v1/desktop/restart")
    assert resp.status_code == 200
    assert resp.json()["data"]["restart_supported"] is False


def test_pending_login_endpoint_404_outside_desktop(switch_env, monkeypatch):
    monkeypatch.setattr(switch_env.settings, "NPT_DESKTOP", False)
    assert switch_env.client.get("/api/v1/desktop/pending-login").status_code == 404
    assert switch_env.client.post("/api/v1/desktop/restart").status_code == 404


# ------------------------------------------------- 重启脚本环境净化与取消回滚

def test_relaunch_helper_clears_inherited_profile_env(tmp_path):
    """重启脚本必须清掉继承的 NPT_DESKTOP_PROFILE：否则新进程沿用旧档变量，
    不读 active_profile.json，重启后仍进入旧数据空间（本次用户报障根因）。"""
    from app.core.desktop_profiles import write_relaunch_helper

    helper = write_relaunch_helper(tmp_path)
    content = helper.read_text(encoding="ascii")
    assert 'set "NPT_DESKTOP_PROFILE="' in content


def test_spawn_relaunch_marks_switching_for_splash(monkeypatch, tmp_path):
    """模式切换重启要给新进程打上 NPT_DESKTOP_SWITCHING=1：启动器据此把
    过渡页显示为「正在切换运行模式」，用户不会把重启误判为崩溃/更新失败。"""
    import os as _os

    from app.core import desktop_profiles

    captured: dict = {}

    def fake_popen(*args, **kwargs):
        captured["env"] = kwargs.get("env") or {}
        return SimpleNamespace(pid=0)

    # 只替换模块内引用的 os（不 patch 全局 os.name，避免 pathlib 走到 WindowsPath）
    class _FakeOs:
        name = "nt"
        environ = _os.environ

    monkeypatch.setattr(desktop_profiles, "os", _FakeOs)
    monkeypatch.setattr(desktop_profiles.subprocess, "Popen", fake_popen)
    assert desktop_profiles.spawn_relaunch(tmp_path) is True
    assert captured["env"].get("NPT_DESKTOP_SWITCHING") == "1"
    # 选档变量仍要清掉：新进程必须从 active_profile.json 选目标档
    assert "NPT_DESKTOP_PROFILE" not in captured["env"]


def test_switch_cancel_restores_active_profile_and_discards_pending(switch_env):
    # 先制造一次跨档切换：standalone 档请求共享登录
    resp = switch_env.client.post(
        "/api/v1/desktop/login",
        json={"username": "alice", "password": "pwd123", "mode": "shared"},
    )
    assert resp.json()["data"]["restart_required"] is True
    assert (switch_env.tmp_path / "pending_login.json").is_file()
    marker = json.loads((switch_env.tmp_path / "active_profile.json").read_text("utf-8"))
    assert marker["mode"] == "shared"

    # 用户在确认弹窗取消：标记恢复为当前运行档，一次性凭据销毁
    resp = switch_env.client.post("/api/v1/desktop/switch-cancel")
    assert resp.status_code == 200
    assert resp.json()["data"]["cancelled"] is True
    assert resp.json()["data"]["mode"] == "standalone"
    marker = json.loads((switch_env.tmp_path / "active_profile.json").read_text("utf-8"))
    assert marker["mode"] == "standalone"
    assert not (switch_env.tmp_path / "pending_login.json").exists()


def test_switch_cancel_404_outside_desktop(switch_env, monkeypatch):
    monkeypatch.setattr(switch_env.settings, "NPT_DESKTOP", False)
    assert switch_env.client.post("/api/v1/desktop/switch-cancel").status_code == 404
