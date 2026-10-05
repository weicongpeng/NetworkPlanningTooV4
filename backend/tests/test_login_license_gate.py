"""登录时的授权闸门：服务器模式拦截过期用户，桌面模式放行（否则无法登录去激活）。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models.database import Base, User
from app.services.auth_service import auth_service


@pytest.fixture()
def db_session(tmp_path):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = Session()
    yield session
    session.close()


def _make_user(db, *, expired: bool) -> User:
    user = User(
        username="admin",
        password_hash=auth_service.hash_password("admin123"),
        is_admin=True,
        is_active=True,
        license_expiry=datetime.now(timezone.utc) - timedelta(days=1)
        if expired
        else datetime.now(timezone.utc) + timedelta(days=30),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def test_server_mode_rejects_expired_license(db_session, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "NPT_DESKTOP", False)
    _make_user(db_session, expired=True)

    user, error = auth_service.authenticate_user(db_session, "admin", "admin123")
    assert user is None
    assert "过期" in (error or "")


def test_server_mode_allows_valid_license(db_session, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "NPT_DESKTOP", False)
    _make_user(db_session, expired=False)

    user, error = auth_service.authenticate_user(db_session, "admin", "admin123")
    assert error is None and user is not None


def test_desktop_mode_allows_expired_license_to_login(db_session, monkeypatch):
    """桌面版未激活时全体用户被镜像为过去日期，必须仍能登录（否则无法激活）。"""
    from app.core.config import settings

    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    _make_user(db_session, expired=True)

    user, error = auth_service.authenticate_user(db_session, "admin", "admin123")
    assert error is None and user is not None


def test_wrong_password_and_inactive_still_rejected_in_desktop(db_session, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    user = _make_user(db_session, expired=True)

    _, error = auth_service.authenticate_user(db_session, "admin", "bad-password")
    assert "用户名或密码错误" in (error or "")

    user.is_active = False
    db_session.commit()
    _, error = auth_service.authenticate_user(db_session, "admin", "admin123")
    assert "禁用" in (error or "")
