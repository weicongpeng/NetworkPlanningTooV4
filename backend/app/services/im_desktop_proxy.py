"""桌面共享模式的 IM 请求代理（本机后端 → 线上服务器）。

桌面壳内前端 apiClient 的 /api/v1 只指向 127.0.0.1:18789，消息若只落本机
data.db 无法与其它用户通信。因此共享模式下把 IM 操作转发到线上 relay：
凭证按项目既有约定放在 JSON body 的 license_file / machine_code 字段中
（DESIGN: docs/协作沟通设计方案.md §2.3 —— 本项目没有自定义签名头）。
"""
from __future__ import annotations

import re
import threading
import urllib.parse
from typing import Any, Dict, Optional, Tuple

import httpx
from fastapi import HTTPException

from app.core.config import settings
from app.services.desktop_cloud_client import CloudError, server_url

# IM 是交互路径：宁可快速失败让前端退避/降级，也不能让一次慢 relay 占住
# anyio 线程池里的工作线程 30s（桌面共享模式高频轮询会叠加打满线程池）。
RELAY_TIMEOUT_SECONDS = 12.0
# 共享模式 IM 轮询是 1.5s 一次、且没有 in-flight 去重；网络抖动时单次 relay 最坏
# 12s×2。不限并发会把 anyio 的 40 个线程池 token 与浏览器 6 条 HTTP/1.1 连接全占住，
# 连「最小化/最大化」这种纯交互请求都要排几十秒。这里给 relay 一个硬上限，
# 抢不到名额立即 503（前端退避到下一轮），始终把连接/线程留给交互请求。
RELAY_MAX_CONCURRENT = 4
RELAY_SLOT_WAIT_SECONDS = 0.2
# 附件分片是「大 JSON + base64」，与 1.5s 轮询共用同一组槽会被偶发 503 打断，
# 用户看到「附件发送失败，已放回待发送列表」。拆成独立槽池 + 更长超时：
# 轮询再忙也抢不走上传名额，上传重试也不会拖慢消息/窗口控制。
RELAY_ATTACHMENT_TIMEOUT_SECONDS = 45.0
RELAY_ATTACHMENT_MAX_CONCURRENT = 4
_relay_slots = threading.BoundedSemaphore(RELAY_MAX_CONCURRENT)
_attachment_slots = threading.BoundedSemaphore(RELAY_ATTACHMENT_MAX_CONCURRENT)
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
            timeout: Optional[float] = None) -> Any:
    """把白名单 op 转发到线上 relay，返回对端 data 字段。

    并发上限是本函数最重要的职责：慢 relay 不能无限堆积占住线程池与浏览器连接，
    否则桌面端「项目沟通」打开后窗口控制按钮会失去响应（见 RELAY_MAX_CONCURRENT）。
    附件走独立槽池与更长超时，避免分片受轮询挤占而频繁失败。
    """
    is_attachment = op.startswith("attachment_")
    slots = _attachment_slots if is_attachment else _relay_slots
    effective_timeout = timeout or (
        RELAY_ATTACHMENT_TIMEOUT_SECONDS if is_attachment else RELAY_TIMEOUT_SECONDS
    )
    if not slots.acquire(timeout=RELAY_SLOT_WAIT_SECONDS):
        raise HTTPException(
            status_code=503,
            detail=f"IM_RELAY_BUSY:{op}: 消息服务繁忙，请稍后重试",
        )
    try:
        return _forward_unlocked(op, args, effective_timeout)
    finally:
        slots.release()


def _forward_unlocked(op: str, args: Dict[str, Any], timeout: float) -> Any:
    """连接池 + 12s 短超时 + 一次有限重试（仅网络抖动 / 5xx），4xx 立即透传不重试。"""
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


def fetch_signed_attachment(info: Dict[str, Any]) -> Tuple[bytes, str, str]:
    """用 relay 换来的短时签名直链下载图片字节（二进制，不占 relay 槽池）。

    与旧 ``attachment_download`` 的区别：不再把整张图片 base64 塞进 JSON 响应，
    也就不吃 relay 的 4 个槽位。失败时由调用方决定回退旧协议。
    """
    base = server_url()
    token = str(info.get("token") or "")
    path = str(info.get("path") or "")
    if not base or not token or not path.startswith("/api/v1/"):
        raise HTTPException(status_code=502, detail="IM_ATTACHMENT_LINK_FAILED")
    thumb = 1 if info.get("thumb") else 0
    url = (f"{base.rstrip('/')}{path}?token={urllib.parse.quote(token, safe='')}"
           f"&thumb={thumb}")
    try:
        response = _get_client().get(
            url, timeout=RELAY_ATTACHMENT_TIMEOUT_SECONDS, follow_redirects=True)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"IM_ATTACHMENT_FETCH_FAILED: {exc}") from exc
    if response.status_code >= 400:
        raise HTTPException(
            status_code=response.status_code if response.status_code < 500 else 502,
            detail="IM_ATTACHMENT_FETCH_FAILED",
        )
    filename = "attachment"
    disposition = response.headers.get("content-disposition", "")
    match = re.search(r"filename\*=UTF-8''([^;]+)", disposition)
    if match:
        filename = urllib.parse.unquote(match.group(1)) or filename
    mime = response.headers.get("content-type", "application/octet-stream").split(";", 1)[0]
    return response.content, mime, filename
