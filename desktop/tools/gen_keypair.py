"""生成 Ed25519 授权密钥对（厂商侧一次性执行，不随安装包分发）。

用法：
    python desktop/tools/gen_keypair.py            # 生成到 desktop/tools/keys/
    python desktop/tools/gen_keypair.py --force    # 覆盖已有私钥（危险，已签发授权将全部失效）

完成后：
1. 私钥 desktop/tools/keys/license_private_key.pem 离线备份，绝不入库/外发；
2. 把终端输出的公钥 hex 粘贴到 backend/app/core/license_public_key.py 的 PUBLIC_KEY_HEX。
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Windows 下重定向输出时 stdout 可能是 cp1252，避免中文 print 崩溃
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

KEYS_DIR = Path(__file__).resolve().parent / "keys"
PRIVATE_KEY_PATH = KEYS_DIR / "license_private_key.pem"


def main() -> int:
    parser = argparse.ArgumentParser(description="生成离线授权 Ed25519 密钥对")
    parser.add_argument("--force", action="store_true", help="覆盖已存在的私钥（谨慎）")
    args = parser.parse_args()

    if PRIVATE_KEY_PATH.exists() and not args.force:
        print(f"私钥已存在：{PRIVATE_KEY_PATH}")
        print("如需重新生成，请先备份后加 --force（重新生成会使已签发的授权全部失效）")
        return 1

    KEYS_DIR.mkdir(parents=True, exist_ok=True)
    private_key = Ed25519PrivateKey.generate()
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    PRIVATE_KEY_PATH.write_bytes(pem)
    try:
        os.chmod(PRIVATE_KEY_PATH, 0o600)
    except OSError:
        pass

    public_hex = (
        private_key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        .hex()
    )

    print(f"私钥已写入：{PRIVATE_KEY_PATH}（请离线备份，切勿提交/外发）")
    print("公钥 hex（粘贴到 backend/app/core/license_public_key.py 的 PUBLIC_KEY_HEX）：")
    print(public_hex)
    return 0


if __name__ == "__main__":
    sys.exit(main())
