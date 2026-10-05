"""桌面版 OTA：检查更新 / 断点续传下载 / sha256 校验 / 稍后计数 / 静默安装并退出。

- 下载走 stdlib urllib（可断点续传，写 <version>.exe.part，完成后校验并改名）
- 安装：写一个等待本进程退出的 helper 脚本（cmd），以脱离进程方式拉起，
  再通过 desktop_bridge.request_exit() 退出应用；helper 静默安装后拉起新版本
- 稍后次数记录在 cloud_state.json（同一版本最多 NPT_DESKTOP_MAX_SNOOZE 次）
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

from app.core.config import settings
from app.services import desktop_cloud_client as cloud
from app.services.desktop_cloud_client import CloudError, load_state, save_state

_state: Dict[str, Any] = {
    "phase": "idle",  # idle | downloading | ready | failed
    "version": None,
    "downloaded": 0,
    "total": 0,
    "error": None,
    "installer": None,
    "sha256": None,
}
_lock = threading.Lock()


def _updates_dir() -> Path:
    path = settings.DATA_ROOT / "updates"
    path.mkdir(parents=True, exist_ok=True)
    return path


def max_snooze() -> int:
    return int(os.environ.get("NPT_DESKTOP_MAX_SNOOZE") or settings.NPT_DESKTOP_MAX_SNOOZE or 3)


def snooze_state(version: str) -> Dict[str, Any]:
    state = load_state()
    snoozed = dict(state.get("snoozed") or {})
    count = int(snoozed.get(version or "", 0))
    limit = max_snooze()
    return {"version": version, "count": count, "max": limit, "force": count >= limit}


def snooze(version: str) -> Dict[str, Any]:
    state = load_state()
    snoozed = dict(state.get("snoozed") or {})
    key = version or ""
    snoozed[key] = int(snoozed.get(key, 0)) + 1
    save_state(snoozed=snoozed)
    return snooze_state(version)


def check_latest() -> Optional[Dict[str, Any]]:
    """查询服务器最新版本；未配置/网络不可用返回 None（不抛错）。"""
    current = settings.NPT_DESKTOP_VERSION or ""
    channel = settings.NPT_DESKTOP_CHANNEL or "stable"
    query = urllib.parse.urlencode({"current": current, "channel": channel})
    try:
        resp = cloud._request("GET", f"/desktop-cloud/releases/latest?{query}", timeout=15)
    except CloudError:
        return None
    data = resp.get("data")
    if not data:
        return None
    data["snooze"] = snooze_state(str(data.get("version")))
    data["current"] = current
    return data


def progress() -> Dict[str, Any]:
    with _lock:
        return dict(_state)


def _download_url(release: Dict[str, Any]) -> str:
    url = str(release.get("download_url") or "")
    if url.startswith("http"):
        return url
    return f"{cloud.server_url()}{url}"


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download_worker(release: Dict[str, Any]) -> None:
    version = str(release.get("version") or "unknown")
    expected_sha = (release.get("sha256") or "").lower()
    url = _download_url(release)
    target = _updates_dir() / f"NetworkPlanningTool-Setup-{version}.exe"
    part = target.with_suffix(".exe.part")
    total = int(release.get("file_size") or 0)

    try:
        with _lock:
            _state.update(
                phase="downloading", version=version, downloaded=part.stat().st_size if part.exists() else 0,
                total=total, error=None, installer=None, sha256=expected_sha,
            )

        for attempt in range(1, 6):
            pos = part.stat().st_size if part.exists() else 0
            headers = {"User-Agent": "NPT-Desktop-Updater"}
            if pos:
                headers["Range"] = f"bytes={pos}-"
            request = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=60) as resp:
                    resumed = pos > 0 and getattr(resp, "status", 200) == 206
                    mode = "ab" if resumed else "wb"
                    if not resumed:
                        pos = 0
                    with part.open(mode) as out:
                        while True:
                            chunk = resp.read(1024 * 256)
                            if not chunk:
                                break
                            out.write(chunk)
                            with _lock:
                                _state["downloaded"] = part.stat().st_size
                break
            except Exception as exc:  # noqa: BLE001
                if attempt >= 5:
                    raise
                with _lock:
                    _state["error"] = f"下载中断，重试中（{attempt}/5）：{exc}"

        actual_sha = _hash_file(part)
        if expected_sha and actual_sha != expected_sha:
            raise CloudError(500, f"安装包校验失败（sha256 不一致）")

        part.replace(target)
        with _lock:
            _state.update(
                phase="ready", installer=str(target), downloaded=target.stat().st_size,
                total=target.stat().st_size, error=None,
            )
    except Exception as exc:  # noqa: BLE001
        with _lock:
            _state.update(phase="failed", error=str(exc))


def start_download(release: Dict[str, Any]) -> Dict[str, Any]:
    with _lock:
        if _state.get("phase") == "downloading":
            return dict(_state)
    thread = threading.Thread(target=_download_worker, args=(release,), daemon=True)
    thread.start()
    return progress()


def _write_helper(installer: Path) -> Path:
    """写一个等待本进程退出 → 静默安装 → 拉起新版本的 cmd 脚本。"""
    # onedir 冻结后 sys.executable 即安装目录下的 NPT.exe；源码模式为 python.exe（仅开发用）
    app_exe = Path(sys.executable)
    script = f"""@echo off
chcp 65001 >nul
:wait
tasklist /FI "IMAGENAME eq {app_exe.name}" 2>nul | find /I "{app_exe.name}" >nul
if not errorlevel 1 (
  timeout /t 2 /nobreak >nul
  goto wait
)
start /wait "" "{installer}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS
start "" "{app_exe}"
del "%~f0" >nul 2>&1
"""
    helper = _updates_dir() / f"npt_update_{installer.stem}.cmd"
    helper.write_text(script, encoding="utf-8", newline="\r\n")
    return helper


def install_and_exit() -> Dict[str, Any]:
    """校验通过后拉起安装 helper 并请求退出应用。"""
    from app import desktop_bridge

    with _lock:
        state = dict(_state)
    if state.get("phase") != "ready" or not state.get("installer"):
        raise CloudError(409, "安装包尚未下载完成")
    installer = Path(str(state["installer"]))
    if not installer.is_file():
        raise CloudError(404, "安装包文件不存在，请重新下载")

    expected_sha = (state.get("sha256") or "").lower()
    if expected_sha and _hash_file(installer) != expected_sha:
        raise CloudError(500, "安装包校验失败（sha256 不一致），请重新下载")

    if os.name != "nt":
        raise CloudError(400, "自动安装仅在 Windows 桌面版可用")

    helper = _write_helper(installer)
    creationflags = 0
    if hasattr(subprocess, "DETACHED_PROCESS"):
        creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(["cmd", "/c", str(helper)], creationflags=creationflags, close_fds=True)

    if not desktop_bridge.request_exit():
        return {"exiting": False, "message": "已启动安装程序；本程序将在退出后自动安装"}
    return {"exiting": True, "message": "即将退出并安装新版本"}
