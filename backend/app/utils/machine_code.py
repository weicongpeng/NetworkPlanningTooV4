"""Windows 机器码采集（离线授权绑定用）。

优先级：
1. 注册表 ``HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid`` —— 换硬件不变，重装系统才变；
2. 系统卷序列号（ctypes，MachineGuid 不可读时兜底）；
3. 主机名+用户名（非 Windows 开发/测试环境兜底）。

对外只暴露 SHA256 派生后的 16 位十六进制机器码（四位一组），不泄露原始硬件标识。
"""
from __future__ import annotations

import ctypes
import hashlib
import os
import socket
from typing import Optional

_MACHINE_CODE_SALT = "npt-desktop-2026"


def _windows_machine_guid() -> Optional[str]:
    if os.name != "nt":
        return None
    try:
        import winreg

        key = winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Cryptography",
            0,
            winreg.KEY_READ | getattr(winreg, "KEY_WOW64_64KEY", 0),
        )
        with key:
            value, _ = winreg.QueryValueEx(key, "MachineGuid")
            value = str(value).strip()
            return value or None
    except Exception:
        return None


def _windows_volume_serial() -> Optional[str]:
    if os.name != "nt":
        return None
    try:
        serial = ctypes.c_ulong(0)
        root = ctypes.c_wchar_p((os.environ.get("SystemDrive") or "C:") + "\\")
        ok = ctypes.windll.kernel32.GetVolumeInformationW(
            root, None, 0, ctypes.byref(serial), None, None, None, 0
        )
        if ok and serial.value:
            return f"{serial.value:08X}"
    except Exception:
        return None
    return None


def _fallback_seed() -> str:
    user = os.environ.get("USERNAME") or os.environ.get("USER") or ""
    return f"{socket.gethostname()}:{user}"


def raw_machine_seed() -> str:
    """本机唯一标识原始种子（仅供派生，不对外输出）。"""
    return _windows_machine_guid() or _windows_volume_serial() or _fallback_seed()


def get_machine_code() -> str:
    """返回展示用机器码：SHA256(salt:seed) 前 16 hex，四位一组（如 A1B2-C3D4-E5F6-7890）。"""
    digest = hashlib.sha256(
        f"{_MACHINE_CODE_SALT}:{raw_machine_seed()}".encode("utf-8")
    ).hexdigest().upper()
    return "-".join(digest[i : i + 4] for i in range(0, 16, 4))


def normalize_machine_code(value: Optional[str]) -> str:
    """归一化机器码用于比较（去空白与分隔符、统一大写；'*' 原样保留）。"""
    return (value or "").strip().upper().replace("-", "").replace(" ", "")
