"""桌面离线授权（Ed25519 签名 + 机器码绑定）单元测试。"""
from __future__ import annotations

import base64
import json
from datetime import date, datetime, timedelta

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def _canonical(payload: dict) -> bytes:
    return json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def _issue(private_key: Ed25519PrivateKey, payload: dict) -> str:
    signature = private_key.sign(_canonical(payload))
    package = {"payload": payload, "sig": base64.b64encode(signature).decode("ascii")}
    return base64.b64encode(json.dumps(package, ensure_ascii=False).encode("utf-8")).decode(
        "ascii"
    )


def _payload(machine_code: str, expire_days: int = 30) -> dict:
    return {
        "v": 1,
        "licensee": "测试单位",
        "machine_code": machine_code,
        "issued_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "expire_date": (date.today() + timedelta(days=expire_days)).isoformat(),
        "features": ["all"],
    }


@pytest.fixture()
def desktop_license(tmp_path, monkeypatch):
    """桌面模式 + 临时授权目录 + 临时密钥对；屏蔽 admin 镜像写库。"""
    from app.core.config import settings
    from app.services.license_service import license_service
    from app.utils.machine_code import get_machine_code

    private_key = Ed25519PrivateKey.generate()
    public_hex = (
        private_key.public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        .hex()
    )

    monkeypatch.setenv("NPT_LICENSE_PUBLIC_KEY_HEX", public_hex)
    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    monkeypatch.setattr(settings, "LICENSE_DIR", tmp_path)
    monkeypatch.setattr(
        license_service, "_mirror_desktop_license_expiry", lambda expire_date: None
    )
    return {"private_key": private_key, "service": license_service, "machine": get_machine_code()}


def test_no_license_is_invalid(desktop_license):
    status = desktop_license["service"].get_status()
    assert status.valid is False
    assert "未激活" in (status.errorMessage or "")


def test_valid_license_activates_and_reports(desktop_license):
    service = desktop_license["service"]
    raw = _issue(desktop_license["private_key"], _payload(desktop_license["machine"], 30))

    ok, message = service.activate(raw)
    assert ok is True, message

    status = service.get_status()
    assert status.valid is True
    assert status.version == "desktop"
    assert status.licensee == "测试单位"
    assert 28 <= status.remainingDays <= 30


def test_wildcard_machine_code_allowed(desktop_license):
    service = desktop_license["service"]
    raw = _issue(desktop_license["private_key"], _payload("*", 10))
    ok, message = service.activate(raw)
    assert ok is True, message
    assert service.get_status().valid is True


def test_wrong_machine_code_rejected(desktop_license):
    service = desktop_license["service"]
    raw = _issue(desktop_license["private_key"], _payload("AAAA-BBBB-CCCC-DDDD", 30))
    ok, message = service.activate(raw)
    assert ok is False
    assert "机器码" in message
    assert service.get_status().valid is False


def test_expired_license_rejected(desktop_license):
    service = desktop_license["service"]
    raw = _issue(desktop_license["private_key"], _payload(desktop_license["machine"], -1))
    ok, message = service.activate(raw)
    assert ok is False
    assert "过期" in message


def test_tampered_signature_rejected(desktop_license):
    service = desktop_license["service"]
    payload = _payload(desktop_license["machine"], 30)
    # 篡改 payload 后再套用原签名
    signature = desktop_license["private_key"].sign(_canonical(payload))
    payload["expire_date"] = (date.today() + timedelta(days=3650)).isoformat()
    package = {"payload": payload, "sig": base64.b64encode(signature).decode("ascii")}
    tampered = base64.b64encode(
        json.dumps(package, ensure_ascii=False).encode("utf-8")
    ).decode("ascii")

    ok, message = service.activate(tampered)
    assert ok is False
    assert "签名" in message


def test_unknown_public_key_config_rejects(desktop_license, monkeypatch):
    """未配置公钥（开发构建）时应明确拒绝而不是放行。"""
    service = desktop_license["service"]
    raw = _issue(desktop_license["private_key"], _payload(desktop_license["machine"], 30))
    monkeypatch.setenv("NPT_LICENSE_PUBLIC_KEY_HEX", "")
    monkeypatch.setattr("app.services.license_service.PUBLIC_KEY_HEX", "")

    ok, message = service.activate(raw)
    assert ok is False
    assert "公钥" in message


def test_desktop_expiry_unauthorized_when_no_license(desktop_license):
    """未激活时前端门禁必须拿到过去日期（null 会被前端当作无限期已授权）。"""
    expiry = desktop_license["service"].desktop_expiry_datetime()
    assert expiry is not None
    assert expiry.year == 1970


def test_desktop_expiry_follows_valid_license(desktop_license):
    service = desktop_license["service"]
    raw = _issue(desktop_license["private_key"], _payload(desktop_license["machine"], 30))
    assert service.activate(raw)[0] is True

    expiry = service.desktop_expiry_datetime()
    assert expiry is not None
    assert 28 <= (expiry - datetime.now()).days <= 30


def test_desktop_expiry_unauthorized_when_tampered(desktop_license):
    service = desktop_license["service"]
    path = service._signed_license_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("not-a-valid-license", encoding="utf-8")

    expiry = service.desktop_expiry_datetime()
    assert expiry is not None
    assert expiry.year == 1970
