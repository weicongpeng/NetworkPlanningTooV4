"""管理员删除用户：外键引用必须自动改挂，不再返回 500。"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.api.v1.endpoints import admin_users
from app.core.database import Base, _set_sqlite_pragma, get_db
from app.core.security import get_current_admin_user
from app.models.database import (
    ImConversation, ImConversationMember, User, Workbook,
)
from app.services.auth_service import auth_service


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_mod(), "NPT_DESKTOP", False)
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    event.listen(engine, "connect", _set_sqlite_pragma)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine, autoflush=False)()

    admin = User(username="admin", password_hash="x", is_admin=True, city="广州", operator="移动")
    zombie = User(username="zombie", password_hash="x", city="广州", operator="移动")
    db.add_all([admin, zombie])
    db.commit()
    db.add(Workbook(id="wb-zombie", user_id=zombie.id, city="广州", operator="移动",
                    name="遗留工参", file_type="xlsx", created_at=""))
    conv = ImConversation(kind="auto_group", group_key="g:广州:移动")
    db.add(conv)
    db.flush()
    db.add(ImConversationMember(conversation_id=conv.id, user_id=zombie.id, role="member"))
    db.commit()

    app = FastAPI()
    app.include_router(admin_users.router, prefix="/api/v1/admin")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_admin_user] = lambda: admin
    yield {"client": TestClient(app), "db": db, "admin": admin, "zombie": zombie}
    db.close()


def settings_mod():
    from app.core.config import settings
    return settings


def test_delete_user_with_foreign_references(env):
    resp = env["client"].delete(f"/api/v1/admin/{env['zombie'].id}")
    assert resp.status_code == 200, resp.text

    db = env["db"]
    assert auth_service.get_user_by_id(db, env["zombie"].id) is None
    wb = db.query(Workbook).filter(Workbook.id == "wb-zombie").first()
    assert wb is not None and wb.user_id == env["admin"].id
    assert db.query(ImConversationMember).filter(
        ImConversationMember.user_id == env["zombie"].id).count() == 0


def test_cannot_delete_self(env):
    resp = env["client"].delete(f"/api/v1/admin/{env['admin'].id}")
    assert resp.status_code == 400
    assert "自己" in resp.json()["detail"]
