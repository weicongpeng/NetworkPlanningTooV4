"""桌面版在线授权的服务端签名（Ed25519）。

私钥来源（优先级）：
1. 环境变量 ``NPT_LICENSE_PRIVATE_KEY``（PEM 全文，或带 ``\\n`` 转义的单行）
2. ``settings.LICENSE_DIR/license_private_key.pem``（服务器部署默认位置，600 权限）

私钥只存在于服务端；客户端仅内置公钥（``app/core/license_public_key.py``）。
未配置私钥时抛出 :class:`SigningNotConfigured`，由端点转 503，
不影响其它接口（如 /license/status）。
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from app.core.config import settings


class SigningNotConfigured(RuntimeError):
    """服务端未配置签发私钥。"""


class LicenseInvalid(RuntimeError):
    """许可文件验签/解析失败。"""


def _load_private_key():
    from cryptography.hazmat.primitives import serialization

    pem: Optional[bytes] = None
    env_value = (os.environ.get("NPT_LICENSE_PRIVATE_KEY") or settings.NPT_LICENSE_PRIVATE_KEY or "").strip()
    if env_value:
        if "\\n" in env_value and "BEGIN" in env_value:
            env_value = env_value.replace("\\n", "\n")
        pem = env_value.encode("utf-8")
    else:
        key_file: Path = settings.LICENSE_DIR / "license_private_key.pem"
        if key_file.is_file():
            pem = key_file.read_bytes()

    if not pem:
        raise SigningNotConfigured(
            "服务端未配置签发私钥：请设置 NPT_LICENSE_PRIVATE_KEY 或放置 "
            f"{settings.LICENSE_DIR / 'license_private_key.pem'}"
        )
    try:
        return serialization.load_pem_private_key(pem, password=None)
    except Exception as exc:  # noqa: BLE001
        raise SigningNotConfigured(f"签发私钥无法解析: {exc}") from exc


def is_configured() -> bool:
    try:
        _load_private_key()
        return True
    except SigningNotConfigured:
        return False


def canonical_payload(payload: Dict[str, Any]) -> bytes:
    """与客户端/签发工具一致的规范化 JSON（排序键、紧凑分隔符、保留中文）。"""
    return json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def sign_license(payload: Dict[str, Any]) -> str:
    """对 payload 签名并返回 .nptlic 文件内容（base64(json{payload,sig})）。"""
    private_key = _load_private_key()
    signature = private_key.sign(canonical_payload(payload))
    package = {"payload": payload, "sig": base64.b64encode(signature).decode("ascii")}
    return base64.b64encode(
        json.dumps(package, ensure_ascii=False).encode("utf-8")
    ).decode("ascii")


def verify_license(license_text: str) -> Dict[str, Any]:
    """验签许可文件并返回 payload；失败抛 :class:`LicenseInvalid`。"""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    from app.core.license_public_key import PUBLIC_KEY_HEX

    hex_key = (os.environ.get("NPT_LICENSE_PUBLIC_KEY_HEX") or PUBLIC_KEY_HEX or "").strip()
    if not hex_key:
        raise LicenseInvalid("服务端未配置授权公钥，无法校验许可")

    try:
        package = json.loads(base64.b64decode(license_text.strip()).decode("utf-8"))
        payload = package["payload"]
        signature = base64.b64decode(package["sig"])
        if not isinstance(payload, dict):
            raise ValueError("payload 不是对象")
    except Exception as exc:  # noqa: BLE001
        raise LicenseInvalid("许可文件格式错误") from exc

    try:
        public_key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(hex_key))
        public_key.verify(signature, canonical_payload(payload))
    except Exception as exc:  # noqa: BLE001
        raise LicenseInvalid("许可文件签名校验失败") from exc
    return payload
