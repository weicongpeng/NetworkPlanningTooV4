"""桌面客户端 → 授权服务器 的 HTTP 客户端与本地云端状态（仅桌面版使用）。

设计要点：
- 全部走 stdlib urllib（无需新依赖，PyInstaller 打包无额外隐藏导入）
- 本机 JWT 与服务器无关：这里只用激活码/许可文件做凭证，不放任何站点 token
- 服务器地址取 settings.NPT_SERVER_URL（launcher 注入，管理员可在配置管理页改）
- 运行状态（license_id/上次续期/申请单）保存在 LICENSE_DIR/cloud_state.json
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional

from app.core.config import settings


class CloudError(Exception):
    """调用授权服务器失败（status_code=0 表示网络不可达）。"""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


# ---------------------------------------------------------------- 本地状态

def state_file() -> Path:
    return settings.LICENSE_DIR / "cloud_state.json"


def load_state() -> Dict[str, Any]:
    path = state_file()
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def save_state(**kwargs: Any) -> Dict[str, Any]:
    state = load_state()
    state.update({k: v for k, v in kwargs.items() if v is not None})
    try:
        settings.LICENSE_DIR.mkdir(parents=True, exist_ok=True)
        state_file().write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
    return state


# ---------------------------------------------------------------- HTTP

def server_url() -> str:
    return (settings.NPT_SERVER_URL or "").strip().rstrip("/")


def _request(method: str, path: str, payload: Optional[dict] = None, timeout: int = 20) -> dict:
    base = server_url()
    if not base:
        raise CloudError(0, "未配置授权服务器地址")
    data = json.dumps(payload or {}).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        f"{base}/api/v1{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "User-Agent": "NPT-Desktop"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        detail = f"HTTP {exc.code}"
        try:
            body = json.loads(exc.read().decode("utf-8", "replace"))
            detail = body.get("detail") or body.get("message") or detail
        except Exception:
            pass
        raise CloudError(exc.code, str(detail)) from exc
    except urllib.error.URLError as exc:
        raise CloudError(0, f"无法连接授权服务器（{exc.reason}）") from exc
    except Exception as exc:  # noqa: BLE001
        raise CloudError(0, f"请求授权服务器失败：{exc}") from exc


def get_handshake() -> Dict[str, Any]:
    """服务器能力（激活模式/默认租约/更新渠道）。"""
    try:
        resp = _request("GET", "/desktop-cloud/config", timeout=10)
        return resp.get("data") or {}
    except CloudError:
        return {}


def _license_file_text() -> str:
    from app.services.license_service import license_service

    path = license_service._signed_license_file()
    if not path.is_file():
        raise CloudError(400, "本机尚未激活，请先在线激活或导入授权文件")
    return path.read_text(encoding="utf-8")


# ---------------------------------------------------------------- 共享模式数据同步

def sync_session(city: str, operator: str) -> Dict[str, Any]:
    """同步握手：服务器确定桌面端的数据组（未绑定则上报值即成为绑定值）。"""
    from app.utils.machine_code import get_machine_code

    resp = _request(
        "POST",
        "/desktop-cloud/data/session",
        {
            "license_file": _license_file_text(),
            "machine_code": get_machine_code(),
            "city": city or "",
            "operator": operator or "",
        },
    )
    return resp.get("data") or {}


def sync_manifest() -> Dict[str, Any]:
    """本组数据集清单（含修订号与删除墓碑）。"""
    from app.utils.machine_code import get_machine_code

    resp = _request(
        "POST",
        "/desktop-cloud/data/manifest",
        {"license_file": _license_file_text(), "machine_code": get_machine_code()},
        timeout=30,
    )
    return resp.get("data") or {}


def download_package(data_id: str, destdir: Optional[Path] = None) -> Path:
    """下载数据集整包，返回 zip 路径（位于专用临时目录，调用方负责清理）。"""
    import shutil
    import tempfile
    import urllib.parse
    from urllib.request import Request as UrlRequest, urlopen

    from app.utils.machine_code import get_machine_code

    base = server_url()
    if not base:
        raise CloudError(0, "未配置授权服务器地址")
    query = urllib.parse.urlencode(
        {"license_file": _license_file_text(), "machine_code": get_machine_code()}
    )
    request = UrlRequest(
        f"{base}/api/v1/desktop-cloud/data/dataset/{urllib.parse.quote(data_id)}/package?{query}",
        method="GET",
        headers={"User-Agent": "NPT-Desktop"},
    )
    target_dir = Path(destdir) if destdir else Path(tempfile.mkdtemp(prefix="npt-pull-"))
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{data_id}.zip"
    try:
        with urlopen(request, timeout=180) as resp, target.open("wb") as out:
            shutil.copyfileobj(resp, out)
    except urllib.error.HTTPError as exc:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise CloudError(exc.code, f"下载数据集失败（HTTP {exc.code}）") from exc
    except urllib.error.URLError as exc:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise CloudError(0, f"无法连接授权服务器（{exc.reason}）") from exc
    return target


def upload_package(data_id: str, zip_path: Path, base_rev: Optional[int] = None) -> Dict[str, Any]:
    """上传数据集整包（multipart/form-data，手动构造以免引入 requests 依赖）。"""
    import mimetypes
    import urllib.parse

    from app.utils.machine_code import get_machine_code

    base = server_url()
    if not base:
        raise CloudError(0, "未配置授权服务器地址")

    boundary = f"----NPTDesktop{uuid.uuid4().hex}"
    fields = [
        ("license_file", _license_file_text()),
        ("machine_code", get_machine_code()),
    ]
    if base_rev is not None:
        fields.append(("base_rev", str(base_rev)))

    body = bytearray()
    for name, value in fields:
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        body += value.encode("utf-8") + b"\r\n"
    filename = zip_path.name
    ctype = mimetypes.guess_type(filename)[0] or "application/zip"
    body += f"--{boundary}\r\n".encode()
    body += (
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n"
    ).encode()
    with zip_path.open("rb") as f:
        body += f.read()
    body += f"\r\n--{boundary}--\r\n".encode()

    request = urllib.request.Request(
        f"{base}/api/v1/desktop-cloud/data/dataset/{urllib.parse.quote(data_id)}/package",
        data=bytes(body),
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": "NPT-Desktop",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=600) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        raise CloudError(exc.code, _http_error_detail(exc)) from exc
    except urllib.error.URLError as exc:
        raise CloudError(0, f"无法连接授权服务器（{exc.reason}）") from exc
    if not payload.get("success"):
        raise CloudError(502, payload.get("message") or payload.get("detail") or "上传失败")
    return payload.get("data") or {}


def delete_dataset(data_id: str) -> Dict[str, Any]:
    """通知服务器删除该数据集。"""
    from app.utils.machine_code import get_machine_code

    resp = _request(
        "DELETE",
        f"/desktop-cloud/data/dataset/{urllib.parse.quote(data_id)}",
        {"license_file": _license_file_text(), "machine_code": get_machine_code()},
    )
    return resp or {}


# ---------------------------------------------------------------- 业务

def activate(activation_code: str, hostname: Optional[str] = None) -> Dict[str, Any]:
    from app.utils.machine_code import get_machine_code

    resp = _request(
        "POST",
        "/desktop-cloud/license/activate",
        {
            "activation_code": activation_code,
            "machine_code": get_machine_code(),
            "client_version": settings.NPT_DESKTOP_VERSION or "",
            "hostname": hostname or "",
        },
    )
    data = resp.get("data") or {}
    save_state(
        license_id=data.get("license_id"),
        last_renew_at=datetime.now().isoformat(),
        server_url=server_url(),
    )
    return data


def login(
    username: str,
    password: str,
    mode: str = "standalone",
    offline_logins: Optional[int] = None,
    hostname: Optional[str] = None,
) -> Dict[str, Any]:
    """桌面端账号登录：凭证是网页端用户名/密码，成功即落盘许可。

    返回 {"result": "ok"|"pending"|..., ...}；result != ok 时不写许可文件。
    """
    from app.utils.machine_code import get_machine_code

    payload: Dict[str, Any] = {
        "username": username,
        "password": password,
        "mode": mode,
        "machine_code": get_machine_code(),
        "client_version": settings.NPT_DESKTOP_VERSION or "",
        "hostname": hostname or "",
    }
    if offline_logins:
        payload["offline_logins"] = int(offline_logins)
    resp = _request("POST", "/desktop-cloud/auth/login", payload)
    data = resp.get("data") or {}
    if data.get("result") == "ok":
        from app.services.license_service import license_service

        ok, message = license_service.activate(str(data.get("license_file") or ""))
        if not ok:
            raise CloudError(500, f"许可文件校验失败：{message}")
        save_state(
            license_id=data.get("license_id"),
            desktop_username=username,
            desktop_mode=mode,
            last_renew_at=datetime.now().isoformat(),
            server_url=server_url(),
        )
    return data


def register_options() -> Dict[str, Any]:
    """注册选项（地市预设 + 运营商）：桌面端注册下拉直接取服务器的值。"""
    resp = _request("GET", "/auth/options", timeout=10)
    return resp.get("data") or {}


def register(username: str, password: str, city: str, operator: str) -> Dict[str, Any]:
    """桌面端注册：在服务器上创建与网页端同规则的账号（注册不允许自封管理员）。"""
    resp = _request(
        "POST",
        "/desktop-cloud/auth/register",
        {
            "username": username,
            "password": password,
            "confirm_password": password,
            "city": city,
            "operator": operator,
        },
    )
    return resp.get("data") or {}


def app_version() -> Dict[str, Any]:
    """手机 APP 最新版本：桌面端没有 APK 分发，直接从服务器取（供客户端下载页展示）。"""
    resp = _request("GET", "/app-versions/latest", timeout=15)
    return resp.get("data") or {}


def session_check(session_jti: str) -> Dict[str, Any]:
    """登录态校验：本机本次登录是否仍是该账号的最后一次登录。

    只有服务器**明确回复** valid=False（该账号已在别处登录 / 会话已失效）才判定
    为本机需登出；网络不可达、超时、5xx 等一律按"无法确定"处理——断网或服务器
    抖动时不能把人踢下线（单机模式本就允许离线长期使用）。
    """
    from app.utils.machine_code import get_machine_code

    try:
        resp = _request(
            "POST",
            "/desktop-cloud/auth/session-check",
            {
                "license_file": _license_file_text(),
                "machine_code": get_machine_code(),
                "session_jti": session_jti or "",
            },
            timeout=15,
        )
    except CloudError as exc:
        return {"valid": True, "offline": True, "reason": exc.message}
    return resp.get("data") or {}


def poll_login(username: str) -> Dict[str, Any]:
    """单机模式：轮询授权申请，批准后当场落盘许可。"""
    from app.utils.machine_code import get_machine_code

    resp = _request(
        "POST",
        "/desktop-cloud/auth/poll",
        {"username": username, "machine_code": get_machine_code()},
    )
    data = resp.get("data") or {}
    if data.get("result") == "ok":
        from app.services.license_service import license_service

        ok, message = license_service.activate(str(data.get("license_file") or ""))
        if not ok:
            raise CloudError(500, f"许可文件校验失败：{message}")
        save_state(
            license_id=data.get("license_id"),
            desktop_username=username,
            desktop_mode="standalone",
            last_renew_at=datetime.now().isoformat(),
        )
    return data


def apply_license(
    applicant_name: str, organization: Optional[str] = None, note: Optional[str] = None
) -> Dict[str, Any]:
    from app.utils.machine_code import get_machine_code

    resp = _request(
        "POST",
        "/desktop-cloud/license/apply",
        {
            "machine_code": get_machine_code(),
            "applicant_name": applicant_name,
            "organization": organization or "",
            "note": note or "",
            "client_version": settings.NPT_DESKTOP_VERSION or "",
            "hostname": "",
        },
    )
    data = resp.get("data") or {}
    save_state(request_id=data.get("request_id"), apply_token=data.get("apply_token"))
    return data


def poll_apply() -> Dict[str, Any]:
    state = load_state()
    request_id = state.get("request_id")
    token = state.get("apply_token")
    if not request_id or not token:
        raise CloudError(400, "本机没有待批准的授权申请")
    resp = _request(
        "GET", f"/desktop-cloud/license/apply/{request_id}?token={urllib.parse.quote(str(token))}"
    )
    return resp.get("data") or {}


def renew_remote(license_file: str) -> Dict[str, Any]:
    from app.utils.machine_code import get_machine_code

    resp = _request(
        "POST",
        "/desktop-cloud/license/renew",
        {
            "license_file": license_file,
            "machine_code": get_machine_code(),
            "client_version": settings.NPT_DESKTOP_VERSION or "",
        },
    )
    data = resp.get("data") or {}
    save_state(license_id=data.get("license_id"), last_renew_at=datetime.now().isoformat())
    return data


def renew_local_license() -> Dict[str, Any]:
    """读取本机许可 → 调服务器续期 → 写回许可文件（端点与后台任务共用）。

    远程调用与本地写盘都在这里，测试可只桩化 :func:`renew_remote`。
    """
    from app.services.license_service import license_service

    path = license_service._signed_license_file()
    if not path.is_file():
        raise CloudError(400, "本机尚未激活，请先在线激活或导入授权文件")
    data = renew_remote(path.read_text(encoding="utf-8"))
    new_license = data.get("license_file")
    if not new_license:
        raise CloudError(500, "授权服务器未返回新的许可文件")
    ok, message = license_service.activate(new_license)
    if not ok:
        raise CloudError(500, f"新的许可文件校验失败：{message}")
    return data


def should_renew(info: Optional[Dict[str, Any]], state: Dict[str, Any]) -> bool:
    """续期策略：剩余 <20 天，或距上次续期 ≥7 天。"""
    if not info or not info.get("valid") or info.get("issued_via") != "online":
        return False
    remaining = info.get("remaining_days")
    if remaining is not None and remaining < 20:
        return True
    last = state.get("last_renew_at")
    if not last:
        return True
    try:
        return datetime.now() - datetime.fromisoformat(last) >= timedelta(days=7)
    except ValueError:
        return True


async def renewal_loop() -> None:
    """桌面版后台续期任务（启动 30s 后开始，每 24h 检查一次；失败仅记日志）。"""
    import asyncio

    from app.services.license_service import license_service

    await asyncio.sleep(30)
    while True:
        try:
            info = license_service.desktop_license_info()
            state = load_state()
            if should_renew(info, state):
                result = renew_local_license()
                print(f"[DesktopCloud] 已自动续期至 {result.get('expire_date')}")
        except Exception as exc:  # noqa: BLE001
            print(f"[DesktopCloud] 自动续期未完成（忽略）：{exc}")
        await asyncio.sleep(24 * 3600)
