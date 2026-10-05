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
    for method, path in (
        ("get", "/api/v1/desktop/cloud-status"),
        ("post", "/api/v1/desktop/cloud-renew"),
        ("get", "/api/v1/desktop/cloud-apply"),
    ):
        resp = getattr(desktop_local.client, method)(path)
        assert resp.status_code == 404, (method, path, resp.status_code)


def test_offline_license_not_renewed_by_policy(desktop_local):
    from app.services import desktop_cloud_client as cloud

    assert cloud.should_renew({"valid": True, "issued_via": "offline", "remaining_days": 3}, {}) is False


def test_renewal_policy_by_remaining_days(desktop_local):
    from app.services import desktop_cloud_client as cloud

    info = {"valid": True, "issued_via": "online", "remaining_days": 5}
    assert cloud.should_renew(info, {}) is True
    info["remaining_days"] = 25
    assert cloud.should_renew(info, {"last_renew_at": "2026-01-01T00:00:00"}) is True  # 距上次超过 7 天
