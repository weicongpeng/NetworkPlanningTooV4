"""desktop_releases.mandatory 遗留列会让「桌面版分发」上传直接 500。

背景（2026-10-10 用户报网页端上传安装包 500）：早期「强制更新」功能下线后，
ORM 模型删掉了 mandatory 列，但旧库残留 `mandatory BOOLEAN NOT NULL`（无默认值），
所有新插入都报 NOT NULL constraint failed → complete 接口 500。
init_db 必须把旧库里的这一列真正删掉，且保留存量数据。
"""
from __future__ import annotations

import sqlite3

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core import database as db_module
from app.models.database import DesktopRelease

LEGACY_SCHEMA = """
CREATE TABLE desktop_releases (
    id INTEGER NOT NULL,
    version VARCHAR(30) NOT NULL,
    channel VARCHAR(20) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER,
    sha256 VARCHAR(64),
    release_notes TEXT,
    mandatory BOOLEAN NOT NULL,
    is_latest BOOLEAN NOT NULL,
    download_count INTEGER,
    created_by VARCHAR(100),
    created_at VARCHAR(30) NOT NULL,
    updated_at VARCHAR(30),
    PRIMARY KEY (id)
)
"""


def test_init_db_drops_legacy_mandatory_column(tmp_path, monkeypatch):
    db_path = tmp_path / "legacy.db"
    raw = sqlite3.connect(db_path)
    try:
        raw.execute(LEGACY_SCHEMA)
        raw.execute(
            "INSERT INTO desktop_releases "
            "(version, channel, filename, file_path, mandatory, is_latest, created_at) "
            "VALUES ('0.0.5', 'stable', 'x.exe', '/tmp/x.exe', 0, 1, '2026-10-10T00:00:00')"
        )
        raw.commit()
    finally:
        raw.close()

    engine = create_engine(f"sqlite:///{db_path}")
    monkeypatch.setattr(db_module, "engine", engine)
    monkeypatch.setattr(
        db_module, "SessionLocal", sessionmaker(bind=engine, autoflush=False, autocommit=False)
    )

    db_module.init_db()

    conn = sqlite3.connect(db_path)
    try:
        cols = [row[1] for row in conn.execute("PRAGMA table_info(desktop_releases)")]
    finally:
        conn.close()
    assert "mandatory" not in cols

    # 存量行保留，新插入不再被 NOT NULL 卡住（上传安装包的核心路径）
    session = db_module.SessionLocal()
    try:
        session.add(
            DesktopRelease(
                version="0.0.6", channel="stable", filename="y.exe",
                file_path="/tmp/y.exe", file_size=1, sha256="a" * 64,
                is_latest=True, created_at="2026-10-10T01:00:00",
            )
        )
        session.commit()
        assert session.query(DesktopRelease).count() == 2
    finally:
        session.close()
