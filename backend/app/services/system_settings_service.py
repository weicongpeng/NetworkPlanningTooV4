"""全局系统设置（system_settings 键值表）。

与 `user_settings` 的区别：本表全站只有一份，对所有用户生效；
按用户的个性化设置走 `user_settings`。

当前唯一用途是全局授权期限（`license_expiry`）：
授权是系统级设置，管理员在「系统设置 → 授权管理」里改一次应对所有人生效。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from app.core.database import SessionLocal
from app.models.database import SystemSetting

# 全局授权期限（NULL / 无记录 = 无限期）
KEY_LICENSE_EXPIRY = "license_expiry"

# 日期格式（与前端 date input 一致）
_DATE_FMT = "%Y-%m-%d"


def get_setting(key: str) -> Optional[str]:
    """读全局设置原始字符串；不存在返回 None。"""
    db = SessionLocal()
    try:
        row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
        return row.value if row else None
    except Exception:
        return None
    finally:
        db.close()


def set_setting(key: str, value: Optional[str]) -> None:
    """写全局设置（空值写 NULL，不删行，便于区分"未设置"与"已设为无限期"）。"""
    db = SessionLocal()
    try:
        row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
        if row is None:
            row = SystemSetting(key=key)
            db.add(row)
        row.value = value
        row.updated_at = datetime.now(timezone.utc).isoformat()
        db.commit()
    finally:
        db.close()


def _parse_date(raw: Optional[str]) -> Optional[datetime]:
    if not raw:
        return None
    try:
        parsed = datetime.strptime(raw, _DATE_FMT)
    except ValueError:
        return None
    # 与 users.license_expiry 保持一致：SQLite 存 naive，比较时补 UTC
    return parsed.replace(tzinfo=timezone.utc)


def get_license_expiry() -> Optional[datetime]:
    """全局授权期限；None = 无限期。

    首次调用时若全局未设置，从管理员行的 license_expiry **播种一次**：
    改造前授权期限就存在管理员行上，播种可保证存量部署行为不突变。
    """
    raw = get_setting(KEY_LICENSE_EXPIRY)
    if raw is not None:
        return _parse_date(raw)

    from app.models.database import User

    db = SessionLocal()
    try:
        admin = (
            db.query(User)
            .filter(User.is_admin == True, User.is_active == True)  # noqa: E712
            .first()
        )
        seed = admin.license_expiry if admin else None
    except Exception:
        seed = None
    finally:
        db.close()

    # 播种为显式记录（含"无限期"），避免每次请求都回查管理员行
    set_setting(KEY_LICENSE_EXPIRY, seed.strftime(_DATE_FMT) if seed else "")
    return seed.replace(tzinfo=timezone.utc) if seed and seed.tzinfo is None else seed


def set_license_expiry(expiry_date: Optional[str]) -> Optional[datetime]:
    """设置全局授权期限；None/空串 = 无限期。非法日期返回 None 且不写入。"""
    if expiry_date:
        try:
            parsed = datetime.strptime(expiry_date, _DATE_FMT)
        except ValueError:
            return None
        set_setting(KEY_LICENSE_EXPIRY, parsed.strftime(_DATE_FMT))
        return parsed.replace(tzinfo=timezone.utc)

    set_setting(KEY_LICENSE_EXPIRY, "")
    return None
