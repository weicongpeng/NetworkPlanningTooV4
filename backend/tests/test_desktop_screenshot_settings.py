"""桌面截图设置的本机配置契约：默认值、校验、Win32 映射、冲突码与原子读写。

这些纯 Python 逻辑同时被 /desktop/screenshot-settings 端点与 Windows 壳层的
热键线程使用，必须在 Linux CI 上也能完整验证（不依赖 user32 / pythonnet）。
"""
from __future__ import annotations

import json

from app.services import desktop_screenshot_settings as cfg


def test_default_settings_are_alt_z_and_hide_off():
    assert cfg.default_settings() == {
        "hotkey": {"modifiers": ["alt"], "key": "Z"},
        "hideImWindow": False,
    }
    assert cfg.format_hotkey(cfg.default_settings()) == "Alt+Z"


def test_normalize_settings_sorts_dedupes_and_falls_back():
    assert cfg.normalize_settings({
        "hotkey": {"modifiers": ["alt", "ctrl", "ctrl", "nope"], "key": "q"},
        "hideImWindow": True,
    }) == {
        "hotkey": {"modifiers": ["ctrl", "alt"], "key": "Q"},
        "hideImWindow": True,
    }
    assert cfg.normalize_settings(None) == cfg.default_settings()
    assert cfg.normalize_settings({"hotkey": {"modifiers": [], "key": "ESCAPE"}}) \
        == cfg.default_settings()


def test_validate_settings_error_codes():
    assert cfg.validate_settings({})[1] == "INVALID_HOTKEY"
    assert cfg.validate_settings({"hotkey": {"modifiers": [], "key": "Z"}})[1] \
        == "MODIFIER_REQUIRED"
    assert cfg.validate_settings({"hotkey": {"modifiers": ["bogus"], "key": "Z"}})[1] \
        == "INVALID_MODIFIER"
    assert cfg.validate_settings({"hotkey": {"modifiers": ["alt"], "key": "UNKNOWN"}})[1] \
        == "INVALID_KEY"
    assert cfg.validate_settings({"hotkey": {"modifiers": ["alt"], "key": "TAB"}})[1] \
        == "RESERVED_KEY"
    settings, error = cfg.validate_settings({
        "hotkey": {"modifiers": ["ctrl", "shift"], "key": "F5"},
        "hideImWindow": True,
    })
    assert error == ""
    assert settings["hotkey"] == {"modifiers": ["ctrl", "shift"], "key": "F5"}
    assert settings["hideImWindow"] is True


def test_to_win32_hotkey_and_conflict_code():
    flags, vk = cfg.to_win32_hotkey(cfg.default_settings())
    assert flags == cfg.MOD_NOREPEAT | cfg.MODIFIER_TO_FLAG["alt"]
    assert vk == 0x5A  # 'Z'
    flags2, vk2 = cfg.to_win32_hotkey({
        "hotkey": {"modifiers": ["ctrl", "shift"], "key": "F5"},
        "hideImWindow": False,
    })
    assert flags2 == (cfg.MOD_NOREPEAT | cfg.MODIFIER_TO_FLAG["ctrl"]
                      | cfg.MODIFIER_TO_FLAG["shift"])
    assert vk2 == 0x74  # F5
    assert cfg.is_conflict_error(cfg.HOTKEY_ALREADY_REGISTERED) is True
    assert cfg.is_conflict_error(0) is False
    assert cfg.is_conflict_error(5) is False


def test_key_from_code_covers_common_layouts():
    assert cfg.key_from_code("KeyZ", "z") == "Z"
    assert cfg.key_from_code("Digit2", "2") == "2"
    assert cfg.key_from_code("Numpad7", "7") == "7"
    assert cfg.key_from_code("F12", "F12") == "F12"
    assert cfg.key_from_code("Space", " ") == "SPACE"
    assert cfg.key_from_code("", "q") == "Q"


def test_save_load_roundtrip_is_atomic_and_tolerates_corruption(tmp_path):
    assert cfg.load_settings(tmp_path) == cfg.default_settings()
    target = cfg.validate_settings({
        "hotkey": {"modifiers": ["shift"], "key": "A"},
        "hideImWindow": True,
    })[0]
    saved = cfg.save_settings(tmp_path, target)
    assert saved == target
    assert json.loads(cfg.settings_path(tmp_path).read_text(encoding="utf-8")) == target
    assert cfg.load_settings(tmp_path) == target
    # 原子写不应留下 .tmp
    assert not (tmp_path / "screenshot_settings.json.tmp").exists()

    cfg.settings_path(tmp_path).write_text("{broken json", encoding="utf-8")
    assert cfg.load_settings(tmp_path) == cfg.default_settings()
