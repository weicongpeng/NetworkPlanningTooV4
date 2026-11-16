"""桌面共享模式的 IM 请求代理（本机后端 → 线上服务器）。

桌面壳内前端 apiClient 的 /api/v1 只指向 127.0.0.1:18789，消息若只落本机
data.db 无法与其它用户通信。因此共享模式下把 IM 操作转发到线上 relay：
凭证按项目既有约定放在 JSON body 的 license_file / machine_code 字段中
（DESIGN: docs/协作沟通设计方案.md §2.3 —— 本项目没有自定义签名头）。
"""
from __future__ import annotations

import threading
from typing import Any, Dict, Optional

import httpx
from fastapi import HTTPException

from app.core.config import settings
from app.services.desktop_cloud_client import CloudError, server_url

# IM 是交互路径：宁可快速失败让前端退避/降级，也不能让一次慢 relay 占住
# anyio 线程池里的工作线程 30s（桌面共享模式高频轮询会叠加打满线程池）。
RELAY_TIMEOUT_SECONDS = 12.0
_client_lock = threading.Lock()
_http_client: Optional[httpx.Client] = None


def _get_client() -> httpx.Client:
    """进程内复用一个带连接池的同步客户端（httpx.Client 线程安全）。

    保持「同步端点 → 同步 HTTP」的调用链一致：不把 async 客户端塞进 def 端点，
    同步 SQLAlchemy Session 也无需跨协程复用。连接复用省掉每次 TLS 握手。
    """
    global _http_client
    with _client_lock:
        if _http_client is None or _http_client.is_closed:
            _http_client = httpx.Client(
                timeout=httpx.Timeout(RELAY_TIMEOUT_SECONDS, connect=5.0),
                limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
                headers={"User-Agent": "NPT-Desktop"},
            )
        return _http_client


def is_shared_desktop() -> bool:
    """仅桌面共享模式走代理；单机模式不具备跨用户通信条件。"""
    return bool(settings.NPT_DESKTOP) and str(settings.DESKTOP_PROFILE or "") == "shared"


def _credentials() -> Dict[str, str]:
    from app.utils.machine_code import get_machine_code

    # 复用与数据同步完全相同的许可读取路径，避免两套激活状态
    from app.services.desktop_cloud_client import _license_file_text

    return {"license_file": _license_file_text(), "machine_code": get_machine_code()}


def forward(op: str, args: Dict[str, Any],
            timeout: float = RELAY_TIMEOUT_SECONDS) -> Any:
    """把白名单 op 转发到线上 relay，返回对端 data 字段。

    连接池 + 12s 短超时 + 一次有限重试（仅网络抖动 / 5xx），4xx 立即透传不重试。
    """
    try:
        payload = _credentials()
    except CloudError as exc:
        raise HTTPException(status_code=502, detail=f"IM_RELAY_FAILED: {exc.message}")

    payload.update({"op": op, "args": args or {}})
    base = server_url()
    if not base:
        raise HTTPException(status_code=502, detail="IM_RELAY_FAILED: 未配置服务器地址")
    url = f"{base}/api/v1/desktop-cloud/im/relay"
    client = _get_client()

    response = None
    last_error: Any = None
    for attempt in range(2):
        try:
            candidate = client.post(url, json=payload, timeout=timeout)
            # 云端 502/503/504 抖动很常见（Cloudflare Tunnel），重试一次；
            # 4xx 是业务错误，重试只会放大负载。
            if candidate.status_code >= 500 and attempt == 0:
                last_error = f"HTTP {candidate.status_code}"
                continue
            response = candidate
            break
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            last_error = exc
            if attempt == 0:
                continue
    if response is None:
        raise HTTPException(status_code=502, detail=f"IM_RELAY_FAILED: {last_error}")

    if response.status_code >= 400:
        detail = "IM_RELAY_FAILED"
        try:
            parsed = response.json()
            detail = str(parsed.get("detail") or detail)
        except Exception:  # noqa: BLE001
            pass
        raise HTTPException(
            status_code=response.status_code if 400 <= response.status_code < 500 else 502,
            detail=detail,
        )
    try:
        body = response.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"IM_RELAY_FAILED: {exc}")
    if not body.get("success", True):
        raise HTTPException(status_code=502, detail=body.get("detail") or "IM_RELAY_FAILED")
    return body.get("data")
