"""桌面版 OTA：检查更新 / 断点续传下载 / sha256 校验 / 稍后计数 / 静默安装并退出。

- 下载走 stdlib urllib（可断点续传，写 <version>.exe.part，完成后校验并改名）
- 安装：写一个升级脚本（cmd，隐藏运行，不弹终端窗口），以脱离进程方式拉起，
  再通过 desktop_bridge.request_exit() 退出应用；
  脚本等待应用退出（有上限，超时 taskkill 兜底）→ 静默安装 → 拉起新版本，
  因此应用侧退出失败也不会让安装永久卡住
- 不设强制更新：新版本只提示，用户可随时关闭，下次按间隔（1 天 2 次）再提示
"""
from __future__ import annotations

import hashlib
import logging
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

from app.core.config import settings
from app.services import desktop_cloud_client as cloud
from app.services.desktop_cloud_client import CloudError

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
    # 用户选了「后台运行」：窗口关闭后由启动器进程继续下载并自动安装
    "background": False,
}
_lock = threading.Lock()
_install_started = False  # 升级脚本只允许拉起一次（重复触发会出现两个安装器）


def _updates_dir() -> Path:
    path = settings.DATA_ROOT / "updates"
    path.mkdir(parents=True, exist_ok=True)
    return path


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


def _write_intent(installer: Path, version: str) -> Path:
    """记录本次安装意图：目标版本 + 安装包路径（应用重启后据此判断是否装成功）。"""
    import json

    path = _updates_dir() / "npt_ota_intent.json"
    try:
        path.write_text(
            json.dumps(
                {
                    "target_version": version,
                    "installer": str(installer),
                    "app_exe": str(Path(sys.executable)),
                    "started_at": _now_iso(),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001
        _log.warning("写入升级意图失败（不影响安装）：%s", exc)
    return path


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _write_helper(installer: Path, target_version: str) -> Path:
    """写升级脚本：等待应用退出（超时强杀）→ 静默安装 → 重新启动新版本。

    脚本必须隐藏运行（调用方用 CREATE_NO_WINDOW 拉起），否则用户会看到一个卡住的
    终端窗口；计时用 ping 而非 timeout —— 无控制台环境下 timeout 会直接报错退化为忙循环。
    脚本正文保持纯 ASCII（注释英文 + 8.3 短路径），避免代码页解析问题。

    安装目录与重启目标：
    - 先带 /DIR 安装到**当前正在运行的目录**——否则若程序不是装在默认目录，
      安装器会把新版本装到别处，脚本又重启旧目录的 exe，用户看到"版本没变"。
    - /DIR 安装失败（如目录无写权限）再退回默认目录重试一次。
    - 重启优先选「安装目录里的 exe」，其次是默认目录，最后才是旧路径。
    - 安装器退出码写进 npt_ota_result.txt，应用重启后据此告知用户失败原因。
    """
    # onedir 冻结后 sys.executable 即安装目录下的 NPT.exe；源码模式为 python.exe（仅开发用）
    app_exe = Path(sys.executable)
    app_dir = app_exe.parent
    app_path = _windows_short_path(app_exe)
    app_dir_short = _windows_short_path(app_dir)
    installer_path = _windows_short_path(installer)
    install_log = _windows_short_path(_updates_dir() / "npt_setup.log")
    result_file = _windows_short_path(_updates_dir() / "npt_ota_result.txt")
    default_dir = "%LOCALAPPDATA%\\Programs\\NetworkPlanningTool"
    base_args = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /LOG="%LOG%"'
    script = f"""@echo off
chcp 65001 >nul
rem NPT OTA updater: wait for app exit -> silent install -> restart new version
setlocal
set "APP={app_path}"
set "APPDIR={app_dir_short}"
set "EXE={app_exe.name}"
set "SETUP={installer_path}"
set "LOG={install_log}"
set "RESULT={result_file}"
set "DEFAULTDIR={default_dir}"
set "RC="
set "RC2=skipped"
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
rem 1) install into the directory the app currently runs from (upgrade in place)
start /wait "" "%SETUP%" {base_args} /DIR="%APPDIR%"
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto launch
rem 2) fallback: default per-user directory
ping -n 3 127.0.0.1 >nul
start /wait "" "%SETUP%" {base_args}
set "RC2=%ERRORLEVEL%"
:launch
set "TARGET=%APPDIR%\\{app_exe.name}"
if exist "%TARGET%" goto startapp
set "TARGET=%DEFAULTDIR%\\{app_exe.name}"
if exist "%TARGET%" goto startapp
set "TARGET=%APP%"
:startapp
> "%RESULT%" echo target_version={target_version}
>> "%RESULT%" echo setup_rc=%RC%
>> "%RESULT%" echo setup_retry_rc=%RC2%
>> "%RESULT%" echo restarted=%TARGET%
>> "%RESULT%" echo finished_at=%DATE% %TIME%
start "" "%TARGET%"
del "%~f0" >nul 2>&1
"""
    helper = _updates_dir() / f"npt_update_{installer.stem}.cmd"
    helper.write_text(script, encoding="utf-8", newline="\r\n")
    return helper


def _start_installer() -> Path:
    """校验安装包后拉起升级脚本（不做退出动作），返回安装包路径。"""
    global _install_started

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

    _write_intent(installer, str(state.get("version") or ""))
    helper = _write_helper(installer, str(state.get("version") or ""))
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
    return installer


def install_and_exit() -> Dict[str, Any]:
    """校验通过后拉起升级脚本并请求退出应用（"重启并安装"）。"""
    from app import desktop_bridge

    _start_installer()

    if not desktop_bridge.request_exit():
        return {"exiting": False, "message": "已启动安装程序；应用未响应退出，升级脚本将自动关闭并安装"}
    return {"exiting": True, "message": "即将退出并安装新版本"}


def _background_marker() -> Path:
    """后台更新标记文件：其它进程（用户重复启动）据此提示"正在后台更新"。"""
    return _updates_dir() / "background_update.json"


def _write_background_marker(version: str) -> None:
    import json

    try:
        _background_marker().write_text(
            json.dumps({"version": version, "armed_at": _now_iso()}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001
        _log.warning("写入后台更新标记失败（不影响更新）：%s", exc)


def _clear_background_marker() -> None:
    try:
        _background_marker().unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass


def arm_background(release: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """把更新转入后台：窗口关闭后由启动器进程继续下载 → 自动安装 → 拉起新版本。

    未开始下载时按最新版本启动下载；已下载完成则只置位（关窗即安装）。
    """
    with _lock:
        phase = _state.get("phase")
    if phase not in ("downloading", "ready"):
        target = release or check_latest(raise_on_error=True)
        if not target or not target.get("update_available"):
            raise CloudError(409, "当前没有可用的新版本")
        start_download(target)
    with _lock:
        _state["background"] = True
        version = str(_state.get("version") or "")
    _write_background_marker(version)
    _log.info("更新已转入后台运行：%s", version)
    return progress()


def is_background_armed() -> bool:
    with _lock:
        return bool(_state.get("background"))


def wait_background_update(
    poll_seconds: float = 2.0, timeout_seconds: float = 45 * 60
) -> Dict[str, Any]:
    """启动器专用：窗口已关闭时继续后台更新（阻塞直到安装拉起 / 失败 / 超时）。

    返回 {action: 'install' | 'abort' | 'none', ...}。
    """
    if not is_background_armed():
        return {"action": "none"}
    _log.info("检测到后台更新：继续等待下载完成后自动安装")
    deadline = time.monotonic() + timeout_seconds
    try:
        while time.monotonic() < deadline:
            state = progress()
            phase = state.get("phase")
            if phase == "ready":
                try:
                    _start_installer()
                    return {"action": "install", "version": state.get("version")}
                except Exception as exc:  # noqa: BLE001
                    _log.error("后台更新拉起安装失败：%s", exc)
                    return {"action": "abort", "error": str(exc)}
            if phase in ("failed", "idle"):
                _log.warning("后台更新结束（phase=%s, error=%s）", phase, state.get("error"))
                return {"action": "abort", "error": state.get("error")}
            time.sleep(poll_seconds)
        _log.warning("后台更新等待超时（%s 秒），退出应用", timeout_seconds)
        return {"action": "abort", "error": "timeout"}
    finally:
        # 标记文件只为提示"后台更新中"；安装脚本已拉起或更新结束都不再适用
        _clear_background_marker()


def last_result() -> Optional[Dict[str, Any]]:
    """上一次安装的结果（供应用重启后展示）：目标版本、安装器退出码、是否已生效。"""
    import json

    intent_path = _updates_dir() / "npt_ota_intent.json"
    result_path = _updates_dir() / "npt_ota_result.txt"
    if not intent_path.is_file() and not result_path.is_file():
        return None
    data: Dict[str, Any] = {}
    try:
        if intent_path.is_file():
            data.update(json.loads(intent_path.read_text(encoding="utf-8")))
    except Exception:  # noqa: BLE001
        pass
    try:
        if result_path.is_file():
            for line in result_path.read_text(encoding="utf-8", errors="replace").splitlines():
                key, _, value = line.partition("=")
                key = key.strip()
                if key:
                    data[key] = value.strip()
    except Exception:  # noqa: BLE001
        pass
    if not data:
        return None
    target = str(data.get("target_version") or "")
    current = settings.NPT_DESKTOP_VERSION or ""
    data["current_version"] = current
    # 安装器退出码非 0（或目标版本没变）都算没装成功，前端据此给出手动安装提示
    rc_ok = str(data.get("setup_rc", "0")) in ("0", "") or str(data.get("setup_retry_rc", "")) == "0"
    data["applied"] = bool(target) and current == target
    data["needs_manual"] = bool(target) and (not data["applied"]) and not rc_ok
    return data
