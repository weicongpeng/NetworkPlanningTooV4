"""签发离线授权文件 .nptlic（厂商侧工具，不随安装包分发）。

用法示例：
    python desktop/tools/gen_license.py --licensee "某某公司" \
        --machine-code A1B2-C3D4-E5F6-7890 --expire 2027-12-31

    # 应急/测试：不限机器，有效期一年
    python desktop/tools/gen_license.py --licensee "测试" --machine-code "*" --days 365

流程：客户在「许可证」页复制机器码 → 厂商用本工具签发 → 客户导入 .nptlic 激活。
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from cryptography.hazmat.primitives import serialization

DEFAULT_KEY = Path(__file__).resolve().parent / "keys" / "license_private_key.pem"


def canonical_payload(payload: dict) -> bytes:
    return json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def normalize_machine_code(value: str) -> str:
    return (value or "").strip().upper().replace("-", "").replace(" ", "")


def main() -> int:
    parser = argparse.ArgumentParser(description="签发离线授权文件（.nptlic）")
    parser.add_argument("--licensee", required=True, help="客户/单位名称")
    parser.add_argument(
        "--machine-code", required=True, help='客户机器码（四位一组）；"*" 表示不限机器（应急用）'
    )
    parser.add_argument("--expire", help="到期日 YYYY-MM-DD")
    parser.add_argument("--days", type=int, help="自今天起 N 天有效（与 --expire 二选一）")
    parser.add_argument("--private-key", default=str(DEFAULT_KEY), help="私钥 PEM 路径")
    parser.add_argument("-o", "--out", help="输出文件路径（默认 <licensee>.nptlic）")
    args = parser.parse_args()

    if bool(args.expire) == bool(args.days):
        print("错误：必须且只能指定 --expire 或 --days 之一")
        return 1

    if args.days is not None:
        if args.days <= 0:
            print("错误：--days 必须为正整数")
            return 1
        expire = (date.today() + timedelta(days=args.days)).isoformat()
    else:
        expire = args.expire
        try:
            datetime.strptime(expire, "%Y-%m-%d")
        except ValueError:
            print(f"错误：到期日格式应为 YYYY-MM-DD，收到 {expire!r}")
            return 1

    machine = normalize_machine_code(args.machine_code)
    if machine != "*" and len(machine) != 16:
        print("错误：机器码应为 16 位十六进制（四位一组）；应急许可可用 --machine-code '*'")
        return 1
    machine_formatted = machine if machine == "*" else "-".join(
        machine[i : i + 4] for i in range(0, 16, 4)
    )

    key_path = Path(args.private_key)
    if not key_path.is_file():
        print(f"错误：私钥不存在 {key_path}（先运行 desktop/tools/gen_keypair.py）")
        return 1
    private_key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)

    payload = {
        "v": 1,
        "licensee": args.licensee.strip(),
        "machine_code": machine_formatted,
        "issued_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "expire_date": expire,
        "features": ["all"],
    }
    signature = private_key.sign(canonical_payload(payload))
    package = {
        "payload": payload,
        "sig": base64.b64encode(signature).decode("ascii"),
    }
    content = base64.b64encode(
        json.dumps(package, ensure_ascii=False).encode("utf-8")
    ).decode("ascii")

    out_path = Path(args.out) if args.out else Path.cwd() / f"{args.licensee.strip()}.nptlic"
    out_path.write_text(content, encoding="utf-8")
    print(f"授权文件已生成：{out_path}")
    print(f"  被授权方: {payload['licensee']}")
    print(f"  机器码:   {machine_formatted}")
    print(f"  有效期至: {expire}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
