"""桌面端「截图设置」的本机配置契约（纯 Python，跨平台可导入）。

配置文件落在 ``settings.DATA_ROOT/screenshot_settings.json``，与 ``last_login.json`` /
``active_profile.json`` 同属机器级数据：全局热键由 Windows 壳层注册，在其它应用窗口
触发时前端甚至可能还没登录，所以壳层必须能独立读到同一份配置，不能只存 localStorage
或跨设备的 ``/user/settings``。

前端设置面板、``/desktop/screenshot-settings`` 端点与 ``desktop/`` 壳层共用这里的
规范化与 Win32 映射，避免三处各写一份「Alt+Z 怎么解析」。
"""
from __future__ import annotations

import json
import os
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, List, Tuple

SETTINGS_FILE_NAME = "screenshot_settings.json"

#: Win32 ERROR_HOTKEY_ALREADY_REGISTERED：组合键已被其它进程的系统级热键占用
HOTKEY_ALREADY_REGISTERED = 1409

#: 默认 Alt+Z、隐藏会话窗口关闭（与改造前行为一致）
DEFAULT_SETTINGS: Dict[str, Any] = {
    "hotkey": {"modifiers": ["alt"], "key": "Z"},
    "hideImWindow": False,
}

#: Win32 MOD_* 位（RegisterHotKey 的 fsModifiers）
MODIFIER_TO_FLAG: Dict[str, int] = {
    "alt": 0x0001,   # MOD_ALT
    "ctrl": 0x0002,  # MOD_CONTROL
    "shift": 0x0004, # MOD_SHIFT
    "win": 0x0008,   # MOD_WIN
}
MOD_NOREPEAT = 0x4000
#: 展示 / 规范化时的固定顺序，避免 ["alt","ctrl"] 与 ["ctrl","alt"] 产生两份配置
MODIFIER_ORDER = ("ctrl", "alt", "shift", "win")
#: 展示名（前端 i18n 只做整串翻译，组合键本身用系统通用写法）
MODIFIER_LABEL = {"ctrl": "Ctrl", "alt": "Alt", "shift": "Shift", "win": "Win"}

_BASE_KEYS = {**{chr(c): 0x30 + c - ord("0") for c in range(ord("0"), ord("9") + 1)},
              **{chr(c): 0x41 + c - ord("A") for c in range(ord("A"), ord("Z") + 1)}}
_EXTRA_KEYS = {
    "F1": 0x70, "F2": 0x71, "F3": 0x72, "F4": 0x73, "F5": 0x74, "F6": 0x75,
    "F7": 0x76, "F8": 0x77, "F9": 0x78, "F10": 0x79, "F11": 0x7A, "F12": 0x7B,
    "SPACE": 0x20, "TAB": 0x09, "INSERT": 0x2D, "DELETE": 0x2E,
    "HOME": 0x24, "END": 0x23, "PAGEUP": 0x21, "PAGEDOWN": 0x22,
    "UP": 0x26, "DOWN": 0x28, "LEFT": 0x25, "RIGHT": 0x27,
    "PRINTSCREEN": 0x2C, "SCROLLLOCK": 0x91, "PAUSE": 0x13,
    "BACKSPACE": 0x08, "ENTER": 0x0D, "ESCAPE": 0x1B,
    "`": 0xC0, "-": 0xBD, "=": 0xBB, "[": 0xDB, "]": 0xDD,
    "\\": 0xDC, ";": 0xBA, "'": 0xDE, ",": 0xBC, ".": 0xBE, "/": 0xBF,
}
#: 主键名 → 虚拟键码；主键必须是可打印/功能键，纯修饰键组合无效
KEY_TO_VK: Dict[str, int] = {**_BASE_KEYS, **_EXTRA_KEYS}

#: 浏览器 ``KeyboardEvent.code`` → 配置主键名（与前端 keyFromEvent 保持同一口径）
_CODE_TO_KEY = {
    "Space": "SPACE", "Insert": "INSERT", "Delete": "DELETE",
    "Home": "HOME", "End": "END", "PageUp": "PAGEUP", "PageDown": "PAGEDOWN",
    "ArrowUp": "UP", "ArrowDown": "DOWN", "ArrowLeft": "LEFT", "ArrowRight": "RIGHT",
    "ScrollLock": "SCROLLLOCK", "Pause": "PAUSE", "Backspace": "BACKSPACE",
    "Backquote": "`", "Minus": "-", "Equal": "=", "BracketLeft": "[",
    "BracketRight": "]", "Backslash": "\\", "Semicolon": ";", "Quote": "'",
    "Comma": ",", "Period": ".", "Slash": "/",
    "Escape": "ESCAPE", "Tab": "TAB", "Enter": "ENTER", "PrintScreen": "PRINTSCREEN",
}

#: 系统保留、注册后基本必冲突或会打断系统操作的组合（前端录制时直接拒绝）
RESERVED_KEYS = {"ESCAPE", "TAB", "ENTER", "PRINTSCREEN"}

_file_lock = threading.Lock()


def default_settings() -> Dict[str, Any]:
    return deepcopy(DEFAULT_SETTINGS)


def key_from_code(code: str, key: str) -> str:
    """把 ``KeyboardEvent`` 转成配置里的主键名；无法识别时返回空串。

    ``code`` 优先（不受输入法/大小写影响），``KeyZ`` / ``Digit2`` / ``F5`` /
    ``Numpad1`` 都能覆盖；退化时用 ``key`` 的大写形式。
    """
    raw = str(code or "")
    if raw.startswith("Key") and len(raw) == 4 and raw[3:].isalpha():
        return raw[3:].upper()
    if raw.startswith("Digit") and len(raw) == 6 and raw[5:].isdigit():
        return raw[5:]
    if raw.startswith("Numpad") and len(raw) == 7 and raw[6:].isdigit():
        return raw[6:]
    if raw in _CODE_TO_KEY:
        return _CODE_TO_KEY[raw]
    if raw in KEY_TO_VK:
        return raw
    fallback = str(key or "").upper()
    if fallback in KEY_TO_VK:
        return fallback
    return ""


def normalize_settings(raw: Any) -> Dict[str, Any]:
    """规范化任意来源（JSON / 前端表单 / 旧版本残留）为合法配置。

    非法项一律回落默认值，绝不把脏数据写进 Win32 RegisterHotKey。
    返回的结构固定为 ``{"hotkey": {"modifiers": [...], "key": "Z"}, "hideImWindow": bool}``。
    """
    result = default_settings()
    if not isinstance(raw, dict):
        return result
    hotkey = raw.get("hotkey")
    if isinstance(hotkey, dict):
        modifiers = hotkey.get("modifiers")
        if isinstance(modifiers, (list, tuple)):
            cleaned = [str(m).lower() for m in modifiers if str(m).lower() in MODIFIER_TO_FLAG]
            # 去重并按固定顺序排列
            cleaned = [m for m in MODIFIER_ORDER if m in cleaned]
            if cleaned:
                result["hotkey"]["modifiers"] = cleaned
        candidate = str(hotkey.get("key") or "").upper()
        if candidate in KEY_TO_VK and candidate not in RESERVED_KEYS:
            result["hotkey"]["key"] = candidate
    result["hideImWindow"] = bool(raw.get("hideImWindow", False))
    return result


def validate_settings(raw: Any) -> Tuple[Dict[str, Any], str]:
    """严格校验前端提交，返回 ``(settings, error_code)``；``error_code`` 为空表示合法。

    与 :func:`normalize_settings` 的区别：这里不做静默回落，非法输入要让用户看到原因。
    """
    if not isinstance(raw, dict):
        return default_settings(), "INVALID_PAYLOAD"
    hotkey = raw.get("hotkey")
    if not isinstance(hotkey, dict):
        return default_settings(), "INVALID_HOTKEY"
    modifiers = hotkey.get("modifiers")
    if not isinstance(modifiers, list) or not modifiers:
        return default_settings(), "MODIFIER_REQUIRED"
    lowered = [str(m).lower() for m in modifiers]
    if any(m not in MODIFIER_TO_FLAG for m in lowered):
        return default_settings(), "INVALID_MODIFIER"
    key = str(hotkey.get("key") or "").upper()
    if key not in KEY_TO_VK:
        return default_settings(), "INVALID_KEY"
    if key in RESERVED_KEYS:
        return default_settings(), "RESERVED_KEY"
    settings = normalize_settings(raw)
    if not settings["hotkey"]["modifiers"]:
        return default_settings(), "MODIFIER_REQUIRED"
    settings["hideImWindow"] = bool(raw.get("hideImWindow", False))
    return settings, ""


def format_hotkey(settings: Dict[str, Any]) -> str:
    """展示文本，如 ``Alt+Z`` / ``Ctrl+Shift+F5``（用于按钮 title 与设置面板）。"""
    normalized = normalize_settings(settings)
    parts = [MODIFIER_LABEL[m] for m in normalized["hotkey"]["modifiers"]]
    parts.append(normalized["hotkey"]["key"])
    return "+".join(parts)


def to_win32_hotkey(settings: Dict[str, Any]) -> Tuple[int, int]:
    """配置 → ``(fsModifiers, vk)``，供 ``RegisterHotKey`` 使用。"""
    normalized = normalize_settings(settings)
    flags = MOD_NOREPEAT
    for modifier in normalized["hotkey"]["modifiers"]:
        flags |= MODIFIER_TO_FLAG[modifier]
    return flags, KEY_TO_VK[normalized["hotkey"]["key"]]


def is_conflict_error(error_code: int) -> bool:
    """``RegisterHotKey`` 失败时区分「被其它应用占用」与其它系统错误。"""
    return int(error_code or 0) == HOTKEY_ALREADY_REGISTERED


def settings_path(data_root: Path) -> Path:
    return Path(data_root) / SETTINGS_FILE_NAME


def load_settings(data_root: Path) -> Dict[str, Any]:
    """读本机配置；文件缺失/损坏/无权限都回落默认值，绝不阻断启动。"""
    try:
        path = settings_path(data_root)
        if not path.is_file():
            return default_settings()
        return normalize_settings(json.loads(path.read_text(encoding="utf-8")))
    except Exception:  # noqa: BLE001 - 配置损坏不应影响应用启动
        return default_settings()


def save_settings(data_root: Path, settings: Dict[str, Any]) -> Dict[str, Any]:
    """原子写本机配置（临时文件 + os.replace），返回已规范化的配置。"""
    normalized = normalize_settings(settings)
    path = settings_path(data_root)
    with _file_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".json.tmp")
        temp.write_text(
            json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(temp, path)
    return normalized
