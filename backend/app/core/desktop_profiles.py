"""桌面端运行模式配置档（profile）：共享 / 单机两种模式的物理数据隔离。

数据根布局（桌面形态下）::

    DATA_ROOT/                       # 全局（机器级）：授权、凭据、OTA、webview
      active_profile.json            # 当前配置档（launcher 启动时读取）
      profiles/
        shared/      data/ uploads/ outputs/ exports/ sync_state.json
        standalone/  data/ uploads/ outputs/ exports/ sync_state.json

本模块只依赖标准库，launcher 在导入 app 业务包之前就会调用，因此不得导入
app.core.config 或任何业务模块。

服务器形态不分档（profile_root_for 原样返回数据根，行为与历史一致）。
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

PROFILE_SHARED = "shared"
PROFILE_STANDALONE = "standalone"
PROFILE_DEFAULT = PROFILE_SHARED

PROFILES_DIRNAME = "profiles"
ACTIVE_PROFILE_FILE = "active_profile.json"
RESTART_DIRNAME = "restart"

# 旧版本全部业务数据直接放在 DATA_ROOT 下；分档后首启时迁入 shared 档
_LEGACY_BUSINESS_DIRS = ("data", "uploads", "outputs", "exports")
_LEGACY_BUSINESS_FILES = ("sync_state.json",)
_MIGRATION_MARKER = ".legacy_migrated"

_logger = logging.getLogger(__name__)


def normalize_profile(value: Optional[str]) -> str:
    """把环境变量/标记文件里的模式值归一化，非法值回落 shared。"""
    return PROFILE_STANDALONE if str(value or "").strip().lower() == PROFILE_STANDALONE else PROFILE_SHARED


def active_profile_from_env() -> str:
    return normalize_profile(os.environ.get("NPT_DESKTOP_PROFILE"))


def profiles_root(data_root: Path) -> Path:
    return Path(data_root) / PROFILES_DIRNAME


def profile_root_for(data_root: Path, profile: Optional[str]) -> Path:
    """某配置档的可写根目录。

    非桌面形态调用方直接传 PROFILE_DEFAULT 之外的判断在 config 层完成；
    这里始终返回 DATA_ROOT/profiles/<profile>（仅桌面形态应调用）。
    """
    return profiles_root(data_root) / normalize_profile(profile)


def read_active_profile(data_root: Path) -> str:
    """读取上次登录使用的配置档（默认 shared）。文件损坏/缺失均回落默认值。"""
    path = Path(data_root) / ACTIVE_PROFILE_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return normalize_profile(data.get("mode"))
    except (OSError, ValueError, AttributeError):
        return PROFILE_DEFAULT


def write_active_profile(data_root: Path, profile: Optional[str]) -> str:
    """记录当前配置档（供下次启动选档）。尽力而为：失败不阻断登录。"""
    normalized = normalize_profile(profile)
    path = Path(data_root) / ACTIVE_PROFILE_FILE
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"mode": normalized}, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError as exc:
        _logger.warning("写入配置档标记失败（不影响使用）：%s", exc)
    return normalized


def ensure_legacy_migrated(data_root: Path, profile: Optional[str]) -> bool:
    """把旧版本平铺在 DATA_ROOT 下的业务数据一次性迁入 profiles/shared/。

    - 仅 shared 档执行（单机档永远从空库开始，避免共享数据混入）
    - 逐项移动、目标已存在则跳过：首启中途失败下次继续，不重复移动
    - 幂等：新数据根（无旧 data/data.db 且各业务目录均不存在）什么都不做
    """
    data_root = Path(data_root)
    if normalize_profile(profile) != PROFILE_SHARED:
        return False

    legacy_present = any((data_root / name).exists() for name in
                         _LEGACY_BUSINESS_DIRS + _LEGACY_BUSINESS_FILES)
    if not legacy_present:
        return False

    target_root = profile_root_for(data_root, PROFILE_SHARED)
    target_root.mkdir(parents=True, exist_ok=True)
    moved = 0
    for name in _LEGACY_BUSINESS_DIRS:
        src = data_root / name
        dst = target_root / name
        if src.exists() and not dst.exists():
            shutil.move(str(src), str(dst))
            moved += 1
    for name in _LEGACY_BUSINESS_FILES:
        src = data_root / name
        dst = target_root / name
        if src.exists() and not dst.exists():
            shutil.move(str(src), str(dst))
            moved += 1

    if moved:
        _logger.info("旧版平铺业务数据已迁入配置档 shared：%s（%s 项）", target_root, moved)
    try:
        (target_root / _MIGRATION_MARKER).write_text("1\n", encoding="utf-8")
    except OSError:
        pass
    return moved > 0


# ---------------------------------------------------------------- 重启脚本

# 应用退出后等待拉起的秒数上限，超时强杀（与 OTA 脚本同一口径）
_RESTART_WAIT_SECONDS = 60


def write_relaunch_helper(data_root: Path) -> Path:
    """生成 Windows 重启脚本：等本进程退出（超时强杀）→ 重新拉起应用 → 自删。

    与 OTA 升级脚本同一模式（隐藏运行、ping 计时、纯 ASCII 正文）；
    进程消失后再多等 2 秒，确保单实例互斥体被 OS 回收，避免新实例误报
    「程序已在运行」。
    """
    app_exe = Path(sys.executable)
    app_path = str(app_exe)
    restart_dir = Path(data_root) / RESTART_DIRNAME
    restart_dir.mkdir(parents=True, exist_ok=True)
    helper = restart_dir / "npt_restart.cmd"
    script = f"""@echo off
rem NPT profile-switch restart helper: wait for app exit, then relaunch
setlocal
set "APP={app_path}"
set "EXE={app_exe.name}"
set /a WAITED=0
:wait
tasklist /FI "IMAGENAME eq %EXE%" /NH 2>nul | find /I "%EXE%" >nul
if errorlevel 1 goto launch
set /a WAITED+=1
if %WAITED% GEQ {_RESTART_WAIT_SECONDS} goto killapp
rem fast poll: ping returns immediately, so the loop is bounded by tasklist
rem (~0.1s) -> the relaunch starts right after the old process is gone.
rem The loop only runs while the old process is alive, so the tight cadence
rem costs nothing once it has exited.
ping -n 1 127.0.0.1 >nul
goto wait
:killapp
taskkill /F /IM "%EXE%" >nul 2>&1
:launch
rem The new process must select its data profile from active_profile.json,
rem not inherit the old process NPT_DESKTOP_PROFILE (same pitfall as
rem NPT_DESKTOP_VERSION in the OTA helper: env inheritance across restart).
set "NPT_DESKTOP_PROFILE="
rem tasklist already confirmed the old process is gone: its mutex handle is
rem released by the kernel at termination and the port uses SO_REUSEADDR.
rem A single ping (~0.3s) only cushions slow antivirus scans of the new exe.
ping -n 1 127.0.0.1 >nul
start "" "%APP%"
del "%~f0" >nul 2>&1
"""
    helper.write_text(script, encoding="ascii", newline="\r\n")
    return helper


def spawn_relaunch(data_root: Path) -> bool:
    """拉起重启脚本。仅 Windows 桌面壳支持；其他平台返回 False（提示手动重启）。

    显式用净化后的环境启动：删除当前进程的 NPT_DESKTOP_PROFILE，保证重启后的
    新进程一定从 active_profile.json 选档（否则它会继承旧档变量、重启后仍进
    旧数据空间，pending 凭据因档不符被丢弃）。
    """
    if os.name != "nt":
        return False
    helper = write_relaunch_helper(data_root)
    child_env = {k: v for k, v in os.environ.items() if k != "NPT_DESKTOP_PROFILE"}
    # 标记"这次重启是模式切换"：启动器读到它会把启动过渡页显示为
    # 「正在切换运行模式」（通用文案会让用户误以为应用只是普通重启）
    child_env["NPT_DESKTOP_SWITCHING"] = "1"
    creationflags = (
        getattr(subprocess, "CREATE_NO_WINDOW", 0)
        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    )
    subprocess.Popen(
        ["cmd", "/c", str(helper)],
        env=child_env,
        creationflags=creationflags,
        close_fds=True,
    )
    return True
