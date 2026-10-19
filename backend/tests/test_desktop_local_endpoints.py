"""桌面版本机接口（在线激活/续期/申请）测试：真实许可校验 + 桩化云端调用。"""
from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.security import get_current_admin_user, get_current_user


@pytest.fixture()
def desktop_local(tmp_path, monkeypatch):
    from app.api.v1.endpoints import desktop_local as endpoint_module
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
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    monkeypatch.setenv("NPT_LICENSE_PUBLIC_KEY_HEX", public_hex)
    # 仅测试用：本用例需要现场"签发"许可（真实客户端不持有私钥）
    monkeypatch.setenv("NPT_LICENSE_PRIVATE_KEY", private_pem)
    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    monkeypatch.setattr(settings, "LICENSE_DIR", tmp_path)
    monkeypatch.setattr(settings, "NPT_SERVER_URL", "https://example.invalid")
    monkeypatch.setattr(settings, "NPT_DESKTOP_VERSION", "0.0.0-test")

    machine = get_machine_code()

    def make_license(days: int = 30, issued_via: str = "online") -> str:
        return sign_license(
            {
                "v": 1,
                "license_id": 7,
                "subject": "张三",
                "org": "某市网优中心",
                "licensee": "某市网优中心",
                "machine_code": machine,
                "lease_days": days,
                "renew_count": 1,
                "issued_via": issued_via,
                "issued_at": "2026-01-01 00:00:00",
                "expire_date": (date.today() + timedelta(days=days)).isoformat(),
                "features": ["all"],
            }
        )

    app = FastAPI()
    app.include_router(endpoint_module.router, prefix="/api/v1/desktop")
    admin = SimpleNamespace(username="admin", is_admin=True)
    app.dependency_overrides[get_current_user] = lambda: admin
    app.dependency_overrides[get_current_admin_user] = lambda: admin

    yield SimpleNamespace(
        client=TestClient(app),
        cloud=cloud,
        endpoint_module=endpoint_module,
        make_license=make_license,
        settings=settings,
        monkeypatch=monkeypatch,
        machine=machine,
    )


def test_activate_writes_license(desktop_local):
    license_file = desktop_local.make_license(30)
    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "activate",
        lambda code, hostname=None: {"license_file": license_file, "expire_date": "x"},
    )
    resp = desktop_local.client.post(
        "/api/v1/desktop/cloud-activate", json={"activation_code": "NPT-ABCD-EFGH-JKMN-PQRS"}
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["license"]["valid"] is True
    assert data["license"]["issued_via"] == "online"
    assert data["license"]["subject"] == "张三"
    assert 28 <= data["license"]["remaining_days"] <= 30
    assert (desktop_local.settings.LICENSE_DIR / "license.nptlic").is_file()


def test_app_version_uses_server_absolute_url(desktop_local):
    """桌面端不分发 APK：取服务器最新版本，且下载/二维码地址必须是服务器绝对地址。"""
    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "app_version",
        lambda: {
            "version": "1.2.0",
            "download_url": "/api/v1/app-versions/download/9",
            "file_size_display": "85.0 MB",
        },
    )
    resp = desktop_local.client.get("/api/v1/desktop/app-version")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["version"] == "1.2.0"
    assert data["download_url"] == "https://example.invalid/api/v1/app-versions/download/9"


def test_session_status_reports_kicked(desktop_local):
    """账号在别处登录后，本机登录态接口要报失效（前端据此退出到登录页）。"""
    desktop_local.monkeypatch.setattr(
        desktop_local.cloud, "session_check", lambda jti: {"valid": True}
    )
    resp = desktop_local.client.get("/api/v1/desktop/session-status")
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["valid"] is True

    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "session_check",
        lambda jti: {"valid": False, "reason": "该账号已在其它设备登录"},
    )
    desktop_local.cloud.save_state(session_jti="jti-1", local_jti="local-1")
    resp2 = desktop_local.client.get("/api/v1/desktop/session-status")
    assert resp2.json()["data"]["valid"] is False
    assert "其它设备" in (resp2.json()["data"].get("reason") or "")


def test_window_title_forwarded_to_shell(desktop_local):
    """窗口标题由前端拼好、后端只转发给桌面壳（用于标注运行模式 + 实时同步状态）。"""
    from app import desktop_bridge

    seen: list[str] = []
    desktop_bridge.set_title_handler(seen.append)
    try:
        resp = desktop_local.client.post(
            "/api/v1/desktop/window-title", json={"title": "网优引擎 - 共享模式 · 已同步 11:28"}
        )
        assert resp.status_code == 200, resp.text
        assert seen == ["网优引擎 - 共享模式 · 已同步 11:28"]
    finally:
        desktop_bridge.set_title_handler(None)


def test_window_title_without_shell_returns_403(desktop_local):
    """非桌面壳（未注入回调）必须 403，网页端据此静默忽略。"""
    from app import desktop_bridge

    desktop_bridge.set_title_handler(None)
    resp = desktop_local.client.post(
        "/api/v1/desktop/window-title", json={"title": "网优引擎 - 单机模式"}
    )
    assert resp.status_code == 403


def test_window_title_rejects_blank(desktop_local):
    from app import desktop_bridge

    desktop_bridge.set_title_handler(lambda _t: None)
    try:
        resp = desktop_local.client.post("/api/v1/desktop/window-title", json={"title": "   "})
        assert resp.status_code == 400
    finally:
        desktop_bridge.set_title_handler(None)


def test_fullscreen_forwarded_to_shell(desktop_local):
    """地图「全屏」由桌面壳把主窗口切成系统级全屏（WebView2 的 HTML Fullscreen 占不满屏幕）。"""
    from app import desktop_bridge

    seen: list[bool] = []
    desktop_bridge.set_fullscreen_handler(seen.append)
    try:
        enter = desktop_local.client.post("/api/v1/desktop/fullscreen", json={"fullscreen": True})
        assert enter.status_code == 200, enter.text
        assert enter.json()["data"]["fullscreen"] is True

        leave = desktop_local.client.post("/api/v1/desktop/fullscreen", json={"fullscreen": False})
        assert leave.status_code == 200, leave.text
        assert seen == [True, False]
    finally:
        desktop_bridge.set_fullscreen_handler(None)


def test_fullscreen_without_shell_returns_403(desktop_local):
    """非桌面壳必须 403：前端据此回退浏览器 Fullscreen API。"""
    from app import desktop_bridge

    desktop_bridge.set_fullscreen_handler(None)
    resp = desktop_local.client.post("/api/v1/desktop/fullscreen", json={"fullscreen": True})
    assert resp.status_code == 403


def test_activate_error_maps_status(desktop_local):
    def boom(code, hostname=None):
        raise desktop_local.cloud.CloudError(403, "该授权已被禁用，请联系管理员")

    desktop_local.monkeypatch.setattr(desktop_local.cloud, "activate", boom)
    resp = desktop_local.client.post(
        "/api/v1/desktop/cloud-activate", json={"activation_code": "NPT-XXXX-XXXX-XXXX-XXXX"}
    )
    assert resp.status_code == 403
    assert "禁用" in resp.json()["detail"]


def test_cloud_unreachable_maps_502(desktop_local):
    def boom(code, hostname=None):
        raise desktop_local.cloud.CloudError(0, "无法连接授权服务器")

    desktop_local.monkeypatch.setattr(desktop_local.cloud, "activate", boom)
    resp = desktop_local.client.post(
        "/api/v1/desktop/cloud-activate", json={"activation_code": "NPT-XXXX-XXXX-XXXX-XXXX"}
    )
    assert resp.status_code == 502


def test_renew_updates_license(desktop_local):
    # 先激活
    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "activate",
        lambda code, hostname=None: {"license_file": desktop_local.make_license(5)},
    )
    desktop_local.client.post(
        "/api/v1/desktop/cloud-activate", json={"activation_code": "NPT-ABCD-EFGH-JKMN-PQRS"}
    )

    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "renew_remote",
        lambda license_file, **kwargs: {
            "license_file": desktop_local.make_license(30),
            "expire_date": "future",
        },
    )
    resp = desktop_local.client.post("/api/v1/desktop/cloud-renew")
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["license"]["remaining_days"] >= 29


def test_apply_poll_auto_activates(desktop_local):
    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "apply_license",
        lambda name, org=None, note=None: {"request_id": 11, "status": "pending"},
    )
    resp = desktop_local.client.post(
        "/api/v1/desktop/cloud-apply", json={"applicant_name": "李四", "organization": "某单位"}
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "pending"

    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "poll_apply",
        lambda: {"status": "issued", "activation_code": "NPT-ABCD-EFGH-JKMN-PQRS"},
    )
    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "activate",
        lambda code, hostname=None: {"license_file": desktop_local.make_license(30)},
    )
    resp = desktop_local.client.get("/api/v1/desktop/cloud-apply")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["activated"] is True
    assert data["status_detail"]["license"]["valid"] is True


def test_status_without_license(desktop_local):
    resp = desktop_local.client.get("/api/v1/desktop/cloud-status")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["desktop"] is True
    assert data["machine_code"] == desktop_local.machine
    assert data["license"] is None


def test_endpoints_404_outside_desktop(desktop_local):
    desktop_local.monkeypatch.setattr(desktop_local.settings, "NPT_DESKTOP", False)
    for method, path, payload in (
        ("get", "/api/v1/desktop/cloud-status", None),
        ("post", "/api/v1/desktop/cloud-renew", None),
        ("get", "/api/v1/desktop/cloud-apply", None),
        ("post", "/api/v1/desktop/fullscreen", {"fullscreen": True}),
    ):
        call = getattr(desktop_local.client, method)
        resp = call(path, json=payload) if payload is not None else call(path)
        assert resp.status_code == 404, (method, path, resp.status_code)


def test_offline_license_not_renewed_by_policy(desktop_local):
    from app.services import desktop_cloud_client as cloud

    assert cloud.should_renew({"valid": True, "issued_via": "offline", "remaining_days": 3}, {}) is False
    # 离线导入许可没有在线记录：即使已过期也不能续期
    assert cloud.should_renew({"valid": False, "issued_via": "offline"}, {}) is False


def test_expired_online_license_renewed_by_policy(desktop_local):
    """过期的在线许可仍要尝试续期：联网后服务器重签，客户端无需重登即可恢复。"""
    from app.services import desktop_cloud_client as cloud

    assert cloud.should_renew({"valid": False, "issued_via": "online"}, {}) is True


def test_renewal_policy_by_remaining_days(desktop_local):
    from app.services import desktop_cloud_client as cloud

    info = {"valid": True, "issued_via": "online", "remaining_days": 5}
    assert cloud.should_renew(info, {}) is True
    info["remaining_days"] = 25
    assert cloud.should_renew(info, {"last_renew_at": "2026-01-01T00:00:00"}) is True  # 距上次超过 7 天
