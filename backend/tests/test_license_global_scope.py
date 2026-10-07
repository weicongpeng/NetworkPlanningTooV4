"""授权期限的作用域：全局设置对所有用户生效，管理员权限无限期。

改造前授权期限存在**管理员用户行的 license_expiry**，登录闸门读的却是**每个用户
自己的** license_expiry——管理员在「系统设置 → 授权管理」里改的期限对别人无效。

改造后的语义：
- 全局期限存 system_settings（system_settings_service），对所有用户生效
- 非管理员：自身 license_expiry（用户管理页单独设的例外）优先，未设置则用全局
- 管理员：恒为无限期，不受全局期限约束
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.models.database import Base, User
from app.services import system_settings_service as sys_settings
from app.services.auth_service import auth_service


@pytest.fixture()
def db(monkeypatch):
    """内存库，并把各服务里已绑定的 SessionLocal 一并换掉（模块级 import 绑定）。"""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    from app.services import license_service as lic_mod

    monkeypatch.setattr(sys_settings, "SessionLocal", Session)
    monkeypatch.setattr(lic_mod, "SessionLocal", Session)
    monkeypatch.setattr(settings, "NPT_DESKTOP", False)

    session = Session()
    yield session
    session.close()


def _add_user(db, *, username: str, is_admin: bool = False, expiry=None) -> User:
    user = User(
        username=username,
        password_hash=auth_service.hash_password("pw123456"),
        is_admin=is_admin,
        is_active=True,
        license_expiry=expiry,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _days(n: int) -> datetime:
    return datetime.now() + timedelta(days=n)


# ---------------------------------------------------------------- 全局设置读写

def test_global_expiry_roundtrip(db):
    assert sys_settings.get_license_expiry() is None

    sys_settings.set_license_expiry("2030-01-02")
    assert sys_settings.get_license_expiry().strftime("%Y-%m-%d") == "2030-01-02"

    sys_settings.set_license_expiry(None)
    assert sys_settings.get_license_expiry() is None


def test_invalid_date_is_rejected_and_not_written(db):
    sys_settings.set_license_expiry("2030-01-02")
    assert sys_settings.set_license_expiry("2030-13-99") is None
    # 非法输入不得覆盖已生效的期限
    assert sys_settings.get_license_expiry().strftime("%Y-%m-%d") == "2030-01-02"


def test_seeds_from_admin_row_once(db):
    """存量部署：全局未设置时从管理员行播种，行为不突变。"""
    _add_user(db, username="admin", is_admin=True, expiry=_days(400))

    seeded = sys_settings.get_license_expiry()
    assert seeded is not None
    # 播种结果已落库：后续读取不再依赖管理员行
    assert sys_settings.get_setting(sys_settings.KEY_LICENSE_EXPIRY) == seeded.strftime("%Y-%m-%d")


# ---------------------------------------------------------------- 登录闸门

def test_non_admin_without_own_expiry_follows_global(db):
    _add_user(db, username="op")
    _add_user(db, username="admin", is_admin=True)

    sys_settings.set_license_expiry((_days(-1)).strftime("%Y-%m-%d"))
    user, error = auth_service.authenticate_user(db, "op", "pw123456")
    assert user is None and "过期" in (error or "")

    sys_settings.set_license_expiry((_days(10)).strftime("%Y-%m-%d"))
    user, error = auth_service.authenticate_user(db, "op", "pw123456")
    assert error is None and user is not None


def test_non_admin_own_expiry_wins_over_global(db):
    _add_user(db, username="vip", expiry=_days(30))
    _add_user(db, username="temp", expiry=_days(-1))

    # 全局已过期：设了例外期限的用户仍可登录
    sys_settings.set_license_expiry((_days(-1)).strftime("%Y-%m-%d"))
    _, error = auth_service.authenticate_user(db, "vip", "pw123456")
    assert error is None

    # 全局有效：自身例外已过期的用户照样被拦
    sys_settings.set_license_expiry((_days(30)).strftime("%Y-%m-%d"))
    _, error = auth_service.authenticate_user(db, "temp", "pw123456")
    assert "过期" in (error or "")


def test_admin_is_unlimited(db):
    admin = _add_user(db, username="admin", is_admin=True, expiry=_days(-5))
    sys_settings.set_license_expiry((_days(-5)).strftime("%Y-%m-%d"))

    # 自身期限与全局期限都已过期，管理员仍不受限
    assert auth_service.effective_license_expiry(admin) is None
    user, error = auth_service.authenticate_user(db, "admin", "pw123456")
    assert error is None and user is not None


def test_effective_expiry_prefers_own_then_global(db):
    own = _add_user(db, username="own", expiry=_days(7))
    fallback = _add_user(db, username="fallback")
    admin = _add_user(db, username="admin", is_admin=True, expiry=_days(7))

    sys_settings.set_license_expiry((_days(99)).strftime("%Y-%m-%d"))

    assert auth_service.effective_license_expiry(own) == own.license_expiry
    assert auth_service.effective_license_expiry(fallback).strftime("%Y-%m-%d") == (
        _days(99).strftime("%Y-%m-%d")
    )
    assert auth_service.effective_license_expiry(admin) is None


# ---------------------------------------------------------------- /license/status

def test_license_status_reads_global_expiry(db):
    from app.services.license_service import license_service

    _add_user(db, username="admin", is_admin=True)

    sys_settings.set_license_expiry(None)
    assert license_service.get_status().remainingDays == -1  # 无限期

    sys_settings.set_license_expiry((_days(10)).strftime("%Y-%m-%d"))
    status = license_service.get_status()
    assert status.valid is True and status.remainingDays > 0

    sys_settings.set_license_expiry((_days(-1)).strftime("%Y-%m-%d"))
    status = license_service.get_status()
    assert status.valid is False and status.remainingDays == 0
