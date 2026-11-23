"""IM 垃圾自动清理：合法附件保护、保守保留期与错误容错。"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.core.database import Base, _set_sqlite_pragma
from app.services import desktop_im_storage, im_garbage_cleanup as cleanup


@pytest.fixture()
def env(tmp_path, monkeypatch):
    base = tmp_path / "uploads" / "im"
    (base / "7").mkdir(parents=True)
    monkeypatch.setattr(settings, "DATA_ROOT", tmp_path)
    monkeypatch.setattr(settings, "PROFILE_ROOT", tmp_path)
    monkeypatch.setattr(settings, "NPT_IM_ATTACHMENT_DIR", base)
    monkeypatch.setattr(settings, "DESKTOP_PROFILE", "")
    monkeypatch.setattr(desktop_im_storage, "_cache", None)
    monkeypatch.setattr(
        desktop_im_storage, "open_temp_dir", lambda: tmp_path / "npt-im-open")

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    event.listen(engine, "connect", _set_sqlite_pragma)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine, autoflush=False)()
    from app.models.database import ImConversation, User

    db.add(User(id=1, username="u", password_hash="x", is_admin=True,
                city="广州", operator="移动"))
    db.add(ImConversation(id=7, kind="direct", group_key="d:1:2", created_at=""))
    db.commit()

    def add_attachment(aid, created_days_ago, relative, thumb=None):
        created = (datetime.now(timezone.utc) - timedelta(days=created_days_ago)).isoformat()
        db.execute(text(
            "insert into im_attachments(id,conversation_id,uploader_id,original_name,"
            "stored_name,mime,size_bytes,storage_path,thumb_path,created_at) "
            "values(:id,7,1,'f.png','f.png','image/png',10,:path,:thumb,:created)"),
            {"id": aid, "path": relative, "thumb": thumb, "created": created})
        db.commit()

    def add_message(attachment_id):
        db.execute(text(
            "insert into im_messages(conversation_id,sender_id,kind,attachment_id,mention_all,created_at) "
            "values(7,1,'image',:aid,0,'')"), {"aid": attachment_id})
        db.commit()

    yield {"db": db, "base": base, "tmp": tmp_path,
           "add_attachment": add_attachment, "add_message": add_message}
    db.close()


def _age(path: Path, days: float) -> None:
    moment = time.time() - days * 86400
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * 128)
    import os

    os.utime(path, (moment, moment))


def test_legit_attachment_never_deleted(env):
    """消息仍引用的附件即使很旧也不能删。"""
    env["add_attachment"](1, 200, "7/legit.png")
    env["add_message"](1)
    _age(env["base"] / "7" / "legit.png", 200)

    stats = cleanup.cleanup_once(env["db"])

    assert (env["base"] / "7" / "legit.png").is_file()
    assert stats.deleted_attachment_rows == 0
    assert stats.deleted_files == 0


def test_orphan_attachment_and_file_removed_after_90_days(env):
    """消息已删：90 天以上的附件行与磁盘文件一起清掉。"""
    env["add_attachment"](2, 100, "7/orphan.png")
    _age(env["base"] / "7" / "orphan.png", 100)
    env["add_attachment"](3, 5, "7/recent.png")
    _age(env["base"] / "7" / "recent.png", 5)

    stats = cleanup.cleanup_once(env["db"])

    assert not (env["base"] / "7" / "orphan.png").exists()
    assert (env["base"] / "7" / "recent.png").is_file()
    remain = env["db"].execute(text("select id from im_attachments")).fetchall()
    assert [int(row[0]) for row in remain] == [3]
    assert stats.deleted_attachment_rows == 1
    assert stats.deleted_files >= 1


def test_part_and_thumb_and_temp_files_use_short_retention(env):
    _age(env["base"] / "7" / "old.part", 8)
    _age(env["base"] / "7" / "fresh.part", 2)
    _age(env["base"] / "7" / "old_thumb.png", 8)
    _age(env["base"] / "7" / "fresh_thumb.png", 2)
    _age(env["tmp"] / "npt-im-open" / "old-open.png", 0.01)
    _age(env["tmp"] / "screenshot_tmp" / "old.png", 8)

    cleanup.cleanup_once(env["db"])

    assert not (env["base"] / "7" / "old.part").exists()
    assert (env["base"] / "7" / "fresh.part").is_file()
    assert not (env["base"] / "7" / "old_thumb.png").exists()
    assert (env["base"] / "7" / "fresh_thumb.png").is_file()
    assert not (env["tmp"] / "npt-im-open" / "old-open.png").exists()
    assert not (env["tmp"] / "screenshot_tmp" / "old.png").exists()


def test_active_upload_part_skipped(env, monkeypatch):
    from app.services import im_attachment_service

    active = env["base"] / "7" / "active.part"
    _age(active, 30)
    monkeypatch.setattr(im_attachment_service, "active_upload_paths", lambda: [active])

    cleanup.cleanup_once(env["db"])

    assert active.is_file()


def test_missing_messages_table_aborts_without_deleting(env):
    env["db"].execute(text("drop table im_messages"))
    env["db"].commit()
    target = env["base"] / "7" / "keep.png"
    _age(target, 200)

    stats = cleanup.cleanup_once(env["db"])

    assert target.is_file()
    assert stats.errors >= 1
    assert stats.deleted_files == 0


def test_stats_and_thread_control(monkeypatch):
    monkeypatch.setattr(settings, "NPT_IM_CLEANUP_ENABLED", False)
    cleanup.stop_background_cleanup()
    cleanup.start_background_cleanup()
    assert cleanup._thread is None or not cleanup._thread.is_alive()
    assert cleanup.CleanupStats().as_dict()["deleted_files"] == 0
