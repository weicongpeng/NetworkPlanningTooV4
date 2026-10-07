"""桌面版 OTA：检查更新 / 断点续传下载 / sha256 校验 / 稍后计数 / 静默安装并退出。

- 下载走 stdlib urllib（可断点续传，写 <version>.exe.part，完成后校验并改名）
- 安装：写一个升级脚本（cmd，隐藏运行，不弹终端窗口），以脱离进程方式拉起，
  再通过 desktop_bridge.request_exit() 退出应用；
  脚本等待应用退出（有上限，超时 taskkill 兜底）→ 静默安装 → 拉起新版本，
  因此应用侧退出失败也不会让安装永久卡住
- 稍后次数记录在 cloud_state.json（同一版本最多 NPT_DESKTOP_MAX_SNOOZE 次）
"""
from __future__ import annotations

import hashlib
import logging
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

_log = logging.getLogger("desktop.update")

# 升级脚本等待应用退出的上限（秒），超时后 taskkill 强制结束再继续安装
EXIT_WAIT_SECONDS = 60


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
_install_started = False  # 升级脚本只允许拉起一次（重复触发会出现两个安装器）


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


def check_latest(raise_on_error: bool = False) -> Optional[Dict[str, Any]]:
    """查询服务器最新版本；未配置/网络不可用返回 None（不抛错）。

    raise_on_error=True 时网络失败改为抛 CloudError：手动「检查更新」需要区分
    「确实已是最新」与「连不上授权服务器」，不能让用户误以为已是最新。
    """
    current = settings.NPT_DESKTOP_VERSION or ""
    channel = settings.NPT_DESKTOP_CHANNEL or "stable"
    query = urllib.parse.urlencode({"current": current, "channel": channel})
    try:
        resp = cloud._request("GET", f"/desktop-cloud/releases/latest?{query}", timeout=15)
    except CloudError:
        if raise_on_error:
            raise
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


def _windows_short_path(path: Path) -> str:
    """取 Windows 8.3 短路径（纯 ASCII），让升级脚本不受 cmd 代码页影响。

    用户名含中文时，%APPDATA% 下的路径写入 UTF-8 批处理脚本后，一旦 cmd 未能按
    chcp 65001 解码就会拼出错误路径导致安装失败；短路径可彻底规避（未启用 8.3 时回退长路径）。
    """
    if os.name != "nt":
        return str(path)
    try:
        import ctypes

        buffer = ctypes.create_unicode_buffer(1024)
        if ctypes.windll.kernel32.GetShortPathNameW(str(path), buffer, 1024):
            return buffer.value or str(path)
    except Exception:  # noqa: BLE001
        pass
    return str(path)


def _write_helper(installer: Path) -> Path:
    """写升级脚本：等待应用退出（超时强杀）→ 静默安装 → 重新启动应用。

    脚本必须隐藏运行（调用方用 CREATE_NO_WINDOW 拉起），否则用户会看到一个卡住的
    终端窗口；计时用 ping 而非 timeout —— 无控制台环境下 timeout 会直接报错退化为忙循环。
    脚本正文保持纯 ASCII（注释英文 + 8.3 短路径），避免代码页解析问题。
    """
    # onedir 冻结后 sys.executable 即安装目录下的 NPT.exe；源码模式为 python.exe（仅开发用）
    app_exe = Path(sys.executable)
    app_path = _windows_short_path(app_exe)
    installer_path = _windows_short_path(installer)
    install_log = _windows_short_path(_updates_dir() / "npt_setup.log")
    setup_args = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /LOG="%LOG%"'
    script = f"""@echo off
chcp 65001 >nul
rem NPT OTA updater: wait for app exit -> silent install -> restart app
setlocal
set "APP={app_path}"
set "EXE={app_exe.name}"
set "SETUP={installer_path}"
set "LOG={install_log}"
set /a WAITED=0
:wait
tasklist /FI "IMAGENAME eq %EXE%" /NH 2>nul | find /I "%EXE%" >nul
if errorlevel 1 goto install
set /a WAITED+=2
if %WAITED% GEQ {EXIT_WAIT_SECONDS} goto killapp
ping -n 3 127.0.0.1 >nul
goto wait
:killapp
taskkill /F /IM "%EXE%" >nul 2>&1
ping -n 3 127.0.0.1 >nul
:install
start /wait "" "%SETUP%" {setup_args}
if errorlevel 1 (
  ping -n 3 127.0.0.1 >nul
  start /wait "" "%SETUP%" {setup_args}
)
start "" "%APP%"
del "%~f0" >nul 2>&1
"""
    helper = _updates_dir() / f"npt_update_{installer.stem}.cmd"
    helper.write_text(script, encoding="utf-8", newline="\r\n")
    return helper


def install_and_exit() -> Dict[str, Any]:
    """校验通过后拉起升级脚本并请求退出应用。"""
    global _install_started
    from app import desktop_bridge

    with _lock:
        state = dict(_state)
        started = _install_started
    if started:
        raise CloudError(409, "升级已启动，请稍候自动安装完成")
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
    with _lock:
        _install_started = True
    # CREATE_NO_WINDOW：脚本在隐藏控制台中运行，用户不会看到"卡住的终端窗口"
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
        subprocess, "CREATE_NEW_PROCESS_GROUP", 0
    )
    try:
        subprocess.Popen(["cmd", "/c", str(helper)], creationflags=creationflags, close_fds=True)
    except Exception:
        with _lock:
            _install_started = False  # 拉起失败允许重试
        raise
    _log.info("OTA 升级脚本已启动：installer=%s helper=%s", installer, helper)

    if not desktop_bridge.request_exit():
        return {"exiting": False, "message": "已启动安装程序；应用未响应退出，升级脚本将自动关闭并安装"}
    return {"exiting": True, "message": "即将退出并安装新版本"}
