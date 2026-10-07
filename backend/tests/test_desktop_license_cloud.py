"""桌面版在线授权（服务端）单元测试：激活码生命周期 / 绑定换机 / 续期 / 禁用 / 申请批准。"""
from __future__ import annotations

import base64
import json
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
from app.core.security import get_current_admin_user
from app.models.database import Base

MACHINE_A = "AAAA-BBBB-CCCC-DDDD"
MACHINE_B = "1111-2222-3333-4444"


@pytest.fixture()
def cloud_env(tmp_path, monkeypatch):
    """临时 SQLite + 临时 Ed25519 密钥对 + 最小 FastAPI 应用。"""
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
    monkeypatch.setattr(settings, "NPT_DESKTOP_ACTIVATION_MODE", "precreate")
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

    client = TestClient(app)
    yield SimpleNamespace(
        client=client,
        session_factory=TestingSession,
        private_key=private_key,
        public_hex=public_hex,
        settings=settings,
        monkeypatch=monkeypatch,
    )


def _create(client, name="张三", lease_days=30) -> dict:
    resp = client.post(
        "/api/v1/desktop-licenses",
        json={"licensee_username": name, "organization": "某市网优中心", "lease_days": lease_days},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def _activate(client, code, machine=MACHINE_A) -> dict:
    return client.post(
        "/api/v1/desktop-cloud/license/activate",
        json={"activation_code": code, "machine_code": machine, "hostname": "PC-01"},
    )


def _license_payload(cloud_env, license_file: str) -> dict:
    from app.services.desktop_signing import verify_license

    return verify_license(license_file)


def test_create_and_activate(cloud_env):
    record = _create(cloud_env.client)
    assert record["activation_code"].startswith("NPT-")
    assert len(record["activation_code"]) == len("NPT-XXXX-XXXX-XXXX-XXXX")
    assert record["status"] == "issued"

    resp = _activate(cloud_env.client, record["activation_code"])
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["machine_code"] == MACHINE_A
    assert data["lease_days"] == 30
    assert 29 <= data["remaining_days"] <= 30

    payload = _license_payload(cloud_env, data["license_file"])
    assert payload["license_id"] == record["id"]
    assert payload["subject"] == "张三"
    assert payload["machine_code"] == MACHINE_A
    assert payload["issued_via"] == "online"
    expire = datetime.strptime(payload["expire_date"], "%Y-%m-%d").date()
    assert 29 <= (expire - date.today()).days <= 31

    # 激活码输入容错：小写 + 无分隔符
    resp2 = _activate(cloud_env.client, record["activation_code"].replace("-", "").lower())
    assert resp2.status_code == 200


def test_activation_code_invalid_and_format(cloud_env):
    resp = _activate(cloud_env.client, "NPT-XXXX-XXXX-XXXX-XXXX")
    assert resp.status_code == 404
    resp = _activate(cloud_env.client, "not-a-code")
    assert resp.status_code == 400


def test_machine_mismatch_conflicts(cloud_env):
    record = _create(cloud_env.client)
    assert _activate(cloud_env.client, record["activation_code"]).status_code == 200
    resp = _activate(cloud_env.client, record["activation_code"], machine=MACHINE_B)
    assert resp.status_code == 409


def test_renew_extends_and_tamper_rejected(cloud_env):
    record = _create(cloud_env.client)
    license_file = _activate(cloud_env.client, record["activation_code"]).json()["data"]["license_file"]

    resp = cloud_env.client.post(
        "/api/v1/desktop-cloud/license/renew",
        json={"license_file": license_file, "machine_code": MACHINE_A},
    )
    assert resp.status_code == 200, resp.text
    renewed = resp.json()["data"]
    assert renewed["license_file"] != license_file
    old_payload = _license_payload(cloud_env, license_file)
    new_payload = _license_payload(cloud_env, renewed["license_file"])
    assert new_payload["expire_date"] >= old_payload["expire_date"]
    assert new_payload["renew_count"] == 1

    # 管理端可见续期次数
    listing = cloud_env.client.get("/api/v1/desktop-licenses").json()["data"]
    assert listing["items"][0]["renewal_count"] == 1

    # 篡改：改 payload 但保留旧签名
    package = json.loads(base64.b64decode(license_file))
    package["payload"]["expire_date"] = "2099-01-01"
    tampered = base64.b64encode(json.dumps(package).encode()).decode()
    resp = cloud_env.client.post(
        "/api/v1/desktop-cloud/license/renew",
        json={"license_file": tampered, "machine_code": MACHINE_A},
    )
    assert resp.status_code == 400

    # 离线许可（无 license_id）不能在线续期
    from app.services.desktop_signing import sign_license

    offline = sign_license(
        {"v": 1, "machine_code": MACHINE_A, "expire_date": "2099-01-01", "licensee": "离线"}
    )
    resp = cloud_env.client.post(
        "/api/v1/desktop-cloud/license/renew",
        json={"license_file": offline, "machine_code": MACHINE_A},
    )
    assert resp.status_code == 400


def test_update_lease_refreshes_expire_date(cloud_env):
    """编辑租约后到期日期立即按新租约重算（列表不再停留在旧值）。"""
    record = _create(cloud_env.client, lease_days=30)
    activated = _activate(cloud_env.client, record["activation_code"]).json()["data"]
    old_expire = datetime.strptime(activated["expire_date"], "%Y-%m-%d").date()
    assert 29 <= (old_expire - date.today()).days <= 31

    resp = cloud_env.client.put(
        f"/api/v1/desktop-licenses/{record['id']}", json={"lease_days": 90}
    )
    assert resp.status_code == 200, resp.text
    updated = resp.json()["data"]
    assert updated["lease_days"] == 90
    new_expire = datetime.strptime(updated["expire_date"], "%Y-%m-%d").date()
    assert 89 <= (new_expire - date.today()).days <= 91

    # 租约不变（只改备注）不应重签到未来：把库里的到期日改成过去值验证不被覆盖
    from app.models.database import DesktopLicense

    db = cloud_env.session_factory()
    try:
        row = db.query(DesktopLicense).filter(DesktopLicense.id == record["id"]).first()
        row.expire_date = "2000-01-01"
        db.commit()
    finally:
        db.close()
    resp = cloud_env.client.put(
        f"/api/v1/desktop-licenses/{record['id']}",
        json={"lease_days": 90, "note": "只改备注"},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["expire_date"] == "2000-01-01"


def test_disable_blocks_activate_and_renew(cloud_env):
    record = _create(cloud_env.client)
    license_file = _activate(cloud_env.client, record["activation_code"]).json()["data"]["license_file"]

    assert (
        cloud_env.client.post(f"/api/v1/desktop-licenses/{record['id']}/disable").status_code == 200
    )
    resp = _activate(cloud_env.client, record["activation_code"])
    assert resp.status_code == 403
    resp = cloud_env.client.post(
        "/api/v1/desktop-cloud/license/renew",
        json={"license_file": license_file, "machine_code": MACHINE_A},
    )
    assert resp.status_code == 403

    # 恢复后可续期
    assert cloud_env.client.post(f"/api/v1/desktop-licenses/{record['id']}/enable").status_code == 200
    resp = cloud_env.client.post(
        "/api/v1/desktop-cloud/license/renew",
        json={"license_file": license_file, "machine_code": MACHINE_A},
    )
    assert resp.status_code == 200


def test_unbind_allows_new_machine(cloud_env):
    record = _create(cloud_env.client)
    assert _activate(cloud_env.client, record["activation_code"]).status_code == 200
    assert (
        cloud_env.client.post(f"/api/v1/desktop-licenses/{record['id']}/unbind").status_code == 200
    )
    resp = _activate(cloud_env.client, record["activation_code"], machine=MACHINE_B)
    assert resp.status_code == 200
    assert resp.json()["data"]["machine_code"] == MACHINE_B


def test_regenerate_code_and_delete(cloud_env):
    record = _create(cloud_env.client)
    resp = cloud_env.client.post(f"/api/v1/desktop-licenses/{record['id']}/regenerate-code")
    assert resp.status_code == 200
    new_code = resp.json()["data"]["activation_code"]
    assert new_code != record["activation_code"]
    assert _activate(cloud_env.client, record["activation_code"]).status_code == 404
    assert _activate(cloud_env.client, new_code).status_code == 200

    assert cloud_env.client.delete(f"/api/v1/desktop-licenses/{record['id']}").status_code == 200
    resp = cloud_env.client.get("/api/v1/desktop-licenses")
    assert resp.json()["data"]["total"] == 0


def test_approve_flow(cloud_env):
    cloud_env.monkeypatch.setattr(cloud_env.settings, "NPT_DESKTOP_ACTIVATION_MODE", "approve")
    resp = cloud_env.client.post(
        "/api/v1/desktop-cloud/license/apply",
        json={"machine_code": MACHINE_A, "applicant_name": "李四", "organization": "某单位"},
    )
    assert resp.status_code == 200, resp.text
    request = resp.json()["data"]
    assert request["status"] == "pending"

    # 待批准时用申请接口是幂等的
    again = cloud_env.client.post(
        "/api/v1/desktop-cloud/license/apply",
        json={"machine_code": MACHINE_A, "applicant_name": "李四"},
    )
    assert again.json()["data"]["request_id"] == request["request_id"]

    poll = cloud_env.client.get(
        f"/api/v1/desktop-cloud/license/apply/{request['request_id']}",
        params={"token": request["apply_token"]},
    )
    assert poll.json()["data"]["status"] == "pending"

    approve = cloud_env.client.post(f"/api/v1/desktop-licenses/{request['request_id']}/approve", json={})
    assert approve.status_code == 200, approve.text
    code = approve.json()["data"]["activation_code"]

    poll = cloud_env.client.get(
        f"/api/v1/desktop-cloud/license/apply/{request['request_id']}",
        params={"token": request["apply_token"]},
    )
    assert poll.json()["data"]["status"] == "issued"
    assert poll.json()["data"]["activation_code"] == code
    assert _activate(cloud_env.client, code).status_code == 200

    # 错误 token 不能读取
    bad = cloud_env.client.get(
        f"/api/v1/desktop-cloud/license/apply/{request['request_id']}", params={"token": "bad"}
    )
    assert bad.status_code == 404


def test_apply_rejected_when_precreate(cloud_env):
    resp = cloud_env.client.post(
        "/api/v1/desktop-cloud/license/apply",
        json={"machine_code": MACHINE_A, "applicant_name": "王五"},
    )
    assert resp.status_code == 403


def test_signing_not_configured(cloud_env, monkeypatch):
    record = _create(cloud_env.client)
    monkeypatch.delenv("NPT_LICENSE_PRIVATE_KEY", raising=False)
    from app.core.config import settings

    monkeypatch.setattr(settings, "NPT_LICENSE_PRIVATE_KEY", "")
    # 防止误读真实服务器私钥文件
    monkeypatch.setattr(settings, "LICENSE_DIR", settings.LICENSE_DIR / "__not_exists__")

    resp = _activate(cloud_env.client, record["activation_code"])
    assert resp.status_code == 503
    # 管理端列表仍可用（不影响其它接口）
    assert cloud_env.client.get("/api/v1/desktop-licenses").status_code == 200


def test_renew_requires_matching_machine(cloud_env):
    record = _create(cloud_env.client)
    license_file = _activate(cloud_env.client, record["activation_code"]).json()["data"]["license_file"]
    resp = cloud_env.client.post(
        "/api/v1/desktop-cloud/license/renew",
        json={"license_file": license_file, "machine_code": MACHINE_B},
    )
    assert resp.status_code == 409
