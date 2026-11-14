"""桌面共享模式的 IM 请求代理（本机后端 → 线上服务器）。

桌面壳内前端 apiClient 的 /api/v1 只指向 127.0.0.1:18789，消息若只落本机
data.db 无法与其它用户通信。因此共享模式下把 IM 操作转发到线上 relay：
凭证按项目既有约定放在 JSON body 的 license_file / machine_code 字段中
（DESIGN: docs/协作沟通设计方案.md §2.3 —— 本项目没有自定义签名头）。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict

from fastapi import HTTPException

from app.core.config import settings
from app.services.desktop_cloud_client import CloudError, server_url


def is_shared_desktop() -> bool:
    """仅桌面共享模式走代理；单机模式不具备跨用户通信条件。"""
    return bool(settings.NPT_DESKTOP) and str(settings.DESKTOP_PROFILE or "") == "shared"


def _credentials() -> Dict[str, str]:
    from app.utils.machine_code import get_machine_code

    # 复用与数据同步完全相同的许可读取路径，避免两套激活状态
    from app.services.desktop_cloud_client import _license_file_text

    return {"license_file": _license_file_text(), "machine_code": get_machine_code()}


def forward(op: str, args: Dict[str, Any], timeout: int = 30) -> Any:
    """把白名单 op 转发到线上 relay，返回对端 data 字段。"""
    try:
        payload = _credentials()
    except CloudError as exc:
        raise HTTPException(status_code=502, detail=f"IM_RELAY_FAILED: {exc.message}")

    payload.update({"op": op, "args": args or {}})
    base = server_url()
    if not base:
        raise HTTPException(status_code=502, detail="IM_RELAY_FAILED: 未配置服务器地址")

    request = urllib.request.Request(
        f"{base}/api/v1/desktop-cloud/im/relay",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "NPT-Desktop"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.load(response)
    except urllib.error.HTTPError as exc:
        detail = "IM_RELAY_FAILED"
        try:
            parsed = json.loads(exc.read().decode("utf-8", "replace"))
            detail = str(parsed.get("detail") or detail)
        except Exception:  # noqa: BLE001
            pass
        raise HTTPException(status_code=exc.code if 400 <= exc.code < 500 else 502,
                            detail=detail)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(status_code=502, detail=f"IM_RELAY_FAILED: {exc}")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"IM_RELAY_FAILED: {exc}")

    if not body.get("success", True):
        raise HTTPException(status_code=502, detail=body.get("detail") or "IM_RELAY_FAILED")
    return body.get("data")
