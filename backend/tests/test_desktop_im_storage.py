"""桌面端 IM 本地存储：档内配置、路径校验、迁移与清理回归。"""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.v1.endpoints import desktop_local
from app.core.config import settings
from app.core.database import Base, get_db
from app.core.security import get_current_user
from app.models.database import ImAttachment, ImConversation, User
from app.services import desktop_im_storage as storage
from app.services import im_attachment_service


@pytest.fixture()
def env(tmp_path, monkeypatch):
    data_root = tmp_path / "appdata"
    profile = data_root / "profile"
    default_dir = profile / "uploads" / "im"
    default_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, "DATA_ROOT", data_root)
    monkeypatch.setattr(settings, "PROFILE_ROOT", profile)
    monkeypatch.setattr(settings, "BUNDLE_DIR", tmp_path / "bundle")
    monkeypatch.setattr(settings, "NPT_IM_ATTACHMENT_DIR", default_dir)
    monkeypatch.setattr(settings, "DESKTOP_PROFILE", "shared")
    monkeypatch.setattr(storage, "_cache", None)

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine, autoflush=False)()
    db.add(User(username="alice", password_hash="x", city="广州", operator="移动"))
    db.commit()
    conv = ImConversation(kind="direct", name=None, group_key=None)
    db.add(conv)
    db.commit()

    app = FastAPI()
    app.include_router(desktop_local.router, prefix="/api/v1/desktop")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: db.query(User).first()
    app.dependency_overrides[desktop_local._require_desktop] = lambda: None
    yield {"db": db, "root": tmp_path, "default": default_dir, "profile": profile,
           "client": TestClient(app), "conv_id": conv.id}
    db.close()
    monkeypatch.setattr(storage, "_cache", None)


def _attachment(db, conv_id, name):
    att = ImAttachment(
        conversation_id=conv_id, uploader_id=1, original_name=name, stored_name=name,
        mime="image/png", size_bytes=4, storage_path=f"1/{name}", thumb_path=None,
    )
    db.add(att)
    db.commit()
    return att


def test_default_path_and_profile_config(env, monkeypatch):
    assert storage.effective_attachment_dir() == env["default"]
    target = env["root"] / "custom-im"
    storage.save_path(target)
    assert storage.effective_attachment_dir() == target
    assert storage.current_state()["customized"] is True
    # 缓存用 mtime 失效：直接改文件也要能看到新值
    (env["profile"] / storage.SETTINGS_FILE_NAME).write_text(
        '{"attachment_dir": ""}', encoding="utf-8")
    assert storage.effective_attachment_dir() == env["default"]


def test_download_mode_defaults_manual_and_survives_path_change(env):
    assert storage.download_mode() == "manual"
    assert storage.current_state()["attachment_download_mode"] == "manual"
    storage.set_download_mode("auto")
    storage.save_path(env["root"] / "custom-im")
    assert storage.download_mode() == "auto"
    assert storage.current_state()["attachment_download_mode"] == "auto"
    with pytest.raises(ValueError):
        storage.set_download_mode("all")
    assert storage.download_mode() == "auto"

    res = env["client"].post(
        "/api/v1/desktop/im-storage/download-mode", json={"mode": "manual"})
    assert res.status_code == 200
    assert res.json()["data"] == {"mode": "manual"}
    assert storage.download_mode() == "manual"


@pytest.mark.parametrize("raw,code", [
    ("", "IM_STORAGE_PATH_REQUIRED"),
    ("relative/path", "IM_STORAGE_PATH_ABSOLUTE"),
    (str(Path("/")), "IM_STORAGE_PATH_FORBIDDEN"),
    (str(Path("/Windows/System32")), "IM_STORAGE_PATH_FORBIDDEN"),
])
def test_invalid_paths_rejected(raw, code):
    with pytest.raises(ValueError) as exc:
        storage.validate_path(raw)
    assert code in str(exc.value)


def test_migrate_moves_files_and_rejects_nonempty_target(env):
    (env["default"] / "1").mkdir()
    (env["default"] / "1" / "kept.png").write_bytes(b"data")
    target = env["root"] / "new-im"
    result = storage.migrate_attachment_dir(target)
    assert result["moved_files"] == 1 and result["moved_bytes"] == 4
    assert (target / "1" / "kept.png").read_bytes() == b"data"
    assert storage.effective_attachment_dir() == target
    # 目标非空时保持原配置不变
    (env["root"] / "occupied").mkdir()
    (env["root"] / "occupied" / "old.txt").write_text("x")
    with pytest.raises(ValueError, match="NOT_EMPTY"):
        storage.migrate_attachment_dir(env["root"] / "occupied")
    assert storage.effective_attachment_dir() == target


def test_cleanup_keeps_referenced_and_active_files(env, monkeypatch):
    base = env["default"]
    (base / "1").mkdir()
    referenced = _attachment(env["db"], env["conv_id"], "kept.png")
    (base / "1" / "kept.png").write_bytes(b"keep")
    (base / "1" / "orphan.png").write_bytes(b"1234")
    (base / "1" / "partial.part").write_bytes(b"12")

    active = base / "1" / "uploading.part"
    active.write_bytes(b"999")
    monkeypatch.setattr(
        im_attachment_service, "active_upload_paths", lambda: {active})

    temp = storage.open_temp_dir()
    temp.mkdir(parents=True, exist_ok=True)
    old = temp / "old-open.png"
    old.write_bytes(b"old")
    old_time = time.time() - storage.OPEN_TEMP_KEEP_SECONDS - 10
    os.utime(old, (old_time, old_time))
    recent = temp / "recent-open.png"
    recent.write_bytes(b"new")

    preview = storage.cleanup_preview(env["db"])
    assert preview["files"] == 3  # orphan + partial + old-open
    result = storage.cleanup_now(env["db"])
    assert result["deleted_files"] == 3 and result["freed_bytes"] == 4 + 2 + 3
    assert (base / "1" / referenced.stored_name).is_file()
    assert active.is_file() and recent.is_file()


def test_desktop_endpoints_state_and_non_desktop_404(env, monkeypatch):
    resp = env["client"].get("/api/v1/desktop/im-storage")
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["path"] == str(env["default"])

    target = env["root"] / "from-api"
    resp = env["client"].post("/api/v1/desktop/im-storage/path", json={"path": str(target)})
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["path"] == str(target)

    # 非桌面形态：不覆盖门禁，走 _require_desktop 返回 404
    from app.core.config import settings as cfg

    monkeypatch.setattr(cfg, "NPT_DESKTOP", False)
    plain = FastAPI()
    plain.include_router(desktop_local.router, prefix="/api/v1/desktop")
    assert TestClient(plain).get("/api/v1/desktop/im-storage").status_code == 404
